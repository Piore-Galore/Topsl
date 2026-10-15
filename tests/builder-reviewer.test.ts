import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import {
  BuilderReviewerWorkflow,
  type WorkflowDispatch,
  type WorkflowDriver,
  type BuilderReviewerState,
} from "../packages/workflows/builder-reviewer";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import type {
  ExecutionAttempt,
  Workflow,
  Task,
} from "../packages/domain/workflow";
import type { Installation } from "../packages/domain/types";
import { now, uid } from "../packages/domain/invariants";
import {
  previewCheck,
  reuseCheckAuthorization,
  type CheckDefinition,
} from "../packages/workflows/verification";
import { findingDecisions } from "../packages/workflows/finding-decisions";
import { fixture } from "./helpers";
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup(
  options: {
    findings?: number;
    unknown?: boolean;
    mutateReview?: boolean;
    missingProof?: boolean;
    oversized?: boolean;
    checkPolicy?: CheckDefinition["executionPolicy"];
    changedRepair?: boolean;
  } = {},
) {
  const f = await fixture();
  fixtures.push(f);
  await writeFile(
    path.join(f.directory, "file.ts"),
    "export const value = 1;\n",
  );
  f.store.put("installation", {
    ...f.installation,
    id: "claude",
    appId: "anthropic.claude-code-cli",
  } satisfies Installation);
  const project = {
    id: "p",
    name: "workflow fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  const repository = new CoordinationRepository(f.store),
    results = new Map<string, string>();
  let calls = 0,
    reviews = 0;
  const driver: WorkflowDriver = {
    capabilities: () => ({
      supported: true,
      detail: "Deterministic local fixture only",
    }),
    result: (attempt) => results.get(attempt.id) ?? "",
    async dispatch(input: WorkflowDispatch) {
      calls++;
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
      if (options.unknown) throw new Error("Fixture reply lost after dispatch");
      repository.updateIntent(intent.id, "acknowledged", "fixture-native-turn");
      if (input.mode === "edit")
        await writeFile(
          path.join(f.directory, "file.ts"),
          options.oversized
            ? "x".repeat(1_000_001)
            : options.changedRepair && calls > 2
              ? "export const value = 2; // repaired bytes\n"
              : "export const value = 2;\n",
        );
      else {
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
            candidateRevision: input.context.candidateRevision,
            summary: findings.length
              ? "repair required"
              : "no substantiated findings",
            findings,
          }),
        );
        if (options.mutateReview) {
          await chmod(path.join(input.project.realPath, "file.ts"), 0o600);
          await writeFile(
            path.join(input.project.realPath, "file.ts"),
            "reviewer changed pinned bytes",
          );
        }
        if (options.missingProof)
          f.store.remove("review-snapshot-proof", attempt.id);
      }
      repository.updateIntent(intent.id, "verified", "fixture-native-turn");
      attempt = repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "completed",
        {
          reportedModel: "fixture-effective",
          modelEvidence: {
            level: "provider-ack",
            source: input.attempt.provider,
            observedAt: now(),
            detail: "Fixture effective model differs from request.",
          },
        },
      );
      const task = repository.require<Task>("task", input.task.id);
      repository.transitionTask(
        task.id,
        task.revision,
        "submitted",
        "Fixture provider turn complete",
      );
    },
  };
  const engine = new BuilderReviewerWorkflow(repository, driver);
  const create = (
    reverse = false,
    checksCode = 'const fs=require("fs"); if(!fs.readFileSync("file.ts","utf8").includes("value = 2"))process.exit(1)',
  ) =>
    engine.create(project, {
      objective: "change value to two",
      acceptanceCriteria: ["value equals two"],
      builder: {
        provider: reverse ? "claude" : "codex",
        installationId: reverse ? "claude" : f.installation.id,
        model: "fixture-requested",
      },
      reviewer: {
        provider: reverse ? "codex" : "claude",
        installationId: reverse ? f.installation.id : "claude",
        model: "fixture-requested-reviewer",
      },
      selectedPaths: ["file.ts"],
      checks: [
        {
          id: "value-check",
          label: "verify actual candidate value",
          executable: process.execPath,
          args: ["-e", checksCode],
          timeoutMs: 30_000,
          ...(options.checkPolicy
            ? { executionPolicy: options.checkPolicy }
            : {}),
        },
      ],
    });
  const advance = (id: string) =>
    engine.advance(id, repository.require<Workflow>("workflow", id).revision);
  const check = async (id: string) => {
    const plans = await engine.previewChecks(
      id,
      repository.require<Workflow>("workflow", id).revision,
    );
    return engine.runCheck(plans[0].id, plans[0].digest);
  };
  return {
    ...f,
    repository,
    driver,
    engine,
    create,
    advance,
    check,
    calls: () => calls,
  };
}
describe("provider-neutral builder reviewer lifecycle", () => {
  test("refresh invalidates accepted current workspace evidence while historical snapshots remain", async () => {
    const f = await setup(),
      state = await f.create();
    await f.advance(state.id);
    await f.advance(state.id);
    await f.advance(state.id);
    await f.check(state.id);
    await f.engine.accept(
      state.id,
      f.repository.require<Workflow>("workflow", state.id).revision,
      f.engine.acceptanceDigest(state.id),
    );
    await writeFile(
      path.join(f.directory, "file.ts"),
      "external editor changed the accepted source",
    );
    expect((await f.engine.observe(state.id)).stage).toBe("blocked");
    expect(
      f.repository.require<Workflow>("workflow", state.id).acceptance,
    ).toBeNull();
    expect(
      f.repository.all("candidate", { projectId: "p" }).length,
    ).toBeGreaterThan(1);
  });
  test.each([false, true])(
    "%s reversed provider assignment progresses to explicit acceptance",
    async (reverse) => {
      const f = await setup(),
        state = await f.create(reverse);
      expect((await f.advance(state.id)).stage).toBe("building");
      expect((await f.advance(state.id)).stage).toBe("reviewing");
      expect((await f.advance(state.id)).stage).toBe("checking");
      expect((await f.check(state.id)).stage).toBe("awaiting-acceptance");
      expect(f.repository.require<Workflow>("workflow", state.id).state).toBe(
        "awaiting-acceptance",
      );
      const accepted = await f.engine.accept(
        state.id,
        f.repository.require<Workflow>("workflow", state.id).revision,
        f.engine.acceptanceDigest(state.id),
      );
      expect(accepted.stage).toBe("accepted");
      const attempts = f.repository.all<ExecutionAttempt>("attempt", {
        projectId: "p",
      });
      expect(attempts.map((a) => a.provider)).toEqual(
        reverse ? ["claude", "codex"] : ["codex", "claude"],
      );
      expect(
        attempts.every(
          (a) =>
            a.contextPackageId &&
            a.inputManifest.contentManifestId &&
            a.reportedModel === "fixture-effective",
        ),
      ).toBe(true);
      expect(new Set(attempts.map((a) => a.sessionId)).size).toBe(2);
    },
  );
  test("one repair produces new evidence while superseded task lineage remains attributable", async () => {
    const f = await setup({ findings: 1, changedRepair: true }),
      state = await f.create();
    await f.advance(state.id);
    await f.advance(state.id);
    expect((await f.advance(state.id)).stage).toBe("ready-repair");
    expect((await f.advance(state.id)).stage).toBe("repairing");
    await f.advance(state.id);
    expect((await f.advance(state.id)).stage).toBe("checking");
    await f.check(state.id);
    const link = f.store.iterate<any>("task-supersession").next().value!;
    f.store.put("task-supersession", {
      ...link,
      candidateId: state.baselineId,
    });
    await expect(
      f.engine.accept(
        state.id,
        f.repository.require<Workflow>("workflow", state.id).revision,
        f.engine.acceptanceDigest(state.id),
      ),
    ).rejects.toThrow("verified replacement");
    f.store.put("task-supersession", link);
    expect(
      (
        await f.engine.accept(
          state.id,
          f.repository.require<Workflow>("workflow", state.id).revision,
          f.engine.acceptanceDigest(state.id),
        )
      ).stage,
    ).toBe("accepted");
    expect(
      f.repository
        .all<Task>("task", { projectId: "p" })
        .filter((t) => t.state === "cancelled"),
    ).toHaveLength(2);
    expect(f.store.iterate("task-supersession").next().value).toBeDefined();
    const predecessors = f.repository
      .all<Task>("task", { projectId: "p" })
      .filter((t) => t.state === "cancelled");
    const acceptedCandidate = f.store.get<any>(
      "candidate",
      f.store.get<BuilderReviewerState>("builder-reviewer", state.id)!
        .candidateId,
    )!;
    for (const task of predecessors) {
      const historical = f.store.get<any>("candidate", task.candidateId!)!;
      expect(historical.revision).not.toBe(acceptedCandidate.revision);
      expect(f.store.get<any>("task-supersession", task.id).candidateId).toBe(
        historical.id,
      );
    }
    expect(
      findingDecisions(f.store, "p", state.id).some(
        (decision) => decision.decision === "resolved",
      ),
    ).toBe(true);
    expect(
      f.repository.all<{ disposition: string }>("workflow-finding", {
        projectId: "p",
      })[0].disposition,
    ).toBe("open");
  });
  test("R2-AT-30: a bounded definition approved before repair binds the current tester and completes repaired workflow checks", async () => {
    const f = await setup({
        findings: 1,
        checkPolicy: { maximumUses: 2, allowCandidateChanges: true },
      }),
      initial = await f.create();
    const priorTester = f.repository.createTask({
      projectId: "p",
      workflowId: initial.id,
      workspaceId: initial.workspaceId,
      title: "Reviewed bounded test definition",
      role: "tester",
    });
    const baseline = f.store.get<any>("candidate", initial.baselineId)!,
      approved = await previewCheck(
        f.repository,
        initial.id,
        priorTester.id,
        baseline,
        initial.checks[0],
      );
    await f.advance(initial.id);
    await f.advance(initial.id);
    expect((await f.advance(initial.id)).stage).toBe("ready-repair");
    expect((await f.advance(initial.id)).stage).toBe("repairing");
    await f.advance(initial.id);
    const current = await f.advance(initial.id);
    expect(current.stage).toBe("checking");
    expect(current.checkTaskId).not.toBe(priorTester.id);
    const plan = await reuseCheckAuthorization(
      f.store,
      approved.authorizationId!,
      current.candidateId,
    );
    expect(plan.taskId).toBe(current.checkTaskId);
    expect(plan.candidateId).toBe(current.candidateId);
    expect((await f.engine.runCheck(plan.id, plan.digest)).stage).toBe(
      "awaiting-acceptance",
    );
    expect(
      f.repository
        .all<any>("verification", { projectId: "p" })
        .filter((v) => v.candidateId === current.candidateId)
        .every((v) => v.taskId === current.checkTaskId),
    ).toBe(true);
  });
  test("R2-AT-34/39: a user can reject an unsupported finding with a durable rationale before a repair", async () => {
    const f = await setup({ findings: 1 });
    const initial = await f.create();
    await f.advance(initial.id);
    await f.advance(initial.id);
    const reviewed = await f.advance(initial.id);
    expect(reviewed.stage).toBe("ready-repair");
    expect(f.calls()).toBe(2);
    const findingId = reviewed.findings[0];
    const original = f.store.get("workflow-finding", findingId);
    const input = {
      id: initial.id,
      expectedRevision: f.repository.require<Workflow>("workflow", initial.id)
        .revision,
      candidateId: reviewed.candidateId,
      findingId,
      decision: "rejected" as const,
      expectedDecisionId: null,
      rationale:
        "The protected check demonstrates that value two is the required behavior.",
    };
    expect(() => f.engine.decideFinding({ ...input, rationale: " " })).toThrow(
      "rationale",
    );
    expect(() =>
      f.engine.decideFinding({ ...input, candidateId: "other-candidate" }),
    ).toThrow("current");
    const checking = f.engine.decideFinding(input);
    expect(checking.stage).toBe("checking");
    expect(f.store.get("workflow-finding", findingId)).toEqual(original);
    expect(findingDecisions(f.store, "p", initial.id)[0]).toMatchObject({
      decision: "rejected",
      actor: "local-user",
      candidateId: reviewed.candidateId,
    });
    expect(f.calls()).toBe(2);
    expect(() => f.engine.decideFinding(input)).toThrow();
    await f.check(initial.id);
    const accepted = await f.engine.accept(
      initial.id,
      f.repository.require<Workflow>("workflow", initial.id).revision,
      f.engine.acceptanceDigest(initial.id),
    );
    expect(accepted.stage).toBe("accepted");
    expect(f.calls()).toBe(2);
  });
  test("repair loop is bounded at two and does not automatically dispatch a third", async () => {
    const f = await setup({ findings: 100 }),
      state = await f.create();
    let latest: BuilderReviewerState = state;
    for (let i = 0; i < 12 && latest.stage !== "blocked"; i++)
      latest = await f.advance(state.id);
    expect(latest.stage).toBe("blocked");
    expect(latest.repairRound).toBe(2);
    expect(f.calls()).toBe(6);
    await expect(f.advance(state.id)).rejects.toThrow("repair limit");
  });
  test("lost dispatch acknowledgment stays uncertain and blocks a second billable turn", async () => {
    const f = await setup({ unknown: true }),
      state = await f.create();
    expect((await f.advance(state.id)).stage).toBe("blocked");
    expect(
      f.repository.all<ExecutionAttempt>("attempt", { projectId: "p" })[0]
        .state,
    ).toBe("uncertain");
    expect(
      f.repository.all<{ state: string }>("operation-intent", {
        projectId: "p",
      })[0].state,
    ).toBe("unknown");
    await expect(f.advance(state.id)).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
  test.each([{ mutateReview: true }, { missingProof: true }])(
    "changed/missing reviewer snapshot proof cannot pass on another advance or restart",
    async (options) => {
      const f = await setup(options),
        state = await f.create();
      await f.advance(state.id);
      await f.advance(state.id);
      expect((await f.advance(state.id)).stage).toBe("blocked");
      await expect(f.advance(state.id)).rejects.toThrow("Review proof failed");
      const restarted = new BuilderReviewerWorkflow(f.repository, f.driver);
      await expect(
        restarted.advance(
          state.id,
          f.repository.require<Workflow>("workflow", state.id).revision,
        ),
      ).rejects.toThrow("Review proof failed");
      expect(f.calls()).toBe(2);
    },
  );
  test("failed actual check and source changes block acceptance", async () => {
    const f = await setup(),
      state = await f.create(false, "process.exit(1)");
    await f.advance(state.id);
    await f.advance(state.id);
    await f.advance(state.id);
    expect((await f.check(state.id)).stage).toBe("checking");
    await expect(
      f.engine.accept(
        state.id,
        f.repository.require<Workflow>("workflow", state.id).revision,
        f.engine.acceptanceDigest(state.id),
      ),
    ).rejects.toThrow("checks");
    const g = await setup(),
      successful = await g.create();
    await g.advance(successful.id);
    await g.advance(successful.id);
    await g.advance(successful.id);
    await g.check(successful.id);
    const digest = g.engine.acceptanceDigest(successful.id),
      revision = g.repository.require<Workflow>(
        "workflow",
        successful.id,
      ).revision;
    await writeFile(
      path.join(g.directory, "file.ts"),
      "external editor changed bytes",
    );
    await expect(
      g.engine.accept(successful.id, revision, digest),
    ).rejects.toThrow("stale");
  });
  test("large candidate without an installed reader blocks before a reviewer task/copy/turn is created", async () => {
    const f = await setup({ oversized: true }),
      state = await f.create();
    await f.advance(state.id);
    expect((await f.advance(state.id)).stage).toBe("blocked");
    expect(f.repository.all<Task>("task", { projectId: "p" })).toHaveLength(1);
    expect(f.calls()).toBe(1);
    await expect(f.advance(state.id)).rejects.toThrow("reader");
  });
  test("check runs on snapshot bytes and does not see extra live workspace files", async () => {
    const f = await setup(),
      state = await f.create(
        false,
        'const fs=require("fs");if(fs.existsSync("unapproved.txt"))process.exit(1)',
      );
    await writeFile(
      path.join(f.directory, "unapproved.txt"),
      "excluded live input",
    );
    await f.advance(state.id);
    await f.advance(state.id);
    await f.advance(state.id);
    expect((await f.check(state.id)).stage).toBe("awaiting-acceptance");
    expect(
      await readFile(path.join(f.directory, "unapproved.txt"), "utf8"),
    ).toBe("excluded live input");
  });
});
