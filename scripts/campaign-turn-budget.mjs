import { _electron as electron, expect } from "@playwright/test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { standIn } from "./desktop-stand-in.mjs";

// The campaign-wide live budget (docs/testing/2026-11-04-comprehensive/
// PLAN.md, "Live budget"): at most a fixed number of structured-turn starts
// and prompted terminal rounds, across every live run, qualification, retry
// and retest. Each provider executable Topsl is given is a wrapper that runs
// scripts/campaign-turn-proxy.mjs, which counts every turn in one shared
// ledger and refuses those past the cap before they reach the provider.
//
//   node scripts/campaign-turn-budget.mjs wrap --provider codex|claude \
//     --real /absolute/path --ledger /absolute/ledger.jsonl --cap 80 \
//     --out /absolute/directory
//   node scripts/campaign-turn-budget.mjs report --ledger /absolute/ledger.jsonl
//   node scripts/campaign-turn-budget.mjs self-test
//
// self-test checks the accounting against stand-ins before any live run: an
// isolated Topsl qualifies a wrapped Codex and Claude Code stand-in and runs a
// session message with both as coordinators, and the ledger must hold exactly
// the turns Topsl and the stand-ins report. Then a cap one turn above the
// count must let exactly one more turn through and refuse the rest, with the
// ledger never above the cap. No provider, account or network is contacted.

const proxy = path.resolve("scripts/campaign-turn-proxy.mjs");

/** Writes `out/<provider>`, a wrapper Topsl can be given as the executable. */
export async function wrap({ provider, real, ledger, cap, out }) {
  if (!["codex", "claude"].includes(provider))
    throw new Error("--provider must be codex or claude");
  for (const p of [real, ledger, out])
    if (!path.isAbsolute(p)) throw new Error(`${p} must be absolute`);
  await mkdir(out, { recursive: true });
  const quote = (v) => "'" + String(v).replaceAll("'", "'\\''") + "'";
  const file = path.join(out, provider);
  await writeFile(
    file,
    `#!/bin/sh\nCAMPAIGN_PROVIDER=${quote(provider)} CAMPAIGN_REAL=${quote(real)} CAMPAIGN_LEDGER=${quote(ledger)} CAMPAIGN_CAP=${quote(cap)} exec ${quote(process.execPath)} ${quote(proxy)} "$@"\n`,
  );
  await chmod(file, 0o755);
  return file;
}

/** The ledger's counted and refused turns, by provider and kind. */
export function summary(ledger) {
  const read = (file) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const counted = read(ledger),
    refused = read(`${ledger}.refused`);
  const by = (entries) =>
    entries.reduce((totals, e) => {
      const key = `${e.provider}/${e.kind}`;
      totals[key] = (totals[key] ?? 0) + 1;
      return totals;
    }, {});
  return {
    counted: counted.length,
    refused: refused.length,
    cap: existsSync(`${ledger}.cap`)
      ? Number(readFileSync(`${ledger}.cap`, "utf8"))
      : (counted.at(-1)?.cap ?? null),
    byKind: by(counted),
    refusedByKind: by(refused),
  };
}

