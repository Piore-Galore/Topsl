import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { hash, now, safeError, stable } from "../domain/invariants";
import type { Project, UsageFact } from "../domain/types";
import type { ExecutionAttempt } from "../domain/workflow";
import type { GoalCheckDefinition } from "../domain/role-groups";
import type { Store } from "../persistence/store";
import { summarizeUsage } from "../domain/usage";
import { bindCheckInputs } from "../workflows/check-inputs";
import {
  assertCandidateCurrent,
  captureCandidate,
  gitWorkingTreeChanges,
  type CandidateSnapshot,
} from "../workflows/candidates";
import { candidateChanges } from "../workflows/parallel-specialists";
import { writeManagedSnapshot } from "../workspace/managed";
import type { GoalCheckEvidence, OrchestrationDriver } from "./engine";

/**
 * Checkpoint lineage for loop runs (docs/Recursive_Looping.md). The original
 * folder is captured once as the run's publication base; accepted loop
 * checkpoints live in Topsl-owned copies. Each iteration starts from a child
 * baseline: the accepted checkpoint's exact content, captured again under the
 * child goal's workflow identity with explicit ancestry. No candidate record
 * is mutated, the original folder is never captured again, and nothing here
 * commits, stashes or discards the owner's working changes.
 */

export interface PublicationPlan {
  root: string;
  baseRevision: string | null;
  fromCandidateId: string;
  toCandidateId: string;
  files: Array<{ path: string; change: "added" | "modified" | "deleted" }>;
  problems: string[];
  /** first: the folder must match the publication base. incremental: the last receipt. */
  basis: "first" | "incremental";
}

export interface LoopDriver {
  /** Captures the original folder as the publication base and its owned copy as checkpoint 0. */
  captureBase(input: { projectId: string; runId: string }): Promise<{
    publicationBaseCandidateId: string;
    checkpointCandidateId: string;
    contentDigest: string;
    setupConditions: string[];
  }>;
  /** A new candidate bound to `goalId` with the same file content and explicit ancestry. */
  childBaseline(input: {
    projectId: string;
    runId: string;
    goalId: string;
    candidateId: string;
  }): Promise<string>;
  /** The digest of a candidate's files only, independent of workflow binding. */
  contentDigest(candidateId: string): string | null;
  candidateHasPath(candidateId: string, filePath: string): boolean;
  changedPaths(
    fromCandidateId: string,
    toCandidateId: string,
  ): Array<{ path: string; change: "added" | "modified" | "deleted" }>;
  /** Freezes the run's protected regression protocol at checkpoint 0. */
  bindRunProtocol(input: {
    runId: string;
    checkpointCandidateId: string;
    checks: GoalCheckDefinition[];
  }): void;
  /** Problems when a child goal's frozen protocol is weaker than the run's. */
  protocolProblems(input: {
    runId: string;
    goalId: string;
    checks: GoalCheckDefinition[];
  }): string[];
  /** The protocol revision: the digest of the run's protected bindings. */
  protocolRevision(runId: string, checks: GoalCheckDefinition[]): string;
  /**
   * Runs the run's checks on an accepted checkpoint's own workflow binding,
   * under a machine-attributed authorization recorded by the caller.
   */
  verifyCheckpoint?(input: {
    projectId: string;
    runId: string;
    candidateId: string;
    checks: GoalCheckDefinition[];
    authorize: (plan: {
      id: string;
      digest: string;
      definitionId: string;
    }) => void;
  }): Promise<GoalCheckEvidence[]>;
  publicationPreview(input: {
    projectId: string;
    baseCandidateId: string;
    headCandidateId: string;
    cursor: {
      lastPublishedCandidateId: string;
      targetRevision: string | null;
      manifest: Array<{ path: string; hash: string | null }>;
    } | null;
  }): Promise<PublicationPlan>;
  publicationApply(input: {
    projectId: string;
    plan: PublicationPlan;
  }): Promise<
    | { refused: string }
    | {
        written: PublicationPlan["files"];
        manifest: Array<{ path: string; hash: string | null }>;
        targetRevision: string | null;
      }
  >;
  /** The folder's current Git revision, for reconciling after the owner commits. */
  folderRevision?(projectId: string): Promise<string | null>;
  /** Releases owned materialized copies no consumer needs; returns how many. */
  reclaim(candidateIds: string[]): Promise<number>;
  exportCheckpoint?(input: {
    candidateId: string;
    target: string;
  }): Promise<string>;
  /** Cheap fingerprint of the project folder for wakeups; null when unknown. */
  projectFingerprint?(projectId: string): Promise<string | null>;
  /** Known usage for attempts; unreported usage stays unknown, never zero. */
  usage(
    projectId: string,
    attemptIds: string[],
  ): {
    input: number | null;
    output: number | null;
    coveredAttempts: number;
    totalAttempts: number;
    complete: boolean;
    notes: string[];
  };
  /** Provider quota or owner allowance limits that block new work now. */
  providerLimits?(providers: Array<"codex" | "claude">): Array<{
    provider: "codex" | "claude";
    kind: "quota" | "allowance";
    detail: string;
    retryAt: string | null;
  }>;
}

