import { z } from "zod";
import { hash, stable } from "../domain/invariants";
import {
  collaborationModes,
  type ExecutionPurpose,
} from "../domain/role-groups";
import {
  loopFunctions,
  type LoopDecisionStage,
  type LoopExpected,
  type LoopMode,
  type TurnProtocol,
} from "../domain/recursive-loops";

/**
 * The recursive-loop-v1 protocol. Coordinators propose these decisions; only
 * the loop supervisor commits the state transitions they describe. Every
 * field is required (nullable where absent) so a provider can enforce the
 * schema strictly, and every response repeats the exact revisions it was
 * given so an obsolete proposal is stored as history, never applied.
 */

const text = (max = 2000) => z.string().max(max);
const id = z.string().min(1).max(256);
const roleId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const score = z.number().min(0).max(1);

const criterionResult = z
  .object({
    criterionId: id,
    result: z.enum(["met", "unmet", "unknown"]),
    evidenceIds: z.array(id).max(50),
    citedPaths: z.array(z.string().min(1).max(4096)).max(50),
    note: text(),
  })
  .strict();

const proposedCriterion = z
  .object({
    text: z.string().min(1).max(2000),
    verification: z.enum(["check", "review", "artifact", "inspection"]),
    checkId: z.string().max(256).nullable(),
  })
  .strict();

