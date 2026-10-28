import { afterEach, describe, expect, test } from "vitest";
import type { Goal } from "../packages/domain/role-groups";
import {
  goalAttention,
  loopAttention,
  parseThreadId,
  summarizeThreads,
  threadTitle,
  type ThreadGoalFact,
  type ThreadRunFact,
} from "../packages/domain/threads";
import { kinds } from "../packages/orchestration/repository";
import { classifyMessage } from "../packages/orchestration/routing";
import { orchestration } from "./orchestration-fixture";
import { loopSetup } from "./loop-fixture";

/**
 * Coordinator threads (docs/Coordinator_Teams.md#conversations-as-threads):
 * routing of follow-ups in a goal thread, one conversation per new goal,
 * loop steering recorded in the run's conversation, and the sidebar
 * summaries. Fixture stand-ins only.
 */

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
let counter = 0;
const cmd = () => `threads-cmd-${++counter}`;

describe("message routing", () => {
  const running = { state: "running" as const };
  const accepted = { state: "accepted" as const };

  test("auto routing is unchanged: steering phrases steer, other text is a new goal", () => {
    expect(classifyMessage("Also keep the API.", running, "auto")).toBe(
      "update-goal",
    );
    expect(classifyMessage("Make it blue.", running, "auto")).toBe("new-goal");
    expect(classifyMessage("Is it done?", running, "auto")).toBe("status");
    expect(classifyMessage("Is it done?", undefined, "auto")).toBe("new-goal");
    expect(classifyMessage("Status", undefined, "auto")).toBe("status");
    expect(classifyMessage("Stop everything", running, "auto")).toBe("status");
  });

  test("a follow-up steers a running goal and continues an ended one", () => {
    expect(classifyMessage("Make it blue.", running, "follow-up")).toBe(
      "update-goal",
    );
    expect(classifyMessage("Make it blue.", accepted, "follow-up")).toBe(
      "related-goal",
    );
    expect(classifyMessage("Make it blue.", undefined, "follow-up")).toBe(
      "new-goal",
    );
    expect(classifyMessage("Is it done?", running, "follow-up")).toBe("status");
    // A question after the goal ended asks for more work, not its status.
    expect(classifyMessage("Can you add tests?", accepted, "follow-up")).toBe(
      "related-goal",
    );
    expect(classifyMessage("What is the status", accepted, "follow-up")).toBe(
      "status",
    );
  });

  test("explicit routing is kept", () => {
    expect(classifyMessage("Make it blue.", running, "new-goal")).toBe(
      "new-goal",
    );
  });
});

