// Campaign 2026-10-19 packet p4b-desktop-ui, updated 4 November 2026 for the
// session-first navigation (docs/UX_Cleanup_Plan.md §1–2): focused Electron
// journeys for desktop interaction contracts the existing desktop harnesses do
// not assert. Every launch uses its own isolated TOPSL_TEST_PROFILE; no
// provider, account, network or installer is contacted. Responses are delayed
// or turned into errors only at the main-process IPC boundary (a test wrapper
// around the registered `topsl:command` handler), so the renderer and service
// are the real ones. Fixture records are created through service commands;
// the behaviour under test is driven through the interface.
//
// Run: <cleanenv.sh> npm run test:desktop -- scripts/campaign-ui-test.mjs
// TOPSL_CAMPAIGN_UI_EVIDENCE names the evidence folder (default
// test-results/campaign-ui), so the dated October packet is never overwritten.
//
// A step whose assertion fails is recorded and the remaining steps still run;
// the process exits non-zero when any step failed. A confirmed product defect
// is wrapped in knownDefect(), which logs `CAMPAIGN DEFECT <id>` and does not
// fail the run, and fails the run if the defect stops reproducing. A step
// whose feature the cleanup removed stays as a `retired` record with the
// reason and, where there is one, the replacement this harness checks instead.
import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  stat,
  chmod,
} from "node:fs/promises";
import { randomBytes, scryptSync, createCipheriv } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { navigate, selectProject as selectProjectIn } from "./desktop-navigation.mjs";

// TOPSL_CAMPAIGN_UI_EVIDENCE writes a run elsewhere, so earlier evidence is kept.
const evidence = path.resolve(
  process.env.TOPSL_CAMPAIGN_UI_EVIDENCE ?? "test-results/campaign-ui",
);
await mkdir(evidence, { recursive: true });
const TEST_PASSPHRASE = "Topsl isolated test passphrase"; // apps/desktop/main.ts unlock()
const steps = [];
const measurements = {};
let failed = false;

class Defect extends Error {}
/** Run one step; a failure is recorded and the journey continues. */
async function step(name, cases, fn, page) {
  const started = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, cases, status: "passed", ms: Date.now() - started, detail: detail ?? null });
    console.log(`STEP PASS ${name} [${cases.join(", ")}]`);
  } catch (error) {
    failed = true;
    const message = String(error?.stack ?? error).slice(0, 3000);
    steps.push({ name, cases, status: "failed", ms: Date.now() - started, error: message });
    console.error(`STEP FAIL ${name} [${cases.join(", ")}]\n${message}`);
    if (page)
      await page
        .screenshot({ path: path.join(evidence, `fail-${name.replace(/\W+/g, "-")}.png`) })
        .catch(() => {});
    if (releaseAllHook) await releaseAllHook().catch(() => {});
  }
}
/** A confirmed product defect: log it and continue; flip if it stops reproducing. */
async function knownDefect(id, description, fn) {
  try {
    await fn();
  } catch (error) {
    const observed = String(error?.message ?? error).split("\n").slice(0, 6).join(" | ");
    console.log(`CAMPAIGN DEFECT ${id}: ${description} -- observed: ${observed}`);
    steps.push({ name: `defect ${id}`, cases: [id], status: "defect", description, observed });
    return;
  }
  throw new Defect(`CAMPAIGN DEFECT ${id} no longer reproduces: ${description}`);
}
/**
 * A step whose feature the session-first cleanup removed. It is kept as a
 * record, with the reason and the replacement checked instead, if any.
 */
function retired(name, cases, reason, replacement = null) {
  steps.push({ name, cases, status: "retired", reason, replacement });
  console.log(`STEP RETIRED ${name} [${cases.join(", ")}]: ${reason}`);
}

function launch(profile, extra = {}) {
  const env = { ...process.env, TOPSL_TEST_PROFILE: profile, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: [...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []), "."],
    env,
    timeout: 90000,
  });
}
/** Electron's own stdout/stderr, for the passphrase scan. */
function captureOutput(app) {
  const chunks = [];
  const child = app.process();
  child.stdout?.on("data", (bytes) => chunks.push(bytes.toString()));
  child.stderr?.on("data", (bytes) => chunks.push(bytes.toString()));
  return chunks;
}
/** Wrap the registered IPC handler: log every command and optionally hold or fail replies. */
async function installInterceptor(app) {
  const result = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    if (!handlers || typeof handlers.get !== "function") return "no invoke handler map";
    const original = handlers.get("topsl:command");
    if (!original) return "no topsl:command handler";
    const c = (globalThis.__campaign = { calls: [], rules: [], held: [] });
    handlers.set("topsl:command", async (event, raw) => {
      const entry = {
        seq: c.calls.length,
        type: raw?.type,
        projectId: raw?.projectId ?? null,
        projectView: raw?.projectView ?? null,
        query: raw?.query ?? null,
        title: raw?.title ?? null,
        at: Date.now(),
      };
      c.calls.push(entry);
      const rule = c.rules.find(
        (r) =>
          r.remaining > 0 &&
          (!r.types || r.types.includes(raw?.type)) &&
          (!r.projectId || r.projectId === raw?.projectId),
      );
      if (rule) rule.remaining--;
      if (rule?.failWith) {
        entry.failedBy = rule.name;
        return { error: rule.failWith };
      }
      const reply = await original(event, raw);
      if (!rule) return reply;
      entry.heldBy = rule.name;
      return new Promise((resolve) =>
        c.held.push({
          ...entry,
          rule: rule.name,
          release: (error) => resolve(error ? { error } : reply),
        }),
      );
    });
    return "installed";
  });
  if (result !== "installed") throw new Error(`IPC interceptor unavailable: ${result}`);
}
const hold = (app, rule) =>
  app.evaluate((_, rule) => {
    globalThis.__campaign.rules.push({ remaining: 1, ...rule });
  }, rule);
const release = (app, name, error = null) =>
  app.evaluate(
    (_, { name, error }) => {
      const c = globalThis.__campaign;
      const items = c.held.filter((h) => h.rule === name);
      c.held = c.held.filter((h) => h.rule !== name);
      c.rules = c.rules.filter((r) => r.name !== name);
      for (const item of items) item.release(error);
      return items.length;
    },
    { name, error },
  );
const clearRule = (app, name) =>
  app.evaluate((_, name) => {
    const c = globalThis.__campaign;
    c.rules = c.rules.filter((r) => r.name !== name);
  }, name);
/** After a failed step: release every held reply and drop every rule. */
let releaseAllHook = null;
const releaseAll = (app) =>
  app.evaluate(() => {
    const c = globalThis.__campaign;
    if (!c) return 0;
    const items = c.held;
    c.held = [];
    c.rules = [];
    for (const item of items) item.release(null);
    return items.length;
  });
const heldCount = (app, name) =>
  app.evaluate((_, name) => globalThis.__campaign.held.filter((h) => h.rule === name).length, name);
const calls = (app, since = 0) =>
  app.evaluate((_, since) => globalThis.__campaign.calls.slice(since).map(({ ...c }) => c), since);
const callCount = (app) => app.evaluate(() => globalThis.__campaign.calls.length);
const frames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const settle = async (page, ms = 400) => {
  await frames(page);
  await page.waitForTimeout(ms);
  await frames(page);
};
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const command = (page, value) => page.evaluate((value) => window.topsl.command(value), value);
async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
async function filesContaining(directory, needle) {
  const hits = [];
  for (const file of await filesUnder(directory))
    if ((await readFile(file)).includes(Buffer.from(needle))) hits.push(path.relative(directory, file));
  return hits;
}
const exists = (file) => stat(file).then(() => true, () => false);

