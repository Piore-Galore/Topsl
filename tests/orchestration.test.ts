import { afterEach, describe, expect, test } from "vitest";
import type {
  CoordinatorPlan,
  Goal,
  ParticipantContribution,
  PlanTaskAction,
  QueuedPlanAction,
  RoleRound,
} from "../packages/domain/role-groups";
import { kinds } from "../packages/orchestration/repository";
import {
  combineProposals,
  normalizeAction,
  planActionSchema,
} from "../packages/orchestration/contracts";
import {
  effectiveGroup,
  legacyDraftGroups,
  parseMembership,
  presetGroups,
} from "../packages/orchestration/membership";
import { builtInRoleDefinitions } from "../packages/orchestration/roles";
import {
  aggregateFindings,
  evaluateDecision,
  freezePolicy,
} from "../packages/orchestration/policy";
import { admit, wavePlan } from "../packages/orchestration/schedule";
import {
  modelEvidence,
  resolveGroup,
} from "../packages/orchestration/selection";
import { completionPolicySchema } from "../packages/domain/role-groups";
import {
  defaultPlan,
  rosterPlan,
  defaultReply,
  drive,
  orchestration,
  route,
} from "./orchestration-fixture";

const open: Array<Awaited<ReturnType<typeof orchestration>>> = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
async function setup() {
  const f = await orchestration();
  open.push(f);
  return f;
}
let commandCounter = 0;
const cmd = () => `cmd-${++commandCounter}`;
async function start(
  f: Awaited<ReturnType<typeof setup>>,
  text: string,
  kind: Goal["kind"] = "code",
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
  });
  return { conversation, goal: posted.goal! };
}
const rounds = (
  f: Awaited<ReturnType<typeof setup>>,
  goalId: string,
  kind?: RoleRound["kind"],
) => f.orchestrator.rounds(goalId).filter((r) => !kind || r.kind === kind);
const goalOf = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
  f.orchestrator.repo.require<Goal>(kinds.goal, id);

