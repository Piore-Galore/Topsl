import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function fixtureCommand(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(cwd, ".no-global-git-config"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(
              `${executable} ${args.join(" ")} failed (${code}): ${stderr}`,
            ),
          ),
    );
  });
}

// A deterministic, minimal POSIX archive. No npm invocation, registry access,
// package hooks, host dependency tree or downloaded source enters generation.
function archive(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const bytes = Buffer.from(text),
      header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, 100);
    for (const [offset, width, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, bytes.length],
      [136, 12, 0],
    ])
      header.write(
        value.toString(8).padStart(width - 1, "0") + "\0",
        offset,
        width,
      );
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
      8,
    );
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
}

export const discountSource = (defective = false) =>
  `// New module required by the approved feature.\nexport function applyDiscount(cents) { return Math.round(cents * ${defective ? "0.8" : "0.9"}); }\n`;
export const featureOrderSource = `import { totalCents } from './cart.mjs';\nimport { applyDiscount } from './discount.mjs';\nexport function orderTotal(items) { return applyDiscount(totalCents(items)); }\n`;

// The live workflow run's task changes one tracked file, so its build adds no
// file that needs an exact-hash output review.
const liveTask =
  "Apply a ten percent discount to the order total in src/order.mjs. Change only that file and add no new files. Preserve original cart totals, tracked logo, build script and original checks. Acceptance is a workflow decision, separate from applying or publishing.\n";

/**
 * Creates only a new disposable directory. It never mutates the Topsl index.
 * With `live`, it creates the small project that `scripts/live-session.mjs
 * --workflow` seeds: the same dependency, binary asset and check, a one-line
 * reference source, and a task that changes src/order.mjs instead of adding
 * src/discount.mjs. Its build prints the receipt rather than writing
 * output/receipt.json, because a check set up through Topsl's guided setup has
 * no writable paths, and the check reads that printed receipt.
 */