// ---------------------------------------------------------------------------
// Part A. Vault routes at first launch (UI-01, UI-02). In a test profile the
// main process always supplies its fixed isolated passphrase, so these cover
// the passphrase route only; the OS-store route and owner-typed passphrases
// are not reachable from a test profile.
// ---------------------------------------------------------------------------
function passphraseVault(passphrase) {
  const salt = randomBytes(32),
    iv = randomBytes(12),
    key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(randomBytes(32).toString("hex"), "utf8"), cipher.final()]);
  return JSON.stringify({
    method: "passphrase",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("base64"),
  });
}
/** Launch against a prepared profile and assert it stays locked without replacing anything. */
async function lockedLaunch(name, prepare, expectedReason, typed) {
  const profile = await mkdtemp(path.join(os.tmpdir(), `topsl-test-campaign-${name}-`));
  const before = await prepare(profile);
  const app = await launch(profile);
  const output = captureOutput(app);
  let page;
  try {
    page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1, name: "Your work stays local." })).toBeVisible({ timeout: 45000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("main.lock-screen")).toContainText(expectedReason);
    const state = await command(page, { type: "state" });
    expect(state.locked).toBe(true);
    // Nothing else runs while locked.
    const refused = await page.evaluate(() =>
      window.topsl.command({ type: "theme", theme: "night" }).then(() => "accepted", (e) => e.message),
    );
    expect(refused).not.toBe("accepted");
    await expect(page.locator(".app-shell")).toHaveCount(0);
    const input = page.getByLabel("Vault passphrase");
    expect(await input.getAttribute("type")).toBe("password");
    if (typed) {
      await input.fill(typed);
      await page.getByRole("button", { name: "Unlock / create vault" }).click();
      await settle(page, 1500);
      await expect(page.locator("main.lock-screen")).toContainText(expectedReason);
      expect((await command(page, { type: "state" })).locked).toBe(true);
      expect(JSON.stringify(await command(page, { type: "state" }))).not.toContain(typed);
    }
    await page.screenshot({ path: path.join(evidence, `vault-${name}.png`) });
  } finally {
    await app.close();
  }
  // Authoritative boundary: the profile's bytes after the app closed.
  for (const [file, bytes] of Object.entries(before)) {
    const now = await readFile(path.join(profile, file)).catch(() => null);
    expect(now?.equals(bytes), `${file} must be preserved byte for byte`).toBe(true);
  }
  if (!before["vault.json"]) expect(await exists(path.join(profile, "vault.json"))).toBe(false);
  if (!before["history.sqlite"]) expect(await exists(path.join(profile, "history.sqlite"))).toBe(false);
  const leaked =
    output.join("").includes(TEST_PASSPHRASE) || (!!typed && output.join("").includes(typed));
  expect(leaked, "passphrase in Electron output").toBe(false);
  if (typed) expect(await filesContaining(profile, typed)).toEqual([]);
  return { profile, files: Object.keys(before) };
}

await step("UI-01 first launch creates a passphrase vault and opens", ["UI-01", "UI-02"], async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-campaign-first-"));
  const app = await launch(profile);
  const output = captureOutput(app);
  let state;
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible({ timeout: 45000 });
    state = await command(page, { type: "state" });
    expect(state.locked).toBe(false);
    expect(JSON.stringify(state)).not.toContain(TEST_PASSPHRASE);
  } finally {
    await app.close();
  }
  const vault = JSON.parse(await readFile(path.join(profile, "vault.json"), "utf8"));
  expect(vault.method).toBe("passphrase");
  expect(Object.keys(vault).sort()).toEqual(["data", "iv", "method", "salt", "tag"]);
  expect((await stat(path.join(profile, "vault.json"))).mode & 0o777).toBe(0o600);
  expect((await readdir(profile)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  expect(output.join("").includes(TEST_PASSPHRASE)).toBe(false);
  expect(await filesContaining(profile, TEST_PASSPHRASE)).toEqual([]);
  const backups = (await readdir(profile)).filter((f) => /\.backup-/.test(f));
  // A database created at this launch held nothing a migration could lose.
  await knownDefect(
    "W1-3",
    "a first launch writes schema migration backups of the brand-new, empty history database",
    async () => expect(backups).toEqual([]),
  );
  return { vaultMethod: vault.method, files: (await readdir(profile)).sort() };
});
await step("UI-02 wrong passphrase vault stays locked and preserved", ["UI-02"], async () => {
  return lockedLaunch(
    "wrong",
    async (profile) => {
      const bytes = Buffer.from(passphraseVault("a different owner passphrase 密码"));
      await writeFile(path.join(profile, "vault.json"), bytes, { mode: 0o600 });
      return { "vault.json": bytes };
    },
    "Vault passphrase is incorrect.",
    "owner typed secret 0x7f — 口令",
  );
});
await step("UI-02 unknown vault format stays locked and preserved", ["UI-02"], async () =>
  lockedLaunch(
    "unknown",
    async (profile) => {
      const bytes = Buffer.from(JSON.stringify({ method: "hardware-key", data: "opaque" }));
      await writeFile(path.join(profile, "vault.json"), bytes, { mode: 0o600 });
      return { "vault.json": bytes };
    },
    "Unknown vault format",
  ),
);
await step("UI-02 missing key with existing database stays locked", ["UI-02"], async () =>
  lockedLaunch(
    "missing-key",
    async (profile) => {
      const bytes = randomBytes(4096);
      await writeFile(path.join(profile, "history.sqlite"), bytes);
      return { "history.sqlite": bytes };
    },
    "vault key is missing",
  ),
);
await step("UI-01 half-written (empty) vault file is not accepted", ["UI-01"], async () =>
  lockedLaunch(
    "empty-vault",
    async (profile) => {
      const bytes = Buffer.alloc(0);
      await writeFile(path.join(profile, "vault.json"), bytes, { mode: 0o600 });
      return { "vault.json": bytes };
    },
    "JSON",
  ),
);

// ---------------------------------------------------------------------------
// Part B. One isolated profile for the interaction journeys.
// ---------------------------------------------------------------------------
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-campaign-ui-"));
const longParent = path.join(
  profile,
  "a deliberately long parent folder name so the path wraps",
  "第二层 nested folder with spaces",
);
await mkdir(longParent, { recursive: true });
const folderA = path.join(longParent, "项目 🚀 Alpha");
const folderB = path.join(profile, "Beta harbor");
await mkdir(folderA);
await mkdir(folderB);
const nameA = "项目 🚀 Alpha";
const nameB = "Beta harbor";
const app = await launch(profile);
const output = captureOutput(app);
const errors = [];
const page = await app.firstWindow();
page.on("pageerror", (error) => errors.push(error.message));
await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible({ timeout: 45000 });
await installInterceptor(app);
releaseAllHook = async () => {
  await releaseAll(app);
  await page.keyboard.press("Escape").catch(() => {});
  await page.setViewportSize({ width: 1280, height: 880 }).catch(() => {});
  await app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    .catch(() => {});
};
await app.evaluate(({ dialog }) => {
  globalThis.campaignPick = null;
  globalThis.campaignConfirmations = [];
  globalThis.campaignCancelNextOpen = false;
  globalThis.campaignNextResponses = [];
  dialog.showOpenDialog = async () => {
    if (globalThis.campaignCancelNextOpen) {
      globalThis.campaignCancelNextOpen = false;
      return { canceled: true, filePaths: [] };
    }
    return { canceled: false, filePaths: [globalThis.campaignPick] };
  };
  // The affirmative button unless a step queued another answer (0 = Cancel).
  dialog.showMessageBox = async (...args) => {
    const response = globalThis.campaignNextResponses.length ? globalThis.campaignNextResponses.shift() : 1;
    globalThis.campaignConfirmations.push({ message: args.at(-1)?.message, response });
    return { response, checkboxChecked: false };
  };
});
await page.setViewportSize({ width: 1280, height: 880 });
const mod = process.platform === "darwin" ? "Meta" : "Control";
// Today's project destinations (docs/UX_Cleanup_Plan.md §1): New session in
// the sidebar, the rest in the selected project's menu. `view` is the value
// navigation-save records.
const projectDestinations = [
  { nav: "New session", view: "coordinator" },
  { nav: "All sessions", view: "all-sessions" },
  { nav: "Project settings", view: "project-settings" },
  { nav: "Provider tools", view: "sessions" },
  { nav: "Advanced workflows", view: "advanced" },
];
const projectNames = projectDestinations.map((d) => d.nav);
const globalPages = [
  { nav: "Projects", h1: "Projects", crumb: "Topsl / Projects" },
  { nav: "Providers", h1: "Providers", crumb: "Topsl / Providers" },
  { nav: "Settings", h1: "Settings", crumb: "Topsl / Settings" },
];
const allDestinations = [...projectNames, ...globalPages.map((g) => g.nav)];
const advancedSections = ["Builder–reviewer", "Candidate review", "Activity", "Context", "Workspaces"];
const crumb = page.locator("header.topbar > span").first();
const sectionTab = (name) =>
  page.getByRole("tablist", { name: "Section" }).getByRole("tab", { name, exact: true });
