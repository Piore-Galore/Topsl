/**
 * Campaign 2026-10-19 packet p5a-build-review-candidates (plan §5.15).
 *
 * Service-level Build and review contracts through Service.command with the
 * Codex JSON-RPC workflow stand-in (tests/fixtures/codex-workflow.cjs) in a
 * real subprocess and a real Git project folder: builder-reviewer-cancel during
 * a managed build and during a running check (BW-21), forged or stale
 * verification references (BW-15), and acceptance that is not publication
 * (BW-20). No provider account or model is contacted.
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import type { Installation } from "../packages/domain/types";
import type {
  ExecutionAttempt,
  Verification,
} from "../packages/domain/workflow";
import type { BuilderReviewerState } from "../packages/workflows/builder-reviewer";
import { commandSchema } from "../packages/domain/commands";
import { now, uid } from "../packages/domain/invariants";
import { fixture, gitExecutable } from "./helpers";

class FixtureCodex extends CodexAdapter {
  override capabilities(installation: Installation) {
    return super.capabilities(installation).map((capability) => ({
      ...capability,
      support: "enforceable" as const,
      testedPlatforms: ["fixture"],
      evidence: {
        ...capability.evidence,
        detail: "Dependency-injected local fixture only",
      },
    }));
  }
}

const opened: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const f of opened.splice(0)) {
    await f.service.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    gitExecutable,
    [
      "-c",
      "user.name=Campaign",
      "-c",
      "user.email=campaign@example.test",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

type Check = {
  id: string;
  label: string;
  executable: string;
  args: string[];
  timeoutMs: number;
};
const passing: Check = {
  id: "required",
  label: "actual captured value",
  executable: process.execPath,
  args: [
    "-e",
    'if(!require("fs").readFileSync("file.ts","utf8").includes("value = 2"))process.exit(1)',
  ],
  timeoutMs: 30_000,
};

async function setup() {
  const f = await fixture(),
    log = path.join(f.directory, "codex-frames.jsonl"),
    project = path.join(f.directory, "project");
  f.store.close();
  await mkdir(project);
  await writeFile(path.join(project, "file.ts"), "export const value = 1;\n");
  git(project, "init", "-q");
  git(project, "add", "file.ts");
  git(project, "commit", "-q", "-m", "base");
  const make = () =>
    new Service(f.directory, f.key, () => {}, true, {
      codex: new FixtureCodex(
        (_executable, cwd) =>
          new RpcPeer(
            process.execPath,
            [path.resolve("tests/fixtures/codex-workflow.cjs")],
            cwd,
            nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1", FIXTURE_LOG: log }),
          ),
      ),
    });
  let service = make();
  const entry = { service, directory: f.directory };
  opened.push(entry);
  service.store.put("project", {
    id: "p",
    name: "campaign service fixture",
    path: project,
    realPath: project,
    trusted: true,
    createdAt: now(),
  });
  service.store.put("installation", f.installation);
  await service.start();
  const codex = {
    provider: "codex" as const,
    installationId: f.installation.id,
    model: "fixture-requested",
  };
  const create = (
    options: { objective?: string; checks?: Check[] } = {},
  ): Promise<BuilderReviewerState> =>
    service.command({
      type: "builder-reviewer-create",
      requestId: uid(),
      projectId: "p",
      objective: options.objective ?? "value two",
      acceptanceCriteria: ["value equals two"],
      interfaces: [],
      builder: codex,
      reviewer: codex,
      selectedPaths: ["file.ts"],
      approvedUntracked: [],
      maxRepairs: 2,
      requireIndependence: false,
      checks: options.checks ?? [passing],
    });
  const revision = (id: string) =>
    service.store.get<{ revision: number }>("workflow", id)!.revision;
  const workflow = (id: string) =>
    service.store.get<BuilderReviewerState>("builder-reviewer", id)!;
  const start = (id: string) =>
    service.command(
      {
        type: "builder-reviewer-advance",
        requestId: uid(),
        id,
        expectedRevision: revision(id),
      },
      {
        digest: (service.review("workflow-dispatch-inputs", id) as any).digest,
      },
    );
  const toChecking = async (id: string) => {
    await start(id);
    await vi.waitFor(
      () => expect(["checking", "blocked"]).toContain(workflow(id).stage),
      { timeout: 10_000 },
    );
    expect(workflow(id).stage, workflow(id).detail).toBe("checking");
  };
  const plans = (id: string) =>
    service.command({
      type: "builder-reviewer-checks-preview",
      id,
      expectedRevision: revision(id),
    });
  const applyCheck = (
    plan: { id: string; digest: string },
    digest = plan.digest,
  ) =>
    service.command(
      { type: "builder-reviewer-check-apply", requestId: uid(), id: plan.id },
      { digest },
    );
  const accept = (id: string, digest?: string, requestId = uid()) =>
    service.command(
      {
        type: "builder-reviewer-accept",
        requestId,
        id,
        expectedRevision: revision(id),
      },
      digest ? { digest } : {},
    );
  const cancel = (id: string, expectedRevision = revision(id)) =>
    service.command({
      type: "builder-reviewer-cancel",
      requestId: uid(),
      id,
      expectedRevision,
    });
  const frames = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { from: string; frame: any })
      : [];
  /** Closes the service and starts a new one on the same profile. */
  const restart = async () => {
    await service.close();
    service = entry.service = make();
    await service.start();
  };
  return {
    ...f,
    get service() {
      return service;
    },
    restart,
    project,
    create,
    revision,
    workflow,
    start,
    toChecking,
    plans,
    applyCheck,
    accept,
    cancel,
    frames,
  };
}

