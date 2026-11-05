import type Database from "better-sqlite3-multiple-ciphers";
import {
  CLAUDE_PLAN_RETIREMENT_REASON,
  type AccountEvidence,
  type RetiredConnection,
  type RetiredRoute,
} from "./types";

/**
 * Retirement of the direct Claude subscription connection (proxy schema 2;
 * docs/Native_Harness_Execution.md, "Retirement of the direct Claude plan
 * connection").
 *
 * It runs when the proxy opens its database, before the proxy publishes
 * state or listens for requests, in two steps:
 *
 * 1. **Fence.** One transaction creates the history tables, records the
 *    marker `fenced` and raises the schema version to 2, so an older Topsl
 *    refuses the file from then on.
 * 2. **Cleanup.** One exclusive transaction moves each `claude-plan`
 *    connection and its routes into history-only records, deletes its
 *    credential and any orphaned Claude credential, and marks the marker
 *    `complete` with non-secret counts. A failure rolls the cleanup back;
 *    the fence stays, and the next open retries.
 *
 * Nothing here contacts a provider, exports a token or makes a backup.
 * Deletion from this database does not revoke a sign-in at the provider or
 * remove copies held in older backups or filesystem snapshots.
 */

export const RETIREMENT_MARKER = "retirement:claude-plan";

export interface RetirementCounts {
  connections: number;
  routes: number;
  credentials: number;
  orphanCredentials: number;
}

export interface RetirementMarker {
  state: "fenced" | "complete";
  fencedAt: string;
  /** Cleanup attempts started, including ones that rolled back. */
  attempts: number;
  completedAt: string | null;
  counts: RetirementCounts | null;
}

/** Tables schema 2 adds. */
export const RETIRED_TABLES = `
  CREATE TABLE IF NOT EXISTS retired_connections(id TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS retired_routes(id TEXT PRIMARY KEY,alias TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,body TEXT NOT NULL);
`;

export interface RetirementOptions {
  /** Test-only fault injection: runs inside the cleanup transaction, before it commits. */
  beforeCleanupCommit?: () => void;
}

const now = () => new Date().toISOString();

/**
 * Runs fn in a `BEGIN EXCLUSIVE` transaction: no other connection can read or
 * write the file meanwhile, and one that holds it makes this throw (after the
 * driver's busy timeout) instead of waiting forever.
 */
export function exclusive(db: Database, fn: () => void): void {
  db.exec("BEGIN EXCLUSIVE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back by SQLite.
    }
    throw error;
  }
}