/** Advanced workflows at one of its sections, through the project menu and the Section tabs. */
async function openSection(name) {
  await navigate(page, "Advanced workflows");
  await sectionTab(name).click();
  await expect(sectionTab(name)).toHaveAttribute("aria-selected", "true");
}
const paletteDialog = page.getByRole("dialog", { name: "Command palette" });
const focusInfo = () =>
  page.evaluate(() => {
    const active = document.activeElement;
    const dialog = document.querySelector("dialog[open]");
    return {
      tag: active?.tagName ?? null,
      text: (active?.getAttribute("aria-label") || active?.textContent || "").trim().slice(0, 60),
      inDialog: !!(dialog && active && dialog.contains(active)),
      body: active === document.body || active === null,
      openDialogs: document.querySelectorAll("dialog[open]").length,
    };
  });
async function checkDestination({ nav, h1, crumb: expectedCrumb }, projectView, projectId) {
  await navigate(page, nav);
  const headings = page.getByRole("heading", { level: 1 });
  await expect(headings).toHaveCount(1);
  await expect(headings).toHaveText(h1);
  await expect(page.locator("h1:visible")).toHaveCount(1);
  const current = page.locator('[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText(nav);
  await expect(crumb).toHaveText(expectedCrumb);
  if (projectView) {
    // The durable navigation record names this destination and project (the
    // newest save; an unchanged view issues no new save).
    await expect
      .poll(async () => {
        const saves = (await calls(app)).filter((c) => c.type === "navigation-save");
        const last = saves.at(-1);
        return last && `${last.projectView}:${last.projectId}`;
      })
      .toBe(`${projectView}:${projectId}`);
  }
}
const projectMenuButtons = page.locator("aside.sidebar .project-menu-button");

await step("UI-03 empty profile: global destinations; no project menu and no new session", ["UI-03"], async () => {
  for (const destination of globalPages) await checkDestination(destination);
  await expect(projectMenuButtons).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New session", exact: true })).toBeDisabled();
  await expect(page.getByRole("list", { name: "Projects and sessions" }).getByRole("listitem")).toHaveCount(0);
  await expect(page.locator("aside.sidebar")).toContainText("Add a folder to begin.");
}, page);
retired(
  "UI-03 Project navigation list",
  ["UI-03"],
  "The expanded Project tools list (navigation \"Project navigation\") was replaced by a per-project menu (docs/UX_Cleanup_Plan.md §1).",
  "The empty-profile step asserts no project menu exists; the populated step opens every menu destination.",
);

await step("UI-05 command palette: unavailable actions stay unavailable (empty profile)", ["UI-05"], async () => {
  await navigate(page, "Projects");
  await page.keyboard.press(`${mod}+k`);
  await expect(paletteDialog).toBeVisible();
  for (const name of projectNames)
    await expect(paletteDialog.getByRole("button", { name: `${name} →`, exact: true })).toBeDisabled();
  // Discovery never runs in a test profile.
  const discover = paletteDialog.getByRole("button", { name: "Discover providers →", exact: true });
  await expect(discover).toBeDisabled();
  await expect(paletteDialog.getByRole("button", { name: "Discover applications →" })).toHaveCount(0);
  const before = await callCount(app);
  // A synthetic click on a disabled control must not navigate or dispatch.
  await paletteDialog.evaluate((dialog) => {
    for (const button of dialog.querySelectorAll("button[disabled]")) button.click();
  });
  await settle(page);
  expect((await calls(app, before)).map((c) => c.type).filter((t) => t !== "state")).toEqual([]);
  await expect(paletteDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(paletteDialog).toHaveCount(0);
}, page);
retired(
  "UI-05 Discover applications palette action",
  ["UI-05"],
  "Applications became Providers and desktop-application discovery was removed (docs/UX_Cleanup_Plan.md §2).",
  "The palette's Discover providers action, disabled in a test profile, is asserted instead.",
);

// Projects A (Unicode, emoji, long path) and B, added through the screen.
let idA, idB;
await step("setup: add two projects and Beta-only records", ["UI-03", "UI-09"], async () => {
  for (const folder of [folderA, folderB]) {
    await app.evaluate((_, folder) => (globalThis.campaignPick = folder), folder);
    await navigate(page, "Projects");
    await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
    // A new project opens at its New session page.
    await expect(crumb).toHaveText(`${path.basename(folder)} / New session`);
    await expect(page.getByRole("heading", { level: 1, name: "New session" })).toBeVisible();
  }
  const state = await command(page, { type: "state" });
  idA = state.projects.find((p) => p.name === nameA)?.id;
  idB = state.projects.find((p) => p.name === nameB)?.id;
  expect(idA && idB).toBeTruthy();
  const coordination = await command(page, { type: "coordination-query", projectId: idB });
  const workflow = await command(page, {
    type: "workflow-create",
    requestId: crypto.randomUUID(),
    projectId: idB,
    objective: "Beta-only workflow",
    template: "desktop-fixture",
    templateVersion: "1",
  });
  await command(page, {
    type: "task-create",
    requestId: crypto.randomUUID(),
    projectId: idB,
    workspaceId: coordination.workspaces[0].id,
    workflowId: workflow.id,
    title: "Beta-only task 乙",
    role: "planner",
    acceptanceCriteria: ["Only Beta shows this"],
  });
  await command(page, { type: "conversation-add", projectId: idB, title: "Beta-only conversation" });
  await selectProjectIn(page, nameA);
  await expect(crumb).toHaveText(`${nameA} / New session`);
  return { idA, idB };
}, page);

await step("UI-03 populated: every destination, one h1, marker, scope and saved view", ["UI-03"], async () => {
  for (const { nav, view } of projectDestinations)
    await checkDestination({ nav, h1: nav, crumb: `${nameA} / ${nav}` }, view, idA);
  for (const destination of globalPages) await checkDestination(destination);
  expect((await command(page, { type: "navigation-query" })).projectId).toBe(idA);
  // Every Advanced workflows section, under one page heading.
  for (const name of advancedSections) {
    await openSection(name);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Advanced workflows");
    await expect(crumb).toHaveText(`${nameA} / Advanced workflows`);
  }
  // The project menu lists exactly its four destinations and closes on Escape.
  const trigger = page.getByRole("button", { name: `Project menu for ${nameA}`, exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: `${nameA} menu` });
  await expect(menu.getByRole("menuitem")).toHaveText(["All sessions", "Project settings", "Provider tools", "Advanced workflows"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
}, page);

await step("UI-03 retired destination names reach their replacements", ["UI-03"], async () => {
  // desktop-navigation.mjs maps names the October campaign used to where the
  // cleanup moved them; each must open a real destination and section.
  const expected = {
    Overview: { h1: "Advanced workflows", tab: "Activity" },
    Tasks: { h1: "Advanced workflows", tab: "Builder–reviewer" },
    Changes: { h1: "Advanced workflows", tab: "Candidate review" },
    Context: { h1: "Advanced workflows", tab: "Context" },
    Workspaces: { h1: "Advanced workflows", tab: "Workspaces" },
    History: { h1: "Provider tools" },
    Applications: { h1: "Providers" },
  };
  for (const [name, target] of Object.entries(expected)) {
    await navigate(page, name);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(target.h1);
    if (target.tab) await expect(sectionTab(target.tab)).toHaveAttribute("aria-selected", "true");
  }
  await navigate(page, "History");
  await expect(page.getByRole("heading", { level: 2, name: "Provider history" })).toBeVisible();
}, page);

await step("UI-03 saved legacy destinations restore to their replacements after a reload", ["UI-03"], async () => {
  // Saved navigation from before the cleanup (written through the service, as
  // an upgraded profile holds it) opens where the cleanup moved it.
  const cases = [
    ["overview", "Advanced workflows", "Activity"],
    ["tasks", "Advanced workflows", "Builder–reviewer"],
    ["changes", "Advanced workflows", "Candidate review"],
    ["context", "Advanced workflows", "Context"],
    ["history", "Provider tools", null],
    ["synchronization", "Project settings", null],
  ];
  const restored = {};
  for (const [legacy, h1, tab] of cases) {
    await command(page, { type: "navigation-save", projectId: idA, workflowId: null, projectView: legacy, threadId: null });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1, { timeout: 30000 });
    await expect(crumb).toHaveText(`${nameA} / ${h1}`);
    if (tab) await expect(sectionTab(tab)).toHaveAttribute("aria-selected", "true");
    if (legacy === "synchronization")
      await expect(
        page.getByRole("note").filter({ hasText: "Native project synchronization is retired." }),
      ).toHaveCount(1);
    restored[legacy] = tab ? `${h1} / ${tab}` : h1;
  }
  await page.screenshot({ path: path.join(evidence, "legacy-synchronization-restored.png") });
  return restored;
}, page);
retired(
  "UI-03 Overview and Synchronization destinations",
  ["UI-03"],
  "Overview became Advanced workflows → Activity; native project synchronization was removed (docs/UX_Cleanup_Plan.md §1–2, §4).",
  "The two steps above check that their names and saved values open the replacements, and Synchronization shows its retirement notice.",
);

await step("UI-05 command palette by mouse: focus enters, stays, returns", ["UI-05"], async () => {
  await navigate(page, "Providers");
  const opener = page.getByRole("button", { name: /^Command palette/ });
  await opener.click();
  await expect(paletteDialog).toBeVisible();
  await expect.poll(async () => (await focusInfo()).inDialog).toBe(true);
  const enabled = await paletteDialog.locator("button:not([disabled])").count();
  const visited = [];
  for (let index = 0; index < enabled * 2 + 3; index++) {
    await page.keyboard.press("Tab");
    visited.push(await focusInfo());
  }
  for (let index = 0; index < enabled + 2; index++) {
    await page.keyboard.press("Shift+Tab");
    visited.push(await focusInfo());
  }
  const escaped = visited.filter((f) => !f.inDialog && !f.body);
  expect(escaped, "focus reached a control outside the modal palette").toEqual([]);
  expect(visited.every((f) => f.openDialogs === 1)).toBe(true);
  // The page behind is inert: a click on the sidebar does not navigate.
  const box = await page.getByRole("navigation", { name: "Application navigation" }).boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
  await settle(page, 200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Providers");
  await page.keyboard.press("Escape");
  await expect(paletteDialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // Control: with no modal open, the same probe does see focus outside any dialog.
  await page.keyboard.press("Tab");
  const outside = await focusInfo();
  expect(outside.openDialogs).toBe(0);
  expect(outside.inDialog || outside.body).toBe(false);
  return { enabledButtons: enabled, tabSamples: visited.length, bodyFocusSamples: visited.filter((f) => f.body).length };
}, page);

await step("UI-05 command palette by keyboard: Cmd/Ctrl+K toggles, repeated opens, focus return", ["UI-05"], async () => {
  const origin = page.getByRole("button", { name: "Settings", exact: true });
  for (let round = 0; round < 5; round++) {
    await origin.focus();
    await page.keyboard.press(`${mod}+k`);
    await expect(paletteDialog).toBeVisible();
    expect((await focusInfo()).openDialogs).toBe(1);
    await expect.poll(async () => (await focusInfo()).inDialog).toBe(true);
    if (round % 2) await page.keyboard.press(`${mod}+k`);
    else await page.keyboard.press("Escape");
    await expect(paletteDialog).toHaveCount(0);
    await expect(origin).toBeFocused();
  }
  // With a project selected, project destinations are available and work.
  await page.keyboard.press(`${mod}+k`);
  for (const name of projectNames)
    await expect(paletteDialog.getByRole("button", { name: `${name} →`, exact: true })).toBeEnabled();
  await paletteDialog.getByRole("button", { name: "Provider tools →", exact: true }).click();
  await expect(paletteDialog).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Provider tools");
  await expect(crumb).toHaveText(`${nameA} / Provider tools`);
}, page);

await step("UI-04 899/900 px boundary: drawer vs sidebar, all destinations without overflow", ["UI-04"], async () => {
  const report = {};
  for (const width of [900, 899]) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page, 100);
    if (width >= 900) {
      await expect(page.locator("aside.sidebar")).toBeVisible();
      await expect(page.locator("dialog.sidebar")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Navigation", exact: true })).toBeHidden();
    } else {
      await expect(page.locator("aside.sidebar")).toHaveCount(0);
      await expect(page.locator("dialog.sidebar")).not.toHaveAttribute("open", "");
      await expect(page.getByRole("button", { name: "Navigation", exact: true })).toBeVisible();
    }
    for (const nav of allDestinations) {
      await navigate(page, nav);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(nav);
      if (width < 900) await expect(page.locator("dialog.sidebar[open]")).toHaveCount(0);
      const excess = await overflow(page);
      report[`${width}:${nav}`] = excess;
      expect(excess, `${width}px ${nav} horizontal overflow`).toBeLessThanOrEqual(0);
    }
  }
  // The drawer is modal, keeps focus, closes on Escape and returns focus.
  const toggle = page.getByRole("button", { name: "Navigation", exact: true });
  await toggle.click();
  const drawer = page.getByRole("dialog", { name: "Workbench navigation" });
  await expect(drawer).toBeVisible();
  await expect.poll(async () => (await focusInfo()).inDialog).toBe(true);
  for (let index = 0; index < 25; index++) {
    await page.keyboard.press("Tab");
    const f = await focusInfo();
    expect(f.inDialog || f.body, `drawer focus escaped to ${f.tag} ${f.text}`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(toggle).toBeFocused();
  // 560 x 720: nothing trapped in the drawer; the last control scrolls into view.
  await page.setViewportSize({ width: 560, height: 720 });
  await toggle.click();
  await expect(drawer).toBeVisible();
  const last = drawer.getByRole("button", { name: /^Command palette/ });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  report["560x720 drawer overflow"] = await overflow(page);
  expect(report["560x720 drawer overflow"]).toBeLessThanOrEqual(0);
  await page.screenshot({ path: path.join(evidence, "drawer-560x720.png") });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 880 });
  measurements.boundaryOverflowPx = report;
}, page);

await step("UI-04 150% and 200% zoom: every destination without horizontal overflow", ["UI-04"], async () => {
  const report = {};
  for (const factor of [1.5, 2]) {
    await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor), factor);
    await settle(page, 200);
    for (const nav of allDestinations) {
      await navigate(page, nav);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(nav);
      const excess = await overflow(page);
      report[`${factor}:${nav}`] = { excess, innerWidth: await page.evaluate(() => innerWidth) };
      expect(excess, `${factor * 100}% ${nav} horizontal overflow`).toBeLessThanOrEqual(0);
    }
    await page.screenshot({ path: path.join(evidence, `zoom-${factor * 100}-settings.png`) });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await settle(page, 200);
  measurements.zoomOverflow = report;
}, page);

await step("UI-04 terminal and unsaved workflow draft stay mounted across resizes and the drawer", ["UI-04"], async () => {
  if (process.platform === "win32") return "skipped: shell stand-in";
  await page.setViewportSize({ width: 1280, height: 880 });
  const runtime = path.join(profile, "codex-campaign");
  await writeFile(
    runtime,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; exit 0; fi\nprintf "Campaign terminal ready\\n"\nexec cat\n',
  );
  await chmod(runtime, 0o700);
  await app.evaluate((_, runtime) => (globalThis.campaignPick = runtime), runtime);
  // Fixture setup: register and trust the shell stand-in as Codex CLI.
  const installed = await command(page, { type: "select-runtime" });
  await expect
    .poll(async () => (await command(page, { type: "state" })).installations.some((i) => i.id === installed.id))
    .toBe(true);
  await command(page, { type: "trust-installation", id: installed.id });
  await openSection("Builder–reviewer");
  const setup = page.locator(".guided-workflow");
  await setup.locator("summary").first().click();
  const objective = setup.getByRole("textbox", { name: "Objective", exact: true });
  await objective.fill("Unsaved draft 草稿 survives resizing");
  await navigate(page, "Provider tools");
  await page.getByRole("combobox", { name: "Runtime", exact: true }).selectOption(installed.id);
  await page.getByRole("button", { name: "Native terminal", exact: true }).click();
  const terminal = page.locator(".terminal-panel");
  await expect(terminal).toBeVisible();
  await expect(terminal).toContainText("Campaign terminal ready");
  const id = await terminal.getAttribute("data-session-id");
  const xterm = await terminal.locator(".xterm").elementHandle();
  for (const [width, height] of [[899, 800], [560, 720]]) {
    await page.setViewportSize({ width, height });
    await settle(page, 150);
    await page.getByRole("button", { name: "Navigation", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Workbench navigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await navigate(page, "Advanced workflows");
    await navigate(page, "Provider tools");
    expect(await terminal.getAttribute("data-session-id")).toBe(id);
    expect(await xterm.evaluate((node) => node.isConnected)).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 880 });
  await settle(page, 150);
  expect(await terminal.getAttribute("data-session-id")).toBe(id);
  expect(await xterm.evaluate((node) => node.isConnected)).toBe(true);
  await openSection("Builder–reviewer");
  await expect(objective).toHaveValue("Unsaved draft 草稿 survives resizing");
  await objective.fill("");
  await navigate(page, "Provider tools");
  await terminal.getByRole("button", { name: "Close session", exact: true }).click();
  await expect(terminal).toHaveCount(0);
  // The closed terminal is no longer offered as an active one.
  await expect
    .poll(async () => (await command(page, { type: "state" })).terminals.filter((t) => t.id === id).length, { timeout: 10000 })
    .toBe(0);
  await expect(page.getByRole("button", { name: /^Show active native terminal/ })).toHaveCount(0, { timeout: 10000 });
  return { terminal: id };
}, page);

await step("UI-08 Unicode/emoji long path is shown, legible and copied exactly", ["UI-08", "UI-12"], async () => {
  const state = await command(page, { type: "state" });
  const project = state.projects.find((p) => p.id === idA);
  expect(await realpath(project.path)).toBe(await realpath(folderA));
  // The project's folder is in Project settings (Overview's heading is retired).
  await navigate(page, "Project settings");
  const folderPath = page.getByRole("region", { name: "Folder", exact: true }).locator("code.path");
  await expect(folderPath).toHaveText(project.path);
  await expect(page.locator(".project-node.selected .project-name")).toHaveText(nameA);
  await navigate(page, "Projects");
  const card = page.getByRole("article", { name: nameA, exact: true });
  await expect(card.locator("code.path")).toHaveText(project.path);
  await app.evaluate(({ clipboard }) => clipboard.writeText("sentinel"));
  await card.getByRole("button", { name: "Copy path", exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(project.path);
  await page.setViewportSize({ width: 560, height: 720 });
  await navigate(page, "Project settings");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const pathBox = await folderPath.evaluate((e) => ({
    scrollWidth: e.scrollWidth,
    clientWidth: e.clientWidth,
  }));
  expect(pathBox.scrollWidth, "path text is clipped rather than wrapped").toBeLessThanOrEqual(pathBox.clientWidth + 1);
  await page.screenshot({ path: path.join(evidence, "unicode-long-path-compact.png") });
  await page.setViewportSize({ width: 1280, height: 880 });
  return { path: project.path, length: project.path.length };
}, page);
retired(
  "UI-08 project path in the Overview heading",
  ["UI-08"],
  "Overview and its path heading were retired; the folder path is shown in Project settings → Folder and on the Projects card (docs/UX_Cleanup_Plan.md §1).",
  "The step above checks both, and the Projects card's Copy path.",
);

/** Compose with the platform IME event stream, with Enter delivered as an IME key (229). */
async function imeCompose(cdp, partial, committed) {
  await cdp.send("Input.imeSetComposition", { text: partial, selectionStart: partial.length, selectionEnd: partial.length });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    key: "Enter",
    code: "Enter",
  });
  await cdp.send("Input.insertText", { text: committed });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
  });
}
await step("UI-08 IME composition Enter does not submit search or publish context", ["UI-08"], async () => {
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  // Provider history search (a read), now in Provider tools -----------------
  await navigate(page, "Provider tools");
  const search = page.getByRole("textbox", { name: "Search project history" });
  await search.fill("");
  await search.focus();
  await search.evaluate((input) => {
    window.__ime = [];
    for (const type of ["compositionstart", "compositionupdate", "compositionend", "keydown"])
      input.addEventListener(type, (e) => window.__ime.push(`${type}:${e.isComposing ?? ""}:${e.keyCode ?? ""}`));
  });
  let before = await callCount(app);
  await imeCompose(cdp, "zhong", "中文");
  await settle(page, 600);
  events.push(...(await page.evaluate(() => window.__ime)));
  await expect(search).toHaveValue("中文");
  expect((await calls(app, before)).filter((c) => c.type === "history-page" && c.query === "中文")).toEqual([]);
  // Negative control: an ordinary Enter after composition does submit.
  before = await callCount(app);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await calls(app, before)).filter((c) => c.type === "history-page" && c.query === "中文").length)
    .toBe(1);
  // Shared context Title (an immutable publication), now Advanced workflows → Context
  await openSection("Context");
  const form = page
    .locator("form.workflow-form")
    .filter({ has: page.getByRole("button", { name: "Publish captured context" }) });
  await form.getByRole("textbox", { name: "Exact context" }).fill("第一行 line one\nsecond line 🚀\n\tindented");
  const title = form.getByRole("textbox", { name: "Title" });
  await title.fill("");
  await title.focus();
  before = await callCount(app);
  await imeCompose(cdp, "jue", "决定 🚀");
  await settle(page, 600);
  await expect(title).toHaveValue("决定 🚀");
  expect((await calls(app, before)).filter((c) => c.type === "shared-revision-publish")).toEqual([]);
  before = await callCount(app);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await calls(app, before)).filter((c) => c.type === "shared-revision-publish").length)
    .toBe(1);
  await expect(page.locator(".workflow-card h3", { hasText: "决定 🚀" })).toHaveCount(1);
  await cdp.detach();
  return { imeEvents: events };
}, page);

