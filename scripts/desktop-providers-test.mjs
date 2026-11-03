import { navigate, selectProject } from "./desktop-navigation.mjs";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { standIn } from "./desktop-stand-in.mjs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Qualifying providers from Providers and using both on New session
// (docs/UX_Cleanup_Plan.md, follow-up of 3 November 2026), driven through
// Topsl's own screens in Electron against a synthetic profile. Codex and
// Claude Code start connected and trusted but not qualified. The coordinator
// list says in one line why each cannot coordinate, with no sideways
// scrolling and no clipped Add button. Providers qualifies Codex with a
// reported model and, after turning on Claude Code's structured route,
// Claude Code with a model id. New session then lists the Claude model, and
// a session starts with a Claude and a Codex coordinator and a custom team
// that includes a role the owner writes; the Claude coordinator and a role
// member each get an effort level, which reaches Claude Code as --effort.
// The runtimes are stand-ins
// (tests/fixtures/codex-desktop-coordinator.cjs and claude-qualify.cjs); no
// model or account is contacted.
// The Claude stand-in's qualification needs a POSIX shell, as in
// tests/campaign-claude-codex.test.ts, so the journey does not run on Windows.
// Not part of `npm run test:desktop`'s default list; run it with
// `npm run test:desktop -- scripts/desktop-providers-test.mjs`.
if (process.platform === "win32") {
  console.log("Skipped on Windows: the Claude stand-in needs a POSIX shell.");
  process.exit(0);
}
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-providers-"));
await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
const qualificationDirectory = await mkdtemp(
  path.resolve("node_modules/.cache/topsl-qualify-"),
);
process.on("exit", () => {
  rmSync(profile, { recursive: true, force: true });
  rmSync(qualificationDirectory, { recursive: true, force: true });
});
const desktopEnvironment = {
  ...process.env,
  TOPSL_TEST_PROFILE: profile,
  TOPSL_TEST_QUALIFICATION_DIR: qualificationDirectory,
  CLAUDE_CONFIG_DIR: path.join(profile, "claude-config"),
};
delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
// Topsl refuses to start Claude Code while a billing variable is set, as
// scripts/test.mjs explains; an agent's own shell may export one.
for (const name of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
])
  delete desktopEnvironment[name];
await mkdir(path.join(profile, "claude-config", "projects"), {
  recursive: true,
});
const project = path.join(profile, "providers-project");
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
await mkdir("test-results/providers", { recursive: true });
const shot = (page, name) =>
  page.screenshot({
    path: `test-results/providers/${name}.png`,
    fullPage: true,
  });
/** Nothing on the page, and no list or button in it, is wider than its box. */
const fits = (page) =>
  page.evaluate(() => ({
    page: document.documentElement.scrollWidth <= window.innerWidth,
    clipped: [
      ...document.querySelectorAll(
        ".model-options, .model-options button, .picked-coordinators button, .team-setup",
      ),
    ]
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => `${e.tagName}.${e.className}`),
  }));

