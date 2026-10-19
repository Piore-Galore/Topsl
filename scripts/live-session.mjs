import { _electron as electron, expect } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createDemoFixture } from "./round2-demo-fixture.mjs";
import { navigate } from "./desktop-navigation.mjs";

// Live acceptance of provider sessions inside Topsl: Claude Code in its native
// terminal, Codex through the structured chat or in its native terminal, or
// both, with Codex continuing Claude Code's imported conversation through a
// reviewed context handoff. A terminal opens in the mode --mode chooses from
// Topsl's Terminal mode menu, never a bypass mode, and a Codex chat uses the
// preset --preset chooses.
// Unlike the automated suites, this sends one real prompt per provider through
// the selected executable and the native sign-in on this machine, so it counts
// toward that account's usage. Topsl runs from this checkout (after
// `npm run build`) with a new disposable topsl-test-* profile, so the user's
// own Topsl profile is not opened. Only the native dialogs this procedure
// expects are approved. The provider keeps the session in its own history, as
// it does for any native session. With --qualify, Codex instead goes through
// Topsl's runtime qualification from the guided setup, with Codex in both
// roles: up to three model turns, approved once and never retried. With
// --workflow and a team, Build and review runs on a small seeded project: one
// build and one review, with no repair. A team with Codex starts with that
// qualification. A Claude role is a Claude Code step on the workflow's card,
// which the script runs as the owner would: it opens Claude Code, pastes the
// instructions Topsl copied once, exits Claude Code after Claude's reply and
// hands the reply back from the session's transcript.

const usage =
  "Usage: node scripts/live-session.mjs [--claude /absolute/path/to/claude] [--codex /absolute/path/to/codex] [--terminal] [--mode id] [--preset id] [--qualify] [--workflow codex-codex|claude-codex|codex-claude|claude-claude] [--model id] [--output directory] [--keep-profile]\nGive --claude, --codex, or both for a handoff from Claude Code to Codex. --terminal with --codex alone opens Codex in Topsl's native terminal instead of a chat. --mode picks the terminal's mode and --preset the Codex chat's preset. --qualify with --codex alone runs Topsl's runtime qualification instead of a prompt. --workflow runs one build and one review of a seeded project with that team, builder first: give --codex for codex-codex, --claude for claude-claude, and both for the others. A team with Codex starts with the qualification.";
// The teams --workflow runs, builder first, with the most each run may start
// as the Claude workflows plan's run table gives it: Codex turns, counting the
// qualification's, and Claude Code sessions, one for each Claude step.
const workflowTeams = {
  "codex-codex": {
    builder: "codex",
    reviewer: "codex",
    codexTurns: 5,
    claudeSessions: 0,
  },
  "claude-codex": {
    builder: "claude",
    reviewer: "codex",
    codexTurns: 4,
    claudeSessions: 1,
  },
  "codex-claude": {
    builder: "codex",
    reviewer: "claude",
    codexTurns: 4,
    claudeSessions: 1,
  },
  "claude-claude": {
    builder: "claude",
    reviewer: "claude",
    codexTurns: 0,
    claudeSessions: 2,
  },
};
const options = {
  executables: {},
  terminal: false,
  mode: null,
  preset: null,
  qualify: false,
  workflow: null,
  model: null,
  output: null,
  keepProfile: false,
};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  // The value that follows an option which takes one.
  const value = () => {
    const next = process.argv[++index];
    if (!next || next.startsWith("--")) throw new Error(usage);
    return next;
  };
  if (
    ["--claude", "--codex"].includes(argument) &&
    !options.executables[argument.slice(2)]
  )
    options.executables[argument.slice(2)] = value();
  else if (argument === "--terminal") options.terminal = true;
  else if (argument === "--mode") options.mode = value();
  else if (argument === "--preset") options.preset = value();
  else if (argument === "--qualify") options.qualify = true;
  else if (argument === "--workflow") options.workflow = value();
  else if (argument === "--model") options.model = value();
  else if (argument === "--output") options.output = value();
  else if (argument === "--keep-profile") options.keepProfile = true;
  else throw new Error(usage);
}
// Claude Code runs first, so that Codex can continue its conversation.
const providers = ["claude", "codex"].filter((p) => options.executables[p]);
const both = providers.length === 2;
const team =
  options.workflow && Object.hasOwn(workflowTeams, options.workflow)
    ? workflowTeams[options.workflow]
    : null;
// The providers the team needs, in the order of `providers`.
const teamProviders = team
  ? ["claude", "codex"].filter((p) => [team.builder, team.reviewer].includes(p))
  : [];
const codexChatRun =
  !!options.executables.codex &&
  !options.terminal &&
  !options.qualify &&
  !options.workflow;
// A workflow run with Codex starts with the runtime qualification.
const qualifies = options.qualify || teamProviders.includes("codex");
if (
  !providers.length ||
  providers.some((p) => !path.isAbsolute(options.executables[p])) ||
  (options.model && !options.executables.codex) ||
  (options.model && options.terminal) ||
  (options.qualify && providers.join() !== "codex") ||
  (options.workflow &&
    (!team || providers.join() !== teamProviders.join() || options.qualify)) ||
  (options.terminal && (providers.join() !== "codex" || qualifies)) ||
  (options.mode &&
    (!options.executables.claude || options.workflow) &&
    !options.terminal) ||
  (options.preset && !codexChatRun)
)
  throw new Error(usage);
// Only for checking a workflow run against the repository's stand-ins: the
// script then also plays the owner, denying each command Codex asks to run
// and allowing each file change on the workflow's card, and answering Yes to
// each permission prompt in a Claude Code step.
const ownerStandIn = process.env.TOPSL_LIVE_OWNER_STAND_IN === "1";
if (ownerStandIn && !options.workflow) throw new Error(usage);
if (qualifies && process.platform === "win32")
  throw new Error(
    "The runtime qualification uses POSIX shell probes and runs on macOS and Linux only.",
  );
if (options.workflow && process.platform === "win32")
  throw new Error("The workflow runs on macOS and Linux only.");
try {
  await stat("dist/main.cjs");
} catch {
  throw new Error("Run `npm run build` in this checkout first.");
}

const home = os.homedir();
const tilde = (value) =>
  typeof value === "string" && value.startsWith(home + path.sep)
    ? `~${value.slice(home.length)}`
    : value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Terminal output without escape sequences or control characters. */
const plain = (text) =>
  text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
async function until(label, timeoutMs, check, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}.`);
    await sleep(intervalMs);
  }
}
const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

// Same names as billingConflicts in packages/platform/system.ts. Topsl refuses
// to start a session while any is set, as a launch from the Dock would not have
// them. Only the names are reported.
const billing =
  /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/;
const caches =
  process.platform === "darwin"
    ? path.join(home, "Library", "Caches")
    : path.join(home, ".cache");
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-live-"));
// A workflow builds and reviews a small seeded project. Like a user's project,
// it sits outside the temporary folders, which Codex's workspace-write sandbox
// leaves writable: in a new topsl-live-* folder in the user's cache folder,
// which is always deleted afterwards. Other runs use an empty folder in the
// profile.
let projectFolder = null,
  seeded = null;
if (options.workflow) {
  await mkdir(caches, { recursive: true });
  projectFolder = await mkdtemp(path.join(caches, "topsl-live-"));
  process.on("exit", () =>
    rmSync(projectFolder, { recursive: true, force: true }),
  );
  seeded = await createDemoFixture({
    root: path.join(projectFolder, "live-project"),
    live: true,
  });
}
const project = seeded?.root ?? path.join(profile, "live-project");
if (!seeded) await mkdir(project);
const canonicalProject = await realpath(project);
const environment = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const removedEnvironment = Object.keys(environment).filter((name) =>
  billing.test(name),
);
for (const name of removedEnvironment) delete environment[name];
// Codex's workspace-write sandbox leaves the temporary folders writable, so a
// qualification there could not judge its outside write. It runs in a new
// topsl-qualify-* folder in the user's cache folder, which is always deleted
// afterwards.
let qualificationFolder = null;
if (qualifies) {
  await mkdir(caches, { recursive: true });
  qualificationFolder = await mkdtemp(path.join(caches, "topsl-qualify-"));
  process.on("exit", () =>
    rmSync(qualificationFolder, { recursive: true, force: true }),
  );
  environment.TOPSL_TEST_QUALIFICATION_DIR = qualificationFolder;
}
const output = path.resolve(
  options.output ??
    path.join(
      "test-results",
      "live-session",
      `${options.workflow ? `workflow-${options.workflow}` : options.qualify ? "qualify" : both ? "both" : options.terminal ? "codex-terminal" : providers[0]}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
);
await mkdir(output, { recursive: true });

const routes = {
  claude: "native-terminal",
  codex: options.terminal ? "native-terminal" : "structured-chat",
};
/** What one provider's part of the run records. */
const newStep = (provider) => ({
  executable: { path: tilde(options.executables[provider]) },
  prompt: null,
  expectedReply: null,
  replyObserved: false,
  replySeconds: null,
  session: {},
});
// A single-provider report keeps its step at the top level. A run with both
// keeps one step per provider, in the order they ran, and the conversation
// they share. A qualification keeps what Topsl recorded and the readiness it
// gives each role, and a workflow run adds what its build and review did:
// `modelTurns` counts Codex's turns and `claudeCodeSessions` the Claude Code
// sessions its steps opened.
const report = {
  schemaVersion: 1,
  kind: "topsl-live-session",
  provider: both ? "both" : providers[0],
  route: options.workflow
    ? "build-and-review"
    : options.qualify
      ? "runtime-qualification"
      : both
        ? "handoff"
        : routes[providers[0]],
  ...(options.workflow ? { team: options.workflow } : {}),
  observedAt: new Date().toISOString(),
  host: `${os.platform()}/${os.arch()} ${os.release()}`,
  topsl: {
    version: JSON.parse(await readFile("package.json", "utf8")).version,
    commit: git("rev-parse", "HEAD"),
    trackedChanges:
      (git("status", "--porcelain", "--untracked-files=no") ?? "") !== "",
  },
  removedEnvironment,
  dialogs: [],
  modelTurns: 0,
  ...(options.qualify || options.workflow
    ? {
        ...(qualifies
          ? {
              executable: { path: tilde(options.executables.codex) },
              session: {},
              qualification: null,
            }
          : {}),
        // Claude Code's executable, and the transcript read the run turns on
        // in its profile.
        ...(teamProviders.includes("claude")
          ? {
              claudeCode: {
                executable: { path: tilde(options.executables.claude) },
                transcriptRead: null,
              },
            }
          : {}),
        readiness: null,
        ...(options.workflow ? { workflow: null, claudeCodeSessions: 0 } : {}),
      }
    : both
      ? { steps: {}, conversation: null }
      : newStep(providers[0])),
  screenshots: [],
  profile: tilde(profile),
  profileDeleted: false,
  ...(qualifies
    ? {
        qualificationFolder: tilde(qualificationFolder),
        qualificationFolderDeleted: false,
      }
    : {}),
  ...(projectFolder
    ? { projectFolder: tilde(projectFolder), projectFolderDeleted: false }
    : {}),
  result: "failed",
  failure: null,
};

const app = await electron.launch({
  args: [
    ...(process.platform === "linux" &&
    (process.env.CI || process.getuid?.() === 0)
      ? ["--no-sandbox"]
      : []),
    ".",
  ],
  env: environment,
  timeout: 90000,
});
const page = await app.firstWindow();
const screenshot = async (name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(tilde(file));
};
const command = (value) =>
  page.evaluate((value) => window.topsl.command(value), value);
/** Fails with the first operation error Topsl shows, if any. */
async function checkShownErrors() {
  const alerts = page.locator("main.content p[role=alert]");
  if (await alerts.count())
    throw new Error(
      `Topsl reported: ${(await alerts.first().innerText()).replace(/\s*Dismiss$/, "")}`,
    );
}
async function appear(label, locator, timeoutMs = 30000) {
  await until(label, timeoutMs, async () => {
    await checkShownErrors();
    return locator.isVisible();
  });
}

/**
 * A sum the provider must work out, which no screen text already contains.
 * After a handoff, one term is the number Claude Code replied with, which only
 * the handed-off context gives.
 */
