import { afterEach, expect, test, vi } from "vitest";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { performance } from "node:perf_hooks";
import path from "node:path";
import os from "node:os";
import { fixture } from "./helpers";
import {
  createDemoFixture,
  discountSource,
  featureOrderSource,
  fixtureCommand,
  type DemoFixture,
} from "../scripts/round2-demo-fixture.mjs";
import { hash, now } from "../packages/domain/invariants";
import type {
  ExecutionAttempt,
  Task,
  Workflow,
} from "../packages/domain/workflow";
import { Store } from "../packages/persistence/store";
import { ProtectedBlobs } from "../packages/persistence/blobs";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import {
  createSpecification,
  createTaskContext,
} from "../packages/context/packages";
import { candidateRequest } from "../packages/context/candidate-reader";
import {
  ContextServer,
  type ContextGrant,
} from "../packages/workspace/context";
import {
  BuilderReviewerWorkflow,
  type BuilderReviewerState,
  type WorkflowDriver,
} from "../packages/workflows/builder-reviewer";
import {
  captureCandidate,
  assertCandidateCoverage,
  recordCandidateOutputReview,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import { bindCheckInputs } from "../packages/workflows/check-inputs";
import { CheckExecutions } from "../packages/workflows/check-executions";
import { environmentSelection } from "../packages/workflows/environments";
import {
  previewCheck,
  type CheckDefinition,
} from "../packages/workflows/verification";
import { processGroupPresent } from "../packages/runtime/process-lifecycle";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function evidence(name: string, result: object) {
  if (!process.env.TOPSL_R2_EVIDENCE) return;
  const root = path.resolve(process.env.TOPSL_R2_EVIDENCE);
  await mkdir(root, { recursive: true });
  // Exclusive creation keeps a failure or prior attempt from being overwritten.
  await writeFile(
    path.join(root, `${name}.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        recordedAt: now(),
        providerRequests: 0,
        billedUsage: 0,
        ...result,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
async function archiveFixture(demo: DemoFixture, name: string) {
  if (!process.env.TOPSL_R2_EVIDENCE) return;
  const root = path.resolve(process.env.TOPSL_R2_EVIDENCE);
  await mkdir(root, { recursive: true });
  const destination = path.join(root, `${name}.bundle`);
  try {
    await stat(destination);
    throw new Error("Fixture evidence already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fixtureCommand(
    demo.gitExecutable,
    ["bundle", "create", destination, "HEAD"],
    demo.root,
  );
}
async function socketRequest(
  grant: ContextGrant,
  request: object,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(grant.endpoint),
      chunks: Buffer[] = [];
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("Fixture context socket timeout")),
    );
    socket.once("error", reject);
    socket.on("data", (bytes) =>
      chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)),
    );
    socket.once("connect", () =>
      socket.end(
        JSON.stringify({ ...request, grant: grant.grant, token: grant.token }) +
          "\n",
      ),
    );
    socket.once("end", () => {
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString());
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function setup(label: string) {
  const f = await fixture(),
    demo = await createDemoFixture({
      root: path.join(f.directory, "receipt-demo"),
    });
  await archiveFixture(
    demo,
    label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
  );
  const repository = new CoordinationRepository(f.store);
  const project = {
    id: "p",
    name: label,
    path: demo.root,
    realPath: demo.root,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  f.store.put("installation", {
    ...f.installation,
    id: "claude-fixture",
    appId: "anthropic.claude-code-cli",
  });
  const node = await realpath(
    process.env.npm_node_execpath ?? process.execPath,
  );
  const npm = await realpath(
    process.env.npm_execpath ??
      path.join(path.dirname(node), "node_modules/npm/bin/npm-cli.js"),
  );
  const selection = environmentSelection(f.store, {
    projectId: "p",
    label: "Generated locked local archive",
    kind: "locked-node",
    profile: "user-approved-local",
    nodeExecutable: node,
    npmCli: npm,
    preparationTimeoutMs: 30_000,
    writablePaths: ["output"],
    hooks: [],
    values: {},
  });
  const definition: CheckDefinition = {
    id: "receipt-check",
    label: "Original receipt acceptance, dependency and tracked build",
    executable: node,
    args: [npm, "run", "check"],
    timeoutMs: 30_000,
    environmentRecipeId: selection.id,
  };
  const context = new ContextServer(f.store, f.directory);
  await context.start();
  let storeClosed = false;
  cleanups.push(async () => {
    context.close();
    await CheckExecutions.for(f.store).shutdown();
    if (!storeClosed) f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  return {
    ...f,
    demo,
    repository,
    project,
    definition,
    context,
    node,
    npm,
    closeStore: () => {
      f.store.close();
      storeClosed = true;
    },
  };
}
function snapshots(store: Store, projectId = "p") {
  return [...store.iterate<CandidateSnapshot>("candidate", { projectId })].map(
    (c) => ({
      id: c.id,
      revision: c.revision,
      baseRevision: c.baseRevision,
      files: c.files.length,
      logicalBytes: c.files.reduce((sum, file) => sum + file.bytes, 0),
      formatVersion: c.formatVersion,
      outputs: c.outputs,
      changedPaths: c.changes,
      coverage: c.coverage,
    }),
  );
}
function executionEvidence(checks: CheckExecutions) {
  return checks
    .list("p")
    .executions.map((execution) => checks.inspect("p", execution.id));
}

test.each([false, true])(
  "R2-AT-37/38 fixture-only direction reverse=%s: actual dependency check detects seeded defect, one repair passes",
  async (reverse) => {
    const f = await setup(
        reverse ? "offline-claude-codex" : "offline-codex-claude",
      ),
      results = new Map<string, string>();
    let edits = 0,
      dispatches = 0;
    const retrievals: object[] = [],
      stages: string[] = [];
    const driver: WorkflowDriver = {
      capabilities: () => ({
        supported: true,
        detail:
          "Dependency-injected provider fixture; no production capability qualification",
      }),
      result: (attempt) => results.get(attempt.id) ?? "",
      async installCandidateReader({ attempt, grant, candidate }) {
        const status = await socketRequest(grant, { method: "status" });
        const reply = await socketRequest(grant, {
          method: "candidate-read-range",
          projectId: "p",
          workflowId: status.subject.workflowId,
          attemptId: attempt.id,
          candidateId: candidate.id,
          candidateRevision: candidate.revision,
          path: "src/reference.ts",
          offset: 1_000_000,
          length: 128,
        });
        expect(reply.returnedBytes).toBe(128);
        expect(reply.content).toContain("source");
        retrievals.push({
          attemptId: attempt.id,
          candidateId: candidate.id,
          revision: candidate.revision,
          path: reply.path,
          returnedBytes: reply.returnedBytes,
        });
      },
      async dispatch(input) {
        dispatches++;
        let attempt = f.repository.transitionAttempt(
          input.attempt.id,
          input.attempt.revision,
          "starting",
        );
        const intent = f.repository.recordIntent(
          attempt.id,
          "turn",
          "offline-receipt-fixture",
        );
        f.repository.updateIntent(intent.id, "dispatch-recorded");
        attempt = f.repository.transitionAttempt(
          attempt.id,
          attempt.revision,
          "running",
          { operationIntentId: intent.id },
        );
        f.repository.updateIntent(intent.id, "acknowledged", "fixture-turn");
        if (input.mode === "edit") {
          await writeFile(
            path.join(f.demo.root, "src/order.mjs"),
            featureOrderSource,
          );
          await writeFile(
            path.join(f.demo.root, "src/discount.mjs"),
            discountSource(edits++ === 0),
          );
        } else {
          const candidate = f.store.get<CandidateSnapshot>(
            "candidate",
            input.attempt.inputManifest.contentManifestId!,
          )!;
          const defective =
            candidate.files.find((file) => file.path === "src/discount.mjs")
              ?.hash === hash(discountSource(true));
          results.set(
            attempt.id,
            JSON.stringify({
              candidateRevision: input.context.candidateRevision,
              summary: defective
                ? "Seeded twenty percent discount conflicts with the ten percent requirement"
                : "Fixture exact-candidate review found no remaining defect",
              findings: defective
                ? [
                    {
                      title: "Wrong discount rate",
                      severity: "medium",
                      file: "src/discount.mjs",
                      line: 2,
                      behavior:
                        "Returns 800 for a 1000 cent cart; approved feature requires 900.",
                      evidence:
                        "Fixture source inspection plus independent original project check.",
                    },
                  ]
                : [],
            }),
          );
        }
        f.repository.updateIntent(intent.id, "verified", "fixture-turn");
        attempt = f.repository.transitionAttempt(
          attempt.id,
          attempt.revision,
          "completed",
          {
            reportedModel: "fixture-effective",
            modelEvidence: {
              level: "source-observation",
              source: "injected-fixture",
              observedAt: now(),
              detail: "Deterministic injected driver; no model inference",
            },
          },
        );
        const task = f.repository.require<Task>("task", input.task.id);
        f.repository.transitionTask(
          task.id,
          task.revision,
          "submitted",
          "Offline fixture turn complete",
        );
      },
    };
    const engine = new BuilderReviewerWorkflow(f.repository, driver, f.context);
    const state = await engine.create(f.project, {
      objective: "Implement a ten percent discount in a new source module",
      acceptanceCriteria: [
        "Original 1000 cent cart total remains unchanged",
        "Discounted order is 900 cents",
        "New src/discount.mjs requires exact-hash output approval",
        "Tracked binary and build script remain captured",
      ],
      builder: {
        provider: reverse ? "claude" : "codex",
        installationId: reverse ? "claude-fixture" : f.installation.id,
        model: "fixture-builder",
      },
      reviewer: {
        provider: reverse ? "codex" : "claude",
        installationId: reverse ? f.installation.id : "claude-fixture",
        model: "fixture-reviewer",
      },
      approvedUntracked: ["src/discount.mjs"],
      checks: [f.definition],
      maxRepairs: 2,
    });
    let current = state;
    const advance = async () => {
      current = await engine.advance(
        state.id,
        f.repository.require<Workflow>("workflow", state.id).revision,
      );
      stages.push(current.stage);
      return current;
    };
    try {
      expect((await advance()).stage).toBe("building");
      expect((await advance()).stage).toBe("ready-review"); // New output remains pending.
      expect(dispatches).toBe(1);
      const seeded = f.store.get<CandidateSnapshot>(
        "candidate",
        current.candidateId,
      )!;
      expect(() => assertCandidateCoverage(seeded, f.store)).toThrow("output");
      const output = seeded.outputs!.find(
        (output) => output.path === "src/discount.mjs",
      )!;
      recordCandidateOutputReview(f.store, seeded, [
        { path: output.path, hash: output.hash!, decision: "approved" },
      ]);
      const task = f.repository.require<Task>("task", current.builderTaskId);
      const plan = await previewCheck(
          f.repository,
          state.id,
          task.id,
          seeded,
          f.definition,
        ),
        checks = CheckExecutions.for(f.store);
      const verification = await checks.execute(
          f.repository,
          plan,
          plan.digest,
        ),
        [execution] = checks.list("p").executions;
      // A slow Windows runner once ended this check as `error`; say why if so.
      expect(
        verification.result,
        `${execution.failurePhase ?? "unknown"} phase, environment ${
          checks.inspect("p", execution.id).environment?.instance.failureKind ??
          "not failed"
        }: ${execution.error ?? "no error recorded"}`,
      ).toBe("failed");
      expect(
        executionEvidence(checks)[0]
          .logs.map((log) => log.text)
          .join(""),
      ).toContain("approved ten percent feature discount");
      expect((await advance()).stage).toBe("reviewing");
      expect((await advance()).stage).toBe("ready-repair");
      expect((await advance()).stage).toBe("repairing");
      await advance(); // A changed new-file hash may need another explicit output review.
      if (current.stage === "ready-review") {
        const repaired = f.store.get<CandidateSnapshot>(
          "candidate",
          current.candidateId,
        )!;
        for (const output of repaired.outputs ?? [])
          if (output.required && output.status !== "approved")
            recordCandidateOutputReview(f.store, repaired, [
              { path: output.path, hash: output.hash!, decision: "approved" },
            ]);
        await advance();
      }
      expect(current.stage).toBe("reviewing");
      expect((await advance()).stage).toBe("checking");
      const [finalPlan] = await engine.previewChecks(
        state.id,
        f.repository.require<Workflow>("workflow", state.id).revision,
      );
      current = await engine.runCheck(finalPlan.id, finalPlan.digest);
      expect(current.stage).toBe("awaiting-acceptance");
      const accepted = await engine.accept(
        state.id,
        f.repository.require<Workflow>("workflow", state.id).revision,
        engine.acceptanceDigest(state.id),
      );
      expect(accepted.stage).toBe("accepted");
      expect(accepted.repairRound).toBe(1);
      expect(dispatches).toBe(4);
      const attempts = f.repository.all<ExecutionAttempt>("attempt", {
        projectId: "p",
      });
      expect(attempts.map((attempt) => attempt.provider)).toEqual(
        reverse
          ? ["claude", "codex", "claude", "codex"]
          : ["codex", "claude", "codex", "claude"],
      );
      const contexts = f.store.list<any>("task-context-package");
      expect(contexts).toHaveLength(4);
      expect(contexts.every((context) => context.bytes <= 128 * 1024)).toBe(
        true,
      );
      // Only the two reviews install the reader; the builder and the repair
      // read the workspace the candidate was captured from.
      expect(
        (retrievals as Array<{ attemptId: string }>).map(
          (retrieval) => retrieval.attemptId,
        ),
      ).toEqual([attempts[1].id, attempts[3].id]);
      expect(
        executionEvidence(checks)
          .map((item) => item.execution.targetRevision)
          .every((revision) => revision === seeded.revision),
      ).toBe(false);
      await evidence(
        reverse ? "direction-claude-codex" : "direction-codex-claude",
        {
          status: "passed-local-fixture-and-process",
          liveGate: "pending-not-authorized",
          evidenceClass: [
            "deterministic-provider-fixture",
            "real-local-check-subprocess",
          ],
          fixture: f.demo,
          stages,
          dispatches,
          attempts: attempts.map(
            ({
              id,
              provider,
              taskId,
              contextPackageId,
              inputManifest,
              reportedModel,
            }) => ({
              id,
              provider,
              taskId,
              contextPackageId,
              inputManifest,
              reportedModel,
            }),
          ),
          retrievals,
          candidates: snapshots(f.store),
          checks: executionEvidence(checks),
          acceptance: accepted,
          authenticationRoute: "none; dependency injection",
          limitations: [
            "Provider output is scripted; no Codex or Claude model was contacted",
            "Local OS filesystem/network/CPU/memory containment is not enforced",
            "Workflow acceptance is fixture user action; no source application, merge or release",
          ],
        },
      );
    } catch (error) {
      await evidence(
        reverse
          ? "direction-claude-codex-failure"
          : "direction-codex-claude-failure",
        {
          status: "failed",
          error: String(error),
          fixture: f.demo,
          stages,
          candidates: snapshots(f.store),
          checks: executionEvidence(CheckExecutions.for(f.store)),
        },
      );
      throw error;
    }
  },
);

test("R2-AT-39 local real check: cleanup fault preserves result; storage uncertainty and reopened vault never replay", async () => {
  const f = await setup("Fault recovery"),
    workspace = f.repository.ensureWorkspace(f.project),
    workflow = f.repository.createWorkflow({
      projectId: "p",
      objective: "Recovery evidence",
      template: "fixture",
      templateVersion: "1",
    }),
    task = f.repository.createTask({
      projectId: "p",
      workflowId: workflow.id,
      workspaceId: workspace.id,
      title: "Fault check",
      role: "tester",
    });
  await writeFile(path.join(f.demo.root, "src/discount.mjs"), discountSource());
  await writeFile(path.join(f.demo.root, "src/order.mjs"), featureOrderSource);
  const candidate = await captureCandidate(f.store, {
    root: f.demo.root,
    projectId: "p",
    workflowId: workflow.id,
    approvedUntracked: ["src/discount.mjs"],
  });
  bindCheckInputs(f.store, workflow.id, candidate, [f.definition]);
  const plan = await previewCheck(
    f.repository,
    workflow.id,
    task.id,
    candidate,
    f.definition,
  );
  let deny = true;
  const cleanupFault = new CheckExecutions(f.store, {
    cleanup: async (root) => {
      if (deny) throw new Error("Injected cleanup lock after committed result");
      await rm(root, { recursive: true, force: true });
    },
  });
  cleanups.unshift(() => cleanupFault.shutdown());
  expect(
    (await cleanupFault.execute(f.repository, plan, plan.digest)).result,
  ).toBe("passed");
  const first = cleanupFault.inspect(
    "p",
    cleanupFault.list("p").executions[0].id,
  );
  expect(first.cleanup?.state).toBe("failed");
  expect(first.execution.eligibility).toBe("eligible");
  deny = false;
  expect((await cleanupFault.retryCleanup("p", first.cleanup!.id)).state).toBe(
    "completed",
  );
  expect(cleanupFault.list("p").executions).toHaveLength(1);
  const secondPlan = await previewCheck(
      f.repository,
      workflow.id,
      task.id,
      candidate,
      f.definition,
    ),
    uncertain = new CheckExecutions(f.store, {
      beforeFinalCommit: () => {
        throw new Error("Injected lost final storage commit");
      },
    });
  cleanups.unshift(() => uncertain.shutdown());
  await expect(
    uncertain.execute(f.repository, secondPlan, secondPlan.digest),
  ).rejects.toThrow("No durable pass");
  const lost = uncertain
    .list("p")
    .executions.find((execution) => execution.planId === secondPlan.id)!;
  expect(lost.state).toBe("uncertain");
  const before = {
    checks: executionEvidence(uncertain),
    verificationCount: f.store.list("verification").length,
    dispatches: f.store.list("check-dispatch-intent").length,
  };
  await uncertain.shutdown();
  await cleanupFault.shutdown();
  f.closeStore();
  const reopened = new Store(path.join(f.directory, "history.sqlite"), f.key),
    recovered = new CheckExecutions(reopened);
  try {
    recovered.recover();
    expect(recovered.inspect("p", lost.id).execution.state).toBe("uncertain");
    await expect(
      recovered.execute(
        new CoordinationRepository(reopened),
        secondPlan,
        secondPlan.digest,
      ),
    ).rejects.toThrow("consumed");
    expect(reopened.list("check-dispatch-intent")).toHaveLength(
      before.dispatches,
    );
    expect(reopened.list("verification")).toHaveLength(
      before.verificationCount,
    );
    expect((await recovered.reconcileStopped("p", lost.id)).eligibility).toBe(
      "ineligible",
    );
    const cleanup = recovered.inspect("p", lost.id).cleanup!;
    await recovered.retryCleanup("p", cleanup.id);
    await evidence("durable-faults", {
      status: "passed-local-process",
      scope:
        "Real checks, injected storage/cleanup faults and actual encrypted vault close/reopen; abrupt service-process crash is not exercised here",
      fixture: f.demo,
      candidate: { id: candidate.id, revision: candidate.revision },
      before,
      recovered: executionEvidence(recovered),
      replayedCommands: 0,
    });
  } finally {
    await recovered.shutdown();
    reopened.close();
  }
});

test("R2-AT-39 uncertain provider fixture and an active real check survive coordinator reconstruction without replay", async () => {
  const f = await setup("Unknown dispatch and restart");
  let dispatches = 0;
  const driver: WorkflowDriver = {
    capabilities: () => ({
      supported: true,
      detail: "Offline fault fixture only",
    }),
    async installCandidateReader({ grant }) {
      await socketRequest(grant, { method: "status" });
    },
    async dispatch(input) {
      dispatches++;
      let attempt = f.repository.transitionAttempt(
        input.attempt.id,
        input.attempt.revision,
        "starting",
      );
      const intent = f.repository.recordIntent(
        attempt.id,
        "turn",
        "unknown-reply-fixture",
      );
      f.repository.updateIntent(intent.id, "dispatch-recorded");
      attempt = f.repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "running",
        { operationIntentId: intent.id },
      );
      throw new Error("Injected response loss after recorded dispatch");
    },
  };
  const engine = new BuilderReviewerWorkflow(f.repository, driver, f.context);
  const state = await engine.create(f.project, {
    objective: "Unknown dispatch must not replay",
    acceptanceCriteria: ["Retain uncertainty"],
    builder: {
      provider: "codex",
      installationId: f.installation.id,
      model: "fixture",
    },
    reviewer: {
      provider: "claude",
      installationId: "claude-fixture",
      model: "fixture",
    },
    checks: [f.definition],
  });
  expect(
    (
      await engine.advance(
        state.id,
        f.repository.require<Workflow>("workflow", state.id).revision,
      )
    ).stage,
  ).toBe("blocked");
  expect(
    f.repository.all<ExecutionAttempt>("attempt", { projectId: "p" })[0].state,
  ).toBe("uncertain");
  const rebuilt = new BuilderReviewerWorkflow(f.repository, driver, f.context);
  await expect(
    rebuilt.advance(
      state.id,
      f.repository.require<Workflow>("workflow", state.id).revision,
    ),
  ).rejects.toThrow();
  expect(dispatches).toBe(1);
  const workspace = f.repository.ensureWorkspace(f.project),
    workflow = f.repository.createWorkflow({
      projectId: "p",
      objective: "Stop and reopen during actual check",
      template: "fixture",
      templateVersion: "1",
    }),
    task = f.repository.createTask({
      projectId: "p",
      workflowId: workflow.id,
      workspaceId: workspace.id,
      title: "Active check",
      role: "tester",
    });
  const marker = path.join(f.directory, "one-check-effect.txt"),
    definition = {
      ...f.definition,
      id: "active-restart",
      label: "One check effect before controlled restart",
      args: [
        "-e",
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'effect\\n');console.log('active-restart-ready');setInterval(()=>{},10000);`,
      ],
    };
  const candidate = await captureCandidate(f.store, {
    root: f.demo.root,
    projectId: "p",
    workflowId: workflow.id,
  });
  bindCheckInputs(f.store, workflow.id, candidate, [definition]);
  const plan = await previewCheck(
      f.repository,
      workflow.id,
      task.id,
      candidate,
      definition,
    ),
    checks = CheckExecutions.for(f.store),
    running = checks.execute(f.repository, plan, plan.digest);
  // The check starts only after its environment is prepared: two version
  // probes and `npm ci`, each with a 30 s limit.
  await vi.waitFor(
    () =>
      expect(
        f.store
          .list<any>("check-log")
          .map((log) => log.text)
          .join(""),
      ).toContain("active-restart-ready"),
    { timeout: 120_000 },
  );
  expect(checks.list("p").executions[0].state).toBe("running");
  await checks.shutdown();
  expect((await running).result).toBe("error");
  const stopped = checks.list("p").executions[0];
  expect(stopped.state).toBe("cancelled");
  expect(stopped.lifecycle?.state).toBe("quiescent");
  f.closeStore();
  const reopened = new Store(path.join(f.directory, "history.sqlite"), f.key),
    recovered = new CheckExecutions(reopened);
  try {
    recovered.recover();
    expect(recovered.list("p").executions).toHaveLength(1);
    expect(recovered.list("p").executions[0].state).toBe("cancelled");
    expect(await readFile(marker, "utf8")).toBe("effect\n");
    expect(reopened.list("check-dispatch-intent")).toHaveLength(1);
    await evidence("unknown-dispatch-active-restart", {
      status: "passed-local-fixture-and-process",
      scope:
        "Unknown reply uses injected provider dispatch; restart is awaited shutdown during a real active check plus actual encrypted vault close/reopen",
      providerDispatches: dispatches,
      providerAttempts: reopened.list("attempt"),
      providerIntents: reopened.list("operation-intent"),
      check: executionEvidence(recovered),
      replayedCommands: 0,
      remaining:
        "Abrupt coordinator-process termination and live provider response loss remain unqualified",
    });
  } finally {
    await recovered.shutdown();
    reopened.close();
  }
});

