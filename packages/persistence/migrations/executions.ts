import type Database from "better-sqlite3-multiple-ciphers";
import { migrateWithBackup } from "./backup";

export const EXECUTION_SCHEMA_VERSION = 5;
export function migrateExecutions(
  db: Database,
  file: string,
  key: string,
): void {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= EXECUTION_SCHEMA_VERSION) return;
  if (version !== 4)
    throw new Error("Durable execution migration requires schema 4.");
  migrateWithBackup(db, file, key, 4, 5, (backup) => {
    // Records remain in the encrypted document store. This migration fences old
    // writers and adds bounded recovery/query indexes without reinterpreting history.
    db.exec(
      "CREATE INDEX IF NOT EXISTS protected_execution_state ON documents(kind,json_extract(body,'$.state'),json_extract(body,'$.workflowId'));",
    );
    db.prepare(
      "INSERT INTO documents(kind,id,body) VALUES('migration','durable-executions-v5',?)",
    ).run(
      JSON.stringify({
        id: "durable-executions-v5",
        from: 4,
        to: 5,
        backup,
        integrity: "ok",
        historicalVerification:
          "Retained with original interpretation; no environment or lifecycle coverage inferred.",
      }),
    );
  });
}
