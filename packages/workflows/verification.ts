import { execFile, type ExecException } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type { Artifact, Verification } from "../domain/workflow";
import { CoordinationRepository } from "../persistence/repositories/coordination";
import { identity, nativeEnvironment } from "../platform/system";
import { TaskResourceAllocator } from "../workspace/resources";
import { assertCheckInputs } from "./check-inputs";
import {
  assertCandidateCurrent,
  materializeCandidate,
  type CandidateSnapshot,
} from "./candidates";

export interface CheckDefinition {
  id: string;
  label: string;
  executable: string;
  args: string[];
  timeoutMs: number;
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
  await assertCandidateCurrent(candidate);
  const runtime = await identity(definition.executable);
  const plan: CheckPlan = {
    id: uid(),
    projectId: candidate.projectId,
    workflowId,
    taskId,
    candidateId: candidate.id,
    targetRevision: candidate.revision,
    definition,
    executableIdentity: runtime.identity,
    environment: stable({
      platform: os.platform(),
      arch: os.arch(),
      node: process.versions.node,
      executable: runtime.realPath,
      input: "materialized-candidate",
      isolation: "temporary-workspace; no OS sandbox",
      network: "not-enforced",
      inheritedEnvironment: "native allowlist; no API credentials",
      mutableResources:
        "unique task temp/database; reserved loopback port with explicit handoff; resources outside candidate",
    }),
    digest: "",
    createdAt: now(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  plan.digest = checkPlanDigest(plan);
  repository.store.immutable("workflow-check-plan", plan);
  return plan;
}
export async function executeCheck(
  repository: CoordinationRepository,
  plan: CheckPlan,
  digest: string,
): Promise<Verification> {
  if (
    digest !== plan.digest ||
    checkPlanDigest(plan) !== plan.digest ||
    Date.parse(plan.expiresAt) <= Date.now()
  )
    throw new Error("Check approval is stale. Review a new check plan.");
  if (repository.store.get("workflow-check-consumed", plan.id))
    throw new Error(
      "This check plan has already been consumed. Review a new plan to rerun.",
    );
  const candidate = repository.require<CandidateSnapshot>(
    "candidate",
    plan.candidateId,
  );
  assertCheckInputs(
    repository.store,
    plan.workflowId,
    candidate,
    plan.definition,
  );
  if (candidate.revision !== plan.targetRevision)
    throw new Error("Check target revision changed.");
  await assertCandidateCurrent(candidate);
  if (
    (await identity(plan.definition.executable)).identity !==
    plan.executableIdentity
  )
    throw new Error("Check executable changed since approval.");
  repository.store.transaction(() => {
    if (repository.store.get("workflow-check-consumed", plan.id))
      throw new Error(
        "This check plan has already been consumed. Review a new plan to rerun.",
      );
    if (Date.parse(plan.expiresAt) <= Date.now())
      throw new Error(
        "Check approval expired before dispatch. Review a new plan.",
      );
    assertCheckInputs(
      repository.store,
      plan.workflowId,
      candidate,
      plan.definition,
    );
    repository.store.immutable("workflow-check-consumed", {
      id: plan.id,
      consumedAt: now(),
      digest,
    });
  });
  const materialized = await materializeCandidate(candidate);
  const allocator = new TaskResourceAllocator(
    repository.store,
    path.join(os.tmpdir(), "topsl-check-resources"),
  );
  let resources: Awaited<ReturnType<TaskResourceAllocator["allocate"]>>;
  try {
    resources = await allocator.allocate(candidate.projectId, plan.taskId);
  } catch (error) {
    await materialized.cleanup();
    allocator.close();
    throw error;
  }
  const environment = allocator.environment(
    await allocator.handoffPort(resources.id),
  );
  let result: Verification["result"] = "error",
    output = "",
    exitCode: number | null = null;
  try {
    const execution = await new Promise<{
      error: ExecException | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        plan.definition.executable,
        plan.definition.args,
        {
          cwd: materialized.root,
          env: nativeEnvironment({ ...environment, ELECTRON_RUN_AS_NODE: "1" }),
          shell: false,
          encoding: "utf8",
          windowsHide: true,
          timeout: plan.definition.timeoutMs,
          maxBuffer: 1_000_000,
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
    exitCode = execution.error
      ? typeof execution.error.code === "number"
        ? execution.error.code
        : null
      : 0;
    result = execution.error
      ? exitCode === null
        ? "error"
        : "failed"
      : "passed";
    output = safeError(
      `${execution.stdout}\n${execution.stderr}\n${execution.error?.message ?? ""}`,
    );
    await materialized.assertUnchanged();
    await assertCandidateCurrent(candidate);
  } catch (error) {
    result = "error";
    output = safeError(`${output}\n${safeError(error)}`);
  } finally {
    allocator.retain(resources.id);
    allocator.close();
    await materialized.cleanup();
  }
  const at = now(),
    evidenceId = uid();
  repository.store.immutable("protected-check-output", {
    id: evidenceId,
    projectId: candidate.projectId,
    text: output,
    exitCode,
    result,
    targetRevision: candidate.revision,
    resourceId: resources.id,
    createdAt: at,
  });
  const artifact: Artifact = {
    id: evidenceId,
    projectId: candidate.projectId,
    taskId: plan.taskId,
    attemptId: null,
    conversationId: null,
    kind: "report",
    contentHash: hash(stable([output, exitCode, result, resources.id])),
    targetRevision: candidate.revision,
    protectedContentRef: evidenceId,
    confidentiality: "project",
    provenance: {
      level: "source-observation",
      source: "topsl-check-process",
      observedAt: at,
      detail:
        "Bounded check ran against materialized pinned bytes. OS/network isolation is not enforced; dependencies were not installed or copied from the live workspace.",
    },
    revision: 1,
    createdAt: at,
    updatedAt: at,
  };
  repository.artifact(artifact);
  return repository.verification({
    id: uid(),
    projectId: candidate.projectId,
    taskId: plan.taskId,
    candidateId: candidate.id,
    targetRevision: candidate.revision,
    definition: plan.definition.id,
    environment: plan.environment,
    result,
    evidenceArtifactId: evidenceId,
    evidence: artifact.provenance,
    invalidatedAt: null,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}
