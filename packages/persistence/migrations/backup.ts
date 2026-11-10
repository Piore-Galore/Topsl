import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { uid } from "../../domain/invariants";

/**
 * Databases created by this process's open, before any of their migrations
 * ran: they hold nothing an upgrade could lose, so their migrations write no
 * backup. A later open of the same file backs up as usual.
 */
const created = new WeakSet<Database>();
export function markCreated(db: Database): void {
  created.add(db);
}

/**
 * The upgrade ID of each open. One upgrade can cross several schema steps;
 * every backup it writes carries this ID in its name, so a later open can
 * tell which backups belong together even when the upgrade failed partway.
 * The lowest-schema backup of an upgrade is the only copy of the vault as it
 * was before the upgrade, and the others are intermediate states nobody
 * restores.
 */
const upgrades = new WeakMap<Database, string>();
function upgradeOf(db: Database): string {
  let upgrade = upgrades.get(db);
  if (!upgrade) upgrades.set(db, (upgrade = uid()));
  return upgrade;
}

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
    expectedVersion === 0 || created.has(db)
      ? null
      : `${file}.schema-${expectedVersion}.backup-${uid()}.upgrade-${upgradeOf(db)}`;
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

/** How many upgrades of one vault keep their pre-upgrade backup. */
const KEPT_UPGRADES = 2;

/**
 * Prunes one vault's migration backups, with their `-wal` and `-shm`
 * companions. Backups are grouped by the upgrade ID in their name; a backup
 * with the older name, which has no upgrade ID, is an upgrade of its own.
 * Each upgrade keeps only its lowest-schema backup: the vault as it was
 * before that upgrade. Then the backups of the two newest upgrades are kept.
 * Backups are full copies that still hold conversations the owner deleted
 * later, so they must not accumulate. Call it only after the vault opened
 * successfully: a failed upgrade needs every backup, and its intermediate
 * steps are removed only once a later open has succeeded. It never throws,
 * because a leftover file must not fail the open.
 */
export function pruneMigrationBackups(file: string, db: Database): void {
  try {
    const directory = path.dirname(file);
    const remove = (name: string) => {
      for (const companion of ["", "-wal", "-shm"])
        try {
          rmSync(path.join(directory, name) + companion, { force: true });
        } catch {
          // The next successful open tries again.
        }
    };
    const prefix = `${path.basename(file)}.schema-`;
    // Exactly the names migrateWithBackup writes or wrote before backups
    // carried an upgrade ID; anything else is left alone.
    const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const suffix = new RegExp(`^(\\d+)\\.backup-${id}(?:\\.upgrade-(${id}))?$`);
    type Backup = { name: string; schema: number; time: number };
    const byUpgrade = new Map<string, Backup[]>();
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix)) continue;
      const match = suffix.exec(name.slice(prefix.length));
      if (!match) continue;
      const stat = statSync(path.join(directory, name));
      if (!stat.isFile()) continue;
      const upgrade = match[2] ?? name;
      const backup = { name, schema: Number(match[1]), time: stat.mtimeMs };
      byUpgrade.set(upgrade, [...(byUpgrade.get(upgrade) ?? []), backup]);
    }
    const current = upgrades.get(db);
    const kept: Array<Backup & { current: boolean }> = [];
    for (const [upgrade, backups] of byUpgrade) {
      backups.sort(
        (a, b) =>
          a.schema - b.schema || a.time - b.time || (a.name < b.name ? -1 : 1),
      );
      const [first, ...intermediate] = backups;
      intermediate.forEach(({ name }) => remove(name));
      kept.push({ ...first, current: upgrade === current });
    }
    // The upgrade this open made is the newest. Otherwise a vault's schema
    // only rises, so an upgrade that started from a later schema is newer.
    // A copy can inherit the vault's modification time, so time only breaks
    // ties within one schema.
    kept.sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.schema - a.schema ||
        b.time - a.time ||
        (a.name < b.name ? 1 : -1),
    );
    for (const { name } of kept.slice(KEPT_UPGRADES)) remove(name);
  } catch {
    // Pruning is housekeeping; the vault is already open and sound.
  }
}
