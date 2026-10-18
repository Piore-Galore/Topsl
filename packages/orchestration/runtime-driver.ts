import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import type {
  Conversation,
  Installation,
  Message,
  Project,
} from "../domain/types";
import type {
  ContextPackage,
  ExecutionAttempt,
  Task,
  Verification,
  Workspace,
} from "../domain/workflow";
import type {
  ExecutionPurpose,
  GoalApplication,
  GoalCheckDefinition,
} from "../domain/role-groups";
import type { Store } from "../persistence/store";
import type { Coordinator } from "../runtime/coordinator";
import type { RuntimeExecution } from "../runtime/coordinator";
import type {
  ProviderCapability,
  ProviderModel,
  ToolBinding,
} from "../providers/contract";
import type { RoleReadiness, RuntimeSelection } from "../providers/readiness";
import { capabilitySatisfies } from "../providers/readiness";
import { canonicalWorkspaceIdentity } from "../workspace/ownership";
import { RevisionRepository } from "../context/revisions";
import type { ContextServer } from "../workspace/context";
import { candidateTools } from "../context/candidate-tools";
import {
  assertCandidateCurrent,
  assertMaterializedCandidate,
  candidateHasTextLine,
  captureCandidate,
  gitWorkingTreeChanges,
  materializeCandidate,
  removeMaterializedCopy,
  type CandidateSnapshot,
} from "../workflows/candidates";
import { bindCheckInputs } from "../workflows/check-inputs";
import { CheckExecutions } from "../workflows/check-executions";
import {
  executeCheck,
  previewCheck,
  type CheckPlan,
} from "../workflows/verification";
import { candidateChanges, fileEqual } from "../workflows/parallel-specialists";
import { writeManagedSnapshot } from "../workspace/managed";
import type {
  ApplyPreview,
  AttemptObservation,
  GoalCheckEvidence,
  GoalCheckPlan,
  MemberTurn,
  OrchestrationDriver,
} from "./engine";
import type { RouteCandidate } from "./selection";
import { readOnlyPurposes } from "./roles";

/** A model catalog older than this is stale for automatic selection. */
export const CATALOG_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface RuntimeDriverDeps {
  store: Store;
  coordinator: Coordinator;
  context: ContextServer;
  capabilities(installation: Installation): ProviderCapability[];
  purposeReadiness(
    installation: Installation,
    selection: RuntimeSelection,
    purpose: ExecutionPurpose,
  ): RoleReadiness;
  start(
    installation: Installation,
    conversation: Conversation,
    project: Project,
    prompt: string,
    model: string,
    mode: "review" | "edit",
    execution: RuntimeExecution,
  ): Promise<unknown>;
  interrupt(runId: string): Promise<void>;
  assertLocalOwner(projectId: string): void;
  /**
   * Where integrated candidates keep their source copy. The copy stays so a
   * required check can prove the candidate unchanged before and after it
   * runs. Defaults to the OS temporary directory.
   */
  integrationRoot?: string;
  gitExecutable?: string;
}

interface CopyRecord {
  id: string;
  projectId: string;
  launchId: string;
  attemptId: string | null;
  purpose: ExecutionPurpose;
  root: string;
  readOnly: boolean;
  candidateId: string | null;
  baselineId: string | null;
  permittedOutputs: string[];
  goalId: string;
  state: "active" | "processed";
}
interface CaptureRecord {
  id: string;
  projectId: string;
  candidateId: string | null;
  error: string | null;
  at: string;
}

async function makeWritable(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else if (entry.isFile())
      await chmod(target, (await stat(target)).mode | 0o200);
  }
}

const purposes: ExecutionPurpose[] = [
  "coordinator-contribution",
  "coordinator-endorsement",
  "information",
  "implementation",
  "candidate-review",
];

/**
 * The coordinator feature's execution boundary over the existing runtime.
 * Every member turn is an ordinary task and attempt in its own Topsl-owned
 * snapshot copy, admitted through the same leases, concurrency budget and
 * readiness gates as other workflows. Claude's structured route stays gated
 * by its readiness blockers; nothing here lifts that restriction.
 */
