import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fixture } from "./helpers";
import { now } from "../packages/domain/invariants";
import { captureCandidate } from "../packages/workflows/candidates";
import { bindCheckInputs } from "../packages/workflows/check-inputs";
import {
  previewCheck,
  type CheckDefinition,
} from "../packages/workflows/verification";
import {
  CheckExecutions,
  type CheckExecution,
} from "../packages/workflows/check-executions";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import { ProcessLifecycle } from "../packages/runtime/process-lifecycle";
import { nativeEnvironment } from "../packages/platform/system";
import { Service } from "../apps/service/service";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
});
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup(program?: (marker: string) => string, timeoutMs = 5_000) {
  const f = await fixture(),
    source = path.join(f.directory, "source"),
    marker = path.join(f.directory, "effects.txt");
  await mkdir(source);
  await writeFile(path.join(source, "value.js"), "export const value=1;\n");
  const repository = new CoordinationRepository(f.store),
    project = {
      id: "p",
      name: "Durability",
      path: source,
      realPath: source,
      trusted: true,
      createdAt: now(),
    };
  f.store.put("project", project);
  const workspace = repository.ensureWorkspace(project),
    workflow = repository.createWorkflow({
      projectId: project.id,
      objective: "Fault injection",
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
    id: "fault-check",
    label: "One effect",
    executable: process.execPath,
    args: [
      "-e",
      program?.(marker) ??
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'effect\\n');console.log('completed');`,
    ],
    timeoutMs,
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

describe("R2 durable process executions", () => {
  test("durable-check rollout switch prevents dispatch and keeps historical inspection available", async () => {
    const f = await setup(),
      checks = new CheckExecutions(f.store);
    f.store.put("preference", {
      id: "round-2-rollout",
      disabled: ["durable-checks"],
    });
    await expect(
      checks.execute(f.repository, f.plan, f.plan.digest),
    ).rejects.toThrow("disabled");
    expect(f.store.list("check-dispatch-intent")).toHaveLength(0);
    expect(checks.list("p").executions).toHaveLength(0);
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("R2-AT-05: cleanup failure preserves committed success and retries without dispatch", async () => {
    const f = await setup();
    let deny = true;
    const cleaning = barrier(),
      releaseCleanup = barrier();
    const checks = new CheckExecutions(f.store, {
      cleanup: async (root) => {
        if (deny) throw new Error("fixture lock");
        cleaning.resolve();
        await releaseCleanup.promise;
        await rm(root, { recursive: true, force: true });
      },
    });
    const verification = await checks.execute(
      f.repository,
      f.plan,
      f.plan.digest,
    );
    expect(verification.result).toBe("passed");
    const execution = checks.list("p").executions[0],
      inspected = checks.inspect("p", execution.id);
    expect(inspected.execution).toMatchObject({
      state: "passed",
      eligibility: "eligible",
      verificationId: verification.id,
    });
    expect(inspected.cleanup?.state).toBe("failed");
    expect(inspected.logs.map((l) => l.text).join("")).toContain("completed");
    expect(() => checks.inspect("other", execution.id)).toThrow("outside");
    await expect(
      checks.retryCleanup("other", inspected.cleanup!.id),
    ).rejects.toThrow("outside");
    deny = false;
    const retry = checks.retryCleanup("p", inspected.cleanup!.id);
    await cleaning.promise;
    await expect(
      checks.retryCleanup("other", inspected.cleanup!.id),
    ).rejects.toThrow("outside");
    releaseCleanup.resolve();
    expect((await retry).state).toBe("completed");
    expect(
      (await checks.retryCleanup("p", inspected.cleanup!.id)).attempts,
    ).toBe(2);
    expect(await readFile(f.marker, "utf8")).toBe("effect\n");
    expect(f.store.get("verification", verification.id)).toBeTruthy();
  });
  test("R2-AT-06/08: final storage failure leaves original intent unresolved and recovery never duplicates effects", async () => {
    const f = await setup(),
      checks = new CheckExecutions(f.store, {
        beforeFinalCommit: () => {
          throw new Error("SQLITE_FULL injected");
        },
      });
    await expect(
      checks.execute(f.repository, f.plan, f.plan.digest),
    ).rejects.toThrow("No durable pass");
    expect(f.store.list("verification")).toHaveLength(0);
    expect(f.store.list("protected-check-output")).toHaveLength(0);
    expect(f.store.list("check-log").length).toBeGreaterThan(0);
    expect(checks.list("p").executions[0]).toMatchObject({
      state: "uncertain",
      eligibility: "uncertain",
      storageError: "SQLITE_FULL injected",
      verificationId: null,
    });
    const recovered = new CheckExecutions(f.store);
    recovered.recover();
    await expect(
      recovered.execute(f.repository, f.plan, f.plan.digest),
    ).rejects.toThrow("already been consumed");
    recovered.cancelWorkflow(f.workflow.id);
    expect(recovered.list("p").executions[0].state).toBe("uncertain");
    expect(f.store.list("check-dispatch-intent")).toHaveLength(1);
    expect(await readFile(f.marker, "utf8")).toBe("effect\n");
    const original = recovered.list("p").executions[0];
    expect(
      (await recovered.reconcileStopped("p", original.id)).eligibility,
    ).toBe("ineligible");
    const job = recovered.inspect("p", original.id).cleanup!;
    expect((await recovered.retryCleanup("p", job.id)).state).toBe("completed");
    expect(f.store.list("verification")).toHaveLength(0);
  });
  test("R2-AT-07: concurrent approval and pre-dispatch cancellation produce one intent and no command", async () => {
    const f = await setup(),
      prepared = barrier<CheckExecution>(),
      release = barrier();
    const checks = new CheckExecutions(f.store, {
      beforeDispatch: async (execution) => {
        prepared.resolve(execution);
        await release.promise;
      },
    });
    const first = checks.execute(f.repository, f.plan, f.plan.digest);
    await prepared.promise;
    await expect(
      checks.execute(f.repository, f.plan, f.plan.digest),
    ).rejects.toThrow("already been consumed");
    checks.cancelWorkflow(f.workflow.id);
    release.resolve();
    expect((await first).result).toBe("error");
    expect(checks.list("p").executions[0].state).toBe("cancelled");
    expect(f.store.list("check-dispatch-intent")).toHaveLength(1);
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("R2-AT-07: incremental bounded logs survive active cancellation and redact split credentials", async () => {
    const f = await setup(
      (marker) =>
        `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'effect\\n');process.stdout.write('Bearer ');process.stdout.write('fixture-secret-value\\nready\\n');setInterval(()=>{},10000);`,
    );
    const checks = new CheckExecutions(f.store),
      pending = checks.execute(f.repository, f.plan, f.plan.digest);
    await vi.waitFor(() =>
      expect(
        f.store
          .list<any>("check-log")
          .map((l) => l.text)
          .join(""),
      ).toContain("ready"),
    );
    const before = checks.list("p").executions[0];
    expect(before.state).toBe("running");
    expect(
      checks
        .inspect("p", before.id)
        .logs.map((l) => l.text)
        .join(""),
    ).toContain("[redacted]");
    expect(
      checks
        .inspect("p", before.id)
        .logs.map((l) => l.text)
        .join(""),
    ).not.toContain("fixture-secret-value");
    checks.cancelWorkflow(f.workflow.id);
    expect((await pending).result).toBe("error");
    expect(checks.list("p").executions[0].state).toBe("cancelled");
    expect(await readFile(f.marker, "utf8")).toBe("effect\n");
  });
  test("protected logs retain bounded full output with explicit truncation, separate from the short UI summary", async () => {
    const f = await setup(
      () =>
        `for(let i=0;i<400;i++)console.log('x'.repeat(6000));console.log('y'.repeat(20000));`,
    );
    const checks = new CheckExecutions(f.store),
      verification = await checks.execute(f.repository, f.plan, f.plan.digest);
    expect(verification.result).toBe("passed");
    const execution = checks.list("p").executions[0],
      inspected = checks.inspect("p", execution.id);
    expect(execution.truncated).toBe(true);
    expect(execution.outputBytes).toBeLessThanOrEqual(1_000_000);
    expect(execution.outputBytes).toBeGreaterThan(1_500);
    expect(inspected.logs.length).toBeLessThanOrEqual(256);
    expect(
      inspected.logs.every((l) => Buffer.byteLength(l.text) <= 16_000),
    ).toBe(true);
  });
  test("timeout records termination evidence and cannot become a passing result", async () => {
    const f = await setup(() => "setInterval(()=>{},10000);", 100),
      checks = new CheckExecutions(f.store);
    const verification = await checks.execute(
      f.repository,
      f.plan,
      f.plan.digest,
    );
    expect(verification.result).toBe("error");
    expect(checks.list("p").executions[0]).toMatchObject({
      state: "error",
      eligibility: "ineligible",
    });
    expect(
      checks.list("p").executions[0].lifecycle?.stopRequestedAt,
    ).toBeTruthy();
  });
  test("R2-AT-03: parent exit with an owned surviving descendant is not quiescence", async () => {
    const ready = barrier<number>();
    const childProgram = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore',env:process.env});console.log(c.pid);c.unref();`;
    const parent = spawn(process.execPath, ["-e", childProgram], {
      env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    const lifecycle = new ProcessLifecycle(parent);
    parent.stdout!.once("data", (bytes) =>
      ready.resolve(Number(bytes.toString().trim())),
    );
    const descendant = await ready.promise;
    cleanup.unshift(async () => {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {}
      await lifecycle.stop();
    });
    const evidence = await lifecycle.completion(5_000);
    expect(evidence.closedAt).not.toBeNull();
    expect(evidence.state).toBe("uncertain");
    expect(evidence.remainingGroup).toBe("present");
    if (process.platform === "win32")
      expect(evidence.remainingDescendants).toContain(descendant);
    process.kill(descendant, "SIGKILL");
  });
  test.skipIf(process.platform === "win32")(
    "explicit stop escalates an owned group member that outlives its exited leader",
    async () => {
      const ready = barrier<number>();
      // The leader exits on SIGTERM; its same-group child ignores SIGTERM.
      const childProgram = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},10000)"],{stdio:'ignore',env:process.env});console.log(c.pid);c.unref();setInterval(()=>{},10000);`;
      const parent = spawn(process.execPath, ["-e", childProgram], {
        env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
        stdio: "pipe",
        detached: true,
      });
      const lifecycle = new ProcessLifecycle(parent);
      parent.stdout!.once("data", (bytes) =>
        ready.resolve(Number(bytes.toString().trim())),
      );
      const descendant = await ready.promise;
      cleanup.unshift(async () => {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      });
      const evidence = await lifecycle.stop(1_000);
      expect(evidence.closedAt).not.toBeNull();
      expect(evidence.remainingGroup).toBe("absent");
      expect(evidence.state).toBe("quiescent");
      expect(() => process.kill(descendant, 0)).toThrow();
    },
  );
  test("R2-AT-04: awaited idempotent shutdown drains active checks before closing storage and reopening does not replay", async () => {
    const f = await setup(
      (marker) =>
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'effect\\n');console.log('ready');setInterval(()=>{},10000);`,
    );
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true);
    const running = service.checks.execute(
      service.coordinator.repository,
      f.plan,
      f.plan.digest,
    );
    await vi.waitFor(() =>
      expect(
        service.store
          .list<any>("check-log")
          .map((l) => l.text)
          .join(""),
      ).toContain("ready"),
    );
    const shutdown = service.close();
    expect(service.close()).toBe(shutdown);
    await shutdown;
    expect((await running).result).toBe("error");
    const reopened = new Service(f.directory, f.key, () => {}, true);
    try {
      expect(reopened.checks.list("p").executions).toHaveLength(1);
      expect(reopened.checks.list("p").executions[0].state).toBe("cancelled");
      expect(await readFile(f.marker, "utf8")).toBe("effect\n");
    } finally {
      await reopened.close();
    }
  });
  test("R2-AT-04: finalized execution callbacks never access persistence after shutdown", async () => {
    const f = await setup();
    let child: ReturnType<typeof spawn> | undefined;
    const checks = new CheckExecutions(f.store, {
      beforeFinalCommit: () => {
        child = [...(checks as any).active.values()][0].lifecycle.child;
      },
    });
    await checks.execute(f.repository, f.plan, f.plan.digest);
    await checks.shutdown();
    f.store.close();
    const writes = vi.spyOn(f.store, "put");
    child!.stdout!.emit("data", "late output\n");
    child!.emit("exit", 0, null);
    child!.emit("close", 0, null);
    expect(writes).not.toHaveBeenCalled();
  });
});
