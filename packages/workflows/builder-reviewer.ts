import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { bindCheckInputs } from "./check-inputs";
import {
  consumeCandidateCapturePlan,
  type CandidateReviewPlan,
} from "./candidate-reviews";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type { Installation, Message, Project, Provider } from "../domain/types";
import {
  claudeStepModel,
  claudeStepNoun,
  type ClaudeStep,
  type ClaudeStepOpen,
  type ClaudeStepProvenance,
  type ClaudeStepReply,
  type ClaudeStepReplySource,
  type ClaudeStepRole,
  type ClaudeTranscriptSource,
} from "../domain/claude-steps";
import type { Store } from "../persistence/store";
import type {
  Artifact,
  ExecutionAttempt,
  Task,
  Workflow,
  Workspace,
} from "../domain/workflow";
import { CoordinationRepository } from "../persistence/repositories/coordination";
import { canonicalWorkspaceIdentity } from "../workspace/ownership";
import type { ContextServer, ContextGrant } from "../workspace/context";
import {
  createSpecification,
  createTaskContext,
  recordContextDelivery,
  type TaskContextPackage,
  type WorkflowSpecification,
} from "../context/packages";
import {
  assertCandidateCurrent,
  assertMaterializedCandidate,
  captureCandidate,
  assertCandidateCoverage,
  assertCandidateOutputCoverage,
  candidateHasTextLine,
  materializeCandidate,
  removeMaterializedCopy,
  type CandidateSelection,
  type CandidateSnapshot,
} from "./candidates";
import { RevisionRepository } from "../context/revisions";
import {
  findingBlocks,
  findingDecisions,
  latestFindingDecision,
  recordFindingDecision,
} from "./finding-decisions";
import {
  executeCheck,
  previewCheck,
  type CheckDefinition,
  type CheckPlan,
} from "./verification";

export interface RoleAssignment {
  provider: Provider;
  installationId: string;
  model: string;
  effort?: string;
  /** terminal: a Claude Code step the owner runs in Topsl's terminal, not a turn Topsl runs. */
  route?: "terminal";
}
export interface WorkflowFinding {
  id: string;
  projectId: string;
  workflowId: string;
  candidateId: string;
  candidateRevision: string;
  reviewAttemptId: string;
  title: string;
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  behavior: string;
  evidence: string;
  disposition: "open" | "resolved";
  resolvedByCandidateId: string | null;
}
export interface BuilderReviewerState {
  id: string;
  projectId: string;
  specificationId: string;
  workspaceId: string;
  builder: RoleAssignment;
  reviewer: RoleAssignment;
  selection: Pick<CandidateSelection, "selectedPaths" | "approvedUntracked">;
  checks: CheckDefinition[];
  maxRepairs: number;
  repairRound: number;
  stage:
    | "ready-build"
    | "building"
    | "ready-review"
    | "reviewing"
    | "ready-repair"
    | "repairing"
    | "checking"
    | "awaiting-acceptance"
    | "accepted"
    | "blocked"
    | "cancelled";
  baselineId: string;
  candidateId: string;
  activeAttemptId: string | null;
  builderTaskId: string;
  reviewerTaskId: string | null;
  checkTaskId: string | null;
  reviewedCandidateId: string | null;
  reviewArtifactId: string | null;
  findings: string[];
  supersededTaskIds: string[];
  detail: string;
  isolation: "not-enforced";
  updatedAt: string;
}
/**
 * A Claude Code step as the workflow page shows it: the step and each reply
 * handed back for it, oldest first, without the reply's text.
 */
export type ClaudeStepView = ClaudeStep & {
  replies: Array<
    Pick<ClaudeStepReply, "id" | "source" | "outcome" | "detail" | "receivedAt">
  >;
};
export interface WorkflowDispatch {
  attempt: ExecutionAttempt;
  task: Task;
  installation: Installation;
  project: Project;
  context: TaskContextPackage;
  mode: "edit" | "review";
}
export interface WorkflowDriver {
  capacity?(
    assignment: RoleAssignment,
    workflowId: string,
  ): { available: boolean; detail: string };
  capabilities(
    assignment: RoleAssignment,
    installation: Installation,
    role?: "implementer" | "reviewer",
  ): { supported: boolean; detail: string };
  dispatch(input: WorkflowDispatch): Promise<void>;
  /** Runtime adapter installs the scoped reader over its tool channel before
   * inference. A prompt reference or capability declaration is insufficient. */
  installCandidateReader?(input: {
    attempt: ExecutionAttempt;
    grant: ContextGrant;
    candidate: CandidateSnapshot;
  }): Promise<void>;
  result?(attempt: ExecutionAttempt): string;
  interrupt?(attempt: ExecutionAttempt): Promise<void>;
}
export const reviewSchema = z.object({
  candidateRevision: z.string(),
  summary: z.string().max(20000),
  findings: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        severity: z.enum(["high", "medium", "low"]),
        file: z.string().min(1).max(4096),
        line: z.number().int().positive(),
        behavior: z.string().min(1).max(10000),
        evidence: z.string().min(1).max(20000),
      }),
    )
    .max(100),
});

export const reviewOutputSchema = z.toJSONSchema(reviewSchema);

/** The stage a Claude Code step of this role is the turn of. */
const stepStage = {
  builder: "building",
  reviewer: "reviewing",
  repair: "repairing",
} as const satisfies Record<ClaudeStepRole, BuilderReviewerState["stage"]>;
/**
 * The Claude Code build or repair step that holds this project's folder, if
 * one does: from when its workflow stops for it until the owner hands back its
 * reply or cancels the workflow. No Topsl-run writer starts in the folder
 * meanwhile, because a Claude Code session moved to the background keeps
 * editing after its terminal closes.
 */
export function claudeStepHolding(
  store: Store,
  projectId: string,
  exceptStepId?: string,
): ClaudeStep | undefined {
  for (const step of store.iterate<ClaudeStep>("claude-step", { projectId }))
    if (
      step.id !== exceptStepId &&
      step.role !== "reviewer" &&
      step.state === "waiting" &&
      store.get<BuilderReviewerState>("builder-reviewer", step.workflowId)
        ?.activeAttemptId === step.attemptId
    )
      return step;
  return undefined;
}

/** The step's latest opening that started Claude Code. */
function latestOpened(step: ClaudeStep): ClaudeStepOpen | undefined {
  return step.opens
    .filter((open) => open.state === "opened")
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .at(-1);
}

/**
 * The steps whose replies Topsl took for the build under acceptance, oldest
 * first, each with the session its reply came from: every build and repair
 * since the workflow's baseline was captured, because a repair keeps the build
 * it repairs and only a restart starts again from a new baseline, and the
 * review of that build, because an earlier review no longer counts.
 */
