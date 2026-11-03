import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import { z } from "zod";
import { hash, stable } from "../domain/invariants";
import type { AllowanceReport, ReportedBucket } from "../domain/allowance";
import { nativeEnvironment } from "../platform/system";
import type { ProviderAccount } from "./contract";

export const claudeAllowanceInterface = "Claude Code /usage (native display)";

// A built-in local command, with no prompt, tools or customizations. Do not
// use --print: /usage is an interactive display, not a model request.
export const claudeUsageArguments = [
  "--safe-mode",
  "--setting-sources",
  "",
  "--settings",
  '{"disableAllHooks":true}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
  "--permission-mode",
  "plan",
  "--no-chrome",
  "--ax-screen-reader",
  "/usage",
];

/** Only the native account command sees credentials. Never return its raw
 * response, stderr, email, organization or configuration path to the UI. */
export async function readClaudeAccount(
  executable: string,
  signal: AbortSignal,
): Promise<ProviderAccount> {
  const unreadable = () =>
    new Error(
      "Claude account status could not be read. Sign in through Claude Code and retry.",
    );
  const output = await new Promise<string>((resolve, reject) => {
    // On Windows, Node refuses a `.cmd` or `.bat` launched without a shell by
    // throwing `spawn EINVAL` synchronously, before any callback runs.
    try {
      execFile(
        executable,
        ["auth", "status", "--json"],
        {
          cwd: os.homedir(),
          env: nativeEnvironment(),
          timeout: 10_000,
          maxBuffer: 64_000,
          windowsHide: true,
          signal,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (error) reject(unreadable());
          else resolve(stdout);
        },
      );
    } catch {
      reject(unreadable());
    }
  });
  const schema = z.object({
    loggedIn: z.literal(true),
    authMethod: z.literal("claude.ai"),
    email: z.string().min(1),
    orgId: z.string().nullish(),
    subscriptionType: z.string().nullish(),
    configDirectory: z.string().optional(),
  });
  let account: z.infer<typeof schema>;
  try {
    account = schema.parse(JSON.parse(output));
  } catch {
    throw new Error(
      "Claude subscription account is unavailable. Sign in through Claude Code with your subscription and retry.",
    );
  }
  return {
    accountKey: hash(
      stable(["claude.ai", account.email, account.orgId ?? null]),
    ),
    profileId: hash(
      account.configDirectory ??
        nativeEnvironment().CLAUDE_CONFIG_DIR ??
        path.join(os.homedir(), ".claude"),
    ),
    billingRoute: "native-subscription",
    sanitized: {
      type: "claude.ai",
      email: null,
      planType: account.subscriptionType ?? null,
    },
  };
}

const terminalColumns = 160;
const terminalRows = 80;

/** The text a terminal shows after `output`, one trimmed line per row. A
 * Windows pseudoconsole (ConPTY) repaints only changed cells and moves the
 * cursor into the middle of a line, so the raw stream is not readable text.
 * Handles printing, CR/LF/BS/TAB and the cursor, erase and scroll commands;
 * other sequences change nothing on screen. Every character takes one cell,
 * and LF also returns to the first column, as a Unix PTY's output does. */
