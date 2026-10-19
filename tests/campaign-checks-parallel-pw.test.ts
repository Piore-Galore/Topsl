// Campaign 2026-10-19-comprehensive, packet p5b-checks-parallel.
// Parallel specialist ownership variants (PW-03) and integration-approval races
// (PW-09). The setup mirrors tests/parallel-workspaces.test.ts: real Git
// worktrees, deterministic local stand-in workers, no model or provider account.
import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fixture } from "./helpers";
import { now, uid } from "../packages/domain/invariants";
import {
  runFile,
  candidatePaths,
  nativeEnvironment,
} from "../packages/platform/system";
import { Coordinator } from "../packages/runtime/coordinator";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { CodexAdapter } from "../packages/providers/codex";
import type { Installation } from "../packages/domain/types";
import type { Task, Workspace } from "../packages/domain/workflow";
import type { ProviderCapability } from "../packages/providers/contract";
import { ManagedWorkspaces } from "../packages/workspace/managed";
import {
  ParallelSpecialists,
  type Specialist,
} from "../packages/workflows/parallel-specialists";
import type { CandidateSnapshot } from "../packages/workflows/candidates";

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
  options: { overlap?: boolean; outputs?: string[][] } = {},
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
    'const f=require("node:fs");process.exit(Number(f.readFileSync("a.txt"))>=1?0:1);',
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
  for (let i = 0; i < 3; i++) {
    const plan = await managed.previewCreate({
      sourceWorkspaceId: original.id,
      workflowId: workflow.id,
      kind: "worktree",
      dirtyInputPolicy: "clean",
    });
    workspaces.push(await managed.apply(plan.id, plan.digest));
  }
  const peers: RpcPeer[] = [];
  const adapter = new FixtureAdapter((_exe, cwd) => {
    const peer = new RpcPeer(
      process.execPath,
      [path.resolve("tests/fixtures/parallel-worker.cjs")],
      cwd,
      nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
    );
    peers.push(peer);
    return peer;
  });
  const runtime = new RuntimeManager(
    f.store,
    () => {},
    () => {},
    undefined,
    coordinator,
    { codex: adapter },
    true, // Explicit isolated fixture constructor; never live runtime qualification.
  );
  const parallel = new ParallelSpecialists(coordinator, managed, {
    capabilities: (installation) => adapter.capabilities(installation),
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
        hold: false,
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
    await runtime.close();
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
    permittedOutputs: options.outputs?.[i] ?? [
      options.overlap || i === 0 ? "a.txt" : "b.txt",
    ],
    interfaceRevisionIds: [],
  }));
  const check = {
    id: "combined-check",
    label: "Combined behavior",
    executable: process.execPath,
    args: ["check.cjs"],
    timeoutMs: 30_000,
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
    workspaces,
    git,
    project,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function dispatchBoth(f: Fixture) {
  let state = await f.parallel.dispatch(f.state.id, f.state.revision, "a");
  state = await f.parallel.dispatch(state.id, state.revision, "b");
  await vi.waitFor(() =>
    expect(f.coordinator.concurrency.snapshot().visibleAttempts).toBe(0),
  );
  state = await f.parallel.submit(state.id, state.revision, "a");
  return await f.parallel.submit(state.id, state.revision, "b");
}
/** As in parallel-workspaces.test.ts:403, retire specialist a's submitted
 * record in this disposable fixture so the same completed attempt crosses a
 * new submission boundary after controlled workspace edits. */
function reopenSubmission(f: Fixture) {
  const current = f.parallel.state(f.state.id);
  f.store.put("parallel-specialists", {
    ...current,
    tasks: current.tasks.map((t) =>
      t.key === "a" ? { ...t, candidateId: null } : t,
    ),
    stage: "running" as const,
  });
  return f.parallel.state(f.state.id);
}
const submissions = (f: Fixture) =>
  f.store.list<any>("integration-submission").length;

describe("PW-03 specialist ownership variants", () => {
  test("PW-03: rename into or out of ownership and an approved untracked file outside ownership are each rejected; the owned edit alone is accepted", async () => {
    const f = await setup(),
      ready = await dispatchBoth(f),
      root = f.workspaces[1].root,
      git = (args: string[]) => runFile(f.git, args, { cwd: root });
    expect(ready.stage).toBe("submitted");
    let state = reopenSubmission(f);
    const before = submissions(f);
    const rejectSubmit = async (approvedUntracked: string[] = []) => {
      await expect(
        f.parallel.submit(state.id, state.revision, "a", approvedUntracked),
      ).rejects.toThrow(/outside the agreed specialist outputs|agreed outputs/);
      expect(submissions(f)).toBe(before);
      expect(f.parallel.state(state.id).tasks[0].candidateId).toBeNull();
    };
    // Plain content edit of an unowned file (the message is pinned here; the
    // separate expected-failure test records that it omits the path).
    await writeFile(path.join(root, "b.txt"), "unowned edit");
    await expect(
      f.parallel.submit(state.id, state.revision, "a"),
    ).rejects.toThrow(
      "Candidate changed or deleted files outside the agreed specialist outputs. Resolve ownership before submitting.",
    );
    await writeFile(path.join(root, "b.txt"), "0");
    // Staged rename of an unowned file.
    await git(["mv", "b.txt", "renamed-b.txt"]);
    await rejectSubmit();
    await git(["mv", "renamed-b.txt", "b.txt"]);
    // Staged rename of the owned file to an unowned name.
    await git(["mv", "a.txt", "moved-a.txt"]);
    await rejectSubmit();
    await git(["mv", "moved-a.txt", "a.txt"]);
    // The executable-bit variant is the separate POSIX-only test below.
    // An untracked file approved as output but outside ownership.
    await writeFile(path.join(root, "stray.txt"), "stray");
    await expect(
      f.parallel.submit(state.id, state.revision, "a", ["stray.txt"]),
    ).rejects.toThrow(
      "Untracked output must be part of the specialist's agreed outputs",
    );
    expect(submissions(f)).toBe(before);
    await rm(path.join(root, "stray.txt"));
    // Positive control: with every variant reverted, the owned edit submits.
    state = await f.parallel.submit(state.id, state.revision, "a");
    expect(state.stage).toBe("submitted");
    const candidate = f.repository.require<CandidateSnapshot>(
      "candidate",
      state.tasks[0].candidateId!,
    );
    expect(candidate.files.find((file) => file.path === "a.txt")?.change).toBe(
      "modified",
    );
    expect(
      candidate.files
        .filter((file) => file.change !== "unchanged")
        .map((file) => file.path),
    ).toEqual(["a.txt"]);
  });

  // Windows has no executable permission bit: chmod there only toggles the
  // read-only attribute, so a "mode change with identical bytes" cannot be
  // produced and the candidate correctly sees no change. Unverified on
  // Windows: whether a git-index-only mode change (update-index --chmod) on an
  // unowned file is rejected.
  test.skipIf(process.platform === "win32")(
    "PW-03: an executable-bit change on an unowned file with identical bytes is rejected; reverted, the owned edit is accepted",
    async () => {
      const f = await setup(),
        ready = await dispatchBoth(f),
        root = f.workspaces[1].root;
      expect(ready.stage).toBe("submitted");
      let state = reopenSubmission(f);
      const before = submissions(f);
      const mode = (await stat(path.join(root, "b.txt"))).mode & 0o777;
      await chmod(path.join(root, "b.txt"), mode | 0o111);
      await expect(
        f.parallel.submit(state.id, state.revision, "a"),
      ).rejects.toThrow(/outside the agreed specialist outputs|agreed outputs/);
      expect(submissions(f)).toBe(before);
      expect(f.parallel.state(state.id).tasks[0].candidateId).toBeNull();
      await chmod(path.join(root, "b.txt"), mode);
      state = await f.parallel.submit(state.id, state.revision, "a");
      expect(state.stage).toBe("submitted");
    },
  );

  test("PW-03: an owned untracked output is accepted only when approved, and an unapproved stray file never enters the candidate or integration", async () => {
    const f = await setup({ outputs: [["a.txt", "new-a.txt"], ["b.txt"]] }),
      ready = await dispatchBoth(f),
      root = f.workspaces[1].root;
    expect(ready.stage).toBe("submitted");
    let state = reopenSubmission(f);
    await writeFile(path.join(root, "new-a.txt"), "owned new output");
    await writeFile(path.join(root, "stray.txt"), "unowned stray");
    state = await f.parallel.submit(state.id, state.revision, "a", [
      "new-a.txt",
    ]);
    const candidate = f.repository.require<CandidateSnapshot>(
      "candidate",
      state.tasks[0].candidateId!,
    );
    expect(candidate.files.map((file) => file.path)).toContain("new-a.txt");
    expect(candidate.files.map((file) => file.path)).not.toContain("stray.txt");
    // The unapproved stray file stays visible as an unapproved omission.
    expect(
      candidate.omissions.find((o) => o.source === "stray.txt")?.reason,
    ).toContain("not approved");
    const plan = await f.parallel.previewIntegration(state.id, state.revision);
    expect(plan.conflicts).toEqual([]);
    expect(plan.files.map((file) => file.path)).toContain("new-a.txt");
    expect(plan.files.map((file) => file.path)).not.toContain("stray.txt");
  });

  // CAMPAIGN DEFECT PW-03: the ownership refusal does not name the changed path the plan requires.
  test.fails(
    "PW-03: the ownership refusal names the exact changed path outside ownership",
    async () => {
      const f = await setup();
      await dispatchBoth(f);
      const state = reopenSubmission(f);
      await writeFile(path.join(f.workspaces[1].root, "b.txt"), "unowned edit");
      await expect(
        f.parallel.submit(state.id, state.revision, "a"),
      ).rejects.toThrow("b.txt");
    },
  );
});

describe("PW-09 integration approval races", () => {
  test("PW-09: candidate, base or writer changes after review block apply without consuming it; concurrent applies write once; a sibling plan reviewed at the same revision goes stale", async () => {
    const f = await setup({ overlap: true }),
      state = await dispatchBoth(f),
      [candidateA, candidateB] = state.tasks.map((t) => t.candidateId!),
      integration = f.workspaces[0].root,
      specialistB = f.workspaces[2].root;
    const conflicted = await f.parallel.previewIntegration(
      state.id,
      state.revision,
    );
    expect(conflicted.conflicts.map((c) => c.path)).toEqual(["a.txt"]);
    await expect(
      f.parallel.applyIntegration(conflicted.id, conflicted.digest),
    ).rejects.toThrow(
      // Recording the conflict advanced the workflow revision, so the
      // conflicted plan is already stale before its conflicts are examined.
      /revision changed|Resolve the recorded conflicts/,
    );
    const current = f.parallel.state(state.id);
    const chooseA = await f.parallel.previewIntegration(
      current.id,
      current.revision,
      [{ path: "a.txt", candidateId: candidateA }],
    );
    const chooseB = await f.parallel.previewIntegration(
      current.id,
      current.revision,
      [{ path: "a.txt", candidateId: candidateB }],
    );
    const untouched = async () => {
      expect(f.store.list("integration-plan-consumed")).toHaveLength(0);
      expect(
        f.store.list<Task>("task").filter((t) => t.role === "integrator"),
      ).toHaveLength(0);
      expect(await readFile(path.join(integration, "a.txt"), "utf8")).toBe("0");
      expect(f.parallel.state(state.id).revision).toBe(current.revision);
    };
    // Wrong digest.
    await expect(
      f.parallel.applyIntegration(chooseA.id, "0".repeat(64)),
    ).rejects.toThrow("stale or consumed");
    await untouched();
    // A submitted candidate's bytes change after review.
    await writeFile(path.join(specialistB, "a.txt"), "tampered");
    await expect(
      f.parallel.applyIntegration(chooseA.id, chooseA.digest),
    ).rejects.toThrow(/Candidate (bytes|tracked-file manifest) changed/);
    await untouched();
    await writeFile(path.join(specialistB, "a.txt"), "2");
    // The integration base changes after review.
    await writeFile(path.join(integration, "b.txt"), "external");
    await expect(
      f.parallel.applyIntegration(chooseA.id, chooseA.digest),
    ).rejects.toThrow(/Candidate (bytes|tracked-file manifest) changed/);
    await untouched();
    await writeFile(path.join(integration, "b.txt"), "0");
    // Another writer holds the integration workspace.
    const workspace = f.repository.require<Workspace>(
      "workspace",
      f.workspaces[0].id,
    );
    const lease = f.coordinator.ownership.acquire(workspace, "foreign-writer");
    await expect(
      f.parallel.applyIntegration(chooseA.id, chooseA.digest),
    ).rejects.toThrow(
      "Active or uncertain workspace cannot be copied, integrated",
    );
    await untouched();
    f.coordinator.ownership.release("foreign-writer", lease.generation, {
      level: "topsl-transaction",
      source: "campaign-fixture",
      observedAt: now(),
      detail: "Fixture writer released; it never wrote.",
    });
    // Two concurrent applies of the same reviewed plan: exactly one writes.
    const results = await Promise.allSettled([
      f.parallel.applyIntegration(chooseA.id, chooseA.digest),
      f.parallel.applyIntegration(chooseA.id, chooseA.digest),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<any>).value.stage).toBe(
      "checking",
    );
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.message,
    ).toMatch(/consumed|revision changed/);
    expect(f.store.list("integration-plan-consumed")).toHaveLength(1);
    expect(
      f.store.list<Task>("task").filter((t) => t.role === "integrator"),
    ).toHaveLength(1);
    expect(await readFile(path.join(integration, "a.txt"), "utf8")).toBe("1");
    // The sibling plan reviewed at the same revision cannot apply afterwards.
    await expect(
      f.parallel.applyIntegration(chooseB.id, chooseB.digest),
    ).rejects.toThrow(/revision changed|stale|consumed/);
    expect(await readFile(path.join(integration, "a.txt"), "utf8")).toBe("1");
    expect(f.store.list("integration-plan-consumed")).toHaveLength(1);
    // Replaying the consumed plan is refused.
    await expect(
      f.parallel.applyIntegration(chooseA.id, chooseA.digest),
    ).rejects.toThrow(/consumed|revision changed/);
  });
});
