/**
 * Campaign 2026-10-19-comprehensive, packet p3b-claude-codex-qualification:
 * Claude structured execution, stall recovery and Claude qualification
 * (plan section 5.14, CL-01..CL-18, and journey J-08 at the stand-in layer).
 *
 * The stall-clock tests drive the production ClaudeAdapter.start() with a
 * synchronous fake child process and Vitest fake timers, so the real default
 * limits (180,000 ms after message stop, 600,000 ms parsed-record silence,
 * 5,000 ms poll) are exercised at exact boundaries without waiting. The
 * process-lifecycle tests use real subprocesses in their own POSIX process
 * group, as the production transport starts Claude Code. No model, account
 * or native Claude Code runs here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  ClaudeAdapter,
  claudeStallLimits,
  type ClaudeStreamEvent,
} from "../packages/providers/claude";
import { candidateToolset } from "../packages/context/candidate-tools";
import { runClaudeQualification } from "../packages/providers/claude-qualification";
import {
  RuntimeAcceptanceRegistry,
  type RuntimeProbeObservation,
} from "../packages/providers/acceptance";
import { runtimeBinding } from "../packages/providers/runtime-binding";
import { RuntimeManager } from "../packages/runtime/manager";
import { claudeRoutePreferenceId } from "../packages/domain/claude-route";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { now, uid } from "../packages/domain/invariants";
import type { ExecutionPurpose } from "../packages/domain/role-groups";
import { fixture } from "./helpers";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const standIn = path.resolve("tests/fixtures/claude-qualify.cjs");
const posix = process.platform !== "win32";

// ---------------------------------------------------------------------------
// Synchronous fake child for ClaudeAdapter.start(). Every write is delivered
// to the adapter's stdout handler immediately, so fake timers alone decide
// when the stall watch polls.
// ---------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  stderr = Object.assign(new EventEmitter(), { resume() {} });
  stdin = Object.assign(new EventEmitter(), { end(_prompt?: string) {} });
  pid = 424242;
  signals: string[] = [];
  exited = false;
  constructor(private exitsOn: (signal: string) => boolean) {
    super();
  }
  kill(signal: string = "SIGTERM") {
    this.signals.push(signal);
    if (this.exitsOn(signal)) this.exit(null, signal);
    return true;
  }
  exit(code: number | null, signal: string | null) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  write(record: unknown) {
    this.stdout.emit(
      "data",
      typeof record === "string" ? record : JSON.stringify(record) + "\n",
    );
  }
}
const sid = "campaign-session";
const rec = {
  init: () => ({
    type: "system",
    subtype: "init",
    session_id: sid,
    model: "claude-fixture-5",
    tools: [],
    apiKeySource: "none",
    uuid: "init",
  }),
  start: (n: number) => ({
    type: "stream_event",
    session_id: sid,
    event: { type: "message_start", message: { id: `m-${n}` } },
    uuid: `start-${n}`,
  }),
  stop: (n: number) => ({
    type: "stream_event",
    session_id: sid,
    event: { type: "message_stop" },
    uuid: `stop-${n}`,
  }),
  retry: (n: number) => ({
    type: "system",
    subtype: "api_retry",
    attempt: n,
    session_id: sid,
    uuid: `retry-${n}`,
  }),
  /** An ordinary informational record: progress for the silence clock only. */
  rateLimit: (n: number) => ({
    type: "rate_limit_event",
    session_id: sid,
    uuid: `rate-${n}`,
  }),
  /** A streamed text delta without a uuid, so the parser's identity map
   * does not grow with it. */
  delta: (text: string) => ({
    type: "stream_event",
    session_id: sid,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  }),
  result: (text = "OK") => ({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sid,
    result: text,
    uuid: "result",
  }),
};
function harness(
  options: {
    exitsOn?: (signal: string) => boolean;
    stall?: Partial<typeof claudeStallLimits>;
  } = {},
) {
  const child = new FakeChild(options.exitsOn ?? (() => true));
  const adapter = new ClaudeAdapter(
    () => child as any,
    undefined,
    options.stall ? { stall: options.stall } : {},
  );
  const events: ClaudeStreamEvent[] = [];
  const t0 = Date.now();
  const run = adapter.start(
    {
      executable: "claude",
      cwd: process.cwd(),
      model: "claude-fixture-5",
      sessionId: sid,
      mode: "review",
      prompt: "campaign",
    },
    (event) => events.push(event),
  );
  let settled: { ok: boolean; error: string | null } | null = null;
  run.done.then(
    () => (settled = { ok: true, error: null }),
    (e: Error) => (settled = { ok: false, error: e.message }),
  );
  return {
    child,
    events,
    run,
    /** Milliseconds since start on the fake clock. */
    at: () => Date.now() - t0,
    /** Advances the fake clock to `ms` after start, running due polls. */
    to: (ms: number) => vi.advanceTimersByTime(ms - (Date.now() - t0)),
    completed: () =>
      events.filter(
        (e): e is Extract<ClaudeStreamEvent, { type: "completed" }> =>
          e.type === "completed",
      ),
    settled: () => settled,
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("CL-09/10/11/14/16 stall clocks at the production defaults (fake clock)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the defaults are the documented 180,000 / 600,000 / 5,000 ms", () => {
    expect(claudeStallLimits).toEqual({
      afterMessageMs: 180_000,
      silenceMs: 600_000,
      checkMs: 5_000,
    });
  });

  test("CL-09: exactly 180,000 ms after message stop is not a stall; the first poll strictly above it is", async () => {
    const h = harness();
    h.child.write(rec.init());
    h.child.write(rec.start(1));
    h.child.write(rec.stop(1));
    h.to(180_000);
    // Equality boundary: the poll at 180,000 ms sees exactly the limit.
    expect(h.child.signals).toEqual([]);
    expect(h.completed()).toEqual([]);
    h.to(184_999);
    expect(h.child.signals).toEqual([]);
    h.to(185_000);
    expect(h.child.signals).toEqual(["SIGTERM"]);
    await flush();
    const done = h.completed();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      sourceId: "topsl-stall",
      failed: true,
      sessionId: sid,
    });
    expect(done[0].detail).toBe(
      "Claude Code wrote nothing for 3 minutes after the model's message ended, so Topsl treated the turn as stalled, stopped Claude Code and recorded the turn as failed.",
    );
    // The process exit was observed, so the turn is a known failure.
    expect(h.settled()).toEqual({ ok: true, error: null });
  });

  test("CL-09: a message stop between polls fails at the first poll above 180,000 ms after it, not at a fixed wall time", async () => {
    for (const [stopAt, quietUntil, failsAt] of [
      [2_500, 180_000, 185_000],
      [5_000, 185_000, 190_000],
      [7_499, 185_000, 190_000],
    ]) {
      const h = harness();
      h.child.write(rec.init());
      h.child.write(rec.start(1));
      h.to(stopAt);
      h.child.write(rec.stop(1));
      h.to(quietUntil);
      expect(h.child.signals, `stop at ${stopAt}`).toEqual([]);
      h.to(failsAt);
      expect(h.child.signals, `stop at ${stopAt}`).toEqual(["SIGTERM"]);
      await flush();
      expect(h.completed()[0].detail).toContain(
        "after the model's message ended",
      );
    }
  });

  test("CL-10: 600,000 ms with no parsed record is not a stall; the first poll above it is", async () => {
    const h = harness();
    h.child.write(rec.init());
    h.to(600_000);
    expect(h.child.signals).toEqual([]);
    h.to(604_999);
    expect(h.child.signals).toEqual([]);
    h.to(605_000);
    expect(h.child.signals).toEqual(["SIGTERM"]);
    await flush();
    expect(h.completed()).toHaveLength(1);
    expect(h.completed()[0].detail).toBe(
      "Claude Code wrote nothing for 10 minutes, so Topsl treated the turn as stalled, stopped Claude Code and recorded the turn as failed.",
    );
    // A process that wrote nothing at all is bounded the same way.
    const silent = harness();
    silent.to(605_000);
    expect(silent.child.signals).toEqual(["SIGTERM"]);
  });

  test("CL-16: raw bytes, blank lines and an incomplete NDJSON record do not reset the silence clock; completing the record does", async () => {
    // Partial record that never completes.
    const partial = harness();
    partial.child.write(rec.init());
    partial.to(300_000);
    partial.child.write('{"type":"rate_limit_event","sess');
    partial.to(550_000);
    partial.child.write('ion_id":"campaign-session"');
    partial.to(600_000);
    expect(partial.child.signals).toEqual([]);
    partial.to(605_000);
    expect(partial.child.signals).toEqual(["SIGTERM"]);
    // Blank and whitespace-only lines are bytes, not records.
    const blank = harness();
    blank.child.write(rec.init());
    blank.to(300_000);
    blank.child.write("\n\n   \n\t\n");
    blank.to(605_000);
    expect(blank.child.signals).toEqual(["SIGTERM"]);
    // Negative control: the same partial record, completed at 590,000 ms,
    // is progress at 590,000 ms (when it completed, not when it began).
    const completed = harness();
    completed.child.write(rec.init());
    completed.to(300_000);
    completed.child.write('{"type":"rate_limit_event","sess');
    completed.to(590_000);
    completed.child.write('ion_id":"campaign-session","uuid":"late"}\n');
    completed.to(1_190_000);
    expect(completed.child.signals).toEqual([]);
    completed.to(1_195_000);
    expect(completed.child.signals).toEqual(["SIGTERM"]);
    // Negative control: a complete record at 300,000 ms moves the deadline.
    const control = harness();
    control.child.write(rec.init());
    control.to(300_000);
    control.child.write(rec.rateLimit(1));
    control.to(900_000);
    expect(control.child.signals).toEqual([]);
    control.to(905_000);
    expect(control.child.signals).toEqual(["SIGTERM"]);
    await flush();
    expect(control.completed()[0].detail).toContain("wrote nothing for 10 minutes");
  });

  test("CL-16: message start or an API retry after message stop clears the post-message deadline; silence still bounds the turn", async () => {
    for (const [label, record] of [
      ["message-start", rec.start(2)],
      ["api_retry", rec.retry(1)],
    ] as const) {
      const h = harness();
      h.child.write(rec.init());
      h.child.write(rec.start(1));
      h.child.write(rec.stop(1));
      h.to(100_000);
      h.child.write(record);
      h.to(700_000);
      expect(h.child.signals, label).toEqual([]);
      h.to(705_000);
      expect(h.child.signals, label).toEqual(["SIGTERM"]);
      await flush();
      expect(h.completed()[0].detail, label).toContain(
        "wrote nothing for 10 minutes,",
      );
    }
  });

  test("CL-11: ordinary records after message stop keep the silence clock alive but do not clear the post-message deadline", async () => {
    const h = harness();
    h.child.write(rec.init());
    h.child.write(rec.start(1));
    h.child.write(rec.stop(1));
    for (let n = 1, at = 10_000; at <= 180_000; n++, at += 10_000) {
      h.to(at);
      h.child.write(rec.rateLimit(n));
    }
    expect(h.child.signals).toEqual([]);
    h.to(185_000);
    expect(h.child.signals).toEqual(["SIGTERM"]);
    await flush();
    expect(h.completed()[0].detail).toContain("after the model's message ended");
  });

  test("CL-11: an API retry 1 ms before the deadline, or after the boundary poll but before the next, prevents a false post-message stall", () => {
    const before = harness();
    before.child.write(rec.init());
    before.child.write(rec.stop(1));
    before.to(179_999);
    before.child.write(rec.retry(1));
    before.to(775_000);
    expect(before.child.signals).toEqual([]);
    // Silence is then measured from the retry at 179,999 ms.
    before.to(780_000);
    expect(before.child.signals).toEqual(["SIGTERM"]);

    const between = harness();
    between.child.write(rec.init());
    between.child.write(rec.stop(1));
    between.to(180_000);
    expect(between.child.signals).toEqual([]);
    between.to(182_000);
    between.child.write(rec.retry(1));
    between.to(185_000);
    expect(between.child.signals).toEqual([]);
  });

  test("CL-11/CL-12: a completed result cannot later stall; a result arriving after the stall kill cannot overwrite the failure", async () => {
    const finished = harness();
    finished.child.write(rec.init());
    finished.child.write(rec.start(1));
    finished.child.write(rec.stop(1));
    finished.to(1_000);
    finished.child.write(rec.result("OK"));
    finished.to(2 * 3_600_000);
    expect(finished.child.signals).toEqual([]);
    finished.child.exit(0, null);
    await flush();
    expect(finished.completed()).toHaveLength(1);
    expect(finished.completed()[0]).toMatchObject({ failed: false, text: "OK" });
    expect(finished.settled()).toEqual({ ok: true, error: null });

    // The child ignores the stall's SIGTERM for a moment and then reports
    // a success; Topsl already decided, and drops everything it writes.
    const late = harness({ exitsOn: () => false });
    late.child.write(rec.init());
    late.child.write(rec.stop(1));
    late.to(185_000);
    expect(late.child.signals).toEqual(["SIGTERM"]);
    late.to(186_000);
    late.child.write(rec.retry(1));
    late.child.write(rec.result("LATE SUCCESS"));
    expect(late.completed()).toEqual([]);
    late.child.exit(0, null);
    await flush();
    expect(late.completed()).toHaveLength(1);
    expect(late.completed()[0]).toMatchObject({
      failed: true,
      sourceId: "topsl-stall",
      text: "",
    });
    expect(late.completed()[0].detail).toContain("after the model's message ended");
  });

  test("CL-13 (adapter): a stall kill that does not end the process leaves the outcome unsettled, with no failure reported and no further signals", async () => {
    const h = harness({ exitsOn: () => false });
    h.child.write(rec.init());
    h.child.write(rec.stop(1));
    h.to(185_000);
    expect(h.child.signals).toEqual(["SIGTERM"]);
    h.to(4 * 3_600_000);
    await flush();
    // Nothing claims the turn failed or finished while the process may run.
    expect(h.completed()).toEqual([]);
    expect(h.settled()).toBeNull();
    // The stall path never escalates by itself (limitation: only Stop or
    // connection close escalates; see the real-process test below).
    expect(h.child.signals).toEqual(["SIGTERM"]);
  });

  test("CL-14: continuous valid output has no total deadline (six hours); Stop still terminates the turn", async () => {
    const h = harness();
    h.child.write(rec.init());
    h.child.write(rec.start(1));
    for (let at = 30_000; at <= 6 * 3_600_000; at += 30_000) {
      h.to(at);
      h.child.write(rec.delta("."));
    }
    expect(h.child.signals).toEqual([]);
    expect(h.events.filter((e) => e.type === "delta")).toHaveLength(720);
    h.run.interrupt();
    expect(h.child.signals).toEqual(["SIGINT"]);
    await flush();
    // The process ended on Topsl's interrupt, so the turn ends interrupted.
    expect(h.completed()).toHaveLength(1);
    expect(h.completed()[0]).toMatchObject({
      failed: true,
      interrupted: true,
      sourceId: "topsl-interrupt",
      text: "",
    });
    expect(h.settled()).toEqual({ ok: true, error: null });
  });

  test("CL-14: API retries after message stop, indefinitely (six hours), never stall the turn; Stop still terminates it", async () => {
    const h = harness();
    h.child.write(rec.init());
    h.child.write(rec.start(1));
    h.child.write(rec.stop(1));
    for (let n = 1, at = 60_000; at <= 6 * 3_600_000; n++, at += 60_000) {
      h.to(at);
      h.child.write(rec.retry(n));
    }
    expect(h.child.signals).toEqual([]);
    h.run.interrupt();
    await flush();
    expect(h.child.signals).toEqual(["SIGINT"]);
    expect(h.completed()).toMatchObject([{ interrupted: true }]);
  });

  test("CL-14/CL-16: telemetry and the partial-record buffer are bounded: 20,001 identified records or a 2 MB partial line end the turn as an unknown outcome", async () => {
    const many = harness();
    many.child.write(rec.init());
    let chunk = "";
    for (let n = 1; n <= 20_000; n++)
      chunk += JSON.stringify(rec.rateLimit(n)) + "\n";
    many.child.write(chunk);
    expect(many.child.signals).toEqual(["SIGTERM"]);
    await flush();
    expect(many.completed()).toEqual([]);
    expect(many.settled()).toEqual({
      ok: false,
      error: "Claude stream exceeds the bounded event limit.",
    });

    const long = harness();
    long.child.write(rec.init());
    long.child.write('{"type":"rate_limit_event","pad":"' + "x".repeat(2_000_001));
    expect(long.child.signals).toEqual(["SIGTERM"]);
    await flush();
    expect(long.settled()).toEqual({
      ok: false,
      error: "Claude stream record exceeds the bounded parser limit.",
    });
  });
});

