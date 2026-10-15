import {
  capabilitySatisfies,
  type RoleReadiness,
  RuntimeRole,
  RuntimeSelection,
} from "../providers/readiness";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type {
  ContextPackage,
  ExecutionAttempt,
  Task,
  Verification,
  Workflow,
  Workspace,
} from "../domain/workflow";
import type { Installation, Project } from "../domain/types";
import type { Coordinator } from "../runtime/coordinator";
import { RevisionRepository } from "../context/revisions";
import {
  assertCandidateCurrent,
  assertCandidateCoverage,
  captureCandidate,
  materializeCandidate,
  type CandidateFile,
  type CandidateSnapshot,
} from "./candidates";
import {
  executeCheck,
  previewCheck,
  type CheckDefinition,
  type CheckPlan,
} from "./verification";
import {
  ManagedWorkspaces,
  writeManagedSnapshot,
  type ManagedWorkspace,
} from "../workspace/managed";
import type { ProviderCapability } from "../providers/contract";
import { bindCheckInputs } from "./check-inputs";

export interface Specialist {
  key: string;
  title: string;
  workspaceId: string;
  provider: "codex" | "claude";
  installationId: string;
  model: string;
  effort?: string;
  permittedOutputs: string[];
  interfaceRevisionIds: string[];
}
export interface SpecialistTask extends Specialist {
  taskId: string;
  baselineId: string;
  candidateId: string | null;
  attemptId: string | null;
}
export interface ParallelState {
  id: string;
  projectId: string;
  revision: number;
  stage:
    | "ready"
    | "running"
    | "submitted"
    | "conflict"
    | "checking"
    | "awaiting-acceptance"
    | "accepted"
    | "blocked"
    | "cancelled";
  integrationWorkspaceId: string;
  baseId: string;
  tasks: SpecialistTask[];
  integrationTaskId: string | null;
  checks: CheckDefinition[];
  combinedCandidateId: string | null;
  interfaceRevisionIds: string[];
  detail: string;
  createdAt: string;
  updatedAt: string;
}
export interface IntegrationPlan {
  id: string;
  projectId: string;
  workflowId: string;
  expectedRevision: number;
  baseId: string;
  inputs: Array<{
    taskId: string;
    baselineId: string;
    candidateId: string;
    revision: string;
  }>;
  files: CandidateFile[];
  conflicts: Array<{ path: string; candidateIds: string[]; reason: string }>;
  resolutions: Array<{ path: string; candidateId: string }>;
  digest: string;
  createdAt: string;
  expiresAt: string;
}
export interface ParallelDriver {
  readiness?(
    installation: Installation,
    selection: RuntimeSelection,
    role: RuntimeRole,
    required: string[],
  ): RoleReadiness;
  capabilities(installation: Installation): ProviderCapability[];
  dispatch(input: {
    attempt: ExecutionAttempt;
    task: Task;
    workspace: Workspace;
    installation: Installation;
    project: Project;
    context: ContextPackage;
  }): Promise<void>;
  interrupt?(attempt: ExecutionAttempt): Promise<void>;
}
const fileEqual = (a?: CandidateFile, b?: CandidateFile) =>
  (a?.hash ?? null) === (b?.hash ?? null) &&
  (a?.mode ?? null) === (b?.mode ?? null);
const contentBasis = (candidate: CandidateSnapshot) =>
  stable(candidate.files.map((f) => [f.path, f.hash, f.mode]));
function candidateChanges(
  baseline: CandidateSnapshot,
  candidate: CandidateSnapshot,
): CandidateFile[] {
  const old = new Map(baseline.files.map((f) => [f.path, f])),
    current = new Map(candidate.files.map((f) => [f.path, f]));
  return [...new Set([...old.keys(), ...current.keys()])]
    .sort()
    .flatMap((name) => {
      const value = current.get(name) ?? {
        path: name,
        hash: null,
        bytes: 0,
        mode: null,
        content: null,
      };
      return fileEqual(old.get(name), value) ? [] : [value];
    });
}
export const integrationPlanDigest = (plan: IntegrationPlan) => {
  const { digest: _, ...body } = plan;
  return hash(stable(body));
};
/** Deterministic specialist ownership and an explicit integration queue. Whole-file
 * overlap is deliberately a conflict; the engine never guesses a textual merge. */