export class RuntimeOrchestrationDriver implements OrchestrationDriver {
  constructor(private deps: RuntimeDriverDeps) {}
  private get store() {
    return this.deps.store;
  }
  private get repository() {
    return this.deps.coordinator.repository;
  }

  routes(_projectId: string): RouteCandidate[] {
    const routes: RouteCandidate[] = [];
    for (const installation of this.store.list<Installation>("installation")) {
      const provider =
        installation.appId === "openai.codex-cli"
          ? "codex"
          : installation.appId === "anthropic.claude-code-cli"
            ? "claude"
            : null;
      if (!provider || !installation.trusted) continue;
      const catalog = this.store.get<{
        models: ProviderModel[];
        runtimeRevision: string;
        executableIdentity: string;
        observedAt: string;
        accountKey?: string;
      }>("runtime-model-catalog", installation.id);
      const account = this.store.get<{
        account: {
          accountKey: string;
          profileId: string;
          billingRoute: RouteCandidate["billingRoute"];
        };
      }>("runtime-account-observation", installation.id)?.account;
      const current =
        !!catalog &&
        catalog.runtimeRevision === installation.revisionId &&
        catalog.executableIdentity === installation.identity;
      const fresh =
        current &&
        Date.now() - Date.parse(catalog!.observedAt) < CATALOG_FRESHNESS_MS &&
        !!catalog!.accountKey &&
        catalog!.accountKey === account?.accountKey;
      const models = current ? catalog!.models : [];
      const sample = models[0]?.model ?? "unselected";
      const capabilities = this.deps.capabilities(installation);
      routes.push({
        provider,
        installationId: installation.id,
        installationRevision: installation.revisionId,
        executableIdentity: installation.identity,
        route: "managed-structured",
        nativeAccountKey: account?.accountKey ?? null,
        nativeProfileId: account?.profileId ?? null,
        billingRoute: account?.billingRoute ?? null,
        accountLabel: null,
        catalog: { models, observedAt: catalog?.observedAt ?? null, fresh },
        purposes: Object.fromEntries(
          purposes.map((purpose) => {
            const readiness = this.deps.purposeReadiness(
              installation,
              { installationId: installation.id, provider, model: sample },
              purpose,
            );
            // Route readiness: model choice is checked per member, not here.
            const blockers = readiness.blockers.filter(
              (b) => b.code !== "unsupported-model-setting",
            );
            return [
              purpose,
              {
                ready: !blockers.length,
                blockers: blockers.map((b) => `${b.code}: ${b.detail}`),
              },
            ];
          }),
        ),
        fanout: capabilities.some((c) =>
          capabilitySatisfies(c, "native-fanout-disabled"),
        )
          ? "disabled"
          : "unknown",
      });
    }
    return routes;
  }

  capacity() {
    const snapshot = this.deps.coordinator.concurrency.snapshot();
    return {
      total: snapshot.totalLimit,
      perProvider: snapshot.perProviderLimit,
      held: snapshot.active.map(
        (s: { provider: "codex" | "claude"; weight: number }) => ({
          provider: s.provider,
          weight: s.weight,
        }),
      ),
    };
  }

  private snapshot(id: string): CandidateSnapshot {
    return this.repository.require<CandidateSnapshot>("candidate", id);
  }

  /** The frozen project snapshot a goal's read-only control turns see. */
  private async contextSnapshot(
    projectId: string,
    goalId: string,
  ): Promise<string | null> {
    const key = `${goalId}:context`;
    const prior = this.store.get<{ candidateId: string | null }>(
      "orchestration-context-snapshot",
      key,
    );
    if (prior) return prior.candidateId;
    let candidateId: string | null = null;
    try {
      candidateId = await this.baseline(projectId, goalId);
    } catch {
      // A non-Git folder has no implied file selection; control turns then
      // get an empty folder and the goal brief alone.
    }
    this.store.put("orchestration-context-snapshot", {
      id: key,
      projectId,
      candidateId,
    });
    return candidateId;
  }

