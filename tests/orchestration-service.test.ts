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
async function setup(inject = true) {
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
                nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
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
      { timeout: 60_000, interval: 100 },
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
  const f = await setup();
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
