import { navigate, openThread } from "./desktop-navigation.mjs";
import { expect } from "@playwright/test";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import {
  addProject,
  coordinatorReady,
  createProfile,
  exited,
  launch,
  processes,
  qualifiedCodex,
  standIns,
  tree,
} from "./campaign-harness.mjs";

// The campaign's Electron navigation and streaming soak
// (docs/testing/2026-11-04-comprehensive/PLAN.md, "Load"): for --minutes
// (60 by default) one Topsl window, with an isolated profile and a qualified
// Codex stand-in (tests/fixtures/codex-soak.cjs), cycles its destinations,
// opens the command palette, starts Discuss and Work sessions whose
// coordinators answer, accepts or stops the goals, opens and closes the
// session panes, reopens older sessions, and sends Provider tools chat turns
// whose replies stream. Every minute it samples the main process's memory,
// the renderer's JS heap and DOM size, Electron's processes, the stand-in
// processes and store (IPC) timings. UI timings are wall-clock times in this
// Node process from the click to the visible result, so they include
// Playwright's locator polling. At the end it quits Topsl and checks that no
// Topsl or stand-in process remains. Samples, timings and a summary go to
// --out. No model or account is contacted. macOS and Linux only.
//
//   npm run build
//   node scripts/campaign-soak.mjs --minutes 60 --out test-results/soak

if (process.platform === "win32") {
  console.log("Skipped on Windows: the soak reads the process table with ps.");
  process.exit(0);
}
const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "60" },
    out: { type: "string", default: "test-results/soak" },
    "turn-delay": { type: "string", default: "300" },
    "cycle-seconds": { type: "string", default: "20" },
    keep: { type: "boolean", default: false },
  },
});
const minutes = Number(values.minutes);
const out = path.resolve(values.out);
await mkdir(path.join(out, "failures"), { recursive: true });
const samplesFile = path.join(out, "soak-samples.jsonl");
const timingsFile = path.join(out, "soak-timings.jsonl");
const eventsFile = path.join(out, "soak-events.jsonl");
await writeFile(samplesFile, "");
await writeFile(timingsFile, "");
await writeFile(eventsFile, "");
const log = (event) => {
  const line = { at: new Date().toISOString(), ...event };
  console.log(JSON.stringify(line));
  return appendFile(eventsFile, JSON.stringify(line) + "\n");
};

const setup = await createProfile("soak");
const startedAt = Date.now();
const elapsedMinutes = () => (Date.now() - startedAt) / 60000;
const { app, page } = await launch(setup);
const mainPid = app.process().pid;
await page.setViewportSize({ width: 1280, height: 900 });
const projectId = await addProject(app, page, setup);
const projectName = path.basename(setup.project);
const runtime = await qualifiedCodex(app, page, setup, {
  name: "codex-soak-fixture",
  env: { FIXTURE_TURN_DELAY_MS: values["turn-delay"] },
});
await coordinatorReady(page, projectId);
await navigate(page, "Projects");
await log({ event: "setup", profile: setup.profile, mainPid, runtime });

const cdp = await page
  .context()
  .newCDPSession(page)
  .catch(() => null);
