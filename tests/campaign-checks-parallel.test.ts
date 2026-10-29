// Campaign 2026-10-19-comprehensive, packet p5b-checks-parallel.
// Protected check execution, reconciliation, cleanup, authorization and mode
// boundaries (plan sections 5.17, 6.1 and 6.2). Every test runs real local
// check subprocesses against a temporary encrypted store; no provider,
// account, network or installer is used.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fixture } from "./helpers";
import { now, uid } from "../packages/domain/invariants";
import { captureCandidate } from "../packages/workflows/candidates";
import { bindCheckInputs } from "../packages/workflows/check-inputs";
import {
  previewCheck,
  reuseCheckAuthorization,
  type CheckDefinition,
  type CheckPlan,
} from "../packages/workflows/verification";
import {
  CheckExecutions,
  type CheckExecution,
  type CheckLog,
  type CleanupJob,
} from "../packages/workflows/check-executions";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import { Store } from "../packages/persistence/store";
import {
  processGroupPresent,
  type ProcessEvidence,
} from "../packages/runtime/process-lifecycle";
import { nativeEnvironment } from "../packages/platform/system";
import { Service } from "../apps/service/service";
import { commandSchema, type Command } from "../packages/domain/commands";
import { requiredCheckSchema } from "../packages/domain/orchestration-commands";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const action of cleanup.splice(0)) {
    try {
      await action();
    } catch {}
  }
});
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const lines = async (file: string) =>
  (await readFile(file, "utf8")).split("\n").filter(Boolean);
const killGroup = (group: number) => {
  try {
    process.kill(-group, "SIGKILL");
  } catch {}
};

/** Mirrors tests/durable-executions.test.ts setup: a pinned non-Git candidate,
 * a frozen check definition and a reviewed (unconsumed) check plan. */
