// A Codex app-server stand-in for coordinator-feature service tests. It
// answers each execution purpose's contract from the prompt alone: no model
// is contacted, and nothing here is evidence for any live model or route.
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");
const { threadResponse } = require("./codex-thread.cjs");
const { answer } = require("./orchestration-answers.cjs");
const session = randomUUID();
let model = "fixture-requested";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line),
    reply = (result) => send({ id: request.id, result });
  if (request.id === undefined || request.method === undefined) return;
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
    model = request.params.model ?? model;
    reply(threadResponse(request.params, session, { model }));
  } else if (request.method === "turn/start") {
    const turn = randomUUID(),
      prompt = request.params.input[0].text;
    reply({ turn: { id: turn }, model });
    send({
      method: "turn/started",
      params: { threadId: session, turn: { id: turn } },
    });
    setTimeout(
      () => {
        const text = answer(prompt);
        send({
          method: "item/completed",
          params: {
            threadId: session,
            turnId: turn,
            item: { type: "agentMessage", id: "fixture-message", text },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: session,
            turnId: turn,
            turn: { id: turn, status: "completed" },
          },
        });
        // FIXTURE_TURN_DELAY_MS lets a test hold turns open long enough to
        // observe overlapping members on slow hosted runners.
      },
      Number(process.env.FIXTURE_TURN_DELAY_MS ?? 20),
    );
  } else reply({});
});