export const assessGoalsSchema = z
  .object({
    kind: z.literal("assess_goals"),
    assessments: z
      .array(
        z
          .object({
            goalId: id,
            goalVersion: z.number().int().min(1),
            result: z.enum(["satisfied", "unmet", "blocked"]),
            criteria: z.array(criterionResult).max(50),
            proposedCriteria: z.array(proposedCriterion).max(20),
            blocker: text().nullable(),
            conflictsWith: z.array(id).max(20),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const opportunitySchema = z
  .object({
    title: z.string().min(1).max(300),
    observedIssue: z.string().min(1).max(4000),
    area: z.string().min(1).max(500),
    expectedBenefit: z.string().min(1).max(2000),
    baselineEvidence: z.array(text()).max(20),
    acceptanceConditions: z.array(z.string().min(1).max(2000)).min(1).max(20),
    estimatedScope: z.enum(["small", "medium", "large"]),
    dependencies: z.array(text(500)).max(20),
    whyNow: text(),
    approach: z.string().min(1).max(4000),
    scores: z
      .object({
        benefit: score,
        confidence: score,
        urgency: score,
        effort: score,
        regressionRisk: score,
      })
      .strict(),
  })
  .strict();

export const proposeOpportunitySchema = z
  .object({
    kind: z.literal("propose_opportunity"),
    opportunities: z.array(opportunitySchema).max(10),
  })
  .strict();

export const selectOpportunitySchema = z
  .object({
    kind: z.literal("select_opportunity"),
    /** An existing backlog ID, or a title from this response's proposals. */
    opportunity: z.string().min(1).max(300),
    reason: text(),
  })
  .strict();

export const planIterationSchema = z
  .object({
    kind: z.literal("plan_iteration"),
    goalIds: z.array(id).max(20),
    summary: z.string().min(1).max(4000),
    acceptanceConditions: z.array(text()).max(20),
    approach: z.string().min(1).max(4000),
  })
  .strict();

const teamOperation = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("create_role"),
      roleId,
      title: z.string().min(1).max(200),
      instructions: z.string().min(1).max(8000),
      function: z.enum(loopFunctions),
    })
    .strict(),
  z.object({ op: z.literal("activate_role"), roleId }).strict(),
  z.object({ op: z.literal("retire_role"), roleId }).strict(),
  z
    .object({
      op: z.literal("split_role"),
      roleId,
      into: z
        .array(
          z
            .object({
              roleId,
              title: z.string().min(1).max(200),
              instructions: z.string().min(1).max(8000),
            })
            .strict(),
        )
        .min(2)
        .max(8),
    })
    .strict(),
  z
    .object({
      op: z.literal("merge_roles"),
      roleIds: z.array(roleId).min(2).max(8),
      into: z
        .object({
          roleId,
          title: z.string().min(1).max(200),
          instructions: z.string().min(1).max(8000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_members"),
      roleId,
      count: z.number().int().min(1).max(64).nullable(),
      /** Observed model IDs only, in slot order. */
      models: z.array(z.string().min(1).max(200)).max(64),
      effort: z.string().max(100).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_collaboration"),
      roleId,
      collaboration: z.enum(collaborationModes),
      executionWidth: z.number().int().min(1).max(64).nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("bind_function"),
      function: z.enum(loopFunctions),
      roleId,
    })
    .strict(),
]);
export type TeamOperation = z.infer<typeof teamOperation>;

export const reconfigureTeamSchema = z
  .object({
    kind: z.literal("reconfigure_team"),
    operations: z.array(teamOperation).max(20),
    reason: z.string().min(1).max(4000),
    expectedBenefit: text(),
    evidenceIds: z.array(id).max(50),
    trigger: z.enum([
      "none",
      "unavailable-route",
      "invalid-output",
      "verification-failures",
      "repairs-exhausted",
      "no-progress",
      "new-requirements",
      "user-steering",
    ]),
  })
  .strict();

export const requestRepairSchema = z
  .object({
    kind: z.literal("request_repair"),
    failure: z.enum([
      "product-defect",
      "transient",
      "environment",
      "invalid-output",
      "integration",
    ]),
    summary: z.string().min(1).max(8000),
    approach: z.enum(["repair", "new-approach", "retry", "wait"]),
    roleId: roleId.nullable(),
  })
  .strict();

export const proposeIntegrationSchema = z
  .object({
    kind: z.literal("propose_integration"),
    paths: z.array(z.string().min(1).max(4096)).max(200),
    roleId: roleId.nullable(),
    summary: z.string().min(1).max(8000),
  })
  .strict();

export const proposePromotionSchema = z
  .object({
    kind: z.literal("propose_promotion"),
    candidateId: id,
    summary: z.string().min(1).max(4000),
  })
  .strict();

export const requestWaitSchema = z
  .object({
    kind: z.literal("request_wait"),
    condition: z.enum(["no-opportunity", "needs-input", "external"]),
    reason: z.string().min(1).max(4000),
    question: text().nullable(),
    goalIds: z.array(id).max(20),
    retryAfterSeconds: z
      .number()
      .int()
      .min(1)
      .max(7 * 86400)
      .nullable(),
  })
  .strict();

export const proposeGoalCompletionSchema = z
  .object({
    kind: z.literal("propose_goal_completion"),
    goalIds: z.array(id).max(50),
    summary: z.string().min(1).max(4000),
  })
  .strict();

const variants = {
  assess_goals: assessGoalsSchema,
  propose_opportunity: proposeOpportunitySchema,
  select_opportunity: selectOpportunitySchema,
  reconfigure_team: reconfigureTeamSchema,
  plan_iteration: planIterationSchema,
  request_repair: requestRepairSchema,
  propose_integration: proposeIntegrationSchema,
  propose_promotion: proposePromotionSchema,
  request_wait: requestWaitSchema,
  propose_goal_completion: proposeGoalCompletionSchema,
} as const;
export type LoopDecisionKind = keyof typeof variants;
export type LoopDecision = z.infer<(typeof variants)[LoopDecisionKind]>;
export const loopDecisionKinds = Object.keys(variants) as LoopDecisionKind[];

/** Which decisions a stage accepts, per mode. Endless never proposes completion. */
export function allowedDecisions(
  stage: LoopDecisionStage,
  mode: LoopMode,
): LoopDecisionKind[] {
  switch (stage) {
    case "boundary":
      return mode === "goal"
        ? [
            "assess_goals",
            "plan_iteration",
            "request_wait",
            "propose_goal_completion",
          ]
        : [
            "propose_opportunity",
            "select_opportunity",
            "plan_iteration",
            "request_wait",
          ];
    case "organize":
      return ["reconfigure_team", "request_wait"];
    case "evaluate":
      return [
        "assess_goals",
        "request_repair",
        "propose_integration",
        "propose_promotion",
      ];
  }
}

const expectedSchema = z
  .object({
    runId: id,
    iterationId: id.nullable(),
    controlGeneration: z.number().int(),
    authorityGeneration: z.number().int(),
    checkpointId: id,
    checkpointDigest: z.string().min(1).max(256),
    goalSetRevision: z.number().int(),
    topologyRevisionId: id,
    policyRevision: z.number().int(),
    overrideRevision: z.number().int(),
  })
  .strict();

/**
 * The envelope for one stage and mode. One boundary turn may both assess and
 * recommend, so an envelope carries one to four decisions, each permitted by
 * its stage. A zero-work outcome (request_wait alone) is a valid response.
 */
export function loopEnvelopeSchema(stage: LoopDecisionStage, mode: LoopMode) {
  const allowed = allowedDecisions(stage, mode).map((k) => variants[k]);
  const decision =
    allowed.length === 1
      ? allowed[0]
      : z.discriminatedUnion(
          "kind",
          allowed as unknown as [
            (typeof allowed)[number],
            (typeof allowed)[number],
            ...(typeof allowed)[number][],
          ],
        );
  return z
    .object({
      schemaVersion: z.literal(1),
      protocolKind: z.literal("recursive-loop-v1"),
      stage: z.literal(stage),
      inputDigest: z.string().min(1).max(256),
      expected: expectedSchema,
      idempotencyKey: z.string().min(1).max(256),
      decisions: z.array(decision).min(1).max(4),
    })
    .strict();
}
export type LoopDecisionEnvelope = {
  schemaVersion: 1;
  protocolKind: "recursive-loop-v1";
  stage: LoopDecisionStage;
  inputDigest: string;
  expected: LoopExpected;
  idempotencyKey: string;
  decisions: LoopDecision[];
};

/** Strict providers accept anyOf, not oneOf; the variants are disjoint by `kind`. */
function anyOf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(anyOf);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema))
    out[k === "oneOf" ? "anyOf" : k] = anyOf(v);
  return out;
}

/**
 * The output contract registry, keyed by execution purpose, protocol kind and
 * stage. Provider schema enforcement and final-response parsing both read it,
 * so an ordinary coordinator plan and a loop assessment on the same read-only
 * route each get their own shape.
 */
export function loopOutputSchema(
  purpose: ExecutionPurpose,
  protocol: TurnProtocol,
): Record<string, unknown> | null {
  if (protocol.kind !== "recursive-loop-v1") return null;
  if (
    purpose !== "coordinator-contribution" ||
    !protocol.stage ||
    !protocol.mode
  )
    return null;
  return anyOf(
    z.toJSONSchema(
      loopEnvelopeSchema(protocol.stage as LoopDecisionStage, protocol.mode),
    ),
  ) as Record<string, unknown>;
}

export function parseEnvelope(
  finalText: string | null,
  stage: LoopDecisionStage,
  mode: LoopMode,
  expected: LoopExpected,
  inputDigest: string,
):
  | { ok: true; value: LoopDecisionEnvelope }
  | { ok: false; reason: string; stale?: boolean } {
  if (!finalText?.trim())
    return { ok: false, reason: "The member returned no final message." };
  let raw: unknown;
  try {
    raw = JSON.parse(finalText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ok: false, reason: "The final message is not JSON." };
  }
  const kind = (raw as { protocolKind?: unknown })?.protocolKind;
  if (kind !== "recursive-loop-v1")
    return {
      ok: false,
      reason: `The response names protocol ${String(kind)}, not recursive-loop-v1; it is not interpreted as another contract.`,
    };
  const rawStage = (raw as { stage?: unknown }).stage;
  if (rawStage !== stage)
    return {
      ok: false,
      reason: `The response is for stage ${String(rawStage)}, not ${stage}.`,
    };
  const parsed = loopEnvelopeSchema(stage, mode).safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      reason: `The final message does not match the ${stage} contract (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "the reply"}: ${i.message}`)
        .join("; ")}).`,
    };
  const value = parsed.data as LoopDecisionEnvelope;
  if (
    value.inputDigest !== inputDigest ||
    stable(value.expected) !== stable(expected)
  )
    return {
      ok: false,
      stale: true,
      reason:
        "The response names different revisions or input; it is kept as history and is not a decision input.",
    };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Prompts. Bounded context: current goals, topology, checkpoint, relevant
// evidence and recent lessons, never the run's whole transcript.

export interface LoopPromptContext {
  /**
   * The native session's frozen import, by identity, so the round's input
   * digest covers it; the launch appends its text (docs/UX_Cleanup_Plan.md §3).
   */
  reference?: { id: string; digest: string } | null;
  mode: LoopMode;
  stage: LoopDecisionStage;
  memberId: string;
  instructions: string;
  title: string;
  priorities: string[];
  expected: LoopExpected;
  inputDigest: string;
  idempotencyKey: string;
  checkpoint: { id: string; sequence: number; changedSinceBase: string[] };
  goals: Array<{
    id: string;
    version: number;
    text: string;
    required: boolean;
    priority: number;
    status: string;
    criteria: Array<{
      id: string;
      text: string;
      verification: string;
      provenance: string;
    }>;
    blocker: string | null;
  }>;
  organization: Array<{
    roleId: string;
    title: string;
    purpose: string;
    functions: string[];
    members: Array<{ memberId: string; model: string | null; pinned: boolean }>;
    locked: string[];
    active: boolean;
  }>;
  models: Array<{
    model: string;
    name: string;
    provider: string;
    purposes: string[];
  }>;
  backlog: Array<{ id: string; title: string; state: string; score: number }>;
  rejected: Array<{ title: string; reason: string }>;
  evidence: Array<{ id: string; kind: string; detail: string }>;
  lessons: string[];
  target: { kind: string; id: string; changedFiles: string[] } | null;
  /**
   * The target's changed files, bounded. Read-only decision turns cannot be
   * relied on to read their copy (their shell reads may need approvals they
   * never get), so the evidence they judge is in the prompt.
   */
  files?: Array<{ path: string; text: string }>;
  handoff: string | null;
}

/**
 * One valid example of every decision, with every field. No production
 * adapter enforces the output schema on the provider side, so the prompt is
 * the contract a model sees and the parser is the gate; these examples are
 * validated against the schemas in the protocol tests.
 */
export const decisionExamples: {
  [K in LoopDecisionKind]: Extract<LoopDecision, { kind: K }>;
} = {
  assess_goals: {
    kind: "assess_goals",
    assessments: [
      {
        goalId: "<goal id>",
        goalVersion: 1,
        result: "unmet",
        criteria: [
          {
            criterionId: "<criterion id>",
            result: "unmet",
            evidenceIds: [],
            citedPaths: ["<file path in the target>"],
            note: "<what you observed>",
          },
        ],
        proposedCriteria: [],
        blocker: null,
        conflictsWith: [],
      },
    ],
  },
  plan_iteration: {
    kind: "plan_iteration",
    goalIds: ["<goal id>"],
    summary: "<what the next iteration should achieve>",
    acceptanceConditions: ["<observable condition>"],
    approach: "<how>",
  },
  request_wait: {
    kind: "request_wait",
    condition: "no-opportunity",
    reason: "<why no work now>",
    question: null,
    goalIds: [],
    retryAfterSeconds: null,
  },
  propose_goal_completion: {
    kind: "propose_goal_completion",
    goalIds: ["<goal id>"],
    summary: "<why every required goal is satisfied>",
  },
  propose_opportunity: {
    kind: "propose_opportunity",
    opportunities: [
      {
        title: "<short title>",
        observedIssue: "<what is wrong or missing>",
        area: "<files or component>",
        expectedBenefit: "<what better looks like>",
        baselineEvidence: [],
        acceptanceConditions: ["<observable condition>"],
        estimatedScope: "small",
        dependencies: [],
        whyNow: "<why it matters now>",
        approach: "<how>",
        scores: {
          benefit: 0.5,
          confidence: 0.5,
          urgency: 0.5,
          effort: 0.5,
          regressionRisk: 0.5,
        },
      },
    ],
  },
  select_opportunity: {
    kind: "select_opportunity",
    opportunity: "<backlog id or title>",
    reason: "<why this one>",
  },
  reconfigure_team: {
    kind: "reconfigure_team",
    operations: [
      {
        op: "set_members",
        roleId: "reviewer",
        count: 1,
        models: ["<observed model id>"],
        effort: null,
      },
    ],
    reason: "<why>",
    expectedBenefit: "<what improves>",
    evidenceIds: [],
    trigger: "none",
  },
  request_repair: {
    kind: "request_repair",
    failure: "product-defect",
    summary: "<what must change>",
    approach: "repair",
    roleId: null,
  },
  propose_integration: {
    kind: "propose_integration",
    paths: ["<file path>"],
    roleId: null,
    summary: "<how to combine>",
  },
  propose_promotion: {
    kind: "propose_promotion",
    candidateId: "<candidate id>",
    summary: "<why it satisfies the contract>",
  },
};

const decisionNotes: Record<LoopDecisionKind, string> = {
  assess_goals:
    'One entry per listed goal, with its exact goalId and goalVersion. result: "satisfied" | "unmet" | "blocked". One criteria entry per listed criterion of that goal: result "met" | "unmet" | "unknown"; cite evidenceIds from the evidence list and citedPaths that exist in the target. proposedCriteria only for a goal with no criteria yet: [{"text": "...", "verification": "check" | "review" | "artifact" | "inspection", "checkId": null}]. blocker: null or what you need from the owner. conflictsWith: other goal IDs this goal contradicts.',
  plan_iteration: "goalIds from the listed goals.",
  request_wait:
    'condition: "no-opportunity" | "needs-input" | "external". question: null or the question for the owner. goalIds: the goals the question blocks.',
  propose_goal_completion:
    "Only when every required goal is satisfied with evidence on this checkpoint.",
  propose_opportunity:
    'estimatedScope: "small" | "medium" | "large". Each score is a number from 0 to 1.',
  select_opportunity: "",
  reconfigure_team:
    'operations, each one of: {"op": "create_role", "roleId", "title", "instructions", "function": "coordination" | "evaluation" | "implementation" | "integration" | "review" | "information"}, {"op": "activate_role", "roleId"}, {"op": "retire_role", "roleId"}, {"op": "split_role", "roleId", "into": [{"roleId", "title", "instructions"}]}, {"op": "merge_roles", "roleIds": [...], "into": {"roleId", "title", "instructions"}}, {"op": "set_members", "roleId", "count": number | null, "models": [observed model IDs], "effort": null}, {"op": "set_collaboration", "roleId", "collaboration": "solo" | "parallel-independent" | "parallel-partitioned" | "peer-collaboration" | "sequential", "executionWidth": number | null}, {"op": "bind_function", "function", "roleId"}. An empty operations list keeps the organization. trigger: "none" | "unavailable-route" | "invalid-output" | "verification-failures" | "repairs-exhausted" | "no-progress" | "new-requirements" | "user-steering".',
  request_repair:
    'failure: "product-defect" | "transient" | "environment" | "invalid-output" | "integration". approach: "repair" | "new-approach" | "retry" | "wait". roleId: null or an active implementation role.',
  propose_integration: "",
  propose_promotion: "",
};

/** The decision shapes for a stage, with the context's real IDs where known. */
function decisionShapes(c: LoopPromptContext): string {
  return allowedDecisions(c.stage, c.mode)
    .map((kind) => {
      let example: LoopDecision = decisionExamples[kind];
      if (kind === "assess_goals" && c.goals.length)
        example = {
          kind: "assess_goals",
          assessments: c.goals.map((g) => ({
            goalId: g.id,
            goalVersion: g.version,
            result: "unmet",
            criteria: g.criteria.map((k) => ({
              criterionId: k.id,
              result: "unmet",
              evidenceIds: [],
              citedPaths: [],
              note: "<what you observed>",
            })),
            proposedCriteria: g.criteria.length
              ? []
              : [
                  {
                    text: "<observable acceptance criterion>",
                    verification: "inspection",
                    checkId: null,
                  },
                ],
            blocker: null,
            conflictsWith: [],
          })),
        };
      return `- ${kind}: ${JSON.stringify(example)}${decisionNotes[kind] ? `\n  ${decisionNotes[kind]}` : ""}`;
    })
    .join("\n");
}

const bounded = (items: string[], max: number, chars = 600) =>
  items
    .slice(0, max)
    .map((s) => (s.length > chars ? `${s.slice(0, chars)}…` : s));

export function loopPrompt(c: LoopPromptContext): string {
  const allowed = allowedDecisions(c.stage, c.mode);
  const stageText: Record<LoopDecisionStage, string> = {
    boundary:
      c.mode === "goal"
        ? "Assess every listed goal against the accepted checkpoint. Derive concrete acceptance criteria for goals that have none. Recommend which goals the next iteration should advance. Ask only when a material ambiguity prevents correct progress."
        : "Inspect the accepted checkpoint and recorded evidence. Propose worthwhile improvements with what better looks like, or request a wait when nothing currently meets the bar. Improvement is not more code: simplification, deletion, clearer documentation or leaving stable code alone are valid.",
    organize:
      "Decide the organization for the next iteration: which roles are active, how many members each has, which observed models fill Auto slots, and which role serves each function. Keep a successful organization unless evidence suggests a change; prefer a small change when evidence is weak. Locked fields cannot change.",
    evaluate:
      "Evaluate the exact candidate. Assess every listed goal and criterion (not only the targeted ones) so regressions are found. Cite evidence by ID; your agreement alone never replaces missing evidence. Request repair when the contract is not met.",
  };
  return [
    `You are coordinator ${c.memberId} in ${c.mode === "goal" ? "a Goal" : "an Endless"} loop run "${c.title}". Stage: ${c.stage}. You propose decisions; the loop supervisor validates and commits them. You cannot change user locks, waive requirements, delete goals or weaken criteria.`,
    `Role instructions: ${c.instructions}`,
    c.priorities.length
      ? `User priorities:\n- ${bounded(c.priorities, 20).join("\n- ")}`
      : "",
    `Accepted checkpoint ${c.checkpoint.sequence} (${c.checkpoint.id}).${c.checkpoint.changedSinceBase.length ? ` Changed since the run started: ${bounded(c.checkpoint.changedSinceBase, 60, 200).join(", ")}.` : ""}`,
    c.goals.length
      ? `Goals:\n${c.goals
          .map(
            (g) =>
              `- ${g.id} v${g.version} [${g.required ? "required" : "optional"}, priority ${g.priority}, ${g.status}${g.blocker ? `, blocked: ${g.blocker}` : ""}]: ${g.text}${g.criteria.length ? `\n${g.criteria.map((k) => `  - criterion ${k.id} (${k.verification}, ${k.provenance}): ${k.text}`).join("\n")}` : "\n  - no criteria yet"}`,
          )
          .join("\n")}`
      : "",
    c.target
      ? `Target ${c.target.kind} ${c.target.id}. Changed files: ${bounded(c.target.changedFiles, 200, 200).join(", ") || "none"}.`
      : "",
    c.files?.length
      ? `Contents of the target's changed files (read-only; cite a path in citedPaths when you rely on it):\n${c.files.map((f) => `### ${f.path}\n\`\`\`\n${f.text}\n\`\`\``).join("\n")}`
      : "",
    c.evidence.length
      ? `Evidence you may cite (by ID):\n${bounded(
          c.evidence.map((e) => `${e.id} (${e.kind}): ${e.detail}`),
          60,
        ).join("\n")}`
      : "No recorded evidence for this target yet.",
    `Organization:\n${c.organization
      .map(
        (r) =>
          `- ${r.roleId} (${r.title}; ${r.purpose}; ${r.active ? "active" : "inactive"}; functions: ${r.functions.join(", ") || "none"}${r.locked.length ? `; locked by the user: ${r.locked.join(", ")}` : ""}): ${r.members.map((m) => `${m.memberId}=${m.model ?? "unresolved"}${m.pinned ? " (pinned)" : ""}`).join(", ") || "no members resolved"}`,
      )
      .join("\n")}`,
    c.stage === "organize"
      ? `Observed models (use these exact IDs):\n${c.models.map((m) => `- ${m.model} (${m.name}, ${m.provider}; ready for ${m.purposes.join(", ")})`).join("\n")}`
      : "",
    c.backlog.length
      ? `Improvement backlog:\n${c.backlog.map((o) => `- ${o.id} [${o.state}, score ${o.score.toFixed(2)}]: ${o.title}`).join("\n")}`
      : "",
    c.rejected.length
      ? `Rejected before at this content (do not repeat unchanged):\n${bounded(
          c.rejected.map((r) => `${r.title}: ${r.reason}`),
          20,
        ).join("\n")}`
      : "",
    c.lessons.length
      ? `Recent lessons:\n- ${bounded(c.lessons, 10).join("\n- ")}`
      : "",
    c.handoff
      ? `Handoff from the previous coordination team:\n${c.handoff}`
      : "",
    stageText[c.stage],
    `Permitted decisions for this stage: ${allowed.join(", ")}. Each decision has exactly the fields shown, with these names, and no others (replace the example values):\n${decisionShapes(c)}`,
    `Reply with one JSON object only: {"schemaVersion": 1, "protocolKind": "recursive-loop-v1", "stage": "${c.stage}", "inputDigest": "${c.inputDigest}", "expected": ${JSON.stringify(c.expected)}, "idempotencyKey": "${c.idempotencyKey}", "decisions": [ one to four of the decisions above ]}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function loopEndorsementPrompt(input: {
  memberId: string;
  candidateDigest: string;
  summary: string;
  operations: unknown[];
}): string {
  return [
    `You are coordinator ${input.memberId}. Endorse or challenge this exact organization decision for the next iteration. You may also abstain.`,
    `Candidate digest (echo it exactly): ${input.candidateDigest}`,
    `Reason: ${input.summary}`,
    `Operations: ${JSON.stringify(input.operations)}`,
    'Reply with one JSON object only: {"candidateDigest": "...", "stance": "endorse" | "challenge" | "abstain", "rationale": "..."}.',
  ].join("\n\n");
}

export const loopInputDigest = (value: unknown) => hash(stable(value));

/** The identity of a team decision's content, for agreement across coordinators. */
export const operationsDigest = (operations: TeamOperation[]) =>
  hash(stable(operations));

/** An opportunity's identity: what it changes and how, not its wording order. */
export function opportunityFingerprint(o: {
  title: string;
  area: string;
  approach: string;
}): string {
  const norm = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      // Short words carry little identity; numbers carry a lot.
      .filter((w) => w.length > 2 || /^\d+$/.test(w))
      .sort()
      .join(" ");
  return hash(stable([norm(o.title), norm(o.area), norm(o.approach)])).slice(
    0,
    32,
  );
}

/**
 * Constrained prioritization: requirements and quality first (a candidate
 * must clear the threshold), then expected benefit, confidence and urgency
 * against effort and regression exposure. A transparent formula, not a claim
 * of optimality.
 */
export function priorityScore(
  scores: {
    benefit: number;
    confidence: number;
    urgency: number;
    effort: number;
    regressionRisk: number;
  },
  matchesPriority: boolean,
): number {
  const value =
    (0.5 * scores.benefit + 0.25 * scores.urgency + 0.25 * scores.confidence) *
      (1 - 0.5 * scores.regressionRisk) *
      (1 - 0.4 * scores.effort) +
    (matchesPriority ? 0.1 : 0);
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