await step("UI-08 multiline paste and shortcuts preserve the composer text", ["UI-08"], async () => {
  await navigate(page, "Provider tools");
  const message = page.getByRole("textbox", { name: "Message" });
  const text = "第一行 first line\n  second line with emoji 🚀\n\tthird line · /路径/with spaces";
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), text);
  await message.fill("");
  await message.focus();
  await page.keyboard.press(`${mod}+v`);
  await expect(message).toHaveValue(text);
  await page.keyboard.press(`${mod}+k`);
  await expect(paletteDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(paletteDialog).toHaveCount(0);
  await expect(message).toBeFocused();
  await expect(message).toHaveValue(text);
  await openSection("Context");
  await navigate(page, "Provider tools");
  await expect(message).toHaveValue(text);
  await message.fill("");
}, page);

// The task and workflow counts Overview's Responsibility line showed are now
// the summary line of Advanced workflows → Activity.
const tasksLine = page.locator(".advanced-workflows p.muted").filter({ hasText: /\d+ tasks · \d+ workflows/ });
/** The Activity summary the service's own snapshot implies for a project. */
async function responsibility(id) {
  const snapshot = await command(page, { type: "scope-snapshot", projectId: id });
  return `${snapshot.coordination.tasks.length} tasks · ${snapshot.coordination.workflows.length} workflows`;
}
async function showsProject(name, line) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Advanced workflows");
  await expect(crumb).toHaveText(`${name} / Advanced workflows`);
  await expect(page.locator(".project-node.selected .project-name")).toHaveText(name);
  await expect(tasksLine).toContainText(line);
}
/** Selects a project in the sidebar, then its Advanced workflows → Activity. */
const selectProject = async (id) => {
  await selectProjectIn(page, id === idA ? nameA : nameB);
  await openSection("Activity");
};
// Permanent "Ready" was removed: an idle workbench shows no status bar.
const idleStatus = async () => expect(page.locator("footer.statusbar")).toHaveCount(0);

