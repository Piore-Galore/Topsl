import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { now } from "../domain/invariants";
import { Store } from "../persistence/store";
import type { ToolBinding } from "../providers/contract";
import {
  captureCandidate,
  type CandidateSnapshot,
} from "../workflows/candidates";
import { ContextServer } from "../workspace/context";
import type { CandidateRetrievalReceipt } from "./candidate-reader";
import { candidateTools } from "./candidate-tools";

/** A one-file build for the qualification's reader probe, with the
 * reviewer's tools bound to it. */
export interface ReaderProbe {
  tools: ToolBinding;
  /** The file the model is asked to read. */
  path: string;
  /** The file's only line. Topsl keeps it in an encrypted store of its own,
   * so no folder the model can read holds it. */
  marker: string;
  /** read_range answers that returned the whole marker, under this probe's
   * attempt and grant. */
  markerReads(): number;
  /** Requests the reader refused under this probe's grant. */
  refusedRequests(): number;
  /** Revokes the grant and closes the store. Later calls are refused. */
  close(): void;
}

/**
 * Captures a one-file build into a new encrypted store in `directory` and
 * grants one probe attempt access to it, as the workflow grants a review
 * attempt. The file is written to a new folder under `sourceParent`, which is
 * normally outside any Git checkout, so it is captured as a plain folder; the
 * folder is deleted once captured. The caller should prepare the probe before
 * it starts a runtime.
 */
export async function createReaderProbe(
  directory: string,
  sourceParent = os.tmpdir(),
): Promise<ReaderProbe> {
  const id = randomBytes(6).toString("hex"),
    marker = `TOPSL-READER-${randomBytes(6).toString("hex")}`,
    file = `reader-${id}.txt`,
    projectId = `qualification-${id}`,
    workflowId = `qualification-workflow-${id}`,
    taskId = `qualification-task-${id}`,
    attemptId = `qualification-attempt-${id}`,
    sessionId = `qualification-session-${id}`,
    workspaceId = `qualification-workspace-${id}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const store = new Store(
      path.join(directory, "reader.sqlite"),
      randomBytes(32).toString("hex"),
    ),
    // Never started: the probe's calls reach it inside Topsl, not by socket.
    context = new ContextServer(store, directory);
  try {
    const source = await mkdtemp(
      path.join(sourceParent, "topsl-reader-probe-"),
    );
    let candidate: CandidateSnapshot;
    try {
      await writeFile(path.join(source, file), `${marker}\n`, { mode: 0o600 });
      candidate = await captureCandidate(store, {
        root: source,
        projectId,
        workflowId,
        selectedPaths: [file],
      });
    } finally {
      await rm(source, { recursive: true, force: true });
    }
    // The reader answers only an attempt, task and session it can attribute;
    // these records hold just the fields it checks.
    store.put("attempt", {
      id: attemptId,
      projectId,
      taskId,
      sessionId,
      workspaceId,
    });
    store.put("task", {
      id: taskId,
      projectId,
      workflowId,
      attemptIds: [attemptId],
      workspaceId,
    });
    store.put("agent-session", { id: sessionId, projectId, workspaceId });
    const grant = context.grant(
      {
        id: projectId,
        name: "Runtime qualification",
        path: source,
        realPath: source,
        trusted: true,
        createdAt: now(),
      },
      {
        visibility: { messageIds: [] },
        candidates: [
          { candidateId: candidate.id, revision: candidate.revision },
        ],
        candidateVisibility: "task-inputs",
        subject: { attemptId, agentSessionId: sessionId, workflowId, taskId },
      },
    );
    const tools = candidateTools({
        context,
        grant,
        attempt: { id: attemptId, projectId },
        candidate,
      }),
      receipts = () =>
        [
          ...store.iterate<CandidateRetrievalReceipt>("candidate-retrieval", {
            projectId,
          }),
        ].filter((r) => r.attemptId === attemptId && r.grantId === grant.grant);
    let closed = false;
    return {
      tools,
      path: file,
      marker,
      markerReads: () =>
        receipts().filter(
          (r) =>
            r.method === "candidate-read-range" &&
            r.outcome === "returned" &&
            !!r.ranges?.some(
              (range) =>
                range.path === file &&
                range.offset === 0 &&
                range.bytes >= Buffer.byteLength(marker),
            ),
        ).length,
      refusedRequests: () =>
        receipts().filter((r) => r.outcome === "denied").length,
      close() {
        if (closed) return;
        closed = true;
        context.revokeAttempt(attemptId);
        context.close();
        store.close();
      },
    };
  } catch (error) {
    context.close();
    store.close();
    throw error;
  }
}
