import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2),
  option = (key) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
if (
  args.some(
    (arg, index) =>
      !["--stress", "--only-stress", "--only-crash", "--output"].includes(
        arg,
      ) && args[index - 1] !== "--output",
  )
)
  throw new Error(
    "Usage: node scripts/round2-acceptance.mjs [--stress|--only-stress|--only-crash] [--output NEW_DIRECTORY]. This runner has no live-provider route.",
  );
const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function command(executable, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (stdout.length > 16_000_000) child.kill();
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
      if (stderr.length > 16_000_000) child.kill();
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}
const git =
  process.platform === "darwin" && (await exists("/opt/homebrew/bin/git"))
    ? "/opt/homebrew/bin/git"
    : "git";
const gitResult = await command(git, ["rev-parse", "HEAD"]);
if (gitResult.code !== 0) throw new Error(gitResult.stderr);
const timestamp = new Date().toISOString(),
  evidenceBase = path.join(root, "docs/round-2-evidence");
await mkdir(evidenceBase, { recursive: true });
const output = option("--output")
  ? path.resolve(option("--output"))
  : await mkdtemp(
      path.join(evidenceBase, "r2-6-" + timestamp.replace(/[:.]/g, "-") + "-"),
    );
if (option("--output")) await mkdir(output); // Never overwrite a prior run.
const files = await command(git, [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
]);
const sourceHashes = [],
  omissions = [];