describe("BW-21 builder-reviewer-cancel through the service", () => {
  test("BW-21: cancel during a managed Codex build waiting on approval rejects a stale revision, then interrupts, revokes the grant and stops checks; the late answer cannot accept", async () => {
    const f = await setup(),
      state = await f.create({
        objective: "value two [fixture: the build asks first]",
      });
    await f.start(state.id);
    const approval = await vi.waitFor(async () => {
      const listed = (
        await f.service.command({
          type: "builder-reviewer-query",
          projectId: "p",
        })
      ).workflows.find((w: { id: string }) => w.id === state.id).approvals;
      expect(listed).toHaveLength(1);
      return listed[0];
    });
    const building = f.workflow(state.id);
    expect(building.stage).toBe("building");
    const attemptId = building.activeAttemptId!;
    const grant = f.service.store.get<{ grantId: string }>(
      "attempt-context-grant",
      attemptId,
    )!;
    const grants = (
      f.service.context as unknown as {
        grants: Map<string, unknown>;
      }
    ).grants;
    expect(grants.has(grant.grantId)).toBe(true);

    await expect(f.cancel(state.id, f.revision(state.id) - 1)).rejects.toThrow(
      "Workflow changed",
    );
    expect(f.workflow(state.id).stage).toBe("building");
    expect(grants.has(grant.grantId)).toBe(true);
    expect(
      f.service.store.get("check-workflow-cancelled", state.id),
    ).toBeUndefined();

    const cancelled = await f.cancel(state.id);
    expect(cancelled.stage).toBe("cancelled");
    expect(f.service.store.get<any>("workflow", state.id).state).toBe(
      "cancelled",
    );
    expect(grants.has(grant.grantId)).toBe(false);
    expect(
      f.service.store.get("check-workflow-cancelled", state.id),
    ).toBeTruthy();
    // Cancellation requested the managed interruption from the provider; the
    // attempt's outcome stays with the provider until it reports one.
    const turnId = f.service.store.get<any>(
      "run",
      f.service.store.get<ExecutionAttempt>("attempt", attemptId)!.legacyRunId!,
    ).nativeTurnId;
    expect(
      f
        .frames()
        .filter(
          (e) => e.from === "topsl" && e.frame.method === "turn/interrupt",
        )
        .map((e) => e.frame.params.turnId),
    ).toEqual([turnId]);
    const candidates = f.service.store.list("candidate").length;
    // A late owner answer lets the stand-in finish its turn after the cancellation.
    await f.service
      .command(
        { type: "approval-decide", id: approval.id, allow: true },
        { digest: approval.digest },
      )
      .catch(() => undefined);
    await vi.waitFor(() =>
      expect(
        f.service.store.get<ExecutionAttempt>("attempt", attemptId)!.state,
      ).toBe("completed"),
    );
    await expect(
      f.service.command({
        type: "builder-reviewer-advance",
        requestId: uid(),
        id: state.id,
        expectedRevision: f.revision(state.id),
      }),
    ).rejects.toThrow();
    await expect(
      f.accept(
        state.id,
        (f.service.review("workflow-acceptance", state.id) as any).digest,
      ),
    ).rejects.toThrow("Acceptance is stale");
    expect(f.workflow(state.id).stage).toBe("cancelled");
    expect(
      f.service.store.get<any>("workflow", state.id).acceptance,
    ).toBeNull();
    // The late edit stays an attributed attempt result; it is not captured as a candidate.
    expect(f.service.store.list("candidate")).toHaveLength(candidates);
    // No review thread was ever started for the cancelled workflow.
    expect(
      f
        .frames()
        .filter((e) => e.from === "topsl" && e.frame.method === "thread/start"),
    ).toHaveLength(1);
  });

  test(
    "BW-21: a failed managed interruption still revokes the grant and cancels the workflow's checks at the service",
    async () => {
      const f = await setup(),
        state = await f.create({
          objective: "value two [fixture: the build asks first]",
        });
      await f.start(state.id);
      await vi.waitFor(async () =>
        expect(
          (
            await f.service.command({
              type: "builder-reviewer-query",
              projectId: "p",
            })
          ).workflows.find((w: { id: string }) => w.id === state.id).approvals,
        ).toHaveLength(1),
      );
      const attemptId = f.workflow(state.id).activeAttemptId!,
        grant = f.service.store.get<{ grantId: string }>(
          "attempt-context-grant",
          attemptId,
        )!,
        grants = (
          f.service.context as unknown as { grants: Map<string, unknown> }
        ).grants;
      vi.spyOn(f.service.runtime, "interrupt").mockRejectedValueOnce(
        new Error("fixture interrupt failed"),
      );
      await expect(f.cancel(state.id)).rejects.toThrow(
        "fixture interrupt failed",
      );
      expect(f.workflow(state.id).stage).toBe("cancelled");
      expect.soft(grants.has(grant.grantId)).toBe(false);
      expect
        .soft(f.service.store.get("check-workflow-cancelled", state.id))
        .toBeTruthy();
    },
  );

  test("BW-21: cancel while a protected check is running stops that execution; it records no passing evidence and acceptance stays blocked", async () => {
    const f = await setup(),
      marker = path.join(f.directory, "check-started.txt"),
      state = await f.create({
        checks: [
          {
            ...passing,
            args: [
              "-e",
              `require("fs").appendFileSync(${JSON.stringify(marker)},"started\\n");setInterval(()=>{},1000);`,
            ],
          },
        ],
      });
    await f.toChecking(state.id);
    const [plan] = await f.plans(state.id);
    const applying = f.applyCheck(plan);
    await vi.waitFor(() => {
      expect(existsSync(marker)).toBe(true);
      expect(f.service.checks.list("p").executions[0]?.state).toBe("running");
    });
    expect((await f.cancel(state.id)).stage).toBe("cancelled");
    const applied = await applying.catch((error: Error) => error);
    expect(applied instanceof Error ? applied.message : applied.stage).not.toBe(
      "awaiting-acceptance",
    );
    await vi.waitFor(() =>
      expect(f.service.checks.list("p").executions[0].state).toBe("cancelled"),
    );
    expect(f.service.checks.list("p").executions[0].eligibility).toBe(
      "ineligible",
    );
    expect(
      f.service.store
        .list<Verification>("verification")
        .filter((v) => v.result === "passed"),
    ).toEqual([]);
    expect(await readFile(marker, "utf8")).toBe("started\n");
    await expect(
      f.accept(
        state.id,
        (f.service.review("workflow-acceptance", state.id) as any).digest,
      ),
    ).rejects.toThrow("Acceptance is stale");
    // A new plan for the cancelled workflow cannot be prepared.
    await expect(f.plans(state.id)).rejects.toThrow(
      "Current reviewed candidate is required",
    );
  });
});

