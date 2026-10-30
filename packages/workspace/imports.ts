import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { Store } from "../persistence/store";
import type { Conversation, Message, Provider } from "../domain/types";
import { hash, now, stable, uid } from "../domain/invariants";
import {
  IMPORT_PREVIEW_MINUTES,
  referenceExcerpt,
  type HistoryReference,
  type ImportPreview,
  type SessionReference,
  type SessionReferenceSummary,
} from "../domain/history-imports";
import { checkImportFile, parseImport } from "../history/imports";

/**
 * Explicit export imports (docs/UX_Cleanup_Plan.md §3): preview one file,
 * commit exactly the previewed bytes as an immutable reference, search and
 * read it, and freeze an excerpt of it into a new session. An import keeps
 * no connection to its source file.
 */

const kinds = {
  preview: "history-import-preview",
  reference: "history-reference",
  source: "history-reference-source",
  session: "session-reference",
} as const;

/** The searchable conversation of one import. */
export const referenceConversationId = (referenceId: string) =>
  `import-ref:${referenceId}`;
const remainderChunk = 20_000;

type StoredPreview = ImportPreview & { text: string };
interface ReferenceSource {
  id: string;
  projectId: string;
  text: string;
}

/** Reads one regular file without following links, refusing a file that changes meanwhile. */
async function readStable(file: string): Promise<Buffer> {
  if (!path.isAbsolute(file)) throw new Error("Choose one file to import.");
  const canonical = await realpath(file);
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Choose one regular file to import.");
    checkImportFile(file, before.size);
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      read !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    )
      throw new Error("The file changed while Topsl read it. Try again.");
    return bytes;
  } finally {
    await handle.close();
  }
}

export class HistoryImports {
  constructor(
    private store: Store,
    private changed: () => void = () => {},
  ) {}

  private references(projectId: string): HistoryReference[] {
    return [
      ...this.store.iterate<HistoryReference>(kinds.reference, { projectId }),
    ].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  }

  private duplicate(projectId: string, provider: Provider, digest: string) {
    return (
      this.references(projectId).find(
        (r) => r.provider === provider && r.contentHash === digest,
      ) ?? null
    );
  }

  /** Previews never committed expire; they hold the file's text. */
  private purgeExpired(): void {
    const at = now();
    for (const preview of [...this.store.iterate<StoredPreview>(kinds.preview)])
      if (preview.expiresAt < at) this.store.remove(kinds.preview, preview.id);
  }

  /** Reads and recognizes the selected file, and keeps exactly those bytes for commit. */
  async preview(input: {
    projectId: string;
    provider: Provider;
    file: string;
  }): Promise<ImportPreview> {
    this.purgeExpired();
    const bytes = await readStable(input.file);
    const fileName = path.basename(input.file).slice(0, 255);
    const parsed = parseImport(bytes, fileName);
    const contentHash = hash(bytes);
    const existing = this.duplicate(
      input.projectId,
      input.provider,
      contentHash,
    );
    const at = new Date();
    const preview: StoredPreview = {
      id: uid(),
      projectId: input.projectId,
      provider: input.provider,
      fileName,
      bytes: bytes.length,
      contentHash,
      format: parsed.format,
      formatLabel: parsed.formatLabel,
      structured: parsed.structured,
      messageCount: parsed.messages.length,
      characters: parsed.characters,
      warnings: parsed.warnings,
      nativeSessionId: parsed.nativeSessionId,
      recordedFolder: parsed.recordedFolder,
      duplicateOf: existing
        ? {
            id: existing.id,
            fileName: existing.fileName,
            importedAt: existing.importedAt,
          }
        : null,
      sample: parsed.text.split(/\r?\n/).slice(0, 12).join("\n").slice(0, 2000),
      createdAt: at.toISOString(),
      expiresAt: new Date(
        at.getTime() + IMPORT_PREVIEW_MINUTES * 60_000,
      ).toISOString(),
      text: parsed.text,
    };
    this.store.put(kinds.preview, preview);
    const { text: _, ...shown } = preview;
    return shown;
  }

