import { afterEach, describe, expect, test } from "vitest";
import type { LoopOutcome } from "../packages/domain/recursive-loops";
import { commandSchema } from "../packages/domain/commands";
import {
  aggregateOutcomes,
  checkChange,
  rankModels,
  shouldRevert,
} from "../packages/orchestration/adaptation";
import {
  reconfigureTeamSchema,
  type LoopDecision,
} from "../packages/orchestration/loop-contracts";
import { loopKinds } from "../packages/orchestration/loop-engine";
import type { MemberTurn } from "../packages/orchestration/engine";
import { driveLoop, improvement, loopSetup, startRun } from "./loop-fixture";

/**
 * Campaign packet p6a-teams-auto (2026-10-19): optimizer rule correctness
 * (plan §5.9, §6.3) and loop override/topology boundaries (§6.1) at the
 * local stand-in layer. These tests check the rules as implemented; they say
 * nothing about measured product benefit, which needs live models (NOT RUN).
 */

// ---------------------------------------------------------------------------
// Pure rule tests (AUTO-06 … AUTO-10)

const outcome = (
  model: string,
  contribution: LoopOutcome["contribution"],
  iterationResult: LoopOutcome["iterationResult"],
  difficulty: LoopOutcome["difficulty"] = "low",
  extra: Partial<LoopOutcome> = {},
): LoopOutcome =>
  ({
    id: `${model}-${Math.random()}`,
    model,
    provider: "codex",
    function: "implementation",
    taskFamily: "goal:family",
    contribution,
    iterationResult,
    difficulty,
    usageCoverage: "unknown",
    ...extra,
  }) as LoopOutcome;
const stat = (outcomes: LoopOutcome[]) => aggregateOutcomes(outcomes)[0];

