import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import { hash, now, uid } from "../packages/domain/invariants";
import type { Installation } from "../packages/domain/types";
import type { Goal } from "../packages/domain/role-groups";
import type { ExecutionAttempt } from "../packages/domain/workflow";
import type { LoopRun } from "../packages/domain/recursive-loops";
import type { CandidateSnapshot } from "../packages/workflows/candidates";
import {
  candidateFileBytes,
  captureCandidate,
} from "../packages/workflows/candidates";
import type { TopslSession } from "../packages/domain/sessions";
import { fixture, gitExecutable } from "./helpers";

/**
 * Service-level Recursive Looping runs over the real runtime manager,
 * attempts, leases, concurrency budget, snapshot copies, capture,
 * integration, owned checkpoint copies and publication, with a scripted Codex
 * stand-in process (tests/fixtures/orchestration-answers.cjs). Model labels
 * are fixture catalog entries; nothing is evidence for a live provider or model.
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
const services: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});
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
async function setup(
  inject = true,
  turnDelayMs = 20,
  claudeStallOnce?: string,
) {
  const f = await fixture();
  f.store.close();
  const service = new Service(
    f.directory,
    f.key,
    () => {},
    true,
    inject
      ? {
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
              ...(claudeStallOnce
                ? ["--fixture-stall-once", claudeStallOnce]
                : []),
            ]),
            undefined,
            claudeStallOnce
              ? {
                  stall: { afterMessageMs: 300, silenceMs: 5_000, checkMs: 50 },
                }
              : {},
          ),
        }
      : undefined,
  );
  services.push({ service, directory: f.directory });
  const project = path.join(f.directory, "project");
  execFileSync("mkdir", ["-p", project]);
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
  return { ...f, service, project, claude };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync(gitExecutable, args, { cwd }).toString();

async function untilRun(
  service: Service,
  runId: string,
  done: (run: LoopRun) => boolean,
) {
  await vi
    .waitFor(
      async () => {
        await service.orchestration.tick();
        await service.loops.tick();
        expect(done(service.store.get<LoopRun>("loop-run", runId)!)).toBe(true);
      },
      { timeout: 240_000, interval: 100 },
    )
    .catch((error) => {
      const view = service.loops.view(runId);
      console.log(
        JSON.stringify(
          {
            run: view.run.detail,
            state: view.run.state,
            wait: view.run.waitReason,
            iterations: view.iterations.map((i) => [
              i.number,
              i.state,
              i.detail,
              i.failure,
            ]),
            child: view.current?.goal?.goal.detail,
            rounds: view.current?.rounds,
          },
          null,
          1,
        ),
      );
      throw error;
    });
  return service.loops.view(runId);
}

async function enable(f: Awaited<ReturnType<typeof setup>>) {
  await f.service.command({ type: "loop-feature-set", enabled: true });
}

test("Recursive Looping is off until the experimental flag is on", async () => {
  const f = await setup();
  await expect(
    f.service.command({
      type: "loop-create",
      projectId: "p",
      conversationId: null,
      mode: "goal",
      text: "Change the value to two.",
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow(/experimental and off/);
  expect(
    (await f.service.command({ type: "loop-query", projectId: "p" })).enabled,
  ).toBe(false);
});

test("a Goal loop runs through real attempts, owned checkpoints and publication without per-iteration approval", async () => {
  const f = await setup();
  await enable(f);
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode: "goal",
    text: "Change the value to two.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id;
  // Starting establishes authority; the window cannot do it without the native dialog.
  await expect(
    f.service.command({ type: "loop-start", runId, commandId: `c-${uid()}` }),
  ).rejects.toThrow(/native confirmation/);
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
    statements: string[];
  };
  expect(authority.statements.join(" ")).toMatch(/Topsl-owned copies/);
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  const view = await untilRun(f.service, runId, (r) =>
    ["completed", "waiting", "stopped"].includes(r.state),
  );
  expect(view.run.state).toBe("completed");
  expect(view.checkpoint!.sequence).toBe(1);
  expect(view.goals[0].status).toBe("satisfied");
  // The original folder is untouched until publication.
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );
  const head = f.service.store.get<CandidateSnapshot>(
    "candidate",
    view.checkpoint!.candidateId,
  )!;
  expect(
    candidateFileBytes(
      head,
      head.files.find((x) => x.path === "file.ts")!,
      f.service.store,
    )!.toString(),
  ).toContain("value = 2");
  // Machine promotion is not owner acceptance.
  const child = f.service.store.get<Goal>(
    "goal",
    view.iterations.find((i) => i.state === "promoted")!
      .childExecutionGoalIds[0],
  )!;
  expect(child.acceptance).toBeNull();
  expect(child.loopDisposition!.by).toBe("loop-policy");
  // Publication: native confirmation of the exact files, then read back.
  await expect(
    f.service.command({
      type: "loop-publication-apply",
      runId,
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow(/native confirmation/);
  const publication = (await f.service.review("loop-publication", runId)) as {
    digest: string;
    files: Array<{ path: string }>;
  };
  expect(publication.files.map((x) => x.path)).toEqual(["file.ts"]);
  await f.service.command(
    { type: "loop-publication-apply", runId, commandId: `c-${uid()}` },
    { digest: publication.digest },
  );
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 2;\n",
  );
  expect(git(f.project, "status", "--porcelain").trim()).toBe("M file.ts");
});

test("a loop in a native session starts from the session's accepted result, not the project folder", async () => {
  const f = await setup();
  await enable(f);
  const { sessionId } = await f.service.command({
    type: "session-create",
    projectId: "p",
    kind: "code",
    commandId: `c-${uid()}`,
  });
  // An accepted goal result the owner has not applied to the folder.
  const result = path.join(f.directory, "integrations", "session-goal");
  await mkdir(result, { recursive: true });
  await writeFile(path.join(result, "file.ts"), "export const value = 5;\n");
  const accepted = await captureCandidate(f.service.store, {
    root: result,
    projectId: "p",
    workflowId: "session-goal",
    selectedPaths: ["file.ts"],
    gitExecutable,
  });
  const session = f.service.store.get<TopslSession>("orch-session", sessionId)!;
  f.service.store.save("orch-session", {
    ...session,
    acceptedCheckpoint: {
      candidateId: accepted.id,
      goalId: "session-goal",
      runId: null,
      workItemId: "w",
      at: now(),
    },
  });
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: sessionId,
    mode: "goal",
    text: "Change the value to two.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id;
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
  };
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  const view = f.service.loops.view(runId);
  expect(view.run.setupConditions.join(" ")).toMatch(
    /Starts from the session's accepted result/,
  );
  const initial = f.service.store.get<CandidateSnapshot>(
    "candidate",
    view.checkpoint!.candidateId,
  )!;
  expect(
    candidateFileBytes(
      initial,
      initial.files.find((x) => x.path === "file.ts")!,
      f.service.store,
    )!.toString(),
  ).toBe("export const value = 5;\n");
  // The publication base is still the folder, which is unchanged.
  const base = f.service.store.get<CandidateSnapshot>(
    "candidate",
    view.run.publicationBaseCandidateId!,
  )!;
  expect(base.sourceRoot).toBe(f.project);
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );
  await f.service.command({
    type: "loop-control",
    runId,
    action: "stop",
    commandId: `c-${uid()}`,
  });
});

test("an Endless loop improves once, then monitors instead of completing", async () => {
  const f = await setup();
  await enable(f);
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode: "endless",
    text: "Keep improving the fixture. Prioritize correctness.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id;
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
  };
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  const view = await untilRun(
    f.service,
    runId,
    (r) => r.state === "monitoring",
  );
  expect(view.checkpoint!.sequence).toBe(1);
  expect(view.run.completedAt).toBeNull();
  expect(view.backlog.map((o) => o.state)).toEqual(["accepted"]);
  await f.service.command({
    type: "loop-control",
    runId,
    action: "stop",
    commandId: `c-${uid()}`,
  });
  const stopped = await untilRun(
    f.service,
    runId,
    (r) => r.state === "stopped",
  );
  expect(stopped.checkpoint!.sequence).toBe(1);
});

/** An exact roster of pinned members, set by the user for one built-in role. */
async function roster(
  f: Awaited<ReturnType<typeof setup>>,
  roleId: string,
  labels: string[],
) {
  await f.service.command({
    type: "orchestration-group-set",
    projectId: "p",
    goalId: null,
    level: "project-role",
    taskKey: null,
    mode: "replace",
    roleId,
    settings: {
      form: "exact",
      members: labels.map((label, i) => ({
        memberId: `${roleId}-${label.toLowerCase()}-${i}`,
        required: true,
        pin: { label },
        fallbacks: [],
        preferences: { providers: [], models: [] },
        source: { kind: "ui", reference: null, provenance: "explicit" },
      })),
    },
    commandId: `c-${uid()}`,
  });
}

