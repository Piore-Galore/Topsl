// Stand-in for Codex in the desktop test's workflows: the runtime
// qualification suite's scripted app-server (codex-qualify.cjs), which here
// also builds and reviews the fixture project's team files, so the test can
// register, qualify and run it through Topsl's screens. No model or account is
// contacted. A build sets the value to 2 in the module the objective names. A
// review returns no findings for the pinned candidate.
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("./codex-qualify.cjs");

fixture.otherTurn = ({ threadId, turnId, prompt, cwd }) => {
  const role = /^Role: (\w+)$/m.exec(prompt)?.[1];
  if (role === "builder" || role === "repair") {
    const file = /^Objective: .*?([\w-]+\.mjs)\b/m.exec(prompt)?.[1];
    if (!file)
      return fixture.complete(threadId, turnId, "The objective names no file.");
    fs.writeFileSync(path.join(cwd, file), "export const value = 2;\n");
    return fixture.complete(
      threadId,
      turnId,
      `Set the value in ${file} to 2. No model was contacted.`,
    );
  }
  if (role !== "reviewer") return fixture.complete(threadId, turnId, "Done.");
  const revision = /^Candidate ID: [^;\n]+; revision: ([a-f0-9]{64});/m.exec(
    prompt,
  )?.[1];
  fixture.complete(
    threadId,
    turnId,
    revision
      ? JSON.stringify({
          candidateRevision: revision,
          summary: "Stand-in review; no model was contacted.",
          findings: [],
        })
      : "The task input names no pinned candidate revision.",
  );
};
