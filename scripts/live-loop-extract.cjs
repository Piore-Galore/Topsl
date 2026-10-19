// Reads a finished live-loop profile (scripts/live-loop.mjs) and prints what
// the report needs: each loop contribution's validation and reported model,
// and each run's requested and reported model. Run with Electron's Node
// (ELECTRON_RUN_AS_NODE=1), because the encrypted store is built for its ABI.
// It reads only an isolated test profile, whose vault uses Topsl's fixed test
// passphrase; it never opens a user's own profile.
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const dir = process.argv[2];
const vault = JSON.parse(fs.readFileSync(path.join(dir, "vault.json"), "utf8"));
if (vault.method !== "passphrase")
  throw new Error("Not an isolated test profile.");
const key = crypto.scryptSync(
  "Topsl isolated test passphrase",
  Buffer.from(vault.salt, "hex"),
  32,
);
const decipher = crypto.createDecipheriv(
  "aes-256-gcm",
  key,
  Buffer.from(vault.iv, "hex"),
);
decipher.setAuthTag(Buffer.from(vault.tag, "hex"));
const dbKey = Buffer.concat([
  decipher.update(Buffer.from(vault.data, "base64")),
  decipher.final(),
]).toString("utf8");
const Database = require(
  path.resolve("node_modules/better-sqlite3-multiple-ciphers"),
);
const db = new Database(path.join(dir, "history.sqlite"), { readonly: true });
db.pragma("cipher='sqlcipher'");
db.pragma("legacy=4");
db.pragma(`key='${dbKey}'`);
const rows = (kind) =>
  db
    .prepare("SELECT body FROM documents WHERE kind=?")
    .all(kind)
    .map((r) => JSON.parse(r.body));
const attempts = new Map(rows("attempt").map((a) => [a.id, a]));
process.stdout.write(
  JSON.stringify({
    loopContributions: rows("loop-contribution").map((c) => ({
      round: c.roundId.split(":").slice(-2).join(":"),
      member: c.memberId,
      phase: c.phase,
      reportedModel: c.reportedModel,
      requestedModel: attempts.get(c.attemptId)?.requestedModel ?? null,
      validation: c.validation,
    })),
    childContributions: rows("role-contribution").map((c) => ({
      member: c.memberId,
      reportedModel: c.reportedModel,
      requestedModel: attempts.get(c.attemptId)?.requestedModel ?? null,
      validation: c.validation,
    })),
  }),
);
