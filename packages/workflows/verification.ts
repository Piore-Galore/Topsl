import os from "node:os";
import path from "node:path";
import { hash, now, stable, uid } from "../domain/invariants";
import type { Verification } from "../domain/workflow";
import { CoordinationRepository } from "../persistence/repositories/coordination";
import { identity } from "../platform/system";
import { CheckExecutions } from "./check-executions";
import {
  createEnvironmentRecipe,
  type EnvironmentRecipe,
} from "./environments";
import { assertCheckInputs } from "./check-inputs";
import {
  assertCandidateCurrent,
  assertCandidateOutputCoverage,
  type CandidateSnapshot,
} from "./candidates";
import type { Store } from "../persistence/store";

export interface CheckDefinition {
  id: string;
  label: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  environmentRecipeId?: string;
  executionPolicy?: {
    maximumUses: number;
    allowCandidateChanges?: boolean;
    expiresAfterMs?: number;
  };
}
export interface CheckPlan {
  id: string;
  projectId: string;
  workflowId: string;
  taskId: string;
  candidateId: string;
  targetRevision: string;
  definition: CheckDefinition;
  executableIdentity: string;
  environment: string;
  environmentRecipeId?: string;
  environmentRecipe?: EnvironmentRecipe;
  authorizationId?: string;
  digest: string;
  createdAt: string;
  expiresAt: string;
}
export function checkPlanDigest(plan: CheckPlan): string {
  const { digest: _, ...body } = plan;
  return hash(stable(body));
}
export async function previewCheck(
  repository: CoordinationRepository,
  workflowId: string,
  taskId: string,
  candidate: CandidateSnapshot,
  definition: CheckDefinition,
): Promise<CheckPlan> {
  assertCheckInputs(repository.store, workflowId, candidate, definition);
  if (
    !path.isAbsolute(definition.executable) ||
    /\.(cmd|bat)$/i.test(definition.executable) ||
    !definition.label.trim() ||
    !definition.id ||
    definition.args.some((s) => s.includes("\0")) ||
    !Number.isSafeInteger(definition.timeoutMs) ||
    definition.timeoutMs < 100 ||
    definition.timeoutMs > 300_000
  )
    throw new Error(
      "A check needs an absolute native executable, bounded timeout and exact arguments; shell wrappers are unsupported.",
    );
  assertCandidateOutputCoverage(candidate, repository.store);
  await assertCandidateCurrent(candidate);
  const runtime = await identity(definition.executable);
  const recipe = await createEnvironmentRecipe(
    repository.store,
    candidate,
    definition,
  );
  const plan: CheckPlan = {
    id: uid(),
    projectId: candidate.projectId,
    workflowId,
    taskId,
    candidateId: candidate.id,
    targetRevision: candidate.revision,
    definition,
    executableIdentity: runtime.identity,
    environmentRecipeId: recipe.id,
    environmentRecipe: recipe,
    environment: stable({
      recipeId: recipe.id,
      recipeDigest: recipe.digest,
      dependencyPreparation: recipe.kind,
      platform: os.platform(),
      arch: os.arch(),
      serviceNodeVersion: process.versions.node,
      checkToolVersions: "unobserved until approved environment preparation",
      executable: runtime.realPath,
      input: "materialized-candidate",
      isolation: "temporary-workspace; no OS sandbox",
      network: "not-enforced",
      inheritedEnvironment:
        "disposable home and explicit non-secret values; no native auth homes, proxy or provider credentials",
      mutableResources:
        "unique task temp/database; reserved loopback port with explicit handoff; resources outside candidate",
    }),
    digest: "",
    createdAt: now(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const policy = definition.executionPolicy;
  if (
    policy &&
    (!Number.isInteger(policy.maximumUses) ||
      policy.maximumUses < 1 ||
      policy.maximumUses > 10 ||
      (policy.expiresAfterMs !== undefined &&
        (!Number.isInteger(policy.expiresAfterMs) ||
          policy.expiresAfterMs < 100 ||
          policy.expiresAfterMs > 3600000)))
  )
    throw new Error(
      "Execution authorization requires bounded uses and expiry.",
    );
  plan.authorizationId = plan.id;
  if (policy?.expiresAfterMs)
    plan.expiresAt = new Date(Date.now() + policy.expiresAfterMs).toISOString();
  plan.digest = checkPlanDigest(plan);
  repository.store.immutable("check-authorization-definition", {
    id: plan.authorizationId,
    version: 1,
    projectId: candidate.projectId,
    workflowId,
    definitionHash: hash(stable(definition)),
    recipeDigest: recipe.digest,
    candidateId: candidate.id,
    candidateRevision: candidate.revision,
    workspaceIdentity: candidate.workspaceIdentity,
    maximumUses: policy?.maximumUses ?? 1,
    allowCandidateChanges: policy?.allowCandidateChanges ?? false,
    expiresAt: plan.expiresAt,
    planDigest: plan.digest,
    specificationRevision:
      repository.store.get<{ specificationRevision: number }>(
        "workflow",
        workflowId,
      )?.specificationRevision ?? null,
    createdAt: now(),
  });
  repository.store.immutable("workflow-check-plan", plan);
  return plan;
}
export function executeCheck(
  repository: CoordinationRepository,
  plan: CheckPlan,
  digest: string,
): Promise<Verification> {
  return CheckExecutions.for(repository.store).execute(
    repository,
    plan,
    digest,
  );
}

/** A new preview/execution for a changed candidate may reuse only an expressly
 * bounded workflow allowance. Dependency, permissions, harness and tool changes
 * remain outside that allowance because recipe/definition hashes must match. */
export async function reuseCheckAuthorization(
  store: Store,
  authorizationId: string,
  candidateId: string,
  requestedTaskId?: string,
): Promise<CheckPlan> {
  const authorization = store.get<any>(
    "check-authorization-definition",
    authorizationId,
  );
  if (
    !authorization ||
    store.get("check-authorization-revoked", authorizationId) ||
    Date.parse(authorization.expiresAt) <= Date.now()
  )
    throw new Error("Execution authorization is expired or revoked.");
  if (
    (store.get<{ uses: number }>("check-authorization-usage", authorizationId)
      ?.uses ?? 0) >= authorization.maximumUses
  )
    throw new Error("Execution authorization is exhausted.");
  const original = store.get<CheckPlan>(
    "workflow-check-plan",
    authorization.id,
  );
  const candidate = store.get<CandidateSnapshot>("candidate", candidateId);
  if (
    !original ||
    !candidate ||
    candidate.projectId !== authorization.projectId ||
    candidate.workflowId !== authorization.workflowId ||
    candidate.workspaceIdentity !== authorization.workspaceIdentity ||
    (!authorization.allowCandidateChanges &&
      candidate.revision !== authorization.candidateRevision)
  )
    throw new Error("Candidate is outside this execution authorization.");
  if (
    authorization.specificationRevision !==
    (store.get<{ specificationRevision: number }>(
      "workflow",
      authorization.workflowId,
    )?.specificationRevision ?? null)
  )
    throw new Error(
      "Acceptance specification changed; fresh execution approval is required.",
    );
  const builder = store.get<{
    stage: string;
    candidateId: string;
    checkTaskId: string | null;
  }>("builder-reviewer", authorization.workflowId);
  const parallel = store.get<{
    stage: string;
    combinedCandidateId: string | null;
    integrationTaskId: string | null;
  }>("parallel-specialists", authorization.workflowId);
  let taskId = requestedTaskId ?? original.taskId;
  if (builder) {
    if (
      builder.stage !== "checking" ||
      builder.candidateId !== candidate.id ||
      !builder.checkTaskId
    )
      throw new Error(
        "A current reviewed candidate and tester task are required for authorization reuse.",
      );
    if (requestedTaskId && requestedTaskId !== builder.checkTaskId)
      throw new Error("Reuse task is not the workflow's current tester.");
    taskId = builder.checkTaskId;
  } else if (parallel) {
    if (
      parallel.stage !== "checking" ||
      parallel.combinedCandidateId !== candidate.id ||
      !parallel.integrationTaskId
    )
      throw new Error(
        "A current combined candidate and integration task are required for authorization reuse.",
      );
    if (requestedTaskId && requestedTaskId !== parallel.integrationTaskId)
      throw new Error(
        "Reuse task is not the workflow's current integration task.",
      );
    taskId = parallel.integrationTaskId;
  }
  const task = store.get<{
    projectId: string;
    workflowId: string;
    state: string;
    role: string;
  }>("task", taskId);
  if (
    !task ||
    task.projectId !== authorization.projectId ||
    task.workflowId !== authorization.workflowId ||
    !["tester", "integrator"].includes(task.role) ||
    ["cancelled", "accepted"].includes(task.state) ||
    store.get("task-supersession", taskId)
  )
    throw new Error(
      "Execution reuse requires a current verification task in the exact project/workflow.",
    );
  const advancedBinding = store.get<any>("advanced-check-binding", original.id);
  if (advancedBinding && advancedBinding.candidateId !== candidate.id)
    throw new Error(
      "Advanced frozen protocol candidate changed; review a fresh check binding.",
    );
  const repository = new CoordinationRepository(store);
  const plan = await previewCheck(
    repository,
    authorization.workflowId,
    taskId,
    candidate,
    original.definition,
  );
  if (plan.environmentRecipe?.digest !== authorization.recipeDigest)
    throw new Error(
      "Dependency, toolchain or permission recipe changed; fresh execution approval is required.",
    );
  // Supersede the unapproved generated preview with a new immutable record; no
  // existing plan or approval is edited retroactively.
  const reused: CheckPlan = {
    ...plan,
    id: uid(),
    authorizationId,
    expiresAt: authorization.expiresAt,
    digest: "",
  };
  reused.digest = checkPlanDigest(reused);
  store.immutable("workflow-check-plan", reused);
  if (advancedBinding)
    store.immutable("advanced-check-binding", {
      ...advancedBinding,
      id: reused.id,
    });
  return reused;
}
