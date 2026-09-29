import {
  app,
  clipboard,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openVault } from "./vault";
import { commandSchema, type Command } from "../../packages/domain/commands";
import { catalog, capabilities } from "../../packages/domain/catalog";
import type {
  AppState,
  Approval,
  ConfigurationPlan,
  LifecyclePlan,
  ProjectOpenResult,
} from "../../packages/domain/types";
import { isClaudeFolderUrl } from "../../packages/workspace/project-opening";
import { safeError } from "../../packages/domain/invariants";
import { isWithin, runFile } from "../../packages/platform/system";
import type { TrustedInput } from "../service/service";

let isolatedTest = false;
if (!app.isPackaged && process.env.TOPSL_TEST_PROFILE) {
  const profile = path.resolve(process.env.TOPSL_TEST_PROFILE);
  if (
    !isWithin(os.tmpdir(), profile) ||
    !path.basename(profile).startsWith("topsl-test-")
  )
    throw new Error(
      "Test profiles must be new topsl-test-* directories under the OS temporary directory.",
    );
  app.setPath("userData", profile);
  isolatedTest = true;
}
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | null = null;
let worker: UtilityProcess | null = null;
let sequence = 0;
let unlocking = false;
let quitting = false;
let closeApproved = false;
let closeReview = false;
let state: AppState = {
  locked: true,
  lockReason: "Unlocking the local vault…",
  platform: `${process.platform}/${process.arch}`,
  version: app.getVersion(),
  theme: "paper",
  applications: catalog,
  capabilities,
  installations: [],
  checks: [],
  jobs: [],
  projects: [],
  projectSync: { enabled: false, refreshing: false, sources: [] },
  codexProjectSync: {
    enabled: false,
    refreshing: false,
    installationId: null,
    home: "",
    status: "disabled",
    detail: "Unlock to synchronize projects.",
    lastSuccessAt: null,
    projects: [],
    orderRevision: "",
  },
  conversations: [],
  messages: [],
  runs: [],
  usage: [],
  approvals: [],
  terminals: [],
  serviceError: null,
  configurationWrites: [],
};
const pending = new Map<
  number,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const rendererFile = path.join(__dirname, "renderer", "index.html");
