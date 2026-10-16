// Scripted app-server for the runtime qualification suite. No model is contacted.
// It answers as Codex CLI 0.163.0 appeared to in the owner's live run on
// 16 October 2026. Unless the approval policy is "never", it asks before it
// runs a command, and a command the client approves runs again outside the
// sandbox when the sandbox blocks it. Under "never" it asks nothing and the
// sandbox has the last word. An interrupt sent before a turn has streamed any
// reply finds no active turn.
// FIXTURE_SANDBOX=broken lets every write land, in the sandbox or out of it.
// FIXTURE_REFUSE=1 answers the write probes without running anything.
// FIXTURE_ALTERED=1 proposes a compound command instead of the requested one.
// FIXTURE_ASK=1 asks for approval whatever the approval policy.
// On a thread that declares tools, the marker turn calls read_range for the
// file it names and quotes the line it returns. FIXTURE_READER=skip replies
// without calling it; FIXTURE_READER=quote quotes the marker in the file that
// FIXTURE_READER_MARKER names, without calling it; FIXTURE_READER=other reads
// another path instead; FIXTURE_READER=stray calls it naming another turn;
// FIXTURE_READER=unquoted reads the file but does not quote it;
// FIXTURE_READER=partial reads only its first bytes, then quotes the marker
// from FIXTURE_READER_MARKER.
// FIXTURE_REFUSE_TOOLS=1 refuses a thread/start that declares tools.
// FIXTURE_LOG appends every frame, in both directions, to that file.
// It answers --version and lists one model, so the desktop test can register,
// connect and qualify it through Topsl's own interface.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.163.0-qualify-fixture");
  process.exit(0);
}
const log = (from, frame) => {
  if (process.env.FIXTURE_LOG)
    fs.appendFileSync(
      process.env.FIXTURE_LOG,
      JSON.stringify({ from, frame }) + "\n",
    );
};
const send = (value) => {
  log("fixture", value);
  process.stdout.write(JSON.stringify(value) + "\n");
};
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
/** Runs a sentinel write and returns its exit code. Inside the sandbox, a
 * write outside the policy's writable roots fails. */