// ---------------------------------------------------------------------------
// Real subprocesses in their own process group, as claudeNativeTransport
// starts Claude Code on macOS and Linux.
// ---------------------------------------------------------------------------
const streamScript = (prelude: string) => `
const fs = require("node:fs");
const argv = process.argv;
const sid = argv[argv.indexOf("--session-id") + 1];
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
${prelude}
process.stdin.resume();
process.stdin.on("end", () => {
  out({ type: "system", subtype: "init", session_id: sid, model: "claude-fixture-5", tools: [], apiKeySource: "none", uuid: "init" });
  out({ type: "stream_event", session_id: sid, event: { type: "message_start", message: { id: "m1" } }, uuid: "s0" });
  out({ type: "stream_event", session_id: sid, event: { type: "message_stop" }, uuid: "s1" });
  setInterval(() => {}, 1000);
});`;
function groupedAdapter(
  script: string,
  env: Record<string, string>,
  stall = { afterMessageMs: 300, silenceMs: 5_000, checkMs: 50 },
) {
  const spawned: number[] = [];
  const adapter = new ClaudeAdapter(undefined, undefined, {
    routeAllowed: () => true,
    stall,
    // Read only when the runtime manager starts a run over this adapter.
    readAccount: async () => ({
      accountKey: "campaign-account",
      profileId: "campaign-profile",
      billingRoute: "native-subscription",
      sanitized: { type: "claude.ai", email: null, planType: "max" },
    }),
    transport: (_executable, args, cwd) => {
      const child = spawn(process.execPath, ["-e", script, "--", ...args], {
        cwd,
        shell: false,
        env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", ...env }),
        detached: posix,
      });
      spawned.push(child.pid!);
      return child;
    },
  });
  return { adapter, spawned };
}
function prepared(prompt = "campaign") {
  return {
    prompt,
    cwd: process.cwd(),
    requestedModel: "claude-fixture-5",
    mode: "review" as const,
    contextPackageId: null,
    attemptId: "campaign-attempt",
    workspaceIdentity: "campaign-workspace",
  };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === "EPERM";
  }
};
/** Independent of Topsl's own lifecycle evidence: signal 0 to a pid, or to
 * a POSIX process group as -pgid. "alive" or the errno code (ESRCH: gone). */