describe("thread summaries", () => {
  const goal = (over: Partial<ThreadGoalFact>): ThreadGoalFact => ({
    id: "g1",
    conversationId: "c1",
    objective: "Change the value to two",
    kind: "code",
    state: "running",
    application: null,
    updatedAt: "2026-10-28T10:00:00.000Z",
    ...over,
  });
  const run = (over: Partial<ThreadRunFact>): ThreadRunFact => ({
    id: "r1",
    conversationId: "c9",
    title: "Make sync reliable",
    mode: "goal",
    state: "active",
    started: true,
    waitReason: null,
    updatedAt: "2026-10-28T09:00:00.000Z",
    ...over,
  });

  test("attention follows what the owner must do next", () => {
    expect(goalAttention(goal({ state: "blocked" }))).toBe("Decide");
    expect(goalAttention(goal({ state: "checking" }))).toBe("Run checks");
    expect(goalAttention(goal({ state: "awaiting-acceptance" }))).toBe(
      "Accept",
    );
    expect(goalAttention(goal({ state: "accepted" }))).toBe("Apply");
    expect(
      goalAttention(
        goal({ state: "accepted", application: { state: "applied" } }),
      ),
    ).toBeNull();
    expect(
      goalAttention(goal({ state: "accepted", kind: "information" })),
    ).toBeNull();
    expect(goalAttention(goal({ state: "running" }))).toBeNull();
    expect(loopAttention(run({ started: false, state: "paused" }))).toBe(
      "Review and start",
    );
    expect(
      loopAttention(
        run({ state: "waiting", waitReason: { kind: "user-input" } }),
      ),
    ).toBe("Answer");
    expect(
      loopAttention(
        run({ state: "monitoring", waitReason: { kind: "no-opportunity" } }),
      ),
    ).toBeNull();
    expect(loopAttention(run({ state: "stopped", started: false }))).toBeNull();
  });

  test("goal and loop threads are listed newest first; empty conversations are not", () => {
    const threads = summarizeThreads({
      projectId: "p",
      conversations: [
        {
          id: "c1",
          projectId: "p",
          title: "Change the value to two",
          goalIds: ["g1"],
          createdAt: "2026-10-28T08:00:00.000Z",
          updatedAt: "2026-10-28T08:00:00.000Z",
        },
        {
          id: "c2",
          projectId: "p",
          title: "Project conversation",
          goalIds: [],
          createdAt: "2026-10-28T08:00:00.000Z",
          updatedAt: "2026-10-28T11:00:00.000Z",
        },
        // A loop's own conversation that also holds an ordinary goal (the
        // earlier Single goal view posted into conversations[0]).
        {
          id: "c9",
          projectId: "p",
          title: "Goal loop",
          goalIds: ["g2"],
          createdAt: "2026-10-28T07:00:00.000Z",
          updatedAt: "2026-10-28T07:00:00.000Z",
        },
      ],
      goals: [
        goal({ state: "awaiting-acceptance" }),
        goal({
          id: "g2",
          conversationId: "c9",
          objective: "Stray goal",
          updatedAt: "2026-10-28T07:30:00.000Z",
        }),
      ],
      runs: [run({})],
    });
    expect(threads.map((t) => t.threadId)).toEqual([
      "goal:c1",
      "loop:r1",
      "goal:c9",
    ]);
    expect(threads[0]).toMatchObject({
      kind: "goal",
      title: "Change the value to two",
      needsYou: "Accept",
    });
    expect(threads[1]).toMatchObject({ kind: "goal-loop", runId: "r1" });
    expect(threads[2]).toMatchObject({ title: "Goal loop", state: "running" });
  });

  test("titles and thread IDs", () => {
    expect(threadTitle("  Fix it\nwith detail")).toBe("Fix it");
    expect(threadTitle("x".repeat(100))).toHaveLength(80);
    expect(parseThreadId("goal:abc")).toEqual({ kind: "goal", id: "abc" });
    expect(parseThreadId("loop:r:1")).toEqual({ kind: "loop", id: "r:1" });
    expect(parseThreadId("coordinator")).toBeNull();
    expect(parseThreadId(null)).toBeNull();
  });
});

