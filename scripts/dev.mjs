// npm run dev: rebuilds Topsl as you edit and keeps it running.
//
// esbuild watches the main process, preload, service worker and CLI; Vite
// watches the renderer. A main-side rebuild quits and relaunches Electron. A
// renderer rebuild only reloads the window: the main process watches the file
// named by TOPSL_DEV_RELOAD_FILE, which a packaged app ignores. The app runs
// from dist/ exactly as `npm start` runs it, with the same profile and the
// same renderer security settings. There is no type check here; run
// `npm run typecheck` separately.
import { context } from "esbuild";
import { build as buildVite } from "vite";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import {
  nodeEntries,
  nodeBuildOptions,
  rendererConfig,
  prepareDist,
} from "./build-config.mjs";

const reloadFile = path.join(os.tmpdir(), `topsl-dev-reload-${process.pid}`);
writeFileSync(reloadFile, "0");

let child = null;
let relaunch = false;
let stopping = false;
let restartTimer = null;
let pendingInitial = nodeEntries.length + 1;
const failed = new Set();
const contexts = [];
let rendererWatcher = null;

function log(message) {
  console.log(`[dev ${new Date().toLocaleTimeString()}] ${message}`);
}

function launch() {
  log("Starting Topsl.");
  child = spawn(electron, ["."], {
    stdio: "inherit",
    env: { ...process.env, TOPSL_DEV_RELOAD_FILE: reloadFile },
  });
  child.on("exit", (code) => {
    child = null;
    if (relaunch && !stopping) {
      relaunch = false;
      launch();
    } else if (!stopping) {
      log("Topsl closed. Stopping the watchers.");
      void stop(code ?? 0);
    }
  });
}

/** Relaunches Electron once the current burst of rebuilds settles. */
function scheduleRestart() {
  if (pendingInitial > 0 || stopping) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (failed.size) {
      log(`Waiting for a clean build of ${[...failed].join(", ")}.`);
      return;
    }
    if (!child) return launch();
    log("Main-side code changed. Restarting Topsl.");
    relaunch = true;
    // Electron quits through app.quit() on SIGTERM, so Topsl's before-quit
    // handler still closes the service worker. On Windows this ends the
    // process at once, like a forced quit.
    child.kill("SIGTERM");
  }, 200);
}

function initialDone() {
  pendingInitial -= 1;
  if (pendingInitial === 0) {
    if (failed.size)
      log(
        `Initial build failed for ${[...failed].join(", ")}. Fix it and save.`,
      );
    else launch();
  }
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  await Promise.allSettled(contexts.map((ctx) => ctx.dispose()));
  await rendererWatcher?.close();
  if (child) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  rmSync(reloadFile, { force: true });
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

await prepareDist();

for (const [entry, outfile] of nodeEntries) {
  let first = true;
  const ctx = await context({
    ...nodeBuildOptions(entry, outfile),
    plugins: [
      {
        name: "topsl-dev",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length) failed.add(outfile);
            else failed.delete(outfile);
            if (first) {
              first = false;
              initialDone();
            } else {
              log(
                result.errors.length
                  ? `${outfile} failed to build.`
                  : `Rebuilt ${outfile}.`,
              );
              scheduleRestart();
            }
          });
        },
      },
    ],
  });
  contexts.push(ctx);
  await ctx.watch();
}

let firstRenderer = true;
rendererWatcher = await buildVite({
  ...rendererConfig,
  build: { ...rendererConfig.build, watch: {} },
});
rendererWatcher.on("event", (event) => {
  if (event.code === "ERROR") {
    failed.add("renderer");
    log(`Renderer failed to build: ${event.error?.message ?? event.error}`);
    if (firstRenderer) {
      firstRenderer = false;
      initialDone();
    }
  } else if (event.code === "END") {
    const recovered = failed.delete("renderer");
    if (firstRenderer) {
      firstRenderer = false;
      initialDone();
    } else if (recovered && !child) {
      scheduleRestart();
    } else {
      log("Rebuilt the renderer. Reloading the window.");
      writeFileSync(reloadFile, String(Date.now()));
    }
  }
  event.result?.close?.();
});
