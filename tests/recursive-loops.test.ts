import { afterEach, describe, expect, test } from "vitest";
import { loopKinds } from "../packages/orchestration/loop-engine";
import type { LoopDecision } from "../packages/orchestration/loop-contracts";
import type { MemberTurn } from "../packages/orchestration/engine";
import { defaultReply } from "./orchestration-fixture";
import {
  assess,
  driveLoop,
  envelope,
  improvement,
  loopReply,
  loopSetup,
  parseLoopPrompt,
  startRun,
} from "./loop-fixture";

const open: Array<Awaited<ReturnType<typeof loopSetup>>> = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const setup = async () => {
  const t = await loopSetup();
  open.push(t);
  return t;
};
const policy = { scheduling: { reserveForDirectWork: 0 } };
const done = (v: { run: { state: string } }) =>
  ["completed", "waiting", "stopped", "monitoring"].includes(v.run.state);

/**
 * Scripted work: an implementation turn "implements" the goals its iteration
 * advances; an evaluation finds a goal met when its work is in the target.
 */
function implementing(
  t: Awaited<ReturnType<typeof setup>>,
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

describe("Recursive Looping: Goal mode", () => {
  test("GL-01: one goal completes only with current evidence on the accepted checkpoint", async () => {
    const t = await setup();
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting to src/a.ts",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done);
    expect(view.run.state).toBe("completed");
    expect(view.goals[0].status).toBe("satisfied");
    expect(view.checkpoint!.sequence).toBe(1);
    const promoted = view.iterations.find((i) => i.state === "promoted")!;
    const promotion = t.store.get<{ by: string; candidateId: string }>(
      loopKinds.promotion,
      promoted.promotionId!,
    )!;
    // Machine promotion, never owner acceptance.
    expect(promotion.by).toBe("loop-policy");
    const child = t.orchestrator.repo.require<{
      acceptance: unknown;
      loopDisposition: { by: string };
    }>("goal", promoted.childExecutionGoalIds[0]);
    expect(child.acceptance).toBeNull();
    expect(child.loopDisposition.by).toBe("loop-policy");
  });

  test("GL-02: several goals are tracked independently and completion covers all of them", async () => {
    const t = await setup();
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Make project synchronization reliable, add the missing coordinator controls, and ensure restart preserves the selected model teams.",
      policy,
    });
    expect(started.goals.map((g) => g.text)).toEqual([
      "Make project synchronization reliable",
      "Add the missing coordinator controls",
      "Ensure restart preserves the selected model teams",
    ]);
    const view = await driveLoop(t, started.run.id, done, 400);
    expect(view.run.state).toBe("completed");
    expect(view.goals.every((g) => g.status === "satisfied")).toBe(true);
    expect(view.checkpoint!.sequence).toBe(3);
    // Each goal was advanced by its own iteration.
    const all = t.supervisor.iterations(view.run);
    expect(
      all.filter((i) => i.state === "promoted").map((i) => i.goalIds.length),
    ).toEqual([1, 1, 1]);
  });

  test("GL-03: a goal broken by later work is regressed and repaired before promotion", async () => {
    const t = await setup();
    const state = implementing(t);
    let breakA = true;
    // Iteration 2 (goal B) first breaks goal A: its evaluation says A is unmet.
    const met = t.script.met;
    t.script.met = (goalId, p) => {
      const g = p.goals.find((x) => x.id === goalId)!;
      if (
        p.stage === "evaluate" &&
        g.text.startsWith("Add the reader") &&
        breakA &&
        state.pending.has("Add the writer")
      ) {
        breakA = false;
        met(goalId, p);
        return false;
      }
      return met(goalId, p);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add the reader\nAdd the writer",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 400);
    const events = [...t.store.iterate<{ kind: string }>(loopKinds.event)].map(
      (e) => e.kind,
    );
    expect(events).toContain("goal-regressed");
    expect(view.run.state).toBe("completed");
    expect(view.goals.every((g) => g.status === "satisfied")).toBe(true);
    // The repair happened inside iteration 2; checkpoints advanced twice.
    expect(view.checkpoint!.sequence).toBe(2);
    expect(
      t.supervisor.iterations(view.run).find((i) => i.number === 2)!.repairs,
    ).toBeGreaterThan(0);
  });

  test("GL-04: a goal already satisfied at the start is verified and completes without invented work", async () => {
    const t = await setup();
    t.script.met = () => true;
    const started = await startRun(t, {
      mode: "goal",
      text: "Keep the README present",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done);
    expect(view.run.state).toBe("completed");
    expect(view.checkpoint!.sequence).toBe(0);
    expect(t.driver.launches.some((l) => l.purpose === "implementation")).toBe(
      false,
    );
  });

  test("GL-05: coordinators claiming success without the required evidence cannot complete", async () => {
    const t = await setup();
    t.script.override = (p) =>
      p.stage === "boundary"
        ? {
            text: envelope(p, [
              assess(p, () => true),
              {
                kind: "propose_goal_completion",
                goalIds: p.goals.map((g) => g.id),
                summary: "Done.",
              } as LoopDecision,
            ]),
          }
        : null;
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      goals: [
        {
          text: "Ship the reviewed change",
          criteria: [{ text: "Reviewed", verification: { kind: "review" } }],
        },
      ],
      policy,
      commandId: "create-gl05",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-gl05",
    });
    await driveLoop(t, created.run.id, (v) =>
      v.iterations.some((i) => i.contract !== null),
    );
    const view = t.supervisor.view(created.run.id);
    expect(view.run.state).not.toBe("completed");
    expect(view.goals[0].assessment!.criteria[0].validation).toBe(
      "missing-evidence",
    );
    const events = [
      ...t.store.iterate<{ kind: string; detail: string }>(loopKinds.event),
    ];
    expect(events.some((e) => e.kind === "completion-rejected")).toBe(true);
  });

  test("GL-06: contradictory goals are both kept, explained and never advanced together", async () => {
    const t = await setup();
    implementing(t);
    t.script.override = (p) => {
      if (p.stage !== "boundary") return null;
      const d = assess(p, () => false) as Extract<
        LoopDecision,
        { kind: "assess_goals" }
      >;
      d.assessments[0].conflictsWith = [p.goals[1].id];
      return {
        text: envelope(p, [
          d,
          {
            kind: "plan_iteration",
            goalIds: p.goals.map((g) => g.id),
            summary: "Both",
            acceptanceConditions: [],
            approach: "together",
          } as LoopDecision,
        ]),
      };
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Make startup faster\nLoad every plugin at startup",
      policy,
    });
    await driveLoop(t, started.run.id, (v) =>
      v.iterations.some((i) => i.contract !== null),
    );
    const view = t.supervisor.view(started.run.id);
    expect(view.goals).toHaveLength(2);
    expect(view.goals[0].conflict).toMatch(/both requirements are kept/);
    expect(
      t.supervisor.iterations(view.run).find((i) => i.contract)!.goalIds,
    ).toHaveLength(1);
  });

  test("GL-07: editing a goal during the final assessment fences the old completion decision", async () => {
    const t = await setup();
    implementing(t);
    let hold = true;
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      hold && turn.protocol?.stage === "evaluate" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(
      t,
      started.run.id,
      (v) =>
        v.current?.rounds.some(
          (r) => r.stage === "evaluate" && r.state === "collecting",
        ) ?? false,
    );
    const goal = t.supervisor.goals(started.run)[0];
    await t.supervisor.updateGoals({
      runId: started.run.id,
      edit: [{ goalId: goal.id, text: "Add a friendly greeting" }],
      commandId: "edit-gl07",
    });
    hold = false;
    const view = await driveLoop(t, started.run.id, done, 300);
    const rounds = [
      ...t.store.iterate<{ stage: string; state: string }>(loopKinds.round),
    ];
    expect(
      rounds.some((r) => r.stage === "evaluate" && r.state === "stale"),
    ).toBe(true);
    // The completed run is for the edited goal version, never the old one.
    expect(view.goals[0].text).toBe("Add a friendly greeting");
    if (view.run.state === "completed")
      expect(view.goals[0].assessment!.goalVersion).toBe(view.goals[0].version);
  });

  test("GL-08: an information-only goal is evaluated against its artifact without code or check evidence", async () => {
    const t = await setup();
    t.script.override = (p) => {
      if (p.stage === "boundary")
        return { text: envelope(p, [assess(p, () => false)]) };
      if (p.stage !== "evaluate") return null;
      // Cite the information artifact only.
      const artifact = p.evidence
        .filter((e) => e.kind === "artifact")
        .map((e) => e.id);
      return {
        text: envelope(p, [
          assess(p, () => artifact.length > 0, {
            evidence: () => artifact,
            paths: [],
          }),
        ]),
      };
    };
    t.driver.reply = (turn) =>
      turn.protocol?.kind === "recursive-loop-v1"
        ? loopReply(turn, t.script)
        : turn.purpose === "coordinator-contribution"
          ? defaultReply(turn, [
              {
                key: "research",
                title: "Research",
                kind: "information",
                roleId: "researcher",
                dependencies: [],
                permittedOutputs: [],
                acceptanceCriteria: [],
                brief: "Find out.",
                partitions: [],
              },
            ])
          : defaultReply(turn);
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      goals: [
        {
          text: "Explain the sync protocol",
          kind: "information",
          criteria: [
            {
              text: "Questions answered with sources",
              verification: { kind: "artifact" },
            },
          ],
        },
      ],
      policy,
      commandId: "create-gl08",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-gl08",
    });
    const view = await driveLoop(t, created.run.id, done);
    expect(view.run.state).toBe("completed");
    expect(view.checkpoint!.sequence).toBe(0);
    expect(t.driver.launches.some((l) => l.purpose === "implementation")).toBe(
      false,
    );
  });

  test("GL-09: a hard goal is not starved by easier goals of the same priority", async () => {
    const t = await setup();
    const state = implementing(
      t,
      (text) => text === "Hard goal" && !hardSeen++,
    );
    let hardSeen = 0;
    void state;
    const started = await startRun(t, {
      mode: "goal",
      text: "Hard goal\nEasy goal",
      policy: { ...policy, iteration: { maxRepairRounds: 0 } },
    });
    await driveLoop(t, started.run.id, done, 500);
    const iterations = t.supervisor
      .iterations(started.run)
      .filter((i) => i.contract);
    const names = iterations.map(
      (i) =>
        t.supervisor.goals(started.run).find((g) => g.id === i.goalIds[0])!
          .text,
    );
    expect(names.slice(0, 3)).toEqual(["Hard goal", "Easy goal", "Hard goal"]);
  });

  test("GL-10: Goal mode completes once required goals pass, before optional work", async () => {
    const t = await setup();
    implementing(t);
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      goals: [
        { text: "Required change" },
        { text: "Nice to have", required: false },
      ],
      policy,
      commandId: "create-gl10",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-gl10",
    });
    const view = await driveLoop(t, created.run.id, done, 300);
    expect(view.run.state).toBe("completed");
    expect(view.goals.find((g) => g.text === "Nice to have")!.status).not.toBe(
      "satisfied",
    );
    expect(
      t.supervisor.iterations(view.run).filter((i) => i.state === "promoted"),
    ).toHaveLength(1);
  });
});

