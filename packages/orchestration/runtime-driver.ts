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
import {
  agentJobsEnabled,
  withAgentJobTools,
  type AgentJobAuthority,
  type AgentJobService,
} from "./agent-jobs";
import type {
  Conversation,
  Installation,
  Message,
  Project,
  Run,
} from "../domain/types";
import type {
  ContextPackage,
  Evidence,
  ExecutionAttempt,
  Task,
  Verification,
  Workspace,
} from "../domain/workflow";
import {
  memberEngine,
  requestedFunding,
  type ExecutionPurpose,
  type Goal,
  type ObservedFunding,
  type ResolvedMemberAssignment,
  type GoalApplication,
  type GoalCheckDefinition,
  type NativeRouteBinding,
} from "../domain/role-groups";
import type { NativeHarness } from "../harness/harness";
import { terminalStates, type NativeAttemptView } from "../harness/types";
import type { Connection, ProxyRoute } from "../proxy/types";
import { memberCapabilityBlockers } from "../proxy/capabilities";
import { nativeRouteReadiness } from "../providers/readiness";
import { reviewOutputSchema } from "../workflows/builder-reviewer";
import { purposeOutputSchema } from "./contracts";
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
  candidateFileBytes,
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
  /**
   * Topsl's native harness, for members bound to a local proxy route
   * (docs/Native_Harness_Plan.md, Phases 6b and 7). Absent: no native
   * routes are offered.
   */
  native?: NativeMemberHost;
  /**
   * The orchestrator's agent-job service, read at launch (the orchestrator
   * is built after the driver). Absent or null: no turn gets job tools.
   */
  agentJobs?: () => AgentJobService | null;
}

/** The native harness and the proxy routes the control service can see. */
export interface NativeMemberHost {
  harness: NativeHarness;
  /** Sanitized proxy routes with their connections; never a credential. */
  routes(): Array<{ route: ProxyRoute; connection: Connection }>;
  /** Whether the proxy process is running now. */
  running(): boolean;
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
  /** Set for a native member's copy; absent for vendor runs. */
  engine?: "native";
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

/** Why a native member attempt did not end with a usable answer, when the driver ended it. */
interface NativeEnding {
  id: string;
  projectId: string;
  detail: string;
  at: string;
}

const activeNativeStates = new Set<NativeAttemptView["state"]>([
  "starting",
  "running",
  "waiting-model",
  "running-tools",
  "waiting-children",
]);

/** The native route identity a member assignment freezes. */
export function nativeRouteBinding(
  route: ProxyRoute,
  connection: Connection,
): NativeRouteBinding {
  return {
    routeId: route.id,
    routeAlias: route.alias,
    routeRevision: route.revision,
    connectionId: connection.id,
    connectionKind: connection.kind,
    connectionLabel: connection.label,
    protocol: route.protocol,
    upstreamModel: route.upstreamModel,
    funding: connection.funding,
    accountKey: connection.account.accountKey,
    quotaOwner: connection.account.quotaOwner,
  };
}

const fundingLabels: Record<Connection["funding"], string> = {
  subscription: "plan allowance",
  "api-billing": "API billing",
  gateway: "managed by external service",
  local: "local",
};

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
 * readiness gates as other workflows. A Claude member runs only when its
 * runtime's readiness allows it: the owner's structured-route setting and a
 * current Claude qualification of what the purpose needs (see the runtime
 * manager); nothing here lifts those checks.
 */
export class RuntimeOrchestrationDriver implements OrchestrationDriver {
  /** Native attempts recorded and being started now. */
  private starting = new Set<string>();
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
    routes.push(...this.nativeRoutes());
    return routes;
  }

