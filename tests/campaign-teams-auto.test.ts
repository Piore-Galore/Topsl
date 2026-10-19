import { afterEach, describe, expect, test } from "vitest";
import type {
  DependencyBundle,
  Goal,
  ParticipantContribution,
  RoleRound,
} from "../packages/domain/role-groups";
import {
  completionPolicySchema,
  memberIntentSchema,
} from "../packages/domain/role-groups";
import { commandSchema } from "../packages/domain/commands";
import { kinds } from "../packages/orchestration/repository";
import {
  effectiveGroup,
  parseMembership,
} from "../packages/orchestration/membership";
import { builtInRoleDefinitions } from "../packages/orchestration/roles";
import {
  countsFor,
  evaluateDecision,
  freezePolicy,
  participation,
} from "../packages/orchestration/policy";
import { admit } from "../packages/orchestration/schedule";
import { resolveGroup } from "../packages/orchestration/selection";
import {
  defaultPlan,
  defaultReply,
  drive,
  orchestration,
  rosterPlan,
  route,
} from "./orchestration-fixture";

/**
 * Campaign packet p6a-teams-auto (2026-10-19): coordinator membership,
 * participation, decision and capacity boundaries (plan §5.7, §6.1) and the
 * J-04 journey at the local stand-in layer. Model labels are fixture catalog
 * entries; nothing here is evidence for a live provider, model or desktop UI.
 */

const open: Array<Awaited<ReturnType<typeof orchestration>>> = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
async function setup() {
  const f = await orchestration();
  open.push(f);
  return f;
}
type F = Awaited<ReturnType<typeof setup>>;
let counter = 0;
const cmd = () => `campaign-cmd-${++counter}`;
async function start(
  f: F,
  text: string,
  kind: Goal["kind"] = "code",
  checks: Array<{
    id: string;
    label: string;
    executable: string;
    args: string[];
    timeoutMs: number;
  }> = [],
) {
  const conversation = await f.orchestrator.createConversation({
    projectId: "p",
    title: "Main",
    commandId: cmd(),
  });
  const posted = await f.orchestrator.post({
    conversationId: conversation.id,
    text,
    commandId: cmd(),
    kind,
    checks,
  });
  return { conversation, goal: posted.goal! };
}
const rounds = (f: F, goalId: string, kind?: RoleRound["kind"]) =>
  f.orchestrator.rounds(goalId).filter((r) => !kind || r.kind === kind);
const goalOf = (f: F, id: string) =>
  f.orchestrator.repo.require<Goal>(kinds.goal, id);
const pinned = (memberId: string, pin: Record<string, unknown>) => ({
  memberId,
  required: true,
  pin,
  fallbacks: [] as Array<Record<string, unknown>>,
  preferences: { providers: [], models: [] },
  source: {
    kind: "ui" as const,
    reference: null,
    provenance: "explicit" as const,
  },
});
/** A route with N distinct fixture models m-1 … m-N. */
const wideRoute = (n: number) =>
  route(
    "codex",
    "wide-fixture",
    Array.from(
      { length: n },
      (_, i) => [`m-${i + 1}`, `Wide ${i + 1}`] as [string, string],
    ),
  );
const parse = (command: unknown) => commandSchema.safeParse(command).success;

// ---------------------------------------------------------------------------
// TEAM-02 and §6.1 per-role policy

