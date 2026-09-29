import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Arch } from "builder-util";
import { PlatformPackager } from "app-builder-lib";
import { packageNames } from "../scripts/release.mjs";

test("release filenames match the installed electron-builder for every target", () => {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const packager = PlatformPackager.prototype;
  const builtNames = [
    ["mac", Arch.arm64, "zip"],
    ["mac", Arch.x64, "zip"],
    ["win", Arch.x64, "exe"],
    ["linux", Arch.x64, "AppImage"],
  ].map(([os, arch, ext]) =>
    packager.computeArtifactName.call(
      {
        appInfo: { version: metadata.version },
        platform: { buildConfigurationKey: os },
        expandMacro: packager.expandMacro,
      },
      metadata.build.artifactName,
      ext,
      arch,
    ),
  );
  assert.deepEqual(packageNames(metadata.version), builtNames);
});
