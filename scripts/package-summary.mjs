import { createHash } from "node:crypto";
import { readdir, stat, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
const files = (await readdir("release")).filter((name) =>
  /\.(zip|exe|AppImage)$/.test(name),
);
if (!files.length)
  throw new Error("Packaging produced no installable artifact.");
let report = `### Topsl ${process.platform}/${process.arch}\n\nCompiled personal-pilot packages (unsigned; platform/provider acceptance is separate).\n\n`;
for (const name of files) {
  const file = path.join("release", name);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  report += `- ${name}: ${(await stat(file)).size} bytes; SHA-256 \`${digest.digest("hex")}\`\n`;
}
report +=
  "\nArtifacts and caches are not uploaded, to avoid storage billing.\n";
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