async function checkSetup(
  options: {
    program?: (marker: string) => string;
    timeoutMs?: number;
    policy?: CheckDefinition["executionPolicy"];
  } = {},
) {
  const f = await fixture(),
    source = path.join(f.directory, "source"),
    marker = path.join(f.directory, "effects.txt");
  await mkdir(source);
  await writeFile(path.join(source, "value.js"), "export const value=1;\n");
  const repository = new CoordinationRepository(f.store),
    project = {
      id: "p",
      name: "Campaign checks",
      path: source,
      realPath: source,
      trusted: true,
      createdAt: now(),
    };
  f.store.put("project", project);
  f.store.put("project", {
    ...project,
    id: "q",
    name: "Foreign project",
    path: f.directory,
    realPath: f.directory,
  });
  const workspace = repository.ensureWorkspace(project),
    workflow = repository.createWorkflow({
      projectId: project.id,
      objective: "Campaign check boundaries",
      template: "fixture",
      templateVersion: "1",
    });
  const task = repository.createTask({
    projectId: project.id,
    workflowId: workflow.id,
    workspaceId: workspace.id,
    title: "Check",
    role: "tester",
  });
  const candidate = await captureCandidate(f.store, {
    root: source,
    projectId: project.id,
    workflowId: workflow.id,
    selectedPaths: ["value.js"],
  });
  const definition: CheckDefinition = {
    id: "campaign-check",
    label: "One effect",
    executable: process.execPath,
    args: [
      "-e",
      options.program?.(marker) ??
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'effect\\n');console.log('completed');`,
    ],
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.policy ? { executionPolicy: options.policy } : {}),
  };
  bindCheckInputs(f.store, workflow.id, candidate, [definition]);
  const plan = await previewCheck(
    repository,
    workflow.id,
    task.id,
    candidate,
    definition,
  );
  cleanup.push(async () => {
    try {
      f.store.close();
    } catch {}
    await rm(f.directory, { recursive: true, force: true });
  });
  return {
    ...f,
    source,
    marker,
    repository,
    project,
    workflow,
    task,
    candidate,
    definition,
    plan,
  };
}

/** Reopens the same protected profile through the production service, as
 * R2-AT-04 does, and exposes public commands through the command schema. */
async function serviceSetup(options: Parameters<typeof checkSetup>[0] = {}) {
  const f = await checkSetup(options);
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  cleanup.unshift(async () => {
    await service.close();
  });
  const command = (value: Record<string, unknown>) =>
    service.command(commandSchema.parse(value) as Command);
  return { ...f, store: service.store, service, command };
}

/** Restores write permission on directories a check made read-only, so the
 * temporary tree can be removed after the test. */
async function unlockTree(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await chmod(root, 0o700).catch(() => {});
  for (const entry of entries)
    if (entry.isDirectory()) await unlockTree(path.join(root, entry.name));
}

describe("CK-16 public check-execution-reconcile", () => {
  test("CK-16: a lost passing result is never reconstructed; observed absence gives error/ineligible, releases the lock and creates cleanup", async () => {
    const f = await serviceSetup();
    // Injected final-commit failure after an exit-0 check: the effect happened,
    // but no durable pass exists (R2-AT-06 fault, here behind the service).
    const injected = new CheckExecutions(f.store, {
      beforeFinalCommit: () => {
        throw new Error("SQLITE_FULL injected");
      },
    });
    await expect(
      injected.execute(f.service.coordinator.repository, f.plan, f.plan.digest),
    ).rejects.toThrow("No durable pass");
    const original = f.store.list<CheckExecution>("check-execution")[0];
    expect(original).toMatchObject({
      state: "uncertain",
      eligibility: "uncertain",
      verificationId: null,
    });
    expect(original.lifecycle).toMatchObject({
      state: "quiescent",
      exitCode: 0,
    });
    expect(
      f.store.get<any>("check-workspace-lock", f.candidate.workspaceIdentity),
    ).toMatchObject({ executionId: original.id, held: true });
    expect(f.store.list("check-cleanup")).toHaveLength(0);
    expect(await lines(f.marker)).toEqual(["effect"]);

    // Wrong scope: another existing project, an unknown project, a replica.
    await expect(
      f.command({
        type: "check-execution-reconcile",
        requestId: uid(),
        projectId: "q",
        id: original.id,
      }),
    ).rejects.toThrow("outside this project");
    await expect(
      f.command({
        type: "check-execution-reconcile",
        requestId: uid(),
        projectId: "missing-project",
        id: original.id,
      }),
    ).rejects.toThrow();
    f.store.put("replication-shared-project", { id: "p" });
    await expect(
      f.command({
        type: "check-execution-reconcile",
        requestId: uid(),
        projectId: "p",
        id: original.id,
      }),
    ).rejects.toThrow("Shared project authority is unknown");
    f.store.remove("replication-shared-project", "p");
    // None of the refusals changed the execution, lock or cleanup state.
    expect(f.store.get("check-execution", original.id)).toEqual(original);
    expect(
      f.store.get<any>("check-workspace-lock", f.candidate.workspaceIdentity)
        .held,
    ).toBe(true);
    expect(f.store.list("check-cleanup")).toHaveLength(0);

    const requestId = uid();
    const reconciled: CheckExecution = await f.command({
      type: "check-execution-reconcile",
      requestId,
      projectId: "p",
      id: original.id,
    });
    expect(reconciled).toMatchObject({
      state: "error",
      eligibility: "ineligible",
      verificationId: null,
    });
    expect(reconciled.lifecycle).toMatchObject({
      pid: original.lifecycle!.pid,
      state: "quiescent",
      remainingGroup: "absent",
    });
    // Authoritative rows: no pass was synthesized and nothing was relaunched.
    expect(f.store.get("check-execution", original.id)).toMatchObject({
      state: "error",
      eligibility: "ineligible",
    });
    expect(f.store.list("verification")).toHaveLength(0);
    expect(f.store.list("protected-check-output")).toHaveLength(0);
    expect(f.store.list("check-dispatch-intent")).toHaveLength(1);
    expect(f.store.list("check-execution")).toHaveLength(1);
    expect(
      f.store.get<any>("check-workspace-lock", f.candidate.workspaceIdentity),
    ).toMatchObject({ executionId: original.id, held: false });
    const jobs = f.store.list<CleanupJob>("check-cleanup");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      executionId: original.id,
      state: "pending",
      attempts: 0,
      roots: original.ownedRoots,
    });
    expect(await lines(f.marker)).toEqual(["effect"]);
    // The consumed approval still cannot launch the command again.
    await expect(
      f.service.checks.execute(
        f.service.coordinator.repository,
        f.plan,
        f.plan.digest,
      ),
    ).rejects.toThrow(/consumed|exhausted/);
    // Replaying the same request returns its receipt; a new request is refused
    // because the execution is no longer uncertain.
    expect(
      (
        await f.command({
          type: "check-execution-reconcile",
          requestId,
          projectId: "p",
          id: original.id,
        })
      ).state,
    ).toBe("error");
    await expect(
      f.command({
        type: "check-execution-reconcile",
        requestId: uid(),
        projectId: "p",
        id: original.id,
      }),
    ).rejects.toThrow("Only an inactive uncertain execution");
    expect(f.store.list("check-cleanup")).toHaveLength(1);

    const cleaned: CleanupJob = await f.command({
      type: "check-cleanup-retry",
      requestId: uid(),
      projectId: "p",
      id: jobs[0].id,
    });
    expect(cleaned.state).toBe("completed");
    for (const root of original.ownedRoots)
      await expect(stat(root.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.store.list("verification")).toHaveLength(0);
    expect(await lines(f.marker)).toEqual(["effect"]);
  });

  test.skipIf(process.platform === "win32")(
    "CK-16: identity matrix — missing identity, present PID, present or unknown group, and every non-uncertain state preserve the block; absent PID and group requeue the existing cleanup",
    async () => {
      const f = await serviceSetup();
      // A real completed execution supplies a realistic record to vary.
      expect(
        (
          await f.service.checks.execute(
            f.service.coordinator.repository,
            f.plan,
            f.plan.digest,
          )
        ).result,
      ).toBe("passed");
      const real = f.store.list<CheckExecution>("check-execution")[0];
      const lifecycle = real.lifecycle as ProcessEvidence;
      expect(lifecycle).toMatchObject({
        scope: "posix-process-group",
        state: "quiescent",
      });
      const spare = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "topsl-campaign-roots-")),
      );
      cleanup.push(() => rm(spare, { recursive: true, force: true }));
      const groups: number[] = [];
      cleanup.unshift(async () => groups.forEach(killGroup));
      /** One synthetic durable execution with a held lock and a blocked cleanup
       * job over a real owned directory. */
      const variant = async (name: string, patch: Partial<CheckExecution>) => {
        const id = `variant-${name}`,
          root = path.join(spare, name);
        await mkdir(root);
        await writeFile(path.join(root, "owned.txt"), name);
        const rootStat = await stat(root);
        const execution: CheckExecution = {
          ...real,
          id,
          state: "uncertain",
          eligibility: "uncertain",
          verificationId: null,
          error: "Service restarted during a check.",
          ownedRoots: [
            {
              root,
              realPath: root,
              dev: String(rootStat.dev),
              ino: String(rootStat.ino),
            },
          ],
          ...patch,
        };
        f.store.put("check-execution", execution);
        f.store.put("check-workspace-lock", {
          id: `lock-${id}`,
          executionId: id,
          projectId: "p",
          held: true,
        });
        const job: CleanupJob = {
          version: 1,
          id: `cleanup-${id}`,
          projectId: "p",
          executionId: id,
          state: "blocked-by-active-process",
          roots: execution.ownedRoots,
          attempts: 0,
          error: null,
          createdAt: now(),
          updatedAt: now(),
        };
        f.store.put("check-cleanup", job);
        return { id, root, execution, job };
      };
      const reconcile = (id: string) =>
        f.command({
          type: "check-execution-reconcile",
          requestId: uid(),
          projectId: "p",
          id,
        });
      const assertPreserved = async (
        v: Awaited<ReturnType<typeof variant>>,
      ) => {
        expect(f.store.get("check-execution", v.id)).toEqual(v.execution);
        expect(
          f.store.get<any>("check-workspace-lock", `lock-${v.id}`).held,
        ).toBe(true);
        expect(f.store.get<CleanupJob>("check-cleanup", v.job.id)!.state).toBe(
          "blocked-by-active-process",
        );
        // Cleanup cannot bypass the block either.
        const retried: CleanupJob = await f.command({
          type: "check-cleanup-retry",
          requestId: uid(),
          projectId: "p",
          id: v.job.id,
        });
        expect(retried.state).toBe("blocked-by-active-process");
        expect(await readFile(path.join(v.root, "owned.txt"), "utf8")).toBe(
          path.basename(v.root),
        );
      };

      // Identity missing: no lifecycle and no preparation lifecycle.
      const missing = await variant("identity-missing", {
        lifecycle: null,
        failurePhase: null,
      });
      await expect(reconcile(missing.id)).rejects.toThrow(
        "No native process identity survived",
      );
      await assertPreserved(missing);
      const missingPid = await variant("pid-null", {
        lifecycle: { ...lifecycle, pid: null },
      });
      await expect(reconcile(missingPid.id)).rejects.toThrow(
        "No native process identity survived",
      );
      await assertPreserved(missingPid);

      // Original PID still present.
      const live = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},10000)"],
        {
          env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
          stdio: "ignore",
          detached: true,
        },
      );
      groups.push(live.pid!);
      const present = await variant("pid-present", {
        lifecycle: { ...lifecycle, pid: live.pid!, groupId: live.pid! },
      });
      await expect(reconcile(present.id)).rejects.toThrow(
        "Original process identity is still present",
      );
      await assertPreserved(present);

      // Original PID absent, owned group member still present.
      const leader = spawn(
        process.execPath,
        [
          "-e",
          "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore',env:process.env});console.log(c.pid);c.unref();",
        ],
        {
          env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
          stdio: ["ignore", "pipe", "ignore"],
          detached: true,
        },
      );
      groups.push(leader.pid!);
      const leaderExit = new Promise((resolve) => leader.once("exit", resolve));
      const member = await new Promise<number>((resolve) =>
        leader.stdout!.once("data", (bytes) =>
          resolve(Number(String(bytes).trim())),
        ),
      );
      await leaderExit;
      expect(() => process.kill(leader.pid!, 0)).toThrow();
      expect(() => process.kill(member, 0)).not.toThrow();
      expect(processGroupPresent(leader.pid!)).toBe(true);
      const group = await variant("group-present", {
        lifecycle: { ...lifecycle, pid: leader.pid!, groupId: leader.pid! },
      });
      await expect(reconcile(group.id)).rejects.toThrow(
        "Owned descendants are present or unknown",
      );
      await assertPreserved(group);

      // Original PID absent, group identity unknown (no group recorded and no
      // descendant observation available on this platform).
      const gone = spawn(process.execPath, ["-e", "process.exit(0)"], {
        env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
        stdio: "ignore",
        detached: true,
      });
      await new Promise((resolve) => gone.once("exit", resolve));
      expect(processGroupPresent(gone.pid!)).toBe(false);
      const unknown = await variant("group-unknown", {
        lifecycle: {
          ...lifecycle,
          pid: gone.pid!,
          groupId: null,
          scope: "child-and-stdio",
        },
      });
      await expect(reconcile(unknown.id)).rejects.toThrow(
        "Owned descendants are present or unknown",
      );
      await assertPreserved(unknown);

      // Every non-uncertain state is refused, including a stale running row.
      for (const state of [
        "prepared",
        "dispatching",
        "running",
        "stopping",
        "passed",
        "failed",
        "error",
        "cancelled",
      ] as const) {
        const v = await variant(`state-${state}`, {
          state,
          eligibility: state === "passed" ? "eligible" : "ineligible",
          lifecycle: { ...lifecycle, pid: gone.pid!, groupId: gone.pid! },
        });
        await expect(reconcile(v.id)).rejects.toThrow(
          "Only an inactive uncertain execution",
        );
        expect(f.store.get("check-execution", v.id)).toEqual(v.execution);
        expect(
          f.store.get<any>("check-workspace-lock", `lock-${v.id}`).held,
        ).toBe(true);
      }
      // Foreign project for an otherwise reconcilable record.
      const absent = await variant("absent", {
        lifecycle: { ...lifecycle, pid: gone.pid!, groupId: gone.pid! },
      });
      await expect(
        f.command({
          type: "check-execution-reconcile",
          requestId: uid(),
          projectId: "q",
          id: absent.id,
        }),
      ).rejects.toThrow("outside this project");
      expect(f.store.get("check-execution", absent.id)).toEqual(
        absent.execution,
      );

      // Positive control: PID and group both observed absent.
      const verifications = f.store.list("verification").length,
        intents = f.store.list("check-dispatch-intent").length;
      const done: CheckExecution = await reconcile(absent.id);
      expect(done).toMatchObject({
        state: "error",
        eligibility: "ineligible",
        verificationId: null,
      });
      expect(
        f.store.get<any>("check-workspace-lock", `lock-${absent.id}`).held,
      ).toBe(false);
      const jobs = f.store
        .list<CleanupJob>("check-cleanup")
        .filter((j) => j.executionId === absent.id);
      expect(jobs).toEqual([
        expect.objectContaining({ id: absent.job.id, state: "pending" }),
      ]);
      expect(f.store.list("verification")).toHaveLength(verifications);
      expect(f.store.list("check-dispatch-intent")).toHaveLength(intents);
      const cleaned: CleanupJob = await f.command({
        type: "check-cleanup-retry",
        requestId: uid(),
        projectId: "p",
        id: absent.job.id,
      });
      expect(cleaned.state).toBe("completed");
      await expect(stat(absent.root)).rejects.toMatchObject({ code: "ENOENT" });
      // The variant whose group is still alive kept its directory.
      expect((await stat(group.root)).isDirectory()).toBe(true);
    },
  );

  test("CK-16: an execution still owned by this service is refused even when its row reads uncertain", async () => {
    const f = await serviceSetup({
      program: (marker) =>
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'effect\\n');console.log('ready');setInterval(()=>{},10000);`,
    });
    const running = f.service.checks.execute(
      f.service.coordinator.repository,
      f.plan,
      f.plan.digest,
    );
    await vi.waitFor(() =>
      expect(
        f.store
          .list<CheckLog>("check-log")
          .map((l) => l.text)
          .join(""),
      ).toContain("ready"),
    );
    const row = f.store.list<CheckExecution>("check-execution")[0];
    expect(row.state).toBe("running");
    await expect(
      f.command({
        type: "check-execution-reconcile",
        requestId: uid(),
        projectId: "p",
        id: row.id,
      }),
    ).rejects.toThrow("Only an inactive uncertain execution");
    // Simulate an uncertain row while the original process is still active.
    f.store.put("check-execution", {
      ...row,
      state: "uncertain",
      eligibility: "uncertain",
    });
    await expect(
      f.command({
        type: "check-execution-reconcile",
        requestId: uid(),
        projectId: "p",
        id: row.id,
      }),
    ).rejects.toThrow("Only an inactive uncertain execution");
    f.store.put("check-execution", row);
    f.service.checks.cancelWorkflow(f.workflow.id);
    expect((await running).result).toBe("error");
    expect(f.store.get<CheckExecution>("check-execution", row.id)!.state).toBe(
      "cancelled",
    );
    expect(await lines(f.marker)).toEqual(["effect"]);
  });

  test.skipIf(process.platform === "win32")(
    "CK-16: after an actual coordinator SIGKILL, the restarted service refuses reconcile while the check group lives and reconciles only after observed absence",
    async () => {
      const f = await fixture(),
        entry = path.join(f.directory, "crash-worker.cjs"),
        input = path.join(f.directory, "crash-input.json");
      f.store.close();
      cleanup.push(() => rm(f.directory, { recursive: true, force: true }));
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
      const worker = spawn(process.execPath, [entry], {
        env: {
          PATH: process.env.PATH,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_PATH: path.resolve("node_modules"),
          TOPSL_CRASH_INPUT: input,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let diagnostics = "";
      worker.stdout!.on("data", (b) => (diagnostics += b));
      worker.stderr!.on("data", (b) => (diagnostics += b));
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        worker.once("exit", (_code, signal) => resolve(signal)),
      );
      let group: number | null = null;
      cleanup.unshift(async () => {
        if (worker.exitCode === null && worker.signalCode === null)
          worker.kill("SIGKILL");
        if (group) killGroup(group);
      });
      const ready = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("crash barrier timed out: " + diagnostics)),
          30_000,
        );
        worker.on("message", (message: any) => {
          if (message.type === "ready") {
            clearTimeout(timer);
            resolve(message);
          } else if (message.type === "failure") {
            clearTimeout(timer);
            reject(new Error(message.error));
          }
        });
      });
      group = ready.groupId;
      expect(worker.kill("SIGKILL")).toBe(true);
      expect(await exited).toBe("SIGKILL");
      expect(processGroupPresent(group!)).toBe(true);

      const service = new Service(f.directory, f.key, () => {}, true);
      cleanup.unshift(() => service.close());
      const command = (value: Record<string, unknown>) =>
        service.command(commandSchema.parse(value) as Command);
      const before = service.checks.inspect(ready.projectId, ready.executionId);
      expect(before.execution).toMatchObject({
        state: "uncertain",
        eligibility: "uncertain",
        verificationId: null,
      });
      expect(before.cleanup).toBeNull();
      await expect(
        command({
          type: "check-execution-reconcile",
          requestId: uid(),
          projectId: ready.projectId,
          id: ready.executionId,
        }),
      ).rejects.toThrow("Original process identity is still present");
      expect(
        service.store.get<CheckExecution>("check-execution", ready.executionId)!
          .state,
      ).toBe("uncertain");
      expect(
        (await stat(before.execution.materializedRoot)).isDirectory(),
      ).toBe(true);
      process.kill(-group!, "SIGTERM");
      await vi.waitFor(() => expect(processGroupPresent(group!)).toBe(false), {
        timeout: 10_000,
      });
      const reconciled: CheckExecution = await command({
        type: "check-execution-reconcile",
        requestId: uid(),
        projectId: ready.projectId,
        id: ready.executionId,
      });
      expect(reconciled).toMatchObject({
        state: "error",
        eligibility: "ineligible",
        verificationId: null,
      });
      const job = service.checks.inspect(
        ready.projectId,
        ready.executionId,
      ).cleanup!;
      expect(job.state).toBe("pending");
      expect(
        (
          await command({
            type: "check-cleanup-retry",
            requestId: uid(),
            projectId: ready.projectId,
            id: job.id,
          })
        ).state,
      ).toBe("completed");
      await expect(
        stat(before.execution.materializedRoot),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(service.store.list("verification")).toHaveLength(0);
      expect(service.store.list("check-dispatch-intent")).toHaveLength(1);
      expect((await lines(ready.marker)).length).toBe(1);
    },
  );
});

