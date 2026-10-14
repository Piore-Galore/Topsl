import { afterEach, describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers";
import { Coordinator } from "../packages/runtime/coordinator";
import {
  AdvancedCollaboration,
  type AdvancedCreate,
  type AdvancedDriver,
} from "../packages/workflows/advanced";
import { hash, now, stable, uid } from "../packages/domain/invariants";
import type {
  Artifact,
  ExecutionAttempt,
  Task,
  Verification,
  Workflow,
  Workspace,
} from "../packages/domain/workflow";
import { captureCandidate } from "../packages/workflows/candidates";
import { Service } from "../apps/service/service";
import { commandSchema, type Command } from "../packages/domain/commands";
import { canonicalWorkspaceIdentity } from "../packages/workspace/ownership";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(options: { enforce?: boolean; missing?: string } = {}) {
  const f = await fixture(),
    coordinator = new Coordinator(f.store),
    repository = coordinator.repository;
  f.store.put("project", {
    id: "project",
    name: "Disposable",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  });
  const participants = [];
  for (const key of ["alpha", "beta"]) {
    const root = path.join(f.directory, key);
    await mkdir(root);
    const w = {
      id: uid(),
      projectId: "project",
      hostId: "local",
      root,
      ...canonicalWorkspaceIdentity(root),
      checkoutType: "directory",
      branch: null,
      trustRevision: hash(root),
      availability: "available",
      provenance: "approved",
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    f.store.put("workspace", w);
    participants.push({
      key,
      workspaceId: w.id,
      installationId: f.installation.id,
      provider: "codex" as const,
      model: "fixture-explicit",
      permittedOutputs: ["result.txt"],
    });
  }
  const driver: AdvancedDriver = {
    capabilities: () =>
      [
        "structured-turn",
        "context-isolation",
        "filesystem-isolation",
        "tool-isolation",
        "fresh-session",
        "native-fanout-disabled",
        "workspace-write",
        "read-only",
      ]
        .filter((name) => name !== options.missing)
        .map((name) => ({
          name,
          route: "structured",
          support: "enforceable",
          versions: [f.installation.version!],
          testedPlatforms: ["fixture-only"],
          restrictions: ["Local deterministic fixture; no provider request."],
          evidence: {
            level: "source-observation",
            source: "fixture-policy-route",
            observedAt: now(),
            detail:
              "Controlled fixture enforces no peer reads or network access.",
          },
        })),
    enforceIsolation:
      options.enforce === false
        ? undefined
        : async (policy) => ({
            policyHash: hash(stable(policy)),
            enforced: true,
            evidence: {
              level: "source-observation",
              source: "fixture-only-policy-installation",
              observedAt: now(),
              detail: "Deterministic local fixture; no filesystem/tool reads.",
            },
          }),
    dispatch: async ({ attempt }) => {
      let a = repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "starting",
      );
      repository.transitionAttempt(a.id, a.revision, "completed");
    },
  };
  const engine = new AdvancedCollaboration(coordinator, driver, {
    enabled: true,
  });
  const input: AdvancedCreate = {
    projectId: "project",
    template: "independent-proposals",
    objective: "Compare proposed parsing approaches",
    acceptanceCriteria: ["Bounded deterministic result"],
    interfaces: ["parse(input): string"],
    participants,
    rubric: [
      {
        id: "score",
        label: "Declared correctness cases",
        unit: "cases",
        direction: "at-least",
        threshold: 2,
      },
    ],
    protocol: "Run declared cases A and B against the exact frozen output",
    protocolChecks: [],
    baselineCandidateId: null,
  };
  cleanup.push(async () => {
    coordinator.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  return { ...f, coordinator, repository, engine, input, driver };
}
function artifact(
  f: Awaited<ReturnType<typeof setup>>,
  taskId: string,
  attemptId: string | null,
  content = "fixture report",
  targetRevision = hash(content),
) {
  const id = uid(),
    at = now();
  f.store.immutable("advanced-output", {
    id,
    projectId: "project",
    text: content,
    contentHash: hash(content),
  });
  return f.repository.artifact({
    id,
    projectId: "project",
    taskId,
    attemptId,
    conversationId: null,
    kind: "report",
    contentHash: hash(content),
    targetRevision,
    protectedContentRef: id,
    confidentiality: "restricted",
    provenance: {
      level: "source-observation",
      source: "local-fixture",
      observedAt: at,
      detail: "Explicit deterministic fixture output.",
    },
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}
async function freezeAll(f: Awaited<ReturnType<typeof setup>>) {
  let state = f.engine.create(f.input);
  for (const key of ["alpha", "beta"]) {
    state = await f.engine.dispatch(state.id, state.revision, key);
    const p = state.participants.find((p) => p.key === key)!;
    const report = artifact(f, p.taskId, p.attemptId, `${key} report`);
    state = await f.engine.freeze(state.id, state.revision, key, report.id);
  }
  return state;
}
function evaluator(
  f: Awaited<ReturnType<typeof setup>>,
  state: ReturnType<AdvancedCollaboration["state"]>,
  submissionId: string,
) {
  const submission = f.engine
    .submissions(state.id)
    .find((s) => s.id === submissionId)!;
  const task = f.repository.createTask({
    projectId: "project",
    workspaceId: f.input.participants[0].workspaceId,
    title: "Separate protocol evaluation",
    role: "tester",
    inputRefs: [submission.id, submission.artifactId, state.protocolHash],
  });
  const evidence = artifact(
    f,
    task.id,
    null,
    "measured evidence",
    submission.candidateRevision ?? submission.artifactHash,
  );
  return { task, evidence, submission };
}

describe("advanced collaboration templates", () => {
  test("independence requires adapter access-policy installation and all capability evidence; flags cannot bypass", async () => {
    const f = await setup({ enforce: false });
    expect(() => f.engine.create(f.input)).toThrow(/access-policy/);
    expect(
      f.engine
        .status("project")
        .templates.find((t) => t.id === "independent-proposals")?.available,
    ).toBe(false);
    const g = await setup({ missing: "tool-isolation" });
    expect(() => g.engine.create(g.input)).toThrow(/tool-isolation/);
    g.engine.setEnabled(false);
    expect(() => g.engine.create(g.input)).toThrow(/disabled/);
    g.engine.setEnabled(true);
    expect(() => g.engine.create(g.input)).toThrow(/tool-isolation/);
    expect([...g.store.iterate("attempt")]).toHaveLength(0);
  });
  test("frozen submissions withhold peers until complete and rubric evidence binds exact target and common protocol", async () => {
    const f = await setup();
    let s = f.engine.create(f.input);
    s = await f.engine.dispatch(s.id, s.revision, "alpha");
    const p = s.participants[0],
      report = artifact(f, p.taskId, p.attemptId);
    s = await f.engine.freeze(s.id, s.revision, "alpha", report.id);
    expect(() => f.engine.submissions(s.id)).toThrow(/withheld/);
    await expect(
      f.engine.freeze(s.id, s.revision, "alpha", report.id),
    ).rejects.toThrow(/freeze once/);
    s = await f.engine.dispatch(s.id, s.revision, "beta");
    const q = s.participants[1];
    s = await f.engine.freeze(
      s.id,
      s.revision,
      "beta",
      artifact(f, q.taskId, q.attemptId, "other").id,
    );
    const submissions = f.engine.submissions(s.id),
      e = evaluator(f, s, submissions[0].id),
      wrong = evaluator(f, s, submissions[1].id);
    expect(() =>
      f.engine.evaluate(s.id, s.revision, submissions[0].id, [
        {
          criterionId: "score",
          value: 2,
          evidenceArtifactId: wrong.evidence.id,
        },
      ]),
    ).toThrow(/frozen target/);
    expect(() =>
      f.engine.evaluate(s.id, s.revision, submissions[0].id, []),
    ).toThrow(/Every declared/);
    s = f.engine.evaluate(s.id, s.revision, submissions[0].id, [
      { criterionId: "score", value: 2, evidenceArtifactId: e.evidence.id },
    ]);
    expect(() => f.engine.select(s.id, s.revision, submissions[0].id)).toThrow(
      /all frozen submissions/,
    );
    s = f.engine.evaluate(s.id, s.revision, submissions[1].id, [
      { criterionId: "score", value: 0, evidenceArtifactId: wrong.evidence.id },
    ]);
    s = f.engine.select(s.id, s.revision, submissions[0].id);
    expect(s.stage).toBe("awaiting-verification");
    expect(f.repository.require<Workflow>("workflow", s.id).state).toBe(
      "running",
    );
    expect([...f.store.iterate<any>("advanced-isolation")]).toHaveLength(2);
    expect(
      [...f.store.iterate<any>("agent-session")].every(
        (a) => a.continuity === "fresh",
      ),
    ).toBe(true);
  });
  test("separate verification, explicit acceptance and task lineage remain consistent; model routing measures outcomes without token ranking", async () => {
    const f = await setup();
    let s = await freezeAll(f);
    const submissions = f.engine.submissions(s.id);
    const evaluators = submissions.map((sub) => evaluator(f, s, sub.id));
    for (const e of evaluators)
      s = f.engine.evaluate(s.id, s.revision, e.submission.id, [
        { criterionId: "score", value: 2, evidenceArtifactId: e.evidence.id },
      ]);
    s = f.engine.select(s.id, s.revision, submissions[0].id);
    const review = f.engine.previewProposalReview(s.id, s.revision);
    expect(() =>
      f.engine.confirmProposalReview(review.id, hash("wrong")),
    ).toThrow(/stale/);
    const check = f.engine.confirmProposalReview(review.id, review.digest);
    expect(check.evidence.level).toBe("user-confirmation");
    expect(check.environment).toContain("Manual native");
    s = f.engine.bindVerification(s.id, s.revision, [check.id]);
    await expect(
      f.engine.accept(s.id, s.revision, hash("wrong")),
    ).rejects.toThrow(/explicit review/);
    s = await f.engine.accept(
      s.id,
      s.revision,
      f.engine.acceptanceDigest(s.id),
    );
    expect(s.stage).toBe("accepted");
    expect(f.repository.require<Workflow>("workflow", s.id).state).toBe(
      "accepted",
    );
    const p = s.participants[0],
      t = f.repository.require<Task>("task", p.taskId);
    expect(t.state).toBe("accepted");
    expect(
      f.repository.require<Task>("task", s.participants[1].taskId).state,
    ).toBe("cancelled");
    const preset = f.engine.savePreset({
      projectId: "project",
      name: "Explicit fixture planner",
      assignments: [
        {
          role: "planner",
          provider: "codex",
          installationId: f.installation.id,
          model: "fixture-explicit",
        },
      ],
    });
    f.engine.measureRouting(preset.id, t.id, 1);
    const summary = f.engine.routingSummary(preset.id);
    expect(summary).toMatchObject({
      acceptedTaskRate: 1,
      escapedDefects: 1,
      repairCount: 0,
      knownUsageCoverage: 0,
      subscriptionAllowance: "unknown",
    });
    expect(summary.ranking).toContain("none");
    const changed = f.engine.savePreset({
      ...preset,
      expectedRevision: preset.revision,
      assignments: [
        {
          role: "planner",
          provider: "codex",
          installationId: f.installation.id,
          model: "another-explicit-model",
        },
      ],
    });
    expect(f.engine.routingSummary(changed.id).tasks).toBe(0);
  });
  test("independent test design refuses implementation input and checks design and execution are different stages", async () => {
    const f = await setup();
    expect(() =>
      f.engine.create({
        ...f.input,
        template: "independent-test-design",
        participants: [f.input.participants[0]],
        baselineCandidateId: "anything",
      }),
    ).toThrow(/before seeing implementation/);
    let s = f.engine.create({
      ...f.input,
      template: "independent-test-design",
      participants: [f.input.participants[0]],
    });
    s = await f.engine.dispatch(s.id, s.revision, "alpha");
    const p = s.participants[0];
    s = await f.engine.freeze(
      s.id,
      s.revision,
      "alpha",
      artifact(f, p.taskId, p.attemptId, "frozen test protocol").id,
    );
    const sub = f.engine.submissions(s.id)[0],
      e = evaluator(f, s, sub.id);
    s = f.engine.evaluate(s.id, s.revision, sub.id, [
      { criterionId: "score", value: 2, evidenceArtifactId: e.evidence.id },
    ]);
    s = f.engine.select(s.id, s.revision, sub.id);
    expect(() =>
      f.engine.bindVerification(s.id, s.revision, ["missing"]),
    ).toThrow(/frozen test protocol/);
    expect(s.stage).toBe("awaiting-verification");
  });
  test("frozen independent tests run as a separate actual process against a later pinned implementation", async () => {
    const f = await setup(),
      definition = {
        id: "frozen-regression",
        label: "Frozen independent regression",
        executable: process.execPath,
        args: ["check.cjs"],
        timeoutMs: 5000,
      },
      text =
        'const f=require("node:fs");if(f.readFileSync("result.txt","utf8")!=="fixed")process.exit(3);console.log("declared regression passed");',
      protocol = JSON.stringify({
        files: [{ path: "check.cjs", text }],
        checks: [definition],
      });
    let s = f.engine.create({
      ...f.input,
      template: "independent-test-design",
      participants: [f.input.participants[0]],
    });
    await expect(
      f.engine.captureVerificationCandidate(
        s.id,
        s.revision,
        f.input.participants[1].workspaceId,
        ["result.txt"],
      ),
    ).rejects.toThrow(/Freeze/);
    s = await f.engine.dispatch(s.id, s.revision, "alpha");
    const p = s.participants[0];
    s = await f.engine.freeze(
      s.id,
      s.revision,
      "alpha",
      artifact(f, p.taskId, p.attemptId, protocol).id,
    );
    const sub = f.engine.submissions(s.id)[0],
      w = f.repository.require<Workspace>(
        "workspace",
        f.input.participants[1].workspaceId,
      );
    await writeFile(path.join(w.canonicalRoot, "result.txt"), "fixed");
    await writeFile(
      path.join(w.canonicalRoot, "check.cjs"),
      "console.log('weakened')",
    );
    await expect(
      f.engine.captureVerificationCandidate(s.id, s.revision, w.id, [
        "result.txt",
        "check.cjs",
      ]),
    ).rejects.toThrow(/changed a frozen/);
    await writeFile(path.join(w.canonicalRoot, "check.cjs"), text);
    const candidate = await f.engine.captureVerificationCandidate(
      s.id,
      s.revision,
      w.id,
      ["result.txt", "check.cjs"],
    );
    await expect(
      f.engine.previewCheck(
        s.id,
        s.revision,
        sub.id,
        { ...definition, args: ["result.txt"] },
        candidate.id,
      ),
    ).rejects.toThrow(/differs from the frozen/);
    const plan = await f.engine.previewCheck(
        s.id,
        s.revision,
        sub.id,
        definition,
        candidate.id,
      ),
      check = await f.engine.runCheck(plan.id, plan.digest);
    expect(check.result).toBe("passed");
    expect(check.taskId).not.toBe(p.taskId);
    expect(check.environment).toContain("materialized-candidate");
    s = f.engine.evaluate(s.id, s.revision, sub.id, [
      {
        criterionId: "score",
        value: 2,
        evidenceArtifactId: check.evidenceArtifactId!,
      },
    ]);
    s = f.engine.select(s.id, s.revision, sub.id);
    s = f.engine.bindVerification(s.id, s.revision, [check.id], sub.id);
    s = await f.engine.accept(
      s.id,
      s.revision,
      f.engine.acceptanceDigest(s.id),
    );
    expect(s.stage).toBe("accepted");
    expect(
      f.repository.require<Workflow>("workflow", s.id).acceptance
        ?.targetRevision,
    ).toBe(candidate.revision);
    await expect(f.engine.runCheck(plan.id, plan.digest)).rejects.toThrow(
      /changed|consumed/,
    );
  });
  test("pair driver switch requires stopped attempts, released writer, observed reproduction, and fresh checkpoint context", async () => {
    const f = await setup(),
      baseline = await captureCandidate(f.store, {
        root: f.repository.require<Workspace>(
          "workspace",
          f.input.participants[0].workspaceId,
        ).canonicalRoot,
        projectId: "project",
        workflowId: "pair-baseline-fixture",
        selectedPaths: ["result.txt"],
      });
    let s = f.engine.create({
      ...f.input,
      template: "pair-debugging",
      baselineCandidateId: baseline.id,
      protocolChecks: [
        {
          id: "regression",
          label: "Fixture regression",
          executable: process.execPath,
          args: ["check.cjs"],
          timeoutMs: 5000,
        },
      ],
    });
    s = await f.engine.dispatch(s.id, s.revision, "alpha");
    const original = s.participants[0],
      report = artifact(
        f,
        original.taskId,
        original.attemptId,
        "observed experiment",
      ),
      at = now();
    const verification = f.repository.verification({
      id: uid(),
      projectId: "project",
      taskId: original.taskId,
      candidateId: report.id,
      targetRevision: report.contentHash,
      definition: "reproduction",
      environment: "fixture",
      result: "failed",
      evidenceArtifactId: report.id,
      evidence: report.provenance,
      invalidatedAt: null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
    const attempt = f.repository.require<ExecutionAttempt>(
      "attempt",
      original.attemptId!,
    );
    f.store.put("attempt", { ...attempt, state: "uncertain" });
    expect(() =>
      f.engine.checkpoint(s.id, s.revision, "beta", verification.id, report.id),
    ).toThrow(/Stop and reconcile/);
    f.store.put("attempt", attempt);
    const w = f.repository.require<Workspace>(
        "workspace",
        original.workspaceId,
      ),
      lease = f.coordinator.ownership.acquire(w, attempt.id);
    expect(() =>
      f.engine.checkpoint(s.id, s.revision, "beta", verification.id, report.id),
    ).toThrow(/held or uncertain/);
    f.coordinator.ownership.release(
      attempt.id,
      lease.generation,
      report.provenance,
    );
    s = f.engine.checkpoint(
      s.id,
      s.revision,
      "beta",
      verification.id,
      report.id,
    );
    expect(s.writerKey).toBe("beta");
    expect(s.checkpoint).toBe(1);
    expect(s.participants[0].contextId).not.toBe(original.contextId);
    const context = f.store.get<any>(
      "context-package",
      s.participants[0].contextId,
    );
    expect(context.sourceRefs).toContain(verification.id);
    expect(context.text).toContain("observed experiment");
    expect(
      f.repository.require<Task>("task", s.participants[0].taskId)
        .permittedOutputs,
    ).toEqual([]);
    expect(
      f.repository.require<Task>("task", s.participants[1].taskId).role,
    ).toBe("implementer");
  });
  test("competing candidates share a verified baseline, freeze captured bytes, and cannot accept a changed candidate", async () => {
    const f = await setup(),
      w = f.input.participants.map((p) =>
        f.repository.require<Workspace>("workspace", p.workspaceId),
      );
    for (const root of w)
      await writeFile(path.join(root.canonicalRoot, "result.txt"), "base");
    const baseline = await captureCandidate(f.store, {
      root: w[0].canonicalRoot,
      projectId: "project",
      workflowId: "baseline-fixture",
      selectedPaths: ["result.txt"],
    });
    let s = f.engine.create({
      ...f.input,
      template: "competing-implementations",
      protocolChecks: [
        {
          id: "regression",
          label: "Fixture regression",
          executable: process.execPath,
          args: ["check.cjs"],
          timeoutMs: 5000,
        },
      ],
      baselineCandidateId: baseline.id,
    });
    s = await f.engine.dispatch(s.id, s.revision, "alpha");
    await writeFile(path.join(w[0].canonicalRoot, "result.txt"), "candidate A");
    s = await f.engine.capture(s.id, s.revision, "alpha");
    await writeFile(path.join(w[1].canonicalRoot, "result.txt"), "wrong basis");
    await expect(f.engine.dispatch(s.id, s.revision, "beta")).rejects.toThrow(
      /common baseline/,
    );
    await writeFile(path.join(w[1].canonicalRoot, "result.txt"), "base");
    s = await f.engine.dispatch(s.id, s.revision, "beta");
    await writeFile(path.join(w[1].canonicalRoot, "result.txt"), "candidate B");
    s = await f.engine.capture(s.id, s.revision, "beta");
    const submissions = f.engine.submissions(s.id);
    expect(
      submissions.every((sub) => sub.candidateId && sub.candidateRevision),
    ).toBe(true);
    const e = evaluator(f, s, submissions[0].id);
    s = f.engine.evaluate(s.id, s.revision, submissions[0].id, [
      { criterionId: "score", value: 2, evidenceArtifactId: e.evidence.id },
    ]);
    expect(
      f.store.get<any>("candidate", submissions[0].candidateId!).files[0]
        .content,
    ).toBe(Buffer.from("candidate A").toString("base64"));
    await writeFile(
      path.join(w[0].canonicalRoot, "result.txt"),
      "late outside edit",
    );
    const { assertCandidateCurrent } =
      await import("../packages/workflows/candidates");
    await expect(
      assertCandidateCurrent(
        f.store.get<any>("candidate", submissions[0].candidateId!)!,
      ),
    ).rejects.toThrow(/changed/);
  });
  test("service hooks default disabled, bounded reads and native replication approvals are enforced before effects", async () => {
    const f = await fixture();
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    service.store.put("project", {
      id: "project",
      name: "Disposable",
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    });
    const command = (raw: unknown) =>
      service.command(commandSchema.parse(raw) as Command);
    expect(
      (await command({ type: "advanced-query", projectId: "project" })).enabled,
    ).toBe(false);
    expect((await command({ type: "replication-query" })).enabled).toBe(false);
    await command({
      type: "optional-feature-set",
      requestId: uid(),
      feature: "multi-device",
      enabled: true,
    });
    const plan = await command({
      type: "replication-owner-preview",
      projectId: "project",
    });
    await expect(
      command({
        type: "replication-plan-apply",
        requestId: uid(),
        id: plan.id,
      }),
    ).rejects.toThrow(/native approval/);
    await service.command(
      commandSchema.parse({
        type: "replication-plan-apply",
        requestId: uid(),
        id: plan.id,
      }),
      { digest: plan.digest },
    );
    const deletedText = "unique portable deletion fixture payload",
      stage = await command({
        type: "replication-stage-preview",
        recordId: "deleted-fixture",
        projectId: "project",
        content: {
          kind: "artifact",
          label: "Reviewed text",
          files: [{ path: "report.txt", text: deletedText }],
        },
      });
    const staged = await service.command(
      commandSchema.parse({
        type: "replication-plan-apply",
        requestId: uid(),
        id: stage.id,
      }),
      { digest: stage.digest },
    );
    expect(staged).not.toHaveProperty("content");
    await service.command(
      commandSchema.parse({
        type: "replication-delete",
        requestId: uid(),
        recordId: "deleted-fixture",
        projectId: "project",
      }),
      { approved: true },
    );
    expect(
      stable(service.store.db.prepare("SELECT body FROM documents").all()),
    ).not.toContain(deletedText);
    expect(
      stable(service.store.db.prepare("SELECT body FROM events").all()),
    ).not.toContain(deletedText);
    service.store.message({
      id: "message",
      projectId: "project",
      conversationId: "conversation",
      role: "assistant",
      text: "x".repeat(200000),
      provider: "codex",
      createdAt: now(),
    } as any);
    expect(
      (await command({ type: "history-page", projectId: "project" })).items[0],
    ).toMatchObject({ totalChars: 200000, truncated: true });
    expect(
      (await command({ type: "history-page", projectId: "project" })).items[0]
        .text,
    ).toHaveLength(6000);
    expect(
      (
        await command({
          type: "history-message",
          projectId: "project",
          id: "message",
          offset: 6000,
          limit: 20000,
        })
      ).text,
    ).toHaveLength(20000);
    await expect(
      command({ type: "history-message", projectId: "other", id: "message" }),
    ).rejects.toThrow(/another project/);
  });
  test("service executes the same declared checks for competing candidates, binds genuine evidence and accepts exact selected bytes", async () => {
    const f = await fixture();
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true),
      repo = service.coordinator.repository;
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    service.store.put("project", {
      id: "project",
      name: "Process fixture",
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    });
    const participants = [];
    const script =
      'const f=require("node:fs"),x=f.readFileSync("result.txt","utf8");if(!["A","B"].includes(x))process.exit(3);console.log("two declared cases passed");';
    for (const key of ["alpha", "beta"]) {
      const root = path.join(f.directory, key);
      await mkdir(root);
      await writeFile(path.join(root, "result.txt"), "base");
      await writeFile(path.join(root, "check.cjs"), script);
      const w = {
        id: uid(),
        projectId: "project",
        hostId: "local",
        root,
        ...canonicalWorkspaceIdentity(root),
        checkoutType: "directory",
        branch: null,
        trustRevision: hash(root),
        availability: "available",
        provenance: "approved",
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      service.store.put("workspace", w);
      participants.push({
        key,
        workspaceId: w.id,
        installationId: f.installation.id,
        provider: "codex" as const,
        model: "fixture-explicit",
        permittedOutputs: ["result.txt", "check.cjs"],
      });
    }
    const capabilities: AdvancedDriver["capabilities"] = () =>
      [
        "structured-turn",
        "context-isolation",
        "filesystem-isolation",
        "tool-isolation",
        "fresh-session",
        "native-fanout-disabled",
        "workspace-write",
        "read-only",
      ].map((name) => ({
        name,
        route: "structured",
        support: "enforceable",
        versions: [f.installation.version!],
        testedPlatforms: ["local-fixture"],
        restrictions: ["Deterministic fixture only"],
        evidence: {
          level: "source-observation",
          source: "controlled-fixture",
          observedAt: now(),
          detail: "No provider model or network request",
        },
      }));
    const engine = new AdvancedCollaboration(
      service.coordinator,
      {
        capabilities,
        enforceIsolation: async (policy) => ({
          policyHash: hash(stable(policy)),
          enforced: true,
          evidence: {
            level: "source-observation",
            source: "controlled-fixture",
            observedAt: now(),
            detail: "No tool/filesystem reads outside explicit fixture",
          },
        }),
        dispatch: async ({ attempt }) => {
          const starting = repo.transitionAttempt(
            attempt.id,
            attempt.revision,
            "starting",
          );
          repo.transitionAttempt(starting.id, starting.revision, "completed");
        },
      },
      { enabled: true },
    );
    Object.defineProperty(service, "advanced", { value: engine }); // Isolated constructor fixture only; production has no isolation route.
    const command = (
        raw: unknown,
        trusted: Parameters<Service["command"]>[1] = {},
      ) => service.command(commandSchema.parse(raw), trusted),
      first = repo.require<Workspace>("workspace", participants[0].workspaceId),
      baseline = await captureCandidate(service.store, {
        root: first.canonicalRoot,
        projectId: "project",
        workflowId: "approved-fixture-baseline",
        selectedPaths: ["result.txt", "check.cjs"],
      }),
      definition = {
        id: "regression",
        label: "Declared comparison regression",
        executable: process.execPath,
        args: ["check.cjs"],
        timeoutMs: 5000,
      };
    let s = await command({
      type: "advanced-create",
      requestId: uid(),
      projectId: "project",
      template: "competing-implementations",
      objective: "Compare isolated candidates",
      acceptanceCriteria: ["Both declared cases pass"],
      interfaces: [],
      participants,
      rubric: [
        {
          id: "cases",
          label: "Declared cases passed",
          unit: "cases",
          direction: "at-least",
          threshold: 2,
        },
      ],
      protocol: "Run the unchanged original process harness on each candidate",
      protocolChecks: [definition],
      baselineCandidateId: baseline.id,
    });
    for (const key of ["alpha", "beta"]) {
      s = await command({
        type: "advanced-dispatch",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
        key,
      });
      const w = repo.require<Workspace>(
        "workspace",
        participants.find((p) => p.key === key)!.workspaceId,
      );
      await writeFile(
        path.join(w.canonicalRoot, "result.txt"),
        key === "alpha" ? "A" : "B",
      );
      s = await command({
        type: "advanced-capture",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
        key,
        approvedUntracked: [],
      });
    }
    const submissions = await command({
        type: "advanced-submissions",
        id: s.id,
      }),
      checks: Verification[] = [];
    for (const sub of submissions) {
      await expect(
        command({
          type: "advanced-check-preview",
          id: s.id,
          expectedRevision: s.revision,
          submissionId: sub.id,
          definition: { ...definition, args: ["-e", "process.exit(0)"] },
        }),
      ).rejects.toThrow(/common protocol/);
      const plan = await command({
        type: "advanced-check-preview",
        id: s.id,
        expectedRevision: s.revision,
        submissionId: sub.id,
        definition,
      });
      await expect(
        command({
          type: "advanced-check-apply",
          requestId: uid(),
          id: plan.id,
        }),
      ).rejects.toThrow(/native approval/);
      const check = await command(
        { type: "advanced-check-apply", requestId: uid(), id: plan.id },
        { digest: plan.digest },
      );
      expect(check.result).toBe("passed");
      checks.push(check);
      s = await command({
        type: "advanced-evaluate",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
        submissionId: sub.id,
        measurements: [
          {
            criterionId: "cases",
            value: 2,
            evidenceArtifactId: check.evidenceArtifactId,
          },
        ],
      });
    }
    s = await command({
      type: "advanced-select",
      requestId: uid(),
      id: s.id,
      expectedRevision: s.revision,
      submissionId: submissions[0].id,
    });
    s = await command({
      type: "advanced-bind-verification",
      requestId: uid(),
      id: s.id,
      expectedRevision: s.revision,
      verificationIds: [checks[0].id],
    });
    await writeFile(
      path.join(first.canonicalRoot, "result.txt"),
      "outside late edit",
    );
    const review = service.review("advanced-acceptance", s.id) as any;
    await expect(
      command(
        {
          type: "advanced-accept",
          requestId: uid(),
          id: s.id,
          expectedRevision: s.revision,
        },
        { digest: review.digest },
      ),
    ).rejects.toThrow(/changed/);
    await writeFile(path.join(first.canonicalRoot, "result.txt"), "A");
    s = await command(
      {
        type: "advanced-accept",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
      },
      { digest: review.digest },
    );
    expect(s.stage).toBe("accepted");
    expect(repo.require<Workflow>("workflow", s.id).state).toBe("accepted");
    expect(
      service.store.get<any>(
        "integration-submission",
        submissions[0].candidateId,
      ).state,
    ).toBe("queued");
    expect(service.runtime.hasActive()).toBe(false);
  });
});