describe("BW-15 forged, absent, failed or stale verification cannot accept", () => {
  test("BW-15: a model's report without a check run, a forged plan digest and a reused plan cannot accept, and an actual failing check keeps acceptance blocked after the other check passes", async () => {
    const f = await setup(),
      state = await f.create({
        checks: [
          { ...passing, id: "a-pass", label: "value check" },
          {
            ...passing,
            id: "b-fail",
            label: "always fails",
            args: ["-e", "process.exit(1)"],
          },
        ],
      });
    await f.toChecking(state.id);
    // The builder's own report ("Fixture changed value") is not check evidence.
    await expect(
      f.accept(
        state.id,
        (f.service.review("workflow-acceptance", state.id) as any).digest,
      ),
    ).rejects.toThrow("Acceptance is stale or required checks have not passed");
    const [a, b] = (await f.plans(state.id)) as Array<{
      id: string;
      digest: string;
    }>;
    await expect(f.applyCheck(a, "forged-digest")).rejects.toThrow(
      "Check approval is stale. Review a new check plan.",
    );
    expect(f.service.store.list("verification")).toEqual([]);
    expect((await f.applyCheck(b)).stage).toBe("checking");
    await expect(f.applyCheck(b)).rejects.toThrow(
      "Execution authorization is expired, revoked, exhausted, or outside its exact definition/environment/candidate scope. A single-use plan has already been consumed; review a new plan to rerun.",
    );
    const current = f.workflow(state.id);
    const failing = f.service.store
      .list<Verification>("verification")
      .filter((v) => v.definition === "b-fail");
    expect(failing).toEqual([
      expect.objectContaining({
        result: "failed",
        candidateId: current.candidateId,
        taskId: current.checkTaskId,
      }),
    ]);
    // The real passing check runs after the real failure; the failure still governs.
    expect((await f.applyCheck(a)).stage).toBe("checking");
    expect(
      f.service.store
        .list<Verification>("verification")
        .filter((v) => v.definition === "a-pass")
        .map((v) => v.result),
    ).toEqual(["passed"]);
    await expect(
      f.accept(
        state.id,
        (f.service.review("workflow-acceptance", state.id) as any).digest,
      ),
    ).rejects.toThrow(
      "Acceptance is stale or required checks have not passed.",
    );
    expect(
      f.service.store.get<any>("workflow", state.id).acceptance,
    ).toBeNull();
  });

  test("BW-15: a forged passed row for a never-run check that differs from a current binding only in candidate, revision, task or invalidation does not count; the same row with only that property restored does", async () => {
    const f = await setup(),
      state = await f.create({
        checks: [
          { ...passing, id: "a-pass", label: "value check" },
          {
            ...passing,
            id: "b-unrun",
            label: "never run; would fail if it were",
            args: ["-e", "process.exit(1)"],
          },
        ],
      });
    await f.toChecking(state.id);
    const current = f.workflow(state.id),
      revision = f.service.store.get<any>("candidate", current.candidateId)
        .revision as string;
    /** Prepares and applies a fresh plan for the real passing check, which re-evaluates every check. */
    const rerunA = async () => {
      const plan = ((await f.plans(state.id)) as any[]).find(
        (p) => p.definition.id === "a-pass",
      );
      return (await f.applyCheck(plan)).stage;
    };
    expect(await rerunA()).toBe("checking");
    const real = f.service.store
      .list<Verification>("verification")
      .filter((v) => v.definition === "a-pass");
    // The real row is the template: it binds the current task, candidate and revision.
    expect(real).toEqual([
      expect.objectContaining({
        result: "passed",
        taskId: current.checkTaskId,
        candidateId: current.candidateId,
        targetRevision: revision,
      }),
    ]);
    expect(real[0].invalidatedAt ?? null).toBeNull();
    expect(real[0].evidenceArtifactId).toBeTruthy();
    const forge = (change: Partial<Verification>) =>
      f.service.store.immutable("verification", {
        ...real[0],
        id: uid(),
        definition: "b-unrun",
        result: "passed",
        createdAt: now(),
        updatedAt: now(),
        ...change,
      });
    const variants: Array<[string, Partial<Verification>]> = [
      ["another candidate", { candidateId: current.baselineId }],
      ["a stale revision", { targetRevision: "0".repeat(64) }],
      ["another task", { taskId: current.builderTaskId }],
      ["an invalidated row", { invalidatedAt: now() }],
    ];
    for (const [label, change] of variants) {
      // Each variant differs from the template only in its one property.
      expect(Object.keys(change), label).toHaveLength(1);
      expect((change as any)[Object.keys(change)[0]], label).not.toEqual(
        (real[0] as any)[Object.keys(change)[0]] ?? null,
      );
      forge(change);
      expect(await rerunA(), label).toBe("checking");
      expect(f.workflow(state.id).detail, label).toBe(
        "Required checks are incomplete or failing; acceptance is blocked.",
      );
      await expect(
        f.accept(
          state.id,
          (f.service.review("workflow-acceptance", state.id) as any).digest,
        ),
        label,
      ).rejects.toThrow(
        "Acceptance is stale or required checks have not passed.",
      );
    }
    expect(
      f.service.store
        .list<Verification>("verification")
        .filter((v) => v.definition === "b-unrun"),
    ).toHaveLength(4);
    expect(
      f.service.store.get<any>("workflow", state.id).acceptance,
    ).toBeNull();
    // Discriminating control: the same row with every binding intact is read as
    // b-unrun's current result, so each refusal above came from its one changed
    // property. (This row is still a direct store write the check never produced;
    // see the BW-15 observation in the campaign results.)
    forge({});
    expect(await rerunA()).toBe("awaiting-acceptance");
  });

  test("BW-15: source changed after passing checks blocks acceptance at the service, and a workflow with no checks cannot be created", async () => {
    const f = await setup(),
      state = await f.create();
    await f.toChecking(state.id);
    const [plan] = await f.plans(state.id);
    expect((await f.applyCheck(plan)).stage).toBe("awaiting-acceptance");
    const digest = (f.service.review("workflow-acceptance", state.id) as any)
      .digest;
    await writeFile(
      path.join(f.project, "file.ts"),
      "export const value = 2; // external edit after checks\n",
    );
    await expect(f.accept(state.id, digest)).rejects.toThrow("stale");
    expect(
      f.service.store.get<any>("workflow", state.id).acceptance,
    ).toBeNull();
    expect(f.workflow(state.id).stage).not.toBe("accepted");
    expect(() =>
      commandSchema.parse({
        type: "builder-reviewer-create",
        requestId: "r",
        projectId: "p",
        objective: "value two",
        acceptanceCriteria: ["value equals two"],
        builder: { provider: "codex", installationId: "i", model: "m" },
        reviewer: { provider: "codex", installationId: "i", model: "m" },
        checks: [],
      }),
    ).toThrow();
  });
});

