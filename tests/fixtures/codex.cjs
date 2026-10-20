const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const { threadResponse } = require("./codex-thread.cjs");
// It answers --version, so the desktop test can register it as Codex.
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.163.0-fixture");
  process.exit(0);
}
// FIXTURE_LOG records every frame in both directions, so tests can check them
// against the schema Codex generates. Its answers to thread/start and
// thread/resume come from codex-thread.cjs, which can also report permissions
// other than those Topsl asked for.
const log = (from, frame) =>
  process.env.FIXTURE_LOG &&
  fs.appendFileSync(
    process.env.FIXTURE_LOG,
    JSON.stringify({ from, frame }) + "\n",
  );
const send = (value) => {
  log("fixture", value);
  process.stdout.write(JSON.stringify(value) + "\n");
};
// FIXTURE_RESETS_AT sets the weekly window's reset time in Unix seconds.
const rateLimitSnapshot = (usedPercent) => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: {
    usedPercent,
    windowDurationMins: 10080,
    resetsAt: Number(
      process.env.FIXTURE_RESETS_AT || Math.floor(Date.now() / 1000) + 86400,
    ),
  },
  secondary: null,
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  individualLimit: null,
  spendControlReached: false,
  planType: "fixture",
  rateLimitReachedType: null,
});
let pendingApproval = false;
let pendingTool = null;
let turn = "turn-fixture";
// FIXTURE_DELTAS streams the reply as that many one-character deltas first.
const done = (text) => {
  const deltas = Number(process.env.FIXTURE_DELTAS || 0);
  let stream = "";
  for (let i = 0; i < deltas; i++)
    stream +=
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-fixture",
          turnId: turn,
          itemId: "item-fixture",
          delta: ".",
        },
      }) + "\n";
  if (stream) process.stdout.write(stream);
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-fixture",
      turnId: turn,
      itemId: "item-fixture",
      delta: text,
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId: "thread-fixture",
      turnId: turn,
      item: { id: "item-fixture", type: "agentMessage", text },
    },
  });
  const usage = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-fixture",
      turnId: turn,
      tokenUsage: {
        total: { inputTokens: 1000 },
        last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
      },
    },
  };
  send(usage);
  send(usage);
  send({
    method: "turn/completed",
    params: {
      threadId: "thread-fixture",
      turn: { id: turn, status: "completed" },
    },
  });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  log("topsl", request);
  if (request.id === "approval-fixture" && pendingApproval) {
    pendingApproval = false;
    done(request.result?.decision ?? request.error?.message ?? "unknown");
    return;
  }
  if (request.id === "tool-fixture" && pendingTool) {
    const call = pendingTool,
      result = request.result;
    pendingTool = null;
    send({
      method: "item/completed",
      params: {
        threadId: "thread-fixture",
        turnId: turn,
        completedAtMs: Date.now(),
        item: {
          type: "dynamicToolCall",
          id: "tool-item-fixture",
          namespace: call.namespace,
          tool: call.tool,
          arguments: call.arguments,
          status: result?.success ? "completed" : "failed",
          contentItems: result?.contentItems ?? null,
          success: result?.success ?? null,
          durationMs: 1,
        },
      },
    });
    done(JSON.stringify(result ?? request.error));
    return;
  }
  if (request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === "initialize")
    reply({ platformFamily: process.platform, platformOs: process.platform });
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
        type: process.env.FIXTURE_ACCOUNT_TYPE || "chatgpt",
        email: "fixture@example.test",
        planType: "fixture",
      },
    });
  else if (
    request.method === "account/rateLimits/read" &&
    process.env.FIXTURE_RATE_LIMITS !== "unsupported"
  )
    // The shape Codex CLI 0.163.0 returns; the values are synthetic.
    reply({
      ordinaryUsageAllowed: true,
      rateLimits: rateLimitSnapshot(12),
      rateLimitsByLimitId: { codex: rateLimitSnapshot(12) },
      rateLimitResetCredits: null,
      accountId: "fixture-account",
      rateLimitUpsell: null,
    });
  else if (["thread/start", "thread/resume"].includes(request.method))
    reply(threadResponse(request.params, "thread-fixture"));
  else if (request.method === "turn/start") {
    const prompt = request.params.input[0].text;
    if (prompt === "crash") {
      process.exit(2);
      return;
    }
    if (prompt === "malformed") {
      process.stdout.write("bad protocol\n");
      return;
    }
    reply({ turn: { id: turn, status: "inProgress" } });
    send({
      method: "turn/started",
      params: { threadId: "thread-fixture", turn: { id: turn } },
    });
    if (prompt === "hold") return;
    setTimeout(() => {
      // "tool {json}" calls a tool, as a model would through Codex's dynamic
      // tools. The JSON names the tool and can override the thread or turn.
      if (prompt.startsWith("tool ")) {
        const ask = JSON.parse(prompt.slice("tool ".length));
        pendingTool = {
          namespace: ask.namespace ?? null,
          tool: ask.tool,
          arguments: ask.arguments ?? {},
        };
        send({
          id: "tool-fixture",
          method: "item/tool/call",
          params: {
            threadId: ask.threadId ?? "thread-fixture",
            turnId: ask.turnId ?? turn,
            callId: "call-fixture",
            ...pendingTool,
          },
        });
      } else if (prompt.includes("file approval")) {
        // Codex names a change's files on its item, and the request to
        // approve it names only the item. This one also asks to write
        // outside the project for the rest of the session.
        pendingApproval = true;
        send({
          method: "item/started",
          params: {
            threadId: "thread-fixture",
            turnId: turn,
            startedAtMs: Date.now(),
            item: {
              type: "fileChange",
              id: "change-fixture",
              status: "inProgress",
              changes: [
                {
                  path: path.join(process.cwd(), "notes.md"),
                  kind: { type: "update", move_path: null },
                  diff: "@@ -1 +1 @@\n-old\n+new\n",
                },
                {
                  path: path.join(process.cwd(), "src", "added.ts"),
                  kind: { type: "add" },
                  diff: "export {};\n",
                },
              ],
            },
          },
        });
        send({
          id: "approval-fixture",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "thread-fixture",
            turnId: turn,
            itemId: "change-fixture",
            startedAtMs: Date.now(),
            reason: "Fixture asks to write outside the project.",
            grantRoot: path.dirname(process.cwd()),
          },
        });
      } else if (prompt.includes("approval")) {
        pendingApproval = true;
        const ask = () =>
          send({
            id: "approval-fixture",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId:
                prompt === "wrong-thread-approval"
                  ? "another-thread"
                  : "thread-fixture",
              turnId: turn,
              itemId: "command-fixture",
              startedAtMs: Date.now(),
              command: "fixture read command",
              cwd: process.cwd(),
            },
          });
        // FIXTURE_APPROVAL_GATE holds the request until that file exists, so
        // a test can change something while the turn runs.
        const gate = process.env.FIXTURE_APPROVAL_GATE;
        if (!gate) ask();
        else {
          const wait = setInterval(() => {
            if (!fs.existsSync(gate)) return;
            clearInterval(wait);
            ask();
          }, 20);
        }
      } else if (prompt === "rate limit update") {
        // A sparse rolling update, as Codex sends while a turn runs.
        send({
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              ...rateLimitSnapshot(40),
              credits: null,
              planType: null,
            },
          },
        });
        done("Fixture response, no model was contacted.");
      } else done("Fixture response, no model was contacted.");
    }, 20);
  } else if (request.method === "turn/interrupt") {
    reply({});
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-fixture",
        turn: { id: turn, status: "interrupted" },
      },
    });
  } else
    send({
      id: request.id,
      error: { code: -32601, message: "Unsupported fixture method." },
    });
});
