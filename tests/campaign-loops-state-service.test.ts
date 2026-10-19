import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import { hash, now, uid } from "../packages/domain/invariants";
import { commandSchema } from "../packages/domain/commands";
import type { Installation } from "../packages/domain/types";
import type {
  LoopRun,
  PublicationCursor,
} from "../packages/domain/recursive-loops";
import type { CandidateSnapshot } from "../packages/workflows/candidates";
import { candidateFileBytes } from "../packages/workflows/candidates";
import { RuntimeLoopDriver } from "../packages/orchestration/loop-checkpoints";
import { fixture, gitExecutable } from "./helpers";

/**
 * Campaign 2026-10-19, packet p6b-loops-state-ops, service layer: Recursive
 * Looping through the real Service, runtime manager, attempts, owned
 * checkpoint copies and publication into a real Git folder, with the scripted
 * Codex stand-in process (tests/fixtures/codex-orchestration.cjs), as
 * tests/loop-service.test.ts sets it up. Publication results are checked
 * against independent SHA-256 hashes of the disk bytes and Git's own index.
 * Nothing here is evidence for a live provider, a packaged build or the
 * Electron UI.
 */
class FixtureCodex extends CodexAdapter {
  override capabilities(installation: Installation) {
    return [
      ...super.capabilities(installation),
      {
        name: "native-fanout-disabled",
        route: "structured" as const,
        support: "enforceable" as const,
        versions: [],
        testedPlatforms: ["fixture"],
        restrictions: [],
        evidence: {
          level: "source-observation" as const,
          source: "fixture",
          observedAt: now(),
          detail: "Dependency-injected local fixture only",
        },
      },
    ].map((capability) => ({
      ...capability,
      support: "enforceable" as const,
      testedPlatforms: ["fixture"],
      evidence: {
        ...capability.evidence,
        level: "source-observation" as const,
        detail: "Dependency-injected local fixture only",
      },
    }));
  }
}

const services: Array<{ service: () => Service; directory: string }> = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    await s
      .service()
      .close()
      .catch(() => {});
    await rm(s.directory, { recursive: true, force: true });
  }
});

function adapters(turnDelayMs: number) {
  return {
    codex: new FixtureCodex(
      (_executable, cwd) =>
        new RpcPeer(
          process.execPath,
          [path.resolve("tests/fixtures/codex-orchestration.cjs")],
          cwd,
          nativeEnvironment({
            ELECTRON_RUN_AS_NODE: "1",
            FIXTURE_TURN_DELAY_MS: String(turnDelayMs),
          }),
        ),
    ),
    claude: new ClaudeAdapter(
      claudeFixtureTransport(process.execPath, [
        path.resolve("tests/fixtures/claude-orchestration.cjs"),
      ]),
    ),
  };
}