describe("goal threads in the engine", () => {
  async function setup() {
    const f = await orchestration();
    open.push(f);
    return f;
  }

  test("starting a conversation creates its first goal once per command", async () => {
    const f = await setup();
    const commandId = cmd();
    const input = {
      projectId: "p",
      text: "Change the value to two\nand keep the API.",
      commandId,
    };
    const one = await f.orchestrator.startConversation(input);
    const two = await f.orchestrator.startConversation(input);
    expect(two.conversationId).toBe(one.conversationId);
    expect(two.goal!.id).toBe(one.goal!.id);
    expect(f.orchestrator.repo.all(kinds.goal, "p")).toHaveLength(1);
    const view = f.orchestrator.view("p", one.conversationId);
    expect(view.conversations).toHaveLength(1);
    expect(view.conversations[0]).toMatchObject({
      title: "Change the value to two",
    });
    expect(view.conversations[0].messages.map((m) => m.role)).toEqual(["user"]);
    await f.orchestrator.startConversation({
      projectId: "p",
      text: "Write the release notes",
      kind: "information",
      commandId: cmd(),
    });
    expect(f.orchestrator.view("p").conversations).toHaveLength(2);
    expect(f.orchestrator.view("p", one.conversationId).goals).toHaveLength(1);
  });

  test("a follow-up steers the thread's goal, then continues it after it ends", async () => {
    const f = await setup();
    const started = await f.orchestrator.startConversation({
      projectId: "p",
      text: "Change the value to two",
      checks: [
        {
          id: "check",
          label: "Unit tests",
          executable: "/usr/bin/true",
          args: [],
          timeoutMs: 1000,
        },
      ],
      commandId: cmd(),
    });
    const goalId = started.goal!.id;
    const steered = await f.orchestrator.post({
      conversationId: started.conversationId,
      text: "Make the label blue too.",
      routing: "follow-up",
      commandId: cmd(),
    });
    expect(steered.routing).toBe("update-goal");
    expect(f.orchestrator.repo.all(kinds.goal, "p")).toHaveLength(1);
    const goal = f.orchestrator.repo.require<Goal>(kinds.goal, goalId);
    expect(goal.constraints).toContain("Make the label blue too.");

    f.store.put(kinds.goal, { ...goal, state: "accepted" });
    const related = await f.orchestrator.post({
      conversationId: started.conversationId,
      text: "Now add a test for it.",
      routing: "follow-up",
      kind: "information",
      commandId: cmd(),
    });
    expect(related.routing).toBe("related-goal");
    expect(related.goal).toMatchObject({
      parentGoalId: goalId,
      conversationId: started.conversationId,
      kind: "code",
    });
    expect(related.goal!.checks).toHaveLength(1);
    // Pause and resume phrases do not act on a goal that has ended.
    const resumed = await f.orchestrator.post({
      conversationId: started.conversationId,
      text: "Resume",
      routing: "follow-up",
      goalId,
      commandId: cmd(),
    });
    expect(resumed.routing).not.toBe("control");
  });

  test("notes are recorded once per command", async () => {
    const f = await setup();
    const conversation = await f.orchestrator.createConversation({
      projectId: "p",
      title: "",
      commandId: cmd(),
    });
    const note = {
      conversationId: conversation.id,
      role: "service" as const,
      text: "Recorded.",
      routing: { kind: "loop-steer" as const, goalId: null },
      commandId: cmd(),
    };
    await f.orchestrator.note(note);
    await f.orchestrator.note(note);
    expect(f.orchestrator.view("p").conversations[0].messages).toHaveLength(1);
  });
});

describe("loop threads", () => {
  test("the owner's text and what it changed are recorded in the run's conversation", async () => {
    const t = await loopSetup();
    open.push(t);
    const created = await t.supervisor.create({
      projectId: "p",
      mode: "goal",
      text: "Make sync reliable and add the missing controls",
      commandId: cmd(),
    });
    const run = created.run;
    const steer = {
      runId: run.id,
      text: "Also ensure restart keeps the teams",
      commandId: cmd(),
    };
    await t.supervisor.message(steer);
    await t.supervisor.message(steer);
    const messages = t.orchestrator
      .view("p", run.conversationId)
      .conversations[0].messages.map((m) => [m.role, m.routing?.kind]);
    expect(messages).toEqual([
      ["user", "loop-steer"],
      ["user", "loop-steer"],
      ["service", "loop-steer"],
    ]);
    const listed = t.supervisor.list("p")[0];
    expect(listed).toMatchObject({
      conversationId: run.conversationId,
      started: false,
      waitReason: null,
    });
    const threads = summarizeThreads({
      projectId: "p",
      ...t.orchestrator.threadFacts("p"),
      runs: t.supervisor.list("p"),
    });
    // The loop's conversation has no ordinary goal, so it is one loop thread.
    expect(threads).toEqual([
      expect.objectContaining({
        threadId: `loop:${run.id}`,
        needsYou: "Review and start",
      }),
    ]);
  });
});
