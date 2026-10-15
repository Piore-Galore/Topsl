import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createDemoFixture,
  fixtureCommand,
} from "../scripts/round2-demo-fixture.mjs";

test("Round 2 demonstration inputs are reproducible, locally archived and Git tracked", async () => {
  const a = await createDemoFixture(),
    b = await createDemoFixture();
  try {
    assert.equal(a.manifest.sourceIdentity, b.manifest.sourceIdentity);
    assert(a.manifest.logicalBytes > 1_000_000);
    assert.equal(a.manifest.dependency.sha256, b.manifest.dependency.sha256);
    const tracked = (
      await fixtureCommand(a.gitExecutable, ["ls-files", "-z"], a.root)
    ).split("\0");
    for (const name of [
      "assets/logo.png",
      "build/receipt.mjs",
      "package-lock.json",
      "src/reference.ts",
      a.manifest.dependency.path,
    ])
      assert(tracked.includes(name));
    const lock = JSON.parse(
      await readFile(path.join(a.root, "package-lock.json"), "utf8"),
    );
    assert.equal(
      lock.packages["node_modules/@topsl/demo-money"].resolved,
      "file:" + a.manifest.dependency.path,
    );
    await assert.rejects(
      readFile(path.join(a.root, a.manifest.feature.newPath)),
      { code: "ENOENT" },
    );
    await assert.rejects(createDemoFixture({ root: a.root }), {
      code: "EEXIST",
    });
    assert.equal(
      await fixtureCommand(a.gitExecutable, ["status", "--porcelain"], a.root),
      "",
    );
  } finally {
    await rm(a.root, { recursive: true, force: true });
    await rm(b.root, { recursive: true, force: true });
  }
});