/** The digest of a snapshot's files: path, content hash and executable bit. */
export function filesDigest(c: Pick<CandidateSnapshot, "files">): string {
  return hash(
    stable(
      c.files
        .filter((f) => f.hash)
        .map((f) => [f.path, f.hash, f.mode === null ? null : f.mode & 0o111])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );
}

interface RetainedCopy {
  id: string;
  projectId: string;
  runId: string;
  candidateId: string;
  root: string;
  state: "retained" | "reclaimed";
  at: string;
}

export interface RuntimeLoopDriverDeps {
  store: Store;
  orchestration: OrchestrationDriver;
  /** Topsl-owned root for checkpoint and child-baseline copies. */
  loopRoot: string;
  /** Other Topsl-owned roots whose copies the loop may reclaim (integrations). */
  ownedRoots: string[];
  assertLocalOwner(projectId: string): void;
  gitExecutable?: string;
  providerLimits?: LoopDriver["providerLimits"];
}

export class RuntimeLoopDriver implements LoopDriver {
  constructor(private deps: RuntimeLoopDriverDeps) {}
  private get store() {
    return this.deps.store;
  }
  private snapshot(id: string): CandidateSnapshot {
    const value = this.store.get<CandidateSnapshot>("candidate", id);
    if (!value) throw new Error("The selected candidate does not exist.");
    return value;
  }

  /** Materializes a snapshot into a new owned folder and captures it again. */
  private async recapture(input: {
    projectId: string;
    runId: string;
    workflowId: string;
    source: CandidateSnapshot;
    label: string;
  }): Promise<CandidateSnapshot> {
    const parent = path.join(this.deps.loopRoot, input.runId);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(parent, `${input.label}-`));
    try {
      const files = input.source.files.filter((f) => f.hash);
      await writeManagedSnapshot({ ...input.source, files }, root, this.store);
      const captured = await captureCandidate(this.store, {
        root,
        projectId: input.projectId,
        workflowId: input.workflowId,
        authorAttemptId: null,
        baseCandidateId: input.source.id,
        selectedPaths: files.map((f) => f.path),
        gitExecutable: this.deps.gitExecutable,
      });
      if (filesDigest(captured) !== filesDigest(input.source))
        throw new Error(
          "The owned copy differs from the accepted content it was made from.",
        );
      this.store.put("loop-retained-copy", {
        id: captured.id,
        projectId: input.projectId,
        runId: input.runId,
        candidateId: captured.id,
        root,
        state: "retained",
        at: now(),
      } satisfies RetainedCopy);
      return captured;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async captureBase(input: { projectId: string; runId: string }) {
    const project = this.store.get<Project>("project", input.projectId);
    if (!project?.trusted)
      throw new Error("The project folder must be trusted.");
    const base = await captureCandidate(this.store, {
      root: project.realPath,
      projectId: input.projectId,
      workflowId: input.runId,
      authorAttemptId: null,
      gitExecutable: this.deps.gitExecutable,
    });
    const setupConditions: string[] = [];
    if (!base.git)
      throw new Error(
        "Code loops need a Git project: the publication base must show which content is tracked.",
      );
    setupConditions.push(
      "Capture policy: Git-tracked files with their current working-tree content. Untracked files are not part of the run unless approved; nothing was committed, stashed or discarded.",
    );
    for (const o of base.omissions.slice(0, 20))
      setupConditions.push(`Not captured: ${o.source} (${o.reason}).`);
    const copy = await this.recapture({
      projectId: input.projectId,
      runId: input.runId,
      workflowId: input.runId,
      source: base,
      label: "checkpoint-0",
    });
    return {
      publicationBaseCandidateId: base.id,
      checkpointCandidateId: copy.id,
      contentDigest: filesDigest(copy),
      setupConditions,
    };
  }

  async childBaseline(input: {
    projectId: string;
    runId: string;
    goalId: string;
    candidateId: string;
  }) {
    const prior = this.store.get<{ candidateId: string }>(
      "loop-child-baseline",
      input.goalId,
    );
    if (prior) return prior.candidateId;
    const copy = await this.recapture({
      projectId: input.projectId,
      runId: input.runId,
      workflowId: input.goalId,
      source: this.snapshot(input.candidateId),
      label: "baseline",
    });
    this.store.immutable("loop-child-baseline", {
      id: input.goalId,
      projectId: input.projectId,
      runId: input.runId,
      candidateId: copy.id,
      sourceCandidateId: input.candidateId,
      contentDigest: filesDigest(copy),
    });
    return copy.id;
  }

  contentDigest(candidateId: string) {
    const c = this.store.get<CandidateSnapshot>("candidate", candidateId);
    return c ? filesDigest(c) : null;
  }

  candidateHasPath(candidateId: string, filePath: string) {
    const c = this.store.get<CandidateSnapshot>("candidate", candidateId);
    return !!c?.files.some((f) => f.path === filePath && f.hash);
  }

  changedPaths(fromCandidateId: string, toCandidateId: string) {
    const from = this.snapshot(fromCandidateId);
    const to = this.snapshot(toCandidateId);
    const before = new Set(from.files.filter((f) => f.hash).map((f) => f.path));
    return candidateChanges(from, to).map((f) => ({
      path: f.path,
      change:
        f.hash === null
          ? ("deleted" as const)
          : before.has(f.path)
            ? ("modified" as const)
            : ("added" as const),
    }));
  }

  bindRunProtocol(input: {
    runId: string;
    checkpointCandidateId: string;
    checks: GoalCheckDefinition[];
  }) {
    if (!input.checks.length) return;
    bindCheckInputs(
      this.store,
      input.runId,
      this.snapshot(input.checkpointCandidateId),
      input.checks,
    );
  }

  private bindings(workflowId: string, checks: GoalCheckDefinition[]) {
    return checks.map(
      (c) =>
        this.store.get<{
          definitionHash: string;
          protectedFiles: Array<{
            path: string;
            hash: string;
            mode: number | null;
          }>;
        }>("workflow-check-input", hash(stable([workflowId, c.id]))) ?? null,
    );
  }

  protocolProblems(input: {
    runId: string;
    goalId: string;
    checks: GoalCheckDefinition[];
  }) {
    const run = this.bindings(input.runId, input.checks);
    const child = this.bindings(input.goalId, input.checks);
    const problems: string[] = [];
    input.checks.forEach((c, i) => {
      const r = run[i],
        g = child[i];
      if (!r || !g) {
        problems.push(`Check ${c.label} has no frozen protocol.`);
        return;
      }
      if (r.definitionHash !== g.definitionHash)
        problems.push(
          `Check ${c.label}'s definition differs from the run's protocol.`,
        );
      for (const file of r.protectedFiles) {
        const now = g.protectedFiles.find((f) => f.path === file.path);
        if (!now || now.hash !== file.hash || now.mode !== file.mode)
          problems.push(
            `The run's protected acceptance input ${file.path} changed; the original obligation cannot be rebound to a weaker test.`,
          );
      }
    });
    return problems;
  }

  protocolRevision(runId: string, checks: GoalCheckDefinition[]) {
    return hash(stable(this.bindings(runId, checks))).slice(0, 32);
  }

  async verifyCheckpoint(input: {
    projectId: string;
    runId: string;
    candidateId: string;
    checks: GoalCheckDefinition[];
    authorize: (plan: {
      id: string;
      digest: string;
      definitionId: string;
    }) => void;
  }) {
    const d = this.deps.orchestration;
    if (!d.checkTask || !d.previewChecks || !d.runCheck || !d.checkEvidence)
      throw new Error("No check route is available for this checkpoint.");
    const candidate = this.snapshot(input.candidateId);
    const taskId = d.checkTask({
      projectId: input.projectId,
      goalId: candidate.workflowId,
      candidateId: candidate.id,
      checks: input.checks,
    });
    const plans = await d.previewChecks({
      goalId: candidate.workflowId,
      taskId,
      candidateId: candidate.id,
      checks: input.checks,
    });
    for (const plan of plans) {
      input.authorize({
        id: plan.id,
        digest: plan.digest,
        definitionId: plan.definition.id,
      });
      await d.runCheck(plan.id, plan.digest);
    }
    return d.checkEvidence({
      projectId: input.projectId,
      taskId,
      candidateId: candidate.id,
    });
  }

  private async fileHash(
    root: string,
    relative: string,
  ): Promise<string | null> {
    try {
      const bytes = await readFile(path.join(root, relative));
      return createHash("sha256").update(bytes).digest("hex");
    } catch {
      return null;
    }
  }

  async folderRevision(projectId: string) {
    const project = this.store.get<Project>("project", projectId);
    if (!project) return null;
    try {
      const head = await readFile(
        path.join(project.realPath, ".git", "HEAD"),
        "utf8",
      );
      const ref = /^ref: (.+)$/m.exec(head)?.[1];
      if (!ref) return head.trim();
      return (
        await readFile(path.join(project.realPath, ".git", ref), "utf8")
      ).trim();
    } catch {
      return null;
    }
  }

  async publicationPreview(input: {
    projectId: string;
    baseCandidateId: string;
    headCandidateId: string;
    cursor: {
      lastPublishedCandidateId: string;
      targetRevision: string | null;
      manifest: Array<{ path: string; hash: string | null }>;
    } | null;
  }): Promise<PublicationPlan> {
    const project = this.store.get<Project>("project", input.projectId);
    if (!project) throw new Error("The project does not exist.");
    const base = this.snapshot(input.baseCandidateId);
    const from = input.cursor
      ? this.snapshot(input.cursor.lastPublishedCandidateId)
      : base;
    const problems: string[] = [];
    if (!project.trusted) problems.push("The project folder must be trusted.");
    if (base.sourceRoot !== project.realPath)
      problems.push(
        "The project was relinked to another folder after this run started.",
      );
    let dirty: string[] = [];
    try {
      dirty = await gitWorkingTreeChanges(
        project.realPath,
        this.deps.gitExecutable,
      );
    } catch (error) {
      problems.push(
        `Git could not report the folder's state: ${safeError(error)}`,
      );
    }
    if (!input.cursor) {
      if (dirty.length)
        problems.push(
          `The project folder has uncommitted or untracked changes (${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? `, and ${dirty.length - 8} more` : ""}). Commit, stash or remove them, then publish.`,
        );
      try {
        await assertCandidateCurrent(base, this.deps.gitExecutable);
      } catch (error) {
        problems.push(
          `The project folder changed since the run's publication base: ${safeError(error)} Reconcile before publishing.`,
        );
      }
    } else {
      // Successive publication: the folder must still be exactly what Topsl
      // last wrote, so earlier published changes are told apart from
      // intervening edits.
      const revision = await this.folderRevision(input.projectId);
      if (revision !== input.cursor.targetRevision)
        problems.push(
          "The folder's Git revision changed since the last publication. Reconcile the run's publication basis first.",
        );
      const published = new Set(input.cursor.manifest.map((m) => m.path));
      const foreign = dirty.filter((p) => !published.has(p));
      if (foreign.length)
        problems.push(
          `Files Topsl did not publish changed in the folder (${foreign.slice(0, 8).join(", ")}). Reconcile before publishing again.`,
        );
      for (const m of input.cursor.manifest) {
        const current = await this.fileHash(project.realPath, m.path);
        if (current !== m.hash)
          problems.push(
            `${m.path} no longer matches what Topsl published; an intervening edit needs reconciliation.`,
          );
      }
    }
    const before = new Set(from.files.filter((f) => f.hash).map((f) => f.path));
    const head = this.snapshot(input.headCandidateId);
    return {
      root: project.realPath,
      baseRevision: base.baseRevision,
      fromCandidateId: from.id,
      toCandidateId: head.id,
      files: candidateChanges(from, head).map((f) => ({
        path: f.path,
        change:
          f.hash === null
            ? ("deleted" as const)
            : before.has(f.path)
              ? ("modified" as const)
              : ("added" as const),
      })),
      problems,
      basis: input.cursor ? "incremental" : "first",
    };
  }

  async publicationApply(input: { projectId: string; plan: PublicationPlan }) {
    this.deps.assertLocalOwner(input.projectId);
    if (input.plan.problems.length)
      return { refused: input.plan.problems.join(" ") };
    const from = this.snapshot(input.plan.fromCandidateId);
    const head = this.snapshot(input.plan.toCandidateId);
    const changed = candidateChanges(from, head);
    await writeManagedSnapshot(
      { ...head, files: changed },
      input.plan.root,
      this.store,
    );
    const manifest: Array<{ path: string; hash: string | null }> = [];
    for (const file of changed) {
      const current = await this.fileHash(input.plan.root, file.path);
      if (current !== file.hash)
        throw new Error(`${file.path} does not match the accepted checkpoint.`);
      manifest.push({ path: file.path, hash: current });
    }
    return {
      written: input.plan.files,
      manifest,
      targetRevision: await this.folderRevision(input.projectId),
    };
  }

  async reclaim(candidateIds: string[]) {
    let count = 0;
    for (const id of candidateIds) {
      const copy = this.store.get<RetainedCopy>("loop-retained-copy", id);
      const candidate = this.store.get<CandidateSnapshot>("candidate", id);
      const root = copy?.root ?? candidate?.sourceRoot;
      if (!root || copy?.state === "reclaimed") continue;
      const owned = [this.deps.loopRoot, ...this.deps.ownedRoots].some(
        (r) =>
          path.relative(r, root) && !path.relative(r, root).startsWith(".."),
      );
      if (!owned) continue;
      await rm(root, { recursive: true, force: true });
      this.store.put("loop-retained-copy", {
        id,
        projectId: candidate?.projectId ?? copy?.projectId ?? "",
        runId: copy?.runId ?? "",
        candidateId: id,
        root,
        state: "reclaimed",
        at: now(),
      } satisfies RetainedCopy);
      count++;
    }
    return count;
  }

  async exportCheckpoint(input: { candidateId: string; target: string }) {
    await mkdir(input.target, { recursive: true, mode: 0o700 });
    const candidate = this.snapshot(input.candidateId);
    await writeManagedSnapshot(
      { ...candidate, files: candidate.files.filter((f) => f.hash) },
      input.target,
      this.store,
    );
    return input.target;
  }

  async projectFingerprint(projectId: string) {
    const project = this.store.get<Project>("project", projectId);
    if (!project) return null;
    const parts: Array<number | null> = [];
    for (const name of ["HEAD", "index"]) {
      try {
        parts.push(
          (await stat(path.join(project.realPath, ".git", name))).mtimeMs,
        );
      } catch {
        parts.push(null);
      }
    }
    return hash(stable(parts)).slice(0, 16);
  }

  usage(projectId: string, attemptIds: string[]) {
    const runs = new Map<string, string>();
    for (const id of attemptIds) {
      const attempt = this.store.get<ExecutionAttempt>("attempt", id);
      if (attempt?.legacyRunId) runs.set(attempt.legacyRunId, id);
    }
    const facts = [
      ...this.store.iterate<UsageFact>("usage", { projectId }),
    ].filter((f) => runs.has(f.runId));
    const summary = summarizeUsage(facts, [...runs.keys()]);
    return {
      input: summary.input,
      output: summary.output,
      coveredAttempts: summary.coveredRuns,
      totalAttempts: attemptIds.length,
      complete: summary.complete && runs.size === attemptIds.length,
      notes: summary.notes,
    };
  }

  providerLimits(providers: Array<"codex" | "claude">) {
    return this.deps.providerLimits?.(providers) ?? [];
  }
}
