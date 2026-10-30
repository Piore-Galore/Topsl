import { sessionReference } from "../workspace/imports";
import { referencePromptBlock } from "../domain/history-imports";
import type { SessionReferenceSummary } from "../domain/history-imports";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type {
  CoordinatorConversation,
  CoordinatorMessage,
  Goal,
  GoalCheckDefinition,
  RoleGroupSettings,
  RoleRound,
} from "../domain/role-groups";
import {
  buildSessionContext,
  CONTEXT_MESSAGES,
  nextWorkItem,
  sessionConfigurationSchema,
  settledWorkState,
  type ComposerMode,
  type InheritedDefaults,
  type IntakeAlternative,
  type IntakeContribution,
  type IntakeMember,
  type IntakeOutcome,
  type SessionAttentionKind,
  type SessionConfiguration,
  type SessionContext,
  type SessionIntake,
  type SessionIntakeResponse,
  type SessionTeamProposal,
  type SessionWorkItem,
  type TopslSession,
} from "../domain/sessions";
import { threadTitle } from "../domain/threads";
import type { Store } from "../persistence/store";
import { endorsementSchema, parseFinal } from "./contracts";
import type { MemberTurn, OrchestrationDriver, Orchestrator } from "./engine";
import { layersFor } from "./membership";
import {
  eligibleModels,
  organizeSessionTeam,
  roleDefinitionFor,
} from "./organization";
import { kinds } from "./repository";
import { modelEvidence, resolveGroup } from "./selection";
import {
  decidePeers,
  decisionDigest,
  parseSessionTurn,
  sessionEndorsementPrompt,
  sessionIntakePrompt,
  sessionWordingPrompt,
  sharedReply,
  type PeerAnswer,
  type PeerDecision,
} from "./session-contracts";
import { sessionActiveRoles, sessionFunctions } from "./session-layers";
import { endedGoalStates } from "./routing";

/** A loop run as the session supervisor sees it. */
export interface SessionLoopFact {
  id: string;
  conversationId: string;
  title: string;
  state: string;
  /** What the owner last asked of the run: running, paused or stopped. */
  desiredState?: string;
  started: boolean;
  /** The run's accepted result, once an iteration was promoted. */
  acceptedCandidateId: string | null;
}

export interface SessionLoopPort {
  runs(projectId: string): SessionLoopFact[];
  stop(runId: string, commandId: string): Promise<void>;
  /** Pauses or resumes a started run; resume never starts a draft. */
  control?(
    runId: string,
    action: "pause" | "resume",
    commandId: string,
  ): Promise<void>;
}

/** Imports a new session can attach (docs/UX_Cleanup_Plan.md §3). */
export interface SessionReferencePort {
  /** Throws unless the import exists in this project. */
  check(projectId: string, referenceId: string): void;
  freeze(input: {
    projectId: string;
    referenceId: string;
    sessionId: string;
  }): SessionReferenceSummary;
}

const openIntakeStages: SessionIntake["stage"][] = [
  "collecting",
  "reconciling",
  "endorsing",
];
const openRoundStages: RoleRound["stage"][] = [
  "collecting",
  "reconciling",
  "endorsing",
];
/** One reconciliation round, then the owner decides. */
const RECONCILIATION_ROUNDS = 1;
/** An intake restarts once when the configuration changes under it. */
const INTAKE_RESTARTS = 1;
const MEMBER_RETRIES = 1;

/**
 * Native Topsl sessions (docs/Native_Sessions_Plan.md). The supervisor owns
 * each session's configuration, its message intake, its ordered work queue
 * and its accepted result. Goals still run in the coordinator engine; the
 * supervisor starts one at a time, continuing from the latest accepted
 * result, and never accepts, applies or publishes anything itself.
 */