describe("BW-14 changed evidence across a service restart", () => {
  test("BW-14: a candidate changed after passing review and checks cannot be accepted after a service restart; the old evidence stays historical", async () => {
    const f = await setup(),
      state = await f.create();
    await f.toChecking(state.id);
    const [plan] = await f.plans(state.id);
    expect((await f.applyCheck(plan)).stage).toBe("awaiting-acceptance");
    const digest = (f.service.review("workflow-acceptance", state.id) as any)
      .digest;
    const passed = f.service.store
      .list<Verification>("verification")
      .filter((v) => v.result === "passed");
    expect(passed).toHaveLength(1);
    await writeFile(
      path.join(f.project, "file.ts"),
      "export const value = 2; // changed while Topsl was closed\n",
    );
    await f.restart();
    await expect(f.accept(state.id, digest)).rejects.toThrow("stale");
    expect(
      f.service.store.get<any>("workflow", state.id).acceptance,
    ).toBeNull();
    // The earlier passing check is retained as a record, not as current evidence.
    expect(
      f.service.store.get<Verification>("verification", passed[0].id),
    ).toMatchObject({ result: "passed", candidateId: passed[0].candidateId });
    await expect(
      f.service.command({
        type: "builder-reviewer-advance",
        requestId: uid(),
        id: state.id,
        expectedRevision: f.revision(state.id),
      }),
    ).resolves.toMatchObject({ stage: "blocked" });
    await expect(
      f.accept(
        state.id,
        (f.service.review("workflow-acceptance", state.id) as any).digest,
      ),
    ).rejects.toThrow();
  });
});

