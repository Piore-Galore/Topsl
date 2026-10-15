import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { fixture, gitExecutable } from "./helpers";
import { now } from "../packages/domain/invariants";
import { runFile } from "../packages/platform/system";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import {
  BuilderReviewerWorkflow,
  type BuilderReviewerState,
  type WorkflowDriver,
} from "../packages/workflows/builder-reviewer";
import {
  applyCandidateReview,
  previewCandidateReview,
} from "../packages/workflows/candidate-reviews";
import {
  candidateFileBytes,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import type { Task, Verification, Workflow } from "../packages/domain/workflow";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup(initialUntracked = false) {
  const f = await fixture();
  fixtures.push(f);
  const root = path.join(f.directory, "repository");
  await mkdir(root);
  await writeFile(path.join(root, "main.ts"), "export const value = 1;\n");
  if (initialUntracked)
    await writeFile(path.join(root, "output.txt"), "captured output bytes");
  const git = gitExecutable;
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "fixture@example.invalid"],
    ["config", "user.name", "Fixture"],
    ["add", "main.ts"],
    ["commit", "-qm", "fixture"],
  ])
    await runFile(git, args, { cwd: root });
  const project = {
    id: "p",
    name: "fixture",
    path: root,
    realPath: root,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  f.store.put("installation", {
    ...f.installation,
    id: "claude",
    appId: "anthropic.claude-code-cli",
  });
  const repository = new CoordinationRepository(f.store),
    results = new Map<string, string>();
  let calls = 0;
  const driver: WorkflowDriver = {
    capabilities: () => ({
      supported: true,
      detail: "Controlled fixture only",
    }),
    result: (attempt) => results.get(attempt.id) ?? "",
    dispatch: async (input) => {
      calls++;
      let attempt = repository.transitionAttempt(
        input.attempt.id,
        input.attempt.revision,
        "starting",
      );
      const intent = repository.recordIntent(attempt.id, "turn", "fixture");
      repository.updateIntent(intent.id, "dispatch-recorded");
      attempt = repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "running",
        { operationIntentId: intent.id },
      );
      if (input.mode === "edit") {
        await writeFile(
          path.join(root, "main.ts"),
          "export const value = 2;\n",
        );
        if (!initialUntracked)
          await writeFile(
            path.join(root, "output.txt"),
            "captured output bytes",
          );
      } else
        results.set(
          attempt.id,
          JSON.stringify({
            candidateRevision: input.context.candidateRevision,
            summary: "no fixture findings",
            findings: [],
          }),
        );
      repository.updateIntent(intent.id, "acknowledged", "fixture-turn");
      repository.updateIntent(intent.id, "verified", "fixture-turn");
      repository.transitionAttempt(attempt.id, attempt.revision, "completed");
      const task = repository.require<Task>("task", input.task.id);
      repository.transitionTask(
        task.id,
        task.revision,
        "submitted",
        "Fixture stopped",
      );
    },
  };
  const engine = new BuilderReviewerWorkflow(repository, driver),
    state = await engine.create(project, {
      objective: "change value",
      acceptanceCriteria: ["value is two"],
      builder: {
        provider: "codex",
        installationId: f.installation.id,
        model: "fixture",
      },
      reviewer: {
        provider: "claude",
        installationId: "claude",
        model: "fixture",
      },
      selectedPaths: ["main.ts"],
      checks: [
        {
          id: "check",
          label: "check pinned source",
          executable: process.execPath,
          args: [
            "-e",
            'if(!require("fs").readFileSync("main.ts","utf8").includes("value = 2"))process.exit(1)',
          ],
          timeoutMs: 30_000,
        },
      ],
    });
  const revision = () =>
      repository.require<Workflow>("workflow", state.id).revision,
    advance = () => engine.advance(state.id, revision()),
    current = () =>
      repository.require<BuilderReviewerState>("builder-reviewer", state.id),
    candidate = () =>
      repository.require<CandidateSnapshot>("candidate", current().candidateId);
  const capturePlan = () =>
    previewCandidateReview(f.store, {
      projectId: "p",
      candidateId: candidate().id,
      outputs: [],
      binaries: [],
      capturePaths: [
        {
          path: "output.txt",
          hash: candidate().outputs!.find(
            (output) => output.path === "output.txt",
          )!.hash!,
        },
      ],
    });
  const check = async () => {
    const [plan] = await engine.previewChecks(state.id, revision());
    return engine.runCheck(plan.id, plan.digest);
  };
  return {
    ...f,
    root,
    repository,
    engine,
    state,
    revision,
    advance,
    current,
    candidate,
    capturePlan,
    check,
    calls: () => calls,
  };
}

