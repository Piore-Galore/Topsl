import { z } from "zod";
import type { Evidence } from "./workflow";

/**
 * Role groups for the coordinator feature (docs/Coordinator_Teams.md). A role
 * group holds one or more members, keyed by stable member IDs. Nothing here,
 * in the schemas, the service or the screens, limits a group to two members:
 * the only ceiling is the configurable `maxMembersPerRole` policy.
 */

/** The ceiling a project policy may set on one role's members. */
export const MEMBER_LIMIT_CEILING = 64;
/** The application default for one role's members, which a policy can raise. */
export const DEFAULT_MEMBER_LIMIT = 8;

/** What an execution is for. It is separate from its filesystem permission. */
export const executionPurposes = [
  "coordinator-contribution",
  "coordinator-endorsement",
  "information",
  "implementation",
  "candidate-review",
  "direct-chat",
] as const;
export type ExecutionPurpose = (typeof executionPurposes)[number];

export const builtInRoles = [
  "coordinator",
  "planner",
  "implementer",
  "reviewer",
  "tester",
  "integrator",
  "researcher",
  "documentation",
] as const;
export type BuiltInRole = (typeof builtInRoles)[number];
export const roleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export const selectionForms = ["auto", "exact", "required-plus-auto"] as const;
export type SelectionForm = (typeof selectionForms)[number];

export const collaborationModes = [
  "solo",
  "parallel-independent",
  "parallel-partitioned",
  "peer-collaboration",
  "sequential",
] as const;
export type CollaborationMode = (typeof collaborationModes)[number];

/** How a group's members are admitted. `capacity-waves` is the default. */
export const schedulingKinds = [
  "capacity-waves",
  "all-simultaneous",
  "sequential",
] as const;
export type SchedulingKind = (typeof schedulingKinds)[number];

const id = z.string().min(1).max(256);
const provider = z.enum(["codex", "claude"]);

/** A member's model pin. Labels are for people; execution needs `model`. */
export const memberPinSchema = z
  .object({
    /** The person's label, such as "Opus", kept even before it resolves. */
    label: z.string().min(1).max(200).optional(),
    provider: provider.optional(),
    installationId: id.optional(),
    /** The provider's actual model identifier. */
    model: z.string().min(1).max(200).optional(),
    effort: z.string().min(1).max(100).optional(),
    /** assisted: an owner-run Claude Code step. It cannot satisfy a strict exact-model pin. */
    route: z.enum(["managed", "assisted"]).optional(),
  })
  .strict();
export type MemberPin = z.infer<typeof memberPinSchema>;

export const memberSourceSchema = z
  .object({
    kind: z.enum(["ui", "message", "preset", "legacy-migration", "auto"]),
    /** A message ID, command ID or migrated record ID. */
    reference: z.string().max(256).nullable(),
    /** legacy-unknown: an old record without enough provenance to call it a pin. */
    provenance: z.enum(["explicit", "legacy-unknown", "default"]),
  })
  .strict();

export const memberIntentSchema = z
  .object({
    memberId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    required: z.boolean().default(true),
    /** null: an Auto slot. */
    pin: memberPinSchema.nullable().default(null),
    /** Explicitly authorized fallbacks for this pin, tried in order. */
    fallbacks: z.array(memberPinSchema).max(8).default([]),
    preferences: z
      .object({
        providers: z.array(provider).max(4).default([]),
        models: z.array(z.string().min(1).max(200)).max(16).default([]),
      })
      .strict()
      .default({ providers: [], models: [] }),
    source: memberSourceSchema.default({
      kind: "ui",
      reference: null,
      provenance: "explicit",
    }),
  })
  .strict();
export type MemberIntent = z.infer<typeof memberIntentSchema>;

export const decisionThresholdSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({ kind: z.literal("count"), count: z.number().int().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("fraction"),
      numerator: z.number().int().min(1),
      denominator: z.number().int().min(1),
    })
    .strict(),
]);
export type DecisionThreshold = z.infer<typeof decisionThresholdSchema>;

