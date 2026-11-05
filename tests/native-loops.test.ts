import { afterEach, describe, expect, test } from "vitest";
import { ResourceLedger } from "../packages/harness/resources";
import { nativeAllowanceLimits } from "../packages/orchestration/loop-checkpoints";
import type { MemberIntent } from "../packages/domain/role-groups";
import type { MemberTurn } from "../packages/orchestration/engine";
import { defaultRoutes, nativeRoute, type Reply } from "./orchestration-fixture";
import { driveLoop, loopSetup, startRun } from "./loop-fixture";

/**
 * Recursive Looping with native members (docs/Native_Harness_Plan.md,
 * Phase 7), over the scripted stand-in driver. Native routes are fixture
 * candidates; their allowance is the harness's real ResourceLedger, and the
 * loop's limit check is the same nativeAllowanceLimits the service uses. The
 * stand-in answers a native member's turn the way the harness behaves: while
 * its quota owner waits, the turn waits too. No model, route or account is
 * contacted, and nothing here is evidence for a live provider.
 */

const open: Array<Awaited<ReturnType<typeof loopSetup>>> = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

const OWNER = "chatgpt:subject-1:oaiapp_fixture";
const policy = { scheduling: { reserveForDirectWork: 0 } };

function pinned(memberId: string, alias: string, model: string): MemberIntent {
  return {
    memberId,
    required: true,
    pin: { provider: "native", routeId: `route-${alias}`, model },
    fallbacks: [],
    preferences: { providers: [], models: [] },
    source: { kind: "ui", reference: null, provenance: "explicit" },
  };
}

async function setup() {
  const t = await loopSetup();
  open.push(t);
  const ledger = new ResourceLedger();
  // Two routes on one ChatGPT account: one allowance, one quota owner.
  t.driver.routesList = [
    ...defaultRoutes(),
    nativeRoute("plan/a", "gpt-fixture-a", {
      quotaOwner: OWNER,
      connectionId: "chatgpt-1",
      connectionLabel: "ChatGPT plan",
    }),
    nativeRoute("plan/b", "gpt-fixture-b", {
      quotaOwner: OWNER,
      connectionId: "chatgpt-1",
      connectionLabel: "ChatGPT plan",
    }),
  ];
  t.loop.providerLimits = (_providers, native = []) =>
    nativeAllowanceLimits(native, {
      quotaWait: (owner) => ledger.quotaWait(owner),
      connectionState: () => "ready",
    });
  // Implementation work counts as done once a native implementer returned.
  let implemented = false;
  const base = t.driver.reply;
  const waits = new Map<string, NonNullable<Reply>>();
  t.driver.reply = (turn: MemberTurn): Reply => {
    const owner = turn.assignment.native?.quotaOwner;
    if (owner && ledger.quotaWait(owner))
      return {
        wait: {
          kind: "quota",
          quotaOwner: owner,
          detail: `Waiting for ChatGPT plan's allowance: ${ledger.quotaWait(owner)!.detail}`,
        },
      };
    const scripted = waits.get(turn.memberId);
    if (scripted) return scripted;
    if (turn.purpose === "implementation") implemented = true;
    return base(turn);
  };
  t.script.met = (_id, p) => p.stage === "evaluate" && implemented;
  const group = (roleId: string, members: MemberIntent[]) =>
    t.orchestrator.setGroup({
      projectId: "p",
      goalId: null,
      level: "project-role",
      roleId,
      settings: { form: "exact", members },
      commandId: `group-${roleId}-${Math.random()}`,
    });
  const nativeLaunches = (memberId?: string) =>
    t.driver.launches.filter(
      (l) =>
        l.assignment.provider === "native" &&
        (!memberId || l.memberId === memberId),
    );
  return { ...t, ledger, group, waits, nativeLaunches };
}

