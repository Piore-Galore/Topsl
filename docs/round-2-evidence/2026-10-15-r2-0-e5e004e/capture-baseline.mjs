import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, readFile, writeFile, mkdir, readdir, stat, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const destination = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(destination, "../../..");
if (await access(path.join(destination, "initial-state.json")).then(() => true, () => false))
  throw new Error("This baseline is already archived. Copy this script into a fresh sibling evidence directory before repeating it.");
const git = "/opt/homebrew/bin/git";
const command = (binary, args) => execFileSync(binary, args, { cwd: repository, encoding: "utf8" });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = async (file) => sha256(await readFile(file));
const tracked = command(git, ["ls-files", "-z"]).split("\0").filter(Boolean);
const porcelain = command(git, ["status", "--porcelain=v1", "--untracked-files=all"]);
const files = [];
for (const file of tracked) {
  try {
    const info = await stat(path.join(repository, file));
    files.push({ path: file, bytes: info.size, sha256: await hashFile(path.join(repository, file)) });
  } catch (error) { files.push({ path: file, error: error.code ?? error.message }); }
}
const preExistingDirtyPaths = [
  ".github/workflows/build.yml", ".github/workflows/release.yml", "README.md",
  "docs/Implementation_Status.md", "package.json", "scripts/package-summary.mjs",
  "scripts/verify-mac-package.mjs", "tests/mac-package.test.mjs",
];
const initialDirty = [];
for (const file of preExistingDirtyPaths) initialDirty.push({ path: file, sha256: await hashFile(path.join(repository, file)) });
const pkg = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
const electron = JSON.parse(await readFile(path.join(repository, "node_modules/electron/package.json"), "utf8"));
const manifest = {
  schemaVersion: 1, runId: path.basename(destination), capturedAt: new Date().toISOString(),
  repository, commit: command(git, ["rev-parse", "HEAD"]).trim(),
  branch: command(git, ["branch", "--show-current"]).trim(),
  workingTree: { porcelain, trackedFiles: files, preExistingDirty: initialDirty },
  host: { platform: process.platform, architecture: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, osVersion: command("/usr/bin/sw_vers", []).trim() },
  tooling: { node: process.version, nodePath: process.execPath, npm: command("/opt/homebrew/bin/npm", ["--version"]).trim(), npmPath: "/opt/homebrew/bin/npm", electron: electron.version, packageVersion: pkg.version, git: command(git, ["--version"]).trim(), gitPath: git },
  packageScripts: pkg.scripts,
  inputs: {
    reviewedPlan: { path: "/Users/piore/Desktop/Topsl_Round_2_Improvement_Plan_Reviewed.md", sha256: await hashFile("/Users/piore/Desktop/Topsl_Round_2_Improvement_Plan_Reviewed.md") },
    originalPlan: { path: "docs/Topsl_Improvement_Plan.md", sha256: await hashFile(path.join(repository, "docs/Topsl_Improvement_Plan.md")) },
    originalEvidence: { path: "docs/Improvement_Execution.md", sha256: await hashFile(path.join(repository, "docs/Improvement_Execution.md")) },
    packageLock: { path: "package-lock.json", sha256: await hashFile(path.join(repository, "package-lock.json")) },
  },
  safety: { fixtureProfiles: true, nativeProviderOptInRemoved: true, heavyBenchmarkOptInRemoved: true, providerModelTurns: 0, downloadsOrInstalls: false, accountOrAuthenticationChanges: false, nativeDatabaseMutation: false },
  runs: [],
};
await writeFile(path.join(destination, "initial-state.json"), JSON.stringify(manifest, null, 2) + "\n");
await copyFile("/Users/piore/Desktop/Topsl_Round_2_Improvement_Plan_Reviewed.md", path.join(repository, "docs/Topsl_Round_2_Improvement_Plan_Reviewed.md"));

async function run(id, args) {
  const startedAt = new Date().toISOString();
  const output = createWriteStream(path.join(destination, `${id}.txt`));
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.TOPSL_NATIVE_PROJECT_BINARY;
  delete env.TOPSL_BENCHMARK;
  const child = spawn("/opt/homebrew/bin/npm", args, { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(`Starting ${id}: npm ${args.join(" ")}\n`);
  let tail = "";
  const append = (bytes) => { output.write(bytes); tail = (tail + bytes.toString()).slice(-12000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await new Promise((resolve) => output.end(resolve));
  const record = { id, command: ["/opt/homebrew/bin/npm", ...args], cwd: repository, startedAt, endedAt: new Date().toISOString(), ...result, output: `${id}.txt`, outputSha256: await hashFile(path.join(destination, `${id}.txt`)) };
  manifest.runs.push(record);
  await writeFile(path.join(destination, "commands.json"), JSON.stringify(manifest.runs, null, 2) + "\n");
  process.stdout.write(`${id} completed: ${JSON.stringify(result)}\n${tail}\n`);
  return result;
}

const checked = await run("check", ["run", "check"]);
if (checked.exitCode === 0) {
  await run("desktop", ["run", "test:desktop"]);
  try {
    const screenshotRoot = path.join(repository, "test-results");
    const screenshotDestination = path.join(destination, "desktop-artifacts");
    await mkdir(screenshotDestination, { recursive: true });
    for (const file of await readdir(screenshotRoot)) {
      const info = await stat(path.join(screenshotRoot, file));
      const desktopRun = manifest.runs.find((entry) => entry.id === "desktop");
      if (info.isFile() && info.mtimeMs >= Date.parse(desktopRun.startedAt))
        await copyFile(path.join(screenshotRoot, file), path.join(screenshotDestination, file));
    }
  } catch (error) { manifest.artifactCopyError = error.message; }
}
await run("concurrency", ["test", "--", "tests/parallel-workspaces.test.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${path.join(destination, "concurrency-report.json")}`]);
manifest.completedAt = new Date().toISOString();
manifest.finalDirtyPreservation = [];
for (const initial of initialDirty) {
  const current = await hashFile(path.join(repository, initial.path));
  manifest.finalDirtyPreservation.push({ path: initial.path, initialSha256: initial.sha256, finalSha256: current, preserved: current === initial.sha256 });
}
manifest.finalCommit = command(git, ["rev-parse", "HEAD"]).trim();
manifest.initialState = { path: "initial-state.json", sha256: await hashFile(path.join(destination, "initial-state.json")) };
delete manifest.workingTree.trackedFiles;
await writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`Baseline capture complete: ${destination}\n`);
process.exitCode = manifest.runs.some((run) => run.exitCode !== 0) ? 1 : 0;
