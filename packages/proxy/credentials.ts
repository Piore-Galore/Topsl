import { createHash } from "node:crypto";
import type { ProxyDatabase } from "./database";

/**
 * Stored upstream credentials (docs/Native_Harness_Plan.md §2, "Credentials
 * and funding"). The proxy process is the only reader and writer. Records
 * live in the encrypted `credentials` table, one per connection, and every
 * write is a compare-and-swap on the row's revision so a refresh that lost a
 * race can never overwrite a newer rotating token.
 */

/** A ChatGPT plan sign-in, as the documented OAuth flow established it. */
export interface ChatGptCredential {
  kind: "oauth-chatgpt";
  /** The client ID issued at registration; never `dynamic_agent_client`. */
  clientId: string;
  extAgentHostId: string;
  issuer: string;
  /** The validated ID token `sub`; with `clientId`, the account identity. */
  subject: string;
  email: string | null;
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  /** ISO time the access token expires. */
  expiresAt: string;
  /** ISO time before which the provider asks Topsl not to refresh. */
  earliestRefreshAt: string | null;
  /** Granted scopes; plan use requires `chatgpt.tokens.use.direct`. */
  scopes: string[];
  savedAt: string;
}

export interface ApiKeyCredential {
  kind: "api-key";
  key: string;
  /** A short hash that identifies the key in receipts without revealing it. */
  fingerprint: string;
  savedAt: string;
}

/** Experimental Claude subscription OAuth; never a Console API key. */
export interface ClaudeCredential {
  kind: "oauth-claude";
  clientId: string;
  accountId: string;
  organizationId: string;
  email: string | null;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string;
  scopes: string[];
  scopeEvidence: "reported" | "requested";
  savedAt: string;
}

export type StoredCredential =
  ChatGptCredential | ClaudeCredential | ApiKeyCredential;

/** A write lost a race: the stored revision is not the one the writer read. */
export class CredentialConflict extends Error {
  constructor(
    readonly connectionId: string,
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      `The credential for connection ${connectionId} changed (expected revision ${expectedRevision ?? "none"}, found ${actualRevision ?? "none"}).`,
    );
    this.name = "CredentialConflict";
  }
}

/** Identifies an API key in receipts and the UI without storing it twice. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16)}`;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Checks a decrypted row before handing it out, so a damaged or
 * older-format record fails here with a plain message instead of failing
 * later inside an upstream request. The message never quotes the record.
 */
function parseCredential(body: string): StoredCredential {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("A stored credential is unreadable.");
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as
    Record<string, unknown> | Record<string, never>;
  if (record.kind === "api-key") {
    if (
      isString(record.key) &&
      isString(record.fingerprint) &&
      isString(record.savedAt)
    )
      return record as unknown as ApiKeyCredential;
  } else if (record.kind === "oauth-claude") {
    if (
      [
        "clientId",
        "accountId",
        "organizationId",
        "accessToken",
        "tokenType",
        "expiresAt",
        "savedAt",
      ].every((name) => isString(record[name])) &&
      isNullableString(record.email) &&
      isNullableString(record.refreshToken) &&
      Array.isArray(record.scopes) &&
      record.scopes.every(isString) &&
      ["reported", "requested"].includes(String(record.scopeEvidence))
    )
      return record as unknown as ClaudeCredential;
  } else if (record.kind === "oauth-chatgpt") {
    const strings = [
      "clientId",
      "extAgentHostId",
      "issuer",
      "subject",
      "idToken",
      "accessToken",
      "tokenType",
      "expiresAt",
      "savedAt",
    ];
    const nullable = ["email", "refreshToken", "earliestRefreshAt"];
    if (
      strings.every((name) => isString(record[name])) &&
      nullable.every((name) => isNullableString(record[name])) &&
      Array.isArray(record.scopes) &&
      record.scopes.every(isString)
    )
      return record as unknown as ChatGptCredential;
  }
  throw new Error("A stored credential has an unrecognized format.");
}

export class CredentialStore {
  /**
   * Tail of each connection's lock queue. Entries are removed once the queue
   * drains, so the map holds only connections with work in progress.
   */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly db: ProxyDatabase) {}

  get(
    connectionId: string,
  ): { revision: number; credential: StoredCredential } | null {
    const row = this.db.db
      .prepare("SELECT revision,body FROM credentials WHERE connection_id=?")
      .get(connectionId) as { revision: number; body: string } | undefined;
    if (!row) return null;
    return { revision: row.revision, credential: parseCredential(row.body) };
  }

  /**
   * Compare-and-swap: writes only when the stored revision equals
   * `expectedRevision` (null = no row). Returns the new revision; throws
   * CredentialConflict otherwise.
   */
  put(
    connectionId: string,
    credential: StoredCredential,
    expectedRevision: number | null,
  ): number {
    const body = JSON.stringify(credential);
    parseCredential(body);
    return this.db.transaction(() => {
      const current = this.db.db
        .prepare("SELECT revision FROM credentials WHERE connection_id=?")
        .get(connectionId) as { revision: number } | undefined;
      const actual = current?.revision ?? null;
      if (actual !== expectedRevision)
        throw new CredentialConflict(connectionId, expectedRevision, actual);
      const revision = (actual ?? 0) + 1;
      const updatedAt = new Date().toISOString();
      if (actual === null)
        this.db.db
          .prepare(
            "INSERT INTO credentials(connection_id,revision,body,updated_at) VALUES(?,?,?,?)",
          )
          .run(connectionId, revision, body, updatedAt);
      else
        this.db.db
          .prepare(
            "UPDATE credentials SET revision=?,body=?,updated_at=? WHERE connection_id=? AND revision=?",
          )
          .run(revision, body, updatedAt, connectionId, actual);
      return revision;
    });
  }

  /**
   * Removes the connection's credential. The database runs with
   * `secure_delete=ON`, so the freed pages are overwritten as well.
   */
  delete(connectionId: string): void {
    this.db.db
      .prepare("DELETE FROM credentials WHERE connection_id=?")
      .run(connectionId);
  }

  /**
   * Runs fn with this connection's refresh lock held (process-local
   * serialization). Callers queue in arrival order; a failing fn releases
   * the lock like a successful one. Re-read the credential inside fn: the
   * caller ahead in the queue may already have rotated it.
   */
  async withLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.locks.set(connectionId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(connectionId) === tail)
        this.locks.delete(connectionId);
    }
  }
}
