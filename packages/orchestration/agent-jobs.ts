import { z } from "zod";
import { hash, now, safeError, stable } from "../domain/invariants";
import type {
  ExecutionPurpose,
  Goal,
  ParticipantContribution,
  PlanTaskAction,
  QueuedPlanAction,
  RoleRound,
} from "../domain/role-groups";
import type { Store } from "../persistence/store";
import type { ToolBinding } from "../providers/contract";
import { validateActions } from "./contracts";
import { agentJobTools } from "../domain/agent-job-tools";

export { agentJobTools };

/**
 * Scoped cross-engine delegation (docs/Subscription_Runtime_Architecture_Plan.md
 * Phase 6, §7). A coordinator turn that holds a delegation authority can ask
 * Topsl for child work through `start_agent_job`, `get_agent_job` and
 * `cancel_agent_job`, from Claude Code (Topsl's MCP server) or the native
 * harness (core tools). Topsl owns every job: it validates the request
 * against the authority the driver recorded for the attempt, records it
 * durably before anything runs, and admits it as an ordinary plan action
 * once the coordinator's plan has committed. The child is then scheduled,
 * reviewed and integrated like any other task, on whichever engine its role
 * resolves to. Model-supplied identifiers are references to validate, never
 * authority.
 */

/** Owner preference id; anything but an explicit `true` reads as off. */
export const agentJobsPreferenceId = "agent-jobs";

export function agentJobsEnabled(store: Store): boolean {
  return (
    store.get<{ value: unknown }>("preference", agentJobsPreferenceId)?.value ===
    true
  );
}

/** Recorded by the driver for one coordinator attempt when the gate is on. */
export interface AgentJobAuthority {
  /** The attempt ID. */
  id: string;
  projectId: string;
  goalId: string;
  roundId: string;
  memberId: string;
  controlGeneration: number;
  createdAt: string;
}

export type AgentJobState =
  | "requested"
  | "admitted"
  | "completed"
  | "blocked"
  | "cancelled";

export interface AgentJob {
  /** Deterministic: the parent attempt and its idempotency key. */
  id: string;
  projectId: string;
  goalId: string;
  parentAttemptId: string;
  parentRoundId: string;
  parentMemberId: string;
  controlGeneration: number;
  idempotencyKey: string;
  requestDigest: string;
  task: PlanTaskAction;
  state: AgentJobState;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

/** At most this many jobs per coordinator attempt, within the goal's grant. */
export const maxJobsPerAttempt = 8;

const requestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    brief: z.string().trim().min(1).max(20_000),
    kind: z.enum(["implementation", "information"]),
    role: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
    permitted_outputs: z.array(z.string().min(1).max(500)).max(200).default([]),
    acceptance_criteria: z.array(z.string().min(1).max(2_000)).max(50).default([]),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .strict();

/** The engine operations the job service needs; the orchestrator implements them. */
export interface AgentJobEngine {
  goal(goalId: string): Goal | undefined;
  round(roundId: string): RoleRound | undefined;
  actions(goal: Goal): QueuedPlanAction[];
  rounds(goalId: string): RoleRound[];
  contributions(roundId: string, projectId: string): ParticipantContribution[];
  roles(projectId: string): Array<{ id: string; purpose: ExecutionPurpose }>;
  /** Appends the task to the goal's committed plan as a queued action. */
  admit(goal: Goal, task: PlanTaskAction, actor: string): void;
  /** Cancels a queued, not yet started action; false when it has started. */
  cancelQueued(goal: Goal, taskKey: string): boolean;
}

/** What a tool call answers: text for the model, and whether it succeeded. */
export interface AgentJobAnswer {
  ok: boolean;
  text: string;
}

const terminalGoal = new Set(["stopped", "accepted", "completed"]);

export class AgentJobService {
  constructor(
    private store: Store,
    private engine: AgentJobEngine,
  ) {}

  /** The tools' one entry point: `tool` is the unprefixed tool name. */
  call(attemptId: string, callId: string, tool: string, args: unknown): AgentJobAnswer {
    try {
      switch (tool) {
        case "start_agent_job":
          return this.answer(this.start(attemptId, callId, args));
        case "get_agent_job":
          return this.answer(this.view(attemptId, jobIdOf(args)));
        case "cancel_agent_job":
          return this.answer(this.cancel(attemptId, jobIdOf(args)));
        default:
          return { ok: false, text: "Topsl has no such job tool." };
      }
    } catch (error) {
      return { ok: false, text: safeError(error) };
    }
  }

  private answer(value: unknown): AgentJobAnswer {
    return { ok: true, text: JSON.stringify(value) };
  }

  /** The authority the driver recorded for this attempt; never the model's word. */
  authority(attemptId: string): AgentJobAuthority {
    if (!agentJobsEnabled(this.store))
      throw new Error("Agent jobs are turned off in Topsl's settings.");
    const authority = this.store.get<AgentJobAuthority>(
      "agent-job-authority",
      attemptId,
    );
    if (!authority)
      throw new Error("This turn has no authority to request agent jobs.");
    return authority;
  }