function question(shown, step, handedOff = null) {
  let first, second, expected;
  do {
    first = randomInt(1000, 5000);
    second = randomInt(1000, 5000);
    expected = String((handedOff ?? first) + second);
  } while (shown.includes(expected));
  step.prompt =
    handedOff === null
      ? `What is ${first} + ${second}? Reply with only the number.`
      : `Add ${second} to the number Claude Code replied with in the handoff above. Reply with only the number.`;
  step.expectedReply = expected;
  return expected;
}
/** Whether the text has the number on its own, not inside a longer number. */
const hasNumber = (text, number) =>
  new RegExp(`(?<![0-9])${number}(?![0-9])`).test(text);

const terminal = page.getByRole("region", { name: "Native terminal" });
const terminalOutput = () => page.evaluate(() => window.__liveTerminal.output);
/** The text Topsl's terminal shows, which can differ from the raw output. */
const terminalScreen = () =>
  terminal
    .locator(".xterm-rows")
    .innerText()
    .then((text) => text.replace(/\u00a0/g, " "))
    .catch(() => "");
const exitPattern = /\[Native session exited: (-?\d+)\]/;
let terminalOpen = false;
/**
 * Gives Topsl's terminal the keyboard focus. A click would also reach a
 * terminal application that reads the mouse, and could change its selection.
 */
const focusTerminal = () =>
  terminal.locator("textarea.xterm-helper-textarea").focus();
const press = async (key) => {
  await focusTerminal();
  await page.keyboard.press(key);
};

/** The run Topsl records for the project's native terminal session. */
const terminalRun = (scope) =>
  scope.runs.find((r) => r.conversationId.startsWith("terminal:"));
/** Keeps the mode and arguments Topsl recorded on the terminal's run. */
function recordMode(session, run) {
  session.mode.recorded = run?.permissionMode ?? null;
  session.mode.args = run?.permissionArgs ?? null;
}

/**
 * Chooses a mode in Topsl's **Terminal mode** menu, the one --mode names or
 * Provider default, and opens the native terminal in it. Bypass modes sit
 * under Advanced, and the script never chooses one.
 */
async function openTerminal(projectId, session) {
  const menu = page.getByRole("combobox", {
    name: "Terminal mode",
    exact: true,
  });
  await appear("the Terminal mode menu", menu);
  const offered = await menu
    .locator(":scope > option")
    .evaluateAll((list) => list.map((option) => option.value));
  const mode = options.mode ?? "provider-default";
  if (!offered.includes(mode))
    throw new Error(
      `Topsl's Terminal mode menu offers ${offered.join(", ")} outside Advanced, not ${mode}.`,
    );
  await menu.selectOption(mode);
  session.mode = { chosen: mode, recorded: null, args: null, shown: null };
  await page.evaluate(() => {
    window.__liveTerminal = { output: "" };
    window.topsl.subscribe((event) => {
      if (event.type === "terminal")
        window.__liveTerminal.output += event.data.data;
    });
  });
  await page
    .getByRole("button", { name: "Native terminal", exact: true })
    .click();
  await appear("the native terminal", terminal);
  terminalOpen = true;
  // Kept now as well, in case the run stops before the session ends.
  recordMode(
    session,
    terminalRun(await command({ type: "scope-snapshot", projectId })),
  );
}

/** Waits until the terminal's output has not changed for 3 seconds. */
async function settle() {
  let length = -1;
  await until(
    "the reply to finish",
    60000,
    async () => {
      const current = (await terminalOutput()).length,
        settled = current === length;
      length = current;
      return settled;
    },
    3000,
  ).catch(() => {});
}

/**
 * Ends the terminal session with the provider's own exit, then if needed
 * Ctrl+C twice and **Close session**, and records how it ended and the run
 * Topsl recorded, with the mode it passed.
 */
async function closeTerminal(projectId, session, exit) {
  session.exit = { method: exit.method, code: null };
  await exit.keys();
  const exited = (timeoutMs) =>
    until("the native session to exit", timeoutMs, async () =>
      exitPattern.exec(plain(await terminalOutput())),
    ).catch(() => null);
  let ended = await exited(30000);
  if (!ended && exit.method !== "Ctrl+C twice") {
    session.exit.method = "Ctrl+C twice";
    await press("Control+C");
    await sleep(500);
    await press("Control+C");
    ended = await exited(20000);
  }
  if (!ended) {
    session.exit.method = "Close session";
    await page
      .getByRole("button", { name: "Close session", exact: true })
      .click();
    ended = await exited(20000);
  }
  session.exit.code = ended ? Number(ended[1]) : null;
  terminalOpen = !ended;
  const snapshot = () => command({ type: "scope-snapshot", projectId });
  const scope = await until(
    "Topsl to record the session's end",
    10000,
    async () => {
      const current = await snapshot(),
        status = terminalRun(current)?.status;
      return status && !["starting", "running"].includes(status)
        ? current
        : null;
    },
  ).catch(snapshot);
  const run = terminalRun(scope);
  let processGone = null;
  if (run?.nativePid)
    try {
      process.kill(run.nativePid, 0);
      processGone = false;
    } catch (error) {
      processGone = error.code === "ESRCH";
    }
  session.run = {
    status: run?.status ?? null,
    processGone,
    openTerminals: scope.terminals.length,
  };
  recordMode(session, run);
}

/** Fails unless Topsl recorded the chosen mode and the session ended cleanly. */
function checkTerminalEnd(session) {
  if (session.mode.recorded !== session.mode.chosen)
    throw new Error(
      `Topsl recorded the terminal mode ${session.mode.recorded ?? "nothing"}, not ${session.mode.chosen}.`,
    );
  if (session.run.status !== "completed" || session.run.openTerminals)
    throw new Error(
      `The native session ended as ${session.run.status ?? "unknown"} with ${session.run.openTerminals} terminal(s) open.`,
    );
}

// Claude Code asks once whether to trust a new folder. A sign-in screen stops
// the procedure before any prompt is sent. Once escape sequences are removed,
// Claude Code's words can run together in its raw output (it can move the
// cursor over blank cells instead of writing spaces), so its prompts are
// matched against the terminal screen as well.
const signIn =
  /select login method|please run \/login|not logged in|invalid api key/i;
const trustPrompt = /trust (the files in )?this folder|do you trust/i;
// The answer the prompt has selected follows its pointer on the screen.
const trustAnswer = /[❯>]\s*(?:\d+\.\s*)?(yes, i trust this folder|no, exit)/i;
// Besides folder trust, Claude Code can ask at startup whether to change its
// default permission mode, as 2.1.300 did in a live run in Plan, or, started
// in bypass permissions, whether to accept that mode. It saves the answer in
// its own settings, so the script answers none of these questions and stops
// before the prompt instead.
const startupQuestions = [
  [
    /your default permission mode\?/i,
    "whether to change its default permission mode",
  ],
  [
    /running in bypass permissions mode/i,
    "whether to accept bypass permissions mode",
  ],
];
// Below the input, Claude Code shows the shortcuts hint or, in place of it,
// the permission mode. Only the screen counts: the raw output still holds
// that line after a question has replaced it.
const inputReady =
  /for shortcuts|accept edits on|plan mode on|auto mode on|bypass permissions on/i;
const shownMode =
  /(plan mode on|accept edits on|auto mode on|bypass permissions on|\? for shortcuts)/i;
// Each choice Claude Code asks for is a list, with the selected answer after
// its pointer and, in most, a number before each answer.
/** The answer on a line of a choice, without its pointer and number. */
const answerText = (line) =>
  line
    .replace(/^\s*[│|]?\s*(?:[❯>]\s*)?(?:\d+\.\s*)?/, "")
    .replace(/\s*[│|]\s*$/, "")
    .trim();

/**
 * Moves the selection of a choice Claude Code shows to the line `wanted`
 * matches, and confirms it only once the screen shows it selected. `pointer`
 * matches the selected line. A choice is drawn below anything else on the
 * screen, so the lowest matching lines count. Returns the answer selected
 * first and the one confirmed.
 */
async function choose(view, label, wanted, pointer) {
  let first = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const lines = (await view.screen()).split("\n"),
      target = lines.findLastIndex((l) => wanted.test(l)),
      selected = lines.findLastIndex((l) => pointer.test(l));
    if (selected >= 0) first ??= answerText(lines[selected]);
    if (target >= 0 && selected === target) {
      await view.press("Enter");
      return { first, chosen: answerText(lines[target]) };
    }
    if (target >= 0 && selected >= 0) {
      await view.press(selected < target ? "ArrowDown" : "ArrowUp");
      await until(
        `Claude Code's ${label} to move its selection`,
        5000,
        async () =>
          (await view.screen())
            .split("\n")
            .findLastIndex((l) => pointer.test(l)) !== selected,
      );
    } else await sleep(500);
  }
  throw new Error(
    `Claude Code's ${label} did not show its answers on the screen.`,
  );
}
// Claude Code 2.1.183 selects "Yes, I trust this folder" first, but 2.1.300
// lists and selects "No, exit" first. The selection is moved to the answer
// that trusts the folder, which is confirmed only once the screen shows it.
const trustFolder = async (view) =>
  (
    await choose(
      view,
      "folder trust prompt",
      /yes, i trust this folder/i,
      trustAnswer,
    )
  ).first;
// While Claude works, Claude Code can stop for an answer: a permission
// prompt, an offer to approve a plan, or a question of Claude's. Each is a
// choice whose answers are numbered, with the selected one after the pointer.
const numberedAnswer = /^\s*[│|]?\s*❯\s*\d+\.\s*\S/;
/** The numbered answer of a choice that starts with `start`. */
const answerNumbered = (start) =>
  new RegExp(String.raw`^\s*[│|]?\s*(?:❯\s*)?\d+\.\s*${start}`, "i");
const keepPlanning = answerNumbered("no, keep planning");
const declinePermission = answerNumbered(String.raw`no\b`);
// Yes alone, not "Yes, and don't ask again …".
const approvePermission = answerNumbered(String.raw`yes[\s│|]*$`);
/**
 * The choice Claude Code shows during a step, if any: an offer to approve a
 * plan, which the script declines with **No, keep planning**, a permission
 * prompt ("Do you want to …?"), which it leaves for the owner, or any other
 * question, which it does not answer.
 */
function claudeChoice(screen) {
  const lines = screen.split("\n"),
    selected = lines.findLastIndex((l) => numberedAnswer.test(l));
  if (selected < 0) return null;
  // The question is the last line above the selected answer that ends with a
  // question mark; the answers follow it.
  const trimmed = lines.map((l) => l.replace(/^[\s│|]+|[\s│|]+$/g, "")),
    asked = trimmed.slice(0, selected).findLastIndex((l) => l.endsWith("?")),
    question = asked >= 0 ? trimmed[asked] : null,
    answers = lines.slice(asked + 1);
  if (answers.some((l) => keepPlanning.test(l)))
    return { kind: "plan", question, answer: keepPlanning };
  if (
    /^do you want to /i.test(question ?? "") &&
    answers.some((l) => declinePermission.test(l))
  )
    return { kind: "permission", question, answer: declinePermission };
  return { kind: "question", question };
}
// Signs that Claude Code waits for an answer, also when the script cannot
// read the choice: its footer, or answers numbered after a pointer.
const choiceSigns =
  /esc to cancel|enter to (confirm|select)|^\s*[│|]?\s*[❯>›]\s*\d+\.\s/im;
/**
 * The screen below the folder trust prompt, which Claude Code can leave on
 * the screen after it was answered; anything it asks next is drawn below.
 * The prompt ends with its answers and, just below them, its footer.
 */
function belowTrust(screen) {
  const lines = screen.split("\n"),
    answers = lines.findLastIndex(
      (l) =>
        trustPrompt.test(l) || /yes, i trust this folder|no, exit/i.test(l),
    ),
    footer = lines.findIndex(
      (l, index) =>
        index > answers && index <= answers + 3 && /enter to confirm/i.test(l),
    );
  return answers < 0
    ? screen
    : lines.slice(Math.max(answers, footer) + 1).join("\n");
}

/**
 * Keeps each native terminal's output by terminal from now on, as a workflow
 * opens a terminal for each Claude Code step.
 */