export const completionPolicySchema = z
  .object({
    /** null: every required member must contribute. */
    requiredContributorIds: z.array(id).nullable().default(null),
    minimumValidContributions: z.number().int().min(0).default(0),
    /** null: every required member is in the electorate. */
    electorateIds: z.array(id).nullable().default(null),
    threshold: decisionThresholdSchema.default({ kind: "all" }),
    requiredEndorserIds: z.array(id).default([]),
    retriesPerMember: z.number().int().min(0).max(5).default(1),
    reconciliationTurns: z.number().int().min(0).max(5).default(1),
    /** replace-unpinned: Auto may replace an unavailable unpinned slot. */
    degradation: z.enum(["none", "replace-unpinned"]).default("none"),
    /** Seconds to wait for optional members before they count as missing. */
    optionalDeadlineSeconds: z.number().int().min(0).max(86400).default(0),
  })
  .strict();
export type CompletionPolicy = z.infer<typeof completionPolicySchema>;

/** Settings a scope can set for a role. An absent field defers to a broader scope. */
export const roleGroupSettingsSchema = z
  .object({
    form: z.enum(selectionForms).optional(),
    /** Exact count for Auto or required-plus-auto. Exact rosters derive theirs. */
    count: z.number().int().min(1).optional(),
    minCount: z.number().int().min(1).optional(),
    maxCount: z.number().int().min(1).optional(),
    members: z.array(memberIntentSchema).optional(),
    distinctModels: z.enum(["required", "preferred", "none"]).optional(),
    distinctProviders: z.enum(["required", "preferred", "none"]).optional(),
    collaboration: z.enum(collaborationModes).optional(),
    scheduling: z.enum(schedulingKinds).optional(),
    /** W: the most members active at once. null: capacity decides. */
    executionWidth: z.number().int().min(1).nullable().optional(),
    completion: completionPolicySchema.partial().optional(),
    /** requested-only: a clearly labelled mode that accepts unreported effective models. */
    modelEvidence: z.enum(["verified", "requested-only"]).optional(),
  })
  .strict();
export type RoleGroupSettings = z.infer<typeof roleGroupSettingsSchema>;

export const groupScopeLevels = ["project-role", "goal-role", "task"] as const;
export type GroupScopeLevel = (typeof groupScopeLevels)[number];

export interface GroupScope {
  level: GroupScopeLevel;
  projectId: string;
  goalId: string | null;
  /** The plan task key, for a task override. */
  taskKey: string | null;
}

/** One revision of one role's settings at one scope. Immutable once written. */
export interface RoleGroupRevision {
  id: string;
  groupId: string;
  revision: number;
  projectId: string;
  goalId: string | null;
  scope: GroupScope;
  roleId: string;
  settings: RoleGroupSettings;
  source: { actor: string; commandId: string; messageId: string | null };
  supersedes: number | null;
  createdAt: string;
}

/** The fully resolved settings for a role at a scope, with where each came from. */
export interface EffectiveRoleGroup {
  projectId: string;
  goalId: string | null;
  roleId: string;
  form: SelectionForm;
  count: number | null;
  minCount: number;
  maxCount: number;
  members: MemberIntent[];
  distinctModels: "required" | "preferred" | "none";
  distinctProviders: "required" | "preferred" | "none";
  collaboration: CollaborationMode;
  scheduling: SchedulingKind;
  executionWidth: number | null;
  completion: CompletionPolicy;
  modelEvidence: "verified" | "requested-only";
  memberLimit: number;
  /** Group revision IDs that contributed, most specific first. */
  sources: Array<{
    level: string;
    revisionId: string | null;
    fields: string[];
  }>;
  /** Problems that keep this group from executing as configured. */
  conflicts: string[];
}

export interface RoleDefinition {
  id: string;
  projectId: string | null;
  revision: number;
  title: string;
  instructions: string;
  purpose: ExecutionPurpose;
  requiredCapabilities: string[];
  permittedOperations: string[];
  outputContract:
    | "coordinator-proposal"
    | "candidate-review"
    | "information"
    | "code-candidate";
  defaultCollaboration: CollaborationMode;
}