describe("AUTO-06: outcome credit, estimates, confidence and cold start", () => {
  test("AUTO-06: one outcome of each kind produces the hand-computed mean and lower estimate", () => {
    // Expected values computed by hand from the documented rule:
    // mean = (credited success + 1) / (weight + 2); lower = max(0, mean − 0.5/√(weight + 1)).
    const cases: Array<[LoopOutcome, number, number]> = [
      // valid + promoted: success = weight = 1 + d (d: low 0, medium 0.5, high 1).
      [outcome("x", "valid", "promoted", "low"), 0.6667, 0.3131],
      [outcome("x", "valid", "promoted", "medium"), 0.7143, 0.3981],
      [outcome("x", "valid", "promoted", "high"), 0.75, 0.4613],
      // valid, not promoted: success 0.4·(1 − d/2), weight 1 − d/2.
      [outcome("x", "valid", "rejected", "low"), 0.4667, 0.1131],
      [outcome("x", "valid", "rejected", "high"), 0.48, 0.0718],
      // invalid / missing: success 0, weight 1. failed: success 0.1, weight 1.
      [outcome("x", "invalid", "rejected"), 0.3333, 0],
      [outcome("x", "missing", "rejected"), 0.3333, 0],
      [outcome("x", "failed", "rejected"), 0.3667, 0.0131],
      // stale: no weight at all.
      [outcome("x", "stale", "rejected"), 0.5, 0],
    ];
    for (const [o, mean, lower] of cases)
      expect([
        o.contribution,
        o.iterationResult,
        o.difficulty,
        stat([o]).mean,
        stat([o]).lower,
      ]).toEqual([
        o.contribution,
        o.iterationResult,
        o.difficulty,
        mean,
        lower,
      ]);
  });

  test("AUTO-06: confidence is low below 3, moderate at 3 and 9, high at 10; family ranking needs 3 family outcomes", () => {
    const n = (k: number) =>
      Array.from({ length: k }, () => outcome("x", "valid", "promoted"));
    expect([0, 2, 3, 9, 10].slice(1).map((k) => stat(n(k)).confidence)).toEqual(
      ["low", "moderate", "moderate", "high"],
    );
    // Two family outcomes: the function's outcomes across families decide.
    const two = [
      outcome("a", "valid", "promoted"),
      outcome("a", "valid", "promoted"),
      outcome("b", "valid", "promoted", "low", { taskFamily: "goal:other" }),
      outcome("b", "valid", "promoted", "low", { taskFamily: "goal:other" }),
      outcome("b", "valid", "promoted", "low", { taskFamily: "goal:other" }),
    ];
    const byFunction = rankModels({
      outcomes: two,
      function: "implementation",
      taskFamily: "goal:family",
      eligible: ["a", "b"],
    });
    expect(byFunction.basis).toBe("function");
    expect(byFunction.ranking).toEqual(["b", "a"]);
    // Three family outcomes: the family decides, even against more data elsewhere.
    const three = [...two, outcome("a", "valid", "promoted")];
    const byFamily = rankModels({
      outcomes: three,
      function: "implementation",
      taskFamily: "goal:family",
      eligible: ["b", "a"],
    });
    expect(byFamily.basis).toBe("task-family");
    expect(byFamily.ranking).toEqual(["a", "b"]);
    // Other functions never count.
    expect(
      rankModels({
        outcomes: [
          outcome("r", "valid", "promoted", "low", { function: "review" }),
        ],
        function: "implementation",
        taskFamily: "goal:family",
        eligible: ["q", "r"],
      }),
    ).toMatchObject({ basis: "cold-start", ranking: ["q", "r"] });
  });

  test("AUTO-06: equal estimates keep the cold-start order; an unknown model ties with a zero-lower model; volume and self-reported fields earn nothing", () => {
    const outcomes = [
      outcome("p", "valid", "promoted"),
      outcome("q", "valid", "promoted"),
      outcome("z", "invalid", "rejected"),
    ];
    expect(
      rankModels({
        outcomes,
        function: "implementation",
        taskFamily: "goal:family",
        eligible: ["q", "new", "z", "p"],
      }).ranking,
    ).toEqual(["q", "p", "new", "z"]);
    expect(
      rankModels({
        outcomes,
        function: "implementation",
        taskFamily: "goal:family",
        eligible: ["z", "new", "p", "q"],
      }).ranking,
    ).toEqual(["p", "q", "z", "new"]);
    // Findings count, lines changed or a self-reported confidence change nothing.
    const plain = stat([outcome("v", "valid", "rejected", "medium")]);
    const noisy = stat([
      outcome("v", "valid", "rejected", "medium", {
        findings: 50,
        ...({ linesChanged: 10_000, selfConfidence: 1, commits: 40 } as object),
      }),
    ]);
    expect(noisy).toEqual(plain);
    // Unknown usage stays unknown, partial stays partial.
    expect(stat([outcome("u", "valid", "promoted")]).usageCoverage).toBe(
      "unknown",
    );
    expect(
      stat([
        outcome("u", "valid", "promoted", "low", { usageCoverage: "complete" }),
        outcome("u", "valid", "promoted"),
      ]).usageCoverage,
    ).toBe("partial");
  });

  test("AUTO-06 (observation): zero-weight stale outcomes still raise the confidence tier and can select the task-family basis", () => {
    // Current rule: confidence and the family threshold count records, not
    // evidence weight. Ten stale records read as "high" confidence with no
    // credited evidence. Recorded as an observed risk, not a confirmed defect.
    const stale = Array.from({ length: 10 }, () =>
      outcome("s", "stale", "rejected"),
    );
    expect(stat(stale)).toMatchObject({
      outcomes: 10,
      confidence: "high",
      mean: 0.5,
      lower: 0,
    });
    expect(
      rankModels({
        outcomes: stale.slice(0, 3),
        function: "implementation",
        taskFamily: "goal:family",
        eligible: ["s"],
      }).basis,
    ).toBe("task-family");
  });

  // CAMPAIGN DEFECT AUTO-06: a valid contribution to a failed hard iteration ranks below the same contribution to a failed easy one (adaptation.ts credit + lower bound).
  test.fails(
    "AUTO-06: a valid contribution to a failed hard iteration does not rank below the same contribution to a failed easy one",
    () => {
      // The source says harder tasks weigh less against a valid contributor,
      // and the plan says difficult assignments must not demote a model. The
      // mean honors that (0.48 > 0.4667), but ranking uses the lower estimate,
      // and the reduced weight widens the interval: 0.0718 < 0.1131.
      for (const k of [1, 5]) {
        const hard = Array.from({ length: k }, () =>
          outcome("hard", "valid", "rejected", "high"),
        );
        const easy = Array.from({ length: k }, () =>
          outcome("easy", "valid", "rejected", "low"),
        );
        expect(stat(hard).mean).toBeGreaterThan(stat(easy).mean);
        expect(
          rankModels({
            outcomes: [...easy, ...hard],
            function: "implementation",
            taskFamily: "goal:family",
            eligible: ["easy", "hard"],
          }).ranking[0],
        ).toBe("hard");
      }
    },
  );
});

