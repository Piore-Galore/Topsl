import { _electron as electron, expect } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Live Recursive Looping with real runtimes (docs/Recursive_Looping.md, RL-7).
// Unlike the automated suites, this sends real model turns through the
// selected Codex executable and its native ChatGPT sign-in, so it counts
// against that account's usage. Topsl runs from this checkout (after
// `npm run build`) with a disposable topsl-test-* profile, so the user's own
// Topsl profile is not opened. Only the native dialogs this procedure expects
// are approved; every dialog is recorded.
//
// Run A is a Goal loop with every role on Auto: Codex is qualified (up to 3
// turns), then the loop runs under a member-turn allowance and its accepted
// checkpoint is published to the scratch project. Run B pins a Claude reviewer:
// Claude's managed structured route is gated, so the run must wait visibly on
// the pin and never substitute another model. Claude Code is registered and
// trusted but never connected for structured turns.
const usage =
  "Usage: node scripts/live-loop.mjs --codex /absolute/path/to/codex [--claude /absolute/path/to/claude] [--max-turns 30] [--no-pin-run] [--keep-profile] [--output directory]";
const options = {
  codex: null,
  claude: null,
  maxTurns: 30,
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
  if (a === "--codex") options.codex = value();
  else if (a === "--claude") options.claude = value();
  else if (a === "--max-turns") options.maxTurns = Number(value());
  else if (a === "--keep-profile") options.keepProfile = true;
  else if (a === "--no-pin-run") options.noPinRun = true;
  else if (a === "--output") options.output = value();
  else throw new Error(usage);
}
if (
  !options.codex ||
  !path.isAbsolute(options.codex) ||
  (options.claude && !path.isAbsolute(options.claude)) ||
  !(options.maxTurns > 4)
)
  throw new Error(usage);
if (process.platform === "win32")
  throw new Error("The live loop runs on macOS and Linux only.");
await stat("dist/main.cjs").catch(() => {
  throw new Error("Run `npm run build` in this checkout first.");
});

const home = os.homedir();
const tilde = (v) =>
  typeof v === "string" && v.startsWith(home + path.sep)
    ? `~${v.slice(home.length)}`
    : v;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitIn = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
// The same names as billingConflicts in packages/platform/system.ts.
const billing =
  /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/;
const caches =
  process.platform === "darwin"
    ? path.join(home, "Library", "Caches")
    : path.join(home, ".cache");
await mkdir(caches, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-live-loop-"));
// Outside the temporary folders, which Codex's workspace-write sandbox leaves writable.
const projectFolder = await mkdtemp(path.join(caches, "topsl-live-loop-"));
const qualificationFolder = await mkdtemp(path.join(caches, "topsl-qualify-"));
const project = path.join(projectFolder, "live-loop-project");
await mkdir(project);
await writeFile(path.join(project, "value.ts"), "export const value = 1;\n");
await writeFile(
  path.join(project, "README.md"),
  "# Live loop project\n\n`value.ts` exports one number.\n",
);
gitIn(project, "init", "-q");
gitIn(project, "add", ".");
gitIn(
  project,
  "-c",
  "user.email=live@example.invalid",
  "-c",
  "user.name=Live loop",
  "commit",
  "-qm",
  "base",
);
const canonicalProject = await realpath(project);
const cleanup = () => {
  if (options.keepProfile) return;
  for (const folder of [profile, projectFolder, qualificationFolder])
    rmSync(folder, { recursive: true, force: true });
};
process.on("exit", cleanup);

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
      "live-loop",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
);
await mkdir(output, { recursive: true });