function readMarker(db: Database): RetirementMarker | null {
  const row = db
    .prepare("SELECT value FROM meta WHERE key=?")
    .get(RETIREMENT_MARKER) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as RetirementMarker;
  } catch {
    return null;
  }
}
function writeMarker(db: Database, marker: RetirementMarker): void {
  db.prepare(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(RETIREMENT_MARKER, JSON.stringify(marker));
}

/** The marker a new database starts with: nothing to retire. */
export function completedMarker(): RetirementMarker {
  const at = now();
  return {
    state: "complete",
    fencedAt: at,
    attempts: 0,
    completedAt: at,
    counts: { connections: 0, routes: 0, credentials: 0, orphanCredentials: 0 },
  };
}

export function retirementMarker(db: Database): RetirementMarker | null {
  return readMarker(db);
}

/** Reads a JSON row body, or null when it is not JSON. Never logs it. */
function parse(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}
const text = (value: unknown, fallback: string, max = 2000) =>
  typeof value === "string" && value ? value.slice(0, max) : fallback;

/** Keeps the account fingerprints receipts refer to, and no contact details. */
function historicalAccount(value: unknown): AccountEvidence {
  const account = (typeof value === "object" && value ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    accountKey: typeof account.accountKey === "string" ? account.accountKey : null,
    email: null,
    source: "oauth-profile",
    quotaOwner:
      typeof account.quotaOwner === "string" ? account.quotaOwner : null,
    observedAt:
      typeof account.observedAt === "string" ? account.observedAt : null,
  };
}

/**
 * Brings a schema 1 database to schema 2, or finishes an interrupted
 * retirement on a schema 2 database. Idempotent: a completed retirement
 * changes nothing.
 */
export function upgradeProxySchema(
  db: Database,
  version: number,
  options: RetirementOptions = {},
): void {
  if (version === 1)
    exclusive(db, () => {
      db.exec(RETIRED_TABLES);
      writeMarker(db, {
        state: "fenced",
        fencedAt: now(),
        attempts: 0,
        completedAt: null,
        counts: null,
      });
      db.pragma("user_version=2");
    });
  const marker = readMarker(db);
  if (marker?.state === "complete") return;
  const fenced: RetirementMarker = marker ?? {
    state: "fenced",
    fencedAt: now(),
    attempts: 0,
    completedAt: null,
    counts: null,
  };
  // Recorded before the cleanup, so a rolled-back attempt still counts.
  const attempt = { ...fenced, attempts: fenced.attempts + 1 };
  exclusive(db, () => {
    db.exec(RETIRED_TABLES);
    writeMarker(db, attempt);
  });
  exclusive(db, () => {
    const at = now();
    const counts: RetirementCounts = {
      connections: 0,
      routes: 0,
      credentials: 0,
      orphanCredentials: 0,
    };
    const connections = db
      .prepare("SELECT id,body FROM connections ORDER BY rowid")
      .all() as Array<{ id: string; body: string }>;
    for (const row of connections) {
      const record = parse(row.body);
      if (record?.kind !== "claude-plan") continue;
      const retired: RetiredConnection = {
        id: row.id,
        kind: "claude-plan",
        label: text(record.label, "Claude plan", 200),
        endpoint: text(record.endpoint, "https://api.anthropic.com/v1"),
        funding: "subscription",
        authentication: "oauth-claude",
        account: historicalAccount(record.account),
        createdAt: text(record.createdAt, at, 64),
        retiredAt: at,
        reason: CLAUDE_PLAN_RETIREMENT_REASON,
      };
      db.prepare(
        "INSERT INTO retired_connections(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      ).run(row.id, JSON.stringify(retired));
      const routes = db
        .prepare("SELECT id,alias,body FROM routes WHERE connection_id=?")
        .all(row.id) as Array<{ id: string; alias: string; body: string }>;
      for (const route of routes) {
        const body = parse(route.body) ?? {};
        const historical: RetiredRoute = {
          id: route.id,
          connectionId: row.id,
          alias: route.alias,
          upstreamModel: text(body.upstreamModel, "unknown", 200),
          protocol: "messages",
          revision: text(body.revision, "", 128),
          retiredAt: at,
          reason: CLAUDE_PLAN_RETIREMENT_REASON,
        };
        db.prepare(
          "INSERT INTO retired_routes(id,alias,connection_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,connection_id=excluded.connection_id,body=excluded.body",
        ).run(route.id, route.alias, row.id, JSON.stringify(historical));
        db.prepare("DELETE FROM routes WHERE id=?").run(route.id);
        counts.routes++;
      }
      counts.credentials += db
        .prepare("DELETE FROM credentials WHERE connection_id=?")
        .run(row.id).changes;
      db.prepare("DELETE FROM connections WHERE id=?").run(row.id);
      counts.connections++;
    }
    // Claude credentials whose connection record is missing or of another kind.
    const credentials = db
      .prepare("SELECT connection_id,body FROM credentials")
      .all() as Array<{ connection_id: string; body: string }>;
    for (const row of credentials)
      if (parse(row.body)?.kind === "oauth-claude") {
        db.prepare("DELETE FROM credentials WHERE connection_id=?").run(
          row.connection_id,
        );
        counts.orphanCredentials++;
      }
    options.beforeCleanupCommit?.();
    writeMarker(db, {
      ...attempt,
      state: "complete",
      completedAt: at,
      counts,
    });
  });
  // Fold the deletions into the main file; secure_delete already overwrote the freed pages.
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // A checkpoint is best effort; the deletions are committed either way.
  }
}
