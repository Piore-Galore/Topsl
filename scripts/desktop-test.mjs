import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  chmod,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-desktop-"));
const desktopEnvironment = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
const project = path.join(profile, "fixture-project");
await mkdir(project);
const canonicalProject = await realpath(project);
const nativeHome = path.join(profile, "native-home");
const nativeCodex = path.join(nativeHome, ".codex");
await mkdir(nativeCodex, { recursive: true });
const discoveredProject = path.join(profile, "discovered-project");
await mkdir(discoveredProject);
const canonicalDiscovered = await realpath(discoveredProject);
const nativeProjects = path.join(nativeCodex, ".codex-global-state.json");
await writeFile(
  nativeProjects,
  JSON.stringify({
    "electron-saved-workspace-roots": [canonicalProject, canonicalDiscovered],
  }),
);
const nativeClaudeText = JSON.stringify({
  projects: {
    [canonicalProject]: { hasTrustDialogAccepted: true },
    [canonicalDiscovered]: { hasTrustDialogAccepted: true },
  },
});
await writeFile(path.join(nativeHome, ".claude.json"), nativeClaudeText);
const transcript = path.join(profile, "fixture.jsonl");
await writeFile(
  transcript,
  [
    {
      type: "session_meta",
      payload: { id: "desktop-fixture-session", cwd: canonicalProject },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "A quartz project fixture." }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Fixture answer preserved with provider attribution.",
          },
        ],
      },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n"),
);
const app = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    ".",
  ],
  env: desktopEnvironment,
  timeout: 90000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await expect(page.getByText("You approve every Topsl update.")).toBeVisible();
  await expect(page.locator(".application-card")).toHaveCount(4);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/applications.png",
    fullPage: true,
  });
  const boundary = await page.evaluate(async () => {
    try {
      await window.topsl.command({
        type: "arbitrary-shell",
        command: "echo forbidden",
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(boundary).toBe(true);
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  }, project);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Add project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "fixture-project", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect(page.locator(".conversation-heading")).toContainText("Chat 1");
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Enable project discovery…", exact: true })
    .click();
  await expect(page.locator(".project-card")).toHaveCount(2);
  const discoveredCard = page.getByRole("article", {
    name: "discovered-project",
    exact: true,
  });
  await expect(discoveredCard).toContainText("Needs trust");
  await expect(discoveredCard).toContainText("Codex desktop saved folders");
  await expect(discoveredCard).toContainText("Claude shared project metadata");
  await discoveredCard
    .getByRole("button", { name: "Trust folder…", exact: true })
    .click();
  await expect(discoveredCard).toContainText("Trusted folder");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/projects.png", fullPage: true });
  await page
    .getByRole("button", { name: "Pause discovery", exact: true })
    .click();
  const externalProject = path.join(profile, "external-project");
  await mkdir(externalProject);
  await writeFile(
    nativeProjects,
    JSON.stringify({
      "electron-saved-workspace-roots": [
        canonicalProject,
        canonicalDiscovered,
        await realpath(externalProject),
      ],
    }),
  );
  await expect(
    page.getByRole("button", { name: "Refresh projects", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Enable project discovery…", exact: true })
    .click();
  await expect(page.locator(".project-card")).toHaveCount(3);
  expect(await readFile(path.join(nativeHome, ".claude.json"), "utf8")).toBe(
    nativeClaudeText,
  );
  await page
    .getByRole("textbox", { name: "Filter projects", exact: true })
    .fill("discovered-project");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Filter projects", exact: true })
    .fill("");
  if (process.platform !== "win32") {
    // Native shell wrapper is a test fixture only; shipped code never generates executables.
    const fixtureExecutable = path.join(profile, "codex-project-fixture");
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(
      fixtureExecutable,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/projects.cjs"))} "$@"\n`,
    );
    await chmod(fixtureExecutable, 0o700);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, fixtureExecutable);
    const installation = await page.evaluate(() =>
      window.topsl.command({ type: "select-runtime" }),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.topsl.command({ type: "state" })))
            .installations.length,
      )
      .toBe(1);
    await page.evaluate(
      (id) => window.topsl.command({ type: "trust-installation", id }),
      installation.id,
    );
    const registry = page.getByRole("region", {
      name: "Codex project synchronization",
    });
    await registry
      .getByRole("combobox", { name: "Codex sync runtime" })
      .selectOption(installation.id);
    await registry.getByRole("button", { name: "Enable Codex sync…" }).click();
    await expect(registry).toContainText("Registry synced");
    await registry
      .locator("summary")
      .filter({ hasText: "registered projects" })
      .click();
    await expect(registry.locator(".native-project-row")).toHaveCount(2);
    const nativeRow = registry
      .locator(".native-project-row")
      .filter({ hasText: "discovered-project" });
    await nativeRow
      .getByRole("button", { name: "Rename", exact: true })
      .click();
    await nativeRow
      .getByRole("textbox", { name: "Rename discovered-project", exact: true })
      .fill("Renamed shared project");
    await nativeRow
      .getByRole("button", { name: "Save name", exact: true })
      .click();
    await expect(
      registry
        .locator(".native-project-row")
        .filter({ hasText: "Renamed shared project" }),
    ).toBeVisible();
    await registry
      .getByRole("button", {
        name: "Move Renamed shared project up",
        exact: true,
      })
      .click();
    await expect(registry.locator(".native-project-row").first()).toContainText(
      "Renamed shared project",
    );
    await registry
      .getByRole("button", { name: "Pause Codex sync", exact: true })
      .click();
    await expect(registry).toContainText("Paused");
    await registry.getByRole("button", { name: "Enable Codex sync…" }).click();
    await expect(registry).toContainText("Registry synced");
    await expect(registry.locator(".native-project-row")).toHaveCount(2);
    await page.screenshot({
      path: "test-results/codex-projects.png",
      fullPage: true,
    });
    await registry
      .locator("summary")
      .filter({ hasText: "registered projects" })
      .click();
    const requests = (
      await readFile(
        path.join(nativeCodex, "topsl-project-requests.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.every(
        (r) => r.method === "initialize" || r.method.startsWith("project/"),
      ),
    ).toBe(true);
  }
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, transcript);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "Import Codex JSONL", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Imported codex/ }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search project history" })
    .fill("quartz");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".history-result")).toContainText(
    "A quartz project fixture.",
  );
  await page.getByRole("button", { name: "Open conversation →" }).click();
  await page.getByRole("button", { name: "Prepare handoff" }).click();
  await expect(page.getByRole("dialog")).toContainText("user · codex");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Night", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await page
    .getByRole("button", { name: "Project instructions", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Native configuration text" })
    .fill("Fixture instructions for a temporary test project.");
  await page
    .getByRole("button", { name: "Preview changes", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Fixture instructions");
  await page
    .getByRole("button", { name: "Apply reviewed file…", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await readFile(path.join(project, "AGENTS.md"), "utf8")).toBe(
    "Fixture instructions for a temporary test project.",
  );
  const grant = await page.evaluate(async () => {
    const state = await window.topsl.command({ type: "state" });
    return window.topsl.command({
      type: "context-enable",
      projectId: state.projects.find(
        (project) => project.name === "fixture-project",
      ).id,
    });
  });
  const context = JSON.parse(
    execFileSync(
      process.execPath,
      [grant.companionPath, "status", grant.file],
      { encoding: "utf8", timeout: 10000 },
    ),
  );
  expect(context.readOnly).toBe(true);
  expect(context.administrativeAuthority).toBe(false);
  await page.getByRole("button", { name: "Paper", exact: true }).click();
  await page.setViewportSize({ width: 800, height: 650 });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/projects-compact.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Applications", exact: true }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: "test-results/compact.png", fullPage: true });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+k" : "Control+k",
  );
  await expect(
    page.getByRole("dialog", { name: "Command palette" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
  console.log(
    "Desktop passed: protected vault, catalog, typed IPC, shared project discovery/deduplication/trust/pause/refresh, Codex registry create/rename/order/pause/resume (macOS/Linux), history import/search, handoff, configuration approval, themes, compact layout, command palette.",
  );
  console.log(`Isolated test profile: ${profile}`);
} finally {
  await app.close();
}
// Reopening the same encrypted vault must retain the native project and imported messages.
const reopened = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    ".",
  ],
  env: desktopEnvironment,
  timeout: 90000,
});
try {
  const page = await reopened.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Applications", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  const state = await page.evaluate(() =>
    window.topsl.command({ type: "state" }),
  );
  expect(state.projects).toHaveLength(3);
  expect(state.projectSync.enabled).toBe(true);
  expect(
    state.projects.find((project) => project.realPath === canonicalDiscovered)
      .trusted,
  ).toBe(true);
  expect(
    state.projects.find((project) => project.name === "external-project")
      .trusted,
  ).toBe(false);
  expect(state.messages).toHaveLength(2);
  if (process.platform !== "win32") {
    expect(state.codexProjectSync.enabled).toBe(true);
    expect(state.codexProjectSync.status).toBe("ready");
    expect(state.codexProjectSync.projects.map((p) => p.name)).toEqual([
      "Renamed shared project",
      "fixture-project",
    ]);
  }
  const bytes = await readFile(path.join(profile, "history.sqlite"));
  expect(bytes.includes(Buffer.from("quartz project fixture"))).toBe(false);
  console.log("Encrypted restart persistence passed.");
} finally {
  await reopened.close();
}
