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

test("every release target has a topsail icon in its native format", () => {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url));
  assert.equal(read(metadata.build.mac.icon).toString("ascii", 0, 4), "icns");
  const ico = read(metadata.build.win.icon);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(
    ico.readUInt16LE(4) >= 5,
    "Windows icon includes small and large sizes",
  );
  for (const size of [16, 32, 64, 256, 1024]) {
    const png = read(`${metadata.build.linux.icon}/${size}x${size}.png`);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});