const probe = (target: number) => {
  try {
    process.kill(target, 0);
    return "alive";
  } catch (error: any) {
    // EPERM means the target exists but cannot be signalled; macOS can
    // answer that for a process group whose member still runs (CI run
    // 39369761570, macOS Intel). Only ESRCH means it is gone.
    if (error.code === "EPERM") return "alive";
    return String(error.code);
  }
};
async function scratch(prefix: string) {
  const directory = await mkdtemp(path.join(path.resolve("node_modules/.cache"), prefix)).catch(
    async () => {
      await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
      return mkdtemp(path.join(path.resolve("node_modules/.cache"), prefix));
    },
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe.skipIf(!posix)("CL-13 / J-08 stall termination with real processes (POSIX process group)", () => {
  test("a Claude Code process that ignores the stall's SIGTERM is not reported failed or finished; Stop escalates and only then is the turn quiescent", async () => {
    const directory = await scratch("campaign-cl13-a-"),
      marker = path.join(directory, "sigterm");
    const { adapter, spawned } = groupedAdapter(
      streamScript(
        `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(marker)}, "SIGTERM"));`,
      ),
      {},
    );
    const connection = adapter.connect("claude", process.cwd());
    const completed: any[] = [];
    let exited: string | null = null;
    connection.onExit = (detail) => (exited = detail);
    connection.onNotification = (_m, params: any) => {
      if (params.event.type === "completed") completed.push(params.event);
    };
    cleanup.push(async () => {
      await connection.close();
    });
    const session = await adapter.startSession(connection, prepared(), null);
    await adapter.startTurn(connection, prepared(), session.nativeSessionId);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    // Give the adapter time to (wrongly) conclude anything.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(completed).toEqual([]);
    expect(exited).toBeNull();
    expect(alive(spawned[0])).toBe(true);
    // Stop: the lifecycle escalates to SIGKILL and observes the group gone.
    const started = Date.now();
    const lifecycle = await connection.close();
    expect(lifecycle.state).toBe("quiescent");
    expect(lifecycle.scope).toBe("posix-process-group");
    expect(lifecycle.signal).toBe("SIGKILL");
    expect(lifecycle.remainingGroup).toBe("absent");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(alive(spawned[0])).toBe(false);
    // After exit was confirmed the stalled turn ends failed with its reason.
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(completed[0]).toMatchObject({ failed: true });
    expect(completed[0].detail).toContain("after the model's message ended");
  });

  test("a stall kill ends the leader but cannot prove a SIGTERM-ignoring descendant stopped; quiescence comes only from the lifecycle stop", async () => {
    const directory = await scratch("campaign-cl13-b-"),
      pidFile = path.join(directory, "descendant.pid");
    const descendant = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const { adapter, spawned } = groupedAdapter(
      streamScript(
        `const d = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore", env: process.env });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));`,
      ),
      {},
    );
    const connection = adapter.connect("claude", process.cwd());
    const completed: any[] = [];
    connection.onNotification = (_m, params: any) => {
      if (params.event.type === "completed") completed.push(params.event);
    };
    let descendantPid = 0;
    cleanup.push(async () => {
      await connection.close();
      if (descendantPid && alive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    });
    const session = await adapter.startSession(connection, prepared(), null);
    await adapter.startTurn(connection, prepared(), session.nativeSessionId);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    descendantPid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    // The adapter reports a known failure once the leader exits ...
    expect(completed[0]).toMatchObject({ failed: true });
    expect(completed[0].detail).toContain("after the model's message ended");
    expect(alive(spawned[0])).toBe(false);
    // ... while a member of its process group is still running.
    expect(alive(descendantPid)).toBe(true);
    const lifecycle = await connection.close();
    expect(lifecycle.state).toBe("quiescent");
    expect(lifecycle.remainingGroup).toBe("absent");
    await vi.waitFor(() => expect(alive(descendantPid)).toBe(false));
  });

  // The adapter's "failed" label above is not the system outcome. These two
  // tests drive the production RuntimeManager (finish -> settle ->
  // ProcessLifecycle.stop -> confirmStopped / markUncertain) over the same
  // grouped stand-in and read the durable run, lease, concurrency-slot and
  // task-process-lifecycle rows, with the descendant checked by an
  // independent signal-0 probe. isolatedFixture=true only skips the Claude
  // route/qualification gate before dispatch; the lifecycle path is unchanged.
  const descendantScript = (pidFile: string) =>
    streamScript(
      `const d = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
        `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
      )}], { stdio: "ignore", env: process.env });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));`,
    );
  async function managedStall() {
    const f = await fixture();
    const directory = await realpath(await scratch("campaign-cl13-ws-")),
      pidFile = path.join(directory, "..", `${path.basename(directory)}.pid`);
    cleanup.push(() => rm(pidFile, { force: true }));
    const installation = { ...f.installation, appId: "anthropic.claude-code-cli" as const };
    f.store.put("installation", installation);
    const { adapter, spawned } = groupedAdapter(descendantScript(pidFile), {});
    const runtime = new RuntimeManager(
      f.store,
      () => {},
      () => {},
      undefined,
      undefined,
      { claude: adapter },
      true,
    );
    const state = { descendant: 0 };
    cleanup.push(async () => {
      await runtime.close();
      // Never leave a stand-in group behind, whatever the test observed.
      for (const pid of spawned)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      if (state.descendant)
        try {
          process.kill(state.descendant, "SIGKILL");
        } catch {}
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const project = {
      id: uid(),
      name: "cl13",
      path: directory,
      realPath: directory,
      trusted: true,
      createdAt: now(),
    };
    const conversation = {
      id: uid(),
      projectId: project.id,
      title: "CL-13",
      nativeSessions: {},
      createdAt: now(),
    };
    f.store.put("project", project);
    f.store.put("conversation", conversation);
    const run = await runtime.start(installation, conversation, project, "campaign", "claude-fixture-5", "review");
    const attempt = runtime.coordinator.attemptForRun(run.id)!;
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    state.descendant = Number(readFileSync(pidFile, "utf8"));
    const rows = () => ({
      run: f.store.get<any>("run", run.id),
      lease: f.store.db
        .prepare("SELECT body FROM workspace_leases")
        .all()
        .map((row: any) => JSON.parse(row.body))
        .find((lease: any) => lease.attemptId === attempt.id),
      slot: f.store.get<any>("concurrency-slot", attempt.id),
      lifecycle: f.store.get<any>("task-process-lifecycle", run.id),
    });
    return { f, runtime, run, attempt, spawned, state, rows, installation, conversation, project };
  }

  test("CL-13 (manager): after a stall kill the run is labelled failed, but the writer lease and concurrency slot stay held while a group member lives; both are released only after the group is gone", async () => {
    const m = await managedStall();
    const leader = m.spawned[0];
    // The stall SIGTERM ends the leader; the manager records the adapter's
    // failure at once and starts the lifecycle stop.
    await vi.waitFor(() => expect(m.rows().run.status).toBe("failed"), { timeout: 10_000, interval: 10 });
    const window = m.rows();
    expect(window.run.error).toContain("after the model's message ended");
    // Positive control: the independent probe sees the descendant and its
    // process group alive while the leader is already gone.
    expect(probe(leader)).toBe("ESRCH");
    expect(probe(m.state.descendant)).toBe("alive");
    expect(probe(-leader)).toBe("alive");
    // Negative control: nothing was released while that member lives.
    expect(window.lease).toMatchObject({ state: "held" });
    expect(window.slot).toMatchObject({ state: "held" });
    expect(window.lifecycle).toBeUndefined();
    expect(m.runtime.coordinator.ownership.forAttempt(m.attempt.id)?.state).toBe("held");
    // No lease reassignment: a new writer on the same folder is refused.
    await expect(
      m.runtime.start(m.installation, m.conversation, m.project, "again", "claude-fixture-5", "review"),
    ).rejects.toThrow("This workspace already has a native session or writer lease.");
    // The lifecycle stop escalates to the group SIGKILL after its 5 s grace;
    // only then are the lease and slot released.
    await vi.waitFor(() => expect(m.rows().lease.state).toBe("released"), { timeout: 15_000, interval: 25 });
    const after = m.rows();
    expect(probe(m.state.descendant)).toBe("ESRCH");
    expect(probe(-leader)).toBe("ESRCH");
    expect(after.slot).toMatchObject({ state: "released" });
    expect(after.lifecycle).toMatchObject({
      state: "quiescent",
      scope: "posix-process-group",
      remainingGroup: "absent",
      groupId: leader,
    });
    expect(after.run).toMatchObject({ status: "failed" });
  });

  test("CL-13 (manager): when the group signals fail and a member survives, the run becomes uncertain, the lease is held uncertain and reconciliation is refused until the group is really gone", async () => {
    const m = await managedStall();
    const leader = m.spawned[0];
    // Simulate a termination signal that cannot be delivered to the group
    // (EPERM). Every other process.kill, including signal-0 probes and the
    // adapter's own ChildProcess.kill, is real.
    const realKill = process.kill.bind(process);
    const signals = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -leader && signal !== 0 && signal !== undefined)
        throw Object.assign(new Error(`kill EPERM`), { code: "EPERM", errno: -1, syscall: "kill" });
      return realKill(pid, signal as any);
    }) as typeof process.kill);
    cleanup.push(() => signals.mockRestore());
    await vi.waitFor(() => expect(m.rows().run.status).toBe("failed"), { timeout: 10_000, interval: 10 });
    // Settle: SIGTERM fails, 5 s grace, SIGKILL fails, group still present.
    await vi.waitFor(() => expect(m.rows().run.status).toBe("uncertain"), { timeout: 15_000, interval: 25 });
    const held = m.rows();
    expect(held.run.error).toContain("Task quiescence is unproven");
    expect(held.lifecycle).toMatchObject({ state: "uncertain", remainingGroup: "present", groupId: leader });
    expect(held.lease).toMatchObject({ state: "uncertain" });
    expect(held.slot).toMatchObject({ state: "held" });
    expect(probe(m.state.descendant)).toBe("alive");
    expect(probe(-leader)).toBe("alive");
    // No automatic reassignment and no reconciliation while the member lives.
    await expect(
      m.runtime.start(m.installation, m.conversation, m.project, "again", "claude-fixture-5", "review"),
    ).rejects.toThrow("Workspace has uncertain ownership; reconcile before starting another writer.");
    await expect(m.runtime.reconcile(m.run.id)).rejects.toThrow(
      "Owned descendant group is still present or unknown. Reconciliation cannot release this workspace.",
    );
    expect(m.rows().lease).toMatchObject({ state: "uncertain" });
    expect(m.rows().slot).toMatchObject({ state: "held" });
    // Control: once the group is really gone, reconciliation releases both.
    signals.mockRestore();
    process.kill(-leader, "SIGKILL");
    await vi.waitFor(() => {
      expect(probe(-leader)).toBe("ESRCH");
      expect(probe(m.state.descendant)).toBe("ESRCH");
    });
    await m.runtime.reconcile(m.run.id);
    expect(m.rows().lease).toMatchObject({ state: "released" });
    expect(m.rows().slot).toMatchObject({ state: "released" });
    expect(m.rows().run).toMatchObject({ status: "interrupted" });
  });
});

describe("CL-10 cleanup and CL-12 late reader calls after a stall (real stand-in)", () => {
  test("a silent reader turn is stopped as failed; closing removes the MCP configuration with its bearer token, stops the server and refuses later calls", async () => {
    const args: string[][] = [];
    const adapter = new ClaudeAdapter(undefined, undefined, {
      routeAllowed: () => true,
      stall: { afterMessageMs: 300, silenceMs: 800, checkMs: 50 },
      transport: (_executable, argv, cwd) => {
        args.push(argv);
        return spawn(process.execPath, [standIn, ...argv], {
          cwd,
          shell: false,
          env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", FIXTURE_STALL: "silent" }),
          detached: posix,
        });
      },
    });
    const connection = adapter.connect("claude", process.cwd());
    const completed: any[] = [];
    const requests: any[] = [];
    connection.onNotification = (_m, params: any) => {
      if (params.event.type === "completed") completed.push(params.event);
    };
    connection.onRequest = (id, method, params) => requests.push({ id, method, params });
    cleanup.push(async () => {
      await connection.close();
    });
    const turn = { ...prepared('Call read_range with path "a.txt".'), toolset: candidateToolset };
    const session = await adapter.startSession(connection, turn, null);
    await adapter.startTurn(connection, turn, session.nativeSessionId);
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(completed[0]).toMatchObject({ failed: true });
    expect(completed[0].detail).toContain("Claude Code wrote nothing for 1 seconds");
    const configPath = args[0][args[0].indexOf("--mcp-config") + 1];
    expect(path.isAbsolute(configPath)).toBe(true);
    // Still present until the connection closes.
    const config = JSON.parse(await readFile(configPath, "utf8")).mcpServers.topsl_candidate;
    expect(config.headers.Authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
    const lifecycle = await connection.close();
    expect(lifecycle.state).toBe("quiescent");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(path.dirname(configPath))).toBe(false);
    // The old bearer token and route serve nothing.
    await expect(
      fetch(config.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
      }),
    ).rejects.toThrow();
    // A late call routed to the closed connection is refused, never handed
    // to the runtime's request handler.
    const late = await (connection as any).toolRequest({
      requestId: "late-1",
      tool: "read_range",
      arguments: { path: "a.txt" },
    });
    expect(late).toMatchObject({ isError: true });
    expect(JSON.stringify(late)).toContain("outside the active turn");
    expect(requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Claude qualification and purpose readiness through the runtime manager.
// ---------------------------------------------------------------------------
async function qualificationParent() {
  return scratch("topsl-qualify-campaign-");
}
async function launched(env = "") {
  const f = await fixture();
  await writeFile(
    f.installation.path,
    `#!/bin/sh\n${env}ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)} "$@"\n`,
  );
  await chmod(f.installation.path, 0o700);
  const installation = {
    ...f.installation,
    appId: "anthropic.claude-code-cli" as const,
    ...(await identity(f.installation.path)),
  };
  f.store.put("installation", installation);
  const runtime = new RuntimeManager(f.store, () => {}, () => {});
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
  const codes = (purpose: ExecutionPurpose, model = "claude-fixture-5") =>
    runtime
      .purposeReadiness(
        installation,
        { installationId: installation.id, provider: "claude", model },
        purpose,
      )
      .blockers.map((b) => b.code);
  return { ...f, installation, runtime, route, codes };
}
const purposes = [
  "coordinator-contribution",
  "coordinator-endorsement",
  "information",
  "candidate-review",
  "implementation",
  "direct-chat",
] as const;
const byName = (report: { observations: any[] }) =>
  Object.fromEntries(report.observations.map((o) => [o.capability, o]));

