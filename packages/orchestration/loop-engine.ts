import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type { Project } from "../domain/types";
import {
  LOOP_FEATURE_FLAG,
  activeRoleCountProblem,
  functionPurpose,
  loopPolicySchema,
  requiredFunctions,
  type ActiveRolePurposeBinding,
  type AdaptationDecision,
  type AssignmentRevisionRef,
  type CriterionAssessment,
  type CriterionVerification,
  type GoalAssessment,
  type IterationContract,
  type LoopCheckpoint,
  type LoopCriterion,
  type LoopDecisionRecord,
  type LoopDecisionStage,
  type LoopExpected,
  type LoopFunction,
  type LoopGoal,
  type LoopIntent,
  type LoopIteration,
  type LoopMode,
  type LoopOpportunity,
  type LoopOutcome,
  type LoopOverride,
  type LoopPolicy,
  type LoopPolicyInput,
  type LoopRound,
  type LoopRun,
  type LoopUsage,
  type LoopWaitReason,
  type LoopWakeup,
  type PromotionDecision,
  type PublicationCursor,
  type TeamTopologyRevision,
  type TopologyRole,
} from "../domain/recursive-loops";
import {
  roleGroupSettingsSchema,
  type DecisionEndorsement,
  type Goal,
  type GoalLoopBinding,
  type MemberIntent,
  type ParticipantContribution,
  type ResolvedMemberAssignment,
  type RoleCompletion,
  type RoleDefinition,
  type RoleGroupSettings,
  type RoleRound,
  type RoundMember,
} from "../domain/role-groups";
import type { Store } from "../persistence/store";
import {
  functionsOf,
  type AttemptObservation,
  type MemberTurn,
  type OrchestrationDriver,
  type Orchestrator,
} from "./engine";
import { kinds, type OrchestrationRepository } from "./repository";
import { goalComplexity, parseMembership } from "./membership";
import { freezePolicy } from "./policy";
import { admit, memberWeight } from "./schedule";
import { modelEvidence } from "./selection";
import { endorsementSchema, parseFinal } from "./contracts";
import {
  loopEndorsementPrompt,
  loopInputDigest,
  loopPrompt,
  operationsDigest,
  opportunityFingerprint,
  parseEnvelope,
  priorityScore,
  type LoopDecision,
  type LoopPromptContext,
  type TeamOperation,
} from "./loop-contracts";
import type { LoopDriver } from "./loop-checkpoints";
import {
  checkChange,
  rankModels,
  shouldRevert,
  topologyDigest,
} from "./adaptation";

/** Record kinds Recursive Looping writes to the encrypted store. */
export const loopKinds = {
  run: "loop-run",
  active: "loop-active",
  goal: "loop-goal",
  iteration: "loop-iteration",
  checkpoint: "loop-checkpoint",
  assessment: "loop-goal-assessment",
  promotion: "loop-promotion",
  topology: "loop-topology",
  override: "loop-override",
  opportunity: "loop-opportunity",
  outcome: "loop-outcome",
  adaptation: "loop-adaptation",
  policy: "loop-policy",
  wakeup: "loop-wakeup",
  intent: "loop-intent",
  round: "loop-round",
  contribution: "loop-contribution",
  decision: "loop-decision",
  evidence: "loop-checkpoint-evidence",
  artifact: "loop-artifact",
  authorization: "loop-check-authorization",
  usage: "loop-usage",
  cursor: "loop-publication-cursor",
  event: "loop-event",
} as const;

/** The actor every machine decision of a loop is attributed to. */
export const LOOP_ACTOR = "loop-policy";

/** Fewer remaining turns than this cannot carry an iteration's decisions and work. */
const MIN_ITERATION_TURNS = 4;

const terminalIteration: ReadonlySet<LoopIteration["state"]> = new Set([
  "promoted",
  "rejected",
  "no-work",
  "cancelled",
]);

interface ActiveIndex {
  id: string;
  projectId: string;
  runId: string;
  lastAdmissionAt: string | null;
}

interface CheckpointEvidence {
  id: string;
  projectId: string;
  conversationId: string;
  runId: string;
  checkpointId: string;
  candidateId: string;
  definitionId: string;
  verificationId: string;
  result: string;
  evidenceArtifactId: string | null;
  at: string;
}

interface LoopArtifact {
  id: string;
  projectId: string;
  conversationId: string;
  runId: string;
  iterationId: string;
  goalIds: string[];
  goalVersions: Record<string, number>;
  summary: string;
  memberId: string;
}

interface LoopContribution {
  id: string;
  projectId: string;
  conversationId: string;
  runId: string;
  roundId: string;
  memberId: string;
  assignmentId: string;
  assignmentRevision: number;
  attemptId: string;
  phase: RoundMember["phase"];
  protocol: {
    kind: "recursive-loop-v1";
    stage: LoopDecisionStage;
    schemaVersion: 1;
  };
  output: unknown;
  validation: ParticipantContribution["validation"];
  inputDigest: string;
  reportedModel: string | null;
  createdAt: string;
}

export interface LoopGoalInput {
  text: string;
  required?: boolean;
  priority?: number;
  kind?: "code" | "information";
  criteria?: Array<{ text: string; verification: CriterionVerification }>;
  /** Indexes into the same list, or existing goal IDs. */
  dependsOn?: Array<number | string>;
  constraints?: string[];
}

export interface LoopSupervisorOptions {
  /** Whether experimental.recursiveLooping is enabled. Default: enabled. */
  enabled?: () => boolean;
  /** The scheduling clock, in milliseconds; tests may advance it. */
  clock?: () => number;
  /** Where checkpoint exports are written. */
  exportRoot?: string;
}

const verbs =
  "add|make|ensure|fix|improve|implement|remove|update|document|write|create|support|keep|reduce|speed|refactor|simplify|migrate|replace|rename|delete|test|verify|clarify|harden|prevent|allow|enable|disable|expose|show|let|handle|cover|research|investigate|plan|produce|design";

/**
 * Splits a request into goals. Lists and lines are goals; a single sentence
 * is split at commas or "and" only where the next part starts with an
 * action, so "Make sync reliable, add the controls, and ensure restart
 * keeps teams" is three goals. Membership and run instructions are not goals.
 */
export function splitGoals(text: string): string[] {
  const instruction =
    /^(?:work until\b|choose (?:everything|the rest|all|the (?:roles|models|agents)).*automatically|decide the (?:roles|models).*automatically|use (?:exactly )?.+ as (?:the )?(?:exact )?(?:coordinators?|reviewers?|implementers?)|include .+ (?:among|as) (?:the )?\w+|use (?:\w+ )?(?:coordinators?|reviewers?|implementers?)$|keep improving\b|prioriti[sz]e\b|do not use (?:provider )?\w+$)/i;
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  const pieces =
    lines.length > 1
      ? lines
      : text
          .split(/(?<=[.!?])\s+(?=[A-Z])/)
          .flatMap((sentence) =>
            sentence
              .replace(/[.!?]+$/, "")
              .split(
                new RegExp(
                  `\\s*(?:,\\s*(?:and\\s+)?|;\\s*|\\s+and\\s+)(?=(?:${verbs})\\b)`,
                  "i",
                ),
              ),
          );
  return pieces
    .map((p) => p.replace(/[.;]+$/, "").trim())
    .filter((p) => p.length > 2 && !instruction.test(p))
    .map((p) => p[0].toUpperCase() + p.slice(1));
}