  async baseline(projectId: string, goalId: string): Promise<string> {
    const project = this.repository.require<Project>("project", projectId);
    if (!project.trusted)
      throw new Error("The project folder must be trusted.");
    const candidate = await captureCandidate(this.store, {
      root: project.realPath,
      projectId,
      workflowId: goalId,
      authorAttemptId: null,
    });
    return candidate.id;
  }

  candidateRevision(candidateId: string) {
    return (
      this.store.get<CandidateSnapshot>("candidate", candidateId)?.revision ??
      null
    );
  }

  validateReview(
    candidateId: string,
    review: { findings: Array<{ file: string; line: number }> },
  ) {
    const candidate = this.snapshot(candidateId);
    return review.findings.every((f) =>
      candidateHasTextLine(candidate, f.file, f.line, this.store),
    )
      ? null
      : "The review cites an unknown file or a line that does not exist in the candidate.";
  }

  findLaunch(launchId: string): string | null {
    return (
      this.store.get<{ attemptId: string }>("orchestration-launch", launchId)
        ?.attemptId ?? null
    );
  }

  async launch(turn: MemberTurn): Promise<{ attemptId: string }> {
    const a = turn.assignment;
    if (a.status !== "resolved" || !a.installationId || !a.model || !a.provider)
      throw new Error("The member has no resolved assignment.");
    const installation = this.repository.require<Installation>(
      "installation",
      a.installationId,
    );
    if (
      installation.revisionId !== a.installationRevision ||
      installation.identity !== a.executableIdentity
    )
      throw new Error(
        "The member's runtime installation changed since it was assigned. Resolve the group again.",
      );
    const project = this.repository.require<Project>("project", turn.projectId);
    const edit = turn.purpose === "implementation";
    if (edit) this.deps.assertLocalOwner(project.id);
    // Each member gets its own copy, so concurrent members never share a
    // checkout or a workspace lease.
    const source =
      turn.purpose === "candidate-review" || edit
        ? turn.candidateId
        : await this.contextSnapshot(turn.projectId, turn.goalId);
    let root: string;
    if (source) {
      const copy = await materializeCandidate(
        this.snapshot(source),
        undefined,
        this.store,
        { readOnlyFolders: !edit },
      );
      root = copy.root;
      // Materialized files are read-only; an implementation member's own copy
      // must be writable. Review and control copies stay read-only.
      if (edit) await makeWritable(root);
    } else root = await mkdtemp(path.join(os.tmpdir(), "topsl-control-"));
    const copyRecord: CopyRecord = {
      id: turn.launchId,
      projectId: turn.projectId,
      launchId: turn.launchId,
      attemptId: null,
      purpose: turn.purpose,
      root,
      readOnly: readOnlyPurposes.has(turn.purpose),
      candidateId: source,
      baselineId: edit ? source : null,
      permittedOutputs: turn.permittedOutputs,
      goalId: turn.goalId,
      state: "active",
    };
    this.store.put("orchestration-copy", copyRecord);
    let attempt: ExecutionAttempt | undefined;
    try {
      const identity = canonicalWorkspaceIdentity(root),
        at = now();
      const base = this.repository.ensureWorkspace(project);
      const workspace: Workspace = {
        ...base,
        id: uid(),
        root,
        canonicalRoot: identity.canonicalRoot,
        filesystemIdentity: identity.filesystemIdentity,
        checkoutType: "snapshot",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      this.store.immutable("workspace", workspace);
      let task = this.repository.createTask({
        projectId: project.id,
        workspaceId: workspace.id,
        title: `${turn.roleId} ${turn.memberId} · ${turn.phase}`,
        role: edit
          ? "implementer"
          : turn.purpose === "candidate-review"
            ? "reviewer"
            : turn.purpose === "information"
              ? "information"
              : "coordinator",
        inputRefs: source ? [source] : [],
        permittedOutputs: turn.permittedOutputs,
        requiredCapabilities: edit
          ? ["structured-turn", "workspace-write"]
          : ["structured-turn", "read-only"],
      });
      task = this.repository.transitionTask(task.id, task.revision, "ready");
      this.store.immutable("orchestration-task-goal", {
        id: task.id,
        projectId: project.id,
        goalId: turn.goalId,
        roundId: turn.roundId,
        memberId: turn.memberId,
      });
      const context: ContextPackage = {
        id: uid(),
        projectId: project.id,
        conversationId: null,
        hash: hash(turn.prompt),
        text: turn.prompt,
        specificationRevision: null,
        sourceRefs: source ? [source] : [],
        omissions: [],
        visibility: "restricted",
        completeness: "recorded",
        createdAt: at,
      };
      this.store.immutable("context-package", context);
      const revisions = new RevisionRepository(this.store);
      revisions.bindPackage(task.id, context.id);
      attempt = this.repository.prepareAttempt({
        taskId: task.id,
        expectedRevision: task.revision,
        provider: a.provider,
        requestedModel: a.model,
        freshSession: true,
        runtimeRevision: installation.revisionId,
        executableIdentity: installation.identity,
        contextPackageId: context.id,
        retryOfAttemptId: null,
      });
      revisions.bindPackage(task.id, context.id, attempt.id);
      this.store.immutable("attempt-runtime-settings", {
        id: attempt.id,
        projectId: project.id,
        effort: a.effort ?? null,
      });
      // Recorded before dispatch: a restart adopts this attempt instead of starting another.
      this.store.immutable("orchestration-launch", {
        id: turn.launchId,
        projectId: project.id,
        attemptId: attempt.id,
        roundId: turn.roundId,
        memberId: turn.memberId,
      });
      this.store.put("orchestration-copy", {
        ...copyRecord,
        attemptId: attempt.id,
      });
      // Member/session binding: one record per member attempt, even when two
      // members share a provider and a native account.
      this.store.immutable("member-session", {
        id: attempt.id,
        projectId: project.id,
        goalId: turn.goalId,
        roundId: turn.roundId,
        memberId: turn.memberId,
        assignmentId: a.id,
        assignmentRevision: a.revision,
        sessionId: attempt.sessionId,
        provider: a.provider,
        nativeAccountKey: a.nativeAccountKey,
        purpose: turn.purpose,
        createdAt: at,
      });
      if (a.fanout === "disabled") {
        const evidence = this.deps
          .capabilities(installation)
          .find((c) => c.name === "native-fanout-disabled");
        this.deps.coordinator.concurrency.setPolicy(attempt.id, {
          mode: "disabled",
          maxChildren: 0,
          enforced: true,
          approvalDigest: null,
          evidence: stable({
            installationRevision: installation.revisionId,
            capability: evidence ?? null,
          }),
        });
      }
      let tools: ToolBinding | undefined;
      if (turn.purpose === "candidate-review" && source) {
        const candidate = this.snapshot(source);
        const grant = this.deps.context.grant(project, {
          visibility: { messageIds: [] },
          candidates: [
            { candidateId: candidate.id, revision: candidate.revision },
          ],
          candidateVisibility: "task-inputs",
          subject: {
            attemptId: attempt.id,
            agentSessionId: attempt.sessionId,
            workflowId: candidate.workflowId,
            taskId: task.id,
          },
        });
        tools = candidateTools({
          context: this.deps.context,
          grant,
          attempt,
          candidate,
        });
      }
      const conversation: Conversation = {
        id: uid(),
        projectId: project.id,
        title: task.title,
        nativeSessions: {},
        createdAt: at,
      };
      this.store.save("conversation", conversation);
      await this.deps.start(
        installation,
        conversation,
        {
          ...project,
          path: root,
          realPath: identity.canonicalRoot,
          trusted: true,
        },
        turn.prompt,
        a.model,
        edit ? "edit" : "review",
        {
          attemptId: attempt.id,
          freshSession: true,
          purpose: turn.purpose,
          ...(tools ? { tools } : {}),
        },
      );
      return { attemptId: attempt.id };
    } catch (error) {
      if (attempt) {
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
          const task = this.repository.require<Task>("task", current.taskId);
          if (task.state === "active")
            this.repository.transitionTask(
              task.id,
              task.revision,
              "blocked",
              safeError(error),
            );
        }
        // The engine adopts this attempt through findLaunch and observes its state.
        throw error;
      }
      await removeMaterializedCopy(root).catch(() => {});
      this.store.put("orchestration-copy", {
        ...copyRecord,
        state: "processed",
      });
      throw error;
    }
  }