  /**
   * Commits a preview: the same text it showed, never the file again. The
   * same content for the same project and provider returns the earlier
   * import instead of a second copy.
   */
  commit(input: {
    projectId: string;
    previewId: string;
    contentHash: string;
  }): { reference: HistoryReference; duplicate: boolean } {
    const preview = this.store.get<StoredPreview>(
      kinds.preview,
      input.previewId,
    );
    if (!preview || preview.projectId !== input.projectId)
      throw new Error(
        "This preview is no longer available. Choose the file again.",
      );
    if (preview.contentHash !== input.contentHash)
      throw new Error("The previewed content changed. Preview the file again.");
    if (preview.expiresAt < now()) {
      this.store.remove(kinds.preview, preview.id);
      throw new Error("This preview expired. Choose the file again.");
    }
    const parsed = parseImport(
      Buffer.from(preview.text, "utf8"),
      preview.fileName,
    );
    return this.store.transaction(() => {
      this.store.remove(kinds.preview, preview.id);
      const existing = this.duplicate(
        preview.projectId,
        preview.provider,
        preview.contentHash,
      );
      if (existing) return { reference: existing, duplicate: true };
      const at = now();
      const id = uid();
      const conversationId = referenceConversationId(id);
      const reference: HistoryReference = {
        id,
        projectId: preview.projectId,
        provider: preview.provider,
        conversationId,
        fileName: preview.fileName,
        bytes: preview.bytes,
        contentHash: preview.contentHash,
        format: parsed.format,
        formatLabel: parsed.formatLabel,
        structured: parsed.structured,
        messageCount: parsed.messages.length,
        characters: parsed.characters,
        warnings: parsed.warnings,
        nativeSessionId: parsed.nativeSessionId,
        recordedFolder: parsed.recordedFolder,
        importedAt: at,
        createdAt: preview.createdAt,
      };
      this.store.save("conversation", {
        id: conversationId,
        projectId: preview.projectId,
        title: `Imported ${preview.provider === "claude" ? "Claude Code" : "Codex"} · ${preview.fileName.slice(0, 80)}`,
        nativeSessions: {},
        createdAt: at,
      } satisfies Conversation);
      const message = (
        index: string,
        role: Message["role"],
        text: string,
        at: string,
        nativeId: string | null,
      ) =>
        this.store.message({
          id: `${conversationId}:${index}`,
          projectId: preview.projectId,
          conversationId,
          role,
          provider: preview.provider,
          text,
          runId: null,
          nativeId,
          createdAt: at,
        });
      parsed.messages.forEach((m, i) =>
        message(
          String(i).padStart(6, "0"),
          m.role,
          m.text,
          m.at ?? at,
          m.nativeId,
        ),
      );
      // Readable content that is not a message stays searchable, with no speaker.
      for (let i = 0; i * remainderChunk < parsed.remainder.length; i++)
        message(
          `reference-${String(i).padStart(4, "0")}`,
          "reference",
          parsed.remainder.slice(i * remainderChunk, (i + 1) * remainderChunk),
          at,
          null,
        );
      this.store.put(kinds.source, {
        id,
        projectId: preview.projectId,
        text: preview.text,
      } satisfies ReferenceSource);
      this.store.save(kinds.reference, reference);
      this.changed();
      return { reference, duplicate: false };
    });
  }

  require(projectId: string, id: string): HistoryReference {
    const reference = this.store.get<HistoryReference>(kinds.reference, id);
    if (!reference) throw new Error("This import no longer exists.");
    if (reference.projectId !== projectId)
      throw new Error("This import belongs to another project.");
    return reference;
  }

  /**
   * The project's imports, newest first. A query matches file names and
   * formats, and the imported text through project history search.
   */
  list(input: {
    projectId: string;
    query?: string;
    cursor?: string | null;
    limit: number;
  }) {
    let items = this.references(input.projectId);
    const query = input.query?.trim();
    if (query) {
      const words = query.toLowerCase().split(/\s+/);
      const hits = new Set(
        this.store
          .searchPage(input.projectId, query, { limit: 500 })
          .items.map((m) => m.conversationId),
      );
      items = items.filter(
        (r) =>
          hits.has(r.conversationId) ||
          words.every((w) =>
            `${r.fileName} ${r.formatLabel} ${r.provider}`
              .toLowerCase()
              .includes(w),
          ),
      );
    }
    const start = Number(input.cursor ?? 0) || 0;
    const page = items.slice(start, start + input.limit);
    return {
      items: page,
      total: items.length,
      nextCursor:
        start + input.limit < items.length ? String(start + input.limit) : null,
    };
  }