/** "Prioritize reliability, synchronization and clarity of the interface." */
export function parsePriorities(text: string): string[] {
  const m = /prioriti[sz]e\s+([^.;\n]+)/i.exec(text);
  if (!m) return [];
  return m[1]
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The longest rolling window a policy may set (31 days). */
const RECENT_HORIZON_MS = 31 * 86_400_000;

/**
 * Keeps the rolling-window history bounded without losing turns. Entries
 * older than the longest possible window are dropped; adjacent entries are
 * merged while the merged span is at most 1/64 of its age. A merged entry is
 * dated by its latest turn, so a window may count a turn slightly longer than
 * strictly due (by at most 1/64 of the window), never shorter: the allowance
 * errs toward waiting. Roughly 64 entries per doubling of age remain, so the
 * history stays near 1,500 entries however many updates a window holds.
 */
export function compactRecent(
  recent: LoopUsage["recent"],
  nowMs: number,
): LoopUsage["recent"] {
  const out: LoopUsage["recent"] = [];
  for (const r of recent) {
    const at = Date.parse(r.at);
    if (at < nowMs - RECENT_HORIZON_MS) continue;
    const last = out.at(-1);
    const from = last?.from ?? last?.at;
    if (last && from && at - Date.parse(from) <= (nowMs - at) / 64)
      out[out.length - 1] = {
        at: Date.parse(last.at) > at ? last.at : r.at,
        turns: last.turns + r.turns,
        from,
      };
    else out.push(r);
  }
  return out;
}

const describeKind = (v: CriterionVerification) =>
  v.kind === "check" ? `check ${v.checkId}` : v.kind;

/**
 * The deterministic Loop Supervisor above the coordinator engine. It owns run
 * state, iteration creation, goal assessment, the active organization, the
 * accepted checkpoint, cumulative accounting and run controls. Model
 * coordinators propose decisions in the recursive-loop-v1 protocol; the
 * supervisor validates and commits them. Execution, attempts, leases, tools,
 * permissions, workspace capture and process lifecycle stay with the existing
 * engine, driver and runtime.
 */
export class LoopSupervisor {
  readonly repo: OrchestrationRepository;
  private ticking = false;
  private lastTick: number | null = null;
  constructor(
    readonly store: Store,
    readonly orchestrator: Orchestrator,
    private driver: OrchestrationDriver,
    private loop: LoopDriver,
    private changed: () => void = () => {},
    private options: LoopSupervisorOptions = {},
  ) {
    this.repo = orchestrator.repo;
    orchestrator.stopListeners.push((projectId, commandId) =>
      this.stopProject(projectId, commandId),
    );
  }

  private ms() {
    return this.options.clock?.() ?? Date.now();
  }
  private iso(ms = this.ms()) {
    return new Date(ms).toISOString();
  }
  private enabled() {
    return !this.options.enabled || this.options.enabled();
  }
  private assertEnabled() {
    if (!this.enabled())
      throw new Error(
        `Recursive Looping is experimental and off. Turn on ${LOOP_FEATURE_FLAG} first.`,
      );
  }

  // -------------------------------------------------------------------------
  // Records

  run(runId: string): LoopRun {
    return this.repo.require<LoopRun>(loopKinds.run, runId);
  }
  policy(runId: string): LoopPolicy {
    return this.repo.require<LoopPolicy>(loopKinds.policy, runId);
  }
  private scoped<T>(kind: string, run: Pick<LoopRun, "id" | "projectId">): T[] {
    return [
      ...this.store.iterate<T>(kind, {
        projectId: run.projectId,
        conversationId: run.id,
      }),
    ];
  }
  goals(run: Pick<LoopRun, "id" | "projectId">): LoopGoal[] {
    return this.scoped<LoopGoal>(loopKinds.goal, run).sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  iterations(run: Pick<LoopRun, "id" | "projectId">): LoopIteration[] {
    return this.scoped<LoopIteration>(loopKinds.iteration, run).sort(
      (a, b) => a.number - b.number,
    );
  }
  checkpoint(id: string): LoopCheckpoint {
    return this.repo.require<LoopCheckpoint>(loopKinds.checkpoint, id);
  }
  topology(id: string): TeamTopologyRevision {
    return this.repo.require<TeamTopologyRevision>(loopKinds.topology, id);
  }
  overrides(run: Pick<LoopRun, "id" | "projectId">): LoopOverride[] {
    return this.scoped<LoopOverride>(loopKinds.override, run)
      .filter((o) => !o.releasedBy)
      .sort((a, b) => a.revision - b.revision);
  }
  private usageRecord(run: LoopRun): LoopUsage {
    return this.repo.require<LoopUsage>(loopKinds.usage, run.cumulativeUsageId);
  }
  private saveRun(run: LoopRun, next: Partial<LoopRun>): LoopRun {
    const current = this.repo.get<LoopRun>(loopKinds.run, run.id) ?? run;
    return this.repo.saveRevisioned(loopKinds.run, {
      ...current,
      ...next,
      revision: current.revision + 1,
      updatedAt: now(),
    });
  }
  private saveIteration(
    it: LoopIteration,
    next: Partial<LoopIteration>,
  ): LoopIteration {
    const current =
      this.repo.get<LoopIteration>(loopKinds.iteration, it.id) ?? it;
    return this.repo.saveRevisioned(loopKinds.iteration, {
      ...current,
      ...next,
      revision: current.revision + 1,
    });
  }
  private saveGoal(goal: LoopGoal, next: Partial<LoopGoal>): LoopGoal {
    const current = this.repo.get<LoopGoal>(loopKinds.goal, goal.id) ?? goal;
    const value = { ...current, ...next, updatedAt: now() };
    this.store.save(loopKinds.goal, value);
    return value;
  }
  /** Every loop event carries run, iteration and revision attribution. */
  private event(
    run: LoopRun,
    kind: string,
    detail: string,
    extra: Record<string, unknown> = {},
  ) {
    const body = {
      id: uid(),
      projectId: run.projectId,
      conversationId: run.id,
      runId: run.id,
      iterationId: run.currentIterationId,
      kind,
      detail,
      revisions: {
        run: run.revision,
        controlGeneration: run.controlGeneration,
        goalSet: run.goalSetRevision,
        policy: run.policyRevision,
        overrides: run.overrideRevision,
        topology: run.topologyRevisionId,
        checkpoint: run.acceptedCheckpointId,
      },
      ...extra,
      at: now(),
    };
    this.store.immutable(loopKinds.event, body);
    this.store.event(`loop.${kind}`, body);
  }

  // -------------------------------------------------------------------------
  // Owner commands. Each runs once per command ID.

  async create(input: {
    projectId: string;
    conversationId?: string | null;
    mode: LoopMode;
    title?: string;
    text?: string;
    goals?: LoopGoalInput[];
    policy?: LoopPolicyInput;
    commandId: string;
  }) {
    this.assertEnabled();
    this.repo.require<Project>("project", input.projectId);
    return this.repo.receipt(
      input.commandId,
      input.projectId,
      "loop-create",
      async () => {
        const text = input.text?.trim() ?? "";
        const goalInputs: LoopGoalInput[] = input.goals?.length
          ? input.goals
          : input.mode === "goal"
            ? splitGoals(text).map((t) => ({ text: t }))
            : [];
        if (input.mode === "goal" && !goalInputs.length)
          throw new Error("Goal mode needs at least one goal.");
        const policyInput = { ...(input.policy ?? {}) } as LoopPolicyInput;
        if (input.mode === "endless" && !policyInput.priorities?.length)
          policyInput.priorities = parsePriorities(text);
        const settings = loopPolicySchema.parse(policyInput);
        const conversationId =
          input.conversationId ??
          (
            await this.orchestrator.createConversation({
              projectId: input.projectId,
              title:
                input.title ??
                (input.mode === "goal" ? "Goal loop" : "Endless loop"),
              commandId: `${input.commandId}:conversation`,
            })
          ).id;
        const at = now();
        const runId = uid();
        const run: LoopRun = {
          id: runId,
          projectId: input.projectId,
          conversationId,
          title:
            input.title?.trim() ||
            (input.mode === "goal"
              ? (goalInputs[0]?.text ?? "Goal loop").slice(0, 120)
              : text.slice(0, 120) || "Keep improving the project"),
          mode: input.mode,
          state: "paused",
          desiredState: "paused",
          stopRequestedAt: null,
          revision: 1,
          controlGeneration: 1,
          authorityGeneration: 1,
          goalSetRevision: 1,
          policyRevision: 1,
          overrideRevision: 0,
          topologyRevisionId: null,
          publicationBaseCheckpointId: null,
          publicationBaseCandidateId: null,
          publicationCursorId: null,
          acceptedCheckpointId: null,
          currentIterationId: null,
          iterationCount: 0,
          cumulativeUsageId: `${runId}:usage`,
          nextWakeAt: null,
          waitReason: null,
          backoffSeconds: 0,
          adaptationTrigger: null,
          setupConditions: [],
          lastAdmissionAt: null,
          started: false,
          completedAt: null,
          detail: "Created. Review what this run will do, then start it.",
          lastTickAt: null,
          createdAt: at,
          updatedAt: at,
        };
        const membership = parseMembership(text, input.commandId);
        this.store.transaction(() => {
          this.repo.saveRevisioned(loopKinds.run, run);
          this.store.save(loopKinds.policy, {
            ...settings,
            id: runId,
            runId,
            projectId: input.projectId,
            revision: 1,
            authorizedDigest: null,
            authorizedAt: null,
            updatedAt: at,
          } satisfies LoopPolicy);
          this.store.put(loopKinds.usage, {
            id: run.cumulativeUsageId,
            runId,
            projectId: input.projectId,
            memberTurns: 0,
            iterations: 0,
            promoted: 0,
            rejected: 0,
            recent: [],
            tokens: {
              input: null,
              output: null,
              coveredAttempts: 0,
              totalAttempts: 0,
              complete: true,
              notes: [],
            },
            updatedAt: at,
          } satisfies LoopUsage);
          const ids: string[] = [];
          goalInputs.forEach((g, index) => {
            const id = `${runId}:goal:${index + 1}`;
            ids.push(id);
            this.newGoal(run, id, g, ids, input.commandId);
          });
          let revision = 0;
          for (const [index, m] of membership.entries()) {
            if (m.roleId === "*") continue;
            revision += 1;
            this.newOverride(run, revision, {
              kind: "role-settings",
              roleId: m.roleId,
              settings: m.settings,
              value: null,
              commandId: `${input.commandId}:membership:${index}`,
              source: "message",
              messageId: null,
            });
          }
          for (const provider of settings.excludedProviders) {
            revision += 1;
            this.newOverride(run, revision, {
              kind: "provider-exclusion",
              roleId: null,
              settings: null,
              value: provider,
              commandId: `${input.commandId}:exclude:${provider}`,
              source: "start",
              messageId: null,
            });
          }
          if (revision)
            this.repo.saveRevisioned(loopKinds.run, {
              ...run,
              overrideRevision: revision,
              revision: run.revision + 1,
            });
        });
        this.changed();
        return this.view(runId);
      },
    );
  }

  private newGoal(
    run: Pick<LoopRun, "id" | "projectId">,
    id: string,
    g: LoopGoalInput,
    siblings: string[],
    commandId: string,
  ): LoopGoal {
    const at = now();
    const goal: LoopGoal = {
      id,
      runId: run.id,
      projectId: run.projectId,
      conversationId: run.id,
      version: 1,
      originalText: g.text.trim(),
      text: g.text.trim(),
      required: g.required ?? true,
      priority: g.priority ?? 0,
      kind: g.kind ?? "code",
      constraints: g.constraints ?? [],
      criteria: (g.criteria ?? []).map((c, i) => ({
        id: `${id}:c${i + 1}`,
        text: c.text.trim(),
        verification: c.verification,
        required: true,
        provenance: "user" as const,
      })),
      dependsOn: (g.dependsOn ?? [])
        .map((d) => (typeof d === "number" ? siblings[d] : d))
        .filter((d): d is string => !!d && d !== id),
      externalInputs: [],
      status: "unassessed",
      lastEvaluatedCheckpointId: null,
      lastAssessmentId: null,
      satisfiedAtCheckpointId: null,
      evidenceIds: [],
      openFindings: [],
      blocker: null,
      conflict: null,
      regression: null,
      attempts: 0,
      lastTargetedIteration: null,
      provenance: [{ actor: "local-user", commandId, change: "created", at }],
      createdAt: at,
      updatedAt: at,
    };
    this.store.save(loopKinds.goal, goal);
    return goal;
  }

  private newOverride(
    run: Pick<LoopRun, "id" | "projectId">,
    revision: number,
    o: Pick<
      LoopOverride,
      | "kind"
      | "roleId"
      | "settings"
      | "value"
      | "commandId"
      | "source"
      | "messageId"
    >,
  ): LoopOverride {
    const override: LoopOverride = {
      id: `${run.id}:override:${revision}`,
      runId: run.id,
      projectId: run.projectId,
      conversationId: run.id,
      revision,
      kind: o.kind,
      roleId: o.roleId,
      lineageId: o.roleId,
      settings: o.settings ? roleGroupSettingsSchema.parse(o.settings) : null,
      value: o.value,
      actor: "local-user",
      commandId: o.commandId,
      messageId: o.messageId,
      source: o.source,
      hard: true,
      effectiveBoundary:
        o.kind === "provider-exclusion" ? "immediate" : "next-iteration",
      releasedBy: null,
      createdAt: now(),
    };
    this.store.save(loopKinds.override, override);
    return override;
  }

  /**
   * What starting this run authorizes, for the owner's native confirmation.
   * The service records this authority once; ordinary iterations are not
   * approved one by one.
   */
  authorityReview(runId: string, proposed?: Partial<LoopPolicyInput>) {
    const run = this.run(runId);
    const policy = this.policy(runId);
    const settings = loopPolicySchema.parse({
      ...this.policySettings(policy),
      ...(proposed ?? {}),
    });
    const project = this.repo.require<Project>("project", run.projectId);
    const body = {
      runId,
      mode: run.mode,
      title: run.title,
      project: project.realPath,
      goals: this.goals(run)
        .filter((g) => g.status !== "cancelled_by_user")
        .map((g) => ({
          id: g.id,
          version: g.version,
          text: g.text,
          required: g.required,
        })),
      overrides: this.overrides(run).map((o) => ({
        kind: o.kind,
        roleId: o.roleId,
        value: o.value,
      })),
      policy: settings,
    };
    const statements = [
      run.mode === "goal"
        ? "Goal loop: repeatedly assess, organize the team, plan, delegate, implement, verify and repair until every required goal has valid evidence on the same accepted checkpoint."
        : "Endless loop: repeatedly find worthwhile improvements, implement and verify them, and reassess. It never reports success; it runs until you stop it.",
      "The coordinator chooses roles, member counts and models automatically for every field you did not lock.",
      `Work happens in Topsl-owned copies of ${project.realPath}. Accepted results advance an internal checkpoint; nothing is written to your folder, committed or pushed until you publish.`,
      settings.automaticChecks && settings.checks.length
        ? `Automatic checks: ${settings.checks.map((c) => `${c.label} (${c.executable} ${c.args.join(" ")})`).join("; ")} run on the host with your OS permissions, without a sandbox, on each candidate.`
        : settings.checks.length
          ? "Required checks need your confirmation each time they run."
          : "No required checks are configured.",
      `Bounds per iteration: ${settings.iteration.maxTurns} member turns, ${settings.iteration.maxDelegatedTasks} tasks, ${settings.iteration.maxRepairRounds} repairs.${settings.allowances.runMemberTurns ? ` Run allowance: ${settings.allowances.runMemberTurns} member turns.` : ""}${settings.allowances.rolling ? ` Rolling allowance: ${settings.allowances.rolling.memberTurns} member turns per ${settings.allowances.rolling.windowHours} h.` : ""}`,
      settings.excludedProviders.length
        ? `Excluded providers: ${settings.excludedProviders.join(", ")}.`
        : "",
      "Existing provider readiness, native permissions and billing rules still apply.",
    ].filter(Boolean);
    return { ...body, statements, digest: hash(stable(body)) };
  }

  private policySettings(policy: LoopPolicy): LoopPolicyInput {
    const {
      id: _id,
      runId: _r,
      projectId: _p,
      revision: _v,
      authorizedDigest: _d,
      authorizedAt: _a,
      updatedAt: _u,
      ...settings
    } = policy;
    return settings;
  }

  /** Starts the run under the authority the owner just confirmed natively. */
  async start(input: { runId: string; digest: string; commandId: string }) {
    this.assertEnabled();
    const run = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      run.projectId,
      "loop-start",
      async () => {
        if (run.started)
          throw new Error(
            "This run already started. Use resume to continue it.",
          );
        const review = this.authorityReview(run.id);
        if (input.digest !== review.digest)
          throw new Error(
            "The run's authority changed after you reviewed it. Review it again.",
          );
        const policy = this.policy(run.id);
        const base = await this.loop.captureBase({
          projectId: run.projectId,
          runId: run.id,
        });
        if (policy.checks.length)
          this.loop.bindRunProtocol({
            runId: run.id,
            checkpointCandidateId: base.checkpointCandidateId,
            checks: policy.checks,
          });
        const at = now();
        const checkpoint: LoopCheckpoint = {
          id: `${run.id}:checkpoint:0`,
          runId: run.id,
          projectId: run.projectId,
          conversationId: run.id,
          sequence: 0,
          candidateId: base.checkpointCandidateId,
          contentDigest: base.contentDigest,
          parentCheckpointId: null,
          iterationId: null,
          promotionId: null,
          kind: "initial",
          pinned: true,
          createdAt: at,
        };
        const topology = this.bootstrapTopology(run);
        this.store.transaction(() => {
          this.store.immutable(loopKinds.checkpoint, checkpoint);
          this.store.immutable(loopKinds.topology, topology);
          this.store.save(loopKinds.policy, {
            ...policy,
            authorizedDigest: input.digest,
            authorizedAt: at,
          });
          const started = this.saveRun(run, {
            started: true,
            desiredState: "running",
            state: "active",
            controlGeneration: run.controlGeneration + 1,
            acceptedCheckpointId: checkpoint.id,
            publicationBaseCheckpointId: checkpoint.id,
            publicationBaseCandidateId: base.publicationBaseCandidateId,
            topologyRevisionId: topology.id,
            setupConditions: base.setupConditions,
            detail: "Started. Assessing the accepted checkpoint.",
          });
          this.intent(started, null, 1);
          this.store.put(loopKinds.active, {
            id: run.id,
            projectId: run.projectId,
            runId: run.id,
            lastAdmissionAt: null,
          } satisfies ActiveIndex);
          this.recordAdaptation(started, {
            kind: "bootstrap",
            roundId: null,
            fromTopologyId: null,
            toTopologyId: topology.id,
            operations: [],
            reason: topology.reason,
            expectedBenefit:
              "A working first organization the coordinators can revise.",
            rejections: [],
            evidence: {
              outcomes: this.projectOutcomes(run).length,
              confidence: "low",
            },
            trigger: null,
            boundaryIteration: 1,
            actor: LOOP_ACTOR,
            dissent: [],
          });
          this.event(started, "control-changed", "Run started.");
        });
        this.changed();
        return this.view(run.id);
      },
    );
  }

  /** The next-iteration outbox entry: one per boundary, never duplicated. */
  private intent(
    run: LoopRun,
    afterIterationId: string | null,
    number: number,
  ) {
    const id = `${run.id}:intent:${number}`;
    if (this.store.get(loopKinds.intent, id)) return;
    this.store.put(loopKinds.intent, {
      id,
      runId: run.id,
      projectId: run.projectId,
      afterIterationId,
      number,
      controlGeneration: run.controlGeneration,
      state: "pending",
      createdAt: now(),
    } satisfies LoopIntent);
  }

  /** Every outcome recorded in this project, across runs, for ranking. */
  private projectOutcomes(run: Pick<LoopRun, "projectId">): LoopOutcome[] {
    return [
      ...this.store.iterate<LoopOutcome>(loopKinds.outcome, {
        projectId: run.projectId,
      }),
    ];
  }

  /**
   * The service's initial organization, made before any coordinator can
   * recommend one: the built-in roles that cover every required function,
   * with Auto membership filled by the same eligibility resolver as other
   * roles. With no history it uses the documented cold-start order; it is
   * recorded as a bootstrap decision with limited evidence. No provider or
   * model is a mandatory coordinator.
   */
  private bootstrapTopology(run: LoopRun): TeamTopologyRevision {
    const roles: TopologyRole[] = [
      ["coordinator", "coordination and evaluation"],
      ["implementer", "implementation and integration"],
      ["reviewer", "review"],
      ["researcher", "information"],
    ].map(([roleId, why]) => ({
      roleId,
      lineageId: roleId,
      active: true,
      adaptive: {
        count: null,
        models: [],
        effort: null,
        collaboration: null,
        executionWidth: null,
      },
      origin: "bootstrap" as const,
      reason: `Bootstrap: covers ${why}.`,
    }));
    const bind: Array<[LoopFunction, string]> = [
      ["coordination", "coordinator"],
      ["evaluation", "coordinator"],
      ["implementation", "implementer"],
      ["integration", "implementer"],
      ["review", "reviewer"],
      ["information", "researcher"],
    ];
    const roleBindings = bind.map(([fn, roleId]) =>
      this.binding(run.projectId, fn, roleId, roleId, 1),
    );
    const outcomes = this.projectOutcomes(run);
    const body = { roles, roleBindings };
    return {
      id: `${run.id}:topology:1`,
      runId: run.id,
      projectId: run.projectId,
      conversationId: run.id,
      revision: 1,
      ...body,
      resolvedAssignmentRevisions: [],
      overrideRevision: run.overrideRevision,
      authorityGeneration: run.authorityGeneration,
      proposedByRoundId: null,
      decisionDigest: topologyDigest(body),
      evidenceIds: [],
      effectiveFromIteration: 1,
      previousRevisionId: null,
      reason: outcomes.length
        ? `Bootstrap from ${outcomes.length} recorded outcomes in this project; evidence is limited.`
        : "Bootstrap with no recorded outcomes: Auto membership uses the cold-start order (explicit preferences, diversity, default model, then stable provider and model order). The first coordinator round may change it.",
      change: "bootstrap",
      createdAt: now(),
    };
  }

  private binding(
    projectId: string,
    fn: LoopFunction,
    roleId: string,
    lineageId: string,
    revision: number,
  ): ActiveRolePurposeBinding {
    const role = this.repo.role(projectId, roleId);
    return {
      id: `${lineageId}:${fn}`,
      revision,
      roleId,
      lineageId,
      function: fn,
      purpose: functionPurpose[fn],
      outputContract: role.outputContract,
      roleDefinitionRevision: role.revision,
    };
  }

  /** Adds, edits, reprioritizes or explicitly removes goals. */
  async updateGoals(input: {
    runId: string;
    add?: LoopGoalInput[];
    edit?: Array<{
      goalId: string;
      text?: string;
      required?: boolean;
      priority?: number;
      criteria?: Array<{ text: string; verification: CriterionVerification }>;
      dependsOn?: string[];
      clearBlocker?: boolean;
    }>;
    remove?: string[];
    commandId: string;
  }) {
    this.assertEnabled();
    const run = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      run.projectId,
      "loop-goals-update",
      () => {
        if (run.mode !== "goal" && input.add?.length)
          throw new Error(
            "Endless runs follow priorities, not goals. Change the priorities instead.",
          );
        const goals = this.goals(run);
        const at = now();
        this.store.transaction(() => {
          const ids = goals.map((g) => g.id);
          for (const [index, g] of (input.add ?? []).entries()) {
            const id = `${run.id}:goal:${goals.length + index + 1}`;
            ids.push(id);
            this.newGoal(run, id, g, ids, input.commandId);
          }
          for (const e of input.edit ?? []) {
            const goal = goals.find((g) => g.id === e.goalId);
            if (!goal) throw new Error("That goal is not in this run.");
            if (goal.status === "cancelled_by_user")
              throw new Error(
                "A removed goal cannot be edited; add a new goal.",
              );
            const changes: string[] = [];
            const next: Partial<LoopGoal> = {};
            if (e.text !== undefined && e.text.trim() !== goal.text) {
              next.text = e.text.trim();
              changes.push("wording");
            }
            if (e.required !== undefined && e.required !== goal.required) {
              next.required = e.required;
              changes.push(e.required ? "required" : "optional");
            }
            if (e.priority !== undefined && e.priority !== goal.priority) {
              next.priority = e.priority;
              changes.push(`priority ${e.priority}`);
            }
            if (e.dependsOn) {
              next.dependsOn = e.dependsOn.filter((d) => d !== goal.id);
              changes.push("dependencies");
            }
            if (e.criteria) {
              // The owner's own criteria replace theirs; coordinator criteria
              // stay unless the owner removes them by replacing the list.
              next.criteria = e.criteria.map((c, i) => ({
                id: `${goal.id}:v${goal.version + 1}:c${i + 1}`,
                text: c.text.trim(),
                verification: c.verification,
                required: true,
                provenance: "user" as const,
              }));
              changes.push("criteria");
            }
            if (e.clearBlocker) {
              next.blocker = null;
              changes.push("unblocked");
            }
            if (!changes.length) continue;
            const content = changes.some(
              (c) => c !== "unblocked" && !c.startsWith("priority"),
            );
            this.saveGoal(goal, {
              ...next,
              version: content ? goal.version + 1 : goal.version,
              status: content ? "unassessed" : goal.status,
              provenance: [
                ...goal.provenance,
                {
                  actor: "local-user",
                  commandId: input.commandId,
                  change: changes.join(", "),
                  at,
                },
              ],
            });
          }
          for (const id of input.remove ?? []) {
            const goal = goals.find((g) => g.id === id);
            if (!goal) throw new Error("That goal is not in this run.");
            // A removed goal is never described as accomplished.
            this.saveGoal(goal, {
              status: "cancelled_by_user",
              version: goal.version + 1,
              provenance: [
                ...goal.provenance,
                {
                  actor: "local-user",
                  commandId: input.commandId,
                  change: "removed",
                  at,
                },
              ],
            });
          }
          const next = this.saveRun(run, {
            goalSetRevision: run.goalSetRevision + 1,
            ...(run.state === "completed" &&
            (input.add?.length || input.edit?.length)
              ? {
                  state: "active" as const,
                  completedAt: null,
                  detail: "Goals changed; continuing.",
                }
              : {}),
            ...(["monitoring", "waiting"].includes(run.state)
              ? {
                  nextWakeAt: this.iso(),
                  detail: "Goals changed; reassessing.",
                }
              : {}),
          });
          if (run.state === "completed" && next.state === "active") {
            this.intent(next, null, next.iterationCount + 1);
            this.store.put(loopKinds.active, {
              id: run.id,
              projectId: run.projectId,
              runId: run.id,
              lastAdmissionAt: null,
            } satisfies ActiveIndex);
          }
          this.event(
            next,
            "goals-changed",
            "The goal set changed; older assessments and completion decisions no longer commit.",
          );
        });
        this.changed();
        return this.view(run.id);
      },
    );
  }

  /** Changes limits and execution settings. A broader execution grant needs native confirmation. */
  async updatePolicy(input: {
    runId: string;
    expectedRevision: number;
    policy: Partial<LoopPolicyInput>;
    digest?: string | null;
    commandId: string;
  }) {
    this.assertEnabled();
    const run = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      run.projectId,
      "loop-policy-update",
      () => {
        const policy = this.policy(run.id);
        if (policy.revision !== input.expectedRevision)
          throw new Error("The run policy changed. Refresh and try again.");
        if (run.started && input.policy.checks)
          throw new Error(
            "The run's protected check protocol is fixed once it starts; start a new run to revise it.",
          );
        const widened =
          (input.policy.automaticChecks === true && !policy.automaticChecks) ||
          (input.policy.excludedProviders &&
            policy.excludedProviders.some(
              (p) => !input.policy.excludedProviders!.includes(p),
            ));
        if (widened) {
          const review = this.authorityReview(run.id, input.policy);
          if (input.digest !== review.digest)
            throw new Error(
              "This change widens what the run may execute; it needs your native confirmation.",
            );
        }
        const settings = loopPolicySchema.parse({
          ...this.policySettings(policy),
          ...input.policy,
        });
        this.store.transaction(() => {
          this.store.save(loopKinds.policy, {
            ...policy,
            ...settings,
            revision: policy.revision + 1,
            ...(widened
              ? { authorizedDigest: input.digest!, authorizedAt: now() }
              : {}),
            updatedAt: now(),
          } satisfies LoopPolicy);
          const next = this.saveRun(run, {
            policyRevision: run.policyRevision + 1,
            ...(["monitoring", "waiting"].includes(run.state)
              ? { nextWakeAt: this.iso() }
              : {}),
          });
          this.event(next, "policy-changed", "The run policy changed.");
        });
        this.changed();
        return this.view(run.id);
      },
    );
  }

  /**
   * Locks exact fields with the owner's provenance. Ordinary changes apply at
   * the next iteration boundary; a provider exclusion also fences current
   * work that uses that provider.
   */
  async setOverride(input: {
    runId: string;
    kind: LoopOverride["kind"];
    roleId?: string | null;
    settings?: RoleGroupSettings | null;
    value?: number | string | null;
    source?: LoopOverride["source"];
    messageId?: string | null;
    commandId: string;
  }) {
    this.assertEnabled();
    const run = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      run.projectId,
      "loop-override-set",
      async () => {
        if (input.roleId) this.repo.role(run.projectId, input.roleId);
        if (
          ["role-settings", "role-presence", "role-frozen"].includes(
            input.kind,
          ) &&
          !input.roleId
        )
          throw new Error("This override needs a role.");
        if (input.kind === "role-settings" && !input.settings)
          throw new Error("A role override needs its settings.");
        if (input.kind === "active-role-count") {
          const problem = activeRoleCountProblem(input.value);
          if (problem) throw new Error(problem);
        }
        if (
          input.kind === "provider-exclusion" &&
          !["codex", "claude"].includes(String(input.value))
        )
          throw new Error("Choose a provider to exclude.");
        let settings = input.settings ?? null;
        if (input.kind === "role-frozen") {
          // "Keep this role's team unchanged": its current exact roster.
          const frozen = this.currentRoster(run, input.roleId!);
          settings = { form: "exact", members: frozen };
        }
        let override!: LoopOverride;
        const revision = run.overrideRevision + 1;
        this.store.transaction(() => {
          override = this.newOverride(run, revision, {
            kind: input.kind,
            roleId: input.roleId ?? null,
            settings,
            value: input.value ?? null,
            commandId: input.commandId,
            source: input.source ?? "editor",
            messageId: input.messageId ?? null,
          });
          const next = this.saveRun(run, {
            overrideRevision: revision,
            adaptationTrigger: "user-steering",
            ...(["monitoring", "waiting"].includes(run.state)
              ? { nextWakeAt: this.iso() }
              : {}),
          });
          this.event(
            next,
            "override-set",
            `Override ${input.kind}${input.roleId ? ` for ${input.roleId}` : ""}; effective ${override.effectiveBoundary === "immediate" ? "immediately" : "at the next iteration boundary"}.`,
          );
        });
        if (input.kind === "provider-exclusion")
          await this.fenceProvider(run, String(input.value));
        this.changed();
        return override;
      },
    );
  }

  async releaseOverride(input: {
    runId: string;
    overrideId: string;
    commandId: string;
  }) {
    this.assertEnabled();
    const run = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      run.projectId,
      "loop-override-release",
      () => {
        const override = this.repo.require<LoopOverride>(
          loopKinds.override,
          input.overrideId,
        );
        if (override.runId !== run.id || override.releasedBy)
          throw new Error("That override is not active in this run.");
        const revision = run.overrideRevision + 1;
        this.store.transaction(() => {
          this.store.save(loopKinds.override, {
            ...override,
            releasedBy: { commandId: input.commandId, at: now(), revision },
          });
          const next = this.saveRun(run, {
            overrideRevision: revision,
            adaptationTrigger: "user-steering",
          });
          this.event(
            next,
            "override-released",
            `Returned ${override.roleId ?? override.kind} to Auto at the next boundary.`,
          );
        });
        this.changed();
        return this.view(run.id);
      },
    );
  }

  /** The exact roster a role resolves to now, as pinned member intents. */
  private currentRoster(run: LoopRun, roleId: string): MemberIntent[] {
    const binding = this.loopBinding(
      run,
      this.topology(run.topologyRevisionId!),
      null,
    );
    const resolved = this.orchestrator.resolve(
      run.projectId,
      null,
      roleId,
      null,
      {
        binding,
        scopeId: `loop:${run.id}`,
      },
    );
    const members = resolved.assignments.filter((a) => a.status === "resolved");
    if (!members.length)
      throw new Error(`Role ${roleId} has no resolved members to keep.`);
    return members.map((a) => ({
      memberId: a.memberId,
      required: true,
      pin: {
        provider: a.provider!,
        installationId: a.installationId!,
        model: a.model!,
        ...(a.effort ? { effort: a.effort } : {}),
      },
      fallbacks: [],
      preferences: { providers: [], models: [] },
      source: { kind: "ui", reference: null, provenance: "explicit" },
    }));
  }

  /** An immediate provider exclusion: current rounds using it restart without it. */
  private async fenceProvider(run: LoopRun, provider: string) {
    const it = run.currentIterationId
      ? this.repo.get<LoopIteration>(
          loopKinds.iteration,
          run.currentIterationId,
        )
      : undefined;
    const goalId = it?.childExecutionGoalIds.at(-1);
    if (!goalId) return;
    const goal = this.repo.get<Goal>(kinds.goal, goalId);
    if (!goal?.loop) return;
    this.store.put(kinds.goal, {
      ...goal,
      loop: {
        ...goal.loop,
        excludedProviders: [
          ...new Set([...goal.loop.excludedProviders, provider as "codex"]),
        ],
      },
    });
    for (const round of this.orchestrator.rounds(goal.id))
      if (
        [
          "collecting",
          "reconciling",
          "endorsing",
          "blocked",
          "awaiting-user",
        ].includes(round.stage) &&
        round.members.some((m) => m.provider === provider)
      )
        await this.orchestrator
          .restartRound({
            goalId: goal.id,
            roundId: round.id,
            commandId: `${round.id}:exclude:${provider}`,
          })
          .catch(() => {});
  }

  /**
   * Pause, resume or stop. None of these waits for or consults a model. Stop
   * and Pause stay available while Recursive Looping is off, so existing runs
   * can always be ended; Resume needs the feature on.
   */
  async control(input: {
    runId: string;
    action: "pause" | "resume" | "stop";
    commandId: string;
  }) {
    if (input.action === "resume") this.assertEnabled();
    const run = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      run.projectId,
      `loop-control-${input.action}`,
      async () => {
        if (!run.started && input.action !== "stop")
          throw new Error("Start the run first.");
        if (run.desiredState === "stopped")
          throw new Error(
            "This run was stopped. Start a new run to continue its work.",
          );
        const at = now();
        const it = run.currentIterationId
          ? this.repo.get<LoopIteration>(
              loopKinds.iteration,
              run.currentIterationId,
            )
          : undefined;
        const children = (it?.childExecutionGoalIds ?? []).filter((id) => {
          const g = this.repo.get<Goal>(kinds.goal, id);
          return g && !g.loopDisposition;
        });
        if (input.action === "stop") {
          // 1. A new control generation fences all future dispatch, durably first.
          let stopped!: LoopRun;
          this.store.transaction(() => {
            stopped = this.saveRun(run, {
              desiredState: "stopped",
              stopRequestedAt: at,
              controlGeneration: run.controlGeneration + 1,
              state: run.state === "completed" ? "completed" : "stopping",
              nextWakeAt: null,
              detail:
                "Stopping: dispatch is fenced; owned executions are settling.",
            });
            // 2. Scheduled wakeups and next-iteration intents are cancelled.
            this.cancelScheduled(stopped);
            if (it && !terminalIteration.has(it.state))
              this.saveIteration(it, {
                state: "cancelled",
                failure: { kind: "stopped", detail: "Stopped by the owner." },
                endedAt: at,
                detail:
                  "Stopped by the owner; accepted checkpoints and partial artifacts are preserved.",
              });
            this.event(stopped, "control-changed", "Stop requested.");
          });
          // 3. Cancellation reaches every owned goal, round, attempt and check.
          for (const goalId of children)
            await this.orchestrator
              .controlCommand({
                projectId: run.projectId,
                goalId,
                action: "stop",
                commandId: `${input.commandId}:${goalId}`,
              })
              .catch(() => {});
          await this.interruptRounds(stopped, "stopped");
          await this.settleStop(stopped);
          this.changed();
          return this.view(run.id);
        }
        if (input.action === "pause") {
          if (run.desiredState === "paused") return this.view(run.id);
          await this.pause(
            run,
            children,
            input.commandId,
            "Paused. Nothing new starts until you resume.",
          );
          this.changed();
          return this.view(run.id);
        }
        // Resume: a new generation; inputs, assignments and capacity are
        // revalidated before new work starts.
        if (run.desiredState === "running" && run.state !== "suspended")
          return this.view(run.id);
        let resumed!: LoopRun;
        this.store.transaction(() => {
          resumed = this.saveRun(run, {
            desiredState: "running",
            controlGeneration: run.controlGeneration + 1,
            state: run.state === "completed" ? "completed" : "active",
            waitReason: null,
            nextWakeAt: null,
            detail: "Resumed; revalidating before new work starts.",
          });
          if (it && !terminalIteration.has(it.state))
            this.saveIteration(it, {
              controlGeneration: resumed.controlGeneration,
            });
          if (!resumed.currentIterationId && resumed.state === "active")
            this.intent(resumed, null, resumed.iterationCount + 1);
          this.event(resumed, "control-changed", "Resumed.");
        });
        for (const goalId of children) {
          const g = this.repo.get<Goal>(kinds.goal, goalId);
          if (g?.state === "paused")
            await this.orchestrator
              .controlCommand({
                projectId: run.projectId,
                goalId,
                action: "resume",
                commandId: `${input.commandId}:${goalId}`,
              })
              .catch(() => {});
        }
        this.changed();
        return this.view(run.id);
      },
    );
  }

  /**
   * Durably pauses a run: a new control generation fences dispatch, scheduled
   * wakeups are cancelled, owned child goals are paused and open decision
   * rounds are interrupted.
   */
  private async pause(
    run: LoopRun,
    children: string[],
    commandId: string,
    detail: string,
  ) {
    this.store.transaction(() => {
      const next = this.saveRun(run, {
        desiredState: "paused",
        controlGeneration: run.controlGeneration + 1,
        state: "paused",
        detail,
      });
      this.cancelScheduled(next, false);
      this.event(next, "control-changed", detail);
    });
    for (const goalId of children)
      await this.orchestrator
        .controlCommand({
          projectId: run.projectId,
          goalId,
          action: "pause",
          commandId: `${commandId}:${goalId}`,
        })
        .catch(() => {});
    await this.interruptRounds(this.run(run.id), "stale");
  }

  /**
   * The disable policy for Recursive Looping. While the feature is off no run
   * advances: every started run that is still meant to run is paused (as if
   * the owner pressed Pause), so no iteration is admitted, no wakeup fires and
   * owned child work stops. A run that was asked to stop still settles. Runs
   * stay paused after the feature is turned back on until the owner resumes
   * them. Returns whether the feature is off.
   */
  async holdWhileDisabled(): Promise<boolean> {
    if (this.enabled()) return false;
    for (const a of [...this.store.iterate<ActiveIndex>(loopKinds.active)]) {
      let run = this.repo.get<LoopRun>(loopKinds.run, a.runId);
      if (!run) continue;
      // Settling committed work is bookkeeping, not new work.
      await this.settleLatest(run);
      run = this.run(run.id);
      if (run.desiredState === "stopped") {
        await this.settleStop(run);
        continue;
      }
      if (
        !run.started ||
        run.desiredState !== "running" ||
        ["completed", "stopped", "stopping"].includes(run.state)
      )
        continue;
      const it = run.currentIterationId
        ? this.repo.get<LoopIteration>(
            loopKinds.iteration,
            run.currentIterationId,
          )
        : undefined;
      const children = (it?.childExecutionGoalIds ?? []).filter((id) => {
        const g = this.repo.get<Goal>(kinds.goal, id);
        return g && !g.loopDisposition;
      });
      await this.pause(
        run,
        children,
        `${run.id}:feature-off:${run.controlGeneration}`,
        "Paused because Recursive Looping was turned off. Turn it on and resume to continue, or stop the run.",
      );
    }
    return true;
  }

  /**
   * Steering through the run's conversation. Membership words become the same
   * overrides the editor saves; pause, resume and stop are controls; other
   * text adds goals (Goal mode) or priorities (Endless mode).
   */
  async message(input: { runId: string; text: string; commandId: string }) {
    this.assertEnabled();
    const run = this.run(input.runId);
    const text = input.text.trim();
    if (
      /^\s*(pause|resume|stop)(?: (?:the|this) (?:run|loop))?\s*[.!]?\s*$/i.test(
        text,
      )
    ) {
      const action = /^\s*(\w+)/.exec(text)![1].toLowerCase() as
        "pause" | "resume" | "stop";
      return {
        routing: "control",
        view: await this.control({
          runId: run.id,
          action,
          commandId: `${input.commandId}:control`,
        }),
      };
    }
    const membership = parseMembership(text, input.commandId).filter(
      (m) => m.roleId !== "*",
    );
    for (const [i, m] of membership.entries())
      await this.setOverride({
        runId: run.id,
        kind: "role-settings",
        roleId: m.roleId,
        settings: m.settings,
        source: "message",
        messageId: input.commandId,
        commandId: `${input.commandId}:membership:${i}`,
      });
    const exclude = /\bdo not use (?:provider )?(codex|claude)\b/i.exec(text);
    if (exclude)
      await this.setOverride({
        runId: run.id,
        kind: "provider-exclusion",
        value: exclude[1].toLowerCase(),
        source: "message",
        messageId: input.commandId,
        commandId: `${input.commandId}:exclude`,
      });
    const keep = /\balways keep an? ([a-z][a-z0-9-]*) role\b/i.exec(text);
    if (keep)
      await this.setOverride({
        runId: run.id,
        kind: "role-presence",
        roleId: keep[1].toLowerCase(),
        source: "message",
        messageId: input.commandId,
        commandId: `${input.commandId}:presence`,
      });
    const count = /\buse exactly (\w+) active roles\b/i.exec(text);
    const words: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
    };
    if (count && (words[count[1].toLowerCase()] || Number(count[1])))
      await this.setOverride({
        runId: run.id,
        kind: "active-role-count",
        value: words[count[1].toLowerCase()] ?? Number(count[1]),
        source: "message",
        messageId: input.commandId,
        commandId: `${input.commandId}:count`,
      });
    if (run.mode === "goal") {
      const goals = splitGoals(text);
      if (goals.length)
        await this.updateGoals({
          runId: run.id,
          add: goals.map((t) => ({ text: t })),
          commandId: `${input.commandId}:goals`,
        });
      return {
        routing: goals.length
          ? "goals"
          : membership.length
            ? "membership"
            : "none",
        view: this.view(run.id),
      };
    }
    const priorities = parsePriorities(text);
    if (priorities.length) {
      const policy = this.policy(run.id);
      await this.updatePolicy({
        runId: run.id,
        expectedRevision: policy.revision,
        policy: {
          priorities: [...new Set([...policy.priorities, ...priorities])],
        },
        commandId: `${input.commandId}:priorities`,
      });
    }
    return {
      routing: priorities.length
        ? "priorities"
        : membership.length
          ? "membership"
          : "none",
      view: this.view(run.id),
    };
  }

  /** "Stop everything" in the project stops its runs as well. */
  private async stopProject(projectId: string, commandId: string) {
    for (const a of [
      ...this.store.iterate<ActiveIndex>(loopKinds.active, { projectId }),
    ]) {
      const run = this.repo.get<LoopRun>(loopKinds.run, a.runId);
      if (!run || run.desiredState === "stopped") continue;
      await this.control({
        runId: run.id,
        action: "stop",
        commandId: `${commandId}:loop:${run.id}`,
      }).catch(() => {});
    }
  }

  private cancelScheduled(run: LoopRun, intents = true) {
    for (const w of this.scoped<LoopWakeup>(loopKinds.wakeup, run))
      if (w.state === "pending")
        this.store.put(loopKinds.wakeup, { ...w, state: "cancelled" });
    if (intents)
      for (const i of [
        ...this.store.iterate<LoopIntent>(loopKinds.intent, {
          projectId: run.projectId,
        }),
      ])
        if (i.runId === run.id && i.state === "pending")
          this.store.put(loopKinds.intent, { ...i, state: "cancelled" });
  }

  /** Interrupts the run's open decision rounds; late results stay history only. */
  private async interruptRounds(run: LoopRun, stage: "stopped" | "stale") {
    for (const round of this.scoped<LoopRound>(loopKinds.round, run)) {
      if (!["collecting", "endorsing"].includes(round.state)) continue;
      const attempts = round.members
        .map((m) => m.activeAttemptId)
        .filter((a): a is string => !!a);
      this.saveRound(round, {
        state: stage,
        detail:
          stage === "stopped"
            ? "Stopped with its run."
            : "Paused; a fresh round freezes current inputs on resume.",
      });
      for (const id of attempts)
        await this.driver.interrupt(id).catch(() => {});
    }
  }

  private saveRound(round: LoopRound, next: Partial<LoopRound>): LoopRound {
    const current =
      this.repo.get<LoopRound>(loopKinds.round, round.id) ?? round;
    return this.repo.saveRevisioned(loopKinds.round, {
      ...current,
      ...next,
      revision: current.revision + 1,
      updatedAt: now(),
    });
  }

  /**
   * A stop is durable intent: the run is reported stopped only after every
   * owned execution is quiescent. While a provider has not confirmed an
   * interruption the run stays stopping and shows that uncertainty.
   */
  private async settleStop(run: LoopRun) {
    const pending = this.ownedActive(run);
    if (pending.length) {
      if (
        run.state !== "stopping" ||
        !run.detail.includes(`${pending.length} `)
      )
        this.saveRun(run, {
          state: "stopping",
          detail: `Stopping: ${pending.length} owned ${pending.length === 1 ? "execution has" : "executions have"} not confirmed they stopped (${pending.slice(0, 4).join(", ")}). Capacity stays held until they are reconciled.`,
        });
      return false;
    }
    if (run.state === "stopped" || run.state === "completed") {
      this.store.remove(loopKinds.active, run.id);
      return false;
    }
    const stopped = this.saveRun(run, {
      state: "stopped",
      detail:
        "Stopped. The accepted checkpoint and partial artifacts are preserved.",
    });
    this.store.remove(loopKinds.active, run.id);
    this.event(
      stopped,
      "control-changed",
      "Stopped; owned execution is quiescent.",
    );
    return false;
  }

  /** Attempts the run owns that are not yet observed stopped. */
  private ownedActive(run: LoopRun): string[] {
    const out: string[] = [];
    for (const round of this.scoped<LoopRound>(loopKinds.round, run)) {
      const members = round.members.map((m) => {
        if (!m.activeAttemptId) return m;
        const obs = this.driver.observe(m.activeAttemptId);
        if (
          obs.state !== "running" &&
          obs.state !== "uncertain" &&
          obs.quiescent
        ) {
          this.archiveLate(run, round, m, obs);
          return { ...m, activeAttemptId: null, launchId: null };
        }
        out.push(`${m.memberId} (${obs.state})`);
        return m;
      });
      if (stable(members) !== stable(round.members))
        this.saveRound(round, { members });
    }
    for (const it of this.iterations(run).slice(-2))
      for (const goalId of it.childExecutionGoalIds) {
        const goal = this.repo.get<Goal>(kinds.goal, goalId);
        if (!goal) continue;
        for (const round of this.orchestrator.rounds(goal.id))
          for (const m of round.members)
            if (m.activeAttemptId) {
              const obs = this.driver.observe(m.activeAttemptId);
              if (
                obs.state === "running" ||
                obs.state === "uncertain" ||
                !obs.quiescent
              )
                out.push(`${m.memberId} (${obs.state})`);
            }
      }
    return out;
  }

  /** Late results of ended rounds stay history only; their capacity is released. */
  private collectLate(run: LoopRun, it: LoopIteration) {
    for (const round of this.scoped<LoopRound>(loopKinds.round, run)) {
      if (
        round.iterationId !== it.id ||
        ["collecting", "endorsing"].includes(round.state)
      )
        continue;
      if (!round.members.some((m) => m.activeAttemptId)) continue;
      const members = round.members.map((m) => {
        if (!m.activeAttemptId) return m;
        const obs = this.driver.observe(m.activeAttemptId);
        if (
          obs.state === "running" ||
          obs.state === "uncertain" ||
          !obs.quiescent
        )
          return m;
        this.archiveLate(run, round, m, obs);
        return {
          ...m,
          activeAttemptId: null,
          launchId: null,
          state: m.state === "running" ? ("stale" as const) : m.state,
        };
      });
      if (stable(members) !== stable(round.members))
        this.saveRound(round, { members });
    }
  }

  private archiveLate(
    run: LoopRun,
    round: LoopRound,
    m: RoundMember,
    obs: AttemptObservation,
  ) {
    this.store.immutable(loopKinds.contribution, {
      id: `${round.id}:${m.activeAttemptId}`,
      projectId: run.projectId,
      conversationId: run.id,
      runId: run.id,
      roundId: round.id,
      memberId: m.memberId,
      assignmentId: m.assignmentId,
      assignmentRevision: m.assignmentRevision,
      attemptId: m.activeAttemptId!,
      phase: m.phase,
      protocol: {
        kind: "recursive-loop-v1",
        stage: round.stage,
        schemaVersion: 1,
      },
      output: null,
      validation: {
        state: "stale",
        reason: `Arrived after the round ended (${round.state}); kept as history only.`,
      },
      inputDigest: round.inputDigest,
      reportedModel: obs.reportedModel,
      createdAt: now(),
    } satisfies LoopContribution);
  }

  // -------------------------------------------------------------------------
  // The supervisor loop. Every transition is idempotent and revision-bound:
  // a repeated tick, a restart or a duplicate notification finds the same
  // records and does nothing twice.

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const head = this.store.controlHead();
    try {
      if (await this.holdWhileDisabled()) return;
      const at = this.ms();
      const slept = this.lastTick !== null && at - this.lastTick > 10 * 60_000;
      this.lastTick = at;
      // Indexed active runs only, least recently admitted first, so loops
      // share the one admission each tick fairly.
      const active = [
        ...this.store.iterate<ActiveIndex>(loopKinds.active),
      ].sort((a, b) =>
        (a.lastAdmissionAt ?? "").localeCompare(b.lastAdmissionAt ?? ""),
      );
      const admission = { available: true };
      for (const entry of active) {
        const run = this.repo.get<LoopRun>(loopKinds.run, entry.runId);
        if (!run) {
          this.store.remove(loopKinds.active, entry.id);
          continue;
        }
        try {
          if (slept)
            this.event(
              run,
              "sleep-detected",
              "A long gap since the last tick: deadlines are revalidated and due wakeups fire once.",
            );
          await this.advance(run, admission);
        } catch (error) {
          const latest = this.run(run.id);
          const detail = `Supervisor error: ${safeError(error)}`;
          if (latest.detail !== detail) this.saveRun(latest, { detail });
        }
      }
    } finally {
      this.ticking = false;
      if (this.store.controlHead() !== head) this.changed();
    }
  }

  private async advance(run: LoopRun, admission: { available: boolean }) {
    await this.settleLatest(run);
    run = this.run(run.id);
    if (run.desiredState === "stopped") {
      await this.settleStop(run);
      return;
    }
    if (run.desiredState === "paused") return;
    if (
      ["suspended", "completed", "stopped", "stopping", "paused"].includes(
        run.state,
      )
    )
      return;
    if (run.state === "monitoring" || run.state === "waiting") {
      const fingerprint = await this.inputsFingerprint(run);
      // A control (pause, stop, or the feature turned off) can land while the
      // project is read. Leaving the wait from the older record would mark a
      // paused run active, and nothing would ever pause it again.
      const latest = this.run(run.id);
      if (
        latest.controlGeneration !== run.controlGeneration ||
        latest.state !== run.state
      )
        return;
      const wake = this.pendingWakeup(run);
      const due = !run.nextWakeAt || Date.parse(run.nextWakeAt) <= this.ms();
      if (!due && wake && wake.inputsFingerprint === fingerprint) return;
      if (wake) this.store.put(loopKinds.wakeup, { ...wake, state: "fired" });
      run = this.saveRun(run, {
        state: "active",
        nextWakeAt: null,
        waitReason: null,
        detail: due
          ? "Reassessing after the wait."
          : "Inputs changed; reassessing early.",
      });
      this.event(run, "wait-exited", run.detail);
    }
    let it = run.currentIterationId
      ? this.repo.get<LoopIteration>(
          loopKinds.iteration,
          run.currentIterationId,
        )
      : undefined;
    if (it) this.collectLate(run, it);
    if (it && terminalIteration.has(it.state)) {
      // A boundary that committed before its run record moved on.
      run = this.saveRun(run, { currentIterationId: null });
      this.intent(run, it.id, run.iterationCount + 1);
      it = undefined;
    }
    if (!it) {
      const limit = this.allowanceLimit(run);
      if (limit) {
        await this.wait(run, limit.reason, limit.retryAt);
        return;
      }
      it = this.admitIteration(run);
      if (!it) return;
      run = this.run(run.id);
    }
    // Decision-round turns count toward allowances as they happen, not only
    // when the iteration's child work runs or ends.
    it = this.account(run, it, this.childTurns(it) + this.roundTurns(run, it));
    // An unknown member outcome stays visible (plan invariant 7). The stage
    // cannot use that turn until the owner reconciles its run, and the
    // turn's workspace and capacity stay held meanwhile.
    const blocked = this.uncertainTurns(run, it);
    if (blocked) {
      this.softWait(run, blocked);
      return;
    }
    if (run.waitReason?.kind === "reconciliation")
      run = this.saveRun(run, {
        waitReason: null,
        detail: `Iteration ${it.number}: ${it.state}.`,
      });
    switch (it.state) {
      case "assessing":
        return this.assess(run, it);
      case "organizing":
        return this.organize(run, it);
      case "preparing":
        return this.prepare(run, it, admission);
      case "executing":
      case "verifying":
        return this.execute(run, it);
      case "evaluating":
        return this.evaluate(run, it);
      case "promoting":
        return this.promote(run, it);
    }
  }

  /** Consumes the next-iteration intent; the iteration ID is deterministic. */
  private admitIteration(run: LoopRun): LoopIteration | undefined {
    const pending = [
      ...this.store.iterate<LoopIntent>(loopKinds.intent, {
        projectId: run.projectId,
      }),
    ].filter((i) => i.runId === run.id && i.state === "pending");
    if (!pending.length) {
      this.intent(run, null, run.iterationCount + 1);
      return undefined;
    }
    const number = run.iterationCount + 1;
    const id = `${run.id}:iteration:${number}`;
    const existing = this.repo.get<LoopIteration>(loopKinds.iteration, id);
    if (existing) {
      this.saveRun(run, { currentIterationId: id, iterationCount: number });
      return existing;
    }
    const topology = this.topology(run.topologyRevisionId!);
    const it: LoopIteration = {
      id,
      runId: run.id,
      projectId: run.projectId,
      conversationId: run.id,
      number,
      parentCheckpointId: run.acceptedCheckpointId!,
      goalIds: [],
      opportunityId: null,
      topologyRevisionId: topology.id,
      childExecutionGoalIds: [],
      verificationProtocolRevision: this.loop.protocolRevision(
        run.id,
        this.policy(run.id).checks,
      ),
      controlGeneration: run.controlGeneration,
      contract: null,
      state: "assessing",
      resultCheckpointId: null,
      assessmentIds: [],
      outcomeRecordIds: [],
      promotionId: null,
      failure: null,
      repairs: 0,
      restarts: 0,
      memberTurns: 0,
      assignments: [],
      detail: "Assessing the accepted checkpoint.",
      startedAt: now(),
      endedAt: null,
      revision: 1,
    };
    this.store.transaction(() => {
      this.repo.saveRevisioned(loopKinds.iteration, it);
      for (const i of pending)
        this.store.put(loopKinds.intent, { ...i, state: "consumed" });
      const next = this.saveRun(run, {
        currentIterationId: id,
        iterationCount: number,
        detail: `Iteration ${number}: assessing.`,
      });
      this.event(next, "iteration-admitted", `Iteration ${number} admitted.`);
    });
    return this.repo.require<LoopIteration>(loopKinds.iteration, id);
  }

  // -------------------------------------------------------------------------
  // Waits, monitoring and allowances

  private pendingWakeup(run: LoopRun): LoopWakeup | undefined {
    return this.scoped<LoopWakeup>(loopKinds.wakeup, run)
      .filter((w) => w.state === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** What would make reassessment worthwhile sooner than the backoff. */
  private async inputsFingerprint(run: LoopRun): Promise<string> {
    const routes = this.driver
      .routes(run.projectId)
      .map((r) => [
        r.provider,
        r.installationId,
        r.installationRevision,
        r.catalog.fresh,
        r.catalog.models.map((m) => m.model),
        Object.entries(r.purposes).map(([p, v]) => [p, v?.ready]),
      ]);
    return hash(
      stable({
        checkpoint: run.acceptedCheckpointId,
        goals: run.goalSetRevision,
        policy: run.policyRevision,
        overrides: run.overrideRevision,
        routes,
        project: (await this.loop.projectFingerprint?.(run.projectId)) ?? null,
      }),
    ).slice(0, 24);
  }

  /**
   * Enters waiting or monitoring with a persisted wakeup. Monitoring backs
   * off while inputs stay unchanged; a restart reads the wakeup instead of
   * generating a burst of discovery work.
   */
  private async wait(
    run: LoopRun,
    reason: LoopWaitReason,
    retryAt: string | null,
    state: "waiting" | "monitoring" = "waiting",
  ) {
    const policy = this.policy(run.id);
    const backoff = run.backoffSeconds
      ? Math.min(
          policy.monitoring.maxSeconds,
          Math.round(run.backoffSeconds * policy.monitoring.factor),
        )
      : // A policy stored before initialSeconds was bounded by maxSeconds.
        Math.min(
          policy.monitoring.maxSeconds,
          policy.monitoring.initialSeconds,
        );
    const dueAt = retryAt ?? this.iso(this.ms() + backoff * 1000);
    const fingerprint = await this.inputsFingerprint(run);
    this.store.transaction(() => {
      for (const w of this.scoped<LoopWakeup>(loopKinds.wakeup, run))
        if (w.state === "pending")
          this.store.put(loopKinds.wakeup, { ...w, state: "cancelled" });
      this.store.save(loopKinds.wakeup, {
        id: `${run.id}:wake:${uid()}`,
        runId: run.id,
        projectId: run.projectId,
        conversationId: run.id,
        dueAt,
        reason: reason.detail,
        controlGeneration: run.controlGeneration,
        inputsFingerprint: fingerprint,
        backoffSeconds: backoff,
        state: "pending",
        createdAt: now(),
      } satisfies LoopWakeup);
      const next = this.saveRun(run, {
        state,
        waitReason: reason,
        nextWakeAt: dueAt,
        backoffSeconds: backoff,
        detail:
          state === "monitoring"
            ? `Monitoring: ${reason.detail} Reassessing later, or sooner when inputs change.`
            : `Waiting: ${reason.detail}`,
      });
      this.event(next, "wait-entered", next.detail, { waitReason: reason });
    });
  }

  /** A wait that keeps the run active: shown, re-checked each tick. */
  private softWait(
    run: LoopRun,
    reason: LoopWaitReason | null,
    detail?: string,
  ) {
    if (
      stable(run.waitReason) === stable(reason) &&
      (!detail || run.detail === detail)
    )
      return;
    this.saveRun(run, {
      waitReason: reason,
      ...(detail
        ? { detail }
        : reason
          ? { detail: `Waiting: ${reason.detail}` }
          : {}),
    });
  }

  private recentTurns(usage: LoopUsage, windowHours: number): number {
    const since = this.ms() - windowHours * 3_600_000;
    return usage.recent
      .filter((r) => Date.parse(r.at) >= since)
      .reduce((n, r) => n + r.turns, 0);
  }

  /** Run-level and rolling allowances the local system can measure. */
  private allowanceLimit(
    run: LoopRun,
  ): { reason: LoopWaitReason; retryAt: string | null } | null {
    const policy = this.policy(run.id);
    const usage = this.usageRecord(run);
    const runLimit = policy.allowances.runMemberTurns;
    if (
      runLimit !== null &&
      runLimit - usage.memberTurns < Math.min(MIN_ITERATION_TURNS, runLimit)
    )
      return {
        reason: {
          kind: "allowance",
          detail: `The run's allowance of ${runLimit} member turns is used up. Raise it to continue; this is not completion.`,
          renewsAt: null,
        },
        retryAt: this.iso(this.ms() + policy.monitoring.maxSeconds * 1000),
      };
    const rolling = policy.allowances.rolling;
    if (
      rolling &&
      rolling.memberTurns - this.recentTurns(usage, rolling.windowHours) <
        Math.min(MIN_ITERATION_TURNS, rolling.memberTurns)
    ) {
      const since = this.ms() - rolling.windowHours * 3_600_000;
      const oldest = usage.recent
        .filter((r) => Date.parse(r.at) >= since)
        .map((r) => Date.parse(r.at))
        .sort()[0];
      const renewsAt = this.iso(
        (oldest ?? this.ms()) + rolling.windowHours * 3_600_000 + 1000,
      );
      return {
        reason: {
          kind: "allowance",
          detail: `The rolling allowance of ${rolling.memberTurns} member turns per ${rolling.windowHours} h is used up; waiting for it to renew.`,
          renewsAt,
        },
        retryAt: renewsAt,
      };
    }
    return null;
  }

  private remainingTurns(run: LoopRun, policy: LoopPolicy): number {
    const usage = this.usageRecord(run);
    let remaining = policy.iteration.maxTurns;
    if (policy.allowances.runMemberTurns !== null)
      remaining = Math.min(
        remaining,
        policy.allowances.runMemberTurns - usage.memberTurns,
      );
    if (policy.allowances.rolling)
      remaining = Math.min(
        remaining,
        policy.allowances.rolling.memberTurns -
          this.recentTurns(usage, policy.allowances.rolling.windowHours),
      );
    return Math.max(0, remaining);
  }

  /** Cumulative accounting across bounded children: a child never resets it. */
  /**
   * Charges an iteration's new member turns. The usage record and the
   * iteration's turn cursor are written in one transaction, so a crash
   * between them can neither lose nor repeat a charge.
   */
  private account(run: LoopRun, it: LoopIteration, turns: number) {
    if (turns <= it.memberTurns) return it;
    const delta = turns - it.memberTurns;
    return this.store.transaction(() => {
      const usage = this.usageRecord(run);
      this.store.put(loopKinds.usage, {
        ...usage,
        memberTurns: usage.memberTurns + delta,
        recent: compactRecent(
          [...usage.recent, { at: this.iso(), turns: delta }],
          this.ms(),
        ),
        updatedAt: now(),
      } satisfies LoopUsage);
      return this.saveIteration(it, { memberTurns: turns });
    });
  }

  private roundTurns(run: LoopRun, it: LoopIteration): number {
    return this.scoped<LoopRound>(loopKinds.round, run)
      .filter((r) => r.iterationId === it.id)
      .reduce(
        (n, r) => n + r.members.reduce((m, x) => m + x.attemptIds.length, 0),
        0,
      );
  }

  /** The iteration's member turns whose outcome is unknown, in its decision
   * rounds and its child goals' rounds, as one wait reason; null when none. */
  private uncertainTurns(
    run: LoopRun,
    it: LoopIteration,
  ): LoopWaitReason | null {
    const children = new Set(it.childExecutionGoalIds);
    const active = [
      ...this.scoped<LoopRound>(loopKinds.round, run)
        .filter((r) => r.iterationId === it.id)
        .flatMap((r) => r.members),
      ...(children.size
        ? this.repo
            .all<RoleRound>(kinds.round, run.projectId)
            .filter((r) => children.has(r.goalId))
            .flatMap((r) => r.members)
        : []),
    ];
    const blocked: Array<{ memberId: string; runId: string }> = [];
    for (const m of active) {
      if (!m.activeAttemptId) continue;
      const obs = this.driver.observe(m.activeAttemptId);
      if (obs.state === "uncertain")
        blocked.push({
          memberId: m.memberId,
          runId: obs.runId ?? m.activeAttemptId,
        });
    }
    if (!blocked.length) return null;
    const named = blocked
      .map((b) => `${b.memberId} (run ${b.runId.slice(0, 8)})`)
      .join(", ");
    return {
      kind: "reconciliation",
      runIds: [...new Set(blocked.map((b) => b.runId))],
      detail: `${blocked.length === 1 ? "A member turn" : `${blocked.length} member turns`} ended with an unknown outcome: ${named}. Each holds its workspace until the owner inspects and reconciles that run under Runs.`,
    };
  }

  private childTurns(it: LoopIteration): number {
    return it.childExecutionGoalIds.reduce(
      (n, id) => n + (this.repo.get<Goal>(kinds.goal, id)?.usage.turns ?? 0),
      0,
    );
  }

  private noWork(
    run: LoopRun,
    it: LoopIteration,
    reason: LoopWaitReason,
    monitoring: boolean,
  ) {
    this.store.transaction(() => {
      this.saveIteration(it, {
        state: "no-work",
        endedAt: now(),
        detail: reason.detail,
      });
      const next = this.saveRun(run, { currentIterationId: null });
      this.intent(next, it.id, next.iterationCount + 1);
    });
    return this.wait(
      this.run(run.id),
      reason,
      null,
      monitoring ? "monitoring" : "waiting",
    );
  }

  // -------------------------------------------------------------------------
  // Boundary: assess goals or discover opportunities

  private async assess(run: LoopRun, it: LoopIteration) {
    const head = this.checkpoint(run.acceptedCheckpointId!);
    const policy = this.policy(run.id);
    if (run.mode === "goal") {
      const active = this.goals(run).filter(
        (g) => g.status !== "cancelled_by_user",
      );
      if (!active.length)
        return this.noWork(
          run,
          it,
          {
            kind: "user-input",
            detail: "Every goal was removed. Add a goal to continue.",
            goalIds: [],
          },
          false,
        );
      if (await this.verifyHead(run, head, policy)) return;
      const completion = this.completion(run);
      if (completion.complete)
        return this.complete(run, it, completion.snapshot);
      // A goal without acceptance criteria needs interpretation at a
      // boundary before any iteration can target it.
      const unassessed = active.filter(
        (g) => !g.criteria.length || !this.currentAssessment(run, g, head),
      );
      if (!unassessed.length) return this.select(run, it, null);
    }
    const result = await this.decisionRound(run, it, "boundary");
    if (result.state !== "decided") return;
    const record = result.record;
    if (run.mode === "goal") {
      if (this.applyProposedCriteria(run, record)) return;
      const goals = this.goals(run).filter(
        (g) => g.status !== "cancelled_by_user",
      );
      const ids = this.recordAssessments(
        run,
        it,
        record,
        this.checkpointTarget(head),
        goals,
        null,
      );
      this.applyCheckpointAssessments(run, head, ids);
      this.applyWaits(run, record);
      const completion = this.completion(this.run(run.id));
      if (completion.complete)
        return this.complete(
          this.run(run.id),
          this.repo.require(loopKinds.iteration, it.id),
          completion.snapshot,
        );
      const proposed = record.decisions.filter(
        (d) => (d.decision as LoopDecision).kind === "propose_goal_completion",
      );
      if (proposed.length)
        this.event(
          this.run(run.id),
          "completion-rejected",
          `Coordinators proposed completion, but ${completion.missing.slice(0, 4).join("; ")}.`,
        );
    } else this.upsertOpportunities(run, record, head);
    return this.select(
      this.run(run.id),
      this.repo.require<LoopIteration>(loopKinds.iteration, it.id),
      record,
    );
  }

  /** Runs the protected checks on the initial checkpoint once, under the run's grant. */
  private async verifyHead(
    run: LoopRun,
    head: LoopCheckpoint,
    policy: LoopPolicy,
  ): Promise<boolean> {
    if (
      !policy.checks.length ||
      head.kind !== "initial" ||
      !policy.automaticChecks ||
      !this.loop.verifyCheckpoint
    )
      return false;
    const have = this.checkpointEvidence(run, head);
    if (policy.checks.every((c) => have.some((e) => e.definitionId === c.id)))
      return false;
    try {
      const evidence = await this.loop.verifyCheckpoint({
        projectId: run.projectId,
        runId: run.id,
        candidateId: head.candidateId,
        checks: policy.checks,
        authorize: (plan) =>
          this.recordAuthorization(
            run,
            null,
            null,
            head.candidateId,
            plan,
            policy,
          ),
      });
      for (const e of evidence)
        this.store.immutable(loopKinds.evidence, {
          id: `${head.id}:${e.verificationId}`,
          projectId: run.projectId,
          conversationId: run.id,
          runId: run.id,
          checkpointId: head.id,
          candidateId: head.candidateId,
          definitionId: e.definitionId,
          verificationId: e.verificationId,
          result: e.result,
          evidenceArtifactId: e.evidenceArtifactId,
          at: now(),
        } satisfies CheckpointEvidence);
    } catch (error) {
      await this.wait(
        run,
        {
          kind: "verification",
          detail: `The checks could not run on the accepted checkpoint: ${safeError(error)} No result counts as a pass.`,
        },
        null,
      );
    }
    return true;
  }

  private checkpointEvidence(
    run: LoopRun,
    head: LoopCheckpoint,
  ): CheckpointEvidence[] {
    return this.scoped<CheckpointEvidence>(loopKinds.evidence, run).filter(
      (e) => e.checkpointId === head.id,
    );
  }

  /** The machine-attributed authorization for one automatic check execution. */
  private recordAuthorization(
    run: LoopRun,
    it: LoopIteration | null,
    goalId: string | null,
    candidateId: string,
    plan: { id: string; digest: string; definitionId: string },
    policy: LoopPolicy,
  ) {
    const definition = policy.checks.find((c) => c.id === plan.definitionId);
    if (!policy.automaticChecks || !policy.authorizedDigest || !definition)
      throw new Error(
        "The run's policy does not grant automatic execution of this check.",
      );
    this.store.immutable(loopKinds.authorization, {
      id: plan.id,
      projectId: run.projectId,
      conversationId: run.id,
      runId: run.id,
      iterationId: it?.id ?? null,
      goalId,
      planId: plan.id,
      planDigest: plan.digest,
      definitionId: plan.definitionId,
      definitionHash: hash(stable(definition)),
      candidateId,
      by: LOOP_ACTOR,
      grantedBy: {
        policyRevision: policy.revision,
        authorizedDigest: policy.authorizedDigest,
      },
      // Host execution with the owner's OS permissions; not a sandbox.
      executionRoute: "host-user-permissions",
      sandboxed: false,
      at: now(),
    });
  }

  /** Coordinator interpretations of goals that have no criteria yet. */
  private applyProposedCriteria(
    run: LoopRun,
    record: LoopDecisionRecord,
  ): boolean {
    const goals = this.goals(run);
    const added = new Map<string, LoopCriterion[]>();
    const checks = new Set(this.policy(run.id).checks.map((c) => c.id));
    for (const { decision } of record.decisions) {
      const d = decision as LoopDecision;
      if (d.kind !== "assess_goals") continue;
      for (const a of d.assessments) {
        const goal = goals.find(
          (g) => g.id === a.goalId && g.version === a.goalVersion,
        );
        if (
          !goal ||
          goal.criteria.length ||
          !a.proposedCriteria.length ||
          added.has(goal.id)
        )
          continue;
        added.set(
          goal.id,
          a.proposedCriteria.map((c, i) => ({
            id: `${goal.id}:v${goal.version + 1}:c${i + 1}`,
            text: c.text,
            // A check criterion must name one of the run's protected checks.
            verification:
              c.verification === "check" && c.checkId && checks.has(c.checkId)
                ? { kind: "check" as const, checkId: c.checkId }
                : c.verification === "check"
                  ? { kind: "inspection" as const }
                  : { kind: c.verification },
            required: true,
            provenance: "coordinator" as const,
          })),
        );
      }
    }
    if (!added.size) return false;
    this.store.transaction(() => {
      for (const [goalId, criteria] of added) {
        const goal = goals.find((g) => g.id === goalId)!;
        this.saveGoal(goal, {
          criteria,
          version: goal.version + 1,
          status: "unassessed",
          provenance: [
            ...goal.provenance,
            {
              actor: "coordinators",
              commandId: record.id,
              change: `interpreted ${criteria.length} acceptance criteria`,
              at: now(),
            },
          ],
        });
      }
      const next = this.saveRun(run, {
        goalSetRevision: run.goalSetRevision + 1,
      });
      this.event(
        next,
        "goals-interpreted",
        `Coordinators derived acceptance criteria for ${added.size} ${added.size === 1 ? "goal" : "goals"}; you can edit them.`,
      );
    });
    return true;
  }

  private applyWaits(run: LoopRun, record: LoopDecisionRecord) {
    const goals = this.goals(run);
    for (const { decision } of record.decisions) {
      const d = decision as LoopDecision;
      if (d.kind !== "request_wait" || d.condition !== "needs-input") continue;
      for (const goalId of d.goalIds) {
        const goal = goals.find((g) => g.id === goalId);
        if (
          goal &&
          goal.status !== "satisfied" &&
          goal.status !== "cancelled_by_user"
        )
          this.saveGoal(goal, {
            status: "blocked",
            blocker: d.question ?? d.reason,
          });
      }
    }
  }

  /** Chooses the next iteration's contract, or waits or monitors. */
  private async select(
    run: LoopRun,
    it: LoopIteration,
    record: LoopDecisionRecord | null,
  ) {
    const head = this.checkpoint(run.acceptedCheckpointId!);
    const recommendations = (record?.decisions ?? []).map((d) => ({
      memberId: d.memberId,
      d: d.decision as LoopDecision,
    }));
    let contract: IterationContract | null = null;
    if (run.mode === "goal") {
      const goals = this.goals(run);
      const done = new Set(
        goals.filter((g) => g.status === "satisfied").map((g) => g.id),
      );
      const exhausted = (g: LoopGoal) =>
        this.rejectedAt(run, g.id, head.contentDigest) >=
        this.policy(run.id).iteration.maxApproachesPerTarget;
      for (const g of goals)
        if (
          g.status !== "cancelled_by_user" &&
          g.status !== "satisfied" &&
          !g.blocker &&
          exhausted(g)
        )
          this.saveGoal(g, {
            status: "blocked",
            blocker: `${this.policy(run.id).iteration.maxApproachesPerTarget} approaches failed at this content. Edit the goal or give direction; a repeated task under a new ID does not bypass the limit.`,
          });
      const eligible = this.goals(run)
        .filter(
          (g) =>
            g.status !== "cancelled_by_user" &&
            g.status !== "satisfied" &&
            !g.blocker &&
            g.criteria.length > 0 &&
            g.dependsOn.every((d) => done.has(d)),
        )
        // Required first, then priority; equal priorities share progress by
        // fewest attempts, so a hard goal is not starved by easy ones.
        .sort(
          (a, b) =>
            Number(b.required) - Number(a.required) ||
            a.priority - b.priority ||
            a.attempts - b.attempts ||
            (a.lastTargetedIteration ?? -1) - (b.lastTargetedIteration ?? -1) ||
            a.createdAt.localeCompare(b.createdAt),
        );
      if (!eligible.length) {
        const blocked = this.goals(run).filter(
          (g) => g.blocker && g.status !== "cancelled_by_user",
        );
        return this.noWork(
          run,
          it,
          {
            kind: "user-input",
            detail: blocked.length
              ? `Every remaining goal needs input: ${blocked.map((g) => `${g.text}: ${g.blocker}`).join(" ")}`
              : "No remaining goal can progress until its dependencies are satisfied.",
            goalIds: blocked.map((g) => g.id),
          },
          false,
        );
      }
      const first = eligible[0];
      const plan = recommendations.find(
        (r) => r.d.kind === "plan_iteration" && r.d.goalIds.includes(first.id),
      )?.d as Extract<LoopDecision, { kind: "plan_iteration" }> | undefined;
      const together = eligible
        .filter(
          (g) =>
            g.id !== first.id &&
            g.priority === first.priority &&
            plan?.goalIds.includes(g.id) &&
            !first.conflict?.includes(g.id) &&
            !g.conflict?.includes(first.id),
        )
        .slice(0, 2);
      const targets = [first, ...together];
      const approach = plan?.approach ?? "";
      contract = {
        summary:
          plan?.summary ?? `Advance: ${targets.map((g) => g.text).join("; ")}`,
        targets: targets.map((g) => ({
          goalId: g.id,
          goalVersion: g.version,
          criterionIds: g.criteria.map((c) => c.id),
        })),
        opportunityId: null,
        acceptanceConditions: [
          ...new Set([
            ...targets.flatMap((g) => g.criteria.map((c) => c.text)),
            ...(plan?.acceptanceConditions ?? []),
          ]),
        ],
        approach,
        fingerprint: this.fingerprint(
          targets.map((g) => [g.id, g.version]),
          approach,
        ),
      };
      if (this.repeatsFailedApproach(run, contract, head.contentDigest))
        contract.approach =
          `${approach} (a previous attempt with this approach failed at this content; take a materially different approach)`.trim();
      this.store.transaction(() => {
        for (const g of targets)
          this.saveGoal(g, {
            status: g.status === "unassessed" ? "in_progress" : g.status,
            attempts: g.attempts + 1,
            lastTargetedIteration: it.number,
          });
      });
    } else {
      const policy = this.policy(run.id);
      const tally = new Map<string, number>();
      for (const r of recommendations)
        if (r.d.kind === "select_opportunity")
          tally.set(r.d.opportunity, (tally.get(r.d.opportunity) ?? 0) + 1);
      const eligible = this.scoped<LoopOpportunity>(loopKinds.opportunity, run)
        .filter(
          (o) =>
            ["proposed", "selected"].includes(o.state) &&
            !o.attempts.some(
              (a) =>
                a.outcome === "rejected" &&
                a.checkpointDigest === head.contentDigest,
            ) &&
            o.priorityScore >= policy.opportunityThreshold,
        )
        .map((o) => ({
          o,
          score:
            o.priorityScore +
            0.05 * ((tally.get(o.id) ?? 0) + (tally.get(o.title) ?? 0)),
        }))
        .sort(
          (a, b) =>
            b.score - a.score || a.o.createdAt.localeCompare(b.o.createdAt),
        );
      const choice = eligible[0]?.o;
      if (!choice) {
        const waits = recommendations.filter(
          (r) => r.d.kind === "request_wait",
        );
        return this.noWork(
          run,
          it,
          {
            kind: "no-opportunity",
            detail: waits.length
              ? `No worthwhile improvement currently identified (${(waits[0].d as { reason: string }).reason}).`
              : "No worthwhile improvement currently identified.",
          },
          true,
        );
      }
      this.store.save(loopKinds.opportunity, {
        ...choice,
        state: "selected",
        updatedAt: now(),
      });
      contract = {
        summary: `${choice.title}: ${choice.expectedBenefit}`,
        targets: [],
        opportunityId: choice.id,
        acceptanceConditions: choice.acceptanceConditions,
        approach: choice.approach,
        fingerprint: this.fingerprint([choice.fingerprint], choice.approach),
      };
    }
    const due = this.adaptationDue(run, it);
    const next = this.saveIteration(it, {
      contract,
      goalIds: contract.targets.map((t) => t.goalId),
      opportunityId: contract.opportunityId,
      state: due ? "organizing" : "preparing",
      detail: `Contract: ${contract.summary}`,
    });
    this.saveRun(run, {
      backoffSeconds: 0,
      detail: `Iteration ${it.number}: ${contract.summary}`,
    });
    this.event(this.run(run.id), "iteration-planned", next.detail);
  }

  private fingerprint(targets: unknown[], approach: string) {
    return hash(
      stable({
        targets,
        approach: approach
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      }),
    ).slice(0, 32);
  }

  private rejectedAt(run: LoopRun, goalId: string, digest: string): number {
    return this.iterations(run).filter(
      (i) =>
        i.state === "rejected" &&
        i.failure?.kind !== "transient" &&
        i.failure?.kind !== "stopped" &&
        i.failure?.kind !== "limit" &&
        i.goalIds.includes(goalId) &&
        this.repo.get<LoopCheckpoint>(
          loopKinds.checkpoint,
          i.parentCheckpointId,
        )?.contentDigest === digest,
    ).length;
  }

  private repeatsFailedApproach(
    run: LoopRun,
    contract: IterationContract,
    digest: string,
  ) {
    return this.iterations(run).some(
      (i) =>
        i.state === "rejected" &&
        i.contract?.fingerprint === contract.fingerprint &&
        this.repo.get<LoopCheckpoint>(
          loopKinds.checkpoint,
          i.parentCheckpointId,
        )?.contentDigest === digest,
    );
  }

  private upsertOpportunities(
    run: LoopRun,
    record: LoopDecisionRecord,
    head: LoopCheckpoint,
  ) {
    const policy = this.policy(run.id);
    const existing = this.scoped<LoopOpportunity>(loopKinds.opportunity, run);
    const words = policy.priorities.flatMap((p) =>
      p
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3),
    );
    for (const { memberId, decision } of record.decisions) {
      const d = decision as LoopDecision;
      if (d.kind !== "propose_opportunity") continue;
      for (const o of d.opportunities) {
        const fingerprint = opportunityFingerprint(o);
        const prior = existing.find((x) => x.fingerprint === fingerprint);
        if (prior) {
          const rejectedHere = prior.attempts.some(
            (a) =>
              a.outcome === "rejected" &&
              a.checkpointDigest === head.contentDigest,
          );
          if (rejectedHere) {
            // The same idea at the same content stays rejected.
            this.event(
              run,
              "opportunity-repeat",
              `"${o.title}" was rejected before at this content; it is not repeated unchanged.`,
            );
            continue;
          }
          this.store.save(loopKinds.opportunity, {
            ...prior,
            proposedBy: [...new Set([...prior.proposedBy, memberId])],
            state:
              prior.state === "rejected" || prior.state === "superseded"
                ? "proposed"
                : prior.state,
            checkpointDigest: head.contentDigest,
            updatedAt: now(),
          });
          continue;
        }
        const text = `${o.title} ${o.area} ${o.observedIssue}`.toLowerCase();
        const value: LoopOpportunity = {
          id: `${run.id}:opportunity:${fingerprint}`,
          runId: run.id,
          projectId: run.projectId,
          conversationId: run.id,
          fingerprint,
          ...o,
          priorityScore: priorityScore(
            o.scores,
            words.some((w) => text.includes(w)),
          ),
          state: "proposed",
          checkpointDigest: head.contentDigest,
          attempts: [],
          proposedBy: [memberId],
          createdAt: now(),
          updatedAt: now(),
        };
        existing.push(value);
        this.store.save(loopKinds.opportunity, value);
      }
    }
  }

  /** Whether the organization should be reviewed at this boundary. */
  private adaptationDue(run: LoopRun, it: LoopIteration): boolean {
    const policy = this.policy(run.id);
    if (!policy.automaticOrganization) return false;
    if (it.number === 1 || run.adaptationTrigger) return true;
    return this.iterationsSinceChange(run) >= policy.adaptation.dwellIterations;
  }

  private iterationsSinceChange(run: LoopRun): number {
    const topology = this.topology(run.topologyRevisionId!);
    return this.iterations(run).filter(
      (i) =>
        i.topologyRevisionId === topology.id &&
        (i.state === "promoted" || i.state === "rejected"),
    ).length;
  }

  // -------------------------------------------------------------------------
  // Organization

  private async organize(run: LoopRun, it: LoopIteration) {
    const topology = this.topology(run.topologyRevisionId!);
    const reverted = this.revertIfWorse(run, topology);
    if (reverted) {
      this.saveIteration(it, {
        state: "preparing",
        topologyRevisionId: reverted.id,
        detail: "Restored the preceding successful organization.",
      });
      return;
    }
    const result = await this.decisionRound(run, it, "organize");
    if (result.state !== "decided") return;
    const team = result.record.team;
    const latest = this.run(run.id);
    if (!team || !team.operations.length || !team.passed) {
      this.recordAdaptation(latest, {
        kind: team && team.operations.length ? "reject" : "keep",
        roundId: result.round.id,
        fromTopologyId: topology.id,
        toTopologyId: null,
        operations: team?.operations ?? [],
        reason:
          team?.reason ?? "The coordinators kept the current organization.",
        expectedBenefit: team?.expectedBenefit ?? "",
        rejections:
          team && !team.passed
            ? [
                "The frozen electorate's decision rule did not pass; the organization is unchanged.",
              ]
            : [],
        evidence: this.evidenceStrength(latest),
        trigger: team?.trigger ?? null,
        boundaryIteration: it.number,
        actor: "coordinators",
        dissent: result.record.dissent,
      });
      this.saveRun(latest, { adaptationTrigger: null });
      this.saveIteration(it, { state: "preparing" });
      return;
    }
    const change = this.proposeTopology(
      latest,
      topology,
      team.operations as TeamOperation[],
      team.trigger,
      result.round.id,
      team.reason,
    );
    if ("rejections" in change) {
      this.recordAdaptation(latest, {
        kind: "reject",
        roundId: result.round.id,
        fromTopologyId: topology.id,
        toTopologyId: null,
        operations: team.operations,
        reason: team.reason,
        expectedBenefit: team.expectedBenefit,
        rejections: change.rejections,
        evidence: this.evidenceStrength(latest),
        trigger: team.trigger,
        boundaryIteration: it.number,
        actor: "coordinators",
        dissent: result.record.dissent,
      });
      this.event(latest, "topology-rejected", change.rejections.join(" "));
    } else {
      this.commitTopology(latest, change.topology, {
        kind: "commit",
        roundId: result.round.id,
        operations: team.operations,
        reason: team.reason,
        expectedBenefit: team.expectedBenefit,
        trigger: team.trigger,
        boundaryIteration: it.number,
        actor: "coordinators",
        dissent: result.record.dissent,
      });
      it = this.saveIteration(it, { topologyRevisionId: change.topology.id });
    }
    this.saveRun(this.run(run.id), { adaptationTrigger: null });
    this.saveIteration(it, { state: "preparing" });
  }

  private evidenceStrength(run: LoopRun): AdaptationDecision["evidence"] {
    const outcomes = this.scoped<LoopOutcome>(loopKinds.outcome, run).length;
    return {
      outcomes,
      confidence: outcomes < 6 ? "low" : outcomes < 30 ? "moderate" : "high",
    };
  }

  private recordAdaptation(
    run: LoopRun,
    a: Omit<
      AdaptationDecision,
      "id" | "runId" | "projectId" | "conversationId" | "createdAt"
    >,
  ) {
    this.store.immutable(loopKinds.adaptation, {
      ...a,
      id: `${run.id}:adaptation:${uid()}`,
      runId: run.id,
      projectId: run.projectId,
      conversationId: run.id,
      createdAt: now(),
    } satisfies AdaptationDecision);
  }

  private commitTopology(
    run: LoopRun,
    topology: TeamTopologyRevision,
    a: Pick<
      AdaptationDecision,
      | "kind"
      | "roundId"
      | "operations"
      | "reason"
      | "expectedBenefit"
      | "trigger"
      | "boundaryIteration"
      | "actor"
      | "dissent"
    >,
  ) {
    const previous = this.topology(run.topologyRevisionId!);
    const handoff =
      topology.authorityGeneration !== previous.authorityGeneration;
    this.store.transaction(() => {
      this.store.immutable(loopKinds.topology, topology);
      const next = this.saveRun(run, {
        topologyRevisionId: topology.id,
        // A changed coordination team is a new authority generation: the
        // outgoing team's decisions against the old one are rejected.
        authorityGeneration: topology.authorityGeneration,
      });
      this.recordAdaptation(next, {
        ...a,
        fromTopologyId: previous.id,
        toTopologyId: topology.id,
        rejections: [],
        evidence: this.evidenceStrength(next),
      });
      this.event(
        next,
        "topology-changed",
        `${topology.reason}${handoff ? " The coordination team changed; the incoming team receives the versioned handoff package." : ""}`,
        { from: previous.id, to: topology.id },
      );
    });
  }

  /** Restores the preceding organization when a routine experiment did worse. */
  private revertIfWorse(
    run: LoopRun,
    topology: TeamTopologyRevision,
  ): TeamTopologyRevision | null {
    if (!topology.previousRevisionId) return null;
    const iterations = this.iterations(run);
    const results = (id: string) =>
      iterations
        .filter(
          (i) => i.topologyRevisionId === id && terminalIteration.has(i.state),
        )
        .map((i) => i.state as "promoted");
    if (
      !shouldRevert({
        current: topology,
        underCurrent: results(topology.id),
        underPrevious: results(topology.previousRevisionId),
      })
    )
      return null;
    const previous = this.topology(topology.previousRevisionId);
    const restored: TeamTopologyRevision = {
      ...previous,
      id: `${run.id}:topology:${topology.revision + 1}`,
      revision: topology.revision + 1,
      previousRevisionId: topology.id,
      proposedByRoundId: null,
      change: "revert",
      authorityGeneration: this.coordinationChanged(topology, previous)
        ? run.authorityGeneration + 1
        : run.authorityGeneration,
      effectiveFromIteration: run.iterationCount,
      reason: `The organization from revision ${topology.revision} did worse than revision ${previous.revision}; restoring it.`,
      createdAt: now(),
    };
    this.commitTopology(run, restored, {
      kind: "revert",
      roundId: null,
      operations: [],
      reason: restored.reason,
      expectedBenefit:
        "Return to the organization with better recorded outcomes.",
      trigger: "verification-failures",
      boundaryIteration: run.iterationCount,
      actor: LOOP_ACTOR,
      dissent: [],
    });
    return restored;
  }

  private coordinationChanged(
    a: TeamTopologyRevision,
    b: TeamTopologyRevision,
  ) {
    const role = (t: TeamTopologyRevision) =>
      t.roleBindings.find((x) => x.function === "coordination")?.roleId;
    const settings = (t: TeamTopologyRevision) =>
      t.roles.find((r) => r.roleId === role(t));
    return role(a) !== role(b) || stable(settings(a)) !== stable(settings(b));
  }

  /** User-locked fields of a role, from run overrides and project settings. */
  private locks(run: LoopRun, roleId: string, binding: GoalLoopBinding) {
    const group = this.orchestrator.effective(
      run.projectId,
      null,
      roleId,
      null,
      { binding, scopeId: `loop:${run.id}` },
    );
    const overrides = this.overrides(run);
    const released = group.form === "auto" && !group.members.length;
    const fields = new Set(
      (group.userFields ?? []).filter(
        (f) => !(released && (f === "form" || f === "members")),
      ),
    );
    return {
      fields,
      presence: overrides.some(
        (o) => o.kind === "role-presence" && o.roleId === roleId,
      ),
      pinned: group.members.some((m) => m.pin),
      exact: group.form === "exact" && fields.has("members"),
    };
  }

  /**
   * Validates a team change against user locks, capabilities, resource
   * settings and change policy. It accepts the valid proposal or returns
   * concrete reasons; it never silently rewrites the requested roster.
   */
  private proposeTopology(
    run: LoopRun,
    current: TeamTopologyRevision,
    operations: TeamOperation[],
    trigger: string,
    roundId: string | null,
    reason: string,
  ): { topology: TeamTopologyRevision } | { rejections: string[] } {
    const rejections: string[] = [];
    const policy = this.policy(run.id);
    const binding = this.loopBinding(run, current, null);
    const roles = current.roles.map((r) => ({
      ...r,
      adaptive: { ...r.adaptive },
    }));
    let bindings = current.roleBindings.map((b) => ({ ...b }));
    const catalog = this.repo.roles(run.projectId);
    const limit = this.repo.policy(run.projectId).maxMembersPerRole;
    const routes = this.driver
      .routes(run.projectId)
      .filter((r) => !binding.excludedProviders.includes(r.provider));
    const eligible = (purpose: string) =>
      new Set(
        routes
          .filter(
            (r) =>
              r.route === "managed-structured" &&
              r.catalog.fresh &&
              r.purposes[purpose as "information"]?.ready,
          )
          .flatMap((r) => r.catalog.models.map((m) => m.model)),
      );
    const role = (roleId: string) => roles.find((r) => r.roleId === roleId);
    const constrained = (roleId: string) => {
      const l = this.locks(run, roleId, binding);
      return l.presence || l.pinned || l.fields.size > 0;
    };
    const created: Array<{
      roleId: string;
      title: string;
      instructions: string;
      purpose: string;
    }> = [];
    const define = (
      roleId: string,
      title: string,
      instructions: string,
      purpose: string,
    ) => {
      if (
        catalog.some((r) => r.id === roleId) ||
        created.some((c) => c.roleId === roleId)
      )
        return false;
      created.push({ roleId, title, instructions, purpose });
      return true;
    };
    for (const op of operations) {
      switch (op.op) {
        case "create_role": {
          if (
            !define(
              op.roleId,
              op.title,
              op.instructions,
              functionPurpose[op.function],
            )
          ) {
            if (role(op.roleId))
              rejections.push(
                `Role ${op.roleId} already exists; activate it instead.`,
              );
            else
              roles.push({
                roleId: op.roleId,
                lineageId: op.roleId,
                active: true,
                adaptive: {
                  count: null,
                  models: [],
                  effort: null,
                  collaboration: null,
                  executionWidth: null,
                },
                origin: "coordinators",
                reason,
              });
            break;
          }
          roles.push({
            roleId: op.roleId,
            lineageId: op.roleId,
            active: true,
            adaptive: {
              count: null,
              models: [],
              effort: null,
              collaboration: null,
              executionWidth: null,
            },
            origin: "coordinators",
            reason,
          });
          break;
        }
        case "activate_role": {
          const r = role(op.roleId);
          if (r) r.active = true;
          else if (catalog.some((c) => c.id === op.roleId))
            roles.push({
              roleId: op.roleId,
              lineageId: op.roleId,
              active: true,
              adaptive: {
                count: null,
                models: [],
                effort: null,
                collaboration: null,
                executionWidth: null,
              },
              origin: "coordinators",
              reason,
            });
          else
            rejections.push(
              `Role ${op.roleId} is not in the role catalog; create it first.`,
            );
          break;
        }
        case "retire_role":
        case "split_role":
        case "merge_roles": {
          const ids = op.op === "merge_roles" ? op.roleIds : [op.roleId];
          for (const id of ids) {
            const r = role(id);
            if (!r?.active) {
              rejections.push(`Role ${id} is not active.`);
              continue;
            }
            // The optimizer cannot retire a constrained role and recreate its
            // function under another name to escape the owner's constraints.
            if (constrained(id)) {
              rejections.push(
                `Role ${id} carries your settings or pins; automation cannot retire, split or merge it.`,
              );
              continue;
            }
            r.active = false;
          }
          const into =
            op.op === "split_role"
              ? op.into
              : op.op === "merge_roles"
                ? [op.into]
                : [];
          const lineage = role(ids[0])?.lineageId ?? ids[0];
          const purpose =
            this.repo.roles(run.projectId).find((c) => c.id === ids[0])
              ?.purpose ?? "implementation";
          for (const [i, child] of into.entries()) {
            define(child.roleId, child.title, child.instructions, purpose);
            roles.push({
              roleId: child.roleId,
              lineageId:
                op.op === "split_role"
                  ? `${lineage}/${child.roleId}`
                  : `${ids.join("+")}`,
              active: true,
              adaptive: {
                count: null,
                models: [],
                effort: null,
                collaboration: null,
                executionWidth: null,
              },
              origin: "coordinators",
              reason,
            });
            // Functions served by the old role move to the first new role.
            if (i === 0)
              bindings = bindings.map((b) =>
                ids.includes(b.roleId)
                  ? { ...b, roleId: child.roleId, revision: b.revision + 1 }
                  : b,
              );
          }
          break;
        }
        case "set_members": {
          const r = role(op.roleId);
          if (!r?.active) {
            rejections.push(`Role ${op.roleId} is not active.`);
            break;
          }
          const l = this.locks(run, op.roleId, binding);
          if (l.exact) {
            rejections.push(
              `Role ${op.roleId} has your exact roster; its membership cannot change automatically.`,
            );
            break;
          }
          if (op.count !== null && l.fields.has("count")) {
            rejections.push(
              `Role ${op.roleId}'s member count is fixed by your settings.`,
            );
            break;
          }
          if (op.count !== null && op.count > limit) {
            rejections.push(
              `${op.count} members exceed the configured limit of ${limit} for one role.`,
            );
            break;
          }
          const purpose = this.repo.role(run.projectId, op.roleId).purpose;
          const ok = eligible(purpose);
          const unknown = op.models.filter((m) => !ok.has(m));
          if (unknown.length) {
            rejections.push(
              `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an observed, qualified model for ${purpose} on an allowed route.`,
            );
            break;
          }
          r.adaptive.count = op.count;
          r.adaptive.models = op.models;
          r.adaptive.effort = op.effort;
          break;
        }
        case "set_collaboration": {
          const r = role(op.roleId);
          if (!r?.active) {
            rejections.push(`Role ${op.roleId} is not active.`);
            break;
          }
          const l = this.locks(run, op.roleId, binding);
          if (
            l.fields.has("collaboration") ||
            (op.executionWidth !== null && l.fields.has("executionWidth"))
          ) {
            rejections.push(
              `Role ${op.roleId}'s collaboration is fixed by your settings.`,
            );
            break;
          }
          r.adaptive.collaboration = op.collaboration;
          r.adaptive.executionWidth = op.executionWidth;
          break;
        }
        case "bind_function": {
          const r = role(op.roleId);
          const purpose =
            catalog.find((c) => c.id === op.roleId)?.purpose ??
            created.find((c) => c.roleId === op.roleId)?.purpose;
          if (!r?.active || !purpose) {
            rejections.push(`Role ${op.roleId} is not active.`);
            break;
          }
          if (purpose !== functionPurpose[op.function]) {
            rejections.push(
              `Role ${op.roleId} has purpose ${purpose}; the ${op.function} function needs ${functionPurpose[op.function]}.`,
            );
            break;
          }
          bindings = bindings.map((b) =>
            b.function === op.function
              ? {
                  ...b,
                  roleId: op.roleId,
                  lineageId: r.lineageId,
                  id: `${r.lineageId}:${op.function}`,
                  revision: b.revision + 1,
                }
              : b,
          );
          break;
        }
      }
    }
    for (const fn of requiredFunctions) {
      const b = bindings.find((x) => x.function === fn);
      if (!b || !role(b.roleId)?.active)
        rejections.push(`The ${fn} function would have no active role.`);
    }
    for (const o of this.overrides(run)) {
      if (o.kind === "role-presence" && !role(o.roleId!)?.active)
        rejections.push(
          `You asked to always keep ${o.roleId}; it cannot be retired.`,
        );
      if (
        o.kind === "active-role-count" &&
        roles.filter((r) => r.active).length !== Number(o.value)
      )
        rejections.push(
          `You asked for exactly ${o.value} active roles; this organization has ${roles.filter((r) => r.active).length}.`,
        );
    }
    const proposed = { roles, roleBindings: bindings };
    const history = this.scoped<TeamTopologyRevision>(loopKinds.topology, run)
      .filter((t) => t.id !== current.id)
      .sort((a, b) => b.revision - a.revision);
    const window = this.scoped<LoopOutcome>(loopKinds.outcome, run).slice(-200);
    const used = new Set(window.map((o) => o.model));
    const newModels = roles
      .flatMap((r) => r.adaptive.models)
      .filter((m) => !used.has(m));
    const change = checkChange({
      policy: policy.adaptation,
      // The first coordinator round proposes the complete organization: the
      // bootstrap is not a routine organization that must dwell.
      trigger:
        current.change === "bootstrap" && trigger === "none"
          ? "bootstrap"
          : trigger,
      operations,
      iterationsSinceChange: this.iterationsSinceChange(run),
      history,
      proposed,
      current,
      evidenceOutcomes: window.length,
      windowTurns: window.length,
      exploratoryTurns: 0,
      newExploratoryTurns: newModels.length,
    });
    rejections.push(...change.reasons);
    if (rejections.length) return { rejections: [...new Set(rejections)] };
    // Custom roles a coordinator proposes are defined in the catalog, with
    // the purpose their function requires.
    for (const c of created) {
      const key = `${run.projectId}:${c.roleId}`;
      if (!this.repo.get(kinds.role, key)) {
        const role: RoleDefinition & { roleId: string } = {
          id: key,
          roleId: c.roleId,
          projectId: run.projectId,
          revision: 1,
          title: c.title,
          instructions: c.instructions,
          purpose: c.purpose as RoleDefinition["purpose"],
          requiredCapabilities: [],
          permittedOperations:
            c.purpose === "implementation"
              ? ["write-permitted-outputs"]
              : ["read-inputs"],
          outputContract:
            c.purpose === "implementation"
              ? "code-candidate"
              : c.purpose === "candidate-review"
                ? "candidate-review"
                : c.purpose === "coordinator-contribution"
                  ? "coordinator-proposal"
                  : "information",
          defaultCollaboration:
            c.purpose === "implementation"
              ? "parallel-partitioned"
              : c.purpose === "coordinator-contribution"
                ? "peer-collaboration"
                : "parallel-independent",
        };
        this.repo.saveRevisioned(kinds.role, role);
      }
    }
    const fixed = bindings.map((b) => {
      const r = this.repo.role(run.projectId, b.roleId);
      return {
        ...b,
        purpose: functionPurpose[b.function],
        outputContract: r.outputContract,
        roleDefinitionRevision: r.revision,
      };
    });
    const next: TeamTopologyRevision = {
      ...current,
      id: `${run.id}:topology:${current.revision + 1}`,
      revision: current.revision + 1,
      roles,
      roleBindings: fixed,
      resolvedAssignmentRevisions: [],
      overrideRevision: run.overrideRevision,
      proposedByRoundId: roundId,
      decisionDigest: topologyDigest({ roles, roleBindings: fixed }),
      evidenceIds: [],
      effectiveFromIteration: run.iterationCount,
      previousRevisionId: current.id,
      reason,
      change:
        trigger === "none" && current.change !== "bootstrap"
          ? "routine"
          : "trigger",
      authorityGeneration: run.authorityGeneration,
      createdAt: now(),
    };
    if (this.coordinationChanged(current, next))
      next.authorityGeneration = run.authorityGeneration + 1;
    return { topology: next };
  }

  /** The adaptive layer, overrides and ranking a child goal or round resolves with. */
  private loopBinding(
    run: LoopRun,
    topology: TeamTopologyRevision,
    it: LoopIteration | null,
  ): GoalLoopBinding {
    const policy = this.policy(run.id);
    const overrides = this.overrides(run);
    const settings: Record<string, RoleGroupSettings> = {};
    for (const o of overrides)
      if (
        (o.kind === "role-settings" || o.kind === "role-frozen") &&
        o.roleId &&
        o.settings
      )
        settings[o.roleId] = { ...(settings[o.roleId] ?? {}), ...o.settings };
    const excluded = [
      ...new Set([
        ...policy.excludedProviders,
        ...overrides
          .filter((o) => o.kind === "provider-exclusion")
          .map((o) => String(o.value) as "codex"),
      ]),
    ];
    const outcomes = this.projectOutcomes(run);
    const routes = this.driver
      .routes(run.projectId)
      .filter((r) => !excluded.includes(r.provider));
    const family = `${run.mode}:${it?.contract?.targets.length ? "goal" : "improvement"}`;
    const ranking: Record<string, string[]> = {};
    const adaptive: Record<string, RoleGroupSettings> = {};
    for (const r of topology.roles.filter((x) => x.active)) {
      const fn =
        topology.roleBindings.find((b) => b.roleId === r.roleId)?.function ??
        null;
      const purpose = this.repo
        .roles(run.projectId)
        .find((c) => c.id === r.roleId)?.purpose;
      if (fn && purpose) {
        const eligible = routes
          .filter(
            (x) =>
              x.route === "managed-structured" &&
              x.catalog.fresh &&
              x.purposes[purpose]?.ready,
          )
          .flatMap((x) =>
            [...x.catalog.models]
              .sort(
                (a, b) =>
                  Number(b.isDefault) - Number(a.isDefault) ||
                  a.model.localeCompare(b.model),
              )
              .map((m) => ({ provider: x.provider, model: m.model })),
          );
        ranking[r.roleId] = rankModels({
          outcomes,
          function: fn,
          taskFamily: family,
          eligible,
        }).ranking;
      }
      const a = r.adaptive;
      const value: RoleGroupSettings = {};
      if (a.count !== null) value.count = a.count;
      if (a.collaboration) value.collaboration = a.collaboration;
      if (a.executionWidth !== null) value.executionWidth = a.executionWidth;
      if (a.models.length)
        value.members = a.models.map((model, i) => ({
          memberId: `${r.roleId}-auto-${i + 1}`,
          required: true,
          pin: null,
          fallbacks: [],
          preferences: { providers: [], models: [model] },
          source: {
            kind: "auto",
            reference: topology.id,
            provenance: "default",
          },
        }));
      if (Object.keys(value).length) adaptive[r.roleId] = value;
    }
    const goals = this.goals(run);
    return {
      runId: run.id,
      iterationId: it?.id ?? "",
      controlGeneration: run.controlGeneration,
      topologyRevisionId: topology.id,
      activeRoles: topology.roles.filter((r) => r.active).map((r) => r.roleId),
      adaptive,
      excludedProviders: excluded,
      ranking,
      overrides: settings,
      complexity: goalComplexity(
        `${run.title} ${goals.map((g) => g.text).join(" ")}`,
      ),
    };
  }

  private functions(topology: TeamTopologyRevision) {
    const of = (fn: LoopFunction) =>
      topology.roleBindings.find((b) => b.function === fn)!.roleId;
    return {
      coordination: of("coordination"),
      review: of("review"),
      implementation: of("implementation"),
      integration:
        topology.roleBindings.find((b) => b.function === "integration")
          ?.roleId ?? of("implementation"),
    };
  }

  // -------------------------------------------------------------------------
  // Preparing and executing the iteration's child goal

  private async prepare(
    run: LoopRun,
    it: LoopIteration,
    admission: { available: boolean },
  ) {
    const policy = this.policy(run.id);
    if (!admission.available) {
      this.softWait(run, {
        kind: "capacity",
        detail: "Another run started work this tick; waiting for a fair turn.",
      });
      return;
    }
    // Endless runs yield: a loop admits new work only while capacity remains
    // for direct user work.
    const capacity = this.driver.capacity();
    const held = capacity.held.reduce((n, h) => n + h.weight, 0);
    const reserve = policy.scheduling.reserveForDirectWork;
    if (capacity.total > reserve && capacity.total - held <= reserve) {
      this.softWait(run, {
        kind: "capacity",
        detail: `Keeping ${reserve} of ${capacity.total} execution slots for direct work; ${held} are in use.`,
      });
      return;
    }
    const limit = this.allowanceLimit(run);
    if (limit) return this.wait(run, limit.reason, limit.retryAt);
    const topology = this.topology(it.topologyRevisionId);
    const binding = this.loopBinding(run, topology, it);
    const functions = this.functions(topology);
    // Every required function resolves before anything starts; a required
    // assignment that cannot run is a visible blocker, never a smaller team.
    const assignments: AssignmentRevisionRef[] = [];
    const blockers: string[] = [];
    let pinned = false;
    for (const r of topology.roles.filter((x) => x.active)) {
      const resolved = this.orchestrator.resolve(
        run.projectId,
        null,
        r.roleId,
        null,
        { binding, scopeId: `loop:${run.id}` },
      );
      const required = new Map(
        resolved.group.members.map((m) => [m.memberId, m.required]),
      );
      for (const a of resolved.assignments) {
        assignments.push({
          roleId: r.roleId,
          memberId: a.memberId,
          bindingId:
            topology.roleBindings.find((b) => b.roleId === r.roleId)?.id ??
            null,
          assignmentId: a.id,
          assignmentRevision: a.revision,
          provider: a.provider,
          model: a.model,
          required: required.get(a.memberId) ?? true,
          status: a.status,
        });
        const needed = Object.values(functions).includes(r.roleId);
        if (
          needed &&
          (required.get(a.memberId) ?? true) &&
          a.status !== "resolved"
        ) {
          blockers.push(`${r.roleId}/${a.memberId}: ${a.reason}`);
          if (a.selection !== "auto") pinned = true;
        }
      }
      if (
        Object.values(functions).includes(r.roleId) &&
        resolved.conflicts.length
      )
        blockers.push(...resolved.conflicts.map((c) => `${r.roleId}: ${c}`));
    }
    if (blockers.length) {
      if (!pinned)
        this.saveRun(run, { adaptationTrigger: "unavailable-route" });
      return this.wait(
        this.run(run.id),
        {
          kind: pinned ? "pinned-model" : "route",
          detail: `${pinned ? "A pinned required member is unavailable; its pin is kept and only its authorized fallback may stand in." : "A required role cannot be filled from a qualified route."} ${blockers.slice(0, 4).join(" ")}`,
        },
        null,
      );
    }
    const providers = [
      ...new Set(
        assignments
          .filter((a) => a.status === "resolved")
          .map((a) => a.provider!)
          .filter(Boolean),
      ),
    ];
    const limits = this.loop.providerLimits?.(providers) ?? [];
    if (limits.length) {
      const first = limits[0];
      return this.wait(
        run,
        first.kind === "quota"
          ? {
              kind: "quota",
              detail: `${first.provider}: ${first.detail}`,
              retryAt: first.retryAt,
            }
          : {
              kind: "allowance",
              detail: `${first.provider}: ${first.detail}`,
              renewsAt: first.retryAt,
            },
        first.retryAt,
      );
    }
    // Admission is fenced by the run's generation, checked again after each await.
    const fresh = this.run(run.id);
    if (
      fresh.desiredState !== "running" ||
      fresh.controlGeneration !== it.controlGeneration
    )
      return;
    admission.available = false;
    const goalId = `${it.id}:goal:${it.childExecutionGoalIds.length + 1}`;
    // Recorded before creation, so a concurrent stop finds and stops it.
    it = this.saveIteration(it, {
      childExecutionGoalIds: [...it.childExecutionGoalIds, goalId],
      assignments,
      detail: "Preparing the iteration baseline from the accepted checkpoint.",
    });
    const head = this.checkpoint(it.parentCheckpointId);
    const kind = this.childKind(run, it);
    let baseline: string;
    try {
      baseline = await this.loop.childBaseline({
        projectId: run.projectId,
        runId: run.id,
        goalId,
        candidateId: head.candidateId,
      });
    } catch (error) {
      return this.wait(
        run,
        {
          kind: "setup",
          detail: `The iteration baseline could not be prepared: ${safeError(error)}`,
        },
        null,
      );
    }
    const remaining = this.remainingTurns(run, policy);
    const goals = this.goals(run).filter((g) => it.goalIds.includes(g.id));
    await this.orchestrator.createGoal({
      conversationId: run.conversationId,
      objective: this.contractText(run, it),
      kind,
      constraints: [
        ...new Set(goals.flatMap((g) => g.constraints)),
        "Work only within this iteration's contract. Existing tests, check configuration and check scripts are protected and cannot be weakened.",
      ],
      grant: {
        taskKinds: kind === "code" ? policy.allowedWork : ["information"],
        maxTurns: remaining,
        maxDelegatedTasks: policy.iteration.maxDelegatedTasks,
        maxRepairRounds: policy.iteration.maxRepairRounds,
        maxReconciliationTurns: 1,
        expiresAt: null,
      },
      checks: kind === "code" ? policy.checks : [],
      commandId: `${goalId}:create`,
      goalId,
      loop: binding,
      functions,
      baselineCandidateId: baseline,
      message: false,
    });
    if (kind === "code" && policy.checks.length) {
      const problems = this.loop.protocolProblems({
        runId: run.id,
        goalId,
        checks: policy.checks,
      });
      if (problems.length)
        return this.reject(
          this.run(run.id),
          this.repo.require(loopKinds.iteration, it.id),
          { kind: "environment", detail: problems.join(" ") },
        );
    }
    const after = this.run(run.id);
    if (
      after.desiredState !== "running" ||
      after.controlGeneration !== it.controlGeneration
    ) {
      await this.orchestrator
        .controlCommand({
          projectId: run.projectId,
          goalId,
          action: after.desiredState === "stopped" ? "stop" : "pause",
          commandId: `${goalId}:fence`,
        })
        .catch(() => {});
      return;
    }
    this.store.transaction(() => {
      this.saveIteration(
        this.repo.require<LoopIteration>(loopKinds.iteration, it.id),
        {
          state: "executing",
          detail: `Executing: ${it.contract?.summary ?? ""}`,
        },
      );
      const at = now();
      this.saveRun(after, {
        lastAdmissionAt: at,
        waitReason: null,
        detail: `Iteration ${it.number}: executing.`,
      });
      this.store.put(loopKinds.active, {
        id: run.id,
        projectId: run.projectId,
        runId: run.id,
        lastAdmissionAt: at,
      } satisfies ActiveIndex);
    });
  }

  private childKind(run: LoopRun, it: LoopIteration): "code" | "information" {
    if (run.mode === "endless")
      return this.policy(run.id).allowedWork.includes("implementation")
        ? "code"
        : "information";
    const goals = this.goals(run).filter((g) => it.goalIds.includes(g.id));
    return goals.some((g) => g.kind === "code") ? "code" : "information";
  }

  private contractText(run: LoopRun, it: LoopIteration): string {
    const c = it.contract!;
    const goals = this.goals(run).filter((g) => it.goalIds.includes(g.id));
    return [
      `Loop iteration ${it.number} of "${run.title}" (${run.mode === "goal" ? "Goal" : "Endless"} mode).`,
      c.summary,
      c.acceptanceConditions.length
        ? `Acceptance conditions:\n- ${c.acceptanceConditions.join("\n- ")}`
        : "",
      c.approach ? `Approach: ${c.approach}` : "",
      goals.length
        ? `Goals advanced by this iteration:\n${goals.map((g) => `- ${g.text}${g.criteria.length ? ` (${g.criteria.map((k) => `${k.text} [${describeKind(k.verification)}]`).join("; ")})` : ""}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 20000);
  }

  private childGoal(it: LoopIteration): Goal | undefined {
    const id = it.childExecutionGoalIds.at(-1);
    return id ? this.repo.get<Goal>(kinds.goal, id) : undefined;
  }

  private async execute(run: LoopRun, it: LoopIteration) {
    const goal = this.childGoal(it);
    if (!goal) {
      this.saveIteration(it, { state: "preparing" });
      return;
    }
    it = this.account(run, it, this.childTurns(it) + this.roundTurns(run, it));
    switch (goal.state) {
      case "planning":
      case "running":
      case "reviewing": {
        // A child whose bounded grant cannot cover its required turns ends as
        // a limit; the next admission waits for the allowance instead.
        if (/cannot start: The goal's turn allowance/.test(goal.detail))
          return this.reject(run, it, { kind: "limit", detail: goal.detail });
        const stuck = /^(Coordinators|Reviewers) cannot start: /.exec(
          goal.detail,
        );
        this.softWait(
          run,
          stuck ? { kind: "route", detail: goal.detail } : null,
          stuck ? undefined : `Iteration ${it.number}: ${goal.detail}`,
        );
        return;
      }
      case "paused":
        return;
      case "stopped":
        if (!goal.loopDisposition)
          return this.reject(run, it, {
            kind: "stopped",
            detail: "The iteration's work was stopped outside the loop.",
          });
        return;
      case "blocked":
        return this.handleBlocked(run, it, goal);
      case "checking":
        return this.runChecks(run, it, goal);
      case "awaiting-acceptance":
      case "completed":
      case "accepted":
        this.saveIteration(it, {
          state: "evaluating",
          detail: "Evaluating the result against the goals.",
        });
        return;
    }
  }

  /**
   * Classifies a blocked child before responding: a product defect calls for
   * repair, overlapping changes for integration, missing output for a fresh
   * round, and a material product choice for the owner. Missing or failed
   * evidence never counts as a pass.
   */
  private async handleBlocked(run: LoopRun, it: LoopIteration, goal: Goal) {
    const left = goal.usage.repairRounds < goal.grant.maxRepairRounds;
    const n = goal.usage.repairRounds + 1;
    if (goal.conflicts?.length) {
      if (!left)
        return this.reject(
          run,
          it,
          {
            kind: "integration",
            detail: "Overlapping changes remain after the repair limit.",
          },
          "repairs-exhausted",
        );
      await this.orchestrator.integrateConflicts({
        goalId: goal.id,
        commandId: `${goal.id}:integrate:${n}`,
        actor: LOOP_ACTOR,
      });
      this.saveIteration(it, {
        repairs: it.repairs + 1,
        detail:
          "Integrating overlapping changes; every contributor's work is kept.",
      });
      return;
    }
    const completion = goal.reviewCompletionId
      ? this.repo.get<RoleCompletion>(kinds.completion, goal.reviewCompletionId)
      : undefined;
    if (
      completion &&
      completion.candidateId === goal.candidateId &&
      completion.result === "blocked"
    ) {
      if (!left)
        return this.reject(
          run,
          it,
          {
            kind: "product-defect",
            detail:
              "Substantiated review findings remain after the repair limit.",
          },
          "repairs-exhausted",
        );
      await this.orchestrator.repair({
        goalId: goal.id,
        commandId: `${goal.id}:repair:${n}`,
        actor: LOOP_ACTOR,
        cause: { kind: "findings" },
      });
      this.saveIteration(it, {
        repairs: it.repairs + 1,
        detail: `Repairing review findings (${n}).`,
      });
      return;
    }
    const rounds = this.orchestrator.rounds(goal.id);
    if (rounds.some((r) => r.stage === "awaiting-user")) {
      this.softWait(run, {
        kind: "user-input",
        detail: `Iteration ${it.number}'s coordinators disagree on the plan; choose a branch. Other runs continue.`,
        goalIds: it.goalIds,
      });
      return;
    }
    if (/Steer the goal to replan\.$/.test(goal.detail)) {
      await this.orchestrator.steer({
        goalId: goal.id,
        text: "Replan against the current resolved organization.",
        commandId: `${goal.id}:replan:${goal.planRevision}`,
        actor: LOOP_ACTOR,
      });
      return;
    }
    if (/cannot start: its predecessors changed/.test(goal.detail))
      return this.reject(run, it, { kind: "integration", detail: goal.detail });
    const blocked = rounds.filter(
      (r) => r.stage === "blocked" && !r.members.some((m) => m.activeAttemptId),
    );
    if (blocked.length && it.restarts < 2) {
      // Invalid or missing required output: one fresh round, never a smaller quorum.
      for (const r of blocked)
        await this.orchestrator
          .restartRound({
            goalId: goal.id,
            roundId: r.id,
            commandId: `${r.id}:loop-restart`,
          })
          .catch(() => {});
      this.saveIteration(it, {
        restarts: it.restarts + 1,
        detail:
          "Required output was missing or invalid; restarting the round with fresh inputs.",
      });
      return;
    }
    if (blocked.length)
      return this.reject(
        run,
        it,
        { kind: "invalid-output", detail: goal.detail },
        "invalid-output",
      );
    return this.reject(run, it, {
      kind: "product-defect",
      detail: goal.detail,
    });
  }

  /** Repeated, authorized checks against the exact candidate. */
  private async runChecks(run: LoopRun, it: LoopIteration, goal: Goal) {
    const policy = this.policy(run.id);
    const status = this.orchestrator.checkStatus(goal);
    const failed = status.results.filter((r) => r.result === "failed");
    const broken = status.results.filter(
      (r) => r.result && !["passed", "failed", "pending"].includes(r.result),
    );
    if (failed.length) {
      if (goal.usage.repairRounds >= goal.grant.maxRepairRounds)
        return this.reject(
          run,
          it,
          {
            kind: "product-defect",
            detail: `Required checks still fail: ${failed.map((r) => r.label).join(", ")}.`,
          },
          "verification-failures",
        );
      await this.orchestrator.repair({
        goalId: goal.id,
        commandId: `${goal.id}:repair:${goal.usage.repairRounds + 1}`,
        actor: LOOP_ACTOR,
        cause: { kind: "checks" },
      });
      this.saveIteration(it, {
        state: "executing",
        repairs: it.repairs + 1,
        detail: `Repairing failed checks: ${failed.map((r) => r.label).join(", ")}.`,
      });
      return;
    }
    if (broken.length) {
      // An environment failure is a visible wait, never a pass. Each failed
      // verification is waited on once; after the wakeup the checks run again.
      const ids = broken.map((r) => r.verificationId!).sort();
      const waited =
        this.store.get<{ ids: string[] }>("loop-verification-wait", goal.id)
          ?.ids ?? [];
      if (!ids.every((id) => waited.includes(id))) {
        this.store.put("loop-verification-wait", {
          id: goal.id,
          projectId: run.projectId,
          ids: [...new Set([...waited, ...ids])],
        });
        this.saveIteration(it, { state: "verifying" });
        return this.wait(
          run,
          {
            kind: "verification",
            detail: `The check environment failed (${broken.map((r) => `${r.label}: ${r.result}`).join(", ")}). No result counts as a pass; the checks run again after the wait.`,
          },
          null,
        );
      }
    }
    const missing = status.results.filter(
      (r) => !r.result || broken.includes(r),
    );
    if (!missing.length) return;
    if (!policy.automaticChecks) {
      this.saveIteration(it, { state: "verifying" });
      this.softWait(run, {
        kind: "authorization",
        detail: `Iteration ${it.number}'s candidate needs its required checks. Run them from the iteration view, or allow automatic checks in the run policy.`,
      });
      return;
    }
    this.saveIteration(it, {
      state: "verifying",
      detail: "Running the required checks on the exact candidate.",
    });
    try {
      const plans = await this.orchestrator.previewChecks({ goalId: goal.id });
      for (const plan of plans.filter((p) =>
        missing.some((m) => m.definitionId === p.definition.id),
      )) {
        this.recordAuthorization(
          run,
          it,
          goal.id,
          plan.candidateId,
          {
            id: plan.id,
            digest: plan.digest,
            definitionId: plan.definition.id,
          },
          policy,
        );
        await this.orchestrator.runCheck({
          planId: plan.id,
          digest: plan.digest,
        });
      }
    } catch (error) {
      return this.wait(
        run,
        {
          kind: "verification",
          detail: `The required checks could not run: ${safeError(error)} No result counts as a pass.`,
        },
        null,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Evaluation, promotion and rejection

  private async evaluate(run: LoopRun, it: LoopIteration) {
    const goal = this.childGoal(it)!;
    const head = this.checkpoint(it.parentCheckpointId);
    const result = await this.decisionRound(run, it, "evaluate");
    if (result.state !== "decided") return;
    it = this.repo.require<LoopIteration>(loopKinds.iteration, it.id);
    // The exact bytes the evaluators were given; a later change cannot borrow this assessment.
    const target = {
      ...result.round.target,
      candidateId: result.round.contextCandidateId ?? "",
    };
    const assessable = this.assessable(run, it);
    const ids = this.recordAssessments(
      run,
      it,
      result.record,
      target,
      assessable,
      goal,
    );
    const assessments = ids.map((id) =>
      this.repo.require<GoalAssessment>(loopKinds.assessment, id),
    );
    const by = new Map(assessments.map((a) => [a.goalId, a]));
    const targets =
      run.mode === "goal" ? it.goalIds : [this.contractGoal(it).id];
    const satisfied = targets.every((id) => by.get(id)?.result === "satisfied");
    // A goal satisfied at the parent that this candidate breaks is regressed.
    const regressed = this.goals(run).filter(
      (g) =>
        g.status === "satisfied" &&
        g.satisfiedAtCheckpointId === head.id &&
        by.get(g.id) &&
        by.get(g.id)!.result !== "satisfied",
    );
    if (regressed.length)
      this.store.transaction(() => {
        for (const g of regressed)
          this.saveGoal(g, {
            status: "regressed",
            regression: {
              previousCheckpointId: head.id,
              checkpointId: head.id,
              iterationId: it.id,
            },
          });
        this.event(
          this.run(run.id),
          "goal-regressed",
          `Iteration ${it.number}'s candidate breaks ${regressed.map((g) => g.text).join("; ")}; repairing before promotion.`,
        );
      });
    it = this.saveIteration(it, {
      assessmentIds: [...new Set([...it.assessmentIds, ...ids])],
    });
    if (satisfied && !regressed.length) {
      this.saveIteration(it, {
        state: "promoting",
        detail: "The contract is satisfied; promoting.",
      });
      return this.promote(
        this.run(run.id),
        this.repo.require<LoopIteration>(loopKinds.iteration, it.id),
      );
    }
    const unmet = assessments
      .filter(
        (a) =>
          targets.includes(a.goalId) ||
          regressed.some((g) => g.id === a.goalId),
      )
      .flatMap((a) => {
        const g = assessable.find((x) => x.id === a.goalId);
        return a.criteria
          .filter((c) => c.result !== "met")
          .map(
            (c) =>
              `${g?.text ?? a.goalId}: ${g?.criteria.find((k) => k.id === c.criterionId)?.text ?? c.criterionId}${c.validation === "missing-evidence" ? " (evidence missing)" : ""}`,
          );
      });
    const requests = result.record.decisions
      .map((d) => d.decision as LoopDecision)
      .filter((d) => d.kind === "request_repair") as Array<
      Extract<LoopDecision, { kind: "request_repair" }>
    >;
    const transient =
      requests.length > 0 && requests.every((r) => r.failure === "transient");
    const environment = requests.some((r) => r.failure === "environment");
    if (environment) {
      // The wait ends in a fresh evaluation, never the same decision again.
      this.saveRound(result.round, {
        state: "stale",
        detail: "Evaluated again after the verification wait.",
      });
      return this.wait(
        run,
        {
          kind: "verification",
          detail: `Evaluation reports a verification environment problem: ${requests.find((r) => r.failure === "environment")!.summary}`,
        },
        null,
      );
    }
    const left = goal.usage.repairRounds < goal.grant.maxRepairRounds;
    if (
      goal.kind === "code" &&
      goal.candidateId &&
      left &&
      !transient &&
      unmet.length
    ) {
      const roleId = requests.find((r) => r.roleId)?.roleId ?? undefined;
      await this.orchestrator
        .repair({
          goalId: goal.id,
          commandId: `${goal.id}:repair:${goal.usage.repairRounds + 1}`,
          actor: LOOP_ACTOR,
          cause: { kind: "criteria", unmet },
          roleId: roleId ?? undefined,
        })
        .catch(() =>
          this.orchestrator.repair({
            goalId: goal.id,
            commandId: `${goal.id}:repair:${goal.usage.repairRounds + 1}:default`,
            actor: LOOP_ACTOR,
            cause: { kind: "criteria", unmet },
          }),
        );
      this.saveIteration(
        this.repo.require<LoopIteration>(loopKinds.iteration, it.id),
        {
          state: "executing",
          repairs: it.repairs + 1,
          detail: `Repairing ${unmet.length} unmet ${unmet.length === 1 ? "condition" : "conditions"}.`,
        },
      );
      return;
    }
    return this.reject(
      run,
      this.repo.require<LoopIteration>(loopKinds.iteration, it.id),
      {
        kind: transient
          ? "transient"
          : goal.kind === "code" && !left
            ? "limit"
            : "product-defect",
        detail: unmet.length
          ? `Not satisfied: ${unmet.slice(0, 6).join("; ")}`
          : "The evaluation did not satisfy the contract.",
      },
      transient ? null : "no-progress",
    );
  }

  /**
   * Automatic internal promotion. The evaluated candidate's exact content
   * advances the accepted checkpoint by compare-and-swap on its parent, in one
   * transaction with the iteration result, assessments and the next
   * iteration's intent. One candidate advances one parent transition once.
   */
  private async promote(run: LoopRun, it: LoopIteration) {
    const goal = this.childGoal(it)!;
    const policy = this.policy(run.id);
    const parent = this.checkpoint(it.parentCheckpointId);
    const code = goal.kind === "code" && !!goal.candidateId;
    const promotionId = `${run.id}:promotion:${hash(stable([parent.id, goal.candidateId ?? `info:${it.id}`])).slice(0, 24)}`;
    const recorded = this.repo.get<PromotionDecision>(
      loopKinds.promotion,
      promotionId,
    );
    if (recorded) {
      // Promotion persisted and its notification may be missing: settle once.
      this.orchestrator.settleLoopGoal({
        goalId: goal.id,
        outcome: "promoted",
        promotionId,
        detail: `Promoted by loop policy into checkpoint ${recorded.checkpointId}.`,
      });
      return;
    }
    const problems: string[] = [];
    if (run.acceptedCheckpointId !== parent.id)
      problems.push(
        "The accepted checkpoint moved since this iteration started.",
      );
    if (
      this.orchestrator
        .rounds(goal.id)
        .some((r) => r.members.some((m) => m.activeAttemptId))
    )
      return; // Not quiescent yet.
    let checkEvidence: PromotionDecision["checkEvidence"] = [];
    let contentDigest = parent.contentDigest;
    let reviewCompletionId: string | null = null;
    if (code) {
      const completion = goal.reviewCompletionId
        ? this.repo.get<RoleCompletion>(
            kinds.completion,
            goal.reviewCompletionId,
          )
        : undefined;
      if (
        !completion ||
        completion.result !== "satisfied" ||
        completion.candidateId !== goal.candidateId
      )
        problems.push("The candidate's required review is not satisfied.");
      reviewCompletionId = completion?.id ?? null;
      const checks = this.orchestrator.checkStatus(goal);
      if (!checks.passing)
        problems.push(
          `Required checks are not current and passing: ${checks.detail}`,
        );
      checkEvidence = checks.results
        .filter((r) => r.verificationId)
        .map((r) => ({
          definitionId: r.definitionId,
          verificationId: r.verificationId!,
        }));
      if (policy.checks.length)
        problems.push(
          ...this.loop.protocolProblems({
            runId: run.id,
            goalId: goal.id,
            checks: policy.checks,
          }),
        );
      contentDigest = this.loop.contentDigest(goal.candidateId!) ?? "";
      // Assessments of different bytes, or of the parent, cannot authorize this candidate.
      const assessments = it.assessmentIds.map((id) =>
        this.repo.require<GoalAssessment>(loopKinds.assessment, id),
      );
      const current = assessments.filter(
        (a) =>
          a.target.kind === "candidate" &&
          a.target.candidateId === goal.candidateId,
      );
      if (
        !current.length ||
        current.some((a) => a.target.contentDigest !== contentDigest)
      )
        problems.push(
          "The candidate's assessment does not cover these exact bytes.",
        );
    }
    if (problems.length)
      return this.reject(run, it, {
        kind: "product-defect",
        detail: problems.join(" "),
      });
    const checkpointId = code
      ? `${run.id}:checkpoint:${parent.sequence + 1}`
      : parent.id;
    const assessments = it.assessmentIds.map((id) =>
      this.repo.require<GoalAssessment>(loopKinds.assessment, id),
    );
    let committed = false;
    this.store.transaction(() => {
      const latest = this.run(run.id);
      if (this.repo.get(loopKinds.promotion, promotionId)) return; // Already committed; settle below.
      if (
        latest.acceptedCheckpointId !== parent.id ||
        latest.desiredState !== "running" ||
        latest.controlGeneration !== it.controlGeneration
      )
        return;
      const at = now();
      if (code) {
        this.store.immutable(loopKinds.checkpoint, {
          id: checkpointId,
          runId: run.id,
          projectId: run.projectId,
          conversationId: run.id,
          sequence: parent.sequence + 1,
          candidateId: goal.candidateId!,
          contentDigest,
          parentCheckpointId: parent.id,
          iterationId: it.id,
          promotionId,
          kind: "promoted",
          pinned: false,
          createdAt: at,
        } satisfies LoopCheckpoint);
        this.store.immutable(loopKinds.promotion, {
          id: promotionId,
          runId: run.id,
          projectId: run.projectId,
          conversationId: run.id,
          iterationId: it.id,
          parentCheckpointId: parent.id,
          candidateId: goal.candidateId!,
          contentDigest,
          checkpointId,
          by: LOOP_ACTOR,
          policyRevision: policy.revision,
          controlGeneration: latest.controlGeneration,
          assessmentIds: assessments.map((a) => a.id),
          reviewCompletionId,
          checkEvidence,
          protocolRevision: it.verificationProtocolRevision,
          at,
        } satisfies PromotionDecision);
      } else
        this.store.immutable(loopKinds.promotion, {
          id: promotionId,
          runId: run.id,
          projectId: run.projectId,
          conversationId: run.id,
          iterationId: it.id,
          parentCheckpointId: parent.id,
          candidateId: parent.candidateId,
          contentDigest,
          checkpointId,
          by: LOOP_ACTOR,
          policyRevision: policy.revision,
          controlGeneration: latest.controlGeneration,
          assessmentIds: assessments.map((a) => a.id),
          reviewCompletionId: null,
          checkEvidence: [],
          protocolRevision: it.verificationProtocolRevision,
          at,
        } satisfies PromotionDecision);
      this.saveIteration(it, {
        state: "promoted",
        resultCheckpointId: checkpointId,
        promotionId,
        settlementPending: "promoted",
        endedAt: at,
        detail: code
          ? `Promoted to checkpoint ${parent.sequence + 1}.`
          : "Information accepted; the checkpoint content is unchanged.",
      });
      // The promoted candidate's assessments now describe the new checkpoint.
      for (const a of assessments) {
        const g = this.repo.get<LoopGoal>(loopKinds.goal, a.goalId);
        if (
          !g ||
          g.status === "cancelled_by_user" ||
          g.version !== a.goalVersion
        )
          continue;
        this.saveGoal(g, {
          status:
            a.result === "satisfied"
              ? "satisfied"
              : a.result === "blocked"
                ? "blocked"
                : g.status === "regressed"
                  ? "regressed"
                  : "in_progress",
          satisfiedAtCheckpointId:
            a.result === "satisfied" ? checkpointId : null,
          lastEvaluatedCheckpointId: checkpointId,
          lastAssessmentId: a.id,
          evidenceIds: a.evidenceIds,
          regression:
            a.result === "satisfied"
              ? null
              : g.regression
                ? { ...g.regression, checkpointId }
                : null,
        });
      }
      if (it.opportunityId) {
        const o = this.repo.get<LoopOpportunity>(
          loopKinds.opportunity,
          it.opportunityId,
        );
        if (o)
          this.store.save(loopKinds.opportunity, {
            ...o,
            state: "accepted",
            attempts: [
              ...o.attempts,
              {
                iterationId: it.id,
                outcome: "accepted",
                checkpointDigest: parent.contentDigest,
              },
            ],
            updatedAt: at,
          });
      }
      if (!code)
        for (const action of this.orchestrator.actions(goal))
          for (const artifactId of action.artifactIds) {
            const c = this.repo.get<ParticipantContribution>(
              kinds.contribution,
              artifactId,
            );
            this.store.immutable(loopKinds.artifact, {
              id: `${run.id}:artifact:${artifactId}`,
              projectId: run.projectId,
              conversationId: run.id,
              runId: run.id,
              iterationId: it.id,
              goalIds: it.goalIds,
              goalVersions: Object.fromEntries(
                it.contract!.targets.map((t) => [t.goalId, t.goalVersion]),
              ),
              summary: (
                (c?.output as { summary?: string } | null)?.summary ?? ""
              ).slice(0, 2000),
              memberId: c?.memberId ?? "",
            } satisfies LoopArtifact);
          }
      const usage = this.usageRecord(latest);
      this.store.put(loopKinds.usage, {
        ...usage,
        iterations: usage.iterations + 1,
        promoted: usage.promoted + 1,
        updatedAt: at,
      });
      const next = this.saveRun(latest, {
        acceptedCheckpointId: checkpointId,
        currentIterationId: null,
        backoffSeconds: 0,
        detail: code
          ? `Checkpoint ${parent.sequence + 1} accepted from iteration ${it.number}.`
          : `Iteration ${it.number}'s information accepted.`,
      });
      this.intent(next, it.id, next.iterationCount + 1);
      this.event(next, "checkpoint-promoted", next.detail, {
        promotionId,
        checkpointId,
        candidateId: goal.candidateId,
      });
      committed = true;
    });
    const promotion = this.repo.get<PromotionDecision>(
      loopKinds.promotion,
      promotionId,
    );
    if (!promotion) {
      if (!committed)
        this.saveIteration(it, {
          detail: "Promotion fenced: the run changed before commit.",
        });
      return;
    }
    // Recovery distinguishes "persisted, notification missing" from "not committed".
    await this.settleIteration(run.id, it.id);
  }

  private async reject(
    run: LoopRun,
    it: LoopIteration,
    failure: NonNullable<LoopIteration["failure"]>,
    trigger: string | null = null,
  ) {
    if (
      terminalIteration.has(
        this.repo.require<LoopIteration>(loopKinds.iteration, it.id).state,
      )
    )
      return;
    const head = this.checkpoint(it.parentCheckpointId);
    this.store.transaction(() => {
      const latest = this.run(run.id);
      const current = this.repo.require<LoopIteration>(
        loopKinds.iteration,
        it.id,
      );
      if (terminalIteration.has(current.state)) return;
      this.saveIteration(current, {
        state: "rejected",
        failure,
        settlementPending:
          failure.kind === "stopped" ? "cancelled" : "rejected",
        endedAt: now(),
        detail: `Rejected: ${failure.detail}`,
      });
      // The accepted checkpoint is unchanged; a goal this candidate broke is
      // still satisfied at the head, and the regression stays in history.
      for (const g of this.goals(latest))
        if (
          g.status === "regressed" &&
          g.satisfiedAtCheckpointId === latest.acceptedCheckpointId
        )
          this.saveGoal(g, { status: "satisfied" });
      if (it.opportunityId) {
        const o = this.repo.get<LoopOpportunity>(
          loopKinds.opportunity,
          it.opportunityId,
        );
        if (o)
          this.store.save(loopKinds.opportunity, {
            ...o,
            state:
              failure.kind === "transient" || failure.kind === "stopped"
                ? "proposed"
                : "rejected",
            attempts: [
              ...o.attempts,
              {
                iterationId: it.id,
                outcome: "rejected",
                checkpointDigest: head.contentDigest,
              },
            ],
            updatedAt: now(),
          });
      }
      const usage = this.usageRecord(latest);
      this.store.put(loopKinds.usage, {
        ...usage,
        iterations: usage.iterations + 1,
        rejected: usage.rejected + 1,
        updatedAt: now(),
      });
      const next = this.saveRun(latest, {
        currentIterationId: null,
        adaptationTrigger: trigger ?? latest.adaptationTrigger,
        detail: `Iteration ${it.number} rejected (${failure.kind}); the accepted checkpoint is unchanged.`,
      });
      if (failure.kind !== "stopped")
        this.intent(next, it.id, next.iterationCount + 1);
      this.event(
        next,
        "iteration-rejected",
        `${next.detail} ${failure.detail}`,
      );
    });
    await this.settleIteration(run.id, it.id);
  }

  /**
   * The steps after a promotion or rejection commits: settle the child goal
   * and finish the iteration (outcome records, token totals, reclaim). They
   * run right after the transaction, and again on a later tick if a crash
   * interrupted them; each step is idempotent.
   */
  private async settleIteration(runId: string, iterationId: string) {
    const it = this.repo.require<LoopIteration>(
      loopKinds.iteration,
      iterationId,
    );
    const result = it.settlementPending;
    if (!result) return;
    const goal = this.childGoal(it);
    if (goal && !goal.loopDisposition) {
      if (result === "promoted") {
        const promotion = this.repo.require<PromotionDecision>(
          loopKinds.promotion,
          it.promotionId!,
        );
        this.orchestrator.settleLoopGoal({
          goalId: goal.id,
          outcome: "promoted",
          promotionId: promotion.id,
          detail: `Promoted by loop policy into checkpoint ${promotion.checkpointId}. This is internal progress, not owner acceptance or publication.`,
        });
      } else {
        if (
          this.orchestrator
            .rounds(goal.id)
            .some((r) => r.members.some((m) => m.activeAttemptId))
        )
          await this.orchestrator
            .controlCommand({
              projectId: it.projectId,
              goalId: goal.id,
              action: "stop",
              commandId: `${goal.id}:reject`,
            })
            .catch(() => {});
        this.orchestrator.settleLoopGoal({
          goalId: goal.id,
          outcome: result,
          promotionId: null,
          detail: `Rejected by loop policy: ${it.failure?.detail ?? ""}`,
        });
      }
    }
    await this.finishIteration(
      this.run(runId),
      this.repo.require<LoopIteration>(loopKinds.iteration, iterationId),
      result,
    );
  }

  /**
   * Finishes the latest iteration's settlement if a crash interrupted it
   * after its promotion or rejection committed (the run has already moved
   * on, so the iteration is no longer current).
   */
  private async settleLatest(run: LoopRun) {
    if (!run.iterationCount) return;
    const latest = this.repo.get<LoopIteration>(
      loopKinds.iteration,
      `${run.id}:iteration:${run.iterationCount}`,
    );
    if (latest?.settlementPending)
      await this.settleIteration(run.id, latest.id);
  }

  /** Outcome records, usage coverage and retention after an iteration ends. */
  private async finishIteration(
    run: LoopRun,
    it: LoopIteration,
    result: LoopOutcome["iterationResult"],
  ) {
    if (it.outcomeRecordIds.length) {
      if (it.settlementPending)
        this.saveIteration(it, { settlementPending: null });
      return;
    }
    it = this.account(run, it, this.childTurns(it) + this.roundTurns(run, it));
    const outcomes = this.recordOutcomes(run, it, result);
    const attempts = this.iterationAttempts(run, it);
    const usage = this.loop.usage(run.projectId, attempts);
    const record = this.usageRecord(run);
    const total = record.tokens.totalAttempts + usage.totalAttempts;
    this.store.put(loopKinds.usage, {
      ...record,
      tokens: {
        // Unreported usage stays unknown; it is never added as zero.
        input:
          usage.input === null
            ? record.tokens.input
            : (record.tokens.input ?? 0) + usage.input,
        output:
          usage.output === null
            ? record.tokens.output
            : (record.tokens.output ?? 0) + usage.output,
        coveredAttempts: record.tokens.coveredAttempts + usage.coveredAttempts,
        totalAttempts: total,
        complete: record.tokens.complete && usage.complete,
        notes: [...new Set([...record.tokens.notes, ...usage.notes])].slice(
          0,
          20,
        ),
      },
      updatedAt: now(),
    } satisfies LoopUsage);
    this.saveIteration(it, {
      outcomeRecordIds: outcomes,
      settlementPending: null,
    });
    await this.reclaim(run, it);
  }

  private iterationAttempts(run: LoopRun, it: LoopIteration): string[] {
    const ids = new Set<string>();
    for (const r of this.scoped<LoopRound>(loopKinds.round, run).filter(
      (r) => r.iterationId === it.id,
    ))
      for (const m of r.members) for (const a of m.attemptIds) ids.add(a);
    for (const goalId of it.childExecutionGoalIds)
      if (this.repo.get<Goal>(kinds.goal, goalId))
        for (const r of this.orchestrator.rounds(goalId))
          for (const m of r.members) for (const a of m.attemptIds) ids.add(a);
    return [...ids];
  }

  /** Per-member outcomes for task-aware ranking; failed members count as evidence too. */
  private recordOutcomes(
    run: LoopRun,
    it: LoopIteration,
    result: LoopOutcome["iterationResult"],
  ): string[] {
    const ids: string[] = [];
    const topology = this.topology(it.topologyRevisionId);
    const family = `${run.mode}:${it.contract?.targets.length ? "goal" : "improvement"}`;
    const difficulty: LoopOutcome["difficulty"] =
      (it.contract?.targets.length ?? 0) > 1 ||
      (it.contract?.acceptanceConditions.length ?? 0) > 5
        ? "high"
        : goalComplexity(it.contract?.summary ?? "") === "complex"
          ? "medium"
          : "low";
    const add = (
      round: { id: string; roleId: string; members: RoundMember[] },
      fn: LoopFunction,
      contribution: (m: RoundMember) => LoopOutcome["contribution"],
      findings: number,
      cohort: string[],
    ) => {
      for (const m of round.members) {
        if (!m.attemptIds.length) continue;
        const a = this.repo.assignmentRevision(
          m.assignmentId,
          m.assignmentRevision,
        );
        const b = topology.roleBindings.find((x) => x.function === fn);
        const usage = this.loop.usage(run.projectId, m.attemptIds);
        const outcome: LoopOutcome = {
          id: `${it.id}:outcome:${round.id}:${m.memberId}`,
          runId: run.id,
          projectId: run.projectId,
          conversationId: run.id,
          iterationId: it.id,
          roleId: round.roleId,
          function: fn,
          bindingId: b?.id ?? null,
          bindingRevision: b?.revision ?? null,
          memberId: m.memberId,
          assignmentId: m.assignmentId,
          assignmentRevision: m.assignmentRevision,
          provider: m.provider,
          model: m.model,
          installationId: m.installationId,
          installationRevision: a?.installationRevision ?? null,
          effort: a?.effort ?? null,
          taskFamily: family,
          difficulty,
          candidateBasis: it.parentCheckpointId,
          protocolVersion: "recursive-loop-v1",
          cohort,
          contribution: contribution(m),
          iterationResult: result,
          findings,
          usageCoverage: usage.complete
            ? "complete"
            : usage.coveredAttempts
              ? "partial"
              : "unknown",
          createdAt: now(),
        };
        if (!this.store.get(loopKinds.outcome, outcome.id))
          this.store.immutable(loopKinds.outcome, outcome);
        ids.push(outcome.id);
      }
    };
    const state = (m: RoundMember): LoopOutcome["contribution"] =>
      m.state === "returned" ||
      (m.contributionIds.length && m.phase !== "initial")
        ? "valid"
        : m.state === "invalid"
          ? "invalid"
          : m.state === "failed"
            ? "failed"
            : m.state === "stale"
              ? "stale"
              : "missing";
    for (const r of this.scoped<LoopRound>(loopKinds.round, run).filter(
      (r) => r.iterationId === it.id,
    ))
      add(
        r,
        r.function,
        state,
        0,
        r.members.map((m) => m.model),
      );
    for (const goalId of it.childExecutionGoalIds) {
      if (!this.repo.get<Goal>(kinds.goal, goalId)) continue;
      for (const r of this.orchestrator.rounds(goalId)) {
        const fn: LoopFunction =
          r.kind === "coordination"
            ? "coordination"
            : r.kind === "review"
              ? "review"
              : r.kind === "information"
                ? "information"
                : r.taskKey?.startsWith("repair-integrate")
                  ? "integration"
                  : "implementation";
        const findings =
          r.kind === "review"
            ? (this.repo.get<{ findings: unknown[] }>(kinds.findings, r.id)
                ?.findings.length ?? 0)
            : 0;
        add(
          r,
          fn,
          state,
          findings,
          r.members.map((m) => m.model),
        );
      }
    }
    return ids;
  }

  /**
   * Reclaims intermediate copies once their consumers and verification
   * needs have ended. The head, pinned checkpoints and anything an active
   * check reads are retained; immutable blobs always remain.
   */
  private async reclaim(run: LoopRun, it: LoopIteration) {
    const head = this.checkpoint(run.acceptedCheckpointId!);
    const keep = new Set(
      this.scoped<LoopCheckpoint>(loopKinds.checkpoint, run)
        .filter((c) => c.pinned || c.id === head.id)
        .map((c) => c.candidateId),
    );
    const release: string[] = [];
    for (const goalId of it.childExecutionGoalIds) {
      const baseline = this.store.get<{ candidateId: string }>(
        "loop-child-baseline",
        goalId,
      );
      if (baseline) release.push(baseline.candidateId);
      const goal = this.repo.get<Goal>(kinds.goal, goalId);
      if (goal?.candidateId && it.state !== "promoted")
        release.push(goal.candidateId);
      if (goal)
        for (const b of [
          ...this.store.iterate<{
            goalId: string;
            assembledCandidateId: string | null;
          }>(kinds.dependency, { projectId: run.projectId }),
        ])
          if (b.goalId === goalId && b.assembledCandidateId)
            release.push(b.assembledCandidateId);
    }
    // The previous head, unless pinned.
    const parent = this.checkpoint(it.parentCheckpointId);
    if (it.state === "promoted" && !parent.pinned && parent.id !== head.id)
      release.push(parent.candidateId);
    const reclaimable = release.filter((id) => !keep.has(id));
    if (reclaimable.length) await this.loop.reclaim(reclaimable).catch(() => 0);
  }

  private async complete(
    run: LoopRun,
    it: LoopIteration,
    snapshot: CompletionSnapshot,
  ) {
    this.store.transaction(() => {
      const latest = this.run(run.id);
      // Every expected revision must still match at the final commit.
      if (
        latest.goalSetRevision !== snapshot.goalSetRevision ||
        latest.controlGeneration !== snapshot.controlGeneration ||
        latest.policyRevision !== snapshot.policyRevision ||
        latest.acceptedCheckpointId !== snapshot.checkpointId ||
        latest.desiredState !== "running"
      )
        return;
      this.saveIteration(it, {
        state: "no-work",
        endedAt: now(),
        detail: "Every required goal is satisfied on the accepted checkpoint.",
      });
      const next = this.saveRun(latest, {
        state: "completed",
        completedAt: now(),
        currentIterationId: null,
        waitReason: null,
        nextWakeAt: null,
        detail: `Completed: every required goal has valid evidence on checkpoint ${this.checkpoint(snapshot.checkpointId).sequence}.`,
      });
      this.cancelScheduled(next);
      this.store.remove(loopKinds.active, run.id);
      this.event(next, "run-completed", next.detail);
    });
  }

  // -------------------------------------------------------------------------
  // Loop decision rounds: the coordination team's turn at one stage, frozen
  // against exact revisions, executed through the same driver, readiness,
  // capacity and model-evidence rules as every other member turn.

  private expected(run: LoopRun, it: LoopIteration | null): LoopExpected {
    const head = this.checkpoint(run.acceptedCheckpointId!);
    return {
      runId: run.id,
      iterationId: it?.id ?? null,
      controlGeneration: run.controlGeneration,
      authorityGeneration: run.authorityGeneration,
      checkpointId: head.id,
      checkpointDigest: head.contentDigest,
      goalSetRevision: run.goalSetRevision,
      topologyRevisionId: run.topologyRevisionId!,
      policyRevision: run.policyRevision,
      overrideRevision: run.overrideRevision,
    };
  }

  private checkpointTarget(
    head: LoopCheckpoint,
  ): LoopRound["target"] & { candidateId: string } {
    return {
      kind: "checkpoint",
      id: head.id,
      contentDigest: head.contentDigest,
      candidateId: head.candidateId,
    };
  }

  private roundTarget(
    run: LoopRun,
    it: LoopIteration,
    stage: LoopDecisionStage,
  ): LoopRound["target"] & { candidateId: string } {
    const head = this.checkpoint(run.acceptedCheckpointId!);
    if (stage !== "evaluate") return this.checkpointTarget(head);
    const goal = this.childGoal(it);
    if (goal?.kind === "code" && goal.candidateId)
      return {
        kind: "candidate",
        id: goal.candidateId,
        contentDigest: this.loop.contentDigest(goal.candidateId) ?? "",
        candidateId: goal.candidateId,
      };
    return this.checkpointTarget(head);
  }

  private async decisionRound(
    run: LoopRun,
    it: LoopIteration,
    stage: LoopDecisionStage,
  ): Promise<
    | { state: "decided"; record: LoopDecisionRecord; round: LoopRound }
    | { state: "pending" }
  > {
    const topology = this.topology(run.topologyRevisionId!);
    const fn: LoopFunction =
      stage === "evaluate" ? "evaluation" : "coordination";
    const bindingRec = topology.roleBindings.find((b) => b.function === fn)!;
    const expected = this.expected(run, it);
    // A decision covers exact revisions and an exact target: a repaired
    // candidate is a new target, never covered by the old decision.
    const target = this.roundTarget(run, it, stage);
    const current = (r: LoopRound) =>
      stable(r.expected) === stable(expected) &&
      r.target.id === target.id &&
      r.target.contentDigest === target.contentDigest;
    const rounds = this.scoped<LoopRound>(loopKinds.round, run)
      .filter((r) => r.iterationId === it.id && r.stage === stage)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const decided = rounds
      .filter((r) => r.state === "decided" && current(r) && r.decisionId)
      .at(-1);
    if (decided)
      return {
        state: "decided",
        record: this.repo.require<LoopDecisionRecord>(
          loopKinds.decision,
          decided.decisionId!,
        ),
        round: decided,
      };
    let round = rounds.find(
      (r) => r.state === "collecting" || r.state === "endorsing",
    );
    if (round && !current(round)) {
      // Obsolete: kept as history, never applied.
      const attempts = round.members
        .map((m) => m.activeAttemptId)
        .filter((a): a is string => !!a);
      this.saveRound(round, {
        state: "stale",
        detail:
          "The run's revisions changed after this round froze; its proposals are history and cannot commit.",
      });
      for (const a of attempts) await this.driver.interrupt(a).catch(() => {});
      round = undefined;
    }
    if (!round) {
      const blocked = rounds.filter((r) => r.state === "blocked" && current(r));
      if (blocked.length) {
        // The failed team does not approve its own recovery.
        const failedHere = rounds.filter((r) => r.state === "blocked");
        if (this.recoverCoordinators(run, it, failedHere, bindingRec.roleId))
          return { state: "pending" };
        if (blocked.length >= 2) {
          await this.wait(
            run,
            {
              kind: "route",
              detail: `The ${bindingRec.roleId} team did not return valid ${stage} decisions: ${blocked.at(-1)!.detail}`,
            },
            null,
          );
          return { state: "pending" };
        }
      }
      const frozen = this.freezeRound(
        run,
        it,
        stage,
        bindingRec,
        topology,
        expected,
      );
      if ("blocked" in frozen) {
        if (!frozen.pinned)
          this.saveRun(run, { adaptationTrigger: "unavailable-route" });
        await this.wait(
          this.run(run.id),
          {
            kind: frozen.pinned ? "pinned-model" : "route",
            detail: frozen.blocked,
          },
          null,
        );
        return { state: "pending" };
      }
      round = frozen;
    }
    round = this.collectRound(run, round);
    if (!this.roundDone(round)) {
      await this.launchRound(run, it, round);
      return { state: "pending" };
    }
    return this.finishRound(run, it, round);
  }

  private freezeRound(
    run: LoopRun,
    it: LoopIteration,
    stage: LoopDecisionStage,
    bindingRec: ActiveRolePurposeBinding,
    topology: TeamTopologyRevision,
    expected: LoopExpected,
  ): LoopRound | { blocked: string; pinned: boolean } {
    const binding = this.loopBinding(run, topology, it);
    const resolved = this.orchestrator.resolve(
      run.projectId,
      null,
      bindingRec.roleId,
      null,
      { binding, scopeId: `loop:${run.id}` },
    );
    const group = resolved.group;
    const required = new Map(
      group.members.map((m) => [m.memberId, m.required]),
    );
    const missing = resolved.assignments.filter(
      (a) => (required.get(a.memberId) ?? true) && a.status !== "resolved",
    );
    if (resolved.conflicts.length || missing.length)
      return {
        blocked: `The ${bindingRec.roleId} team cannot start: ${[...resolved.conflicts, ...missing.map((a) => `${a.memberId}: ${a.reason}`)].join(" ")}`,
        pinned: missing.some((a) => a.selection !== "auto"),
      };
    const usable = resolved.assignments.filter((a) => a.status === "resolved");
    const { conflicts, ...frozen } = freezePolicy(
      group.completion,
      usable.map((a) => ({
        memberId: a.memberId,
        required: required.get(a.memberId) ?? true,
      })),
    );
    if (conflicts.length)
      return { blocked: conflicts.join(" "), pinned: false };
    const target = this.roundTarget(run, it, stage);
    const role = this.repo.role(run.projectId, bindingRec.roleId);
    const context = this.promptContext(
      run,
      it,
      stage,
      target,
      binding,
      topology,
      role,
    );
    const inputDigest = loopInputDigest({ stage, expected, target, context });
    const seq =
      this.scoped<LoopRound>(loopKinds.round, run).filter(
        (r) => r.iterationId === it.id && r.stage === stage,
      ).length + 1;
    const at = now();
    const round: LoopRound = {
      id: `${it.id}:${stage}:${seq}`,
      runId: run.id,
      projectId: run.projectId,
      conversationId: run.id,
      iterationId: it.id,
      stage,
      protocolKind: "recursive-loop-v1",
      roleId: bindingRec.roleId,
      bindingId: bindingRec.id,
      function: bindingRec.function,
      revision: 1,
      members: usable.map((a) => ({
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
      })),
      requiredContributorIds: frozen.requiredContributorIds,
      electorateIds: frozen.electorateIds,
      threshold: frozen.threshold,
      requiredEndorserIds: frozen.requiredEndorserIds,
      retriesPerMember: group.completion.retriesPerMember,
      executionWidth: group.executionWidth,
      expected,
      target: {
        kind: target.kind,
        id: target.id,
        contentDigest: target.contentDigest,
      },
      inputDigest,
      contextCandidateId: target.candidateId,
      candidateDecisionDigest: null,
      state: "collecting",
      decisionId: null,
      detail: `${usable.length} ${usable.length === 1 ? "coordinator" : "coordinators"} queued for ${stage}.`,
      createdAt: at,
      updatedAt: at,
    };
    this.store.transaction(() => {
      this.repo.saveRevisioned(loopKinds.round, round);
      // The exact context every member sees, frozen with the round.
      this.store.put("loop-round-context", {
        id: round.id,
        projectId: run.projectId,
        context,
        instructions: role.instructions,
      });
    });
    return round;
  }

  private roundDone(round: LoopRound) {
    return !round.members.some(
      (m) => m.state === "queued" || m.state === "running" || m.activeAttemptId,
    );
  }

  private async launchRound(run: LoopRun, it: LoopIteration, round: LoopRound) {
    const phase = round.members.find((m) => m.state === "queued")?.phase;
    if (!phase) return;
    const policy = this.policy(run.id);
    const capacity = this.driver.capacity();
    const held = capacity.held.reduce((n, h) => n + h.weight, 0);
    if (
      !round.members.some((m) => m.state === "running") &&
      capacity.total > policy.scheduling.reserveForDirectWork &&
      capacity.total - held <= policy.scheduling.reserveForDirectWork
    ) {
      this.softWait(run, {
        kind: "capacity",
        detail: `Keeping ${policy.scheduling.reserveForDirectWork} execution slots for direct work.`,
      });
      return;
    }
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
    const decision = admit(
      {
        scheduling: "capacity-waves",
        executionWidth: round.executionWidth,
        members: round.members,
      },
      phase,
      weights,
      capacity,
    );
    if (decision.conflict) {
      this.saveRound(round, { state: "blocked", detail: decision.conflict });
      return;
    }
    if (!decision.admit.length) return;
    const stored = this.store.get<{
      context: Omit<
        LoopPromptContext,
        "memberId" | "instructions" | "idempotencyKey"
      >;
      instructions: string;
    }>("loop-round-context", round.id)!;
    const wave = Math.max(0, ...round.members.map((m) => m.wave)) + 1;
    const launches = new Map(decision.admit.map((id) => [id, uid()]));
    round = this.saveRound(round, {
      members: round.members.map((m) =>
        launches.has(m.memberId)
          ? { ...m, launchId: launches.get(m.memberId)!, wave }
          : m,
      ),
    });
    for (const memberId of decision.admit) {
      const fresh = this.repo.require<LoopRound>(loopKinds.round, round.id);
      const member = fresh.members.find((m) => m.memberId === memberId)!;
      const assignment = this.repo.require<ResolvedMemberAssignment>(
        kinds.assignment,
        member.assignmentId,
      );
      if (assignment.revision !== member.assignmentRevision) {
        this.saveRound(fresh, {
          state: "stale",
          detail: `${memberId}'s assignment changed after the round froze.`,
        });
        return;
      }
      const endorsement = member.phase === "endorsement";
      const team = endorsement
        ? this.store.get<{ operations: unknown[]; reason: string }>(
            "loop-team-candidate",
            round.id,
          )
        : undefined;
      const prompt = endorsement
        ? loopEndorsementPrompt({
            memberId,
            candidateDigest: fresh.candidateDecisionDigest!,
            summary: team?.reason ?? "",
            operations: team?.operations ?? [],
          })
        : loopPrompt({
            ...stored.context,
            inputDigest: fresh.inputDigest,
            memberId,
            instructions: stored.instructions,
            idempotencyKey: `${round.id}:${memberId}`,
          } as LoopPromptContext);
      const turn: MemberTurn = {
        launchId: member.launchId!,
        projectId: run.projectId,
        goalId: it.childExecutionGoalIds.at(-1) ?? run.id,
        roundId: round.id,
        roleId: round.roleId,
        memberId,
        assignment,
        purpose: endorsement
          ? "coordinator-endorsement"
          : "coordinator-contribution",
        phase: member.phase,
        prompt,
        inputDigest: round.inputDigest,
        candidateId: null,
        permittedOutputs: [],
        retryOfAttemptId: member.attemptIds.at(-1) ?? null,
        // Loop assessments use the read-only coordinator route; the protocol
        // selects the stage's output contract.
        protocol: endorsement
          ? { kind: "coordinator-v1", stage: null, mode: null }
          : { kind: "recursive-loop-v1", stage: round.stage, mode: run.mode },
        contextCandidateId: round.contextCandidateId,
      };
      try {
        const { attemptId } = await this.driver.launch(turn);
        const latest = this.repo.require<LoopRound>(loopKinds.round, round.id);
        this.saveRound(latest, {
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
      } catch (error) {
        // A launch that recorded an attempt is adopted, never dispatched twice.
        const recorded = this.driver.findLaunch(member.launchId!);
        const latest = this.repo.require<LoopRound>(loopKinds.round, round.id);
        this.saveRound(latest, {
          members: latest.members.map((m) =>
            m.memberId !== memberId
              ? m
              : recorded
                ? {
                    ...m,
                    state: "running",
                    activeAttemptId: recorded,
                    attemptIds: [...new Set([...m.attemptIds, recorded])],
                    detail: safeError(error),
                  }
                : m.retries < latest.retriesPerMember
                  ? {
                      ...m,
                      launchId: null,
                      state: "queued",
                      retries: m.retries + 1,
                      detail: `${memberId} did not start: ${safeError(error)}`,
                    }
                  : {
                      ...m,
                      launchId: null,
                      state: "failed",
                      detail: `${memberId} did not start: ${safeError(error)}`,
                    },
          ),
        });
      }
    }
  }

  private collectRound(run: LoopRun, round: LoopRound): LoopRound {
    let changed = false;
    const members = round.members.map((m) => ({ ...m }));
    for (const m of members) {
      if (!m.activeAttemptId && m.launchId) {
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
      if (obs.state === "uncertain" || !obs.quiescent) continue;
      const attemptId = m.activeAttemptId;
      m.activeAttemptId = null;
      m.launchId = null;
      changed = true;
      const contribution = this.contribute(run, round, m, attemptId, obs);
      m.contributionIds = [...m.contributionIds, contribution.id];
      if (contribution.validation.state === "valid") {
        m.state = "returned";
        m.detail = "";
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
    return changed ? this.saveRound(round, { members }) : round;
  }

  private contribute(
    run: LoopRun,
    round: LoopRound,
    m: RoundMember,
    attemptId: string,
    obs: AttemptObservation,
  ): LoopContribution {
    const assignment =
      this.repo.assignmentRevision(m.assignmentId, m.assignmentRevision) ??
      this.repo.require<ResolvedMemberAssignment>(
        kinds.assignment,
        m.assignmentId,
      );
    const evidence = modelEvidence(assignment, {
      model: obs.reportedModel,
      effort: obs.reportedEffort,
    });
    let output: unknown = null;
    let validation: LoopContribution["validation"];
    if (obs.state !== "completed")
      validation = {
        state: "failed",
        reason: obs.error ?? `The attempt ended ${obs.state}.`,
      };
    else if (!evidence.satisfies)
      validation = { state: "invalid", reason: evidence.detail };
    else if (m.phase === "endorsement") {
      const parsed = parseFinal(endorsementSchema, obs.finalText);
      if (!parsed.ok) validation = { state: "invalid", reason: parsed.reason };
      else if (parsed.value.candidateDigest !== round.candidateDecisionDigest)
        validation = {
          state: "invalid",
          reason:
            "The response names a different decision digest; it endorses nothing.",
        };
      else {
        output = parsed.value;
        validation = { state: "valid", reason: evidence.detail };
      }
    } else {
      const parsed = parseEnvelope(
        obs.finalText,
        round.stage,
        run.mode,
        round.expected,
        round.inputDigest,
      );
      if (!parsed.ok)
        validation = {
          state: parsed.stale ? "stale" : "invalid",
          reason: parsed.reason,
        };
      else {
        output = parsed.value;
        validation = { state: "valid", reason: evidence.detail };
      }
    }
    const contribution: LoopContribution = {
      id: `${round.id}:${attemptId}`,
      projectId: run.projectId,
      conversationId: run.id,
      runId: run.id,
      roundId: round.id,
      memberId: m.memberId,
      assignmentId: m.assignmentId,
      assignmentRevision: m.assignmentRevision,
      attemptId,
      phase: m.phase,
      protocol: {
        kind: "recursive-loop-v1",
        stage: round.stage,
        schemaVersion: 1,
      },
      output,
      validation,
      inputDigest: round.inputDigest,
      reportedModel: obs.reportedModel,
      createdAt: now(),
    };
    this.store.immutable(loopKinds.contribution, contribution);
    return contribution;
  }

  private latestValid(round: LoopRound, phase: RoundMember["phase"]) {
    const out: LoopContribution[] = [];
    for (const m of round.members) {
      const c = [...m.contributionIds]
        .reverse()
        .map((id) =>
          this.repo.get<LoopContribution>(loopKinds.contribution, id),
        )
        .find(
          (c) =>
            c &&
            c.phase === phase &&
            c.validation.state === "valid" &&
            c.assignmentRevision === m.assignmentRevision &&
            c.inputDigest === round.inputDigest,
        );
      if (c) out.push(c);
    }
    return out;
  }

  private async finishRound(
    run: LoopRun,
    it: LoopIteration,
    round: LoopRound,
  ): Promise<
    | { state: "decided"; record: LoopDecisionRecord; round: LoopRound }
    | { state: "pending" }
  > {
    const initial = this.latestValid(round, "initial");
    const returned = new Set(initial.map((c) => c.memberId));
    const missing = round.requiredContributorIds.filter(
      (id) => !returned.has(id),
    );
    if (missing.length || !initial.length) {
      // A quorum never waives a required contribution.
      this.saveRound(round, {
        state: "blocked",
        detail: `Required decisions are missing from ${missing.join(", ") || "every member"}: ${round.members
          .filter((m) => missing.includes(m.memberId))
          .map((m) => m.detail)
          .filter(Boolean)
          .join(" ")}`,
      });
      this.saveRun(run, { adaptationTrigger: "invalid-output" });
      return { state: "pending" };
    }
    const decisions = initial.flatMap((c) =>
      (c.output as { decisions: LoopDecision[] }).decisions.map((decision) => ({
        memberId: c.memberId,
        contributionId: c.id,
        decision,
      })),
    );
    let team: LoopDecisionRecord["team"] = null;
    const dissent: LoopDecisionRecord["dissent"] = [];
    if (round.stage === "organize") {
      const proposals = decisions.filter(
        (d) => (d.decision as LoopDecision).kind === "reconfigure_team",
      ) as Array<{
        memberId: string;
        contributionId: string;
        decision: Extract<LoopDecision, { kind: "reconfigure_team" }>;
      }>;
      if (proposals.length) {
        const groups = new Map<string, typeof proposals>();
        for (const p of proposals) {
          const key = operationsDigest(p.decision.operations);
          groups.set(key, [...(groups.get(key) ?? []), p]);
        }
        const [digest, lead] = [...groups].sort(
          (a, b) =>
            b[1].length - a[1].length ||
            round.members.findIndex((m) => m.memberId === a[1][0].memberId) -
              round.members.findIndex((m) => m.memberId === b[1][0].memberId),
        )[0];
        const implied = lead
          .map((p) => p.memberId)
          .filter((id) => round.electorateIds.includes(id));
        const candidateDigest = hash(
          stable({ round: round.id, operations: digest }),
        );
        const endorsements = this.latestValid(round, "endorsement").map(
          (c) => ({
            memberId: c.memberId,
            ...(c.output as {
              stance: DecisionEndorsement["stance"];
              rationale: string;
            }),
          }),
        );
        const endorsed = [
          ...new Set([
            ...implied,
            ...endorsements
              .filter((e) => e.stance === "endorse")
              .map((e) => e.memberId),
          ]),
        ];
        const passes =
          endorsed.length >= round.threshold &&
          round.requiredEndorserIds.every((id) => endorsed.includes(id));
        const pendingEndorsers = round.electorateIds.filter(
          (id) =>
            !implied.includes(id) &&
            !round.members.find(
              (m) => m.memberId === id && m.phase === "endorsement",
            ),
        );
        if (
          !passes &&
          pendingEndorsers.length &&
          round.state === "collecting"
        ) {
          // Members whose proposal differs endorse or challenge the leading one.
          this.store.put("loop-team-candidate", {
            id: round.id,
            projectId: run.projectId,
            operations: lead[0].decision.operations,
            reason: lead[0].decision.reason,
            digest: candidateDigest,
          });
          this.saveRound(round, {
            state: "endorsing",
            candidateDecisionDigest: candidateDigest,
            members: round.members.map((m) =>
              pendingEndorsers.includes(m.memberId)
                ? {
                    ...m,
                    phase: "endorsement",
                    state: "queued",
                    retries: 0,
                    detail: "",
                  }
                : m,
            ),
            detail: `Asking ${pendingEndorsers.length} coordinators to endorse the leading organization change.`,
          });
          return { state: "pending" };
        }
        for (const e of endorsements)
          if (e.stance !== "endorse")
            dissent.push({ memberId: e.memberId, rationale: e.rationale });
        for (const p of proposals)
          if (!lead.includes(p) && !endorsed.includes(p.memberId))
            dissent.push({
              memberId: p.memberId,
              rationale: p.decision.reason,
            });
        team = {
          operations: lead[0].decision.operations,
          reason: lead[0].decision.reason,
          expectedBenefit: lead[0].decision.expectedBenefit,
          evidenceIds: lead[0].decision.evidenceIds,
          trigger: lead[0].decision.trigger,
          endorsedBy: endorsed,
          passed: passes,
        };
      }
    }
    const record: LoopDecisionRecord = {
      id: `${round.id}:decision`,
      runId: run.id,
      projectId: run.projectId,
      conversationId: run.id,
      iterationId: it.id,
      roundId: round.id,
      stage: round.stage,
      contributionIds: initial.map((c) => c.id),
      decisions,
      team,
      dissent,
      createdAt: now(),
    };
    let saved!: LoopRound;
    this.store.transaction(() => {
      this.store.immutable(loopKinds.decision, record);
      saved = this.saveRound(round, {
        state: "decided",
        decisionId: record.id,
        detail: `${initial.length} valid ${initial.length === 1 ? "decision" : "decisions"} recorded.`,
      });
    });
    return { state: "decided", record, round: saved };
  }

  /**
   * When an unpinned coordination team fails to return valid decisions, the
   * supervisor chooses a replacement from the remaining eligible models. An
   * exact pin waits or uses only its authorized fallback.
   */
  private recoverCoordinators(
    run: LoopRun,
    it: LoopIteration,
    blockedRounds: LoopRound[],
    roleId: string,
  ): boolean {
    const topology = this.topology(run.topologyRevisionId!);
    const binding = this.loopBinding(run, topology, it);
    const locks = this.locks(run, roleId, binding);
    if (locks.exact || locks.pinned || locks.fields.has("members"))
      return false;
    // Bounded: failures accumulate across this iteration's attempts, and
    // recovery is tried at most twice before the run waits visibly.
    const recoveries = this.scoped<AdaptationDecision>(
      loopKinds.adaptation,
      run,
    ).filter(
      (a) => a.kind === "recovery" && a.boundaryIteration === it.number,
    ).length;
    if (recoveries >= 2) return false;
    const blocked = blockedRounds.at(-1)!;
    const failed = new Set(
      blockedRounds.flatMap((r) =>
        r.members
          .filter((m) => m.state === "invalid" || m.state === "failed")
          .map((m) => m.model),
      ),
    );
    if (!failed.size) return false;
    const pool = (binding.ranking[roleId] ?? []).filter((m) => !failed.has(m));
    if (!pool.length) return false;
    const role = topology.roles.find((r) => r.roleId === roleId)!;
    const count = Math.max(1, role.adaptive.count ?? blocked.members.length);
    const models = Array.from(
      { length: Math.min(count, pool.length) },
      (_, i) => pool[i],
    );
    const roles = topology.roles.map((r) =>
      r.roleId === roleId
        ? {
            ...r,
            adaptive: { ...r.adaptive, models, count: models.length },
            origin: "supervisor" as const,
            reason: `Recovery: ${[...failed].join(", ")} did not return valid decisions.`,
          }
        : r,
    );
    const next: TeamTopologyRevision = {
      ...topology,
      id: `${run.id}:topology:${topology.revision + 1}`,
      revision: topology.revision + 1,
      roles,
      resolvedAssignmentRevisions: [],
      proposedByRoundId: null,
      decisionDigest: topologyDigest({
        roles,
        roleBindings: topology.roleBindings,
      }),
      previousRevisionId: topology.id,
      reason: `Recovery replaced the ${roleId} team's failed members with eligible models (${models.join(", ")}).`,
      change: "trigger",
      authorityGeneration: run.authorityGeneration + 1,
      effectiveFromIteration: it.number,
      createdAt: now(),
    };
    this.commitTopology(run, next, {
      kind: "recovery",
      roundId: blocked.id,
      operations: [],
      reason: next.reason,
      expectedBenefit: "Valid decisions from a working team.",
      trigger: "invalid-output",
      boundaryIteration: it.number,
      actor: LOOP_ACTOR,
      dissent: [],
    });
    this.saveIteration(it, { topologyRevisionId: next.id });
    return true;
  }

  // -------------------------------------------------------------------------
  // Assessment and evidence. The coordinators evaluate; the service checks
  // that cited evidence exists, belongs to the current goal and criterion
  // versions and covers the exact target. Agreement never replaces evidence.

  private contractGoal(it: LoopIteration) {
    const c = it.contract!;
    return {
      id: `${it.id}:contract`,
      version: 1,
      text: c.summary,
      required: true,
      priority: 0,
      status: "in_progress" as const,
      blocker: null,
      satisfiedAtCheckpointId: null,
      criteria: c.acceptanceConditions.map((text, i) => ({
        id: `${it.id}:contract:c${i + 1}`,
        text,
        verification: { kind: "inspection" as const },
        required: true,
        provenance: "coordinator" as const,
      })),
    };
  }

  private assessable(run: LoopRun, it: LoopIteration): Assessable[] {
    // Endless: the iteration's improvement contract, once it has one.
    if (run.mode === "endless")
      return it.contract ? [this.contractGoal(it)] : [];
    return this.goals(run).filter((g) => g.status !== "cancelled_by_user");
  }

  private evidenceFor(
    run: LoopRun,
    target: LoopRound["target"] & { candidateId: string },
    goal: Goal | null,
  ): EvidenceItem[] {
    const items: EvidenceItem[] = [];
    if (target.kind === "candidate" && goal) {
      for (const r of this.orchestrator.checkStatus(goal).results)
        if (r.verificationId)
          items.push({
            id: r.verificationId,
            kind: "check",
            checkId: r.definitionId,
            result: r.result ?? "",
            detail: `${r.label}: ${r.result}`,
          });
      const completion = goal.reviewCompletionId
        ? this.repo.get<RoleCompletion>(
            kinds.completion,
            goal.reviewCompletionId,
          )
        : undefined;
      if (completion && completion.candidateId === target.candidateId)
        items.push({
          id: completion.id,
          kind: "review",
          result: completion.result,
          detail: `Required review ${completion.result}: ${completion.policy.detail}`,
        });
    }
    if (target.kind === "checkpoint") {
      const head = this.checkpoint(target.id);
      if (head.promotionId) {
        const p = this.repo.get<PromotionDecision>(
          loopKinds.promotion,
          head.promotionId,
        );
        for (const e of p?.checkEvidence ?? [])
          items.push({
            id: e.verificationId,
            kind: "check",
            checkId: e.definitionId,
            result: "passed",
            detail: `${e.definitionId}: passed on this content`,
          });
        if (p?.reviewCompletionId)
          items.push({
            id: p.reviewCompletionId,
            kind: "review",
            result: "satisfied",
            detail: "The required review covered this content.",
          });
      }
      for (const e of this.checkpointEvidence(run, head))
        items.push({
          id: e.verificationId,
          kind: "check",
          checkId: e.definitionId,
          result: e.result,
          detail: `${e.definitionId}: ${e.result} on this checkpoint`,
        });
    }
    if (goal)
      for (const action of this.orchestrator.actions(goal))
        for (const id of action.artifactIds) {
          const c = this.repo.get<ParticipantContribution>(
            kinds.contribution,
            id,
          );
          const o = c?.output as { summary?: string; report?: string } | null;
          if (o?.report)
            items.push({
              id,
              kind: "artifact",
              result: "returned",
              detail: `${c!.memberId}: ${(o.summary ?? "").slice(0, 300)}`,
            });
        }
    for (const a of this.scoped<LoopArtifact>(loopKinds.artifact, run))
      items.push({
        id: a.id,
        kind: "artifact",
        result: "accepted",
        detail: a.summary.slice(0, 300),
        goalVersions: a.goalVersions,
      });
    return items;
  }

  private recordAssessments(
    run: LoopRun,
    it: LoopIteration,
    record: LoopDecisionRecord,
    target: LoopRound["target"] & { candidateId: string },
    goals: Assessable[],
    childGoal: Goal | null,
  ): string[] {
    const evidence = this.evidenceFor(run, target, childGoal);
    const head = this.checkpoint(run.acceptedCheckpointId!);
    const protocol = it.verificationProtocolRevision;
    const claims = record.decisions.filter(
      (d) => (d.decision as LoopDecision).kind === "assess_goals",
    ) as Array<{
      memberId: string;
      decision: Extract<LoopDecision, { kind: "assess_goals" }>;
    }>;
    const ids: string[] = [];
    for (const g of goals) {
      const mine = claims.flatMap((c) =>
        c.decision.assessments
          .filter((a) => a.goalId === g.id && a.goalVersion === g.version)
          .map((a) => ({ memberId: c.memberId, a })),
      );
      const criteria: CriterionAssessment[] = g.criteria.map((k) => {
        const per = mine
          .map(({ memberId, a }) => ({
            memberId,
            c: a.criteria.find((x) => x.criterionId === k.id),
          }))
          .filter((x) => x.c);
        // Conservative: met only when every assessing member says met.
        const claimed =
          per.length && per.every((x) => x.c!.result === "met")
            ? "met"
            : per.some((x) => x.c!.result === "unmet")
              ? "unmet"
              : "unknown";
        const cited = [...new Set(per.flatMap((x) => x.c!.evidenceIds))];
        const paths = [...new Set(per.flatMap((x) => x.c!.citedPaths))];
        const v = this.validateCriterion(k, cited, paths, evidence, target, g);
        const result =
          claimed === "met" && v.validation === "valid" && v.passing
            ? "met"
            : claimed === "unknown" && v.validation !== "valid"
              ? "unknown"
              : "unmet";
        return {
          criterionId: k.id,
          result,
          evidenceIds: v.evidenceIds,
          validation:
            claimed === "met"
              ? v.validation
              : v.validation === "valid"
                ? "valid"
                : "not-applicable",
          note:
            claimed === "met" && v.validation !== "valid"
              ? `Claimed met, but ${v.validation === "missing-evidence" ? "the required evidence is missing" : "the evidence does not cover this target"}.`
              : per
                  .map((x) => x.c!.note)
                  .filter(Boolean)
                  .join(" / ")
                  .slice(0, 2000),
          dissent: per
            .filter((x) => x.c!.result !== claimed)
            .map((x) => ({
              memberId: x.memberId,
              result: x.c!.result,
              note: x.c!.note,
            })),
        };
      });
      const required = criteria.filter(
        (c) =>
          g.criteria.find((k) => k.id === c.criterionId)?.required !== false,
      );
      const blocker = mine.map((x) => x.a.blocker).find(Boolean) ?? null;
      const satisfied =
        g.criteria.length > 0 && required.every((c) => c.result === "met");
      const result: GoalAssessment["result"] = satisfied
        ? "satisfied"
        : blocker
          ? "blocked"
          : "unmet";
      const assessment: GoalAssessment = {
        id: `${record.id}:${g.id}`,
        runId: run.id,
        projectId: run.projectId,
        conversationId: run.id,
        goalId: g.id,
        goalVersion: g.version,
        target:
          target.kind === "candidate"
            ? {
                kind: "candidate",
                candidateId: target.candidateId,
                contentDigest: target.contentDigest,
                parentCheckpointId: head.id,
              }
            : {
                kind: "checkpoint",
                checkpointId: target.id,
                contentDigest: target.contentDigest,
              },
        protocolRevision: protocol,
        criteria,
        result,
        evidenceIds: [...new Set(criteria.flatMap((c) => c.evidenceIds))],
        evaluatorRoundId: record.roundId,
        goalSetRevision: run.goalSetRevision,
        detail: !g.criteria.length
          ? "This goal has no acceptance criteria yet."
          : !mine.length
            ? "No coordinator assessed this goal version."
            : (blocker ??
              `${criteria.filter((c) => c.result === "met").length} of ${criteria.length} criteria met with valid evidence.`),
        createdAt: now(),
      };
      this.store.immutable(loopKinds.assessment, assessment);
      ids.push(assessment.id);
      const conflicts = [...new Set(mine.flatMap((x) => x.a.conflictsWith))];
      if (conflicts.length && run.mode === "goal") {
        const goal = this.repo.get<LoopGoal>(loopKinds.goal, g.id);
        if (goal)
          this.saveGoal(goal, {
            conflict: `Conflicts with ${conflicts.join(", ")}; both requirements are kept.`,
          });
      }
    }
    this.event(
      run,
      "goal-assessed",
      `${ids.length} ${ids.length === 1 ? "assessment" : "assessments"} recorded on ${target.kind} ${target.id}.`,
    );
    return ids;
  }

  private validateCriterion(
    k: LoopCriterion,
    cited: string[],
    paths: string[],
    evidence: EvidenceItem[],
    target: LoopRound["target"] & { candidateId: string },
    g: Assessable,
  ): {
    validation: CriterionAssessment["validation"];
    evidenceIds: string[];
    passing: boolean;
  } {
    switch (k.verification.kind) {
      case "check": {
        const checkId = k.verification.checkId;
        const e = evidence
          .filter((x) => x.kind === "check" && x.checkId === checkId)
          .at(-1);
        if (!e)
          return {
            validation: "missing-evidence",
            evidenceIds: [],
            passing: false,
          };
        return {
          validation: "valid",
          evidenceIds: [e.id],
          passing: e.result === "passed",
        };
      }
      case "review": {
        const e = evidence.find(
          (x) => x.kind === "review" && x.result === "satisfied",
        );
        return e
          ? { validation: "valid", evidenceIds: [e.id], passing: true }
          : { validation: "missing-evidence", evidenceIds: [], passing: false };
      }
      case "artifact": {
        const ok = cited.filter((id) =>
          evidence.some(
            (x) =>
              x.kind === "artifact" &&
              x.id === id &&
              (!x.goalVersions || x.goalVersions[g.id] === g.version),
          ),
        );
        return ok.length
          ? { validation: "valid", evidenceIds: ok, passing: true }
          : { validation: "missing-evidence", evidenceIds: [], passing: false };
      }
      case "inspection": {
        const known = cited.filter((id) => evidence.some((x) => x.id === id));
        const existing = paths.filter((p) =>
          this.loop.candidateHasPath(target.candidateId, p),
        );
        if (paths.length && existing.length !== paths.length)
          return {
            validation: "stale-evidence",
            evidenceIds: known,
            passing: false,
          };
        return existing.length || known.length
          ? {
              validation: "valid",
              evidenceIds: [...known, ...existing.map((p) => `file:${p}`)],
              passing: true,
            }
          : { validation: "missing-evidence", evidenceIds: [], passing: false };
      }
    }
  }

  private currentAssessment(
    run: LoopRun,
    g: LoopGoal,
    head: LoopCheckpoint,
  ): GoalAssessment | null {
    if (!g.lastAssessmentId) return null;
    const a = this.repo.get<GoalAssessment>(
      loopKinds.assessment,
      g.lastAssessmentId,
    );
    if (!a || a.goalVersion !== g.version) return null;
    const onHead =
      (a.target.kind === "checkpoint" && a.target.checkpointId === head.id) ||
      (a.target.kind === "candidate" &&
        a.target.candidateId === head.candidateId &&
        a.target.contentDigest === head.contentDigest);
    if (!onHead) return null;
    if (
      a.protocolRevision !==
      this.loop.protocolRevision(run.id, this.policy(run.id).checks)
    )
      return null;
    return a;
  }

  /** Statuses from a boundary assessment of the accepted checkpoint. */
  private applyCheckpointAssessments(
    run: LoopRun,
    head: LoopCheckpoint,
    ids: string[],
  ) {
    this.store.transaction(() => {
      for (const id of ids) {
        const a = this.repo.require<GoalAssessment>(loopKinds.assessment, id);
        const g = this.repo.get<LoopGoal>(loopKinds.goal, a.goalId);
        if (
          !g ||
          g.version !== a.goalVersion ||
          g.status === "cancelled_by_user"
        )
          continue;
        const wasSatisfied =
          g.status === "satisfied" && g.satisfiedAtCheckpointId === head.id;
        this.saveGoal(g, {
          status:
            a.result === "satisfied"
              ? "satisfied"
              : wasSatisfied
                ? "regressed"
                : a.result === "blocked"
                  ? "blocked"
                  : "in_progress",
          blocker: a.result === "blocked" ? a.detail : g.blocker,
          satisfiedAtCheckpointId:
            a.result === "satisfied" ? head.id : g.satisfiedAtCheckpointId,
          lastEvaluatedCheckpointId: head.id,
          lastAssessmentId: a.id,
          evidenceIds: a.evidenceIds,
        });
      }
    });
  }

  /**
   * The aggregate completion predicate: every current required goal is
   * satisfied with valid evidence on the same accepted checkpoint, the
   * required checks are current for that content, and nothing in flight can
   * change the result.
   */
  completion(run: LoopRun): {
    complete: boolean;
    missing: string[];
    snapshot: CompletionSnapshot;
  } {
    const snapshot: CompletionSnapshot = {
      goalSetRevision: run.goalSetRevision,
      controlGeneration: run.controlGeneration,
      policyRevision: run.policyRevision,
      checkpointId: run.acceptedCheckpointId!,
    };
    if (run.mode !== "goal")
      return {
        complete: false,
        missing: ["Endless runs never complete."],
        snapshot,
      };
    const head = this.checkpoint(run.acceptedCheckpointId!);
    const policy = this.policy(run.id);
    const missing: string[] = [];
    const goals = this.goals(run).filter(
      (g) => g.status !== "cancelled_by_user",
    );
    const required = goals.filter((g) => g.required);
    if (!required.length) missing.push("no required goal remains");
    for (const g of required) {
      const a = this.currentAssessment(run, g, head);
      if (!a)
        missing.push(
          `"${g.text}" has no current assessment on the accepted checkpoint`,
        );
      else if (a.result !== "satisfied")
        missing.push(`"${g.text}" is ${a.result}`);
      else if (
        a.criteria.some(
          (c) =>
            c.result !== "met" ||
            (c.validation !== "valid" && c.validation !== "not-applicable"),
        )
      )
        missing.push(`"${g.text}" lacks valid evidence for every criterion`);
    }
    if (policy.checks.length) {
      const p = head.promotionId
        ? this.repo.get<PromotionDecision>(
            loopKinds.promotion,
            head.promotionId,
          )
        : undefined;
      const passed = new Set([
        ...(p?.checkEvidence.map((e) => e.definitionId) ?? []),
        ...this.checkpointEvidence(run, head)
          .filter((e) => e.result === "passed")
          .map((e) => e.definitionId),
      ]);
      const stale = policy.checks.filter((c) => !passed.has(c.id));
      if (stale.length)
        missing.push(
          `required checks are not current on the accepted checkpoint (${stale.map((c) => c.label).join(", ")})`,
        );
    }
    const it = run.currentIterationId
      ? this.repo.get<LoopIteration>(
          loopKinds.iteration,
          run.currentIterationId,
        )
      : undefined;
    if (it && it.state !== "assessing")
      missing.push("an iteration is still in flight");
    return { complete: !missing.length, missing, snapshot };
  }

  // -------------------------------------------------------------------------
  // Bounded prompt context

  private promptContext(
    run: LoopRun,
    it: LoopIteration,
    stage: LoopDecisionStage,
    target: LoopRound["target"] & { candidateId: string },
    binding: GoalLoopBinding,
    topology: TeamTopologyRevision,
    role: RoleDefinition,
  ): Omit<LoopPromptContext, "memberId" | "instructions" | "idempotencyKey"> {
    void role;
    const head = this.checkpoint(run.acceptedCheckpointId!);
    const base = run.publicationBaseCheckpointId
      ? this.checkpoint(run.publicationBaseCheckpointId)
      : head;
    const policy = this.policy(run.id);
    const goal = this.childGoal(it) ?? null;
    const goals = this.assessable(run, it).map((g) => ({
      id: g.id,
      version: g.version,
      text: g.text,
      required: g.required,
      priority: g.priority,
      status: g.status,
      criteria: g.criteria.map((k) => ({
        id: k.id,
        text: k.text,
        verification: describeKind(k.verification),
        provenance: k.provenance,
      })),
      blocker: g.blocker,
    }));
    const routes = this.driver
      .routes(run.projectId)
      .filter((r) => !binding.excludedProviders.includes(r.provider));
    const catalog = this.repo.roles(run.projectId);
    const assignmentsByRole = new Map<string, AssignmentRevisionRef[]>();
    for (const a of it.assignments)
      assignmentsByRole.set(a.roleId, [
        ...(assignmentsByRole.get(a.roleId) ?? []),
        a,
      ]);
    const organization = (
      stage === "organize"
        ? catalog.map((c) => c.id)
        : topology.roles.filter((r) => r.active).map((r) => r.roleId)
    ).map((roleId) => {
      const def = catalog.find((c) => c.id === roleId)!;
      const t = topology.roles.find((r) => r.roleId === roleId);
      const l = t?.active
        ? this.locks(run, roleId, binding)
        : {
            fields: new Set<string>(),
            presence: false,
            pinned: false,
            exact: false,
          };
      const group = t?.active
        ? this.orchestrator.effective(run.projectId, null, roleId, null, {
            binding,
            scopeId: `loop:${run.id}`,
          })
        : null;
      return {
        roleId,
        title: def?.title ?? roleId,
        purpose: def?.purpose ?? "unknown",
        functions: topology.roleBindings
          .filter((b) => b.roleId === roleId)
          .map((b) => b.function),
        members: (assignmentsByRole.get(roleId) ?? []).length
          ? assignmentsByRole.get(roleId)!.map((a) => ({
              memberId: a.memberId,
              model: a.model,
              pinned:
                group?.members.some(
                  (m) => m.memberId === a.memberId && m.pin,
                ) ?? false,
            }))
          : (group?.members ?? []).map((m) => ({
              memberId: m.memberId,
              model:
                m.pin?.model ?? m.pin?.label ?? m.preferences.models[0] ?? null,
              pinned: !!m.pin,
            })),
        locked: [...l.fields, ...(l.presence ? ["presence"] : [])],
        active: !!t?.active,
      };
    });
    const models = routes.flatMap((r) =>
      r.catalog.models.map((m) => ({
        model: m.model,
        name: m.name,
        provider: r.provider,
        purposes: Object.entries(r.purposes)
          .filter(([, v]) => v?.ready)
          .map(([p]) => p),
      })),
    );
    const opportunities =
      run.mode === "endless"
        ? this.scoped<LoopOpportunity>(loopKinds.opportunity, run)
        : [];
    const recent = this.iterations(run)
      .filter((i) => terminalIteration.has(i.state))
      .slice(-5);
    return {
      mode: run.mode,
      stage,
      title: run.title,
      priorities: policy.priorities,
      expected: this.expected(run, it),
      inputDigest: "",
      checkpoint: {
        id: head.id,
        sequence: head.sequence,
        changedSinceBase:
          base.id === head.id
            ? []
            : this.loop
                .changedPaths(base.candidateId, head.candidateId)
                .map((f) => `${f.change} ${f.path}`)
                .slice(0, 60),
      },
      goals,
      organization,
      models: stage === "organize" ? models : [],
      backlog: opportunities
        .filter((o) => o.state === "proposed" || o.state === "selected")
        .sort((a, b) => b.priorityScore - a.priorityScore)
        .slice(0, 10)
        .map((o) => ({
          id: o.id,
          title: o.title,
          state: o.state,
          score: o.priorityScore,
        })),
      rejected: opportunities
        .filter((o) =>
          o.attempts.some(
            (a) =>
              a.outcome === "rejected" &&
              a.checkpointDigest === head.contentDigest,
          ),
        )
        .slice(-10)
        .map((o) => ({ title: o.title, reason: "rejected at this content" })),
      evidence: this.evidenceFor(run, target, goal).map((e) => ({
        id: e.id,
        kind: e.checkId ? `check ${e.checkId}` : e.kind,
        detail: e.detail,
      })),
      lessons: recent.map(
        (i) =>
          `Iteration ${i.number} ${i.state}${i.failure ? ` (${i.failure.kind}): ${i.failure.detail}` : `: ${i.contract?.summary ?? i.detail}`}`,
      ),
      target:
        target.kind === "candidate"
          ? {
              kind: "candidate",
              id: target.id,
              changedFiles: this.loop
                .changedPaths(head.candidateId, target.candidateId)
                .map((f) => `${f.change} ${f.path}`)
                .slice(0, 200),
            }
          : stage === "evaluate"
            ? { kind: "checkpoint", id: target.id, changedFiles: [] }
            : null,
      files:
        target.kind === "candidate"
          ? this.changedFileTexts(head.candidateId, target.candidateId)
          : [],
      handoff: this.handoff(run),
    };
  }

  /** Up to ten changed files of a candidate, each bounded, for evaluation. */
  private changedFileTexts(fromCandidateId: string, toCandidateId: string) {
    if (!this.driver.fileText) return [];
    const out: Array<{ path: string; text: string }> = [];
    let total = 0;
    for (const f of this.loop.changedPaths(fromCandidateId, toCandidateId)) {
      if (f.change === "deleted" || out.length >= 10 || total > 40_000)
        continue;
      const text = this.driver.fileText(toCandidateId, f.path);
      if (text === null) continue;
      const bounded =
        text.length > 8000 ? `${text.slice(0, 8000)}\n… (truncated)` : text;
      total += bounded.length;
      out.push({ path: f.path, text: bounded });
    }
    return out;
  }

  /** The versioned handoff package an incoming coordination team receives. */
  private handoff(run: LoopRun): string | null {
    const latest = this.scoped<LoopRound>(loopKinds.round, run)
      .filter((r) => r.state === "decided")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (
      !latest ||
      latest.expected.authorityGeneration === run.authorityGeneration
    )
      return null;
    const adaptations = this.scoped<AdaptationDecision>(
      loopKinds.adaptation,
      run,
    )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5);
    const goals = this.goals(run).filter(
      (g) => g.status !== "cancelled_by_user",
    );
    return [
      `Authority generation ${run.authorityGeneration} (previous team: generation ${latest.expected.authorityGeneration}).`,
      `Accepted checkpoint: ${run.acceptedCheckpointId}.`,
      goals.length
        ? `Goals: ${goals.map((g) => `${g.id} ${g.status}`).join(", ")}.`
        : "",
      `Locked by the owner: ${
        this.overrides(run)
          .map((o) => `${o.kind}${o.roleId ? ` ${o.roleId}` : ""}`)
          .join(", ") || "nothing"
      }.`,
      `Recent organization decisions: ${adaptations.map((a) => `${a.kind}: ${a.reason}`).join(" | ")}`,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
  }

  // -------------------------------------------------------------------------
  // Views, paginated and bounded

  list(projectId: string) {
    return [...this.store.iterate<LoopRun>(loopKinds.run, { projectId })]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({
        id: r.id,
        title: r.title,
        mode: r.mode,
        state: r.state,
        desiredState: r.desiredState,
        iterationCount: r.iterationCount,
        detail: r.detail,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  timeline(runId: string, cursor: string | null = null, limit = 20) {
    const run = this.run(runId);
    return this.store.page<LoopIteration>(loopKinds.iteration, {
      projectId: run.projectId,
      conversationId: run.id,
      cursor,
      limit,
      order: "desc",
    });
  }

  events(runId: string, cursor: string | null = null, limit = 50) {
    const run = this.run(runId);
    return this.store.page(loopKinds.event, {
      projectId: run.projectId,
      conversationId: run.id,
      cursor,
      limit,
      order: "desc",
    });
  }

  view(runId: string) {
    const run = this.run(runId);
    const policy = this.policy(runId);
    const usage = this.usageRecord(run);
    const goals = this.goals(run);
    const head = run.acceptedCheckpointId
      ? this.checkpoint(run.acceptedCheckpointId)
      : null;
    const base = run.publicationBaseCheckpointId
      ? this.checkpoint(run.publicationBaseCheckpointId)
      : null;
    const topology = run.topologyRevisionId
      ? this.topology(run.topologyRevisionId)
      : null;
    const iterations = this.timeline(runId, null, 10).items;
    const current = run.currentIterationId
      ? this.repo.get<LoopIteration>(
          loopKinds.iteration,
          run.currentIterationId,
        )
      : undefined;
    const child = current ? this.childGoal(current) : undefined;
    const binding = topology
      ? this.loopBinding(run, topology, current ?? null)
      : null;
    const catalog = this.repo.roles(run.projectId);
    const assignments = current?.assignments.length
      ? current.assignments
      : (iterations.find((i) => i.assignments.length)?.assignments ?? []);
    const organization =
      topology && binding
        ? topology.roles.map((r) => {
            const def = catalog.find((c) => c.id === r.roleId);
            const group = r.active
              ? this.orchestrator.effective(
                  run.projectId,
                  null,
                  r.roleId,
                  null,
                  { binding, scopeId: `loop:${run.id}` },
                )
              : null;
            const l = r.active ? this.locks(run, r.roleId, binding) : null;
            return {
              ...r,
              title: def?.title ?? r.roleId,
              purpose: def?.purpose ?? null,
              functions: topology.roleBindings
                .filter((b) => b.roleId === r.roleId)
                .map((b) => b.function),
              locked: l ? [...l.fields] : [],
              presenceLocked: l?.presence ?? false,
              form: group?.form ?? null,
              count: group?.count ?? null,
              members: assignments
                .filter((a) => a.roleId === r.roleId)
                .map((a) => ({
                  ...a,
                  pinned:
                    group?.members.some(
                      (m) => m.memberId === a.memberId && m.pin,
                    ) ?? false,
                })),
            };
          })
        : [];
    const rounds = current
      ? this.scoped<LoopRound>(loopKinds.round, run).filter(
          (r) => r.iterationId === current.id,
        )
      : [];
    const assessments = (ids: string[]) =>
      ids
        .map((id) => this.repo.get<GoalAssessment>(loopKinds.assessment, id))
        .filter(Boolean);
    return {
      run,
      labels: {
        experimental: true,
        release: "implemented and fixture-tested; not live-provider-qualified",
      },
      policy,
      usage,
      goals: goals.map((g) => ({
        ...g,
        assessment: g.lastAssessmentId
          ? (this.repo.get<GoalAssessment>(
              loopKinds.assessment,
              g.lastAssessmentId,
            ) ?? null)
          : null,
      })),
      completion: run.mode === "goal" && head ? this.completion(run) : null,
      checkpoint: head
        ? {
            ...head,
            changedSinceBase:
              base && base.id !== head.id
                ? this.loop
                    .changedPaths(base.candidateId, head.candidateId)
                    .slice(0, 200)
                : [],
            count: this.scoped<LoopCheckpoint>(loopKinds.checkpoint, run)
              .length,
          }
        : null,
      topology: topology
        ? {
            id: topology.id,
            revision: topology.revision,
            reason: topology.reason,
            change: topology.change,
            authorityGeneration: topology.authorityGeneration,
            bindings: topology.roleBindings,
          }
        : null,
      organization,
      overrides: this.overrides(run),
      adaptations: this.scoped<AdaptationDecision>(loopKinds.adaptation, run)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 20),
      iterations: iterations.map((i) => ({
        ...i,
        assessments: assessments(i.assessmentIds).map((a) => ({
          goalId: a!.goalId,
          result: a!.result,
          detail: a!.detail,
        })),
      })),
      current: current
        ? {
            iteration: current,
            rounds: rounds.map((r) => ({
              id: r.id,
              stage: r.stage,
              state: r.state,
              detail: r.detail,
              roleId: r.roleId,
              members: r.members.map((m) => ({
                memberId: m.memberId,
                model: m.model,
                provider: m.provider,
                state: m.state,
                phase: m.phase,
                detail: m.detail,
              })),
            })),
            goal: child ? this.orchestrator.goalView(child.id) : null,
          }
        : null,
      backlog:
        run.mode === "endless"
          ? this.scoped<LoopOpportunity>(loopKinds.opportunity, run)
              .sort((a, b) => b.priorityScore - a.priorityScore)
              .slice(0, 20)
          : [],
      publication: {
        baseCandidateId: run.publicationBaseCandidateId,
        cursor: run.publicationCursorId
          ? (this.repo.get<PublicationCursor>(
              loopKinds.cursor,
              run.publicationCursorId,
            ) ?? null)
          : null,
        published: run.publicationCursorId
          ? this.repo.get<PublicationCursor>(
              loopKinds.cursor,
              run.publicationCursorId,
            )?.lastPublishedCheckpointId === run.acceptedCheckpointId
          : false,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Publication: separate from internal promotion, through its own authority.

  async publicationReview(runId: string) {
    const run = this.run(runId);
    if (
      !run.started ||
      !run.acceptedCheckpointId ||
      !run.publicationBaseCandidateId
    )
      throw new Error("Start the run before publishing its accepted work.");
    const head = this.checkpoint(run.acceptedCheckpointId);
    const cursor = run.publicationCursorId
      ? this.repo.get<PublicationCursor>(
          loopKinds.cursor,
          run.publicationCursorId,
        )
      : undefined;
    if (cursor?.state === "uncertain")
      throw new Error(
        "An earlier publication has an unknown outcome. Inspect the project folder; Topsl will not write it again until it is reconciled.",
      );
    if (cursor?.lastPublishedCheckpointId === head.id)
      throw new Error(
        "The accepted checkpoint is already published to the project folder.",
      );
    if (head.kind === "initial")
      throw new Error("Nothing has been accepted yet.");
    const plan = await this.loop.publicationPreview({
      projectId: run.projectId,
      baseCandidateId: run.publicationBaseCandidateId,
      headCandidateId: head.candidateId,
      cursor: cursor
        ? {
            lastPublishedCandidateId: this.checkpoint(
              cursor.lastPublishedCheckpointId,
            ).candidateId,
            targetRevision: cursor.targetRevision,
            manifest: cursor.manifest,
          }
        : null,
    });
    const body = {
      runId,
      checkpointId: head.id,
      sequence: head.sequence,
      root: plan.root,
      basis: plan.basis,
      baseRevision: plan.baseRevision,
      from: plan.fromCandidateId,
      to: plan.toCandidateId,
      files: plan.files,
      authority:
        "machine-promoted checkpoint; publication confirmed by the owner",
    };
    return {
      ...body,
      problems: plan.problems,
      digest: hash(stable(body)),
      plan,
    };
  }

  /**
   * loop-publication-apply: writes the accumulated accepted checkpoint into
   * the project folder after native confirmation of the exact file list. It
   * reuses folder identity, expected-content and read-back checks without
   * fabricating owner acceptance. Nothing is committed, staged or pushed.
   */
  async publish(input: { runId: string; digest: string; commandId: string }) {
    const { projectId } = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      projectId,
      "loop-publication-apply",
      () =>
        this.serialPublication(input.runId, async () => {
          // Read inside the fence: an earlier publication may have moved the cursor.
          const run = this.run(input.runId);
          const review = await this.publicationReview(run.id);
          if (input.digest !== review.digest)
            throw new Error(
              "The publication confirmation is stale. Review the file list again.",
            );
          if (review.problems.length)
            throw new Error(
              `Nothing was written: ${review.problems.join(" ")}`,
            );
          const prior = run.publicationCursorId
            ? this.repo.get<PublicationCursor>(
                loopKinds.cursor,
                run.publicationCursorId,
              )
            : undefined;
          const id = `${run.id}:publication`;
          const at = now();
          const base: PublicationCursor = prior ?? {
            id,
            runId: run.id,
            projectId: run.projectId,
            publicationBaseCandidateId: run.publicationBaseCandidateId!,
            lastPublishedCheckpointId: run.publicationBaseCheckpointId!,
            targetRoot: review.root,
            targetRevision: null,
            manifest: [],
            state: "published",
            receipts: [],
            updatedAt: at,
          };
          // The intent is recorded before any write, so an interrupted write is
          // reported uncertain and never repeated blindly.
          this.store.put(loopKinds.cursor, {
            ...base,
            state: "uncertain",
            updatedAt: at,
          });
          this.saveRun(run, { publicationCursorId: id });
          let result: Awaited<ReturnType<LoopDriver["publicationApply"]>>;
          try {
            result = await this.loop.publicationApply({
              projectId: run.projectId,
              plan: review.plan,
            });
          } catch (error) {
            this.store.put(loopKinds.cursor, {
              ...base,
              state: "uncertain",
              receipts: [
                ...base.receipts,
                {
                  checkpointId: review.checkpointId,
                  files: review.files.length,
                  at: now(),
                  outcome: "uncertain",
                },
              ],
              updatedAt: now(),
            });
            throw new Error(
              `The publication stopped after it may have written files (${safeError(error)}). Inspect the folder; Topsl will not write it again.`,
            );
          }
          if ("refused" in result) {
            if (prior) this.store.put(loopKinds.cursor, prior);
            else {
              this.store.remove(loopKinds.cursor, id);
              this.saveRun(this.run(run.id), { publicationCursorId: null });
            }
            throw new Error(`Nothing was written: ${result.refused}`);
          }
          const manifest = new Map(base.manifest.map((m) => [m.path, m]));
          for (const m of result.manifest) manifest.set(m.path, m);
          const cursor: PublicationCursor = {
            ...base,
            lastPublishedCheckpointId: review.checkpointId,
            targetRevision: result.targetRevision,
            manifest: [...manifest.values()].sort((a, b) =>
              a.path.localeCompare(b.path),
            ),
            state: "published",
            receipts: [
              ...base.receipts,
              {
                checkpointId: review.checkpointId,
                files: result.written.length,
                at: now(),
                outcome: "published",
              },
            ],
            updatedAt: now(),
          };
          this.store.put(loopKinds.cursor, cursor);
          this.event(
            this.run(run.id),
            "checkpoint-published",
            `Published checkpoint ${review.sequence}: ${result.written.length} files written and read back. Nothing was committed.`,
          );
          this.changed();
          return cursor;
        }),
    );
  }

  /** Publication and reconciliation in flight, by run. */
  private publications = new Map<string, Promise<unknown>>();
  /**
   * Runs one run's publication steps one at a time, so two concurrent
   * confirmations of the same checkpoint cannot both pass the "already
   * published" check before either writes: the second sees the first's
   * cursor and is refused.
   */
  private serialPublication<T>(runId: string, step: () => Promise<T>) {
    const next = (this.publications.get(runId) ?? Promise.resolve())
      .catch(() => {})
      .then(step);
    const tail = next.catch(() => {});
    this.publications.set(runId, tail);
    void tail.then(() => {
      if (this.publications.get(runId) === tail)
        this.publications.delete(runId);
    });
    return next;
  }

  /**
   * After the owner commits what Topsl published, the folder's revision
   * moves on. This accepts the new revision only when every path Topsl wrote
   * still holds exactly what it wrote and nothing else changed.
   */
  async reconcilePublication(input: { runId: string; commandId: string }) {
    const { projectId } = this.run(input.runId);
    return this.repo.receipt(
      input.commandId,
      projectId,
      "loop-publication-reconcile",
      () =>
        this.serialPublication(input.runId, async () => {
          const run = this.run(input.runId);
          const cursor = run.publicationCursorId
            ? this.repo.get<PublicationCursor>(
                loopKinds.cursor,
                run.publicationCursorId,
              )
            : undefined;
          if (!cursor)
            throw new Error("Nothing has been published from this run.");
          const plan = await this.loop.publicationPreview({
            projectId: run.projectId,
            baseCandidateId: run.publicationBaseCandidateId!,
            headCandidateId: this.checkpoint(cursor.lastPublishedCheckpointId)
              .candidateId,
            cursor: {
              lastPublishedCandidateId: this.checkpoint(
                cursor.lastPublishedCheckpointId,
              ).candidateId,
              targetRevision: "__reconcile__",
              manifest: cursor.manifest,
            },
          });
          const problems = plan.problems.filter(
            (p) => !p.startsWith("The folder's Git revision changed"),
          );
          if (problems.length)
            throw new Error(
              `The folder cannot be reconciled automatically: ${problems.join(" ")} A newly reviewed target basis is required (start a new run from the current folder).`,
            );
          const revision =
            (await this.loop.folderRevision?.(run.projectId)) ?? null;
          const next = {
            ...cursor,
            targetRevision: revision,
            state: "published" as const,
            updatedAt: now(),
          };
          this.store.put(loopKinds.cursor, next);
          this.changed();
          return next;
        }),
    );
  }

  async exportCheckpoint(input: {
    runId: string;
    checkpointId?: string | null;
  }) {
    const run = this.run(input.runId);
    const checkpoint = this.checkpoint(
      input.checkpointId ?? run.acceptedCheckpointId!,
    );
    if (checkpoint.runId !== run.id)
      throw new Error("That checkpoint belongs to another run.");
    if (!this.loop.exportCheckpoint || !this.options.exportRoot)
      throw new Error("No export route is available.");
    const target = `${this.options.exportRoot}/${run.id}/checkpoint-${checkpoint.sequence}-${uid().slice(0, 8)}`;
    return {
      path: await this.loop.exportCheckpoint({
        candidateId: checkpoint.candidateId,
        target,
      }),
      checkpointId: checkpoint.id,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** Orderly suspension on service shutdown; desired control state is kept. */
  suspend() {
    for (const a of [...this.store.iterate<ActiveIndex>(loopKinds.active)]) {
      const run = this.repo.get<LoopRun>(loopKinds.run, a.runId);
      if (!run || !["active", "monitoring", "waiting"].includes(run.state))
        continue;
      this.saveRun(run, {
        state: "suspended",
        detail:
          "Suspended: the Topsl service stopped. Recorded work is reconciled on the next start.",
      });
    }
  }

  /**
   * Reconciles after a restart: adopt recorded launches, revalidate the
   * project and checkpoint, and resume only under the run's recovery policy.
   * A stopped or paused run never restarts because of a refresh or wakeup.
   */
  async recover() {
    for (const a of [...this.store.iterate<ActiveIndex>(loopKinds.active)]) {
      const run = this.repo.get<LoopRun>(loopKinds.run, a.runId);
      if (!run) continue;
      for (const round of this.scoped<LoopRound>(loopKinds.round, run))
        if (round.members.some((m) => m.launchId && !m.activeAttemptId))
          this.collectRound(run, round);
      if (run.desiredState === "stopped") continue;
      const problems: string[] = [];
      const project = this.repo.get<Project>("project", run.projectId);
      const head = run.acceptedCheckpointId
        ? this.repo.get<LoopCheckpoint>(
            loopKinds.checkpoint,
            run.acceptedCheckpointId,
          )
        : undefined;
      if (!project) problems.push("The project no longer exists.");
      // Revalidate the accepted checkpoint's bytes through the loop driver.
      if (
        run.acceptedCheckpointId &&
        (!head ||
          this.loop.contentDigest(head.candidateId) !== head.contentDigest)
      )
        problems.push(
          "The accepted checkpoint's content could not be verified.",
        );
      if (problems.length) {
        this.saveRun(run, {
          state: "waiting",
          waitReason: { kind: "recovery", detail: problems.join(" ") },
          detail: `Recovery: ${problems.join(" ")}`,
        });
        continue;
      }
      if (run.state !== "suspended") continue;
      const policy = this.policy(run.id);
      const it = run.currentIterationId
        ? this.repo.get<LoopIteration>(
            loopKinds.iteration,
            run.currentIterationId,
          )
        : undefined;
      const children = (it?.childExecutionGoalIds ?? []).filter((id) => {
        const g = this.repo.get<Goal>(kinds.goal, id);
        return (
          g &&
          !g.loopDisposition &&
          !["stopped", "completed", "accepted"].includes(g.state)
        );
      });
      if (
        run.desiredState === "running" &&
        policy.recovery.resumeAfterRestart &&
        this.enabled()
      ) {
        const next = this.saveRun(run, {
          state: "active",
          controlGeneration: run.controlGeneration + 1,
          detail: "Resumed after restart under the run's recovery policy.",
        });
        if (it && !terminalIteration.has(it.state))
          this.saveIteration(it, { controlGeneration: next.controlGeneration });
        this.event(next, "control-changed", next.detail);
      } else {
        // Nothing runs until the owner resumes.
        for (const goalId of children)
          await this.orchestrator
            .controlCommand({
              projectId: run.projectId,
              goalId,
              action: "pause",
              commandId: `${goalId}:suspend:${run.revision}`,
            })
            .catch(() => {});
        this.saveRun(run, {
          detail:
            "Suspended after restart. Resume to continue; recorded work was reconciled.",
        });
      }
    }
  }
}

interface CompletionSnapshot {
  goalSetRevision: number;
  controlGeneration: number;
  policyRevision: number;
  checkpointId: string;
}

interface EvidenceItem {
  id: string;
  kind: "check" | "review" | "artifact";
  checkId?: string;
  result: string;
  detail: string;
  goalVersions?: Record<string, number>;
}

type Assessable = Pick<
  LoopGoal,
  | "id"
  | "version"
  | "text"
  | "required"
  | "priority"
  | "status"
  | "criteria"
  | "blocker"
  | "satisfiedAtCheckpointId"
>;