  private terminal(attempt: ExecutionAttempt) {
    return ["completed", "failed", "interrupted"].includes(attempt.state);
  }

  observe(attemptId: string): AttemptObservation {
    const attempt = this.repository.require<ExecutionAttempt>(
      "attempt",
      attemptId,
    );
    const evidence = attempt.modelEvidence;
    const base = { reportedEffort: null, evidence };
    if (attempt.state === "uncertain")
      return {
        ...base,
        state: "uncertain",
        quiescent: false,
        finalText: null,
        reportedModel: null,
      };
    if (!this.terminal(attempt))
      return {
        ...base,
        state: "running",
        quiescent: false,
        finalText: null,
        reportedModel: null,
      };
    const released = !this.deps.coordinator.ownership.forAttempt(attemptId);
    const copy = [
      ...this.store.iterate<CopyRecord>("orchestration-copy", {
        projectId: attempt.projectId,
      }),
    ].find((c) => c.attemptId === attemptId);
    const capture = this.store.get<CaptureRecord>(
      "orchestration-capture",
      attemptId,
    );
    // Results are used only after processes stopped and post-run checks ran.
    const quiescent = released && (!copy || copy.state === "processed");
    const metadata =
      this.store.get<{
        reported: { model: string | null; effort: string | null };
      }>("runtime-turn-result-metadata", attemptId) ??
      this.store.get<{
        reported: { model: string | null; effort: string | null };
      }>("runtime-turn-metadata", attemptId);
    const finalText =
      quiescent && attempt.state === "completed"
        ? ([
            ...this.store.iterate<Message>("message", {
              projectId: attempt.projectId,
            }),
          ]
            .filter(
              (m) => m.runId === attempt.legacyRunId && m.role === "assistant",
            )
            .at(-1)?.text ?? null)
        : null;
    return {
      state: attempt.state as AttemptObservation["state"],
      quiescent,
      finalText,
      reportedModel: attempt.reportedModel ?? metadata?.reported.model ?? null,
      reportedEffort: metadata?.reported.effort ?? null,
      candidateId: capture?.candidateId ?? null,
      error: capture?.error ?? attempt.error,
      evidence,
    };
  }

