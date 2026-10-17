const readline = require("node:readline");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { threadResponse } = require("./codex-thread.cjs");
const session = randomUUID();
// FIXTURE_LOG records every frame in both directions.
const log = (from, frame) =>
  process.env.FIXTURE_LOG &&
  fs.appendFileSync(
    process.env.FIXTURE_LOG,
    JSON.stringify({ from, frame }) + "\n",
  );
const send = (value) => {
  log("fixture", value);
  process.stdout.write(JSON.stringify(value) + "\n");
};
let tools = [];
const waiting = new Map();
// Asks Topsl to run one of the tools it declared, as a model would through
// Codex's dynamic tools, and resolves with Topsl's answer.
const callTool = (turn, callId, tool, args) =>
  new Promise((resolve) => {
    waiting.set(callId, (result) => {
      send({
        method: "item/completed",
        params: {
          threadId: session,
          turnId: turn,
          completedAtMs: Date.now(),
          item: {
            type: "dynamicToolCall",
            id: `item-${callId}`,
            namespace: "topsl_candidate",
            tool,
            arguments: args,
            status: result.success ? "completed" : "failed",
            contentItems: result.contentItems,
            success: result.success,
            durationMs: 1,
          },
        },
      });
      resolve(result);
    });
    send({
      id: callId,
      method: "item/tool/call",
      params: {
        threadId: session,
        turnId: turn,
        callId,
        namespace: "topsl_candidate",
        tool,
        arguments: args,
      },
    });
  });
/** Reads every text file the task input does not show in full, then a path
 * the candidate does not contain, and notes what came back. */
async function readCandidate(turn, prompt) {
  const unseen = [
      ...prompt.matchAll(/^Path ([^;\n]+); hash [^;\n]+; \d+ bytes; text; /gm),
    ]
      .map((match) => match[1])
      .filter((file) => !prompt.includes(`--- ${file} (complete text) ---`)),
    notes = [];
  for (const file of [...unseen, "outside.txt"]) {
    const result = await callTool(turn, `read-${file}`, "read_range", {
        path: file,
        offset: 0,
        length: 256 * 1024,
      }),
      text = result.contentItems[0].text;
    notes.push(
      result.success
        ? `${file} ends ${JSON.parse(text).content.trim().split("\n").pop()}`
        : `${file} refused: ${text}`,
    );
  }
  return notes.join(" | ");
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line),
    reply = (result) => send({ id: request.id, result });
  log("topsl", request);
  if (request.method === undefined && waiting.has(request.id)) {
    const answer = waiting.get(request.id);
    waiting.delete(request.id);
    answer(request.result);
    return;
  }
  if (request.id === undefined) return;
  if (request.method === "initialize")
    reply({ platformFamily: "fixture", platformOs: process.platform });
  else if (request.method === "account/read")
    reply({
      account: {
        type: "chatgpt",
        email: "fixture@example.test",
        planType: "fixture",
      },
    });
  else if (request.method === "model/list")
    reply({
      data: [{ id: "fixture", model: "fixture-requested", isDefault: true }],
    });
  else if (request.method === "thread/start") {
    tools = request.params.dynamicTools ?? [];
    reply(
      threadResponse(request.params, session, { model: "fixture-effective" }),
    );
  } else if (request.method === "turn/start") {
    const turn = randomUUID(),
      prompt = request.params.input[0].text;
    reply({ turn: { id: turn }, model: "fixture-effective" });
    send({
      method: "turn/started",
      params: { threadId: session, turn: { id: turn } },
    });
    setTimeout(async () => {
      const review = /^Role: reviewer$/m.test(prompt);
      const candidate =
        /^Candidate ID: [^;\n]+; revision: ([a-f0-9]{64});/m.exec(prompt)?.[1];
      if (review && !candidate)
        throw new Error(
          "Fixture requires a pinned candidate revision in the current task input contract.",
        );
      // An objective ending "[fixture: the build asks first]" makes the build
      // ask to run a command, as Codex does under the untrusted policy, and
      // wait for Topsl's answer before it edits.
      if (
        !review &&
        /^Objective: .*\[fixture: the build asks first\]$/m.test(prompt)
      )
        await new Promise((resolve) => {
          waiting.set("ask-command", resolve);
          send({
            id: "ask-command",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: session,
              turnId: turn,
              itemId: "ask-command-item",
              command: "npm test",
              cwd: process.cwd(),
              startedAtMs: Date.now(),
            },
          });
        });
      if (!review) fs.writeFileSync("file.ts", "export const value = 2;\n");
      const read =
        review && tools.some((tool) => tool.name === "topsl_candidate")
          ? `; read ${await readCandidate(turn, prompt)}`
          : "";
      const text = review
        ? JSON.stringify({
            candidateRevision: candidate,
            summary: `no substantiated findings${read}`,
            findings: [],
          })
        : "Fixture changed value; no model was contacted.";
      send({
        method: "item/completed",
        params: {
          threadId: session,
          turnId: turn,
          item: { type: "agentMessage", id: "fixture-message", text },
        },
      });
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: session,
          turnId: turn,
          tokenUsage: {
            last: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 3 },
          },
        },
      });
      // An objective ending "[fixture: the review fails]" fails the review
      // turn after its reads, as a provider error would.
      const fails =
        review && /^Objective: .*\[fixture: the review fails\]$/m.test(prompt);
      send({
        method: "turn/completed",
        params: {
          threadId: session,
          turnId: turn,
          turn: fails
            ? {
                id: turn,
                status: "failed",
                error: { message: "Fixture review turn failed." },
              }
            : { id: turn, status: "completed" },
        },
      });
    }, 20);
  } else reply({});
});
