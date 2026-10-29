import { navigate, openThread } from "./desktop-navigation.mjs";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { standIn, standInAvailable } from "./desktop-stand-in.mjs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// A project's coordinator conversations, driven through Topsl's
// own screens in Electron against a synthetic profile. The Codex runtime is a
// scripted stand-in (tests/fixtures/codex-desktop-coordinator.cjs) that is
// registered, connected and qualified through typed IPC as the main desktop
// test does through the setup screen; no model or account is contacted, and
// the Opus, Astra, Fable and Sol labels are fixture catalog entries only.
// The stand-in is a shell wrapper on macOS and Linux and a compiled launcher
// on Windows (scripts/desktop-stand-in.mjs).
if (!standInAvailable()) {
  console.log(
    "Desktop coordinator journey skipped: Windows has no .NET Framework C# compiler for its stand-in.",
  );
  process.exit(0);
}
const profile = await mkdtemp(
  path.join(os.tmpdir(), "topsl-test-coordinator-"),
);
const desktopEnvironment = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
// A qualification refuses the temporary folders that hold the profile.
await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
const qualificationDirectory = await mkdtemp(
  path.resolve("node_modules/.cache/topsl-qualify-"),
);
process.on("exit", () =>
  rmSync(qualificationDirectory, { recursive: true, force: true }),
);
desktopEnvironment.TOPSL_TEST_QUALIFICATION_DIR = qualificationDirectory;
const nativeHome = path.join(profile, "native-home");
await mkdir(path.join(nativeHome, ".codex"), { recursive: true });
await mkdir(path.join(profile, "claude-config", "projects"), {
  recursive: true,
});
desktopEnvironment.CLAUDE_CONFIG_DIR = path.join(profile, "claude-config");
// A Git project, because a code goal's baseline is a Git snapshot.
const project = path.join(profile, "coordinator-project");
await mkdir(project);
const canonicalProject = await realpath(project);
await writeFile(path.join(project, "file.ts"), "export const value = 1;\n");
const git = (args) =>
  execFileSync("git", args, { cwd: project, stdio: "ignore" });
git(["init", "-q"]);
git(["add", "file.ts"]);
git([
  "-c",
  "user.email=fixture@example.test",
  "-c",
  "user.name=Fixture",
  "commit",
  "-qm",
  "base",
]);
const launch = () =>
  electron.launch({
    args: [
      ...(process.platform === "linux" && process.env.CI
        ? ["--no-sandbox"]
        : []),
      ".",
    ],
    env: desktopEnvironment,
    timeout: 90000,
  });
await mkdir("test-results", { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: `test-results/${name}.png`, fullPage: true });

/** The persisted meaning of a role group: what the owner chose, without the
 * member IDs and provenance that differ between the editor and a message. */
const meaning = (group) => ({
  form: group.form,
  total: group.form === "exact" ? group.members.length : (group.count ?? null),
  pins: group.members
    .filter((m) => m.pin)
    .map((m) => ({ label: m.pin.label ?? m.pin.model, required: m.required })),
  autoSlots:
    (group.form === "exact" ? group.members.length : (group.count ?? 0)) -
    group.members.filter((m) => m.pin).length,
});

