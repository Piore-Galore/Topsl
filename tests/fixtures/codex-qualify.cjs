// Scripted app-server for the runtime qualification suite. No model is contacted.
// `command/exec` runs Topsl's sentinel writes in a pretend sandbox: under the
// read-only policy nothing may be written, and under workspace-write only the
// writable roots. An interrupt sent before a turn has streamed any reply finds
// no active turn, as Codex CLI 0.163.0 did in the owner's first live run on
// 16 October 2026.
// FIXTURE_SANDBOX=broken lets every write land, whatever the policy.
// FIXTURE_NO_EXEC=1 does not know `command/exec`.
// FIXTURE_ASK=1 asks for approval to run a command during the marker turn,
// and runs it only if the client accepts.
// On a thread that declares tools, the turn that names a file calls read_range
// for it and replies with the line it returns. FIXTURE_READER=skip replies
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
/** Runs one of Topsl's sandbox probe commands under `policy`. Only the two
 * forms the suite sends are known: printing a word, and writing one to a
 * file, which the sandbox blocks outside the policy's writable roots. */
function exec(argv, policy) {
  const [shell, flag, script, , word, file] = Array.isArray(argv) ? argv : [];
  if (shell !== "/bin/sh" || flag !== "-c")
    return { exitCode: 127, stdout: "", stderr: "fixture: unknown command" };
  if (script === 'printf %s "$1"')
    return { exitCode: 0, stdout: word, stderr: "" };
  if (script !== 'printf %s "$1" > "$2"' || typeof file !== "string")
    return { exitCode: 127, stdout: "", stderr: "fixture: unknown command" };
  const allowed =
    process.env.FIXTURE_SANDBOX === "broken" ||
    (policy?.type === "workspaceWrite" &&
      policy.writableRoots.some((root) => inside(file, root)));
  if (!allowed)
    return {
      exitCode: 1,
      stdout: "",
      stderr: `/bin/sh: ${file}: Operation not permitted`,
    };
  fs.writeFileSync(file, word);
  return { exitCode: 0, stdout: "", stderr: "" };
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
/** FIXTURE_ASK: the marker turn asks to run a command first, and runs it
 * only if Topsl accepts. */
async function askFirst(threadId, turnId, cwd) {
  const itemId = `${turnId}-cmd`,
    file = path.join(cwd, "asked.txt"),
    command = `/bin/zsh -lc "printf asked > '${file}'"`;
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
  const decision = await ask({
    threadId,
    turnId,
    itemId,
    command,
    startedAtMs: Date.now(),
  });
  const accepted = decision === "accept" || decision === "acceptForSession";
  if (accepted) fs.writeFileSync(file, "asked");
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        id: itemId,
        type: "commandExecution",
        command,
        status: accepted ? "completed" : "declined",
        exitCode: accepted ? 0 : null,
      },
    },
  });
}
/** A turn on a thread with tools that names a file: read it through Topsl's
 * read_range tool and reply with its line. */
async function readerTurn(threadId, turnId, file) {
  const mode = process.env.FIXTURE_READER,
    known = () =>
      fs.readFileSync(process.env.FIXTURE_READER_MARKER, "utf8").trim(),
    fallback = "I could not read the file.";
  if (mode === "skip") return complete(threadId, turnId, fallback);
  if (mode === "quote") return complete(threadId, turnId, known());
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
  complete(threadId, turnId, line || fallback);
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
    const { threadId } = request.params,
      prompt = request.params.input[0].text,
      turnId = `turn-${++turnCount}`;
    reply({ turn: { id: turnId }, model: request.params.model });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId } },
    });
    const marker = /TOPSL-QUALIFY-[0-9a-f]+/.exec(prompt),
      file = /with path "([^"]+)"/.exec(prompt);
    if (file && threads.get(threadId)?.dynamicTools)
      return readerTurn(threadId, turnId, file[1]);
    if (marker) {
      if (process.env.FIXTURE_ASK)
        await askFirst(threadId, turnId, request.params.cwd);
      return complete(threadId, turnId, marker[0]);
    }
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
    complete(threadId, turnId, "Done.");
  } else if (request.method === "command/exec" && !process.env.FIXTURE_NO_EXEC)
    reply(exec(request.params.command, request.params.sandboxPolicy));
  else if (request.method === "turn/interrupt") {
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