describe.skipIf(!posix)("CL-02/CL-06/CL-07 Claude qualification through the runtime manager (POSIX shell stand-in)", () => {
  test("CL-02: the account read runs only `auth status --json` (no model turn); every purpose stays blocked until qualified", async () => {
    const log = path.join(await scratch("campaign-cl02-"), "argv.jsonl");
    const f = await launched(`FIXTURE_LOG=${JSON.stringify(log)} `);
    await expect(f.runtime.inspect(f.installation)).rejects.toThrow("structured route is off");
    expect(existsSync(log)).toBe(false);
    for (const purpose of purposes)
      expect(f.codes(purpose), purpose).toContain("authentication-route-unapproved");
    f.route(true);
    const inspected = await f.runtime.inspect(f.installation);
    expect(inspected.account).toEqual({ type: "claude.ai", email: null, planType: "max" });
    const runs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // inspectClaude reads the account through adapter.inspect and again
    // through adapter.account: two account reads, never a print turn.
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run).toEqual(["auth", "status", "--json"]);
    expect(runs.flat()).not.toContain("--print");
    for (const purpose of purposes) {
      const codes = f.codes(purpose);
      expect(codes, purpose).toContain("claude-route-unqualified");
      expect(codes, purpose).not.toContain("authentication-route-unapproved");
    }
  });

  test("CL-06: a runtime whose turns report an API key source qualifies nothing that needs a turn, and no purpose becomes ready", async () => {
    const f = await launched("FIXTURE_API_KEY=1 ");
    f.route(true);
    await f.runtime.inspect(f.installation);
    f.store.put("installation", { ...f.installation, compatibility: "compatible" });
    const result = await f.runtime.qualify(
      f.installation,
      { model: "claude-fixture-5" },
      await qualificationParent(),
    );
    const o = byName(result.report);
    for (const capability of [
      "structured-turn",
      "read-only",
      "workspace-write",
      "candidate-reader",
      "native-subscription",
      "fresh-session",
    ])
      expect(o[capability]?.passed, capability).toBe(false);
    expect(o["structured-turn"].detail).toContain("not your Claude login");
    expect(result.report.turnsStarted).toBe(4);
    for (const purpose of purposes) expect(f.codes(purpose), purpose).not.toEqual([]);
    // The model never enters the catalog from a failed structured turn.
    expect(f.codes("coordinator-contribution")).toContain("unsupported-model-setting");
  });

  test("CL-07: an alias reported as a different full id stays out of the catalog; qualifying the exact reported id admits it", async () => {
    const exact = "claude-fixture-5-20261001";
    const f = await launched(`FIXTURE_MODEL=${exact} `);
    f.route(true);
    await f.runtime.inspect(f.installation);
    f.store.put("installation", { ...f.installation, compatibility: "compatible" });
    await f.runtime.qualify(f.installation, { model: "claude-fixture-5" }, await qualificationParent());
    expect(f.codes("coordinator-contribution", "claude-fixture-5")).toEqual([
      "unsupported-model-setting",
    ]);
    expect(f.codes("coordinator-contribution", exact)).toEqual(["unsupported-model-setting"]);
    const second = await f.runtime.qualify(
      f.installation,
      { model: exact },
      await qualificationParent(),
    );
    expect(second.report.reportedModel).toBe(exact);
    for (const purpose of purposes) expect(f.codes(purpose, exact), purpose).toEqual([]);
    // The alias is still not an eligible exact model.
    expect(f.codes("coordinator-contribution", "claude-fixture-5")).toEqual([
      "unsupported-model-setting",
    ]);
    // CL-01: turning the route off blocks every purpose but deletes no
    // evidence; turning it back on restores readiness without a new turn.
    f.route(false);
    for (const purpose of purposes)
      expect(f.codes(purpose, exact), purpose).toEqual(["authentication-route-unapproved"]);
    expect(f.runtime.acceptance.history(f.installation.id)).toHaveLength(2);
    expect(f.runtime.qualificationReports(f.installation.id)).toHaveLength(2);
    f.route(true);
    for (const purpose of purposes) expect(f.codes(purpose, exact), purpose).toEqual([]);
  });
});

