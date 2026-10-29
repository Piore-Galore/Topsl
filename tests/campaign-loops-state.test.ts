import { afterEach, describe, expect, test } from "vitest";
import { commandSchema } from "../packages/domain/commands";
import { loopPolicySchema } from "../packages/domain/recursive-loops";
import type {
  LoopCheckpoint,
  LoopGoal,
  LoopIteration,
  LoopIntent,
  LoopRun,
  LoopUsage,
  LoopWakeup,
  PublicationCursor,
} from "../packages/domain/recursive-loops";
import {
  compactRecent,
  LoopSupervisor,
  loopKinds,
} from "../packages/orchestration/loop-engine";
import type { MemberTurn } from "../packages/orchestration/engine";
import { driveLoop, improvement, loopSetup, startRun } from "./loop-fixture";

/**
 * Campaign 2026-10-19, packet p6b-loops-state-ops (LOOP, STATE, OPS and the
 * §6.1 loop boundaries) over the real LoopSupervisor, Orchestrator and
 * encrypted store with the scripted engine driver (tests/loop-fixture.ts).
 * Nothing here is evidence for a live provider, model, folder or Electron UI.
 */
const open: Array<Awaited<ReturnType<typeof loopSetup>>> = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
type T = Awaited<ReturnType<typeof loopSetup>>;
const setup = async () => {
  const t = await loopSetup();
  open.push(t);
  return t;
};
const policy = { scheduling: { reserveForDirectWork: 0 } };
const resting = (v: { run: { state: string } }) =>
  ["completed", "waiting", "stopped", "monitoring"].includes(v.run.state);
const events = (t: T, runId?: string) =>
  [
    ...t.store.iterate<{ kind: string; detail: string; runId: string }>(
      loopKinds.event,
    ),
  ].filter((e) => !runId || e.runId === runId);
const usageOf = (t: T, runId: string) =>
  t.store.get<LoopUsage>(loopKinds.usage, `${runId}:usage`)!;
const runOf = (t: T, runId: string) =>
  t.store.get<LoopRun>(loopKinds.run, runId)!;
const pendingWakeups = (t: T, runId: string) =>
  [...t.store.iterate<LoopWakeup>(loopKinds.wakeup)].filter(
    (w) => w.runId === runId && w.state === "pending",
  );
const pendingIntents = (t: T, runId: string) =>
  [...t.store.iterate<LoopIntent>(loopKinds.intent)].filter(
    (i) => i.runId === runId && i.state === "pending",
  );

