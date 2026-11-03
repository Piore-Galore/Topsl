// Campaign 2026-11-04 worker W3: inspection of Topsl's actual Electron
// interface (docs/testing/2026-11-04-comprehensive/PLAN.md, step 4).
//
// Every launch uses its own isolated TOPSL_TEST_PROFILE with local stand-in
// providers only (tests/fixtures/codex-desktop-coordinator.cjs,
// claude-qualify.cjs and claude-usage.cjs behind small shell dispatchers);
// no model, account or network is contacted. Native confirmations are
// answered in the main process as the desktop journeys do. Commands that
// would reach the network (release lookups, update checks, documentation
// links, discovery) are refused at the IPC boundary; a lifecycle plan is a
// synthetic reply so Topsl's own review dialog can be inspected.
//
// Phases (TOPSL_W3_PHASES, comma-separated, default all):
//   firstrun  fresh profile walkthrough judged by visible guidance
//   dense     205 sessions: sidebar, All sessions paging/search, blocked session
//   main      populated profile: providers, sessions in every goal state,
//             loops, imports, provider tools, advanced workflows, settings,
//             modals, loading/failed states, keyboard, IME, clipboard, then
//             every view across themes, sizes and zoom.
//   loops     a Codex-only profile: a loop draft, running and stopped, as the
//             loop journey drives them (run it with TOPSL_W3_PHASES=loops and
//             TOPSL_W3_REPORT=checks-loops.json to keep the main report).
//
// Each view is screenshotted and measured in the page: horizontal overflow,
// clipped controls, overlapping/occluded interactive elements, approximate
// WCAG text contrast, and (full tier) accessible names from Chromium's
// accessibility tree plus a Tab walk for order, reach and visible focus.
// Results are data, not a verdict: the screenshots still need a human look.
//
// Run (macOS; the Claude stand-in needs a POSIX shell):
//   CE=test-results/agent-testing/2026-11-04-comprehensive/cleanenv.sh
//   $CE npm run build && $CE node scripts/campaign-inspection.mjs
// TOPSL_W3_EVIDENCE overrides the evidence folder.
import { _electron as electron, expect } from "@playwright/test";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { navigate, openThread, selectProject } from "./desktop-navigation.mjs";

const EVIDENCE = path.resolve(
  process.env.TOPSL_W3_EVIDENCE ??
    "/Users/piore/repos/Topsl/test-results/agent-testing/2026-11-04-comprehensive/w3-inspection",
);
const PHASES = (process.env.TOPSL_W3_PHASES ?? "firstrun,dense,main")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
await mkdir(EVIDENCE, { recursive: true });
await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
const revision = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
const report = {
  scope:
    "Actual Electron (dev build) with isolated synthetic profiles and local stand-in providers; no live provider, account or network.",
  revision,
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  phases: {},
};
let phase = null;
function startPhase(name) {
  phase = report.phases[name] = {
    startedAt: new Date().toISOString(),
    steps: [],
    views: [],
    interactions: [],
    walkthrough: [],
    pageErrors: [],
    confirmations: [],
  };
}
// A phase run on its own can write a report of its own (TOPSL_W3_REPORT).
const REPORT = process.env.TOPSL_W3_REPORT ?? "checks.json";
async function save() {
  await writeFile(
    path.join(EVIDENCE, REPORT),
    JSON.stringify(report, null, 1) + "\n",
  );
}
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
/** One step; a failure is recorded with a screenshot and the phase continues. */
async function step(name, fn, page) {
  const started = Date.now();
  try {
    const detail = await fn();
    phase.steps.push({
      name,
      status: "passed",
      ms: Date.now() - started,
      detail: detail ?? null,
    });
    console.log(`STEP PASS ${name}`);
    return detail;
  } catch (error) {
    const message = String(error?.stack ?? error).slice(0, 2500);
    phase.steps.push({
      name,
      status: "failed",
      ms: Date.now() - started,
      error: message,
    });
    console.error(
      `STEP FAIL ${name}\n${message.split("\n").slice(0, 6).join("\n")}`,
    );
    if (page)
      await page
        .screenshot({ path: path.join(EVIDENCE, `fail-${slug(name)}.png`) })
        .catch(() => {});
    return undefined;
  } finally {
    await save();
  }
}
/** Retries a flaky step once and records both outcomes. */
async function stepRetry(name, fn, page) {
  const first = await step(name, fn, page);
  if (phase.steps.at(-1).status === "passed") return first;
  return step(`${name} (retry)`, fn, page);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const LONG_TOKEN =
  "/Users/navigator/Projects/北极星-atlas/src/very/deeply/nested/directory/structure/that-keeps-going-without-any-spaces-at-all/and-even-further-down/components/HarborChartRendererWithAnExtremelyLongComponentName.tsx";
const UNICODE_LINE =
  "Unicode check: 中文测试 · 日本語のテキスト · 한국어 · العربية من اليمين إلى اليسار · emoji 🧭🚀⚓️👩🏽‍💻 · combining é́ · ZWJ 👨‍👩‍👧‍👦";

async function gitProject(folder, files = {}) {
  await mkdir(folder, { recursive: true });
  const all = {
    "file.ts": "export const value = 1;\n",
    "AGENTS.md":
      "# Inspection project\n\nSynthetic instructions for the W3 inspection.\n",
    ...files,
  };
  for (const [name, text] of Object.entries(all))
    await writeFile(path.join(folder, name), text);
  const git = (args) =>
    execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "user.name=Fixture",
    "commit",
    "-qm",
    "base",
  ]);
  return realpath(folder);
}
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
/**
 * The Codex stand-in: the coordinator fixture on pipes (app-server,
 * qualification), and a printing `cat` when Topsl opens it in a terminal.
 */
async function codexStandIn(directory, delay) {
  const file = path.join(directory, "codex-w3");
  await writeFile(
    file,
    `#!/bin/sh
if [ -t 0 ] && [ "$1" != "--version" ]; then
  printf 'Codex terminal stand-in · 终端 🚀 · no model is contacted\\n'
  printf '%s\\n' ${quote(LONG_TOKEN)}
  printf '%s\\n' ${quote(UNICODE_LINE)}
  exec cat
fi
FIXTURE_TURN_DELAY_MS=${delay} exec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/codex-desktop-coordinator.cjs"))} "$@"
`,
  );
  await chmod(file, 0o700);
  return file;
}
/**
 * The Claude stand-in: /usage and \`auth status --json\` from the usage
 * fixture, a printing \`cat\` in a terminal, else the qualification fixture.
 */
async function claudeStandIn(directory, log) {
  const file = path.join(directory, "claude-w3");
  await writeFile(
    file,
    `#!/bin/sh
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "/usage" ] || [ "$*" = "auth status --json" ]; then
  exec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/claude-usage.cjs"))} "$@"
fi
if [ -t 0 ] && [ "$1" != "--version" ] && [ "$1" != "--help" ]; then
  printf 'Claude Code terminal stand-in · 终端 🚀\\n'
  exec cat
fi
FIXTURE_LOG=${quote(log)} exec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/claude-qualify.cjs"))} "$@"
`,
  );
  await chmod(file, 0o700);
  return file;
}
/** A Codex JSON Lines export with long, Unicode and code-heavy messages. */
async function importFile(directory, cwd) {
  const longResponse = [
    "Here is a long response, as a provider might return it.",
    "",
    UNICODE_LINE,
    "",
    `The file lives at ${LONG_TOKEN} and the renderer must wrap this path rather than widen the page.`,
    "",
    "```ts",
    "export function chartHarbor(depths: number[], tide: 'rising' | 'falling'): string { return depths.map((d) => `${d.toFixed(2)}m`).join(' → '); } // a long code line that should scroll or wrap inside its own box",
    "```",
    "",
    ...Array.from(
      { length: 40 },
      (_, i) =>
        `${i + 1}. Survey note ${i + 1}: the channel depth at marker ${i + 1} is ${(i * 0.37).toFixed(2)} m · 測深 ${i + 1}.`,
    ),
  ].join("\n");
  const records = [
    { type: "session_meta", payload: { id: "w3-import-session", cwd } },
    ...Array.from({ length: 24 }, (_, i) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: i % 2 ? "assistant" : "user",
        content: [
          {
            type: i % 2 ? "output_text" : "input_text",
            text:
              i === 23
                ? longResponse
                : i % 2
                  ? `Reply ${i}: ${UNICODE_LINE}`
                  : `Question ${i}: how deep is the harbor at marker ${i}? 港口 ⚓️`,
          },
        ],
      },
    })),
  ];
  const file = path.join(directory, "w3-harbor-history-导出.jsonl");
  await writeFile(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

// ---------------------------------------------------------------------------
// Electron
// ---------------------------------------------------------------------------
async function launch(profile, extra = {}) {
  const env = {
    ...process.env,
    TOPSL_TEST_PROFILE: profile,
    CLAUDE_CONFIG_DIR: path.join(profile, "claude-config"),
    CODEX_HOME: path.join(profile, "native-home", ".codex"),
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete env[name];
  const app = await electron.launch({ args: ["."], env, timeout: 90000 });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => phase.pageErrors.push(error.message));
  page.setDefaultTimeout(20000);
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 45000 });
  return { app, page };
}
/** Native dialogs: the folder or file the harness set, the runtime it set, else affirmative. */
const mockDialogs = (app, openPath, runtime = 1) =>
  app.evaluate(
    ({ dialog }, { openPath, runtime }) => {
      globalThis.w3 ??= { confirmations: [] };
      globalThis.w3.openPath = openPath;
      globalThis.w3.runtime = runtime;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [globalThis.w3.openPath],
      });
      dialog.showSaveDialog = async () => ({ canceled: true });
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        globalThis.w3.confirmations.push({
          message: options.message,
          detail: options.detail ?? "",
          buttons: options.buttons,
        });
        return {
          response:
            options.message === "Which runtime are you locating?"
              ? globalThis.w3.runtime
              : 1,
          checkboxChecked: false,
        };
      };
    },
    { openPath, runtime },
  );
const setOpen = (app, openPath, runtime) =>
  app.evaluate(
    (_, { openPath, runtime }) => {
      globalThis.w3.openPath = openPath;
      if (runtime !== undefined) globalThis.w3.runtime = runtime;
    },
    { openPath, runtime },
  );

/**
 * Wraps the registered `topsl:command` handler: logs every command, refuses
 * network-bound commands, and holds, fails or answers replies by rule.
 */
async function installInterceptor(app) {
  const result = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers?.get?.("topsl:command");
    if (!original) return "no topsl:command handler";
    const c = (globalThis.__w3 = { calls: [], rules: [], held: [] });
    const refused = [
      "check-updates",
      "open-docs",
      "discover",
      "lifecycle-apply",
      "lifecycle-retry-preview",
    ];
    handlers.set("topsl:command", async (event, raw) => {
      const entry = { seq: c.calls.length, type: raw?.type, at: Date.now() };
      if (["session-create", "session-message"].includes(raw?.type))
        entry.text = String(raw.text ?? "").slice(0, 80);
      c.calls.push(entry);
      if (refused.includes(raw?.type)) {
        entry.refused = true;
        return {
          error:
            "Refused by the inspection harness: this command could reach the network.",
        };
      }
      const rule = c.rules.find(
        (r) => r.remaining > 0 && r.types.includes(raw?.type),
      );
      if (rule) rule.remaining--;
      if (rule?.failWith) {
        entry.failedBy = rule.name;
        return { error: rule.failWith };
      }
      if (rule?.reply !== undefined) {
        entry.answeredBy = rule.name;
        // The real handler answers { value } or { error } (apps/desktop/main.ts).
        return {
          value:
            typeof rule.reply === "function" ? rule.reply(raw) : rule.reply,
        };
      }
      const reply = await original(event, raw);
      if (!rule?.hold) return reply;
      entry.heldBy = rule.name;
      return new Promise((resolve) =>
        c.held.push({ rule: rule.name, release: () => resolve(reply) }),
      );
    });
    return "installed";
  });
  if (result !== "installed")
    throw new Error(`IPC interceptor unavailable: ${result}`);
}
const addRule = (app, rule) =>
  app.evaluate((_, rule) => {
    if (rule.replyPlan)
      rule.reply = (raw) => ({
        id: "w3-synthetic-plan",
        appId: raw.appId,
        installationId: raw.installationId ?? null,
        expectedRevision: null,
        installedVersion: null,
        action: raw.action,
        route: "native",
        effects: [
          "Synthetic plan from the inspection harness: no release was looked up.",
          "Opens the official installer for you to complete; Topsl does not verify installation.",
        ],
        release: {
          version: "0.0.0-w3",
          url: "https://example.invalid/synthetic/release/with/a/very/long/path/that/should/wrap/inside/the/dialog/Topsl-W3-synthetic-artifact-name.zip",
          sha256: "0".repeat(64),
          artifactName: "Topsl-W3-synthetic-artifact-name.zip",
        },
        command: null,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      });
    globalThis.__w3.rules.push({ remaining: 1, ...rule });
  }, rule);
const releaseRule = (app, name) =>
  app.evaluate((_, name) => {
    const c = globalThis.__w3;
    const items = c.held.filter((h) => h.rule === name);
    c.held = c.held.filter((h) => h.rule !== name);
    c.rules = c.rules.filter((r) => r.name !== name);
    for (const item of items) item.release();
    return items.length;
  }, name);
const callCount = (app) => app.evaluate(() => globalThis.__w3.calls.length);
const callsSince = (app, since) =>
  app.evaluate((_, since) => globalThis.__w3.calls.slice(since), since);
const command = (page, value) =>
  page.evaluate((value) => window.topsl.command(value), value);
const frames = (page) =>
  page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
async function settle(page, ms = 300) {
  await frames(page);
  await page.waitForTimeout(ms);
  await frames(page);
}

