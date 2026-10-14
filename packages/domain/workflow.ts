import { z } from "zod";

const id = z.string().min(1).max(4096);
const timestamp = z.string().datetime();
const revision = z.number().int().positive();
const provider = z.enum(["codex", "claude"]);
export const evidenceSchema = z.object({
  level: z.enum([
    "topsl-transaction",
    "provider-ack",
    "provider-readback",
    "source-observation",
    "user-confirmation",
    "none",
  ]),
  source: z.string(),
  observedAt: timestamp.nullable(),
  detail: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
const record = {
  id,
  projectId: id,
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
};
export const workspaceSchema = z.object({
  ...record,
  hostId: id,
  root: id,
  canonicalRoot: id,
  filesystemIdentity: id.nullable(),
  checkoutType: z.enum([
    "directory",
    "checkout",
    "worktree",
    "snapshot",
    "unknown",
  ]),
  branch: z.string().nullable(),
  trustRevision: id.nullable(),
  availability: z.enum(["available", "missing", "changed", "unverified"]),
  provenance: z.enum(["approved", "legacy-mapping"]),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export const workflowStateSchema = z.enum([
  "draft",
  "ready",
  "running",
  "blocked",
  "awaiting-acceptance",
  "accepted",
  "failed",
  "cancelled",
]);
export const taskStateSchema = z.enum([
  "draft",
  "ready",
  "blocked",
  "active",
  "submitted",
  "reviewing",
  "verifying",
  "changes-requested",
  "accepted",
  "cancelled",
]);
export const attemptStateSchema = z.enum([
  "prepared",
  "starting",
  "running",
  "awaiting-approval",
  "completed",
  "failed",
  "interrupted",
  "uncertain",
]);
export const workflowSchema = z.object({
  ...record,
  objective: z.string().min(1),
  template: z.string(),
  templateVersion: id,
  specificationRevision: id.nullable(),
  taskIds: z.array(id),
  state: workflowStateSchema,
  budget: z.object({
    concurrency: z.number().int().min(1).max(16),
    repairRounds: z.number().int().min(0).max(10),
  }),
  acceptance: z
    .object({ by: z.string(), at: timestamp, digest: id, targetRevision: id })
    .nullable(),
});
export type Workflow = z.infer<typeof workflowSchema>;
export const taskSchema = z.object({
  ...record,
  workflowId: id.nullable(),
  conversationId: id.nullable(),
  title: z.string().min(1),
  role: z.enum([
    "implementer",
    "reviewer",
    "tester",
    "integrator",
    "planner",
    "native",
    "historical",
  ]),
  workspaceId: id,
  dependencies: z.array(id),
  inputRefs: z.array(id),
  permittedOutputs: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  requiredCapabilities: z.array(z.string()),
  state: taskStateSchema,
  attemptIds: z.array(id),
  candidateId: id.nullable(),
  detail: z.string(),
});
export type Task = z.infer<typeof taskSchema>;
export const agentSessionSchema = z.object({
  ...record,
  conversationId: id.nullable(),
  provider,
  nativeSessionId: id.nullable(),
  profileId: id.nullable(),
  accountKey: id.nullable(),
  runtimeRevision: id.nullable(),
  executableIdentity: id.nullable(),
  workspaceId: id,
  role: taskSchema.shape.role,
  parentSessionId: id.nullable(),
  forkOfSessionId: id.nullable(),
  observability: z.enum([
    "coordinated",
    "observed-external",
    "native-handoff",
    "uncertain",
  ]),
  resumable: z.boolean(),
  continuity: z.enum(["verified", "unknown", "fresh"]),
  evidence: evidenceSchema,
});
export type AgentSession = z.infer<typeof agentSessionSchema>;
export const inputManifestSchema = z.object({
  workspaceIdentity: id.nullable(),
  baseRevision: id.nullable(),
  contentManifestId: id.nullable(),
  dirtyInputPolicy: z.enum(["clean", "reviewed-snapshot", "unknown"]),
  instructionHashes: z.array(
    z.object({
      path: id,
      hash: id,
      delivery: z.enum([
        "present",
        "injected",
        "acknowledged",
        "confirmed",
        "unknown",
      ]),
    }),
  ),
});
export type InputManifest = z.infer<typeof inputManifestSchema>;
export const executionAttemptSchema = z.object({
  ...record,
  taskId: id,
  sessionId: id,
  workspaceId: id,
  conversationId: id.nullable(),
  legacyRunId: id.nullable(),
  provider,
  requestedModel: z.string().nullable(),
  reportedModel: z.string().nullable(),
  modelEvidence: evidenceSchema,
  contextPackageId: id.nullable(),
  specificationRevision: id.nullable(),
  inputManifest: inputManifestSchema,
  state: attemptStateSchema,
  dispatchId: id,
  operationIntentId: id.nullable(),
  retryOfAttemptId: id.nullable(),
  leaseGeneration: z.number().int().positive().nullable(),
  error: z.string().nullable(),
  usageEvidence: evidenceSchema,
  finishedAt: timestamp.nullable(),
});
export type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;
export const artifactSchema = z.object({
  ...record,
  taskId: id.nullable(),
  attemptId: id.nullable(),
  conversationId: id.nullable(),
  kind: z.enum([
    "candidate",
    "patch",
    "snapshot",
    "specification",
    "review",
    "report",
    "legacy-context",
  ]),
  contentHash: id,
  targetRevision: id.nullable(),
  protectedContentRef: id,
  confidentiality: z.enum(["project", "restricted"]),
  provenance: evidenceSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;
export const verificationSchema = z.object({
  ...record,
  taskId: id,
  candidateId: id,
  targetRevision: id,
  definition: z.string().min(1),
  environment: z.string(),
  result: z.enum([
    "pending",
    "passed",
    "failed",
    "error",
    "skipped",
    "unavailable",
  ]),
  evidenceArtifactId: id.nullable(),
  evidence: evidenceSchema,
  invalidatedAt: timestamp.nullable(),
});
export type Verification = z.infer<typeof verificationSchema>;
export const operationIntentSchema = z.object({
  ...record,
  attemptId: id,
  kind: z.enum(["turn", "native-terminal", "interrupt", "provider-operation"]),
  digest: id,
  expectedRevision: id.nullable(),
  state: z.enum([
    "prepared",
    "dispatch-recorded",
    "acknowledged",
    "verified",
    "unknown",
    "failed",
  ]),
  providerReference: id.nullable(),
  evidence: evidenceSchema,
});
export type OperationIntent = z.infer<typeof operationIntentSchema>;
export interface WorkspaceLease {
  id: string;
  workspaceId: string;
  projectId: string;
  filesystemIdentity: string;
  attemptId: string;
  ownerId: string;
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  state: "held" | "uncertain" | "quarantined" | "released";
  execution: { pid: number | null; binding: string | null };
  evidence: Evidence;
}
export interface CoordinatorOwner {
  id: string;
  instanceId: string;
  pid: number;
  processBinding: string;
  generation: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}
export interface ContextPackage {
  id: string;
  projectId: string;
  conversationId: string | null;
  hash: string;
  text: string;
  specificationRevision: string | null;
  sourceRefs: string[];
  omissions: string[];
  visibility: "project" | "restricted";
  completeness: "recorded" | "legacy-unknown";
  createdAt: string;
}
export interface ContextDelivery {
  id: string;
  projectId: string;
  packageId: string;
  attemptId: string;
  state: "prepared" | "submitted" | "acknowledged" | "unknown";
  evidence: Evidence;
  createdAt: string;
}
export interface ReviewFinding {
  id: string;
  projectId: string;
  candidateId: string;
  taskId: string;
  severity: "critical" | "high" | "medium" | "low";
  behavior: string;
  evidence: Evidence;
  disposition: "open" | "resolved" | "waived" | "unsubstantiated";
  recheckVerificationId: string | null;
}
export interface SyncObservation {
  id: string;
  projectId: string;
  dimension:
    | "identity"
    | "code"
    | "context"
    | "history"
    | "configuration"
    | "native-presentation";
  targetId: string;
  state:
    | "current"
    | "pending"
    | "stale"
    | "conflict"
    | "unsupported"
    | "unverified"
    | "paused"
    | "error";
  evidence: Evidence;
  expectedRevision: string | null;
  observedRevision: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulObservationAt: string | null;
  detail: string;
  suggestedAction: string | null;
}
export const unknownEvidence = (detail: string): Evidence => ({
  level: "none",
  source: "unknown",
  observedAt: null,
  detail,
});
const transitions = {
  workflow: {
    draft: ["ready", "cancelled"],
    ready: ["running", "blocked", "cancelled"],
    running: ["blocked", "awaiting-acceptance", "failed", "cancelled"],
    blocked: ["ready", "running", "failed", "cancelled"],
    "awaiting-acceptance": ["running", "accepted", "cancelled"],
    accepted: [],
    failed: [],
    cancelled: [],
  },
  task: {
    draft: ["ready", "blocked", "cancelled"],
    ready: ["active", "blocked", "cancelled"],
    blocked: ["ready", "cancelled"],
    active: ["submitted", "blocked", "changes-requested", "cancelled"],
    submitted: ["reviewing", "verifying", "changes-requested", "cancelled"],
    reviewing: ["verifying", "changes-requested", "cancelled"],
    verifying: ["accepted", "changes-requested", "blocked", "cancelled"],
    "changes-requested": ["ready", "cancelled"],
    accepted: [],
    cancelled: [],
  },
  attempt: {
    prepared: ["starting", "failed", "interrupted", "uncertain"],
    starting: [
      "running",
      "awaiting-approval",
      "completed",
      "failed",
      "interrupted",
      "uncertain",
    ],
    running: [
      "awaiting-approval",
      "completed",
      "failed",
      "interrupted",
      "uncertain",
    ],
    "awaiting-approval": [
      "running",
      "completed",
      "failed",
      "interrupted",
      "uncertain",
    ],
    completed: [],
    failed: [],
    interrupted: [],
    uncertain: ["interrupted", "completed", "failed"],
  },
};
export function assertTransition(
  kind: keyof typeof transitions,
  from: string,
  to: string,
): void {
  if (from === to) return;
  const allowed = (transitions[kind] as Record<string, readonly string[]>)[
    from
  ];
  if (!allowed?.includes(to))
    throw new Error(`Invalid ${kind} transition: ${from} → ${to}.`);
}
export function assertDependencyGraph(
  tasks: Pick<Task, "id" | "dependencies">[],
): void {
  const graph = new Map(tasks.map((task) => [task.id, task.dependencies]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("Task dependencies contain a cycle.");
    if (visited.has(id)) return;
    const dependencies = graph.get(id);
    if (!dependencies)
      throw new Error("Task dependency does not exist in this workflow.");
    visiting.add(id);
    dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach((task) => visit(task.id));
}
export const activeAttemptStates = [
  "prepared",
  "starting",
  "running",
  "awaiting-approval",
  "uncertain",
] as const;