describe("CK-17 public check-cleanup-retry", () => {
  // The check leaves a read-only directory in its task resource root, so the
  // product's own recursive removal fails with a real filesystem error.
  const lockingProgram = (marker: string) =>
    `const fs=require('node:fs'),p=require('node:path');fs.appendFileSync(${JSON.stringify(marker)},'effect\\n');const d=p.join(process.env.TOPSL_TASK_TEMP,'locked');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'held.txt'),'x');fs.chmodSync(d,0o500);console.log('completed');`;

  test.skipIf(process.platform === "win32")(
    "CK-17: failed cleanup keeps the committed verdict; concurrent retries coalesce; replaced and symlinked roots are refused; missing roots are harmless; completion is idempotent",
    async () => {
      const f = await serviceSetup({ program: lockingProgram });
      const verification = await f.service.checks.execute(
        f.service.coordinator.repository,
        f.plan,
        f.plan.digest,
      );
      expect(verification.result).toBe("passed");
      const execution = f.store.list<CheckExecution>("check-execution")[0];
      const [materialized, resources] = execution.ownedRoots;
      cleanup.unshift(() => unlockTree(resources.root));
      const committed = {
        execution: f.store.get("check-execution", execution.id),
        verification: f.store.get("verification", verification.id),
        output: f.store.list("protected-check-output"),
        intents: f.store.list("check-dispatch-intent"),
      };
      expect(committed.execution).toMatchObject({
        state: "passed",
        eligibility: "eligible",
        verificationId: verification.id,
      });
      let job = f.store.list<CleanupJob>("check-cleanup")[0];
      expect(job).toMatchObject({ state: "failed", attempts: 1 });
      expect(job.error).toMatch(/EACCES|permission/i);
      // The candidate copy was removed before the resource root failed.
      await expect(stat(materialized.root)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await stat(resources.root)).isDirectory()).toBe(true);
      const retry = (projectId = "p", id = job.id, requestId = uid()) =>
        f.command({ type: "check-cleanup-retry", requestId, projectId, id });

      // Scope and local ownership.
      await expect(retry("q")).rejects.toThrow(
        "Cleanup is outside this project",
      );
      await expect(retry("missing-project")).rejects.toThrow();
      f.store.put("replication-shared-project", { id: "p" });
      await expect(retry()).rejects.toThrow("Shared project authority");
      f.store.remove("replication-shared-project", "p");
      expect(f.store.get<CleanupJob>("check-cleanup", job.id)!.attempts).toBe(
        1,
      );

      // Concurrent retries for one job coalesce into one attempt.
      const [first, second] = await Promise.all([retry(), retry()]);
      expect(first.state).toBe("failed");
      expect(second.attempts).toBe(first.attempts);
      expect(f.store.get<CleanupJob>("check-cleanup", job.id)!.attempts).toBe(
        2,
      );
      // Negative control: sequential retries are separate attempts.
      expect((await retry()).attempts).toBe(3);

      // A replacement directory at the recorded path is refused, not deleted.
      // The original is moved aside, not removed, while the replacement is
      // made: Linux can reuse a just-freed inode for the new directory, which
      // would give it the recorded device and inode by chance.
      await unlockTree(resources.root);
      const original = `${resources.root}-original`;
      await rename(resources.root, original);
      cleanup.push(() => rm(original, { recursive: true, force: true }));
      await mkdir(resources.root);
      await writeFile(path.join(resources.root, "replacement.txt"), "keep");
      job = await retry();
      expect(job.state).toBe("failed");
      expect(job.error).toContain("identity changed");
      expect(
        await readFile(path.join(resources.root, "replacement.txt"), "utf8"),
      ).toBe("keep");

      // A symlink at the recorded path is refused; its target is untouched.
      await rm(resources.root, { recursive: true, force: true });
      const target = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "topsl-campaign-target-")),
      );
      cleanup.push(() => rm(target, { recursive: true, force: true }));
      await writeFile(path.join(target, "sentinel.txt"), "keep");
      await symlink(target, resources.root);
      job = await retry();
      expect(job.state).toBe("failed");
      expect(job.error).toContain("not an owned directory");
      expect(await readFile(path.join(target, "sentinel.txt"), "utf8")).toBe(
        "keep",
      );
      expect((await stat(resources.root)).isDirectory()).toBe(true);

      // Already missing roots are harmless.
      await rm(resources.root);
      job = await retry();
      expect(job).toMatchObject({ state: "completed", error: null });
      const attempts = job.attempts;
      // Completed cleanup is idempotent and makes no further attempt.
      const again = await retry();
      expect(again).toMatchObject({ state: "completed", attempts });
      // Same request identity replays its receipt; changed parameters refused.
      const requestId = uid();
      await retry("p", job.id, requestId);
      await expect(retry("q", job.id, requestId)).rejects.toThrow(
        "Request identity was reused",
      );

      // The committed verdict and evidence never changed and nothing reran.
      expect(f.store.get("check-execution", execution.id)).toEqual(
        committed.execution,
      );
      expect(f.store.get("verification", verification.id)).toEqual(
        committed.verification,
      );
      expect(f.store.list("protected-check-output")).toEqual(committed.output);
      expect(f.store.list("check-dispatch-intent")).toEqual(committed.intents);
      expect(f.store.list("check-execution")).toHaveLength(1);
      expect(await lines(f.marker)).toEqual(["effect"]);
    },
  );

  test("CK-17: cleanup for an uncertain execution stays blocked and deletes nothing until reconciliation", async () => {
    const f = await serviceSetup();
    const injected = new CheckExecutions(f.store, {
      beforeFinalCommit: () => {
        throw new Error("SQLITE_FULL injected");
      },
    });
    await expect(
      injected.execute(f.service.coordinator.repository, f.plan, f.plan.digest),
    ).rejects.toThrow("No durable pass");
    const execution = f.store.list<CheckExecution>("check-execution")[0];
    expect(execution.state).toBe("uncertain");
    const job: CleanupJob = {
      version: 1,
      id: "blocked-job",
      projectId: "p",
      executionId: execution.id,
      state: "pending",
      roots: execution.ownedRoots,
      attempts: 0,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    f.store.put("check-cleanup", job);
    const blocked: CleanupJob = await f.command({
      type: "check-cleanup-retry",
      requestId: uid(),
      projectId: "p",
      id: job.id,
    });
    expect(blocked).toMatchObject({
      state: "blocked-by-active-process",
      attempts: 0,
    });
    for (const root of execution.ownedRoots)
      expect((await stat(root.root)).isDirectory()).toBe(true);
    // A quiescent-looking lifecycle on a non-final state is still blocked.
    f.store.put("check-execution", { ...execution, state: "running" });
    expect(
      (
        await f.command({
          type: "check-cleanup-retry",
          requestId: uid(),
          projectId: "p",
          id: job.id,
        })
      ).state,
    ).toBe("blocked-by-active-process");
    // A final state with a non-quiescent lifecycle is still blocked.
    f.store.put("check-execution", {
      ...execution,
      state: "error",
      lifecycle: { ...execution.lifecycle!, state: "uncertain" },
    });
    expect(
      (
        await f.command({
          type: "check-cleanup-retry",
          requestId: uid(),
          projectId: "p",
          id: job.id,
        })
      ).state,
    ).toBe("blocked-by-active-process");
    for (const root of execution.ownedRoots)
      expect((await stat(root.root)).isDirectory()).toBe(true);
    // Restore the uncertain record and reconcile through the public path.
    f.store.put("check-execution", execution);
    await f.command({
      type: "check-execution-reconcile",
      requestId: uid(),
      projectId: "p",
      id: execution.id,
    });
    const done: CleanupJob = await f.command({
      type: "check-cleanup-retry",
      requestId: uid(),
      projectId: "p",
      id: job.id,
    });
    expect(done.state).toBe("completed");
    for (const root of execution.ownedRoots)
      await expect(stat(root.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.store.list("verification")).toHaveLength(0);
  });
});

