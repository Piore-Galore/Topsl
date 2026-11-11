import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildConversation, compactionCut } from "../packages/harness/context";
import { PathRejected, resolveInside } from "../packages/harness/paths";

/**
 * Two boundaries of the native harness that have no model in them: where a
 * compaction may cut the conversation, and which paths a tool may write.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const event = (sequence: number, kind: string, body: unknown) =>
  ({ attemptId: "attempt", sequence, generation: 1, kind, body }) as any;
const call = (sequence: number, id: string) =>
  event(sequence, "response-settled", {
    requestNumber: sequence,
    error: null,
    finish: "tool-calls",
    output: [{ type: "tool-call", id, name: "read_file", arguments: "{}" }],
  });
const result = (sequence: number, callId: string) =>
  event(sequence, "tool-result", { callId, ok: true, output: `out ${callId}` });

test("a compaction cut never keeps a tool result whose call it replaced", () => {
  const events = [
    event(1, "input-claimed", { inputIds: ["prompt"], texts: ["Do the work"] }),
    call(2, "c1"),
    result(3, "c1"),
    call(4, "c2"),
    result(5, "c2"),
    call(6, "c3"),
    result(7, "c3"),
    call(8, "c4"),
    result(9, "c4"),
  ];
  const cut = compactionCut(buildConversation(events, "responses"));
  expect(cut).not.toBeNull();
  const compacted = buildConversation(
    [
      ...events,
      event(100, "compaction", { summary: "capsule", throughSequence: cut }),
    ],
    "responses",
  );
  const calls = new Set<string>();
  for (const message of compacted.messages)
    for (const part of message.parts) {
      if (part.type === "tool-call") calls.add(part.id);
      // Every result that survives the cut still follows its own call.
      if (part.type === "tool-result") expect(calls.has(part.callId)).toBe(true);
    }
  expect(calls.size).toBeGreaterThan(0);
});

test("writes into Git metadata are refused by any spelling or route, and a path through a file is a rejected path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "topsl-test-paths-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "README.md"), "text");
  await symlink(path.join(root, ".git"), path.join(root, "meta"));
  const write = (relative: string) =>
    resolveInside(root, relative, { write: true });
  await expect(write(".git/config")).rejects.toBeInstanceOf(PathRejected);
  await expect(write(".GIT/config")).rejects.toBeInstanceOf(PathRejected);
  await expect(write("sub/.Git/hooks/pre-commit")).rejects.toBeInstanceOf(
    PathRejected,
  );
  // A linked folder inside the workspace that leads into the metadata.
  await expect(write("meta/config")).rejects.toBeInstanceOf(PathRejected);
  await expect(write("README.md/x")).rejects.toBeInstanceOf(PathRejected);
  await expect(resolveInside(root, "README.md/x")).rejects.toBeInstanceOf(
    PathRejected,
  );
  // Ordinary paths, and names that only resemble the folder, still resolve.
  await expect(write("src/new.ts")).resolves.toContain("new.ts");
  await expect(write(".github/workflows/ci.yml")).resolves.toContain("ci.yml");
});