// ---------------------------------------------------------------------------
// In-page measurements
// ---------------------------------------------------------------------------
/** Geometry, clipping, overlap, occlusion and contrast of what is on screen. */
function inPageAudit() {
  const out = {};
  const styleOf = (e) => getComputedStyle(e);
  const visible = (e) => {
    if (!(e instanceof Element)) return false;
    if (e.closest("[hidden], [inert]")) return false;
    // The content of a closed <details> is not shown, whatever its box says.
    for (
      let d = e.closest("details:not([open])");
      d;
      d = d.parentElement?.closest("details:not([open])")
    ) {
      const summary = d.querySelector(":scope > summary");
      if (!summary || !summary.contains(e)) return false;
    }
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let n = e; n; n = n.parentElement) {
      const s = styleOf(n);
      if (
        s.display === "none" ||
        s.visibility === "hidden" ||
        Number(s.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const text = (e) =>
    (
      e.getAttribute?.("aria-label") ||
      e.innerText ||
      e.value ||
      e.getAttribute?.("title") ||
      e.textContent ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 90);
  const describe = (e) => {
    const r = e.getBoundingClientRect();
    return {
      tag: e.tagName.toLowerCase(),
      cls: (e.getAttribute("class") || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join("."),
      name: text(e),
      box: [
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.width),
        Math.round(r.height),
      ],
    };
  };
  const modal = [...document.querySelectorAll("dialog[open]")].find((d) =>
    d.matches(":modal"),
  );
  const root = modal ?? document.body;
  out.modal = modal ? modal.getAttribute("aria-label") : null;
  const de = document.documentElement;
  out.viewport = { innerWidth, innerHeight, dpr: devicePixelRatio };
  out.overflow = {
    page: de.scrollWidth - de.clientWidth,
    pageHeight: de.scrollHeight,
  };
  out.h1 = [...document.querySelectorAll("h1")]
    .filter(visible)
    .map((h) => h.innerText.trim().slice(0, 80));
  out.ariaCurrent = [
    ...document.querySelectorAll('[aria-current="page"]'),
  ].filter(visible).length;
  const all = [...root.querySelectorAll("*")];
  // Horizontally scrolling boxes other than the page.
  out.hScroll = all
    .filter((e) => {
      const s = styleOf(e);
      return (
        ["auto", "scroll"].includes(s.overflowX) &&
        e.scrollWidth > e.clientWidth + 1 &&
        visible(e)
      );
    })
    .slice(0, 30)
    .map((e) => ({ ...describe(e), by: e.scrollWidth - e.clientWidth }));
  // Clipped text in controls, labels and badges.
  const clipSel =
    "button, a, label, .badge, summary, [role=tab], [role=menuitem], .count, h1, h2, h3, kbd, legend, dt, dd, th, .thread-title, .project-name, .eyebrow, code.path, .path";
  const clipped = [];
  for (const e of root.querySelectorAll(clipSel)) {
    if (!visible(e)) continue;
    const s = styleOf(e);
    if (s.display === "inline") continue;
    const x = e.scrollWidth - e.clientWidth;
    const y = e.scrollHeight - e.clientHeight;
    const clips = (v) => v !== "visible";
    if (x > 1 || (y > 2 && clips(s.overflowY)))
      clipped.push({
        ...describe(e),
        x,
        y,
        overflowX: s.overflowX,
        textOverflow: s.textOverflow,
        whiteSpace: s.whiteSpace,
        kind: clips(s.overflowX)
          ? s.textOverflow === "ellipsis"
            ? "ellipsis"
            : "hard-clip"
          : "spills",
      });
  }
  out.clipped = clipped.slice(0, 60);
  out.clippedCount = clipped.length;
  // Select and placeholder text wider than its box.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const textWidth = (e, t) => {
    const s = styleOf(e);
    ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return ctx.measureText(t).width;
  };
  out.selectClipped = [];
  for (const e of root.querySelectorAll("select")) {
    if (!visible(e) || e.multiple) continue;
    const s = styleOf(e);
    const t = e.options[e.selectedIndex]?.text ?? "";
    const room =
      e.clientWidth -
      parseFloat(s.paddingLeft) -
      parseFloat(s.paddingRight) -
      18;
    const w = textWidth(e, t);
    if (w > room + 1)
      out.selectClipped.push({
        ...describe(e),
        shown: t.slice(0, 90),
        textWidth: Math.round(w),
        room: Math.round(room),
      });
  }
  out.placeholderClipped = [];
  for (const e of root.querySelectorAll(
    "input[placeholder], textarea[placeholder]",
  )) {
    if (!visible(e) || e.value) continue;
    if (e.tagName === "TEXTAREA") continue;
    const s = styleOf(e);
    const room =
      e.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    const w = textWidth(e, e.placeholder);
    if (w > room + 1)
      out.placeholderClipped.push({
        ...describe(e),
        placeholder: e.placeholder.slice(0, 90),
        textWidth: Math.round(w),
        room: Math.round(room),
      });
  }
  // Interactive elements: beyond their clipping box, overlapping, occluded.
  const interactiveSel =
    'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=radio], [role=checkbox], [tabindex]:not([tabindex="-1"])';
  const interactive = [...root.querySelectorAll(interactiveSel)].filter(
    visible,
  );
  const clipBox = (e) => {
    for (
      let n = e.parentElement;
      n && n !== document.body;
      n = n.parentElement
    ) {
      const s = styleOf(n);
      if (s.overflowX !== "visible" || s.overflowY !== "visible")
        return {
          node: n,
          scrolls:
            ["auto", "scroll"].includes(s.overflowX) ||
            ["auto", "scroll"].includes(s.overflowY),
          rect: n.getBoundingClientRect(),
        };
    }
    return null;
  };
  out.cutOff = [];
  out.beyondViewport = [];
  out.overlaps = [];
  out.occluded = [];
  const boxes = [];
  for (const e of interactive) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue; // visually hidden inputs
    const box = clipBox(e);
    if (
      box &&
      !box.scrolls &&
      (r.right > box.rect.right + 1 || r.left < box.rect.left - 1)
    )
      out.cutOff.push({
        ...describe(e),
        by: Math.round(
          Math.max(r.right - box.rect.right, box.rect.left - r.left),
        ),
        container: describe(box.node).cls,
      });
    if (!box && (r.right > innerWidth + 1 || r.left < -1))
      out.beyondViewport.push({ ...describe(e), right: Math.round(r.right) });
    const inView =
      r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    if (!inView) continue;
    boxes.push([e, r]);
    // Occlusion at the centre, when the centre is inside every clipping box.
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    let clippedOut = false;
    for (
      let n = e.parentElement;
      n && n !== document.body;
      n = n.parentElement
    ) {
      const s = styleOf(n);
      if (s.overflowX !== "visible" || s.overflowY !== "visible") {
        const b = n.getBoundingClientRect();
        if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom)
          clippedOut = true;
      }
    }
    if (clippedOut) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || e.contains(hit) || hit.contains(e)) continue;
    if (hit.tagName === "LABEL" && (hit.control === e || hit.contains(e)))
      continue;
    if (e.labels && [...e.labels].some((l) => l.contains(hit))) continue;
    out.occluded.push({ ...describe(e), by: describe(hit) });
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, ra] = boxes[i];
      const [b, rb] = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2 && w * h > 8)
        out.overlaps.push({
          a: describe(a),
          b: describe(b),
          w: Math.round(w),
          h: Math.round(h),
        });
    }
  out.overlaps = out.overlaps.slice(0, 40);
  out.occluded = out.occluded.slice(0, 40);
  // Contrast: text colour against the composited ancestor background.
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cc = cv.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const rgba = (str) => {
    if (cache.has(str)) return cache.get(str);
    cc.clearRect(0, 0, 1, 1);
    cc.fillStyle = "#000";
    cc.fillStyle = str;
    cc.fillRect(0, 0, 1, 1);
    const d = cc.getImageData(0, 0, 1, 1).data;
    const v = [d[0], d[1], d[2], d[3] / 255];
    cache.set(str, v);
    return v;
  };
  const blend = (top, base) =>
    [0, 1, 2].map((k) => top[k] * top[3] + base[k] * (1 - top[3])).concat(1);
  const background = (e) => {
    const layers = [];
    let image = false;
    for (let n = e; n; n = n.parentElement) {
      const s = styleOf(n);
      if (s.backgroundImage && s.backgroundImage !== "none") image = true;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) {
        layers.push(c);
        if (c[3] >= 0.999) break;
      }
    }
    let base = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return { color: base, image };
  };
  const lum = (c) => {
    const v = c.slice(0, 3).map((x) => {
      x /= 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const hex = (c) =>
    "#" +
    c
      .slice(0, 3)
      .map((x) => Math.round(x).toString(16).padStart(2, "0"))
      .join("");
  const opacity = (e) => {
    let o = 1;
    for (let n = e; n; n = n.parentElement) o *= Number(styleOf(n).opacity);
    return o;
  };
  const textElements = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (
      n.nodeValue.trim() &&
      n.parentElement &&
      !["SCRIPT", "STYLE", "OPTION"].includes(n.parentElement.tagName)
    )
      textElements.add(n.parentElement);
  for (const e of root.querySelectorAll(
    "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select",
  ))
    textElements.add(e);
  const failures = [];
  const disabledLow = [];
  let measured = 0;
  let uncertain = 0;
  let worst = null;
  for (const e of textElements) {
    if (!visible(e)) continue;
    if (e.closest(".xterm")) continue;
    measured++;
    const s = styleOf(e);
    const bg = background(e);
    let fg = rgba(s.color);
    const op = opacity(e);
    fg = blend([fg[0], fg[1], fg[2], fg[3] * op], bg.color);
    const r = ratio(fg, bg.color);
    const size = parseFloat(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const entry = {
      ...describe(e),
      ratio: Math.round(r * 100) / 100,
      need,
      fg: hex(fg),
      bg: hex(bg.color),
      size,
      weight,
      image: bg.image,
    };
    if (!worst || r < worst.ratio) worst = entry;
    if (r < need) {
      if (bg.image) uncertain++;
      if (e.closest(":disabled, [aria-disabled=true]")) disabledLow.push(entry);
      else failures.push(entry);
    }
  }
  out.contrast = {
    measured,
    failures: failures.slice(0, 60),
    failureCount: failures.length,
    uncertainWithImage: uncertain,
    disabledBelow: disabledLow.length,
    disabledSample: disabledLow.slice(0, 5),
    worst,
  };
  // Placeholder contrast (informative text in empty fields).
  out.placeholderContrast = [];
  for (const e of root.querySelectorAll(
    "input[placeholder], textarea[placeholder]",
  )) {
    if (!visible(e) || e.value) continue;
    const bg = background(e);
    const p = rgba(getComputedStyle(e, "::placeholder").color);
    const fg = blend(p, bg.color);
    const r = ratio(fg, bg.color);
    if (r < 4.5)
      out.placeholderContrast.push({
        ...describe(e),
        placeholder: e.placeholder.slice(0, 60),
        ratio: Math.round(r * 100) / 100,
        fg: hex(fg),
        bg: hex(bg.color),
      });
  }
  out.selection = {
    userSelectNone: [
      ...root.querySelectorAll(".turn-text, .transcript, code, pre, .path"),
    ].filter((e) => visible(e) && styleOf(e).userSelect === "none").length,
  };
  return out;
}

/** Elements with an interactive role and no accessible name, from Chromium's tree. */
async function unnamedControls(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Accessibility.enable");
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const roles = new Set([
      "button",
      "link",
      "textbox",
      "searchbox",
      "combobox",
      "checkbox",
      "radio",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "switch",
      "slider",
      "spinbutton",
      "listbox",
      "DisclosureTriangle",
      "treeitem",
    ]);
    const out = {
      checked: 0,
      unnamed: [],
      symbolOnly: [],
      toggleWithoutState: [],
    };
    for (const n of nodes) {
      if (n.ignored || !roles.has(n.role?.value)) continue;
      out.checked++;
      const name = String(n.name?.value ?? "").trim();
      let dom = null;
      const describe = async () => {
        if (dom || !n.backendDOMNodeId) return dom;
        try {
          const { node } = await cdp.send("DOM.describeNode", {
            backendNodeId: n.backendDOMNodeId,
          });
          const attrs = {};
          for (let i = 0; i < (node.attributes ?? []).length; i += 2)
            attrs[node.attributes[i]] = node.attributes[i + 1];
          dom = {
            tag: node.localName,
            class: attrs.class ?? "",
            id: attrs.id ?? "",
            type: attrs.type ?? "",
          };
        } catch {}
        return dom;
      };
      if (!name)
        out.unnamed.push({ role: n.role.value, dom: await describe() });
      else if (name.length <= 2 && !/[\p{L}\p{N}]/u.test(name))
        out.symbolOnly.push({
          role: n.role.value,
          name,
          dom: await describe(),
        });
    }
    out.unnamed = out.unnamed.slice(0, 40);
    out.symbolOnly = out.symbolOnly.slice(0, 40);
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Tab through the page: order, reach and a visible focus change per stop. */
async function tabWalk(page, max = 160) {
  const setup = await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body)
      document.activeElement.blur();
    const modal = [...document.querySelectorAll("dialog[open]")].find((d) =>
      d.matches(":modal"),
    );
    const root = modal ?? document.body;
    const sel =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable="true"]';
    const st = (n) => {
      if (!n) return "";
      const s = getComputedStyle(n);
      return [
        s.outlineStyle,
        s.outlineWidth,
        s.outlineColor,
        s.boxShadow,
        s.borderColor,
        s.backgroundColor,
        s.textDecorationLine,
        s.color,
      ].join("|");
    };
    const shown = (e) => {
      if (e.closest("[hidden], [inert]")) return false;
      const r = e.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return false;
      for (let n = e; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === "none" || s.visibility === "hidden") return false;
      }
      return true;
    };
    window.__w3tab = { base: {}, info: {} };
    let i = 0;
    const radios = new Set();
    const expected = [];
    for (const e of root.querySelectorAll(sel)) {
      const id = String(i++);
      e.dataset.w3tab = id;
      window.__w3tab.base[id] = [
        st(e),
        st(e.parentElement),
        st(e.closest("label")),
      ];
      if (e.disabled || e.tabIndex < 0 || !shown(e)) continue;
      if (e.type === "radio" && e.name) {
        const group = [
          ...root.querySelectorAll(
            `input[type=radio][name="${CSS.escape(e.name)}"]`,
          ),
        ];
        const pick = group.find((r) => r.checked) ?? group[0];
        if (pick !== e || radios.has(e.name)) continue;
        radios.add(e.name);
      }
      if (e.closest("details:not([open])") && !e.matches("summary")) continue;
      expected.push(id);
    }
    return { expected, total: i };
  });
  const stops = [];
  let first = null;
  let bodyHits = 0;
  for (let k = 0; k < max; k++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return { body: true };
      const st = (n) => {
        if (!n) return "";
        const s = getComputedStyle(n);
        return [
          s.outlineStyle,
          s.outlineWidth,
          s.outlineColor,
          s.boxShadow,
          s.borderColor,
          s.backgroundColor,
          s.textDecorationLine,
          s.color,
        ].join("|");
      };
      const id = e.dataset?.w3tab ?? null;
      const base = id ? window.__w3tab.base[id] : null;
      const now = [st(e), st(e.parentElement), st(e.closest("label"))];
      const changed = base ? now.some((v, i) => v !== base[i]) : null;
      const s = getComputedStyle(e);
      const outline =
        s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const r = e.getBoundingClientRect();
      const label = e.closest("label");
      const lr = label?.getBoundingClientRect();
      const shownBox = r.width >= 4 && r.height >= 4 ? r : (lr ?? r);
      const inView =
        shownBox.bottom > 0 &&
        shownBox.top < innerHeight &&
        shownBox.right > 0 &&
        shownBox.left < innerWidth;
      return {
        id,
        tag: e.tagName.toLowerCase(),
        name: (
          e.getAttribute("aria-label") ||
          e.innerText ||
          e.value ||
          e.closest("label")?.innerText ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60),
        focusVisible: e.matches(":focus-visible"),
        indicator:
          changed === null ? outline || s.boxShadow !== "none" : changed,
        inView,
        y: Math.round(shownBox.top),
        x: Math.round(shownBox.left),
        inModal: !!e.closest("dialog[open]"),
      };
    });
    if (info.body) {
      bodyHits++;
      stops.push({ body: true });
      if (bodyHits > 1) break;
      continue;
    }
    if (first === null) first = info.id;
    else if (info.id === first) break;
    stops.push(info);
  }
  const reached = new Set(stops.filter((s) => s.id).map((s) => s.id));
  const order = stops.filter((s) => s.id).map((s) => Number(s.id));
  let backwards = 0;
  for (let i = 1; i < order.length; i++)
    if (order[i] < order[i - 1]) backwards++;
  const unreachedIds = setup.expected.filter((id) => !reached.has(id));
  const unreached = unreachedIds.length
    ? await page.evaluate(
        (ids) =>
          ids.slice(0, 30).map((id) => {
            const e = document.querySelector(`[data-w3tab="${id}"]`);
            return e
              ? {
                  tag: e.tagName.toLowerCase(),
                  cls: e.className?.toString().slice(0, 60),
                  name: (e.getAttribute("aria-label") || e.innerText || "")
                    .trim()
                    .slice(0, 60),
                }
              : { id };
          }),
        unreachedIds,
      )
    : [];
  return {
    expected: setup.expected.length,
    stops: stops.length,
    cycled: stops.length < max,
    truncated: stops.length >= max,
    domOrderBackwards: backwards,
    noIndicator: stops
      .filter((s) => s.id && !s.indicator)
      .map((s) => `${s.tag}:${s.name}`)
      .slice(0, 30),
    noIndicatorCount: stops.filter((s) => s.id && !s.indicator).length,
    offscreen: stops
      .filter((s) => s.id && !s.inView)
      .map((s) => `${s.tag}:${s.name}`)
      .slice(0, 20),
    unreached,
    unreachedCount: unreachedIds.length,
    sequence: stops
      .slice(0, 60)
      .map((s) => (s.body ? "<body>" : `${s.tag}:${s.name}`)),
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
const SIZES = {
  "1280x880": { w: 1280, h: 880, zoom: 1 },
  "1024x768": { w: 1024, h: 768, zoom: 1 },
  "900x800": { w: 900, h: 800, zoom: 1 },
  "899x800": { w: 899, h: 800, zoom: 1 },
  "560x720": { w: 560, h: 720, zoom: 1 },
  zoom150: { w: 1280, h: 880, zoom: 1.5 },
  zoom200: { w: 1280, h: 880, zoom: 2 },
};
let currentZoom = 1;
async function setSize(app, page, size) {
  const s = SIZES[size];
  if (s.zoom !== currentZoom) {
    await app.evaluate(
      ({ BrowserWindow }, z) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z),
      s.zoom,
    );
    currentZoom = s.zoom;
  }
  await page.setViewportSize({ width: s.w, height: s.h });
  await settle(page, 250);
}
let currentTheme = null;
async function setTheme(page, theme) {
  if (theme === currentTheme) return;
  await command(page, { type: "theme", theme });
  await expect(page.locator(`html[data-theme="${theme}"]`)).toHaveCount(1);
  currentTheme = theme;
  await settle(page, 150);
}
/**
 * Screenshot and measure the current view. Full tier adds accessible names
 * and a Tab walk; the Tab walk moves focus, so it runs last.
 */