const report = {
  schemaVersion: 1,
  kind: "topsl-live-loop",
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
  executables: {},
  dialogs: [],
  qualification: null,
  routes: null,
  runs: [],
  failure: null,
  result: "failed",
  profile: tilde(profile),
  projectFolder: tilde(projectFolder),
};

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
try {
  await expect(page.getByRole("contentinfo")).toContainText("Ready", {
    timeout: 60000,
  });
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
        dialogs.push({
          dialog: title,
          answer: selected ? "selected" : "Cancel",
        });
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
            ? policy.runtimeKind
            : message === "Trust this project?" &&
                detail.startsWith(`${policy.project}\n`)
              ? "Trust project"
              : message === "Allow this native executable?" &&
                  detail.startsWith(`${policy.executableRealPath}\n`)
                ? "Trust executable"
                : message === "Connect the experimental Codex integration?" &&
                    detail.includes(`\n${policy.executableRealPath}\n`)
                  ? "Connect"
                  : message ===
                        "Qualify this Codex runtime with live model turns?" &&
                      policy.model &&
                      detail.includes(`\nModel: ${policy.model}`)
                    ? "Run qualification"
                    : message ===
                        "Turn on auto-accept for work inside the sandbox?"
                      ? buttons[1]
                      : message === "Start this Goal loop? (Experimental)"
                        ? "Start loop"
                        : message ===
                              "Publish the loop's accepted checkpoint to the project folder?" &&
                            detail.includes(policy.project)
                          ? "Publish to folder"
                          : null;
        const response = expected ? Math.max(0, buttons.indexOf(expected)) : 0;
        dialogs.push({ dialog: message, answer: buttons[response] ?? null });
        return { response, checkboxChecked: false };
      };
    },
    {
      project,
      executable: null,
      executableRealPath: null,
      runtimeKind: null,
      model: null,
    },
  );
  const policy = (value) =>
    app.evaluate((_e, v) => Object.assign(globalThis.__live.policy, v), value);
  const locate = async (provider, executable) => {
    await policy({
      executable,
      executableRealPath: await realpath(executable),
      runtimeKind: provider === "codex" ? "Codex CLI" : "Claude Code",
    });
    const installation = await command({ type: "select-runtime" });
    if (!installation?.appId?.includes(provider))
      throw new Error(`Topsl did not record the ${provider} executable.`);
    await expect
      .poll(
        async () =>
          (await command({ type: "state" })).installations.some(
            (i) => i.id === installation.id,
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    const trusted = await command({
      type: "trust-installation",
      id: installation.id,
    });
    if (!trusted?.trusted)
      throw new Error(`Topsl did not trust the ${provider} executable.`);
    report.executables[provider] = {
      path: tilde(trusted.path),
      version: trusted.version,
      owner: trusted.owner,
    };
    return trusted;
  };

  // The scratch project, trusted as a user would.
  await command({ type: "project-add" });
  let projectId = null;
  await expect
    .poll(
      async () =>
        (projectId =
          (await command({ type: "state" })).projects.find(
            (p) => p.realPath === canonicalProject || p.path === project,
          )?.id ?? null),
      { timeout: 30000 },
    )
    .not.toBeNull();

  // Codex: located, trusted, connected and qualified (up to 3 model turns).
  const codex = await locate("codex", options.codex);
  await command({ type: "runtime-connect", id: codex.id });
  const inspected = await command({ type: "runtime-models", id: codex.id });
  const models = inspected?.models ?? [];
  const model = (models.find((m) => m.isDefault) ?? models[0])?.model;
  if (!model) throw new Error("Codex reported no models.");
  await policy({ model });
  const qualification = await command({
    type: "runtime-qualify",
    id: codex.id,
    model,
  });
  report.qualification = {
    model,
    result: qualification?.result ?? qualification?.status ?? null,
    passed: qualification?.passed ?? null,
    summary: JSON.stringify(qualification ?? null).slice(0, 4000),
  };
  // Claude Code: located and trusted only; its structured route stays gated.
  if (options.claude) await locate("claude", options.claude);
  // Unattended edit turns ask nothing inside Codex's workspace sandbox.
  await command({ type: "auto-accept-set", level: "sandboxed" });
  const routes = (await command({ type: "orchestration-query", projectId }))
    .routes;
  report.routes = routes.map((r) => ({
    provider: r.provider,
    route: r.route,
    catalogFresh: r.catalog.fresh,
    models: r.models.map((m) => m.model),
    ready: Object.fromEntries(
      Object.entries(r.purposes).map(([p, v]) => [p, v.ready]),
    ),
    blockers: [
      ...new Set(Object.values(r.purposes).flatMap((v) => v.blockers)),
    ].slice(0, 6),
  }));
  await command({ type: "loop-feature-set", enabled: true });

  const runLoop = async (label, input, until, timeoutMs) => {
    const created = await command({
      type: "loop-create",
      projectId,
      conversationId: null,
      commandId: `live-${label}-${Date.now()}-create`,
      ...input,
    });
    const runId = created.run.id;
    await command({
      type: "loop-start",
      runId,
      commandId: `live-${label}-${Date.now()}-start`,
    });
    const transitions = [];
    let last = "";
    const deadline = Date.now() + timeoutMs;
    let view = null;
    for (;;) {
      view = await command({ type: "loop-inspect", runId });
      const now = `${view.run.state} | ${view.current ? `#${view.current.iteration.number} ${view.current.iteration.state}` : "-"} | ${view.run.detail}`;
      if (now !== last) {
        transitions.push({
          at: new Date().toISOString(),
          state: now.slice(0, 600),
        });
        last = now;
        console.log(`[${label}] ${now.slice(0, 200)}`);
      }
      if (until(view) || Date.now() > deadline) break;
      await sleep(5000);
    }
    const record = {
      label,
      runId,
      mode: view.run.mode,
      finalState: view.run.state,
      detail: view.run.detail,
      waitReason: view.run.waitReason,
      timedOut: !until(view),
      checkpoint: view.checkpoint
        ? {
            sequence: view.checkpoint.sequence,
            changed: view.checkpoint.changedSinceBase,
          }
        : null,
      goals: view.goals.map((g) => ({
        text: g.text,
        status: g.status,
        criteria: g.criteria.map((c) => `${c.text} [${c.provenance}]`),
        assessment: g.assessment?.detail ?? null,
      })),
      iterations: view.iterations.map((i) => ({
        number: i.number,
        state: i.state,
        memberTurns: i.memberTurns,
        repairs: i.repairs,
        failure: i.failure,
        detail: i.detail,
      })),
      organization: view.organization.map((r) => ({
        roleId: r.roleId,
        active: r.active,
        functions: r.functions,
        members: r.members.map(
          (m) =>
            `${m.memberId}=${m.provider ?? "?"}/${m.model ?? "unresolved"} (${m.status})`,
        ),
      })),
      adaptations: view.adaptations.map((a) => ({
        kind: a.kind,
        actor: a.actor,
        reason: a.reason,
        rejections: a.rejections,
      })),
      rounds: (view.current?.rounds ?? []).map((r) => ({
        stage: r.stage,
        state: r.state,
        detail: r.detail,
        members: r.members.map((m) => `${m.memberId} ${m.model} ${m.state}`),
      })),
      usage: view.usage,
      transitions,
    };
    await shot(`run-${label}`);
    return { runId, view, record };
  };

  // Run A: Goal loop, everything Auto.
  const a = await runLoop(
    "a-goal",
    {
      mode: "goal",
      goals: [
        {
          text: "Change value.ts so that it exports value = 2",
          criteria: [
            {
              text: "value.ts exports `value = 2`",
              verification: { kind: "inspection" },
            },
          ],
        },
      ],
      policy: {
        scheduling: { reserveForDirectWork: 0 },
        allowances: { runMemberTurns: options.maxTurns, rolling: null },
        iteration: {
          maxTurns: Math.min(25, options.maxTurns),
          maxDelegatedTasks: 3,
          maxRepairRounds: 1,
          maxApproachesPerTarget: 2,
        },
      },
    },
    (v) =>
      ["completed", "waiting", "stopped", "monitoring"].includes(v.run.state),
    35 * 60_000,
  );
  if (a.view.run.state === "completed") {
    await command({
      type: "loop-publication-apply",
      runId: a.runId,
      commandId: `live-a-${Date.now()}-publish`,
    });
    a.record.published = (
      await readFile(path.join(project, "value.ts"), "utf8")
    ).trim();
    a.record.folderStatus = gitIn(project, "status", "--porcelain");
  } else
    await command({
      type: "loop-control",
      runId: a.runId,
      action: "stop",
      commandId: `live-a-${Date.now()}-stop`,
    }).catch(() => {});
  report.runs.push(a.record);

  // Run B: a Claude reviewer pinned. The pin must wait visibly, never be substituted.
  if (options.claude && !options.noPinRun) {
    const b = await runLoop(
      "b-claude-pin",
      {
        mode: "goal",
        text: "Add a comment line at the top of README.md. Include Claude among the reviewers.",
        policy: {
          scheduling: { reserveForDirectWork: 0 },
          allowances: { runMemberTurns: 8, rolling: null },
        },
      },
      (v) => ["completed", "waiting", "stopped"].includes(v.run.state),
      15 * 60_000,
    );
    await command({
      type: "loop-control",
      runId: b.runId,
      action: "stop",
      commandId: `live-b-${Date.now()}-stop`,
    }).catch(() => {});
    report.runs.push(b.record);
  }
  report.result = "completed";
} catch (error) {
  report.failure = String(error?.stack ?? error).slice(0, 4000);
  await shot("failure");
  console.error(error);
  process.exitCode = 1;
} finally {
  report.dialogs = await app
    .evaluate(() => globalThis.__live?.dialogs ?? [])
    .catch(() => []);
  await app.close().catch(() => {});
  // What each loop and child member returned, read from the closed profile.
  try {
    const electronPath = (await import("electron")).default;
    Object.assign(
      report,
      JSON.parse(
        execFileSync(electronPath, ["scripts/live-loop-extract.cjs", profile], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
        }),
      ),
    );
  } catch (error) {
    report.extractionError = String(error?.message ?? error).slice(0, 1000);
  }
  // A run that did not complete keeps its profile for diagnosis.
  if (
    report.result !== "completed" ||
    report.runs.some(
      (r) => r.label === "a-goal" && r.finalState !== "completed",
    )
  )
    options.keepProfile = true;
  report.profileDeleted = !options.keepProfile;
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Report: ${path.join(output, "report.json")}`);
}