for (const name of [
  ...new Set(files.stdout.split("\0").filter(Boolean)),
].sort()) {
  if (name.startsWith("docs/round-2-evidence/")) {
    omissions.push({
      path: name,
      reason:
        "Retained evidence is linked separately and excluded from source identity",
    });
    continue;
  }
  try {
    const bytes = await readFile(path.join(root, name));
    sourceHashes.push({
      path: name,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  } catch (error) {
    omissions.push({ path: name, reason: String(error) });
  }
}
await writeFile(
  path.join(output, "source-hashes.json"),
  JSON.stringify(
    {
      basis: "Exact uncommitted working-tree bytes; no delivery commit created",
      baseCommit: gitResult.stdout.trim(),
      files: sourceHashes,
      omissions,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
const node = await realpath(process.execPath);
let npm = process.env.npm_execpath;
if (!npm)
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of process.platform === "win32"
      ? ["npm", "npm.cmd"]
      : ["npm"]) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) {
        const resolved = await realpath(candidate);
        if (/\.[cm]?js$/.test(resolved)) {
          npm = resolved;
          break;
        }
      }
    }
    if (npm) break;
  }
if (!npm)
  throw new Error(
    "Select the installed npm CLI through npm_execpath; no toolchain installation is performed.",
  );
npm = await realpath(npm);
const npmVersion = await command(node, [npm, "--version"]);
const electronPackage = JSON.parse(
  await readFile(path.join(root, "node_modules/electron/package.json"), "utf8"),
);
const vitestPackage = JSON.parse(
  await readFile(path.join(root, "node_modules/vitest/package.json"), "utf8"),
);
const testArgs = [
  "scripts/test.mjs",
  "tests/round2-acceptance.test.ts",
  "--reporter=json",
  "--outputFile",
  path.join(output, "vitest.json"),
];
if (args.includes("--only-stress")) testArgs.push("-t", "optional synthetic");
if (args.includes("--only-crash")) testArgs.push("-t", "actual POSIX");
if (args.includes("--only-stress") && args.includes("--only-crash"))
  throw new Error("Choose one focused scenario.");
const invocation = {
  executable: node,
  args: testArgs,
  cwd: root,
  environment: {
    ELECTRON_RUN_AS_NODE: "set by scripts/test.mjs",
    npm_node_execpath: node,
    npm_execpath: npm,
    TOPSL_R2_EVIDENCE: output,
    TOPSL_R2_STRESS:
      args.includes("--stress") || args.includes("--only-stress") ? "1" : null,
  },
};
await writeFile(
  path.join(output, "command.json"),
  JSON.stringify(invocation, null, 2) + "\n",
  { flag: "wx" },
);
console.log(`Running offline acceptance; retained evidence: ${output}`);
const started = Date.now();
const result = await command(node, testArgs, {
  env: {
    ...process.env,
    npm_node_execpath: node,
    npm_execpath: npm,
    TOPSL_R2_EVIDENCE: output,
    ...(args.includes("--stress") || args.includes("--only-stress")
      ? { TOPSL_R2_STRESS: "1" }
      : { TOPSL_R2_STRESS: "" }),
  },
});
await writeFile(path.join(output, "stdout.log"), result.stdout, { flag: "wx" });
await writeFile(path.join(output, "stderr.log"), result.stderr, { flag: "wx" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
let report = null;
try {
  report = JSON.parse(await readFile(path.join(output, "vitest.json"), "utf8"));
} catch {}
const sourceChangesDuringRun = [];
for (const before of sourceHashes) {
  let after = null;
  try {
    after = sha256(await readFile(path.join(root, before.path)));
  } catch {}
  if (after !== before.sha256)
    sourceChangesDuringRun.push({
      path: before.path,
      beforeSha256: before.sha256,
      afterSha256: after,
    });
}
const finalNames = await command(git, [
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
]);
for (const name of new Set(finalNames.stdout.split("\0").filter(Boolean)))
  if (
    !name.startsWith("docs/round-2-evidence/") &&
    !sourceHashes.some((file) => file.path === name)
  )
    sourceChangesDuringRun.push({
      path: name,
      beforeSha256: null,
      afterSha256: sha256(await readFile(path.join(root, name))),
    });
await writeFile(
  path.join(output, "source-consistency.json"),
  JSON.stringify(
    {
      unchangedAtEnd: sourceChangesDuringRun.length === 0,
      changes: sourceChangesDuringRun,
      scope:
        "Before/after comparison of working-tree source. It cannot prove a process never changed and restored a file or establish an immutable delivery export.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
const evidenceFiles = [];
for (const name of (await readdir(output)).sort()) {
  const file = path.join(output, name);
  const bytes = await readFile(file);
  evidenceFiles.push({
    path: name,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}
const local = (name) => evidenceFiles.some((file) => file.path === name);
const traceability = Array.from({ length: 40 }, (_, index) => {
  const id = `R2-AT-${String(index + 1).padStart(2, "0")}`;
  if (index < 36)
    return {
      id,
      status: "not-run-by-this-command",
      scope:
        "Phase-specific deterministic suites; see Round_2_Phase_6.md traceability and final full-suite evidence",
    };
  if (index === 36 || index === 37)
    return {
      id,
      status: "pending-live-provider-authorization-and-supported-route",
      fixtureSupplement: local(
        index === 36
          ? "direction-codex-claude.json"
          : "direction-claude-codex.json",
      )
        ? "passed deterministic driver plus actual local dependency checks"
        : "not-passed-in-this-run",
      automaticLiveAcceptance: false,
    };
  if (index === 38)
    return {
      id,
      status:
        local("durable-faults.json") &&
        local("unknown-dispatch-active-restart.json") &&
        local("abrupt-posix-coordinator-crash.json") &&
        local("direction-codex-claude.json") &&
        local("direction-claude-codex.json")
          ? "partial-local-process-and-injected-fault-evidence"
          : "partial-or-failed-see-results",
      remaining:
        "Live provider workflow/full negative journey remain pending. Actual POSIX coordinator SIGKILL is separately recorded when present; Windows abrupt termination is gated.",
    };
  return {
    id,
    status: "pending-delivery-commit-clean-export-and-four-platform-CI",
    localTreeIsDelivery: false,
  };
});
const manifest = {
  schemaVersion: 1,
  createdAt: timestamp,
  completedAt: new Date().toISOString(),
  baseCommit: gitResult.stdout.trim(),
  sourceIdentity: sha256(JSON.stringify(sourceHashes)),
  sourceHashes: "source-hashes.json",
  sourceConsistency: {
    path: "source-consistency.json",
    unchangedAtEnd: sourceChangesDuringRun.length === 0,
  },
  sourceBasis:
    "uncommitted working tree; includes contemporaneous agent changes; no commit, branch, push, install of Topsl dependencies, live turn or release",
  dirtyStatus: (await command(git, ["status", "--porcelain=v1"])).stdout,
  host: {
    platform: process.platform,
    architecture: process.arch,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    node: process.version,
    nodeExecutable: node,
    electron: electronPackage.version,
    vitest: vitestPackage.version,
    npm: npmVersion.stdout.trim(),
  },
  command: invocation,
  result: {
    exitCode: result.code,
    signal: result.signal,
    elapsedMs: Date.now() - started,
    success: report?.success ?? false,
    tests: report?.numTotalTests ?? null,
    passed: report?.numPassedTests ?? null,
    failed: report?.numFailedTests ?? null,
    pending: report?.numPendingTests ?? null,
  },
  evidenceClass: [
    "deterministic-provider-fixture",
    "actual-local-subprocess-check",
    "optional-synthetic-performance",
  ],
  authenticationRoute: "none; provider dependency injection",
  usage: { providerRequests: 0, billedInference: 0, approvedUsageLimit: 0 },
  artifacts: evidenceFiles,
  traceability,
  supportMatrix: [
    {
      feature: "Codex builder / Claude reviewer",
      implementation: "coordinator and adapters in working tree",
      fixture: local("direction-codex-claude.json")
        ? "local fixture passed"
        : "see test result",
      live: "pending",
      packagedPlatforms: "pending all four",
    },
    {
      feature: "Claude builder / Codex reviewer",
      implementation: "coordinator and adapters in working tree",
      fixture: local("direction-claude-codex.json")
        ? "local fixture passed"
        : "see test result",
      live: "pending",
      packagedPlatforms: "pending all four",
    },
    {
      feature: "Locked local-archive checks and durable faults",
      implementation:
        "prepared verification and execution records in working tree",
      fixture: local("durable-faults.json")
        ? "actual local subprocess plus injected faults passed"
        : "see test result",
      live: "provider-independent",
      packagedPlatforms: "pending all four",
    },
    {
      feature: "100 MB / 10,000 source capture",
      implementation: "manifest capture and bounded reader in working tree",
      fixture: local("synthetic-stress.json")
        ? "measured synthetic workload"
        : "skipped unless --stress",
      live: "no inference; not required",
      packagedPlatforms: "not established by this measurement",
    },
  ],
  limitations: [
    "Fixture responses cannot qualify a provider, authentication route or model",
    "A local source snapshot is review evidence, not a delivered commit",
    "Cross-platform CI and packaged runtime acceptance are not run by this command",
    "Read-only source hashing does not prove independent clean export; use round2-source-export.mjs and retain its own outcome",
  ],
};
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      output,
      result: manifest.result,
      liveAT37: "pending",
      liveAT38: "pending",
      deliveryAT40: "pending",
      providerRequests: 0,
    },
    null,
    2,
  ),
);
process.exitCode = result.code ?? 1;