if (cdp) await cdp.send("Performance.enable").catch(() => {});
async function rendererMetrics() {
  const fromPage = await page.evaluate(() => ({
    usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null,
    totalJSHeapSize: performance.memory?.totalJSHeapSize ?? null,
    domNodes: document.getElementsByTagName("*").length,
  }));
  if (!cdp) return fromPage;
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return {
    ...fromPage,
    cdpJSHeapUsedSize: m.JSHeapUsedSize ?? null,
    cdpJSHeapTotalSize: m.JSHeapTotalSize ?? null,
    cdpNodes: m.Nodes ?? null,
    cdpDocuments: m.Documents ?? null,
    cdpJSEventListeners: m.JSEventListeners ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sampling.
let lastTreePids = [];
let currentSessionId = null;
// Stand-in processes live only while a connection is open, so a minute's
// sample can miss them: the process table is also read every 5 seconds.
const seenStandIns = new Set();
let standInsMax = 0;
let standInsMaxEver = 0;
const standInPoll = setInterval(() => {
  try {
    const found = standIns();
    for (const p of found) seenStandIns.add(p.pid);
    standInsMax = Math.max(standInsMax, found.length);
    standInsMaxEver = Math.max(standInsMaxEver, found.length);
  } catch {
    // The next poll reads it again.
  }
}, 1000);
async function storeTimings() {
  return page.evaluate(
    async ({ projectId, sessionId }) => {
      const timed = async (command) => {
        const begin = performance.now();
        await window.topsl.command(command);
        return Math.round((performance.now() - begin) * 10) / 10;
      };
      return {
        sessionListMs: await timed({ type: "session-list", projectId }),
        sessionQueryMs: sessionId
          ? await timed({ type: "session-query", sessionId })
          : null,
        orchestrationQueryMs: await timed({
          type: "orchestration-query",
          projectId,
        }),
        historyPageMs: await timed({
          type: "history-page",
          projectId,
          limit: 80,
        }),
      };
    },
    { projectId, sessionId: currentSessionId },
  );
}
async function sample(label) {
  const at = Date.now();
  const main = await app.evaluate(() => process.memoryUsage());
  const metrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name ?? null,
      serviceName: m.serviceName ?? null,
      cpu: m.cpu.percentCPUUsage,
      workingSetKb: m.memory.workingSetSize,
      peakWorkingSetKb: m.memory.peakWorkingSetSize,
    })),
  );
  const renderer = await rendererMetrics();
  const store = await storeTimings();
  const list = processes();
  const ours = tree(list, mainPid);
  lastTreePids = ours.map((p) => p.pid);
  const fixtures = standIns(list);
  const ourPids = new Set(ours.map((p) => p.pid));
  const otherElectron = list.filter(
    (p) =>
      !ourPids.has(p.pid) && /Electron\.app\/Contents\/MacOS\//.test(p.command),
  );
  const others = list.filter((p) => !ourPids.has(p.pid));
  const record = {
    label,
    at: new Date(at).toISOString(),
    minute: Math.round(((at - startedAt) / 60000) * 100) / 100,
    main: {
      rssMb: main.rss / 1048576,
      heapUsedMb: main.heapUsed / 1048576,
      heapTotalMb: main.heapTotal / 1048576,
      externalMb: main.external / 1048576,
    },
    renderer,
    electron: {
      processes: metrics.length,
      byType: metrics.reduce(
        (acc, m) => ({ ...acc, [m.type]: (acc[m.type] ?? 0) + 1 }),
        {},
      ),
      workingSetMb: metrics.reduce((s, m) => s + m.workingSetKb, 0) / 1024,
      service:
        metrics.find(
          (m) =>
            m.type === "Utility" &&
            /control/i.test(m.name ?? m.serviceName ?? ""),
        ) ?? null,
      metrics,
    },
    tree: {
      processes: ours.length,
      rssMb: ours.reduce((s, p) => s + p.rssKb, 0) / 1024,
    },
    standIns: {
      count: fixtures.length,
      inTree: fixtures.filter((p) => ourPids.has(p.pid)).length,
      rssMb: fixtures.reduce((s, p) => s + p.rssKb, 0) / 1024,
      pids: fixtures.map((p) => p.pid),
      maxSinceLastSample: Math.max(standInsMax, fixtures.length),
      seenTotal: seenStandIns.size,
    },
    store,
    machine: {
      loadavg: os.loadavg(),
      freeMemMb: os.freemem() / 1048576,
      otherElectronProcesses: otherElectron.length,
      otherElectronRssMb: otherElectron.reduce((s, p) => s + p.rssKb, 0) / 1024,
      otherCpuPercent: others.reduce((s, p) => s + p.cpu, 0),
    },
    sampleMs: Date.now() - at,
  };
  standInsMax = 0;
  await appendFile(samplesFile, JSON.stringify(record) + "\n");
  return record;
}

