// A Claude Code print/stream-json stand-in for coordinator and loop service
// tests. It answers each execution purpose's contract from the prompt alone,
// with the same replies as the Codex stand-in (orchestration-answers.cjs), and
// reports the requested model. A session given Topsl's MCP server (a review
// that declares the candidate reader) lists the candidate through it first,
// as a reviewer would. No model is contacted, and nothing here is evidence for
// any live model, route or billing path.
//
// --fixture-stall-once <file>: the first run that finds no <file> creates it,
// ends its model message and then writes nothing, as Claude Code 2.1.302
// sometimes did live; later runs answer normally.
const fs = require("node:fs");
const { answer } = require("./orchestration-answers.cjs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
async function readerTools(config) {
  const server = JSON.parse(fs.readFileSync(config, "utf8")).mcpServers
    .topsl_candidate;
  const rpc = async (id, method, params) =>
    (
      await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...server.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      })
    ).json();
  await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
  const listed = await rpc(2, "tools/list", {});
  const call = await rpc(3, "tools/call", { name: "list", arguments: {} });
  if (call.result.isError)
    throw new Error(`Topsl refused the reader: ${call.result.content[0].text}`);
  return listed.result.tools.map((t) => `mcp__topsl_candidate__${t.name}`);
}
process.stdin.on("end", async () => {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const sessionId = arg("--session-id", "claude-fixture-session");
  const model = arg("--model", "fixture-requested");
  const config = arg("--mcp-config", "{}");
  const event = (v) => process.stdout.write(JSON.stringify(v) + "\n");
  const stallFile = arg("--fixture-stall-once", null);
  const stall = !!stallFile && !fs.existsSync(stallFile);
  if (stall) fs.writeFileSync(stallFile, sessionId);
  const text = answer(input);
  const tools = config.trim().startsWith("{") ? [] : await readerTools(config);
  event({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools,
    uuid: "init-1",
  });
  event({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "message_start", message: { id: "message-1" } },
    uuid: "start-1",
  });
  event({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    uuid: "delta-1",
  });
  event({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "message_stop" },
    uuid: "stop-1",
  });
  if (stall) return setInterval(() => {}, 1000);
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
      input_tokens: 12,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    uuid: "result-1",
  });
});
