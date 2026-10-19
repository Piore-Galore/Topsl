// A Claude Code print/stream-json stand-in for coordinator and loop service
// tests. It answers each execution purpose's contract from the prompt alone,
// with the same replies as the Codex stand-in (orchestration-answers.cjs), and
// reports the requested model. No model is contacted, and nothing here is
// evidence for any live model, route or billing path.
const { answer } = require("./orchestration-answers.cjs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const sessionId = arg("--session-id", "claude-fixture-session");
  const model = arg("--model", "fixture-requested");
  const event = (v) => process.stdout.write(JSON.stringify(v) + "\n");
  const text = answer(input);
  event({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    tools: [],
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
