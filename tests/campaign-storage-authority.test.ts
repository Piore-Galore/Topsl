// Campaign 2026-10-19-comprehensive, packet p2a-storage-authority.
// In-process storage and authority cases through the real Store, repositories
// and Service.command. Child-process and CLI cases are in
// campaign-storage-authority-process.test.ts.
import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import Database from "better-sqlite3-multiple-ciphers";
import { Store } from "../packages/persistence/store";
import { ProtectedBlobs } from "../packages/persistence/blobs";
import { BLOB_SCHEMA_VERSION } from "../packages/persistence/migrations/blobs";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import { Configuration } from "../packages/workspace/configuration";
import { commandSchema } from "../packages/domain/commands";
import { hash, now, uid } from "../packages/domain/invariants";
import type { Project } from "../packages/domain/types";
import { assertTransition, type Task, type Workflow } from "../packages/domain/workflow";
import { Service } from "../apps/service/service";
import { captureCandidate } from "../packages/workflows/candidates";
import { fixture } from "./helpers";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function storeFixture() {
  const f = await fixture();
  cleanups.push(async () => {
    try {
      f.store.close();
    } catch {}
    await rm(f.directory, { recursive: true, force: true });
  });
  return f;
}
async function scratch(prefix: string) {
  // Canonical path: approved project folders are compared after realpath.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function project(id: string, folder: string): Project {
  return {
    id,
    name: id,
    path: folder,
    realPath: folder,
    trusted: true,
    createdAt: now(),
  };
}
/** A real Service on an isolated profile with two trusted projects A and B. */
async function serviceFixture() {
  const f: Fixture = await fixture();
  f.store.close();
  const events: any[] = [];
  const service = new Service(f.directory, f.key, (event) => events.push(event), true);
  cleanups.push(async () => {
    await service.close().catch(() => {});
    await rm(f.directory, { recursive: true, force: true });
  });
  const folderB = path.join(f.directory, "project-b");
  await mkdir(folderB);
  const A = project("A", f.directory),
    B = project("B", folderB);
  service.store.put("project", A);
  service.store.put("project", B);
  const repo = service.coordinator.repository;
  const workspaceA = repo.ensureWorkspace(A),
    workspaceB = repo.ensureWorkspace(B);
  return { ...f, service, events, A, B, repo, workspaceA, workspaceB };
}
function rawOpen(file: string, key: string) {
  const db = new Database(file);
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${key}'`);
  return db;
}
function coordinationChanges(store: Store, after: number) {
  return store.db
    .prepare(
      "SELECT kind,id FROM control_changes WHERE sequence>? AND kind IN ('task','task-revision','workflow','workflow-revision','task-input-head','task-input-binding')",
    )
    .all(after);
}

describe("DATA-05 protected content at rest", () => {
  test("canaries in messages, search index, events, candidates, blobs and configuration backups never reach disk in clear", async () => {
    const f = await storeFixture();
    const canary = `DATA05CANARY${randomBytes(6).toString("hex")}`;
    const file = path.join(f.directory, "history.sqlite");
    f.store.message({
      id: "m",
      projectId: "p",
      conversationId: "c",
      role: "assistant",
      provider: "codex",
      text: `${canary} message body`,
      runId: null,
      nativeId: null,
      createdAt: now(),
    });
    f.store.save("note", { id: "n", projectId: "p", text: `${canary} event body` });
    const blobBytes = Buffer.from(`${canary} candidate blob `.repeat(64));
    const blobHash = hash(blobBytes.toString("utf8"));
    const blobs = new ProtectedBlobs(f.store);
    blobs.stage("cand:one", 0, blobBytes);
    f.store.transaction(() => {
      blobs.publish("cand:one", blobHash, blobBytes.length);
      blobs.reference("p", "cand", { path: `${canary}.txt`, hash: blobHash });
    });
    f.store.immutable("candidate", {
      id: "cand",
      projectId: "p",
      workflowId: "w",
      files: [{ path: `${canary}.txt`, hash: blobHash, bytes: blobBytes.length }],
    });
    // A configuration backup through the real Configuration apply path.
    const projectFolder = await scratch("topsl-campaign-config-");
    const instructions = path.join(projectFolder, "AGENTS.md");
    await writeFile(instructions, `${canary} original instructions`);
    const configuration = new Configuration(f.store, () => false);
    const current = await configuration.read(
      "codex",
      project("p", projectFolder),
      "instructions",
    );
    const plan = await configuration.preview(current.path, current.hash, "Replaced instructions.");
    await configuration.apply(plan.id, plan.digest);
    expect(f.store.get<any>("configuration-backup", plan.id).content).toContain(canary);

    async function scan(directory: string) {
      const found: string[] = [];
      for (const name of await readdir(directory)) {
        if (name === "runtime") continue;
        const bytes = await readFile(path.join(directory, name));
        if (bytes.includes(Buffer.from(canary)) || bytes.includes(Buffer.from("SQLite format 3")))
          found.push(name);
      }
      return found;
    }
    // Live WAL and shared memory while the connection is open.
    const live = await readdir(f.directory);
    expect(live).toContain("history.sqlite-wal");
    expect(await scan(f.directory)).toEqual([]);
    // Negative control for the scanner: an unencrypted database with the same
    // canary is detected.
    const control = await scratch("topsl-campaign-plain-");
    const plain = new Database(path.join(control, "plain.sqlite"));
    plain.exec("CREATE TABLE t(v TEXT)");
    plain.prepare("INSERT INTO t VALUES(?)").run(canary);
    plain.close();
    expect(await scan(control)).toEqual(["plain.sqlite"]);
    // After a checkpointing close, the main file and every backup stay encrypted.
    f.store.close();
    expect(await scan(f.directory)).toEqual([]);
    // Wrong key fails at both the Store and the raw SQLCipher boundary.
    expect(() => new Store(file, randomBytes(32).toString("hex"))).toThrow();
    const wrong = rawOpen(file, randomBytes(32).toString("hex"));
    expect(() => wrong.prepare("SELECT count(*) FROM documents").get()).toThrow();
    wrong.close();
    // Positive control: the right key still reads every canary back.
    f.store = new Store(file, f.key);
    expect(f.store.searchPage("p", canary).items.map((m) => m.id)).toEqual(["m"]);
    expect(
      new ProtectedBlobs(f.store)
        .read("p", "cand", { path: `${canary}.txt`, hash: blobHash, bytes: blobBytes.length })
        ?.equals(blobBytes),
    ).toBe(true);
    expect(f.store.get<any>("configuration-backup", plan.id).content).toContain(canary);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM events WHERE body LIKE ?").get(`%${canary}%`).n,
    ).toBeGreaterThan(0);
  });
});

