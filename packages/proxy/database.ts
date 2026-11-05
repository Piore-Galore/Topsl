import Database from "better-sqlite3-multiple-ciphers";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import {
  RETIRED_TABLES,
  RETIREMENT_MARKER,
  completedMarker,
  exclusive,
  upgradeProxySchema,
  type RetirementOptions,
} from "./retirement";

/**
 * The proxy's encrypted database (docs/Native_Harness_Plan.md §2,
 * "Credentials and funding"): connections, routes, credentials and request
 * receipts, in a SQLCipher file of its own. The proxy process is its only
 * writer; the control service never opens it.
 */
export const PROXY_SCHEMA_VERSION = 2;

/**
 * Schema 1, as Topsl wrote it before 5 November 2026's retirement of the
 * direct Claude connection. Schema 2 adds the history-only retired tables
 * (packages/proxy/retirement.ts).
 */
export const PROXY_SCHEMA_V1 = `
  CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE connections(id TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE routes(id TEXT PRIMARY KEY,alias TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,body TEXT NOT NULL);
  CREATE TABLE credentials(connection_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE receipts(id TEXT PRIMARY KEY,attempt_id TEXT,connection_id TEXT,started_at TEXT NOT NULL,body TEXT NOT NULL);
  CREATE INDEX receipt_attempt ON receipts(attempt_id,started_at);
  CREATE INDEX receipt_connection ON receipts(connection_id,started_at);
`;

/**
 * Derives the proxy database key from the vault key, so the history database
 * key never opens the credential database directly. Both keys come from the
 * same vault, so this separates files and processes, not trust domains.
 */
export function proxyDatabaseKey(vaultKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(vaultKey)) throw new Error("Invalid vault key.");
  return createHmac("sha256", Buffer.from(vaultKey, "hex"))
    .update("topsl-proxy-credentials-v1")
    .digest("hex");
}

export class ProxyDatabase {
  readonly db: Database;
  /**
   * Opens (and if needed upgrades) the database. The proxy process is its
   * only writer: Electron's single-instance lock keeps a second Topsl off
   * the profile, and the desktop broker starts a new proxy only after the
   * previous one exited. Upgrade transactions are also exclusive, so a
   * writer that still held the file would make the open fail rather than
   * have credentials deleted beneath it.
   */
  constructor(file: string, key: string, options: RetirementOptions = {}) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("Invalid proxy database key.");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try {
      this.db.pragma("cipher='sqlcipher'");
      this.db.pragma("legacy=4");
      this.db.pragma(`key='${key}'`);
      const version = this.db.prepare("PRAGMA user_version").get()
        .user_version as number;
      if (version > PROXY_SCHEMA_VERSION)
        throw new Error(
          "The connection database was created by a newer Topsl version.",
        );
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("synchronous=FULL");
      this.db.pragma("secure_delete=ON");
      if (version === 0)
        exclusive(this.db, () => {
          this.db.exec(PROXY_SCHEMA_V1);
          this.db.exec(RETIRED_TABLES);
          this.db
            .prepare("INSERT INTO meta(key,value) VALUES(?,?)")
            .run(RETIREMENT_MARKER, JSON.stringify(completedMarker()));
          this.db.pragma(`user_version=${PROXY_SCHEMA_VERSION}`);
        });
      else upgradeProxySchema(this.db, version, options);
      chmodSync(file, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  meta(key: string): string | null {
    return (
      (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value as
        string | undefined) ?? null
    );
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  /**
   * The opaque, stable `ext_agent_host_id` for this Topsl profile: a UUIDv4
   * URN, created once. It identifies no person and is not a credential.
   */
  hostId(): string {
    let value = this.meta("ext-agent-host-id");
    if (!value) {
      value = `urn:uuid:${randomUUID()}`;
      this.setMeta("ext-agent-host-id", value);
    }
    return value;
  }
  close(): void {
    this.db.close();
  }
}