async function startLoop(f: Awaited<ReturnType<typeof setup>>) {
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode: "goal",
    text: "Change the value to two.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id;
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
  };
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  return untilRun(f.service, runId, (r) =>
    ["completed", "waiting", "stopped"].includes(r.state),
  );
}
/** Each member turn of the run's loop rounds and child goals, by provider. */
function memberTurns(f: Awaited<ReturnType<typeof setup>>) {
  const attempts = new Map(
    f.service.store
      .list<ExecutionAttempt>("attempt")
      .map((a) => [a.id, a] as const),
  );
  type Contribution = {
    attemptId: string;
    memberId: string;
    validation: { state: string };
  };
  return [
    ...f.service.store
      .list<Contribution>("loop-contribution")
      .map((c) => ({ ...c, loop: true })),
    ...f.service.store
      .list<Contribution>("role-contribution")
      .map((c) => ({ ...c, loop: false })),
  ].map((c) => {
    const a = attempts.get(c.attemptId)!;
    return {
      loop: c.loop,
      member: c.memberId,
      provider: a.provider,
      requested: a.requestedModel,
      reported: a.reportedModel,
      validation: c.validation.state,
    };
  });
}

test("a Goal loop with Claude and Codex members on one team coordinates, implements, reviews and promotes", async () => {
  const f = await setup();
  await enable(f);
  // Claude's structured route is ready here only because the stand-in
  // transport is injected. In production it needs the owner's setting and a
  // current Claude qualification (tests/claude-route.test.ts). Here Codex
  // reviews; the next test pins a Claude reviewer.
  await roster(f, "coordinator", ["Opus", "Astra"]);
  await roster(f, "implementer", ["Opus"]);
  await roster(f, "reviewer", ["Sol"]);
  const view = await startLoop(f);
  expect(view.run.state).toBe("completed");
  expect(view.checkpoint!.sequence).toBe(1);
  expect(view.goals[0].status).toBe("satisfied");
  const head = f.service.store.get<CandidateSnapshot>(
    "candidate",
    view.checkpoint!.candidateId,
  )!;
  expect(
    candidateFileBytes(
      head,
      head.files.find((x) => x.path === "file.ts")!,
      f.service.store,
    )!.toString(),
  ).toContain("value = 2");

  // Every loop and child turn ran on the model its pinned member asked for,
  // and each provider did the work the roster gave it.
  const turns = memberTurns(f);
  for (const t of turns) {
    expect(t.validation).toBe("valid");
    expect(t.reported).toBe(t.requested);
    expect(t.provider).toBe(
      t.requested === "claude-opus-fixture" ? "claude" : "codex",
    );
  }
  const by = (role: string, provider: string, loop: boolean) =>
    turns.filter(
      (t) =>
        t.member.startsWith(`${role}-`) &&
        t.provider === provider &&
        t.loop === loop,
    ).length;
  // Loop decision rounds (boundary, organize, evaluate) went to both
  // coordinators; in the child goal both planned, Claude implemented and
  // Codex reviewed the integrated candidate.
  expect(by("coordinator", "claude", true)).toBeGreaterThan(0);
  expect(by("coordinator", "codex", true)).toBeGreaterThan(0);
  expect(by("coordinator", "claude", false)).toBeGreaterThan(0);
  expect(by("coordinator", "codex", false)).toBeGreaterThan(0);
  expect(by("implementer", "claude", false)).toBeGreaterThan(0);
  expect(by("implementer", "codex", false)).toBe(0);
  expect(by("reviewer", "codex", false)).toBeGreaterThan(0);
  // Machine promotion, not owner acceptance, on a mixed team too.
  const child = f.service.store.get<Goal>(
    "goal",
    view.iterations.find((i) => i.state === "promoted")!
      .childExecutionGoalIds[0],
  )!;
  expect(child.acceptance).toBeNull();
  expect(child.loopDisposition!.by).toBe("loop-policy");
});

