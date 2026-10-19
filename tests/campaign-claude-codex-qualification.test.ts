/**
 * Campaign 2026-10-19-comprehensive, packet p3b-claude-codex-qualification:
 * Codex runtime qualification (plan section 5.24, CQ-01..CQ-08).
 *
 * Every run uses the scripted Codex app-server stand-in
 * (tests/fixtures/codex-qualify.cjs) over the production CodexAdapter,
 * qualification suite, runtime manager and service. Wrappers around the
 * adapter count calls or substitute a misleading runtime answer; they never
 * replace the suite's own checks. No model or account is contacted.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createReaderProbe } from "../packages/context/reader-probe";
import { CodexAdapter } from "../packages/providers/codex";
import type {
  ProviderAdapter,
  ProviderConnection,
  SandboxCommandResult,
} from "../packages/providers/contract";
import {
  assertQualificationParent,
  qualificationValidityDays,
  runCodexQualification,
} from "../packages/providers/qualification";
import { answerToolCall } from "../packages/providers/tool-calls";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { Service } from "../apps/service/service";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { now } from "../packages/domain/invariants";
import { fixture } from "./helpers";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const posix = process.platform !== "win32";
const standIn = path.resolve("tests/fixtures/codex-qualify.cjs");
const cache = path.resolve("node_modules/.cache");

async function qualificationParent(prefix = "topsl-qualify-campaign-") {
  await mkdir(cache, { recursive: true });
  const parent = await mkdtemp(path.join(cache, prefix));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  return parent;
}
async function setup(env: Record<string, string> = {}) {
  const f = await fixture();
  cleanup.push(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const log = path.join(f.directory, "frames.jsonl");
  let connections = 0;
  const adapter = new CodexAdapter((_executable, cwd) => {
    connections++;
    return new RpcPeer(process.execPath, [standIn], cwd, {
      ...nativeEnvironment(),
      ELECTRON_RUN_AS_NODE: "1",
      FIXTURE_LOG: log,
      ...env,
    });
  });
  return {
    ...f,
    adapter,
    parent: await qualificationParent(),
    connections: () => connections,
    frames: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { from: string; frame: any })
        : [],
  };
}
/** The adapter with some methods replaced; everything else is the real one. */
function wrap(adapter: CodexAdapter, overrides: Partial<Record<keyof CodexAdapter, unknown>>) {
  return Object.assign(Object.create(adapter), overrides) as ProviderAdapter;
}
/** Counts the adapter calls that start model turns and sessions. */
function counted(adapter: CodexAdapter, overrides: Partial<Record<keyof CodexAdapter, unknown>> = {}) {
  const counts = { startTurn: 0, startSession: 0, sandboxCommand: 0 };
  const base = wrap(adapter, overrides) as any;
  const wrapped = wrap(adapter, {
    ...overrides,
    startTurn: (...a: any[]) => {
      counts.startTurn++;
      return base.startTurn(...a);
    },
    startSession: (...a: any[]) => {
      counts.startSession++;
      return base.startSession(...a);
    },
    sandboxCommand: (...a: any[]) => {
      counts.sandboxCommand++;
      return base.sandboxCommand(...a);
    },
  });
  return { wrapped, counts };
}
const byName = (report: { observations: any[] }) =>
  Object.fromEntries(report.observations.map((o) => [o.capability, o]));
const turnCapabilities = [
  "structured-turn",
  "candidate-reader",
  "fresh-session",
  "read-only",
  "workspace-write",
  "interrupt",
];