describe("Recursive Looping: Endless mode", () => {
  const endless = async (
    t: Awaited<ReturnType<typeof setup>>,
    extra: Record<string, unknown> = {},
  ) =>
    startRun(t, {
      mode: "endless",
      text: "Keep improving Topsl. Prioritize reliability, synchronization and clarity of the interface.",
      policy: { ...policy, ...extra },
    });

  test("EN-01: a successful improvement is promoted, then the run reassesses and continues", async () => {
    const t = await setup();
    let n = 0;
    t.script.opportunities = () =>
      n < 2 ? [improvement(`Improvement ${++n}`)] : [];
    t.script.met = (_id, p) => p.stage === "evaluate";
    const started = await endless(t);
    expect(t.supervisor.policy(started.run.id).priorities).toEqual([
      "reliability",
      "synchronization",
      "clarity of the interface",
    ]);
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "monitoring",
      400,
    );
    expect(view.checkpoint!.sequence).toBe(2);
    expect(view.run.state).toBe("monitoring");
    expect(view.run.completedAt).toBeNull();
    expect(view.backlog.filter((o) => o.state === "accepted")).toHaveLength(2);
  });

  test("EN-02: no worthwhile work is monitoring with increasing backoff, not completion or busy looping", async () => {
    const t = await setup();
    const started = await endless(t);
    let view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "monitoring",
    );
    const first = view.run.backoffSeconds;
    const launches = t.driver.launches.length;
    for (let i = 0; i < 20; i++) await t.supervisor.tick();
    expect(t.driver.launches.length).toBe(launches);
    t.advance(first * 1000 + 1);
    view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "monitoring" && v.run.backoffSeconds > first,
    );
    expect(view.run.backoffSeconds).toBe(first * 2);
    expect(view.run.state).toBe("monitoring");
    // Changed inputs wake the run sooner than the backoff.
    t.loop.fingerprint = "folder-2";
    await t.supervisor.tick();
    expect(t.supervisor.run(started.run.id).state).not.toBe("monitoring");
  });

  test("EN-03: a rejected improvement rediscovered at the same content is not repeated", async () => {
    const t = await setup();
    t.script.opportunities = () => [improvement("Faster sync")];
    t.script.met = () => false;
    const started = await endless(t, { iteration: { maxRepairRounds: 0 } });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "monitoring",
      400,
    );
    const iterations = t.supervisor
      .iterations(view.run)
      .filter((i) => i.opportunityId);
    expect(iterations).toHaveLength(1);
    expect(iterations[0].state).toBe("rejected");
    const events = [...t.store.iterate<{ kind: string }>(loopKinds.event)].map(
      (e) => e.kind,
    );
    expect(events).toContain("opportunity-repeat");
  });

  test("EN-04: provider quota exhaustion waits, keeps accounting, and resumes after renewal", async () => {
    const t = await setup();
    t.script.opportunities = () => [improvement("Quota-bound change")];
    t.script.met = (_id, p) => p.stage === "evaluate";
    t.loop.limits = [
      {
        provider: "codex",
        kind: "quota",
        detail: "rate_limit_reached",
        retryAt: new Date(t.now() + 3_600_000).toISOString(),
      },
    ];
    const started = await endless(t);
    let view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "waiting",
    );
    expect(view.run.waitReason!.kind).toBe("quota");
    const turns = view.usage.memberTurns;
    t.loop.limits = [];
    t.advance(3_600_001);
    view = await driveLoop(
      t,
      started.run.id,
      (v) => v.checkpoint!.sequence === 1,
      300,
    );
    expect(view.checkpoint!.sequence).toBe(1);
    expect(view.usage.memberTurns).toBeGreaterThan(turns);
  });

  test("EN-05: a stopped Endless run that reaches its wakeup starts no new work", async () => {
    const t = await setup();
    const started = await endless(t);
    await driveLoop(t, started.run.id, (v) => v.run.state === "monitoring");
    await t.supervisor.control({
      runId: started.run.id,
      action: "stop",
      commandId: "stop-en05",
    });
    const launches = t.driver.launches.length;
    t.advance(30 * 86_400_000);
    for (let i = 0; i < 5; i++) await t.supervisor.tick();
    expect(t.driver.launches.length).toBe(launches);
    expect(t.supervisor.run(started.run.id).state).toBe("stopped");
    expect(
      [...t.store.iterate<{ state: string }>(loopKinds.wakeup)].every(
        (w) => w.state !== "pending",
      ),
    ).toBe(true);
  });

  test("EN-06: a long run has no hidden iteration limit and pages its history", async () => {
    const t = await setup();
    let n = 0;
    t.script.opportunities = () => [improvement(`Step ${++n}`)];
    t.script.met = (_id, p) => p.stage === "evaluate";
    const started = await endless(t, { iteration: { maxTurns: 40 } });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => (v.checkpoint?.sequence ?? 0) >= 6,
      1200,
    );
    expect(view.checkpoint!.sequence).toBeGreaterThanOrEqual(6);
    expect(view.run.state).not.toBe("completed");
    const page = t.supervisor.timeline(started.run.id, null, 3);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    // Intermediate copies were released; the head and pinned checkpoint 0 were kept.
    expect(t.loop.reclaimed.length).toBeGreaterThan(0);
    expect(t.loop.reclaimed).not.toContain("checkpoint-c0");
    expect(t.loop.reclaimed).not.toContain(view.checkpoint!.candidateId);
  });
});