export class ParallelSpecialists {
  private locks = new Set<string>();
  readonly revisions: RevisionRepository;
  constructor(
    readonly coordinator: Coordinator,
    readonly managed: ManagedWorkspaces,
    private driver: ParallelDriver,
    private changed = () => {},
  ) {
    this.revisions = new RevisionRepository(coordinator.store);
  }
  private get repository() {
    return this.coordinator.repository;
  }
  state(id: string) {
    return this.repository.require<ParallelState>("parallel-specialists", id);
  }
  list(projectId: string) {
    return this.repository.all<ParallelState>("parallel-specialists", {
      projectId,
    });
  }
  private expect(id: string, expectedRevision: number) {
    const state = this.state(id);
    if (state.revision !== expectedRevision)
      throw new Error(
        "Parallel workflow revision changed. Refresh before retrying.",
      );
    return state;
  }
  private save(state: ParallelState, patch: Partial<ParallelState>) {
    const next = {
      ...state,
      ...patch,
      revision: state.revision + 1,
      updatedAt: now(),
    };
    this.coordinator.store.save(
      "parallel-specialists",
      next,
      "parallel.progress",
    );
    this.changed();
    return next;
  }
  private snapshot(id: string) {
    return this.repository.require<CandidateSnapshot>("candidate", id);
  }
  private artifact(candidate: CandidateSnapshot, taskId: string | null) {
    const at = now();
    this.repository.artifact({
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
        source: "managed-candidate-capture",
        observedAt: at,
        detail:
          "Encrypted immutable selected file bytes; worktrees are not an OS sandbox.",
      },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
  }
  async create(input: {
    workflowId: string;
    integrationWorkspaceId: string;
    specialists: Specialist[];
    checks: CheckDefinition[];
    interfaceRevisionIds?: string[];
  }): Promise<ParallelState> {
    this.coordinator.ownership.assertOwner();
    const workflow = this.repository.require<Workflow>(
      "workflow",
      input.workflowId,
    );
    if (
      workflow.state !== "draft" ||
      workflow.taskIds.length ||
      input.specialists.length < 2 ||
      input.specialists.length > 8 ||
      !input.checks.length ||
      new Set(input.checks.map((c) => c.id)).size !== input.checks.length
    )
      throw new Error(
        "Parallel specialists needs an empty draft workflow, two to eight specialists and distinct mandatory combined checks.",
      );
    if (
      new Set(input.specialists.map((s) => s.key)).size !==
        input.specialists.length ||
      input.specialists.some(
        (s) =>
          !/^[a-z][a-z0-9_-]{0,63}$/.test(s.key) ||
          !s.permittedOutputs.length ||
          s.permittedOutputs.some(
            (p) =>
              !p ||
              p.includes("\\") ||
              p.startsWith("/") ||
              p.split("/").some((part) => part === ".." || !part),
          ),
      )
    )
      throw new Error(
        "Each specialist needs a distinct stable key and explicit relative output file paths.",
      );
    const ids = [
        input.integrationWorkspaceId,
        ...input.specialists.map((s) => s.workspaceId),
      ],
      workspaces = ids.map((id) =>
        this.repository.require<Workspace>("workspace", id),
      );
    if (
      new Set(workspaces.map((w) => w.filesystemIdentity)).size !== ids.length
    )
      throw new Error(
        "Each specialist and integrator must own a different canonical workspace.",
      );
    for (const workspace of workspaces) {
      const record = this.repository.require<ManagedWorkspace>(
        "managed-workspace",
        workspace.id,
      );
      if (
        record.state !== "available" ||
        workspace.projectId !== workflow.projectId ||
        !workspace.trustRevision
      )
        throw new Error(
          "Parallel tasks require approved available managed workspaces under the same logical project.",
        );
      this.managed.assertInactive(workspace.id);
    }
    const selection = (workspace: Workspace) => {
      const initial = this.repository.require<{ candidateId: string }>(
        "managed-input",
        workspace.id,
      );
      const snapshot = this.snapshot(initial.candidateId);
      return {
        root: workspace.canonicalRoot,
        projectId: workflow.projectId,
        workflowId: workflow.id,
        selectedPaths:
          workspace.checkoutType === "snapshot"
            ? snapshot.files.map((f) => f.path)
            : undefined,
        approvedUntracked: snapshot.approvedUntracked,
      };
    };
    const base = await captureCandidate(
      this.coordinator.store,
      selection(workspaces[0]),
    );
    this.artifact(base, null);
    bindCheckInputs(this.coordinator.store, workflow.id, base, input.checks);
    const sorted = [...input.specialists].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      baselines: CandidateSnapshot[] = [];
    for (const specialist of sorted) {
      const installation = this.repository.require<Installation>(
        "installation",
        specialist.installationId,
      );
      if (
        (specialist.provider === "codex"
          ? "openai.codex-cli"
          : "anthropic.claude-code-cli") !== installation.appId ||
        !installation.trusted ||
        !specialist.model
      )
        throw new Error(
          "Specialist provider/model must match its approved runtime.",
        );
      const baseline = await captureCandidate(
        this.coordinator.store,
        selection(this.repository.require("workspace", specialist.workspaceId)),
      );
      if (contentBasis(baseline) !== contentBasis(base))
        throw new Error(
          "Specialist inputs must match the known integration base before parallel work begins.",
        );
      baselines.push(baseline);
      this.artifact(baseline, null);
    }
    const interfaceIds = [...new Set(input.interfaceRevisionIds ?? [])];
    const tasks: SpecialistTask[] = [];
    this.coordinator.store.transaction(() => {
      for (let index = 0; index < sorted.length; index++) {
        const specialist = sorted[index],
          refs = [
            ...new Set([...interfaceIds, ...specialist.interfaceRevisionIds]),
          ];
        for (const id of refs) {
          const revision = this.repository.require<{
            projectId: string;
            kind: string;
          }>("shared-revision", id);
          if (
            revision.projectId !== workflow.projectId ||
            revision.kind !== "interface"
          )
            throw new Error(
              "Specialist interface inputs must be pinned project interface revisions.",
            );
        }
        let task = this.repository.createTask({
          projectId: workflow.projectId,
          workflowId: workflow.id,
          workspaceId: specialist.workspaceId,
          title: specialist.title,
          role: "implementer",
          inputRefs: [baselines[index].id, ...refs],
          permittedOutputs: specialist.permittedOutputs,
          acceptanceCriteria: workflow.objective ? [workflow.objective] : [],
          requiredCapabilities: [
            "structured-turn",
            "workspace-write",
            "native-fanout-disabled",
          ],
        });
        task = this.repository.transitionTask(task.id, task.revision, "ready");
        tasks.push({
          ...specialist,
          interfaceRevisionIds: refs,
          taskId: task.id,
          baselineId: baselines[index].id,
          candidateId: null,
          attemptId: null,
        });
        const record = this.repository.require<ManagedWorkspace>(
          "managed-workspace",
          specialist.workspaceId,
        );
        this.coordinator.store.put("managed-workspace", {
          ...record,
          taskId: task.id,
        });
      }
      const current = this.repository.require<Workflow>(
        "workflow",
        workflow.id,
      );
      this.coordinator.store.put("workflow", {
        ...current,
        template: "parallel-specialists",
        templateVersion: "1",
        budget: {
          ...current.budget,
          concurrency: Math.min(current.budget.concurrency, 2),
        },
      });
      this.repository.transitionWorkflow(current.id, current.revision, "ready");
    });
    const at = now(),
      state: ParallelState = {
        id: workflow.id,
        projectId: workflow.projectId,
        revision: 1,
        stage: "ready",
        integrationWorkspaceId: input.integrationWorkspaceId,
        baseId: base.id,
        tasks,
        integrationTaskId: null,
        checks: input.checks,
        combinedCandidateId: null,
        interfaceRevisionIds: interfaceIds,
        detail:
          "Ready. Each worker has its own workspace; native fan-out must be verified disabled before dispatch.",
        createdAt: at,
        updatedAt: at,
      };
    this.coordinator.store.immutable("parallel-definition", state);
    this.coordinator.store.save("parallel-specialists", state);
    this.changed();
    return state;
  }
  async dispatch(
    id: string,
    expectedRevision: number,
    key: string,
  ): Promise<ParallelState> {
    if (this.locks.has(id)) throw new Error("Parallel action is pending.");
    this.locks.add(id);
    try {
      let state = this.expect(id, expectedRevision);
      if (!["ready", "running"].includes(state.stage))
        throw new Error("Parallel workflow is not dispatchable.");
      const specialist = state.tasks.find((t) => t.key === key);
      if (!specialist || specialist.attemptId)
        throw new Error(
          "Specialist is missing or already dispatched; uncertain outcomes are never replayed.",
        );
      const task = this.repository.require<Task>("task", specialist.taskId),
        installation = this.repository.require<Installation>(
          "installation",
          specialist.installationId,
        ),
        capabilities = this.driver.capabilities(installation);
      const readiness = this.driver.readiness?.(
        installation,
        {
          installationId: installation.id,
          provider: specialist.provider,
          model: specialist.model,
          ...(specialist.effort ? { effort: specialist.effort } : {}),
        },
        "implementer",
        task.requiredCapabilities,
      );
      if (readiness && !readiness.ready)
        throw new Error(
          readiness.blockers.map((b) => `${b.code}: ${b.detail}`).join(" "),
        );
      if (
        task.requiredCapabilities.some(
          (name) =>
            !capabilities.some(
              (c) =>
                capabilitySatisfies(c, name) && c.evidence.level !== "none",
            ),
        )
      )
        throw new Error(
          "Required workspace and native fan-out controls are not verified by this selected runtime. Parallel dispatch is gated.",
        );
      const baseline = this.snapshot(specialist.baselineId);
      await assertCandidateCurrent(baseline);
      const capacity = this.coordinator.concurrency.available(
        specialist.provider,
        state.id,
        0,
      );
      if (!capacity.available) {
        this.coordinator.store.put("parallel-dispatch-queued", {
          id: `${id}:${key}`,
          projectId: state.projectId,
          workflowId: id,
          key,
          requestedAt: now(),
        });
        return this.save(state, {
          detail: `Waiting for capacity: ${capacity.detail}`,
        });
      }
      const interfaces = specialist.interfaceRevisionIds.map((id) =>
        this.repository.require<{ id: string; content: string }>(
          "shared-revision",
          id,
        ),
      );
      const text = stable({
        objective: this.repository.require<Workflow>("workflow", state.id)
          .objective,
        role: specialist.title,
        allowedOutputs: specialist.permittedOutputs,
        baseRevision: baseline.baseRevision,
        candidateRevision: baseline.revision,
        candidateId: baseline.id,
        candidateFileCount: baseline.files.length,
        candidateCoverage: baseline.coverage
          ? {
              complete: baseline.coverage.complete,
              manualBinaryCount: baseline.coverage.manualBinaryPaths.length,
            }
          : "legacy",
        interfaces: interfaces.map((r) => ({ id: r.id, content: r.content })),
        output:
          "Submit an immutable candidate. Individual checks do not establish integrated acceptance.",
        isolation:
          "separate checkout; no OS sandbox or enforced reviewer independence claim",
      });
      const context: ContextPackage = {
        id: uid(),
        projectId: state.projectId,
        conversationId: null,
        hash: hash(text),
        text,
        specificationRevision: null,
        sourceRefs: [baseline.id, ...specialist.interfaceRevisionIds],
        omissions: baseline.omissions.map((o) => `${o.source}: ${o.reason}`),
        visibility: "project",
        completeness: "recorded",
        createdAt: now(),
      };
      this.coordinator.store.immutable("context-package", context);
      this.revisions.bindPackage(task.id, context.id);
      this.revisions.assertTaskInputsCurrent(task.id, context.id);
      const attempt = this.repository.prepareAttempt({
        taskId: task.id,
        expectedRevision: task.revision,
        provider: specialist.provider,
        requestedModel: specialist.model,
        freshSession: true,
        runtimeRevision: installation.revisionId,
        executableIdentity: installation.identity,
        contextPackageId: context.id,
        inputManifest: {
          workspaceIdentity: baseline.workspaceIdentity,
          baseRevision: baseline.baseRevision,
          contentManifestId: baseline.id,
          dirtyInputPolicy: "reviewed-snapshot",
          instructionHashes: baseline.instructionHashes.map((i) => ({
            ...i,
            delivery: "present",
          })),
        },
      });
      this.repository.store.immutable("attempt-runtime-settings", {
        id: attempt.id,
        projectId: state.projectId,
        effort: specialist.effort ?? null,
      });
      this.revisions.bindPackage(task.id, context.id, attempt.id);
      const policyEvidence = capabilities.find(
        (c) => c.name === "native-fanout-disabled",
      )!;
      this.coordinator.concurrency.setPolicy(attempt.id, {
        mode: "disabled",
        maxChildren: 0,
        enforced: true,
        approvalDigest: null,
        evidence: stable({
          installationRevision: installation.revisionId,
          capability: policyEvidence,
        }),
      });
      state = this.save(state, {
        stage: "running",
        tasks: state.tasks.map((t) =>
          t.key === key ? { ...t, attemptId: attempt.id } : t,
        ),
        detail: `Specialist ${key} dispatched against pinned interfaces and inputs.`,
      });
      this.coordinator.store.remove("parallel-dispatch-queued", `${id}:${key}`);
      const workspace = this.repository.require<Workspace>(
          "workspace",
          task.workspaceId,
        ),
        logical = this.repository.require<Project>("project", state.projectId);
      try {
        await this.driver.dispatch({
          attempt,
          task,
          workspace,
          installation,
          context,
          project: {
            ...logical,
            path: workspace.root,
            realPath: workspace.canonicalRoot,
            trusted: !!workspace.trustRevision,
          },
        });
      } catch (error) {
        const current = this.repository.require<ExecutionAttempt>(
          "attempt",
          attempt.id,
        );
        if (current.state === "prepared") {
          this.repository.transitionAttempt(
            current.id,
            current.revision,
            "failed",
            { error: safeError(error) },
          );
          const latest = this.repository.require<Task>("task", task.id);
          this.repository.transitionTask(
            latest.id,
            latest.revision,
            "blocked",
            safeError(error),
          );
        }
        this.save(this.state(id), {
          stage: "blocked",
          detail: safeError(error),
        });
        throw error;
      }
      return this.state(id);
    } finally {
      this.locks.delete(id);
    }
  }
  async submit(
    id: string,
    expectedRevision: number,
    key: string,
    approvedUntracked: string[] = [],
  ): Promise<ParallelState> {
    const state = this.expect(id, expectedRevision),
      specialist = state.tasks.find((t) => t.key === key);
    if (!specialist?.attemptId || specialist.candidateId)
      throw new Error(
        "Submission requires one completed attributed specialist attempt.",
      );
    const attempt = this.repository.require<ExecutionAttempt>(
      "attempt",
      specialist.attemptId,
    );
    if (
      attempt.state !== "completed" ||
      this.coordinator.ownership.forAttempt(attempt.id)
    )
      throw new Error(
        "Submission requires confirmed provider process termination. An inference completion is not a stopped writer.",
      );
    const baseline = this.snapshot(specialist.baselineId);
    if (approvedUntracked.some((p) => !specialist.permittedOutputs.includes(p)))
      throw new Error(
        "Untracked output must be part of the specialist's agreed outputs.",
      );
    const candidate = await captureCandidate(this.coordinator.store, {
      root: baseline.sourceRoot,
      projectId: state.projectId,
      workflowId: id,
      authorAttemptId: attempt.id,
      baseCandidateId: baseline.id,
      selectedPaths: baseline.git
        ? undefined
        : [
            ...new Set([
              ...baseline.files.map((f) => f.path),
              ...approvedUntracked,
            ]),
          ],
      approvedUntracked: baseline.git
        ? [...new Set([...baseline.approvedUntracked, ...approvedUntracked])]
        : [],
    });
    if (
      candidateChanges(baseline, candidate).some(
        (file) => !specialist.permittedOutputs.includes(file.path),
      )
    )
      throw new Error(
        "Candidate changed or deleted files outside the agreed specialist outputs. Resolve ownership before submitting.",
      );
    this.expect(id, expectedRevision);
    this.artifact(candidate, specialist.taskId);
    this.coordinator.store.immutable("integration-submission", {
      id: candidate.id,
      projectId: state.projectId,
      workflowId: id,
      taskId: specialist.taskId,
      attemptId: attempt.id,
      baselineId: baseline.id,
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      state: state.stage === "cancelled" ? "late-cancelled" : "queued",
      createdAt: now(),
    });
    if (state.stage === "cancelled") return state;
    const task = this.repository.require<Task>("task", specialist.taskId);
    this.repository.transitionTask(
      task.id,
      task.revision,
      "submitted",
      "Immutable specialist candidate queued; combined checks remain required.",
      candidate.id,
    );
    const tasks = state.tasks.map((t) =>
      t.key === key ? { ...t, candidateId: candidate.id } : t,
    );
    return this.save(state, {
      tasks,
      stage: tasks.every((t) => t.candidateId) ? "submitted" : "running",
      detail:
        "Candidate queued. Individual branch checks cannot accept integration.",
    });
  }
  async previewIntegration(
    id: string,
    expectedRevision: number,
    resolutions: Array<{ path: string; candidateId: string }> = [],
  ): Promise<IntegrationPlan> {
    const state = this.expect(id, expectedRevision);
    if (
      !["submitted", "conflict"].includes(state.stage) ||
      state.tasks.some((t) => !t.candidateId)
    )
      throw new Error(
        "All specialist candidates must be queued before integration.",
      );
    this.managed.assertInactive(state.integrationWorkspaceId);
    const base = this.snapshot(state.baseId);
    await assertCandidateCurrent(base);
    const files = new Map(base.files.map((f) => [f.path, f])),
      changes = new Map<
        string,
        Array<{ candidateId: string; file: CandidateFile }>
      >(),
      inputs: IntegrationPlan["inputs"] = [];
    for (const task of state.tasks) {
      const baseline = this.snapshot(task.baselineId),
        candidate = this.snapshot(task.candidateId!);
      await assertCandidateCurrent(candidate);
      inputs.push({
        taskId: task.taskId,
        baselineId: baseline.id,
        candidateId: candidate.id,
        revision: candidate.revision,
      });
      for (const file of candidateChanges(baseline, candidate)) {
        const values = changes.get(file.path) ?? [];
        values.push({ candidateId: candidate.id, file });
        changes.set(file.path, values);
      }
    }
    const conflicts: IntegrationPlan["conflicts"] = [];
    if (
      new Set(resolutions.map((r) => r.path)).size !== resolutions.length ||
      resolutions.some(
        (r) =>
          !changes.get(r.path)?.some((v) => v.candidateId === r.candidateId),
      )
    )
      throw new Error(
        "Conflict resolutions must select a submitted candidate for an explicit changed file.",
      );
    for (const [name, values] of [...changes].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const resolution = resolutions.find((r) => r.path === name),
        distinct = values.filter(
          (v, i) =>
            values.findIndex((other) => fileEqual(other.file, v.file)) === i,
        );
      if (distinct.length > 1 && !resolution) {
        conflicts.push({
          path: name,
          candidateIds: values.map((v) => v.candidateId),
          reason:
            "Multiple specialists changed the same file differently; explicit resolution required.",
        });
        continue;
      }
      files.set(
        name,
        resolution
          ? values.find((v) => v.candidateId === resolution.candidateId)!.file
          : values[0].file,
      );
    }
    const plan: IntegrationPlan = {
      id: uid(),
      projectId: state.projectId,
      workflowId: id,
      expectedRevision,
      baseId: base.id,
      inputs,
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
      conflicts,
      resolutions,
      digest: "",
      createdAt: now(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    this.expect(id, expectedRevision);
    plan.digest = integrationPlanDigest(plan);
    this.coordinator.store.immutable("integration-plan", plan);
    if (conflicts.length)
      this.save(state, {
        stage: "conflict",
        detail: `${conflicts.length} file conflicts recorded. Source candidates and integration base remain unchanged.`,
      });
    return plan;
  }
  async applyIntegration(
    planId: string,
    digest: string,
  ): Promise<ParallelState> {
    const plan = this.repository.require<IntegrationPlan>(
        "integration-plan",
        planId,
      ),
      state = this.expect(plan.workflowId, plan.expectedRevision);
    if (
      digest !== plan.digest ||
      integrationPlanDigest(plan) !== digest ||
      Date.parse(plan.expiresAt) <= Date.now() ||
      this.coordinator.store.get("integration-plan-consumed", plan.id)
    )
      throw new Error("Integration approval is stale or consumed.");
    if (plan.conflicts.length)
      throw new Error(
        "Resolve the recorded conflicts before applying an integration plan.",
      );
    if (!["submitted", "conflict"].includes(state.stage))
      throw new Error("Integration state changed.");
    const base = this.snapshot(plan.baseId);
    await assertCandidateCurrent(base);
    this.managed.assertInactive(state.integrationWorkspaceId);
    for (const input of plan.inputs) {
      const candidate = this.snapshot(input.candidateId);
      if (candidate.revision !== input.revision)
        throw new Error("Submitted candidate revision changed.");
      await assertCandidateCurrent(candidate);
    }
    const prepared = this.coordinator.store.transaction(() => {
      this.expect(plan.workflowId, plan.expectedRevision);
      if (this.coordinator.store.get("integration-plan-consumed", plan.id))
        throw new Error(
          "Integration plan was consumed by another action. Do not replay its writes.",
        );
      let task = this.repository.createTask({
        projectId: state.projectId,
        workflowId: state.id,
        workspaceId: state.integrationWorkspaceId,
        title: "Integrate specialist candidates",
        role: "integrator",
        dependencies: plan.inputs.map((i) => i.taskId),
        inputRefs: plan.inputs.map((i) => i.candidateId),
        acceptanceCriteria: state.checks.map((c) => c.label),
      });
      task = this.repository.transitionTask(task.id, task.revision, "ready");
      task = this.repository.transitionTask(task.id, task.revision, "active");
      const lease = this.coordinator.ownership.acquire(
        this.repository.require<Workspace>(
          "workspace",
          state.integrationWorkspaceId,
        ),
        `integration:${plan.id}`,
      );
      this.coordinator.store.immutable("integration-plan-consumed", {
        id: plan.id,
        digest,
        state: "dispatch-recorded",
        createdAt: now(),
      });
      return { task, lease };
    });
    const { task, lease } = prepared;
    try {
      await writeManagedSnapshot(
        { ...base, files: plan.files },
        base.sourceRoot,
        this.coordinator.store,
      );
      const combined = await captureCandidate(this.coordinator.store, {
        root: base.sourceRoot,
        projectId: state.projectId,
        workflowId: state.id,
        baseCandidateId: base.id,
        selectedPaths: base.git ? undefined : plan.files.map((f) => f.path),
        approvedUntracked: base.git
          ? plan.files
              .map((f) => f.path)
              .filter(
                (p) =>
                  !base.files.some(
                    (f) => f.path === p && !base.approvedUntracked.includes(p),
                  ),
              )
          : [],
      });
      if (
        plan.files.some(
          (file) =>
            !fileEqual(
              file,
              combined.files.find((f) => f.path === file.path),
            ),
        )
      )
        throw new Error(
          "Combined workspace differs from the reviewed integration file manifest. Preserve it for reconciliation.",
        );
      this.artifact(combined, task.id);
      this.coordinator.store.immutable("integration-result", {
        id: combined.id,
        projectId: state.projectId,
        workflowId: state.id,
        planId: plan.id,
        baseId: base.id,
        inputCandidates: plan.inputs,
        combinedRevision: combined.revision,
        candidateId: combined.id,
        requiredChecks: state.checks,
        createdAt: now(),
      });
      this.repository.transitionTask(
        task.id,
        task.revision,
        "submitted",
        "Combined revision captured; all required combined checks remain outstanding.",
        combined.id,
      );
      const workflow = this.repository.require<Workflow>("workflow", state.id);
      if (workflow.state === "ready")
        this.repository.transitionWorkflow(
          workflow.id,
          workflow.revision,
          "running",
        );
      return this.save(state, {
        stage: "checking",
        combinedCandidateId: combined.id,
        integrationTaskId: task.id,
        detail:
          "Candidates applied to the known integration base. Combined-revision checks are mandatory.",
      });
    } catch (error) {
      this.coordinator.ownership.markUncertain(
        `integration:${plan.id}`,
        "Integration mutation stopped with an unknown filesystem outcome; preserve workspace for explicit reconciliation.",
      );
      return this.save(state, {
        stage: "blocked",
        integrationTaskId: task.id,
        detail: safeError(error),
      });
    } finally {
      const current = this.coordinator.ownership.forAttempt(
        `integration:${plan.id}`,
      );
      if (current?.state === "held")
        this.coordinator.ownership.release(
          `integration:${plan.id}`,
          lease.generation,
          {
            level: "topsl-transaction",
            source: "integration-writer",
            observedAt: now(),
            detail:
              "Controlled integration writes finished; no provider process was created.",
          },
        );
    }
  }
  async previewChecks(id: string, expectedRevision: number) {
    const state = this.expect(id, expectedRevision);
    if (
      state.stage !== "checking" ||
      !state.combinedCandidateId ||
      !state.integrationTaskId
    )
      throw new Error("Combined candidate required before checks.");
    return Promise.all(
      state.checks.map((c) =>
        previewCheck(
          this.repository,
          state.id,
          state.integrationTaskId!,
          this.snapshot(state.combinedCandidateId!),
          c,
        ),
      ),
    );
  }
  private currentChecks(state: ParallelState) {
    return new Map(
      this.repository
        .all<Verification>("verification", { projectId: state.projectId })
        .filter(
          (v) =>
            v.taskId === state.integrationTaskId &&
            v.candidateId === state.combinedCandidateId &&
            v.targetRevision ===
              this.snapshot(state.combinedCandidateId!).revision &&
            !v.invalidatedAt,
        )
        .map((v) => [v.definition, v]),
    );
  }
  async runCheck(planId: string, digest: string) {
    const plan = this.repository.require<CheckPlan>(
        "workflow-check-plan",
        planId,
      ),
      state = this.state(plan.workflowId);
    if (
      state.stage !== "checking" ||
      plan.candidateId !== state.combinedCandidateId
    )
      throw new Error(
        "Check targets a stale or individual candidate; integrated evidence required.",
      );
    await executeCheck(this.repository, plan, digest);
    const latest = this.state(state.id);
    if (latest.stage === "cancelled") return latest;
    const checks = this.currentChecks(latest),
      passed = latest.checks.every(
        (c) =>
          checks.get(c.id)?.result === "passed" &&
          checks.get(c.id)?.evidenceArtifactId,
      );
    if (passed) {
      const workflow = this.repository.require<Workflow>("workflow", state.id);
      this.repository.transitionWorkflow(
        workflow.id,
        workflow.revision,
        "awaiting-acceptance",
      );
    }
    return this.save(latest, {
      stage: passed ? "awaiting-acceptance" : "checking",
      detail: passed
        ? "Required combined-revision checks passed. Explicit user acceptance remains required."
        : "Combined candidate has failing or incomplete checks; acceptance is blocked.",
    });
  }
  acceptanceDigest(id: string) {
    const state = this.state(id);
    return hash(
      stable({
        state,
        checks: state.combinedCandidateId
          ? [...this.currentChecks(state).values()].map((v) => [
              v.id,
              v.targetRevision,
              v.result,
              v.invalidatedAt,
            ])
          : [],
      }),
    );
  }
  async accept(id: string, expectedRevision: number, digest: string) {
    const state = this.expect(id, expectedRevision);
    if (
      state.stage !== "awaiting-acceptance" ||
      digest !== this.acceptanceDigest(id) ||
      !state.combinedCandidateId
    )
      throw new Error(
        "Explicit acceptance requires the current combined candidate and its checks.",
      );
    await this.observe(id);
    const current = this.expect(id, expectedRevision),
      candidate = this.snapshot(current.combinedCandidateId!),
      checks = this.currentChecks(current);
    assertCandidateCoverage(candidate, this.coordinator.store);
    if (
      !current.checks.every(
        (c) =>
          checks.get(c.id)?.result === "passed" &&
          checks.get(c.id)?.evidenceArtifactId,
      )
    )
      throw new Error(
        "Individual worker checks cannot establish combined acceptance.",
      );
    this.coordinator.store.transaction(() => {
      for (const taskId of [
        ...current.tasks.map((t) => t.taskId),
        current.integrationTaskId!,
      ]) {
        let task = this.repository.require<Task>("task", taskId);
        task = this.repository.transitionTask(
          task.id,
          task.revision,
          "verifying",
          "Accepting only the tested combined integration revision.",
          candidate.id,
        );
        if (taskId !== current.integrationTaskId)
          for (const check of checks.values())
            this.repository.verification({
              ...check,
              id: uid(),
              taskId,
              createdAt: now(),
              updatedAt: now(),
            });
        this.repository.transitionTask(
          task.id,
          task.revision,
          "accepted",
          "Explicit user acceptance of integrated output and combined evidence.",
          candidate.id,
        );
      }
      const workflow = this.repository.require<Workflow>("workflow", id);
      this.repository.transitionWorkflow(
        workflow.id,
        workflow.revision,
        "accepted",
        {
          by: "local-user",
          at: now(),
          digest,
          targetRevision: candidate.revision,
        },
      );
    });
    return this.save(current, {
      stage: "accepted",
      detail:
        "Explicitly accepted the combined candidate with current revision-bound checks.",
    });
  }
  async observe(id: string) {
    const state = this.state(id);
    if (!state.combinedCandidateId || state.stage === "cancelled") return state;
    try {
      await assertCandidateCurrent(this.snapshot(state.combinedCandidateId));
    } catch (error) {
      this.repository.invalidateCandidate(
        state.combinedCandidateId,
        safeError(error),
      );
      return this.save(state, {
        stage: "blocked",
        detail:
          "External candidate modification invalidated combined review/check evidence. Capture and verify a new candidate.",
      });
    }
    return state;
  }
  async cancel(id: string, expectedRevision: number) {
    const state = this.expect(id, expectedRevision),
      next = this.save(state, {
        stage: "cancelled",
        detail:
          "Cancelled. Late results remain attributed historical evidence and cannot accept this workflow.",
      });
    const workflow = this.repository.require<Workflow>("workflow", id);
    if (!["accepted", "cancelled", "failed"].includes(workflow.state))
      this.repository.transitionWorkflow(
        workflow.id,
        workflow.revision,
        "cancelled",
      );
    for (const queued of this.repository.all<{
      id: string;
      workflowId: string;
    }>("parallel-dispatch-queued", { projectId: state.projectId }))
      if (queued.workflowId === id)
        this.coordinator.store.remove("parallel-dispatch-queued", queued.id);
    for (const specialist of state.tasks)
      if (specialist.attemptId) {
        const attempt = this.repository.require<ExecutionAttempt>(
          "attempt",
          specialist.attemptId,
        );
        if (
          ["starting", "running", "awaiting-approval"].includes(attempt.state)
        )
          await this.driver.interrupt?.(attempt);
      }
    return next;
  }
  async tick() {
    for (const queued of this.repository.all<{
      id: string;
      workflowId: string;
      key: string;
    }>("parallel-dispatch-queued")) {
      const state = this.state(queued.workflowId),
        specialist = state.tasks.find((t) => t.key === queued.key);
      if (
        !specialist ||
        !["ready", "running"].includes(state.stage) ||
        specialist.attemptId
      ) {
        this.coordinator.store.remove("parallel-dispatch-queued", queued.id);
        continue;
      }
      if (
        this.coordinator.concurrency.available(specialist.provider, state.id, 0)
          .available
      )
        await this.dispatch(state.id, state.revision, queued.key);
    }
  }
  async reviewSnapshot(
    candidateId: string,
    requiredCapabilities: string[],
    capabilities: ProviderCapability[],
  ) {
    if (
      requiredCapabilities.some(
        (name) =>
          !capabilities.some(
            (c) =>
              c.name === name &&
              c.support === "enforceable" &&
              c.evidence.level !== "none",
          ),
      )
    )
      throw new Error(
        "Required review visibility/filesystem isolation is unavailable. Enforced independence cannot be claimed.",
      );
    const candidate = this.snapshot(candidateId);
    await assertCandidateCurrent(candidate);
    const copy = await materializeCandidate(candidate);
    return {
      ...copy,
      isolation:
        "pinned bytes; OS independence only when the supplied runtime capabilities are verified",
      candidateRevision: candidate.revision,
    };
  }
}