export function terminalScreen(
  output: string,
  columns = terminalColumns,
  rows = terminalRows,
): string {
  const blank = () => Array<string>(columns).fill(" ");
  const screen = Array.from({ length: rows }, blank);
  let row = 0;
  let column = 0;
  let saved = [0, 0];
  const clamp = (value: number, max: number) =>
    Math.max(0, Math.min(max - 1, value));
  const erase = (r: number, from: number, to: number) =>
    screen[r].fill(" ", from, to);
  const scroll = (top: number, count: number) => {
    // Positive counts move rows up from `top`; negative counts move them down.
    const size = Math.min(Math.abs(count), rows - top);
    const lines = Array.from({ length: size }, blank);
    if (count > 0) {
      screen.splice(top, size);
      screen.push(...lines);
    } else {
      screen.splice(top, 0, ...lines);
      screen.length = rows;
    }
  };
  const lineFeed = () => {
    column = 0;
    if (row === rows - 1) scroll(0, 1);
    else row++;
  };
  let i = 0;
  while (i < output.length) {
    const char = output[i];
    if (char === "\x1b") {
      const kind = output[i + 1];
      if (kind === "[") {
        const csi = /^\x1b\[([0-?]*)[ -/]*([@-~])/.exec(
          output.slice(i, i + 64),
        );
        if (!csi) break; // An incomplete sequence at the end of the output.
        i += csi[0].length;
        if (/^[<=>?]/.test(csi[1])) continue; // Private modes.
        const params = csi[1].split(";").map((p) => Number.parseInt(p) || 0);
        const n = Math.max(1, params[0]);
        switch (csi[2]) {
          case "A":
            row = clamp(row - n, rows);
            break;
          case "B":
            row = clamp(row + n, rows);
            break;
          case "C":
            column = clamp(column + n, columns);
            break;
          case "D":
            column = clamp(column - n, columns);
            break;
          case "E":
          case "F":
            row = clamp(row + (csi[2] === "E" ? n : -n), rows);
            column = 0;
            break;
          case "G":
          case "`":
            column = clamp(n - 1, columns);
            break;
          case "d":
            row = clamp(n - 1, rows);
            break;
          case "H":
          case "f":
            row = clamp(n - 1, rows);
            column = clamp(Math.max(1, params[1] ?? 0) - 1, columns);
            break;
          case "J":
            if (params[0] === 0) {
              erase(row, column, columns);
              for (let r = row + 1; r < rows; r++) erase(r, 0, columns);
            } else if (params[0] === 1) {
              for (let r = 0; r < row; r++) erase(r, 0, columns);
              erase(row, 0, column + 1);
            } else for (let r = 0; r < rows; r++) erase(r, 0, columns);
            break;
          case "K":
            if (params[0] === 0) erase(row, column, columns);
            else if (params[0] === 1) erase(row, 0, column + 1);
            else erase(row, 0, columns);
            break;
          case "X":
            erase(row, column, column + n);
            break;
          case "S":
          case "T":
            scroll(0, csi[2] === "S" ? n : -n);
            break;
          case "L":
          case "M":
            scroll(row, csi[2] === "M" ? n : -n);
            break;
        }
        continue;
      }
      if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
        // OSC, DCS, APC and PM strings end at BEL or ST.
        const end = /\x07|\x1b\\/.exec(output.slice(i + 2));
        if (!end) break;
        i += 2 + end.index + end[0].length;
        continue;
      }
      const other = /^\x1b[ -/]*[0-~]/.exec(output.slice(i, i + 8));
      if (!other) break;
      if (other[0] === "\x1b7") saved = [row, column];
      if (other[0] === "\x1b8") [row, column] = saved;
      i += other[0].length;
      continue;
    }
    i++;
    if (char === "\r") column = 0;
    else if (char === "\n" || char === "\v" || char === "\f") lineFeed();
    else if (char === "\b") column = Math.max(0, column - 1);
    else if (char === "\t") column = Math.min(columns - 1, (column | 7) + 1);
    else if (char < " " || (char >= "\x7f" && char < "\xa0")) continue;
    else {
      if (column === columns) lineFeed();
      screen[row][column++] = char;
    }
  }
  return screen.map((line) => line.join("").trimEnd()).join("\n");
}

/** Screen-reader output from the native /usage display. Unknown or partial
 * layouts stay unknown; local activity percentages are never quota windows.
 * Reset labels lack an exact timestamp/year, so retain their original text. */
