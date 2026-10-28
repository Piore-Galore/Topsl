import { afterEach, describe, expect, test } from "vitest";
import type { CoordinatorMessage, Goal } from "../packages/domain/role-groups";
import type { SessionIntake, TopslSession } from "../packages/domain/sessions";
import {
  buildSessionContext,
  CONTEXT_MESSAGES,
} from "../packages/domain/sessions";
import { parseThreadId, summarizeThreads } from "../packages/domain/threads";
import { commandSchema } from "../packages/domain/commands";
import { kinds } from "../packages/orchestration/repository";
import {
  decidePeers,
  effectiveIntent,
  parseSessionTurn,
} from "../packages/orchestration/session-contracts";
import { SessionSupervisor } from "../packages/orchestration/session-engine";
import type { MemberTurn } from "../packages/orchestration/engine";
import {
  defaultReply,
  orchestration,
  sessionReply,
} from "./orchestration-fixture";

/**
 * Native Topsl sessions (docs/Native_Sessions_Plan.md): intake by peer
 * coordinators, the one-at-a-time queue continuing from accepted results,
 * session-level team settings, controls, recovery and the legacy backfill.
 * Fixture stand-ins only: no result here is evidence for a live provider.
 */

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
let counter = 0;
const cmd = () => `sessions-cmd-${++counter}`;

async function setup() {
  const f = await orchestration();
  open.push(f);
  const sessions = new SessionSupervisor(f.store, f.orchestrator, f.driver);
  return { ...f, sessions };
}
type F = Awaited<ReturnType<typeof setup>>;

/** Ticks engine and sessions, settling scripted attempts, until `until` holds. */
async function run(f: F, until: () => boolean, steps = 120) {
  for (let i = 0; i < steps; i++) {
    await f.orchestrator.tick();
    await f.sessions.tick();
    if (until()) return true;
    f.driver.settle();
  }
  return until();
}
const session = (f: F, id: string) =>
  f.store.get<TopslSession>(kinds.session, id)!;
const intake = (f: F, id: string) =>
  f.store.get<SessionIntake>(kinds.intake, id)!;
const messages = (f: F, conversationId: string) =>
  [...f.store.iterate<CoordinatorMessage>(kinds.message)]
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.sequence - b.sequence);
const goal = (f: F, id: string) => f.store.get<Goal>(kinds.goal, id)!;
const decided = (f: F, id: string) => () =>
  ["decided", "failed", "awaiting-user"].includes(intake(f, id).stage);
const pins = {
  opus: {
    memberId: "coordinator-1",
    required: true,
    pin: { provider: "claude" as const, model: "claude-opus-fixture" },
    fallbacks: [],
    preferences: { providers: [], models: [] },
    source: {
      kind: "ui" as const,
      reference: null,
      provenance: "explicit" as const,
    },
  },
  astra: {
    memberId: "coordinator-2",
    required: true,
    pin: { provider: "codex" as const, model: "astra-fixture" },
    fallbacks: [],
    preferences: { providers: [], models: [] },
    source: {
      kind: "ui" as const,
      reference: null,
      provenance: "explicit" as const,
    },
  },
};

/** Drives the session's running goal to acceptance and accepts it. */
async function accept(f: F, sessionId: string) {
  await run(f, () => !!session(f, sessionId).activeWorkId);
  const s = session(f, sessionId);
  const goalId = s.queue.find((w) => w.id === s.activeWorkId)!.goalId!;
  expect(
    await run(f, () => goal(f, goalId).state === "awaiting-acceptance"),
  ).toBe(true);
  await f.orchestrator.accept({
    goalId,
    digest: f.orchestrator.acceptanceDigest(goalId),
    commandId: cmd(),
  });
  await run(f, () => !session(f, sessionId).activeWorkId);
  return goal(f, goalId);
}