describe("BW-20 explicit acceptance through the service is not publication", () => {
  test("BW-20: acceptance needs the native digest, applies once, replays only its own receipt, and commits, stages or rewrites nothing in Git", async () => {
    const f = await setup(),
      state = await f.create();
    await f.toChecking(state.id);
    const [plan] = await f.plans(state.id);
    expect((await f.applyCheck(plan)).stage).toBe("awaiting-acceptance");
    const head = git(f.project, "rev-parse", "HEAD"),
      commits = git(f.project, "rev-list", "--count", "HEAD"),
      staged = git(f.project, "diff", "--cached", "--name-only"),
      status = git(f.project, "status", "--porcelain"),
      bytes = await readFile(path.join(f.project, "file.ts"), "utf8");
    expect(status).toBe("M file.ts");
    expect(bytes).toBe("export const value = 2;\n");
    const digest = (f.service.review("workflow-acceptance", state.id) as any)
      .digest;
    await expect(f.accept(state.id)).rejects.toThrow("native confirmation");
    const requestId = uid(),
      expectedRevision = f.revision(state.id);
    const accepted = await f.accept(state.id, digest, requestId);
    expect(accepted.stage).toBe("accepted");
    const workflow = f.service.store.get<any>("workflow", state.id);
    expect(workflow.acceptance).toMatchObject({
      digest,
      targetRevision: f.service.store.get<any>(
        "candidate",
        f.workflow(state.id).candidateId,
      ).revision,
    });
    // The same request replays its receipt and changes nothing.
    const replay = await f.service.command(
      {
        type: "builder-reviewer-accept",
        requestId,
        id: state.id,
        expectedRevision,
      },
      { digest },
    );
    expect(replay.stage).toBe("accepted");
    expect(f.service.store.get<any>("workflow", state.id)).toEqual(workflow);
    // A new acceptance request is refused.
    await expect(f.accept(state.id, digest)).rejects.toThrow();
    await expect(
      f.accept(
        state.id,
        (f.service.review("workflow-acceptance", state.id) as any).digest,
      ),
    ).rejects.toThrow("Acceptance is stale");
    expect(f.service.store.get<any>("workflow", state.id)).toEqual(workflow);
    // Acceptance did not commit, stage, or rewrite the working tree.
    expect(git(f.project, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.project, "rev-list", "--count", "HEAD")).toBe(commits);
    expect(git(f.project, "diff", "--cached", "--name-only")).toBe(staged);
    expect(git(f.project, "status", "--porcelain")).toBe(status);
    expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(bytes);
  });
});

