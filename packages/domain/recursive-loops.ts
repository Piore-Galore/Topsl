import { z } from "zod";
import { optionalFields } from "./patches";
import type {
  CollaborationMode,
  ExecutionPurpose,
  GoalCheckDefinition,
  RoleDefinition,
  RoleGroupSettings,
  RoundMember,
} from "./role-groups";

/**
 * Recursive Looping (docs/Recursive_Looping.md): a persistent, experimental
 * operating mode above the coordinator engine. A loop run repeatedly assesses,
 * organizes, plans, executes, verifies and promotes work against one shared
 * accepted checkpoint. Goal mode completes only when every current required
 * goal has valid evidence on the same accepted checkpoint; Endless mode has
 * no success terminal state.
 *
 * "Recursive" is a durable state machine with bounded calls and rounds, never
 * an unbounded call stack: child engine goals cannot start loop runs.
 */

export const LOOP_FEATURE_FLAG = "experimental.recursiveLooping";

export const loopModes = ["goal", "endless"] as const;
export type LoopMode = (typeof loopModes)[number];

/** Operational lifecycle, separate from the user's desired control state. */
export const loopLifecycleStates = [
  "active",
  "monitoring",
  "waiting",
  "paused",
  "suspended",
  "stopping",
  "stopped",
  "completed",
] as const;
export type LoopLifecycleState = (typeof loopLifecycleStates)[number];
export type LoopDesiredState = "running" | "paused" | "stopped";

export type LoopWaitReason =
  | { kind: "user-input"; detail: string; goalIds: string[] }
  /** Endless: no worthwhile improvement now; reassessment is scheduled. */
  | { kind: "no-opportunity"; detail: string }
  | { kind: "route"; detail: string }
  | { kind: "pinned-model"; detail: string }
  | { kind: "quota"; detail: string; retryAt: string | null }
  | { kind: "allowance"; detail: string; renewsAt: string | null }
  | { kind: "capacity"; detail: string }
  | { kind: "verification"; detail: string }
  | { kind: "authorization"; detail: string }
  | { kind: "recovery"; detail: string }
  /** A member turn's outcome is unknown: it holds its workspace until the
   * owner reconciles each named runtime run (plan invariant 7). */
  | { kind: "reconciliation"; detail: string; runIds: string[] }
  | { kind: "setup"; detail: string };

/**
 * The obligations a run's organization must cover. Each task still has one
 * execution purpose and one output contract; a function binding only says
 * which active role serves it.
 */
export const loopFunctions = [
  "coordination",
  "evaluation",
  "implementation",
  "integration",
  "review",
  "information",
] as const;
export type LoopFunction = (typeof loopFunctions)[number];

/** The execution purpose each function requires of the role bound to it. */
export const functionPurpose: Record<LoopFunction, ExecutionPurpose> = {
  coordination: "coordinator-contribution",
  evaluation: "coordinator-contribution",
  implementation: "implementation",
  integration: "implementation",
  review: "candidate-review",
  information: "information",
};
export const requiredFunctions: readonly LoopFunction[] = [
  "coordination",
  "evaluation",
  "implementation",
  "review",
];

/**
 * The active-role counts an owner may require. The required functions need
 * this many distinct execution purposes, so no organization has fewer roles;
 * the ceiling matches a role's member-limit ceiling, since an organization
 * cannot usefully run more roles than that.
 */
export const ACTIVE_ROLE_COUNT_MIN = new Set(
  requiredFunctions.map((fn) => functionPurpose[fn]),
).size;
export const ACTIVE_ROLE_COUNT_MAX = 64;