async function inspect(
  page,
  { destination, state, theme, size, full = false, note = null },
) {
  const name = `${slug(destination)}-${slug(state)}-${theme}-${size}`;
  const file = path.join(EVIDENCE, `${name}.png`);
  const entry = {
    name,
    destination,
    state,
    theme,
    size,
    note,
    screenshot: file,
  };
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page, 150);
    // What the owner sees; a full-page capture as well when the page scrolls
    // (it draws the fixed sidebar only over the first viewport height).
    await page.screenshot({ path: file });
    Object.assign(entry, await page.evaluate(inPageAudit));
    if (entry.overflow.pageHeight > entry.viewport.innerHeight * 1.1) {
      entry.fullScreenshot = file.replace(/\.png$/, "-full.png");
      await page.screenshot({ path: entry.fullScreenshot, fullPage: true });
    }
    if (full) {
      entry.names = await unnamedControls(page);
      entry.tab = await tabWalk(page);
      await page.evaluate(() => document.activeElement?.blur?.());
    }
  } catch (error) {
    entry.error = String(error?.message ?? error).slice(0, 600);
  }
  phase.views.push(entry);
  const flags = [
    entry.overflow?.page > 0 && `overflow ${entry.overflow.page}`,
    entry.clippedCount && `clipped ${entry.clippedCount}`,
    entry.overlaps?.length && `overlaps ${entry.overlaps.length}`,
    entry.occluded?.length && `occluded ${entry.occluded.length}`,
    entry.contrast?.failureCount && `contrast ${entry.contrast.failureCount}`,
    entry.names?.unnamed?.length && `unnamed ${entry.names.unnamed.length}`,
    entry.tab?.noIndicatorCount && `no-focus ${entry.tab.noIndicatorCount}`,
    entry.tab?.unreachedCount && `unreached ${entry.tab.unreachedCount}`,
    entry.error && `ERROR ${entry.error.slice(0, 80)}`,
  ].filter(Boolean);
  console.log(`VIEW ${name}${flags.length ? " · " + flags.join(" · ") : ""}`);
  await save();
  return entry;
}
/** Visible guidance on the page: headings, statuses, alerts, notes and primary actions. */
const guidance = (page) =>
  page.evaluate(() => {
    const shown = (e) => {
      const r = e.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        !e.closest("[hidden]") &&
        getComputedStyle(e).visibility !== "hidden"
      );
    };
    const t = (e) => e.innerText.trim().replace(/\s+/g, " ").slice(0, 240);
    const pick = (sel) =>
      [...document.querySelectorAll(sel)].filter(shown).map(t).filter(Boolean);
    return {
      h1: pick("h1"),
      statuses: pick(
        "[role=status], [role=alert], [role=note], .session-attention, .info-strip, .empty-row, .notice",
      ),
      primary: pick("button.primary:not(:disabled)"),
      disabledPrimary: pick("button.primary:disabled"),
      breadcrumb: pick(".topbar > span"),
    };
  });
async function walk(page, stepName, judge, extra = {}) {
  const g = await guidance(page);
  const file = path.join(
    EVIDENCE,
    `firstrun-${String(phase.walkthrough.length + 1).padStart(2, "0")}-${slug(stepName)}-paper-1280x880.png`,
  );
  await page.screenshot({ path: file });
  phase.walkthrough.push({
    step: stepName,
    guidance: g,
    judge,
    screenshot: file,
    ...extra,
  });
  await save();
}

// ---------------------------------------------------------------------------
// Keyboard, IME and clipboard
// ---------------------------------------------------------------------------
/** Opens a Topsl modal from its opener by keyboard and checks focus handling. */
async function modalCheck(
  page,
  { name, opener, dialog, openWith = "Enter", tabs = 30, closeWith = "Escape" },
) {
  const result = { name };
  await opener.focus();
  const openerId = await opener.evaluate((e) => {
    e.dataset.w3opener = "1";
    return true;
  });
  await page.keyboard.press(openWith);
  await expect(dialog).toBeVisible({ timeout: 20000 });
  await settle(page, 200);
  result.focusInsideOnOpen = await dialog.evaluate((d) =>
    d.contains(document.activeElement),
  );
  result.initialFocus = await page.evaluate(() => {
    const e = document.activeElement;
    return e
      ? `${e.tagName.toLowerCase()}:${(e.getAttribute("aria-label") || e.innerText || "").trim().slice(0, 40)}`
      : null;
  });
  let escaped = 0;
  for (let i = 0; i < tabs; i++) {
    await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
    const inside = await dialog.evaluate(
      (d) =>
        d.contains(document.activeElement) ||
        document.activeElement === document.body,
    );
    if (!inside) escaped++;
  }
  result.focusEscapedSteps = escaped;
  await page.keyboard.press(closeWith);
  await settle(page, 300);
  result.closedByEscape = !(await dialog.isVisible().catch(() => false));
  result.focusReturnedToOpener = await page.evaluate(
    () => document.activeElement?.dataset?.w3opener === "1",
  );
  result.focusAfterClose = await page.evaluate(() => {
    const e = document.activeElement;
    return e
      ? `${e.tagName.toLowerCase()}:${(e.getAttribute("aria-label") || e.innerText || "").trim().slice(0, 40)}`
      : null;
  });
  await page.evaluate(() =>
    document
      .querySelectorAll("[data-w3opener]")
      .forEach((e) => delete e.dataset.w3opener),
  );
  void openerId;
  phase.interactions.push({ kind: "modal", ...result });
  console.log(`MODAL ${name} ${JSON.stringify(result)}`);
  await save();
  return result;
}
/** Composition with the platform IME event stream; Enter arrives as an IME key (229). */
async function imeCompose(cdp, partial, committed, modifiers = 0) {
  await cdp.send("Input.imeSetComposition", {
    text: partial,
    selectionStart: partial.length,
    selectionEnd: partial.length,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    key: "Enter",
    code: "Enter",
    modifiers,
  });
  await cdp.send("Input.insertText", { text: committed });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
    modifiers,
  });
}
async function imeCheck(
  page,
  app,
  { name, field, submitTypes, modifiers = 0, control = null },
) {
  const cdp = await page.context().newCDPSession(page);
  const result = { name, modifiers };
  try {
    await field.click();
    await field.fill("");
    await field.focus();
    const before = await callCount(app);
    await imeCompose(cdp, "zhong", "中文 🚀", modifiers);
    await settle(page, 700);
    const sent = (await callsSince(app, before)).filter((c) =>
      submitTypes.includes(c.type),
    );
    result.submittedDuringComposition = sent.length;
    result.submittedText = sent.map((c) => c.text ?? null);
    result.value = await field
      .inputValue({ timeout: 3000 })
      .catch(() => "(field gone: the screen changed)");
    result.valueKept = result.value.includes("中文 🚀");
    if (control) {
      const after = await callCount(app);
      await page.keyboard.press(control);
      await settle(page, 700);
      result.control = control;
      result.submittedByPlainKey = (await callsSince(app, after)).filter((c) =>
        submitTypes.includes(c.type),
      ).length;
    }
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 400);
  } finally {
    await cdp.detach().catch(() => {});
  }
  phase.interactions.push({ kind: "ime", ...result });
  console.log(`IME ${name} ${JSON.stringify(result)}`);
  await save();
  return result;
}
async function clipboardCheck(page, app, { name, target, copyButton = null }) {
  const result = { name };
  await app.evaluate(({ clipboard }) => clipboard.writeText("w3-sentinel"));
  if (copyButton) {
    await copyButton.click();
    await settle(page, 300);
  } else {
    await target.scrollIntoViewIfNeeded();
    await target.click({ clickCount: 3 });
    result.selection = await page.evaluate(() =>
      getSelection().toString().slice(0, 200),
    );
    await page.keyboard.press("Meta+c");
    await settle(page, 300);
  }
  result.expected = (await target.innerText()).trim().slice(0, 200);
  result.clipboard = (
    await app.evaluate(({ clipboard }) => clipboard.readText())
  ).slice(0, 200);
  result.copied =
    result.clipboard !== "w3-sentinel" && result.clipboard.trim().length > 0;
  result.matches =
    result.clipboard.trim() === result.expected ||
    result.expected.startsWith(result.clipboard.trim().slice(0, 40));
  phase.interactions.push({ kind: "clipboard", ...result });
  console.log(
    `CLIPBOARD ${name} copied=${result.copied} matches=${result.matches}`,
  );
  await page.evaluate(() => getSelection().removeAllRanges());
  await save();
  return result;
}
/** Holds a read's reply, screenshots the loading state, then releases it. */
async function loadingState(
  page,
  app,
  {
    destination,
    types,
    away,
    open,
    theme = "paper",
    size = "1280x880",
    reveal = null,
  },
) {
  const rule = `hold-${slug(destination)}`;
  // The screen must mount afresh: some stay mounted while hidden.
  await away();
  await settle(page, 1200);
  await addRule(app, { name: rule, types, hold: true, remaining: 3 });
  let openError = null;
  const opening = open().catch(
    (e) => (openError = String(e?.message ?? e).slice(0, 300)),
  );
  await Promise.race([opening, page.waitForTimeout(4000)]);
  await page.waitForTimeout(800);
  if (reveal) await reveal().catch(() => {});
  const g = await guidance(page);
  const shotFile = path.join(
    EVIDENCE,
    `${slug(destination)}-loading-${theme}-${size}.png`,
  );
  await page.screenshot({ path: shotFile });
  const released = await releaseRule(app, rule);
  await settle(page, 600);
  phase.interactions.push({
    kind: "loading",
    destination,
    types,
    heldReplies: released,
    openError,
    visibleWhileHeld: g,
    screenshot: shotFile,
  });
  console.log(
    `LOADING ${destination} held=${released} statuses=${JSON.stringify(g.statuses).slice(0, 200)}`,
  );
  await save();
}
/** Fails a read once, screenshots the failed state and what it offers. */
async function failedState(
  page,
  app,
  {
    destination,
    types,
    away,
    open,
    theme = "paper",
    size = "1280x880",
    remaining = 3,
    afterRelease = null,
    reveal = null,
  },
) {
  const rule = `fail-${slug(destination)}`;
  await away();
  await settle(page, 1200);
  await addRule(app, {
    name: rule,
    types,
    failWith: "Synthetic read failure from the inspection harness.",
    remaining,
  });
  let openError = null;
  await open().catch(
    (e) => (openError = String(e?.message ?? e).slice(0, 300)),
  );
  await page.waitForTimeout(1200);
  if (reveal) await reveal().catch(() => {});
  const g = await guidance(page);
  const shotFile = path.join(
    EVIDENCE,
    `${slug(destination)}-failed-${theme}-${size}.png`,
  );
  await page.screenshot({ path: shotFile });
  const retry = await page.getByRole("button", { name: /Retry/ }).count();
  const failedReplies = await app.evaluate(
    (_, rule) =>
      globalThis.__w3.calls.filter((c) => c.failedBy === rule).length,
    rule,
  );
  await releaseRule(app, rule);
  // Does the screen recover on its own once reads succeed again?
  const recovery = afterRelease
    ? await afterRelease().catch((e) => ({
        error: String(e?.message ?? e).slice(0, 200),
      }))
    : null;
  phase.interactions.push({
    kind: "failed",
    destination,
    types,
    failedReplies,
    openError,
    visible: g,
    retryButtons: retry,
    recovery,
    screenshot: shotFile,
  });
  console.log(
    `FAILED ${destination} retry=${retry} statuses=${JSON.stringify(g.statuses).slice(0, 200)}`,
  );
  await save();
}
const confirmations = async (app) =>
  app.evaluate(() => globalThis.w3?.confirmations ?? []);