export function parseClaudeUsageDisplay(
  output: string,
): AllowanceReport | null {
  const text = terminalScreen(output);
  const start = text.lastIndexOf("Current session\n");
  if (start < 0) return null;
  const display = text.slice(start);
  if (!/Esc to (?:cancel|close)/i.test(display)) return null;
  const headings = [
    ...display.matchAll(
      /^Current (session|week(?:\s*\([^\n()]{1,80}\))?)\s*$/gm,
    ),
  ];
  const buckets: ReportedBucket[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i];
    const body = display
      .slice(match.index! + match[0].length, headings[i + 1]?.index)
      .split(
        /What's contributing|Usage credits|Extra usage|Esc to (?:cancel|close)/i,
      )[0];
    const percent = body.match(/(?:^|\s)(\d+(?:\.\d+)?)%\s+used\b/);
    if (!percent || Number(percent[1]) > 100) return null;
    const name = `Current ${match[1]}`;
    const id = name.toLowerCase();
    if (seen.has(id)) return null;
    seen.add(id);
    const resetDescription =
      body.match(/^\s*(Resets? [^\n]{1,160})\s*$/m)?.[1]?.trim() ?? null;
    buckets.push({
      id,
      name,
      primary: {
        usedPercent: Number(percent[1]),
        windowMinutes: match[1] === "session" ? 300 : 10080,
        resetsAtSeconds: null,
        resetDescription,
      },
      secondary: null,
      credits: null,
      planType: null,
      limitReached: null,
    });
  }
  return buckets.length
    ? { kind: "read", ordinaryUsageAllowed: null, buckets }
    : null;
}

/** A bounded, disposable native terminal. It never answers login/trust
 * prompts, sends model input, or persists raw output. Success waits for exit. */
export function readClaudeUsage(
  executable: string,
  cwd: string,
  signal: AbortSignal,
  options: { spawn?: typeof spawn; timeoutMs?: number } = {},
): Promise<AllowanceReport> {
  if (signal.aborted)
    return Promise.reject(new Error("Claude usage read cancelled."));
  return new Promise((resolve, reject) => {
    let terminal: IPty;
    try {
      terminal = (options.spawn ?? spawn)(
        executable,
        [...claudeUsageArguments],
        {
          cwd,
          env: nativeEnvironment({ TERM: "xterm-256color" }),
          cols: terminalColumns,
          rows: terminalRows,
          name: "xterm-256color",
        },
      );
    } catch {
      reject(
        new Error(
          "Claude usage terminal could not start. Check the selected Claude Code executable.",
        ),
      );
      return;
    }
    let output = "";
    let result: AllowanceReport | Error | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (value: AllowanceReport | Error) => {
      if (result) return;
      result = value;
      output = "";
      clearTimeout(timeout);
      forceTimer = setTimeout(() => {
        exitTimer = setTimeout(
          () =>
            finish(
              new Error("Claude usage terminal exit could not be confirmed."),
            ),
          1000,
        );
        try {
          terminal.kill("SIGKILL");
        } catch {
          /* Exit handler settles. */
        }
      }, 1000);
      try {
        terminal.kill();
      } catch {
        /* May already have exited. */
      }
    };
    const abort = () => stop(new Error("Claude usage read cancelled."));
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            "Claude did not return a supported /usage display. Run /usage in Claude Code to check sign-in, folder trust and runtime compatibility.",
          ),
        ),
      options.timeoutMs ?? 25_000,
    );
    const data = terminal.onData((chunk) => {
      if (result) return;
      output += chunk;
      if (output.length > 256_000)
        return stop(new Error("Claude usage display exceeded the read limit."));
      const plain = terminalScreen(output);
      if (
        /Is this a project you created or one you trust|Enter y\/n:/.test(plain)
      )
        return stop(
          new Error(
            "Claude needs native folder trust. Open Claude Code in this Topsl project, review its trust prompt, then refresh usage.",
          ),
        );
      if (
        /Failed to load usage|Error fetching usage|Failed to fetch usage/i.test(
          plain,
        )
      )
        return stop(
          new Error(
            "Claude could not load usage. Try /usage in Claude Code and refresh again.",
          ),
        );
      const report = parseClaudeUsageDisplay(output);
      if (report) stop(report);
    });
    const finish = (value: AllowanceReport | Error) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(exitTimer);
      signal.removeEventListener("abort", abort);
      data.dispose();
      exited.dispose();
      output = "";
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const exited = terminal.onExit(() =>
      finish(
        result ??
          new Error(
            "Claude exited without a supported usage display. Run /usage in Claude Code and retry.",
          ),
      ),
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