describe("CK-06 frozen acceptance inputs at execution", () => {
  test("CK-06: a weakened, removed or drifting frozen harness blocks execution before dispatch, while source repairs and added tests run the original harness", async () => {
    const f = await fixture(),
      source = path.join(f.directory, "source"),
      marker = path.join(f.directory, "harness-runs.txt");
    cleanup.push(async () => {
      try {
        f.store.close();
      } catch {}
      await rm(f.directory, { recursive: true, force: true });
    });
    await mkdir(path.join(source, "tests"), { recursive: true });
    await writeFile(path.join(source, "src.cjs"), "module.exports=1;\n");
    const harness = `require('node:fs').appendFileSync(${JSON.stringify(marker)},'harness\\n');process.exit(require('../src.cjs')===2?0:1);\n`;
    await writeFile(path.join(source, "tests/accept.cjs"), harness);
    const repository = new CoordinationRepository(f.store),
      project = {
        id: "p",
        name: "Frozen harness",
        path: source,
        realPath: source,
        trusted: true,
        createdAt: now(),
      };
    f.store.put("project", project);
    const workspace = repository.ensureWorkspace(project),
      workflow = repository.createWorkflow({
        projectId: "p",
        objective: "Frozen acceptance protocol",
        template: "fixture",
        templateVersion: "1",
      }),
      task = repository.createTask({
        projectId: "p",
        workflowId: workflow.id,
        workspaceId: workspace.id,
        title: "Check",
        role: "tester",
      });
    const capture = (paths = ["src.cjs", "tests/accept.cjs"]) =>
      captureCandidate(f.store, {
        root: source,
        projectId: "p",
        workflowId: workflow.id,
        selectedPaths: paths,
      });
    const baseline = await capture();
    const definition: CheckDefinition = {
      id: "frozen-acceptance",
      label: "Frozen acceptance",
      executable: process.execPath,
      args: ["tests/accept.cjs"],
      timeoutMs: 30_000,
      executionPolicy: { maximumUses: 4, allowCandidateChanges: true },
    };
    bindCheckInputs(f.store, workflow.id, baseline, [definition]);
    const plan = await previewCheck(
      repository,
      workflow.id,
      task.id,
      baseline,
      definition,
    );
    const checks = new CheckExecutions(f.store);
    const run = async (candidateId: string) => {
      const reused = await reuseCheckAuthorization(
        f.store,
        plan.authorizationId!,
        candidateId,
      );
      return checks.execute(repository, reused, reused.digest);
    };
    expect((await checks.execute(repository, plan, plan.digest)).result).toBe(
      "failed",
    );
    // Additive: repaired source plus a new test keep the original harness.
    await writeFile(path.join(source, "src.cjs"), "module.exports=2;\n");
    await writeFile(path.join(source, "tests/extra.cjs"), "// added test\n");
    const repaired = await capture([
      "src.cjs",
      "tests/accept.cjs",
      "tests/extra.cjs",
    ]);
    expect((await run(repaired.id)).result).toBe("passed");
    expect(await lines(marker)).toEqual(["harness", "harness"]);
    const settled = {
      intents: f.store.list("check-dispatch-intent").length,
      uses: f.store.get<any>("check-authorization-usage", plan.authorizationId!)
        .uses,
    };
    // Weakened harness.
    await writeFile(
      path.join(source, "tests/accept.cjs"),
      "process.exit(0);\n",
    );
    await expect(run((await capture()).id)).rejects.toThrow(
      "Required acceptance inputs changed",
    );
    // Removed harness.
    await rm(path.join(source, "tests/accept.cjs"));
    await expect(run((await capture()).id)).rejects.toThrow(
      "Required acceptance inputs changed",
    );
    // Drift after a valid plan was issued, before dispatch.
    await writeFile(path.join(source, "tests/accept.cjs"), harness);
    const current = await capture();
    const reviewed = await reuseCheckAuthorization(
      f.store,
      plan.authorizationId!,
      current.id,
    );
    await writeFile(
      path.join(source, "tests/accept.cjs"),
      "process.exit(0);\n",
    );
    await expect(
      checks.execute(repository, reviewed, reviewed.digest),
    ).rejects.toThrow("Candidate bytes changed");
    // None of the refusals dispatched a process or spent a use.
    expect(f.store.list("check-dispatch-intent")).toHaveLength(settled.intents);
    expect(
      f.store.get<any>("check-authorization-usage", plan.authorizationId!).uses,
    ).toBe(settled.uses);
    expect(await lines(marker)).toEqual(["harness", "harness"]);
  });
});

