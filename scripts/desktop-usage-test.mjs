import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { standIn } from "./desktop-stand-in.mjs";

// Focused native usage journey, independent of the project's landing view.
// No provider account is contacted: the CLI and profile are local fixtures.
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-usage-"));
const project = path.join(profile, "usage-project");
const config = path.join(profile, "claude-config");
await mkdir(project);
await mkdir(config);
await writeFile(path.join(config, "usage-fixture"), "");
const wrapper = await standIn({
  directory: profile,
  name: "claude-usage-fixture",
  script: "tests/fixtures/claude-usage.cjs",
});
const env = {
  ...process.env,
  TOPSL_TEST_PROFILE: profile,
  CLAUDE_CONFIG_DIR: config,
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    ".",
  ],
  env,
  timeout: 90_000,
});
const errors = [];
let success = false;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("button", { name: "Applications", exact: true }),
  ).toBeVisible({ timeout: 45_000 });
  await app.evaluate(
    ({ dialog }, { project, wrapper }) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false,
        filePaths: [
          options.properties.includes("openFile") ? wrapper : project,
        ],
      });
      dialog.showMessageBox = async (...args) => ({
        response:
          args.at(-1).message === "Which runtime are you locating?" ? 2 : 1,
        checkboxChecked: false,
      });
    },
    { project, wrapper },
  );
  await page.evaluate(() => window.topsl.command({ type: "project-add" }));
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
  await page.getByRole("button", { name: "Applications", exact: true }).click();
  const card = page.getByRole("article", { name: "Claude usage remaining" });
  const refresh = card.getByRole("button", {
    name: "Refresh from Claude",
    exact: true,
  });
  await expect(card.locator(".badge")).toHaveText("Not reported");
  await expect(
    card.getByRole("combobox", { name: "Project for Claude usage" }),
  ).toHaveText("usage-project");
  await refresh.click();
  await expect(card.locator(".badge")).toHaveText("Reported · current");
  await expect(card).toContainText("87% left · 13% used, as reported");
  await expect(card).toContainText("49% left · 51% used, as reported");
  await expect(card).toContainText("Current week (Fable)");
  await expect(card).toContainText("Resets 1:29am (Asia/Shanghai)");
  await expect(card).not.toContainText("private@example");
  await expect(card).not.toContainText("private-organization");
  const state = await page.evaluate(() =>
    window.topsl.command({ type: "state" }),
  );
  expect(state.runs).toHaveLength(0);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/claude-usage.png",
    fullPage: true,
  });
  await writeFile(path.join(config, "failure"), "");
  await refresh.click();
  await expect(card.locator(".badge")).toHaveText(
    "Refresh failed · older values",
  );
  await expect(card.getByRole("alert")).toContainText(
    "Claude could not load usage",
  );
  await expect(card).toContainText("87% left · 13% used, as reported");
  await expect(card).not.toContainText("private-body");
  await rm(path.join(config, "failure"));
  await refresh.click();
  await expect(card.locator(".badge")).toHaveText("Reported · current");
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
  success = true;
  console.log(
    "Claude usage Electron journey passed: native-only refresh, three windows, reset labels, failed-read retention, retry, and no model run.",
  );
} finally {
  await app.close();
  if (success) await rm(profile, { recursive: true, force: true });
  else console.error(`Usage journey failure profile: ${profile}`);
}
