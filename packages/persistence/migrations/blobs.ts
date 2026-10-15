import type Database from "better-sqlite3-multiple-ciphers";
import { migrateWithBackup } from "./backup";

export const BLOB_SCHEMA_VERSION = 6;
export function migrateBlobs(db: Database, file: string, key: string): void {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= BLOB_SCHEMA_VERSION) return;
  if (version !== 5)
    throw new Error("Protected blob migration requires schema 5.");
  migrateWithBackup(db, file, key, 5, 6, (backup) => {
    db.exec(`
      CREATE TABLE protected_blobs(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE protected_blob_chunks(hash TEXT NOT NULL,ordinal INTEGER NOT NULL,bytes BLOB NOT NULL,chunk_hash TEXT NOT NULL,PRIMARY KEY(hash,ordinal));
      CREATE TABLE protected_blob_refs(project_id TEXT NOT NULL,candidate_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(project_id,candidate_id,path));
      CREATE INDEX protected_blob_ref_hash ON protected_blob_refs(hash);
      CREATE TABLE protected_blob_staging(capture_id TEXT NOT NULL,ordinal INTEGER NOT NULL,bytes BLOB NOT NULL,chunk_hash TEXT NOT NULL,PRIMARY KEY(capture_id,ordinal));
    `);
    db.prepare(
      "INSERT INTO documents(kind,id,body) VALUES('migration','protected-blobs-v6',?)",
    ).run(
      JSON.stringify({
        id: "protected-blobs-v6",
        from: 5,
        to: 6,
        backup,
        integrity: "ok",
        historicalCandidates:
          "Legacy bytes and hashes retain their original interpretation. No backfill is required for reads.",
      }),
    );
  });
}
