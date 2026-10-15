#!/usr/bin/env node
// Stand-in for the Codex app-server methods that scripts/live-session.mjs
// uses, so the procedure can be checked without a model or an account. It
// answers the sum in a prompt.
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.0.1 (stand-in)");
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
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
    reply({ thread: { id: thread.threadId } });
  else if (request.method === "turn/start") {
    const text = request.params.input[0].text;
    const sum = String(
      (text.match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0),
    );
    reply({ turn: { id: thread.turnId, status: "inProgress" } });
    send({
      method: "turn/started",
      params: { threadId: thread.threadId, turn: { id: thread.turnId } },
    });
    send({
      method: "item/agentMessage/delta",
      params: { ...thread, itemId: "item-stand-in", delta: sum },
    });
    send({
      method: "item/completed",
      params: {
        ...thread,
        item: { id: "item-stand-in", type: "agentMessage", text: sum },
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
