import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import { readFile, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import Database from "better-sqlite3-multiple-ciphers";
import { Store } from "../packages/persistence/store";
import { BLOB_SCHEMA_VERSION } from "../packages/persistence/migrations/blobs";
import {
  migrateWithBackup,
  restoreMigrationBackup,
} from "../packages/persistence/migrations/backup";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import { Coordinator } from "../packages/runtime/coordinator";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import {
  canonicalWorkspaceIdentity,
  WorkspaceOwnership,
} from "../packages/workspace/ownership";
import {
  assertDependencyGraph,
  assertTransition,
  type AgentSession,
  type ExecutionAttempt,
  type Task,
  type Workspace,
} from "../packages/domain/workflow";
import { now } from "../packages/domain/invariants";
import type { Run } from "../packages/domain/types";
import { fixture } from "./helpers";
const fixtures: Array<
  Awaited<ReturnType<typeof fixture>> & { close?: () => void | Promise<void> }
> = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  const project = {
    id: "p",
    name: "Fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  return { ...f, project };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close?.();
    try {
      f.store.close();
    } catch {}
    await rm(f.directory, { recursive: true, force: true });
  }
});
function open(file: string, key: string) {
  const db = new Database(file);
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${key}'`);
  return db;
}
function run(projectId = "p", conversationId = "c"): Run {
  return {
    id: "r",
    projectId,
    conversationId,
    provider: "codex",
    installationId: "i",
    installationRevisionId: "rev",
    runtimeVersion: null,
    executableIdentity: "exe",
    model: "requested-only",
    mode: "edit",
    status: "completed",
    nativeSessionId: "legacy-native",
    nativeTurnId: "legacy-turn",
    error: null,
    createdAt: now(),
  };
}
function legacySchema2(db: Database) {
  db.exec(
    "DROP TRIGGER control_document_insert;DROP TRIGGER control_document_update;DROP TRIGGER control_document_delete;DROP TABLE control_changes;DROP TABLE coordinator_owners;DROP TABLE workspace_leases;DROP INDEX coordination_task_project;DROP INDEX coordination_session_project;DROP INDEX coordination_workflow_project;DROP INDEX coordination_attempt_state;DROP INDEX protected_execution_state;DROP TABLE protected_blob_refs;DROP TABLE protected_blob_chunks;DROP TABLE protected_blob_staging;DROP TABLE protected_blobs;DELETE FROM documents WHERE kind='migration';PRAGMA user_version=2;",
  );
}
describe("coordination migration and recovery", () => {
  test("preserves legacy runs, tombstones and unknown provenance with an encrypted restorable backup", async () => {
    const f = await setup(),
      file = path.join(f.directory, "history.sqlite");
    f.store.put("conversation", {
      id: "c",
      projectId: "p",
      title: "PRIVATE_MIGRATION_CANARY",
      nativeSessions: { codex: "legacy-native" },
      createdAt: now(),
    });
    f.store.put("run", run());
    f.store.put("run", { ...run("p", "deleted"), id: "deleted-run" });
    f.store.put("tombstone", { id: "deleted", deletedAt: now() });
    f.store.put("snapshot", {
      id: "s",
      conversationId: "c",
      projectId: "p",
      provider: "claude",
      text: "PRIVATE_MIGRATION_CANARY",
      hash: "source-hash",
      sourceMessageIds: ["m"],
      createdAt: now(),
    });
    f.store.close();
    const legacy = open(file, f.key);
    legacySchema2(legacy);
    legacy.close();
    const migrated = new Store(file, f.key);
    const migration = migrated.get<any>("migration", "coordination-v3");
    expect([...migrated.iterate<ExecutionAttempt>("attempt")]).toHaveLength(1);
    const attempt = [...migrated.iterate<ExecutionAttempt>("attempt")][0];
    expect(attempt.requestedModel).toBe("requested-only");
    expect(attempt.reportedModel).toBeNull();
    expect(attempt.inputManifest.baseRevision).toBeNull();
    const sessions = [...migrated.iterate<AgentSession>("agent-session")];
    expect(
      sessions.every(
        (session) =>
          !session.resumable &&
          session.accountKey === null &&
          session.continuity === "unknown",
      ),
    ).toBe(true);
    expect(migrated.get<any>("context-package", "s").hash).toBe("source-hash");
    expect(migrated.get<any>("context-package", "s").completeness).toBe(
      "legacy-unknown",
    );
    expect(migrated.get("tombstone", "deleted")).toBeTruthy();
    const bytes = await readFile(migration.backup);
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(bytes.includes(Buffer.from("PRIVATE_MIGRATION_CANARY"))).toBe(false);
    const restored = path.join(f.directory, "restored.sqlite");
    restoreMigrationBackup(migration.backup, restored, f.key, 2);
    const check = open(restored, f.key);
    expect(check.prepare("PRAGMA user_version").get().user_version).toBe(2);
    expect(check.prepare("PRAGMA integrity_check").get().integrity_check).toBe(
      "ok",
    );
    expect(
      check.prepare("SELECT count(*) n FROM documents WHERE kind='run'").get()
        .n,
    ).toBe(2);
    check.close();
    migrated.close();
  });
  test("conversation deletion removes coordination context/session/attempt derivatives and keeps its tombstone", async () => {
    const f = await setup();
    for (const kind of [
      "context-package",
      "context-package-revision",
      "agent-session",
      "agent-session-revision",
      "attempt",
      "attempt-revision",
      "task",
      "task-revision",
      "artifact",
    ]) {
      f.store.put(kind, {
        id: kind,
        projectId: "p",
        conversationId: "c",
        text: "PRIVATE_DERIVATIVE",
      });
    }
    f.store.deleteConversation("c");
    for (const kind of [
      "context-package",
      "context-package-revision",
      "agent-session",
      "agent-session-revision",
      "attempt",
      "attempt-revision",
      "task",
      "task-revision",
      "artifact",
    ])
      expect(f.store.get(kind, kind)).toBeUndefined();
    expect(f.store.get("tombstone", "c")).toBeTruthy();
  });
  test("a failed migration rolls back schema and records, and future schemas reject writes", async () => {
    const f = await setup(),
      file = path.join(f.directory, "history.sqlite");
    expect(() =>
      migrateWithBackup(
        f.store.db,
        file,
        f.key,
        BLOB_SCHEMA_VERSION,
        BLOB_SCHEMA_VERSION + 1,
        () => {
          f.store.db.exec("CREATE TABLE interrupted_migration(id TEXT)");
          throw new Error("fault");
        },
      ),
    ).toThrow("fault");
    expect(f.store.db.prepare("PRAGMA user_version").get().user_version).toBe(
      BLOB_SCHEMA_VERSION,
    );
    expect(
      f.store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='interrupted_migration'",
        )
        .get(),
    ).toBeUndefined();
    f.store.db.exec(`PRAGMA user_version=${BLOB_SCHEMA_VERSION + 1}`);
    f.store.close();
    expect(() => new Store(file, f.key)).toThrow("newer Topsl");
  });
  test("a second coordinator cannot run recovery or dispatch for the owned profile", async () => {
    const f = await setup(),
      first = new Coordinator(f.store);
    fixtures.at(-1)!.close = () => first.close();
    f.store.put("run", { ...run(), status: "running" });
    f.store.put("approval", { id: "pending", runId: "r" });
    const second = new Store(path.join(f.directory, "history.sqlite"), f.key);
    expect(() => new Coordinator(second)).toThrow(
      "already has a coordination owner",
    );
    expect(second.get<Run>("run", "r")?.status).toBe("running");
    expect(second.get("approval", "pending")).toBeTruthy();
    second.close();
  });
  test("startup preserves unknown dispatch without replay", async () => {
    const f = await setup(),
      repo = new CoordinationRepository(f.store),
      workspace = repo.ensureWorkspace(f.project),
      task = repo.createTask({
        projectId: "p",
        workspaceId: workspace.id,
        title: "Work",
        role: "implementer",
      }),
      ready = repo.transitionTask(task.id, task.revision, "ready"),
      attempt = repo.prepareAttempt({
        taskId: task.id,
        expectedRevision: ready.revision,
        provider: "codex",
        requestedModel: "model",
      });
    const coordinator = new Coordinator(f.store);
    fixtures.at(-1)!.close = () => coordinator.close();
    expect(repo.require<ExecutionAttempt>("attempt", attempt.id).state).toBe(
      "uncertain",
    );
    expect(repo.all("operation-intent")).toHaveLength(0);
  });
});
describe("transactional workspace ownership", () => {
  test("symlink aliases contend; expiration while a process is alive never releases the writer", async () => {
    const f = await setup(),
      owner = new WorkspaceOwnership(f.store);
    owner.acquireProfile();
    fixtures.at(-1)!.close = () => owner.releaseProfile();
    const alias = path.join(f.directory, "alias");
    await symlink(
      f.directory,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const identity = canonicalWorkspaceIdentity(f.directory),
      other = canonicalWorkspaceIdentity(alias);
    expect(other.filesystemIdentity).toBe(identity.filesystemIdentity);
    const lease = owner.acquire(
      { id: "w", projectId: "p", root: f.directory, ...identity },
      "a1",
    );
    owner.bindExecution("a1", lease.generation, process.pid, "bound-process");
    lease.expiresAt = "2000-01-01T00:00:00.000Z";
    f.store.db
      .prepare("UPDATE workspace_leases SET body=? WHERE filesystem_identity=?")
      .run(JSON.stringify(lease), lease.filesystemIdentity);
    expect(() =>
      owner.acquire(
        { id: "alias", projectId: "p2", root: alias, ...other },
        "a2",
      ),
    ).toThrow("Expiry does not prove termination");
    expect(owner.forAttempt("a1")?.state).toBe("held");
  });
  test("separate workspace writers progress with distinct generations; stale owner release fails", async () => {
    const f = await setup(),
      owner = new WorkspaceOwnership(f.store);
    owner.acquireProfile();
    fixtures.at(-1)!.close = () => owner.releaseProfile();
    const { mkdir } = await import("node:fs/promises");
    const second = path.join(f.directory, "second");
    await mkdir(second);
    const identity = canonicalWorkspaceIdentity(f.directory),
      other = canonicalWorkspaceIdentity(second);
    const lease = owner.acquire(
      { id: "w", projectId: "p", root: f.directory, ...identity },
      "a1",
    );
    expect(
      owner.acquire({ id: "w2", projectId: "p", root: second, ...other }, "a2")
        .filesystemIdentity,
    ).not.toBe(lease.filesystemIdentity);
    expect(() =>
      owner.release(
        "a1",
        lease.generation,
        {
          level: "source-observation",
          source: "exit",
          observedAt: now(),
          detail: "exit",
        },
        "stale-owner",
      ),
    ).toThrow("owner or generation changed");
    owner.release("a1", lease.generation, {
      level: "source-observation",
      source: "exit",
      observedAt: now(),
      detail: "exit",
    });
    const next = owner.acquire(
      { id: "w", projectId: "p", root: f.directory, ...identity },
      "a3",
    );
    expect(next.generation).toBe(lease.generation + 1);
    expect(() => owner.assertLease("a1", lease.generation)).toThrow("stale");
  });
});
describe("domain transitions and multi-session attribution", () => {
  test("rejects cycles, missing dependencies and inference-only acceptance", async () => {
    expect(() =>
      assertDependencyGraph([
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: ["a"] },
      ]),
    ).toThrow("cycle");
    expect(() =>
      assertDependencyGraph([{ id: "a", dependencies: ["missing"] }]),
    ).toThrow("does not exist");
    expect(() => assertTransition("workflow", "running", "accepted")).toThrow(
      "Invalid",
    );
    const f = await setup(),
      repo = new CoordinationRepository(f.store),
      workspace = repo.ensureWorkspace(f.project),
      task = repo.createTask({
        projectId: "p",
        workspaceId: workspace.id,
        title: "Build",
        role: "implementer",
      });
    expect(() =>
      repo.transitionTask(task.id, task.revision + 1, "ready"),
    ).toThrow("revision changed");
    let latest = repo.transitionTask(task.id, task.revision, "ready");
    latest = repo.transitionTask(latest.id, latest.revision, "active");
    latest = repo.transitionTask(latest.id, latest.revision, "submitted");
    latest = repo.transitionTask(latest.id, latest.revision, "verifying");
    expect(() =>
      repo.transitionTask(latest.id, latest.revision, "accepted"),
    ).toThrow("current candidate");
  });
  test("multiple session bindings are retained and one session cannot have simultaneous turns", async () => {
    const f = await setup(),
      repo = new CoordinationRepository(f.store),
      workspace = repo.ensureWorkspace(f.project);
    function task() {
      let t = repo.createTask({
        projectId: "p",
        workspaceId: workspace.id,
        title: "Build",
        role: "implementer",
      });
      return repo.transitionTask(t.id, t.revision, "ready");
    }
    const first = task(),
      attempt = repo.prepareAttempt({
        taskId: first.id,
        expectedRevision: first.revision,
        provider: "codex",
        requestedModel: "model",
        profileId: "profile",
        accountKey: "account",
        runtimeRevision: "runtime",
        executableIdentity: "exe",
      });
    const session = repo.bindSession(attempt.sessionId, {
      nativeSessionId: "thread1",
      profileId: "profile",
      accountKey: "account",
      runtimeRevision: "runtime",
      executableIdentity: "exe",
      evidence: {
        level: "provider-ack",
        source: "fixture",
        observedAt: now(),
        detail: "binding",
      },
    });
    const second = task();
    expect(() =>
      repo.prepareAttempt({
        taskId: second.id,
        expectedRevision: second.revision,
        provider: "codex",
        requestedModel: "model",
        sessionId: session.id,
        profileId: "profile",
        accountKey: "account",
        runtimeRevision: "runtime",
        executableIdentity: "exe",
      }),
    ).toThrow("active turn");
    const fresh = repo.prepareAttempt({
      taskId: second.id,
      expectedRevision: second.revision,
      provider: "codex",
      requestedModel: "model",
      sessionId: session.id,
      freshSession: true,
    });
    expect(fresh.sessionId).not.toBe(session.id);
    expect(
      repo.all<AgentSession>("agent-session", { projectId: "p" }),
    ).toHaveLength(2);
    expect(
      repo.require<AgentSession>("agent-session", fresh.sessionId)
        .forkOfSessionId,
    ).toBe(session.id);
  });
  test("uncertain imported sessions cannot be upgraded to resumable continuity", async () => {
    const f = await setup(),
      repo = new CoordinationRepository(f.store),
      workspace = repo.ensureWorkspace(f.project),
      task = repo.createTask({
        projectId: "p",
        workspaceId: workspace.id,
        title: "Review",
        role: "reviewer",
      }),
      ready = repo.transitionTask(task.id, task.revision, "ready");
    f.store.put("agent-session", {
      id: "legacy",
      projectId: "p",
      workspaceId: workspace.id,
      role: "reviewer",
      provider: "codex",
      resumable: false,
      continuity: "unknown",
    });
    expect(() =>
      repo.prepareAttempt({
        taskId: task.id,
        expectedRevision: ready.revision,
        provider: "codex",
        requestedModel: "model",
        sessionId: "legacy",
      }),
    ).toThrow("not verified");
  });
});
describe("legacy runtime participation", () => {
  test("aliases cannot bypass lease ownership and refused start leaves no orphan attempt", async () => {
    const f = await setup(),
      runtime = new RuntimeManager(
        f.store,
        () => {},
        () => {},
        (_exe, cwd) =>
          new RpcPeer(
            process.execPath,
            [path.resolve("tests/fixtures/codex.cjs")],
            cwd,
            { ...nativeEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
          ),
      );
    fixtures.at(-1)!.close = () => runtime.close();
    const conversation = {
      id: "c",
      projectId: "p",
      title: "Chat",
      nativeSessions: {},
      createdAt: now(),
    };
    f.store.put("conversation", conversation);
    const first = await runtime.start(
      f.installation,
      conversation,
      f.project,
      "hold",
      "fixture-model",
      "edit",
    );
    const before = [...f.store.iterate<ExecutionAttempt>("attempt")].length;
    const alias = path.join(f.directory, "alias");
    await symlink(
      f.directory,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const project = { ...f.project, id: "alias-project", path: alias },
      other = { ...conversation, id: "other", projectId: project.id };
    f.store.put("project", project);
    f.store.put("conversation", other);
    await expect(
      runtime.start(
        f.installation,
        other,
        project,
        "hello",
        "fixture-model",
        "edit",
      ),
    ).rejects.toThrow("writer lease");
    expect([...f.store.iterate<ExecutionAttempt>("attempt")]).toHaveLength(
      before,
    );
    await runtime.interrupt(first.id);
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", first.id)?.status).toBe("interrupted"),
    );
  });
  test("completion is submitted and lease release waits for bound child exit evidence", async () => {
    const f = await setup(),
      runtime = new RuntimeManager(
        f.store,
        () => {},
        () => {},
        (_exe, cwd) =>
          new RpcPeer(
            process.execPath,
            [path.resolve("tests/fixtures/codex.cjs")],
            cwd,
            { ...nativeEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
          ),
      );
    fixtures.at(-1)!.close = () => runtime.close();
    const conversation = {
      id: "c",
      projectId: "p",
      title: "Chat",
      nativeSessions: {},
      createdAt: now(),
    };
    f.store.put("conversation", conversation);
    const run = await runtime.start(
      f.installation,
      conversation,
      f.project,
      "hello",
      "fixture-model",
      "edit",
    );
    await vi.waitFor(() =>
      expect(runtime.coordinator.attemptForRun(run.id)?.state).toBe(
        "completed",
      ),
    );
    const attempt = runtime.coordinator.attemptForRun(run.id)!;
    expect(f.store.get<Task>("task", attempt.taskId)?.state).toBe("submitted");
    await vi.waitFor(() =>
      expect(
        runtime.coordinator.ownership
          .list()
          .every((lease) => lease.state === "released"),
      ).toBe(true),
    );
  });
});
