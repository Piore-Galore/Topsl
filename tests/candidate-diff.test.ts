import { afterEach, expect, test } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers";
import { captureCandidate } from "../packages/workflows/candidates";
import { candidateDiff } from "../packages/workflows/candidate-diff";

const opened: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of opened.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("R2-AT-20/34: diff uses pinned bytes, preserves line identities and labels binary/large omissions", async () => {
  const f = await fixture();
  opened.push(f);
  const source = path.join(f.directory, "module.ts"),
    binary = path.join(f.directory, "image.png");
  const large = path.join(f.directory, "large.ts");
  await writeFile(source, "first\nold value\nlast\n");
  await writeFile(binary, Buffer.from([137, 80, 78, 71, 0, 1]));
  await writeFile(large, "x".repeat(500_001));
  const selection = {
    root: f.directory,
    projectId: "p",
    workflowId: "w",
    selectedPaths: ["module.ts", "image.png", "large.ts"],
  };
  const baseline = await captureCandidate(f.store, selection);
  await writeFile(source, "first\nnew value\nlast\n");
  await writeFile(binary, Buffer.from([137, 80, 78, 71, 0, 2]));
  await writeFile(large, "y".repeat(500_001));
  const candidate = await captureCandidate(f.store, {
    ...selection,
    baseCandidateId: baseline.id,
  });
  await writeFile(source, "unrelated live editor bytes");
  const diff = candidateDiff(f.store, baseline, candidate);
  expect(diff.changedFiles).toBe(3);
  const module = diff.files.find((file) => file.path === "module.ts")!;
  expect(module.before).toContainEqual({ line: 2, text: "old value" });
  expect(module.after).toContainEqual({ line: 2, text: "new value" });
  expect(JSON.stringify(diff)).not.toContain("unrelated live editor");
  expect(diff.files.find((file) => file.path === "image.png")).toMatchObject({
    binary: true,
    before: [],
    after: [],
  });
  expect(diff.files.find((file) => file.path === "large.ts")?.detail).toContain(
    "bounded diff",
  );
  const selected = candidateDiff(f.store, baseline, candidate, {
    path: "module.ts",
    limit: 1,
  });
  expect(selected.files.map((file) => file.path)).toEqual(["module.ts"]);
  expect(() =>
    candidateDiff(f.store, baseline, candidate, { path: "../module.ts" }),
  ).toThrow("relative");
  expect(() =>
    candidateDiff(f.store, { ...baseline, projectId: "other" }, candidate),
  ).toThrow("boundary");
});
