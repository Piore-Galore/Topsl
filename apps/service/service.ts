import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { Store } from "../../packages/persistence/store";
import { AssistedWorkflows } from "../../packages/workflows/assisted";
import {
  capabilitySatisfies,
  type RuntimeSelection,
} from "../../packages/providers/readiness";
import { WorkflowDrafts } from "../../packages/workflows/drafts";
import { SyncRepository } from "../../packages/sync/reconciler";
import { RevisionRepository } from "../../packages/context/revisions";
import { HistoryReconciler } from "../../packages/history/reconcile";
import type {
  NativeHistorySource,
  NativeProjectLink,
  SyncField,
} from "../../packages/domain/sync";
import type {
  AppId,
  AppState,
  Approval,
  ConfigurationPlan,
  ContextSnapshot,
  Conversation,
  Installation,
  LifecycleJob,
  LifecyclePlan,
  Message,
  Project,
  ProjectOpenResult,
  ServiceEvent,
} from "../../packages/domain/types";
import type { Command } from "../../packages/domain/commands";
import type { Observed } from "../../packages/domain/read-model";
import { round2Features } from "../../packages/domain/round2-features";
import { catalog, capabilities } from "../../packages/domain/catalog";
import {
  hash,
  now,
  safeError,
  stable,
  uid,
} from "../../packages/domain/invariants";
import {
  discover,
  describeInstallation,
  probeVersion,
} from "../../packages/applications/discovery";
import { Lifecycle } from "../../packages/applications/lifecycle";
import { RuntimeManager } from "../../packages/runtime/manager";
import { Coordinator } from "../../packages/runtime/coordinator";
import { ClaudeAdapter } from "../../packages/providers/claude";
import type {
  ProviderAdapter,
  ToolBinding,
} from "../../packages/providers/contract";
import { candidateTools } from "../../packages/context/candidate-tools";
import { BuilderReviewerWorkflow } from "../../packages/workflows/builder-reviewer";
import type {
  BuilderReviewerState,
  WorkflowFinding,
} from "../../packages/workflows/builder-reviewer";
import type { CandidateSnapshot } from "../../packages/workflows/candidates";
import {
  reuseCheckAuthorization,
  type CheckPlan,
} from "../../packages/workflows/verification";
import { CheckExecutions } from "../../packages/workflows/check-executions";
import {
  detectEnvironments,
  environmentSelection,
  PreparedEnvironments,
} from "../../packages/workflows/environments";
import { findingDecisions } from "../../packages/workflows/finding-decisions";
import { candidateDiff } from "../../packages/workflows/candidate-diff";
import {
  applyCandidateReview,
  candidateBinaryPreview,
  previewCandidateReview,
} from "../../packages/workflows/candidate-reviews";
import {
  ManagedWorkspaces,
  type WorkspacePlan,
} from "../../packages/workspace/managed";
import {
  ParallelSpecialists,
  type IntegrationPlan,
} from "../../packages/workflows/parallel-specialists";
import { AdvancedCollaboration } from "../../packages/workflows/advanced";
import { LocalReplication } from "../../packages/replication/local";
import type {
  ExecutionAttempt,
  Task,
  Workspace,
} from "../../packages/domain/workflow";
import { Configuration } from "../../packages/workspace/configuration";
import {
  importHistory,
  previewHandoff,
} from "../../packages/workspace/history";
import { ContextServer } from "../../packages/workspace/context";
import {
  ProjectSync,
  projectSourcePaths,
  requireProjectFolder,
} from "../../packages/workspace/projects";
import { desktopProjectRoute } from "../../packages/workspace/project-opening";
import {
  CodexProjectSync,
  orderLocalProjects,
} from "../../packages/workspace/codex-projects";

