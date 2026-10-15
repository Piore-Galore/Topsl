import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type { ExecutionAttempt, Workspace } from "../domain/workflow";
import type { Coordinator } from "../runtime/coordinator";
import {
  candidatePaths,
  exists,
  identity,
  isWithin,
  runFile,
} from "../platform/system";
import {
  assertCandidateCurrent,
  captureCandidate,
  candidateFileBytes,
  candidateFileRange,
  type CandidateSnapshot,
} from "../workflows/candidates";
import { canonicalWorkspaceIdentity } from "./ownership";
import type { Store } from "../persistence/store";
import { createHash } from "node:crypto";

export interface ManagedWorkspace {
  id: string;
  projectId: string;
  workflowId: string;
  taskId: string | null;
  sourceWorkspaceId: string;
  baselineId: string;
  root: string;
  kind: "worktree" | "snapshot";
  gitExecutable: string | null;
  state: "creating" | "available" | "unknown" | "removed";
  retention: "protected" | "cleanup-approved";
  createdAt: string;
  detail: string;
}
export interface WorkspacePlan {
  id: string;
  projectId: string;
  workflowId: string;
  action: "create" | "remove";
  managedId: string;
  sourceWorkspaceId: string;
  baselineId: string;
  targetRevision: string;
  kind: "worktree" | "snapshot";
  root: string;
  dirtyInputPolicy: "clean" | "reviewed-snapshot";
  gitExecutable: string | null;
  executableIdentity: string | null;
  expectedIdentity: string | null;
  effects: string[];
  digest: string;
  createdAt: string;
  expiresAt: string;
}
export const workspacePlanDigest = (plan: WorkspacePlan) => {
  const { digest: _, ...body } = plan;
  return hash(stable(body));
};
async function gitProgram() {
  if (process.platform === "darwin" && (await exists("/opt/homebrew/bin/git")))
    return "/opt/homebrew/bin/git";
  const program = (await candidatePaths("git")).find(
    (p) => !/\.(cmd|bat)$/i.test(p),
  );
  if (!program)
    throw new Error(
      "A native Git executable is required; select the snapshot route for non-Git inputs.",
    );
  return program;
}
async function parentIdentity(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  if (root !== path.resolve(directory))
    throw new Error("Managed workspace parent must not be a symlink alias.");
  return root;
}
export async function writeManagedSnapshot(
  snapshot: CandidateSnapshot,
  root: string,
  store?: Store,
) {
  const origins = new Map<string, CandidateSnapshot>();
  for (const file of snapshot.files) {
    const target = path.resolve(root, file.path);
    if (!isWithin(root, target))
      throw new Error("Snapshot path escapes managed workspace.");
    let current = root;
    for (const part of file.path.split("/").slice(0, -1)) {
      current = path.join(current, part);
      if ((await exists(current)) && !(await lstat(current)).isDirectory())
        throw new Error("Snapshot parent is not a directory.");
    }
    if (file.hash === null) {
      if (await exists(target)) await unlink(target);
      continue;
    }
    let origin = snapshot;
    if (file.blobCandidateId && store) {
      const cached = origins.get(file.blobCandidateId);
      const saved =
        cached ??
        store.get<CandidateSnapshot>("candidate", file.blobCandidateId);
      if (!saved)
        throw new Error("Integrated file source candidate is missing.");
      origin = saved;
      origins.set(file.blobCandidateId, saved);
    }
    if (
      !origin ||
      origin.projectId !== snapshot.projectId ||
      origin.workflowId !== snapshot.workflowId
    )
      throw new Error(
        "Integrated file has no protected source candidate in this workflow.",
      );
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if ((await exists(target)) && (await lstat(target)).isSymbolicLink())
      throw new Error("Managed destination symlink is unsupported.");
    const handle = await open(target, "w", file.mode ?? 0o600),
      digest = createHash("sha256");
    try {
      if (origin.formatVersion === 2) {
        for (let offset = 0; offset < file.bytes; offset += 64 * 1024) {
          const bytes = candidateFileRange(
            origin,
            file.path,
            { offset, length: Math.min(64 * 1024, file.bytes - offset) },
            store,
          )!;
          digest.update(bytes);
          await handle.write(bytes);
        }
      } else {
        const bytes = candidateFileBytes(origin, file, store)!;
        digest.update(bytes);
        await handle.write(bytes);
      }
    } finally {
      await handle.close();
    }
    if (digest.digest("hex") !== file.hash)
      throw new Error("Snapshot content integrity failed.");
    await chmod(target, file.mode ?? 0o600);
  }
}
/** Git worktrees share repository metadata. They are never advertised as a sandbox.
 * Every filesystem mutation is bound to a short-lived native-reviewed plan. */