await step("UI-09 late Beta replies after A->B->A cannot replace Alpha", ["UI-09"], async () => {
  const lineA = await responsibility(idA),
    lineB = await responsibility(idB);
  expect(lineA).not.toBe(lineB);
  await selectProject(idA);
  await showsProject(nameA, lineA);
  await hold(app, { name: "beta-late", projectId: idB, remaining: 1000 });
  await selectProject(idB);
  await expect.poll(() => heldCount(app, "beta-late")).toBeGreaterThan(0);
  await selectProject(idA);
  await showsProject(nameA, lineA);
  const released = await release(app, "beta-late");
  await settle(page, 800);
  await showsProject(nameA, lineA);
  await expect(page.getByText("Beta-only task 乙")).toHaveCount(0);
  expect((await command(page, { type: "navigation-query" })).projectId).toBe(idA);
  await navigate(page, "Provider tools");
  await expect(page.getByRole("combobox", { name: "Conversation" }).locator("option", { hasText: "Beta-only conversation" })).toHaveCount(0);
  await idleStatus();
  return { releasedBetaReplies: released, lineA, lineB };
}, page);

await step("UI-09 control: a held reply still in scope is delivered and shown", ["UI-09"], async () => {
  // Shows the hold/release path delivers data the view does apply, so the
  // A->B->A assertions above are not vacuous.
  const lineA = await responsibility(idA),
    lineB = await responsibility(idB);
  await selectProject(idA);
  await showsProject(nameA, lineA);
  await hold(app, { name: "beta-in-scope", projectId: idB, types: ["scope-snapshot"], remaining: 1 });
  await selectProject(idB);
  await expect.poll(() => heldCount(app, "beta-in-scope")).toBe(1);
  await expect(page.getByText("Loading project activity…")).toBeVisible();
  await expect(tasksLine).toHaveCount(0);
  await release(app, "beta-in-scope");
  await showsProject(nameB, lineB);
  await expect(page.locator(".coordination-view").getByText("Loading project activity…")).toHaveCount(0);
}, page);