  /**
   * One candidate per native proxy route: its single model is the route's
   * upstream model, and its readiness needs no installation or vendor
   * qualification (packages/providers/readiness.ts nativeRouteReadiness).
   */
  private nativeRoutes(): RouteCandidate[] {
    const host = this.deps.native;
    if (!host) return [];
    const running = host.running();
    return host.routes().map(({ route, connection }) => {
      const binding = nativeRouteBinding(route, connection);
      return {
        provider: "native",
        engine: "native",
        installationId: null,
        installationRevision: null,
        executableIdentity: null,
        native: binding,
        route: "managed-structured",
        nativeAccountKey: connection.account.accountKey,
        nativeProfileId: null,
        // The vendor billing routes do not describe proxy funding; the
        // native binding carries it.
        billingRoute: null,
        accountLabel: `${connection.label} · ${fundingLabels[connection.funding]}`,
        catalog: {
          models: [
            {
              id: route.alias,
              model: route.upstreamModel,
              name: route.alias,
              description: `${connection.label} (${fundingLabels[connection.funding]})`,
              isDefault: false,
              // No observed effort catalog: a pinned effort is refused.
              supportedReasoningEfforts: [],
            },
          ],
          observedAt: route.updatedAt,
          // The route is the owner's own configuration, read now.
          fresh: true,
        },
        purposes: Object.fromEntries(
          purposes.map((purpose) => [
            purpose,
            nativeRouteReadiness(
              {
                alias: route.alias,
                disabled: route.disabled,
                structuredOutput:
                  route.capabilities.structuredOutput ?? "unknown",
                connectionLabel: connection.label,
                connectionState: connection.state,
                connectionDetail: connection.stateDetail,
                proxyRunning: running,
                capabilityBlockers: memberCapabilityBlockers(
                  route,
                  connection,
                  purpose !== "direct-chat",
                ),
              },
              purpose,
            ),
          ]),
        ),
        // Member turns get no delegation tool, so no hidden fan-out.
        fanout: "disabled",
      } satisfies RouteCandidate;
    });
  }

  capacity() {
    const snapshot = this.deps.coordinator.concurrency.snapshot();
    return {
      total: snapshot.totalLimit,
      perProvider: snapshot.perProviderLimit,
      held: [
        ...snapshot.active.map(
          (s: { provider: "codex" | "claude"; weight: number }) => ({
            provider: s.provider as RouteCandidate["provider"],
            weight: s.weight,
          }),
        ),
        // A native member holds one slot while it executes. One waiting on
        // its allowance, or paused, holds none: it makes no requests.
        ...this.nativeCopies()
          .filter((c) => {
            const view = this.deps.native!.harness.view(c.attemptId!);
            return !!view && activeNativeStates.has(view.state);
          })
          .map(() => ({ provider: "native" as const, weight: 1 })),
      ],
    };
  }

  private nativeCopies(): CopyRecord[] {
    if (!this.deps.native) return [];
    return [...this.store.iterate<CopyRecord>("orchestration-copy")].filter(
      (c) => c.engine === "native" && c.state === "active" && !!c.attemptId,
    );
  }