// A scripted Claude Code for direct runClaudeQualification runs: CAMPAIGN_MODE
// "no-init" never sends the init record; "no-marker" replies without the
// requested marker. It never writes files or calls tools.
const qualifyScript = `
const argv = process.argv;
const sid = argv[argv.indexOf("--session-id") + 1];
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const mode = process.env.CAMPAIGN_MODE;
  if (mode !== "no-init")
    out({ type: "system", subtype: "init", session_id: sid, model: "claude-fixture-5", tools: [], apiKeySource: "none", uuid: "init" });
  const marker = /nothing else: (\\S+)$/m.exec(input);
  const text = mode === "no-marker" ? "I would rather not." : marker ? marker[1] : "NO-WRITE-TOOL";
  out({ type: "assistant", session_id: sid, message: { id: "m1", model: "claude-fixture-5", content: [{ type: "text", text }] }, uuid: "a1" });
  out({ type: "result", subtype: "success", is_error: false, session_id: sid, result: text, uuid: "r1" });
});`;
function scriptedQualificationAdapter(env: Record<string, string>, script = qualifyScript) {
  return new ClaudeAdapter(undefined, undefined, {
    routeAllowed: () => true,
    readAccount: async () => ({
      accountKey: "campaign-account",
      profileId: "campaign-profile",
      billingRoute: "native-subscription",
      sanitized: { type: "claude.ai", email: null, planType: "max" },
    }),
    transport: (_executable, args, cwd) =>
      spawn(process.execPath, ["-e", script, "--", ...args], {
        cwd,
        shell: false,
        env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", ...env }),
        detached: posix,
      }),
  });
}

