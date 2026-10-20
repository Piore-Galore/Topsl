import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  claudeRouteConfirmation,
  claudeRouteDecision,
  claudeRoutePreferenceId,
} from "../packages/domain/claude-route";
import { readClaudeAccount } from "../packages/providers/claude-allowance";
import type { ProviderAccount } from "../packages/providers/contract";
import type { Store } from "../packages/persistence/store";
import {
  ClaudeAdapter,
  claudeArguments,
  claudeEditTools,
  claudeToolMethod,
} from "../packages/providers/claude";
import { ClaudeToolServer } from "../packages/providers/claude-tools";
import { candidateToolset } from "../packages/context/candidate-tools";
import { claudeQualificationSuite } from "../packages/providers/claude-qualification";
import { RuntimeManager } from "../packages/runtime/manager";
import { Service } from "../apps/service/service";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { hash, now, stable } from "../packages/domain/invariants";
import type { ExecutionPurpose } from "../packages/domain/role-groups";
import type { Message, Run } from "../packages/domain/types";
import { fixture } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const standIn = path.resolve("tests/fixtures/claude-qualify.cjs");

/** Qualifications refuse the temporary directory, so each test gets a folder
 * under the repository's cache. */
async function qualificationParent() {
  const cache = path.resolve("node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const parent = await mkdtemp(path.join(cache, "topsl-qualify-claude-"));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

const windows = process.platform === "win32";

/** Reads `A=1 B=2 ` (the POSIX wrapper's variable prefix) as variables. */
function variables(env: string): Record<string, string> {
  return Object.fromEntries(
    env
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
}

/**
 * Windows only: the stand-in's `auth status --json`, run through Node's own
 * executable, mapped as readClaudeAccount maps a claude.ai login. Topsl's
 * account reader launches the selected executable with execFile and no
 * shell, so on Windows it can launch only a native .exe: a `#!/bin/sh`
 * wrapper is not a Win32 program, and Node refuses .cmd/.bat files without a
 * shell (EINVAL); the broker's preflight refuses .cmd paths anyway. The
 * repository has no .exe stand-in, so on Windows this test double replaces
 * the native account read, and the launch failure itself is diagnosed in
 * "Claude account read diagnostics" below. Its errors name the launch,
 * response or sign-in cause for the test log; Topsl's own message is
 * asserted separately. Unverified on Windows by the 2026-10-19 campaign.
 */
function standInAccount(env: Record<string, string>): Promise<ProviderAccount> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [standIn, "auth", "status", "--json"],
      {
        env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", ...env }),
        windowsHide: true,
        timeout: 10_000,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error)
          return reject(
            new Error(`Stand-in account read did not launch or exit cleanly: ${error.code ?? error.message}`),
          );
        let account: any;
        try {
          account = JSON.parse(stdout);
        } catch {
          return reject(new Error("Stand-in account read returned malformed JSON."));
        }
        if (account?.loggedIn !== true || account.authMethod !== "claude.ai")
          return reject(new Error("Stand-in account read reported no claude.ai login."));
        resolve({
          accountKey: hash(stable(["claude.ai", account.email, account.orgId ?? null])),
          profileId: hash(path.join(os.homedir(), ".claude")),
          billingRoute: "native-subscription",
          sanitized: {
            type: "claude.ai",
            email: null,
            planType: account.subscriptionType ?? null,
          },
        });
      },
    );
  });
}

/** Windows only: the manager's Claude adapter, with the stand-in started
 * through Node (no shell wrapper) and the account read above. The route
 * decision is read from the store on every use, as the manager's own
 * adapter reads it. */
function windowsStandInAdapter(store: Store, env: Record<string, string>) {
  return new ClaudeAdapter(undefined, undefined, {
    routeAllowed: () =>
      claudeRouteDecision(store.get("preference", claudeRoutePreferenceId)).enabled,
    transport: (_executable, args, cwd) =>
      spawn(process.execPath, [standIn, ...args], {
        cwd,
        shell: false,
        env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", ...env }),
      }),
    readAccount: () => standInAccount(env),
  });
}

/** A trusted "Claude Code" executable that runs the stand-in, with a
 * production runtime manager (no injected fixture) over it. On macOS and
 * Linux the executable is a shell wrapper Topsl launches itself. On Windows
 * the file only carries the installation's identity: the manager's Claude
 * adapter is replaced by windowsStandInAdapter, which starts the stand-in
 * without a shell wrapper. */
