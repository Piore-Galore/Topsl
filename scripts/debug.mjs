// npm run debug: builds Topsl with inline source maps and runs it with every
// debugger attached-ready, from this checkout.
//
//   npm run debug                    your normal Topsl profile, like `npm start`
//   npm run debug -- --temp-profile  a throwaway profile (see below)
//   npm run debug -- --keep-profile  with --temp-profile: keep it afterwards
//   npm run debug -- --no-devtools   do not open the window's DevTools
//
// What it opens, all on 127.0.0.1:
//   main process      Node inspector on 9229 (chrome://inspect, or VS Code "Attach")
//   control service   Node inspector on 9230
//   local proxy       Node inspector on 9231
//   window            Chrome remote debugging on 9222, and DevTools, detached
// The control service's and proxy's output is printed here, labelled
// [service] and [proxy]; a normal run discards it. Ports can be changed with
// TOPSL_DEBUG_MAIN_PORT, TOPSL_DEBUG_SERVICE_PORT, TOPSL_DEBUG_PROXY_PORT and
// TOPSL_DEBUG_RENDERER_PORT.
//
// --temp-profile runs on a new topsl-test-debug-* profile in the OS temporary
// directory, with the isolated-test passphrase, so nothing touches your real
// vault. Like any Topsl test profile, it does not search for runtimes (add one
// with Providers → Locate a runtime), and runtime qualification runs in a
// topsl-qualify-* folder under test-results/.
//
// The normal profile is the one `npm start` and `npm run dev` use. A build
// from this checkout may upgrade that profile's stores past what an older
// installed Topsl can open; use --temp-profile when that matters.
import { build } from "esbuild";
import { build as buildVite } from "vite";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import {
  debugRendererConfig,
  nodeBuildOptions,
  nodeEntries,
  prepareDist,
} from "./build-config.mjs";

const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--temp-profile", "--keep-profile", "--no-devtools"].includes(arg)) {
    console.error(`Unknown option ${arg}. See scripts/debug.mjs.`);
    process.exit(2);
  }
const port = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    console.error(`${name} must be a port number from 1024 to 65535.`);
    process.exit(2);
  }
  return value;
};
const ports = {
  main: port("TOPSL_DEBUG_MAIN_PORT", 9229),
  service: port("TOPSL_DEBUG_SERVICE_PORT", 9230),
  proxy: port("TOPSL_DEBUG_PROXY_PORT", 9231),
  renderer: port("TOPSL_DEBUG_RENDERER_PORT", 9222),
};
const log = (message) => console.log(`[debug] ${message}`);

log("Building with inline source maps.");
await prepareDist();
for (const [entry, outfile] of nodeEntries)
  await build(nodeBuildOptions(entry, outfile, { debug: true }));
await buildVite(debugRendererConfig);

const env = {
  ...process.env,
  TOPSL_DEBUG_LOGS: "1",
  TOPSL_DEBUG_DEVTOOLS: args.has("--no-devtools") ? "0" : "1",
  TOPSL_DEBUG_SERVICE_INSPECT: String(ports.service),
  TOPSL_DEBUG_PROXY_INSPECT: String(ports.proxy),
  // Electron's own logging, to this terminal.
  ELECTRON_ENABLE_LOGGING: "1",
};
let temporary = [];
if (args.has("--temp-profile")) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-debug-"));
  await mkdir("test-results", { recursive: true });
  const qualification = await mkdtemp(
    path.resolve("test-results", "topsl-qualify-debug-"),
  );
  env.TOPSL_TEST_PROFILE = profile;
  env.TOPSL_TEST_QUALIFICATION_DIR = qualification;
  temporary = [profile, qualification];
  log(`Throwaway profile: ${profile}`);
  log(`Qualification folder: ${qualification}`);
} else {
  delete env.TOPSL_TEST_PROFILE;
  delete env.TOPSL_TEST_QUALIFICATION_DIR;
  log("Using your normal Topsl profile.");
}

log(
  `Inspectors on 127.0.0.1: main ${ports.main}, control service ${ports.service}, proxy ${ports.proxy}; window remote debugging ${ports.renderer}.`,
);
log("Attach from chrome://inspect or your editor. Close Topsl or press Ctrl+C to stop.");
const child = spawn(
  electron,
  [
    `--inspect=127.0.0.1:${ports.main}`,
    `--remote-debugging-port=${ports.renderer}`,
    "--remote-debugging-address=127.0.0.1",
    ".",
  ],
  { stdio: "inherit", env },
);
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", async (code) => {
  if (temporary.length && !args.has("--keep-profile")) {
    await Promise.all(
      temporary.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    log("Removed the throwaway profile.");
  } else if (temporary.length) log(`Kept ${temporary.join(" and ")}.`);
  process.exit(code ?? 0);
});