// ---------------------------------------------------------------------------
// UI timings.
const timings = [];
async function timed(kind, fn) {
  const begin = performance.now();
  try {
    const value = await fn();
    const ms = performance.now() - begin;
    const t = { kind, minute: elapsedMinutes(), ms, ok: true };
    timings.push(t);
    await appendFile(timingsFile, JSON.stringify(t) + "\n");
    return value;
  } catch (error) {
    const ms = performance.now() - begin;
    const t = {
      kind,
      minute: elapsedMinutes(),
      ms,
      ok: false,
      error: String(error.message ?? error).split("\n")[0],
    };
    timings.push(t);
    await appendFile(timingsFile, JSON.stringify(t) + "\n");
    throw error;
  }
}
const heading = (name) =>
  page.getByRole("heading", { level: 1, name, exact: true });

const destinations = [
  "Providers",
  "Settings",
  "Projects",
  "All sessions",
  "Project settings",
  "Provider tools",
  "Advanced workflows",
];
async function sweep() {
  for (const name of destinations)
    await timed(`navigate:${name}`, async () => {
      await navigate(page, name);
      await expect(heading(name)).toBeVisible({ timeout: 30000 });
    });
}
const paletteKey = process.platform === "darwin" ? "Meta+k" : "Control+k";
async function palette(target) {
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await timed("palette:open", async () => {
    await page.keyboard.press(paletteKey);
    await expect(dialog).toBeVisible({ timeout: 10000 });
  });
  if (!target) {
    await timed("palette:close", async () => {
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0, { timeout: 10000 });
    });
    return;
  }
  await timed(`palette:${target}`, async () => {
    await dialog
      .getByRole("button", { name: `${target} →`, exact: true })
      .click();
    await expect(heading(target)).toBeVisible({ timeout: 30000 });
  });
}

const sessions = [];
const thread = page.getByRole("region", { name: "Session", exact: true });
const sessionIds = () =>
  page.evaluate(
    async (projectId) =>
      (await window.topsl.command({ type: "session-list", projectId })).map(
        (s) => s.id,
      ),
    projectId,
  );
async function startSession(mode, text) {
  await palette("New session");
  const home = page.getByRole("region", { name: "New session", exact: true });
  await home.getByRole("radio", { name: mode, exact: true }).check();
  await home.getByRole("textbox", { name: "Message" }).fill(text);
  const known = new Set(await sessionIds());
  const begin = performance.now();
  await home
    .getByRole("button", { name: "Start session", exact: true })
    .click();
  await expect(heading(text)).toBeVisible({ timeout: 30000 });
  let id = null;
  await expect
    .poll(
      async () => {
        const added = (await sessionIds()).filter((s) => !known.has(s));
        id = added.length === 1 ? added[0] : null;
        return added.length;
      },
      { timeout: 30000 },
    )
    .toBe(1);
  currentSessionId = id;
  const entry = { id, title: text, mode, begin };
  sessions.push(entry);
  return entry;
}

let discussions = 0;
async function discuss() {
  const n = ++discussions;
  const text = `Soak discuss ${n}: how does file.ts hold its value?`;
  const before = performance.now();
  const entry = await startSession("Discuss", text);
  await timed("session:discuss-start-to-reply", async () => {
    await expect(
      thread
        .getByRole("list", { name: "Conversation" })
        .locator(":scope > li.turn.coordinator")
        .filter({
          hasText: /file\.ts holds one exported value|The coordinators agree/,
        }),
    ).toBeVisible({ timeout: 120000 });
  });
  // The start time is the click; timed() above measures from the heading.
  timings.at(-1).fromClickMs = performance.now() - entry.begin;
  timings.at(-1).fromPaletteMs = performance.now() - before;
  await panes();
}
async function panes() {
  for (const [toggle, region, close] of [
    [/^Work/, "Work details", "Close work details"],
    ["Team", "Team details", "Close team details"],
    [/^Results/, "Results details", "Close results details"],
  ]) {
    const pane = thread.getByRole("complementary", { name: region });
    await timed(`pane:open:${region}`, async () => {
      await thread
        .getByRole("group", { name: "Thread panes" })
        .getByRole("button", {
          name: toggle,
          ...(typeof toggle === "string" ? { exact: true } : {}),
        })
        .click();
      await expect(pane).toBeVisible({ timeout: 15000 });
    });
    await timed(`pane:close:${region}`, async () => {
      await pane.getByRole("button", { name: close, exact: true }).click();
      await expect(pane).toHaveCount(0, { timeout: 15000 });
    });
  }
}