  private isNative(attemptId: string): boolean {
    return (
      this.store.get<{ engine?: string }>("orchestration-native-member", attemptId)
        ?.engine === "native"
    );
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
    if (memberEngine(a) === "native") return this.launchNative(turn);
    if (
      a.status !== "resolved" ||
      !a.installationId ||
      !a.model ||
      (a.provider !== "codex" && a.provider !== "claude")
    )
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
    const { root, source, copyRecord } = await this.memberCopy(turn);
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
      // Codex reads its read-only copy through its own sandbox. Claude Code's
      // read-only turns have no file tools, so a Claude coordinator or
      // information turn reads its copy through Topsl's candidate reader when
      // a qualification observed that reader for this runtime and model;
      // without it, a live Claude coordinator asked about the project wrote
      // invented tool calls and file contents (29 October 2026).
      const reads =
        turn.purpose === "candidate-review" ||
        (a.provider === "claude" &&
          !edit &&
          !this.deps.purposeReadiness(
            installation,
            {
              installationId: installation.id,
              provider: "claude",
              model: a.model,
            },
            "candidate-review",
          ).blockers.length);
      if (reads && source) {
        const candidate = this.snapshot(source);
        // The engine chose this candidate for the turn; it may come from an
        // earlier workflow (a loop checkpoint, a continued session's work).
        this.store.immutable("candidate-input-binding", {
          id: attempt.id,
          projectId: project.id,
          goalId: turn.goalId,
          candidateId: candidate.id,
        });
        const grant = this.deps.context.grant(project, {
          visibility: { messageIds: [] },
          candidates: [
            { candidateId: candidate.id, revision: candidate.revision },
          ],
          candidateVisibility: "task-inputs",
          subject: {
            attemptId: attempt.id,
            agentSessionId: attempt.sessionId,
            // The reading goal; its candidate may be its declared baseline
            // from an earlier workflow (validateCandidateAccess).
            workflowId: turn.goalId,
            taskId: task.id,
          },
        });
        tools = candidateTools({
          context: this.deps.context,
          grant,
          attempt,
          candidate,
          workflowId: turn.goalId,
        });
        const jobs = this.jobAuthority(turn, attempt.id);
        if (jobs) tools = withAgentJobTools(tools, jobs, attempt.id);
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
          protocol: turn.protocol,
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

  /**
   * The member's own Topsl-owned copy, so concurrent members never share a
   * checkout or a workspace lease. A loop turn reads its iteration's
   * accepted content; it never captures the original folder again.
   */
  private async memberCopy(
    turn: MemberTurn,
    engine?: "native",
  ): Promise<{ root: string; source: string | null; copyRecord: CopyRecord }> {
    const edit = turn.purpose === "implementation";
    const source =
      turn.purpose === "candidate-review" || edit
        ? turn.candidateId
        : (turn.contextCandidateId ??
          (await this.contextSnapshot(turn.projectId, turn.goalId)));
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
      ...(engine ? { engine } : {}),
    };
    this.store.put("orchestration-copy", copyRecord);
    return { root, source, copyRecord };
  }

  /**
   * Starts a native member turn: Topsl's harness runs it in the member's own
   * copy on the route the assignment froze. The route's revision, connection
   * and account must still match, or the group resolves again; nothing is
   * redirected to another route or account. The turn's output contract is
   * the same JSON Schema a vendor runtime enforces for this purpose and
   * protocol, carried through the proxy.
   */
  private async launchNative(turn: MemberTurn): Promise<{ attemptId: string }> {
    const host = this.deps.native;
    const a = turn.assignment;
    if (!host)
      throw new Error("Topsl's native harness is not available here.");
    if (a.status !== "resolved" || !a.native || !a.model)
      throw new Error("The member has no resolved native route.");
    const frozen = a.native;
    const current = host.routes().find((r) => r.route.id === frozen.routeId);
    if (!current)
      throw new Error(
        `The member's route ${frozen.routeAlias} no longer exists. Resolve the group again.`,
      );
    if (
      current.route.revision !== frozen.routeRevision ||
      current.connection.id !== frozen.connectionId ||
      current.connection.account.accountKey !== frozen.accountKey ||
      current.route.upstreamModel !== a.model
    )
      throw new Error(
        `The member's route ${frozen.routeAlias} changed since it was assigned (route, connection, account or model). Resolve the group again.`,
      );
    const project = this.repository.require<Project>("project", turn.projectId);
    const edit = turn.purpose === "implementation";
    if (edit) this.deps.assertLocalOwner(project.id);
    const schema =
      turn.purpose === "candidate-review"
        ? (reviewOutputSchema as Record<string, unknown>)
        : purposeOutputSchema(turn.purpose, turn.protocol);
    const { root, source, copyRecord } = await this.memberCopy(turn, "native");
    const attemptId = uid();
    const at = now();
    // Recorded before dispatch: a restart adopts this attempt instead of
    // starting another, and observe reports it failed if it never began.
    this.store.immutable("orchestration-native-member", {
      id: attemptId,
      projectId: project.id,
      engine: "native",
      launchId: turn.launchId,
      goalId: turn.goalId,
      roundId: turn.roundId,
      memberId: turn.memberId,
      routeId: frozen.routeId,
      routeRevision: frozen.routeRevision,
      createdAt: at,
    });
    this.store.immutable("orchestration-launch", {
      id: turn.launchId,
      projectId: project.id,
      attemptId,
      roundId: turn.roundId,
      memberId: turn.memberId,
    });
    this.store.put("orchestration-copy", { ...copyRecord, attemptId });
    this.starting.add(attemptId);
    const jobs = this.jobAuthority(turn, attemptId);
    // An implementer may run the goal's plain checks (no environment recipe)
    // in its own copy before it submits; Topsl still runs the required checks
    // on the integrated candidate.
    const goalChecks = edit
      ? (this.store.get<Goal>("goal", turn.goalId)?.checks ?? [])
          .filter((c) => !c.environmentRecipeId)
          .map((c) => ({
            name: c.id,
            argv: [c.executable, ...c.args],
            timeoutMs: c.timeoutMs,
          }))
      : [];
    try {
      const view = await host.harness.startMember({
        ...(jobs ? { agentJobs: true } : {}),
        ...(goalChecks.length ? { checks: goalChecks } : {}),
        attemptId,
        projectId: project.id,
        routeAlias: frozen.routeAlias,
        title: `${turn.roleId} ${turn.memberId} · ${turn.phase}`,
        prompt: turn.prompt,
        workspace: { root, writable: edit, baselineCandidateId: source },
        outputSchema: schema
          ? { name: outputSchemaName(turn), schema }
          : null,
        member: {
          goalId: turn.goalId,
          roundId: turn.roundId,
          memberId: turn.memberId,
          launchId: turn.launchId,
          purpose: turn.purpose,
          protocol: `${turn.protocol.kind}${turn.protocol.stage ? `:${turn.protocol.stage}` : ""}`,
        },
        reasoningEffort: a.effort ?? null,
        maxRequests: null,
      });
      // Member/session binding, as for vendor members: one per attempt.
      this.store.immutable("member-session", {
        id: attemptId,
        projectId: project.id,
        goalId: turn.goalId,
        roundId: turn.roundId,
        memberId: turn.memberId,
        assignmentId: a.id,
        assignmentRevision: a.revision,
        sessionId: attemptId,
        provider: "native",
        engine: "native",
        nativeAccountKey: frozen.accountKey,
        binding: view.binding,
        purpose: turn.purpose,
        createdAt: at,
      });
      return { attemptId };
    } catch (error) {
      // The engine adopts the recorded attempt through findLaunch; it reads
      // as failed with this reason, and its copy is removed.
      this.store.put("orchestration-native-ending", {
        id: attemptId,
        projectId: project.id,
        detail: `The native turn did not start: ${safeError(error)}`,
        at: now(),
      } satisfies NativeEnding);
      throw error;
    } finally {
      this.starting.delete(attemptId);
    }
  }

  private terminal(attempt: ExecutionAttempt) {
    return ["completed", "failed", "interrupted"].includes(attempt.state);
  }

  /**
   * Records an agent-job authority for a coordinator's contribution turn on
   * an engine goal while the owner's gate is on, and returns the service
   * that answers its job tools. Loops, sessions and every other purpose get
   * none, so a child never holds the authority to start more children.
   */
  private jobAuthority(turn: MemberTurn, attemptId: string) {
    const jobs = this.deps.agentJobs?.() ?? null;
    if (
      !jobs ||
      turn.purpose !== "coordinator-contribution" ||
      turn.phase !== "initial" ||
      !agentJobsEnabled(this.store)
    )
      return null;
    const goal = this.store.get<Goal>("goal", turn.goalId);
    if (!goal || goal.projectId !== turn.projectId || goal.loop) return null;
    this.store.immutable("agent-job-authority", {
      id: attemptId,
      projectId: turn.projectId,
      goalId: goal.id,
      roundId: turn.roundId,
      memberId: turn.memberId,
      controlGeneration: goal.controlGeneration,
      createdAt: now(),
    } satisfies AgentJobAuthority);
    return jobs;
  }

  observe(attemptId: string): AttemptObservation {
    if (this.isNative(attemptId)) return this.observeNative(attemptId);
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
        runId: attempt.legacyRunId,
        error: attempt.error,
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
      funding: this.vendorFunding(attempt.legacyRunId),
      candidateId: capture?.candidateId ?? null,
      error: capture?.error ?? attempt.error,
      evidence,
    };
  }

