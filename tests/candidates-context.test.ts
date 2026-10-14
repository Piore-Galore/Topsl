import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import {
  captureCandidate,
  assertCandidateCurrent,
  candidateText,
} from "../packages/workflows/candidates";
import {
  createSpecification,
  createTaskContext,
  recordContextDelivery,
} from "../packages/context/packages";
import { fixture } from "./helpers";
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  await writeFile(
    path.join(f.directory, "file.ts"),
    "export const value = 1;\n",
  );
  return f;
}
test("encrypted candidate captures exact bytes and deletion, external edits invalidate evidence", async () => {
  const f = await setup();
  const candidate = await captureCandidate(f.store, {
    root: f.directory,
    projectId: "p",
    workflowId: "w",
    selectedPaths: ["file.ts", "deleted.ts"],
    gitExecutable: "missing-git-fixture",
  });
  expect(
    candidate.files.find((file) => file.path === "deleted.ts")?.hash,
  ).toBeNull();
  expect(candidateText(candidate)).toContain("export const value = 1;");
  await assertCandidateCurrent(candidate, "missing-git-fixture");
  await writeFile(
    path.join(f.directory, "file.ts"),
    "export const value = 2;\n",
  );
  await expect(
    assertCandidateCurrent(candidate, "missing-git-fixture"),
  ).rejects.toThrow("stale");
  expect(candidateText(f.store.get("candidate", candidate.id)!)).toContain(
    "value = 1",
  );
  f.store.db.pragma("wal_checkpoint(TRUNCATE)");
  expect(
    (await readFile(path.join(f.directory, "history.sqlite"))).includes(
      Buffer.from("export const value"),
    ),
  ).toBe(false);
});
test("protected files, symlinks, absent manifests and oversize snapshots cannot become implicit context", async () => {
  const f = await setup(),
    input = {
      root: f.directory,
      projectId: "p",
      workflowId: "w",
      gitExecutable: "missing-git-fixture",
    };
  await expect(captureCandidate(f.store, input)).rejects.toThrow("manifest");
  await expect(
    captureCandidate(f.store, { ...input, selectedPaths: ["../escape"] }),
  ).rejects.toThrow("relative");
  await expect(
    captureCandidate(f.store, { ...input, selectedPaths: [".env"] }),
  ).rejects.toThrow("excluded");
  await symlink(
    path.join(f.directory, "file.ts"),
    path.join(f.directory, "alias.ts"),
  );
  await expect(
    captureCandidate(f.store, { ...input, selectedPaths: ["alias.ts"] }),
  ).rejects.toThrow("symlink");
  await expect(
    captureCandidate(f.store, {
      ...input,
      selectedPaths: ["file.ts"],
      maxBytes: 1,
    }),
  ).rejects.toThrow("limit");
});
test("context has exact revisions, omission/evidence levels and blocks mandatory truncation", async () => {
  const f = await setup();
  const candidate = await captureCandidate(f.store, {
    root: f.directory,
    projectId: "p",
    workflowId: "w",
    selectedPaths: ["file.ts"],
    gitExecutable: "missing-git-fixture",
  });
  const specification = createSpecification(f.store, {
    workflowId: "w",
    projectId: "p",
    objective: "correct value",
    acceptanceCriteria: ["value equals two"],
    interfaces: ["public export stays named value"],
  });
  const context = createTaskContext(f.store, {
    specification,
    candidate,
    taskId: "review",
    role: "reviewer",
  });
  expect(context.content).toContain("value equals two");
  expect(context.candidateRevision).toBe(candidate.revision);
  expect(context.independence).toBe("not-enforced");
  expect(context.omissions).not.toHaveLength(0);
  expect(
    recordContextDelivery(f.store, context, "attempt", "submitted").evidence,
  ).toBe("transport-submission");
  expect(
    recordContextDelivery(f.store, context, "attempt", "acknowledged", "native")
      .detail,
  ).toContain("comprehension");
  expect(() =>
    createTaskContext(f.store, {
      specification,
      candidate,
      taskId: "review",
      role: "reviewer",
      maxBytes: 2,
    }),
  ).toThrow("budget");
  expect(() =>
    f.store.immutable("task-context-package", {
      ...context,
      content: "changed",
    }),
  ).toThrow("Immutable");
});
