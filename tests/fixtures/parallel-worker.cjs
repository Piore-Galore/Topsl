const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const thread = "fixture-" + process.pid, turn = "turn-" + process.pid;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = result => send({ id: request.id, result });
  if (request.method === "initialize") reply({ platformFamily: process.platform, platformOs: process.platform });
  else if (request.method === "account/read") reply({ account: { type: "chatgpt", email: "local-fixture@example.test" } });
  else if (request.method === "thread/start") reply({ thread: { id: thread } });
  else if (request.method === "turn/start") {
    const input = JSON.parse(request.params.input[0].text);
    fs.writeFileSync(path.join(process.cwd(), input.file), input.content);
    reply({ turn: { id: turn } });
    send({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
    setTimeout(() => send({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } }), input.delay ?? 100);
  } else if (request.method === "turn/interrupt") {
    reply({}); // Fault fixture: a late completion may arrive after cancellation.
  } else send({ id: request.id, error: { code: -32601, message: "Unsupported local fixture method" } });
});