  async interrupt(attemptId: string): Promise<void> {
    const attempt = this.repository.require<ExecutionAttempt>(
      "attempt",
      attemptId,
    );
    if (attempt.legacyRunId) await this.deps.interrupt(attempt.legacyRunId);
  }

  /**
   * Post-run work for stopped attempts: capture implementation candidates and
   * check their outputs, prove review copies unchanged, remove copies. Runs
   * before each engine tick.
   */
  async sync(): Promise<void> {
    for (const copy of this.store.iterate<CopyRecord>("orchestration-copy")) {
      if (copy.state !== "active" || !copy.attemptId) continue;
      const attempt = this.store.get<ExecutionAttempt>(
        "attempt",
        copy.attemptId,
      );
      if (
        !attempt ||
        !this.terminal(attempt) ||
        this.deps.coordinator.ownership.forAttempt(attempt.id)
      )
        continue;
      let candidateId: string | null = null,
        error: string | null = null;
      try {
        if (
          copy.purpose === "implementation" &&
          attempt.state === "completed"
        ) {
          candidateId = await this.captureMember(copy, attempt);
        } else if (
          copy.readOnly &&
          copy.candidateId &&
          copy.purpose === "candidate-review"
        ) {
          await assertMaterializedCandidate(
            this.snapshot(copy.candidateId),
            copy.root,
            true,
          );
        }
      } catch (e) {
        error = safeError(e);
      }
      this.store.immutable("orchestration-capture", {
        id: attempt.id,
        projectId: attempt.projectId,
        candidateId,
        error,
        at: now(),
      } satisfies CaptureRecord);
      const task = this.store.get<Task>("task", attempt.taskId);
      if (task?.state === "active" && attempt.state === "completed")
        this.repository.transitionTask(
          task.id,
          task.revision,
          "submitted",
          error ??
            "Member result recorded; non-code results complete without candidate acceptance.",
          candidateId,
        );
      this.deps.context.revokeAttempt(attempt.id);
      await removeMaterializedCopy(copy.root).catch(() => {});
      this.store.put("orchestration-copy", { ...copy, state: "processed" });
    }
  }