await step("UI-09 a late Beta error after A->B->A is not shown in Alpha", ["UI-09"], async () => {
  const lineA = await responsibility(idA);
  await selectProject(idA);
  await showsProject(nameA, lineA);
  await hold(app, { name: "beta-error", projectId: idB, remaining: 1000 });
  await selectProject(idB);
  await expect.poll(() => heldCount(app, "beta-error")).toBeGreaterThan(0);
  await selectProject(idA);
  await showsProject(nameA, lineA);
  const released = await release(app, "beta-error", "Late Beta failure 乙");
  await settle(page, 800);
  await expect(page.getByText(/Late Beta failure/)).toHaveCount(0);
  await showsProject(nameA, lineA);
  await navigate(page, "Provider tools");
  await expect(page.getByText(/Late Beta failure/)).toHaveCount(0);
  return { releasedBetaErrors: released };
}, page);

await step("UI-09 an older Alpha reply cannot replace the newer Alpha view", ["UI-09"], async () => {
  const oldA = await responsibility(idA),
    lineB = await responsibility(idB);
  await selectProject(idB);
  await showsProject(nameB, lineB);
  await hold(app, { name: "alpha-old", projectId: idA, types: ["scope-snapshot"], remaining: 1 });
  await selectProject(idA);
  await expect.poll(() => heldCount(app, "alpha-old")).toBe(1);
  await selectProject(idB);
  await showsProject(nameB, lineB);
  const coordination = await command(page, { type: "coordination-query", projectId: idA });
  const workflow = await command(page, {
    type: "workflow-create",
    requestId: crypto.randomUUID(),
    projectId: idA,
    objective: "Alpha workflow after the held read",
    template: "desktop-fixture",
    templateVersion: "1",
  });
  await command(page, {
    type: "task-create",
    requestId: crypto.randomUUID(),
    projectId: idA,
    workspaceId: coordination.workspaces[0].id,
    workflowId: workflow.id,
    title: "Alpha task after the held read",
    role: "planner",
    acceptanceCriteria: ["Newer Alpha state"],
  });
  const newA = await responsibility(idA);
  expect(newA).not.toBe(oldA);
  await selectProject(idA);
  await showsProject(nameA, newA);
  await release(app, "alpha-old");
  await settle(page, 800);
  await showsProject(nameA, newA);
  // Current data shows no freshness banner (a "current" label is retired).
  await expect(page.locator(".scope-freshness:visible")).toHaveCount(0);
  return { oldA, newA };
}, page);

await step("UI-09 guided workflow drafts stay per project", ["UI-09"], async () => {
  await selectProjectIn(page, nameA);
  await openSection("Builder–reviewer");
  let setup = page.locator(".guided-workflow");
  await setup.locator("summary").first().click();
  await setup.getByRole("textbox", { name: "Objective", exact: true }).fill("Alpha draft 甲 only");
  await setup.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(setup.getByText(/Protected draft revision 1 saved/)).toBeVisible();
  await selectProjectIn(page, nameB);
  await openSection("Builder–reviewer");
  setup = page.locator(".guided-workflow");
  await expect(setup).toHaveAttribute("data-project-id", idB);
  await setup.locator("summary").first().click();
  await expect(setup.getByRole("textbox", { name: "Objective", exact: true })).toHaveValue("");
  await selectProjectIn(page, nameA);
  await openSection("Builder–reviewer");
  setup = page.locator(".guided-workflow");
  await expect(setup).toHaveAttribute("data-project-id", idA);
  await setup.locator("summary").first().click();
  await expect(setup.getByRole("textbox", { name: "Objective", exact: true })).toHaveValue("Alpha draft 甲 only");
}, page);
retired(
  "UI-09/UI-11 permanent Ready status",
  ["UI-09", "UI-11"],
  "The permanent \"Ready\" status bar was removed (docs/UX_Cleanup_Plan.md §1).",
  "Steps assert that an idle workbench shows no status bar and that pending work shows \"Operations pending\".",
);

