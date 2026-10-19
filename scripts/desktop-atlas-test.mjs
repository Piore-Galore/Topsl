import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { navigate } from "./desktop-navigation.mjs";

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
  await page
    .getByRole("button", { name: "+ Add project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Atlas 项目", exact: true }),
  ).toBeVisible();
  selectedProject = await page
    .getByRole("combobox", { name: "Selected project", exact: true })
    .inputValue();
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
      "Overview",
      "Sessions",
      "Coordinator",
      "Tasks",
      "Changes",
      "Context",
      "History",
      "Synchronization",
      "Applications",
      "Settings",
      "Projects",
    ]) {
      await navigate(page, view);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await shot(`${theme}-${view.toLowerCase()}`);
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
  await navigate(page, "Sessions");
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect(page.locator(".conversation-heading")).toContainText("Chat 1");
  const prompt = page.locator(".composer > textarea");
  await prompt.fill("A draft survives a journey around the atlas.");
  await navigate(page, "Context");
  await navigate(page, "Sessions");
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
    await navigate(page, "Sessions");
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
  await page
    .getByRole("button", { name: "+ Add project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Second harbor", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Selected project", exact: true })
    .selectOption(selectedProject);
  await expect(
    page.getByRole("heading", { name: "Atlas 项目", exact: true }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 560, height: 720 });
  for (const theme of ["paper", "night"]) {
    await page.evaluate(
      (theme) => window.topsl.command({ type: "theme", theme }),
      theme,
    );
    for (const view of [
      "Overview",
      "Sessions",
      "Coordinator",
      "Tasks",
      "Changes",
      "Context",
      "History",
      "Synchronization",
      "Applications",
      "Settings",
      "Projects",
    ]) {
      await navigate(page, view);
      await shot(`compact-${theme}-${view.toLowerCase()}`);
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
  await shot("enlarged-overview");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await navigate(page, "History");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.topsl.command({ type: "navigation-query" }),
          )
        ).projectView,
    )
    .toBe("history");
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
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await expect(
    page.getByRole("combobox", { name: "Selected project", exact: true }),
  ).toHaveValue(selectedProject);
} finally {
  await reopened.close();
  await rm(profile, { recursive: true, force: true });
}
console.log(
  `Atlas desktop passed: all destinations in both themes at standard and compact sizes, rendered palette contrast, draft retention, terminal continuity, native navigation dialog and restart. Evidence: ${output}`,
);
