import { navigate } from "./desktop-navigation.mjs";
import { expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import path from "node:path";
import {
  addProject,
  alive,
  coordinatorReady,
  createProfile,
  exited,
  launch,
  processes,
  qualifiedCodex,
  standIns,
  tree,
} from "./campaign-harness.mjs";
import { standIn } from "./desktop-stand-in.mjs";

// Recovery fault injection through Topsl's own window
// (docs/testing/2026-11-04-comprehensive/PLAN.md, "Recovery"), each case in
// its own disposable profile with Codex stand-ins
// (tests/fixtures/codex-soak.cjs); no model or account is contacted.
//
//   disconnect   the stand-in is SIGKILLed while a Provider tools reply streams
//   malformed    a stand-in writes a line that is not JSON mid-reply; another
//                sends JSON frames of the wrong shape
//   stall        a stand-in stops writing mid-reply and ignores the interrupt
//   double       Start session, Send and Send to Codex are double-clicked; one
//                commandId is sent more than once over IPC
//   service-kill Topsl's control service is SIGKILLed while the coordinator
//                answers a session's first (Work) message; -goal: while a
//                member turn of the goal it started runs
//   restart      Topsl is closed at the same points (restart, restart-goal)
// After an interruption Topsl is reopened; the journey checks for replayed
// turns, the run's and the workspace's uncertainty, what the session says,
// Stop session, and reconciliation from Provider tools.
//
// Each case records what it observed and its checks to --out as
// recovery-<case>.json, with screenshots. A failed check is a finding to
// triage, not necessarily a product defect. macOS and Linux only.
//
//   npm run build
//   node scripts/campaign-recovery-desktop.mjs --case all --out test-results/recovery

if (process.platform === "win32") {
  console.log(
    "Skipped on Windows: the journeys read the process table with ps.",
  );
  process.exit(0);
}
const { values } = parseArgs({
  options: {
    case: { type: "string", default: "all" },
    out: { type: "string", default: "test-results/recovery" },
  },
});
const out = path.resolve(values.out);
await mkdir(out, { recursive: true });
const all = [
  "disconnect",
  "malformed",
  "stall",
  "double",
  "service-kill",
  "service-kill-goal",
  "restart",
  "restart-goal",
  "restart-reconcile-first",
];
const selected = values.case === "all" ? all : values.case.split(",");

/** Records checks without stopping at the first, so every observation is kept. */
function recorder(name) {
  const result = {
    case: name,
    startedAt: new Date().toISOString(),
    checks: [],
    observations: {},
  };
  return {
    result,
    check(label, ok, detail = null) {
      result.checks.push({ label, ok: !!ok, detail });
      console.log(
        `${ok ? "PASS" : "FAIL"} [${name}] ${label}${detail === null ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`,
      );
      return !!ok;
    },
    observe(key, value) {
      result.observations[key] = value;
    },
    async save() {
      result.finishedAt = new Date().toISOString();
      result.passed = result.checks.every((c) => c.ok);
      await writeFile(
        path.join(out, `recovery-${name}.json`),
        JSON.stringify(result, null, 2),
      );
      return result;
    },
  };
}
const shot = (page, name) =>
  page
    .screenshot({ path: path.join(out, `${name}.png`), fullPage: true })
    .catch(() => {});
const state = (page) =>
  page.evaluate(() => window.topsl.command({ type: "state" }));
async function servicePid(app) {
  const metrics = await app.evaluate(({ app }) =>
    app
      .getAppMetrics()
      .map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? null })),
  );
  return metrics.find((m) => m.name === "Topsl control service")?.pid ?? null;
}
/** Stand-ins started below the control service. */
async function serviceStandIns(app) {
  const pid = await servicePid(app);
  const list = processes();
  const below = new Set(tree(list, pid).map((p) => p.pid));
  return standIns(list).filter((p) => below.has(p.pid));
}
/** A trusted, connected stand-in that is not qualified (enough for a chat). */
async function connectedCodex(app, page, setup, { name, env }) {
  const wrapper = await standIn({
    directory: setup.profile,
    name,
    script: "tests/fixtures/codex-soak.cjs",
    env,
  });
  await app.evaluate((_, selected) => {
    globalThis.topslOpenPath = selected;
  }, wrapper);
  const runtime = await page.evaluate(() =>
    window.topsl.command({ type: "select-runtime" }),
  );
  await expect
    .poll(async () =>
      (await state(page)).installations.some((i) => i.id === runtime.id),
    )
    .toBe(true);
  await page.evaluate(async (id) => {
    await window.topsl.command({ type: "trust-installation", id });
    await window.topsl.command({ type: "runtime-connect", id });
    await window.topsl.command({ type: "runtime-models", id });
  }, runtime.id);
  return { id: runtime.id, wrapper };
}
/** Opens a new Provider tools chat on `runtimeId` and sends `text`. */
async function sendChat(page, runtimeId, text, { double = false } = {}) {
  await navigate(page, "Provider tools");
  await expect(
    page.getByRole("heading", { level: 1, name: "Provider tools" }),
  ).toBeVisible();
  const conversation = page.getByRole("combobox", {
    name: "Conversation",
    exact: true,
  });
  const earlier = await conversation.inputValue();
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect(conversation).not.toHaveValue(earlier, { timeout: 30000 });
  await page
    .getByRole("combobox", { name: "Runtime", exact: true })
    .selectOption(runtimeId);
  await page
    .getByRole("button", { name: "Models & account", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("fixture-model", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("fixture-model");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  const send = page.getByRole("button", { name: /^Send to Codex/ });
  await expect(send).toBeEnabled({ timeout: 30000 });
  await (double ? send.dblclick() : send.click());
  return await conversation.inputValue();
}
const transcript = (page) =>
  page.getByRole("region", { name: "Conversation transcript" });
/** The project's runs, from the scoped snapshot the window reads. */
async function allRuns(page) {
  const projectId = (await state(page)).projects[0].id;
  return (
    await page.evaluate(
      (projectId) =>
        window.topsl.command({ type: "scope-snapshot", projectId }),
      projectId,
    )
  ).runs;
}
const runsOf = async (page, conversationId) =>
  (await allRuns(page)).filter((r) => r.conversationId === conversationId);
const leases = async (page, projectId) =>
  (
    await page.evaluate(
      (projectId) =>
        window.topsl.command({ type: "coordination-query", projectId }),
      projectId,
    )
  ).leases.map((l) => ({ state: l.state, attemptId: l.attemptId }));
/** Frames a stand-in logged (FIXTURE_LOG): Topsl's turn/start prompts. */
async function turnStarts(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((f) => f.from === "topsl" && f.frame.method === "turn/start")
    .map((f) => f.frame.params.input?.[0]?.text ?? "");
}
const duplicates = (prompts) => {
  const seen = new Map();
  for (const p of prompts) seen.set(p, (seen.get(p) ?? 0) + 1);
  return [...seen.values()].filter((n) => n > 1).length;
};
async function baseSetup(name, env = {}) {
  const setup = await createProfile(name);
  const opened = await launch(setup);
  await opened.page.setViewportSize({ width: 1280, height: 900 });
  const projectId = await addProject(opened.app, opened.page, setup);
  const log = path.join(setup.profile, "healthy-frames.jsonl");
  const runtime = await qualifiedCodex(opened.app, opened.page, setup, {
    name: "codex-healthy",
    env: { FIXTURE_LOG: log, ...env },
  });
  await coordinatorReady(opened.page, projectId);
  return { setup, ...opened, projectId, runtime, log };
}
async function finish(r, context) {
  if (context?.app) {
    const pids = await context.app
      .evaluate(({ app }) => app.getAppMetrics().map((m) => m.pid))
      .catch(() => []);
    await context.app.close().catch(() => {});
    const left = await exited(pids, 20000);
    r.check(
      "after quit, no Topsl process of this case remains",
      !left.length,
      left,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  // A stand-in of this checkout whose parent is gone was orphaned; the soak's
  // stand-ins, which may run at the same time, still have their service.
  const strays = standIns().filter((p) => p.ppid === 1);
  r.observe(
    "orphanedStandInsAfterQuit",
    strays.map((p) => ({ pid: p.pid, ppid: p.ppid })),
  );
  r.check(
    "no orphaned stand-in remains after quit",
    !strays.length,
    strays.map((p) => p.pid),
  );
  context?.setup?.remove();
  return r.save();
}

// ---------------------------------------------------------------------------
async function disconnect() {
  const r = recorder("disconnect");
  const c = await baseSetup("rec-disconnect", { FIXTURE_STREAM_PARTS: 400 });
  try {
    const conversationId = await sendChat(
      c.page,
      c.runtime.id,
      "Soak stream 1: please stream a reply.",
    );
    await expect(transcript(c.page)).toContainText("Streamed soak answer 1:", {
      timeout: 60000,
    });
    const victims = await serviceStandIns(c.app);
    r.observe(
      "standInsDuringStream",
      victims.map((p) => p.pid),
    );
    r.check(
      "one stand-in serves the streaming chat",
      victims.length === 1,
      victims.length,
    );
    for (const v of victims) process.kill(v.pid, "SIGKILL");
    const killedAt = Date.now();
    const status = c.page.locator(".run-status").first();
    await expect(status.locator(".badge"))
      .not.toHaveText(/running|starting/, { timeout: 20000 })
      .catch(() => {});
    r.observe("msToSettle", Date.now() - killedAt);
    const [run] = await runsOf(c.page, conversationId);
    r.observe("runAfterKill", { status: run?.status, error: run?.error });
    await shot(c.page, "disconnect-after-kill");
    r.check(
      "the run is not reported completed",
      run && run.status !== "completed",
      run?.status,
    );
    r.check(
      "the run's outcome is failed, interrupted or uncertain",
      ["failed", "interrupted", "uncertain"].includes(run?.status),
      run?.status,
    );
    r.check(
      "the window shows the run's error",
      !!run?.error &&
        (await status.textContent()).includes(run.error.slice(0, 30)),
      run?.error,
    );
    const text = await transcript(c.page).textContent();
    r.check(
      "the streamed part stays in the transcript",
      text.includes("Streamed soak answer 1:"),
    );
    r.check(
      "the unfinished reply is not shown as finished",
      !text.includes("End of soak answer 1."),
    );
    r.check(
      "no Interrupt button remains for the dead run",
      (await c.page
        .getByRole("button", { name: "Interrupt", exact: true })
        .count()) === 0,
    );
    r.check("the killed stand-in is gone", !victims.some((v) => alive(v.pid)));
    const held = await leases(c.page, c.projectId);
    r.observe("leasesAfterKill", held);
    if (run?.status === "uncertain") {
      // Workspace ownership: before reconciliation no other writer starts.
      const startsBefore = (await turnStarts(c.log)).length;
      const blocked = await sendChat(
        c.page,
        c.runtime.id,
        "Soak stream 3: before reconciling.",
      );
      const refusal = await c.page
        .getByRole("alert")
        .filter({ hasText: /uncertain|reconcile/i })
        .first()
        .textContent({ timeout: 15000 })
        .catch(() => null);
      await c.page.waitForTimeout(3000);
      r.observe("chatBeforeReconcile", {
        refusal,
        runs: (await runsOf(c.page, blocked)).map((x) => x.status),
      });
      r.check(
        "before reconciliation a new chat is refused with a reason and starts no turn",
        !!refusal && (await turnStarts(c.log)).length === startsBefore,
        refusal,
      );
      await c.page
        .getByRole("button", { name: /^Dismiss .*error$/ })
        .first()
        .click()
        .catch(() => {});
      await c.page
        .getByRole("combobox", { name: "Conversation", exact: true })
        .selectOption(conversationId);
      await c.page
        .getByRole("button", { name: "Inspect & reconcile", exact: true })
        .click();
      await expect
        .poll(async () => (await runsOf(c.page, conversationId))[0].status, {
          timeout: 15000,
        })
        .not.toBe("uncertain");
      r.observe("afterReconcile", (await runsOf(c.page, conversationId))[0]);
    }
    // Recovery: a new chat on the same runtime starts a new process and completes.
    const second = await sendChat(
      c.page,
      c.runtime.id,
      "Soak stream 2: please stream a reply.",
    );
    await expect(transcript(c.page)).toContainText("End of soak answer 2.", {
      timeout: 90000,
    });
    const secondRuns = await runsOf(c.page, second);
    r.check(
      "a later chat on the same runtime completes",
      secondRuns.length === 1 && secondRuns[0].status === "completed",
      secondRuns.map((x) => x.status),
    );
    const prompts = await turnStarts(c.log);
    r.check(
      "the killed turn was not replayed",
      prompts.filter((p) => p.includes("Soak stream 1")).length === 1,
      prompts.filter((p) => p.includes("Soak stream")).length,
    );
    r.check(
      "the first chat still has one run",
      (await runsOf(c.page, conversationId)).length === 1,
    );
    r.observe("leasesAtEnd", await leases(c.page, c.projectId));
  } catch (error) {
    r.check(
      "journey completed without an unexpected error",
      false,
      String(error.message).slice(0, 1500),
    );
    await shot(c.page, "disconnect-error");
  }
  return finish(r, c);
}

// ---------------------------------------------------------------------------
async function malformed() {
  const r = recorder("malformed");
  const c = await baseSetup("rec-malformed");
  try {
    for (const fault of ["malformed-stream", "malformed-exit", "wrong-shape"]) {
      const bad = await connectedCodex(c.app, c.page, c.setup, {
        name: `codex-${fault}`,
        env: { FIXTURE_FAULT: fault, FIXTURE_STREAM_PARTS: 20 },
      });
      const conversationId = await sendChat(
        c.page,
        bad.id,
        `Soak stream 1: ${fault}.`,
      );
      await expect
        .poll(
          async () =>
            (await runsOf(c.page, conversationId))[0]?.status ?? "none",
          { timeout: 30000 },
        )
        .not.toMatch(/^(none|starting|running)$/)
        .catch(() => {});
      const [run] = await runsOf(c.page, conversationId);
      const text = await transcript(c.page).textContent();
      await shot(c.page, `malformed-${fault}`);
      r.observe(fault, {
        status: run?.status,
        error: run?.error,
        transcriptHasEnd: text.includes("End of soak answer 1."),
        standIns: (await serviceStandIns(c.app)).length,
      });
      if (fault === "wrong-shape") {
        r.check(
          "wrong-shape deltas are ignored and the final reply completes the run",
          run?.status === "completed" && text.includes("End of soak answer 1."),
          run?.status,
        );
      } else {
        r.check(
          `${fault}: the run is not reported completed`,
          run && run.status !== "completed",
          run?.status,
        );
        r.check(`${fault}: the run states why`, !!run?.error, run?.error);
        r.check(
          `${fault}: no false finished reply`,
          !text.includes("End of soak answer 1."),
        );
      }
      await expect
        .poll(async () => (await serviceStandIns(c.app)).length, {
          timeout: 15000,
        })
        .toBe(0)
        .catch(() => {});
      r.check(
        `${fault}: no stand-in left running`,
        (await serviceStandIns(c.app)).length === 0,
      );
      r.observe(`${fault}-leases`, await leases(c.page, c.projectId));
      // An uncertain run holds the project's writer lease until the owner
      // reconciles it, which the next fault needs.
      if (run?.status === "uncertain") {
        await c.page
          .getByRole("button", { name: "Inspect & reconcile", exact: true })
          .click();
        await expect
          .poll(async () => (await runsOf(c.page, conversationId))[0].status, {
            timeout: 15000,
          })
          .toBe("interrupted")
          .catch(() => {});
        const [after] = await runsOf(c.page, conversationId);
        r.check(
          `${fault}: Inspect & reconcile settles the uncertain run`,
          after.status === "interrupted",
          [after.status, after.error],
        );
        r.observe(
          `${fault}-leasesAfterReconcile`,
          await leases(c.page, c.projectId),
        );
      }
    }
    // A healthy runtime still works afterwards.
    const healthy = await sendChat(
      c.page,
      c.runtime.id,
      "Soak stream 9: please stream a reply.",
    );
    await expect(transcript(c.page)).toContainText("End of soak answer 9.", {
      timeout: 60000,
    });
    r.check(
      "a healthy runtime's chat completes afterwards",
      (await runsOf(c.page, healthy))[0]?.status === "completed",
    );
  } catch (error) {
    r.check(
      "journey completed without an unexpected error",
      false,
      String(error.message).slice(0, 1500),
    );
    await shot(c.page, "malformed-error");
  }
  return finish(r, c);
}

// ---------------------------------------------------------------------------
async function stall() {
  const r = recorder("stall");
  const c = await baseSetup("rec-stall");
  let reopened = null;
  try {
    const stuck = await connectedCodex(c.app, c.page, c.setup, {
      name: "codex-stall",
      env: { FIXTURE_FAULT: "stall" },
    });
    const conversationId = await sendChat(
      c.page,
      stuck.id,
      "Soak stream 1: stall.",
    );
    await expect(transcript(c.page)).toContainText("Streamed soak answer 1:", {
      timeout: 30000,
    });
    await c.page.waitForTimeout(20000);
    let [run] = await runsOf(c.page, conversationId);
    r.observe("after20sSilence", { status: run.status, error: run.error });
    r.check(
      "a silent run is not reported completed",
      run.status !== "completed",
      run.status,
    );
    const interrupt = c.page.getByRole("button", {
      name: "Interrupt",
      exact: true,
    });
    r.check(
      "the owner can interrupt the silent run",
      await interrupt.isVisible(),
    );
    await interrupt.click().catch(() => {});
    const clickedAt = Date.now();
    await expect
      .poll(async () => (await runsOf(c.page, conversationId))[0].status, {
        timeout: 60000,
      })
      .not.toMatch(/^(starting|running)$/)
      .catch(() => {});
    [run] = await runsOf(c.page, conversationId);
    r.observe("afterInterrupt", {
      status: run.status,
      error: run.error,
      ms: Date.now() - clickedAt,
    });
    await shot(c.page, "stall-after-interrupt");
    r.check(
      "after the interrupt the run is no longer running",
      !["starting", "running"].includes(run.status),
      run.status,
    );
    r.check(
      "the run is not reported completed",
      run.status !== "completed",
      run.status,
    );
    const left = await serviceStandIns(c.app);
    r.observe(
      "standInsAfterInterrupt",
      left.map((p) => p.pid),
    );
    const capacity = await sendChat(
      c.page,
      c.runtime.id,
      "Soak stream 2: after a stall.",
    );
    const outcome = await Promise.race([
      transcript(c.page)
        .getByText("End of soak answer 2.", { exact: false })
        .waitFor({ timeout: 60000 })
        .then(() => "completed"),
      c.page
        // The limit's wording since 4 November 2026 (W4-5), and before it.
        .getByText(
          /as many provider turns as it allows|concurrency budget is full/,
        )
        .first()
        .waitFor({ timeout: 60000 })
        .then(() => "refused: capacity"),
      c.page
        .getByText("already has a native session or writer lease", {
          exact: false,
        })
        .first()
        .waitFor({ timeout: 60000 })
        .then(() => "refused: lease"),
      c.page
        .getByText("uncertain ownership", { exact: false })
        .first()
        .waitFor({ timeout: 60000 })
        .then(() => "refused: uncertain"),
    ]).catch(() => "timeout");
    r.observe("nextChatAfterStall", {
      outcome,
      runs: (await runsOf(c.page, capacity)).map((x) => [x.status, x.error]),
    });
    await shot(c.page, "stall-next-chat");
    r.check(
      "the stalled stand-in does not block another chat forever",
      outcome === "completed",
      outcome,
    );
    r.observe("leases", await leases(c.page, c.projectId));
    // The owner's way out today: close Topsl, reopen, inspect and reconcile.
    const stuckPids = left.map((p) => p.pid);
    const pids = await c.app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => m.pid),
    );
    await c.app.close();
    const survivors = await exited([...pids, ...stuckPids], 20000);
    r.check(
      "closing Topsl stops the stalled stand-in",
      !survivors.length,
      survivors,
    );
    reopened = await launch(c.setup);
    await reopened.page.setViewportSize({ width: 1280, height: 900 });
    const page = reopened.page;
    await navigate(page, "Provider tools");
    await page
      .getByRole("combobox", { name: "Conversation", exact: true })
      .selectOption(conversationId);
    [run] = await runsOf(page, conversationId);
    r.observe("afterReopen", { status: run.status, error: run.error });
    // Since 4 November 2026 (W4-3) Topsl stops a turn that never ends its
    // interrupt, so the run is already interrupted; an older build left it
    // uncertain for reconciliation.
    r.check(
      "after the reopen the stalled run is settled: interrupted, or uncertain for reconciliation",
      ["interrupted", "uncertain"].includes(run.status),
      [run.status, run.error],
    );
    if (run.status === "uncertain") {
      await page
        .getByRole("button", { name: "Inspect & reconcile", exact: true })
        .click();
      await expect
        .poll(async () => (await runsOf(page, conversationId))[0].status, {
          timeout: 15000,
        })
        .toBe("interrupted")
        .catch(() => {});
      [run] = await runsOf(page, conversationId);
    }
    r.check("the stalled run ends interrupted", run.status === "interrupted", [
      run.status,
      run.error,
    ]);
    const next = await sendChat(
      page,
      c.runtime.id,
      "Soak stream 4: after reconciling.",
    );
    await expect(transcript(page)).toContainText("End of soak answer 4.", {
      timeout: 60000,
    });
    r.check(
      "after reconciliation a chat completes",
      (await runsOf(page, next))[0]?.status === "completed",
    );
    await shot(page, "stall-after-reconcile");
  } catch (error) {
    r.check(
      "journey completed without an unexpected error",
      false,
      String(error.message).slice(0, 1500),
    );
    await shot(reopened?.page ?? c.page, "stall-error");
  }
  return finish(r, reopened ? { ...reopened, setup: c.setup } : c);
}

// ---------------------------------------------------------------------------
/** Starts a Work session through New session and returns its id. */
async function startWork(page, projectId, text) {
  const known = new Set(
    (
      await page.evaluate(
        (projectId) =>
          window.topsl.command({ type: "session-list", projectId }),
        projectId,
      )
    ).map((s) => s.id),
  );
  await page
    .locator("aside.sidebar")
    .getByRole("button", { name: "New session", exact: true })
    .click();
  const home = page.getByRole("region", { name: "New session", exact: true });
  await home.getByRole("radio", { name: "Work", exact: true }).check();
  await home.getByRole("textbox", { name: "Message" }).fill(text);
  await home
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  let id = null;
  await expect
    .poll(
      async () => {
        const added = (
          await page.evaluate(
            (projectId) =>
              window.topsl.command({ type: "session-list", projectId }),
            projectId,
          )
        ).filter((s) => !known.has(s.id));
        id = added[0]?.id ?? null;
        return added.length;
      },
      { timeout: 30000 },
    )
    .toBe(1);
  return id;
}
/**
 * Stop session settles a session's work: no queued or running work item and
 * no intake still collecting, reconciling or endorsing. (Stop leaves the
 * session's `control` field "running"; it is not the measure.)
 */
const settledByStop = (view) =>
  view.session.queue.every(
    (w) => !["queued", "waiting-configuration", "running"].includes(w.state),
  ) &&
  view.intakes.every(
    (i) => !["collecting", "reconciling", "endorsing"].includes(i.stage),
  );
const sessionView = (page, sessionId) =>
  page.evaluate(
    (id) => window.topsl.command({ type: "session-query", sessionId: id }),
    sessionId,
  );
const goalsView = (page, projectId, sessionId) =>
  page.evaluate(
    async ({ projectId, sessionId }) =>
      (
        await window.topsl.command({
          type: "orchestration-query",
          projectId,
          conversationId: sessionId,
        })
      ).goals.map((g) => ({
        state: g.goal.state,
        detail: g.goal.detail,
        rounds: (g.rounds ?? []).map((x) => ({
          kind: x.purpose ?? x.kind,
          stage: x.stage,
          state: x.state,
          members: (x.members ?? []).map((m) => m.state),
        })),
      })),
    { projectId, sessionId },
  );
/** Waits until a member turn is in flight: a turn/start with no completion yet. */
async function memberInFlight(app, log, after) {
  await expect
    .poll(
      async () =>
        (await turnStarts(log)).length > after &&
        (await serviceStandIns(app)).length > 0,
      { timeout: 120000, intervals: [100] },
    )
    .toBe(true);
}

/**
 * Work interrupted by Topsl itself: `kind` "service-kill" SIGKILLs the control
 * service, "restart" closes Topsl; `phase` "intake" interrupts the
 * coordinator answering the session's first message, "goal" a member turn of
 * the goal it started. Then Topsl is reopened, the session inspected, Stop
 * tried, the uncertain run reconciled from Provider tools, and Stop tried
 * again.
 */
async function interrupted(kind, phase, { reconcileFirst = false } = {}) {
  const name = `${kind}${phase === "goal" ? "-goal" : ""}${reconcileFirst ? "-reconcile-first" : ""}`;
  const r = recorder(name);
  const c = await baseSetup(`rec-${name}`, { FIXTURE_TURN_DELAY_MS: 6000 });
  let reopened = null;
  try {
    const before = (await turnStarts(c.log)).length;
    const sessionId = await startWork(
      c.page,
      c.projectId,
      "Change the value to two in file.ts.",
    );
    let after = before;
    if (phase === "goal") {
      await expect
        .poll(
          async () =>
            (await sessionView(c.page, sessionId)).session.queue[0]?.state ??
            "none",
          { timeout: 120000 },
        )
        .toBe("running");
      after = (await turnStarts(c.log)).length;
    }
    await memberInFlight(c.app, c.log, after);
    const inFlight = await serviceStandIns(c.app);
    const promptsBefore = await turnStarts(c.log);
    const atInterrupt = await sessionView(c.page, sessionId);
    r.observe("atInterrupt", {
      queue: atInterrupt.session.queue.map((w) => w.state),
      intakes: atInterrupt.intakes.map((i) => i.stage),
      goals: await goalsView(c.page, c.projectId, sessionId),
      standIns: inFlight.map((p) => p.pid),
      turnStarts: promptsBefore.length,
    });
    if (kind === "service-kill") {
      process.kill(await servicePid(c.app), "SIGKILL");
      const banner = c.page
        .getByRole("alert")
        .filter({ hasText: "The control service stopped." });
      r.check(
        "the window says the control service stopped",
        await banner.waitFor({ timeout: 15000 }).then(
          () => true,
          () => false,
        ),
      );
      await shot(c.page, `${name}-banner`);
      const refused = await c.page.evaluate(() =>
        window.topsl.command({ type: "session-list", projectId: "x" }).then(
          () => "accepted",
          (e) => String(e.message),
        ),
      );
      r.check(
        "commands are refused while the service is gone",
        refused !== "accepted",
        refused,
      );
      await new Promise((resolve) => setTimeout(resolve, 10000));
      const orphans = inFlight.filter((p) => alive(p.pid));
      r.check(
        "the in-flight stand-in does not outlive the killed service by 10 s",
        orphans.length === 0,
        orphans.map((p) => p.pid),
      );
      r.check(
        "nothing new was started after the kill",
        (await turnStarts(c.log)).length === promptsBefore.length,
      );
      await c.app.close().catch(() => {});
    } else {
      const pids = await c.app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => m.pid),
      );
      const began = Date.now();
      await c.app.close();
      r.observe("closeMs", Date.now() - began);
      const left = await exited(
        [...pids, ...inFlight.map((p) => p.pid)],
        20000,
      );
      r.check(
        "closing stops Topsl and the in-flight stand-in",
        !left.length,
        left,
      );
    }
    reopened = await launch(c.setup);
    const page = reopened.page;
    await page.setViewportSize({ width: 1280, height: 900 });
    await new Promise((resolve) => setTimeout(resolve, 15000));
    const view = await sessionView(page, sessionId);
    const runs = (await allRuns(page)).map((x) => ({
      id: x.id,
      conversationId: x.conversationId,
      status: x.status,
      error: x.error,
    }));
    r.observe("afterReopen", {
      queue: view.session.queue.map((w) => w.state),
      control: view.session.control,
      intakes: view.intakes.map((i) => [i.stage, i.detail]),
      goals: await goalsView(page, c.projectId, sessionId),
      runs,
      leases: await leases(page, c.projectId),
    });
    const promptsAfter = await turnStarts(c.log);
    r.observe("turnStarts", {
      beforeInterrupt: promptsBefore.length,
      afterReopen15s: promptsAfter.length,
      duplicatePrompts: duplicates(promptsAfter),
    });
    r.check(
      "no member turn was sent twice after the reopen",
      duplicates(promptsAfter) === 0,
      duplicates(promptsAfter),
    );
    r.check(
      "nothing was started again after the reopen",
      promptsAfter.length === promptsBefore.length,
      promptsAfter.length - promptsBefore.length,
    );
    const uncertain = runs.filter((x) => x.status === "uncertain");
    r.check(
      "the interrupted member run is recorded uncertain",
      uncertain.length === 1,
      runs.map((x) => x.status),
    );
    r.check(
      "workspace ownership stays uncertain until reconciliation",
      (await leases(page, c.projectId)).some((l) => l.state === "uncertain"),
    );
    const session = page.getByRole("region", { name: "Session", exact: true });
    await expect(session)
      .toBeVisible({ timeout: 30000 })
      .catch(() => {});
    await shot(page, `${name}-reopened-session`);
    const text = (await session.textContent().catch(() => "")) ?? "";
    r.observe("sessionTextAfterReopen", text.slice(0, 1500));
    r.check(
      "the reopened session says its interrupted work needs inspection or reconciliation",
      /uncertain|reconcil|Inspect|interrupted/i.test(text),
      text.slice(0, 300),
    );
    r.check(
      "the reopened session does not claim a coordinator is still answering",
      !/Answering…|coordinator answering/i.test(text) || phase === "goal",
      text.slice(0, 300),
    );
    // Cancellation before any retry (unless the owner reconciles first).
    const stopBefore = (await turnStarts(c.log)).length;
    const stop = () =>
      session
        .getByRole("group", { name: "Session controls" })
        .getByRole("button", { name: "Stop session", exact: true })
        .click();
    let stopped = view;
    if (!reconcileFirst) {
      await stop();
      await page.waitForTimeout(5000);
      stopped = await sessionView(page, sessionId);
      const stopError = await session
        .getByRole("alert")
        .allTextContents()
        .catch(() => []);
      r.observe("afterFirstStop", {
        control: stopped.session.control,
        queue: stopped.session.queue.map((w) => w.state),
        intakes: stopped.intakes.map((i) => i.stage),
        errors: stopError,
      });
      await shot(page, `${name}-after-stop`);
      r.check(
        "Stop session stops the session before any retry",
        settledByStop(stopped),
        {
          queue: stopped.session.queue.map((w) => w.state),
          intakes: stopped.intakes.map((i) => i.stage),
          errors: stopError,
        },
      );
      r.check(
        "no member turn starts after Stop",
        (await turnStarts(c.log)).length === stopBefore,
      );
    }
    // The reconciliation the owner can reach: Provider tools, the run's conversation.
    if (uncertain.length) {
      await navigate(page, "Provider tools");
      await page
        .getByRole("combobox", { name: "Conversation", exact: true })
        .selectOption(uncertain[0].conversationId);
      const reconcile = page.getByRole("button", {
        name: "Inspect & reconcile",
        exact: true,
      });
      r.check(
        "Provider tools offers Inspect & reconcile for the coordinator's run",
        await reconcile.isVisible().catch(() => false),
      );
      await reconcile.click().catch(() => {});
      await expect
        .poll(
          async () =>
            (await allRuns(page)).find((x) => x.id === uncertain[0].id)?.status,
          { timeout: 15000 },
        )
        .toBe("interrupted")
        .catch(() => {});
      const settled = (await allRuns(page)).find(
        (x) => x.id === uncertain[0].id,
      );
      r.check(
        "Inspect & reconcile settles the coordinator's run",
        settled?.status === "interrupted",
        [settled?.status, settled?.error],
      );
      r.observe("leasesAfterReconcile", await leases(page, c.projectId));
      await page
        .locator("aside.sidebar")
        .getByRole("button", {
          name: "Change the value to two in file.ts.",
          exact: true,
        })
        .click();
      await page.waitForTimeout(10000);
      const afterReconcile = await sessionView(page, sessionId);
      const startsAfterReconcile = (await turnStarts(c.log)).length;
      r.observe("afterReconcile", {
        control: afterReconcile.session.control,
        queue: afterReconcile.session.queue.map((w) => w.state),
        intakes: afterReconcile.intakes.map((i) => [i.stage, i.detail]),
        goals: await goalsView(page, c.projectId, sessionId),
        turnStartsSinceStop: startsAfterReconcile - stopBefore,
        text: ((await session.textContent().catch(() => "")) ?? "").slice(
          0,
          800,
        ),
      });
      await shot(page, `${name}-after-reconcile`);
      if (reconcileFirst) {
        await page.waitForTimeout(15000);
        const later = await sessionView(page, sessionId);
        const starts = (await turnStarts(c.log)).length - stopBefore;
        r.observe("25sAfterReconcile", {
          intakes: later.intakes.map((i) => [i.stage, i.detail]),
          queue: later.session.queue.map((w) => w.state),
          turnStartsSinceReconcile: starts,
        });
        r.check(
          "after reconciliation the session moves on (its coordinator answers again or the intake settles)",
          starts > 0 || later.intakes.every((i) => i.stage !== "collecting"),
          { starts, intakes: later.intakes.map((i) => i.stage) },
        );
        r.check(
          "a retry after reconciliation sends the coordinator's turn at most once more",
          duplicates(await turnStarts(c.log)) <= 1,
          duplicates(await turnStarts(c.log)),
        );
      }
      const beforeSecondStop = (await turnStarts(c.log)).length;
      if (!settledByStop(afterReconcile)) {
        await stop();
        await page.waitForTimeout(5000);
        stopped = await sessionView(page, sessionId);
        r.observe("afterSecondStop", {
          control: stopped.session.control,
          queue: stopped.session.queue.map((w) => w.state),
          intakes: stopped.intakes.map((i) => i.stage),
          errors: await session
            .getByRole("alert")
            .allTextContents()
            .catch(() => []),
        });
        r.check(
          "after reconciliation Stop session stops the session",
          settledByStop(stopped),
          {
            queue: stopped.session.queue.map((w) => w.state),
            intakes: stopped.intakes.map((i) => i.stage),
          },
        );
      }
      await page.waitForTimeout(5000);
      r.observe("turnStartsAtEnd", (await turnStarts(c.log)).length);
      r.check(
        "no turn starts after the session is stopped",
        (await turnStarts(c.log)).length === beforeSecondStop,
        { beforeSecondStop, atEnd: (await turnStarts(c.log)).length },
      );
    }
  } catch (error) {
    r.check(
      "journey completed without an unexpected error",
      false,
      String(error.message).slice(0, 1500),
    );
    await shot(reopened?.page ?? c.page, `${name}-error`);
  }
  return finish(r, reopened ? { ...reopened, setup: c.setup } : c);
}
// ---------------------------------------------------------------------------
async function double() {
  const r = recorder("double");
  const c = await baseSetup("rec-double");
  try {
    const page = c.page;
    const list = async () =>
      (
        await page.evaluate(
          (projectId) =>
            window.topsl.command({ type: "session-list", projectId }),
          c.projectId,
        )
      ).map((s) => s.id);
    // Double-click Start session.
    const known = new Set(await list());
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const home = page.getByRole("region", { name: "New session", exact: true });
    await home.getByRole("radio", { name: "Discuss", exact: true }).check();
    await home
      .getByRole("textbox", { name: "Message" })
      .fill("Double click: how does file.ts hold its value?");
    await home
      .getByRole("button", { name: "Start session", exact: true })
      .dblclick();
    await page.waitForTimeout(5000);
    const added = (await list()).filter((id) => !known.has(id));
    r.check(
      "a double-clicked Start session creates one session",
      added.length === 1,
      added.length,
    );
    await page.waitForTimeout(5000);
    const doubleTurns = (await turnStarts(c.log)).filter((p) =>
      p.includes("Double click: how does file.ts"),
    );
    r.observe("startSessionDoubleClick", {
      sessions: added.length,
      coordinatorTurnsNamingTheMessage: doubleTurns.length,
    });
    const sessionId = added[0];
    const thread = page.getByRole("region", { name: "Session", exact: true });
    await expect(thread.locator("li.turn.coordinator").first()).toBeVisible({
      timeout: 60000,
    });
    let view = await sessionView(page, sessionId);
    r.check(
      "its first message has one intake",
      view.intakes.length === 1,
      view.intakes.length,
    );
    // Double-click Send.
    await thread
      .getByRole("group", { name: "Composer mode" })
      .getByRole("radio", { name: "Discuss", exact: true })
      .check();
    await thread
      .getByRole("textbox", { name: "Message" })
      .fill("Double send: is it still one value?");
    await thread.getByRole("button", { name: "Send", exact: true }).dblclick();
    await page.waitForTimeout(5000);
    view = await sessionView(page, sessionId);
    r.check(
      "a double-clicked Send adds one intake",
      view.intakes.length === 2,
      view.intakes.length,
    );
    const users = (
      await thread
        .getByRole("list", { name: "Conversation" })
        .locator(":scope > li")
        .allTextContents()
    ).filter((t) => t.includes("Double send"));
    r.check(
      "a double-clicked Send shows the message once",
      users.length === 1,
      users.length,
    );
    await page.waitForTimeout(3000);
    r.observe("sendDoubleClick", {
      intakes: view.intakes.length - 1,
      shown: users.length,
      coordinatorTurnsNamingTheMessage: (await turnStarts(c.log)).filter((p) =>
        p.includes("Double send: is it still one value?"),
      ).length,
    });
    await shot(page, "double-send-session");
    // The same commandId twice over IPC, concurrently and then again.
    const intakesBefore = view.intakes.length;
    const twice = await page.evaluate(async (sessionId) => {
      const commandId = crypto.randomUUID();
      const message = {
        type: "session-message",
        sessionId,
        text: "Same command twice?",
        mode: "discuss",
        commandId,
      };
      const [a, b] = await Promise.all([
        window.topsl.command(message),
        window.topsl.command(message),
      ]);
      const c2 = await window.topsl.command(message);
      return { a, b, c: c2 };
    }, sessionId);
    view = await sessionView(page, sessionId);
    r.observe("sameCommandIdResults", twice);
    r.check(
      "one session-message commandId sent three times starts one intake",
      view.intakes.length === intakesBefore + 1 &&
        twice.a.intakeId === twice.b.intakeId &&
        twice.b.intakeId === twice.c.intakeId,
      { before: intakesBefore, after: view.intakes.length },
    );
    const createTwice = await page.evaluate(async (projectId) => {
      const commandId = crypto.randomUUID();
      const create = {
        type: "session-create",
        projectId,
        text: "Created twice?",
        mode: "discuss",
        commandId,
      };
      const [a, b] = await Promise.all([
        window.topsl.command(create),
        window.topsl.command(create),
      ]);
      return { a: a.sessionId, b: b.sessionId };
    }, c.projectId);
    r.observe("sameCreateCommandId", createTwice);
    r.check(
      "one session-create commandId sent twice creates one session",
      createTwice.a === createTwice.b,
      createTwice,
    );
    const changed = await page.evaluate(
      async ({ projectId }) => {
        const commandId = crypto.randomUUID();
        const first = await window.topsl.command({
          type: "session-create",
          projectId,
          text: "First text",
          mode: "discuss",
          commandId,
        });
        const second = await window.topsl
          .command({
            type: "session-create",
            projectId,
            text: "Different text",
            mode: "discuss",
            commandId,
          })
          .then(
            (v) => ({ ok: v.sessionId }),
            (e) => ({ error: String(e.message) }),
          );
        return { first: first.sessionId, second };
      },
      { projectId: c.projectId },
    );
    r.observe("reusedCommandIdWithDifferentInput", changed);
    r.check(
      "a commandId reused with different input is refused or returns the first result",
      changed.second.error || changed.second.ok === changed.first,
      changed,
    );
    // Double-click Send to Codex on a new chat: one run, one turn. A chat
    // takes the whole concurrency budget, so it waits until the sessions'
    // coordinators have answered.
    await expect
      .poll(
        async () =>
          page.evaluate(async (projectId) => {
            const sessions = await window.topsl.command({
              type: "session-list",
              projectId,
            });
            for (const s of sessions) {
              const view = await window.topsl.command({
                type: "session-query",
                sessionId: s.id,
              });
              if (
                view.intakes.some((i) =>
                  ["collecting", "reconciling", "endorsing"].includes(i.stage),
                )
              )
                return false;
            }
            return true;
          }, c.projectId),
        { timeout: 120000 },
      )
      .toBe(true);
    await page.waitForTimeout(3000);
    const conversationId = await sendChat(
      page,
      c.runtime.id,
      "Soak stream 6: double.",
      { double: true },
    );
    await expect(transcript(page)).toContainText("End of soak answer 6.", {
      timeout: 60000,
    });
    await page.waitForTimeout(5000);
    const runs = await runsOf(page, conversationId);
    const prompts = (await turnStarts(c.log)).filter((p) =>
      p.includes("Soak stream 6"),
    );
    r.observe("doubleSendToCodex", {
      runs: runs.map((x) => [x.status, x.error]),
      turnStarts: prompts.length,
    });
    r.check(
      "a double-clicked Send to Codex starts one turn",
      prompts.length === 1,
      prompts.length,
    );
    await shot(page, "double-send-to-codex");
  } catch (error) {
    r.check(
      "journey completed without an unexpected error",
      false,
      String(error.message).slice(0, 1500),
    );
    await shot(c.page, "double-error");
  }
  return finish(r, c);
}

// ---------------------------------------------------------------------------
/**
 * Not a fault: how soon a goal accepted on its card settles the session's
 * work item. The soak read work items as "running" right after the card
 * said Accepted; this measures the delay.
 */
async function acceptSettles() {
  const r = recorder("accept-settles");
  const c = await baseSetup("rec-accept");
  try {
    const delays = [];
    for (let n = 1; n <= 3; n++) {
      const text = `Accept ${n}: change the value to two in file.ts.`;
      const sessionId = await startWork(c.page, c.projectId, text);
      const goal = c.page
        .getByRole("region", { name: "Session", exact: true })
        .getByRole("article", { name: `Goal ${text}` });
      await expect(
        goal.getByText("Awaiting acceptance", { exact: true }),
      ).toBeVisible({ timeout: 180000 });
      await goal
        .getByRole("button", { name: "Accept candidate…", exact: true })
        .click();
      await expect(goal.getByText("Accepted", { exact: true })).toBeVisible({
        timeout: 60000,
      });
      const shown = Date.now();
      const states = [];
      let settledAfter = null;
      while (Date.now() - shown < 60000) {
        const state = (await sessionView(c.page, sessionId)).session.queue[0]
          ?.state;
        states.push(state);
        if (state === "accepted") {
          settledAfter = Date.now() - shown;
          break;
        }
        await c.page.waitForTimeout(250);
      }
      delays.push({
        n,
        settledAfter,
        firstState: states[0],
        polls: states.length,
      });
    }
    r.observe("acceptToWorkItemAccepted", delays);
    r.check(
      "an accepted goal's work item becomes accepted within 60 s",
      delays.every((d) => d.settledAfter !== null),
      delays,
    );
  } catch (error) {
    r.check(
      "journey completed without an unexpected error",
      false,
      String(error.message).slice(0, 1500),
    );
    await shot(c.page, "accept-settles-error");
  }
  return finish(r, c);
}

const cases = {
  "accept-settles": acceptSettles,
  disconnect,
  malformed,
  stall,
  double,
  "service-kill": () => interrupted("service-kill", "intake"),
  "service-kill-goal": () => interrupted("service-kill", "goal"),
  restart: () => interrupted("restart", "intake"),
  "restart-goal": () => interrupted("restart", "goal"),
  "restart-reconcile-first": () =>
    interrupted("restart", "intake", { reconcileFirst: true }),
};
const results = [];
for (const name of selected) {
  console.log(`--- ${name}`);
  results.push(await cases[name]());
}
const summary = results.map((x) => ({
  case: x.case,
  passed: x.passed,
  failed: x.checks.filter((c) => !c.ok).map((c) => c.label),
}));
await writeFile(
  path.join(out, `recovery-summary-${values.case.replaceAll(",", "+")}.json`),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
// A failed check is a finding to triage; the exit code says one was recorded.
if (results.some((x) => !x.passed)) process.exitCode = 1;
