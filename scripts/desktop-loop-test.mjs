import { navigate, openThread } from "./desktop-navigation.mjs";
import { throttleRenderer } from "./desktop-click-trace.mjs";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, realpath, chmod } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Recursive Looping (experimental) as loop conversations, driven through
// Topsl's own screens in Electron against a synthetic profile. The Codex runtime is a
// scripted stand-in (tests/fixtures/codex-desktop-coordinator.cjs) that is
// registered, connected and qualified through typed IPC as the main desktop
// test does through the setup screen; no model or account is contacted, and
// the Opus, Astra, Fable and Sol labels are fixture catalog entries only.
// The stand-in is a shell wrapper, which Topsl launches on macOS and Linux.
if (process.platform === "win32") {
  console.log("Desktop coordinator journey skipped: it needs a shell wrapper.");
  process.exit(0);
}
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-loop-"));
const desktopEnvironment = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete desktopEnvironment.ELECTRON_RUN_AS_NODE;
// A qualification refuses the temporary folders that hold the profile.
await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
const qualificationDirectory = await mkdtemp(
  path.resolve("node_modules/.cache/topsl-qualify-"),
);
process.on("exit", () =>
  rmSync(qualificationDirectory, { recursive: true, force: true }),
);
desktopEnvironment.TOPSL_TEST_QUALIFICATION_DIR = qualificationDirectory;
const nativeHome = path.join(profile, "native-home");
await mkdir(path.join(nativeHome, ".codex"), { recursive: true });
await mkdir(path.join(profile, "claude-config", "projects"), {
  recursive: true,
});
desktopEnvironment.CLAUDE_CONFIG_DIR = path.join(profile, "claude-config");
// A Git project, because a code goal's baseline is a Git snapshot.
const project = path.join(profile, "loop-project");
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
const launch = () =>
  electron.launch({
    args: [
      ...(process.platform === "linux" && process.env.CI
        ? ["--no-sandbox"]
        : []),
      ".",
    ],
    env: desktopEnvironment,
    timeout: 90000,
  });
await mkdir("test-results", { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: `test-results/${name}.png`, fullPage: true });

const app0 = await launch();
const errors = [];
let projectId = null;
let app = app0;
let page = null;
// Member runs the mid-turn restart left with an unknown outcome.
let unknown = [];
const answerDialogs = (app, selected) =>
  app.evaluate(({ dialog }, selected) => {
    globalThis.topslConfirmations ??= [];
    globalThis.topslOpenPath = selected;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.topslOpenPath],
    });
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.topslConfirmations.push({
        message: options.message,
        detail: options.detail ?? "",
        buttons: options.buttons,
      });
      return { response: 1, checkboxChecked: false };
    };
  }, selected);
const confirmations = () => app.evaluate(() => globalThis.topslConfirmations);
/**
 * Holds, in the main process and in order, Topsl's change events and the
 * project snapshot and change-log reads until released, so a screen must
 * read what it shows itself rather than wait for a project refresh. It also
 * counts the commands in flight, for `settled` below.
 */
const holdRefreshes = (app, hold) =>
  app.evaluate(({ BrowserWindow, ipcMain }, hold) => {
    let h = globalThis.topslHold;
    if (!h) {
      h = globalThis.topslHold = {
        holding: false,
        inFlight: 0,
        held: [],
      };
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      contents.send = (channel, event) =>
        h.holding && event?.type === "changes"
          ? h.held.push(() => send(channel, event))
          : send(channel, event);
      const handlers = ipcMain._invokeHandlers;
      const command = handlers.get("topsl:command");
      handlers.set("topsl:command", async (event, raw) => {
        let reply;
        h.inFlight++;
        try {
          reply = await command(event, raw);
        } finally {
          h.inFlight--;
        }
        return h.holding &&
          ["scope-snapshot", "scope-events"].includes(raw?.type)
          ? new Promise((resolve) => h.held.push(() => resolve(reply)))
          : reply;
      });
    }
    h.holding = hold;
    if (!hold) for (const release of h.held.splice(0)) release();
  }, hold);
/** Waits until no command is in flight apart from the held reads. */
const settled = () =>
  expect
    .poll(async () => {
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
      return app.evaluate(() => globalThis.topslHold.inFlight);
    })
    .toBe(0);
const command = (value) =>
  page.evaluate((value) => window.topsl.command(value), value);