describe("TEAM-02: member counts and the per-role policy", () => {
  test("TEAM-02: rosters of 1, 2, 3, 5, 8, 12 and 64 keep distinct stable identities; one above the policy is kept, explained and not run", async () => {
    const f = await setup();
    f.driver.routesList = [wideRoute(64)];
    for (const n of [1, 2, 3, 5, 8, 12, 64]) {
      const members = Array.from({ length: n }, (_, i) =>
        pinned(`r-${i + 1}`, { model: `m-${i + 1}` }),
      );
      // Negative control first: one below the requested size.
      if (n > 1) {
        const policy = f.orchestrator.repo.policy("p");
        f.orchestrator.repo.setPolicy({
          projectId: "p",
          expectedRevision: policy.revision,
          maxMembersPerRole: n - 1,
          defaults: {},
        });
        await f.orchestrator.setGroup({
          projectId: "p",
          goalId: null,
          level: "project-role",
          roleId: "reviewer",
          settings: { form: "exact", members },
          commandId: cmd(),
        });
        const over = f.orchestrator.resolve("p", null, "reviewer");
        expect(over.group.members).toHaveLength(n);
        expect(over.conflicts.join(" ")).toContain(
          `${n} members are requested, above the configured limit of ${n - 1}`,
        );
        expect(over.assignments).toHaveLength(n);
        expect(over.assignments.every((a) => a.status === "unresolved")).toBe(
          true,
        );
      }
      const policy = f.orchestrator.repo.policy("p");
      f.orchestrator.repo.setPolicy({
        projectId: "p",
        expectedRevision: policy.revision,
        maxMembersPerRole: Math.max(n, 1),
        defaults: {},
      });
      await f.orchestrator.setGroup({
        projectId: "p",
        goalId: null,
        level: "project-role",
        roleId: "reviewer",
        settings: { form: "exact", members },
        commandId: cmd(),
      });
      const first = f.orchestrator.resolve("p", null, "reviewer");
      expect(first.conflicts).toEqual([]);
      expect(first.assignments).toHaveLength(n);
      expect(first.assignments.every((a) => a.status === "resolved")).toBe(
        true,
      );
      expect(new Set(first.assignments.map((a) => a.memberId)).size).toBe(n);
      expect(new Set(first.assignments.map((a) => a.id)).size).toBe(n);
      expect(first.assignments.map((a) => a.model)).toEqual(
        members.map((m) => m.pin.model),
      );
      // Stable: resolving again (and from a reopened engine) keeps IDs and revisions.
      const again = f.reopen().resolve("p", null, "reviewer");
      expect(again.assignments.map((a) => [a.id, a.revision])).toEqual(
        first.assignments.map((a) => [a.id, a.revision]),
      );
    }
  });

  test("TEAM-02: twelve reviewers under policy 8 stay twelve and blocked across a restart, then all twelve run after the policy rises; width is not count", async () => {
    const f = await setup();
    const { goal } = await start(f, "Change the value. Use twelve reviewers.");
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 40,
      until: (s) => s === "reviewing",
    });
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 3,
      until: () => false,
    });
    expect(goalOf(f, goal.id).state).toBe("reviewing");
    expect(goalOf(f, goal.id).detail).toContain(
      "12 members are requested, above the configured limit of 8",
    );
    expect(rounds(f, goal.id, "review")).toHaveLength(0);
    expect(
      f.driver.launches.filter((l) => l.purpose === "candidate-review"),
    ).toHaveLength(0);
    // Restart: the over-policy request is persisted, not trimmed.
    const reopened = f.reopen();
    const kept = reopened.effective("p", goal.id, "reviewer");
    expect(kept.count).toBe(12);
    expect(kept.conflicts.join(" ")).toContain("limit of 8");
    await expect(
      Promise.resolve().then(() =>
        reopened.repo.setPolicy({
          projectId: "p",
          expectedRevision: 5,
          maxMembersPerRole: 12,
          defaults: {},
        }),
      ),
    ).rejects.toThrow(/changed/);
    reopened.repo.setPolicy({
      projectId: "p",
      expectedRevision: 0,
      maxMembersPerRole: 12,
      defaults: {},
    });
    expect(
      f.store.get<{ maxMembersPerRole: number; revision: number }>(
        kinds.policy,
        "p",
      ),
    ).toMatchObject({ maxMembersPerRole: 12, revision: 1 });
    expect(await drive(reopened, f.driver, goal.id, { maxSteps: 200 })).toBe(
      "awaiting-acceptance",
    );
    const review = rounds(f, goal.id, "review")[0];
    expect(review.members).toHaveLength(12);
    expect(new Set(review.members.map((m) => m.memberId)).size).toBe(12);
    expect(review.members.every((m) => m.state === "returned")).toBe(true);
    // Capacity two: twelve members in six waves, never more than two at once.
    expect(review.members.map((m) => m.wave)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    ]);
    expect(f.driver.maxRunning).toBe(2);
    expect(reopened.goalView(goal.id).review!.policy).toMatchObject({
      requiredReturned: 12,
      requiredTotal: 12,
    });
  });

  test("TEAM-02/§6.1: the policy accepts 1 and 64 and rejects 0, 1.5 and 65 at the public command and the store", async () => {
    const policy = (maxMembersPerRole: unknown) => ({
      type: "orchestration-policy-set",
      projectId: "p",
      expectedRevision: 0,
      maxMembersPerRole,
      commandId: "policy-command",
    });
    expect(parse(policy(1))).toBe(true);
    expect(parse(policy(64))).toBe(true);
    for (const bad of [0, -1, 1.5, 65, null, "8"])
      expect(parse(policy(bad))).toBe(false);
    const f = await setup();
    for (const bad of [0, 1.5, 65])
      expect(() =>
        f.orchestrator.repo.setPolicy({
          projectId: "p",
          expectedRevision: 0,
          maxMembersPerRole: bad,
          defaults: {},
        }),
      ).toThrow(/between 1 and 64/);
    // Nothing was stored by the refusals.
    expect(f.store.get(kinds.policy, "p")).toBeUndefined();
    f.orchestrator.repo.setPolicy({
      projectId: "p",
      expectedRevision: 0,
      maxMembersPerRole: 64,
      defaults: {},
    });
    expect(f.orchestrator.repo.policy("p").maxMembersPerRole).toBe(64);
  });

  test("§6.1: count/min/max/width reject 0, negatives, fractions and null count; 65 parses and is a policy conflict, never truncated to width", () => {
    const group = (settings: Record<string, unknown>) => ({
      type: "orchestration-group-set",
      projectId: "p",
      goalId: null,
      level: "project-role",
      taskKey: null,
      roleId: "reviewer",
      settings,
      mode: "replace",
      commandId: "group-command",
    });
    for (const field of ["count", "minCount", "maxCount", "executionWidth"]) {
      for (const bad of [0, -1, 1.5])
        expect(parse(group({ [field]: bad }))).toBe(false);
      for (const good of [1, 2, 64, 65])
        expect(parse(group({ [field]: good }))).toBe(true);
    }
    expect(parse(group({ count: null }))).toBe(false);
    expect(parse(group({ executionWidth: null }))).toBe(true);
    expect(parse(group({}))).toBe(true);
    const role = builtInRoleDefinitions.reviewer;
    const over = effectiveGroup({
      projectId: "p",
      goalId: null,
      role,
      memberLimit: 64,
      layers: [
        {
          level: "project-role",
          revisionId: "x",
          settings: { form: "auto", count: 65, executionWidth: 2 },
        },
      ],
    });
    expect(over.count).toBe(65);
    expect(over.executionWidth).toBe(2);
    expect(over.conflicts.join(" ")).toContain(
      "65 members are requested, above the configured limit of 64",
    );
    const fits = effectiveGroup({
      projectId: "p",
      goalId: null,
      role,
      memberLimit: 64,
      layers: [
        {
          level: "project-role",
          revisionId: "x",
          settings: { form: "auto", count: 64, executionWidth: 2 },
        },
      ],
    });
    expect(fits.conflicts).toEqual([]);
    expect(
      resolveGroup({
        role,
        group: fits,
        pool: [wideRoute(64)],
        complexity: "simple",
      }).assignments,
    ).toHaveLength(64);
    // A policy above the ceiling cannot be smuggled in through the resolver.
    expect(
      effectiveGroup({
        projectId: "p",
        goalId: null,
        role,
        memberLimit: 1000,
        layers: [],
      }).memberLimit,
    ).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// §6.1 membership identity and fallbacks (TEAM-03)

describe("§6.1 membership identity and fallbacks", () => {
  test("member IDs of 128 characters parse and 129 do not; invalid characters and duplicate IDs are refused before any member runs", async () => {
    const id128 = `a${"b".repeat(127)}`;
    const id129 = `a${"b".repeat(128)}`;
    expect(memberIntentSchema.safeParse({ memberId: id128 }).success).toBe(
      true,
    );
    expect(memberIntentSchema.safeParse({ memberId: id129 }).success).toBe(
      false,
    );
    for (const bad of ["", "-lead", "has space", "slash/id", "é"])
      expect(memberIntentSchema.safeParse({ memberId: bad }).success).toBe(
        false,
      );
    for (const good of ["A", "r1", "a_b.c:d-e"])
      expect(memberIntentSchema.safeParse({ memberId: good }).success).toBe(
        true,
      );
    // The public command refuses the 129-character ID too.
    const command = (memberId: string) => ({
      type: "orchestration-group-set",
      projectId: "p",
      goalId: null,
      level: "project-role",
      roleId: "reviewer",
      settings: {
        form: "exact",
        members: [{ memberId, pin: { label: "Sol" } }],
      },
      commandId: "group-command",
    });
    expect(parse(command(id128))).toBe(true);
    expect(parse(command(id129))).toBe(false);
    // Duplicate IDs are a conflict that blocks the role in a goal.
    const f = await setup();
    const { goal } = await start(f, "Change the value.");
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: goal.id,
      level: "goal-role",
      roleId: "reviewer",
      settings: {
        form: "exact",
        members: [
          pinned("same", { label: "Sol" }),
          pinned("same", { label: "Fable" }),
        ],
      },
      commandId: cmd(),
    });
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 40,
      until: (s) => s === "reviewing",
    });
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 3,
      until: () => false,
    });
    expect(goalOf(f, goal.id).detail).toContain(
      "Member IDs must be unique within a role",
    );
    expect(rounds(f, goal.id, "review")).toHaveLength(0);
  });

  test("eight fallbacks parse and nine do not; the first available fallback in authorized order is used and the primary pin stays as intent", () => {
    const fallbacks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ label: `Missing ${i + 1}` }));
    expect(
      memberIntentSchema.safeParse({
        memberId: "a",
        pin: { label: "Nebula" },
        fallbacks: fallbacks(8),
      }).success,
    ).toBe(true);
    expect(
      memberIntentSchema.safeParse({
        memberId: "a",
        pin: { label: "Nebula" },
        fallbacks: fallbacks(9),
      }).success,
    ).toBe(false);
    const role = builtInRoleDefinitions.reviewer;
    const pool = [
      route("claude", "c", [["claude-fable-fixture", "Fable"]]),
      route("codex", "x", [["sol-fixture", "Sol"]]),
    ];
    const resolve = (fb: Array<Record<string, unknown>>) =>
      resolveGroup({
        role,
        group: effectiveGroup({
          projectId: "p",
          goalId: "g",
          role,
          memberLimit: 8,
          layers: [
            {
              level: "goal-role",
              revisionId: "x",
              settings: {
                form: "exact",
                members: [
                  { ...pinned("m", { label: "Nebula" }), fallbacks: fb },
                ],
              },
            },
          ],
        }),
        pool,
        complexity: "simple",
      }).assignments[0];
    // Only the eighth fallback exists: it is used, in order, as a fallback.
    const eighth = resolve([...fallbacks(7), { label: "Sol" }]);
    expect(eighth).toMatchObject({
      status: "resolved",
      selection: "fallback",
      model: "sol-fixture",
      primaryPin: { label: "Nebula" },
    });
    // Order is authority: Fable before Sol yields Fable, Sol before Fable yields Sol.
    expect(resolve([{ label: "Fable" }, { label: "Sol" }]).model).toBe(
      "claude-fable-fixture",
    );
    expect(resolve([{ label: "Sol" }, { label: "Fable" }]).model).toBe(
      "sol-fixture",
    );
    // Negative control: no authorized fallback resolves, so nothing is substituted.
    const none = resolve(fallbacks(8));
    expect(none.status).not.toBe("resolved");
    expect(none.model).toBeNull();
  });

  test("TEAM-03: an unsupported effort or a retired label is unavailable with the exact field named; never replaced by another model", () => {
    const role = builtInRoleDefinitions.reviewer;
    const group = (members: ReturnType<typeof pinned>[]) =>
      effectiveGroup({
        projectId: "p",
        goalId: "g",
        role,
        memberLimit: 8,
        layers: [
          {
            level: "goal-role",
            revisionId: "x",
            settings: { form: "required-plus-auto", count: 5, members },
          },
        ],
      });
    const pool = [
      route("claude", "c", [
        ["claude-opus-fixture", "Opus"],
        ["claude-fable-fixture", "Fable"],
      ]),
      route("codex", "x", [
        ["astra-fixture", "Astra"],
        ["sol-fixture", "Sol"],
        ["vega-fixture", "Vega"],
      ]),
    ];
    const result = resolveGroup({
      role,
      group: group([
        pinned("effort", { label: "Sol", effort: "ultra" }),
        pinned("retired", { label: "Gemini Retired" }),
      ]),
      pool,
      complexity: "simple",
    });
    expect(result.assignments).toHaveLength(5);
    const effort = result.assignments.find((a) => a.memberId === "effort")!;
    expect(effort.status).toBe("unavailable");
    expect(effort.model).toBeNull();
    expect(effort.reason).toContain(
      "Effort ultra is not in the observed catalog",
    );
    const retired = result.assignments.find((a) => a.memberId === "retired")!;
    expect(retired).toMatchObject({ status: "unresolved", model: null });
    // Three Auto slots resolve independently; pins are not cloned into them.
    expect(
      result.assignments.filter(
        (a) => a.selection === "auto" && a.status === "resolved",
      ),
    ).toHaveLength(3);
    // Negative control: a supported effort resolves exactly.
    const ok = resolveGroup({
      role,
      group: group([pinned("effort", { label: "Sol", effort: "high" })]),
      pool,
      complexity: "simple",
    }).assignments[0];
    expect(ok).toMatchObject({
      status: "resolved",
      model: "sol-fixture",
      effort: "high",
    });
  });
});

