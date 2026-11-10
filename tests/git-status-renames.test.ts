import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  gitHeadRevision,
  gitWorkingTreeChanges,
} from "../packages/workflows/candidates";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "topsl-test-git-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd: root, encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  await writeFile(path.join(root, "oldname.txt"), "one\n");
  await writeFile(path.join(root, "abc"), "two\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  return { root, git };
}

test("a staged rename lists both of its paths, whole", async () => {
  const { root, git } = await repository();
  git("mv", "oldname.txt", "newname.txt");
  git("mv", "abc", "xyz");
  expect((await gitWorkingTreeChanges(root)).sort()).toEqual([
    "abc",
    "newname.txt",
    "oldname.txt",
    "xyz",
  ]);
});

test("the head revision is read through Git, so packed refs and linked work trees answer", async () => {
  const { root, git } = await repository();
  const head = git("rev-parse", "HEAD");
  expect(await gitHeadRevision(root)).toBe(head);
  // After packing there is no loose ref file left to read by hand.
  git("pack-refs", "--all");
  expect(await gitHeadRevision(root)).toBe(head);
  const linked = `${root}-linked`;
  cleanups.push(() => rm(linked, { recursive: true, force: true }));
  git("worktree", "add", "--quiet", "--detach", linked);
  expect(await gitHeadRevision(linked)).toBe(head);
  // A folder that is not the root of a work tree has no revision of its own.
  expect(await gitHeadRevision(os.tmpdir())).toBeNull();
});
