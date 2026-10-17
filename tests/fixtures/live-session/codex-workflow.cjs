#!/usr/bin/env node
// Stand-in for `scripts/live-session.mjs --workflow codex-codex`: the runtime
// qualification suite's scripted app-server (codex-qualify.cjs), which here
// also builds and reviews the project the script seeds. No model or account is
// contacted. A build applies the ten percent discount in src/order.mjs. A
// review sends a progress note first, as Codex does, then reads that file in
// the task input, or through Topsl's candidate reader when the input leaves it
// out, and returns no findings for the pinned candidate.
// FIXTURE_BUILD=twenty applies twenty percent instead, so the check fails.
// FIXTURE_BUILD=new-file also adds src/discount.mjs, which nobody approved.
// FIXTURE_REVIEW=finding returns one finding on src/order.mjs.
// FIXTURE_BUILD_ASK=1 makes the build ask, as Codex does under the untrusted
// policy, to run the project's check and then to change src/order.mjs, which
// it writes only if Topsl allows the change.
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

/** Asks Topsl to allow one item, announced and completed as Codex does, and
 * returns whether it was allowed. */
async function ask(threadId, turnId, method, item, params) {
  fixture.send({
    method: "item/started",
    params: { threadId, turnId, startedAtMs: Date.now(), item },
  });
  const response = await fixture.call(method, {
      threadId,
      turnId,
      itemId: item.id,
      startedAtMs: Date.now(),
      ...params,
    }),
    allowed = ["accept", "acceptForSession"].includes(
      response.result?.decision,
    );
  fixture.send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: { ...item, status: allowed ? "completed" : "declined" },
    },
  });
  return allowed;
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
    const file = path.join(cwd, "src", "order.mjs"),
      text = order(process.env.FIXTURE_BUILD === "twenty" ? 0.8 : 0.9);
    if (process.env.FIXTURE_BUILD_ASK === "1") {
      await ask(
        threadId,
        turnId,
        "item/commandExecution/requestApproval",
        {
          type: "commandExecution",
          id: `${turnId}-check`,
          command: "npm run check",
          cwd,
          status: "inProgress",
        },
        { command: "npm run check", cwd },
      );
      const change = {
        type: "fileChange",
        id: `${turnId}-change`,
        status: "inProgress",
        changes: [
          {
            path: file,
            kind: { type: "update", move_path: null },
            diff: `@@ -1 +1 @@\n+${text}`,
          },
        ],
      };
      if (
        !(await ask(
          threadId,
          turnId,
          "item/fileChange/requestApproval",
          change,
          {},
        ))
      )
        return fixture.complete(
          threadId,
          turnId,
          "The change to src/order.mjs was declined, so nothing changed. No model was contacted.",
        );
    }
    fs.writeFileSync(file, text);
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
  // Codex sends a progress note before it reads and answers, which its
  // protocol marks as commentary. Topsl reads only the answer.
  fixture.send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        id: `${turnId}-note`,
        type: "agentMessage",
        text: "Reading src/order.mjs before I review it.",
        phase: "commentary",
      },
    },
  });
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