function claudeStepProvenance(
  state: BuilderReviewerState,
  steps: ClaudeStep[],
  baselineAt: string,
): ClaudeStepProvenance[] {
  return steps
    .filter(
      (step) =>
        step.workflowId === state.id &&
        step.state === "returned" &&
        !!step.replySource &&
        (step.role === "reviewer"
          ? !state.supersededTaskIds.includes(step.taskId)
          : step.createdAt >= baselineAt),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((step) => {
      // A step takes no opening after its reply, so its latest is the reply's.
      const open = latestOpened(step);
      return {
        role: step.role,
        replySource: step.replySource!,
        sessionId: open?.sessionId ?? null,
        mode: open?.mode ?? null,
        runtimeVersion: open?.runtimeVersion ?? null,
      };
    });
}

/** Why a reply is not a review of this build, or null when it is one. */
function reviewReplyProblem(
  text: string,
  candidate: CandidateSnapshot,
  store: Store,
): string | null {
  let reply: unknown;
  try {
    reply = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return "it is not one JSON object in the review format.";
  }
  const parsed = reviewSchema.safeParse(reply);
  if (!parsed.success)
    return `it does not match the review format (${parsed.error.issues
      .slice(0, 3)
      .map(
        (issue) => `${issue.path.join(".") || "the reply"}: ${issue.message}`,
      )
      .join("; ")}).`;
  if (parsed.data.candidateRevision !== candidate.revision)
    return `it names candidate revision ${JSON.stringify(parsed.data.candidateRevision.slice(0, 80))}, not this build's ${candidate.revision}.`;
  const index = parsed.data.findings.findIndex((finding) => {
    try {
      return !candidateHasTextLine(
        candidate,
        finding.file,
        finding.line,
        store,
      );
    } catch {
      return true;
    }
  });
  if (index >= 0) {
    const finding = parsed.data.findings[index];
    return `finding ${index + 1} names ${JSON.stringify(finding.file.slice(0, 200))} line ${finding.line}, which is not a text line of this build. Name each file by its path relative to the review's folder.`;
  }
  return null;
}

/** One request, immutable evidence, deterministic scheduling. Provider completion alone never accepts work. */
export class BuilderReviewerWorkflow {
  private locks = new Set<string>();
  private reviews = new Map<
    string,
    Awaited<ReturnType<typeof materializeCandidate>>
  >();
  constructor(
    readonly repository: CoordinationRepository,
    private driver: WorkflowDriver,
    private contextServer?: ContextServer,
    private changed = () => {},
  ) {}
  private state(id: string): BuilderReviewerState {
    return this.repository.require("builder-reviewer", id);
  }
  private candidate(id: string): CandidateSnapshot {
    return this.repository.require("candidate", id);
  }
  private artifact(
    candidate: CandidateSnapshot,
    taskId: string | null,
  ): Artifact {
    const at = now();
    return this.repository.artifact({
      id: candidate.id,
      projectId: candidate.projectId,
      taskId,
      attemptId: candidate.authorAttemptId,
      conversationId: null,
      kind: "candidate",
      contentHash: candidate.revision,
      targetRevision: candidate.revision,
      protectedContentRef: candidate.id,
      confidentiality: "project",
      provenance: {
        level: "source-observation",
        source: "topsl-candidate-snapshot",
        observedAt: at,
        detail:
          "Exact approved file bytes and omissions captured in the encrypted vault.",
      },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
  }
  private save(
    state: BuilderReviewerState,
    next: Partial<BuilderReviewerState>,
    workflowState?: Workflow["state"],
  ): BuilderReviewerState {
    return this.repository.store.transaction(() => {
      const value = { ...state, ...next, updatedAt: now() },
        workflow = this.repository.require<Workflow>("workflow", state.id);
      this.repository.transitionWorkflow(
        workflow.id,
        workflow.revision,
        workflowState ?? workflow.state,
      );
      this.repository.store.save(
        "builder-reviewer",
        value,
        "workflow.progress",
      );
      this.changed();
      return value;
    });
  }
  private expect(id: string, expectedRevision: number): Workflow {
    const workflow = this.repository.require<Workflow>("workflow", id);
    if (workflow.revision !== expectedRevision)
      throw new Error("Workflow changed. Refresh before taking this action.");
    return workflow;
  }
  async create(
    project: Project,
    input: {
      objective: string;
      acceptanceCriteria: string[];
      interfaces?: string[];
      builder: RoleAssignment;
      reviewer: RoleAssignment;
      selectedPaths?: string[];
      approvedUntracked?: string[];
      checks: CheckDefinition[];
      maxRepairs?: number;
      requireIndependence?: boolean;
    },
  ): Promise<BuilderReviewerState> {
    if (input.requireIndependence)
      throw new Error(
        "Independent filesystem/tool access is unavailable; the independent template is disabled. Ordinary candidate review is labeled independence not enforced.",
      );
    if (
      !input.checks.length ||
      new Set(input.checks.map((c) => c.id)).size !== input.checks.length
    )
      throw new Error(
        "Select at least one distinct required check before starting.",
      );
    if (
      !Number.isInteger(input.maxRepairs ?? 2) ||
      (input.maxRepairs ?? 2) < 0 ||
      (input.maxRepairs ?? 2) > 2
    )
      throw new Error("The automatic repair limit is at most two.");
    if (!project.trusted)
      throw new Error(
        "Approve the project folder before creating a coordinated workflow.",
      );
    for (const assignment of [input.builder, input.reviewer]) {
      const installation = this.repository.require<Installation>(
        "installation",
        assignment.installationId,
      );
      if (
        (assignment.provider === "codex"
          ? "openai.codex-cli"
          : "anthropic.claude-code-cli") !== installation.appId ||
        !installation.trusted ||
        !assignment.model.trim()
      )
        throw new Error(
          "Each role needs its selected trusted provider runtime and requested model.",
        );
      if (assignment.route === "terminal" && assignment.provider !== "claude")
        throw new Error(
          "Only Claude Code runs as a step in Topsl's terminal; Codex runs inside Topsl.",
        );
      if (
        assignment.route === "terminal" &&
        (assignment.model !== claudeStepModel || assignment.effort)
      )
        throw new Error(
          `Topsl passes a Claude Code step no model or effort, so Claude Code's own settings decide. Name the model "${claudeStepModel}" and no effort.`,
        );
    }
    const workspace = this.repository.ensureWorkspace(project),
      workflow = this.repository.createWorkflow({
        projectId: project.id,
        objective: input.objective,
        template: "builder-reviewer",
        templateVersion: "1",
        budget: { concurrency: 2, repairRounds: input.maxRepairs ?? 2 },
      });
    try {
      const specification = createSpecification(this.repository.store, {
        workflowId: workflow.id,
        projectId: project.id,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        interfaces: input.interfaces ?? [],
      });
      const baseline = await captureCandidate(this.repository.store, {
        root: workspace.canonicalRoot,
        projectId: project.id,
        workflowId: workflow.id,
        selectedPaths: input.selectedPaths,
        approvedUntracked: input.approvedUntracked,
      });
      bindCheckInputs(
        this.repository.store,
        workflow.id,
        baseline,
        input.checks,
      );
      this.artifact(baseline, null);
      const task = this.repository.createTask({
        projectId: project.id,
        workflowId: workflow.id,
        workspaceId: workspace.id,
        title: "Build requested change",
        role: "implementer",
        acceptanceCriteria: specification.acceptanceCriteria,
        inputRefs: [specification.id, baseline.id],
        permittedOutputs: baseline.files.map((f) => f.path),
        requiredCapabilities: ["structured-turn", "workspace-write"],
      });
      this.repository.transitionTask(task.id, task.revision, "ready");
      const current = this.repository.require<Workflow>(
        "workflow",
        workflow.id,
      );
      this.repository.store.put("workflow", {
        ...current,
        specificationRevision: specification.revision,
      });
      const state: BuilderReviewerState = {
        id: workflow.id,
        projectId: project.id,
        specificationId: specification.id,
        workspaceId: workspace.id,
        builder: input.builder,
        reviewer: input.reviewer,
        selection: {
          selectedPaths: input.selectedPaths,
          approvedUntracked: input.approvedUntracked,
        },
        checks: input.checks,
        maxRepairs: input.maxRepairs ?? 2,
        repairRound: 0,
        stage: "ready-build",
        baselineId: baseline.id,
        candidateId: baseline.id,
        activeAttemptId: null,
        builderTaskId: task.id,
        reviewerTaskId: null,
        checkTaskId: null,
        reviewedCandidateId: null,
        reviewArtifactId: null,
        findings: [],
        supersededTaskIds: [],
        detail:
          "Ready to build. Review and required checks gate explicit user acceptance.",
        isolation: "not-enforced",
        updatedAt: now(),
      };
      this.repository.store.immutable("builder-reviewer-definition", {
        ...state,
        id: workflow.id,
      });
      return this.save(state, {}, "ready");
    } catch (error) {
      const current = this.repository.require<Workflow>(
        "workflow",
        workflow.id,
      );
      this.repository.transitionWorkflow(
        current.id,
        current.revision,
        "cancelled",
      );
      throw error;
    }
  }
  /** The answer a turn ended with: its last assistant message. Codex and
   * Claude send progress notes before they answer, and each is a message of
   * its own in the run's history. */
  private result(attempt: ExecutionAttempt): string {
    // A Claude Code step's answer is the reply the owner handed back.
    const step = this.repository.store.get<ClaudeStep>(
      "claude-step",
      attempt.id,
    );
    if (step)
      return step.replyId
        ? this.repository.require<ClaudeStepReply>(
            "claude-step-reply",
            step.replyId,
          ).text
        : "";
    if (this.driver.result) return this.driver.result(attempt);
    return (
      [
        ...this.repository.store.iterate<Message>("message", {
          projectId: attempt.projectId,
        }),
      ]
        .filter(
          (m) => m.runId === attempt.legacyRunId && m.role === "assistant",
        )
        .at(-1)?.text ?? ""
    );
  }
  async advance(
    id: string,
    expectedRevision: number,
  ): Promise<BuilderReviewerState> {
    if (this.locks.has(id))
      throw new Error("This workflow action is already pending.");
    this.locks.add(id);
    try {
      this.expect(id, expectedRevision);
      return await this.advanceLocked(id);
    } finally {
      this.locks.delete(id);
    }
  }
  /** advance() once it holds the workflow's lock. */
  private async advanceLocked(id: string): Promise<BuilderReviewerState> {
    let state = this.state(id);
    if (["accepted", "cancelled", "blocked"].includes(state.stage))
      throw new Error(state.detail || "Workflow is not runnable.");
    const candidate = this.candidate(state.candidateId);
    try {
      await assertCandidateCurrent(candidate);
    } catch (error) {
      // During an authorized builder turn the live workspace is expected to change.
      if (!["building", "repairing"].includes(state.stage)) {
        this.repository.invalidateCandidate(candidate.id, safeError(error));
        return this.save(state, {
          stage: "blocked",
          detail: safeError(error),
        });
      }
    }
    if (state.activeAttemptId) {
      const attempt = this.repository.require<ExecutionAttempt>(
        "attempt",
        state.activeAttemptId,
      );
      if (
        ["prepared", "starting", "running", "awaiting-approval"].includes(
          attempt.state,
        )
      )
        return state;
      if (attempt.state !== "completed") {
        // The attempt has ended, so its reader grant goes with it.
        this.contextServer?.revokeAttempt(attempt.id);
        return this.save(
          state,
          {
            stage: "blocked",
            detail: `Attempt ${attempt.state}: ${attempt.error ?? "reconcile before replacement; nothing was retried"}`,
          },
          "blocked",
        );
      }
      const outstandingLease = this.repository.store.db
        .prepare(
          "SELECT state FROM workspace_leases WHERE attempt_id=? AND state!='released'",
        )
        .get(attempt.id);
      if (outstandingLease) {
        const detail =
          "Provider turn completed; waiting for confirmed process exit before freezing its output.";
        return state.detail === detail ? state : this.save(state, { detail });
      }
      this.contextServer?.revokeAttempt(attempt.id);
      if (state.stage === "reviewing") {
        state = await this.completeReview(state, attempt);
        // A finding is a proposal. Leave time for explicit adjudication before
        // the next bounded repair dispatch (including the background observer).
        if (state.stage === "ready-repair") return state;
      } else state = await this.completeBuild(state, attempt);
    }
    if (["ready-build", "ready-review", "ready-repair"].includes(state.stage))
      return await this.dispatch(state);
    return state;
  }
  private async dispatch(
    state: BuilderReviewerState,
  ): Promise<BuilderReviewerState> {
    try {
      return await this.dispatchPrepared(state);
    } catch (error) {
      const current = this.state(state.id),
        copy = this.reviews.get(state.id);
      if (!current.activeAttemptId) {
        if (current.reviewerTaskId) {
          const task = this.repository.require<Task>(
            "task",
            current.reviewerTaskId,
          );
          if (["draft", "ready"].includes(task.state))
            this.repository.transitionTask(
              task.id,
              task.revision,
              "cancelled",
              "Preparation failed before dispatch.",
            );
        }
        if (copy) {
          await copy.cleanup();
          this.reviews.delete(state.id);
        }
      }
      return this.save(
        current,
        {
          stage: "blocked",
          detail: `Preparation blocked: ${safeError(error)}`,
        },
        "blocked",
      );
    }
  }
  private async dispatchPrepared(
    state: BuilderReviewerState,
  ): Promise<BuilderReviewerState> {
    try {
      assertCandidateOutputCoverage(
        this.candidate(state.candidateId),
        this.repository.store,
      );
    } catch (error) {
      return this.save(state, {
        detail: `Awaiting output manifest review: ${safeError(error)} No provider turn was dispatched; approve the exact captured output and explicitly advance again.`,
      });
    }
    // Both selected routes must be usable before spending a builder turn.
    for (const assignment of [state.builder, state.reviewer]) {
      const installation = this.repository.require<Installation>(
          "installation",
          assignment.installationId,
        ),
        // A Claude Code step is ready when its installation is trusted; the
        // owner signs in and runs it in Claude Code.
        capability =
          assignment.route === "terminal"
            ? installation.appId === "anthropic.claude-code-cli" &&
              installation.trusted
              ? {
                  supported: true,
                  detail: "Claude Code runs this step in Topsl's terminal.",
                }
              : {
                  supported: false,
                  detail:
                    "Trust this Claude Code executable in Applications before its step can open.",
                }
            : this.driver.capabilities(
                assignment,
                installation,
                assignment === state.reviewer ? "reviewer" : "implementer",
              );
      if (!capability.supported)
        return this.save(
          state,
          { stage: "blocked", detail: capability.detail },
          "blocked",
        );
    }
    const review = state.stage === "ready-review",
      repair = state.stage === "ready-repair",
      role = review ? "reviewer" : repair ? "repair" : "builder";
    if (repair && state.repairRound >= state.maxRepairs)
      return this.save(
        state,
        {
          stage: "blocked",
          detail:
            "The bounded repair limit was reached. Inspect unresolved findings and create an explicitly reviewed continuation.",
        },
        "blocked",
      );
    const assignment = review ? state.reviewer : state.builder,
      installation = this.repository.require<Installation>(
        "installation",
        assignment.installationId,
      ),
      candidate = this.candidate(state.candidateId),
      // The owner runs this stage in Claude Code; Topsl starts no turn.
      step = assignment.route === "terminal",
      delivery = step ? ("terminal" as const) : undefined;
    // One writer at a time: a build or repair waits while another workflow's
    // Claude Code step holds the project folder.
    const holding = review
      ? undefined
      : claudeStepHolding(this.repository.store, state.projectId);
    if (holding && holding.workflowId !== state.id)
      return this.save(state, {
        detail: `Waiting for capacity: another workflow's Claude Code ${claudeStepNoun[holding.role]} holds this project folder until its reply is handed back or that workflow is cancelled.`,
      });
    const capacity = step
      ? undefined
      : this.driver.capacity?.(assignment, state.id);
    if (capacity && !capacity.available)
      return this.save(state, {
        detail: `Waiting for capacity: ${capacity.detail}`,
      });
    const specification = this.repository.require<WorkflowSpecification>(
      "workflow-specification",
      state.specificationId,
    );
    const findings = state.findings
      .filter((id) =>
        findingBlocks(
          this.repository.store,
          this.repository.require<WorkflowFinding>("workflow-finding", id),
        ),
      )
      .map((id) => {
        const f = this.repository.require<WorkflowFinding>(
          "workflow-finding",
          id,
        );
        return { id, revision: f.candidateRevision, text: stable(f) };
      });
    // Validate the entire mandatory package before creating a task or snapshot directory.
    const previewContext = createTaskContext(this.repository.store, {
      specification,
      candidate,
      taskId: state.builderTaskId,
      role,
      findings,
      delivery,
      persist: false,
    });
    if (
      previewContext.retrievalRequired &&
      (!this.contextServer || !this.driver.installCandidateReader)
    )
      throw new Error(
        "Immutable candidate reader installation is unavailable; dispatch is blocked before a task/copy/paid turn is created.",
      );
    let task: Task,
      workspace = this.repository.require<Workspace>(
        "workspace",
        state.workspaceId,
      );
    if (review) {
      // Claude Code's Plan is not a sandbox, so its copy cannot gain, lose or
      // rename a file either.
      const copy = await materializeCandidate(candidate, undefined, undefined, {
          readOnlyFolders: step,
        }),
        at = now(),
        identity = canonicalWorkspaceIdentity(copy.root);
      workspace = {
        ...workspace,
        id: uid(),
        root: copy.root,
        canonicalRoot: identity.canonicalRoot,
        filesystemIdentity: identity.filesystemIdentity,
        checkoutType: "snapshot",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      this.repository.store.immutable("workspace", workspace);
      this.reviews.set(state.id, copy);
      task = this.repository.createTask({
        projectId: state.projectId,
        workflowId: state.id,
        workspaceId: workspace.id,
        title: `Review candidate ${candidate.revision.slice(0, 10)}`,
        role: "reviewer",
        dependencies: [state.builderTaskId],
        inputRefs: [candidate.id],
        acceptanceCriteria: [
          "Substantiated findings against the pinned candidate",
        ],
        requiredCapabilities: ["structured-turn", "read-only"],
      });
      task = this.repository.transitionTask(task.id, task.revision, "ready");
      state = this.save(state, { reviewerTaskId: task.id });
    } else if (repair) {
      task = this.repository.createTask({
        projectId: state.projectId,
        workflowId: state.id,
        workspaceId: workspace.id,
        title: `Repair findings · round ${state.repairRound + 1}`,
        role: "implementer",
        inputRefs: [candidate.id, ...state.findings],
        acceptanceCriteria: this.repository.require<WorkflowSpecification>(
          "workflow-specification",
          state.specificationId,
        ).acceptanceCriteria,
        requiredCapabilities: ["structured-turn", "workspace-write"],
      });
      task = this.repository.transitionTask(task.id, task.revision, "ready");
      const superseded = [state.builderTaskId, state.reviewerTaskId!];
      for (const id of superseded) {
        const old = this.repository.require<Task>("task", id);
        this.repository.store.immutable("task-supersession", {
          id,
          workflowId: state.id,
          replacementTaskId: task.id,
          candidateId: candidate.id,
          reason: "Repair findings against pinned candidate",
          createdAt: now(),
        });
        this.repository.transitionTask(
          id,
          old.revision,
          "cancelled",
          "Superseded by a new repair candidate; original inputs/evidence remain historical.",
        );
      }
      state = this.save(state, {
        builderTaskId: task.id,
        reviewerTaskId: null,
        supersededTaskIds: [...state.supersededTaskIds, ...superseded],
        repairRound: state.repairRound + 1,
      });
    } else task = this.repository.require<Task>("task", state.builderTaskId);
    const context = createTaskContext(this.repository.store, {
      specification,
      candidate,
      taskId: task.id,
      role,
      findings,
      delivery,
    });
    // Generic domain projection retains original content/hash, never reclassifies it as provider-loaded.
    this.repository.store.immutable("context-package", {
      id: context.id,
      projectId: context.projectId,
      conversationId: null,
      hash: context.contentHash,
      text: context.content,
      specificationRevision: context.specificationRevision,
      sourceRefs: context.sources.map((s) => s.id),
      omissions: context.omissions.map((o) => `${o.source}: ${o.reason}`),
      visibility: "restricted",
      completeness: "recorded",
      createdAt: context.createdAt,
    });
    const revisions = new RevisionRepository(this.repository.store);
    revisions.bindPackage(task.id, context.id);
    revisions.assertTaskInputsCurrent(task.id, context.id);
    const attempt = this.repository.prepareAttempt({
      taskId: task.id,
      expectedRevision: task.revision,
      provider: assignment.provider,
      // Topsl passes a Claude Code step no model; its own setting decides.
      requestedModel: step ? null : assignment.model,
      freshSession: true,
      runtimeRevision: installation.revisionId,
      executableIdentity: installation.identity,
      contextPackageId: context.id,
      specificationRevision: specification.revision,
      inputManifest: {
        workspaceIdentity: workspace.filesystemIdentity,
        baseRevision: candidate.baseRevision,
        contentManifestId: candidate.id,
        dirtyInputPolicy: "reviewed-snapshot",
        instructionHashes: candidate.instructionHashes.map((i) => ({
          ...i,
          delivery: "injected",
        })),
      },
    });
    this.repository.store.immutable("attempt-runtime-settings", {
      id: attempt.id,
      projectId: state.projectId,
      effort: assignment.effort ?? null,
    });
    revisions.bindPackage(task.id, context.id, attempt.id);
    if (review)
      this.repository.store.immutable("review-snapshot-proof", {
        id: attempt.id,
        workflowId: state.id,
        candidateId: candidate.id,
        candidateRevision: candidate.revision,
        root: workspace.canonicalRoot,
        filesystemIdentity: workspace.filesystemIdentity,
        state: "pending",
        checkedAt: null,
        detail: "Prepared pinned review snapshot; completion proof pending.",
      });
    const project = this.repository.require<Project>(
      "project",
      state.projectId,
    );
    try {
      // Claude Code reads its folder, so a step gets no reader grant.
      if (this.contextServer && !step) {
        const grant = this.contextServer.grant(project, {
          visibility: { messageIds: [] },
          candidates: [
            { candidateId: candidate.id, revision: candidate.revision },
          ],
          candidateVisibility: "task-inputs",
          subject: {
            attemptId: attempt.id,
            agentSessionId: attempt.sessionId,
            workflowId: state.id,
            taskId: task.id,
          },
        });
        if (context.retrievalRequired) {
          if (!this.driver.installCandidateReader) {
            this.contextServer.revoke(grant.grant);
            throw new Error(
              "This candidate requires immutable retrieval, but the selected runtime has no qualified candidate reader installer. No provider turn was dispatched.",
            );
          }
          try {
            await this.driver.installCandidateReader({
              attempt,
              grant,
              candidate,
            });
          } catch (error) {
            this.contextServer.revoke(grant.grant);
            throw new Error(
              `Candidate reader installation failed before provider dispatch: ${safeError(error)}`,
            );
          }
        }
        this.repository.store.immutable("attempt-context-grant", {
          id: attempt.id,
          projectId: state.projectId,
          grantId: grant.grant,
          expiresAt: grant.expiresAt,
          visibility: "no-project-history",
          delivery: context.retrievalRequired
            ? "installed-before-dispatch"
            : review
              ? "initial-input-complete; retrieval-not-required"
              : "workspace-read; retrieval-not-required",
        });
      } else if (context.retrievalRequired)
        throw new Error(
          "This candidate requires an installed scoped reader before provider dispatch; the context service is unavailable.",
        );
    } catch (error) {
      this.contextServer?.revokeAttempt(attempt.id);
      this.repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "failed",
        { error: safeError(error) },
      );
      recordContextDelivery(
        this.repository.store,
        context,
        attempt.id,
        "failed",
      );
      throw error;
    }
    recordContextDelivery(
      this.repository.store,
      context,
      attempt.id,
      "prepared",
    );
    if (step)
      return this.prepareClaudeStep(state, {
        attempt,
        task,
        installation,
        workspace,
        candidate,
        context,
        role,
      });
    state = this.save(
      state,
      {
        activeAttemptId: attempt.id,
        stage: review ? "reviewing" : repair ? "repairing" : "building",
        detail: `${role} dispatched with immutable inputs; effective model is pending provider evidence.`,
      },
      "running",
    );
    try {
      await this.driver.dispatch({
        attempt,
        task,
        installation,
        project: {
          ...project,
          path: workspace.root,
          realPath: workspace.canonicalRoot,
        },
        context,
        mode: review ? "review" : "edit",
      });
      const current = this.repository.require<ExecutionAttempt>(
        "attempt",
        attempt.id,
      );
      recordContextDelivery(
        this.repository.store,
        context,
        attempt.id,
        current.operationIntentId &&
          this.repository.store.get<{ state: string }>(
            "operation-intent",
            current.operationIntentId,
          )?.state === "acknowledged"
          ? "acknowledged"
          : current.state === "uncertain"
            ? "unknown"
            : "submitted",
      );
      return state;
    } catch (error) {
      this.contextServer?.revokeAttempt(attempt.id);
      const current = this.repository.require<ExecutionAttempt>(
        "attempt",
        attempt.id,
      );
      if (
        ["prepared", "starting"].includes(current.state) &&
        !current.operationIntentId
      )
        this.repository.transitionAttempt(
          current.id,
          current.revision,
          "failed",
          { error: safeError(error) },
        );
      else if (
        current.operationIntentId &&
        ["prepared", "starting", "running", "awaiting-approval"].includes(
          current.state,
        )
      ) {
        this.repository.transitionAttempt(
          current.id,
          current.revision,
          "uncertain",
          { error: safeError(error) },
        );
        const intent = this.repository.require<{ state: string }>(
          "operation-intent",
          current.operationIntentId,
        );
        if (["dispatch-recorded", "acknowledged"].includes(intent.state))
          this.repository.updateIntent(current.operationIntentId, "unknown");
      }
      recordContextDelivery(
        this.repository.store,
        context,
        attempt.id,
        current.operationIntentId ? "unknown" : "failed",
      );
      return this.save(
        state,
        { stage: "blocked", detail: safeError(error) },
        "blocked",
      );
    }
  }
  /** Records a prepared stage as a Claude Code step that waits for the owner. */
  private prepareClaudeStep(
    state: BuilderReviewerState,
    input: {
      attempt: ExecutionAttempt;
      task: Task;
      installation: Installation;
      workspace: Workspace;
      candidate: CandidateSnapshot;
      context: TaskContextPackage;
      role: ClaudeStepRole;
    },
  ): BuilderReviewerState {
    const at = now(),
      noun = claudeStepNoun[input.role],
      detail =
        input.role === "reviewer"
          ? "Waiting for Claude Code. Open the review in Claude Code, which starts in Plan in a read-only copy of the build, paste the instructions Topsl copies, and after Claude Code exits, hand back Claude's final reply."
          : `Waiting for Claude Code. Open the ${noun} in Claude Code in the project folder, paste the instructions Topsl copies, and after Claude Code exits, hand back Claude's final reply. Until then no other Topsl writer starts in this folder.`,
      step: ClaudeStep = {
        id: input.attempt.id,
        projectId: state.projectId,
        workflowId: state.id,
        attemptId: input.attempt.id,
        taskId: input.task.id,
        role: input.role,
        installationId: input.installation.id,
        candidateId: input.candidate.id,
        candidateRevision: input.candidate.revision,
        specificationId: state.specificationId,
        contextPackageId: input.context.id,
        instructionsHash: input.context.contentHash,
        workspaceId: input.workspace.id,
        folder: input.workspace.root,
        state: "waiting",
        opens: [],
        replyId: null,
        replySource: null,
        stoppedAt: null,
        detail: "Waiting for the owner to open Claude Code.",
        createdAt: at,
        updatedAt: at,
      };
    return this.repository.store.transaction(() => {
      this.repository.store.save("claude-step", step, "claude-step.prepared");
      return this.save(
        state,
        {
          activeAttemptId: input.attempt.id,
          stage: stepStage[input.role],
          detail,
        },
        "running",
      );
    });
  }
  /** The workflow's step with this id, in this project. */
  private step(projectId: string, workflowId: string, stepId: string) {
    const step = this.repository.store.get<ClaudeStep>("claude-step", stepId);
    if (!step || step.projectId !== projectId || step.workflowId !== workflowId)
      throw new Error(
        "This Claude Code step belongs to another workflow or no longer exists.",
      );
    return step;
  }
  /** The step the workflow waits on now, or an error saying why there is none. */
  claudeStep(projectId: string, workflowId: string, stepId: string) {
    const step = this.step(projectId, workflowId, stepId),
      state = this.state(workflowId);
    if (
      step.state !== "waiting" ||
      state.activeAttemptId !== step.attemptId ||
      state.stage !== stepStage[step.role]
    )
      throw new Error(
        "This Claude Code step has ended, or the workflow no longer waits on it.",
      );
    return {
      step,
      workspace: this.repository.require<Workspace>(
        "workspace",
        step.workspaceId,
      ),
      instructions: this.repository.require<TaskContextPackage>(
        "task-context-package",
        step.contextPackageId,
      ).content,
    };
  }
  /** The step's latest session that opened, whose transcript a hand-back reads. */
  claudeStepSession(
    projectId: string,
    workflowId: string,
    stepId: string,
  ): { step: ClaudeStep; open: ClaudeStepOpen } {
    const step = this.step(projectId, workflowId, stepId);
    if (step.state !== "waiting")
      throw new Error("This Claude Code step has already ended.");
    const open = latestOpened(step);
    if (!open)
      throw new Error(
        "Open Claude Code for this step in Topsl's terminal before handing back its reply.",
      );
    return { step, open };
  }
  /** Says why Topsl took no reply from the transcript. The step keeps waiting. */
  claudeStepUnread(stepId: string, reason: string): string {
    const detail = `Topsl took no reply from the session's transcript: ${reason} Paste Claude's final reply instead, or open Claude Code again.`;
    this.repository.store.transaction(() => {
      const step = this.repository.require<ClaudeStep>("claude-step", stepId);
      if (step.state !== "waiting")
        throw new Error("This Claude Code step has already ended.");
      this.repository.store.save(
        "claude-step",
        { ...step, detail, updatedAt: now() },
        "claude-step.transcript-unread",
      );
    });
    this.changed();
    return detail;
  }
  /** Records an opening before Claude Code starts, so its session id is kept either way. */
  claudeStepOpening(
    stepId: string,
    open: Omit<ClaudeStepOpen, "terminalId" | "state" | "error">,
  ): void {
    this.repository.store.transaction(() => {
      const step = this.repository.require<ClaudeStep>("claude-step", stepId);
      if (step.state !== "waiting")
        throw new Error("This Claude Code step has ended.");
      this.repository.store.save(
        "claude-step",
        {
          ...step,
          opens: [
            ...step.opens,
            { ...open, terminalId: null, state: "requested", error: null },
          ],
          updatedAt: now(),
        },
        "claude-step.open-requested",
      );
    });
    this.changed();
  }
  /** Records how an opening went: the terminal Topsl opened, or why it did not. */
  claudeStepOpened(
    stepId: string,
    sessionId: string,
    result: { terminalId: string } | { error: string },
  ): void {
    this.repository.store.transaction(() => {
      const step = this.repository.require<ClaudeStep>("claude-step", stepId),
        first = !step.opens.some((open) => open.state === "opened");
      this.repository.store.save(
        "claude-step",
        {
          ...step,
          opens: step.opens.map((open) =>
            open.sessionId !== sessionId
              ? open
              : "terminalId" in result
                ? { ...open, terminalId: result.terminalId, state: "opened" }
                : { ...open, state: "failed", error: result.error },
          ),
          detail:
            "terminalId" in result
              ? "Claude Code is open in Topsl's terminal. After it exits, confirm it stopped and hand back Claude's final reply."
              : `Claude Code did not open: ${result.error}`,
          updatedAt: now(),
        },
        "claude-step.opened",
      );
      // Topsl copied the instructions; whether the owner pasted them is not observed.
      if ("terminalId" in result && first)
        recordContextDelivery(
          this.repository.store,
          this.repository.require<TaskContextPackage>(
            "task-context-package",
            step.contextPackageId,
          ),
          step.attemptId,
          "unknown",
        );
    });
    this.changed();
  }
  /** Ends a step that Topsl took no reply from, and the attempt it is. */
  private async endClaudeStep(
    step: ClaudeStep,
    outcome: "stale" | "cancelled",
    detail: string,
    stopped: boolean,
    reply: ClaudeStepReply | null = null,
  ): Promise<void> {
    this.repository.store.transaction(() => {
      this.repository.store.save(
        "claude-step",
        {
          ...step,
          state: outcome,
          replyId: reply?.id ?? null,
          replySource: reply?.source ?? null,
          stoppedAt: stopped ? now() : null,
          detail,
          updatedAt: now(),
        },
        `claude-step.${outcome}`,
      );
      const attempt = this.repository.require<ExecutionAttempt>(
        "attempt",
        step.attemptId,
      );
      if (attempt.state === "prepared")
        this.repository.transitionAttempt(
          attempt.id,
          attempt.revision,
          "interrupted",
          { error: detail },
        );
      const task = this.repository.require<Task>("task", step.taskId);
      if (task.state === "active")
        this.repository.transitionTask(
          task.id,
          task.revision,
          outcome === "cancelled" ? "cancelled" : "blocked",
          detail,
        );
    });
    if (step.role === "reviewer") await this.removeStepCopy(step);
  }
  /** Removes a review step's copy of the build, which only Topsl created. */
  private async removeStepCopy(step: ClaudeStep): Promise<void> {
    const copy = this.reviews.get(step.workflowId);
    if (copy && path.resolve(copy.root) === path.resolve(step.folder)) {
      await copy.cleanup();
      this.reviews.delete(step.workflowId);
    } else if (
      // After a restart only the record names it.
      path.dirname(path.resolve(step.folder)) === path.resolve(os.tmpdir()) &&
      path.basename(step.folder).startsWith("topsl-candidate-")
    )
      await removeMaterializedCopy(step.folder);
  }
  /**
   * The owner hands back Claude's final reply, having confirmed that Claude
   * Code stopped: pasted, or read from the latest session's transcript. A
   * review's reply must name this build, and each finding a text line in it;
   * otherwise the step keeps waiting and says why. A reply that comes after
   * the specification or the build changed, or after the workflow moved on,
   * is kept as evidence only.
   */
  async returnClaudeStep(input: {
    projectId: string;
    workflowId: string;
    stepId: string;
    reply: string;
    source: ClaudeStepReplySource;
    /** The transcript a reply from one was read from. */
    transcript?: ClaudeTranscriptSource;
  }): Promise<{
    outcome: ClaudeStepReply["outcome"];
    detail: string;
    state: BuilderReviewerState;
  }> {
    const id = input.workflowId;
    if (this.locks.has(id))
      throw new Error("This workflow action is already pending.");
    this.locks.add(id);
    try {
      const step = this.step(input.projectId, id, input.stepId);
      if (step.state !== "waiting")
        throw new Error("This Claude Code step has already ended.");
      // Each stage records the session it ran in.
      const latest = latestOpened(step);
      if (!latest)
        throw new Error(
          "Open Claude Code for this step in Topsl's terminal before handing back its reply.",
        );
      if ((input.source === "claude-transcript") !== !!input.transcript)
        throw new Error(
          "A reply from the transcript comes with the transcript Topsl read, and only then.",
        );
      if (input.transcript && input.transcript.sessionId !== latest.sessionId)
        throw new Error(
          "Claude Code opened again for this step while Topsl read the transcript. Hand the reply back again.",
        );
      let state = this.state(id);
      const record = (
        outcome: ClaudeStepReply["outcome"],
        detail: string,
      ): ClaudeStepReply => {
        const reply: ClaudeStepReply = {
          id: uid(),
          projectId: input.projectId,
          workflowId: id,
          stepId: step.id,
          source: input.source,
          ...(input.transcript ? { transcript: input.transcript } : {}),
          text: input.reply,
          hash: hash(input.reply),
          outcome,
          detail,
          receivedAt: now(),
        };
        this.repository.store.immutable("claude-step-reply", reply);
        return reply;
      };
      if (
        state.activeAttemptId !== step.attemptId ||
        state.stage !== stepStage[step.role]
      ) {
        const detail = `The workflow no longer waits on this step (${state.stage}): ${state.detail} The reply is kept as evidence and was not used.`;
        await this.endClaudeStep(
          step,
          "stale",
          detail,
          true,
          record("stale", detail),
        );
        this.changed();
        return { outcome: "stale", detail, state };
      }
      const head =
        new RevisionRepository(this.repository.store).head(
          state.projectId,
          `workflow-specification:${id}`,
        )?.revisionId ?? state.specificationId;
      let changed =
        head !== step.specificationId
          ? `The specification changed during this Claude Code ${claudeStepNoun[step.role]}.`
          : null;
      if (!changed && step.role === "reviewer")
        try {
          await assertCandidateCurrent(this.candidate(step.candidateId));
        } catch (error) {
          changed = `The project folder no longer matches the build under review: ${safeError(error)}`;
        }
      if (changed) {
        const detail = `${changed} Claude's reply is kept as evidence and was not used. Restart the workflow to continue.`;
        await this.endClaudeStep(
          step,
          "stale",
          detail,
          true,
          record("stale", detail),
        );
        state = this.save(
          state,
          { stage: "blocked", activeAttemptId: null, detail },
          "blocked",
        );
        return { outcome: "stale", detail, state };
      }
      const problem =
        step.role === "reviewer"
          ? reviewReplyProblem(
              input.reply,
              this.candidate(step.candidateId),
              this.repository.store,
            )
          : null;
      if (problem) {
        const detail = `Topsl did not take this reply: ${problem} The step keeps waiting: open Claude Code again, or hand back another reply.`;
        this.repository.store.transaction(() => {
          record("invalid", detail);
          this.repository.store.save(
            "claude-step",
            { ...step, detail, updatedAt: now() },
            "claude-step.reply-invalid",
          );
        });
        this.changed();
        return { outcome: "invalid", detail, state };
      }
      const detail =
        step.role === "reviewer"
          ? "Topsl took Claude's review. It still checks that the copy is unchanged before reading the findings."
          : `Topsl took Claude's reply and captures the project folder as the ${claudeStepNoun[step.role]}'s result.`;
      this.repository.store.transaction(() => {
        // Cancelling takes no lock, so check nothing moved meanwhile.
        const latest = this.state(id);
        if (
          this.repository.require<ClaudeStep>("claude-step", step.id).state !==
            "waiting" ||
          latest.activeAttemptId !== step.attemptId ||
          latest.stage !== stepStage[step.role]
        )
          throw new Error(
            "The workflow changed while Topsl was taking this reply, so it took nothing.",
          );
        const reply = record("taken", detail);
        this.repository.store.save(
          "claude-step",
          {
            ...step,
            state: "returned",
            replyId: reply.id,
            replySource: reply.source,
            stoppedAt: now(),
            detail,
            updatedAt: now(),
          },
          "claude-step.returned",
        );
        // The step is the stage's turn, which ends with the owner's reply.
        let attempt = this.repository.require<ExecutionAttempt>(
          "attempt",
          step.attemptId,
        );
        attempt = this.repository.transitionAttempt(
          attempt.id,
          attempt.revision,
          "starting",
        );
        this.repository.transitionAttempt(
          attempt.id,
          attempt.revision,
          "completed",
        );
      });
      return {
        outcome: "taken",
        detail,
        state: await this.advanceLocked(id),
      };
    } finally {
      this.locks.delete(id);
    }
  }
  /** Native approved capture of stopped output. No model attempt is created or
   * replayed; the resulting manifest still requires new review/check evidence. */
  async captureReviewedOutputs(
    id: string,
    expectedRevision: number,
    planId: string,
    digest: string,
  ): Promise<BuilderReviewerState> {
    if (this.locks.has(id))
      throw new Error("A workflow operation is already pending.");
    this.locks.add(id);
    let consumed = false;
    try {
      this.expect(id, expectedRevision);
      const state = this.state(id),
        candidate = this.candidate(state.candidateId),
        plan = this.repository.require<CandidateReviewPlan>(
          "candidate-review-plan",
          planId,
        ),
        project = this.repository.require<Project>("project", state.projectId),
        workspace = this.repository.require<Workspace>(
          "workspace",
          state.workspaceId,
        );
      if (
        !project.trusted ||
        !workspace.trustRevision ||
        workspace.availability !== "available" ||
        workspace.canonicalRoot !== candidate.sourceRoot
      )
        throw new Error(
          "Output capture requires the same trusted available workspace.",
        );
      if (
        plan.projectId !== state.projectId ||
        plan.workflowId !== id ||
        plan.candidateId !== candidate.id ||
        plan.candidateRevision !== candidate.revision ||
        plan.workflowRevision !== expectedRevision ||
        !plan.capturePaths?.length
      )
        throw new Error(
          "Capture plan does not match the current workflow/candidate revision.",
        );
      if (
        ![
          "ready-review",
          "blocked",
          "checking",
          "awaiting-acceptance",
        ].includes(state.stage) ||
        state.activeAttemptId
      )
        throw new Error(
          "Stop and reconcile the current attempt before recapturing proposed outputs.",
        );
      const assertInactive = () => {
        if (
          this.repository.store.db
            .prepare(
              "SELECT 1 FROM workspace_leases WHERE filesystem_identity=? AND state!='released'",
            )
            .get(workspace.filesystemIdentity)
        )
          throw new Error(
            "Active or uncertain ownership blocks output recapture.",
          );
        if (
          [
            ...this.repository.store.iterate<{
              workflowId: string;
              state: string;
            }>("check-execution", { projectId: state.projectId }),
          ].some(
            (run) =>
              run.workflowId === id &&
              [
                "prepared",
                "dispatching",
                "running",
                "stopping",
                "uncertain",
              ].includes(run.state),
          )
        )
          throw new Error("Active or uncertain checks block output recapture.");
      };
      assertInactive();
      const builderTask = this.repository.require<Task>(
        "task",
        state.builderTaskId,
      );
      if (!["submitted", "reviewing", "verifying"].includes(builderTask.state))
        throw new Error(
          "Recapture requires a stopped submitted builder task; restart the workflow explicitly for other task states.",
        );
      await assertCandidateCurrent(candidate);
      this.expect(id, expectedRevision);
      assertInactive();
      this.repository.store.transaction(() =>
        consumeCandidateCapturePlan(
          this.repository.store,
          state.projectId,
          planId,
          digest,
        ),
      );
      consumed = true;
      const captures = plan.capturePaths.map((entry) => entry.path),
        selection = {
          selectedPaths: candidate.git
            ? state.selection.selectedPaths
            : [
                ...new Set([
                  ...(state.selection.selectedPaths ??
                    candidate.files.map((file) => file.path)),
                  ...captures,
                ]),
              ],
          approvedUntracked: [
            ...new Set([
              ...(state.selection.approvedUntracked ?? []),
              ...captures,
            ]),
          ],
        };
      const replacement = await captureCandidate(this.repository.store, {
        root: workspace.canonicalRoot,
        projectId: state.projectId,
        workflowId: id,
        authorAttemptId: candidate.authorAttemptId,
        ...selection,
        baseCandidateId: state.baselineId,
        expectedOutputHashes: Object.fromEntries(
          plan.capturePaths.map((entry) => [entry.path, entry.hash]),
        ),
      });
      this.expect(id, expectedRevision);
      assertInactive();
      return this.repository.store.transaction(() => {
        this.artifact(replacement, state.builderTaskId);
        for (const verification of this.repository
          .all<import("../domain/workflow").Verification>("verification", {
            projectId: state.projectId,
          })
          .filter(
            (record) =>
              record.candidateId === candidate.id && !record.invalidatedAt,
          ))
          this.repository.store.put("verification", {
            ...verification,
            invalidatedAt: now(),
            revision: verification.revision + 1,
            updatedAt: now(),
          });
        const superseded = [state.reviewerTaskId, state.checkTaskId].filter(
          (value): value is string => !!value,
        );
        for (const taskId of superseded) {
          const task = this.repository.require<Task>("task", taskId);
          if (task.state !== "cancelled")
            this.repository.transitionTask(
              task.id,
              task.revision,
              "cancelled",
              "Superseded by explicit output scope capture; prior evidence remains historical.",
              task.candidateId ?? candidate.id,
            );
          this.repository.store.immutable("task-supersession", {
            id: task.id,
            projectId: state.projectId,
            workflowId: id,
            replacementTaskId: builderTask.id,
            candidateId: task.candidateId ?? candidate.id,
            reason: "Explicit native-approved scope amendment",
            createdAt: now(),
          });
        }
        this.repository.store.put("task", {
          ...builderTask,
          inputRefs: [...new Set([...builderTask.inputRefs, candidate.id])],
        });
        this.repository.transitionTask(
          builderTask.id,
          builderTask.revision,
          builderTask.state,
          "Explicit native-approved output scope amendment; the stopped builder's new manifest requires fresh review/checks.",
          replacement.id,
        );
        this.repository.store.immutable("candidate-scope-amendment", {
          id: planId,
          projectId: state.projectId,
          workflowId: id,
          priorCandidateId: candidate.id,
          candidateId: replacement.id,
          paths: plan.capturePaths,
          priorTaskRevision: builderTask.revision,
          priorInputRefs: builderTask.inputRefs,
          createdAt: now(),
          source: "native-approved-capture",
        });
        this.repository.store.immutable("candidate-capture-result", {
          id: planId,
          projectId: state.projectId,
          state: "complete",
          candidateId: replacement.id,
          createdAt: now(),
        });
        return this.save(
          state,
          {
            selection,
            candidateId: replacement.id,
            reviewerTaskId: null,
            checkTaskId: null,
            reviewedCandidateId: null,
            reviewArtifactId: null,
            findings: [],
            supersededTaskIds: [
              ...new Set([...state.supersededTaskIds, ...superseded]),
            ],
            stage: "ready-review",
            detail:
              "Approved output paths captured with exact reviewed hashes. Review the new resulting manifest, then explicitly advance; prior review/check/acceptance evidence does not apply.",
          },
          "running",
        );
      });
    } catch (error) {
      if (consumed)
        this.repository.store.immutable("candidate-capture-result", {
          id: planId,
          projectId: this.state(id).projectId,
          state: "failed",
          detail: safeError(error),
          createdAt: now(),
        });
      throw error;
    } finally {
      this.locks.delete(id);
    }
  }
  private async completeBuild(
    state: BuilderReviewerState,
    attempt: ExecutionAttempt,
  ): Promise<BuilderReviewerState> {
    const workspace = this.repository.require<Workspace>(
      "workspace",
      state.workspaceId,
    );
    const candidate = await captureCandidate(this.repository.store, {
      root: workspace.canonicalRoot,
      projectId: state.projectId,
      workflowId: state.id,
      authorAttemptId: attempt.id,
      baseCandidateId: state.baselineId,
      ...state.selection,
    });
    this.artifact(candidate, state.builderTaskId);
    const task = this.repository.require<Task>("task", state.builderTaskId);
    this.repository.transitionTask(
      task.id,
      task.revision,
      "submitted",
      "Candidate captured; review and tests remain required.",
      candidate.id,
    );
    return this.save(state, {
      candidateId: candidate.id,
      activeAttemptId: null,
      reviewedCandidateId: null,
      reviewArtifactId: null,
      stage: "ready-review",
      detail:
        "Candidate frozen; the reviewer receives a fresh session and pinned bytes.",
    });
  }
  private async completeReview(
    state: BuilderReviewerState,
    attempt: ExecutionAttempt,
  ): Promise<BuilderReviewerState> {
    const candidate = this.candidate(state.candidateId),
      copy = this.reviews.get(state.id);
    const proof = this.repository.store.get<{
      id: string;
      candidateId: string;
      root: string;
      filesystemIdentity: string;
      state: string;
      detail: string;
    }>("review-snapshot-proof", attempt.id);
    try {
      if (
        !proof ||
        proof.candidateId !== candidate.id ||
        proof.state === "failed"
      )
        throw new Error(
          proof?.detail ??
            "Review snapshot proof is missing; review is unverified.",
        );
      if (proof.state !== "verified") {
        if (
          canonicalWorkspaceIdentity(proof.root).filesystemIdentity !==
          proof.filesystemIdentity
        )
          throw new Error("Review snapshot identity changed.");
        await assertMaterializedCandidate(candidate, proof.root, true);
        this.repository.store.put("review-snapshot-proof", {
          ...proof,
          state: "verified",
          checkedAt: now(),
          detail:
            "Exact pinned review file set validated after provider completion.",
        });
      }
    } catch (error) {
      this.repository.store.put("review-snapshot-proof", {
        ...(proof ?? { id: attempt.id, candidateId: candidate.id }),
        state: "failed",
        checkedAt: now(),
        detail: safeError(error),
      });
      return this.save(
        state,
        {
          stage: "blocked",
          activeAttemptId: null,
          detail: `Review proof failed: ${safeError(error)}`,
        },
        "blocked",
      );
    } finally {
      const step = this.repository.store.get<ClaudeStep>(
        "claude-step",
        attempt.id,
      );
      if (step) await this.removeStepCopy(step);
      else if (copy) {
        await copy.cleanup();
        this.reviews.delete(state.id);
      }
    }
    await assertCandidateCurrent(candidate);
    let reply: unknown;
    try {
      reply = JSON.parse(
        this.result(attempt)
          .trim()
          .replace(/^```(?:json)?\s*|\s*```$/g, ""),
      );
    } catch {
      reply = undefined;
    }
    const parsed = reviewSchema.safeParse(reply);
    if (!parsed.success)
      return this.save(
        state,
        {
          stage: "blocked",
          activeAttemptId: null,
          // Zod's wording names the field and what it expected, never the
          // reviewer's own text.
          detail: `Reviewer output did not match the required finding schema (${
            reply === undefined
              ? "its final message is not JSON"
              : parsed.error.issues
                  .slice(0, 3)
                  .map(
                    (issue) =>
                      `${issue.path.join(".") || "the reply"}: ${issue.message}`,
                  )
                  .join("; ")
          }); review is unverified and cannot be accepted.`,
        },
        "blocked",
      );
    const result = parsed.data;
    if (
      result.candidateRevision !== candidate.revision ||
      result.findings.some(
        (f) =>
          !candidateHasTextLine(
            candidate,
            f.file,
            f.line,
            this.repository.store,
          ),
      )
    )
      return this.save(
        state,
        {
          stage: "blocked",
          activeAttemptId: null,
          detail:
            "Review referenced a different candidate, unknown/binary file or nonexistent text line; no findings were promoted to acceptance evidence.",
        },
        "blocked",
      );
    const findingIds: string[] = [];
    for (const value of result.findings) {
      const finding: WorkflowFinding = {
        ...value,
        id: uid(),
        projectId: state.projectId,
        workflowId: state.id,
        candidateId: candidate.id,
        candidateRevision: candidate.revision,
        reviewAttemptId: attempt.id,
        disposition: "open",
        resolvedByCandidateId: null,
      };
      this.repository.store.immutable("workflow-finding", finding);
      findingIds.push(finding.id);
    }
    const at = now(),
      reviewId = uid(),
      text = stable(result),
      // A Claude Code step's review is the reply the owner handed back, not
      // a provider's own report, and is labelled by where that reply came from.
      step = this.repository.store.get<ClaudeStep>("claude-step", attempt.id);
    this.repository.store.immutable("protected-review", {
      id: reviewId,
      projectId: state.projectId,
      text,
      createdAt: at,
    });
    this.repository.artifact({
      id: reviewId,
      projectId: state.projectId,
      taskId: state.reviewerTaskId,
      attemptId: attempt.id,
      conversationId: null,
      kind: "review",
      contentHash: hash(text),
      targetRevision: candidate.revision,
      protectedContentRef: reviewId,
      confidentiality: "project",
      provenance: step
        ? step.replySource === "claude-transcript"
          ? {
              level: "source-observation",
              source: "claude-code-terminal:transcript",
              observedAt: at,
              detail:
                "Claude Code review in Topsl's terminal under the owner's control, in Plan in a read-only copy of the build. Topsl read Claude's final reply from the session's transcript. Independent filesystem isolation is not enforced.",
            }
          : {
              level: "user-confirmation",
              source: "claude-code-terminal:owner-paste",
              observedAt: at,
              detail:
                "Claude Code review in Topsl's terminal under the owner's control, in Plan in a read-only copy of the build. The owner pasted Claude's final reply. Independent filesystem isolation is not enforced.",
            }
        : {
            level: "provider-ack",
            source: attempt.provider,
            observedAt: at,
            detail:
              "Fresh-session review of pinned inputs; independent filesystem isolation is not enforced.",
          },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
    const task = this.repository.require<Task>("task", state.reviewerTaskId!);
    this.repository.transitionTask(
      task.id,
      task.revision,
      findingIds.length ? "changes-requested" : "submitted",
      result.summary,
      candidate.id,
    );
    if (!findingIds.length)
      for (const id of state.findings) {
        const finding = this.repository.require<WorkflowFinding>(
          "workflow-finding",
          id,
        );
        recordFindingDecision(this.repository.store, finding, {
          candidateId: candidate.id,
          decision: "resolved",
          rationale: `Subsequent review ${reviewId} reported no substantiated findings on candidate ${candidate.id}.`,
          actor: "subsequent-review",
          expectedDecisionId:
            latestFindingDecision(this.repository.store, finding)?.id ?? null,
        });
      }
    state = this.save(state, {
      activeAttemptId: null,
      findings: [...state.findings, ...findingIds],
      reviewedCandidateId: candidate.id,
      reviewArtifactId: reviewId,
      stage: findingIds.length ? "ready-repair" : "checking",
      detail: findingIds.length
        ? `${findingIds.length} findings await a decision. Accept a substantiated finding, reject it with a rationale, or explicitly start a bounded repair.`
        : "No substantiated findings. Required checks have not yet run.",
    });
    if (!findingIds.length) state = this.beginChecks(state, task.id);
    return state;
  }
  private beginChecks(
    state: BuilderReviewerState,
    reviewerTaskId: string,
  ): BuilderReviewerState {
    let check = this.repository.createTask({
      projectId: state.projectId,
      workflowId: state.id,
      workspaceId: state.workspaceId,
      title: "Verify pinned candidate",
      role: "tester",
      dependencies: [reviewerTaskId],
      inputRefs: [state.candidateId],
      acceptanceCriteria: state.checks.map((c) => c.label),
      requiredCapabilities: [],
    });
    check = this.repository.transitionTask(check.id, check.revision, "ready");
    check = this.repository.transitionTask(check.id, check.revision, "active");
    return this.save(
      state,
      { checkTaskId: check.id, stage: "checking" },
      "running",
    );
  }
  decideFinding(input: {
    id: string;
    expectedRevision: number;
    findingId: string;
    candidateId: string;
    decision: "accepted" | "rejected";
    rationale: string;
    expectedDecisionId: string | null;
  }): BuilderReviewerState {
    return this.repository.store.transaction(() => {
      this.expect(input.id, input.expectedRevision);
      let state = this.state(input.id);
      if (
        state.activeAttemptId ||
        !["ready-repair", "blocked"].includes(state.stage) ||
        state.candidateId !== input.candidateId ||
        state.reviewedCandidateId !== state.candidateId ||
        !state.reviewArtifactId ||
        !state.reviewerTaskId ||
        !state.findings.includes(input.findingId)
      )
        throw new Error(
          "A current, completed candidate review is required to decide a finding.",
        );
      const finding = this.repository.require<WorkflowFinding>(
        "workflow-finding",
        input.findingId,
      );
      if (
        finding.projectId !== state.projectId ||
        finding.workflowId !== state.id ||
        finding.candidateId !== state.candidateId
      )
        throw new Error(
          "Finding belongs to a different workflow or candidate.",
        );
      recordFindingDecision(this.repository.store, finding, {
        ...input,
        actor: "local-user",
      });
      const unresolved = state.findings.some((id) =>
        findingBlocks(
          this.repository.store,
          this.repository.require<WorkflowFinding>("workflow-finding", id),
        ),
      );
      state = this.save(
        state,
        {
          stage: unresolved ? "ready-repair" : "checking",
          detail: unresolved
            ? "Finding decision recorded; unresolved findings remain. A bounded repair requires the next explicit action."
            : "All findings were adjudicated with recorded rationales. Required checks remain outstanding.",
        },
        "running",
      );
      if (!unresolved) {
        let task = this.repository.require<Task>("task", state.reviewerTaskId!);
        if (task.state === "changes-requested") {
          task = this.repository.transitionTask(
            task.id,
            task.revision,
            "ready",
            "User adjudication of the recorded review.",
          );
          task = this.repository.transitionTask(
            task.id,
            task.revision,
            "active",
            "Local user reviewed the findings; no provider was dispatched.",
          );
          this.repository.transitionTask(
            task.id,
            task.revision,
            "submitted",
            "User rejected the findings with recorded rationales.",
            state.candidateId,
          );
        }
        state = this.beginChecks(state, task.id);
      }
      return state;
    });
  }
  async previewChecks(
    id: string,
    expectedRevision: number,
  ): Promise<CheckPlan[]> {
    this.expect(id, expectedRevision);
    const state = this.state(id);
    if (state.stage !== "checking" || !state.checkTaskId)
      throw new Error(
        "Current reviewed candidate is required before running checks.",
      );
    const candidate = this.candidate(state.candidateId);
    return Promise.all(
      state.checks.map((check) =>
        previewCheck(
          this.repository,
          state.id,
          state.checkTaskId!,
          candidate,
          check,
        ),
      ),
    );
  }
  async runCheck(
    planId: string,
    digest: string,
  ): Promise<BuilderReviewerState> {
    const plan = this.repository.require<CheckPlan>(
        "workflow-check-plan",
        planId,
      ),
      state = this.state(plan.workflowId);
    if (state.stage !== "checking" || state.candidateId !== plan.candidateId)
      throw new Error("Check plan targets a stale workflow candidate.");
    await executeCheck(this.repository, plan, digest);
    const latest = this.state(state.id);
    if (
      latest.stage !== "checking" ||
      latest.candidateId !== state.candidateId ||
      latest.checkTaskId !== state.checkTaskId
    )
      return latest;
    const checks = this.currentChecks(state),
      passed = state.checks.every((c) => checks.get(c.id)?.result === "passed");
    if (passed) {
      const task = this.repository.require<Task>("task", state.checkTaskId!);
      this.repository.transitionTask(
        task.id,
        task.revision,
        "submitted",
        "Required checks passed on this candidate.",
        state.candidateId,
      );
    }
    return this.save(
      state,
      {
        stage: passed ? "awaiting-acceptance" : "checking",
        detail: passed
          ? "Review and required checks are current. Explicit user acceptance remains required."
          : "Required checks are incomplete or failing; acceptance is blocked.",
      },
      passed ? "awaiting-acceptance" : undefined,
    );
  }
  private currentChecks(state: BuilderReviewerState) {
    const candidate = this.candidate(state.candidateId),
      checks = this.repository
        .all<import("../domain/workflow").Verification>("verification", {
          projectId: state.projectId,
        })
        .filter(
          (v) =>
            v.taskId === state.checkTaskId &&
            v.candidateId === state.candidateId &&
            v.targetRevision === candidate.revision &&
            !v.invalidatedAt,
        );
    return new Map(checks.map((check) => [check.definition, check]));
  }
  acceptanceDigest(id: string): string {
    const state = this.state(id),
      workflow = this.repository.require<Workflow>("workflow", id);
    return hash(
      stable({
        workflowRevision: workflow.revision,
        state,
        findingDecisions: findingDecisions(
          this.repository.store,
          state.projectId,
          state.id,
        ),
        checks: [...this.currentChecks(state)].map(([id, check]) => [
          id,
          check.id,
          check.result,
          check.targetRevision,
        ]),
      }),
    );
  }
  async accept(
    id: string,
    expectedRevision: number,
    digest: string,
    by = "local-user",
  ): Promise<BuilderReviewerState> {
    const workflow = this.expect(id, expectedRevision),
      state = this.state(id),
      candidate = this.candidate(state.candidateId);
    if (
      state.stage !== "awaiting-acceptance" ||
      digest !== this.acceptanceDigest(id)
    )
      throw new Error(
        "Acceptance is stale or required checks have not passed.",
      );
    await assertCandidateCurrent(candidate);
    assertCandidateCoverage(candidate, this.repository.store);
    const latestSpecification = new RevisionRepository(
      this.repository.store,
    ).head(state.projectId, `workflow-specification:${id}`);
    if (latestSpecification?.revisionId !== state.specificationId)
      throw new Error(
        "A newer shared specification is available. Explicit restart and fresh review/check evidence are required before acceptance.",
      );
    const specification = this.repository.require<WorkflowSpecification>(
      "workflow-specification",
      state.specificationId,
    );
    if (
      workflow.specificationRevision !== specification.revision ||
      state.reviewedCandidateId !== candidate.id ||
      !state.reviewArtifactId ||
      state.findings.some((id) =>
        findingBlocks(
          this.repository.store,
          this.repository.require<WorkflowFinding>("workflow-finding", id),
        ),
      )
    )
      throw new Error(
        "Current specification and resolved revision-bound review are required.",
      );
    const checks = this.currentChecks(state);
    if (
      !state.checks.every(
        (definition) =>
          checks.get(definition.id)?.result === "passed" &&
          checks.get(definition.id)?.evidenceArtifactId,
      )
    )
      throw new Error(
        "Current passing evidence is required for every defined check.",
      );
    const taskIds = [
      state.builderTaskId,
      state.reviewerTaskId!,
      state.checkTaskId!,
    ];
    this.repository.store.transaction(() => {
      this.expect(id, expectedRevision);
      for (const taskId of taskIds) {
        let task = this.repository.require<Task>("task", taskId);
        if (task.state === "submitted")
          task = this.repository.transitionTask(
            taskId,
            task.revision,
            "verifying",
            "User is accepting the reviewed and verified final candidate.",
            candidate.id,
          );
        for (const check of checks.values())
          if (check.taskId !== taskId)
            this.repository.verification({
              ...check,
              id: uid(),
              taskId,
              createdAt: now(),
              updatedAt: now(),
            });
        this.repository.transitionTask(
          taskId,
          task.revision,
          "accepted",
          "Explicit user acceptance with current candidate evidence.",
          candidate.id,
        );
      }
      this.repository.transitionWorkflow(id, expectedRevision, "accepted", {
        by,
        at: now(),
        digest,
        targetRevision: candidate.revision,
      });
      this.repository.store.save("builder-reviewer", {
        ...state,
        stage: "accepted",
        detail:
          "Explicitly accepted with candidate-specific review and checks.",
        updatedAt: now(),
      });
    });
    this.changed();
    return this.state(id);
  }
  async cancel(
    id: string,
    expectedRevision: number,
    confirmation: { claudeCodeStopped?: boolean } = {},
  ): Promise<BuilderReviewerState> {
    this.expect(id, expectedRevision);
    const state = this.state(id),
      step = state.activeAttemptId
        ? this.repository.store.get<ClaudeStep>(
            "claude-step",
            state.activeAttemptId,
          )
        : undefined,
      waiting = step?.state === "waiting" ? step : undefined;
    // An opened build or repair may still be writing, so its hold on the
    // folder ends only with the owner's word.
    if (
      waiting &&
      waiting.role !== "reviewer" &&
      waiting.opens.length &&
      !confirmation.claudeCodeStopped
    )
      throw new Error(
        "Claude Code may still be changing the project folder. Confirm that it has stopped to cancel this workflow.",
      );
    const cancelled = this.save(
      state,
      {
        stage: "cancelled",
        detail:
          "Cancellation requested. Late provider evidence remains attributed; it cannot accept this workflow.",
      },
      "cancelled",
    );
    if (waiting)
      await this.endClaudeStep(
        waiting,
        "cancelled",
        "The workflow was cancelled during this Claude Code step.",
        !!confirmation.claudeCodeStopped,
      );
    else if (state.activeAttemptId && this.driver.interrupt)
      await this.driver.interrupt(
        this.repository.require<ExecutionAttempt>(
          "attempt",
          state.activeAttemptId,
        ),
      );
    if (state.activeAttemptId)
      this.contextServer?.revokeAttempt(state.activeAttemptId);
    return cancelled;
  }
  publishSpecification(
    id: string,
    expectedRevision: number,
    input: {
      objective: string;
      acceptanceCriteria: string[];
      interfaces: string[];
    },
  ): WorkflowSpecification {
    this.expect(id, expectedRevision);
    const state = this.state(id);
    if (["accepted", "cancelled"].includes(state.stage))
      throw new Error(
        "A finished workflow requires a new explicitly reviewed workflow.",
      );
    const specification = this.repository.store.transaction(() => {
      this.expect(id, expectedRevision);
      const specification = createSpecification(this.repository.store, {
        workflowId: id,
        projectId: state.projectId,
        ...input,
      });
      this.save(state, {
        detail: `New specification ${specification.revision.slice(0, 10)} available. Current attempts retain their original inputs; explicitly restart before accepting under the new requirements.`,
      });
      this.repository.store.immutable("workflow-context-update", {
        id: uid(),
        projectId: state.projectId,
        workflowId: id,
        priorSpecificationId: state.specificationId,
        specificationId: specification.id,
        action: "published",
        createdAt: now(),
      });
      return specification;
    });
    return specification;
  }
  async restartForSpecification(
    id: string,
    expectedRevision: number,
    specificationId: string,
  ): Promise<BuilderReviewerState> {
    if (this.locks.has(id))
      throw new Error("A workflow operation is already pending.");
    this.locks.add(id);
    try {
      this.expect(id, expectedRevision);
      let state = this.state(id);
      if (["accepted", "cancelled"].includes(state.stage))
        throw new Error("A finished workflow cannot be restarted.");
      const specification = this.repository.require<WorkflowSpecification>(
        "workflow-specification",
        specificationId,
      );
      const revisions = new RevisionRepository(this.repository.store),
        head = revisions.head(state.projectId, `workflow-specification:${id}`);
      if (
        specification.projectId !== state.projectId ||
        specification.workflowId !== id ||
        head?.revisionId !== specification.id
      )
        throw new Error(
          "Restart requires the current specification for this exact workflow.",
        );
      if (state.activeAttemptId) {
        let attempt = this.repository.require<ExecutionAttempt>(
          "attempt",
          state.activeAttemptId,
        );
        if (
          this.repository.store.get<ClaudeStep>("claude-step", attempt.id)
            ?.state === "waiting"
        )
          throw new Error(
            "Hand back this Claude Code step's reply, or cancel the workflow, before restarting it.",
          );
        if (attempt.state === "uncertain")
          throw new Error(
            "Reconcile the uncertain attempt before any replacement; no work was replayed.",
          );
        if (
          ["prepared", "starting", "running", "awaiting-approval"].includes(
            attempt.state,
          )
        ) {
          if (!this.driver.interrupt)
            throw new Error(
              "This provider has no supported interruption route; stop and reconcile the attempt before restart.",
            );
          this.repository.store.immutable("workflow-context-update", {
            id: uid(),
            projectId: state.projectId,
            workflowId: id,
            priorAttemptId: attempt.id,
            specificationId,
            action: "interrupt-requested",
            createdAt: now(),
          });
          await this.driver.interrupt(attempt);
          attempt = this.repository.require<ExecutionAttempt>(
            "attempt",
            attempt.id,
          );
          if (!["interrupted", "failed", "completed"].includes(attempt.state))
            return this.save(
              state,
              {
                stage: "blocked",
                detail:
                  "Interruption requested. Wait for supported stop evidence, then explicitly continue this restart; no replacement turn was dispatched.",
              },
              "blocked",
            );
        }
        const lease = this.repository.store.db
          .prepare(
            "SELECT state FROM workspace_leases WHERE attempt_id=? AND state!='released'",
          )
          .get(attempt.id);
        if (lease)
          throw new Error(
            "The prior writer is not confirmed stopped; reconcile ownership before restarting.",
          );
        this.contextServer?.revokeAttempt(attempt.id);
      }
      const workspace = this.repository.require<Workspace>(
        "workspace",
        state.workspaceId,
      );
      const baseline = await captureCandidate(this.repository.store, {
        root: workspace.canonicalRoot,
        projectId: state.projectId,
        workflowId: id,
        ...state.selection,
      });
      this.expect(id, expectedRevision);
      return this.repository.store.transaction(() => {
        state = this.state(id);
        this.artifact(baseline, null);
        const replacement = this.repository.createTask({
          projectId: state.projectId,
          workflowId: id,
          workspaceId: state.workspaceId,
          title: "Build updated shared specification",
          role: "implementer",
          acceptanceCriteria: specification.acceptanceCriteria,
          inputRefs: [specification.id, baseline.id],
          permittedOutputs: baseline.files.map((file) => file.path),
          requiredCapabilities: ["structured-turn", "workspace-write"],
        });
        const superseded = [
          state.builderTaskId,
          state.reviewerTaskId,
          state.checkTaskId,
        ]
          .filter((taskId): taskId is string => !!taskId)
          .filter((taskId) => !state.supersededTaskIds.includes(taskId));
        for (const taskId of superseded) {
          const task = this.repository.require<Task>("task", taskId);
          if (!["accepted", "cancelled"].includes(task.state))
            this.repository.transitionTask(
              taskId,
              task.revision,
              "cancelled",
              "Superseded after explicit specification restart; original attempt inputs remain historical.",
            );
          this.repository.store.immutable("task-supersession", {
            id: taskId,
            projectId: state.projectId,
            workflowId: id,
            replacementTaskId: replacement.id,
            candidateId: state.candidateId,
            reason: "Explicit shared specification restart",
            createdAt: now(),
          });
        }
        this.repository.transitionTask(
          replacement.id,
          replacement.revision,
          "ready",
        );
        this.repository.invalidateCandidate(
          state.candidateId,
          "Specification changed; the previous review and verification cannot accept the new requirements.",
        );
        const workflow = this.repository.require<Workflow>("workflow", id);
        this.repository.store.put("workflow", {
          ...workflow,
          specificationRevision: specification.revision,
          objective: specification.objective,
        });
        this.repository.store.immutable("workflow-context-update", {
          id: uid(),
          projectId: state.projectId,
          workflowId: id,
          priorSpecificationId: state.specificationId,
          specificationId,
          replacementTaskId: replacement.id,
          action: "restart-ready",
          createdAt: now(),
        });
        return this.save(
          state,
          {
            specificationId,
            builderTaskId: replacement.id,
            reviewerTaskId: null,
            checkTaskId: null,
            candidateId: baseline.id,
            baselineId: baseline.id,
            activeAttemptId: null,
            reviewedCandidateId: null,
            reviewArtifactId: null,
            findings: [],
            repairRound: 0,
            supersededTaskIds: [...state.supersededTaskIds, ...superseded],
            stage: "ready-build",
            detail:
              "Explicit restart prepared a new task with current shared requirements. Advance to dispatch; prior inputs, findings, and verification remain historical.",
          },
          ["ready", "blocked"].includes(workflow.state) ? "ready" : "running",
        );
      });
    } finally {
      this.locks.delete(id);
    }
  }
  async observe(id: string): Promise<BuilderReviewerState> {
    const state = this.state(id);
    if (["building", "repairing", "blocked", "cancelled"].includes(state.stage))
      return state;
    try {
      await assertCandidateCurrent(this.candidate(state.candidateId));
      return state;
    } catch (error) {
      this.repository.invalidateCandidate(state.candidateId, safeError(error));
      return this.save(state, {
        stage: "blocked",
        detail: `Current workspace changed after captured evidence: ${safeError(error)}`,
      });
    }
  }
  /** The Claude Code steps behind the build under acceptance, and where each reply came from. */
  claudeStepProvenance(id: string): ClaudeStepProvenance[] {
    const state = this.state(id);
    return claudeStepProvenance(
      state,
      [
        ...this.repository.store.iterate<ClaudeStep>("claude-step", {
          projectId: state.projectId,
        }),
      ],
      this.candidate(state.baselineId).createdAt,
    );
  }
  list(projectId: string): Array<
    BuilderReviewerState & {
      revision: number;
      candidateRevision: string;
      acceptanceDigest: string;
      checksStatus: unknown[];
      claudeStep: ClaudeStep | null;
      claudeSteps: ClaudeStepView[];
      claudeProvenance: ClaudeStepProvenance[];
    }
  > {
    const replies = new Map<string, ClaudeStepView["replies"]>(),
      steps = new Map<string, ClaudeStepView[]>();
    for (const reply of this.repository.store.iterate<ClaudeStepReply>(
      "claude-step-reply",
      { projectId },
    ))
      replies.set(reply.stepId, [
        ...(replies.get(reply.stepId) ?? []),
        {
          id: reply.id,
          source: reply.source,
          outcome: reply.outcome,
          detail: reply.detail,
          receivedAt: reply.receivedAt,
        },
      ]);
    for (const step of this.repository.store.iterate<ClaudeStep>(
      "claude-step",
      { projectId },
    ))
      steps.set(step.workflowId, [
        ...(steps.get(step.workflowId) ?? []),
        {
          ...step,
          replies: (replies.get(step.id) ?? []).sort((a, b) =>
            a.receivedAt.localeCompare(b.receivedAt),
          ),
        },
      ]);
    return this.repository
      .all<BuilderReviewerState>("builder-reviewer", { projectId })
      .map((state) => ({
        ...state,
        revision: this.repository.require<Workflow>("workflow", state.id)
          .revision,
        candidateRevision: this.candidate(state.candidateId).revision,
        acceptanceDigest: this.acceptanceDigest(state.id),
        checksStatus: [...this.currentChecks(state).values()],
        // The step the workflow waits on, if its stage is a Claude Code step.
        claudeStep:
          (state.activeAttemptId &&
            this.repository.store.get<ClaudeStep>(
              "claude-step",
              state.activeAttemptId,
            )) ||
          null,
        claudeSteps: (steps.get(state.id) ?? []).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        ),
        claudeProvenance: claudeStepProvenance(
          state,
          steps.get(state.id) ?? [],
          this.candidate(state.baselineId).createdAt,
        ),
      }));
  }
  close(): void {
    for (const state of this.repository.all<BuilderReviewerState>(
      "builder-reviewer",
    ))
      if (state.activeAttemptId)
        this.contextServer?.revokeAttempt(state.activeAttemptId);
  }
}
