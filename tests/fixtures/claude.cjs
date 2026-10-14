let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const sessionIndex = process.argv.indexOf("--session-id");
  const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : "claude-fixture-session";
  const event = (v) => process.stdout.write(JSON.stringify(v) + "\n");
  let text = "fixture result";
  if (input.startsWith("# Topsl task input")) {
    if (/^Role: reviewer$/m.test(input)) text = JSON.stringify({ candidateRevision: /Candidate revision: ([a-f0-9]{64})/.exec(input)?.[1], summary: "no substantiated findings", findings: [] });
    else { require("node:fs").writeFileSync("file.ts", "export const value = 2;\n"); text = "Fixture changed value; no model was contacted."; }
  }
  event({ type: "system", subtype: "init", session_id: sessionId, model: "fixture-effective", tools: [], uuid: "init-1" });
  if (input.includes("fixture-crash")) return process.exit(1);
  if (input.includes("fixture-malformed")) return process.stdout.write("not json\n");
  event({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { id: "message-1" } }, uuid: "start-1" });
  event({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text } }, uuid: "delta-1" });
  event({ type: "assistant", session_id: sessionId, message: { id: "message-1", model: "fixture-effective", content: [{ type: "thinking", thinking: "not product telemetry" }, { type: "text", text }] }, uuid: "assistant-1" });
  event({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: text, usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }, uuid: "result-1" });
});
