import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type { Evidence } from "../domain/workflow";
import type {
  AggregatedFinding,
  ControlEvent,
  CoordinatorConversation,
  CoordinatorMessage,
  CoordinatorPlan,
  DecisionCandidate,
  DecisionEndorsement,
  EffectiveRoleGroup,
  ExecutionPurpose,
  FindingObservation,
  Goal,
  GoalGrant,
  GroupScopeLevel,
  ParticipantContribution,
  PlanTaskAction,
  QueuedPlanAction,
  ResolvedMemberAssignment,
  RoleCompletion,
  RoleDefinition,
  RoleGroupRevision,
  RoleGroupSettings,
  RoleRound,
  RoundKind,
  RoundMember,
} from "../domain/role-groups";
import type { Store } from "../persistence/store";
import { OrchestrationRepository, kinds } from "./repository";
import { customRoleDefinition } from "./roles";
import { builtInRoles } from "../domain/role-groups";
import {
  effectiveGroup,
  goalComplexity,
  layersFor,
  legacyDraftGroups,
  parseMembership,
  presetGroups,
} from "./membership";
import type { WorkflowDraft } from "../domain/workflow-drafts";
import { modelEvidence, resolveGroup, type RouteCandidate } from "./selection";
import {
  aggregateFindings,
  blockingDispositions,
  countsFor,
  evaluateDecision,
  freezePolicy,
  participation,
  policyDigest,
  reviewStatus,
} from "./policy";
import { admit, memberWeight, type CapacityView } from "./schedule";
import {
  candidateDigest,
  combineProposals,
  coordinatorPrompt,
  coordinatorProposalSchema,
  endorsementPrompt,
  endorsementSchema,
  implementationSummarySchema,
  informationSchema,
  normalizeAction,
  parseFinal,
  reconciliationPrompt,
  reviewPrompt,
  validateActions,
  workPrompt,
  actionDigest,
  actionSetDigest,
} from "./contracts";
import { reviewSchema } from "../workflows/builder-reviewer";

/** One member turn the engine asks a driver to run. */
export interface MemberTurn {
  launchId: string;
  projectId: string;
  goalId: string;
  roundId: string;
  roleId: string;
  memberId: string;
  assignment: ResolvedMemberAssignment;
  purpose: ExecutionPurpose;
  phase: RoundMember["phase"];
  prompt: string;
  inputDigest: string;
  /** Review: the candidate under review. Implementation: the baseline to start from. */
  candidateId: string | null;
  permittedOutputs: string[];
  retryOfAttemptId: string | null;
}

export interface AttemptObservation {
  state: "running" | "completed" | "failed" | "interrupted" | "uncertain";
  /** Owned processes and descendants were observed stopped or explicitly reconciled. */
  quiescent: boolean;
  /** The member's final assistant message only. */
  finalText: string | null;
  reportedModel: string | null;
  reportedEffort: string | null;
  /** Implementation: the candidate captured from the member's workspace. */
  candidateId?: string | null;
  error?: string | null;
  evidence: Evidence;
}

/**
 * The boundary between the deterministic engine and native execution. The
 * service implements it over the existing runtime, attempts, leases and
 * concurrency budget; tests implement it with a scripted stand-in.
 */
export interface OrchestrationDriver {
  /** Post-run work (candidate capture, copy checks) that must finish before results are used. */
  sync?(): Promise<void>;
  routes(projectId: string): RouteCandidate[];
  capacity(): CapacityView;
  /** Starts one member turn. Throws when no process was started. */
  launch(turn: MemberTurn): Promise<{ attemptId: string }>;
  /** The attempt a launch created, if it got that far before a restart. */
  findLaunch(launchId: string): string | null;
  observe(attemptId: string): AttemptObservation;
  interrupt(attemptId: string): Promise<void>;
  /** Captures the frozen project snapshot a code goal starts from. */
  baseline?(projectId: string, goalId: string): Promise<string>;
  /** Integrates member candidates over a base in one controlled workspace. */
  integrate?(input: {
    projectId: string;
    goalId: string;
    baseCandidateId: string;
    candidateIds: string[];
  }): Promise<{ candidateId: string } | { conflicts: string[] }>;
  /** Extra validation of a parsed review against its candidate (file/line existence). */
  validateReview?(
    candidateId: string,
    review: {
      candidateRevision: string;
      findings: Array<{ file: string; line: number }>;
    },
  ): string | null;
  candidateRevision?(candidateId: string): string | null;
}

const defaultGrant = (kind: Goal["kind"]): GoalGrant => ({
  taskKinds:
    kind === "code" ? ["implementation", "information"] : ["information"],
  maxTurns: 200,
  maxDelegatedTasks: 20,
  maxRepairRounds: 2,
  maxReconciliationTurns: 1,
  expiresAt: null,
});

const activeStages: ReadonlySet<RoleRound["stage"]> = new Set([
  "collecting",
  "reconciling",
  "endorsing",
]);

export class Orchestrator {
  readonly repo: OrchestrationRepository;
  private ticking = false;
  constructor(
    readonly store: Store,
    private driver: OrchestrationDriver,
    private changed: () => void = () => {},
  ) {
    this.repo = new OrchestrationRepository(store);
  }

  // -------------------------------------------------------------------------
  // Settings, roles and membership

  effective(
    projectId: string,
    goalId: string | null,
    roleId: string,
    taskKey: string | null = null,
  ): EffectiveRoleGroup {
    const role = this.repo.role(projectId, roleId);
    const policy = this.repo.policy(projectId);
    const goal = goalId ? this.repo.require<Goal>(kinds.goal, goalId) : null;
    return effectiveGroup({
      projectId,
      goalId,
      role,
      memberLimit: policy.maxMembersPerRole,
      layers: layersFor(
        this.repo.groupRevisions(projectId),
        policy.defaults,
        roleId,
        goal?.id ?? null,
        taskKey,
      ),
    });
  }

  async setGroup(input: {
    projectId: string;
    goalId: string | null;
    level: GroupScopeLevel;
    taskKey?: string | null;
    roleId: string;
    settings: RoleGroupSettings;
    commandId: string;
    actor?: string;
    messageId?: string | null;
    mode?: "merge" | "replace";
  }): Promise<{ revision: RoleGroupRevision; effective: EffectiveRoleGroup }> {
    return this.repo.receipt(
      input.commandId,
      input.projectId,
      "group-set",
      () => {
        if (input.roleId !== "*") this.repo.role(input.projectId, input.roleId);
        if (input.level !== "project-role" && !input.goalId)
          throw new Error("Goal and task settings need a goal.");
        if (input.level === "task" && !input.taskKey)
          throw new Error("A task override needs a task key.");
        const revision = this.store.transaction(() => {
          const revision = this.repo.addGroupRevision({
            scope: {
              level: input.level,
              projectId: input.projectId,
              goalId: input.level === "project-role" ? null : input.goalId,
              taskKey: input.level === "task" ? (input.taskKey ?? null) : null,
            },
            roleId: input.roleId,
            settings: input.settings,
            actor: input.actor ?? "local-user",
            commandId: input.commandId,
            messageId: input.messageId ?? null,
            mode: input.mode ?? "merge",
          });
          // A membership change takes effect at the next round boundary: active
          // rounds of the affected role become stale and restart with the new roster.
          if (input.goalId && input.level !== "project-role")
            this.control(
              input.projectId,
              input.goalId,
              "membership",
              input.roleId,
              input.commandId,
              `Membership for ${input.roleId} changed; affected rounds restart at the next boundary.`,
            );
          return revision;
        });
        const effective =
          input.roleId === "*"
            ? this.effective(input.projectId, input.goalId, "coordinator")
            : this.effective(
                input.projectId,
                input.goalId,
                input.roleId,
                input.taskKey ?? null,
              );
        this.changed();
        return { revision, effective };
      },
    );
  }

  async defineRole(input: {
    projectId: string;
    roleId: string;
    title: string;
    instructions: string;
    purpose:
      | "coordinator-contribution"
      | "information"
      | "implementation"
      | "candidate-review";
    commandId: string;
  }): Promise<RoleDefinition> {
    return this.repo.receipt(
      input.commandId,
      input.projectId,
      "role-define",
      () => {
        if ((builtInRoles as readonly string[]).includes(input.roleId))
          throw new Error(
            "Built-in roles keep their definitions; choose another role ID.",
          );
        const key = `${input.projectId}:${input.roleId}`;
        const old = this.repo.get<{ revision: number }>(kinds.role, key);
        const role = customRoleDefinition({
          id: input.roleId,
          projectId: input.projectId,
          revision: (old?.revision ?? 0) + 1,
          title: input.title,
          instructions: input.instructions,
          purpose: input.purpose,
        });
        // Stored under a project-scoped key; the role keeps the ID the user chose.
        this.repo.saveRevisioned(kinds.role, {
          ...role,
          id: key,
          roleId: input.roleId,
        });
        this.changed();
        return role;
      },
    );
  }

  /** "Return to Auto" for one member: its pin is released, the roster is kept. */
  async releaseMember(input: {
    projectId: string;
    goalId: string | null;
    roleId: string;
    memberId: string;
    commandId: string;
  }) {
    const current = this.effective(input.projectId, input.goalId, input.roleId);
    if (!current.members.some((m) => m.memberId === input.memberId))
      throw new Error("That member is not in this role.");
    return this.setGroup({
      projectId: input.projectId,
      goalId: input.goalId,
      level: input.goalId ? "goal-role" : "project-role",
      roleId: input.roleId,
      settings: {
        form: "required-plus-auto",
        count: current.count ?? current.members.length,
        members: current.members.map((m) =>
          m.memberId === input.memberId
            ? { ...m, pin: null, fallbacks: [] }
            : m,
        ),
      },
      commandId: input.commandId,
    });
  }

  /** "Return to Auto" for the whole role: its roster and count are released. */
  async releaseRoster(input: {
    projectId: string;
    goalId: string | null;
    roleId: string;
    commandId: string;
  }) {
    return this.setGroup({
      projectId: input.projectId,
      goalId: input.goalId,
      level: input.goalId ? "goal-role" : "project-role",
      roleId: input.roleId,
      settings: { form: "auto", members: [] },
      commandId: input.commandId,
      mode: "replace",
    });
  }

  /** Resolves and records the assignments for a role at a scope. */
  resolve(
    projectId: string,
    goalId: string | null,
    roleId: string,
    taskKey: string | null = null,
  ) {
    const role = this.repo.role(projectId, roleId);
    const group = this.effective(projectId, goalId, roleId, taskKey);
    const goal = goalId ? this.repo.get<Goal>(kinds.goal, goalId) : undefined;
    const result = resolveGroup({
      role,
      group,
      pool: this.driver.routes(projectId),
      complexity: goal ? goalComplexity(goal.objective) : "simple",
    });
    const assignments = result.assignments.map((a) =>
      this.repo.upsertAssignment(a),
    );
    return {
      group,
      role,
      assignments,
      conflicts: result.conflicts,
      targetCount: result.targetCount,
    };
  }

  // -------------------------------------------------------------------------
  // Conversation and goals

  async createConversation(input: {
    projectId: string;
    title: string;
    commandId: string;
  }) {
    return this.repo.receipt(
      input.commandId,
      input.projectId,
      "conversation-create",
      () => {
        const at = now();
        const conversation: CoordinatorConversation = {
          id: uid(),
          projectId: input.projectId,
          title: input.title.trim() || "Project conversation",
          goalIds: [],
          intakeCursor: 0,
          createdAt: at,
          updatedAt: at,
        };
        this.store.save(kinds.conversation, conversation);
        this.changed();
        return conversation;
      },
    );
  }

  private message(
    conversation: CoordinatorConversation,
    role: CoordinatorMessage["role"],
    text: string,
    routing: CoordinatorMessage["routing"],
  ) {
    const sequence = conversation.intakeCursor + 1;
    const message: CoordinatorMessage = {
      id: uid(),
      projectId: conversation.projectId,
      conversationId: conversation.id,
      sequence,
      role,
      text,
      routing,
      createdAt: now(),
    };
    this.store.immutable(kinds.message, message);
    conversation.intakeCursor = sequence;
    conversation.updatedAt = now();
    this.store.put(kinds.conversation, conversation);
    return message;
  }

