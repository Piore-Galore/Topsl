import path from "node:path";
import { EventEmitter } from "node:events";
import { access, chmod, readFile, rm, writeFile } from "node:fs/promises";
import type { IPty, spawn } from "node-pty";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseClaudeUsageDisplay,
  readClaudeAccount,
  readClaudeUsage,
  terminalScreen,
} from "../packages/providers/claude-allowance";
import {
  applyAllowanceReport,
  allowanceWindows,
  type AllowanceSnapshot,
} from "../packages/domain/allowance";
import { allowanceStatus } from "../apps/desktop/renderer/state/allowance-view";
import { RuntimeManager } from "../packages/runtime/manager";
import { identity } from "../packages/platform/system";
import { Service } from "../apps/service/service";
import type { AppState } from "../packages/domain/types";
import { fixture } from "./helpers";

const display =
  "Current session\r\n13% 13% used\r\nResets 1:29am (Asia/Shanghai)\r\nCurrent week (all models)\r\n51% 51% used\r\nResets Oct 23 at 3:59pm (Asia/Shanghai)\r\nCurrent week (Sonnet only)\r\n0% 0% used\r\nResets Oct 23 at 4pm (Asia/Shanghai)\r\nWhat's contributing to your limits usage?\r\n90% of your usage was at >150k context\r\nUsage credits\r\nUsage credits are off\r\nEsc to cancel";
afterEach(() => vi.unstubAllEnvs());

test.skipIf(!process.env.TOPSL_CLAUDE_USAGE_LIVE)(
  "opt-in installed Claude Code usage read (no model prompt)",
  async () => {
    const executable = process.env.TOPSL_CLAUDE_USAGE_LIVE!;
    const cwd = process.env.TOPSL_CLAUDE_USAGE_CWD ?? process.cwd();
    const signal = AbortSignal.timeout(40_000);
    const before = await readClaudeAccount(executable, signal);
    const report = await readClaudeUsage(executable, cwd, signal);
    const after = await readClaudeAccount(executable, signal);
    expect(after.accountKey).toBe(before.accountKey);
    expect(after.profileId).toBe(before.profileId);
    expect(report.buckets.length).toBeGreaterThan(0);
    expect(
      report.buckets.every((bucket) => bucket.primary?.resetDescription),
    ).toBe(true);
    // No account identifiers, balances or raw terminal output in evidence.
    console.log(
      `Native Claude /usage: ${report.buckets.length} windows; reset labels retained; account unchanged.`,
    );
  },
  45_000,
);

describe("Claude native usage display", () => {
  test("reads session, weekly and model windows without counting activity or inventing reset timestamps", () => {
    const report = parseClaudeUsageDisplay(
      `\x1b]0;Claude\x07Loading usage data…\nEsc to cancel\x1b[2K\x1b[G${display}`,
    )!;
    expect(report.buckets.map((b) => b.primary?.usedPercent)).toEqual([
      13, 51, 0,
    ]);
    expect(report.buckets.map((b) => b.primary?.windowMinutes)).toEqual([
      300, 10080, 10080,
    ]);
    expect(report.buckets[0].primary).toMatchObject({
      resetsAtSeconds: null,
      resetDescription: "Resets 1:29am (Asia/Shanghai)",
    });
    expect(report.ordinaryUsageAllowed).toBeNull();
    expect(report.buckets.every((b) => b.credits === null)).toBe(true);
    const snapshot = applyAllowanceReport(
      undefined,
      {
        provider: "claude",
        accountKey: "hash",
        installationId: "cli",
        runtimeVersion: "2.1.302",
        interface: "native /usage",
      },
      report,
      "2026-10-18T10:00:00Z",
    );
    const windows = allowanceWindows(
      snapshot,
      Date.parse("2026-10-18T10:01:00Z"),
    );
    expect(windows[0].windows[0]).toMatchObject({
      remainingPercent: 87,
      resetsAt: null,
      resetDescription: "Resets 1:29am (Asia/Shanghai)",
    });
    expect(
      allowanceStatus("claude", [snapshot], Date.parse("2026-10-18T10:01:00Z"))
        .label,
    ).toBe("Reported · current");
  });
  test.each([
    "Loading usage data…\nEsc to cancel",
    "90% of your usage was at >150k context\nEsc to cancel",
    display.replace("13% used", "101% used"),
    display.replace("13% 13% used", "-1% used"),
    display.replace("13% 13% used", "unknown"),
    display.replace("Esc to cancel", ""),
    display.replace("Current week (Sonnet only)", "Current week (all models)"),
  ])("rejects incomplete, invalid or unrelated output", (value) => {
    expect(parseClaudeUsageDisplay(value)).toBeNull();
  });
  test("reads a Windows pseudoconsole repaint that moves the cursor into the middle of a heading", () => {
    // The shape ConPTY sent on Windows CI (29 October 2026) for the usage
    // stand-in: a cleared screen, then only the changed cells, positioned.
    const rest = display.slice("Current session\r\n".length);
    const report = parseClaudeUsageDisplay(
      "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HSettings  Status   Config   Usage   Stats\r\nLoading usage data…\r\nEsc to cancel\x1b]0;Claude\x07\x1b[?25h" +
        `\x1b[?25l\x1b[2;1HCurrent ses\x1b[K\r\n\x1b[K\x1b[2;12H\x1b[?25hsion\r\n${rest}\x1b[15C\x1b[?9001l\x1b[?1004l`,
    )!;
    expect(report.buckets.map((b) => b.primary?.usedPercent)).toEqual([
      13, 51, 0,
    ]);
    // A cursor move is a position, not a line break: here the second half
    // of the heading lands on another row.
    expect(
      parseClaudeUsageDisplay(
        display.replace("Current session", "Current ses\x1b[2;12Hsion"),
      ),
    ).toBeNull();
  });
  test("reads what the terminal shows: overwritten text, erased lines and scrolled rows", () => {
    expect(terminalScreen("Loading usage data…\r\x1b[KCurrent session")).toBe(
      "Current session" + "\n".repeat(79),
    );
    // Text that a repaint does not erase stays on screen.
    expect(
      terminalScreen("Loading usage data…\x1b[GCurrent session").split("\n")[0],
    ).toBe("Current sessionata…");
    expect(
      terminalScreen("a\r\nb\x1b[1;3Hc\x1b[2;1H\x1b[2Kd\x1b[5X", 10, 3),
    ).toBe("a c\nd\n");
    expect(terminalScreen("1\n2\n3\n4", 10, 3)).toBe("2\n3\n4");
    expect(terminalScreen("abcdef", 4, 2)).toBe("abcd\nef");
    expect(terminalScreen("ab\x1b[1;1H\x1b[1L", 4, 2)).toBe("\nab");
    expect(terminalScreen("ab\x1b[", 4, 1)).toBe("ab");
  });
  test("an omitted reset stays unknown and a real 100% stays exhausted", () => {
    const report = parseClaudeUsageDisplay(
      "Current session\n100% used\nEsc to cancel",
    )!;
    expect(report.buckets[0].primary).toMatchObject({
      usedPercent: 100,
      resetsAtSeconds: null,
      resetDescription: null,
    });
  });
});

