import { describe, expect, test } from "vitest";
import { purposeOutputSchema } from "../packages/orchestration/contracts";
import {
  allowedDecisions,
  decisionExamples,
  loopEnvelopeSchema,
  loopPrompt,
  opportunityFingerprint,
  parseEnvelope,
} from "../packages/orchestration/loop-contracts";
import {
  checkChange,
  rankModels,
  shouldRevert,
} from "../packages/orchestration/adaptation";
import {
  parsePriorities,
  splitGoals,
} from "../packages/orchestration/loop-engine";
import { effectiveGroup } from "../packages/orchestration/membership";
import { builtInRoleDefinitions } from "../packages/orchestration/roles";
import { parseMembership } from "../packages/orchestration/membership";
import type { LoopOutcome } from "../packages/domain/recursive-loops";

const expected = {
  runId: "r",
  iterationId: "i",
  controlGeneration: 2,
  authorityGeneration: 1,
  checkpointId: "c",
  checkpointDigest: "d",
  goalSetRevision: 1,
  topologyRevisionId: "t",
  policyRevision: 1,
  overrideRevision: 0,
};
const wait = {
  kind: "request_wait",
  condition: "no-opportunity",
  reason: "Nothing now.",
  question: null,
  goalIds: [],
  retryAfterSeconds: null,
};
const envelope = (
  stage: string,
  decisions: unknown[],
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    schemaVersion: 1,
    protocolKind: "recursive-loop-v1",
    stage,
    inputDigest: "x",
    expected,
    idempotencyKey: "k",
    decisions,
    ...extra,
  });

describe("recursive-loop-v1 protocol", () => {
  test("PR-05: loop assessments and ordinary plans on the same read-only route get their own contracts", () => {
    const plan = purposeOutputSchema("coordinator-contribution");
    const loop = purposeOutputSchema("coordinator-contribution", {
      kind: "recursive-loop-v1",
      stage: "boundary",
      mode: "endless",
    });
    expect(JSON.stringify(plan)).toContain("snapshotDigest");
    expect(JSON.stringify(loop)).toContain("recursive-loop-v1");
    // Strict providers accept anyOf, not oneOf.
    expect(JSON.stringify(loop)).not.toContain("oneOf");
    // A coordinator-v1 plan is not interpreted as a loop decision.
    const v1 = JSON.stringify({
      snapshotDigest: "x",
      summary: "s",
      assumptions: [],
      actions: [],
      concerns: [],
    });
    expect(parseEnvelope(v1, "boundary", "endless", expected, "x").ok).toBe(
      false,
    );
    // A response for another stage is rejected.
    const organize = parseEnvelope(
      envelope("organize", [wait]),
      "boundary",
      "endless",
      expected,
      "x",
    );
    expect(organize.ok).toBe(false);
  });

  test("zero-work decisions are valid; Endless never proposes completion", () => {
    expect(
      parseEnvelope(
        envelope("boundary", [wait]),
        "boundary",
        "endless",
        expected,
        "x",
      ).ok,
    ).toBe(true);
    expect(allowedDecisions("boundary", "endless")).not.toContain(
      "propose_goal_completion",
    );
    const completion = envelope("boundary", [
      { kind: "propose_goal_completion", goalIds: [], summary: "done" },
    ]);
    expect(
      parseEnvelope(completion, "boundary", "endless", expected, "x").ok,
    ).toBe(false);
    expect(
      parseEnvelope(completion, "boundary", "goal", expected, "x").ok,
    ).toBe(true);
  });

  test("an envelope naming other revisions is stale history, not a decision", () => {
    const stale = parseEnvelope(
      envelope("boundary", [wait], {
        expected: { ...expected, controlGeneration: 1 },
      }),
      "boundary",
      "endless",
      expected,
      "x",
    );
    expect(stale).toMatchObject({ ok: false, stale: true });
    expect(loopEnvelopeSchema("evaluate", "goal").safeParse({}).success).toBe(
      false,
    );
  });

  test("an opportunity's fingerprint ignores wording order but keeps numbers", () => {
    const a = opportunityFingerprint({
      title: "Speed up sync",
      area: "sync",
      approach: "Cache the index",
    });
    const b = opportunityFingerprint({
      title: "sync: speed up",
      area: "Sync",
      approach: "cache the index.",
    });
    expect(a).toBe(b);
    expect(
      opportunityFingerprint({ title: "Fix bug 42", area: "x", approach: "y" }),
    ).not.toBe(
      opportunityFingerprint({ title: "Fix bug 17", area: "x", approach: "y" }),
    );
  });
});