describe("CL-04/CL-06 qualification probes that need evidence fail closed when it is missing", () => {
  test("CL-04: turns without an init record fail read-only, native-subscription and fresh-session; the structured turn itself still passes (documented current behavior)", async () => {
    const f = await fixture();
    cleanup.push(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const report = await runClaudeQualification({
      adapter: scriptedQualificationAdapter({ CAMPAIGN_MODE: "no-init" }),
      installation: { ...f.installation, appId: "anthropic.claude-code-cli" },
      model: "claude-fixture-5",
      parent: await qualificationParent(),
    });
    const o = byName(report);
    expect(report.turnsStarted).toBe(4);
    expect(o["read-only"]).toMatchObject({ passed: false });
    expect(o["read-only"].detail).toContain("reported these tools for it: not reported");
    expect(o["native-subscription"]).toMatchObject({ passed: false });
    expect(o["native-subscription"].detail).toContain("0 of 4 turns reported their API key source");
    expect(o["fresh-session"]).toMatchObject({ passed: false });
    expect(o["fresh-session"].detail).toContain("0 reported that id");
    expect(o["workspace-write"].passed).toBe(false);
    expect(o["candidate-reader"].passed).toBe(false);
    // The direct-turn path accepts a result without init: this is the
    // plan's "does not universally reject every omission" note.
    expect(o["structured-turn"].passed).toBe(true);
    expect(o["process-lifecycle"].passed).toBe(true);
  });

  test("CL-06: a reply without the requested marker fails the structured turn while independent probes are still judged", async () => {
    const f = await fixture();
    cleanup.push(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const report = await runClaudeQualification({
      adapter: scriptedQualificationAdapter({ CAMPAIGN_MODE: "no-marker" }),
      installation: { ...f.installation, appId: "anthropic.claude-code-cli" },
      model: "claude-fixture-5",
      parent: await qualificationParent(),
    });
    const o = byName(report);
    expect(o["structured-turn"].passed).toBe(false);
    expect(o["structured-turn"].detail).toContain("the requested marker was not returned");
    expect(o["structured-turn"].detail).toContain('The reply began: "I would rather not."');
    expect(o["fresh-session"].passed).toBe(true);
    expect(o["native-subscription"].passed).toBe(true);
  });

  test("CL-06: a process that never exits fails every turn probe at the turn timeout, and every turn process is still stopped", async () => {
    const f = await fixture();
    cleanup.push(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const adapter = new ClaudeAdapter(undefined, undefined, {
      routeAllowed: () => true,
      readAccount: async () => ({
        accountKey: "campaign-account",
        profileId: "campaign-profile",
        billingRoute: "native-subscription",
        sanitized: { type: "claude.ai", email: null, planType: "max" },
      }),
      transport: (_executable, args, cwd) => {
        const child = spawn(process.execPath, [standIn, ...args], {
          cwd,
          shell: false,
          env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", FIXTURE_STALL: "silent" }),
          detached: posix,
        });
        const pid = child.pid!;
        turns.push({ pid, before: null });
        // Positive control, mid-turn (the turn timeout is 1,000 ms): the same
        // independent probe used after the stop sees the process and its
        // group alive before Topsl stops it.
        setTimeout(() => {
          turns.find((t) => t.pid === pid)!.before = posix ? [probe(pid), probe(-pid)] : [probe(pid)];
        }, 400);
        return child;
      },
    });
    const turns: Array<{ pid: number; before: string[] | null }> = [];
    cleanup.push(() => {
      for (const { pid } of turns)
        try {
          process.kill(posix ? -pid : pid, "SIGKILL");
        } catch {}
    });
    const report = await runClaudeQualification({
      adapter,
      installation: { ...f.installation, appId: "anthropic.claude-code-cli" },
      model: "claude-fixture-5",
      parent: await qualificationParent(),
      timeoutMs: 1_000,
    });
    const o = byName(report);
    for (const capability of ["structured-turn", "read-only", "workspace-write", "candidate-reader"])
      expect(o[capability].passed, capability).toBe(false);
    expect(o["structured-turn"].detail).toContain("structured-turn turn exceeded 1000 ms");
    expect(o["process-lifecycle"]).toMatchObject({ passed: true });
    expect(o["process-lifecycle"].detail).toMatch(/^4 of 4 turn processes stopped/);
    // The product's "4 of 4 stopped" is checked independently: four turn
    // processes (plus the account read's connection, which starts none) were
    // seen alive mid-turn, and after the report every pid and its process
    // group is gone (ESRCH), not merely reported quiescent.
    expect(turns).toHaveLength(4);
    for (const turn of turns) {
      expect(turn.before, `pid ${turn.pid} before the stop`).toEqual(posix ? ["alive", "alive"] : ["alive"]);
      expect(probe(turn.pid), `pid ${turn.pid} after the report`).toBe("ESRCH");
      if (posix) expect(probe(-turn.pid), `group ${turn.pid} after the report`).toBe("ESRCH");
    }
  });
});

// ---------------------------------------------------------------------------
// CL-08: Claude binding matrix and exact expiry, at the acceptance registry.
// ---------------------------------------------------------------------------
function observed(names: string[]): RuntimeProbeObservation[] {
  return names.map((capability) => ({
    capability,
    meaning: "behavior-observed",
    source: "trusted-runtime-validation",
    operationId: `campaign:${capability}`,
    observedAt: now(),
    passed: true,
    negativeControl: null,
    detail: "Synthetic trusted-suite contract observation; no live provider acceptance.",
  }));
}

describe("CL-08 Claude binding changes and the exact 30-day expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test("Claude settings, settings.local and account changes stale only the Claude acceptance; the Codex acceptance in the same store is unaffected", async () => {
    const f = await fixture();
    cleanup.push(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const claudeHome = path.join(f.directory, "claude-home"),
      codexHome = path.join(f.directory, "codex-home");
    await mkdir(claudeHome);
    await mkdir(codexHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    await writeFile(path.join(claudeHome, "settings.json"), '{"theme":"dark"}');
    const registry = new RuntimeAcceptanceRegistry(f.store);
    const claude = { ...f.installation, id: uid(), appId: "anthropic.claude-code-cli" as const };
    const codex = f.installation;
    const account = (key = "account") => ({
      accountKey: key,
      profileId: "profile",
      billingRoute: "native-subscription" as const,
    });
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    registry.recordTrustedValidation(runtimeBinding(claude, account()), observed(["structured-turn"]), expires);
    registry.recordTrustedValidation(runtimeBinding(codex, account()), observed(["structured-turn"]), expires);
    const state = (installation: typeof claude | typeof codex, key = "account") =>
      registry.resolve(runtimeBinding(installation, account(key)), installation).freshness.state;
    expect(state(claude)).toBe("current");
    expect(state(codex)).toBe("current");
    for (const [file, text] of [
      ["settings.json", '{"theme":"light"}'],
      ["settings.local.json", '{"permissions":{"allow":["Bash"]}}'],
    ]) {
      const before = await readFile(path.join(claudeHome, "settings.json"), "utf8");
      await writeFile(path.join(claudeHome, file), text);
      expect(state(claude), file).toBe("stale");
      expect(state(codex), file).toBe("current");
      // Restoring the exact bytes restores the binding.
      if (file === "settings.json") await writeFile(path.join(claudeHome, file), before);
      else await rm(path.join(claudeHome, file));
      expect(state(claude), file).toBe("current");
    }
    // A moved profile root is a different binding.
    vi.stubEnv("CLAUDE_CONFIG_DIR", codexHome);
    expect(state(claude)).toBe("stale");
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
    expect(state(claude, "other-account")).toBe("stale");
    expect(state(claude)).toBe("current");
    // A changed executable or runtime revision is a different binding.
    expect(
      registry.resolve(runtimeBinding({ ...claude, identity: "changed" }, account()), claude).freshness.state,
    ).toBe("stale");
    // A fresh valid qualification supersedes a stale one.
    vi.stubEnv("CLAUDE_CONFIG_DIR", codexHome);
    registry.recordTrustedValidation(runtimeBinding(claude, account()), observed(["structured-turn"]), expires);
    expect(state(claude)).toBe("current");
  });

  test("acceptance is current until 1 ms before expiresAt and stale at exactly expiresAt; an already-expired record is refused", async () => {
    const f = await fixture();
    cleanup.push(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const claude = { ...f.installation, appId: "anthropic.claude-code-cli" as const };
    const binding = runtimeBinding(claude, {
      accountKey: "a",
      profileId: "p",
      billingRoute: "native-subscription",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-10-19T12:00:00.000Z");
    vi.setSystemTime(t0);
    const registry = new RuntimeAcceptanceRegistry(f.store);
    const expiresAt = new Date(t0 + 30 * 86_400_000).toISOString();
    expect(() =>
      registry.recordTrustedValidation(binding, observed(["structured-turn"]), new Date(t0).toISOString()),
    ).toThrow("Only current trusted runtime operations");
    registry.recordTrustedValidation(binding, observed(["structured-turn"]), expiresAt);
    vi.setSystemTime(t0 + 30 * 86_400_000 - 1);
    expect(registry.resolve(binding, claude).freshness.state).toBe("current");
    expect(registry.resolve(binding, claude).capabilities.map((c) => c.name)).toEqual([
      "structured-turn",
    ]);
    vi.setSystemTime(t0 + 30 * 86_400_000);
    expect(registry.resolve(binding, claude).freshness.state).toBe("stale");
    expect(registry.resolve(binding, claude).capabilities).toEqual([]);
  });
});
