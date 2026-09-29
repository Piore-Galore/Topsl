const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let pendingApproval = false;
let turn = "turn-fixture";
const done = (text) => {
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-fixture",
      turnId: turn,
      itemId: "item-fixture",
      delta: text,
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-fixture",
      turnId: turn,
      item: { id: "item-fixture", type: "agentMessage", text },
    },
  });
  const usage = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-fixture",
      turnId: turn,
      tokenUsage: {
        total: { inputTokens: 1000 },
        last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
      },
    },
  };
  send(usage);
  send(usage);
  send({
    method: "turn/completed",
    params: {
      threadId: "thread-fixture",
      turn: { id: turn, status: "completed" },
    },
  });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === "approval-fixture" && pendingApproval) {
    pendingApproval = false;
    done(request.result?.decision ?? request.error?.message ?? "unknown");
    return;
  }
  if (request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize")
    reply({ platformFamily: process.platform, platformOs: process.platform });
  else if (request.method === "model/list")
    reply({
      data: [
        {
          id: "fixture",
          model: "fixture-model",
          displayName: "Fixture",
          isDefault: true,
        },
      ],
    });
  else if (request.method === "account/read")
    reply({
      account: {
        type: process.env.FIXTURE_ACCOUNT_TYPE || "chatgpt",
        email: "fixture@example.test",
        planType: "fixture",
      },
    });
  else if (["thread/start", "thread/resume"].includes(request.method))
    reply({ thread: { id: "thread-fixture" } });
  else if (request.method === "turn/start") {
    const prompt = request.params.input[0].text;
    if (prompt === "crash") {
      process.exit(2);
      return;
    }
    if (prompt === "malformed") {
      process.stdout.write("bad protocol\n");
      return;
    }
    reply({ turn: { id: turn, status: "inProgress" } });
    send({
      method: "turn/started",
      params: { threadId: "thread-fixture", turn: { id: turn } },
    });
    if (prompt === "hold") return;
    setTimeout(() => {
      if (prompt.includes("approval")) {
        pendingApproval = true;
        send({
          id: "approval-fixture",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId:
              prompt === "wrong-thread-approval"
                ? "another-thread"
                : "thread-fixture",
            turnId: turn,
            itemId: "command-fixture",
            command: "fixture read command",
            cwd: process.cwd(),
          },
        });
      } else done("Fixture response, no model was contacted.");
    }, 20);
  } else if (request.method === "turn/interrupt") {
    reply({});
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-fixture",
        turn: { id: turn, status: "interrupted" },
      },
    });
  } else
    send({
      id: request.id,
      error: { code: -32601, message: "Unsupported fixture method." },
    });
});