let works = 0;
let lastWork = null;
const goalOutcomes = [];
async function settleWork(entry) {
  // The previous Work session: accept its goal when it awaits acceptance,
  // otherwise stop the session; either way verify the stored result.
  await timed("session:reopen-from-all-sessions", async () => {
    await navigate(page, "All sessions");
    await expect(heading("All sessions")).toBeVisible({ timeout: 30000 });
    await page
      .getByRole("region", { name: "All sessions" })
      .getByRole("button", { name: entry.title, exact: true })
      .first()
      .click();
    await expect(heading(entry.title)).toBeVisible({ timeout: 30000 });
  });
  currentSessionId = entry.id;
  const goal = thread.getByRole("article", { name: `Goal ${entry.title}` });
  await expect(goal).toBeVisible({ timeout: 30000 });
  const awaiting = goal.getByText("Awaiting acceptance", { exact: true });
  if (await awaiting.isVisible()) {
    await timed("goal:accept", async () => {
      await goal
        .getByRole("button", { name: "Accept candidate…", exact: true })
        .click();
      await expect(goal.getByText("Accepted", { exact: true })).toBeVisible({
        timeout: 60000,
      });
    });
  } else {
    await timed("session:stop", async () => {
      await thread
        .getByRole("group", { name: "Session controls" })
        .getByRole("button", { name: "Stop session", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(
                (id) =>
                  window.topsl.command({
                    type: "session-query",
                    sessionId: id,
                  }),
                entry.id,
              )
            ).session.queue[0]?.state,
          { timeout: 60000 },
        )
        .toMatch(/^(stopped|accepted|completed)$/);
    });
  }
  const view = await page.evaluate(
    (id) => window.topsl.command({ type: "session-query", sessionId: id }),
    entry.id,
  );
  const states = view.session.queue.map((w) => w.state);
  goalOutcomes.push({ session: entry.title, states });
  if (states.length !== 1)
    await log({
      event: "anomaly",
      detail: "goal count",
      states,
      session: entry.title,
    });
}
async function work() {
  if (lastWork) {
    const previous = lastWork;
    lastWork = null;
    await settleWork(previous);
  }
  const n = ++works;
  const text = `Soak work ${n}: change the value to two in file.ts.`;
  const entry = await startSession("Work", text);
  await timed("session:work-start-to-goal-card", async () => {
    await expect(
      thread.getByRole("article", { name: `Goal ${text}` }),
    ).toBeVisible({ timeout: 120000 });
  });
  timings.at(-1).fromClickMs = performance.now() - entry.begin;
  lastWork = entry;
}

