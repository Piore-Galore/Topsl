import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
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
  const output = await new Promise<string>((resolve, reject) => {
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
        if (error)
          reject(
            new Error(
              "Claude account status could not be read. Sign in through Claude Code and retry.",
            ),
          );
        else resolve(stdout);
      },
    );
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

/** Screen-reader output from the native /usage display. Unknown or partial
 * layouts stay unknown; local activity percentages are never quota windows.
 * Reset labels lack an exact timestamp/year, so retain their original text. */
export function parseClaudeUsageDisplay(
  output: string,
): AllowanceReport | null {
  // Repaints can put a new heading immediately after the old footer. Keep a
  // line boundary for cursor/erase commands; SGR/OSC are formatting only.
  const text = stripVTControlCharacters(
    output.replace(/\x1b\[[\d;?]*[ABCDEFGHJKf]/g, "\n"),
  ).replace(/\r/g, "");
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
          cols: 160,
          rows: 80,
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
      const plain = stripVTControlCharacters(output);
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
