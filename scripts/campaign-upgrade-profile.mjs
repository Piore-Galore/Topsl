// Campaign packet p8-packaged-upgrade: profile inspection helper (19 October
// 2026, updated 4 November 2026 for the native-integration retirement).
//
// Run under the checkout's Electron in Node mode, so the encrypted SQLite
// module matches its ABI:
//   ELECTRON_RUN_AS_NODE=1 <checkout>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     scripts/campaign-upgrade-profile.mjs inspect <profile> <passphrase>
//   ... set-user-version <profile> <passphrase> <version>
//   ... seed-legacy <profile> <passphrase> <records.json>
//
// `inspect` copies the profile to a temporary folder first and reads only the
// copy, so the profile under test is never opened by this helper. It reads
// passphrase vaults only (an `os` vault needs Electron's safeStorage).
// `seed-legacy` adds the given documents (an array of {kind, id, body}) to a
// closed profile, for records an older release cannot create in an isolated
// test profile (desktop installations and their pending operations). It
// never replaces a document that already exists.
// TOPSL_CAMPAIGN_CLEAN names the checkout whose node_modules to load; it
// defaults to this script's own checkout.
import { createRequire } from "node:module";
import { createDecipheriv, createHash, scryptSync } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLEAN =
  process.env.TOPSL_CAMPAIGN_CLEAN ??
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(path.join(CLEAN, "package.json"));
const Database = require("better-sqlite3-multiple-ciphers");

function databaseKey(profile, passphrase) {
  const vault = JSON.parse(readFileSync(path.join(profile, "vault.json"), "utf8"));
  if (vault.method !== "passphrase")
    throw new Error(`Vault method ${vault.method} cannot be read by this helper.`);
  const key = scryptSync(passphrase, Buffer.from(vault.salt, "hex"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(vault.iv, "hex"));
  decipher.setAuthTag(Buffer.from(vault.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(vault.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
function open(file, key, readonly = false) {
  const db = new Database(file, { readonly, fileMustExist: true });
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${key}'`);
  return db;
}
const sha = (text) => createHash("sha256").update(text).digest("hex");

function inspect(profile, passphrase) {
  const key = databaseKey(profile, passphrase);
  const copy = mkdtempSync(path.join(os.tmpdir(), "topsl-p8-inspect-"));
  try {
    cpSync(profile, copy, {
      recursive: true,
      filter: (source) => !/(Singleton|\.sock$)/.test(path.basename(source)),
    });
    const db = open(path.join(copy, "history.sqlite"), key);
    try {
      const userVersion = db.prepare("PRAGMA user_version").get().user_version;
      const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
        .all()
        .map((r) => r.name);
      const documents = db.prepare("SELECT kind,id,body FROM documents").all();
      const kinds = {};
      const digests = {};
      for (const d of documents) {
        kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
        digests[`${d.kind}:${d.id}`] = sha(d.body);
      }
      const pick = (kind, fields) =>
        documents
          .filter((d) => d.kind === kind)
          .map((d) => {
            const body = JSON.parse(d.body);
            return Object.fromEntries([["id", d.id], ...fields.map((f) => [f, body[f] ?? null])]);
          })
          .sort((a, b) => a.id.localeCompare(b.id));
      const events = tables.includes("events")
        ? db.prepare("SELECT id,kind FROM events ORDER BY rowid").all()
        : [];
      let searchRows = null;
      if (tables.includes("message_search"))
        searchRows = db.prepare("SELECT count(*) AS n FROM message_search").get().n;
      const preferences = documents
        .filter((d) => d.kind === "preference")
        .map((d) => ({ id: d.id, body: JSON.parse(d.body) }));
      const backups = readdirSync(profile)
        .filter((name) => /^history\.sqlite\.schema-\d+\.backup-/.test(name))
        .map((name) => {
          const b = open(path.join(copy, name), key, true);
          try {
            return {
              name,
              userVersion: b.prepare("PRAGMA user_version").get().user_version,
              integrity: b.prepare("PRAGMA integrity_check").get().integrity_check,
              documents: b.prepare("SELECT count(*) AS n FROM documents").get().n,
            };
          } finally {
            b.close();
          }
        });
      return {
        userVersion,
        integrity,
        tables,
        kinds,
        digests,
        projects: pick("project", ["name", "path", "realPath", "trusted", "sources", "nameSource"]),
        conversations: pick("conversation", ["projectId", "title"]),
        messages: pick("message", ["conversationId", "projectId", "role", "provider", "text"]),
        installations: pick("installation", ["appId", "path", "trusted", "owner", "managementUnitId"]),
        runs: pick("run", ["status", "installationId", "conversationId", "nativePid", "error"]),
        jobs: pick("job", ["planId", "state", "detail"]),
        plans: pick("plan", ["appId", "managementUnitId", "nativeApplicationPath"]),
        consumedApprovals: pick("consumed-approval", ["digest", "jobId", "retiredAt"]),
        installationLocks: pick("installation-lock", ["owner"]),
        historySources: pick("native-history-source", ["projectId", "enabled", "state", "revision"]),
        syncFields: pick("sync-field", ["projectId", "state"]),
        migrations: pick("migration", ["at", "counts"]),
        preferences,
        events: { count: events.length, kinds: [...new Set(events.map((e) => e.kind))].sort() },
        searchRows,
        files: readdirSync(profile).sort(),
        backups,
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function setUserVersion(profile, passphrase, version) {
  const key = databaseKey(profile, passphrase);
  const db = open(path.join(profile, "history.sqlite"), key);
  try {
    db.pragma(`user_version=${Number(version)}`);
    db.pragma("wal_checkpoint(TRUNCATE)");
    return { userVersion: db.prepare("PRAGMA user_version").get().user_version };
  } finally {
    db.close();
  }
}

function seedLegacy(profile, passphrase, recordsFile) {
  const records = JSON.parse(readFileSync(recordsFile, "utf8"));
  const key = databaseKey(profile, passphrase);
  const db = open(path.join(profile, "history.sqlite"), key);
  try {
    const exists = db.prepare("SELECT 1 FROM documents WHERE kind=? AND id=?");
    const insert = db.prepare("INSERT INTO documents(kind,id,body) VALUES(?,?,?)");
    const added = [];
    db.transaction(() => {
      for (const { kind, id, body } of records) {
        if (exists.get(kind, id)) throw new Error(`${kind}:${id} already exists.`);
        insert.run(kind, id, JSON.stringify({ id, ...body }));
        added.push(`${kind}:${id}`);
      }
    })();
    db.pragma("wal_checkpoint(TRUNCATE)");
    return { added };
  } finally {
    db.close();
  }
}

const [mode, profile, passphrase, extra] = process.argv.slice(2);
try {
  const result =
    mode === "inspect"
      ? inspect(profile, passphrase)
      : mode === "set-user-version"
        ? setUserVersion(profile, passphrase, extra)
        : mode === "seed-legacy"
          ? seedLegacy(profile, passphrase, extra)
          : (() => {
              throw new Error(
                "Usage: inspect|set-user-version|seed-legacy <profile> <passphrase> [version|records.json]",
              );
            })();
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + "\n");
  process.exitCode = 1;
}
