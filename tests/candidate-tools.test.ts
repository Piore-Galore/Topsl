import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fixture } from "./helpers";
import { now } from "../packages/domain/invariants";
import type { ExecutionAttempt } from "../packages/domain/workflow";
import { captureCandidate } from "../packages/workflows/candidates";
import { ContextServer } from "../packages/workspace/context";
import {
  candidateTools,
  candidateToolset,
} from "../packages/context/candidate-tools";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

/** One review attempt granted one captured candidate, as the workflow grants
 * it before a review turn. */
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  const root = path.join(f.directory, "source"),
    marker = "reader-marker-7f3a";
  await mkdir(root);
  await writeFile(
    path.join(root, "large.txt"),
    "filler for the candidate reader\n".repeat(1000) + `last ${marker}\n`,
  );
  await writeFile(path.join(root, "small.txt"), "small file\n");
  await writeFile(path.join(root, "outside.txt"), "never captured\n");
  const candidate = await captureCandidate(f.store, {
    root,
    projectId: "p",
    workflowId: "w",
    selectedPaths: ["large.txt", "small.txt"],
    gitExecutable: "missing-git-fixture",
  });
  f.store.put("attempt", {
    id: "a",
    projectId: "p",
    taskId: "t",
    sessionId: "s",
    workspaceId: "ws",
  });
  f.store.put("task", {
    id: "t",
    projectId: "p",
    workflowId: "w",
    attemptIds: ["a"],
    workspaceId: "ws",
  });
  f.store.put("agent-session", { id: "s", projectId: "p", workspaceId: "ws" });
  const project = {
      id: "p",
      name: "reader fixture",
      path: root,
      realPath: root,
      trusted: true,
      createdAt: now(),
    },
    context = new ContextServer(f.store, f.directory),
    grant = context.grant(project, {
      candidates: [{ candidateId: candidate.id, revision: candidate.revision }],
      candidateVisibility: "task-inputs",
      subject: {
        attemptId: "a",
        agentSessionId: "s",
        workflowId: "w",
        taskId: "t",
      },
    }),
    tools = candidateTools({
      context,
      grant,
      attempt: f.store.get<ExecutionAttempt>("attempt", "a")!,
      candidate,
    });
  const call = (tool: string, args: unknown) =>
    tools.call({
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      namespace: candidateToolset.namespace,
      tool,
      arguments: args,
    });
  const receipts = () =>
    [...f.store.iterate<any>("candidate-retrieval", { projectId: "p" })].map(
      (receipt) => [receipt.attemptId, receipt.method, receipt.outcome],
    );
  return { ...f, candidate, context, marker, tools, call, receipts };
}

test("each declared tool reaches the reader, with the ids Topsl fills in", async () => {
  const f = await setup();
  expect(f.tools.toolset).toBe(candidateToolset);
  expect(candidateToolset.tools.map((tool) => tool.name)).toEqual([
    "list",
    "search",
    "read_range",
  ]);
  const list = await f.call("list", {});
  expect(list.success).toBe(true);
  expect(
    JSON.parse(list.text).items.map((item: { path: string }) => item.path),
  ).toEqual(["large.txt", "small.txt"]);
  const search = await f.call("search", { query: f.marker });
  expect(search.success).toBe(true);
  expect(JSON.parse(search.text).items).toEqual([
    expect.objectContaining({ path: "large.txt" }),
  ]);
  // Ids in the arguments are ignored: the model cannot name another attempt
  // or candidate.
  const read = await f.call("read_range", {
    path: "large.txt",
    offset: 32 * 1000,
    length: 64,
    attemptId: "another-attempt",
    candidateId: "another-candidate",
    projectId: "another-project",
  });
  expect(read.success).toBe(true);
  expect(JSON.parse(read.text)).toMatchObject({
    attemptId: "a",
    candidateId: f.candidate.id,
    candidateRevision: f.candidate.revision,
    path: "large.txt",
    content: `last ${f.marker}\n`,
  });
  expect(f.receipts()).toEqual([
    ["a", "candidate-list", "returned"],
    ["a", "candidate-search", "returned"],
    ["a", "candidate-read-range", "returned"],
  ]);
});

test("a path outside the grant is refused with a receipt, and a call after revocation is refused before the reader", async () => {
  const f = await setup();
  expect(await f.call("read_range", { path: "outside.txt" })).toEqual({
    text: "Candidate path is withheld or outside the scoped manifest.",
    success: false,
  });
  expect(f.receipts()).toEqual([["a", "candidate-read-range", "denied"]]);
  expect(await f.call("read_range", "large.txt")).toEqual({
    text: "Tool arguments must be a JSON object.",
    success: false,
  });
  expect(f.context.revokeAttempt("a")).toBe(1);
  expect(await f.call("read_range", { path: "large.txt" })).toEqual({
    text: "Invalid project context grant.",
    success: false,
  });
  // The revoked grant no longer reaches the reader, so no receipt is added.
  expect(f.receipts()).toHaveLength(1);
});
