// Campaign 2026-10-19 packet p8-packaged-upgrade: packaged-app acceptance harness.
//
// Drives the real extracted Topsl.app (not `electron .`) with Playwright's
// `_electron`, always with a fresh temporary `--user-data-dir`, and an
// environment without ELECTRON_RUN_AS_NODE / TOPSL_TEST_PROFILE (except the one
// negative control that proves a packaged app ignores TOPSL_TEST_PROFILE).
// Older releases (tags v0.1.1 / v0.1.2, built worktrees) are launched with
// their own Electron as `electron <worktree>` only to create realistic profiles.
//
// Run from the clean checkout:
//   test-results/agent-testing/2026-10-19-comprehensive/cleanenv.sh \
//     node <repository>/scripts/campaign-packaged-test.mjs <scenario>
// Scenarios: identity native osvault vaultfaults upgrade-v011 upgrade-v012
//            faults restore removal
//
// Vaults are passphrase vaults written by the harness in the product's exact
// format (apps/desktop/vault.ts), because on macOS with a secure store the
// startup auto-unlock creates an `os` vault before any passphrase can be typed.
// Only the `osvault` scenario (and one fault variant) uses the OS store; it
// uses the existing "topsl Safe Storage" login-keychain item.
import { createRequire } from "node:module";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createHash,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  cpSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import { selectProject } from "./desktop-navigation.mjs";
import path from "node:path";

// Paths default to the 19 October 2026 campaign layout; override them to rerun
// elsewhere: TOPSL_CAMPAIGN_CLEAN (clean checkout holding the packaged build),
// TOPSL_CAMPAIGN_V011 / TOPSL_CAMPAIGN_V012 (built tag worktrees).
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLEAN =
  process.env.TOPSL_CAMPAIGN_CLEAN ?? `${REPO}/.claude/worktrees/campaign-clean`;
const WORKTREES = {
  "0.1.1":
    process.env.TOPSL_CAMPAIGN_V011 ?? `${REPO}/.claude/worktrees/campaign-v011`,
  "0.1.2":
    process.env.TOPSL_CAMPAIGN_V012 ?? `${REPO}/.claude/worktrees/campaign-v012`,
};
const PACKET = `${REPO}/test-results/agent-testing/2026-10-19-comprehensive/p8-packaged-upgrade`;
const ZIP = `${CLEAN}/release/Topsl-0.1.2-mac-arm64.zip`;
const ZIP_SHA256 =
  "3da1499d8d7a202b14b98deabe6821421239b27d5ee0284d2c0b21285285ab6e";
const WORK = process.env.P8_WORK ?? path.join(os.tmpdir(), "topsl-p8-work");
const BUNDLE = process.env.P8_BUNDLE ?? path.join(WORK, "extracted", "Topsl.app");
const PASSPHRASE = "Campaign p8 vault passphrase ✓ 2026";
const CANARY = "quartzharbor";
const require = createRequire(path.join(CLEAN, "package.json"));
const { _electron: electron, expect } = require("@playwright/test");

const scenario = process.argv[2];
const evidence = path.join(PACKET, "evidence", scenario ?? "none");
mkdirSync(evidence, { recursive: true });
mkdirSync(WORK, { recursive: true });
const checks = [];
const notes = {};
const startedAt = new Date().toISOString();

