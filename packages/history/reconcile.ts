import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { hash, now, stable, safeError } from "../domain/invariants";
import type { Conversation, Message, Project, Provider } from "../domain/types";
import type { NativeHistorySource, NativeMessageSource } from "../domain/sync";
import { Store } from "../persistence/store";
import { SyncRepository } from "../sync/reconciler";

export const HISTORY_PARSER_VERSION = "native-text-jsonl-v1";
const MAX_SOURCE_BYTES = 30_000_000;
interface JsonRecord {
  value: Record<string, unknown>;
  start: number;
  end: number;
  order: number;
}
interface ReadSource {
  bytes: Buffer;
  identity: string;
  canonicalFile: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(object)
    .filter(
      (part) =>
        ["text", "input_text", "output_text"].includes(String(part.type)) &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}
async function readSource(
  selectedFile: string,
  approvedCanonical?: string,
): Promise<ReadSource> {
  if (
    !path.isAbsolute(selectedFile) ||
    ![".jsonl", ".ndjson"].includes(path.extname(selectedFile).toLowerCase())
  )
    throw new Error(
      "Select one explicit absolute JSONL transcript file; native databases and directory scans are not supported.",
    );
  const canonicalFile = await realpath(selectedFile);
  if (approvedCanonical && canonicalFile !== approvedCanonical)
    throw new Error(
      "Approved transcript path changed. Review the new source before reading.",
    );
  const handle = await open(
    canonicalFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES)
      throw new Error(
        "Native transcript must be a regular file within the 30 MB source limit.",
      );
    const bytes = Buffer.alloc(before.size);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      count !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino ||
      canonicalFile !== (await realpath(selectedFile))
    )
      throw new Error(
        "Native transcript changed while reading. Retry its stable source snapshot.",
      );
    return { bytes, canonicalFile, identity: `${before.dev}:${before.ino}` };
  } finally {
    await handle.close();
  }
}
function records(
  bytes: Buffer,
  completeTrailing: boolean,
): { records: JsonRecord[]; cursor: number; pendingBytes: number } {
  const result: JsonRecord[] = [];
  let start = 0,
    order = 0;
  function add(end: number, jsonEnd: number): void {
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(start, jsonEnd))
        .replace(/\r$/, "");
    } catch {
      throw new Error(
        `Invalid UTF-8 record at byte ${start}. Durable cursor was retained.`,
      );
    }
    if (line.trim()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(
          `Invalid complete JSONL record at byte ${start}. Durable cursor was retained.`,
        );
      }
      if (!object(value))
        throw new Error(
          `Unsupported native record at byte ${start}. Durable cursor was retained.`,
        );
      result.push({ value, start, end, order: order++ });
    }
    start = end;
  }
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) add(i + 1, i);
  if (completeTrailing && start < bytes.length) {
    // Explicit finite-file imports may include a complete final JSON value without LF.
    // A live source never commits a trailing record before its newline is durable.
    try {
      JSON.parse(bytes.subarray(start).toString("utf8"));
      add(bytes.length, bytes.length);
    } catch {
      /* Preserve the trailing partial bytes. */
    }
  }
  return { records: result, cursor: start, pendingBytes: bytes.length - start };
}
async function validateBinding(
  project: Project,
  provider: Provider,
  sessionId: string,
  source: JsonRecord[],
): Promise<void> {
  for (const { value } of source) {
    const payload = object(value.payload) ? value.payload : null;
    const nativeSession =
      provider === "codex" && value.type === "session_meta"
        ? payload?.id
        : provider === "claude"
          ? value.sessionId
          : undefined;
    if (nativeSession !== undefined && nativeSession !== sessionId)
      throw new Error(
        "Native transcript session identity differs from the approved source.",
      );
    const cwd =
      provider === "codex" && value.type === "session_meta"
        ? payload?.cwd
        : provider === "claude"
          ? value.cwd
          : undefined;
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd))
        throw new Error("Native transcript has an invalid project identity.");
      let canonical: string;
      try {
        canonical = await realpath(cwd);
      } catch {
        throw new Error(
          "The native transcript project is unavailable; its provenance cannot be verified.",
        );
      }
      if (canonical !== project.realPath)
        throw new Error(
          "This native transcript belongs to a different project.",
        );
    }
  }
}
export async function discoverExplicitHistoryIdentity(
  provider: Provider,
  file: string,
): Promise<string> {
  const source = await readSource(file),
    parsed = records(source.bytes, true);
  for (const { value } of parsed.records) {
    const payload = object(value.payload) ? value.payload : null;
    const id =
      provider === "codex" && value.type === "session_meta"
        ? payload?.id
        : provider === "claude"
          ? value.sessionId
          : undefined;
    if (typeof id === "string" && id.length && id.length <= 4096) return id;
  }
  throw new Error(
    "This transcript has no supported native session identity. Choose a supported source rather than inferring a resumable session.",
  );
}
export class HistoryReconciler {
  constructor(readonly store: Store) {}
  sources(projectId: string): NativeHistorySource[] {
    return [
      ...this.store.iterate<NativeHistorySource>("native-history-source", {
        projectId,
      }),
    ];
  }
  async approve(input: {
    project: Project;
    provider: Provider;
    profileId: string;
    sessionId: string;
    file: string;
  }): Promise<NativeHistorySource> {
    if (!input.project.trusted)
      throw new Error(
        "Approve this project before opting into native history reconciliation.",
      );
    if (
      !input.profileId.trim() ||
      !input.sessionId.trim() ||
      input.profileId.length > 4096 ||
      input.sessionId.length > 4096
    )
      throw new Error(
        "An explicit native profile and session identity are required.",
      );
    if (!path.isAbsolute(input.file))
      throw new Error("Select one explicit absolute JSONL transcript file.");
    const file = path.resolve(input.file),
      source = await readSource(file),
      parsed = records(source.bytes, true);
    await validateBinding(
      input.project,
      input.provider,
      input.sessionId,
      parsed.records,
    );
    const id = hash(
      stable([
        input.project.id,
        input.provider,
        input.profileId,
        input.sessionId,
        source.canonicalFile,
      ]),
    );
    const old = this.store.get<NativeHistorySource>(
      "native-history-source",
      id,
    );
    const legacyId = `import:${input.provider}:${hash(`${input.project.id}:${input.sessionId}`)}`;
    // The explicit-import compatibility profile has unknown original native profile
    // provenance. Reuse its old reference IDs only; actual approved profiles remain separate.
    const legacy =
      input.profileId === "explicit-import" &&
      this.store.get<Conversation>("conversation", legacyId);
    const conversationId = legacy
      ? legacyId
      : `native-reference:${hash(stable([input.project.id, input.provider, input.profileId, input.sessionId]))}`;
    // Preserve legacy imports' deletion boundary when the exact session was already deleted.
    if (
      this.store.get("tombstone", conversationId) ||
      this.store.get(
        "tombstone",
        `import:${input.provider}:${hash(`${input.project.id}:${input.sessionId}`)}`,
      )
    )
      throw new Error(
        "Deleted history tombstones prevent reimport of this native session.",
      );
    if (old && old.parserVersion !== HISTORY_PARSER_VERSION)
      throw new Error(
        "Native parser version changed. Review a supported migration before continuing the cursor.",
      );
    const value: NativeHistorySource = old
      ? {
          ...old,
          enabled: true,
          revision: old.revision + 1,
          state: "pending",
          detail: "Explicit source approved; reconciliation is pending.",
        }
      : {
          id,
          projectId: input.project.id,
          provider: input.provider,
          profileId: input.profileId,
          sessionId: input.sessionId,
          selectedFile: file,
          canonicalFile: source.canonicalFile,
          conversationId,
          parserVersion: HISTORY_PARSER_VERSION,
          enabled: true,
          revision: 1,
          cursor: 0,
          prefixHash: hash(""),
          fileIdentity: source.identity,
          recordCount: 0,
          sourceRevision: null,
          pendingBytes: 0,
          state: "pending",
          coverageLosses: [],
          lastCheckedAt: null,
          lastSuccessAt: null,
          detail: "Explicit source approved; reconciliation is pending.",
          approvedAt: now(),
        };
    this.store.save("native-history-source", value);
    return value;
  }
  pause(sourceId: string, expectedRevision: number): NativeHistorySource {
    const source = this.requireSource(sourceId);
    if (source.revision !== expectedRevision)
      throw new Error("History source changed; refresh before pausing it.");
    const value = {
      ...source,
      enabled: false,
      revision: source.revision + 1,
      state: "paused" as const,
      detail:
        "History source paused; native file and imported history are preserved.",
    };
    this.store.save("native-history-source", value);
    return value;
  }
  async reconcile(
    sourceId: string,
    options: { completeTrailing?: boolean } = {},
  ): Promise<{
    source: NativeHistorySource;
    conversationId: string;
    imported: number;
    duplicates: number;
  }> {
    const source = this.requireSource(sourceId);
    if (!source.enabled)
      throw new Error(
        "This source is paused. Explicitly approve it again before reading.",
      );
    if (source.parserVersion !== HISTORY_PARSER_VERSION)
      throw new Error(
        "Native parser version changed. Review migration before advancing this source.",
      );
    const project = this.store.get<Project>("project", source.projectId);
    if (!project?.trusted)
      throw new Error(
        "Native history source's project is missing or no longer approved.",
      );
    if (this.store.get("tombstone", source.conversationId)) {
      const deleted = {
        ...source,
        enabled: false,
        revision: source.revision + 1,
        state: "deleted" as const,
        detail:
          "Conversation deleted; source is disabled and its tombstone prevents resurrection.",
      };
      this.store.save("native-history-source", deleted);
      throw new Error(deleted.detail);
    }
    try {
      const read = await readSource(source.selectedFile, source.canonicalFile),
        parsed = records(read.bytes, options.completeTrailing ?? false);
      await validateBinding(
        project,
        source.provider,
        source.sessionId,
        parsed.records,
      );
      let loss: NativeHistorySource["coverageLosses"][number]["reason"] | null =
        read.identity !== source.fileIdentity
          ? "rotation"
          : read.bytes.length < source.cursor
            ? "truncation"
            : hash(read.bytes.subarray(0, source.cursor)) !== source.prefixHash
              ? "rewrite"
              : null;
      const sourceRevision = hash(read.bytes),
        occurrences = new Map<string, number>(),
        messages: Array<Message & { source: NativeMessageSource }> = [];
      for (const record of parsed.records) {
        const value = record.value;
        const payload =
          source.provider === "codex" &&
          value.type === "response_item" &&
          object(value.payload)
            ? value.payload
            : source.provider === "claude" &&
                ["user", "assistant"].includes(String(value.type)) &&
                object(value.message)
              ? value.message
              : null;
        if (!payload || !["user", "assistant"].includes(String(payload.role)))
          continue;
        const text = textContent(payload.content);
        if (!text) continue;
        const recordHash = hash(stable(value)),
          occurrence = occurrences.get(recordHash) ?? 0;
        occurrences.set(recordHash, occurrence + 1);
        const nativeId =
          typeof value.uuid === "string"
            ? value.uuid
            : typeof payload.id === "string"
              ? payload.id
              : null;
        const stableIdentity = nativeId
          ? `native:${nativeId}`
          : `record:${recordHash}:${occurrence}`;
        const messageId = source.conversationId.startsWith("import:")
          ? `${source.conversationId}:${nativeId ?? record.order}`
          : `${source.conversationId}:${hash(stableIdentity)}`;
        const timestamp =
          typeof value.timestamp === "string" &&
          Number.isFinite(Date.parse(value.timestamp))
            ? value.timestamp
            : null;
        const contentHash = hash(
          stable({ role: payload.role, text, nativeId, timestamp }),
        );
        messages.push({
          id: messageId,
          projectId: source.projectId,
          conversationId: source.conversationId,
          role: payload.role as "user" | "assistant",
          provider: source.provider,
          text,
          nativeId,
          runId: null,
          createdAt: timestamp ?? source.approvedAt,
          source: {
            sourceId,
            sourceRevision,
            contentHash,
            recordHash,
            parserVersion: source.parserVersion,
            nativeOrder: record.order,
            byteStart: record.start,
            byteEnd: record.end,
          },
        });
      }
      return this.store.transaction(() => {
        const current = this.requireSource(sourceId);
        if (current.revision !== source.revision || !current.enabled)
          throw new Error(
            "History source changed while reading. Retry after reviewing its current state.",
          );
        if (this.store.get("tombstone", source.conversationId))
          throw new Error(
            "Deletion tombstone prevents native history resurrection.",
          );
        let imported = 0,
          duplicates = 0;
        for (const message of messages) {
          const old = this.store.get<
            Message & { source?: NativeMessageSource }
          >("message", message.id);
          if (old) {
            const oldHash = old.source?.contentHash;
            const compatibleLegacy =
              !oldHash &&
              source.profileId === "explicit-import" &&
              source.conversationId.startsWith("import:") &&
              old.role === message.role &&
              old.text === message.text &&
              old.nativeId === message.nativeId;
            if (
              (!oldHash || oldHash !== message.source.contentHash) &&
              !compatibleLegacy
            )
              throw new Error(
                "Native event ID collision with different content; no imported record or cursor was changed.",
              );
            duplicates++;
            continue;
          }
          this.store.message(message);
          imported++;
        }
        if (
          messages.length &&
          !this.store.get("conversation", source.conversationId)
        )
          this.store.save("conversation", {
            id: source.conversationId,
            projectId: source.projectId,
            title: `Imported ${source.provider} · ${path.basename(source.canonicalFile).slice(0, 80)}`,
            nativeSessions: {},
            createdAt: source.approvedAt,
          } satisfies Conversation);
        const at = now(),
          coverageLosses = [
            ...source.coverageLosses,
            ...(loss
              ? [{ at, reason: loss, previousCursor: source.cursor }]
              : []),
          ];
        const next: NativeHistorySource = {
          ...source,
          revision: source.revision + 1,
          cursor: parsed.cursor,
          prefixHash: hash(read.bytes.subarray(0, parsed.cursor)),
          fileIdentity: read.identity,
          recordCount: parsed.records.length,
          sourceRevision,
          pendingBytes: parsed.pendingBytes,
          coverageLosses,
          state: coverageLosses.length
            ? "stale"
            : parsed.pendingBytes
              ? "partial"
              : "current",
          lastCheckedAt: at,
          lastSuccessAt: at,
          detail: coverageLosses.length
            ? "Source coverage changed through rotation, truncation, or rewrite; prior imported evidence is retained and missing coverage remains visible."
            : parsed.pendingBytes
              ? "Complete records imported; trailing bytes remain uncommitted until a complete record boundary."
              : "Supported native text records reconciled through the durable source cursor; imported references remain non-resumable.",
        };
        this.store.save("native-history-source", next);
        new SyncRepository(this.store).observe({
          projectId: next.projectId,
          dimension: "history",
          targetId: sourceId,
          state: next.state === "current" ? "current" : "stale",
          evidence: {
            level: "source-observation",
            source: sourceId,
            observedAt: at,
            detail: `${source.parserVersion}; durable byte cursor ${next.cursor}; ${next.pendingBytes} uncommitted trailing bytes.`,
          },
          expectedRevision: source.sourceRevision,
          observedRevision: sourceRevision,
          detail: next.detail,
          suggestedAction:
            next.state === "current"
              ? null
              : "Review source coverage or wait for the trailing record to complete.",
        });
        this.store.event("history.reconciled", {
          projectId: source.projectId,
          sourceId,
          conversationId: source.conversationId,
          imported,
          duplicates,
          cursor: next.cursor,
          sourceRevision,
          parserVersion: source.parserVersion,
        });
        return {
          source: next,
          conversationId: source.conversationId,
          imported,
          duplicates,
        };
      });
    } catch (error) {
      const current = this.requireSource(sourceId);
      if (current.revision === source.revision)
        this.store.save("native-history-source", {
          ...source,
          revision: source.revision + 1,
          state: "error",
          lastCheckedAt: now(),
          detail: safeError(error),
        });
      throw error;
    }
  }
  private requireSource(id: string): NativeHistorySource {
    const source = this.store.get<NativeHistorySource>(
      "native-history-source",
      id,
    );
    if (!source)
      throw new Error(
        "Explicitly approve one transcript source before reconciling native history.",
      );
    return source;
  }
}