/** Scripted work, as in recursive-loops.test.ts: implementation "implements" the goals it advances. */
function implementing(
  t: T,
  broken: (text: string, turn: MemberTurn) => boolean = () => false,
) {
  const done = new Set<string>();
  const pending = new Set<string>();
  const base = t.driver.reply;
  t.driver.reply = (turn) => {
    if (turn.purpose === "implementation") {
      const section =
        /Goals advanced by this iteration:\n([\s\S]*?)(?:\n\n|$)/.exec(
          turn.prompt,
        )?.[1] ?? "";
      for (const line of section.split("\n")) {
        const text = /^- (.*?)(?: \(|$)/.exec(line)?.[1];
        if (text && !broken(text, turn)) pending.add(text);
      }
    }
    return base(turn);
  };
  t.script.met = (goalId, p) => {
    const g = p.goals.find((x) => x.id === goalId)!;
    if (p.stage === "evaluate") for (const x of pending) done.add(x);
    return done.has(g.text);
  };
  return { done, pending };
}

const parse = (command: unknown) => commandSchema.safeParse(command);
const createCommand = (extra: Record<string, unknown>) => ({
  type: "loop-create",
  projectId: "p",
  mode: "goal",
  commandId: "campaign-create-1",
  ...extra,
});
const check = (i: number, timeoutMs = 1000) => ({
  id: `check-${i}`,
  label: `Check ${i}`,
  executable: "/usr/bin/true",
  args: [],
  timeoutMs,
});

// ---------------------------------------------------------------------------
// §6.1 boundaries: the public command parser (U) and the supervisor (S)

describe("§6.1 loop boundaries through the public command schema and the supervisor", () => {
  test("goal batch 0/1/50/51 per call; accumulated goals beyond 50 across calls; text splitting has no per-call cap", async () => {
    const goals = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ text: `Goal ${i + 1}` }));
    // 0 parses (an empty array), and the supervisor then refuses a Goal run with no goals.
    expect(parse(createCommand({ goals: [] })).success).toBe(true);
    expect(parse(createCommand({ goals: goals(1) })).success).toBe(true);
    expect(parse(createCommand({ goals: goals(50) })).success).toBe(true);
    expect(parse(createCommand({ goals: goals(51) })).success).toBe(false);
    const update = (n: number) =>
      parse({
        type: "loop-goals-update",
        runId: "r",
        add: goals(n),
        commandId: "campaign-update-1",
      }).success;
    expect([update(0), update(1), update(50), update(51)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    const t = await setup();
    await expect(
      t.supervisor.create({
        projectId: "p",
        mode: "goal",
        goals: [],
        commandId: "campaign-zero-goals",
      }),
    ).rejects.toThrow(/at least one goal/);
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      goals: goals(50),
      policy,
      commandId: "campaign-fifty",
    });
    for (const [i, n] of [50, 50].entries())
      await t.supervisor.updateGoals({
        runId: created.run.id,
        add: goals(n).map((g) => ({ text: `${g.text} batch ${i + 2}` })),
        commandId: `campaign-batch-${i + 2}`,
      });
    // The 50 limit is per call; the run's lifetime goal list is not capped at 50.
    const stored = [...t.store.iterate<LoopGoal>(loopKinds.goal)].filter(
      (g) => g.runId === created.run.id,
    );
    expect(stored).toHaveLength(150);
    expect(new Set(stored.map((g) => g.id)).size).toBe(150);
    // A free-text request is split without the goals-array limit: 60 lines are 60 goals.
    const text = Array.from(
      { length: 60 },
      (_, i) => `Add feature number ${i + 1}`,
    ).join("\n");
    expect(parse(createCommand({ text })).success).toBe(true);
    const split = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text,
      policy,
      commandId: "campaign-sixty-lines",
    });
    expect(split.goals).toHaveLength(60);
  });

  test("goal text 3,999/4,000/4,001 counts Unicode code points (CJK, emoji, combining marks) and round-trips exactly", async () => {
    const ok = (text: string) =>
      parse(createCommand({ goals: [{ text }] })).success;
    expect(ok("a".repeat(3999))).toBe(true);
    expect(ok("a".repeat(4000))).toBe(true);
    expect(ok("a".repeat(4001))).toBe(false);
    // CJK BMP characters are one code point each.
    expect(ok("界".repeat(3999))).toBe(true);
    expect(ok("界".repeat(4000))).toBe(true);
    expect(ok("界".repeat(4001))).toBe(false);
    // An emoji outside the BMP is two UTF-16 code units but one code point:
    // the limit admits 4,000 emoji (8,000 code units) and refuses 4,001.
    expect("😀".length).toBe(2);
    expect(ok("😀".repeat(2001))).toBe(true);
    expect(ok("😀".repeat(4000))).toBe(true);
    expect(ok("😀".repeat(4001))).toBe(false);
    // A grapheme made of two code points counts twice: not a grapheme limit.
    expect(ok("e\u0301".repeat(2000))).toBe(true);
    expect(ok("e\u0301".repeat(2001))).toBe(false);
    expect(ok("")).toBe(false);
    const edit = (text: string) =>
      parse({
        type: "loop-goals-update",
        runId: "r",
        edit: [{ goalId: "g", text }],
        commandId: "campaign-edit-1",
      }).success;
    expect([edit("a".repeat(4000)), edit("a".repeat(4001))]).toEqual([
      true,
      false,
    ]);
    const t = await setup();
    const texts = ["a".repeat(4000), "界".repeat(4000), "😀".repeat(4000)];
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      goals: texts.map((text) => ({ text })),
      policy,
      commandId: "campaign-long-text",
    });
    const stored = [...t.store.iterate<LoopGoal>(loopKinds.goal)].filter(
      (g) => g.runId === created.run.id,
    );
    expect(stored.map((g) => g.text)).toEqual(texts);
    expect(stored.map((g) => g.originalText)).toEqual(texts);
  });

  test("goal priority -101/-100/0/100/101, fractions and wrong types", () => {
    const ok = (priority: unknown) =>
      parse(createCommand({ goals: [{ text: "Goal", priority }] })).success;
    expect([-101, -100, 0, 100, 101].map(ok)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
    expect(ok(1.5)).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok("1")).toBe(false);
    const edit = (priority: unknown) =>
      parse({
        type: "loop-goals-update",
        runId: "r",
        edit: [{ goalId: "g", priority }],
        commandId: "campaign-edit-2",
      }).success;
    expect([-101, -100, 100, 101].map(edit)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  test("required checks 1/2/20/21 and timeout 99/100/300,000/300,001 through the command and the supervisor", async () => {
    const checks = (n: number, timeoutMs = 1000) =>
      Array.from({ length: n }, (_, i) => check(i + 1, timeoutMs));
    const ok = (policy: unknown) => parse(createCommand({ policy })).success;
    expect([1, 2, 20, 21].map((n) => ok({ checks: checks(n) }))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(
      [99, 100, 300_000, 300_001].map((ms) => ok({ checks: checks(1, ms) })),
    ).toEqual([false, true, true, false]);
    // The supervisor validates the policy again, so a caller that skips the
    // command parser cannot store 21 checks.
    const t = await setup();
    const twenty = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, checks: checks(20) },
      commandId: "campaign-checks-20",
    });
    expect(t.supervisor.policy(twenty.run.id).checks).toHaveLength(20);
    await expect(
      t.supervisor.create({
        projectId: "p",
        mode: "goal",
        text: "Add a greeting",
        policy: { ...policy, checks: checks(21) },
        commandId: "campaign-checks-21",
      }),
    ).rejects.toThrow();
    expect(
      [...t.store.iterate<LoopRun>(loopKinds.run)].map((r) => r.id),
    ).toEqual([twenty.run.id]);
  });

  test("per-iteration bounds, rolling allowance and monitoring limits at one below, at and one above", () => {
    const p = (value: unknown) => loopPolicySchema.safeParse(value).success;
    const iteration = (patch: Record<string, number>) => ({
      iteration: {
        maxTurns: 200,
        maxDelegatedTasks: 20,
        maxRepairRounds: 2,
        maxApproachesPerTarget: 3,
        ...patch,
      },
    });
    const defaults = loopPolicySchema.parse({});
    expect(defaults.iteration).toEqual({
      maxTurns: 200,
      maxDelegatedTasks: 20,
      maxRepairRounds: 2,
      maxApproachesPerTarget: 3,
    });
    expect(defaults.monitoring).toEqual({
      initialSeconds: 300,
      maxSeconds: 21600,
      factor: 2,
    });
    expect(defaults.allowances).toEqual({
      runMemberTurns: null,
      rolling: null,
    });
    for (const [field, below, low, high, above] of [
      ["maxTurns", 0, 1, 2000, 2001],
      ["maxDelegatedTasks", 0, 1, 200, 201],
      ["maxRepairRounds", -1, 0, 10, 11],
      ["maxApproachesPerTarget", 0, 1, 20, 21],
    ] as const)
      expect(
        [below, low, high, above, low + 0.5].map((v) =>
          p(iteration({ [field]: v })),
        ),
      ).toEqual([false, true, true, false, false]);
    const rolling = (memberTurns: unknown, windowHours: unknown) =>
      p({ allowances: { rolling: { memberTurns, windowHours } } });
    expect([0.009, 0.01, 744, 744.01].map((h) => rolling(10, h))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect([0, 1, 1.5].map((n) => rolling(n, 1))).toEqual([false, true, false]);
    expect(
      [0, 1, 1.5].map((n) => p({ allowances: { runMemberTurns: n } })),
    ).toEqual([false, true, false]);
    const monitoring = (patch: Record<string, number>) =>
      p({
        monitoring: {
          initialSeconds: 300,
          maxSeconds: 21600,
          factor: 2,
          ...patch,
        },
      });
    expect(
      [0, 1, 86400, 86401].map((v) =>
        monitoring({ initialSeconds: v, maxSeconds: 604800 }),
      ),
    ).toEqual([false, true, true, false]);
    expect(
      [0, 1, 604800, 604801].map((v) =>
        monitoring({ initialSeconds: 1, maxSeconds: v }),
      ),
    ).toEqual([false, true, true, false]);
    expect([0.9, 1, 10, 10.1].map((v) => monitoring({ factor: v }))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // Initial greater than maximum is refused, though each value is in range
    // (accepted until the D-24 repair, 20 October 2026); equal is accepted.
    expect(monitoring({ initialSeconds: 86400, maxSeconds: 60 })).toBe(false);
    expect(monitoring({ initialSeconds: 61, maxSeconds: 60 })).toBe(false);
    expect(monitoring({ initialSeconds: 60, maxSeconds: 60 })).toBe(true);
  });

  test("loop-timeline limit 0/1/20 default/100/101 and cursor length at the command boundary", () => {
    const timeline = (extra: Record<string, unknown>) =>
      parse({ type: "loop-timeline", runId: "r", ...extra });
    expect(
      [0, 1, 20, 100, 101, 1.5].map((limit) => timeline({ limit }).success),
    ).toEqual([false, true, true, true, false, false]);
    const parsed = timeline({});
    expect(parsed.success && (parsed.data as { limit: number }).limit).toBe(20);
    expect(timeline({ cursor: "x".repeat(2000) }).success).toBe(true);
    expect(timeline({ cursor: "x".repeat(2001) }).success).toBe(false);
  });

  test("no public command lets a window or model assess, promote, admit or commit a topology", () => {
    for (const type of [
      "loop-promote",
      "loop-assess",
      "loop-admit",
      "loop-topology-commit",
      "loop-complete",
    ])
      expect(
        parse({ type, runId: "r", commandId: "campaign-x-1" }).success,
      ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOOP-03 / J-05: three required goals, one optional, regression on the last

describe("LOOP-03 / J-05: required goals are satisfied together on one checkpoint", () => {
  const goals = [
    { text: "Add the reader" },
    { text: "Add the writer" },
    { text: "Add the logger" },
    { text: "Polish the docs", required: false },
  ];
  async function run(t: T, extra: Record<string, unknown> = {}) {
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      goals,
      policy: { ...policy, ...extra },
      commandId: `campaign-loop03-${Math.random()}`,
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: `campaign-loop03-start-${Math.random()}`,
    });
    return created.run.id;
  }

  test("goal one regresses during goal three, reopens, is repaired, and completion binds every required goal to the final checkpoint", async () => {
    const t = await setup();
    const state = implementing(t);
    let breakReader = true;
    const met = t.script.met;
    // While the logger is evaluated, the candidate breaks the reader once.
    t.script.met = (goalId, p) => {
      const g = p.goals.find((x) => x.id === goalId)!;
      const result = met(goalId, p);
      if (
        p.stage === "evaluate" &&
        g.text === "Add the reader" &&
        breakReader &&
        state.pending.has("Add the logger")
      ) {
        breakReader = false;
        return false;
      }
      return result;
    };
    const runId = await run(t);
    // Observe every intermediate state: completion must never be declared early.
    const states: string[] = [];
    let view = t.supervisor.view(runId);
    for (let i = 0; i < 600 && !resting(view); i++) {
      await t.supervisor.orchestrator.tick();
      await t.supervisor.tick();
      view = t.supervisor.view(runId);
      states.push(
        `${view.run.state}@${view.checkpoint?.sequence}:${view.goals.map((g) => g.status[0]).join("")}`,
      );
      t.driver.settle();
    }
    expect(view.run.state).toBe("completed");
    const regressedEvent = events(t, runId).find(
      (e) => e.kind === "goal-regressed",
    );
    // The regression names the goal it broke.
    expect(regressedEvent?.detail).toMatch(/breaks Add the reader/);
    // The reader was satisfied, then reopened (regressed) while the third iteration ran.
    const readerRegressed = (s: string) => s.split(":")[1]?.[0] === "r";
    expect(states.some(readerRegressed)).toBe(true);
    expect(
      states.filter((s) => s.startsWith("completed")).length,
    ).toBeGreaterThan(0);
    expect(states.findIndex((s) => s.startsWith("completed"))).toBeGreaterThan(
      states.findIndex(readerRegressed),
    );
    const head = view.checkpoint!;
    expect(head.sequence).toBe(3);
    const promoted = t.supervisor
      .iterations(view.run)
      .filter((i) => i.state === "promoted");
    // The optional goal never prolonged the run.
    expect(promoted).toHaveLength(3);
    expect(promoted.flatMap((i) => i.goalIds)).not.toContain(
      view.goals.find((g) => g.text === "Polish the docs")!.id,
    );
    // The third iteration repaired the regression before promoting.
    expect(promoted[2].repairs).toBeGreaterThan(0);
    // Every required goal: satisfied on the same, final checkpoint, by an
    // assessment of that checkpoint's exact content and the goal's current version.
    for (const g of view.goals.filter((x) => x.required)) {
      expect(g.status).toBe("satisfied");
      expect(g.satisfiedAtCheckpointId).toBe(head.id);
      expect(g.regression).toBeNull();
      expect(g.assessment!.goalVersion).toBe(g.version);
      expect(g.assessment!.target.contentDigest).toBe(head.contentDigest);
      expect(g.assessment!.result).toBe("satisfied");
    }
    const optional = view.goals.find((g) => !g.required)!;
    expect(optional.status).not.toBe("satisfied");
    expect(view.completion).not.toBeNull();
  });

  test("negative control: a regression that cannot be repaired rejects the candidate; the head and the reader's evidence stay at checkpoint 2", async () => {
    const t = await setup();
    const state = implementing(t);
    const met = t.script.met;
    // The logger's candidate always breaks the reader, and no repair is allowed.
    t.script.met = (goalId, p) => {
      const g = p.goals.find((x) => x.id === goalId)!;
      const result = met(goalId, p);
      return p.stage === "evaluate" &&
        g.text === "Add the reader" &&
        state.pending.has("Add the logger")
        ? false
        : result;
    };
    const runId = await run(t, { iteration: { maxRepairRounds: 0 } });
    const view = await driveLoop(
      t,
      runId,
      (v) =>
        v.run.state === "completed" ||
        v.iterations.some((i) => i.state === "rejected"),
      600,
    );
    expect(view.run.state).not.toBe("completed");
    const rejected = t.supervisor
      .iterations(view.run)
      .find((i) => i.state === "rejected")!;
    expect(rejected).toBeTruthy();
    expect(view.checkpoint!.sequence).toBe(2);
    expect(view.run.acceptedCheckpointId).toBe(rejected.parentCheckpointId);
    const logger = view.goals.find((g) => g.text === "Add the logger")!;
    expect(logger.status).not.toBe("satisfied");
    expect(events(t, runId).some((e) => e.kind === "run-completed")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// LOOP-09 / J-06 (first half): Endless never completes; bounded growing backoff

describe("LOOP-09: Endless monitoring backs off to its cap and never completes", () => {
  test("one promoted improvement, reassessment from checkpoint 1, then monitoring with 300 s doubling to the 21,600 s cap and no busy loop", async () => {
    const t = await setup();
    let offered = 0;
    t.script.opportunities = () =>
      offered++ === 0 ? [improvement("Cache the parser")] : [];
    t.script.met = (_id, p) => p.stage === "evaluate";
    const boundaryTargets: string[] = [];
    const reply = t.driver.reply;
    t.driver.reply = (turn) => {
      if (turn.protocol?.stage === "boundary")
        boundaryTargets.push(turn.contextCandidateId ?? "null");
      return reply(turn);
    };
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving the parser.",
      policy,
    });
    const runId = started.run.id;
    let view = await driveLoop(
      t,
      runId,
      (v) => v.run.state === "monitoring",
      400,
    );
    expect(view.checkpoint!.sequence).toBe(1);
    const head = view.checkpoint!;
    const delays: number[] = [view.run.backoffSeconds];
    const launchesPerCycle: number[] = [];
    for (let cycle = 0; cycle < 9; cycle++) {
      const before = t.driver.launches.length;
      // No busy loop: many ticks before the wakeup is due start nothing.
      t.advance(view.run.backoffSeconds * 1000 - 1000);
      for (let i = 0; i < 10; i++) await t.supervisor.tick();
      expect(t.driver.launches.length).toBe(before);
      expect(runOf(t, runId).state).toBe("monitoring");
      t.advance(1001);
      const previous = view.run.backoffSeconds;
      view = await driveLoop(
        t,
        runId,
        (v) =>
          v.run.state === "monitoring" &&
          (v.run.backoffSeconds !== previous || previous === 21600) &&
          t.driver.launches.length > before,
        200,
      );
      expect(view.run.state).toBe("monitoring");
      delays.push(view.run.backoffSeconds);
      launchesPerCycle.push(t.driver.launches.length - before);
    }
    expect(delays).toEqual([
      300, 600, 1200, 2400, 4800, 9600, 19200, 21600, 21600, 21600,
    ]);
    // Each wakeup reassesses once; no gratuitous changes: the head never moved again.
    expect(new Set(launchesPerCycle).size).toBe(1);
    expect(view.checkpoint!.id).toBe(head.id);
    expect(view.run.completedAt).toBeNull();
    expect(events(t, runId).some((e) => e.kind === "run-completed")).toBe(
      false,
    );
    const pending = pendingWakeups(t, runId);
    expect(pending).toHaveLength(1);
    expect(pending[0].backoffSeconds).toBe(21600);
    // Reassessment after promotion read the accepted checkpoint 1 content.
    expect(boundaryTargets.at(-1)).toBe(head.candidateId);
  });

  test("monitoring initial greater than maximum is refused with the reason, at the command and when a run starts", async () => {
    // Observed on 2026-10-19 (D-24): the run started and its delays were
    // 3,600 s, then 60 s, then 60 s.
    const command = parse({
      type: "loop-policy-update",
      runId: "r",
      expectedRevision: 1,
      policy: { monitoring: { initialSeconds: 3600, maxSeconds: 60 } },
      commandId: "policy-command",
    });
    expect(command.success).toBe(false);
    expect(command.error!.issues.map((i) => i.message).join(" ")).toContain(
      "cannot be longer than the maximum delay",
    );
    const t = await setup();
    await expect(
      startRun(t, {
        mode: "endless",
        text: "Keep improving.",
        policy: {
          ...policy,
          monitoring: { initialSeconds: 3600, maxSeconds: 60, factor: 2 },
        },
      }),
    ).rejects.toThrow("cannot be longer than the maximum delay");
  });

  test("a stored policy whose initial delay exceeds its maximum waits no longer than the maximum", async () => {
    const t = await setup();
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy,
    });
    // A policy saved before the D-24 repair could hold initial > maximum.
    const stored = t.supervisor.policy(started.run.id);
    t.store.save(loopKinds.policy, {
      ...stored,
      monitoring: { initialSeconds: 3600, maxSeconds: 60, factor: 2 },
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "monitoring",
    );
    expect(view.run.backoffSeconds).toBe(60);
  });

  test("monitoring initial greater than maximum is either refused or bounded by the maximum", async () => {
    const t = await setup();
    let refused = false;
    let first = 0;
    try {
      const started = await startRun(t, {
        mode: "endless",
        text: "Keep improving.",
        policy: {
          ...policy,
          monitoring: { initialSeconds: 3600, maxSeconds: 60, factor: 2 },
        },
      });
      const view = await driveLoop(
        t,
        started.run.id,
        (v) => v.run.state === "monitoring",
      );
      first = view.run.backoffSeconds;
    } catch {
      refused = true;
    }
    expect(refused || first <= 60).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LOOP-11 / J-06 (second half): stop versus wakeup, quota renewal, route change, restart

type Event = "wakeup" | "quota" | "route" | "restart";
const permutations = <X>(items: X[]): X[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((x, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
          (rest) => [x, ...rest],
        ),
      );

/** An Endless run monitoring with a quota limit recorded; resumeAfterRestart on, so restart alone would resume it. */
async function monitoringRun(t: T) {
  const started = await startRun(t, {
    mode: "endless",
    text: "Keep improving.",
    policy: { ...policy, recovery: { resumeAfterRestart: true } },
  });
  await driveLoop(t, started.run.id, (v) => v.run.state === "monitoring");
  return started.run.id;
}

async function apply(
  t: T,
  ctx: { supervisor: LoopSupervisor },
  runId: string,
  e: Event | "stop",
) {
  const s = ctx.supervisor;
  switch (e) {
    case "stop":
      await s.control({
        runId,
        action: "stop",
        commandId: `campaign-stop-${Math.random()}`,
      });
      break;
    case "wakeup":
      // Past the due wakeup; repeated ticks deliver it more than once.
      t.advance(7 * 3_600_000);
      break;
    case "quota":
      // A quota limit is reported, then renews.
      t.loop.limits = [
        {
          provider: "codex",
          kind: "quota",
          detail: "rate_limit_reached",
          retryAt: new Date(t.now() + 60_000).toISOString(),
        },
      ];
      await s.tick();
      t.driver.settle();
      await s.tick();
      t.loop.limits = [];
      t.advance(60_001);
      break;
    case "route":
      t.driver.routesList = t.driver.routesList.map((r) =>
        r.provider === "codex"
          ? {
              ...r,
              installationRevision: `${r.installationRevision}-${Math.random()}`,
            }
          : r,
      );
      break;
    case "restart":
      s.suspend();
      ctx.supervisor = t.reopenSupervisor();
      await ctx.supervisor.recover();
      break;
  }
  for (let i = 0; i < 4; i++) {
    await ctx.supervisor.orchestrator.tick();
    await ctx.supervisor.tick();
    t.driver.settle();
  }
}

describe("LOOP-11 / J-06: a stopped monitoring run stays stopped in every delivery order", () => {
  test("negative control: without Stop, each of wakeup, route change and restart (auto-resume) starts new work", async () => {
    for (const e of ["wakeup", "route", "restart"] as const) {
      const t = await setup();
      const runId = await monitoringRun(t);
      const ctx = { supervisor: t.supervisor };
      const launches = t.driver.launches.length;
      const iterations = runOf(t, runId).iterationCount;
      await apply(t, ctx, runId, e);
      if (e === "restart") {
        // Restart resumed it (policy) and a due wakeup then dispatches.
        expect(runOf(t, runId).desiredState).toBe("running");
        await apply(t, ctx, runId, "wakeup");
      }
      expect(t.driver.launches.length, e).toBeGreaterThan(launches);
      expect(runOf(t, runId).iterationCount, e).toBeGreaterThan(iterations);
    }
  });

  test.each(permutations<Event>(["wakeup", "quota", "route", "restart"]))(
    "order %s, %s, %s, %s with Stop at each position",
    async (...order: Event[]) => {
      for (let position = 0; position <= order.length; position++) {
        const t = await setup();
        const runId = await monitoringRun(t);
        const ctx = { supervisor: t.supervisor };
        const sequence: Array<Event | "stop"> = [...order];
        sequence.splice(position, 0, "stop");
        let launchesAtStop = -1;
        let iterationsAtStop = -1;
        let firedAtStop = -1;
        const firedCount = () =>
          [...t.store.iterate<LoopWakeup>(loopKinds.wakeup)].filter(
            (w) => w.runId === runId && w.state === "fired",
          ).length;
        for (const e of sequence) {
          await apply(t, ctx, runId, e);
          if (e === "stop") {
            // Settle what Stop interrupted, then freeze the counts.
            for (let i = 0; i < 4; i++) {
              t.driver.settle();
              await ctx.supervisor.tick();
            }
            launchesAtStop = t.driver.launches.length;
            iterationsAtStop = runOf(t, runId).iterationCount;
            firedAtStop = firedCount();
          }
        }
        // A last due wakeup and restart after everything.
        await apply(t, ctx, runId, "wakeup");
        await apply(t, ctx, runId, "restart");
        const label = sequence.join(">");
        const run = runOf(t, runId);
        expect(run.desiredState, label).toBe("stopped");
        expect(run.state, label).toBe("stopped");
        expect(t.driver.launches.length, label).toBe(launchesAtStop);
        expect(run.iterationCount, label).toBe(iterationsAtStop);
        expect(pendingWakeups(t, runId), label).toEqual([]);
        expect(pendingIntents(t, runId), label).toEqual([]);
        // No wakeup fired after Stop was requested.
        expect(firedCount(), label).toBe(firedAtStop);
        // A wakeup fires at most once.
        const fired = [...t.store.iterate<LoopWakeup>(loopKinds.wakeup)].filter(
          (w) => w.runId === runId && w.state === "fired",
        );
        expect(new Set(fired.map((w) => w.id)).size, label).toBe(fired.length);
        expect(
          events(t, runId).filter((e) => e.kind === "wait-exited").length,
          label,
        ).toBe(fired.length);
        await t.close();
        open.splice(open.indexOf(t), 1);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// OPS-01 / J-09: cumulative allowance across child boundaries and restart

/** Every scripted launch is one member turn (decision, endorsement, child, retry, repair). */
const launchedTurns = (t: T, runId: string) => {
  const childGoals = new Set(
    t.supervisor
      .iterations(runOf(t, runId))
      .flatMap((i) => i.childExecutionGoalIds),
  );
  const loopRounds = new Set(
    [...t.store.iterate<{ id: string; runId: string }>(loopKinds.round)]
      .filter((r) => r.runId === runId)
      .map((r) => r.id),
  );
  return t.driver.launches.filter(
    (l) => childGoals.has(l.goalId) || loopRounds.has(l.roundId),
  ).length;
};

describe("OPS-01 / J-09: the run allowance is cumulative across children, failures and restart", () => {
  test("decision, child, failed-and-retried turns all count; exhaustion waits (never completes) through restart; raising the allowance resumes without a reset", async () => {
    const t = await setup();
    let n = 0;
    t.script.opportunities = () => [improvement(`Step ${++n}`)];
    t.script.met = (_id, p) => p.stage === "evaluate";
    // The first implementation attempt fails and is retried.
    let failed = 0;
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" && failed++ === 0
        ? { text: "", state: "failed" }
        : reply(turn);
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: { ...policy, allowances: { runMemberTurns: 12 } },
    });
    const runId = started.run.id;
    let view = await driveLoop(t, runId, (v) => v.run.state === "waiting", 600);
    expect(view.run.waitReason).toMatchObject({ kind: "allowance" });
    expect(view.run.waitReason!.detail).toMatch(/not completion/);
    expect(failed).toBeGreaterThan(1);
    const counted = view.usage.memberTurns;
    // The persisted counter equals the immutable launches the run owns.
    expect(counted).toBe(launchedTurns(t, runId));
    expect(counted).toBeLessThanOrEqual(12);
    expect(counted).toBeGreaterThan(12 - 4);
    const childGoals = t.supervisor
      .iterations(view.run)
      .flatMap((i) => i.childExecutionGoalIds);
    expect(childGoals.length).toBeGreaterThan(1);
    // Waiting persists: time, ticks and a restart neither complete nor reset it.
    const launches = t.driver.launches.length;
    t.advance(31 * 86_400_000);
    for (let i = 0; i < 10; i++) await t.supervisor.tick();
    t.supervisor.suspend();
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    await reopened.control({
      runId,
      action: "resume",
      commandId: "campaign-ops01-resume",
    });
    for (let i = 0; i < 10; i++) {
      await reopened.orchestrator.tick();
      await reopened.tick();
      t.driver.settle();
    }
    expect(t.driver.launches.length).toBe(launches);
    expect(usageOf(t, runId).memberTurns).toBe(counted);
    expect(runOf(t, runId).state).toBe("waiting");
    expect(runOf(t, runId).completedAt).toBeNull();
    // J-09: raising the numeric allowance is not a widening; no dialog digest is required.
    await reopened.updatePolicy({
      runId,
      expectedRevision: reopened.policy(runId).revision,
      policy: { allowances: { runMemberTurns: 30, rolling: null } },
      commandId: "campaign-ops01-raise",
    });
    view = await driveLoop(
      t,
      runId,
      (v) => v.run.state === "waiting" && v.usage.memberTurns > counted,
      600,
      reopened,
    );
    expect(t.driver.launches.length).toBeGreaterThan(launches);
    expect(view.usage.memberTurns).toBeGreaterThan(counted);
    expect(view.usage.memberTurns).toBeLessThanOrEqual(30);
    expect(view.usage.memberTurns).toBe(launchedTurns(t, runId));
  });

  test("a Goal run whose allowance is spent waits with the allowance reason and never reports completion", async () => {
    const t = await setup();
    t.script.met = () => false;
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, allowances: { runMemberTurns: 6 } },
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "waiting" || v.run.state === "completed",
      400,
    );
    expect(view.run.state).toBe("waiting");
    expect(view.run.waitReason!.kind).toMatch(/allowance|user-input/);
    expect(view.usage.memberTurns).toBeLessThanOrEqual(6);
    expect(view.run.completedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OPS-02: rolling accounting beyond 2,000 updates, and crash between usage and iteration cursor

describe("OPS-02: accounting updates against immutable attempts", () => {
  /**
   * An Endless run at rest, then `updates` one-turn accounting updates through
   * the production account() boundary (the same call advance() makes), one
   * second apart, all inside one rolling window. Driving it directly reaches
   * 2,000+ updates in bounded time.
   */
  async function accounted(t: T, rollingTurns: number, slack: number) {
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: {
        ...policy,
        allowances: {
          runMemberTurns: null,
          rolling: { memberTurns: rollingTurns, windowHours: 24 },
        },
      },
    });
    const runId = started.run.id;
    await driveLoop(t, runId, (v) => v.run.state === "monitoring");
    const k = usageOf(t, runId).memberTurns;
    const updates = rollingTurns - k - slack;
    const s = t.supervisor as unknown as {
      account(run: LoopRun, it: LoopIteration, turns: number): LoopIteration;
    };
    let it = t.supervisor.iterations(runOf(t, runId))[0];
    for (let i = 0; i < updates; i++) {
      t.advance(1000);
      it = s.account(runOf(t, runId), it, it.memberTurns + 1);
    }
    return { runId, k, updates };
  }

  test("over 2,000 updates the lifetime counter stays exact and the compacted rolling history keeps every turn in the window", async () => {
    const t = await setup();
    const { runId, k, updates } = await accounted(t, 2010, 3);
    expect(updates).toBeGreaterThan(2000);
    const usage = usageOf(t, runId);
    expect(usage.memberTurns).toBe(k + updates);
    expect(usage.recent.length).toBeLessThan(updates);
    const inWindow = usage.recent.reduce((n, r) => n + r.turns, 0);
    expect(inWindow).toBe(k + updates);
  });

  test("compacted history stays bounded over 20,000 updates and only ever dates a turn later, by at most 1/64 of its age", () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    let recent: LoopUsage["recent"] = [];
    let at = start;
    for (let i = 0; i < 20_000; i++) {
      at += 60_000;
      recent = compactRecent(
        [...recent, { at: new Date(at).toISOString(), turns: 1 }],
        at,
      );
    }
    expect(recent.reduce((n, r) => n + r.turns, 0)).toBe(20_000);
    expect(recent.length).toBeLessThan(2000);
    for (const r of recent) {
      const latest = Date.parse(r.at);
      const earliest = Date.parse(r.from ?? r.at);
      expect(latest - earliest).toBeLessThanOrEqual((at - latest) / 64 + 1);
    }
  });

  test("negative control: with fewer than 2,000 updates in the window, 3 turns left (< 4) waits for the rolling allowance", async () => {
    const t = await setup();
    const { runId } = await accounted(t, 1010, 3);
    const launches = t.driver.launches.length;
    t.advance(7 * 3_600_000 - 1_100_000);
    for (let i = 0; i < 6; i++) {
      await t.supervisor.tick();
      t.driver.settle();
    }
    expect(t.driver.launches.length).toBe(launches);
    expect(runOf(t, runId).waitReason).toMatchObject({ kind: "allowance" });
  });

  // Regression for D-04 (OPS-02, fixed 2026-10-19): LoopUsage.recent was sliced to 2,000 entries, so the rolling allowance undercounted. It is now compacted without losing turns (compactRecent).
  test("with more than 2,000 updates in the window, 3 turns left (< 4) still waits for the rolling allowance", async () => {
    const t = await setup();
    const { runId } = await accounted(t, 2010, 3);
    const launches = t.driver.launches.length;
    t.advance(7 * 3_600_000 - 2_100_000);
    for (let i = 0; i < 6; i++) {
      await t.supervisor.tick();
      t.driver.settle();
    }
    expect(runOf(t, runId).waitReason).toMatchObject({ kind: "allowance" });
    expect(t.driver.launches.length).toBe(launches);
  });

  /** Fails the next iteration-cursor write that only records member turns: a crash right after the usage write. */
  function crashAfterUsageWrite(s: LoopSupervisor) {
    const target = s as unknown as {
      saveIteration(it: LoopIteration, next: Partial<LoopIteration>): unknown;
    };
    const original = target.saveIteration.bind(s);
    let armed = true;
    target.saveIteration = (it, next) => {
      if (armed && Object.keys(next).join() === "memberTurns") {
        armed = false;
        throw new Error("campaign crash after the usage record");
      }
      return original(it, next);
    };
    return () => !armed;
  }

  test("negative control: without a crash, cumulative usage equals the immutable launches", async () => {
    const t = await setup();
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    const view = await driveLoop(t, started.run.id, resting, 400);
    expect(view.run.state).toBe("completed");
    expect(view.usage.memberTurns).toBe(launchedTurns(t, started.run.id));
  });

  // Regression for D-05 (OPS-02, fixed 2026-10-19): account() wrote the usage record and the iteration's memberTurns cursor separately, so a crash between them double-charged. Both are now one transaction.
  test("a crash between the usage record and the iteration cursor neither loses nor duplicates a turn charge after restart", async () => {
    const t = await setup();
    implementing(t);
    const crashed = crashAfterUsageWrite(t.supervisor);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(t, started.run.id, () => crashed(), 200);
    expect(crashed()).toBe(true);
    // Restart from the persisted state and replay.
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    const view = await driveLoop(t, started.run.id, resting, 400, reopened);
    expect(view.run.state).toBe("completed");
    expect(view.usage.memberTurns).toBe(launchedTurns(t, started.run.id));
  });
});

// ---------------------------------------------------------------------------
// STATE-04 / STATE-05: crash and replay boundaries

describe("STATE-04 / STATE-05: promotion and launch crash boundaries", () => {
  test("STATE-04: a crash after the promotion transaction, before the child is settled, recovers to one checkpoint, one intent and one admitted child", async () => {
    const t = await setup();
    implementing(t);
    const orchestrator = t.orchestrator as unknown as {
      settleLoopGoal: (input: unknown) => unknown;
    };
    const settle = orchestrator.settleLoopGoal.bind(t.orchestrator);
    let crashed = false;
    orchestrator.settleLoopGoal = (input: any) => {
      if (!crashed && input.outcome === "promoted") {
        crashed = true;
        throw new Error("campaign crash after the promotion transaction");
      }
      return settle(input);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    const runId = started.run.id;
    await driveLoop(t, runId, () => crashed, 300);
    expect(crashed).toBe(true);
    const first = t.supervisor
      .iterations(runOf(t, runId))
      .find((i) => i.number === 1)!;
    expect(first.state).toBe("promoted");
    const child = first.childExecutionGoalIds[0];
    // The crash left the child unsettled.
    expect(
      t.orchestrator.repo.require<{ loopDisposition: unknown }>("goal", child)
        .loopDisposition ?? null,
    ).toBeNull();
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    const view = await driveLoop(t, runId, resting, 400, reopened);
    expect(view.run.state).toBe("completed");
    const promotions = [
      ...t.store.iterate<{ iterationId: string }>(loopKinds.promotion),
    ];
    expect(promotions.filter((p) => p.iterationId === first.id)).toHaveLength(
      1,
    );
    expect(
      [...t.store.iterate<LoopCheckpoint>(loopKinds.checkpoint)].filter(
        (c) => c.iterationId === first.id,
      ),
    ).toHaveLength(1);
    expect(
      [...t.store.iterate<LoopIntent>(loopKinds.intent)].filter(
        (i) => i.runId === runId && i.number === 2,
      ),
    ).toHaveLength(1);
    expect(
      reopened.iterations(view.run).filter((i) => i.number === 2),
    ).toHaveLength(1);
    expect(
      events(t, runId).filter(
        (e) =>
          e.kind === "checkpoint-promoted" && /iteration 1\b/.test(e.detail),
      ),
    ).toHaveLength(1);
  });

  // Regression for D-03 (STATE-04, fixed 2026-10-19): a crash between the promotion transaction and settleLoopGoal left the child unsettled and skipped finishIteration. The transaction now marks settlementPending, which the next tick completes.
  test("STATE-04: recovery settles the persisted promotion's child goal", async () => {
    const t = await setup();
    implementing(t);
    const orchestrator = t.orchestrator as unknown as {
      settleLoopGoal: (input: unknown) => unknown;
    };
    const settle = orchestrator.settleLoopGoal.bind(t.orchestrator);
    let crashed = false;
    orchestrator.settleLoopGoal = (input: any) => {
      if (!crashed && input.outcome === "promoted") {
        crashed = true;
        throw new Error("campaign crash after the promotion transaction");
      }
      return settle(input);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(t, started.run.id, () => crashed, 300);
    const first = t.supervisor
      .iterations(runOf(t, started.run.id))
      .find((i) => i.number === 1)!;
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    await driveLoop(t, started.run.id, resting, 400, reopened);
    const child = t.orchestrator.repo.require<{
      state: string;
      loopDisposition: { outcome: string; by: string } | null;
    }>("goal", first.childExecutionGoalIds[0]);
    const settled = reopened
      .iterations(runOf(t, started.run.id))
      .find((i) => i.number === 1)!;
    // Both the child's disposition and the iteration's outcome records
    // (finishIteration) belong to settling the persisted promotion.
    expect({
      disposition: child.loopDisposition?.outcome ?? null,
      by: child.loopDisposition?.by ?? null,
      childState: child.state,
      outcomesRecorded: settled.outcomeRecordIds.length > 0,
    }).toEqual({
      disposition: "promoted",
      by: "loop-policy",
      childState: "completed",
      outcomesRecorded: true,
    });
  });

  test("STATE-05: a launch refused before process creation is never counted as launched, and the member is retried once", async () => {
    const t = await setup();
    implementing(t);
    let refused = 0;
    t.driver.failLaunch = (turn) =>
      turn.protocol?.kind === "recursive-loop-v1" && refused++ === 0;
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const view = await driveLoop(t, started.run.id, resting, 300);
    expect(refused).toBeGreaterThan(1);
    expect(view.run.state).toBe("completed");
    // No attempt exists for the refused launch; usage counts only real launches.
    expect(view.usage.memberTurns).toBe(launchedTurns(t, started.run.id));
  });

  test("STATE-05: a child implementation launch recorded before a crash is adopted after restart, not replayed", async () => {
    const t = await setup();
    implementing(t);
    // The first implementation launch is recorded, then the process "dies"
    // before the engine hears back (the call never returns).
    const launch = t.driver.launch.bind(t.driver);
    let crashed = false;
    t.driver.launch = async (turn) => {
      if (!crashed && turn.purpose === "implementation") {
        crashed = true;
        t.driver.crashAfterRecord = true;
      }
      return launch(turn);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    for (let i = 0; i < 200 && !crashed; i++) {
      await Promise.race([
        t.orchestrator.tick(),
        new Promise((r) => setTimeout(r, 20)),
      ]);
      if (crashed) break;
      await t.supervisor.tick();
      t.driver.settle();
    }
    expect(crashed).toBe(true);
    const implementations = () =>
      t.driver.launches.filter((l) => l.purpose === "implementation");
    expect(implementations()).toHaveLength(1);
    const launchId = implementations()[0].launchId;
    const reopened = t.reopenSupervisor();
    await reopened.orchestrator.recover();
    await reopened.recover();
    const view = await driveLoop(t, started.run.id, resting, 300, reopened);
    expect(view.run.state).toBe("completed");
    // The recorded launch was adopted: no second launch for that launch ID,
    // and no second implementation turn for the same task.
    expect(
      t.driver.launches.filter((l) => l.launchId === launchId),
    ).toHaveLength(1);
    expect(implementations()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// STATE-09 (supervisor boundary): publication intent, failure points and restart

describe("STATE-09: publication failure points keep a durable uncertain intent and never replay", () => {
  async function promoted(t: T) {
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(t, started.run.id, resting, 300);
    expect(runOf(t, started.run.id).state).toBe("completed");
    return started.run.id;
  }
  const cursorOf = (t: T, runId: string) =>
    t.store.get<PublicationCursor>(loopKinds.cursor, `${runId}:publication`);

  test("a proven prewrite refusal leaves no intent and is retryable", async () => {
    const t = await setup();
    const runId = await promoted(t);
    t.loop.folder.problems = ["The project folder has uncommitted changes."];
    const review = await t.supervisor.publicationReview(runId);
    await expect(
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-pub-prewrite",
      }),
    ).rejects.toThrow(/Nothing was written/);
    expect(cursorOf(t, runId)).toBeUndefined();
    expect(runOf(t, runId).publicationCursorId).toBeNull();
    expect(t.loop.published).toHaveLength(0);
    // Repeating the same command ID returns the recorded refusal; a new one can retry.
    await expect(
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-pub-prewrite",
      }),
    ).rejects.toThrow(/Nothing was written/);
    t.loop.folder.problems = [];
    const retry = await t.supervisor.publicationReview(runId);
    await t.supervisor.publish({
      runId,
      digest: retry.digest,
      commandId: "campaign-pub-retry",
    });
    expect(t.loop.published).toHaveLength(1);
    expect(cursorOf(t, runId)!.state).toBe("published");
  });

  test("a failure after writes may have started is uncertain, explained, not repeated by any command, and survives restart", async () => {
    const t = await setup();
    const runId = await promoted(t);
    let writes = 0;
    t.loop.publicationApply = async () => {
      writes++;
      throw new Error("disk full after the first file");
    };
    const review = await t.supervisor.publicationReview(runId);
    await expect(
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-pub-kth",
      }),
    ).rejects.toThrow(/may have written files.*will not write it again/);
    const cursor = cursorOf(t, runId)!;
    expect(cursor.state).toBe("uncertain");
    expect(cursor.receipts.at(-1)).toMatchObject({ outcome: "uncertain" });
    for (const commandId of ["campaign-pub-kth", "campaign-pub-kth-2"])
      await expect(
        t.supervisor.publish({ runId, digest: review.digest, commandId }),
      ).rejects.toThrow();
    await expect(t.supervisor.publicationReview(runId)).rejects.toThrow(
      /unknown outcome/,
    );
    expect(writes).toBe(1);
    t.supervisor.suspend();
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    await expect(reopened.publicationReview(runId)).rejects.toThrow(
      /unknown outcome/,
    );
    expect(reopened.view(runId).publication.cursor!.state).toBe("uncertain");
    expect(writes).toBe(1);
  });

  test("a crash after readback, before the receipt, restarts as uncertain and is never written again", async () => {
    const t = await setup();
    const runId = await promoted(t);
    let writes = 0;
    // The files are written and read back; the process dies before the receipt.
    t.loop.publicationApply = async () => {
      writes++;
      t.loop.published.push({ from: "base-c", to: "head" });
      return new Promise<never>(() => {});
    };
    const review = await t.supervisor.publicationReview(runId);
    void t.supervisor.publish({
      runId,
      digest: review.digest,
      commandId: "campaign-pub-crash",
    });
    await new Promise((r) => setTimeout(r, 20));
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    expect(cursorOf(t, runId)!.state).toBe("uncertain");
    await expect(reopened.publicationReview(runId)).rejects.toThrow(
      /unknown outcome/,
    );
    await expect(
      reopened.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-pub-crash-2",
      }),
    ).rejects.toThrow(/unknown outcome/);
    expect(writes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// STATE-12: concurrent and repeated commands from two windows

describe("STATE-12: concurrent commands keep one authoritative transition", () => {
  async function promotedRun(t: T) {
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(t, started.run.id, resting, 300);
    // A slower folder write widens the window in which two windows overlap.
    const apply = t.loop.publicationApply.bind(t.loop);
    t.loop.publicationApply = async (input) => {
      await new Promise((r) => setTimeout(r, 30));
      return apply(input);
    };
    return started.run.id;
  }

  test("two windows start the same run with one reviewed digest: one start, one checkpoint 0, one first intent", async () => {
    const t = await setup();
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy,
      commandId: "campaign-s12-create",
    });
    const digest = t.supervisor.authorityReview(created.run.id).digest;
    const results = await Promise.allSettled([
      t.supervisor.start({
        runId: created.run.id,
        digest,
        commandId: "campaign-s12-start-a",
      }),
      t.supervisor.start({
        runId: created.run.id,
        digest,
        commandId: "campaign-s12-start-b",
      }),
    ]);
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      [...t.store.iterate<LoopCheckpoint>(loopKinds.checkpoint)].filter(
        (c) => c.runId === created.run.id,
      ),
    ).toHaveLength(1);
    expect(
      [...t.store.iterate<LoopIntent>(loopKinds.intent)].filter(
        (i) => i.runId === created.run.id,
      ),
    ).toHaveLength(1);
    expect(runOf(t, created.run.id).started).toBe(true);
  });

  test("a stale expected policy revision is refused; the first update wins", async () => {
    const t = await setup();
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const revision = t.supervisor.policy(started.run.id).revision;
    const [a, b] = await Promise.allSettled([
      t.supervisor.updatePolicy({
        runId: started.run.id,
        expectedRevision: revision,
        policy: { allowances: { runMemberTurns: 50, rolling: null } },
        commandId: "campaign-s12-policy-a",
      }),
      t.supervisor.updatePolicy({
        runId: started.run.id,
        expectedRevision: revision,
        policy: { allowances: { runMemberTurns: 70, rolling: null } },
        commandId: "campaign-s12-policy-b",
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const after = t.supervisor.policy(started.run.id);
    expect(after.revision).toBe(revision + 1);
    expect(after.allowances.runMemberTurns).toBe(
      a.status === "fulfilled" ? 50 : 70,
    );
    expect(
      (b.status === "rejected" ? b : a) as PromiseRejectedResult,
    ).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/policy changed/),
      }),
    });
  });

  test("concurrent pause and stop end stopped; a later resume is refused", async () => {
    const t = await setup();
    t.driver.reply = () => "hang";
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(
      t,
      started.run.id,
      (v) => v.current?.rounds.some((r) => r.state === "collecting") ?? false,
    );
    await Promise.allSettled([
      t.supervisor.control({
        runId: started.run.id,
        action: "pause",
        commandId: "campaign-s12-pause",
      }),
      t.supervisor.control({
        runId: started.run.id,
        action: "stop",
        commandId: "campaign-s12-stop",
      }),
    ]);
    for (let i = 0; i < 5; i++) await t.supervisor.tick();
    expect(runOf(t, started.run.id).desiredState).toBe("stopped");
    expect(runOf(t, started.run.id).state).toBe("stopped");
    await expect(
      t.supervisor.control({
        runId: started.run.id,
        action: "resume",
        commandId: "campaign-s12-resume",
      }),
    ).rejects.toThrow(/stopped/);
  });

  // Regression for D-02 (STATE-12, fixed 2026-10-19): CommandReceipt idempotency was check-then-run. A concurrent repeat of a command ID now joins the run in flight.
  test("the same publication command ID sent twice concurrently writes the folder once", async () => {
    const t = await setup();
    const runId = await promotedRun(t);
    const review = await t.supervisor.publicationReview(runId);
    await Promise.allSettled([
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-s12-pub",
      }),
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-s12-pub",
      }),
    ]);
    expect(t.loop.published).toHaveLength(1);
  });

  // Regression for D-02 (STATE-12, fixed 2026-10-19): publish() checked "already published" before its async write with no fence. Publication steps now run one at a time per run.
  test("two windows publishing the same checkpoint concurrently write it once; the other is refused as already published", async () => {
    const t = await setup();
    const runId = await promotedRun(t);
    const review = await t.supervisor.publicationReview(runId);
    const results = await Promise.allSettled([
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-s12-pub-a",
      }),
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-s12-pub-b",
      }),
    ]);
    expect(t.loop.published).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const cursor = t.store.get<PublicationCursor>(
      loopKinds.cursor,
      `${runId}:publication`,
    )!;
    expect(cursor.receipts).toHaveLength(1);
  });

  test("sequential repeat of the same checkpoint is refused before any write", async () => {
    const t = await setup();
    const runId = await promotedRun(t);
    const review = await t.supervisor.publicationReview(runId);
    await t.supervisor.publish({
      runId,
      digest: review.digest,
      commandId: "campaign-s12-seq-1",
    });
    await expect(
      t.supervisor.publish({
        runId,
        digest: review.digest,
        commandId: "campaign-s12-seq-2",
      }),
    ).rejects.toThrow(/already published/);
    // The first command ID replays its receipt without writing again.
    await t.supervisor.publish({
      runId,
      digest: review.digest,
      commandId: "campaign-s12-seq-1",
    });
    expect(t.loop.published).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LOOP-14: policy updates while work runs

describe("LOOP-14: policy changes during a run follow their actual confirmation rules", () => {
  test("automatic checks and lifting an exclusion need the dialog digest; narrowing and numeric allowance changes do not; checks are fixed after start", async () => {
    const t = await setup();
    implementing(t);
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, excludedProviders: ["claude"], checks: [check(1)] },
    });
    const runId = started.run.id;
    await driveLoop(t, runId, () =>
      t.driver.launches.some((l) => l.purpose === "implementation"),
    );
    const rev = () => t.supervisor.policy(runId).revision;
    // Widening without the native digest is refused and changes nothing.
    await expect(
      t.supervisor.updatePolicy({
        runId,
        expectedRevision: rev(),
        policy: { automaticChecks: true },
        commandId: "campaign-l14-auto",
      }),
    ).rejects.toThrow(/native confirmation/);
    await expect(
      t.supervisor.updatePolicy({
        runId,
        expectedRevision: rev(),
        policy: { excludedProviders: [] },
        digest: "window-made",
        commandId: "campaign-l14-lift",
      }),
    ).rejects.toThrow(/native confirmation/);
    expect(t.supervisor.policy(runId).automaticChecks).toBe(false);
    expect(t.supervisor.policy(runId).excludedProviders).toEqual(["claude"]);
    // The digest of the proposed authority (what the native dialog shows) is accepted.
    const proposed = { automaticChecks: true };
    const digest = t.supervisor.authorityReview(runId, proposed).digest;
    await t.supervisor.updatePolicy({
      runId,
      expectedRevision: rev(),
      policy: proposed,
      digest,
      commandId: "campaign-l14-auto-ok",
    });
    expect(t.supervisor.policy(runId)).toMatchObject({
      automaticChecks: true,
      authorizedDigest: digest,
    });
    // Narrowing (adding an exclusion) and numeric allowance changes need no digest.
    await t.supervisor.updatePolicy({
      runId,
      expectedRevision: rev(),
      policy: { excludedProviders: ["claude", "codex"] },
      commandId: "campaign-l14-narrow",
    });
    await t.supervisor.updatePolicy({
      runId,
      expectedRevision: rev(),
      policy: {
        allowances: {
          runMemberTurns: 500,
          rolling: { memberTurns: 100, windowHours: 1 },
        },
      },
      commandId: "campaign-l14-allowance",
    });
    expect(t.supervisor.policy(runId).allowances.runMemberTurns).toBe(500);
    // Protected check definitions cannot change after start, even narrowed.
    await expect(
      t.supervisor.updatePolicy({
        runId,
        expectedRevision: rev(),
        policy: { checks: [] },
        commandId: "campaign-l14-checks",
      }),
    ).rejects.toThrow(/fixed once it starts/);
    expect(t.supervisor.policy(runId).checks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LOOP-13 (supervisor boundary): the feature flag turned off while runs exist.
// Disable policy (D-01 fix): while the flag is off every started run that is
// meant to run is paused, nothing new is admitted or dispatched, Stop and
// Pause stay available, Resume needs the flag, and nothing resumes by itself
// when the flag is turned back on.

describe("LOOP-13: turning Recursive Looping off while a run is active or monitoring", () => {
  /** The supervisor's flag option, as the service wires it to experimental.recursiveLooping. */
  function flag(t: T, supervisor: LoopSupervisor = t.supervisor) {
    const state = { enabled: true };
    (
      supervisor as unknown as { options: { enabled?: () => boolean } }
    ).options.enabled = () => state.enabled;
    return state;
  }

  test("with the flag off, an active run is paused, its child work stops, and it stays paused when the flag returns", async () => {
    const t = await setup();
    implementing(t);
    const f = flag(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(
      t,
      started.run.id,
      (v) => (v.checkpoint?.sequence ?? 0) >= 1,
      300,
    );
    f.enabled = false;
    const paused = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "paused",
      20,
    );
    expect(paused.run.desiredState).toBe("paused");
    expect(paused.run.detail).toMatch(/Recursive Looping was turned off/);
    const launches = t.driver.launches.length;
    const iterations = runOf(t, started.run.id).iterationCount;
    await driveLoop(t, started.run.id, () => false, 100);
    expect(t.driver.launches.length).toBe(launches);
    expect(runOf(t, started.run.id).iterationCount).toBe(iterations);
    // No owned child goal is left running or planning.
    for (const id of t.supervisor
      .iterations(runOf(t, started.run.id))
      .flatMap((i) => i.childExecutionGoalIds))
      expect(
        t.orchestrator.repo.require<{ state: string }>("goal", id).state,
      ).not.toMatch(/^(running|planning|reviewing)$/);
    // Inspection still works with the flag off.
    expect(t.supervisor.view(started.run.id).run.id).toBe(started.run.id);
    // Turning the flag back on resumes nothing by itself...
    f.enabled = true;
    await driveLoop(t, started.run.id, () => false, 20);
    expect(runOf(t, started.run.id).state).toBe("paused");
    expect(t.driver.launches.length).toBe(launches);
    // ...and the owner's Resume continues the run to completion.
    await t.supervisor.control({
      runId: started.run.id,
      action: "resume",
      commandId: "campaign-l13-resume-on",
    });
    const view = await driveLoop(t, started.run.id, resting, 400);
    expect(view.run.state).toBe("completed");
    expect(view.checkpoint!.sequence).toBe(2);
  });

  test("with the flag off, a monitoring Endless run is paused and its due wakeup never fires", async () => {
    const t = await setup();
    const f = flag(t);
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy,
    });
    await driveLoop(t, started.run.id, (v) => v.run.state === "monitoring");
    f.enabled = false;
    const launches = t.driver.launches.length;
    const iterations = runOf(t, started.run.id).iterationCount;
    t.advance(3_600_000);
    await driveLoop(t, started.run.id, () => false, 50);
    expect(runOf(t, started.run.id).state).toBe("paused");
    expect(pendingWakeups(t, started.run.id)).toHaveLength(0);
    expect(t.driver.launches.length).toBe(launches);
    expect(runOf(t, started.run.id).iterationCount).toBe(iterations);
  });

  test("the flag turned off while a due monitoring run reads its inputs leaves it paused, not active", async () => {
    const t = await setup();
    const f = flag(t);
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy,
    });
    await driveLoop(t, started.run.id, (v) => v.run.state === "monitoring");
    t.advance(3_600_000);
    // Hold the tick inside its project read, as a slow folder read does.
    let release!: () => void;
    let reading!: () => void;
    const entered = new Promise<void>((resolve) => (reading = resolve));
    t.loop.projectFingerprint = () =>
      new Promise<string>((resolve) => {
        reading();
        release = () => resolve("folder-1");
      });
    const tick = t.supervisor.tick();
    await entered;
    f.enabled = false;
    await t.supervisor.holdWhileDisabled();
    expect(runOf(t, started.run.id).state).toBe("paused");
    release();
    await tick;
    expect(runOf(t, started.run.id).state).toBe("paused");
    expect(runOf(t, started.run.id).desiredState).toBe("paused");
  });

  test("with the flag off, Pause and Stop are accepted and Resume is refused", async () => {
    const t = await setup();
    const f = flag(t);
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy,
    });
    await driveLoop(t, started.run.id, (v) => v.run.state === "monitoring");
    f.enabled = false;
    await t.supervisor.control({
      runId: started.run.id,
      action: "pause",
      commandId: "campaign-l13-pause",
    });
    expect(runOf(t, started.run.id).desiredState).toBe("paused");
    await expect(
      t.supervisor.control({
        runId: started.run.id,
        action: "resume",
        commandId: "campaign-l13-resume",
      }),
    ).rejects.toThrow(/experimental and off/);
    expect(runOf(t, started.run.id).desiredState).toBe("paused");
    await t.supervisor.control({
      runId: started.run.id,
      action: "stop",
      commandId: "campaign-l13-stop",
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "stopped",
      20,
    );
    expect(view.run.desiredState).toBe("stopped");
    expect(view.run.state).toBe("stopped");
  });

  test("Stop remains available for existing work while the flag is off, and fences further dispatch", async () => {
    const t = await setup();
    implementing(t);
    const f = flag(t);
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(t, started.run.id, () =>
      t.driver.launches.some((l) => l.purpose === "implementation"),
    );
    f.enabled = false;
    await t.supervisor.control({
      runId: started.run.id,
      action: "stop",
      commandId: "campaign-l13-stop-off",
    });
    const launches = t.driver.launches.length;
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "stopped",
      20,
    );
    expect(view.run.state).toBe("stopped");
    expect(t.driver.launches.length).toBe(launches);
  });

  test("project-wide Stop everything stops the loop run while the flag is off, and the loop starts no new work", async () => {
    const t = await setup();
    implementing(t);
    const f = flag(t);
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(t, started.run.id, () =>
      t.driver.launches.some((l) => l.purpose === "implementation"),
    );
    f.enabled = false;
    const child = t.supervisor.iterations(runOf(t, started.run.id))[0]
      .childExecutionGoalIds[0];
    await t.orchestrator.controlCommand({
      projectId: "p",
      goalId: null,
      action: "stop",
      commandId: "campaign-l13-stop-all",
    });
    expect(
      t.orchestrator.repo.require<{ state: string }>("goal", child).state,
    ).toBe("stopped");
    expect(runOf(t, started.run.id).desiredState).toBe("stopped");
    t.driver.reply = reply;
    const launches = t.driver.launches.length;
    const iterations = runOf(t, started.run.id).iterationCount;
    const view = await driveLoop(t, started.run.id, resting, 100);
    expect(view.run.state).toBe("stopped");
    expect(t.driver.launches.length).toBe(launches);
    expect(runOf(t, started.run.id).iterationCount).toBe(iterations);
  });

  test("negative control: with the flag on, project-wide Stop everything stops the loop run", async () => {
    const t = await setup();
    implementing(t);
    flag(t);
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(t, started.run.id, () =>
      t.driver.launches.some((l) => l.purpose === "implementation"),
    );
    await t.orchestrator.controlCommand({
      projectId: "p",
      goalId: null,
      action: "stop",
      commandId: "campaign-l13-stop-all-on",
    });
    t.driver.reply = reply;
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "stopped",
      100,
    );
    expect(view.run.desiredState).toBe("stopped");
    expect(view.run.state).toBe("stopped");
  });

  test("restart with the flag off does not auto-resume a run whose policy selects it", async () => {
    const t = await setup();
    const f = flag(t);
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: { ...policy, recovery: { resumeAfterRestart: true } },
    });
    await driveLoop(t, started.run.id, (v) => v.run.state === "monitoring");
    t.supervisor.suspend();
    f.enabled = false;
    const reopened = t.reopenSupervisor();
    const g = flag(t, reopened);
    g.enabled = false;
    await reopened.recover();
    expect(reopened.run(started.run.id).state).toBe("suspended");
    const launches = t.driver.launches.length;
    t.advance(3_600_000);
    await driveLoop(t, started.run.id, () => false, 50, reopened);
    expect(reopened.run(started.run.id).state).toBe("paused");
    expect(reopened.run(started.run.id).desiredState).toBe("paused");
    expect(t.driver.launches.length).toBe(launches);
  });
});

// ---------------------------------------------------------------------------
// §6.1 timeline paging and OPS-06 (bounded): long histories page without loss

describe("§6.1 / OPS-06: the loop timeline pages 100+ iterations without missed or duplicate items", () => {
  test("limit 1/20/100/101, invalid cursor, and insertion between pages", async () => {
    const t = await setup();
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy,
    });
    const runId = started.run.id;
    await driveLoop(t, runId, (v) => v.run.state === "monitoring");
    // Each due wakeup admits one no-work iteration: build 105 of them.
    while (runOf(t, runId).iterationCount < 105) {
      const before = runOf(t, runId).iterationCount;
      t.advance(runOf(t, runId).backoffSeconds * 1000 + 1);
      await driveLoop(
        t,
        runId,
        (v) => v.run.state === "monitoring" && v.run.iterationCount > before,
        50,
      );
    }
    const all = t.supervisor.iterations(runOf(t, runId)).map((i) => i.id);
    expect(all).toHaveLength(105);
    const pageAll = (limit: number) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = t.supervisor.timeline(runId, cursor, limit);
        expect(page.items.length).toBeLessThanOrEqual(limit);
        ids.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 500);
      return { ids, pages };
    };
    for (const limit of [1, 20, 100]) {
      const { ids, pages } = pageAll(limit);
      expect(new Set(ids).size, `limit ${limit}`).toBe(105);
      expect(ids.length, `limit ${limit}`).toBe(105);
      expect([...ids].sort()).toEqual([...all].sort());
      expect(pages).toBeGreaterThanOrEqual(Math.ceil(105 / limit));
    }
    // Newest first by number.
    const numbers = t.supervisor
      .timeline(runId, null, 20)
      .items.map((i) => i.number);
    expect(numbers[0]).toBe(105);
    // The command schema caps the limit at 100; the supervisor itself returns
    // whatever the store allows (recorded fact).
    expect(t.supervisor.timeline(runId, null, 101).items).toHaveLength(101);
    expect(() => t.supervisor.timeline(runId, null, 501)).toThrow();
    expect(() => t.supervisor.timeline(runId, "not-a-cursor", 20)).toThrow();
    // Insertion between page requests: earlier items are neither repeated nor skipped.
    const first = t.supervisor.timeline(runId, null, 20);
    for (let i = 0; i < 3; i++) {
      const before = runOf(t, runId).iterationCount;
      t.advance(runOf(t, runId).backoffSeconds * 1000 + 1);
      await driveLoop(
        t,
        runId,
        (v) => v.run.state === "monitoring" && v.run.iterationCount > before,
        50,
      );
    }
    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = t.supervisor.timeline(runId, cursor, 20);
      rest.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    }
    const seen = [...first.items.map((i) => i.id), ...rest];
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...all].sort());
  });
});