test("R2-AT-23 unexpected output recapture is exact, single-use and requires a separate resulting-manifest review", async () => {
  const f = await setup();
  await f.advance();
  expect((await f.advance()).stage).toBe("ready-review");
  expect(f.calls()).toBe(1);
  const prior = f.candidate();
  expect(prior.files.some((file) => file.path === "output.txt")).toBe(false);
  const plan = await f.capturePlan();
  const captured = await f.engine.captureReviewedOutputs(
    f.state.id,
    f.revision(),
    plan.id,
    plan.digest,
  );
  expect(captured.stage).toBe("ready-review");
  expect(f.calls()).toBe(1);
  expect(f.candidate().id).not.toBe(prior.id);
  expect(candidateFileBytes(f.candidate(), "output.txt")?.toString()).toBe(
    "captured output bytes",
  );
  expect(f.store.get("candidate", prior.id)).toBeTruthy();
  await expect(
    f.engine.captureReviewedOutputs(
      f.state.id,
      f.revision(),
      plan.id,
      plan.digest,
    ),
  ).rejects.toThrow(/current|consumed/);
  expect((await f.advance()).stage).toBe("ready-review");
  expect(f.calls()).toBe(1);
  const output = f
    .candidate()
    .outputs!.find((output) => output.path === "output.txt")!;
  const review = await previewCandidateReview(f.store, {
    projectId: "p",
    candidateId: f.candidate().id,
    outputs: [{ path: output.path, hash: output.hash!, decision: "approved" }],
    binaries: [],
  });
  await applyCandidateReview(f.store, "p", review.id, review.digest);
  expect((await f.advance()).stage).toBe("reviewing");
  expect((await f.advance()).stage).toBe("checking");
  expect((await f.check()).stage).toBe("awaiting-acceptance");
  expect(
    (
      await f.engine.accept(
        f.state.id,
        f.revision(),
        f.engine.acceptanceDigest(f.state.id),
      )
    ).stage,
  ).toBe("accepted");
});

test("R2-AT-23 changed proposed bytes consume the approved capture before side effects and cannot retry automatically", async () => {
  const f = await setup();
  await f.advance();
  await f.advance();
  const old = f.candidate(),
    count = [...f.store.iterate("candidate")].length,
    plan = await f.capturePlan();
  await writeFile(
    path.join(f.root, "output.txt"),
    "different unapproved bytes",
  );
  await expect(
    f.engine.captureReviewedOutputs(
      f.state.id,
      f.revision(),
      plan.id,
      plan.digest,
    ),
  ).rejects.toThrow("changed");
  expect(f.store.get<any>("candidate-review-consumed", plan.id)?.state).toBe(
    "capture-started",
  );
  expect(f.store.get<any>("candidate-capture-result", plan.id)?.state).toBe(
    "failed",
  );
  expect(f.current().candidateId).toBe(old.id);
  expect([...f.store.iterate("candidate")]).toHaveLength(count);
  expect(f.calls()).toBe(1);
  expect([...f.store.iterate("candidate-output-review")]).toEqual([]);
  await expect(
    f.engine.captureReviewedOutputs(
      f.state.id,
      f.revision(),
      plan.id,
      plan.digest,
    ),
  ).rejects.toThrow("consumed");
});

test("R2-AT-23 scope amendment invalidates old passing evidence and preserves explicit accepted lineage", async () => {
  const f = await setup(true);
  await f.advance();
  await f.advance();
  await f.advance();
  await f.check();
  const prior = f.current(),
    oldChecks = f.repository
      .all<Verification>("verification", { projectId: "p" })
      .filter((check) => check.candidateId === prior.candidateId),
    plan = await f.capturePlan();
  expect(prior.stage).toBe("awaiting-acceptance");
  await f.engine.captureReviewedOutputs(
    f.state.id,
    f.revision(),
    plan.id,
    plan.digest,
  );
  expect(f.current().reviewedCandidateId).toBeNull();
  expect(f.current().checkTaskId).toBeNull();
  for (const check of oldChecks)
    expect(
      f.store.get<Verification>("verification", check.id)?.invalidatedAt,
    ).toBeTruthy();
  for (const id of [prior.reviewerTaskId!, prior.checkTaskId!]) {
    expect(f.store.get<Task>("task", id)?.state).toBe("cancelled");
    expect(f.store.get<any>("task-supersession", id)?.replacementTaskId).toBe(
      prior.builderTaskId,
    );
  }
  await f.advance();
  await f.advance();
  await f.check();
  expect(
    (
      await f.engine.accept(
        f.state.id,
        f.revision(),
        f.engine.acceptanceDigest(f.state.id),
      )
    ).stage,
  ).toBe("accepted");
  expect(f.store.get("candidate-scope-amendment", plan.id)).toBeTruthy();
});

test("R2-AT-23 an unrun check task is explicitly attributed and superseded before final acceptance", async () => {
  const f = await setup(true);
  await f.advance();
  await f.advance();
  await f.advance();
  const prior = f.current(),
    oldCheck = f.store.get<Task>("task", prior.checkTaskId!)!;
  expect(oldCheck.candidateId).toBeNull();
  const plan = await f.capturePlan();
  await f.engine.captureReviewedOutputs(
    f.state.id,
    f.revision(),
    plan.id,
    plan.digest,
  );
  expect(f.store.get<Task>("task", oldCheck.id)?.candidateId).toBe(
    prior.candidateId,
  );
  expect(f.store.get<Task>("task", oldCheck.id)?.state).toBe("cancelled");
  await f.advance();
  await f.advance();
  await f.check();
  expect(
    (
      await f.engine.accept(
        f.state.id,
        f.revision(),
        f.engine.acceptanceDigest(f.state.id),
      )
    ).stage,
  ).toBe("accepted");
});
