import { afterEach, describe, expect, test } from "vitest";
import type { Goal, RoleRound } from "../packages/domain/role-groups";
import { kinds } from "../packages/orchestration/repository";
import {
  defaultReply,
  drive,
  orchestration,
  rosterPlan,
} from "./orchestration-fixture";

/**
 * RL-0 prerequisites in the coordinator engine (docs/Recursive_Looping.md):
 * one resolved topology for planning and execution, role-definition fencing,
 * purpose-compatible actions and dependency handoff.
 */
const open: Array<Awaited<ReturnType<typeof orchestration>>> = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
let n = 0;
const cmd = () => `prereq-${++n}`;
async function setup() {
  const f = await orchestration();
  open.push(f);
  return f;
}
async function goal(f: Awaited<ReturnType<typeof setup>>, text: string) {
  const conversation = await f.orchestrator.createConversation({
    projectId: "p",
    title: "Main",
    commandId: cmd(),
  });
  return (
    await f.orchestrator.post({
      conversationId: conversation.id,
      text,
      commandId: cmd(),
    })
  ).goal!;
}
const rounds = (f: Awaited<ReturnType<typeof setup>>, goalId: string) =>
  f.orchestrator.rounds(goalId);

describe("coordinator prerequisites for Recursive Looping", () => {
  test("coordinators see the resolved roster that executes their plan", async () => {
    const f = await setup();
    const g = await goal(f, "Coordinate a feature across modules");
    const prompts: string[] = [];
    f.driver.reply = (turn) => {
      if (turn.purpose === "coordinator-contribution")
        prompts.push(turn.prompt);
      return defaultReply(turn);
    };
    expect(await drive(f.orchestrator, f.driver, g.id)).toBe(
      "awaiting-acceptance",
    );
    // A complex goal resolves two Auto implementers; the prompt says two, not the configured minimum.
    expect(prompts[0]).toMatch(
      /- implementer: implementation, 2 member\(s\), parallel-partitioned/,
    );
    const work = rounds(f, g.id).find((r) => r.kind === "work")!;
    expect(work.members).toHaveLength(2);
    expect(Object.keys(work.input.partitions)).toHaveLength(2);
  });

  test("TM-06: a roster that changed after planning is a stale topology, never a trimmed one", async () => {
    const f = await setup();
    const g = await goal(f, "Coordinate a feature across modules");
    let hold = true;
    f.driver.reply = (turn) =>
      hold && turn.purpose === "coordinator-contribution"
        ? "hang"
        : defaultReply(turn);
    await drive(f.orchestrator, f.driver, g.id, {
      until: () =>
        rounds(f, g.id).some((r) =>
          r.members.some((m) => m.state === "running"),
        ),
      maxSteps: 5,
    });
    // The plan is being made for two implementers; the owner asks for three.
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: g.id,
      level: "goal-role",
      roleId: "implementer",
      settings: { count: 3 },
      commandId: cmd(),
    });
    hold = false;
    const state = await drive(f.orchestrator, f.driver, g.id);
    expect(state).toBe("blocked");
    const goalNow = f.orchestrator.repo.require<Goal>(kinds.goal, g.id);
    expect(goalNow.detail).toMatch(
      /now resolves to .*Replan|Steer the goal to replan/,
    );
    expect(f.driver.launches.some((l) => l.purpose === "implementation")).toBe(
      false,
    );
  });

  test("TM-07: a role definition changed while its plan is decided cannot dispatch", async () => {
    const f = await setup();
    await f.orchestrator.defineRole({
      projectId: "p",
      roleId: "ui-dev",
      title: "UI",
      instructions: "Interface work.",
      purpose: "implementation",
      commandId: cmd(),
    });
    const g = await goal(f, "Add a button");
    let hold = true;
    f.driver.reply = (turn) =>
      hold && turn.purpose === "coordinator-contribution"
        ? "hang"
        : defaultReply(turn);
    await drive(f.orchestrator, f.driver, g.id, {
      until: () =>
        rounds(f, g.id).some((r) =>
          r.members.some((m) => m.state === "running"),
        ),
      maxSteps: 5,
    });
    await f.orchestrator.defineRole({
      projectId: "p",
      roleId: "ui-dev",
      title: "UI",
      instructions: "Revised interface work.",
      purpose: "implementation",
      commandId: cmd(),
    });
    hold = false;
    await drive(f.orchestrator, f.driver, g.id);
    const first = rounds(f, g.id).find((r) => r.kind === "coordination")!;
    expect(first.stage).toBe("stale");
    expect(first.detail).toMatch(/ui-dev's definition changed/);
  });

  test("TM-08: an implementation action for a role with another purpose is rejected before launch", async () => {
    const f = await setup();
    const g = await goal(f, "Add a button");
    f.driver.reply = (turn) => {
      if (turn.purpose !== "coordinator-contribution")
        return defaultReply(turn);
      const plan = rosterPlan(turn);
      plan[0].roleId = "reviewer";
      return defaultReply(turn, plan);
    };
    expect(await drive(f.orchestrator, f.driver, g.id)).toBe("blocked");
    const contribution = f.orchestrator.contributions(
      rounds(f, g.id)[0].id,
      "p",
    )[0];
    expect(contribution.validation.reason).toMatch(
      /role reviewer has purpose candidate-review; its output contract cannot satisfy this task/,
    );
    expect(f.driver.launches.some((l) => l.purpose === "implementation")).toBe(
      false,
    );
  });

  test("CP-07: a dependent task receives its predecessor's actual outputs; integration keeps both once", async () => {
    const f = await setup();
    const g = await goal(f, "Add an API and use it");
    f.driver.reply = (turn) => {
      if (turn.purpose !== "coordinator-contribution")
        return defaultReply(turn);
      return defaultReply(turn, [
        {
          key: "api",
          title: "Add the API",
          kind: "implementation",
          roleId: "implementer",
          dependencies: [],
          permittedOutputs: ["src/api.ts"],
          acceptanceCriteria: [],
          brief: "Add it.",
          partitions: [],
        },
        {
          key: "use",
          title: "Use the API",
          kind: "implementation",
          roleId: "implementer",
          dependencies: ["api"],
          permittedOutputs: ["src/use.ts"],
          acceptanceCriteria: [],
          brief: "Use it.",
          partitions: [],
        },
      ]);
    };
    expect(await drive(f.orchestrator, f.driver, g.id)).toBe(
      "awaiting-acceptance",
    );
    const api = f.driver.launches.find(
      (l) => l.purpose === "implementation" && /Task api:/.test(l.prompt),
    )!;
    const use = f.driver.launches.find(
      (l) => l.purpose === "implementation" && /Task use:/.test(l.prompt),
    )!;
    const apiCandidate = [...f.driver.attempts.values()].find(
      (a) => a.turn.launchId === api.launchId,
    )!.obs.candidateId!;
    // The dependent task started from an assembled baseline containing the API.
    const assembly = f.driver.integrations[0];
    expect(assembly.candidates).toEqual([apiCandidate]);
    expect(use.candidateId).toBe("integrated-1");
    expect(use.prompt).toMatch(
      /Inputs from the tasks this one depends on:\n- api \(implementation; its changes to src\/api.ts are already in your starting files\)/,
    );
    // Final integration includes both, with the dependent result superseding its base.
    const final = f.driver.integrations.at(-1)!;
    const useCandidate = [...f.driver.attempts.values()].find(
      (a) => a.turn.launchId === use.launchId,
    )!.obs.candidateId!;
    expect(final.candidates.sort()).toEqual(
      [apiCandidate, useCandidate].sort(),
    );
    expect(final.ancestry).toEqual({ [useCandidate]: [apiCandidate] });
    const round = rounds(f, g.id).find((r: RoleRound) => r.taskKey === "use")!;
    expect(round.input.dependencyBundleId).toBeTruthy();
  });

  test("ordinary coordinator turns carry the coordinator-v1 protocol", async () => {
    const f = await setup();
    const g = await goal(f, "Add a button");
    await drive(f.orchestrator, f.driver, g.id);
    expect(
      f.driver.launches.every((l) => l.protocol.kind === "coordinator-v1"),
    ).toBe(true);
  });
});
