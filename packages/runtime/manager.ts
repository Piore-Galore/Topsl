import os from "node:os";
import { spawn as spawnPty, type IPty } from "node-pty";
import { RpcPeer } from "./rpc";
import { Coordinator, type RuntimeExecution } from "./coordinator";
import { CodexAdapter } from "../providers/codex";
import type {
  PreparedTurn,
  ProviderAdapter,
  ProviderConnection,
} from "../providers/contract";
import type { Workspace } from "../domain/workflow";
import { canonicalWorkspaceIdentity } from "../workspace/ownership";
import { Store } from "../persistence/store";
import type {
  Approval,
  Conversation,
  Installation,
  Message,
  Project,
  Run,
  ServiceEvent,
} from "../domain/types";
import {
  hash,
  normalizeUsage,
  now,
  safeError,
  stable,
  uid,
} from "../domain/invariants";
import {
  affectedProcesses,
  billingConflicts,
  identity,
  nativeEnvironment,
} from "../platform/system";

type Active = {
  run: Run;
  client: ProviderConnection;
  adapter: ProviderAdapter;
  approvals: Map<string, { approval: Approval; params: any }>;
  finished: boolean;
  dispatched: boolean;
};
export class RuntimeManager {
  private active = new Map<string, Active>();
  private terminals = new Map<
    string,
    {
      process: IPty;
      projectId: string;
      installation: Installation;
      login: boolean;
      run: Run;
    }
  >();
  private openingWorkspaces = new Map<string, string>();
  private closing = false;
  readonly coordinator: Coordinator;
  private ownsCoordinator: boolean;
  private adapters: Partial<Record<"codex" | "claude", ProviderAdapter>>;
  constructor(
    private store: Store,
    private emit: (event: ServiceEvent) => void,
    private changed: () => void,
    private peer = (executable: string, cwd: string) =>
      new RpcPeer(executable, ["app-server"], cwd),
    coordinator?: Coordinator,
    adapters: Partial<Record<"codex" | "claude", ProviderAdapter>> = {},
  ) {
    this.ownsCoordinator = !coordinator;
    this.coordinator = coordinator ?? new Coordinator(store);
    this.adapters = { codex: new CodexAdapter(this.peer), ...adapters };
    for (const run of store.iterate<Run>("run"))
      if (["starting", "running", "awaiting-approval"].includes(run.status))
        store.save("run", {
          ...run,
          status: "uncertain",
          error:
            "Topsl stopped while this native run was active. Inspect the native session before continuing; nothing was replayed.",
        });
    for (const approval of store.iterate<Approval>("approval"))
      store.remove("approval", approval.id);
  }
  capabilities(installation: Installation) {
    const provider = installation.appId.includes("claude") ? "claude" : "codex";
    return this.adapters[provider]?.capabilities(installation) ?? [];
  }
  isProjectBusy(id: string): boolean {
    return (
      [...this.openingWorkspaces.values()].includes(id) ||
      [...this.active.values()].some((a) => a.run.projectId === id) ||
      [...this.terminals.values()].some((t) => t.projectId === id)
    );
  }
  terminalState(): Array<{
    id: string;
    projectId: string;
    installationId: string;
    login: boolean;
  }> {
    return [...this.terminals.entries()].map(([id, t]) => ({
      id,
      projectId: t.projectId,
      installationId: t.installation.id,
      login: t.login,
    }));
  }
  hasActive(): boolean {
    return !!(
      this.active.size ||
      this.terminals.size ||
      this.openingWorkspaces.size
    );
  }
  isUnitBusy(id: string): boolean {
    return (
      [...this.active.values()].some((a) => a.run.managementUnitId === id) ||
      [...this.terminals.values()].some(
        (t) => t.installation.managementUnitId === id,
      )
    );
  }
  private async preflight(installation: Installation): Promise<void> {
    if (!installation.trusted)
      throw new Error(
        "Review and trust this executable in Applications first.",
      );
    if ((await identity(installation.path)).identity !== installation.identity)
      throw new Error(
        "The installed executable changed. Rediscover and reconnect before running.",
      );
    if (billingConflicts().length)
      throw new Error(
        `API or third-party billing environment is present (${billingConflicts().join(", ")}). This subscription-only pilot requires a clean launch environment.`,
      );
    if (/\.cmd$/i.test(installation.path))
      throw new Error(
        "Select the native executable. Shell wrappers are not launched by the structured broker.",
      );
  }
  async inspect(
    installation: Installation,
  ): Promise<{ models: any[]; account: any; info: any }> {
    await this.preflight(installation);
    if (installation.appId !== "openai.codex-cli")
      throw new Error(
        "Use the Claude native terminal for account and model controls.",
      );
    const adapter = this.adapters.codex!;
    const client = adapter.connect(installation.path, os.homedir());
    try {
      return await adapter.inspect(client);
    } finally {
      client.close();
    }
  }
  async start(
    installation: Installation,
    conversation: Conversation,
    project: Project,
    prompt: string,
    model: string,
    mode: "review" | "edit",
    execution?: RuntimeExecution,
  ): Promise<Run> {
    this.coordinator.ownership.assertOwner();
    const workspaceReservation = this.reserveWorkspace(project);
    try {
      await this.preflight(installation);
      const provider = installation.appId.includes("claude")
        ? "claude"
        : "codex";
      const adapter = this.adapters[provider];
      if (
        !adapter ||
        (provider === "codex" && installation.compatibility !== "compatible")
      )
        throw new Error(
          "Connect a compatible Codex runtime first. Claude runs through its native terminal.",
        );
      const run: Run = {
        id: uid(),
        conversationId: conversation.id,
        projectId: project.id,
        provider,
        installationId: installation.id,
        installationRevisionId: installation.revisionId,
        runtimeVersion: installation.version,
        executableIdentity: installation.identity,
        managementUnitId: installation.managementUnitId,
        model,
        mode,
        status: "starting",
        nativeSessionId: execution?.freshSession
          ? null
          : (conversation.nativeSessions[provider] ?? null),
        nativeTurnId: null,
        error: null,
        createdAt: now(),
      };
      if (execution) {
        const preparedAttempt = this.coordinator.repository.require<any>(
          "attempt",
          execution.attemptId,
        );
        const preparedWorkspace =
          this.coordinator.repository.require<Workspace>(
            "workspace",
            preparedAttempt.workspaceId,
          );
        if (
          preparedAttempt.projectId !== project.id ||
          preparedAttempt.provider !== provider ||
          preparedWorkspace.canonicalRoot !== project.realPath
        )
          throw new Error(
            "Attempt provider, project, or workspace differs from this dispatch.",
          );
        const task = this.coordinator.repository.require<any>(
          "task",
          preparedAttempt.taskId,
        );
        const capabilities = adapter.capabilities(installation);
        if (
          task.requiredCapabilities.some(
            (name: string) =>
              !capabilities.some(
                (capability) =>
                  capability.name === name &&
                  capability.support === "enforceable",
              ),
          )
        )
          throw new Error(
            "A required task capability is not enforced by this runtime.",
          );
      }
      const attempt = execution
        ? this.coordinator.beginAttempt(execution.attemptId, run.id)
        : this.coordinator.beginLegacy(run, project, conversation);
      if (execution) {
        const session = this.coordinator.repository.require<any>(
          "agent-session",
          attempt.sessionId,
        );
        run.nativeSessionId = execution.freshSession
          ? null
          : session.nativeSessionId;
      }
      this.store.transaction(() => {
        this.store.save("run", run, "run.start-requested");
        this.store.message({
          id: uid(),
          conversationId: conversation.id,
          projectId: project.id,
          role: "user",
          provider,
          text: prompt,
          runId: run.id,
          nativeId: null,
          createdAt: now(),
        });
      });
      let client: ProviderConnection;
      try {
        client = adapter.connect(installation.path, project.realPath);
      } catch (error) {
        run.status = "failed";
        run.error = safeError(error);
        this.store.save("run", run);
        this.coordinator.syncRun(run);
        this.coordinator.confirmStopped(
          run.id,
          "Provider connection refused before process creation or dispatch.",
        );
        this.changed();
        throw error;
      }
      run.nativePid = client.process.pid;
      if (run.nativePid)
        this.coordinator.attachExecution(run.id, run.nativePid);
      client.process.once("exit", () => {
        if (!this.closing) this.coordinator.confirmStopped(run.id);
      });
      this.store.save("run", run);
      const active: Active = {
        run,
        client,
        adapter,
        approvals: new Map(),
        finished: false,
        dispatched: false,
      };
      this.active.set(run.id, active);
      this.changed();
      client.onNotification = (method, params) =>
        this.notification(active, method, params);
      client.onRequest = (id, method, params) =>
        this.requestApproval(active, id, method, params);
      client.onExit = (detail) => {
        if (!active.finished)
          this.finish(
            active,
            active.dispatched ? "uncertain" : "failed",
            detail,
          );
      };
      try {
        await client.initialize();
        const account = await adapter.account(client, installation);
        const priorSession = this.coordinator.repository.require<any>(
          "agent-session",
          attempt.sessionId,
        );
        const bindings = this.coordinator.repository
          .all<any>("agent-session", { projectId: project.id })
          .filter(
            (session) =>
              session.nativeSessionId === run.nativeSessionId &&
              session.continuity === "verified",
          );
        if (
          run.nativeSessionId &&
          (conversation.nativeAccounts?.[provider] !== account.accountKey ||
            (priorSession.profileId &&
              priorSession.profileId !== account.profileId) ||
            !bindings.length ||
            bindings.some((session) => session.profileId !== account.profileId))
        )
          throw new Error(
            "The native account changed or profile changed or its original binding is unknown. Create a fresh session and explicitly review any handoff before sending history.",
          );
        run.nativeAccountKey = account.accountKey;
        conversation.nativeAccounts = {
          ...conversation.nativeAccounts,
          [provider]: account.accountKey,
        };
        const workspace = this.coordinator.repository.require<Workspace>(
          "workspace",
          attempt.workspaceId,
        );
        const prepared: PreparedTurn = {
          prompt,
          cwd: project.realPath,
          requestedModel: model,
          mode,
          contextPackageId: attempt.contextPackageId,
          attemptId: attempt.id,
          workspaceIdentity: workspace.filesystemIdentity!,
        };
        const thread = await adapter.startSession(
          client,
          prepared,
          run.nativeSessionId,
        );
        run.nativeSessionId = thread.nativeSessionId;
        conversation.nativeSessions[provider] = thread.nativeSessionId;
        this.coordinator.bindRunSession(
          run,
          account.profileId,
          thread.evidence,
        );
        this.store.transaction(() => {
          this.store.save("run", run);
          this.store.save("conversation", conversation);
        });
        this.coordinator.recordDispatch(run, prompt);
        active.dispatched = true;
        const turn = await adapter.startTurn(
          client,
          prepared,
          run.nativeSessionId,
        );
        run.nativeTurnId = turn.nativeTurnId ?? run.nativeTurnId;
        this.coordinator.acknowledge(
          run,
          turn.reportedModel ?? thread.reportedModel,
        );
        if (!active.finished) {
          run.status = active.approvals.size ? "awaiting-approval" : "running";
          this.store.save("run", run);
          this.coordinator.syncRun(run);
          this.changed();
        }
        return run;
      } catch (error) {
        if (active.finished && run.status === "completed") return run;
        if (!active.finished)
          this.finish(
            active,
            active.dispatched ? "uncertain" : "failed",
            safeError(error),
          );
        throw error;
      }
    } finally {
      this.openingWorkspaces.delete(workspaceReservation);
    }
  }
  private notification(active: Active, method: string, payload: unknown): void {
    const run = active.run;
    if (active.finished) return;
    const event = active.adapter.event(method, payload);
    if (!event) return;
    if (
      event.threadId &&
      run.nativeSessionId &&
      event.threadId !== run.nativeSessionId
    )
      return;
    if (event.turnId && run.nativeTurnId && event.turnId !== run.nativeTurnId)
      return;
    if (event.type === "turn-started") {
      run.nativeTurnId = event.turnId;
      this.store.save("run", run);
      this.coordinator.acknowledge(run, event.reportedModel ?? null);
    }
    if (event.type === "message-delta" || event.type === "message") {
      const id = `${run.id}:${event.itemId}`,
        previous = this.store.get<Message>("message", id);
      this.store.message({
        id,
        conversationId: run.conversationId,
        projectId: run.projectId,
        role: event.type === "message" ? event.role : "assistant",
        provider: run.provider,
        text:
          event.type === "message-delta"
            ? ((previous?.text ?? "") + event.text).slice(0, 2_000_000)
            : event.text,
        runId: run.id,
        nativeId: event.itemId,
        createdAt: previous?.createdAt ?? now(),
      });
    }
    if (event.type === "usage" && run.nativeTurnId)
      this.store.put("usage", {
        id: `${run.id}:${run.nativeTurnId}`,
        runId: run.id,
        provider: run.provider,
        input: event.input,
        output: event.output,
        cached: event.cached,
        source: "native-runtime",
        scope: run.nativeTurnId,
        projectId: run.projectId,
        conversationId: run.conversationId,
        semantics: "cumulative",
        scopeLevel: "turn",
        cachedIncludedInInput: true,
        sessionId: run.nativeSessionId,
      });
    if (event.type === "completed") {
      this.finish(active, event.status, event.error);
      return;
    }
    this.changed();
  }
  private requestApproval(
    active: Active,
    requestId: string | number,
    method: string,
    params: any,
  ): void {
    const request = active.adapter.approval(method, params);
    if (!request) {
      active.client.reject(
        requestId,
        "Topsl does not support this request. Use the native terminal for this capability.",
      );
      return;
    }
    if (
      request.threadId !== active.run.nativeSessionId ||
      (active.run.nativeTurnId && request.turnId !== active.run.nativeTurnId)
    ) {
      active.client.reject(requestId, "Approval is outside this active run.");
      return;
    }
    if (!active.run.nativeTurnId) active.run.nativeTurnId = request.turnId;
    // Review mode never grants escalation or file writes, even if a native runtime asks.
    if (active.run.mode === "review") {
      active.client.reply(requestId, { decision: "decline" });
      return;
    }
    const approval: Approval = {
      id: uid(),
      runId: active.run.id,
      method,
      description: request.description,
      digest: hash(
        stable({
          requestId,
          method,
          params,
          runId: active.run.id,
          installationRevisionId: active.run.installationRevisionId,
        }),
      ),
      requestId,
      createdAt: now(),
    };
    active.approvals.set(approval.id, { approval, params });
    active.run.status = "awaiting-approval";
    this.store.transaction(() => {
      this.store.save("approval", approval);
      this.store.save("run", active.run);
      this.coordinator.syncRun(active.run);
    });
    this.changed();
  }
  decide(id: string, digest: string, allow: boolean): void {
    const approval = this.store.get<Approval>("approval", id);
    const active = approval && this.active.get(approval.runId);
    const pending = active?.approvals.get(id);
    if (
      !approval ||
      !active ||
      !pending ||
      active.finished ||
      digest !== approval.digest
    )
      throw new Error(
        "This approval is stale or no longer bound to an active request.",
      );
    if (Date.now() - Date.parse(approval.createdAt) > 15 * 60_000)
      throw new Error(
        "Approval expired. Interrupt and inspect the native session.",
      );
    this.store.transaction(() => {
      this.store.event("approval.decided", {
        id,
        digest,
        allow,
        runId: active.run.id,
      });
      this.store.remove("approval", id);
    });
    active.approvals.delete(id);
    active.client.reply(approval.requestId, {
      decision: allow ? "accept" : "decline",
    });
    active.run.status = active.approvals.size ? "awaiting-approval" : "running";
    this.store.save("run", active.run);
    this.coordinator.syncRun(active.run);
    this.changed();
  }
  private finish(
    active: Active,
    status: Run["status"],
    error: string | null,
  ): void {
    if (active.finished) return;
    active.finished = true;
    active.run.status = status;
    active.run.error = error;
    for (const { approval } of active.approvals.values())
      this.store.remove("approval", approval.id);
    this.store.save("run", active.run);
    this.coordinator.syncRun(active.run);
    this.active.delete(active.run.id);
    active.client.close();
    this.changed();
  }
  async interrupt(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active)
      throw new Error(
        "This run is not active in Topsl. Inspect the native session.",
      );
    if (!active.run.nativeSessionId || !active.run.nativeTurnId) {
      this.finish(
        active,
        "uncertain",
        "Interrupted before the native turn identity was confirmed.",
      );
      return;
    }
    await active.adapter.interrupt(
      active.client,
      active.run.nativeSessionId,
      active.run.nativeTurnId,
    );
  }
  async terminal(
    installation: Installation,
    project: Project,
    login = false,
  ): Promise<string> {
    this.coordinator.ownership.assertOwner();
    const workspaceReservation = this.reserveWorkspace(project);
    try {
      await this.preflight(installation);
      const id = uid();
      const args = login
        ? installation.appId === "openai.codex-cli"
          ? ["login"]
          : ["auth", "login"]
        : [];
      const provider = installation.appId.includes("claude")
        ? "claude"
        : "codex";
      const conversationId = `terminal:${id}`;
      const run: Run = {
        id,
        conversationId,
        projectId: project.id,
        provider,
        installationId: installation.id,
        installationRevisionId: installation.revisionId,
        runtimeVersion: installation.version,
        executableIdentity: installation.identity,
        managementUnitId: installation.managementUnitId,
        model: "native-controlled",
        mode: "native",
        status: "starting",
        nativeSessionId: null,
        nativeTurnId: null,
        error: null,
        createdAt: now(),
      };
      const conversation: Conversation = {
        id: conversationId,
        projectId: project.id,
        title: `${provider} native ${login ? "login" : "session"}`,
        nativeSessions: {},
        createdAt: now(),
      };
      this.coordinator.beginLegacy(run, project, conversation);
      this.store.transaction(() => {
        this.store.save("conversation", conversation);
        this.store.save("run", run, "terminal.start-requested");
      });
      this.coordinator.recordDispatch(
        run,
        `native-terminal:${login ? "login" : "session"}`,
      );
      // Full native mode: its own trust, slash commands, extensions, and approval UI remain intact.
      let terminal: IPty;
      try {
        terminal = spawnPty(installation.path, args, {
          cwd: login ? os.homedir() : project.realPath,
          env: nativeEnvironment({ TERM: "xterm-256color" }),
          cols: 100,
          rows: 24,
          name: "xterm-256color",
        });
      } catch (e) {
        run.status = "failed";
        run.error = safeError(e);
        this.store.save("run", run);
        this.coordinator.syncRun(run);
        this.coordinator.confirmStopped(
          run.id,
          "Native terminal failed before a process was created.",
        );
        throw e;
      }
      run.nativePid = terminal.pid;
      this.coordinator.attachExecution(run.id, terminal.pid);
      run.status = "running";
      this.store.save("run", run);
      this.coordinator.acknowledge(run);
      this.coordinator.syncRun(run);
      this.terminals.set(id, {
        process: terminal,
        projectId: project.id,
        installation,
        login,
        run,
      });
      this.store.event("terminal.opened", {
        id,
        projectId: project.id,
        installationRevisionId: installation.revisionId,
        login,
      });
      terminal.onData((data) =>
        this.emit({ type: "terminal", data: { id, data } }),
      );
      terminal.onExit(({ exitCode }) => {
        this.terminals.delete(id);
        if (this.closing) return;
        run.status = exitCode === 0 ? "completed" : "interrupted";
        this.store.save("run", run);
        this.coordinator.syncRun(run);
        this.coordinator.confirmStopped(run.id);
        this.emit({
          type: "terminal",
          data: {
            id,
            data: `\r\n[Native session exited: ${exitCode}]\r\n`,
            exited: true,
          },
        });
        this.changed();
      });
      this.changed();
      return id;
    } finally {
      this.openingWorkspaces.delete(workspaceReservation);
    }
  }
  terminalInput(id: string, data: string): void {
    const t = this.terminals.get(id);
    if (!t) throw new Error("Terminal is closed.");
    t.process.write(data);
  }
  private reserveWorkspace(project: Project): string {
    const identity = canonicalWorkspaceIdentity(project.realPath),
      key = identity.filesystemIdentity;
    const lease = this.coordinator.ownership.get(key);
    if (
      this.openingWorkspaces.has(key) ||
      (lease && lease.state !== "released")
    )
      throw new Error(
        lease?.state === "uncertain"
          ? "Workspace has uncertain ownership; reconcile before starting another writer."
          : "This workspace already has a native session or writer lease.",
      );
    // Old records without an attempt are conservatively bound to their legacy root.
    for (const run of this.store.iterate<Run>("run")) {
      if (run.status !== "uncertain") continue;
      const attempt = this.coordinator.attemptForRun(run.id);
      const workspace =
        attempt && this.store.get<Workspace>("workspace", attempt.workspaceId);
      const legacy = !attempt
        ? this.store.get<Project>("project", run.projectId)
        : undefined;
      if (
        workspace?.filesystemIdentity === key ||
        workspace?.canonicalRoot === identity.canonicalRoot ||
        legacy?.realPath === identity.canonicalRoot
      )
        throw new Error(
          "Reconcile this workspace’s uncertain run before starting another writer.",
        );
    }
    this.openingWorkspaces.set(key, project.id);
    return key;
  }
  async reconcile(id: string): Promise<void> {
    const run = this.store.get<Run>("run", id);
    if (!run || run.status !== "uncertain")
      throw new Error("No uncertain run is selected.");
    if (run.nativePid) {
      try {
        process.kill(run.nativePid, 0);
        throw new Error(
          "The native process is still present. Close it in its native application before reconciling.",
        );
      } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
      }
    } else {
      const i = this.store.get<Installation>(
        "installation",
        run.installationId,
      );
      const processes = i ? await affectedProcesses([i.realPath]) : null;
      if (processes === null || processes.length)
        throw new Error(
          "The prior process identity was not recorded. Close the affected runtime and rediscover it before reconciliation.",
        );
    }
    run.status = "interrupted";
    run.error =
      "Native process no longer present; user inspected and reconciled the outcome. The prior turn was not replayed.";
    this.store.save("run", run);
    this.coordinator.reconcileRun(run);
    this.changed();
  }
  terminalResize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.process.resize(cols, rows);
  }
  terminalClose(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    t.process.kill();
  }
  close(): void {
    this.closing = true;
    for (const active of [...this.active.values()])
      this.finish(
        active,
        "uncertain",
        "Topsl closed while the native run was active. Inspect before continuing.",
      );
    for (const t of this.terminals.values()) {
      this.store.save("run", {
        ...t.run,
        status: "uncertain",
        error:
          "Topsl closed during a native session. Inspect its outcome before starting another writer.",
      });
      this.coordinator.syncRun({
        ...t.run,
        status: "uncertain",
        error: "Topsl closed during a native session.",
      });
      t.process.kill();
    }
    if (this.ownsCoordinator) this.coordinator.close();
  }
}