  /** A slice of the import's full original text. */
  read(input: {
    projectId: string;
    id: string;
    offset: number;
    limit: number;
  }) {
    const reference = this.require(input.projectId, input.id);
    const source = this.store.get<ReferenceSource>(kinds.source, reference.id);
    if (!source) throw new Error("This import's text is no longer stored.");
    const end = input.offset + input.limit;
    return {
      reference,
      text: source.text.slice(input.offset, end),
      offset: input.offset,
      totalChars: source.text.length,
      nextOffset: end < source.text.length ? end : null,
    };
  }

  /**
   * Deletes an import, its text and its search entries. Sessions that
   * already started with it keep their frozen copy.
   */
  delete(input: { projectId: string; id: string }): { sessions: number } {
    const reference = this.require(input.projectId, input.id);
    const sessions = [
      ...this.store.iterate<SessionReference>(kinds.session, {
        projectId: reference.projectId,
      }),
    ].filter((s) => s.referenceId === reference.id).length;
    this.store.transaction(() => {
      this.store.deleteConversation(reference.conversationId);
      this.store.remove(kinds.source, reference.id);
      this.store.remove(kinds.reference, reference.id);
      this.store.event("history-reference.deleted", {
        id: reference.id,
        projectId: reference.projectId,
      });
    });
    this.changed();
    return { sessions };
  }

  /** A summary of what a session would freeze, for the New session attachment. */
  excerptSummary(projectId: string, id: string) {
    const reference = this.require(projectId, id);
    const excerpt = this.excerpt(reference);
    return {
      reference,
      includedMessages: excerpt.includedMessages,
      omissions: excerpt.omissions,
      characters: excerpt.text.length,
    };
  }

  private excerpt(reference: HistoryReference) {
    const source = this.store.get<ReferenceSource>(kinds.source, reference.id);
    if (!source) throw new Error("This import's text is no longer stored.");
    const parsed = parseImport(
      Buffer.from(source.text, "utf8"),
      reference.fileName,
    );
    return referenceExcerpt({
      messages: parsed.messages,
      remainder: parsed.remainder,
      provider: reference.provider,
    });
  }

  /**
   * Freezes a session's copy of an import: the same excerpt every intake,
   * goal round and loop of the session reads, kept apart from the import so
   * deleting the import does not change it.
   */
  freeze(input: {
    projectId: string;
    referenceId: string;
    sessionId: string;
  }): SessionReferenceSummary {
    const id = `${input.sessionId}:reference`;
    const existing = this.store.get<SessionReference>(kinds.session, id);
    if (existing) {
      const { text: _, ...summary } = existing;
      return summary;
    }
    const reference = this.require(input.projectId, input.referenceId);
    const excerpt = this.excerpt(reference);
    const frozen: SessionReference = {
      id,
      sessionId: input.sessionId,
      projectId: input.projectId,
      conversationId: input.sessionId,
      referenceId: reference.id,
      provider: reference.provider,
      fileName: reference.fileName,
      formatLabel: reference.formatLabel,
      importedAt: reference.importedAt,
      includedMessages: excerpt.includedMessages,
      messageCount: reference.messageCount,
      omissions: excerpt.omissions,
      text: excerpt.text,
      digest: hash(stable({ referenceId: reference.id, text: excerpt.text })),
      createdAt: now(),
    };
    this.store.immutable(kinds.session, frozen);
    const { text: _, ...summary } = frozen;
    return summary;
  }
}

/** A session's frozen import, read by every prompt that carries it. */
export function sessionReference(
  store: Store,
  id: string | null | undefined,
): SessionReference | null {
  return id ? (store.get<SessionReference>(kinds.session, id) ?? null) : null;
}