describe("session-v1 decisions", () => {
  const answer = (
    memberId: string,
    order: number,
    intent: string,
    team: unknown = null,
  ) => ({
    memberId,
    order,
    value: {
      schemaVersion: 1 as const,
      protocolKind: "session-v1" as const,
      inputDigest: "d",
      intent: intent as "discuss",
      reply: `${memberId} says ${intent}`,
      question: null,
      team: team as null,
    },
  });

  test("the composer mode bounds what an answer can do", () => {
    expect(effectiveIntent("new-work", "discuss", false)).toBe("discuss");
    expect(effectiveIntent("status", "discuss", true)).toBe("status");
    expect(effectiveIntent("discuss", "work", true)).toBe("steer");
    expect(effectiveIntent("discuss", "work", false)).toBe("new-work");
    // Steering needs a running target; without one it is new work.
    expect(effectiveIntent("steer", "auto", false)).toBe("new-work");
  });

  test("agreement acts, clarify asks, disagreement reconciles once then goes to the owner", () => {
    const team = [
      {
        roleId: "implementer",
        title: null,
        instructions: null,
        purpose: null,
        count: 2,
        models: [],
        reason: "Two parts.",
      },
    ];
    const agree = decidePeers({
      answers: [
        answer("a", 0, "new-work"),
        answer("b", 1, "new-work", team),
        answer("c", 2, "new-work", team),
      ],
      mode: "auto",
      targetActive: false,
      reconciliationLeft: true,
    });
    // The largest group of identical proposals leads; order breaks ties only.
    expect(agree).toMatchObject({
      kind: "candidate",
      intent: "new-work",
      implied: ["b", "c"],
      endorsers: ["a"],
    });
    expect(
      decidePeers({
        answers: [answer("a", 0, "discuss"), answer("b", 1, "clarify")],
        mode: "auto",
        targetActive: false,
        reconciliationLeft: true,
      }),
    ).toMatchObject({ kind: "reply", intent: "clarify" });
    // Differing discussion views do not block.
    expect(
      decidePeers({
        answers: [answer("a", 0, "discuss"), answer("b", 1, "status")],
        mode: "auto",
        targetActive: true,
        reconciliationLeft: true,
      }),
    ).toMatchObject({ kind: "reply", intent: "discuss" });
    const split = [answer("a", 0, "new-work"), answer("b", 1, "discuss")];
    expect(
      decidePeers({
        answers: split,
        mode: "auto",
        targetActive: false,
        reconciliationLeft: true,
      }).kind,
    ).toBe("reconcile");
    const offered = decidePeers({
      answers: split,
      mode: "auto",
      targetActive: false,
      reconciliationLeft: false,
    });
    expect(offered.kind).toBe("alternatives");
    expect(
      offered.kind === "alternatives" &&
        offered.options.map((o) => o.memberIds),
    ).toEqual([["a"], ["b"]]);
  });

  test("an answer to another context is history, not a decision", () => {
    const text = JSON.stringify(answer("a", 0, "new-work").value);
    expect(parseSessionTurn(text, "intake", "d").ok).toBe(true);
    expect(parseSessionTurn(text, "intake", "other")).toMatchObject({
      ok: false,
      stale: true,
    });
    expect(
      parseSessionTurn(
        JSON.stringify({
          ...answer("a", 0, "x").value,
          protocolKind: "recursive-loop-v1",
        }),
        "intake",
        "d",
      ).ok,
    ).toBe(false);
  });

  test("session context is bounded and keeps references to older history", () => {
    const context = buildSessionContext({
      messages: Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        sequence: i + 1,
        role: "user" as const,
        text: "x".repeat(5000),
      })),
      decisions: [],
      work: [],
      checkpoint: null,
      status: null,
      team: [],
    });
    expect(context.messages).toHaveLength(CONTEXT_MESSAGES);
    expect(context.messages[0].text.length).toBeLessThanOrEqual(2000);
    expect(context.omitted).toEqual({
      fromSequence: 1,
      toSequence: 30 - CONTEXT_MESSAGES,
      count: 30 - CONTEXT_MESSAGES,
    });
  });
});

