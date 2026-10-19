// Campaign 2026-10-19-comprehensive, packet p2a-storage-authority.
// Real child processes that hold the profile and are SIGKILLed; the parent
// then reopens from what is actually on disk (DATA-09, TASK-03, TASK-05), plus
// runtime shutdown with a live stand-in child (BOUND-05 P).
import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { Store } from "../packages/persistence/store";
import { ProtectedBlobs } from "../packages/persistence/blobs";
import { Coordinator } from "../packages/runtime/coordinator";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import { hash, now } from "../packages/domain/invariants";
import type { Project, Run } from "../packages/domain/types";
import type { ExecutionAttempt, WorkspaceLease } from "../packages/domain/workflow";
import { Service } from "../apps/service/service";
import { fixture } from "./helpers";

const repo = path.resolve(".");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function profile() {
  const f = await fixture();
  cleanups.push(async () => {
    try {
      f.store.close();
    } catch {}
    await rm(f.directory, { recursive: true, force: true });
  });
  return f;
}
function project(id: string, folder: string): Project {
  return { id, name: id, path: folder, realPath: folder, trusted: true, createdAt: now() };
}
/** Bundles a worker that imports the real repository modules, as the existing
 * R2-AT-39 crash test does, and runs it under the same Electron-as-Node. */
