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
let activeControl = false;
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
        } else if (message.event.type === "activity") {
          activeControl = message.event.data?.active === true;
        } else if (
          ["terminal", "changes", "auth-url"].includes(message.event.type)
        )
          publish(message.event);
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
  if (command.type === "builder-reviewer-advance") {
    const review: any = await request({
      kind: "review",
      recordKind: "workflow-dispatch-inputs",
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Approve captured inputs and start?",
        `${JSON.stringify(review, null, 2)}\n\nThe captured manifest, omissions, specification and explicit provider/runtime/model assignments above are the reviewed execution inputs. Changed files or revisions invalidate this approval. Provider acknowledgement does not establish comprehension. Native permission and billing rules still apply.`,
        "Approve inputs and start",
      ))
    )
      return null;
    trusted.digest = review.digest;
  }
  if (command.type === "replication-mapping-preview") {
    const chosen = await dialog.showOpenDialog(window!, {
      title: "Select the approved local workspace mapping",
      properties: ["openDirectory"],
    });
    if (chosen.canceled) return null;
    trusted.selectedPath = chosen.filePaths[0];
  }
  if (
    command.type === "replication-plan-apply" ||
    command.type === "replication-conflict-resolve" ||
    command.type === "advanced-accept"
  ) {
    const recordKind =
      command.type === "replication-plan-apply"
        ? "replication-plan"
        : command.type === "replication-conflict-resolve"
          ? "replication-conflict"
          : "advanced-acceptance";
    const review: any = await request({
      kind: "review",
      recordKind,
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Approve this optional coordination operation?",
        `${JSON.stringify(review, null, 2)}\n\nOnly this exact digest is approved. Replicated metadata does not grant native runtime access or trust; remote native control remains unsupported.`,
        "Approve exact operation",
      ))
    )
      return null;
    trusted.digest = review.digest;
  }
  if (
    command.type === "replication-delete" ||
    command.type === "replication-device-revoke"
  ) {
    trusted.approved = await confirm(
      command.type === "replication-delete"
        ? "Delete this replicated metadata record?"
        : "Revoke this approved peer device?",
      `Selected record: ${command.type === "replication-delete" ? command.recordId : command.deviceId}\n\nDeletion boundaries propagate through explicitly exchanged encrypted metadata. Native folders, history and credentials remain with their owners.`,
      "Confirm change",
    );
    if (!trusted.approved) return null;
  }
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
  if (command.type === "runtime-qualify") {
    const i = state.installations.find((i) => i.id === command.id);
    if (!i) throw new Error("Rediscover this installation first.");
    trusted.approved = await confirm(
      "Qualify this Codex runtime with live model turns?",
      `Runtime: ${i.version ?? "unknown"}\n${i.realPath}\nModel: ${command.model}${command.effort ? ` · effort ${command.effort}` : ""}\n\nTopsl will start up to 4 model turns through your native ChatGPT sign-in. They count against your subscription usage. In a disposable folder inside Topsl's profile it will:\n• ask for a marker reply (structured turn)\n• ask a read-only session to write a file, and check that nothing was written\n• ask an editing session to write one file inside its workspace and one outside it, and check that only the inside file exists\n• interrupt a turn that is writing a long answer\n• check that the runtime process exits when the connection closes\n\nApprovals are accepted only for those exact sentinel commands, once each; all others are declined. The folder is deleted afterwards. The result is recorded for 30 days and only for this executable, account, policy and host. It does not qualify the Claude route or the reviewer's candidate reader.`,
      "Run qualification",
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
  if (
    command.type === "workspace-plan-apply" ||
    command.type === "parallel-integration-apply"
  ) {
    const recordKind =
      command.type === "workspace-plan-apply"
        ? "workspace-plan"
        : "integration-plan";
    const plan: any = await request({
      kind: "review",
      recordKind,
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Apply this reviewed workspace operation?",
        `${(plan.effects ?? []).join("\n")}\n\n${JSON.stringify({ ...plan, files: plan.files?.map((file: any) => ({ path: file.path, hash: file.hash, bytes: file.bytes })) }, null, 2)}\n\nWorkspaces isolate code changes; they do not sandbox OS access. External changes invalidate this review.`,
        "Apply operation",
      ))
    )
      return null;
    trusted.digest = plan.digest;
  }
  if (command.type === "parallel-accept") {
    const review: any = await request({
      kind: "review",
      recordKind: "parallel-acceptance",
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Accept this combined candidate?",
        `${review.state.detail}\n\nCombined candidate: ${review.combinedCandidate?.revision ?? "unknown"}\nChecks and submissions: ${JSON.stringify(review.state, null, 2).slice(0, 16000)}\n\nAcceptance does not commit or deploy.`,
        "Accept candidate",
      ))
    )
      return null;
    trusted.digest = review.digest;
  }
  if (command.type === "advanced-review-confirm") {
    const plan: any = await request({
      kind: "review",
      recordKind: "advanced-review-plan",
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Confirm this frozen proposal review?",
        `${JSON.stringify(plan, null, 2)}\n\nThis records your explicit review of the frozen proposal and rubric. It does not claim automated testing, independent comprehension or deployment.`,
        "Confirm reviewed proposal",
      ))
    )
      return null;
    trusted.digest = plan.digest;
  }
  if (command.type === "candidate-review-apply") {
    const plan: any = await request({
      kind: "review",
      recordKind: "candidate-review-plan",
      recordId: command.id,
    });
    const recapture = !!plan.capturePaths?.length;
    if (
      !(await confirm(
        recapture
          ? "Capture these exact proposed output files?"
          : "Record this candidate artifact review?",
        `Candidate: ${plan.candidateId}\nRevision: ${plan.candidateRevision}\n\n${recapture ? `New capture paths and hashes:\n${JSON.stringify(plan.capturePaths, null, 2)}\n\nThis creates a new candidate and requires a fresh review and checks. Approval is single-use; failed capture needs a new plan.` : `Output decisions:\n${JSON.stringify(plan.outputs, null, 2)}\n\nBinaries confirmed to have PASSED your manual verification:\n${JSON.stringify(plan.binaries, null, 2)}\n\nOnly confirm binary entries whose exact listed bytes passed your actual manual check. A failed or unperformed check must not be confirmed.`}\n\nThis does not execute new scripts, waive required checks, or accept the candidate.\nApproval expires: ${plan.expiresAt}`,
        recapture ? "Capture exact output files" : "Record reviewed artifacts",
      ))
    )
      return null;
    trusted.digest = plan.digest;
  }
  if (
    command.type === "builder-reviewer-check-apply" ||
    command.type === "parallel-check-apply" ||
    command.type === "advanced-check-apply"
  ) {
    const plan: any = await request({
      kind: "review",
      recordKind: "workflow-check-plan",
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Run this required check?",
        `${plan.definition.label}\n\nExecutable: ${plan.definition.executable}\nArguments: ${JSON.stringify(plan.definition.args)}\nCandidate: ${plan.targetRevision}\nTimeout: ${plan.definition.timeoutMs} ms\nPreparation network: ${plan.environmentRecipe?.network?.preparation ?? "legacy unknown"}\n\nThe check runs against a disposable copy of the exact captured files. Preparation and checks have separate protected records. This process has the user's OS permissions; network, CPU/memory limits and access outside the temporary directory are not sandboxed. It receives a disposable home with no inherited model-provider credentials. Review exact dependency commands, lifecycle hook exceptions and writable output paths below.\n\n${JSON.stringify(plan.environmentRecipe ?? { legacyEnvironment: plan.environment }, null, 2)}\nExecution authorization: ${JSON.stringify(plan.definition.executionPolicy ?? { maximumUses: 1 })}\nApproval expires: ${plan.expiresAt}`,
        "Run check",
      ))
    )
      return null;
    trusted.digest = plan.digest;
  }
  if (command.type === "builder-reviewer-accept") {
    const review: any = await request({
      kind: "review",
      recordKind: "workflow-acceptance",
      recordId: command.id,
    });
    if (
      !(await confirm(
        "Accept this reviewed candidate?",
        `${review.objective}\n\nCandidate: ${review.targetRevision}\n${review.detail}\n\nChecks: ${JSON.stringify(review.checks?.map((check: any) => ({ definition: check.definition, result: check.result, targetRevision: check.targetRevision })))}\nFindings: ${JSON.stringify(review.findings?.map((finding: any) => ({ title: finding.title, disposition: finding.disposition })))}\n\nIndependent filesystem isolation: ${review.isolation}\nAcceptance does not deploy or commit changes. External changes invalidate this confirmation.`,
        "Accept candidate",
      ))
    )
      return null;
    trusted.digest = review.digest;
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
  if (command.type === "sync-field-push") {
    const sync: any = await request({
      command: { type: "synchronization-query", projectId: command.projectId },
    });
    const field = sync.fields.find(
      (item: any) =>
        item.id === command.id && item.revision === command.expectedRevision,
    );
    if (!field)
      throw new Error(
        "This synchronization field changed. Refresh before reviewing its write.",
      );
    trusted.approved = await confirm(
      "Push this reviewed native name?",
      `Direction: Topsl → native registry\nCurrent native value: ${JSON.stringify(field.remote)}\nReviewed Topsl value: ${JSON.stringify(field.local)}\nSource revision: ${field.revision}\n\nOnly the supported native registry field is written. Visible desktop presentation has separate readback.`,
      "Push reviewed name",
    );
    if (!trusted.approved) return null;
  }
  if (
    command.type === "history-import" ||
    command.type === "native-history-approve"
  ) {
    const selected = await dialog.showOpenDialog(window!, {
      title: `Import an attributed ${command.provider} transcript`,
      properties: ["openFile"],
      filters: [{ name: "Native transcript", extensions: ["jsonl", "ndjson"] }],
    });
    if (selected.canceled) return null;
    trusted.selectedPath = selected.filePaths[0];
    trusted.approved =
      command.type === "history-import" ||
      (await confirm(
        "Observe this native history source?",
        `${command.provider}\nProfile: ${command.type === "native-history-approve" ? command.profileId : "selected"}\n${trusted.selectedPath}\n\nTopsl will incrementally read this exact source and record coverage gaps. Native files remain with their owner.`,
        "Approve source",
      ));
    if (!trusted.approved) return null;
  }
  if (command.type === "history-delete") {
    trusted.approved = await confirm(
      "Delete this Topsl conversation?",
      "Conversation messages, search entries, conversation snapshots, run records, and local usage facts will be deleted from Topsl. Independently retained project candidates, verification evidence, and their protected artifacts remain with the project. Original provider transcripts and exported files remain with their owners.",
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
  const result = await request(
    { kind: "command", command, trusted },
    // Qualification runs bounded live turns: 4 × 3 minutes plus connection setup.
    command.type === "runtime-qualify" ? 20 * 60_000 : undefined,
  );
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
      activeControl ||
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
    const closingWorker = worker;
    const exited = new Promise<void>((resolve) =>
      closingWorker.once("exit", () => resolve()),
    );
    void (async () => {
      try {
        await request({ kind: "close" }, 45_000);
        await exited;
        app.quit();
      } catch (error) {
        quitting = false;
        closeApproved = false;
        dialog.showErrorBox("Topsl shutdown needs attention", safeError(error));
      }
    })();
  }
});