test("a pinned Claude reviewer reviews the candidate through Topsl's candidate reader", async () => {
  const f = await setup();
  await enable(f);
  await roster(f, "coordinator", ["Opus", "Astra"]);
  await roster(f, "implementer", ["Opus"]);
  await roster(f, "reviewer", ["Opus", "Sol"]);
  const view = await startLoop(f);
  expect(view.run.state).toBe("completed");
  expect(view.goals[0].status).toBe("satisfied");
  const turns = memberTurns(f);
  expect(
    turns.filter(
      (t) =>
        t.member.startsWith("reviewer-") && t.provider === "claude" && !t.loop,
    ).length,
  ).toBeGreaterThan(0);
  // Each Claude review called the reader through Topsl's MCP server, and
  // Topsl answered it under the review attempt's grant.
  const claudeRuns = new Set(
    f.service.store
      .list<{ id: string; provider: string }>("run")
      .filter((r) => r.provider === "claude")
      .map((r) => r.id),
  );
  const calls = f.service.store.db
    .prepare("SELECT body FROM events WHERE kind = 'run.tool-call'")
    .all()
    .map((row: any) => JSON.parse(row.body))
    .filter((call) => claudeRuns.has(call.runId));
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls)
    expect(call).toMatchObject({
      namespace: "topsl_candidate",
      tool: "list",
      outcome: "answered",
    });
});

test("a stalled Claude coordinator turn is stopped, recorded as failed and retried, and the loop completes", async () => {
  const stallFile = path.join(
    await mkdtemp(path.join(os.tmpdir(), "topsl-stall-")),
    "stalled",
  );
  const f = await setup(true, 20, stallFile);
  await enable(f);
  await roster(f, "coordinator", ["Opus", "Astra"]);
  await roster(f, "implementer", ["Opus"]);
  await roster(f, "reviewer", ["Sol"]);
  const view = await startLoop(f);
  expect(view.run.state).toBe("completed");
  // Exactly one Claude turn stalled; it ended failed, not uncertain, so no
  // lease was left held and the member was retried.
  expect(existsSync(stallFile)).toBe(true);
  const runs = f.service.store.list<{
    provider: string;
    status: string;
    error: string | null;
  }>("run");
  const stalled = runs.filter((r) => r.error?.includes("stalled"));
  expect(stalled).toHaveLength(1);
  expect(stalled[0]).toMatchObject({ provider: "claude", status: "failed" });
  expect(stalled[0].error).toContain("after the model's message ended");
  expect(runs.filter((r) => r.status === "uncertain")).toEqual([]);
});