describe("CK-07 concurrent spending of one approval", () => {
  test("CK-07: five concurrent callers of a single-use approval produce one durable execution and one process", async () => {
    const f = await checkSetup(),
      checks = new CheckExecutions(f.store);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        checks.execute(f.repository, f.plan, f.plan.digest),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected"))
      expect((r as PromiseRejectedResult).reason.message).toMatch(
        /consumed|exhausted|active or uncertain/,
      );
    expect(await lines(f.marker)).toEqual(["effect"]);
    expect(f.store.list("check-execution")).toHaveLength(1);
    expect(f.store.list("check-dispatch-intent")).toHaveLength(1);
    expect(f.store.list("check-authorization-consumption")).toHaveLength(1);
    expect(
      f.store.get<any>("check-authorization-usage", f.plan.authorizationId!)
        .uses,
    ).toBe(1);
    // A restarted store cannot replay the consumed approval.
    f.store.close();
    const reopened = new Store(path.join(f.directory, "history.sqlite"), f.key);
    cleanup.unshift(async () => reopened.close());
    const recovered = new CheckExecutions(reopened);
    recovered.recover();
    await expect(
      recovered.execute(
        new CoordinationRepository(reopened),
        f.plan,
        f.plan.digest,
      ),
    ).rejects.toThrow(/consumed|exhausted/);
    expect(reopened.list("check-dispatch-intent")).toHaveLength(1);
    expect(await lines(f.marker)).toEqual(["effect"]);
  });

  test("CK-07: a refused concurrent spend of a two-use approval rolls back its use, so exactly two executions ever run", async () => {
    const f = await checkSetup({ policy: { maximumUses: 2 } }),
      dispatching = barrier(),
      release = barrier();
    let held = false;
    const checks = new CheckExecutions(f.store, {
      beforeDispatch: async () => {
        if (held) return;
        held = true;
        dispatching.resolve();
        await release.promise;
      },
    });
    const first = checks.execute(f.repository, f.plan, f.plan.digest);
    await dispatching.promise;
    await expect(
      checks.execute(f.repository, f.plan, f.plan.digest),
    ).rejects.toThrow("active or uncertain check");
    // The refused caller's use was rolled back with its transaction.
    expect(
      f.store.get<any>("check-authorization-usage", f.plan.authorizationId!)
        .uses,
    ).toBe(1);
    expect(f.store.list("check-dispatch-intent")).toHaveLength(1);
    release.resolve();
    expect((await first).result).toBe("passed");
    expect(
      (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
    ).toBe("passed");
    await expect(
      checks.execute(f.repository, f.plan, f.plan.digest),
    ).rejects.toThrow(/exhausted/);
    const executions = f.store.list<CheckExecution>("check-execution");
    expect(executions).toHaveLength(2);
    expect(new Set(executions.map((e) => e.id)).size).toBe(2);
    expect(f.store.list("check-authorization-consumption")).toHaveLength(2);
    expect(await lines(f.marker)).toEqual(["effect", "effect"]);
  });
});

describe("CK-08 / 6.1 ordinary check authorization boundaries", () => {
  const authorizationRows = (store: Store) =>
    store.list("check-authorization-definition").length;

  test("6.1: uses 1-10 and expiry 100-3,600,000 ms are accepted at preview; values outside, fractions and zero are rejected without an authorization", async () => {
    const f = await checkSetup();
    const preview = (
      policy: CheckDefinition["executionPolicy"],
      id: string,
    ) => {
      const definition: CheckDefinition = {
        ...f.definition,
        id,
        executionPolicy: policy,
      };
      bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]);
      return previewCheck(
        f.repository,
        f.workflow.id,
        f.task.id,
        f.candidate,
        definition,
      );
    };
    const rejected: Array<CheckDefinition["executionPolicy"]> = [
      { maximumUses: 0 },
      { maximumUses: -1 },
      { maximumUses: 11 },
      { maximumUses: 1.5 },
      { maximumUses: 1, expiresAfterMs: 99 },
      { maximumUses: 1, expiresAfterMs: 0 },
      { maximumUses: 1, expiresAfterMs: 3_600_001 },
      { maximumUses: 1, expiresAfterMs: 100.5 },
    ];
    for (const [i, policy] of rejected.entries()) {
      const before = authorizationRows(f.store),
        plans = f.store.list("workflow-check-plan").length;
      await expect(preview(policy, `rejected-${i}`)).rejects.toThrow(
        "bounded uses and expiry",
      );
      expect(authorizationRows(f.store)).toBe(before);
      expect(f.store.list("workflow-check-plan")).toHaveLength(plans);
      // The public schema rejects the same values.
      expect(
        requiredCheckSchema.safeParse({
          ...f.definition,
          id: "schema",
          executionPolicy: policy,
        }).success,
      ).toBe(false);
    }
    for (const [i, policy] of [
      { maximumUses: 1 },
      { maximumUses: 2 },
      { maximumUses: 10 },
      { maximumUses: 1, expiresAfterMs: 100 },
      { maximumUses: 10, expiresAfterMs: 3_600_000 },
    ].entries()) {
      const started = Date.now(),
        plan = await preview(policy, `accepted-${i}`),
        finished = Date.now();
      const authorization = f.store.get<any>(
        "check-authorization-definition",
        plan.authorizationId!,
      );
      expect(authorization).toMatchObject({
        maximumUses: policy.maximumUses,
        expiresAt: plan.expiresAt,
        planDigest: plan.digest,
      });
      const expires = Date.parse(plan.expiresAt);
      const duration = policy.expiresAfterMs ?? 600_000;
      expect(expires).toBeGreaterThanOrEqual(started + duration);
      expect(expires).toBeLessThanOrEqual(finished + duration);
      expect(
        requiredCheckSchema.safeParse({
          ...f.definition,
          id: "schema",
          executionPolicy: policy,
        }).success,
      ).toBe(true);
    }
  });

  test("CK-08: a single-use approval runs once; a ten-use approval runs exactly ten distinct executions and refuses the eleventh", async () => {
    const one = await checkSetup({ policy: { maximumUses: 1 } }),
      oneChecks = new CheckExecutions(one.store);
    expect(
      (await oneChecks.execute(one.repository, one.plan, one.plan.digest))
        .result,
    ).toBe("passed");
    await expect(
      oneChecks.execute(one.repository, one.plan, one.plan.digest),
    ).rejects.toThrow(/exhausted|consumed/);
    expect(await lines(one.marker)).toEqual(["effect"]);

    const ten = await checkSetup({ policy: { maximumUses: 10 } }),
      checks = new CheckExecutions(ten.store);
    for (let i = 0; i < 10; i++)
      expect(
        (await checks.execute(ten.repository, ten.plan, ten.plan.digest))
          .result,
      ).toBe("passed");
    await expect(
      checks.execute(ten.repository, ten.plan, ten.plan.digest),
    ).rejects.toThrow(/exhausted/);
    const executions = ten.store.list<CheckExecution>("check-execution");
    expect(executions).toHaveLength(10);
    expect(new Set(executions.map((e) => e.id)).size).toBe(10);
    expect(ten.store.list("check-authorization-consumption")).toHaveLength(10);
    expect(ten.store.list("verification")).toHaveLength(10);
    expect(
      ten.store.get<any>("check-authorization-usage", ten.plan.authorizationId!)
        .uses,
    ).toBe(10);
    expect(await lines(ten.marker)).toHaveLength(10);
  }, 120_000);

  test.each([100, 3_600_000])(
    "6.1: an approval with expiry %i ms is usable one millisecond before expiry and refused exactly at expiry",
    async (expiresAfterMs) => {
      const f = await checkSetup({
          policy: { maximumUses: 2, expiresAfterMs },
        }),
        checks = new CheckExecutions(f.store),
        expiresAt = Date.parse(f.plan.expiresAt);
      // A held lock is checked after expiry inside the dispatch transaction, so
      // its refusal proves the approval itself was still valid. No process runs.
      f.store.put("check-workspace-lock", {
        id: f.candidate.workspaceIdentity,
        executionId: "synthetic-holder",
        projectId: "p",
        held: true,
      });
      vi.setSystemTime(expiresAt - 1);
      await expect(
        checks.execute(f.repository, f.plan, f.plan.digest),
      ).rejects.toThrow("active or uncertain check");
      vi.setSystemTime(expiresAt);
      await expect(
        checks.execute(f.repository, f.plan, f.plan.digest),
      ).rejects.toThrow("stale");
      vi.useRealTimers();
      expect(f.store.list("check-dispatch-intent")).toHaveLength(0);
      expect(f.store.list("check-execution")).toHaveLength(0);
      expect(
        f.store.get("check-authorization-usage", f.plan.authorizationId!),
      ).toBeUndefined();
      await expect(readFile(f.marker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  test("CK-08: public revocation stops later uses and is scoped to its project", async () => {
    const f = await serviceSetup({ policy: { maximumUses: 3 } });
    expect(
      (
        await f.service.checks.execute(
          f.service.coordinator.repository,
          f.plan,
          f.plan.digest,
        )
      ).result,
    ).toBe("passed");
    await expect(
      f.command({
        type: "check-authorization-revoke",
        requestId: uid(),
        projectId: "q",
        id: f.plan.authorizationId!,
      }),
    ).rejects.toThrow("outside this project");
    await expect(
      f.service.checks.execute(
        f.service.coordinator.repository,
        f.plan,
        f.plan.digest,
      ),
    ).resolves.toMatchObject({ result: "passed" });
    await f.command({
      type: "check-authorization-revoke",
      requestId: uid(),
      projectId: "p",
      id: f.plan.authorizationId!,
    });
    await expect(
      f.service.checks.execute(
        f.service.coordinator.repository,
        f.plan,
        f.plan.digest,
      ),
    ).rejects.toThrow("revoked");
    await expect(
      f.command({
        type: "check-authorization-reuse-preview",
        projectId: "p",
        id: f.plan.authorizationId!,
        candidateId: f.candidate.id,
      }),
    ).rejects.toThrow("revoked");
    expect(
      f.store.get<any>("check-authorization-usage", f.plan.authorizationId!)
        .uses,
    ).toBe(2);
    expect(await lines(f.marker)).toEqual(["effect", "effect"]);
  });
});

describe("6.1 required-check boundaries", () => {
  const check = (i: number, timeoutMs = 1_000) => ({
    id: `check-${i}`,
    label: `Check ${i}`,
    executable: process.execPath,
    args: ["--version"],
    timeoutMs,
  });
  const assignment = {
    provider: "codex",
    installationId: "installation",
    model: "fixture-model",
  };
  test("6.1: public commands accept 1, 2 and 20 required checks and reject 0 and 21; timeout 100-300,000 ms", () => {
    const parallel = (checks: unknown[]) =>
      commandSchema.safeParse({
        type: "parallel-create",
        requestId: "request-1",
        workflowId: "workflow",
        integrationWorkspaceId: "workspace",
        specialists: ["a", "b"].map((key) => ({
          key,
          title: key,
          workspaceId: `workspace-${key}`,
          ...assignment,
          permittedOutputs: [`${key}.txt`],
        })),
        checks,
      }).success;
    const goalChecks = (checks: unknown[]) =>
      commandSchema.safeParse({
        type: "orchestration-checks-set",
        goalId: "goal",
        checks,
        commandId: "command-0001",
      }).success;
    const many = (n: number, timeoutMs?: number) =>
      Array.from({ length: n }, (_, i) => check(i, timeoutMs));
    expect(parallel(many(0))).toBe(false);
    for (const n of [1, 2, 20]) expect(parallel(many(n))).toBe(true);
    expect(parallel(many(21))).toBe(false);
    for (const n of [0, 1, 2, 20]) expect(goalChecks(many(n))).toBe(true);
    expect(goalChecks(many(21))).toBe(false);
    for (const t of [100, 300_000]) {
      expect(parallel(many(1, t))).toBe(true);
      expect(goalChecks(many(1, t))).toBe(true);
    }
    for (const t of [99, 300_001, 100.5, 0, -1]) {
      expect(parallel(many(1, t))).toBe(false);
      expect(goalChecks(many(1, t))).toBe(false);
    }
  });
  test("6.1: the service-side preview enforces the same timeout boundary independently of the schema", async () => {
    const f = await checkSetup();
    for (const timeoutMs of [99, 300_001, 100.5]) {
      const definition = { ...f.definition, id: `t-${timeoutMs}`, timeoutMs };
      bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]);
      await expect(
        previewCheck(
          f.repository,
          f.workflow.id,
          f.task.id,
          f.candidate,
          definition,
        ),
      ).rejects.toThrow("bounded timeout");
    }
    for (const timeoutMs of [100, 300_000]) {
      const definition = { ...f.definition, id: `t-${timeoutMs}`, timeoutMs };
      bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]);
      await expect(
        previewCheck(
          f.repository,
          f.workflow.id,
          f.task.id,
          f.candidate,
          definition,
        ),
      ).resolves.toMatchObject({ definition: { timeoutMs } });
    }
  });
});