const app = await launch();
const errors = [];
let projectId = null;
let persisted = null;
let page = null;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await navigate(page, "Applications");
  // Every native confirmation is recorded and answered with its affirmative
  // button, as the owner would.
  await app.evaluate(({ dialog }, selected) => {
    globalThis.topslConfirmations = [];
    globalThis.topslOpenPath = selected;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.topslOpenPath],
    });
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.topslConfirmations.push({
        message: options.message,
        detail: options.detail ?? "",
        buttons: options.buttons,
      });
      return { response: 1, checkboxChecked: false };
    };
  }, project);
  const confirmations = () => app.evaluate(() => globalThis.topslConfirmations);
  await navigate(page, "Projects");
  await page
    .getByRole("button", { name: "+ Add project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "coordinator-project", exact: true }),
  ).toBeVisible();
  projectId = (
    await page.evaluate(() => window.topsl.command({ type: "state" }))
  ).projects.find((p) => p.realPath === canonicalProject).id;

  // The Codex stand-in, registered, connected, catalogued and qualified.
  const wrapper = await standIn({
    directory: profile,
    name: "codex-coordinator-fixture",
    script: "tests/fixtures/codex-desktop-coordinator.cjs",
    env: { FIXTURE_TURN_DELAY_MS: 1200 },
  });
  await app.evaluate((_, selected) => {
    globalThis.topslOpenPath = selected;
  }, wrapper);
  const runtime = await page.evaluate(() =>
    window.topsl.command({ type: "select-runtime" }),
  );
  await expect
    .poll(async () =>
      (
        await page.evaluate(() => window.topsl.command({ type: "state" }))
      ).installations.some((i) => i.id === runtime.id),
    )
    .toBe(true);
  await page.evaluate(async (id) => {
    await window.topsl.command({ type: "trust-installation", id });
    await window.topsl.command({ type: "runtime-connect", id });
    await window.topsl.command({ type: "runtime-models", id });
  }, runtime.id);
  const qualification = await page.evaluate(
    (id) =>
      window.topsl.command({
        type: "runtime-qualify",
        id,
        model: "fixture-model",
      }),
    runtime.id,
  );
  expect(qualification).not.toBeNull();

  // Usage remaining: both native read paths, with local stand-ins, and an
  // owner-set budget saved and removed on screen.
  await navigate(page, "Applications");
  const usage = page.getByRole("region", { name: "Usage remaining" });
  const codexUsage = usage.getByRole("article", {
    name: "Codex usage remaining",
  });
  const claudeUsage = usage.getByRole("article", {
    name: "Claude usage remaining",
  });
  await expect(codexUsage.locator(".badge")).toHaveText("Reported · current");
  await expect(codexUsage).toContainText("Weekly window");
  await expect(codexUsage).toContainText("88% left · 12% used, as reported");
  await expect(codexUsage).toContainText("plan fixture");
  await expect(codexUsage).toContainText("Credits");
  await expect(codexUsage).not.toContainText("fixture-account");
  await expect(claudeUsage.locator(".badge")).toHaveText("Not reported");
  await expect(claudeUsage).toContainText(
    "Remaining: unknown. Claude has not reported its allowance to Topsl yet.",
  );
  await expect(claudeUsage).toContainText("/usage");
  // Select a Claude native-only runtime through the same owner controls.
  await writeFile(path.join(profile, "claude-config", "usage-fixture"), "");
  const claudeWrapper = await standIn({
    directory: profile,
    name: "claude-usage-fixture",
    script: "tests/fixtures/claude-usage.cjs",
  });
  await app.evaluate(({ dialog }, selected) => {
    globalThis.topslOpenPath = selected;
    const previous = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.message === "Which runtime are you locating?")
        return { response: 2, checkboxChecked: false };
      return previous(...args);
    };
  }, claudeWrapper);
  const claudeRuntime = await page.evaluate(() =>
    window.topsl.command({ type: "select-runtime" }),
  );
  await expect
    .poll(async () =>
      (
        await page.evaluate(() => window.topsl.command({ type: "state" }))
      ).installations.some(
        (installation) => installation.id === claudeRuntime.id,
      ),
    )
    .toBe(true);
  await page.evaluate(
    async ({ runtimeId, projectId }) => {
      await window.topsl.command({ type: "trust-installation", id: runtimeId });
      await window.topsl.command({ type: "project-trust", id: projectId });
    },
    { runtimeId: claudeRuntime.id, projectId },
  );
  await claudeUsage
    .getByRole("button", { name: "Refresh from Claude", exact: true })
    .click();
  await expect(claudeUsage.locator(".badge")).toHaveText("Reported · current");
  await expect(claudeUsage).toContainText("87% left · 13% used, as reported");
  await expect(claudeUsage).toContainText("49% left · 51% used, as reported");
  await expect(claudeUsage).toContainText("Current week (Fable)");
  await expect(claudeUsage).toContainText("Resets 1:29am (Asia/Shanghai)");
  await expect(claudeUsage).not.toContainText("private@example");
  await codexUsage
    .getByRole("button", { name: "Refresh from Codex", exact: true })
    .click();
  await expect(
    codexUsage.getByRole("button", { name: "Refresh from Codex", exact: true }),
  ).toBeEnabled();
  await expect(codexUsage.getByRole("alert")).toHaveCount(0);
  await expect(
    codexUsage.getByRole("status", { name: "Codex owner-set budget" }),
  ).toHaveText("No owner-set budget.");
  await codexUsage
    .locator("summary", { hasText: "Set your own budget for Codex" })
    .click();
  await codexUsage
    .getByRole("spinbutton", { name: "Tokens per period", exact: true })
    .fill("5000");
  await codexUsage
    .getByRole("combobox", { name: "Period", exact: true })
    .selectOption("day");
  await codexUsage
    .getByRole("button", { name: "Save budget", exact: true })
    .click();
  await expect(
    codexUsage.getByRole("status", { name: "Codex owner-set budget" }),
  ).toHaveText(
    "Owner-set budget: 5,000 tokens today. Topsl observed 0 known tokens · 5,000 tokens left · no runs in Topsl yet.",
  );
  await page.screenshot({
    path: "test-results/usage-remaining.png",
    fullPage: true,
  });
  await codexUsage
    .getByRole("button", { name: "Remove budget", exact: true })
    .click();
  await expect(
    codexUsage.getByRole("status", { name: "Codex owner-set budget" }),
  ).toHaveText("No owner-set budget.");
  expect(
    (await page.evaluate(() => window.topsl.command({ type: "state" })))
      .providerBudgets,
  ).toEqual([]);
  const query = () =>
    page.evaluate(
      (projectId) =>
        window.topsl.command({ type: "orchestration-query", projectId }),
      projectId,
    );
  const routes = (await query()).routes;
  expect(routes.map((route) => route.provider).sort()).toEqual([
    "claude",
    "codex",
  ]);
  const codexRoute = routes.find((route) => route.provider === "codex");
  const claudeRoute = routes.find((route) => route.provider === "claude");
  for (const purpose of Object.values(claudeRoute.purposes))
    expect(purpose.ready).toBe(false);
  for (const purpose of Object.values(codexRoute.purposes))
    expect(purpose).toEqual({ ready: true, blockers: [] });

  await page.setViewportSize({ width: 1280, height: 900 });
  // Adding the project opened its New session page; the sidebar's
  // New session returns there from a conversation.
  await navigate(page, "New session");
  const home = page.getByRole("region", { name: "New session" });
  await expect(
    home.getByRole("heading", { name: "coordinator-project", exact: true }),
  ).toBeVisible();
  const defaults = home.locator("details", {
    has: page.getByText("Project role defaults", { exact: true }),
  });
  const editor = home.locator("fieldset.role-editor");
  const members = (title) =>
    editor.getByRole("list", { name: `${title} members`, exact: true });
  /** The project's defaults, edited on the New session page. */
  const openDefaults = async (title) => {
    if (!(await home.count())) await navigate(page, "New session");
    if ((await defaults.getAttribute("open")) === null)
      await defaults.locator("summary").click();
    await defaults
      .getByRole("listitem")
      .filter({ hasText: `${title}:` })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await expect(editor.locator("legend")).toHaveText(
      new RegExp(`^${title}: `),
    );
  };
  const add = async (name) => {
    await editor
      .getByLabel("Model picker")
      .selectOption({ label: `${name} (fixture-${name.toLowerCase()})` });
    await editor
      .getByRole("button", { name: "Add selected model", exact: true })
      .click();
  };
  const member = (title, label) =>
    members(title).getByRole("listitem").filter({ hasText: label });
  const projectGroup = async (roleId) =>
    meaning((await query()).roles.find((r) => r.role.id === roleId).group);
  const goalGroup = async (goalId, roleId) =>
    (await query()).goals
      .find((g) => g.goal.id === goalId)
      .groups.find((x) => x.roleId === roleId);

  // UI-01, conversation path: a goal starts its own conversation and is
  // paused, and its reviewers are then pinned, trimmed and partly returned
  // to Auto by follow-up messages in that conversation alone.
  const goalText = "Change the value to two in file.ts.";
  await home.getByRole("textbox", { name: "Message" }).fill(goalText);
  await home
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const section = page.getByRole("region", {
    name: "Session",
    exact: true,
  });
  await expect(
    section.getByRole("heading", { name: goalText, exact: true }),
  ).toBeVisible();
  /** Returns to the goal's conversation from the sidebar. */
  const openGoal = async () => {
    if (!(await section.count()))
      await openThread(page, "coordinator-project", goalText);
    await expect(section).toBeVisible();
  };
  const message = section.getByRole("textbox", { name: "Message" });
  /** Every message of the session has been answered by its coordinators. */
  const answered = async () => {
    const sessions = await page.evaluate(
      (projectId) => window.topsl.command({ type: "session-list", projectId }),
      projectId,
    );
    const views = await Promise.all(
      sessions.map((s) =>
        page.evaluate(
          (sessionId) =>
            window.topsl.command({ type: "session-query", sessionId }),
          s.id,
        ),
      ),
    );
    return views.every((v) =>
      v.intakes.every(
        (i) => !["collecting", "reconciling", "endorsing"].includes(i.stage),
      ),
    );
  };
  const send = async (text) => {
    await openGoal();
    await message.fill(text);
    await section.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      section
        .getByRole("list", { name: "Conversation" })
        .getByRole("listitem")
        .filter({ hasText: text }),
    ).toBeVisible();
    // The coordinators decide what the message does before it takes effect.
    await expect.poll(answered, { timeout: 60000 }).toBe(true);
  };
  await expect(
    section
      .getByRole("list", { name: "Conversation" })
      .getByRole("listitem")
      .filter({ hasText: goalText }),
  ).toBeVisible();
  const goal = section.getByRole("article", { name: `Goal ${goalText}` });
  await expect(goal).toBeVisible();
  const goalControls = section.getByRole("group", { name: "Goal controls" });
  await goalControls
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await expect(goal.getByText("Paused", { exact: true })).toBeVisible();
  await expect(
    goalControls.getByRole("button", { name: "Resume" }),
  ).toBeVisible();
  const goalId = (await query()).goals[0].goal.id;
  const reviewerLine = goal
    .locator(".team-summary li")
    .filter({ hasText: "Reviewers:" });

  // Add and pin: three reviewers by name, in the conversation and the editor.
  await send("Change the reviewers. Review with Astra, Sol and Fable.");
  await expect(reviewerLine).toContainText("Reviewers: Astra + Sol + Fable");
  await openDefaults("Reviewers");
  await editor.getByLabel("Selection").selectOption("exact");
  for (const name of ["Astra", "Sol", "Fable"]) await add(name);
  await expect(members("Reviewers").getByRole("listitem")).toHaveCount(3);
  await expect(editor.locator("legend")).toHaveText(
    "Reviewers: Astra + Sol + Fable",
  );
  await editor.getByRole("button", { name: "Save reviewers" }).click();
  const pinned3 = {
    form: "exact",
    total: 3,
    pins: ["Astra", "Sol", "Fable"].map((label) => ({
      label,
      required: true,
    })),
    autoSlots: 0,
  };
  await expect.poll(() => projectGroup("reviewer")).toEqual(pinned3);
  expect(meaning((await goalGroup(goalId, "reviewer")).group)).toEqual(pinned3);

  // Remove: Fable leaves the roster.
  await send("Change the reviewers. Review with Astra and Sol.");
  await expect(reviewerLine).toContainText("Reviewers: Astra + Sol");
  await openDefaults("Reviewers");
  await member("Reviewers", "Fable")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(members("Reviewers").getByRole("listitem")).toHaveCount(2);
  await editor.getByRole("button", { name: "Save reviewers" }).click();
  const pinned2 = { ...pinned3, total: 2, pins: pinned3.pins.slice(0, 2) };
  await expect.poll(() => projectGroup("reviewer")).toEqual(pinned2);
  expect(meaning((await goalGroup(goalId, "reviewer")).group)).toEqual(pinned2);

  // Return one member to Auto: Sol's slot stays, chosen automatically.
  await send("Change the reviewers. Use two reviewers; include Astra.");
  await expect(reviewerLine).toContainText("Reviewers: Astra + 1 Auto");
  await openDefaults("Reviewers");
  await member("Reviewers", "Sol")
    .getByRole("button", { name: "Return to Auto", exact: true })
    .click();
  await expect(member("Reviewers", "Auto slot")).toHaveCount(1);
  await expect(editor.locator("legend")).toHaveText("Reviewers: Astra + Auto");
  await editor.getByRole("button", { name: "Save reviewers" }).click();
  const astraPlusAuto = {
    form: "required-plus-auto",
    total: 2,
    pins: [{ label: "Astra", required: true }],
    autoSlots: 1,
  };
  await expect.poll(() => projectGroup("reviewer")).toEqual(astraPlusAuto);
  expect(meaning((await goalGroup(goalId, "reviewer")).group)).toEqual(
    astraPlusAuto,
  );
  // Neither path leaves an open slot inside an exact roster.
  expect(
    (await query()).roles.find((r) => r.role.id === "reviewer").group.conflicts,
  ).toEqual([]);
  expect((await goalGroup(goalId, "reviewer")).group.conflicts).toEqual([]);

  // The whole role back to Auto, from the editor; the editor shows it.
  await editor
    .getByRole("button", { name: "Return whole role to Auto", exact: true })
    .click();
  await expect
    .poll(() => projectGroup("reviewer"))
    .toEqual({ form: "auto", total: null, pins: [], autoSlots: 0 });
  await expect(editor.locator("legend")).toHaveText("Reviewers: Auto");
  await expect(members("Reviewers").getByRole("listitem")).toHaveCount(0);
  await shot(page, "coordinator-ui01-editor");

  // The plan's own example, in one message and in the editor: coordinate
  // with Opus and Astra, review with Fable and Sol.
  await send(
    "Change the team. Coordinate with Opus and Astra, review with Fable and Sol.",
  );
  const coordinatorLine = goal
    .locator(".team-summary li")
    .filter({ hasText: "Coordinators:" });
  await expect(coordinatorLine).toContainText("Coordinators: Opus + Astra");
  await expect(reviewerLine).toContainText("Reviewers: Fable + Sol");
  await shot(page, "coordinator-ui01-thread");
  for (const [title, roleId, names] of [
    ["Coordinators", "coordinator", ["Opus", "Astra"]],
    ["Reviewers", "reviewer", ["Fable", "Sol"]],
  ]) {
    await openDefaults(title);
    await editor.getByLabel("Selection").selectOption("exact");
    for (const name of names) await add(name);
    await editor
      .getByRole("button", { name: `Save ${title.toLowerCase()}` })
      .click();
    const expected = {
      form: "exact",
      total: 2,
      pins: names.map((label) => ({ label, required: true })),
      autoSlots: 0,
    };
    await expect.poll(() => projectGroup(roleId)).toEqual(expected);
    expect(meaning((await goalGroup(goalId, roleId)).group)).toEqual(expected);
  }
  await expect(
    defaults.getByRole("listitem").filter({ hasText: "Coordinators:" }),
  ).toContainText("Coordinators: Opus + Astra");
  await expect(
    defaults.getByRole("listitem").filter({ hasText: "Reviewers:" }),
  ).toContainText("Reviewers: Fable + Sol");
  await shot(page, "coordinator-ui01-conversation");

  // The goal runs to "awaiting acceptance" with the conversation's team:
  // round progress and member cards in the Plan pane while it runs, then
  // the review group.
  await openGoal();
  await goalControls
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await section
    .getByRole("group", { name: "Thread panes" })
    .getByRole("button", { name: "Plan", exact: true })
    .click();
  const planPane = section.getByRole("complementary", { name: "Plan details" });
  const coordinatorRound = planPane.getByRole("region", {
    name: "coordinator round",
  });
  await expect(coordinatorRound.locator(".member-card")).toHaveCount(2, {
    timeout: 60000,
  });
  await expect(coordinatorRound.locator("p").first()).not.toBeEmpty();
  await expect(coordinatorRound).toContainText("Decision rule: 2 of 2");
  for (const [name, model] of [
    ["Opus", "fixture-opus"],
    ["Astra", "fixture-astra"],
  ])
    await expect(
      coordinatorRound.locator(".member-card").filter({ hasText: name }),
    ).toContainText(`Requested: ${name} (${model}) · codex`);
  await shot(page, "coordinator-round");
  await expect(
    goal.getByText("Awaiting acceptance", { exact: true }),
  ).toBeVisible({ timeout: 180000 });
  const reviewRound = planPane.getByRole("region", { name: "reviewer round" });
  const reviewCards = reviewRound.locator(".member-card");
  await expect(reviewCards).toHaveCount(2);
  for (const [name, model] of [
    ["Fable", "fixture-fable"],
    ["Sol", "fixture-sol"],
  ]) {
    const card = reviewCards.filter({ hasText: `${name} (${model})` });
    await expect(card).toContainText("Pinned");
    await expect(card).toContainText(`Effective: ${model}`);
  }
  await expect(reviewRound.locator("p").first()).not.toBeEmpty();
  const view = await query();
  const finished = view.goals.find((g) => g.goal.id === goalId);
  const review = finished.rounds.filter((r) => r.kind === "review").at(-1);
  await expect(reviewRound.locator("p").first()).toHaveText(review.progress);
  expect(review.members.map((m) => m.effectiveModel).sort()).toEqual([
    "fixture-fable",
    "fixture-sol",
  ]);
  const coordination = finished.rounds
    .filter((r) => r.kind === "coordination")
    .at(-1);
  expect(coordination.members.map((m) => m.requestedModel).sort()).toEqual([
    "fixture-astra",
    "fixture-opus",
  ]);
  await shot(page, "coordinator-awaiting-acceptance");

  // Acceptance through Topsl's native dialog, naming the review evidence.
  await goal
    .getByRole("button", { name: "Accept candidate…", exact: true })
    .click();
  await expect(goal.getByText("Accepted", { exact: true })).toBeVisible();
  // An accepted code goal offers Apply, and the sidebar says so.
  await expect(
    goal.getByRole("button", { name: "Apply to project folder…", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("list", { name: "coordinator-project sessions" })
      .getByRole("listitem")
      .filter({ hasText: goalText }),
  ).toContainText("Apply");
  const acceptance = (await confirmations()).findLast(
    (c) => c.message === "Accept this reviewed candidate?",
  );
  expect(acceptance.buttons).toEqual(["Cancel", "Accept candidate"]);
  expect(acceptance.detail).toContain("Change the value to two in file.ts.");
  expect(acceptance.detail).toContain("Review group:");
  expect(acceptance.detail).toContain(
    "This goal has no required checks; acceptance rests on the review group's evidence only.",
  );
  // Acceptance records the decision; the project folder is not changed.
  expect(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    }),
  ).toBe("");

  // UI-02: a fifth reviewer is added and edited in a compact window by
  // keyboard alone, in one role, with counts that follow the actual list.
  await page.setViewportSize({ width: 560, height: 720 });
  await openDefaults("Reviewers");
  /** Moves focus to `target` with Tab or Shift+Tab only. */
  const focusByTab = async (target) => {
    await target.scrollIntoViewIfNeeded();
    for (let step = 0; step < 300; step++) {
      const position = await target.evaluate((node) =>
        node === document.activeElement
          ? 0
          : document.activeElement.compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_PRECEDING
            ? -1
            : 1,
      );
      if (position === 0) return;
      await page.keyboard.press(position < 0 ? "Shift+Tab" : "Tab");
    }
    throw new Error("The control was not reachable by Tab.");
  };
  const press = async (target, key = "Enter") => {
    await focusByTab(target);
    await page.keyboard.press(key);
  };
  // Focus starts in the model search; everything after is the keyboard. A
  // search that narrows to one model selects it in the picker.
  const search = editor.getByLabel("Search models across providers");
  await search.focus();
  for (const model of ["fixture-model", "fixture-opus", "fixture-astra"]) {
    await focusByTab(search);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(model);
    await expect(editor.getByLabel("Model picker")).toHaveValue(
      new RegExp(`:${model}$`),
    );
    await press(
      editor.getByRole("button", { name: "Add selected model", exact: true }),
    );
  }
  const listed = members("Reviewers").getByRole("listitem");
  await expect(listed).toHaveCount(5);
  await expect(editor.locator("legend")).toHaveText(
    "Reviewers: Fable + Sol + Fixture + Opus + Astra",
  );
  await expect(editor).toContainText(
    "5 members listed of 5; limit 8 per role.",
  );
  const fifth = listed.nth(4);
  await expect(fifth).toContainText("5. Astra · codex");
  // The fifth member is configured on its own: optional, then Auto.
  await press(fifth.getByRole("checkbox", { name: "Required" }), "Space");
  await expect(
    fifth.getByRole("checkbox", { name: "Required" }),
  ).not.toBeChecked();
  await press(fifth.getByRole("button", { name: "Return to Auto" }));
  await expect(fifth).toContainText("5. Auto slot");
  await expect(editor.locator("legend")).toHaveText(
    "Reviewers: Fable + Sol + Fixture + Opus + Auto",
  );
  await expect(editor).toContainText(
    "5 members listed of 5; limit 8 per role.",
  );
  // The count is the actual list; no smaller "at most" sits beside it.
  await expect(editor.getByLabel("Exact count")).toHaveValue("5");
  await expect(editor.getByLabel("At most")).toHaveCount(0);
  for (let index = 0; index < 4; index++)
    await expect(
      listed.nth(index).getByRole("checkbox", { name: "Required" }),
    ).toBeChecked();
  // Every member's controls are on screen once scrolled to, and the
  // compact page does not scroll sideways.
  for (let index = 0; index < 5; index++) {
    const remove = listed.nth(index).getByRole("button", { name: "Remove" });
    await remove.scrollIntoViewIfNeeded();
    await expect(remove).toBeInViewport();
  }
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await shot(page, "coordinator-ui02-compact");
  await press(editor.getByRole("button", { name: "Save reviewers" }));
  const five = {
    form: "required-plus-auto",
    total: 5,
    pins: ["Fable", "Sol", "Fixture", "Opus"].map((label) => ({
      label,
      required: true,
    })),
    autoSlots: 1,
  };
  await expect.poll(() => projectGroup("reviewer")).toEqual(five);
  const saved = (await query()).roles.find((r) => r.role.id === "reviewer");
  // One group of five, not pairs: one revision holds every member.
  expect(saved.group.members).toHaveLength(5);
  expect(saved.group.conflicts).toEqual([]);
  expect(saved.group.members.at(-1)).toMatchObject({
    pin: null,
    required: false,
  });
  await expect(
    defaults.getByRole("listitem").filter({ hasText: "Reviewers:" }),
  ).toContainText("Reviewers: Fable + Sol + Fixture + Opus + Auto");
  // The open conversation is restored after a restart.
  await page.setViewportSize({ width: 1280, height: 900 });
  await openGoal();
  await expect(page.locator("header.topbar > span").first()).toHaveText(
    `coordinator-project / ${goalText}`,
  );
  expect(errors).toEqual([]);
  const final = await query();
  persisted = {
    project: Object.fromEntries(
      ["coordinator", "reviewer"].map((roleId) => [
        roleId,
        final.roles.find((r) => r.role.id === roleId).group.members,
      ]),
    ),
    goal: final.goals.find((g) => g.goal.id === goalId).goal.state,
  };
} catch (error) {
  console.error(`Desktop coordinator failure profile: ${profile}`);
  if (errors.length) console.error("Renderer failures:", errors);
  // The goals' rounds and attempts as the service holds them.
  if (page && projectId)
    console.error(
      JSON.stringify(
        await page
          .evaluate(async (projectId) => {
            const view = await window.topsl.command({
              type: "orchestration-query",
              projectId,
            });
            return view.goals.map((g) => ({
              state: g.goal.state,
              detail: g.goal.detail,
              actions: g.actions.map((a) => [a.taskKey, a.state, a.detail]),
              rounds: g.rounds.map((r) => ({
                kind: r.kind,
                stage: r.stage,
                progress: r.progress,
                members: r.members.map((m) => [m.memberId, m.state, m.detail]),
              })),
            }));
          }, projectId)
          .catch((e) => e.message),
        null,
        1,
      ),
    );
  throw error;
} finally {
  await app.close();
}
// The encrypted store keeps both paths' settings and the decision.
const reopened = await launch();
try {
  const page = await reopened.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 45000 });
  await expect(
    page
      .getByRole("region", { name: "Session", exact: true })
      .getByRole("heading", {
        name: "Change the value to two in file.ts.",
        exact: true,
      }),
  ).toBeVisible({ timeout: 30000 });
  const view = await page.evaluate(
    (projectId) =>
      window.topsl.command({ type: "orchestration-query", projectId }),
    projectId,
  );
  for (const roleId of ["coordinator", "reviewer"])
    expect(view.roles.find((r) => r.role.id === roleId).group.members).toEqual(
      persisted.project[roleId],
    );
  expect(persisted.goal).toBe("accepted");
  expect(view.goals[0].goal.state).toBe("accepted");
  expect(
    view.goals[0].groups
      .filter((g) => ["coordinator", "reviewer"].includes(g.roleId))
      .map((g) => g.group.members.map((m) => m.pin?.label)),
  ).toEqual([
    ["Opus", "Astra"],
    ["Fable", "Sol"],
  ]);
} finally {
  await reopened.close();
}
console.log(
  "Desktop coordinator journey passed: UI-01 role editor and conversation produce the same persisted settings for pin, remove and return to Auto, and the whole role returns to Auto; a goal from the conversation runs to awaiting acceptance with coordinator and reviewer member cards and round progress, and is accepted through Topsl's native dialog; UI-02 a fifth reviewer is added and edited by keyboard in a 560 x 720 window with counts that follow the list; settings survive a restart; Applications shows the stand-in's reported Codex allowance, Claude's as unavailable in Topsl, and an owner-set Codex budget saved and removed. Against a qualified Codex stand-in only.",
);
