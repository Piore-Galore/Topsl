import { z } from "zod";
import {
  memberIntentSchema,
  roleGroupSettingsSchema,
  roleIdSchema,
  type GoalCheckDefinition,
  type GoalState,
  type MemberRoundState,
  type RoleGroupSettings,
} from "./role-groups";

/**
 * Native Topsl sessions (docs/Native_Sessions_Plan.md). A session is the
 * durable identity of one coordinator conversation: its configuration, its
 * ordered work queue, the work running now and the latest accepted result.
 * Its ID is the conversation's ID, so messages, goals and loop runs that
 * already name the conversation belong to it without a rewrite. This module
 * holds no Node imports: the renderer reads it too.
 */

export const SESSION_PROTOCOL = "session-v1" as const;

/** How the composer asks coordinators to treat a message. */
export const composerModes = ["auto", "discuss", "work"] as const;
export type ComposerMode = (typeof composerModes)[number];

/** What coordinators may decide a message is. */
export const sessionIntents = [
  "discuss",
  "status",
  "steer",
  "new-work",
  "clarify",
] as const;
export type SessionIntent = (typeof sessionIntents)[number];

/** automatic: coordinators organize the team; custom: the owner's roster. */
export const teamModes = ["automatic", "custom"] as const;
export type TeamMode = (typeof teamModes)[number];

/** Purposes a session role may be created with. Coordination stays separate. */
export const sessionRolePurposes = [
  "implementation",
  "information",
  "candidate-review",
] as const;

export const sessionRoleSchema = z
  .object({
    /** Owner settings for this role in this session only. */
    settings: roleGroupSettingsSchema.default({}),
    /** Role instructions for a role this session defines. */
    title: z.string().min(1).max(200).optional(),
    instructions: z.string().min(1).max(8000).optional(),
    purpose: z.enum(sessionRolePurposes).optional(),
  })
  .strict();
export type SessionRole = z.infer<typeof sessionRoleSchema>;

/** The owner's configuration of a session. Every change is a new revision. */
export const sessionConfigurationSchema = z
  .object({
    /** Selected coordinators. Empty: one Auto coordinator. A pin stays pinned. */
    coordinators: z.array(memberIntentSchema).max(8).default([]),
    team: z.enum(teamModes).default("automatic"),
    /**
     * Roles the owner set or pinned for this session. In a custom team they
     * are the roster; in an automatic team they stay active and their set
     * fields stay authoritative while automation fills the rest.
     */
    roles: z.record(roleIdSchema, sessionRoleSchema).default({}),
    /** Roles a custom team requires before work can start. */
    requiredRoles: z.array(roleIdSchema).max(64).default([]),
    composerMode: z.enum(composerModes).default("auto"),
  })
  .strict();
export type SessionConfiguration = z.infer<typeof sessionConfigurationSchema>;

/**
 * A change to some fields of a configuration. Unlike `.partial()`, which
 * still fills defaults, an absent field here stays absent, so changing the
 * roles never resets the coordinators.
 */
export const sessionConfigurationPatchSchema = z
  .object({
    coordinators: z.array(memberIntentSchema).max(8).optional(),
    team: z.enum(teamModes).optional(),
    roles: z.record(roleIdSchema, sessionRoleSchema).optional(),
    requiredRoles: z.array(roleIdSchema).max(64).optional(),
    composerMode: z.enum(composerModes).optional(),
  })
  .strict();

/** The project defaults a session captured when it was created. */
export interface InheritedDefaults {
  policyRevision: number;
  policyDefaults: RoleGroupSettings;
  maxMembersPerRole: number;
  roles: Record<
    string,
    {
      revisionId: string;
      settings: RoleGroupSettings;
      authority: "user" | "automatic";
    }
  >;
  capturedAt: string;
}

/** What the coordinators decided about the team. It fills only open fields. */
export interface SessionAutomaticTeam {
  revision: number;
  roles: Record<string, { settings: RoleGroupSettings; reason: string }>;
  /** Roles automation chose to use; null: every visible role. */
  activeRoles: string[] | null;
  intakeId: string | null;
  /** A refused proposal and why, so the Team pane can say what was kept. */
  rejections: string[];
}

export type WorkItemState =
  | "queued"
  | "waiting-configuration"
  | "running"
  | "accepted"
  | "completed"
  | "stopped"
  | "cancelled";

