import type Database from "better-sqlite3-multiple-ciphers";
import { migrateWithBackup } from "./backup";

/**
 * Schema 7: the native harness's durable execution records
 * (docs/Native_Harness_Plan.md §3, "Durable execution").
 *
 * - `native_journal`: an attempt-scoped, append-only, hash-chained event log
 *   (frozen requests, settled responses, tool intentions and results,
 *   steering, usage, checkpoints, reconciliation).
 * - `native_projections`: each attempt's read model and the journal sequence
 *   it reflects, advanced in the same transaction as the events.
 * - `protected_blob_owners`: blob ownership by request manifests, tool output,
 *   compaction capsules and evidence, so authorization and garbage collection
 *   no longer depend on candidate-file references alone.
 *
 * Earlier writers are fenced by the existing newer-schema refusal; history
 * keeps its original interpretation.
 */
export const NATIVE_SCHEMA_VERSION = 7;
/** The newest schema this build writes. */
export const CURRENT_SCHEMA_VERSION = NATIVE_SCHEMA_VERSION;

export function migrateNative(db: Database, file: string, key: string): void {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= NATIVE_SCHEMA_VERSION) return;
  if (version !== 6)
    throw new Error("Native harness migration requires schema 6.");
  migrateWithBackup(db, file, key, 6, 7, (backup) => {
    db.exec(`
      CREATE TABLE native_journal(
        attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(attempt_id,sequence)
      ) WITHOUT ROWID;
      CREATE INDEX native_journal_kind ON native_journal(attempt_id,kind,sequence);
      CREATE TABLE native_projections(
        attempt_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        root_attempt_id TEXT NOT NULL,
        through_sequence INTEGER NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX native_projection_project ON native_projections(project_id,updated_at);
      CREATE INDEX native_projection_root ON native_projections(root_attempt_id);
      CREATE INDEX native_projection_state ON native_projections(state);
      CREATE TABLE protected_blob_owners(
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        hash TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        PRIMARY KEY(owner_kind,owner_id,name)
      );
      CREATE INDEX protected_blob_owner_hash ON protected_blob_owners(hash);
    `);
    db.prepare(
      "INSERT INTO documents(kind,id,body) VALUES('migration','native-harness-v7',?)",
    ).run(
      JSON.stringify({
        id: "native-harness-v7",
        from: 6,
        to: 7,
        backup,
        integrity: "ok",
        historicalRecords:
          "Existing runs, attempts and candidates keep their original interpretation. No engine, account, funding or capability evidence is inferred for them.",
      }),
    );
  });
}