async function watchTerminals() {
  await page.evaluate(() => {
    window.__liveTerminal = { output: "", byId: {} };
    window.topsl.subscribe((event) => {
      if (event.type !== "terminal") return;
      const { id, data } = event.data;
      window.__liveTerminal.output += data;
      window.__liveTerminal.byId[id] =
        (window.__liveTerminal.byId[id] ?? "") + data;
    });
  });
}
/** The terminal a Claude Code step's panel shows: its output, screen and keys. */
function stepTerminal(panel, id) {
  const region = panel.getByRole("region", {
      name: "Native terminal",
      exact: true,
    }),
    focus = () => region.locator("textarea.xterm-helper-textarea").focus();
  return {
    region,
    output: () =>
      page.evaluate((id) => window.__liveTerminal.byId[id] ?? "", id),
    screen: () =>
      region
        .locator(".xterm-rows")
        .innerText()
        .then((text) => text.replace(/ /g, " "))
        .catch(() => ""),
    focus,
    press: async (key) => {
      await focus();
      await page.keyboard.press(key);
    },
  };
}

/**
 * Claude Code in Topsl's native terminal, then the import of its transcript.
 * Returns the imported conversation and the number Claude Code replied with.
 */
async function claudeTerminal(projectId, step) {
  const session = (step.session = {
    mode: null,
    folderTrust: "not shown",
    folderTrustReadFrom: null,
    folderTrustDefault: null,
    startupQuestion: null,
    apiError: null,
    exit: null,
    run: null,
    transcript: null,
    history: null,
  });
  await openTerminal(projectId, session);
  await until("Claude Code to accept a prompt", 120000, async () => {
    const output = plain(await terminalOutput()),
      screen = await terminalScreen(),
      text = `${output}\n${screen}`;
    if (signIn.test(text))
      throw new Error(
        "Claude Code is not signed in. Sign in with `claude` in a terminal, then run this again.",
      );
    if (exitPattern.test(output))
      throw new Error("Claude Code exited before accepting a prompt.");
    if (session.folderTrust === "not shown" && trustPrompt.test(text)) {
      session.folderTrustReadFrom = trustPrompt.test(output)
        ? "output"
        : "screen";
      session.folderTrustDefault = await trustFolder({
        screen: terminalScreen,
        press,
      });
      session.folderTrust = "accepted";
      return null;
    }
    const asked = startupQuestions.find(([pattern]) => pattern.test(text));
    if (asked) {
      session.startupQuestion = asked[1];
      await screenshot("claude-question");
      throw new Error(
        `Claude Code asked ${asked[1]} before accepting a prompt. The script answers none of Claude Code's startup questions except folder trust, so no prompt was sent.`,
      );
    }
    return inputReady.test(screen);
  });
  // A mode that Claude Code shows below its input has to be the one Topsl
  // passed, or the prompt is not sent.
  session.mode.shown =
    shownMode.exec(await terminalScreen())?.[1].toLowerCase() ?? null;
  await screenshot("claude-ready");
  const expectedShown = {
    plan: "plan mode on",
    "accept-edits": "accept edits on",
    // Accept edits with Claude Code's sandbox turned on.
    sandboxed: "accept edits on",
    auto: "auto mode on",
  }[session.mode.chosen];
  if (expectedShown && session.mode.shown !== expectedShown)
    throw new Error(
      `Claude Code showed ${session.mode.shown ? `"${session.mode.shown}"` : "no permission mode"} below its input instead of "${expectedShown}", so no prompt was sent.`,
    );

  const expected = question(
    plain(await terminalOutput()) + (await terminalScreen()),
    step,
  );
  const before = (await terminalOutput()).length;
  await focusTerminal();
  await page.keyboard.type(step.prompt, { delay: 10 });
  await sleep(500);
  const sentAt = Date.now();
  await page.keyboard.press("Enter");
  report.modelTurns += 1;
  await until("Claude Code's reply", 240000, async () => {
    const output = plain((await terminalOutput()).slice(before)),
      screen = await terminalScreen();
    if (hasNumber(output, expected) || hasNumber(screen, expected)) return true;
    // An API error Claude Code has given up on stays on screen; while it
    // retries one, it says so.
    const apiError = /API Error: (\d{3})/.exec(screen);
    if (apiError && !/Retrying in/i.test(screen)) {
      session.apiError = Number(apiError[1]);
      throw new Error(
        `Claude Code reported API error ${apiError[1]} instead of replying.`,
      );
    }
    if (signIn.test(`${output}\n${screen}`))
      throw new Error("Claude Code asked to sign in instead of replying.");
    if (exitPattern.test(output))
      throw new Error("Claude Code exited instead of replying.");
    return false;
  });
  step.replyObserved = true;
  step.replySeconds = Math.round((Date.now() - sentAt) / 100) / 10;
  // Let the interface settle before the screenshot.
  await settle();
  await screenshot("claude-reply");

  await closeTerminal(projectId, session, {
    method: "/exit",
    keys: async () => {
      await focusTerminal();
      await page.keyboard.type("/exit", { delay: 20 });
      await sleep(500);
      await page.keyboard.press("Enter");
    },
  });

  // Claude Code records each message with its working directory.
  const configDirectory =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const projectsDirectory = path.join(configDirectory, "projects");
  const marker = `"cwd":${JSON.stringify(canonicalProject)}`;
  const candidates = [];
  for (const folder of await readdir(projectsDirectory).catch(() => [])) {
    const directory = path.join(projectsDirectory, folder);
    for (const name of await readdir(directory).catch(() => [])) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(directory, name),
        details = await stat(file);
      if (details.mtimeMs < sentAt - 60000) continue;
      if ((await readFile(file, "utf8")).includes(marker))
        candidates.push({ file, modified: details.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.modified - a.modified);
  const transcript = candidates[0]?.file ?? null;
  session.transcript = {
    found: !!transcript,
    path: tilde(transcript),
    candidates: candidates.length,
  };
  if (!transcript)
    throw new Error(
      `No Claude Code transcript for the disposable folder was found under ${tilde(projectsDirectory)}.`,
    );

  await app.evaluate((_electron, file) => {
    globalThis.__liveSession.policy.transcript = file;
  }, transcript);
  await navigate(page, "History");
  await page
    .getByRole("button", { name: "Import Claude JSONL", exact: true })
    .click();
  await appear(
    "the imported transcript",
    page.getByRole("button", { name: /Imported claude/i }),
  );
  const found = await command({
    type: "history-page",
    projectId,
    query: expected,
  });
  const replies = found.items.filter(
    (m) =>
      m.role === "assistant" &&
      m.provider === "claude" &&
      hasNumber(m.text, expected),
  );
  session.history = {
    matchingMessages: found.items.length,
    claudeReplies: replies.length,
  };
  await page
    .getByRole("textbox", { name: "Search project history" })
    .fill(expected);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".history-result").first()).toContainText(
    expected,
    { timeout: 30000 },
  );
  await screenshot("claude-history");
  if (!replies.length)
    throw new Error(
      "The imported history has no Claude reply with the answer.",
    );
  checkTerminalEnd(session);
  return { conversationId: replies[0].conversationId, reply: Number(expected) };
}

/**
 * Codex in Topsl's native terminal: one prompt, then Ctrl+C twice. The script
 * answers none of Codex's startup questions, such as whether to trust the
 * folder, to update Codex or to switch models, because Codex saves the answer
 * in its own settings or updates itself; it stops before the prompt instead.
 */
async function codexTerminal(projectId, step) {
  const session = (step.session = {
    mode: null,
    startupQuestion: null,
    exit: null,
    run: null,
  });
  await openTerminal(projectId, session);
  const signIn = /sign in with chatgpt|provide your own api key/i;
  // Codex 0.163.0's strings have these questions; each saves its answer.
  const startupQuestions = [
    [/trust this folder\?/i, "whether to trust the folder"],
    [/update now/i, "whether to update Codex"],
    [/just got an upgrade/i, "whether to switch to a new model"],
  ];
  // Codex shows the composer's placeholder, or its hints below the composer,
  // once it accepts a prompt; before that, the placeholder says it is waiting.
  const inputReady = /ask codex to do anything|for shortcuts|context left/i;
  await until("Codex to accept a prompt", 120000, async () => {
    const output = plain(await terminalOutput()),
      screen = await terminalScreen(),
      text = `${output}\n${screen}`;
    if (signIn.test(text))
      throw new Error(
        "Codex is not signed in. Sign in with `codex` in a terminal, then run this again.",
      );
    if (exitPattern.test(output))
      throw new Error("Codex exited before accepting a prompt.");
    const asked = startupQuestions.find(([pattern]) => pattern.test(text));
    if (asked) {
      session.startupQuestion = asked[1];
      await screenshot("codex-terminal-question");
      throw new Error(
        `Codex asked ${asked[1]} before accepting a prompt. The script answers none of Codex's startup questions, so no prompt was sent.`,
      );
    }
    return inputReady.test(screen) && !/waiting for startup/i.test(screen);
  });
  session.mode.shown =
    /\b(read[- ]only|workspace[- ]write|full access)\b/i
      .exec(await terminalScreen())?.[1]
      .toLowerCase() ?? null;
  await screenshot("codex-terminal-ready");

  const expected = question(
    plain(await terminalOutput()) + (await terminalScreen()),
    step,
  );
  const before = (await terminalOutput()).length;
  await focusTerminal();
  await page.keyboard.type(step.prompt, { delay: 10 });
  await sleep(500);
  const sentAt = Date.now();
  await page.keyboard.press("Enter");
  report.modelTurns += 1;
  await until("Codex's reply", 240000, async () => {
    const output = plain((await terminalOutput()).slice(before)),
      screen = await terminalScreen();
    if (hasNumber(output, expected) || hasNumber(screen, expected)) return true;
    if (signIn.test(`${output}\n${screen}`))
      throw new Error("Codex asked to sign in instead of replying.");
    if (exitPattern.test(output))
      throw new Error("Codex exited instead of replying.");
    return false;
  });
  step.replyObserved = true;
  step.replySeconds = Math.round((Date.now() - sentAt) / 100) / 10;
  await settle();
  await screenshot("codex-terminal-reply");

  // Ctrl+C twice quits Codex. Typing a command instead could reach the model
  // as a second prompt if Codex did not know it.
  await closeTerminal(projectId, session, {
    method: "Ctrl+C twice",
    keys: async () => {
      await press("Control+C");
      await sleep(500);
      await press("Control+C");
    },
  });
  checkTerminalEnd(session);
}

/**
 * Codex's **Models & account**: connects the runtime and returns the model to
 * use, the one chosen with --model or the one Codex reports as default.
 */
async function codexConnection(session) {
  await page
    .getByRole("button", { name: "Models & account", exact: true })
    .click();
  const connection = page.getByRole("dialog", { name: "Native connection" });
  await appear("the Codex connection", connection, 60000);
  const connected = JSON.parse(await connection.locator("pre").innerText());
  await connection.getByRole("button", { name: "Close dialog" }).click();
  // Only the account kind and plan are kept, never the sign-in identity.
  session.account = {
    type: connected.account?.type ?? null,
    planType: connected.account?.planType ?? null,
  };
  const models = connected.models ?? [];
  session.modelsReported = models.length;
  const model =
    options.model ??
    (models.find((m) => m.isDefault) ?? models[0])?.model ??
    null;
  if (!model) throw new Error("Codex reported no model to select.");
  if (!models.some((m) => m.model === model))
    throw new Error(`Codex did not report the model ${model}.`);
  session.model = model;
  return model;
}

/**
 * Codex through the structured chat: one prompt in a new chat or, after a
 * handoff, in Claude Code's imported conversation with the reviewed context
 * attached.
 */
