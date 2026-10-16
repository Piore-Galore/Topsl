const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { threadResponse } = require("./codex-thread.cjs");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const thread = "fixture-" + process.pid,
  turn = "turn-" + process.pid;
let active = false,
  finished = false;
let schedulingDelay = 0;
const later = (action) =>
  schedulingDelay ? setTimeout(action, schedulingDelay) : setImmediate(action);
const complete = () => {
  if (!active || finished) return;
  finished = true;
  send({
    method: "turn/completed",
    params: { threadId: thread, turn: { id: turn, status: "completed" } },
  });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize")
    reply({ platformFamily: process.platform, platformOs: process.platform });
  else if (request.method === "account/read")
    reply({
      account: { type: "chatgpt", email: "local-fixture@example.test" },
    });
  else if (request.method === "thread/start")
    reply(threadResponse(request.params, thread));
  else if (request.method === "turn/start") {
    const input = JSON.parse(request.params.input[0].text);
    if (process.env.TOPSL_LIFECYCLE_SEED)
      schedulingDelay =
        [...(process.env.TOPSL_LIFECYCLE_SEED + input.file)].reduce(
          (n, c) => ((n * 33) ^ c.charCodeAt(0)) >>> 0,
          5381,
        ) % 41;
    fs.writeFileSync(path.join(process.cwd(), input.file), input.content);
    reply({ turn: { id: turn } });
    send({
      method: "turn/started",
      params: { threadId: thread, turn: { id: turn } },
    });
    active = true;
    if (!input.hold) later(complete);
  } else if (request.method === "fixture/ready") {
    reply({ pid: process.pid, cwd: process.cwd(), active, finished });
  } else if (request.method === "fixture/release-turn") {
    reply({ released: true });
    later(complete);
  } else if (request.method === "turn/interrupt") {
    reply({}); // Fault fixture: a late completion may arrive after cancellation.
    later(complete);
  } else
    send({
      id: request.id,
      error: { code: -32601, message: "Unsupported local fixture method" },
    });
});