export interface ResolvedMemberAssignment {
  id: string;
  projectId: string;
  goalId: string | null;
  roleId: string;
  memberId: string;
  /** Increases for every substitution or re-resolution of this member. */
  revision: number;
  groupRevisionIds: string[];
  status: "resolved" | "unresolved" | "unavailable" | "assisted";
  selection: "pinned" | "auto" | "fallback";
  /** The primary pin this fallback stands in for, kept as intent. */
  primaryPin: MemberPin | null;
  provider: "codex" | "claude" | null;
  route: "managed-structured" | "assisted-terminal" | null;
  installationId: string | null;
  installationRevision: string | null;
  executableIdentity: string | null;
  /** The native sign-in, never an agent instruction profile. */
  nativeAccountKey: string | null;
  nativeProfileId: string | null;
  billingRoute: "native-subscription" | "api-key" | "cloud-provider" | null;
  model: string | null;
  modelLabel: string | null;
  effort: string | null;
  roleDefinitionRevision: number;
  catalog: { observedAt: string | null; fresh: boolean } | null;
  fanout: "disabled" | "bounded" | "unknown";
  modelEvidencePolicy: "verified" | "requested-only";
  reason: string;
  createdAt: string;
}

export type MemberRoundState =
  | "queued"
  | "running"
  | "returned"
  | "invalid"
  | "failed"
  | "missing"
  | "stale"
  | "stopped";

export interface RoundMember {
  memberId: string;
  assignmentId: string;
  assignmentRevision: number;
  provider: "codex" | "claude";
  model: string;
  installationId: string;
  required: boolean;
  state: MemberRoundState;
  phase: "initial" | "reconciliation" | "endorsement";
  attemptIds: string[];
  activeAttemptId: string | null;
  /** Recorded before a launch, so a restart adopts the attempt instead of starting another. */
  launchId: string | null;
  contributionIds: string[];
  retries: number;
  wave: number;
  detail: string;
}

export type RoundKind = "coordination" | "review" | "work" | "information";