  /**
   * What a vendor runtime reported about a turn's credentials. Claude Code
   * reports its credential source in its init record (`apiKeySource`, "none"
   * for its own login); otherwise the only evidence is the account status
   * Topsl read before launch, labelled as such.
   */
  private vendorFunding(runId: string | null): ObservedFunding | null {
    const run = runId ? this.store.get<Run>("run", runId) : undefined;
    if (!run) return null;
    if (run.provider === "claude" && typeof run.credentialSource === "string")
      return run.credentialSource === "none"
        ? {
            observed: "subscription",
            source: "Claude Code init record",
            detail:
              "Claude Code reported no API key source for the turn: it ran on its own login.",
          }
        : {
            observed: "api-billing",
            source: "Claude Code init record",
            detail: `Claude Code reported credentials from ${run.credentialSource.slice(0, 80)}.`,
          };
    const route = this.store.get<{
      account: { billingRoute: ResolvedMemberAssignment["billingRoute"] };
      observedAt?: string;
    }>("runtime-account-observation", run.installationId)?.account
      .billingRoute;
    if (!route) return null;
    return {
      observed: requestedFunding({ billingRoute: route }),
      source: "account status before launch",
      detail: `The runtime reported nothing for the turn itself; its account status before launch named the ${route} billing route.`,
    };
  }

