// Scripted app-server for the runtime qualification suite. No model is contacted.
// FIXTURE_SANDBOX=broken lets every approved or unapproved write land.
// FIXTURE_REFUSE=1 answers the write probes without running anything.
// FIXTURE_ALTERED=1 proposes a compound command instead of the requested one.
// FIXTURE_NO_APPROVAL=1 runs commands without asking (sandbox still applies).
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const threads = new Map();
const pending = new Map();
let threadCount = 0,
  turnCount = 0,
  requestCount = 0,
  streaming = null;
function inside(file, root) {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function execute(line, policy) {
  const match = /^printf (\w+) > '([^']+)'$/.exec(line);
  if (!match) return 1;
  const allowed =
    process.env.FIXTURE_SANDBOX === "broken" ||
    (policy?.type === "workspaceWrite" &&
      policy.writableRoots.some((root) => inside(match[2], root)));
  if (!allowed) return 1;
  fs.writeFileSync(match[2], match[1]);
  return 0;
}
function ask(params) {
  if (process.env.FIXTURE_NO_APPROVAL) return Promise.resolve("accept");
  const id = `approval-${++requestCount}`;
  send({ id, method: "item/commandExecution/requestApproval", params });
  return new Promise((resolve) => pending.set(id, resolve));
}
async function runCommands(threadId, turnId, lines, policy) {
  for (const [index, requested] of lines.entries()) {
    const line = process.env.FIXTURE_ALTERED
        ? `${requested}; touch '${path.join(path.dirname(requested.split("'")[1]), "extra")}'`
        : requested,
      itemId = `${turnId}-cmd-${index}`,
      command = ["bash", "-lc", line];
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { id: itemId, type: "commandExecution", command },
      },
    });
    const decision = await ask({ threadId, turnId, itemId, reason: "write" });
    const exitCode = decision === "accept" ? execute(line, policy) : null;
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: "commandExecution",
          command,
          status: decision === "accept" ? "completed" : "declined",
          exitCode,
        },
      },
    });
  }
}
function complete(threadId, turnId, text, status = "completed") {
  if (text)
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: `${turnId}-msg`, type: "agentMessage", text },
      },
    });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status } },
  });
}
readline.createInterface({ input: process.stdin }).on("line", async (raw) => {
  const request = JSON.parse(raw);
  if (request.id !== undefined && !request.method) {
    pending.get(request.id)?.(request.result?.decision ?? "decline");
    pending.delete(request.id);
    return;
  }
  if (request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize")
    reply({ platformFamily: "unix", platformOs: process.platform });
  else if (request.method === "account/read")
    reply({
      account: {
        type: "chatgpt",
        email: "fixture@example.test",
        planType: "fixture",
        chatgptAccountId: "fixture-account",
      },
    });
  else if (request.method === "thread/start") {
    const id = `thread-${++threadCount}`;
    threads.set(id, request.params);
    reply({ thread: { id }, model: request.params.model });
  } else if (request.method === "turn/start") {
    const { threadId, sandboxPolicy } = request.params,
      prompt = request.params.input[0].text,
      turnId = `turn-${++turnCount}`;
    reply({ turn: { id: turnId }, model: request.params.model });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId } },
    });
    const marker = /nothing else: (\S+)/.exec(prompt);
    if (marker) return complete(threadId, turnId, marker[1]);
    if (prompt.includes("Write the numbers")) {
      let n = 0;
      streaming = {
        threadId,
        turnId,
        timer: setInterval(
          () =>
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId,
                itemId: `${turnId}-msg`,
                delta: `${++n}\n`,
              },
            }),
          10,
        ),
      };
      return;
    }
    const lines = prompt
      .split("\n")
      .filter((line) => line.startsWith("printf "));
    if (process.env.FIXTURE_REFUSE || !lines.length)
      return complete(threadId, turnId, "I will not run commands here.");
    await runCommands(threadId, turnId, lines, sandboxPolicy);
    complete(threadId, turnId, "Done.");
  } else if (request.method === "turn/interrupt") {
    reply({});
    if (streaming?.turnId === request.params.turnId) {
      clearInterval(streaming.timer);
      complete(streaming.threadId, streaming.turnId, null, "interrupted");
      streaming = null;
    }
  } else
    send({
      id: request.id,
      error: { code: -32601, message: "Unsupported fixture method." },
    });
});
