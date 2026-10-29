import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { now } from "../packages/domain/invariants";
import {
  RuntimeLoopDriver,
  filesDigest,
} from "../packages/orchestration/loop-checkpoints";
import {
  captureCandidate,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import { writeManagedSnapshot } from "../packages/workspace/managed";
import type { OrchestrationDriver } from "../packages/orchestration/engine";
import { fixture, gitExecutable } from "./helpers";

/**
 * The runtime checkpoint boundary over real captures, owned copies and a real
 * Git folder. No provider runs here.
 */
const open: Array<Awaited<ReturnType<typeof fixture>>> = [];
afterEach(async () => {
  for (const f of open.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(gitExecutable, args, { cwd }).toString().trim();
const check = {
  id: "unit",
  label: "Unit",
  executable: process.execPath,
  args: ["tests/a.test.js"],
  timeoutMs: 1000,
};

async function setup() {
  const f = await fixture();
  open.push(f);
  const root = path.join(f.directory, "project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  await writeFile(path.join(root, "src", "a.ts"), "export const value = 1;\n");
  await writeFile(
    path.join(root, "tests", "a.test.js"),
    "require('assert')(true);\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  f.store.put("project", {
    id: "p",
    name: "Fixture",
    path: root,
    realPath: root,
    trusted: true,
    createdAt: now(),
  });
  const driver = new RuntimeLoopDriver({
    store: f.store,
    orchestration: {} as OrchestrationDriver,
    loopRoot: path.join(f.directory, "loops"),
    ownedRoots: [path.join(f.directory, "integrations")],
    assertLocalOwner: () => {},
    gitExecutable,
  });
  return { ...f, root, driver };
}

/** A candidate with changed content, as an iteration would produce it. */
async function changed(
  f: Awaited<ReturnType<typeof setup>>,
  from: string,
  goalId: string,
  files: Record<string, string>,
) {
  const base = f.store.get<CandidateSnapshot>("candidate", from)!;
  const dir = path.join(f.directory, "integrations", goalId);
  await mkdir(dir, { recursive: true });
  await writeManagedSnapshot(
    { ...base, files: base.files.filter((x) => x.hash) },
    dir,
    f.store,
  );
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(dir, name), text);
  return captureCandidate(f.store, {
    root: dir,
    projectId: "p",
    workflowId: goalId,
    baseCandidateId: from,
    selectedPaths: [...base.files.map((x) => x.path), ...Object.keys(files)],
    gitExecutable,
  });
}

test("checkpoint 0 is an owned copy of the folder; a child baseline keeps its bytes under the child's identity", async () => {
  const f = await setup();
  const base = await f.driver.captureBase({ projectId: "p", runId: "run" });
  const publication = f.store.get<CandidateSnapshot>(
    "candidate",
    base.publicationBaseCandidateId,
  )!;
  const checkpoint = f.store.get<CandidateSnapshot>(
    "candidate",
    base.checkpointCandidateId,
  )!;
  expect(publication.sourceRoot).toBe(f.root);
  expect(checkpoint.sourceRoot).not.toBe(f.root);
  expect(checkpoint.workflowId).toBe("run");
  expect(filesDigest(checkpoint)).toBe(filesDigest(publication));
  expect(base.setupConditions.join(" ")).toMatch(
    /nothing was committed, stashed or discarded/,
  );
  // CP-02: a supported lineage operation, not a mutated record.
  const child = await f.driver.childBaseline({
    projectId: "p",
    runId: "run",
    goalId: "goal-1",
    candidateId: checkpoint.id,
  });
  const snapshot = f.store.get<CandidateSnapshot>("candidate", child)!;
  expect(snapshot.workflowId).toBe("goal-1");
  expect(snapshot.baseCandidateId).toBe(checkpoint.id);
  expect(f.driver.contentDigest(child)).toBe(base.contentDigest);
  expect(
    await f.driver.childBaseline({
      projectId: "p",
      runId: "run",
      goalId: "goal-1",
      candidateId: checkpoint.id,
    }),
  ).toBe(child);
  expect(
    f.store.get<CandidateSnapshot>("candidate", checkpoint.id)!.workflowId,
  ).toBe("run");
  // The original folder was never written.
  expect(git(f.root, "status", "--porcelain")).toBe("");
});

test("checkpoint 0 can copy an accepted result instead of the folder, which stays the publication base", async () => {
  const f = await setup();
  const folder = await f.driver.captureBase({ projectId: "p", runId: "first" });
  const accepted = await changed(f, folder.checkpointCandidateId, "goal-s", {
    "src/a.ts": "export const a = 5;\n",
  });
  const base = await f.driver.captureBase({
    projectId: "p",
    runId: "run",
    fromCandidateId: accepted.id,
  });
  const checkpoint = f.store.get<CandidateSnapshot>(
    "candidate",
    base.checkpointCandidateId,
  )!;
  expect(checkpoint.workflowId).toBe("run");
  expect(checkpoint.baseCandidateId).toBe(accepted.id);
  expect(filesDigest(checkpoint)).toBe(filesDigest(accepted));
  expect(
    f.store.get<CandidateSnapshot>(
      "candidate",
      base.publicationBaseCandidateId,
    )!.sourceRoot,
  ).toBe(f.root);
  expect(
    f.driver.changedPaths(
      base.publicationBaseCandidateId,
      base.checkpointCandidateId,
    ),
  ).toEqual([{ path: "src/a.ts", change: "modified" }]);
  expect(base.setupConditions.join(" ")).toMatch(
    /Starts from the session's accepted result/,
  );
  expect(git(f.root, "status", "--porcelain")).toBe("");
});

test("VF-04: a child baseline whose protected tests differ from the run's protocol is reported", async () => {
  const f = await setup();
  const base = await f.driver.captureBase({ projectId: "p", runId: "run" });
  f.driver.bindRunProtocol({
    runId: "run",
    checkpointCandidateId: base.checkpointCandidateId,
    checks: [check],
  });
  const same = await f.driver.childBaseline({
    projectId: "p",
    runId: "run",
    goalId: "goal-ok",
    candidateId: base.checkpointCandidateId,
  });
  const { bindCheckInputs } =
    await import("../packages/workflows/check-inputs");
  bindCheckInputs(
    f.store,
    "goal-ok",
    f.store.get<CandidateSnapshot>("candidate", same)!,
    [check],
  );
  expect(
    f.driver.protocolProblems({
      runId: "run",
      goalId: "goal-ok",
      checks: [check],
    }),
  ).toEqual([]);
  const weaker = await changed(f, base.checkpointCandidateId, "goal-weak", {
    "tests/a.test.js": "/* no assertions */\n",
  });
  bindCheckInputs(f.store, "goal-weak", weaker, [check]);
  expect(
    f.driver
      .protocolProblems({ runId: "run", goalId: "goal-weak", checks: [check] })
      .join(" "),
  ).toMatch(/tests\/a.test.js changed/);
});

test("CP-05/CP-09: publication writes the first increment, then only the next one, and refuses intervening edits", async () => {
  const f = await setup();
  const base = await f.driver.captureBase({ projectId: "p", runId: "run" });
  const one = await changed(f, base.checkpointCandidateId, "goal-1", {
    "src/a.ts": "export const value = 2;\n",
  });
  const first = await f.driver.publicationPreview({
    projectId: "p",
    baseCandidateId: base.publicationBaseCandidateId,
    headCandidateId: one.id,
    cursor: null,
  });
  expect(first.problems).toEqual([]);
  expect(first.files).toEqual([{ path: "src/a.ts", change: "modified" }]);
  const applied = await f.driver.publicationApply({
    projectId: "p",
    plan: first,
  });
  if ("refused" in applied) throw new Error(applied.refused);
  expect(await readFile(path.join(f.root, "src", "a.ts"), "utf8")).toBe(
    "export const value = 2;\n",
  );
  const cursor = {
    lastPublishedCandidateId: one.id,
    targetRevision: applied.targetRevision,
    manifest: applied.manifest,
  };
  const two = await changed(f, one.id, "goal-2", {
    "src/b.ts": "export const other = 3;\n",
  });
  const second = await f.driver.publicationPreview({
    projectId: "p",
    baseCandidateId: base.publicationBaseCandidateId,
    headCandidateId: two.id,
    cursor,
  });
  expect(second.problems).toEqual([]);
  expect(second.basis).toBe("incremental");
  expect(second.files).toEqual([{ path: "src/b.ts", change: "added" }]);
  // An intervening edit to a published file needs reconciliation.
  await writeFile(
    path.join(f.root, "src", "a.ts"),
    "export const value = 9;\n",
  );
  const blocked = await f.driver.publicationPreview({
    projectId: "p",
    baseCandidateId: base.publicationBaseCandidateId,
    headCandidateId: two.id,
    cursor,
  });
  expect(blocked.problems.join(" ")).toMatch(
    /src\/a.ts no longer matches what Topsl published/,
  );
  expect(
    await f.driver.publicationApply({ projectId: "p", plan: blocked }),
  ).toHaveProperty("refused");
  expect(
    await stat(path.join(f.root, "src", "b.ts")).catch(() => null),
  ).toBeNull();
  // A first publication to an edited folder is refused too.
  const edited = await f.driver.publicationPreview({
    projectId: "p",
    baseCandidateId: base.publicationBaseCandidateId,
    headCandidateId: one.id,
    cursor: null,
  });
  expect(edited.problems.join(" ")).toMatch(/uncommitted or untracked changes/);
});

test("OP-04: reclaiming releases owned copies only", async () => {
  const f = await setup();
  const base = await f.driver.captureBase({ projectId: "p", runId: "run" });
  const child = await f.driver.childBaseline({
    projectId: "p",
    runId: "run",
    goalId: "goal-1",
    candidateId: base.checkpointCandidateId,
  });
  const root = f.store.get<CandidateSnapshot>("candidate", child)!.sourceRoot;
  expect(await f.driver.reclaim([child, base.publicationBaseCandidateId])).toBe(
    1,
  );
  expect(await stat(root).catch(() => null)).toBeNull();
  // The original folder is never an owned copy.
  expect((await stat(f.root)).isDirectory()).toBe(true);
  // Immutable content remains for rematerialization.
  expect(f.driver.contentDigest(child)).toBe(base.contentDigest);
});
