import { build } from "esbuild";
import { build as buildVite } from "vite";
import { mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
for (const [entry, outfile] of [
  ["apps/desktop/main.ts", "main.cjs"],
  ["apps/desktop/preload.ts", "preload.cjs"],
  ["apps/service/worker.ts", "service.cjs"],
  ["apps/cli/main.ts", "cli.cjs"],
]) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${outfile}`,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: false,
    external: ["electron", "better-sqlite3-multiple-ciphers", "node-pty"],
  });
}
await buildVite({
  root: "apps/desktop/renderer",
  base: "./",
  build: { outDir: "../../../dist/renderer", emptyOutDir: true },
  logLevel: "warn",
});
console.log("Built desktop, isolated service, companion CLI, and renderer.");
