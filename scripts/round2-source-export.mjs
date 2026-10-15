import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const runFile = promisify(execFile);
const root = process.cwd();
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
const git =
  process.platform === "darwin" && (await exists("/opt/homebrew/bin/git"))
    ? "/opt/homebrew/bin/git"
    : "git";
const gitRun = (args, encoding = "utf8") =>
  runFile(git, args, { cwd: root, encoding, maxBuffer: 20_000_000 });
const output = option("--output")
  ? path.resolve(option("--output"))
  : path.join(
      await mkdtemp(path.join(os.tmpdir(), "topsl-round2-export-")),
      "source",
    );
if (
  output === root ||
  output.startsWith(root + path.sep) ||
  (await exists(output))
)
  throw new Error(
    "Choose a new export directory outside the supplied checkout.",
  );
const initial = JSON.parse(
  await readFile(
    path.join(
      root,
      "docs/round-2-evidence/2026-10-15-r2-0-e5e004e/manifest.json",
    ),
    "utf8",
  ),
);
const preserved = new Set(
  initial.finalDirtyPreservation.map((entry) => entry.path),
);
const appendixPath = path.join(
  root,
  "docs/round-2-evidence/canonical-doc-additions.json",
);
const appendices = new Map(
  ((await exists(appendixPath))
    ? JSON.parse(await readFile(appendixPath, "utf8")).records
    : []
  ).map((entry) => [entry.path, entry]),
);
const excludeExisting = process.argv.includes("--exclude-preexisting");
const { stdout: names } = await gitRun([
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
]);
const { stdout: baseCommit } = await gitRun(["rev-parse", "HEAD"]);
const { stdout: status } = await gitRun(["status", "--porcelain=v1"]);
const files = [],
  omissions = [];
await mkdir(output, { recursive: true, mode: 0o700 });
for (const relative of [...new Set(names.split("\0").filter(Boolean))].sort()) {
  if (
    path.isAbsolute(relative) ||
    relative.split("/").some((part) => part === ".." || !part)
  )
    throw new Error("Git returned an unsafe export path.");
  const source = path.join(root, relative),
    destination = path.join(output, relative);
  let bytes,
    mode,
    basis = "working-tree";
  if (excludeExisting && preserved.has(relative)) {
    try {
      ({ stdout: bytes } = await gitRun(
        ["show", `HEAD:${relative}`],
        "buffer",
      ));
      mode = 0o644;
      basis = "baseline-commit (pre-existing edit excluded)";
      const appendix = appendices.get(relative);
      if (appendix) {
        const current = await readFile(source);
        if (
          hash(current) !== appendix.combinedSha256 ||
          hash(current.subarray(0, appendix.priorBytes)) !==
            appendix.priorSha256 ||
          hash(current.subarray(appendix.priorBytes)) !==
            appendix.appendedSha256
        )
          throw new Error(
            `Documentation appendix identity changed: ${relative}`,
          );
        bytes = Buffer.concat([bytes, current.subarray(appendix.priorBytes)]);
        basis =
          "baseline-commit + Round 2 appendix (pre-existing edit excluded)";
      }
    } catch (error) {
      if (appendices.has(relative)) throw error;
      omissions.push({
        path: relative,
        reason:
          "Pre-existing untracked file excluded from the implementation export.",
      });
      continue;
    }
  } else {
    let before;
    try {
      before = await lstat(source);
    } catch (error) {
      if (error.code === "ENOENT") {
        omissions.push({
          path: relative,
          reason: "Deleted in the working tree.",
        });
        continue;
      }
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error(`Unsupported export input: ${relative}`);
    bytes = await readFile(source);
    const after = await lstat(source);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error(`Source changed during export: ${relative}`);
    mode = before.mode & 0o777;
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, bytes, { mode });
  await chmod(destination, mode);
  files.push({
    path: relative,
    sha256: hash(bytes),
    bytes: bytes.length,
    mode,
    basis,
  });
}
const linkDependencies = process.argv.includes("--link-dependencies");
if (linkDependencies)
  await symlink(
    path.join(root, "node_modules"),
    path.join(output, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
const manifest = {
  version: 1,
  sourceRoot: root,
  exportRoot: output,
  generatedAt: new Date().toISOString(),
  baseCommit: baseCommit.trim(),
  sourceState: status.trim() ? "uncommitted-working-tree" : "clean-commit",
  preExistingEdits: excludeExisting
    ? "restored-to-HEAD-or-excluded; verified Round 2 documentation appendices retained"
    : "included-as-captured",
  dependencyMode: linkDependencies
    ? "shared-installed-engineering-toolchain"
    : "not-prepared",
  qualification:
    "source-export-only; no live-provider, delivery-commit or platform qualification inferred",
  contentRevision: hash(
    JSON.stringify(
      files.map(({ path, sha256, mode }) => ({ path, sha256, mode })),
    ),
  ),
  files,
  omissions,
};
const manifestPath = output + ".manifest.json";
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  JSON.stringify({
    exportRoot: output,
    manifest: manifestPath,
    files: files.length,
    contentRevision: manifest.contentRevision,
    dependencyMode: manifest.dependencyMode,
  }) + "\n",
);
