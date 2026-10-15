const readline = require("node:readline");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const session = randomUUID();
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line),
    reply = (result) => send({ id: request.id, result });
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
  else if (request.method === "thread/start")
    reply({ thread: { id: session }, model: "fixture-effective" });
  else if (request.method === "turn/start") {
    const turn = randomUUID(),
      prompt = request.params.input[0].text;
    reply({ turn: { id: turn }, model: "fixture-effective" });
    send({
      method: "turn/started",
      params: { threadId: session, turn: { id: turn } },
    });
    setTimeout(() => {
      const review = /^Role: reviewer$/m.test(prompt);
      const candidate =
        /^Candidate ID: [^;\n]+; revision: ([a-f0-9]{64});/m.exec(prompt)?.[1];
      if (review && !candidate)
        throw new Error(
          "Fixture requires a pinned candidate revision in the current task input contract.",
        );
      if (!review) fs.writeFileSync("file.ts", "export const value = 2;\n");
      const text = review
        ? JSON.stringify({
            candidateRevision: candidate,
            summary: "no substantiated findings",
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
      send({
        method: "turn/completed",
        params: {
          threadId: session,
          turnId: turn,
          turn: { id: turn, status: "completed" },
        },
      });
    }, 20);
  } else reply({});
});
