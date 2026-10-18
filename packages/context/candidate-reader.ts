import { hash, now, stable, uid } from "../domain/invariants";
import type { Store } from "../persistence/store";
import {
  candidateFileRange,
  candidateRelativePath,
  type CandidateSnapshot,
} from "../workflows/candidates";
import type { AgentSession, ExecutionAttempt, Task } from "../domain/workflow";
import { assertRound2Feature } from "../domain/round2-features";

export interface CandidateAccess {
  candidateId: string;
  revision: string;
  /** Undefined means the whole manifest; [] means no files. */
  paths?: string[];
}
export interface CandidateReaderScope {
  projectId: string;
  subject?: {
    workflowId?: string;
    attemptId?: string;
    taskId?: string;
    agentSessionId?: string;
  };
  candidates?: CandidateAccess[];
  candidateVisibility?: "task-inputs" | "independent";
  grantId?: string;
}
export interface CandidateRetrievalReceipt {
  id: string;
  projectId: string;
  workflowId: string | null;
  attemptId: string | null;
  candidateId: string | null;
  candidateRevision: string | null;
  grantId: string | null;
  method: string;
  path: string | null;
  offset: number | null;
  bytes: number;
  outcome: "returned" | "denied";
  createdAt: string;
  ranges?: Array<{
    path: string;
    hash: string | null;
    offset: number;
    bytes: number;
  }>;
}
function bounded(value: unknown, fallback: number, max: number): number {
  const number = value ?? fallback;
  if (
    !Number.isSafeInteger(number) ||
    (number as number) < 1 ||
    (number as number) > max
  )
    throw new Error("Candidate request exceeds the bounded retrieval limit.");
  return number as number;
}
function cursor(
  value: unknown,
  scope: string,
): { index: number; offset: number } {
  if (value === undefined || value === null) return { index: 0, offset: 0 };
  try {
    if (typeof value !== "string" || value.length > 1024) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed.scope !== scope ||
      !Number.isSafeInteger(parsed.index) ||
      parsed.index < 0 ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    )
      throw new Error();
    return parsed;
  } catch {
    throw new Error("Invalid cursor for this candidate scope.");
  }
}
const nextCursor = (scope: string, index: number, offset = 0) =>
  Buffer.from(JSON.stringify({ scope, index, offset })).toString("base64url");
