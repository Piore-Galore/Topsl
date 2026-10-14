import { hash, now, stable } from "../domain/invariants";
import type { Conversation, Project, Run } from "../domain/types";
import type {
  AgentSession,
  Evidence,
  ExecutionAttempt,
  Task,
  Workspace,
} from "../domain/workflow";
import { CoordinationRepository } from "../persistence/repositories/coordination";
import { Store } from "../persistence/store";
import { WorkspaceOwnership } from "../workspace/ownership";
import { ConcurrencyBudget } from "./concurrency";
import { RevisionRepository } from "../context/revisions";

export interface RuntimeExecution {
  attemptId: string;
  freshSession?: boolean;
}
/** Profile authority and dispatch ownership; workflow scheduling remains deterministic
 * in the workflow service, while every native/legacy writer enters this same boundary. */
export class Coordinator {
  readonly repository: CoordinationRepository;
  readonly ownership: WorkspaceOwnership;
  readonly concurrency: ConcurrencyBudget;
  constructor(
    readonly store: Store,
    profileId = "local-profile",
  ) {
    this.repository = new CoordinationRepository(store);
    this.ownership = new WorkspaceOwnership(store, profileId);
    this.concurrency = new ConcurrencyBudget(store);
    this.ownership.acquireProfile(); // Must precede every recovery mutation.
    this.recover();
    this.concurrency.recover();
  }
  private recover(): void {
    this.store.transaction(() => {
      this.ownership.assertOwner();
      for (const attempt of this.store.iterate<ExecutionAttempt>("attempt"))
        if (
          ["prepared", "starting", "running", "awaiting-approval"].includes(
            attempt.state,
          )
        ) {
          this.repository.transitionAttempt(
            attempt.id,
            attempt.revision,
            "uncertain",
            {
              error:
                "Coordinator restarted during execution. Reconcile the native outcome; nothing was replayed.",
            },
          );
          if (attempt.operationIntentId) {
            const intent = this.store.get<any>(
              "operation-intent",
              attempt.operationIntentId,
            );
            if (["dispatch-recorded", "acknowledged"].includes(intent?.state))
              this.repository.updateIntent(intent.id, "unknown");
          }
        }
      for (const lease of this.ownership.list())
        if (lease.state === "held")
          this.ownership.markUncertain(
            lease.attemptId,
            "Prior coordinator stopped; expiry is not termination evidence.",
          );
      this.store.event("coordinator.recovered", {
        instanceId: this.ownership.instanceId,
        detail:
          "Active attempts and leases remain uncertain; no native operation replayed.",
      });
    });
  }
  beginLegacy(
    run: Run,
    project: Project,
    conversation: Conversation,
  ): ExecutionAttempt {
    return this.store.transaction(() => {
      const workspace = this.repository.ensureWorkspace(project);
      const task = this.repository.createTask({
        projectId: project.id,
        workspaceId: workspace.id,
        conversationId: conversation.id,
        title:
          run.mode === "native"
            ? "Native session"
            : run.mode === "review"
              ? "Review conversation"
              : "Edit conversation",
        role:
          run.mode === "native"
            ? "native"
            : run.mode === "review"
              ? "reviewer"
              : "implementer",
      });
      const ready = this.repository.transitionTask(
        task.id,
        task.revision,
        "ready",
      );
      const attempt = this.repository.prepareAttempt({
        taskId: task.id,
        expectedRevision: ready.revision,
        provider: run.provider,
        requestedModel: run.mode === "native" ? null : run.model,
        runtimeRevision: run.installationRevisionId,
        executableIdentity: run.executableIdentity,
        legacyRunId: run.id,
      });
      return this.beginAttempt(attempt.id, run.id);
    });
  }
  beginAttempt(attemptId: string, legacyRunId?: string): ExecutionAttempt {
    return this.store.transaction(() => {
      this.ownership.assertOwner();
      let attempt = this.repository.require<ExecutionAttempt>(
        "attempt",
        attemptId,
      );
      if (attempt.state !== "prepared")
        throw new Error(
          "Attempt has already started or its outcome requires reconciliation.",
        );
      const workspace = this.repository.require<Workspace>(
        "workspace",
        attempt.workspaceId,
      );
      // Legacy migrations deliberately do not synthesize a lease. Their unresolved
      // attempts still block aliases by the recorded canonical root.
      const uncertain = this.store.db
        .prepare(
          `SELECT a.id FROM documents a JOIN documents w ON w.kind='workspace' AND w.id=json_extract(a.body,'$.workspaceId') WHERE a.kind='attempt' AND json_extract(a.body,'$.state')='uncertain' AND (json_extract(w.body,'$.filesystemIdentity')=? OR json_extract(w.body,'$.canonicalRoot')=?) LIMIT 1`,
        )
        .get(workspace.filesystemIdentity, workspace.canonicalRoot);
      if (uncertain)
        throw new Error(
          "Workspace has an uncertain execution. Reconcile before starting another writer.",
        );
      this.concurrency.acquire(attempt);
      const lease = this.ownership.acquire(workspace, attempt.id);
      if (legacyRunId && attempt.legacyRunId !== legacyRunId) {
        attempt = { ...attempt, legacyRunId };
        this.store.put("attempt", attempt);
      }
      return this.repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "starting",
        { leaseGeneration: lease.generation },
      );
    });
  }
  attemptForRun(runId: string): ExecutionAttempt | undefined {
    const row = this.store.db
      .prepare(
        "SELECT body FROM documents WHERE kind='attempt' AND json_extract(body,'$.legacyRunId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(runId);
    return row && JSON.parse(row.body);
  }
  attachExecution(runId: string, pid: number): void {
    const attempt = this.attemptForRun(runId);
    if (!attempt || !attempt.leaseGeneration)
      throw new Error("Execution has no writer ownership.");
    this.ownership.bindExecution(
      attempt.id,
      attempt.leaseGeneration,
      pid,
      hash(stable([runId, pid, this.ownership.processBinding])),
    );
  }
  bindRunSession(
    run: Run,
    profileId: string,
    evidence: Evidence,
  ): AgentSession {
    const attempt = this.attemptForRun(run.id);
    if (!attempt) throw new Error("Run is missing attempt provenance.");
    return this.repository.bindSession(attempt.sessionId, {
      nativeSessionId: run.nativeSessionId,
      accountKey: run.nativeAccountKey ?? null,
      profileId,
      runtimeRevision: run.installationRevisionId,
      executableIdentity: run.executableIdentity,
      evidence,
    });
  }
  recordDispatch(run: Run, prompt: string): void {
    this.store.transaction(() => {
      this.ownership.assertOwner();
      const attempt = this.attemptForRun(run.id);
      if (!attempt || !attempt.leaseGeneration)
        throw new Error("Run has no execution ownership.");
      this.ownership.assertLease(attempt.id, attempt.leaseGeneration);
      new RevisionRepository(this.store).assertTaskInputsCurrent(
        attempt.taskId,
        attempt.contextPackageId ?? undefined,
      );
      const intent = this.repository.recordIntent(
        attempt.id,
        run.mode === "native" ? "native-terminal" : "turn",
        hash(
          stable({
            attemptId: attempt.id,
            prompt,
            installationRevision: run.installationRevisionId,
            sessionId: run.nativeSessionId,
            model: run.model,
            mode: run.mode,
          }),
        ),
      );
      this.repository.updateIntent(intent.id, "dispatch-recorded");
      this.repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        attempt.state,
        { operationIntentId: intent.id },
      );
    });
  }
  acknowledge(run: Run, reportedModel: string | null = null): void {
    const attempt = this.attemptForRun(run.id);
    if (!attempt) return;
    if (attempt.operationIntentId)
      this.repository.updateIntent(
        attempt.operationIntentId,
        "acknowledged",
        run.nativeTurnId,
      );
    if (reportedModel)
      this.repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        attempt.state,
        {
          reportedModel,
          modelEvidence: {
            level: "provider-ack",
            source: run.provider,
            observedAt: now(),
            detail: "Effective model reported by runtime.",
          },
        },
      );
  }
  syncRun(run: Run): void {
    this.store.transaction(() => {
      const attempt = this.attemptForRun(run.id);
      if (!attempt) return;
      if (["completed", "failed", "interrupted"].includes(attempt.state))
        return;
      const next = this.repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        run.status,
        { error: run.error },
      );
      if (run.status === "uncertain") {
        this.ownership.markUncertain(
          next.id,
          run.error ?? "Native outcome uncertain.",
        );
        const intent =
          next.operationIntentId &&
          this.store.get<any>("operation-intent", next.operationIntentId);
        if (
          intent &&
          ["dispatch-recorded", "acknowledged"].includes(intent.state)
        )
          this.repository.updateIntent(intent.id, "unknown");
      }
      const task = this.repository.require<Task>("task", next.taskId);
      if (
        task.state === "active" &&
        ["completed", "failed", "interrupted", "uncertain"].includes(run.status)
      )
        this.repository.transitionTask(
          task.id,
          task.revision,
          run.status === "completed" ? "submitted" : "blocked",
          run.status === "completed"
            ? "Native turn finished; candidate review, verification and acceptance remain separate."
            : (run.error ?? "Execution needs attention."),
        );
    });
  }
  confirmStopped(
    runId: string,
    detail = "Bound native process exit observed.",
  ): void {
    const attempt = this.attemptForRun(runId);
    if (!attempt) return;
    const lease = this.ownership.forAttempt(attempt.id);
    if (lease && attempt.state !== "uncertain") {
      this.ownership.release(attempt.id, lease.generation, {
        level: "source-observation",
        source: "native-child-exit",
        observedAt: now(),
        detail,
      });
      this.concurrency.release(attempt.id);
    }
  }
  reconcileRun(run: Run): void {
    this.syncRun(run);
    const attempt = this.attemptForRun(run.id);
    if (!attempt) return;
    const lease = this.ownership.forAttempt(attempt.id);
    if (lease) {
      this.ownership.release(
        attempt.id,
        lease.generation,
        {
          level: "user-confirmation",
          source: "native-outcome-reconciliation",
          observedAt: now(),
          detail:
            "User inspected the prior outcome and process absence was observed; no replay.",
        },
        lease.ownerId,
      );
      this.concurrency.release(attempt.id);
    } else this.concurrency.release(attempt.id);
  }
  snapshot(projectId: string) {
    return {
      workspaces: this.repository.all<Workspace>("workspace", { projectId }),
      workflows: this.repository.all("workflow", { projectId }),
      tasks: this.repository.all<Task>("task", { projectId }),
      sessions: this.repository.all<AgentSession>("agent-session", {
        projectId,
      }),
      attempts: this.repository.all<ExecutionAttempt>("attempt", { projectId }),
      leases: this.ownership.list(projectId),
      concurrency: this.concurrency.snapshot(),
    };
  }
  close(): void {
    this.ownership.releaseProfile();
  }
}