/** Why an active-role count cannot be stored, or null when it can. */
export function activeRoleCountProblem(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value))
    return `An active-role count must be a whole number, not ${String(value)}.`;
  if (value < ACTIVE_ROLE_COUNT_MIN)
    return `An active-role count must be at least ${ACTIVE_ROLE_COUNT_MIN}: the required functions need ${ACTIVE_ROLE_COUNT_MIN} distinct purposes (coordination, implementation and review). ${value} is too few.`;
  if (value > ACTIVE_ROLE_COUNT_MAX)
    return `An active-role count can be at most ${ACTIVE_ROLE_COUNT_MAX}; ${value} is too many.`;
  return null;
}

/** One active role's binding to one function, with an immutable revision. */
export interface ActiveRolePurposeBinding {
  /** Stable across revisions: lineage and function. */
  id: string;
  revision: number;
  roleId: string;
  /** Semantic lineage; renaming, splitting or merging preserves constraints by it. */
  lineageId: string;
  function: LoopFunction;
  purpose: ExecutionPurpose;
  outputContract: RoleDefinition["outputContract"];
  roleDefinitionRevision: number;
}

/** What the coordinator decided for a role's unconstrained fields. */
export interface AdaptiveRoleSettings {
  /** null: the role's own Auto count. */
  count: number | null;
  /** Observed model IDs, in slot order, for the role's Auto members. */
  models: string[];
  effort: string | null;
  collaboration: CollaborationMode | null;
  executionWidth: number | null;
}

export interface TopologyRole {
  roleId: string;
  lineageId: string;
  active: boolean;
  adaptive: AdaptiveRoleSettings;
  origin: "bootstrap" | "coordinators" | "supervisor" | "user";
  reason: string;
}

/** A frozen member assignment, keyed by role, member and binding. */
export interface AssignmentRevisionRef {
  roleId: string;
  memberId: string;
  bindingId: string | null;
  assignmentId: string;
  assignmentRevision: number;
  provider: "codex" | "claude" | null;
  model: string | null;
  required: boolean;
  status: string;
}

export interface TeamTopologyRevision {
  id: string;
  runId: string;
  projectId: string;
  /** Index scope: the run ID, so a run's records page without a full scan. */
  conversationId: string;
  revision: number;
  roles: TopologyRole[];
  roleBindings: ActiveRolePurposeBinding[];
  /** Filled when an iteration freezes this topology against current routes. */
  resolvedAssignmentRevisions: AssignmentRevisionRef[];
  overrideRevision: number;
  /** Advances when the coordination team changes: the old team loses authority. */
  authorityGeneration: number;
  proposedByRoundId: string | null;
  decisionDigest: string;
  evidenceIds: string[];
  /** The iteration number from which this organization applies. */
  effectiveFromIteration: number;
  previousRevisionId: string | null;
  reason: string;
  /** routine: dwell and exploration limits apply. trigger: an immediate cause. */
  change: "bootstrap" | "routine" | "trigger" | "revert" | "user" | "none";
  createdAt: string;
}

export const criterionVerificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), checkId: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("review") }),
  z.object({ kind: z.literal("artifact") }),
  z.object({ kind: z.literal("inspection") }),
]);
export type CriterionVerification = z.infer<typeof criterionVerificationSchema>;

export interface LoopCriterion {
  id: string;
  text: string;
  verification: CriterionVerification;
  required: boolean;
  provenance: "user" | "coordinator";
}

export const loopGoalStatuses = [
  "unassessed",
  "in_progress",
  "satisfied",
  "regressed",
  "blocked",
  "cancelled_by_user",
] as const;
export type LoopGoalStatus = (typeof loopGoalStatuses)[number];