await step("UI-10 disconnect keeps last-known data; reconnect reads only and replays no mutation", ["UI-10"], async () => {
  const lineA = await responsibility(idA);
  await selectProject(idA);
  await showsProject(nameA, lineA);
  // The page's own banner; Parallel integration repeats it (defect W1-1 below).
  const freshness = page.locator(".advanced-workflows > .scope-freshness:visible");
  const banners = page.locator(".scope-freshness:visible");
  // A mutation whose reply is still outstanding when the connection drops.
  await navigate(page, "Provider tools");
  // The service's own project snapshot, not the main process's cached state.
  const storedConversations = async () =>
    (await command(page, { type: "scope-snapshot", projectId: idA })).conversations.length;
  const conversationsBefore = await storedConversations();
  const addsBefore = (await calls(app)).filter((c) => c.type === "conversation-add" && c.projectId === idA).length;
  await hold(app, { name: "add-chat", types: ["conversation-add"], projectId: idA, remaining: 1 });
  await page.getByRole("button", { name: "+ New chat", exact: true }).click();
  await expect.poll(() => heldCount(app, "add-chat")).toBe(1);
  await openSection("Activity");
  // Let the mutation's own change events settle before the connection drops;
  // current data shows no freshness banner.
  await expect(freshness).toHaveCount(0, { timeout: 15000 });
  await settle(page, 1000);
  await expect(freshness).toHaveCount(0);
  const before = await callCount(app);
  // The transport is gone: every project read now fails without reaching the service.
  await hold(app, {
    name: "transport-down",
    types: ["scope-snapshot", "scope-events"],
    projectId: idA,
    remaining: 1000,
    failWith: "Fixture transport unavailable",
  });
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(freshness.locator("strong")).toHaveText("disconnected");
  await expect(freshness).toContainText("showing last-known state");
  await expect(freshness).toContainText("Connection unavailable");
  await showsProject(nameA, lineA);
  const repeated = await banners.count();
  await knownDefect(
    "W1-1",
    "Advanced workflows → Activity shows the same project-snapshot freshness banner twice (page and Parallel integration)",
    async () => expect(banners, "one freshness banner for one project snapshot").toHaveCount(1, { timeout: 1000 }),
  );
  // A reconnect attempt that fails keeps the last-known data, labelled stale.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(freshness.locator("strong")).toHaveText("stale");
  await expect(freshness).toContainText("showing last-known state");
  await expect(freshness.getByRole("alert")).toContainText("Fixture transport unavailable");
  await showsProject(nameA, lineA);
  await page.screenshot({ path: path.join(evidence, "disconnect-stale.png") });
  await settle(page, 1500);
  await clearRule(app, "transport-down");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(freshness).toHaveCount(0, { timeout: 15000 });
  await expect(banners).toHaveCount(0);
  await release(app, "add-chat");
  await settle(page, 1000);
  const after = await calls(app, before);
  const types = after.map((c) => c.type);
  const reads = new Set(["state", "scope-snapshot", "scope-events", "navigation-query", "navigation-save", "builder-reviewer-query", "coordination-query", "synchronization-query", "history-page", "history-conversations", "task-inspect", "coordinator-query", "coordinator-threads", "loop-query", "orchestration-query"]);
  const isRead = (t) => reads.has(t) || t.endsWith("-query") || t.endsWith("-inspect");
  expect(types.filter((t) => !isRead(t)), "commands other than reads after the disconnect").toEqual([]);
  const snapshots = types.filter((t) => t === "scope-snapshot").length;
  expect(snapshots, "bounded recovery reads").toBeLessThanOrEqual(10);
  const all = await calls(app);
  expect(all.filter((c) => c.type === "conversation-add" && c.projectId === idA).length).toBe(addsBefore + 1);
  expect(await storedConversations()).toBe(conversationsBefore + 1);
  return {
    callsDuringDisconnectAndRecovery: types,
    failedReads: after.filter((c) => c.failedBy).length,
    scopeSnapshots: snapshots,
    freshnessBannersWhileDisconnected: repeated,
  };
}, page);
retired(
  "UI-10 freshness \"current\" label",
  ["UI-10"],
  "Successful freshness banners were removed; Freshness shows only stale, failed or disconnected reads (docs/UX_Cleanup_Plan.md §1).",
  "The step above asserts the banner's absence when current and its disconnected/stale states.",
);

