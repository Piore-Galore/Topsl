import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-desktop-"));
const project = path.join(profile, "fixture-project");
await mkdir(project);
const canonicalProject = await realpath(project);
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
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    TOPSL_TEST_PROFILE: profile,
  },
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
      projectId: state.projects[0].id,
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
    "Desktop passed: protected vault, catalog, typed IPC, trusted project, history import/search, handoff, configuration approval, themes, compact layout, command palette.",
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
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "",
    TOPSL_TEST_PROFILE: profile,
  },
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
  expect(state.projects).toHaveLength(1);
  expect(state.messages).toHaveLength(2);
  const bytes = await readFile(path.join(profile, "history.sqlite"));
  expect(bytes.includes(Buffer.from("quartz project fixture"))).toBe(false);
  console.log("Encrypted restart persistence passed.");
} finally {
  await reopened.close();
}
