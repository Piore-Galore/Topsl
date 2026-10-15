import {
  Store,
  type Page,
  type PageOptions,
  type DocumentScope,
} from "../store";
import { hash, now, stable, uid } from "../../domain/invariants";
import {
  activeAttemptStates,
  agentSessionSchema,
  artifactSchema,
  assertDependencyGraph,
  assertTransition,
  executionAttemptSchema,
  taskSchema,
  verificationSchema,
  workflowSchema,
  workspaceSchema,
  unknownEvidence,
  type AgentSession,
  type Artifact,
  type ExecutionAttempt,
  type InputManifest,
  type OperationIntent,
  type Task,
  type Verification,
  type Workflow,
  type Workspace,
} from "../../domain/workflow";
import type { Project } from "../../domain/types";
import { canonicalWorkspaceIdentity } from "../../workspace/ownership";
import { RevisionRepository } from "../../context/revisions";
import { SyncRepository } from "../../sync/reconciler";
import type { AdvancedState, FrozenSubmission } from "../../workflows/advanced";

export interface PrepareAttempt {
  taskId: string;
  expectedRevision: number;
  provider: "codex" | "claude";
  requestedModel: string | null;
  sessionId?: string;
  freshSession?: boolean;
  profileId?: string | null;
  accountKey?: string | null;
  runtimeRevision?: string | null;
  executableIdentity?: string | null;
  contextPackageId?: string | null;
  specificationRevision?: string | null;
  inputManifest?: InputManifest;
  retryOfAttemptId?: string | null;
  legacyRunId?: string | null;
}
export class CoordinationRepository {
  constructor(readonly store: Store) {}
  require<T>(kind: string, id: string): T {
    const value = this.store.get<T>(kind, id);
    if (!value) throw new Error(`Selected ${kind} does not exist.`);
    return value;
  }
  page<T>(kind: string, scope: PageOptions): Page<T> {
    return this.store.page<T>(kind, scope);
  }
  all<T>(kind: string, scope: DocumentScope = {}): T[] {
    return [...this.store.iterate<T>(kind, scope)];
  }
  private save<T extends { id: string; revision: number }>(
    kind: string,
    value: T,
  ): T {
    this.store.save(kind, value, `${kind}.changed`);
    this.store.immutable(`${kind}-revision`, {
      ...value,
      id: `${value.id}:${value.revision}`,
      entityId: value.id,
    });
    return value;
  }
  ensureWorkspace(project: Project): Workspace {
    const identity = canonicalWorkspaceIdentity(project.realPath),
      id =
        this.store.get<{ workspaceId: string }>(
          "project-default-workspace",
          project.id,
        )?.workspaceId ?? `legacy-workspace:${project.id}`;
    const old = this.store.get<Workspace>("workspace", id),
      at = now();
    if (
      old?.filesystemIdentity &&
      old.filesystemIdentity !== identity.filesystemIdentity
    )
      throw new Error(
        "Workspace folder identity changed. Relink and review trust before dispatch.",
      );
    const workspace = workspaceSchema.parse({
      id,
      projectId: project.id,
      hostId: "local",
      root: project.path,
      ...identity,
      checkoutType: old?.checkoutType ?? "directory",
      branch: old?.branch ?? null,
      trustRevision: project.trusted
        ? hash(
            stable([
              project.id,
              identity.filesystemIdentity,
              "approved-folder",
            ]),
          )
        : null,
      availability: project.trusted ? "available" : "unverified",
      provenance: old?.provenance ?? "approved",
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? project.createdAt,
      updatedAt: at,
    });
    return this.store.transaction(() => this.save("workspace", workspace));
  }
  /** Explicit relink creates a new default workspace without rebinding historical tasks. */
  relinkDefaultWorkspace(project: Project): Workspace {
    const identity = canonicalWorkspaceIdentity(project.realPath),
      at = now();
    if (!project.trusted)
      throw new Error("Relink requires current approved project trust.");
    return this.store.transaction(() => {
      const priorId =
        this.store.get<{ workspaceId: string }>(
          "project-default-workspace",
          project.id,
        )?.workspaceId ?? `legacy-workspace:${project.id}`;
      const prior = this.store.get<Workspace>("workspace", priorId);
      if (
        prior?.filesystemIdentity === identity.filesystemIdentity &&
        prior.canonicalRoot === identity.canonicalRoot
      )
        return this.ensureWorkspace(project);
      if (
        this.all<ExecutionAttempt>("attempt", { projectId: project.id }).some(
          (attempt) => activeAttemptStates.includes(attempt.state as any),
        )
      )
        throw new Error(
          "Close and reconcile prior project attempts before relinking its default workspace.",
        );
      const workspace = workspaceSchema.parse({
        id: uid(),
        projectId: project.id,
        hostId: "local",
        root: project.path,
        ...identity,
        checkoutType: "directory",
        branch: null,
        trustRevision: hash(
          stable([project.id, identity.filesystemIdentity, "approved-folder"]),
        ),
        availability: "available",
        provenance: "approved",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      });
      this.save("workspace", workspace);
      if (prior)
        this.save("workspace", {
          ...prior,
          trustRevision: null,
          availability: "unverified",
          revision: prior.revision + 1,
          updatedAt: at,
        });
      this.store.save("project-default-workspace", {
        id: project.id,
        projectId: project.id,
        workspaceId: workspace.id,
        priorWorkspaceId: prior?.id ?? null,
        approvedAt: at,
      });
      this.store.immutable("workspace-relink", {
        id: uid(),
        projectId: project.id,
        priorWorkspaceId: prior?.id ?? null,
        workspaceId: workspace.id,
        at,
      });
      return workspace;
    });
  }
  createWorkflow(
    input: Pick<
      Workflow,
      "projectId" | "objective" | "template" | "templateVersion"
    > &
      Partial<Pick<Workflow, "specificationRevision" | "budget">>,
  ): Workflow {
    this.require<Project>("project", input.projectId);
    const at = now(),
      workflow = workflowSchema.parse({
        ...input,
        id: uid(),
        taskIds: [],
        state: "draft",
        specificationRevision: input.specificationRevision ?? null,
        budget: input.budget ?? { concurrency: 2, repairRounds: 2 },
        acceptance: null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      });
    return this.store.transaction(() => this.save("workflow", workflow));
  }
  createTask(
    input: Pick<Task, "projectId" | "workspaceId" | "title" | "role"> &
      Partial<
        Pick<
          Task,
          | "workflowId"
          | "conversationId"
          | "dependencies"
          | "inputRefs"
          | "permittedOutputs"
          | "acceptanceCriteria"
          | "requiredCapabilities"
        >
      >,
  ): Task {
    return this.store.transaction(() => {
      const workspace = this.require<Workspace>("workspace", input.workspaceId);
      if (workspace.projectId !== input.projectId)
        throw new Error("Task workspace belongs to another project.");
      const at = now(),
        task = taskSchema.parse({
          ...input,
          id: uid(),
          workflowId: input.workflowId ?? null,
          conversationId: input.conversationId ?? null,
          dependencies: input.dependencies ?? [],
          inputRefs: input.inputRefs ?? [],
          permittedOutputs: input.permittedOutputs ?? [],
          acceptanceCriteria: input.acceptanceCriteria ?? [],
          requiredCapabilities: input.requiredCapabilities ?? [],
          state: "draft",
          attemptIds: [],
          candidateId: null,
          detail: "",
          revision: 1,
          createdAt: at,
          updatedAt: at,
        });
      if (task.workflowId) {
        const workflow = this.require<Workflow>("workflow", task.workflowId);
        if (workflow.projectId !== task.projectId)
          throw new Error("Workflow belongs to another project.");
        const tasks = this.all<Task>("task", {
          projectId: task.projectId,
        }).filter((t) => t.workflowId === task.workflowId);
        assertDependencyGraph([...tasks, task]);
        this.save("workflow", {
          ...workflow,
          taskIds: [...workflow.taskIds, task.id],
          revision: workflow.revision + 1,
          updatedAt: at,
        });
      }
      return this.save("task", task);
    });
  }
  transitionTask(
    id: string,
    expectedRevision: number,
    state: Task["state"],
    detail = "",
    candidateId?: string | null,
  ): Task {
    return this.store.transaction(() => {
      const task = this.require<Task>("task", id);
      this.expectRevision(task, expectedRevision);
      assertTransition("task", task.state, state);
      if (
        state === "ready" &&
        task.dependencies.some((id) => {
          const dependency = this.require<Task>("task", id);
          if (dependency.state === "accepted") return false;
          return !(
            task.role !== "implementer" &&
            ["submitted", "reviewing", "verifying"].includes(
              dependency.state,
            ) &&
            dependency.candidateId &&
            task.inputRefs.includes(dependency.candidateId) &&
            this.store.get<Artifact>("artifact", dependency.candidateId)
          );
        })
      )
        throw new Error(
          "Task dependencies require acceptance or an explicitly pinned immutable candidate.",
        );
      const candidate =
        candidateId === undefined ? task.candidateId : candidateId;
      if (state === "accepted")
        this.assertTaskAcceptance({ ...task, candidateId: candidate });
      return this.save("task", {
        ...task,
        state,
        detail,
        candidateId: candidate,
        revision: task.revision + 1,
        updatedAt: now(),
      });
    });
  }
  transitionWorkflow(
    id: string,
    expectedRevision: number,
    state: Workflow["state"],
    acceptance?: Workflow["acceptance"],
  ): Workflow {
    return this.store.transaction(() => {
      const workflow = this.require<Workflow>("workflow", id);
      this.expectRevision(workflow, expectedRevision);
      assertTransition("workflow", workflow.state, state);
      if (state === "accepted") {
        if (!acceptance || !workflow.taskIds.length)
          throw new Error(
            "Explicit user acceptance and accepted tasks are required.",
          );
        for (const taskId of workflow.taskIds)
          this.assertAcceptedLineage(
            workflow,
            taskId,
            acceptance.targetRevision,
          );
      }
      return this.save("workflow", {
        ...workflow,
        state,
        acceptance: acceptance ?? workflow.acceptance,
        revision: workflow.revision + 1,
        updatedAt: now(),
      });
    });
  }
  prepareAttempt(input: PrepareAttempt): ExecutionAttempt {
    return this.store.transaction(() => {
      let task = this.require<Task>("task", input.taskId);
      this.expectRevision(task, input.expectedRevision);
      if (task.state !== "ready")
        throw new Error("Task must be ready before preparing an attempt.");
      new RevisionRepository(this.store).assertTaskInputsCurrent(
        task.id,
        input.contextPackageId ?? undefined,
      );
      const workspace = this.require<Workspace>("workspace", task.workspaceId);
      if (!workspace.trustRevision || workspace.availability !== "available")
        throw new Error("Task workspace must have current approved trust.");
      if (
        this.all<ExecutionAttempt>("attempt", {
          projectId: task.projectId,
        }).some(
          (a) =>
            a.taskId === task.id &&
            activeAttemptStates.includes(a.state as any),
        )
      )
        throw new Error("Task already has an active or uncertain attempt.");
      const at = now();
      let session: AgentSession;
      if (input.sessionId && !input.freshSession) {
        session = this.require<AgentSession>("agent-session", input.sessionId);
        if (
          !session.resumable ||
          session.continuity === "unknown" ||
          session.provider !== input.provider ||
          session.workspaceId !== task.workspaceId ||
          session.role !== task.role ||
          session.accountKey !== input.accountKey ||
          session.profileId !== input.profileId ||
          session.runtimeRevision !== input.runtimeRevision ||
          session.executableIdentity !== input.executableIdentity
        )
          throw new Error(
            "Session continuity, account, role, workspace, or runtime binding is not verified.",
          );
        if (
          this.all<ExecutionAttempt>("attempt", {
            projectId: task.projectId,
          }).some(
            (a) =>
              a.sessionId === session.id &&
              activeAttemptStates.includes(a.state as any),
          )
        )
          throw new Error("Session already has an active turn.");
      } else {
        session = agentSessionSchema.parse({
          id: uid(),
          projectId: task.projectId,
          conversationId: task.conversationId,
          provider: input.provider,
          nativeSessionId: null,
          profileId: input.profileId ?? null,
          accountKey: input.accountKey ?? null,
          runtimeRevision: input.runtimeRevision ?? null,
          executableIdentity: input.executableIdentity ?? null,
          workspaceId: task.workspaceId,
          role: task.role,
          parentSessionId: null,
          forkOfSessionId: input.freshSession
            ? (input.sessionId ?? null)
            : null,
          observability: "coordinated",
          resumable: false,
          continuity: "fresh",
          evidence: unknownEvidence("Provider session has not been created."),
          revision: 1,
          createdAt: at,
          updatedAt: at,
        });
        this.save("agent-session", session);
      }
      if (input.retryOfAttemptId) {
        const previous = this.require<ExecutionAttempt>(
          "attempt",
          input.retryOfAttemptId,
        );
        if (
          previous.taskId !== task.id ||
          activeAttemptStates.includes(previous.state as any)
        )
          throw new Error(
            "Retry requires a reconciled terminal prior attempt for this task.",
          );
      }
      const attempt = executionAttemptSchema.parse({
        id: uid(),
        projectId: task.projectId,
        taskId: task.id,
        sessionId: session.id,
        workspaceId: task.workspaceId,
        conversationId: task.conversationId,
        legacyRunId: input.legacyRunId ?? null,
        provider: input.provider,
        requestedModel: input.requestedModel,
        reportedModel: null,
        modelEvidence: unknownEvidence("Effective model was not reported."),
        contextPackageId: input.contextPackageId ?? null,
        specificationRevision: input.specificationRevision ?? null,
        inputManifest: input.inputManifest ?? {
          workspaceIdentity: workspace.filesystemIdentity,
          baseRevision: null,
          contentManifestId: null,
          dirtyInputPolicy: "unknown",
          instructionHashes: [],
        },
        state: "prepared",
        dispatchId: uid(),
        operationIntentId: null,
        retryOfAttemptId: input.retryOfAttemptId ?? null,
        leaseGeneration: null,
        error: null,
        usageEvidence: unknownEvidence("Usage has not been reported."),
        finishedAt: null,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      });
      task = this.save("task", {
        ...task,
        state: "active",
        attemptIds: [...task.attemptIds, attempt.id],
        revision: task.revision + 1,
        updatedAt: at,
      });
      this.save("attempt", attempt);
      const configuration = new SyncRepository(this.store);
      configuration.recordConfiguration({
        projectId: task.projectId,
        sessionId: session.id,
        provider: input.provider,
        capability: "model",
        classification: "observable-only",
        stage: "requested",
        value: input.requestedModel,
        sourceRevision: attempt.id,
        sourceHash: null,
        evidence: {
          level: "topsl-transaction",
          source: "execution-attempt",
          observedAt: at,
          detail:
            "Requested model recorded; provider-reported effective model remains separate.",
        },
      });
      for (const instruction of attempt.inputManifest.instructionHashes)
        configuration.recordConfiguration({
          projectId: task.projectId,
          sessionId: session.id,
          provider: input.provider,
          capability: `instruction:${instruction.path}`,
          classification: "observable-only",
          stage:
            instruction.delivery === "injected" ? "configured" : "discovered",
          value: instruction.path,
          sourceRevision: attempt.contextPackageId,
          sourceHash: instruction.hash,
          evidence: {
            level: "topsl-transaction",
            source: "attempt-input-manifest",
            observedAt: at,
            detail: `Instruction ${instruction.delivery} recorded; effective runtime loading is unverified.`,
          },
        });
      return attempt;
    });
  }
  bindSession(
    id: string,
    binding: Pick<
      AgentSession,
      | "nativeSessionId"
      | "accountKey"
      | "profileId"
      | "runtimeRevision"
      | "executableIdentity"
      | "evidence"
    >,
  ): AgentSession {
    return this.store.transaction(() => {
      const session = this.require<AgentSession>("agent-session", id);
      if (
        session.nativeSessionId &&
        session.nativeSessionId !== binding.nativeSessionId
      )
        throw new Error(
          "A session binding cannot be replaced; create a new session.",
        );
      if (session.accountKey && session.accountKey !== binding.accountKey)
        throw new Error("Session account changed.");
      const verified = !!(
        binding.nativeSessionId &&
        binding.accountKey &&
        binding.profileId &&
        binding.runtimeRevision &&
        binding.executableIdentity
      );
      return this.save(
        "agent-session",
        agentSessionSchema.parse({
          ...session,
          ...binding,
          resumable: verified,
          continuity: verified ? "verified" : "unknown",
          revision: session.revision + 1,
          updatedAt: now(),
        }),
      );
    });
  }
  transitionAttempt(
    id: string,
    expectedRevision: number,
    state: ExecutionAttempt["state"],
    patch: Partial<
      Pick<
        ExecutionAttempt,
        | "error"
        | "reportedModel"
        | "modelEvidence"
        | "operationIntentId"
        | "leaseGeneration"
        | "usageEvidence"
      >
    > = {},
  ): ExecutionAttempt {
    return this.store.transaction(() => {
      const attempt = this.require<ExecutionAttempt>("attempt", id);
      this.expectRevision(attempt, expectedRevision);
      assertTransition("attempt", attempt.state, state);
      return this.save(
        "attempt",
        executionAttemptSchema.parse({
          ...attempt,
          ...patch,
          state,
          finishedAt: ["completed", "failed", "interrupted"].includes(state)
            ? now()
            : null,
          revision: attempt.revision + 1,
          updatedAt: now(),
        }),
      );
    });
  }
  recordIntent(
    attemptId: string,
    kind: OperationIntent["kind"],
    digest: string,
  ): OperationIntent {
    const attempt = this.require<ExecutionAttempt>("attempt", attemptId),
      at = now();
    const intent: OperationIntent = {
      id: attempt.dispatchId,
      projectId: attempt.projectId,
      attemptId,
      kind,
      digest,
      expectedRevision: String(attempt.revision),
      state: "prepared",
      providerReference: null,
      evidence: unknownEvidence("External operation has not been dispatched."),
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.store.immutable("operation-intent", intent);
    return intent;
  }
  updateIntent(
    id: string,
    state: OperationIntent["state"],
    providerReference: string | null = null,
  ): OperationIntent {
    return this.store.transaction(() => {
      const intent = this.require<OperationIntent>("operation-intent", id);
      const allowed: Record<
        OperationIntent["state"],
        OperationIntent["state"][]
      > = {
        prepared: ["dispatch-recorded", "failed"],
        "dispatch-recorded": ["acknowledged", "unknown", "failed"],
        acknowledged: ["verified", "unknown"],
        verified: [],
        unknown: ["verified", "failed"],
        failed: [],
      };
      if (intent.state !== state && !allowed[intent.state].includes(state))
        throw new Error(
          "Operation intent must be reconciled before replacement.",
        );
      const result = {
        ...intent,
        state,
        providerReference,
        revision: intent.revision + 1,
        updatedAt: now(),
      };
      this.store.save("operation-intent", result);
      return result;
    });
  }
  artifact(input: Artifact): Artifact {
    const value = artifactSchema.parse(input);
    this.store.immutable("artifact", value);
    return value;
  }
  verification(input: Verification): Verification {
    const value = verificationSchema.parse(input);
    this.store.immutable("verification", value);
    return value;
  }
  invalidateCandidate(candidateId: string, reason: string): void {
    this.store.transaction(() => {
      const artifact = this.require<Artifact>("artifact", candidateId);
      for (const check of this.all<Verification>("verification", {
        projectId: artifact.projectId,
      }).filter((v) => v.candidateId === candidateId && !v.invalidatedAt))
        this.store.put("verification", {
          ...check,
          invalidatedAt: now(),
          revision: check.revision + 1,
          updatedAt: now(),
        });
      for (const task of this.all<Task>("task", {
        projectId: artifact.projectId,
      }).filter((t) => t.candidateId === candidateId))
        this.save("task", {
          ...task,
          state: "changes-requested",
          detail: reason,
          revision: task.revision + 1,
          updatedAt: now(),
        });
      for (const workflow of this.all<Workflow>("workflow", {
        projectId: artifact.projectId,
      }).filter((w) =>
        w.taskIds.some(
          (id) => this.require<Task>("task", id).candidateId === candidateId,
        ),
      ))
        this.save("workflow", {
          ...workflow,
          state: "blocked",
          acceptance: null,
          revision: workflow.revision + 1,
          updatedAt: now(),
        });
      this.store.event("candidate.invalidated", {
        projectId: artifact.projectId,
        candidateId,
        reason,
      });
    });
  }
  private assertAcceptedLineage(
    workflow: Workflow,
    taskId: string,
    targetRevision: string,
  ): void {
    const visited = new Set<string>();
    let id = taskId;
    while (true) {
      if (visited.has(id))
        throw new Error("Task supersession contains a cycle.");
      visited.add(id);
      const task = this.require<Task>("task", id);
      if (
        task.workflowId !== workflow.id ||
        task.projectId !== workflow.projectId
      )
        throw new Error("Task supersession crosses a workflow boundary.");
      if (task.state === "accepted") {
        if (
          !task.candidateId ||
          this.require<Artifact>("artifact", task.candidateId)
            .targetRevision !== targetRevision
        )
          throw new Error(
            "Accepted task does not target the current candidate.",
          );
        this.assertTaskAcceptance(task);
        return;
      }
      const link = this.store.get<{
        workflowId: string;
        replacementTaskId: string;
        candidateId: string;
        mode?: "measured-selection";
        selectedSubmissionId?: string;
      }>("task-supersession", id);
      const predecessor = link
        ? this.store.get<Artifact>("artifact", link.candidateId)
        : undefined;
      const historicalCandidate = link
        ? this.store.get<{
            projectId: string;
            workflowId: string;
            revision: string;
          }>("candidate", link.candidateId)
        : undefined;
      const replacement = link
        ? this.store.get<Task>("task", link.replacementTaskId)
        : undefined;
      const selection =
        link?.mode === "measured-selection"
          ? this.store.get<AdvancedState>("advanced-workflow", workflow.id)
          : undefined;
      const selected = selection?.selectedSubmissionId
        ? this.store.get<FrozenSubmission>(
            "advanced-submission",
            selection.selectedSubmissionId,
          )
        : undefined;
      const measuredSelection = !!(
        selection &&
        selected &&
        predecessor &&
        replacement &&
        selection.projectId === workflow.projectId &&
        selection.template === workflow.template &&
        ["awaiting-acceptance", "accepted"].includes(selection.stage) &&
        link?.selectedSubmissionId === selected.id &&
        selected.projectId === workflow.projectId &&
        selected.workflowId === workflow.id &&
        selection.participants.some(
          (participant) =>
            participant.submissionId === selected.id &&
            participant.taskId === replacement.id,
        ) &&
        replacement.candidateId === predecessor.id &&
        predecessor.targetRevision === targetRevision &&
        selection.verificationIds.length > 0 &&
        selection.verificationIds.every((verificationId) => {
          const verification = this.store.get<Verification>(
            "verification",
            verificationId,
          );
          return (
            verification?.projectId === workflow.projectId &&
            verification.candidateId === predecessor.id &&
            verification.targetRevision === targetRevision &&
            verification.result === "passed" &&
            !verification.invalidatedAt
          );
        })
      );
      const historicalInput = !!(
        link &&
        predecessor &&
        historicalCandidate &&
        replacement &&
        link.mode === undefined &&
        link.candidateId === task.candidateId &&
        historicalCandidate.projectId === workflow.projectId &&
        historicalCandidate.workflowId === workflow.id &&
        historicalCandidate.revision === predecessor.targetRevision &&
        replacement.inputRefs.includes(predecessor.id)
      );
      if (
        task.state !== "cancelled" ||
        !link ||
        link.workflowId !== workflow.id ||
        !predecessor ||
        predecessor.projectId !== workflow.projectId ||
        !replacement ||
        replacement.projectId !== workflow.projectId ||
        replacement.workflowId !== workflow.id ||
        !workflow.taskIds.includes(replacement.id) ||
        (!historicalInput && !measuredSelection)
      )
        throw new Error(
          "Every required task needs current acceptance or an explicit verified replacement.",
        );
      // Repairs preserve historical input. A measured selection instead binds
      // the explicit selected submission and its current separate verification.
      id = link.replacementTaskId;
    }
  }
  private assertTaskAcceptance(task: Task): void {
    if (!task.candidateId)
      throw new Error("A current candidate is required for task acceptance.");
    const candidate = this.require<Artifact>("artifact", task.candidateId);
    const checks = this.all<Verification>("verification", {
      projectId: task.projectId,
    }).filter(
      (v) =>
        v.taskId === task.id &&
        v.candidateId === candidate.id &&
        v.targetRevision === candidate.targetRevision &&
        !v.invalidatedAt,
    );
    if (
      !checks.length ||
      checks.some((v) => v.result !== "passed" || !v.evidenceArtifactId)
    )
      throw new Error(
        "Current candidate-specific verification evidence is required for acceptance.",
      );
  }
  private expectRevision(record: { revision: number }, expected: number): void {
    if (record.revision !== expected)
      throw new Error("Record revision changed. Refresh before retrying.");
  }
}