// ---------------------------------------------------------------------------
// CQ-01: refusals before any process, canonical aliases, concurrency.
// ---------------------------------------------------------------------------
describe("CQ-01 qualification parent folder and refusal before any process", () => {
  // Not applicable on Windows: runCodexQualification refuses win32 before it
  // ever consults the parent folder ("Runtime qualification probes use POSIX
  // shell commands..."; the platform-stubbed test below pins that refusal),
  // and this alias list (/tmp, symlinks into the temp folder) is POSIX-shaped.
  // Unverified on Windows: assertQualificationParent's handling of %TEMP%
  // aliases (8.3 short names, junctions), which has no caller there.
  test.skipIf(!posix)("system temporary folders and their aliases are refused; a folder under the repository cache is accepted", async () => {
    const tmp = os.tmpdir(),
      real = await realpath(tmp),
      parent = await qualificationParent(),
      link = path.join(parent, "into-temporary");
    await symlink(tmp, link);
    const refused = [
      tmp,
      real,
      path.join(tmp, "a", "b", "missing"),
      path.join(real, "qualification"),
      path.join(link, "qualification"),
      path.join(parent, "..", path.relative(path.dirname(parent), path.join(tmp, "x"))),
      "/tmp",
      "/tmp/topsl-campaign/missing/child",
    ];
    if (process.platform === "darwin")
      refused.push(
        "/private/tmp/topsl-campaign",
        // APFS here is case-insensitive; realpath canonicalizes the case.
        "/TMP/topsl-campaign",
        "/Private/Tmp/topsl-campaign",
        path.join(tmp.toUpperCase(), "topsl-campaign"),
      );
    for (const candidate of refused)
      await expect(assertQualificationParent(candidate), candidate).rejects.toThrow(
        "Use a folder outside the system temporary folders.",
      );
    // Negative control.
    await expect(assertQualificationParent(parent)).resolves.toBeUndefined();
    await expect(
      assertQualificationParent(path.join(parent, "not", "yet", "created")),
    ).resolves.toBeUndefined();
  });

  const dataTmp = "/System/Volumes/Data/private/tmp";
  const firmlinked =
    process.platform === "darwin" &&
    existsSync(dataTmp) &&
    statSync(dataTmp).ino === statSync("/private/tmp").ino &&
    statSync(dataTmp).dev === statSync("/private/tmp").dev;
  // CAMPAIGN DEFECT CQ-01: macOS firmlink path of /tmp (same dev/inode) passes assertQualificationParent and a qualification runs inside /tmp.
  test.skipIf(!firmlinked).fails(
    "the macOS firmlink alias of /tmp (same device and inode) is refused before the runtime starts",
    async () => {
      const f = await setup();
      const parent = path.join(dataTmp, `topsl-campaign-${process.pid}-${Date.now()}`);
      cleanup.push(() => rm(parent, { recursive: true, force: true }));
      // Precondition: the alias really is the system /tmp directory.
      expect(statSync(dataTmp).ino).toBe(statSync("/tmp").ino);
      // Observed 2026-10-19: this resolves, so the test fails here.
      await expect(assertQualificationParent(parent)).rejects.toThrow(
        "outside the system temporary folders",
      );
      let error: unknown = null;
      try {
        await runCodexQualification({
          adapter: f.adapter,
          installation: f.installation,
          model: "fixture-model",
          parent,
        });
      } catch (e) {
        error = e;
      }
      expect(String(error)).toContain("outside the system temporary folders");
      expect(f.connections()).toBe(0);
    },
  );

  // Not applicable on Windows: the platform refusal precedes the quoting
  // check there (pinned by the platform-stubbed test below), so the POSIX
  // shell-quoting refusal cannot be reached.
  test.skipIf(!posix)("a folder whose path the shell probes cannot quote is refused before the runtime starts, leaving no workspace", async () => {
    const f = await setup();
    const parent = await qualificationParent("topsl qualify campaign é-");
    await expect(
      runCodexQualification({
        adapter: f.adapter,
        installation: f.installation,
        model: "fixture-model",
        parent,
      }),
    ).rejects.toThrow("contains characters the shell probes cannot quote safely");
    expect(f.connections()).toBe(0);
    expect(await readdir(parent)).toEqual([]);
  });

  test("on Windows the suite refuses before creating a folder or starting the runtime (platform stubbed)", async () => {
    const f = await setup();
    const parent = path.join(f.parent, "never-created");
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    let error: unknown = null;
    try {
      await runCodexQualification({
        adapter: f.adapter,
        installation: f.installation,
        model: "fixture-model",
        parent,
      });
    } catch (e) {
      error = e;
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    expect(String(error)).toContain("available on macOS and Linux only");
    expect(f.connections()).toBe(0);
    expect(existsSync(parent)).toBe(false);
  });
});

/** A trusted "Codex" executable that runs the stand-in, under a production
 * runtime manager. Every frame goes to `log`. */
async function launched(
  env = "",
  adapters?: (executable: string) => Partial<Record<"codex", ProviderAdapter>>,
) {
  const f = await fixture();
  const log = path.join(f.directory, "frames.jsonl");
  await writeFile(
    f.installation.path,
    `#!/bin/sh\nFIXTURE_LOG=${JSON.stringify(log)} ${env}ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)}\n`,
  );
  await chmod(f.installation.path, 0o700);
  const installation = { ...f.installation, ...(await identity(f.installation.path)) };
  f.store.put("installation", installation);
  const catalog = (models = ["fixture-model"]) =>
    f.store.put("runtime-model-catalog", {
      id: installation.id,
      runtimeRevision: installation.revisionId,
      executableIdentity: installation.identity,
      models: models.map((model) => ({
        id: model,
        model,
        name: model,
        description: "",
        isDefault: model === "fixture-model",
        supportedReasoningEfforts: ["high"],
      })),
      observedAt: now(),
    });
  catalog();
  const runtime = new RuntimeManager(
    f.store,
    () => {},
    () => {},
    undefined,
    undefined,
    adapters?.(installation.path),
  );
  cleanup.push(async () => {
    await runtime.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const frames = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { from: string; frame: any })
      : [];
  const sent = (method: string) =>
    frames().filter((e) => e.from === "topsl" && e.frame.method === method);
  const readiness = (model = "fixture-model") =>
    runtime.readiness(
      installation,
      { installationId: installation.id, provider: "codex", model },
      "implementer",
    );
  return { ...f, installation, runtime, frames, sent, readiness, catalog, log };
}

describe.skipIf(!posix)("CQ-01 runtime manager refusals and one qualification per installation (POSIX shell stand-in)", () => {
  test("untrusted, unconnected, stale-catalog, unknown-model and unsupported-effort requests start no process", async () => {
    const f = await launched();
    const parent = await qualificationParent();
    const cases: Array<[any, any, string]> = [
      [{ ...f.installation, trusted: false }, { model: "fixture-model" }, "trust this executable"],
      [{ ...f.installation, compatibility: "unverified" }, { model: "fixture-model" }, "Connect this runtime"],
      [f.installation, { model: "other-model" }, "Discover this runtime's models"],
      [f.installation, { model: "fixture-model", effort: "max" }, "Discover this runtime's models"],
      [{ ...f.installation, appId: "anthropic.claude-code-cli" }, { model: "fixture-model" }, "structured route is off"],
    ];
    for (const [installation, selection, message] of cases)
      await expect(f.runtime.qualify(installation, selection, parent), message).rejects.toThrow(message);
    // A catalog observed for another runtime revision is stale.
    f.store.put("runtime-model-catalog", {
      ...f.store.get<any>("runtime-model-catalog", f.installation.id),
      runtimeRevision: "older-revision",
    });
    await expect(
      f.runtime.qualify(f.installation, { model: "fixture-model" }, parent),
    ).rejects.toThrow("Discover this runtime's models");
    expect(existsSync(f.log)).toBe(false);
    expect(await readdir(parent)).toEqual([]);
    expect(f.runtime.qualificationReports(f.installation.id)).toEqual([]);
  });

  test("a second qualification for the same installation is refused while one runs; the refusal promotes nothing; the lock is released afterwards", async () => {
    const f = await launched();
    expect(f.readiness().ready).toBe(false);
    const first = f.runtime.qualify(f.installation, { model: "fixture-model" }, await qualificationParent());
    await expect(
      f.runtime.qualify(f.installation, { model: "fixture-model" }, await qualificationParent()),
    ).rejects.toThrow("A qualification is already running for this runtime.");
    expect(f.readiness().ready).toBe(false);
    expect(f.runtime.qualificationReports(f.installation.id)).toEqual([]);
    const result = await first;
    expect(result.report.turnsStarted).toBe(3);
    // One qualification ran: one connection, three turns.
    expect(f.sent("thread/start")).toHaveLength(3);
    expect(f.sent("turn/start")).toHaveLength(3);
    expect(f.runtime.qualificationReports(f.installation.id)).toHaveLength(1);
    expect(f.readiness().ready).toBe(true);
    await f.runtime.qualify(f.installation, { model: "fixture-model" }, await qualificationParent());
    expect(f.runtime.qualificationReports(f.installation.id)).toHaveLength(2);
  });
});

describe.skipIf(!posix)("CQ-01 / CQ-08 through the service commands (POSIX shell stand-in)", () => {
  test("runtime-qualify needs the trusted approval; the query returns at most five distinct reports, newest first, while all are retained", async () => {
    const f = await fixture();
    f.store.close();
    const log = path.join(f.directory, "frames.jsonl");
    await writeFile(
      f.installation.path,
      `#!/bin/sh\nFIXTURE_LOG=${JSON.stringify(log)} ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)}\n`,
    );
    await chmod(f.installation.path, 0o700);
    const installation = { ...f.installation, ...(await identity(f.installation.path)) };
    const qualificationDirectory = await qualificationParent();
    const service = new Service(f.directory, f.key, () => {}, true, undefined, qualificationDirectory);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    await service.start();
    service.store.put("installation", installation);
    service.store.put("runtime-model-catalog", {
      id: installation.id,
      runtimeRevision: installation.revisionId,
      executableIdentity: installation.identity,
      models: [{ id: "fixture-model", model: "fixture-model", name: "Fixture", description: "", isDefault: true, supportedReasoningEfforts: [] }],
      observedAt: now(),
    });
    const command = { type: "runtime-qualify" as const, id: installation.id, model: "fixture-model" };
    for (const trusted of [{}, { confirmedClaudeRoute: true }, { approved: false }])
      await expect(service.command(command, trusted as any)).rejects.toThrow(
        "Review the qualification operations and their model-turn budget first.",
      );
    expect(existsSync(log)).toBe(false);
    expect(
      (await service.command({ type: "runtime-qualification-query", id: installation.id })).reports,
    ).toEqual([]);
    for (let n = 0; n < 6; n++) {
      const result = await service.command(command, { approved: true });
      expect(result.report.turnsStarted).toBe(3);
    }
    const query = await service.command({ type: "runtime-qualification-query", id: installation.id });
    expect(query.reports).toHaveLength(5);
    expect(new Set(query.reports.map((r: any) => r.id)).size).toBe(5);
    expect(new Set(query.reports.map((r: any) => r.acceptanceId)).size).toBe(5);
    const created = query.reports.map((r: any) => r.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    expect(service.runtime.qualificationReports(installation.id)).toHaveLength(6);
    // Retained reports carry no account email.
    expect(JSON.stringify(query)).not.toContain("fixture@example.test");
  });
});

// ---------------------------------------------------------------------------
// CQ-02: count adapter startTurn calls.
// ---------------------------------------------------------------------------
describe.skipIf(!posix)("CQ-02 model turns counted at the adapter", () => {
  test("a passing run starts exactly three model turns and three sessions; the sandbox probes add no turn", async () => {
    const f = await setup();
    const { wrapped, counts } = counted(f.adapter);
    const report = await runCodexQualification({
      adapter: wrapped,
      installation: f.installation,
      model: "fixture-model",
      parent: f.parent,
    });
    expect(report.error).toBeNull();
    expect(counts).toEqual({ startTurn: 3, startSession: 3, sandboxCommand: 4 });
    expect(report.turnsStarted).toBe(counts.startTurn);
    expect(f.frames().filter((e) => e.from === "topsl" && e.frame.method === "turn/start")).toHaveLength(3);
  });

  test.each([
    ["an API-key account", { type: "apiKey" }],
    ["no account", null],
    ["another non-subscription login", { type: "chatgptAuthTokens", email: "x@example.test" }],
  ])(
    "with %s the native-subscription failure prevents every model turn; unreached probes are not tested, not passed",
    async (_label, account) => {
      const f = await setup();
      const { wrapped, counts } = counted(f.adapter, {
        account: (connection: ProviderConnection, installation: any) =>
          f.adapter.account(
            Object.assign(Object.create(connection), {
              request: async (method: string, params: unknown) =>
                method === "account/read" ? { account } : connection.request(method, params),
            }),
            installation,
          ),
      });
      const report = await runCodexQualification({
        adapter: wrapped,
        installation: f.installation,
        model: "fixture-model",
        parent: f.parent,
      });
      expect(counts.startTurn).toBe(0);
      expect(counts.startSession).toBe(0);
      expect(counts.sandboxCommand).toBe(0);
      expect(report.turnsStarted).toBe(0);
      expect(report.account).toBeNull();
      expect(report.error).toContain("native ChatGPT subscription login is required");
      const o = byName(report);
      expect(o["native-subscription"]).toMatchObject({ passed: false, meaning: "unknown" });
      for (const capability of turnCapabilities) expect(o[capability], capability).toBeUndefined();
      expect(report.notTested.map((n) => n.capability).sort()).toEqual([...turnCapabilities].sort());
      expect(report.observations.filter((x) => x.passed).map((x) => x.capability)).toEqual(["process-lifecycle"]);
    },
  );

  test("a reply without the marker fails structured-turn; a reply that merely contains it passes (substring check, not exact output)", async () => {
    const missing = await setup();
    const a = counted(missing.adapter, {
      startTurn: (connection: any, turn: any, thread: string) =>
        missing.adapter.startTurn(
          connection,
          { ...turn, prompt: turn.prompt.replace(/Reply with exactly this text.*$/, "Reply with Done.") },
          thread,
        ),
    });
    const r1 = await runCodexQualification({
      adapter: a.wrapped,
      installation: missing.installation,
      model: "fixture-model",
      parent: missing.parent,
    });
    expect(byName(r1)["structured-turn"]).toMatchObject({ passed: false });
    expect(byName(r1)["structured-turn"].detail).toBe(
      'Turn completed; the requested marker was not returned. The reply began: "Done."',
    );
    expect(a.counts.startTurn).toBe(3);

    const padded = await setup();
    const b = counted(padded.adapter, {
      event: (method: string, payload: unknown) => {
        const event = padded.adapter.event(method, payload);
        return event?.type === "message-delta" || (event?.type === "message" && event.role === "assistant")
          ? { ...event, text: `Sure! ${event.text} Anything else?` }
          : event;
      },
    });
    const r2 = await runCodexQualification({
      adapter: b.wrapped,
      installation: padded.installation,
      model: "fixture-model",
      parent: padded.parent,
    });
    expect(byName(r2)["structured-turn"]).toMatchObject({ passed: true });
    expect(b.counts.startTurn).toBe(3);
  });

  test("a repeated native thread id fails fresh-session, and the turn count stays within three", async () => {
    const f = await setup();
    let first: string | null = null;
    const { wrapped, counts } = counted(f.adapter, {
      startSession: async (...args: any[]) => {
        const started = await f.adapter.startSession(
          ...(args as Parameters<CodexAdapter["startSession"]>),
        );
        first ??= started.nativeSessionId;
        return { ...started, nativeSessionId: first };
      },
    });
    const report = await runCodexQualification({
      adapter: wrapped,
      installation: f.installation,
      model: "fixture-model",
      parent: f.parent,
    });
    const o = byName(report);
    expect(o["fresh-session"]).toMatchObject({ passed: false });
    expect(o["fresh-session"].detail).toBe(
      "The runtime returned the same thread identity for two fresh sessions.",
    );
    expect(counts.startTurn).toBeLessThanOrEqual(3);
    expect(report.turnsStarted).toBe(counts.startTurn);
  });

  test("a model turn that never completes fails at the turn timeout; later probes still run within the three-turn budget", async () => {
    const f = await setup();
    const { wrapped, counts } = counted(f.adapter, {
      // The structured turn becomes an endless streaming turn.
      startTurn: (connection: any, turn: any, thread: string) =>
        f.adapter.startTurn(
          connection,
          turn.attemptId.includes(":structured-turn:")
            ? { ...turn, prompt: "Write the numbers from 1 to 3000, one per line." }
            : turn,
          thread,
        ),
    });
    const report = await runCodexQualification({
      adapter: wrapped,
      installation: f.installation,
      model: "fixture-model",
      parent: f.parent,
      timeoutMs: 1_500,
    });
    const o = byName(report);
    expect(o["structured-turn"]).toMatchObject({ passed: false, meaning: "unknown" });
    expect(o["structured-turn"].detail).toBe("structured-turn turn exceeded 1500 ms.");
    expect(counts.startTurn).toBe(3);
    expect(o["candidate-reader"].passed).toBe(true);
    expect(o["interrupt"].passed).toBe(true);
    // The timed-out turn was interrupted, not left streaming.
    expect(
      f.frames().filter((e) => e.from === "topsl" && e.frame.method === "turn/interrupt").length,
    ).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// CQ-03 / CQ-04: sandbox control and sentinel outcomes, including misleading
// exit codes. A wrapper changes what the runtime reports; Topsl's own
// filesystem readback still decides.
// ---------------------------------------------------------------------------
type Exec = (connection: ProviderConnection, input: { argv: string[]; cwd: string; mode: "review" | "edit" }) => Promise<SandboxCommandResult>;
async function sandboxRun(
  env: Record<string, string>,
  rewrite: (input: { argv: string[]; mode: string }, result: SandboxCommandResult) => Promise<SandboxCommandResult> | SandboxCommandResult,
) {
  const f = await setup(env);
  const exec = f.adapter.sandboxCommand.bind(f.adapter) as Exec;
  const { wrapped, counts } = counted(f.adapter, {
    sandboxCommand: async (connection: ProviderConnection, input: any) =>
      rewrite(input, await exec(connection, input)),
  });
  const report = await runCodexQualification({
    adapter: wrapped,
    installation: f.installation,
    model: "fixture-model",
    parent: f.parent,
  });
  // The sandbox probes never add a model turn.
  expect(counts.startTurn).toBe(3);
  return byName(report);
}
const target = (input: { argv: string[] }) => input.argv[5] ?? "";
const isWrite = (input: { argv: string[] }) => input.argv[2] === 'printf %s "$1" > "$2"';

describe.skipIf(!posix)("CQ-03 / CQ-04 sandbox probe matrix", () => {
  test("CQ-03: a control that does not print `readable`, or exits nonzero, fails read-only even though the write was denied", async () => {
    for (const control of [
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "readable", stderr: "" },
      { exitCode: 0, stdout: "readable\n", stderr: "" },
    ]) {
      const o = await sandboxRun({}, (input, result) =>
        input.mode === "review" && !isWrite(input) ? control : result,
      );
      expect(o["read-only"], JSON.stringify(control)).toMatchObject({ passed: false });
      expect(o["read-only"].negativeControl.operationAttempted).toBe(false);
      expect(o["workspace-write"].passed).toBe(true);
    }
  });

  test("CQ-03: a denied write reported as exit 0 fails; a landed write reported as exit 1 fails and records the file", async () => {
    const quiet = await sandboxRun({}, (input, result) =>
      input.mode === "review" && isWrite(input) ? { ...result, exitCode: 0 } : result,
    );
    expect(quiet["read-only"]).toMatchObject({ passed: false, meaning: "unknown" });
    expect(quiet["read-only"].negativeControl).toEqual({
      operationAttempted: true,
      trustedStateChecked: true,
      denied: true,
    });
    const lying = await sandboxRun({ FIXTURE_SANDBOX: "broken" }, (input, result) =>
      isWrite(input) && input.mode === "review" ? { ...result, exitCode: 1 } : result,
    );
    expect(lying["read-only"]).toMatchObject({ passed: false, meaning: "unsupported" });
    expect(lying["read-only"].detail).toContain("a file was created");
  });

  test("CQ-04: inside failure, wrong inside bytes, outside reported success, a landed outside write reported as denied, or a stray outside file each fail workspace-write", async () => {
    const insideFails = await sandboxRun({}, (input, result) =>
      input.mode === "edit" && target(input).includes("/workspace/") ? { ...result, exitCode: 1 } : result,
    );
    expect(insideFails["workspace-write"].passed).toBe(false);
    expect(insideFails["workspace-write"].detail).toContain("did not land");

    const wrongBytes = await sandboxRun({}, async (input, result) => {
      if (input.mode === "edit" && target(input).includes("/workspace/"))
        await writeFile(target(input), "inside\n");
      return result;
    });
    expect(wrongBytes["workspace-write"].passed).toBe(false);

    const outsideClaimsSuccess = await sandboxRun({}, (input, result) =>
      input.mode === "edit" && target(input).includes("/outside/") ? { ...result, exitCode: 0 } : result,
    );
    expect(outsideClaimsSuccess["workspace-write"]).toMatchObject({ passed: false });
    expect(outsideClaimsSuccess["workspace-write"].negativeControl.denied).toBe(true);

    const escaped = await sandboxRun({ FIXTURE_SANDBOX: "broken" }, (input, result) =>
      input.mode === "edit" && target(input).includes("/outside/") ? { ...result, exitCode: 1 } : result,
    );
    expect(escaped["workspace-write"]).toMatchObject({ passed: false, meaning: "unsupported" });
    expect(escaped["workspace-write"].negativeControl.denied).toBe(false);

    const stray = await sandboxRun({}, async (input, result) => {
      if (input.mode === "edit" && target(input).includes("/outside/"))
        await writeFile(path.join(path.dirname(target(input)), "unexpected.txt"), "x");
      return result;
    });
    expect(stray["workspace-write"]).toMatchObject({ passed: false });
    expect(stray["workspace-write"].detail).toContain("created a file");
    // Unrelated probes still ran in every variant.
    for (const o of [insideFails, wrongBytes, outsideClaimsSuccess, escaped, stray])
      expect(o["structured-turn"].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CQ-05: the reader grant after close and calls naming another turn or tool.
// ---------------------------------------------------------------------------
describe("CQ-05 reader probe grant boundaries", () => {
  test("reads under the probe grant succeed only for the active turn and declared tool; after close every call is refused", async () => {
    const parent = await qualificationParent();
    const probe = await createReaderProbe(path.join(parent, "reader"));
    cleanup.push(() => probe.close());
    const call = (overrides: Record<string, unknown> = {}) => ({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: probe.tools.toolset.namespace,
      tool: "read_range",
      arguments: { path: probe.path },
      ...overrides,
    });
    const session = { threadId: "thread-1", turnId: "turn-1", ended: false };
    const ok = await answerToolCall(probe.tools, call(), session);
    expect(ok.outcome).toBe("answered");
    expect(ok.result.text).toContain(probe.marker);
    expect(probe.markerReads()).toBe(1);
    for (const [label, foreign] of [
      ["another turn", call({ turnId: "turn-2" })],
      ["another thread", call({ threadId: "thread-9" })],
      ["another namespace", call({ namespace: "other" })],
      ["an undeclared tool", call({ tool: "write_file" })],
    ] as const) {
      const answer = await answerToolCall(probe.tools, foreign, session);
      expect(answer.outcome, label).toBe("refused");
      expect(answer.result.text, label).not.toContain(probe.marker);
    }
    expect(probe.markerReads()).toBe(1);
    const ended = await answerToolCall(probe.tools, call(), { ...session, ended: true });
    expect(ended).toMatchObject({ outcome: "refused", detail: "This run has ended." });
    probe.close();
    const afterClose = await answerToolCall(probe.tools, call(), session);
    expect(afterClose.outcome).not.toBe("answered");
    expect(afterClose.result.text).not.toContain(probe.marker);
    // markerReads() reads the probe's own store, which close() also closed.
  });
});

// ---------------------------------------------------------------------------
// CQ-06: an interrupt that does not end the turn interrupted.
// ---------------------------------------------------------------------------
describe.skipIf(!posix)("CQ-06 interrupt qualification", () => {
  test("an interrupt requested after streamed text whose turn reports completed does not qualify interrupt", async () => {
    const f = await setup();
    const { wrapped } = counted(f.adapter, {
      event: (method: string, payload: unknown) => {
        const event = f.adapter.event(method, payload);
        return event?.type === "completed" && event.status === "interrupted"
          ? { ...event, status: "completed" }
          : event;
      },
    });
    const report = await runCodexQualification({
      adapter: wrapped,
      installation: f.installation,
      model: "fixture-model",
      parent: f.parent,
    });
    const o = byName(report);
    expect(o.interrupt).toMatchObject({ passed: false, meaning: "unknown" });
    expect(o.interrupt.detail).toBe(
      "Interrupt requested after the reply's first streamed text; the turn ended completed.",
    );
    expect(
      f.frames().filter((e) => e.from === "topsl" && e.frame.method === "turn/interrupt"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CQ-07 / CQ-08 through the runtime manager.
// ---------------------------------------------------------------------------
describe.skipIf(!posix)("CQ-07 / CQ-08 recording, expiry, policy hash and model eligibility (POSIX shell stand-in)", () => {
  test("CQ-07: an executable changed during qualification records neither acceptance nor report", async () => {
    // The manager's own Codex adapter, except that the first model turn
    // changes the executable's bytes before it starts: a deterministic point
    // inside the qualification.
    const native = new CodexAdapter();
    let changed = false;
    const f = await launched("", (executable) => ({
      codex: wrap(native, {
        startTurn: async (...args: Parameters<CodexAdapter["startTurn"]>) => {
          if (!changed) {
            changed = true;
            await writeFile(executable, readFileSync(executable, "utf8") + "# changed\n");
          }
          return native.startTurn(...args);
        },
      }),
    }));
    const runtime = f.runtime;
    await expect(
      runtime.qualify(f.installation, { model: "fixture-model" }, await qualificationParent()),
    ).rejects.toThrow("The executable changed during qualification. Nothing was recorded.");
    expect(changed).toBe(true);
    // The suite itself ran to the end against the original process.
    expect(f.sent("turn/start")).toHaveLength(3);
    expect(runtime.acceptance.history(f.installation.id)).toEqual([]);
    expect(runtime.qualificationReports(f.installation.id)).toEqual([]);
    expect(runtime.readiness(f.installation, { installationId: f.installation.id, provider: "codex", model: "fixture-model" }, "implementer").ready).toBe(false);
  });

  test("CQ-08: the recorded acceptance expires exactly 30 days after recording: current 1 ms before, stale at the instant", async () => {
    const f = await launched();
    const result = await f.runtime.qualify(f.installation, { model: "fixture-model" }, await qualificationParent());
    const [record] = f.runtime.acceptance.history(f.installation.id);
    expect(record.expiresAt).toBe(result.expiresAt);
    expect(qualificationValidityDays).toBe(30);
    const span = Date.parse(result.expiresAt) - Date.parse(record.createdAt);
    // expiresAt is computed when the report is done, just before recording.
    expect(span).toBeLessThanOrEqual(30 * 86_400_000);
    expect(span).toBeGreaterThan(30 * 86_400_000 - 5_000);
    expect(f.readiness().ready).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(result.expiresAt) - 1);
    expect(f.readiness()).toMatchObject({ ready: true, freshness: { state: "current" } });
    vi.setSystemTime(Date.parse(result.expiresAt));
    const expired = f.readiness();
    expect(expired.ready).toBe(false);
    expect(expired.freshness.state).toBe("stale");
    vi.setSystemTime(Date.parse(result.expiresAt) + 86_400_000);
    expect(f.readiness().freshness.state).toBe("stale");
  });

  test("CQ-08: adding Codex `projects` entries keeps the acceptance current; any other config.toml change stales it", async () => {
    const f = await launched();
    const home = path.join(f.directory, "codex-home");
    await mkdir(home);
    vi.stubEnv("CODEX_HOME", home);
    const config = path.join(home, "config.toml");
    const settings = 'model = "fixture-model"\napproval_policy = "untrusted"\n';
    await writeFile(config, settings);
    await f.runtime.qualify(f.installation, { model: "fixture-model" }, await qualificationParent());
    expect(f.readiness().freshness.state).toBe("current");
    await writeFile(
      config,
      settings +
        '\n[projects."/work/one"]\ntrust_level = "trusted"\n\n[projects."/work/two"]\ntrust_level = "untrusted"\n',
    );
    expect(f.readiness()).toMatchObject({ ready: true, freshness: { state: "current" } });
    await writeFile(config, settings + 'sandbox_mode = "danger-full-access"\n');
    expect(f.readiness().freshness.state).toBe("stale");
    expect(f.readiness().ready).toBe(false);
    await writeFile(config, settings);
    expect(f.readiness().freshness.state).toBe("current");
  });

  test("CQ-08: selecting another eligible catalog model does not invalidate the capability cache; a model outside the catalog is blocked as a model setting", async () => {
    const f = await launched();
    f.catalog(["fixture-model", "fixture-other"]);
    await f.runtime.qualify(f.installation, { model: "fixture-model" }, await qualificationParent());
    expect(f.readiness("fixture-model").ready).toBe(true);
    const other = f.readiness("fixture-other");
    expect(other).toMatchObject({ ready: true, freshness: { state: "current" } });
    const missing = f.readiness("fixture-missing");
    expect(missing.ready).toBe(false);
    expect(missing.freshness.state).toBe("current");
    expect(missing.blockers.map((b) => b.code)).toEqual(["unsupported-model-setting"]);
  });
});