describe("decision shapes in the prompt", () => {
  // No production adapter enforces the output schema on the provider side
  // (live run, 19 October 2026: Codex invented field names), so the prompt's
  // examples are the contract and must parse.
  test("every example decision parses in each stage and mode that permits it", () => {
    for (const stage of ["boundary", "organize", "evaluate"] as const)
      for (const mode of ["goal", "endless"] as const)
        for (const kind of allowedDecisions(stage, mode)) {
          const text = envelope(stage, [decisionExamples[kind]]);
          const parsed = parseEnvelope(text, stage, mode, expected, "x");
          expect(
            parsed.ok,
            `${stage}/${mode}/${kind}: ${"reason" in parsed ? parsed.reason : ""}`,
          ).toBe(true);
        }
  });
  test("the prompt fills assess_goals with the listed goals and criteria", () => {
    const prompt = loopPrompt({
      mode: "goal",
      stage: "boundary",
      memberId: "m",
      instructions: "i",
      title: "t",
      priorities: [],
      expected,
      inputDigest: "x",
      idempotencyKey: "k",
      checkpoint: { id: "c", sequence: 0, changedSinceBase: [] },
      goals: [
        {
          id: "g1",
          version: 2,
          text: "Goal",
          required: true,
          priority: 0,
          status: "unassessed",
          criteria: [
            {
              id: "g1:c1",
              text: "C",
              verification: "inspection",
              provenance: "user",
            },
          ],
          blocker: null,
        },
      ],
      organization: [],
      models: [],
      backlog: [],
      rejected: [],
      evidence: [],
      lessons: [],
      target: null,
      handoff: null,
    });
    const line = /^- assess_goals: (\{.*\})$/m.exec(prompt)![1];
    const example = JSON.parse(line);
    expect(example.assessments[0]).toMatchObject({
      goalId: "g1",
      goalVersion: 2,
      criteria: [{ criterionId: "g1:c1" }],
    });
    expect(
      parseEnvelope(
        envelope("boundary", [example]),
        "boundary",
        "goal",
        expected,
        "x",
      ).ok,
    ).toBe(true);
    expect(prompt).toContain("no others");
  });
});

describe("goal intake", () => {
  test("a request splits into stable goals; run and membership instructions are not goals", () => {
    const text =
      "Make project synchronization reliable, add the missing coordinator controls, and ensure restart preserves the selected model teams. Work until all three goals are complete. Use Opus and Astra as the exact coordinator team. Include Fable among the reviewers. Choose everything else automatically.";
    expect(splitGoals(text)).toEqual([
      "Make project synchronization reliable",
      "Add the missing coordinator controls",
      "Ensure restart preserves the selected model teams",
    ]);
    const m = parseMembership(text, "m");
    expect(
      m.map((x) => [
        x.roleId,
        x.settings.form,
        x.settings.members?.map((y) => y.pin?.label),
      ]),
    ).toEqual([
      ["coordinator", "exact", ["Opus", "Astra"]],
      ["reviewer", "required-plus-auto", ["Fable"]],
    ]);
    expect(splitGoals("- Fix login\n- Document the API")).toEqual([
      "Fix login",
      "Document the API",
    ]);
    expect(
      parsePriorities(
        "Keep improving Topsl. Prioritize reliability, synchronization and clarity of the interface.",
      ),
    ).toEqual(["reliability", "synchronization", "clarity of the interface"]);
  });
});

describe("authority before scope", () => {
  test("OV-04: an automatic narrower setting never overrides the owner's wider pin", () => {
    const pin = {
      memberId: "reviewer-fable",
      required: true,
      pin: { label: "Fable" },
    };
    const group = effectiveGroup({
      projectId: "p",
      goalId: "g",
      role: builtInRoleDefinitions.reviewer,
      memberLimit: 8,
      layers: [
        {
          level: "project-role",
          revisionId: "user",
          settings: { form: "exact", members: [pin as never] },
          authority: "user",
        },
        {
          level: "task",
          revisionId: "auto",
          settings: { form: "auto", count: 4, members: [] },
          authority: "automatic",
        },
      ],
    });
    expect(group.form).toBe("exact");
    expect(group.members.map((m) => m.memberId)).toEqual(["reviewer-fable"]);
    expect(group.ignoredAutomatic).toEqual(expect.arrayContaining(["form"]));
    // Adaptive settings fill only what the owner left open.
    const open = effectiveGroup({
      projectId: "p",
      goalId: "g",
      role: builtInRoleDefinitions.reviewer,
      memberLimit: 8,
      layers: [
        {
          level: "project-role",
          revisionId: "user",
          settings: { form: "required-plus-auto", members: [pin as never] },
          authority: "user",
        },
        {
          level: "adaptive",
          revisionId: "t",
          settings: {
            count: 3,
            members: [
              {
                memberId: "reviewer-auto-1",
                required: true,
                pin: null,
                fallbacks: [],
                preferences: { providers: [], models: ["sol"] },
                source: {
                  kind: "auto",
                  reference: null,
                  provenance: "default",
                },
              },
            ],
          },
          authority: "automatic",
        },
      ],
    });
    expect(open.count).toBe(3);
    expect(open.members.map((m) => m.memberId)).toEqual([
      "reviewer-fable",
      "reviewer-auto-1",
    ]);
  });
});