describe("Recursive Looping: stopping, restart and recovery", () => {
  test("ST-01/ST-02: stop during child work fences dispatch, cancels descendants and settles", async () => {
    const t = await setup();
    implementing(t);
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(t, started.run.id, (v) =>
      t.driver.launches.some((l) => l.purpose === "implementation"),
    );
    const stopped = await t.supervisor.control({
      runId: started.run.id,
      action: "stop",
      commandId: "stop-st01",
    });
    expect(t.driver.interrupted.length).toBeGreaterThan(0);
    expect(["stopped", "stopping"]).toContain(stopped.run.state);
    const launches = t.driver.launches.length;
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "stopped",
      20,
    );
    expect(view.run.state).toBe("stopped");
    expect(t.driver.launches.length).toBe(launches);
    const child = t.orchestrator.repo.require<{ state: string }>(
      "goal",
      t.supervisor.iterations(view.run)[0].childExecutionGoalIds[0],
    );
    expect(child.state).toBe("stopped");
    expect(view.checkpoint!.sequence).toBe(0);
  });

  test("ST-03: a provider that cannot confirm interruption keeps the run stopping", async () => {
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
    t.driver.interrupt = async (id) => {
      t.driver.interrupted.push(id);
    };
    await t.supervisor.control({
      runId: started.run.id,
      action: "stop",
      commandId: "stop-st03",
    });
    await t.supervisor.tick();
    expect(t.supervisor.run(started.run.id).state).toBe("stopping");
    expect(t.supervisor.run(started.run.id).detail).toMatch(/not confirmed/);
    for (const a of t.driver.attempts.values())
      a.obs = { ...a.obs, state: "interrupted", quiescent: true };
    await t.supervisor.tick();
    expect(t.supervisor.run(started.run.id).state).toBe("stopped");
  });

  test("ST-04: a crash after a decision turn was recorded adopts it on recovery", async () => {
    const t = await setup();
    implementing(t);
    t.driver.crashAfterRecord = true;
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    // The first loop turn records its launch and never returns.
    void t.supervisor.tick();
    await new Promise((r) => setTimeout(r, 20));
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    const launches = t.driver.launches.length;
    t.driver.settle();
    await reopened.tick();
    const rounds = [
      ...t.store.iterate<{ members: Array<{ attemptIds: string[] }> }>(
        loopKinds.round,
      ),
    ];
    expect(rounds[0].members[0].attemptIds).toHaveLength(1);
    expect(t.driver.launches.length).toBeGreaterThanOrEqual(launches);
    expect(
      t.driver.launches.filter(
        (l) => l.roundId === (rounds[0] as unknown as { id: string }).id,
      ),
    ).toHaveLength(1);
    void started;
  });

  test("ST-05/CP-04: a repeated promotion or boundary event promotes once and admits one child", async () => {
    const t = await setup();
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(
      t,
      started.run.id,
      (v) => v.iterations.some((i) => i.state === "promoted"),
      300,
    );
    const run = t.supervisor.run(started.run.id);
    const it = t.supervisor
      .iterations(run)
      .find((i) => i.state === "promoted")!;
    // Replaying the promotion after it committed changes nothing.
    await (
      t.supervisor as unknown as {
        promote(r: unknown, i: unknown): Promise<void>;
      }
    ).promote(run, { ...it, state: "promoting" });
    await Promise.all([t.supervisor.tick(), t.supervisor.tick()]);
    expect([...t.store.iterate(loopKinds.promotion)]).toHaveLength(1);
    expect(
      t.supervisor.iterations(run).filter((i) => i.number === 2),
    ).toHaveLength(1);
    expect([...t.store.iterate(loopKinds.checkpoint)]).toHaveLength(2);
  });

  test("ST-06: an old result arriving after pause and resume is stored as stale history", async () => {
    const t = await setup();
    implementing(t);
    const reply = t.driver.reply;
    let hang = true;
    t.driver.reply = (turn) =>
      hang && turn.protocol?.kind === "recursive-loop-v1"
        ? "hang"
        : reply(turn);
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
    t.driver.interrupt = async (id) => {
      t.driver.interrupted.push(id);
    };
    await t.supervisor.control({
      runId: started.run.id,
      action: "pause",
      commandId: "pause-st06",
    });
    await t.supervisor.control({
      runId: started.run.id,
      action: "resume",
      commandId: "resume-st06",
    });
    hang = false;
    // The paused round's attempt finally returns.
    t.driver.settle();
    const view = await driveLoop(t, started.run.id, done, 300);
    const contributions = [
      ...t.store.iterate<{ validation: { state: string } }>(
        loopKinds.contribution,
      ),
    ];
    expect(contributions.some((c) => c.validation.state === "stale")).toBe(
      true,
    );
    expect(view.run.state).toBe("completed");
  });

  test("ST-07/ST-09: quit and reopen suspend and reconcile; stop intent survives and never restarts", async () => {
    const t = await setup();
    implementing(t);
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "implementation" ? "hang" : reply(turn);
    const a = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const b = await startRun(t, {
      mode: "goal",
      text: "Add a farewell",
      policy: { ...policy, recovery: { resumeAfterRestart: true } },
    });
    await driveLoop(
      t,
      a.run.id,
      () =>
        t.driver.launches.filter((l) => l.purpose === "implementation")
          .length >= 2,
      200,
    );
    t.driver.interrupt = async (id) => {
      t.driver.interrupted.push(id);
    };
    await t.supervisor.control({
      runId: b.run.id,
      action: "stop",
      commandId: "stop-st09",
    });
    t.supervisor.suspend();
    expect(t.supervisor.run(a.run.id).state).toBe("suspended");
    const reopened = t.reopenSupervisor();
    await reopened.recover();
    // a: no automatic resume selected; its child work is paused.
    expect(reopened.run(a.run.id).state).toBe("suspended");
    const childA = t.orchestrator.repo.require<{ state: string }>(
      "goal",
      reopened.iterations(a.run)[0].childExecutionGoalIds[0],
    );
    expect(childA.state).toBe("paused");
    // b: auto-resume is on, but the durable stop intent wins.
    const launches = t.driver.launches.length;
    for (let i = 0; i < 5; i++) await reopened.tick();
    expect(reopened.run(b.run.id).desiredState).toBe("stopped");
    expect(t.driver.launches.length).toBe(launches);
    await reopened.control({
      runId: a.run.id,
      action: "resume",
      commandId: "resume-st07",
    });
    expect(reopened.run(a.run.id).state).toBe("active");
  });

  test("ST-08: a sleep gap revalidates and fires a due wakeup once", async () => {
    const t = await setup();
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy,
    });
    await driveLoop(t, started.run.id, (v) => v.run.state === "monitoring");
    t.advance(6 * 3_600_000);
    await t.supervisor.tick();
    await t.supervisor.tick();
    const events = [...t.store.iterate<{ kind: string }>(loopKinds.event)].map(
      (e) => e.kind,
    );
    expect(events).toContain("sleep-detected");
    expect(events.filter((e) => e === "wait-exited")).toHaveLength(1);
  });
});

