import {
  app,
  clipboard,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
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
import { safeError } from "../../packages/domain/invariants";
import { approvalConfirmation } from "../../packages/domain/approval-text";
import {
  bypassConfirmation,
  isBypassMode,
  terminalMode,
} from "../../packages/domain/terminal-modes";
import {
  autoAcceptConfirmation,
  autoAcceptTerminalMode,
} from "../../packages/domain/auto-accept";
import {
  claudeStepMode,
  claudeStepProvenanceText,
  claudeTranscriptConfirmation,
  type ClaudeStep,
  type ClaudeStepProvenance,
} from "../../packages/domain/claude-steps";
import { claudeRouteConfirmation } from "../../packages/domain/claude-route";
import { isWithin, runFile } from "../../packages/platform/system";
import type { TrustedInput } from "../service/service";
import { testProfileSettings } from "./test-profile";

const testProfile = testProfileSettings(process.env, app.isPackaged),
  isolatedTest = !!testProfile;
if (testProfile) app.setPath("userData", testProfile.profile);
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
  // The owner's theme is stored in the vault, so until it opens Topsl follows the computer.
  theme: "system",
  applications: catalog,
  capabilities,
  installations: [],
  checks: [],
  jobs: [],
  projects: [],
  projectOrderRevision: 0,
  conversations: [],
  messages: [],
  runs: [],
  usage: [],
  approvals: [],
  terminals: [],
  terminalModes: [],
  chatPresetBlocks: [],
  // The settings are stored in the vault too; until it opens, nothing runs.
  autoAccept: "off",
  claudeTranscriptRead: false,
  claudeStructuredRoute: { enabled: false, decidedAt: null },
  allowances: [],
  providerBudgets: [],
  serviceError: null,
  configurationWrites: [],
  testProfile: isolatedTest,
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
let windowBackground = "";
/** The paper color (style.css) of the theme on screen: Night's, or System's
 * on a dark computer, else Paper's. */
function themeBackground(): string {
  return state.theme === "night" ||
    (state.theme === "system" && nativeTheme.shouldUseDarkColors)
    ? "#101f28"
    : "#f3ebdd";
}
/** Repaints the window behind the page after the theme or the computer's appearance changes. */
function updateWindowBackground(): void {
  const color = themeBackground();
  if (!window || window.isDestroyed() || color === windowBackground) return;
  windowBackground = color;
  window.setBackgroundColor(color);
}
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
          updateWindowBackground();
          publish(message.event);
        } else if (message.event.type === "native-open") {
          const target = message.event.data?.target;
          // Only a catalog CLI's official page opens; Topsl launches no
          // desktop application (docs/UX_Cleanup_Plan.md §2).
          if (typeof target === "string" && officialLink(target))
            void shell
              .openExternal(target)
              .catch((e) => publish({ type: "error", data: safeError(e) }));
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
    state = await request({
      kind: "initialize",
      directory,
      key,
      isolatedTest,
      qualificationDirectory: testProfile?.qualificationDirectory ?? null,
    });
    updateWindowBackground();
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
  type: "question" | "warning" = "question",
): Promise<boolean> {
  const options = {
    type,
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
      `${trusted.selectedPath}\n\nNative instructions, hooks, plugins, and MCP servers in this project may execute when you start its runtime.${command.type === "project-relink" ? " Existing Topsl history will remain attached to this project; existing native entries are retained." : ""}`,
      "Trust project",
    );
    if (!trusted.approved) return null;
  }
  if (command.type === "project-trust") {
    const project = state.projects.find((project) => project.id === command.id);
    if (!project) throw new Error("Refresh the project list first.");
    trusted.selectedPath = project.path;
    trusted.approved = await confirm(
      "Trust this project?",
      `${project.name}\n${project.path}\n\nNative instructions, hooks, plugins, and MCP servers may execute when you start a native session in this folder.`,
      "Trust project",
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
    if (i?.appId === "anthropic.claude-code-cli") {
      trusted.approved = await confirm(
        "Connect Claude Code's structured route?",
        `Runtime: ${i.version ?? "unknown"}\n${i.realPath}\n\nTopsl runs \`claude auth status\` to read which Claude login this runtime uses. No model request is sent by this check. Claude Code has no model list; a model enters Topsl's catalog only when a qualification sees Claude Code report it.`,
        "Connect",
      );
      if (!trusted.approved) return null;
    } else {
      trusted.approved = await confirm(
        "Connect the experimental Codex integration?",
        `Runtime: ${i?.version ?? "unknown"}\n${i?.realPath}\n\nThis personal pilot probes local stdio initialization, models, and native account status. It does not certify all features of this version. Native configuration remains active. No model request is sent by this check.`,
        "Connect",
      );
      if (!trusted.approved) return null;
    }
  }
  if (command.type === "runtime-qualify") {
    const i = state.installations.find((i) => i.id === command.id);
    if (!i) throw new Error("Rediscover this installation first.");
    if (i.appId === "anthropic.claude-code-cli") {
      trusted.approved = await confirm(
        "Qualify this Claude Code runtime with live model turns?",
        `Runtime: ${i.version ?? "unknown"}\n${i.realPath}\nModel: ${command.model}\n\nTopsl will start 4 Claude Code turns, each a fresh session, under your own Claude login. They count against your Claude subscription usage. In a disposable folder ${testProfile?.qualificationDirectory ? `in ${testProfile.qualificationDirectory}` : "inside Topsl's profile"} it will:\n• ask a review session for a marker reply (structured turn)\n• ask a review session, which Claude Code must report as having no tools, to create a file, and check that nothing was written (read-only)\n• ask an edit session to write one file in the workspace and one outside it, and check that only the inside file exists and that Claude Code reported the outside write as denied (workspace write)\n• ask a review session to read a marker through Topsl's candidate reader, served to Claude Code by Topsl's own local tool server (candidate reader)\n• check the Claude login with claude auth status, that every turn used it and no API key, and that each Claude Code process stopped\n\nThe read-only and workspace-write results are Claude Code's own permission settings, not operating-system isolation. The folder is deleted afterwards. The result is recorded for 30 days and only for this executable, account, arguments and host.`,
        "Run qualification",
      );
      if (!trusted.approved) return null;
    } else {
      trusted.approved = await confirm(
        "Qualify this Codex runtime with live model turns?",
        `Runtime: ${i.version ?? "unknown"}\n${i.realPath}\nModel: ${command.model}${command.effort ? ` · effort ${command.effort}` : ""}\n\nTopsl will start up to 3 model turns through your native ChatGPT sign-in. They count against your subscription usage. In a disposable folder ${testProfile?.qualificationDirectory ? `in ${testProfile.qualificationDirectory}` : "inside Topsl's profile"} it will:\n• ask a review session for a marker reply (structured turn)\n• ask a second review session to read a marker through the reviewer's candidate reader from a one-file build that only Topsl holds (candidate reader)\n• run a write itself in Codex's sandbox under the read-only policy, and check that nothing was written\n• run two writes itself in Codex's sandbox under the workspace-write policy, one inside the workspace and one outside it, and check that only the inside file exists\n• interrupt a turn that is writing a long answer\n• check that the runtime process exits when the connection closes\n\nThe write checks send nothing to the model, and Topsl declines any approval request a turn makes. The folder is deleted afterwards. The result is recorded for 30 days and only for this executable, account, policy and host. It does not qualify the Claude route.`,
        "Run qualification",
      );
      if (!trusted.approved) return null;
    }
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
      plan.release?.url ?? plan.nativeUrl ?? "",
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
    command.type === "advanced-check-apply" ||
    command.type === "orchestration-check-apply"
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
    // Each Claude Code step names where its reply came from, so a reply the
    // owner pasted reads as theirs.
    const steps: ClaudeStepProvenance[] = review.claudeSteps ?? [];
    const claudeSteps = steps.length
      ? `\n\nClaude Code steps, each run in Claude Code's terminal under your control:\n${steps.map(claudeStepProvenanceText).join("\n")}${steps.some((step) => step.replySource === "owner-paste") ? "\nA reply you pasted is recorded as supplied by you; Topsl did not read it from Claude Code." : ""}`
      : "";
    if (
      !(await confirm(
        "Accept this reviewed candidate?",
        `${review.objective}\n\nCandidate: ${review.targetRevision}\n${review.detail}\n\nChecks: ${JSON.stringify(review.checks?.map((check: any) => ({ definition: check.definition, result: check.result, targetRevision: check.targetRevision })))}\nFindings: ${JSON.stringify(review.findings?.map((finding: any) => ({ title: finding.title, disposition: finding.disposition })))}${claudeSteps}\n\nIndependent filesystem isolation: ${review.isolation}\nAcceptance does not deploy or commit changes. External changes invalidate this confirmation.`,
        "Accept candidate",
      ))
    )
      return null;
    trusted.digest = review.digest;
  }
  if (command.type === "orchestration-accept") {
    const review: any = await request({
      kind: "review",
      recordKind: "goal-acceptance",
      recordId: command.goalId,
    });
    if (
      !(await confirm(
        "Accept this reviewed candidate?",
        `${review.objective}\n\nCandidate: ${review.targetRevision}\n${review.detail}\n\nReview group: ${JSON.stringify(review.review)}\n${review.checks?.length ? `Required checks on this exact candidate: ${JSON.stringify(review.checks.map((check: any) => ({ definition: check.definition, label: check.label, result: check.result, targetRevision: check.targetRevision })))}` : "This goal has no required checks; acceptance rests on the review group's evidence only."}\n\nAcceptance records your decision for this exact candidate. It does not write the project folder, deploy or commit; applying the candidate to the folder is a separate step with its own confirmation. Any change to the goal, review, checks or candidate invalidates this confirmation.`,
        "Accept candidate",
      ))
    )
      return null;
    trusted.digest = review.digest;
  }
  if (command.type === "orchestration-apply") {
    const review: any = await request({
      kind: "review",
      recordKind: "goal-application",
      recordId: command.goalId,
    });
    const files: Array<{ path: string; change: string }> = review.files ?? [];
    if (
      !(await confirm(
        "Apply the accepted candidate to the project folder?",
        `${review.objective}\n\nFolder: ${review.root}\nGit commit: ${review.baseRevision ?? "none"}\nCandidate: ${review.candidateId}\n\n${files.length} ${files.length === 1 ? "file" : "files"} will be written:\n${files
          .slice(0, 200)
          .map((file) => `${file.change}: ${file.path}`)
          .join(
            "\n",
          )}${files.length > 200 ? `\n… and ${files.length - 200} more` : ""}\n\nTopsl checked that the folder has no uncommitted or untracked changes and still matches the goal's baseline, and checks again just before writing. Nothing is committed, staged or pushed. Native tools watching the folder may react to the change.`,
        "Apply to folder",
        "warning",
      ))
    )
      return null;
    trusted.digest = review.digest;
  }
  if (
    command.type === "loop-start" ||
    (command.type === "loop-policy-update" &&
      (command.policy.automaticChecks === true ||
        command.policy.excludedProviders !== undefined))
  ) {
    // The run's authority is recorded once, from this dialog; ordinary
    // iterations are not approved one by one.
    const review: any = await request({
      kind: "review",
      recordKind:
        command.type === "loop-start" ? "loop-authority" : "loop-policy",
      recordId:
        command.type === "loop-start"
          ? command.runId
          : `${command.runId}:${Buffer.from(JSON.stringify(command.policy)).toString("base64url")}`,
    });
    const goals: Array<{ text: string; required: boolean }> =
      review.goals ?? [];
    if (
      !(await confirm(
        command.type === "loop-start"
          ? `Start this ${review.mode === "goal" ? "Goal" : "Endless"} loop? (Experimental)`
          : "Widen what this loop may run? (Experimental)",
        `${review.title}\n\n${(review.statements as string[]).join("\n\n")}${goals.length ? `\n\nGoals:\n${goals.map((g) => `- ${g.text}${g.required ? "" : " (optional)"}`).join("\n")}` : ""}\n\nYou can pause or stop the run at any time; stopping fences new work and keeps the accepted checkpoint.`,
        command.type === "loop-start" ? "Start loop" : "Allow",
        "warning",
      ))
    )
      return null;
    trusted.digest = review.digest;
  }
  if (command.type === "loop-publication-apply") {
    const review: any = await request({
      kind: "review",
      recordKind: "loop-publication",
      recordId: command.runId,
    });
    const files: Array<{ path: string; change: string }> = review.files ?? [];
    if (
      !(await confirm(
        "Publish the loop's accepted checkpoint to the project folder?",
        `Folder: ${review.root}\nCheckpoint: ${review.sequence} (${review.basis === "first" ? "first publication from the run's starting folder" : "only the changes since the last publication"})\n\n${files.length} ${files.length === 1 ? "file" : "files"} will be written:\n${files
          .slice(0, 200)
          .map((file) => `${file.change}: ${file.path}`)
          .join(
            "\n",
          )}${files.length > 200 ? `\n… and ${files.length - 200} more` : ""}\n\nThis checkpoint was promoted automatically by the loop's policy, not accepted by you. Topsl checked that the folder still matches what it expects and checks again just before writing. Nothing is committed, staged or pushed.`,
        "Publish to folder",
        "warning",
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
  if (
    (command.type === "project-open" ||
      (command.type === "terminal-open" && !command.login)) &&
    isBypassMode(command.permissionMode)
  ) {
    // Asked every time, before the service sees the request; the renderer cannot answer it.
    const installation = state.installations.find(
        (i) => i.id === command.installationId,
      ),
      project = state.projects.find((p) => p.id === command.projectId);
    if (!installation || !project)
      throw new Error("Refresh Topsl, then choose the terminal again.");
    // A desktop app gets no mode from Topsl; the service refuses one.
    if (installation.appId.endsWith("cli")) {
      const provider = installation.appId.includes("claude")
          ? "claude"
          : "codex",
        text = bypassConfirmation(
          provider,
          terminalMode(provider, command.permissionMode),
          installation.realPath,
          project.realPath,
        );
      if (
        !(await confirm(text.message, text.detail, text.affirmative, "warning"))
      )
        return null;
      trusted.confirmedTerminalMode = command.permissionMode;
    }
  }
  if (
    command.type === "assisted-handoff-open" &&
    state.autoAccept === "everything"
  ) {
    // A build handoff then opens in a bypass mode, which Topsl confirms like
    // any other; a review handoff keeps its own mode.
    const handoff: { role: string; installationId: string } = await request({
        kind: "review",
        recordKind: "assisted-handoff",
        recordId: command.id,
      }),
      installation = state.installations.find(
        (i) => i.id === handoff.installationId,
      ),
      project = state.projects.find((p) => p.id === command.projectId);
    if (handoff.role === "builder" && installation?.appId.endsWith("cli")) {
      if (!project)
        throw new Error("Refresh Topsl, then open the handoff again.");
      const provider = installation.appId.includes("claude")
          ? "claude"
          : "codex",
        mode = autoAcceptTerminalMode("everything", provider)!,
        text = bypassConfirmation(
          provider,
          terminalMode(provider, mode),
          installation.realPath,
          project.realPath,
        );
      if (
        !(await confirm(text.message, text.detail, text.affirmative, "warning"))
      )
        return null;
      trusted.confirmedTerminalMode = mode;
    }
  }
  if (command.type === "claude-step-open") {
    // A build or repair opens in Bypass only under Everything, and Topsl
    // confirms it each time; a review always opens in Plan.
    const step: ClaudeStep = await request({
        kind: "review",
        recordKind: "claude-step",
        recordId: command.stepId,
      }),
      installation = state.installations.find(
        (i) => i.id === step.installationId,
      );
    let mode;
    try {
      mode = claudeStepMode(
        step.role,
        state.autoAccept,
        command.permissionMode,
      );
    } catch {
      // The service refuses this mode with the reason.
    }
    if (mode && isBypassMode(mode)) {
      if (!installation)
        throw new Error("Refresh Topsl, then open the step again.");
      const text = bypassConfirmation(
        "claude",
        terminalMode("claude", mode),
        installation.realPath,
        step.folder,
      );
      if (
        !(await confirm(text.message, text.detail, text.affirmative, "warning"))
      )
        return null;
      trusted.confirmedTerminalMode = mode;
    }
  }
  if (command.type === "auto-accept-set" && command.level !== "off") {
    // Asked before the service sees the request; the renderer cannot answer it.
    const text = autoAcceptConfirmation(command.level);
    if (
      !(await confirm(
        text.message,
        text.detail,
        text.affirmative,
        command.level === "everything" ? "warning" : "question",
      ))
    )
      return null;
    trusted.confirmedAutoAccept = command.level;
  }
  if (command.type === "claude-structured-route-set" && command.enabled) {
    // Asked before the service sees the request; the renderer cannot answer it.
    const text = claudeRouteConfirmation();
    if (
      !(await confirm(text.message, text.detail, text.affirmative, "warning"))
    )
      return null;
    trusted.confirmedClaudeRoute = true;
  }
  if (command.type === "claude-transcript-read-set" && command.enabled) {
    // Asked before the service sees the request; the renderer cannot answer it.
    const text = claudeTranscriptConfirmation();
    if (!(await confirm(text.message, text.detail, text.affirmative)))
      return null;
    trusted.confirmedTranscriptRead = true;
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
        approvalConfirmation(approval),
        "Allow once",
      ))
    )
      return null;
    trusted.digest = approval.digest;
  }
  if (command.type === "history-import-preview") {
    const selected = await dialog.showOpenDialog(window!, {
      title: `Import an exported ${command.provider === "claude" ? "Claude Code" : "Codex"} history`,
      properties: ["openFile"],
      filters: [
        {
          name: "Exported history",
          extensions: ["md", "txt", "json", "jsonl", "ndjson"],
        },
      ],
    });
    if (selected.canceled) return null;
    trusted.selectedPath = selected.filePaths[0];
  }
  if (command.type === "history-import-delete") {
    trusted.approved = await confirm(
      "Delete this import?",
      "Its stored text and search entries will be deleted from Topsl. Sessions that already started with it keep the copy they were given. The original exported file is not changed.",
      "Delete import",
    );
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
  // The owner pastes the step's instructions into Claude Code.
  if (command.type === "claude-step-open" && result?.instructions)
    clipboard.writeText(result.instructions);
  if (command.type === "project-open") return result as ProjectOpenResult;
  if (result?.openUrl) {
    if (!officialLink(result.openUrl))
      throw new Error("Unrecognized external destination.");
    await shell.openExternal(result.openUrl);
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
  const iconPath = path.join(__dirname, "icon.png");
  app.setAboutPanelOptions({
    applicationName: "Topsl",
    applicationVersion: app.getVersion(),
    credits: "Navigator’s Atlas · pronounced “topsail”",
    iconPath,
  });
  if (process.platform === "darwin") app.dock?.setIcon(iconPath);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Topsl",
        submenu: [
          { label: "About Topsl", role: "about" },
          { type: "separator" },
          { label: "Quit Topsl", role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  windowBackground = themeBackground();
  window = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 780,
    minHeight: 600,
    title: "Topsl",
    icon: iconPath,
    backgroundColor: windowBackground,
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
  nativeTheme.on("updated", updateWindowBackground);
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