function terminalFixture() {
  const events = new EventEmitter();
  const kill = vi.fn(() =>
    setImmediate(() => events.emit("exit", { exitCode: 0 })),
  );
  const terminal = {
    kill,
    onData: (callback: (data: string) => void) => {
      events.on("data", callback);
      return { dispose: () => events.off("data", callback) };
    },
    onExit: (callback: (event: { exitCode: number }) => void) => {
      events.on("exit", callback);
      return { dispose: () => events.off("exit", callback) };
    },
  } as unknown as IPty;
  const launch = vi.fn(() => terminal) as unknown as typeof spawn;
  return { events, kill, launch };
}

describe("bounded native terminal", () => {
  test("accepts split ANSI chunks, closes the PTY and returns only quota fields", async () => {
    const f = terminalFixture();
    const reading = readClaudeUsage(
      "claude",
      "/trusted",
      new AbortController().signal,
      { spawn: f.launch },
    );
    f.events.emit("data", "\x1b]");
    f.events.emit("data", `0;private-account\x07${display.slice(0, 25)}`);
    f.events.emit("data", display.slice(25));
    const report = await reading;
    expect(report.buckets).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain("private-account");
    expect(f.kill).toHaveBeenCalledOnce();
    expect(f.events.listenerCount("data")).toBe(0);
  });
  test.each([
    "Is this a project you created or one you trust?",
    "Error fetching usage: private-error-body",
  ])(
    "never answers native prompts or exposes error output",
    async (message) => {
      const f = terminalFixture();
      const reading = readClaudeUsage(
        "claude",
        "/trusted",
        new AbortController().signal,
        { spawn: f.launch },
      );
      f.events.emit("data", message);
      await expect(reading).rejects.toThrow(
        /Claude (needs native folder trust|could not load usage)/,
      );
      expect(f.kill).toHaveBeenCalledOnce();
    },
  );
  test("times out and closes a silent process", async () => {
    const f = terminalFixture();
    await expect(
      readClaudeUsage("claude", "/trusted", new AbortController().signal, {
        spawn: f.launch,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("supported /usage display");
    expect(f.kill).toHaveBeenCalledOnce();
  });
  test("cancellation closes an active process", async () => {
    const f = terminalFixture(),
      abort = new AbortController();
    const reading = readClaudeUsage("claude", "/trusted", abort.signal, {
      spawn: f.launch,
    });
    abort.abort();
    await expect(reading).rejects.toThrow("cancelled");
    expect(f.kill).toHaveBeenCalledOnce();
  });
  test("an early exit stays unknown", async () => {
    const f = terminalFixture();
    const reading = readClaudeUsage(
      "claude",
      "/trusted",
      new AbortController().signal,
      { spawn: f.launch },
    );
    f.events.emit("exit", { exitCode: 1 });
    await expect(reading).rejects.toThrow("without a supported usage display");
  });
});

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function setup() {
  const f = await fixture();
  vi.stubEnv("CLAUDE_CONFIG_DIR", f.directory);
  await writeFile(path.join(f.directory, "usage-fixture"), "");
  await writeFile(
    f.installation.path,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/claude-usage.cjs"))} "$@"\n`,
  );
  await chmod(f.installation.path, 0o700);
  const installation = {
    ...f.installation,
    ...(await identity(f.installation.path)),
    appId: "anthropic.claude-code-cli" as const,
    version: "2.1.302",
    compatibility: "native-only" as const,
  };
  f.store.put("installation", installation);
  f.store.put("project", {
    id: "project",
    name: "fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
  });
  return { ...f, installation };
}

describe.skipIf(process.platform === "win32")(
  "Claude native usage integration",
  () => {
    test("service publishes reads from a native-only CLI, keeps failures beside older values and persists no account or terminal text", async () => {
      const f = await setup();
      f.store.close();
      const states: AppState[] = [];
      const service = new Service(
        f.directory,
        f.key,
        (event) => {
          if (event.type === "state") states.push(event.data);
        },
        true,
      );
      try {
        const first = (await service.command({
          type: "provider-allowance-refresh",
          id: f.installation.id,
        })) as AllowanceSnapshot;
        expect(first.buckets[0].primary?.usedPercent).toBe(13);
        expect(first.buckets[0].planType).toBe("max");
        expect(JSON.stringify(first)).not.toMatch(
          /private@example|private-organization|contributing/,
        );
        await expect
          .poll(() =>
            states.some((s) =>
              s.allowances?.some((a) => a.provider === "claude"),
            ),
          )
          .toBe(true);
        expect(service.store.list("run")).toHaveLength(0);
        expect(service.store.list("usage")).toHaveLength(0);
        await writeFile(path.join(f.directory, "failure"), "");
        const failed = (await service.command({
          type: "provider-allowance-refresh",
          id: f.installation.id,
        })) as AllowanceSnapshot;
        expect(failed.buckets).toEqual(first.buckets);
        expect(failed.readAt).toBe(first.readAt);
        expect(failed.lastError?.detail).toContain("could not load usage");
        expect(JSON.stringify(failed)).not.toContain("private-body");
        expect(allowanceStatus("claude", [failed], Date.now()).label).toBe(
          "Refresh failed · older values",
        );
        await rm(path.join(f.directory, "failure"));
        await writeFile(path.join(f.directory, "change-account"), "");
        const changed = (await service.command({
          type: "provider-allowance-refresh",
          id: f.installation.id,
        })) as AllowanceSnapshot;
        expect(changed.buckets).toEqual(first.buckets);
        expect(changed.lastError?.detail).toContain("account changed");
      } finally {
        await service.close();
        await rm(f.directory, { recursive: true, force: true });
      }
    });
    test("concurrent refreshes share one process; sign-out and executable trust block reading", async () => {
      const f = await setup(),
        runtime = new RuntimeManager(
          f.store,
          () => {},
          () => {},
        );
      try {
        const first = runtime.refreshAllowance(f.installation);
        expect(runtime.refreshAllowance(f.installation)).toBe(first);
        expect(runtime.isUnitBusy(f.installation.managementUnitId)).toBe(true);
        await first;
        expect(runtime.isUnitBusy(f.installation.managementUnitId)).toBe(false);
        expect(
          await readFile(path.join(f.directory, "usage-starts"), "utf8"),
        ).toBe("start\n");
        await expect(
          runtime.refreshAllowance({ ...f.installation, trusted: false }),
        ).rejects.toThrow("trust this executable");
        await writeFile(path.join(f.directory, "signed-out"), "");
        await expect(runtime.refreshAllowance(f.installation)).rejects.toThrow(
          "subscription account is unavailable",
        );
        expect(
          await readFile(path.join(f.directory, "usage-starts"), "utf8"),
        ).toBe("start\n");
      } finally {
        await runtime.close();
        f.store.close();
        await rm(f.directory, { recursive: true, force: true });
      }
    });
  },
);

test.skipIf(process.platform === "win32")(
  "shutdown cancels a native usage read without writing after closing",
  async () => {
    const f = await setup(),
      runtime = new RuntimeManager(
        f.store,
        () => {},
        () => {},
      );
    try {
      await writeFile(path.join(f.directory, "silent"), "");
      const reading = runtime.refreshAllowance(f.installation);
      const outcome = expect(reading).rejects.toThrow("cancelled");
      // The account read and terminal start take about a second on their own.
      await expect
        .poll(
          async () =>
            access(path.join(f.directory, "usage-starts")).then(
              () => true,
              () => false,
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      await runtime.close();
      await outcome;
      expect(f.store.list("allowance-snapshot")).toHaveLength(0);
    } finally {
      await runtime.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
