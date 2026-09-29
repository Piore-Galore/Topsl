import os from "node:os";
import { spawn as spawnPty, type IPty } from "node-pty";
import { RpcPeer } from "./rpc";
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
  client: RpcPeer;
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
  private openingProjects = new Set<string>();
  private closing = false;
  constructor(
    private store: Store,
    private emit: (event: ServiceEvent) => void,
    private changed: () => void,
    private peer = (executable: string, cwd: string) =>
      new RpcPeer(executable, ["app-server"], cwd),
  ) {
    for (const run of store.list<Run>("run"))
      if (["starting", "running", "awaiting-approval"].includes(run.status))
        store.save("run", {
          ...run,
          status: "uncertain",
          error:
            "Topsl stopped while this native run was active. Inspect the native session before continuing; nothing was replayed.",
        });
    for (const approval of store.list<Approval>("approval"))
      store.remove("approval", approval.id);
  }
  isProjectBusy(id: string): boolean {
    return (
      this.openingProjects.has(id) ||
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
      this.openingProjects.size
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
    const client = this.peer(installation.path, os.homedir());
    try {
      const info = await client.initialize();
      const models = await client.request("model/list", { limit: 100 });
      const account = await client.request("account/read", {
        refreshToken: false,
      });
      return {
        info: {
          platformFamily: info.platformFamily,
          platformOs: info.platformOs,
        },
        models: (models.data ?? []).map((m: any) => ({
          id: m.id,
          model: m.model,
          name: m.displayName,
          description: m.description,
          isDefault: m.isDefault,
        })),
        account: account.account
          ? {
              type: account.account.type,
              email: account.account.email,
              planType: account.account.planType,
            }
          : null,
      };
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
  ): Promise<Run> {
    if (this.isProjectBusy(project.id))
      throw new Error(
        "This project already has a native session. Close it before starting another writer.",
      );
    this.assertReconciled(project.id);
    this.openingProjects.add(project.id);
    try {
      await this.preflight(installation);
      if (
        installation.appId !== "openai.codex-cli" ||
        installation.compatibility !== "compatible"
      )
        throw new Error(
          "Connect a compatible Codex runtime first. Claude runs through its native terminal.",
        );
      const run: Run = {
        id: uid(),
        conversationId: conversation.id,
        projectId: project.id,
        provider: "codex",
        installationId: installation.id,
        installationRevisionId: installation.revisionId,
        runtimeVersion: installation.version,
        executableIdentity: installation.identity,
        managementUnitId: installation.managementUnitId,
        model,
        mode,
        status: "starting",
        nativeSessionId: conversation.nativeSessions.codex ?? null,
        nativeTurnId: null,
        error: null,
        createdAt: now(),
      };
      this.store.transaction(() => {
        this.store.save("run", run, "run.start-requested");
        this.store.message({
          id: uid(),
          conversationId: conversation.id,
          projectId: project.id,
          role: "user",
          provider: "codex",
          text: prompt,
          runId: run.id,
          nativeId: null,
          createdAt: now(),
        });
      });
      const client = this.peer(installation.path, project.realPath);
      run.nativePid = client.process.pid;
      this.store.save("run", run);
      const active: Active = {
        run,
        client,
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
        const account = await client.request("account/read", {
          refreshToken: false,
        });
        if (account.account?.type !== "chatgpt")
          throw new Error(
            "A native ChatGPT subscription login is required. API-key and external-token modes are not supported by this pilot.",
          );
        const accountKey = hash(
          stable({
            type: account.account.type,
            email: account.account.email,
            accountId: account.account.chatgptAccountId ?? null,
          }),
        );
        if (
          conversation.nativeSessions.codex &&
          conversation.nativeAccounts?.codex !== accountKey
        )
          throw new Error(
            "The native account changed or its original binding is unknown. Create a new conversation and explicitly review any handoff before sending history.",
          );
        run.nativeAccountKey = accountKey;
        conversation.nativeAccounts = {
          ...conversation.nativeAccounts,
          codex: accountKey,
        };
        const params = {
          cwd: project.realPath,
          model,
          approvalPolicy: "untrusted",
          sandbox: mode === "review" ? "read-only" : "workspace-write",
        };
        const thread = run.nativeSessionId
          ? await client.request("thread/resume", {
              ...params,
              threadId: run.nativeSessionId,
            })
          : await client.request("thread/start", params);
        if (!thread.thread?.id)
          throw new Error("Runtime did not return its session identity.");
        run.nativeSessionId = thread.thread.id;
        conversation.nativeSessions.codex = thread.thread.id;
        this.store.transaction(() => {
          this.store.save("run", run);
          this.store.save("conversation", conversation);
        });
        this.store.event("turn.dispatch-requested", {
          runId: run.id,
          nativeSessionId: run.nativeSessionId,
        });
        active.dispatched = true;
        const turn = await client.request("turn/start", {
          threadId: run.nativeSessionId,
          input: [{ type: "text", text: prompt }],
          cwd: project.realPath,
          model,
          approvalPolicy: "untrusted",
          sandboxPolicy:
            mode === "review"
              ? { type: "readOnly" }
              : {
                  type: "workspaceWrite",
                  writableRoots: [project.realPath],
                  networkAccess: false,
                },
        });
        run.nativeTurnId = turn.turn?.id ?? run.nativeTurnId;
        if (!active.finished) {
          run.status = active.approvals.size ? "awaiting-approval" : "running";
          this.store.save("run", run);
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
      this.openingProjects.delete(project.id);
    }
  }
  private notification(active: Active, method: string, p: any): void {
    const run = active.run;
    if (active.finished || !p) return;
    if (p.threadId && run.nativeSessionId && p.threadId !== run.nativeSessionId)
      return;
    if (p.turnId && run.nativeTurnId && p.turnId !== run.nativeTurnId) return;
    if (method === "turn/started" && p.turn?.id) {
      run.nativeTurnId = p.turn.id;
      this.store.save("run", run);
    }
    if (
      method === "item/agentMessage/delta" &&
      typeof p.delta === "string" &&
      p.itemId
    ) {
      const id = `${run.id}:${p.itemId}`;
      const previous = this.store.get<Message>("message", id);
      this.store.message({
        id,
        conversationId: run.conversationId,
        projectId: run.projectId,
        role: "assistant",
        provider: "codex",
        text: ((previous?.text ?? "") + p.delta).slice(0, 2_000_000),
        runId: run.id,
        nativeId: p.itemId,
        createdAt: previous?.createdAt ?? now(),
      });
    }
    if (method === "item/completed" && p.item?.id) {
      const item = p.item;
      if (
        [
          "agentMessage",
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "plan",
        ].includes(item.type)
      ) {
        const text =
          item.type === "agentMessage" || item.type === "plan"
            ? item.text
            : item.type === "commandExecution"
              ? `${item.command}\n${item.aggregatedOutput ?? ""}\nExit: ${item.exitCode ?? "unknown"}`
              : JSON.stringify(item, null, 2);
        this.store.message({
          id: `${run.id}:${item.id}`,
          conversationId: run.conversationId,
          projectId: run.projectId,
          role: item.type === "agentMessage" ? "assistant" : "tool",
          provider: "codex",
          text: String(text ?? "").slice(0, 2_000_000),
          runId: run.id,
          nativeId: item.id,
          createdAt: now(),
        });
      }
    }
    // `last` is a native turn snapshot, not a delta and not the thread's cumulative total.
    if (
      method === "thread/tokenUsage/updated" &&
      p.tokenUsage?.last &&
      run.nativeTurnId
    )
      this.store.put(
        "usage",
        normalizeUsage("codex", p.tokenUsage.last, run.id, run.nativeTurnId),
      );
    if (method === "turn/completed") {
      this.finish(
        active,
        p.turn?.status === "completed"
          ? "completed"
          : p.turn?.status === "interrupted"
            ? "interrupted"
            : "failed",
        p.turn?.error?.message ? safeError(p.turn.error.message) : null,
      );
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
    if (
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(method)
    ) {
      active.client.reject(
        requestId,
        "Topsl does not support this request. Use the native terminal for this capability.",
      );
      return;
    }
    if (
      !params?.threadId ||
      params.threadId !== active.run.nativeSessionId ||
      !params.turnId ||
      (active.run.nativeTurnId && params.turnId !== active.run.nativeTurnId)
    ) {
      active.client.reject(requestId, "Approval is outside this active run.");
      return;
    }
    if (!active.run.nativeTurnId) active.run.nativeTurnId = params.turnId;
    // Review mode never grants escalation or file writes, even if a native runtime asks.
    if (active.run.mode === "review") {
      active.client.reply(requestId, { decision: "decline" });
      return;
    }
    const approval: Approval = {
      id: uid(),
      runId: active.run.id,
      method,
      description: JSON.stringify(params, null, 2).slice(0, 30000),
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
    await active.client.request("turn/interrupt", {
      threadId: active.run.nativeSessionId,
      turnId: active.run.nativeTurnId,
    });
  }
  async terminal(
    installation: Installation,
    project: Project,
    login = false,
  ): Promise<string> {
    if (this.isProjectBusy(project.id))
      throw new Error(
        "Close this project’s active session before opening another writer.",
      );
    this.assertReconciled(project.id);
    this.openingProjects.add(project.id);
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
      this.store.transaction(() => {
        this.store.save("conversation", {
          id: conversationId,
          projectId: project.id,
          title: `${provider} native ${login ? "login" : "session"}`,
          nativeSessions: {},
          createdAt: now(),
        });
        this.store.save("run", run, "terminal.start-requested");
      });
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
        this.store.save("run", {
          ...run,
          status: "failed",
          error: safeError(e),
        });
        throw e;
      }
      run.nativePid = terminal.pid;
      run.status = "running";
      this.store.save("run", run);
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
      this.openingProjects.delete(project.id);
    }
  }
  terminalInput(id: string, data: string): void {
    const t = this.terminals.get(id);
    if (!t) throw new Error("Terminal is closed.");
    t.process.write(data);
  }
  private assertReconciled(projectId: string): void {
    if (
      this.store
        .list<Run>("run")
        .some((r) => r.projectId === projectId && r.status === "uncertain")
    )
      throw new Error(
        "Reconcile this project’s uncertain run before starting another writer.",
      );
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
    this.store.save("run", {
      ...run,
      status: "interrupted",
      error:
        "Native process no longer present; user inspected and reconciled the outcome. The prior turn was not replayed.",
    });
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
      t.process.kill();
    }
  }
}