export interface RoleRound {
  id: string;
  projectId: string;
  goalId: string;
  roleId: string;
  kind: RoundKind;
  /** The plan task this work round serves, if any. */
  taskKey: string | null;
  revision: number;
  stage:
    | "collecting"
    | "reconciling"
    | "endorsing"
    | "awaiting-user"
    | "committed"
    | "completed"
    | "blocked"
    | "stopped"
    | "stale";
  input: RoundInput;
  members: RoundMember[];
  requiredContributorIds: string[];
  minimumValidContributions: number;
  electorateIds: string[];
  /** Endorsements needed, from the frozen electorate. */
  threshold: number;
  requiredEndorserIds: string[];
  policyDigest: string;
  /** The effective role settings this round froze; a change starts a new round. */
  groupDigest: string;
  collaboration: CollaborationMode;
  scheduling: SchedulingKind;
  executionWidth: number | null;
  retriesPerMember: number;
  reconciliationTurns: number;
  reconciliationTurnsUsed: number;
  candidateId: string | null;
  completionId: string | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoundInput {
  goalRevision: number;
  planRevision: number;
  controlGeneration: number;
  specificationRevision: string | null;
  eventCursor: number;
  candidateId: string | null;
  candidateRevision: string | null;
  /** For a work round: the plan task brief and its partition per member. */
  brief: string | null;
  partitions: Record<string, { title: string; permittedOutputs: string[] }>;
  /** Each role's resolved roster size and collaboration, as the coordinators saw them. */
  rosters: Record<
    string,
    { members: number; collaboration: CollaborationMode }
  >;
  artifactRefs: string[];
  allowedOperations: string[];
  digest: string;
}

export interface ParticipantContribution {
  id: string;
  projectId: string;
  goalId: string;
  roundId: string;
  memberId: string;
  assignmentId: string;
  assignmentRevision: number;
  attemptId: string;
  phase: "initial" | "reconciliation" | "endorsement";
  output: unknown;
  validation: {
    state: "valid" | "invalid" | "inconclusive" | "failed" | "stale";
    reason: string;
  };
  inputDigest: string;
  reportedModel: string | null;
  provenance: Evidence;
  createdAt: string;
}

export interface PlanTaskAction {
  key: string;
  title: string;
  kind: "implementation" | "information" | "review" | "check";
  roleId: string;
  dependencies: string[];
  permittedOutputs: string[];
  acceptanceCriteria: string[];
  brief: string;
  /** One per member of a partitioned group, in member order. */
  partitions: Array<{ title: string; permittedOutputs: string[] }>;
}

export interface DecisionCandidate {
  id: string;
  projectId: string;
  goalId: string;
  roundId: string;
  revision: number;
  digest: string;
  actions: PlanTaskAction[];
  summary: string;
  assumptions: string[];
  contributionIds: string[];
  source: "matching-proposals" | "combined" | "reconciled" | "user-direction";
  expected: {
    goalRevision: number;
    planRevision: number;
    controlGeneration: number;
  };
  createdAt: string;
}

export interface DecisionEndorsement {
  id: string;
  projectId: string;
  roundId: string;
  candidateId: string;
  candidateDigest: string;
  memberId: string;
  assignmentId: string;
  contributionId: string;
  stance: "endorse" | "challenge" | "abstain";
  rationale: string;
  implied: boolean;
  createdAt: string;
}

export interface FindingObservation {
  contributionId: string;
  memberId: string;
  title: string;
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  behavior: string;
  evidence: string;
}

export interface AggregatedFinding {
  id: string;
  key: string;
  title: string;
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  observations: FindingObservation[];
  /** Members whose valid report did not mention it. Omission is not resolution. */
  silentMemberIds: string[];
  disposition:
    | "open"
    | "substantiated"
    | "duplicate"
    | "unsupported"
    | "resolved-by-check"
    | "waived";
  dispositionRationale: string | null;
  decidedBy: string | null;
}

export interface RoleCompletion {
  id: string;
  projectId: string;
  goalId: string;
  roundId: string;
  kind: RoundKind;
  result: "satisfied" | "incomplete" | "blocked";
  includedContributionIds: string[];
  excluded: Array<{
    memberId: string;
    contributionId: string | null;
    reason: string;
  }>;
  findings: AggregatedFinding[];
  policy: {
    requiredReturned: number;
    requiredTotal: number;
    endorsements: number | null;
    threshold: number | null;
    detail: string;
  };
  assignmentMap: Record<
    string,
    { assignmentId: string; assignmentRevision: number }
  >;
  inputDigest: string;
  candidateId: string | null;
  createdAt: string;
}

export interface GoalGrant {
  taskKinds: Array<"implementation" | "information" | "review" | "check">;
  maxTurns: number;
  maxDelegatedTasks: number;
  maxRepairRounds: number;
  maxReconciliationTurns: number;
  expiresAt: string | null;
}

export type GoalState =
  | "planning"
  | "running"
  | "reviewing"
  | "paused"
  | "stopped"
  | "blocked"
  /** The review group is satisfied; required checks still need current passing evidence. */
  | "checking"
  | "awaiting-acceptance"
  | "completed"
  | "accepted";

/**
 * A required check for a code goal. The same shape as the check machinery's
 * `CheckDefinition` (packages/workflows/verification.ts), which runs it.
 */
export interface GoalCheckDefinition {
  id: string;
  label: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  environmentRecipeId?: string;
  executionPolicy?: {
    maximumUses: number;
    allowCandidateChanges?: boolean;
    expiresAfterMs?: number;
  };
}

/** A file two or more members changed differently, with each member's version. */
export interface IntegrationConflict {
  path: string;
  options: Array<{ candidateId: string; memberId: string; taskKey: string }>;
}

/** The owner's choice of one member's version for one conflicting path. */
export interface ConflictResolution {
  path: string;
  candidateId: string;
  by: string;
  at: string;
}

/** The recorded outcome of applying an accepted candidate to the project folder. */
export interface GoalApplication {
  state: "applying" | "applied" | "refused" | "uncertain";
  candidateId: string;
  digest: string;
  root: string;
  files: Array<{ path: string; change: "added" | "modified" | "deleted" }>;
  detail: string;
  by: string;
  at: string;
}

export interface Goal {
  id: string;
  projectId: string;
  conversationId: string;
  revision: number;
  objective: string;
  constraints: string[];
  kind: "code" | "information";
  state: GoalState;
  /** Advances on every pause, stop, resume, steering or membership change. */
  controlGeneration: number;
  grant: GoalGrant;
  usage: { turns: number; delegatedTasks: number; repairRounds: number };
  planId: string | null;
  planRevision: number;
  /** The frozen project snapshot implementation members start from. */
  baselineCandidateId: string | null;
  /** The state to return to after a pause. */
  pausedFrom: GoalState | null;
  parentGoalId: string | null;
  relatedGoalIds: string[];
  candidateId: string | null;
  reviewCompletionId: string | null;
  acceptance: {
    by: string;
    at: string;
    digest: string;
    candidateId: string;
  } | null;
  synthesis: string | null;
  /**
   * Required checks every integrated candidate must pass before acceptance.
   * Absent on goals recorded before coordinator checks existed (no checks).
   */
  checks?: GoalCheckDefinition[];
  /** The tester task that holds check evidence for `checkCandidateId`. */
  checkTaskId?: string | null;
  checkCandidateId?: string | null;
  /** Conflicts from the latest integration attempt, until resolved. */
  conflicts?: IntegrationConflict[];
  /** Per-path choices applied on the next integration of the same candidates. */
  resolutions?: ConflictResolution[];
  application?: GoalApplication | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorConversation {
  id: string;
  projectId: string;
  title: string;
  goalIds: string[];
  intakeCursor: number;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorMessage {
  id: string;
  projectId: string;
  conversationId: string;
  sequence: number;
  role: "user" | "coordinator" | "service";
  text: string;
  routing: {
    kind:
      | "status"
      | "update-goal"
      | "new-goal"
      | "related-goal"
      | "control"
      | "membership";
    goalId: string | null;
  } | null;
  createdAt: string;
}

export interface CoordinatorPlan {
  id: string;
  projectId: string;
  goalId: string;
  revision: number;
  tasks: PlanTaskAction[];
  decisionCandidateId: string | null;
  roundId: string | null;
  supersedesPlanId: string | null;
  createdAt: string;
}

export interface QueuedPlanAction {
  /** The idempotency key: plan ID and task key. */
  id: string;
  projectId: string;
  goalId: string;
  planId: string;
  taskKey: string;
  revision: number;
  state: "queued" | "admitted" | "completed" | "blocked" | "cancelled";
  expectedControlGeneration: number;
  roundId: string | null;
  /** Existing runtime records this action's executions link to. */
  attemptIds: string[];
  candidateIds: string[];
  artifactIds: string[];
  detail: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlEvent {
  id: string;
  projectId: string;
  goalId: string | null;
  scope: "project" | "goal" | "group" | "member";
  action: "pause" | "stop" | "resume" | "steer" | "stop-member" | "membership";
  targetId: string | null;
  generation: number;
  actor: string;
  commandId: string;
  detail: string;
  createdAt: string;
}

export interface CommandReceipt {
  id: string;
  projectId: string;
  type: string;
  accepted: boolean;
  result: unknown;
  error: string | null;
  at: string;
}

export interface OrchestrationPolicy {
  id: string;
  projectId: string;
  revision: number;
  maxMembersPerRole: number;
  /** Goal-wide defaults, which role settings override field by field. */
  defaults: RoleGroupSettings;
  updatedAt: string;
}
