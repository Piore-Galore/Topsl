import { navigate, openThread, selectProject } from "./desktop-navigation.mjs";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { standIn, standInAvailable } from "./desktop-stand-in.mjs";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

// Native Topsl sessions (docs/Native_Sessions_Plan.md), driven through
// Topsl's own screens in Electron against a synthetic profile: session setup
// with two peer coordinators, discussion that starts no goal, automatic
// delegation of new work, a manual team override, a second goal continuing
// from the accepted result, both themes, a compact window, and restart. The
// Codex runtime is the scripted stand-in the coordinator journey uses
// (tests/fixtures/codex-desktop-coordinator.cjs); no model or account is
// contacted, and the Opus and Astra labels are fixture catalog entries only.
// The stand-in is a shell wrapper on macOS and Linux and a compiled launcher
// on Windows (scripts/desktop-stand-in.mjs).
if (!standInAvailable()) {
  console.log(
    "Desktop session journey skipped: Windows has no .NET Framework C# compiler for its stand-in.",
  );
  process.exit(0);
}
// TOPSL_PACKAGED_APP runs the journey against a packaged executable, such as
// release/mac-arm64/Topsl.app/Contents/MacOS/Topsl. A packaged app ignores
// TOPSL_TEST_PROFILE, so it gets a disposable --user-data-dir with a seeded
// passphrase vault (no OS keychain item), and HOME, CODEX_HOME and
// CLAUDE_CONFIG_DIR inside the profile. The profile is outside the system
// temporary folders, which a qualification refuses, and its path is short for
// the context socket.
// TOPSL_PACKAGED_APP=release finds this platform's unpacked build there.
const packaged =
  process.env.TOPSL_PACKAGED_APP === "release"
    ? [
        "release/mac-arm64/Topsl.app/Contents/MacOS/Topsl",
        "release/mac/Topsl.app/Contents/MacOS/Topsl",
        "release/win-unpacked/Topsl.exe",
        "release/linux-unpacked/topsl",
      ]
        .map((candidate) => path.resolve(candidate))
        .find((candidate) => existsSync(candidate))
    : process.env.TOPSL_PACKAGED_APP
      ? path.resolve(process.env.TOPSL_PACKAGED_APP)
      : null;
if (process.env.TOPSL_PACKAGED_APP && !packaged)
  throw new Error("No packaged Topsl was found in release/.");
const passphrase = "Topsl packaged session journey";
await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
const profile = packaged
  ? await mkdtemp(path.resolve("node_modules/.cache/tps-"))
  : await mkdtemp(path.join(os.tmpdir(), "topsl-test-session-"));
const desktopEnvironment = packaged
  ? { ...process.env }
  : { ...process.env, TOPSL_TEST_PROFILE: profile };
delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
if (packaged) {
  delete desktopEnvironment.TOPSL_TEST_PROFILE;
  delete desktopEnvironment.TOPSL_TEST_QUALIFICATION_DIR;
  desktopEnvironment.HOME = path.join(profile, "native-home");
  if (process.platform === "win32")
    desktopEnvironment.USERPROFILE = desktopEnvironment.HOME;
  desktopEnvironment.CODEX_HOME = path.join(profile, "native-home", ".codex");
  process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
  // The product's passphrase vault format (apps/desktop/vault.ts).
  const userData = path.join(profile, "user-data");
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    scryptSync(passphrase, salt, 32),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(randomBytes(32).toString("hex"), "utf8"),
    cipher.final(),
  ]);
  await writeFile(
    path.join(userData, "vault.json"),
    JSON.stringify({
      method: "passphrase",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: data.toString("base64"),
    }),
    { mode: 0o600 },
  );
} else {
  const qualificationDirectory = await mkdtemp(
    path.resolve("node_modules/.cache/topsl-qualify-"),
  );
  process.on("exit", () =>
    rmSync(qualificationDirectory, { recursive: true, force: true }),
  );
  desktopEnvironment.TOPSL_TEST_QUALIFICATION_DIR = qualificationDirectory;
}
await mkdir(path.join(profile, "native-home", ".codex"), { recursive: true });
await mkdir(path.join(profile, "claude-config", "projects"), {
  recursive: true,
});
desktopEnvironment.CLAUDE_CONFIG_DIR = path.join(profile, "claude-config");
const project = path.join(profile, "session-project");
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
const launch = async () => {
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [
      ...(process.platform === "linux" && process.env.CI
        ? ["--no-sandbox"]
        : []),
      packaged ? `--user-data-dir=${path.join(profile, "user-data")}` : ".",
    ],
    env: desktopEnvironment,
    timeout: 90000,
  });
  if (packaged) {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await app.firstWindow();
    await page
      .getByRole("textbox", { name: "Vault passphrase" })
      .fill(passphrase);
    await page.getByRole("button", { name: "Unlock / create vault" }).click();
  }
  return app;
};
await mkdir("test-results/sessions", { recursive: true });
const shot = (page, name) =>
  page.screenshot({
    path: `test-results/sessions/${name}.png`,
    fullPage: true,
  });
