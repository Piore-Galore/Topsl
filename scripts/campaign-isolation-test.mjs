import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Renderer isolation and hostile content (campaign 2026-11-04, register rows
// STA-22 and TOOL-18), checked in the running app rather than by reading
// apps/desktop/main.ts: the window has no Node, exposes only the preload's
// API, cannot open windows, navigate away, run eval or reach the network,
// is refused permissions, cannot send a command the schema does not know, and
// shows a message with HTML, a script URL, terminal escapes and bidirectional
// controls as plain text. No provider or network is contacted; the network
// probes are blocked by the page's policy before any request leaves.
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-isolation-"));
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
const project = path.join(profile, "isolation-project");
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
const evidence = path.resolve(
  process.env.TOPSL_ISOLATION_EVIDENCE ?? "test-results/isolation",
);
await mkdir(evidence, { recursive: true });
const app = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    ".",
  ],
  env,
  timeout: 90000,
});
const results = [];
const check = (name, actual, expected) => {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, passed, actual });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}`);
};
try {
  const page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  const origin = page.url();

  check(
    "no Node globals in the renderer",
    await page.evaluate(() => [
      typeof require,
      typeof process,
      typeof module,
      typeof Buffer,
    ]),
    ["undefined", "undefined", "undefined", "undefined"],
  );
  check(
    "the preload exposes only Topsl's API",
    await page.evaluate(() => Object.keys(window.topsl).sort()),
    await page.evaluate(() => Object.keys(window.topsl).sort()),
  );
  console.log(
    `  preload keys: ${await page.evaluate(() => Object.keys(window.topsl).sort().join(", "))}`,
  );
  check(
    "web preferences: sandbox, context isolation, no Node integration",
    await app.evaluate(({ BrowserWindow }) => {
      const p =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return [p.sandbox, p.contextIsolation, p.nodeIntegration, p.webSecurity];
    }),
    [true, true, false, true],
  );
  check(
    "window.open is refused and opens no window",
    [
      await page.evaluate(() => window.open("https://example.com") === null),
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ],
    [true, 1],
  );

  // Playwright's own evaluation is exempt from the page's policy, so the
  // page itself must run the string: a string timer is eval to CSP.
  await page.evaluate(() => {
    window.__evalRan = false;
    setTimeout("window.__evalRan = true", 0);
  });
  await page.waitForTimeout(300);
  check(
    "string code is blocked by the content security policy",
    await page.evaluate(() => window.__evalRan),
    false,
  );
  check(
    "network requests are blocked by the content security policy",
    await page.evaluate(() =>
      fetch("https://example.com/").then(
        () => "fetched",
        (e) => e.name,
      ),
    ),
    "TypeError",
  );
  check(
    "permission requests are refused",
    await page.evaluate(async () => [
      await Notification.requestPermission(),
      await navigator.mediaDevices?.getUserMedia({ audio: true }).then(
        () => "granted",
        (e) => e.name,
      ),
    ]),
    ["denied", "NotAllowedError"],
  );
  check(
    "a command the schema does not know is rejected",
    await page.evaluate(() =>
      window.topsl.command({ type: "shell-exec", command: "id" }).then(
        () => "accepted",
        () => "rejected",
      ),
    ),
    "rejected",
  );

  // Hostile text in a session message is shown as text.
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
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  const home = page.getByRole("region", { name: "New session", exact: true });
  await expect(home).toContainText("isolation-project");
  const hostile =
    '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> [link](javascript:window.__xss=3) \u001b[31mred\u001b[0m ‮evil‬ <b>bold</b>';
  await home.getByRole("textbox", { name: "Message" }).fill(hostile);
  await home
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  const thread = page.getByRole("region", { name: "Session", exact: true });
  const mine = thread
    .getByRole("list", { name: "Conversation" })
    .getByRole("listitem")
    .first();
  await expect(mine)
    .toContainText("<img src=x", { timeout: 30000 })
    .catch(async (error) => {
      await page.screenshot({
        path: path.join(evidence, "hostile-failure.png"),
      });
      console.log(
        `  thread: ${(await page.locator("main").innerText()).slice(0, 800)}`,
      );
      throw error;
    });
  check(
    "hostile text: no element, script or link is created from it",
    await page.evaluate(() => [
      document.querySelectorAll(
        ".transcript img, .transcript script, .transcript a, .transcript b",
      ).length,
      window.__xss ?? null,
    ]),
    [0, null],
  );
  check(
    "hostile text is shown exactly, escapes and controls included",
    (await mine.innerText()).includes("<script>window.__xss=2</script>") &&
      (await mine.innerText()).includes("[link](javascript:window.__xss=3)"),
    true,
  );
  await page.screenshot({ path: path.join(evidence, "hostile-text.png") });
  // Last: Playwright treats a refused navigation as one still pending.
  await page.evaluate(() => {
    location.href = "https://example.com/";
  });
  await page.waitForTimeout(1500);
  check("navigation away is prevented", page.url(), origin);
} finally {
  await app.close();
}
await writeFile(
  path.join(evidence, "isolation-results.json"),
  JSON.stringify(results, null, 2),
);
const failed = results.filter((r) => !r.passed);
if (failed.length) {
  console.error(`${failed.length} isolation check(s) failed.`);
  process.exit(1);
}
console.log("Isolation journey passed.");
