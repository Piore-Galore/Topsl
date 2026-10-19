import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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
import { candidateFileBytes } from "../packages/workflows/candidates";
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
async function setup(inject = true, turnDelayMs = 20) {
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
            ]),
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
  // transport is injected; production keeps it gated (claudeStructuredGate).
  // Claude cannot review a candidate (next test), so Codex reviews.
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

test("a pinned Claude reviewer waits visibly: its adapter cannot host Topsl's candidate reader", async () => {
  const f = await setup();
  await enable(f);
  await roster(f, "coordinator", ["Opus", "Astra"]);
  await roster(f, "implementer", ["Opus"]);
  await roster(f, "reviewer", ["Opus", "Sol"]);
  const view = await startLoop(f);
  expect(view.run.state).toBe("waiting");
  expect(view.run.waitReason).toMatchObject({ kind: "pinned-model" });
  expect(view.run.waitReason!.detail).toContain("candidate-reader-unavailable");
  // The child goal never started, so no Claude review was dispatched and failed.
  expect(view.checkpoint!.sequence).toBe(0);
  expect(
    f.service.store
      .list<ExecutionAttempt>("attempt")
      .filter((a) => a.state === "failed"),
  ).toEqual([]);
  expect(memberTurns(f).filter((t) => !t.loop)).toEqual([]);
});