describe("native members in Recursive Looping", () => {
  test("an iteration waits on an allowance two routes share, starts nothing meanwhile, and continues once the owner resumes it", async () => {
    const t = await setup();
    // Codex coordinates; two native implementers on routes of one account.
    await t.group("implementer", [
      pinned("plan-a", "plan/a", "gpt-fixture-a"),
      pinned("plan-b", "plan/b", "gpt-fixture-b"),
    ]);
    t.ledger.pauseQuota(OWNER, "subscription_sharing_usage_limit_exceeded");
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting to src/a.ts",
      policy,
    });
    let view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "waiting",
    );
    expect(view.run.state).toBe("waiting");
    expect(view.run.waitReason).toMatchObject({ kind: "quota" });
    expect(view.run.waitReason!.detail).toContain(
      "plan/a, plan/b share this allowance and wait together",
    );
    // Waiting starts no native turn and no child goal for the iteration.
    expect(t.nativeLaunches()).toHaveLength(0);
    const before = t.driver.launches.length;
    t.advance(60_000);
    for (let i = 0; i < 5; i++) {
      await t.orchestrator.tick();
      await t.supervisor.tick();
    }
    expect(t.supervisor.run(started.run.id).waitReason?.kind).toBe("quota");
    expect(t.driver.launches.length).toBe(before);

    // The owner tries the allowance again: the changed allowance wakes the
    // run before its backoff is due.
    t.ledger.resumeQuota(OWNER);
    t.advance(1_000);
    await t.supervisor.tick();
    expect(t.supervisor.run(started.run.id).state).not.toBe("waiting");
    view = await driveLoop(t, started.run.id, (v) =>
      ["completed", "stopped"].includes(v.run.state),
    );
    expect(view.run.state).toBe("completed");
    expect(view.checkpoint!.sequence).toBe(1);
    const implementers = t.nativeLaunches().filter(
      (l) => l.purpose === "implementation",
    );
    expect(implementers.map((l) => l.assignment.native!.routeAlias).sort()).toEqual([
      "plan/a",
      "plan/b",
    ]);
    // Both members are funded by the one allowance they waited on.
    expect(
      new Set(implementers.map((l) => l.assignment.native!.quotaOwner)),
    ).toEqual(new Set([OWNER]));
  });

  test("a native coordinator that hits its allowance mid-round waits in place: no replacement turn, and the same turn finishes after resume", async () => {
    const t = await setup();
    await t.group("coordinator", [pinned("plan-a", "plan/a", "gpt-fixture-a")]);
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting to src/a.ts",
      policy,
    });
    // The allowance runs out while the first decision turn is in flight.
    for (let i = 0; i < 4 && !t.nativeLaunches("plan-a").length; i++) {
      await t.orchestrator.tick();
      await t.supervisor.tick();
    }
    expect(t.nativeLaunches("plan-a")).toHaveLength(1);
    t.ledger.pauseQuota(OWNER, "usage limit reached");
    let view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.waitReason?.kind === "quota",
      40,
    );
    expect(view.run.waitReason).toMatchObject({ kind: "quota" });
    expect(view.run.waitReason!.detail).toContain("waiting on an allowance");
    // Many ticks later the member still has its one attempt.
    for (let i = 0; i < 10; i++) {
      await t.orchestrator.tick();
      await t.supervisor.tick();
      t.driver.settle();
    }
    expect(t.nativeLaunches("plan-a")).toHaveLength(1);
    const waiting = t.nativeLaunches("plan-a")[0];
    expect(t.driver.interrupted).toHaveLength(0);

    t.ledger.resumeQuota(OWNER);
    view = await driveLoop(t, started.run.id, (v) =>
      ["completed", "stopped"].includes(v.run.state),
    );
    expect(view.run.state).toBe("completed");
    // The waiting turn itself completed; it was not replaced.
    const first = [...t.driver.attempts.values()].find(
      (a) => a.turn.launchId === waiting.launchId,
    )!;
    expect(first.obs.state).toBe("completed");
  });

  test("a native turn paused for no progress waits for the owner instead of restarting", async () => {
    const t = await setup();
    await t.group("implementer", [pinned("plan-b", "plan/b", "gpt-fixture-b")]);
    t.waits.set("plan-b", {
      wait: {
        kind: "no-progress",
        quotaOwner: null,
        detail:
          "Paused for no progress: edit_file failed the same way three times.",
      },
    });
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting to src/a.ts",
      policy,
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.waitReason?.kind === "no-progress",
    );
    expect(view.run.waitReason).toMatchObject({ kind: "no-progress" });
    expect(
      (view.run.waitReason as { attemptIds: string[] }).attemptIds,
    ).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      await t.orchestrator.tick();
      await t.supervisor.tick();
      t.driver.settle();
    }
    expect(t.nativeLaunches("plan-b")).toHaveLength(1);
    // The owner resumed it (under Native tasks); the iteration carries on.
    t.waits.delete("plan-b");
    const done = await driveLoop(t, started.run.id, (v) =>
      ["completed", "stopped"].includes(v.run.state),
    );
    expect(done.run.state).toBe("completed");
    expect(t.nativeLaunches("plan-b")).toHaveLength(1);
  });

  test("Stop during a quota wait interrupts the waiting native turn and starts nothing new", async () => {
    const t = await setup();
    await t.group("coordinator", [pinned("plan-a", "plan/a", "gpt-fixture-a")]);
    t.ledger.pauseQuota(OWNER, "usage limit reached");
    const started = await startRun(t, {
      mode: "goal",
      text: "Add a greeting to src/a.ts",
      policy,
    });
    await driveLoop(
      t,
      started.run.id,
      (v) => v.run.waitReason?.kind === "quota",
      40,
    );
    const waiting = t.nativeLaunches("plan-a");
    expect(waiting).toHaveLength(1);
    await t.supervisor.control({
      runId: started.run.id,
      action: "stop",
      commandId: "stop-native-quota",
    });
    const view = await driveLoop(
      t,
      started.run.id,
      (v) => v.run.state === "stopped",
      40,
    );
    expect(view.run.state).toBe("stopped");
    const attempt = t.driver.launchRecords.get(waiting[0].launchId)!;
    expect(t.driver.interrupted).toContain(attempt);
    t.ledger.resumeQuota(OWNER);
    const launches = t.driver.launches.length;
    t.advance(86_400_000);
    for (let i = 0; i < 5; i++) {
      await t.orchestrator.tick();
      await t.supervisor.tick();
      t.driver.settle();
    }
    expect(t.driver.launches.length).toBe(launches);
  });
});
