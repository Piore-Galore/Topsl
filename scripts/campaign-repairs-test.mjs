import { _electron as electron, expect } from "@playwright/test";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { navigate, selectProject } from "./desktop-navigation.mjs";
import { standIn } from "./desktop-stand-in.mjs";

// The interface repairs of campaign 2026-11-04 (docs/testing/
// 2026-11-04-comprehensive/REPORT.md), checked in the running app with local
// stand-ins: each step reproduces a finding of the inspection and asserts the
// repaired behaviour. A failed step is recorded and the others still run; the
// run fails if any step failed. No provider, account or network is contacted.
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-repairs-"));
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
const evidence = path.resolve(
  process.env.TOPSL_REPAIRS_EVIDENCE ?? "test-results/repairs",
);
await mkdir(evidence, { recursive: true });
const project = path.join(profile, "repairs-project");
await mkdir(project);
await writeFile(path.join(project, "file.ts"), "export const value = 1;\n");
const git = (args) =>
  execFileSync("git", args, { cwd: project, stdio: "ignore" });
git(["init", "-q"]);
git(["add", "file.ts"]);
git([
  "-c",
  "user.email=f@example.test",
  "-c",
  "user.name=F",
  "commit",
  "-qm",
  "base",
]);
const env = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    ".",
  ],
  env,
  timeout: 90000,
});
const results = [];
let page = null;
async function step(id, name, fn) {
  try {
    await fn();
    results.push({ id, name, passed: true });
    console.log(`PASS ${id} ${name}`);
  } catch (error) {
    results.push({ id, name, passed: false, error: String(error.message) });
    console.log(`FAIL ${id} ${name}: ${String(error.message).split("\n")[0]}`);
    await page
      ?.screenshot({ path: path.join(evidence, `fail-${id}.png`) })
      .catch(() => {});
  }
}
const focused = () =>
  page.evaluate(() => {
    const e = document.activeElement;
    return e
      ? `${e.tagName.toLowerCase()}|${e.getAttribute("aria-label") ?? ""}|${(e.textContent ?? "").trim().slice(0, 40)}`
      : "none";
  });
