import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { navigate, selectProject } from "./desktop-navigation.mjs";

const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-atlas-"));
const folder = path.join(profile, "Atlas 项目");
await mkdir(folder);
const output = path.resolve("test-results/atlas");
await mkdir(output, { recursive: true });
const environment = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const launch = () =>
  electron.launch({
    args: [
      ...(process.platform === "linux" && process.env.CI
        ? ["--no-sandbox"]
        : []),
      ".",
    ],
    env: environment,
    timeout: 90000,
  });
const app = await launch();
const errors = [];
const reports = [];
let selectedProject;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await app.evaluate(({ dialog }, folder) => {
    globalThis.atlasFolder = folder;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.atlasFolder],
    });
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  }, folder);
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  // Adding a project opens its New session page, the message box first.
  await expect(page.getByRole("region", { name: "New session" })).toBeVisible();
  await expect(page.getByRole("region", { name: "New session" })).toContainText(
    "Atlas 项目",
  );
  selectedProject = (
    await page.evaluate(() =>
      window.topsl.command({ type: "navigation-query" }),
    )
  ).projectId;
  const shot = async (name) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, name + ".png") });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      name + " has horizontal overflow",
    ).toBe(false);
  };
  for (const theme of ["paper", "night"]) {
    await page.evaluate(
      (theme) => window.topsl.command({ type: "theme", theme }),
      theme,
    );
    for (const view of [
      "New session",
      "All sessions",
      "Project settings",
      "Provider tools",
      "Advanced workflows",
      "Providers",
      "Settings",
      "Projects",
    ]) {
      await navigate(page, view);
      // One page heading and one current location per screen.
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
      await shot(`${theme}-${view.toLowerCase().replaceAll(" ", "-")}`);
    }
    // Measure actual rendered tokens on the root, panel, control and sidebar.
    const contrast = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const color = (name) => css.getPropertyValue(name).trim();
      const luminance = (hex) => {
        const values = hex
          .slice(1)
          .match(/../g)
          .map((pair) => parseInt(pair, 16) / 255)
          .map((v) =>
            v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
          );
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      };
      const ratio = (a, b) => {
        const values = [luminance(color(a)), luminance(color(b))].sort(
          (a, b) => b - a,
        );
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      return {
        brassText: ratio("--brass", "--paper"),
        text: ratio("--ink", "--paper"),
        panelText: ratio("--ink", "--card"),
        muted: ratio("--muted", "--paper"),
        mutedPanel: ratio("--muted", "--card"),
        primary: ratio("--primary-ink", "--primary"),
        good: ratio("--good-ink", "--good-soft"),
        warning: ratio("--warm-ink", "--warm-soft"),
        sidebar: ratio("--sidebar-muted", "--sidebar-bg"),
        selectedSidebar: ratio("--sidebar-ink", "--sidebar-selected"),
        controlBoundary: ratio("--strong-line", "--card"),
        focus: ratio("--accent", "--paper"),
        sidebarBoundary: ratio("--sidebar-line", "--sidebar-bg"),
      };
    });
    for (const [pair, value] of Object.entries(contrast))
      expect(value, `${theme} ${pair}`).toBeGreaterThanOrEqual(
        /Boundary|focus/.test(pair) ? 3 : 4.5,
      );
    reports.push({ theme, contrast });
  }
  // A session: transcript, composer and a detail pane, docked at 1200px and
  // wider and over the transcript below. This journey qualifies no
  // coordinator, so the session reports that no coordinator can answer.
  await navigate(page, "New session");
  const home = page.getByRole("region", { name: "New session" });
  await home
    .getByRole("textbox", { name: "Message" })
    .fill("Chart the harbor before the tide turns.");
  await home
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const thread = page.getByRole("region", { name: "Session", exact: true });
  const transcript = thread.getByRole("list", { name: "Conversation" });
  await expect(
    transcript
      .getByRole("listitem")
      .filter({ hasText: "Chart the harbor before the tide turns." }),
  ).toBeVisible();
  await expect(
    transcript
      .getByRole("listitem")
      .filter({ hasText: "The coordinators cannot answer yet." }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
  await thread
    .getByRole("group", { name: "Thread panes" })
    .getByRole("button", { name: "Team", exact: true })
    .click();
  await expect(
    thread.getByRole("complementary", { name: "Team details" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 880 });
  await shot("night-session-pane-docked");
  await page.setViewportSize({ width: 1199, height: 880 });
  await shot("night-session-pane-overlay");
  await thread
    .getByRole("button", { name: "Close team details", exact: true })
    .click();
  await page.setViewportSize({ width: 1280, height: 880 });
  await navigate(page, "Provider tools");
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect(page.locator(".conversation-heading")).toContainText("Chat 1");
  const prompt = page.locator(".composer > textarea");
  await prompt.fill("A draft survives a journey around the atlas.");
  await navigate(page, "Context");
  await navigate(page, "Provider tools");
  await expect(prompt).toHaveValue(
    "A draft survives a journey around the atlas.",
  );
  // Open a real PTY against a local stand-in; no vendor process or account.
  if (process.platform !== "win32") {
    const runtime = path.join(profile, "codex-atlas");
    await writeFile(
      runtime,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; exit 0; fi\nprintf "Atlas terminal ready\\n"\nexec cat\n',
    );
    await chmod(runtime, 0o700);
    await app.evaluate((_, runtime) => {
      globalThis.atlasFolder = runtime;
    }, runtime);
    const installed = await page.evaluate(() =>
      window.topsl.command({ type: "select-runtime" }),
    );
    await expect
      .poll(async () =>
        (
          await page.evaluate(() => window.topsl.command({ type: "state" }))
        ).installations.some(
          (installation) => installation.id === installed.id,
        ),
      )
      .toBe(true);
    await page.evaluate(
      (id) => window.topsl.command({ type: "trust-installation", id }),
      installed.id,
    );
    await page
      .getByRole("combobox", { name: "Runtime", exact: true })
      .selectOption(installed.id);
    await page
      .getByRole("button", { name: "Native terminal", exact: true })
      .click();
    const terminal = page.locator(".terminal-panel");
    await expect(terminal).toBeVisible();
    const id = await terminal.getAttribute("data-session-id");
    const xterm = await terminal.locator(".xterm").elementHandle();
    await page.evaluate(() =>
      window.topsl.command({ type: "theme", theme: "paper" }),
    );
    await page.evaluate(() =>
      window.topsl.command({ type: "theme", theme: "night" }),
    );
    await navigate(page, "Overview");
    await navigate(page, "Provider tools");
    expect(await terminal.getAttribute("data-session-id")).toBe(id);
    expect(await xterm.evaluate((node) => node.isConnected)).toBe(true);
    await expect(terminal.locator(".xterm-scrollable-element")).toHaveCSS(
      "background-color",
      "rgb(14, 32, 42)",
    );
    await shot("night-terminal");
    await terminal
      .getByRole("button", { name: "Close session", exact: true })
      .click();
  }
  const secondFolder = path.join(profile, "Second harbor");
  await mkdir(secondFolder);
  await app.evaluate((_, folder) => {
    globalThis.atlasFolder = folder;
  }, secondFolder);
  await navigate(page, "Projects");
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  await expect(page.getByRole("region", { name: "New session" })).toContainText(
    "Second harbor",
  );
  // A project opens at its last viewed session.
  await selectProject(page, "Atlas 项目");
  await expect(
    page.getByRole("heading", {
      name: "Chart the harbor before the tide turns.",
      exact: true,
    }),
  ).toBeVisible();
  // Rapid switching lands on the project chosen last, at its own place.
  const tree = page.getByRole("list", { name: "Projects and sessions" });
  for (let round = 0; round < 3; round++) {
    await tree
      .getByRole("button", { name: "Second harbor", exact: true })
      .click();
    await tree.getByRole("button", { name: "Atlas 项目", exact: true }).click();
  }
  await tree
    .getByRole("button", { name: "Second harbor", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "New session" })).toContainText(
    "Second harbor",
  );
  await expect(
    page.getByRole("region", { name: "Session", exact: true }),
  ).toHaveCount(0);
  await selectProject(page, "Atlas 项目");
  await expect(
    page.getByRole("heading", {
      name: "Chart the harbor before the tide turns.",
      exact: true,
    }),
  ).toBeVisible();
  // The project menu by keyboard: open, move, close with Escape, and choose.
  const menuButton = page.getByRole("button", {
    name: "Project menu for Atlas 项目",
  });
  await menuButton.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Atlas 项目 menu" });
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Project settings" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expect(
    menu.getByRole("menuitem", { name: "Advanced workflows" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Advanced workflows", level: 1 }),
  ).toBeVisible();
  await expect(menuButton).toBeFocused();
  // All sessions reaches every session past 200, by pages and by search.
  const atlasProject = selectedProject;
  await page.evaluate(async (projectId) => {
    for (let i = 0; i < 205; i++)
      await window.topsl.command({
        type: "session-create",
        projectId,
        kind: "code",
        mode: "discuss",
        text: `Survey leg ${String(i).padStart(3, "0")}`,
        commandId: `atlas-many-${i}`,
      });
  }, atlasProject);
  await navigate(page, "All sessions");
  const index = page.getByRole("region", { name: "All sessions" });
  await expect(index).toContainText("206 sessions");
  for (let shown = 50; shown < 206; shown += 50)
    await index
      .getByRole("button", { name: `Show more (${shown} of 206)` })
      .click();
  await expect(index.getByRole("listitem")).toHaveCount(206);
  await index
    .getByRole("searchbox", { name: "Search sessions" })
    .or(index.getByRole("textbox", { name: "Search sessions" }))
    .fill("survey leg 007");
  await index.getByRole("button", { name: "Search", exact: true }).click();
  await expect(index).toContainText("1 matching session");
  await index.getByRole("button", { name: "Survey leg 007" }).click();
  await expect(
    page.getByRole("heading", { name: "Survey leg 007", exact: true }),
  ).toBeVisible();
  await selectProject(page, "Atlas 项目");
  await expect(
    page.getByRole("heading", { name: "Survey leg 007", exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 560, height: 720 });
  for (const theme of ["paper", "night"]) {
    await page.evaluate(
      (theme) => window.topsl.command({ type: "theme", theme }),
      theme,
    );
    for (const view of [
      "New session",
      "All sessions",
      "Project settings",
      "Provider tools",
      "Advanced workflows",
      "Providers",
      "Settings",
      "Projects",
    ]) {
      await navigate(page, view);
      await shot(`compact-${theme}-${view.toLowerCase().replaceAll(" ", "-")}`);
    }
    await page.getByRole("button", { name: "Navigation", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Workbench navigation" }),
    ).toBeVisible();
    await shot(`compact-${theme}-navigation`);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Navigation", exact: true }),
    ).toBeFocused();
  }
  await page.setViewportSize({ width: 1280, height: 880 });
  await navigate(page, "Overview");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5),
  );
  await shot("enlarged-advanced-workflows");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await navigate(page, "Provider tools");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.topsl.command({ type: "navigation-query" }),
          )
        ).projectView,
    )
    .toBe("sessions");
  expect(errors).toEqual([]);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        scope:
          "Actual Electron with isolated synthetic profile and local terminal stand-in",
        reports,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await app.close();
}
const reopened = await launch();
try {
  const page = await reopened.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Provider tools", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  expect(
    (
      await page.evaluate(() =>
        window.topsl.command({ type: "navigation-query" }),
      )
    ).projectId,
  ).toBe(selectedProject);
} finally {
  await reopened.close();
  await rm(profile, { recursive: true, force: true });
}
console.log(
  `Atlas desktop passed: all destinations in both themes at standard and compact sizes, rendered palette contrast, draft retention, terminal continuity, per-project resume and rapid project switching, the project menu by keyboard with focus returned, All sessions past 200 sessions by pages and search, native navigation dialog and restart. Evidence: ${output}`,
);
