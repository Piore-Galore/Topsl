// Campaign packet p8-packaged-upgrade: packaged-app acceptance harness
// (19 October 2026; updated 4 November 2026 for the 0.1.3 package and the
// session-first screens of docs/UX_Cleanup_Plan.md).
//
// Drives the real extracted Topsl.app (not `electron .`) with Playwright's
// `_electron`, always with a fresh temporary `--user-data-dir`, and an
// environment without ELECTRON_RUN_AS_NODE / TOPSL_TEST_PROFILE (except the one
// negative control that proves a packaged app ignores TOPSL_TEST_PROFILE).
// Older releases are built from their tags (`prepare-old <version>`) and run
// as `electron <source>` in an isolated TOPSL_TEST_PROFILE, only to create
// realistic earlier profiles.
//
// Offline by default. A packaged app (and an old release outside a test
// profile) searches this Mac for the Codex and Claude Code CLIs and then
// fetches their release metadata. Every launch therefore runs under
// `sandbox-exec` with a profile that denies outbound IP traffic except
// loopback and the DNS resolver socket (`NET-00` checks this first), with
// Chromium's own sandbox off (`--no-sandbox`: a second Seatbelt profile cannot
// be applied inside the first) and Chromium's mock keychain
// (`--use-mock-keychain`), so no keychain prompt or item is involved. HOME,
// CODEX_HOME and CLAUDE_CONFIG_DIR point inside the work folder. Discovery
// still runs the installed CLIs' `--version`; their release checks fail
// offline. TOPSL_CAMPAIGN_OFFLINE=0 turns the guard off.
//
// Run from the checkout holding the package (npm run package -- --mac --arm64):
//   <cleanenv.sh> node scripts/campaign-packaged-test.mjs <scenario> [version]
// Scenarios: identity native osvault vaultfaults prepare-old upgrade-v012
//            upgrade-v013 faults restore removal longpath
// Environment: TOPSL_CAMPAIGN_CLEAN (checkout holding release/ and dist/,
// default this checkout), TOPSL_CAMPAIGN_ZIP_SHA256 (expected archive hash),
// TOPSL_CAMPAIGN_V011/V012/V013 (built old sources, default
// <P8_WORK>/old/v<version>), TOPSL_CAMPAIGN_PACKAGED_EVIDENCE
// (default test-results/campaign-packaged), P8_WORK.
//
// Vaults are passphrase vaults written by the harness in the product's exact
// format (apps/desktop/vault.ts). `osvault` needs the real login keychain and
// runs only with TOPSL_CAMPAIGN_KEYCHAIN=1; the disk-full part of `faults`
// mounts a disk image and runs only with TOPSL_CAMPAIGN_DISK_IMAGE=1.
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
  symlinkSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  cpSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import { navigate, selectProject } from "./desktop-navigation.mjs";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLEAN = process.env.TOPSL_CAMPAIGN_CLEAN ?? REPO;
const VERSION = JSON.parse(readFileSync(`${CLEAN}/package.json`, "utf8")).version;
const WORK = process.env.P8_WORK ?? path.join(os.tmpdir(), "topsl-p8-work");
// Old sources live in the disposable work folder, not in node_modules: each
// links back to this checkout's node_modules, which would otherwise contain a
// link to itself.
const OLD = Object.fromEntries(
  ["0.1.1", "0.1.2", "0.1.3"].map((v) => [
    v,
    process.env[`TOPSL_CAMPAIGN_V${v.replaceAll(".", "").slice(0, 3)}`] ??
      path.join(WORK, "old", `v${v}`),
  ]),
);
const EVIDENCE_ROOT =
  process.env.TOPSL_CAMPAIGN_PACKAGED_EVIDENCE ?? `${REPO}/test-results/campaign-packaged`;