describe("adaptation policy", () => {
  const roles = (model: string) => [
    {
      roleId: "coordinator",
      lineageId: "coordinator",
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
    },
  ];
  const t = (model: string) => ({
    roles: roles(model),
    roleBindings: [],
    change: "routine" as const,
  });
  const base = {
    policy: {
      dwellIterations: 3,
      explorationShare: 0.1,
      maxRoutineOperations: 2,
      windowIterations: 10,
    },
    operations: [
      {
        op: "set_members" as const,
        roleId: "coordinator",
        count: 1,
        models: ["a"],
        effort: null,
      },
    ],
    evidenceOutcomes: 2,
    windowTurns: 100,
    exploratoryTurns: 0,
    newExploratoryTurns: 0,
  };
  test("TM-09: dwell, swap-back and churn are rejected unless a trigger explains them", () => {
    expect(
      checkChange({
        ...base,
        trigger: "none",
        iterationsSinceChange: 1,
        history: [],
        proposed: t("a"),
        current: t("b"),
      }).reasons.join(" "),
    ).toMatch(/wait 3 evaluated iterations/);
    expect(
      checkChange({
        ...base,
        trigger: "none",
        iterationsSinceChange: 5,
        history: [t("a")],
        proposed: t("a"),
        current: t("b"),
      }).reasons.join(" "),
    ).toMatch(/swap-back/);
    expect(
      checkChange({
        ...base,
        trigger: "repairs-exhausted",
        iterationsSinceChange: 0,
        history: [t("a")],
        proposed: t("a"),
        current: t("b"),
      }).allowed,
    ).toBe(true);
  });
  test("a worse experiment restores the preceding organization", () => {
    expect(
      shouldRevert({
        current: { id: "t2", change: "routine", previousRevisionId: "t1" },
        underCurrent: ["rejected", "rejected"],
        underPrevious: ["promoted", "rejected"],
      }),
    ).toBe(true);
    expect(
      shouldRevert({
        current: { id: "t2", change: "trigger", previousRevisionId: "t1" },
        underCurrent: ["rejected", "rejected"],
        underPrevious: ["promoted"],
      }),
    ).toBe(false);
  });
  test("OP-02: difficulty context keeps harder work from demoting a model", () => {
    const o = (
      model: string,
      contribution: LoopOutcome["contribution"],
      result: LoopOutcome["iterationResult"],
      difficulty: LoopOutcome["difficulty"],
    ) =>
      ({
        model,
        provider: "codex",
        function: "implementation",
        taskFamily: "goal:goal",
        contribution,
        iterationResult: result,
        difficulty,
        usageCoverage: "unknown",
      }) as LoopOutcome;
    const outcomes = [
      // "hard" took three hard tasks: two promoted, one valid but rejected.
      o("hard", "valid", "promoted", "high"),
      o("hard", "valid", "promoted", "high"),
      o("hard", "valid", "rejected", "high"),
      // "easy" took three easy tasks: one promoted, two invalid.
      o("easy", "valid", "promoted", "low"),
      o("easy", "invalid", "rejected", "low"),
      o("easy", "invalid", "rejected", "low"),
    ];
    const r = rankModels({
      outcomes,
      function: "implementation",
      taskFamily: "goal:goal",
      eligible: ["easy", "hard", "new"],
    });
    expect(r.ranking[0]).toBe("hard");
    expect(r.basis).toBe("task-family");
    expect(
      r.stats.every(
        (s) => s.confidence === "moderate" || s.confidence === "low",
      ),
    ).toBe(true);
    expect(
      rankModels({
        outcomes: [],
        function: "implementation",
        taskFamily: "x",
        eligible: ["b", "a"],
      }),
    ).toMatchObject({ ranking: ["b", "a"], basis: "cold-start" });
  });
});