  /**
   * What a native member's attempt shows the engine. A turn waiting on its
   * allowance, paused for no progress, or paused by the owner is still
   * running: the engine waits and never starts a replacement. A turn the
   * driver ended (its request budget used) reads as failed with that reason.
   */
  private observeNative(attemptId: string): AttemptObservation {
    const host = this.deps.native;
    const view = host?.harness.view(attemptId) ?? null;
    const ending = this.store.get<NativeEnding>(
      "orchestration-native-ending",
      attemptId,
    );
    const copy = this.copyOf(attemptId);
    const capture = this.store.get<CaptureRecord>(
      "orchestration-capture",
      attemptId,
    );
    const route = view?.binding.native;
    const evidence: Evidence = {
      level: view?.reportedModel ? "provider-ack" : "none",
      source: "native-harness",
      observedAt: view?.updatedAt ?? null,
      detail: route
        ? `Topsl's native harness on ${route.routeAlias} (${route.connectionLabel}, ${fundingLabels[route.funding]}): ${view!.requests} model requests; the model is as the upstream reported it.`
        : "The native turn did not start.",
    };
    const base = {
      reportedEffort: null,
      evidence,
      runId: null,
      // The proxy dispatches only on the route revision the attempt froze
      // and refuses a changed one, so the connection's funding is the turn's.
      funding: route
        ? {
            observed: requestedFunding({ billingRoute: null, native: route }),
            source: "proxy route binding",
            detail: `Dispatched through ${route.connectionLabel} (${fundingLabels[route.funding]}) on its frozen route revision.`,
          }
        : null,
    };
    const processed = !copy || copy.state === "processed";
    if (!view)
      return {
        ...base,
        state: "failed",
        quiescent: processed,
        finalText: null,
        reportedModel: null,
        error:
          ending?.detail ?? "The native turn did not start before Topsl stopped.",
      };
    if (view.state === "uncertain")
      return {
        ...base,
        state: "uncertain",
        quiescent: false,
        finalText: null,
        reportedModel: view.reportedModel ?? null,
        error: view.stateDetail,
      };
    if (!terminalStates.has(view.state))
      return {
        ...base,
        state: "running",
        quiescent: false,
        finalText: null,
        reportedModel: null,
        wait: nativeWait(view),
      };
    const quiescent = processed && !host!.harness.kernel.isRunning(attemptId);
    return {
      ...base,
      state:
        view.state === "completed"
          ? "completed"
          : view.state === "cancelled" && !ending
            ? "interrupted"
            : "failed",
      quiescent,
      finalText:
        quiescent && view.state === "completed" ? view.summary : null,
      reportedModel: view.reportedModel ?? null,
      candidateId: capture?.candidateId ?? null,
      error:
        capture?.error ??
        ending?.detail ??
        (view.state === "completed" ? null : view.stateDetail),
    };
  }