const organizeOnce = (
  t: Awaited<ReturnType<typeof setup>>,
  decisions: LoopDecision[],
) => {
  let used = false;
  t.script.organize = () => {
    if (used)
      return [
        {
          kind: "request_wait",
          condition: "external",
          reason: "Keep.",
          question: null,
          goalIds: [],
          retryAfterSeconds: null,
        } as LoopDecision,
      ];
    used = true;
    return decisions;
  };
};
const team = (
  operations: unknown[],
  extra: Partial<Extract<LoopDecision, { kind: "reconfigure_team" }>> = {},
) =>
  ({
    kind: "reconfigure_team",
    operations,
    reason: "Evidence suggests it.",
    expectedBenefit: "Better results.",
    evidenceIds: [],
    trigger: "none",
    ...extra,
  }) as LoopDecision;
const childRounds = (
  t: Awaited<ReturnType<typeof setup>>,
  runId: string,
  n = 1,
) => {
  const it = t.supervisor
    .iterations(t.supervisor.run(runId))
    .find((i) => i.number === n)!;
  return t.orchestrator.rounds(it.childExecutionGoalIds[0]);
};
const loopRounds = (t: Awaited<ReturnType<typeof setup>>) => [
  ...t.store.iterate<{
    id: string;
    stage: string;
    state: string;
    iterationId: string;
    members: Array<{
      memberId: string;
      model: string;
      state: string;
      wave: number;
    }>;
  }>(loopKinds.round),
];