  /**
   * Routes one user message: a status question, a control, a membership
   * instruction, steering for an existing goal, or a new goal. A new
   * unrelated request never cancels existing work. The routing decision is
   * persisted with the message.
   */
  async post(input: {
    conversationId: string;
    text: string;
    commandId: string;
    goalId?: string | null;
    routing?: "auto" | "new-goal" | "update-goal" | "related-goal" | "status";
    kind?: Goal["kind"];
  }) {
    const conversation = this.repo.require<CoordinatorConversation>(
      kinds.conversation,
      input.conversationId,
    );
    return this.repo.receipt(
      input.commandId,
      conversation.projectId,
      "message-post",
      async () => {
        const text = input.text.trim();
        if (!text) throw new Error("Write a message first.");
        const goals = conversation.goalIds.map((id) =>
          this.repo.require<Goal>(kinds.goal, id),
        );
        const target =
          (input.goalId
            ? goals.find((g) => g.id === input.goalId)
            : undefined) ??
          goals
            .filter(
              (g) => !["stopped", "accepted", "completed"].includes(g.state),
            )
            .at(-1);
        let routing = input.routing ?? "auto";
        if (routing === "auto") {
          if (/^\s*(stop everything|stop all)\b/i.test(text))
            routing = "status";
          else if (
            target &&
            /^\s*(status|what(?:'s| is) (?:the )?(?:status|progress)|how is it going)\b|\?\s*$/i.test(
              text,
            )
          )
            routing = "status";
          else if (
            target &&
            /^\s*(also|change|update|instead|actually|steer|add to)\b/i.test(
              text,
            )
          )
            routing = "update-goal";
          else routing = "new-goal";
        }
        const membership = parseMembership(text, input.commandId);
        // Explicit controls are service operations, independent of language
        // interpretation; these phrases are a convenience over them.
        if (/^\s*(stop everything|stop all)\b/i.test(text)) {
          const message = this.message(conversation, "user", text, {
            kind: "control",
            goalId: null,
          });
          await this.controlCommand({
            projectId: conversation.projectId,
            goalId: null,
            action: "stop",
            commandId: `${input.commandId}:control`,
          });
          this.message(
            conversation,
            "service",
            "Stopped every goal in this project. Results and uncertain executions are preserved.",
            { kind: "control", goalId: null },
          );
          return { message, routing: "control", goal: null };
        }
        if (target && /^\s*pause (this|the) goal\b/i.test(text)) {
          const message = this.message(conversation, "user", text, {
            kind: "control",
            goalId: target.id,
          });
          await this.controlCommand({
            projectId: conversation.projectId,
            goalId: target.id,
            action: "pause",
            commandId: `${input.commandId}:control`,
          });
          return {
            message,
            routing: "control",
            goal: this.repo.require<Goal>(kinds.goal, target.id),
          };
        }
        if (target && /^\s*resume\b/i.test(text)) {
          const message = this.message(conversation, "user", text, {
            kind: "control",
            goalId: target.id,
          });
          await this.controlCommand({
            projectId: conversation.projectId,
            goalId: target.id,
            action: "resume",
            commandId: `${input.commandId}:control`,
          });
          return {
            message,
            routing: "control",
            goal: this.repo.require<Goal>(kinds.goal, target.id),
          };
        }
        if (routing === "status" && target) {
          const message = this.message(conversation, "user", text, {
            kind: "status",
            goalId: target.id,
          });
          this.message(conversation, "service", this.statusText(target.id), {
            kind: "status",
            goalId: target.id,
          });
          return { message, routing, goal: target };
        }
        if (routing === "update-goal" && target) {
          const message = this.message(conversation, "user", text, {
            kind: "update-goal",
            goalId: target.id,
          });
          this.applyMembership(
            conversation.projectId,
            target.id,
            membership,
            message.id,
            input.commandId,
          );
          await this.steer({
            goalId: target.id,
            text,
            commandId: `${input.commandId}:steer`,
          });
          return {
            message,
            routing,
            goal: this.repo.require<Goal>(kinds.goal, target.id),
          };
        }
        const message = this.message(conversation, "user", text, {
          kind: routing === "related-goal" ? "related-goal" : "new-goal",
          goalId: null,
        });
        const goal = this.newGoal(
          conversation,
          text,
          input.kind ?? "code",
          routing === "related-goal" ? (target?.id ?? null) : null,
        );
        this.store.put(kinds.message, {
          ...message,
          routing: { ...message.routing!, goalId: goal.id },
        });
        this.applyMembership(
          conversation.projectId,
          goal.id,
          membership,
          message.id,
          input.commandId,
        );
        this.changed();
        return { message, routing, goal };
      },
    );
  }

  private applyMembership(
    projectId: string,
    goalId: string,
    instructions: ReturnType<typeof parseMembership>,
    messageId: string,
    commandId: string,
  ) {
    for (const [index, instruction] of instructions.entries()) {
      if (instruction.roleId !== "*")
        this.repo.role(projectId, instruction.roleId);
      this.repo.addGroupRevision({
        scope: { level: "goal-role", projectId, goalId, taskKey: null },
        roleId: instruction.roleId,
        settings: instruction.settings,
        actor: "local-user",
        commandId: `${commandId}:membership:${index}`,
        messageId,
      });
    }
  }

  private newGoal(
    conversation: CoordinatorConversation,
    objective: string,
    kind: Goal["kind"],
    parentGoalId: string | null,
  ): Goal {
    const at = now();
    const goal: Goal = {
      id: uid(),
      projectId: conversation.projectId,
      conversationId: conversation.id,
      revision: 1,
      objective,
      constraints: [],
      kind,
      state: "planning",
      controlGeneration: 1,
      grant: defaultGrant(kind),
      usage: { turns: 0, delegatedTasks: 0, repairRounds: 0 },
      planId: null,
      planRevision: 0,
      baselineCandidateId: null,
      pausedFrom: null,
      parentGoalId,
      relatedGoalIds: [],
      candidateId: null,
      reviewCompletionId: null,
      acceptance: null,
      synthesis: null,
      detail: "Forming the coordinator group.",
      createdAt: at,
      updatedAt: at,
    };
    this.store.transaction(() => {
      this.repo.saveRevisioned(kinds.goal, goal);
      conversation.goalIds = [...conversation.goalIds, goal.id];
      this.store.put(kinds.conversation, conversation);
      if (parentGoalId) {
        const parent = this.repo.require<Goal>(kinds.goal, parentGoalId);
        this.store.put(kinds.goal, {
          ...parent,
          relatedGoalIds: [...parent.relatedGoalIds, goal.id],
        });
      }
    });
    return goal;
  }

  async createGoal(input: {
    conversationId: string;
    objective: string;
    kind?: Goal["kind"];
    constraints?: string[];
    grant?: Partial<GoalGrant>;
    commandId: string;
  }) {
    const conversation = this.repo.require<CoordinatorConversation>(
      kinds.conversation,
      input.conversationId,
    );
    return this.repo.receipt(
      input.commandId,
      conversation.projectId,
      "goal-create",
      () => {
        const goal = this.newGoal(
          conversation,
          input.objective,
          input.kind ?? "code",
          null,
        );
        const next = {
          ...goal,
          constraints: input.constraints ?? [],
          grant: { ...goal.grant, ...input.grant },
        };
        this.store.put(kinds.goal, next);
        this.message(conversation, "user", input.objective, {
          kind: "new-goal",
          goalId: goal.id,
        });
        this.changed();
        return next;
      },
    );
  }

  /** Applies changes to the latest stored goal, never to a stale copy. */
  private saveGoal(goal: Goal, next: Partial<Goal>, content = false): Goal {
    const current = this.repo.get<Goal>(kinds.goal, goal.id) ?? goal;
    const value = {
      ...current,
      ...next,
      revision: content ? current.revision + 1 : current.revision,
      updatedAt: now(),
    };
    if (content) this.repo.saveRevisioned(kinds.goal, value);
    else this.store.save(kinds.goal, value);
    return value;
  }

  /**
   * Steering changes the goal's scope. Coordination candidates for the old
   * revision can no longer commit; admitted work keeps its scope, and queued
   * actions wait for the replan.
   */
  async steer(input: {
    goalId: string;
    text: string;
    constraints?: string[];
    commandId: string;
  }) {
    const goal = this.repo.require<Goal>(kinds.goal, input.goalId);
    return this.repo.receipt(
      input.commandId,
      goal.projectId,
      "goal-steer",
      () => {
        if (["stopped", "accepted"].includes(goal.state))
          throw new Error("This goal has ended. Start a new goal.");
        const next = this.store.transaction(() => {
          const updated = this.saveGoal(
            goal,
            {
              constraints: [
                ...goal.constraints,
                ...(input.constraints ?? []),
                input.text,
              ],
              state: goal.state === "paused" ? "paused" : "planning",
              pausedFrom:
                goal.state === "paused" ? "planning" : goal.pausedFrom,
              detail:
                "Steering received; replanning before further actions are admitted.",
            },
            true,
          );
          for (const action of this.actions(goal))
            if (action.state === "queued")
              this.saveAction(action, {
                state: "blocked",
                detail: "Held for the replan after steering.",
              });
          this.control(
            goal.projectId,
            goal.id,
            "steer",
            null,
            input.commandId,
            input.text.slice(0, 500),
          );
          return updated;
        });
        this.changed();
        return next;
      },
    );
  }

  // -------------------------------------------------------------------------
  // Controls. These never wait for or consult a model.

  private control(
    projectId: string,
    goalId: string | null,
    action: ControlEvent["action"],
    targetId: string | null,
    commandId: string,
    detail: string,
  ) {
    const goal = goalId ? this.repo.get<Goal>(kinds.goal, goalId) : undefined;
    this.store.immutable(kinds.control, {
      id: `${commandId}:${action}:${goalId ?? "project"}`,
      projectId,
      goalId,
      scope:
        targetId && action === "stop-member"
          ? "member"
          : goalId
            ? "goal"
            : "project",
      action,
      targetId,
      generation: goal?.controlGeneration ?? 0,
      actor: "local-user",
      commandId,
      detail,
      createdAt: now(),
    } satisfies ControlEvent);
  }

  async controlCommand(input: {
    projectId: string;
    goalId: string | null;
    action: "pause" | "stop" | "resume" | "stop-member";
    roundId?: string;
    memberId?: string;
    commandId: string;
  }) {
    return this.repo.receipt(
      input.commandId,
      input.projectId,
      `control-${input.action}`,
      async () => {
        const goals = input.goalId
          ? [this.repo.require<Goal>(kinds.goal, input.goalId)]
          : this.repo.all<Goal>(kinds.goal, input.projectId);
        const interrupts: string[] = [];
        this.store.transaction(() => {
          for (const goal of goals) {
            if (goal.projectId !== input.projectId)
              throw new Error("That goal belongs to another project.");
            if (input.action === "stop-member") {
              const round = this.repo.require<RoleRound>(
                kinds.round,
                input.roundId!,
              );
              const member = round.members.find(
                (m) => m.memberId === input.memberId,
              );
              if (!member || round.goalId !== goal.id)
                throw new Error("That member is not in this round.");
              if (member.activeAttemptId)
                interrupts.push(member.activeAttemptId);
              this.repo.saveRound(round, {
                members: round.members.map((m) =>
                  m.memberId === member.memberId
                    ? {
                        ...m,
                        state: "stopped",
                        detail:
                          "Stopped by the owner; its contribution is missing, not passed.",
                      }
                    : m,
                ),
              });
              this.control(
                goal.projectId,
                goal.id,
                "stop-member",
                member.memberId,
                input.commandId,
                `Stopped ${member.memberId}.`,
              );
              continue;
            }
            if (
              ["stopped", "accepted"].includes(goal.state) &&
              input.action !== "resume"
            )
              continue;
            if (input.action === "resume") {
              if (goal.state !== "paused") continue;
              this.saveGoal(goal, {
                state:
                  goal.pausedFrom && goal.pausedFrom !== "blocked"
                    ? goal.pausedFrom
                    : goal.candidateId
                      ? "reviewing"
                      : goal.planId
                        ? "running"
                        : "planning",
                pausedFrom: null,
                controlGeneration: goal.controlGeneration + 1,
                detail:
                  "Resumed; assignments, inputs and capacity are revalidated before new work starts.",
              });
              for (const action of this.actions(goal))
                if (
                  action.state === "blocked" &&
                  action.detail.startsWith("Paused")
                )
                  this.saveAction(action, {
                    state: "queued",
                    detail: "",
                    expectedControlGeneration: goal.controlGeneration + 1,
                  });
              this.control(
                goal.projectId,
                goal.id,
                "resume",
                null,
                input.commandId,
                "Resumed.",
              );
              continue;
            }
            const stop = input.action === "stop";
            const generation = goal.controlGeneration + 1;
            this.saveGoal(goal, {
              state: stop ? "stopped" : "paused",
              pausedFrom: stop
                ? null
                : goal.state === "paused"
                  ? goal.pausedFrom
                  : goal.state,
              controlGeneration: generation,
              detail: stop
                ? "Stopped. Future dispatch is revoked; results and uncertain executions are preserved."
                : "Pausing: new actions are fenced; waiting for active members to stop.",
            });
            for (const action of this.actions(goal))
              if (["queued", "admitted"].includes(action.state))
                this.saveAction(action, {
                  state: stop
                    ? "cancelled"
                    : action.state === "queued"
                      ? "blocked"
                      : action.state,
                  detail: stop
                    ? "Cancelled by stop."
                    : action.state === "queued"
                      ? "Paused before admission."
                      : action.detail,
                });
            for (const round of this.rounds(goal.id).filter(
              (r) => activeStages.has(r.stage) || r.stage === "awaiting-user",
            )) {
              for (const m of round.members)
                if (m.activeAttemptId) interrupts.push(m.activeAttemptId);
              this.repo.saveRound(round, {
                stage: stop ? "stopped" : "stale",
                detail: stop
                  ? "Stopped by the owner."
                  : "Paused; this round restarts with fresh inputs on resume.",
              });
            }
            this.control(
              goal.projectId,
              goal.id,
              input.action,
              null,
              input.commandId,
              stop ? "Stopped." : "Paused.",
            );
          }
        });
        for (const attemptId of interrupts)
          try {
            await this.driver.interrupt(attemptId);
          } catch {
            // An interrupt that cannot be delivered leaves the attempt uncertain;
            // its lease and capacity stay held until reconciliation.
          }
        this.changed();
        return { interrupted: interrupts.length };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Records

  rounds(goalId: string): RoleRound[] {
    const goal = this.repo.require<Goal>(kinds.goal, goalId);
    return this.repo
      .all<RoleRound>(kinds.round, goal.projectId)
      .filter((r) => r.goalId === goalId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  contributions(roundId: string, projectId: string): ParticipantContribution[] {
    return this.repo
      .all<ParticipantContribution>(kinds.contribution, projectId)
      .filter((c) => c.roundId === roundId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private endorsements(
    roundId: string,
    projectId: string,
  ): DecisionEndorsement[] {
    return this.repo
      .all<DecisionEndorsement>(kinds.endorsement, projectId)
      .filter((e) => e.roundId === roundId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private candidates(roundId: string, projectId: string): DecisionCandidate[] {
    return this.repo
      .all<DecisionCandidate>(kinds.candidate, projectId)
      .filter((c) => c.roundId === roundId)
      .sort((a, b) => a.revision - b.revision);
  }
  actions(goal: Goal): QueuedPlanAction[] {
    if (!goal.planId) return [];
    return this.repo
      .all<QueuedPlanAction>(kinds.action, goal.projectId)
      .filter((a) => a.planId === goal.planId)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.taskKey.localeCompare(b.taskKey),
      );
  }
  private saveAction(
    action: QueuedPlanAction,
    next: Partial<QueuedPlanAction>,
  ): QueuedPlanAction {
    return this.repo.saveRevisioned(kinds.action, {
      ...action,
      ...next,
      revision: action.revision + 1,
      updatedAt: now(),
    });
  }
  private plan(goal: Goal): CoordinatorPlan | null {
    return goal.planId
      ? this.repo.require<CoordinatorPlan>(kinds.plan, goal.planId)
      : null;
  }

  // -------------------------------------------------------------------------
  // Rounds

  private freeze(
    goal: Goal,
    input: {
      roleId: string;
      kind: RoundKind;
      taskKey: string | null;
      candidateId?: string | null;
      brief?: string | null;
      partitions?: Array<{ title: string; permittedOutputs: string[] }>;
    },
  ): RoleRound | { blocked: string } {
    const { group, role, assignments, conflicts } = this.resolve(
      goal.projectId,
      goal.id,
      input.roleId,
      input.taskKey,
    );
    const required = new Map(
      group.members.map((m) => [m.memberId, m.required]),
    );
    const blocked = assignments.filter(
      (a) => (required.get(a.memberId) ?? true) && a.status !== "resolved",
    );
    if (conflicts.length || blocked.length)
      return {
        blocked: [
          ...conflicts,
          ...blocked.map((a) => `${a.memberId}: ${a.reason}`),
        ].join(" "),
      };
    let usable = assignments.filter((a) => a.status === "resolved");
    // A partition plan with fewer partitions than members names only the
    // members it needs; the others are recorded as not needed for this task.
    const partitions = input.partitions ?? [];
    if (
      input.kind === "work" &&
      group.collaboration === "parallel-partitioned" &&
      partitions.length > usable.length
    )
      return {
        blocked: `Task ${input.taskKey} has ${partitions.length} partitions for ${usable.length} members. Replan this task.`,
      };
    if (
      input.kind === "work" &&
      group.collaboration === "parallel-partitioned" &&
      partitions.length &&
      partitions.length < usable.length
    )
      usable = usable.slice(0, partitions.length);
    const { conflicts: policyConflicts, ...frozen } = freezePolicy(
      group.completion,
      usable.map((a) => ({
        memberId: a.memberId,
        required: required.get(a.memberId) ?? true,
      })),
    );
    if (policyConflicts.length) return { blocked: policyConflicts.join(" ") };
    // Validate the turn allowance covers every required member and stage
    // before anything starts, rather than exhausting it partway.
    const stages =
      input.kind === "coordination"
        ? 2 + group.completion.reconciliationTurns
        : 1;
    const needed =
      usable.length * stages * (1 + group.completion.retriesPerMember);
    const minimum = usable.length * stages;
    if (goal.usage.turns + minimum > goal.grant.maxTurns)
      return {
        blocked: `The goal's turn allowance (${goal.grant.maxTurns - goal.usage.turns} left) cannot cover ${minimum} required turns for ${usable.length} ${role.title.toLowerCase()}.`,
      };
    const rosters: RoleRound["input"]["rosters"] = {};
    if (input.kind === "coordination")
      for (const r of this.repo
        .roles(goal.projectId)
        .filter((r) => r.purpose !== "coordinator-contribution")) {
        try {
          const g = this.effective(goal.projectId, goal.id, r.id);
          rosters[r.id] = {
            members:
              g.form === "exact"
                ? g.members.length
                : (g.count ?? Math.max(g.members.length, g.minCount)),
            collaboration: g.collaboration,
          };
        } catch {}
      }
    const candidateRevision = input.candidateId
      ? (this.driver.candidateRevision?.(input.candidateId) ?? null)
      : null;
    const memberPartitions: RoleRound["input"]["partitions"] = {};
    usable.forEach((a, i) => {
      if (partitions[i]) memberPartitions[a.memberId] = partitions[i];
    });
    const base = {
      goalRevision: goal.revision,
      planRevision: goal.planRevision,
      controlGeneration: goal.controlGeneration,
      specificationRevision: null,
      eventCursor: this.store.controlHead(),
      candidateId: input.candidateId ?? null,
      candidateRevision,
      brief: input.brief ?? null,
      partitions: memberPartitions,
      rosters,
      artifactRefs: this.actions(goal).flatMap((a) => [
        ...a.artifactIds,
        ...a.candidateIds,
      ]),
      allowedOperations: goal.grant.taskKinds,
    };
    const members: RoundMember[] = usable.map((a) => ({
      memberId: a.memberId,
      assignmentId: a.id,
      assignmentRevision: a.revision,
      provider: a.provider!,
      model: a.model!,
      installationId: a.installationId!,
      required: required.get(a.memberId) ?? true,
      state: "queued",
      phase: "initial",
      attemptIds: [],
      activeAttemptId: null,
      launchId: null,
      contributionIds: [],
      retries: 0,
      wave: 0,
      detail: "",
    }));
    const at = now();
    const round: RoleRound = {
      id: uid(),
      projectId: goal.projectId,
      goalId: goal.id,
      roleId: input.roleId,
      kind: input.kind,
      taskKey: input.taskKey,
      revision: 1,
      stage: "collecting",
      input: {
        ...base,
        digest: hash(
          stable({
            ...base,
            members: members.map((m) => [
              m.memberId,
              m.assignmentId,
              m.assignmentRevision,
            ]),
          }),
        ),
      },
      members,
      ...frozen,
      policyDigest: "",
      groupDigest: this.groupDigest(group),
      collaboration: group.collaboration,
      scheduling:
        group.collaboration === "sequential" ? "sequential" : group.scheduling,
      executionWidth: group.executionWidth,
      retriesPerMember: group.completion.retriesPerMember,
      reconciliationTurns: Math.min(
        group.completion.reconciliationTurns,
        goal.grant.maxReconciliationTurns,
      ),
      reconciliationTurnsUsed: 0,
      candidateId: null,
      completionId: null,
      detail: `${members.length} ${members.length === 1 ? "member" : "members"} queued.${needed > goal.grant.maxTurns - goal.usage.turns ? " Retries may exceed the remaining turn allowance." : ""}`,
      createdAt: at,
      updatedAt: at,
    };
    round.policyDigest = policyDigest(round);
    this.repo.saveRevisioned(kinds.round, round);
    return round;
  }

  private groupDigest(group: EffectiveRoleGroup): string {
    return hash(
      stable({ ...group, sources: group.sources.map((s) => s.revisionId) }),
    );
  }

  private stale(round: RoleRound, goal: Goal): string | null {
    if (round.input.controlGeneration !== goal.controlGeneration)
      return "The goal was paused, stopped or resumed after this round froze its inputs.";
    if (
      round.kind === "coordination" &&
      round.input.goalRevision !== goal.revision
    )
      return "The goal's scope changed; this round's candidates can no longer commit.";
    if (round.kind === "review" && round.input.candidateId !== goal.candidateId)
      return "The candidate changed; this review no longer covers the current candidate.";
    if (
      [
        "collecting",
        "reconciling",
        "endorsing",
        "awaiting-user",
        "blocked",
      ].includes(round.stage)
    ) {
      const current = this.groupDigest(
        this.effective(goal.projectId, goal.id, round.roleId, round.taskKey),
      );
      if (current !== round.groupDigest)
        return "The role's membership or policy changed; a new round freezes the new assignments.";
    }
    return null;
  }

  private purpose(round: RoleRound, member: RoundMember): ExecutionPurpose {
    if (round.kind === "coordination")
      return member.phase === "endorsement"
        ? "coordinator-endorsement"
        : "coordinator-contribution";
    if (round.kind === "review") return "candidate-review";
    return this.repo.role(round.projectId, round.roleId).purpose;
  }

  private prompt(
    goal: Goal,
    round: RoleRound,
    member: RoundMember,
    role: RoleDefinition,
  ): string {
    if (round.kind === "coordination") {
      const base = coordinatorPrompt({
        objective: goal.objective,
        constraints: goal.constraints,
        round,
        memberId: member.memberId,
        instructions: role.instructions,
        knownRoles: Object.entries(round.input.rosters).map(([id, r]) => ({
          id,
          purpose: this.repo.role(goal.projectId, id).purpose,
          members: r.members,
          collaboration: r.collaboration,
        })),
        completed: this.actions(goal)
          .filter((a) => a.state === "completed")
          .map((a) => ({
            key: a.taskKey,
            title: a.taskKey,
            summary: a.detail,
          })),
      });
      if (member.phase === "endorsement") {
        const candidate = this.repo.require<DecisionCandidate>(
          kinds.candidate,
          round.candidateId!,
        );
        return endorsementPrompt(candidate, member.memberId);
      }
      if (member.phase === "reconciliation") {
        const contributions = this.contributions(
          round.id,
          round.projectId,
        ).filter((c) => countsFor(round, c) && c.phase !== "endorsement");
        const latest = new Map<string, ParticipantContribution>();
        for (const c of contributions) latest.set(c.memberId, c);
        const challenges = this.endorsements(round.id, round.projectId)
          .filter(
            (e) =>
              e.candidateId === round.candidateId && e.stance !== "endorse",
          )
          .map((e) => ({ memberId: e.memberId, rationale: e.rationale }));
        return reconciliationPrompt({
          base,
          proposals: [...latest.values()].map((c) => {
            const p = c.output as {
              summary: string;
              actions: PlanTaskAction[];
            };
            return {
              memberId: c.memberId,
              summary: p.summary,
              actions: p.actions,
            };
          }),
          conflicts: round.detail ? [round.detail] : [],
          challenges,
        });
      }
      return base;
    }
    if (round.kind === "review")
      return reviewPrompt({
        objective: goal.objective,
        candidateRevision: round.input.candidateRevision ?? "",
        memberId: member.memberId,
        instructions: role.instructions,
        criteria:
          this.plan(goal)?.tasks.flatMap((t) => t.acceptanceCriteria) ?? [],
      });
    const action = this.plan(goal)!.tasks.find((t) => t.key === round.taskKey)!;
    const previous =
      round.collaboration === "sequential"
        ? this.contributions(round.id, round.projectId)
            .filter((c) => countsFor(round, c))
            .map(
              (c) =>
                `${c.memberId}: ${(c.output as { summary?: string })?.summary ?? ""}`,
            )
            .join("\n") || null
        : null;
    return workPrompt({
      purpose:
        role.purpose === "implementation" ? "implementation" : "information",
      objective: goal.objective,
      action,
      partition: round.input.partitions[member.memberId] ?? null,
      memberId: member.memberId,
      instructions: role.instructions,
      inputDigest: round.input.digest,
      handoff: previous,
    });
  }

  /** Records a finished attempt as a contribution, validating only its final message. */
  private contribute(
    goal: Goal,
    round: RoleRound,
    member: RoundMember,
    attemptId: string,
    obs: AttemptObservation,
  ): ParticipantContribution {
    const assignment =
      this.repo.assignmentRevision(
        member.assignmentId,
        member.assignmentRevision,
      ) ??
      this.repo.require<ResolvedMemberAssignment>(
        kinds.assignment,
        member.assignmentId,
      );
    let output: unknown = null;
    let validation: ParticipantContribution["validation"];
    const evidence = modelEvidence(assignment, {
      model: obs.reportedModel,
      effort: obs.reportedEffort,
    });
    if (obs.state !== "completed")
      validation = {
        state: "failed",
        reason: obs.error ?? `The attempt ended ${obs.state}.`,
      };
    else if (!evidence.satisfies)
      validation = { state: "invalid", reason: evidence.detail };
    else if (round.kind === "coordination" && member.phase === "endorsement") {
      const parsed = parseFinal(endorsementSchema, obs.finalText);
      const candidate = round.candidateId
        ? this.repo.get<DecisionCandidate>(kinds.candidate, round.candidateId)
        : undefined;
      if (!parsed.ok) validation = { state: "invalid", reason: parsed.reason };
      else if (!candidate || parsed.value.candidateDigest !== candidate.digest)
        validation = {
          state: "invalid",
          reason:
            "The response names a different candidate digest; it endorses nothing.",
        };
      else {
        output = parsed.value;
        validation = { state: "valid", reason: evidence.detail };
      }
    } else if (round.kind === "coordination") {
      const parsed = parseFinal(coordinatorProposalSchema, obs.finalText);
      if (!parsed.ok) validation = { state: "invalid", reason: parsed.reason };
      else if (parsed.value.snapshotDigest !== round.input.digest)
        validation = {
          state: "stale",
          reason:
            "The proposal names a different snapshot; it is kept as history but is not a decision input.",
        };
      else {
        const actions = parsed.value.actions.map(normalizeAction);
        const problems = validateActions(actions, {
          knownRoles: this.repo.roles(goal.projectId).map((r) => r.id),
          allowedKinds: goal.grant.taskKinds,
          remainingTasks:
            goal.grant.maxDelegatedTasks - goal.usage.delegatedTasks,
          rosters: round.input.rosters,
        });
        output = { ...parsed.value, actions };
        validation = problems.length
          ? { state: "invalid", reason: problems.join(" ") }
          : { state: "valid", reason: evidence.detail };
      }
    } else if (round.kind === "review") {
      const parsed = parseFinal(reviewSchema, obs.finalText);
      if (!parsed.ok) validation = { state: "invalid", reason: parsed.reason };
      else if (parsed.value.candidateRevision !== round.input.candidateRevision)
        validation = {
          state: "stale",
          reason: "The review names a different candidate revision.",
        };
      else {
        const problem =
          this.driver.validateReview?.(
            round.input.candidateId!,
            parsed.value,
          ) ?? null;
        output = parsed.value;
        validation = problem
          ? { state: "invalid", reason: problem }
          : { state: "valid", reason: evidence.detail };
      }
    } else if (
      this.repo.role(goal.projectId, round.roleId).purpose === "implementation"
    ) {
      const parsed = parseFinal(implementationSummarySchema, obs.finalText);
      output = {
        summary: parsed.ok
          ? parsed.value.summary
          : "The member returned no summary.",
        candidateId: obs.candidateId ?? null,
      };
      validation = obs.candidateId
        ? { state: "valid", reason: evidence.detail }
        : {
            state: "invalid",
            reason:
              obs.error ??
              "No candidate was captured from the member's workspace.",
          };
    } else {
      const parsed = parseFinal(informationSchema, obs.finalText);
      if (!parsed.ok) validation = { state: "invalid", reason: parsed.reason };
      else if (parsed.value.inputDigest !== round.input.digest)
        validation = {
          state: "stale",
          reason: "The report names a different input digest.",
        };
      else {
        output = parsed.value;
        validation = { state: "valid", reason: evidence.detail };
      }
    }
    const contribution: ParticipantContribution = {
      id: `${round.id}:${attemptId}`,
      projectId: goal.projectId,
      goalId: goal.id,
      roundId: round.id,
      memberId: member.memberId,
      assignmentId: member.assignmentId,
      assignmentRevision: member.assignmentRevision,
      attemptId,
      phase: member.phase,
      output,
      validation,
      inputDigest: round.input.digest,
      reportedModel: obs.reportedModel,
      provenance: obs.evidence,
      createdAt: now(),
    };
    this.repo.immutable(kinds.contribution, contribution);
    if (
      validation.state === "valid" &&
      round.kind === "coordination" &&
      member.phase === "endorsement"
    ) {
      const e = output as {
        candidateDigest: string;
        stance: DecisionEndorsement["stance"];
        rationale: string;
      };
      this.repo.immutable(kinds.endorsement, {
        id: `${round.id}:${round.candidateId}:${member.memberId}:${attemptId}`,
        projectId: goal.projectId,
        roundId: round.id,
        candidateId: round.candidateId!,
        candidateDigest: e.candidateDigest,
        memberId: member.memberId,
        assignmentId: member.assignmentId,
        contributionId: contribution.id,
        stance: e.stance,
        rationale: e.rationale,
        implied: false,
        createdAt: now(),
      } satisfies DecisionEndorsement);
    }
    return contribution;
  }

  /** Observes running members, records results and applies the retry allowance. */
  private collect(goal: Goal, round: RoleRound): RoleRound {
    let changed = false;
    const members = round.members.map((m) => ({ ...m }));
    for (const m of members) {
      if (!m.activeAttemptId && m.launchId) {
        // A launch interrupted by a restart: adopt its attempt, never start it twice.
        const adopted = this.driver.findLaunch(m.launchId);
        if (adopted) {
          m.activeAttemptId = adopted;
          if (!m.attemptIds.includes(adopted)) m.attemptIds.push(adopted);
          m.state = "running";
        } else {
          m.launchId = null;
          m.state = "queued";
        }
        changed = true;
      }
      if (!m.activeAttemptId) continue;
      const obs = this.driver.observe(m.activeAttemptId);
      if (obs.state === "running") continue;
      if (obs.state === "uncertain" || !obs.quiescent) {
        const detail =
          obs.state === "uncertain"
            ? "Execution is uncertain; its lease and capacity stay held until reconciliation."
            : "Waiting for the member's processes to stop before using its result.";
        if (m.detail !== detail) {
          m.detail = detail;
          changed = true;
        }
        continue;
      }
      const attemptId = m.activeAttemptId;
      m.activeAttemptId = null;
      m.launchId = null;
      changed = true;
      if (m.state === "stopped") continue;
      const cohortRestart = m.detail === "cohort-restart";
      const contribution = this.contribute(goal, round, m, attemptId, obs);
      m.contributionIds = [...m.contributionIds, contribution.id];
      if (contribution.validation.state === "valid") {
        m.state = "returned";
        m.detail = "";
      } else if (cohortRestart) {
        m.state = "queued";
        m.detail = "Restarting with its cohort.";
      } else if (m.retries < round.retriesPerMember) {
        m.retries += 1;
        m.state = "queued";
        m.detail = `Retrying: ${contribution.validation.reason}`;
      } else {
        m.state =
          contribution.validation.state === "failed" ? "failed" : "invalid";
        m.detail = contribution.validation.reason;
      }
    }
    return changed ? this.repo.saveRound(round, { members }) : round;
  }

  /** Starts the members the schedule admits now. */
  private async launch(goal: Goal, round: RoleRound): Promise<RoleRound> {
    const phase = round.members.find((m) => m.state === "queued")?.phase;
    if (!phase) return round;
    const capacity = this.driver.capacity();
    const weights = Object.fromEntries(
      round.members.map((m) => {
        const a = this.repo.require<ResolvedMemberAssignment>(
          kinds.assignment,
          m.assignmentId,
        );
        return [
          m.memberId,
          {
            provider: m.provider,
            weight: memberWeight(a.fanout, capacity.total),
          },
        ];
      }),
    );
    const decision = admit(round, phase, weights, capacity);
    if (decision.conflict) {
      return this.repo.saveRound(round, {
        stage: "blocked",
        detail: decision.conflict,
      });
    }
    if (!decision.admit.length) {
      return round.detail === decision.detail
        ? round
        : this.repo.saveRound(round, { detail: decision.detail });
    }
    const role = this.repo.role(goal.projectId, round.roleId);
    const wave = Math.max(0, ...round.members.map((m) => m.wave)) + 1;
    // Record each launch before starting it, so a restart adopts the attempt.
    const launches = new Map(decision.admit.map((id) => [id, uid()]));
    round = this.repo.saveRound(round, {
      members: round.members.map((m) =>
        launches.has(m.memberId)
          ? { ...m, launchId: launches.get(m.memberId)!, wave }
          : m,
      ),
      detail: decision.detail,
    });
    const started: string[] = [];
    let failure: string | null = null;
    for (const memberId of decision.admit) {
      const fresh = this.repo.require<RoleRound>(kinds.round, round.id);
      const member = fresh.members.find((m) => m.memberId === memberId)!;
      const assignment = this.repo.require<ResolvedMemberAssignment>(
        kinds.assignment,
        member.assignmentId,
      );
      if (assignment.revision !== member.assignmentRevision) {
        failure = `${memberId}'s assignment changed after the round froze.`;
        break;
      }
      const turn: MemberTurn = {
        launchId: member.launchId!,
        projectId: goal.projectId,
        goalId: goal.id,
        roundId: round.id,
        roleId: round.roleId,
        memberId,
        assignment,
        purpose: this.purpose(fresh, member),
        phase: member.phase,
        prompt: this.prompt(goal, fresh, member, role),
        inputDigest: fresh.input.digest,
        candidateId:
          round.kind === "review"
            ? fresh.input.candidateId
            : round.kind === "work" && role.purpose === "implementation"
              ? (fresh.input.candidateId ?? goal.baselineCandidateId)
              : null,
        permittedOutputs:
          fresh.input.partitions[memberId]?.permittedOutputs ??
          this.plan(goal)?.tasks.find((t) => t.key === round.taskKey)
            ?.permittedOutputs ??
          [],
        retryOfAttemptId: member.attemptIds.at(-1) ?? null,
      };
      try {
        const { attemptId } = await this.driver.launch(turn);
        started.push(memberId);
        const latest = this.repo.require<RoleRound>(kinds.round, round.id);
        this.repo.saveRound(latest, {
          members: latest.members.map((m) =>
            m.memberId === memberId
              ? {
                  ...m,
                  state: "running",
                  activeAttemptId: attemptId,
                  attemptIds: [...m.attemptIds, attemptId],
                  detail: "",
                }
              : m,
          ),
        });
        const g = this.repo.require<Goal>(kinds.goal, goal.id);
        this.saveGoal(g, { usage: { ...g.usage, turns: g.usage.turns + 1 } });
      } catch (error) {
        // A launch that recorded an attempt before failing is adopted and
        // observed, never assumed unstarted and dispatched again.
        const recorded = this.driver.findLaunch(member.launchId!);
        if (recorded) {
          const latest = this.repo.require<RoleRound>(kinds.round, round.id);
          this.repo.saveRound(latest, {
            members: latest.members.map((m) =>
              m.memberId === memberId
                ? {
                    ...m,
                    state: "running",
                    activeAttemptId: recorded,
                    attemptIds: [...new Set([...m.attemptIds, recorded])],
                    detail: safeError(error),
                  }
                : m,
            ),
          });
          started.push(memberId);
          continue;
        }
        failure = `${memberId} did not start: ${safeError(error)}`;
        const latest = this.repo.require<RoleRound>(kinds.round, round.id);
        this.repo.saveRound(latest, {
          members: latest.members.map((m) =>
            m.memberId === memberId
              ? m.retries < latest.retriesPerMember
                ? {
                    ...m,
                    launchId: null,
                    state: "queued",
                    retries: m.retries + 1,
                    detail: failure!,
                  }
                : { ...m, launchId: null, state: "failed", detail: failure! }
              : m,
          ),
        });
        if (round.scheduling !== "all-simultaneous") continue;
        break;
      }
    }
    let latest = this.repo.require<RoleRound>(kinds.round, round.id);
    if (failure && round.scheduling === "all-simultaneous") {
      // A strict cohort that cannot all start: release never-started members
      // and interrupt started peers; their processes keep their capacity
      // until observed stopped.
      latest = this.repo.saveRound(latest, {
        members: latest.members.map((m) =>
          launches.has(m.memberId) && !started.includes(m.memberId)
            ? {
                ...m,
                launchId: null,
                state: m.state === "failed" ? "failed" : "queued",
              }
            : started.includes(m.memberId)
              ? { ...m, detail: "cohort-restart" }
              : m,
        ),
        detail: `The cohort could not start together (${failure}); started peers are being stopped.`,
      });
      for (const id of started) {
        const attemptId = latest.members.find(
          (m) => m.memberId === id,
        )?.activeAttemptId;
        if (attemptId) await this.driver.interrupt(attemptId).catch(() => {});
      }
    }
    return latest;
  }

  /**
   * Ends a round as stale and returns its goal to the phase that round served,
   * so the next tick freezes a fresh round with current inputs and roster.
   */
  private async retire(
    goal: Goal,
    round: RoleRound,
    reason: string,
  ): Promise<void> {
    const interrupts = round.members
      .map((m) => m.activeAttemptId)
      .filter((v): v is string => !!v);
    this.repo.saveRound(round, { stage: "stale", detail: reason });
    const current = this.repo.require<Goal>(kinds.goal, goal.id);
    if (round.kind !== "coordination" && round.taskKey) {
      const action = this.actions(current).find((a) => a.roundId === round.id);
      if (action && ["admitted", "blocked"].includes(action.state))
        this.saveAction(action, {
          state: "queued",
          roundId: null,
          detail: `Re-admitting: ${reason}`,
        });
    }
    if (current.state === "blocked")
      this.saveGoal(current, {
        state:
          round.kind === "coordination"
            ? "planning"
            : round.kind === "review"
              ? "reviewing"
              : "running",
        detail: reason,
      });
    for (const id of interrupts)
      await this.driver.interrupt(id).catch(() => {});
  }

  /** The owner's explicit restart of a blocked or waiting round with fresh inputs. */
  async restartRound(input: {
    goalId: string;
    roundId: string;
    commandId: string;
  }) {
    const goal = this.repo.require<Goal>(kinds.goal, input.goalId);
    return this.repo.receipt(
      input.commandId,
      goal.projectId,
      "round-restart",
      async () => {
        const round = this.repo.require<RoleRound>(kinds.round, input.roundId);
        if (
          round.goalId !== goal.id ||
          ![
            "blocked",
            "awaiting-user",
            "collecting",
            "reconciling",
            "endorsing",
          ].includes(round.stage)
        )
          throw new Error("Only an open round of this goal can be restarted.");
        if (["paused", "stopped", "accepted"].includes(goal.state))
          throw new Error("Resume the goal first.");
        await this.retire(
          goal,
          round,
          "Restarted by the owner; a fresh round freezes current inputs.",
        );
        this.changed();
        return this.repo.require<Goal>(kinds.goal, goal.id);
      },
    );
  }

  private phaseDone(round: RoleRound): boolean {
    return !round.members.some(
      (m) => m.state === "queued" || m.state === "running" || m.activeAttemptId,
    );
  }

  private async advanceRound(goal: Goal, round: RoleRound): Promise<void> {
    const staleness = this.stale(round, goal);
    if (staleness) {
      await this.retire(goal, round, staleness);
      return;
    }
    if (!activeStages.has(round.stage)) return;
    round = this.collect(goal, round);
    if (!this.phaseDone(round)) {
      await this.launch(goal, round);
      return;
    }
    if (round.kind === "coordination")
      return this.advanceCoordination(goal, round);
    if (round.kind === "review") return this.completeReview(goal, round);
    return this.completeWork(goal, round);
  }

  // -------------------------------------------------------------------------
  // Coordination protocol

  private advanceCoordination(goal: Goal, round: RoleRound): void {
    const contributions = this.contributions(round.id, round.projectId);
    if (round.stage === "collecting" || round.stage === "reconciling") {
      const phase = round.stage === "collecting" ? "initial" : "reconciliation";
      const status = participation(round, contributions, "initial");
      if (!status.satisfied) {
        this.repo.saveRound(round, {
          stage: "blocked",
          detail: `Required participation is missing: ${status.detail} A quorum cannot waive a required contribution.`,
        });
        this.saveGoal(goal, {
          state: "blocked",
          detail: `Coordination blocked: ${status.detail}`,
        });
        return;
      }
      if (phase === "reconciliation") {
        const rec = participation(round, contributions, "reconciliation");
        const electorateMissing = round.electorateIds.filter(
          (id) => !rec.returned.includes(id),
        );
        if (electorateMissing.length) {
          this.repo.saveRound(round, {
            stage: "blocked",
            detail: `Reconciliation is missing from ${electorateMissing.join(", ")}.`,
          });
          this.saveGoal(goal, {
            state: "blocked",
            detail:
              "Coordination blocked: a required reconciliation response is missing.",
          });
          return;
        }
      }
      const latest = new Map<string, ParticipantContribution>();
      for (const c of contributions.filter(
        (c) => countsFor(round, c) && c.phase !== "endorsement",
      ))
        if (phase === "initial" ? c.phase === "initial" : true)
          latest.set(c.memberId, c);
      const proposals = [...latest.values()].map((c) => {
        const o = c.output as {
          actions: PlanTaskAction[];
          assumptions: string[];
          summary: string;
        };
        return {
          contribution: c,
          actions: o.actions,
          assumptions: o.assumptions,
        };
      });
      const combined = combineProposals(proposals);
      if (combined.agreement === "conflict") {
        const summary = combined.conflicts
          .map(
            (c) =>
              `${c.key}: ${[...new Set(c.variants.map((v) => `${v.memberId} proposes "${v.title}"`))].join(" vs ")}`,
          )
          .join("; ");
        if (round.reconciliationTurnsUsed < round.reconciliationTurns) {
          this.repo.saveRound(round, {
            stage: "reconciling",
            reconciliationTurnsUsed: round.reconciliationTurnsUsed + 1,
            detail: `Reconciling ${combined.conflicts.length} planning ${combined.conflicts.length === 1 ? "disagreement" : "disagreements"}: ${summary}`,
            members: round.members.map((m) =>
              round.electorateIds.includes(m.memberId)
                ? {
                    ...m,
                    phase: "reconciliation",
                    state: "queued",
                    retries: 0,
                    detail: "",
                  }
                : m,
            ),
          });
          return;
        }
        this.repo.saveRound(round, {
          stage: "awaiting-user",
          detail: `Unresolved planning disagreement after the bounded exchange: ${summary}`,
        });
        this.saveGoal(goal, {
          state: "blocked",
          detail:
            "The coordinators disagree. Choose a branch to continue; the other proposals stay attributed.",
        });
        return;
      }
      const source =
        phase === "reconciliation"
          ? "reconciled"
          : combined.agreement === "matching"
            ? "matching-proposals"
            : "combined";
      const leadSummary = proposals
        .map((p) => (p.contribution.output as { summary: string }).summary)
        .join(" / ");
      this.propose(
        goal,
        round,
        combined.actions,
        combined.assumptions,
        leadSummary,
        proposals.map((p) => p.contribution.id),
        source,
        proposals,
      );
      return;
    }
    if (round.stage === "endorsing") this.decide(goal, round);
  }

  private propose(
    goal: Goal,
    round: RoleRound,
    actions: PlanTaskAction[],
    assumptions: string[],
    summary: string,
    contributionIds: string[],
    source: DecisionCandidate["source"],
    proposals: Array<{
      contribution: ParticipantContribution;
      actions: PlanTaskAction[];
    }>,
  ): void {
    const digest = candidateDigest(round, actions, assumptions);
    const revision = this.candidates(round.id, round.projectId).length + 1;
    const candidate: DecisionCandidate = {
      id: `${round.id}:candidate:${revision}`,
      projectId: round.projectId,
      goalId: goal.id,
      roundId: round.id,
      revision,
      digest,
      actions,
      summary: summary.slice(0, 20000),
      assumptions,
      contributionIds,
      source,
      expected: {
        goalRevision: round.input.goalRevision,
        planRevision: round.input.planRevision,
        controlGeneration: round.input.controlGeneration,
      },
      createdAt: now(),
    };
    this.repo.immutable(kinds.candidate, candidate);
    // A proposal that already identifies this exact action set supplies its
    // member's endorsement; everyone else gets a short endorsement turn.
    const setDigest = actionSetDigest(actions);
    const implied = new Set<string>();
    for (const p of proposals)
      if (
        source !== "user-direction" &&
        actionSetDigest(p.actions) === setDigest &&
        round.electorateIds.includes(p.contribution.memberId)
      ) {
        implied.add(p.contribution.memberId);
        this.repo.immutable(kinds.endorsement, {
          id: `${candidate.id}:${p.contribution.memberId}:implied`,
          projectId: round.projectId,
          roundId: round.id,
          candidateId: candidate.id,
          candidateDigest: digest,
          memberId: p.contribution.memberId,
          assignmentId: p.contribution.assignmentId,
          contributionId: p.contribution.id,
          stance: "endorse",
          rationale: "Its proposal identifies this exact action set.",
          implied: true,
          createdAt: now(),
        } satisfies DecisionEndorsement);
      }
    const next = this.repo.saveRound(round, {
      stage: "endorsing",
      candidateId: candidate.id,
      detail:
        implied.size === round.electorateIds.length
          ? "All coordinators proposed the same plan."
          : `Asking ${round.electorateIds.length - implied.size} coordinators to endorse candidate ${revision}.`,
      members: round.members.map((m) =>
        round.electorateIds.includes(m.memberId) && !implied.has(m.memberId)
          ? {
              ...m,
              phase: "endorsement",
              state: "queued",
              retries: 0,
              detail: "",
            }
          : m,
      ),
    });
    if (this.phaseDone(next)) this.decide(goal, next);
  }

  private decide(goal: Goal, round: RoleRound): void {
    const candidate = this.repo.require<DecisionCandidate>(
      kinds.candidate,
      round.candidateId!,
    );
    const status = evaluateDecision(
      round,
      candidate.digest,
      this.endorsements(round.id, round.projectId),
    );
    const contributions = this.contributions(round.id, round.projectId);
    const required = participation(round, contributions, "initial");
    if (status.passes && required.satisfied) {
      this.commit(goal, round, candidate, status.detail);
      return;
    }
    if (!this.phaseDone(round) && !status.impossible) return;
    if (round.reconciliationTurnsUsed < round.reconciliationTurns) {
      this.repo.saveRound(round, {
        stage: "reconciling",
        reconciliationTurnsUsed: round.reconciliationTurnsUsed + 1,
        detail: `The candidate did not pass (${status.detail}); one bounded reconciliation follows.`,
        members: round.members.map((m) =>
          round.electorateIds.includes(m.memberId)
            ? {
                ...m,
                phase: "reconciliation",
                state: "queued",
                retries: 0,
                detail: "",
              }
            : m,
        ),
      });
      return;
    }
    this.repo.saveRound(round, {
      stage: "awaiting-user",
      detail: `The decision rule did not pass: ${status.detail} Dissent is retained.`,
    });
    this.saveGoal(goal, {
      state: "blocked",
      detail:
        "The coordinators' decision rule did not pass. Choose a branch or change the decision policy.",
    });
  }

  /**
   * Commits one accepted decision: the plan revision and its queued actions in
   * one transaction, keyed by the candidate so a repeated commit is a no-op.
   */
  private commit(
    goal: Goal,
    round: RoleRound,
    candidate: DecisionCandidate,
    detail: string,
  ): void {
    this.store.transaction(() => {
      const current = this.repo.require<Goal>(kinds.goal, goal.id);
      if (
        ["paused", "stopped", "accepted"].includes(current.state) ||
        current.controlGeneration !== candidate.expected.controlGeneration ||
        current.revision !== candidate.expected.goalRevision ||
        current.planRevision !== candidate.expected.planRevision
      ) {
        this.repo.saveRound(round, {
          stage: "stale",
          detail:
            "The goal changed before commit; this candidate cannot commit.",
        });
        return;
      }
      const planId = `plan:${hash(stable([round.id, candidate.digest])).slice(0, 32)}`;
      if (this.store.get(kinds.plan, planId)) return;
      const previous = this.plan(current);
      const prior = previous ? this.actions(current) : [];
      const plan: CoordinatorPlan = {
        id: planId,
        projectId: goal.projectId,
        goalId: goal.id,
        revision: current.planRevision + 1,
        tasks: candidate.actions,
        decisionCandidateId: candidate.id,
        roundId: round.id,
        supersedesPlanId: previous?.id ?? null,
        createdAt: now(),
      };
      this.repo.immutable(kinds.plan, plan);
      let delegated = 0;
      for (const task of candidate.actions) {
        const carried = previous
          ? prior.find(
              (a) =>
                a.state === "completed" &&
                previous.tasks.some(
                  (t) =>
                    t.key === a.taskKey &&
                    actionDigest(t) === actionDigest(task),
                ),
            )
          : undefined;
        if (!carried) delegated += 1;
        this.repo.saveRevisioned(kinds.action, {
          id: `${planId}:${task.key}`,
          projectId: goal.projectId,
          goalId: goal.id,
          planId,
          taskKey: task.key,
          revision: 1,
          state: carried ? "completed" : "queued",
          expectedControlGeneration: current.controlGeneration,
          roundId: carried?.roundId ?? null,
          attemptIds: carried?.attemptIds ?? [],
          candidateIds: carried?.candidateIds ?? [],
          artifactIds: carried?.artifactIds ?? [],
          detail: carried
            ? `Carried forward unchanged from ${carried.id}.`
            : "",
          createdAt: now(),
          updatedAt: now(),
        } satisfies QueuedPlanAction);
      }
      for (const old of prior)
        if (["queued", "blocked"].includes(old.state))
          this.saveAction(old, {
            state: "cancelled",
            detail: `Superseded by plan revision ${plan.revision}.`,
          });
      this.repo.saveRound(round, {
        stage: "committed",
        detail: `Committed: ${detail}`,
      });
      this.saveGoal(current, {
        planId,
        planRevision: plan.revision,
        state: "running",
        usage: {
          ...current.usage,
          delegatedTasks: current.usage.delegatedTasks + delegated,
        },
        detail: `Plan revision ${plan.revision} committed with ${candidate.actions.length} tasks.`,
      });
    });
  }

  /** The owner's choice between disputed branches: an authorized user decision. */
  async chooseBranch(input: {
    goalId: string;
    roundId: string;
    contributionId: string;
    commandId: string;
  }) {
    const goal = this.repo.require<Goal>(kinds.goal, input.goalId);
    return this.repo.receipt(
      input.commandId,
      goal.projectId,
      "branch-choose",
      () => {
        const round = this.repo.require<RoleRound>(kinds.round, input.roundId);
        if (round.goalId !== goal.id || round.stage !== "awaiting-user")
          throw new Error("This round is not waiting for a decision.");
        const contribution = this.repo.require<ParticipantContribution>(
          kinds.contribution,
          input.contributionId,
        );
        if (
          contribution.roundId !== round.id ||
          !countsFor(round, contribution) ||
          contribution.phase === "endorsement"
        )
          throw new Error("Choose a valid proposal from this round.");
        const o = contribution.output as {
          actions: PlanTaskAction[];
          assumptions: string[];
          summary: string;
        };
        const digest = candidateDigest(round, o.actions, o.assumptions);
        const revision = this.candidates(round.id, round.projectId).length + 1;
        const candidate: DecisionCandidate = {
          id: `${round.id}:candidate:${revision}`,
          projectId: round.projectId,
          goalId: goal.id,
          roundId: round.id,
          revision,
          digest,
          actions: o.actions,
          summary: `Owner chose ${contribution.memberId}'s proposal. ${o.summary}`,
          assumptions: o.assumptions,
          contributionIds: [contribution.id],
          source: "user-direction",
          expected: {
            goalRevision: round.input.goalRevision,
            planRevision: round.input.planRevision,
            controlGeneration: round.input.controlGeneration,
          },
          createdAt: now(),
        };
        this.repo.immutable(kinds.candidate, candidate);
        const latest = this.repo.saveRound(round, {
          candidateId: candidate.id,
        });
        this.commit(
          this.repo.require<Goal>(kinds.goal, goal.id),
          latest,
          candidate,
          `the owner chose ${contribution.memberId}'s proposal; other proposals and dissent stay attributed`,
        );
        this.changed();
        return this.repo.require<Goal>(kinds.goal, goal.id);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Work, integration and review

  private async dispatch(goal: Goal): Promise<void> {
    const plan = this.plan(goal);
    if (!plan) return;
    // Workers wait until every coordinator attempt of the decision is quiescent.
    if (
      this.rounds(goal.id).some(
        (r) =>
          r.kind === "coordination" && r.members.some((m) => m.activeAttemptId),
      )
    )
      return;
    // Work paused or stopped mid-round is re-admitted with fresh inputs.
    for (const action of this.actions(goal).filter(
      (a) => a.state === "admitted" && a.roundId,
    )) {
      const round = this.repo.get<RoleRound>(kinds.round, action.roundId!);
      if (
        round &&
        ["stale", "stopped"].includes(round.stage) &&
        !round.members.some((m) => m.activeAttemptId)
      )
        this.saveAction(action, {
          state: "queued",
          roundId: null,
          detail: "Re-admitting with fresh inputs.",
        });
    }
    const actions = this.actions(goal);
    const done = new Set(
      actions.filter((a) => a.state === "completed").map((a) => a.taskKey),
    );
    for (const action of actions.filter((a) => a.state === "queued")) {
      if (action.expectedControlGeneration !== goal.controlGeneration) {
        this.saveAction(action, {
          expectedControlGeneration: goal.controlGeneration,
        });
        continue;
      }
      const task = plan.tasks.find((t) => t.key === action.taskKey)!;
      if (!task.dependencies.every((d) => done.has(d))) continue;
      if (task.kind === "implementation" && !goal.baselineCandidateId) {
        if (!this.driver.baseline) {
          this.saveAction(action, {
            state: "blocked",
            detail:
              "No controlled workspace route is available for implementation members.",
          });
          continue;
        }
        const baselineCandidateId = await this.driver.baseline(
          goal.projectId,
          goal.id,
        );
        goal = this.saveGoal(this.repo.require<Goal>(kinds.goal, goal.id), {
          baselineCandidateId,
        });
      }
      const round = this.freeze(goal, {
        roleId: task.roleId,
        kind: task.kind === "implementation" ? "work" : "information",
        taskKey: task.key,
        candidateId:
          task.kind === "implementation"
            ? task.key.startsWith("repair-")
              ? goal.candidateId
              : goal.baselineCandidateId
            : null,
        brief: task.brief,
        partitions: task.partitions,
      });
      if ("blocked" in round) {
        if (action.detail !== round.blocked)
          this.saveAction(action, { detail: `Waiting: ${round.blocked}` });
        continue;
      }
      this.saveAction(action, {
        state: "admitted",
        roundId: round.id,
        detail: round.detail,
      });
    }
  }

  private completeWork(goal: Goal, round: RoleRound): void {
    const contributions = this.contributions(round.id, round.projectId);
    const status = participation(round, contributions);
    const action = this.actions(goal).find((a) => a.roundId === round.id);
    const included = contributions.filter((c) => countsFor(round, c));
    const completion: RoleCompletion = {
      id: `${round.id}:completion`,
      projectId: round.projectId,
      goalId: goal.id,
      roundId: round.id,
      kind: round.kind,
      result: status.satisfied ? "satisfied" : "incomplete",
      includedContributionIds: included.map((c) => c.id),
      excluded: round.members
        .filter((m) => !status.returned.includes(m.memberId))
        .map((m) => ({
          memberId: m.memberId,
          contributionId: m.contributionIds.at(-1) ?? null,
          reason: m.detail || m.state,
        })),
      findings: [],
      policy: {
        requiredReturned: status.returned.length,
        requiredTotal: round.requiredContributorIds.length,
        endorsements: null,
        threshold: null,
        detail: status.detail,
      },
      assignmentMap: Object.fromEntries(
        round.members.map((m) => [
          m.memberId,
          {
            assignmentId: m.assignmentId,
            assignmentRevision: m.assignmentRevision,
          },
        ]),
      ),
      inputDigest: round.input.digest,
      candidateId: null,
      createdAt: now(),
    };
    this.repo.immutable(kinds.completion, completion);
    this.repo.saveRound(round, {
      stage: status.satisfied ? "completed" : "blocked",
      completionId: completion.id,
      detail: status.detail,
    });
    if (!action) return;
    if (!status.satisfied) {
      this.saveAction(action, {
        state: "blocked",
        detail: `Required members did not return valid results: ${status.missing.join(", ")}.`,
      });
      this.saveGoal(goal, {
        state: "blocked",
        detail: `Task ${action.taskKey} is incomplete: ${status.detail}`,
      });
      return;
    }
    const candidateIds = included
      .map((c) => (c.output as { candidateId?: string | null })?.candidateId)
      .filter((v): v is string => !!v);
    this.saveAction(action, {
      state: "completed",
      attemptIds: round.members.flatMap((m) => m.attemptIds),
      candidateIds,
      artifactIds: included.map((c) => c.id),
      detail: included
        .map(
          (c) =>
            `${c.memberId}: ${(c.output as { summary?: string })?.summary ?? ""}`,
        )
        .join(" | ")
        .slice(0, 2000),
    });
  }

  private async finishPlan(goal: Goal): Promise<void> {
    const plan = this.plan(goal);
    if (!plan) return;
    const actions = this.actions(goal);
    if (!actions.length || actions.some((a) => a.state !== "completed")) return;
    const implementation = plan.tasks.filter(
      (t) => t.kind === "implementation",
    );
    if (!implementation.length) {
      // A status-style synthesis rendered from recorded facts, with attribution;
      // it never claims code verification for informational work.
      const synthesis = actions
        .map((a) => `${a.taskKey}: ${a.detail || "completed"}`)
        .join("\n");
      this.saveGoal(goal, {
        state: "completed",
        synthesis: `Information goal completed. Each line keeps its contributors:\n${synthesis}\nNo code candidate or check was produced.`,
        detail:
          "Completed with information artifacts; no code verification is claimed.",
      });
      return;
    }
    if (goal.candidateId && goal.state === "reviewing") return;
    const repair = actions.find(
      (a) =>
        a.taskKey.startsWith("repair-") &&
        a.taskKey === implementation.at(-1)?.key,
    );
    const base = repair ? goal.candidateId! : goal.baselineCandidateId!;
    const candidateIds = repair
      ? repair.candidateIds
      : implementation.flatMap(
          (t) => actions.find((a) => a.taskKey === t.key)!.candidateIds,
        );
    if (!this.driver.integrate) {
      this.saveGoal(goal, {
        state: "blocked",
        detail: "No controlled integration route is available.",
      });
      return;
    }
    const result = await this.driver.integrate({
      projectId: goal.projectId,
      goalId: goal.id,
      baseCandidateId: base,
      candidateIds,
    });
    if ("conflicts" in result) {
      this.saveGoal(goal, {
        state: "blocked",
        detail: `Integration conflicts need a decision: ${result.conflicts.join("; ")}`,
      });
      return;
    }
    this.saveGoal(this.repo.require<Goal>(kinds.goal, goal.id), {
      candidateId: result.candidateId,
      reviewCompletionId: null,
      state: "reviewing",
      detail:
        "Integrated candidate captured; the review group reviews this exact candidate.",
    });
  }

  private findingsFor(roundId: string): AggregatedFinding[] {
    return (
      this.repo.get<{ id: string; findings: AggregatedFinding[] }>(
        kinds.findings,
        roundId,
      )?.findings ?? []
    );
  }

  private completeReview(goal: Goal, round: RoleRound): void {
    const contributions = this.contributions(round.id, round.projectId);
    const valid = contributions.filter((c) => countsFor(round, c));
    const observations: FindingObservation[] = valid.flatMap((c) =>
      (
        c.output as {
          findings: Array<
            Omit<FindingObservation, "contributionId" | "memberId">
          >;
        }
      ).findings.map((f) => ({
        ...f,
        contributionId: c.id,
        memberId: c.memberId,
      })),
    );
    const findings = aggregateFindings(
      observations,
      valid.map((c) => c.memberId),
      this.findingsFor(round.id),
    );
    this.store.put(kinds.findings, {
      id: round.id,
      projectId: round.projectId,
      goalId: goal.id,
      findings,
    });
    this.recordReview(goal, round, findings);
  }

  private recordReview(
    goal: Goal,
    round: RoleRound,
    findings: AggregatedFinding[],
  ): void {
    const contributions = this.contributions(round.id, round.projectId);
    const status = reviewStatus(round, contributions, findings);
    const completion: RoleCompletion = {
      id: `${round.id}:completion:${hash(stable(findings.map((f) => [f.key, f.disposition]))).slice(0, 12)}`,
      projectId: round.projectId,
      goalId: goal.id,
      roundId: round.id,
      kind: "review",
      result: status.satisfied
        ? "satisfied"
        : status.complete
          ? "blocked"
          : "incomplete",
      includedContributionIds: contributions
        .filter((c) => countsFor(round, c))
        .map((c) => c.id),
      excluded: round.members
        .filter((m) => status.missing.includes(m.memberId))
        .map((m) => ({
          memberId: m.memberId,
          contributionId: m.contributionIds.at(-1) ?? null,
          reason: m.detail || m.state,
        })),
      findings,
      policy: {
        requiredReturned: status.returned,
        requiredTotal: status.required,
        endorsements: null,
        threshold: null,
        detail: status.detail,
      },
      assignmentMap: Object.fromEntries(
        round.members.map((m) => [
          m.memberId,
          {
            assignmentId: m.assignmentId,
            assignmentRevision: m.assignmentRevision,
          },
        ]),
      ),
      inputDigest: round.input.digest,
      candidateId: round.input.candidateId,
      createdAt: now(),
    };
    this.store.immutable(kinds.completion, completion);
    this.repo.saveRound(round, {
      stage: status.complete ? "completed" : "blocked",
      completionId: completion.id,
      detail: status.detail,
    });
    const current = this.repo.require<Goal>(kinds.goal, goal.id);
    if (status.satisfied)
      this.saveGoal(current, {
        state: "awaiting-acceptance",
        reviewCompletionId: completion.id,
        detail: `Review complete: ${status.detail} The candidate awaits your acceptance.`,
      });
    else if (status.complete)
      this.saveGoal(current, {
        state: "blocked",
        reviewCompletionId: completion.id,
        detail: `${status.blockingFindings} findings need a disposition or a repair. Clean reports do not resolve a finding by omission.`,
      });
    else
      this.saveGoal(current, {
        state: "blocked",
        reviewCompletionId: completion.id,
        detail: `Review incomplete: ${status.detail} A missing or invalid required report is not a pass.`,
      });
  }

  /** A finding-specific disposition by the owner, with its rationale. */
  async decideFinding(input: {
    goalId: string;
    findingKey: string;
    disposition: AggregatedFinding["disposition"];
    rationale: string;
    commandId: string;
  }) {
    const goal = this.repo.require<Goal>(kinds.goal, input.goalId);
    return this.repo.receipt(
      input.commandId,
      goal.projectId,
      "finding-decide",
      () => {
        if (!input.rationale.trim())
          throw new Error("A disposition needs a rationale.");
        const completion = goal.reviewCompletionId
          ? this.repo.require<RoleCompletion>(
              kinds.completion,
              goal.reviewCompletionId,
            )
          : null;
        if (!completion || completion.candidateId !== goal.candidateId)
          throw new Error(
            "A completed review of the current candidate is required.",
          );
        const round = this.repo.require<RoleRound>(
          kinds.round,
          completion.roundId,
        );
        const findings = this.findingsFor(round.id);
        if (!findings.some((f) => f.key === input.findingKey))
          throw new Error("That finding is not in the current review.");
        const next = findings.map((f) =>
          f.key === input.findingKey
            ? {
                ...f,
                disposition: input.disposition,
                dispositionRationale: input.rationale,
                decidedBy: "local-user",
              }
            : f,
        );
        this.store.put(kinds.findings, {
          id: round.id,
          projectId: round.projectId,
          goalId: goal.id,
          findings: next,
        });
        this.recordReview(goal, round, next);
        this.changed();
        return this.repo.require<Goal>(kinds.goal, goal.id);
      },
    );
  }

  /** Admits one bounded repair of the blocking findings; a new review round follows. */
  async repair(input: { goalId: string; commandId: string }) {
    const goal = this.repo.require<Goal>(kinds.goal, input.goalId);
    return this.repo.receipt(
      input.commandId,
      goal.projectId,
      "goal-repair",
      () => {
        if (goal.usage.repairRounds >= goal.grant.maxRepairRounds)
          throw new Error(
            `The goal's repair limit (${goal.grant.maxRepairRounds}) is reached.`,
          );
        const completion = goal.reviewCompletionId
          ? this.repo.require<RoleCompletion>(
              kinds.completion,
              goal.reviewCompletionId,
            )
          : null;
        const blocking =
          completion?.findings.filter((f) =>
            blockingDispositions.has(f.disposition),
          ) ?? [];
        if (!completion || !blocking.length)
          throw new Error("There are no blocking findings to repair.");
        const plan = this.plan(goal)!;
        const files = [...new Set(blocking.map((f) => f.file))].sort();
        const group = this.effective(goal.projectId, goal.id, "implementer");
        const members =
          group.form === "exact"
            ? group.members.length
            : (group.count ?? Math.max(group.members.length, group.minCount));
        const parts = Math.max(1, Math.min(members, files.length));
        const key = `repair-${goal.usage.repairRounds + 1}`;
        const task: PlanTaskAction = {
          key,
          title: `Repair ${blocking.length} findings`,
          kind: "implementation",
          roleId: "implementer",
          dependencies: [],
          permittedOutputs: files,
          acceptanceCriteria: blocking.map(
            (f) => `Resolve: ${f.title} (${f.file}:${f.line})`,
          ),
          brief: blocking
            .map(
              (f) =>
                `${f.severity} ${f.file}:${f.line} ${f.title}\n${f.observations.map((o) => `${o.memberId}: ${o.behavior}`).join("\n")}`,
            )
            .join("\n\n"),
          partitions:
            group.collaboration === "parallel-partitioned" && parts > 1
              ? Array.from({ length: parts }, (_, i) => ({
                  title: `Repair share ${i + 1}`,
                  permittedOutputs: files.filter((_, j) => j % parts === i),
                }))
              : [],
        };
        this.store.transaction(() => {
          const planId = `plan:${hash(stable([plan.id, key])).slice(0, 32)}`;
          const next: CoordinatorPlan = {
            ...plan,
            id: planId,
            revision: goal.planRevision + 1,
            tasks: [...plan.tasks, task],
            supersedesPlanId: plan.id,
            decisionCandidateId: plan.decisionCandidateId,
            createdAt: now(),
          };
          this.repo.immutable(kinds.plan, next);
          for (const a of this.actions(goal))
            this.repo.saveRevisioned(kinds.action, {
              ...a,
              id: `${planId}:${a.taskKey}`,
              planId,
              revision: 1,
              detail: a.state === "completed" ? a.detail : a.detail,
            });
          this.repo.saveRevisioned(kinds.action, {
            id: `${planId}:${key}`,
            projectId: goal.projectId,
            goalId: goal.id,
            planId,
            taskKey: key,
            revision: 1,
            state: "queued",
            expectedControlGeneration: goal.controlGeneration,
            roundId: null,
            attemptIds: [],
            candidateIds: [],
            artifactIds: [],
            detail: "",
            createdAt: now(),
            updatedAt: now(),
          } satisfies QueuedPlanAction);
          this.saveGoal(goal, {
            planId,
            planRevision: next.revision,
            state: "running",
            usage: {
              ...goal.usage,
              repairRounds: goal.usage.repairRounds + 1,
              delegatedTasks: goal.usage.delegatedTasks + 1,
            },
            detail: `Repair ${goal.usage.repairRounds + 1} admitted; a new required review round follows the repaired candidate.`,
          });
        });
        this.changed();
        return this.repo.require<Goal>(kinds.goal, goal.id);
      },
    );
  }

  acceptanceDigest(goalId: string): string {
    const goal = this.repo.require<Goal>(kinds.goal, goalId);
    const completion = goal.reviewCompletionId
      ? this.repo.get<RoleCompletion>(kinds.completion, goal.reviewCompletionId)
      : undefined;
    return hash(
      stable({
        goal: goal.id,
        revision: goal.revision,
        candidate: goal.candidateId,
        completion: completion?.id ?? null,
        findings: completion?.findings.map((f) => [f.key, f.disposition]) ?? [],
      }),
    );
  }

  /** Records the owner's acceptance of the exact reviewed candidate. */
  async accept(input: { goalId: string; digest: string; commandId: string }) {
    const goal = this.repo.require<Goal>(kinds.goal, input.goalId);
    return this.repo.receipt(
      input.commandId,
      goal.projectId,
      "goal-accept",
      () => {
        if (
          goal.state !== "awaiting-acceptance" ||
          input.digest !== this.acceptanceDigest(goal.id)
        )
          throw new Error(
            "Acceptance is stale, or the review group has not completed for this candidate.",
          );
        const completion = this.repo.require<RoleCompletion>(
          kinds.completion,
          goal.reviewCompletionId!,
        );
        if (
          completion.result !== "satisfied" ||
          completion.candidateId !== goal.candidateId
        )
          throw new Error(
            "The current candidate's review completion is not satisfied.",
          );
        const next = this.saveGoal(
          goal,
          {
            state: "accepted",
            acceptance: {
              by: "local-user",
              at: now(),
              digest: input.digest,
              candidateId: goal.candidateId!,
            },
            detail:
              "Accepted: the exact candidate covered by the required review group.",
          },
          true,
        );
        this.changed();
        return next;
      },
    );
  }

  // -------------------------------------------------------------------------
  // The supervisor loop

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.driver.sync?.();
      for (const goal of this.repo.all<Goal>(kinds.goal))
        await this.tickGoal(goal.id);
    } finally {
      this.ticking = false;
    }
  }

  private async tickGoal(goalId: string): Promise<void> {
    let goal = this.repo.require<Goal>(kinds.goal, goalId);
    for (const round of this.rounds(goal.id)) {
      if (
        ["stopped", "stale", "committed", "completed"].includes(round.stage)
      ) {
        // Late results of an ended round stay as history; never as a decision input.
        if (round.members.some((m) => m.activeAttemptId))
          this.collectLate(goal, round);
        continue;
      }
      if (["paused", "stopped"].includes(goal.state)) continue;
      await this.advanceRound(
        goal,
        this.repo.require<RoleRound>(kinds.round, round.id),
      );
      goal = this.repo.require<Goal>(kinds.goal, goal.id);
    }
    if (
      [
        "paused",
        "stopped",
        "accepted",
        "completed",
        "awaiting-acceptance",
      ].includes(goal.state)
    )
      return;
    const rounds = this.rounds(goal.id);
    const open = (kind: RoundKind) =>
      rounds.some(
        (r) =>
          r.kind === kind &&
          (activeStages.has(r.stage) ||
            r.stage === "awaiting-user" ||
            r.stage === "blocked") &&
          !this.stale(r, goal),
      );
    if (goal.state === "planning" && !open("coordination")) {
      const round = this.freeze(goal, {
        roleId: "coordinator",
        kind: "coordination",
        taskKey: null,
      });
      this.saveGoal(
        goal,
        "blocked" in round
          ? { detail: `Coordinators cannot start: ${round.blocked}` }
          : {
              detail: `${round.members.length === 1 ? "The coordinator is" : `${round.members.length} coordinators are`} preparing proposals.`,
            },
      );
      return;
    }
    if (goal.state === "running") {
      await this.dispatch(goal);
      await this.finishPlan(this.repo.require<Goal>(kinds.goal, goal.id));
      return;
    }
    if (goal.state === "reviewing" && goal.candidateId && !open("review")) {
      const round = this.freeze(goal, {
        roleId: "reviewer",
        kind: "review",
        taskKey: null,
        candidateId: goal.candidateId,
      });
      if ("blocked" in round)
        this.saveGoal(goal, {
          detail: `Reviewers cannot start: ${round.blocked}`,
        });
    }
  }

  private collectLate(goal: Goal, round: RoleRound): void {
    const members = round.members.map((m) => {
      if (!m.activeAttemptId) return m;
      const obs = this.driver.observe(m.activeAttemptId);
      if (
        obs.state === "running" ||
        obs.state === "uncertain" ||
        !obs.quiescent
      )
        return m;
      this.repo.immutable(kinds.contribution, {
        id: `${round.id}:${m.activeAttemptId}`,
        projectId: goal.projectId,
        goalId: goal.id,
        roundId: round.id,
        memberId: m.memberId,
        assignmentId: m.assignmentId,
        assignmentRevision: m.assignmentRevision,
        attemptId: m.activeAttemptId,
        phase: m.phase,
        output: null,
        validation: {
          state: "stale",
          reason: `Arrived after the round ended (${round.stage}); kept as history only.`,
        },
        inputDigest: round.input.digest,
        reportedModel: obs.reportedModel,
        provenance: obs.evidence,
        createdAt: now(),
      } satisfies ParticipantContribution);
      return {
        ...m,
        activeAttemptId: null,
        launchId: null,
        state: m.state === "running" ? ("stale" as const) : m.state,
      };
    });
    if (stable(members) !== stable(round.members))
      this.repo.saveRound(round, { members });
  }

  /**
   * After a restart: adopt launches that reached the runtime, keep uncertain
   * executions held, and replay nothing blindly. The next tick continues.
   */
  async recover(): Promise<void> {
    for (const round of this.repo.all<RoleRound>(kinds.round)) {
      if (!round.members.some((m) => m.launchId && !m.activeAttemptId))
        continue;
      const goal = this.repo.require<Goal>(kinds.goal, round.goalId);
      this.collect(goal, round);
    }
  }

  // -------------------------------------------------------------------------
  // Views, derived from persisted state and actual attempts

  statusText(goalId: string): string {
    const view = this.goalView(goalId);
    return [
      `Goal: ${view.goal.objective}`,
      `State: ${view.goal.state}. ${view.goal.detail}`,
      ...view.rounds
        .filter((r) => r.active)
        .map((r) => `${r.roleId}: ${r.progress}`),
      view.actions.length
        ? `Tasks: ${view.actions.filter((a) => a.state === "completed").length} of ${view.actions.length} completed.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  progress(round: RoleRound): string {
    const count = (s: RoundMember["state"]) =>
      round.members.filter((m) => m.state === s).length;
    const n = round.members.length;
    const noun =
      round.kind === "review"
        ? "reviews"
        : round.kind === "coordination"
          ? "proposals"
          : "results";
    const returned = round.members.filter(
      (m) =>
        m.state === "returned" ||
        (m.contributionIds.length && m.phase !== "initial"),
    ).length;
    const running = count("running"),
      queued = count("queued");
    const failed = round.members.filter((m) =>
      ["failed", "invalid", "stopped"].includes(m.state),
    );
    if (round.stage === "reconciling") return round.detail.split(":")[0];
    if (round.stage === "endorsing")
      return `Endorsing candidate: ${round.detail}`;
    if (round.stage === "awaiting-user")
      return "Waiting for your decision on a disagreement.";
    if (["blocked", "stale", "stopped"].includes(round.stage))
      return round.detail;
    if (round.stage === "committed") return "Decision committed.";
    if (round.stage === "completed")
      return `${returned} of ${n} ${noun} returned; complete.`;
    if (
      round.kind === "coordination" &&
      returned === 0 &&
      queued === 0 &&
      running === n
    )
      return n === 2
        ? "Both coordinators preparing proposals."
        : `${n} coordinators preparing proposals.`;
    const waiting = round.members
      .filter((m) => m.state !== "returned")
      .map((m) => m.memberId);
    return `${returned} of ${n} ${noun} returned${running ? `; ${running} running` : ""}${queued ? `; ${queued} queued` : ""}${failed.length ? `; ${failed.map((m) => `${m.memberId} ${m.state}`).join(", ")}` : ""}${waiting.length && waiting.length <= 2 && !queued ? `; waiting for ${waiting.join(" and ")}` : ""}.`;
  }

  goalView(goalId: string) {
    const goal = this.repo.require<Goal>(kinds.goal, goalId);
    const rounds = this.rounds(goal.id);
    const plan = this.plan(goal);
    const completion = goal.reviewCompletionId
      ? this.repo.get<RoleCompletion>(kinds.completion, goal.reviewCompletionId)
      : undefined;
    return {
      goal,
      plan,
      actions: this.actions(goal),
      acceptanceDigest:
        goal.state === "awaiting-acceptance"
          ? this.acceptanceDigest(goal.id)
          : null,
      review: completion ?? null,
      rounds: rounds.map((r) => ({
        id: r.id,
        roleId: r.roleId,
        kind: r.kind,
        taskKey: r.taskKey,
        stage: r.stage,
        active: activeStages.has(r.stage) || r.stage === "awaiting-user",
        progress: this.progress(r),
        detail: r.detail,
        threshold: r.threshold,
        electorate: r.electorateIds.length,
        members: r.members.map((m) => {
          const a = this.repo.assignmentRevision(
            m.assignmentId,
            m.assignmentRevision,
          );
          const latest = m.contributionIds.length
            ? this.repo.get<ParticipantContribution>(
                kinds.contribution,
                m.contributionIds.at(-1)!,
              )
            : undefined;
          return {
            ...m,
            requestedModel: a?.model ?? m.model,
            modelLabel: a?.modelLabel ?? null,
            effectiveModel: latest?.reportedModel ?? null,
            selection: a?.selection ?? null,
            reason: a?.reason ?? "",
            route: a?.route ?? null,
            latestValidation: latest?.validation ?? null,
          };
        }),
        contributions: this.contributions(r.id, r.projectId).map((c) => ({
          id: c.id,
          memberId: c.memberId,
          phase: c.phase,
          validation: c.validation,
          reportedModel: c.reportedModel,
          summary:
            (
              c.output as {
                summary?: string;
                rationale?: string;
                stance?: string;
              }
            )?.summary ??
            ((c.output as { stance?: string })?.stance
              ? `${(c.output as { stance: string }).stance}: ${(c.output as { rationale: string }).rationale}`
              : null),
        })),
        endorsements: this.endorsements(r.id, r.projectId).map((e) => ({
          memberId: e.memberId,
          stance: e.stance,
          implied: e.implied,
          candidateId: e.candidateId,
          rationale: e.rationale,
        })),
        findings: r.kind === "review" ? this.findingsFor(r.id) : [],
      })),
    };
  }

  view(projectId: string) {
    const conversations = this.repo.all<CoordinatorConversation>(
      kinds.conversation,
      projectId,
    );
    const roles = this.repo.roles(projectId);
    const goals = this.repo
      .all<Goal>(kinds.goal, projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const routes = this.driver.routes(projectId);
    return {
      policy: this.repo.policy(projectId),
      capacity: this.driver.capacity(),
      routes: routes.map((r) => ({
        provider: r.provider,
        installationId: r.installationId,
        route: r.route,
        accountLabel: r.accountLabel,
        fanout: r.fanout,
        catalog: { observedAt: r.catalog.observedAt, fresh: r.catalog.fresh },
        models: r.catalog.models.map((m) => ({
          id: m.id,
          model: m.model,
          name: m.name,
          efforts: m.supportedReasoningEfforts ?? [],
        })),
        purposes: r.purposes,
      })),
      roles: roles.map((role) => {
        const group = this.effective(projectId, null, role.id);
        return { role, group };
      }),
      // Compatibility readers: one-member records written before role groups,
      // shown as singleton groups without rewriting the records themselves.
      legacy: {
        drafts: this.repo
          .all<WorkflowDraft>("workflow-draft", projectId)
          .map((d) => ({
            id: d.id,
            workflowId: d.workflowId,
            groups: legacyDraftGroups(d.draft, d.id),
          })),
        presets: this.repo
          .all<{
            id: string;
            name: string;
            assignments: Array<{
              role: string;
              memberId?: string;
              provider: "codex" | "claude";
              installationId: string;
              model: string;
            }>;
          }>("routing-preset", projectId)
          .map((p) => ({
            id: p.id,
            name: p.name,
            groups: presetGroups(p),
          })),
      },
      conversations: conversations.map((c) => ({
        ...c,
        messages: this.repo
          .all<CoordinatorMessage>(kinds.message, projectId)
          .filter((m) => m.conversationId === c.id)
          .sort((a, b) => a.sequence - b.sequence),
      })),
      goals: goals.map((g) => ({
        ...this.goalView(g.id),
        groups: roles.map((role) => {
          const group = this.effective(projectId, g.id, role.id);
          const assignments = this.repo
            .all<ResolvedMemberAssignment>(kinds.assignment, projectId)
            .filter((a) => a.goalId === g.id && a.roleId === role.id);
          return { roleId: role.id, title: role.title, group, assignments };
        }),
      })),
    };
  }
}
