// Shared by scripts/build.mjs (one build) and scripts/dev.mjs (watch mode),
// so both produce the same dist/ layout.
import { mkdir, copyFile } from "node:fs/promises";

/** The Node-side bundles: entry point and the dist/ file it becomes. */
export const nodeEntries = [
  ["apps/desktop/main.ts", "main.cjs"],
  ["apps/desktop/preload.ts", "preload.cjs"],
  ["apps/service/worker.ts", "service.cjs"],
  ["apps/cli/main.ts", "cli.cjs"],
];

/** esbuild options for one Node-side bundle. */
export function nodeBuildOptions(entry, outfile) {
  return {
    entryPoints: [entry],
    outfile: `dist/${outfile}`,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    external: ["electron", "better-sqlite3-multiple-ciphers", "node-pty"],
  };
}

/** Vite options for the renderer. */
export const rendererConfig = {
  root: "apps/desktop/renderer",
  base: "./",
  build: { outDir: "../../../dist/renderer", emptyOutDir: true },
  logLevel: "warn",
};

/** Creates dist/ and copies the window icon into it. */
export async function prepareDist() {
  await mkdir("dist", { recursive: true });
  await copyFile("assets/brand/icons/png/512x512.png", "dist/icon.png");
}