function execute(line, policy, sandboxed) {
  const match = /^printf (\w+) > '([^']+)'$/.exec(line);
  if (!match) return 1;
  const allowed =
    !sandboxed ||
    process.env.FIXTURE_SANDBOX === "broken" ||
    (policy?.type === "workspaceWrite" &&
      policy.writableRoots.some((root) => inside(match[2], root)));
  if (!allowed) return 1;
  fs.writeFileSync(match[2], match[1]);
  return 0;
}
/** Sends a request to Topsl and resolves with its response. */
function call(method, params) {
  const id = `request-${++requestCount}`;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
async function ask(params) {
  const response = await call("item/commandExecution/requestApproval", params);
  return response.result?.decision ?? "decline";
}
/** The marker turn on a thread with tools: read the named file through
 * Topsl's read_range tool and quote its line after the reply marker. */
async function readerTurn(threadId, turnId, marker, file) {
  const mode = process.env.FIXTURE_READER,
    known = () =>
      fs.readFileSync(process.env.FIXTURE_READER_MARKER, "utf8").trim();
  if (mode === "skip") return complete(threadId, turnId, marker);
  if (mode === "quote")
    return complete(threadId, turnId, `${marker}\n${known()}`);
  const callId = `${turnId}-tool`,
    args =
      mode === "other"
        ? { path: "outside.txt" }
        : mode === "partial"
          ? { path: file, length: 4 }
          : { path: file },
    response = await call("item/tool/call", {
      threadId,
      turnId: mode === "stray" ? "another-turn" : turnId,
      callId,
      namespace: "topsl_candidate",
      tool: "read_range",
      arguments: args,
    });
  const text = response.result?.contentItems?.[0]?.text ?? "";
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: {
        id: callId,
        type: "dynamicToolCall",
        namespace: "topsl_candidate",
        tool: "read_range",
        arguments: args,
        status: response.result?.success ? "completed" : "failed",
        contentItems: response.result?.contentItems ?? null,
        success: response.result?.success ?? null,
        durationMs: 1,
      },
    },
  });
  let line = "";
  try {
    line = JSON.parse(text).content.trim();
  } catch {
    // A refusal is plain text.
  }
  if (mode === "unquoted") line = "";
  if (mode === "partial") line = known();
  complete(threadId, turnId, line ? `${marker}\n${line}` : marker);
}
async function runCommands(threadId, turnId, lines, policy, approvalPolicy) {
  for (const [index, requested] of lines.entries()) {
    const line = process.env.FIXTURE_ALTERED
        ? `${requested}; touch '${path.join(path.dirname(requested.split("'")[1]), "extra")}'`
        : requested,
      itemId = `${turnId}-cmd-${index}`,
      // Codex 0.163.0 reports the command as one string.
      command = `/bin/zsh -lc "${line}"`;
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: "commandExecution",
          command,
          status: "inProgress",
        },
      },
    });
    let exitCode = null;
    if (approvalPolicy === "never" && !process.env.FIXTURE_ASK)
      exitCode = execute(line, policy, true);
    else {
      const decision = await ask({
        threadId,
        turnId,
        itemId,
        command,
        startedAtMs: Date.now(),
      });
      if (decision === "accept" || decision === "acceptForSession") {
        exitCode = execute(line, policy, true);
        if (exitCode && approvalPolicy !== "never")
          exitCode = execute(line, policy, false);
      }
    }
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: "commandExecution",
          command,
          status:
            exitCode === null ? "declined" : exitCode ? "failed" : "completed",
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
  log("topsl", request);
  if (request.id !== undefined && !request.method) {
    pending.get(request.id)?.(request);
    pending.delete(request.id);
    return;
  }
  if (request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize")
    reply({ platformFamily: "unix", platformOs: process.platform });
  else if (request.method === "model/list")
    reply({
      data: [
        {
          id: "fixture",
          model: "fixture-model",
          displayName: "Fixture",
          isDefault: true,
        },
      ],
    });
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
    if (process.env.FIXTURE_REFUSE_TOOLS && request.params.dynamicTools)
      return send({
        id: request.id,
        error: {
          code: -32600,
          message:
            "thread/start.dynamicTools requires experimentalApi capability",
        },
      });
    const id = `thread-${++threadCount}`;
    threads.set(id, request.params);
    reply({ thread: { id }, model: request.params.model });
  } else if (request.method === "turn/start") {
    const { threadId, sandboxPolicy } = request.params,
      approvalPolicy =
        request.params.approvalPolicy ?? threads.get(threadId)?.approvalPolicy,
      prompt = request.params.input[0].text,
      turnId = `turn-${++turnCount}`;
    reply({ turn: { id: turnId }, model: request.params.model });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId } },
    });
    const marker = /TOPSL-QUALIFY-[0-9a-f]+/.exec(prompt),
      file = /with path "([^"]+)"/.exec(prompt);
    if (marker && file && threads.get(threadId)?.dynamicTools)
      return readerTurn(threadId, turnId, marker[0], file[1]);
    if (marker) return complete(threadId, turnId, marker[0]);
    if (prompt.includes("Write the numbers")) {
      let n = 0;
      const delta = () =>
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId: `${turnId}-msg`,
            delta: `${++n}\n`,
          },
        });
      // The reply starts streaming a little after the turn has started.
      const turn = (streaming = { threadId, turnId, active: false });
      turn.timer = setTimeout(() => {
        turn.active = true;
        delta();
        turn.timer = setInterval(delta, 10);
      }, 100);
      return;
    }
    const lines = prompt
      .split("\n")
      .filter((line) => line.startsWith("printf "));
    if (process.env.FIXTURE_REFUSE || !lines.length)
      return complete(threadId, turnId, "I will not run commands here.");
    await runCommands(threadId, turnId, lines, sandboxPolicy, approvalPolicy);
    complete(threadId, turnId, "Done.");
  } else if (request.method === "turn/interrupt") {
    if (!streaming?.active || streaming.turnId !== request.params.turnId)
      return send({
        id: request.id,
        error: { code: -32600, message: "no active turn to interrupt" },
      });
    reply({});
    clearInterval(streaming.timer);
    complete(streaming.threadId, streaming.turnId, null, "interrupted");
    streaming = null;
  } else
    send({
      id: request.id,
      error: { code: -32601, message: "Unsupported fixture method." },
    });
});
