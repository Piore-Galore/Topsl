import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fixture } from "./helpers";
import { hash, now, uid } from "../packages/domain/invariants";
import {
  runFile,
  candidatePaths,
  nativeEnvironment,
} from "../packages/platform/system";
import { Coordinator } from "../packages/runtime/coordinator";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { CodexAdapter } from "../packages/providers/codex";
import type { Installation, Run } from "../packages/domain/types";
import type { ProviderCapability } from "../packages/providers/contract";
import {
  ManagedWorkspaces,
  workspacePlanDigest,
} from "../packages/workspace/managed";
import { TaskResourceAllocator } from "../packages/workspace/resources";
import {
  ParallelSpecialists,
  type Specialist,
} from "../packages/workflows/parallel-specialists";
import { executeCheck, previewCheck } from "../packages/workflows/verification";
import {
  assertMaterializedCandidate,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import { Service } from "../apps/service/service";
import { commandSchema, type Command } from "../packages/domain/commands";

class FixtureAdapter extends CodexAdapter {
  capabilities(installation: Installation): ProviderCapability[] {
    return [
      "structured-turn",
      "workspace-write",
      "read-only",
      "native-fanout-disabled",
    ].map((name) => ({
      name,
      route: "structured",
      support: "enforceable",
      versions: [installation.version!],
      testedPlatforms: ["local-fixture"],
      restrictions: [
        "Deterministic fixture creates no children or model requests.",
      ],
      evidence: {
        level: "source-observation",
        source: "local-identity-bound-worker-fixture",
        observedAt: now(),
        detail: "Fixture executable and commands are controlled by this test.",
      },
    }));
  }
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
});
async function setup(
  options: {
    overlap?: boolean;
    delay?: number;
    count?: number;
    unknown?: boolean;
    delayedExit?: number;
  } = {},
) {
  const f = await fixture(),
    source = path.join(f.directory, "source");
  await mkdir(source);
  const git = (await candidatePaths("git")).find((p) => !p.endsWith(".cmd"))!;
  await runFile(git, ["init", source]);
  await runFile(git, ["config", "user.email", "fixture@example.test"], {
    cwd: source,
  });
  await runFile(git, ["config", "user.name", "Local Fixture"], { cwd: source });
  await writeFile(path.join(source, "a.txt"), "0");
  await writeFile(path.join(source, "b.txt"), "0");
  await writeFile(
    path.join(source, "check.cjs"),
    'const f=require("node:fs");const e=process.env;if(!e.TOPSL_TASK_DATABASE||e.TOPSL_TASK_DATABASE.startsWith(process.cwd())||!f.statSync(e.TOPSL_TASK_TEMP).isDirectory())process.exit(2);f.writeFileSync(e.TOPSL_TASK_DATABASE,"isolated fixture database");console.log(e.TOPSL_TASK_RESOURCE_ID);process.exit(Number(f.readFileSync("a.txt"))+Number(f.readFileSync("b.txt"))===2?1:0);',
  );
  await runFile(git, ["add", "."], { cwd: source });
  await runFile(git, ["commit", "-m", "disposable fixture base"], {
    cwd: source,
  });
  const project = {
    id: "project",
    name: "Fixture",
    path: source,
    realPath: source,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  const coordinator = new Coordinator(f.store),
    repository = coordinator.repository,
    managed = new ManagedWorkspaces(
      coordinator,
      path.join(f.directory, "profile"),
    );
  const original = repository.ensureWorkspace(project),
    workflow = repository.createWorkflow({
      projectId: project.id,
      objective: "Combine both specialist outputs",
      template: "parallel-specialists",
      templateVersion: "1",
    });
  const workspaces = [];
  for (let i = 0; i < (options.count ?? 2) + 1; i++) {
    const plan = await managed.previewCreate({
      sourceWorkspaceId: original.id,
      workflowId: workflow.id,
      kind: "worktree",
      dirtyInputPolicy: "clean",
    });
    workspaces.push(await managed.apply(plan.id, plan.digest));
  }
  const adapter = new FixtureAdapter((_exe, cwd) => {
    const peer = new RpcPeer(
      process.execPath,
      [path.resolve("tests/fixtures/parallel-worker.cjs")],
      cwd,
      nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
    );
    if (options.delayedExit) {
      const close = peer.close.bind(peer);
      peer.close = () => {
        setTimeout(close, options.delayedExit);
      };
    }
    return peer;
  });
  const runtime = new RuntimeManager(
    f.store,
    () => {},
    () => {},
    undefined,
    coordinator,
    { codex: adapter },
  );
  const parallel = new ParallelSpecialists(coordinator, managed, {
    capabilities: (installation) =>
      options.unknown
        ? new CodexAdapter().capabilities(installation)
        : adapter.capabilities(installation),
    dispatch: async ({
      attempt,
      task,
      installation,
      project: executionProject,
    }) => {
      const key = task.title,
        conversation = {
          id: uid(),
          projectId: project.id,
          title: key,
          nativeSessions: {},
          createdAt: now(),
        };
      f.store.put("conversation", conversation);
      const input = {
        file: options.overlap || key === "a" ? "a.txt" : "b.txt",
        content: options.overlap && key === "b" ? "2" : "1",
        delay: options.delay ?? 120,
      };
      await runtime.start(
        installation,
        conversation,
        executionProject,
        JSON.stringify(input),
        "fixture-model",
        "edit",
        { attemptId: attempt.id, freshSession: true },
      );
    },
    interrupt: async (attempt) => {
      if (attempt.legacyRunId) await runtime.interrupt(attempt.legacyRunId);
    },
  });
  cleanup.push(async () => {
    runtime.close();
    coordinator.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const specialists: Specialist[] = workspaces.slice(1).map((workspace, i) => ({
    key: String.fromCharCode(97 + i),
    title: String.fromCharCode(97 + i),
    workspaceId: workspace.id,
    provider: "codex",
    installationId: f.installation.id,
    model: "fixture-model",
    permittedOutputs: [options.overlap || i === 0 ? "a.txt" : "b.txt"],
    interfaceRevisionIds: [],
  }));
  const check = {
    id: "combined-check",
    label: "Combined behavior",
    executable: process.execPath,
    args: ["check.cjs"],
    timeoutMs: 3000,
  };
  const state = await parallel.create({
    workflowId: workflow.id,
    integrationWorkspaceId: workspaces[0].id,
    specialists,
    checks: [check],
  });
  return {
    ...f,
    source,
    coordinator,
    repository,
    managed,
    parallel,
    runtime,
    state,
    check,
    workspaces,
    git,
    project,
    original,
  };
}
async function dispatchBoth(f: Awaited<ReturnType<typeof setup>>) {
  let state = await f.parallel.dispatch(f.state.id, f.state.revision, "a");
  state = await f.parallel.dispatch(state.id, state.revision, "b");
  await vi.waitFor(() =>
    expect(f.coordinator.concurrency.snapshot().visibleAttempts).toBe(0),
  );
  state = await f.parallel.submit(state.id, state.revision, "a");
  return await f.parallel.submit(state.id, state.revision, "b");
}
describe("managed parallel workspace safety", () => {
  test("two actual fixture writers share one logical project but separate roots; aliases collide", async () => {
    const f = await setup({ delay: 400 });
    let state = await f.parallel.dispatch(f.state.id, f.state.revision, "a");
    state = await f.parallel.dispatch(state.id, state.revision, "b");
    expect(
      f.store.list<Run>("run").filter((r) => r.status === "running"),
    ).toHaveLength(2);
    expect(f.coordinator.concurrency.snapshot()).toMatchObject({
      visibleAttempts: 2,
      maximumIncludingNativeChildren: 2,
    });
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("0");
    const alias = path.join(f.directory, "alias");
    await symlink(f.workspaces[1].root, alias);
    await expect(
      f.runtime.start(
        f.installation,
        {
          id: uid(),
          projectId: f.project.id,
          title: "Alias",
          nativeSessions: {},
          createdAt: now(),
        },
        { ...f.project, realPath: alias, path: alias },
        "{}",
        "fixture-model",
        "edit",
      ),
    ).rejects.toThrow("already has");
  });
  test("dirty inputs require reviewed capture; digest change and late source edit block creation", async () => {
    const f = await setup();
    await writeFile(path.join(f.source, "a.txt"), "dirty");
    await expect(
      f.managed.previewCreate({
        sourceWorkspaceId: f.original.id,
        workflowId: f.state.id,
        kind: "worktree",
        dirtyInputPolicy: "clean",
      }),
    ).rejects.toThrow("Dirty inputs");
    const plan = await f.managed.previewCreate({
      sourceWorkspaceId: f.original.id,
      workflowId: f.state.id,
      kind: "snapshot",
      dirtyInputPolicy: "reviewed-snapshot",
    });
    expect(
      workspacePlanDigest({ ...plan, root: plan.root + "changed" }),
    ).not.toBe(plan.digest);
    await expect(f.managed.apply(plan.id, "stale")).rejects.toThrow("stale");
    const snapshot = await f.managed.apply(plan.id, plan.digest);
    expect(await readFile(path.join(snapshot.root, "a.txt"), "utf8")).toBe(
      "dirty",
    );
    const late = await f.managed.previewCreate({
      sourceWorkspaceId: f.original.id,
      workflowId: f.state.id,
      kind: "snapshot",
      dirtyInputPolicy: "reviewed-snapshot",
    });
    await writeFile(path.join(f.source, "a.txt"), "new bytes");
    await expect(f.managed.apply(late.id, late.digest)).rejects.toThrow(
      "changed",
    );
  });
  test("worker checks pass but combined checks fail and block acceptance", async () => {
    const f = await setup(),
      state = await dispatchBoth(f);
    for (const worker of state.tasks) {
      const candidate = f.repository.require<CandidateSnapshot>(
        "candidate",
        worker.candidateId!,
      );
      const plan = await previewCheck(
        f.repository,
        state.id,
        worker.taskId,
        candidate,
        f.check,
      );
      expect((await executeCheck(f.repository, plan, plan.digest)).result).toBe(
        "passed",
      );
    }
    await expect(
      f.parallel.accept(
        state.id,
        state.revision,
        f.parallel.acceptanceDigest(state.id),
      ),
    ).rejects.toThrow("combined");
    const plan = await f.parallel.previewIntegration(state.id, state.revision);
    let combined = await f.parallel.applyIntegration(plan.id, plan.digest);
    const [check] = await f.parallel.previewChecks(
      combined.id,
      combined.revision,
    );
    combined = await f.parallel.runCheck(check.id, check.digest);
    expect(combined.stage).toBe("checking");
    expect(
      f.store
        .list<import("../packages/domain/workflow").Verification>(
          "verification",
        )
        .filter((v) => v.candidateId === combined.combinedCandidateId)[0]
        .result,
    ).toBe("failed");
    await expect(
      f.parallel.accept(
        combined.id,
        combined.revision,
        f.parallel.acceptanceDigest(combined.id),
      ),
    ).rejects.toThrow("combined");
  });
  test("overlapping candidates record conflict and preserve all bases until explicit resolution", async () => {
    const f = await setup({ overlap: true }),
      state = await dispatchBoth(f),
      plan = await f.parallel.previewIntegration(state.id, state.revision);
    expect(plan.conflicts[0].path).toBe("a.txt");
    expect(
      await readFile(path.join(f.workspaces[0].root, "a.txt"), "utf8"),
    ).toBe("0");
    const conflicted = f.parallel.state(state.id),
      resolved = await f.parallel.previewIntegration(
        conflicted.id,
        conflicted.revision,
        [{ path: "a.txt", candidateId: state.tasks[0].candidateId! }],
      );
    const result = await f.parallel.applyIntegration(
      resolved.id,
      resolved.digest,
    );
    expect(result.stage).toBe("checking");
    expect(
      await readFile(path.join(f.workspaces[0].root, "a.txt"), "utf8"),
    ).toBe("1");
  });
  test("staged deletion cannot bypass specialist file ownership", async () => {
    const f = await setup(),
      ready = await dispatchBoth(f),
      worker = ready.tasks[0];
    // Retire the submitted record only in this disposable fixture, exercising a new
    // submission boundary for the same completed attempt after controlled edits.
    const baselineState = {
      ...ready,
      tasks: ready.tasks.map((t) =>
        t.key === "a" ? { ...t, candidateId: null } : t,
      ),
      stage: "running" as const,
    };
    f.store.put("parallel-specialists", baselineState);
    await runFile(f.git, ["rm", "check.cjs"], { cwd: f.workspaces[1].root });
    await expect(
      f.parallel.submit(ready.id, ready.revision, "a"),
    ).rejects.toThrow("deleted files outside");
    // The original protected acceptance source cannot be removed merely to pass the
    // checks; the preserved baseline remains available for an explicit repair.
    expect(
      f.store
        .get<CandidateSnapshot>("candidate", worker.baselineId)
        ?.files.some((file) => file.path === "check.cjs" && file.hash),
    ).toBe(true);
  });
  test("accepted combined evidence is invalidated on external edit; stable review bytes and visibility gate", async () => {
    const f = await setup({ overlap: true }),
      state = await dispatchBoth(f);
    const conflict = await f.parallel.previewIntegration(
      state.id,
      state.revision,
    );
    let current = f.parallel.state(state.id);
    const plan = await f.parallel.previewIntegration(
      current.id,
      current.revision,
      [
        {
          path: conflict.conflicts[0].path,
          candidateId: state.tasks[0].candidateId!,
        },
      ],
    );
    current = await f.parallel.applyIntegration(plan.id, plan.digest);
    const [check] = await f.parallel.previewChecks(
      current.id,
      current.revision,
    );
    current = await f.parallel.runCheck(check.id, check.digest);
    expect(current.stage).toBe("awaiting-acceptance");
    const candidate = f.repository.require<CandidateSnapshot>(
      "candidate",
      current.combinedCandidateId!,
    );
    await expect(
      f.parallel.reviewSnapshot(candidate.id, ["filesystem-independent"], []),
    ).rejects.toThrow("independence");
    const pinned = await f.parallel.reviewSnapshot(candidate.id, [], []);
    current = await f.parallel.accept(
      current.id,
      current.revision,
      f.parallel.acceptanceDigest(current.id),
    );
    expect(current.stage).toBe("accepted");
    await writeFile(path.join(candidate.sourceRoot, "a.txt"), "external");
    await assertMaterializedCandidate(candidate, pinned.root);
    await pinned.cleanup();
    current = await f.parallel.observe(current.id);
    expect(current.stage).toBe("blocked");
    expect(
      f.store
        .list<import("../packages/domain/workflow").Verification>(
          "verification",
        )
        .filter((v) => v.candidateId === candidate.id)
        .every((v) => v.invalidatedAt),
    ).toBe(true);
  });
  test("fanout capability gate and third task wait without dispatch or orphan attempt", async () => {
    const unknown = await setup({ unknown: true });
    await expect(
      unknown.parallel.dispatch(unknown.state.id, unknown.state.revision, "a"),
    ).rejects.toThrow("fan-out");
    expect(unknown.store.list("attempt")).toHaveLength(0);
    const f = await setup({ count: 3, delay: 500 });
    let state = await f.parallel.dispatch(f.state.id, f.state.revision, "a");
    state = await f.parallel.dispatch(state.id, state.revision, "b");
    state = await f.parallel.dispatch(state.id, state.revision, "c");
    expect(state.detail).toContain("Waiting for capacity");
    expect(f.store.list("attempt")).toHaveLength(2);
    await vi.waitFor(() =>
      expect(f.coordinator.concurrency.snapshot().visibleAttempts).toBe(0),
    );
    state = await f.parallel.dispatch(state.id, state.revision, "c");
    expect(state.tasks.find((t) => t.key === "c")?.attemptId).toBeTruthy();
  });
  test("completed inference keeps capacity until observed exit and queued dispatch resumes afterward", async () => {
    const f = await setup({ count: 3, delay: 10, delayedExit: 500 });
    let state = await f.parallel.dispatch(f.state.id, f.state.revision, "a");
    state = await f.parallel.dispatch(state.id, state.revision, "b");
    await vi.waitFor(() =>
      expect(
        f.store.list<Run>("run").every((run) => run.status === "completed"),
      ).toBe(true),
    );
    expect(f.coordinator.concurrency.snapshot().visibleAttempts).toBe(2);
    state = await f.parallel.dispatch(state.id, state.revision, "c");
    expect(state.detail).toContain("Waiting for capacity");
    expect(f.store.list("attempt")).toHaveLength(2);
    await vi.waitFor(() =>
      expect(f.coordinator.concurrency.snapshot().visibleAttempts).toBe(0),
    );
    await f.parallel.tick();
    expect(
      f.parallel.state(state.id).tasks.find((task) => task.key === "c")
        ?.attemptId,
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(f.coordinator.concurrency.snapshot().visibleAttempts).toBe(0),
    );
  });
  test("late cancellation evidence stays historical; active cleanup blocked and explicit inactive cleanup retains content", async () => {
    const f = await setup({ delay: 250 });
    let state = await f.parallel.dispatch(f.state.id, f.state.revision, "a");
    await expect(f.managed.previewRemove(f.workspaces[1].id)).rejects.toThrow(
      "Active",
    );
    state = await f.parallel.cancel(state.id, state.revision);
    await vi.waitFor(() =>
      expect(f.coordinator.concurrency.snapshot().visibleAttempts).toBe(0),
    );
    const unchanged = await f.parallel.submit(state.id, state.revision, "a");
    expect(unchanged.stage).toBe("cancelled");
    expect(f.store.list<any>("integration-submission")[0].state).toBe(
      "late-cancelled",
    );
    const plan = await f.managed.previewRemove(f.workspaces[1].id);
    expect((await f.managed.apply(plan.id, plan.digest)).state).toBe("removed");
    expect(f.store.get("candidate", plan.baselineId)).toBeTruthy();
    expect(await readFile(path.join(f.source, "a.txt"), "utf8")).toBe("0");
  });
  test("mutable resources use distinct reserved ports, databases and temp paths outside candidate", async () => {
    const f = await setup(),
      allocator = new TaskResourceAllocator(
        f.store,
        path.join(f.directory, "resources"),
      );
    try {
      const a = await allocator.allocate(f.project.id, f.state.tasks[0].taskId),
        b = await allocator.allocate(f.project.id, f.state.tasks[1].taskId);
      expect(a.port).not.toBe(b.port);
      expect(a.databasePath).not.toBe(b.databasePath);
      expect(a.temporaryDirectory).not.toBe(b.temporaryDirectory);
      expect(a.root.startsWith(f.workspaces[1].root)).toBe(false);
      const handed = await allocator.handoffPort(a.id);
      expect(handed.portState).toBe("handed-off");
      await expect(allocator.handoffPort(a.id)).rejects.toThrow(
        "already handed",
      );
      allocator.retain(a.id);
      allocator.retain(b.id);
    } finally {
      allocator.close();
    }
  });
  test("shared service commands require reviewed workspace/integration actions and report external acceptance drift", async () => {
    const f = await setup();
    // Reopen the same protected profile after the original coordinator relinquishes it.
    // No provider attempt was prepared before this boundary.
    f.runtime.close();
    f.coordinator.close();
    class ServiceFixtureAdapter extends FixtureAdapter {
      startTurn(
        connection: Parameters<CodexAdapter["startTurn"]>[0],
        turn: Parameters<CodexAdapter["startTurn"]>[1],
        nativeSessionId: string,
      ) {
        const context = JSON.parse(turn.prompt);
        return super.startTurn(
          connection,
          {
            ...turn,
            prompt: JSON.stringify({
              file: context.allowedOutputs[0],
              content: "1",
              delay: 150,
            }),
          },
          nativeSessionId,
        );
      }
    }
    const adapter = new ServiceFixtureAdapter(
      (_exe, cwd) =>
        new RpcPeer(
          process.execPath,
          [path.resolve("tests/fixtures/parallel-worker.cjs")],
          cwd,
          nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
        ),
    );
    const service = new Service(f.directory, f.key, () => {}, true, {
      codex: adapter,
    });
    const command = (value: unknown, digest?: string) =>
      service.command(
        commandSchema.parse(value) as Command,
        digest ? { digest } : {},
      );
    try {
      const preview = await command({
        type: "workspace-create-preview",
        sourceWorkspaceId: f.original.id,
        workflowId: f.state.id,
        kind: "snapshot",
        dirtyInputPolicy: "reviewed-snapshot",
      });
      await expect(
        command({
          type: "workspace-plan-apply",
          requestId: uid(),
          id: preview.id,
        }),
      ).rejects.toThrow("native approval");
      const extra = await command(
        { type: "workspace-plan-apply", requestId: uid(), id: preview.id },
        service.review("workspace-plan", preview.id) && preview.digest,
      );
      expect(
        (
          await command({
            type: "managed-workspaces-query",
            projectId: f.project.id,
          })
        ).workspaces.some((w: any) => w.id === extra.id),
      ).toBe(true);
      let state = service.parallel.state(f.state.id);
      state = await command({
        type: "parallel-dispatch",
        requestId: uid(),
        id: state.id,
        expectedRevision: state.revision,
        key: "a",
      });
      state = await command({
        type: "parallel-dispatch",
        requestId: uid(),
        id: state.id,
        expectedRevision: state.revision,
        key: "b",
      });
      await vi.waitFor(() =>
        expect(service.coordinator.concurrency.snapshot().visibleAttempts).toBe(
          0,
        ),
      );
      state = await command({
        type: "parallel-submit",
        requestId: uid(),
        id: state.id,
        expectedRevision: state.revision,
        key: "a",
      });
      state = await command({
        type: "parallel-submit",
        requestId: uid(),
        id: state.id,
        expectedRevision: state.revision,
        key: "b",
      });
      const plan = await command({
        type: "parallel-integration-preview",
        id: state.id,
        expectedRevision: state.revision,
      });
      await expect(
        command({
          type: "parallel-integration-apply",
          requestId: uid(),
          id: plan.id,
        }),
      ).rejects.toThrow("native approval");
      state = await command(
        { type: "parallel-integration-apply", requestId: uid(), id: plan.id },
        plan.digest,
      );
      // This fixture's actual combined behavior deliberately fails, while branch checks
      // passed in the separate regression. Service acceptance must be equally strict.
      const [check] = await command({
        type: "parallel-checks-preview",
        id: state.id,
        expectedRevision: state.revision,
      });
      state = await command(
        { type: "parallel-check-apply", requestId: uid(), id: check.id },
        check.digest,
      );
      expect(state.stage).toBe("checking");
      await writeFile(path.join(f.workspaces[0].root, "a.txt"), "external");
      const observed = await command({
        type: "parallel-query",
        projectId: f.project.id,
      });
      expect(observed.workflows[0].stage).toBe("blocked");
    } finally {
      service.close();
    }
  });
});