/** The project's New conversation page, in a loop run mode. */
async function openLoops(mode) {
  await navigate(page, "New conversation");
  const home = page.getByRole("region", { name: "New conversation" });
  await home.getByRole("radio", { name: new RegExp(`^${mode}`) }).check();
  return home;
}
/** Opens a run's conversation from the sidebar unless it is already open. */
async function openRun(title) {
  if (!(await runArticle(title).isVisible()))
    await openThread(page, "loop-project", title);
  await expect(runArticle(title)).toBeVisible();
  return runArticle(title);
}
/** Shows one of a run's panes (Goals, Checkpoint, Organization, …). */
async function showPane(run, name) {
  const toggle = run
    .getByRole("group", { name: "Thread panes" })
    .getByRole("button", { name, exact: true });
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
}
// Exact: one run's title can begin another's ("Change the value to two" and
// "Change the value to two in a second run").
const runArticle = (title) =>
  page.getByRole("article", { name: `Loop run ${title}`, exact: true });
const runOf = async (title) =>
  (await command({ type: "loop-query", projectId })).runs.find(
    (r) => r.title === title,
  );
try {
  page = await app.firstWindow();
  await throttleRenderer(page);
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await answerDialogs(app, project);
  await navigate(page, "Projects");
  await page
    .getByRole("button", { name: "+ Add project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "loop-project", exact: true }),
  ).toBeVisible();
  projectId = (await command({ type: "state" })).projects.find(
    (p) => p.realPath === canonicalProject,
  ).id;
  // The Codex stand-in, registered, connected, catalogued and qualified.
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = path.join(profile, "codex-loop-fixture");
  await writeFile(
    wrapper,
    `#!/bin/sh\nFIXTURE_TURN_DELAY_MS=600 exec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/codex-desktop-coordinator.cjs"))} "$@"\n`,
  );
  await chmod(wrapper, 0o700);
  await app.evaluate((_, selected) => {
    globalThis.topslOpenPath = selected;
  }, wrapper);
  const runtime = await command({ type: "select-runtime" });
  await expect
    .poll(async () =>
      (await command({ type: "state" })).installations.some(
        (i) => i.id === runtime.id,
      ),
    )
    .toBe(true);
  await page.evaluate(async (id) => {
    await window.topsl.command({ type: "trust-installation", id });
    await window.topsl.command({ type: "runtime-connect", id });
    await window.topsl.command({ type: "runtime-models", id });
  }, runtime.id);
  expect(
    await command({
      type: "runtime-qualify",
      id: runtime.id,
      model: "fixture-model",
    }),
  ).not.toBeNull();

  // The run mode selector on the project's New conversation page: Single
  // goal starts a goal conversation; the loop modes create runs.
  await page.setViewportSize({ width: 1280, height: 900 });
  await navigate(page, "New conversation");
  await expect(page.getByRole("radio", { name: /^Single goal/ })).toBeChecked();
  let loops = await openLoops("Goal loop");
  await expect(loops).toContainText("Experimental");
  await loops
    .getByRole("button", {
      name: "Turn on experimental Recursive Looping",
      exact: true,
    })
    .click();

  // Goal loop A: create, start under native authority, and steer while it runs.
  await loops
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Change the value to two.");
  await loops.getByRole("button", { name: "Create run", exact: true }).click();
  // Creating opens the run's own conversation, which starts with the goals.
  const a = runArticle("Change the value to two");
  await expect(a).toBeVisible();
  await expect(
    a.getByRole("list", { name: "Conversation" }).getByRole("listitem").first(),
  ).toContainText("Change the value to two.");
  await a
    .getByRole("button", { name: "Review and start", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await confirmations()).some(
        (c) => c.message === "Start this Goal loop? (Experimental)",
      ),
    )
    .toBe(true);
  const authority = (await confirmations()).find(
    (c) => c.message === "Start this Goal loop? (Experimental)",
  );
  if (!/Topsl-owned copies/.test(authority.detail))
    throw new Error("The start confirmation must say where work happens.");
  await expect(
    a.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await expect(
    a.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  // Adding a goal and changing an override during execution.
  await expect
    .poll(
      async () =>
        (
          await command({
            type: "loop-inspect",
            runId: (await runOf("Change the value to two")).id,
          })
        ).current?.iteration.state ?? "",
      { timeout: 60000 },
    )
    .toMatch(/organizing|preparing|executing|verifying|evaluating/);
  await showPane(a, "Goals");
  await a
    .getByRole("textbox", { name: "Add a goal", exact: true })
    .fill("Keep file.ts exporting the value");
  await a.getByRole("button", { name: "Add goal", exact: true }).click();
  await expect(a.getByRole("region", { name: "Goals" })).toContainText(
    "Keep file.ts exporting the value",
  );
  await showPane(a, "Organization");
  const reviewers = a
    .getByRole("region", { name: "Organization" })
    .getByRole("listitem")
    .filter({ hasText: "Reviewers" });
  await reviewers
    .getByRole("spinbutton", { name: "Member count for Reviewers" })
    .fill("2");
  await reviewers
    .getByRole("button", { name: "Lock count", exact: true })
    .click();
  await expect(a.getByRole("region", { name: "Organization" })).toContainText(
    "Role settings for reviewer",
  );
  await shot(page, "loop-goal-running");

  // Restart while a member turn runs: the run suspends and reconciles; it
  // does not resume on its own. Closing mid-turn leaves that turn's outcome
  // unknown, which the loop shows until the owner reconciles it (D-29).
  const idA = (await runOf("Change the value to two")).id;
  await expect
    .poll(
      async () =>
        (await command({ type: "loop-inspect", runId: idA })).current?.iteration
          .state ?? "",
      { timeout: 60000 },
    )
    .toMatch(/executing|verifying|evaluating/);
  await expect
    .poll(
      async () =>
        (await command({ type: "scope-snapshot", projectId })).runs.some(
          (r) => r.status === "running",
        ),
      { timeout: 120000, intervals: [50] },
    )
    .toBe(true);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await throttleRenderer(page);
  page.on("pageerror", (e) => errors.push(e.message));
  // The window reopens where it was; wait for the service, not a screen.
  await expect(page.getByRole("contentinfo")).toContainText("Ready", {
    timeout: 45000,
  });
  await answerDialogs(app, project);
  // The window reopens on the run's conversation.
  await openRun("Change the value to two");
  await expect(runArticle("Change the value to two")).toContainText(
    "Suspended",
  );
  await runArticle("Change the value to two")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  // A turn can still finish during shutdown, so check what the restart left.
  unknown = (await command({ type: "scope-snapshot", projectId })).runs.filter(
    (r) => r.status === "uncertain",
  );
  if (unknown.length) {
    await expect(runArticle("Change the value to two")).toContainText(
      "Reconciliation needed",
      { timeout: 60000 },
    );
    const waiting = await command({ type: "loop-inspect", runId: idA });
    const named = waiting.run.waitReason?.runIds ?? [];
    if (!unknown.every((r) => named.includes(r.id)))
      throw new Error(
        `The reconciliation wait names ${named.join(", ")}, not every unknown run (${unknown.map((r) => r.id).join(", ")}).`,
      );
    // The command behind each run's "Inspect & reconcile" button.
    for (const r of unknown) await command({ type: "run-reconcile", id: r.id });
  }
  await expect(
    runArticle("Change the value to two").locator(".loop-header .badge").last(),
  ).toHaveText("Completed", { timeout: 180000 });
  const doneA = await command({ type: "loop-inspect", runId: idA });
  if (
    doneA.checkpoint.sequence < 1 ||
    doneA.goals.some((g) => g.status !== "satisfied")
  )
    throw new Error(
      "Run A must complete with every goal satisfied on an accepted checkpoint.",
    );
  // The automatic organization change is visible with its reason and boundary.
  await showPane(runArticle("Change the value to two"), "Organization");
  const changes = runArticle("Change the value to two").locator("details", {
    hasText: "Why the organization changed",
  });
  await changes.locator("summary").click();
  await expect(changes).toContainText("Commit at iteration 1 by coordinators");
  await expect(changes).toContainText("One Astra coordinator");
  await shot(page, "loop-goal-completed");

  // Goal loop B: stop during child work fences everything and settles.
  loops = await openLoops("Goal loop");
  await loops
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Change the value to two in a second run.");
  await loops.getByRole("button", { name: "Create run", exact: true }).click();
  const titleB = "Change the value to two in a second run";
  const b = runArticle(titleB);
  await expect(b).toBeVisible();
  await b
    .getByRole("button", { name: "Review and start", exact: true })
    .click();
  const idB = (await runOf(titleB)).id;
  await expect
    .poll(
      async () =>
        (await command({ type: "loop-inspect", runId: idB })).current?.iteration
          .state ?? "",
      { timeout: 60000 },
    )
    .toMatch(/executing/);
  await b.getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await command({ type: "loop-inspect", runId: idB })).run.state,
      { timeout: 60000 },
    )
    .toBe("stopped");
  await expect(
    b.getByRole("button", { name: "Stop", exact: true }),
  ).toBeDisabled();

  // Inspect and publish run A's accumulated checkpoint into the folder.
  // Opening a run shows that run by itself, read by its own screen: project
  // refreshes are held while A is opened (the run picker once showed the
  // previously chosen run until the project's next change, the loop failure
  // recorded with F-01 in docs/testing/TEST-DECISIONS.md).
  await holdRefreshes(app, true);
  await settled();
  await openRun("Change the value to two");
  await showPane(runArticle("Change the value to two"), "Checkpoint");
  await settled();
  const checkpoint = runArticle("Change the value to two").getByRole("region", {
    name: "Accepted checkpoint",
  });
  await checkpoint
    .locator("summary", { hasText: "Accumulated changes" })
    .click();
  await expect(checkpoint).toContainText("modified: file.ts");
  await holdRefreshes(app, false);
  await checkpoint
    .getByRole("button", { name: "Publish to folder…", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await confirmations()).some(
        (c) =>
          c.message ===
          "Publish the loop's accepted checkpoint to the project folder?",
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await import("node:fs/promises")).readFile(
        path.join(project, "file.ts"),
        "utf8",
      ),
    )
    .toBe("export const value = 2;\n");
  const publication = (await confirmations()).find(
    (c) =>
      c.message ===
      "Publish the loop's accepted checkpoint to the project folder?",
  );
  if (
    !/promoted automatically by the loop's policy, not accepted by you/.test(
      publication.detail,
    )
  )
    throw new Error("The publication dialog must name machine promotion.");

  // Endless: with the published value there is no worthwhile work, so it monitors.
  // Switching modes keeps the typed text. Refreshes are held until the form
  // has settled with the text in it, so the page cannot depend on a project
  // refresh (the loop failure recorded with F-01 in
  // docs/testing/TEST-DECISIONS.md).
  loops = await openLoops("Goal loop");
  await holdRefreshes(app, true);
  await settled();
  const improve = loops.getByRole("textbox", { name: "Message", exact: true });
  await improve.fill("Keep improving the fixture. Prioritize correctness.");
  // Keyboard: the mode selector is an ordinary radio group.
  await page.getByRole("radio", { name: /^Goal loop/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /^Endless/ })).toBeChecked();
  await page.setViewportSize({ width: 760, height: 900 });
  await settled();
  await expect(improve).toHaveValue(
    "Keep improving the fixture. Prioritize correctness.",
  );
  await holdRefreshes(app, false);
  await loops.getByRole("button", { name: "Create run", exact: true }).click();
  const c = runArticle("Keep improving the fixture. Prioritize correctness.");
  await c
    .getByRole("button", { name: "Review and start", exact: true })
    .click();
  const idC = (
    await runOf("Keep improving the fixture. Prioritize correctness.")
  ).id;
  await expect
    .poll(
      async () =>
        (await command({ type: "loop-inspect", runId: idC })).run.state,
      { timeout: 90000 },
    )
    .toBe("monitoring");
  await expect(c.locator(".loop-header .badge").last()).toHaveText(
    "Monitoring",
  );
  // Compact layout: the controls stay reachable without horizontal scrolling.
  await expect(
    c.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  if (overflow > 1)
    throw new Error(
      `The compact loop view scrolls horizontally by ${overflow}px.`,
    );
  await shot(page, "loop-endless-monitoring-compact");
  // Turning the feature off pauses the run, and Stop stays available for it.
  await command({ type: "loop-feature-set", enabled: false });
  await expect
    .poll(
      async () =>
        (await command({ type: "loop-inspect", runId: idC })).run.state,
      { timeout: 30000 },
    )
    .toBe("paused");
  // The run's conversation can no longer be steered, and the project's page
  // keeps Stop for it.
  await expect(
    c.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeDisabled();
  loops = await openLoops("Endless");
  const existing = loops.getByRole("region", { name: "Existing runs" });
  await expect(existing).toContainText("Paused");
  await shot(page, "loop-feature-off-existing-run");
  await existing
    .getByRole("button", {
      name: "Stop Keep improving the fixture. Prioritize correctness.",
      exact: true,
    })
    .click();
  await expect
    .poll(
      async () =>
        (await command({ type: "loop-inspect", runId: idC })).run.state,
      { timeout: 60000 },
    )
    .toBe("stopped");
  if (errors.length) throw new Error(`Page errors: ${errors.join("; ")}`);
  console.log(
    `Desktop loop journey passed: mode selector, Goal loop with live steering, restart and resume (${unknown.length ? `${unknown.length} member turn(s) cut off by the restart shown as Reconciliation needed and reconciled` : "no member turn cut off by the restart"}), automatic organization change, stop during child work, publication, Endless monitoring in a compact window, Stop while the feature is off.`,
  );
} catch (error) {
  if (page) await shot(page, "loop-failure").catch(() => {});
  if (page && projectId)
    await page
      .evaluate(async (projectId) => {
        const runs = (
          await window.topsl.command({ type: "loop-query", projectId })
        ).runs;
        return Promise.all(
          runs.map((r) =>
            window.topsl.command({ type: "loop-inspect", runId: r.id }),
          ),
        );
      }, projectId)
      .then((views) =>
        writeFile(
          "test-results/loop-failure.json",
          JSON.stringify(
            views.map((v) => ({
              run: v.run,
              iterations: v.iterations.map((i) => [
                i.number,
                i.state,
                i.detail,
                i.failure,
              ]),
              current: v.current && {
                iteration: v.current.iteration.detail,
                rounds: v.current.rounds,
                goal: v.current.goal?.goal.detail,
              },
            })),
            null,
            1,
          ),
        ),
      )
      .catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
