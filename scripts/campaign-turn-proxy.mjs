// The campaign turn budget's proxy (docs/testing/2026-11-04-comprehensive/
// PLAN.md, "Live budget"): a stand-in for one provider executable that runs the
// real one and records every model turn in a shared ledger, refusing any turn
// past the cap. scripts/campaign-turn-budget.mjs writes the wrapper that runs
// this file with the settings below; nothing here is shipped.
//
// CAMPAIGN_PROVIDER  codex | claude
// CAMPAIGN_REAL      the real executable
// CAMPAIGN_LEDGER    the ledger: one JSON line per counted turn
// CAMPAIGN_CAP       the most turns the whole ledger may hold; a file
//                    <ledger>.cap, when present, overrides it
//
// Codex: each JSON-RPC `turn/start` request Topsl writes to the app-server is
// a structured turn. A turn past the cap is answered with a JSON-RPC error and
// never reaches Codex. `command/exec` sandbox probes start no model turn and
// are not counted.
// Claude Code: each `--print` run is a structured turn, and each interactive
// session is one prompted terminal round (the live harness sends one prompt
// per session). A run past the cap exits 1 before Claude Code starts. Account
// reads, --version and --help are not counted.
// The ledger records times, provider, kind, model and effort, never prompts.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
} from "node:fs";
import { createInterface } from "node:readline";

const provider = process.env.CAMPAIGN_PROVIDER;
const real = process.env.CAMPAIGN_REAL;
const ledger = process.env.CAMPAIGN_LEDGER;
const args = process.argv.slice(2);
if (!["codex", "claude"].includes(provider) || !real || !ledger) {
  process.stderr.write("campaign-turn-proxy: missing settings\n");
  process.exit(2);
}

const cap = () => {
  const file = `${ledger}.cap`;
  const value = existsSync(file)
    ? Number(readFileSync(file, "utf8").trim())
    : Number(process.env.CAMPAIGN_CAP);
  return Number.isInteger(value) && value >= 0 ? value : 0;
};
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Counts one turn under the ledger's lock; false when the cap is reached. */
function reserve(entry) {
  const lock = `${ledger}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (tries > 1000) throw new Error("campaign ledger lock is stuck");
      sleep(10);
    }
  }
  try {
    const counted = existsSync(ledger)
      ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).length
      : 0;
    const allowed = counted < cap();
    appendFileSync(
      allowed ? ledger : `${ledger}.refused`,
      JSON.stringify({
        at: new Date().toISOString(),
        provider,
        pid: process.pid,
        number: allowed ? counted + 1 : null,
        cap: cap(),
        ...entry,
      }) + "\n",
    );
    return allowed;
  } finally {
    rmdirSync(lock);
  }
}

const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
};

function run(stdio) {
  const child = spawn(real, args, { stdio, env: process.env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => child.kill(signal));
  // "close" waits for the child's output to drain before this process exits.
  child.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on("error", (error) => {
    process.stderr.write(`campaign-turn-proxy: ${error.message}\n`);
    process.exit(127);
  });
  return child;
}

if (provider === "claude") {
  const passthrough =
    ["auth", "mcp", "config", "doctor", "update"].includes(args[0]) ||
    args.includes("--version") ||
    args.includes("--help");
  if (!passthrough) {
    const kind = args.includes("--print")
      ? "structured-turn"
      : "terminal-session";
    if (
      !reserve({ kind, model: value("--model"), effort: value("--effort") })
    ) {
      process.stderr.write(
        "The campaign's turn budget is spent; this Claude Code run was refused before it started.\n",
      );
      process.exit(1);
    }
  }
  run("inherit");
} else {
  const child = run(["pipe", "pipe", "inherit"]);
  // Whole lines only, so a refusal never lands inside one of Codex's frames.
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on(
    "line",
    (line) => process.stdout.write(line + "\n"),
  );
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {}
    if (message?.method === "turn/start") {
      const params = message.params ?? {};
      const allowed = reserve({
        kind: "structured-turn",
        model: params.model ?? null,
        effort: params.effort ?? params.reasoningEffort ?? null,
      });
      if (!allowed) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message:
                "The campaign's turn budget is spent; this turn was refused before it reached Codex.",
            },
          }) + "\n",
        );
        return;
      }
    }
    child.stdin.write(line + "\n");
  });
  lines.on("close", () => child.stdin.end());
}