const ZIP = process.env.TOPSL_CAMPAIGN_ZIP ?? `${CLEAN}/release/Topsl-${VERSION}-mac-arm64.zip`;
const ZIP_SHA256 = process.env.TOPSL_CAMPAIGN_ZIP_SHA256 ?? null;
const BUILT_APP = `${CLEAN}/release/mac-arm64/Topsl.app`;
const ELECTRON = `${CLEAN}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
const BUNDLE = process.env.P8_BUNDLE ?? path.join(WORK, "extracted", "Topsl.app");
const PASSPHRASE = "Campaign p8 vault passphrase ✓ 2026";
// apps/desktop/main.ts: an isolated test profile's fixed passphrase. Earlier
// profiles are created in old releases' test profiles, so they carry it.
const TEST_PASSPHRASE = "Topsl isolated test passphrase";
const CANARY = "quartzharbor";
const OFFLINE = process.env.TOPSL_CAMPAIGN_OFFLINE !== "0";
const require = createRequire(path.join(CLEAN, "package.json"));
const { _electron: electron, expect } = require("@playwright/test");

const scenario = process.argv[2];
const evidence = path.join(EVIDENCE_ROOT, scenario ?? "none");
mkdirSync(evidence, { recursive: true });
mkdirSync(WORK, { recursive: true });
const checks = [];
const notes = {};
const blocked = [];
const startedAt = new Date().toISOString();

function check(caseId, name, ok, detail = null) {
  checks.push({ caseId, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${caseId}] ${name}${detail !== null && !ok ? ` :: ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  return !!ok;
}
/** A case this run could not exercise, with the reason; never a pass. */
function block(caseId, name, reason) {
  blocked.push({ caseId, name, reason });
  console.log(`BLOCKED [${caseId}] ${name} :: ${reason}`);
}
const sha256File = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (v) => "'" + String(v).replaceAll("'", "'\\''") + "'";
function sh(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 180_000, ...options });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// --- Offline guard -----------------------------------------------------------
const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(allow network-outbound (remote ip "localhost:*"))
`;
// The loopback allowance must come last: a later deny for the resolver
// socket otherwise also refuses loopback connections (observed 4 November 2026).
const sandboxFile = path.join(WORK, "offline.sb");
/** An executable that runs `executable` under the offline Seatbelt profile. */
function offline(executable) {
  if (!OFFLINE) return executable;
  writeFileSync(sandboxFile, SANDBOX_PROFILE);
  const wrapper = path.join(
    WORK,
    `offline-${createHash("sha256").update(executable).digest("hex").slice(0, 12)}.sh`,
  );
  writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${q(sandboxFile)} ${q(executable)} "$@"\n`);
  chmodSync(wrapper, 0o700);
  return wrapper;
}
const guardArgs = () => (OFFLINE ? ["--no-sandbox", "--use-mock-keychain"] : ["--use-mock-keychain"]);
/** NET-00: under the guard, loopback connects and anything else is refused locally. */
function offlineProbe() {
  if (!OFFLINE) {
    block("NET-00", "offline guard", "TOPSL_CAMPAIGN_OFFLINE=0: launches may contact release metadata services");
    return;
  }
  writeFileSync(sandboxFile, SANDBOX_PROFILE);
  const probe = path.join(WORK, "offline-probe.cjs");
  writeFileSync(
    probe,
    `const net = require("node:net"), http = require("node:http");
const tryConnect = (o) => new Promise((resolve) => { const s = net.connect({ ...o, timeout: 3000 }); s.on("connect", () => { s.destroy(); resolve("connected"); }); s.on("timeout", () => { s.destroy(); resolve("timeout"); }); s.on("error", (e) => resolve("error " + e.code)); });
const server = http.createServer((q, r) => r.end()).listen(0, "127.0.0.1", async () => {
  const result = { loopback: await tryConnect({ host: "127.0.0.1", port: server.address().port }),
    testNet: await tryConnect({ host: "192.0.2.1", port: 443 }),
    resolver: await tryConnect({ path: "/private/var/run/mDNSResponder" }) };
  server.close(); console.log(JSON.stringify(result));
});`,
  );
  // 192.0.2.1 is TEST-NET-1 (RFC 5737): documentation-only and never routed.
  const r = sh("/usr/bin/sandbox-exec", ["-f", sandboxFile, process.execPath, probe]);
  let result = null;
  try {
    result = JSON.parse(r.stdout.trim());
  } catch {}
  notes.offlineGuard = { profile: SANDBOX_PROFILE, probe: result ?? r.stderr.trim() };
  if (!check("NET-00", "offline guard: loopback connects, TEST-NET and the DNS resolver socket are refused", result?.loopback === "connected" && result?.testNet === "error EPERM" && result?.resolver === "error EPERM", notes.offlineGuard.probe))
    throw new Error("The offline guard is not effective; no app is launched.");
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
/** HOME, CODEX_HOME and CLAUDE_CONFIG_DIR inside `home`, so no native home of the owner is read. */
function nativeHome(home = path.join(WORK, "native-home")) {
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  return { HOME: home, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
}
// Short temporary roots: the product's context socket lives at
// <userData>/context.sock, and macOS limits a socket path to 104 bytes (see the
// longpath scenario).
function tempProfile(label) {
  return mkdtempSync(path.join(os.tmpdir(), `p8${label.replace(/[^a-z0-9]/gi, "").slice(0, 4)}-`));
}
/** An old release's isolated test profile: a new topsl-test-* folder in the OS temporary directory. */
function testProfile(label) {
  return mkdtempSync(path.join(os.tmpdir(), `topsl-test-p8${label.replace(/[^a-z0-9]/gi, "").slice(0, 4)}-`));
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
function helper(args) {
  const r = sh(ELECTRON, [`${REPO}/scripts/campaign-upgrade-profile.mjs`, ...args], {
    env: { ...childEnv(), ELECTRON_RUN_AS_NODE: "1" },
  });
  if (r.status !== 0) return { error: r.stderr.trim().split("\n").slice(0, 3).join(" ") };
  return JSON.parse(r.stdout);
}
const inspectProfile = (profile, passphrase = PASSPHRASE) => helper(["inspect", profile, passphrase]);
function setUserVersion(profile, version, passphrase = PASSPHRASE) {
  const r = helper(["set-user-version", profile, passphrase, String(version)]);
  if (r.error) throw new Error(r.error);
  return r;
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
// Metadata only (no -g/-w): whether the items exist and when they changed.
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
/**
 * `candidate` launches the extracted package with --user-data-dir; an old
 * version runs `electron <source>` in the isolated test profile `profile`.
 */
async function launch({ kind, profile, bundle = BUNDLE, env = {}, home }) {
  const options =
    kind === "candidate"
      ? {
          executablePath: offline(path.join(bundle, "Contents/MacOS/Topsl")),
          args: [...guardArgs(), `--user-data-dir=${profile}`],
          env: childEnv({ ...nativeHome(home), ...env }),
        }
      : {
          executablePath: offline(ELECTRON),
          args: [...guardArgs(), OLD[kind]],
          cwd: OLD[kind],
          env: childEnv({ ...nativeHome(home), TOPSL_TEST_PROFILE: profile, ...env }),
        };
  const app = await electron.launch({ ...options, timeout: 90_000 });
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
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
  return promptText;
}
/** An old release's test profile unlocks itself with the fixed test passphrase. */
async function testUnlocked(page) {
  await expect.poll(async () => (await state(page).catch(() => ({ locked: true }))).locked, { timeout: 60_000 }).toBe(false);
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
const crumb = (page) => page.locator("header.topbar > span").first();

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
  writeFileSync(executable, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} "$@"\n`);
  chmodSync(executable, 0o700);
  return { executable, log, events: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

// --- Shared journeys ---------------------------------------------------------
/** Projects → + Add folder; a new project opens at its New session page. */
async function addProjectUI(session, projectPath) {
  const { app, page } = session;
  await setOpenPath(app, projectPath);
  await navigate(page, "Projects");
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  await expect(crumb(page)).toHaveText(`${path.basename(projectPath)} / New session`, { timeout: 30_000 });
  return (await state(page)).projects.find((p) => p.realPath === projectPath);
}
/** Settings → Imports: preview one Codex export for the project, then import exactly that. */
async function importUI(session, transcript, projectId, projectName) {
  const { app, page } = session;
  await setOpenPath(app, transcript);
  await navigate(page, "Settings");
  const imports = page.getByRole("region", { name: "Imports", exact: true });
  await imports.getByRole("combobox", { name: "Project", exact: true }).selectOption(projectId);
  await imports.getByRole("combobox", { name: "Provider", exact: true }).selectOption("codex");
  await imports.getByRole("button", { name: "Choose file…", exact: true }).click();
  const preview = imports.getByRole("article", { name: "Import preview" });
  await expect(preview).toContainText(path.basename(transcript), { timeout: 30_000 });
  await expect(preview).toContainText(`${projectName} · Codex`);
  const contains = await preview.locator("dd").nth(1).innerText();
  await preview.getByRole("button", { name: "Import", exact: true }).click();
  await expect(imports.getByText(`Imported ${path.basename(transcript)}.`)).toBeVisible({ timeout: 30_000 });
  await expect(imports.getByRole("list", { name: "Imported histories" })).toContainText(path.basename(transcript));
  return { contains };
}
/** Provider tools → Provider history search, as the owner searches; returns the shown count. */
async function searchUI(page, projectName, query) {
  await selectProject(page, projectName);
  await navigate(page, "Provider tools");
  await page.getByRole("textbox", { name: "Search project history" }).fill(query);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const line = page.getByText(/^\d+ matching messages/);
  await expect(line).toBeVisible({ timeout: 30_000 });
  return Number((await line.innerText()).match(/^(\d+)/)[1]);
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
/** Providers → Locate a runtime → Trust executable; Provider tools → Native terminal. */
async function terminalJourney(session, root, caseId, bundle = BUNDLE) {
  const { app, page } = session;
  const standin = makeStandin(root);
  const result = { standin: standin.executable };
  await setOpenPath(app, standin.executable);
  await navigate(page, "Providers");
  await page.getByRole("button", { name: "Locate a runtime", exact: true }).click();
  let installation;
  await expect
    .poll(async () => {
      installation = (await state(page)).installations.find((i) => i.realPath === realpathSync(standin.executable));
      return !!installation;
    }, { timeout: 30_000 })
    .toBe(true);
  const card = page.locator(".installation").filter({ has: page.locator("code.path", { hasText: standin.executable }) });
  await card.getByRole("button", { name: "Trust executable", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).installations.find((i) => i.id === installation.id)?.trusted, { timeout: 30_000 })
    .toBe(true);
  await navigate(page, "Provider tools");
  await page.getByRole("combobox", { name: "Runtime", exact: true }).selectOption(installation.id);
  await page.getByRole("button", { name: "Native terminal", exact: true }).click();
  const terminal = page.locator(".terminal-panel");
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
  await terminal.getByRole("button", { name: "Close session", exact: true }).click();
  await expect.poll(() => standin.events().some((e) => e.event === "exit"), { timeout: 20_000 }).toBe(true).catch(() => {});
  await expect.poll(() => alive(start.pid), { timeout: 10_000 }).toBe(false).catch(() => {});
  result.endEvents = standin.events().filter((e) => ["signal", "exit"].includes(e.event));
  check(caseId, "Close session terminates the PTY child (no orphan)", !alive(start.pid) && result.endEvents.some((e) => e.event === "exit"), result.endEvents);
  // The closed terminal is no longer listed or offered as an active one.
  const showActive = page.getByRole("button", { name: /^Show active native terminal/ });
  await expect(showActive).toHaveCount(0, { timeout: 10_000 }).catch(() => {});
  result.afterClose = {
    listed: (await state(page)).terminals.map((t) => t.id),
    showActiveButtons: await showActive.count(),
    panelOpen: await terminal.count(),
  };
  if (result.afterClose.showActiveButtons) await page.screenshot({ path: path.join(evidence, `${caseId}-closed-terminal-offered.png`) });
  check(caseId, "after Close session no active terminal is listed or offered", result.afterClose.listed.length === 0 && result.afterClose.showActiveButtons === 0 && result.afterClose.panelOpen === 0, result.afterClose);
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
    version: VERSION,
    bundle: BUNDLE,
    offline: OFFLINE,
    checks,
    blocked,
    notes,
    ...extra,
  };
  writeFileSync(path.join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${scenario}: ${checks.length - failed} passed, ${failed} failed, ${blocked.length} blocked. Report: ${path.join(evidence, "report.json")}`);
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
function oldBuilt(version) {
  return existsSync(path.join(OLD[version], "dist", "main.cjs"));
}

// --- Scenarios -------------------------------------------------------------
async function identity() {
  const zipHash = sha256File(ZIP);
  notes.archive = { zip: ZIP, size: statSync(ZIP).size, sha256: zipHash };
  if (ZIP_SHA256) check("PKG-03", "archive SHA-256 equals TOPSL_CAMPAIGN_ZIP_SHA256", zipHash === ZIP_SHA256, zipHash);
  else block("PKG-03", "archive SHA-256 equals a separately recorded candidate hash", "TOPSL_CAMPAIGN_ZIP_SHA256 not set; the hash is recorded in notes.archive");
  rmSync(path.dirname(BUNDLE), { recursive: true, force: true });
  ensureBundle();
  notes.extractedFrom = { ...notes.archive, extractedTo: BUNDLE, tool: "ditto -x -k" };
  const diff = sh("/usr/bin/diff", ["-rq", BUNDLE, BUILT_APP]);
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
  check("PKG-03", `packaged package.json version is ${VERSION} and main is dist/main.cjs`, appPackage.version === VERSION && appPackage.main === "dist/main.cjs", { version: appPackage.version, main: appPackage.main });
  const distMatches = {};
  for (const f of ["main.cjs", "service.cjs", "preload.cjs"])
    distMatches[f] = createHash("sha256").update(asar.extractFile(archive, `dist/${f}`)).digest("hex") === sha256File(`${CLEAN}/dist/${f}`);
  distMatches["cli.cjs (unpacked)"] = sha256File(path.join(BUNDLE, "Contents/Resources/app.asar.unpacked/dist/cli.cjs")) === sha256File(`${CLEAN}/dist/cli.cjs`);
  const head = sh("git", ["-C", CLEAN, "rev-parse", "HEAD"]).stdout.trim();
  const dirty = sh("git", ["-C", CLEAN, "status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  notes.source = { head, trackedDirty: dirty || null, lockfileSha256: sha256File(`${CLEAN}/package-lock.json`) };
  check("PKG-03", "packaged dist bundles are byte-identical to the checkout's dist build", Object.values(distMatches).every(Boolean), { distMatches, head });
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
    check("PKG-03", `built version is ${VERSION} on arm64 with Electron 44.4.5`, id.version === VERSION && id.arch === "arm64" && id.versions.electron === "44.4.5", id);
    const prompt = await unlockUI(session.page);
    notes.passphrasePrompt = prompt;
    const s = await state(session.page);
    check("PKG-03", "packaged app ignores TOPSL_TEST_PROFILE: not a test profile and the decoy stays empty", s.testProfile === false && readdirSync(decoy).length === 0, { testProfile: s.testProfile, decoy: readdirSync(decoy) });
    check("PKG-03", "service-reported version equals app.getVersion()", s.version === id.version, { service: s.version, app: id.version });
    await expect(session.page.locator("aside.sidebar").getByText(`Topsl ${id.version}`, { exact: true })).toBeVisible();
    check("PKG-03", "visible sidebar shows the built version", true);
    await expect(session.page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
    const files = readdirSync(profile);
    check("PKG-03", "profile readback: vault.json and history.sqlite created only in the temporary profile", files.includes("vault.json") && files.includes("history.sqlite"), files);
    notes.profileFiles = files;
    notes.freshProfileBackups = files.filter((f) => /\.backup-/.test(f));
    notes.dockVisible = await session.app.evaluate(({ app }) => app.dock.isVisible());
    await sleep(3000);
    const later = await state(session.page);
    notes.discoveredInstallations = later.installations.map((i) => ({ appId: i.appId, path: i.path, owner: i.owner }));
    notes.releaseChecksOffline = later.checks.map((c) => ({ status: c.status, failures: c.failures ?? null, detail: c.detail }));
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
  check("PKG-03", "passphrase-vault launch created or changed no Topsl keychain item", JSON.stringify(keysBefore) === JSON.stringify(notes.keychain.after), notes.keychain);
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
    // UI-01 / DATA-02: locked until a valid passphrase; a wrong one is refused.
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
    result.import = await importUI(session, transcript, added.id, added.name);
    const shown = await searchUI(session.page, added.name, CANARY);
    const hits = await search(session.page, added.id, CANARY);
    result.hitsBefore = hits.map((m) => m.id);
    result.searchShown = shown;
    check("PKG-04", "imported export is searchable in the encrypted store, through Provider tools search", hits.length >= 2 && shown === hits.length, { shown, hits: hits.length });
    const header = readFileSync(path.join(profile, "history.sqlite")).subarray(0, 16).toString("latin1");
    check("PKG-04", "history.sqlite on disk is encrypted (no SQLite plaintext header)", !header.startsWith("SQLite format 3"), header);
    // Terminal through the packaged UI.
    result.terminal = await terminalJourney(session, root, "PKG-04");
    // Context grant through Project settings → Share history with an MCP client…
    await navigate(session.page, "Project settings");
    await session.page.getByRole("button", { name: "Share history with an MCP client…", exact: true }).click();
    const detail = session.page.getByRole("region", { name: "Project controls", exact: true }).locator("pre.snapshot");
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
    result.moduleErrors = moduleErrors(session.logs);
    check("PKG-04", "no missing-module or wrong-ABI errors in packaged app output", result.moduleErrors.length === 0, result.moduleErrors);
    result.serviceError = (await state(session.page)).serviceError;
    check("PKG-04", "control service reports no error", !result.serviceError, result.serviceError);
    result.prompts = (await prompts(session.app)).map((p) => p.message ?? p.title);
    await session.page.screenshot({ path: path.join(evidence, "native-project-settings.png") });
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
  if (process.env.TOPSL_CAMPAIGN_KEYCHAIN !== "1") {
    block("DATA-01", "OS-store vault on a fresh profile, reopen, single vault", "needs the owner's login keychain (no mock keychain); run with TOPSL_CAMPAIGN_KEYCHAIN=1 only with the owner's agreement");
    return;
  }
  ensureBundle();
  const footprintBefore = ownerFootprint();
  const keysBefore = keychainItems();
  const root = tempProfile("osvault-root");
  const profile = path.join(root, "p");
  const project = makeProject(root);
  let session;
  // The real login keychain: no --use-mock-keychain here.
  const realKeychain = async () => {
    const app = await electron.launch({
      executablePath: offline(path.join(BUNDLE, "Contents/MacOS/Topsl")),
      args: [...(OFFLINE ? ["--no-sandbox"] : []), `--user-data-dir=${profile}`],
      env: childEnv(nativeHome()),
      timeout: 90_000,
    });
    const page = await app.firstWindow();
    return { kind: "candidate", app, page, logs: [], pid: app.process().pid, profile };
  };
  try {
    session = await realKeychain();
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
    session = await realKeychain();
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
    // With the mock keychain this ciphertext cannot be decrypted, as on a Mac
    // whose login keychain no longer holds the key.
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

/** Builds an old release from its tag into OLD[version], sharing this checkout's node_modules. */
function prepareOld(version) {
  const target = OLD[version];
  if (!/^0\.1\.\d$/.test(version ?? "")) throw new Error("Usage: prepare-old <0.1.1|0.1.2|0.1.3>");
  const deps = (ref) => {
    const p = JSON.parse(sh("git", ["-C", REPO, "show", `${ref}:package.json`]).stdout);
    return JSON.stringify([p.dependencies, p.devDependencies]);
  };
  const same = deps(`v${version}`) === deps("HEAD");
  check("PREP", `v${version} declares the same dependencies as HEAD, so this checkout's node_modules can build it`, same);
  if (!same) return;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const archive = spawnSync("git", ["-C", REPO, "archive", "--format=tar", `v${version}`], { maxBuffer: 1 << 30 });
  const untar = spawnSync("/usr/bin/tar", ["-x", "-C", target], { input: archive.stdout });
  check("PREP", `source of tag v${version} extracted`, archive.status === 0 && untar.status === 0, archive.stderr?.toString() + untar.stderr?.toString());
  symlinkSync(realpathSync(path.join(CLEAN, "node_modules")), path.join(target, "node_modules"));
  const build = sh(process.execPath, ["scripts/build.mjs"], { cwd: target, env: childEnv(), timeout: 300_000 });
  notes.build = { status: build.status, tail: (build.stdout + build.stderr).trim().split("\n").slice(-4) };
  check("PREP", `v${version} built (dist/main.cjs)`, build.status === 0 && oldBuilt(version), notes.build);
  notes.source = { version, target, commit: sh("git", ["-C", REPO, "rev-parse", `v${version}^{commit}`]).stdout.trim() };
}

/**
 * An earlier profile, written by the old release itself in an isolated test
 * profile: a project, conversations, imported history, the Night theme and,
 * from 0.1.3, native project discovery switched on over a seeded native home.
 */
async function createOldProfile(version, root) {
  const profile = testProfile(`v${version.replaceAll(".", "")}`);
  const project = makeProject(root, `p8 ${version} project`);
  const discovered = makeProject(root, `p8 ${version} discovered`);
  const transcript = makeTranscript(root, project, `v${version.replaceAll(".", "")}`);
  // The old release's test profile reads native metadata from <profile>/native-home.
  const home = path.join(profile, "native-home");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [discovered]: {} } }));
  const session = await launch({ kind: version, profile, home: path.join(root, "old-home") });
  try {
    await stubDialogs(session.app);
    await testUnlocked(session.page);
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
    let discovery = null;
    if (version === "0.1.3") {
      discovery = await cmd(session.page, { type: "project-sync-enable", enabled: true }).catch((e) => ({ error: String(e.message ?? e) }));
      await expect
        .poll(async () => (await state(session.page)).projects.some((x) => x.realPath === discovered), { timeout: 30_000 })
        .toBe(true)
        .catch(() => {});
    }
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
      projectSync: s.projectSync ? { enabled: s.projectSync.enabled, sources: s.projectSync.sources?.map((x) => x.id ?? x.sourceId) } : null,
      discovery: discovery && (discovery.error ? discovery : { enabled: discovery.enabled }),
      discoveredFolder: discovered,
      installations: s.installations.map((i) => ({ id: i.id, appId: i.appId, trusted: i.trusted })),
      appVersion: s.version,
      // 0.1.2 does not report it; its test-profile path is the one set above.
      testProfile: s.testProfile ?? null,
    };
    await session.page.screenshot({ path: path.join(evidence, `v${version}-created.png`) });
    await close(session);
    return { profile, project, transcript, old, home };
  } catch (e) {
    await snapshotOnError(session, `v${version}-create-error`);
    kill(session);
    throw e;
  }
}

/**
 * Records 0.1.3 could hold that an old release cannot create in a test
 * profile (no desktop discovery there): a desktop installation, its pending
 * operation, approval and lock, an observed history source and a sync field.
 * Synthetic, written with the product's own record shapes
 * (tests/native-retirement.test.ts), and labelled so in the report.
 */
function legacyRecords(root, projectId) {
  const at = new Date().toISOString();
  const nativeApp = path.join(root, "Codex.app");
  return [
    { kind: "installation", id: "p8-desktop", body: { appId: "openai.desktop", hostId: "host", path: nativeApp, realPath: nativeApp, version: "1.0.0", revisionId: "p8-desktop-revision", identity: "p8-desktop-identity", managementUnitId: "p8-unit-desktop", owner: "vendor", packageId: null, channel: "native", nativeAutoUpdates: "unknown", trusted: true, compatibility: "native-only" } },
    { kind: "check", id: "p8-desktop", body: { installationId: "p8-desktop", status: "available", checkedAt: at } },
    { kind: "plan", id: "p8-plan-waiting", body: { appId: "openai.desktop", installationId: "p8-desktop", action: "update", route: "native", managementUnitId: "p8-unit-desktop", nativeApplicationPath: nativeApp, digest: "p8-digest-waiting", effects: [], createdAt: at, expiresAt: at } },
    { kind: "job", id: "p8-job-waiting", body: { planId: "p8-plan-waiting", state: "waiting-for-idle", acquiredPath: null, bytes: 0, total: null, actualVersion: null, detail: "before", createdAt: at, updatedAt: at } },
    { kind: "installation-lock", id: "p8-unit-desktop", body: { owner: "p8-job-waiting" } },
    { kind: "native-history-source", id: "p8-source", body: { projectId, enabled: true, state: "current", revision: 3 } },
    { kind: "sync-field", id: "p8-field", body: { projectId, state: "push-required" } },
  ];
}
const retiredIds = ["installation:p8-desktop", "check:p8-desktop", "installation-lock:p8-unit-desktop"];

async function upgrade(version) {
  if (!oldBuilt(version)) {
    block("PKG-10", `upgrade from a v${version} profile`, `no built v${version} source at ${OLD[version]}; run \`prepare-old ${version}\` first`);
    return;
  }
  ensureBundle();
  const footprintBefore = ownerFootprint();
  const keysBefore = keychainItems();
  const root = tempProfile(`upgrade-${version}`);
  const fixtures = path.join(WORK, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  const created = await createOldProfile(version, root);
  const { old } = created;
  notes.old = old;
  check("PKG-10", `v${version} (tag source, electron <source>, isolated test profile) profile created with a project, conversations and imported history`, old.projects.length >= 1 && old.conversations.length >= 2 && old.hits.length >= 2 && old.appVersion === version && old.testProfile !== false, old);
  if (version === "0.1.3")
    check("PKG-10", "v0.1.3 profile has native project discovery on and a discovered project", old.projectSync?.enabled === true && old.projects.some((p) => p.realPath === old.discoveredFolder), { projectSync: old.projectSync, discovery: old.discovery });
  const mainProject = old.projects.find((p) => p.realPath === created.project);
  const seeded = helper(["seed-legacy", created.profile, TEST_PASSPHRASE, (() => {
    const file = path.join(root, "legacy-records.json");
    writeFileSync(file, JSON.stringify(legacyRecords(root, mainProject.id)));
    return file;
  })()]);
  notes.syntheticLegacyRecords = seeded;
  check("PKG-10", "synthetic desktop/synchronization records added to the closed old profile", !seeded.error && seeded.added?.length === 7, seeded);
  const pre = inspectProfile(created.profile, TEST_PASSPHRASE);
  notes.preUpgradeStore = { userVersion: pre.userVersion, kinds: pre.kinds, events: pre.events, files: pre.files, projects: pre.projects, preferences: pre.preferences?.map((p) => ({ id: p.id, enabled: p.body.enabled ?? null })) };
  const pristine = path.join(fixtures, `v${version}-pristine`);
  rmSync(pristine, { recursive: true, force: true });
  cpSync(created.profile, pristine, { recursive: true });
  writeFileSync(path.join(fixtures, `v${version}-pristine.json`), JSON.stringify({ old, project: created.project, passphrase: TEST_PASSPHRASE }, null, 2));
  // The candidate opens a copy, so the pristine fixture survives.
  const profile = path.join(root, "upgraded");
  cpSync(created.profile, profile, { recursive: true });
  // A native folder added after the upgrade must not become a project: native
  // discovery is retired, so nothing reads this file any more.
  const home = path.join(profile, "native-home");
  const late = makeProject(root, `p8 ${version} late native folder`);
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: { [old.discoveredFolder]: {}, [late]: {} } }));
  let session;
  try {
    session = await launch({ kind: "candidate", profile, home });
    await stubDialogs(session.app);
    const prompt = await unlockUI(session.page, TEST_PASSPHRASE);
    check("PKG-10", "candidate asks for the existing vault's passphrase and unlocks it (visible workbench)", /Enter your vault passphrase/.test(prompt ?? ""), prompt);
    notes.landingHeading = await session.page.getByRole("heading", { level: 1 }).first().innerText().catch(() => null);
    const s = await state(session.page);
    const projectsNow = s.projects.map((x) => ({ id: x.id, realPath: x.realPath, trusted: x.trusted, name: x.name }));
    const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));
    check("PKG-10", "projects preserved with the same ids, folders, names and trust", JSON.stringify(byId(projectsNow)) === JSON.stringify(byId(old.projects)), { old: old.projects, now: projectsNow });
    check("PKG-10", "the displayed project order is the order the old release showed", JSON.stringify(projectsNow.map((p) => p.id)) === JSON.stringify(old.projects.map((p) => p.id)), { old: old.projects.map((p) => p.name), now: projectsNow.map((p) => p.name) });
    await navigate(session.page, "Projects");
    const cards = await session.page.locator(".project-card h2").allInnerTexts();
    check("PKG-10", "Projects lists the upgraded projects in that order", JSON.stringify(cards) === JSON.stringify(old.projects.map((p) => p.name)), cards);
    const convNow = await conversations(session.page, mainProject.id);
    const convOld = [...old.conversations].sort((a, b) => a.id.localeCompare(b.id));
    check("PKG-10", "conversations preserved with the same ids and titles", convOld.length >= 2 && JSON.stringify(convNow) === JSON.stringify(convOld), { old: convOld, now: convNow });
    const hits = (await search(session.page, mainProject.id, CANARY)).map((m) => m.id).sort();
    check("PKG-10", "imported messages searchable with the same ids after the upgrade", JSON.stringify(hits) === JSON.stringify(old.hits), { old: old.hits, now: hits });
    const shown = await searchUI(session.page, mainProject.name, CANARY);
    check("PKG-10", "Provider tools search shows the upgraded history", shown === old.hits.length, { shown, expected: old.hits.length });
    check("PKG-10", "owner preference (theme) preserved", s.theme === old.theme, { old: old.theme, now: s.theme });
    const loops = await cmd(session.page, { type: "loop-query", projectId: mainProject.id });
    const privileges = {
      claudeStructuredRoute: s.claudeStructuredRoute,
      claudeTranscriptRead: s.claudeTranscriptRead,
      autoAccept: s.autoAccept,
      loopsEnabled: loops.enabled,
      trustedInstallations: s.installations.filter((i) => i.trusted).map((i) => i.appId),
      desktopInstallations: s.installations.filter((i) => !/-cli$/.test(i.appId)).map((i) => i.appId),
      testProfile: s.testProfile,
      retiredStateFields: ["projectSync", "codexProjectSync"].filter((f) => f in s),
    };
    notes.privileges = privileges;
    check("PKG-10", "no privilege widening: Claude structured route off, loops off, auto-accept off, no trusted executables, not a test profile", privileges.claudeStructuredRoute?.enabled === false && privileges.loopsEnabled === false && privileges.autoAccept === "off" && privileges.trustedInstallations.length === 0 && privileges.testProfile === false, privileges);
    check("RET-01", "no desktop installation survives the upgrade and no synchronization state is exposed", privileges.desktopInstallations.length === 0 && privileges.retiredStateFields.length === 0, privileges);
    await navigate(session.page, "Providers");
    const providerCards = await session.page.locator("article.application-card h2").allInnerTexts();
    check("RET-01", "Providers lists only Codex CLI and Claude Code", JSON.stringify(providerCards.sort()) === JSON.stringify(["Claude Code", "Codex CLI"]), providerCards);
    await sleep(5000);
    const later = (await state(session.page)).projects;
    check("RET-02", "a native folder added after the upgrade is not discovered (no retired metadata reads)", later.length === old.projects.length && !later.some((p) => p.realPath === late), later.map((p) => p.realPath));
    await selectProject(session.page, mainProject.name);
    await expect(crumb(session.page)).toHaveText(`${mainProject.name} / New session`);
    notes.terminal = await terminalJourney(session, root, "J-12");
    notes.moduleErrors = moduleErrors(session.logs);
    check("J-12", "no missing-module or wrong-ABI errors", notes.moduleErrors.length === 0, notes.moduleErrors);
    notes.prompts = (await prompts(session.app)).map((p) => p.message ?? p.title);
    check("RET-03", "no installer, launch or synchronization confirmation was requested", !notes.prompts.some((m) => /install|update|synchron|discover|launch/i.test(m ?? "")), notes.prompts);
    await session.page.screenshot({ path: path.join(evidence, `candidate-on-v${version}.png`) });
    await close(session);
    session = null;
  } catch (e) {
    check("PKG-10", "candidate upgrade session completed", false, String(e.stack ?? e).slice(0, 1200));
    await snapshotOnError(session, "upgrade-error");
    if (session) kill(session);
    session = null;
  }
  const post = inspectProfile(profile, TEST_PASSPHRASE);
  notes.postUpgradeStore = { userVersion: post.userVersion, integrity: post.integrity, kinds: post.kinds, events: post.events, backups: post.backups, files: post.files, migrations: post.migrations, jobs: post.jobs, consumedApprovals: post.consumedApprovals, historySources: post.historySources, syncFields: post.syncFields };
  check("PKG-10", "store at schema 6 with integrity ok", post.userVersion === 6 && post.integrity === "ok", { userVersion: post.userVersion, integrity: post.integrity });
  const preIds = Object.keys(pre.digests ?? {});
  const missing = preIds.filter((k) => !(k in (post.digests ?? {})) && !retiredIds.includes(k));
  check("PKG-10", "every pre-upgrade document identity is still present, except the retired desktop installation, its check and lock", missing.length === 0, missing);
  notes.rewrittenDocuments = preIds.filter((k) => post.digests?.[k] && post.digests[k] !== pre.digests[k]);
  const msgSame = JSON.stringify(pre.messages) === JSON.stringify(post.messages);
  check("PKG-10", "message records (ids, text, attribution) byte-equivalent in the decoded fields", msgSame, { pre: pre.messages?.length, post: post.messages?.length });
  const migration = post.migrations?.find((m) => m.id === "native-integration-retired-v1");
  check("RET-04", "the native-retirement migration ran once and recorded its counts", post.migrations?.filter((m) => m.id === "native-integration-retired-v1").length === 1 && migration?.counts?.installations === 1 && migration?.counts?.jobs === 1, post.migrations);
  const pref = (id) => post.preferences?.find((p) => p.id === id)?.body;
  if (version === "0.1.3")
    check("RET-04", "project discovery preference disabled with a retirement time", pref("project-sync")?.enabled === false && !!pref("project-sync")?.retiredAt, pref("project-sync"));
  check("RET-04", "project order recorded from the old display order", JSON.stringify(pref("project-order")?.order) === JSON.stringify(old.projects.map((p) => p.id)), pref("project-order"));
  check("RET-04", "no project keeps a native name source", (post.projects ?? []).every((p) => p.nameSource === null), post.projects?.map((p) => ({ id: p.id, nameSource: p.nameSource })));
  const job = post.jobs?.find((j) => j.id === "p8-job-waiting");
  check("RET-05", "the pending desktop operation is cancelled as retired, its approval consumed and its lock released; nothing was run", job?.state === "cancelled" && /Retired/.test(job?.detail ?? "") && post.consumedApprovals?.some((a) => a.id === "p8-plan-waiting") && !(post.installationLocks ?? []).some((l) => l.id === "p8-unit-desktop") && !existsSync(path.join(root, "Codex.app")), { job, approvals: post.consumedApprovals, locks: post.installationLocks });
  check("RET-05", "the observed history source and sync field are retired", post.historySources?.find((h) => h.id === "p8-source")?.state === "retired" && post.historySources?.find((h) => h.id === "p8-source")?.enabled === false && post.syncFields?.find((f) => f.id === "p8-field")?.state === "retired", { sources: post.historySources, fields: post.syncFields });
  if (pre.userVersion < 6)
    check("PKG-10", "encrypted migration backup(s) created, readable with the same key, at the old schema", post.backups?.length >= 1 && post.backups.every((b) => b.integrity === "ok") && post.backups.some((b) => b.userVersion === pre.userVersion), post.backups);
  else notes.backupNote = `v${version} profile already at schema ${pre.userVersion}; no schema migration. Backups: ${JSON.stringify(post.backups?.map((b) => b.name.replace(/backup-.*/, "backup-*")))}`;
  const migrated = path.join(fixtures, `v${version}-migrated`);
  rmSync(migrated, { recursive: true, force: true });
  cpSync(profile, migrated, { recursive: true });
  // J-12 reopen.
  try {
    session = await launch({ kind: "candidate", profile, home });
    await unlockUI(session.page, TEST_PASSPHRASE);
    const s = await state(session.page);
    const convReopen = await conversations(session.page, mainProject.id);
    check("J-12", "candidate reopen after upgrade: same projects and conversations", s.projects.map((p) => p.id).join() === old.projects.map((p) => p.id).join() && old.conversations.every((c) => convReopen.some((x) => x.id === c.id)));
    await close(session);
    session = null;
    const again = inspectProfile(profile, TEST_PASSPHRASE);
    check("RET-04", "reopening does not run the retirement migration again", JSON.stringify(again.migrations) === JSON.stringify(post.migrations), again.migrations);
  } catch (e) {
    check("J-12", "candidate reopen completed", false, String(e).slice(0, 600));
    if (session) kill(session);
    session = null;
  }
  // DATA-08: the older release reopens the migrated profile (in a test profile).
  const back = testProfile("back");
  cpSync(profile, back, { recursive: true });
  const tracked = ["vault.json"];
  const beforeBack = fileHashes(back, tracked);
  const baseline = inspectProfile(back, TEST_PASSPHRASE);
  const backRecord = {};
  try {
    session = await launch({ kind: version, profile: back, home: path.join(root, "old-home") });
    await settledLockReason(session.page);
    await sleep(3000);
    const s = await state(session.page);
    backRecord.locked = s.locked;
    backRecord.lockReason = s.lockReason ?? null;
    backRecord.serviceError = s.serviceError ?? null;
    backRecord.projects = s.projects?.map((p) => p.id) ?? [];
    backRecord.projectSync = s.projectSync?.enabled ?? null;
    backRecord.conversations = s.locked ? [] : (await conversations(session.page, mainProject.id, version).catch(() => [])).map((c) => c.id);
    await session.page.screenshot({ path: path.join(evidence, `v${version}-reopens-migrated.png`) });
    await close(session);
    session = null;
  } catch (e) {
    backRecord.error = String(e).slice(0, 400);
    await snapshotOnError(session, "older-writer");
    if (session) kill(session);
    session = null;
  }
  backRecord.vaultUnchanged = JSON.stringify(beforeBack) === JSON.stringify(fileHashes(back, tracked));
  const backInspect = inspectProfile(back, TEST_PASSPHRASE);
  backRecord.afterOlderWriter = { userVersion: backInspect.userVersion, integrity: backInspect.integrity, kinds: backInspect.kinds };
  backRecord.documentsLost = Object.keys(baseline.digests ?? {}).filter((k) => !(k in (backInspect.digests ?? {})));
  backRecord.documentsChanged = Object.keys(baseline.digests ?? {}).filter((k) => backInspect.digests?.[k] && backInspect.digests[k] !== baseline.digests[k]);
  backRecord.documentsAdded = Object.keys(backInspect.digests ?? {}).filter((k) => !(k in (baseline.digests ?? {})));
  notes.olderWriter = backRecord;
  check("DATA-08", `v${version} (same schema 6) opens the candidate-written profile without losing any document, and discovery stays off`, backRecord.locked === false && backRecord.documentsLost.length === 0 && old.projects.every((p) => backRecord.projects.includes(p.id)) && backRecord.projectSync !== true, backRecord);
  rmSync(back, { recursive: true, force: true });
  if (["0.1.2", "0.1.3"].includes(version)) await uncertainRunUpgrade(root, version);
  const footprintAfter = ownerFootprint();
  check("PKG-10", "owner's Topsl profile unchanged during upgrade runs", JSON.stringify(footprintBefore) === JSON.stringify(footprintAfter), { footprintBefore, footprintAfter });
  notes.keychain = { before: keysBefore, after: keychainItems() };
  check("PKG-10", "no Topsl keychain item created or changed by the upgrade journeys", JSON.stringify(keysBefore) === JSON.stringify(notes.keychain.after), notes.keychain);
  rmSync(created.profile, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

// PKG-11 (partial): a native terminal run left running by a hard-killed old
// release, then the candidate opens the profile. It must not replay or report success.
async function uncertainRunUpgrade(root, version) {
  const meta = JSON.parse(readFileSync(path.join(WORK, "fixtures", `v${version}-pristine.json`), "utf8"));
  const profile = testProfile("uncertain");
  cpSync(path.join(WORK, "fixtures", `v${version}-pristine`), profile, { recursive: true });
  const record = {};
  let session = await launch({ kind: version, profile, home: path.join(root, "old-home") });
  const standin = makeStandin(path.join(root, "uncertain-standin"));
  try {
    await stubDialogs(session.app);
    await testUnlocked(session.page);
    await setOpenPath(session.app, standin.executable);
    const installation = await cmd(session.page, { type: "select-runtime" });
    await expect.poll(async () => (await state(session.page)).installations.some((i) => i.id === installation.id), { timeout: 20_000 }).toBe(true);
    await cmd(session.page, { type: "trust-installation", id: installation.id });
    await expect.poll(async () => (await state(session.page)).installations.find((i) => i.id === installation.id)?.trusted, { timeout: 20_000 }).toBe(true);
    const projectId = meta.old.projects.find((p) => p.realPath === meta.project).id;
    const terminalId = await cmd(session.page, { type: "terminal-open", projectId, installationId: installation.id, login: false });
    await expect.poll(() => standin.events().some((e) => e.event === "start"), { timeout: 20_000 }).toBe(true);
    const start = standin.events().find((e) => e.event === "start");
    record.terminalId = terminalId;
    record.killed = kill(session).length;
    session = null;
    await sleep(1500);
    const killedStore = inspectProfile(profile, TEST_PASSPHRASE);
    const before = killedStore.runs?.find((r) => r.id === terminalId);
    record.beforeUpgrade = before && { status: before.status, nativePid: before.nativePid };
    record.standinAliveAfterKill = alive(start.pid);
    if (record.standinAliveAfterKill) process.kill(start.pid, "SIGKILL");
    const startsBefore = standin.events().filter((e) => e.event === "start").length;
    session = await launch({ kind: "candidate", profile, home: path.join(profile, "native-home") });
    await unlockUI(session.page, TEST_PASSPHRASE);
    await sleep(3000);
    record.replayed = standin.events().filter((e) => e.event === "start").length > startsBefore;
    await close(session);
    session = null;
    const after = inspectProfile(profile, TEST_PASSPHRASE);
    const run = after.runs?.find((r) => r.id === terminalId);
    record.afterUpgrade = run && { status: run.status, error: run.error };
    record.operationIntents = after.kinds?.["operation-intent"] ?? 0;
    check("PKG-11", `a run left running by a hard-killed v${version} is not reported running or completed by the candidate and is not replayed`, before?.status === "running" && !!run && !["running", "starting", "completed"].includes(run.status) && !record.replayed, record);
  } catch (e) {
    record.error = String(e.stack ?? e).slice(0, 800);
    check("PKG-11", "uncertain-run upgrade completed", false, record);
    await snapshotOnError(session, "uncertain-error");
    if (session) kill(session);
  }
  notes.uncertainRun = record;
  rmSync(profile, { recursive: true, force: true });
}

/** The newest earlier-profile fixture an upgrade scenario left in WORK. */
function pristineFixture() {
  const preferred = process.env.TOPSL_CAMPAIGN_FAULT_FROM;
  for (const version of preferred ? [preferred] : ["0.1.3", "0.1.2", "0.1.1"]) {
    const dir = path.join(WORK, "fixtures", `v${version}-pristine`);
    if (existsSync(dir)) {
      const meta = JSON.parse(readFileSync(`${dir}.json`, "utf8"));
      return { version, dir, meta, passphrase: meta.passphrase ?? PASSPHRASE };
    }
  }
  return null;
}

async function faults() {
  ensureBundle();
  const fixture = pristineFixture();
  if (!fixture) {
    block("PKG-12", "SIGKILL during upgrade and disk full", "no earlier-profile fixture; run an upgrade scenario first");
    return;
  }
  const { meta, passphrase } = fixture;
  notes.fixture = fixture.version;
  const mainId = meta.old.projects.find((p) => p.realPath === meta.project)?.id ?? meta.old.projects[0].id;
  const root = tempProfile("faults");
  notes.kills = [];
  for (const delay of [0, 120, 400, 1200]) {
    const p = path.join(root, `kill-${delay}`);
    cpSync(fixture.dir, p, { recursive: true });
    const record = { delay };
    let session = await launch({ kind: "candidate", profile: p, home: path.join(p, "native-home") });
    try {
      await settledLockReason(session.page);
      await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(passphrase);
      await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
      await sleep(delay);
      record.killed = kill(session).length;
      session = null;
      await sleep(800);
      const mid = inspectProfile(p, passphrase);
      record.afterKill = { userVersion: mid.userVersion, integrity: mid.integrity, backups: mid.backups?.map((b) => [b.userVersion, b.integrity]), migrationRecords: mid.migrations?.length ?? null, retirementRecords: mid.migrations?.filter((m) => m.id === "native-integration-retired-v1").length ?? null, error: mid.error ?? null };
      session = await launch({ kind: "candidate", profile: p, home: path.join(p, "native-home") });
      await unlockUI(session.page, passphrase);
      const s = await state(session.page);
      record.recovered = {
        projects: [...s.projects.map((x) => x.id)].sort().join() === [...meta.old.projects.map((x) => x.id)].sort().join(),
        conversations: await conversations(session.page, mainId).then((list) => meta.old.conversations.every((c) => list.some((x) => x.id === c.id))),
        hits: JSON.stringify((await search(session.page, mainId, CANARY)).map((m) => m.id).sort()) === JSON.stringify(meta.old.hits),
      };
      await close(session);
      session = null;
      const end = inspectProfile(p, passphrase);
      record.final = { userVersion: end.userVersion, integrity: end.integrity, backups: end.backups?.length, retirementRecords: end.migrations?.filter((m) => m.id === "native-integration-retired-v1").length ?? null };
    } catch (e) {
      record.error = String(e.stack ?? e).slice(0, 600);
      await snapshotOnError(session, `kill-${delay}`);
      if (session) kill(session);
    }
    notes.kills.push(record);
    check("PKG-12", `SIGKILL ${delay} ms after unlock during upgrade/startup: a committed state with integrity ok, then all records recovered, schema 6 and exactly one retirement record`, !record.error && record.afterKill?.userVersion >= 1 && record.afterKill?.userVersion <= 6 && record.afterKill?.integrity === "ok" && (record.afterKill?.backups ?? []).every((b) => b[1] === "ok") && record.recovered?.projects && record.recovered?.conversations && record.recovered?.hits && record.final?.userVersion === 6 && (fixture.version !== "0.1.3" || record.final?.retirementRecords === 1), record);
  }
  if (process.env.TOPSL_CAMPAIGN_DISK_IMAGE !== "1")
    block("PKG-12", "disk full during migration", "mounts a disposable disk image with hdiutil; run with TOPSL_CAMPAIGN_DISK_IMAGE=1");
  else await diskFull(root, fixture, mainId);
  rmSync(root, { recursive: true, force: true });
}

async function diskFull(root, fixture, mainId) {
  const { meta, passphrase } = fixture;
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
    cpSync(fixture.dir, p, { recursive: true });
    let session = await launch({ kind: "candidate", profile: p, home: path.join(root, "home") });
    await settledLockReason(session.page);
    const filler = path.join(mount, "filler");
    sh("/bin/dd", ["if=/dev/zero", `of=${filler}`, "bs=1m"]);
    sh("/bin/dd", ["if=/dev/zero", `of=${filler}-small`, "bs=4k"]);
    record.freeBytes = sh("/bin/df", ["-k", mount]).stdout.trim().split("\n").at(-1);
    await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(passphrase);
    await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
    await sleep(6000);
    const s = await state(session.page).catch((e) => ({ error: String(e) }));
    record.duringFull = { locked: s.locked, lockReason: s.lockReason ?? null, serviceError: s.serviceError ?? null, projects: s.projects?.length ?? null };
    await session.page.screenshot({ path: path.join(evidence, "disk-full.png") }).catch(() => {});
    record.closedCleanly = await session.app.close().then(() => true, () => false);
    if (!record.closedCleanly) kill(session);
    unlinkSync(filler);
    unlinkSync(`${filler}-small`);
    const mid = inspectProfile(p, passphrase);
    record.afterFull = { userVersion: mid.userVersion, integrity: mid.integrity, error: mid.error ?? null };
    session = await launch({ kind: "candidate", profile: p, home: path.join(root, "home") });
    await unlockUI(session.page, passphrase);
    const s2 = await state(session.page);
    const list = await conversations(session.page, mainId);
    record.recovered = [...s2.projects.map((x) => x.id)].sort().join() === [...meta.old.projects.map((x) => x.id)].sort().join() && meta.old.conversations.every((c) => list.some((x) => x.id === c.id));
    await close(session);
    const end = inspectProfile(p, passphrase);
    record.final = { userVersion: end.userVersion, integrity: end.integrity };
    check("PKG-12", "disk full during upgrade: no false empty unlocked profile; data intact; recovers after space is freed", !(record.duringFull.locked === false && record.duringFull.projects === 0) && record.afterFull.integrity === "ok" && record.recovered && record.final.userVersion === 6, record);
    check("PKG-12", "disk full: the visible reason names the storage problem (precise recovery path)", /disk|space|full|storage|ENOSPC/i.test(`${record.duringFull.lockReason} ${record.duringFull.serviceError}`), record.duringFull);
  } catch (e) {
    record.error = String(e.stack ?? e).slice(0, 800);
    check("PKG-12", "disk-full scenario completed", false, record);
  } finally {
    if (attached) sh("/usr/bin/hdiutil", ["detach", mount, "-force"]);
  }
  notes.diskFull = record;
}

async function restore() {
  ensureBundle();
  const root = tempProfile("restore");
  // (a) Restore an encrypted schema-1 migration backup into a new profile (v0.1.1 fixture only).
  const v011 = path.join(WORK, "fixtures", "v0.1.1-migrated");
  if (!existsSync(v011) || !oldBuilt("0.1.1"))
    block("PKG-13", "schema-1 migration backup restored and re-migrated", "needs a v0.1.1 upgrade fixture (prepare-old 0.1.1, then upgrade-v011); later releases are already at schema 6 and write no schema backup");
  // (b) Unknown future schema.
  const fixture = ["0.1.3", "0.1.2", "0.1.1"].map((v) => ({ v, dir: path.join(WORK, "fixtures", `v${v}-migrated`) })).find((f) => existsSync(f.dir));
  if (!fixture) {
    block("PKG-13", "unknown future schema refused", "no migrated fixture; run an upgrade scenario first");
    rmSync(root, { recursive: true, force: true });
    return;
  }
  const meta = JSON.parse(readFileSync(path.join(WORK, "fixtures", `v${fixture.v}-pristine.json`), "utf8"));
  const passphrase = meta.passphrase ?? PASSPHRASE;
  const r2 = path.join(root, "future");
  cpSync(fixture.dir, r2, { recursive: true });
  for (const f of readdirSync(r2)) if (/backup-/.test(f)) unlinkSync(path.join(r2, f));
  setUserVersion(r2, 7, passphrase);
  const before = fileHashes(r2, ["vault.json", "history.sqlite"]);
  const fut = { fixture: fixture.v };
  let session;
  try {
    session = await launch({ kind: "candidate", profile: r2 });
    await settledLockReason(session.page);
    await session.page.getByRole("textbox", { name: "Vault passphrase" }).fill(passphrase);
    await session.page.getByRole("button", { name: "Unlock / create vault" }).click();
    await sleep(4000);
    const s = await state(session.page);
    fut.locked = s.locked;
    fut.reason = s.lockReason ?? s.serviceError ?? null;
    fut.visible = await session.page.getByText(/newer Topsl version/).first().isVisible().catch(() => false);
    await session.page.screenshot({ path: path.join(evidence, "future-schema.png") });
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
  "prepare-old": () => prepareOld(process.argv[3]),
  "upgrade-v011": () => upgrade("0.1.1"),
  "upgrade-v012": () => upgrade("0.1.2"),
  "upgrade-v013": () => upgrade("0.1.3"),
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
  if (scenario !== "prepare-old") offlineProbe();
  await scenarios[scenario]();
} catch (e) {
  check(scenario, "scenario threw", false, String(e.stack ?? e).slice(0, 1500));
}
saveReport();