async function launched(env = "") {
  const f = await fixture();
  await writeFile(
    f.installation.path,
    windows
      ? "Topsl test stand-in identity; never launched on Windows.\n"
      : `#!/bin/sh\n${env}ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)} "$@"\n`,
  );
  await chmod(f.installation.path, 0o700);
  const installation = {
    ...f.installation,
    appId: "anthropic.claude-code-cli" as const,
    ...(await identity(f.installation.path)),
  };
  f.store.put("installation", installation);
  const runtime = new RuntimeManager(
    f.store,
    () => {},
    () => {},
    undefined,
    undefined,
    windows ? { claude: windowsStandInAdapter(f.store, variables(env)) } : {},
  );
  cleanup.push(async () => {
    await runtime.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const route = (enabled: boolean) =>
    f.store.put("preference", {
      id: claudeRoutePreferenceId,
      value: enabled,
      decidedAt: now(),
    });
  return { ...f, installation, runtime, route };
}
const selection = (installationId: string, model = "claude-fixture-5") => ({
  installationId,
  provider: "claude" as const,
  model,
});
const codes = (
  f: Awaited<ReturnType<typeof launched>>,
  purpose: ExecutionPurpose,
  model?: string,
) =>
  f.runtime
    .purposeReadiness(
      f.installation,
      selection(f.installation.id, model),
      purpose,
    )
    .blockers.map((b) => b.code);
const byName = (report: { observations: any[] }) =>
  Object.fromEntries(report.observations.map((o) => [o.capability, o]));

describe("the owner's Claude route decision", () => {
  test("it is off until stored on, and its confirmation says what it means", () => {
    expect(claudeRouteDecision(undefined)).toEqual({
      enabled: false,
      decidedAt: null,
    });
    expect(claudeRouteDecision({ value: "yes" }).enabled).toBe(false);
    expect(
      claudeRouteDecision({ value: true, decidedAt: "2026-10-19T10:00:00Z" }),
    ).toEqual({ enabled: true, decidedAt: "2026-10-19T10:00:00Z" });
    const text = claudeRouteConfirmation();
    expect(text.message).toMatch(/unattended/);
    expect(text.detail).toMatch(/your own Claude Code login/);
    expect(text.detail).toMatch(/subscription usage/);
    expect(text.detail).toMatch(/not operating-system filesystem isolation/);
    expect(text.detail).toMatch(/does not make any Claude runtime ready/);
  });

  test("turning it on takes the owner's confirmation in Topsl's dialog, and is recorded with its time", async () => {
    const f = await fixture();
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    await service.start();
    expect(service.state().claudeStructuredRoute).toEqual({
      enabled: false,
      decidedAt: null,
    });
    for (const trusted of [
      {},
      { approved: true },
      { confirmedTranscriptRead: true },
    ])
      await expect(
        service.command(
          { type: "claude-structured-route-set", enabled: true },
          trusted,
        ),
      ).rejects.toThrow(
        "Turning on Claude Code's structured route needs your confirmation in Topsl's own dialog.",
      );
    expect(service.state().claudeStructuredRoute.enabled).toBe(false);
    const on = await service.command(
      { type: "claude-structured-route-set", enabled: true },
      { confirmedClaudeRoute: true },
    );
    expect(on.enabled).toBe(true);
    expect(Date.parse(on.decidedAt)).toBeGreaterThan(0);
    expect(service.state().claudeStructuredRoute).toEqual(on);
    const off = await service.command({
      type: "claude-structured-route-set",
      enabled: false,
    });
    expect(off.enabled).toBe(false);
    expect(
      service.store.db
        .prepare(
          "SELECT body FROM events WHERE kind = 'claude-structured-route.set'",
        )
        .all()
        .map((row: any) => JSON.parse(row.body).enabled),
    ).toEqual([true, false]);
  });
});

describe("Claude Code's live route", () => {
  test("while the route is off, nothing is spawned; while it is on, the trusted executable is", async () => {
    let enabled = false,
      spawned: string[][] = [];
    const adapter = new ClaudeAdapter(undefined, undefined, {
      routeAllowed: () => enabled,
      transport: (executable, args, cwd) => {
        spawned.push([executable, ...args]);
        return spawn(process.execPath, [standIn, ...args], {
          cwd,
          env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
        });
      },
    });
    expect(adapter.live).toBe(false);
    expect(() => adapter.connect("/opt/claude", process.cwd())).toThrow(
      "gated",
    );
    expect(spawned).toEqual([]);
    enabled = true;
    expect(adapter.live).toBe(true);
    const connection = adapter.connect("/opt/claude", process.cwd());
    const session = await adapter.startSession(
      connection,
      turn("review", "Reply with nothing else: OK-1"),
      null,
    );
    const done = completion(connection);
    await adapter.startTurn(
      connection,
      turn("review", "Reply with nothing else: OK-1"),
      session.nativeSessionId,
    );
    expect(await done).toMatchObject({ type: "completed", failed: false });
    expect(spawned[0][0]).toBe("/opt/claude");
    expect(spawned[0]).toEqual([
      "/opt/claude",
      ...claudeArguments("claude-fixture-5", session.nativeSessionId, "review"),
    ]);
    await connection.close();
  });

  test("arguments: a plain review has no tools and safe mode; a reader session names only Topsl's tools; an edit gets file tools only", () => {
    const review = claudeArguments("m", "s", "review");
    expect(review).toContain("--safe-mode");
    expect(review[review.indexOf("--tools") + 1]).toBe("");
    expect(review[review.indexOf("--allowedTools") + 1]).toBe("");
    const reader = claudeArguments("m", "s", "review", {
      configPath: "/private/topsl/mcp.json",
      names: ["mcp__topsl_candidate__read_range"],
    });
    // Safe mode drops --mcp-config servers in Claude Code 2.1.302.
    expect(reader).not.toContain("--safe-mode");
    expect(reader[reader.indexOf("--settings") + 1]).toBe(
      '{"disableAllHooks":true}',
    );
    expect(reader[reader.indexOf("--setting-sources") + 1]).toBe("");
    expect(reader[reader.indexOf("--mcp-config") + 1]).toBe(
      "/private/topsl/mcp.json",
    );
    expect(reader).toContain("--strict-mcp-config");
    expect(reader[reader.indexOf("--tools") + 1]).toBe("");
    expect(reader[reader.indexOf("--allowedTools") + 1]).toBe(
      "mcp__topsl_candidate__read_range",
    );
    const edit = claudeArguments("m", "s", "edit");
    expect(edit[edit.indexOf("--tools") + 1]).toBe(claudeEditTools.join(","));
    // File edits are allowed only inside the working directory.
    expect(edit[edit.indexOf("--allowedTools") + 1]).toBe(
      "Read,Glob,Grep,Edit(./**)",
    );
    expect(edit.join(" ")).not.toMatch(/Bash|dangerously|bypass|fallback/);
    expect(() =>
      claudeArguments("m", "s", "edit", { configPath: "x", names: [] }),
    ).toThrow("review session");
  });

  test.each([
    ["FIXTURE_EXTRA_TOOL", "tools Topsl did not grant (Bash)"],
    ["FIXTURE_API_KEY", "not your Claude login"],
  ])(
    "a turn whose init reports %s is stopped before its reply",
    async (variable, message) => {
      const adapter = new ClaudeAdapter(undefined, undefined, {
        routeAllowed: () => true,
        transport: (_executable, args, cwd) =>
          spawn(process.execPath, [standIn, ...args], {
            cwd,
            env: nativeEnvironment({
              ELECTRON_RUN_AS_NODE: "1",
              [variable]: "1",
            }),
          }),
      });
      const connection = adapter.connect("claude", process.cwd());
      const exited = new Promise<string>((resolve) => {
        connection.onExit = resolve;
      });
      let completed = false;
      connection.onNotification = (_method, params: any) => {
        if (params.event.type === "completed") completed = true;
      };
      const session = await adapter.startSession(
        connection,
        turn("review", "x"),
        null,
      );
      await adapter.startTurn(
        connection,
        turn("review", "x"),
        session.nativeSessionId,
      );
      expect(await exited).toContain(message);
      expect(completed).toBe(false);
      await connection.close();
    },
  );
});

describe("stalled Claude Code turns", () => {
  const stalling = (env: Record<string, string>) =>
    new ClaudeAdapter(undefined, undefined, {
      routeAllowed: () => true,
      stall: { afterMessageMs: 300, silenceMs: 800, checkMs: 50 },
      transport: (_executable, args, cwd) =>
        spawn(process.execPath, [standIn, ...args], {
          cwd,
          env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", ...env }),
        }),
    });
  async function run(adapter: ClaudeAdapter) {
    const connection = adapter.connect("claude", process.cwd());
    let exited: string | null = null;
    connection.onExit = (detail) => (exited = detail);
    const session = await adapter.startSession(
      connection,
      turn("review", "Reply with nothing else: OK-2"),
      null,
    );
    const done = completion(connection),
      started = Date.now();
    await adapter.startTurn(
      connection,
      turn("review", "Reply with nothing else: OK-2"),
      session.nativeSessionId,
    );
    const result = await done;
    const lifecycle = await connection.close();
    return { result, lifecycle, exited, elapsed: Date.now() - started };
  }

  test.each([
    ["after-message", "after the model's message ended"],
    ["silent", "Claude Code wrote nothing for 1 seconds"],
  ])(
    "a turn that stalls (%s) is stopped and ends failed with the reason, not as an unknown outcome",
    async (stall, reason) => {
      const { result, lifecycle, exited, elapsed } = await run(
        stalling({ FIXTURE_STALL: stall }),
      );
      expect(result).toMatchObject({ type: "completed", failed: true });
      expect(result.detail).toContain(reason);
      expect(result.detail).toContain("stopped Claude Code");
      expect(lifecycle.state).toBe("quiescent");
      // The process exit was confirmed, so the outcome is known.
      expect(exited).toBeNull();
      expect(elapsed).toBeLessThan(5_000);
    },
  );

  test("API retry notices between messages keep a slow turn alive", async () => {
    const { result } = await run(
      stalling({
        FIXTURE_STALL: "retrying",
        FIXTURE_RETRY_MS: "100",
        FIXTURE_RETRY_FOR_MS: "700",
      }),
    );
    expect(result).toMatchObject({ type: "completed", failed: false });
    expect(result.text).toBe("OK-2");
  });
});

describe("Claude Code turns Topsl interrupts", () => {
  /** An edit turn through the runtime manager whose stand-in streams the
   * start of its message and then holds, so Topsl interrupts it mid-stream. */
  async function held(env: Record<string, string> = {}) {
    const f = await fixture();
    const runtime = new RuntimeManager(
      f.store,
      () => {},
      () => {},
      () => {
        throw new Error("no Codex process in this test");
      },
      undefined,
      {
        claude: new ClaudeAdapter((args, cwd) =>
          spawn(process.execPath, [standIn, ...args], {
            cwd,
            shell: false,
            env: nativeEnvironment({
              ELECTRON_RUN_AS_NODE: "1",
              FIXTURE_HOLD: "1",
              ...env,
            }),
            detached: !windows,
          }),
        ),
      },
    );
    cleanup.push(async () => {
      await runtime.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const installation = {
      ...f.installation,
      id: "claude",
      appId: "anthropic.claude-code-cli" as const,
    };
    const project = {
      id: "p",
      name: "fixture",
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    };
    f.store.put("installation", installation);
    f.store.put("project", project);
    // Each writer in the folder is a fresh Claude session.
    let chats = 0;
    const start = () => {
      const conversation = {
        id: `c-${++chats}`,
        projectId: "p",
        title: "Claude chat",
        nativeSessions: {},
        createdAt: now(),
      };
      f.store.put("conversation", conversation);
      return runtime.start(
        installation,
        conversation,
        project,
        "Reply with nothing else: OK-2",
        "claude-fixture-5",
        "edit",
      );
    };
    const run = await start();
    // The partial message has arrived; the turn has not ended.
    await vi.waitFor(() =>
      expect(
        f.store
          .list<Message>("message")
          .some((m) => m.runId === run.id && m.text === "OK-2"),
      ).toBe(true),
    );
    expect(f.store.get<Run>("run", run.id)?.status).toBe("running");
    await runtime.interrupt(run.id);
    const leases = () => runtime.coordinator.ownership.list();
    return { f, runtime, run, leases, start };
  }

  test("a turn interrupted mid-stream whose process exits on the interrupt ends interrupted, and its workspace is released", async () => {
    const { f, runtime, run, leases, start } = await held();
    await vi.waitFor(() =>
      expect(leases().every((l) => l.state === "released")).toBe(true),
    );
    expect(f.store.get<Run>("run", run.id)).toMatchObject({
      status: "interrupted",
      error:
        "Topsl interrupted the turn and Claude Code exited on the interrupt.",
    });
    expect(runtime.coordinator.attemptForRun(run.id)?.state).toBe(
      "interrupted",
    );
    expect(
      f.store.get<any>("task-process-lifecycle", run.id),
    ).toMatchObject({ state: "quiescent", remainingGroup: "absent" });
    // No reconciliation is needed before another writer starts there.
    const next = await start();
    await runtime.interrupt(next.id);
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", next.id)?.status).toBe("interrupted"),
    );
  });

  test.skipIf(windows)(
    "a turn whose process ignores the interrupt and exits by itself stays uncertain, and its workspace stays held",
    async () => {
      const { f, run, leases, start } = await held({ FIXTURE_SIGINT: "ignore" });
      await vi.waitFor(() =>
        expect(f.store.get<any>("task-process-lifecycle", run.id)).toBeTruthy(),
      );
      const ended = f.store.get<Run>("run", run.id)!;
      expect(ended.status).toBe("uncertain");
      expect(ended.error).toContain("did not exit on the interrupt");
      expect(ended.error).toContain("exit code 0");
      expect(leases().map((l) => l.state)).toEqual(["uncertain"]);
      await expect(start()).rejects.toThrow(/uncertain/);
    },
  );
});

describe("Topsl's MCP server for Claude Code", () => {
  test("it answers only its own path and token, lists the toolset and routes calls; closed, it serves nothing", async () => {
    const calls: any[] = [];
    const server = new ClaudeToolServer(candidateToolset, async (request) => {
      calls.push(request);
      return { content: [{ type: "text", text: "answer" }], isError: false };
    });
    // Closed even when an assertion below fails; close() is idempotent.
    cleanup.push(() => server.close());
    const file = await server.start();
    const config = JSON.parse(readFileSync(file, "utf8")).mcpServers
      .topsl_candidate;
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]+$/);
    const post = (body: unknown, headers = config.headers, url = config.url) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect(
      (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {})).status,
    ).toBe(404);
    expect(
      (
        await post(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { Authorization: "Bearer wrong" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          config.headers,
          config.url.replace(/[a-f0-9]+$/, "0"),
        )
      ).status,
    ).toBe(404);
    const init = await (
      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      })
    ).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(
      (await post({ jsonrpc: "2.0", method: "notifications/initialized" }))
        .status,
    ).toBe(202);
    const listed = await (
      await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    expect(listed.result.tools.map((t: any) => t.name)).toEqual([
      "list",
      "search",
      "read_range",
    ]);
    expect(server.allowedTools).toEqual([
      "mcp__topsl_candidate__list",
      "mcp__topsl_candidate__search",
      "mcp__topsl_candidate__read_range",
    ]);
    const called = await (
      await post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_range", arguments: { path: "a.txt" } },
      })
    ).json();
    expect(called.result).toEqual({
      content: [{ type: "text", text: "answer" }],
      isError: false,
    });
    expect(calls).toEqual([
      { requestId: "mcp-1", tool: "read_range", arguments: { path: "a.txt" } },
    ]);
    await server.close();
    expect(existsSync(file)).toBe(false);
    await expect(
      post({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    ).rejects.toThrow();
  });

  test("its configuration file, which holds the bearer token, is private to the owner and is removed with its folder on close", async () => {
    const server = new ClaudeToolServer(candidateToolset, async () => ({
      content: [],
      isError: false,
    }));
    cleanup.push(() => server.close());
    const file = await server.start();
    const folder = path.dirname(file);
    // A fresh folder of its own, holding only the configuration.
    expect(path.basename(folder)).toMatch(/^topsl-claude-mcp-/);
    expect(readdirSync(folder)).toEqual(["mcp.json"]);
    const config = JSON.parse(readFileSync(file, "utf8")).mcpServers
      .topsl_candidate;
    expect(config.headers.Authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
    // The token is not in the route Claude Code is given on its command line.
    expect(config.url).not.toContain(config.headers.Authorization.slice(7));
    if (windows) {
      // Mode bits do not describe Windows access. Read the file's effective
      // access rules as security identifiers (locale-independent): the
      // current user may read it, and no rule allows Everyone, Authenticated
      // Users, Users, Guests or Anonymous. Unverified by the 2026-10-19
      // campaign, which had no Windows host.
      const access = windowsAccess(file);
      expect(
        access.rules.some((r) => r.sid === access.user && r.type === "Allow"),
      ).toBe(true);
      expect(
        access.rules.filter(
          (r) => r.type === "Allow" && broadWindowsGroups.includes(r.sid),
        ),
      ).toEqual([]);
    } else {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(file).uid).toBe(process.getuid!());
    }
    await server.close();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    await server.close();
  });

  test("a call reaches the runtime's request handler with the session's thread and turn, and a call outside a turn is refused", async () => {
    const adapter = new ClaudeAdapter(undefined, undefined, {
      routeAllowed: () => true,
      transport: (_executable, args, cwd) =>
        spawn(process.execPath, [standIn, ...args], {
          cwd,
          env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
        }),
    });
    const connection = adapter.connect("claude", process.cwd());
    const requests: any[] = [];
    connection.onRequest = (id, method, params) => {
      requests.push({ method, params });
      const call = adapter.toolCall(method, params)!;
      connection.reply(
        id,
        adapter.toolResult({
          text: JSON.stringify({
            content: `read ${String((call.arguments as any).path)}\n`,
          }),
          success: true,
        }),
      );
    };
    const prepared = {
      ...turn("review", 'Call read_range with path "file.txt".'),
      toolset: candidateToolset,
    };
    const session = await adapter.startSession(connection, prepared, null);
    const done = completion(connection);
    const started = await adapter.startTurn(
      connection,
      prepared,
      session.nativeSessionId,
    );
    const result = await done;
    expect(result.text).toBe("read file.txt");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe(claudeToolMethod);
    expect(
      adapter.toolCall(requests[0].method, requests[0].params),
    ).toMatchObject({
      threadId: session.nativeSessionId,
      turnId: started.nativeTurnId,
      namespace: "topsl_candidate",
      tool: "read_range",
      arguments: { path: "file.txt" },
    });
    await connection.close();
  });
});