// ---------------------------------------------------------------------------
// LOOP-01 / LOOP-02 / LOOP-04 supplements

describe("LOOP-01 / LOOP-02 / LOOP-04 supplements", () => {
  test("LOOP-01: create launches nothing; a refused or fabricated start launches nothing and captures nothing", async () => {
    const t = await setup();
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy,
      commandId: "campaign-l01-create",
    });
    for (let i = 0; i < 5; i++) {
      await t.orchestrator.tick();
      await t.supervisor.tick();
    }
    await expect(
      t.supervisor.start({
        runId: created.run.id,
        digest: "made-by-the-window",
        commandId: "campaign-l01-forged",
      }),
    ).rejects.toThrow(/changed after you reviewed it/);
    // A digest reviewed before the goals changed is stale.
    const stale = t.supervisor.authorityReview(created.run.id).digest;
    await t.supervisor.updateGoals({
      runId: created.run.id,
      add: [{ text: "Add a farewell" }],
      commandId: "campaign-l01-goal",
    });
    await expect(
      t.supervisor.start({
        runId: created.run.id,
        digest: stale,
        commandId: "campaign-l01-stale",
      }),
    ).rejects.toThrow(/changed after you reviewed it/);
    for (let i = 0; i < 5; i++) {
      await t.orchestrator.tick();
      await t.supervisor.tick();
    }
    expect(t.driver.launches).toHaveLength(0);
    expect([
      ...t.store.iterate<LoopCheckpoint>(loopKinds.checkpoint),
    ]).toHaveLength(0);
    expect(runOf(t, created.run.id)).toMatchObject({
      started: false,
      state: "paused",
    });
  });

  test("LOOP-02: coordinators claiming success cannot promote a candidate whose protected check fails; the passing candidate promotes", async () => {
    const t = await setup();
    implementing(t);
    let passing = false;
    t.driver.checkResult = () => (passing ? "passed" : "failed");
    t.loop.checkResult = () => "passed";
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      goals: [
        {
          text: "Add a greeting",
          criteria: [
            {
              text: "The unit check passes",
              verification: { kind: "check", checkId: "check-1" },
            },
          ],
        },
      ],
      policy: {
        ...policy,
        checks: [check(1)],
        automaticChecks: true,
        iteration: { maxRepairRounds: 1 },
      },
      commandId: "campaign-l02-create",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "campaign-l02-start",
    });
    const view = await driveLoop(
      t,
      created.run.id,
      (v) => resting(v) || v.iterations.some((i) => i.state === "rejected"),
      400,
    );
    // The coordinators said "met" throughout (implementing()), yet nothing promoted.
    expect(view.run.state).not.toBe("completed");
    expect(
      [...t.store.iterate(loopKinds.promotion)].filter(
        (p: any) => p.runId === created.run.id,
      ),
    ).toHaveLength(0);
    expect(view.checkpoint!.sequence).toBe(0);
    expect(t.driver.evidence.length).toBeGreaterThan(0);
    expect(t.driver.evidence.every((e) => e.result === "failed")).toBe(true);
    // Negative control: the same goal with a passing check promotes and completes.
    passing = true;
    const view2 = await driveLoop(t, created.run.id, resting, 600);
    if (view2.run.state === "waiting")
      await t.supervisor.updateGoals({
        runId: created.run.id,
        edit: [{ goalId: view2.goals[0].id, clearBlocker: true }],
        commandId: "campaign-l02-unblock",
      });
    const final = await driveLoop(
      t,
      created.run.id,
      (v) => v.run.state === "completed",
      600,
    );
    expect(final.run.state).toBe("completed");
    const promotion = [
      ...t.store.iterate<{
        runId: string;
        candidateId: string;
        checkEvidence: Array<{ verificationId: string }>;
      }>(loopKinds.promotion),
    ].find((p) => p.runId === created.run.id)!;
    // The promotion cites passing evidence for the promoted candidate itself.
    const cited = t.driver.evidence.filter((e) =>
      promotion.checkEvidence.some(
        (c) => c.verificationId === e.verificationId,
      ),
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((e) => e.result === "passed")).toBe(true);
    expect(cited.every((e) => e.candidateId === promotion.candidateId)).toBe(
      true,
    );
  });

  test("LOOP-04: removing every goal is cancellation, never accomplishment", async () => {
    const t = await setup();
    t.script.met = () => false;
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(t, started.run.id, () =>
      t.driver.launches.some((l) => l.purpose === "implementation"),
    );
    await t.supervisor.updateGoals({
      runId: started.run.id,
      remove: started.goals.map((g) => g.id),
      commandId: "campaign-l04-remove",
    });
    t.driver.reply = reply;
    const view = await driveLoop(t, started.run.id, resting, 300);
    expect(view.goals.every((g) => g.status === "cancelled_by_user")).toBe(
      true,
    );
    expect(view.goals.some((g) => g.satisfiedAtCheckpointId)).toBe(false);
    // Recorded outcome for the no-required-goal state.
    expect(view.run.state).not.toBe("completed");
    // The no-required-goal state is explicit: a user-input wait, not completion.
    expect(view.run.state).toBe("waiting");
    expect(view.run.waitReason).toMatchObject({
      kind: "user-input",
      detail: expect.stringMatching(/Every goal was removed/),
    });
    expect(view.run.completedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OPS-06 (accelerated, bounded): scripted boundaries on a fake clock. The
// default suite runs 200 boundaries. Per-boundary cost grows with retained
// history, so the 1,000-boundary soak (about 150 s on an Apple M5, over 600 s
// on a hosted Intel Mac runner on 19 October 2026) is opt-in:
// TOPSL_LOOP_SOAK=1 npm test -- tests/campaign-loops-state.test.ts -t OPS-06

const soakBoundaries = process.env.TOPSL_LOOP_SOAK ? 1000 : 200;

describe("OPS-06 (accelerated): scripted boundaries with promotions, rejections and no-work", () => {
  test("no hidden iteration cap, one promotion per accepted iteration, bounded scheduling records, complete paging", async () => {
    const t = await setup();
    const number = (p: { expected: unknown }) =>
      Number(
        /:iteration:(\d+)$/.exec(
          String((p.expected as { iterationId: string | null }).iterationId),
        )?.[1] ?? 0,
      );
    // Every 10th boundary offers a distinct improvement; every 30th is rejected.
    t.script.opportunities = (p) =>
      number(p) % 10 === 0 ? [improvement(`Step ${number(p)}`)] : [];
    t.script.met = (_id, p) => p.stage === "evaluate" && number(p) % 30 !== 0;
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: { ...policy, iteration: { maxRepairRounds: 0 } },
    });
    const runId = started.run.id;
    const samples: Array<{
      iterations: number;
      elapsedMs: number;
      heapMb: number;
      events: number;
    }> = [];
    const began = Date.now();
    let nextSample = 100;
    for (let step = 0; step < 60_000; step++) {
      const run = runOf(t, runId);
      if (run.iterationCount >= soakBoundaries && run.state === "monitoring")
        break;
      if (run.state === "monitoring") t.advance(run.backoffSeconds * 1000 + 1);
      await t.orchestrator.tick();
      await t.supervisor.tick();
      t.driver.settle();
      if (run.iterationCount >= nextSample) {
        samples.push({
          iterations: run.iterationCount,
          elapsedMs: Date.now() - began,
          heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
          events: events(t, runId).length,
        });
        nextSample += 100;
      }
    }
    const run = runOf(t, runId);
    expect(run.iterationCount).toBeGreaterThanOrEqual(soakBoundaries);
    expect(run.state).toBe("monitoring");
    expect(run.completedAt).toBeNull();
    const iterations = t.supervisor.iterations(run);
    expect(iterations).toHaveLength(run.iterationCount);
    const promoted = iterations.filter((i) => i.state === "promoted");
    const rejected = iterations.filter((i) => i.state === "rejected");
    expect(promoted.length).toBeGreaterThanOrEqual(soakBoundaries * 0.06);
    expect(rejected.length).toBeGreaterThanOrEqual(soakBoundaries * 0.03);
    expect(iterations.filter((i) => !terminal.has(i.state))).toEqual([]);
    const promotions = [
      ...t.store.iterate<{ runId: string; iterationId: string }>(
        loopKinds.promotion,
      ),
    ].filter((p) => p.runId === runId);
    expect(promotions).toHaveLength(promoted.length);
    expect(new Set(promotions.map((p) => p.iterationId)).size).toBe(
      promoted.length,
    );
    const checkpoints = [
      ...t.store.iterate<LoopCheckpoint>(loopKinds.checkpoint),
    ].filter((c) => c.runId === runId);
    expect(checkpoints).toHaveLength(promoted.length + 1);
    expect(t.supervisor.checkpoint(run.acceptedCheckpointId!).sequence).toBe(
      promoted.length,
    );
    // Scheduling records stay bounded: one active index, at most one pending wakeup and intent.
    expect(
      [...t.store.iterate<{ runId: string }>(loopKinds.active)].filter(
        (a) => a.runId === runId,
      ),
    ).toHaveLength(1);
    expect(pendingWakeups(t, runId).length).toBeLessThanOrEqual(1);
    expect(pendingIntents(t, runId).length).toBeLessThanOrEqual(1);
    // Accounting agrees with the immutable launches after every boundary.
    expect(usageOf(t, runId).memberTurns).toBe(launchedTurns(t, runId));
    // Owned copies were reclaimed; the head and checkpoint 0 were kept.
    expect(t.loop.reclaimed).not.toContain("checkpoint-c0");
    expect(t.loop.reclaimed).not.toContain(
      t.supervisor.checkpoint(run.acceptedCheckpointId!).candidateId,
    );
    // Paging the whole timeline loses and repeats nothing.
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = t.supervisor.timeline(runId, cursor, 100);
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(run.iterationCount);
    const eventCount = events(t, runId).length;
    // Reported, not asserted as an SLA: growth by retained data.
    console.log(
      `CAMPAIGN-OPS06 ${JSON.stringify({
        iterations: run.iterationCount,
        promoted: promoted.length,
        rejected: rejected.length,
        launches: t.driver.launches.length,
        events: eventCount,
        eventsPerIteration: +(eventCount / run.iterationCount).toFixed(2),
        elapsedMs: Date.now() - began,
        samples,
      })}`,
    );
    expect(eventCount / run.iterationCount).toBeLessThan(30);
    // An explicit budget for this accelerated soak only: about 150 s on the
    // campaign host, growing with retained history (see the reported samples).
  }, 600_000);
});
const terminal = new Set(["promoted", "rejected", "no-work", "cancelled"]);

// ---------------------------------------------------------------------------
// 2026-10-29: in zod 4, `.partial()` fills defaults, so a `loop-policy-update`
// that sent one field reset every other one. On a started run the reset
// `checks: []` was refused as a protocol change, and an empty
// `excludedProviders` counted as lifting an exclusion.

describe("loop-policy-update changes only the fields it sends", () => {
  const settings = (p: ReturnType<T["supervisor"]["policy"]>) => {
    const { revision: _r, updatedAt: _u, ...rest } = p;
    return rest;
  };
  const update = (
    runId: string,
    expectedRevision: number,
    patch: Record<string, unknown>,
  ) => {
    const command = commandSchema.parse({
      type: "loop-policy-update",
      runId,
      expectedRevision,
      policy: patch,
      commandId: `partial-${Math.random()}`,
    });
    if (command.type !== "loop-policy-update") throw new Error("unexpected");
    return command;
  };

  test("a one-field command keeps the run's other settings, including grouped fields", async () => {
    const t = await setup();
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy: {
        scheduling: { reserveForDirectWork: 3 },
        excludedProviders: ["claude"],
        checks: [check(1)],
        automaticChecks: true,
        iteration: { maxTurns: 150, maxRepairRounds: 5 },
        allowances: {
          runMemberTurns: 40,
          rolling: { memberTurns: 10, windowHours: 2 },
        },
      },
    });
    const runId = started.run.id;
    const before = t.supervisor.policy(runId);

    const one = update(runId, before.revision, { opportunityThreshold: 0.5 });
    expect(one.policy).toEqual({ opportunityThreshold: 0.5 });
    await t.supervisor.updatePolicy(one);
    const afterOne = t.supervisor.policy(runId);
    expect(afterOne.revision).toBe(before.revision + 1);
    expect(settings(afterOne)).toEqual({
      ...settings(before),
      opportunityThreshold: 0.5,
    });

    // Inside a group, the fields sent replace only those fields.
    const grouped = update(runId, afterOne.revision, {
      iteration: { maxTurns: 50 },
      allowances: { runMemberTurns: 60 },
    });
    expect(grouped.policy).toEqual({
      iteration: { maxTurns: 50 },
      allowances: { runMemberTurns: 60 },
    });
    await t.supervisor.updatePolicy(grouped);
    const afterGrouped = t.supervisor.policy(runId);
    expect(settings(afterGrouped)).toEqual({
      ...settings(afterOne),
      iteration: { ...afterOne.iteration, maxTurns: 50 },
      allowances: { ...afterOne.allowances, runMemberTurns: 60 },
    });
    expect(afterGrouped).toMatchObject({
      automaticChecks: true,
      excludedProviders: ["claude"],
      scheduling: { reserveForDirectWork: 3 },
      iteration: { maxRepairRounds: 5 },
      allowances: { rolling: { memberTurns: 10, windowHours: 2 } },
      authorizedDigest: before.authorizedDigest,
    });
    expect(afterGrouped.checks).toHaveLength(1);
  });

  test("the monitoring delay rule applies to the merged settings", async () => {
    const t = await setup();
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy,
    });
    const runId = started.run.id;
    const revision = t.supervisor.policy(runId).revision;
    // One side of the rule parses alone; the stored maximum is 21,600 s.
    const command = update(runId, revision, {
      monitoring: { initialSeconds: 30000 },
    });
    await expect(t.supervisor.updatePolicy(command)).rejects.toThrow(
      "cannot be longer than the maximum delay",
    );
    await t.supervisor.updatePolicy(
      update(runId, revision, { monitoring: { initialSeconds: 600 } }),
    );
    expect(t.supervisor.policy(runId).monitoring).toEqual({
      initialSeconds: 600,
      maxSeconds: 21600,
      factor: 2,
    });
  });
});