export interface LoopGoal {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  /** Advances on every content change: wording, criteria, required or dependencies. */
  version: number;
  originalText: string;
  text: string;
  required: boolean;
  /** Lower runs first. Equal priorities share progress fairly. */
  priority: number;
  kind: "code" | "information";
  constraints: string[];
  criteria: LoopCriterion[];
  dependsOn: string[];
  externalInputs: string[];
  status: LoopGoalStatus;
  lastEvaluatedCheckpointId: string | null;
  lastAssessmentId: string | null;
  /** The checkpoint at which this goal was last satisfied. */
  satisfiedAtCheckpointId: string | null;
  evidenceIds: string[];
  openFindings: string[];
  blocker: string | null;
  /** A recorded conflict with other goals; both requirements are kept. */
  conflict: string | null;
  regression: {
    previousCheckpointId: string;
    checkpointId: string;
    iterationId: string | null;
  } | null;
  /** Fairness: how many iterations targeted this goal. */
  attempts: number;
  lastTargetedIteration: number | null;
  provenance: Array<{
    actor: string;
    commandId: string;
    change: string;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Immutable accepted project content. */
export interface LoopCheckpoint {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  sequence: number;
  candidateId: string;
  /** Digest of the file content, independent of workflow binding. */
  contentDigest: string;
  parentCheckpointId: string | null;
  iterationId: string | null;
  promotionId: string | null;
  kind: "initial" | "promoted";
  /** Pinned checkpoints keep their materialized copy and verification artifacts. */
  pinned: boolean;
  createdAt: string;
}

export const iterationStates = [
  "assessing",
  "organizing",
  "preparing",
  "executing",
  "verifying",
  "evaluating",
  "promoting",
  "promoted",
  "rejected",
  "no-work",
  "cancelled",
] as const;
export type IterationState = (typeof iterationStates)[number];

export interface IterationContract {
  summary: string;
  targets: Array<{
    goalId: string;
    goalVersion: number;
    criterionIds: string[];
  }>;
  opportunityId: string | null;
  acceptanceConditions: string[];
  approach: string;
  /** Approach identity: the same failed contract cannot repeat under a new ID. */
  fingerprint: string;
}

export interface LoopIteration {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  number: number;
  parentCheckpointId: string;
  goalIds: string[];
  opportunityId: string | null;
  topologyRevisionId: string;
  childExecutionGoalIds: string[];
  verificationProtocolRevision: string;
  controlGeneration: number;
  contract: IterationContract | null;
  state: IterationState;
  resultCheckpointId: string | null;
  assessmentIds: string[];
  outcomeRecordIds: string[];
  /**
   * Set in the transaction that promotes or rejects the iteration and cleared
   * when its child goal is settled and its outcome records, token totals and
   * reclaim are done, so a crash in between is finished on the next tick.
   * Absent on records written before this field existed.
   */
  settlementPending?: "promoted" | "rejected" | "cancelled" | null;
  promotionId: string | null;
  /** Why it did not promote, classified before any response. */
  failure: {
    kind:
      | "product-defect"
      | "transient"
      | "environment"
      | "invalid-output"
      | "integration"
      | "participation"
      | "limit"
      | "stopped";
    detail: string;
  } | null;
  repairs: number;
  /** Round restarts after invalid or missing required output. */
  restarts: number;
  memberTurns: number;
  /** The fully resolved assignments this iteration froze. */
  assignments: AssignmentRevisionRef[];
  detail: string;
  startedAt: string;
  endedAt: string | null;
  revision: number;
}

export interface CriterionAssessment {
  criterionId: string;
  result: "met" | "unmet" | "unknown";
  evidenceIds: string[];
  /** Service validation of the cited evidence. */
  validation:
    "valid" | "missing-evidence" | "stale-evidence" | "not-applicable";
  note: string;
  dissent: Array<{ memberId: string; result: string; note: string }>;
}

export interface GoalAssessment {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  goalId: string;
  goalVersion: number;
  target:
    | {
        kind: "candidate";
        candidateId: string;
        contentDigest: string;
        parentCheckpointId: string;
      }
    | { kind: "checkpoint"; checkpointId: string; contentDigest: string };
  protocolRevision: string;
  criteria: CriterionAssessment[];
  result: "satisfied" | "unmet" | "regressed" | "blocked";
  evidenceIds: string[];
  evaluatorRoundId: string | null;
  goalSetRevision: number;
  detail: string;
  createdAt: string;
}

export interface LoopOverride {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  /** The run's override revision this record created. */
  revision: number;
  kind:
    | "role-settings"
    | "role-presence"
    | "active-role-count"
    | "provider-exclusion"
    | "role-frozen";
  roleId: string | null;
  lineageId: string | null;
  settings: RoleGroupSettings | null;
  value: number | string | null;
  actor: string;
  commandId: string;
  messageId: string | null;
  source: "editor" | "message" | "start";
  hard: boolean;
  effectiveBoundary: "next-iteration" | "immediate";
  releasedBy: { commandId: string; at: string; revision: number } | null;
  createdAt: string;
}

export interface LoopOpportunity {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  fingerprint: string;
  title: string;
  observedIssue: string;
  area: string;
  expectedBenefit: string;
  baselineEvidence: string[];
  acceptanceConditions: string[];
  estimatedScope: "small" | "medium" | "large";
  dependencies: string[];
  whyNow: string;
  approach: string;
  scores: {
    benefit: number;
    confidence: number;
    urgency: number;
    effort: number;
    regressionRisk: number;
  };
  priorityScore: number;
  state: "proposed" | "selected" | "accepted" | "rejected" | "superseded";
  /** The accepted content this was found against; unchanged rejection stays rejected. */
  checkpointDigest: string;
  attempts: Array<{
    iterationId: string;
    outcome: "accepted" | "rejected";
    checkpointDigest: string;
  }>;
  proposedBy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LoopOutcome {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  iterationId: string;
  roleId: string;
  function: LoopFunction | null;
  bindingId: string | null;
  bindingRevision: number | null;
  memberId: string;
  assignmentId: string;
  assignmentRevision: number;
  provider: "codex" | "claude";
  model: string;
  installationId: string;
  installationRevision: string | null;
  effort: string | null;
  taskFamily: string;
  difficulty: "low" | "medium" | "high";
  candidateBasis: string;
  protocolVersion: string;
  cohort: string[];
  contribution: "valid" | "invalid" | "failed" | "missing" | "stale";
  iterationResult: "promoted" | "rejected" | "no-work" | "cancelled";
  findings: number;
  usageCoverage: "complete" | "partial" | "unknown";
  createdAt: string;
}

export interface AdaptationDecision {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  kind: "bootstrap" | "commit" | "reject" | "revert" | "recovery" | "keep";
  roundId: string | null;
  fromTopologyId: string | null;
  toTopologyId: string | null;
  operations: unknown[];
  reason: string;
  expectedBenefit: string;
  rejections: string[];
  evidence: { outcomes: number; confidence: "low" | "moderate" | "high" };
  trigger: string | null;
  boundaryIteration: number;
  actor: "loop-policy" | "coordinators" | "local-user";
  dissent: Array<{ memberId: string; rationale: string }>;
  createdAt: string;
}

/** Automatic internal promotion, attributed to loop policy, never to the owner. */
export interface PromotionDecision {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  iterationId: string;
  parentCheckpointId: string;
  candidateId: string;
  contentDigest: string;
  checkpointId: string;
  by: "loop-policy";
  policyRevision: number;
  controlGeneration: number;
  assessmentIds: string[];
  reviewCompletionId: string | null;
  checkEvidence: Array<{ definitionId: string; verificationId: string }>;
  protocolRevision: string;
  at: string;
}

export interface LoopWakeup {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  dueAt: string;
  reason: string;
  controlGeneration: number;
  inputsFingerprint: string;
  backoffSeconds: number;
  state: "pending" | "fired" | "cancelled";
  createdAt: string;
}

/** The durable outbox entry for the next iteration after a boundary. */
export interface LoopIntent {
  id: string;
  runId: string;
  projectId: string;
  afterIterationId: string | null;
  number: number;
  controlGeneration: number;
  state: "pending" | "consumed" | "cancelled";
  createdAt: string;
}

export interface PublicationCursor {
  id: string;
  runId: string;
  projectId: string;
  publicationBaseCandidateId: string;
  lastPublishedCheckpointId: string;
  targetRoot: string;
  targetRevision: string | null;
  /** Every path Topsl wrote, with its exact post-write content hash. */
  manifest: Array<{ path: string; hash: string | null }>;
  state: "published" | "uncertain";
  receipts: Array<{
    checkpointId: string;
    files: number;
    at: string;
    outcome: "published" | "uncertain";
  }>;
  updatedAt: string;
}

export const loopPolicySchema = z
  .object({
    allowedWork: z
      .array(z.enum(["implementation", "information"]))
      .min(1)
      .default(["implementation", "information"]),
    excludedProviders: z
      .array(z.enum(["codex", "claude"]))
      .max(2)
      .default([]),
    /** The protected run-level regression and acceptance protocol. */
    checks: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          label: z.string().min(1).max(1000),
          executable: z.string().min(1).max(4096),
          args: z.array(z.string().max(20000)).max(100),
          timeoutMs: z.number().int().min(100).max(300000),
          environmentRecipeId: z.string().max(256).optional(),
        }),
      )
      .max(20)
      .default([]),
    /**
     * A run-level grant to execute exactly these check definitions with the
     * user's OS permissions on the host. It is not a sandbox.
     */
    automaticChecks: z.boolean().default(false),
    automaticOrganization: z.boolean().default(true),
    publication: z.enum(["manual"]).default("manual"),
    iteration: z
      .object({
        maxTurns: z.number().int().min(1).max(2000).default(200),
        maxDelegatedTasks: z.number().int().min(1).max(200).default(20),
        maxRepairRounds: z.number().int().min(0).max(10).default(2),
        maxApproachesPerTarget: z.number().int().min(1).max(20).default(3),
      })
      .strict()
      .default({
        maxTurns: 200,
        maxDelegatedTasks: 20,
        maxRepairRounds: 2,
        maxApproachesPerTarget: 3,
      }),
    allowances: z
      .object({
        /** Member turns across the whole run; null: no run-level allowance. */
        runMemberTurns: z.number().int().min(1).nullable().default(null),
        rolling: z
          .object({
            memberTurns: z.number().int().min(1),
            windowHours: z
              .number()
              .min(0.01)
              .max(24 * 31),
          })
          .nullable()
          .default(null),
      })
      .strict()
      .default({ runMemberTurns: null, rolling: null }),
    adaptation: z
      .object({
        dwellIterations: z.number().int().min(0).max(100).default(3),
        explorationShare: z.number().min(0).max(1).default(0.1),
        maxRoutineOperations: z.number().int().min(1).max(20).default(2),
        windowIterations: z.number().int().min(1).max(100).default(10),
      })
      .strict()
      .default({
        dwellIterations: 3,
        explorationShare: 0.1,
        maxRoutineOperations: 2,
        windowIterations: 10,
      }),
    monitoring: z
      .object({
        initialSeconds: z.number().int().min(1).max(86400).default(300),
        maxSeconds: z
          .number()
          .int()
          .min(1)
          .max(7 * 86400)
          .default(21600),
        factor: z.number().min(1).max(10).default(2),
      })
      .strict()
      .refine((m) => m.initialSeconds <= m.maxSeconds, {
        path: ["initialSeconds"],
        message:
          "The first monitoring delay (initialSeconds) cannot be longer than the maximum delay (maxSeconds).",
      })
      .default({ initialSeconds: 300, maxSeconds: 21600, factor: 2 }),
    scheduling: z
      .object({
        /** Slots kept free for direct user work before a loop admits new work. */
        reserveForDirectWork: z.number().int().min(0).max(64).default(1),
      })
      .strict()
      .default({ reserveForDirectWork: 1 }),
    recovery: z
      .object({ resumeAfterRestart: z.boolean().default(false) })
      .strict()
      .default({ resumeAfterRestart: false }),
    /** Endless: what the user wants improved, in order. */
    priorities: z.array(z.string().min(1).max(500)).max(20).default([]),
    /** Endless: the lowest priority score that is worth an iteration. */
    opportunityThreshold: z.number().min(0).max(1).default(0.25),
  })
  .strict();