describe("Claude account read diagnostics", () => {
  /** How a launch of `executable` the way readClaudeAccount launches it (no
   * shell) failed, for the test log: a spawn error code, or null. */
  const launchCause = (executable: string) =>
    new Promise<string | null>((resolve) => {
      // Some launch refusals (Node's EINVAL for a .cmd/.bat without a shell
      // on Windows) are thrown synchronously by execFile, not passed to the
      // callback; report those the same way.
      try {
        execFile(
          executable,
          ["auth", "status", "--json"],
          { env: nativeEnvironment(), windowsHide: true, timeout: 10_000 },
          (error) =>
            resolve(error ? String((error as any).code ?? error.message) : null),
        );
      } catch (error) {
        resolve(String((error as any).code ?? (error as Error).message));
      }
    });
  const unreadable =
    "Claude account status could not be read. Sign in through Claude Code and retry.";
  const unavailable =
    "Claude subscription account is unavailable. Sign in through Claude Code with your subscription and retry.";

  test("a launch failure gives Topsl's sanitized message, while the fixture names the launch cause", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-claude-account-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const missing = path.join(directory, "missing-claude");
    await expect(
      readClaudeAccount(missing, AbortSignal.timeout(15_000)),
    ).rejects.toThrow(unreadable);
    expect(await launchCause(missing)).toBe("ENOENT");
    // The shell wrapper this test file used to write on every platform.
    const wrapper = path.join(directory, windows ? "claude-wrapper" : "claude-not-executable");
    await writeFile(
      wrapper,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)} "$@"\n`,
      { mode: 0o600 },
    );
    await expect(
      readClaudeAccount(wrapper, AbortSignal.timeout(15_000)),
    ).rejects.toThrow(unreadable);
    // POSIX: not executable (EACCES). Windows: not a Win32 program; the
    // exact code is unverified by the 2026-10-19 campaign.
    const cause = await launchCause(wrapper);
    expect(cause).toBeTruthy();
    if (!windows) expect(cause).toBe("EACCES");
  });

  // On Windows Node refuses to launch a .cmd/.bat without a shell by
  // throwing "spawn EINVAL" synchronously from execFile (CVE-2024-27980
  // hardening); readClaudeAccount sanitizes that throw too. On POSIX the same
  // file is merely not executable (EACCES through the callback).
  test(
    "a .cmd file, which Node will not launch without a shell, gives Topsl's sanitized message",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-claude-account-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const cmd = path.join(directory, "claude.cmd");
      await writeFile(cmd, "@echo {}\r\n");
      // Precondition: the launch itself is refused.
      expect(await launchCause(cmd)).toBeTruthy();
      await expect(
        readClaudeAccount(cmd, AbortSignal.timeout(15_000)),
      ).rejects.toThrow(unreadable);
    },
  );

  test.skipIf(windows)(
    "a malformed response, a signed-out or API-key account and a failing command are distinguished from a launch failure; nothing raw is returned",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-claude-account-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const script = async (name: string, body: string) => {
        const file = path.join(directory, name);
        await writeFile(file, `#!/bin/sh\n${body}\n`);
        await chmod(file, 0o700);
        expect(await launchCause(file), name).toBeNull();
        return file;
      };
      const read = (file: string) =>
        readClaudeAccount(file, AbortSignal.timeout(15_000));
      await expect(read(await script("malformed", "printf 'not json'"))).rejects.toThrow(unavailable);
      await expect(
        read(await script("signed-out", `printf '%s' '{"loggedIn":false}'`)),
      ).rejects.toThrow(unavailable);
      await expect(
        read(
          await script(
            "api-key",
            `printf '%s' '{"loggedIn":true,"authMethod":"api_key","email":"x@example.test"}'`,
          ),
        ),
      ).rejects.toThrow(unavailable);
      // A command that runs but fails reads as unreadable, without its stderr.
      const failing = path.join(directory, "failing");
      await writeFile(failing, "#!/bin/sh\necho secret-canary >&2\nexit 3\n");
      await chmod(failing, 0o700);
      const error = await read(failing).catch((e: Error) => e);
      expect(String(error)).toContain(unreadable);
      expect(String(error)).not.toContain("secret-canary");
      // Positive control: the stand-in's claude.ai login, with no email kept.
      const account = await read(
        await script(
          "stand-in",
          `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)} "$@"`,
        ),
      );
      expect(account).toMatchObject({
        billingRoute: "native-subscription",
        sanitized: { type: "claude.ai", email: null, planType: "max" },
      });
      expect(JSON.stringify(account)).not.toContain("owner@example.test");
    },
  );
});