function seedCatalog(
  service: Service,
  installation: Installation,
  models: Array<[string, string]>,
) {
  const accountKey = hash(`fixture-account:${installation.id}`);
  service.store.put("runtime-account-observation", {
    id: installation.id,
    account: {
      accountKey,
      profileId: hash(`profile:${installation.id}`),
      billingRoute: "native-subscription",
      sanitized: { type: "fixture", email: null, planType: null },
    },
    observedAt: now(),
  });
  service.store.put("runtime-model-catalog", {
    id: installation.id,
    runtimeRevision: installation.revisionId,
    executableIdentity: installation.identity,
    models: models.map(([model, name]) => ({
      id: model,
      model,
      name,
      description: "fixture",
      isDefault: false,
      supportedReasoningEfforts: [],
    })),
    observedAt: now(),
    accountKey,
  });
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(gitExecutable, args, { cwd }).toString();
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const diskHash = async (file: string) => sha256(await readFile(file));

async function setup(turnDelayMs = 20) {
  const f = await fixture();
  f.store.close();
  let service = new Service(
    f.directory,
    f.key,
    () => {},
    true,
    adapters(turnDelayMs),
  );
  services.push({ service: () => service, directory: f.directory });
  const project = path.join(f.directory, "project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "file.ts"), "export const value = 1;\n");
  for (const args of [
    ["init", "-q"],
    ["add", "file.ts"],
    [
      "-c",
      "user.email=f@example.test",
      "-c",
      "user.name=Fixture",
      "commit",
      "-qm",
      "base",
    ],
  ])
    execFileSync(gitExecutable, args, { cwd: project });
  service.store.put("project", {
    id: "p",
    name: "fixture",
    path: project,
    realPath: project,
    trusted: true,
    createdAt: now(),
  });
  service.store.put("installation", f.installation);
  const claude = {
    ...f.installation,
    id: "claude",
    appId: "anthropic.claude-code-cli",
  } satisfies Installation;
  service.store.put("installation", claude);
  seedCatalog(service, f.installation, [
    ["fixture-astra", "Astra"],
    ["fixture-sol", "Sol"],
  ]);
  seedCatalog(service, claude, [["claude-opus-fixture", "Opus"]]);
  return {
    ...f,
    project,
    get service() {
      return service;
    },
    /** Closes the service and opens a new one over the same profile, as a restart does. */
    async restart() {
      await service.close();
      service = new Service(
        f.directory,
        f.key,
        () => {},
        true,
        adapters(turnDelayMs),
      );
      await service.orchestration.recover();
      await service.loops.recover();
      return service;
    },
  };
}
type F = Awaited<ReturnType<typeof setup>>;

/** Sends a command through the same parser the service worker applies. */
const send = (
  f: F,
  command: Record<string, unknown>,
  trusted: { digest?: string } = {},
) => f.service.command(commandSchema.parse(command), trusted);

async function untilRun(
  f: F,
  runId: string,
  done: (run: LoopRun) => boolean,
  timeout = 240_000,
) {
  await vi.waitFor(
    async () => {
      await f.service.orchestration.tick();
      await f.service.loops.tick();
      expect(done(f.service.store.get<LoopRun>("loop-run", runId)!)).toBe(true);
    },
    { timeout, interval: 100 },
  );
  return f.service.loops.view(runId);
}

async function createAndStart(
  f: F,
  mode: "goal" | "endless" = "goal",
  policy: Record<string, unknown> = {},
) {
  await send(f, { type: "loop-feature-set", enabled: true });
  const created = await send(f, {
    type: "loop-create",
    projectId: "p",
    mode,
    text:
      mode === "goal"
        ? "Change the value to two."
        : "Keep improving the fixture.",
    policy: { scheduling: { reserveForDirectWork: 0 }, ...policy },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id as string;
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
  };
  await send(
    f,
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  return runId;
}

async function completedRun(f: F) {
  const runId = await createAndStart(f);
  const view = await untilRun(f, runId, (r) =>
    ["completed", "waiting", "stopped"].includes(r.state),
  );
  expect(view.run.state).toBe("completed");
  const head = f.service.store.get<CandidateSnapshot>(
    "candidate",
    view.checkpoint!.candidateId,
  )!;
  const bytes = candidateFileBytes(
    head,
    head.files.find((x) => x.path === "file.ts")!,
    f.service.store,
  )!;
  return { runId, view, headBytes: Buffer.from(bytes) };
}

const review = async (f: F, runId: string) =>
  (await f.service.review("loop-publication", runId)) as {
    digest: string;
    files: Array<{ path: string; change: string }>;
    problems: string[];
    basis: string;
  };
const apply = (f: F, runId: string, digest: string, commandId = `c-${uid()}`) =>
  send(f, { type: "loop-publication-apply", runId, commandId }, { digest });
const cursorOf = (f: F, runId: string) =>
  f.service.store.get<PublicationCursor>(
    "loop-publication-cursor",
    `${runId}:publication`,
  );
const publishedEvents = (f: F, runId: string) =>
  f.service.store
    .list<{ kind: string; runId: string }>("loop-event")
    .filter((e) => e.runId === runId && e.kind === "checkpoint-published");

// ---------------------------------------------------------------------------
// LOOP-13 on the real service flag

describe("LOOP-13 (service): experimental.recursiveLooping turned off while a run is active", () => {
  test("recorded fact: with the flag off the run stays inspectable and keeps running to completion, while loop-control is refused", async () => {
    const f = await setup(150);
    const runId = await createAndStart(f);
    await untilRun(
      f,
      runId,
      () => f.service.store.list<{ id: string }>("attempt").length > 0,
    );
    await send(f, { type: "loop-feature-set", enabled: false });
    const query = await send(f, { type: "loop-query", projectId: "p" });
    expect(query.enabled).toBe(false);
    expect(query.runs.map((r: { id: string }) => r.id)).toContain(runId);
    expect((await send(f, { type: "loop-inspect", runId })).run.id).toBe(runId);
    for (const action of ["stop", "pause"])
      await expect(
        send(f, {
          type: "loop-control",
          runId,
          action,
          commandId: `c-${uid()}`,
        }),
      ).rejects.toThrow(/experimental and off/);
    const attempts = f.service.store.list("attempt").length;
    const view = await untilRun(f, runId, (r) =>
      ["completed", "waiting", "stopped"].includes(r.state),
    );
    // Background work continued after the flag went off.
    expect(view.run.state).toBe("completed");
    expect(f.service.store.list("attempt").length).toBeGreaterThan(attempts);
    expect(view.run.desiredState).toBe("running");
  });

  // CAMPAIGN DEFECT LOOP-13: service loop-control is refused while experimental.recursiveLooping is off (LoopSupervisor.control assertEnabled), so an active run cannot be stopped from the service although it keeps running.
  test.fails(
    "Stop is accepted for an active run while the flag is off and the run reaches stopped",
    async () => {
      const f = await setup(150);
      const runId = await createAndStart(f);
      await untilRun(
        f,
        runId,
        () => f.service.store.list("attempt").length > 0,
      );
      await send(f, { type: "loop-feature-set", enabled: false });
      await send(f, {
        type: "loop-control",
        runId,
        action: "stop",
        commandId: `c-${uid()}`,
      });
      const view = await untilRun(f, runId, (r) =>
        ["stopped", "completed"].includes(r.state),
      );
      expect(view.run.state).toBe("stopped");
    },
  );
});

// ---------------------------------------------------------------------------
// STATE-08 / STATE-10: publication digest, drift and reconciliation on real Git

describe("STATE-08 / STATE-10 (service): publication binds the exact files to the current folder", () => {
  test("dirty, untracked, changed HEAD, relinked and drift-after-dialog folders are refused without writing; a clean publish writes exactly the accepted bytes and nothing is staged or committed", async () => {
    const f = await setup();
    const { runId, headBytes } = await completedRun(f);
    const file = path.join(f.project, "file.ts");
    const original = "export const value = 1;\n";
    const baseHead = git(f.project, "rev-parse", "HEAD").trim();
    expect(headBytes.toString()).toBe("export const value = 2;\n");
    const refused = async (label: string, problem: RegExp) => {
      // The native dialog is not offered for a folder that needs reconciliation...
      await expect(review(f, runId), label).rejects.toThrow(problem);
      // ...and a digest obtained from the preview still writes nothing.
      const preview = (await send(f, {
        type: "loop-publication-preview",
        runId,
      })) as { digest: string; problems: string[] };
      expect(preview.problems.join(" "), label).toMatch(problem);
      await expect(apply(f, runId, preview.digest), label).rejects.toThrow(
        /Nothing was written/,
      );
      expect(cursorOf(f, runId), label).toBeUndefined();
    };
    // Dirty tracked file: refused; the user's bytes are untouched.
    await writeFile(file, "export const value = 9;\n");
    await refused("dirty", /uncommitted or untracked changes \(file.ts\)/);
    expect(await readFile(file, "utf8")).toBe("export const value = 9;\n");
    git(f.project, "checkout", "--", "file.ts");
    // Untracked file: refused.
    await writeFile(path.join(f.project, "note.txt"), "mine\n");
    await refused("untracked", /uncommitted or untracked changes \(note.txt\)/);
    await rm(path.join(f.project, "note.txt"));
    // Changed HEAD (an unrelated commit): refused.
    await writeFile(path.join(f.project, "other.ts"), "x\n");
    git(f.project, "add", "other.ts");
    git(
      f.project,
      "-c",
      "user.email=f@example.test",
      "-c",
      "user.name=Fixture",
      "commit",
      "-qm",
      "unrelated",
    );
    await refused("changed HEAD", /changed since the run's publication base/);
    git(f.project, "reset", "-q", "--hard", baseHead);
    // Relinked project: refused.
    const project = f.service.store.get<{
      id: string;
      path: string;
      realPath: string;
    }>("project", "p")!;
    const elsewhere = path.join(f.directory, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    git(elsewhere, "init", "-q");
    f.service.store.put("project", {
      ...project,
      path: elsewhere,
      realPath: elsewhere,
    });
    await refused("relinked", /relinked to another folder/);
    f.service.store.put("project", project);
    // Drift after the dialog: the digest was confirmed, then the folder changed.
    const confirmed = await review(f, runId);
    expect(confirmed.problems).toEqual([]);
    expect(confirmed.files).toEqual([{ path: "file.ts", change: "modified" }]);
    await writeFile(file, "export const value = 7;\n");
    await expect(apply(f, runId, confirmed.digest)).rejects.toThrow(
      /Nothing was written/,
    );
    expect(await readFile(file, "utf8")).toBe("export const value = 7;\n");
    git(f.project, "checkout", "--", "file.ts");
    expect(await readFile(file, "utf8")).toBe(original);
    // An ignored file is not inspected by publication and is left alone.
    await writeFile(path.join(f.project, ".git", "info", "exclude"), "*.log\n");
    await writeFile(path.join(f.project, "ignored.log"), "ignored bytes\n");
    // A window-made digest never publishes.
    await expect(apply(f, runId, "forged")).rejects.toThrow(/stale/);
    expect(await readFile(file, "utf8")).toBe(original);
    // Clean publish: exact bytes by an independent hash; nothing staged or committed.
    const clean = await review(f, runId);
    expect(clean.problems).toEqual([]);
    const cursor = (await apply(f, runId, clean.digest)) as PublicationCursor;
    expect(await diskHash(file)).toBe(sha256(headBytes));
    expect(await diskHash(file)).toBe(sha256("export const value = 2;\n"));
    expect(cursor.manifest).toEqual([
      { path: "file.ts", hash: sha256("export const value = 2;\n") },
    ]);
    expect(cursor.state).toBe("published");
    expect(git(f.project, "rev-parse", "HEAD").trim()).toBe(baseHead);
    expect(git(f.project, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(git(f.project, "status", "--porcelain").trim()).toBe("M file.ts");
    expect(await readFile(path.join(f.project, "ignored.log"), "utf8")).toBe(
      "ignored bytes\n",
    );
    // The same checkpoint again is refused before any write.
    await expect(review(f, runId)).rejects.toThrow(/already published/);
    await expect(apply(f, runId, clean.digest)).rejects.toThrow(
      /already published/,
    );
    expect(publishedEvents(f, runId)).toHaveLength(1);
  });

  test("reconcile accepts a commit of the unchanged published bytes only; an untracked file or a changed published path needs a newly reviewed basis", async () => {
    const f = await setup();
    const { runId } = await completedRun(f);
    const file = path.join(f.project, "file.ts");
    const r = await review(f, runId);
    await apply(f, runId, r.digest);
    const commit = (message: string) =>
      git(
        f.project,
        "-c",
        "user.email=f@example.test",
        "-c",
        "user.name=Fixture",
        "commit",
        "-qam",
        message,
      );
    // An untracked user file blocks reconciliation (no implicit rebase).
    await writeFile(path.join(f.project, "note.txt"), "mine\n");
    commit("publish value two");
    await expect(
      send(f, {
        type: "loop-publication-reconcile",
        runId,
        commandId: `c-${uid()}`,
      }),
    ).rejects.toThrow(/newly reviewed target basis/);
    await rm(path.join(f.project, "note.txt"));
    const reconciled = (await send(f, {
      type: "loop-publication-reconcile",
      runId,
      commandId: `c-${uid()}`,
    })) as PublicationCursor;
    expect(reconciled.targetRevision).toBe(
      git(f.project, "rev-parse", "HEAD").trim(),
    );
    expect(reconciled.state).toBe("published");
    // A later commit that changes a published path is refused.
    await writeFile(file, "export const value = 3;\n");
    commit("my own change");
    await expect(
      send(f, {
        type: "loop-publication-reconcile",
        runId,
        commandId: `c-${uid()}`,
      }),
    ).rejects.toThrow(/file.ts no longer matches what Topsl published/);
    expect(cursorOf(f, runId)!.targetRevision).toBe(reconciled.targetRevision);
  });
});

// ---------------------------------------------------------------------------
// STATE-09 / J-10: interrupted publication on real Git, restart and reconcile

describe("STATE-09 / J-10 (service): an interrupted publication stays uncertain across restart and is never replayed", () => {
  test("a write that fails at the file is uncertain; every repeat is refused; restart keeps it; an explicit reconcile of the unchanged folder makes it retryable", async () => {
    const f = await setup();
    const { runId } = await completedRun(f);
    const file = path.join(f.project, "file.ts");
    // A read-only tracked file: Git sees no change, the write itself fails.
    await chmod(file, 0o444);
    expect(git(f.project, "status", "--porcelain").trim()).toBe("");
    const r = await review(f, runId);
    expect(r.problems).toEqual([]);
    const commandId = `c-${uid()}`;
    await expect(apply(f, runId, r.digest, commandId)).rejects.toThrow(
      /may have written files.*will not write it again/,
    );
    expect(cursorOf(f, runId)).toMatchObject({ state: "uncertain" });
    expect(cursorOf(f, runId)!.receipts.at(-1)).toMatchObject({
      outcome: "uncertain",
    });
    expect(await readFile(file, "utf8")).toBe("export const value = 1;\n");
    await chmod(file, 0o644);
    // The same command ID returns its recorded refusal; a new one is refused before writing.
    await expect(apply(f, runId, r.digest, commandId)).rejects.toThrow(
      /may have written files/,
    );
    await expect(apply(f, runId, r.digest)).rejects.toThrow(/unknown outcome/);
    expect(await readFile(file, "utf8")).toBe("export const value = 1;\n");
    // Restart: the uncertain intent is durable.
    await f.restart();
    await expect(review(f, runId)).rejects.toThrow(/unknown outcome/);
    expect(cursorOf(f, runId)!.state).toBe("uncertain");
    // The owner inspects the folder; nothing was written, so reconcile accepts it.
    const reconciled = (await send(f, {
      type: "loop-publication-reconcile",
      runId,
      commandId: `c-${uid()}`,
    })) as PublicationCursor;
    expect(reconciled.state).toBe("published");
    expect(reconciled.receipts.map((x) => x.outcome)).toEqual(["uncertain"]);
    const retry = await review(f, runId);
    await apply(f, runId, retry.digest);
    expect(await diskHash(file)).toBe(sha256("export const value = 2;\n"));
    expect(git(f.project, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  test("J-10: files written and read back, then the publication is interrupted before its receipt: restart shows uncertain, preview and apply refuse, reconcile refuses the changed folder, and nothing is staged or committed", async () => {
    const f = await setup();
    const { runId } = await completedRun(f);
    const file = path.join(f.project, "file.ts");
    const baseHead = git(f.project, "rev-parse", "HEAD").trim();
    const loop = (f.service.loops as unknown as { loop: any }).loop;
    const original = loop.publicationApply.bind(loop);
    loop.publicationApply = async (input: unknown) => {
      await original(input);
      throw new Error("the service was interrupted before the receipt");
    };
    const r = await review(f, runId);
    await expect(apply(f, runId, r.digest)).rejects.toThrow(
      /may have written files/,
    );
    // The bytes are on disk (an independent hash), the receipt is uncertain.
    expect(await diskHash(file)).toBe(sha256("export const value = 2;\n"));
    await f.restart();
    expect(cursorOf(f, runId)!.state).toBe("uncertain");
    await expect(review(f, runId)).rejects.toThrow(/unknown outcome/);
    await expect(apply(f, runId, r.digest)).rejects.toThrow(/unknown outcome/);
    await expect(
      send(f, {
        type: "loop-publication-reconcile",
        runId,
        commandId: `c-${uid()}`,
      }),
    ).rejects.toThrow(/newly reviewed target basis/);
    expect(cursorOf(f, runId)!.state).toBe("uncertain");
    expect(git(f.project, "rev-parse", "HEAD").trim()).toBe(baseHead);
    expect(git(f.project, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(git(f.project, "status", "--porcelain").trim()).toBe("M file.ts");
  });
});

// ---------------------------------------------------------------------------
// STATE-12 on the real service: two windows confirm the same publication

describe("STATE-12 (service): concurrent publication confirmations", () => {
  // CAMPAIGN DEFECT STATE-12: two concurrent loop-publication-apply commands for the same checkpoint both pass the "already published" check before either writes, so the increment is written twice with two receipts.
  test.fails(
    "two concurrent confirmations of the same checkpoint produce one write and one receipt",
    async () => {
      const f = await setup();
      const { runId } = await completedRun(f);
      const r = await review(f, runId);
      // Deterministic interleaving: the first write waits until a second
      // confirmation also reaches the write (the defect) or 3 s pass (a fixed
      // product refuses the second before it writes). Without this barrier the
      // race reproduced only on some runs (combined gate 2026-10-19T13:23Z).
      const original = RuntimeLoopDriver.prototype.publicationApply;
      let calls = 0;
      let release!: () => void;
      const second = new Promise<void>((resolve) => (release = resolve));
      const spy = vi
        .spyOn(RuntimeLoopDriver.prototype, "publicationApply")
        .mockImplementation(async function (this: RuntimeLoopDriver, input) {
          calls++;
          if (calls === 1)
            await Promise.race([second, new Promise((r) => setTimeout(r, 3000))]);
          else release();
          return original.call(this, input);
        });
      const results = await Promise.allSettled([
        apply(f, runId, r.digest),
        apply(f, runId, r.digest),
      ]).finally(() => spy.mockRestore());
      expect(publishedEvents(f, runId)).toHaveLength(1);
      expect(cursorOf(f, runId)!.receipts).toHaveLength(1);
      expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// OPS-05 (process layer): continuous Claude output is a separate runaway case

describe("OPS-05 (process): a Claude Code turn that streams continuously is not a stall", () => {
  async function standIn(ignoreSignals: boolean) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "topsl-campaign-ops05-"));
    const script = path.join(dir, "claude-continuous.cjs");
    await writeFile(
      script,
      `// Campaign stand-in: reads the prompt, then streams text deltas forever.
${ignoreSignals ? 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {});' : ""}
const session = process.argv[process.argv.indexOf("--session-id") + 1] || "s";
const event = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  event({ type: "system", subtype: "init", session_id: session, model: "claude-fixture-5", tools: [], mcp_servers: [], apiKeySource: "none", uuid: "init-1" });
  event({ type: "stream_event", session_id: session, event: { type: "message_start", message: { id: "m1", model: "claude-fixture-5" } }, uuid: "s0" });
  event({ type: "stream_event", session_id: session, event: { type: "content_block_start", index: 0, content_block: { type: "text" } }, uuid: "s1" });
  let n = 0;
  setInterval(() => event({ type: "stream_event", session_id: session, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }, uuid: "d" + n++ }), 30);
});
`,
    );
    return { dir, script };
  }

  const posix = process.platform !== "win32";
  /** Independent of Topsl's lifecycle evidence: signal 0 to a pid, or to a
   * POSIX process group as -pgid. "alive" or the errno code (ESRCH: gone). */
  const probe = (target: number) => {
    try {
      process.kill(target, 0);
      return "alive";
    } catch (error: any) {
      return String(error.code);
    }
  };
  // Whatever the assertions observe, never leave a runaway stand-in behind.
  const leftovers: Array<{ dir: string; pids: number[] }> = [];
  afterEach(async () => {
    for (const { dir, pids } of leftovers.splice(0)) {
      for (const pid of pids)
        try {
          process.kill(posix ? -pid : pid, "SIGKILL");
        } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  });
  const gone = posix ? ["ESRCH", "ESRCH"] : ["ESRCH"];
  const alive = posix ? ["alive", "alive"] : ["alive"];

  for (const ignoreSignals of [false, true])
    test(`continuous output outlives the stall limits until stopped${ignoreSignals ? "; a child ignoring SIGINT/SIGTERM is killed on close and its exit observed" : "; interrupt confirms the exit"}`, async () => {
      const { dir, script } = await standIn(ignoreSignals);
      const pids: number[] = [];
      const adapter = new ClaudeAdapter(undefined, undefined, {
        routeAllowed: () => true,
        stall: { afterMessageMs: 300, silenceMs: 800, checkMs: 50 },
        transport: (_executable, args, cwd) => {
          const child = spawn(process.execPath, [script, ...args], {
            cwd,
            env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
            detached: process.platform !== "win32",
          });
          pids.push(child.pid!);
          return child;
        },
      });
      leftovers.push({ dir, pids });
      const observe = () => {
        expect(pids).toHaveLength(1);
        return posix ? [probe(pids[0]), probe(-pids[0])] : [probe(pids[0])];
      };
      const connection = adapter.connect("claude", process.cwd());
      const turn = {
        prompt: "Reply with nothing else: OK",
        cwd: process.cwd(),
        requestedModel: "claude-fixture-5",
        mode: "review" as const,
        contextPackageId: null,
        attemptId: "attempt",
        workspaceIdentity: "workspace",
      };
      let completed: any = null;
      connection.onNotification = (_m: string, params: any) => {
        if (params.event.type === "completed") completed = params.event;
      };
      let exited: string | null = null;
      connection.onExit = (detail: string) => (exited = detail);
      const session = await adapter.startSession(connection, turn, null);
      const native = await adapter.startTurn(
        connection,
        turn,
        session.nativeSessionId,
      );
      // Three times the silence limit: still running, never reported stalled.
      await new Promise((r) => setTimeout(r, 2400));
      expect(completed).toBeNull();
      expect(exited).toBeNull();
      // Positive control: the same independent probe used after the stop
      // sees the streaming process and its group alive now.
      expect(observe()).toEqual(alive);
      await adapter.interrupt(
        connection,
        session.nativeSessionId,
        native.nativeTurnId,
      );
      if (!ignoreSignals) {
        // Stop reaches the runaway turn: its exit is observed, not assumed.
        await vi.waitFor(() => expect(exited).toMatch(/exit confirmed/), {
          timeout: 5_000,
          interval: 25,
        });
        // The confirmation matches the operating system: the pid and its
        // group are gone before Topsl's own close evidence is taken.
        expect(observe()).toEqual(gone);
      } else {
        // The child ignores the interrupt: no exit is claimed, and it is
        // in fact still running.
        await new Promise((r) => setTimeout(r, 500));
        expect(exited).toBeNull();
        expect(observe()).toEqual(alive);
      }
      const started = Date.now();
      const lifecycle = await connection.close();
      expect(lifecycle.state).toBe("quiescent");
      expect(lifecycle.exitedAt ?? lifecycle.closedAt).not.toBeNull();
      if (ignoreSignals) {
        // SIGTERM was ignored too; the bounded stop escalated to SIGKILL.
        expect(lifecycle.signal).toBe("SIGKILL");
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
      }
      // Independently of the lifecycle evidence: nothing is left running.
      expect(observe()).toEqual(gone);
      // No successful result was ever fabricated for the runaway turn.
      expect(completed).toBeNull();
      await rm(dir, { recursive: true, force: true });
    });
});
