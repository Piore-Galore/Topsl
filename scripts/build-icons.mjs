import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runIconsTool } from "app-builder-lib/out/toolsets/icons.js";

const root = path.resolve(import.meta.dirname, "..");
for (const format of ["set", "icns", "ico"]) {
  const outDir = path.join(
    root,
    "assets/brand/icons",
    format === "set" ? "png" : "",
  );
  await mkdir(outDir, { recursive: true });
  await runIconsTool({
    inputFile: path.join(root, "assets/brand/topsl.svg"),
    outputFormat: format,
    outDir,
  });
  const files = (await readdir(outDir)).filter((file) =>
    format === "set" ? file.endsWith(".png") : file.endsWith(`.${format}`),
  );
  if (!files.length)
    throw new Error(`The topsail icon did not produce ${format} assets.`);
  console.log(`${format}: ${files.join(", ")}`);
}
// The Linux set stops at 512px. Preserve the converter's 1024px PNG from ICNS
// as a review/export master, rather than enlarging a smaller raster.
const icns = await readFile(path.join(root, "assets/brand/icons/icon.icns"));
let master = null;
for (let offset = 8; offset + 8 <= icns.length;) {
  const type = icns.toString("ascii", offset, offset + 4);
  const length = icns.readUInt32BE(offset + 4);
  if (length < 8 || offset + length > icns.length)
    throw new Error("Invalid generated ICNS chunk.");
  if (type === "ic10") master = icns.subarray(offset + 8, offset + length);
  offset += length;
}
if (!master || master.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
  throw new Error("The ICNS converter did not produce a 1024px PNG master.");
await writeFile(
  path.join(root, "assets/brand/icons/png/1024x1024.png"),
  master,
);