test.skipIf(process.platform === "win32")(
  "R2-AT-39 actual POSIX coordinator SIGKILL retains one uncertain real check and permits cleanup only after recorded group absence",
  async () => {
    const f = await fixture(),
      entry = path.join(f.directory, "crash-worker.cjs"),
      input = path.join(f.directory, "crash-input.json");
    f.store.close();
    await writeFile(
      input,
      JSON.stringify({ directory: f.directory, key: f.key }),
      { mode: 0o600 },
    );
    await build({
      entryPoints: [path.resolve("tests/fixtures/round2-crash-worker.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      packages: "external",
      logLevel: "silent",
    });
    const workerHash = hash(await readFile(entry));
    const worker = spawn(process.execPath, [entry], {
      env: {
        PATH: process.env.PATH,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: path.resolve("node_modules"),
        TOPSL_CRASH_INPUT: input,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let diagnostics = "",
      ownedGroup: number | null = null,
      ready: any,
      reopened: Store | undefined,
      recovered: CheckExecutions | undefined;
    worker.stdout!.on("data", (bytes) => {
      diagnostics = (diagnostics + bytes).slice(-16000);
    });
    worker.stderr!.on("data", (bytes) => {
      diagnostics = (diagnostics + bytes).slice(-16000);
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      ready = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Abrupt worker ready barrier timed out: " + diagnostics,
              ),
            ),
          30_000,
        );
        worker.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        worker.once("exit", () => {
          clearTimeout(timeout);
          reject(
            new Error("Worker exited before crash barrier: " + diagnostics),
          );
        });
        worker.on("message", (message) => {
          const event = message as any;
          if (event.type === "ready") {
            clearTimeout(timeout);
            resolve(event);
          } else if (event.type === "failure") {
            clearTimeout(timeout);
            reject(new Error(event.error));
          }
        });
      });
      expect(ready.workerPid).toBe(worker.pid);
      expect(ready.pid).toBeGreaterThan(1);
      expect(ready.groupId).toBe(ready.pid);
      expect(ready.groupId).not.toBe(process.pid);
      expect(ready.groupId).not.toBe(worker.pid);
      const effect = JSON.parse((await readFile(ready.marker, "utf8")).trim());
      expect(effect).toEqual({ pid: ready.pid, effect: "once" });
      ownedGroup = ready.groupId;
      expect(worker.kill("SIGKILL")).toBe(true);
      const coordinatorExit = await exited;
      expect(coordinatorExit.signal).toBe("SIGKILL");
      reopened = new Store(path.join(f.directory, "history.sqlite"), f.key);
      recovered = new CheckExecutions(reopened);
      recovered.recover();
      const uncertain = recovered.inspect(ready.projectId, ready.executionId),
        plan = reopened.get<any>("workflow-check-plan", ready.planId)!;
      expect(uncertain.execution).toMatchObject({
        state: "uncertain",
        eligibility: "uncertain",
        verificationId: null,
      });
      expect(uncertain.execution.lifecycle).toMatchObject({
        pid: ready.pid,
        groupId: ready.groupId,
        scope: "posix-process-group",
      });
      expect(uncertain.logs.map((log) => log.text).join("")).toContain(
        "abrupt-crash-check-ready",
      );
      expect(reopened.list("check-dispatch-intent")).toHaveLength(1);
      expect(reopened.list("verification")).toHaveLength(0);
      expect(processGroupPresent(ownedGroup!)).toBe(true);
      await expect(
        recovered.reconcileStopped(ready.projectId, ready.executionId),
      ).rejects.toThrow("present");
      expect(
        (await stat(uncertain.execution.materializedRoot)).isDirectory(),
      ).toBe(true);
      await expect(
        recovered.execute(
          new CoordinationRepository(reopened),
          plan,
          plan.digest,
        ),
      ).rejects.toThrow(/consumed|exhausted/);
      expect(reopened.list("check-dispatch-intent")).toHaveLength(1);
      expect(
        (await readFile(ready.marker, "utf8")).trim().split("\n"),
      ).toHaveLength(1);
      process.kill(-ownedGroup!, "SIGTERM");
      await vi.waitFor(
        () => expect(processGroupPresent(ownedGroup!)).toBe(false),
        { timeout: 10_000 },
      );
      const reconciled = await recovered.reconcileStopped(
        ready.projectId,
        ready.executionId,
      );
      expect(reconciled).toMatchObject({
        state: "error",
        eligibility: "ineligible",
        verificationId: null,
      });
      const job = recovered.inspect(
        ready.projectId,
        ready.executionId,
      ).cleanup!;
      expect(
        (await recovered.retryCleanup(ready.projectId, job.id)).state,
      ).toBe("completed");
      await expect(
        stat(uncertain.execution.materializedRoot),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(reopened.list("verification")).toHaveLength(0);
      await evidence("abrupt-posix-coordinator-crash", {
        status: "passed-real-process-fault",
        evidenceClass: "actual-local-coordinator-SIGKILL-and-check-subprocess",
        platform: process.platform,
        worker: { pid: worker.pid, entryHash: workerHash, coordinatorExit },
        barrier: {
          executionId: ready.executionId,
          pid: ready.pid,
          groupId: ready.groupId,
        },
        beforeReconciliation: uncertain,
        afterReconciliation: recovered.inspect(
          ready.projectId,
          ready.executionId,
        ),
        dispatchIntents: reopened.list("check-dispatch-intent"),
        effectCount: 1,
        replayedCommands: 0,
        durablePasses: 0,
        limitations: [
          "POSIX process-group observation on this host; no escaped-process containment guarantee",
          "Windows abrupt-termination route is skipped until separately implemented and executed",
          "The killed process is an isolated CheckExecutions coordinator fixture, not a production profile or native provider",
        ],
      });
    } finally {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGKILL");
      await exited.catch(() => {});
      if (ownedGroup && processGroupPresent(ownedGroup) === true) {
        try {
          process.kill(-ownedGroup, "SIGKILL");
        } catch {}
      }
      await recovered?.shutdown();
      reopened?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(!process.env.TOPSL_R2_STRESS)(
  "R2-AT-17/24 optional synthetic 100 MB and 10000 source capture/retrieval",
  async () => {
    const f = await fixture();
    cleanups.push(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const start = performance.now(),
      initial = process.memoryUsage(),
      demo = await createDemoFixture({
        root: path.join(f.directory, "stress"),
        stress: true,
      }),
      generated = performance.now();
    const repository = new CoordinationRepository(f.store),
      project = {
        id: "stress",
        name: "Synthetic capture fixture",
        path: demo.root,
        realPath: demo.root,
        trusted: true,
        createdAt: now(),
      };
    f.store.put("project", project);
    const workspace = repository.ensureWorkspace(project),
      workflow = repository.createWorkflow({
        projectId: "stress",
        objective: "Bounded synthetic capture",
        template: "fixture",
        templateVersion: "1",
      });
    let peakRss = initial.rss;
    const sample = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    try {
      expect(demo.manifest.logicalBytes).toBeGreaterThanOrEqual(100_000_000);
      expect(
        demo.paths.filter((name) => name.startsWith("synthetic/")).length,
      ).toBe(10_000);
      const candidate = await captureCandidate(f.store, {
          root: demo.root,
          projectId: "stress",
          workflowId: workflow.id,
          limits: {
            fileCount: 20_000,
            projectBytes: 256 * 1024 * 1024,
            vaultBytes: 512 * 1024 * 1024,
          },
        }),
        captured = performance.now();
      const second = await captureCandidate(f.store, {
          root: demo.root,
          projectId: "stress",
          workflowId: workflow.id,
        }),
        recaptured = performance.now();
      expect(second.revision).toBe(candidate.revision);
      const logical = candidate.files.reduce(
          (sum, file) => sum + file.bytes,
          0,
        ),
        protectedBytes = new ProtectedBlobs(f.store).usage();
      expect(protectedBytes).toBeLessThan(logical / 2);
      const specification = createSpecification(f.store, {
        projectId: "stress",
        workflowId: workflow.id,
        objective: "Exercise bounded artifact delivery",
        acceptanceCriteria: [
          "Retain all approved files; bounded context and scoped retrieval",
        ],
        interfaces: [],
      });
      const context = createTaskContext(f.store, {
        specification,
        candidate,
        taskId: "stress-t",
        role: "reviewer",
        maxBytes: 32 * 1024,
      });
      expect(context.bytes).toBeLessThanOrEqual(32 * 1024);
      let task = repository.createTask({
        projectId: "stress",
        workflowId: workflow.id,
        workspaceId: workspace.id,
        title: "Synthetic reader attribution",
        role: "reviewer",
      });
      task = repository.transitionTask(task.id, task.revision, "ready");
      const attempt = repository.prepareAttempt({
        taskId: task.id,
        expectedRevision: task.revision,
        provider: "codex",
        requestedModel: "synthetic-no-inference",
        freshSession: true,
        inputManifest: {
          workspaceIdentity: workspace.filesystemIdentity,
          baseRevision: candidate.baseRevision,
          contentManifestId: candidate.id,
          dirtyInputPolicy: "reviewed-snapshot",
          instructionHashes: [],
        },
      });
      const scope = {
        projectId: "stress",
        subject: { workflowId: workflow.id, attemptId: attempt.id },
        candidates: [
          { candidateId: candidate.id, revision: candidate.revision },
        ],
      };
      const request = {
        projectId: "stress",
        workflowId: workflow.id,
        attemptId: attempt.id,
        candidateId: candidate.id,
        candidateRevision: candidate.revision,
      };
      const list = candidateRequest(f.store, scope, {
        ...request,
        method: "candidate-list",
        limit: 50,
      }) as any;
      expect(list.items).toHaveLength(50);
      expect(list.nextCursor).toBeTruthy();
      const read = candidateRequest(f.store, scope, {
        ...request,
        method: "candidate-read-range",
        path: "synthetic/source-09999.ts",
        offset: 100,
        length: 256,
      }) as any;
      expect(read.returnedBytes).toBe(256);
      expect(read.hash).toBe(
        demo.manifest.sourceFiles.find(
          (file) => file.path === "synthetic/source-09999.ts",
        )!.sha256,
      );
      expect(() =>
        candidateRequest(
          f.store,
          { ...scope, projectId: "other" },
          { ...request, method: "candidate-list" },
        ),
      ).toThrow();
      const receipts = f.store.list<any>("candidate-retrieval");
      expect(
        receipts.filter((receipt) => receipt.outcome === "returned"),
      ).toHaveLength(2);
      expect(
        receipts.filter((receipt) => receipt.outcome === "denied"),
      ).toHaveLength(1);
      const end = performance.now();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      await archiveFixture(demo, "synthetic-stress-input");
      await evidence("synthetic-stress", {
        status: "passed-synthetic-capture",
        evidenceClass: "synthetic-local-performance",
        seed: demo.manifest.seed,
        fixtureSourceIdentity: demo.manifest.sourceIdentity,
        files: candidate.files.length,
        logicalBytes: logical,
        protectedUniqueBytes: protectedBytes,
        dedupRatio: protectedBytes / logical,
        candidateRevision: candidate.revision,
        recaptureRevision: second.revision,
        contextBytes: context.bytes,
        contextBudget: 32 * 1024,
        receiptLimit: 256 * 1024,
        receipts,
        measurements: {
          generationMs: generated - start,
          captureMs: captured - generated,
          recaptureMs: recaptured - captured,
          totalMs: end - start,
          sampledPeakRssBytes: peakRss,
          initialRssBytes: initial.rss,
          finalRssBytes: process.memoryUsage().rss,
          processMaxRssKiB: process.resourceUsage().maxRSS,
          sqliteBytes: (await stat(path.join(f.directory, "history.sqlite")))
            .size,
        },
        host: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          electron: process.versions.electron ?? null,
          cpu: os.cpus()[0]?.model,
        },
        limitations: [
          "Synthetic duplicate-heavy workload; capacity is not a guarantee for arbitrary assets",
          "RSS is process-wide, sampled every 20 ms; brief peaks may be missed",
          "No model inference, UI render timing, remote CI or packaged OS execution",
        ],
      });
    } finally {
      clearInterval(sample);
    }
  },
  600_000,
);