async function selfTest() {
  if (process.platform === "win32")
    throw new Error("The wrappers are POSIX shell scripts.");
  const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-budget-"));
  await mkdir(path.resolve("node_modules/.cache"), { recursive: true });
  const qualificationDirectory = await mkdtemp(
    path.resolve("node_modules/.cache/topsl-qualify-"),
  );
  process.on("exit", () => {
    rmSync(profile, { recursive: true, force: true });
    rmSync(qualificationDirectory, { recursive: true, force: true });
  });
  const ledger = path.join(profile, "ledger.jsonl");
  const claudeLog = path.join(profile, "claude-runs.jsonl");
  const codexReal = await standIn({
    directory: profile,
    name: "codex-real",
    script: "tests/fixtures/codex-desktop-coordinator.cjs",
  });
  const claudeReal = await standIn({
    directory: profile,
    name: "claude-real",
    script: "tests/fixtures/claude-qualify.cjs",
    env: { FIXTURE_LOG: claudeLog },
  });
  const out = path.join(profile, "wrapped");
  const codex = await wrap({
    provider: "codex",
    real: codexReal,
    ledger,
    cap: 80,
    out,
  });
  const claude = await wrap({
    provider: "claude",
    real: claudeReal,
    ledger,
    cap: 80,
    out,
  });
  const project = path.join(profile, "budget-project");
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
  await mkdir(path.join(profile, "claude-config", "projects"), {
    recursive: true,
  });
  const env = {
    ...process.env,
    TOPSL_TEST_PROFILE: profile,
    TOPSL_TEST_QUALIFICATION_DIR: qualificationDirectory,
    CLAUDE_CONFIG_DIR: path.join(profile, "claude-config"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ["."], env, timeout: 90000 });
  const checks = [];
  const check = (name, actual, expected) => {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, passed, actual, expected });
    console.log(
      `${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}`,
    );
  };
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Projects", exact: true }),
    ).toBeVisible({ timeout: 45000 });
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
    const command = (c) => page.evaluate((c) => window.topsl.command(c), c);
    await page
      .getByRole("button", { name: "+ Add folder", exact: true })
      .click();
    const canonical = await realpath(project);
    let projectId = null;
    await expect
      .poll(async () => {
        projectId =
          (await command({ type: "state" })).projects.find(
            (p) => p.realPath === canonical,
          )?.id ?? null;
        return projectId;
      })
      .not.toBeNull();
    const locate = async (file, runtime) => {
      await app.evaluate(
        (_, [file, runtime]) => {
          globalThis.topslOpenPath = file;
          globalThis.topslRuntime = runtime;
        },
        [file, runtime],
      );
      const located = await command({ type: "select-runtime" });
      await expect
        .poll(async () =>
          (await command({ type: "state" })).installations.some(
            (i) => i.id === located.id,
          ),
        )
        .toBe(true);
      await command({ type: "trust-installation", id: located.id });
      return located.id;
    };
    const codexId = await locate(codex, 1);
    const claudeId = await locate(claude, 2);
    await command({ type: "runtime-connect", id: codexId });
    await command({ type: "runtime-models", id: codexId });
    check("no turn before qualification", summary(ledger).counted, 0);

    const codexQualified = await command({
      type: "runtime-qualify",
      id: codexId,
      model: "fixture-model",
    });
    check(
      "Codex qualification: ledger equals the report's turns",
      summary(ledger).byKind["codex/structured-turn"] ?? 0,
      codexQualified.report.turnsStarted,
    );
    await command({ type: "claude-structured-route-set", enabled: true });
    await command({ type: "runtime-connect", id: claudeId });
    const claudeQualified = await command({
      type: "runtime-qualify",
      id: claudeId,
      model: "claude-opus-5-5",
    });
    const prints = () =>
      readFileSync(claudeLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((a) => a.includes("--print")).length;
    check(
      "Claude qualification: ledger equals the report's turns and the stand-in's runs",
      [
        summary(ledger).byKind["claude/structured-turn"] ?? 0,
        claudeQualified.report.turnsStarted,
      ],
      [prints(), prints()],
    );
    check(
      "account, --version and --help reads are not counted",
      summary(ledger).counted,
      codexQualified.report.turnsStarted + claudeQualified.report.turnsStarted,
    );

    // A session message answered by a Codex and a Claude coordinator.
    const pin = (memberId, value) => ({
      memberId,
      required: true,
      pin: value,
      fallbacks: [],
      preferences: { providers: [], models: [] },
      source: { kind: "ui", reference: null, provenance: "explicit" },
    });
    const before = summary(ledger).counted;
    const created = await command({
      type: "session-create",
      projectId,
      configuration: {
        coordinators: [
          pin("coordinator-1", {
            provider: "codex",
            installationId: codexId,
            model: "fixture-model",
          }),
          pin("coordinator-2", {
            provider: "claude",
            installationId: claudeId,
            model: "claude-opus-5-5",
            effort: "high",
          }),
        ],
        team: "automatic",
      },
      text: "How does file.ts hold its value?",
      mode: "discuss",
      kind: "code",
      commandId: `budget-${Date.now()}`,
    });
    const intakeOf = async (intakeId) =>
      (
        await command({ type: "session-query", sessionId: created.sessionId })
      ).intakes.find((i) => i.id === intakeId);
    const settled = (stage) =>
      ["decided", "failed", "stale", "stopped", "awaiting-user"].includes(
        stage,
      );
    await expect
      .poll(async () => settled((await intakeOf(created.intakeId))?.stage), {
        timeout: 120000,
      })
      .toBe(true);
    const first = await intakeOf(created.intakeId);
    const contributions = first.members.reduce(
      (n, m) => n + m.contributions.length,
      0,
    );
    check(
      "session intake: ledger delta equals the coordinators' contributions",
      summary(ledger).counted - before,
      contributions,
    );
    const ledgerLines = readFileSync(ledger, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    check(
      "the Claude coordinator's effort is in the ledger",
      [
        ...new Set(
          ledgerLines
            .slice(before)
            .filter((e) => e.provider === "claude")
            .map((e) => e.effort),
        ),
      ],
      ["high"],
    );

    // The cap: one turn above the count lets exactly one more through.
    const capAt = summary(ledger).counted + 1;
    await writeFile(`${ledger}.cap`, String(capAt));
    const next = await command({
      type: "session-message",
      sessionId: created.sessionId,
      text: "And which file declares it?",
      mode: "discuss",
      commandId: `budget-next-${Date.now()}`,
    });
    // What the owner sees while turns are refused: the intake's stage and
    // each member's state, sampled until it settles or 10 minutes pass.
    const history = [];
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const intake = await intakeOf(next.intakeId);
      const line = `${intake?.stage} | ${intake?.detail ?? ""} | ${(intake?.members ?? []).map((m) => `${m.memberId}:${m.state}`).join(",")} | refused ${summary(ledger).refused}`;
      if (history.at(-1)?.line !== line) {
        history.push({ at: new Date().toISOString(), line });
        console.log(`intake: ${line}`);
      }
      if (settled(intake?.stage) || Date.now() > deadline) break;
      await page.waitForTimeout(3000);
    }
    checks.push({ name: "intake history after the cap", history });
    check(
      "an intake whose turns are refused settles within 10 minutes",
      settled((await intakeOf(next.intakeId))?.stage),
      true,
    );
    // Give retries time to run; none may pass the cap.
    await page.waitForTimeout(5000);
    const afterCap = summary(ledger);
    check("the ledger never exceeds the cap", afterCap.counted, capAt);
    check("turns past the cap were refused", afterCap.refused > 0, true);
    const second = await intakeOf(next.intakeId);
    console.log(
      `After the cap: intake ${second.stage}; ${second.detail ?? ""}; refused ${afterCap.refused}`,
    );
    checks.push({
      name: "intake after the cap",
      stage: second.stage,
      detail: second.detail ?? null,
    });
    console.log(JSON.stringify(summary(ledger)));
  } finally {
    await app.close();
  }
  const failed = checks.filter((c) => c.passed === false);
  await writeFile(
    path.resolve(
      process.env.TOPSL_BUDGET_EVIDENCE ??
        "test-results/campaign-turn-budget.json",
    ),
    JSON.stringify({ checks, ledger: summary(ledger) }, null, 2),
  ).catch(() => {});
  if (failed.length) {
    console.error(`${failed.length} budget check(s) failed.`);
    process.exit(1);
  }
  console.log("Turn budget self-test passed.");
}

const [mode, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};
if (mode === "wrap")
  console.log(
    await wrap({
      provider: flag("--provider"),
      real: flag("--real"),
      ledger: flag("--ledger"),
      cap: Number(flag("--cap") ?? 80),
      out: flag("--out"),
    }),
  );
else if (mode === "report")
  console.log(JSON.stringify(summary(flag("--ledger")), null, 2));
else if (mode === "self-test") await selfTest();
else
  throw new Error(
    "Usage: node scripts/campaign-turn-budget.mjs wrap|report|self-test (see the header)",
  );