// ---------------------------------------------------------------------------
// TEAM-01 roles and routes

describe("TEAM-03 (observation): an exact count above maxCount", () => {
  test("TEAM-03 (observation): count 5 with maxCount 3 at one scope is not reported as a conflict; the count wins", () => {
    // Recorded as an observed risk, not a confirmed defect: minCount > maxCount
    // is a conflict, but count > maxCount is silently resolved in favour of count.
    const role = builtInRoleDefinitions.reviewer;
    const group = effectiveGroup({
      projectId: "p",
      goalId: "g",
      role,
      memberLimit: 8,
      layers: [
        {
          level: "goal-role",
          revisionId: "x",
          settings: { form: "auto", count: 5, maxCount: 3 },
        },
      ],
    });
    expect(group).toMatchObject({ count: 5, maxCount: 3, conflicts: [] });
    expect(
      resolveGroup({
        role,
        group,
        pool: [wideRoute(8)],
        complexity: "simple",
      }).assignments,
    ).toHaveLength(5);
    // Negative control: minCount above maxCount is a conflict.
    expect(
      effectiveGroup({
        projectId: "p",
        goalId: "g",
        role,
        memberLimit: 8,
        layers: [
          {
            level: "goal-role",
            revisionId: "x",
            settings: { form: "auto", minCount: 4, maxCount: 3 },
          },
        ],
      }).conflicts,
    ).toEqual(["The minimum count 4 exceeds the maximum 3."]);
  });
});

