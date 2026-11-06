import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { now } from "../packages/domain/invariants";
import { Store } from "../packages/persistence/store";
import { candidateTools } from "../packages/context/candidate-tools";
import { ContextServer } from "../packages/workspace/context";
import { captureCandidate } from "../packages/workflows/candidates";

/**
 * A turn may read a candidate an earlier workflow made (a loop iteration's
 * accepted checkpoint, a continued session's work) only when the driver
 * recorded that candidate as the attempt's input. Found on 6 November 2026:
 * a Claude coordinator's reader in an Endless loop's second iteration was
 * refused because its checkpoint came from the first iteration's goal.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-input-"));
  const store = new Store(
    path.join(directory, "store.sqlite"),
    randomBytes(32).toString("hex"),
  );
  const context = new ContextServer(store, directory);
  cleanups.push(async () => {
    context.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, "source");
  await mkdir(source);
  await writeFile(path.join(source, "file.ts"), "export const value = 2;\n");
  const projectId = "p";
  // Captured by the first iteration's goal.
  const candidate = await captureCandidate(store, {
    root: source,
    projectId,
    workflowId: "goal-iteration-1",
    selectedPaths: ["file.ts"],
  });
  // The reading attempt belongs to the second iteration's goal.
  const record = (attemptId: string) => {
    const taskId = `task-${attemptId}`,
      sessionId = `session-${attemptId}`;
    store.put("attempt", {
      id: attemptId,
      projectId,
      taskId,
      sessionId,
      workspaceId: "w",
    });
    store.put("task", {
      id: taskId,
      projectId,
      workflowId: "goal-iteration-2",
      attemptIds: [attemptId],
      workspaceId: "w",
    });
    store.put("agent-session", { id: sessionId, projectId, workspaceId: "w" });
    return { attemptId, taskId, sessionId };
  };
  const project = {
    id: projectId,
    name: "fixture",
    path: source,
    realPath: source,
    trusted: true,
    createdAt: now(),
  };
  const grant = (subject: ReturnType<typeof record>) =>
    context.grant(project, {
      visibility: { messageIds: [] },
      candidates: [{ candidateId: candidate.id, revision: candidate.revision }],
      candidateVisibility: "task-inputs",
      subject: {
        attemptId: subject.attemptId,
        agentSessionId: subject.sessionId,
        workflowId: "goal-iteration-2",
        taskId: subject.taskId,
      },
    });
  return { store, context, candidate, projectId, record, grant };
}

test("a candidate from an earlier workflow is refused unless it is the attempt's recorded input", async () => {
  const f = await setup();
  const reader = f.record("attempt-reader");
  expect(() => f.grant(reader)).toThrow(
    "Candidate grant is outside its project/workflow/revision scope.",
  );
  // Another attempt's binding does not admit it.
  const other = f.record("attempt-other");
  f.store.immutable("candidate-input-binding", {
    id: other.attemptId,
    projectId: f.projectId,
    goalId: "goal-iteration-2",
    candidateId: f.candidate.id,
  });
  expect(() => f.grant(reader)).toThrow("outside its project/workflow");
  // Nor does a binding recorded under another project.
  f.store.immutable("candidate-input-binding", {
    id: reader.attemptId,
    projectId: "elsewhere",
    goalId: "goal-iteration-2",
    candidateId: f.candidate.id,
  });
  expect(() => f.grant(reader)).toThrow("outside its project/workflow");
});

test("the attempt's recorded input is readable through the reader tools under the reading workflow", async () => {
  const f = await setup();
  const reader = f.record("attempt-reader");
  f.store.immutable("candidate-input-binding", {
    id: reader.attemptId,
    projectId: f.projectId,
    goalId: "goal-iteration-2",
    candidateId: f.candidate.id,
  });
  const grant = f.grant(reader);
  const tools = candidateTools({
    context: f.context,
    grant,
    attempt: { id: reader.attemptId, projectId: f.projectId },
    candidate: f.candidate,
    workflowId: "goal-iteration-2",
  });
  const read = await tools.call({
    threadId: "t",
    turnId: "u",
    callId: "c",
    namespace: tools.toolset.namespace,
    tool: "read_range",
    arguments: { path: "file.ts" },
  });
  expect(read.success).toBe(true);
  expect(read.text).toContain("value = 2");
  // Under the candidate's own workflow instead, the request does not match
  // the grant and is refused.
  const mismatched = candidateTools({
    context: f.context,
    grant,
    attempt: { id: reader.attemptId, projectId: f.projectId },
    candidate: f.candidate,
  });
  const refused = await mismatched.call({
    threadId: "t",
    turnId: "u",
    callId: "d",
    namespace: tools.toolset.namespace,
    tool: "read_range",
    arguments: { path: "file.ts" },
  });
  expect(refused.success).toBe(false);
});