describe("AUTO-07/AUTO-08: change policy boundaries", () => {
  const roles = (model: string, extra: string[] = []) => [
    ...["coordinator", ...extra].map((roleId) => ({
      roleId,
      lineageId: roleId,
      active: true,
      adaptive: {
        count: 1,
        models: [model],
        effort: null,
        collaboration: null,
        executionWidth: null,
      },
      origin: "coordinators" as const,
      reason: "",
    })),
  ];
  const t = (model: string) => ({
    roles: roles(model),
    roleBindings: [],
    change: "routine" as const,
  });
  const op = {
    op: "set_members" as const,
    roleId: "coordinator",
    count: 1,
    models: ["a"],
    effort: null,
  };
  const policy = {
    dwellIterations: 3,
    explorationShare: 0.1,
    maxRoutineOperations: 2,
    windowIterations: 10,
  };
  const base = {
    policy,
    trigger: "none",
    operations: [op],
    iterationsSinceChange: 3,
    history: [] as ReturnType<typeof t>[],
    proposed: t("a"),
    current: t("b"),
    evidenceOutcomes: 6,
    windowTurns: 100,
    exploratoryTurns: 0,
    newExploratoryTurns: 0,
  };
  const check = (over: Partial<typeof base>) =>
    checkChange({ ...base, ...over });

  test("AUTO-07: dwell 2 waits and 3 proceeds; weak evidence 5 limits operations to 2 and 6 lifts it; a trigger or bootstrap is exempt", () => {
    expect(check({}).allowed).toBe(true);
    expect(check({ iterationsSinceChange: 2 }).reasons.join(" ")).toMatch(
      /wait 3 evaluated iterations; 2 have passed/,
    );
    expect(
      check({ iterationsSinceChange: 2, trigger: "no-progress" }).allowed,
    ).toBe(true);
    // The supervisor passes "bootstrap" as the trigger for the first organize round.
    expect(
      check({ iterationsSinceChange: 0, trigger: "bootstrap" }).allowed,
    ).toBe(true);
    const three = [op, { ...op, roleId: "x" }, { ...op, roleId: "y" }];
    const two = three.slice(0, 2);
    expect(check({ evidenceOutcomes: 5, operations: two }).allowed).toBe(true);
    expect(
      check({ evidenceOutcomes: 5, operations: three }).reasons.join(" "),
    ).toMatch(
      /Evidence is weak \(5 outcomes\); a routine change may have at most 2/,
    );
    expect(check({ evidenceOutcomes: 6, operations: three }).allowed).toBe(
      true,
    );
    expect(
      check({
        evidenceOutcomes: 5,
        operations: three,
        trigger: "user-steering",
      }).allowed,
    ).toBe(true);
  });

  test("AUTO-07: A→B→A is a swap-back, a recurring organization is churn, both only without a trigger; the window is ten revisions; a no-op is always rejected", () => {
    expect(check({ history: [t("a")] }).reasons.join(" ")).toMatch(/swap-back/);
    expect(
      check({ history: [t("a")], trigger: "invalid-output" }).allowed,
    ).toBe(true);
    // Seen twice in the window, not most recently: churn.
    const churn = check({ history: [t("c"), t("a"), t("d"), t("a")] });
    expect(churn.reasons.join(" ")).toMatch(/churn/);
    expect(churn.reasons.join(" ")).not.toMatch(/swap-back/);
    // Seen once in the window: allowed.
    expect(check({ history: [t("c"), t("a"), t("d")] }).allowed).toBe(true);
    // The second sighting falls outside the ten-revision window: allowed.
    const old = [
      t("c"),
      t("a"),
      ...Array.from({ length: 8 }, (_, i) => t(`f${i}`)),
      t("a"),
    ];
    expect(old).toHaveLength(11);
    expect(check({ history: old }).allowed).toBe(true);
    // Inside the window (tenth entry): churn.
    expect(check({ history: old.slice(0, 9).concat([t("a")]) }).allowed).toBe(
      false,
    );
    // Operations that change nothing are rejected even with a trigger.
    expect(
      check({ proposed: t("b"), current: t("b"), trigger: "user-steering" })
        .reasons,
    ).toContain("The operations do not change the organization.");
    // No operations: nothing to check.
    expect(
      check({ operations: [], proposed: t("b"), current: t("b") }),
    ).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  test("AUTO-08: the exploration check uses (prior + new) / (window + new) against the share, inclusive at 10%; it is a per-proposal heuristic", () => {
    expect(check({ windowTurns: 90, newExploratoryTurns: 10 }).allowed).toBe(
      true,
    );
    expect(
      check({ windowTurns: 90, newExploratoryTurns: 11 }).reasons.join(" "),
    ).toMatch(/Untried models would take 11% of member turns/);
    expect(
      check({ windowTurns: 90, exploratoryTurns: 5, newExploratoryTurns: 6 })
        .allowed,
    ).toBe(false);
    // A trigger bypasses the allowance; so does a proposal with no untried model.
    expect(
      check({ windowTurns: 0, newExploratoryTurns: 3, trigger: "no-progress" })
        .allowed,
    ).toBe(true);
    expect(check({ windowTurns: 0, newExploratoryTurns: 0 }).allowed).toBe(
      true,
    );
    // Cold window: any untried model exceeds 10% when there is no history.
    expect(check({ windowTurns: 0, newExploratoryTurns: 1 }).allowed).toBe(
      false,
    );
  });
});

describe("AUTO-09/AUTO-10: revert predicate and provider attribution", () => {
  test("AUTO-09: 0/2 after 1/2 reverts; 1/2 after 2/2 does not; fewer than two evaluated, no predecessor or a triggered change never revert", () => {
    const current = {
      id: "t2",
      change: "routine" as const,
      previousRevisionId: "t1",
    };
    expect(
      shouldRevert({
        current,
        underCurrent: ["rejected", "rejected"],
        underPrevious: ["promoted", "rejected"],
      }),
    ).toBe(true);
    // Narrow predicate: a decline that is not to zero does not revert.
    expect(
      shouldRevert({
        current,
        underCurrent: ["promoted", "rejected"],
        underPrevious: ["promoted", "promoted"],
      }),
    ).toBe(false);
    // No-work and cancelled iterations are not evaluations.
    expect(
      shouldRevert({
        current,
        underCurrent: ["rejected", "no-work", "cancelled"],
        underPrevious: ["promoted"],
      }),
    ).toBe(false);
    expect(
      shouldRevert({
        current,
        underCurrent: ["rejected", "rejected"],
        underPrevious: ["rejected", "rejected"],
      }),
    ).toBe(false);
    expect(
      shouldRevert({
        current,
        underCurrent: ["rejected", "rejected"],
        underPrevious: [],
      }),
    ).toBe(false);
    for (const change of ["trigger", "bootstrap", "revert"] as const)
      expect(
        shouldRevert({
          current: { ...current, change: change as "routine" },
          underCurrent: ["rejected", "rejected"],
          underPrevious: ["promoted"],
        }),
      ).toBe(false);
    expect(
      shouldRevert({
        current: { ...current, previousRevisionId: null as never },
        underCurrent: ["rejected", "rejected"],
        underPrevious: ["promoted"],
      }),
    ).toBe(false);
  });

  test("AUTO-10: the same model ID on two providers keeps separate statistics", () => {
    const codex = Array.from({ length: 4 }, () =>
      outcome("shared", "valid", "promoted"),
    );
    const claude = Array.from({ length: 4 }, () =>
      outcome("shared", "invalid", "rejected", "low", { provider: "claude" }),
    );
    const stats = aggregateOutcomes([...codex, ...claude]);
    expect(
      stats.map((s) => [
        s.provider,
        s.model,
        s.outcomes,
        s.promoted,
        s.invalid,
      ]),
    ).toEqual([
      ["codex", "shared", 4, 4, 0],
      ["claude", "shared", 4, 0, 4],
    ]);
  });

  // CAMPAIGN DEFECT AUTO-10: rankModels keys statistics by model ID only, so the same ID on two providers is ranked by whichever provider's records came last (adaptation.ts rankModels `known` map).
  test.fails(
    "AUTO-10: ranking the same outcomes does not depend on record order when one model ID exists on two providers",
    () => {
      const codex = Array.from({ length: 4 }, () =>
        outcome("shared", "valid", "promoted"),
      );
      const claude = Array.from({ length: 4 }, () =>
        outcome("shared", "invalid", "rejected", "low", { provider: "claude" }),
      );
      const middling = Array.from({ length: 4 }, () =>
        outcome("other", "valid", "rejected"),
      );
      const rank = (outcomes: LoopOutcome[]) =>
        rankModels({
          outcomes,
          function: "implementation",
          taskFamily: "goal:family",
          eligible: ["other", "shared"],
        }).ranking;
      expect(rank([...middling, ...claude, ...codex])).toEqual(
        rank([...middling, ...codex, ...claude]),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// §6.1 role proposal schema boundaries (AUTO-05)

describe("§6.1 role proposals: operation count and split/merge sizes", () => {
  const proposal = (operations: unknown[]) => ({
    kind: "reconfigure_team",
    operations,
    reason: "r",
    expectedBenefit: "b",
    evidenceIds: [],
    trigger: "none",
  });
  const retire = (i: number) => ({ op: "retire_role", roleId: `role-${i}` });
  const child = (i: number) => ({
    roleId: `part-${i}`,
    title: `Part ${i}`,
    instructions: "Do it.",
  });
  test("AUTO-05: 0, 1 and 20 operations parse and 21 do not; split and merge accept 2 and 8 roles and refuse 1 and 9", () => {
    const ok = (v: unknown) => reconfigureTeamSchema.safeParse(v).success;
    for (const n of [0, 1, 20])
      expect(ok(proposal(Array.from({ length: n }, (_, i) => retire(i))))).toBe(
        true,
      );
    expect(ok(proposal(Array.from({ length: 21 }, (_, i) => retire(i))))).toBe(
      false,
    );
    const split = (n: number) =>
      proposal([
        {
          op: "split_role",
          roleId: "reviewer",
          into: Array.from({ length: n }, (_, i) => child(i)),
        },
      ]);
    const merge = (n: number) =>
      proposal([
        {
          op: "merge_roles",
          roleIds: Array.from({ length: n }, (_, i) => `role-${i}`),
          into: child(0),
        },
      ]);
    expect([1, 2, 8, 9].map((n) => ok(split(n)))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect([1, 2, 8, 9].map((n) => ok(merge(n)))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // set_members count and width: 1..64.
    const members = (count: unknown) =>
      proposal([
        {
          op: "set_members",
          roleId: "reviewer",
          count,
          models: [],
          effort: null,
        },
      ]);
    expect([0, 1, 64, 65, 1.5, null].map((c) => ok(members(c)))).toEqual([
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Loop-level overrides and topology (AUTO-02, AUTO-05, AUTO-11, J-07)

const open: Array<Awaited<ReturnType<typeof loopSetup>>> = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const setup = async () => {
  const t = await loopSetup();
  open.push(t);
  return t;
};
type T = Awaited<ReturnType<typeof setup>>;
const policy = { scheduling: { reserveForDirectWork: 0 } };
const done = (v: { run: { state: string } }) =>
  ["completed", "waiting", "stopped", "monitoring"].includes(v.run.state);
const wait = {
  kind: "request_wait",
  condition: "external",
  reason: "Keep.",
  question: null,
  goalIds: [],
  retryAfterSeconds: null,
} as LoopDecision;
const team = (operations: unknown[], trigger = "none") =>
  ({
    kind: "reconfigure_team",
    operations,
    reason: "Evidence suggests it.",
    expectedBenefit: "Better results.",
    evidenceIds: [],
    trigger,
  }) as LoopDecision;
const organizeOnce = (t: T, decisions: LoopDecision[]) => {
  let used = false;
  t.script.organize = () => {
    if (used) return [wait];
    used = true;
    return decisions;
  };
};
/** Scripted work: implementation turns implement their goals; evaluation sees them. */
function implementing(t: T) {
  const finished = new Set<string>();
  const pending = new Set<string>();
  const base = t.driver.reply;
  t.driver.reply = (turn: MemberTurn) => {
    if (turn.purpose === "implementation") {
      const section =
        /Goals advanced by this iteration:\n([\s\S]*?)(?:\n\n|$)/.exec(
          turn.prompt,
        )?.[1] ?? "";
      for (const line of section.split("\n")) {
        const text = /^- (.*?)(?: \(|$)/.exec(line)?.[1];
        if (text) pending.add(text);
      }
    }
    return base(turn);
  };
  t.script.met = (goalId, p) => {
    const g = p.goals.find((x) => x.id === goalId)!;
    if (p.stage === "evaluate") for (const x of pending) finished.add(x);
    return finished.has(g.text);
  };
}
async function created(t: T, text = "Add a greeting") {
  return t.supervisor.create({
    projectId: "p",
    mode: "goal",
    text,
    policy,
    commandId: `create-${Math.random()}`,
  });
}
async function startCreated(t: T, runId: string) {
  return t.supervisor.start({
    runId,
    digest: t.supervisor.authorityReview(runId).digest,
    commandId: `start-${Math.random()}`,
  });
}
const rejections = (v: {
  adaptations: Array<{ kind: string; rejections?: string[] }>;
}) =>
  v.adaptations
    .filter((a) => a.kind === "reject")
    .flatMap((a) => a.rejections ?? [])
    .join(" ");
const activeRoles = (v: {
  organization: Array<{ roleId: string; active: boolean }>;
}) =>
  v.organization
    .filter((r) => r.active)
    .map((r) => r.roleId)
    .sort();

describe("AUTO-11: active-role-count override validation", () => {
  test("AUTO-11: 0, a negative number and a string are refused before anything is stored", async () => {
    const t = await setup();
    const { run } = await created(t);
    for (const value of [0, -2, "4"])
      await expect(
        t.supervisor.setOverride({
          runId: run.id,
          kind: "active-role-count",
          value,
          commandId: `ov-${Math.random()}`,
        }),
      ).rejects.toThrow(/positive number/);
    expect(t.supervisor.overrides(run)).toEqual([]);
    expect(t.supervisor.run(run.id).overrideRevision).toBe(
      run.overrideRevision,
    );
    expect([...t.store.iterate(loopKinds.override)]).toHaveLength(0);
  });

  test("AUTO-11: the public command parses 1.5 and very large counts (observed input surface)", () => {
    const command = (value: unknown) => ({
      type: "loop-override-set",
      runId: "r",
      kind: "active-role-count",
      roleId: null,
      settings: null,
      value,
      commandId: "override-command",
    });
    const ok = (v: unknown) => commandSchema.safeParse(command(v)).success;
    expect(ok(4)).toBe(true);
    // The schema accepts any number: fraction, zero and huge values reach the engine.
    expect(ok(1.5)).toBe(true);
    expect(ok(0)).toBe(true);
    expect(ok(1e300)).toBe(true);
    expect(ok(Number.POSITIVE_INFINITY)).toBe(false);
    expect(ok(Number.NaN)).toBe(false);
  });

  test("AUTO-11 (observed effect): a stored 1.5 count makes every automatic reorganization impossible; the organization stays unchanged", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "create_role",
          roleId: "ui-specialist",
          title: "UI specialists",
          instructions: "Own interface changes.",
          function: "implementation",
        },
      ]),
    ]);
    const { run } = await created(t);
    const stored = await t.supervisor.setOverride({
      runId: run.id,
      kind: "active-role-count",
      value: 1.5,
      commandId: "ov-fraction",
    });
    expect(stored).toMatchObject({ kind: "active-role-count", value: 1.5 });
    await startCreated(t, run.id);
    const view = await driveLoop(t, run.id, done, 300);
    expect(rejections(view)).toContain(
      "You asked for exactly 1.5 active roles; this organization has 5.",
    );
    expect(activeRoles(view)).not.toContain("ui-specialist");
    expect(view.topology!.revision).toBe(1);
  });

  // CAMPAIGN DEFECT AUTO-11: setOverride accepts a fractional active-role count (loop-engine.ts setOverride checks only `typeof value === "number" && value >= 1`).
  test.fails(
    "AUTO-11: a fractional active-role count is rejected before it is stored",
    async () => {
      const t = await setup();
      const { run } = await created(t);
      await expect(
        t.supervisor.setOverride({
          runId: run.id,
          kind: "active-role-count",
          value: 1.5,
          commandId: "ov-fraction-refused",
        }),
      ).rejects.toThrow();
      expect(t.supervisor.overrides(run)).toEqual([]);
    },
  );

  // CAMPAIGN DEFECT AUTO-11: an active-role count no organization can satisfy (1 or 2, below the three distinct purposes the required functions need, or 1e9) is stored as a hard override.
  test.fails(
    "AUTO-11: an impossible active-role count (1, 2 or 1e9) is rejected before it is stored",
    async () => {
      const t = await setup();
      const { run } = await created(t);
      for (const value of [1, 2, 1e9])
        await expect(
          t.supervisor.setOverride({
            runId: run.id,
            kind: "active-role-count",
            value,
            commandId: `ov-impossible-${value}`,
          }),
        ).rejects.toThrow();
      expect(t.supervisor.overrides(run)).toEqual([]);
    },
  );
});

describe("AUTO-02/AUTO-05: owner locks and atomic topology proposals", () => {
  test("AUTO-02: a matching active-role count lets a count-preserving change through and refuses one that adds a role", async () => {
    // Bootstrap organization: coordinator, implementer, reviewer, researcher.
    for (const [count, expectCreated] of [
      [4, false],
      [5, true],
    ] as const) {
      const t = await setup();
      implementing(t);
      organizeOnce(t, [
        team([
          {
            op: "create_role",
            roleId: "ui-specialist",
            title: "UI specialists",
            instructions: "Own interface changes.",
            function: "implementation",
          },
        ]),
      ]);
      const { run } = await created(t);
      await t.supervisor.setOverride({
        runId: run.id,
        kind: "active-role-count",
        value: count,
        commandId: `ov-count-${count}`,
      });
      await startCreated(t, run.id);
      const view = await driveLoop(t, run.id, done, 300);
      expect(view.run.state).toBe("completed");
      if (expectCreated) {
        expect(activeRoles(view)).toContain("ui-specialist");
        expect(activeRoles(view)).toHaveLength(5);
      } else {
        expect(rejections(view)).toContain(
          "You asked for exactly 4 active roles; this organization has 5.",
        );
        expect(activeRoles(view)).toHaveLength(4);
      }
    }
  });

  test("AUTO-02: an always-present role cannot be retired or merged away, and an excluded provider's model cannot be proposed", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        { op: "retire_role", roleId: "researcher" },
        {
          op: "set_members",
          roleId: "reviewer",
          count: 1,
          models: ["claude-fable-fixture"],
          effort: null,
        },
      ]),
    ]);
    const { run } = await created(t);
    await t.supervisor.setOverride({
      runId: run.id,
      kind: "role-presence",
      roleId: "researcher",
      commandId: "ov-presence",
    });
    await t.supervisor.setOverride({
      runId: run.id,
      kind: "provider-exclusion",
      value: "claude",
      commandId: "ov-exclude",
    });
    await startCreated(t, run.id);
    const view = await driveLoop(t, run.id, done, 300);
    const reasons = rejections(view);
    expect(reasons).toMatch(/researcher carries your settings or pins/);
    expect(reasons).toMatch(
      /claude-fable-fixture is not an observed, qualified model for candidate-review/,
    );
    expect(activeRoles(view)).toContain("researcher");
    // No Claude route served the run while it was excluded.
    expect(
      t.driver.launches.some((l) => l.assignment.provider === "claude"),
    ).toBe(false);
    // Restart keeps both locks.
    expect(
      t
        .reopenSupervisor()
        .overrides(view.run)
        .map((o) => o.kind)
        .sort(),
    ).toEqual(["provider-exclusion", "role-presence"]);
  });

  test("AUTO-05: a proposal with one valid and one invalid operation commits none of them", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "create_role",
          roleId: "ui-specialist",
          title: "UI specialists",
          instructions: "Own interface changes.",
          function: "implementation",
        },
        {
          op: "set_members",
          roleId: "reviewer",
          count: 2,
          models: ["not-a-catalog-model"],
          effort: null,
        },
        {
          op: "create_role",
          roleId: "reviewer",
          title: "Dup",
          instructions: "Dup",
          function: "review",
        },
      ]),
    ]);
    const { run } = await created(t);
    await startCreated(t, run.id);
    const view = await driveLoop(t, run.id, done, 300);
    const reasons = rejections(view);
    expect(reasons).toMatch(
      /not-a-catalog-model is not an observed, qualified model/,
    );
    expect(reasons).toMatch(
      /Role reviewer already exists; activate it instead/,
    );
    // Atomic: the valid create_role was not committed either.
    expect(view.topology!.revision).toBe(1);
    expect(activeRoles(view)).not.toContain("ui-specialist");
    expect(t.orchestrator.repo.roles("p").map((r) => r.id)).not.toContain(
      "ui-specialist",
    );
    const topologies = [
      ...t.store.iterate<{ runId: string }>(loopKinds.topology),
    ].filter((x) => x.runId === run.id);
    expect(topologies).toHaveLength(1);
  });

  test("AUTO-05: a role split into two keeps predecessor lineage and moves its function bindings atomically", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "split_role",
          roleId: "researcher",
          into: [
            {
              roleId: "research-web",
              title: "Web research",
              instructions: "Web.",
            },
            {
              roleId: "research-code",
              title: "Code research",
              instructions: "Code.",
            },
          ],
        },
      ]),
    ]);
    const { run } = await created(t);
    await startCreated(t, run.id);
    const view = await driveLoop(t, run.id, done, 300);
    expect(view.topology!.revision).toBe(2);
    const org = Object.fromEntries(view.organization.map((r) => [r.roleId, r]));
    expect(org.researcher.active).toBe(false);
    expect(org["research-web"]).toMatchObject({
      active: true,
      lineageId: "researcher/research-web",
    });
    expect(org["research-code"].lineageId).toBe("researcher/research-code");
    // Split roles keep the predecessor's purpose.
    expect(t.orchestrator.repo.role("p", "research-web").purpose).toBe(
      "information",
    );
    // The function served by the old role moves to the first new role; the
    // binding keeps its stable lineage key.
    const information = view.topology!.bindings.find(
      (b) => b.function === "information",
    )!;
    expect(information).toMatchObject({
      roleId: "research-web",
      lineageId: "researcher",
    });
    expect(view.topology!.bindings.some((b) => b.roleId === "researcher")).toBe(
      false,
    );
  });
});

