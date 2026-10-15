import type { Store } from "../persistence/store";
import {
  candidateFileBytes,
  candidateRelativePath,
  type CandidateFile,
  type CandidateSnapshot,
} from "./candidates";

export interface DiffLine {
  line: number;
  text: string;
}
export interface CandidateDiffFile {
  path: string;
  kind: "added" | "deleted" | "modified" | "mode-changed";
  beforeHash: string | null;
  afterHash: string | null;
  binary: boolean;
  before: DiffLine[];
  after: DiffLine[];
  omittedBeforeLines: number;
  omittedAfterLines: number;
  detail: string;
}

/** A bounded comparison of protected artifact bytes. It never reads the live workspace. */
export function candidateDiff(
  store: Store,
  baseline: CandidateSnapshot,
  candidate: CandidateSnapshot,
  options: { path?: string; offset?: number; limit?: number } = {},
) {
  if (
    baseline.projectId !== candidate.projectId ||
    baseline.workflowId !== candidate.workflowId
  )
    throw new Error(
      "Candidate diff cannot cross a project or workflow boundary.",
    );
  const offset = options.offset ?? 0,
    limit = options.limit ?? 20;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Invalid candidate diff page.");
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const after = new Map(candidate.files.map((file) => [file.path, file]));
  const selectedPath =
    options.path === undefined
      ? undefined
      : candidateRelativePath(options.path);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((name) => {
      const old = before.get(name),
        next = after.get(name);
      return (
        (!selectedPath || name === selectedPath) &&
        ((old?.hash ?? null) !== (next?.hash ?? null) ||
          ((old?.mode ?? 0) & 0o111) !== ((next?.mode ?? 0) & 0o111))
      );
    });
  let remainingBytes = 200_000,
    remainingLines = 1000;
  const text = (
    snapshot: CandidateSnapshot,
    file: CandidateFile | undefined,
  ): string[] | null => {
    if (!file?.hash) return [];
    if (file.type === "binary" || file.bytes > 500_000) return null;
    const bytes = candidateFileBytes(snapshot, file, store);
    if (!bytes || bytes.includes(0)) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .split("\n");
    } catch {
      return null;
    }
  };
  const files = changed
    .slice(offset, offset + limit)
    .map((name): CandidateDiffFile => {
      const old = before.get(name),
        next = after.get(name);
      const entry: CandidateDiffFile = {
        path: name,
        kind: !old?.hash
          ? "added"
          : !next?.hash
            ? "deleted"
            : old.hash === next.hash
              ? "mode-changed"
              : "modified",
        beforeHash: old?.hash ?? null,
        afterHash: next?.hash ?? null,
        binary: old?.type === "binary" || next?.type === "binary",
        before: [],
        after: [],
        omittedBeforeLines: 0,
        omittedAfterLines: 0,
        detail:
          "Protected candidate bytes; line numbers refer to their respective revisions.",
      };
      const oldText = text(baseline, old),
        newText = text(candidate, next);
      if (!oldText || !newText) {
        entry.detail = entry.binary
          ? "Binary change requires its recorded supported or manual verification route. Text was not decoded."
          : "Text preview is unavailable or exceeds the bounded diff limit. Inspect pinned ranges through the candidate reader.";
        return entry;
      }
      let prefix = 0,
        suffix = 0;
      while (
        prefix < oldText.length &&
        prefix < newText.length &&
        oldText[prefix] === newText[prefix]
      )
        prefix++;
      while (
        suffix < oldText.length - prefix &&
        suffix < newText.length - prefix &&
        oldText[oldText.length - suffix - 1] ===
          newText[newText.length - suffix - 1]
      )
        suffix++;
      const start = Math.max(0, prefix - 3);
      const append = (
        lines: string[],
        destination: DiffLine[],
        end: number,
      ) => {
        let included = 0;
        for (
          let index = start;
          index < end && included < 150 && remainingLines > 0;
          index++
        ) {
          const value = lines[index];
          const bytes = Buffer.byteLength(value);
          // Omit a huge line instead of allocating an unbounded DOM node.
          if (bytes > 16_000 || bytes > remainingBytes) break;
          destination.push({ line: index + 1, text: value });
          included++;
          remainingLines--;
          remainingBytes -= bytes;
        }
        return Math.max(0, end - start - included);
      };
      entry.omittedBeforeLines = append(
        oldText,
        entry.before,
        Math.min(oldText.length, oldText.length - suffix + 3),
      );
      entry.omittedAfterLines = append(
        newText,
        entry.after,
        Math.min(newText.length, newText.length - suffix + 3),
      );
      if (entry.omittedBeforeLines || entry.omittedAfterLines)
        entry.detail +=
          " Diff excerpts are truncated; additional pinned ranges remain available.";
      return entry;
    });
  return {
    projectId: candidate.projectId,
    workflowId: candidate.workflowId,
    baseCandidateId: baseline.id,
    candidateId: candidate.id,
    baseRevision: baseline.revision,
    candidateRevision: candidate.revision,
    files,
    changedFiles: changed.length,
    nextOffset:
      offset + files.length < changed.length ? offset + files.length : null,
    limits: {
      files: limit,
      bytes: 200_000,
      lines: 1000,
      perFileBytes: 500_000,
    },
  };
}