  private copyOf(attemptId: string): CopyRecord | undefined {
    return [...this.store.iterate<CopyRecord>("orchestration-copy")].find(
      (c) => c.attemptId === attemptId,
    );
  }

  async interrupt(attemptId: string): Promise<void> {
    // Stopping a native member cancels its descendants too, and the kernel
    // refuses any further launch under it.
    if (this.isNative(attemptId)) {
      await this.deps.native?.harness.cancel(attemptId);
      return;
    }
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
      if (copy.engine === "native") {
        await this.syncNative(copy);
        continue;
      }
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
          candidateId = await this.captureMember(copy, attempt.id);
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
      // Written once per attempt. A stop between this record and the copy
      // being marked processed brings the copy here again; a second record,
      // with a new time, would be refused as a collision on every tick.
      if (!this.store.get<CaptureRecord>("orchestration-capture", attempt.id))
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

  /**
   * Post-run work for a native member: a turn paused at its request budget
   * ends (a bounded episode), one paused by a Topsl restart continues (its
   * journal was reconciled, and member turns run no commands), and a
   * finished turn's copy is captured or checked, then removed.
   */
  private async syncNative(copy: CopyRecord): Promise<void> {
    const host = this.deps.native;
    const attemptId = copy.attemptId!;
    if (!host || this.starting.has(attemptId)) return;
    let view = host.harness.view(attemptId);
    if (view?.state === "paused" && !host.harness.kernel.isRunning(attemptId)) {
      if (view.pauseKind === "budget") {
        this.store.put("orchestration-native-ending", {
          id: attemptId,
          projectId: copy.projectId,
          detail: `The native turn ended without an answer: ${view.stateDetail ?? "its request budget is used."}`,
          at: now(),
        } satisfies NativeEnding);
        await host.harness.cancel(attemptId);
      } else if (view.pauseKind === "restart") {
        try {
          await host.harness.resume(attemptId);
          return;
        } catch (error) {
          // Claimed or finished meanwhile.
          if ((error as { code?: string } | null)?.code !== "route-retired")
            return;
          // Its route was retired: the member ends with that reason, and
          // nothing moves it to another route, account or engine.
          this.store.put("orchestration-native-ending", {
            id: attemptId,
            projectId: copy.projectId,
            detail: (error as Error).message,
            at: now(),
          } satisfies NativeEnding);
          await host.harness.cancel(attemptId);
        }
      } else return;
      view = host.harness.view(attemptId);
    }
    if (view && (!terminalStates.has(view.state) || host.harness.kernel.isRunning(attemptId)))
      return;
    let candidateId: string | null = null,
      error: string | null = null;
    if (!view)
      error =
        this.store.get<NativeEnding>("orchestration-native-ending", attemptId)
          ?.detail ?? "The native turn did not start before Topsl stopped.";
    else
      try {
        if (copy.purpose === "implementation" && view.state === "completed")
          candidateId = await this.captureMember(copy, attemptId);
        else if (
          copy.readOnly &&
          copy.candidateId &&
          copy.purpose === "candidate-review"
        )
          await assertMaterializedCandidate(
            this.snapshot(copy.candidateId),
            copy.root,
            true,
          );
      } catch (e) {
        error = safeError(e);
      }
    // Written once per attempt, as in `sync`.
    if (!this.store.get<CaptureRecord>("orchestration-capture", attemptId))
      this.store.immutable("orchestration-capture", {
        id: attemptId,
        projectId: copy.projectId,
        candidateId,
        error,
        at: now(),
      } satisfies CaptureRecord);
    await removeMaterializedCopy(copy.root).catch(() => {});
    if (view) await host.harness.discardWorkspace(attemptId).catch(() => {});
    this.store.put("orchestration-copy", { ...copy, state: "processed" });
  }

  private async captureMember(
    copy: CopyRecord,
    attemptId: string,
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
      owned: true,
      projectId: copy.projectId,
      workflowId: copy.goalId,
      authorAttemptId: attemptId,
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
    ancestry?: Record<string, string[]>;
  }) {
    const base = this.snapshot(input.baseCandidateId);
    const ancestry = input.ancestry ?? {};
    const descends = (a: string, b: string): boolean =>
      (ancestry[a] ?? []).includes(b);
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
    for (const [name, all] of [...changes].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      // A change built on a predecessor's result supersedes that predecessor's
      // version of the same path: it is included once and never reverted.
      const list = all.filter(
        (v) =>
          !all.some(
            (o) =>
              o.candidateId !== v.candidateId &&
              descends(o.candidateId, v.candidateId),
          ),
      );
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
        owned: true,
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

  /**
   * A session goal's baseline: the session's accepted candidate, copied into
   * a Topsl-owned folder and captured for the new goal, so the next goal
   * continues from it whether or not it was applied to the project folder.
   */
  async continueFrom(input: {
    projectId: string;
    goalId: string;
    candidateId: string;
  }): Promise<string> {
    const prior = this.store.get<{ candidateId: string }>(
      "session-continuation",
      input.goalId,
    );
    if (prior) return prior.candidateId;
    const source = this.snapshot(input.candidateId);
    const parent = this.deps.integrationRoot ?? os.tmpdir();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(parent, "topsl-continuation-"));
    try {
      const files = source.files.filter((f) => f.hash);
      await writeManagedSnapshot({ ...source, files }, root, this.store);
      const captured = await captureCandidate(this.store, {
        root,
        owned: true,
        projectId: input.projectId,
        workflowId: input.goalId,
        baseCandidateId: source.id,
        selectedPaths: files.map((f) => f.path),
      });
      if (
        files.some(
          (f) =>
            !fileEqual(
              f,
              captured.files.find((c) => c.path === f.path),
            ),
        )
      )
        throw new Error(
          "The owned copy differs from the accepted result it was made from.",
        );
      this.store.immutable("session-continuation", {
        id: input.goalId,
        projectId: input.projectId,
        candidateId: captured.id,
        sourceCandidateId: source.id,
      });
      return captured.id;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  fileText(candidateId: string, filePath: string): string | null {
    const candidate = this.store.get<CandidateSnapshot>(
      "candidate",
      candidateId,
    );
    const file = candidate?.files.find((f) => f.path === filePath && f.hash);
    if (!candidate || !file) return null;
    const bytes = candidateFileBytes(candidate, file, this.store);
    if (!bytes || bytes.includes(0)) return null;
    return bytes.toString("utf8");
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

/** A schema name OpenAI accepts, from the turn's protocol and purpose. */
function outputSchemaName(turn: MemberTurn): string {
  return `${turn.protocol.kind}_${turn.purpose}${turn.protocol.stage ? `_${turn.protocol.stage}` : ""}`
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64);
}

/** Why a running native member is not making requests now, or null. */
function nativeWait(view: NativeAttemptView): AttemptObservation["wait"] {
  const route = view.binding.native;
  if (view.state === "waiting-quota")
    return {
      kind: "quota",
      quotaOwner: route?.quotaOwner ?? null,
      detail: `Waiting for ${route?.connectionLabel ?? "the connection"}'s allowance: ${view.stateDetail ?? "it reported its usage limit."} Every turn on this allowance waits; none restarts.`,
    };
  if (view.state !== "paused") return null;
  if (view.pauseKind === "repetition")
    return {
      kind: "no-progress",
      quotaOwner: null,
      detail: `Paused for no progress: ${view.stateDetail ?? "it repeated a failing operation."} It waits for the owner under Native tasks instead of restarting.`,
    };
  return {
    kind: "paused",
    quotaOwner: null,
    detail: `Paused: ${view.stateDetail ?? "by the owner."}`,
  };
}