export class SessionSupervisor {
  private ticking = false;
  /** Each session's admission and control operations, one after another. */
  private serials = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly orchestrator: Orchestrator,
    private driver: OrchestrationDriver,
    private changed: () => void = () => {},
    private loops: SessionLoopPort | null = null,
    private references: SessionReferencePort | null = null,
  ) {}

  private get repo() {
    return this.orchestrator.repo;
  }

  /** Loop runs per project, read once per tick. */
  private runCache: Map<string, SessionLoopFact[]> | null = null;
  private runs(projectId: string): SessionLoopFact[] {
    if (!this.loops) return [];
    if (!this.runCache) return this.loops.runs(projectId);
    let runs = this.runCache.get(projectId);
    if (!runs) {
      runs = this.loops.runs(projectId);
      this.runCache.set(projectId, runs);
    }
    return runs;
  }

  // -------------------------------------------------------------------------
  // Creation, backfill and configuration

  /** The project defaults a new session captures. */
  private capture(projectId: string): InheritedDefaults {
    const policy = this.repo.policy(projectId);
    const revisions = this.repo.groupRevisions(projectId);
    const roles: InheritedDefaults["roles"] = {};
    for (const role of this.repo.visibleRoles(projectId, null)) {
      const layer = layersFor(revisions, null, role.id, null, null).find(
        (l) => l.level === "project-role",
      );
      if (layer)
        roles[role.id] = {
          revisionId: layer.revisionId!,
          settings: layer.settings,
          authority: layer.authority ?? "user",
        };
    }
    return {
      policyRevision: policy.revision,
      policyDefaults: policy.defaults,
      maxMembersPerRole: policy.maxMembersPerRole,
      roles,
      capturedAt: now(),
    };
  }

  private blank(
    conversation: CoordinatorConversation,
    origin: TopslSession["origin"],
    configuration: SessionConfiguration,
  ): TopslSession {
    const at = now();
    return {
      id: conversation.id,
      projectId: conversation.projectId,
      conversationId: conversation.id,
      revision: 1,
      configuration,
      pending: null,
      inherited:
        origin === "native" ? this.capture(conversation.projectId) : null,
      automatic: {
        revision: 0,
        roles: {},
        activeRoles: null,
        intakeId: null,
        rejections: [],
      },
      queue: [],
      activeWorkId: null,
      acceptedCheckpoint: null,
      control: "running",
      controlGeneration: 1,
      attention: null,
      origin,
      createdAt: at,
      updatedAt: at,
    };
  }

  /**
   * Gives every conversation recorded before sessions a session of its own,
   * without rewriting its messages, goals or evidence. Its goals and loop
   * runs become work items; a running one keeps its old behavior, and new
   * work waits behind it in the queue. Legacy sessions keep following the
   * project defaults as they change.
   */
  backfill(): number {
    let created = 0;
    for (const conversation of this.store.iterate<CoordinatorConversation>(
      kinds.conversation,
    )) {
      if (this.repo.get(kinds.session, conversation.id)) continue;
      const session = this.blank(
        conversation,
        "legacy",
        sessionConfigurationSchema.parse({}),
      );
      session.createdAt = conversation.createdAt;
      this.discover(session);
      this.store.save(kinds.session, session);
      created++;
    }
    if (created) this.changed();
    return created;
  }

  /** Adds goals and loop runs of the conversation that the queue does not list yet. */
  private discover(session: TopslSession): boolean {
    let found = false;
    const conversation = this.repo.require<CoordinatorConversation>(
      kinds.conversation,
      session.conversationId,
    );
    const listed = new Set(session.queue.map((w) => w.goalId ?? w.runId));
    for (const goalId of conversation.goalIds) {
      if (listed.has(goalId)) continue;
      const goal = this.repo.get<Goal>(kinds.goal, goalId);
      if (!goal) continue;
      found = true;
      session.queue.push({
        ...this.item(goal.objective, goal.kind, goal.checks ?? []),
        origin: "legacy",
        goalId: goal.id,
        state: settledWorkState(goal) ?? "running",
        detail: "Started outside the session queue.",
        createdAt: goal.createdAt,
      });
      if (goal.state === "accepted" && goal.acceptance)
        session.acceptedCheckpoint = {
          candidateId: goal.acceptance.candidateId,
          goalId: goal.id,
          runId: null,
          workItemId: session.queue.at(-1)!.id,
          at: goal.acceptance.at,
        };
    }
    for (const run of this.runs(session.projectId)) {
      if (run.conversationId !== session.conversationId || listed.has(run.id))
        continue;
      found = true;
      session.queue.push({
        ...this.item(run.title, "code", []),
        kind: "loop",
        runId: run.id,
        origin: session.origin === "native" ? "session" : "legacy",
        state: ["stopped", "completed"].includes(run.state)
          ? "stopped"
          : run.started
            ? "running"
            : "queued",
        detail: "A loop run in this session.",
      });
    }
    return found;
  }

  private item(
    objective: string,
    goalKind: "code" | "information",
    checks: GoalCheckDefinition[],
  ): SessionWorkItem {
    const at = now();
    return {
      id: uid(),
      kind: "goal",
      objective,
      goalKind,
      checks,
      state: "queued",
      goalId: null,
      runId: null,
      messageId: null,
      intakeId: null,
      baselineCandidateId: null,
      origin: "session",
      detail: "",
      createdAt: at,
      updatedAt: at,
    };
  }

  require(sessionId: string): TopslSession {
    const session = this.repo.get<TopslSession>(kinds.session, sessionId);
    if (session) return session;
    // A conversation recorded before sessions gets its session on first use.
    if (this.repo.get(kinds.conversation, sessionId)) {
      this.backfill();
      return this.repo.require<TopslSession>(kinds.session, sessionId);
    }
    throw new Error("The selected session does not exist.");
  }

  /**
   * Runs one admission or control operation of a session after the ones
   * already waiting, so a loop start, a queue change, a session control and
   * the scheduler never interleave (docs/UX_Cleanup_Plan.md §4).
   */
  serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.serials.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.catch(() => {});
    this.serials.set(sessionId, settled);
    void settled.then(() => {
      if (this.serials.get(sessionId) === settled)
        this.serials.delete(sessionId);
    });
    return next;
  }

  /** The native session a loop run belongs to, if any. */
  private loopSession(run: { conversationId: string }) {
    const session = this.repo.get<TopslSession>(
      kinds.session,
      run.conversationId,
    );
    return session?.origin === "native" ? session : null;
  }

  /**
   * Why a loop of a native session cannot start now: the session must be
   * running, the loop must still be in its queue, and it must be the next
   * work, with nothing running.
   */
  loopAdmission(run: { id: string; conversationId: string }): string | null {
    const session = this.loopSession(run);
    if (!session) return null;
    if (session.control !== "running")
      return "This session is paused. Resume the session, then start the loop.";
    const latest = this.sync(this.require(session.id));
    const item = latest.queue.find((w) => w.runId === run.id);
    if (!item || item.state !== "queued")
      return "This loop is no longer in the session's queue.";
    if (latest.queue.some((w) => w.state === "running" && w.runId !== run.id))
      return "This session is already running a goal or loop. Start this run when it finishes, or stop the current work first.";
    const ahead = latest.queue
      .slice(0, latest.queue.indexOf(item))
      .find((w) => ["queued", "waiting-configuration"].includes(w.state));
    if (ahead)
      return `Earlier work in this session runs first ("${threadTitle(ahead.objective, 60)}"). Move the loop up in Work, or remove the earlier work.`;
    return null;
  }

  /** Why a paused loop of a native session cannot resume now. */
  loopResumeRefusal(run: {
    id: string;
    conversationId: string;
  }): string | null {
    const session = this.loopSession(run);
    if (!session) return null;
    if (session.control !== "running")
      return "This session is paused. Resume the session; its running loop resumes with it.";
    return null;
  }

  /** Brings a session's queue up to date with its goals and loop runs now. */
  refresh(sessionId: string): TopslSession {
    return this.sync(this.require(sessionId));
  }

  private save(session: TopslSession, next: Partial<TopslSession> = {}) {
    const value = { ...session, ...next, updatedAt: now() };
    this.store.save(kinds.session, value);
    return value;
  }

  /**
   * Creates a session: its conversation, its configuration with the project
   * defaults captured now, and, with text, its first message.
   */
  async create(input: {
    projectId: string;
    title?: string;
    configuration?: Partial<SessionConfiguration>;
    text?: string;
    mode?: ComposerMode;
    kind?: "code" | "information";
    checks?: GoalCheckDefinition[];
    referenceId?: string;
    commandId: string;
  }) {
    return this.repo.receipt(
      input.commandId,
      input.projectId,
      "session-create",
      async () => {
        const configuration = sessionConfigurationSchema.parse(
          input.configuration ?? {},
        );
        this.validateConfiguration(input.projectId, null, configuration);
        if (input.referenceId) {
          if (!this.references)
            throw new Error("Imports cannot be attached here.");
          this.references.check(input.projectId, input.referenceId);
        }
        const text = input.text?.trim() ?? "";
        const conversation = await this.orchestrator.createConversation({
          projectId: input.projectId,
          title:
            input.title?.trim() || (text ? threadTitle(text) : "New session"),
          commandId: `${input.commandId}:conversation`,
        });
        let session = this.blank(conversation, "native", {
          ...configuration,
          coordinators: numbered(configuration.coordinators),
        });
        // The import is frozen before the first message, so every intake
        // of the session reads the same copy.
        if (input.referenceId)
          session.reference = this.references!.freeze({
            projectId: input.projectId,
            referenceId: input.referenceId,
            sessionId: session.id,
          });
        session = this.save(session);
        this.defineRoles(session, session.configuration);
        this.changed();
        const posted = text
          ? await this.message({
              sessionId: session.id,
              text,
              mode: input.mode,
              target: null,
              kind: input.kind,
              checks: input.checks,
              commandId: `${input.commandId}:message`,
            })
          : null;
        return {
          sessionId: session.id,
          session: this.require(session.id),
          intakeId: posted?.intakeId ?? null,
        };
      },
    );
  }

  private validateConfiguration(
    projectId: string,
    sessionId: string | null,
    configuration: SessionConfiguration,
  ) {
    const all = this.repo.roles(projectId);
    for (const [roleId, role] of Object.entries(configuration.roles)) {
      const existing = all.find((r) => r.id === roleId);
      if (
        existing?.ownerConversationId &&
        existing.ownerConversationId !== sessionId
      )
        throw new Error(
          `Role ${roleId} belongs to another session. Choose another role ID.`,
        );
      if (existing?.purpose === "coordinator-contribution")
        throw new Error(
          "Coordinators are chosen in the session's coordinator list, not as a team role.",
        );
      if (!existing && !(role.title && role.instructions && role.purpose))
        throw new Error(
          `Role ${roleId} is new: give it a title, instructions and a purpose.`,
        );
      if (
        existing &&
        !existing.ownerConversationId &&
        (role.instructions || role.title || role.purpose)
      )
        throw new Error(
          `Role ${roleId} is a project role; its definition is edited in the project's role defaults.`,
        );
    }
    for (const roleId of configuration.requiredRoles)
      if (!configuration.roles[roleId])
        throw new Error(
          `Required role ${roleId} is not in the session's roster.`,
        );
  }

  /** Session roles the owner defined belong to the session. */
  private defineRoles(
    session: TopslSession,
    configuration: SessionConfiguration,
  ) {
    for (const [roleId, role] of Object.entries(configuration.roles)) {
      if (!role.title || !role.instructions || !role.purpose) continue;
      const key = `${session.projectId}:${roleId}`;
      const prior = this.repo.get<{
        revision: number;
        title: string;
        instructions: string;
        purpose: string;
        ownerConversationId?: string | null;
      }>(kinds.role, key);
      if (
        prior &&
        prior.title === role.title &&
        prior.instructions === role.instructions &&
        prior.purpose === role.purpose
      )
        continue;
      this.repo.saveRevisioned(kinds.role, {
        ...roleDefinitionFor({
          projectId: session.projectId,
          roleId,
          title: role.title,
          instructions: role.instructions,
          purpose: role.purpose,
          ownerConversationId: session.id,
        }),
        revision: (prior?.revision ?? 0) + 1,
      });
    }
  }

  /** Whether the session's active goal has a round whose inputs are frozen now. */
  private openRound(session: TopslSession): boolean {
    const goalId = this.activeGoalId(session);
    if (!goalId) return false;
    return this.orchestrator
      .rounds(goalId)
      .some((r) => openRoundStages.includes(r.stage));
  }

  /**
   * Changes the session's configuration. While the active goal has an open
   * round the change waits for its boundary, so a frozen round is never
   * re-scoped under its members; a stale answer cannot authorize work.
   */
  async update(input: {
    sessionId: string;
    expectedRevision: number;
    configuration: Partial<SessionConfiguration>;
    commandId: string;
  }) {
    const session = this.require(input.sessionId);
    return this.repo.receipt(
      input.commandId,
      session.projectId,
      "session-update",
      () => {
        const latest = this.require(input.sessionId);
        if (latest.revision !== input.expectedRevision)
          throw new Error("This session changed. Refresh and try again.");
        const base = latest.pending?.configuration ?? latest.configuration;
        const configuration = sessionConfigurationSchema.parse({
          ...base,
          ...input.configuration,
        });
        configuration.coordinators = numbered(configuration.coordinators);
        this.validateConfiguration(latest.projectId, latest.id, configuration);
        const result = this.store.transaction(() => {
          if (this.openRound(latest))
            return this.save(latest, {
              pending: {
                configuration,
                commandId: input.commandId,
                requestedAt: now(),
              },
            });
          return this.applyConfiguration(latest, configuration);
        });
        this.changed();
        return result;
      },
    );
  }

  private applyConfiguration(
    session: TopslSession,
    configuration: SessionConfiguration,
  ): TopslSession {
    this.defineRoles(session, configuration);
    const next = this.save(session, {
      configuration,
      pending: null,
      revision: session.revision + 1,
      // A configuration change is the owner's answer to a team request.
      attention:
        session.attention?.kind === "choose-alternative"
          ? session.attention
          : null,
      queue: session.queue.map((w) =>
        w.state === "waiting-configuration" ? { ...w, state: "queued" } : w,
      ),
    });
    return next;
  }

  /**
   * Saves a session role and its settings as project defaults, so new
   * sessions inherit them. The session keeps using the role.
   */
  async saveRole(input: {
    sessionId: string;
    roleId: string;
    commandId: string;
  }) {
    const session = this.require(input.sessionId);
    return this.repo.receipt(
      input.commandId,
      session.projectId,
      "session-role-save",
      () => {
        const key = `${session.projectId}:${input.roleId}`;
        const role = this.repo.get<
          Record<string, unknown> & {
            revision: number;
            ownerConversationId?: string | null;
          }
        >(kinds.role, key);
        if (
          role &&
          role.ownerConversationId &&
          role.ownerConversationId !== session.id
        )
          throw new Error("This role belongs to another session.");
        this.store.transaction(() => {
          if (role?.ownerConversationId)
            this.repo.saveRevisioned(kinds.role, {
              ...role,
              id: key,
              ownerConversationId: null,
              revision: role.revision + 1,
            } as never);
          const owned: RoleGroupSettings =
            session.configuration.roles[input.roleId]?.settings ?? {};
          const automatic =
            session.automatic.roles[input.roleId]?.settings ?? {};
          const value = { ...automatic, ...owned };
          if (Object.keys(value).length)
            this.repo.addGroupRevision({
              scope: {
                level: "project-role",
                projectId: session.projectId,
                goalId: null,
                taskKey: null,
              },
              roleId: input.roleId,
              settings: value,
              actor: "local-user",
              commandId: input.commandId,
              messageId: null,
            });
        });
        this.changed();
        return this.repo.role(session.projectId, input.roleId);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Messages and intake

  private activeItem(session: TopslSession): SessionWorkItem | null {
    return session.queue.find((w) => w.id === session.activeWorkId) ?? null;
  }

  /** The session's current goal: the active one, or a running legacy goal. */
  private activeGoalId(session: TopslSession): string | null {
    const active = this.activeItem(session);
    if (active?.goalId) return active.goalId;
    return (
      session.queue.find(
        (w) => w.origin === "legacy" && w.state === "running" && w.goalId,
      )?.goalId ?? null
    );
  }

  private conversation(session: TopslSession) {
    return this.repo.require<CoordinatorConversation>(
      kinds.conversation,
      session.conversationId,
    );
  }

  /**
   * Records the owner's message and starts its intake: every selected
   * coordinator answers it in the session-v1 protocol. Nothing is routed by
   * punctuation; what the message is comes from the coordinators.
   */
  async message(input: {
    sessionId: string;
    text: string;
    mode?: ComposerMode;
    /** "current": the session's current goal; a goal ID; null: New goal. */
    target?: string | null;
    kind?: "code" | "information";
    checks?: GoalCheckDefinition[];
    commandId: string;
  }) {
    const session = this.require(input.sessionId);
    return this.repo.receipt(
      input.commandId,
      session.projectId,
      "session-message",
      async () => {
        const text = input.text.trim();
        if (!text) throw new Error("Write a message first.");
        const latest = this.require(input.sessionId);
        const mode = input.mode ?? latest.configuration.composerMode;
        const targetGoalId =
          input.target === "current"
            ? this.activeGoalId(latest)
            : (input.target ?? null);
        if (targetGoalId) {
          const goal = this.repo.require<Goal>(kinds.goal, targetGoalId);
          if (goal.conversationId !== latest.conversationId)
            throw new Error("That goal belongs to another session.");
        }
        const message = await this.orchestrator.note({
          conversationId: latest.conversationId,
          role: "user",
          text,
          routing: { kind: "session", goalId: targetGoalId },
          commandId: `${input.commandId}:note`,
        });
        const intake = this.freezeIntake(latest, {
          messageId: message.id,
          text,
          mode,
          targetGoalId,
          kind: input.kind ?? "code",
          checks: input.checks ?? [],
          restarts: 0,
        });
        this.changed();
        return {
          messageId: message.id,
          intakeId: intake.id,
          stage: intake.stage,
        };
      },
    );
  }

  private contextFor(session: TopslSession): SessionContext {
    // Only the latest messages are read; sequences count from 1 in each
    // conversation, so the earlier ones are referenced by their range.
    const messages = this.store.page<CoordinatorMessage>(kinds.message, {
      projectId: session.projectId,
      conversationId: session.conversationId,
      order: "desc",
      limit: CONTEXT_MESSAGES,
    }).items;
    const oldest = Math.min(...messages.map((m) => m.sequence));
    const omitted =
      messages.length && oldest > 1
        ? { fromSequence: 1, toSequence: oldest - 1, count: oldest - 1 }
        : null;
    const decisions = this.intakes(session.id)
      .filter((i) => i.outcome && i.outcome.kind !== "failed")
      .map((i) => ({
        intakeId: i.id,
        intent:
          i.outcome!.kind === "alternatives"
            ? "awaiting the owner"
            : (i.outcome as { intent: string }).intent,
        summary: i.text,
      }));
    const work = session.queue.map((w) => {
      const goal = w.goalId ? this.repo.get<Goal>(kinds.goal, w.goalId) : null;
      return {
        workItemId: w.id,
        goalId: w.goalId,
        objective: w.objective,
        state: goal?.state ?? w.state,
        result: goal?.synthesis ?? null,
      };
    });
    const active = this.activeGoalId(session);
    const team: string[] = [];
    for (const role of this.repo.visibleRoles(session.projectId, session.id)) {
      const active = sessionActiveRoles(session);
      if (active && !active.has(role.id) && role.id !== "coordinator") continue;
      const group = this.orchestrator.effective(
        session.projectId,
        null,
        role.id,
        null,
        { scopeId: `session:${session.id}`, conversationId: session.id },
      );
      const pins = group.members
        .map((m) =>
          m.pin
            ? `${m.pin.provider ?? ""}:${m.pin.model ?? m.pin.label ?? ""}`
            : "Auto",
        )
        .join(", ");
      team.push(
        `- ${role.id} (${role.purpose}): ${pins || `Auto x${group.count ?? group.minCount}`}`,
      );
    }
    return buildSessionContext({
      messages: messages.map((m) => ({
        id: m.id,
        sequence: m.sequence,
        role: m.role,
        text: m.text,
      })),
      decisions,
      work,
      checkpoint: session.acceptedCheckpoint
        ? {
            candidateId: session.acceptedCheckpoint.candidateId,
            goalId: session.acceptedCheckpoint.goalId,
          }
        : null,
      status: active ? this.orchestrator.statusText(active) : null,
      team,
      omitted,
      reference: session.reference
        ? { id: session.reference.id, digest: session.reference.digest }
        : null,
    });
  }

  private freezeIntake(
    session: TopslSession,
    input: {
      messageId: string;
      text: string;
      mode: ComposerMode;
      targetGoalId: string | null;
      kind: "code" | "information";
      checks: GoalCheckDefinition[];
      restarts: number;
    },
  ): SessionIntake {
    const at = now();
    const context = this.contextFor(session);
    const resolved = this.orchestrator.resolve(
      session.projectId,
      null,
      "coordinator",
      null,
      { scopeId: `session:${session.id}`, conversationId: session.id },
    );
    const required = new Map(
      resolved.group.members.map((m) => [m.memberId, m.required]),
    );
    const blocked = resolved.assignments.filter(
      (a) => (required.get(a.memberId) ?? true) && a.status !== "resolved",
    );
    const usable = resolved.assignments.filter((a) => a.status === "resolved");
    const members: IntakeMember[] = usable.map((a, order) => ({
      memberId: a.memberId,
      assignmentId: a.id,
      assignmentRevision: a.revision,
      provider: a.provider!,
      model: a.model!,
      installationId: a.installationId!,
      order,
      state: "queued",
      phase: "initial",
      attemptIds: [],
      activeAttemptId: null,
      launchId: null,
      retries: 0,
      detail: "",
      contributions: [],
    }));
    const inputDigest = hash(
      stable({
        context,
        text: input.text,
        mode: input.mode,
        target: input.targetGoalId,
        revision: session.revision,
        members: members.map((m) => [
          m.memberId,
          m.assignmentId,
          m.assignmentRevision,
        ]),
      }),
    ).slice(0, 32);
    const intake: SessionIntake = {
      id: uid(),
      projectId: session.projectId,
      sessionId: session.id,
      conversationId: session.conversationId,
      messageId: input.messageId,
      text: input.text,
      mode: input.mode,
      targetGoalId: input.targetGoalId,
      kind: input.kind,
      checks: input.checks,
      configurationRevision: session.revision,
      controlGeneration: session.controlGeneration,
      context,
      inputDigest,
      members,
      stage: "collecting",
      reconciliationUsed: 0,
      candidate: null,
      outcome: null,
      replyMessageId: null,
      restarts: input.restarts,
      detail: `${members.length} ${members.length === 1 ? "coordinator" : "coordinators"} answering.`,
      createdAt: at,
      updatedAt: at,
    };
    const problems = [
      ...resolved.conflicts,
      ...blocked.map((a) => `${a.memberId}: ${a.reason}`),
    ];
    if (problems.length || !members.length) {
      const detail =
        problems.join(" ") ||
        "No coordinator can answer: no qualified route is available.";
      intake.stage = "failed";
      intake.outcome = { kind: "failed", reason: detail };
      intake.detail = detail;
      this.store.save(kinds.intake, intake);
      this.attend(session.id, "choose-model", detail);
      void this.orchestrator.note({
        conversationId: session.conversationId,
        role: "service",
        text: `The coordinators cannot answer yet. ${detail} Change the session's coordinators or add an explicit fallback; nothing was started.`,
        routing: { kind: "session", goalId: null },
        intakeId: intake.id,
        commandId: `${intake.id}:blocked`,
      });
      return intake;
    }
    this.store.transaction(() => {
      this.store.save(kinds.intake, intake);
      const latest = this.require(session.id);
      this.save(latest, {
        openIntakes: [...(latest.openIntakes ?? []), intake.id],
      });
    });
    return intake;
  }

  private attend(
    sessionId: string,
    kind: SessionAttentionKind | null,
    detail = "",
  ) {
    const session = this.require(sessionId);
    this.save(session, { attention: kind ? { kind, detail } : null });
  }

  intakes(sessionId: string): SessionIntake[] {
    const session = this.repo.get<TopslSession>(kinds.session, sessionId);
    if (!session) return [];
    return [
      ...this.store.iterate<SessionIntake>(kinds.intake, {
        projectId: session.projectId,
        conversationId: session.conversationId,
      }),
    ]
      .filter((i) => i.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private saveIntake(intake: SessionIntake, next: Partial<SessionIntake>) {
    const value = { ...intake, ...next, updatedAt: now() };
    this.store.save(kinds.intake, value);
    // A settled intake leaves its session's open list, so ticks read only
    // the intakes that can still move.
    if (!openIntakeStages.includes(value.stage)) {
      const session = this.repo.get<TopslSession>(
        kinds.session,
        value.sessionId,
      );
      if (session?.openIntakes?.includes(value.id))
        this.save(session, {
          openIntakes: session.openIntakes.filter((id) => id !== value.id),
        });
    }
    return value;
  }

  private targetActive(intake: SessionIntake): boolean {
    if (!intake.targetGoalId) return false;
    const goal = this.repo.get<Goal>(kinds.goal, intake.targetGoalId);
    return !!goal && !endedGoalStates.includes(goal.state);
  }

  private answers(intake: SessionIntake): PeerAnswer[] {
    const out: PeerAnswer[] = [];
    for (const m of intake.members) {
      const latest = [...m.contributions]
        .reverse()
        .find(
          (c) =>
            c.valid && (c.phase === "initial" || c.phase === "reconciliation"),
        );
      if (latest)
        out.push({
          memberId: m.memberId,
          order: m.order,
          value: latest.output as SessionIntakeResponse,
        });
    }
    return out;
  }

  private prompt(intake: SessionIntake, member: IntakeMember): string {
    const session = this.require(intake.sessionId);
    const role = this.repo.role(intake.projectId, "coordinator");
    if (member.phase === "endorsement")
      return sessionEndorsementPrompt({
        memberId: member.memberId,
        message: intake.text,
        intent: intake.candidate!.intent,
        team: intake.candidate!.team,
        digest: intake.candidate!.digest,
      });
    const answers = this.answers(intake);
    if (member.phase === "wording")
      return sessionWordingPrompt({
        memberId: member.memberId,
        message: intake.text,
        decision: describeOutcome(intake),
        contributions: answers.map((a) => ({
          memberId: a.memberId,
          intent: a.value.intent,
          reply: a.value.reply,
        })),
        inputDigest: intake.inputDigest,
      });
    const target = intake.targetGoalId
      ? this.repo.get<Goal>(kinds.goal, intake.targetGoalId)
      : null;
    const routes = this.driver.routes(intake.projectId);
    const models = new Map<
      string,
      { provider: string; model: string; purposes: string[] }
    >();
    for (const purpose of ["implementation", "information", "candidate-review"])
      for (const m of eligibleModels(routes, purpose)) {
        const key = `${m.provider}:${m.model}`;
        const prior = models.get(key) ?? { ...m, purposes: [] };
        prior.purposes.push(purpose);
        models.set(key, prior);
      }
    const reference = sessionReference(
      this.store,
      intake.context.reference?.id,
    );
    const prompt = sessionIntakePrompt({
      memberId: member.memberId,
      instructions: role.instructions,
      context: intake.context,
      message: intake.text,
      mode: intake.mode,
      target: target
        ? {
            goalId: target.id,
            objective: target.objective,
            state: target.state,
          }
        : null,
      teamMode: session.configuration.team,
      models: [...models.values()],
      inputDigest: intake.inputDigest,
      peers:
        member.phase === "reconciliation"
          ? answers
              .filter((a) => a.memberId !== member.memberId)
              .map((a) => ({
                memberId: a.memberId,
                intent: a.value.intent,
                reply: a.value.reply,
              }))
          : undefined,
    });
    return reference
      ? `${prompt}\n\n${referencePromptBlock(reference)}`
      : prompt;
  }

  private async launch(intake: SessionIntake): Promise<SessionIntake> {
    for (const member of intake.members.filter((m) => m.state === "queued")) {
      const capacity = this.driver.capacity();
      const held = capacity.held.reduce((n, h) => n + h.weight, 0);
      const byProvider = capacity.held
        .filter((h) => h.provider === member.provider)
        .reduce((n, h) => n + h.weight, 0);
      // Queued members hold no capacity; they start when a slot frees.
      if (held + 1 > capacity.total || byProvider + 1 > capacity.perProvider)
        break;
      const assignment = this.repo.require<
        Parameters<typeof modelEvidence>[0] & {
          id: string;
          revision: number;
        }
      >(kinds.assignment, member.assignmentId);
      if (assignment.revision !== member.assignmentRevision) {
        return this.saveIntake(intake, {
          stage: "stale",
          detail:
            "A coordinator's assignment changed after this message froze its inputs.",
        });
      }
      const launchId =
        member.launchId ??
        `${intake.id}:${member.memberId}:${member.attemptIds.length + 1}`;
      intake = this.saveIntake(intake, {
        members: intake.members.map((m) =>
          m.memberId === member.memberId ? { ...m, launchId } : m,
        ),
      });
      const endorsement = member.phase === "endorsement";
      const turn: MemberTurn = {
        launchId,
        projectId: intake.projectId,
        // Each intake reads its own context: the accepted result, or the
        // project folder as it is now.
        goalId: `session:${intake.sessionId}:${intake.id}`,
        roundId: intake.id,
        roleId: "coordinator",
        memberId: member.memberId,
        assignment: assignment as never,
        purpose: endorsement
          ? "coordinator-endorsement"
          : "coordinator-contribution",
        phase: member.phase === "wording" ? "reconciliation" : member.phase,
        prompt: this.prompt(intake, member),
        inputDigest: intake.inputDigest,
        candidateId: null,
        permittedOutputs: [],
        retryOfAttemptId: member.attemptIds.at(-1) ?? null,
        protocol: endorsement
          ? { kind: "coordinator-v1", stage: null, mode: null }
          : {
              kind: "session-v1",
              stage: member.phase === "wording" ? "wording" : "intake",
              mode: null,
            },
        contextCandidateId:
          this.require(intake.sessionId).acceptedCheckpoint?.candidateId ??
          null,
      };
      let attemptId: string | null = null;
      let error: string | null = null;
      try {
        attemptId = (await this.driver.launch(turn)).attemptId;
      } catch (e) {
        // A launch that recorded an attempt is adopted, never dispatched twice.
        attemptId = this.driver.findLaunch(launchId);
        error = safeError(e);
      }
      const latest = this.repo.require<SessionIntake>(kinds.intake, intake.id);
      intake = this.saveIntake(latest, {
        members: latest.members.map((m) => {
          if (m.memberId !== member.memberId) return m;
          if (attemptId)
            return {
              ...m,
              state: "running",
              activeAttemptId: attemptId,
              attemptIds: [...new Set([...m.attemptIds, attemptId])],
              detail: "",
            };
          return m.retries < MEMBER_RETRIES
            ? {
                ...m,
                launchId: null,
                retries: m.retries + 1,
                detail: `${m.memberId} did not start: ${error}`,
              }
            : {
                ...m,
                state: "failed",
                launchId: null,
                detail: `${m.memberId} did not start: ${error}`,
              };
        }),
      });
    }
    return intake;
  }

  private collect(intake: SessionIntake): SessionIntake {
    let changed = false;
    const members = intake.members.map((m) => {
      if (m.state !== "running" || !m.activeAttemptId) return m;
      const obs = this.driver.observe(m.activeAttemptId);
      if (obs.state === "running" || !obs.quiescent) return m;
      changed = true;
      if (obs.state !== "completed") {
        return m.retries < MEMBER_RETRIES
          ? {
              ...m,
              state: "queued" as const,
              launchId: null,
              activeAttemptId: null,
              retries: m.retries + 1,
              detail: obs.error ?? `The attempt ended ${obs.state}.`,
            }
          : {
              ...m,
              state: "failed" as const,
              activeAttemptId: null,
              detail: obs.error ?? `The attempt ended ${obs.state}.`,
            };
      }
      const contribution = this.contribution(intake, m, m.activeAttemptId, obs);
      const valid = contribution.valid;
      return {
        ...m,
        state: valid
          ? ("returned" as const)
          : m.retries < MEMBER_RETRIES
            ? ("queued" as const)
            : ("invalid" as const),
        launchId: valid ? m.launchId : null,
        activeAttemptId: null,
        retries: valid ? m.retries : m.retries + 1,
        detail: valid ? "" : contribution.reason,
        contributions: [...m.contributions, contribution],
      };
    });
    return changed ? this.saveIntake(intake, { members }) : intake;
  }

  private contribution(
    intake: SessionIntake,
    member: IntakeMember,
    attemptId: string,
    obs: ReturnType<OrchestrationDriver["observe"]>,
  ): IntakeContribution {
    const base = {
      id: `${intake.id}:${member.memberId}:${member.contributions.length + 1}`,
      phase: member.phase,
      attemptId,
      reportedModel: obs.reportedModel,
      at: now(),
    };
    const evidence = modelEvidence(
      {
        model: member.model,
        effort: null,
        modelEvidencePolicy: "verified",
      },
      { model: obs.reportedModel, effort: null },
    );
    if (!evidence.satisfies)
      return { ...base, output: null, valid: false, reason: evidence.detail };
    if (member.phase === "endorsement") {
      const parsed = parseFinal(endorsementSchema, obs.finalText);
      if (!parsed.ok)
        return { ...base, output: null, valid: false, reason: parsed.reason };
      if (parsed.value.candidateDigest !== intake.candidate?.digest)
        return {
          ...base,
          output: parsed.value,
          valid: false,
          reason: "The endorsement names another decision.",
        };
      return { ...base, output: parsed.value, valid: true, reason: "" };
    }
    const parsed = parseSessionTurn(
      obs.finalText,
      member.phase === "wording" ? "wording" : "intake",
      intake.inputDigest,
    );
    if (!parsed.ok)
      return { ...base, output: null, valid: false, reason: parsed.reason };
    return { ...base, output: parsed.value, valid: true, reason: "" };
  }

  private phaseSettled(intake: SessionIntake): boolean {
    return intake.members.every(
      (m) => !["queued", "running"].includes(m.state),
    );
  }

  /** Moves an intake on: launches, collects, decides. */
  private async advance(intake: SessionIntake): Promise<void> {
    const session = this.require(intake.sessionId);
    if (intake.controlGeneration !== session.controlGeneration) {
      await this.interruptIntake(intake, "The session was paused or stopped.");
      return;
    }
    if (intake.configurationRevision !== session.revision) {
      await this.interruptIntake(
        intake,
        "The session's configuration changed while coordinators were answering.",
        "stale",
      );
      if (intake.restarts < INTAKE_RESTARTS)
        this.freezeIntake(session, {
          ...intake,
          restarts: intake.restarts + 1,
        });
      else
        await this.orchestrator.note({
          conversationId: session.conversationId,
          role: "service",
          text: "The team changed again while coordinators were answering. Send the message again.",
          routing: { kind: "session", goalId: null },
          intakeId: intake.id,
          commandId: `${intake.id}:stale-note`,
        });
      this.changed();
      return;
    }
    intake = this.collect(intake);
    intake = await this.launch(intake);
    if (!openIntakeStages.includes(intake.stage)) return;
    if (!this.phaseSettled(intake)) return;
    await this.settlePhase(intake);
  }

  private async interruptIntake(
    intake: SessionIntake,
    detail: string,
    stage: SessionIntake["stage"] = "stopped",
  ) {
    for (const m of intake.members)
      if (m.activeAttemptId) await this.driver.interrupt(m.activeAttemptId);
    this.saveIntake(intake, {
      stage,
      detail,
      members: intake.members.map((m) =>
        ["queued", "running"].includes(m.state)
          ? { ...m, state: "stopped" as const, activeAttemptId: null }
          : m,
      ),
    });
  }

  private async settlePhase(intake: SessionIntake) {
    // A wording turn comes last; an endorsement phase follows a candidate.
    const current = intake.members.map((m) => m.phase);
    if (current.includes("wording")) return this.finishWording(intake);
    if (intake.stage === "endorsing" && current.includes("endorsement"))
      return this.finishEndorsement(intake);
    const answers = this.answers(intake);
    if (!answers.length) {
      const reasons = intake.members
        .map((m) => `${m.memberId}: ${m.detail}`)
        .join(" ");
      return this.finish(intake, { kind: "failed", reason: reasons }, null);
    }
    const decision = decidePeers({
      answers,
      mode: intake.mode,
      targetActive: this.targetActive(intake),
      reconciliationLeft:
        answers.length > 1 && intake.reconciliationUsed < RECONCILIATION_ROUNDS,
    });
    return this.apply(intake, decision, answers);
  }

  private async apply(
    intake: SessionIntake,
    decision: PeerDecision,
    answers: PeerAnswer[],
  ) {
    if (decision.kind === "reconcile") {
      const valid = new Set(answers.map((a) => a.memberId));
      this.saveIntake(intake, {
        stage: "reconciling",
        reconciliationUsed: intake.reconciliationUsed + 1,
        detail: "The coordinators answered differently; reconciling once.",
        members: intake.members.map((m) =>
          valid.has(m.memberId)
            ? {
                ...m,
                phase: "reconciliation",
                state: "queued",
                launchId: null,
                retries: 0,
              }
            : m,
        ),
      });
      this.changed();
      return;
    }
    if (decision.kind === "alternatives")
      return this.offer(intake, decision.options);
    if (decision.kind === "candidate" && decision.endorsers.length) {
      const endorsers = new Set(decision.endorsers);
      this.saveIntake(intake, {
        stage: "endorsing",
        candidate: {
          intent: decision.intent,
          team: decision.team,
          digest: decision.digest,
          proposedBy: decision.implied,
        },
        detail: `${decision.endorsers.length} ${decision.endorsers.length === 1 ? "coordinator endorses" : "coordinators endorse"} the decision.`,
        members: intake.members.map((m) =>
          endorsers.has(m.memberId)
            ? {
                ...m,
                phase: "endorsement",
                state: "queued",
                launchId: null,
                retries: 0,
              }
            : m,
        ),
      });
      this.changed();
      return;
    }
    const outcome: IntakeOutcome =
      decision.kind === "reply"
        ? { kind: "reply", intent: decision.intent, views: decision.views }
        : {
            kind: "act",
            intent: decision.intent,
            team: decision.team,
            endorsedBy: decision.implied,
            workItemId: null,
            goalId: null,
          };
    return this.word(intake, outcome, answers, decision);
  }

  private async finishEndorsement(intake: SessionIntake) {
    const candidate = intake.candidate!;
    const stances = intake.members
      .filter((m) => m.phase === "endorsement")
      .map((m) => {
        const c = [...m.contributions]
          .reverse()
          .find((x) => x.phase === "endorsement" && x.valid);
        return {
          memberId: m.memberId,
          stance:
            (c?.output as { stance?: string } | undefined)?.stance ?? "missing",
          rationale:
            (c?.output as { rationale?: string } | undefined)?.rationale ??
            m.detail,
        };
      });
    const challenged = stances.filter(
      (s) => s.stance === "challenge" || s.stance === "missing",
    );
    const answers = this.answers(intake);
    if (challenged.length) {
      if (intake.reconciliationUsed < RECONCILIATION_ROUNDS) {
        const valid = new Set(answers.map((a) => a.memberId));
        this.saveIntake(intake, {
          stage: "reconciling",
          candidate: null,
          reconciliationUsed: intake.reconciliationUsed + 1,
          detail: `${challenged.map((c) => c.memberId).join(", ")} challenged the decision; reconciling once.`,
          members: intake.members.map((m) =>
            valid.has(m.memberId)
              ? {
                  ...m,
                  phase: "reconciliation",
                  state: "queued",
                  launchId: null,
                  retries: 0,
                }
              : m,
          ),
        });
        this.changed();
        return;
      }
      const decision = decidePeers({
        answers,
        mode: intake.mode,
        targetActive: this.targetActive(intake),
        reconciliationLeft: false,
      });
      const options =
        decision.kind === "alternatives"
          ? decision.options
          : [
              {
                intent: candidate.intent,
                team: candidate.team,
                memberIds: candidate.proposedBy,
                summary:
                  answers
                    .find((a) => a.memberId === candidate.proposedBy[0])
                    ?.value.reply.slice(0, 600) ?? "",
              },
              ...challenged.map((c) => ({
                intent: "discuss" as const,
                team: null,
                memberIds: [c.memberId],
                summary: `Do not act yet: ${c.rationale}`.slice(0, 600),
              })),
            ];
      return this.offer(intake, options);
    }
    const outcome: IntakeOutcome = {
      kind: "act",
      intent: candidate.intent,
      team: candidate.team,
      endorsedBy: [
        ...candidate.proposedBy,
        ...stances.filter((s) => s.stance === "endorse").map((s) => s.memberId),
      ],
      workItemId: null,
      goalId: null,
    };
    return this.word(intake, outcome, answers, null);
  }

  /** With peers, the first configured coordinator prepares the shared wording. */
  private async word(
    intake: SessionIntake,
    outcome: IntakeOutcome,
    answers: PeerAnswer[],
    decision: PeerDecision | null,
  ) {
    const first = [...answers].sort((a, b) => a.order - b.order)[0];
    if (answers.length > 1) {
      this.saveIntake(intake, {
        stage: "endorsing",
        outcome,
        detail: `${first.memberId} prepares the shared response.`,
        members: intake.members.map((m) =>
          m.memberId === first.memberId
            ? {
                ...m,
                phase: "wording",
                state: "queued",
                launchId: null,
                retries: 0,
              }
            : m,
        ),
      });
      this.changed();
      return;
    }
    const reply = sharedReply(
      answers,
      decision ?? { kind: "reply", intent: "discuss", views: [] },
    );
    return this.finish(intake, outcome, reply);
  }

  private async finishWording(intake: SessionIntake) {
    const writer = intake.members.find((m) => m.phase === "wording")!;
    const wording = [...writer.contributions]
      .reverse()
      .find((c) => c.phase === "wording" && c.valid);
    const answers = this.answers(intake);
    const outcome = intake.outcome!;
    const reply =
      (wording?.output as { reply?: string } | undefined)?.reply ??
      sharedReply(
        answers,
        outcome.kind === "reply"
          ? { kind: "reply", intent: outcome.intent, views: outcome.views }
          : { kind: "reply", intent: "discuss", views: [] },
      );
    return this.finish(intake, outcome, reply);
  }

  private async offer(intake: SessionIntake, options: IntakeAlternative[]) {
    const session = this.require(intake.sessionId);
    const outcome: IntakeOutcome = {
      kind: "alternatives",
      options,
      chosen: null,
    };
    const text = [
      "The coordinators did not agree after one reconciliation round. Choose how to continue:",
      ...options.map(
        (o, i) =>
          `${i + 1}. ${label(o.intent)} (${o.memberIds.join(", ")}): ${o.summary}`,
      ),
    ].join("\n");
    const message = await this.orchestrator.note({
      conversationId: session.conversationId,
      role: "coordinator",
      text,
      routing: { kind: "session", goalId: intake.targetGoalId },
      intakeId: intake.id,
      commandId: `${intake.id}:alternatives`,
    });
    this.saveIntake(intake, {
      stage: "awaiting-user",
      outcome,
      replyMessageId: message.id,
      detail: "Waiting for you to choose.",
    });
    this.attend(session.id, "choose-alternative", "The coordinators disagree.");
    this.changed();
  }

  /** The owner picks one of the coordinators' alternatives. */
  async choose(input: {
    sessionId: string;
    intakeId: string;
    option: number;
    commandId: string;
  }) {
    const session = this.require(input.sessionId);
    return this.repo.receipt(
      input.commandId,
      session.projectId,
      "session-choose",
      async () => {
        const intake = this.repo.require<SessionIntake>(
          kinds.intake,
          input.intakeId,
        );
        if (
          intake.sessionId !== session.id ||
          intake.stage !== "awaiting-user" ||
          intake.outcome?.kind !== "alternatives"
        )
          throw new Error("This decision is no longer waiting for you.");
        if (
          intake.controlGeneration !==
          this.require(session.id).controlGeneration
        )
          throw new Error(
            "The session was paused or stopped since; send the message again.",
          );
        const option = intake.outcome.options[input.option];
        if (!option) throw new Error("Choose one of the listed options.");
        const acting =
          option.intent === "steer" || option.intent === "new-work";
        const intent: "steer" | "new-work" =
          option.intent === "steer" && this.targetActive(intake)
            ? "steer"
            : "new-work";
        const outcome: IntakeOutcome = acting
          ? {
              kind: "act",
              intent,
              team: option.team,
              endorsedBy: ["local-user"],
              workItemId: null,
              goalId: null,
            }
          : { kind: "reply", intent: "discuss", views: [] };
        const chosen = this.saveIntake(intake, {
          outcome: { ...intake.outcome, chosen: input.option },
        });
        this.attend(session.id, null);
        await this.finish(
          chosen,
          outcome,
          `You chose: ${label(option.intent)} (${option.memberIds.join(", ")}).`,
          true,
        );
        return this.repo.require<SessionIntake>(kinds.intake, intake.id);
      },
    );
  }

  /** Records the shared response and carries out the decision. */
  private async finish(
    intake: SessionIntake,
    outcome: IntakeOutcome,
    reply: string | null,
    service = false,
  ) {
    const session = this.require(intake.sessionId);
    if (outcome.kind === "act") {
      if (outcome.team?.length) this.organize(session, intake, outcome.team);
      if (outcome.intent === "steer" && intake.targetGoalId) {
        try {
          this.membership(
            intake.projectId,
            intake.targetGoalId,
            intake.text,
            intake.messageId,
            `${intake.id}:membership`,
          );
          await this.orchestrator.steer({
            goalId: intake.targetGoalId,
            text: intake.text,
            commandId: `${intake.id}:steer`,
          });
          outcome = { ...outcome, goalId: intake.targetGoalId };
        } catch (error) {
          outcome = { kind: "failed", reason: safeError(error) };
        }
      } else if (outcome.intent === "new-work") {
        const latest = this.require(session.id);
        const item: SessionWorkItem = {
          ...this.item(intake.text, intake.kind, intake.checks),
          messageId: intake.messageId,
          intakeId: intake.id,
        };
        this.save(latest, { queue: [...latest.queue, item] });
        outcome = { ...outcome, workItemId: item.id };
      }
    }
    const message =
      outcome.kind === "failed"
        ? await this.orchestrator.note({
            conversationId: session.conversationId,
            role: "service",
            text: `The coordinators could not answer: ${outcome.reason}`,
            routing: { kind: "session", goalId: intake.targetGoalId },
            intakeId: intake.id,
            commandId: `${intake.id}:failed`,
          })
        : reply
          ? await this.orchestrator.note({
              conversationId: session.conversationId,
              role: service ? "service" : "coordinator",
              text: reply,
              routing: {
                kind: "session",
                goalId:
                  outcome.kind === "act" ? outcome.goalId : intake.targetGoalId,
              },
              intakeId: intake.id,
              commandId: `${intake.id}:reply`,
            })
          : null;
    const latest = this.repo.require<SessionIntake>(kinds.intake, intake.id);
    this.saveIntake(latest, {
      stage: outcome.kind === "failed" ? "failed" : "decided",
      outcome:
        latest.outcome?.kind === "alternatives" && outcome.kind !== "failed"
          ? { ...latest.outcome }
          : outcome,
      replyMessageId: message?.id ?? latest.replyMessageId,
      detail: describe(outcome),
      // The decision taken, kept with an owner's choice of alternatives.
      ...(latest.outcome?.kind === "alternatives"
        ? {
            candidate:
              outcome.kind === "act"
                ? {
                    intent: outcome.intent,
                    team: outcome.team,
                    digest: decisionDigest(outcome.intent, outcome.team),
                    proposedBy: outcome.endorsedBy,
                  }
                : null,
          }
        : {}),
    });
    await this.schedule(this.require(session.id));
    this.changed();
  }

  /**
   * The owner's own team instructions in the message ("review with Fable
   * and Sol") apply to the goal it steers or starts, as owner settings. An
   * instruction naming an unknown role is reported, never guessed.
   */
  private membership(
    projectId: string,
    goalId: string,
    text: string,
    messageId: string,
    commandId: string,
  ) {
    try {
      this.orchestrator.applyMessageMembership({
        projectId,
        goalId,
        text,
        messageId,
        commandId,
      });
    } catch (error) {
      const goal = this.repo.get<Goal>(kinds.goal, goalId);
      if (goal)
        void this.orchestrator.note({
          conversationId: goal.conversationId,
          role: "service",
          text: `A team instruction in your message was not applied: ${safeError(error)}`,
          routing: { kind: "session", goalId },
          commandId: `${commandId}:refused`,
        });
    }
  }

  /**
   * Applies an endorsed team proposal as automatic settings: they fill only
   * fields the owner left open. Like configuration, a change waits for the
   * active goal's open round to finish.
   */
  private organize(
    session: TopslSession,
    intake: SessionIntake,
    proposal: SessionTeamProposal,
  ) {
    const all = this.repo.roles(session.projectId);
    const foreign = proposal.filter((r) => {
      const owner = all.find((x) => x.id === r.roleId)?.ownerConversationId;
      return owner && owner !== session.id;
    });
    const usable = proposal.filter((r) => !foreign.includes(r));
    const result = organizeSessionTeam({
      proposal: usable,
      teamMode: session.configuration.team,
      catalog: this.repo
        .visibleRoles(session.projectId, session.id)
        .map((r) => ({ id: r.id, purpose: r.purpose })),
      roster: Object.keys(session.configuration.roles),
      group: (roleId) => {
        try {
          return this.orchestrator.effective(
            session.projectId,
            null,
            roleId,
            null,
            {
              scopeId: `session:${session.id}`,
              conversationId: session.id,
            },
          );
        } catch {
          return null;
        }
      },
      routes: this.driver.routes(session.projectId),
      limit: this.repo.policy(session.projectId).maxMembersPerRole,
      reference: intake.id,
    });
    for (const c of result.created)
      if (!this.repo.get(kinds.role, `${session.projectId}:${c.roleId}`))
        this.repo.saveRevisioned(
          kinds.role,
          roleDefinitionFor({
            projectId: session.projectId,
            roleId: c.roleId,
            title: c.title,
            instructions: c.instructions,
            purpose: c.purpose,
            ownerConversationId: session.id,
          }),
        );
    const latest = this.require(session.id);
    const automatic = {
      revision: latest.automatic.revision + 1,
      roles: { ...latest.automatic.roles, ...result.roles },
      activeRoles:
        latest.configuration.team === "automatic"
          ? [
              ...new Set([
                ...(latest.automatic.activeRoles ?? []),
                ...result.activeRoles,
              ]),
            ]
          : latest.automatic.activeRoles,
      intakeId: intake.id,
      rejections: [
        ...foreign.map(
          (r) =>
            `Role ${r.roleId} belongs to another session; it was not used.`,
        ),
        ...result.rejections,
      ],
    };
    if (this.openRound(latest))
      this.save(latest, { pendingAutomatic: automatic });
    else this.save(latest, { automatic });
  }

  // -------------------------------------------------------------------------
  // The queue

  /** Keeps work items in step with their goals and runs, and the accepted result. */
  private sync(session: TopslSession): TopslSession {
    let dirty = this.discover(session);
    const runs = this.runs(session.projectId);
    const queue = session.queue.map((w) => {
      if (w.state !== "running") return w;
      if (w.kind === "goal" && w.goalId) {
        const goal = this.repo.get<Goal>(kinds.goal, w.goalId);
        const settled = goal ? settledWorkState(goal) : "stopped";
        if (!settled) return w;
        dirty = true;
        if (settled === "accepted" && goal?.acceptance)
          session.acceptedCheckpoint = {
            candidateId: goal.acceptance.candidateId,
            goalId: goal.id,
            runId: null,
            workItemId: w.id,
            at: goal.acceptance.at,
          };
        return { ...w, state: settled, updatedAt: now() };
      }
      if (w.kind === "loop" && w.runId) {
        const run = runs.find((r) => r.id === w.runId);
        if (run && !["stopped", "completed"].includes(run.state)) return w;
        dirty = true;
        if (run?.acceptedCandidateId)
          session.acceptedCheckpoint = {
            candidateId: run.acceptedCandidateId,
            goalId: null,
            runId: run.id,
            workItemId: w.id,
            at: now(),
          };
        return {
          ...w,
          state:
            run?.state === "completed"
              ? ("completed" as const)
              : ("stopped" as const),
          updatedAt: now(),
        };
      }
      return w;
    });
    // A loop the owner started counts as the session's running work; a
    // draft stopped before it started leaves the queue.
    for (const [i, w] of queue.entries())
      if (w.kind === "loop" && w.state === "queued") {
        const run = runs.find((r) => r.id === w.runId);
        if (run?.started) {
          queue[i] = { ...w, state: "running", updatedAt: now() };
          dirty = true;
        } else if (
          run &&
          (run.state === "stopped" || run.desiredState === "stopped")
        ) {
          queue[i] = {
            ...w,
            state: "cancelled",
            detail: "The loop was stopped before it started.",
            updatedAt: now(),
          };
          dirty = true;
        }
      }
    const active = queue.find((w) => w.id === session.activeWorkId);
    const activeWorkId =
      active && active.state === "running" ? active.id : null;
    if (activeWorkId !== session.activeWorkId) dirty = true;
    if (!dirty) return session;
    return this.save(session, { queue, activeWorkId });
  }

  /** Starts the next queued goal when nothing in the session is running. */
  private async schedule(session: TopslSession) {
    if (session.control !== "running") return;
    // One goal or loop at a time: a running legacy goal or loop also waits.
    if (session.queue.some((w) => w.state === "running")) return;
    const next = nextWorkItem(session);
    if (!next || next.kind !== "goal") return;
    const fn = sessionFunctions({
      session,
      roles: this.repo.visibleRoles(session.projectId, session.id),
      goalKind: next.goalKind,
    });
    if ("missing" in fn) {
      const detail = `This work needs ${fn.missing.join(" and ")} in the custom team.`;
      if (next.state !== "waiting-configuration") {
        this.save(session, {
          queue: session.queue.map((w) =>
            w.id === next.id
              ? { ...w, state: "waiting-configuration", detail }
              : w,
          ),
          attention: { kind: "configure-team", detail },
        });
        await this.orchestrator.note({
          conversationId: session.conversationId,
          role: "service",
          text: `${detail} Add the role in the Team pane (or switch the team to Automatic); the work starts once it can run.`,
          routing: { kind: "session", goalId: null },
          commandId: `${next.id}:configure`,
        });
      }
      return;
    }
    const goalId = `${next.id}-goal`;
    let baseline: string | null = null;
    try {
      if (session.acceptedCheckpoint && next.goalKind === "code") {
        if (!this.driver.continueFrom)
          throw new Error("No route can continue from the accepted result.");
        baseline = await this.driver.continueFrom({
          projectId: session.projectId,
          goalId,
          candidateId: session.acceptedCheckpoint.candidateId,
        });
      }
      const recent = this.intakes(session.id)
        .filter((i) => i.outcome?.kind === "act")
        .slice(-3)
        .map((i) => `Earlier in this session: ${i.text.slice(0, 300)}`);
      await this.orchestrator.createGoal({
        conversationId: session.conversationId,
        objective: next.objective,
        kind: next.goalKind,
        checks: next.checks,
        constraints: recent.filter(
          (r) => !r.endsWith(next.objective.slice(0, 300)),
        ),
        commandId: `${next.id}:goal`,
        goalId,
        functions: fn.functions,
        ...(baseline ? { baselineCandidateId: baseline } : {}),
        message: false,
        session: { workItemId: next.id, continued: !!baseline },
        ...(session.reference
          ? {
              reference: {
                id: session.reference.id,
                digest: session.reference.digest,
              },
            }
          : {}),
      });
      if (next.messageId)
        this.membership(
          session.projectId,
          goalId,
          next.objective,
          next.messageId,
          `${next.id}:membership`,
        );
      const latest = this.require(session.id);
      this.save(latest, {
        activeWorkId: next.id,
        queue: latest.queue.map((w) =>
          w.id === next.id
            ? {
                ...w,
                state: "running",
                goalId,
                baselineCandidateId: baseline,
                detail: baseline
                  ? "Continues from the session's accepted result."
                  : "Starts from the project folder.",
                updatedAt: now(),
              }
            : w,
        ),
        attention:
          latest.attention?.kind === "configure-team" ? null : latest.attention,
      });
    } catch (error) {
      const latest = this.require(session.id);
      this.save(latest, {
        queue: latest.queue.map((w) =>
          w.id === next.id
            ? { ...w, detail: `Could not start: ${safeError(error)}` }
            : w,
        ),
      });
    }
    this.changed();
  }

  /** Reorders or removes queued work. Running work keeps its own controls. */
  async queue(input: {
    sessionId: string;
    workItemId: string;
    action: "remove" | "up" | "down";
    commandId: string;
  }) {
    const session = this.require(input.sessionId);
    return this.serial(session.id, () =>
      this.repo.receipt(
        input.commandId,
        session.projectId,
        "session-queue",
        async () => {
          // A loop that started meanwhile is running work, not queued.
          const latest = this.sync(this.require(input.sessionId));
          const index = latest.queue.findIndex(
            (w) => w.id === input.workItemId,
          );
          const item = latest.queue[index];
          if (
            !item ||
            !["queued", "waiting-configuration"].includes(item.state)
          )
            throw new Error("Only queued work can be reordered or removed.");
          const queue = [...latest.queue];
          if (input.action === "remove")
            queue[index] = { ...item, state: "cancelled", updatedAt: now() };
          else {
            const open = queue
              .map((w, i) => ({ w, i }))
              .filter(({ w }) =>
                ["queued", "waiting-configuration"].includes(w.state),
              );
            const at = open.findIndex(({ i }) => i === index);
            const swap = open[at + (input.action === "up" ? -1 : 1)];
            if (swap) {
              queue[index] = swap.w;
              queue[swap.i] = item;
            }
          }
          let next = this.save(latest, { queue });
          // A removed loop's draft is stopped, so it cannot start later.
          if (input.action === "remove" && item.kind === "loop" && item.runId) {
            await this.loops?.stop(item.runId, `${input.commandId}:loop`);
            next = this.require(input.sessionId);
          }
          this.changed();
          return next;
        },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Controls

  /**
   * Pause, resume or stop the session. Pause and stop reach its running goal
   * and open intakes; stop also cancels queued work and stops a running loop
   * of the session. Goals keep their own controls.
   */
  async control(input: {
    sessionId: string;
    action: "pause" | "resume" | "stop";
    commandId: string;
  }) {
    const session = this.require(input.sessionId);
    return this.serial(session.id, () =>
      this.repo.receipt(
        input.commandId,
        session.projectId,
        `session-${input.action}`,
        async () => {
          let latest = this.save(this.sync(this.require(input.sessionId)), {
            control: input.action === "pause" ? "paused" : "running",
            controlGeneration:
              this.require(input.sessionId).controlGeneration + 1,
          });
          const goalId = this.activeGoalId(latest);
          const goal = goalId ? this.repo.get<Goal>(kinds.goal, goalId) : null;
          if (goal && !endedGoalStates.includes(goal.state)) {
            const action =
              input.action === "resume"
                ? goal.state === "paused"
                  ? "resume"
                  : null
                : input.action;
            if (action)
              await this.orchestrator.controlCommand({
                projectId: latest.projectId,
                goalId: goal.id,
                action,
                commandId: `${input.commandId}:goal`,
              });
          }
          // A running loop of the session pauses and resumes with it; a draft
          // is never started by Resume.
          const loopItem = latest.queue.find(
            (w) => w.kind === "loop" && w.runId && w.state === "running",
          );
          const loopRun = loopItem
            ? this.runs(latest.projectId).find((r) => r.id === loopItem.runId)
            : undefined;
          // A run already stopping or finished takes no pause or resume.
          if (
            loopItem?.runId &&
            loopRun &&
            !["stopped", "completed"].includes(loopRun.state) &&
            loopRun.desiredState !== "stopped" &&
            input.action !== "stop" &&
            this.loops?.control
          )
            await this.loops.control(
              loopItem.runId,
              input.action,
              `${input.commandId}:loop:${loopItem.runId}`,
            );
          for (const intake of this.intakes(latest.id).filter((i) =>
            openIntakeStages.includes(i.stage),
          ))
            if (input.action !== "resume")
              await this.interruptIntake(
                intake,
                `The session was ${input.action === "stop" ? "stopped" : "paused"}.`,
              );
          if (input.action === "stop") {
            latest = this.require(latest.id);
            // Running loops stop, and queued loop drafts are stopped too.
            for (const w of latest.queue)
              if (
                w.kind === "loop" &&
                w.runId &&
                ["running", "queued", "waiting-configuration"].includes(
                  w.state,
                ) &&
                this.loops
              )
                await this.loops.stop(
                  w.runId,
                  `${input.commandId}:loop:${w.runId}`,
                );
            latest = this.require(latest.id);
            latest = this.save(latest, {
              queue: latest.queue.map((w) =>
                ["queued", "waiting-configuration"].includes(w.state)
                  ? {
                      ...w,
                      state: "cancelled",
                      detail: "Cancelled when the session stopped.",
                      updatedAt: now(),
                    }
                  : w,
              ),
              attention: null,
            });
            for (const intake of this.intakes(latest.id).filter(
              (i) => i.stage === "awaiting-user",
            ))
              this.saveIntake(intake, {
                stage: "stopped",
                detail: "The session was stopped.",
              });
          }
          await this.orchestrator.note({
            conversationId: latest.conversationId,
            role: "service",
            text:
              input.action === "pause"
                ? "Paused this session: its running goal or loop is paused and queued work waits."
                : input.action === "resume"
                  ? "Resumed this session."
                  : "Stopped this session's work. Queued work and loop drafts were cancelled; accepted results and evidence are kept.",
            routing: { kind: "control", goalId: goal?.id ?? null },
            commandId: `${input.commandId}:note`,
          });
          this.changed();
          return this.require(latest.id);
        },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Ticking, recovery and reads

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.runCache = new Map();
    try {
      const sessions = [...this.store.iterate<TopslSession>(kinds.session)];
      for (const value of sessions)
        for (const id of value.openIntakes ?? []) {
          const intake = this.repo.get<SessionIntake>(kinds.intake, id);
          if (!intake || !openIntakeStages.includes(intake.stage)) continue;
          try {
            await this.advance(intake);
          } catch (error) {
            this.saveIntake(intake, { detail: safeError(error) });
          }
        }
      for (const { id } of sessions) {
        let session = this.require(id);
        const still = (session.openIntakes ?? []).filter((i) =>
          openIntakeStages.includes(
            this.repo.get<SessionIntake>(kinds.intake, i)?.stage ?? "stopped",
          ),
        );
        if (still.length !== (session.openIntakes ?? []).length)
          session = this.save(session, { openIntakes: still });
        session = this.sync(session);
        const pendingAutomatic = session.pendingAutomatic;
        if ((session.pending || pendingAutomatic) && !this.openRound(session)) {
          if (session.pending)
            session = this.applyConfiguration(
              session,
              session.pending.configuration,
            );
          if (pendingAutomatic)
            session = this.save(session, {
              automatic: pendingAutomatic,
              pendingAutomatic: null,
            });
          this.changed();
        }
        await this.serial(id, async () => {
          const current = this.require(id);
          await this.reconcileLoops(current);
          await this.schedule(this.require(id));
        });
      }
    } finally {
      this.runCache = null;
      this.ticking = false;
    }
  }

  /**
   * Finishes loop controls a restart cut off: a loop whose work item was
   * removed or cancelled is stopped, and a paused session's running loop is
   * paused. Each repeat uses the same command ID, so it acts once.
   */
  private async reconcileLoops(session: TopslSession) {
    if (session.origin !== "native" || !this.loops) return;
    const runs = this.runs(session.projectId);
    for (const w of session.queue) {
      if (w.kind !== "loop" || !w.runId) continue;
      const run = runs.find((r) => r.id === w.runId);
      if (!run || ["stopped", "completed"].includes(run.state)) continue;
      if (w.state === "cancelled" && run.desiredState !== "stopped")
        await this.loops.stop(run.id, `${w.id}:reconcile-stop`).catch(() => {});
      else if (
        w.state === "running" &&
        session.control === "paused" &&
        run.desiredState === "running" &&
        this.loops.control
      )
        await this.loops
          .control(
            run.id,
            "pause",
            `${w.id}:reconcile-pause:${session.controlGeneration}`,
          )
          .catch(() => {});
    }
  }

  /** Backfills legacy conversations and adopts launches a restart cut off. */
  async recover(): Promise<void> {
    this.backfill();
    // Rebuild each session's open list from the intakes themselves.
    const open = new Map<string, string[]>();
    for (const intake of this.store.iterate<SessionIntake>(kinds.intake))
      if (openIntakeStages.includes(intake.stage))
        open.set(intake.sessionId, [
          ...(open.get(intake.sessionId) ?? []),
          intake.id,
        ]);
    for (const session of [...this.store.iterate<TopslSession>(kinds.session)])
      if (
        stable(session.openIntakes ?? []) !== stable(open.get(session.id) ?? [])
      )
        this.save(session, { openIntakes: open.get(session.id) ?? [] });
    for (const intake of [...this.store.iterate<SessionIntake>(kinds.intake)]) {
      if (!openIntakeStages.includes(intake.stage)) continue;
      this.saveIntake(intake, {
        members: intake.members.map((m) => {
          if (m.state !== "queued" || !m.launchId) return m;
          const attemptId = this.driver.findLaunch(m.launchId);
          return attemptId
            ? {
                ...m,
                state: "running",
                activeAttemptId: attemptId,
                attemptIds: [...new Set([...m.attemptIds, attemptId])],
              }
            : m;
        }),
      });
    }
  }

  list(projectId: string) {
    return this.repo
      .all<TopslSession>(kinds.session, projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** One session for its screen: configuration, queue, intakes and team. */
  query(sessionId: string) {
    const session = this.require(sessionId);
    const scope = {
      scopeId: `session:${session.id}`,
      conversationId: session.id,
    };
    const active = sessionActiveRoles(session);
    const roles = this.repo
      .visibleRoles(session.projectId, session.id)
      .map((role) => {
        const group = this.orchestrator.effective(
          session.projectId,
          null,
          role.id,
          null,
          scope,
        );
        return {
          role,
          group,
          active: !active || active.has(role.id) || role.id === "coordinator",
          owned: role.ownerConversationId === session.id,
          pinned: !!session.configuration.roles[role.id],
          explanation: session.automatic.roles[role.id]?.reason ?? null,
        };
      });
    // A read: the coordinators as they would resolve now, recording nothing.
    const coordinators = resolveGroup({
      role: this.repo.role(session.projectId, "coordinator"),
      group: this.orchestrator.effective(
        session.projectId,
        null,
        "coordinator",
        null,
        scope,
      ),
      pool: this.driver.routes(session.projectId),
      complexity: "simple",
    });
    return {
      session,
      intakes: this.intakes(session.id).slice(-50),
      roles,
      coordinators: coordinators.assignments.map((a) => ({
        memberId: a.memberId,
        status: a.status,
        selection: a.selection,
        provider: a.provider,
        model: a.model,
        effort: a.effort,
        reason: a.reason,
      })),
      coordinatorConflicts: coordinators.conflicts,
      functions: sessionFunctions({
        session,
        roles: this.repo.visibleRoles(session.projectId, session.id),
        goalKind: "code",
      }),
    };
  }

  /**
   * Resolves a saved thread ID: a goal thread opens its conversation's
   * session; a loop run opens its own view, with the session it belongs to.
   */
  resolveThread(threadId: string): {
    threadId: string;
    sessionId: string | null;
    workItemId: string | null;
  } | null {
    const match = /^(goal|loop|session):(.+)$/.exec(threadId);
    if (!match) return null;
    const [, kind, id] = match;
    if (kind === "loop") {
      const run = this.loops
        ? this.store.get<{ conversationId: string; projectId: string }>(
            "loop-run",
            id,
          )
        : null;
      const session = run
        ? this.repo.get<TopslSession>(kinds.session, run.conversationId)
        : null;
      return {
        threadId,
        sessionId: session?.id ?? null,
        workItemId: session?.queue.find((w) => w.runId === id)?.id ?? null,
      };
    }
    if (!this.repo.get(kinds.conversation, id)) return null;
    const session = this.require(id);
    return {
      threadId: `session:${id}`,
      sessionId: session.id,
      workItemId: null,
    };
  }
}

const label = (intent: string) =>
  ({
    discuss: "Discuss",
    status: "Status",
    steer: "Steer the current goal",
    "new-work": "Queue new work",
    clarify: "Clarify first",
  })[intent] ?? intent;

function describe(outcome: IntakeOutcome): string {
  switch (outcome.kind) {
    case "reply":
      return outcome.intent === "clarify"
        ? "The coordinators asked a question."
        : "Answered without starting work.";
    case "act":
      return outcome.intent === "steer"
        ? "Steered the current goal."
        : "Queued as new work.";
    case "alternatives":
      return "Waiting for you to choose.";
    case "failed":
      return outcome.reason;
  }
}

function describeOutcome(intake: SessionIntake): string {
  return intake.outcome
    ? describe(intake.outcome)
    : "Answer without starting work.";
}

/** Coordinator member IDs in configured order. */
function numbered(members: SessionConfiguration["coordinators"]) {
  const used = new Set<string>();
  return members.map((m, i) => {
    let memberId = m.memberId || `coordinator-${i + 1}`;
    if (used.has(memberId)) memberId = `coordinator-${i + 1}`;
    used.add(memberId);
    return { ...m, memberId };
  });
}