export async function createDemoFixture(options = {}) {
  const root = options.root
    ? path.resolve(options.root)
    : await mkdtemp(path.join(os.tmpdir(), "topsl-r2-demo-"));
  if (options.root) await mkdir(root); // EEXIST protects existing user work.
  const canonical = await realpath(root),
    seed = options.seed ?? "topsl-round2-v1";
  const files = new Map();
  const add = async (name, bytes) => {
    await mkdir(path.dirname(path.join(canonical, name)), { recursive: true });
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await writeFile(path.join(canonical, name), value);
    files.set(name, { path: name, bytes: value.length, sha256: digest(value) });
  };
  const dependency = archive({
    "package.json":
      JSON.stringify({
        name: "@topsl/demo-money",
        version: "1.0.0",
        type: "module",
        exports: "./index.mjs",
      }) + "\n",
    "index.mjs":
      "export function sumCents(values) { return values.reduce((sum, value) => sum + value, 0); }\n",
  });
  const dependencyPath = "vendor/topsl-demo-money-1.0.0.tgz";
  const manifest = {
    name: "topsl-round2-receipt-demo",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { build: "node build/receipt.mjs", check: "node tests/check.mjs" },
    dependencies: { "@topsl/demo-money": "file:" + dependencyPath },
  };
  await add("package.json", JSON.stringify(manifest, null, 2) + "\n");
  await add(
    "package-lock.json",
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: manifest.name,
            version: manifest.version,
            dependencies: manifest.dependencies,
          },
          "node_modules/@topsl/demo-money": {
            version: "1.0.0",
            resolved: "file:" + dependencyPath,
            integrity:
              "sha512-" +
              createHash("sha512").update(dependency).digest("base64"),
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  await add(dependencyPath, dependency);
  await add(".gitignore", "node_modules/\noutput/\n.cache/\n");
  await add(
    "src/catalog.mjs",
    "export const catalog = [{ sku: 'tea', cents: 250, quantity: 2 }, { sku: 'rice', cents: 500, quantity: 1 }];\n",
  );
  await add(
    "src/cart.mjs",
    "import { sumCents } from '@topsl/demo-money';\nexport function totalCents(items) { return sumCents(items.map(item => item.cents * item.quantity)); }\n",
  );
  await add(
    "src/order.mjs",
    "import { totalCents } from './cart.mjs';\nexport function orderTotal(items) { return totalCents(items); }\n",
  );
  await add(
    "src/contracts.ts",
    "export interface LineItem { sku: string; cents: number; quantity: number }\nexport interface Receipt { totalCents: number; logoBytes: number }\n",
  );
  const referenceLine = `// ${seed}: reference-only source; discounted order total is 900 cents; retrieval-needle\n`;
  await add(
    "src/reference.ts",
    referenceLine.repeat(
      options.live
        ? 1
        : Math.ceil(1_200_000 / Buffer.byteLength(referenceLine)),
    ),
  );
  await add(
    "assets/logo.png",
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7d8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await add(
    "build/receipt.mjs",
    options.live
      ? "import { readFile } from 'node:fs/promises';\nimport { catalog } from '../src/catalog.mjs';\nimport { orderTotal } from '../src/order.mjs';\nconsole.log(JSON.stringify({ totalCents: orderTotal(catalog), logoBytes: (await readFile('assets/logo.png')).length }));\n"
      : "import { mkdir, readFile, writeFile } from 'node:fs/promises';\nimport { catalog } from '../src/catalog.mjs';\nimport { orderTotal } from '../src/order.mjs';\nawait mkdir('output', { recursive: true });\nawait writeFile('output/receipt.json', JSON.stringify({ totalCents: orderTotal(catalog), logoBytes: (await readFile('assets/logo.png')).length }));\nconsole.log('receipt-build-complete');\n",
  );
  await add(
    "tests/check.mjs",
    options.live
      ? "import assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\nimport { catalog } from '../src/catalog.mjs';\nimport { totalCents } from '../src/cart.mjs';\nimport { orderTotal } from '../src/order.mjs';\nassert.equal(totalCents(catalog), 1000, 'original cart acceptance remains mandatory');\nassert.equal(orderTotal(catalog), 900, 'approved ten percent feature discount');\nassert.equal(orderTotal([]), 0, 'empty order');\nconst build = spawnSync(process.execPath, ['build/receipt.mjs'], { encoding: 'utf8' });\nprocess.stdout.write(build.stdout ?? ''); process.stderr.write(build.stderr ?? '');\nassert.equal(build.status, 0, 'tracked build script must succeed');\nconst receipt = JSON.parse(build.stdout);\nassert.equal(receipt.totalCents, 900); assert(receipt.logoBytes > 0);\nassert(!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.CODEX_HOME, 'provider credentials are not inherited');\nconsole.log('receipt-check-passed');\n"
      : "import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { spawnSync } from 'node:child_process';\nimport { catalog } from '../src/catalog.mjs';\nimport { totalCents } from '../src/cart.mjs';\nimport { orderTotal } from '../src/order.mjs';\nassert.equal(totalCents(catalog), 1000, 'original cart acceptance remains mandatory');\nassert.equal(orderTotal(catalog), 900, 'approved ten percent feature discount');\nassert.equal(orderTotal([]), 0, 'empty order');\nconst build = spawnSync(process.execPath, ['build/receipt.mjs'], { encoding: 'utf8' });\nprocess.stdout.write(build.stdout ?? ''); process.stderr.write(build.stderr ?? '');\nassert.equal(build.status, 0, 'tracked build script must succeed');\nconst receipt = JSON.parse(await readFile('output/receipt.json', 'utf8'));\nassert.equal(receipt.totalCents, 900); assert(receipt.logoBytes > 0);\nassert(!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.CODEX_HOME, 'provider credentials are not inherited');\nconsole.log('receipt-check-passed');\n",
  );
  await add(
    "TASK.md",
    options.live
      ? liveTask
      : "Implement a ten percent order discount in a new src/discount.mjs module and call it from src/order.mjs. Preserve original cart totals, tracked logo, build script and original checks. Approve the exact new-file hash before review/checks. Acceptance is a workflow decision, separate from applying or publishing.\n",
  );
  if (options.stress) {
    // 10,000 source files at 10 KiB plus four 1 MiB binary inputs exceeds
    // 100,000,000 logical bytes without requiring model inference.
    for (let index = 0; index < 10_000; index++) {
      const group = index % 100,
        line = `// ${seed}: synthetic group ${group}; bounded retrieval stress\n`;
      await add(
        `synthetic/source-${String(index).padStart(5, "0")}.ts`,
        line
          .repeat(Math.ceil(10_240 / Buffer.byteLength(line)))
          .slice(0, 10_240),
      );
    }
    for (let index = 0; index < 4; index++) {
      const bytes = Buffer.alloc(1024 * 1024),
        token = Buffer.from(digest(`${seed}:${index}`), "hex");
      for (let offset = 0; offset < bytes.length; offset += token.length)
        token.copy(bytes, offset);
      await add(`assets/synthetic-${index}.bin`, bytes);
    }
  }
  const sourceFiles = [...files.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const fixtureManifest = {
    version: 1,
    evidenceClass: "deterministic-generated-fixture",
    seed,
    stress: !!options.stress,
    ...(options.live ? { live: true } : {}),
    sourceFiles,
    logicalBytes: sourceFiles.reduce((sum, file) => sum + file.bytes, 0),
    dependency: {
      path: dependencyPath,
      sha256: digest(dependency),
      origin: "generated local archive; no registry fetch; no install hooks",
    },
    feature: options.live
      ? { path: "src/order.mjs", expectedTotalCents: 900 }
      : { newPath: "src/discount.mjs", expectedTotalCents: 900 },
    sourceIdentity: digest(JSON.stringify(sourceFiles)),
  };
  await add(
    "fixture-manifest.json",
    JSON.stringify(fixtureManifest, null, 2) + "\n",
  );
  const git =
    options.gitExecutable ??
    (process.platform === "darwin" && existsSync("/opt/homebrew/bin/git")
      ? "/opt/homebrew/bin/git"
      : "git");
  await fixtureCommand(git, ["init", "--quiet"], canonical);
  await fixtureCommand(git, ["add", "--", ...files.keys()], canonical);
  await fixtureCommand(
    git,
    [
      "-c",
      "user.name=Topsl Fixture",
      "-c",
      "user.email=fixture@invalid.example",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Deterministic Round 2 disposable acceptance input",
    ],
    canonical,
  );
  return {
    root: canonical,
    gitExecutable: git,
    baseCommit: await fixtureCommand(git, ["rev-parse", "HEAD"], canonical),
    manifest: fixtureManifest,
    paths: [...files.keys()].sort(),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) =>
        !["--stress", "--root", "--seed"].includes(arg) &&
        !["--root", "--seed"].includes(args[args.indexOf(arg) - 1]),
    )
  )
    throw new Error(
      "Usage: node scripts/round2-demo-fixture.mjs [--stress] [--root NEW_DIRECTORY] [--seed VALUE]",
    );
  const value = (key) =>
    args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  const result = await createDemoFixture({
    root: value("--root"),
    seed: value("--seed"),
    stress: args.includes("--stress"),
  });
  console.log(
    JSON.stringify(
      {
        root: result.root,
        baseCommit: result.baseCommit,
        sourceIdentity: result.manifest.sourceIdentity,
        logicalBytes: result.manifest.logicalBytes,
        files: result.paths.length,
        providerRequests: 0,
      },
      null,
      2,
    ),
  );
}
