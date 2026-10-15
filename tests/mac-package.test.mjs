import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  verifyMacApp,
  verifyMacArchive,
} from "../scripts/verify-mac-package.mjs";

// Exercise Apple's verifier with real bundles, rather than mock its exit code.
test(
  "Mac package gate accepts sealed bundles and rejects changed resources",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "topsl-mac-sign-test-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = path.join(directory, "Topsl.app");
    await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
    await mkdir(path.join(app, "Contents", "Resources"));
    await copyFile(
      "/usr/bin/true",
      path.join(app, "Contents", "MacOS", "Topsl"),
    );
    await writeFile(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.piore.topsl.signature-test</string>
<key>CFBundleExecutable</key><string>Topsl</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
    );
    const resource = path.join(app, "Contents", "Resources", "fixture.txt");
    await writeFile(resource, "sealed resource");
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], {
      stdio: "pipe",
      timeout: 30_000,
    });
    assert.doesNotThrow(() => verifyMacApp(app));
    const archive = path.join(directory, "Topsl.zip");
    const archiveApp = () =>
      execFileSync(
        "/usr/bin/ditto",
        ["-c", "-k", "--keepParent", app, archive],
        { stdio: "pipe", timeout: 30_000 },
      );
    archiveApp();
    await verifyMacArchive(archive);
    await writeFile(resource, "modified after signing");
    assert.throws(() => verifyMacApp(app), /codesign/);
    await rm(archive);
    archiveApp();
    await assert.rejects(verifyMacArchive(archive), /codesign/);
  },
);
