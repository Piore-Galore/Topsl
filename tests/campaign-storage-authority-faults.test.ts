// Campaign 2026-10-19-comprehensive, packet p2a-storage-authority.
// DATA-07: a full disk while the encrypted migration backup is being copied.
// Only node:fs copyFileSync is wrapped; the Store, migrations and SQLCipher
// database are the real ones, reopened from what is actually on disk.
import { afterEach, expect, test, vi } from "vitest";
import path from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import Database from "better-sqlite3-multiple-ciphers";

const fault = vi.hoisted(() => ({ failOnCall: 0, calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    copyFileSync: (from: string, to: string, mode?: number) => {
      fault.calls++;
      if (fault.calls === fault.failOnCall) {
        // Write a torn half copy first, as a disk that fills mid-copy would.
        const bytes = original.readFileSync(from);
        original.writeFileSync(to, bytes.subarray(0, Math.floor(bytes.length / 2)));
        throw Object.assign(new Error("ENOSPC: no space left on device, copyfile"), {
          code: "ENOSPC",
        });
      }
      return original.copyFileSync(from, to, mode);
    },
  };
});

import { Store } from "../packages/persistence/store";
import { BLOB_SCHEMA_VERSION } from "../packages/persistence/migrations/blobs";
import { fixture } from "./helpers";

const cleanup: string[] = [];
afterEach(async () => {
  fault.failOnCall = 0;
  fault.calls = 0;
  for (const directory of cleanup.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function raw(file: string, key: string) {
  const db = new Database(file);
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${key}'`);
  return db;
}
// Same downgrade the existing coordination migration test uses (schema 2).
const LEGACY_SCHEMA_2 =
  "DROP TRIGGER control_document_insert;DROP TRIGGER control_document_update;DROP TRIGGER control_document_delete;DROP TABLE control_changes;DROP TABLE coordinator_owners;DROP TABLE workspace_leases;DROP INDEX coordination_task_project;DROP INDEX coordination_session_project;DROP INDEX coordination_workflow_project;DROP INDEX coordination_attempt_state;DROP INDEX protected_execution_state;DROP TABLE protected_blob_refs;DROP TABLE protected_blob_chunks;DROP TABLE protected_blob_staging;DROP TABLE protected_blobs;DELETE FROM documents WHERE kind='migration';PRAGMA user_version=2;";
async function legacyProfile() {
  const f = await fixture();
  cleanup.push(f.directory);
  const file = path.join(f.directory, "history.sqlite");
  f.store.put("project", {
    id: "p",
    name: "DATA07_FAULT_CANARY",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: new Date().toISOString(),
  });
  f.store.message({
    id: "m",
    projectId: "p",
    conversationId: "c",
    role: "user",
    provider: "codex",
    text: "DATA07_FAULT_CANARY message",
    runId: null,
    nativeId: null,
    createdAt: new Date().toISOString(),
  });
  f.store.close();
  const legacy = raw(file, f.key);
  legacy.exec(LEGACY_SCHEMA_2);
  legacy.close();
  return { ...f, file };
}
async function noPlaintext(directory: string) {
  for (const name of await readdir(directory)) {
    if (name === "runtime") continue;
    const bytes = await readFile(path.join(directory, name));
    expect(bytes.includes(Buffer.from("DATA07_FAULT_CANARY")), name).toBe(false);
    expect(bytes.includes(Buffer.from("SQLite format 3")), name).toBe(false);
  }
}

test("a full disk while copying the first migration backup leaves schema 2 intact; reopen migrates", async () => {
  const f = await legacyProfile();
  fault.calls = 0;
  fault.failOnCall = 1;
  expect(() => new Store(f.file, f.key)).toThrow("ENOSPC");
  const after = raw(f.file, f.key);
  expect(after.prepare("PRAGMA user_version").get().user_version).toBe(2);
  expect(after.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
  expect(
    after.prepare("SELECT name FROM sqlite_master WHERE name IN ('coordinator_owners','workspace_leases')").all(),
  ).toEqual([]);
  expect(
    after.prepare("SELECT count(*) n FROM documents WHERE kind LIKE 'legacy-%' OR id LIKE 'legacy-%'").get().n,
  ).toBe(0);
  expect(JSON.parse(after.prepare("SELECT body FROM documents WHERE kind='project'").get().body).name).toBe(
    "DATA07_FAULT_CANARY",
  );
  after.close();
  // The torn backup and the database stay encrypted.
  await noPlaintext(f.directory);
  // Disk space returns: the real constructor completes every step.
  const reopened = new Store(f.file, f.key);
  expect(reopened.db.prepare("PRAGMA user_version").get().user_version).toBe(BLOB_SCHEMA_VERSION);
  expect(reopened.searchPage("p", "DATA07_FAULT_CANARY").items.map((m) => m.id)).toEqual(["m"]);
  expect(reopened.get("workspace", "legacy-workspace:p")).toBeTruthy();
  reopened.close();
});

test("a full disk at the second migration step keeps the completed first step and resumes from it", async () => {
  const f = await legacyProfile();
  fault.calls = 0;
  fault.failOnCall = 2;
  expect(() => new Store(f.file, f.key)).toThrow("ENOSPC");
  const after = raw(f.file, f.key);
  // Step 2→3 committed; step 3→4 rolled back as a unit.
  expect(after.prepare("PRAGMA user_version").get().user_version).toBe(3);
  expect(after.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
  expect(after.prepare("SELECT name FROM sqlite_master WHERE name='control_changes'").get()).toBeUndefined();
  expect(after.prepare("SELECT count(*) n FROM documents WHERE id='legacy-workspace:p'").get().n).toBe(1);
  after.close();
  await noPlaintext(f.directory);
  const reopened = new Store(f.file, f.key);
  expect(reopened.db.prepare("PRAGMA user_version").get().user_version).toBe(BLOB_SCHEMA_VERSION);
  expect(reopened.searchPage("p", "DATA07_FAULT_CANARY").items).toHaveLength(1);
  reopened.close();
});
