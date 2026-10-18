// The coordinator stand-ins' replies: each execution purpose's contract
// answered from the prompt alone. An implementation turn writes its permitted
// outputs into `cwd`. No model is contacted, and nothing here is evidence for
// any live model or route.
const fs = require("node:fs");
const path = require("node:path");
const match = (prompt, pattern) => pattern.exec(prompt)?.[1] ?? "";

function answer(prompt, cwd = process.cwd()) {
  const snapshot = match(prompt, /Snapshot digest \(echo it exactly\): (\S+)/);
  if (snapshot) {
    const roster =
      /- implementer: implementation, (\d+) member\(s\), (\S+)/.exec(prompt);
    const members = roster ? Number(roster[1]) : 1;
    const partitioned = roster?.[2] === "parallel-partitioned" && members > 1;
    return JSON.stringify({
      snapshotDigest: snapshot,
      summary: "Change the value in file.ts.",
      assumptions: [],
      actions: [
        {
          key: "build",
          title: "Change the value",
          kind: "implementation",
          roleId: "implementer",
          dependencies: [],
          permittedOutputs: ["file.ts"],
          acceptanceCriteria: ["The value is two."],
          brief: "Set value to 2 in file.ts.",
          partitions: partitioned
            ? Array.from({ length: members }, (_, i) => ({
                title: `Part ${i + 1}`,
                permittedOutputs: [i === 0 ? "file.ts" : `part-${i + 1}.ts`],
              }))
            : [],
        },
      ],
      concerns: [],
    });
  }
  const candidateDigest = match(
    prompt,
    /Candidate digest \(echo it exactly\): (\S+)/,
  );
  if (candidateDigest)
    return JSON.stringify({
      candidateDigest,
      stance: "endorse",
      rationale: "Fixture agrees.",
    });
  const revision = match(
    prompt,
    /Candidate revision \(echo it exactly\): (\S+)/,
  );
  if (revision)
    return JSON.stringify({
      candidateRevision: revision,
      summary: "Fixture review: no findings.",
      findings: [],
    });
  const inputDigest = match(prompt, /"inputDigest": "([^"]+)"/);
  if (/When done, reply/.test(prompt)) {
    const outputs =
      match(prompt, /Change only: ([^\n]+)\./) ||
      match(prompt, /Permitted outputs: ([^\n]+)\./);
    for (const file of outputs.split(", ").filter(Boolean))
      fs.writeFileSync(
        path.join(cwd, file),
        file === "file.ts"
          ? "export const value = 2;\n"
          : `export const ${file.replace(/\W/g, "_")} = true;\n`,
      );
    return JSON.stringify({
      inputDigest,
      summary: `Fixture changed ${outputs}.`,
    });
  }
  return JSON.stringify({
    inputDigest,
    summary: "Fixture report.",
    report: "Fixture findings; no model was contacted.",
    limitations: ["fixture"],
  });
}

module.exports = { answer };