export type LoopPolicyInput = z.input<typeof loopPolicySchema>;
export type LoopPolicySettings = z.infer<typeof loopPolicySchema>;

const policyFields = loopPolicySchema.shape;
/** The policy fields grouped in an object, which a patch changes field by field. */
const policyGroups = [
  "iteration",
  "allowances",
  "adaptation",
  "monitoring",
  "scheduling",
  "recovery",
] as const;
const groupPatch = <S extends z.ZodRawShape>(
  group: z.ZodDefault<z.ZodObject<S>>,
) => z.object(optionalFields(group.unwrap().shape)).strict().optional();

/**
 * A change to some fields of a run's policy. Unlike `.partial()`, which still
 * fills defaults, an absent field here stays absent, so changing one field
 * never resets the others. Within a group such as `iteration`, the fields
 * sent replace only those fields.
 */
export const loopPolicyPatchSchema = z
  .object({
    ...optionalFields({
      allowedWork: policyFields.allowedWork,
      excludedProviders: policyFields.excludedProviders,
      checks: policyFields.checks,
      automaticChecks: policyFields.automaticChecks,
      automaticOrganization: policyFields.automaticOrganization,
      publication: policyFields.publication,
      priorities: policyFields.priorities,
      opportunityThreshold: policyFields.opportunityThreshold,
    }),
    iteration: groupPatch(policyFields.iteration),
    allowances: groupPatch(policyFields.allowances),
    adaptation: groupPatch(policyFields.adaptation),
    monitoring: groupPatch(policyFields.monitoring).refine(
      (m) =>
        m?.initialSeconds === undefined ||
        m.maxSeconds === undefined ||
        m.initialSeconds <= m.maxSeconds,
      {
        path: ["initialSeconds"],
        message:
          "The first monitoring delay (initialSeconds) cannot be longer than the maximum delay (maxSeconds).",
      },
    ),
    scheduling: groupPatch(policyFields.scheduling),
    recovery: groupPatch(policyFields.recovery),
  })
  .strict();
