import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const iterations = Number(option("--iterations", "20"));
const seed = option("--seed", randomBytes(8).toString("hex"));
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  iterations > 100 ||
  !/^[a-zA-Z0-9_-]{1,64}$/.test(seed)
)
  throw new Error(
    "Use --iterations 1..100 and --seed with 1..64 letters, digits, _ or -.",
  );
const output = path.resolve(
  option(
    "--output",
    path.join(os.tmpdir(), `topsl-lifecycle-stress-${Date.now()}`),
  ),
);
await mkdir(output, { recursive: true });
const results = [];
for (let index = 0; index < iterations; index++) {
  const iterationSeed = createHash("sha256")
    .update(`${seed}:${index}`)
    .digest("hex")
    .slice(0, 16);
  const report = path.join(output, `iteration-${index + 1}.json`),
    logPath = path.join(output, `iteration-${index + 1}.txt`);
  process.stdout.write(
    `Lifecycle iteration ${index + 1}/${iterations}; seed ${iterationSeed}\n`,
  );
  const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  const startedAt = new Date().toISOString();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/test.mjs",
        "tests/parallel-workspaces.test.ts",
        "tests/runtime.test.ts",
        "tests/durable-executions.test.ts",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      {
        env: { ...process.env, TOPSL_LIFECYCLE_SEED: iterationSeed },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    child.stdout.on("data", (bytes) => {
      process.stdout.write(bytes);
      log.write(bytes);
    });
    child.stderr.on("data", (bytes) => {
      process.stderr.write(bytes);
      log.write(bytes);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      log.end();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
  results.push({
    iteration: index + 1,
    seed: iterationSeed,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: code,
    report,
    log: logPath,
  });
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        seed,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        requestedIterations: iterations,
        results,
        passed:
          results.length === iterations &&
          results.every((r) => r.exitCode === 0),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
process.stdout.write(`Lifecycle evidence: ${output}\n`);