try {
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 880 });
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  // Fail chosen replies at the main process's IPC handler, as the October
  // campaign's UI harness does.
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get("topsl:command");
    globalThis.__repairs = { fail: new Set() };
    handlers.set("topsl:command", async (event, raw) => {
      if (globalThis.__repairs.fail.has(raw?.type))
        return { error: "Fixture read failure" };
      return original(event, raw);
    });
  });
  const failReads = (types) =>
    app.evaluate((_, types) => {
      globalThis.__repairs.fail = new Set(types);
    }, types);
  await app.evaluate(({ dialog }, selected) => {
    globalThis.topslOpenPath = selected;
    globalThis.topslRuntime = 1;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.topslOpenPath],
    });
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
  await expect(home).toContainText("repairs-project");
  const command = (c) => page.evaluate((c) => window.topsl.command(c), c);
  const projectId = (await command({ type: "state" })).projects[0].id;

  await step(
    "W3-2",
    "Cmd+Enter during an IME composition starts nothing",
    async () => {
      const message = home.getByRole("textbox", { name: "Message" });
      await message.click();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "zhong",
        selectionStart: 5,
        selectionEnd: 5,
      });
      await page.keyboard.press("Meta+Enter");
      await page.keyboard.press("Control+Enter");
      await cdp.send("Input.insertText", { text: "中文" });
      await page.waitForTimeout(800);
      const sessions = await command({ type: "session-list", projectId });
      expect(sessions).toHaveLength(0);
      await expect(message).toHaveValue("中文");
      await message.fill("");
    },
  );

  await step(
    "W3-9",
    "a session with no qualified provider says so and offers Providers; a double-click starts one",
    async () => {
      await expect(home.getByRole("status").first()).toContainText(
        "a message sent before then is not answered",
      );
      await home
        .getByRole("textbox", { name: "Message" })
        .fill(
          "A long session title that the sidebar must end with an ellipsis",
        );
      // A double-click starts one session, not two (W4-2).
      await home
        .getByRole("button", { name: "Start session", exact: true })
        .dblclick();
      const thread = page.getByRole("region", { name: "Session", exact: true });
      const attention = thread.locator(".session-attention").first();
      await expect(attention).toContainText(
        "No provider can coordinate yet. Qualify Codex or Claude Code under Providers",
        { timeout: 30000 },
      );
      await expect(attention).not.toContainText("coordinator-contribution");
      await expect(
        attention.getByRole("button", { name: "Open Providers" }),
      ).toBeVisible();
      expect(await command({ type: "session-list", projectId })).toHaveLength(
        1,
      );
    },
  );

  await step("W3-18", "an idle session offers no Pause or Stop", async () => {
    const thread = page.getByRole("region", { name: "Session", exact: true });
    await expect(
      thread.getByRole("group", { name: "Session controls" }),
    ).toHaveCount(0);
  });

  await step(
    "W3-8",
    "sidebar titles end with an ellipsis, not a cut letter",
    async () => {
      const title = page
        .locator("aside.sidebar .thread-link .thread-title")
        .first();
      const style = await title.evaluate((e) => {
        const s = getComputedStyle(e);
        return [s.display, s.textOverflow, s.whiteSpace, e.title];
      });
      expect(style.slice(0, 3)).toEqual(["block", "ellipsis", "nowrap"]);
      expect(style[3]).toContain("A long session title");
    },
  );

  await step(
    "W3-6",
    "a session pane takes focus, closes on Escape and returns focus",
    async () => {
      const thread = page.getByRole("region", { name: "Session", exact: true });
      const work = thread
        .getByRole("group", { name: "Thread panes" })
        .getByRole("button", { name: /^Work/ });
      await work.focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("complementary", { name: "Work details" }),
      ).toBeVisible();
      expect(await focused()).toMatch(/^h2\|\|Work/);
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("complementary", { name: "Work details" }),
      ).toHaveCount(0);
      expect(await focused()).toMatch(/^button\|\|Work/);
    },
  );

  await step(
    "W3-13",
    "the breadcrumb shows between 900 and 1100 px",
    async () => {
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.waitForTimeout(300);
      await expect(page.locator(".topbar > span").first()).toBeVisible();
      await expect(page.locator(".topbar > span").first()).toContainText(
        "repairs-project",
      );
      await page.setViewportSize({ width: 1280, height: 880 });
    },
  );

  await step("W3-7", "theme choices expose which is selected", async () => {
    await navigate(page, "Settings");
    const appearance = page.locator("#appearance");
    const pressed = await appearance
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((b) => [
          b.textContent.trim(),
          b.getAttribute("aria-pressed"),
        ]),
      );
    expect(pressed).toEqual([
      ["Paper", "false"],
      ["Night", "false"],
      ["System", "true"],
    ]);
  });

  // A Codex stand-in for the Providers and dialog checks.
  const codex = await standIn({
    directory: profile,
    name: "codex-repairs",
    script: "tests/fixtures/codex-desktop-coordinator.cjs",
  });
  await app.evaluate((_, file) => {
    globalThis.topslOpenPath = file;
    globalThis.topslRuntime = 1;
  }, codex);
  const located = await command({ type: "select-runtime" });
  await expect
    .poll(async () =>
      (await command({ type: "state" })).installations.some(
        (i) => i.id === located.id,
      ),
    )
    .toBe(true);
  await command({ type: "trust-installation", id: located.id });

  await step(
    "W3-5",
    "a dialog opened by a slow command returns focus to its opener",
    async () => {
      await navigate(page, "Providers");
      const connect = page
        .locator("article.application-card")
        .filter({ hasText: "Codex CLI" })
        .getByRole("button", { name: "Connect / test" });
      await connect.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Native connection" });
      await expect(dialog).toBeVisible({ timeout: 30000 });
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await focused()).toMatch(/Connect \/ test/);
    },
  );

  await step(
    "W3-4",
    "a failed qualification read says so and can be retried",
    async () => {
      await failReads(["runtime-qualification-query"]);
      await navigate(page, "Settings");
      await navigate(page, "Providers");
      const block = page.getByRole("region", { name: "Codex qualification" });
      await expect(block.getByRole("alert")).toContainText(
        "Topsl could not read this runtime's qualification: Fixture read failure",
        { timeout: 15000 },
      );
      await expect(block).not.toContainText("Codex reported no models");
      await failReads([]);
      await block
        .getByRole("button", { name: "Read qualification again" })
        .click();
      await expect(block.getByRole("alert")).toHaveCount(0);
      await expect(block.locator(".badge")).toHaveText("Not qualified");
    },
  );

  await step(
    "W3-22",
    "a failed All sessions read says so and can be retried",
    async () => {
      await selectProject(page, "repairs-project");
      await failReads(["project-threads-page"]);
      await navigate(page, "All sessions");
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "could not read the sessions" });
      await expect(alert).toContainText("Fixture read failure", {
        timeout: 15000,
      });
      await expect(page.getByText("Loading sessions…")).toHaveCount(0);
      await failReads([]);
      await alert.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByText("A long session title")).toBeVisible();
    },
  );

  await step(
    "W1-2",
    "a pending operation is named in plain words",
    async () => {
      await app.evaluate(({ ipcMain }) => {
        const handlers = ipcMain._invokeHandlers;
        const original = handlers.get("topsl:command");
        handlers.set("topsl:command", async (event, raw) => {
          if (raw?.type === "runtime-connect") {
            await new Promise((r) => setTimeout(r, 1500));
            handlers.set("topsl:command", original);
          }
          return original(event, raw);
        });
      });
      await navigate(page, "Providers");
      await page
        .locator("article.application-card")
        .filter({ hasText: "Codex CLI" })
        .getByRole("button", { name: "Connect / test" })
        .click();
      await expect(
        page.locator('p[role="status"]', {
          hasText: "Connecting the runtime…",
        }),
      ).toBeVisible();
      await expect(
        page.locator('p[role="status"]', { hasText: "runtime connect" }),
      ).toHaveCount(0);
      await page.getByRole("dialog", { name: "Native connection" }).waitFor();
      await page.keyboard.press("Escape");
    },
  );

  await step(
    "W3-1",
    "Escape then Tab moves focus out of the native terminal",
    async () => {
      const quote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
      const fixture = path.join(profile, "claude-terminal-fixture");
      await writeFile(
        fixture,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/terminal-stand-in.cjs"))} "$@"\n`,
      );
      await chmod(fixture, 0o700);
      await app.evaluate((_, file) => {
        globalThis.topslOpenPath = file;
        globalThis.topslRuntime = 2;
      }, fixture);
      const claude = await command({ type: "select-runtime" });
      await expect
        .poll(async () =>
          (await command({ type: "state" })).installations.some(
            (i) => i.id === claude.id,
          ),
        )
        .toBe(true);
      await command({ type: "trust-installation", id: claude.id });
      await selectProject(page, "repairs-project");
      await navigate(page, "Provider tools");
      await page
        .getByRole("combobox", { name: "Runtime" })
        .selectOption(claude.id);
      await page
        .getByRole("button", { name: "Native terminal", exact: true })
        .click();
      const terminal = page.getByRole("region", { name: "Native terminal" });
      await expect(terminal).toBeVisible({ timeout: 30000 });
      await expect(
        page.getByText("press Escape, then Tab or Shift+Tab"),
      ).toBeVisible();
      await terminal.click();
      const inside = async () => {
        const value = await page.evaluate(
          () => !!document.activeElement?.closest(".terminal"),
        );
        console.log(
          `  terminal focus: ${value ? "inside" : "outside"} (${await focused()})`,
        );
        return value;
      };
      expect(await inside()).toBe(true);
      // Tab alone stays in the terminal; the program gets it.
      await page.keyboard.press("Tab");
      expect(await inside()).toBe(true);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      expect(await inside()).toBe(false);
      // Shift+Tab leaves backwards, to the terminal's own controls.
      await terminal.click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Shift+Tab");
      expect(await inside()).toBe(false);
      await page.screenshot({
        path: path.join(evidence, "terminal-leave.png"),
      });
      await page
        .getByRole("button", { name: "Close session", exact: true })
        .click();
    },
  );
} finally {
  await app.close();
}
await writeFile(
  path.join(evidence, "repairs-results.json"),
  JSON.stringify(results, null, 2),
);
const failed = results.filter((r) => !r.passed);
console.log(
  `Repairs journey: ${results.length - failed.length} of ${results.length} steps passed.`,
);
if (failed.length) process.exit(1);