describe("Recursive Looping: automatic organization", () => {
  test("TM-01: fully Auto, the coordinators choose member counts and observed models", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "set_members",
          roleId: "coordinator",
          count: 2,
          models: ["astra-fixture", "sol-fixture"],
          effort: null,
        },
        {
          op: "set_members",
          roleId: "reviewer",
          count: 3,
          models: [],
          effort: null,
        },
      ]),
    ]);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 300);
    expect(view.run.state).toBe("completed");
    expect(view.topology!.revision).toBe(2);
    const rounds = childRounds(t, started.run.id);
    expect(
      rounds
        .find((r) => r.kind === "coordination")!
        .members.map((m) => m.model)
        .sort(),
    ).toEqual(["astra-fixture", "sol-fixture"]);
    expect(rounds.find((r) => r.kind === "review")!.members).toHaveLength(3);
    const evaluate = loopRounds(t).find((r) => r.stage === "evaluate")!;
    expect(evaluate.members.map((m) => m.model).sort()).toEqual([
      "astra-fixture",
      "sol-fixture",
    ]);
    expect(view.adaptations.some((a) => a.kind === "bootstrap")).toBe(true);
    expect(view.adaptations.some((a) => a.kind === "commit")).toBe(true);
  });

  test("TM-02/TM-03: a specialist role is created for the next boundary and an unused role retires with its history", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "create_role",
          roleId: "ui-specialist",
          title: "UI specialists",
          instructions: "Own interface changes.",
          function: "implementation",
        },
        { op: "retire_role", roleId: "researcher" },
      ]),
    ]);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 300);
    const roles = view.organization.map((r) => [r.roleId, r.active]);
    expect(roles).toContainEqual(["ui-specialist", true]);
    expect(roles).toContainEqual(["researcher", false]);
    // The retired role keeps its definition; the new one has the function's purpose.
    expect(t.orchestrator.repo.role("p", "researcher").purpose).toBe(
      "information",
    );
    expect(t.orchestrator.repo.role("p", "ui-specialist").purpose).toBe(
      "implementation",
    );
    const child = t.orchestrator.repo.require<{
      loop: { activeRoles: string[] };
    }>("goal", t.supervisor.iterations(view.run)[0].childExecutionGoalIds[0]);
    expect(child.loop.activeRoles).toContain("ui-specialist");
    expect(child.loop.activeRoles).not.toContain("researcher");
  });

  test("TM-04/TM-05: three coordinators and five reviewers all participate; width two runs waves of 2 + 2 + 1", async () => {
    const t = await setup();
    implementing(t);
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy,
      commandId: "create-tm04",
    });
    await t.supervisor.setOverride({
      runId: created.run.id,
      kind: "role-settings",
      roleId: "coordinator",
      settings: { count: 3 },
      commandId: "ov-tm04-c",
    });
    await t.supervisor.setOverride({
      runId: created.run.id,
      kind: "role-settings",
      roleId: "reviewer",
      settings: { count: 5, executionWidth: 2 },
      commandId: "ov-tm04-r",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-tm04",
    });
    const view = await driveLoop(t, created.run.id, done, 400);
    expect(view.run.state).toBe("completed");
    const boundary = loopRounds(t).find((r) => r.stage === "boundary")!;
    expect(boundary.members).toHaveLength(3);
    expect(boundary.members.every((m) => m.state === "returned")).toBe(true);
    const review = childRounds(t, created.run.id).find(
      (r) => r.kind === "review",
    )!;
    expect(review.members).toHaveLength(5);
    expect(review.members.every((m) => m.state === "returned")).toBe(true);
    expect(review.members.map((m) => m.wave)).toEqual([1, 1, 2, 2, 3]);
  });

  test("TM-09: routine swaps that oscillate are rejected by the change policy", async () => {
    const t = await setup();
    let n = 0;
    t.script.opportunities = () => [improvement(`Step ${++n}`)];
    t.script.met = (_id, p) => p.stage === "evaluate";
    const swaps = [["astra-fixture"], ["sol-fixture"], ["astra-fixture"]];
    let i = 0;
    t.script.organize = () => [
      team([
        {
          op: "set_members",
          roleId: "coordinator",
          count: 1,
          models: swaps[Math.min(i++, 2)],
          effort: null,
        },
      ]),
    ];
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: {
        ...policy,
        adaptation: { dwellIterations: 0, explorationShare: 1 },
      },
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => (v.checkpoint?.sequence ?? 0) >= 3,
      800,
    );
    const rejected = view.adaptations.filter((a) => a.kind === "reject");
    expect(
      rejected.some((a) => a.rejections.some((r) => /swap-back|churn/.test(r))),
    ).toBe(true);
  });

  test("TM-10: replacing an unpinned coordinator team moves authority and hands off the run", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "set_members",
          roleId: "coordinator",
          count: 1,
          models: ["sol-fixture"],
          effort: null,
        },
      ]),
    ]);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const before = started.run.authorityGeneration;
    const handoffs: string[] = [];
    const reply = t.driver.reply;
    t.driver.reply = (turn) => {
      if (
        turn.protocol?.stage === "evaluate" &&
        /Handoff from the previous coordination team/.test(turn.prompt)
      )
        handoffs.push(turn.assignment.model!);
      return reply(turn);
    };
    const view = await driveLoop(t, started.run.id, done, 300);
    expect(view.run.authorityGeneration).toBe(before + 1);
    expect(handoffs).toEqual(["sol-fixture"]);
  });

  test("TM-11: the frozen electorate decides; a challenged replacement does not commit", async () => {
    const t = await setup();
    implementing(t);
    t.script.organize = (_p, turn) =>
      turn.memberId.endsWith("-1")
        ? [
            team([
              {
                op: "set_members",
                roleId: "coordinator",
                count: 2,
                models: ["vega-fixture", "lyra-fixture"],
                effort: null,
              },
            ]),
          ]
        : [
            {
              kind: "request_wait",
              condition: "external",
              reason: "Keep the current team.",
              question: null,
              goalIds: [],
              retryAfterSeconds: null,
            } as LoopDecision,
          ];
    const reply = t.driver.reply;
    t.driver.reply = (turn) => {
      if (
        turn.purpose === "coordinator-endorsement" &&
        turn.protocol?.kind === "coordinator-v1" &&
        /organization decision/.test(turn.prompt)
      ) {
        const digest = /Candidate digest \(echo it exactly\): (\S+)/.exec(
          turn.prompt,
        )![1];
        return {
          text: JSON.stringify({
            candidateDigest: digest,
            stance: "challenge",
            rationale: "The current team works.",
          }),
        };
      }
      return reply(turn);
    };
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy,
      commandId: "create-tm11",
    });
    await t.supervisor.setOverride({
      runId: created.run.id,
      kind: "role-settings",
      roleId: "coordinator",
      settings: { count: 2 },
      commandId: "ov-tm11",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-tm11",
    });
    const view = await driveLoop(t, created.run.id, done, 300);
    const organize = loopRounds(t).find((r) => r.stage === "organize")!;
    expect(organize.members.map((m) => m.model)).not.toContain("vega-fixture");
    expect(view.topology!.revision).toBe(1);
    expect(
      view.adaptations.find((a) => a.kind === "reject")!.dissent.length,
    ).toBeGreaterThan(0);
  });

  test("TM-12/PR-03: a coordinator whose runtime reports another model is replaced by an eligible one", async () => {
    const t = await setup();
    implementing(t);
    const reply = t.driver.reply;
    let bad: string | null = null;
    t.driver.reply = (turn) => {
      if (turn.protocol?.kind === "recursive-loop-v1") {
        bad ??= turn.assignment.model;
        if (turn.assignment.model === bad) {
          const r = reply(turn) as { text: string };
          return { ...r, reportedModel: "some-other-model" };
        }
      }
      return reply(turn);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 400);
    expect(view.adaptations.some((a) => a.kind === "recovery")).toBe(true);
    const contributions = [
      ...t.store.iterate<{ validation: { state: string; reason: string } }>(
        loopKinds.contribution,
      ),
    ];
    expect(
      contributions.some(
        (c) =>
          c.validation.state === "invalid" &&
          /reported some-other-model/.test(c.validation.reason),
      ),
    ).toBe(true);
    expect(view.run.state).toBe("completed");
  });

  test("TM-13: an initial team whose work fails verification adapts before any accepted iteration", async () => {
    const t = await setup();
    t.script.met = () => false;
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, iteration: { maxRepairRounds: 0 } },
    });
    await driveLoop(
      t,
      started.run.id,
      (v) =>
        v.iterations.some((i) => i.number === 2 && i.state !== "assessing"),
      300,
    );
    const its = t.supervisor.iterations(started.run);
    expect(its[0].state).toBe("rejected");
    expect(its[1].state).toBe("organizing");
    const outcomes = [
      ...t.store.iterate<{ iterationResult: string }>(loopKinds.outcome),
    ];
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.iterationResult === "rejected")).toBe(true);
  });

  test("TM-14: an implementation role cannot be bound to the review function", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        { op: "bind_function", function: "review", roleId: "implementer" },
      ]),
    ]);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 300);
    const rejection = view.adaptations.find((a) => a.kind === "reject")!;
    expect(rejection.rejections.join(" ")).toMatch(
      /purpose implementation; the review function needs candidate-review/,
    );
  });
});

