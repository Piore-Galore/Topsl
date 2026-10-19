import { z } from "zod";
import { projectViews } from "./navigation";
import { workflowDraftCommands } from "./workflow-drafts";
import { candidateReviewCommands } from "./candidate-reviews";
import {
  orchestrationCommands,
  requiredCheckSchema,
} from "./orchestration-commands";
import { loopCommands } from "./loop-commands";
import {
  advancedCreateSchema,
  advancedMeasurementsSchema,
} from "./advanced-inputs";
import { terminalModeIds } from "./terminal-modes";
import { codexApprovalPolicies } from "./chat-presets";
import { autoAcceptLevels } from "./auto-accept";
import { budgetPeriods } from "./allowance";
import {
  deviceIdentitySchema,
  portableContentSchema,
  transferManifestSchema,
  chunkSchema,
} from "./replication-inputs";
const id = z.string().min(1).max(256);
/** A terminal's permission mode; the provider's own settings decide unless the owner picks another. */
const permissionMode = z.enum(terminalModeIds).default("provider-default");
const roleAssignment = z.object({
  provider: z.enum(["codex", "claude"]),
  installationId: id,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(100).optional(),
  /** A Claude Code step the owner runs in Topsl's terminal, instead of a turn Topsl runs. */
  route: z.literal("terminal").optional(),
});
const requiredCheck = requiredCheckSchema;
const specialist = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  title: z.string().min(1).max(1000),
  workspaceId: id,
  provider: z.enum(["codex", "claude"]),
  installationId: id,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(100).optional(),
  permittedOutputs: z.array(z.string().min(1).max(4096)).min(1).max(10000),
  interfaceRevisionIds: z.array(id).max(100).default([]),
});
export const commandSchema = z.discriminatedUnion("type", [
  ...workflowDraftCommands,
  ...candidateReviewCommands,
  ...orchestrationCommands,
  ...loopCommands,
  z.object({ type: z.literal("environment-detect"), projectId: id }),
  z.object({
    type: z.literal("environment-selection-create"),
    requestId: id,
    projectId: id,
    label: z.string().min(1).max(1000),
    kind: z.enum(["self-contained", "locked-node"]),
    profile: z.enum(["user-approved-local", "isolated-required"]),
    nodeExecutable: z.string().min(1).max(4096),
    npmCli: z.string().min(1).max(4096).optional(),
    preparationTimeoutMs: z.number().int().min(100).max(300000),
    preparationNetwork: z
      .enum([
        "offline",
        "package-manager-network",
        "enforced-allowlist-required",
      ])
      .default("offline"),
    writablePaths: z.array(z.string().min(1).max(4096)).max(100),
    hooks: z
      .array(
        z.object({
          packagePath: z.string().min(1).max(4096),
          executable: z.string().min(1).max(4096),
          args: z.array(z.string().max(20000)).max(100),
          timeoutMs: z.number().int().min(100).max(300000),
        }),
      )
      .max(100),
    values: z.record(z.string(), z.string().max(2000)),
  }),
  z.object({
    type: z.literal("check-authorization-reuse-preview"),
    projectId: id,
    id,
    candidateId: id,
    taskId: id.optional(),
  }),
  z.object({ type: z.literal("environment-instances-query"), projectId: id }),
  z.object({
    type: z.literal("environment-instance-inspect"),
    projectId: id,
    id,
  }),
  z.object({
    type: z.literal("check-authorization-revoke"),
    requestId: id,
    projectId: id,
    id,
  }),
  z.object({ type: z.literal("round-2-features-query"), projectId: id }),
  z.object({
    type: z.literal("candidate-diff-query"),
    projectId: id,
    workflowId: id,
    candidateId: id,
    baseCandidateId: id,
    path: z.string().min(1).max(4096).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    type: z.literal("workflow-readiness-query"),
    projectId: id,
    builder: roleAssignment
      .extend({ effort: z.string().max(100).optional() })
      .optional(),
    reviewer: roleAssignment
      .extend({ effort: z.string().max(100).optional() })
      .optional(),
  }),
  z.object({
    type: z.literal("assisted-handoff-prepare"),
    projectId: id,
    workflowId: id,
    installationId: id,
    role: z.enum(["builder", "reviewer"]),
    exportApproved: z.literal(true),
  }),
  z.object({ type: z.literal("assisted-handoff-open"), projectId: id, id }),
  z.object({
    type: z.literal("assisted-handoff-import"),
    projectId: id,
    id,
    candidateRevision: id,
    specificationId: id,
    report: z.string().min(1).max(1000000),
    source: z.enum(["user-supplied", "native-import"]),
    externalWritingStopped: z.literal(true),
  }),
  z.object({
    type: z.literal("assisted-handoff-query"),
    projectId: id,
    workflowId: id,
  }),
  z.object({
    type: z.literal("workflow-finding-decide"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
    findingId: id,
    candidateId: id,
    decision: z.enum(["accepted", "rejected"]),
    rationale: z.string().trim().min(1).max(20000),
    expectedDecisionId: id.nullable(),
  }),
  z.object({ type: z.literal("check-execution-inspect"), projectId: id, id }),
  z.object({ type: z.literal("check-executions-query"), projectId: id }),
  z.object({
    type: z.literal("check-execution-reconcile"),
    requestId: id,
    projectId: id,
    id,
  }),
  z.object({
    type: z.literal("check-cleanup-retry"),
    requestId: id,
    projectId: id,
    id,
  }),
  z.object({ type: z.literal("usage-budget-query"), projectId: id }),
  z.object({
    type: z.literal("usage-budget-save"),
    projectId: id,
    tokens: z.number().int().positive().nullable(),
    wallMs: z.number().int().positive().nullable(),
  }),
  z.object({ type: z.literal("advanced-query"), projectId: id }),
  z.object({
    type: z.literal("advanced-check-preview"),
    id,
    expectedRevision: z.number().int().positive(),
    submissionId: id,
    definition: requiredCheck,
    candidateId: id.optional(),
  }),
  z.object({ type: z.literal("advanced-check-apply"), requestId: id, id }),
  z.object({
    type: z.literal("advanced-test-candidate-capture"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    workspaceId: id,
    selectedPaths: z.array(z.string().min(1).max(4096)).min(1).max(10000),
    approvedUntracked: z
      .array(z.string().min(1).max(4096))
      .max(10000)
      .default([]),
  }),
  z.object({
    type: z.literal("advanced-review-preview"),
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({ type: z.literal("advanced-review-confirm"), requestId: id, id }),
  z.object({
    type: z.literal("optional-feature-set"),
    requestId: id,
    feature: z.enum(["advanced", "multi-device"]),
    enabled: z.boolean(),
  }),
  advancedCreateSchema.extend({
    type: z.literal("advanced-create"),
    requestId: id,
  }),
  z.object({
    type: z.literal("advanced-dispatch"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    key: id,
  }),
  z.object({
    type: z.literal("advanced-freeze"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    key: id,
    artifactId: id,
  }),
  z.object({
    type: z.literal("advanced-capture"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    key: id,
    approvedUntracked: z
      .array(z.string().min(1).max(4096))
      .max(10000)
      .default([]),
  }),
  z.object({ type: z.literal("advanced-submissions"), id }),
  z.object({
    type: z.literal("advanced-evaluate"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    submissionId: id,
    measurements: advancedMeasurementsSchema,
  }),
  z.object({
    type: z.literal("advanced-select"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    submissionId: id,
  }),
  z.object({
    type: z.literal("advanced-bind-verification"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    verificationIds: z.array(id).min(1).max(20),
    frozenTestSubmissionId: id.optional(),
  }),
  z.object({
    type: z.literal("advanced-accept"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("advanced-checkpoint"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    nextDriverKey: id,
    reproductionVerificationId: id,
    experimentArtifactId: id,
  }),
  z.object({
    type: z.literal("routing-preset-save"),
    requestId: id,
    id: id.optional(),
    expectedRevision: z.number().int().positive().optional(),
    projectId: id,
    name: z.string().trim().min(1).max(200),
    assignments: z
      .array(
        roleAssignment.extend({
          role: z.enum([
            "planner",
            "implementer",
            "reviewer",
            "tester",
            "integrator",
          ]),
          /** Unique within the preset; a role may repeat with distinct members. */
          memberId: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
            .optional(),
        }),
      )
      .min(1)
      .max(320),
  }),
  z.object({
    type: z.literal("routing-measure"),
    requestId: id,
    presetId: id,
    taskId: id,
    escapedDefects: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("replication-query"), projectId: id.optional() }),
  z.object({
    type: z.literal("replication-device-preview"),
    identity: deviceIdentitySchema,
    approvedProjectIds: z.array(id).min(1).max(100),
  }),
  z.object({
    type: z.literal("replication-mapping-preview"),
    projectId: id,
    logicalWorkspaceId: id,
  }),
  z.object({ type: z.literal("replication-owner-preview"), projectId: id }),
  z.object({
    type: z.literal("replication-stage-preview"),
    recordId: id,
    projectId: id,
    content: portableContentSchema,
  }),
  z.object({
    type: z.literal("replication-export-preview"),
    targetDeviceId: id,
    recordIds: z.array(id).min(1).max(100),
  }),
  z.object({ type: z.literal("replication-plan-apply"), requestId: id, id }),
  z.object({
    type: z.literal("replication-chunk"),
    id,
    index: z.number().int().min(0).max(39),
  }),
  z.object({
    type: z.literal("replication-import-begin"),
    requestId: id,
    manifest: transferManifestSchema,
  }),
  z.object({
    type: z.literal("replication-import-chunk"),
    requestId: id,
    id,
    chunk: chunkSchema,
  }),
  z.object({
    type: z.literal("replication-import-complete"),
    requestId: id,
    id,
  }),
  z.object({ type: z.literal("replication-conflict-preview"), id }),
  z.object({
    type: z.literal("replication-conflict-resolve"),
    requestId: id,
    id,
    choice: z.enum(["local", "remote"]),
  }),
  z.object({
    type: z.literal("replication-delete"),
    requestId: id,
    recordId: id,
    projectId: id,
  }),
  z.object({
    type: z.literal("replication-device-revoke"),
    requestId: id,
    deviceId: id,
  }),
  z.object({
    type: z.literal("history-message"),
    projectId: id,
    id,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(20000).default(20000),
  }),
  z.object({
    type: z.literal("scope-snapshot"),
    projectId: id,
    conversationId: id.optional(),
  }),
  z.object({
    type: z.literal("scope-events"),
    projectId: id,
    conversationId: id.optional(),
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(500).default(200),
  }),
  z.object({
    type: z.literal("history-page"),
    projectId: id,
    conversationId: id.optional(),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(200).default(80),
    query: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("history-conversations"),
    projectId: id,
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(200).default(80),
  }),
  z.object({
    type: z.literal("navigation-save"),
    projectId: id.nullable(),
    workflowId: id.nullable(),
    projectView: z.enum(projectViews),
  }),
  z.object({ type: z.literal("navigation-query") }),
  z.object({ type: z.literal("managed-workspaces-query"), projectId: id }),
  z.object({
    type: z.literal("workspace-create-preview"),
    sourceWorkspaceId: id,
    workflowId: id,
    kind: z.enum(["worktree", "snapshot"]),
    dirtyInputPolicy: z.enum(["clean", "reviewed-snapshot"]),
    selectedPaths: z.array(z.string().min(1).max(4096)).max(10000).optional(),
    approvedUntracked: z
      .array(z.string().min(1).max(4096))
      .max(10000)
      .default([]),
  }),
  z.object({ type: z.literal("workspace-remove-preview"), id }),
  z.object({ type: z.literal("workspace-plan-apply"), requestId: id, id }),
  z.object({
    type: z.literal("parallel-create"),
    requestId: id,
    workflowId: id,
    integrationWorkspaceId: id,
    specialists: z.array(specialist).min(2).max(8),
    checks: z.array(requiredCheck).min(1).max(20),
    interfaceRevisionIds: z.array(id).max(100).default([]),
  }),
  z.object({ type: z.literal("parallel-query"), projectId: id }),
  z.object({
    type: z.literal("parallel-dispatch"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    key: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal("parallel-submit"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    key: z.string().min(1).max(64),
    approvedUntracked: z
      .array(z.string().min(1).max(4096))
      .max(10000)
      .default([]),
  }),
  z.object({
    type: z.literal("parallel-integration-preview"),
    id,
    expectedRevision: z.number().int().positive(),
    resolutions: z
      .array(z.object({ path: z.string().min(1).max(4096), candidateId: id }))
      .max(10000)
      .default([]),
  }),
  z.object({
    type: z.literal("parallel-integration-apply"),
    requestId: id,
    id,
  }),
  z.object({
    type: z.literal("parallel-checks-preview"),
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({ type: z.literal("parallel-check-apply"), requestId: id, id }),
  z.object({
    type: z.literal("parallel-accept"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("parallel-cancel"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("sync-field-push"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({ type: z.literal("synchronization-query"), projectId: id }),
  z.object({
    type: z.literal("sync-field-intent"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
    local: z.union([
      z.string().max(10000),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(z.string().max(4096)).max(2000),
    ]),
    authority: z.enum(["topsl", "follow-native"]),
  }),
  z.object({
    type: z.literal("sync-field-resolve"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
    direction: z.enum(["follow-native", "keep-topsl"]),
  }),
  z.object({
    type: z.literal("native-link-state"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
    state: z.enum(["linked", "unlinked"]),
  }),
  z.object({
    type: z.literal("native-root-map"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
    nativeRoot: z.string().min(1).max(4096),
    workspaceId: id,
  }),
  z.object({
    type: z.literal("shared-revision-publish"),
    requestId: id,
    projectId: id,
    recordId: id,
    kind: z.enum(["specification", "decision", "interface"]),
    title: z.string().min(1).max(1000),
    content: z.string().min(1).max(1000000),
    impact: z.enum(["dispatch-blocking", "advisory"]),
    expectedHeadId: id.nullable(),
  }),
  z.object({ type: z.literal("task-inputs-inspect"), projectId: id, id }),
  z.object({
    type: z.literal("task-context-bind"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
    contextPackageId: id,
    references: z
      .array(z.object({ recordId: id, revisionId: id }))
      .max(1000)
      .optional(),
  }),
  z.object({
    type: z.literal("builder-reviewer-specification-publish"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    objective: z.string().min(1).max(100000),
    acceptanceCriteria: z.array(z.string().min(1).max(10000)).min(1).max(100),
    interfaces: z.array(z.string().min(1).max(10000)).max(100).default([]),
  }),
  z.object({
    type: z.literal("builder-reviewer-specification-restart"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    specificationId: id,
  }),
  z.object({
    type: z.literal("native-history-approve"),
    requestId: id,
    projectId: id,
    provider: z.enum(["codex", "claude"]),
    profileId: id,
    sessionId: id,
  }),
  z.object({
    type: z.literal("native-history-reconcile"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("native-history-pause"),
    requestId: id,
    projectId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({ type: z.literal("builder-reviewer-query"), projectId: id }),
  z.object({ type: z.literal("builder-reviewer-inspect"), id }),
  z.object({
    type: z.literal("builder-reviewer-create"),
    requestId: id,
    projectId: id,
    objective: z.string().min(1).max(100000),
    acceptanceCriteria: z.array(z.string().min(1).max(10000)).min(1).max(100),
    interfaces: z.array(z.string().min(1).max(10000)).max(100).default([]),
    builder: roleAssignment,
    reviewer: roleAssignment,
    selectedPaths: z.array(z.string().min(1).max(4096)).max(10000).optional(),
    approvedUntracked: z
      .array(z.string().min(1).max(4096))
      .max(10000)
      .default([]),
    checks: z.array(requiredCheck).min(1).max(20),
    maxRepairs: z.number().int().min(0).max(2).default(2),
    requireIndependence: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("builder-reviewer-advance"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("builder-reviewer-checks-preview"),
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("builder-reviewer-check-apply"),
    requestId: id,
    id,
  }),
  z.object({
    type: z.literal("builder-reviewer-accept"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("builder-reviewer-cancel"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    /** Required while a Claude Code build or repair step the owner opened holds the folder. */
    claudeCodeStopped: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("claude-step-open"),
    projectId: id,
    workflowId: id,
    stepId: id,
    /** A build or repair's mode; a review always opens in Plan. */
    permissionMode: z.enum(terminalModeIds).optional(),
  }),
  z.object({
    type: z.literal("claude-step-return"),
    projectId: id,
    workflowId: id,
    stepId: id,
    /** Claude's final reply as the owner pasted it, or none when Topsl reads it from the session's transcript. */
    reply: z.string().min(1).max(1000000).optional(),
    source: z.enum(["owner-paste", "claude-transcript"]),
    claudeCodeStopped: z.literal(true),
  }),
  z.object({ type: z.literal("coordination-query"), projectId: id }),
  z.object({
    type: z.literal("coordination-page"),
    projectId: id,
    kind: z.enum([
      "workspace",
      "workflow",
      "task",
      "agent-session",
      "attempt",
      "artifact",
      "verification",
    ]),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  z.object({ type: z.literal("task-inspect"), projectId: id, id }),
  z.object({
    type: z.literal("workflow-create"),
    requestId: id,
    projectId: id,
    objective: z.string().min(1).max(100000),
    template: z.string().min(1).max(200),
    templateVersion: id,
  }),
  z.object({
    type: z.literal("task-create"),
    requestId: id,
    projectId: id,
    workspaceId: id,
    workflowId: id.nullable().default(null),
    conversationId: id.nullable().default(null),
    title: z.string().min(1).max(1000),
    role: z.enum([
      "implementer",
      "reviewer",
      "tester",
      "integrator",
      "planner",
    ]),
    acceptanceCriteria: z
      .array(z.string().min(1).max(10000))
      .max(100)
      .default([]),
  }),
  z.object({
    type: z.literal("task-transition"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    state: z.enum(["ready", "blocked", "cancelled"]),
    detail: z.string().max(10000).default(""),
  }),
  z.object({
    type: z.literal("task-run"),
    requestId: id,
    id,
    expectedRevision: z.number().int().positive(),
    installationId: id,
    prompt: z.string().min(1).max(100000),
    model: z.string().min(1).max(200),
    mode: z.enum(["review", "edit"]),
    contextPackageId: id.nullable().default(null),
    freshSession: z.boolean().default(true),
  }),
  z.object({ type: z.literal("state") }),
  z.object({
    type: z.literal("unlock"),
    passphrase: z.string().min(12).max(1024),
  }),
  z.object({
    type: z.literal("theme"),
    theme: z.enum(["paper", "night", "system"]),
  }),
  z.object({
    type: z.literal("auto-accept-set"),
    level: z.enum(autoAcceptLevels),
  }),
  z.object({
    type: z.literal("claude-transcript-read-set"),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("claude-structured-route-set"),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal("discover") }),
  z.object({ type: z.literal("trust-installation"), id }),
  z.object({ type: z.literal("select-runtime") }),
  z.object({ type: z.literal("check-updates"), id }),
  z.object({
    type: z.literal("lifecycle-preview"),
    appId: id,
    installationId: id.nullable(),
    action: z.enum(["download", "install", "update"]),
  }),
  z.object({ type: z.literal("lifecycle-apply"), id }),
  z.object({ type: z.literal("lifecycle-cancel"), id }),
  z.object({ type: z.literal("lifecycle-reconcile"), id }),
  z.object({ type: z.literal("lifecycle-retry-preview"), id }),
  z.object({ type: z.literal("open-application"), id }),
  z.object({
    type: z.literal("open-docs"),
    appId: id,
    kind: z.enum(["website", "docs", "releaseNotes"]),
  }),
  z.object({ type: z.literal("show-download"), id }),
  z.object({ type: z.literal("project-add") }),
  z.object({ type: z.literal("project-sync-enable"), enabled: z.boolean() }),
  z.object({ type: z.literal("project-sync-refresh") }),
  z.object({
    type: z.literal("codex-project-sync-enable"),
    installationId: id,
  }),
  z.object({ type: z.literal("codex-project-sync-pause") }),
  z.object({ type: z.literal("codex-project-sync-refresh") }),
  z.object({
    type: z.literal("codex-project-rename"),
    id,
    expectedRevision: id,
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/),
  }),
  z.object({
    type: z.literal("codex-project-move"),
    id,
    beforeProjectId: id.nullable(),
    expectedOrderRevision: id,
  }),
  z.object({ type: z.literal("project-trust"), id }),
  z.object({ type: z.literal("project-relink"), id }),
  z.object({
    type: z.literal("project-open"),
    projectId: id,
    installationId: id,
    permissionMode,
  }),
  z.object({ type: z.literal("project-copy-path"), id }),
  z.object({
    type: z.literal("conversation-add"),
    projectId: id,
    title: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("history-search"),
    projectId: id,
    query: z.string().max(500),
  }),
  z.object({
    type: z.literal("history-import"),
    projectId: id,
    provider: z.enum(["codex", "claude"]),
  }),
  z.object({ type: z.literal("history-delete"), id }),
  z.object({ type: z.literal("runtime-connect"), id }),
  z.object({ type: z.literal("runtime-login"), id }),
  z.object({ type: z.literal("runtime-models"), id }),
  z.object({ type: z.literal("runtime-account"), id }),
  /** Reads the account's subscription allowance from the runtime. */
  z.object({
    type: z.literal("provider-allowance-refresh"),
    id,
    projectId: id.optional(),
  }),
  /** The owner's own token budget for a provider; null tokens removes it. */
  z.object({
    type: z.literal("provider-budget-save"),
    provider: z.enum(["codex", "claude"]),
    tokens: z.number().int().positive().max(1e12).nullable(),
    period: z.enum(budgetPeriods),
  }),
  z.object({
    type: z.literal("runtime-qualify"),
    id,
    model: z.string().min(1).max(200),
    effort: z.string().min(1).max(100).optional(),
  }),
  z.object({ type: z.literal("runtime-qualification-query"), id }),
  z.object({
    type: z.literal("run-start"),
    conversationId: id,
    installationId: id,
    prompt: z.string().min(1).max(100000),
    model: z.string().min(1).max(200),
    mode: z.enum(["review", "edit", "native"]),
    /** With the mode, picks one of the Codex chat presets. */
    approvalPolicy: z.enum(codexApprovalPolicies).default("untrusted"),
    snapshotId: id.nullable(),
  }),
  z.object({ type: z.literal("run-interrupt"), id }),
  z.object({ type: z.literal("run-reconcile"), id }),
  z.object({ type: z.literal("approval-decide"), id, allow: z.boolean() }),
  z.object({
    type: z.literal("handoff-preview"),
    conversationId: id,
    provider: z.enum(["codex", "claude"]),
    objective: z.string().min(1).max(10000),
  }),
  z.object({ type: z.literal("handoff-export"), id }),
  z.object({
    type: z.literal("terminal-open"),
    projectId: id,
    installationId: id,
    login: z.boolean().default(false),
    permissionMode,
  }),
  z.object({
    type: z.literal("terminal-input"),
    id,
    data: z.string().max(65536),
  }),
  z.object({
    type: z.literal("terminal-resize"),
    id,
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({ type: z.literal("terminal-close"), id }),
  z.object({
    type: z.literal("configuration-read"),
    provider: z.enum(["codex", "claude"]),
    projectId: id.nullable(),
    kind: z.enum(["native", "instructions"]),
  }),
  z.object({
    type: z.literal("configuration-preview"),
    path: z.string().max(4096),
    expectedHash: id,
    text: z.string().max(1000000),
  }),
  z.object({ type: z.literal("configuration-apply"), id }),
  z.object({ type: z.literal("context-enable"), projectId: id }),
]);
export type Command = z.infer<typeof commandSchema>;
