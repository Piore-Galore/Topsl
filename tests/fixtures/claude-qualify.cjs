// A Claude Code 2.1.302 print/stream-json stand-in for the Claude runtime
// qualification and the live route's own checks. It answers `auth status
// --json`, reports the tools its arguments grant (and the tools of an MCP
// server named by --mcp-config, which it lists over HTTP), and acts out each
// qualification probe from the prompt. No model is contacted, and nothing
// here is evidence for any live model, route or billing path.
//
// FIXTURE_READONLY=broken   the read-only turn writes its file anyway
// FIXTURE_WRITE=skip-outside the edit turn never tries the outside write
// FIXTURE_WRITE=escape      the outside write lands (as it does whenever
//                           --allowedTools grants a bare Write or Edit)
// FIXTURE_READER=skip       the reader turn never calls the tool
// FIXTURE_API_KEY=1         init reports an API key source
// FIXTURE_EXTRA_TOOL=1      init reports a Bash tool nobody granted
// FIXTURE_MODEL=<id>        the model Claude Code reports instead of --model
// FIXTURE_LOG=<file>        appends each run's arguments as a JSON line
// FIXTURE_STALL=silent      writes nothing after init and never ends
// FIXTURE_STALL=after-message ends the model message, then writes nothing
//                           and never ends (as Claude Code 2.1.302 did live)
// FIXTURE_STALL=retrying    after the message, reports API retries every
//                           FIXTURE_RETRY_MS for FIXTURE_RETRY_FOR_MS, then
//                           finishes normally
// FIXTURE_HOLD=1            streams the start of the model message, then
//                           waits until a signal ends it (SIGINT's default
//                           action ends it on the interrupt)
// FIXTURE_SIGINT=ignore     with FIXTURE_HOLD, ignores SIGINT and exits by
//                           itself 300 ms later (code 0, no result)
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.FIXTURE_LOG)
  fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(argv) + "\n");
if (argv[0] === "auth" && argv[1] === "status") {
  process.stdout.write(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "owner@example.test",
      orgId: "fixture-org",
      subscriptionType: "max",
    }),
  );
  process.exit(0);
}
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const allowedTools = (arg("--allowedTools", "") || "").split(",");
const sessionId = arg("--session-id", "claude-fixture-session"),
  model = process.env.FIXTURE_MODEL || arg("--model", "fixture-requested"),
  builtIn = (arg("--tools", "") || "").split(",").filter(Boolean),
  mcpConfig = arg("--mcp-config", '{"mcpServers":{}}');
const event = (v) => process.stdout.write(JSON.stringify(v) + "\n");

async function rpc(server, method, params, id) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...server.headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (response.status === 202) return null;
  return response.json();
}

async function servers() {
  const config = mcpConfig.trim().startsWith("{")
    ? JSON.parse(mcpConfig)
    : JSON.parse(fs.readFileSync(mcpConfig, "utf8"));
  const found = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    await rpc(server, "initialize", { protocolVersion: "2025-06-18" }, 1);
    await rpc(server, "notifications/initialized", {}, undefined);
    const listed = await rpc(server, "tools/list", {}, 2);
    found.push({
      name,
      server,
      tools: listed.result.tools.map((t) => `mcp__${name}__${t.name}`),
    });
  }
  return found;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  const mcp = await servers();
  const tools = [
    ...builtIn,
    ...mcp.flatMap((s) => s.tools),
    ...(process.env.FIXTURE_EXTRA_TOOL ? ["Bash"] : []),
  ];
  event({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools,
    mcp_servers: mcp.map((s) => ({ name: s.name, status: "connected" })),
    apiKeySource: process.env.FIXTURE_API_KEY ? "ANTHROPIC_API_KEY" : "none",
    uuid: "init-1",
  });
  const hang = () => setInterval(() => {}, 1000);
  const hold = () => {
    if (process.env.FIXTURE_SIGINT === "ignore")
      process.on("SIGINT", () => setTimeout(() => process.exit(0), 300));
    return hang();
  };
  if (process.env.FIXTURE_STALL === "silent") return hang();
  const denials = [];
  let text = "fixture reply";
  const marker = /nothing else: (\S+)$/m.exec(input);
  if (marker) text = marker[1];
  const readonly = /Create a file named (readonly-[a-f0-9]+\.txt)/.exec(input);
  if (readonly) {
    if (process.env.FIXTURE_READONLY === "broken")
      fs.writeFileSync(readonly[1], "readonly");
    text = "NO-WRITE-TOOL";
  }
  const inside = /write a file named (inside-[a-f0-9]+\.txt)/.exec(input),
    outside = /at the absolute path (\S+) whose/.exec(input);
  if (inside && builtIn.includes("Write")) {
    fs.writeFileSync(inside[1], "inside");
    text = "The inside write succeeded.";
    if (outside && process.env.FIXTURE_WRITE !== "skip-outside") {
      // As Claude Code 2.1.302 did live: a bare Write or Edit rule allows a
      // write anywhere; only a path rule confines it to the folder.
      if (
        process.env.FIXTURE_WRITE === "escape" ||
        allowedTools.includes("Write") ||
        allowedTools.includes("Edit")
      )
        fs.writeFileSync(outside[1], "outside");
      else
        denials.push({
          tool_name: "Write",
          tool_use_id: "toolu_outside",
          tool_input: { file_path: outside[1], content: "outside" },
        });
    }
  }
  const reader = /with path "([^"]+)"/.exec(input);
  if (reader && process.env.FIXTURE_READER !== "skip") {
    const server = mcp.find((s) => s.name === "topsl_candidate");
    if (server) {
      const answer = await rpc(
        server.server,
        "tools/call",
        { name: "read_range", arguments: { path: reader[1] } },
        3,
      );
      const body = JSON.parse(answer.result.content[0].text);
      text = String(body.content ?? "").split("\n")[0];
    }
  }
  // The partial-message records Claude Code 2.1.302 streams, including a
  // message_delta whose delta has no type.
  for (const [n, streamed] of [
    { type: "message_start", message: { id: "message-1", model } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ].entries()) {
    event({
      type: "stream_event",
      session_id: sessionId,
      event: streamed,
      uuid: `stream-${n}`,
    });
    if (process.env.FIXTURE_HOLD && streamed.type === "content_block_delta")
      return hold();
  }
  if (process.env.FIXTURE_STALL === "after-message") return hang();
  if (process.env.FIXTURE_STALL === "retrying") {
    const every = Number(process.env.FIXTURE_RETRY_MS ?? 100),
      until = Date.now() + Number(process.env.FIXTURE_RETRY_FOR_MS ?? 1000);
    for (let attempt = 1; Date.now() < until; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, every));
      event({
        type: "system",
        subtype: "api_retry",
        attempt,
        session_id: sessionId,
        uuid: `retry-${attempt}`,
      });
    }
  }
  event({
    type: "assistant",
    session_id: sessionId,
    message: { id: "message-1", model, content: [{ type: "text", text }] },
    uuid: "assistant-1",
  });
  event({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: text,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    permission_denials: denials,
    uuid: "result-1",
  });
});