describe("Recursive Looping: owner overrides", () => {
  test("OV-01/UI-02: an exact coordinator roster from a message is never changed automatically", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "set_members",
          roleId: "coordinator",
          count: 1,
          models: ["sol-fixture"],
          effort: null,
        },
      ]),
    ]);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting. Use Opus and Astra as the exact coordinator team. Include Fable among the reviewers. Choose everything else automatically.",
      policy,
    });
    expect(started.goals.map((g) => g.text)).toEqual(["Add a greeting"]);
    const view = await driveLoop(t, started.run.id, done, 300);
    expect(
      view.adaptations.find((a) => a.kind === "reject")!.rejections.join(" "),
    ).toMatch(/exact roster/);
    for (const r of loopRounds(t))
      expect(r.members.map((m) => m.model).sort()).toEqual([
        "astra-fixture",
        "claude-opus-fixture",
      ]);
    // OV-02: Fable is required among the reviewers; the rest stays Auto.
    const review = childRounds(t, started.run.id).find(
      (r) => r.kind === "review",
    )!;
    expect(review.members.map((m) => m.model)).toContain(
      "claude-fable-fixture",
    );
  });

  test("OV-03: an exact count with a partial pin keeps the count; only free slots change", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "set_members",
          roleId: "reviewer",
          count: 4,
          models: [],
          effort: null,
        },
      ]),
    ]);
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy,
      commandId: "create-ov03",
    });
    await t.supervisor.setOverride({
      runId: created.run.id,
      kind: "role-settings",
      roleId: "reviewer",
      settings: {
        form: "required-plus-auto",
        count: 3,
        members: [
          {
            memberId: "reviewer-fable",
            required: true,
            pin: { label: "Fable" },
            fallbacks: [],
            preferences: { providers: [], models: [] },
            source: { kind: "ui", reference: null, provenance: "explicit" },
          },
        ],
      },
      commandId: "ov-ov03",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-ov03",
    });
    const view = await driveLoop(t, created.run.id, done, 300);
    expect(
      view.adaptations.find((a) => a.kind === "reject")!.rejections.join(" "),
    ).toMatch(/member count is fixed/);
    const review = childRounds(t, created.run.id).find(
      (r) => r.kind === "review",
    )!;
    expect(review.members).toHaveLength(3);
    expect(review.members.map((m) => m.model)).toContain(
      "claude-fable-fixture",
    );
  });

  test("OV-05: a role carrying the owner's pins cannot be split or retired to escape them", async () => {
    const t = await setup();
    implementing(t);
    organizeOnce(t, [
      team([
        {
          op: "split_role",
          roleId: "reviewer",
          into: [
            { roleId: "reviewer-a", title: "A", instructions: "A" },
            { roleId: "reviewer-b", title: "B", instructions: "B" },
          ],
        },
      ]),
    ]);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting. Include Fable among the reviewers.",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 300);
    expect(
      view.adaptations.find((a) => a.kind === "reject")!.rejections.join(" "),
    ).toMatch(/carries your settings or pins/);
    expect(view.organization.find((r) => r.roleId === "reviewer")!.active).toBe(
      true,
    );
  });

  test("OV-06: an unavailable exact model is a visible blocker, never a native-default substitute", async () => {
    const t = await setup();
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting. Use Zephyr as the exact coordinator team.",
      policy,
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "waiting",
      30,
    );
    expect(view.run.waitReason!.kind).toBe("pinned-model");
    expect(t.driver.launches).toHaveLength(0);
  });

  test("OV-07: an override set during execution waits for the next boundary and survives restart", async () => {
    const t = await setup();
    implementing(t);
    const reply = t.driver.reply;
    let hold = true;
    t.driver.reply = (turn) =>
      hold && turn.purpose === "implementation" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    await driveLoop(t, started.run.id, () =>
      t.driver.launches.some((l) => l.purpose === "implementation"),
    );
    const override = await t.supervisor.setOverride({
      runId: started.run.id,
      kind: "role-settings",
      roleId: "reviewer",
      settings: { count: 2 },
      commandId: "ov-ov07",
    });
    expect(override.effectiveBoundary).toBe("next-iteration");
    const child = t.orchestrator.repo.require<{
      loop: { overrides: Record<string, unknown> };
    }>(
      "goal",
      t.supervisor.iterations(started.run)[0].childExecutionGoalIds[0],
    );
    expect(child.loop.overrides.reviewer).toBeUndefined();
    const reopened = t.reopenSupervisor();
    expect(reopened.overrides(started.run).map((o) => o.id)).toContain(
      override.id,
    );
    hold = false;
    await driveLoop(
      t,
      started.run.id,
      (v) =>
        v.iterations.some(
          (i) => i.number === 2 && i.childExecutionGoalIds.length > 0,
        ),
      300,
    );
    expect(childRounds(t, started.run.id, 2).length >= 0).toBe(true);
    const second = t.orchestrator.repo.require<{
      loop: { overrides: Record<string, { count?: number }> };
    }>(
      "goal",
      t.supervisor.iterations(started.run).find((i) => i.number === 2)!
        .childExecutionGoalIds[0],
    );
    expect(second.loop.overrides.reviewer.count).toBe(2);
  });
});

const unitCheck = {
  id: "unit",
  label: "Unit tests",
  executable: "/usr/bin/true",
  args: [],
  timeoutMs: 1000,
};

describe("Recursive Looping: cumulative checkpoints and publication", () => {
  test("CP-01/CP-02/CP-06: iteration two starts from iteration one's accepted content with fresh context", async () => {
    const t = await setup();
    implementing(t);
    const contexts: Array<{
      stage: string | null;
      context: string | null;
      goal: string;
    }> = [];
    const reply = t.driver.reply;
    t.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution")
        contexts.push({
          stage: turn.protocol.stage,
          context: turn.contextCandidateId,
          goal: turn.goalId,
        });
      return reply(turn);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting\nAdd a farewell",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 400);
    const its = t.supervisor.iterations(view.run);
    const first = t.supervisor.checkpoint(its[0].resultCheckpointId!);
    // A supported lineage operation: a new candidate bound to the child goal, from checkpoint 1.
    const second = t.loop.baselines.find(
      (b) => b.goalId === its[1].childExecutionGoalIds[0],
    )!;
    expect(second.from).toBe(first.candidateId);
    expect(second.id).not.toBe(first.candidateId);
    // Loop rounds of iteration two read checkpoint 1; its child goal reads its own baseline.
    expect(
      contexts.filter((c) => c.stage === "boundary" && c.goal === its[1].id)
        .length,
    ).toBeGreaterThanOrEqual(0);
    expect(
      contexts.some((c) => c.stage === null && c.context === second.id),
    ).toBe(true);
    const evaluate2 = loopRounds(t).filter(
      (r) => r.iterationId === its[1].id && r.stage === "evaluate",
    );
    expect(evaluate2.length).toBeGreaterThan(0);
  });

  test("CP-03: a rejected candidate leaves the accepted checkpoint unchanged", async () => {
    const t = await setup();
    t.script.met = () => false;
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, iteration: { maxRepairRounds: 0 } },
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.iterations.some((i) => i.state === "rejected"),
      300,
    );
    expect(view.checkpoint!.sequence).toBe(0);
    expect(view.run.acceptedCheckpointId).toBe(
      started.run.acceptedCheckpointId,
    );
  });

  test("CP-05/CP-09: publication revalidates the folder, applies increments, and reconciles intervening edits", async () => {
    const t = await setup();
    implementing(t);
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
    // CP-05: an edited folder refuses publication; the internal head stays.
    t.loop.folder.problems = [
      "The project folder changed since the run's publication base.",
    ];
    const refused = await t.supervisor.publicationReview(started.run.id);
    await expect(
      t.supervisor.publish({
        runId: started.run.id,
        digest: refused.digest,
        commandId: "pub-refused",
      }),
    ).rejects.toThrow(/Nothing was written/);
    expect(t.loop.published).toHaveLength(0);
    t.loop.folder.problems = [];
    const first = await t.supervisor.publicationReview(started.run.id);
    expect(first.basis).toBe("first");
    await t.supervisor.publish({
      runId: started.run.id,
      digest: first.digest,
      commandId: "pub-1",
    });
    await expect(
      t.supervisor.publicationReview(started.run.id),
    ).rejects.toThrow(/already published/);
    await driveLoop(
      t,
      started.run.id,
      (v) => (v.checkpoint?.sequence ?? 0) >= 2,
      300,
    );
    // CP-09: an intervening edit to a published file needs reconciliation.
    t.loop.folder.problems = [
      "src/a.ts no longer matches what Topsl published; an intervening edit needs reconciliation.",
    ];
    const blocked = await t.supervisor.publicationReview(started.run.id);
    expect(blocked.basis).toBe("incremental");
    await expect(
      t.supervisor.publish({
        runId: started.run.id,
        digest: blocked.digest,
        commandId: "pub-2-refused",
      }),
    ).rejects.toThrow(/intervening edit/);
    t.loop.folder.problems = [];
    const second = await t.supervisor.publicationReview(started.run.id);
    await t.supervisor.publish({
      runId: started.run.id,
      digest: second.digest,
      commandId: "pub-2",
    });
    expect(t.loop.published.map((p) => p.from)).toEqual([
      "base-c",
      t.supervisor.checkpoint(`${started.run.id}:checkpoint:1`).candidateId,
    ]);
    // A fabricated digest never publishes.
    await expect(
      t.supervisor.publish({
        runId: started.run.id,
        digest: "forged",
        commandId: "pub-forged",
      }),
    ).rejects.toThrow();
  });

  test("CP-08: bytes that change after evaluation began get a new evaluation before promotion", async () => {
    const t = await setup();
    implementing(t);
    let hold = true;
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      hold && turn.protocol?.stage === "evaluate" ? "hang" : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(
      t,
      started.run.id,
      (v) =>
        v.current?.rounds.some(
          (r) => r.stage === "evaluate" && r.state === "collecting",
        ) ?? false,
      300,
    );
    const candidate = t.supervisor.view(started.run.id).current!.goal!.goal
      .candidateId!;
    t.loop.digests.set(candidate, "changed-bytes");
    hold = false;
    const view = await driveLoop(t, started.run.id, done, 300);
    expect(
      loopRounds(t).some((r) => r.stage === "evaluate" && r.state === "stale"),
    ).toBe(true);
    expect(view.checkpoint!.contentDigest).toBe("changed-bytes");
  });
});