await step("UI-11 one pending mutation per target; unrelated controls stay usable; recovers after reply and error", ["UI-11"], async () => {
  await navigate(page, "Provider tools");
  const newChat = page.getByRole("button", { name: "+ New chat", exact: true });
  const countAdds = async () => (await calls(app)).filter((c) => c.type === "conversation-add" && c.projectId === idA).length;
  // Negative control: the call log does see two dispatches when two are made.
  const baseline = await countAdds();
  await page.evaluate(async (projectId) => {
    await Promise.all([
      window.topsl.command({ type: "conversation-add", projectId, title: "Control one" }),
      window.topsl.command({ type: "conversation-add", projectId, title: "Control two" }),
    ]);
  }, idA);
  expect(await countAdds()).toBe(baseline + 2);
  // Two clicks inside one task, before React can disable the button.
  await hold(app, { name: "add-twice", types: ["conversation-add"], projectId: idA, remaining: 1000 });
  const beforeClicks = await countAdds();
  await newChat.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect.poll(() => heldCount(app, "add-twice")).toBe(1);
  await expect(newChat).toBeDisabled();
  await newChat.click({ force: true }).catch(() => {});
  await settle(page, 300);
  expect(await countAdds()).toBe(beforeClicks + 1);
  // Unrelated controls stay usable while the mutation is pending.
  await expect(page.getByRole("combobox", { name: "Conversation" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Projects", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add project", exact: true })).toBeEnabled();
  await expect(page.locator("footer.statusbar")).toContainText("Operations pending");
  await page.screenshot({ path: path.join(evidence, "pending-new-chat.png") });
  // The pending line above the page heading is built from the command type.
  await knownDefect(
    "W1-2",
    "a pending operation is announced with its internal command name (\"conversation add…\") above the page heading",
    async () =>
      expect(page.locator('main.content > p[role="status"]', { hasText: "conversation add…" })).toHaveCount(0, { timeout: 1000 }),
  );
  await release(app, "add-twice");
  await expect(newChat).toBeEnabled();
  await idleStatus();
  expect(await countAdds()).toBe(beforeClicks + 1);
  // A rejected mutation re-enables its control and names the error.
  await hold(app, { name: "add-fails", types: ["conversation-add"], projectId: idA, remaining: 1 });
  await newChat.click();
  await expect.poll(() => heldCount(app, "add-fails")).toBe(1);
  await expect(newChat).toBeDisabled();
  await release(app, "add-fails", "Fixture rejection for the new chat");
  await expect(page.getByRole("alert").filter({ hasText: "Fixture rejection for the new chat" })).toBeVisible();
  await expect(newChat).toBeEnabled();
  // A background refresh does not disable the action, and the action works during it.
  await hold(app, { name: "refresh", types: ["scope-snapshot"], projectId: idA, remaining: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => heldCount(app, "refresh")).toBe(1);
  await expect(newChat).toBeEnabled();
  const beforeDuring = await countAdds();
  await newChat.click();
  await expect.poll(countAdds).toBe(beforeDuring + 1);
  await release(app, "refresh");
  await expect(newChat).toBeEnabled();
}, page);

const storedProjects = async () => (await command(page, { type: "state" })).projects;
await step("UI-12 add cancel and duplicate add keep one stable project identity", ["UI-12"], async () => {
  await page.setViewportSize({ width: 1280, height: 880 });
  await navigate(page, "Projects");
  const before = await storedProjects();
  await app.evaluate(() => (globalThis.campaignCancelNextOpen = true));
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  await settle(page, 500);
  expect((await storedProjects()).map((p) => p.id).sort()).toEqual(before.map((p) => p.id).sort());
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Projects");
  // The same folder again: no second project, same identity.
  await app.evaluate((_, folder) => (globalThis.campaignPick = folder), folderB);
  await navigate(page, "Projects");
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  await expect(crumb).toHaveText(`${nameB} / New session`);
  const after = await storedProjects();
  expect(after.length).toBe(before.length);
  expect(after.filter((p) => p.name === nameB).map((p) => p.id)).toEqual([idB]);
  await navigate(page, "Projects");
  await expect(page.locator(".project-card")).toHaveCount(before.length);
}, page);

await step("UI-12 missing folder is labelled; relink keeps identity and history and refuses another project's folder", ["UI-12"], async () => {
  const original = path.join(profile, "Relink 项目 source");
  const moved = path.join(profile, "Relink 项目 moved");
  await mkdir(original);
  await app.evaluate((_, folder) => (globalThis.campaignPick = folder), original);
  await navigate(page, "Projects");
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  await expect(crumb).toHaveText("Relink 项目 source / New session");
  const project = (await storedProjects()).find((p) => p.name === "Relink 项目 source");
  await command(page, { type: "conversation-add", projectId: project.id, title: "History that must follow the relink" });
  const countBefore = (await storedProjects()).length;
  const { rename } = await import("node:fs/promises");
  await rename(original, moved);
  const movedAt = Date.now();
  await navigate(page, "Projects");
  const card = page.getByRole("article", { name: "Relink 项目 source", exact: true });
  // Topsl re-checks folders at startup and every minute (no manual refresh
  // remains once discovery was retired), so allow for one check.
  await expect(card).toContainText("Folder unavailable", { timeout: 75000 });
  const labelledAfterMs = Date.now() - movedAt;
  await expect(card).toContainText("Relink this project’s folder to keep using its history.");
  await expect(card.getByRole("button", { name: "Open terminal", exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(evidence, "relink-missing-folder.png") });
  // Relinking to a folder that already belongs to Beta is refused, not merged.
  await app.evaluate((_, folder) => (globalThis.campaignPick = folder), folderB);
  await card.getByRole("button", { name: "Relink folder…", exact: true }).click();
  await expect(page.locator('main.content > p[role="alert"]', { hasText: "already belongs to another project" })).toHaveCount(1);
  expect((await storedProjects()).find((p) => p.id === project.id).realPath).toBe(project.realPath);
  await app.evaluate((_, folder) => (globalThis.campaignPick = folder), moved);
  await card.getByRole("button", { name: "Relink folder…", exact: true }).click();
  await expect(card).toContainText("Trusted folder");
  const relinked = (await storedProjects()).find((p) => p.id === project.id);
  expect(await realpath(relinked.path)).toBe(await realpath(moved));
  expect((await storedProjects()).length).toBe(countBefore);
  const conversations = (await command(page, { type: "scope-snapshot", projectId: project.id })).conversations;
  expect(conversations.map((c) => c.title)).toContain("History that must follow the relink");
  await expect(card.locator("code.path")).toHaveText(relinked.path);
  return { id: project.id, path: relinked.path, labelledAfterMs };
}, page);
retired(
  "UI-12 project discovery and Open folder controls",
  ["UI-12"],
  "Automatic project discovery (Enable project discovery…, Refresh projects) and folder deep links (Open folder) were removed (docs/UX_Cleanup_Plan.md §2); availability is a stat-only check at startup and every minute.",
  "The step above waits for that periodic check and asserts Open terminal is disabled for the missing folder.",
);

await step("UI-16 instruction file: exact scope shown; native cancel and external drift leave the file untouched", ["UI-16"], async () => {
  await selectProjectIn(page, nameA);
  await navigate(page, "Settings");
  const card = page.locator(".settings-card").filter({ has: page.getByRole("heading", { name: "Configuration & instructions" }) });
  await card.getByRole("button", { name: "Project instructions", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Native configuration text" });
  await expect(editor).toBeVisible();
  const target = path.join(await realpath(folderA), "AGENTS.md");
  const shown = await card.locator("p.path").first().textContent();
  // The canonical project folder, exactly.
  expect(path.dirname(shown)).toBe(await realpath(folderA));
  expect(path.basename(shown)).toBe("AGENTS.md");
  await editor.fill("Campaign instructions 指令 — reviewed text\nsecond line");
  await page.getByRole("button", { name: "Preview changes", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review configuration change" });
  await expect(review).toBeVisible();
  await expect(review.locator("code.path")).toHaveText(shown);
  await expect(review).toContainText("Campaign instructions 指令");
  // Native cancel: nothing is written and the reviewed plan stays open.
  const asked = (await app.evaluate(() => globalThis.campaignConfirmations.length));
  await app.evaluate(() => globalThis.campaignNextResponses.push(0));
  await review.getByRole("button", { name: "Apply reviewed file…", exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.campaignConfirmations.length)).toBe(asked + 1);
  const cancelled = await app.evaluate(() => globalThis.campaignConfirmations.at(-1));
  expect(cancelled).toEqual({ message: "Apply the reviewed native configuration?", response: 0 });
  await settle(page, 300);
  expect(await exists(target)).toBe(false);
  await expect(review).toBeVisible();
  // An external edit after the preview invalidates the approval.
  await writeFile(target, "External edit made after the preview\n");
  await review.getByRole("button", { name: "Apply reviewed file…", exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.campaignConfirmations.length)).toBe(asked + 2);
  await expect(page.locator('main.content > p[role="alert"]')).not.toHaveCount(0);
  expect(await readFile(target, "utf8")).toBe("External edit made after the preview\n");
  const alerts = await page.locator('main.content > p[role="alert"]').allTextContents();
  await review.getByRole("button", { name: "Close dialog" }).click();
  await expect(review).toHaveCount(0);
  return { shownPath: shown, driftRejection: alerts };
}, page);

await step("UI-02 no passphrase in state, Electron output or profile files (main journey)", ["UI-02"], async () => {
  const state = JSON.stringify(await command(page, { type: "state" }));
  expect(state).not.toContain(TEST_PASSPHRASE);
  expect(output.join("").includes(TEST_PASSPHRASE)).toBe(false);
  return { outputBytes: output.join("").length };
}, page);

await step("UI-26 bounded navigation soak (measured only)", ["UI-26"], async () => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const samples = [];
  const navigationMs = [];
  // TOPSL_UI_SOAK_MINUTES runs the cycles for that long instead of the
  // default 12 (plan §12.7 asks for a one-hour soak); samples are thinned to
  // about 60 so the report stays readable.
  const soakMinutes = Number(process.env.TOPSL_UI_SOAK_MINUTES ?? 0);
  const soakUntil = soakMinutes > 0 ? Date.now() + soakMinutes * 60_000 : 0;
  let cycles = 12;
  const sample = async (cycle) => {
    await cdp.send("HeapProfiler.collectGarbage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().length);
    samples.push({
      cycle,
      nodes: dom.nodes,
      documents: dom.documents,
      jsEventListeners: dom.jsEventListeners,
      heapUsedBytes: heap.usedSize,
      processes,
      ipcCalls: await callCount(app),
    });
  };
  await sample(0);
  const defaultCycles = cycles;
  for (let cycle = 1; soakUntil ? Date.now() < soakUntil : cycle <= defaultCycles; cycle++) {
    cycles = cycle;
    for (const nav of allDestinations) {
      const begin = Date.now();
      await navigate(page, nav);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      navigationMs.push(Date.now() - begin);
    }
    await navigate(page, "Advanced workflows");
    for (const name of advancedSections) {
      const begin = Date.now();
      await sectionTab(name).click();
      await expect(sectionTab(name)).toHaveAttribute("aria-selected", "true");
      navigationMs.push(Date.now() - begin);
    }
    await selectProject(cycle % 2 ? idB : idA);
    await page.keyboard.press(`${mod}+k`);
    await expect(paletteDialog).toBeVisible();
    await page.keyboard.press("Escape");
    if (!soakUntil || cycle % Math.max(1, Math.round(soakMinutes)) === 0) await sample(cycle);
  }
  if (soakUntil && samples.at(-1).cycle !== cycles) await sample(cycles);
  await cdp.detach();
  const sorted = navigationMs.slice().sort((a, b) => a - b);
  const warm = samples.slice(2);
  measurements.soak = {
    cycles,
    minutes: soakMinutes || null,
    navigations: navigationMs.length,
    navigationP50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    navigationP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    navigationMaxMs: sorted.at(-1),
    samples,
    drift: {
      nodes: warm.at(-1).nodes - warm[0].nodes,
      jsEventListeners: warm.at(-1).jsEventListeners - warm[0].jsEventListeners,
      heapUsedPercent: Math.round(((warm.at(-1).heapUsedBytes - warm[0].heapUsedBytes) / warm[0].heapUsedBytes) * 1000) / 10,
      processes: warm.at(-1).processes - warm[0].processes,
    },
    note: "Navigation latency includes Playwright locator overhead; IPC subscription counts in the preload world are not observable here.",
  };
  return { drift: measurements.soak.drift, navigationP95Ms: measurements.soak.navigationP95Ms };
}, page);

await step("no renderer errors during the journey", ["UI-03"], async () => {
  expect(errors).toEqual([]);
});
const ipcLog = await calls(app).catch(() => []);
await app.close();
await step("UI-02 no passphrase in any file of the main profile after close", ["UI-02"], async () => {
  expect(await filesContaining(profile, TEST_PASSPHRASE)).toEqual([]);
  expect(output.join("").includes(TEST_PASSPHRASE)).toBe(false);
});

const report = {
  recordedAt: new Date().toISOString(),
  scope: "Actual Electron, isolated TOPSL_TEST_PROFILE, local shell stand-in only; IPC replies delayed/failed by a main-process test wrapper",
  host: {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    runnerNode: process.version,
  },
  steps,
  measurements,
  ipcCommandCounts: ipcLog.reduce((acc, c) => ((acc[c.type] = (acc[c.type] ?? 0) + 1), acc), {}),
};
await writeFile(path.join(evidence, "campaign-ui-report.json"), JSON.stringify(report, null, 2) + "\n");
const summary = steps.reduce((acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc), {});
console.log(`Campaign UI harness: ${JSON.stringify(summary)}. Report: ${path.join(evidence, "campaign-ui-report.json")}`);
if (failed) process.exitCode = 1;
