/**
 * Campaign 2026-10-19 packet p5a-build-review-candidates (plan §5.15, §7 J-03).
 *
 * Engine-level Build and review contracts on the real encrypted store with a
 * deterministic, controllable provider driver: cancellation (BW-21), finding
 * decisions (BW-13), explicit acceptance (BW-20) and the four-pairing
 * findings → repair → check → acceptance journey (J-03, local stand-in).
 * Service-level cancellation, forged verification and acceptance-is-not-
 * publication evidence lives in campaign-build-review-service.test.ts.
 */
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  BuilderReviewerWorkflow,
  type BuilderReviewerState,
  type WorkflowDispatch,
  type WorkflowDriver,
  type WorkflowFinding,
} from "../packages/workflows/builder-reviewer";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import type {
  ExecutionAttempt,
  Task,
  Workflow,
} from "../packages/domain/workflow";
import type { Installation, Project } from "../packages/domain/types";
import { now } from "../packages/domain/invariants";
import { ContextServer } from "../packages/workspace/context";
import { commandSchema } from "../packages/domain/commands";
import { findingDecisions } from "../packages/workflows/finding-decisions";
import { fixture } from "./helpers";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const contexts: ContextServer[] = [];
afterEach(async () => {
  contexts.splice(0).forEach((context) => context.close());
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

type Mode = WorkflowDispatch["mode"];
interface Held {
  attemptId: string;
  intentId: string;
  taskId: string;
  mode: Mode;
  candidateRevision: string;
}

/**
 * A workflow engine whose driver records every dispatch and can hold a turn
 * open (the attempt stays running) until the test finishes it, as a provider
 * reply that arrives late would.
 */
async function setup(
  options: {
    /** Number of reviews that report one substantiated finding. */
    findings?: number;
    /** Dispatch modes whose turn stays running until finish() is called. */
    hold?: Mode[];
    checkCode?: string;
  } = {},
) {
  const f = await fixture();
  fixtures.push(f);
  const root = path.join(f.directory, "project");
  await mkdir(root);
  await writeFile(path.join(root, "file.ts"), "export const value = 1;\n");
  f.store.put("installation", {
    ...f.installation,
    id: "claude",
    appId: "anthropic.claude-code-cli",
  } satisfies Installation);
  const project: Project = {
    id: "p",
    name: "campaign workflow fixture",
    path: root,
    realPath: root,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  const repository = new CoordinationRepository(f.store),
    results = new Map<string, string>(),
    held: Held[] = [],
    dispatched: Array<{ attemptId: string; mode: Mode; provider: string }> = [];
  let reviews = 0,
    edits = 0;
  const interrupt = vi.fn(async (_attempt: ExecutionAttempt) => {});
  const finish = async (turn: Held) => {
    let attempt = repository.require<ExecutionAttempt>(
      "attempt",
      turn.attemptId,
    );
    if (turn.mode === "edit") {
      edits++;
      await writeFile(
        path.join(root, "file.ts"),
        edits > 1
          ? `export const value = 2; // repair ${edits}\n`
          : "export const value = 2;\n",
      );
    } else {
      const findings =
        reviews++ < (options.findings ?? 0)
          ? [
              {
                title: "fixture defect",
                severity: "medium",
                file: "file.ts",
                line: 1,
                behavior: "value is incorrect under the fixture condition",
                evidence: "repeatable local fixture evidence",
              },
            ]
          : [];
      results.set(
        attempt.id,
        JSON.stringify({
          candidateRevision: turn.candidateRevision,
          summary: findings.length
            ? "repair required"
            : "no substantiated findings",
          findings,
        }),
      );
    }
    repository.updateIntent(turn.intentId, "acknowledged", "fixture-turn");
    repository.updateIntent(turn.intentId, "verified", "fixture-turn");
    attempt = repository.transitionAttempt(
      attempt.id,
      attempt.revision,
      "completed",
      {
        reportedModel: "fixture-effective",
        modelEvidence: {
          level: "provider-ack",
          source: attempt.provider,
          observedAt: now(),
          detail: "Fixture effective model.",
        },
      },
    );
    const task = repository.require<Task>("task", turn.taskId);
    if (task.state === "active")
      repository.transitionTask(
        task.id,
        task.revision,
        "submitted",
        "Fixture provider turn complete",
      );
  };
  const driver: WorkflowDriver = {
    capabilities: () => ({
      supported: true,
      detail: "Deterministic local fixture only",
    }),
    result: (attempt) => results.get(attempt.id) ?? "",
    interrupt,
    async dispatch(input: WorkflowDispatch) {
      dispatched.push({
        attemptId: input.attempt.id,
        mode: input.mode,
        provider: input.attempt.provider,
      });
      let attempt = repository.transitionAttempt(
        input.attempt.id,
        input.attempt.revision,
        "starting",
      );
      const intent = repository.recordIntent(
        attempt.id,
        "turn",
        "fixture-input-digest",
      );
      repository.updateIntent(intent.id, "dispatch-recorded");
      attempt = repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "running",
        { operationIntentId: intent.id },
      );
      const turn: Held = {
        attemptId: attempt.id,
        intentId: intent.id,
        taskId: input.task.id,
        mode: input.mode,
        candidateRevision: input.context.candidateRevision,
      };
      if (options.hold?.includes(input.mode)) held.push(turn);
      else await finish(turn);
    },
  };
  const context = new ContextServer(f.store, f.directory);
  contexts.push(context);
  const engine = new BuilderReviewerWorkflow(repository, driver, context);
  const roles = {
    codex: {
      provider: "codex" as const,
      installationId: f.installation.id,
      model: "fixture-requested",
    },
    claude: {
      provider: "claude" as const,
      installationId: "claude",
      model: "fixture-requested-claude",
    },
  };
  const create = (
    builder: keyof typeof roles = "codex",
    reviewer: keyof typeof roles = "claude",
  ) =>
    engine.create(project, {
      objective: "change value to two",
      acceptanceCriteria: ["value equals two"],
      builder: roles[builder],
      reviewer: roles[reviewer],
      selectedPaths: ["file.ts"],
      checks: [
        {
          id: "value-check",
          label: "verify actual candidate value",
          executable: process.execPath,
          args: [
            "-e",
            options.checkCode ??
              'const fs=require("fs"); if(!fs.readFileSync("file.ts","utf8").includes("value = 2"))process.exit(1)',
          ],
          timeoutMs: 30_000,
        },
      ],
    });
  const revision = (id: string) =>
    repository.require<Workflow>("workflow", id).revision;
  const state = (id: string) =>
    repository.require<BuilderReviewerState>("builder-reviewer", id);
  const advance = (id: string) => engine.advance(id, revision(id));
  const check = async (id: string) => {
    const plans = await engine.previewChecks(id, revision(id));
    return engine.runCheck(plans[0].id, plans[0].digest);
  };
  /** Whether the context server still holds a live grant for the attempt. */
  const grantLive = (attemptId: string) => {
    const row = f.store.get<{ grantId: string }>(
      "attempt-context-grant",
      attemptId,
    );
    expect(row, "a reader grant row was recorded for the attempt").toBeTruthy();
    return (context as unknown as { grants: Map<string, unknown> }).grants.has(
      row!.grantId,
    );
  };
  return {
    ...f,
    root,
    project,
    repository,
    engine,
    driver,
    interrupt,
    held,
    dispatched,
    finish,
    create,
    revision,
    state,
    advance,
    check,
    grantLive,
  };
}

/** Runs a fresh workflow to awaiting-acceptance with no findings. */
async function toAwaitingAcceptance(f: Awaited<ReturnType<typeof setup>>) {
  const created = await f.create();
  await f.advance(created.id);
  await f.advance(created.id);
  expect((await f.advance(created.id)).stage).toBe("checking");
  expect((await f.check(created.id)).stage).toBe("awaiting-acceptance");
  return created.id;
}

/** Snapshot of the project folder: names, bytes and modification times. */
async function folderSnapshot(root: string) {
  const entries: Array<[string, string, number]> = [];
  for (const name of (await readdir(root)).sort()) {
    const file = path.join(root, name);
    entries.push([
      name,
      (await readFile(file)).toString("base64"),
      (await stat(file)).mtimeMs,
    ]);
  }
  return entries;
}

describe("BW-21 builder-reviewer cancellation (engine)", () => {
  test("BW-21: cancel before dispatch records cancelled and never dispatches a turn", async () => {
    const f = await setup(),
      created = await f.create();
    expect(created.stage).toBe("ready-build");
    // Stale revision is rejected and leaves the workflow runnable.
    await expect(
      f.engine.cancel(created.id, f.revision(created.id) - 1),
    ).rejects.toThrow("Workflow changed");
    expect(f.state(created.id).stage).toBe("ready-build");
    const cancelled = await f.engine.cancel(created.id, f.revision(created.id));
    expect(cancelled.stage).toBe("cancelled");
    expect(f.repository.require<Workflow>("workflow", created.id).state).toBe(
      "cancelled",
    );
    await expect(f.advance(created.id)).rejects.toThrow(
      "Late provider evidence remains attributed",
    );
    expect(f.dispatched).toEqual([]);
    expect(f.interrupt).not.toHaveBeenCalled();
  });

  test("BW-21: cancelling a running managed build interrupts it, revokes its reader grant, and its late result cannot advance or accept", async () => {
    const f = await setup({ hold: ["edit"] }),
      created = await f.create();
    const building = await f.advance(created.id);
    expect(building.stage).toBe("building");
    const attemptId = building.activeAttemptId!;
    expect(f.grantLive(attemptId)).toBe(true);
    // A stale workflow revision cannot cancel; the build and grant continue.
    await expect(
      f.engine.cancel(created.id, f.revision(created.id) - 1),
    ).rejects.toThrow("Workflow changed");
    expect(f.state(created.id).stage).toBe("building");
    expect(f.grantLive(attemptId)).toBe(true);
    expect(f.interrupt).not.toHaveBeenCalled();

    const cancelled = await f.engine.cancel(created.id, f.revision(created.id));
    expect(cancelled.stage).toBe("cancelled");
    expect(f.interrupt).toHaveBeenCalledTimes(1);
    expect(f.interrupt.mock.calls[0][0].id).toBe(attemptId);
    expect(f.grantLive(attemptId)).toBe(false);
    const candidatesBefore = f.repository.all("candidate", {
      projectId: "p",
    }).length;

    // The provider's reply arrives after the cancellation.
    await f.finish(f.held[0]);
    expect(
      f.repository.require<ExecutionAttempt>("attempt", attemptId).state,
    ).toBe("completed");
    await expect(f.advance(created.id)).rejects.toThrow(
      "it cannot accept this workflow",
    );
    expect(f.state(created.id).stage).toBe("cancelled");
    await expect(
      f.engine.accept(
        created.id,
        f.revision(created.id),
        f.engine.acceptanceDigest(created.id),
      ),
    ).rejects.toThrow("Acceptance is stale");
    const workflow = f.repository.require<Workflow>("workflow", created.id);
    expect(workflow.state).toBe("cancelled");
    expect(workflow.acceptance).toBeNull();
    // The late bytes were never captured as a reviewed candidate, and no
    // review turn was dispatched.
    expect(f.repository.all("candidate", { projectId: "p" })).toHaveLength(
      candidatesBefore,
    );
    expect(f.dispatched.map((d) => d.mode)).toEqual(["edit"]);
  });

  test("BW-21: cancelling a running managed review revokes the reviewer grant; a late clean review records no review and cannot reach checks", async () => {
    const f = await setup({ hold: ["review"] }),
      created = await f.create();
    await f.advance(created.id);
    const reviewing = await f.advance(created.id);
    expect(reviewing.stage).toBe("reviewing");
    const reviewerAttempt = reviewing.activeAttemptId!;
    expect(f.grantLive(reviewerAttempt)).toBe(true);
    await f.engine.cancel(created.id, f.revision(created.id));
    expect(f.grantLive(reviewerAttempt)).toBe(false);
    expect(f.interrupt.mock.calls.map(([a]) => a.id)).toEqual([
      reviewerAttempt,
    ]);
    await f.finish(f.held[0]);
    await expect(f.advance(created.id)).rejects.toThrow();
    const state = f.state(created.id);
    expect(state).toMatchObject({
      stage: "cancelled",
      reviewArtifactId: null,
      reviewedCandidateId: null,
      checkTaskId: null,
    });
    expect(f.repository.all("workflow-finding", { projectId: "p" })).toEqual(
      [],
    );
    await expect(
      f.engine.previewChecks(created.id, f.revision(created.id)),
    ).rejects.toThrow("Current reviewed candidate is required");
  });

  test("BW-21: cancelling while checks are pending makes the prepared check plan stale and records no verification", async () => {
    const f = await setup(),
      created = await f.create();
    await f.advance(created.id);
    await f.advance(created.id);
    expect((await f.advance(created.id)).stage).toBe("checking");
    const plans = await f.engine.previewChecks(
      created.id,
      f.revision(created.id),
    );
    await f.engine.cancel(created.id, f.revision(created.id));
    await expect(
      f.engine.runCheck(plans[0].id, plans[0].digest),
    ).rejects.toThrow("stale workflow candidate");
    expect(f.repository.all("verification", { projectId: "p" })).toEqual([]);
    expect(f.state(created.id).stage).toBe("cancelled");
  });

  test("BW-21: a failed managed interruption still records cancellation and surfaces the failure; the late result cannot accept", async () => {
    const f = await setup({ hold: ["edit"] }),
      created = await f.create();
    const building = await f.advance(created.id);
    f.interrupt.mockRejectedValueOnce(new Error("fixture interrupt failed"));
    await expect(
      f.engine.cancel(created.id, f.revision(created.id)),
    ).rejects.toThrow("fixture interrupt failed");
    expect(f.state(created.id).stage).toBe("cancelled");
    expect(f.repository.require<Workflow>("workflow", created.id).state).toBe(
      "cancelled",
    );
    // Cancellation alone does not prove the provider stopped: the attempt keeps
    // its own state until the provider reports.
    expect(
      f.repository.require<ExecutionAttempt>(
        "attempt",
        building.activeAttemptId!,
      ).state,
    ).toBe("running");
    await f.finish(f.held[0]);
    await expect(f.advance(created.id)).rejects.toThrow();
    await expect(
      f.engine.accept(
        created.id,
        f.revision(created.id),
        f.engine.acceptanceDigest(created.id),
      ),
    ).rejects.toThrow("Acceptance is stale");
  });

  test(
    "BW-21: a failed managed interruption still revokes the cancelled attempt's reader grant",
    async () => {
      const f = await setup({ hold: ["edit"] }),
        created = await f.create();
      const attemptId = (await f.advance(created.id)).activeAttemptId!;
      expect(f.grantLive(attemptId)).toBe(true);
      f.interrupt.mockRejectedValueOnce(new Error("fixture interrupt failed"));
      await f.engine
        .cancel(created.id, f.revision(created.id))
        .catch(() => undefined);
      expect(f.state(created.id).stage).toBe("cancelled");
      expect(f.grantLive(attemptId)).toBe(false);
    },
  );

  test("BW-21: an accepted workflow cannot be cancelled and keeps its acceptance", async () => {
    const f = await setup(),
      id = await toAwaitingAcceptance(f);
    await f.engine.accept(id, f.revision(id), f.engine.acceptanceDigest(id));
    const accepted = f.repository.require<Workflow>("workflow", id);
    await expect(f.engine.cancel(id, f.revision(id))).rejects.toThrow(
      "Invalid workflow transition: accepted → cancelled",
    );
    expect(f.repository.require<Workflow>("workflow", id)).toEqual(accepted);
    expect(f.state(id).stage).toBe("accepted");
  });
});

describe("BW-13 finding decisions (engine and command schema)", () => {
  const decisionsOf = (f: Awaited<ReturnType<typeof setup>>, id: string) =>
    findingDecisions(f.store, "p", id);

  test("BW-13: stale revision, blank or oversized rationale, unknown finding, wrong decision head and late decisions are refused without touching the review", async () => {
    const f = await setup({ findings: 1 }),
      created = await f.create();
    await f.advance(created.id);
    await f.advance(created.id);
    const reviewed = await f.advance(created.id);
    expect(reviewed.stage).toBe("ready-repair");
    const findingId = reviewed.findings[0];
    const original = f.store.get<WorkflowFinding>(
      "workflow-finding",
      findingId,
    );
    const base = () => ({
      id: created.id,
      expectedRevision: f.revision(created.id),
      candidateId: reviewed.candidateId,
      findingId,
      decision: "rejected" as const,
      expectedDecisionId: null as string | null,
      rationale: "The protected check shows value two is required.",
    });
    const refused: Array<[string, Partial<ReturnType<typeof base>>, string]> = [
      [
        "stale revision",
        { expectedRevision: f.revision(created.id) - 1 },
        "Workflow changed",
      ],
      ["blank rationale", { rationale: "   \n\t" }, "nonempty rationale"],
      ["empty rationale", { rationale: "" }, "nonempty rationale"],
      ["oversized rationale", { rationale: "r".repeat(20_001) }, "bounded"],
      [
        "unknown finding",
        { findingId: "not-a-finding" },
        "current, completed candidate review",
      ],
      [
        "foreign candidate",
        { candidateId: created.baselineId },
        "current, completed candidate review",
      ],
      [
        "invented decision head",
        { expectedDecisionId: "invented-head" },
        "Refresh before adjudicating",
      ],
    ];
    for (const [label, change, message] of refused) {
      expect(
        () => f.engine.decideFinding({ ...base(), ...change }),
        label,
      ).toThrow(message);
    }
    expect(decisionsOf(f, created.id)).toEqual([]);
    expect(f.store.get("workflow-finding", findingId)).toEqual(original);
    expect(f.state(created.id).stage).toBe("ready-repair");

    // Exactly 20,000 characters is the accepted upper bound (owner agrees the finding).
    const agreed = f.engine.decideFinding({
      ...base(),
      decision: "accepted",
      rationale: "a".repeat(20_000),
    });
    expect(agreed.stage).toBe("ready-repair");
    const head = decisionsOf(f, created.id)[0];
    expect(head).toMatchObject({ decision: "accepted", findingId });
    // A second decision must name the current head.
    expect(() => f.engine.decideFinding(base())).toThrow(
      "Refresh before adjudicating",
    );
    const rejected = f.engine.decideFinding({
      ...base(),
      expectedDecisionId: head.id,
    });
    expect(rejected.stage).toBe("checking");
    expect(decisionsOf(f, created.id).map((d) => d.decision)).toEqual([
      "accepted",
      "rejected",
    ]);
    expect(decisionsOf(f, created.id)[1].previousDecisionId).toBe(head.id);
    // Once checks began the review is no longer open for adjudication.
    expect(() =>
      f.engine.decideFinding({
        ...base(),
        decision: "accepted",
        expectedDecisionId: decisionsOf(f, created.id)[1].id,
      }),
    ).toThrow("current, completed candidate review");
    expect(f.store.get("workflow-finding", findingId)).toEqual(original);
    expect(f.dispatched).toHaveLength(2);
  });

  test("BW-13: a finding from a superseded review cannot be decided after the repaired candidate was reviewed", async () => {
    const f = await setup({ findings: 1 }),
      created = await f.create();
    await f.advance(created.id);
    await f.advance(created.id);
    const first = await f.advance(created.id);
    expect(first.stage).toBe("ready-repair");
    const oldFinding = first.findings[0];
    const original = f.store.get("workflow-finding", oldFinding);
    expect((await f.advance(created.id)).stage).toBe("repairing");
    await f.advance(created.id);
    const second = await f.advance(created.id);
    expect(second.stage).toBe("checking");
    expect(second.candidateId).not.toBe(first.candidateId);
    for (const candidateId of [first.candidateId, second.candidateId])
      expect(() =>
        f.engine.decideFinding({
          id: created.id,
          expectedRevision: f.revision(created.id),
          candidateId,
          findingId: oldFinding,
          decision: "rejected",
          expectedDecisionId: null,
          rationale: "Late rejection of a superseded review.",
        }),
      ).toThrow("current, completed candidate review");
    // The original finding remains; only the subsequent review resolved it.
    expect(f.store.get("workflow-finding", oldFinding)).toEqual(original);
    expect(
      decisionsOf(f, created.id).map((d) => [d.decision, d.actor]),
    ).toEqual([["resolved", "subsequent-review"]]);
  });

  test("BW-13: the public command schema refuses malformed finding decisions before the service", () => {
    const valid = {
      type: "workflow-finding-decide" as const,
      requestId: "r1",
      projectId: "p",
      id: "w",
      expectedRevision: 3,
      findingId: "finding",
      candidateId: "candidate",
      decision: "rejected",
      rationale: "Recorded reason.",
      expectedDecisionId: null,
    };
    expect(commandSchema.parse(valid)).toMatchObject({ decision: "rejected" });
    for (const change of [
      { decision: "resolved" },
      { decision: "maybe" },
      { rationale: "" },
      { rationale: "   " },
      { rationale: "x".repeat(20_001) },
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
      { expectedDecisionId: undefined },
      { findingId: "" },
    ])
      expect(
        () => commandSchema.parse({ ...valid, ...change }),
        JSON.stringify(change).slice(0, 60),
      ).toThrow();
  });
});

describe("BW-20 explicit final acceptance (engine)", () => {
  test("BW-20: only the current digest and revision accept, exactly once, and acceptance writes nothing to the project folder", async () => {
    const f = await setup(),
      created = await f.create();
    await f.advance(created.id);
    await f.advance(created.id);
    await f.advance(created.id);
    // A digest taken before the check ran is stale once the check passes.
    const early = f.engine.acceptanceDigest(created.id);
    await f.check(created.id);
    const id = created.id;
    await expect(f.engine.accept(id, f.revision(id), early)).rejects.toThrow(
      "Acceptance is stale",
    );
    await expect(
      f.engine.accept(id, f.revision(id) - 1, f.engine.acceptanceDigest(id)),
    ).rejects.toThrow("Workflow changed");
    await expect(
      f.engine.accept(id, f.revision(id), "0".repeat(64)),
    ).rejects.toThrow("Acceptance is stale");
    expect(
      f.repository.require<Workflow>("workflow", id).acceptance,
    ).toBeNull();

    const before = await folderSnapshot(f.root),
      revision = f.revision(id),
      digest = f.engine.acceptanceDigest(id),
      state = f.state(id),
      candidate = f.store.get<{ revision: string }>(
        "candidate",
        state.candidateId,
      )!;
    expect((await f.engine.accept(id, revision, digest)).stage).toBe(
      "accepted",
    );
    const workflow = f.repository.require<Workflow>("workflow", id);
    expect(workflow.acceptance).toMatchObject({
      by: "local-user",
      digest,
      targetRevision: candidate.revision,
    });
    // The accepted candidate is the reviewed and checked candidate.
    expect(f.state(id).reviewedCandidateId).toBe(state.candidateId);
    expect(
      f.repository
        .all<any>("verification", { projectId: "p" })
        .filter((v) => v.taskId === state.checkTaskId)
        .every((v) => v.candidateId === state.candidateId),
    ).toBe(true);
    // Repeat acceptance: the old revision is stale, and the fresh one is refused.
    await expect(f.engine.accept(id, revision, digest)).rejects.toThrow(
      "Workflow changed",
    );
    await expect(
      f.engine.accept(id, f.revision(id), f.engine.acceptanceDigest(id)),
    ).rejects.toThrow("Acceptance is stale");
    expect(f.repository.require<Workflow>("workflow", id)).toEqual(workflow);
    // Acceptance is a record: no file was written, added or touched.
    expect(await folderSnapshot(f.root)).toEqual(before);
    expect(f.dispatched).toHaveLength(2);
  });
});

describe("J-03 local stand-in: findings → repair → exact check → explicit acceptance", () => {
  test.each([
    ["codex", "codex"],
    ["codex", "claude"],
    ["claude", "codex"],
    ["claude", "claude"],
  ] as const)(
    "J-03: %s builds and %s reviews with one finding, one repair, a fresh review and an exact check before acceptance",
    async (builder, reviewer) => {
      const f = await setup({ findings: 1 }),
        created = await f.create(builder, reviewer);
      await f.advance(created.id);
      await f.advance(created.id);
      const first = await f.advance(created.id);
      expect(first.stage).toBe("ready-repair");
      const finding = f.store.get<WorkflowFinding>(
        "workflow-finding",
        first.findings[0],
      )!;
      expect(finding).toMatchObject({
        candidateId: first.candidateId,
        disposition: "open",
      });
      // Nothing is dispatched until the owner's next explicit action.
      expect(f.dispatched).toHaveLength(2);
      expect((await f.advance(created.id)).stage).toBe("repairing");
      await f.advance(created.id);
      const reviewed = await f.advance(created.id);
      expect(reviewed.stage).toBe("checking");
      // Acceptance before the check is refused.
      await expect(
        f.engine.accept(
          created.id,
          f.revision(created.id),
          f.engine.acceptanceDigest(created.id),
        ),
      ).rejects.toThrow("Acceptance is stale");
      expect((await f.check(created.id)).stage).toBe("awaiting-acceptance");
      const final = f.state(created.id);
      const digest = f.engine.acceptanceDigest(created.id);
      expect(
        (await f.engine.accept(created.id, f.revision(created.id), digest))
          .stage,
      ).toBe("accepted");
      // Route: builder, reviewer, repair builder, fresh reviewer.
      expect(f.dispatched.map((d) => [d.mode, d.provider])).toEqual([
        ["edit", builder],
        ["review", reviewer],
        ["edit", builder],
        ["review", reviewer],
      ]);
      const attempts = f.repository.all<ExecutionAttempt>("attempt", {
        projectId: "p",
      });
      expect(new Set(attempts.map((a) => a.sessionId)).size).toBe(4);
      const secondReview = attempts.find(
        (a) => a.id === f.dispatched[3].attemptId,
      )!;
      // The fresh review and the check bind the repaired candidate, which is the accepted one.
      expect(final.candidateId).not.toBe(first.candidateId);
      expect(final.reviewedCandidateId).toBe(final.candidateId);
      expect(secondReview.inputManifest.contentManifestId).toBe(
        final.candidateId,
      );
      const verifications = f.repository
        .all<any>("verification", { projectId: "p" })
        .filter((v) => v.taskId === final.checkTaskId);
      expect(verifications.length).toBeGreaterThan(0);
      expect(
        verifications.every(
          (v) => v.candidateId === final.candidateId && v.result === "passed",
        ),
      ).toBe(true);
      const accepted = f.repository.require<Workflow>("workflow", created.id);
      expect(accepted.acceptance?.targetRevision).toBe(
        f.store.get<{ revision: string }>("candidate", final.candidateId)!
          .revision,
      );
      // The original finding is preserved; resolution is a separate record.
      expect(f.store.get("workflow-finding", finding.id)).toEqual(finding);
      expect(
        findingDecisions(f.store, "p", created.id).map((d) => d.decision),
      ).toEqual(["resolved"]);
      // Acceptance left the repaired bytes in place and published nothing else.
      expect(await readdir(f.root)).toEqual(["file.ts"]);
      expect(await readFile(path.join(f.root, "file.ts"), "utf8")).toBe(
        "export const value = 2; // repair 2\n",
      );
    },
  );
});