describe("6.2 check recipe, preparation network and execution modes", () => {
  test("6.2: every recipe/network/profile value is enumerated at the public command; unsupported guarantees block preview and unknown values are rejected", async () => {
    const f = await serviceSetup();
    const npm = await realpath(
      process.env.npm_execpath ??
        path.join(
          path.dirname(process.execPath),
          "node_modules/npm/bin/npm-cli.js",
        ),
    ).catch(() => null);
    const base = {
      type: "environment-selection-create",
      projectId: "p",
      label: "Mode matrix",
      nodeExecutable: process.execPath,
      preparationTimeoutMs: 60_000,
      writablePaths: [],
      hooks: [],
      values: {},
    };
    for (const bad of [
      { kind: "container" },
      { profile: "os-sandbox" },
      { preparationNetwork: "online" },
    ])
      expect(
        commandSchema.safeParse({
          ...base,
          requestId: uid(),
          kind: "self-contained",
          profile: "user-approved-local",
          ...bad,
        }).success,
      ).toBe(false);
    const outcomes: Record<string, string> = {};
    const digests = new Map<string, string>();
    for (const kind of ["self-contained", "locked-node"] as const)
      for (const profile of ["user-approved-local", "isolated-required"])
        for (const preparationNetwork of [
          "offline",
          "package-manager-network",
          "enforced-allowlist-required",
        ]) {
          const key = `${kind}/${profile}/${preparationNetwork}`;
          if (kind === "locked-node" && !npm) {
            outcomes[key] = "no-npm";
            continue;
          }
          const selection = await f.command({
            ...base,
            requestId: uid(),
            kind,
            profile,
            preparationNetwork,
            ...(kind === "locked-node" ? { npmCli: npm } : {}),
          });
          expect(selection).toMatchObject({
            kind,
            profile,
            preparationNetwork,
          });
          if (kind === "locked-node") {
            // Locked recipes need a lockfile; selection creation is the
            // enumerated surface here (R2-AT-25..27 execute locked-node).
            outcomes[key] = "selection-created";
            continue;
          }
          const definition = {
            ...f.definition,
            id: `mode-${profile}-${preparationNetwork}`,
            environmentRecipeId: selection.id,
          };
          bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]);
          try {
            const plan: CheckPlan = await previewCheck(
              f.service.coordinator.repository,
              f.workflow.id,
              f.task.id,
              f.candidate,
              definition,
            );
            digests.set(key, plan.environmentRecipe!.digest);
            outcomes[key] = "previewed";
          } catch (error: any) {
            outcomes[key] = error.message.includes("allowlist is unavailable")
              ? "allowlist-unavailable"
              : error.message.includes("isolation is unavailable")
                ? "isolation-unavailable"
                : `unexpected: ${error.message}`;
          }
        }
    expect(outcomes).toEqual({
      "self-contained/user-approved-local/offline": "previewed",
      "self-contained/user-approved-local/package-manager-network": "previewed",
      "self-contained/user-approved-local/enforced-allowlist-required":
        "allowlist-unavailable",
      "self-contained/isolated-required/offline": "isolation-unavailable",
      "self-contained/isolated-required/package-manager-network":
        "isolation-unavailable",
      "self-contained/isolated-required/enforced-allowlist-required":
        "allowlist-unavailable",
      "locked-node/user-approved-local/offline": npm
        ? "selection-created"
        : "no-npm",
      "locked-node/user-approved-local/package-manager-network": npm
        ? "selection-created"
        : "no-npm",
      "locked-node/user-approved-local/enforced-allowlist-required": npm
        ? "selection-created"
        : "no-npm",
      "locked-node/isolated-required/offline": npm
        ? "selection-created"
        : "no-npm",
      "locked-node/isolated-required/package-manager-network": npm
        ? "selection-created"
        : "no-npm",
      "locked-node/isolated-required/enforced-allowlist-required": npm
        ? "selection-created"
        : "no-npm",
    });
    // Distinct network choices are distinct recipe identities.
    expect(digests.get("self-contained/user-approved-local/offline")).not.toBe(
      digests.get("self-contained/user-approved-local/package-manager-network"),
    );
    // No preview executed anything or consumed an approval.
    expect(f.store.list("check-dispatch-intent")).toHaveLength(0);
    expect(f.store.list("environment-instance")).toHaveLength(0);
  });
});