export type LoopPolicyPatch = z.input<typeof loopPolicyPatchSchema>;

/** The settings after a patch: absent fields keep their current values. */
export function applyLoopPolicyPatch(
  current: LoopPolicyInput,
  patch: LoopPolicyPatch,
): LoopPolicySettings {
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[field] = (policyGroups as readonly string[]).includes(field)
      ? {
          ...(current[field as keyof LoopPolicyInput] as object),
          ...Object.fromEntries(
            Object.entries(value).filter(([, v]) => v !== undefined),
          ),
        }
      : value;
  }
  return loopPolicySchema.parse(next);
}

export interface LoopPolicy extends LoopPolicySettings {
  id: string;
  runId: string;
  projectId: string;
  revision: number;
  /** The native confirmation digest that established this authority. */
  authorizedDigest: string | null;
  authorizedAt: string | null;
  updatedAt: string;
}

export interface LoopUsage {
  id: string;
  runId: string;
  projectId: string;
  memberTurns: number;
  iterations: number;
  promoted: number;
  rejected: number;
  /**
   * Rolling-window history of member turns, compacted without loss: `at` is
   * the latest turn an entry holds and `from`, when entries were merged, the
   * earliest (see compactRecent in loop-engine.ts).
   */
  recent: Array<{ at: string; turns: number; from?: string }>;
  tokens: {
    input: number | null;
    output: number | null;
    coveredAttempts: number;
    totalAttempts: number;
    complete: boolean;
    notes: string[];
  };
  updatedAt: string;
}

