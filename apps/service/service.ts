import path from "node:path";
import { realpath, stat, writeFile, mkdir } from "node:fs/promises";
import { Store } from "../../packages/persistence/store";
import type {
  AppId,
  AppState,
  Approval,
  ConfigurationPlan,
  ContextSnapshot,
  Conversation,
  Installation,
  LifecycleJob,
  LifecyclePlan,
  Project,
  ServiceEvent,
} from "../../packages/domain/types";
import type { Command } from "../../packages/domain/commands";
import { catalog, capabilities } from "../../packages/domain/catalog";
import { hash, now, safeError, uid } from "../../packages/domain/invariants";
import {
  discover,
  describeInstallation,
  probeVersion,
} from "../../packages/applications/discovery";
import { Lifecycle } from "../../packages/applications/lifecycle";
import { RuntimeManager } from "../../packages/runtime/manager";
import { Configuration } from "../../packages/workspace/configuration";
import {
  importHistory,
  previewHandoff,
} from "../../packages/workspace/history";
import { ContextServer } from "../../packages/workspace/context";

export interface TrustedInput {
  selectedPath?: string;
  selectedAppId?: AppId;
  digest?: string;
  approved?: boolean;
}
export class Service {
  readonly store: Store;
  readonly lifecycle: Lifecycle;
  readonly runtime: RuntimeManager;
  readonly configuration: Configuration;
  readonly context: ContextServer;
  private timer?: ReturnType<typeof setInterval>;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private discovery?: Promise<Installation[]>;
  private closing = false;
  private lastDiscoveryAt = 0;
  constructor(
    readonly directory: string,
    key: string,
    private emit: (event: ServiceEvent) => void,
    private isolatedTest = false,
  ) {
    this.store = new Store(path.join(directory, "history.sqlite"), key);
    this.runtime = new RuntimeManager(this.store, emit, () => this.changed());
    this.configuration = new Configuration(this.store, () =>
      this.runtime.hasActive(),
    );
    this.context = new ContextServer(this.store, directory);
    this.lifecycle = new Lifecycle(this.store, directory, {
      installations: () => this.store.list("installation"),
      discover: () => this.discover(),
      active: (unit) => this.runtime.isUnitBusy(unit),
      changed: () => this.changed(),
      nativeOpen: async (target) =>
        emit({ type: "native-open", data: { target } }),
    });
  }
  async start(): Promise<void> {
    await this.configuration.reconcile();
    await this.context.start();
    if (!this.isolatedTest) {
      await this.discover();
      void this.lifecycle.scheduledChecks();
      this.timer = setInterval(() => {
        void this.lifecycle.tick().catch(() => {});
        void this.lifecycle.scheduledChecks().catch(() => {});
        if (Date.now() - this.lastDiscoveryAt >= 5 * 60_000)
          void this.discover().catch(() => {});
      }, 60_000);
    }
    this.changed();
  }
  state(): AppState {
    return {
      locked: false,
      lockReason: null,
      platform: `${process.platform}/${process.arch}`,
      version: "0.1.0",
      theme: this.store.get<any>("preference", "theme")?.value ?? "paper",
      applications: catalog,
      capabilities,
      serviceError: null,
      installations: this.store.list("installation"),
      checks: this.store.list("check"),
      jobs: this.store.list("job"),
      projects: this.store.list("project"),
      conversations: this.store.list("conversation"),
      messages: this.store.list("message"),
      runs: this.store.list("run"),
      usage: this.store.list("usage"),
      approvals: this.store.list("approval"),
      terminals: this.runtime.terminalState(),
      configurationWrites: this.store.list("configuration-write"),
    };
  }
  private changed(): void {
    if (this.closing || this.notificationTimer) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      if (!this.closing) this.emit({ type: "state", data: this.state() });
    }, 40);
  }
  private require<T>(kind: string, id: string): T {
    const value = this.store.get<T>(kind, id);
    if (!value) throw new Error(`The selected ${kind} no longer exists.`);
    return value;
  }
  private installation(id: string): Installation {
    return this.require("installation", id);
  }
  private async project(id: string): Promise<Project> {
    const project = this.require<Project>("project", id);
    if (!project.trusted || (await realpath(project.path)) !== project.realPath)
      throw new Error("The project path changed. Select and approve it again.");
    return project;
  }
  async discover(): Promise<Installation[]> {
    if (this.discovery) return this.discovery;
    this.discovery = (async () => {
      const previous = this.store.list<Installation>("installation");
      const found = this.isolatedTest ? previous : await discover(previous);
      this.store.transaction(() => {
        for (const old of previous)
          if (!found.some((i) => i.id === old.id))
            this.store.remove("installation", old.id);
        for (const i of found) {
          const old = previous.find((p) => p.id === i.id);
          this.store.put("installation", i);
          this.store.immutable("installation-revision", {
            id: i.revisionId,
            installationId: i.id,
            identity: i.identity,
            version: i.version,
            path: i.realPath,
            owner: i.owner,
            channel: i.channel,
          });
          if (old && old.revisionId !== i.revisionId)
            this.store.event("installation.external-change", {
              installationId: i.id,
              from: old.revisionId,
              to: i.revisionId,
            });
        }
      });
      this.lastDiscoveryAt = Date.now();
      this.changed();
      return found;
    })();
    try {
      return await this.discovery;
    } finally {
      this.discovery = undefined;
    }
  }
  review(
    kind: "plan" | "configuration-plan" | "approval",
    id: string,
  ): LifecyclePlan | ConfigurationPlan | Approval {
    return this.require(kind, id);
  }
  async command(command: Command, trusted: TrustedInput = {}): Promise<any> {
    switch (command.type) {
      case "state":
        return this.state();
      case "theme":
        this.store.put("preference", { id: "theme", value: command.theme });
        this.changed();
        return;
      case "discover":
        return this.discover();
      case "select-runtime": {
        if (
          !trusted.selectedPath ||
          !trusted.selectedAppId ||
          !trusted.approved
        )
          throw new Error("Select a runtime through the native dialog.");
        const installation = await describeInstallation(
          trusted.selectedAppId,
          trusted.selectedPath,
          this.store.list("installation"),
        );
        this.store.save("installation", installation);
        this.changed();
        return installation;
      }
      case "trust-installation": {
        if (!trusted.approved)
          throw new Error(
            "Executable trust requires a native user confirmation.",
          );
        const i = this.installation(command.id);
        const verified = await probeVersion({ ...i, trusted: true });
        this.store.save("installation", verified);
        this.store.immutable("installation-revision", {
          id: verified.revisionId,
          installationId: verified.id,
          identity: verified.identity,
          version: verified.version,
          path: verified.realPath,
          owner: verified.owner,
          channel: verified.channel,
        });
        this.changed();
        return verified;
      }
      case "check-updates":
        return this.lifecycle.check(command.id, true);
      case "lifecycle-preview":
        return this.lifecycle.preview(
          command.appId as AppId,
          command.installationId,
          command.action,
        );
      case "lifecycle-apply":
        if (!trusted.digest) throw new Error("Missing native approval.");
        return this.lifecycle.approve(command.id, trusted.digest);
      case "lifecycle-cancel":
        return this.lifecycle.cancel(command.id);
      case "lifecycle-reconcile":
        return this.lifecycle.reconcile(command.id);
      case "lifecycle-retry-preview": {
        const job = this.require<LifecycleJob>("job", command.id);
        if (!["failed", "cancelled"].includes(job.state))
          throw new Error("Reconcile the existing operation before retrying.");
        const plan = this.require<LifecyclePlan>("plan", job.planId);
        return this.lifecycle.preview(
          plan.appId,
          plan.installationId,
          plan.action,
        );
      }
      case "show-download": {
        const job = this.require<LifecycleJob>("job", command.id);
        if (!job.acquiredPath || job.state !== "completed")
          throw new Error("No verified download is available.");
        return { reveal: job.acquiredPath };
      }
      case "open-docs": {
        const app = catalog.find((a) => a.id === command.appId);
        if (!app) throw new Error("Unknown application.");
        return { openUrl: app[command.kind] };
      }
      case "open-application": {
        const i = this.installation(command.id);
        if (!i.appId.endsWith("desktop"))
          throw new Error(
            "Open CLI applications through a project’s native terminal.",
          );
        return { openPath: i.path };
      }
      case "project-add": {
        if (!trusted.selectedPath || !trusted.approved)
          throw new Error(
            "Project trust requires a native folder selection and confirmation.",
          );
        const canonical = await realpath(trusted.selectedPath);
        if (!(await stat(canonical)).isDirectory())
          throw new Error("Select a project directory.");
        const previous = this.store
          .list<Project>("project")
          .find((p) => p.realPath === canonical);
        if (previous) return previous;
        const project = {
          id: uid(),
          name: path.basename(canonical),
          path: trusted.selectedPath,
          realPath: canonical,
          trusted: true,
          createdAt: now(),
        };
        this.store.save("project", project);
        this.changed();
        return project;
      }
      case "conversation-add": {
        await this.project(command.projectId);
        const conversation = {
          id: uid(),
          projectId: command.projectId,
          title: command.title,
          nativeSessions: {},
          createdAt: now(),
        };
        this.store.save("conversation", conversation);
        this.changed();
        return conversation;
      }
      case "history-search":
        await this.project(command.projectId);
        return this.store.search(command.projectId, command.query);
      case "history-import": {
        if (!trusted.selectedPath || !trusted.approved)
          throw new Error("Select a transcript in the native dialog.");
        const result = await importHistory(
          this.store,
          await this.project(command.projectId),
          command.provider,
          trusted.selectedPath,
        );
        this.changed();
        return result;
      }
      case "history-delete": {
        if (!trusted.approved)
          throw new Error("Deletion needs a native confirmation.");
        const conversation = this.require<Conversation>(
          "conversation",
          command.id,
        );
        if (this.runtime.isProjectBusy(conversation.projectId))
          throw new Error(
            "Close native sessions before deleting their history.",
          );
        this.store.deleteConversation(command.id);
        this.changed();
        return;
      }
      case "runtime-connect":
      case "runtime-models":
      case "runtime-account": {
        const i = this.installation(command.id);
        if (command.type === "runtime-connect" && !trusted.approved)
          throw new Error(
            "Review the experimental integration before connecting.",
          );
        if (
          command.type !== "runtime-connect" &&
          i.compatibility !== "compatible"
        )
          throw new Error("Connect the selected runtime first.");
        try {
          const result = await this.runtime.inspect(i);
          this.store.save("installation", {
            ...i,
            compatibility: "compatible",
          });
          this.changed();
          return result;
        } catch (e) {
          this.store.save("installation", {
            ...i,
            compatibility: "incompatible",
          });
          this.changed();
          throw e;
        }
      }
      case "run-start": {
        const conversation = this.require<Conversation>(
          "conversation",
          command.conversationId,
        );
        const project = await this.project(conversation.projectId);
        if (command.mode === "native")
          return this.runtime.terminal(
            this.installation(command.installationId),
            project,
          );
        let prompt = command.prompt;
        if (command.snapshotId) {
          const snapshot = this.require<ContextSnapshot>(
            "snapshot",
            command.snapshotId,
          );
          if (
            snapshot.projectId !== project.id ||
            snapshot.conversationId !== conversation.id ||
            snapshot.provider !== "codex" ||
            hash(snapshot.text) !== snapshot.hash ||
            !trusted.approved
          )
            throw new Error(
              "Review the exact handoff snapshot for this destination first.",
            );
          prompt = snapshot.text + "\n\n# Current user request\n" + prompt;
          this.store.event("handoff.sent", {
            id: snapshot.id,
            hash: snapshot.hash,
            provider: snapshot.provider,
          });
        }
        return this.runtime.start(
          this.installation(command.installationId),
          conversation,
          project,
          prompt,
          command.model,
          command.mode,
        );
      }
      case "run-interrupt":
        return this.runtime.interrupt(command.id);
      case "run-reconcile":
        if (!trusted.approved)
          throw new Error(
            "Inspect the native session and confirm reconciliation.",
          );
        return this.runtime.reconcile(command.id);
      case "approval-decide":
        if (!trusted.digest)
          throw new Error("A native approval decision is required.");
        return this.runtime.decide(command.id, trusted.digest, command.allow);
      case "handoff-preview":
        return previewHandoff(
          this.store,
          this.require("conversation", command.conversationId),
          command.provider,
          command.objective,
        );
      case "handoff-export": {
        if (!trusted.selectedPath || !trusted.approved)
          throw new Error("Export requires a native destination selection.");
        const snapshot = this.require<ContextSnapshot>("snapshot", command.id);
        await writeFile(trusted.selectedPath, snapshot.text, { mode: 0o600 });
        this.store.event("handoff.exported", {
          id: snapshot.id,
          hash: snapshot.hash,
        });
        return;
      }
      case "runtime-login":
        throw new Error("Choose a project and open the native login terminal.");
      case "terminal-open":
        return this.runtime.terminal(
          this.installation(command.installationId),
          await this.project(command.projectId),
          command.login,
        );
      case "terminal-input":
        return this.runtime.terminalInput(command.id, command.data);
      case "terminal-resize":
        return this.runtime.terminalResize(
          command.id,
          command.cols,
          command.rows,
        );
      case "terminal-close":
        return this.runtime.terminalClose(command.id);
      case "configuration-read":
        return this.configuration.read(
          command.provider,
          command.projectId ? await this.project(command.projectId) : null,
          command.kind,
        );
      case "configuration-preview":
        return this.configuration.preview(
          command.path,
          command.expectedHash,
          command.text,
        );
      case "configuration-apply":
        if (!trusted.digest) throw new Error("A native approval is required.");
        try {
          await this.configuration.apply(command.id, trusted.digest);
          return { applied: true, loaded: false };
        } finally {
          await this.configuration.reconcile();
          this.changed();
        }
      case "context-enable": {
        if (!trusted.approved)
          throw new Error(
            "Project context sharing requires a native confirmation.",
          );
        const project = await this.project(command.projectId);
        const grant = this.context.grant(project);
        const directory = path.join(this.directory, "context-grants");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${project.id}.json`);
        await writeFile(file, JSON.stringify(grant), { mode: 0o600 });
        return {
          file,
          companionPath: path
            .join(__dirname, "cli.cjs")
            .replace(/app\.asar([/\\])/, "app.asar.unpacked$1"),
          expires:
            "When Topsl closes or this project grant is replaced. Native configuration is not modified.",
        };
      }
      case "unlock":
        throw new Error("Vault unlock belongs to the desktop broker.");
    }
  }
  close(): void {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.context.close();
    this.runtime.close();
    this.store.close();
  }
}