describe("membership settings and instructions", () => {
  test("UI-01: conversation instructions produce the same persisted settings as the editor", () => {
    const parsed = parseMembership(
      "Add the coordinator feature; coordinate with Opus and Astra, review with Fable and Sol.",
      "m1",
    );
    expect(
      parsed.map((p) => [
        p.roleId,
        p.settings.form,
        p.settings.members?.map((m) => m.pin?.label),
      ]),
    ).toEqual([
      ["coordinator", "exact", ["Opus", "Astra"]],
      ["reviewer", "exact", ["Fable", "Sol"]],
    ]);
    const larger = parseMembership(
      "Use three coordinators; include Opus and Astra. Use five reviewers; include Fable and Sol.",
      "m2",
    );
    expect(
      larger.map((p) => [
        p.roleId,
        p.settings.form,
        p.settings.count,
        p.settings.members?.length,
      ]),
    ).toEqual([
      ["coordinator", "required-plus-auto", 3, 2],
      ["reviewer", "required-plus-auto", 5, 2],
    ]);
    const cases: Array<[string, unknown]> = [
      ["Choose the agents automatically.", [["*", { form: "auto" }]]],
      [
        "Use two reviewers; pick the models.",
        [["reviewer", { form: "auto", count: 2, members: [] }]],
      ],
      [
        "Use three coordinators and four implementers.",
        [
          ["coordinator", { form: "auto", count: 3, members: [] }],
          ["implementer", { form: "auto", count: 4, members: [] }],
        ],
      ],
      [
        "Use at most three reviewers.",
        [["reviewer", { form: "auto", maxCount: 3 }]],
      ],
      [
        "Prefer different providers.",
        [["*", { distinctProviders: "preferred" }]],
      ],
    ];
    for (const [text, expected] of cases)
      expect(
        parseMembership(text, "m").map((p) => [p.roleId, p.settings]),
      ).toEqual(expected);
    const include = parseMembership("Include Opus as a coordinator.", "m3")[0];
    expect(include.settings.form).toBe("required-plus-auto");
    expect(include.settings.count).toBeUndefined();
    const sequential = parseMembership("Use Sol first, then Fable.", "m4")[0];
    expect(sequential.settings).toMatchObject({
      form: "exact",
      collaboration: "sequential",
    });
    expect(sequential.settings.members!.map((m) => m.pin?.label)).toEqual([
      "Sol",
      "Fable",
    ]);
    const fallback = parseMembership(
      "Use Sol; fall back to Fable if unavailable.",
      "m5",
    )[0];
    expect(fallback.settings.members).toHaveLength(1);
    expect(fallback.settings.members![0].fallbacks).toEqual([
      { label: "Fable" },
    ]);
    expect(
      parseMembership("Use two different models.", "m6")[0].settings,
    ).toEqual({ distinctModels: "required" });
  });

  test("RG-13/RG-15: no two-member ceiling; a count above the limit is kept and explained until the limit rises", () => {
    const role = builtInRoleDefinitions.reviewer;
    const members = Array.from({ length: 12 }, (_, i) => ({
      memberId: `r-${i + 1}`,
      required: true,
      pin: { label: `Model ${i + 1}` },
      fallbacks: [],
      preferences: { providers: [], models: [] },
      source: {
        kind: "ui" as const,
        reference: null,
        provenance: "explicit" as const,
      },
    }));
    const limited = effectiveGroup({
      projectId: "p",
      goalId: null,
      role,
      memberLimit: 8,
      layers: [
        {
          level: "project-role",
          revisionId: "r1",
          settings: { form: "exact", members },
        },
      ],
    });
    expect(limited.members).toHaveLength(12);
    expect(limited.conflicts.join(" ")).toContain(
      "12 members are requested, above the configured limit of 8",
    );
    const raised = effectiveGroup({
      projectId: "p",
      goalId: null,
      role,
      memberLimit: 12,
      layers: [
        {
          level: "project-role",
          revisionId: "r1",
          settings: { form: "exact", members },
        },
      ],
    });
    expect(raised.conflicts).toEqual([]);
    expect(raised.count).toBe(12);
  });

  test("scope precedence: a more specific scope overrides only the fields it sets", () => {
    const role = builtInRoleDefinitions.coordinator;
    const group = effectiveGroup({
      projectId: "p",
      goalId: "g",
      role,
      memberLimit: 8,
      layers: [
        {
          level: "project-policy",
          revisionId: null,
          settings: { distinctProviders: "preferred" },
        },
        {
          level: "project-role",
          revisionId: "a",
          settings: { form: "auto", count: 3 },
        },
        {
          level: "goal-role",
          revisionId: "b",
          settings: { completion: { threshold: { kind: "count", count: 2 } } },
        },
      ],
    });
    expect(group).toMatchObject({
      form: "auto",
      count: 3,
      distinctProviders: "preferred",
    });
    expect(group.completion.threshold).toEqual({ kind: "count", count: 2 });
    expect(group.sources.map((s) => s.level)).toEqual([
      "goal-role",
      "project-role",
      "project-policy",
      "application",
    ]);
  });

  test("MG-01: legacy singleton drafts and presets keep their saved meaning", () => {
    const [builder, reviewer] = legacyDraftGroups(
      {
        builder: "codex",
        reviewer: "claude",
        builderRuntime: "i1",
        reviewerRuntime: "i2",
        builderModel: "",
        reviewerModel: "",
        builderEffort: "",
        reviewerEffort: "",
      },
      "draft-1",
    );
    // An untouched default is not relabelled as an explicit pin.
    expect(builder.settings.form).toBe("auto");
    expect(builder.settings.members![0]).toMatchObject({
      pin: null,
      source: { provenance: "legacy-unknown" },
    });
    // Terminal Claude keeps its native-default meaning as assisted participation.
    expect(reviewer.settings.members![0].pin).toMatchObject({
      provider: "claude",
      model: "set-in-claude-code",
      route: "assisted",
    });
    const groups = presetGroups({
      id: "preset",
      assignments: [
        {
          role: "reviewer",
          memberId: "fable",
          provider: "claude",
          installationId: "c",
          model: "claude-fable-fixture",
        },
        {
          role: "reviewer",
          memberId: "sol",
          provider: "codex",
          installationId: "x",
          model: "sol-fixture",
        },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].settings.members!.map((m) => m.memberId)).toEqual([
      "fable",
      "sol",
    ]);
  });
});

describe("selection", () => {
  const role = builtInRoleDefinitions.reviewer;
  const group = (
    settings: Parameters<typeof effectiveGroup>[0]["layers"][0]["settings"],
  ) =>
    effectiveGroup({
      projectId: "p",
      goalId: "g",
      role,
      memberLimit: 8,
      layers: [{ level: "goal-role", revisionId: "x", settings }],
    });
  const pool = () => [
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
  const pin = (memberId: string, label: string, extra = {}) => ({
    memberId,
    required: true,
    pin: { label, ...extra },
    fallbacks: [],
    preferences: { providers: [], models: [] },
    source: {
      kind: "ui" as const,
      reference: null,
      provenance: "explicit" as const,
    },
  });

  test("RG-01/RG-05: any qualified model for any role; Auto respects count and capability", () => {
    const result = resolveGroup({
      role: builtInRoleDefinitions.implementer,
      group: group({ form: "auto", count: 3, members: [] }),
      pool: pool(),
      complexity: "simple",
    });
    expect(result.assignments).toHaveLength(3);
    expect(new Set(result.assignments.map((a) => a.provider))).toEqual(
      new Set(["claude", "codex"]),
    );
    expect(
      result.assignments.every(
        (a) =>
          a.status === "resolved" &&
          a.reason.includes("Selected automatically"),
      ),
    ).toBe(true);
    const blocked = resolveGroup({
      role,
      group: group({ form: "exact", members: [pin("a", "Opus")] }),
      pool: [
        route("claude", "c", [["claude-opus-fixture", "Opus"]], {
          blocked: ["candidate-review"],
        }),
      ],
      complexity: "simple",
    });
    expect(blocked.assignments[0]).toMatchObject({
      status: "unavailable",
      model: null,
    });
    expect(blocked.assignments[0].reason).toContain(
      "not qualified for candidate-review",
    );
  });

  test("RG-08: unknown or ambiguous labels stay unresolved; nothing is substituted", () => {
    const unknown = resolveGroup({
      role,
      group: group({ form: "exact", members: [pin("a", "Nebula")] }),
      pool: pool(),
      complexity: "simple",
    });
    expect(unknown.assignments[0]).toMatchObject({
      status: "unresolved",
      model: null,
      modelLabel: "Nebula",
    });
    const ambiguous = resolveGroup({
      role,
      group: group({ form: "exact", members: [pin("a", "Opus")] }),
      pool: [
        route("claude", "c1", [["claude-opus-fixture", "Opus"]]),
        route("claude", "c2", [["claude-opus-next", "Opus Next"]]),
      ],
      complexity: "simple",
    });
    expect(ambiguous.assignments[0].status).toBe("unresolved");
    expect(ambiguous.assignments[0].reason).toContain("matches 2 models");
    const stale = resolveGroup({
      role,
      group: group({ form: "exact", members: [pin("a", "Opus")] }),
      pool: [
        route("claude", "c", [["claude-opus-fixture", "Opus"]], {
          stale: true,
        }),
      ],
      complexity: "simple",
    });
    expect(stale.assignments[0].status).toBe("unavailable");
    expect(stale.assignments[0].reason).toContain("stale");
  });

  test("RG-06/RG-14: five reviewers with two pins fill three Auto slots without cloning when distinct models are required", () => {
    const result = resolveGroup({
      role,
      group: group({
        form: "required-plus-auto",
        count: 5,
        members: [pin("fable", "Fable"), pin("sol", "Sol")],
        distinctModels: "required",
      }),
      pool: pool(),
      complexity: "simple",
    });
    expect(result.assignments).toHaveLength(5);
    expect(
      result.assignments
        .slice(0, 2)
        .map((a) => [a.memberId, a.model, a.selection]),
    ).toEqual([
      ["fable", "claude-fable-fixture", "pinned"],
      ["sol", "sol-fixture", "pinned"],
    ]);
    expect(new Set(result.assignments.map((a) => a.model)).size).toBe(5);
    const short = resolveGroup({
      role,
      group: group({
        form: "auto",
        count: 6,
        members: [],
        distinctModels: "required",
      }),
      pool: pool(),
      complexity: "simple",
    });
    expect(
      short.assignments.filter((a) => a.status === "unresolved"),
    ).toHaveLength(1);
    expect(
      short.assignments.find((a) => a.status === "unresolved")!.reason,
    ).toContain("does not clone");
  });

  test("RG-10/RG-11: assisted steps cannot satisfy a managed member; fallbacks are explicit and attributed", () => {
    const assisted = resolveGroup({
      role,
      group: group({
        form: "exact",
        members: [
          pin("c", "Claude", {
            provider: "claude",
            model: "set-in-claude-code",
            route: "assisted",
          }),
        ],
      }),
      pool: pool(),
      complexity: "simple",
    });
    expect(assisted.assignments[0].status).toBe("assisted");
    const fallback = resolveGroup({
      role,
      group: group({
        form: "exact",
        members: [{ ...pin("sol", "Nebula"), fallbacks: [{ label: "Fable" }] }],
      }),
      pool: pool(),
      complexity: "simple",
    });
    expect(fallback.assignments[0]).toMatchObject({
      status: "resolved",
      selection: "fallback",
      model: "claude-fable-fixture",
      primaryPin: { label: "Nebula" },
    });
  });

  test("RG-09: a different reported model never satisfies an exact assignment", () => {
    expect(
      modelEvidence(
        { model: "a", effort: null, modelEvidencePolicy: "verified" },
        { model: "b", effort: null },
      ).satisfies,
    ).toBe(false);
    expect(
      modelEvidence(
        { model: "a", effort: null, modelEvidencePolicy: "verified" },
        { model: null, effort: null },
      ).level,
    ).toBe("unreported");
    expect(
      modelEvidence(
        { model: "a", effort: null, modelEvidencePolicy: "requested-only" },
        { model: null, effort: null },
      ),
    ).toMatchObject({ satisfies: true, level: "requested-only" });
  });
});

describe("decision policy and review aggregation", () => {
  const round = (
    n: number,
    policy: Partial<ReturnType<typeof completionPolicySchema.parse>> = {},
  ) => {
    const members = Array.from({ length: n }, (_, i) => ({
      memberId: `m${i + 1}`,
      required: true,
    }));
    const frozen = freezePolicy(completionPolicySchema.parse(policy), members);
    return {
      id: "round",
      members: members.map((m) => ({
        ...m,
        assignmentId: `a-${m.memberId}`,
        assignmentRevision: 1,
      })),
      ...frozen,
    } as unknown as RoleRound;
  };
  const vote = (
    memberId: string,
    stance: "endorse" | "challenge" | "abstain",
    digest = "d",
  ) => ({
    id: `${memberId}-${stance}-${Math.random()}`,
    projectId: "p",
    roundId: "round",
    candidateId: "c",
    candidateDigest: digest,
    memberId,
    assignmentId: `a-${memberId}`,
    contributionId: "x",
    stance,
    rationale: "",
    implied: false,
    createdAt: "",
  });

  test("CO-06/CO-08: three-of-five passes with two dissents; denominator, duplicates and required endorsers hold", () => {
    const r = round(5, { threshold: { kind: "count", count: 3 } });
    const status = evaluateDecision(r, "d", [
      vote("m1", "endorse"),
      vote("m2", "endorse"),
      vote("m3", "endorse"),
      vote("m4", "challenge"),
      vote("m5", "challenge"),
    ]);
    expect(status).toMatchObject({
      passes: true,
      endorsements: 3,
      challenges: 2,
      electorate: 5,
    });
    const duplicate = evaluateDecision(r, "d", [
      vote("m1", "endorse"),
      vote("m1", "endorse"),
      vote("m2", "endorse"),
      vote("m3", "abstain"),
    ]);
    expect(duplicate).toMatchObject({
      passes: false,
      endorsements: 2,
      electorate: 5,
    });
    const wrongDigest = evaluateDecision(r, "d", [
      vote("m1", "endorse", "other"),
      vote("m2", "endorse"),
      vote("m3", "endorse"),
    ]);
    expect(wrongDigest.endorsements).toBe(2);
    const requiredEndorser = round(5, {
      threshold: { kind: "count", count: 3 },
      requiredEndorserIds: ["m5"],
    });
    const blocked = evaluateDecision(requiredEndorser, "d", [
      vote("m1", "endorse"),
      vote("m2", "endorse"),
      vote("m3", "endorse"),
      vote("m4", "endorse"),
      vote("m5", "challenge"),
    ]);
    expect(blocked).toMatchObject({
      passes: false,
      impossible: true,
      requiredEndorsersMissing: ["m5"],
    });
    expect(
      round(4, {
        threshold: { kind: "fraction", numerator: 2, denominator: 3 },
      }).threshold,
    ).toBe(3);
  });

  test("RV-03: overlapping findings deduplicate while keeping every observation and silent reviewer", () => {
    const findings = aggregateFindings(
      [
        {
          contributionId: "c1",
          memberId: "fable",
          title: "Null dereference in parser",
          severity: "high",
          file: "src/a.ts",
          line: 10,
          behavior: "Crashes on empty parser input",
          evidence: "x",
        },
        {
          contributionId: "c2",
          memberId: "sol",
          title: "Parser null dereference",
          severity: "medium",
          file: "src/a.ts",
          line: 11,
          behavior: "Empty input crashes parser",
          evidence: "y",
        },
        {
          contributionId: "c2",
          memberId: "sol",
          title: "Typo",
          severity: "low",
          file: "README.md",
          line: 1,
          behavior: "Spelling",
          evidence: "z",
        },
      ],
      ["fable", "sol", "vega"],
    );
    expect(findings).toHaveLength(2);
    const merged = findings.find((f) => f.file === "src/a.ts")!;
    expect(merged.observations.map((o) => o.memberId)).toEqual([
      "fable",
      "sol",
    ]);
    expect(merged.severity).toBe("high");
    expect(merged.silentMemberIds).toEqual(["vega"]);
    expect(merged.disposition).toBe("open");
  });

  test("EX-10/EX-11: five members at width two admit 2 + 2 + 1; strict simultaneity reports the conflict", () => {
    expect(wavePlan(5, 2)).toEqual([2, 2, 1]);
    const members = Array.from({ length: 5 }, (_, i) => ({
      memberId: `m${i}`,
      state: "queued",
      phase: "initial",
    })) as RoleRound["members"];
    const weights = Object.fromEntries(
      members.map((m) => [
        m.memberId,
        { provider: "codex" as const, weight: 1 },
      ]),
    );
    const capacity = { total: 2, perProvider: 2, held: [] };
    expect(
      admit(
        { scheduling: "capacity-waves", executionWidth: null, members },
        "initial",
        weights,
        capacity,
      ).admit,
    ).toEqual(["m0", "m1"]);
    const strict = admit(
      { scheduling: "all-simultaneous", executionWidth: null, members },
      "initial",
      weights,
      capacity,
    );
    expect(strict.admit).toEqual([]);
    expect(strict.conflict).toContain("All 5 members must run at once");
    const unknown = Object.fromEntries(
      members.map((m) => [
        m.memberId,
        { provider: "codex" as const, weight: 2 },
      ]),
    );
    expect(
      admit(
        { scheduling: "capacity-waves", executionWidth: null, members },
        "initial",
        unknown,
        capacity,
      ).admit,
    ).toEqual(["m0"]);
  });
});

describe("coordinator goals end to end (scripted driver)", () => {
  test("RG-02/RG-03/CO-01: Opus + Astra coordinate, Fable + Sol review, one plan and one acceptance path", async () => {
    const f = await setup();
    const { goal } = await start(
      f,
      "Add the coordinator feature; coordinate with Opus and Astra, review with Fable and Sol.",
    );
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const [coordination] = rounds(f, goal.id, "coordination");
    expect(coordination.members.map((m) => [m.memberId, m.model])).toEqual([
      ["coordinator-opus-1", "claude-opus-fixture"],
      ["coordinator-astra-2", "astra-fixture"],
    ]);
    const proposals = f.orchestrator.contributions(coordination.id, "p");
    expect(
      proposals
        .filter((c) => c.validation.state === "valid")
        .map((c) => c.memberId)
        .sort(),
    ).toEqual(["coordinator-astra-2", "coordinator-opus-1"]);
    // Both coordinator turns started before either returned.
    const coordinatorLaunches = f.driver.launches.filter(
      (l) => l.purpose === "coordinator-contribution",
    );
    expect(coordinatorLaunches).toHaveLength(2);
    expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(1);
    const view = f.orchestrator.goalView(goal.id);
    expect(view.rounds[0].endorsements.map((e) => e.implied)).toEqual([
      true,
      true,
    ]);
    const review = rounds(f, goal.id, "review")[0];
    expect(review.members.map((m) => m.model).sort()).toEqual([
      "claude-fable-fixture",
      "sol-fixture",
    ]);
    expect(view.review?.result).toBe("satisfied");
    await expect(
      f.orchestrator.accept({
        goalId: goal.id,
        digest: "wrong",
        commandId: cmd(),
      }),
    ).rejects.toThrow(/stale/);
    const accepted = await f.orchestrator.accept({
      goalId: goal.id,
      digest: f.orchestrator.acceptanceDigest(goal.id),
      commandId: cmd(),
    });
    expect(accepted.acceptance?.candidateId).toBe(
      goalOf(f, goal.id).candidateId,
    );
  });

  test("E2E-01/E2E-03/EX-10: three coordinators and five reviewers under two slots run in waves with every result counted", async () => {
    const f = await setup();
    const { goal } = await start(
      f,
      "Use three coordinators; include Opus and Astra. Use five reviewers; include Fable and Sol.",
    );
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.members).toHaveLength(3);
    expect(coordination.members.slice(0, 2).map((m) => m.model)).toEqual([
      "claude-opus-fixture",
      "astra-fixture",
    ]);
    expect(coordination.members.map((m) => m.wave)).toEqual([1, 1, 2]);
    const review = rounds(f, goal.id, "review")[0];
    expect(review.members).toHaveLength(5);
    expect(review.members.map((m) => m.wave)).toEqual([1, 1, 2, 2, 3]);
    expect(f.driver.maxRunning).toBe(2);
    const completion = f.orchestrator.goalView(goal.id).review!;
    expect(completion.includedContributionIds).toHaveLength(5);
    expect(completion.policy).toMatchObject({
      requiredReturned: 5,
      requiredTotal: 5,
    });
    // Later waves never saw earlier verdicts: review prompts carry no peer output.
    for (const l of f.driver.launches.filter(
      (x) => x.purpose === "candidate-review",
    ))
      expect(l.prompt).not.toContain("No findings");
  });

  test("E2E-03/CO-06: five coordinators with a three-of-five rule commit with two dissents retained", async () => {
    const f = await setup();
    const { goal } = await start(f, "Use five coordinators.");
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: goal.id,
      level: "goal-role",
      roleId: "coordinator",
      settings: { completion: { threshold: { kind: "count", count: 3 } } },
      commandId: cmd(),
    });
    const dissenters = ["coordinator-auto-4", "coordinator-auto-5"];
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution") {
        // Three members add a compatible task; their proposals identify the
        // combined candidate. The other two must endorse explicitly, and challenge.
        const plan: unknown[] = rosterPlan(turn);
        if (!dissenters.includes(turn.memberId))
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
            rationale: "The docs task is unnecessary.",
          }),
        };
      }
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.members).toHaveLength(5);
    expect(coordination.electorateIds).toHaveLength(5);
    expect(coordination.threshold).toBe(3);
    expect(coordination.stage).toBe("committed");
    const view = f.orchestrator.goalView(goal.id).rounds[0];
    expect(
      view.endorsements.filter((e) => e.stance === "endorse"),
    ).toHaveLength(3);
    expect(
      view.endorsements
        .filter((e) => e.stance === "challenge")
        .map((e) => e.memberId)
        .sort(),
    ).toEqual(dissenters);
    expect(
      view.contributions.filter(
        (c) => c.phase === "initial" && c.validation.state === "valid",
      ),
    ).toHaveLength(5);
  });

  test("CO-02: unresolved conflicts never dispatch; the owner's branch choice commits once", async () => {
    const f = await setup();
    const { goal } = await start(f, "Coordinate with Opus and Astra.");
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution") {
        // A real conflict: the two plans would let different files change.
        // Wording alone no longer counts (CO-02b).
        const plan = rosterPlan(turn);
        const opus = turn.memberId.includes("opus");
        plan[0].title = opus ? "Opus build" : "Astra build";
        plan[0].permittedOutputs = [opus ? "src/opus.ts" : "src/astra.ts"];
        return defaultReply(turn, plan);
      }
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.stage).toBe("awaiting-user");
    expect(coordination.reconciliationTurnsUsed).toBe(1);
    expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(0);
    expect(f.driver.launches.some((l) => l.purpose === "implementation")).toBe(
      false,
    );
    const astra = f.orchestrator
      .contributions(coordination.id, "p")
      .find(
        (c) => c.memberId.includes("astra") && c.validation.state === "valid",
      )!;
    const commandId = cmd();
    await f.orchestrator.chooseBranch({
      goalId: goal.id,
      roundId: coordination.id,
      contributionId: astra.id,
      commandId,
    });
    await f.orchestrator.chooseBranch({
      goalId: goal.id,
      roundId: coordination.id,
      contributionId: astra.id,
      commandId,
    });
    expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(1);
    expect(goalOf(f, goal.id).state).toBe("running");
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
  });

  test("CO-02b: coordinators who propose the same work in different words decide without the owner, and each endorses the merged wording explicitly", async () => {
    const f = await setup();
    const { goal } = await start(f, "Coordinate with Opus and Astra.");
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution") {
        const plan = rosterPlan(turn);
        const opus = turn.memberId.includes("opus");
        plan[0].title = opus ? "Opus build" : "Astra build";
        plan[0].brief = opus ? "Edit src/a.ts carefully." : "Change src/a.ts only.";
        plan[0].acceptanceCriteria = opus
          ? ["It works.", "Opus: tests pass."]
          : ["It works.", "Astra: no other file changes."];
        return defaultReply(turn, plan);
      }
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.stage).toBe("committed");
    expect(coordination.reconciliationTurnsUsed).toBe(0);
    const plans = f.orchestrator.repo.all<CoordinatorPlan>(kinds.plan, "p");
    expect(plans).toHaveLength(1);
    const [task] = plans[0].tasks;
    // Authority is exactly what both proposed; wording from both survives.
    expect(task.permittedOutputs).toEqual(["src/a.ts"]);
    expect(["Opus build", "Astra build"]).toContain(task.title);
    expect(task.brief).toMatch(/opus[^:]*: Edit src\/a\.ts carefully\./);
    expect(task.brief).toMatch(/astra[^:]*: Change src\/a\.ts only\./);
    expect(task.acceptanceCriteria.filter((c) => c === "It works.")).toHaveLength(1);
    expect(task.acceptanceCriteria).toEqual(
      expect.arrayContaining(["Opus: tests pass.", "Astra: no other file changes."]),
    );
    // Neither proposal was this exact plan, so nobody's endorsement is implied.
    const view = f.orchestrator.goalView(goal.id).rounds[0];
    const votes = view.endorsements.filter(
      (e) => e.candidateId === coordination.candidateId,
    );
    expect(votes.map((e) => e.memberId).sort()).toEqual(
      coordination.electorateIds.slice().sort(),
    );
    expect(votes.every((e) => e.stance === "endorse" && !e.implied)).toBe(true);
  });

  test("CO-02c: a coordinator who challenges the merged wording is not overridden", async () => {
    const f = await setup();
    const { goal } = await start(f, "Coordinate with Opus and Astra.");
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution") {
        const plan = rosterPlan(turn);
        plan[0].brief = turn.memberId.includes("opus")
          ? "Put the line at the top."
          : "Put the line at the bottom.";
        return defaultReply(turn, plan);
      }
      if (
        turn.purpose === "coordinator-endorsement" &&
        turn.memberId.includes("astra")
      ) {
        const r = JSON.parse((defaultReply(turn) as { text: string }).text);
        return {
          text: JSON.stringify({
            ...r,
            stance: "challenge",
            rationale: "The two briefs contradict each other.",
          }),
        };
      }
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.stage).toBe("awaiting-user");
    expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(0);
    expect(f.driver.launches.some((l) => l.purpose === "implementation")).toBe(
      false,
    );
    const view = f.orchestrator.goalView(goal.id).rounds[0];
    expect(
      view.endorsements.some(
        (e) => e.memberId.includes("astra") && e.stance === "challenge",
      ),
    ).toBe(true);
  });

  test("CO-02d: reconciled proposals that converge on one task in different words commit without the owner", async () => {
    // The 21 October live loop: initial plans named the same task with
    // different keys, the union was challenged as a duplicate, and both
    // reconciled plans kept one task but worded its brief differently.
    const f = await setup();
    const { goal } = await start(f, "Coordinate with Opus and Astra.");
    f.driver.reply = (turn) => {
      const opus = turn.memberId.includes("opus");
      if (turn.purpose === "coordinator-contribution") {
        const plan = rosterPlan(turn);
        if (turn.prompt.includes("All initial proposals are now collected")) {
          plan[0].brief = opus
            ? "Prepend the line and keep every other byte."
            : "Prepend the line; change nothing else.";
          return defaultReply(turn, plan);
        }
        if (!opus) plan[0].key = "prepend";
        return defaultReply(turn, plan);
      }
      if (
        turn.purpose === "coordinator-endorsement" &&
        turn.prompt.includes('"prepend"')
      ) {
        const r = JSON.parse((defaultReply(turn) as { text: string }).text);
        return {
          text: JSON.stringify({
            ...r,
            stance: "challenge",
            rationale: "Two tasks would edit the same file.",
          }),
        };
      }
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.stage).toBe("committed");
    expect(coordination.reconciliationTurnsUsed).toBe(1);
    const plans = f.orchestrator.repo.all<CoordinatorPlan>(kinds.plan, "p");
    expect(plans).toHaveLength(1);
    expect(plans[0].tasks).toHaveLength(1);
    const [task] = plans[0].tasks;
    expect(task.permittedOutputs).toEqual(["src/a.ts"]);
    expect(task.brief).toMatch(/opus[^:]*: Prepend the line and keep every other byte\./);
    expect(task.brief).toMatch(/astra[^:]*: Prepend the line; change nothing else\./);
    const view = f.orchestrator.goalView(goal.id).rounds[0];
    const votes = view.endorsements.filter(
      (e) => e.candidateId === coordination.candidateId,
    );
    expect(votes.map((e) => e.memberId).sort()).toEqual(
      coordination.electorateIds.slice().sort(),
    );
    expect(votes.every((e) => e.stance === "endorse" && !e.implied)).toBe(true);
  });
  test("CO-04/CO-07: a required coordinator that keeps failing blocks the decision; quorum cannot waive it", async () => {
    const f = await setup();
    const { goal } = await start(f, "Use three coordinators.");
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: goal.id,
      level: "goal-role",
      roleId: "coordinator",
      settings: { completion: { threshold: { kind: "count", count: 2 } } },
      commandId: cmd(),
    });
    f.driver.reply = (turn) =>
      turn.memberId === "coordinator-auto-3"
        ? { text: "not json" }
        : defaultReply(turn);
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    const coordination = rounds(f, goal.id, "coordination")[0];
    expect(coordination.stage).toBe("blocked");
    expect(coordination.detail).toContain(
      "A quorum cannot waive a required contribution",
    );
    expect(
      coordination.members.find((m) => m.memberId === "coordinator-auto-3"),
    ).toMatchObject({ state: "invalid", retries: 1 });
    expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(0);
  });

  test("RG-09: a member whose runtime reports another model cannot satisfy its role", async () => {
    const f = await setup();
    const { goal } = await start(f, "Coordinate with Opus.");
    f.driver.reply = (turn) =>
      turn.purpose === "coordinator-contribution"
        ? ({
            ...(defaultReply(turn) as object),
            reportedModel: "some-other-model",
          } as never)
        : defaultReply(turn);
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    const contributions = f.orchestrator.contributions(
      rounds(f, goal.id, "coordination")[0].id,
      "p",
    );
    expect(
      contributions.every(
        (c) =>
          c.validation.state === "invalid" &&
          c.validation.reason.includes("some-other-model"),
      ),
    ).toBe(true);
  });

  test("RV-01/RV-06: four clean reports cannot erase the fifth reviewer's finding; repair needs a new review round", async () => {
    const f = await setup();
    const { goal } = await start(f, "Use five reviewers.");
    f.driver.reply = (turn) => {
      if (
        turn.purpose === "candidate-review" &&
        turn.memberId === "reviewer-auto-5" &&
        turn.candidateId === "integrated-1"
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
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    const view = f.orchestrator.goalView(goal.id);
    expect(view.review).toMatchObject({ result: "blocked" });
    expect(view.review!.findings).toHaveLength(1);
    expect(view.review!.findings[0].silentMemberIds).toHaveLength(4);
    expect(view.goal.detail).toContain(
      "Clean reports do not resolve a finding by omission",
    );
    await f.orchestrator.repair({ goalId: goal.id, commandId: cmd() });
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const reviews = rounds(f, goal.id, "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[1].input.candidateId).toBe("integrated-2");
    expect(reviews[1].members).toHaveLength(5);
    expect(f.driver.integrations[1].base).toBe("integrated-1");
  });

  test("RV-02/RV-07: missing or invalid required reports keep the review incomplete with exact counts", async () => {
    const f = await setup();
    const { goal } = await start(f, "Use five reviewers.");
    f.driver.reply = (turn) =>
      turn.purpose === "candidate-review" && turn.memberId === "reviewer-auto-4"
        ? "hang"
        : defaultReply(turn);
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 40,
      until: () => false,
    });
    const review = rounds(f, goal.id, "review")[0];
    const progress = f.orchestrator.progress(review);
    expect(progress).toMatch(/^3 of 5 reviews returned; 1 running; 1 queued/);
    expect(goalOf(f, goal.id).state).toBe("reviewing");
    f.driver.reply = (turn) =>
      turn.purpose === "candidate-review" && turn.memberId === "reviewer-auto-4"
        ? { text: "{}" }
        : defaultReply(turn);
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    expect(f.orchestrator.goalView(goal.id).review).toMatchObject({
      result: "incomplete",
    });
    expect(goalOf(f, goal.id).detail).toContain(
      "A missing or invalid required report is not a pass",
    );
  });

  test("EX-08: an information goal completes without a fabricated candidate or check", async () => {
    const f = await setup();
    f.driver.reply = (turn) =>
      turn.purpose === "coordinator-contribution"
        ? defaultReply(turn, defaultPlan("information"))
        : defaultReply(turn);
    const { goal } = await start(
      f,
      "Research which logging library fits.",
      "information",
    );
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("completed");
    const done = goalOf(f, goal.id);
    expect(done.candidateId).toBeNull();
    expect(done.synthesis).toContain("No code candidate or check was produced");
    expect(f.driver.integrations).toHaveLength(0);
  });

  test("EX-12/EX-04: a three-member partitioned implementation group integrates three candidates and reviews the result", async () => {
    const f = await setup();
    const { goal } = await start(f, "Use three implementers.");
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const work = rounds(f, goal.id, "work")[0];
    expect(work.members).toHaveLength(3);
    expect(
      Object.values(work.input.partitions).map((p) => p.permittedOutputs),
    ).toEqual([["src/part-1.ts"], ["src/part-2.ts"], ["src/part-3.ts"]]);
    expect(f.driver.integrations[0].candidates).toHaveLength(3);
    expect(rounds(f, goal.id, "review")[0].input.candidateId).toBe(
      "integrated-1",
    );
  });

  test("RG-04: two members of one provider and one account keep separate attempts and assignments", async () => {
    const f = await setup();
    const { goal } = await start(f, "Review with Astra and Sol.");
    await drive(f.orchestrator, f.driver, goal.id);
    const review = rounds(f, goal.id, "review")[0];
    expect(review.members.map((m) => m.provider)).toEqual(["codex", "codex"]);
    expect(new Set(review.members.map((m) => m.assignmentId)).size).toBe(2);
    expect(new Set(review.members.flatMap((m) => m.attemptIds)).size).toBe(2);
    const launches = f.driver.launches.filter(
      (l) => l.purpose === "candidate-review",
    );
    expect(launches.map((l) => l.assignment.nativeAccountKey)).toEqual([
      "codex-account",
      "codex-account",
    ]);
  });

  test("RG-07/RG-12: rosters survive restart and replan; reassignment mid-round freezes a new assignment map", async () => {
    const f = await setup();
    const { goal } = await start(f, "Coordinate with Opus and Astra.");
    f.driver.reply = (turn) =>
      turn.memberId.includes("astra") ? "hang" : defaultReply(turn);
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 4,
      until: () => false,
    });
    const first = rounds(f, goal.id, "coordination")[0];
    const opusContribution = f.orchestrator
      .contributions(first.id, "p")
      .find((c) => c.memberId.includes("opus"))!;
    expect(opusContribution.validation.state).toBe("valid");
    // Restart: a new engine over the same store keeps the exact roster.
    const reopened = f.reopen();
    expect(
      reopened
        .effective("p", goal.id, "coordinator")
        .members.map((m) => m.pin?.label),
    ).toEqual(["Opus", "Astra"]);
    // Replace Astra with Vega under the same member slot count.
    await reopened.setGroup({
      projectId: "p",
      goalId: goal.id,
      level: "goal-role",
      roleId: "coordinator",
      settings: {
        form: "exact",
        members: [
          {
            memberId: "coordinator-opus-1",
            required: true,
            pin: { label: "Opus" },
            fallbacks: [],
            preferences: { providers: [], models: [] },
            source: { kind: "ui", reference: null, provenance: "explicit" },
          },
          {
            memberId: "coordinator-astra-2",
            required: true,
            pin: { label: "Vega" },
            fallbacks: [],
            preferences: { providers: [], models: [] },
            source: { kind: "ui", reference: null, provenance: "explicit" },
          },
        ],
      },
      commandId: cmd(),
    });
    f.driver.reply = (turn) => defaultReply(turn);
    expect(await drive(reopened, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    const [old, fresh] = rounds(f, goal.id, "coordination");
    expect(old.stage).toBe("stale");
    expect(f.driver.interrupted.length).toBeGreaterThan(0);
    const replaced = fresh.members.find(
      (m) => m.memberId === "coordinator-astra-2",
    )!;
    expect(replaced.model).toBe("vega-fixture");
    expect(replaced.assignmentRevision).toBe(2);
    // The old round's Opus proposal does not count toward the new round.
    expect(
      f.orchestrator
        .contributions(fresh.id, "p")
        .some((c) => c.id === opusContribution.id),
    ).toBe(false);
  });

  test("CO-03/EX-05: steering during endorsement stales the old candidate; pause and stop fence every path", async () => {
    const f = await setup();
    const { conversation, goal } = await start(
      f,
      "Coordinate with Opus and Astra.",
    );
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution") {
        // Astra adds a compatible task, so the combined candidate needs Opus's explicit endorsement.
        const plan: unknown[] = rosterPlan(turn);
        if (turn.memberId.includes("astra"))
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
      if (turn.purpose === "coordinator-endorsement") return "hang";
      return defaultReply(turn);
    };
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 8,
      until: () => false,
    });
    const first = rounds(f, goal.id, "coordination")[0];
    expect(first.stage).toBe("endorsing");
    await f.orchestrator.post({
      conversationId: conversation.id,
      text: "Also keep the public API unchanged.",
      commandId: cmd(),
    });
    f.driver.reply = (turn) => defaultReply(turn);
    await f.orchestrator.tick();
    expect(rounds(f, goal.id, "coordination")[0].stage).toBe("stale");
    expect(f.orchestrator.repo.all(kinds.plan, "p")).toHaveLength(0);
    // Pause interrupts active members without consulting a model.
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 2,
      until: () => false,
      settle: false,
    });
    const before = f.driver.interrupted.length;
    await f.orchestrator.controlCommand({
      projectId: "p",
      goalId: goal.id,
      action: "pause",
      commandId: cmd(),
    });
    expect(goalOf(f, goal.id).state).toBe("paused");
    expect(f.driver.interrupted.length).toBeGreaterThan(before);
    const launchesWhilePaused = f.driver.launches.length;
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 5,
      until: () => false,
    });
    expect(f.driver.launches.length).toBe(launchesWhilePaused);
    await f.orchestrator.controlCommand({
      projectId: "p",
      goalId: goal.id,
      action: "resume",
      commandId: cmd(),
    });
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    await f.orchestrator.post({
      conversationId: conversation.id,
      text: "Stop everything.",
      commandId: cmd(),
    });
    expect(goalOf(f, goal.id).state).toBe("stopped");
  });

  test("CO-05: duplicate commands and a crash around launch create no duplicate work", async () => {
    const f = await setup();
    const conversation = await f.orchestrator.createConversation({
      projectId: "p",
      title: "Main",
      commandId: cmd(),
    });
    const commandId = cmd();
    const one = await f.orchestrator.post({
      conversationId: conversation.id,
      text: "Coordinate with Opus.",
      commandId,
    });
    const two = await f.orchestrator.post({
      conversationId: conversation.id,
      text: "Coordinate with Opus.",
      commandId,
    });
    expect(two.goal!.id).toBe(one.goal!.id);
    expect(f.orchestrator.repo.all(kinds.goal, "p")).toHaveLength(1);
    await f.orchestrator.tick();
    f.driver.crashAfterRecord = true;
    void f.orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.driver.launches).toHaveLength(1);
    // Restart: the recorded launch is adopted, not started again.
    const reopened = f.reopen();
    await reopened.recover();
    const round = rounds(f, one.goal!.id, "coordination")[0];
    expect(round.members[0]).toMatchObject({
      state: "running",
      attemptIds: ["attempt-1"],
    });
    expect(await drive(reopened, f.driver, one.goal!.id)).toBe(
      "awaiting-acceptance",
    );
    expect(
      f.driver.launches.filter((l) => l.purpose === "coordinator-contribution"),
    ).toHaveLength(1);
  });

  test("EX-01/EX-02: stages release capacity between turns; unknown fan-out runs one member at a time", async () => {
    const f = await setup();
    f.driver.routesList = [
      route(
        "codex",
        "codex-fixture",
        [
          ["astra-fixture", "Astra"],
          ["sol-fixture", "Sol"],
        ],
        { fanout: "unknown" },
      ),
    ];
    const { goal } = await start(
      f,
      "Coordinate with Astra and Sol. Review with Astra and Sol.",
    );
    expect(
      await drive(f.orchestrator, f.driver, goal.id, { maxSteps: 120 }),
    ).toBe("awaiting-acceptance");
    expect(f.driver.maxRunning).toBe(1);
    expect(
      rounds(f, goal.id, "coordination")[0].members.map((m) => m.wave),
    ).toEqual([1, 2]);
  });

  test("EX-11/EX-09: strict simultaneity beyond capacity blocks visibly; a partly started cohort is stopped and released", async () => {
    const f = await setup();
    const { goal } = await start(f, "Use three coordinators.");
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: goal.id,
      level: "goal-role",
      roleId: "coordinator",
      settings: { scheduling: "all-simultaneous" },
      commandId: cmd(),
    });
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 3,
      until: () => false,
    });
    const blocked = rounds(f, goal.id, "coordination").at(-1)!;
    expect(blocked.stage).toBe("blocked");
    expect(blocked.detail).toContain("All 3 members must run at once");
    expect(blocked.members).toHaveLength(3);
    expect(f.driver.launches).toHaveLength(0);
    f.driver.total = 3;
    f.driver.perProvider = 3;
    let refused = false;
    f.driver.failLaunch = (turn) => {
      if (turn.memberId === "coordinator-auto-3" && !refused) {
        refused = true;
        return true;
      }
      return false;
    };
    await f.orchestrator.restartRound({
      goalId: goal.id,
      roundId: blocked.id,
      commandId: cmd(),
    });
    await f.orchestrator.tick();
    await f.orchestrator.tick();
    const cohort = rounds(f, goal.id, "coordination").at(-1)!;
    expect(f.driver.interrupted.length).toBe(2);
    expect(
      cohort.members.find((m) => m.memberId === "coordinator-auto-3")!.state,
    ).toBe("queued");
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
  });

  test("RG-10/RG-08 in a goal: assisted or unresolved required members block the role instead of substituting", async () => {
    const f = await setup();
    const { goal } = await start(f, "Review with Nebula and Sol.");
    expect(
      await drive(f.orchestrator, f.driver, goal.id, {
        maxSteps: 40,
        until: (s) => s === "reviewing",
      }),
    ).toBe("reviewing");
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 3,
      until: () => false,
    });
    const g = goalOf(f, goal.id);
    expect(g.detail).toContain("Reviewers cannot start");
    expect(g.detail).toContain("Nebula");
    expect(rounds(f, goal.id, "review")).toHaveLength(0);
  });

  test("RV-04: a changed candidate makes the old review stale", async () => {
    const f = await setup();
    const { goal } = await start(f, "Review with Fable and Sol.");
    f.driver.reply = (turn) =>
      turn.purpose === "candidate-review" && turn.memberId.includes("sol")
        ? "hang"
        : defaultReply(turn);
    await drive(f.orchestrator, f.driver, goal.id, {
      maxSteps: 30,
      until: () => false,
    });
    const review = rounds(f, goal.id, "review")[0];
    expect(review.stage).toBe("collecting");
    f.orchestrator.store.put(kinds.goal, {
      ...goalOf(f, goal.id),
      candidateId: "integrated-other",
    });
    await f.orchestrator.tick();
    expect(rounds(f, goal.id, "review")[0].stage).toBe("stale");
    expect(rounds(f, goal.id, "review")).toHaveLength(2);
  });

  test("actions link to their attempts and plan commits are keyed by the decision", async () => {
    const f = await setup();
    const { goal } = await start(f, "Coordinate with Opus.");
    await drive(f.orchestrator, f.driver, goal.id);
    const actions = f.orchestrator.repo.all<QueuedPlanAction>(
      kinds.action,
      "p",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].attemptIds.length).toBeGreaterThan(0);
    expect(actions[0].state).toBe("completed");
    const contributions = f.orchestrator.repo.all<ParticipantContribution>(
      kinds.contribution,
      "p",
    );
    expect(new Set(contributions.map((c) => c.id)).size).toBe(
      contributions.length,
    );
  });
});

