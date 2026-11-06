import { _electron as electron, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Live acceptance of the subscription runtime architecture
// (docs/Subscription_Runtime_Architecture_Plan.md, §9.3): Claude through
// Claude Code and GPT through Topsl's own ChatGPT plan connection, in one
// Topsl workflow. Unlike the automated suites, this sends real model turns,
// so it counts against the owner's ChatGPT plan and Claude subscription.
//
// Topsl runs from this checkout (after `npm run build`) on a disposable
// topsl-test-* profile; the owner's own profile is not opened. Only the
// dialogs this procedure expects are approved; any other is cancelled, and
// every dialog is recorded. The ChatGPT sign-in opens OpenAI's page in the
// owner's browser: the owner signs in there; nothing here enters a
// credential. The report keeps states, models, counts and Topsl's own
// observations, never tokens, e-mail addresses or account identifiers.
//
// Steps:
//   1. ChatGPT plan: create the connection, sign in (the owner), list the
//      account's models, add a route.
//   2. Native task on that route, editing value.ts with Topsl's tools
//      (plan Phase 3 live gate: a completed task with a tool call).
//   3. Claude Code: locate, trust, turn on the structured route, connect and
//      qualify --claude-model (4 Claude turns).
//   4. Agent jobs on. Team A: native GPT coordinator → Claude Code
//      implementer → native GPT reviewer, Claude Code researcher; the
//      coordinator is asked to request one agent job.
//   5. Team B: the reverse — Claude Code coordinator → native implementer →
//      Claude Code reviewer, native researcher, with one agent job asked.
const usage =
  "Usage: node scripts/live-subscription.mjs --claude /absolute/path/to/claude --claude-model model-id [--chatgpt-model model] [--sign-in-minutes 15] [--goal-minutes 40] [--skip-team-b] [--keep-profile] [--output directory]";
const options = {
  claude: null,
  claudeModel: null,
  chatgptModel: null,
  signInMinutes: 15,
  goalMinutes: 40,
  skipTeamB: false,
  keepProfile: false,
  output: null,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const value = () => {
    const next = process.argv[++i];
    if (!next || next.startsWith("--")) throw new Error(usage);
    return next;
  };
  if (a === "--claude") options.claude = value();
  else if (a === "--claude-model") options.claudeModel = value();
  else if (a === "--chatgpt-model") options.chatgptModel = value();
  else if (a === "--sign-in-minutes") options.signInMinutes = Number(value());
  else if (a === "--goal-minutes") options.goalMinutes = Number(value());
  else if (a === "--skip-team-b") options.skipTeamB = true;
  else if (a === "--keep-profile") options.keepProfile = true;
  else if (a === "--output") options.output = value();
  else throw new Error(usage);
}
if (
  !options.claude ||
  !path.isAbsolute(options.claude) ||
  !options.claudeModel ||
  !(options.signInMinutes > 0) ||
  !(options.goalMinutes > 0)
)
  throw new Error(usage);
if (process.platform === "win32")
  throw new Error("The live procedure runs on macOS and Linux only.");
await stat("dist/main.cjs").catch(() => {
  throw new Error("Run `npm run build` in this checkout first.");
});

const home = os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitIn = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const log = (step, message) => console.log(`[${step}] ${message}`);
// The same names as billingConflicts in packages/platform/system.ts.
const billing =
  /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/;
const caches =
  process.platform === "darwin"
    ? path.join(home, "Library", "Caches")
    : path.join(home, ".cache");
await mkdir(caches, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-live-sub-"));
// Outside the temporary folders, as runtime qualification requires.
const projectFolder = await mkdtemp(path.join(caches, "topsl-live-sub-"));
const qualificationFolder = await mkdtemp(path.join(caches, "topsl-qualify-"));
const project = path.join(projectFolder, "live-sub-project");
await mkdir(project);
await writeFile(path.join(project, "value.ts"), "export const value = 1;\n");
await writeFile(
  path.join(project, "README.md"),
  "# Live subscription project\n\n`value.ts` exports one number. Its value should be 2.\n",
);
gitIn(project, "init", "-q");
gitIn(project, "add", ".");
gitIn(
  project,
  "-c",
  "user.email=live@example.invalid",
  "-c",
  "user.name=Live",
  "commit",
  "-qm",
  "base",
);
const canonicalProject = await realpath(project);
process.on("exit", () => {
  if (options.keepProfile) return;
  for (const folder of [profile, projectFolder, qualificationFolder])
    rmSync(folder, { recursive: true, force: true });
});

const environment = {
  ...process.env,
  TOPSL_TEST_PROFILE: profile,
  TOPSL_TEST_QUALIFICATION_DIR: qualificationFolder,
};
delete environment.ELECTRON_RUN_AS_NODE;
const removedEnvironment = Object.keys(environment).filter((n) =>
  billing.test(n),
);
for (const n of removedEnvironment) delete environment[n];
const output = path.resolve(
  options.output ??
    path.join(
      "test-results",
      "live-subscription",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
);
await mkdir(output, { recursive: true });

const report = {
  schemaVersion: 1,
  kind: "topsl-live-subscription-runtime",
  observedAt: new Date().toISOString(),
  host: `${os.platform()}/${os.arch()} ${os.release()}`,
  topsl: {
    version: JSON.parse(await readFile("package.json", "utf8")).version,
    commit: gitIn(process.cwd(), "rev-parse", "HEAD"),
    trackedChanges:
      gitIn(process.cwd(), "status", "--porcelain", "--untracked-files=no") !==
      "",
  },
  removedEnvironment,
  dialogs: [],
  chatgpt: null,
  nativeTask: null,
  claudeQualification: null,
  teams: [],
  failure: null,
  result: "failed",
};
const save = () =>
  writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));

const app = await electron.launch({
  args: ["."],
  env: environment,
  timeout: 90000,
});
const page = await app.firstWindow();
const command = (value) => page.evaluate((v) => window.topsl.command(v), value);
const shot = (name) =>
  page
    .screenshot({ path: path.join(output, `${name}.png`), fullPage: true })
    .catch(() => {});
const state = () => command({ type: "state" });

try {
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await app.evaluate(
    ({ dialog }, policy) => {
      globalThis.__live = { policy, dialogs: [] };
      const optionsOf = (args) => (args.length > 1 ? args[1] : args[0]) ?? {};
      dialog.showOpenDialog = async (...args) => {
        const { policy, dialogs } = globalThis.__live;
        const title = String(optionsOf(args).title ?? "");
        const selected =
          title === "Select a trusted project"
            ? policy.project
            : title === "Choose the native executable"
              ? policy.executable
              : null;
        dialogs.push({ dialog: title, answer: selected ? "selected" : "Cancel" });
        return selected
          ? { canceled: false, filePaths: [selected] }
          : { canceled: true, filePaths: [] };
      };
      dialog.showMessageBox = async (...args) => {
        const { policy, dialogs } = globalThis.__live;
        const v = optionsOf(args);
        const message = String(v.message ?? ""),
          detail = String(v.detail ?? ""),
          buttons = (v.buttons ?? []).map(String);
        const expected =
          message === "Which runtime are you locating?"
            ? "Claude Code"
            : message === "Trust this project?" &&
                detail.startsWith(`${policy.project}\n`)
              ? "Trust project"
              : message === "Allow this native executable?" &&
                  detail.startsWith(`${policy.executableRealPath}\n`)
                ? "Trust executable"
                : message === "Connect Claude Code's structured route?" &&
                    detail.includes(`\n${policy.executableRealPath}\n`)
                  ? "Connect"
                  : message ===
                        "Qualify this Claude Code runtime with live model turns?" &&
                      detail.includes(`\nModel: ${policy.model}`)
                    ? "Run qualification"
                    : message === "Let Topsl run Claude Code unattended?"
                      ? "Allow unattended Claude Code"
                      : message === "Continue with ChatGPT?" && policy.chatgpt
                        ? "Continue with ChatGPT"
                        : null;
        // Anything unexpected is cancelled, never approved.
        const cancel =
          typeof v.cancelId === "number"
            ? v.cancelId
            : buttons.findIndex((b) => /^cancel$/i.test(b));
        const response = expected
          ? Math.max(0, buttons.indexOf(expected))
          : cancel >= 0
            ? cancel
            : buttons.length - 1;
        dialogs.push({ dialog: message, answer: buttons[response] ?? null });
        return { response, checkboxChecked: false };
      };
    },
    {
      project,
      executable: null,
      executableRealPath: null,
      model: null,
      chatgpt: false,
    },
  );
  const policy = (value) =>
    app.evaluate((_e, v) => Object.assign(globalThis.__live.policy, v), value);

  // The scratch project, trusted as a user would.
  await command({ type: "project-add" });
  let projectId = null;
  await expect
    .poll(
      async () =>
        (projectId =
          (await state()).projects.find(
            (p) => p.realPath === canonicalProject || p.path === project,
          )?.id ?? null),
      { timeout: 30000 },
    )
    .not.toBeNull();

  // 1. ChatGPT plan through Topsl's own sign-in.
  await expect
    .poll(async () => !!(await state()).proxy, { timeout: 60000 })
    .toBe(true);
  await policy({ chatgpt: true });
  const connection = await command({
    type: "connection-create",
    kind: "chatgpt-plan",
    label: "ChatGPT (live)",
  });
  await command({ type: "connection-sign-in", connectionId: connection.id });
  console.log(
    "\n>>> Sign in to ChatGPT in the browser page Topsl just opened. Waiting up to",
    options.signInMinutes,
    "minutes.\n",
  );
  const connectionView = async () =>
    (await state()).proxy?.connections.find((c) => c.id === connection.id) ??
    null;
  const signInDeadline = Date.now() + options.signInMinutes * 60_000;
  let signed = null;
  for (;;) {
    signed = await connectionView();
    // A new connection is signed-out until the owner finishes signing in.
    if (signed && signed.state !== "signed-out") break;
    if (Date.now() > signInDeadline) break;
    await sleep(3000);
  }
  // State only: "ready" means plan use was granted, "plan-use-disabled" that
  // the sign-in holds no plan permission. No account identity is kept.
  report.chatgpt = {
    state: signed?.state ?? null,
    funding: signed?.funding ?? null,
    detail: String(signed?.stateDetail ?? "").slice(0, 500),
  };
  log("chatgpt", `connection state: ${report.chatgpt.state}`);
  await save();
  if (!signed || !["ready", "paused-usage-limit"].includes(signed.state))
    throw new Error(
      `The ChatGPT plan connection is not ready (${signed?.state ?? "missing"}).`,
    );
  const listed = await command({
    type: "connection-models",
    connectionId: connection.id,
  });
  const models = (Array.isArray(listed) ? listed : []).map((m) => m.id);
  report.chatgpt.models = models.slice(0, 40);
  const upstreamModel = options.chatgptModel ?? models[0];
  if (!upstreamModel) throw new Error("The ChatGPT account listed no models.");
  const route = await command({
    type: "route-save",
    connectionId: connection.id,
    upstreamModel,
    alias: "chatgpt/live",
  });
  report.chatgpt.route = {
    alias: route?.alias ?? "chatgpt/live",
    upstreamModel,
    adapterRevision: route?.adapterRevision ?? null,
  };
  log("chatgpt", `route chatgpt/live → ${upstreamModel}`);
  await save();

  // 2. A native task with Topsl's tools on the plan route.
  const started = await command({
    type: "native-start",
    projectId,
    title: "Live native edit",
    prompt:
      "Use read_file to read value.ts, then use edit_file to change the exported value from 1 to 2 (pass the sha256 read_file reported). Then reply with one sentence saying what you changed.",
    routeAlias: "chatgpt/live",
    mode: "edit",
    maxRequests: 12,
  });
  const attemptId = started?.attemptId ?? started?.view?.attemptId;
  const terminal = new Set([
    "completed",
    "failed",
    "cancelled",
    "uncertain",
    "paused",
    "waiting-quota",
  ]);
  let native = null;
  const nativeDeadline = Date.now() + 15 * 60_000;
  for (;;) {
    const s = await command({ type: "native-state", projectId });
    native = (s?.attempts ?? s?.items ?? []).find(
      (a) => a.attemptId === attemptId,
    );
    if ((native && terminal.has(native.state)) || Date.now() > nativeDeadline)
      break;
    await sleep(3000);
  }
  report.nativeTask = native
    ? {
        state: native.state,
        stateDetail: String(native.stateDetail ?? "").slice(0, 800),
        requests: native.requests,
        toolCalls: native.toolCalls,
        usage: native.usage,
        reportedModel: native.reportedModel ?? null,
        summary: String(native.summary ?? "").slice(0, 800),
        binding: native.binding?.native
          ? {
              connectionKind: native.binding.native.connectionKind,
              funding: native.binding.native.funding,
              upstreamModel: native.binding.native.upstreamModel,
            }
          : null,
      }
    : { state: "not-found" };
  log(
    "native",
    `task ${report.nativeTask.state}: ${report.nativeTask.toolCalls ?? 0} tool calls, ${report.nativeTask.requests ?? 0} requests`,
  );
  await shot("native-task");
  await save();

  // 3. Claude Code: located, trusted, structured route on, qualified.
  const claudeReal = await realpath(options.claude);
  await policy({
    executable: options.claude,
    executableRealPath: claudeReal,
    model: options.claudeModel,
  });
  const installation = await command({ type: "select-runtime" });
  if (!installation?.appId?.includes("claude"))
    throw new Error("Topsl did not record the Claude Code executable.");
  await expect
    .poll(
      async () =>
        (await state()).installations.some((i) => i.id === installation.id),
      { timeout: 30000 },
    )
    .toBe(true);
  const trusted = await command({
    type: "trust-installation",
    id: installation.id,
  });
  if (!trusted?.trusted) throw new Error("Topsl did not trust Claude Code.");
  const claudeRoute = await command({
    type: "claude-structured-route-set",
    enabled: true,
  });
  if (!claudeRoute?.enabled)
    throw new Error("Topsl did not turn on Claude Code's structured route.");
  await command({ type: "runtime-connect", id: installation.id });
  const qualification = await command({
    type: "runtime-qualify",
    id: installation.id,
    model: options.claudeModel,
  });
  report.claudeQualification = {
    version: trusted.version,
    model: options.claudeModel,
    acceptanceId: qualification?.acceptanceId ?? null,
    reportedModel: qualification?.report?.reportedModel ?? null,
    turnsStarted: qualification?.report?.turnsStarted ?? null,
    observations: (qualification?.report?.observations ?? []).map((o) => ({
      capability: o.capability,
      passed: o.passed,
      detail: String(o.detail ?? "").slice(0, 600),
    })),
    error: qualification?.report?.error ?? null,
  };
  log(
    "claude",
    `qualification ${qualification?.acceptanceId ? "recorded" : "not recorded"}: ${report.claudeQualification.observations.map((o) => `${o.capability}=${o.passed ? "pass" : "fail"}`).join(" ")}`,
  );
  await save();

  // 4 and 5. Teams across engines, with agent jobs on.
  await command({ type: "agent-jobs-set", enabled: true });
  const routeId = (await state()).proxy.routes.find(
    (r) => r.alias === "chatgpt/live",
  )?.id;
  const nativePin = (memberId) => ({
    memberId,
    required: true,
    pin: { provider: "native", routeId, model: upstreamModel },
    fallbacks: [],
    preferences: { providers: [], models: [] },
    source: { kind: "ui", reference: null, provenance: "explicit" },
  });
  const claudePin = (memberId) => ({
    memberId,
    required: true,
    pin: { provider: "claude", model: options.claudeModel },
    fallbacks: [],
    preferences: { providers: [], models: [] },
    source: { kind: "ui", reference: null, provenance: "explicit" },
  });
  const group = (roleId, members) =>
    command({
      type: "orchestration-group-set",
      projectId,
      goalId: null,
      level: "project-role",
      taskKey: null,
      mode: "replace",
      roleId,
      settings: { form: "exact", members },
      commandId: `live-${roleId}-${Date.now()}`,
    });
  const team = async (label, roles) => {
    for (const [roleId, members] of Object.entries(roles))
      await group(roleId, members);
    const conversation = await command({
      type: "orchestration-conversation-create",
      projectId,
      title: label,
      commandId: `live-conv-${label}-${Date.now()}`,
    });
    const posted = await command({
      type: "orchestration-message",
      conversationId: conversation.id,
      text:
        "Change value.ts so that the exported value is 2. While you plan, use the start_agent_job tool once to ask a researcher (kind information, role researcher) to report in one sentence what README.md says about value.ts; then propose your plan as usual.",
      goalId: null,
      routing: "auto",
      kind: "code",
      commandId: `live-msg-${label}-${Date.now()}`,
    });
    const goalId = posted.goal.id;
    const deadline = Date.now() + options.goalMinutes * 60_000;
    let last = "";
    let view = null;
    const transitions = [];
    for (;;) {
      const all = await command({ type: "orchestration-query", projectId });
      view = all.goals.find((g) => g.goal.id === goalId);
      const now = `${view.goal.state} | ${view.goal.detail}`.slice(0, 300);
      if (now !== last) {
        transitions.push({ at: new Date().toISOString(), state: now });
        log(label, now.slice(0, 200));
        last = now;
      }
      if (
        ["awaiting-acceptance", "checking", "blocked", "stopped", "completed"].includes(
          view.goal.state,
        ) ||
        Date.now() > deadline
      )
        break;
      await sleep(5000);
    }
    const record = {
      label,
      goalState: view.goal.state,
      detail: String(view.goal.detail ?? "").slice(0, 600),
      timedOut: Date.now() > deadline,
      rounds: view.rounds.map((r) => ({
        role: r.roleId,
        kind: r.kind,
        taskKey: r.taskKey,
        stage: r.stage,
        detail: String(r.detail ?? "").slice(0, 300),
        members: r.members.map((m) => ({
          memberId: m.memberId,
          engine: m.engine ?? null,
          state: m.state,
          requestedModel: m.requestedModel,
          effectiveModel: m.effectiveModel,
          requestedFunding: m.requestedFunding ?? null,
          funding: m.funding
            ? {
                observed: m.funding.observed,
                state: m.funding.state,
                source: m.funding.source,
                detail: String(m.funding.detail ?? "").slice(0, 300),
              }
            : null,
          detail: String(m.detail ?? "").slice(0, 300),
        })),
      })),
      agentJobs: (view.agentJobs ?? []).map((j) => ({
        title: j.title,
        kind: j.kind,
        roleId: j.roleId,
        state: j.state,
        parentMemberId: j.parentMemberId,
        detail: String(j.detail ?? "").slice(0, 300),
      })),
      transitions,
    };
    report.teams.push(record);
    await shot(`team-${label}`);
    await save();
    return record;
  };
  await team("gpt-coordinates-claude", {
    coordinator: [nativePin("gpt-coordinator")],
    implementer: [claudePin("claude-implementer")],
    reviewer: [nativePin("gpt-reviewer")],
    researcher: [claudePin("claude-researcher")],
  });
  if (!options.skipTeamB)
    await team("claude-coordinates-gpt", {
      coordinator: [claudePin("claude-coordinator")],
      implementer: [nativePin("gpt-implementer")],
      reviewer: [claudePin("claude-reviewer")],
      researcher: [nativePin("gpt-researcher")],
    });
  report.result = "completed";
} catch (error) {
  report.failure = String(error?.stack ?? error).slice(0, 4000);
  console.error(report.failure);
  await shot("failure");
} finally {
  report.dialogs = await app
    .evaluate(() => globalThis.__live?.dialogs ?? [])
    .catch(() => []);
  await save();
  await app.close().catch(() => {});
  console.log(`Report: ${path.join(output, "report.json")}`);
}
