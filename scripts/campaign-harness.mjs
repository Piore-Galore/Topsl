import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { standIn } from "./desktop-stand-in.mjs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Shared setup for the 4 November 2026 campaign's soak and recovery
// journeys (docs/testing/2026-11-04-comprehensive/PLAN.md, "Recovery" and
// "Load"): a synthetic Topsl profile, a scratch Git project, a Codex
// stand-in (tests/fixtures/codex-soak.cjs) registered, trusted, connected
// and qualified through service commands, and process-table helpers. The
// fixture setup goes through service commands; what a journey verifies goes
// through Topsl's screens. No model or account is contacted. macOS and Linux
// only: the helpers read `ps`.

export const fixtureScript = path.resolve("tests/fixtures/codex-soak.cjs");

/** A disposable profile with a one-file Git project. */
export async function createProfile(name) {
  await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
  const profile = await mkdtemp(path.join(os.tmpdir(), `topsl-test-${name}-`));
  // Qualification refuses the system temporary folders.
  const qualificationDirectory = await mkdtemp(
    path.resolve("node_modules/.cache/topsl-qualify-"),
  );
  await mkdir(path.join(profile, "claude-config", "projects"), {
    recursive: true,
  });
  await mkdir(path.join(profile, "native-home", ".codex"), { recursive: true });
  const project = path.join(profile, `${name}-project`);
  await mkdir(project);
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
  const env = {
    ...process.env,
    TOPSL_TEST_PROFILE: profile,
    TOPSL_TEST_QUALIFICATION_DIR: qualificationDirectory,
    CLAUDE_CONFIG_DIR: path.join(profile, "claude-config"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const variable of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    delete env[variable];
  return {
    profile,
    qualificationDirectory,
    project,
    canonicalProject: await realpath(project),
    env,
    remove() {
      rmSync(profile, { recursive: true, force: true });
      rmSync(qualificationDirectory, { recursive: true, force: true });
    },
  };
}

/** Launches Topsl from this checkout's dist/ against the profile. */
export async function launch(setup) {
  const app = await electron.launch({
    args: [".", "--enable-precise-memory-info"],
    env: setup.env,
    timeout: 90000,
  });
  const page = await app.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 45000 });
  await app.evaluate(({ dialog }) => {
    globalThis.topslConfirmations = [];
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.topslOpenPath],
    });
    // Every native confirmation is answered with its affirmative button,
    // unless a journey sets topslConfirmAnswer.
    dialog.showMessageBox = async (...args) => {
      globalThis.topslConfirmations.push(args.at(-1));
      return {
        response: globalThis.topslConfirmAnswer ?? 1,
        checkboxChecked: false,
      };
    };
  });
  return { app, page };
}

/** Adds the project through Projects' own button. */
export async function addProject(app, page, setup) {
  await app.evaluate((_, selected) => {
    globalThis.topslOpenPath = selected;
  }, setup.project);
  await page.getByRole("button", { name: "+ Add folder", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "New session", exact: true }),
  ).toContainText(path.basename(setup.project), { timeout: 30000 });
  return (
    await page.evaluate(() => window.topsl.command({ type: "state" }))
  ).projects.find((p) => p.realPath === setup.canonicalProject).id;
}

/** Registers, trusts, connects and qualifies a Codex stand-in. */
export async function qualifiedCodex(app, page, setup, { name, env = {} }) {
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
      (
        await page.evaluate(() => window.topsl.command({ type: "state" }))
      ).installations.some((i) => i.id === runtime.id),
    )
    .toBe(true);
  await page.evaluate(async (id) => {
    await window.topsl.command({ type: "trust-installation", id });
    await window.topsl.command({ type: "runtime-connect", id });
    await window.topsl.command({ type: "runtime-models", id });
  }, runtime.id);
  const qualification = await page.evaluate(
    (id) =>
      window.topsl.command({
        type: "runtime-qualify",
        id,
        model: "fixture-model",
      }),
    runtime.id,
  );
  if (!qualification) throw new Error("The stand-in was not qualified.");
  return { id: runtime.id, wrapper };
}

/** Waits until the project's Codex route is ready to coordinate. */
export async function coordinatorReady(page, projectId) {
  await expect
    .poll(
      async () => {
        const view = await page.evaluate(
          (projectId) =>
            window.topsl.command({ type: "orchestration-query", projectId }),
          projectId,
        );
        const codex = view.routes.find((r) => r.provider === "codex");
        return (
          !!codex?.catalog.fresh &&
          !!codex.purposes["coordinator-contribution"]?.ready
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
}

/** The process table: pid, parent, RSS in KB, CPU %, command. */
export function processes() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return text
    .split("\n")
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
      return (
        m && {
          pid: +m[1],
          ppid: +m[2],
          rssKb: +m[3],
          cpu: +m[4],
          command: m[5],
        }
      );
    })
    .filter(Boolean);
}

/** `root` and every process below it. */
export function tree(list, root) {
  const found = new Map();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    const p = list.find((p) => p.pid === pid);
    if (p && !found.has(pid)) found.set(pid, p);
    for (const child of list.filter((c) => c.ppid === pid))
      if (!found.has(child.pid)) queue.push(child.pid);
  }
  return [...found.values()];
}

/** Stand-in processes this checkout's fixture started. */
export function standIns(list = processes()) {
  return list.filter(
    (p) => p.command.includes(fixtureScript) && !/\bps\b -axo/.test(p.command),
  );
}

/** True while `pid` exists. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Waits up to `ms` for every pid to exit; returns the ones still running. */
export async function exited(pids, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = pids.filter(alive);
    if (!left.length || Date.now() > deadline) return left;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