describe("J-07: automatic team learns, adds a specialist, changes a model, the owner restricts it, restart (stand-in)", () => {
  test("J-07: organization lineage and measured reasons are recorded; owner pins and exclusions survive reorganization and restart", async () => {
    const t = await setup();
    let n = 0;
    t.script.opportunities = () => [improvement(`Step ${++n}`)];
    t.script.met = (_id, p) => p.stage === "evaluate";
    const plan: LoopDecision[][] = [
      // First organize round: add a specialist (bootstrap exempt from dwell).
      [
        team([
          {
            op: "create_role",
            roleId: "perf-specialist",
            title: "Performance specialists",
            instructions: "Own performance work.",
            function: "implementation",
          },
        ]),
      ],
      // Later: change the reviewer model to a Claude model.
      [
        team([
          {
            op: "set_members",
            roleId: "reviewer",
            count: 1,
            models: ["claude-fable-fixture"],
            effort: null,
          },
        ]),
      ],
    ];
    let calls = 0;
    t.script.organize = () => plan[calls++] ?? [wait];
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: {
        ...policy,
        adaptation: { dwellIterations: 0, explorationShare: 1 },
      },
    });
    const runId = started.run.id;
    let view = await driveLoop(
      t,
      runId,
      (v) => (v.topology?.revision ?? 0) >= 3,
      800,
    );
    expect(view.topology!.revision).toBe(3);
    expect(activeRoles(view)).toContain("perf-specialist");
    const commits = view.adaptations.filter((a) => a.kind === "commit");
    expect(commits.length).toBeGreaterThanOrEqual(2);
    for (const c of commits)
      expect((c as { reason: string }).reason).toBe("Evidence suggests it.");
    // The owner excludes Claude and pins the reviewer to Sol.
    await t.supervisor.setOverride({
      runId,
      kind: "provider-exclusion",
      value: "claude",
      commandId: "j07-exclude",
    });
    await t.supervisor.setOverride({
      runId,
      kind: "role-settings",
      roleId: "reviewer",
      settings: {
        form: "exact",
        members: [
          {
            memberId: "reviewer-sol",
            required: true,
            pin: { label: "Sol" },
            fallbacks: [],
            preferences: { providers: [], models: [] },
            source: { kind: "ui", reference: null, provenance: "explicit" },
          },
        ],
      },
      commandId: "j07-pin",
    });
    // A later automatic proposal tries to move the reviewer back to Claude.
    plan.push([
      team(
        [
          {
            op: "set_members",
            roleId: "reviewer",
            count: 1,
            models: ["claude-opus-fixture"],
            effort: null,
          },
        ],
        "no-progress",
      ),
    ]);
    const launchesBefore = t.driver.launches.length;
    view = await driveLoop(
      t,
      runId,
      (v) => rejections(v).includes("exact roster"),
      800,
    );
    expect(rejections(view)).toMatch(/reviewer has your exact roster/);
    // Crash/restart: a new supervisor over the same store keeps the locks and lineage.
    const reopened = t.reopenSupervisor();
    const after = reopened.view(runId);
    expect(after.overrides.map((o) => o.kind).sort()).toEqual([
      "provider-exclusion",
      "role-settings",
    ]);
    expect(after.topology!.revision).toBe(view.topology!.revision);
    expect(activeRoles(after)).toContain("perf-specialist");
    const lineage = [
      ...t.store.iterate<{
        runId: string;
        revision: number;
        previousRevisionId: string | null;
        id: string;
      }>(loopKinds.topology),
    ]
      .filter((x) => x.runId === runId)
      .sort((a, b) => a.revision - b.revision);
    for (const [i, rev] of lineage.entries())
      if (i > 0) expect(rev.previousRevisionId).toBe(lineage[i - 1].id);
    // After the exclusion, later reviewer turns run on Sol, never Claude.
    await driveLoop(
      t,
      runId,
      () =>
        t.driver.launches
          .slice(launchesBefore)
          .some((l) => l.purpose === "candidate-review"),
      800,
      reopened,
    );
    const later = t.driver.launches
      .slice(launchesBefore)
      .filter((l) => l.purpose === "candidate-review");
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((l) => l.assignment.model === "sol-fixture")).toBe(true);
  });
});