describe("TEAM-01: any role on any qualified route", () => {
  test("TEAM-01: every built-in and a custom role take an exact Claude or Codex pin; an unqualified route is unavailable, never substituted", async () => {
    const f = await setup();
    await f.orchestrator.defineRole({
      projectId: "p",
      roleId: "accessibility",
      title: "Accessibility reviewers",
      instructions: "Review accessibility.",
      purpose: "candidate-review",
      commandId: cmd(),
    });
    const roles = f.orchestrator.repo.roles("p");
    expect(roles.map((r) => r.id)).toContain("accessibility");
    for (const role of roles) {
      for (const [provider, model] of [
        ["claude", "claude-opus-fixture"],
        ["codex", "astra-fixture"],
      ] as const) {
        const group = effectiveGroup({
          projectId: "p",
          goalId: "g",
          role,
          memberLimit: 8,
          layers: [
            {
              level: "goal-role",
              revisionId: "x",
              settings: {
                form: "exact",
                members: [
                  pinned("a", { provider, model }),
                  pinned("b", {
                    label: provider === "claude" ? "Fable" : "Sol",
                  }),
                  pinned("c", { label: "Vega" }),
                ],
              },
            },
          ],
        });
        const ok = resolveGroup({
          role,
          group,
          pool: f.driver.routesList,
          complexity: "simple",
        });
        expect(ok.assignments.map((a) => a.status)).toEqual([
          "resolved",
          "resolved",
          "resolved",
        ]);
        expect(ok.assignments[0]).toMatchObject({ provider, model });
        // The same pin on a route not qualified for this role's purpose.
        const blocked = resolveGroup({
          role,
          group,
          pool: f.driver.routesList.map((r) =>
            r.provider === provider
              ? route(
                  r.provider,
                  r.installationId,
                  r.catalog.models.map((m) => [m.model, m.name]),
                  { blocked: [role.purpose] },
                )
              : r,
          ),
          complexity: "simple",
        });
        // The requested pin stays as intent; no route, installation or
        // other model is substituted for it.
        expect(blocked.assignments[0]).toMatchObject({
          status: "unavailable",
          provider,
          model,
          route: null,
          installationRevision: null,
          catalog: null,
        });
        expect(blocked.assignments[0].reason).toContain(
          `not qualified for ${role.purpose}`,
        );
      }
    }
  });

  test("TEAM-01: swapping coordinator and reviewer providers, with three and five members, records the requested and reported model of every turn", async () => {
    for (const [text, coordinators, reviewers] of [
      [
        "Change the value. Use Opus, Fable and Astra as coordinators. Review with Sol and Vega.",
        ["claude-opus-fixture", "claude-fable-fixture", "astra-fixture"],
        ["sol-fixture", "vega-fixture"],
      ],
      [
        "Change the value. Coordinate with Astra. Use Opus, Fable, Sol, Vega and Lyra as reviewers.",
        ["astra-fixture"],
        [
          "claude-opus-fixture",
          "claude-fable-fixture",
          "sol-fixture",
          "vega-fixture",
          "lyra-fixture",
        ],
      ],
    ] as const) {
      const f = await setup();
      const { goal } = await start(f, text);
      expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
        "awaiting-acceptance",
      );
      expect(
        rounds(f, goal.id, "coordination")[0].members.map((m) => m.model),
      ).toEqual(coordinators);
      expect(
        rounds(f, goal.id, "review")[0].members.map((m) => m.model),
      ).toEqual(reviewers);
      // Every launched turn carries its frozen assignment, and every valid
      // contribution records the effective model the runtime reported.
      for (const r of rounds(f, goal.id)) {
        for (const m of r.members) {
          const launches = f.driver.launches.filter(
            (l) => l.roundId === r.id && l.memberId === m.memberId,
          );
          expect(launches.length).toBeGreaterThan(0);
          for (const l of launches) {
            expect(l.assignment.model).toBe(m.model);
            expect(l.assignment.id).toBe(m.assignmentId);
          }
        }
        for (const c of f.orchestrator.contributions(r.id, "p"))
          expect(c.reportedModel).toBe(
            r.members.find((m) => m.memberId === c.memberId)!.model,
          );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TEAM-04 and TEAM-06 participation and decisions

describe("TEAM-06: participation and decision rule for five members", () => {
  const roundOf = (
    policy: Partial<ReturnType<typeof completionPolicySchema.parse>>,
    required = [true, true, true, true, true],
  ) => {
    const members = required.map((r, i) => ({
      memberId: `m${i + 1}`,
      required: r,
    }));
    const frozen = freezePolicy(completionPolicySchema.parse(policy), members);
    return {
      round: {
        id: "round",
        input: { digest: "input-digest" },
        members: members.map((m) => ({
          ...m,
          assignmentId: `a-${m.memberId}`,
          assignmentRevision: 1,
        })),
        ...frozen,
      } as unknown as RoleRound,
      conflicts: frozen.conflicts,
    };
  };
  const vote = (
    memberId: string,
    stance: "endorse" | "challenge" | "abstain",
    extra: Record<string, unknown> = {},
  ) => ({
    id: `${memberId}-${stance}-${Math.random()}`,
    projectId: "p",
    roundId: "round",
    candidateId: "c",
    candidateDigest: "d",
    memberId,
    assignmentId: `a-${memberId}`,
    contributionId: "x",
    stance,
    rationale: "",
    implied: false,
    createdAt: "",
    ...extra,
  });
  const contribution = (
    memberId: string,
    extra: Partial<ParticipantContribution> = {},
  ) =>
    ({
      id: `c-${memberId}-${Math.random()}`,
      projectId: "p",
      goalId: "g",
      roundId: "round",
      memberId,
      assignmentId: `a-${memberId}`,
      assignmentRevision: 1,
      attemptId: "att",
      phase: "initial",
      output: {},
      validation: { state: "valid", reason: "" },
      inputDigest: "input-digest",
      reportedModel: "m",
      provenance: {} as never,
      createdAt: "",
      ...extra,
    }) as ParticipantContribution;

  test("TEAM-06: all = 5, count 3 = 3, fraction 2/3 = ceil(10/3) = 4; the frozen denominator never shrinks", () => {
    expect(roundOf({ threshold: { kind: "all" } }).round.threshold).toBe(5);
    expect(
      roundOf({ threshold: { kind: "count", count: 3 } }).round.threshold,
    ).toBe(3);
    const { round } = roundOf({
      threshold: { kind: "fraction", numerator: 2, denominator: 3 },
    });
    expect(round.threshold).toBe(4);
    expect(round.electorateIds).toHaveLength(5);
    const three = evaluateDecision(round, "d", [
      vote("m1", "endorse"),
      vote("m2", "endorse"),
      vote("m3", "endorse"),
    ]);
    expect(three).toMatchObject({
      passes: false,
      impossible: false,
      endorsements: 3,
      electorate: 5,
      threshold: 4,
    });
    expect(
      evaluateDecision(round, "d", [
        vote("m1", "endorse"),
        vote("m2", "endorse"),
        vote("m3", "endorse"),
        vote("m4", "endorse"),
      ]).passes,
    ).toBe(true);
    // An abstention and a challenge do not shrink the electorate: 3 + 0 pending < 4.
    expect(
      evaluateDecision(round, "d", [
        vote("m1", "endorse"),
        vote("m2", "endorse"),
        vote("m3", "endorse"),
        vote("m4", "abstain"),
        vote("m5", "challenge"),
      ]),
    ).toMatchObject({
      passes: false,
      impossible: true,
      electorate: 5,
      abstentions: 1,
      challenges: 1,
    });
    // count greater than the electorate is a policy conflict, not a silent cap.
    expect(
      roundOf({ threshold: { kind: "count", count: 6 } }).conflicts,
    ).toEqual([
      "The decision needs 6 endorsements, but the electorate has 5 members.",
    ]);
    expect(
      roundOf({ requiredEndorserIds: ["m9"] }).conflicts.join(" "),
    ).toContain("m9");
    // §6.1: retries per member and reconciliation turns are integers 0–5.
    for (const field of ["retriesPerMember", "reconciliationTurns"])
      expect(
        [-1, 0, 5, 6, 1.5].map(
          (v) => completionPolicySchema.safeParse({ [field]: v }).success,
        ),
      ).toEqual([false, true, true, false, false]);
  });

  test("TEAM-06/TEAM-04: one vote per member, only the exact candidate, round and assignment count; a quorum cannot waive an absent required contributor", () => {
    const { round } = roundOf({
      threshold: { kind: "fraction", numerator: 2, denominator: 3 },
      requiredEndorserIds: ["m5"],
    });
    // Duplicate and out-of-order delivery: m1 challenges, then its retry endorses twice.
    const duplicates = evaluateDecision(round, "d", [
      vote("m1", "challenge"),
      vote("m1", "endorse"),
      vote("m1", "endorse"),
      vote("m2", "endorse"),
      vote("m3", "endorse"),
      vote("m4", "endorse"),
      vote("m5", "endorse"),
    ]);
    expect(duplicates.endorsements).toBe(4);
    expect(duplicates.challenges).toBe(1);
    expect(duplicates.passes).toBe(true);
    // Wrong candidate digest, wrong round and wrong (stale) assignment never count.
    const wrong = evaluateDecision(round, "d", [
      vote("m1", "endorse", { candidateDigest: "older" }),
      vote("m2", "endorse", { roundId: "other-round" }),
      vote("m3", "endorse", { assignmentId: "a-m3-old" }),
      vote("m4", "endorse"),
      vote("m5", "endorse"),
    ]);
    expect(wrong.endorsements).toBe(2);
    expect(wrong.pending.sort()).toEqual(["m1", "m2", "m3"]);
    // A required endorser's dissent blocks four endorsements.
    const dissent = evaluateDecision(round, "d", [
      vote("m1", "endorse"),
      vote("m2", "endorse"),
      vote("m3", "endorse"),
      vote("m4", "endorse"),
      vote("m5", "challenge"),
    ]);
    expect(dissent).toMatchObject({
      passes: false,
      impossible: true,
      requiredEndorsersMissing: ["m5"],
    });
    // Participation: m5 absent; four valid contributions do not satisfy it.
    const four = ["m1", "m2", "m3", "m4"].map((m) => contribution(m));
    expect(participation(round, four)).toMatchObject({
      satisfied: false,
      missing: ["m5"],
      validCount: 4,
    });
    // m1's report delivered twice still counts once and cannot fill m5's slot.
    const repeated = [...four, contribution("m1"), contribution("m1")];
    expect(participation(round, repeated)).toMatchObject({
      satisfied: false,
      missing: ["m5"],
      validCount: 4,
    });
    // m5's report from a stale assignment revision, another round or another input does not count.
    for (const stale of [
      contribution("m5", { assignmentRevision: 0 }),
      contribution("m5", { roundId: "older-round" }),
      contribution("m5", { inputDigest: "older-input" }),
      contribution("m5", { validation: { state: "invalid", reason: "x" } }),
    ]) {
      expect(countsFor(round, stale)).toBe(false);
      expect(participation(round, [...four, stale]).satisfied).toBe(false);
    }
    expect(participation(round, [...four, contribution("m5")]).satisfied).toBe(
      true,
    );
  });

  test("TEAM-06: five coordinators under a 2/3 rule commit with one explicit dissent, and do not commit with two", async () => {
    for (const dissenters of [
      ["coordinator-auto-5"],
      ["coordinator-auto-4", "coordinator-auto-5"],
    ]) {
      const f = await setup();
      const { goal } = await start(
        f,
        "Change the value. Use five coordinators.",
      );
      await f.orchestrator.setGroup({
        projectId: "p",
        goalId: goal.id,
        level: "goal-role",
        roleId: "coordinator",
        settings: {
          completion: {
            threshold: { kind: "fraction", numerator: 2, denominator: 3 },
          },
        },
        commandId: cmd(),
      });
      const explicit = ["coordinator-auto-4", "coordinator-auto-5"];
      f.driver.reply = (turn) => {
        if (turn.purpose === "coordinator-contribution") {
          // Members 1–3 add a compatible task, so members 4 and 5 must
          // endorse the combined candidate explicitly.
          const plan: unknown[] = rosterPlan(turn);
          if (!explicit.includes(turn.memberId))
            plan.push({
              key: "docs",
              title: "Document it",
              kind: "information",
              roleId: "researcher",
              dependencies: [],
              permittedOutputs: [],
              acceptanceCriteria: [],
              brief: "Summarize.",
              partitions: [],
            });
          return defaultReply(turn, plan);
        }
        if (
          turn.purpose === "coordinator-endorsement" &&
          dissenters.includes(turn.memberId)
        ) {
          const r = JSON.parse((defaultReply(turn) as { text: string }).text);
          return {
            text: JSON.stringify({
              ...r,
              stance: "challenge",
              rationale: `Dissent from ${turn.memberId}.`,
            }),
          };
        }
        return defaultReply(turn);
      };
      const state = await drive(f.orchestrator, f.driver, goal.id, {
        maxSteps: 120,
      });
      const coordination = rounds(f, goal.id, "coordination")[0];
      expect(coordination.threshold).toBe(4);
      expect(coordination.electorateIds).toHaveLength(5);
      const view = f.orchestrator.goalView(goal.id).rounds[0];
      // Each candidate revision keeps every member's stance; dissent is
      // attributed on every revision the electorate voted on.
      const candidates = [
        ...new Set(view.endorsements.map((e) => e.candidateId)),
      ];
      for (const candidate of candidates) {
        const votes = view.endorsements.filter(
          (e) => e.candidateId === candidate,
        );
        expect(votes.map((e) => e.memberId).sort()).toEqual(
          coordination.electorateIds.slice().sort(),
        );
        expect(
          votes
            .filter((e) => e.stance === "challenge")
            .map((e) => e.memberId)
            .sort(),
        ).toEqual(dissenters);
      }
      if (dissenters.length === 1) {
        expect(coordination.stage).toBe("committed");
        expect(state).toBe("awaiting-acceptance");
        expect(
          view.endorsements.filter((e) => e.stance === "endorse"),
        ).toHaveLength(4);
        expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(1);
      } else {
        // One bounded reconciliation turn, then the owner decides.
        expect(candidates).toHaveLength(2);
        expect(coordination.reconciliationTurnsUsed).toBe(1);
        expect(coordination.stage).toBe("awaiting-user");
        expect(coordination.detail).toContain("3 of 5 endorsed (needs 4)");
        expect(coordination.detail).toContain("Dissent is retained");
        expect(state).toBe("blocked");
        expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(0);
        expect(
          f.driver.launches.some((l) => l.purpose === "implementation"),
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TEAM-10 minority findings

describe("TEAM-10: one high-severity finding among five reviewers", () => {
  test("TEAM-10: four clean reports cannot erase a defect; nearby duplicates keep both observations; a waiver needs a rationale and keeps the record", async () => {
    const f = await setup();
    const { goal } = await start(f, "Change the value. Use five reviewers.");
    const finding = (line: number, title: string, behavior: string) => ({
      title,
      severity: "high",
      file: "src/a.ts",
      line,
      behavior,
      evidence: "Loop bound",
    });
    f.driver.reply = (turn) => {
      if (
        turn.purpose === "candidate-review" &&
        ["reviewer-auto-5", "reviewer-auto-2"].includes(turn.memberId)
      ) {
        const r = JSON.parse((defaultReply(turn) as { text: string }).text);
        return {
          text: JSON.stringify({
            ...r,
            summary: "One defect.",
            findings: [
              turn.memberId === "reviewer-auto-5"
                ? finding(3, "Off-by-one in loop", "Loop skips the last item")
                : finding(4, "Loop off-by-one", "The loop skips the last item"),
            ],
          }),
        };
      }
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    const view = f.orchestrator.goalView(goal.id);
    expect(view.review!.result).toBe("blocked");
    expect(view.review!.findings).toHaveLength(1);
    const [only] = view.review!.findings;
    expect(only.observations.map((o) => o.memberId).sort()).toEqual([
      "reviewer-auto-2",
      "reviewer-auto-5",
    ]);
    expect(only.silentMemberIds).toHaveLength(3);
    expect(only.disposition).toBe("open");
    // A disposition without a rationale is refused by the command and the engine.
    expect(
      parse({
        type: "orchestration-finding-decide",
        goalId: goal.id,
        findingKey: only.key,
        disposition: "waived",
        rationale: "",
        commandId: "finding-command",
      }),
    ).toBe(false);
    await expect(
      f.orchestrator.decideFinding({
        goalId: goal.id,
        findingKey: only.key,
        disposition: "waived",
        rationale: "   ",
        commandId: cmd(),
      }),
    ).rejects.toThrow(/rationale/);
    expect(goalOf(f, goal.id).state).toBe("blocked");
    await f.orchestrator.decideFinding({
      goalId: goal.id,
      findingKey: only.key,
      disposition: "waived",
      rationale: "Accepted risk for this fixture.",
      commandId: cmd(),
    });
    const after = f.orchestrator.goalView(goal.id).review!;
    expect(after.result).toBe("satisfied");
    expect(after.findings[0]).toMatchObject({
      disposition: "waived",
      dispositionRationale: "Accepted risk for this fixture.",
      decidedBy: "local-user",
    });
    expect(after.findings[0].observations).toHaveLength(2);
    expect(goalOf(f, goal.id).state).toBe("awaiting-acceptance");
  });
});

// ---------------------------------------------------------------------------
// TEAM-11 capacity, width and scheduling

describe("TEAM-11: execution width, capacity and scheduling", () => {
  test("TEAM-11: five reviewers at width two under capacity four run 2 + 2 + 1; queued members hold no capacity", async () => {
    const f = await setup();
    f.driver.total = 4;
    f.driver.perProvider = 4;
    const { goal } = await start(f, "Change the value. Use five reviewers.");
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: goal.id,
      level: "goal-role",
      roleId: "reviewer",
      settings: { executionWidth: 2 },
      commandId: cmd(),
    });
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 80,
      until: () =>
        rounds(f, goal.id, "review").some((r) =>
          r.members.some((m) => m.state === "running"),
        ),
    });
    const first = rounds(f, goal.id, "review")[0];
    expect(first.members.filter((m) => m.state === "running")).toHaveLength(2);
    expect(first.members.filter((m) => m.state === "queued")).toHaveLength(3);
    // Only the two running attempts hold capacity.
    expect(f.driver.capacity().held).toHaveLength(2);
    const reviewLaunchesAt = f.driver.launches.length;
    await f.orchestrator.tick();
    expect(f.driver.launches.length).toBe(reviewLaunchesAt);
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const review = rounds(f, goal.id, "review")[0];
    expect(review.members.map((m) => m.wave)).toEqual([1, 1, 2, 2, 3]);
    expect(review.members.every((m) => m.state === "returned")).toBe(true);
    // Observed concurrency of review launches never exceeded the width.
    const reviewIndexes = f.driver.launches
      .map((l, i) => (l.purpose === "candidate-review" ? i : -1))
      .filter((i) => i >= 0);
    expect(Math.max(...reviewIndexes.map((i) => f.driver.overlap[i]))).toBe(2);
  });

  test("TEAM-11: sequential scheduling runs one reviewer at a time; a per-provider cap bounds a mixed wave", async () => {
    const f = await setup();
    f.driver.total = 4;
    f.driver.perProvider = 4;
    const { goal } = await start(f, "Change the value. Use five reviewers.");
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: goal.id,
      level: "goal-role",
      roleId: "reviewer",
      settings: { scheduling: "sequential" },
      commandId: cmd(),
    });
    expect(
      await drive(f.orchestrator, f.driver, goal.id, { maxSteps: 120 }),
    ).toBe("awaiting-acceptance");
    const review = rounds(f, goal.id, "review")[0];
    expect(review.members.map((m) => m.wave)).toEqual([1, 2, 3, 4, 5]);
    const reviewIndexes = f.driver.launches
      .map((l, i) => (l.purpose === "candidate-review" ? i : -1))
      .filter((i) => i >= 0);
    expect(reviewIndexes.map((i) => f.driver.overlap[i])).toEqual([
      1, 1, 1, 1, 1,
    ]);
    // Per-provider cap one, total four: a wave takes one member per provider.
    const members = [
      ["a", "claude"],
      ["b", "claude"],
      ["c", "codex"],
      ["d", "codex"],
    ].map(([memberId]) => ({
      memberId,
      state: "queued",
      phase: "initial",
    })) as RoleRound["members"];
    const weights = {
      a: { provider: "claude" as const, weight: 1 },
      b: { provider: "claude" as const, weight: 1 },
      c: { provider: "codex" as const, weight: 1 },
      d: { provider: "codex" as const, weight: 1 },
    };
    expect(
      admit(
        { scheduling: "capacity-waves", executionWidth: null, members },
        "initial",
        weights,
        { total: 4, perProvider: 1, held: [] },
      ).admit,
    ).toEqual(["a"]);
    // A wave stops at the first member that does not fit, preserving order.
    expect(
      admit(
        {
          scheduling: "capacity-waves",
          executionWidth: null,
          members: [members[0], members[2], members[1], members[3]],
        },
        "initial",
        weights,
        { total: 4, perProvider: 1, held: [] },
      ).admit,
    ).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// TEAM-08 invalid decisions

describe("TEAM-08: invalid plans are rejected before any launch", () => {
  const task = (over: Record<string, unknown>) => ({
    ...defaultPlan("implementation")[0],
    ...over,
  });
  const cases: Array<
    [string, string, (turn: never) => unknown[], RegExp, Goal["kind"]?]
  > = [
    [
      "implementation work outside an information goal's grant",
      "Research the logging options. Coordinate with Opus.",
      () => [task({})],
      /implementation work, which the goal's grant does not permit/,
      "information",
    ],
    [
      "a dependency cycle",
      "Change the value. Coordinate with Opus.",
      () => [
        task({ key: "a", dependencies: ["b"] }),
        task({ key: "b", dependencies: ["a"], permittedOutputs: ["src/b.ts"] }),
      ],
      /contain a cycle/,
    ],
    [
      "an unknown dependency",
      "Change the value. Coordinate with Opus.",
      () => [task({ dependencies: ["missing"] })],
      /depends on missing, which is not in the plan/,
    ],
    [
      "a wrong-purpose role",
      "Change the value. Coordinate with Opus.",
      () => [task({ roleId: "reviewer" })],
      /has purpose candidate-review/,
    ],
    [
      "a malformed partition count",
      "Change the value. Coordinate with Opus. Use three implementers.",
      () => [
        task({
          partitions: [
            { title: "One", permittedOutputs: ["src/1.ts"] },
            { title: "Two", permittedOutputs: ["src/2.ts"] },
          ],
        }),
      ],
      /needs 3 partitions, not 2/,
    ],
    [
      "a task kind outside the coordinator contract",
      "Change the value. Coordinate with Opus.",
      () => [task({ kind: "check" })],
      /actions\.0\.kind: Invalid option/,
    ],
    [
      "an invented role",
      "Change the value. Coordinate with Opus.",
      () => [task({ roleId: "ghost" })],
      /Coordinators cannot invent roles/,
    ],
  ];
  for (const [name, text, plan, reason, kind] of cases)
    test(`TEAM-08: ${name} blocks the decision with a named reason and dispatches nothing`, async () => {
      const f = await setup();
      const { goal } = await start(f, text, kind ?? "code");
      f.driver.reply = (turn) =>
        turn.purpose === "coordinator-contribution"
          ? defaultReply(turn, plan(turn as never))
          : defaultReply(turn);
      expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
      const coordination = rounds(f, goal.id, "coordination")[0];
      const contributions = f.orchestrator.contributions(coordination.id, "p");
      expect(contributions.length).toBeGreaterThan(0);
      expect(
        contributions.every(
          (c) =>
            c.validation.state === "invalid" &&
            reason.test(c.validation.reason),
        ),
      ).toBe(true);
      expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(0);
      expect(f.orchestrator.repo.all(kinds.action, "p")).toHaveLength(0);
      expect(
        f.driver.launches.some((l) => l.purpose === "implementation"),
      ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// TEAM-09 dependent partitions

describe("TEAM-09: predecessor-dependent work", () => {
  test("TEAM-09: a follow-up task starts from the integrated output of three partitions; the final candidate holds every contributor once", async () => {
    const f = await setup();
    const { goal } = await start(
      f,
      "Change the value. Use three implementers.",
    );
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution") {
        const [build] = rosterPlan(turn);
        const wire = {
          ...build,
          key: "wire",
          title: "Wire it up",
          dependencies: ["build"],
          permittedOutputs: ["src/wire.ts"],
          partitions: build.partitions.map((_, i) => ({
            title: `Wire ${i + 1}`,
            permittedOutputs: [`src/wire-${i + 1}.ts`],
          })),
        };
        return defaultReply(turn, [build, wire]);
      }
      return defaultReply(turn);
    };
    expect(
      await drive(f.orchestrator, f.driver, goal.id, { maxSteps: 150 }),
    ).toBe("awaiting-acceptance");
    const impl = f.driver.launches.filter(
      (l) => l.purpose === "implementation",
    );
    const build = impl.filter((l) =>
      l.permittedOutputs.some((p) => p.startsWith("src/part-")),
    );
    const wire = impl.filter((l) =>
      l.permittedOutputs.some((p) => p.startsWith("src/wire-")),
    );
    expect(build).toHaveLength(3);
    expect(wire).toHaveLength(3);
    expect(build.every((l) => l.candidateId === "baseline-candidate")).toBe(
      true,
    );
    // The dependency assembly integrated exactly the three build candidates.
    const assembly = f.driver.integrations[0];
    expect(assembly.base).toBe("baseline-candidate");
    expect(assembly.candidates).toHaveLength(3);
    const assembled = "integrated-1";
    expect(wire.every((l) => l.candidateId === assembled)).toBe(true);
    const bundle = f.orchestrator.repo
      .all<DependencyBundle>(kinds.dependency, "p")
      .find((b) => b.taskKey === "wire")!;
    expect(bundle.assembledCandidateId).toBe(assembled);
    expect(bundle.predecessors[0].candidateIds.sort()).toEqual(
      [...assembly.candidates].sort(),
    );
    // The final integration includes all six contributions once, with
    // ancestry so the follow-up is not double-applied over its predecessors.
    const final = f.driver.integrations.at(-1)!;
    expect(final.candidates).toHaveLength(6);
    expect(new Set(final.candidates).size).toBe(6);
    for (const c of final.candidates.filter(
      (c) => !assembly.candidates.includes(c),
    ))
      expect([...final.ancestry![c]].sort()).toEqual(
        [...assembly.candidates].sort(),
      );
    // Review is of the final integrated candidate, not a fragment.
    const review = rounds(f, goal.id, "review")[0];
    expect(review.input.candidateId).toBe(goalOf(f, goal.id).candidateId);
    expect(review.input.candidateId).not.toBe(assembled);
  });
});

// ---------------------------------------------------------------------------
// TEAM-05 scopes and releases, TEAM-13 information goals

describe("TEAM-05/TEAM-13: scoped settings, releases and information goals", () => {
  test("TEAM-05: merge keeps unset fields, replace closes the scope; releasing one pin keeps the roster and count; releasing the roster returns the role to Auto", async () => {
    const f = await setup();
    const { goal } = await start(f, "Change the value.");
    const opts = {
      projectId: "p",
      goalId: goal.id,
      level: "goal-role" as const,
    };
    await f.orchestrator.setGroup({
      ...opts,
      roleId: "reviewer",
      settings: {
        form: "required-plus-auto",
        count: 4,
        members: [
          pinned("fable", { label: "Fable" }),
          pinned("sol", { label: "Sol" }),
        ],
        distinctModels: "required",
      },
      commandId: cmd(),
    });
    // merge: only executionWidth changes.
    await f.orchestrator.setGroup({
      ...opts,
      roleId: "reviewer",
      settings: { executionWidth: 2 },
      mode: "merge",
      commandId: cmd(),
    });
    let g = f.orchestrator.effective("p", goal.id, "reviewer");
    expect(g).toMatchObject({
      count: 4,
      executionWidth: 2,
      distinctModels: "required",
    });
    expect(g.members.map((m) => m.memberId)).toEqual(["fable", "sol"]);
    // The coordinator role is unrelated and unchanged.
    expect(f.orchestrator.effective("p", goal.id, "coordinator").form).toBe(
      "auto",
    );
    // Release one pin: the slot stays, now Auto; the other pin and the count survive.
    await f.orchestrator.releaseMember({
      projectId: "p",
      goalId: goal.id,
      roleId: "reviewer",
      memberId: "fable",
      commandId: cmd(),
    });
    g = f.orchestrator.effective("p", goal.id, "reviewer");
    expect(g.count).toBe(4);
    expect(g.members.map((m) => [m.memberId, m.pin?.label ?? null])).toEqual([
      ["fable", null],
      ["sol", "Sol"],
    ]);
    expect(g.executionWidth).toBe(2);
    await expect(
      f.orchestrator.releaseMember({
        projectId: "p",
        goalId: goal.id,
        roleId: "reviewer",
        memberId: "nobody",
        commandId: cmd(),
      }),
    ).rejects.toThrow(/not in this role/);
    // replace: releasing the roster closes the scope's earlier fields.
    await f.orchestrator.releaseRoster({
      projectId: "p",
      goalId: goal.id,
      roleId: "reviewer",
      commandId: cmd(),
    });
    g = f.orchestrator.effective("p", goal.id, "reviewer");
    expect(g.form).toBe("auto");
    expect(g.members).toEqual([]);
    expect(g.count).toBeNull();
    expect(g.executionWidth).toBeNull();
    // Provenance names the goal-role revision that released it.
    expect(g.sources[0]).toMatchObject({ level: "goal-role" });
    expect(g.sources[0].fields.sort()).toEqual(["form", "members"]);
    // Equivalent conversation and editor commands produce the same settings.
    const [parsed] = parseMembership("Use four reviewers.", "m");
    expect(parsed.settings).toEqual({ form: "auto", count: 4, members: [] });
  });

  test("TEAM-13: an information goal with three researchers keeps every contributor; a status query creates no goal", async () => {
    const f = await setup();
    f.driver.reply = (turn) =>
      turn.purpose === "coordinator-contribution"
        ? defaultReply(turn, defaultPlan("information"))
        : defaultReply(turn);
    const { conversation, goal } = await start(
      f,
      "Research which logging library fits. Use three researchers.",
      "information",
    );
    // A status question while the goal runs reports on it and creates nothing.
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 3,
      until: () => false,
    });
    expect(goalOf(f, goal.id).state).not.toBe("completed");
    const running = await f.orchestrator.post({
      conversationId: conversation.id,
      text: "What is the status?",
      commandId: cmd(),
    });
    expect(running.routing).toBe("status");
    expect(running.goal!.id).toBe(goal.id);
    expect(f.orchestrator.repo.all<Goal>(kinds.goal, "p")).toHaveLength(1);
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("completed");
    const work = rounds(f, goal.id, "information")[0];
    expect(work.members).toHaveLength(3);
    const reports = f.orchestrator
      .contributions(work.id, "p")
      .filter((c) => c.validation.state === "valid");
    expect(reports.map((c) => c.memberId).sort()).toEqual(
      work.members.map((m) => m.memberId).sort(),
    );
    const done = goalOf(f, goal.id);
    expect(done.candidateId).toBeNull();
    expect(done.checkCandidateId ?? null).toBeNull();
    expect(done.synthesis).toContain("No code candidate or check was produced");
    expect(f.driver.integrations).toHaveLength(0);
  });

  // CAMPAIGN DEFECT TEAM-13: an explicit status message with no active goal creates a new code goal (engine.ts post: falls through to newGoal).
  test.fails(
    "TEAM-13: an explicit status query after the only goal completed creates no goal",
    async () => {
      const f = await setup();
      f.driver.reply = (turn) =>
        turn.purpose === "coordinator-contribution"
          ? defaultReply(turn, defaultPlan("information"))
          : defaultReply(turn);
      const { conversation, goal } = await start(
        f,
        "Research which logging library fits.",
        "information",
      );
      expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("completed");
      const status = await f.orchestrator.post({
        conversationId: conversation.id,
        text: "What is the status?",
        routing: "status",
        commandId: cmd(),
      });
      // Observed on 2026-10-19: routing "status" is returned together with a
      // new planning goal whose objective is the status question.
      expect(status.routing).toBe("status");
      expect(
        f.orchestrator.repo.all<Goal>(kinds.goal, "p").map((g) => g.id),
      ).toEqual([goal.id]);
    },
  );
});

// ---------------------------------------------------------------------------
// J-04 journey at the local stand-in layer

describe("J-04: three coordinators, five reviewers, dependent work, minority finding, repair, check, accept and apply (stand-in)", () => {
  test("J-04: every contribution and the minority finding stay attributed; a fresh full review and the exact check precede acceptance and one apply", async () => {
    const f = await setup();
    const check = {
      id: "unit",
      label: "unit tests",
      executable: "/fixture/bin/check",
      args: [],
      timeoutMs: 30_000,
    };
    const { goal } = await start(
      f,
      "Change the value. Use three coordinators; include Opus and Astra. Use five reviewers; include Fable and Sol. Use two implementers.",
      "code",
      [check],
    );
    let firstReviewed: string | null = null;
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution") {
        const [build] = rosterPlan(turn);
        return defaultReply(turn, [
          build,
          {
            ...build,
            key: "wire",
            title: "Wire it up",
            dependencies: ["build"],
            permittedOutputs: ["src/wire.ts"],
            partitions: build.partitions.map((_, i) => ({
              title: `Wire ${i + 1}`,
              permittedOutputs: [`src/wire-${i + 1}.ts`],
            })),
          },
        ]);
      }
      if (turn.purpose === "candidate-review") {
        firstReviewed ??= turn.candidateId;
        if (
          turn.memberId === "reviewer-auto-5" &&
          turn.candidateId === firstReviewed
        ) {
          const r = JSON.parse((defaultReply(turn) as { text: string }).text);
          return {
            text: JSON.stringify({
              ...r,
              summary: "One defect.",
              findings: [
                {
                  title: "Off-by-one",
                  severity: "high",
                  file: "src/a.ts",
                  line: 3,
                  behavior: "Skips the last item",
                  evidence: "Loop bound",
                },
              ],
            }),
          };
        }
      }
      return defaultReply(turn);
    };
    expect(
      await drive(f.orchestrator, f.driver, goal.id, { maxSteps: 200 }),
    ).toBe("blocked");
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.members).toHaveLength(3);
    expect(coordination.members.map((m) => m.wave)).toEqual([1, 1, 2]);
    expect(
      f.orchestrator
        .contributions(coordination.id, "p")
        .filter((c) => c.validation.state === "valid")
        .map((c) => c.memberId)
        .sort(),
    ).toEqual(coordination.members.map((m) => m.memberId).sort());
    // Dependent task started from the predecessor's integrated output.
    const wire = f.driver.launches.filter(
      (l) =>
        l.purpose === "implementation" &&
        l.permittedOutputs.some((p) => p.startsWith("src/wire-")),
    );
    expect(wire).toHaveLength(2);
    expect(wire.every((l) => l.candidateId === "integrated-1")).toBe(true);
    const firstReview = rounds(f, goal.id, "review")[0];
    expect(firstReview.members).toHaveLength(5);
    expect(firstReview.members.map((m) => m.wave)).toEqual([1, 1, 2, 2, 3]);
    expect(f.driver.maxRunning).toBe(2);
    const blocked = f.orchestrator.goalView(goal.id).review!;
    expect(blocked.result).toBe("blocked");
    expect(blocked.findings[0].observations.map((o) => o.memberId)).toEqual([
      "reviewer-auto-5",
    ]);
    expect(blocked.findings[0].silentMemberIds).toHaveLength(4);
    // Acceptance is closed while the finding is open.
    await expect(
      f.orchestrator.accept({
        goalId: goal.id,
        digest: f.orchestrator.acceptanceDigest(goal.id),
        commandId: cmd(),
      }),
    ).rejects.toThrow();
    await f.orchestrator.repair({ goalId: goal.id, commandId: cmd() });
    expect(
      await drive(f.orchestrator, f.driver, goal.id, { maxSteps: 200 }),
    ).toBe("checking");
    const reviews = rounds(f, goal.id, "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[1].members).toHaveLength(5);
    expect(reviews[1].input.candidateId).not.toBe(firstReviewed);
    expect(reviews[1].input.candidateId).toBe(goalOf(f, goal.id).candidateId);
    // The earlier finding record is preserved on the first review.
    expect(
      f.orchestrator.goalView(goal.id).rounds.length,
    ).toBeGreaterThanOrEqual(2);
    const plans = await f.orchestrator.previewChecks({ goalId: goal.id });
    expect(plans.map((p) => p.candidateId)).toEqual([
      goalOf(f, goal.id).candidateId,
    ]);
    for (const p of plans)
      await f.orchestrator.runCheck({ planId: p.id, digest: p.digest });
    expect(goalOf(f, goal.id).state).toBe("awaiting-acceptance");
    const accepted = await f.orchestrator.accept({
      goalId: goal.id,
      digest: f.orchestrator.acceptanceDigest(goal.id),
      commandId: cmd(),
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.acceptance!.candidateId).toBe(reviews[1].input.candidateId);
    // Applying is a separate authorization, done once.
    expect(f.driver.applied).toEqual([]);
    const review = await f.orchestrator.applicationReview(goal.id);
    const applied = await f.orchestrator.apply({
      goalId: goal.id,
      digest: review.digest,
      commandId: cmd(),
    });
    expect(applied.application?.state).toBe("applied");
    expect(f.driver.applied).toEqual([
      { goalId: goal.id, candidateId: accepted.acceptance!.candidateId },
    ]);
  });
});
