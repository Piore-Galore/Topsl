import { spawn } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import { assertRound2Feature } from "../domain/round2-features";
import type { Artifact, Verification } from "../domain/workflow";
import type { Store } from "../persistence/store";
import { CoordinationRepository } from "../persistence/repositories/coordination";
import { identity, nativeEnvironment } from "../platform/system";
import {
  ProcessLifecycle,
  processGroupPresent,
  windowsDescendants,
  type ProcessEvidence,
} from "../runtime/process-lifecycle";
import { TaskResourceAllocator } from "../workspace/resources";
import { assertCheckInputs } from "./check-inputs";
import {
  assertCandidateCurrent,
  assertCandidateOutputCoverage,
  materializeCandidate,
  type CandidateSnapshot,
} from "./candidates";
import { checkPlanDigest, type CheckPlan } from "./verification";
import {
  checkEnvironment,
  PreparedEnvironments,
  verifyEnvironmentRecipe,
  type EnvironmentInstance,
  type EnvironmentRecipe,
} from "./environments";

export interface CheckExecution {
  version: 1;
  id: string;
  projectId: string;
  workflowId: string;
  taskId: string;
  planId: string;
  candidateId: string;
  targetRevision: string;
  definition: CheckPlan["definition"];
  environment: string;
  environmentRecipeId?: string;
  environmentInstanceId?: string;
  failurePhase?: "environment" | "test" | "integrity" | null;
  executableIdentity: string;
  ownerBinding: string | null;
  state:
    | "prepared"
    | "dispatching"
    | "running"
    | "stopping"
    | "passed"
    | "failed"
    | "error"
    | "cancelled"
    | "uncertain";
  eligibility: "pending" | "eligible" | "ineligible" | "uncertain";
  dispatchIntentAt: string;
  materializedRoot: string;
  ownedRoots: RootIdentity[];
  resourceId: string | null;
  lifecycle: ProcessEvidence | null;
  outputBytes: number;
  truncated: boolean;
  verificationId: string | null;
  error: string | null;
  storageError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CheckLog {
  id: string;
  executionId: string;
  projectId: string;
  targetRevision: string;
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  createdAt: string;
}
type RootIdentity = {
  root: string;
  realPath: string;
  dev: string;
  ino: string;
};
export interface CleanupJob {
  version: 1;
  id: string;
  projectId: string;
  executionId: string;
  state:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "blocked-by-active-process";
  roots: RootIdentity[];
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
type ActiveCheck = {
  promise: Promise<Verification>;
  abort: AbortController;
  lifecycle?: ProcessLifecycle;
  executionId?: string;
};
type CheckHooks = {
  beforeDispatch?: (execution: CheckExecution) => Promise<void>;
  beforeFinalCommit?: (execution: CheckExecution) => void;
  cleanup?: (root: string) => Promise<void>;
};
const instances = new WeakMap<Store, CheckExecutions>();
const finalStates = new Set(["passed", "failed", "error", "cancelled"]);
const MAX_LOG_BYTES = 1_000_000;
const MAX_LINE_BYTES = 16_000;
// OAuth authorization codes appear as URL parameters. A bare `code:` is an
// ordinary diagnostic (exit codes, Node error codes) and stays readable.
const redact = (text: string) =>
  text.replace(
    /(sk-[\w-]{12,}|Bearer\s+\S+|(?:access_token|refresh_token|api_key)["']?\s*[:=]\s*["']?[^\s&"']+|[?&]code=[^\s&"']+)/gi,
    "[redacted]",
  );
async function rootIdentity(root: string): Promise<RootIdentity> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Cleanup root is not an owned directory.");
  return {
    root,
    realPath: await realpath(root),
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

/** Every workflow uses this registry. Cleanup has no command or authorization
 * path; recovery never calls execute(). All records use the encrypted store. */
export class CheckExecutions {
  private active = new Map<string, ActiveCheck>();
  private cleanupActive = new Map<string, Promise<CleanupJob>>();
  private closing = false;
  private closed?: Promise<void>;
  constructor(
    readonly store: Store,
    private hooks: CheckHooks = {},
  ) {}
  static for(store: Store): CheckExecutions {
    let instance = instances.get(store);
    if (!instance) {
      instance = new CheckExecutions(store);
      instances.set(store, instance);
    }
    return instance;
  }
  /** Called only after the service acquired its profile owner. */
  recover(): void {
    this.store.transaction(() => {
      for (const old of this.store.iterate<CheckExecution>("check-execution")) {
        if (finalStates.has(old.state)) continue;
        this.save({
          ...old,
          state: "uncertain",
          eligibility: "uncertain",
          error:
            "Service restarted during a check. Reconcile the original execution; no command was replayed.",
        });
      }
      for (const instance of this.store.iterate<EnvironmentInstance>(
        "environment-instance",
      )) {
        if (["planned", "approved", "preparing"].includes(instance.state))
          this.store.put("environment-instance", {
            ...instance,
            state: "uncertain",
            error:
              "Service restarted during environment preparation; no preparation or check command was replayed.",
            updatedAt: now(),
          });
      }
      for (const job of this.store.iterate<CleanupJob>("check-cleanup"))
        if (job.state === "running")
          this.store.put("check-cleanup", {
            ...job,
            state: "pending",
            updatedAt: now(),
          });
    });
  }
  list(projectId: string) {
    return {
      executions: [
        ...this.store.iterate<CheckExecution>("check-execution", { projectId }),
      ],
      cleanup: [
        ...this.store.iterate<CleanupJob>("check-cleanup", { projectId }),
      ],
    };
  }
  inspect(projectId: string, executionId: string) {
    const execution = this.store.get<CheckExecution>(
      "check-execution",
      executionId,
    );
    if (!execution || execution.projectId !== projectId)
      throw new Error("Check execution is outside this project.");
    const plan = this.store.get<CheckPlan>(
      "workflow-check-plan",
      execution.planId,
    );
    if (!plan || plan.projectId !== projectId)
      throw new Error("Check plan scope is invalid.");
    const logs = [...this.store.iterate<CheckLog>("check-log", { projectId })]
      .filter((l) => l.executionId === executionId)
      .sort((a, b) => a.sequence - b.sequence);
    const cleanup =
      [...this.store.iterate<CleanupJob>("check-cleanup", { projectId })].find(
        (j) => j.executionId === executionId,
      ) ?? null;
    const environment = execution.environmentInstanceId
      ? new PreparedEnvironments(this.store).inspect(
          projectId,
          execution.environmentInstanceId,
        )
      : null;
    return { execution, plan, logs, cleanup, environment };
  }
  private ownerBinding(): string | null {
    const row = this.store.db
      .prepare(
        "SELECT body FROM coordinator_owners WHERE profile_id='local-profile'",
      )
      .get();
    if (!row) return null; // Unit/standalone API without a service owner.
    const owner = JSON.parse(row.body);
    if (owner.pid !== process.pid)
      throw new Error(
        "Check dispatch requires this service's profile ownership.",
      );
    return hash(
      stable([owner.instanceId, owner.generation, owner.processBinding]),
    );
  }
  private save(execution: CheckExecution): void {
    execution.updatedAt = now();
    this.store.put("check-execution", execution);
  }
  execute(
    repository: CoordinationRepository,
    plan: CheckPlan,
    digest: string,
  ): Promise<Verification> {
    try {
      assertRound2Feature(this.store, "durable-checks");
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.closing)
      return Promise.reject(
        new Error("Check dispatch is stopped for shutdown."),
      );
    const abort = new AbortController(),
      key = uid();
    const active: ActiveCheck = { abort, promise: undefined! };
    const promise = this.run(repository, plan, digest, active).finally(() =>
      this.active.delete(key),
    );
    active.promise = promise;
    this.active.set(key, active);
    return promise;
  }
  cancelWorkflow(workflowId: string): void {
    this.store.put("check-workflow-cancelled", {
      id: workflowId,
      cancelledAt: now(),
    });
    for (const execution of this.store.iterate<CheckExecution>(
      "check-execution",
    )) {
      if (
        execution.workflowId !== workflowId ||
        finalStates.has(execution.state) ||
        execution.state === "uncertain"
      )
        continue;
      this.save({
        ...execution,
        state: "stopping",
        eligibility: "ineligible",
        error:
          "Cancellation requested; late evidence remains attached to this execution.",
      });
      for (const active of this.active.values())
        if (active.executionId === execution.id) active.abort.abort();
    }
  }
  async shutdown(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = (async () => {
      for (const active of this.active.values()) active.abort.abort();
      await Promise.allSettled([...this.active.values()].map((a) => a.promise));
      await Promise.allSettled([...this.cleanupActive.values()]);
    })();
    return this.closed;
  }
  private async run(
    repository: CoordinationRepository,
    plan: CheckPlan,
    digest: string,
    active: ActiveCheck,
  ): Promise<Verification> {
    if (
      digest !== plan.digest ||
      checkPlanDigest(plan) !== plan.digest ||
      Date.parse(plan.expiresAt) <= Date.now()
    )
      throw new Error("Check approval is stale. Review a new check plan.");
    const candidate = repository.require<CandidateSnapshot>(
      "candidate",
      plan.candidateId,
    );
    assertCheckInputs(this.store, plan.workflowId, candidate, plan.definition);
    if (
      candidate.revision !== plan.targetRevision ||
      candidate.projectId !== plan.projectId
    )
      throw new Error("Check target revision or project changed.");
    assertCandidateOutputCoverage(candidate, this.store);
    await assertCandidateCurrent(candidate);
    if (
      (await identity(plan.definition.executable)).identity !==
      plan.executableIdentity
    )
      throw new Error("Check executable changed since approval.");
    const recipe = plan.environmentRecipeId
      ? this.store.get<EnvironmentRecipe>(
          "environment-recipe",
          plan.environmentRecipeId,
        )
      : undefined;
    if (plan.environmentRecipeId) {
      if (!recipe || recipe.digest !== plan.environmentRecipe?.digest)
        throw new Error("Approved environment recipe is missing or changed.");
      await verifyEnvironmentRecipe(this.store, recipe, candidate);
    }
    const prepared = new PreparedEnvironments(this.store);
    let environmentInstance: EnvironmentInstance | undefined;
    const at = now(),
      execution: CheckExecution = {
        version: 1,
        id: uid(),
        projectId: plan.projectId,
        workflowId: plan.workflowId,
        taskId: plan.taskId,
        planId: plan.id,
        candidateId: candidate.id,
        targetRevision: candidate.revision,
        definition: plan.definition,
        environment: plan.environment,
        environmentRecipeId: recipe?.id,
        failurePhase: recipe ? "environment" : null,
        executableIdentity: plan.executableIdentity,
        ownerBinding: this.ownerBinding(),
        state: "prepared",
        eligibility: "pending",
        dispatchIntentAt: at,
        materializedRoot: path.join(os.tmpdir(), `topsl-candidate-${uid()}`),
        resourceId: null,
        lifecycle: null,
        outputBytes: 0,
        ownedRoots: [],
        truncated: false,
        verificationId: null,
        error: null,
        storageError: null,
        createdAt: at,
        updatedAt: at,
      };
    active.executionId = execution.id;
    this.store.transaction(() => {
      assertRound2Feature(this.store, "durable-checks");
      if (
        this.closing ||
        active.abort.signal.aborted ||
        this.store.get("check-workflow-cancelled", plan.workflowId)
      )
        throw new Error(
          "Check dispatch was cancelled before authorization consumption.",
        );
      const authorization = plan.authorizationId
        ? this.store.get<any>(
            "check-authorization-definition",
            plan.authorizationId,
          )
        : null;
      if (plan.authorizationId) {
        const used =
          this.store.get<any>("check-authorization-usage", plan.authorizationId)
            ?.uses ?? 0;
        if (
          !authorization ||
          this.store.get("check-authorization-revoked", plan.authorizationId) ||
          Date.parse(authorization.expiresAt) <= Date.now() ||
          authorization.projectId !== plan.projectId ||
          authorization.workflowId !== plan.workflowId ||
          authorization.workspaceIdentity !== candidate.workspaceIdentity ||
          authorization.definitionHash !== hash(stable(plan.definition)) ||
          authorization.specificationRevision !==
            (this.store.get<{ specificationRevision: number }>(
              "workflow",
              plan.workflowId,
            )?.specificationRevision ?? null) ||
          authorization.recipeDigest !== recipe?.digest ||
          (!authorization.allowCandidateChanges &&
            authorization.candidateRevision !== candidate.revision) ||
          used >= authorization.maximumUses
        )
          throw new Error(
            "Execution authorization is expired, revoked, exhausted, or outside its exact definition/environment/candidate scope. A single-use plan has already been consumed; review a new plan to rerun.",
          );
        this.store.put("check-authorization-usage", {
          id: plan.authorizationId,
          projectId: plan.projectId,
          uses: used + 1,
          lastExecutionId: execution.id,
          updatedAt: now(),
        });
        this.store.immutable("check-authorization-consumption", {
          id: execution.id,
          projectId: plan.projectId,
          authorizationId: plan.authorizationId,
          executionId: execution.id,
          candidateId: candidate.id,
          candidateRevision: candidate.revision,
          usedAt: now(),
        });
      } else if (this.store.get("workflow-check-consumed", plan.id))
        throw new Error(
          "This check plan has already been consumed. Review a new plan to rerun.",
        );
      if (Date.parse(plan.expiresAt) <= Date.now())
        throw new Error("Check approval expired before dispatch.");
      assertCheckInputs(
        this.store,
        plan.workflowId,
        candidate,
        plan.definition,
      );
      if (execution.ownerBinding !== this.ownerBinding())
        throw new Error("Check owner changed before dispatch.");
      const lock = this.store.get<any>(
        "check-workspace-lock",
        candidate.workspaceIdentity,
      );
      if (lock?.held)
        throw new Error(
          "Candidate has an active or uncertain check; reconcile it before another execution.",
        );
      if (!this.store.get("workflow-check-consumed", plan.id))
        this.store.immutable("workflow-check-consumed", {
          id: plan.id,
          consumedAt: at,
          digest,
          executionId: execution.id,
        });
      this.store.immutable("check-dispatch-intent", {
        id: execution.id,
        projectId: plan.projectId,
        planId: plan.id,
        digest,
        targetRevision: candidate.revision,
        createdAt: at,
      });
      this.store.put("check-workspace-lock", {
        id: candidate.workspaceIdentity,
        executionId: execution.id,
        projectId: plan.projectId,
        held: true,
      });
      if (recipe) {
        environmentInstance = prepared.create(
          recipe,
          execution.id,
          candidate,
          execution.materializedRoot,
          "",
          "",
        );
        execution.environmentInstanceId = environmentInstance.id;
      }
      this.save(execution);
    });
    const allocator = new TaskResourceAllocator(
      this.store,
      path.join(os.tmpdir(), "topsl-check-resources"),
    );
    let output = "",
      sequence = 0,
      storageFailure: unknown,
      spawned = false,
      exitCode: number | null = null;
    let acceptingObservations = true;
    let result: Verification["result"] = "error";
    const roots: RootIdentity[] = [];
    const log = (stream: CheckLog["stream"], value: string) => {
      if (storageFailure || !acceptingObservations) return;
      const text = redact(value),
        bytes = Buffer.byteLength(text);
      if (execution.outputBytes + bytes > MAX_LOG_BYTES || sequence >= 256) {
        execution.truncated = true;
        return;
      }
      try {
        this.store.transaction(() => {
          this.store.immutable("check-log", {
            id: `${execution.id}:${++sequence}`,
            executionId: execution.id,
            projectId: plan.projectId,
            targetRevision: candidate.revision,
            sequence,
            stream,
            text,
            createdAt: now(),
          } satisfies CheckLog);
          execution.outputBytes += bytes;
          this.save(execution);
        });
        output += text;
      } catch (error) {
        storageFailure = error;
        active.abort.abort();
      }
    };
    try {
      const materialized = await materializeCandidate(
        candidate,
        execution.materializedRoot,
        this.store,
      );
      roots.push(await rootIdentity(materialized.root));
      execution.ownedRoots = [...roots];
      this.save(execution);
      const resources = await allocator.allocate(
        candidate.projectId,
        plan.taskId,
      );
      execution.resourceId = resources.id;
      roots.push(await rootIdentity(resources.root));
      execution.ownedRoots = [...roots];
      this.save(execution);
      const environment = allocator.environment(
        await allocator.handoffPort(resources.id),
      );
      if (recipe) {
        if (!environmentInstance)
          throw new Error("Prepared environment intent is missing.");
        prepared.allocate(environmentInstance, resources.root, resources.id);
        execution.environmentInstanceId = environmentInstance.id;
        execution.failurePhase = "environment";
        this.save(execution);
        await prepared.prepare(
          environmentInstance,
          recipe,
          candidate,
          environment,
          active.abort.signal,
        );
        execution.failurePhase = null;
        this.save(execution);
      }
      await this.hooks.beforeDispatch?.({ ...execution });
      if (recipe && environmentInstance) {
        execution.failurePhase = "integrity";
        await prepared.verify(environmentInstance, recipe, candidate);
        await assertCandidateCurrent(candidate);
        execution.failurePhase = null;
      }
      assertRound2Feature(this.store, "durable-checks");
      if (
        active.abort.signal.aborted ||
        this.store.get("check-workflow-cancelled", plan.workflowId)
      )
        throw new Error("Check cancelled before process dispatch.");
      if (execution.ownerBinding !== this.ownerBinding())
        throw new Error("Check owner changed before process dispatch.");
      execution.state = "dispatching";
      this.save(execution); // An ambiguous crash from here must never dispatch again.
      const child = spawn(plan.definition.executable, plan.definition.args, {
        cwd: materialized.root,
        env:
          recipe && environmentInstance
            ? checkEnvironment(
                recipe.values,
                environmentInstance.home,
                recipe.toolchains.find((t) => t.role === "node")?.executable ??
                  plan.definition.executable,
                environment,
              )
            : nativeEnvironment({ ...environment, ELECTRON_RUN_AS_NODE: "1" }),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: "pipe",
      });
      spawned = true;
      child.stdin.end();
      let spawnError: Error | undefined;
      child.on("error", (error) => {
        spawnError = error;
      });
      const lifecycle = (active.lifecycle = new ProcessLifecycle(
        child,
        process.platform !== "win32",
        (observation) => {
          execution.lifecycle = observation;
          if (acceptingObservations && !storageFailure)
            try {
              this.save(execution);
            } catch (error) {
              storageFailure = error;
              active.abort.abort();
            }
        },
      ));
      execution.lifecycle = lifecycle.snapshot();
      execution.state = "running";
      this.save(execution);
      for (const stream of ["stdout", "stderr"] as const) {
        let pending = "",
          dropping = false;
        child[stream].setEncoding("utf8");
        child[stream].on("data", (chunk: string) => {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline + 1);
            pending = pending.slice(newline + 1);
            if (!dropping)
              log(
                stream,
                Buffer.byteLength(line) <= MAX_LINE_BYTES
                  ? line
                  : "[overlong diagnostic line omitted]\n",
              );
            dropping = false;
          }
          if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
            pending = "";
            dropping = true;
            execution.truncated = true;
          }
        });
        child[stream].on("end", () => {
          if (dropping) log(stream, "[overlong diagnostic line omitted]\n");
          else if (pending) log(stream, pending);
        });
      }
      const abort = () => {
        execution.state = "stopping";
        void lifecycle.stop();
      };
      active.abort.signal.addEventListener("abort", abort, { once: true });
      if (active.abort.signal.aborted) abort();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void lifecycle.stop();
      }, plan.definition.timeoutMs);
      execution.lifecycle = await lifecycle.completion(
        plan.definition.timeoutMs + 6_100,
      );
      clearTimeout(timer);
      active.abort.signal.removeEventListener("abort", abort);
      exitCode = execution.lifecycle.exitCode;
      if (storageFailure) throw storageFailure;
      if (spawnError) throw spawnError;
      if (execution.lifecycle.state !== "quiescent")
        throw new Error(execution.lifecycle.detail);
      execution.failurePhase = "integrity";
      if (recipe && environmentInstance)
        await prepared.verify(environmentInstance, recipe, candidate);
      else await materialized.assertUnchanged();
      await assertCandidateCurrent(candidate);
      execution.failurePhase = null;
      if (
        active.abort.signal.aborted ||
        this.store.get("check-workflow-cancelled", plan.workflowId)
      ) {
        execution.state = "cancelled";
        result = "error";
        execution.error =
          "Cancellation requested. Output and late process evidence retained; this execution cannot satisfy acceptance.";
      } else if (timedOut) {
        execution.state = "error";
        execution.error = "Check timed out; termination evidence retained.";
      } else {
        result =
          exitCode === 0 ? "passed" : exitCode === null ? "error" : "failed";
        execution.state = result;
        if (result !== "passed") execution.failurePhase = "test";
      }
    } catch (error) {
      result = "error";
      if (environmentInstance)
        try {
          prepared.failBeforePreparation(
            environmentInstance,
            error,
            active.abort.signal.aborted,
          );
        } catch {}
      if (!spawned && environmentInstance?.preparationLifecycle)
        execution.lifecycle = environmentInstance.preparationLifecycle;
      if (active.lifecycle && execution.lifecycle?.state !== "quiescent")
        execution.lifecycle = await active.lifecycle.stop();
      execution.state =
        (spawned && execution.lifecycle?.state !== "quiescent") ||
        environmentInstance?.state === "uncertain"
          ? "uncertain"
          : active.abort.signal.aborted && !storageFailure
            ? "cancelled"
            : "error";
      execution.error = safeError(error);
      log("system", `${execution.error}\n`);
    } finally {
      if (execution.resourceId) {
        try {
          allocator.retain(execution.resourceId);
        } catch (error) {
          storageFailure ??= error;
        }
      }
      allocator.close();
    }
    // An uncertain child may close or produce output after the bounded stop.
    // Retain its intent/resources, but fence all late callbacks from persistence.
    acceptingObservations = false;
    if (!roots.length) {
      try {
        roots.push(await rootIdentity(execution.materializedRoot));
      } catch {}
    }
    execution.eligibility =
      result === "passed" && execution.lifecycle?.state === "quiescent"
        ? "eligible"
        : execution.state === "uncertain"
          ? "uncertain"
          : "ineligible";
    if (storageFailure)
      return this.persistenceFailure(execution, storageFailure);
    const evidenceId = uid(),
      verificationId = uid(),
      finishedAt = now();
    const provenance: Artifact["provenance"] = {
      level: "source-observation",
      source: "topsl-check-process",
      observedAt: finishedAt,
      detail: recipe
        ? `Exact candidate, protected harness and prepared environment ${environmentInstance?.id ?? "unavailable"} / recipe ${recipe.digest}. Preparation and test evidence retained separately. ${recipe.kind}; fresh dependencies with no shared cache. User-approved local execution; OS/network/CPU/memory isolation is not enforced. Escaped or lost ancestry is outside process observation coverage; no Windows Job containment is claimed.`
        : "Legacy bounded check against pinned bytes; environment coverage unknown and dependencies were not prepared. Protected logs and scoped process observation retained; OS/network isolation is not enforced.",
    };
    const artifact: Artifact = {
      id: evidenceId,
      projectId: candidate.projectId,
      taskId: plan.taskId,
      attemptId: null,
      conversationId: null,
      kind: "report",
      contentHash: hash(stable([output, exitCode, result, execution.id])),
      targetRevision: candidate.revision,
      protectedContentRef: evidenceId,
      confidentiality: "project",
      provenance,
      revision: 1,
      createdAt: finishedAt,
      updatedAt: finishedAt,
    };
    const verification: Verification = {
      id: verificationId,
      projectId: candidate.projectId,
      taskId: plan.taskId,
      candidateId: candidate.id,
      targetRevision: candidate.revision,
      definition: plan.definition.id,
      environment: plan.environment,
      result,
      evidenceArtifactId: evidenceId,
      evidence: provenance,
      invalidatedAt: null,
      revision: 1,
      createdAt: finishedAt,
      updatedAt: finishedAt,
    };
    const cleanup: CleanupJob = {
      version: 1,
      id: uid(),
      projectId: candidate.projectId,
      executionId: execution.id,
      state:
        execution.state === "uncertain"
          ? "blocked-by-active-process"
          : "pending",
      roots,
      attempts: 0,
      error: null,
      createdAt: finishedAt,
      updatedAt: finishedAt,
    };
    try {
      this.store.transaction(() => {
        this.hooks.beforeFinalCommit?.({ ...execution });
        this.store.immutable("protected-check-output", {
          id: evidenceId,
          projectId: candidate.projectId,
          executionId: execution.id,
          text: output,
          exitCode,
          result,
          targetRevision: candidate.revision,
          resourceId: execution.resourceId,
          environmentInstanceId: execution.environmentInstanceId ?? null,
          environmentRecipeId: execution.environmentRecipeId ?? null,
          failurePhase: execution.failurePhase ?? null,
          truncated: execution.truncated,
          createdAt: finishedAt,
        });
        repository.artifact(artifact);
        repository.verification(verification);
        execution.verificationId = verificationId;
        this.save(execution);
        this.store.put("check-cleanup", cleanup);
        if (execution.state !== "uncertain")
          this.store.put("check-workspace-lock", {
            id: candidate.workspaceIdentity,
            executionId: execution.id,
            projectId: candidate.projectId,
            held: false,
          });
      });
    } catch (error) {
      return this.persistenceFailure(execution, error);
    }
    // Evidence committed first. Cleanup failure cannot replace or erase it.
    if (cleanup.state === "pending") {
      try {
        await this.retryCleanup(candidate.projectId, cleanup.id);
      } catch {
        /* The committed pending job remains retryable after storage recovery. */
      }
    }
    return verification;
  }
  private persistenceFailure(execution: CheckExecution, error: unknown): never {
    execution.state = "uncertain";
    execution.eligibility = "uncertain";
    execution.verificationId = null;
    execution.storageError = safeError(error);
    try {
      this.save(execution);
    } catch {} // The pre-effect intent still survives a persistently full disk.
    throw new Error(
      `Check final evidence could not be persisted. No durable pass is available; reconcile execution ${execution.id}. ${safeError(error)}`,
    );
  }
  retryCleanup(projectId: string, cleanupId: string): Promise<CleanupJob> {
    const job = this.store.get<CleanupJob>("check-cleanup", cleanupId);
    if (!job || job.projectId !== projectId)
      return Promise.reject(new Error("Cleanup is outside this project."));
    const execution = this.store.get<CheckExecution>(
      "check-execution",
      job.executionId,
    );
    if (!execution || execution.projectId !== projectId)
      return Promise.reject(new Error("Cleanup execution scope is invalid."));
    const current = this.cleanupActive.get(cleanupId);
    if (current) return current;
    const operation = this.cleanup(projectId, cleanupId).finally(() =>
      this.cleanupActive.delete(cleanupId),
    );
    this.cleanupActive.set(cleanupId, operation);
    return operation;
  }
  /** Explicit observation/reconciliation only. It cannot synthesize a pass or
   * reconstruct a lost native result, and grants no authority to launch again. */
  async reconcileStopped(
    projectId: string,
    executionId: string,
  ): Promise<CheckExecution> {
    const execution = this.store.get<CheckExecution>(
      "check-execution",
      executionId,
    );
    if (!execution || execution.projectId !== projectId)
      throw new Error("Execution is outside this project.");
    if (
      execution.state !== "uncertain" ||
      [...this.active.values()].some((a) => a.executionId === executionId)
    )
      throw new Error(
        "Only an inactive uncertain execution can be reconciled.",
      );
    const lifecycle =
      execution.lifecycle ??
      (execution.failurePhase === "environment" &&
      execution.environmentInstanceId
        ? this.store.get<EnvironmentInstance>(
            "environment-instance",
            execution.environmentInstanceId,
          )?.preparationLifecycle
        : null);
    if (!lifecycle?.pid)
      throw new Error(
        "No native process identity survived. Inspect external state; absence cannot be established automatically.",
      );
    try {
      process.kill(lifecycle.pid, 0);
      throw new Error(
        "Original process identity is still present; no ownership was released.",
      );
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
    }
    const descendants =
      process.platform === "win32"
        ? await windowsDescendants(lifecycle.pid, lifecycle.startedAt)
        : null;
    const absent = lifecycle.groupId
      ? processGroupPresent(lifecycle.groupId) === false
      : descendants !== null && descendants.length === 0;
    if (!absent)
      throw new Error(
        "Owned descendants are present or unknown; preserve execution resources.",
      );
    const at = now(),
      updated: CheckExecution = {
        ...execution,
        state: "error",
        eligibility: "ineligible",
        error:
          "Process absence explicitly reconciled. The original result remains unproven; nothing was rerun.",
        lifecycle: {
          ...lifecycle,
          state: "quiescent",
          remainingGroup: "absent",
          observedAt: at,
          detail:
            "Explicit recovery observed original PID and scoped group/tree absent. This cannot substantiate a lost check result.",
        },
        updatedAt: at,
      };
    const job: CleanupJob = {
      version: 1,
      id: uid(),
      projectId,
      executionId,
      state: "pending",
      roots: execution.ownedRoots ?? [],
      attempts: 0,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    this.store.transaction(() => {
      this.save(updated);
      const oldJob = [
        ...this.store.iterate<CleanupJob>("check-cleanup", { projectId }),
      ].find((j) => j.executionId === executionId);
      if (oldJob)
        this.store.put("check-cleanup", {
          ...oldJob,
          state: "pending",
          updatedAt: at,
        });
      else this.store.put("check-cleanup", job);
      for (const lock of this.store.iterate<any>("check-workspace-lock"))
        if (lock.executionId === executionId)
          this.store.put("check-workspace-lock", { ...lock, held: false });
    });
    return updated;
  }
  private async cleanup(
    projectId: string,
    cleanupId: string,
  ): Promise<CleanupJob> {
    const job = this.store.get<CleanupJob>("check-cleanup", cleanupId);
    if (!job || job.projectId !== projectId)
      throw new Error("Cleanup is outside this project.");
    const execution = this.store.get<CheckExecution>(
      "check-execution",
      job.executionId,
    );
    if (!execution || execution.projectId !== projectId)
      throw new Error("Cleanup execution scope is invalid.");
    if (job.state === "completed") return job;
    if (
      !finalStates.has(execution.state) ||
      (execution.lifecycle && execution.lifecycle.state !== "quiescent")
    ) {
      job.state = "blocked-by-active-process";
      job.error = "Lifecycle evidence does not permit cleanup.";
      this.store.put("check-cleanup", { ...job, updatedAt: now() });
      return job;
    }
    job.state = "running";
    job.attempts++;
    job.updatedAt = now();
    this.store.put("check-cleanup", job);
    try {
      for (const root of job.roots) {
        let current: RootIdentity;
        try {
          current = await rootIdentity(root.root);
        } catch (error: any) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (stable(root) !== stable(current))
          throw new Error(
            "Cleanup root identity changed; refusing replacement or symlink deletion.",
          );
        if (this.hooks.cleanup) await this.hooks.cleanup(root.root);
        else await rm(root.root, { recursive: true, force: true });
      }
      job.state = "completed";
      job.error = null;
    } catch (error) {
      job.state = "failed";
      job.error = safeError(error);
    }
    job.updatedAt = now();
    this.store.put("check-cleanup", job);
    return job;
  }
}
