import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function verifyMacApp(appPath) {
  if (process.platform !== "darwin")
    throw new Error("Mac package verification requires macOS.");
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "pipe", timeout: 120_000 },
  );
}

// Run before electron-builder archives the app, including for local packages.
export default function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  verifyMacApp(appPath);
  console.log(`Verified Mac bundle signature: ${appPath}`);
}

export async function verifyMacArchive(archivePath) {
  if (process.platform !== "darwin")
    throw new Error("Mac package verification requires macOS.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-mac-package-"));
  try {
    execFileSync("/usr/bin/ditto", ["-x", "-k", archivePath, directory], {
      stdio: "pipe",
      timeout: 120_000,
    });
    verifyMacApp(path.join(directory, "Topsl.app"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const { version } = JSON.parse(await readFile("package.json", "utf8"));
    const archivePath = path.resolve(
      process.argv[2] ?? `release/Topsl-${version}-mac-${process.arch}.zip`,
    );
    await verifyMacArchive(archivePath);
    console.log(`Verified extracted Mac package signature: ${archivePath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
