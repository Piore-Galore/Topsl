import { build } from "esbuild";
import { build as buildVite } from "vite";
import {
  nodeEntries,
  nodeBuildOptions,
  rendererConfig,
  prepareDist,
} from "./build-config.mjs";
await prepareDist();
for (const [entry, outfile] of nodeEntries)
  await build(nodeBuildOptions(entry, outfile));
await buildVite(rendererConfig);
console.log("Built desktop, isolated service, companion CLI, and renderer.");