export interface SessionWorkItem {
  id: string;
  kind: "goal" | "loop";
  objective: string;
  goalKind: "code" | "information";
  checks: GoalCheckDefinition[];
  state: WorkItemState;
  goalId: string | null;
  runId: string | null;
  messageId: string | null;
  intakeId: string | null;
  /** The accepted result this work continued from; null: the project folder. */
  baselineCandidateId: string | null;
  /** legacy: recorded before sessions; its execution keeps its old behavior. */
  origin: "session" | "legacy";
  detail: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCheckpoint {
  candidateId: string;
  goalId: string | null;
  runId: string | null;
  workItemId: string | null;
  at: string;
}

export interface TopslSession {
  /** The conversation's ID. */
  id: string;
  projectId: string;
  conversationId: string;
  /** The configuration revision; bumps on every applied change. */
  revision: number;
  configuration: SessionConfiguration;
  /** A change waiting for the active goal's open round to finish. */
  pending: {
    configuration: SessionConfiguration;
    commandId: string;
    requestedAt: string;
  } | null;
  /** null: the session follows the project defaults as they change (legacy). */
  inherited: InheritedDefaults | null;
  automatic: SessionAutomaticTeam;
  /** An endorsed team change waiting for the active goal's open round. */
  pendingAutomatic?: SessionAutomaticTeam | null;
  /** Intakes still collecting, reconciling or endorsing. */
  openIntakes?: string[];
  queue: SessionWorkItem[];
  activeWorkId: string | null;
  acceptedCheckpoint: SessionCheckpoint | null;
  control: "running" | "paused" | "stopped";
  /** Advances on pause, resume and stop; an intake from before cannot act. */
  controlGeneration: number;
  /** What the session waits on the owner for, if anything. */
  attention: { kind: SessionAttentionKind; detail: string } | null;
  origin: "native" | "legacy";
  createdAt: string;
  updatedAt: string;
}

export type SessionAttentionKind =
  "choose-alternative" | "configure-team" | "choose-model";

export const attentionLabels: Record<SessionAttentionKind, string> = {
  "choose-alternative": "Choose",
  "configure-team": "Configure team",
  "choose-model": "Choose model",
};

/** One coordinator's view of one message, and later its endorsement. */
export interface IntakeContribution {
  id: string;
  phase: IntakePhase;
  attemptId: string;
  output: unknown;
  valid: boolean;
  reason: string;
  reportedModel: string | null;
  at: string;
}

export type IntakePhase =
  "initial" | "reconciliation" | "endorsement" | "wording";

export interface IntakeMember {
  memberId: string;
  assignmentId: string;
  assignmentRevision: number;
  provider: "codex" | "claude";
  model: string;
  installationId: string;
  /** Position in the configured coordinator order; 0 prepares the wording. */
  order: number;
  state: MemberRoundState;
  phase: IntakePhase;
  attemptIds: string[];
  activeAttemptId: string | null;
  launchId: string | null;
  retries: number;
  detail: string;
  contributions: IntakeContribution[];
}

/** A decision the coordinators endorse before it takes effect. */
export interface IntakeCandidate {
  intent: "steer" | "new-work";
  team: SessionTeamProposal | null;
  digest: string;
  proposedBy: string[];
}

export interface IntakeAlternative {
  intent: SessionIntent;
  team: SessionTeamProposal | null;
  memberIds: string[];
  summary: string;
}

export type IntakeOutcome =
  | {
      kind: "reply";
      intent: "discuss" | "status" | "clarify";
      /** Differing views, reported without blocking. */
      views: Array<{ memberId: string; intent: SessionIntent }>;
    }
  | {
      kind: "act";
      intent: "steer" | "new-work";
      team: SessionTeamProposal | null;
      endorsedBy: string[];
      workItemId: string | null;
      goalId: string | null;
    }
  | {
      kind: "alternatives";
      options: IntakeAlternative[];
      chosen: number | null;
    }
  | { kind: "failed"; reason: string };

/** One message's coordinator round. */
export interface SessionIntake {
  id: string;
  projectId: string;
  sessionId: string;
  conversationId: string;
  messageId: string;
  text: string;
  mode: ComposerMode;
  /** The goal the composer targeted, or null for New goal. */
  targetGoalId: string | null;
  kind: "code" | "information";
  checks: GoalCheckDefinition[];
  configurationRevision: number;
  controlGeneration: number;
  context: SessionContext;
  inputDigest: string;
  members: IntakeMember[];
  stage:
    | "collecting"
    | "reconciling"
    | "endorsing"
    | "awaiting-user"
    | "decided"
    | "failed"
    | "stale"
    | "stopped";
  reconciliationUsed: number;
  candidate: IntakeCandidate | null;
  outcome: IntakeOutcome | null;
  /** The shared coordinator response message, once recorded. */
  replyMessageId: string | null;
  /** Restarts after a configuration change; bounded. */
  restarts: number;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// The session-v1 protocol: coordinators' structured answers.

const provider = z.enum(["codex", "claude"]);

/** A model reference keeps its provider, not just a model name. */
export const sessionModelRefSchema = z
  .object({ provider, model: z.string().min(1).max(200) })
  .strict();
export type SessionModelRef = z.infer<typeof sessionModelRefSchema>;

export const sessionTeamRoleSchema = z
  .object({
    roleId: roleIdSchema,
    /** Set only to create a role for this session. */
    title: z.string().min(1).max(200).nullable(),
    instructions: z.string().min(1).max(8000).nullable(),
    purpose: z.enum(sessionRolePurposes).nullable(),
    count: z.number().int().min(1).max(64).nullable(),
    models: z.array(sessionModelRefSchema).max(64),
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type SessionTeamRole = z.infer<typeof sessionTeamRoleSchema>;
export type SessionTeamProposal = SessionTeamRole[];

export const sessionIntakeResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolKind: z.literal(SESSION_PROTOCOL),
    inputDigest: z.string().min(1).max(200),
    intent: z.enum(sessionIntents),
    reply: z.string().min(1).max(20000),
    /** The clarifying question, when intent is clarify. */
    question: z.string().min(1).max(2000).nullable(),
    /** The roles and models this work needs; null leaves the team as is. */
    team: z.array(sessionTeamRoleSchema).max(16).nullable(),
  })
  .strict();
export type SessionIntakeResponse = z.infer<typeof sessionIntakeResponseSchema>;

/** The first coordinator's shared wording, from its peers' contributions. */
export const sessionWordingSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolKind: z.literal(SESSION_PROTOCOL),
    inputDigest: z.string().min(1).max(200),
    reply: z.string().min(1).max(20000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Bounded session context.

export interface SessionContext {
  messages: Array<{
    id: string;
    sequence: number;
    role: "user" | "coordinator" | "service";
    text: string;
  }>;
  /** Older history left out, by reference. */
  omitted: { fromSequence: number; toSequence: number; count: number } | null;
  decisions: Array<{ intakeId: string; intent: string; summary: string }>;
  work: Array<{
    workItemId: string;
    goalId: string | null;
    objective: string;
    state: string;
    result: string | null;
  }>;
  checkpoint: { candidateId: string; goalId: string | null } | null;
  /** The current goal's status, when one is running. */
  status: string | null;
  team: string[];
}

export const CONTEXT_MESSAGES = 12;
export const CONTEXT_DECISIONS = 8;
export const CONTEXT_WORK = 6;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The frozen context every coordinator of one intake reads: recent messages,
 * recorded decisions, relevant goal results and the accepted checkpoint.
 * Older messages are referenced by sequence, never inlined.
 */
export function buildSessionContext(input: {
  messages: Array<{
    id: string;
    sequence: number;
    role: "user" | "coordinator" | "service";
    text: string;
  }>;
  decisions: SessionContext["decisions"];
  work: SessionContext["work"];
  checkpoint: SessionContext["checkpoint"];
  status: string | null;
  team: string[];
  /** Messages before those given, when only the latest were read. */
  omitted?: SessionContext["omitted"];
}): SessionContext {
  const sorted = [...input.messages].sort((a, b) => a.sequence - b.sequence);
  const recent = sorted.slice(-CONTEXT_MESSAGES);
  const older = sorted.slice(0, Math.max(0, sorted.length - recent.length));
  return {
    messages: recent.map((m) => ({ ...m, text: clip(m.text, 2000) })),
    omitted: older.length
      ? {
          fromSequence: input.omitted?.fromSequence ?? older[0].sequence,
          toSequence: older.at(-1)!.sequence,
          count: (input.omitted?.count ?? 0) + older.length,
        }
      : (input.omitted ?? null),
    decisions: input.decisions
      .slice(-CONTEXT_DECISIONS)
      .map((d) => ({ ...d, summary: clip(d.summary, 600) })),
    work: input.work.slice(-CONTEXT_WORK).map((w) => ({
      ...w,
      objective: clip(w.objective, 600),
      result: w.result ? clip(w.result, 1500) : null,
    })),
    checkpoint: input.checkpoint,
    status: input.status ? clip(input.status, 1500) : null,
    team: input.team.slice(0, 32),
  };
}

// ---------------------------------------------------------------------------
// The work queue.

export const openWorkStates: WorkItemState[] = [
  "queued",
  "waiting-configuration",
  "running",
];

/** The work item a goal's state settles, or null while it is still active. */
export function settledWorkState(goal: {
  state: GoalState;
  kind: "code" | "information";
}): WorkItemState | null {
  switch (goal.state) {
    case "accepted":
      return "accepted";
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return null;
  }
}

/** The next work item to start, in queue order, or null. */
export function nextWorkItem(session: TopslSession): SessionWorkItem | null {
  if (session.control !== "running" || session.activeWorkId) return null;
  return session.queue.find((w) => w.state === "queued") ?? null;
}

/** The configuration the owner changed, field by field, for the Team pane. */
export function coordinatorSettings(
  configuration: SessionConfiguration,
): RoleGroupSettings {
  if (!configuration.coordinators.length) return { form: "auto", count: 1 };
  return { form: "exact", members: configuration.coordinators };
}

/** Roles a custom team needs but does not define. */
export function missingRequiredRoles(
  configuration: SessionConfiguration,
  defined: (roleId: string) => boolean,
): string[] {
  if (configuration.team !== "custom") return [];
  return configuration.requiredRoles.filter(
    (r) => !configuration.roles[r] || !defined(r),
  );
}

/** What a session needs from the owner, for the sidebar. */
export function sessionAttention(session: TopslSession): string | null {
  return session.attention ? attentionLabels[session.attention.kind] : null;
}

// ---------------------------------------------------------------------------
// Thread identity for sessions.

export const sessionThreadId = (sessionId: string) => `session:${sessionId}`;