const noOverflow = (page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

const firstGoal = "Change the value to two in file.ts.";
const secondGoal = "Now add a comment above the value in file.ts.";
const app = await launch();
let projectId = null;
let sessionId = null;
let page = null;
try {
  page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await app.evaluate(({ dialog }, selected) => {
    globalThis.topslOpenPath = selected;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.topslOpenPath],
    });
    // Every native confirmation is answered with its affirmative button.
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  }, project);
  await page
    .getByRole("button", { name: "+ Add project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "session-project", exact: true }),
  ).toBeVisible();
  projectId = (
    await page.evaluate(() => window.topsl.command({ type: "state" }))
  ).projects.find((p) => p.realPath === canonicalProject).id;
  const wrapper = await standIn({
    directory: profile,
    name: "codex-session-fixture",
    script: "tests/fixtures/codex-desktop-coordinator.cjs",
    env: { FIXTURE_TURN_DELAY_MS: 300 },
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
    await window.topsl.command({
      type: "runtime-qualify",
      id,
      model: "fixture-model",
    });
  }, runtime.id);
  const sessionQuery = () =>
    page.evaluate(
      (id) => window.topsl.command({ type: "session-query", sessionId: id }),
      sessionId,
    );
  const goalsQuery = () =>
    page.evaluate(
      ({ projectId, sessionId }) =>
        window.topsl.command({
          type: "orchestration-query",
          projectId,
          conversationId: sessionId,
        }),
      { projectId, sessionId },
    );

  // The stand-in's catalog and account are observed before the picker reads
  // them; a runtime change does not refresh an open project page, so the
  // New session page is opened again.
  await expect
    .poll(
      async () => {
        const view = await page.evaluate(
          (projectId) =>
            window.topsl.command({ type: "orchestration-query", projectId }),
          projectId,
        );
        const codex = view.routes.find((r) => r.provider === "codex");
        return (
          !!codex?.catalog.fresh &&
          !!codex.purposes["coordinator-contribution"]?.ready
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await navigate(page, "Projects");

  // Setup: two peer coordinators from the combined model picker, an
  // automatic team, and a first message in Discuss mode.
  await page.setViewportSize({ width: 1280, height: 900 });
  await selectProject(page, "session-project");
  const home = page.getByRole("region", { name: "New session", exact: true });
  await expect(home.getByRole("radio", { name: /^Session/ })).toBeChecked();
  const picker = home.getByRole("group", { name: "Coordinators" });
  await expect(picker).toContainText("Auto: one coordinator");
  for (const name of ["Opus", "Astra"])
    await picker
      .getByRole("button", { name: `Add ${name} (Codex) as a coordinator` })
      .click();
  await expect(picker.getByRole("listitem").first()).toContainText(
    "prepares the shared wording",
  );
  await expect(
    home.getByRole("radio", { name: "Automatic", exact: true }),
  ).toBeChecked();
  await home.getByRole("radio", { name: "Discuss", exact: true }).check();
  await shot(page, "paper-new-session");
  await home
    .getByRole("textbox", { name: "Message" })
    .fill("How does file.ts hold its value?");
  await home
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const thread = page.getByRole("region", { name: "Session", exact: true });
  const transcript = thread.getByRole("list", { name: "Conversation" });
  await expect(
    transcript.getByRole("listitem").filter({ hasText: "How does file.ts" }),
  ).toBeVisible();
  sessionId = (
    await page.evaluate(
      (projectId) => window.topsl.command({ type: "session-list", projectId }),
      projectId,
    )
  )[0].id;

  // Discussion: one shared response with each coordinator's attributed
  // contribution, and no goal.
  const reply = transcript
    .locator(":scope > li.turn.coordinator")
    .filter({ hasText: "The coordinators agree" });
  await expect(reply).toBeVisible({ timeout: 60000 });
  await reply.locator("summary").click();
  await expect(reply).toContainText("Contributions from 2 coordinators");
  await expect(reply).toContainText("fixture-opus");
  await expect(reply).toContainText("fixture-astra");
  expect((await goalsQuery()).goals).toEqual([]);
  // A discussion-only session is listed in navigation.
  await expect(
    page
      .getByRole("list", { name: "session-project sessions" })
      .getByRole("listitem")
      .filter({ hasText: "How does file.ts hold its value?" }),
  ).toBeVisible();

  // Automatic delegation: a Work message becomes the session's goal.
  const composerMode = thread.getByRole("group", { name: "Composer mode" });
  await composerMode.getByRole("radio", { name: "Work", exact: true }).check();
  await thread.getByRole("textbox", { name: "Message" }).fill(firstGoal);
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  const first = thread.getByRole("article", { name: `Goal ${firstGoal}` });
  await expect(first).toBeVisible({ timeout: 60000 });
  await thread
    .getByRole("group", { name: "Thread panes" })
    .getByRole("button", { name: /^Work/ })
    .click();
  const work = thread.getByRole("complementary", { name: "Work details" });
  await expect(
    work.getByRole("listitem").filter({ hasText: firstGoal }),
  ).toBeVisible();

  // Manual override: the owner pins Reviewers in the session's team.
  await thread
    .getByRole("group", { name: "Thread panes" })
    .getByRole("button", { name: "Team", exact: true })
    .click();
  const team = thread.getByRole("complementary", { name: "Team details" });
  await team
    .getByRole("list", { name: "Session roles" })
    .getByRole("listitem")
    .filter({ hasText: "Reviewers:" })
    .getByRole("button", { name: "Pin role", exact: true })
    .click();
  await expect
    .poll(async () => {
      const s = (await sessionQuery()).session;
      return !!(s.pending?.configuration ?? s.configuration).roles.reviewer;
    })
    .toBe(true);
  await page.setViewportSize({ width: 1200, height: 880 });
  await shot(page, "paper-session-team-docked");

  // The first goal runs to acceptance and is accepted natively.
  await expect(
    first.getByText("Awaiting acceptance", { exact: true }),
  ).toBeVisible({
    timeout: 180000,
  });
  await first
    .getByRole("button", { name: "Accept candidate…", exact: true })
    .click();
  await expect(first.getByText("Accepted", { exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await sessionQuery()).session.acceptedCheckpoint?.goalId ?? null,
    )
    .not.toBeNull();
  // The override reached the session at a round boundary.
  await expect
    .poll(
      async () => !!(await sessionQuery()).session.configuration.roles.reviewer,
    )
    .toBe(true);

  // A second goal continues from the accepted result, which is not applied
  // to the project folder.
  await thread
    .getByRole("combobox", { name: "Target" })
    .selectOption("new")
    .catch(() => {});
  await thread.getByRole("textbox", { name: "Message" }).fill(secondGoal);
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    thread.getByRole("article", { name: `Goal ${secondGoal}` }),
  ).toBeVisible({ timeout: 60000 });
  const view = await sessionQuery();
  // Every message was answered by both selected coordinators.
  console.log(
    "Session intakes:",
    JSON.stringify(
      view.intakes.map((i) => [
        i.text.slice(0, 20),
        i.stage,
        i.members.map((m) => m.memberId),
        i.detail,
      ]),
    ),
  );
  expect(view.intakes.map((i) => i.members.length)).toEqual([2, 2, 2]);
  const [one, two] = view.session.queue;
  expect(one.state).toBe("accepted");
  expect(two.baselineCandidateId).toBeTruthy();
  expect(view.session.acceptedCheckpoint.workItemId).toBe(one.id);
  expect(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    }),
  ).toBe("");

  // Both themes and a compact window keep the session readable.
  for (const theme of ["night", "paper"]) {
    await page.evaluate(
      (theme) => window.topsl.command({ type: "theme", theme }),
      theme,
    );
    await expect(page.locator(`html[data-theme="${theme}"]`)).toHaveCount(1);
    await page.setViewportSize({ width: 1280, height: 900 });
    await shot(page, `${theme}-session`);
    await page.setViewportSize({ width: 560, height: 720 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    expect(await noOverflow(page)).toBe(true);
    await shot(page, `${theme}-session-compact`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Stop the second goal so the restart below has nothing running.
  await thread
    .getByRole("group", { name: "Session controls" })
    .getByRole("button", { name: "Stop session", exact: true })
    .click();
  await expect
    .poll(async () => (await sessionQuery()).session.queue[1].state)
    .toBe("stopped");
} catch (error) {
  if (page) await shot(page, "failure").catch(() => {});
  throw error;
} finally {
  await app.close();
}

// Restart: the session, its transcript, queue and accepted result return.
const reopened = await launch();
try {
  const page = await reopened.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 45000 });
  const thread = page.getByRole("region", { name: "Session", exact: true });
  await expect(
    thread.getByRole("heading", {
      name: "How does file.ts hold its value?",
      exact: true,
    }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    thread.getByRole("article", { name: `Goal ${firstGoal}` }),
  ).toBeVisible();
  const view = await page.evaluate(
    (id) => window.topsl.command({ type: "session-query", sessionId: id }),
    sessionId,
  );
  expect(view.session.queue.map((w) => w.state)).toEqual([
    "accepted",
    "stopped",
  ]);
  expect(view.session.acceptedCheckpoint).not.toBeNull();
  await openThread(page, "session-project", "How does file.ts hold its value?");
} finally {
  await reopened.close();
}
console.log(
  (packaged ? `Packaged (${packaged}) ` : "") +
    "Desktop session journey passed: a session with two pinned Codex stand-in coordinators answered a Discuss message with one shared response and two attributed contributions and no goal; a Work message became the session's goal; a pinned Reviewers role reached the session at a round boundary; the goal was accepted natively; a second goal continued from the accepted result without changing the project folder; night and paper themes and a 560 x 720 window had one heading and no horizontal overflow; stopping the session stopped its goal; and a restart restored the session, its transcript, queue and accepted result. Against a qualified Codex stand-in only.",
);