describe("native sessions", () => {
  test("discussion answers without creating a goal and is listed in navigation", async () => {
    const f = await setup();
    const created = await f.sessions.create({
      projectId: "p",
      text: "What does the parser do?",
      mode: "discuss",
      commandId: cmd(),
    });
    expect(await run(f, decided(f, created.intakeId!))).toBe(true);
    const done = intake(f, created.intakeId!);
    expect(done.outcome).toMatchObject({ kind: "reply", intent: "discuss" });
    expect(f.store.list(kinds.goal)).toHaveLength(0);
    const transcript = messages(f, created.sessionId);
    expect(transcript.map((m) => m.role)).toEqual(["user", "coordinator"]);
    expect(transcript[1].intakeId).toBe(done.id);
    const threads = summarizeThreads({
      projectId: "p",
      ...f.orchestrator.threadFacts("p"),
      runs: [],
      sessions: f.sessions.list("p"),
    });
    expect(threads).toMatchObject([
      {
        threadId: `session:${created.sessionId}`,
        kind: "session",
        state: "discussion",
      },
    ]);
  });

  test("an ambiguous message gets a clarifying question and starts nothing", async () => {
    const f = await setup();
    f.driver.reply = (turn: MemberTurn) =>
      turn.protocol.kind === "session-v1" && turn.protocol.stage === "intake"
        ? sessionReply(turn, {
            intent: "clarify",
            reply: "Which cache?",
            question: "Do you mean the HTTP cache or the build cache?",
          })
        : defaultReply(turn);
    const { sessionId, intakeId } = await f.sessions.create({
      projectId: "p",
      text: "Fix the cache",
      commandId: cmd(),
    });
    expect(await run(f, decided(f, intakeId!))).toBe(true);
    expect(intake(f, intakeId!).outcome).toMatchObject({
      kind: "reply",
      intent: "clarify",
    });
    expect(messages(f, sessionId).at(-1)?.text).toBe(
      "Do you mean the HTTP cache or the build cache?",
    );
    expect(session(f, sessionId).queue).toEqual([]);
  });

  test("a duplicate message command starts one intake", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      commandId: cmd(),
    });
    const id = cmd();
    const [a, b] = await Promise.all([
      f.sessions.message({ sessionId, text: "Hello", commandId: id }),
      f.sessions.message({ sessionId, text: "Hello", commandId: id }),
    ]);
    expect(a.intakeId).toBe(b.intakeId);
    expect(f.sessions.intakes(sessionId)).toHaveLength(1);
    expect(messages(f, sessionId)).toHaveLength(1);
  });

  test("new work runs one goal at a time and the second continues from the accepted result", async () => {
    const f = await setup();
    const { sessionId, intakeId } = await f.sessions.create({
      projectId: "p",
      text: "Build the parser",
      commandId: cmd(),
    });
    expect(await run(f, () => !!session(f, sessionId).activeWorkId)).toBe(true);
    expect(intake(f, intakeId!).outcome).toMatchObject({
      kind: "act",
      intent: "new-work",
    });
    // A second request while the first goal runs waits in the queue.
    await f.sessions.message({
      sessionId,
      text: "Build the printer",
      mode: "work",
      commandId: cmd(),
    });
    await run(f, () => session(f, sessionId).queue.length === 2, 40);
    const first = session(f, sessionId).queue[0];
    expect(session(f, sessionId).queue.map((w) => w.state)).toEqual([
      "running",
      "queued",
    ]);
    expect(goal(f, first.goalId!).session).toEqual({
      workItemId: first.id,
      continued: false,
    });
    const accepted = await accept(f, sessionId);
    expect(session(f, sessionId).acceptedCheckpoint).toMatchObject({
      candidateId: accepted.candidateId,
      goalId: accepted.id,
    });
    expect(
      await run(f, () => session(f, sessionId).queue[1].state === "running"),
    ).toBe(true);
    const second = goal(f, session(f, sessionId).queue[1].goalId!);
    // It starts from the accepted result, not applied to the folder.
    expect(second.baselineCandidateId).toBe(
      `continued-${accepted.candidateId}`,
    );
    expect(second.session?.continued).toBe(true);
    expect(f.driver.applied).toEqual([]);
    await run(f, () => f.driver.launches.some((t) => t.goalId === second.id));
    const coordination = f.driver.launches.find((t) => t.goalId === second.id)!;
    expect(coordination.contextCandidateId).toBe(second.baselineCandidateId);
  });

  test("a stopped goal contributes nothing to the accepted result", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      text: "Build A",
      commandId: cmd(),
    });
    const accepted = await accept(f, sessionId);
    await f.sessions.message({ sessionId, text: "Build B", commandId: cmd() });
    await run(f, () => !!session(f, sessionId).activeWorkId);
    const goalId = session(f, sessionId).queue[1].goalId!;
    await f.orchestrator.controlCommand({
      projectId: "p",
      goalId,
      action: "stop",
      commandId: cmd(),
    });
    await run(f, () => session(f, sessionId).queue[1].state === "stopped");
    expect(session(f, sessionId).acceptedCheckpoint?.candidateId).toBe(
      accepted.candidateId,
    );
  });

  test("peer coordinators on two providers each answer, and the first prepares the shared wording", async () => {
    const f = await setup();
    const { sessionId, intakeId } = await f.sessions.create({
      projectId: "p",
      configuration: { coordinators: [pins.opus, pins.astra] },
      text: "Build it",
      commandId: cmd(),
    });
    expect(await run(f, decided(f, intakeId!))).toBe(true);
    const done = intake(f, intakeId!);
    expect(done.members.map((m) => [m.memberId, m.provider, m.model])).toEqual([
      ["coordinator-1", "claude", "claude-opus-fixture"],
      ["coordinator-2", "codex", "astra-fixture"],
    ]);
    expect(done.outcome).toMatchObject({
      kind: "act",
      intent: "new-work",
      endorsedBy: ["coordinator-1", "coordinator-2"],
    });
    const reply = messages(f, sessionId).find((m) => m.role === "coordinator")!;
    expect(reply.text).toBe("Shared answer from coordinator-1.");
    // Each contribution stays attributed.
    expect(
      done.members.every((m) =>
        m.contributions.some((c) => c.phase === "initial" && c.valid),
      ),
    ).toBe(true);
  });

  test("conflicting coordinators reconcile once, then the owner chooses", async () => {
    const f = await setup();
    f.driver.reply = (turn: MemberTurn) =>
      turn.protocol.kind === "session-v1" && turn.protocol.stage === "intake"
        ? sessionReply(turn, {
            intent: turn.memberId === "coordinator-1" ? "new-work" : "discuss",
          })
        : defaultReply(turn);
    const { sessionId, intakeId } = await f.sessions.create({
      projectId: "p",
      configuration: { coordinators: [pins.opus, pins.astra] },
      text: "Maybe rework the cache",
      commandId: cmd(),
    });
    expect(await run(f, decided(f, intakeId!))).toBe(true);
    const waiting = intake(f, intakeId!);
    expect(waiting.stage).toBe("awaiting-user");
    expect(waiting.reconciliationUsed).toBe(1);
    expect(
      waiting.members.every((m) =>
        m.contributions.some((c) => c.phase === "reconciliation"),
      ),
    ).toBe(true);
    expect(session(f, sessionId).attention?.kind).toBe("choose-alternative");
    const outcome = waiting.outcome;
    const options = outcome?.kind === "alternatives" ? outcome.options : [];
    const work = options.findIndex((o) => o.intent === "new-work");
    await f.sessions.choose({
      sessionId,
      intakeId: intakeId!,
      option: work,
      commandId: cmd(),
    });
    expect(session(f, sessionId).attention).toBeNull();
    expect(await run(f, () => !!session(f, sessionId).activeWorkId)).toBe(true);
  });

  test("a challenged decision is reconciled before it acts", async () => {
    const f = await setup();
    const team = [
      {
        roleId: "implementer",
        title: null,
        instructions: null,
        purpose: null,
        count: 2,
        models: [],
        reason: "Two parts.",
      },
    ];
    f.driver.reply = (turn: MemberTurn) => {
      if (
        turn.protocol.kind === "session-v1" &&
        turn.protocol.stage === "intake"
      )
        return sessionReply(turn, {
          intent: "new-work",
          team: turn.memberId === "coordinator-1" ? team : null,
        });
      if (turn.purpose === "coordinator-endorsement") {
        const digest = /Candidate digest \(echo it exactly\): (\S+)/.exec(
          turn.prompt,
        )![1];
        return {
          text: JSON.stringify({
            candidateDigest: digest,
            stance: "challenge",
            rationale: "One implementer is enough.",
          }),
        };
      }
      return defaultReply(turn);
    };
    const { intakeId } = await f.sessions.create({
      projectId: "p",
      configuration: { coordinators: [pins.opus, pins.astra] },
      text: "Build two parsers",
      commandId: cmd(),
    });
    expect(await run(f, decided(f, intakeId!))).toBe(true);
    const done = intake(f, intakeId!);
    expect(done.reconciliationUsed).toBe(1);
    expect(done.stage).toBe("awaiting-user");
    expect(f.store.list(kinds.goal)).toHaveLength(0);
  });

  test("an automatic team assigns provider-qualified models and creates a session role", async () => {
    const f = await setup();
    f.driver.reply = (turn: MemberTurn) =>
      turn.protocol.kind === "session-v1" && turn.protocol.stage === "intake"
        ? sessionReply(turn, {
            intent: "new-work",
            team: [
              {
                roleId: "implementer",
                title: null,
                instructions: null,
                purpose: null,
                count: null,
                models: [{ provider: "codex", model: "sol-fixture" }],
                reason: "Sol fits small changes.",
              },
              {
                roleId: "docs-writer",
                title: "Docs writer",
                instructions: "Write the user guide.",
                purpose: "information",
                count: 1,
                models: [],
                reason: "The change needs docs.",
              },
              {
                roleId: "tester",
                title: null,
                instructions: null,
                purpose: null,
                count: null,
                models: [{ provider: "claude", model: "astra-fixture" }],
                reason: "Wrong provider.",
              },
            ],
          })
        : defaultReply(turn);
    const a = await f.sessions.create({
      projectId: "p",
      text: "Build the guide",
      commandId: cmd(),
    });
    const b = await f.sessions.create({ projectId: "p", commandId: cmd() });
    expect(await run(f, decided(f, a.intakeId!))).toBe(true);
    const s = session(f, a.sessionId);
    expect(s.automatic.activeRoles).toEqual([
      "implementer",
      "docs-writer",
      "tester",
    ]);
    // A model reference keeps its provider: Astra is not a Claude model.
    expect(s.automatic.rejections.join(" ")).toMatch(
      /claude:astra-fixture is not an observed, qualified model/,
    );
    const group = f.orchestrator.effective("p", null, "implementer", null, {
      scopeId: "x",
      conversationId: a.sessionId,
    });
    expect(group.members.map((m) => m.preferences)).toEqual([
      { providers: ["codex"], models: ["sol-fixture"] },
    ]);
    const role = f.orchestrator.repo.role("p", "docs-writer");
    expect(role.ownerConversationId).toBe(a.sessionId);
    expect(
      f.orchestrator.repo
        .visibleRoles("p", b.sessionId)
        .some((r) => r.id === "docs-writer"),
    ).toBe(false);
    // Session isolation: the other session's team is untouched.
    const other = f.orchestrator.effective("p", null, "implementer", null, {
      scopeId: "y",
      conversationId: b.sessionId,
    });
    expect(other.members).toEqual([]);
    const view = f.sessions.query(a.sessionId);
    expect(
      view.roles.find((r) => r.role.id === "implementer")?.explanation,
    ).toBe("Sol fits small changes.");
  });

  test("owner settings stay authoritative over automatic choices, and saving a role makes it a project default", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      configuration: { roles: { implementer: { settings: { count: 3 } } } },
      commandId: cmd(),
    });
    const s = session(f, sessionId);
    f.store.save(kinds.session, {
      ...s,
      automatic: {
        ...s.automatic,
        roles: { implementer: { settings: { count: 1 }, reason: "r" } },
      },
    });
    const group = f.orchestrator.effective("p", null, "implementer", null, {
      scopeId: "x",
      conversationId: sessionId,
    });
    expect(group.count).toBe(3);
    expect(group.ignoredAutomatic).toContain("count");
    await f.sessions.saveRole({
      sessionId,
      roleId: "implementer",
      commandId: cmd(),
    });
    expect(f.orchestrator.effective("p", null, "implementer").count).toBe(3);
  });

  test("a session keeps the project defaults it captured; a legacy conversation follows the project", async () => {
    const f = await setup();
    const legacy = await f.orchestrator.startConversation({
      projectId: "p",
      text: "Old goal",
      commandId: cmd(),
    });
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      commandId: cmd(),
    });
    f.sessions.backfill();
    await f.orchestrator.setGroup({
      projectId: "p",
      goalId: null,
      level: "project-role",
      taskKey: null,
      roleId: "reviewer",
      settings: { count: 2 },
      mode: "replace",
      commandId: cmd(),
    });
    const native = f.orchestrator.effective("p", null, "reviewer", null, {
      scopeId: "x",
      conversationId: sessionId,
    });
    const old = f.orchestrator.effective("p", null, "reviewer", null, {
      scopeId: "y",
      conversationId: legacy.conversationId,
    });
    expect(native.count).not.toBe(2);
    expect(old.count).toBe(2);
  });

  test("an unavailable pinned coordinator needs the owner; an explicit fallback is used", async () => {
    const f = await setup();
    const missing = {
      ...pins.opus,
      pin: { provider: "claude" as const, model: "claude-missing" },
    };
    const blocked = await f.sessions.create({
      projectId: "p",
      configuration: { coordinators: [missing] },
      text: "Hello",
      commandId: cmd(),
    });
    expect(intake(f, blocked.intakeId!).stage).toBe("failed");
    expect(session(f, blocked.sessionId).attention?.kind).toBe("choose-model");
    expect(f.driver.launches).toHaveLength(0);
    const fallback = await f.sessions.create({
      projectId: "p",
      configuration: {
        coordinators: [
          {
            ...missing,
            fallbacks: [{ provider: "codex", model: "astra-fixture" }],
          },
        ],
      },
      text: "Hello",
      commandId: cmd(),
    });
    expect(await run(f, decided(f, fallback.intakeId!))).toBe(true);
    expect(intake(f, fallback.intakeId!).members[0].model).toBe(
      "astra-fixture",
    );
  });

  test("a custom team without the roles code work needs asks for configuration, then runs", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      configuration: {
        team: "custom",
        roles: { researcher: { settings: {} } },
      },
      text: "Build the parser",
      commandId: cmd(),
    });
    await run(
      f,
      () => session(f, sessionId).queue[0]?.state === "waiting-configuration",
    );
    expect(session(f, sessionId).attention?.kind).toBe("configure-team");
    const s = session(f, sessionId);
    await f.sessions.update({
      sessionId,
      expectedRevision: s.revision,
      configuration: {
        roles: {
          researcher: { settings: {} },
          implementer: { settings: {} },
          reviewer: { settings: {} },
        },
      },
      commandId: cmd(),
    });
    expect(
      await run(f, () => session(f, sessionId).queue[0].state === "running"),
    ).toBe(true);
    expect(
      goal(f, session(f, sessionId).queue[0].goalId!).functions,
    ).toMatchObject({ implementation: "implementer", review: "reviewer" });
  });

  test("a command that changes one field keeps the others", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      configuration: {
        coordinators: [pins.opus, pins.astra],
        composerMode: "work",
      },
      commandId: cmd(),
    });
    const command = commandSchema.parse({
      type: "session-update",
      sessionId,
      expectedRevision: session(f, sessionId).revision,
      configuration: { roles: { reviewer: { settings: {} } } },
      commandId: cmd(),
    });
    if (command.type !== "session-update") throw new Error("unexpected");
    expect(command.configuration).toEqual({
      roles: { reviewer: { settings: {} } },
    });
    await f.sessions.update(command);
    const s = session(f, sessionId);
    expect(s.configuration.coordinators.map((c) => c.pin?.model)).toEqual([
      "claude-opus-fixture",
      "astra-fixture",
    ]);
    expect(s.configuration.composerMode).toBe("work");
    expect(Object.keys(s.configuration.roles)).toEqual(["reviewer"]);
  });

  test("configuration changes wait for the running round's boundary", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      text: "Build it",
      commandId: cmd(),
    });
    await run(f, () => !!session(f, sessionId).activeWorkId);
    const goalId = session(f, sessionId).queue[0].goalId!;
    await run(
      f,
      () => f.orchestrator.rounds(goalId).some((r) => r.stage === "collecting"),
      10,
    );
    const before = session(f, sessionId);
    await f.sessions.update({
      sessionId,
      expectedRevision: before.revision,
      configuration: { roles: { reviewer: { settings: { count: 2 } } } },
      commandId: cmd(),
    });
    expect(session(f, sessionId).pending).not.toBeNull();
    expect(session(f, sessionId).revision).toBe(before.revision);
    expect(await run(f, () => !session(f, sessionId).pending)).toBe(true);
    expect(session(f, sessionId).revision).toBe(before.revision + 1);
  });

  test("steering in Work mode reaches the running goal; stopping the session cancels queued work", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      text: "Build it",
      commandId: cmd(),
    });
    await run(f, () => !!session(f, sessionId).activeWorkId);
    const goalId = session(f, sessionId).queue[0].goalId!;
    const revision = goal(f, goalId).revision;
    const steer = await f.sessions.message({
      sessionId,
      text: "Keep the API",
      mode: "work",
      target: "current",
      commandId: cmd(),
    });
    expect(await run(f, decided(f, steer.intakeId), 20)).toBe(true);
    expect(intake(f, steer.intakeId).outcome).toMatchObject({
      kind: "act",
      intent: "steer",
      goalId,
    });
    expect(goal(f, goalId).revision).toBeGreaterThan(revision);
    const queued = await f.sessions.message({
      sessionId,
      text: "Build more",
      mode: "work",
      commandId: cmd(),
    });
    await run(f, decided(f, queued.intakeId), 20);
    await f.sessions.control({ sessionId, action: "stop", commandId: cmd() });
    await run(f, () => goal(f, goalId).state === "stopped", 20);
    await run(f, () => !session(f, sessionId).activeWorkId, 5);
    expect(session(f, sessionId).queue.map((w) => w.state)).toEqual([
      "stopped",
      "cancelled",
    ]);
    expect(session(f, sessionId).acceptedCheckpoint).toBeNull();
  });

  test("pause holds the queue and the goal; resume continues", async () => {
    const f = await setup();
    const { sessionId } = await f.sessions.create({
      projectId: "p",
      text: "Build it",
      commandId: cmd(),
    });
    await run(f, () => !!session(f, sessionId).activeWorkId);
    const goalId = session(f, sessionId).queue[0].goalId!;
    await f.sessions.control({ sessionId, action: "pause", commandId: cmd() });
    expect(goal(f, goalId).state).toBe("paused");
    const later = await f.sessions.message({
      sessionId,
      text: "Hello",
      commandId: cmd(),
    });
    // An intake frozen while paused still answers; acting waits for resume.
    await run(f, decided(f, later.intakeId), 20);
    await f.sessions.control({ sessionId, action: "resume", commandId: cmd() });
    expect(goal(f, goalId).state).not.toBe("paused");
  });

  test("a restart adopts recorded launches instead of starting them again", async () => {
    const f = await setup();
    f.driver.crashAfterRecord = true;
    const { intakeId } = await f.sessions.create({
      projectId: "p",
      text: "Hello",
      commandId: cmd(),
    });
    void f.sessions.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.driver.launches).toHaveLength(1);
    const reopened = new SessionSupervisor(f.store, f.reopen(), f.driver);
    await reopened.recover();
    expect(intake(f, intakeId!).members[0].state).toBe("running");
    f.driver.settle();
    await reopened.tick();
    expect(intake(f, intakeId!).stage).toBe("decided");
    expect(f.driver.launches).toHaveLength(1);
  });

  test("legacy conversations are backfilled without rewriting history, and their thread IDs resolve", async () => {
    const f = await setup();
    const legacy = await f.orchestrator.startConversation({
      projectId: "p",
      text: "Old goal",
      commandId: cmd(),
    });
    const before = messages(f, legacy.conversationId).map((m) =>
      JSON.stringify(m),
    );
    expect(f.sessions.backfill()).toBe(1);
    expect(f.sessions.backfill()).toBe(0);
    const s = session(f, legacy.conversationId);
    expect(s).toMatchObject({ origin: "legacy", inherited: null });
    expect(s.queue).toMatchObject([
      { goalId: legacy.goal!.id, origin: "legacy", state: "running" },
    ]);
    expect(
      messages(f, legacy.conversationId).map((m) => JSON.stringify(m)),
    ).toEqual(before);
    expect(f.sessions.resolveThread(`goal:${legacy.conversationId}`)).toEqual({
      threadId: `session:${legacy.conversationId}`,
      sessionId: legacy.conversationId,
      workItemId: null,
    });
    expect(parseThreadId(`goal:${legacy.conversationId}`)).toEqual({
      kind: "session",
      id: legacy.conversationId,
    });
    // New work in a legacy session waits behind its running legacy goal.
    await f.sessions.message({
      sessionId: legacy.conversationId,
      text: "Build more",
      mode: "work",
      commandId: cmd(),
    });
    await run(
      f,
      () => session(f, legacy.conversationId).queue.length === 2,
      30,
    );
    expect(session(f, legacy.conversationId).queue[1].state).toBe("queued");
  });
});
