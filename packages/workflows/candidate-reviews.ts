import { hash, now, stable, uid } from "../domain/invariants";
import type { Store } from "../persistence/store";
import {
  assertCandidateCurrent,
  candidateFileBytes,
  candidateRelativePath,
  recordCandidateBinaryReview,
  recordCandidateOutputReview,
  type CandidateOutputReviewEntry,
  type CandidateSnapshot,
} from "./candidates";

export interface CandidateReviewPlan {
  id: string;
  projectId: string;
  workflowId: string;
  candidateId: string;
  candidateRevision: string;
  capturePaths?: Array<{ path: string; hash: string }>;
  workflowRevision?: number;
  outputs: CandidateOutputReviewEntry[];
  binaries: Array<{ path: string; hash: string; detail: string }>;
  createdAt: string;
  expiresAt: string;
  digest: string;
}
function planDigest(plan: CandidateReviewPlan) {
  const { digest: _, ...body } = plan;
  return hash(stable(body));
}
function candidateInScope(store: Store, projectId: string, id: string) {
  const candidate = store.get<CandidateSnapshot>("candidate", id);
  if (!candidate || candidate.projectId !== projectId)
    throw new Error("Candidate belongs to another project or is unavailable.");
  return candidate;
}
export async function previewCandidateReview(
  store: Store,
  input: {
    projectId: string;
    candidateId: string;
    outputs: CandidateOutputReviewEntry[];
    binaries: Array<{ path: string; detail: string }>;
    capturePaths?: Array<{ path: string; hash: string }>;
  },
): Promise<CandidateReviewPlan> {
  const candidate = candidateInScope(store, input.projectId, input.candidateId);
  if (
    !input.outputs.length &&
    !input.binaries.length &&
    !input.capturePaths?.length
  )
    throw new Error(
      "Select at least one output decision, capture path or manually verified binary.",
    );
  if (
    input.capturePaths?.length &&
    (input.outputs.length || input.binaries.length)
  )
    throw new Error(
      "Capture paths in a separate approved plan; review the new resulting manifest afterward.",
    );
  if (
    new Set(input.outputs.map((entry) => entry.path)).size !==
      input.outputs.length ||
    new Set(input.binaries.map((entry) => entry.path)).size !==
      input.binaries.length
  )
    throw new Error("Review each candidate path once per plan.");
  await assertCandidateCurrent(candidate);
  const capturePaths = (input.capturePaths ?? []).map((entry) => {
    const name = candidateRelativePath(entry.path),
      output = candidate.outputs?.find((o) => o.path === name);
    if (
      !output?.hash ||
      output.hash !== entry.hash ||
      candidate.files.some((f) => f.path === name && f.hash)
    )
      throw new Error(
        "Capture approval requires an exact proposed new-output path/hash outside the current captured bytes.",
      );
    return { path: name, hash: entry.hash };
  });
  if (
    capturePaths.length > 50 ||
    new Set(capturePaths.map((entry) => entry.path)).size !==
      capturePaths.length
  )
    throw new Error("Approve at most fifty distinct proposed capture paths.");
  const workflow = capturePaths.length
    ? store.get<{ revision: number; projectId: string }>(
        "workflow",
        candidate.workflowId,
      )
    : undefined;
  const state = capturePaths.length
    ? store.get<{ candidateId: string }>(
        "builder-reviewer",
        candidate.workflowId,
      )
    : undefined;
  if (
    capturePaths.length &&
    (!workflow ||
      workflow.projectId !== candidate.projectId ||
      state?.candidateId !== candidate.id)
  )
    throw new Error(
      "Output recapture requires the current ordinary workflow candidate.",
    );
  const outputs = input.outputs.map((entry) => {
    const name = candidateRelativePath(entry.path);
    const output = candidate.outputs?.find((value) => value.path === name);
    if (!output || output.hash !== entry.hash)
      throw new Error("Output review targets a different hashed manifest.");
    if (
      entry.decision === "approved" &&
      !candidate.files.some(
        (file) => file.path === name && file.hash === entry.hash,
      )
    )
      throw new Error(
        "Approve the path and recapture the output bytes before accepting this output.",
      );
    return { ...entry, path: name };
  });
  const binaries = input.binaries.map((entry) => {
    const name = candidateRelativePath(entry.path);
    const file = candidate.files.find((value) => value.path === name);
    if (
      !file?.hash ||
      !candidate.coverage?.manualBinaryPaths.includes(name) ||
      !entry.detail.trim()
    )
      throw new Error(
        "Manual verification must describe a changed binary in this exact candidate.",
      );
    return { path: name, hash: file.hash, detail: entry.detail.trim() };
  });
  const plan: CandidateReviewPlan = {
    id: uid(),
    projectId: candidate.projectId,
    workflowId: candidate.workflowId,
    candidateId: candidate.id,
    candidateRevision: candidate.revision,
    capturePaths,
    ...(workflow ? { workflowRevision: workflow.revision } : {}),
    outputs,
    binaries,
    createdAt: now(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    digest: "",
  };
  plan.digest = planDigest(plan);
  store.immutable("candidate-review-plan", plan);
  return plan;
}
export async function applyCandidateReview(
  store: Store,
  projectId: string,
  id: string,
  approvedDigest: string,
) {
  const plan = store.get<CandidateReviewPlan>("candidate-review-plan", id);
  if (
    !plan ||
    plan.projectId !== projectId ||
    plan.digest !== approvedDigest ||
    planDigest(plan) !== approvedDigest ||
    Date.parse(plan.expiresAt) <= Date.now()
  )
    throw new Error("Candidate review approval is missing, expired, or stale.");
  const candidate = candidateInScope(store, projectId, plan.candidateId);
  if (plan.capturePaths?.length)
    throw new Error(
      "Use the workflow's approved output recapture route for this capture plan.",
    );
  if (candidate.revision !== plan.candidateRevision)
    throw new Error("Candidate revision changed after review.");
  await assertCandidateCurrent(candidate);
  store.transaction(() => {
    if (
      store.get("candidate-review-consumed", id) ||
      Date.parse(plan.expiresAt) <= Date.now()
    )
      throw new Error("Candidate review was already consumed or expired.");
    for (const entry of plan.binaries)
      if (
        candidate.files.find((file) => file.path === entry.path)?.hash !==
        entry.hash
      )
        throw new Error("Binary identity changed after manual review.");
    store.immutable("candidate-review-consumed", {
      id,
      projectId,
      candidateId: candidate.id,
      digest: approvedDigest,
      consumedAt: now(),
    });
    if (plan.outputs.length)
      recordCandidateOutputReview(store, candidate, plan.outputs);
    for (const entry of plan.binaries)
      recordCandidateBinaryReview(store, candidate, entry.path, entry.detail);
  });
  return {
    candidateId: candidate.id,
    candidateRevision: candidate.revision,
    planId: id,
    recordedAt: now(),
  };
}
export function consumeCandidateCapturePlan(
  store: Store,
  projectId: string,
  id: string,
  approvedDigest: string,
) {
  const plan = store.get<CandidateReviewPlan>("candidate-review-plan", id);
  if (
    !plan ||
    plan.projectId !== projectId ||
    !plan.capturePaths?.length ||
    plan.digest !== approvedDigest ||
    planDigest(plan) !== approvedDigest ||
    Date.parse(plan.expiresAt) <= Date.now()
  )
    throw new Error("Capture approval is missing, expired or stale.");
  if (store.get("candidate-review-consumed", id))
    throw new Error(
      "Capture approval was already consumed; request a new explicit plan after reconciling its outcome.",
    );
  store.immutable("candidate-review-consumed", {
    id,
    projectId,
    candidateId: plan.candidateId,
    digest: approvedDigest,
    state: "capture-started",
    consumedAt: now(),
  });
  return plan;
}
export function candidateBinaryPreview(
  store: Store,
  projectId: string,
  candidateId: string,
  name: string,
) {
  const candidate = candidateInScope(store, projectId, candidateId);
  const file = candidate.files.find(
    (value) => value.path === candidateRelativePath(name),
  );
  if (!file?.hash)
    throw new Error("Binary preview path is outside the captured candidate.");
  const metadata = {
    candidateId,
    candidateRevision: candidate.revision,
    path: file.path,
    hash: file.hash,
    bytes: file.bytes,
  };
  if (file.bytes > 2_000_000)
    return {
      ...metadata,
      mime: null,
      base64: null,
      detail:
        "Preview exceeds 2 MB; use a supported external/manual inspection route.",
    };
  const bytes = candidateFileBytes(candidate, file, store)!;
  const mime = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? "image/jpeg"
      : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
        ? "image/gif"
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
            bytes.subarray(8, 12).toString("ascii") === "WEBP"
          ? "image/webp"
          : null;
  return {
    ...metadata,
    mime,
    base64: mime ? bytes.toString("base64") : null,
    detail: mime
      ? "Pinned candidate image preview. A manual result still needs explicit confirmation."
      : "This binary format has no supported inline preview; record its external/manual verification result.",
  };
}
