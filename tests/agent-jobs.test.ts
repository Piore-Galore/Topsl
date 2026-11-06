import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { now } from "../packages/domain/invariants";
import type {
  Goal,
  PlanTaskAction,
  QueuedPlanAction,
} from "../packages/domain/role-groups";
import { Store } from "../packages/persistence/store";
import {
  AgentJobService,
  agentJobsPreferenceId,
  type AgentJob,
  type AgentJobEngine,
} from "../packages/orchestration/agent-jobs";

/**
 * The agent-job service's authority and durability rules (plan §7), against
 * a recorded engine stand-in. Service-level runs across engines are in
 * tests/native-members.test.ts.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-jobs-"));
  const store = new Store(
    path.join(directory, "store.sqlite"),
    randomBytes(32).toString("hex"),
  );
  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const goals = new Map<string, Goal>();
  const admitted: Array<{ goalId: string; task: PlanTaskAction }> = [];
  const actions: QueuedPlanAction[] = [];
  const goal = (id: string, projectId = "p", over: Partial<Goal> = {}) => {
    const value = {
      id,
      projectId,
      state: "planning",
      controlGeneration: 1,
      planId: null,
      grant: {
        taskKinds: ["implementation", "information"],
        maxTurns: 200,
        maxDelegatedTasks: 3,
        maxRepairRounds: 2,
        maxReconciliationTurns: 1,
        expiresAt: null,
      },
      usage: { turns: 0, delegatedTasks: 0, repairRounds: 0 },
      ...over,
    } as unknown as Goal;
    goals.set(id, value);
    return value;
  };
  const engine: AgentJobEngine = {
    goal: (id) => goals.get(id),
    round: () => undefined,
    actions: (g) => actions.filter((a) => a.goalId === g.id),
    rounds: () => [],
    contributions: () => [],
    roles: () => [
      { id: "implementer", purpose: "implementation" },
      { id: "researcher", purpose: "information" },
      { id: "reviewer", purpose: "candidate-review" },
    ],
    admit: (g, task) => {
      admitted.push({ goalId: g.id, task });
      actions.push({
        id: `${g.planId}:${task.key}`,
        projectId: g.projectId,
        goalId: g.id,
        planId: g.planId!,
        taskKey: task.key,
        revision: 1,
        state: "queued",
        expectedControlGeneration: g.controlGeneration,
        roundId: null,
        attemptIds: [],
        candidateIds: [],
        artifactIds: [],
        detail: "",
        createdAt: now(),
        updatedAt: now(),
      });
    },
    cancelQueued: (g, key) => {
      const i = actions.findIndex((a) => a.goalId === g.id && a.taskKey === key);
      if (i < 0 || actions[i].state !== "queued") return false;
      actions.splice(i, 1);
      return true;
    },
  };
  const jobs = new AgentJobService(store, engine);
  const authorize = (attemptId: string, goalId: string, projectId = "p") =>
    store.immutable("agent-job-authority", {
      id: attemptId,
      projectId,
      goalId,
      roundId: "round",
      memberId: "coordinator",
      controlGeneration: goals.get(goalId)!.controlGeneration,
      createdAt: now(),
    });
  const enable = (on = true) =>
    store.put("preference", { id: agentJobsPreferenceId, value: on });
  return { store, jobs, goal, goals, authorize, enable, admitted, actions };
}

const request = {
  title: "Survey",
  brief: "Report what file.ts exports.",
  kind: "information",
};
const parse = (answer: { ok: boolean; text: string }) => {
  expect(answer.ok).toBe(true);
  return JSON.parse(answer.text);
};

test("a turn without a recorded authority, or with the gate off, starts nothing", async () => {
  const f = await setup();
  f.goal("g");
  f.enable();
  expect(f.jobs.call("attempt", "call", "start_agent_job", request)).toEqual({
    ok: false,
    text: "This turn has no authority to request agent jobs.",
  });
  f.authorize("attempt", "g");
  f.enable(false);
  expect(f.jobs.call("attempt", "call", "start_agent_job", request).text).toBe(
    "Agent jobs are turned off in Topsl's settings.",
  );
  expect([...f.store.iterate("agent-job")]).toEqual([]);
});

test("the same key returns the same job; the same key with other arguments is a conflict", async () => {
  const f = await setup();
  f.goal("g");
  f.enable();
  f.authorize("attempt", "g");
  const first = parse(f.jobs.call("attempt", "call-1", "start_agent_job", request));
  // A retried tool call has the same call identity.
  expect(
    parse(f.jobs.call("attempt", "call-1", "start_agent_job", request)).job_id,
  ).toBe(first.job_id);
  const conflict = f.jobs.call("attempt", "call-1", "start_agent_job", {
    ...request,
    title: "Other",
  });
  expect(conflict.ok).toBe(false);
  expect(conflict.text).toContain("already names a different job request");
  // An explicit idempotency key holds across call identities.
  const keyed = { ...request, idempotency_key: "k" };
  const a = parse(f.jobs.call("attempt", "call-2", "start_agent_job", keyed));
  const b = parse(f.jobs.call("attempt", "call-3", "start_agent_job", keyed));
  expect(b.job_id).toBe(a.job_id);
  expect([...f.store.iterate("agent-job")]).toHaveLength(2);
});

test("a job of another goal or project is not visible, and model-supplied IDs grant nothing", async () => {
  const f = await setup();
  f.goal("g");
  f.goal("other-goal");
  f.goal("other-project-goal", "q");
  f.enable();
  f.authorize("attempt", "g");
  f.authorize("other", "other-goal");
  f.authorize("foreign", "other-project-goal", "q");
  const job = parse(f.jobs.call("attempt", "c", "start_agent_job", request));
  for (const caller of ["other", "foreign"]) {
    const seen = f.jobs.call(caller, "c", "get_agent_job", { job_id: job.job_id });
    expect(seen).toEqual({ ok: false, text: "No such agent job for this goal." });
    expect(
      f.jobs.call(caller, "c", "cancel_agent_job", { job_id: job.job_id }).ok,
    ).toBe(false);
  }
  expect(
    f.jobs.call("attempt", "c", "get_agent_job", { job_id: "../../etc" }).ok,
  ).toBe(false);
});

test("a stopped or restarted goal fences new jobs and cancels jobs that had not started", async () => {
  const f = await setup();
  const goal = f.goal("g");
  f.enable();
  f.authorize("attempt", "g");
  const job = parse(f.jobs.call("attempt", "c", "start_agent_job", request));
  // Stop: the generation advances.
  f.goals.set("g", { ...goal, state: "stopped", controlGeneration: 2 });
  expect(
    f.jobs.call("attempt", "d", "start_agent_job", { ...request, title: "Late" })
      .text,
  ).toContain("stopped, paused or changed");
  f.jobs.settle(f.goals.get("g")!);
  expect(f.store.get<AgentJob>("agent-job", job.job_id)).toMatchObject({
    state: "cancelled",
  });
  expect(f.admitted).toEqual([]);
});

test("jobs join the plan only once it has committed, within the goal's grant", async () => {
  const f = await setup();
  const goal = f.goal("g");
  f.enable();
  f.authorize("attempt", "g");
  // The grant allows 3 delegated tasks; 3 are already used or pending.
  f.goals.set("g", { ...goal, usage: { ...goal.usage, delegatedTasks: 2 } });
  parse(f.jobs.call("attempt", "a", "start_agent_job", request));
  const over = f.jobs.call("attempt", "b", "start_agent_job", {
    ...request,
    title: "One more",
  });
  expect(over.ok).toBe(false);
  expect(over.text).toContain("above the 0 the goal's grant still allows");
  // A kind the grant does not permit, or a role with the wrong purpose.
  f.goals.set("g", {
    ...f.goals.get("g")!,
    usage: { ...goal.usage, delegatedTasks: 0 },
    grant: { ...goal.grant, taskKinds: ["information"] },
  });
  expect(
    f.jobs.call("attempt", "c", "start_agent_job", {
      ...request,
      kind: "implementation",
      permitted_outputs: ["file.ts"],
    }).text,
  ).toContain("which the goal's grant does not permit");
  expect(
    f.jobs.call("attempt", "d", "start_agent_job", { ...request, role: "reviewer" })
      .text,
  ).toContain("has purpose candidate-review");
  // Planning: nothing is admitted. Running with a plan: admitted once.
  f.jobs.settle(f.goals.get("g")!);
  expect(f.admitted).toEqual([]);
  f.goals.set("g", { ...f.goals.get("g")!, state: "running", planId: "plan-1" });
  f.jobs.settle(f.goals.get("g")!);
  f.jobs.settle(f.goals.get("g")!);
  expect(f.admitted).toHaveLength(1);
  expect(f.admitted[0].task).toMatchObject({
    kind: "information",
    roleId: "researcher",
    dependencies: [],
  });
});

test("cancel withdraws a job that has not started and refuses one that has", async () => {
  const f = await setup();
  f.goal("g", "p", { state: "running", planId: "plan-1" } as Partial<Goal>);
  f.enable();
  f.authorize("attempt", "g");
  const a = parse(f.jobs.call("attempt", "a", "start_agent_job", request));
  expect(
    parse(f.jobs.call("attempt", "x", "cancel_agent_job", { job_id: a.job_id }))
      .status,
  ).toBe("cancelled");
  const b = parse(
    f.jobs.call("attempt", "b", "start_agent_job", { ...request, title: "B" }),
  );
  f.jobs.settle(f.goals.get("g")!);
  // Admitted but not started: withdrawn from the plan.
  expect(
    parse(f.jobs.call("attempt", "y", "cancel_agent_job", { job_id: b.job_id }))
      .status,
  ).toBe("cancelled");
  const c = parse(
    f.jobs.call("attempt", "c", "start_agent_job", { ...request, title: "C" }),
  );
  f.jobs.settle(f.goals.get("g")!);
  f.actions.find((x) => x.taskKey.endsWith(c.task_key.slice(-12)))!.state =
    "admitted";
  const refused = f.jobs.call("attempt", "z", "cancel_agent_job", {
    job_id: c.job_id,
  });
  expect(refused.ok).toBe(false);
  expect(refused.text).toContain("stop the goal to cancel it");
});
