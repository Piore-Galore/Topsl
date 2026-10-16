#!/usr/bin/env node
// Stand-in for the Codex app-server methods that scripts/live-session.mjs
// uses, so the procedure can be checked without a model or an account. It
// answers the sum in a prompt. After a Topsl handoff, it adds the numbers in
// the current request to the last Claude reply in the handed-off context.
const readline = require("node:readline");
const { threadResponse } = require("../codex-thread.cjs");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.0.1 (stand-in)");
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const total = (text) =>
  (text.match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
const currentRequest = "\n\n# Current user request\n";
function answer(text) {
  const at = text.lastIndexOf(currentRequest);
  if (!text.startsWith("# Topsl context handoff") || at < 0)
    return String(total(text));
  const reply = text
    .slice(0, at)
    .split(/^(?=## )/m)
    .filter((section) => section.startsWith("## assistant · claude · "))
    .at(-1);
  const number = /\d+/.exec(reply?.slice(reply.indexOf("\n")) ?? "");
  return number
    ? String(Number(number[0]) + total(text.slice(at + currentRequest.length)))
    : "No Claude reply in the handoff.";
}
const thread = { threadId: "thread-stand-in", turnId: "turn-stand-in" };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize")
    reply({ platformFamily: process.platform, platformOs: process.platform });
  else if (request.method === "model/list")
    reply({
      data: [
        {
          id: "stand-in",
          model: "stand-in-model",
          displayName: "Stand-in",
          isDefault: true,
        },
      ],
    });
  else if (request.method === "account/read")
    reply({
      account: {
        type: "chatgpt",
        email: "stand-in@example.invalid",
        planType: "stand-in",
      },
    });
  else if (["thread/start", "thread/resume"].includes(request.method))
    reply(threadResponse(request.params, thread.threadId));
  else if (request.method === "turn/start") {
    const text = answer(request.params.input[0].text);
    reply({ turn: { id: thread.turnId, status: "inProgress" } });
    send({
      method: "turn/started",
      params: { threadId: thread.threadId, turn: { id: thread.turnId } },
    });
    send({
      method: "item/agentMessage/delta",
      params: { ...thread, itemId: "item-stand-in", delta: text },
    });
    send({
      method: "item/completed",
      params: {
        ...thread,
        item: { id: "item-stand-in", type: "agentMessage", text },
      },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        ...thread,
        tokenUsage: {
          total: { inputTokens: 20, outputTokens: 2 },
          last: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 0 },
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: thread.threadId,
        turn: { id: thread.turnId, status: "completed" },
      },
    });
  } else if (request.method === "turn/interrupt") reply({});
  else
    send({
      id: request.id,
      error: { code: -32601, message: "Unsupported stand-in method." },
    });
});
