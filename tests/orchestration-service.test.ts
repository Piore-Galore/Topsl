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
import type { Goal, RoleRound } from "../packages/domain/role-groups";
import type { CandidateSnapshot } from "../packages/workflows/candidates";
import { candidateFileBytes } from "../packages/workflows/candidates";
import { fixture, gitExecutable } from "./helpers";

/**
 * Service-level coordinator runs over the real runtime manager, attempts,
 * leases, concurrency budget, snapshot copies, capture and integration, with
 * a scripted Codex stand-in process. Model labels here are fixture catalog
 * entries; nothing is evidence for a live provider or model.
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
              path.resolve("tests/fixtures/claude.cjs"),
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
  return { ...f, service, project, claude };
}
async function untilGoal(service: Service, goalId: string, states: string[]) {
  await vi
    .waitFor(
      async () => {
        await service.orchestration.tick();
        expect(states).toContain(
          service.store.get<Goal>("goal", goalId)!.state,
        );
      },
      { timeout: 180_000, interval: 100 },
    )
    .catch((error) => {
      const view = service.orchestration.goalView(goalId);
      console.log(
        JSON.stringify(
          {
            goal: view.goal.detail,
            actions: view.actions.map((a: any) => [
              a.taskKey,
              a.state,
              a.detail,
            ]),
            rounds: view.rounds.map((r: any) => ({
              kind: r.kind,
              stage: r.stage,
              detail: r.detail,
              members: r.members.map((m: any) => [
                m.memberId,
                m.state,
                m.detail,
                m.latestValidation,
                m.attemptIds.map(
                  (id: string) => service.store.get<any>("attempt", id)?.state,
                ),
              ]),
            })),
          },
          null,
          1,
        ),
      );
      throw error;
    });
  return service.store.get<Goal>("goal", goalId)!;
}

test("a two-coordinator, two-reviewer goal runs through real attempts, copies, capture and one acceptance", async () => {
  // Turns stay open for 2.5 s, so both coordinators of one wave are
  // provably running at once even on slow hosted runners; 20 ms was not
  // enough on macOS Intel and Windows.
  const f = await setup(true, 2500);
  const conversation = await f.service.command({
    type: "orchestration-conversation-create",
    projectId: "p",
    title: "",
    commandId: `c-${uid()}`,
  });
  const posted = await f.service.command({
    type: "orchestration-message",
    conversationId: conversation.id,
    text: "Change the value to two. Coordinate with Astra and Sol. Review with Astra and Sol.",
    goalId: null,
    routing: "auto",
    kind: "code",
    commandId: `c-${uid()}`,
  });
  const goal = await untilGoal(f.service, posted.goal.id, [
    "awaiting-acceptance",
    "blocked",
  ]);
  expect(goal.detail).toContain("awaits your acceptance");
  const rounds = f.service.orchestration.rounds(goal.id);
  const coordination = rounds.find(
    (r: RoleRound) => r.kind === "coordination",
  )!;
  expect(coordination.members.map((m) => m.model)).toEqual([
    "fixture-astra",
    "fixture-sol",
  ]);
  // Each member turn is an ordinary attempt with its own session binding.
  const sessions = f.service.orchestration.repo.all<{
    memberId: string;
    sessionId: string;
    purpose: string;
  }>("member-session", "p");
  const initial = sessions.filter(
    (s) => s.purpose === "coordinator-contribution",
  );
  expect(new Set(initial.map((s) => s.sessionId)).size).toBe(2);
  const attempts = coordination.members
    .flatMap((m) => m.attemptIds)
    .map((id) => f.service.store.get<any>("attempt", id));
  expect(
    attempts.every((a) => a.state === "completed" && a.requestedModel),
  ).toBe(true);
  // With the stand-in declaring bounded fan-out, both coordinator attempts
  // were admitted in one wave and their lifetimes overlapped.
  expect(coordination.members.map((m) => m.wave)).toEqual([1, 1]);
  const [first, second] = attempts;
  expect(
    first.createdAt < second.finishedAt && second.createdAt < first.finishedAt,
  ).toBe(true);
  const tasks = attempts.map((a) => f.service.store.get<any>("task", a.taskId));
  expect(
    tasks.every(
      (t) =>
        t.role === "coordinator" &&
        t.workflowId === null &&
        t.state === "submitted",
    ),
  ).toBe(true);
  // The integrated candidate contains the implementer's permitted change.
  const candidate = f.service.store.get<CandidateSnapshot>(
    "candidate",
    goal.candidateId!,
  )!;
  const file = candidate.files.find((x) => x.path === "file.ts")!;
  expect(
    candidateFileBytes(candidate, file, f.service.store)!.toString(),
  ).toContain("value = 2");
  // The project folder itself is untouched until the owner applies the candidate.
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toContain(
    "value = 1",
  );
  const review = rounds.find((r: RoleRound) => r.kind === "review")!;
  expect(review.members.map((m) => m.state)).toEqual(["returned", "returned"]);
  expect(f.service.orchestration.goalView(goal.id).review!.result).toBe(
    "satisfied",
  );
  // Copies are removed and capacity is released once processes stopped.
  expect(
    f.service.orchestration.repo
      .all<{ state: string }>("orchestration-copy", "p")
      .every((c) => c.state === "processed"),
  ).toBe(true);
  expect(f.service.coordinator.concurrency.snapshot().active).toHaveLength(0);
  await expect(
    f.service.command({
      type: "orchestration-accept",
      goalId: goal.id,
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow(/native confirmation/);
  const digest = (
    f.service.review("goal-acceptance", goal.id) as { digest: string }
  ).digest;
  const accepted = await f.service.command(
    { type: "orchestration-accept", goalId: goal.id, commandId: `c-${uid()}` },
    { digest },
  );
  expect(accepted.state).toBe("accepted");
});

test("Claude's managed route stays gated outside fixtures: a pinned Claude member is unavailable, never substituted", async () => {
  const f = await setup(false);
  seedCatalog(f.service, f.claude, [["claude-opus-fixture", "Opus"]]);
  await f.service.command({
    type: "orchestration-group-set",
    projectId: "p",
    goalId: null,
    level: "project-role",
    taskKey: null,
    mode: "replace",
    roleId: "reviewer",
    settings: {
      form: "exact",
      members: [
        {
          memberId: "opus",
          required: true,
          pin: { label: "Opus" },
          fallbacks: [],
          preferences: { providers: [], models: [] },
          source: { kind: "ui", reference: null, provenance: "explicit" },
        },
      ],
    },
    commandId: `c-${uid()}`,
  });
  const resolved = f.service.orchestration.resolve("p", null, "reviewer");
  expect(resolved.assignments[0]).toMatchObject({
    memberId: "opus",
    status: "unavailable",
    model: null,
  });
  expect(resolved.assignments[0].reason).toContain(
    "authentication-route-unapproved",
  );
  const view = f.service.orchestration.view("p");
  const claude = view.routes.find(
    (r: { provider: string }) => r.provider === "claude",
  )!;
  expect(claude.purposes["coordinator-contribution"]!.ready).toBe(false);
});

const valueCheck = {
  id: "value-check",
  label: "value is two",
  executable: process.execPath,
  args: [
    "-e",
    'if(!require("fs").readFileSync("file.ts","utf8").includes("value = 2"))process.exit(1)',
  ],
  timeoutMs: 30_000,
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(gitExecutable, args, { cwd }).toString();
async function post(
  f: Awaited<ReturnType<typeof setup>>,
  text: string,
  checks: unknown[] = [],
) {
  const conversation = await f.service.command({
    type: "orchestration-conversation-create",
    projectId: "p",
    title: "",
    commandId: `c-${uid()}`,
  });
  return f.service.command({
    type: "orchestration-message",
    conversationId: conversation.id,
    text,
    goalId: null,
    routing: "auto",
    kind: "code",
    checks,
    commandId: `c-${uid()}`,
  } as any);
}

test("a required check runs against the exact integrated candidate, gates acceptance, and the accepted candidate is applied to a clean folder", async () => {
  const f = await setup();
  const posted = await post(f, "Change the value to two.", [valueCheck]);
  let goal = await untilGoal(f.service, posted.goal.id, [
    "checking",
    "blocked",
  ]);
  expect(goal.state).toBe("checking");
  // The review group is satisfied, but acceptance waits for the check.
  expect(f.service.orchestration.goalView(goal.id).review!.result).toBe(
    "satisfied",
  );
  const acceptanceBefore = f.service.review("goal-acceptance", goal.id) as any;
  await expect(
    f.service.command(
      {
        type: "orchestration-accept",
        goalId: goal.id,
        commandId: `c-${uid()}`,
      },
      { digest: acceptanceBefore.digest },
    ),
  ).rejects.toThrow(/stale|not completed/);
  const plans: any[] = await f.service.command({
    type: "orchestration-checks-preview",
    goalId: goal.id,
  });
  expect(plans).toHaveLength(1);
  expect(plans[0].candidateId).toBe(goal.candidateId);
  expect(plans[0].workflowId).toBe(goal.id);
  await expect(
    f.service.command({ type: "orchestration-check-apply", id: plans[0].id }),
  ).rejects.toThrow(/native approval/);
  goal = await f.service.command(
    { type: "orchestration-check-apply", id: plans[0].id },
    { digest: plans[0].digest },
  );
  expect(goal.state).toBe("awaiting-acceptance");
  const tester = f.service.store.get<any>("task", goal.checkTaskId!);
  expect(tester).toMatchObject({ role: "tester", workflowId: null });
  const verification = f.service.store
    .list<any>("verification")
    .find((v) => v.taskId === tester.id)!;
  expect(verification).toMatchObject({
    candidateId: goal.candidateId,
    definition: "value-check",
    result: "passed",
  });
  const acceptance = f.service.review("goal-acceptance", goal.id) as any;
  expect(acceptance.checks).toEqual([
    {
      definition: "value-check",
      label: "value is two",
      result: "passed",
      targetRevision: acceptance.targetRevision,
    },
  ]);
  goal = await f.service.command(
    { type: "orchestration-accept", goalId: goal.id, commandId: `c-${uid()}` },
    { digest: acceptance.digest },
  );
  expect(goal.state).toBe("accepted");
  // Acceptance alone leaves the folder untouched.
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toContain(
    "value = 1",
  );
  // An untracked file makes the folder dirty: no confirmation is offered.
  await writeFile(path.join(f.project, "scratch.txt"), "notes\n");
  await expect(f.service.review("goal-application", goal.id)).rejects.toThrow(
    /uncommitted or untracked changes \(scratch\.txt\)/,
  );
  await rm(path.join(f.project, "scratch.txt"));
  // A new commit changes the folder's basis: also refused.
  await writeFile(path.join(f.project, "other.ts"), "export {};\n");
  git(f.project, "add", "other.ts");
  git(
    f.project,
    "-c",
    "user.email=f@example.test",
    "-c",
    "user.name=Fixture",
    "commit",
    "-qm",
    "other",
  );
  await expect(f.service.review("goal-application", goal.id)).rejects.toThrow(
    /changed since the goal's baseline/,
  );
  git(f.project, "reset", "-q", "--hard", "HEAD~1");
  const application = (await f.service.review(
    "goal-application",
    goal.id,
  )) as any;
  expect(application.files).toEqual([{ path: "file.ts", change: "modified" }]);
  await expect(
    f.service.command({
      type: "orchestration-apply",
      goalId: goal.id,
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow(/native confirmation/);
  goal = await f.service.command(
    { type: "orchestration-apply", goalId: goal.id, commandId: `c-${uid()}` },
    { digest: application.digest },
  );
  expect(goal.application).toMatchObject({
    state: "applied",
    files: [{ path: "file.ts", change: "modified" }],
  });
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 2;\n",
  );
  // Written, not committed.
  expect(git(f.project, "status", "--porcelain")).toContain(" M file.ts");
  await expect(f.service.review("goal-application", goal.id)).rejects.toThrow(
    /already applied/,
  );
});

test("two implementers' different versions of one file conflict; the owner's per-file choice is integrated and reviewed", async () => {
  const f = await setup();
  await f.service.command({
    type: "orchestration-group-set",
    projectId: "p",
    goalId: null,
    level: "project-role",
    taskKey: null,
    mode: "replace",
    roleId: "implementer",
    settings: {
      form: "exact",
      collaboration: "parallel-independent",
      members: ["astra", "sol"].map((name) => ({
        memberId: `implementer-${name}`,
        required: true,
        pin: { label: name === "astra" ? "Astra" : "Sol" },
        fallbacks: [],
        preferences: { providers: [], models: [] },
        source: { kind: "ui", reference: null, provenance: "explicit" },
      })),
    },
    commandId: `c-${uid()}`,
  });
  const posted = await post(f, "Change the value to two [distinct versions].");
  let goal = await untilGoal(f.service, posted.goal.id, ["blocked"]);
  const view = f.service.orchestration.goalView(goal.id);
  expect(view.conflicts).toHaveLength(1);
  expect(view.conflicts[0].path).toBe("file.ts");
  expect(view.conflicts[0].options.map((o: any) => o.memberId).sort()).toEqual([
    "implementer-astra",
    "implementer-sol",
  ]);
  const sol = view.conflicts[0].options.find(
    (o: any) => o.memberId === "implementer-sol",
  )!;
  goal = await f.service.command({
    type: "orchestration-conflict-resolve",
    goalId: goal.id,
    resolutions: [{ path: "file.ts", candidateId: sol.candidateId }],
    commandId: `c-${uid()}`,
  });
  expect(goal.state).toBe("running");
  goal = await untilGoal(f.service, goal.id, ["awaiting-acceptance"]);
  const candidate = f.service.store.get<CandidateSnapshot>(
    "candidate",
    goal.candidateId!,
  )!;
  const file = candidate.files.find((x) => x.path === "file.ts")!;
  expect(candidateFileBytes(candidate, file, f.service.store)!.toString()).toBe(
    "export const value = 2; // by implementer-sol\n",
  );
  const review = f.service.orchestration
    .rounds(goal.id)
    .filter((r: RoleRound) => r.kind === "review")
    .at(-1)!;
  expect(review.input.candidateId).toBe(goal.candidateId);
});
