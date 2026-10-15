import { readFile, appendFile } from "node:fs/promises";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Pass the lifecycle manifest path.");
try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  process.stdout.write(JSON.stringify({ lifecycleStress: manifest }) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `Lifecycle stress: ${manifest.passed ? "passed" : "incomplete or failed"}`,
      "",
      `Platform: ${manifest.platform}/${manifest.arch}; seed: ${manifest.seed}; completed: ${manifest.results.length}/${manifest.requestedIterations}.`,
      "",
      "| Iteration | Scheduling seed | Exit |",
      "|---|---|---|",
      ...manifest.results.map(
        (result) =>
          `| ${result.iteration} | ${result.seed} | ${result.exitCode} |`,
      ),
      "",
      "This is deterministic fixture/process evidence. Live provider and packaged-platform qualification are separate gates.",
      "",
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }
} catch (error) {
  process.stderr.write(`Lifecycle manifest unavailable: ${error.message}\n`);
  process.exitCode = 1;
}
