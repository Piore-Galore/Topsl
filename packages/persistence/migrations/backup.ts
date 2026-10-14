import { chmodSync, copyFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { uid } from "../../domain/invariants";

/** Supported checkpoint procedure: leave WAL, hold an exclusive rollback-journal
 * lock, then copy the complete encrypted main database before any schema write. */
export function migrateWithBackup(
  db: Database,
  file: string,
  key: string,
  expectedVersion: number,
  targetVersion: number,
  migrate: (backup: string | null) => void,
): string | null {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    !Number.isInteger(targetVersion) ||
    targetVersion <= expectedVersion
  )
    throw new Error("Invalid migration parameters.");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version !== expectedVersion)
    throw new Error("Database schema changed before migration.");
  db.pragma("wal_checkpoint(TRUNCATE)");
  const mode = db.prepare("PRAGMA journal_mode=DELETE").get().journal_mode;
  if (mode !== "delete")
    throw new Error("Close other database clients before migration.");
  const backup =
    expectedVersion === 0
      ? null
      : `${file}.schema-${expectedVersion}.backup-${uid()}`;
  db.exec("BEGIN EXCLUSIVE");
  try {
    if (backup) {
      if (existsSync(backup))
        throw new Error("Migration backup already exists.");
      copyFileSync(file, backup);
      chmodSync(backup, 0o600);
      const check = new Database(backup);
      try {
        check.pragma("cipher='sqlcipher'");
        check.pragma("legacy=4");
        check.pragma(`key='${key}'`);
        if (
          check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
        )
          throw new Error("Encrypted migration backup failed integrity check.");
        if (
          check.prepare("PRAGMA user_version").get().user_version !==
          expectedVersion
        )
          throw new Error("Migration backup has an unexpected schema.");
      } finally {
        check.close();
      }
    }
    migrate(backup);
    db.exec(`PRAGMA user_version=${targetVersion}; COMMIT;`);
    return backup;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.pragma("journal_mode=WAL");
  }
}

/** Restore to a new path only. Pair the result with an application that supports
 * its recorded schema; this never downgrades or overwrites the current vault. */
export function restoreMigrationBackup(
  backup: string,
  destination: string,
  key: string,
  maximumSchemaVersion: number,
): void {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !Number.isInteger(maximumSchemaVersion) ||
    maximumSchemaVersion < 0 ||
    !existsSync(backup)
  )
    throw new Error("Invalid backup or restore parameters.");
  if (existsSync(destination))
    throw new Error("Restore destination must be a new file.");
  const check = new Database(backup);
  try {
    check.pragma("cipher='sqlcipher'");
    check.pragma("legacy=4");
    check.pragma(`key='${key}'`);
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Migration backup failed integrity check.");
    if (
      check.prepare("PRAGMA user_version").get().user_version >
      maximumSchemaVersion
    )
      throw new Error("Backup requires a newer compatible application.");
    copyFileSync(backup, destination);
    chmodSync(destination, 0o600);
  } finally {
    check.close();
  }
}
