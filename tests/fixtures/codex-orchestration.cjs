// A Codex app-server stand-in for coordinator-feature service tests. It
// answers each execution purpose's contract from the prompt alone: no model
// is contacted, and nothing here is evidence for any live model or route.
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { threadResponse } = require("./codex-thread.cjs");
const session = randomUUID();
let model = "fixture-requested";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const match = (prompt, pattern) => pattern.exec(prompt)?.[1] ?? "";

function answer(prompt) {
  const snapshot = match(prompt, /Snapshot digest \(echo it exactly\): (\S+)/);
  if (snapshot) {
    const roster =
      /- implementer: implementation, (\d+) member\(s\), (\S+)/.exec(prompt);
    const members = roster ? Number(roster[1]) : 1;
    const partitioned = roster?.[2] === "parallel-partitioned" && members > 1;
    return JSON.stringify({
      snapshotDigest: snapshot,
      summary: "Change the value in file.ts.",
      assumptions: [],
      actions: [
        {
          key: "build",
          title: "Change the value",
          kind: "implementation",
          roleId: "implementer",
          dependencies: [],
          permittedOutputs: ["file.ts"],
          acceptanceCriteria: ["The value is two."],
          brief: "Set value to 2 in file.ts.",
          partitions: partitioned
            ? Array.from({ length: members }, (_, i) => ({
                title: `Part ${i + 1}`,
                permittedOutputs: [i === 0 ? "file.ts" : `part-${i + 1}.ts`],
              }))
            : [],
        },
      ],
      concerns: [],
    });
  }
  const candidateDigest = match(
    prompt,
    /Candidate digest \(echo it exactly\): (\S+)/,
  );
  if (candidateDigest)
    return JSON.stringify({
      candidateDigest,
      stance: "endorse",
      rationale: "Fixture agrees.",
    });
  const revision = match(
    prompt,
    /Candidate revision \(echo it exactly\): (\S+)/,
  );
  if (revision)
    return JSON.stringify({
      candidateRevision: revision,
      summary: "Fixture review: no findings.",
      findings: [],
    });
  const inputDigest = match(prompt, /"inputDigest": "([^"]+)"/);
  if (/When done, reply/.test(prompt)) {
    const outputs =
      match(prompt, /Change only: ([^\n]+)\./) ||
      match(prompt, /Permitted outputs: ([^\n]+)\./);
    // A goal marked "[distinct versions]" makes each member write its own
    // version of file.ts, so two members conflict on it.
    const member = /\[distinct versions\]/.test(prompt)
      ? match(prompt, /You are member (\S+)\./)
      : "";
    for (const file of outputs.split(", ").filter(Boolean))
      fs.writeFileSync(
        path.join(process.cwd(), file),
        file === "file.ts"
          ? `export const value = 2;${member ? ` // by ${member}` : ""}\n`
          : `export const ${file.replace(/\W/g, "_")} = true;\n`,
      );
    return JSON.stringify({
      inputDigest,
      summary: `Fixture changed ${outputs}.`,
    });
  }
  return JSON.stringify({
    inputDigest,
    summary: "Fixture report.",
    report: "Fixture findings; no model was contacted.",
    limitations: ["fixture"],
  });
}

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
    setTimeout(() => {
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
    }, 20);
  } else reply({});
});