describe("Claude runtime qualification through the runtime manager", () => {
  test("refused while the route is off; connect reads the account; each purpose waits for a qualification", async () => {
    const f = await launched();
    await expect(
      f.runtime.qualify(
        f.installation,
        { model: "claude-fixture-5" },
        await qualificationParent(),
      ),
    ).rejects.toThrow("structured route is off");
    await expect(f.runtime.inspect(f.installation)).rejects.toThrow(
      "structured route is off",
    );
    expect(codes(f, "coordinator-contribution")).toContain(
      "authentication-route-unapproved",
    );
    f.route(true);
    const inspected = await f.runtime.inspect(f.installation);
    expect(inspected.account).toEqual({
      type: "claude.ai",
      email: null,
      planType: "max",
    });
    expect(inspected.models).toEqual([]);
    expect(codes(f, "coordinator-contribution")).toEqual(
      expect.arrayContaining([
        "claude-route-unqualified",
        "unsupported-model-setting",
      ]),
    );
    expect(codes(f, "coordinator-contribution")).not.toContain(
      "authentication-route-unapproved",
    );
    await expect(
      f.runtime.qualify(
        f.installation,
        { model: "claude-fixture-5", effort: "high" },
        await qualificationParent(),
      ),
    ).rejects.toThrow("no reasoning effort");
    await expect(
      f.runtime.qualify(
        f.installation,
        { model: "opus; rm -rf" },
        await qualificationParent(),
      ),
    ).rejects.toThrow("full id");
  });

  test.skipIf(process.platform === "win32")(
    "a passing qualification makes every purpose it observed ready, including candidate review through the reader",
    async () => {
      const f = await launched();
      f.route(true);
      await f.runtime.inspect(f.installation);
      f.store.put("installation", {
        ...f.installation,
        compatibility: "compatible",
      });
      const result = await f.runtime.qualify(
        f.installation,
        { model: "claude-fixture-5" },
        await qualificationParent(),
      );
      expect(result.report.suite).toBe(claudeQualificationSuite);
      expect(result.report.turnsStarted).toBe(4);
      expect(result.report.error).toBeNull();
      expect(result.report.reportedModel).toBe("claude-fixture-5");
      const observed = byName(result.report);
      for (const capability of [
        "native-subscription",
        "structured-turn",
        "read-only",
        "workspace-write",
        "candidate-reader",
        "fresh-session",
        "process-lifecycle",
      ])
        expect(observed[capability], capability).toMatchObject({
          passed: true,
        });
      expect(observed["read-only"].meaning).toBe("policy-enforced");
      expect(observed["workspace-write"]).toMatchObject({
        meaning: "policy-enforced",
        negativeControl: {
          operationAttempted: true,
          trustedStateChecked: true,
          denied: true,
        },
      });
      expect(observed["workspace-write"].detail).toMatch(
        /not operating-system isolation/,
      );
      expect(observed["candidate-reader"].detail).toMatch(/connected/);
      expect(result.report.notTested.map((n) => n.capability)).toEqual([
        "interrupt",
      ]);
      expect(result.acceptanceId).toBeTruthy();
      expect(JSON.stringify(result.report)).not.toContain("owner@example.test");
      for (const purpose of [
        "coordinator-contribution",
        "coordinator-endorsement",
        "information",
        "candidate-review",
        "implementation",
      ] as const)
        expect(codes(f, purpose), purpose).toEqual([]);
      // Only the model Claude Code reported is in the catalog.
      expect(codes(f, "implementation", "claude-other-5")).toEqual([
        "unsupported-model-setting",
      ]);
      // Turning the route off blocks every purpose again.
      f.route(false);
      expect(codes(f, "implementation")).toEqual([
        "authentication-route-unapproved",
      ]);
    },
  );

  test.skipIf(process.platform === "win32").each([
    [
      "FIXTURE_READER=skip ",
      "candidate-reader",
      { "candidate-review": ["candidate-reader-unavailable"] },
    ],
    [
      "FIXTURE_WRITE=skip-outside ",
      "workspace-write",
      { implementation: ["permission-profile-unverified"] },
    ],
    [
      "FIXTURE_WRITE=escape ",
      "workspace-write",
      { implementation: ["permission-profile-unverified"] },
    ],
    [
      "FIXTURE_READONLY=broken ",
      "read-only",
      {
        "candidate-review": ["permission-profile-unverified"],
        "coordinator-contribution": ["permission-profile-unverified"],
      },
    ],
  ])(
    "with %s, %s does not pass and only the purposes needing it stay blocked",
    async (env, capability, blocked) => {
      const f = await launched(env);
      f.route(true);
      await f.runtime.inspect(f.installation);
      const result = await f.runtime.qualify(
        f.installation,
        { model: "claude-fixture-5" },
        await qualificationParent(),
      );
      expect(byName(result.report)[capability].passed).toBe(false);
      for (const purpose of [
        "coordinator-contribution",
        "candidate-review",
        "implementation",
      ] as const)
        expect(codes(f, purpose), purpose).toEqual(
          (blocked as Record<string, string[]>)[purpose] ?? [],
        );
    },
  );

  test.skipIf(process.platform === "win32")(
    "a model Claude Code reports differently never enters the catalog",
    async () => {
      const f = await launched("FIXTURE_MODEL=claude-fixture-5-20261001 ");
      f.route(true);
      await f.runtime.inspect(f.installation);
      const result = await f.runtime.qualify(
        f.installation,
        { model: "claude-fixture-5" },
        await qualificationParent(),
      );
      expect(result.report.reportedModel).toBe("claude-fixture-5-20261001");
      expect(byName(result.report)["structured-turn"].detail).toContain(
        "reported model claude-fixture-5-20261001 for the request claude-fixture-5",
      );
      expect(codes(f, "coordinator-contribution")).toEqual([
        "unsupported-model-setting",
      ]);
    },
  );
});