describe("DATA-07 faults during commit and migration", () => {
  test("SQLITE_FULL during a multi-record commit rolls back completely and reopens consistent", async () => {
    const f = await storeFixture();
    const file = path.join(f.directory, "history.sqlite");
    const message = (id: string, text: string) => ({
      id,
      projectId: "p",
      conversationId: "c",
      role: "user" as const,
      provider: "codex" as const,
      text,
      runId: null,
      nativeId: null,
      createdAt: now(),
    });
    f.store.message(message("kept", "committed before the fault"));
    const head = f.store.controlHead();
    const pages: number = f.store.db.prepare("PRAGMA page_count").get().page_count;
    f.store.db.pragma(`max_page_count=${pages + 4}`);
    let error: any;
    try {
      f.store.transaction(() => {
        for (let i = 0; i < 50; i++) f.store.message(message(`lost-${i}`, "x".repeat(20000)));
      });
    } catch (e) {
      error = e;
    }
    expect(error?.code).toBe("SQLITE_FULL");
    expect(f.store.get("message", "lost-0")).toBeUndefined();
    expect(f.store.controlHead()).toBe(head);
    f.store.db.pragma("max_page_count=1073741823");
    f.store.close();
    f.store = new Store(file, f.key);
    expect(f.store.db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    expect(f.store.messagesPage({ projectId: "p" }).items.map((m) => m.id)).toEqual(["kept"]);
    expect(f.store.searchPage("p", "committed").items).toHaveLength(1);
    expect(
      f.store.db.prepare("SELECT count(*) n FROM documents WHERE id LIKE 'lost-%'").get().n,
    ).toBe(0);
  });
  test("a malformed legacy record mid-migration rolls the whole step back; nothing half-migrated, backup encrypted", async () => {
    const f = await storeFixture();
    const file = path.join(f.directory, "history.sqlite");
    f.store.put("project", { ...project("p", f.directory), name: "DATA07MIDCANARY" });
    f.store.close();
    const legacy = rawOpen(file, f.key);
    legacy.exec(
      "DROP TRIGGER control_document_insert;DROP TRIGGER control_document_update;DROP TRIGGER control_document_delete;DROP TABLE control_changes;DROP TABLE coordinator_owners;DROP TABLE workspace_leases;DROP INDEX coordination_task_project;DROP INDEX coordination_session_project;DROP INDEX coordination_workflow_project;DROP INDEX coordination_attempt_state;DROP INDEX protected_execution_state;DROP TABLE protected_blob_refs;DROP TABLE protected_blob_chunks;DROP TABLE protected_blob_staging;DROP TABLE protected_blobs;DELETE FROM documents WHERE kind IN ('migration','workspace','workspace-revision');PRAGMA user_version=2;",
    );
    // A run whose body parses to null: the migration reaches it only after it
    // has already written workspaces for every project.
    legacy.prepare("INSERT INTO documents(kind,id,body) VALUES('run','corrupt','null')").run();
    legacy.close();
    expect(() => new Store(file, f.key)).toThrow();
    const after = rawOpen(file, f.key);
    expect(after.prepare("PRAGMA user_version").get().user_version).toBe(2);
    expect(after.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
    expect(after.prepare("SELECT count(*) n FROM documents WHERE kind='workspace'").get().n).toBe(0);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name='coordinator_owners'").get()).toBeUndefined();
    expect(JSON.parse(after.prepare("SELECT body FROM documents WHERE kind='project'").get().body).name).toBe(
      "DATA07MIDCANARY",
    );
    after.prepare("DELETE FROM documents WHERE kind='run' AND id='corrupt'").run();
    after.close();
    const backups = (await readdir(f.directory)).filter((n) => n.includes(".schema-2.backup-"));
    expect(backups.length).toBeGreaterThan(0);
    for (const name of backups) {
      const bytes = await readFile(path.join(f.directory, name));
      expect(bytes.includes(Buffer.from("DATA07MIDCANARY"))).toBe(false);
      expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    }
    f.store = new Store(file, f.key);
    expect(f.store.db.prepare("PRAGMA user_version").get().user_version).toBe(BLOB_SCHEMA_VERSION);
    expect(f.store.get("workspace", "legacy-workspace:p")).toBeTruthy();
  });
});

describe("DATA-06 and DATA-08 schema migration and newer-schema refusal", () => {
  // Objects each later migration adds, so a current profile can be rolled back
  // to the exact layout of schema 5, 4 or 3 (synthetic fixtures, not a pilot profile).
  const downgrade: Record<number, string> = {
    5: "DROP TABLE protected_blob_refs;DROP TABLE protected_blob_chunks;DROP TABLE protected_blob_staging;DROP TABLE protected_blobs;DELETE FROM documents WHERE kind='migration' AND id='protected-blobs-v6';",
    4: "DROP INDEX protected_execution_state;DELETE FROM documents WHERE kind='migration' AND id='durable-executions-v5';",
    3: "DROP TRIGGER control_document_insert;DROP TRIGGER control_document_update;DROP TRIGGER control_document_delete;DROP TABLE control_changes;DELETE FROM documents WHERE kind='migration' AND id='ordered-events-v4';",
  };
  async function historicalProfile(version: 3 | 4 | 5) {
    const f = await storeFixture();
    const file = path.join(f.directory, "history.sqlite");
    const repo = new CoordinationRepository(f.store);
    const p = project("p", f.directory);
    f.store.put("project", p);
    f.store.put("conversation", { id: "c", projectId: "p", title: "DATA06CANARY chat", nativeSessions: {}, createdAt: now() });
    for (let i = 0; i < 25; i++)
      f.store.message({
        id: `m${i}`,
        projectId: "p",
        conversationId: "c",
        role: i % 2 ? "assistant" : "user",
        provider: i % 3 ? "codex" : "claude",
        text: `DATA06CANARY 量子 message ${i}`,
        runId: null,
        nativeId: `native-${i}`,
        createdAt: now(),
      });
    f.store.put("tombstone", { id: "deleted-conversation", deletedAt: now() });
    f.store.save("run", { id: "r", projectId: "p", conversationId: "c", status: "completed" });
    const workspace = repo.ensureWorkspace(p);
    const task = repo.createTask({ projectId: "p", workspaceId: workspace.id, title: "historical", role: "implementer" });
    const ready = repo.transitionTask(task.id, task.revision, "ready");
    repo.prepareAttempt({ taskId: ready.id, expectedRevision: ready.revision, provider: "codex", requestedModel: "m" });
    const snapshot = (store: Store) => {
      const rows = store.db
        .prepare("SELECT kind,id,body FROM documents WHERE kind!='migration' ORDER BY kind,id")
        .all();
      return {
        rows,
        events: store.db.prepare("SELECT id,kind,body FROM events ORDER BY id").all(),
      };
    };
    const before = snapshot(f.store);
    f.store.close();
    const db = rawOpen(file, f.key);
    for (let v = 5; v >= version; v--) db.exec(downgrade[v]);
    db.exec(`PRAGMA user_version=${version}`);
    db.close();
    return { ...f, file, before, snapshot };
  }
  test.each([5, 4, 3] as const)(
    "schema %i migrates to the current schema with identical records, search, events and an encrypted restorable backup",
    async (version) => {
      const f = await historicalProfile(version);
      f.store = new Store(f.file, f.key);
      cleanups.push(() => f.store.close());
      expect(f.store.db.prepare("PRAGMA user_version").get().user_version).toBe(BLOB_SCHEMA_VERSION);
      expect(f.store.db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
      const after = f.snapshot(f.store);
      expect(after.rows).toEqual(f.before.rows);
      expect(after.events).toEqual(f.before.events);
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const page = f.store.searchPage("p", "DATA06CANARY", { cursor, limit: 10 });
        found.push(...page.items.map((m) => m.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(found.sort()).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`).sort());
      // The ordered event feed works after migration.
      const head = f.store.controlHead();
      f.store.save("run", { id: "r2", projectId: "p", conversationId: "c", status: "completed" });
      expect(f.store.controlPage(head, { projectId: "p" }).events.map((e) => e.id)).toEqual(["r2"]);
      const migrations = f.store.list<any>("migration");
      const step = migrations.find((m) => m.from === version);
      expect(step?.backup).toContain(`.schema-${version}.backup-`);
      const backup = await readFile(step.backup);
      expect(backup.includes(Buffer.from("DATA06CANARY"))).toBe(false);
      expect(backup.includes(Buffer.from("SQLite format 3"))).toBe(false);
      const restoredPath = path.join(f.directory, `restored-${version}.sqlite`);
      const { restoreMigrationBackup } = await import("../packages/persistence/migrations/backup");
      restoreMigrationBackup(step.backup, restoredPath, f.key, version);
      const restored = rawOpen(restoredPath, f.key);
      expect(restored.prepare("PRAGMA user_version").get().user_version).toBe(version);
      expect(restored.prepare("SELECT count(*) n FROM documents WHERE kind='message'").get().n).toBe(25);
      restored.close();
    },
  );
  test("a newer schema is refused before any write and the database bytes are unchanged", async () => {
    const f = await storeFixture();
    const file = path.join(f.directory, "history.sqlite");
    f.store.put("project", { ...project("p", f.directory), name: "DATA08CANARY" });
    f.store.close();
    const db = rawOpen(file, f.key);
    db.exec(`PRAGMA user_version=${BLOB_SCHEMA_VERSION + 1}`);
    db.close();
    const before = await readFile(file);
    const names = (await readdir(f.directory)).sort();
    expect(() => new Store(file, f.key)).toThrow("newer Topsl version");
    expect((await readFile(file)).equals(before)).toBe(true);
    expect((await readdir(f.directory)).sort()).toEqual(names);
    const check = rawOpen(file, f.key);
    expect(JSON.parse(check.prepare("SELECT body FROM documents WHERE kind='project'").get().body).name).toBe(
      "DATA08CANARY",
    );
    check.close();
  });
});

describe("DATA-11 corrupted protected blob chunk", () => {
  test("a corrupted chunk fails precisely for its own candidate; other bytes and records survive repeated reopen", async () => {
    const f = await storeFixture();
    const file = path.join(f.directory, "history.sqlite");
    const blobs = new ProtectedBlobs(f.store);
    const put = (candidate: string, content: Buffer) => {
      const digest = hash(content);
      blobs.stage(`${candidate}:f`, 0, content.subarray(0, 64 * 1024));
      if (content.length > 64 * 1024) blobs.stage(`${candidate}:f`, 1, content.subarray(64 * 1024));
      f.store.transaction(() => {
        blobs.publish(`${candidate}:f`, digest, content.length);
        blobs.reference("p", candidate, { path: "f.bin", hash: digest });
      });
      return { path: "f.bin", hash: digest, bytes: content.length };
    };
    const good = put("good", Buffer.alloc(70 * 1024, 1));
    const bad = put("bad", Buffer.alloc(70 * 1024, 2));
    // Flip bytes inside the second chunk of one blob, as disk corruption would.
    f.store.db
      .prepare("UPDATE protected_blob_chunks SET bytes=? WHERE hash=? AND ordinal=1")
      .run(Buffer.alloc(6 * 1024, 9), bad.hash);
    for (let i = 0; i < 5; i++) {
      f.store.close();
      f.store = new Store(file, f.key);
    }
    const reader = new ProtectedBlobs(f.store);
    expect(() => reader.read("p", "bad", bad)).toThrow("chunk integrity failed");
    // The first chunk of the damaged blob is still readable by range; the other blob is intact.
    expect(reader.read("p", "bad", bad, 0, 1024)?.equals(Buffer.alloc(1024, 2))).toBe(true);
    expect(reader.read("p", "good", good)?.equals(Buffer.alloc(70 * 1024, 1))).toBe(true);
    expect(f.store.db.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
  });
});

describe("DATA-12 immutable identities and duplicate commands", () => {
  test("a repeated requestId returns the original effect; changed parameters and replayed failures do not execute", async () => {
    const f = await serviceFixture();
    const create = {
      type: "task-create" as const,
      requestId: uid(),
      projectId: "A",
      workspaceId: f.workspaceA.id,
      workflowId: null,
      conversationId: null,
      title: "DATA12 task",
      role: "implementer" as const,
      acceptanceCriteria: [],
    };
    const first = await f.service.command(create);
    const again = await f.service.command(create);
    expect(again).toEqual(first);
    const titled = () =>
      f.repo.all<Task>("task", { projectId: "A" }).filter((t) => t.title.startsWith("DATA12"));
    expect(titled()).toHaveLength(1);
    await expect(f.service.command({ ...create, title: "DATA12 changed" })).rejects.toThrow(
      "reused with changed parameters",
    );
    expect(titled().map((t) => t.title)).toEqual(["DATA12 task"]);
    // A failed request is never silently retried, even once it would succeed.
    const stale = {
      type: "task-transition" as const,
      requestId: uid(),
      id: first.id,
      expectedRevision: 2,
      state: "cancelled" as const,
      detail: "",
    };
    await expect(f.service.command(stale)).rejects.toThrow("revision changed");
    await f.service.command({
      type: "task-transition",
      requestId: uid(),
      id: first.id,
      expectedRevision: 1,
      state: "ready",
      detail: "",
    });
    expect(f.repo.require<Task>("task", first.id).revision).toBe(2);
    await expect(f.service.command(stale)).rejects.toThrow("revision changed");
    expect(f.repo.require<Task>("task", first.id).state).toBe("ready");
    expect(f.service.store.get<any>("command-receipt", stale.requestId).state).toBe("failed");
  });
  test("immutable records reject rewritten content under the same identity and keep the original", async () => {
    const f = await storeFixture();
    const candidate = { id: "cand", projectId: "p", files: [{ path: "a", hash: "h1" }] };
    f.store.immutable("candidate", candidate);
    f.store.immutable("candidate", structuredClone(candidate)); // identical replay is accepted
    expect(() =>
      f.store.immutable("candidate", { ...candidate, files: [{ path: "a", hash: "h2" }] }),
    ).toThrow("Immutable record collision");
    expect(f.store.get<any>("candidate", "cand").files[0].hash).toBe("h1");
    // Revision history written by the coordination repository is immutable too.
    const repo = new CoordinationRepository(f.store);
    f.store.put("project", project("p", f.directory));
    const workspace = repo.ensureWorkspace(project("p", f.directory));
    const task = repo.createTask({ projectId: "p", workspaceId: workspace.id, title: "T", role: "implementer" });
    const revision = f.store.get<any>("task-revision", `${task.id}:1`);
    expect(() =>
      f.store.immutable("task-revision", { ...revision, title: "rewritten history" }),
    ).toThrow("Immutable record collision");
    expect(f.store.get<any>("task-revision", `${task.id}:1`).title).toBe("T");
    // A duplicated message identity stays one message and one search row.
    const message = {
      id: "dup",
      projectId: "p",
      conversationId: "c",
      role: "user" as const,
      provider: "codex" as const,
      text: "DATA12 duplicate delivery",
      runId: null,
      nativeId: "dup",
      createdAt: now(),
    };
    f.store.message(message);
    f.store.message(message);
    expect(f.store.searchPage("p", "duplicate").items).toHaveLength(1);
    expect(f.store.db.prepare("SELECT count(*) n FROM message_search").get().n).toBe(1);
  });
});

describe("TASK-01 task graphs and transitions through the service", () => {
  test("wrong-project workspace or workflow, missing dependencies and invalid transitions commit nothing", async () => {
    const f = await serviceFixture();
    const workflow: Workflow = await f.service.command({
      type: "workflow-create",
      requestId: uid(),
      projectId: "A",
      objective: "TASK01",
      template: "custom",
      templateVersion: "1",
    });
    const t1: Task = await f.service.command({
      type: "task-create",
      requestId: uid(),
      projectId: "A",
      workspaceId: f.workspaceA.id,
      workflowId: workflow.id,
      conversationId: null,
      title: "independent",
      role: "implementer",
      acceptanceCriteria: [],
    });
    expect(f.repo.require<Workflow>("workflow", workflow.id)).toMatchObject({
      taskIds: [t1.id],
      revision: 2,
    });
    const mark = f.service.store.controlHead();
    const taskCount = () => f.repo.all<Task>("task").length;
    const before = taskCount();
    await expect(
      f.service.command({
        type: "task-create",
        requestId: uid(),
        projectId: "A",
        workspaceId: f.workspaceB.id,
        workflowId: workflow.id,
        conversationId: null,
        title: "wrong workspace",
        role: "implementer",
        acceptanceCriteria: [],
      }),
    ).rejects.toThrow("another project");
    await expect(
      f.service.command({
        type: "task-create",
        requestId: uid(),
        projectId: "B",
        workspaceId: f.workspaceB.id,
        workflowId: workflow.id,
        conversationId: null,
        title: "wrong workflow",
        role: "implementer",
        acceptanceCriteria: [],
      }),
    ).rejects.toThrow("Workflow belongs to another project");
    await expect(
      f.service.command({
        type: "task-create",
        requestId: uid(),
        projectId: "A",
        workspaceId: f.workspaceA.id,
        workflowId: "missing-workflow",
        conversationId: null,
        title: "missing workflow",
        role: "implementer",
        acceptanceCriteria: [],
      }),
    ).rejects.toThrow("does not exist");
    // The public command cannot carry dependencies; the repository that the
    // workflow engines use is checked directly for graph validation.
    expect(() =>
      f.repo.createTask({
        projectId: "A",
        workspaceId: f.workspaceA.id,
        workflowId: workflow.id,
        title: "missing dependency",
        role: "implementer",
        dependencies: ["no-such-task"],
      }),
    ).toThrow("does not exist");
    expect(taskCount()).toBe(before);
    expect(f.repo.require<Workflow>("workflow", workflow.id).revision).toBe(2);
    expect(coordinationChanges(f.service.store, mark)).toEqual([]);
    // A dependent task cannot become ready before its dependency is accepted.
    const t2 = f.repo.createTask({
      projectId: "A",
      workspaceId: f.workspaceA.id,
      workflowId: workflow.id,
      title: "dependent",
      role: "implementer",
      dependencies: [t1.id],
    });
    const t2Mark = f.service.store.controlHead();
    await expect(
      f.service.command({
        type: "task-transition",
        requestId: uid(),
        id: t2.id,
        expectedRevision: 1,
        state: "ready",
        detail: "",
      }),
    ).rejects.toThrow("dependencies require acceptance");
    expect(f.repo.require<Task>("task", t2.id)).toMatchObject({ state: "draft", revision: 1 });
    // Terminal states accept no further lifecycle change; stale revisions fail.
    await f.service.command({
      type: "task-transition",
      requestId: uid(),
      id: t2.id,
      expectedRevision: 1,
      state: "cancelled",
      detail: "",
    });
    // Since the D-19 owner decision a finished task gives its own reason
    // rather than the generic "Invalid task transition".
    for (const [state, revision, message] of [
      ["ready", 2, "A finished task cannot change"],
      ["blocked", 2, "A finished task cannot change"],
      ["ready", 1, "revision changed"],
    ] as const)
      await expect(
        f.service.command({
          type: "task-transition",
          requestId: uid(),
          id: t2.id,
          expectedRevision: revision,
          state,
          detail: "",
        }),
      ).rejects.toThrow(message);
    expect(f.repo.require<Task>("task", t2.id)).toMatchObject({ state: "cancelled", revision: 2 });
    expect(
      coordinationChanges(f.service.store, t2Mark).filter((c: any) => c.kind === "task").length,
    ).toBe(1);
    // The renderer schema cannot ask for an engine-only state.
    for (const state of ["active", "accepted", "submitted"])
      expect(
        commandSchema.safeParse({ type: "task-transition", requestId: "r", id: t1.id, expectedRevision: 1, state }).success,
      ).toBe(false);
  });
});

describe("TASK-01 terminal tasks", () => {
  // Owner decision, 20 October 2026: finished tasks must not change.
  test("a cancelled task rejects or ignores a repeated cancel without rewriting the terminal record", async () => {
    const f = await serviceFixture();
    const task: Task = await f.service.command({
      type: "task-create",
      requestId: uid(),
      projectId: "A",
      workspaceId: f.workspaceA.id,
      workflowId: null,
      conversationId: null,
      title: "terminal",
      role: "implementer",
      acceptanceCriteria: [],
    });
    await f.service.command({
      type: "task-transition",
      requestId: uid(),
      id: task.id,
      expectedRevision: 1,
      state: "cancelled",
      detail: "cancelled by owner",
    });
    const terminal = structuredClone(f.repo.require<Task>("task", task.id));
    for (const state of ["cancelled", "ready", "blocked"] as const)
      await expect(
        f.service.command({
          type: "task-transition",
          requestId: uid(),
          id: task.id,
          expectedRevision: 2,
          state,
          detail: "rewritten after the task ended",
        }),
      ).rejects.toThrow("This task is cancelled. A finished task cannot change");
    expect(f.repo.require<Task>("task", task.id)).toEqual(terminal);
    expect(f.service.store.get("task-revision", `${task.id}:3`)).toBeUndefined();
  });
});

describe("TASK-01 finished-task rule", () => {
  test("accepted and cancelled tasks refuse every transition; a same-state transition of an unfinished task is still allowed", () => {
    for (const from of ["accepted", "cancelled"])
      for (const to of ["accepted", "cancelled", "ready", "active"])
        expect(() => assertTransition("task", from, to)).toThrow(
          `This task is ${from}. A finished task cannot change`,
        );
    // Parallel acceptance re-records a task that is already verifying.
    expect(() => assertTransition("task", "verifying", "verifying")).not.toThrow();
    expect(() => assertTransition("task", "ready", "ready")).not.toThrow();
    // Workflows and attempts keep their existing same-state rule.
    expect(() => assertTransition("workflow", "cancelled", "cancelled")).not.toThrow();
    expect(() => assertTransition("attempt", "completed", "completed")).not.toThrow();
  });
});

describe("TASK-08 committed versus rolled-back events through the service", () => {
  test("only committed metadata advances the scoped watermark; a cursor beyond the head forces resync", async () => {
    const f = await serviceFixture();
    const start = f.service.store.controlHead();
    const canary = "TASK08_TITLE_CANARY";
    await expect(
      f.service.command({
        type: "task-create",
        requestId: uid(),
        projectId: "A",
        workspaceId: f.workspaceB.id,
        workflowId: null,
        conversationId: null,
        title: canary,
        role: "implementer",
        acceptanceCriteria: [],
      }),
    ).rejects.toThrow(/^Task workspace belongs to another project\.$/);
    const afterRollback = await f.service.command({
      type: "scope-events",
      projectId: "A",
      afterSequence: start,
      limit: 200,
    });
    expect(afterRollback.events.filter((e: any) => e.kind === "task")).toEqual([]);
    const task: Task = await f.service.command({
      type: "task-create",
      requestId: uid(),
      projectId: "A",
      workspaceId: f.workspaceA.id,
      workflowId: null,
      conversationId: null,
      title: canary,
      role: "implementer",
      acceptanceCriteria: [],
    });
    const committed = await f.service.command({
      type: "scope-events",
      projectId: "A",
      afterSequence: start,
      limit: 200,
    });
    expect(committed.events.some((e: any) => e.kind === "task" && e.id === task.id)).toBe(true);
    expect(JSON.stringify(committed)).not.toContain(canary);
    expect(committed.throughSequence).toBe(f.service.store.controlHead());
    const other = await f.service.command({
      type: "scope-events",
      projectId: "B",
      afterSequence: start,
      limit: 200,
    });
    expect(other.events.some((e: any) => e.id === task.id)).toBe(false);
    await expect(
      f.service.command({
        type: "scope-events",
        projectId: "A",
        afterSequence: f.service.store.controlHead() + 1,
        limit: 200,
      }),
    ).rejects.toThrow(/^Event cursor belongs to a newer or restored vault; resync required\.$/);
  });

  test("a command that writes inside its transaction and then fails leaves no partial write in the durable store", async () => {
    const f = await serviceFixture();
    const store = f.service.store;
    const file = path.join(f.directory, "history.sqlite");
    const canary = "TASK08_ROLLBACK_CANARY";
    const workflow: Workflow = await f.service.command({
      type: "workflow-create",
      requestId: uid(),
      projectId: "A",
      objective: "rollback fixture",
      template: "manual",
      templateVersion: "v1",
    });
    expect(workflow).toMatchObject({ revision: 1, taskIds: [] });
    const create = () =>
      f.service.command({
        type: "task-create",
        requestId: uid(),
        projectId: "A",
        workspaceId: f.workspaceA.id,
        workflowId: workflow.id,
        conversationId: null,
        title: canary,
        role: "implementer",
        acceptanceCriteria: [],
      });
    /** Rows a second, independent connection sees in the encrypted file (committed state only). */
    const durable = (after: number) => {
      const db = rawOpen(file, f.key);
      try {
        return {
          tasks: db
            .prepare("SELECT id,body FROM documents WHERE kind='task' AND json_extract(body,'$.title')=?")
            .all(canary) as Array<{ id: string; body: string }>,
          taskRevisions: db
            .prepare("SELECT id FROM documents WHERE kind='task-revision' AND json_extract(body,'$.title')=?")
            .all(canary),
          workflow: JSON.parse(
            (db.prepare("SELECT body FROM documents WHERE kind='workflow' AND id=?").get(workflow.id) as any).body,
          ),
          workflowRevisions: db
            .prepare("SELECT id FROM documents WHERE kind='workflow-revision' AND json_extract(body,'$.entityId')=? ORDER BY id")
            .all(workflow.id)
            .map((row: any) => row.id),
          workflowEvents: db
            .prepare("SELECT kind FROM events WHERE kind='workflow.changed' AND instr(body,?)>0")
            .all(workflow.id)
            .map((row: any) => row.kind),
          canaryEvents: db.prepare("SELECT kind FROM events WHERE instr(body,?)>0").all(canary),
          changes: db
            .prepare("SELECT kind FROM control_changes WHERE sequence>? ORDER BY sequence")
            .all(after)
            .map((row: any) => row.kind),
        };
      } finally {
        db.close();
      }
    };
    const mark = store.controlHead();
    const before = durable(mark);
    expect(before.workflowRevisions).toEqual([`${workflow.id}:1`]);
    // Fault injection after the command has already written the workflow update,
    // the task row, its task.changed event and their control_changes rows inside
    // createTask's single transaction: the final write (the task revision) throws.
    const immutable = store.immutable.bind(store);
    const fault = vi.spyOn(store, "immutable").mockImplementation((kind: string, value: any) => {
      if (kind === "task-revision") {
        // The partial writes exist inside the open transaction at this moment.
        expect(store.get<Workflow>("workflow", workflow.id)?.revision).toBe(2);
        expect(store.get<Task>("task", value.entityId)?.title).toBe(canary);
        throw new Error("CAMPAIGN TASK-08 injected failure after the task write");
      }
      return immutable(kind, value);
    });
    try {
      await expect(create()).rejects.toThrow(/^CAMPAIGN TASK-08 injected failure after the task write$/);
      expect(fault.mock.calls.some(([kind]) => kind === "task-revision")).toBe(true);
    } finally {
      fault.mockRestore();
    }
    const rolledBack = durable(mark);
    expect(rolledBack.tasks).toEqual([]);
    expect(rolledBack.taskRevisions).toEqual([]);
    expect(rolledBack.workflow).toEqual(before.workflow);
    expect(rolledBack.workflow).toMatchObject({ revision: 1, taskIds: [] });
    expect(rolledBack.workflowRevisions).toEqual([`${workflow.id}:1`]);
    expect(before.workflowEvents).toEqual(["workflow.changed"]);
    expect(rolledBack.workflowEvents).toEqual(before.workflowEvents);
    expect(rolledBack.canaryEvents).toEqual([]);
    // Only the command receipt (prepared, then failed), written outside the
    // transaction, reached the change log.
    expect(rolledBack.changes).toEqual(["command-receipt", "command-receipt"]);
    const page = await f.service.command({ type: "scope-events", projectId: "A", afterSequence: mark, limit: 200 });
    expect(page.events.filter((e: any) => e.kind !== "command-receipt")).toEqual([]);
    expect(page.throughSequence).toBe(store.controlHead());
    // Control: the same command without the fault persists every write.
    const markOk = store.controlHead();
    const task: Task = await create();
    const persisted = durable(markOk);
    expect(persisted.tasks.map((row) => row.id)).toEqual([task.id]);
    expect(persisted.taskRevisions).toEqual([{ id: `${task.id}:1` }]);
    expect(persisted.workflow).toMatchObject({ revision: 2, taskIds: [task.id] });
    expect(persisted.workflowRevisions).toEqual([`${workflow.id}:1`, `${workflow.id}:2`]);
    expect(persisted.workflowEvents).toEqual(["workflow.changed", "workflow.changed"]);
    expect(persisted.canaryEvents.map((row: any) => row.kind)).toEqual(["task.changed"]);
    expect(persisted.changes.filter((kind: string) => kind !== "command-receipt").sort()).toEqual([
      "task",
      "task-revision",
      "workflow",
      "workflow-revision",
    ]);
    const committed = await f.service.command({ type: "scope-events", projectId: "A", afterSequence: markOk, limit: 200 });
    expect(committed.events.some((e: any) => e.kind === "task" && e.id === task.id)).toBe(true);
    expect(JSON.stringify(committed)).not.toContain(canary);
  });
});

describe("TASK-13 task-context-bind lifecycle and reference matrix", () => {
  async function bindFixture() {
    const f = await serviceFixture();
    const publish = (recordId: string, content: string, expectedHeadId: string | null, projectId = "A") =>
      f.service.command({
        type: "shared-revision-publish",
        requestId: uid(),
        projectId,
        recordId,
        kind: "specification",
        title: recordId,
        content,
        impact: "dispatch-blocking",
        expectedHeadId,
      });
    const specV1 = await publish("spec", "v1", null);
    const specV2 = await publish("spec", "v2", specV1.id);
    const decision = await publish("decision", "d1", null);
    const foreign = await publish("spec", "foreign", null, "B");
    const pkg = (id: string, refs: string[], projectId = "A", text = `Package ${id}`) => {
      f.service.store.immutable("context-package", {
        id,
        projectId,
        conversationId: null,
        text,
        hash: hash(`Package ${id}`),
        sourceRefs: refs,
        specificationRevision: refs[0] ?? null,
        omissions: [],
        visibility: "project",
        completeness: "recorded",
        createdAt: now(),
      });
      return id;
    };
    pkg("current", [specV2.id, decision.id]);
    pkg("both-spec", [specV1.id, specV2.id]);
    pkg("foreign-package", [foreign.id], "B");
    pkg("tampered", [specV2.id], "A", "Package tampered, then edited");
    const task = (state: Task["state"]) => {
      let t = f.repo.createTask({ projectId: "A", workspaceId: f.workspaceA.id, title: state, role: "implementer" });
      const path: Record<string, Task["state"][]> = {
        draft: [],
        ready: ["ready"],
        blocked: ["blocked"],
        active: ["ready", "active"],
        submitted: ["ready", "active", "submitted"],
        reviewing: ["ready", "active", "submitted", "reviewing"],
        verifying: ["ready", "active", "submitted", "reviewing", "verifying"],
        "changes-requested": ["ready", "active", "changes-requested"],
        cancelled: ["cancelled"],
      };
      if (state === "accepted") {
        // Acceptance needs a full candidate lineage; the bind guard only reads
        // the stored state, so the record is placed there directly.
        t = { ...t, state: "accepted", revision: t.revision + 1 };
        f.service.store.put("task", t);
        return t;
      }
      for (const next of path[state]) t = f.repo.transitionTask(t.id, t.revision, next);
      return t;
    };
    const bind = (t: Task, overrides: Record<string, unknown> = {}) =>
      f.service.command({
        type: "task-context-bind",
        requestId: uid(),
        projectId: "A",
        id: t.id,
        expectedRevision: t.revision,
        contextPackageId: "current",
        ...overrides,
      } as any);
    const head = (t: Task) => f.service.store.get<{ bindingId: string }>("task-input-head", t.id);
    return { ...f, specV1, specV2, decision, foreign, task, bind, head };
  }
  const states: Task["state"][] = [
    "draft",
    "ready",
    "blocked",
    "active",
    "submitted",
    "reviewing",
    "verifying",
    "changes-requested",
    "accepted",
    "cancelled",
  ];
  test("only draft, ready or blocked tasks at the current revision can bind; rejection changes no head", async () => {
    const f = await bindFixture();
    for (const state of states) {
      const t = f.task(state);
      expect(t.state).toBe(state);
      if (["draft", "ready", "blocked"].includes(state)) {
        const binding = await f.bind(t);
        expect(f.head(t)?.bindingId).toBe(binding.id);
        const stored = f.service.store.get<any>("task-input-binding", binding.id);
        expect(stored).toMatchObject({
          taskId: t.id,
          projectId: "A",
          contextPackageId: "current",
          contextPackageHash: hash("Package current"),
          attemptId: null,
        });
        expect(stored.references).toEqual([
          { recordId: "spec", revisionId: f.specV2.id },
          { recordId: "decision", revisionId: f.decision.id },
        ]);
        // Binding is evidence of the record, not of provider delivery.
        expect(f.service.store.list("context-delivery")).toEqual([]);
        const inspected = await f.service.command({ type: "task-inputs-inspect", projectId: "A", id: t.id });
        expect(inspected).toMatchObject({ current: true, binding: { id: binding.id } });
      } else {
        await expect(f.bind(t), state).rejects.toThrow("Only an inactive task");
        expect(f.head(t), state).toBeUndefined();
      }
    }
  });
  test("stale revision, foreign project, foreign package, tampered package and bad references are rejected without a head change", async () => {
    const f = await bindFixture();
    const t = f.task("ready");
    const good = await f.bind(t);
    const unchanged = () => expect(f.head(t)?.bindingId).toBe(good.id);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["stale revision", { expectedRevision: t.revision + 1 }, "Only an inactive task"],
      ["older revision", { expectedRevision: t.revision - 1 }, "Only an inactive task"],
      ["foreign project", { projectId: "B" }, "another project"],
      ["foreign package", { contextPackageId: "foreign-package" }, "another project"],
      ["missing package", { contextPackageId: "absent" }, "missing"],
      ["tampered package", { contextPackageId: "tampered" }, "changed"],
      [
        "foreign shared record",
        { references: [{ recordId: "spec", revisionId: f.foreign.id }] },
        "included in the immutable context package",
      ],
      [
        "missing revision",
        { references: [{ recordId: "spec", revisionId: "no-such-revision" }] },
        "included in the immutable context package",
      ],
      [
        "revision not in package",
        { references: [{ recordId: "spec", revisionId: f.specV1.id }] },
        "included in the immutable context package",
      ],
      [
        "record id mismatch",
        { references: [{ recordId: "decision", revisionId: f.specV2.id }] },
        "included in the immutable context package",
      ],
      [
        "one record supplies two revisions",
        {
          contextPackageId: "both-spec",
          references: [
            { recordId: "spec", revisionId: f.specV1.id },
            { recordId: "spec", revisionId: f.specV2.id },
          ],
        },
        "two revisions of one shared record",
      ],
      ["derived duplicate from package", { contextPackageId: "both-spec" }, "two revisions of one shared record"],
    ];
    const bindings = () => f.service.store.list("task-input-binding").length;
    const count = bindings();
    for (const [label, overrides, message] of cases) {
      await expect(f.bind(t, overrides), label).rejects.toThrow(message);
      unchanged();
    }
    expect(bindings()).toBe(count);
    // Control: a valid explicit subset binds and moves the head.
    const subset = await f.bind(t, { references: [{ recordId: "decision", revisionId: f.decision.id }] });
    expect(f.head(t)?.bindingId).toBe(subset.id);
    expect(f.service.store.get<any>("task-input-binding", good.id).references).toHaveLength(2);
  });
});

describe("BOUND-01 command schema and authority injection", () => {
  test("unknown or malformed commands, invalid IDs and strict nested extras are rejected; injected authority is stripped", () => {
    for (const raw of [
      { type: "exec", command: "/bin/sh" },
      { command: "state" },
      { type: 7 },
      null,
      "state",
    ])
      expect(commandSchema.safeParse(raw).success).toBe(false);
    for (const id of ["", "x".repeat(257), 42, null])
      expect(commandSchema.safeParse({ type: "task-inspect", projectId: "A", id }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "task-inspect", projectId: "A", id: "x".repeat(256) }).success).toBe(true);
    expect(
      commandSchema.parse({
        type: "context-enable",
        projectId: "A",
        approved: true,
        trusted: { approved: true },
        digest: "forged",
      }),
    ).toEqual({ type: "context-enable", projectId: "A" });
    const goal = { text: "ship it" };
    const loop = { type: "loop-create", projectId: "A", mode: "goal", commandId: "command-0001", goals: [goal] };
    expect(commandSchema.safeParse(loop).success).toBe(true);
    expect(commandSchema.safeParse({ ...loop, goals: [{ ...goal, approved: true }] }).success).toBe(false);
  });
  test("authority fields inside a command body never substitute for the broker's trusted input", async () => {
    const f = await serviceFixture();
    await expect(
      f.service.command({ type: "context-enable", projectId: "A", approved: true, trusted: { approved: true } } as any),
    ).rejects.toThrow("native confirmation");
    expect((await readdir(f.directory)).includes("context-grants")).toBe(false);
    await expect(f.service.command({ type: "unlock", passphrase: "x".repeat(12) })).rejects.toThrow(
      "desktop broker",
    );
    await expect(
      f.service.command({ type: "approval-decide", id: "anything", allow: true, digest: "forged" } as any),
    ).rejects.toThrow("native approval decision is required");
  });
});

describe("BOUND-03 cross-project references through the service", () => {
  test("project A commands cannot reach project B's task, message, conversation, candidate bytes or approvals", async () => {
    const f = await serviceFixture();
    const secret = "BOUND03_PROJECT_B_SECRET";
    const store = f.service.store;
    const taskB = f.repo.createTask({ projectId: "B", workspaceId: f.workspaceB.id, title: secret, role: "implementer" });
    const taskA = f.repo.createTask({ projectId: "A", workspaceId: f.workspaceA.id, title: "visible", role: "implementer" });
    store.message({
      id: "mB",
      projectId: "B",
      conversationId: "cB",
      role: "assistant",
      provider: "codex",
      text: secret,
      runId: "rB",
      nativeId: null,
      createdAt: now(),
    });
    store.put("conversation", { id: "cB", projectId: "B", title: secret, nativeSessions: {}, createdAt: now() });
    store.put("run", { id: "rB", projectId: "B", conversationId: "cB", status: "awaiting-approval" });
    store.put("approval", { id: "apB", runId: "rB", summary: secret, digest: "d" });
    const bytes = Buffer.from(`${secret} bytes`);
    const blobHash = hash(bytes.toString("utf8"));
    const blobs = new ProtectedBlobs(store);
    blobs.stage("candB:one", 0, bytes);
    store.transaction(() => {
      blobs.publish("candB:one", blobHash, bytes.length);
      blobs.reference("B", "candB", { path: "secret.bin", hash: blobHash });
    });
    store.immutable("candidate", {
      id: "candB",
      projectId: "B",
      workflowId: "wB",
      revision: "r",
      files: [{ path: "secret.bin", hash: blobHash, bytes: bytes.length, type: "binary" }],
    });
    // Real captured candidates in project B's workflow (format 2, protected
    // blobs), so the same diff and preview commands can succeed for B.
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`${secret} v1`)]);
    await writeFile(path.join(f.B.path, "image.png"), png);
    const capture = (baseCandidateId?: string) =>
      captureCandidate(store, {
        root: f.B.path,
        projectId: "B",
        workflowId: "wB",
        selectedPaths: ["image.png"],
        gitExecutable: "missing-git-fixture",
        ...(baseCandidateId ? { baseCandidateId } : {}),
      });
    const baseB = await capture();
    const pngV2 = Buffer.concat([png.subarray(0, 8), Buffer.from(`${secret} v2`)]);
    await writeFile(path.join(f.B.path, "image.png"), pngV2);
    const nextB = await capture(baseB.id);
    store.immutable("context-package", {
      id: "pkgB",
      projectId: "B",
      conversationId: null,
      text: "Package B",
      hash: hash("Package B"),
      sourceRefs: [],
      specificationRevision: null,
      omissions: [],
      visibility: "project",
      completeness: "recorded",
      createdAt: now(),
    });
    const beforeB = structuredClone(store.get<Task>("task", taskB.id));
    const bindingsBefore = store.list("task-input-binding").length;
    // The same six operations, parameterised by the requesting project.
    const operations = (projectId: string) =>
      [
        [{ type: "task-inspect", projectId, id: taskB.id }, /^Task belongs to another project\.$/],
        [{ type: "task-inputs-inspect", projectId, id: taskB.id }, /^Task belongs to another project\.$/],
        [
          {
            type: "task-context-bind",
            requestId: uid(),
            projectId,
            id: taskB.id,
            expectedRevision: taskB.revision,
            contextPackageId: "pkgB",
          },
          /^Task belongs to another project\.$/,
        ],
        [{ type: "history-message", projectId, id: "mB", offset: 0, limit: 100 }, /^Message belongs to another project\.$/],
        [
          {
            type: "candidate-diff-query",
            projectId,
            workflowId: "wB",
            candidateId: nextB.id,
            baseCandidateId: baseB.id,
            offset: 0,
            limit: 20,
          },
          /^Candidate diff belongs to another project or workflow\.$/,
        ],
        [
          { type: "candidate-binary-preview", projectId, candidateId: nextB.id, path: "image.png" },
          /^Candidate belongs to another project or is unavailable\.$/,
        ],
      ] as const;
    for (const [command, reason] of operations("A"))
      await expect(f.service.command(command as any), command.type).rejects.toThrow(reason);
    // Scoped reads filter instead of leaking.
    const page = await f.service.command({ type: "history-page", projectId: "A", conversationId: "cB", limit: 80 });
    const snapshot = await f.service.command({ type: "scope-snapshot", projectId: "A" });
    const tasks = await f.service.command({ type: "coordination-page", projectId: "A", kind: "task", limit: 100 });
    const search = await f.service.command({ type: "history-page", projectId: "A", query: secret, limit: 80 });
    for (const result of [page, snapshot, tasks, search])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(page.items).toEqual([]);
    expect(tasks.items.map((t: Task) => t.id)).toEqual([taskA.id]);
    expect(snapshot.approvals).toEqual([]);
    // The protected blob boundary is project-scoped; a hash is not a grant.
    expect(() =>
      blobs.read("A", "candB", { path: "secret.bin", hash: blobHash, bytes: bytes.length }),
    ).toThrow("No protected blob reference");
    // Project A's attempts changed nothing in project B.
    expect(store.get("task", taskB.id)).toEqual(beforeB);
    expect(store.get("task-input-head", taskB.id)).toBeUndefined();
    expect(store.list("task-input-binding")).toHaveLength(bindingsBefore);
    expect(store.get("approval", "apB")).toBeTruthy();
    // Positive controls: the identical operations succeed for project B, the
    // owner of every referenced record, so A's rejections are scope refusals.
    const results: any[] = [];
    for (const [command] of operations("B")) results.push(await f.service.command(command as any));
    const [inspected, inputs, binding, message, diff, preview] = results;
    expect(inspected.task).toMatchObject({ id: taskB.id, projectId: "B", title: secret });
    expect(inputs).toMatchObject({ observation: { projectId: "B" } });
    expect(binding).toMatchObject({ taskId: taskB.id, projectId: "B", contextPackageId: "pkgB" });
    expect(store.get<any>("task-input-head", taskB.id)?.bindingId).toBe(binding.id);
    expect(message).toMatchObject({ id: "mB", text: secret });
    expect(diff.files.map((file: any) => [file.path, file.kind, file.binary])).toEqual([["image.png", "modified", true]]);
    expect(preview).toMatchObject({ candidateId: nextB.id, path: "image.png", mime: "image/png" });
    expect(Buffer.from(preview.base64, "base64").equals(pngV2)).toBe(true);
    expect(blobs.read("B", "candB", { path: "secret.bin", hash: blobHash, bytes: bytes.length })?.equals(bytes)).toBe(true);
  });
});

describe("BOUND-05 service shutdown", () => {
  test("close revokes grants, stops new commands, closes storage, and deferred notifications do not touch it", async () => {
    const f = await serviceFixture();
    await f.service.start();
    const enabled = await f.service.command({ type: "context-enable", projectId: "A" }, { approved: true });
    const grant = JSON.parse(await readFile(enabled.file, "utf8"));
    expect((f.service.context.request(grant.grant, grant.token, { method: "status" }) as any).projectId).toBe("A");
    // Queue a deferred notification, then close before it fires.
    await f.service.command({ type: "theme", theme: "night" });
    await f.service.close();
    const eventsAtClose = f.events.length;
    // The local better-sqlite3 type shim omits `open`; the runtime property exists.
    expect((f.service.store.db as unknown as { open: boolean }).open).toBe(false);
    expect(() => f.service.context.request(grant.grant, grant.token, { method: "status" })).toThrow(
      "Invalid project context grant",
    );
    await expect(f.service.command({ type: "state" })).rejects.toThrow("shutting down");
    (f.service as any).changed(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(f.events.length).toBe(eventsAtClose);
    // A second service on the same profile does not revive the former grant.
    const next = new Service(f.directory, f.key, () => {}, true);
    cleanups.push(() => next.close().catch(() => {}));
    await next.start();
    expect(() => next.context.request(grant.grant, grant.token, { method: "status" })).toThrow(
      "Invalid project context grant",
    );
    expect(next.store.get<any>("preference", "theme")?.value).toBe("night");
  });
});
