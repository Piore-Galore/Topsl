// Seeds a desktop test profile as Topsl left it before 5 November 2026's
// retirement of the direct Claude subscription connection: an isolated-test
// passphrase vault and a schema 1 `connections.sqlite` holding a Claude plan
// connection, its route, a synthetic OAuth credential and one receipt.
// scripts/desktop-native-test.mjs runs it with Electron as Node (the SQLCipher
// module is built for Electron) before the app's first launch, so the real
// proxy performs the schema 2 upgrade. Every value here is synthetic.
//
// The vault format and key derivation mirror apps/desktop/vault.ts and
// packages/proxy/database.ts; the schema is the frozen schema 1
// (PROXY_SCHEMA_V1 there).
const { createCipheriv, createHmac, randomBytes, scryptSync } = require("node:crypto");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3-multiple-ciphers");

const profile = process.argv[2];
if (!profile) throw new Error("Pass the test profile directory.");
mkdirSync(profile, { recursive: true, mode: 0o700 });

const vaultKey = randomBytes(32).toString("hex");
const salt = randomBytes(32);
const iv = randomBytes(12);
const cipher = createCipheriv(
  "aes-256-gcm",
  scryptSync("Topsl isolated test passphrase", salt, 32),
  iv,
);
const data = Buffer.concat([cipher.update(vaultKey, "utf8"), cipher.final()]);
writeFileSync(
  path.join(profile, "vault.json"),
  JSON.stringify({
    method: "passphrase",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("base64"),
  }),
  { mode: 0o600 },
);

const proxyKey = createHmac("sha256", Buffer.from(vaultKey, "hex"))
  .update("topsl-proxy-credentials-v1")
  .digest("hex");
const db = new Database(path.join(profile, "connections.sqlite"));
db.pragma("cipher='sqlcipher'");
db.pragma("legacy=4");
db.pragma(`key='${proxyKey}'`);
db.pragma("journal_mode=WAL");
const at = new Date().toISOString();
db.exec(`
  BEGIN;
  CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE connections(id TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE routes(id TEXT PRIMARY KEY,alias TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,body TEXT NOT NULL);
  CREATE TABLE credentials(connection_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE receipts(id TEXT PRIMARY KEY,attempt_id TEXT,connection_id TEXT,started_at TEXT NOT NULL,body TEXT NOT NULL);
  CREATE INDEX receipt_attempt ON receipts(attempt_id,started_at);
  CREATE INDEX receipt_connection ON receipts(connection_id,started_at);
  PRAGMA user_version=1;
  COMMIT;
`);
const account = {
  accountKey: "claude:legacy-account:legacy-org",
  email: "legacy-person@example.invalid",
  source: "oauth-profile",
  quotaOwner: "claude:legacy-account:legacy-org",
  observedAt: at,
};
db.prepare("INSERT INTO connections(id,body) VALUES(?,?)").run(
  "legacy-claude",
  JSON.stringify({
    id: "legacy-claude",
    kind: "claude-plan",
    label: "Claude plan",
    endpoint: "https://api.anthropic.com/v1",
    protocol: "messages",
    authentication: "oauth-claude",
    funding: "subscription",
    state: "ready",
    stateDetail: null,
    account,
    hasCredential: true,
    revocation: "not-supported",
    revision: 2,
    createdAt: at,
    updatedAt: at,
  }),
);
db.prepare("INSERT INTO routes(id,alias,connection_id,body) VALUES(?,?,?,?)").run(
  "legacy-claude-route",
  "claude-plan/legacy",
  "legacy-claude",
  JSON.stringify({
    id: "legacy-claude-route",
    connectionId: "legacy-claude",
    upstreamModel: "legacy-claude-model",
    alias: "claude-plan/legacy",
    protocol: "messages",
    adapterRevision: "claude-plan-messages-e6e5708-v1",
    capabilities: {},
    revision: "legacy-revision",
    disabled: false,
    createdAt: at,
    updatedAt: at,
  }),
);
db.prepare(
  "INSERT INTO credentials(connection_id,revision,body,updated_at) VALUES(?,?,?,?)",
).run(
  "legacy-claude",
  1,
  JSON.stringify({
    kind: "oauth-claude",
    clientId: "legacy-client",
    accountId: "legacy-account",
    organizationId: "legacy-org",
    email: account.email,
    accessToken: "synthetic-legacy-claude-access",
    refreshToken: "synthetic-legacy-claude-refresh",
    tokenType: "Bearer",
    expiresAt: at,
    scopes: ["user:inference"],
    scopeEvidence: "reported",
    savedAt: at,
  }),
  at,
);
db.prepare(
  "INSERT INTO receipts(id,attempt_id,connection_id,started_at,body) VALUES(?,?,?,?,?)",
).run(
  "legacy-receipt",
  null,
  "legacy-claude",
  at,
  JSON.stringify({
    id: "legacy-receipt",
    correlationId: null,
    attemptId: null,
    routeId: "legacy-claude-route",
    routeRevision: "legacy-revision",
    connectionId: "legacy-claude",
    accountKey: account.accountKey,
    funding: "subscription",
    clientProtocol: "messages",
    upstreamProtocol: "messages",
    requestedModel: "claude-plan/legacy",
    upstreamModel: "legacy-claude-model",
    reportedModel: "legacy-claude-model",
    outcome: "completed",
    error: null,
    usage: { input: 12, output: 3, cachedInput: null, reasoning: null },
    upstreamRequestId: null,
    startedAt: at,
    finishedAt: at,
  }),
);
db.close();