function turn(mode: "review" | "edit", prompt: string) {
  return {
    prompt,
    cwd: process.cwd(),
    requestedModel: "claude-fixture-5",
    mode,
    contextPackageId: null,
    attemptId: "attempt",
    workspaceIdentity: "workspace",
  };
}
function completion(connection: { onNotification: any }) {
  return new Promise<any>((resolve) => {
    connection.onNotification = (_method: string, params: any) => {
      if (params.event.type === "completed") resolve(params.event);
    };
  });
}

/** Everyone, Authenticated Users, Users, Guests and Anonymous Logon. */
const broadWindowsGroups = [
  "S-1-1-0",
  "S-1-5-11",
  "S-1-5-32-545",
  "S-1-5-32-546",
  "S-1-5-7",
];
/** The current user's security identifier and a file's access rules
 * (explicit and inherited), read in Windows PowerShell 5.1 through .NET's
 * FileSecurity. Windows CI run 39271847356 (2026-10-19) showed Get-Acl
 * failing with "the module could not be loaded": the runner's PowerShell 7
 * parent exports a PSModulePath that Windows PowerShell 5.1 cannot load
 * modules from. So the script uses no module cmdlets (no Get-Acl,
 * ConvertTo-Json or New-Object), prints plain "user"/"rule" lines, and the
 * child gets the environment without PSModulePath. Windows only. */
function windowsAccess(file: string): {
  user: string;
  rules: Array<{ sid: string; type: string }>;
} {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$acl = [System.Security.AccessControl.FileSecurity]::new($env:TOPSL_ACL_PATH, [System.Security.AccessControl.AccessControlSections]::Access)",
    "'user ' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { 'rule ' + $r.IdentityReference.Value + ' ' + [string]$r.AccessControlType }",
  ].join("; ");
  const env: NodeJS.ProcessEnv = { TOPSL_ACL_PATH: file };
  for (const [key, value] of Object.entries(process.env))
    if (!/^(psmodulepath|topsl_acl_path)$/i.test(key)) env[key] = value;
  const output = execFileSync(
    path.join(
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env, encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  const lines = output
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const user = lines.find((line) => line.startsWith("user "))?.slice(5) ?? "";
  if (!user)
    throw new Error(`Windows access rules could not be read: ${output}`);
  return {
    user,
    rules: lines
      .filter((line) => line.startsWith("rule "))
      .map((line) => {
        const [, sid, type] = line.split(" ");
        return { sid, type };
      }),
  };
}