export class ManagedWorkspaces {
  readonly directory: string;
  constructor(
    readonly coordinator: Coordinator,
    profileDirectory: string,
  ) {
    this.directory = path.join(profileDirectory, "managed-workspaces");
  }
  list(projectId: string) {
    return this.coordinator.repository.all<ManagedWorkspace>(
      "managed-workspace",
      { projectId },
    );
  }
  async previewCreate(input: {
    sourceWorkspaceId: string;
    workflowId: string;
    kind: "worktree" | "snapshot";
    dirtyInputPolicy: "clean" | "reviewed-snapshot";
    selectedPaths?: string[];
    approvedUntracked?: string[];
  }): Promise<WorkspacePlan> {
    this.coordinator.ownership.assertOwner();
    const workspace = this.coordinator.repository.require<Workspace>(
      "workspace",
      input.sourceWorkspaceId,
    );
    const workflow = this.coordinator.repository.require<{ projectId: string }>(
      "workflow",
      input.workflowId,
    );
    if (
      workflow.projectId !== workspace.projectId ||
      !workspace.trustRevision ||
      workspace.availability !== "available"
    )
      throw new Error(
        "Creation requires an approved source workspace in this workflow project.",
      );
    if (
      this.coordinator.ownership.get(workspace.filesystemIdentity!)?.state &&
      this.coordinator.ownership.get(workspace.filesystemIdentity!)?.state !==
        "released"
    )
      throw new Error(
        "Source writer must stop before capturing managed inputs.",
      );
    const git = await gitProgram();
    const snapshot = await captureCandidate(this.coordinator.store, {
      root: workspace.canonicalRoot,
      projectId: workspace.projectId,
      workflowId: input.workflowId,
      selectedPaths: input.selectedPaths,
      approvedUntracked: input.approvedUntracked,
      gitExecutable: git,
    });
    if (
      snapshot.git &&
      input.dirtyInputPolicy === "clean" &&
      (
        await runFile(
          git,
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { cwd: workspace.canonicalRoot },
        )
      ).length
    )
      throw new Error(
        "Dirty inputs require a reviewed snapshot. The source checkout was not reset or stashed.",
      );
    if (!snapshot.git && input.dirtyInputPolicy !== "reviewed-snapshot")
      throw new Error(
        "Non-Git inputs require a reviewed explicit content manifest.",
      );
    if (input.kind === "worktree") {
      if (!snapshot.git || !snapshot.baseRevision)
        throw new Error(
          "A managed worktree requires a known committed Git base.",
        );
      const tracked = (
        await runFile(git, ["ls-files", "-z"], { cwd: snapshot.sourceRoot })
      )
        .split("\0")
        .filter(Boolean);
      if (
        tracked.some(
          (name) => !snapshot.files.some((file) => file.path === name),
        )
      )
        throw new Error(
          "Excluded tracked files cannot enter a managed worktree. Choose a safe snapshot instead.",
        );
    }
    const directory = await parentIdentity(this.directory),
      managedId = uid(),
      root = path.join(directory, managedId);
    if (
      isWithin(snapshot.sourceRoot, root) ||
      isWithin(root, snapshot.sourceRoot)
    )
      throw new Error("Managed workspace must be outside its source checkout.");
    const program = input.kind === "worktree" ? await identity(git) : null;
    const at = now(),
      plan: WorkspacePlan = {
        id: uid(),
        projectId: workspace.projectId,
        workflowId: input.workflowId,
        action: "create",
        managedId,
        sourceWorkspaceId: workspace.id,
        baselineId: snapshot.id,
        targetRevision: snapshot.revision,
        kind: input.kind,
        root,
        dirtyInputPolicy: input.dirtyInputPolicy,
        gitExecutable: program?.realPath ?? null,
        executableIdentity: program?.identity ?? null,
        expectedIdentity: null,
        effects: [
          "Create a task workspace under this logical project from the pinned approved input manifest.",
          input.kind === "worktree"
            ? "Create a detached Git worktree at the recorded base; shared Git metadata changes. Worktrees do not enforce OS isolation."
            : "Copy only selected safe input bytes into a separate editable directory.",
          "Preserve the source checkout and retain encrypted input evidence.",
        ],
        digest: "",
        createdAt: at,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    plan.digest = workspacePlanDigest(plan);
    this.coordinator.store.immutable("workspace-plan", plan);
    return plan;
  }
  private async approved(plan: WorkspacePlan, digest: string) {
    this.coordinator.ownership.assertOwner();
    if (
      digest !== plan.digest ||
      workspacePlanDigest(plan) !== digest ||
      Date.parse(plan.expiresAt) <= Date.now() ||
      this.coordinator.store.get("workspace-plan-consumed", plan.id)
    )
      throw new Error(
        "Workspace approval is stale or already consumed. Review a new plan.",
      );
    if (
      (await parentIdentity(this.directory)) !== path.dirname(plan.root) ||
      !isWithin(this.directory, plan.root)
    )
      throw new Error("Managed workspace destination changed.");
    if (
      plan.gitExecutable &&
      (await identity(plan.gitExecutable)).identity !== plan.executableIdentity
    )
      throw new Error("Git executable changed since review.");
    const snapshot = this.coordinator.repository.require<CandidateSnapshot>(
      "candidate",
      plan.baselineId,
    );
    if (snapshot.revision !== plan.targetRevision)
      throw new Error("Workspace input revision changed.");
    await assertCandidateCurrent(snapshot, plan.gitExecutable ?? undefined);
    return snapshot;
  }
  async apply(planId: string, digest: string): Promise<ManagedWorkspace> {
    const plan = this.coordinator.repository.require<WorkspacePlan>(
        "workspace-plan",
        planId,
      ),
      snapshot = await this.approved(plan, digest);
    // Recheck inactivity immediately before consuming the external-operation intent.
    const workspaceId =
      plan.action === "remove" ? plan.managedId : plan.sourceWorkspaceId;
    this.assertInactive(workspaceId);
    if (plan.action === "create" && (await exists(plan.root)))
      throw new Error(
        "Managed destination already exists; creation is blocked.",
      );
    if (
      plan.action === "remove" &&
      canonicalWorkspaceIdentity(plan.root).filesystemIdentity !==
        plan.expectedIdentity
    )
      throw new Error("Cleanup target identity changed.");
    this.coordinator.store.transaction(() => {
      if (this.coordinator.store.get("workspace-plan-consumed", plan.id))
        throw new Error(
          "Workspace plan was consumed by another action. Refresh its result; do not replay.",
        );
      this.coordinator.store.immutable("workspace-plan-consumed", {
        id: plan.id,
        digest,
        state: "dispatch-recorded",
        createdAt: now(),
      });
    });
    const record: ManagedWorkspace =
      plan.action === "create"
        ? {
            id: plan.managedId,
            projectId: plan.projectId,
            workflowId: plan.workflowId,
            taskId: null,
            sourceWorkspaceId: plan.sourceWorkspaceId,
            baselineId: plan.baselineId,
            root: plan.root,
            kind: plan.kind,
            gitExecutable: plan.gitExecutable,
            state: "creating",
            retention: "protected",
            createdAt: now(),
            detail: "Reviewed creation intent recorded.",
          }
        : this.coordinator.repository.require(
            "managed-workspace",
            plan.managedId,
          );
    this.coordinator.store.put("managed-workspace", record);
    try {
      if (plan.action === "create") {
        if (plan.kind === "worktree") {
          // Skip checkout filters/smudge hooks. Populate only the known Git index and
          // the reviewed safe bytes rather than executing repository checkout helpers.
          await runFile(
            plan.gitExecutable!,
            [
              "-c",
              "core.hooksPath=",
              "worktree",
              "add",
              "--no-checkout",
              "--detach",
              "--",
              plan.root,
              snapshot.baseRevision!,
            ],
            { cwd: snapshot.sourceRoot },
          );
          await runFile(
            plan.gitExecutable!,
            ["read-tree", snapshot.baseRevision!],
            { cwd: plan.root },
          );
        } else await mkdir(plan.root, { mode: 0o700 });
        await writeManagedSnapshot(snapshot, plan.root, this.coordinator.store);
        const identity = canonicalWorkspaceIdentity(plan.root),
          at = now();
        const workspace: Workspace = {
          id: record.id,
          projectId: plan.projectId,
          hostId: "local",
          root: plan.root,
          ...identity,
          checkoutType: plan.kind,
          branch: null,
          trustRevision: hash(
            stable([plan.digest, identity.filesystemIdentity]),
          ),
          availability: "available",
          provenance: "approved",
          revision: 1,
          createdAt: at,
          updatedAt: at,
        };
        this.coordinator.store.immutable("workspace", workspace);
        const baseline = await captureCandidate(this.coordinator.store, {
          root: plan.root,
          projectId: plan.projectId,
          workflowId: plan.workflowId,
          selectedPaths:
            snapshot.git && plan.kind === "worktree"
              ? undefined
              : snapshot.files.map((f) => f.path),
          approvedUntracked:
            plan.kind === "worktree" ? snapshot.approvedUntracked : [],
          gitExecutable: plan.gitExecutable ?? undefined,
        });
        this.coordinator.store.immutable("managed-input", {
          id: record.id,
          projectId: plan.projectId,
          sourceCandidateId: snapshot.id,
          candidateId: baseline.id,
          dirtyInputPolicy: plan.dirtyInputPolicy,
        });
        record.state = "available";
        record.detail =
          "Approved inputs copied. Shared Git metadata and native tools remain outside complete isolation.";
      } else {
        await this.assertCompleteCleanupManifest(snapshot, plan.root);
        if (plan.kind === "worktree")
          await runFile(
            plan.gitExecutable!,
            [
              "-c",
              "core.hooksPath=",
              "worktree",
              "remove",
              "--force",
              "--",
              plan.root,
            ],
            {
              cwd: this.coordinator.repository.require<Workspace>(
                "workspace",
                plan.sourceWorkspaceId,
              ).canonicalRoot,
            },
          );
        else await rm(plan.root, { recursive: true });
        record.state = "removed";
        record.retention = "cleanup-approved";
        record.detail =
          "Explicitly reviewed inactive workspace removed; protected candidate evidence retained.";
        const workspace = this.coordinator.repository.require<Workspace>(
          "workspace",
          record.id,
        );
        this.coordinator.store.put("workspace", {
          ...workspace,
          availability: "missing",
          revision: workspace.revision + 1,
          updatedAt: now(),
        });
      }
      this.coordinator.store.save(
        "managed-workspace",
        record,
        "workspace.managed-changed",
      );
      return record;
    } catch (error) {
      record.state = "unknown";
      record.detail = `External operation requires reconciliation: ${safeError(error)}. No automatic cleanup or replay.`;
      this.coordinator.store.save("managed-workspace", record);
      throw error;
    }
  }
  assertInactive(workspaceId: string) {
    const workspace = this.coordinator.repository.require<Workspace>(
      "workspace",
      workspaceId,
    );
    const lease = this.coordinator.ownership.get(
      canonicalWorkspaceIdentity(workspace.root).filesystemIdentity,
    );
    if (
      (lease && lease.state !== "released") ||
      this.coordinator.repository
        .all<ExecutionAttempt>("attempt", { projectId: workspace.projectId })
        .some(
          (a) =>
            a.workspaceId === workspaceId &&
            [
              "prepared",
              "starting",
              "running",
              "awaiting-approval",
              "uncertain",
            ].includes(a.state),
        )
    )
      throw new Error(
        "Active or uncertain workspace cannot be copied, integrated or removed.",
      );
  }
  private async assertCompleteCleanupManifest(
    snapshot: CandidateSnapshot,
    root: string,
  ) {
    const allowed = new Set(
      snapshot.files.filter((f) => f.hash).map((f) => f.path),
    );
    async function inspect(directory: string, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (relative === ".git") continue;
        if (entry.isDirectory())
          await inspect(path.join(directory, entry.name), relative + "/");
        else if (!entry.isFile() || !allowed.has(relative))
          throw new Error(
            "Cleanup would remove an unprotected file or symlink. Retain this workspace until its evidence is explicitly captured.",
          );
      }
    }
    await inspect(root);
  }
  async previewRemove(managedId: string): Promise<WorkspacePlan> {
    this.coordinator.ownership.assertOwner();
    const record = this.coordinator.repository.require<ManagedWorkspace>(
      "managed-workspace",
      managedId,
    );
    if (record.state !== "available")
      throw new Error(
        "Failed or uncertain work is retained until explicit reconciliation; automatic cleanup is disabled.",
      );
    this.assertInactive(managedId);
    const basis = this.coordinator.repository.require<{ candidateId: string }>(
        "managed-input",
        managedId,
      ),
      initial = this.coordinator.repository.require<CandidateSnapshot>(
        "candidate",
        basis.candidateId,
      );
    const snapshot = await captureCandidate(this.coordinator.store, {
      root: record.root,
      projectId: record.projectId,
      workflowId: record.workflowId,
      selectedPaths:
        record.kind === "snapshot"
          ? initial.files.map((f) => f.path)
          : undefined,
      approvedUntracked: initial.approvedUntracked,
      gitExecutable: record.gitExecutable ?? undefined,
    });
    await this.assertCompleteCleanupManifest(snapshot, record.root);
    const program = record.gitExecutable
        ? await identity(record.gitExecutable)
        : null,
      at = now();
    const plan: WorkspacePlan = {
      id: uid(),
      projectId: record.projectId,
      workflowId: record.workflowId,
      action: "remove",
      managedId,
      sourceWorkspaceId: record.sourceWorkspaceId,
      baselineId: snapshot.id,
      targetRevision: snapshot.revision,
      root: record.root,
      kind: record.kind,
      dirtyInputPolicy: "reviewed-snapshot",
      gitExecutable: program?.realPath ?? null,
      executableIdentity: program?.identity ?? null,
      expectedIdentity: canonicalWorkspaceIdentity(record.root)
        .filesystemIdentity,
      effects: [
        "Remove this confirmed inactive managed task workspace including its reviewed dirty bytes.",
        "Retain the encrypted content snapshot, candidate evidence and logical project history.",
      ],
      digest: "",
      createdAt: at,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    plan.digest = workspacePlanDigest(plan);
    this.coordinator.store.immutable("workspace-plan", plan);
    return plan;
  }
}