describe("required checks, conflict resolution and applying (scripted driver)", () => {
  const check = (id = "unit") => ({
    id,
    label: `${id} tests`,
    executable: "/fixture/bin/check",
    args: ["--all"],
    timeoutMs: 30_000,
  });
  async function startWith(
    f: Awaited<ReturnType<typeof setup>>,
    text: string,
    checks: ReturnType<typeof check>[] = [],
    kind: Goal["kind"] = "code",
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
    return posted.goal!;
  }

  test("CK-01: acceptance needs the review group and current passing evidence for every required check on the exact candidate", async () => {
    const f = await setup();
    const goal = await startWith(f, "Change the value.", [
      check("unit"),
      check("lint"),
    ]);
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("checking");
    // The protocol was frozen at the baseline members started from.
    expect(f.driver.boundChecks).toEqual([
      {
        goalId: goal.id,
        baseline: "baseline-candidate",
        ids: ["unit", "lint"],
      },
    ]);
    let current = goalOf(f, goal.id);
    expect(current.candidateId).toBe("integrated-1");
    expect(f.orchestrator.goalView(goal.id).review?.result).toBe("satisfied");
    expect(current.detail).toContain("2 of 2 not yet run");
    await expect(
      f.orchestrator.accept({
        goalId: goal.id,
        digest: f.orchestrator.acceptanceDigest(goal.id),
        commandId: cmd(),
      }),
    ).rejects.toThrow(/stale|not completed/);
    // One check fails on this candidate: acceptance stays closed.
    f.driver.checkResult = (id) => (id === "lint" ? "failed" : "passed");
    let plans = await f.orchestrator.previewChecks({ goalId: goal.id });
    expect(plans.map((p) => [p.definition.id, p.candidateId])).toEqual([
      ["unit", "integrated-1"],
      ["lint", "integrated-1"],
    ]);
    for (const plan of plans)
      await f.orchestrator.runCheck({ planId: plan.id, digest: plan.digest });
    current = goalOf(f, goal.id);
    expect(current.state).toBe("checking");
    expect(current.detail).toContain("lint tests failed");
    // Evidence on another task, or a plan for another candidate, never counts.
    f.driver.evidence.push({
      definitionId: "lint",
      verificationId: "elsewhere",
      result: "passed",
      targetRevision: "rev-integrated-1",
      evidenceArtifactId: "elsewhere",
      taskId: "another-task",
      candidateId: "integrated-1",
    });
    expect(f.orchestrator.checkStatus(goalOf(f, goal.id)).passing).toBe(false);
    plans = await f.orchestrator.previewChecks({ goalId: goal.id });
    const lint = plans.find((p) => p.definition.id === "lint")!;
    f.driver.checkPlans.set("stale-plan", {
      ...lint,
      id: "stale-plan",
      candidateId: "integrated-0",
    });
    await expect(
      f.orchestrator.runCheck({ planId: "stale-plan", digest: lint.digest }),
    ).rejects.toThrow(/stale candidate/);
    f.driver.checkResult = () => "passed";
    const before = f.orchestrator.acceptanceDigest(goal.id);
    await f.orchestrator.runCheck({ planId: lint.id, digest: lint.digest });
    current = goalOf(f, goal.id);
    expect(current.state).toBe("awaiting-acceptance");
    expect(f.orchestrator.acceptanceDigest(goal.id)).not.toBe(before);
    const accepted = await f.orchestrator.accept({
      goalId: goal.id,
      digest: f.orchestrator.acceptanceDigest(goal.id),
      commandId: cmd(),
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.detail).toContain("2 passing required checks");
    // Checks ran on one tester task bound to the accepted candidate.
    expect(f.driver.checkTasks).toEqual([current.checkTaskId]);
    expect(current.checkCandidateId).toBe(accepted.acceptance?.candidateId);
  });

  test("CK-02: checks belong to code goals, have distinct IDs and are fixed once implementation starts; stopping fences them", async () => {
    const f = await setup();
    await expect(
      startWith(f, "Research it.", [check()], "information"),
    ).rejects.toThrow(/Only code goals/);
    const goal = await startWith(f, "Change the value.");
    await expect(
      f.orchestrator.setChecks({
        goalId: goal.id,
        checks: [check("a"), check("a")],
        commandId: cmd(),
      }),
    ).rejects.toThrow(/distinct ID/);
    await f.orchestrator.setChecks({
      goalId: goal.id,
      checks: [check("a")],
      commandId: cmd(),
    });
    expect(goalOf(f, goal.id).checks?.map((c) => c.id)).toEqual(["a"]);
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("checking");
    await expect(
      f.orchestrator.setChecks({
        goalId: goal.id,
        checks: [],
        commandId: cmd(),
      }),
    ).rejects.toThrow(/fixed once implementation starts/);
    await f.orchestrator.controlCommand({
      projectId: "p",
      goalId: goal.id,
      action: "stop",
      commandId: cmd(),
    });
    expect(f.driver.cancelledChecks).toEqual([goal.id]);
    await expect(
      f.orchestrator.previewChecks({ goalId: goal.id }),
    ).rejects.toThrow(/after the review group/);
  });

  test("CF-01: the owner chooses one member's version per conflicting file; the result is integrated and reviewed again", async () => {
    const f = await setup();
    f.driver.integrateResult = (candidates, resolutions) => {
      const open = ["src/shared.ts", "src/other.ts"].filter(
        (p) => !resolutions.some((r) => r.path === p),
      );
      return open.length
        ? {
            conflicts: open.map((path) => ({ path, candidateIds: candidates })),
          }
        : { candidateId: "integrated-resolved" };
    };
    const goal = await startWith(f, "Use two implementers.");
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe("blocked");
    let view = f.orchestrator.goalView(goal.id);
    expect(view.conflicts.map((c) => c.path)).toEqual([
      "src/shared.ts",
      "src/other.ts",
    ]);
    const [first, second] = view.conflicts[0].options;
    expect(first.memberId).not.toBe(second.memberId);
    expect(first.memberId).toMatch(/^implementer/);
    expect(first.taskKey).toBe("build");
    expect(goalOf(f, goal.id).detail).toContain(
      `src/shared.ts changed differently by ${first.memberId}, ${second.memberId}`,
    );
    await expect(
      f.orchestrator.resolveConflicts({
        goalId: goal.id,
        resolutions: [
          { path: "src/unknown.ts", candidateId: first.candidateId },
        ],
        commandId: cmd(),
      }),
    ).rejects.toThrow(/not one of the recorded conflicts/);
    await expect(
      f.orchestrator.resolveConflicts({
        goalId: goal.id,
        resolutions: [{ path: "src/shared.ts", candidateId: "someone-else" }],
        commandId: cmd(),
      }),
    ).rejects.toThrow(/Choose a member that changed/);
    // A partial choice keeps the goal blocked on the rest.
    let next = await f.orchestrator.resolveConflicts({
      goalId: goal.id,
      resolutions: [{ path: "src/shared.ts", candidateId: second.candidateId }],
      commandId: cmd(),
    });
    expect(next.state).toBe("blocked");
    expect(next.conflicts?.map((c) => c.path)).toEqual(["src/other.ts"]);
    next = await f.orchestrator.resolveConflicts({
      goalId: goal.id,
      resolutions: [{ path: "src/other.ts", candidateId: first.candidateId }],
      commandId: cmd(),
    });
    expect(next.state).toBe("running");
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    expect(f.driver.integrations.at(-1)!.resolutions).toEqual([
      { path: "src/other.ts", candidateId: first.candidateId },
      { path: "src/shared.ts", candidateId: second.candidateId },
    ]);
    view = f.orchestrator.goalView(goal.id);
    expect(view.goal.candidateId).toBe("integrated-resolved");
    expect(view.conflicts).toEqual([]);
    expect(view.resolutions.every((r) => r.by === "local-user")).toBe(true);
    // The review group reviewed the resolved candidate, not an earlier one.
    expect(rounds(f, goal.id, "review").at(-1)!.input.candidateId).toBe(
      "integrated-resolved",
    );
  });

  test("AP-01: applying the accepted candidate is confirmed by digest, refused for a dirty folder and never repeated", async () => {
    const f = await setup();
    const goal = await startWith(f, "Change the value.");
    expect(await drive(f.orchestrator, f.driver, goal.id)).toBe(
      "awaiting-acceptance",
    );
    await expect(f.orchestrator.applicationReview(goal.id)).rejects.toThrow(
      /Only an accepted/,
    );
    await f.orchestrator.accept({
      goalId: goal.id,
      digest: f.orchestrator.acceptanceDigest(goal.id),
      commandId: cmd(),
    });
    const review = await f.orchestrator.applicationReview(goal.id);
    expect(review.files).toEqual([{ path: "src/a.ts", change: "modified" }]);
    expect(review.problems).toEqual([]);
    await expect(
      f.orchestrator.apply({
        goalId: goal.id,
        digest: "wrong",
        commandId: cmd(),
      }),
    ).rejects.toThrow(/stale/);
    f.driver.applyProblem = "The project folder has uncommitted changes.";
    expect((await f.orchestrator.applicationReview(goal.id)).problems).toEqual([
      f.driver.applyProblem,
    ]);
    let next = await f.orchestrator.apply({
      goalId: goal.id,
      digest: review.digest,
      commandId: cmd(),
    });
    expect(next.application).toMatchObject({
      state: "refused",
      candidateId: goal.candidateId ?? next.candidateId,
    });
    expect(next.application!.detail).toContain("Nothing was written");
    expect(f.driver.applied).toEqual([]);
    f.driver.applyProblem = null;
    next = await f.orchestrator.apply({
      goalId: goal.id,
      digest: review.digest,
      commandId: cmd(),
    });
    expect(next.application?.state).toBe("applied");
    expect(next.state).toBe("accepted");
    expect(f.driver.applied).toEqual([
      { goalId: goal.id, candidateId: next.candidateId },
    ]);
    await expect(
      f.orchestrator.apply({
        goalId: goal.id,
        digest: review.digest,
        commandId: cmd(),
      }),
    ).rejects.toThrow(/already applied/);
  });

  test("AP-02: an apply that fails after it may have written is uncertain and is not retried", async () => {
    const f = await setup();
    const goal = await startWith(f, "Change the value.");
    await drive(f.orchestrator, f.driver, goal.id);
    await f.orchestrator.accept({
      goalId: goal.id,
      digest: f.orchestrator.acceptanceDigest(goal.id),
      commandId: cmd(),
    });
    const review = await f.orchestrator.applicationReview(goal.id);
    f.driver.apply = async () => {
      throw new Error("disk full");
    };
    const next = await f.orchestrator.apply({
      goalId: goal.id,
      digest: review.digest,
      commandId: cmd(),
    });
    expect(next.application?.state).toBe("uncertain");
    expect(next.application?.detail).toContain("disk full");
    await expect(f.orchestrator.applicationReview(goal.id)).rejects.toThrow(
      /unknown outcome/,
    );
  });
});

describe("plan reconciliation: wording versus structure", () => {
  const proposal = (memberId: string, edit: (a: PlanTaskAction) => void) => {
    const action = normalizeAction(
      planActionSchema.parse(defaultPlan("implementation")[0]),
    );
    edit(action);
    return {
      contribution: { memberId } as ParticipantContribution,
      actions: [action],
      assumptions: [],
    };
  };
  test("proposals that differ only in title, brief and acceptance criteria combine into one action", () => {
    const combined = combineProposals([
      proposal("coordinator-a", (a) => {
        a.title = "Build A";
        a.brief = "Brief from A.";
        a.acceptanceCriteria = ["It works.", "A only."];
      }),
      proposal("coordinator-b", (a) => {
        a.title = "Build B";
        a.brief = "Brief from B.";
        a.acceptanceCriteria = ["It works.", "B only."];
      }),
    ]);
    expect(combined.agreement).toBe("combined");
    expect(combined.conflicts).toEqual([]);
    expect(combined.actions).toHaveLength(1);
    const [action] = combined.actions;
    expect(action.title).toBe("Build A");
    expect(action.brief).toBe(
      "coordinator-a: Brief from A.\n\ncoordinator-b: Brief from B.",
    );
    expect(action.acceptanceCriteria).toEqual(["It works.", "A only.", "B only."]);
    expect(action.permittedOutputs).toEqual(["src/a.ts"]);
  });
  test.each([
    ["permitted outputs", (a: PlanTaskAction) => void (a.permittedOutputs = ["src/b.ts"])],
    ["role", (a: PlanTaskAction) => void (a.roleId = "reviewer")],
    ["kind", (a: PlanTaskAction) => void (a.kind = "information")],
    ["dependencies", (a: PlanTaskAction) => void (a.dependencies = ["setup"])],
    [
      "partitions",
      (a: PlanTaskAction) =>
        void (a.partitions = [{ title: "One", permittedOutputs: ["src/a.ts"] }]),
    ],
  ])("a difference in %s stays a conflict", (_field, edit) => {
    const combined = combineProposals([
      proposal("coordinator-a", () => {}),
      proposal("coordinator-b", edit),
    ]);
    expect(combined.agreement).toBe("conflict");
    expect(combined.actions).toEqual([]);
    expect(combined.conflicts.map((c) => c.key)).toEqual(["build"]);
  });
  test("wording that cannot be merged within the action limits stays a conflict", () => {
    const long = "x".repeat(15_000);
    const briefs = combineProposals([
      proposal("coordinator-a", (a) => void (a.brief = `A ${long}`)),
      proposal("coordinator-b", (a) => void (a.brief = `B ${long}`)),
    ]);
    expect(briefs.agreement).toBe("conflict");
    const criteria = (prefix: string) =>
      Array.from({ length: 30 }, (_, i) => `${prefix} criterion ${i}`);
    const many = combineProposals([
      proposal("coordinator-a", (a) => void (a.acceptanceCriteria = criteria("A"))),
      proposal("coordinator-b", (a) => void (a.acceptanceCriteria = criteria("B"))),
    ]);
    expect(many.agreement).toBe("conflict");
  });
  test("identical proposals still match outright", () => {
    const combined = combineProposals([
      proposal("coordinator-a", () => {}),
      proposal("coordinator-b", () => {}),
    ]);
    expect(combined.agreement).toBe("matching");
  });
});
