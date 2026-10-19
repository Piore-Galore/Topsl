import { navigate } from "./desktop-navigation.mjs";
import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  chmod,
  appendFile,
} from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-desktop-"));
const desktopEnvironment = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
// A qualification refuses the temporary folders that hold the profile, and
// runs on macOS and Linux only.
let qualificationDirectory = null;
if (process.platform !== "win32") {
  await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
  const directory = await mkdtemp(
    path.resolve("node_modules/.cache/topsl-qualify-"),
  );
  qualificationDirectory = directory;
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  desktopEnvironment.TOPSL_TEST_QUALIFICATION_DIR = directory;
}
const project = path.join(profile, "fixture-project");
await mkdir(project);
const canonicalProject = await realpath(project);
// The four workflow teams below each change their own module, which a
// required check expects to export 2.
const teams = [
  ["codex", "codex"],
  ["claude", "codex"],
  ["codex", "claude"],
  ["claude", "claude"],
];
for (const [builder, reviewer] of teams) {
  await writeFile(
    path.join(project, `${builder}-${reviewer}.mjs`),
    "export const value = 1;\n",
  );
  await writeFile(
    path.join(project, `${builder}-${reviewer}.test.mjs`),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "./${builder}-${reviewer}.mjs";\ntest("the value is two", () => assert.equal(value, 2));\n`,
  );
}
// Claude Code's configuration folder for this profile, where the transcript
// a workflow step's reply is read from is written.
const claudeConfig = path.join(profile, "claude-config");
await mkdir(path.join(claudeConfig, "projects"), { recursive: true });
desktopEnvironment.CLAUDE_CONFIG_DIR = claudeConfig;
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
let desktopBenchmark = null;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible({ timeout: 45000 });
  await navigate(page, "Applications");
  await expect(page.getByText("You approve every Topsl update.")).toBeVisible();
  await expect(page.locator(".application-catalog .application-card")).toHaveCount(4);
  // A test profile never searches for applications, and says so. An
  // application without a native build for this platform keeps its own label.
  await expect(page.getByText("This is a test profile.")).toBeVisible();
  const { applications, platform } = await page.evaluate(() =>
    window.topsl.command({ type: "state" }),
  );
  const badges = page.locator(".application-catalog .application-card .badge");
  await expect(badges.filter({ hasText: "Not searched" })).toHaveCount(
    applications.filter((application) =>
      application.platforms.includes(platform.split("/")[0]),
    ).length,
  );
  await expect(badges.filter({ hasText: "Not found" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "↻ Discover" })).toBeDisabled();
  // A new profile has no stored theme, so Topsl follows the computer.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
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
  await navigate(page, "Projects");
  await page
    .getByRole("button", { name: "+ Add project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "fixture-project", exact: true }),
  ).toBeVisible();
  await navigate(page, "Sessions");
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect(page.locator(".conversation-heading")).toContainText("Chat 1");
  await navigate(page, "Projects");
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
  await navigate(page, "History");
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
  // Phase 5 acceptance uses only disposable JSONL sources and coordinator records.
  const benchmarkMemoryBefore = await app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .map((metric) => ({ type: metric.type, memory: metric.memory })),
  );
  const stateBeforeBench = await page.evaluate(() =>
    window.topsl.command({ type: "state" }),
  );
  const projectIds = [canonicalProject, canonicalDiscovered].map(
    (root) =>
      stateBeforeBench.projects.find((project) => project.realPath === root).id,
  );
  const streamFixtures = [];
  for (let stream = 0; stream < 4; stream++) {
    const root = stream % 2 ? canonicalDiscovered : canonicalProject;
    const file = path.join(profile, `history-benchmark-${stream}.jsonl`);
    const records = [
      {
        type: "session_meta",
        payload: { id: `benchmark-session-${stream}`, cwd: root },
      },
      ...Array.from({ length: 25000 }, (_, index) => ({
        type: "response_item",
        payload: {
          type: "message",
          role: index % 2 ? "assistant" : "user",
          content: [
            {
              type: index % 2 ? "output_text" : "input_text",
              text: `Benchmark stream ${stream} · message ${index} · 测量 · ${"x".repeat(120)}`,
            },
          ],
        },
      })),
    ];
    await writeFile(
      file,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, file);
    const imported = await page.evaluate(
      ({ projectId }) =>
        window.topsl.command({
          type: "history-import",
          projectId,
          provider: "codex",
        }),
      { projectId: projectIds[stream % 2] },
    );
    expect(imported.imported).toBe(25000);
    streamFixtures.push({
      file,
      projectId: projectIds[stream % 2],
      conversationId: imported.conversationId,
      stream,
    });
  }
  await navigate(page, "Sessions");
  await page
    .getByRole("combobox", { name: "Conversation", exact: true })
    .selectOption(streamFixtures[0].conversationId);
  await expect(page.locator(".virtual-message")).toHaveCount(20);
  await expect(
    page.getByRole("combobox", { name: "Runtime", exact: true }),
  ).toHaveValue("");
  await page.locator(".virtual-transcript").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator(".virtual-transcript")).toContainText(
    "message 24999",
  );
  const historyQueries = [];
  for (let sample = 0; sample < 30; sample++)
    historyQueries.push(
      await page.evaluate(async (projectId) => {
        const begin = performance.now();
        const result = await window.topsl.command({
          type: "history-page",
          projectId,
          limit: 80,
        });
        if (result.items.length !== 80)
          throw new Error("Scoped benchmark page missing");
        return performance.now() - begin;
      }, projectIds[0]),
    );
  const streamLatency = [];
  for (const fixture of streamFixtures)
    await appendFile(
      fixture.file,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: `Late stream ${fixture.stream} · isolated scoped update`,
            },
          ],
        },
      }) + "\n",
    );
  const reconciledAt = await page.evaluate(
    async ({ projectIds, selected }) => {
      const sources = (
        await Promise.all(
          projectIds.map((projectId) =>
            window.topsl.command({ type: "synchronization-query", projectId }),
          ),
        )
      )
        .flatMap((value) => value.historySources)
        .filter((source) => source.selectedFile.includes("history-benchmark-"));
      await Promise.all(
        sources.map((source) =>
          window.topsl.command({
            type: "native-history-reconcile",
            requestId: crypto.randomUUID(),
            projectId: source.projectId,
            id: source.id,
            expectedRevision: source.revision,
          }),
        ),
      );
      return performance.now();
    },
    { projectIds, selected: streamFixtures[0].conversationId },
  );
  await expect(page.locator(".virtual-transcript")).toContainText(
    "Late stream 0",
  );
  expect(await page.locator(".virtual-transcript").textContent()).not.toContain(
    "Late stream 1",
  );
  streamLatency.push(
    await page.evaluate((begin) => performance.now() - begin, reconciledAt),
  );
  const selectedCommandToRender = [];
  for (let sample = 0; sample < 5; sample++) {
    const fixture = streamFixtures[0],
      text = `Selected fixture update ${sample}`;
    await appendFile(
      fixture.file,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      }) + "\n",
    );
    const source = await page.evaluate(
      async (projectId) =>
        (
          await window.topsl.command({
            type: "synchronization-query",
            projectId,
          })
        ).historySources.find((source) =>
          source.selectedFile.endsWith("history-benchmark-0.jsonl"),
        ),
      fixture.projectId,
    );
    const begin = Date.now();
    await page.evaluate(
      (source) =>
        window.topsl.command({
          type: "native-history-reconcile",
          requestId: crypto.randomUUID(),
          projectId: source.projectId,
          id: source.id,
          expectedRevision: source.revision,
        }),
      source,
    );
    await expect(page.locator(".virtual-transcript")).toContainText(text);
    selectedCommandToRender.push(Date.now() - begin);
  }
  const coordination = await page.evaluate(
    (projectId) =>
      window.topsl.command({ type: "coordination-query", projectId }),
    projectIds[0],
  );
  const workflow = await page.evaluate(
    (projectId) =>
      window.topsl.command({
        type: "workflow-create",
        requestId: crypto.randomUUID(),
        projectId,
        objective: "Unicode fixture coordination",
        template: "desktop-fixture",
        templateVersion: "1",
      }),
    projectIds[0],
  );
  const task = await page.evaluate(
    ({ projectId, workspaceId, workflowId }) =>
      window.topsl.command({
        type: "task-create",
        requestId: crypto.randomUUID(),
        projectId,
        workspaceId,
        workflowId,
        title: "Inspect Unicode 项目 · long paths remain readable",
        role: "planner",
        acceptanceCriteria: [
          "Rendered inputs remain scoped",
          "Acceptance remains explicit",
        ],
      }),
    {
      projectId: projectIds[0],
      workspaceId: coordination.workspaces[0].id,
      workflowId: workflow.id,
    },
  );
  await page.evaluate(
    ({ projectId, workspaceId, workflowId }) =>
      window.topsl.command({
        type: "task-create",
        requestId: crypto.randomUUID(),
        projectId,
        workspaceId,
        workflowId,
        title: "Alternate task for late inspector response",
        role: "tester",
        acceptanceCriteria: ["Only alternate task evidence belongs here"],
      }),
    {
      projectId: projectIds[0],
      workspaceId: coordination.workspaces[0].id,
      workflowId: workflow.id,
    },
  );
  // The side task inspector is the wide layout; below 1200 px a task opens
  // in a modal drawer instead. Hosted runners' default windows are narrower
  // than a developer's, so set the width this section checks.
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigate(page, "Tasks");
  const projectNav = page.getByRole("navigation", {
    name: "Project navigation",
  });
  const interactions = [];
  for (let sample = 0; sample < 20; sample++) {
    const name = sample % 2 ? "Overview" : "Tasks";
    const begin = Date.now();
    await projectNav.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: name === "Overview" ? "fixture-project" : name, exact: true }).first(),
    ).toBeVisible();
    interactions.push(Date.now() - begin);
  }
  await projectNav.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: /Inspect Unicode 项目/ }).click();
  await page
    .getByRole("button", { name: /Alternate task for late inspector response/ })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Task inspector" }),
  ).toContainText("Only alternate task evidence belongs here");
  await expect(
    page.getByRole("complementary", { name: "Task inspector" }),
  ).not.toContainText("Rendered inputs remain scoped");
  await page.getByRole("button", { name: /Inspect Unicode 项目/ }).click();
  await expect(
    page.getByRole("complementary", { name: "Task inspector" }),
  ).toContainText("Rendered inputs remain scoped");
  await expect(
    page.getByRole("complementary", { name: "Task inspector" }),
  ).toContainText("fixture-project");
  // A refresh re-reads the selected task. Its button stays enabled meanwhile,
  // because a click that lands on a disabled button is lost. The button is
  // disabled only while the click's own read is pending.
  await expect(
    page.getByRole("button", { name: /Inspect Unicode 项目/ }),
  ).toBeEnabled();
  const disabledDuringRefresh = await page.evaluate(
    async ({ projectId, workspaceId, workflowId }) => {
      const selected = document.querySelector(
        'button.coordination-task[aria-pressed="true"]',
      );
      let disabled = selected.disabled;
      const watch = new MutationObserver(() => {
        disabled ||= selected.disabled;
      });
      watch.observe(selected, {
        attributes: true,
        attributeFilter: ["disabled"],
      });
      const title = "Task created while another is selected";
      await window.topsl.command({
        type: "task-create",
        requestId: crypto.randomUUID(),
        projectId,
        workspaceId,
        workflowId,
        title,
        role: "tester",
        acceptanceCriteria: ["The selected task stays enabled"],
      });
      const deadline = performance.now() + 10000;
      while (
        ![...document.querySelectorAll("button.coordination-task")].some(
          (button) => button.textContent.includes(title),
        )
      ) {
        if (performance.now() > deadline)
          throw new Error("The new task did not appear after a refresh");
        await new Promise(requestAnimationFrame);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      watch.disconnect();
      return disabled;
    },
    {
      projectId: projectIds[0],
      workspaceId: coordination.workspaces[0].id,
      workflowId: workflow.id,
    },
  );
  expect(disabledDuringRefresh).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "test-results/coordination-standard.png",
    fullPage: true,
  });
  // The colors a theme draws: every palette color on the root, the root and
  // body, and probes with the component classes, so the comparison does not
  // depend on which controls this page shows.
  const themeColors = () =>
    page.evaluate(() => {
      const probe = (tag, className) =>
        document.body.appendChild(
          Object.assign(document.createElement(tag), { className }),
        );
      const probes = [
        probe("button", "primary"),
        probe("span", "badge good"),
        probe("span", "badge warm"),
      ];
      try {
        const colors = (element) => {
          const { color, backgroundColor, borderColor, colorScheme } =
            getComputedStyle(element);
          return { color, backgroundColor, borderColor, colorScheme };
        };
        const root = getComputedStyle(document.documentElement);
        return {
          palette: Object.fromEntries(
            Array.from(root)
              .filter((name) => name.startsWith("--"))
              .map((name) => [name, root.getPropertyValue(name)]),
          ),
          root: colors(document.documentElement),
          body: colors(document.body),
          primary: colors(probes[0]),
          good: colors(probes[1]),
          warm: colors(probes[2]),
        };
      } finally {
        for (const element of probes) element.remove();
      }
    });
  // The window behind the page is painted in the page's paper color. Under
  // System it follows the computer itself, which emulateMedia does not change.
  const windowBackground = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
    );
  const paperColor = (colors) =>
    "#" +
    colors.root.backgroundColor
      .match(/\d+/g)
      .map((channel) => Number(channel).toString(16).padStart(2, "0"))
      .join("");
  await page.evaluate(() =>
    window.topsl.command({ type: "theme", theme: "night" }),
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await page.screenshot({
    path: "test-results/coordination-night.png",
    fullPage: true,
  });
  const night = await themeColors();
  expect(await windowBackground()).toBe(paperColor(night));
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.evaluate(() =>
    window.topsl.command({ type: "theme", theme: "system" }),
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  await page.screenshot({
    path: "test-results/coordination-system-dark.png",
    fullPage: true,
  });
  // System draws exactly what Night draws on a dark computer, and what Paper
  // draws on a light one.
  expect(await themeColors()).toEqual(night);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const systemLight = await themeColors();
  expect(systemLight).not.toEqual(night);
  const computerIsDark = await app.evaluate(
    ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
  );
  expect(await windowBackground()).toBe(
    paperColor(computerIsDark ? night : systemLight),
  );
  await page.evaluate(() =>
    window.topsl.command({ type: "theme", theme: "paper" }),
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper");
  const paper = await themeColors();
  expect(paper).toEqual(systemLight);
  expect(await windowBackground()).toBe(paperColor(paper));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5),
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const enlargedCapture = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
      .toPNG()
      .toString("base64"),
  );
  await writeFile(
    "test-results/coordination-scale.png",
    Buffer.from(enlargedCapture, "base64"),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await page.setViewportSize({ width: 560, height: 720 });
  await page.getByRole("button", { name: /Inspect Unicode 项目/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Task details" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/coordination-compact.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Task details" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Applications", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  const p95 = (values) =>
    values.slice().sort((a, b) => a - b)[
      Math.floor((values.length - 1) * 0.95)
    ];
  desktopBenchmark = {
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      node: process.versions.node,
      electron: await app.evaluate(() => process.versions.electron),
    },
    workload: {
      messages: 100000,
      projects: 2,
      nativeSources: 4,
      sourceBytes: await Promise.all(
        streamFixtures.map(
          async (fixture) => (await readFile(fixture.file)).length,
        ),
      ),
      historyPage: 80,
      eventBatch: 200,
      renderedWindowLimit: 20,
    },
    measurements: {
      electronProcessesBefore: benchmarkMemoryBefore,
      historyIpcQueryP95Ms: p95(historyQueries),
      ordinaryUiInteractionP95Ms: p95(interactions),
      selectedStreamCommitResponseToRenderedTextMs: streamLatency[0],
      selectedReconciliationCommandStartToRenderedTextP95Ms: p95(
        selectedCommandToRender,
      ),
      selectedReconciliationSamplesMs: selectedCommandToRender,
      electronProcesses: await app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .map((metric) => ({
            type: metric.type,
            cpu: metric.cpu.percentCPUUsage,
            memory: metric.memory,
          })),
      ),
    },
    limits: [
      "Native JSONL source fixtures; no model turn or paid route.",
      "Stream latency measures after four concurrent reconciliation command responses; service commit time and provider latency are excluded.",
      "Selected command-start to paint samples include IPC, full-source reparse and durable reconciliation; they are conservative upper bounds, not direct commit-to-paint samples.",
      "Interaction timing includes Playwright locator/visibility overhead; this is a measurement, not a release SLA.",
    ],
  };
  await writeFile(
    "test-results/desktop-coordination-benchmark.json",
    JSON.stringify(desktopBenchmark, null, 2),
  );
  await navigate(page, "Settings");
  await expect(
    page.getByText("System follows the computer’s light or dark appearance."),
  ).toBeVisible();
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
  await navigate(page, "Projects");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/projects-compact.png",
    fullPage: true,
  });
  await navigate(page, "Applications");
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
  // The Codex runtime the workflow teams below run, once it is qualified.
  let qualifiedCodex = null;
  if (qualificationDirectory) {
    // A Codex-only team through the guided setup: the scripted qualification
    // stand-in, which also builds and reviews the team files, is registered,
    // connected and qualified as a user would, so no model is contacted.
    // Native shell wrapper is a test fixture only.
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const qualifyFixture = path.join(profile, "codex-qualify-fixture");
    await writeFile(
      qualifyFixture,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/codex-desktop-workflow.cjs"))} "$@"\n`,
    );
    await chmod(qualifyFixture, 0o700);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, qualifyFixture);
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
    await page.evaluate(
      (id) => window.topsl.command({ type: "trust-installation", id }),
      runtime.id,
    );
    const pairing =
      "Codex reviews Codex in a fresh, read-only session. This is not an independent second model.";
    await page.setViewportSize({ width: 1280, height: 900 });
    await navigate(page, "Tasks");
    const setup = page.locator(".guided-workflow");
    await setup.locator("summary").first().click();
    await setup
      .getByRole("textbox", { name: "Objective", exact: true })
      .fill("Codex builds and Codex reviews codex-codex.mjs");
    await setup
      .getByRole("textbox", {
        name: "Acceptance criteria · one per line",
        exact: true,
      })
      .fill("The fixture check passes");
    await setup.getByRole("button", { name: "2. Team", exact: true }).click();
    await expect(setup.getByLabel("Team preset")).toHaveValue("codex:codex");
    await expect(setup.getByText(pairing, { exact: true })).toBeVisible();
    await setup.getByLabel("Selected builder runtime").selectOption(runtime.id);
    await setup
      .getByLabel("Selected reviewer runtime")
      .selectOption(runtime.id);
    await setup
      .getByRole("button", { name: "Validate builder runtime", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() => window.topsl.command({ type: "state" }))
          ).installations.find((i) => i.id === runtime.id).compatibility,
      )
      .toBe("compatible");
    const discover = setup.getByRole("button", {
      name: "Discover builder models",
      exact: true,
    });
    await expect(discover).toBeEnabled();
    await discover.click();
    await expect(
      setup
        .getByLabel("Requested reviewer model")
        .locator('option[value="fixture-model"]'),
    ).toHaveCount(1);
    await setup
      .getByLabel("Requested builder model")
      .selectOption("fixture-model");
    await setup
      .getByLabel("Requested reviewer model")
      .selectOption("fixture-model");
    await setup
      .getByRole("button", { name: "Qualify builder runtime", exact: true })
      .click();
    const summary = setup.getByText(/^Qualification recorded until/).first();
    await expect(summary).toBeVisible({ timeout: 120000 });
    await expect(summary).toContainText("candidate-reader");
    await expect(summary).not.toContainText("Not passed");
    await expect(summary).not.toContainText("Not tested");
    await expect(summary).toContainText("Model turns started: 3.");
    // The same qualification covers both roles on one installation.
    await expect(
      setup.getByText(/^Role requirements currently satisfied/),
    ).toHaveCount(2);
    await page.screenshot({
      path: "test-results/codex-team.png",
      fullPage: true,
    });
    await setup
      .getByRole("button", { name: "3. Environment", exact: true })
      .click();
    await setup
      .getByLabel("Preparation and check recipe")
      .selectOption({ label: "Self-contained command" });
    await setup.getByRole("button", { name: "4. Scope", exact: true }).click();
    await setup
      .getByRole("textbox", {
        name: "Change boundaries · relative paths, one per line",
        exact: true,
      })
      .fill("codex-codex.mjs\ncodex-codex.test.mjs");
    await setup
      .getByRole("button", { name: "5. Review and start", exact: true })
      .click();
    await expect(setup.getByText(pairing, { exact: true })).toBeVisible();
    const capture = setup.getByRole("button", {
      name: "Capture coordinated workflow",
      exact: true,
    });
    await expect(capture).toBeEnabled();
    await capture.click();
    await expect(setup.getByText(/^Workflow captured/)).toBeVisible();
    const card = page.locator(".workflow-card").filter({
      has: page.getByRole("heading", {
        name: "Codex builds and Codex reviews codex-codex.mjs",
        exact: true,
      }),
    });
    await expect(card).toContainText("codex · requested fixture-model");
    await expect(card.getByText(pairing, { exact: true })).toBeVisible();
    // Capture dispatches nothing; starting the build is a separate action.
    await expect(card.getByText("ready build", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "test-results/codex-team-workflow.png",
      fullPage: true,
    });
    qualifiedCodex = runtime;
  }
  if (process.platform !== "win32") {
    // A direct Codex chat with the protocol stand-in: a command approval is
    // denied and a file change is allowed through the trusted confirmation,
    // which is recorded here. Native shell wrapper is a test fixture only.
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const chatFixture = path.join(profile, "codex-chat-fixture");
    await writeFile(
      chatFixture,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/codex.cjs"))} "$@"\n`,
    );
    await chmod(chatFixture, 0o700);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
      globalThis.topslConfirmations = [];
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        globalThis.topslConfirmations.push({
          message: options.message,
          detail: options.detail ?? "",
        });
        return { response: 1, checkboxChecked: false };
      };
    }, chatFixture);
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
    // The window shows a change only after the service has published every
    // change record before it, 200 at a time, and the history benchmark above
    // left tens of thousands. Wait for that backlog to clear, so each step
    // below waits only for its own change.
    await page.evaluate(() => {
      globalThis.topslPublished = 0;
      globalThis.topslStopWatching = window.topsl.subscribe((event) => {
        if (event.type === "changes")
          globalThis.topslPublished = event.data.throughSequence;
      });
    });
    await page.evaluate(
      (id) => window.topsl.command({ type: "trust-installation", id }),
      runtime.id,
    );
    const head = (
      await page.evaluate(
        (projectId) =>
          window.topsl.command({ type: "scope-snapshot", projectId }),
        projectIds[0],
      )
    ).sequence;
    await expect
      .poll(() => page.evaluate(() => globalThis.topslPublished), {
        timeout: 180000,
      })
      .toBeGreaterThanOrEqual(head);
    await page.evaluate(() => globalThis.topslStopWatching());
    // A conversation, a card, or a decision shows only after the service has
    // committed its records, each synced to disk. A slow CI disk can stretch
    // that past the default five seconds, so these waits allow 30.
    const committed = { timeout: 30000 };
    await navigate(page, "Sessions");
    await expect(
      page.getByRole("heading", { name: "Sessions", exact: true }),
    ).toBeVisible();
    const conversationSelect = page.getByRole("combobox", {
      name: "Conversation",
      exact: true,
    });
    const earlierConversation = await conversationSelect.inputValue();
    await page.getByRole("button", { name: "+ New chat", exact: true }).click();
    await expect(conversationSelect).not.toHaveValue(
      earlierConversation,
      committed,
    );
    await expect(page.locator(".conversation-heading")).toContainText(
      "Chat ",
      committed,
    );
    await page
      .getByRole("combobox", { name: "Runtime", exact: true })
      .selectOption(runtime.id);
    await page
      .getByRole("button", { name: "Models & account", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("fixture-model");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption("fixture-model");
    const permissions = page.getByRole("combobox", {
      name: "Permissions",
      exact: true,
    });
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    const send = page.getByRole("button", { name: /^Send to Codex/ });
    const chat = page.getByRole("region", { name: "Conversation transcript" });
    const presetNote = page.locator(".chat-preset-note");
    // Nothing has qualified the stand-in, so No asking is offered but cannot
    // be sent, and the composer says why.
    await expect(permissions.locator("option")).toHaveText([
      "Read-only review",
      "Workspace edits · ask",
      "Workspace edits · ask when needed",
      "Workspace edits · no asking (unavailable)",
    ]);
    await message.fill("approval");
    await permissions.selectOption("edit-never");
    await expect(presetNote).toContainText(
      "Not available for this runtime. Qualify this runtime first",
    );
    await expect(send).toBeDisabled();
    await permissions.selectOption("edit");
    await expect(presetNote).toHaveText(
      "Commands write only in the workspace, without network. You decide, before any command outside Codex's known-safe list.",
    );
    await send.click();
    const command = page.getByRole("group", {
      name: "Run a command",
      exact: true,
    });
    await expect(command).toContainText("fixture read command", committed);
    await expect(command).toContainText("Folder");
    await expect(command).toContainText("may run with your own access");
    await expect(command.locator(".actions button").first()).toHaveText("Deny");
    await command.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(command).toHaveCount(0, committed);
    await expect(chat).toContainText("decline", committed);
    // The run names its preset and what Codex reported when its thread started.
    const runLine = page.locator(".run-status").first();
    await expect(runLine).toContainText(
      "fixture-model · Workspace edits · ask",
    );
    await expect(runLine).toContainText(
      "Codex reported approval policy untrusted, sandbox workspace-write, approvals reviewer user.",
    );
    // The next chat turn waits until the first has released the workspace.
    await expect
      .poll(
        async () =>
          page.evaluate(
            async (projectId) =>
              (
                await window.topsl.command({
                  type: "coordination-query",
                  projectId,
                })
              ).leases.every((lease) => lease.state === "released"),
            projectIds[0],
          ),
        committed,
      )
      .toBe(true);
    await message.fill("file approval");
    await send.click();
    const change = page.getByRole("group", {
      name: "Change files",
      exact: true,
    });
    await expect(change).toContainText("notes.md", committed);
    await expect(change).toContainText("Write access requested");
    await expect(change).toContainText("for the rest of the session");
    await page.screenshot({
      path: "test-results/approval-card.png",
      fullPage: true,
    });
    await change
      .getByRole("button", { name: "Review & allow once", exact: true })
      .click();
    await expect(change).toHaveCount(0, committed);
    await expect(chat).toContainText("accept", committed);
    const confirmation = await app.evaluate(() =>
      globalThis.topslConfirmations.at(-1),
    );
    expect(confirmation.message).toBe("Allow this native action once?");
    expect(confirmation.detail).toContain("Change files");
    expect(confirmation.detail).toContain(
      "Allowing also lets Codex write under",
    );
    expect(confirmation.detail).toContain("Digest:");
  }
  if (process.platform !== "win32") {
    // A native terminal through Topsl's screens, with a stand-in for Claude
    // Code that prints the arguments it received: Plan is passed and
    // remembered, and Bypass starts only after Topsl's own confirmation, which
    // is recorded here. Native shell wrapper is a test fixture only.
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const terminalFixture = path.join(profile, "claude-terminal-fixture");
    await writeFile(
      terminalFixture,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/terminal-stand-in.cjs"))} "$@"\n`,
    );
    await chmod(terminalFixture, 0o700);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
      globalThis.topslConfirmations = [];
      globalThis.topslBypassAnswer = 0;
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        globalThis.topslConfirmations.push({
          message: options.message,
          detail: options.detail ?? "",
          type: options.type,
          buttons: options.buttons,
        });
        // The runtime picker's third button is Claude Code; apart from the
        // Claude route's own confirmation, Topsl's bypass confirmation is its
        // only warning.
        const response =
          options.message === "Which runtime are you locating?"
            ? 2
            : options.message === "Let Topsl run Claude Code unattended?"
              ? 1
              : options.type === "warning"
                ? globalThis.topslBypassAnswer
                : 1;
        return { response, checkboxChecked: false };
      };
    }, terminalFixture);
    const claude = await page.evaluate(() =>
      window.topsl.command({ type: "select-runtime" }),
    );
    expect(claude.appId).toBe("anthropic.claude-code-cli");
    await expect
      .poll(async () =>
        (
          await page.evaluate(() => window.topsl.command({ type: "state" }))
        ).installations.some((i) => i.id === claude.id),
      )
      .toBe(true);
    await page.evaluate(
      (id) => window.topsl.command({ type: "trust-installation", id }),
      claude.id,
    );
    // As in the chat above, a terminal opens, closes and is remembered only
    // after the service has committed its records, each synced to disk.
    const committed = { timeout: 30000 };
    const scope = () =>
      page.evaluate(
        (projectId) =>
          window.topsl.command({ type: "scope-snapshot", projectId }),
        projectIds[0],
      );
    const released = () =>
      expect
        .poll(async () => {
          const { coordination, terminals } = await scope();
          return (
            !terminals.length &&
            coordination.leases.every((lease) => lease.state === "released")
          );
        }, committed)
        .toBe(true);
    await released();
    await page
      .getByRole("combobox", { name: "Runtime", exact: true })
      .selectOption(claude.id);
    const modeSelect = page.getByRole("combobox", {
      name: "Terminal mode",
      exact: true,
    });
    const modeNote = page.locator(".terminal-mode-note");
    await expect(modeSelect).toHaveValue("provider-default");
    expect(await modeSelect.locator("option").allTextContents()).toEqual([
      "Provider default",
      "Manual",
      "Plan",
      "Accept edits",
      "Sandboxed edits",
      "Auto",
      "Don't ask",
      "Bypass",
    ]);
    expect(
      await modeSelect
        .locator('optgroup[label="Advanced"] option')
        .allTextContents(),
    ).toEqual(["Bypass"]);
    await modeSelect.selectOption("plan");
    await expect(modeNote).toContainText("Passes --permission-mode plan.");
    const terminal = page.getByRole("region", { name: "Native terminal" });
    // xterm writes spaces as no-break spaces.
    const screen = () =>
      terminal
        .locator(".xterm-rows")
        .innerText()
        .then((text) => text.replaceAll(String.fromCharCode(160), " "))
        .catch(() => "");
    await page
      .getByRole("button", { name: "Native terminal", exact: true })
      .click();
    await expect.poll(screen, committed).toContain("Permission mode: plan");
    await expect(page.locator(".terminal-heading")).toContainText(
      "Plan (--permission-mode plan)",
      committed,
    );
    await page.screenshot({
      path: "test-results/terminal-mode.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Close session", exact: true })
      .click();
    await released();
    await expect(modeSelect).toHaveValue("plan", committed);
    await modeSelect.selectOption("bypass");
    await expect(modeNote).toContainText(
      "Passes --permission-mode bypassPermissions.",
    );
    await expect(modeNote).toContainText(
      "Topsl asks you to confirm every time",
    );
    const confirmations = () =>
      app.evaluate(() => globalThis.topslConfirmations.length);
    const asked = await confirmations();
    await page
      .getByRole("button", { name: "Native terminal", exact: true })
      .click();
    await expect.poll(confirmations).toBe(asked + 1);
    // Declined: no terminal starts, and the menu returns to the remembered mode.
    await expect(modeSelect).toHaveValue("plan");
    await expect(terminal).toHaveCount(0);
    const declined = await app.evaluate(() =>
      globalThis.topslConfirmations.at(-1),
    );
    expect(declined.message).toBe(
      "Start Claude Code with permission checks bypassed?",
    );
    expect(declined.type).toBe("warning");
    expect(declined.buttons).toEqual(["Cancel", "Start in Bypass"]);
    expect(declined.detail).toContain(
      `Executable: ${claude.realPath}\nFolder: ${canonicalProject}\nTopsl passes: --permission-mode bypassPermissions`,
    );
    expect(declined.detail).toContain(
      "Only use this mode in isolated environments",
    );
    await modeSelect.selectOption("bypass");
    await app.evaluate(() => {
      globalThis.topslBypassAnswer = 1;
    });
    await page
      .getByRole("button", { name: "Native terminal", exact: true })
      .click();
    await expect
      .poll(screen, committed)
      .toContain("Permission mode: bypassPermissions");
    await expect(page.locator(".terminal-heading")).toContainText(
      "Bypass (--permission-mode bypassPermissions)",
      committed,
    );
    expect(await confirmations()).toBe(asked + 2);
    await page
      .getByRole("button", { name: "Close session", exact: true })
      .click();
    await released();
    await expect(modeSelect).toHaveValue("plan", committed);
    expect(
      (await scope()).runs
        .filter((run) => run.installationId === claude.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((run) => [run.permissionMode, run.permissionArgs.join(" ")]),
    ).toEqual([
      ["plan", "--permission-mode plan"],
      ["bypass", "--permission-mode bypassPermissions"],
    ]);
    expect(
      (await page.evaluate(() => window.topsl.command({ type: "state" })))
        .terminalModes,
    ).toEqual([expect.objectContaining({ id: projectIds[0], claude: "plan" })]);
    // Auto-accept in Settings: turning it on takes Topsl's own confirmation,
    // and while it is on, the terminal menu starts in its mode.
    await navigate(page, "Settings");
    const autoAccept = page.getByRole("region", { name: "Auto-accept" });
    const level = (name) =>
      autoAccept.getByRole("button", { name, exact: true });
    await expect(level("Off")).toHaveAttribute("aria-pressed", "true");
    await expect(autoAccept.getByRole("note")).toContainText(
      "You answer each request Codex makes",
    );
    const beforeAutoAccept = await confirmations();
    await level("Sandboxed").click();
    await expect(level("Sandboxed")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    expect(await confirmations()).toBe(beforeAutoAccept + 1);
    expect(
      await app.evaluate(() => globalThis.topslConfirmations.at(-1)),
    ).toMatchObject({
      message: "Turn on auto-accept for work inside the sandbox?",
      type: "question",
      buttons: ["Cancel", "Turn on Sandboxed"],
    });
    await expect(autoAccept.getByRole("note")).toContainText(
      "Nobody is asked about work inside the sandbox.",
    );
    // Everything, declined in its warning, leaves Sandboxed on.
    await app.evaluate(() => {
      globalThis.topslBypassAnswer = 0;
    });
    await level("Everything").click();
    await expect.poll(confirmations).toBe(beforeAutoAccept + 2);
    const everything = await app.evaluate(() =>
      globalThis.topslConfirmations.at(-1),
    );
    expect(everything).toMatchObject({
      message: "Let Topsl allow everything Codex and Claude Code ask for?",
      type: "warning",
      buttons: ["Cancel", "Allow everything"],
    });
    expect(everything.detail).toContain("EXTREMELY DANGEROUS");
    expect(everything.detail).toContain(
      "Only use this mode in isolated environments",
    );
    await expect(level("Sandboxed")).toHaveAttribute("aria-pressed", "true");
    await navigate(page, "Sessions");
    await expect(modeSelect).toHaveValue("sandboxed", committed);
    await expect(modeNote).toContainText(
      "Passes --permission-mode acceptEdits --settings",
    );
    // Turning it off takes no confirmation, and the menu returns to Plan.
    await navigate(page, "Settings");
    await level("Off").click();
    await expect(level("Off")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    expect(await confirmations()).toBe(beforeAutoAccept + 2);
    await navigate(page, "Sessions");
    await expect(modeSelect).toHaveValue("plan", committed);
    // The transcript read in Settings: turning it on takes Topsl's own
    // confirmation, and turning it off takes none.
    await navigate(page, "Settings");
    const transcripts = page.getByRole("region", {
      name: "Claude Code transcripts",
    });
    const reading = (name) =>
      transcripts.getByRole("button", { name, exact: true });
    await expect(reading("Off")).toHaveAttribute("aria-pressed", "true");
    const beforeTranscripts = await confirmations();
    await reading("On").click();
    await expect(reading("On")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    expect(await confirmations()).toBe(beforeTranscripts + 1);
    expect(
      await app.evaluate(() => globalThis.topslConfirmations.at(-1)),
    ).toMatchObject({
      message: "Let Topsl read Claude Code's transcripts for workflow steps?",
      type: "question",
      buttons: ["Cancel", "Read transcripts"],
    });
    await expect(transcripts.getByRole("note")).toContainText(
      "Topsl takes Claude's final reply from that session's transcript",
    );
    await reading("Off").click();
    await expect(reading("Off")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    expect(await confirmations()).toBe(beforeTranscripts + 1);
    // Claude Code's structured route in Settings: turning it on takes Topsl's
    // own warning confirmation, is recorded with its time, and turning it off
    // takes none.
    const claudeRoute = page.getByRole("region", {
      name: "Claude Code structured route",
    });
    const routeChoice = (name) =>
      claudeRoute.getByRole("button", { name, exact: true });
    await expect(routeChoice("Off")).toHaveAttribute("aria-pressed", "true");
    const beforeRoute = await confirmations();
    await routeChoice("On").click();
    await expect(routeChoice("On")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    expect(await confirmations()).toBe(beforeRoute + 1);
    expect(
      await app.evaluate(() => globalThis.topslConfirmations.at(-1)),
    ).toMatchObject({
      message: "Let Topsl run Claude Code unattended?",
      type: "warning",
      buttons: ["Cancel", "Allow unattended Claude Code"],
    });
    await expect(claudeRoute.getByRole("note")).toContainText(
      "under your Claude Code login and usage",
    );
    await expect(claudeRoute.getByRole("note")).toContainText("Last changed");
    await routeChoice("Off").click();
    await expect(routeChoice("Off")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    expect(await confirmations()).toBe(beforeRoute + 1);
    // All four teams through the setup screen and the workflow page, each to
    // acceptance, against the Codex stand-in qualified above and the Claude
    // Code stand-in. A Claude role is a Claude Code step: the test plays
    // Claude by changing the team's module while the stand-in runs, exits it
    // as the owner would, and hands back Claude's reply, pasted or read from
    // a fixture transcript in this profile's CLAUDE_CONFIG_DIR.
    expect(qualifiedCodex).not.toBeNull();
    await app.evaluate(({ dialog }) => {
      globalThis.topslConfirmations = [];
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        globalThis.topslConfirmations.push({
          message: options.message,
          detail: options.detail ?? "",
        });
        // The affirmative button, unless the test declines this message.
        return {
          response: globalThis.topslDeclined?.includes(options.message) ? 0 : 1,
          checkboxChecked: false,
        };
      };
    });
    /** The latest confirmation Topsl asked with this message. */
    const confirmed = (message) =>
      app.evaluate(
        (_, message) =>
          globalThis.topslConfirmations.findLast(
            (confirmation) => confirmation.message === message,
          ),
        message,
      );
    const claudeVersion = `Claude Code ${
      (
        await page.evaluate(() => window.topsl.command({ type: "state" }))
      ).installations.find((i) => i.id === claude.id).version ??
      "version unknown"
    }`;
    const providerName = { codex: "Codex", claude: "Claude" };
    const teamName = (builder, reviewer) =>
      `${providerName[builder]} builds and ${providerName[reviewer]} reviews ${builder}-${reviewer}.mjs`;
    const claudePairing =
      "Claude reviews Claude in a fresh Claude Code session. This is not an independent second model.";
    const workflowSetup = page.locator(".guided-workflow");
    const workflowCard = (name) =>
      page.locator(".workflow-card").filter({
        has: page.getByRole("heading", { name, exact: true }),
      });
    // A build, review or check commits and syncs several records each.
    const working = { timeout: 120000 };
    const stage = (card, text) =>
      expect(card.getByText(text, { exact: true })).toBeVisible(working);
    const activity = async () => {
      await navigate(page, "Tasks");
      await expect(workflowSetup).toBeVisible(committed);
    };
    const settings = () =>
      page.getByRole("button", { name: "Settings", exact: true }).click();
    /** Sets up one team on the setup screen and captures its workflow. */
    const captureTeam = async (builder, reviewer) => {
      const name = teamName(builder, reviewer),
        module = `${builder}-${reviewer}`,
        pair = builder === "claude" && reviewer === "claude";
      if ((await workflowSetup.getAttribute("open")) === null)
        await workflowSetup.locator("summary").first().click();
      await workflowSetup
        .getByRole("button", { name: "1. Goal", exact: true })
        .click();
      await workflowSetup
        .getByRole("textbox", { name: "Objective", exact: true })
        .fill(name);
      await workflowSetup
        .getByRole("textbox", {
          name: "Acceptance criteria · one per line",
          exact: true,
        })
        .fill("The fixture check passes");
      await workflowSetup
        .getByRole("button", { name: "2. Team", exact: true })
        .click();
      await workflowSetup
        .getByLabel("Team preset")
        .selectOption(`${builder}:${reviewer}`);
      const note = workflowSetup.getByText(claudePairing, { exact: true });
      await expect(note).toHaveCount(pair ? 1 : 0);
      for (const [role, chosen] of [
        ["builder", builder],
        ["reviewer", reviewer],
      ]) {
        await workflowSetup
          .getByLabel(`Selected ${role} runtime`)
          .selectOption(chosen === "codex" ? qualifiedCodex.id : claude.id);
        const model = workflowSetup.getByLabel(`Requested ${role} model`);
        if (chosen === "claude") {
          // A Claude Code step names no model or effort.
          await expect(model).toHaveCount(0);
          continue;
        }
        if (!(await model.locator('option[value="fixture-model"]').count()))
          await workflowSetup
            .getByRole("button", {
              name: `Discover ${role} models`,
              exact: true,
            })
            .click();
        await model.selectOption("fixture-model");
      }
      await expect(
        workflowSetup.getByText(
          "Topsl passes it no model or effort, so Claude Code's own settings decide. Build and review runs Claude only as these steps; Claude's structured route serves coordinator and loop teams.",
        ),
      ).toHaveCount([builder, reviewer].filter((p) => p === "claude").length);
      await expect(
        workflowSetup.getByText(/^Role requirements currently satisfied/),
      ).toHaveCount(2, committed);
      await workflowSetup
        .getByRole("button", { name: "3. Environment", exact: true })
        .click();
      await workflowSetup
        .getByLabel("Preparation and check recipe")
        .selectOption({ label: "Self-contained command" });
      await workflowSetup
        .getByRole("button", { name: "4. Scope", exact: true })
        .click();
      await workflowSetup
        .getByRole("textbox", {
          name: "Change boundaries · relative paths, one per line",
          exact: true,
        })
        .fill(`${module}.mjs\n${module}.test.mjs`);
      await workflowSetup
        .getByRole("button", { name: "5. Review and start", exact: true })
        .click();
      await expect(note).toHaveCount(pair ? 1 : 0);
      const capture = workflowSetup.getByRole("button", {
        name: "Capture coordinated workflow",
        exact: true,
      });
      await expect(capture).toBeEnabled(committed);
      await capture.click();
      const card = workflowCard(name);
      await expect(card.getByText("ready build", { exact: true })).toBeVisible(
        committed,
      );
      await expect(card.getByText(claudePairing, { exact: true })).toHaveCount(
        pair ? 1 : 0,
      );
      return card;
    };
    /** Approves a captured workflow's inputs and starts it. */
    const start = async (card) => {
      const button = card.getByRole("button", {
        name: "Approve captured inputs and start",
        exact: true,
      });
      await expect(button).toBeEnabled(committed);
      const asked = await confirmations();
      await button.click();
      await expect.poll(confirmations).toBe(asked + 1);
      expect(
        await confirmed("Approve captured inputs and start?"),
      ).toBeTruthy();
    };
    /** Runs a workflow's required check once its review is in. */
    const check = async (card) => {
      await stage(card, "checking");
      await card
        .getByRole("button", { name: "Review and run checks", exact: true })
        .click();
      await stage(card, "awaiting acceptance");
    };
    /** Accepts a checked workflow and returns Topsl's acceptance dialog. */
    const accept = async (card, module) => {
      await card
        .getByRole("button", { name: "Review final acceptance", exact: true })
        .click();
      await stage(card, "accepted");
      expect(await readFile(path.join(project, module), "utf8")).toBe(
        "export const value = 2;\n",
      );
      const acceptance = await confirmed("Accept this reviewed candidate?");
      expect(acceptance.detail).toContain('"result":"passed"');
      return acceptance;
    };
    const stepPanel = (card, noun) =>
      card.getByRole("region", { name: `Claude Code ${noun}`, exact: true });
    const stepRecord = (card) =>
      card.getByRole("region", { name: "Claude Code steps", exact: true });
    const stopped = (panel) =>
      panel.getByRole("checkbox", { name: /^Claude Code has stopped/ });
    const sessions = (panel) =>
      panel.getByRole("list", { name: "Claude Code sessions", exact: true });
    const stepTerminal = (panel) =>
      panel.getByRole("region", { name: "Native terminal", exact: true });
    // The terminal's rows joined, so a wrapped line reads whole.
    const stepScreen = (panel) =>
      stepTerminal(panel)
        .locator(".xterm-rows")
        .innerText()
        .then((text) =>
          text.replaceAll(String.fromCharCode(160), " ").replaceAll("\n", ""),
        )
        .catch(() => "");
    /**
     * Opens the step in Claude Code, as the owner's button does, and returns
     * its session id, its instructions, and the step as the service has it.
     */
    const openStep = async (name, panel, args) => {
      const before = await sessions(panel).locator("li").count();
      await panel
        .getByRole("button", { name: "Open in Claude Code", exact: true })
        .click();
      await expect(sessions(panel).locator("li")).toHaveCount(
        before + 1,
        committed,
      );
      const sessionId = /^Session ([0-9a-f-]{36}) · /.exec(
        await sessions(panel).locator("li").last().innerText(),
      )[1];
      // Topsl passes the mode's arguments and the session id, and nothing else.
      await expect
        .poll(() => stepScreen(panel), committed)
        .toContain(
          `Stand-in arguments: ${JSON.stringify([...args, "--session-id", sessionId])}`,
        );
      expect(
        (await scope()).runs.find((run) => run.nativeSessionId === sessionId)
          .permissionArgs,
      ).toEqual(args);
      await expect(panel.locator("details pre")).toHaveCount(1);
      const instructions = await panel.locator("details pre").textContent();
      // Topsl copies the instructions for the owner to paste into Claude Code.
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
        instructions,
      );
      const step = await page.evaluate(
        async ({ projectId, name }) =>
          (
            await window.topsl.command({
              type: "builder-reviewer-query",
              projectId,
            })
          ).workflows.find((workflow) => workflow.objective === name)
            .claudeStep,
        { projectId: projectIds[0], name },
      );
      expect(step.opens.at(-1).sessionId).toBe(sessionId);
      return { sessionId, instructions, step };
    };
    /** Exits the stand-in from its terminal, as the owner exits Claude Code. */
    const exitStep = async (panel) => {
      await stepTerminal(panel).locator("textarea").focus();
      // The terminal passes a line on at Enter.
      await page.keyboard.type("q");
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => (await scope()).terminals.length, committed)
        .toBe(0);
      await expect(stepTerminal(panel)).toHaveCount(0, committed);
    };
    const handBack = async (panel, reply) => {
      await panel
        .getByRole("textbox", { name: "Claude's final reply", exact: true })
        .fill(reply);
      await panel
        .getByRole("button", { name: "Hand back reply", exact: true })
        .click();
    };
    const reviewReply = (instructions) =>
      JSON.stringify({
        candidateRevision: /"candidateRevision":"([a-f0-9]{64})"/.exec(
          instructions,
        )[1],
        summary: "Reviewed in the stand-in.",
        findings: [],
      });
    await activity();

    // Codex builds and Codex reviews: the team captured above.
    const codexTeam = workflowCard(teamName("codex", "codex"));
    await start(codexTeam);
    await check(codexTeam);
    // No Claude Code step ran, so acceptance names none.
    await expect(stepRecord(codexTeam)).toHaveCount(0);
    expect((await accept(codexTeam, "codex-codex.mjs")).detail).not.toContain(
      "Claude Code",
    );

    // Claude builds and Codex reviews: the build is a Claude Code step whose
    // reply the owner pastes.
    const claudeBuilds = await captureTeam("claude", "codex");
    await expect(claudeBuilds).toContainText(
      "Claude Code · a step you run in Topsl's terminal · model and effort set in Claude Code",
    );
    await start(claudeBuilds);
    await stage(claudeBuilds, "building");
    const build = stepPanel(claudeBuilds, "build");
    // The step says what it needs.
    await expect(claudeBuilds).toContainText(
      "Waiting for Claude Code. Open the build in Claude Code in the project folder, paste the instructions Topsl copies, and after Claude Code exits, hand back Claude's final reply.",
    );
    await expect(build.getByRole("status")).toHaveText(
      "Waiting for the owner to open Claude Code.",
    );
    const buildMode = build.getByRole("combobox", {
      name: "Claude Code mode for this build",
      exact: true,
    });
    // A build opens in the ordinary modes, and in Bypass only while
    // auto-accept is Everything, which then starts the menu in Bypass.
    await expect(buildMode).toHaveValue("provider-default");
    await expect(buildMode.locator('option[value="bypass"]')).toHaveCount(0);
    await settings();
    await level("Everything").click();
    await expect(level("Everything")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    await activity();
    await expect(buildMode).toHaveValue("bypass", committed);
    await expect(
      buildMode.locator('optgroup[label="Advanced"] option'),
    ).toHaveText(["Bypass"]);
    await expect(build.locator(".terminal-mode-note")).toContainText(
      "Topsl asks you to confirm every time",
    );
    // Opening in Bypass takes Topsl's own confirmation, naming the step's
    // folder, and declining it opens nothing and copies nothing.
    const bypassQuestion = "Start Claude Code with permission checks bypassed?";
    await app.evaluate((_, message) => {
      globalThis.topslDeclined = [message];
    }, bypassQuestion);
    const clipboardBefore = await app.evaluate(({ clipboard }) =>
      clipboard.readText(),
    );
    const openBuild = build.getByRole("button", {
      name: "Open in Claude Code",
      exact: true,
    });
    await openBuild.click();
    await expect.poll(() => confirmed(bypassQuestion), committed).toBeTruthy();
    await expect(openBuild).toBeEnabled(committed);
    const waitingBuild = await page.evaluate(
      async ({ projectId, name }) =>
        (
          await window.topsl.command({
            type: "builder-reviewer-query",
            projectId,
          })
        ).workflows.find((workflow) => workflow.objective === name).claudeStep,
      { projectId: projectIds[0], name: teamName("claude", "codex") },
    );
    expect((await confirmed(bypassQuestion)).detail).toContain(
      `Folder: ${waitingBuild.folder}\nTopsl passes: --permission-mode bypassPermissions`,
    );
    expect(waitingBuild.opens).toEqual([]);
    await expect(sessions(build)).toHaveCount(0);
    await expect(stepTerminal(build)).toHaveCount(0);
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      clipboardBefore,
    );
    await app.evaluate(() => {
      globalThis.topslDeclined = [];
    });
    await settings();
    await level("Off").click();
    await expect(level("Off")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    await activity();
    await expect(buildMode).toHaveValue("provider-default", committed);
    await expect(buildMode.locator('option[value="bypass"]')).toHaveCount(0);
    const built = await openStep(teamName("claude", "codex"), build, []);
    expect(built.instructions).toContain("Role: builder");
    expect(built.instructions).toContain(
      `Objective: ${teamName("claude", "codex")}`,
    );
    await expect(sessions(build)).toHaveText([
      `Session ${built.sessionId} · Provider default (no arguments) · ${claudeVersion} · opened`,
    ]);
    await expect(build.getByRole("status")).toHaveText(
      "Claude Code is open in Topsl's terminal. After it exits, confirm it stopped and hand back Claude's final reply.",
    );
    // While Claude Code runs, Topsl takes neither its reply nor a cancel.
    const cancel = claudeBuilds.getByRole("button", {
      name: "Cancel",
      exact: true,
    });
    await expect(cancel).toBeDisabled();
    await expect(cancel).toHaveAttribute(
      "title",
      "Exit Claude Code in Topsl's terminal, then cancel.",
    );
    await expect(build).toContainText(
      "Claude Code is still running in Topsl's terminal.",
    );
    await expect(
      build.getByRole("button", { name: "Hand back reply", exact: true }),
    ).toBeDisabled();
    await build.screenshot({ path: "test-results/claude-step.png" });
    // Claude changes the team's module, and the owner exits Claude Code.
    await writeFile(
      path.join(project, "claude-codex.mjs"),
      "export const value = 2;\n",
    );
    await exitStep(build);
    // An opened build may have kept writing, so cancelling, like handing
    // back, takes the owner's word that Claude Code stopped.
    await expect(cancel).toBeDisabled();
    await expect(cancel).toHaveAttribute(
      "title",
      "Confirm on the Claude Code step that Claude Code has stopped, then cancel.",
    );
    await stopped(build).check();
    await expect(cancel).toBeEnabled();
    await handBack(build, "Set the value in claude-codex.mjs to 2.");
    await expect(build).toHaveCount(0, committed);
    // Codex reviewed the build Topsl captured from the folder.
    await check(claudeBuilds);
    const buildSteps = stepRecord(claudeBuilds);
    await expect(buildSteps).toContainText(
      "Each ran in Claude Code in Topsl's terminal, under your control.",
    );
    await expect(buildSteps.locator("ol > li")).toHaveCount(1);
    await expect(buildSteps.locator("ol > li").first()).toContainText(
      "Build · reply taken · reply pasted by you",
    );
    await expect(buildSteps).toContainText(
      `Session ${built.sessionId} · Provider default (no arguments) · ${claudeVersion} · opened`,
    );
    await expect(buildSteps).toContainText(
      "Taken · reply pasted by you: Topsl took Claude's reply and captures the project folder as the build's result.",
    );
    await expect(claudeBuilds.getByRole("status")).toContainText([
      "You pasted the reply of this workflow's Claude Code build. Topsl records it as pasted by you, not read from Claude Code.",
    ]);
    expect((await accept(claudeBuilds, "claude-codex.mjs")).detail).toContain(
      `\n\nClaude Code steps, each run in Claude Code's terminal under your control:\nClaude Code build: reply pasted by you · session ${built.sessionId} · Provider default · ${claudeVersion}\nA reply you pasted is recorded as supplied by you; Topsl did not read it from Claude Code.\n\n`,
    );

    // Codex builds and Claude reviews: the review opens in Plan in a
    // read-only copy, and a reply that is not a review of the build waits.
    const claudeReviews = await captureTeam("codex", "claude");
    await start(claudeReviews);
    const review = stepPanel(claudeReviews, "review");
    await expect(review).toBeVisible(working);
    await expect(review).toContainText(
      "Opens in Plan, in a read-only copy of the build.",
    );
    await expect(review.getByRole("combobox")).toHaveCount(0);
    const reviewed = await openStep(teamName("codex", "claude"), review, [
      "--permission-mode",
      "plan",
    ]);
    expect(reviewed.instructions).toContain("Role: reviewer");
    expect(await realpath(reviewed.step.folder)).not.toBe(canonicalProject);
    await expect(sessions(review)).toHaveText([
      `Session ${reviewed.sessionId} · Plan (--permission-mode plan) · ${claudeVersion} · opened`,
    ]);
    await review
      .getByRole("button", { name: "Close session", exact: true })
      .click();
    await expect(stepTerminal(review)).toHaveCount(0, committed);
    await stopped(review).check();
    await handBack(review, "The build looks right.");
    await expect(review.getByRole("status")).toContainText(
      "Topsl did not take this reply: it is not one JSON object",
      committed,
    );
    await expect(review.getByRole("status")).toContainText(
      "The step keeps waiting",
    );
    const reviewSteps = stepRecord(claudeReviews);
    await expect(reviewSteps.locator("ol > li").first()).toContainText(
      "Review · waiting for you",
    );
    await expect(reviewSteps).toContainText(
      "Not taken · reply pasted by you: Topsl did not take this reply: it is not one JSON object",
    );
    await handBack(review, reviewReply(reviewed.instructions));
    await expect(review).toHaveCount(0, committed);
    await check(claudeReviews);
    await expect(reviewSteps.locator("ol > li").first()).toContainText(
      "Review · reply taken · reply pasted by you",
    );
    await expect(reviewSteps).toContainText(
      "Taken · reply pasted by you: Topsl took Claude's review.",
    );
    await expect(claudeReviews.getByRole("status")).toContainText([
      "You pasted the reply of this workflow's Claude Code review. Topsl records it as pasted by you, not read from Claude Code.",
    ]);
    expect((await accept(claudeReviews, "codex-claude.mjs")).detail).toContain(
      `\nClaude Code review: reply pasted by you · session ${reviewed.sessionId} · Plan · ${claudeVersion}\nA reply you pasted is recorded as supplied by you;`,
    );

    // Claude builds and Claude reviews: the build's reply comes from its
    // session's transcript, once that is turned on and Claude Code wrote it.
    const claudeTeam = await captureTeam("claude", "claude");
    await start(claudeTeam);
    await stage(claudeTeam, "building");
    const pairBuild = stepPanel(claudeTeam, "build");
    await pairBuild
      .getByRole("combobox", {
        name: "Claude Code mode for this build",
        exact: true,
      })
      .selectOption("accept-edits");
    await expect(pairBuild.locator(".terminal-mode-note")).toContainText(
      "Passes --permission-mode acceptEdits.",
    );
    const pairBuilt = await openStep(teamName("claude", "claude"), pairBuild, [
      "--permission-mode",
      "acceptEdits",
    ]);
    await writeFile(
      path.join(project, "claude-claude.mjs"),
      "export const value = 2;\n",
    );
    await exitStep(pairBuild);
    await expect(
      pairBuild.getByRole("button", { name: "Take reply from transcript" }),
    ).toHaveCount(0);
    await expect(pairBuild).toContainText(
      "Turn on Settings → Claude Code transcripts to take the reply from the session's transcript",
    );
    await settings();
    await reading("On").click();
    await expect(reading("On")).toHaveAttribute(
      "aria-pressed",
      "true",
      committed,
    );
    await activity();
    const fromTranscript = pairBuild.getByRole("button", {
      name: "Take reply from transcript",
      exact: true,
    });
    await expect(fromTranscript).toBeDisabled(committed);
    await stopped(pairBuild).check();
    // Claude Code has not written the session's transcript yet, so Topsl
    // takes no reply and says why.
    await fromTranscript.click();
    await expect(pairBuild.getByRole("status")).toContainText(
      `Topsl took no reply from the session's transcript: Claude Code has no transcript for session ${pairBuilt.sessionId}`,
      committed,
    );
    // Claude Code's transcript of the session, in the record shapes Topsl
    // recognizes: the pasted instructions, Claude's reply, and the /exit.
    const transcriptFolder = path.join(
      claudeConfig,
      "projects",
      pairBuilt.step.folder.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    const transcriptRecord = (type, content) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        userType: "external",
        cwd: pairBuilt.step.folder,
        sessionId: pairBuilt.sessionId,
        version: "2.1.300",
        type,
        message: { role: type, content },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      }) + "\n";
    await mkdir(transcriptFolder, { recursive: true });
    await writeFile(
      path.join(transcriptFolder, `${pairBuilt.sessionId}.jsonl`),
      transcriptRecord("user", pairBuilt.instructions) +
        transcriptRecord("assistant", [
          { type: "text", text: "Set the value in claude-claude.mjs to 2." },
        ]) +
        transcriptRecord("user", "<command-name>/exit</command-name>"),
    );
    await fromTranscript.click();
    await expect(pairBuild).toHaveCount(0, committed);
    const pairReview = stepPanel(claudeTeam, "review");
    await expect(pairReview).toBeVisible(working);
    const pairReviewed = await openStep(
      teamName("claude", "claude"),
      pairReview,
      ["--permission-mode", "plan"],
    );
    expect(pairReviewed.sessionId).not.toBe(pairBuilt.sessionId);
    await pairReview
      .getByRole("button", { name: "Close session", exact: true })
      .click();
    await expect(stepTerminal(pairReview)).toHaveCount(0, committed);
    await stopped(pairReview).check();
    await handBack(pairReview, reviewReply(pairReviewed.instructions));
    await expect(pairReview).toHaveCount(0, committed);
    await check(claudeTeam);
    const pairSteps = stepRecord(claudeTeam);
    await expect(pairSteps.locator("ol > li")).toHaveCount(2);
    await expect(pairSteps.locator("ol > li").first()).toContainText(
      "Build · reply taken · reply read from its session's transcript",
    );
    await expect(pairSteps.locator("ol > li").first()).toContainText(
      `Session ${pairBuilt.sessionId} · Accept edits (--permission-mode acceptEdits) · ${claudeVersion} · opened`,
    );
    await expect(pairSteps.locator("ol > li").first()).toContainText(
      "Taken · reply read from its session's transcript: Topsl took Claude's reply",
    );
    await expect(pairSteps.locator("ol > li").nth(1)).toContainText(
      "Review · reply taken · reply pasted by you",
    );
    await expect(claudeTeam.getByRole("status")).toContainText([
      "You pasted the reply of this workflow's Claude Code review. Topsl records it as pasted by you, not read from Claude Code.",
    ]);
    await page.screenshot({
      path: "test-results/claude-team-workflow.png",
      fullPage: true,
    });
    expect((await accept(claudeTeam, "claude-claude.mjs")).detail).toContain(
      `\n\nClaude Code steps, each run in Claude Code's terminal under your control:\nClaude Code build: reply read from its session's transcript · session ${pairBuilt.sessionId} · Accept edits · ${claudeVersion}\nClaude Code review: reply pasted by you · session ${pairReviewed.sessionId} · Plan · ${claudeVersion}\nA reply you pasted is recorded as supplied by you; Topsl did not read it from Claude Code.\n\n`,
    );
    // The project still remembers only the ordinary terminal's last mode.
    expect(
      (await page.evaluate(() => window.topsl.command({ type: "state" })))
        .terminalModes,
    ).toEqual([expect.objectContaining({ id: projectIds[0], claude: "plan" })]);
  }
  expect(errors).toEqual([]);
  console.log(
    "Desktop passed: protected vault, catalog, typed IPC, shared project discovery/deduplication/trust/pause/refresh, Codex registry create/rename/order/pause/resume (macOS/Linux), history import/search, handoff, configuration approval, themes, compact layout, command palette, Codex-only team qualified against a stand-in (macOS/Linux), Codex chat presets with No asking unavailable before a qualification, and approval cards for a denied command and an allowed file change, against a stand-in (macOS/Linux), a native terminal in Plan that is remembered and one in Bypass only after Topsl's confirmation against a stand-in, auto-accept turned on only through Topsl's confirmation, with the terminal menu starting in its mode, the Claude Code transcript read turned on only through Topsl's confirmation, and all four teams (Codex and Codex, Claude and Codex, Codex and Claude, Claude and Claude) set up, run and accepted through the screens against stand-ins, with Claude Code steps opened in Topsl's terminal and handed back by paste and from a fixture transcript (macOS/Linux).",
  );
  console.log(`Isolated test profile: ${profile}`);
} catch (error) {
  console.error(`Desktop failure profile: ${profile}`);
  if (errors.length) console.error("Renderer failures:", errors);
  throw error;
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
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 45000 });
  const state = await page.evaluate(() =>
    window.topsl.command({ type: "state" }),
  );
  expect(state.projects).toHaveLength(3);
  // Paper, picked last in Settings, is kept rather than replaced by System.
  expect(state.theme).toBe("paper");
  expect(state.projectSync.enabled).toBe(true);
  expect(
    state.projects.find((project) => project.realPath === canonicalDiscovered)
      .trusted,
  ).toBe(true);
  expect(
    state.projects.find((project) => project.name === "external-project")
      .trusted,
  ).toBe(false);
  expect(state.messages.length).toBeLessThanOrEqual(200);
  const persisted = await page.evaluate(
    async (projectId) =>
      window.topsl.command({
        type: "history-page",
        projectId,
        query: "quartz",
      }),
    state.projects.find((project) => project.realPath === canonicalProject).id,
  );
  expect(
    persisted.items.some((message) => message.text.includes("quartz")),
  ).toBe(true);
  const navigation = await page.evaluate(() =>
    window.topsl.command({ type: "navigation-query" }),
  );
  expect(navigation.projectId).toBe(
    state.projects.find((project) => project.realPath === canonicalProject).id,
  );
  expect(navigation.projectView).toBe("tasks");
  if (process.platform !== "win32") {
    expect(state.codexProjectSync.enabled).toBe(true);
    expect(state.codexProjectSync.status).toBe("ready");
    expect(state.codexProjectSync.projects.map((p) => p.name)).toEqual([
      "Renamed shared project",
      "fixture-project",
    ]);
    // The project still remembers Plan, its last ordinary terminal mode.
    expect(state.terminalModes).toEqual([
      expect.objectContaining({ claude: "plan" }),
    ]);
  }
  const bytes = await readFile(path.join(profile, "history.sqlite"));
  expect(bytes.includes(Buffer.from("quartz project fixture"))).toBe(false);
  console.log("Encrypted restart persistence passed.");
} finally {
  await reopened.close();
}
