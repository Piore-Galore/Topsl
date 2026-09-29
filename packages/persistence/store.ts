import Database from "better-sqlite3-multiple-ciphers";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { now, uid, stable } from "../domain/invariants";
import type { Message } from "../domain/types";
export class Store {
  readonly db: Database;
  constructor(file: string, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid vault key.");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    try {
      this.db.pragma("cipher='sqlcipher'");
      this.db.pragma("legacy=4");
      this.db.pragma(`key='${key}'`);
      const schemaVersion = this.db
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      if (schemaVersion > 1)
        throw new Error(
          "This history database was created by a newer Topsl version.",
        );
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("synchronous=FULL");
      this.db.pragma("secure_delete=ON");
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(id UNINDEXED,project_id UNINDEXED,text);
      PRAGMA user_version=1;`);
      chmodSync(file, 0o600);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM documents WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.body) : undefined;
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare(
        "SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC LIMIT 5000",
      )
      .all(kind)
      .map((row) => JSON.parse(row.body));
  }
  put<T extends { id: string }>(kind: string, value: T): void {
    this.db
      .prepare(
        "INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, value.id, JSON.stringify(value));
  }
  immutable<T extends { id: string }>(kind: string, value: T): void {
    const previous = this.get(kind, value.id);
    if (previous && stable(previous) !== stable(value))
      throw new Error("Immutable record collision.");
    if (!previous) this.put(kind, value);
  }
  remove(kind: string, id: string): void {
    this.db
      .prepare("DELETE FROM documents WHERE kind=? AND id=?")
      .run(kind, id);
  }
  event(
    kind: string,
    body: unknown,
    scope: "control" | "conversation" = "control",
  ): void {
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
      .run(uid(), scope, kind, JSON.stringify(body), now());
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  save<T extends { id: string }>(
    kind: string,
    value: T,
    event = `${kind}.changed`,
  ): void {
    this.transaction(() => {
      this.put(kind, value);
      this.event(event, value);
    });
  }
  message(message: Message): void {
    if (this.get("tombstone", message.conversationId)) return;
    this.transaction(() => {
      this.put("message", message);
      this.db.prepare("DELETE FROM message_search WHERE id=?").run(message.id);
      this.db
        .prepare("INSERT INTO message_search(id,project_id,text) VALUES(?,?,?)")
        .run(message.id, message.projectId, message.text);
    });
  }
  search(projectId: string, query: string): Message[] {
    const safe = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => '"' + w.replaceAll('"', '""') + '"')
      .join(" AND ");
    if (!safe) return [];
    return this.db
      .prepare(
        "SELECT id FROM message_search WHERE message_search MATCH ? AND project_id=? LIMIT 100",
      )
      .all(safe, projectId)
      .map((row) => this.get<Message>("message", row.id)!)
      .filter(Boolean);
  }
  deleteConversation(id: string): void {
    this.transaction(() => {
      const runs = this.db
        .prepare(
          "SELECT id FROM documents WHERE kind='run' AND json_extract(body,'$.conversationId')=?",
        )
        .all(id)
        .map((r) => r.id);
      for (const runId of runs)
        this.db
          .prepare(
            "DELETE FROM documents WHERE kind='usage' AND json_extract(body,'$.runId')=?",
          )
          .run(runId);
      this.db
        .prepare(
          "DELETE FROM events WHERE json_extract(body,'$.conversationId')=? OR (kind LIKE 'conversation.%' AND json_extract(body,'$.id')=?)",
        )
        .run(id, id);
      for (const runId of runs)
        this.db
          .prepare(
            "DELETE FROM events WHERE json_extract(body,'$.runId')=? OR (kind LIKE 'run.%' AND json_extract(body,'$.id')=?)",
          )
          .run(runId, runId);
      this.db
        .prepare(
          "DELETE FROM message_search WHERE id IN (SELECT id FROM documents WHERE kind='message' AND json_extract(body,'$.conversationId')=?)",
        )
        .run(id);
      this.db
        .prepare(
          "DELETE FROM documents WHERE kind IN ('message','snapshot','run') AND json_extract(body,'$.conversationId')=?",
        )
        .run(id);
      this.remove("conversation", id);
      this.put("tombstone", { id, deletedAt: now() });
      this.event("conversation.deleted", { id });
    });
  }
  close(): void {
    this.db.close();
  }
}