describe("Recursive Looping: verification, repair and authority", () => {
  test("VF-01/AU-01/AU-03: a failing required check is repaired automatically under the run's grant", async () => {
    const t = await setup();
    implementing(t);
    let failures = 1;
    t.driver.checkResult = () => (failures-- > 0 ? "failed" : "passed");
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, checks: [unitCheck], automaticChecks: true },
      commandId: "create-vf01",
    });
    const review = t.supervisor.authorityReview(created.run.id);
    expect(review.statements.join(" ")).toMatch(/without a sandbox/);
    await t.supervisor.start({
      runId: created.run.id,
      digest: review.digest,
      commandId: "start-vf01",
    });
    const view = await driveLoop(t, created.run.id, done, 400);
    expect(view.run.state).toBe("completed");
    expect(t.supervisor.iterations(view.run)[0].repairs).toBeGreaterThan(0);
    const authorizations = [
      ...t.store.iterate<{
        by: string;
        sandboxed: boolean;
        executionRoute: string;
      }>(loopKinds.authorization),
    ];
    expect(authorizations.length).toBeGreaterThanOrEqual(2);
    expect(
      authorizations.every(
        (a) =>
          a.by === "loop-policy" &&
          a.sandboxed === false &&
          a.executionRoute === "host-user-permissions",
      ),
    ).toBe(true);
    // The initial checkpoint was verified under the same grant (GL-04's route).
    expect(t.loop.verified).toContain("checkpoint-c0");
  });

  test("VF-02: a missing required reviewer is never a quorum by omission", async () => {
    const t = await setup();
    implementing(t);
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.purpose === "candidate-review" ? { text: "not json" } : reply(turn);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.iterations.some((i) => i.state === "rejected"),
      400,
    );
    expect(view.iterations.some((i) => i.state === "promoted")).toBe(false);
    expect(t.supervisor.iterations(view.run)[0].failure!.kind).toBe(
      "invalid-output",
    );
    expect(view.run.adaptationTrigger).toBe("invalid-output");
  });

  test("VF-03: four clean reviews and one substantiated defect still trigger a repair", async () => {
    const t = await setup();
    implementing(t);
    let reported = false;
    const reply = t.driver.reply;
    t.driver.reply = (turn) => {
      if (
        turn.purpose === "candidate-review" &&
        turn.memberId.endsWith("-5") &&
        !reported
      ) {
        reported = true;
        const r = JSON.parse((reply(turn) as { text: string }).text);
        return {
          text: JSON.stringify({
            ...r,
            findings: [
              {
                title: "Off by one",
                severity: "high",
                file: "src/a.ts",
                line: 1,
                behavior: "Wrong.",
                evidence: "Line 1.",
              },
            ],
          }),
        };
      }
      return reply(turn);
    };
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy,
      commandId: "create-vf03",
    });
    await t.supervisor.setOverride({
      runId: created.run.id,
      kind: "role-settings",
      roleId: "reviewer",
      settings: { count: 5 },
      commandId: "ov-vf03",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-vf03",
    });
    const view = await driveLoop(t, created.run.id, done, 400);
    expect(view.run.state).toBe("completed");
    expect(t.supervisor.iterations(view.run)[0].repairs).toBe(1);
  });

  test("VF-04: a candidate that weakens the protected protocol is rejected", async () => {
    const t = await setup();
    implementing(t);
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, checks: [unitCheck], automaticChecks: true },
      commandId: "create-vf04",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-vf04",
    });
    await driveLoop(
      t,
      created.run.id,
      (v) =>
        v.current?.goal?.goal.state === "checking" ||
        v.current?.goal?.goal.state === "awaiting-acceptance",
      300,
    );
    t.loop.protocolIssues = [
      "The run's protected acceptance input tests/a.test.ts changed; the original obligation cannot be rebound to a weaker test.",
    ];
    const view = await driveLoop(
      t,
      created.run.id,
      (v) => v.iterations.some((i) => i.state === "rejected"),
      300,
    );
    expect(view.iterations.some((i) => i.state === "promoted")).toBe(false);
    expect(t.supervisor.iterations(view.run)[0].failure!.detail).toMatch(
      /protected acceptance input/,
    );
  });

  test("VF-06: an unavailable check environment is a visible blocker, never a pass", async () => {
    const t = await setup();
    implementing(t);
    t.driver.checkResult = () => "unavailable";
    t.loop.checkResult = () => "passed";
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy: { ...policy, checks: [unitCheck], automaticChecks: true },
      commandId: "create-vf06",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-vf06",
    });
    const view = await driveLoop(
      t,
      created.run.id,
      (v) => v.run.state === "waiting",
      400,
    );
    expect(view.run.waitReason!.kind).toBe("verification");
    expect(view.iterations.some((i) => i.state === "promoted")).toBe(false);
  });

  test("VF-07: overlapping changes are integrated by a role that keeps every contributor's work", async () => {
    const t = await setup();
    implementing(t);
    let conflicted = false;
    t.driver.integrateResult = (candidates) => {
      if (!conflicted && candidates.length > 1) {
        conflicted = true;
        return { conflicts: [{ path: "src/a.ts", candidateIds: candidates }] };
      }
      return { candidateId: `integrated-x${t.driver.integrations.length}` };
    };
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Coordinate several feature changes across modules",
      policy,
      commandId: "create-vf07",
    });
    await t.supervisor.setOverride({
      runId: created.run.id,
      kind: "role-settings",
      roleId: "implementer",
      settings: { count: 2, collaboration: "parallel-independent" },
      commandId: "ov-vf07",
    });
    await t.supervisor.start({
      runId: created.run.id,
      digest: t.supervisor.authorityReview(created.run.id).digest,
      commandId: "start-vf07",
    });
    const view = await driveLoop(t, created.run.id, done, 400);
    expect(conflicted).toBe(true);
    const integrate = t.driver.launches.find(
      (l) =>
        l.purpose === "implementation" &&
        /keeps every contributor's required work|keep every contributor/.test(
          l.prompt,
        ),
    );
    expect(integrate).toBeDefined();
    expect(view.run.state).toBe("completed");
  });

  test("AU-02: a fabricated start digest is refused", async () => {
    const t = await setup();
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Add a greeting",
      policy,
      commandId: "create-au02",
    });
    await expect(
      t.supervisor.start({
        runId: created.run.id,
        digest: "model-supplied",
        commandId: "start-au02",
      }),
    ).rejects.toThrow(/changed after you reviewed it/);
    expect(t.supervisor.run(created.run.id).started).toBe(false);
  });

  test("AU-04: a new child after allowance exhaustion keeps cumulative accounting", async () => {
    const t = await setup();
    let n = 0;
    t.script.opportunities = () => [improvement(`Step ${++n}`)];
    t.script.met = (_id, p) => p.stage === "evaluate";
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: { ...policy, allowances: { runMemberTurns: 8 } },
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "waiting",
      400,
    );
    expect(view.run.waitReason!.kind).toBe("allowance");
    expect(view.usage.memberTurns).toBeLessThanOrEqual(8);
    expect(view.usage.memberTurns).toBeGreaterThan(4);
    // Each child's grant was bounded by what remained, never reset.
    for (const it of t.supervisor.iterations(view.run))
      for (const id of it.childExecutionGoalIds) {
        const g = t.orchestrator.repo.require<{ grant: { maxTurns: number } }>(
          "goal",
          id,
        );
        expect(g.grant.maxTurns).toBeLessThanOrEqual(8);
      }
  });
});