let chats = 0;
let chatRefusals = 0;
let chatRuntimeSet = false;
async function chat() {
  const n = ++chats;
  await timed("navigate:Provider tools", async () => {
    await navigate(page, "Provider tools");
    await expect(heading("Provider tools")).toBeVisible({ timeout: 30000 });
  });
  const conversation = page.getByRole("combobox", {
    name: "Conversation",
    exact: true,
  });
  // Every chat is a new conversation: a second turn resumes the Codex thread
  // (thread/resume), which the qualification stand-in does not implement.
  {
    const earlier = await conversation.inputValue();
    await timed("chat:new", async () => {
      await page
        .getByRole("button", { name: "+ New chat", exact: true })
        .click();
      await expect(conversation).not.toHaveValue(earlier, { timeout: 30000 });
    });
    chatRuntimeSet = false;
  }
  if (!chatRuntimeSet) {
    await page
      .getByRole("combobox", { name: "Runtime", exact: true })
      .selectOption(runtime.id);
    // The chat's model list is the one Models & account reads.
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
    chatRuntimeSet = true;
  }
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: /^Send to Codex/ });
  const transcript = page.getByRole("region", {
    name: "Conversation transcript",
  });
  await message.fill(`Soak stream ${n}: please stream a reply.`);
  await expect(send).toBeEnabled({ timeout: 60000 });
  // A chat on a route with unknown native fan-out takes the whole
  // coordinator/provider concurrency budget, so while a session member's
  // turn holds a slot Topsl refuses it without dispatching
  // (packages/runtime/concurrency.ts). The owner's text stays in the
  // composer; the soak dismisses the notice and sends again, as an owner
  // would, and records each refusal.
  const refusal = page.getByText(
    "Coordinator/provider concurrency budget is full.",
    { exact: false },
  );
  const streamed = transcript.getByText(`Streamed soak answer ${n}:`, {
    exact: false,
  });
  const firstClick = performance.now();
  let begin = firstClick;
  let refusals = 0;
  for (;;) {
    begin = performance.now();
    await send.click();
    const outcome = await Promise.race([
      streamed
        .waitFor({ state: "visible", timeout: 120000 })
        .then(() => "streamed"),
      refusal
        .first()
        .waitFor({ state: "visible", timeout: 120000 })
        .then(() => "refused"),
    ]).catch(() => "timeout");
    if (outcome === "streamed") break;
    if (outcome === "timeout" || refusals >= 40) {
      timings.push({
        kind: "chat:send-to-first-streamed-text",
        minute: elapsedMinutes(),
        ms: performance.now() - begin,
        ok: false,
        error: `no streamed text (${outcome}, ${refusals} refusals)`,
      });
      throw new Error(`Chat ${n}: no streamed text (${outcome})`);
    }
    refusals++;
    chatRefusals++;
    // What held the budget: the open Work goal's state, if any.
    const holder = lastWork
      ? await page
          .evaluate(
            async ({ projectId, sessionId }) => {
              const view = await window.topsl.command({
                type: "orchestration-query",
                projectId,
                conversationId: sessionId,
              });
              return view.goals.map((g) => ({
                state: g.goal.state,
                rounds: (g.rounds ?? [])
                  .map((r) => `${r.purpose ?? r.kind}:${r.state}`)
                  .slice(-3),
              }));
            },
            { projectId, sessionId: lastWork.id },
          )
          .catch((e) => String(e.message))
      : null;
    const r = {
      kind: "chat:refused-capacity",
      minute: elapsedMinutes(),
      ms: performance.now() - begin,
      ok: true,
      holder,
    };
    await appendFile(timingsFile, JSON.stringify(r) + "\n");
    timings.push(r);
    await page
      .getByRole("button", { name: /^Dismiss .*error$/ })
      .first()
      .click();
    await expect(refusal).toHaveCount(0, { timeout: 10000 });
    await page.waitForTimeout(3000);
    await expect(message).toHaveValue(
      `Soak stream ${n}: please stream a reply.`,
    );
  }
  const firstText = performance.now() - begin;
  const t = {
    kind: "chat:send-to-first-streamed-text",
    minute: elapsedMinutes(),
    ms: firstText,
    ok: true,
    refusals,
    fromFirstClickMs: performance.now() - firstClick,
  };
  timings.push(t);
  await appendFile(timingsFile, JSON.stringify(t) + "\n");
  await timed("chat:send-to-complete", async () => {
    await expect(transcript).toContainText(`End of soak answer ${n}.`, {
      timeout: 120000,
    });
  });
  timings.at(-1).ms = performance.now() - begin;
}
let reopens = 0;
async function reopenOlder() {
  // The sidebar lists a project's 8 most recent sessions, then "All N
  // sessions"; an older session opens from All sessions.
  const older = sessions.slice(0, -1);
  if (older.length < 2) return;
  reopens++;
  if (reopens % 2) {
    const recent = older.slice(-6);
    const target = recent[Math.floor(Math.random() * recent.length)];
    await timed("session:open-from-sidebar", async () => {
      await openThread(page, projectName, target.title);
      await expect(heading(target.title)).toBeVisible({ timeout: 30000 });
    });
    currentSessionId = target.id;
    return;
  }
  // All sessions shows 50 at a time, so an older one is found by search.
  const target = older[Math.floor(Math.random() * older.length)];
  const index = page.getByRole("region", { name: "All sessions" });
  await navigate(page, "All sessions");
  await expect(heading("All sessions")).toBeVisible({ timeout: 30000 });
  await timed("session:all-sessions-search", async () => {
    await index
      .getByRole("textbox", { name: "Search sessions" })
      .fill(target.title.split(":")[0] + ":");
    await index.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      index.getByRole("button", { name: target.title, exact: true }),
    ).toBeVisible({ timeout: 30000 });
  });
  await timed("session:open-from-all-sessions", async () => {
    await index
      .getByRole("button", { name: target.title, exact: true })
      .first()
      .click();
    await expect(heading(target.title)).toBeVisible({ timeout: 30000 });
  });
  currentSessionId = target.id;
}