function check(caseId, name, ok, detail = null) {
  checks.push({ caseId, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${caseId}] ${name}${detail !== null && !ok ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  return !!ok;
}
const sha256File = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 180_000, ...options });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!("TOPSL_TEST_PROFILE" in extra)) delete env.TOPSL_TEST_PROFILE;
  delete env.TOPSL_TEST_QUALIFICATION_DIR;
  for (const k of Object.keys(env))
    if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k))
      throw new Error(`Leaked environment variable ${k}; run through cleanenv.sh.`);
  return env;
}
// Short temporary roots: the product's context socket lives at
// <userData>/context.sock, and macOS limits a socket path to 104 bytes (see the
// longpath scenario), so long temporary profile paths cannot unlock at all.
function tempProfile(label) {
  return mkdtempSync(path.join(os.tmpdir(), `p8${label.replace(/[^a-z0-9]/gi, "").slice(0, 4)}-`));
}
function seedPassphraseVault(directory, passphrase = PASSPHRASE) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databaseKey = randomBytes(32).toString("hex");
  const salt = randomBytes(32),
    iv = randomBytes(12),
    key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(databaseKey, "utf8"), cipher.final()]);
  writeFileSync(
    path.join(directory, "vault.json"),
    JSON.stringify({
      method: "passphrase",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: data.toString("base64"),
    }),
    { mode: 0o600 },
  );
}
function inspectProfile(profile, passphrase = PASSPHRASE) {
  const r = sh(
    `${CLEAN}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
    [`${REPO}/scripts/campaign-upgrade-profile.mjs`, "inspect", profile, passphrase],
    { env: { ...childEnv(), ELECTRON_RUN_AS_NODE: "1" } },
  );
  if (r.status !== 0) return { error: r.stderr.trim().split("\n").slice(0, 3).join(" ") };
  return JSON.parse(r.stdout);
}
function setUserVersion(profile, version) {
  const r = sh(
    `${CLEAN}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
    [`${REPO}/scripts/campaign-upgrade-profile.mjs`, "set-user-version", profile, PASSPHRASE, String(version)],
    { env: { ...childEnv(), ELECTRON_RUN_AS_NODE: "1" } },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
function fileHashes(profile, names) {
  return Object.fromEntries(
    names.map((n) => [n, existsSync(path.join(profile, n)) ? sha256File(path.join(profile, n)) : null]),
  );
}
// Stat only: the owner's real profile and native homes are never opened.
function ownerFootprint() {
  const home = os.homedir();
  const targets = [
    "Library/Application Support/Topsl",
    "Library/Application Support/Topsl/vault.json",
    "Library/Application Support/Topsl/history.sqlite",
    "Library/Application Support/Topsl/history.sqlite-wal",
  ];
  return Object.fromEntries(
    targets.map((t) => {
      try {
        const s = statSync(path.join(home, t));
        return [t, { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.isFile() ? s.size : null }];
      } catch {
        return [t, null];
      }
    }),
  );
}
function keychainItems() {
  const out = {};
  for (const service of ["topsl Safe Storage", "Topsl Safe Storage"]) {
    const r = sh("/usr/bin/security", ["find-generic-password", "-s", service]);
    out[service] =
      r.status === 0
        ? (r.stdout.match(/"mdat"<timedate>=0x[0-9A-F]+\s+"([^"\\]+)/)?.[1] ?? "present")
        : null;
  }
  return out;
}
function descendants(pid) {
  const r = sh("/usr/bin/pgrep", ["-P", String(pid)]);
  const kids = r.stdout.split("\n").filter(Boolean).map(Number);
  return kids.flatMap((k) => [k, ...descendants(k)]);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Launching -------------------------------------------------------------
async function launch({ kind, profile, bundle = BUNDLE, env = {} }) {
  const options =
    kind === "candidate"
      ? {
          executablePath: path.join(bundle, "Contents/MacOS/Topsl"),
          args: [`--user-data-dir=${profile}`],
        }
      : {
          // The old worktrees' npm ci did not download Electron's binary; each
          // pins electron 44.4.5, identical to the clean checkout's binary.
          executablePath: existsSync(`${WORKTREES[kind]}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`)
            ? `${WORKTREES[kind]}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`
            : `${CLEAN}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
          args: [WORKTREES[kind], `--user-data-dir=${profile}`],
          cwd: WORKTREES[kind],
        };
  const app = await electron.launch({ ...options, env: childEnv(env), timeout: 90_000 });
  const logs = [];
  app.process().stdout?.on("data", (d) => logs.push(`[stdout] ${d}`));
  app.process().stderr?.on("data", (d) => logs.push(`[stderr] ${d}`));
  const page = await app.firstWindow();
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && logs.push(`[console.error] ${m.text()}`));
  return { kind, app, page, logs, pid: app.process().pid, profile };
}
async function close(session) {
  const started = Date.now();
  await session.app.close();
  return Date.now() - started;
}
function kill(session) {
  const all = [session.pid, ...descendants(session.pid)];
  for (const pid of all) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return all;
}
const state = (page) => page.evaluate(() => window.topsl.command({ type: "state" }));
const cmd = (page, command) =>
  page.evaluate((c) => window.topsl.command(c), command);
async function settledLockReason(page, timeout = 45_000) {
  let last;
  await expect
    .poll(
      async () => {
        last = await state(page).catch(() => null);
        return last && (!last.locked || last.lockReason !== "Unlocking the local vault…");
      },
      { timeout },
    )
    .toBe(true)
    .catch(() => {});
  return last;
}
async function unlockUI(page, passphrase = PASSPHRASE, { wrong = null } = {}) {
  const field = page.getByRole("textbox", { name: "Vault passphrase" });
  const prompt = await settledLockReason(page);
  const promptText = prompt?.lockReason ?? null;
  if (wrong) {
    await field.fill(wrong);
    await page.getByRole("button", { name: "Unlock / create vault" }).click();
    await expect(page.getByText("Vault passphrase is incorrect.")).toBeVisible({ timeout: 30_000 });
  }
  await field.fill(passphrase);
  await page.getByRole("button", { name: "Unlock / create vault" }).click();
  await expect
    .poll(async () => (await state(page)).locked, { timeout: 60_000 })
    .toBe(false);
  return promptText;
}
async function stubDialogs(app) {
  await app.evaluate(({ dialog }) => {
    globalThis.__p8 = { openPath: null, prompts: [] };
    dialog.showOpenDialog = async (...args) => {
      const o = args.at(-1) ?? {};
      globalThis.__p8.prompts.push({ kind: "open", title: o.title ?? null });
      return { canceled: false, filePaths: [globalThis.__p8.openPath] };
    };
    dialog.showMessageBox = async (...args) => {
      const o = args.at(-1) ?? {};
      globalThis.__p8.prompts.push({ kind: "message", message: o.message ?? null, detail: o.detail ?? null, buttons: o.buttons ?? null });
      return { response: 1, checkboxChecked: false };
    };
  });
}
const setOpenPath = (app, p) =>
  app.evaluate((_, p) => {
    globalThis.__p8.openPath = p;
  }, p);
const prompts = (app) => app.evaluate(() => globalThis.__p8.prompts);
async function navigate(page, name) {
  if (await page.evaluate(() => innerWidth < 900)) {
    const drawer = page.locator("dialog.sidebar");
    if (!(await drawer.isVisible()))
      await page.getByRole("button", { name: "Navigation", exact: true }).click();
  }
  // Application navigation carries a count badge ("Applications 1").
  const label = name === "Applications" ? /^Applications( \d+)?$/ : name;
  await page.getByRole("button", { name: label, exact: typeof label === "string" }).first().click();
}

// --- Fixtures --------------------------------------------------------------
function makeProject(root, name = "p8 harbor project") {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Campaign p8 fixture project\n");
  return realpathSync(dir);
}
function makeTranscript(root, projectPath, tag) {
  const file = path.join(root, `p8-${tag}.jsonl`);
  const records = [
    { type: "session_meta", payload: { id: `p8-session-${tag}`, cwd: projectPath } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Where is the ${CANARY} ${tag} lighthouse?` }] },
    },
    {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `The ${CANARY} ${tag} answer is preserved with attribution.` }] },
    },
  ];
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
// A local PTY stand-in for a Codex CLI: no vendor process or account. It logs
// what its own TTY reports, so resize and close are observed by the child.
function makeStandin(root) {
  const dir = path.join(root, "standin");
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "standin.log");
  const script = path.join(dir, "standin.cjs");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const note = (o) => fs.appendFileSync(log, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + "\\n");
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 0.163.0\\n"); process.exit(0); }
note({ event: "start", argv: process.argv.slice(2), cwd: process.cwd(), ppid: process.ppid, tty: !!process.stdout.isTTY, cols: process.stdout.columns, rows: process.stdout.rows, term: process.env.TERM ?? null });
process.stdout.write("TOPSL-STANDIN READY " + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n");
process.stdout.on("resize", () => { note({ event: "resize", cols: process.stdout.columns, rows: process.stdout.rows }); process.stdout.write("SIZE " + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n"); });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (d) => { note({ event: "input", data: d.toString() }); process.stdout.write("ECHO:" + d.toString().replace(/\\r/g, "") + "\\r\\n"); });
for (const s of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(s, () => { note({ event: "signal", signal: s }); process.exit(0); });
process.on("exit", (code) => note({ event: "exit", code }));
setInterval(() => {}, 1 << 30);
`,
  );
  const executable = path.join(dir, "codex");
  const q = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
  writeFileSync(executable, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} "$@"\n`);
  chmodSync(executable, 0o700);
  return { executable, log, events: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

// --- Shared journeys ---------------------------------------------------------
async function addProjectUI(session, projectPath) {
  const { app, page } = session;
  await setOpenPath(app, projectPath);
  await navigate(page, "Projects");
  await page.getByRole("button", { name: "+ Add project", exact: true }).click();
  await expect(page.getByRole("heading", { name: path.basename(projectPath), exact: true })).toBeVisible({ timeout: 30_000 });
  return (await state(page)).projects.find((p) => p.realPath === projectPath);
}
async function importUI(session, transcript, projectId) {
  const { app, page } = session;
  await setOpenPath(app, transcript);
  await navigate(page, "History");
  const before = (await conversations(page, projectId)).length;
  await page.getByRole("button", { name: "Import Codex JSONL", exact: true }).click();
  await expect.poll(async () => (await conversations(page, projectId)).length, { timeout: 30_000 }).toBe(before + 1);
  await expect(page.getByRole("button", { name: new RegExp(`Imported codex · ${path.basename(transcript)}`) })).toBeVisible();
}
async function conversations(page, projectId, version = "candidate") {
  const list =
    version === "0.1.1"
      ? (await state(page)).conversations.filter((c) => c.projectId === projectId)
      : (await cmd(page, { type: "history-conversations", projectId, limit: 200 })).items;
  return list.map((c) => ({ id: c.id, projectId: c.projectId, title: c.title })).sort((a, b) => a.id.localeCompare(b.id));
}
async function search(page, projectId, query, version = "candidate") {
  if (version === "0.1.1") return cmd(page, { type: "history-search", projectId, query });
  const r = await cmd(page, { type: "history-page", projectId, query, limit: 50 });
  return r.items ?? r;
}
async function nativeModuleMaps(session, bundle) {
  const pids = [session.pid, ...descendants(session.pid)];
  const loaded = [];
  for (const pid of pids) {
    const r = sh("/usr/sbin/lsof", ["-p", String(pid), "-Fn"]);
    for (const line of r.stdout.split("\n"))
      if (line.startsWith("n") && /\.node$/.test(line)) loaded.push({ pid, file: line.slice(1) });
  }
  return { pids, loaded, insideBundle: loaded.every((l) => l.file.replace(/^\/private/, "").startsWith(realpathSync(bundle).replace(/^\/private/, ""))) };
}
async function terminalJourney(session, root, caseId, bundle = BUNDLE) {
  const { app, page } = session;
  const standin = makeStandin(root);
  const result = { standin: standin.executable };
  await setOpenPath(app, standin.executable);
  await navigate(page, "Applications");
  await page.getByRole("button", { name: "Locate a runtime", exact: true }).click();
  let installation;
  await expect
    .poll(async () => {
      installation = (await state(page)).installations.find((i) => i.realPath === realpathSync(standin.executable));
      return !!installation;
    }, { timeout: 30_000 })
    .toBe(true);
  const card = page.locator("code.path", { hasText: standin.executable }).locator("..");
  await card.getByRole("button", { name: "Trust executable", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).installations.find((i) => i.id === installation.id)?.trusted, { timeout: 30_000 })
    .toBe(true);
  await navigate(page, "Provider tools");
  await page.getByRole("combobox", { name: "Runtime", exact: true }).selectOption(installation.id);
  await page.getByRole("button", { name: "Native terminal", exact: true }).click();
  const terminal = page.getByRole("region", { name: "Native terminal" });
  const screen = () =>
    terminal.locator(".xterm-rows").innerText().then((t) => t.replaceAll(String.fromCharCode(160), " ")).catch(() => "");
  await expect.poll(screen, { timeout: 30_000 }).toContain("TOPSL-STANDIN READY");
  const start = standin.events().find((e) => e.event === "start");
  result.start = start;
  check(caseId, "PTY child started from the packaged UI with a TTY", start?.tty === true, start);
  const parent = sh("/bin/ps", ["-o", "comm=", "-p", String(start?.ppid)]).stdout.trim();
  result.parentCommand = parent;
  check(caseId, "PTY child's parent process (control service) runs from inside the bundle", parent.startsWith(realpathSync(bundle)) || parent.startsWith(bundle) || parent.replace(/^\/private/, "").startsWith(bundle.replace(/^\/private/, "")), parent);
  result.modules = await nativeModuleMaps(session, bundle);
  const sqlite = result.modules.loaded.filter((l) => /better-sqlite3-multiple-ciphers\//.test(l.file));
  const pty = result.modules.loaded.filter((l) => /node-pty\/.*pty\.node$/.test(l.file));
  check(caseId, "the encrypted-SQLite and PTY native modules are mapped from app.asar.unpacked in the running app", sqlite.length > 0 && pty.length > 0 && [...sqlite, ...pty].every((l) => l.file.includes("/Contents/Resources/app.asar.unpacked/")), result.modules.loaded);
  // Resize through the OS window: ResizeObserver -> terminal-resize -> PTY.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720));
  await expect
    .poll(() => standin.events().some((e) => e.event === "resize" && e.cols !== start.cols), { timeout: 20_000 })
    .toBe(true)
    .catch(() => {});
  const resized = standin.events().filter((e) => e.event === "resize");
  result.resizes = resized;
  check(caseId, "window resize reaches the PTY child as a new TTY size", resized.some((e) => e.cols !== start.cols), { start: [start.cols, start.rows], resized });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 880));
  await terminal.locator(".xterm").click();
  await page.keyboard.type("p8ping");
  const typed = () => standin.events().filter((e) => e.event === "input").map((e) => e.data).join("");
  await expect.poll(typed, { timeout: 20_000 }).toBe("p8ping").catch(() => {});
  await expect.poll(screen, { timeout: 20_000 }).toContain("ECHO:g");
  check(caseId, "keyboard input reaches the PTY child and its output renders", typed() === "p8ping", typed());
  await page.locator(".terminal-panel").getByRole("button", { name: "Close session", exact: true }).click();
  await expect.poll(() => standin.events().some((e) => e.event === "exit"), { timeout: 20_000 }).toBe(true).catch(() => {});
  await expect.poll(() => alive(start.pid), { timeout: 10_000 }).toBe(false).catch(() => {});
  result.endEvents = standin.events().filter((e) => ["signal", "exit"].includes(e.event));
  check(caseId, "Close session terminates the PTY child (no orphan)", !alive(start.pid) && result.endEvents.some((e) => e.event === "exit"), result.endEvents);
  const run = (await state(page)).runs.find((r) => r.installationId === installation.id);
  result.run = run && { id: run.id, status: run.status, nativePid: run.nativePid };
  result.installationId = installation.id;
  return result;
}
function moduleErrors(logs) {
  return logs.filter((l) => /NODE_MODULE_VERSION|compiled against a different|Cannot find module|ERR_DLOPEN_FAILED|was compiled against/.test(l));
}
function saveReport(extra = {}) {
  const report = {
    scenario,
    startedAt,
    finishedAt: new Date().toISOString(),
    host: `${process.platform}-${process.arch}`,
    node: process.version,
    bundle: BUNDLE,
    checks,
    notes,
    ...extra,
  };
  writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${scenario}: ${checks.length - failed} passed, ${failed} failed. Report: ${path.join(evidence, "report.json")}`);
  process.exitCode = failed ? 1 : 0;
}
async function snapshotOnError(session, name) {
  if (!session) return;
  try {
    await session.page.screenshot({ path: path.join(evidence, `${name}.png`) });
    writeFileSync(path.join(evidence, `${name}.aria.txt`), await session.page.locator("body").ariaSnapshot());
  } catch {}
  try {
    writeFileSync(path.join(evidence, `${name}.logs.txt`), session.logs.join(""));
  } catch {}
}
function ensureBundle() {
  if (existsSync(BUNDLE)) return;
  const out = path.dirname(BUNDLE);
  mkdirSync(out, { recursive: true });
  execFileSync("/usr/bin/ditto", ["-x", "-k", ZIP, out], { stdio: "pipe", timeout: 300_000 });
}

// --- Scenarios -------------------------------------------------------------
async function identity() {
  const zipHash = sha256File(ZIP);
  check("PKG-03", "archive SHA-256 equals the coordinator's recorded candidate", zipHash === ZIP_SHA256, zipHash);
  rmSync(path.dirname(BUNDLE), { recursive: true, force: true });
  ensureBundle();
  notes.extractedFrom = { zip: ZIP, size: statSync(ZIP).size, sha256: zipHash, extractedTo: BUNDLE, tool: "ditto -x -k" };
  const diff = sh("/usr/bin/diff", ["-rq", BUNDLE, `${CLEAN}/release/mac-arm64/Topsl.app`]);
  check("PKG-03", "extracted archive tree is byte-identical to electron-builder's mac-arm64/Topsl.app", diff.status === 0, diff.stdout.slice(0, 500));
  const verify = sh("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", BUNDLE]);
  check("PKG-06", "codesign --verify --deep --strict accepts the extracted bundle", verify.status === 0, verify.stderr);
  const display = sh("/usr/bin/codesign", ["-dv", "--verbose=2", BUNDLE]);
  notes.codesign = display.stderr.split("\n").filter((l) => /Identifier|Signature|TeamIdentifier|Format|CDHash=/.test(l));
  check("PKG-07", "bundle is ad-hoc signed with no Team ID (no Developer ID claim possible)", /Signature=adhoc/.test(display.stderr) && /TeamIdentifier=not set/.test(display.stderr), notes.codesign);
  const icon = sha256File(path.join(BUNDLE, "Contents/Resources/icon.icns")) === sha256File(`${CLEAN}/assets/brand/icons/icon.icns`);
  check("PKG-06", "bundle icon bytes equal assets/brand/icons/icon.icns", icon);
  // Tampered copy: a changed sealed resource must be rejected by the verifier.
  const tamperRoot = path.join(WORK, "tampered");
  rmSync(tamperRoot, { recursive: true, force: true });
  mkdirSync(tamperRoot, { recursive: true });
  const tampered = path.join(tamperRoot, "Topsl.app");
  execFileSync("/usr/bin/ditto", [BUNDLE, tampered]);
  check("PKG-06", "unmodified ditto copy still verifies (control)", sh("/usr/bin/codesign", ["--verify", "--deep", "--strict", tampered]).status === 0);
  appendFileSync(path.join(tampered, "Contents/Resources/app.asar.unpacked/dist/cli.cjs"), "\n// p8 tamper\n");
  const tv = sh("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", tampered]);
  check("PKG-06", "codesign rejects the copy after one unpacked resource changed", tv.status !== 0, tv.stderr.trim().split("\n").slice(-3));
  notes.tamperedVerifyOutput = tv.stderr.trim().split("\n").slice(-4);
  // Quarantine observation on a copy only (no open, no Gatekeeper changes).
  const quarantined = path.join(tamperRoot, "Quarantined.app");
  execFileSync("/usr/bin/ditto", [BUNDLE, quarantined]);
  sh("/usr/bin/xattr", ["-w", "com.apple.quarantine", `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, quarantined]);
  const spctl = sh("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", quarantined]);
  notes.quarantineAssessment = { status: spctl.status, output: (spctl.stdout + spctl.stderr).trim() };
  check("PKG-07", "spctl assessment of a quarantined copy does not accept it as notarized/Developer ID", spctl.status !== 0, notes.quarantineAssessment);
  rmSync(quarantined, { recursive: true, force: true });
  // Architecture and package contents.
  const fileOut = sh("/usr/bin/file", [path.join(BUNDLE, "Contents/MacOS/Topsl"), ...["better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node", "node-pty/build/Release/pty.node", "node-pty/build/Release/spawn-helper"].map((p) => path.join(BUNDLE, "Contents/Resources/app.asar.unpacked/node_modules", p)).filter(existsSync)]);
  notes.architectures = fileOut.stdout.trim().split("\n");
  check("PKG-01", "main executable and unpacked native modules are arm64 Mach-O", notes.architectures.length >= 3 && notes.architectures.every((l) => /arm64/.test(l) && !/x86_64/.test(l)), notes.architectures);
  const asar = require("@electron/asar");
  const archive = path.join(BUNDLE, "Contents/Resources/app.asar");
  const listing = asar.listPackage(archive);
  notes.asarEntries = listing.length;
  const flagged = listing.filter((f) => /(^|\/)(tests?|fixtures?|\.env|.*\.sqlite|vault\.json|\.git|test-results|\.claude|history\.sqlite)(\/|$)/i.test(f.replace(/^\//, "")));
  // Third-party packages may ship their own source test folders; those are
  // recorded, not Topsl test fixtures or profiles.
  const thirdParty = flagged.filter((f) => /^\/node_modules\//.test(f));
  notes.thirdPartyTestFolders = { count: thirdParty.length, roots: [...new Set(thirdParty.map((f) => f.split("/").slice(0, 6).join("/")))].slice(0, 8) };
  const suspicious = flagged.filter((f) => !/^\/node_modules\//.test(f));
  check("PKG-01", "app.asar contains no Topsl tests, fixtures, profiles, vaults, .env or .git", suspicious.length === 0, suspicious.slice(0, 20));
  const appPackage = JSON.parse(asar.extractFile(archive, "package.json").toString());
  check("PKG-03", "packaged package.json version is 0.1.2 and main is dist/main.cjs", appPackage.version === "0.1.2" && appPackage.main === "dist/main.cjs", { version: appPackage.version, main: appPackage.main });
  const distMatches = {};
  for (const f of ["main.cjs", "service.cjs", "preload.cjs"])
    distMatches[f] = createHash("sha256").update(asar.extractFile(archive, `dist/${f}`)).digest("hex") === sha256File(`${CLEAN}/dist/${f}`);
  distMatches["cli.cjs (unpacked)"] = sha256File(path.join(BUNDLE, "Contents/Resources/app.asar.unpacked/dist/cli.cjs")) === sha256File(`${CLEAN}/dist/cli.cjs`);
  const head = sh("git", ["-C", CLEAN, "rev-parse", "HEAD"]).stdout.trim();
  const dirty = sh("git", ["-C", CLEAN, "status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  notes.source = { head, trackedDirty: dirty || null, lockfileSha256: sha256File(`${CLEAN}/package-lock.json`) };
  check("PKG-03", "packaged dist bundles are byte-identical to the clean d4b788e checkout's build", Object.values(distMatches).every(Boolean) && head.startsWith("d4b788e"), { distMatches, head });
  // Tracked edits after packaging are recorded; the package's inputs are dist/** and package.json.
  notes.source.dirtyFilesArePackageInputs = dirty.split("\n").filter(Boolean).some((l) => /\s(dist\/|package\.json$|apps\/|packages\/)/.test(l));
  // Launch the real extracted app; TOPSL_TEST_PROFILE must be ignored.
  const footprintBefore = ownerFootprint();
  const keysBefore = keychainItems();
  const profile = tempProfile("identity");
  seedPassphraseVault(profile);
  const decoy = mkdtempSync(path.join(os.tmpdir(), "topsl-test-p8decoy-"));
  let session;
  try {
    session = await launch({ kind: "candidate", profile, env: { TOPSL_TEST_PROFILE: decoy } });
    const id = await session.app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      userData: app.getPath("userData"),
      name: app.getName(),
      version: app.getVersion(),
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      versions: { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, chrome: process.versions.chrome },
      arch: process.arch,
      testProfileEnvSeen: !!process.env.TOPSL_TEST_PROFILE,
    }));
    notes.identity = { ...id, userData: "<temporary profile>" };
    check("PKG-03", "app.isPackaged is true", id.packaged === true, id);
    check("PKG-03", "userData resolves to the temporary --user-data-dir even with TOPSL_TEST_PROFILE set", realpathSync(id.userData) === realpathSync(profile), { userData: id.userData });
    check("PKG-03", "executable and resources run from the extracted bundle", realpathSync(id.execPath).startsWith(realpathSync(BUNDLE)) && realpathSync(id.resourcesPath).startsWith(realpathSync(BUNDLE)), { execPath: id.execPath });
    check("PKG-03", "built version is 0.1.2 on arm64 with Electron 44.4.5", id.version === "0.1.2" && id.arch === "arm64" && id.versions.electron === "44.4.5", id);
    const prompt = await unlockUI(session.page);
    notes.passphrasePrompt = prompt;
    const s = await state(session.page);
    check("PKG-03", "packaged app ignores TOPSL_TEST_PROFILE: not a test profile and the decoy stays empty", s.testProfile === false && readdirSync(decoy).length === 0, { testProfile: s.testProfile, decoy: readdirSync(decoy) });
    check("PKG-03", "service-reported version equals app.getVersion()", s.version === id.version, { service: s.version, app: id.version });
    await expect(session.page.getByText(`Personal pilot · ${id.version}`)).toBeVisible();
    check("PKG-03", "visible sidebar shows the built version", true);
    const files = readdirSync(profile);
    check("PKG-03", "profile readback: vault.json and history.sqlite created only in the temporary profile", files.includes("vault.json") && files.includes("history.sqlite"), files);
    notes.profileFiles = files;
    notes.dockVisible = await session.app.evaluate(({ app }) => app.dock.isVisible());
    await session.page.screenshot({ path: path.join(evidence, "identity-unlocked.png") });
    notes.moduleErrors = moduleErrors(session.logs);
    check("PKG-04", "no missing-module or wrong-ABI errors in app output", notes.moduleErrors.length === 0, notes.moduleErrors);
    notes.closeMs = await close(session);
    session = null;
  } catch (e) {
    check("PKG-03", "identity launch completed", false, String(e.stack ?? e).slice(0, 800));
    await snapshotOnError(session, "identity-error");
    if (session) await session.app.close().catch(() => kill(session));
  }
  const footprintAfter = ownerFootprint();
  check("PKG-03", "owner's real Topsl profile unchanged (stat before/after)", JSON.stringify(footprintBefore) === JSON.stringify(footprintAfter), { footprintBefore, footprintAfter });
  notes.keychain = { before: keysBefore, after: keychainItems() };
  check("PKG-03", "passphrase-vault launch created no new Topsl keychain item", JSON.stringify(keysBefore) === JSON.stringify(notes.keychain.after), notes.keychain);
  // Tampered copy launch observation (runtime does not re-verify resource seals).
  const tProfile = tempProfile("tampered");
  seedPassphraseVault(tProfile);
  let t;
  try {
    t = await launch({ kind: "candidate", profile: tProfile, bundle: tampered });
    notes.tamperedCopyLaunches = await t.app.evaluate(({ app }) => app.isPackaged);
    await close(t);
  } catch (e) {
    notes.tamperedCopyLaunches = `launch failed: ${String(e).slice(0, 200)}`;
    if (t) kill(t);
  }
  rmSync(tamperRoot, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
  rmSync(tProfile, { recursive: true, force: true });
  rmSync(decoy, { recursive: true, force: true });
}

async function native() {
  ensureBundle();
  const footprintBefore = ownerFootprint();
  const keysBefore = keychainItems();
  const root = tempProfile("native-root");
  const profile = path.join(root, "p");
  seedPassphraseVault(profile);
  const vaultHash = sha256File(path.join(profile, "vault.json"));
  const project = makeProject(root);
  const transcript = makeTranscript(root, project, "native");
  let session;
  const result = {};
  try {
    session = await launch({ kind: "candidate", profile });
    await stubDialogs(session.app);
    // UI-01 / DATA-02 K: locked until a valid passphrase; wrong one is refused.
    const locked = await settledLockReason(session.page);
    result.lockReason = locked?.lockReason;
    check("UI-01", "existing passphrase vault: startup stays locked and asks for the passphrase", locked?.locked === true && /Enter your vault passphrase/.test(locked?.lockReason ?? ""), locked?.lockReason);
    const refused = await cmd(session.page, { type: "project-add" }).then(() => "accepted", (e) => String(e.message ?? e));
    check("UI-01", "commands are refused while the vault is locked", refused !== "accepted", refused);
    await expect(session.page.getByText(/Enter your vault passphrase/)).toBeVisible();
    await unlockUI(session.page, PASSPHRASE, { wrong: "wrong passphrase ✗ 12345" });
    check("DATA-02", "wrong passphrase refused, vault bytes unchanged, then the correct passphrase unlocks", sha256File(path.join(profile, "vault.json")) === vaultHash);
    await expect(session.page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible({ timeout: 45_000 });
    const added = await addProjectUI(session, project);
    result.project = added;
    check("PKG-04", "project added through the packaged UI (native dialog stubbed in main)", added?.trusted === true, added);
    await importUI(session, transcript, added.id);
    const hits = await search(session.page, added.id, CANARY);
    result.hitsBefore = hits.map((m) => m.id);
    check("PKG-04", "imported transcript is searchable in the encrypted store", hits.length >= 2, hits.length);
    const header = readFileSync(path.join(profile, "history.sqlite")).subarray(0, 16).toString("latin1");
    check("PKG-04", "history.sqlite on disk is encrypted (no SQLite plaintext header)", !header.startsWith("SQLite format 3"), header);
    // Terminal through the packaged UI.
    result.terminal = await terminalJourney(session, root, "PKG-04");
    // Context grant through the Settings button.
    await navigate(session.page, "Settings");
    await session.page.getByRole("button", { name: new RegExp(`^Create grant for ${added.name}`) }).click();
    const detail = session.page.getByRole("dialog");
    await expect(detail).toContainText("Grant file:", { timeout: 20_000 });
    const text = await detail.innerText();
    result.grantDialog = text.replace(/\/[^\s"]+/g, (p) => (p.includes("app.asar.unpacked") ? p.replace(BUNDLE, "<bundle>") : "<path>"));
    const grantFile = text.match(/Grant file: (\S+)/)?.[1];
    const companion = JSON.parse(text.match(/node ("[^"]+") mcp/)?.[1] ?? "null");
    result.companion = companion?.replace(BUNDLE, "<bundle>");
    check("PKG-05", "displayed companion path is dist/cli.cjs inside app.asar.unpacked of this bundle and exists", companion?.startsWith(realpathSync(BUNDLE)) || companion?.startsWith(BUNDLE) ? companion.endsWith("app.asar.unpacked/dist/cli.cjs") && existsSync(companion) : false, companion);
    check("MCP-08", "packaged CLI resolution: the displayed MCP command points at an existing file outside app.asar", !!companion && existsSync(companion) && !companion.includes("app.asar/"), companion);
    const grantStat = statSync(grantFile);
    const grantDirStat = statSync(path.dirname(grantFile));
    const grant = JSON.parse(readFileSync(grantFile, "utf8"));
    result.grantKeys = Object.keys(grant).sort();
    check("PKG-05", "grant file is 0600 in a 0700 folder inside the temporary profile", (grantStat.mode & 0o777) === 0o600 && (grantDirStat.mode & 0o777) === 0o700 && realpathSync(grantFile).startsWith(realpathSync(profile)), { mode: (grantStat.mode & 0o777).toString(8), dir: (grantDirStat.mode & 0o777).toString(8) });
    const grantText = JSON.stringify(grant);
    check("PKG-05", "grant carries no provider credentials", !/sk-|ANTHROPIC|OPENAI|apiKey|password/i.test(grantText), result.grantKeys);
    const node = process.execPath;
    const engines = JSON.parse(readFileSync(`${CLEAN}/package.json`, "utf8")).engines.node;
    result.node = { version: process.version, declared: engines };
    const run = (args, input, extraEnv) => sh(node, [companion, ...args], { input, timeout: 15_000, env: { ...childEnv(), ...extraEnv } });
    const usage = run([]);
    const help = run(["--help"]);
    result.cli = { usage: { status: usage.status, stderr: usage.stderr.trim() }, help: { status: help.status } };
    check("PKG-05", `CLI runs with host Node ${process.version} (declared ${engines}); no-args and --help print usage with exit 2`, usage.status === 2 && help.status === 2 && /Usage: topsl-context/.test(usage.stderr), result.cli);
    const status = run(["status", grantFile]);
    const statusJson = status.status === 0 ? JSON.parse(status.stdout) : null;
    result.cli.status = { status: status.status, body: statusJson, stderr: status.stderr.trim() };
    check("PKG-05", "status with the valid grant succeeds against the packaged app's socket, read-only, no admin authority", statusJson?.readOnly === true && statusJson?.administrativeAuthority === false, result.cli.status);
    const found = run(["search", grantFile, CANARY]);
    result.cli.search = { status: found.status, count: (() => { try { const j = JSON.parse(found.stdout); return (j.items ?? j).length; } catch { return null; } })() };
    check("PKG-05", "CLI search returns the imported history through the grant", found.status === 0 && result.cli.search.count >= 1, result.cli.search);
    const mcpIn = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p8", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run", arguments: { command: "echo forbidden" } } },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const mcp = await new Promise((resolve) => {
      const child = spawn(node, [companion, "mcp", grantFile], { env: childEnv() });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        if (out.trim().split("\n").length >= 3) child.stdin.end();
      });
      child.on("exit", (code) => resolve({ code, lines: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
      child.stdin.write(mcpIn);
      setTimeout(() => child.kill(), 10_000);
    });
    const tools = mcp.lines.find((l) => l.id === 2)?.result?.tools?.map((t) => t.name) ?? [];
    const forbidden = mcp.lines.find((l) => l.id === 3);
    result.mcp = { serverInfo: mcp.lines.find((l) => l.id === 1)?.result?.serverInfo, tools, forbidden };
    check("MCP-08", "packaged CLI MCP mode initializes and lists only read-only context tools", tools.length > 0 && tools.every((t) => /search|history|status|page/i.test(t)), result.mcp);
    check("PKG-05", "MCP call to a non-context tool is refused", !!forbidden && (forbidden.error || forbidden.result?.isError), forbidden);
    const wrong = path.join(root, "wrong-token.json");
    writeFileSync(wrong, JSON.stringify({ ...grant, token: randomBytes(32).toString("hex") }));
    const wrongRun = run(["status", wrong]);
    const wrongProject = path.join(root, "wrong-project.json");
    writeFileSync(wrongProject, JSON.stringify({ ...grant, projectId: "0".repeat(32) }));
    const wrongProjectRun = run(["status", wrongProject]);
    result.cli.wrongToken = { status: wrongRun.status, stderr: wrongRun.stderr.trim() };
    result.cli.wrongProject = { status: wrongProjectRun.status, stderr: wrongProjectRun.stderr.trim() };
    // The grant file carries no project; the scope is held by the service, so
    // a client-supplied projectId must not change it.
    const scopedTo = wrongProjectRun.status === 0 ? JSON.parse(wrongProjectRun.stdout).projectId : null;
    result.cli.wrongProject.scopedTo = scopedTo;
    check("PKG-05", "grant with a wrong token is rejected by the packaged service", wrongRun.status === 1 && /Invalid project context grant/.test(wrongRun.stderr), result.cli.wrongToken);
    check("PKG-05", "a client-supplied projectId cannot widen or move the grant's server-side scope", scopedTo === added.id, result.cli.wrongProject);
    const runAsNode = sh(path.join(BUNDLE, "Contents/MacOS/Topsl"), [companion, "status", grantFile], { env: { ...childEnv(), ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000 });
    result.cli.runAsNodeWithPackagedBinary = { status: runAsNode.status };
    result.moduleErrors = moduleErrors(session.logs);
    check("PKG-04", "no missing-module or wrong-ABI errors in packaged app output", result.moduleErrors.length === 0, result.moduleErrors);
    result.serviceError = (await state(session.page)).serviceError;
    check("PKG-04", "control service reports no error", !result.serviceError, result.serviceError);
    result.prompts = (await prompts(session.app)).map((p) => p.message ?? p.title);
    await session.page.screenshot({ path: path.join(evidence, "native-settings.png") });
    result.closeMs = await close(session);
    session = null;
    // Grant does not survive the process.
    const afterClose = run(["status", grantFile]);
    result.cli.afterClose = { status: afterClose.status, stderr: afterClose.stderr.trim() };
    check("PKG-05", "grant is rejected after Topsl closes", afterClose.status === 1, result.cli.afterClose);
    // Restart / reopen the encrypted DB.
    session = await launch({ kind: "candidate", profile });
    await unlockUI(session.page);
    const s2 = await state(session.page);
    const reopenHits = await search(session.page, added.id, CANARY);
    check("PKG-04", "after restart the same project, conversation and messages are read back", s2.projects.some((p) => p.id === added.id) && JSON.stringify(reopenHits.map((m) => m.id).sort()) === JSON.stringify(result.hitsBefore.sort()), { projects: s2.projects.map((p) => p.id), hits: reopenHits.length });

    const revived = run(["status", grantFile]);
    result.cli.afterRestart = { status: revived.status, stderr: revived.stderr.trim() };
    check("PKG-05", "former grant is not revived by a new Topsl process", revived.status === 1, result.cli.afterRestart);
    result.reopenCloseMs = await close(session);
    session = null;
    const stored = inspectProfile(profile);
    result.storedRuns = stored.runs?.map((r) => ({ status: r.status, installationId: r.installationId, error: r.error }));
    const terminalRuns = (stored.runs ?? []).filter((r) => r.installationId === result.terminal.installationId);
    check("PKG-04", "stored terminal run (durable record) is closed, not left running, after close and restart", terminalRuns.length === 1 && !["starting", "running"].includes(terminalRuns[0].status), result.storedRuns);
  } catch (e) {
    check("PKG-04", "native scenario completed", false, String(e.stack ?? e).slice(0, 1200));
    await snapshotOnError(session, "native-error");
    if (session) await session.app.close().catch(() => kill(session));
  }
  notes.native = result;
  const footprintAfter = ownerFootprint();
  check("PKG-03", "owner's real Topsl profile unchanged during the native scenario", JSON.stringify(footprintBefore) === JSON.stringify(footprintAfter), { footprintBefore, footprintAfter });
  notes.keychain = { before: keysBefore, after: keychainItems() };
  check("DATA-02", "passphrase-vault journey created or changed no Topsl keychain item", JSON.stringify(keysBefore) === JSON.stringify(notes.keychain.after), notes.keychain);
  rmSync(root, { recursive: true, force: true });
}

async function osvault() {
  ensureBundle();
  const footprintBefore = ownerFootprint();
  const keysBefore = keychainItems();
  const root = tempProfile("osvault-root");
  const profile = path.join(root, "p");
  const project = makeProject(root);
  let session;
  try {
    session = await launch({ kind: "candidate", profile });
    await stubDialogs(session.app);
    const started = Date.now();
    const s = await settledLockReason(session.page, 60_000);
    notes.firstLaunch = { locked: s?.locked, lockReason: s?.lockReason ?? null, ms: Date.now() - started };
    check("DATA-01", "fresh profile with the OS store unlocks without a passphrase", s?.locked === false, notes.firstLaunch);
    if (s?.locked) {
      await snapshotOnError(session, "osvault-stuck");
      throw new Error(`os vault did not open: ${s?.lockReason}`);
    }
    const vault = JSON.parse(readFileSync(path.join(profile, "vault.json"), "utf8"));
    notes.vault = { method: vault.method, keys: Object.keys(vault).sort(), dataBytes: Buffer.from(vault.data, "base64").length, mode: (statSync(path.join(profile, "vault.json")).mode & 0o777).toString(8) };
    check("DATA-01", "vault.json uses method os, 0600, with only ciphertext (no 64-hex key)", vault.method === "os" && notes.vault.mode === "600" && !/[a-f0-9]{64}/.test(readFileSync(path.join(profile, "vault.json"), "utf8")), notes.vault);
    const added = await addProjectUI(session, project);
    await close(session);
    session = null;
    const hashes = fileHashes(profile, ["vault.json"]);
    session = await launch({ kind: "candidate", profile });
    const s2 = await settledLockReason(session.page, 60_000);
    check("DATA-01", "reopen unlocks from the OS store and recovers the same project id", s2?.locked === false && s2.projects.some((p) => p.id === added.id), { locked: s2?.locked, lockReason: s2?.lockReason });
    check("DATA-01", "reopen did not rewrite or replace vault.json (initialized once)", JSON.stringify(hashes) === JSON.stringify(fileHashes(profile, ["vault.json"])));
    await close(session);
    session = null;
    const files = readdirSync(profile);
    notes.files = files;
    check("DATA-01", "exactly one vault and one history database in the profile", files.filter((f) => f === "vault.json").length === 1 && files.filter((f) => /^history\.sqlite$/.test(f)).length === 1 && !files.some((f) => /vault.*\.tmp$/.test(f)), files);
  } catch (e) {
    check("DATA-01", "os-vault scenario completed", false, String(e.stack ?? e).slice(0, 800));
    await snapshotOnError(session, "osvault-error");
    if (session) await session.app.close().catch(() => kill(session));
  }
  const footprintAfter = ownerFootprint();
  check("DATA-01", "no accidental second profile: owner's Topsl profile unchanged", JSON.stringify(footprintBefore) === JSON.stringify(footprintAfter), { footprintBefore, footprintAfter });
  notes.keychain = { before: keysBefore, after: keychainItems() };
  notes.keychainNote = "The os vault encrypts its key with the pre-existing login-keychain item 'topsl Safe Storage' (service name derived from app name 'topsl'); this item is shared with the owner's own profile and with development runs.";
  check("DATA-01", "no new keychain item was created (existing 'topsl Safe Storage' reused)", keysBefore["Topsl Safe Storage"] === notes.keychain.after["Topsl Safe Storage"] && !!notes.keychain.after["topsl Safe Storage"], notes.keychain);
  rmSync(root, { recursive: true, force: true });
}

async function vaultfaults() {
  ensureBundle();
  const root = tempProfile("vaultfaults-root");
  const base = path.join(root, "base");
  seedPassphraseVault(base);
  const project = makeProject(root);
  let session = await launch({ kind: "candidate", profile: base });
  await stubDialogs(session.app);
  await unlockUI(session.page);
  const added = await addProjectUI(session, project);
  await close(session);
  const variants = {
    "missing-vault": (p) => unlinkSync(path.join(p, "vault.json")),
    "malformed-envelope": (p) => writeFileSync(path.join(p, "vault.json"), '{"method":"passphrase",'),
    "invalid-auth-tag": (p) => {
      const v = JSON.parse(readFileSync(path.join(p, "vault.json"), "utf8"));
      v.tag = (v.tag[0] === "0" ? "1" : "0") + v.tag.slice(1);
      writeFileSync(path.join(p, "vault.json"), JSON.stringify(v));
    },
    "unknown-format": (p) => {
      const v = JSON.parse(readFileSync(path.join(p, "vault.json"), "utf8"));
      writeFileSync(path.join(p, "vault.json"), JSON.stringify({ ...v, method: "hardware-token" }));
    },
    "os-key-unavailable": (p) =>
      writeFileSync(path.join(p, "vault.json"), JSON.stringify({ method: "os", data: randomBytes(48).toString("base64") })),
    "crash-before-rename": (p) => renameSync(path.join(p, "vault.json"), path.join(p, "vault.json.0123456789abcdef.tmp")),
  };
  notes.variants = {};
  let index = 0;
  for (const [name, mutate] of Object.entries(variants)) {
    const p = path.join(root, `f${++index}`);
    cpSync(base, p, { recursive: true });
    mutate(p);
    const tracked = readdirSync(p).filter((f) => /^(vault\.json.*|history\.sqlite(-wal)?)$/.test(f));
    const before = fileHashes(p, tracked);
    const record = { tracked };
    try {
      session = await launch({ kind: "candidate", profile: p });
      const s = await settledLockReason(session.page);
      record.lockReason = s?.lockReason ?? null;
      record.locked = s?.locked;
      if (name === "invalid-auth-tag") {
        await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(PASSPHRASE);
        await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
        await expect(session.page.getByText("Vault passphrase is incorrect.")).toBeVisible({ timeout: 30_000 });
        record.afterCorrectPassphrase = (await state(session.page)).lockReason;
      }
      const shown = (await state(session.page)).lockReason ?? "__none__";
      record.visible = await session.page.getByText(shown).first().isVisible().catch(() => false);
      record.stillLocked = (await state(session.page)).locked;
      await close(session);
      session = null;
    } catch (e) {
      record.error = String(e).slice(0, 300);
      await snapshotOnError(session, `vaultfault-${name}`);
      if (session) kill(session);
      session = null;
    }
    const after = fileHashes(p, tracked);
    record.preserved = JSON.stringify(before) === JSON.stringify(after);
    record.noReplacementVault = name === "missing-vault" || name === "crash-before-rename" ? !existsSync(path.join(p, "vault.json")) : true;
    record.filesAfter = readdirSync(p).filter((f) => /vault|history/.test(f));
    notes.variants[name] = record;
    const caseId = name === "crash-before-rename" ? "PKG-12" : "DATA-04";
    check(caseId, `${name}: stays locked with a visible reason, files byte-identical, no replacement key`, record.stillLocked === true && record.visible && record.preserved && record.noReplacementVault && !record.error, record);
  }
  // Recovery control: restoring the original vault file unlocks the same data.
  const recover = path.join(root, "f3");
  cpSync(path.join(base, "vault.json"), path.join(recover, "vault.json"));
  session = await launch({ kind: "candidate", profile: recover });
  await unlockUI(session.page);
  const s = await state(session.page);
  check("DATA-04", "after restoring the original vault file the preserved database unlocks with the same project", s.projects.some((p) => p.id === added.id));
  await close(session);
  rmSync(root, { recursive: true, force: true });
}

async function createOldProfile(version, root, { label = "clean" } = {}) {
  const profile = path.join(root, `v${version}-${label}`);
  seedPassphraseVault(profile);
  const project = makeProject(root, `p8 ${version} project`);
  const transcript = makeTranscript(root, project, `v${version.replaceAll(".", "")}`);
  const session = await launch({ kind: version, profile });
  try {
    await stubDialogs(session.app);
    await unlockUI(session.page);
    await setOpenPath(session.app, project);
    const addResult = await cmd(session.page, { type: "project-add" });
    let p;
    await expect
      .poll(async () => {
        p = (await state(session.page)).projects.find((x) => x.realPath === project || x.path === project);
        return !!p;
      }, { timeout: 20_000 })
      .toBe(true)
      .catch(async () => {
        throw new Error(`project-add in v${version} did not record the project: ${JSON.stringify({ addResult, projects: (await state(session.page)).projects, prompts: await prompts(session.app) }).slice(0, 1500)}`);
      });
    await cmd(session.page, { type: "conversation-add", projectId: p.id, title: "Chat before upgrade" });
    await setOpenPath(session.app, transcript);
    const imported = await cmd(session.page, { type: "history-import", projectId: p.id, provider: "codex" });
    await cmd(session.page, { type: "theme", theme: "night" });
    // The main process caches state from service events; wait until it shows the writes.
    await expect
      .poll(async () => {
        const s = await state(session.page);
        return s.theme === "night" && (await conversations(session.page, p.id, version)).length >= 2;
      }, { timeout: 20_000 })
      .toBe(true);
    const s = await state(session.page);
    const hits = await search(session.page, p.id, CANARY, version);
    const old = {
      version,
      projects: s.projects.map((x) => ({ id: x.id, realPath: x.realPath, trusted: x.trusted, name: x.name })),
      conversations: await conversations(session.page, p.id, version),
      hits: (hits.items ?? hits).map((m) => m.id).sort(),
      imported,
      theme: s.theme,
      installations: s.installations.map((i) => ({ id: i.id, appId: i.appId, trusted: i.trusted })),
      appVersion: s.version,
      isPackaged: await session.app.evaluate(({ app }) => app.isPackaged),
    };
    await session.page.screenshot({ path: path.join(evidence, `v${version}-${label}.png`) });
    await close(session);
    return { profile, project, transcript, old };
  } catch (e) {
    await snapshotOnError(session, `v${version}-create-error`);
    kill(session);
    throw e;
  }
}

async function upgrade(version) {
  ensureBundle();
  const footprintBefore = ownerFootprint();
  const keysBefore = keychainItems();
  const root = tempProfile(`upgrade-${version}`);
  const fixtures = path.join(WORK, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  const created = await createOldProfile(version, root);
  const { old } = created;
  notes.old = old;
  check("PKG-10", `v${version} (tag source, electron .) profile created with a project, conversations and imported history`, old.projects.length === 1 && old.conversations.length >= 2 && old.hits.length >= 2 && old.appVersion === version, old);
  const pre = inspectProfile(created.profile);
  notes.preUpgradeStore = { userVersion: pre.userVersion, kinds: pre.kinds, events: pre.events, files: pre.files };
  const pristine = path.join(fixtures, `v${version}-pristine`);
  rmSync(pristine, { recursive: true, force: true });
  cpSync(created.profile, pristine, { recursive: true });
  writeFileSync(path.join(fixtures, `v${version}-pristine.json`), JSON.stringify({ old, project: created.project }, null, 2));
  // Candidate opens the SAME profile (a copy, so the pristine fixture survives).
  const profile = path.join(root, "upgraded");
  cpSync(created.profile, profile, { recursive: true });
  let session;
  try {
    session = await launch({ kind: "candidate", profile });
    await stubDialogs(session.app);
    const prompt = await unlockUI(session.page);
    await expect(session.page.getByText("Local vault unlocked")).toBeVisible({ timeout: 45_000 });
    check("PKG-10", "candidate asks for the existing vault's passphrase and unlocks it (visible unlocked shell)", /Enter your vault passphrase/.test(prompt ?? ""), prompt);
    notes.landingHeading = await session.page.getByRole("heading", { level: 1 }).first().innerText().catch(() => null);
    const s = await state(session.page);
    const projectsNow = s.projects.map((x) => ({ id: x.id, realPath: x.realPath, trusted: x.trusted, name: x.name }));
    check("PKG-10", "projects preserved with the same ids, folders and trust", JSON.stringify(projectsNow) === JSON.stringify(old.projects), { old: old.projects, now: projectsNow });
    const convNow = await conversations(session.page, old.projects[0].id);
    const convOld = [...old.conversations].sort((a, b) => a.id.localeCompare(b.id));
    check("PKG-10", "conversations preserved with the same ids and titles", convOld.length >= 2 && JSON.stringify(convNow) === JSON.stringify(convOld), { old: convOld, now: convNow });
    const hits = (await search(session.page, old.projects[0].id, CANARY)).map((m) => m.id).sort();
    check("PKG-10", "imported messages searchable with the same ids after migration", JSON.stringify(hits) === JSON.stringify(old.hits), { old: old.hits, now: hits });
    check("PKG-10", "owner preference (theme) preserved", s.theme === old.theme, { old: old.theme, now: s.theme });
    const loops = await cmd(session.page, { type: "loop-query", projectId: old.projects[0].id });
    const privileges = {
      claudeStructuredRoute: s.claudeStructuredRoute,
      claudeTranscriptRead: s.claudeTranscriptRead,
      autoAccept: s.autoAccept,
      loopsEnabled: loops.enabled,
      projectSync: s.projectSync?.enabled,
      codexProjectSync: s.codexProjectSync?.enabled,
      trustedInstallations: s.installations.filter((i) => i.trusted).map((i) => i.appId),
      testProfile: s.testProfile,
    };
    notes.privileges = privileges;
    check("PKG-10", "no privilege widening: Claude structured route off, loops off, auto-accept off, discovery/sync off, no trusted executables", privileges.claudeStructuredRoute?.enabled === false && privileges.loopsEnabled === false && privileges.autoAccept === "off" && !privileges.projectSync && !privileges.codexProjectSync && privileges.trustedInstallations.length === 0 && privileges.testProfile === false, privileges);
    // An upgraded profile has no remembered project selection; choose it as the owner would.
    await selectProject(session.page, old.projects[0].name);
    notes.terminal = await terminalJourney(session, root, "J-12");
    notes.moduleErrors = moduleErrors(session.logs);
    check("J-12", "no missing-module or wrong-ABI errors", notes.moduleErrors.length === 0, notes.moduleErrors);
    await session.page.screenshot({ path: path.join(evidence, `candidate-on-v${version}.png`) });
    await close(session);
    session = null;
  } catch (e) {
    check("PKG-10", "candidate upgrade session completed", false, String(e.stack ?? e).slice(0, 1200));
    await snapshotOnError(session, "upgrade-error");
    if (session) kill(session);
    session = null;
  }
  const post = inspectProfile(profile);
  notes.postUpgradeStore = { userVersion: post.userVersion, integrity: post.integrity, kinds: post.kinds, events: post.events, backups: post.backups, files: post.files };
  check("PKG-10", "store migrated to schema 6 with integrity ok", post.userVersion === 6 && post.integrity === "ok", { userVersion: post.userVersion, integrity: post.integrity });
  const preIds = Object.keys(pre.digests ?? {});
  const missing = preIds.filter((k) => !(k in (post.digests ?? {})));
  check("PKG-10", "every pre-upgrade document identity is still present after migration", missing.length === 0, missing);
  notes.rewrittenDocuments = preIds.filter((k) => post.digests?.[k] && post.digests[k] !== pre.digests[k]);
  const msgSame = JSON.stringify(pre.messages) === JSON.stringify(post.messages);
  check("PKG-10", "message records (ids, text, attribution) byte-equivalent in the decoded fields", msgSame, { pre: pre.messages?.length, post: post.messages?.length });
  if (pre.userVersion < 6)
    check("PKG-10", "encrypted migration backup(s) created, readable with the same key, at the old schema", post.backups?.length >= 1 && post.backups.every((b) => b.integrity === "ok") && post.backups.some((b) => b.userVersion === pre.userVersion), post.backups);
  else notes.backupNote = `v${version} profile already at schema ${pre.userVersion}; no migration and no backup expected. Backups: ${JSON.stringify(post.backups)}`;
  const migrated = path.join(fixtures, `v${version}-migrated`);
  rmSync(migrated, { recursive: true, force: true });
  cpSync(profile, migrated, { recursive: true });
  // J-12 reopen.
  try {
    session = await launch({ kind: "candidate", profile });
    await unlockUI(session.page);
    const s = await state(session.page);
    const convReopen = await conversations(session.page, old.projects[0].id);
    check("J-12", "candidate reopen after upgrade: same project and conversations", s.projects.map((p) => p.id).join() === old.projects.map((p) => p.id).join() && old.conversations.every((c) => convReopen.some((x) => x.id === c.id)));
    await close(session);
    session = null;
  } catch (e) {
    check("J-12", "candidate reopen completed", false, String(e).slice(0, 600));
    if (session) kill(session);
    session = null;
  }
  // DATA-08 K: the older writer reopens the migrated profile.
  const back = path.join(root, "back-to-old");
  cpSync(profile, back, { recursive: true });
  const tracked = ["vault.json", "history.sqlite"];
  const beforeBack = fileHashes(back, tracked);
  const baseline = inspectProfile(back);
  const backRecord = {};
  try {
    session = await launch({ kind: version, profile: back });
    await stubDialogs(session.app);
    await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(PASSPHRASE);
    await settledLockReason(session.page);
    await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
    await sleep(4000);
    const s = await state(session.page);
    backRecord.locked = s.locked;
    backRecord.lockReason = s.lockReason ?? null;
    backRecord.serviceError = s.serviceError ?? null;
    backRecord.projects = s.projects?.map((p) => p.id) ?? [];
    backRecord.conversations = s.locked ? [] : (await conversations(session.page, old.projects[0].id, version).catch(() => [])).map((c) => c.id);
    await session.page.screenshot({ path: path.join(evidence, `v${version}-reopens-migrated.png`) });
    await close(session);
    session = null;
  } catch (e) {
    backRecord.error = String(e).slice(0, 400);
    await snapshotOnError(session, "older-writer");
    if (session) kill(session);
    session = null;
  }
  backRecord.mainFilesUnchanged = JSON.stringify(beforeBack) === JSON.stringify(fileHashes(back, tracked));
  const backInspect = inspectProfile(back);
  backRecord.afterOlderWriter = { userVersion: backInspect.userVersion, integrity: backInspect.integrity, kinds: backInspect.kinds };
  backRecord.documentsLost = Object.keys(baseline.digests ?? {}).filter((k) => !(k in (backInspect.digests ?? {})));
  backRecord.documentsChanged = Object.keys(baseline.digests ?? {}).filter((k) => backInspect.digests?.[k] && backInspect.digests[k] !== baseline.digests[k]);
  backRecord.documentsAdded = Object.keys(backInspect.digests ?? {}).filter((k) => !(k in (baseline.digests ?? {})));
  notes.olderWriter = backRecord;
  if (pre.userVersion < 6)
    check("DATA-08", `v${version} refuses the schema-6 profile as newer, stays locked, and the files are byte-identical`, backRecord.locked !== false && /newer Topsl version/.test(`${backRecord.lockReason} ${backRecord.serviceError}`) && backRecord.mainFilesUnchanged && backRecord.documentsLost.length === 0, backRecord);
  else {
    check("DATA-08", `v${version} (same schema 6) opens the candidate-written profile without losing any document`, backRecord.locked === false && backRecord.documentsLost.length === 0 && old.projects.every((p) => backRecord.projects.includes(p.id)), backRecord);
    // And the candidate can still open it afterwards.
    try {
      session = await launch({ kind: "candidate", profile: back });
      await unlockUI(session.page);
      const s = await state(session.page);
      check("DATA-08", "candidate reopens the profile after the older same-schema writer used it", s.projects.some((p) => p.id === old.projects[0].id));
      await close(session);
      session = null;
    } catch (e) {
      check("DATA-08", "candidate reopen after older writer", false, String(e).slice(0, 400));
      if (session) kill(session);
      session = null;
    }
  }
  if (version === "0.1.2") await uncertainRunUpgrade(root, pristine);
  const footprintAfter = ownerFootprint();
  check("PKG-10", "owner's Topsl profile unchanged during upgrade runs", JSON.stringify(footprintBefore) === JSON.stringify(footprintAfter), { footprintBefore, footprintAfter });
  notes.keychain = { before: keysBefore, after: keychainItems() };
  check("PKG-10", "no Topsl keychain item created or changed by the passphrase upgrade journeys", JSON.stringify(keysBefore) === JSON.stringify(notes.keychain.after), notes.keychain);
  rmSync(root, { recursive: true, force: true });
}

// PKG-11 (partial): a v0.1.2 native terminal run left running by a hard kill,
// then the candidate opens the profile. It must not replay or report success.
async function uncertainRunUpgrade(root, pristine) {
  const profile = path.join(root, "uncertain");
  cpSync(pristine, profile, { recursive: true });
  const meta = JSON.parse(readFileSync(path.join(path.dirname(pristine), "v0.1.2-pristine.json"), "utf8"));
  const record = {};
  let session = await launch({ kind: "0.1.2", profile });
  const standin = makeStandin(path.join(root, "uncertain-standin"));
  try {
    await stubDialogs(session.app);
    await unlockUI(session.page);
    await setOpenPath(session.app, standin.executable);
    const installation = await cmd(session.page, { type: "select-runtime" });
    await expect.poll(async () => (await state(session.page)).installations.some((i) => i.id === installation.id), { timeout: 20_000 }).toBe(true);
    await cmd(session.page, { type: "trust-installation", id: installation.id });
    await expect.poll(async () => (await state(session.page)).installations.find((i) => i.id === installation.id)?.trusted, { timeout: 20_000 }).toBe(true);
    const projectId = meta.old.projects[0].id;
    const terminalId = await cmd(session.page, { type: "terminal-open", projectId, installationId: installation.id, login: false });
    await expect.poll(() => standin.events().some((e) => e.event === "start"), { timeout: 20_000 }).toBe(true);
    const start = standin.events().find((e) => e.event === "start");
    record.terminalId = terminalId;
    record.killed = kill(session).length;
    session = null;
    await sleep(1500);
    const killedStore = inspectProfile(profile);
    const before = killedStore.runs?.find((r) => r.id === terminalId);
    record.beforeUpgrade = before && { status: before.status, nativePid: before.nativePid };
    record.standinAliveAfterKill = alive(start.pid);
    if (record.standinAliveAfterKill) process.kill(start.pid, "SIGKILL");
    const startsBefore = standin.events().filter((e) => e.event === "start").length;
    session = await launch({ kind: "candidate", profile });
    await unlockUI(session.page);
    await sleep(3000);
    record.replayed = standin.events().filter((e) => e.event === "start").length > startsBefore;
    await close(session);
    session = null;
    const after = inspectProfile(profile);
    const run = after.runs?.find((r) => r.id === terminalId);
    record.afterUpgrade = run && { status: run.status, error: run.error };
    record.operationIntents = after.kinds?.["operation-intent"] ?? 0;
    check("PKG-11", "a run left running by a hard-killed v0.1.2 is not reported running or completed by the candidate and is not replayed", before?.status === "running" && !!run && !["running", "starting", "completed"].includes(run.status) && !record.replayed, record);
  } catch (e) {
    record.error = String(e.stack ?? e).slice(0, 800);
    check("PKG-11", "uncertain-run upgrade completed", false, record);
    await snapshotOnError(session, "uncertain-error");
    if (session) kill(session);
  }
  notes.uncertainRun = record;
}

async function faults() {
  ensureBundle();
  const pristine = path.join(WORK, "fixtures", "v0.1.1-pristine");
  const meta = JSON.parse(readFileSync(`${pristine}.json`, "utf8"));
  const root = tempProfile("faults");
  notes.kills = [];
  for (const delay of [0, 120, 400, 1200]) {
    const p = path.join(root, `kill-${delay}`);
    cpSync(pristine, p, { recursive: true });
    const record = { delay };
    let session = await launch({ kind: "candidate", profile: p });
    try {
      await settledLockReason(session.page);
      await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(PASSPHRASE);
      await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
      await sleep(delay);
      record.killed = kill(session).length;
      session = null;
      await sleep(800);
      const mid = inspectProfile(p);
      record.afterKill = { userVersion: mid.userVersion, integrity: mid.integrity, backups: mid.backups?.map((b) => [b.userVersion, b.integrity]), error: mid.error ?? null };
      session = await launch({ kind: "candidate", profile: p });
      await unlockUI(session.page);
      const s = await state(session.page);
      record.recovered = {
        projects: s.projects.map((x) => x.id).join() === meta.old.projects.map((x) => x.id).join(),
        conversations: await conversations(session.page, meta.old.projects[0].id).then((list) => meta.old.conversations.every((c) => list.some((x) => x.id === c.id))),
        hits: JSON.stringify((await search(session.page, meta.old.projects[0].id, CANARY)).map((m) => m.id).sort()) === JSON.stringify(meta.old.hits),
      };
      await close(session);
      session = null;
      const end = inspectProfile(p);
      record.final = { userVersion: end.userVersion, integrity: end.integrity, backups: end.backups?.length };
    } catch (e) {
      record.error = String(e.stack ?? e).slice(0, 600);
      await snapshotOnError(session, `kill-${delay}`);
      if (session) kill(session);
    }
    notes.kills.push(record);
    // Each migration step (1->2 ... 5->6) commits separately, so a kill can
    // leave any committed step; integrity and resumption are the contract.
    check("PKG-12", `SIGKILL ${delay} ms after unlock during migration/startup: a committed schema (1..6) with integrity ok and readable backups, then recovers all records at schema 6`, !record.error && record.afterKill?.userVersion >= 1 && record.afterKill?.userVersion <= 6 && record.afterKill?.integrity === "ok" && (record.afterKill?.backups ?? []).every((b) => b[1] === "ok") && record.recovered?.projects && record.recovered?.conversations && record.recovered?.hits && record.final?.userVersion === 6, record);
  }
  // Disk full during migration on a small disposable disk image.
  const image = path.join(root, "full.dmg");
  const mount = path.join(root, "fullvol");
  mkdirSync(mount);
  const record = {};
  let attached = false;
  try {
    const created = sh("/usr/bin/hdiutil", ["create", "-size", "24m", "-fs", "HFS+", "-volname", "p8full", "-layout", "NONE", image]);
    if (created.status !== 0) throw new Error(`hdiutil create: ${created.stderr}`);
    const att = sh("/usr/bin/hdiutil", ["attach", "-nobrowse", "-noautoopen", "-mountpoint", mount, image]);
    if (att.status !== 0) throw new Error(`hdiutil attach: ${att.stderr}`);
    attached = true;
    const p = path.join(mount, "profile");
    cpSync(pristine, p, { recursive: true });
    // Let Chromium create its own profile files first, then fill the volume so
    // the migration backup copy cannot be written.
    let session = await launch({ kind: "candidate", profile: p });
    await settledLockReason(session.page);
    const filler = path.join(mount, "filler");
    sh("/bin/dd", ["if=/dev/zero", `of=${filler}`, "bs=1m"]);
    sh("/bin/dd", ["if=/dev/zero", `of=${filler}-small`, "bs=4k"]);
    record.freeBytes = sh("/bin/df", ["-k", mount]).stdout.trim().split("\n").at(-1);
    await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(PASSPHRASE);
    await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
    await sleep(6000);
    const s = await state(session.page).catch((e) => ({ error: String(e) }));
    record.duringFull = { locked: s.locked, lockReason: s.lockReason ?? null, serviceError: s.serviceError ?? null, projects: s.projects?.length ?? null };
    await session.page.screenshot({ path: path.join(evidence, "disk-full.png") }).catch(() => {});
    record.closedCleanly = await session.app.close().then(() => true, () => false);
    if (!record.closedCleanly) kill(session);
    unlinkSync(filler);
    unlinkSync(`${filler}-small`);
    const mid = inspectProfile(p);
    record.afterFull = { userVersion: mid.userVersion, integrity: mid.integrity, backups: mid.backups?.map((b) => [b.name.replace(/backup-.*/, "backup-*"), b.userVersion, b.integrity]), error: mid.error ?? null };
    session = await launch({ kind: "candidate", profile: p });
    await unlockUI(session.page);
    const s2 = await state(session.page);
    const list = await conversations(session.page, meta.old.projects[0].id);
    record.recovered = s2.projects.map((x) => x.id).join() === meta.old.projects.map((x) => x.id).join() && meta.old.conversations.every((c) => list.some((x) => x.id === c.id));
    await close(session);
    const end = inspectProfile(p);
    record.final = { userVersion: end.userVersion, integrity: end.integrity };
    check("PKG-12", "disk full during migration: no false empty unlocked profile; data intact at a committed schema; recovers after space is freed", !(record.duringFull.locked === false && record.duringFull.projects === 0) && record.afterFull.userVersion >= 1 && record.afterFull.userVersion <= 6 && record.afterFull.integrity === "ok" && record.recovered && record.final.userVersion === 6, record);
    check("PKG-12", "disk full: the visible reason names the storage problem (precise recovery path)", /disk|space|full|storage|ENOSPC/i.test(`${record.duringFull.lockReason} ${record.duringFull.serviceError}`), record.duringFull);
  } catch (e) {
    record.error = String(e.stack ?? e).slice(0, 800);
    check("PKG-12", "disk-full scenario completed", false, record);
  } finally {
    if (attached) sh("/usr/bin/hdiutil", ["detach", mount, "-force"]);
  }
  notes.diskFull = record;
  rmSync(root, { recursive: true, force: true });
}

async function restore() {
  ensureBundle();
  const migrated = path.join(WORK, "fixtures", "v0.1.1-migrated");
  const meta = JSON.parse(readFileSync(path.join(WORK, "fixtures", "v0.1.1-pristine.json"), "utf8"));
  const root = tempProfile("restore");
  // (a) Restore the encrypted migration backup into a NEW profile.
  const backupName = readdirSync(migrated).find((f) => /^history\.sqlite\.schema-1\.backup-/.test(f));
  const r1 = path.join(root, "restored-backup");
  mkdirSync(r1, { mode: 0o700 });
  cpSync(path.join(migrated, "vault.json"), path.join(r1, "vault.json"));
  cpSync(path.join(migrated, backupName), path.join(r1, "history.sqlite"));
  const rec = { backupName: backupName?.replace(/backup-.*/, "backup-*") };
  let session;
  try {
    session = await launch({ kind: "0.1.1", profile: r1 });
    await unlockUI(session.page);
    const s = await state(session.page);
    rec.v011 = { projects: s.projects.map((p) => p.id), conversations: (await conversations(session.page, s.projects[0]?.id, "0.1.1")).length };
    await close(session);
    session = await launch({ kind: "candidate", profile: r1 });
    await unlockUI(session.page);
    const s2 = await state(session.page);
    rec.candidate = { projects: s2.projects.map((p) => p.id), conversations: (await conversations(session.page, s2.projects[0]?.id)).length };
    await close(session);
    session = null;
    const after = inspectProfile(r1);
    rec.after = { userVersion: after.userVersion, integrity: after.integrity, backups: after.backups?.length };
  } catch (e) {
    rec.error = String(e.stack ?? e).slice(0, 600);
    await snapshotOnError(session, "restore-error");
    if (session) kill(session);
    session = null;
  }
  notes.restoreBackup = rec;
  check("PKG-13", "schema-1 migration backup + original vault restored to a new profile: v0.1.1 reads it and the candidate re-migrates it with the same ids", !rec.error && rec.v011?.projects.join() === meta.old.projects.map((p) => p.id).join() && rec.candidate?.projects.join() === rec.v011.projects.join() && rec.after?.userVersion === 6, rec);
  // (b) Unknown future schema.
  const r2 = path.join(root, "future");
  cpSync(migrated, r2, { recursive: true });
  for (const f of readdirSync(r2)) if (/backup-/.test(f)) unlinkSync(path.join(r2, f));
  setUserVersion(r2, 7);
  const before = fileHashes(r2, ["vault.json", "history.sqlite"]);
  const fut = {};
  try {
    session = await launch({ kind: "candidate", profile: r2 });
    await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(PASSPHRASE);
    await settledLockReason(session.page);
    await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
    await sleep(4000);
    const s = await state(session.page);
    fut.locked = s.locked;
    fut.reason = s.lockReason ?? s.serviceError ?? null;
    fut.visible = await session.page.getByText(/newer Topsl version/).first().isVisible().catch(() => false);
    await close(session);
    session = null;
  } catch (e) {
    fut.error = String(e).slice(0, 400);
    if (session) kill(session);
    session = null;
  }
  fut.unchanged = JSON.stringify(before) === JSON.stringify(fileHashes(r2, ["vault.json", "history.sqlite"]));
  fut.noBackup = !readdirSync(r2).some((f) => /backup-/.test(f));
  notes.futureSchema = fut;
  check("PKG-13", "unknown future schema 7: candidate refuses as newer, stays locked, files byte-identical, no backup or downgrade", fut.locked !== false && /newer Topsl version/.test(fut.reason ?? "") && fut.visible && fut.unchanged && fut.noBackup, fut);
  rmSync(root, { recursive: true, force: true });
}

async function removal() {
  ensureBundle();
  const footprintBefore = ownerFootprint();
  const root = tempProfile("removal");
  const copy = path.join(root, "Applications", "Topsl.app");
  mkdirSync(path.dirname(copy), { recursive: true });
  execFileSync("/usr/bin/ditto", [BUNDLE, copy]);
  const profile = path.join(root, "p");
  seedPassphraseVault(profile);
  const project = makeProject(root);
  const rec = {};
  let session;
  try {
    session = await launch({ kind: "candidate", profile, bundle: copy });
    await stubDialogs(session.app);
    rec.execPathInCopy = realpathSync(await session.app.evaluate(() => process.execPath)).startsWith(realpathSync(copy));
    await unlockUI(session.page);
    const added = await addProjectUI(session, project);
    await close(session);
    session = null;
    const tracked = readdirSync(profile).filter((f) => /^(vault\.json|history\.sqlite.*)$/.test(f));
    const before = fileHashes(profile, tracked);
    rmSync(copy, { recursive: true, force: true });
    rec.copyRemoved = !existsSync(copy);
    rec.profileUnchanged = JSON.stringify(before) === JSON.stringify(fileHashes(profile, tracked));
    session = await launch({ kind: "candidate", profile });
    await unlockUI(session.page);
    rec.reopenedWithOtherCopy = (await state(session.page)).projects.some((p) => p.id === added.id);
    await close(session);
    session = null;
    rec.projectFolderIntact = existsSync(path.join(project, "README.md"));
  } catch (e) {
    rec.error = String(e.stack ?? e).slice(0, 600);
    await snapshotOnError(session, "removal-error");
    if (session) kill(session);
  }
  rec.ownerAndNativeHomesUnchanged = JSON.stringify(footprintBefore) === JSON.stringify(ownerFootprint());
  const docs = sh("/usr/bin/grep", ["-rniE", "uninstall|remove (the )?app|delete (the )?app|Application Support/Topsl", `${CLEAN}/README.md`, `${CLEAN}/docs`]);
  rec.removalDocs = docs.stdout.trim().split("\n").filter(Boolean).slice(0, 12).map((l) => l.replace(CLEAN + "/", ""));
  notes.removal = rec;
  check("PKG-14", "deleting the app bundle leaves the profile byte-identical; another copy reopens the same data; project folder and native homes untouched", rec.execPathInCopy && rec.copyRemoved && rec.profileUnchanged && rec.reopenedWithOtherCopy && rec.projectFolderIntact && rec.ownerAndNativeHomesUnchanged && !rec.error, rec);
  rmSync(root, { recursive: true, force: true });
}

// Boundary: <userData>/context.sock at 104 bytes (macOS sun_path size) versus
// 105 bytes. The vault and history do not depend on the socket, so both should
// unlock; the context connection could fail separately.
async function longpath() {
  ensureBundle();
  const base = realpathSync(os.tmpdir());
  notes.lengths = {};
  for (const length of [104, 105]) {
    const prefix = path.join(base, "p8L-");
    const pad = length - (prefix.length + "/context.sock".length);
    const profile = prefix + "x".repeat(pad);
    rmSync(profile, { recursive: true, force: true });
    seedPassphraseVault(profile);
    const socketPath = path.join(profile, "context.sock");
    const record = { socketPathBytes: Buffer.byteLength(socketPath) };
    let session;
    try {
      session = await launch({ kind: "candidate", profile });
      await settledLockReason(session.page);
      await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(PASSPHRASE);
      await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
      await expect.poll(async () => (await state(session.page)).lockReason !== "Enter your vault passphrase to unlock local history." , { timeout: 30_000 }).toBe(true).catch(() => {});
      await sleep(3000);
      const s = await state(session.page);
      record.locked = s.locked;
      record.lockReason = s.lockReason?.replace(base, "<tmp>") ?? null;
      record.historyCreated = existsSync(path.join(profile, "history.sqlite"));
      await session.page.screenshot({ path: path.join(evidence, `longpath-${length}.png`) });
      await close(session);
    } catch (e) {
      record.error = String(e).slice(0, 300);
      if (session) kill(session);
    }
    notes.lengths[length] = record;
    // PKG-03 (D-09, fixed): at d4b788e a context.sock path of 104 bytes or more kept the vault locked (listen EINVAL).
    check("PKG-03", `isolated --user-data-dir with a ${length}-byte context socket path unlocks`, record.locked === false, record);
    rmSync(profile, { recursive: true, force: true });
  }
}

const scenarios = {
  longpath,
  identity,
  native,
  osvault,
  vaultfaults,
  "upgrade-v011": () => upgrade("0.1.1"),
  "upgrade-v012": () => upgrade("0.1.2"),
  faults,
  restore,
  removal,
};
if (!scenarios[scenario]) {
  console.error(`Usage: campaign-packaged-test.mjs <${Object.keys(scenarios).join("|")}>`);
  process.exit(2);
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This harness targets the local darwin-arm64 package.");
try {
  await scenarios[scenario]();
} catch (e) {
  check(scenario, "scenario threw", false, String(e.stack ?? e).slice(0, 1500));
}
saveReport();