async function codexChat(projectId, step, handoff = null) {
  const session = (step.session = {
    account: null,
    model: null,
    modelsReported: null,
    preset: null,
    ...(handoff ? { handoff: null } : {}),
    run: null,
    approvals: [],
    usageRecords: null,
  });
  const model = await codexConnection(session);

  let conversationId = handoff?.conversationId;
  if (handoff) {
    await page
      .getByRole("combobox", { name: "Conversation" })
      .selectOption(conversationId);
    await appear(
      "Claude Code's imported conversation",
      page
        .locator(".conversation-heading")
        .filter({ hasText: "Imported claude" }),
    );
  } else {
    await page.getByRole("button", { name: "+ New chat", exact: true }).click();
    await appear(
      "the new chat",
      page.locator(".conversation-heading").filter({ hasText: "Chat 1" }),
    );
    conversationId = (
      await command({ type: "scope-snapshot", projectId })
    ).conversations.find((c) => c.title === "Chat 1")?.id;
    if (!conversationId) throw new Error("Topsl did not create the chat.");
  }
  const expected = question(
    await page.locator("main").innerText(),
    step,
    handoff?.reply ?? null,
  );
  await page.getByRole("textbox", { name: "Message" }).fill(step.prompt);
  if (handoff) {
    // The context is reviewed in full before it is attached, and it has to
    // carry Claude Code's reply.
    await page
      .getByRole("button", { name: "Prepare handoff", exact: true })
      .click();
    const review = page.getByRole("dialog", { name: "Handoff to codex" });
    await appear("the handoff to review", review);
    const text = await review.locator("pre.snapshot").innerText();
    const sections = text.split(/^(?=## )/m).slice(1);
    session.handoff = {
      snapshotHash: (
        await review.getByText(/^Snapshot SHA-256:/).innerText()
      ).replace(/^Snapshot SHA-256:\s*/, ""),
      characters: text.length,
      messages: sections.length,
      claudeReplies: sections.filter(
        (section) =>
          section.startsWith("## assistant · claude · ") &&
          hasNumber(section.slice(section.indexOf("\n")), handoff.reply),
      ).length,
    };
    await screenshot("handoff-review");
    if (!session.handoff.claudeReplies)
      throw new Error("The handoff does not contain Claude Code's reply.");
    await review
      .getByRole("button", { name: "Attach to next Codex message" })
      .click();
    await appear(
      "the attached handoff",
      page.getByText("Reviewed handoff attached"),
    );
  }
  const composer = page.locator("form.composer");
  await composer.locator("select").nth(0).selectOption(model);
  // The preset --preset names, or Read-only review. Topsl's note under the
  // menu says what it allows, or why the runtime cannot use it.
  const presets = composer.getByRole("combobox", {
    name: "Permissions",
    exact: true,
  });
  const offered = await presets
    .locator("option")
    .evaluateAll((list) =>
      list.map((option) => ({ id: option.value, label: option.textContent })),
    );
  const preset = offered.find((p) => p.id === (options.preset ?? "review"));
  if (!preset)
    throw new Error(
      `Topsl's Permissions menu offers ${offered.map((p) => p.id).join(", ")}, not ${options.preset}.`,
    );
  await presets.selectOption(preset.id);
  session.preset = {
    ...preset,
    note: await composer.locator(".chat-preset-note").innerText(),
  };
  const unavailable = /^Not available for this runtime\.\s*/;
  if (unavailable.test(session.preset.note))
    throw new Error(
      `${preset.label.replace(/ \(unavailable\)$/, "")} is not available for this runtime, so no prompt was sent. ${session.preset.note.replace(unavailable, "")}`,
    );
  // Topsl asks once before it sends the attached context.
  if (handoff)
    await app.evaluate(() => {
      globalThis.__liveSession.policy.handoff = true;
    });
  const sentAt = Date.now();
  const turnsBefore = report.modelTurns;
  await composer.getByRole("button", { name: /Send to Codex/ }).click();
  report.modelTurns += 1;

  const runOf = (scope) =>
    scope.runs.find((r) => r.conversationId === conversationId);
  // What the run recorded: the approval policy Topsl asked for and what Codex
  // reported it adopted, also when Topsl stopped the run over a difference.
  const recordRun = (run) => {
    session.run = {
      status: run.status,
      model: run.model,
      runtimeVersion: run.runtimeVersion,
      approvalPolicy: run.approvalPolicy ?? null,
      reportedPermissions: run.reportedPermissions ?? null,
      error: withoutHome(run.error ?? null),
    };
    // A run that ended before Codex started its turn sent the model nothing,
    // as when Topsl stops it over the permissions Codex reported.
    if (["completed", "failed", "interrupted"].includes(run.status))
      report.modelTurns = turnsBefore + (run.nativeTurnId ? 1 : 0);
  };
  const declined = new Set();
  const scope = await until("Codex's reply", 240000, async () => {
    const current = await command({ type: "scope-snapshot", projectId }),
      run = runOf(current);
    if (run) recordRun(run);
    await checkShownErrors();
    // The script approves nothing: any request Codex makes is declined.
    for (const approval of current.approvals.filter(
      (a) => a.runId === run?.id && !declined.has(a.id),
    )) {
      declined.add(approval.id);
      session.approvals.push(String(approval.description).slice(0, 200));
      await command({ type: "approval-decide", id: approval.id, allow: false });
    }
    if (["failed", "interrupted", "uncertain"].includes(run?.status))
      throw new Error(
        `The Codex run ended as ${run.status}: ${run.error ?? "no detail"}`,
      );
    return run?.status === "completed" ? current : null;
  });
  const run = runOf(scope);
  const found = await command({
    type: "history-page",
    projectId,
    conversationId,
    query: expected,
  });
  step.replyObserved = found.items.some(
    (m) =>
      m.role === "assistant" &&
      m.provider === "codex" &&
      hasNumber(m.text, expected),
  );
  step.replySeconds = Math.round((Date.now() - sentAt) / 100) / 10;
  recordRun(run);
  session.usageRecords = scope.usage.filter((u) => u.runId === run.id).length;
  if (!step.replyObserved)
    throw new Error("The Codex reply does not contain the answer.");
  await expect(page.locator(".conversation")).toContainText(expected, {
    timeout: 30000,
  });
  await screenshot("codex-reply");
  if (!handoff) return;
  // The one conversation keeps both providers' replies, each attributed.
  const messages = (
    await command({
      type: "history-page",
      projectId,
      conversationId,
      limit: 80,
    })
  ).items;
  const replies = (provider, number) =>
    messages.filter(
      (m) =>
        m.role === "assistant" &&
        m.provider === provider &&
        hasNumber(m.text, number),
    ).length;
  report.conversation = {
    messages: messages.length,
    claudeReplies: replies("claude", handoff.reply),
    codexReplies: replies("codex", expected),
  };
  if (!report.conversation.claudeReplies || !report.conversation.codexReplies)
    throw new Error("The conversation does not keep both providers' replies.");
}

// Topsl's suite starts at most three model turns, and the script approves
// only a dialog that says so.
const qualificationTurns = 3;
const qualificationDialog = "Qualify this Codex runtime with live model turns?";
/** Text with the home folder written as ~, wherever it appears. */
const withoutHome = (text) =>
  typeof text === "string"
    ? text.split(home + path.sep).join(`~${path.sep}`)
    : text;

/**
 * A role as the guided setup captures it: Codex with the model, or Claude
 * Code, to which Topsl passes no model, as a step the owner runs in its
 * terminal.
 */
const roleOf = (provider, runtimes, model) =>
  provider === "claude"
    ? {
        provider,
        installationId: runtimes.claude.id,
        model: "set-in-claude-code",
        route: "terminal",
      }
    : { provider, installationId: runtimes.codex.id, model };

/** Opens the guided setup in the project's Tasks at its Team step. */
async function openTeamStep() {
  await navigate(page, "Tasks");
  const setup = page.locator(".guided-workflow");
  await appear("the guided setup", setup.locator("summary").first());
  if ((await setup.getAttribute("open")) === null)
    await setup.locator("summary").first().click();
  await setup.getByRole("button", { name: "2. Team", exact: true }).click();
  return setup;
}

/**
 * Keeps the readiness Topsl gives each role of the selection, and how many
 * roles the guided setup shows as satisfied, in `session`.
 */
async function recordReadiness(projectId, setup, selection, session) {
  const readiness = await command({
    type: "workflow-readiness-query",
    projectId,
    ...selection,
  });
  report.readiness = {};
  for (const role of ["builder", "reviewer"]) {
    const value = readiness.roles?.[role];
    report.readiness[role] = {
      provider: selection[role].provider,
      ready: !!value?.ready,
      freshness: value?.freshness?.state ?? null,
      blockers: (value?.blockers ?? []).map((b) => b.code),
    };
  }
  const shownReady = setup.getByText(/^Role requirements currently satisfied/);
  if (report.readiness.builder.ready && report.readiness.reviewer.ready)
    await until(
      "the guided setup to show both roles as satisfied",
      15000,
      async () => (await shownReady.count()) === 2,
    ).catch(() => {});
  session.rolesShownReady = await shownReady.count();
}

/**
 * Topsl's runtime qualification from the guided setup, with Codex in both
 * roles, or in the Codex role of a workflow's team, with Claude Code in the
 * other. It is approved once and not retried. Whatever Topsl recorded is
 * kept, also when the qualification fails.
 */
async function codexQualification(projectId, runtimes) {
  const runtime = runtimes.codex,
    // The team the guided setup is given: --workflow's, or Codex in both roles.
    roles = team ?? { builder: "codex", reviewer: "codex" },
    codexRoles = ["builder", "reviewer"].filter((r) => roles[r] === "codex");
  const session = (report.session = {
    account: null,
    model: null,
    modelsReported: null,
    summary: null,
    rolesShownReady: null,
  });
  const model = await codexConnection(session);
  const setup = await openTeamStep();
  await setup
    .getByLabel("Team preset")
    .selectOption(`${roles.builder}:${roles.reviewer}`);
  for (const role of ["builder", "reviewer"])
    await setup
      .getByLabel(`Selected ${role} runtime`)
      .selectOption(runtimes[roles[role]].id);
  await setup
    .getByRole("button", {
      name: `Discover ${codexRoles[0]} models`,
      exact: true,
    })
    .click();
  const listed = setup
    .getByLabel(`Requested ${codexRoles.at(-1)} model`)
    .locator(`option[value=${JSON.stringify(model)}]`);
  await until("the guided setup to list Codex's models", 60000, async () => {
    await checkShownErrors();
    return (await listed.count()) > 0;
  });
  for (const role of codexRoles)
    await setup.getByLabel(`Requested ${role} model`).selectOption(model);
  const qualify = setup.getByRole("button", {
    name: `Qualify ${codexRoles[0]} runtime`,
    exact: true,
  });
  await expect(qualify).toBeEnabled();
  await screenshot("qualification-ready");
  await app.evaluate(
    (_electron, approval) => {
      globalThis.__liveSession.policy.qualification = approval;
    },
    {
      message: qualificationDialog,
      model,
      turns: qualificationTurns,
      folder: qualificationFolder,
    },
  );
  await qualify.click();
  const clickedAt = Date.now();

  const answer = () =>
    app.evaluate(
      (_electron, dialog) =>
        globalThis.__liveSession.dialogs.find((d) => d.dialog === dialog)
          ?.answer ?? null,
      qualificationDialog,
    );
  const summary = setup
    .getByText(/^(Qualification recorded until|Nothing was recorded\.)/)
    .first();
  let failure = null;
  try {
    // Topsl allows the qualification 20 minutes.
    await until(
      "Topsl's qualification",
      21 * 60000,
      async () => {
        const answered = await answer();
        if (answered && answered !== "Run qualification")
          throw new Error(
            "Topsl's qualification dialog did not name the executable, model, turn budget and folder this script expected, so it was cancelled.",
          );
        if (!answered && Date.now() - clickedAt > 60000)
          throw new Error("Topsl did not ask to run the qualification.");
        await checkShownErrors();
        return summary.isVisible();
      },
      2000,
    );
  } catch (error) {
    failure = error;
  }
  try {
    const recorded =
      (await command({ type: "runtime-qualification-query", id: runtime.id }))
        .reports[0] ?? null;
    // Unknown when Topsl started the qualification but recorded nothing.
    report.modelTurns = recorded
      ? recorded.report.turnsStarted
      : (await answer()) === "Run qualification"
        ? null
        : 0;
    const result = recorded?.report;
    report.qualification = result
      ? {
          suite: result.suite,
          model: result.model,
          effort: result.effort,
          // Only the account kind and plan are kept, never the sign-in identity.
          account: result.account && {
            type: result.account.sanitized?.type ?? null,
            planType: result.account.sanitized?.planType ?? null,
          },
          turnsStarted: result.turnsStarted,
          seconds:
            Math.round(
              (Date.parse(result.finishedAt) - Date.parse(result.startedAt)) /
                100,
            ) / 10,
          observations: result.observations.map((o) => ({
            capability: o.capability,
            passed: o.passed,
            meaning: o.meaning,
            detail: withoutHome(o.detail),
          })),
          notTested: result.notTested.map((n) => ({
            capability: n.capability,
            reason: withoutHome(n.reason),
          })),
          approvals: result.approvals,
          error: withoutHome(result.error),
          recorded: !!recorded.acceptanceId,
          expiresAt: recorded.expiresAt,
        }
      : null;
    if (await summary.isVisible())
      session.summary = withoutHome(await summary.innerText());
    await recordReadiness(
      projectId,
      setup,
      {
        builder: roleOf(roles.builder, runtimes, model),
        reviewer: roleOf(roles.reviewer, runtimes, model),
      },
      session,
    );
    await screenshot("qualification");
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;

  const qualification = report.qualification;
  if (!qualification)
    throw new Error("Topsl recorded no qualification report.");
  if (qualification.turnsStarted > qualificationTurns)
    throw new Error(
      `The qualification started ${qualification.turnsStarted} model turns, more than the ${qualificationTurns} approved.`,
    );
  if (qualification.error)
    throw new Error(`The qualification stopped: ${qualification.error}`);
  const failed = qualification.observations
    .filter((o) => !o.passed)
    .map((o) => o.capability);
  if (failed.length) throw new Error(`Not passed: ${failed.join(", ")}.`);
  if (qualification.notTested.length)
    throw new Error(
      `Not tested: ${qualification.notTested.map((n) => n.capability).join(", ")}.`,
    );
  if (!qualification.recorded)
    throw new Error("Topsl did not record the qualification.");
  const blocked = ["builder", "reviewer"].filter(
    (role) => !report.readiness[role].ready,
  );
  if (blocked.length)
    throw new Error(
      `The ${blocked.join(" and ")} role stayed blocked after the qualification.`,
    );
  if (session.rolesShownReady !== 2)
    throw new Error("The guided setup does not show both roles as satisfied.");
}

// The seeded project's task, as the guided setup's Goal step takes it. It
// changes one tracked file, so the build adds no file that Topsl holds for an
// exact-hash review, which the script never gives.
const workflowGoal = {
  objective:
    "Apply a ten percent discount to the order total in src/order.mjs.",
  criteria: [
    "orderTotal(catalog) returns 900 cents",
    "totalCents(catalog) still returns 1000 cents",
    "Only src/order.mjs changes, and no file is added",
    "The required check, npm run check, passes on the build",
  ],
};
const offlineRecipe = "Locked JavaScript / TypeScript · offline";
const dispatchDialog = "Approve captured inputs and start?",
  checkDialog = "Run this required check?",
  transcriptDialog =
    "Let Topsl read Claude Code's transcripts for workflow steps?";
/** Whether the build and the review have ended, or Topsl stopped before them. */
const settled = (workflow) =>
  [
    "checking",
    "ready-repair",
    "awaiting-acceptance",
    "blocked",
    "cancelled",
  ].includes(workflow.stage) ||
  (workflow.stage === "ready-review" &&
    !!workflow.detail?.startsWith("Awaiting output manifest review"));

/** Waits for Topsl to show `dialog`, and fails unless the script approved it. */
async function approved(dialog, approval, refused) {
  const answer = await until(`Topsl to ask "${dialog}"`, 60000, () =>
    app.evaluate(
      (_electron, dialog) =>
        globalThis.__liveSession.dialogs.find((d) => d.dialog === dialog)
          ?.answer ?? null,
      dialog,
    ),
  );
  if (answer !== approval) throw new Error(refused);
}

/** How long Topsl takes an answer to one of Codex's requests. */
const answerWindow = 15 * 60000;

/** What a request Codex makes during the workflow asks, as its card shows it. */
const asked = (approval) => ({
  title: approval.summary?.title ?? "Native approval requested",
  details: (approval.summary?.details ?? []).map(
    (detail) =>
      `${detail.label}: ${withoutHome(String(detail.value)).slice(0, 500)}`,
  ),
  answer: null,
});

/** Records which button on a request's card is pressed, by request. */
async function watchPresses() {
  await page.evaluate(() => {
    window.__liveSessionPresses = [];
    document.addEventListener(
      "click",
      (event) => {
        const button =
            event.target instanceof Element
              ? event.target.closest("button")
              : null,
          request = button?.closest("[data-approval]");
        if (request)
          window.__liveSessionPresses.push({
            approval: request.getAttribute("data-approval"),
            button: button.textContent.trim(),
          });
      },
      true,
    );
  });
}

/**
 * The owner's answer to a request that is no longer waiting: `allowed` when
 * they confirmed **Allow once** in Topsl's dialog for it, `denied` when they
 * pressed **Deny** on its card, and otherwise `unanswered`.
 */
async function answerOf(approval) {
  const [confirmed, presses] = await Promise.all([
    app.evaluate(
      (_electron, digest) =>
        globalThis.__liveSession.dialogs.some(
          (d) => d.digest === digest && d.answer === "Allow once",
        ),
      approval.digest,
    ),
    page.evaluate(
      (id) =>
        window.__liveSessionPresses
          .filter((press) => press.approval === id)
          .map((press) => press.button),
      approval.id,
    ),
  ]);
  return confirmed
    ? "allowed"
    : presses.includes("Deny")
      ? "denied"
      : "unanswered";
}

/** Stand-in runs only: answers a request on the workflow's card as the owner
 * would, denying a command and allowing a file change. */
async function answerAsOwner(card, approval) {
  await card
    .locator(`[data-approval="${approval.id}"]`)
    .getByRole("button", {
      name:
        approval.method === "item/fileChange/requestApproval"
          ? "Review & allow once"
          : "Deny",
      exact: true,
    })
    .click();
}

/**
 * Turns on Settings → Claude Code transcripts in the run's profile, through
 * Topsl's own confirmation, so that Topsl takes each Claude step's reply from
 * its session's transcript.
 */
async function claudeTranscripts() {
  await navigate(page, "Settings");
  const setting = page.getByRole("region", {
    name: "Claude Code transcripts",
    exact: true,
  });
  await appear("Settings → Claude Code transcripts", setting);
  const turn = (name) => setting.getByRole("button", { name, exact: true });
  await app.evaluate(() => {
    globalThis.__liveSession.policy.transcriptRead = true;
  });
  await turn("On").click();
  await approved(
    transcriptDialog,
    "Read transcripts",
    "Topsl's confirmation to read Claude Code's transcripts was not the one this script expected, so it was cancelled.",
  );
  await expect(turn("On")).toHaveAttribute("aria-pressed", "true", {
    timeout: 15000,
  });
  report.claudeCode.transcriptRead = "on";
  await navigate(page, "Sessions");
}

/**
 * The guided setup's Team step with Claude Code in both roles. A Claude Code
 * step needs no model and no qualification, only a trusted Claude Code and
 * project, so nothing runs before the workflow.
 */
async function claudeTeam(projectId, runtimes) {
  const setup = await openTeamStep();
  await setup.getByLabel("Team preset").selectOption("claude:claude");
  for (const role of ["builder", "reviewer"])
    await setup
      .getByLabel(`Selected ${role} runtime`)
      .selectOption(runtimes.claude.id);
  const selection = {
    builder: roleOf("claude", runtimes),
    reviewer: roleOf("claude", runtimes),
  };
  await recordReadiness(projectId, setup, selection, report.claudeCode);
  // The setup says plainly that Claude reviews Claude.
  report.claudeCode.pairingNoteShown =
    (await setup
      .getByText(
        "Claude reviews Claude in a fresh Claude Code session. This is not an independent second model.",
        { exact: true },
      )
      .count()) === 1;
  await screenshot("team");
  const blocked = ["builder", "reviewer"].filter(
    (role) => !report.readiness[role].ready,
  );
  if (blocked.length)
    throw new Error(
      `Topsl shows the ${blocked.join(" and ")} role blocked: ${blocked.map((role) => report.readiness[role].blockers.join(", ") || "no reason given").join("; ")}.`,
    );
  if (report.claudeCode.rolesShownReady !== 2)
    throw new Error("The guided setup does not show both roles as satisfied.");
  if (!report.claudeCode.pairingNoteShown)
    throw new Error(
      "The guided setup does not say that Claude reviewing Claude is not an independent second model.",
    );
}

/**
 * Fails unless Claude Code opens for the step in one of the run's folders,
 * whose trust question the script answers: the seeded project for a build,
 * or, for a review, a new read-only copy of the build in the temporary folder.
 */
async function runFolder(step, noun) {
  const folder = await realpath(step.folder).catch(() => null);
  if (step.role !== "reviewer") {
    if (folder !== canonicalProject)
      throw new Error(
        `Topsl opens the ${noun} in ${withoutHome(step.folder)}, not in the seeded project, so the script opened nothing.`,
      );
    return folder;
  }
  const mode = folder ? (await stat(folder)).mode : null;
  if (
    !folder ||
    path.dirname(folder) !== (await realpath(os.tmpdir())) ||
    !path.basename(folder).startsWith("topsl-candidate-") ||
    mode & 0o222
  )
    throw new Error(
      `Topsl opens the review in ${withoutHome(step.folder)}, which is not a new read-only copy of the build in the temporary folder, so the script opened nothing.`,
    );
  return folder;
}

// The mode each Claude step opens in: a build or repair in Accept edits,
// which the script picks on the step's mode menu, and a review in Plan, the
// only mode Topsl opens it in. Claude Code shows each below its input.
const stepModes = {
  build: {
    id: "accept-edits",
    args: ["--permission-mode", "acceptEdits"],
    shown: "accept edits on",
  },
  review: {
    id: "plan",
    args: ["--permission-mode", "plan"],
    shown: "plan mode on",
  },
};
/** How long a Claude step may take, from the instructions to Claude's reply. */
const stepWindow = 30 * 60000;

/**
 * Runs the Claude Code step the workflow waits on from its card, as the
 * owner would: it opens Claude Code for the step, answers the folder trust
 * question for the run's folder, and pastes the instructions Topsl copied
 * once. During Claude's turn, it leaves each permission prompt for the owner
 * to answer in Topsl's terminal within 15 minutes, and keeps the answer;
 * with TOPSL_LIVE_OWNER_STAND_IN, it answers Yes as the owner. It declines
 * every offer to approve a plan, and any other question stops the run. After Claude's
 * reply it exits Claude Code, confirms that Claude Code stopped and hands the
 * reply back from the session's transcript, which Topsl must take.
 */
async function claudeStep(projectId, card, step, workflowOf) {
  const noun = { builder: "build", reviewer: "review", repair: "repair" }[
      step.role
    ],
    mode = step.role === "reviewer" ? stepModes.review : stepModes.build;
  const record = {
    role: step.role,
    stepId: step.id,
    folder: withoutHome(step.folder),
    sessionId: null,
    runtimeVersion: null,
    mode: { chosen: mode.id, recorded: null, args: null, shown: null },
    folderTrust: { asked: false, selectedFirst: null, namesFolder: null },
    startupQuestion: null,
    bracketedPaste: null,
    instructions: null,
    pasted: false,
    replySeconds: null,
    declined: [],
    permissions: [],
    question: null,
    apiError: null,
    exit: null,
    stopped: false,
    handBack: null,
    topsl: null,
  };
  report.workflow.claudeSteps.push(record);
  const panel = card.getByRole("region", {
    name: `Claude Code ${noun}`,
    exact: true,
  });
  await appear(`the Claude Code ${noun} on the workflow's card`, panel);
  const folder = await runFolder(step, noun);
  const menu = panel.getByRole("combobox", {
    name: `Claude Code mode for this ${noun}`,
    exact: true,
  });
  if (step.role === "reviewer") {
    if (await menu.count())
      throw new Error(
        "The Claude Code review offers a mode menu, but a review opens only in Plan.",
      );
  } else {
    const offered = await menu
      .locator("option")
      .evaluateAll((list) => list.map((option) => option.value));
    if (!offered.includes(mode.id))
      throw new Error(
        `The ${noun}'s mode menu offers ${offered.join(", ")}, not ${mode.id}.`,
      );
    await menu.selectOption(mode.id);
  }
  await screenshot(`claude-${noun}-step`);

  try {
    await panel
      .getByRole("button", { name: "Open in Claude Code", exact: true })
      .click();
    const open = await until(
      `Claude Code to open for the ${noun}`,
      60000,
      async () => {
        await checkShownErrors();
        const latest = (await workflowOf()).claudeSteps
          .find((s) => s.id === step.id)
          ?.opens.at(-1);
        if (latest?.state === "failed")
          throw new Error(
            `Claude Code did not open for the ${noun}: ${withoutHome(latest.error)}`,
          );
        return latest?.state === "opened" ? latest : null;
      },
    );
    record.sessionId = open.sessionId;
    record.runtimeVersion = open.runtimeVersion;
    record.mode.recorded = open.mode;
    record.mode.args =
      (await command({ type: "scope-snapshot", projectId })).runs.find(
        (run) => run.nativeSessionId === open.sessionId,
      )?.permissionArgs ?? null;
    if (
      open.mode !== mode.id ||
      JSON.stringify(record.mode.args) !== JSON.stringify(mode.args)
    )
      throw new Error(
        `Topsl opened the ${noun} in ${open.mode} with ${JSON.stringify(record.mode.args)}, not ${mode.id} with ${JSON.stringify(mode.args)}.`,
      );
    // The instructions Topsl shows on the step, which it copied for the owner.
    const shown = panel.locator("details pre");
    const instructions = await until(
      "the instructions Topsl copied",
      15000,
      async () => ((await shown.count()) ? shown.textContent() : null),
    );
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    record.instructions = {
      characters: instructions.length,
      lines: instructions.split("\n").length,
      sha256: createHash("sha256").update(instructions).digest("hex"),
      copied: copied === instructions,
    };
    record.instructions.matchStep =
      record.instructions.sha256 === step.instructionsHash;
    if (!record.instructions.copied)
      throw new Error(
        "The clipboard does not hold the instructions Topsl shows for the step, so nothing was pasted.",
      );
    if (
      !record.instructions.matchStep ||
      !instructions.startsWith(`# Topsl task input\nRole: ${step.role}\n`) ||
      (step.role === "reviewer" &&
        !instructions.includes(
          `"candidateRevision":"${step.candidateRevision}"`,
        ))
    )
      throw new Error(
        `The instructions Topsl copied are not the ${noun}'s, so nothing was pasted.`,
      );

    const view = stepTerminal(panel, open.terminalId);
    await appear(`Claude Code's terminal for the ${noun}`, view.region);
    await until(
      `Claude Code to accept the ${noun}'s instructions`,
      120000,
      async () => {
        const output = plain(await view.output()),
          screen = await view.screen(),
          text = `${output}\n${screen}`;
        if (signIn.test(text))
          throw new Error(
            "Claude Code is not signed in. Sign in with `claude` in a terminal, then run this again.",
          );
        if (exitPattern.test(output))
          throw new Error(
            `Claude Code exited before accepting the ${noun}'s instructions.`,
          );
        // Claude Code asks whether to trust each new folder, as this run's
        // are.
        if (!record.folderTrust.asked && trustPrompt.test(screen)) {
          record.folderTrust.asked = true;
          const flat = screen.replace(/\s+/g, "");
          record.folderTrust.namesFolder = [
            folder,
            step.folder,
            tilde(folder),
            tilde(step.folder),
          ].some((name) => flat.includes(name.replace(/\s+/g, "")));
          record.folderTrust.selectedFirst = await trustFolder(view);
          return null;
        }
        const shown = belowTrust(screen);
        const asked = startupQuestions.find(([pattern]) => pattern.test(text));
        if (asked) {
          record.startupQuestion = asked[1];
          await screenshot(`claude-${noun}-question`);
          throw new Error(
            `Claude Code asked ${asked[1]} before accepting the ${noun}'s instructions. The script answers none of Claude Code's startup questions except folder trust, so nothing was pasted.`,
          );
        }
        if (claudeChoice(shown) || choiceSigns.test(shown)) {
          record.question = claudeChoice(shown)?.question ?? null;
          await screenshot(`claude-${noun}-question`);
          throw new Error(
            `Claude Code asked ${record.question ? `"${record.question}"` : "a question"} before accepting the ${noun}'s instructions. The script answers none of Claude Code's startup questions except folder trust, so nothing was pasted.`,
          );
        }
        return inputReady.test(shown);
      },
    );
    // The mode Claude Code shows below its input has to be the one Topsl
    // passed, or nothing is pasted.
    record.mode.shown =
      shownMode.exec(await view.screen())?.[1].toLowerCase() ?? null;
    await screenshot(`claude-${noun}-ready`);
    if (record.mode.shown !== mode.shown)
      throw new Error(
        `Claude Code showed ${record.mode.shown ? `"${record.mode.shown}"` : "no permission mode"} below its input instead of "${mode.shown}", so nothing was pasted.`,
      );
    // Without bracketed paste, each line of the instructions would reach
    // Claude Code as if typed, and the first would be sent alone.
    const raw = await view.output();
    record.bracketedPaste =
      raw.lastIndexOf("\x1b[?2004h") > raw.lastIndexOf("\x1b[?2004l");
    if (!record.bracketedPaste)
      throw new Error(
        "Claude Code has not turned on bracketed paste, so a paste would send the instructions line by line. Nothing was pasted.",
      );

    // One paste, with Topsl's Edit → Paste, which is what Cmd+V does in
    // Topsl on a Mac, into Claude Code's input; then Enter sends it.
    const before = raw.length;
    await view.focus();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.paste(),
    );
    record.pasted = true;
    await until(
      `Claude Code to show the pasted instructions`,
      15000,
      async () =>
        /\[Pasted text #\d+/.test(await view.screen()) ||
        (await view.screen()).includes("# Topsl task input"),
    );
    await sleep(500);
    const sentAt = Date.now();
    await view.press("Enter");

    // Claude's turn, until Claude Code waits for the owner again with
    // nothing on its screen changing for 5 seconds.
    let last = null,
      steadySince = Date.now(),
      asking = null;
    await until(
      `Claude's reply in the ${noun}`,
      stepWindow,
      async () => {
        const output = plain((await view.output()).slice(before)),
          screen = belowTrust(await view.screen());
        if (screen !== last) {
          last = screen;
          steadySince = Date.now();
        }
        const steady = Date.now() - steadySince >= 5000;
        // An API error Claude Code has given up on stays on screen; while it
        // retries one, it says so.
        const apiError = /API Error: (\d{3})/.exec(screen);
        if (apiError && !/Retrying in/i.test(screen)) {
          record.apiError = Number(apiError[1]);
          throw new Error(
            `Claude Code reported API error ${apiError[1]} instead of replying.`,
          );
        }
        if (signIn.test(`${output}\n${screen}`))
          throw new Error("Claude Code asked to sign in instead of replying.");
        if (exitPattern.test(output))
          throw new Error(
            `Claude Code exited before Claude replied in the ${noun}.`,
          );
        const choice = claudeChoice(screen);
        // A permission prompt waits for the owner, who answers it in Topsl's
        // terminal. It is kept with the answer last selected before it went.
        if (asking && choice?.kind !== "permission") {
          asking.seconds = Math.round((Date.now() - asking.at) / 1000);
          delete asking.at;
          delete asking.deadline;
          asking = null;
          steadySince = Date.now();
          return false;
        }
        if (choice?.kind === "permission") {
          const selected = screen
            .split("\n")
            .findLast((l) => numberedAnswer.test(l));
          if (!asking) {
            await screenshot(`claude-${noun}-permission`);
            const deadline = Date.now() + answerWindow;
            asking = {
              question: choice.question,
              selectedFirst: selected ? answerText(selected) : null,
              answeredBy: ownerStandIn ? "owner stand-in" : "owner",
              answer: null,
              seconds: null,
              at: Date.now(),
              deadline,
            };
            record.permissions.push(asking);
            console.error(
              ownerStandIn
                ? `Claude Code asks: ${choice.question} The script answers Yes as the owner, since this is the stand-in run.`
                : `Claude Code asks: ${choice.question} Answer it in the ${noun}'s terminal in Topsl's window by ${new Date(deadline).toLocaleTimeString()}, after which the run stops.`,
            );
            if (ownerStandIn)
              asking.answer = (
                await choose(
                  view,
                  "permission prompt",
                  approvePermission,
                  numberedAnswer,
                )
              ).chosen;
          }
          if (selected && !ownerStandIn) asking.answer = answerText(selected);
          if (Date.now() > asking.deadline)
            throw new Error(
              `Claude Code's permission prompt "${choice.question}" waited 15 minutes without an answer, so the run stopped.`,
            );
          return false;
        }
        if (choice?.kind === "plan") {
          await screenshot(`claude-${noun}-plan`);
          const { first, chosen } = await choose(
            view,
            "offer to approve the plan",
            choice.answer,
            numberedAnswer,
          );
          record.declined.push({
            kind: choice.kind,
            question: choice.question,
            selectedFirst: first,
            answered: chosen,
          });
          await until(
            "Claude Code to take the answer",
            15000,
            async () =>
              !(await view.screen())
                .split("\n")
                .some((l) => choice.answer.test(l)),
          );
          return false;
        }
        if (choice || (choiceSigns.test(screen) && steady)) {
          record.question = choice?.question ?? null;
          await screenshot(`claude-${noun}-question`);
          throw new Error(
            `Claude Code asked ${record.question ? `"${record.question}"` : "a question the script cannot read"} during the ${noun}. The script answers no question there but plan approvals, which it declines, and leaves permission prompts to you, so it stopped.`,
          );
        }
        const working =
          /esc\s*to\s*interrupt/i.test(output) || output.includes("⏺");
        if (!working && Date.now() - sentAt > 120000)
          throw new Error(
            `Claude Code showed no sign of working on the ${noun}'s instructions within 2 minutes.`,
          );
        return (
          working &&
          steady &&
          inputReady.test(screen) &&
          !/esc\s*to\s*interrupt/i.test(screen)
        );
      },
      1000,
    );
    record.replySeconds = Math.round((steadySince - sentAt) / 100) / 10;
    await screenshot(`claude-${noun}-reply`);

    // Claude Code's own exit, then if needed Ctrl+C twice and Close session.
    record.exit = { method: "/exit", code: null };
    if (choiceSigns.test(belowTrust(await view.screen())))
      throw new Error(
        "Claude Code shows a choice, so the script typed nothing to exit it.",
      );
    await view.focus();
    await page.keyboard.type("/exit", { delay: 20 });
    await sleep(500);
    await page.keyboard.press("Enter");
    const exited = (timeoutMs) =>
      until("Claude Code to exit", timeoutMs, async () =>
        exitPattern.exec(plain(await view.output())),
      ).catch(() => null);
    let ended = await exited(30000);
    if (!ended) {
      record.exit.method = "Ctrl+C twice";
      await view.press("Control+C");
      await sleep(500);
      await view.press("Control+C");
      ended = await exited(20000);
    }
    if (!ended) {
      record.exit.method = "Close session";
      await panel
        .getByRole("button", { name: "Close session", exact: true })
        .click();
      ended = await exited(20000);
    }
    record.exit.code = ended ? Number(ended[1]) : null;
    await until(
      "Topsl to see Claude Code exit",
      20000,
      async () => !(await workflowOf()).claudeStepTerminalId,
    );
  } finally {
    // A run that stops while Claude Code runs keeps its screen, then closes
    // its session.
    const running = await command({ type: "builder-reviewer-query", projectId })
      .then(
        ({ workflows }) =>
          workflows.find((w) => w.id === step.workflowId)?.claudeStepTerminalId,
      )
      .catch(() => null);
    if (running) {
      await screenshot(`claude-${noun}-stopped`).catch(() => {});
      await panel
        .getByRole("button", { name: "Close session", exact: true })
        .click({ timeout: 5000 })
        .catch(() => {});
      record.exit ??= { method: "Close session", code: null };
    }
  }

  // The owner's confirmation, then the reply from the session's transcript.
  await panel
    .getByRole("checkbox", { name: /^Claude Code has stopped/ })
    .check();
  record.stopped = true;
  const handed = (await workflowOf()).claudeSteps.find((s) => s.id === step.id);
  await panel
    .getByRole("button", { name: "Take reply from transcript", exact: true })
    .click();
  record.handBack = await until(
    "Topsl to take Claude's reply",
    60000,
    async () => {
      await checkShownErrors();
      const current = (await workflowOf()).claudeSteps.find(
          (s) => s.id === step.id,
        ),
        reply =
          current.replies.length > handed.replies.length
            ? current.replies.at(-1)
            : null;
      if (reply)
        return {
          source: reply.source,
          outcome: reply.outcome,
          detail: withoutHome(reply.detail),
        };
      if (
        current.updatedAt !== handed.updatedAt &&
        current.detail.startsWith("Topsl took no reply")
      )
        return {
          source: "claude-transcript",
          outcome: "unread",
          detail: withoutHome(current.detail),
        };
      return null;
    },
  );
  if (record.handBack.outcome !== "taken")
    throw new Error(
      record.handBack.outcome === "unread"
        ? record.handBack.detail
        : `Topsl did not take the ${noun}'s reply from the transcript: ${record.handBack.detail}`,
    );
  if (record.handBack.source !== "claude-transcript")
    throw new Error(
      `Topsl took the ${noun}'s reply as ${record.handBack.source}, not from the transcript.`,
    );
}

/**
 * Build and review with the team --workflow names, through Topsl's own
 * screens: Codex's qualification, or the Team step for Claude in both roles,
 * then the rest of the guided setup and one approved start, after which
 * Topsl builds and then starts the review itself. A Claude role is a Claude
 * Code step on the workflow's card, which the script runs as claudeStep
 * says. The script answers none of the requests Codex makes during the
 * workflow's turns: each waits for the owner on the workflow's card, and the
 * report keeps what it asked and the owner's answer. The script starts no
 * repair, decides no finding and never accepts, so the run ends at the
 * findings or, after the required check, at acceptance. Whatever Topsl
 * recorded is kept, also when it fails.
 */
async function teamWorkflow(projectId, runtimes) {
  if (
    ownerStandIn &&
    ((runtimes.codex && !String(runtimes.codex.version).endsWith("-fixture")) ||
      (runtimes.claude &&
        !/tests\/fixtures\/live-session\/claude\.cjs$/.test(
          runtimes.claude.realPath,
        )))
  )
    throw new Error(
      "TOPSL_LIVE_OWNER_STAND_IN plays the owner only for the repository's stand-ins, never for a live Codex or Claude Code.",
    );
  await watchTerminals();
  if (runtimes.claude) await claudeTranscripts();
  if (runtimes.codex) await codexQualification(projectId, runtimes);
  else await claudeTeam(projectId, runtimes);
  const workflow = (report.workflow = {
    project: {
      baseCommit: seeded.baseCommit,
      sourceIdentity: seeded.manifest.sourceIdentity,
      files: seeded.paths.length,
    },
    id: null,
    objective: workflowGoal.objective,
    check: null,
    stages: [],
    stage: null,
    detail: null,
    attempts: [],
    approvals: [],
    candidate: null,
    review: null,
    reviewReply: null,
    checks: [],
    claudeSteps: [],
    claudeProvenance: [],
    record: null,
    stoppedAt: null,
  });
  const setup = page.locator(".guided-workflow");
  await setup.getByRole("button", { name: "1. Goal", exact: true }).click();
  await setup
    .getByRole("textbox", { name: "Objective", exact: true })
    .fill(workflowGoal.objective);
  await setup
    .getByRole("textbox", {
      name: "Acceptance criteria · one per line",
      exact: true,
    })
    .fill(workflowGoal.criteria.join("\n"));
  await setup
    .getByRole("button", { name: "3. Environment", exact: true })
    .click();
  const recipes = setup.getByLabel("Preparation and check recipe");
  await until(
    "the guided setup to offer the locked offline recipe",
    30000,
    async () => {
      await checkShownErrors();
      return (
        (await recipes.locator("option", { hasText: offlineRecipe }).count()) >
        0
      );
    },
  );
  await recipes.selectOption({ label: offlineRecipe });
  await setup.getByLabel("Project check script").selectOption("check");
  // The exact check, as Topsl's dialog names it before it runs.
  const recipe = (
    await command({ type: "environment-detect", projectId })
  ).suggestions.find((s) => s.label === offlineRecipe);
  const check = {
    executable: recipe.nodeExecutable,
    args: [recipe.npmCli, "run", "check"],
  };
  workflow.check = {
    executable: tilde(check.executable),
    args: check.args.map(tilde),
  };
  // Nothing to fill in under Scope: no change boundaries and no new files.
  await setup.getByRole("button", { name: "4. Scope", exact: true }).click();
  await setup
    .getByRole("button", { name: "5. Review and start", exact: true })
    .click();
  const capture = setup.getByRole("button", {
    name: "Capture coordinated workflow",
    exact: true,
  });
  await expect(capture).toBeEnabled({ timeout: 30000 });
  await screenshot("workflow-setup");
  await capture.click();
  await appear("the captured workflow", setup.getByText(/^Workflow captured/));
  const workflows = async () =>
    (await command({ type: "builder-reviewer-query", projectId })).workflows;
  let current = (await workflows()).find(
    (w) => w.objective === workflowGoal.objective,
  );
  if (!current) throw new Error("Topsl did not capture the workflow.");
  workflow.id = current.id;
  // Reads the workflow again and keeps each new stage, in order.
  const observe = async () => {
    current = (await workflows()).find((w) => w.id === workflow.id);
    if (current.stage !== workflow.stages.at(-1))
      workflow.stages.push(current.stage);
    await checkShownErrors();
    return current;
  };
  await observe();
  const card = page.locator(".workflow-card").filter({
    has: page.getByRole("heading", {
      name: workflowGoal.objective,
      exact: true,
    }),
  });
  let failure = null;
  try {
    await appear(
      "the workflow ready to build",
      card.getByText("ready build", { exact: true }),
    );
    // Topsl asks once. The approval covers the captured inputs and both
    // roles' runtime and model, so it also starts the review after the build.
    await app.evaluate(
      (_electron, approval) => {
        globalThis.__liveSession.policy.dispatch = approval;
      },
      {
        workflowId: workflow.id,
        workspace: canonicalProject,
        builder: roleOf(team.builder, runtimes, report.session?.model),
        reviewer: roleOf(team.reviewer, runtimes, report.session?.model),
      },
    );
    const start = card.getByRole("button", {
      name: "Approve captured inputs and start",
      exact: true,
    });
    await expect(start).toBeEnabled({ timeout: 30000 });
    await start.click();
    await approved(
      dispatchDialog,
      "Approve inputs and start",
      "Topsl's dialog to start the workflow did not name the workflow, folder, runtime and model this script captured, so it was cancelled.",
    );
    // The script answers none of Codex's requests: each waits for the owner
    // on the workflow's card and is kept with the owner's answer once it is
    // gone. A Claude step the workflow waits on is run once, as the owner
    // would, after which Topsl goes on by itself.
    await watchPresses();
    const requests = new Map(),
      handled = new Set(),
      workflowOf = observe;
    try {
      for (;;) {
        let waitingStep = null;
        await until(
          "the build and the review",
          45 * 60000,
          async () => {
            const scope = await command({ type: "scope-snapshot", projectId }),
              tasks = scope.coordination.tasks
                .filter((t) => t.workflowId === workflow.id)
                .map((t) => t.id),
              runs = new Set(
                scope.coordination.attempts
                  .filter((a) => tasks.includes(a.taskId))
                  .map((a) => a.legacyRunId),
              ),
              waiting = scope.approvals.filter((a) => runs.has(a.runId));
            for (const approval of waiting) {
              // Topsl takes no answer to a request after 15 minutes, so one
              // left that long can only hold the run until its time is up.
              const deadline = Date.parse(approval.createdAt) + answerWindow;
              if (Date.now() > deadline)
                throw new Error(
                  `Codex's request "${asked(approval).title}" waited 15 minutes without an answer, and Topsl takes none after that.`,
                );
              if (!requests.has(approval.id)) {
                const request = asked(approval);
                requests.set(approval.id, { approval, request });
                workflow.approvals.push(request);
                console.error(
                  ownerStandIn
                    ? `Codex asks: ${request.title}. The script answers it as the owner, since this is the stand-in run.`
                    : `Codex asks: ${request.title}. Answer it on the workflow's card in Topsl's window by ${new Date(deadline).toLocaleTimeString()}, after which Topsl takes no answer.`,
                );
                // How the first request looks on the card, before its answer.
                if (requests.size === 1) {
                  await appear(
                    "Codex's request on the workflow's card",
                    card.locator(`[data-approval="${approval.id}"]`),
                  );
                  await screenshot("workflow-request");
                }
                if (ownerStandIn) await answerAsOwner(card, approval);
              }
            }
            for (const [id, { approval, request }] of requests)
              if (!request.answer && !waiting.some((a) => a.id === id))
                request.answer = await answerOf(approval);
            const observed = await observe(),
              step = observed.claudeStep;
            if (step?.state === "waiting" && !handled.has(step.id))
              waitingStep = step;
            return waitingStep || settled(observed);
          },
          2000,
        );
        if (!waitingStep) break;
        handled.add(waitingStep.id);
        await claudeStep(projectId, card, waitingStep, workflowOf);
      }
    } finally {
      for (const { request } of requests.values())
        request.answer ??= "unanswered";
    }
    if (current.stage === "checking") {
      await app.evaluate(
        (_electron, approval) => {
          globalThis.__liveSession.policy.check = approval;
        },
        { ...check, candidate: current.candidateRevision },
      );
      await card
        .getByRole("button", { name: "Review and run checks", exact: true })
        .click();
      await approved(
        checkDialog,
        "Run check",
        "Topsl's dialog to run the required check did not name the check and build this script expected, so it was cancelled.",
      );
      await until(
        "the required check",
        10 * 60000,
        async () => {
          await observe();
          return (
            current.stage !== "checking" ||
            current.checksStatus.some(
              (c) =>
                c.targetRevision === current.candidateRevision &&
                c.result !== "pending",
            )
          );
        },
        2000,
      );
    }
  } catch (error) {
    failure = error;
  }
  try {
    await recordWorkflow(projectId, card);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;

  if (report.modelTurns > team.codexTurns)
    throw new Error(
      `The run started ${report.modelTurns} model turns, more than the ${team.codexTurns} approved.`,
    );
  if (report.claudeCodeSessions > team.claudeSessions)
    throw new Error(
      `The run opened ${report.claudeCodeSessions} Claude Code sessions, more than the ${team.claudeSessions} approved.`,
    );
  const { stage, candidate, review } = workflow;
  if (stage === "ready-review" && candidate.pendingOutputs.length)
    throw new Error(
      `The build added a file that Topsl holds for an exact-hash review before the review turn: ${candidate.pendingOutputs.join(", ")}. The script approves no file, so no review ran.`,
    );
  if (!review)
    throw new Error(
      `Topsl stopped the workflow at "${stage.replaceAll("-", " ")}" without a review: ${workflow.detail}`,
    );
  if (!review.ofThisBuild)
    throw new Error("Topsl's review is not of the current build.");
  if (stage === "ready-repair") workflow.stoppedAt = "findings";
  else if (stage === "awaiting-acceptance") workflow.stoppedAt = "acceptance";
  else if (stage === "checking") {
    const ran = workflow.checks.at(-1),
      outcome =
        {
          failed: "failed",
          error: "ended in an error",
          cancelled: "was cancelled",
        }[ran?.state] ?? `ended ${ran?.state}`;
    throw new Error(
      ran
        ? `The review found nothing, but the required check ${outcome}${ran.failurePhase ? ` in its ${ran.failurePhase} phase` : ""}${ran.error ? `: ${ran.error}` : "."}`
        : "The review found nothing, but the required check did not run.",
    );
  } else
    throw new Error(
      `Topsl stopped the workflow at "${stage.replaceAll("-", " ")}": ${workflow.detail}`,
    );
}

/**
 * Keeps what Topsl recorded for the workflow: a summary in the report, and
 * the whole record, with the home folder written as ~, in workflow.json.
 */
async function recordWorkflow(projectId, card) {
  const workflow = report.workflow;
  const [inspection, scope] = await Promise.all([
    command({ type: "builder-reviewer-inspect", id: workflow.id }),
    command({ type: "scope-snapshot", projectId }),
  ]);
  const state = inspection.state,
    tasks = scope.coordination.tasks.filter(
      (t) => t.workflowId === workflow.id,
    );
  workflow.stage = state.stage;
  workflow.detail = withoutHome(state.detail);
  // The stages: the build, the review and any repair, each a Codex turn or
  // a Claude Code step. The required check is a task too, but it runs no
  // model.
  workflow.attempts = scope.coordination.attempts
    .filter((a) => tasks.some((t) => t.id === a.taskId && t.role !== "tester"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((attempt) => {
      const task = tasks.find((t) => t.id === attempt.taskId),
        run = scope.runs.find((r) => r.id === attempt.legacyRunId);
      return {
        role:
          task.role === "reviewer"
            ? "review"
            : task.id === state.builderTaskId
              ? "build"
              : "repair",
        provider: (task.role === "reviewer" ? state.reviewer : state.builder)
          .provider,
        state: attempt.state,
        requestedModel: attempt.requestedModel,
        reportedModel: attempt.reportedModel,
        turnStarted: !!run?.nativeTurnId,
        seconds: attempt.finishedAt
          ? Math.round(
              (Date.parse(attempt.finishedAt) - Date.parse(attempt.createdAt)) /
                100,
            ) / 10
          : null,
        usageRecords: scope.usage.filter((u) => u.runId === run?.id).length,
        error: withoutHome(attempt.error),
      };
    });
  report.modelTurns =
    (report.qualification?.turnsStarted ?? 0) +
    workflow.attempts.filter((a) => a.provider === "codex" && a.turnStarted)
      .length;
  // What Topsl recorded for each Claude Code step: its sessions, with the
  // mode and Claude Code version, and each reply handed back.
  const listed = (
    await command({ type: "builder-reviewer-query", projectId })
  ).workflows.find((w) => w.id === workflow.id);
  for (const step of listed?.claudeSteps ?? []) {
    let record = workflow.claudeSteps.find((r) => r.stepId === step.id);
    if (!record)
      workflow.claudeSteps.push(
        (record = { role: step.role, stepId: step.id, run: "not run" }),
      );
    record.topsl = {
      state: step.state,
      replySource: step.replySource,
      detail: withoutHome(step.detail),
      opens: step.opens.map((open) => ({
        sessionId: open.sessionId,
        mode: open.mode,
        runtimeVersion: open.runtimeVersion,
        state: open.state,
        error: withoutHome(open.error),
      })),
      replies: step.replies.map((reply) => ({
        source: reply.source,
        outcome: reply.outcome,
        detail: withoutHome(reply.detail),
      })),
    };
  }
  report.claudeCodeSessions = (listed?.claudeSteps ?? []).reduce(
    (sum, step) => sum + step.opens.length,
    0,
  );
  workflow.claudeProvenance = listed?.claudeProvenance ?? [];
  workflow.candidate = {
    revision: inspection.candidate.revision,
    changes: (inspection.candidate.changes ?? []).map(
      (c) => `${c.kind} ${c.path}`,
    ),
    pendingOutputs: (inspection.candidate.outputs ?? [])
      .filter((o) => o.required && o.status !== "approved")
      .map((o) => `${o.path} (${o.status})`),
  };
  const reviewer = tasks.find((t) => t.id === state.reviewerTaskId);
  workflow.review = state.reviewArtifactId
    ? {
        ofThisBuild: state.reviewedCandidateId === state.candidateId,
        summary: withoutHome(reviewer?.detail ?? null),
        findings: inspection.findings.map((f) => ({
          title: f.title,
          severity: f.severity,
          file: f.file,
          line: f.line,
        })),
        candidateReads: inspection.candidateRetrievals.total,
      }
    : null;
  // Without a review, the reviewer's own messages show what it answered:
  // how many it sent and the last, which is the one Topsl reads.
  const lastReview = scope.coordination.attempts
      .filter((attempt) => attempt.taskId === state.reviewerTaskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1),
    reviewRun = scope.runs.find((run) => run.id === lastReview?.legacyRunId);
  workflow.reviewReply = null;
  if (!workflow.review && reviewRun) {
    const { items } = await command({
        type: "history-page",
        projectId,
        conversationId: reviewRun.conversationId,
        limit: 200,
      }),
      replies = items.filter(
        (m) => m.runId === reviewRun.id && m.role === "assistant",
      );
    // The page lists the newest message first.
    workflow.reviewReply = {
      messages: replies.length,
      last: replies.length ? withoutHome(replies[0].text.slice(0, 4000)) : null,
    };
  }
  workflow.checks = [];
  for (const execution of inspection.checkExecutions) {
    const { logs } = await command({
      type: "check-execution-inspect",
      projectId,
      id: execution.id,
    });
    workflow.checks.push({
      definition: execution.definition.id,
      state: execution.state,
      targetRevision: execution.targetRevision,
      failurePhase: execution.failurePhase ?? null,
      error: withoutHome(execution.error),
      outputEnd: withoutHome(
        logs
          .map((l) => l.text)
          .join("")
          .slice(-600),
      ),
    });
  }
  const file = path.join(output, "workflow.json");
  await writeFile(
    file,
    withoutHome(JSON.stringify(inspection, null, 2)) + "\n",
  );
  workflow.record = tilde(file);
  // The changes and context Topsl shows for the workflow.
  await card
    .getByRole("button", { name: "Inspect changes and context", exact: true })
    .click({ timeout: 10000 })
    .catch(() => {});
  await sleep(1000);
  await screenshot("workflow");
}

/** Locates and trusts the provider's executable, as a user would. */
async function locate(provider, step) {
  const executable = options.executables[provider];
  await app.evaluate(
    (_electron, selection) =>
      Object.assign(globalThis.__liveSession.policy, selection),
    {
      executable,
      executableRealPath: await realpath(executable),
      runtimeKind: provider === "claude" ? "Claude Code" : "Codex CLI",
    },
  );
  const installation = await command({ type: "select-runtime" });
  if (!installation?.appId?.includes(provider))
    throw new Error("Topsl did not record the selected executable.");
  await until("Topsl to list the executable", 30000, async () =>
    (await command({ type: "state" })).installations.some(
      (i) => i.id === installation.id,
    ),
  );
  const trusted = await command({
    type: "trust-installation",
    id: installation.id,
  });
  if (!trusted?.trusted) throw new Error("Topsl did not trust the executable.");
  step.executable = {
    path: tilde(trusted.path),
    realPath: tilde(trusted.realPath),
    version: trusted.version,
    owner: trusted.owner,
    identity: trusted.identity,
  };
  return trusted;
}

try {
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  // Answer only the expected native dialogs, and record every dialog shown.
  await app.evaluate(
    ({ dialog }, policy) => {
      globalThis.__liveSession = { policy, dialogs: [] };
      const optionsOf = (args) => (args.length > 1 ? args[1] : args[0]) ?? {};
      // Topsl's dialog to start a workflow shows its captured inputs as JSON
      // above its explanation. It has to name the workflow, the folder and,
      // for both roles, the provider, runtime and model the script chose, and
      // for a Claude role its terminal route.
      const startsWorkflow = (detail, expected) => {
        let inputs = null;
        try {
          inputs = JSON.parse(
            detail.slice(0, detail.indexOf("\n\nThe captured manifest")),
          );
        } catch {
          return false;
        }
        return (
          inputs.workflowId === expected.workflowId &&
          inputs.workspace === expected.workspace &&
          ["builder", "reviewer"].every((role) =>
            ["provider", "installationId", "model", "route", "effort"].every(
              (key) => inputs[role]?.[key] === expected[role]?.[key],
            ),
          )
        );
      };
      dialog.showOpenDialog = async (...args) => {
        const { policy, dialogs } = globalThis.__liveSession;
        const title = String(optionsOf(args).title ?? "");
        const selected =
          title === "Select a trusted project"
            ? policy.project
            : title === "Choose the native executable"
              ? policy.executable
              : title === "Import an attributed claude transcript"
                ? policy.transcript
                : null;
        dialogs.push({
          dialog: title,
          answer: selected ? "selected" : "Cancel",
        });
        return selected
          ? { canceled: false, filePaths: [selected] }
          : { canceled: true, filePaths: [] };
      };
      const showMessageBox = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        const { policy, dialogs } = globalThis.__liveSession;
        const value = optionsOf(args),
          message = String(value.message ?? ""),
          detail = String(value.detail ?? ""),
          buttons = (value.buttons ?? []).map(String);
        // Allowing one of Codex's requests is the owner's answer. The script
        // shows them Topsl's dialog and keeps the answer with the request's
        // digest; only the stand-in owner answers it here.
        if (message === "Allow this native action once?") {
          const answer = policy.ownerStandIn
            ? {
                response: buttons.indexOf("Allow once"),
                checkboxChecked: false,
              }
            : await showMessageBox.apply(dialog, args);
          dialogs.push({
            dialog: message,
            answer: buttons[answer.response] ?? null,
            by: policy.ownerStandIn ? "owner stand-in" : "owner",
            digest: /\nDigest: ([a-f0-9]{64})$/.exec(detail)?.[1] ?? null,
          });
          return answer;
        }
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
                  : message === "Send the reviewed context to Codex?" &&
                      policy.handoff
                    ? "Send context"
                    : message === policy.qualification?.message &&
                        detail.includes(
                          `\n${policy.executableRealPath}\nModel: ${policy.qualification.model}\n`,
                        ) &&
                        detail.includes(
                          `Topsl will start up to ${policy.qualification.turns} model turns`,
                        ) &&
                        detail.includes(
                          `In a disposable folder in ${policy.qualification.folder} it will:`,
                        )
                      ? "Run qualification"
                      : message ===
                            "Let Topsl read Claude Code's transcripts for workflow steps?" &&
                          policy.transcriptRead
                        ? "Read transcripts"
                        : message === "Approve captured inputs and start?" &&
                            policy.dispatch &&
                            startsWorkflow(detail, policy.dispatch)
                          ? "Approve inputs and start"
                          : message === "Run this required check?" &&
                              policy.check &&
                              detail.startsWith(
                                `Required project check\n\nExecutable: ${policy.check.executable}\nArguments: ${JSON.stringify(policy.check.args)}\nCandidate: ${policy.check.candidate}\n`,
                              )
                            ? "Run check"
                            : null;
        // The handoff approval covers the one message the script sends, the
        // qualification approval one qualification, the transcript approval
        // one change of that setting, and the workflow's approvals one start
        // and one run of its check.
        if (expected === "Send context") policy.handoff = false;
        if (expected === "Read transcripts") policy.transcriptRead = false;
        if (expected === "Run qualification") policy.qualification = null;
        if (expected === "Approve inputs and start") policy.dispatch = null;
        if (expected === "Run check") policy.check = null;
        const response = Math.max(0, buttons.indexOf(expected));
        dialogs.push({ dialog: message, answer: buttons[response] ?? null });
        return { response, checkboxChecked: false };
      };
    },
    {
      project: canonicalProject,
      executable: null,
      executableRealPath: null,
      runtimeKind: null,
      transcript: null,
      handoff: false,
      transcriptRead: false,
      qualification: null,
      dispatch: null,
      check: null,
      ownerStandIn,
    },
  );

  /** Adds the disposable project in Projects, as a user would. */
  const addProject = async () => {
    await navigate(page, "Projects");
    await page
      .getByRole("button", { name: "+ Add project", exact: true })
      .click();
    await appear(
      "the disposable project",
      page.getByRole("heading", { name: "live-project", exact: true }),
    );
    const id = (await command({ type: "state" })).projects.find(
      (p) => p.realPath === canonicalProject,
    )?.id;
    if (!id) throw new Error("Topsl did not add the disposable project.");
    return id;
  };
  let projectId = null,
    handoff = null;
  if (options.workflow) {
    // Each executable the team needs, then the project, with Codex selected
    // in the runtime bar of the project's Sessions when the team has it.
    const runtimes = {};
    for (const provider of teamProviders)
      runtimes[provider] = await locate(
        provider,
        provider === "claude" ? report.claudeCode : report,
      );
    projectId = await addProject();
    await navigate(page, "Sessions");
    await page
      .locator(".runtime-bar select")
      .first()
      .selectOption((runtimes.codex ?? runtimes.claude).id);
    await teamWorkflow(projectId, runtimes);
  } else
    for (const provider of providers) {
      const step = both
        ? (report.steps[provider] = {
            route: routes[provider],
            ...newStep(provider),
          })
        : report;
      const trusted = await locate(provider, step);
      projectId ??= await addProject();
      await navigate(page, "Sessions");
      await page
        .locator(".runtime-bar select")
        .first()
        .selectOption(trusted.id);
      if (provider === "claude")
        handoff = await claudeTerminal(projectId, step);
      else if (options.qualify)
        await codexQualification(projectId, { codex: trusted });
      else if (options.terminal) await codexTerminal(projectId, step);
      else await codexChat(projectId, step, both ? handoff : null);
    }
  report.result = "passed";
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await screenshot("failure").catch(() => {});
  if (terminalOpen)
    await page
      .getByRole("button", { name: "Close session", exact: true })
      .click({ timeout: 5000 })
      .catch(() => {});
} finally {
  report.dialogs = await app
    .evaluate(() => globalThis.__liveSession?.dialogs ?? [])
    .catch(() => report.dialogs);
  await app.close().catch(() => {});
  if (qualificationFolder) {
    await rm(qualificationFolder, { recursive: true, force: true });
    report.qualificationFolderDeleted = true;
  }
  if (projectFolder) {
    await rm(projectFolder, { recursive: true, force: true });
    report.projectFolderDeleted = true;
  }
  if (report.result === "passed" && !options.keepProfile) {
    await rm(profile, { recursive: true, force: true });
    report.profileDeleted = true;
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence: ${tilde(output)}`);
  process.exitCode = report.result === "passed" ? 0 : 1;
}