describe("CK-15 bounded, redacted evidence and descendants", () => {
  test("CK-15: every credential pattern is redacted in logs and stored output, ordinary codes stay readable, and overlong or unterminated lines are bounded", async () => {
    const secrets = [
      "sk-campaignSECRET0123456789",
      "Bearer campaign-bearer-secret",
      "access_token=campaign-access-secret",
      'refresh_token: "campaign-refresh-secret"',
      "api_key=campaign-api-secret",
      "https://example.invalid/cb?code=campaign-oauth-secret&state=1",
    ];
    const program = (marker: string) =>
      [
        "const fs=require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(marker)},'effect\\n');`,
        `for(const s of ${JSON.stringify(secrets)}){console.log('stdout '+s);console.error('stderr '+s);}`,
        "console.log('exit code: 1 and error code: E42 remain readable');",
        // A secret inside a line longer than the per-line bound.
        "console.log('x'.repeat(17000)+' sk-overlongSECRET0123456789');",
        // An unterminated overlong final line on stderr.
        "process.stderr.write('y'.repeat(20000)+' Bearer tail-secret-value');",
      ].join("");
    const f = await checkSetup({ program }),
      before = await readFile(path.join(f.source, "value.js")),
      checks = new CheckExecutions(f.store);
    const verification = await checks.execute(
      f.repository,
      f.plan,
      f.plan.digest,
    );
    expect(verification.result).toBe("passed");
    const execution = f.store.list<CheckExecution>("check-execution")[0],
      inspected = checks.inspect("p", execution.id),
      text = inspected.logs.map((l) => l.text).join(""),
      stored = f.store.list<any>("protected-check-output")[0];
    expect(execution.truncated).toBe(true);
    expect(inspected.logs.length).toBeLessThanOrEqual(256);
    expect(execution.outputBytes).toBeLessThanOrEqual(1_000_000);
    expect(
      inspected.logs.every((l) => Buffer.byteLength(l.text) <= 16_000),
    ).toBe(true);
    expect(stored.text).toBe(text);
    expect(stored.truncated).toBe(true);
    for (const value of [
      "campaignSECRET",
      "campaign-bearer-secret",
      "campaign-access-secret",
      "campaign-refresh-secret",
      "campaign-api-secret",
      "campaign-oauth-secret",
      "overlongSECRET",
      "tail-secret-value",
    ]) {
      expect(text).not.toContain(value);
      expect(stored.text).not.toContain(value);
    }
    expect(text.match(/\[redacted\]/g)!.length).toBeGreaterThanOrEqual(12);
    expect(text).toContain("exit code: 1 and error code: E42 remain readable");
    expect(text).toContain("[overlong diagnostic line omitted]");
    expect(
      inspected.logs.some(
        (l) =>
          l.stream === "stderr" &&
          l.text === "[overlong diagnostic line omitted]\n",
      ),
    ).toBe(true);
    // No hidden source mutation.
    expect(await readFile(path.join(f.source, "value.js"))).toEqual(before);
  });

  test("CK-15: a record flood is cut at 256 bounded records, marked truncated, and the stored output equals the retained records", async () => {
    const f = await checkSetup({
        program: (marker) =>
          `require('node:fs').appendFileSync(${JSON.stringify(marker)},'effect\\n');for(let i=0;i<300;i++)console.log('line '+i+' api_key=flood-secret-'+i);`,
      }),
      checks = new CheckExecutions(f.store);
    expect(
      (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
    ).toBe("passed");
    const execution = f.store.list<CheckExecution>("check-execution")[0],
      inspected = checks.inspect("p", execution.id),
      text = inspected.logs.map((l) => l.text).join(""),
      stored = f.store.list<any>("protected-check-output")[0];
    expect(inspected.logs).toHaveLength(256);
    expect(inspected.logs.map((l) => l.sequence)).toEqual(
      Array.from({ length: 256 }, (_, i) => i + 1),
    );
    expect(text).toContain("line 255 ");
    expect(text).not.toContain("line 256 ");
    expect(text).not.toContain("flood-secret");
    expect(execution.truncated).toBe(true);
    expect(stored).toMatchObject({ truncated: true, text });
  });

  test.skipIf(process.platform === "win32")(
    "CK-15: an exit-0 check whose owned descendant survives is never a pass; the descendant is stopped, including one that ignores SIGTERM",
    async () => {
      const program = (ignoreTerm: boolean) => (marker: string) =>
        `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(`${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},10000)`)}],{stdio:'ignore',env:process.env});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));c.unref();console.log('leader exits 0');`;
      for (const ignoreTerm of [false, true]) {
        const f = await checkSetup({ program: program(ignoreTerm) }),
          checks = new CheckExecutions(f.store);
        const verification = await checks.execute(
          f.repository,
          f.plan,
          f.plan.digest,
        );
        const descendant = Number(await readFile(f.marker, "utf8"));
        cleanup.unshift(async () => {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {}
        });
        const execution = f.store.list<CheckExecution>("check-execution")[0];
        expect(verification.result).toBe("error");
        expect(execution).toMatchObject({
          state: "error",
          eligibility: "ineligible",
        });
        expect(execution.error).toContain("quiescence is unproven");
        expect(execution.lifecycle).toMatchObject({
          exitCode: 0,
          state: "quiescent",
          remainingGroup: "absent",
        });
        expect(execution.lifecycle!.stopRequestedAt).toBeTruthy();
        expect(() => process.kill(descendant, 0)).toThrow();
      }
      // Negative control: the same leader without a surviving descendant passes.
      const control = await checkSetup(),
        checks = new CheckExecutions(control.store);
      expect(
        (
          await checks.execute(
            control.repository,
            control.plan,
            control.plan.digest,
          )
        ).result,
      ).toBe("passed");
    },
    60_000,
  );

  test.skipIf(process.platform === "win32")(
    "CK-15 limitation: a descendant that escapes the owned process group is outside observation and the evidence says so",
    async () => {
      const f = await checkSetup({
          program: (marker) =>
            `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore',env:process.env,detached:true});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));c.unref();`,
        }),
        checks = new CheckExecutions(f.store);
      const verification = await checks.execute(
        f.repository,
        f.plan,
        f.plan.digest,
      );
      const escaped = Number(await readFile(f.marker, "utf8"));
      cleanup.unshift(async () => {
        try {
          process.kill(escaped, "SIGKILL");
        } catch {}
      });
      expect(() => process.kill(escaped, 0)).not.toThrow();
      expect(verification.result).toBe("passed");
      expect(verification.evidence.detail).toContain(
        "Escaped or lost ancestry is outside process observation coverage",
      );
      expect(verification.evidence.detail).toContain(
        "OS/network/CPU/memory isolation is not enforced",
      );
    },
  );
});
