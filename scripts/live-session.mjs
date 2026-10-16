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
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import os from "node:os";
import path from "node:path";

// Live acceptance of provider sessions inside Topsl: Claude Code in its native
// terminal, Codex through the structured chat, or both, with Codex continuing
// Claude Code's imported conversation through a reviewed context handoff.
// Unlike the automated suites, this sends one real prompt per provider through
// the selected executable and the native sign-in on this machine, so it counts
// toward that account's usage. Topsl runs from this checkout (after
// `npm run build`) with a new disposable topsl-test-* profile, so the user's
// own Topsl profile is not opened. Only the native dialogs this procedure
// expects are approved. The provider keeps the session in its own history, as
// it does for any native session.

const usage =
  "Usage: node scripts/live-session.mjs [--claude /absolute/path/to/claude] [--codex /absolute/path/to/codex] [--model id] [--output directory] [--keep-profile]\nGive --claude, --codex, or both for a handoff from Claude Code to Codex.";
const options = {
  executables: {},
  model: null,
  output: null,
  keepProfile: false,
};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (
    ["--claude", "--codex"].includes(argument) &&
    !options.executables[argument.slice(2)]
  )
    options.executables[argument.slice(2)] = process.argv[++index];
  else if (argument === "--model") options.model = process.argv[++index];
  else if (argument === "--output") options.output = process.argv[++index];
  else if (argument === "--keep-profile") options.keepProfile = true;
  else throw new Error(usage);
}
// Claude Code runs first, so that Codex can continue its conversation.
const providers = ["claude", "codex"].filter((p) => options.executables[p]);
const both = providers.length === 2;
if (
  !providers.length ||
  providers.some((p) => !path.isAbsolute(options.executables[p])) ||
  (options.model && !options.executables.codex)
)
  throw new Error(usage);
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
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-live-"));
const project = path.join(profile, "live-project");
await mkdir(project);
const canonicalProject = await realpath(project);
const environment = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const removedEnvironment = Object.keys(environment).filter((name) =>
  billing.test(name),
);
for (const name of removedEnvironment) delete environment[name];
const output = path.resolve(
  options.output ??
    path.join(
      "test-results",
      "live-session",
      `${both ? "both" : providers[0]}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
);
await mkdir(output, { recursive: true });

const routes = { claude: "native-terminal", codex: "structured-chat" };
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
// they share.
const report = {
  schemaVersion: 1,
  kind: "topsl-live-session",
  provider: both ? "both" : providers[0],
  route: both ? "handoff" : routes[providers[0]],
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
  ...(both ? { steps: {}, conversation: null } : newStep(providers[0])),
  screenshots: [],
  profile: tilde(profile),
  profileDeleted: false,
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

/**
 * Claude Code in Topsl's native terminal, then the import of its transcript.
 * Returns the imported conversation and the number Claude Code replied with.
 */
async function claudeTerminal(projectId, step) {
  const session = (step.session = {
    folderTrust: "not shown",
    folderTrustReadFrom: null,
    folderTrustDefault: null,
    apiError: null,
    exit: null,
    run: null,
    transcript: null,
    history: null,
  });
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
  const press = async (key) => {
    await focusTerminal();
    await page.keyboard.press(key);
  };

  // Claude Code asks once whether to trust a new folder. A sign-in screen stops
  // the procedure before any prompt is sent. Once escape sequences are removed,
  // Claude Code's words can run together in its raw output (it can move the
  // cursor over blank cells instead of writing spaces), so its prompts are
  // matched against the terminal screen as well.
  const signIn =
    /select login method|please run \/login|not logged in|invalid api key/i;
  const trustPrompt = /trust (the files in )?this folder|do you trust/i;
  // The answer the prompt has selected follows its pointer on the screen.
  const trustAnswer =
    /[❯>]\s*(?:\d+\.\s*)?(yes, i trust this folder|no, exit)/i;
  const selectedLine = (lines) => lines.findIndex((l) => trustAnswer.test(l));
  // Claude Code 2.1.183 selects "Yes, I trust this folder" first, but 2.1.300
  // lists and selects "No, exit" first. The selection is moved to the answer
  // that trusts the folder, which is confirmed only once the screen shows it.
  async function trustFolder() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const lines = (await terminalScreen()).split("\n"),
        yes = lines.findIndex((l) => /yes, i trust this folder/i.test(l)),
        selected = selectedLine(lines);
      if (selected >= 0)
        session.folderTrustDefault ??= trustAnswer.exec(lines[selected])[1];
      if (yes >= 0 && selected === yes) return press("Enter");
      if (yes >= 0 && selected >= 0) {
        await press(selected < yes ? "ArrowDown" : "ArrowUp");
        await until(
          "Claude Code's folder trust prompt to move its selection",
          5000,
          async () =>
            selectedLine((await terminalScreen()).split("\n")) !== selected,
        );
      } else await sleep(500);
    }
    throw new Error(
      "Claude Code's folder trust prompt did not show its answers on the screen.",
    );
  }
  // Below the input, Claude Code shows the shortcuts hint or, in place of it,
  // the permission mode.
  const inputReady =
    /for shortcuts|accept edits on|plan mode on|auto mode on|bypass permissions on/i;
  await until("Claude Code to accept a prompt", 120000, async () => {
    const output = plain(await terminalOutput()),
      text = `${output}\n${await terminalScreen()}`;
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
      await trustFolder();
      session.folderTrust = "accepted";
      return null;
    }
    return inputReady.test(text);
  });
  await screenshot("claude-ready");

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
  await screenshot("claude-reply");

  session.exit = { method: "/exit", code: null };
  await focusTerminal();
  await page.keyboard.type("/exit", { delay: 20 });
  await sleep(500);
  await page.keyboard.press("Enter");
  let exited = await until("Claude Code to exit", 30000, async () =>
    exitPattern.exec(plain(await terminalOutput())),
  ).catch(() => null);
  if (!exited) {
    session.exit.method = "Ctrl+C twice";
    await press("Control+C");
    await sleep(500);
    await press("Control+C");
    exited = await until("Claude Code to exit", 20000, async () =>
      exitPattern.exec(plain(await terminalOutput())),
    ).catch(() => null);
  }
  if (!exited) {
    session.exit.method = "Close session";
    await page
      .getByRole("button", { name: "Close session", exact: true })
      .click();
    exited = await until("the native session to close", 20000, async () =>
      exitPattern.exec(plain(await terminalOutput())),
    ).catch(() => null);
  }
  session.exit.code = exited ? Number(exited[1]) : null;
  terminalOpen = !exited;
  const snapshot = () => command({ type: "scope-snapshot", projectId });
  const terminalRun = (scope) =>
    scope.runs.find((r) => r.conversationId.startsWith("terminal:"));
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
  await page.getByRole("button", { name: "History", exact: true }).click();
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
  if (session.run.status !== "completed" || session.run.openTerminals)
    throw new Error(
      `The native session ended as ${session.run.status ?? "unknown"} with ${session.run.openTerminals} terminal(s) open.`,
    );
  return { conversationId: replies[0].conversationId, reply: Number(expected) };
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
    ...(handoff ? { handoff: null } : {}),
    run: null,
    approvals: [],
    usageRecords: null,
  });
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
  session.model = model;

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
  await composer.locator("select").nth(1).selectOption("review");
  // Topsl asks once before it sends the attached context.
  if (handoff)
    await app.evaluate(() => {
      globalThis.__liveSession.policy.handoff = true;
    });
  const sentAt = Date.now();
  await composer.getByRole("button", { name: /Send to Codex/ }).click();
  report.modelTurns += 1;

  const runOf = (scope) =>
    scope.runs.find((r) => r.conversationId === conversationId);
  const declined = new Set();
  const scope = await until("Codex's reply", 240000, async () => {
    await checkShownErrors();
    const current = await command({ type: "scope-snapshot", projectId }),
      run = runOf(current);
    // Read-only review should need no approval; decline anything requested.
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
  session.run = {
    status: run.status,
    model: run.model,
    runtimeVersion: run.runtimeVersion,
  };
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
    page.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  // Answer only the expected native dialogs, and record every dialog shown.
  await app.evaluate(
    ({ dialog }, policy) => {
      globalThis.__liveSession = { policy, dialogs: [] };
      const optionsOf = (args) => (args.length > 1 ? args[1] : args[0]) ?? {};
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
      dialog.showMessageBox = async (...args) => {
        const { policy, dialogs } = globalThis.__liveSession;
        const value = optionsOf(args),
          message = String(value.message ?? ""),
          detail = String(value.detail ?? ""),
          buttons = (value.buttons ?? []).map(String);
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
                    : null;
        // The handoff approval covers the one message the script sends.
        if (expected === "Send context") policy.handoff = false;
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
    },
  );

  let projectId = null,
    handoff = null;
  for (const provider of providers) {
    const step = both
      ? (report.steps[provider] = {
          route: routes[provider],
          ...newStep(provider),
        })
      : report;
    const trusted = await locate(provider, step);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    if (!projectId) {
      await page
        .getByRole("button", { name: "+ Add project", exact: true })
        .click();
      await appear(
        "the disposable project",
        page.getByRole("heading", { name: "live-project", exact: true }),
      );
      projectId = (await command({ type: "state" })).projects.find(
        (p) => p.realPath === canonicalProject,
      )?.id;
      if (!projectId)
        throw new Error("Topsl did not add the disposable project.");
    }
    await page.locator(".runtime-bar select").first().selectOption(trusted.id);
    if (provider === "claude") handoff = await claudeTerminal(projectId, step);
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