export interface LoopRun {
  id: string;
  projectId: string;
  conversationId: string;
  title: string;
  mode: LoopMode;
  state: LoopLifecycleState;
  desiredState: LoopDesiredState;
  stopRequestedAt: string | null;
  revision: number;
  controlGeneration: number;
  authorityGeneration: number;
  goalSetRevision: number;
  policyRevision: number;
  overrideRevision: number;
  topologyRevisionId: string | null;
  publicationBaseCheckpointId: string | null;
  publicationBaseCandidateId: string | null;
  publicationCursorId: string | null;
  acceptedCheckpointId: string | null;
  currentIterationId: string | null;
  iterationCount: number;
  cumulativeUsageId: string;
  nextWakeAt: string | null;
  waitReason: LoopWaitReason | null;
  /** Monitoring backoff while inputs stay unchanged. */
  backoffSeconds: number;
  /** An immediate cause for the next organization change, if any. */
  adaptationTrigger: string | null;
  /** Source content outside the capture policy, shown as setup conditions. */
  setupConditions: string[];
  lastAdmissionAt: string | null;
  started: boolean;
  completedAt: string | null;
  detail: string;
  lastTickAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A loop decision round: the coordination team's turn at one boundary stage. */
export interface LoopRound {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  iterationId: string | null;
  stage: LoopDecisionStage;
  protocolKind: "recursive-loop-v1";
  roleId: string;
  bindingId: string;
  function: LoopFunction;
  revision: number;
  members: RoundMember[];
  requiredContributorIds: string[];
  electorateIds: string[];
  threshold: number;
  requiredEndorserIds: string[];
  retriesPerMember: number;
  executionWidth: number | null;
  expected: LoopExpected;
  target: {
    kind: "checkpoint" | "candidate";
    id: string;
    contentDigest: string;
  };
  inputDigest: string;
  contextCandidateId: string | null;
  candidateDecisionDigest: string | null;
  state:
    "collecting" | "endorsing" | "decided" | "blocked" | "stale" | "stopped";
  decisionId: string | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoopExpected {
  runId: string;
  iterationId: string | null;
  controlGeneration: number;
  authorityGeneration: number;
  checkpointId: string;
  checkpointDigest: string;
  goalSetRevision: number;
  topologyRevisionId: string;
  policyRevision: number;
  overrideRevision: number;
}

/** The committed result of one loop decision round, with attributed dissent. */
export interface LoopDecisionRecord {
  id: string;
  runId: string;
  projectId: string;
  conversationId: string;
  iterationId: string | null;
  roundId: string;
  stage: LoopDecisionStage;
  contributionIds: string[];
  /** Per-kind decisions with the members that proposed them. */
  decisions: Array<{
    memberId: string;
    contributionId: string;
    decision: unknown;
  }>;
  team: {
    operations: unknown[];
    reason: string;
    expectedBenefit: string;
    evidenceIds: string[];
    trigger: string;
    endorsedBy: string[];
    passed: boolean;
  } | null;
  dissent: Array<{ memberId: string; rationale: string }>;
  createdAt: string;
}

export const loopDecisionStages = ["boundary", "organize", "evaluate"] as const;
export type LoopDecisionStage = (typeof loopDecisionStages)[number];

/** The protocol versions an execution turn can be bound to. */
export const protocolKinds = [
  "coordinator-v1",
  "recursive-loop-v1",
  /** A native session's intake and wording turns (docs/Native_Sessions_Plan.md). */
  "session-v1",
] as const;
export type ProtocolKind = (typeof protocolKinds)[number];
export interface TurnProtocol {
  kind: ProtocolKind;
  /** A loop decision stage, or a session-v1 stage. */
  stage: LoopDecisionStage | "intake" | "wording" | null;
  mode: LoopMode | null;
}

export type { GoalCheckDefinition };