// ---------------------------------------------------------------------------
// The run.
const failures = [];
let consecutive = 0;
async function step(name, fn) {
  try {
    await fn();
    consecutive = 0;
  } catch (error) {
    consecutive++;
    const shot = path.join(
      out,
      "failures",
      `m${elapsedMinutes().toFixed(1)}-${name}.png`,
    );
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const failure = {
      step: name,
      minute: elapsedMinutes(),
      error: String(error.message ?? error).slice(0, 2000),
      screenshot: shot,
    };
    failures.push(failure);
    await log({ event: "failure", ...failure });
    await page.keyboard.press("Escape").catch(() => {});
    await navigate(page, "Projects").catch(() => {});
  }
}

const first = await sample("start");
let sampling = true;
const sampler = (async () => {
  let next = 1;
  while (sampling) {
    const due = startedAt + next * 60000;
    while (sampling && Date.now() < due)
      await new Promise((resolve) => setTimeout(resolve, 500));
    if (!sampling) break;
    try {
      await sample(`minute-${next}`);
    } catch (error) {
      await log({ event: "sample-failed", error: String(error.message) });
    }
    next++;
  }
})();

let cycle = 0;
const endAt = startedAt + minutes * 60000;
const cycleMs = Number(values["cycle-seconds"]) * 1000;
while (Date.now() < endAt && consecutive < 8) {
  // Cycles start at most every --cycle-seconds, so each minute holds about
  // one Discuss session, one Work session and one streamed chat at 20 s.
  const due = startedAt + cycle * cycleMs;
  if (Date.now() < due)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(due, endAt) - Date.now()),
    );
  if (Date.now() >= endAt) break;
  cycle++;
  await step("sweep", sweep);
  await step("palette", () => palette(null));
  if (cycle % 3 === 1) await step("discuss", discuss);
  if (cycle % 3 === 2) await step("work", work);
  if (cycle % 3 === 0) await step("chat", chat);
  await step("reopen", reopenOlder);
  await step("palette-providers", () => palette("Providers"));
  if (cycle % 10 === 0)
    await log({ event: "progress", cycle, minute: elapsedMinutes() });
}
const aborted = consecutive >= 8;
if (lastWork) await step("settle-last-work", () => settleWork(lastWork));
sampling = false;
await sampler;
const last = await sample("end");
// After a forced garbage collection, to tell retained memory from garbage.
let collected = null;
if (cdp) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
  collected = await sample("end-after-renderer-gc");
}
const storeBytes = (() => {
  try {
    return execFileSync("du", ["-sk", setup.profile], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[0];
  } catch {
    return null;
  }
})();

// Quit, then confirm nothing of this run is left.
const treeBeforeQuit = lastTreePids.slice();
const standInsBeforeQuit = standIns().map((p) => p.pid);
const quitBegin = performance.now();
await app.close();
const quitMs = performance.now() - quitBegin;
clearInterval(standInPoll);
const leftTree = await exited(treeBeforeQuit, 20000);
const leftSeen = await exited([...seenStandIns], 5000);
const leftStandIns = standIns();
const leftovers = {
  treeBeforeQuit: treeBeforeQuit.length,
  standInsBeforeQuit: standInsBeforeQuit.length,
  standInsSeenDuringRun: seenStandIns.size,
  standInsMaxConcurrent: standInsMaxEver,
  remainingSeenStandInPids: leftSeen,
  remainingTreePids: leftTree,
  remainingStandIns: leftStandIns.map((p) => ({
    pid: p.pid,
    command: p.command,
  })),
  quitMs,
};
await log({ event: "quit", ...leftovers });

// ---------------------------------------------------------------------------
// Summary.
const samples = (await import("node:fs"))
  .readFileSync(samplesFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((s) => s.label !== "end-after-renderer-gc");
function trend(pick) {
  const points = samples
    .map((s) => [s.minute, pick(s)])
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v));
  if (!points.length) return null;
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const sxy = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const round = (v) => Math.round(v * 100) / 100;
  return {
    start: round(points[0][1]),
    end: round(points.at(-1)[1]),
    min: round(Math.min(...points.map(([, y]) => y))),
    max: round(Math.max(...points.map(([, y]) => y))),
    slopePerHour: sxx ? round((sxy / sxx) * 60) : 0,
    samples: n,
  };
}
const percentile = (values, p) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length
    ? Math.round(
        sorted[
          Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
        ] * 10,
      ) / 10
    : null;
};
const kinds = [...new Set(timings.map((t) => t.kind))];
const ui = Object.fromEntries(
  kinds.map((kind) => {
    const all = timings.filter((t) => t.kind === kind);
    const ok = all.filter((t) => t.ok).map((t) => t.ms);
    const fromClick = all
      .filter((t) => t.ok && t.fromClickMs)
      .map((t) => t.fromClickMs);
    return [
      kind,
      {
        count: all.length,
        failed: all.length - ok.length,
        p50: percentile(ok, 0.5),
        p95: percentile(ok, 0.95),
        max: percentile(ok, 1),
        ...(fromClick.length
          ? {
              fromClickP50: percentile(fromClick, 0.5),
              fromClickP95: percentile(fromClick, 0.95),
            }
          : {}),
        firstHalfP50: percentile(
          all.filter((t) => t.ok && t.minute < minutes / 2).map((t) => t.ms),
          0.5,
        ),
        secondHalfP50: percentile(
          all.filter((t) => t.ok && t.minute >= minutes / 2).map((t) => t.ms),
          0.5,
        ),
      },
    ];
  }),
);
const storeKinds = [
  "sessionListMs",
  "sessionQueryMs",
  "orchestrationQueryMs",
  "historyPageMs",
];
const summary = {
  recordedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    totalMemGb: os.totalmem() / 2 ** 30,
    node: process.versions.node,
  },
  requestedMinutes: minutes,
  actualMinutes: Math.round(elapsedMinutes() * 100) / 100,
  aborted,
  cycles: cycle,
  work: {
    discussions,
    works,
    chats,
    chatRefusals,
    sessions: sessions.length,
    goalOutcomes,
  },
  failures,
  trends: {
    mainRssMb: trend((s) => s.main.rssMb),
    mainHeapUsedMb: trend((s) => s.main.heapUsedMb),
    rendererJsHeapUsedMb: trend(
      (s) =>
        (s.renderer.cdpJSHeapUsedSize ?? s.renderer.usedJSHeapSize) / 1048576,
    ),
    rendererDomNodes: trend((s) => s.renderer.domNodes),
    rendererCdpNodes: trend((s) => s.renderer.cdpNodes),
    rendererJsEventListeners: trend((s) => s.renderer.cdpJSEventListeners),
    electronProcesses: trend((s) => s.electron.processes),
    electronWorkingSetMb: trend((s) => s.electron.workingSetMb),
    serviceWorkingSetKb: trend((s) => s.electron.service?.workingSetKb),
    treeProcesses: trend((s) => s.tree.processes),
    treeRssMb: trend((s) => s.tree.rssMb),
    standIns: trend((s) => s.standIns.count),
    standInsMaxPerMinute: trend((s) => s.standIns.maxSinceLastSample),
    loadavg1: trend((s) => s.machine.loadavg[0]),
    otherElectronProcesses: trend((s) => s.machine.otherElectronProcesses),
  },
  store: Object.fromEntries(
    storeKinds.map((k) => {
      const v = samples
        .map((s) => s.store?.[k])
        .filter((x) => typeof x === "number");
      return [
        k,
        {
          p50: percentile(v, 0.5),
          p95: percentile(v, 0.95),
          max: percentile(v, 1),
          first: v[0] ?? null,
          last: v.at(-1) ?? null,
        },
      ];
    }),
  ),
  ui,
  afterRendererGc: collected
    ? {
        rendererJsHeapUsedMb:
          (collected.renderer.cdpJSHeapUsedSize ??
            collected.renderer.usedJSHeapSize) / 1048576,
        domNodes: collected.renderer.domNodes,
        cdpNodes: collected.renderer.cdpNodes,
      }
    : null,
  startSample: {
    label: first.label,
    rendererJsHeapUsedMb:
      (first.renderer.cdpJSHeapUsedSize ?? first.renderer.usedJSHeapSize) /
      1048576,
  },
  endSample: { label: last.label },
  profileKb: storeBytes,
  leftovers,
  limits: [
    "UI timings are wall-clock in the Playwright driver from the action to the visible result; they include locator polling and IPC to the driver.",
    "Store timings are window.topsl.command round trips measured inside the renderer (IPC + service), not UI rendering.",
    "Stand-in Codex only (tests/fixtures/codex-soak.cjs); no model or account was contacted.",
    "Other agents ran Electron concurrently on this machine; see machine.loadavg and otherElectronProcesses per sample.",
  ],
};
await writeFile(
  path.join(out, "soak-summary.json"),
  JSON.stringify(summary, null, 2),
);
const csvColumns = [
  ["label", (s) => s.label],
  ["minute", (s) => s.minute],
  ["main_rss_mb", (s) => s.main.rssMb.toFixed(1)],
  ["main_heap_used_mb", (s) => s.main.heapUsedMb.toFixed(1)],
  [
    "renderer_js_heap_mb",
    (s) =>
      (
        (s.renderer.cdpJSHeapUsedSize ?? s.renderer.usedJSHeapSize) / 1048576
      ).toFixed(1),
  ],
  ["renderer_dom_nodes", (s) => s.renderer.domNodes],
  ["renderer_cdp_nodes", (s) => s.renderer.cdpNodes],
  ["renderer_listeners", (s) => s.renderer.cdpJSEventListeners],
  ["electron_processes", (s) => s.electron.processes],
  ["electron_working_set_mb", (s) => s.electron.workingSetMb.toFixed(1)],
  [
    "service_working_set_mb",
    (s) => ((s.electron.service?.workingSetKb ?? 0) / 1024).toFixed(1),
  ],
  ["tree_processes", (s) => s.tree.processes],
  ["tree_rss_mb", (s) => s.tree.rssMb.toFixed(1)],
  ["stand_ins", (s) => s.standIns.count],
  ["stand_ins_max_5s_poll", (s) => s.standIns.maxSinceLastSample],
  ["stand_ins_seen_total", (s) => s.standIns.seenTotal],
  ["session_list_ms", (s) => s.store.sessionListMs],
  ["session_query_ms", (s) => s.store.sessionQueryMs],
  ["orchestration_query_ms", (s) => s.store.orchestrationQueryMs],
  ["history_page_ms", (s) => s.store.historyPageMs],
  ["loadavg1", (s) => s.machine.loadavg[0].toFixed(2)],
  ["other_electron_processes", (s) => s.machine.otherElectronProcesses],
  ["other_cpu_percent", (s) => s.machine.otherCpuPercent.toFixed(0)],
];
const allSamples = (await import("node:fs"))
  .readFileSync(samplesFile, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
await writeFile(
  path.join(out, "soak-samples.csv"),
  [
    csvColumns.map(([h]) => h).join(","),
    ...allSamples.map((s) => csvColumns.map(([, f]) => f(s)).join(",")),
  ].join("\n") + "\n",
);
await writeFile(
  path.join(out, "soak-timings.csv"),
  [
    "kind,minute,ms,ok,from_click_ms,error",
    ...timings.map((t) =>
      [
        t.kind,
        t.minute.toFixed(2),
        t.ms.toFixed(1),
        t.ok,
        t.fromClickMs?.toFixed(1) ?? "",
        JSON.stringify(t.error ?? ""),
      ].join(","),
    ),
  ].join("\n") + "\n",
);
if (!values.keep) setup.remove();
console.log(
  JSON.stringify(
    {
      summary: path.join(out, "soak-summary.json"),
      aborted,
      failures: failures.length,
      leftovers,
    },
    null,
    2,
  ),
);
if (aborted || leftTree.length || leftStandIns.length || leftSeen.length)
  process.exitCode = 1;