  private async captureMember(
    copy: CopyRecord,
    attempt: ExecutionAttempt,
  ): Promise<string> {
    const baseline = this.snapshot(copy.baselineId!);
    const known = new Set(baseline.files.map((f) => f.path));
    const present: string[] = [];
    const walk = async (dir: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory())
          await walk(path.join(dir, entry.name), relative + "/");
        else present.push(relative);
      }
    };
    await walk(copy.root);
    // Unexpected files keep the output-review gate: agreement never admits them.
    const unexpected = present.filter(
      (p) => !known.has(p) && !copy.permittedOutputs.includes(p),
    );
    if (unexpected.length)
      throw new Error(
        `The member created files outside its permitted outputs (${unexpected.slice(0, 10).join(", ")}); output review is required.`,
      );
    const candidate = await captureCandidate(this.store, {
      root: copy.root,
      projectId: copy.projectId,
      workflowId: copy.goalId,
      authorAttemptId: attempt.id,
      baseCandidateId: baseline.id,
      selectedPaths: [
        ...new Set([
          ...known,
          ...copy.permittedOutputs.filter((p) => present.includes(p)),
        ]),
      ],
    });
    const outside = candidateChanges(baseline, candidate).filter(
      (f) => !copy.permittedOutputs.includes(f.path),
    );
    if (outside.length)
      throw new Error(
        `The member changed files outside its permitted outputs (${outside
          .slice(0, 10)
          .map((f) => f.path)
          .join(", ")}).`,
      );
    return candidate.id;
  }

  /**
   * Integrates member candidates in one controlled copy. Whole-file overlap
   * with different contents is a conflict for the owner; nothing is merged
   * textually.
   */
  async integrate(input: {
    projectId: string;
    goalId: string;
    baseCandidateId: string;
    candidateIds: string[];
    resolutions?: Array<{ path: string; candidateId: string }>;
  }) {
    const base = this.snapshot(input.baseCandidateId);
    const files = new Map(base.files.map((f) => [f.path, f]));
    const changes = new Map<
      string,
      Array<{ candidateId: string; file: CandidateSnapshot["files"][number] }>
    >();
    for (const id of input.candidateIds) {
      const candidate = this.snapshot(id);
      const baseline = candidate.baseCandidateId
        ? this.snapshot(candidate.baseCandidateId)
        : base;
      for (const file of candidateChanges(baseline, candidate)) {
        const list = changes.get(file.path) ?? [];
        list.push({ candidateId: id, file });
        changes.set(file.path, list);
      }
    }
    const resolutions = input.resolutions ?? [];
    if (
      new Set(resolutions.map((r) => r.path)).size !== resolutions.length ||
      resolutions.some(
        (r) =>
          !changes.get(r.path)?.some((v) => v.candidateId === r.candidateId),
      )
    )
      throw new Error(
        "Conflict resolutions must select a member candidate that changed that file.",
      );
    const conflicts: Array<{ path: string; candidateIds: string[] }> = [];
    for (const [name, list] of [...changes].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const resolution = resolutions.find((r) => r.path === name);
      const distinct = list.filter(
        (v, i) => list.findIndex((o) => fileEqual(o.file, v.file)) === i,
      );
      if (distinct.length > 1 && !resolution)
        conflicts.push({
          path: name,
          candidateIds: [...new Set(list.map((l) => l.candidateId))],
        });
      else
        files.set(
          name,
          resolution
            ? list.find((v) => v.candidateId === resolution.candidateId)!.file
            : list[0].file,
        );
    }
    if (conflicts.length) return { conflicts };
    const parent = this.deps.integrationRoot ?? os.tmpdir();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(parent, "topsl-integration-"));
    try {
      const merged = [...files.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      await writeManagedSnapshot(
        { ...base, files: merged.filter((f) => f.hash) },
        root,
        this.store,
      );
      const combined = await captureCandidate(this.store, {
        root,
        projectId: input.projectId,
        workflowId: input.goalId,
        baseCandidateId: base.id,
        selectedPaths: merged.filter((f) => f.hash).map((f) => f.path),
      });
      if (
        merged.some(
          (f) =>
            f.hash &&
            !fileEqual(
              f,
              combined.files.find((c) => c.path === f.path),
            ),
        )
      )
        throw new Error(
          "The integrated copy differs from the merged file manifest.",
        );
      // The copy is kept: required checks prove the candidate unchanged
      // against it before and after they run.
      return { candidateId: combined.id };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  bindChecks(input: {
    goalId: string;
    baselineCandidateId: string;
    checks: GoalCheckDefinition[];
  }) {
    try {
      bindCheckInputs(
        this.store,
        input.goalId,
        this.snapshot(input.baselineCandidateId),
        input.checks,
      );
    } catch (error) {
      if (/Immutable record collision/.test(safeError(error)))
        throw new Error(
          "A check with this ID was already bound to the goal's baseline with another definition. Give the changed check a new ID.",
        );
      throw error;
    }
  }

  checkTask(input: {
    projectId: string;
    goalId: string;
    candidateId: string;
    checks: GoalCheckDefinition[];
  }): string {
    const project = this.repository.require<Project>(
      "project",
      input.projectId,
    );
    const workspace = this.repository.ensureWorkspace(project);
    return this.store.transaction(() => {
      let task = this.repository.createTask({
        projectId: project.id,
        workspaceId: workspace.id,
        title: "Run required checks on the integrated candidate",
        role: "tester",
        inputRefs: [input.candidateId],
        acceptanceCriteria: input.checks.map((c) => c.label),
      });
      task = this.repository.transitionTask(task.id, task.revision, "ready");
      task = this.repository.transitionTask(task.id, task.revision, "active");
      this.store.immutable("orchestration-task-goal", {
        id: task.id,
        projectId: project.id,
        goalId: input.goalId,
        roundId: null,
        memberId: null,
      });
      return task.id;
    });
  }

  async previewChecks(input: {
    goalId: string;
    taskId: string;
    candidateId: string;
    checks: GoalCheckDefinition[];
  }): Promise<GoalCheckPlan[]> {
    const candidate = this.snapshot(input.candidateId);
    return Promise.all(
      input.checks.map((check) =>
        previewCheck(
          this.repository,
          input.goalId,
          input.taskId,
          candidate,
          check,
        ),
      ),
    );
  }

  checkPlan(planId: string): GoalCheckPlan | null {
    return this.store.get<CheckPlan>("workflow-check-plan", planId) ?? null;
  }

  async runCheck(planId: string, digest: string): Promise<void> {
    await executeCheck(
      this.repository,
      this.repository.require<CheckPlan>("workflow-check-plan", planId),
      digest,
    );
  }

  checkEvidence(input: {
    projectId: string;
    taskId: string;
    candidateId: string;
  }): GoalCheckEvidence[] {
    const candidate = this.store.get<CandidateSnapshot>(
      "candidate",
      input.candidateId,
    );
    if (!candidate) return [];
    return this.repository
      .all<Verification>("verification", { projectId: input.projectId })
      .filter(
        (v) =>
          v.taskId === input.taskId &&
          v.candidateId === candidate.id &&
          v.targetRevision === candidate.revision &&
          !v.invalidatedAt,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((v) => ({
        definitionId: v.definition,
        verificationId: v.id,
        result: v.result,
        targetRevision: v.targetRevision,
        evidenceArtifactId: v.evidenceArtifactId ?? null,
      }));
  }

  cancelChecks(goalId: string) {
    CheckExecutions.for(this.store).cancelWorkflow(goalId);
  }

  async applyPreview(input: {
    projectId: string;
    goalId: string;
    baselineCandidateId: string;
    candidateId: string;
  }): Promise<ApplyPreview> {
    const project = this.repository.require<Project>(
      "project",
      input.projectId,
    );
    const baseline = this.snapshot(input.baselineCandidateId);
    const candidate = this.snapshot(input.candidateId);
    const problems: string[] = [];
    if (!project.trusted) problems.push("The project folder must be trusted.");
    if (baseline.sourceRoot !== project.realPath)
      problems.push(
        "The project was relinked to another folder after this goal started.",
      );
    if (!baseline.git)
      problems.push(
        "Applying needs a Git checkout, so Topsl can show the folder has no other changes.",
      );
    else
      try {
        const dirty = await gitWorkingTreeChanges(
          project.realPath,
          this.deps.gitExecutable,
        );
        if (dirty.length)
          problems.push(
            `The project folder has uncommitted or untracked changes (${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? `, and ${dirty.length - 8} more` : ""}). Commit, stash or remove them, then apply.`,
          );
      } catch (error) {
        problems.push(
          `Git could not report the folder's state: ${safeError(error)}`,
        );
      }
    try {
      await assertCandidateCurrent(baseline, this.deps.gitExecutable);
    } catch (error) {
      problems.push(
        `The project folder changed since the goal's baseline: ${safeError(error)}`,
      );
    }
    const before = new Set(
      baseline.files.filter((f) => f.hash).map((f) => f.path),
    );
    return {
      root: project.realPath,
      baseRevision: baseline.baseRevision,
      files: candidateChanges(baseline, candidate).map((f) => ({
        path: f.path,
        change:
          f.hash === null
            ? "deleted"
            : before.has(f.path)
              ? "modified"
              : "added",
      })),
      problems,
    };
  }

  /**
   * Writes the accepted candidate's changes into the project folder, only
   * when the folder is clean and still matches the goal's baseline, then
   * reads every written file back.
   */
  async apply(input: {
    projectId: string;
    goalId: string;
    baselineCandidateId: string;
    candidateId: string;
  }): Promise<{ applied: GoalApplication["files"] } | { refused: string }> {
    this.deps.assertLocalOwner(input.projectId);
    const preview = await this.applyPreview(input);
    if (preview.problems.length) return { refused: preview.problems.join(" ") };
    const baseline = this.snapshot(input.baselineCandidateId);
    const candidate = this.snapshot(input.candidateId);
    const changed = candidateChanges(baseline, candidate);
    await writeManagedSnapshot(
      { ...candidate, files: changed },
      preview.root,
      this.store,
    );
    for (const file of changed) {
      const target = path.join(preview.root, file.path);
      if (file.hash === null) {
        const gone = await stat(target).then(
          () => false,
          () => true,
        );
        if (!gone) throw new Error(`${file.path} was not removed.`);
        continue;
      }
      const bytes = await readFile(target);
      if (createHash("sha256").update(bytes).digest("hex") !== file.hash)
        throw new Error(`${file.path} does not match the accepted candidate.`);
    }
    return { applied: preview.files };
  }
}
