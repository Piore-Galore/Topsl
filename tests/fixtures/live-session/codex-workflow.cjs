#!/usr/bin/env node
// Stand-in for `scripts/live-session.mjs --workflow codex-codex`: the runtime
// qualification suite's scripted app-server (codex-qualify.cjs), which here
// also builds and reviews the project the script seeds. No model or account is
// contacted. A build applies the ten percent discount in src/order.mjs. A
// review reads that file in the task input, or through Topsl's candidate reader
// when the input leaves it out, and returns no findings for the pinned
// candidate.
// FIXTURE_BUILD=twenty applies twenty percent instead, so the check fails.
// FIXTURE_BUILD=new-file also adds src/discount.mjs, which nobody approved.
// FIXTURE_REVIEW=finding returns one finding on src/order.mjs.
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("../codex-qualify.cjs");

const order = (rate) =>
  `import { totalCents } from './cart.mjs';\n// The approved order discount.\nexport function orderTotal(items) { return Math.round(totalCents(items) * ${rate}); }\n`;

/** The file's text, when the task input shows it in full. */
function shown(prompt, file) {
  const header = `--- ${file} (complete text) ---\n`,
    start = prompt.indexOf(header);
  if (start < 0) return null;
  const rest = prompt.slice(start + header.length),
    end = rest.search(/\n(Path |--- )/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Reads a candidate file through Topsl's read_range tool, as a reviewer would. */
async function read(threadId, turnId, file) {
  const callId = `${turnId}-read`,
    args = { path: file },
    response = await fixture.call("item/tool/call", {
      threadId,
      turnId,
      callId,
      namespace: "topsl_candidate",
      tool: "read_range",
      arguments: args,
    });
  fixture.send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: {
        id: callId,
        type: "dynamicToolCall",
        namespace: "topsl_candidate",
        tool: "read_range",
        arguments: args,
        status: response.result?.success ? "completed" : "failed",
        contentItems: response.result?.contentItems ?? null,
        success: response.result?.success ?? null,
        durationMs: 1,
      },
    },
  });
  try {
    return JSON.parse(response.result.contentItems[0].text).content;
  } catch {
    return null;
  }
}

fixture.otherTurn = async ({ threadId, turnId, prompt, cwd, tools }) => {
  const role = /^Role: (\w+)$/m.exec(prompt)?.[1];
  if (role === "builder" || role === "repair") {
    fs.writeFileSync(
      path.join(cwd, "src", "order.mjs"),
      order(process.env.FIXTURE_BUILD === "twenty" ? 0.8 : 0.9),
    );
    if (process.env.FIXTURE_BUILD === "new-file")
      fs.writeFileSync(
        path.join(cwd, "src", "discount.mjs"),
        "export const rate = 0.9;\n",
      );
    return fixture.complete(
      threadId,
      turnId,
      "Applied the discount in src/order.mjs. No model was contacted.",
    );
  }
  if (role !== "reviewer") return fixture.complete(threadId, turnId, "Done.");
  const revision = /^Candidate ID: [^;\n]+; revision: ([a-f0-9]{64});/m.exec(
    prompt,
  )?.[1];
  if (!revision)
    return fixture.complete(
      threadId,
      turnId,
      "The task input names no pinned candidate revision.",
    );
  const inInput = shown(prompt, "src/order.mjs"),
    source =
      inInput ?? (tools ? await read(threadId, turnId, "src/order.mjs") : null),
    where =
      inInput === null ? "through the candidate reader" : "in the task input";
  fixture.complete(
    threadId,
    turnId,
    JSON.stringify({
      candidateRevision: revision,
      summary: source
        ? `Read src/order.mjs ${where}: ${source.trim().split("\n").pop()}`
        : "The task input left out src/order.mjs, and no candidate reader was available.",
      findings:
        process.env.FIXTURE_REVIEW === "finding"
          ? [
              {
                title: "Discount rate is not named",
                severity: "low",
                file: "src/order.mjs",
                line: 3,
                behavior: "The rate is a bare number in orderTotal.",
                evidence: "Stand-in finding; no model was contacted.",
              },
            ]
          : [],
    }),
  );
};