describe("BW-01/BW-02 drafts and the captured-input approval through the service", () => {
  test("BW-01: a new draft defaults to Codex/Codex, an older saved pairing is kept, drafts are project-scoped, and a stale save is refused", async () => {
    const f = await setup();
    f.service.store.put("project", {
      id: "q",
      name: "second project",
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    });
    const save = (projectId: string, expectedRevision: number, draft: object) =>
      f.service.command(
        commandSchema.parse({
          type: "workflow-draft-save",
          requestId: uid(),
          projectId,
          workflowId: null,
          expectedRevision,
          draft,
        }),
      );
    const query = (projectId: string) =>
      f.service.command(
        commandSchema.parse({
          type: "workflow-draft-query",
          projectId,
          workflowId: null,
        }),
      );
    const first = (await save("p", 0, { objective: "draft one" })).draft;
    expect([first.draft.builder, first.draft.reviewer]).toEqual([
      "codex",
      "codex",
    ]);
    await expect(save("p", 0, { objective: "lost update" })).rejects.toThrow(
      "changed",
    );
    expect((await query("p")).draft.draft.objective).toBe("draft one");
    // Another project sees none of it.
    expect((await query("q")).draft).toBeNull();
    // A draft saved before the reviewer choice keeps its cross-provider pairing.
    const { reviewer: _, ...older } = { ...first.draft, builder: "claude" };
    f.service.store.put("workflow-draft", { ...first, draft: older });
    expect((await query("p")).draft.draft).toMatchObject({
      builder: "claude",
      reviewer: "codex",
    });
    // A workflow draft cannot be addressed through another project.
    const state = await f.create();
    await expect(
      f.service.command(
        commandSchema.parse({
          type: "workflow-draft-query",
          projectId: "q",
          workflowId: state.id,
        }),
      ),
    ).rejects.toThrow("another project");
  });

  test("BW-02: a source change after the owner reviewed the captured inputs makes the reviewed digest unusable; nothing is dispatched", async () => {
    const f = await setup(),
      state = await f.create();
    const reviewed: any = f.service.review(
      "workflow-dispatch-inputs",
      state.id,
    );
    expect(reviewed.files.map((file: any) => file.path)).toEqual(["file.ts"]);
    await writeFile(
      path.join(f.project, "file.ts"),
      "export const value = 1; // changed before Start\n",
    );
    // The pinned baseline no longer matches the folder: the workflow blocks
    // instead of dispatching the build.
    const result = await f.service.command(
      {
        type: "builder-reviewer-advance",
        requestId: uid(),
        id: state.id,
        expectedRevision: f.revision(state.id),
      },
      { digest: reviewed.digest },
    );
    expect(result.stage).toBe("blocked");
    expect(result.detail).toMatch(/changed|stale/i);
    await expect(
      f.service.command(
        {
          type: "builder-reviewer-advance",
          requestId: uid(),
          id: state.id,
          expectedRevision: f.revision(state.id),
        },
        { digest: reviewed.digest },
      ),
    ).rejects.toThrow();
    expect(f.service.store.list("attempt")).toEqual([]);
    expect(f.service.store.list("run")).toEqual([]);
    expect(f.frames().filter((e) => e.frame.method === "thread/start")).toEqual(
      [],
    );
    // Positive control on the same service, project, stand-in and frame log:
    // once the changed folder is recaptured as a new workflow and its own inputs
    // are reviewed, the build is dispatched and the stand-in sees thread/start.
    // So the empty frame log above is the refusal, not a stand-in that never runs.
    const recaptured = await f.create();
    expect(recaptured.id).not.toBe(state.id);
    const fresh: any = f.service.review(
      "workflow-dispatch-inputs",
      recaptured.id,
    );
    expect(fresh.digest).not.toBe(reviewed.digest);
    // The approval of the earlier capture does not carry over to the recapture.
    await expect(
      f.service.command(
        {
          type: "builder-reviewer-advance",
          requestId: uid(),
          id: recaptured.id,
          expectedRevision: f.revision(recaptured.id),
        },
        { digest: reviewed.digest },
      ),
    ).rejects.toThrow(
      "Review and approve the exact captured input manifest and selected agent assignments before the first dispatch.",
    );
    expect(f.service.store.list("attempt")).toEqual([]);
    expect(f.frames().filter((e) => e.frame.method === "thread/start")).toEqual(
      [],
    );
    await f.service.command(
      {
        type: "builder-reviewer-advance",
        requestId: uid(),
        id: recaptured.id,
        expectedRevision: f.revision(recaptured.id),
      },
      { digest: fresh.digest },
    );
    await vi.waitFor(
      () =>
        expect(
          f
            .frames()
            .filter(
              (e) => e.from === "topsl" && e.frame.method === "thread/start",
            ),
        ).toHaveLength(1),
      { timeout: 10_000 },
    );
    const attempts = f.service.store.list<ExecutionAttempt>("attempt");
    expect(attempts.length).toBeGreaterThan(0);
    expect(
      attempts.every(
        (attempt) =>
          f.service.store.get<any>("task", attempt.taskId)?.workflowId ===
          recaptured.id,
      ),
    ).toBe(true);
    // The refused workflow itself stays blocked and undispatched.
    expect(f.workflow(state.id).stage).toBe("blocked");
    expect(f.workflow(state.id).activeAttemptId ?? null).toBeNull();
  });
});