async function worker(directory: string, name: string, source: string, input: unknown) {
  const entry = path.join(directory, `${name}.ts`),
    outfile = path.join(directory, `${name}.cjs`);
  // REPO sits inside string-literal import specifiers. A Windows path's
  // backslashes would be read as escapes there ("D:\a\Topsl" became
  // "D:aTopsl" in Windows CI run 39271847356), so embed it with forward
  // slashes, which Windows and esbuild accept as an absolute path.
  await writeFile(entry, source.replaceAll("REPO", repo.replaceAll("\\", "/")));
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    packages: "external",
    logLevel: "silent",
  });
  const child = spawn(process.execPath, [outfile], {
    env: {
      PATH: process.env.PATH,
      // Windows processes need SystemRoot for system DLL and socket setup.
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: path.join(repo, "node_modules"),
      WORKER_INPUT: JSON.stringify(input),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr!.on("data", (bytes) => (diagnostics = (diagnostics + bytes).slice(-8000)));
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    lines.push(line);
    waiters.splice(0).forEach((wake) => wake());
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  async function next(prefix: string): Promise<string> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const index = lines.findIndex((line) => line.startsWith(prefix));
      if (index >= 0) return lines.splice(index, 1)[0].slice(prefix.length).trim();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`worker exited before ${prefix}: ${diagnostics}`);
      if (Date.now() > deadline) throw new Error(`worker timed out before ${prefix}: ${diagnostics}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  }
  return {
    child: child as ChildProcess,
    next,
    send: (line: string) => child.stdin!.write(line + "\n"),
    kill: async () => {
      child.kill("SIGKILL");
      return exited;
    },
  };
}

describe("DATA-09 crash while capturing protected blobs", () => {
  test("a SIGKILLed capture never becomes a readable candidate; restart cleanup keeps every referenced byte", async () => {
    const f = await profile();
    const blobs = new ProtectedBlobs(f.store);
    const shared = Buffer.from("DATA09 shared bytes retained by a completed candidate");
    const sharedHash = hash(shared);
    // A completed, independently retained candidate that shares one blob.
    blobs.stage("kept:shared", 0, shared);
    f.store.transaction(() => {
      blobs.publish("kept:shared", sharedHash, shared.length);
      blobs.reference("p", "kept", { path: "shared.txt", hash: sharedHash });
    });
    f.store.immutable("candidate", {
      id: "kept",
      projectId: "p",
      workflowId: "w",
      files: [{ path: "shared.txt", hash: sharedHash, bytes: shared.length }],
    });
    f.store.put("candidate-capture", { id: "kept", projectId: "p", state: "complete", createdAt: now() });
    f.store.close();
    const orphanStaged = Buffer.from("DATA09 staged only, never published");
    const orphanReferenced = Buffer.from("DATA09 published and referenced before the manifest");
    const w = await worker(
      f.directory,
      "capture-worker",
      `
      import path from "node:path";
      import { createHash } from "node:crypto";
      import { Store } from "REPO/packages/persistence/store";
      import { ProtectedBlobs, captureOwner } from "REPO/packages/persistence/blobs";
      const input = JSON.parse(process.env.WORKER_INPUT!);
      const store = new Store(path.join(input.directory, "history.sqlite"), input.key);
      const blobs = new ProtectedBlobs(store);
      for (const capture of input.captures) {
        // Same order as captureCandidate: a capturing record owned by this process,
        // then per file stage, and publish+reference in one transaction.
        store.put("candidate-capture", { id: capture.id, projectId: "p", workflowId: "w", state: "capturing", owner: captureOwner, createdAt: new Date().toISOString() });
        for (const file of capture.files) {
          const bytes = Buffer.from(file.content, "base64");
          const digest = createHash("sha256").update(bytes).digest("hex");
          const staging = capture.id + ":" + file.path;
          blobs.stage(staging, 0, bytes);
          if (capture.phase === "referenced")
            store.transaction(() => {
              blobs.publish(staging, digest, bytes.length);
              blobs.reference("p", capture.id, { path: file.path, hash: digest });
            });
        }
      }
      console.log("READY " + process.pid);
      setInterval(() => {}, 1000);
      `,
      {
        directory: f.directory,
        key: f.key,
        captures: [
          { id: "staged", phase: "staged", files: [{ path: "a.txt", content: orphanStaged.toString("base64") }] },
          {
            id: "referenced",
            phase: "referenced",
            files: [
              { path: "shared.txt", content: shared.toString("base64") },
              { path: "b.txt", content: orphanReferenced.toString("base64") },
            ],
          },
        ],
      },
    );
    await w.next("READY");
    const file = path.join(f.directory, "history.sqlite");
    const counts = (store: Store) => ({
      staging: store.db.prepare("SELECT count(*) n FROM protected_blob_staging").get().n,
      refs: store.db.prepare("SELECT count(*) n FROM protected_blob_refs").get().n,
      blobs: store.db.prepare("SELECT count(*) n FROM protected_blobs").get().n,
    });
    // Negative control: while the capturing process is alive, reopening the
    // profile (which runs recovery) must not treat its capture as abandoned.
    const whileAlive = new Store(file, f.key);
    expect(whileAlive.get<any>("candidate-capture", "staged").state).toBe("capturing");
    expect(whileAlive.get<any>("candidate-capture", "referenced").state).toBe("capturing");
    // One staged-only chunk; the referenced capture already moved its two chunks.
    expect(counts(whileAlive)).toEqual({ staging: 1, refs: 3, blobs: 2 });
    whileAlive.close();
    expect((await w.kill()).signal).toBe("SIGKILL");
    f.store = new Store(file, f.key);
    const store = f.store;
    expect(store.get<any>("candidate-capture", "staged").state).toBe("recovered");
    expect(store.get<any>("candidate-capture", "referenced").state).toBe("recovered");
    expect(store.get("candidate", "staged")).toBeUndefined();
    expect(store.get("candidate", "referenced")).toBeUndefined();
    expect(counts(store)).toEqual({ staging: 0, refs: 1, blobs: 1 });
    const reader = new ProtectedBlobs(store);
    expect(() =>
      reader.read("p", "referenced", { path: "b.txt", hash: hash(orphanReferenced), bytes: orphanReferenced.length }),
    ).toThrow("No protected blob reference");
    expect(() =>
      reader.read("p", "referenced", { path: "shared.txt", hash: sharedHash, bytes: shared.length }),
    ).toThrow("No protected blob reference");
    expect(
      reader.read("p", "kept", { path: "shared.txt", hash: sharedHash, bytes: shared.length })?.equals(shared),
    ).toBe(true);
  });
});

describe("DATA-11 abrupt service death and WAL recovery", () => {
  test("committed records written by a SIGKILLed process are recovered from the WAL; the uncommitted transaction is absent", async () => {
    const f = await profile();
    f.store.close();
    const w = await worker(
      f.directory,
      "wal-worker",
      `
      import path from "node:path";
      import { Store } from "REPO/packages/persistence/store";
      const input = JSON.parse(process.env.WORKER_INPUT!);
      const store = new Store(path.join(input.directory, "history.sqlite"), input.key);
      for (let i = 0; i < 200; i++)
        store.message({ id: "c" + i, projectId: "p", conversationId: "c", role: "user", provider: "codex", text: "DATA11 committed " + i, runId: null, nativeId: null, createdAt: new Date().toISOString() });
      // An open transaction that never commits.
      store.db.exec("BEGIN IMMEDIATE");
      store.db.prepare("INSERT INTO documents(kind,id,body) VALUES('message','uncommitted','{}')").run();
      console.log("READY");
      setInterval(() => {}, 1000);
      `,
      { directory: f.directory, key: f.key },
    );
    await w.next("READY");
    expect((await w.kill()).signal).toBe("SIGKILL");
    f.store = new Store(path.join(f.directory, "history.sqlite"), f.key);
    expect(f.store.db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    expect(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='message'").get().n).toBe(200);
    expect(f.store.get("message", "uncommitted")).toBeUndefined();
    expect(f.store.searchPage("p", "committed", { limit: 500 }).items).toHaveLength(200);
  });
});

const coordinationWorker = `
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Store } from "REPO/packages/persistence/store";
import { Coordinator } from "REPO/packages/runtime/coordinator";
const input = JSON.parse(process.env.WORKER_INPUT!);
const store = new Store(path.join(input.directory, "history.sqlite"), input.key);
const coordinator = new Coordinator(store);
const repo = coordinator.repository;
const ready = (projectId: string) => {
  const project = store.get<any>("project", projectId);
  const workspace = repo.ensureWorkspace(project);
  const task = repo.createTask({ projectId, workspaceId: workspace.id, title: "task " + projectId, role: "implementer" });
  const t = repo.transitionTask(task.id, task.revision, "ready");
  const attempt = repo.prepareAttempt({ taskId: t.id, expectedRevision: t.revision, provider: "codex", requestedModel: "fixture-model" });
  // An enforced no-fan-out policy weighs one slot, so two writers fit the budget.
  coordinator.concurrency.setPolicy(attempt.id, { mode: "disabled", maxChildren: 0, enforced: true, evidence: "campaign fixture", approvalDigest: null });
  return attempt;
};
const out: any = { pid: process.pid, instanceId: coordinator.ownership.instanceId };
// Never launched: prepared, no lease, no intent.
out.neverLaunched = ready("A").id;
// Unknown outcome: begun (lease held) and a dispatch recorded, no acknowledgement.
let unknown = coordinator.beginAttempt(ready("B").id);
const intent = repo.recordIntent(unknown.id, "turn", "digest-unknown");
repo.updateIntent(intent.id, "dispatch-recorded");
unknown = repo.transitionAttempt(unknown.id, unknown.revision, unknown.state, { operationIntentId: intent.id });
out.unknown = unknown.id;
out.intent = intent.id;
if (input.knownActive) {
  // Known active: running, lease bound to a live process that outlives us.
  let active = coordinator.beginAttempt(ready("C").id);
  active = repo.transitionAttempt(active.id, active.revision, "running");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: { ELECTRON_RUN_AS_NODE: "1" } });
  sleeper.unref();
  coordinator.ownership.bindExecution(active.id, active.leaseGeneration!, sleeper.pid!, "campaign-sleeper");
  out.knownActive = active.id;
  out.sleeper = sleeper.pid;
}
console.log("READY " + JSON.stringify(out));
createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    if (line === "step-down") { coordinator.close(); console.log("STEPPED"); return; }
    if (line === "release") {
      const lease = coordinator.ownership.forAttempt(out.unknown)!;
      coordinator.ownership.release(out.unknown, lease.generation, { level: "source-observation", source: "exit", observedAt: new Date().toISOString(), detail: "stale owner claims exit" });
      console.log("RESULT released");
      return;
    }
    if (line === "acquire") {
      const project = store.get<any>("project", "A");
      const workspace = store.get<any>("workspace", "legacy-workspace:A");
      coordinator.ownership.acquire({ ...workspace, root: project.realPath }, "stale-attempt");
      console.log("RESULT acquired");
      return;
    }
  } catch (error: any) {
    console.log("RESULT error " + error.message);
  }
});
setInterval(() => {}, 1000);
`;
async function coordinationProfile() {
  const f = await profile();
  for (const id of ["A", "B", "C"]) {
    const folder = id === "A" ? f.directory : path.join(f.directory, `project-${id}`);
    if (id !== "A") await mkdir(folder);
    f.store.put("project", project(id, folder));
  }
  f.store.close();
  return f;
}
const leases = (store: Store) =>
  store.db
    .prepare("SELECT body FROM workspace_leases ORDER BY filesystem_identity")
    .all()
    .map((row: { body: string }) => JSON.parse(row.body) as WorkspaceLease);

describe("TASK-03 and TASK-05 profile ownership across real processes", () => {
  test("a live owner process excludes a second service; after SIGKILL the next owner recovers without replay", async () => {
    const f = await coordinationProfile();
    const file = path.join(f.directory, "history.sqlite");
    const w = await worker(f.directory, "coordination-worker", coordinationWorker, {
      directory: f.directory,
      key: f.key,
      knownActive: true,
    });
    const ids = JSON.parse(await w.next("READY"));
    cleanups.push(() => {
      try {
        process.kill(ids.sleeper, "SIGKILL");
      } catch {}
    });
    // TASK-03: the second service and a second coordinator are refused, and the
    // refused instance performs no recovery mutation.
    expect(() => new Service(f.directory, f.key, () => {}, true)).toThrow("already has a coordination owner");
    const observer = new Store(file, f.key);
    expect(() => new Coordinator(observer)).toThrow("already has a coordination owner");
    const owner = JSON.parse(observer.db.prepare("SELECT body FROM coordinator_owners").get().body);
    expect(owner).toMatchObject({ pid: ids.pid, instanceId: ids.instanceId, generation: 1 });
    const state = (store: Store, id: string) => store.get<ExecutionAttempt>("attempt", id)!.state;
    expect([state(observer, ids.neverLaunched), state(observer, ids.unknown), state(observer, ids.knownActive)]).toEqual([
      "prepared",
      "starting",
      "running",
    ]);
    expect(leases(observer).map((l) => l.state)).toEqual(["held", "held"]);
    expect(observer.db.prepare("SELECT count(*) n FROM events WHERE kind='coordinator.recovered'").get().n).toBe(1);
    observer.close();

    expect((await w.kill()).signal).toBe("SIGKILL");
    const service = new Service(f.directory, f.key, () => {}, true);
    cleanups.push(() => service.close().catch(() => {}));
    const store = service.store;
    const next = JSON.parse(store.db.prepare("SELECT body FROM coordinator_owners").get().body);
    expect(next).toMatchObject({ pid: process.pid, generation: 2 });
    expect(next.instanceId).not.toBe(ids.instanceId);
    expect(store.db.prepare("SELECT count(*) n FROM events WHERE kind='coordinator.recovered'").get().n).toBe(2);
    // TASK-05: each in-flight attempt is uncertain; the records still tell the
    // three apart, and nothing was replayed or added.
    const attempts = [...store.iterate<ExecutionAttempt>("attempt")];
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.state === "uncertain")).toBe(true);
    const neverLaunched = store.get<ExecutionAttempt>("attempt", ids.neverLaunched)!;
    expect(neverLaunched.operationIntentId ?? null).toBeNull();
    expect(neverLaunched.leaseGeneration ?? null).toBeNull();
    expect(store.get<any>("operation-intent", ids.intent).state).toBe("unknown");
    expect(store.list("operation-intent")).toHaveLength(1);
    const byAttempt = new Map(leases(store).map((l) => [l.attemptId, l]));
    expect(byAttempt.get(ids.unknown)).toMatchObject({ state: "uncertain", execution: { pid: null } });
    expect(byAttempt.get(ids.knownActive)).toMatchObject({ state: "uncertain", execution: { pid: ids.sleeper } });
    expect(byAttempt.has(ids.neverLaunched)).toBe(false);
    // The known-active process really is still running; expiry or restart did
    // not release its writer.
    expect(() => process.kill(ids.sleeper, 0)).not.toThrow();
    expect(store.list("run")).toEqual([]);
    // No automatic replay: a fresh writer on that workspace is refused.
    const repo = service.coordinator.repository;
    const projectC = store.get<Project>("project", "C")!;
    const workspace = repo.ensureWorkspace(projectC);
    const task = repo.createTask({ projectId: "C", workspaceId: workspace.id, title: "retry", role: "implementer" });
    const ready = repo.transitionTask(task.id, task.revision, "ready");
    const retry = repo.prepareAttempt({
      taskId: ready.id,
      expectedRevision: ready.revision,
      provider: "codex",
      requestedModel: "fixture-model",
    });
    expect(() => service.coordinator.beginAttempt(retry.id)).toThrow("uncertain");
    expect(store.list("operation-intent")).toHaveLength(1);
  });
  test("an owner that stepped down cannot release or acquire a writer after another instance takes over", async () => {
    const f = await coordinationProfile();
    const w = await worker(f.directory, "stale-worker", coordinationWorker, {
      directory: f.directory,
      key: f.key,
      knownActive: false,
    });
    const ids = JSON.parse(await w.next("READY"));
    w.send("step-down");
    await w.next("STEPPED");
    const service = new Service(f.directory, f.key, () => {}, true);
    cleanups.push(() => service.close().catch(() => {}));
    const before = leases(service.store);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ attemptId: ids.unknown, state: "uncertain", ownerId: ids.instanceId });
    w.send("release");
    expect(await w.next("RESULT")).toMatch(/^error .*no longer owns/);
    w.send("acquire");
    expect(await w.next("RESULT")).toMatch(/^error .*no longer owns/);
    expect(leases(service.store)).toEqual(before);
    expect(JSON.parse(service.store.db.prepare("SELECT body FROM coordinator_owners").get().body).pid).toBe(process.pid);
    // The live current owner is still the only one that can act.
    service.coordinator.ownership.assertOwner();
  });
});

describe("BOUND-05 runtime shutdown with a live stand-in child", () => {
  test("closing during an active run records it uncertain and keeps the writer lease unreleased", async () => {
    const f = await profile();
    const runtime = new RuntimeManager(
      f.store,
      () => {},
      () => {},
      (_exe, cwd) =>
        new RpcPeer(process.execPath, [path.resolve("tests/fixtures/codex.cjs")], cwd, {
          ...nativeEnvironment(),
          ELECTRON_RUN_AS_NODE: "1",
        }),
    );
    let closed = false;
    cleanups.push(async () => {
      if (!closed) await runtime.close();
    });
    const p = project("p", f.directory);
    f.store.put("project", p);
    const conversation = { id: "c", projectId: "p", title: "Chat", nativeSessions: {}, createdAt: now() };
    f.store.put("conversation", conversation);
    const run = await runtime.start(f.installation, conversation, p, "hold", "fixture-model", "edit");
    await vi.waitFor(() => expect(f.store.get<Run>("run", run.id)?.status).toBe("running"));
    const attempt = runtime.coordinator.attemptForRun(run.id)!;
    expect(runtime.coordinator.ownership.forAttempt(attempt.id)?.state).toBe("held");
    await runtime.close();
    closed = true;
    expect(f.store.get<Run>("run", run.id)).toMatchObject({ status: "uncertain" });
    expect(f.store.get<ExecutionAttempt>("attempt", attempt.id)?.state).toBe("uncertain");
    const lease = leases(f.store).find((l) => l.attemptId === attempt.id)!;
    expect(lease.state).not.toBe("released");
  });
});