  start(attemptId: string, callId: string, args: unknown) {
    const authority = this.authority(attemptId);
    const parsed = requestSchema.safeParse(args ?? {});
    if (!parsed.success)
      throw new Error(
        `The job request is invalid: ${parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "request"}: ${i.message}`)
          .join("; ")}`,
      );
    const request = parsed.data;
    const key = request.idempotency_key ?? callId;
    const id = hash(stable(["agent-job", attemptId, key])).slice(0, 32);
    const role =
      request.role ??
      (request.kind === "implementation" ? "implementer" : "researcher");
    const task: PlanTaskAction = {
      key: `job-${id.slice(0, 12)}`,
      title: request.title,
      kind: request.kind,
      roleId: role,
      dependencies: [],
      permittedOutputs: request.permitted_outputs,
      acceptanceCriteria: request.acceptance_criteria,
      brief: request.brief,
      partitions: [],
    };
    const digest = hash(stable(task));
    return this.store.transaction(() => {
      const existing = this.store.get<AgentJob>("agent-job", id);
      if (existing) {
        if (existing.requestDigest !== digest)
          throw new Error(
            `Idempotency key ${JSON.stringify(key.slice(0, 80))} already names a different job request; nothing new was started.`,
          );
        return this.describe(existing);
      }
      const goal = this.engine.goal(authority.goalId);
      if (!goal || goal.projectId !== authority.projectId)
        throw new Error("The turn's goal no longer exists.");
      if (
        goal.controlGeneration !== authority.controlGeneration ||
        terminalGoal.has(goal.state) ||
        goal.state === "paused"
      )
        throw new Error(
          "The goal was stopped, paused or changed since this turn started; no job was started.",
        );
      const mine = [
        ...this.store.iterate<AgentJob>("agent-job", {
          projectId: goal.projectId,
        }),
      ].filter((j) => j.goalId === goal.id);
      if (mine.filter((j) => j.parentAttemptId === attemptId).length >= maxJobsPerAttempt)
        throw new Error(
          `A turn may request at most ${maxJobsPerAttempt} agent jobs.`,
        );
      const pending = mine.filter((j) => j.state === "requested").length;
      const round = this.engine.round(authority.roundId);
      const roles = this.engine.roles(goal.projectId);
      const problems = validateActions([task], {
        knownRoles: roles
          .filter((r) => !goal.loop || goal.loop.activeRoles.includes(r.id))
          .map((r) => r.id),
        allowedKinds: goal.grant.taskKinds,
        remainingTasks:
          goal.grant.maxDelegatedTasks - goal.usage.delegatedTasks - pending,
        rosters: round?.input.rosters ?? {},
        rolePurposes: Object.fromEntries(roles.map((r) => [r.id, r.purpose])),
      });
      if (problems.length) throw new Error(problems.join(" "));
      const at = now();
      const job: AgentJob = {
        id,
        projectId: goal.projectId,
        goalId: goal.id,
        parentAttemptId: attemptId,
        parentRoundId: authority.roundId,
        parentMemberId: authority.memberId,
        controlGeneration: authority.controlGeneration,
        idempotencyKey: key,
        requestDigest: digest,
        task,
        state: "requested",
        detail:
          "Recorded. Topsl starts it once the coordinators' plan is committed.",
        createdAt: at,
        updatedAt: at,
      };
      this.store.put("agent-job", job);
      return this.describe(job);
    });
  }

  /** A job the caller's goal owns, or an error that reveals nothing else. */
  private owned(attemptId: string, jobId: string): AgentJob {
    const authority = this.authority(attemptId);
    const job = this.store.get<AgentJob>("agent-job", jobId);
    if (
      !job ||
      job.projectId !== authority.projectId ||
      job.goalId !== authority.goalId
    )
      throw new Error("No such agent job for this goal.");
    return job;
  }

  view(attemptId: string, jobId: string) {
    return this.describe(this.owned(attemptId, jobId));
  }

  cancel(attemptId: string, jobId: string) {
    const job = this.owned(attemptId, jobId);
    if (job.state === "requested") {
      return this.describe(
        this.save(job, { state: "cancelled", detail: "Cancelled before it started." }),
      );
    }
    if (job.state === "admitted") {
      const goal = this.engine.goal(job.goalId);
      if (goal && this.engine.cancelQueued(goal, job.task.key))
        return this.describe(
          this.save(job, {
            state: "cancelled",
            detail: "Cancelled before a member started it.",
          }),
        );
      throw new Error(
        "The job is already running. Topsl stops running work only with its goal; stop the goal to cancel it.",
      );
    }
    return this.describe(job);
  }

  private save(job: AgentJob, next: Partial<AgentJob>): AgentJob {
    const saved = { ...job, ...next, updatedAt: now() };
    this.store.put("agent-job", saved);
    return saved;
  }

  /**
   * Called by the engine each tick for a goal. Admits requested jobs once the
   * goal's plan has committed and its generation still matches, cancels jobs
   * a stop or restart fenced, and mirrors admitted jobs' action states.
   */
  settle(goal: Goal): void {
    const jobs = [
      ...this.store.iterate<AgentJob>("agent-job", { projectId: goal.projectId }),
    ].filter((j) => j.goalId === goal.id);
    if (!jobs.length) return;
    const actions = new Map(this.engine.actions(goal).map((a) => [a.taskKey, a]));
    let current = goal;
    for (const job of jobs) {
      if (job.state === "requested") {
        if (
          job.controlGeneration !== current.controlGeneration ||
          terminalGoal.has(current.state)
        ) {
          this.save(job, {
            state: "cancelled",
            detail: "The goal was stopped or restarted before the job started.",
          });
          continue;
        }
        if (
          current.state === "checking" ||
          current.state === "awaiting-acceptance"
        ) {
          this.save(job, {
            state: "blocked",
            detail:
              "The goal finished its plan before the job could join it; nothing was started.",
          });
          continue;
        }
        if (current.state !== "running" || !current.planId) continue;
        try {
          this.engine.admit(current, job.task, `agent job ${job.id.slice(0, 8)}`);
          this.save(job, {
            state: "admitted",
            detail: "Admitted as a task of the goal's plan.",
          });
          // Each admission is a new plan revision.
          current = this.engine.goal(goal.id) ?? current;
        } catch (error) {
          this.save(job, { state: "blocked", detail: safeError(error) });
        }
        continue;
      }
      if (job.state !== "admitted") continue;
      const action = actions.get(job.task.key);
      if (!action) continue;
      if (action.state === "completed")
        this.save(job, { state: "completed", detail: "The task completed." });
      else if (action.state === "cancelled")
        this.save(job, {
          state: "cancelled",
          detail: action.detail || "The task was cancelled.",
        });
      else if (action.state === "blocked")
        this.save(job, {
          state: "blocked",
          detail: action.detail || "The task is blocked.",
        });
    }
  }

  /** The status a tool returns: state, the task's round and a concise result. */
  describe(job: AgentJob) {
    const goal = this.engine.goal(job.goalId);
    const action = goal
      ? this.engine.actions(goal).find((a) => a.taskKey === job.task.key)
      : undefined;
    const rounds = goal
      ? this.engine.rounds(goal.id).filter((r) => r.taskKey === job.task.key)
      : [];
    const round = rounds.at(-1);
    const result = round
      ? this.engine
          .contributions(round.id, job.projectId)
          .filter((c) => c.validation.state === "valid")
          .map((c) => summaryOf(c.output))
          .filter((s): s is string => !!s)
          .at(-1)
      : undefined;
    const status =
      job.state === "requested"
        ? "queued"
        : job.state === "admitted"
          ? goal?.state === "stopped"
            ? "stopping"
            : action?.state === "admitted"
              ? "running"
              : "queued"
          : job.state;
    return {
      job_id: job.id,
      status,
      title: job.task.title,
      kind: job.task.kind,
      role: job.task.roleId,
      task_key: job.task.key,
      detail: (round?.detail || job.detail).slice(0, 1_000),
      round: round
        ? { stage: round.stage, members: round.members.map((m) => ({ member: m.memberId, provider: m.provider, state: m.state })) }
        : null,
      result: result?.slice(0, 4_000) ?? null,
      note: "Topsl integrates and reviews this work with the goal; its result also reaches later rounds through the goal.",
    };
  }
}

function jobIdOf(args: unknown): string {
  const id = (args as { job_id?: unknown } | null)?.job_id;
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
    throw new Error("job_id must be a job ID that start_agent_job returned.");
  return id;
}

function summaryOf(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { summary?: unknown; answer?: unknown };
  return typeof o.summary === "string"
    ? o.summary
    : typeof o.answer === "string"
      ? o.answer
      : null;
}


/**
 * A Claude Code turn carries one toolset. A coordinator that may request
 * agent jobs gets them beside its candidate reader, under the reader's
 * namespace, answered by the job service with the attempt's own authority.
 */
export function withAgentJobTools(
  binding: ToolBinding,
  jobs: AgentJobService,
  attemptId: string,
): ToolBinding {
  const names = new Set<string>(agentJobTools.map((t) => t.name));
  return {
    toolset: {
      ...binding.toolset,
      tools: [
        ...binding.toolset.tools,
        ...agentJobTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as unknown as Record<string, unknown>,
        })),
      ],
    },
    async call(call) {
      if (!names.has(call.tool)) return binding.call(call);
      const answer = jobs.call(attemptId, call.callId, call.tool, call.arguments);
      return { text: answer.text, success: answer.ok };
    },
  };
}