// ---------------------------------------------------------------------------
// Phase: first run
// ---------------------------------------------------------------------------
async function firstRun() {
  startPhase("firstrun");
  const profile = await mkdtemp(
    path.join(os.tmpdir(), "topsl-test-w3-firstrun-"),
  );
  const qualify = await mkdtemp(
    path.resolve("node_modules/.cache/topsl-qualify-"),
  );
  await mkdir(path.join(profile, "claude-config", "projects"), {
    recursive: true,
  });
  await mkdir(path.join(profile, "native-home", ".codex"), { recursive: true });
  const project = await gitProject(path.join(profile, "harbor-app"));
  const codex = await codexStandIn(profile, 40);
  const { app, page } = await launch(profile, {
    TOPSL_TEST_QUALIFICATION_DIR: qualify,
  });
  try {
    await mockDialogs(app, project);
    await installInterceptor(app);
    await page.setViewportSize({ width: 1280, height: 880 });
    currentTheme = null;
    currentZoom = 1;
    await settle(page, 500);
    await walk(
      page,
      "launch",
      "Fresh profile: does the first screen say what to do first?",
    );
    await inspect(page, {
      destination: "projects",
      state: "empty",
      theme: "default",
      size: "1280x880",
      full: true,
    });
    await step(
      "first run: add a project from the visible call to action",
      async () => {
        await page
          .getByRole("button", { name: "+ Add folder", exact: true })
          .click();
        await expect(
          page.getByRole("region", { name: "New session" }),
        ).toBeVisible();
        await settle(page, 1500);
        await walk(
          page,
          "project added",
          "After adding a folder: is the next step (a provider) explained?",
        );
      },
      page,
    );
    await step(
      "first run: follow the guidance to Providers",
      async () => {
        const open = page.getByRole("button", { name: "Open Providers" });
        const visible = await open.isVisible();
        if (visible) await open.click();
        else await navigate(page, "Providers");
        await expect(
          page.getByRole("heading", { name: "Providers", level: 1 }),
        ).toBeVisible();
        await walk(
          page,
          "providers empty",
          "Providers in a fresh test profile: is it clear how to get a runtime ready?",
          { followedVisibleLink: visible },
        );
      },
      page,
    );
    await step(
      "first run: locate the Codex runtime",
      async () => {
        await setOpen(app, codex, 1);
        await page
          .getByRole("button", { name: "Locate a runtime", exact: true })
          .click();
        await expect(
          page
            .locator("article.application-card")
            .filter({ hasText: "Codex" })
            .locator(".installation"),
        ).toBeVisible({ timeout: 20000 });
        await walk(
          page,
          "runtime located",
          "A located runtime: does the card say Trust is next?",
        );
      },
      page,
    );
    await step(
      "first run: trust, connect and qualify through the card",
      async () => {
        const card = page
          .locator("article.application-card")
          .filter({ hasText: "Codex" });
        await card.getByRole("button", { name: "Trust executable" }).click();
        await expect(
          card.getByRole("button", { name: "Connect / test" }),
        ).toBeVisible({ timeout: 20000 });
        await walk(
          page,
          "runtime trusted",
          "Trusted: is Connect / test clearly the next step?",
        );
        await card.getByRole("button", { name: "Connect / test" }).click();
        const dialog = page.getByRole("dialog", { name: "Native connection" });
        await expect(dialog).toBeVisible({ timeout: 30000 });
        await walk(
          page,
          "connection dialog",
          "Native connection dialog: is the outcome readable?",
        );
        await dialog.getByRole("button", { name: "Close dialog" }).click();
        const q = page.getByRole("region", { name: "Codex qualification" });
        await walk(
          page,
          "before qualification",
          "Qualification block: is Qualify explained and visible?",
        );
        await q.getByRole("button", { name: "Qualify Codex runtime" }).click();
        await expect(q.locator(".badge")).toHaveText("Qualified", {
          timeout: 90000,
        });
        await walk(
          page,
          "qualified",
          "After qualifying: does the page lead back to starting work?",
        );
      },
      page,
    );
    await step(
      "first run: return to the project and start work with a required check",
      async () => {
        // The owner returns through the sidebar's New session button.
        await page
          .getByRole("button", { name: "New session", exact: true })
          .first()
          .click();
        const home = page.getByRole("region", { name: "New session" });
        await expect(home).toBeVisible();
        await settle(page, 2500);
        await walk(
          page,
          "new session ready",
          "Ready provider: does New session invite a first message?",
        );
        await home.getByRole("radio", { name: "Work", exact: true }).check();
        await home.locator("details.composer-options-panel > summary").click();
        await home.getByLabel("Check name").fill("Fixture check passes");
        await home
          .getByLabel("Executable (absolute path)")
          .fill("/usr/bin/true");
        await home
          .getByRole("textbox", { name: "Message" })
          .fill("Change the value to two in file.ts.");
        await walk(
          page,
          "composed",
          "Composed a Work message with a required check: is Start session obvious?",
        );
        await home
          .getByRole("button", { name: "Start session", exact: true })
          .click();
        const thread = page.getByRole("region", {
          name: "Session",
          exact: true,
        });
        await expect(
          thread.getByRole("article", { name: /^Goal / }),
        ).toBeVisible({ timeout: 60000 });
        await settle(page, 800);
        await walk(
          page,
          "goal running",
          "Goal started: does the card say what is happening and what comes next?",
        );
      },
      page,
    );
    await step(
      "first run: resolve the blocker the goal reports",
      async () => {
        const thread = page.getByRole("region", {
          name: "Session",
          exact: true,
        });
        const goal = thread.getByRole("article", { name: /^Goal / });
        await expect(goal.getByText(/Needs you/)).toBeVisible({
          timeout: 180000,
        });
        await walk(
          page,
          "needs you: checks",
          "Blocked on a required check: does the card say what to do?",
        );
        await goal
          .getByRole("button", { name: "Prepare checks for this candidate" })
          .click();
        await goal.getByRole("button", { name: /^Run .*…$/ }).click();
        await expect(
          goal.getByRole("button", { name: "Accept candidate…" }),
        ).toBeVisible({ timeout: 120000 });
        await walk(
          page,
          "needs you: accept",
          "Awaiting acceptance: is the decision and its effect explained?",
        );
        await goal.getByRole("button", { name: "Accept candidate…" }).click();
        await expect(goal.getByText("Accepted", { exact: true })).toBeVisible({
          timeout: 60000,
        });
        await walk(
          page,
          "accepted",
          "Accepted: does the page say the folder is unchanged and how to apply?",
        );
      },
      page,
    );
    await step(
      "first run: review results",
      async () => {
        const thread = page.getByRole("region", {
          name: "Session",
          exact: true,
        });
        await thread
          .getByRole("group", { name: "Thread panes" })
          .getByRole("button", { name: /^Results/ })
          .click();
        const results = thread.getByRole("complementary", {
          name: "Results details",
        });
        await expect(results).toBeVisible();
        await walk(
          page,
          "results review",
          "Results pane: are review, checks and changes understandable?",
        );
        await results.getByRole("tab", { name: "Changes" }).click();
        await walk(
          page,
          "results changes",
          "Results → Changes: can the owner see what changed?",
        );
      },
      page,
    );
    await step(
      "first run: start other work, then return to the earlier session",
      async () => {
        await page
          .getByRole("button", { name: "New session", exact: true })
          .first()
          .click();
        const home = page.getByRole("region", { name: "New session" });
        await home.getByRole("radio", { name: "Discuss", exact: true }).check();
        await home
          .getByRole("textbox", { name: "Message" })
          .fill("Where is the value kept?");
        await home
          .getByRole("button", { name: "Start session", exact: true })
          .click();
        await expect(
          page.getByRole("heading", {
            name: "Where is the value kept?",
            level: 1,
          }),
        ).toBeVisible({ timeout: 30000 });
        await settle(page, 2000);
        await walk(
          page,
          "second session",
          "A second session: is the earlier one still findable in navigation?",
        );
        const list = page.getByRole("list", { name: "harbor-app sessions" });
        const earlier = list.getByRole("button", {
          name: /Change the value to two/,
        });
        await earlier.click();
        await expect(
          page
            .getByRole("region", { name: "Session", exact: true })
            .getByRole("article", { name: /^Goal / }),
        ).toBeVisible();
        await walk(
          page,
          "returned",
          "Returned to the earlier session: is its outcome clear at a glance?",
        );
      },
      page,
    );
    phase.confirmations = await confirmations(app);
  } finally {
    await app.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
    rmSync(qualify, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase: dense profile
// ---------------------------------------------------------------------------
async function dense() {
  startPhase("dense");
  const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-w3-dense-"));
  await mkdir(path.join(profile, "claude-config", "projects"), {
    recursive: true,
  });
  await mkdir(path.join(profile, "native-home", ".codex"), { recursive: true });
  const folder = path.join(profile, "Atlas 项目 dense survey 🧭");
  await mkdir(folder);
  const { app, page } = await launch(profile);
  try {
    await mockDialogs(app, folder);
    await installInterceptor(app);
    await page.setViewportSize({ width: 1280, height: 880 });
    currentTheme = null;
    currentZoom = 1;
    let projectId;
    await step(
      "dense: add project and 205 sessions",
      async () => {
        await page
          .getByRole("button", { name: "+ Add folder", exact: true })
          .click();
        await expect(
          page.getByRole("region", { name: "New session" }),
        ).toBeVisible();
        projectId = (await command(page, { type: "navigation-query" }))
          .projectId;
        await page.evaluate(
          async ({ projectId, unicode, token }) => {
            for (let i = 0; i < 205; i++)
              await window.topsl.command({
                type: "session-create",
                projectId,
                kind: "code",
                mode: "discuss",
                text:
                  i === 3
                    ? `Survey leg ${String(i).padStart(3, "0")} ${unicode}`
                    : i === 4
                      ? `Survey leg ${String(i).padStart(3, "0")} ${token}`
                      : `Survey leg ${String(i).padStart(3, "0")} · channel ${i % 7}`,
                commandId: `w3-dense-${i}`,
              });
          },
          { projectId, unicode: UNICODE_LINE, token: LONG_TOKEN },
        );
      },
      page,
    );
    await step(
      "dense: blocked session (no provider can answer)",
      async () => {
        await selectProject(page, "Atlas 项目 dense survey 🧭");
        await expect(
          page.getByRole("region", { name: "Session", exact: true }),
        ).toBeVisible();
        await settle(page, 1500);
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "session",
            state: "blocked-no-provider",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
      },
      page,
    );
    await step(
      "dense: All sessions paging and search",
      async () => {
        await setTheme(page, "paper");
        await navigate(page, "All sessions");
        const index = page.getByRole("region", { name: "All sessions" });
        await expect(index).toContainText("205 sessions");
        await inspect(page, {
          destination: "all-sessions",
          state: "dense-first-page",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
        for (let shown = 50; shown < 205; shown += 50)
          await index
            .getByRole("button", { name: `Show more (${shown} of 205)` })
            .click();
        await expect(index.getByRole("listitem")).toHaveCount(205);
        await inspect(page, {
          destination: "all-sessions",
          state: "dense-all-pages",
          theme: "paper",
          size: "1280x880",
        });
        const search = index
          .getByRole("searchbox", { name: "Search sessions" })
          .or(index.getByRole("textbox", { name: "Search sessions" }));
        await search.fill("survey leg 004");
        await index
          .getByRole("button", { name: "Search", exact: true })
          .click();
        await expect(index).toContainText("1 matching session");
        await inspect(page, {
          destination: "all-sessions",
          state: "search-long-token",
          theme: "paper",
          size: "1280x880",
        });
        await search.fill("no such harbor 🦑");
        await index
          .getByRole("button", { name: "Search", exact: true })
          .click();
        await settle(page, 800);
        await inspect(page, {
          destination: "all-sessions",
          state: "search-empty",
          theme: "paper",
          size: "1280x880",
        });
        await imeCheck(page, app, {
          name: "All sessions search",
          field: search,
          submitTypes: ["project-threads-page"],
          control: "Enter",
        });
        await search.fill("");
        await index
          .getByRole("button", { name: "Search", exact: true })
          .click();
      },
      page,
    );
    await step(
      "dense: loading and failed All sessions",
      async () => {
        const away = () => navigate(page, "Project settings");
        await loadingState(page, app, {
          destination: "all-sessions",
          types: ["project-threads-page"],
          away,
          open: () => navigate(page, "All sessions"),
        });
        await failedState(page, app, {
          destination: "all-sessions",
          types: ["project-threads-page"],
          away,
          open: () => navigate(page, "All sessions"),
        });
      },
      page,
    );
    await step(
      "dense: sizes and themes for the dense sidebar and All sessions",
      async () => {
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          for (const size of ["1024x768", "899x800", "560x720", "zoom200"]) {
            await setSize(app, page, size);
            await navigate(page, "All sessions");
            await inspect(page, {
              destination: "all-sessions",
              state: "dense",
              theme,
              size,
            });
          }
          await setSize(app, page, "1280x880");
        }
        await setTheme(page, "paper");
        await setSize(app, page, "560x720");
        await page
          .getByRole("button", { name: "Navigation", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: "Workbench navigation" }),
        ).toBeVisible();
        await inspect(page, {
          destination: "navigation-drawer",
          state: "dense",
          theme: "paper",
          size: "560x720",
          full: true,
        });
        await page.keyboard.press("Escape");
        await setSize(app, page, "1280x880");
      },
      page,
    );
  } finally {
    await app.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase: main populated profile
// ---------------------------------------------------------------------------
async function main() {
  startPhase("main");
  const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-w3-main-"));
  const qualify = await mkdtemp(
    path.resolve("node_modules/.cache/topsl-qualify-"),
  );
  await mkdir(path.join(profile, "claude-config", "projects"), {
    recursive: true,
  });
  await writeFile(path.join(profile, "claude-config", "usage-fixture"), "");
  await mkdir(path.join(profile, "native-home", ".codex"), { recursive: true });
  const projectA = await gitProject(path.join(profile, "inspection-project"));
  const longFolder = path.join(
    profile,
    "Navigator’s Atlas 项目 🚀 — a deliberately long folder name for wrapping checks",
    "nested-directory-with-a-long-name-that-keeps-going",
    "深层目录 · harbor charts 🧭",
  );
  const projectB = await gitProject(longFolder);
  const codex = await codexStandIn(profile, 700);
  const claude = await claudeStandIn(
    profile,
    path.join(profile, "claude-runs.jsonl"),
  );
  const history = await importFile(profile, projectA);
  const { app, page } = await launch(profile, {
    TOPSL_TEST_QUALIFICATION_DIR: qualify,
  });
  const titles = {};
  let projectId = null;
  const thread = () =>
    page.getByRole("region", { name: "Session", exact: true });
  const home = () =>
    page.getByRole("region", { name: "New session", exact: true });
  const paneButton = (name) =>
    thread()
      .getByRole("group", { name: "Thread panes" })
      .getByRole("button", { name: new RegExp(`^${name}`) });
  async function openPane(name) {
    const b = paneButton(name);
    if ((await b.getAttribute("aria-pressed")) !== "true") {
      // Below 1200 px an open pane overlays the header's toggles.
      const open = thread().locator("aside.thread-pane");
      if (await open.count())
        await open.getByRole("button", { name: /^Close / }).click();
      await b.click();
    }
    await expect(
      thread().getByRole("complementary", { name: `${name} details` }),
    ).toBeVisible();
  }
  async function closePanes() {
    const open = thread().locator("aside.thread-pane");
    if (await open.count())
      await open.getByRole("button", { name: /^Close / }).click();
  }
  async function openSession(key, pane = null) {
    await openThread(page, "inspection-project", titles[key]);
    await expect(thread().getByRole("heading", { level: 1 })).toBeVisible();
    await settle(page, 400);
    if (pane) await openPane(pane);
    else await closePanes();
  }
  /** Starts a session from New session with the given coordinators, mode and options. */
  async function startSession(
    key,
    { coordinators = ["Opus (Codex)"], mode = "Work", text, check = null },
  ) {
    await navigate(page, "New session");
    await expect(home()).toBeVisible();
    await settle(page, 400);
    const summary = home().getByRole("button", { name: /^Coordinator:/ });
    if ((await summary.getAttribute("aria-expanded")) !== "true")
      await summary.click();
    const picker = home().getByRole("group", { name: "Coordinators" });
    await expect(picker).toBeVisible();
    for (const c of coordinators)
      await picker
        .getByRole("button", { name: `Add ${c} as a coordinator` })
        .click();
    await home().getByRole("radio", { name: mode, exact: true }).check();
    if (check) {
      const options = home().locator("details.composer-options-panel");
      if ((await options.getAttribute("open")) === null)
        await options.locator("summary").click();
      await home().getByLabel("Check name").fill(check.label);
      await home()
        .getByLabel("Executable (absolute path)")
        .fill(check.executable);
    }
    await home().getByRole("textbox", { name: "Message" }).fill(text);
    await home()
      .getByRole("button", { name: "Start session", exact: true })
      .click();
    await expect(thread()).toBeVisible({ timeout: 30000 });
    await expect(thread().getByRole("heading", { level: 1 })).not.toHaveText(
      "Loading session…",
      { timeout: 30000 },
    );
    titles[key] = (
      await thread().getByRole("heading", { level: 1 }).innerText()
    ).trim();
    return titles[key];
  }
  /** The sidebar's attention text for a session beside the session's own state, now and after a wait. */
  async function trace(key, label, waitMs = 6000) {
    const read = async () =>
      page.evaluate((title) => {
        const row = [...document.querySelectorAll(".thread-row")].find(
          (r) => r.querySelector(".thread-title")?.textContent.trim() === title,
        );
        const card = document.querySelector(
          '[aria-label="Session"] article[aria-label^="Goal "] .badge',
        );
        return {
          sidebarAttention:
            row?.querySelector(".thread-attention")?.textContent.trim() ?? null,
          sidebarTooltip:
            row?.querySelector(".thread-link")?.getAttribute("title") ?? null,
          headerBadge:
            document
              .querySelector('[aria-label="Session"] .thread-header .badge')
              ?.textContent.trim() ?? null,
          goalBadge: card?.textContent.trim() ?? null,
          projectNeedsYou:
            document
              .querySelector(".project-node.selected .count.warm")
              ?.childNodes[0]?.textContent.trim() ?? null,
        };
      }, titles[key]);
    const now = await read();
    await page.waitForTimeout(waitMs);
    const later = await read();
    phase.interactions.push({
      kind: "attention",
      session: titles[key],
      label,
      now,
      after: { waitMs, ...later },
    });
    console.log(
      `ATTENTION ${label} now=${JSON.stringify(now)} later=${JSON.stringify(later)}`,
    );
  }
  const views = []; // recipes swept across themes and sizes later
  const recipe = (destination, state, open) =>
    views.push({ destination, state, open });
  try {
    await mockDialogs(app, projectA);
    await installInterceptor(app);
    await page.setViewportSize({ width: 1280, height: 880 });
    currentTheme = null;
    currentZoom = 1;
    await setTheme(page, "paper");

    await step(
      "main: add projects through Projects",
      async () => {
        await page
          .getByRole("button", { name: "+ Add folder", exact: true })
          .click();
        await expect(home()).toContainText("inspection-project");
        projectId = (await command(page, { type: "navigation-query" }))
          .projectId;
        await setOpen(app, projectB);
        await navigate(page, "Projects");
        await page
          .getByRole("button", { name: "+ Add folder", exact: true })
          .click();
        await expect(home()).toBeVisible();
        await selectProject(page, "inspection-project");
      },
      page,
    );
    await step(
      "main: locate, trust and connect the stand-ins (setup)",
      async () => {
        for (const [file, runtime] of [
          [codex, 1],
          [claude, 2],
        ]) {
          await setOpen(app, file, runtime);
          const located = await command(page, { type: "select-runtime" });
          await expect
            .poll(async () =>
              (await command(page, { type: "state" })).installations.some(
                (i) => i.id === located.id,
              ),
            )
            .toBe(true);
          await command(page, { type: "trust-installation", id: located.id });
          if (runtime === 1) {
            await command(page, { type: "runtime-connect", id: located.id });
            await command(page, { type: "runtime-models", id: located.id });
          }
        }
      },
      page,
    );
    await step(
      "main: New session with unqualified providers",
      async () => {
        await navigate(page, "New session");
        await home()
          .getByRole("button", { name: /^Coordinator:/ })
          .click();
        await expect(
          home().getByRole("region", { name: "Codex coordinator models" }),
        ).toContainText("Not qualified yet", { timeout: 30000 });
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "new-session",
            state: "unqualified",
            theme,
            size: "1280x880",
            full: true,
          });
        }
        await setTheme(page, "paper");
        for (const size of ["1024x768", "899x800", "560x720"]) {
          await setSize(app, page, size);
          await inspect(page, {
            destination: "new-session",
            state: "unqualified",
            theme: "paper",
            size,
          });
        }
        await setSize(app, page, "1280x880");
      },
      page,
    );
    await step(
      "main: Providers before qualification and loading/failed reads",
      async () => {
        await navigate(page, "Providers");
        await settle(page, 800);
        await inspect(page, {
          destination: "providers",
          state: "unqualified",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
        const away = () => navigate(page, "Projects");
        const reveal = () =>
          page
            .getByRole("region", { name: "Codex qualification" })
            .scrollIntoViewIfNeeded();
        await loadingState(page, app, {
          destination: "providers-qualification",
          types: ["runtime-qualification-query"],
          away,
          reveal,
          open: () => navigate(page, "Providers"),
        });
        await failedState(page, app, {
          destination: "providers-qualification",
          types: ["runtime-qualification-query"],
          away,
          open: () => navigate(page, "Providers"),
          remaining: 4,
          reveal,
          afterRelease: async () => {
            const badge = page
              .getByRole("region", { name: "Codex qualification" })
              .locator(".badge");
            const at = Date.now();
            await page.waitForTimeout(8000);
            await reveal();
            const text = (await badge.innerText()).trim();
            const shotFile = path.join(
              EVIDENCE,
              "providers-qualification-after-failed-read-paper-1280x880.png",
            );
            await page.screenshot({ path: shotFile });
            return {
              waitedMs: Date.now() - at,
              badgeAfterWait: text,
              block: (
                await page
                  .getByRole("region", { name: "Codex qualification" })
                  .innerText()
              ).slice(0, 400),
              screenshot: shotFile,
            };
          },
        });
      },
      page,
    );
    await step(
      "main: qualify Codex through Providers",
      async () => {
        // A failed read above leaves the block unread until Providers mounts again.
        await navigate(page, "Projects");
        await navigate(page, "Providers");
        const q = page.getByRole("region", { name: "Codex qualification" });
        await expect(q.locator(".badge")).toHaveText("Not qualified", {
          timeout: 20000,
        });
        await q
          .getByRole("combobox", { name: "Codex model to qualify" })
          .selectOption("fixture-model");
        await q.getByRole("button", { name: "Qualify Codex runtime" }).click();
        await settle(page, 300);
        await inspect(page, {
          destination: "providers",
          state: "qualifying",
          theme: "paper",
          size: "1280x880",
        });
        await expect(q.locator(".badge")).toHaveText("Qualified", {
          timeout: 90000,
        });
      },
      page,
    );
    await step(
      "main: Claude route, Connect / test dialog and qualification",
      async () => {
        const q = page.getByRole("region", { name: "Claude qualification" });
        await q
          .getByRole("button", { name: "Turn on structured route…" })
          .click();
        const card = page
          .locator("article.application-card")
          .filter({ hasText: "Claude Code" });
        await expect(
          card.getByRole("button", { name: "Connect / test" }),
        ).toBeVisible({ timeout: 20000 });
        // Loading: hold the connection reply.
        await addRule(app, {
          name: "hold-connect",
          types: ["runtime-connect"],
          hold: true,
        });
        await card.getByRole("button", { name: "Connect / test" }).click();
        await page.waitForTimeout(700);
        await inspect(page, {
          destination: "providers",
          state: "connect-pending",
          theme: "paper",
          size: "1280x880",
        });
        await releaseRule(app, "hold-connect");
        const dialog = page.getByRole("dialog", { name: "Native connection" });
        await expect(dialog).toBeVisible({ timeout: 30000 });
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "dialog-native-connection",
            state: "claude",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await dialog.getByRole("button", { name: "Close dialog" }).click();
        await modalCheck(page, {
          name: "Native connection (Connect / test)",
          opener: card.getByRole("button", { name: "Connect / test" }),
          dialog,
        });
        await q
          .getByRole("textbox", { name: "Claude model to qualify" })
          .fill("claude-opus-5-5");
        await q.getByRole("button", { name: "Qualify Claude runtime" }).click();
        await expect(q.locator(".badge")).toHaveText("Qualified", {
          timeout: 90000,
        });
      },
      page,
    );
    await step(
      "main: usage cards refresh",
      async () => {
        const claudeCard = page.getByRole("article", {
          name: "Claude usage remaining",
        });
        const refresh = claudeCard.getByRole("button", {
          name: /Refresh from Claude/,
        });
        if (await refresh.count()) {
          await refresh.click();
          await expect(claudeCard.locator(".badge").first()).not.toHaveText(
            "Reading…",
            { timeout: 30000 },
          );
        }
        const codexCard = page.getByRole("article", {
          name: "Codex usage remaining",
        });
        const codexRefresh = codexCard.getByRole("button", {
          name: /Refresh from Codex/,
        });
        if (await codexRefresh.count()) {
          await codexRefresh.click();
          await settle(page, 2500);
        }
        await settle(page, 800);
        return {
          claude: (await claudeCard.innerText().catch(() => "")).slice(0, 600),
          codex: (await codexCard.innerText().catch(() => "")).slice(0, 600),
        };
      },
      page,
    );
    recipe("providers", "qualified-usage", async () => {
      await navigate(page, "Providers");
      await expect(
        page
          .getByRole("region", { name: "Codex qualification" })
          .locator(".badge"),
      ).toHaveText("Qualified", { timeout: 20000 });
    });
    await step(
      "main: lifecycle review dialog (synthetic plan)",
      async () => {
        await navigate(page, "Providers");
        const card = page
          .locator("article.application-card")
          .filter({ hasText: "Codex" });
        await addRule(app, {
          name: "plan",
          types: ["lifecycle-preview"],
          replyPlan: true,
          remaining: 4,
        });
        const opener = card.getByRole("button", {
          name: "Download",
          exact: true,
        });
        await opener.click();
        const dialog = page.getByRole("dialog", { name: /^Review / });
        await expect(dialog).toBeVisible();
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "dialog-lifecycle-plan",
            state: "synthetic",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await setSize(app, page, "560x720");
        await inspect(page, {
          destination: "dialog-lifecycle-plan",
          state: "synthetic",
          theme: "paper",
          size: "560x720",
        });
        await setSize(app, page, "1280x880");
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await modalCheck(page, {
          name: "Lifecycle plan (Download)",
          opener,
          dialog,
        });
        await releaseRule(app, "plan");
      },
      page,
    );
    await step(
      "main: Providers keyboard path for qualification",
      async () => {
        await navigate(page, "Providers");
        await inspect(page, {
          destination: "providers",
          state: "qualified-usage",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
      },
      page,
    );

    // Sessions in every goal state ---------------------------------------
    await step(
      "main: New session custom team with own role and options",
      async () => {
        await navigate(page, "New session");
        await settle(page, 2500);
        const summary = home().getByRole("button", { name: /^Coordinator:/ });
        if ((await summary.getAttribute("aria-expanded")) !== "true")
          await summary.click();
        const picker = home().getByRole("group", { name: "Coordinators" });
        await expect(
          home()
            .getByRole("region", { name: "Codex coordinator models" })
            .locator(".badge"),
        ).toHaveText("Ready", { timeout: 30000 });
        await picker
          .getByRole("button", {
            name: "Add claude-opus-5-5 (Claude Code) as a coordinator",
          })
          .click();
        await picker
          .getByRole("button", { name: "Add Opus (Codex) as a coordinator" })
          .click();
        await picker
          .getByRole("combobox", { name: "Effort for claude-opus-5-5" })
          .selectOption("high");
        await home()
          .getByRole("radio", { name: "Custom", exact: true })
          .check();
        await home().getByRole("checkbox", { name: "Implementation" }).check();
        const own = home().locator("details.own-role-create");
        if ((await own.getAttribute("open")) === null)
          await own.locator("summary").click();
        await imeCheck(page, app, {
          name: "New session Role title",
          field: home().getByRole("textbox", { name: "Role title" }),
          submitTypes: ["session-create"],
          control: "Enter",
        });
        await home()
          .getByRole("textbox", { name: "Role title" })
          .fill("API writer for the harbor chart service 🧭");
        await home()
          .getByRole("textbox", { name: "What this role does" })
          .fill(
            `Reviews the HTTP handlers against the OpenAPI file at ${LONG_TOKEN}.`,
          );
        await home()
          .getByRole("combobox", { name: "Kind of work" })
          .selectOption("candidate-review");
        await home()
          .getByRole("button", { name: "Add role", exact: true })
          .click();
        const options = home().locator("details.composer-options-panel");
        await options.locator("summary").click();
        await home().getByLabel("Check name").fill("Type check");
        await home()
          .getByLabel("Executable (absolute path)")
          .fill("/usr/local/bin/a-rather-long-path-to/npx");
        await home()
          .getByLabel("Arguments, one per line")
          .fill("tsc\n--noEmit");
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "new-session",
            state: "custom-team-options",
            theme,
            size: "1280x880",
            full: true,
          });
        }
        await setTheme(page, "paper");
        for (const size of [
          "1024x768",
          "900x800",
          "899x800",
          "560x720",
          "zoom150",
          "zoom200",
        ]) {
          await setSize(app, page, size);
          await inspect(page, {
            destination: "new-session",
            state: "custom-team-options",
            theme: "paper",
            size,
          });
        }
        await setSize(app, page, "1280x880");
        const message = home().getByRole("textbox", { name: "Message" });
        await imeCheck(page, app, {
          name: "New session composer (Enter)",
          field: message,
          submitTypes: ["session-create"],
          control: "Enter",
        });
        await imeCheck(page, app, {
          name: "New session composer (Cmd+Enter during composition)",
          field: message,
          submitTypes: ["session-create"],
          modifiers: 4,
        });
        // The Cmd+Enter variant may have started a session; return to the page.
        if (
          await thread()
            .isVisible()
            .catch(() => false)
        ) {
          titles.imeAccident = (
            await thread().getByRole("heading", { level: 1 }).innerText()
          ).trim();
          phase.interactions.push({
            kind: "note",
            text: `Cmd+Enter during composition started session "${titles.imeAccident}".`,
          });
          await navigate(page, "New session");
        }
      },
      page,
    );
    recipe("new-session", "qualified-default", async () => {
      await navigate(page, "New session");
      await expect(home()).toBeVisible();
      const summary = home().getByRole("button", { name: /^Coordinator:/ });
      if ((await summary.getAttribute("aria-expanded")) !== "true")
        await summary.click();
      await expect(
        home().getByRole("group", { name: "Coordinators" }),
      ).toBeVisible();
    });

    await step(
      "main: session S1 discussion with two coordinators",
      async () => {
        await startSession("discuss", {
          coordinators: ["claude-opus-5-5 (Claude Code)", "Opus (Codex)"],
          mode: "Discuss",
          text: "How does file.ts hold its value?",
        });
        const reply = thread()
          .locator("li.turn.coordinator:not(.pending)")
          .filter({ hasText: /Contribution/ });
        await expect(reply).toBeVisible({ timeout: 90000 });
        await reply
          .locator("summary")
          .first()
          .click()
          .catch(() => {});
      },
      page,
    );
    recipe("session", "discussion", async () => {
      await openSession("discuss");
      const reply = thread()
        .locator("li.turn.coordinator:not(.pending)")
        .filter({ hasText: /Contribution/ })
        .locator("details")
        .first();
      if ((await reply.count()) && (await reply.getAttribute("open")) === null)
        await reply.locator("summary").click();
    });

    await step(
      "main: session S2 goal running → awaiting acceptance",
      async () => {
        await startSession("accept", {
          text: "Change the value to two in file.ts.",
        });
        const goal = thread().getByRole("article", { name: /^Goal / });
        await expect(goal).toBeVisible({ timeout: 60000 });
        await inspect(page, {
          destination: "session",
          state: "goal-running",
          theme: "paper",
          size: "1280x880",
        });
        await openPane("Work");
        await inspect(page, {
          destination: "session-work-pane",
          state: "goal-running",
          theme: "paper",
          size: "1280x880",
        });
        await setTheme(page, "night");
        await inspect(page, {
          destination: "session-work-pane",
          state: "goal-running",
          theme: "night",
          size: "1280x880",
        });
        await setTheme(page, "paper");
        await expect(
          goal.getByText("Awaiting acceptance", { exact: true }),
        ).toBeVisible({ timeout: 240000 });
        await closePanes();
        await trace("accept", "awaiting acceptance");
      },
      page,
    );
    await step(
      "main: awaiting acceptance across themes and sizes",
      async () => {
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await openSession("accept");
          await inspect(page, {
            destination: "session",
            state: "awaiting-acceptance",
            theme,
            size: "1280x880",
            full: true,
          });
          for (const size of ["1024x768", "899x800", "560x720", "zoom200"]) {
            await setSize(app, page, size);
            await inspect(page, {
              destination: "session",
              state: "awaiting-acceptance",
              theme,
              size,
            });
          }
          await setSize(app, page, "1280x880");
        }
        await setTheme(page, "paper");
        await openSession("accept", "Results");
        await inspect(page, {
          destination: "session-results-pane",
          state: "awaiting-acceptance",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
      },
      page,
    );
    await step(
      "main: accept the candidate",
      async () => {
        await openSession("accept");
        const goal = thread().getByRole("article", { name: /^Goal / });
        await goal
          .getByRole("button", { name: "Accept candidate…", exact: true })
          .click();
        await expect(goal.getByText("Accepted", { exact: true })).toBeVisible({
          timeout: 60000,
        });
        await trace("accept", "accepted");
      },
      page,
    );
    recipe("session", "accepted", () => openSession("accept"));
    recipe("session-work-pane", "accepted", () =>
      openSession("accept", "Work"),
    );
    recipe("session-team-pane", "accepted", () =>
      openSession("accept", "Team"),
    );
    recipe("session-results-pane", "accepted", async () => {
      await openSession("accept", "Results");
      await thread()
        .getByRole("complementary", { name: "Results details" })
        .getByRole("tab", { name: "Changes" })
        .click();
    });

    await step(
      "main: session S3 required check → needs you → failed",
      async () => {
        await startSession("failed", {
          text: "Change the value to two in file.ts, with a check that fails.",
          check: { label: "Fails on purpose", executable: "/usr/bin/false" },
        });
        const goal = thread().getByRole("article", { name: /^Goal / });
        await expect(
          goal.getByText(/Needs you: run the required checks/),
        ).toBeVisible({ timeout: 240000 });
        await trace("failed", "needs required check", 2500);
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "session",
            state: "blocked-needs-check",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await goal
          .getByRole("button", { name: "Prepare checks for this candidate" })
          .click();
        await goal
          .getByRole("button", { name: "Run Fails on purpose…" })
          .click();
        await settle(page, 3000);
        await expect
          .poll(
            async () =>
              (await goal.innerText()).includes("Fail") ||
              (await goal.innerText()).includes("fail"),
            { timeout: 60000 },
          )
          .toBe(true);
        await trace("failed", "check failed");
        return { card: (await goal.innerText()).slice(0, 800) };
      },
      page,
    );
    recipe("session", "check-failed", () => openSession("failed"));
    recipe("session-results-pane", "check-failed", async () => {
      await openSession("failed", "Results");
      await thread()
        .getByRole("complementary", { name: "Results details" })
        .getByRole("tab", { name: "Checks" })
        .click();
    });

    await step(
      "main: session S4 stopped",
      async () => {
        await startSession("stopped", {
          text: "Add a comment above the value in file.ts.",
        });
        await expect(
          thread().getByRole("article", { name: /^Goal / }),
        ).toBeVisible({ timeout: 60000 });
        await thread()
          .getByRole("group", { name: "Session controls" })
          .getByRole("button", { name: "Stop session" })
          .click();
        await expect(
          thread()
            .getByRole("article", { name: /^Goal / })
            .getByText("Stopped", { exact: true }),
        ).toBeVisible({ timeout: 60000 });
        await trace("stopped", "stopped", 3000);
      },
      page,
    );
    recipe("session", "stopped", () => openSession("stopped"));

    await step(
      "main: session S5 long Unicode message",
      async () => {
        await startSession("unicode", {
          mode: "Discuss",
          text: `${UNICODE_LINE}\n\nPlease explain the path ${LONG_TOKEN} — is it too long?\n\n${"Long paragraph with many words that should wrap neatly across the transcript width without widening the page. ".repeat(12)}`,
        });
        await expect(
          thread()
            .locator("li.turn.coordinator:not(.pending)")
            .filter({ hasText: /Contribution/ }),
        ).toBeVisible({ timeout: 90000 });
      },
      page,
    );
    recipe("session", "long-unicode", () => openSession("unicode"));

    await step(
      "main: session keyboard, selection and clipboard",
      async () => {
        await openSession("discuss");
        await clipboardCheck(page, app, {
          name: "transcript reply text",
          target: thread().locator("li.turn.coordinator .turn-text").first(),
        });
        await clipboardCheck(page, app, {
          name: "transcript user message",
          target: thread().locator("li.turn.user .turn-text").first(),
        });
        const message = thread().getByRole("textbox", { name: "Message" });
        await imeCheck(page, app, {
          name: "Session composer (Enter)",
          field: message,
          submitTypes: ["session-message"],
          control: "Enter",
        });
        await message.fill("");
        // Side panes: open from the keyboard, close with Close, where does focus go?
        const work = paneButton("Work");
        await work.focus();
        await page.keyboard.press("Enter");
        const pane = thread().getByRole("complementary", {
          name: "Work details",
        });
        await expect(pane).toBeVisible();
        const focusInPane = await pane.evaluate((p) =>
          p.contains(document.activeElement),
        );
        await page.keyboard.press("Escape");
        await settle(page, 300);
        const escapeClosed = !(await pane.isVisible());
        if (!escapeClosed) {
          await pane
            .getByRole("button", { name: "Close work details" })
            .focus();
          await page.keyboard.press("Enter");
        }
        await settle(page, 300);
        const after = await page.evaluate(() => {
          const e = document.activeElement;
          return e
            ? `${e.tagName.toLowerCase()}:${(e.getAttribute("aria-label") || e.innerText || "").trim().slice(0, 40)}`
            : null;
        });
        phase.interactions.push({
          kind: "pane",
          name: "Work pane by keyboard",
          focusInPaneOnOpen: focusInPane,
          escapeClosed,
          focusAfterClose: after,
        });
      },
      page,
    );

    // Loops ----------------------------------------------------------------
    const openLoop = async (title) => {
      if (
        await page
          .getByRole("article", { name: `Loop run ${title}`, exact: true })
          .isVisible()
      )
        return;
      await openSession("discuss", "Work");
      const pane = thread().getByRole("complementary", {
        name: "Work details",
      });
      const entry = pane
        .getByRole("region", { name: "Running now", exact: true })
        .or(pane.getByRole("listitem"))
        .filter({ hasText: title })
        .getByRole("button", { name: /Open loop|Review and start/ })
        .first();
      await entry.click();
      await expect(
        page.getByRole("article", { name: `Loop run ${title}`, exact: true }),
      ).toBeVisible();
    };
    await step(
      "main: loops draft, running and stopped",
      async () => {
        await openSession("discuss", "Work");
        const pane = thread().getByRole("complementary", {
          name: "Work details",
        });
        const form = pane.getByRole("region", { name: "Create loop" });
        await form
          .getByRole("button", { name: "Create loop", exact: true })
          .first()
          .click();
        const enable = form.getByRole("button", {
          name: "Turn on experimental Recursive Looping",
          exact: true,
        });
        if (await enable.count()) await enable.click();
        await inspect(page, {
          destination: "session-work-pane",
          state: "create-loop-form",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
        const create = async (text) => {
          const disclosure = form
            .getByRole("button", { name: "Create loop", exact: true })
            .first();
          if ((await disclosure.getAttribute("aria-expanded")) !== "true")
            await disclosure.click();
          await form
            .getByRole("group", { name: "Loop kind" })
            .getByRole("radio", { name: "Goal loop" })
            .check();
          await form.getByRole("textbox", { name: /Goals/ }).fill(text);
          await form
            .getByRole("button", { name: "Create loop", exact: true })
            .last()
            .click();
          await expect(form.getByRole("status")).toContainText(
            "Nothing has started",
          );
        };
        // The first loop runs; a second, created while it runs, waits as a draft.
        titles.loopStopped = "Running loop: change the value to two";
        titles.loopDraft = "Draft loop: change the value to two";
        await create("Running loop: change the value to two.");
        await form
          .getByRole("button", { name: "Open loop", exact: true })
          .click();
        const run = page.getByRole("article", {
          name: `Loop run ${titles.loopStopped}`,
          exact: true,
        });
        await expect(run).toBeVisible();
        await run
          .getByRole("button", { name: "Review and start", exact: true })
          .click();
        await expect(
          run.getByRole("button", { name: "Review and start", exact: true }),
        ).toHaveCount(0, { timeout: 30000 });
        await expect
          .poll(
            async () =>
              (
                await command(page, { type: "loop-query", projectId })
              ).runs.find((r) => r.title === titles.loopStopped)?.state,
            { timeout: 60000 },
          )
          .toMatch(/running|organizing|executing|monitoring/);
        await settle(page, 1500);
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "loop",
            state: "running",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await setSize(app, page, "560x720");
        await inspect(page, {
          destination: "loop",
          state: "running",
          theme: "paper",
          size: "560x720",
        });
        await setSize(app, page, "1280x880");
        await run
          .getByRole("button", { name: "← Back to session", exact: true })
          .click();
        await openPane("Work");
        await inspect(page, {
          destination: "session-work-pane",
          state: "loop-running",
          theme: "paper",
          size: "1280x880",
        });
        await create("Draft loop: change the value to two.");
        await openLoop(titles.loopStopped);
        await run.getByRole("button", { name: "Stop", exact: true }).click();
        await expect
          .poll(
            async () =>
              (
                await command(page, { type: "loop-query", projectId })
              ).runs.find((r) => r.title === titles.loopStopped)?.state,
            { timeout: 90000 },
          )
          .toBe("stopped");
      },
      page,
    );
    recipe("loop", "draft", () => openLoop(titles.loopDraft));
    recipe("loop", "stopped", () => openLoop(titles.loopStopped));

    // Imports, Provider tools, handoff, terminal ----------------------------
    await step(
      "main: Settings → Imports through the UI",
      async () => {
        await setOpen(app, history);
        await navigate(page, "Settings");
        const imports = page.getByRole("region", {
          name: "Imports",
          exact: true,
        });
        await imports
          .getByRole("combobox", { name: "Project", exact: true })
          .selectOption({ label: "inspection-project" });
        await imports.getByRole("button", { name: "Choose file…" }).click();
        const preview = imports.getByRole("article", {
          name: "Import preview",
        });
        await expect(preview).toBeVisible({ timeout: 20000 });
        await preview
          .locator("details > summary")
          .first()
          .click()
          .catch(() => {});
        await inspect(page, {
          destination: "settings-imports",
          state: "preview",
          theme: "paper",
          size: "1280x880",
        });
        await preview
          .getByRole("button", { name: "Import", exact: true })
          .click();
        await expect(
          imports.getByRole("status").filter({ hasText: "Imported" }),
        ).toBeVisible({ timeout: 20000 });
        await imeCheck(page, app, {
          name: "Imports search",
          field: imports.getByRole("textbox", { name: "Search imports" }),
          submitTypes: ["history-imports"],
          control: "Enter",
        });
        await imports.getByRole("textbox", { name: "Search imports" }).fill("");
        await imports
          .getByRole("button", { name: "Search", exact: true })
          .click();
        await imports
          .getByRole("button", { name: "Continue in Topsl" })
          .first()
          .click();
        await expect(
          page.getByRole("region", { name: "Attached reference" }),
        ).toBeVisible({ timeout: 20000 });
      },
      page,
    );
    recipe("new-session", "attached-import", async () => {
      await navigate(page, "Settings");
      const imports = page.getByRole("region", {
        name: "Imports",
        exact: true,
      });
      await imports
        .getByRole("list", { name: "Imported histories" })
        .getByRole("button", { name: "Continue in Topsl" })
        .first()
        .click();
      await expect(
        page.getByRole("region", { name: "Attached reference" }),
      ).toBeVisible({ timeout: 20000 });
      const details = page
        .getByRole("region", { name: "Attached reference" })
        .locator("details");
      if (
        (await details.count()) &&
        (await details.getAttribute("open")) === null
      )
        await details.locator("summary").click();
    });
    recipe("settings", "top", async () => {
      await navigate(page, "Settings");
    });
    recipe("settings-imports", "list", async () => {
      await navigate(page, "Settings");
      await page
        .getByRole("region", { name: "Imports", exact: true })
        .scrollIntoViewIfNeeded();
    });
    await step(
      "main: Provider tools with imported conversation, handoff and terminal",
      async () => {
        await selectProject(page, "inspection-project");
        await navigate(page, "Provider tools");
        const conversation = page.getByRole("combobox", {
          name: "Conversation",
          exact: true,
        });
        const value = await conversation.evaluate(
          (s) => [...s.options].find((o) => o.value)?.value ?? "",
        );
        await conversation.selectOption(value);
        await settle(page, 800);
        await inspect(page, {
          destination: "provider-tools",
          state: "imported-chat",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
        const handoff = page.getByRole("button", { name: "Prepare handoff" });
        await handoff.click();
        const dialog = page.getByRole("dialog", { name: /^Handoff to / });
        await expect(dialog).toBeVisible({ timeout: 20000 });
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "dialog-handoff",
            state: "imported",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await setSize(app, page, "560x720");
        await inspect(page, {
          destination: "dialog-handoff",
          state: "imported",
          theme: "paper",
          size: "560x720",
        });
        await setSize(app, page, "1280x880");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await modalCheck(page, {
          name: "Handoff preview",
          opener: handoff,
          dialog,
        });
        await clipboardCheck(page, app, {
          name: "imported long transcript message",
          target: page.locator(".virtual-message, .message").last(),
        });
        const search = page.getByRole("textbox", {
          name: "Search project history",
        });
        await imeCheck(page, app, {
          name: "Provider tools history search",
          field: search,
          submitTypes: ["history-page"],
          control: "Enter",
        });
        await search.fill("港口");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await settle(page, 800);
        await inspect(page, {
          destination: "provider-tools",
          state: "history-search",
          theme: "paper",
          size: "1280x880",
        });
        // Terminal from the Codex stand-in.
        const state = await command(page, { type: "state" });
        const codexInstall = state.installations.find(
          (i) => i.appId === "openai.codex-cli",
        );
        await page
          .getByRole("combobox", { name: "Runtime", exact: true })
          .selectOption(codexInstall.id);
        await page
          .getByRole("button", { name: "Native terminal", exact: true })
          .click();
        await expect(page.locator(".terminal-panel")).toBeVisible({
          timeout: 20000,
        });
        await expect(page.locator(".terminal-panel")).toContainText(
          "Codex terminal stand-in",
          { timeout: 20000 },
        );
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "provider-tools",
            state: "terminal",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        // Can a keyboard user leave the terminal once focus is in it?
        const input = page.locator(".terminal-panel textarea").first();
        await input.focus();
        const inTerminal = () =>
          page.evaluate(
            () => !!document.activeElement?.closest(".terminal-panel .xterm"),
          );
        const escape = {};
        for (const keys of [
          ["Tab"],
          ["Shift+Tab"],
          ["Escape", "Tab"],
          ["Control+Tab"],
          ["Meta+ArrowDown"],
        ]) {
          await input.focus();
          for (const k of keys) await page.keyboard.press(k);
          escape[keys.join(" then ")] = !(await inTerminal());
        }
        phase.interactions.push({
          kind: "terminal-keyboard",
          leavesTerminal: escape,
        });
        console.log(`TERMINAL ${JSON.stringify(escape)}`);
      },
      page,
    );
    recipe("provider-tools", "terminal-chat", async () => {
      await navigate(page, "Provider tools");
      // Switching projects hides the panel; the page offers it again.
      const again = page.getByRole("button", {
        name: /^Show active native terminal/,
      });
      if (await again.count()) await again.first().click();
      await expect(page.locator(".terminal-panel")).toBeVisible();
    });

    // Project settings and Advanced workflows ------------------------------
    await step(
      "main: Project settings role editor and rename IME",
      async () => {
        await navigate(page, "Project settings");
        const settings = page.getByRole("region", { name: "Project settings" });
        await inspect(page, {
          destination: "project-settings",
          state: "populated",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
        await settings
          .getByRole("button", { name: /^Edit .* default$/ })
          .first()
          .click();
        await settle(page, 500);
        await imeCheck(page, app, {
          name: "Role editor model search",
          field: settings.getByRole("textbox", {
            name: /Search models across providers/,
          }),
          submitTypes: ["orchestration-role-set", "orchestration-policy-set"],
          control: "Enter",
        });
        await settings
          .getByRole("textbox", { name: /Search models across providers/ })
          .fill("");
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "project-settings",
            state: "role-editor",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        const rename = settings.getByRole("button", { name: "Rename" });
        if (await rename.count()) {
          await rename.first().click();
          await imeCheck(page, app, {
            name: "Project settings rename",
            field: settings.getByRole("textbox", { name: "Project name" }),
            submitTypes: ["project-rename"],
          });
          await settings
            .getByRole("button", { name: "Cancel" })
            .first()
            .click();
        }
      },
      page,
    );
    recipe("project-settings", "role-editor", async () => {
      await navigate(page, "Project settings");
      const settings = page.getByRole("region", { name: "Project settings" });
      const edit = settings
        .getByRole("button", { name: /^Edit .* default$/ })
        .first();
      if (await edit.isVisible()) await edit.click();
    });
    await step(
      "main: Advanced workflows populated through commands (setup)",
      async () => {
        const coordination = await command(page, {
          type: "coordination-query",
          projectId,
        });
        const workflow = await command(page, {
          type: "workflow-create",
          requestId: `w3-${Date.now()}`,
          projectId,
          objective: `Unicode fixture coordination ${UNICODE_LINE.slice(0, 40)}`,
          template: "desktop-fixture",
          templateVersion: "1",
        });
        for (const [title, role] of [
          [`Inspect long path ${LONG_TOKEN}`, "planner"],
          ["Second task · 第二个任务 🚀", "tester"],
        ])
          await command(page, {
            type: "task-create",
            requestId: `w3-${title.length}-${Date.now()}`,
            projectId,
            workspaceId: coordination.workspaces[0].id,
            workflowId: workflow.id,
            title,
            role,
            acceptanceCriteria: [
              "Rendered inputs remain scoped",
              "Acceptance remains explicit",
            ],
          });
      },
      page,
    );
    for (const section of [
      "Builder–reviewer",
      "Candidate review",
      "Activity",
      "Context",
      "Workspaces",
    ])
      recipe("advanced-workflows", section, async () => {
        await navigate(page, "Advanced workflows");
        await page
          .getByRole("tablist", { name: "Section" })
          .getByRole("tab", { name: new RegExp(`^${section}`) })
          .click();
        await settle(page, 500);
      });
    await step(
      "main: Advanced workflows sections, task inspector and loading",
      async () => {
        await navigate(page, "Advanced workflows");
        for (const section of [
          "Builder–reviewer",
          "Candidate review",
          "Activity",
          "Context",
          "Workspaces",
        ]) {
          await page
            .getByRole("tablist", { name: "Section" })
            .getByRole("tab", { name: new RegExp(`^${section}`) })
            .click();
          await settle(page, 600);
          await inspect(page, {
            destination: "advanced-workflows",
            state: section,
            theme: "paper",
            size: "1280x880",
            full: true,
          });
        }
        await page
          .getByRole("tablist", { name: "Section" })
          .getByRole("tab", { name: /^Activity/ })
          .click();
        const task = page.getByRole("button", { name: /Second task/ }).first();
        if (await task.count()) {
          await task.click();
          await settle(page, 500);
          await inspect(page, {
            destination: "advanced-workflows",
            state: "task-inspector",
            theme: "paper",
            size: "1280x880",
          });
          await setSize(app, page, "1024x768");
          await inspect(page, {
            destination: "advanced-workflows",
            state: "task-inspector",
            theme: "paper",
            size: "1024x768",
            full: true,
          });
          await setSize(app, page, "1280x880");
        }
        await page
          .getByRole("tablist", { name: "Section" })
          .getByRole("tab", { name: /^Context/ })
          .click();
        const title = page.getByRole("textbox", { name: "Title" }).first();
        if (await title.count())
          await imeCheck(page, app, {
            name: "Shared context Title",
            field: title,
            submitTypes: ["shared-revision-publish"],
          });
      },
      page,
    );

    // Settings: themes through the UI, System following the computer ---------
    await step(
      "main: Settings themes through the UI and System",
      async () => {
        await navigate(page, "Settings");
        const bg = () =>
          page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const out = {};
        for (const theme of ["Night", "Paper", "System"]) {
          await page.getByRole("button", { name: theme, exact: true }).click();
          await expect(
            page.locator(`html[data-theme="${theme.toLowerCase()}"]`),
          ).toHaveCount(1);
          await settle(page, 300);
          out[theme] = await bg();
        }
        currentTheme = "system";
        const buttons = await page
          .locator(".theme-choices button")
          .evaluateAll((bs) =>
            bs.map((b) => ({
              name: b.innerText,
              pressed: b.getAttribute("aria-pressed"),
              current: b.getAttribute("aria-current"),
              primary: b.classList.contains("primary"),
            })),
          );
        await page.emulateMedia({ colorScheme: "dark" });
        await settle(page, 400);
        out.systemDark = await bg();
        await inspect(page, {
          destination: "settings",
          state: "system-dark",
          theme: "system",
          size: "1280x880",
        });
        await page.emulateMedia({ colorScheme: "light" });
        await settle(page, 400);
        out.systemLight = await bg();
        await inspect(page, {
          destination: "settings",
          state: "system-light",
          theme: "system",
          size: "1280x880",
        });
        out.followsDark = out.systemDark === out.Night;
        out.followsLight = out.systemLight === out.Paper;
        phase.interactions.push({
          kind: "system-theme",
          ...out,
          themeButtons: buttons,
        });
        await inspect(page, {
          destination: "settings",
          state: "top",
          theme: "system",
          size: "1280x880",
          full: true,
        });
        // A few destinations under System dark.
        await page.emulateMedia({ colorScheme: "dark" });
        for (const open of [
          async () => openSession("accept"),
          async () => navigate(page, "Providers"),
          async () => navigate(page, "New session"),
        ]) {
          await open();
          await settle(page, 500);
          const h1 = (
            await page.getByRole("heading", { level: 1 }).first().innerText()
          ).trim();
          await inspect(page, {
            destination: slug(h1).slice(0, 30) || "view",
            state: "system-dark",
            theme: "system",
            size: "1280x880",
          });
        }
        await page.emulateMedia({ colorScheme: "light" });
        await setTheme(page, "paper");
        return out;
      },
      page,
    );
    await step(
      "main: Settings auto-accept, Claude route, transcripts",
      async () => {
        await navigate(page, "Settings");
        const auto = page.getByRole("region", { name: "Auto-accept" });
        const choice = auto.getByRole("button").nth(1);
        const before = await callCount(app);
        if (await choice.count()) await choice.click();
        await settle(page, 600);
        const sent = (await callsSince(app, before)).map((c) => c.type);
        await inspect(page, {
          destination: "settings",
          state: "auto-accept-changed",
          theme: "paper",
          size: "1280x880",
        });
        return {
          autoAcceptCommands: sent,
          confirmations: (await confirmations(app)).slice(-3),
        };
      },
      page,
    );
    await step(
      "main: configuration review dialog",
      async () => {
        await navigate(page, "Settings");
        await page
          .getByRole("button", { name: "Project instructions" })
          .click();
        const editor = page.getByRole("textbox", {
          name: "Native configuration text",
        });
        await expect(editor).toBeVisible({ timeout: 20000 });
        await editor.fill(
          `# Inspection project\n\n${UNICODE_LINE}\n\nA proposed instruction line that is long enough to wrap inside the review dialog's two columns without widening it: ${LONG_TOKEN}\n`,
        );
        const opener = page.getByRole("button", { name: "Preview changes" });
        await opener.click();
        const dialog = page.getByRole("dialog", {
          name: "Review configuration change",
        });
        await expect(dialog).toBeVisible({ timeout: 20000 });
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "dialog-configuration-review",
            state: "instructions",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await setSize(app, page, "560x720");
        await inspect(page, {
          destination: "dialog-configuration-review",
          state: "instructions",
          theme: "paper",
          size: "560x720",
        });
        await setSize(app, page, "1280x880");
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await modalCheck(page, {
          name: "Configuration review",
          opener,
          dialog,
        });
      },
      page,
    );

    // Palette, drawer, project menu and Projects --------------------------
    await step(
      "main: command palette and drawer",
      async () => {
        await navigate(page, "Projects");
        const opener = page.getByRole("button", { name: /^Command palette/ });
        const dialog = page.getByRole("dialog", { name: "Command palette" });
        await opener.click();
        await expect(dialog).toBeVisible();
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "dialog-command-palette",
            state: "open",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await page.keyboard.press("Escape");
        await modalCheck(page, {
          name: "Command palette (sidebar button)",
          opener,
          dialog,
        });
        // ⌘K from the composer.
        await navigate(page, "New session");
        const message = home().getByRole("textbox", { name: "Message" });
        await message.fill("draft kept across the palette 🧭");
        await message.focus();
        await page.keyboard.press("Meta+k");
        await expect(dialog).toBeVisible();
        const focusIn = await dialog.evaluate((d) =>
          d.contains(document.activeElement),
        );
        await page.keyboard.press("Escape");
        await settle(page, 300);
        phase.interactions.push({
          kind: "modal",
          name: "Command palette (⌘K from composer)",
          focusInsideOnOpen: focusIn,
          closedByEscape: !(await dialog.isVisible()),
          focusReturnedToOpener: await message.evaluate(
            (e) => e === document.activeElement,
          ),
          draftKept:
            (await message.inputValue()) === "draft kept across the palette 🧭",
        });
        await message.fill("");
        // The compact drawer.
        for (const size of ["899x800", "560x720"]) {
          await setSize(app, page, size);
          const toggle = page.getByRole("button", {
            name: "Navigation",
            exact: true,
          });
          const drawer = page.getByRole("dialog", {
            name: "Workbench navigation",
          });
          await toggle.click();
          await expect(drawer).toBeVisible();
          for (const theme of ["paper", "night"]) {
            await setTheme(page, theme);
            await inspect(page, {
              destination: "navigation-drawer",
              state: "open",
              theme,
              size,
              full: theme === "paper" && size === "560x720",
            });
          }
          await setTheme(page, "paper");
          await page.keyboard.press("Escape");
          await modalCheck(page, {
            name: `Navigation drawer ${size}`,
            opener: toggle,
            dialog: drawer,
            tabs: 40,
          });
        }
        await setSize(app, page, "1280x880");
      },
      page,
    );
    await step(
      "main: project menu by keyboard",
      async () => {
        const button = page.getByRole("button", {
          name: "Project menu for inspection-project",
        });
        await button.focus();
        await page.keyboard.press("Enter");
        const menu = page.getByRole("menu", {
          name: "inspection-project menu",
        });
        await expect(menu).toBeVisible();
        await inspect(page, {
          destination: "project-menu",
          state: "open",
          theme: "paper",
          size: "1280x880",
        });
        const firstFocused = await menu
          .getByRole("menuitem")
          .first()
          .evaluate((e) => e === document.activeElement);
        await page.keyboard.press("Escape");
        phase.interactions.push({
          kind: "menu",
          name: "Project menu",
          firstItemFocused: firstFocused,
          closed: !(await menu.isVisible()),
          focusReturned: await button.evaluate(
            (e) => e === document.activeElement,
          ),
        });
      },
      page,
    );
    recipe("projects", "populated", async () => {
      await navigate(page, "Projects");
    });
    await step(
      "main: Projects path copy",
      async () => {
        await navigate(page, "Projects");
        const card = page.getByRole("article", {
          name: path.basename(longFolder),
          exact: true,
        });
        await clipboardCheck(page, app, {
          name: "Copy path button (long Unicode path)",
          target: card.locator("code.path, .path").first(),
          copyButton: card.getByRole("button", {
            name: /^Copy (folder )?path$/,
          }),
        });
        await clipboardCheck(page, app, {
          name: "Select and copy long path text",
          target: card.locator("code.path, .path").first(),
        });
        const filter = page
          .getByRole("textbox", { name: "Filter projects" })
          .or(page.getByRole("searchbox", { name: "Filter projects" }));
        if (await filter.count()) {
          await imeCheck(page, app, {
            name: "Projects filter",
            field: filter,
            submitTypes: ["project-add"],
          });
          await filter.fill("");
        }
      },
      page,
    );
    recipe("all-sessions", "populated", async () => {
      await selectProject(page, "inspection-project");
      await navigate(page, "All sessions");
    });

    // Loading and failed states of project reads -----------------------------
    await step(
      "main: loading and failed states",
      async () => {
        const toAll = () => navigate(page, "All sessions");
        const toProjects = () => navigate(page, "Projects");
        const remount = async () => {
          await selectProject(page, path.basename(longFolder));
          await settle(page, 800);
          await selectProject(page, "inspection-project");
        };
        await loadingState(page, app, {
          destination: "new-session",
          types: ["orchestration-query"],
          away: toAll,
          open: () => navigate(page, "New session"),
        });
        await loadingState(page, app, {
          destination: "session",
          types: ["session-query", "orchestration-query"],
          away: toAll,
          open: () => openThread(page, "inspection-project", titles.accept),
        });
        await failedState(page, app, {
          destination: "session",
          types: ["session-query"],
          away: toAll,
          open: () => openThread(page, "inspection-project", titles.accept),
          remaining: 6,
        });
        await failedState(page, app, {
          destination: "new-session",
          types: ["orchestration-query"],
          away: toAll,
          open: () => navigate(page, "New session"),
          remaining: 6,
        });
        await loadingState(page, app, {
          destination: "advanced-workflows",
          types: ["scope-snapshot"],
          away: remount,
          open: () => navigate(page, "Advanced workflows"),
        });
        await failedState(page, app, {
          destination: "advanced-workflows",
          types: ["scope-snapshot"],
          away: remount,
          open: () => navigate(page, "Advanced workflows"),
          remaining: 6,
        });
        await loadingState(page, app, {
          destination: "settings-imports",
          types: ["history-imports"],
          away: toProjects,
          open: () => navigate(page, "Settings"),
        });
        await failedState(page, app, {
          destination: "settings-imports",
          types: ["history-imports"],
          away: toProjects,
          open: () => navigate(page, "Settings"),
        });
        await loadingState(page, app, {
          destination: "project-settings",
          types: ["orchestration-query", "scope-snapshot"],
          away: toAll,
          open: () => navigate(page, "Project settings"),
        });
        await failedState(page, app, {
          destination: "project-settings",
          types: ["orchestration-query"],
          away: toAll,
          open: () => navigate(page, "Project settings"),
          remaining: 6,
        });
        await loadingState(page, app, {
          destination: "loop",
          types: ["loop-inspect"],
          away: toAll,
          open: () => openLoop(titles.loopStopped),
        });
        await failedState(page, app, {
          destination: "loop",
          types: ["loop-inspect"],
          away: toAll,
          open: () => openLoop(titles.loopStopped),
          remaining: 6,
        });
        // A failed owner action (not a read): Start session refused.
        await navigate(page, "New session");
        await home()
          .getByRole("textbox", { name: "Message" })
          .fill("This start is refused by the harness.");
        await addRule(app, {
          name: "fail-start",
          types: ["session-create"],
          failWith: "Synthetic refusal: the session could not start.",
        });
        await home()
          .getByRole("button", { name: "Start session", exact: true })
          .click();
        await settle(page, 800);
        await inspect(page, {
          destination: "new-session",
          state: "start-failed",
          theme: "paper",
          size: "1280x880",
        });
        await releaseRule(app, "fail-start");
        await home().getByRole("textbox", { name: "Message" }).fill("");
      },
      page,
    );

    // Sweep every recipe across themes and sizes --------------------------
    await step(
      "main: sweep recipes at 1280x880 in both themes (full)",
      async () => {
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          for (const v of views) {
            try {
              await v.open();
              await settle(page, 400);
              await inspect(page, {
                destination: v.destination,
                state: v.state,
                theme,
                size: "1280x880",
                full: true,
              });
            } catch (error) {
              phase.views.push({
                name: `${v.destination}-${v.state}-${theme}-1280x880`,
                error: String(error?.message ?? error).slice(0, 400),
              });
            }
          }
        }
      },
      page,
    );
    await step(
      "main: sweep recipes across sizes and zoom",
      async () => {
        for (const size of [
          "1024x768",
          "900x800",
          "899x800",
          "560x720",
          "zoom150",
          "zoom200",
        ])
          for (const theme of size.startsWith("zoom")
            ? ["paper"]
            : ["paper", "night"]) {
            await setTheme(page, theme);
            await setSize(app, page, size);
            for (const v of views) {
              try {
                await v.open();
                await settle(page, 300);
                await inspect(page, {
                  destination: v.destination,
                  state: v.state,
                  theme,
                  size,
                });
              } catch (error) {
                phase.views.push({
                  name: `${v.destination}-${v.state}-${theme}-${size}`,
                  error: String(error?.message ?? error).slice(0, 400),
                });
              }
            }
          }
        await setSize(app, page, "1280x880");
        await setTheme(page, "night");
        await setSize(app, page, "zoom200");
        for (const v of views.filter((v) =>
          ["session", "providers", "new-session"].includes(v.destination),
        )) {
          try {
            await v.open();
            await inspect(page, {
              destination: v.destination,
              state: v.state,
              theme: "night",
              size: "zoom200",
            });
          } catch {}
        }
        await setSize(app, page, "1280x880");
        await setTheme(page, "paper");
      },
      page,
    );
    phase.confirmations = await confirmations(app);
    phase.commandCounts = await app.evaluate(() => {
      const counts = {};
      for (const c of globalThis.__w3.calls)
        counts[c.type] = (counts[c.type] ?? 0) + 1;
      return {
        counts,
        refused: globalThis.__w3.calls
          .filter((c) => c.refused)
          .map((c) => c.type),
      };
    });
  } finally {
    await app.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
    rmSync(qualify, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase: loops in a Codex-only profile (scripts/desktop-loop-test.mjs setup)
// ---------------------------------------------------------------------------
async function loops() {
  startPhase("loops");
  const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-w3-loops-"));
  const qualify = await mkdtemp(
    path.resolve("node_modules/.cache/topsl-qualify-"),
  );
  await mkdir(path.join(profile, "claude-config", "projects"), {
    recursive: true,
  });
  await mkdir(path.join(profile, "native-home", ".codex"), { recursive: true });
  const project = await gitProject(path.join(profile, "loop-project"));
  const codex = await codexStandIn(profile, 600);
  const { app, page } = await launch(profile, {
    TOPSL_TEST_QUALIFICATION_DIR: qualify,
  });
  const command_ = (value) => command(page, value);
  const thread = () =>
    page.getByRole("region", { name: "Session", exact: true });
  const runArticle = (title) =>
    page.getByRole("article", { name: `Loop run ${title}`, exact: true });
  const runOf = async (title) =>
    (await command_({ type: "loop-query", projectId })).runs.find(
      (r) => r.title === title,
    );
  let projectId = null;
  async function work() {
    const toggle = thread()
      .getByRole("group", { name: "Thread panes" })
      .getByRole("button", { name: /^Work/ });
    if ((await toggle.getAttribute("aria-pressed")) !== "true")
      await toggle.click();
    return thread().getByRole("complementary", { name: "Work details" });
  }
  async function createLoop(text) {
    const form = (await work()).getByRole("region", { name: "Create loop" });
    const disclosure = form
      .getByRole("button", { name: "Create loop", exact: true })
      .first();
    if ((await disclosure.getAttribute("aria-expanded")) !== "true")
      await disclosure.click();
    const enable = form.getByRole("button", {
      name: "Turn on experimental Recursive Looping",
      exact: true,
    });
    if (await enable.count()) await enable.click();
    await form
      .getByRole("group", { name: "Loop kind" })
      .getByRole("radio", { name: "Goal loop" })
      .check();
    await form.getByRole("textbox", { name: /Goals/ }).fill(text);
    await form
      .getByRole("button", { name: "Create loop", exact: true })
      .last()
      .click();
    await expect(form.getByRole("status")).toContainText("Nothing has started");
    await form.getByRole("button", { name: "Open loop", exact: true }).click();
  }
  try {
    await mockDialogs(app, project);
    await installInterceptor(app);
    await page.setViewportSize({ width: 1280, height: 880 });
    currentTheme = null;
    currentZoom = 1;
    await setTheme(page, "paper");
    const running = "Change the value to two";
    const draft = "Draft loop: add a comment above the value";
    await step(
      "loops: project, qualified Codex stand-in and a discussion session (setup)",
      async () => {
        await page
          .getByRole("button", { name: "+ Add folder", exact: true })
          .click();
        await expect(
          page.getByRole("region", { name: "New session" }),
        ).toBeVisible();
        projectId = (await command_({ type: "navigation-query" })).projectId;
        await setOpen(app, codex, 1);
        const runtime = await command_({ type: "select-runtime" });
        await expect
          .poll(async () =>
            (await command_({ type: "state" })).installations.some(
              (i) => i.id === runtime.id,
            ),
          )
          .toBe(true);
        await command_({ type: "trust-installation", id: runtime.id });
        await command_({ type: "runtime-connect", id: runtime.id });
        await command_({ type: "runtime-models", id: runtime.id });
        await command_({
          type: "runtime-qualify",
          id: runtime.id,
          model: "fixture-model",
        });
        await navigate(page, "New session");
        const home = page.getByRole("region", { name: "New session" });
        await home
          .getByRole("group", { name: "Composer mode" })
          .getByRole("radio", { name: "Discuss", exact: true })
          .check();
        await home
          .getByRole("textbox", { name: "Message" })
          .fill("What does file.ts export?");
        await home
          .getByRole("button", { name: "Start session", exact: true })
          .click();
        await expect(
          thread().getByRole("heading", {
            name: "What does file.ts export?",
            exact: true,
          }),
        ).toBeVisible({ timeout: 30000 });
      },
      page,
    );
    await step(
      "loops: draft, then running",
      async () => {
        await createLoop(`${running}.`);
        await expect(runArticle(running)).toBeVisible();
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "loop-codex",
            state: "draft-first-in-queue",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await runArticle(running)
          .getByRole("button", { name: "Review and start", exact: true })
          .click();
        const id = (await runOf(running)).id;
        await expect
          .poll(
            async () =>
              (await command_({ type: "loop-inspect", runId: id })).current
                ?.iteration.state ?? "",
            { timeout: 60000, intervals: [100] },
          )
          .toMatch(/organizing|preparing|executing|verifying|evaluating/);
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "loop-codex",
            state: "running",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        for (const size of ["1024x768", "560x720", "zoom200"]) {
          await setSize(app, page, size);
          await inspect(page, {
            destination: "loop-codex",
            state: "running",
            theme: "paper",
            size,
          });
        }
        await setSize(app, page, "1280x880");
        for (const pane of ["Goals", "Organization", "Iterations"]) {
          const toggle = runArticle(running)
            .getByRole("group", { name: "Thread panes" })
            .getByRole("button", { name: new RegExp(`^${pane}`) });
          if ((await toggle.getAttribute("aria-pressed")) !== "true")
            await toggle.click();
          await settle(page, 400);
          await inspect(page, {
            destination: `loop-codex-${pane.toLowerCase()}-pane`,
            state: "running",
            theme: "paper",
            size: "1280x880",
          });
        }
      },
      page,
    );
    await step(
      "loops: a second loop waits as a draft while the first runs",
      async () => {
        await runArticle(running)
          .getByRole("button", { name: "← Back to session", exact: true })
          .click();
        await work();
        await inspect(page, {
          destination: "loop-codex-session-work-pane",
          state: "loop-running",
          theme: "paper",
          size: "1280x880",
          full: true,
        });
        await createLoop(`${draft}.`);
        await expect(runArticle(draft)).toBeVisible();
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "loop-codex",
            state: "draft-behind-running",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await setSize(app, page, "560x720");
        await inspect(page, {
          destination: "loop-codex",
          state: "draft-behind-running",
          theme: "paper",
          size: "560x720",
        });
        await setSize(app, page, "1280x880");
      },
      page,
    );
    await step(
      "loops: stop the running loop",
      async () => {
        await runArticle(draft)
          .getByRole("button", { name: "← Back to session", exact: true })
          .click();
        const pane = await work();
        await pane
          .getByRole("region", { name: "Running now", exact: true })
          .or(pane.getByRole("listitem"))
          .filter({ hasText: running })
          .getByRole("button", { name: /Open loop|Review and start/ })
          .first()
          .click();
        await expect(runArticle(running)).toBeVisible();
        await runArticle(running)
          .getByRole("button", { name: "Stop", exact: true })
          .click();
        const id = (await runOf(running)).id;
        await expect
          .poll(
            async () =>
              (await command_({ type: "loop-inspect", runId: id })).run.state,
            { timeout: 90000 },
          )
          .toBe("stopped");
        await settle(page, 800);
        for (const theme of ["paper", "night"]) {
          await setTheme(page, theme);
          await inspect(page, {
            destination: "loop-codex",
            state: "stopped",
            theme,
            size: "1280x880",
            full: theme === "paper",
          });
        }
        await setTheme(page, "paper");
        await setSize(app, page, "560x720");
        await inspect(page, {
          destination: "loop-codex",
          state: "stopped",
          theme: "paper",
          size: "560x720",
        });
        await setSize(app, page, "1280x880");
      },
      page,
    );
    phase.confirmations = (await confirmations(app)).map((c) => ({
      message: c.message,
      buttons: c.buttons,
    }));
  } finally {
    await app.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
    rmSync(qualify, { recursive: true, force: true });
  }
}

const runners = { firstrun: firstRun, dense, main, loops };
for (const name of PHASES) {
  if (!runners[name]) throw new Error(`Unknown phase ${name}`);
  try {
    await runners[name]();
  } catch (error) {
    report.phases[name] ??= {};
    report.phases[name].fatal = String(error?.stack ?? error).slice(0, 3000);
    console.error(`PHASE FATAL ${name}`, error);
  }
  report.phases[name].endedAt = new Date().toISOString();
  await save();
}
report.endedAt = new Date().toISOString();
report.limitations = [
  "VoiceOver cannot be driven from Playwright; accessible names come from Chromium's accessibility tree, which is not a screen-reader journey.",
  "Contrast is computed from computed colours and ancestor backgrounds; text over images, gradients or overlapping positioned boxes is approximate.",
  "Focus visibility is a style change on the focused element, its parent or label between unfocused and focused; it does not judge whether the change is perceivable enough.",
  "IME composition is simulated through CDP Input.imeSetComposition and insertText, not a real macOS input method.",
  "Network-bound commands were refused; the lifecycle plan dialog shows a synthetic plan.",
];
await save();
const failedSteps = Object.values(report.phases).flatMap((p) =>
  (p.steps ?? []).filter((s) => s.status === "failed").map((s) => s.name),
);
console.log(
  `W3 inspection finished. Views: ${Object.values(report.phases).reduce((n, p) => n + (p.views?.length ?? 0), 0)}. Failed steps: ${failedSteps.length ? failedSteps.join("; ") : "none"}. Evidence: ${EVIDENCE}`,
);