export interface TrustedInput {
  selectedPath?: string;
  selectedAppId?: AppId;
  digest?: string;
  approved?: boolean;
}
export class Service {
  readonly store: Store;
  readonly synchronization: SyncRepository;
  readonly revisions: RevisionRepository;
  readonly nativeHistory: HistoryReconciler;
  readonly lifecycle: Lifecycle;
  readonly runtime: RuntimeManager;
  readonly assisted: AssistedWorkflows;
  readonly coordinator: Coordinator;
  readonly checks: CheckExecutions;
  readonly workflows: BuilderReviewerWorkflow;
  readonly managedWorkspaces: ManagedWorkspaces;
  readonly parallel: ParallelSpecialists;
  readonly advanced: AdvancedCollaboration;
  readonly replication: LocalReplication;
  readonly configuration: Configuration;
  readonly context: ContextServer;
  readonly projects: ProjectSync;
  readonly codexProjects: CodexProjectSync;
  private timer?: ReturnType<typeof setInterval>;
  private ownershipTimer?: ReturnType<typeof setInterval>;
  private workflowTimer?: ReturnType<typeof setInterval>;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private discovery?: Promise<Installation[]>;
  private closing = false;
  private closePromise?: Promise<void>;
  private operations = new Set<Promise<unknown>>();
  private lastDiscoveryAt = 0;
  private publishedSequence = 0;
  private publishedActivity: boolean | undefined;
  private catalogDirty = true;
  /** Reader tools installed for review attempts that have not dispatched yet. */
  private readers = new Map<string, ToolBinding>();
  constructor(
    readonly directory: string,
    key: string,
    private emit: (event: ServiceEvent) => void,
    private isolatedTest = false,
    fixtureProviders?: Partial<Record<"codex" | "claude", ProviderAdapter>>,
    /** Test profiles only: where runtime qualifications run, outside the
     * temporary directory that holds the profile. */
    private qualificationDirectory?: string,
  ) {
    this.store = new Store(path.join(directory, "history.sqlite"), key);
    this.assisted = new AssistedWorkflows(this.store);
    this.synchronization = new SyncRepository(this.store);
    this.revisions = new RevisionRepository(this.store);
    this.nativeHistory = new HistoryReconciler(this.store);
    try {
      this.coordinator = new Coordinator(this.store, "local-profile");
    } catch (error) {
      this.store.close();
      throw error;
    }
    if (fixtureProviders && !isolatedTest) {
      this.coordinator.close();
      this.store.close();
      throw new Error(
        "Fixture provider injection is available only to the isolated local test constructor.",
      );
    }
    if (qualificationDirectory && !isolatedTest) {
      this.coordinator.close();
      this.store.close();
      throw new Error(
        "A separate qualification folder is available only to isolated test profiles.",
      );
    }
    this.checks = CheckExecutions.for(this.store);
    this.checks.recover();
    this.runtime = new RuntimeManager(
      this.store,
      emit,
      () => this.changed(),
      undefined,
      this.coordinator,
      { claude: new ClaudeAdapter(), ...fixtureProviders },
      !!(isolatedTest && fixtureProviders),
    );
    this.configuration = new Configuration(this.store, () =>
      this.runtime.hasActive(),
    );
    this.context = new ContextServer(this.store, directory);
    this.replication = new LocalReplication(this.store, {
      enabled:
        this.store.get<{ enabled: boolean }>(
          "preference",
          "optional-multi-device",
        )?.enabled ?? false,
    });
    this.workflows = new BuilderReviewerWorkflow(
      this.coordinator.repository,
      {
        capacity: (assignment, workflowId) =>
          this.coordinator.concurrency.available(
            assignment.provider,
            workflowId,
          ),
        capabilities: (assignment, installation, role = "implementer") => {
          const readiness = this.runtime.readiness(
            installation,
            assignment,
            role,
          );
          return {
            supported: readiness.ready,
            detail: readiness.ready
              ? "Selected role is ready under the current qualified runtime binding."
              : `Selected role is gated. ${readiness.blockers.map((b) => `${b.code}: ${b.detail}`).join(" ")}`,
          };
        },
        installCandidateReader: async ({ attempt, grant, candidate }) => {
          // Builders and repairs read their own workspace; only a reviewer's
          // fresh session gets the reader.
          if (this.store.get<Task>("task", attempt.taskId)?.role !== "reviewer")
            throw new Error(
              "Topsl installs the candidate reader only for review attempts.",
            );
          this.readers.set(
            attempt.id,
            candidateTools({
              context: this.context,
              grant,
              attempt,
              candidate,
            }),
          );
        },
        dispatch: async ({
          attempt,
          task,
          installation,
          project,
          context,
          mode,
        }) => {
          const tools = this.readers.get(attempt.id);
          this.readers.delete(attempt.id);
          this.replication.assertLocalOwner(project.id);
          const conversation: Conversation = {
            id: uid(),
            projectId: project.id,
            title: task.title,
            nativeSessions: {},
            createdAt: now(),
          };
          this.store.save("conversation", conversation);
          await this.runtime.start(
            installation,
            conversation,
            project,
            context.content,
            attempt.requestedModel!,
            mode,
            {
              attemptId: attempt.id,
              freshSession: true,
              ...(tools ? { tools } : {}),
            },
          );
        },
        interrupt: async (attempt) => {
          if (attempt.legacyRunId)
            await this.runtime.interrupt(attempt.legacyRunId);
        },
      },
      this.context,
      () => this.changed(),
    );
    this.managedWorkspaces = new ManagedWorkspaces(this.coordinator, directory);
    this.parallel = new ParallelSpecialists(
      this.coordinator,
      this.managedWorkspaces,
      {
        capabilities: (installation) => this.runtime.capabilities(installation),
        readiness: (installation, selection, role, required) =>
          this.runtime.readiness(installation, selection, role, required),
        dispatch: async ({ attempt, task, installation, project, context }) => {
          this.replication.assertLocalOwner(project.id);
          const conversation: Conversation = {
            id: uid(),
            projectId: project.id,
            title: task.title,
            nativeSessions: {},
            createdAt: now(),
          };
          this.store.save("conversation", conversation);
          await this.runtime.start(
            installation,
            conversation,
            project,
            context.text,
            attempt.requestedModel!,
            "edit",
            { attemptId: attempt.id, freshSession: true },
          );
        },
        interrupt: async (attempt) => {
          if (attempt.legacyRunId)
            await this.runtime.interrupt(attempt.legacyRunId);
        },
      },
      () => this.changed(),
    );
    this.advanced = new AdvancedCollaboration(
      this.coordinator,
      {
        capabilities: (installation) => this.runtime.capabilities(installation),
        readiness: (installation, selection, role, required) =>
          this.runtime.readiness(installation, selection, role, required),
        dispatch: async ({ attempt, task, installation, project, context }) => {
          if (task.role === "implementer")
            this.replication.assertLocalOwner(project.id);
          const conversation: Conversation = {
            id: uid(),
            projectId: project.id,
            title: task.title,
            nativeSessions: {},
            createdAt: now(),
          };
          this.store.save("conversation", conversation);
          await this.runtime.start(
            installation,
            conversation,
            project,
            context.text,
            attempt.requestedModel!,
            task.role === "implementer" ? "edit" : "review",
            { attemptId: attempt.id, freshSession: true },
          );
        },
        interrupt: async (attempt) => {
          if (attempt.legacyRunId)
            await this.runtime.interrupt(attempt.legacyRunId);
        },
        // Production adapters expose no independently enforced access-policy route.
      },
      {
        enabled:
          this.store.get<{ enabled: boolean }>(
            "preference",
            "optional-advanced",
          )?.enabled ?? false,
        changed: () => this.changed(),
        assertOwnerHost: (projectId, action) =>
          this.replication.assertLocalOwner(projectId, action),
      },
    );
    const projectPaths = isolatedTest
      ? projectSourcePaths(path.join(directory, "native-home"), {})
      : projectSourcePaths();
    this.projects = new ProjectSync(
      this.store,
      () => this.changed(true),
      projectPaths,
    );
    this.codexProjects = new CodexProjectSync(
      this.store,
      this.projects,
      directory,
      projectPaths.codexHome,
      () => this.changed(true),
    );
    this.lifecycle = new Lifecycle(this.store, directory, {
      installations: () => this.store.list("installation"),
      discover: () => this.discover(),
      active: (unit) => this.runtime.isUnitBusy(unit),
      changed: () => this.changed(true),
      nativeOpen: async (target) =>
        emit({ type: "native-open", data: { target } }),
    });
  }
  async start(): Promise<void> {
    this.workflowTimer = setInterval(() => {
      this.background(this.parallel.tick());
      for (const state of this.store.iterate<BuilderReviewerState>(
        "builder-reviewer",
      )) {
        if (
          ["ready-build", "ready-review", "ready-repair"].includes(
            state.stage,
          ) &&
          state.detail.startsWith("Waiting for capacity:")
        ) {
          const workflow = this.store.get<{ revision: number }>(
            "workflow",
            state.id,
          );
          if (workflow)
            this.background(
              this.workflows.advance(state.id, workflow.revision),
            );
          continue;
        }
        if (
          !state.activeAttemptId ||
          !["building", "reviewing", "repairing"].includes(state.stage)
        )
          continue;
        const attempt = this.store.get<ExecutionAttempt>(
          "attempt",
          state.activeAttemptId,
        );
        if (
          !attempt ||
          ["prepared", "starting", "running", "awaiting-approval"].includes(
            attempt.state,
          )
        )
          continue;
        if (
          attempt.state === "completed" &&
          this.coordinator.ownership.forAttempt(attempt.id)
        )
          continue;
        const workflow = this.store.get<{ revision: number }>(
          "workflow",
          state.id,
        );
        if (workflow)
          this.background(this.workflows.advance(state.id, workflow.revision));
      }
    }, 500);
    this.ownershipTimer = setInterval(() => {
      try {
        this.coordinator.ownership.heartbeat();
      } catch (error) {
        this.emit({
          type: "state",
          data: { ...this.state(), serviceError: safeError(error) },
        });
      }
    }, 10_000);
    await this.configuration.reconcile();
    await this.context.start();
    await this.refreshProjects();
    this.timer = setInterval(() => {
      this.background(this.refreshProjects());
      if (!this.isolatedTest) {
        this.background(this.lifecycle.tick());
        this.background(this.lifecycle.scheduledChecks());
        if (Date.now() - this.lastDiscoveryAt >= 5 * 60_000)
          this.background(this.discover());
      }
    }, 60_000);
    if (!this.isolatedTest) {
      await this.discover();
      this.background(this.lifecycle.scheduledChecks());
    }
    this.changed();
  }
  state(includeMessages = true): AppState {
    const codexProjectSync = this.codexProjects.state();
    return {
      locked: false,
      lockReason: null,
      platform: `${process.platform}/${process.arch}`,
      version: "0.1.2",
      theme: this.store.get<any>("preference", "theme")?.value ?? "paper",
      applications: catalog,
      capabilities,
      serviceError: null,
      installations: this.store.list("installation"),
      checks: this.store.list("check"),
      jobs: this.store.list("job"),
      projects: orderLocalProjects(
        this.store.list<Project>("project"),
        codexProjectSync.projects,
      ),
      projectSync: this.projects.state(),
      codexProjectSync,
      conversations: includeMessages ? this.store.list("conversation") : [],
      messages: includeMessages
        ? this.store
            .page<Message>("message", { limit: 80 })
            .items.map((message) => this.messagePreview(message))
        : [],
      runs: includeMessages ? this.store.list("run") : [],
      usage: includeMessages ? this.store.list("usage") : [],
      approvals: includeMessages ? this.store.list("approval") : [],
      terminals: includeMessages ? this.runtime.terminalState() : [],
      configurationWrites: this.store.list("configuration-write"),
    };
  }
  providerReadiness(input: {
    projectId: string;
    builder?: RuntimeSelection;
    reviewer?: RuntimeSelection;
  }) {
    this.require<Project>("project", input.projectId);
    const roles = {
      builder: input.builder
        ? this.runtime.readiness(
            this.installation(input.builder.installationId),
            input.builder,
            "implementer",
          )
        : null,
      reviewer: input.reviewer
        ? this.runtime.readiness(
            this.installation(input.reviewer.installationId),
            input.reviewer,
            "reviewer",
          )
        : null,
    };
    return this.observed(input.projectId, () => ({
      mode: "coordinated" as const,
      roles,
      runnable: !!(roles.builder?.ready && roles.reviewer?.ready),
      observedAt: now(),
    }));
  }
  async prepareAssistedHandoff(input: {
    projectId: string;
    workflowId: string;
    installationId: string;
    role: "builder" | "reviewer";
    exportApproved: true;
  }) {
    this.replication.assertLocalOwner(input.projectId);
    this.installation(input.installationId);
    const result = await this.assisted.prepare(input);
    this.changed();
    return result;
  }
  async openAssistedHandoff(input: { projectId: string; id: string }) {
    this.replication.assertLocalOwner(input.projectId);
    const handoff = this.assisted.get(input.projectId, input.id),
      project = await this.project(input.projectId),
      installation = this.installation(handoff.installationId);
    if (
      this.runtime.isProjectBusy(project.id) ||
      [
        ...this.store.iterate<any>("assisted-handoff-state", {
          projectId: project.id,
        }),
      ].some(
        (h) => h.state === "externally-controlled" && !h.externalWritingStopped,
      )
    )
      throw new Error(
        "Stop and reconcile the current managed/native writer before opening an assisted surface.",
      );
    this.assisted.beginOpen(input.projectId, input.id);
    this.changed();
    try {
      const result: ProjectOpenResult = installation.appId.endsWith("cli")
        ? {
            terminalId: await this.runtime.terminal(installation, project),
            projectPath: project.realPath,
            route: "terminal",
            detail:
              "Native surface opened. Paste the reviewed pinned handoff explicitly; progress and stopping are externally controlled.",
          }
        : await desktopProjectRoute(installation, project);
      this.assisted.opened(input.projectId, input.id, result.route);
      this.changed();
      return result;
    } catch (error) {
      this.assisted.openUncertain(input.projectId, input.id);
      this.changed();
      throw error;
    }
  }
  async importAssistedHandoff(input: {
    projectId: string;
    id: string;
    candidateRevision: string;
    specificationId: string;
    report: string;
    source: "user-supplied" | "native-import";
    externalWritingStopped: true;
  }) {
    this.replication.assertLocalOwner(input.projectId);
    const result = await this.assisted.import(input);
    this.changed();
    return result;
  }
  private changed(catalog = false): void {
    if (catalog) this.catalogDirty = true;
    if (this.closing || this.notificationTimer) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      if (!this.closing) {
        const page = this.store.controlPage(this.publishedSequence);
        if (page.throughSequence > this.publishedSequence) {
          this.emit({
            type: "changes",
            data: { ...page, epoch: this.coordinator.ownership.instanceId },
          });
          this.publishedSequence = page.throughSequence;
        }
        // Catalog compatibility snapshots are narrow. Streaming records use
        // durable metadata invalidations and project-scoped queries only.
        const catalogKinds = [
          "project",
          "installation",
          "check",
          "job",
          "configuration-write",
          "preference",
          "codex-native-project",
          "codex-project-sync",
        ];
        if (
          this.catalogDirty ||
          page.events.some((event) => catalogKinds.includes(event.kind))
        ) {
          this.catalogDirty = false;
          this.emit({ type: "state", data: this.state(false) });
        }
        const active = !!this.store.db
          .prepare(
            "SELECT 1 FROM documents WHERE (kind='run' AND json_extract(body,'$.status') IN ('starting','running','awaiting-approval')) OR (kind='job' AND json_extract(body,'$.state') IN ('downloading','verifying','applying')) LIMIT 1",
          )
          .get();
        if (active !== this.publishedActivity) {
          this.publishedActivity = active;
          this.emit({ type: "activity", data: { active } });
        }
        if (page.hasMore) this.changed();
      }
    }, 40);
  }
  private require<T>(kind: string, id: string): T {
    const value = this.store.get<T>(kind, id);
    if (!value) throw new Error(`The selected ${kind} no longer exists.`);
    return value;
  }
  /** Build mutually dependent slices and their watermark in one vault read snapshot. */
  private observed<T extends object>(
    projectId: string,
    read: () => T,
  ): Observed<T> {
    return this.store.transaction(() => ({
      ...read(),
      observation: {
        projectId,
        epoch: this.coordinator.ownership.instanceId,
        sequence: this.store.controlHead(),
        generatedAt: now(),
      },
    }));
  }
  private synchronizationSnapshot(projectId: string) {
    const inputs = [...this.store.iterate<Task>("task", { projectId })].map(
      (task) => ({
        taskId: task.id,
        ...this.revisions.inspectTaskInputs(task.id),
      }),
    );
    return {
      projectId,
      observations: this.synchronization.observations(projectId),
      fields: this.synchronization.fields(projectId),
      links: this.synchronization.links(projectId),
      sharedHeads: this.revisions.heads(projectId),
      sharedRevisions: this.revisions.revisions(projectId),
      historySources: this.nativeHistory.sources(projectId),
      configuration: this.synchronization.configuration(projectId),
      inputs,
    };
  }
  private candidateRetrievalSummary(projectId: string, workflowId: string) {
    const items: Array<Record<string, any>> = [];
    let total = 0;
    for (const receipt of this.store.iterate<Record<string, any>>(
      "candidate-retrieval",
      { projectId },
    )) {
      if (receipt.workflowId !== workflowId) continue;
      total++;
      // Keep bounded metadata only; grant identifiers and returned content do
      // not belong in renderer evidence. A receipt never proves comprehension.
      const {
        id,
        attemptId,
        candidateId,
        candidateRevision,
        method,
        path,
        offset,
        bytes,
        outcome,
        ranges,
        createdAt,
      } = receipt;
      items.push({
        id,
        attemptId,
        candidateId,
        candidateRevision,
        method,
        path,
        offset,
        bytes,
        outcome,
        ranges,
        createdAt,
      });
      items.sort(
        (a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)) ||
          String(b.id).localeCompare(String(a.id)),
      );
      if (items.length > 200) items.pop();
    }
    return { items, total, truncated: total > items.length };
  }
  private installation(id: string): Installation {
    return this.require("installation", id);
  }
  private async project(id: string): Promise<Project> {
    return requireProjectFolder(this.require<Project>("project", id));
  }
  private async refreshProjects(): Promise<void> {
    await this.projects.refresh();
    for (const project of this.store.iterate<Project>("project")) {
      try {
        this.coordinator.repository.ensureWorkspace(project);
      } catch {
        /* Missing/changed folders remain unverified; dispatch revalidates. */
      }
    }
    // A failed native API probe is visible in Projects and must not block vault startup.
    await this.codexProjects.refresh().catch(() => {});
  }
  async discover(): Promise<Installation[]> {
    if (this.discovery) return this.discovery;
    this.discovery = (async () => {
      const previous = this.store.list<Installation>("installation");
      const found = this.isolatedTest ? previous : await discover(previous);
      this.store.transaction(() => {
        for (const old of previous)
          if (!found.some((i) => i.id === old.id))
            this.store.remove("installation", old.id);
        for (const i of found) {
          const old = previous.find((p) => p.id === i.id);
          this.store.put("installation", i);
          this.store.immutable("installation-revision", {
            id: i.revisionId,
            installationId: i.id,
            identity: i.identity,
            version: i.version,
            path: i.realPath,
            owner: i.owner,
            channel: i.channel,
          });
          if (old && old.revisionId !== i.revisionId)
            this.store.event("installation.external-change", {
              installationId: i.id,
              from: old.revisionId,
              to: i.revisionId,
            });
        }
      });
      this.lastDiscoveryAt = Date.now();
      this.changed();
      return found;
    })();
    try {
      return await this.discovery;
    } finally {
      this.discovery = undefined;
    }
  }
  review(
    kind:
      | "plan"
      | "configuration-plan"
      | "approval"
      | "workflow-check-plan"
      | "workflow-acceptance"
      | "workspace-plan"
      | "integration-plan"
      | "parallel-acceptance"
      | "advanced-acceptance"
      | "replication-plan"
      | "replication-conflict"
      | "workflow-dispatch-inputs"
      | "candidate-review-plan"
      | "advanced-review-plan",
    id: string,
  ): LifecyclePlan | ConfigurationPlan | Approval | CheckPlan | unknown {
    if (kind === "workflow-dispatch-inputs") {
      const state = this.require<BuilderReviewerState>("builder-reviewer", id),
        workflow = this.require<{ revision: number; objective: string }>(
          "workflow",
          id,
        ),
        candidate = this.require<CandidateSnapshot>(
          "candidate",
          state.candidateId,
        );
      const body = {
        workflowId: id,
        projectId: state.projectId,
        expectedRevision: workflow.revision,
        objective: workflow.objective,
        specificationId: state.specificationId,
        builder: state.builder,
        reviewer: state.reviewer,
        workspace: candidate.sourceRoot,
        baseRevision: candidate.baseRevision,
        candidateRevision: candidate.revision,
        files: candidate.files.map((file) => ({
          path: file.path,
          hash: file.hash,
          bytes: file.bytes,
        })),
        omissions: candidate.omissions,
        selection: state.selection,
      };
      return { ...body, digest: hash(stable(body)) };
    }
    if (kind === "advanced-acceptance")
      return {
        id,
        state: this.advanced.state(id),
        digest: this.advanced.acceptanceDigest(id),
      };
    if (kind === "replication-conflict")
      return this.replication.conflictPreview(id);
    if (kind === "parallel-acceptance") {
      const state = this.parallel.state(id);
      return {
        id,
        state,
        digest: this.parallel.acceptanceDigest(id),
        combinedCandidate: state.combinedCandidateId
          ? this.require("candidate", state.combinedCandidateId)
          : null,
      };
    }
    if (kind === "workflow-acceptance") {
      const state = this.require<BuilderReviewerState>("builder-reviewer", id),
        candidate = this.require<CandidateSnapshot>(
          "candidate",
          state.candidateId,
        );
      return {
        id,
        objective: this.require<{ objective: string }>("workflow", id)
          .objective,
        targetRevision: candidate.revision,
        digest: this.workflows.acceptanceDigest(id),
        detail: state.detail,
        reviewArtifactId: state.reviewArtifactId,
        findings: state.findings.map((id) =>
          this.require<WorkflowFinding>("workflow-finding", id),
        ),
        checks: this.workflows.list(state.projectId).find((w) => w.id === id)
          ?.checksStatus,
        isolation: state.isolation,
      };
    }
    return this.require(kind, id);
  }
  command(command: Command, trusted: TrustedInput = {}): Promise<any> {
    if (this.closing)
      return Promise.reject(
        new Error("The service is shutting down; new commands are stopped."),
      );
    const operation = this.commandOwned(command, trusted);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
  private background(operation: Promise<unknown>): void {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
  }
  private async commandOwned(
    command: Command,
    trusted: TrustedInput = {},
  ): Promise<any> {
    this.coordinator.ownership.assertOwner();
    if (!("requestId" in command)) {
      const result = await this.dispatchCommand(command, trusted);
      if (
        /^(theme|discover|trust-installation|select-runtime|runtime-(connect|models|account)|lifecycle-|project-|codex-project-|configuration-apply)/.test(
          command.type,
        )
      )
        this.changed(true);
      return result;
    }
    const digest = hash(stable(command));
    const existing = this.store.get<any>("command-receipt", command.requestId);
    if (existing) {
      if (existing.digest !== digest)
        throw new Error("Request identity was reused with changed parameters.");
      if (existing.state === "completed") return existing.result;
      throw new Error(
        existing.error ??
          "This request is pending or its outcome is unknown. Inspect recorded state before issuing a replacement request.",
      );
    }
    this.store.put("command-receipt", {
      id: command.requestId,
      digest,
      state: "prepared",
      createdAt: now(),
    });
    try {
      const result = await this.dispatchCommand(command, trusted);
      this.store.put("command-receipt", {
        id: command.requestId,
        digest,
        state: "completed",
        result: result ?? null,
        completedAt: now(),
      });
      return result;
    } catch (error) {
      this.store.put("command-receipt", {
        id: command.requestId,
        digest,
        state: "failed",
        error: safeError(error),
        completedAt: now(),
      });
      throw error;
    }
  }
  private messagePreview(message: Message) {
    return {
      ...message,
      text: message.text.slice(0, 6000),
      totalChars: message.text.length,
      truncated: message.text.length > 6000,
    };
  }
  private assertCommandOwner(command: Command) {
    let projectId: string | undefined,
      action: "execution" | "integration" = "execution";
    if (
      [
        "builder-reviewer-create",
        "workflow-create",
        "task-create",
        "terminal-open",
        "project-open",
      ].includes(command.type)
    )
      projectId = (command as { projectId: string }).projectId;
    else if (
      [
        "builder-reviewer-advance",
        "builder-reviewer-specification-restart",
        "builder-reviewer-accept",
      ].includes(command.type)
    )
      projectId = this.require<{ projectId: string }>(
        "builder-reviewer",
        (command as { id: string }).id,
      ).projectId;
    else if (["parallel-create"].includes(command.type))
      projectId = this.require<{ projectId: string }>(
        "workflow",
        (command as { workflowId: string }).workflowId,
      ).projectId;
    else if (
      [
        "parallel-dispatch",
        "parallel-integration-preview",
        "parallel-accept",
      ].includes(command.type)
    ) {
      projectId = this.require<{ projectId: string }>(
        "parallel-specialists",
        (command as { id: string }).id,
      ).projectId;
      if (command.type !== "parallel-dispatch") action = "integration";
    } else if (command.type === "parallel-integration-apply") {
      projectId = this.require<{ projectId: string }>(
        "integration-plan",
        command.id,
      ).projectId;
      action = "integration";
    } else if (command.type === "task-run")
      projectId = this.require<Task>("task", command.id).projectId;
    else if (command.type === "run-start")
      projectId = this.require<Conversation>(
        "conversation",
        command.conversationId,
      ).projectId;
    if (projectId) this.replication.assertLocalOwner(projectId, action);
  }
  private async dispatchCommand(
    command: Command,
    trusted: TrustedInput,
  ): Promise<any> {
    this.coordinator.ownership.assertOwner();
    this.assertCommandOwner(command);
    switch (command.type) {
      case "environment-selection-create": {
        const project = this.require<Project>("project", command.projectId);
        if (!project.trusted)
          throw new Error(
            "Trust this project before defining an execution recipe.",
          );
        const { type: _, requestId: __, ...selection } = command;
        return environmentSelection(this.store, selection);
      }
      case "check-authorization-reuse-preview": {
        const authorization = this.require<any>(
          "check-authorization-definition",
          command.id,
        );
        if (authorization.projectId !== command.projectId)
          throw new Error("Execution authorization is outside this project.");
        return reuseCheckAuthorization(
          this.store,
          command.id,
          command.candidateId,
          command.taskId,
        );
      }
      case "environment-detect": {
        const project = this.require<Project>("project", command.projectId);
        if (!project.trusted)
          throw new Error(
            "Trust this project before detecting executable recipes.",
          );
        return detectEnvironments(this.store, project);
      }
      case "environment-instances-query":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          new PreparedEnvironments(this.store).list(command.projectId),
        );
      case "environment-instance-inspect":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          new PreparedEnvironments(this.store).inspect(
            command.projectId,
            command.id,
          ),
        );
      case "check-authorization-revoke": {
        const authorization = this.require<any>(
          "check-authorization-definition",
          command.id,
        );
        if (authorization.projectId !== command.projectId)
          throw new Error("Execution authorization is outside this project.");
        this.store.put("check-authorization-revoked", {
          id: command.id,
          projectId: command.projectId,
          revokedAt: now(),
        });
        this.changed();
        return null;
      }
      case "round-2-features-query":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () => ({
          features: round2Features(this.store),
        }));
      case "workflow-readiness-query":
        return this.providerReadiness(command);
      case "assisted-handoff-prepare":
        return this.prepareAssistedHandoff(command);
      case "assisted-handoff-open":
        return this.openAssistedHandoff(command);
      case "assisted-handoff-import":
        return this.importAssistedHandoff(command);
      case "assisted-handoff-query":
        return this.assisted.query(command.projectId, command.workflowId);
      case "workflow-draft-query":
        return this.observed(command.projectId, () => ({
          draft: new WorkflowDrafts(this.store).query(
            command.projectId,
            command.workflowId,
          ),
        }));
      case "workflow-draft-save": {
        const draft = new WorkflowDrafts(this.store).save(
          command.projectId,
          command.workflowId,
          command.expectedRevision,
          command.draft,
        );
        this.changed();
        return this.observed(command.projectId, () => ({ draft }));
      }
      case "workflow-draft-delete":
        new WorkflowDrafts(this.store).delete(
          command.projectId,
          command.workflowId,
          command.expectedRevision,
        );
        this.changed();
        return null;
      case "usage-budget-query":
        this.require<Project>("project", command.projectId);
        return this.observed(
          command.projectId,
          () =>
            this.store.get(
              "preference",
              `usage-budget:${command.projectId}`,
            ) ?? {
              tokens: null,
              wallMs: null,
            },
        );
      case "usage-budget-save":
        this.require<Project>("project", command.projectId);
        this.store.put("preference", {
          id: `usage-budget:${command.projectId}`,
          projectId: command.projectId,
          tokens: command.tokens,
          wallMs: command.wallMs,
        });
        this.changed();
        return { tokens: command.tokens, wallMs: command.wallMs };
      case "advanced-query":
        return this.observed(command.projectId, () =>
          this.advanced.status(command.projectId),
        );
      case "advanced-check-preview":
        return this.advanced.previewCheck(
          command.id,
          command.expectedRevision,
          command.submissionId,
          command.definition,
          command.candidateId,
        );
      case "advanced-check-apply":
        if (!trusted.digest)
          throw new Error(
            "Advanced process checks require native approval of the exact frozen inputs and command.",
          );
        return this.advanced.runCheck(command.id, trusted.digest);
      case "advanced-test-candidate-capture":
        return this.advanced.captureVerificationCandidate(
          command.id,
          command.expectedRevision,
          command.workspaceId,
          command.selectedPaths,
          command.approvedUntracked,
        );
      case "advanced-review-preview":
        return this.advanced.previewProposalReview(
          command.id,
          command.expectedRevision,
        );
      case "advanced-review-confirm":
        if (!trusted.digest)
          throw new Error(
            "Manual proposal verification requires native review of the exact frozen proposal and rubric.",
          );
        return this.advanced.confirmProposalReview(command.id, trusted.digest);
      case "advanced-capture":
        return this.advanced.capture(
          command.id,
          command.expectedRevision,
          command.key,
          command.approvedUntracked,
        );
      case "optional-feature-set": {
        this.store.put("preference", {
          id: `optional-${command.feature}`,
          enabled: command.enabled,
        });
        const result =
          command.feature === "advanced"
            ? this.advanced.setEnabled(command.enabled)
            : this.replication.setEnabled(command.enabled);
        this.changed();
        return result;
      }
      case "advanced-create": {
        const { type: _, requestId: __, ...input } = command;
        return this.advanced.create(input);
      }
      case "advanced-dispatch":
        return this.advanced.dispatch(
          command.id,
          command.expectedRevision,
          command.key,
        );
      case "advanced-freeze":
        return this.advanced.freeze(
          command.id,
          command.expectedRevision,
          command.key,
          command.artifactId,
        );
      case "advanced-submissions":
        return this.advanced.submissions(command.id);
      case "advanced-evaluate":
        return this.advanced.evaluate(
          command.id,
          command.expectedRevision,
          command.submissionId,
          command.measurements,
        );
      case "advanced-select":
        return this.advanced.select(
          command.id,
          command.expectedRevision,
          command.submissionId,
        );
      case "advanced-bind-verification":
        return this.advanced.bindVerification(
          command.id,
          command.expectedRevision,
          command.verificationIds,
          command.frozenTestSubmissionId,
        );
      case "advanced-checkpoint":
        return this.advanced.checkpoint(
          command.id,
          command.expectedRevision,
          command.nextDriverKey,
          command.reproductionVerificationId,
          command.experimentArtifactId,
        );
      case "advanced-accept":
        if (!trusted.digest)
          throw new Error(
            "Advanced acceptance requires explicit native review of current frozen evidence.",
          );
        return this.advanced.accept(
          command.id,
          command.expectedRevision,
          trusted.digest,
        );
      case "routing-preset-save":
        return this.advanced.savePreset(command);
      case "routing-measure":
        return this.advanced.measureRouting(
          command.presetId,
          command.taskId,
          command.escapedDefects,
        );
      case "replication-query":
        return command.projectId
          ? this.observed(command.projectId, () =>
              this.replication.status(command.projectId),
            )
          : this.replication.status();
      case "replication-device-preview":
        return this.replication.previewDevice(
          command.identity,
          command.approvedProjectIds,
        );
      case "replication-mapping-preview":
        if (!trusted.selectedPath)
          throw new Error(
            "Select the local mapping folder in the native dialog.",
          );
        return this.replication.previewMapping(
          command.projectId,
          command.logicalWorkspaceId,
          trusted.selectedPath,
        );
      case "replication-owner-preview":
        return this.replication.previewOwner(command.projectId);
      case "replication-stage-preview":
        return this.replication.previewStage(
          command.recordId,
          command.projectId,
          command.content,
        );
      case "replication-export-preview":
        return this.replication.previewExport(
          command.targetDeviceId,
          command.recordIds,
        );
      case "replication-plan-apply": {
        if (!trusted.digest)
          throw new Error(
            "Replication requires native approval of this exact preview.",
          );
        const plan = this.require<{
          kind: "device" | "mapping" | "owner" | "stage" | "export";
        }>("replication-plan", command.id);
        if (plan.kind === "device")
          return this.replication.approveDevice(command.id, trusted);
        if (plan.kind === "mapping")
          return this.replication.approveMapping(command.id, trusted);
        if (plan.kind === "owner")
          return this.replication.approveOwner(command.id, trusted);
        if (plan.kind === "export")
          return this.replication.exportApproved(command.id, trusted);
        const record = this.replication.approveStage(command.id, trusted);
        // Request receipts retain only identifiers/revisions, never a second portable content copy.
        return {
          id: record.id,
          projectId: record.projectId,
          revision: record.revision,
          kind: record.content.kind,
        };
      }
      case "replication-chunk":
        return this.replication.outgoingChunk(command.id, command.index);
      case "replication-import-begin":
        return this.replication.beginImport(command.manifest);
      case "replication-import-chunk":
        return this.replication.receiveChunk(command.id, command.chunk);
      case "replication-import-complete":
        return this.replication.completeImport(command.id);
      case "replication-conflict-preview":
        return this.replication.conflictPreview(command.id);
      case "replication-conflict-resolve": {
        const record = this.replication.resolveConflict(
          command.id,
          command.choice,
          trusted,
        );
        return {
          id: record.id,
          projectId: record.projectId,
          revision: record.revision,
        };
      }
      case "replication-delete":
        if (!trusted.approved)
          throw new Error("Deletion propagation requires native confirmation.");
        this.replication.deleteRecord(command.recordId, command.projectId);
        return null;
      case "replication-device-revoke":
        if (!trusted.approved)
          throw new Error("Device revocation requires native confirmation.");
        this.replication.revokeDevice(command.deviceId);
        return null;
      case "history-message": {
        const message = this.require<Message>("message", command.id);
        if (message.projectId !== command.projectId)
          throw new Error("Message belongs to another project.");
        const end = command.offset + command.limit;
        return {
          ...message,
          text: message.text.slice(command.offset, end),
          totalChars: message.text.length,
          offset: command.offset,
          nextOffset: end < message.text.length ? end : null,
        };
      }
      case "navigation-query":
        return (
          this.store.get("preference", "navigation") ?? {
            projectId: null,
            workflowId: null,
            projectView: "overview",
          }
        );
      case "navigation-save":
        const previous = this.store.get<any>("preference", "navigation");
        this.store.put("preference", {
          id: "navigation",
          projectId: command.projectId,
          workflowId:
            command.workflowId ??
            (previous?.projectId === command.projectId
              ? previous.workflowId
              : null),
          projectView: command.projectView,
        });
        return null;
      case "scope-events":
        this.require<Project>("project", command.projectId);
        return {
          ...this.store.controlPage(
            command.afterSequence,
            command,
            command.limit,
          ),
          epoch: this.coordinator.ownership.instanceId,
        };
      case "history-page": {
        this.require<Project>("project", command.projectId);
        const options = {
          conversationId: command.conversationId,
          cursor: command.cursor,
          limit: command.limit,
        };
        const page =
          command.query === undefined
            ? this.store.messagesPage({
                ...options,
                projectId: command.projectId,
              })
            : this.store.searchPage(command.projectId, command.query, options);
        return this.observed(command.projectId, () => ({
          ...page,
          items: page.items.map((message) => this.messagePreview(message)),
        }));
      }
      case "history-conversations":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          this.store.page("conversation", {
            projectId: command.projectId,
            cursor: command.cursor,
            limit: command.limit,
          }),
        );
      case "scope-snapshot":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () => ({
          sequence: this.store.controlHead(),
          epoch: this.coordinator.ownership.instanceId,
          projectId: command.projectId,
          generatedAt: now(),
          coordination: this.coordinator.snapshot(command.projectId),
          synchronization: this.synchronizationSnapshot(command.projectId),
          conversations: this.store.page("conversation", {
            projectId: command.projectId,
            limit: 200,
          }).items,
          conversationCursor: this.store.page("conversation", {
            projectId: command.projectId,
            limit: 200,
          }).nextCursor,
          runs: this.store.page("run", {
            projectId: command.projectId,
            limit: 200,
          }).items,
          approvals: this.store.db
            .prepare(
              "SELECT a.body FROM documents a JOIN documents r ON r.kind='run' AND r.id=json_extract(a.body,'$.runId') WHERE a.kind='approval' AND json_extract(r.body,'$.projectId')=? ORDER BY a.rowid DESC LIMIT 100",
            )
            .all(command.projectId)
            .map((row) => JSON.parse(row.body)),
          terminals: this.runtime
            .terminalState()
            .filter((terminal) => terminal.projectId === command.projectId),
          usage: this.store.db
            .prepare(
              "SELECT u.body FROM documents u JOIN documents r ON r.kind='run' AND r.id=json_extract(u.body,'$.runId') WHERE u.kind='usage' AND json_extract(r.body,'$.projectId')=? ORDER BY u.rowid DESC LIMIT 500",
            )
            .all(command.projectId)
            .map((row) => JSON.parse(row.body)),
          messages: ((page) => ({
            ...page,
            items: page.items.map((message) => this.messagePreview(message)),
          }))(
            this.store.messagesPage({
              projectId: command.projectId,
              conversationId: command.conversationId,
              limit: 80,
            }),
          ),
        }));
      case "managed-workspaces-query":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () => ({
          workspaces: this.managedWorkspaces.list(command.projectId),
          concurrency: this.coordinator.concurrency.snapshot(),
        }));
      case "workspace-create-preview":
        return this.managedWorkspaces.previewCreate(command);
      case "workspace-remove-preview":
        return this.managedWorkspaces.previewRemove(command.id);
      case "workspace-plan-apply":
        if (!trusted.digest)
          throw new Error(
            "Workspace creation/cleanup requires native approval of this exact input snapshot and filesystem operation.",
          );
        return this.managedWorkspaces.apply(command.id, trusted.digest);
      case "parallel-create":
        return this.parallel.create(command);
      case "parallel-query":
        this.require<Project>("project", command.projectId);
        for (const state of this.parallel.list(command.projectId))
          await this.parallel.observe(state.id);
        return this.observed(command.projectId, () => ({
          workflows: this.parallel.list(command.projectId),
          queue: this.coordinator.repository.all("integration-submission", {
            projectId: command.projectId,
          }),
          concurrency: this.coordinator.concurrency.snapshot(),
        }));
      case "parallel-dispatch":
        return this.parallel.dispatch(
          command.id,
          command.expectedRevision,
          command.key,
        );
      case "parallel-submit":
        return this.parallel.submit(
          command.id,
          command.expectedRevision,
          command.key,
          command.approvedUntracked,
        );
      case "parallel-integration-preview":
        return this.parallel.previewIntegration(
          command.id,
          command.expectedRevision,
          command.resolutions,
        );
      case "parallel-integration-apply":
        if (!trusted.digest)
          throw new Error(
            "Integration requires native approval of exact submitted candidates and conflict resolutions.",
          );
        return this.parallel.applyIntegration(command.id, trusted.digest);
      case "parallel-checks-preview":
        return this.parallel.previewChecks(
          command.id,
          command.expectedRevision,
        );
      case "parallel-check-apply":
        if (!trusted.digest)
          throw new Error(
            "Combined checks require native approval of the exact command and revision.",
          );
        return this.parallel.runCheck(command.id, trusted.digest);
      case "parallel-accept":
        if (!trusted.digest)
          throw new Error(
            "Combined acceptance requires explicit native confirmation of current evidence.",
          );
        return this.parallel.accept(
          command.id,
          command.expectedRevision,
          trusted.digest,
        );
      case "parallel-cancel": {
        const result = await this.parallel.cancel(
          command.id,
          command.expectedRevision,
        );
        this.checks.cancelWorkflow(command.id);
        return result;
      }
      case "sync-field-push": {
        if (!trusted.approved)
          throw new Error(
            "Native field writes require review of their exact value, direction and source revision.",
          );
        const field = this.require<SyncField>("sync-field", command.id);
        if (
          field.projectId !== command.projectId ||
          field.revision !== command.expectedRevision ||
          field.state !== "push-required" ||
          field.field !== "name" ||
          typeof field.local !== "string" ||
          !/^[^\x00-\x1f\x7f]{1,200}$/.test(field.local)
        )
          throw new Error(
            "Refresh and explicitly resolve a supported native name before pushing local intent.",
          );
        const link = this.require<NativeProjectLink>(
          "native-project-link",
          field.targetId,
        );
        if (
          link.projectId !== field.projectId ||
          link.provider !== "codex" ||
          link.state !== "linked" ||
          link.profileId !== this.codexProjects.boundProfileId()
        )
          throw new Error(
            "This native write route or exact profile binding is unavailable. No fallback operation was sent.",
          );
        await this.codexProjects.rename(
          link.nativeGroupId,
          link.sourceRevision,
          field.local,
        );
        const result = this.require<SyncField>("sync-field", field.id);
        this.changed();
        return {
          field: result,
          detail:
            "Supported registry readback recorded; visible native sidebar remains a separate observation.",
        };
      }
      case "synchronization-query": {
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          this.synchronizationSnapshot(command.projectId),
        );
      }
      case "sync-field-intent": {
        const field = this.require<SyncField>("sync-field", command.id);
        if (
          field.projectId !== command.projectId ||
          field.authority === "provider"
        )
          throw new Error(
            "This field belongs to another project or is provider-owned.",
          );
        const result = this.synchronization.reconcileField({
          ...field,
          expectedRevision: command.expectedRevision,
          local: command.local,
          authority: command.authority,
          evidence: {
            level: "topsl-transaction",
            source: "explicit-local-field-intent",
            observedAt: now(),
            detail:
              "User selected field intent and ownership; provider write/readback remains separate.",
          },
        });
        if (field.field === "name" && typeof command.local === "string")
          this.store.save("project", {
            ...this.require<Project>("project", command.projectId),
            name: command.local,
          });
        this.changed();
        return result;
      }
      case "sync-field-resolve": {
        const field = this.require<SyncField>("sync-field", command.id);
        if (field.projectId !== command.projectId)
          throw new Error("Synchronization field belongs to another project.");
        const result = this.synchronization.resolveField(
          command.id,
          command.expectedRevision,
          command.direction,
        );
        if (field.field === "name" && typeof result.local === "string")
          this.store.save("project", {
            ...this.require<Project>("project", command.projectId),
            name: result.local,
          });
        this.changed();
        return result;
      }
      case "native-link-state":
      case "native-root-map": {
        const link = this.require<NativeProjectLink>(
          "native-project-link",
          command.id,
        );
        if (link.projectId !== command.projectId)
          throw new Error("Native project link belongs to another project.");
        const result =
          command.type === "native-link-state"
            ? this.synchronization.setLinkState(
                command.id,
                command.expectedRevision,
                command.state,
              )
            : this.synchronization.mapNativeRoot(
                command.id,
                command.expectedRevision,
                command.nativeRoot,
                command.workspaceId,
              );
        this.changed();
        return result;
      }
      case "shared-revision-publish": {
        this.require<Project>("project", command.projectId);
        if (command.recordId.startsWith("workflow-specification:"))
          throw new Error(
            "Use the workflow specification publish action to update workflow requirements.",
          );
        const result = this.revisions.publish(command);
        this.changed();
        return result;
      }
      case "task-inputs-inspect":
      case "task-context-bind": {
        const task = this.require<Task>("task", command.id);
        if (task.projectId !== command.projectId)
          throw new Error("Task belongs to another project.");
        if (command.type === "task-inputs-inspect")
          return this.observed(command.projectId, () =>
            this.revisions.inspectTaskInputs(task.id),
          );
        if (
          task.revision !== command.expectedRevision ||
          !["draft", "ready", "blocked"].includes(task.state)
        )
          throw new Error(
            "Only an inactive task with the current revision can bind a new immutable context.",
          );
        const result = this.revisions.bindPackage(
          task.id,
          command.contextPackageId,
          null,
          command.references,
        );
        this.changed();
        return result;
      }
      case "builder-reviewer-specification-publish": {
        const result = this.workflows.publishSpecification(
          command.id,
          command.expectedRevision,
          {
            objective: command.objective,
            acceptanceCriteria: command.acceptanceCriteria,
            interfaces: command.interfaces,
          },
        );
        this.changed();
        return result;
      }
      case "builder-reviewer-specification-restart": {
        const result = await this.workflows.restartForSpecification(
          command.id,
          command.expectedRevision,
          command.specificationId,
        );
        this.changed();
        return result;
      }
      case "native-history-approve": {
        if (!trusted.selectedPath || !trusted.approved)
          throw new Error(
            "Explicit native transcript selection and approval are required for each source/profile.",
          );
        const source = await this.nativeHistory.approve({
          project: await this.project(command.projectId),
          provider: command.provider,
          profileId: command.profileId,
          sessionId: command.sessionId,
          file: trusted.selectedPath,
        });
        this.changed();
        return source;
      }
      case "native-history-reconcile":
      case "native-history-pause": {
        const source = this.require<NativeHistorySource>(
          "native-history-source",
          command.id,
        );
        if (
          source.projectId !== command.projectId ||
          source.revision !== command.expectedRevision
        )
          throw new Error(
            "History source scope or revision changed; refresh before this operation.",
          );
        const result =
          command.type === "native-history-pause"
            ? this.nativeHistory.pause(source.id, command.expectedRevision)
            : await this.nativeHistory.reconcile(source.id);
        this.changed();
        return result;
      }
      case "builder-reviewer-query":
        this.require<Project>("project", command.projectId);
        for (const state of this.coordinator.repository.all<BuilderReviewerState>(
          "builder-reviewer",
          { projectId: command.projectId },
        ))
          await this.workflows.observe(state.id);
        return this.observed(command.projectId, () => ({
          workflows: this.workflows.list(command.projectId).map((workflow) => ({
            ...workflow,
            objective: this.require<{ objective: string }>(
              "workflow",
              workflow.id,
            ).objective,
            latestSpecificationId:
              this.revisions.head(
                command.projectId,
                `workflow-specification:${workflow.id}`,
              )?.revisionId ?? workflow.specificationId,
          })),
          runtimes: this.store
            .list<Installation>("installation")
            .filter((i) =>
              ["openai.codex-cli", "anthropic.claude-code-cli"].includes(
                i.appId,
              ),
            )
            .map((i) => ({
              installation: i,
              capabilities: this.runtime.capabilities(i),
            })),
          checkRuntime: process.execPath,
        }));
      case "builder-reviewer-inspect": {
        const state = this.require<BuilderReviewerState>(
          "builder-reviewer",
          command.id,
        );
        return this.observed(state.projectId, () => ({
          state,
          candidate: this.require("candidate", state.candidateId),
          diff: candidateDiff(
            this.store,
            this.require<CandidateSnapshot>("candidate", state.baselineId),
            this.require<CandidateSnapshot>("candidate", state.candidateId),
          ),
          candidateArtifactReviews: {
            outputs: [
              ...this.store.iterate<{ candidateId: string }>(
                "candidate-output-review",
                { projectId: state.projectId },
              ),
            ].filter((receipt) => receipt.candidateId === state.candidateId),
            binaries: [
              ...this.store.iterate<{ candidateId: string }>(
                "candidate-binary-review",
                { projectId: state.projectId },
              ),
            ].filter((receipt) => receipt.candidateId === state.candidateId),
          },
          candidateRetrievals: this.candidateRetrievalSummary(
            state.projectId,
            state.id,
          ),
          findings: state.findings.map((id) =>
            this.require("workflow-finding", id),
          ),
          findingDecisions: findingDecisions(
            this.store,
            state.projectId,
            state.id,
          ),
          checkExecutions: this.checks
            .list(state.projectId)
            .executions.filter(
              (execution) => execution.workflowId === state.id,
            ),
          runtimeMetadata: [
            ...this.store.iterate<{ attemptId: string }>(
              "runtime-turn-metadata",
              { projectId: state.projectId },
            ),
          ].filter(
            (metadata) =>
              this.store.get<Task>(
                "task",
                this.store.get<ExecutionAttempt>("attempt", metadata.attemptId)
                  ?.taskId ?? "",
              )?.workflowId === state.id,
          ),
          runtimeResultMetadata: [
            ...this.store.iterate<{ id: string; attemptId?: string }>(
              "runtime-turn-result-metadata",
              { projectId: state.projectId },
            ),
          ].filter(
            (metadata) =>
              this.store.get<Task>(
                "task",
                this.store.get<ExecutionAttempt>(
                  "attempt",
                  metadata.attemptId ?? metadata.id,
                )?.taskId ?? "",
              )?.workflowId === state.id,
          ),
          contexts: this.coordinator.repository
            .all("task-context-package", { projectId: state.projectId })
            .filter((c: any) => c.workflowId === state.id),
          deliveries: this.coordinator.repository
            .all("task-context-delivery", { projectId: state.projectId })
            .filter(
              (d: any) =>
                this.store.get<any>("attempt", d.attemptId)?.taskId &&
                this.store.get<any>(
                  "task",
                  this.store.get<any>("attempt", d.attemptId).taskId,
                )?.workflowId === state.id,
            ),
        }));
      }
      case "workflow-finding-decide": {
        const state = this.require<BuilderReviewerState>(
          "builder-reviewer",
          command.id,
        );
        if (state.projectId !== command.projectId)
          throw new Error("Finding belongs to another project.");
        this.replication.assertLocalOwner(command.projectId);
        const result = this.workflows.decideFinding(command);
        this.changed();
        return result;
      }
      case "candidate-diff-query": {
        this.require<Project>("project", command.projectId);
        const candidate = this.require<CandidateSnapshot>(
          "candidate",
          command.candidateId,
        );
        const baseline = this.require<CandidateSnapshot>(
          "candidate",
          command.baseCandidateId,
        );
        if (
          candidate.projectId !== command.projectId ||
          candidate.workflowId !== command.workflowId ||
          baseline.projectId !== command.projectId ||
          baseline.workflowId !== command.workflowId
        )
          throw new Error(
            "Candidate diff belongs to another project or workflow.",
          );
        return this.observed(command.projectId, () =>
          candidateDiff(this.store, baseline, candidate, command),
        );
      }
      case "candidate-review-preview":
        this.require<Project>("project", command.projectId);
        return previewCandidateReview(this.store, command);
      case "candidate-review-apply": {
        this.require<Project>("project", command.projectId);
        this.replication.assertLocalOwner(command.projectId);
        if (!trusted.digest)
          throw new Error(
            "Native approval of the exact hashed output/manual-verification plan is required.",
          );
        const plan = this.require<
          import("../../packages/workflows/candidate-reviews").CandidateReviewPlan
        >("candidate-review-plan", command.id);
        if (plan.projectId !== command.projectId)
          throw new Error("Candidate review belongs to another project.");
        const result = plan.capturePaths?.length
          ? await this.workflows.captureReviewedOutputs(
              plan.workflowId,
              plan.workflowRevision!,
              plan.id,
              trusted.digest,
            )
          : await applyCandidateReview(
              this.store,
              command.projectId,
              command.id,
              trusted.digest,
            );
        this.changed();
        return result;
      }
      case "candidate-binary-preview":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          candidateBinaryPreview(
            this.store,
            command.projectId,
            command.candidateId,
            command.path,
          ),
        );
      case "check-executions-query":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () => ({
          executions: this.checks.list(command.projectId),
        }));
      case "check-execution-inspect":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          this.checks.inspect(command.projectId, command.id),
        );
      case "check-execution-reconcile": {
        this.require<Project>("project", command.projectId);
        this.replication.assertLocalOwner(command.projectId);
        const result = await this.checks.reconcileStopped(
          command.projectId,
          command.id,
        );
        this.changed();
        return result;
      }
      case "check-cleanup-retry": {
        this.require<Project>("project", command.projectId);
        this.replication.assertLocalOwner(command.projectId);
        const result = await this.checks.retryCleanup(
          command.projectId,
          command.id,
        );
        this.changed();
        return result;
      }
      case "builder-reviewer-create":
        return this.workflows.create(
          await this.project(command.projectId),
          command,
        );
      case "builder-reviewer-advance": {
        const state = this.require<BuilderReviewerState>(
          "builder-reviewer",
          command.id,
        );
        if (state.stage === "ready-build") {
          const reviewed: any = this.review(
            "workflow-dispatch-inputs",
            command.id,
          );
          if (
            command.expectedRevision !== reviewed.expectedRevision ||
            trusted.digest !== reviewed.digest
          )
            throw new Error(
              "Review and approve the exact captured input manifest and selected agent assignments before the first dispatch.",
            );
          this.store.immutable("workflow-input-approval", {
            ...reviewed,
            id: uid(),
            approvedAt: now(),
            reviewedBy: "local-user-native-dialog",
          });
        }
        return this.workflows.advance(command.id, command.expectedRevision);
      }
      case "builder-reviewer-checks-preview":
        return this.workflows.previewChecks(
          command.id,
          command.expectedRevision,
        );
      case "builder-reviewer-check-apply":
        if (!trusted.digest)
          throw new Error(
            "Check execution requires native approval of its exact command and candidate revision.",
          );
        return this.workflows.runCheck(command.id, trusted.digest);
      case "builder-reviewer-accept":
        if (!trusted.digest)
          throw new Error(
            "Final acceptance requires native confirmation of the exact candidate evidence.",
          );
        return this.workflows.accept(
          command.id,
          command.expectedRevision,
          trusted.digest,
        );
      case "builder-reviewer-cancel": {
        const result = await this.workflows.cancel(
          command.id,
          command.expectedRevision,
        );
        this.checks.cancelWorkflow(command.id);
        return result;
      }
      case "coordination-query":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          this.coordinator.snapshot(command.projectId),
        );
      case "coordination-page":
        this.require<Project>("project", command.projectId);
        return this.observed(command.projectId, () =>
          this.store.page(command.kind, {
            projectId: command.projectId,
            cursor: command.cursor,
            limit: command.limit,
          }),
        );
      case "task-inspect": {
        const task = this.require<Task>("task", command.id);
        if (task.projectId !== command.projectId)
          throw new Error("Task belongs to another project.");
        return this.observed(command.projectId, () => {
          const snapshot = this.coordinator.snapshot(command.projectId);
          return {
            task,
            inputStatus: this.revisions.inspectTaskInputs(task.id),
            configuration: this.synchronization.configuration(task.projectId),
            workspace: snapshot.workspaces.find(
              (workspace) => workspace.id === task.workspaceId,
            ),
            attempts: snapshot.attempts.filter(
              (attempt) => attempt.taskId === task.id,
            ),
            runtimeMetadata: [
              ...this.store.iterate<{ attemptId: string }>(
                "runtime-turn-metadata",
                { projectId: task.projectId },
              ),
            ].filter((metadata) =>
              task.attemptIds.includes(metadata.attemptId),
            ),
            runtimeResultMetadata: [
              ...this.store.iterate<{ id: string; attemptId?: string }>(
                "runtime-turn-result-metadata",
                { projectId: task.projectId },
              ),
            ].filter((metadata) =>
              task.attemptIds.includes(metadata.attemptId ?? metadata.id),
            ),
            sessions: snapshot.sessions.filter((session) =>
              snapshot.attempts.some(
                (attempt) =>
                  attempt.taskId === task.id &&
                  attempt.sessionId === session.id,
              ),
            ),
            leases: snapshot.leases.filter((lease) =>
              task.attemptIds.includes(lease.attemptId),
            ),
          };
        });
      }
      case "workflow-create": {
        const result = this.coordinator.repository.createWorkflow(command);
        this.changed();
        return result;
      }
      case "task-create": {
        const result = this.coordinator.repository.createTask(command);
        this.changed();
        return result;
      }
      case "task-transition": {
        const result = this.coordinator.repository.transitionTask(
          command.id,
          command.expectedRevision,
          command.state,
          command.detail,
        );
        this.changed();
        return result;
      }
      case "task-run": {
        const task = this.require<Task>("task", command.id),
          workspace = this.require<Workspace>("workspace", task.workspaceId);
        if (task.workflowId)
          throw new Error(
            "This task belongs to a coordinated workflow. Use its workflow action so pinned code, context, specification and dispatch ownership remain bound.",
          );
        if (task.revision !== command.expectedRevision)
          throw new Error("Task revision changed. Refresh before running it.");
        const logical = await this.project(task.projectId);
        const project = await requireProjectFolder({
          ...logical,
          path: workspace.root,
          realPath: workspace.canonicalRoot,
          trusted: !!workspace.trustRevision,
        });
        if (task.role === "reviewer" && command.mode !== "review")
          throw new Error("Reviewer tasks require read-only execution.");
        const installation = this.installation(command.installationId),
          provider = installation.appId.includes("claude") ? "claude" : "codex";
        const capabilityReport = this.runtime.capabilities(installation);
        if (
          task.requiredCapabilities.some(
            (name) =>
              !capabilityReport.some((c) => capabilitySatisfies(c, name)),
          )
        )
          throw new Error(
            "A required task capability is not enforced by this runtime. No attempt or provider turn was created.",
          );
        if (command.contextPackageId) {
          this.revisions.bindPackage(task.id, command.contextPackageId);
          this.revisions.assertTaskInputsCurrent(
            task.id,
            command.contextPackageId,
          );
        } else this.revisions.assertTaskInputsCurrent(task.id);
        let conversation: Conversation,
          taskRevision = command.expectedRevision;
        if (task.conversationId)
          conversation = this.require("conversation", task.conversationId);
        else {
          conversation = {
            id: uid(),
            projectId: task.projectId,
            title: task.title,
            nativeSessions: {},
            createdAt: now(),
          };
          this.store.save("conversation", conversation);
          this.store.save("task", {
            ...task,
            conversationId: conversation.id,
            revision: task.revision + 1,
            updatedAt: now(),
          });
          taskRevision = task.revision + 1;
        }
        const attempt = this.coordinator.repository.prepareAttempt({
          taskId: task.id,
          expectedRevision: taskRevision,
          provider,
          requestedModel: command.model,
          contextPackageId: command.contextPackageId,
          runtimeRevision: installation.revisionId,
          executableIdentity: installation.identity,
          freshSession: command.freshSession,
        });
        if (command.contextPackageId)
          this.revisions.bindPackage(
            task.id,
            command.contextPackageId,
            attempt.id,
          );
        try {
          return await this.runtime.start(
            installation,
            conversation,
            project,
            command.prompt,
            command.model,
            command.mode,
            { attemptId: attempt.id, freshSession: command.freshSession },
          );
        } catch (error) {
          const current = this.require<ExecutionAttempt>("attempt", attempt.id);
          if (current.state === "prepared") {
            this.coordinator.repository.transitionAttempt(
              current.id,
              current.revision,
              "failed",
              { error: safeError(error) },
            );
            const latest = this.require<Task>("task", task.id);
            if (latest.state === "active")
              this.coordinator.repository.transitionTask(
                latest.id,
                latest.revision,
                "blocked",
                safeError(error),
              );
          }
          this.changed();
          throw error;
        }
      }
      case "state":
        return this.state();
      case "theme":
        this.store.put("preference", { id: "theme", value: command.theme });
        this.changed();
        return;
      case "discover":
        return this.discover();
      case "select-runtime": {
        if (
          !trusted.selectedPath ||
          !trusted.selectedAppId ||
          !trusted.approved
        )
          throw new Error("Select a runtime through the native dialog.");
        const installation = await describeInstallation(
          trusted.selectedAppId,
          trusted.selectedPath,
          this.store.list("installation"),
        );
        this.store.save("installation", installation);
        this.changed();
        return installation;
      }
      case "trust-installation": {
        if (!trusted.approved)
          throw new Error(
            "Executable trust requires a native user confirmation.",
          );
        const i = this.installation(command.id);
        const verified = await probeVersion({ ...i, trusted: true });
        this.store.save("installation", verified);
        this.store.immutable("installation-revision", {
          id: verified.revisionId,
          installationId: verified.id,
          identity: verified.identity,
          version: verified.version,
          path: verified.realPath,
          owner: verified.owner,
          channel: verified.channel,
        });
        this.changed();
        return verified;
      }
      case "check-updates":
        return this.lifecycle.check(command.id, true);
      case "lifecycle-preview":
        return this.lifecycle.preview(
          command.appId as AppId,
          command.installationId,
          command.action,
        );
      case "lifecycle-apply":
        if (!trusted.digest) throw new Error("Missing native approval.");
        return this.lifecycle.approve(command.id, trusted.digest);
      case "lifecycle-cancel":
        return this.lifecycle.cancel(command.id);
      case "lifecycle-reconcile":
        return this.lifecycle.reconcile(command.id);
      case "lifecycle-retry-preview": {
        const job = this.require<LifecycleJob>("job", command.id);
        if (!["failed", "cancelled", "unchanged"].includes(job.state))
          throw new Error("Reconcile the existing operation before retrying.");
        const plan = this.require<LifecyclePlan>("plan", job.planId);
        return this.lifecycle.preview(
          plan.appId,
          plan.installationId,
          plan.action,
        );
      }
      case "show-download": {
        const job = this.require<LifecycleJob>("job", command.id);
        if (!job.acquiredPath || job.state !== "completed")
          throw new Error("No verified download is available.");
        return { reveal: job.acquiredPath };
      }
      case "open-docs": {
        const app = catalog.find((a) => a.id === command.appId);
        if (!app) throw new Error("Unknown application.");
        return { openUrl: app[command.kind] };
      }
      case "open-application": {
        const i = this.installation(command.id);
        if (!i.appId.endsWith("desktop"))
          throw new Error(
            "Open CLI applications through a project’s native terminal.",
          );
        return { openPath: i.path };
      }
      case "project-add": {
        if (!trusted.selectedPath || !trusted.approved)
          throw new Error(
            "Project trust requires a native folder selection and confirmation.",
          );
        const project = await this.projects.add(trusted.selectedPath);
        this.coordinator.repository.ensureWorkspace(project);
        await this.codexProjects.refresh().catch(() => {});
        return project;
      }
      case "project-sync-enable":
        if (command.enabled && !trusted.approved)
          throw new Error(
            "Native folder discovery requires a native user confirmation.",
          );
        await this.projects.enable(command.enabled);
        return this.projects.state();
      case "project-sync-refresh":
        if (!this.projects.enabled())
          throw new Error("Enable project discovery first.");
        await this.projects.refresh();
        return this.projects.state();
      case "codex-project-sync-enable":
        if (!trusted.approved)
          throw new Error(
            "Native project synchronization requires confirmation of the runtime and profile.",
          );
        await this.codexProjects.enable(command.installationId);
        return this.codexProjects.state();
      case "codex-project-sync-pause":
        await this.codexProjects.pause();
        return this.codexProjects.state();
      case "codex-project-sync-refresh":
        if (!this.codexProjects.state().enabled)
          throw new Error("Enable Codex project synchronization first.");
        await this.codexProjects.refresh();
        return this.codexProjects.state();
      case "codex-project-rename":
        await this.codexProjects.rename(
          command.id,
          command.expectedRevision,
          command.name,
        );
        return this.codexProjects.state();
      case "codex-project-move":
        await this.codexProjects.move(
          command.id,
          command.beforeProjectId,
          command.expectedOrderRevision,
        );
        return this.codexProjects.state();
      case "project-trust":
        if (!trusted.approved || !trusted.selectedPath)
          throw new Error("Project trust requires a native user confirmation.");
        {
          const project = await this.projects.trust(
            command.id,
            trusted.selectedPath,
          );
          this.coordinator.repository.ensureWorkspace(project);
          await this.codexProjects.refresh().catch(() => {});
          return project;
        }
      case "project-relink":
        if (!trusted.approved || !trusted.selectedPath)
          throw new Error(
            "Relinking requires native folder selection and confirmation.",
          );
        if (
          this.runtime.isProjectBusy(command.id) ||
          this.store
            .list<any>("run")
            .some(
              (run) =>
                run.projectId === command.id && run.status === "uncertain",
            )
        )
          throw new Error(
            "Close or reconcile this project's native sessions before relinking it.",
          );
        {
          const project = await this.projects.relink(
            command.id,
            trusted.selectedPath,
            (updated) => {
              if (
                this.runtime.isProjectBusy(command.id) ||
                [
                  ...this.store.iterate<any>("run", { projectId: command.id }),
                ].some((run) =>
                  [
                    "starting",
                    "running",
                    "awaiting-approval",
                    "uncertain",
                  ].includes(run.status),
                )
              )
                throw new Error(
                  "Close or reconcile this project's active sessions before relinking it.",
                );
              this.coordinator.repository.relinkDefaultWorkspace(updated);
            },
          );
          await this.codexProjects.refresh().catch(() => {});
          return project;
        }
      case "project-copy-path":
        return {
          copyProjectPath: this.require<Project>("project", command.id).path,
        };
      case "project-open": {
        const project = await this.project(command.projectId);
        const installation = this.installation(command.installationId);
        if (installation.appId.endsWith("cli")) {
          const terminalId = await this.runtime.terminal(installation, project);
          return {
            terminalId,
            projectPath: project.realPath,
            route: "terminal",
            detail: "The native terminal uses this shared project folder.",
          } satisfies ProjectOpenResult;
        }
        if (
          this.runtime.isProjectBusy(project.id) ||
          this.store
            .list<any>("run")
            .some(
              (run) =>
                run.projectId === project.id && run.status === "uncertain",
            )
        )
          throw new Error(
            "Close or reconcile this project's native sessions before opening another application.",
          );
        return desktopProjectRoute(installation, project);
      }
      case "conversation-add": {
        await this.project(command.projectId);
        const conversation = {
          id: uid(),
          projectId: command.projectId,
          title: command.title,
          nativeSessions: {},
          createdAt: now(),
        };
        this.store.save("conversation", conversation);
        this.changed();
        return conversation;
      }
      case "history-search":
        await this.project(command.projectId);
        return this.store.search(command.projectId, command.query);
      case "history-import": {
        if (!trusted.selectedPath || !trusted.approved)
          throw new Error("Select a transcript in the native dialog.");
        const result = await importHistory(
          this.store,
          await this.project(command.projectId),
          command.provider,
          trusted.selectedPath,
        );
        this.changed();
        return result;
      }
      case "history-delete": {
        if (!trusted.approved)
          throw new Error("Deletion needs a native confirmation.");
        const conversation = this.require<Conversation>(
          "conversation",
          command.id,
        );
        if (this.runtime.isProjectBusy(conversation.projectId))
          throw new Error(
            "Close native sessions before deleting their history.",
          );
        this.store.deleteConversation(command.id);
        this.changed();
        return;
      }
      case "runtime-connect":
      case "runtime-models":
      case "runtime-account": {
        const i = this.installation(command.id);
        if (command.type === "runtime-connect" && !trusted.approved)
          throw new Error(
            "Review the experimental integration before connecting.",
          );
        if (
          command.type !== "runtime-connect" &&
          i.compatibility !== "compatible"
        )
          throw new Error("Connect the selected runtime first.");
        try {
          const result = await this.runtime.inspect(i);
          this.store.save("installation", {
            ...i,
            compatibility: "compatible",
          });
          this.changed();
          return result;
        } catch (e) {
          this.store.save("installation", {
            ...i,
            compatibility: "incompatible",
          });
          this.changed();
          throw e;
        }
      }
      case "runtime-qualify": {
        if (!trusted.approved)
          throw new Error(
            "Review the qualification operations and their model-turn budget first.",
          );
        // A test profile sits in the temporary directory, where the suite's
        // outside-write probe cannot be judged.
        if (this.isolatedTest && !this.qualificationDirectory)
          throw new Error(
            "This test profile is in the OS temporary directory, where a qualification cannot be judged. Set TOPSL_TEST_QUALIFICATION_DIR to a new topsl-qualify-* folder outside it.",
          );
        const result = await this.runtime.qualify(
          this.installation(command.id),
          {
            model: command.model,
            ...(command.effort ? { effort: command.effort } : {}),
          },
          this.qualificationDirectory ??
            path.join(this.directory, "runtime-qualification"),
        );
        this.changed();
        return result;
      }
      case "runtime-qualification-query":
        this.installation(command.id);
        return {
          reports: this.runtime.qualificationReports(command.id).slice(0, 5),
        };
      case "run-start": {
        const conversation = this.require<Conversation>(
          "conversation",
          command.conversationId,
        );
        const project = await this.project(conversation.projectId);
        if (command.mode === "native")
          return this.runtime.terminal(
            this.installation(command.installationId),
            project,
          );
        let prompt = command.prompt;
        if (command.snapshotId) {
          const snapshot = this.require<ContextSnapshot>(
            "snapshot",
            command.snapshotId,
          );
          if (
            snapshot.projectId !== project.id ||
            snapshot.conversationId !== conversation.id ||
            snapshot.provider !== "codex" ||
            hash(snapshot.text) !== snapshot.hash ||
            !trusted.approved
          )
            throw new Error(
              "Review the exact handoff snapshot for this destination first.",
            );
          prompt = snapshot.text + "\n\n# Current user request\n" + prompt;
          this.store.event("handoff.sent", {
            id: snapshot.id,
            hash: snapshot.hash,
            provider: snapshot.provider,
          });
        }
        return this.runtime.start(
          this.installation(command.installationId),
          conversation,
          project,
          prompt,
          command.model,
          command.mode,
        );
      }
      case "run-interrupt":
        return this.runtime.interrupt(command.id);
      case "run-reconcile":
        if (!trusted.approved)
          throw new Error(
            "Inspect the native session and confirm reconciliation.",
          );
        return this.runtime.reconcile(command.id);
      case "approval-decide":
        if (!trusted.digest)
          throw new Error("A native approval decision is required.");
        return this.runtime.decide(command.id, trusted.digest, command.allow);
      case "handoff-preview":
        return previewHandoff(
          this.store,
          this.require("conversation", command.conversationId),
          command.provider,
          command.objective,
        );
      case "handoff-export": {
        if (!trusted.selectedPath || !trusted.approved)
          throw new Error("Export requires a native destination selection.");
        const snapshot = this.require<ContextSnapshot>("snapshot", command.id);
        await writeFile(trusted.selectedPath, snapshot.text, { mode: 0o600 });
        this.store.event("handoff.exported", {
          id: snapshot.id,
          hash: snapshot.hash,
        });
        return;
      }
      case "runtime-login":
        throw new Error("Choose a project and open the native login terminal.");
      case "terminal-open":
        return this.runtime.terminal(
          this.installation(command.installationId),
          await this.project(command.projectId),
          command.login,
        );
      case "terminal-input":
        return this.runtime.terminalInput(command.id, command.data);
      case "terminal-resize":
        return this.runtime.terminalResize(
          command.id,
          command.cols,
          command.rows,
        );
      case "terminal-close":
        return this.runtime.terminalClose(command.id);
      case "configuration-read": {
        const result = await this.configuration.read(
          command.provider,
          command.projectId ? await this.project(command.projectId) : null,
          command.kind,
        );
        if (command.projectId)
          this.synchronization.recordConfiguration({
            projectId: command.projectId,
            sessionId: "project-files",
            provider: command.provider,
            capability:
              command.kind === "instructions"
                ? "project-instructions"
                : "native-configuration",
            classification: "observable-only",
            stage: "discovered",
            value: result.path,
            sourceHash: result.hash,
            sourceRevision: result.hash,
            evidence: {
              level: "source-observation",
              source: result.path,
              observedAt: now(),
              detail:
                "File content observed; effective native session loading remains unverified.",
            },
          });
        return result;
      }
      case "configuration-preview":
        return this.configuration.preview(
          command.path,
          command.expectedHash,
          command.text,
        );
      case "configuration-apply":
        if (!trusted.digest) throw new Error("A native approval is required.");
        try {
          await this.configuration.apply(command.id, trusted.digest);
          const plan = this.require<ConfigurationPlan>(
            "configuration-plan",
            command.id,
          );
          for (const project of this.store.iterate<Project>("project"))
            if (plan.path.startsWith(project.realPath + path.sep)) {
              const provider =
                plan.path.endsWith("CLAUDE.md") ||
                plan.path.includes(path.sep + ".claude" + path.sep)
                  ? "claude"
                  : "codex";
              this.synchronization.recordConfiguration({
                projectId: project.id,
                sessionId: "project-files",
                provider,
                capability:
                  plan.path.endsWith("AGENTS.md") ||
                  plan.path.endsWith("CLAUDE.md")
                    ? "project-instructions"
                    : "native-configuration",
                classification: "observable-only",
                stage: "configured",
                value: plan.path,
                sourceHash: hash(plan.after),
                sourceRevision: command.id,
                evidence: {
                  level: "source-observation",
                  source: plan.path,
                  observedAt: now(),
                  detail:
                    "Reviewed file written. Native runtime reload and effective instruction loading remain unverified.",
                },
              });
            }
          return { applied: true, loaded: false };
        } finally {
          await this.configuration.reconcile();
          this.changed();
        }
      case "context-enable": {
        if (!trusted.approved)
          throw new Error(
            "Project context sharing requires a native confirmation.",
          );
        const project = await this.project(command.projectId);
        const grant = this.context.grant(project);
        const directory = path.join(this.directory, "context-grants");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${grant.grant}.json`);
        await writeFile(file, JSON.stringify(grant), {
          mode: 0o600,
          flag: "wx",
        });
        return {
          file,
          companionPath: path
            .join(__dirname, "cli.cjs")
            .replace(/app\.asar([/\\])/, "app.asar.unpacked$1"),
          expiresAt: grant.expiresAt,
          expires: `At ${grant.expiresAt}, on revocation, or when Topsl closes. Native configuration is not modified.`,
        };
      }
      case "unlock":
        throw new Error("Vault unlock belongs to the desktop broker.");
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.workflows.close();
    clearInterval(this.workflowTimer);
    if (this.timer) clearInterval(this.timer);
    if (this.ownershipTimer) clearInterval(this.ownershipTimer);
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.closePromise = (async () => {
      this.context.close();
      this.readers.clear();
      await Promise.all([
        this.checks.shutdown(),
        this.runtime.close(),
        this.projects.close(),
        this.codexProjects.close(),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.allSettled([
          ...this.operations,
          ...(this.discovery ? [this.discovery] : []),
        ]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 30_000);
        }),
      ]);
      clearTimeout(timer);
      if (!settled)
        throw new Error(
          "Shutdown has unresolved service operations. Protected storage remains open; reopen only after reconciliation.",
        );
      this.coordinator.close();
      this.store.close();
    })().catch((error) => {
      // A bounded shutdown can leave storage intentionally open. Once the
      // outstanding operation settles, another close request may finish it.
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
}