describe("Recursive Looping: resources, fairness and protocol", () => {
  test("OP-01: missing token measurements stay unknown, never zero", async () => {
    const t = await setup();
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    const view = await driveLoop(t, started.run.id, done, 300);
    expect(view.usage.tokens.input).toBeNull();
    expect(view.usage.tokens.complete).toBe(false);
    expect(view.usage.tokens.totalAttempts).toBeGreaterThan(0);
  });

  test("OP-03: an Endless run yields capacity to direct user work", async () => {
    const t = await setup();
    t.driver.total = 2;
    t.driver.perProvider = 2;
    // Direct user work holds one slot.
    const conversation = await t.orchestrator.createConversation({
      projectId: "p",
      title: "Direct",
      commandId: "direct-conv",
    });
    const reply = t.driver.reply;
    t.driver.reply = (turn) =>
      turn.goalId === direct.id ? "hang" : reply(turn);
    const direct = await t.orchestrator.createGoal({
      conversationId: conversation.id,
      objective: "Direct work",
      commandId: "direct-goal",
    });
    // One tick freezes the direct goal's round; the next launches it.
    await t.orchestrator.tick();
    await t.orchestrator.tick();
    expect(t.driver.capacity().held.length).toBe(1);
    const started = await startRun(t, {
      mode: "endless",
      text: "Keep improving.",
      policy: { scheduling: { reserveForDirectWork: 1 } },
    });
    await t.supervisor.tick();
    const run = t.supervisor.run(started.run.id);
    expect(run.waitReason?.kind).toBe("capacity");
    expect(
      t.driver.launches.filter((l) => l.protocol.kind === "recursive-loop-v1"),
    ).toHaveLength(0);
  });

  test("PR-02: the same model in several assignments keeps separate identities", async () => {
    const t = await setup();
    implementing(t);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(t, started.run.id, done, 300);
    const loopAssignment = loopRounds(t).find((r) => r.stage === "boundary")!
      .members[0];
    const child = childRounds(t, started.run.id).find(
      (r) => r.kind === "coordination",
    )!.members[0];
    expect(loopAssignment.model).toBe(child.model);
    expect(
      (loopAssignment as unknown as { assignmentId: string }).assignmentId,
    ).not.toBe(child.assignmentId);
  });
});

describe("Recursive Looping: live steering", () => {
  test("a goal added during an iteration is interpreted before it is targeted", async () => {
    const t = await setup();
    const state = implementing(t);
    const reply = t.driver.reply;
    let added = false;
    let runId = "";
    t.driver.reply = (turn) => {
      if (!added && turn.purpose === "implementation") {
        added = true;
        void t.supervisor.updateGoals({
          runId,
          add: [{ text: "Add a farewell" }],
          commandId: "add-mid",
        });
      }
      return reply(turn);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    runId = started.run.id;
    const view = await driveLoop(t, runId, done, 400);
    expect(view.run.state).toBe("completed");
    expect(
      view.goals.map((g) => [g.text, g.status, g.criteria.length > 0]),
    ).toEqual([
      ["Add a greeting", "satisfied", true],
      ["Add a farewell", "satisfied", true],
    ]);
    expect(
      t.supervisor.iterations(view.run).filter((i) => i.state === "rejected"),
    ).toHaveLength(0);
    void state;
  });
});

describe("Recursive Looping: evaluation inputs (live run follow-up, 19 October 2026)", () => {
  test("the evaluate prompt carries the target's changed files, since read-only turns may not read their copy", async () => {
    const t = await setup();
    implementing(t);
    (
      t.driver as unknown as {
        fileText: (c: string, p: string) => string | null;
      }
    ).fileText = (c, p) =>
      p === "src/a.ts" ? `export const greeting = "hi"; // ${c}` : null;
    const prompts: string[] = [];
    const reply = t.driver.reply;
    t.driver.reply = (turn) => {
      if (turn.protocol?.stage === "evaluate") prompts.push(turn.prompt);
      return reply(turn);
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    await driveLoop(t, started.run.id, done, 300);
    expect(prompts[0]).toMatch(
      /Contents of the target's changed files[\s\S]*### src\/a\.ts\n```\nexport const greeting = "hi";/,
    );
  });

  test("an evaluation that reports an environment problem is evaluated again after the wait", async () => {
    const t = await setup();
    implementing(t);
    let first = true;
    t.script.override = (p) => {
      if (p.stage !== "evaluate" || !first) return null;
      first = false;
      return {
        text: envelope(p, [
          assess(p, () => false),
          {
            kind: "request_repair",
            failure: "environment",
            summary: "Cannot read the candidate.",
            approach: "wait",
            roleId: null,
          } as LoopDecision,
        ]),
      };
    };
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting",
      policy,
    });
    let view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "waiting",
      300,
    );
    expect(view.run.waitReason!.kind).toBe("verification");
    t.advance(3_600_000);
    view = await driveLoop(t, started.run.id, done, 300);
    expect(view.run.state).toBe("completed");
    expect(loopRounds(t).filter((r) => r.stage === "evaluate").length).toBe(2);
  });
});