export function validateCandidateAccess(
  store: Store,
  scope: CandidateReaderScope,
): void {
  assertRound2Feature(store, "manifest-context");
  if (
    !scope.subject?.workflowId ||
    !scope.subject.attemptId ||
    !Array.isArray(scope.candidates) ||
    scope.candidates.length > 50
  )
    throw new Error(
      "Candidate access requires a workflow, attempt and explicit artifact allowlist.",
    );
  const attempt = store.get<ExecutionAttempt>(
      "attempt",
      scope.subject.attemptId,
    ),
    task = attempt ? store.get<Task>("task", attempt.taskId) : undefined,
    session = attempt
      ? store.get<AgentSession>("agent-session", attempt.sessionId)
      : undefined;
  if (
    !attempt ||
    !task ||
    !session ||
    attempt.projectId !== scope.projectId ||
    task.projectId !== scope.projectId ||
    session.projectId !== scope.projectId ||
    // A coordinator goal's task has no workflow; its explicit goal binding
    // stands in, and the goal ID is the candidate's workflow scope.
    (task.workflowId ??
      store.get<{ goalId: string }>("orchestration-task-goal", task.id)
        ?.goalId) !== scope.subject.workflowId ||
    !task.attemptIds.includes(attempt.id) ||
    attempt.workspaceId !== task.workspaceId ||
    session.workspaceId !== attempt.workspaceId ||
    (scope.subject.taskId !== undefined && scope.subject.taskId !== task.id) ||
    (scope.subject.agentSessionId !== undefined &&
      scope.subject.agentSessionId !== session.id)
  )
    throw new Error(
      "Candidate grant subject is not an attributed attempt/task/session in this project/workflow.",
    );
  for (const access of scope.candidates) {
    const candidate = store.get<CandidateSnapshot>(
      "candidate",
      access.candidateId,
    );
    if (
      !candidate ||
      candidate.projectId !== scope.projectId ||
      candidate.workflowId !== scope.subject.workflowId ||
      candidate.revision !== access.revision
    )
      throw new Error(
        "Candidate grant is outside its project/workflow/revision scope.",
      );
    if (access.paths !== undefined) {
      if (!Array.isArray(access.paths) || access.paths.length > 100000)
        throw new Error("Invalid candidate path allowlist.");
      for (const name of access.paths)
        if (
          !candidate.files.some(
            (f) =>
              f.path ===
              candidateRelativePath(name, candidate.formatVersion !== 2),
          )
        )
          throw new Error(
            "Candidate path allowlist is outside the pinned manifest.",
          );
    }
  }
}
export function candidateRequest(
  store: Store,
  scope: CandidateReaderScope,
  request: any,
): unknown {
  const receipt: CandidateRetrievalReceipt = {
    id: uid(),
    projectId: scope.projectId,
    workflowId: scope.subject?.workflowId ?? null,
    attemptId: scope.subject?.attemptId ?? null,
    candidateId:
      typeof request.candidateId === "string" ? request.candidateId : null,
    candidateRevision:
      typeof request.candidateRevision === "string"
        ? request.candidateRevision
        : null,
    grantId: scope.grantId ?? null,
    method: request.method,
    path: typeof request.path === "string" ? request.path : null,
    offset: Number.isSafeInteger(request.offset) ? request.offset : null,
    bytes: 0,
    outcome: "denied",
    createdAt: now(),
  };
  try {
    validateCandidateAccess(store, scope);
    if (
      request.projectId !== scope.projectId ||
      request.workflowId !== scope.subject!.workflowId ||
      request.attemptId !== scope.subject!.attemptId
    )
      throw new Error(
        "Candidate request does not match its project/workflow/attempt grant.",
      );
    const access = scope.candidates!.find(
      (a) =>
        a.candidateId === request.candidateId &&
        a.revision === request.candidateRevision,
    );
    if (!access)
      throw new Error(
        "Candidate artifact is withheld or outside the scoped grant.",
      );
    const candidate = store.get<CandidateSnapshot>(
      "candidate",
      access.candidateId,
    )!;
    // Filter before cursor computation, pagination, metadata or snippet production.
    const files = candidate.files.filter(
      (f) => access.paths === undefined || access.paths.includes(f.path),
    );
    const binding = {
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      projectId: scope.projectId,
      workflowId: scope.subject!.workflowId,
      attemptId: scope.subject!.attemptId,
      visibility: scope.candidateVisibility ?? "task-inputs",
    };
    const fingerprint = hash(
      stable({
        binding,
        paths: access.paths,
        method: request.method,
        query: request.query ?? null,
      }),
    );
    let result: unknown;
    if (request.method === "candidate-list") {
      const page = cursor(request.cursor, fingerprint),
        limit = bounded(request.limit, 25, 50);
      const items = files
        .slice(page.index, page.index + limit)
        .map(({ content: _, ...file }) => file);
      result = {
        ...binding,
        items,
        nextCursor:
          page.index + limit < files.length
            ? nextCursor(fingerprint, page.index + limit)
            : null,
      };
    } else if (request.method === "candidate-search") {
      if (
        typeof request.query !== "string" ||
        !request.query.length ||
        request.query.length > 500
      )
        throw new Error("Candidate search requires a bounded literal query.");
      const page = cursor(request.cursor, fingerprint),
        limit = bounded(request.limit, 20, 50),
        items: Array<{
          path: string;
          hash: string | null;
          offset: number;
          snippet: string;
        }> = [],
        needle = Buffer.from(request.query, "utf8");
      let index = page.index,
        offset = page.offset,
        scanned = 0;
      receipt.ranges = [];
      while (
        index < files.length &&
        scanned < 1024 * 1024 &&
        items.length < limit
      ) {
        const file = files[index];
        if (file.type === "binary" || !file.hash) {
          index++;
          offset = 0;
          continue;
        }
        const length = Math.min(64 * 1024, file.bytes - offset);
        if (length <= 0) {
          index++;
          offset = 0;
          continue;
        }
        const bytes = candidateFileRange(
          candidate,
          file.path,
          { offset, length },
          store,
        )!;
        let start = 0,
          lastEnd = 0;
        while (items.length < limit) {
          const at = bytes.indexOf(needle, start);
          if (at < 0) break;
          const snippetStart = Math.max(0, at - 100),
            snippetEnd = Math.min(bytes.length, at + needle.length + 100),
            snippetBytes = bytes.subarray(snippetStart, snippetEnd);
          items.push({
            path: file.path,
            hash: file.hash,
            offset: offset + at,
            snippet: snippetBytes.toString("utf8"),
          });
          receipt.ranges.push({
            path: file.path,
            hash: file.hash,
            offset: offset + snippetStart,
            bytes: snippetBytes.length,
          });
          receipt.bytes += snippetBytes.length;
          start = lastEnd = at + needle.length;
        }
        scanned += length;
        if (items.length >= limit) {
          offset += lastEnd;
        } else if (offset + length >= file.bytes) {
          index++;
          offset = 0;
        } else offset += Math.max(1, length - needle.length + 1);
      }
      result = {
        ...binding,
        items,
        scannedBytes: scanned,
        nextCursor:
          index < files.length ? nextCursor(fingerprint, index, offset) : null,
        coverage:
          index < files.length
            ? "bounded-page; continue with cursor"
            : "permitted text files scanned; binary content excluded",
      };
    } else if (
      request.method === "candidate-read-range" ||
      request.method === "candidate-read-binary"
    ) {
      const name = candidateRelativePath(
          request.path,
          candidate.formatVersion !== 2,
        ),
        file = files.find((f) => f.path === name);
      if (!file)
        throw new Error(
          "Candidate path is withheld or outside the scoped manifest.",
        );
      const offset = request.offset ?? 0,
        length = bounded(request.length, 64 * 1024, 256 * 1024);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes)
        throw new Error("Invalid candidate range offset.");
      if (request.method === "candidate-read-range" && file.type === "binary")
        throw new Error(
          "Use the supported binary route for binary candidate bytes; manual verification may still be required.",
        );
      const bytes =
        candidateFileRange(candidate, name, { offset, length }, store) ??
        Buffer.alloc(0);
      receipt.bytes = bytes.length;
      let encoding: "base64" | "utf8" =
        request.method === "candidate-read-binary" ? "base64" : "utf8";
      if (encoding === "utf8")
        try {
          new TextDecoder("utf8", { fatal: true }).decode(bytes);
        } catch {
          encoding = "base64";
        }
      receipt.ranges = [
        { path: name, hash: file.hash, offset, bytes: bytes.length },
      ];
      result = {
        ...binding,
        path: name,
        hash: file.hash,
        rangeHash: hash(bytes),
        fileBytes: file.bytes,
        offset,
        returnedBytes: bytes.length,
        nextOffset:
          offset + bytes.length < file.bytes ? offset + bytes.length : null,
        encoding,
        content: bytes.toString(encoding),
        reviewCoverage:
          file.type === "binary"
            ? "Returned bytes do not establish supported visual/model inspection; changed binary verification remains explicit."
            : encoding === "base64"
              ? "Range crosses a UTF-8 boundary; exact pinned bytes are encoded as base64."
              : "returned pinned range; comprehension not established",
      };
    } else throw new Error("Unsupported candidate retrieval method.");
    receipt.outcome = "returned";
    return result;
  } finally {
    store.immutable("candidate-retrieval", receipt);
  }
}