function publish(event: unknown): void {
  if (window && !window.isDestroyed())
    window.webContents.send("topsl:event", event);
}
function request(body: Record<string, unknown>, timeout = 60000): Promise<any> {
  if (!worker)
    return Promise.reject(
      new Error(
        "The local control service is unavailable. Reopen Topsl to reconcile it.",
      ),
    );
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          "The control service timed out. Check the recorded outcome before retrying.",
        ),
      );
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({ id, ...body });
  });
}
function officialLink(target: string): boolean {
  return catalog.some((a) =>
    [a.website, a.docs, a.releaseNotes].includes(target),
  );
}
async function unlock(passphrase?: string): Promise<AppState> {
  if (unlocking) throw new Error("The vault is already opening.");
  if (!state.locked) return state;
  unlocking = true;
  try {
    const directory = app.getPath("userData");
    const key = await openVault(
      directory,
      isolatedTest ? "Topsl isolated test passphrase" : passphrase,
    );
    worker = utilityProcess.fork(path.join(__dirname, "service.cjs"), [], {
      cwd: directory,
      serviceName: "Topsl control service",
      stdio: "pipe",
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.on("message", (message: any) => {
      if (message.event) {
        if (message.event.type === "state") {
          state = message.event.data;
          publish(message.event);
        } else if (message.event.type === "native-open") {
          const target = message.event.data?.target;
          if (typeof target === "string" && officialLink(target))
            void shell
              .openExternal(target)
              .catch((e) => publish({ type: "error", data: safeError(e) }));
          else if (
            typeof target === "string" &&
            (isWithin(
              path.join(app.getPath("userData"), "downloads"),
              target,
            ) ||
              state.installations.some(
                (i) => i.appId.endsWith("desktop") && i.path === target,
              ))
          )
            void shell.openPath(target).then((error) => {
              if (error) publish({ type: "error", data: error });
            });
        } else if (message.event.type === "terminal") publish(message.event);
      } else {
        const task = pending.get(message.id);
        if (!task) return;
        clearTimeout(task.timer);
        pending.delete(message.id);
        message.error
          ? task.reject(new Error(message.error))
          : task.resolve(message.value);
      }
    });
    worker.on("exit", () => {
      worker = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new Error(
            "The control service stopped. Reopen Topsl; uncertain operations will require reconciliation.",
          ),
        );
      }
      pending.clear();
      if (!quitting) {
        state = {
          ...state,
          serviceError:
            "The control service stopped. Reopen Topsl to recover; no operation will be replayed automatically.",
        };
        publish({ type: "state", data: state });
      }
    });
    state = await request({ kind: "initialize", directory, key, isolatedTest });
    publish({ type: "state", data: state });
    return state;
  } catch (e) {
    state = { ...state, locked: true, lockReason: safeError(e) };
    publish({ type: "state", data: state });
    throw e;
  } finally {
    unlocking = false;
  }
}
async function confirm(
  title: string,
  detail: string,
  affirmative = "Approve",
): Promise<boolean> {
  const options = {
    type: "question" as const,
    title: "Topsl",
    message: title,
    detail,
    buttons: ["Cancel", affirmative],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  return (
    (
      await (window
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options))
    ).response === 1
  );
}
async function dispatch(command: Command): Promise<any> {
  if (command.type === "state") return state;
  if (command.type === "unlock") return unlock(command.passphrase);
  if (state.locked || state.serviceError)
    throw new Error(
      state.lockReason ?? state.serviceError ?? "The vault is locked.",
    );
  const trusted: TrustedInput = {};
  if (command.type === "project-add" || command.type === "project-relink") {
    const chosen = await dialog.showOpenDialog(window!, {
      title:
        command.type === "project-relink"
          ? "Select this project's new folder"
          : "Select a trusted project",
      properties: ["openDirectory"],
    });
    if (chosen.canceled) return null;
    trusted.selectedPath = chosen.filePaths[0];
    trusted.approved = await confirm(
      command.type === "project-relink"
        ? "Relink and trust this project?"
        : "Trust this project?",
      `${trusted.selectedPath}\n\nNative instructions, hooks, plugins, and MCP servers in this project may execute when you start its runtime.${command.type === "project-relink" ? " Existing Topsl history will remain attached to this project; existing native entries are retained." : ""}${state.codexProjectSync.enabled ? " Codex synchronization will share this trusted folder with the native project registry." : ""}`,
      "Trust project",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "project-sync-enable" && command.enabled) {
    trusted.approved = await confirm(
      "Discover project folders across your applications?",
      `Topsl will read folder names and paths from these native metadata files on startup and every minute:\n\n${state.projectSync.sources.map((source) => source.path).join("\n")}\n\nDiscovered folders appear in the shared Projects catalog. Trust each folder before running it. Discovery reads metadata only; Codex synchronization has separate controls. You can pause discovery in Projects.`,
      "Enable discovery",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "project-trust") {
    const project = state.projects.find((project) => project.id === command.id);
    if (!project) throw new Error("Refresh the project list first.");
    trusted.selectedPath = project.path;
    trusted.approved = await confirm(
      "Trust this discovered project?",
      `${project.name}\n${project.path}\n\nNative instructions, hooks, plugins, and MCP servers may execute when you start a native session in this folder.`,
      "Trust project",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "codex-project-sync-enable") {
    const installation = state.installations.find(
      (i) =>
        i.id === command.installationId &&
        i.appId === "openai.codex-cli" &&
        i.trusted,
    );
    if (!installation) throw new Error("Choose a trusted Codex runtime first.");
    trusted.approved = await confirm(
      "Synchronize the Codex project registry?",
      `Runtime: ${installation.realPath}\nProfile: ${state.codexProjectSync.home}\n\nTopsl will read native project names, folders, and order and add trusted Topsl folders that are not already registered. It will refresh every minute while open. Renaming or reordering a native project here will update Codex. Removed native entries stay removed; files and history are retained.\n\nThis uses an experimental local API and starts no model turn. The visible desktop sidebar may keep a separate cache. You can pause in Projects.`,
      "Enable synchronization",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "select-runtime") {
    const provider = await dialog.showMessageBox(window!, {
      message: "Which runtime are you locating?",
      buttons: ["Cancel", "Codex CLI", "Claude Code"],
      defaultId: 0,
      cancelId: 0,
    });
    if (!provider.response) return null;
    const selected = await dialog.showOpenDialog(window!, {
      title: "Choose the native executable",
      properties: ["openFile"],
    });
    if (selected.canceled) return null;
    trusted.selectedPath = selected.filePaths[0];
    trusted.selectedAppId =
      provider.response === 1
        ? "openai.codex-cli"
        : "anthropic.claude-code-cli";
    trusted.approved = true;
  }
  if (command.type === "trust-installation") {
    const i = state.installations.find((i) => i.id === command.id);
    if (!i) throw new Error("Rediscover this installation first.");
    trusted.approved = await confirm(
      "Allow this native executable?",
      `${i.realPath}\nVersion: ${i.version ?? "unknown"}\nOwner: ${i.owner}\nIdentity: ${i.identity}\n\nTopsl will run --version, then allow you to connect or open native sessions. Only trust software you recognize.`,
      "Trust executable",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "runtime-connect") {
    const i = state.installations.find((i) => i.id === command.id);
    trusted.approved = await confirm(
      "Connect the experimental Codex integration?",
      `Runtime: ${i?.version ?? "unknown"}\n${i?.realPath}\n\nThis personal pilot probes local stdio initialization, models, and native account status. It does not certify all features of this version. Native configuration remains active. No model request is sent by this check.`,
      "Connect",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "lifecycle-apply") {
    const plan: LifecyclePlan = await request({
      kind: "review",
      recordKind: "plan",
      recordId: command.id,
    });
    const detail = [
      ...plan.effects,
      plan.command
        ? `Command: ${plan.command.executable} ${plan.command.args.join(" ")}`
        : "",
      plan.release?.url ?? plan.nativeApplicationPath ?? plan.nativeUrl ?? "",
      plan.release?.sha256 ? `SHA-256: ${plan.release.sha256}` : "",
      `Review expires: ${plan.expiresAt}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (
      !(await confirm(
        `Approve ${plan.action}?`,
        detail,
        plan.action === "download" ? "Download only" : "Approve operation",
      ))
    )
      return null;
    trusted.digest = plan.digest;
  }
  if (command.type === "configuration-apply") {
    const plan: ConfigurationPlan = await request({
      kind: "review",
      recordKind: "configuration-plan",
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Apply the reviewed native configuration?",
        `${plan.path}\n\nThe full edited text will replace this file. An encrypted local backup will be retained. External changes invalidate this approval. Native reload must be verified separately.\n\nRevision: ${plan.expectedHash}\nPlan: ${plan.digest}`,
        "Apply file",
      ))
    )
      return null;
    trusted.digest = plan.digest;
  }
  if (command.type === "approval-decide") {
    const approval: Approval = await request({
      kind: "review",
      recordKind: "approval",
      recordId: command.id,
    });
    if (
      command.allow &&
      !(await confirm(
        "Allow this native action once?",
        `${approval.description}\n\nRun: ${approval.runId}\nRequest: ${approval.requestId}\nDigest: ${approval.digest}`,
        "Allow once",
      ))
    )
      return null;
    trusted.digest = approval.digest;
  }
  if (command.type === "history-import") {
    const selected = await dialog.showOpenDialog(window!, {
      title: `Import an attributed ${command.provider} transcript`,
      properties: ["openFile"],
      filters: [{ name: "Native transcript", extensions: ["jsonl"] }],
    });
    if (selected.canceled) return null;
    trusted.selectedPath = selected.filePaths[0];
    trusted.approved = true;
  }
  if (command.type === "history-delete") {
    trusted.approved = await confirm(
      "Delete this Topsl conversation?",
      "Messages, search entries, snapshots, run records, and local usage facts will be deleted from Topsl. The original provider transcript and any exported files remain with their owners.",
      "Delete locally",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "run-reconcile") {
    trusted.approved = await confirm(
      "Have you inspected the interrupted native session?",
      "Topsl will confirm the recorded native process is no longer present, then let you start a new turn. The interrupted turn will not be replayed.",
      "Reconcile",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "handoff-export") {
    const chosen = await dialog.showSaveDialog(window!, {
      title: "Export reviewed handoff context",
      defaultPath: "Topsl-handoff.md",
      filters: [{ name: "Markdown context", extensions: ["md"] }],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    trusted.selectedPath = chosen.filePath;
    trusted.approved = true;
  }
  if (command.type === "run-start" && command.snapshotId) {
    trusted.approved = await confirm(
      "Send the reviewed context to Codex?",
      "The selected immutable handoff snapshot will be included in this native Codex turn. It can contain history originally created with another provider.",
      "Send context",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "context-enable") {
    trusted.approved = await confirm(
      "Share this project’s history with a native MCP client?",
      "This creates a local read-only project grant. It expires when Topsl closes. The grant cannot manage applications, modify configuration, start runs, or approve actions. Add the displayed command to native configuration yourself.",
      "Create project grant",
    );
    if (!trusted.approved) return null;
  }
  const result = await request({ kind: "command", command, trusted });
  if (command.type === "project-copy-path" && result?.copyProjectPath) {
    clipboard.writeText(result.copyProjectPath);
    return;
  }
  if (command.type === "project-open") {
    const opened = result as ProjectOpenResult;
    if (opened.applicationPath) {
      if (
        !state.installations.some(
          (i) =>
            i.id === command.installationId &&
            i.realPath === opened.applicationPath,
        )
      )
        throw new Error(
          "The selected application changed. Rediscover it first.",
        );
      if (opened.route === "claude-folder-link") {
        const installation = state.installations.find(
          (i) => i.id === command.installationId,
        );
        const project = state.projects.find((p) => p.id === command.projectId);
        if (
          installation?.appId !== "anthropic.claude-desktop" ||
          project?.realPath !== opened.projectPath ||
          !opened.nativeUrl ||
          !isClaudeFolderUrl(opened.nativeUrl, opened.projectPath)
        )
          throw new Error(
            "Invalid native folder link. Refresh projects first.",
          );
        if (process.platform === "darwin")
          await runFile("/usr/bin/open", [
            "-a",
            opened.applicationPath,
            opened.nativeUrl,
          ]);
        else await shell.openExternal(opened.nativeUrl);
      } else if (
        opened.route === "folder-open" &&
        process.platform === "darwin"
      ) {
        // Target an existing installation directly; never invoke a CLI that may install an absent app.
        await runFile("/usr/bin/open", [
          "-a",
          opened.applicationPath,
          opened.projectPath,
        ]);
      } else {
        const error = await shell.openPath(opened.applicationPath);
        if (error) throw new Error(error);
      }
    }
    return opened;
  }
  if (result?.openUrl) {
    if (!officialLink(result.openUrl))
      throw new Error("Unrecognized external destination.");
    await shell.openExternal(result.openUrl);
    return;
  }
  if (result?.openPath) {
    const error = await shell.openPath(result.openPath);
    if (error) throw new Error(error);
    return;
  }
  if (result?.reveal) {
    shell.showItemInFolder(result.reveal);
    return;
  }
  return result;
}
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Topsl",
        submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 780,
    minHeight: 600,
    title: "Topsl",
    backgroundColor: "#f4f1e8",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on("close", (event) => {
    const active =
      state.runs.some((r) =>
        ["starting", "running", "awaiting-approval"].includes(r.status),
      ) ||
      state.jobs.some((j) =>
        ["downloading", "verifying", "applying"].includes(j.state),
      );
    if (!active || closeApproved || quitting) return;
    event.preventDefault();
    if (closeReview) return;
    closeReview = true;
    void confirm(
      "Close Topsl while work is active?",
      "Topsl-owned native sessions will stop. An external installer may continue. Durable records will require reconciliation on restart; approved commands will not be replayed.",
      "Close Topsl",
    ).then((approved) => {
      closeReview = false;
      if (approved) {
        closeApproved = true;
        window?.close();
      }
    });
  });
  ipcMain.handle("topsl:command", async (event, raw: unknown) => {
    try {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        fileURLToPath(event.senderFrame.url) !== rendererFile
      )
        throw new Error("Untrusted control sender.");
      return { value: await dispatch(commandSchema.parse(raw)) };
    } catch (error) {
      return { error: safeError(error) };
    }
  });
  window.once("ready-to-show", () => window?.show());
  await window.loadFile(rendererFile);
  void unlock().catch(() => {});
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  if (worker) {
    event.preventDefault();
    quitting = true;
    worker.postMessage({ kind: "close", id: ++sequence });
    setTimeout(() => app.quit(), 300);
  }
});