const app = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    ".",
  ],
  env: desktopEnvironment,
  timeout: 90000,
});
let page = null;
try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await app.evaluate(({ dialog }, selected) => {
    globalThis.topslOpenPath = selected;
    globalThis.topslRuntime = 1;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.topslOpenPath],
    });
    // Locating a runtime answers with the provider set below; every other
    // native confirmation is answered with its affirmative button.
    dialog.showMessageBox = async (...args) => ({
      response:
        args.at(-1).message === "Which runtime are you locating?"
          ? globalThis.topslRuntime
          : 1,
      checkboxChecked: false,
    });
  }, project);
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  const home = page.getByRole("region", { name: "New session", exact: true });
  await expect(home).toContainText("providers-project");
  const projectId = (
    await page.evaluate(() => window.topsl.command({ type: "state" }))
  ).projects.find((p) => p.realPath === canonicalProject).id;

  // Both runtimes located and trusted; Codex connected with its models.
  const locate = async (file, runtime) => {
    await app.evaluate(
      (_, [file, runtime]) => {
        globalThis.topslOpenPath = file;
        globalThis.topslRuntime = runtime;
      },
      [file, runtime],
    );
    const located = await page.evaluate(() =>
      window.topsl.command({ type: "select-runtime" }),
    );
    await expect
      .poll(async () =>
        (
          await page.evaluate(() => window.topsl.command({ type: "state" }))
        ).installations.some((i) => i.id === located.id),
      )
      .toBe(true);
    await page.evaluate(
      (id) => window.topsl.command({ type: "trust-installation", id }),
      located.id,
    );
    return located.id;
  };
  const codexId = await locate(
    await standIn({
      directory: profile,
      name: "codex-providers-fixture",
      script: "tests/fixtures/codex-desktop-coordinator.cjs",
    }),
    1,
  );
  // Each Claude Code run's arguments, to see the effort a turn was given.
  const claudeLog = path.join(profile, "claude-runs.jsonl");
  await locate(
    await standIn({
      directory: profile,
      name: "claude-providers-fixture",
      script: "tests/fixtures/claude-qualify.cjs",
      env: { FIXTURE_LOG: claudeLog },
    }),
    2,
  );
  await page.evaluate(async (id) => {
    await window.topsl.command({ type: "runtime-connect", id });
    await window.topsl.command({ type: "runtime-models", id });
  }, codexId);

  // Unqualified: one line per runtime saying why, no Add, nothing clipped.
  const summary = home.getByRole("button", { name: /^Coordinator:/ });
  await summary.click();
  const claudeModels = home.getByRole("region", {
    name: "Claude Code coordinator models",
  });
  const codexModels = home.getByRole("region", {
    name: "Codex coordinator models",
  });
  await expect(claudeModels).toContainText(
    "Claude Code's structured route is off. Turn it on under Providers, then qualify a model.",
    { timeout: 30000 },
  );
  await expect(claudeModels).toContainText("No Claude model is qualified yet");
  await expect(codexModels).toContainText(
    "Not qualified yet. Qualify it under Providers.",
  );
  // One visible line; the runtime's own blocker text stays folded away.
  await expect(codexModels.locator(".model-group-reason")).toHaveText([
    "Not qualified yet. Qualify it under Providers.",
  ]);
  expect(
    await codexModels
      .locator("details.model-group-details")
      .getAttribute("open"),
  ).toBeNull();
  await expect(
    codexModels.getByRole("button", {
      name: "Add Opus (Codex) as a coordinator",
    }),
  ).toBeDisabled();
  for (const width of [1100, 820]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => fits(page)).toEqual({ page: true, clipped: [] });
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  await shot(page, "new-session-unqualified");
  await codexModels.getByRole("button", { name: "Open Providers" }).click();

  // Codex: one of its reported models.
  const codexQualification = page.getByRole("region", {
    name: "Codex qualification",
  });
  await expect(codexQualification.locator(".badge")).toHaveText(
    "Not qualified",
  );
  await codexQualification
    .getByRole("combobox", { name: "Codex model to qualify" })
    .selectOption("fixture-model");
  await codexQualification
    .getByRole("button", { name: "Qualify Codex runtime" })
    .click();
  await expect(codexQualification.getByRole("status")).toContainText(
    "Recorded until",
    { timeout: 60000 },
  );
  await expect(codexQualification.locator(".badge")).toHaveText("Qualified", {
    timeout: 10000,
  });

  // Claude Code: the route from Providers, Connect / test, then a model id.
  const claudeQualification = page.getByRole("region", {
    name: "Claude qualification",
  });
  await claudeQualification
    .getByRole("button", { name: "Turn on structured route…" })
    .click();
  await page
    .locator("article.application-card")
    .filter({ hasText: "Claude Code" })
    .getByRole("button", { name: "Connect / test" })
    .click();
  const connection = page.getByRole("dialog", { name: "Native connection" });
  await expect(connection).toContainText(
    "Connected. No model request was sent.",
    { timeout: 30000 },
  );
  await expect(connection).toContainText("Claude Code has no model list.");
  await connection.getByRole("button", { name: "Close dialog" }).click();
  const claudeModel = claudeQualification.getByRole("textbox", {
    name: "Claude model to qualify",
  });
  await claudeModel.fill("claude-opus-5-5");
  await claudeQualification
    .getByRole("button", { name: "Qualify Claude runtime" })
    .click();
  await expect(claudeQualification.getByRole("status")).toContainText(
    "Claude Code reported model claude-opus-5-5.",
    { timeout: 60000 },
  );
  await expect(claudeQualification.locator(".badge")).toHaveText("Qualified", {
    timeout: 10000,
  });
  await expect(claudeQualification).toContainText(
    "Qualified Claude models: claude-opus-5-5.",
  );
  expect((await fits(page)).page).toBe(true);
  await shot(page, "providers-qualified");

  // New session: both providers ready, a mixed pair of coordinators, and a
  // custom team with a project role and the owner's own role.
  await navigate(page, "Projects");
  await selectProject(page, "providers-project");
  const picker = home.getByRole("group", { name: "Coordinators" });
  await expect(picker).toBeVisible();
  await expect(claudeModels.locator(".badge")).toHaveText("Ready");
  await expect(codexModels.locator(".badge")).toHaveText("Ready");
  await picker
    .getByRole("button", {
      name: "Add claude-opus-5-5 (Claude Code) as a coordinator",
    })
    .click();
  await picker
    .getByRole("button", { name: "Add Opus (Codex) as a coordinator" })
    .click();
  await expect(summary).toContainText("Coordinator: claude-opus-5-5, Opus");
  // Effort: the levels Claude Code's --help lists, chosen per coordinator.
  const claudeEffort = picker.getByRole("combobox", {
    name: "Effort for claude-opus-5-5",
  });
  await expect(claudeEffort.locator("option")).toHaveText([
    "Default effort",
    "Low effort",
    "Medium effort",
    "High effort",
    "Xhigh effort",
    "Max effort",
  ]);
  await claudeEffort.selectOption("high");
  await expect(summary).toContainText("claude-opus-5-5 (high)");
  await home.getByRole("radio", { name: "Custom", exact: true }).check();
  await home.getByRole("checkbox", { name: "Implementation" }).check();
  const ownRole = home.locator("details.own-role-create");
  if ((await ownRole.getAttribute("open")) === null)
    await ownRole.locator("summary").click();
  await home.getByRole("textbox", { name: "Role title" }).fill("API writer");
  await home
    .getByRole("textbox", { name: "What this role does" })
    .fill("Reviews the HTTP handlers against the OpenAPI file.");
  await home
    .getByRole("combobox", { name: "Kind of work" })
    .selectOption("candidate-review");
  await home.getByRole("button", { name: "Add role", exact: true }).click();
  await expect(summary).toContainText("Team: Custom (2)");
  expect(await fits(page)).toEqual({ page: true, clipped: [] });
  await shot(page, "new-session-custom");
  await home.getByRole("radio", { name: "Discuss", exact: true }).check();
  await home
    .getByRole("textbox", { name: "Message" })
    .fill("How does file.ts hold its value?");
  await home
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const thread = page.getByRole("region", { name: "Session", exact: true });
  await expect(
    thread.locator("li.turn.coordinator").filter({ hasText: "Contributions" }),
  ).toContainText("Contributions from 2 coordinators", { timeout: 60000 });
  const sessionId = (
    await page.evaluate(
      (projectId) => window.topsl.command({ type: "session-list", projectId }),
      projectId,
    )
  )[0].id;
  const query = await page.evaluate(
    (sessionId) => window.topsl.command({ type: "session-query", sessionId }),
    sessionId,
  );
  const { coordinators, team, roles } = query.session.configuration;
  expect(
    coordinators.map((c) => [c.pin.provider, c.pin.model, c.pin.effort]),
  ).toEqual([
    ["claude", "claude-opus-5-5", "high"],
    ["codex", "fixture-opus", undefined],
  ]);
  // The Claude coordinator's turns ran with --effort high; the qualification
  // turns before them ran with none.
  const { readFileSync } = await import("node:fs");
  const prints = readFileSync(claudeLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((args) => args.includes("--print"));
  const efforts = prints.map((args) =>
    args.includes("--effort") ? args[args.indexOf("--effort") + 1] : null,
  );
  expect(efforts.slice(0, 4)).toEqual([null, null, null, null]);
  expect(efforts.slice(4).length).toBeGreaterThan(0);
  expect(new Set(efforts.slice(4))).toEqual(new Set(["high"]));
  expect(team).toBe("custom");
  const ownId = Object.keys(roles).find((id) => id.startsWith("api-writer-"));
  expect(Object.keys(roles).sort()).toEqual([ownId, "implementer"].sort());
  expect(roles[ownId]).toEqual({
    settings: {},
    title: "API writer",
    instructions: "Reviews the HTTP handlers against the OpenAPI file.",
    purpose: "candidate-review",
  });
  expect(query.roles.find((r) => r.role.id === ownId)).toMatchObject({
    owned: true,
    pinned: true,
  });
  await thread
    .getByRole("group", { name: "Thread panes" })
    .getByRole("button", { name: /^Team/ })
    .click();
  const pane = page.getByRole("complementary", { name: "Team details" });
  await expect(pane).toContainText("API writer:");
  await expect(pane).toContainText("this session's role");
  await expect(pane).toContainText("claude-opus-5-5 · high effort");
  // A role member's effort, in the Team pane's role editor.
  await pane
    .getByRole("listitem")
    .filter({ hasText: "Implementation:" })
    .getByRole("button", { name: "Edit" })
    .click();
  const editor = pane.locator(".role-editor");
  await editor
    .getByRole("textbox", { name: "Search models across providers" })
    .fill("claude-opus-5-5");
  await editor.getByRole("button", { name: "Add selected model" }).click();
  await editor
    .getByRole("combobox", { name: "Effort for claude-opus-5-5" })
    .selectOption("max");
  await editor.getByRole("button", { name: "Save implementation" }).click();
  await expect
    .poll(async () => {
      const after = await page.evaluate(
        (sessionId) =>
          window.topsl.command({ type: "session-query", sessionId }),
        sessionId,
      );
      return after.session.configuration.roles.implementer?.settings.members?.map(
        (m) => [m.pin?.model, m.pin?.effort],
      );
    })
    .toEqual([["claude-opus-5-5", "max"]]);
  await shot(page, "session-team");
  console.log(
    "Providers journey passed: both runtimes qualified from Providers, and a session started with a Claude and a Codex coordinator and the owner's own role; the Claude coordinator's high effort reached Claude Code as --effort, and a role member saved a max effort.",
  );
} catch (error) {
  if (page) await shot(page, "failure").catch(() => {});
  throw error;
} finally {
  await app.close();
}
