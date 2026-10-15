import Database from "better-sqlite3-multiple-ciphers";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { hash, now, uid, stable } from "../domain/invariants";
import type { Message } from "../domain/types";
import { migrateWithBackup } from "./migrations/backup";
import { EVENT_SCHEMA_VERSION, migrateEvents } from "./migrations/events";
import { migrateExecutions } from "./migrations/executions";
import { BLOB_SCHEMA_VERSION, migrateBlobs } from "./migrations/blobs";
import { bindCandidateStore } from "./candidate-binding";
import { ProtectedBlobs, recoverAbandonedCaptures } from "./blobs";
import type { ChangePage } from "../domain/events";
import {
  COORDINATION_SCHEMA_VERSION,
  migrateCoordination,
} from "./migrations/coordination";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface DocumentScope {
  projectId?: string;
  conversationId?: string;
}
export interface PageOptions extends DocumentScope {
  cursor?: string | null;
  limit?: number;
  order?: "asc" | "desc";
}
// Undefined allows all project records; an empty allowlist allows none.
// These predicates are applied before LIMIT, including for full-text search.
export interface MessageVisibility {
  conversationIds?: readonly string[];
  messageIds?: readonly string[];
  runIds?: readonly string[];
  excludedConversationIds?: readonly string[];
  excludedMessageIds?: readonly string[];
  excludedRunIds?: readonly string[];
}
export interface MessagePageOptions extends PageOptions {
  projectId: string;
  roles?: readonly Message["role"][];
  visibility?: MessageVisibility;
}
interface PageCursor {
  version: 1;
  scope: string;
  upper: number;
  last: number;
}

export class Store {
  readonly db: Database;
  private readonly statements = new Map<
    string,
    ReturnType<Database["prepare"]>
  >();
  private prepare(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
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
      if (schemaVersion > BLOB_SCHEMA_VERSION)
        throw new Error(
          "This history database was created by a newer Topsl version.",
        );
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("synchronous=FULL");
      this.db.pragma("secure_delete=ON");
      if (schemaVersion < 2)
        migrateWithBackup(this.db, file, key, schemaVersion, 2, () => {
          if (schemaVersion === 0)
            this.db
              .exec(`CREATE TABLE documents(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
              CREATE TABLE events(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
              CREATE VIRTUAL TABLE message_search USING fts5(id UNINDEXED,project_id UNINDEXED,text);`);
          this.db.exec(`
            CREATE TABLE document_index(
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL,id TEXT NOT NULL,
              project_id TEXT,conversation_id TEXT,
              UNIQUE(kind,id)
            );
            INSERT INTO document_index(kind,id,project_id,conversation_id)
              SELECT kind,id,json_extract(body,'$.projectId'),json_extract(body,'$.conversationId')
              FROM documents ORDER BY rowid;
            CREATE INDEX document_kind_sequence ON document_index(kind,sequence);
            CREATE INDEX document_project_sequence ON document_index(kind,project_id,sequence);
            CREATE INDEX document_conversation_sequence ON document_index(kind,project_id,conversation_id,sequence);
            CREATE TRIGGER document_insert AFTER INSERT ON documents BEGIN
              INSERT INTO document_index(kind,id,project_id,conversation_id)
              VALUES(new.kind,new.id,json_extract(new.body,'$.projectId'),json_extract(new.body,'$.conversationId'));
            END;
            CREATE TRIGGER document_update AFTER UPDATE OF body ON documents BEGIN
              UPDATE document_index SET project_id=json_extract(new.body,'$.projectId'),
                conversation_id=json_extract(new.body,'$.conversationId')
                WHERE kind=new.kind AND id=new.id;
            END;
            CREATE TRIGGER document_delete AFTER DELETE ON documents BEGIN
              DELETE FROM document_index WHERE kind=old.kind AND id=old.id;
            END;
          `);
        });
      migrateCoordination(this.db, file, key);
      migrateEvents(this.db, file, key);
      migrateExecutions(this.db, file, key);
      migrateBlobs(this.db, file, key);
      recoverAbandonedCaptures(this);
      new ProtectedBlobs(this).collectUnreferenced(100);
      chmodSync(file, 0o600);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.prepare(
      "SELECT body FROM documents WHERE kind=? AND id=?",
    ).get(kind, id);
    if (!row) return undefined;
    const value = JSON.parse(row.body);
    return kind === "candidate" ? bindCandidateStore(value, this) : value;
  }
  controlHead(): number {
    return this.prepare(
      "SELECT COALESCE(MAX(sequence),0) AS head FROM control_changes",
    ).get().head;
  }
  controlPage(
    afterSequence: number,
    scope: DocumentScope = {},
    limit = 200,
  ): ChangePage {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error("Invalid event cursor or limit.");
    const headSequence = this.controlHead();
    if (afterSequence > headSequence)
      throw new Error(
        "Event cursor belongs to a newer or restored vault; resync required.",
      );
    // Scan bounded batches before filtering, so every subscription advances even during other projects' streams.
    const rows = this.prepare(
      "SELECT sequence,kind,id,project_id AS projectId,conversation_id AS conversationId,operation FROM control_changes WHERE sequence>? ORDER BY sequence LIMIT ?",
    ).all(afterSequence, limit);
    const throughSequence = rows.at(-1)?.sequence ?? afterSequence;
    return {
      afterSequence,
      throughSequence,
      headSequence,
      hasMore: throughSequence < headSequence,
      events: rows.filter(
        (row) =>
          (scope.projectId === undefined ||
            row.projectId === scope.projectId ||
            row.projectId === null) &&
          (scope.conversationId === undefined ||
            row.conversationId === scope.conversationId ||
            row.conversationId === null),
      ),
    };
  }
  list<T>(kind: string): T[] {
    return this.prepare(
      "SELECT body FROM documents WHERE kind=? ORDER BY rowid DESC LIMIT 5000",
    )
      .all(kind)
      .map((row) => {
        const value = JSON.parse(row.body);
        return kind === "candidate" ? bindCandidateStore(value, this) : value;
      });
  }
  page<T>(kind: string, options: PageOptions = {}): Page<T> {
    return this.queryPage(kind, options);
  }
  *iterate<T>(kind: string, scope: DocumentScope = {}): Generator<T> {
    let cursor: string | null = null;
    do {
      const page: Page<T> = this.page(kind, {
        ...scope,
        order: "asc",
        limit: 500,
        cursor,
      });
      yield* page.items;
      cursor = page.nextCursor;
    } while (cursor);
  }
  messagesPage(options: MessagePageOptions): Page<Message> {
    if (!options.projectId)
      throw new Error("History requires a project scope.");
    return this.queryPage("message", options);
  }
  searchPage(
    projectId: string,
    query: string,
    options: Omit<MessagePageOptions, "projectId"> = {},
  ): Page<Message> {
    if (!projectId) throw new Error("Search requires a project scope.");
    const safe = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => '"' + w.replaceAll('"', '""') + '"')
      .join(" AND ");
    return this.queryPage("message", { ...options, projectId }, safe);
  }
  private queryPage<T>(
    kind: string,
    options: PageOptions & Partial<MessagePageOptions>,
    search?: string,
  ): Page<T> {
    const limit = options.limit ?? 100;
    const order = options.order ?? "desc";
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Page size must be an integer between 1 and 500.");
    if (order !== "asc" && order !== "desc")
      throw new Error("Invalid page order.");
    const predicates = ["i.kind=?"];
    const params: unknown[] = [kind];
    if (options.projectId !== undefined) {
      predicates.push("i.project_id=?");
      params.push(options.projectId);
    }
    if (options.conversationId !== undefined) {
      predicates.push("i.conversation_id=?");
      params.push(options.conversationId);
    }
    const filter = (
      expression: string,
      ids: readonly string[] | undefined,
      excluded = false,
    ) => {
      if (ids === undefined) return;
      if (
        !Array.isArray(ids) ||
        ids.length > 10000 ||
        ids.some((id) => typeof id !== "string")
      )
        throw new Error("Invalid history visibility policy.");
      // NULL run IDs must survive an exclusion list, but never an allowlist.
      predicates.push(
        `${excluded ? `COALESCE(${expression},'')` : expression} ${excluded ? "NOT IN" : "IN"} (SELECT value FROM json_each(?))`,
      );
      params.push(JSON.stringify([...new Set(ids)].sort()));
    };
    filter("json_extract(d.body,'$.role')", options.roles);
    const visibility = options.visibility;
    if (
      visibility !== undefined &&
      (!visibility ||
        typeof visibility !== "object" ||
        Array.isArray(visibility) ||
        Object.keys(visibility).some(
          (key) =>
            ![
              "conversationIds",
              "messageIds",
              "runIds",
              "excludedConversationIds",
              "excludedMessageIds",
              "excludedRunIds",
            ].includes(key),
        ))
    )
      throw new Error("Invalid history visibility policy.");
    for (const [field, expression, excluded] of [
      ["conversationIds", "i.conversation_id", false],
      ["messageIds", "i.id", false],
      ["runIds", "json_extract(d.body,'$.runId')", false],
      ["excludedConversationIds", "i.conversation_id", true],
      ["excludedMessageIds", "i.id", true],
      ["excludedRunIds", "json_extract(d.body,'$.runId')", true],
    ] as const)
      filter(expression, visibility?.[field], excluded);
    if (search !== undefined) {
      if (!search) return { items: [], nextCursor: null };
      predicates.push(
        "message_search MATCH ?",
        "message_search.project_id=i.project_id",
      );
      params.push(search);
    }
    // Bind the cursor to the actual SQL predicates, not caller-provided context.
    const scope = hash(stable({ predicates, params, order }));
    const currentUpper = this.prepare(
      "SELECT COALESCE(MAX(sequence),0) AS upper FROM document_index",
    ).get().upper;
    let boundary: PageCursor = {
      version: 1,
      scope,
      upper: currentUpper,
      last: order === "desc" ? currentUpper + 1 : 0,
    };
    if (options.cursor !== undefined && options.cursor !== null) {
      try {
        if (typeof options.cursor !== "string" || options.cursor.length > 2000)
          throw new Error();
        boundary = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString("utf8"),
        );
        if (
          boundary.version !== 1 ||
          boundary.scope !== scope ||
          !Number.isSafeInteger(boundary.upper) ||
          boundary.upper < 0 ||
          !Number.isSafeInteger(boundary.last) ||
          boundary.last < 0 ||
          boundary.last > boundary.upper + 1
        )
          throw new Error();
      } catch {
        throw new Error("Invalid cursor for this history scope.");
      }
    }
    predicates.push(
      "i.sequence<=?",
      `i.sequence${order === "desc" ? "<" : ">"}?`,
    );
    params.push(boundary.upper, boundary.last, limit + 1);
    const rows = this.prepare(
      `
      SELECT d.body,i.sequence FROM document_index i
      JOIN documents d ON d.kind=i.kind AND d.id=i.id
      ${search !== undefined ? "JOIN message_search ON message_search.rowid=i.sequence" : ""}
      WHERE ${predicates.join(" AND ")}
      ORDER BY i.sequence ${order} LIMIT ?
    `,
    ).all(...params);
    const included = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({ ...boundary, last: included.at(-1)!.sequence }),
          ).toString("base64url")
        : null;
    return {
      items: included.map((row) => {
        const value = JSON.parse(row.body);
        return kind === "candidate" ? bindCandidateStore(value, this) : value;
      }),
      nextCursor,
    };
  }
  put<T extends { id: string }>(kind: string, value: T): void {
    this.prepare(
      "INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
    ).run(kind, value.id, JSON.stringify(value));
  }
  immutable<T extends { id: string }>(kind: string, value: T): void {
    const previous = this.get(kind, value.id);
    if (previous && stable(previous) !== stable(value))
      throw new Error("Immutable record collision.");
    if (!previous) this.put(kind, value);
  }
  remove(kind: string, id: string): void {
    this.prepare("DELETE FROM documents WHERE kind=? AND id=?").run(kind, id);
  }
  event(
    kind: string,
    body: unknown,
    scope: "control" | "conversation" = "control",
  ): void {
    this.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(
      uid(),
      scope,
      kind,
      JSON.stringify(body),
      now(),
    );
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
      this.prepare(
        "DELETE FROM message_search WHERE rowid=(SELECT sequence FROM document_index WHERE kind='message' AND id=?)",
      ).run(message.id);
      this.prepare(
        "INSERT INTO message_search(rowid,id,project_id,text) VALUES((SELECT sequence FROM document_index WHERE kind='message' AND id=?),?,?,?)",
      ).run(message.id, message.id, message.projectId, message.text);
    });
  }
  search(projectId: string, query: string): Message[] {
    return this.searchPage(projectId, query).items;
  }
  deleteConversation(id: string): void {
    this.transaction(() => {
      const runs = this.prepare(
        "SELECT id FROM documents WHERE kind='run' AND json_extract(body,'$.conversationId')=?",
      )
        .all(id)
        .map((r) => r.id);
      for (const runId of runs)
        this.prepare(
          "DELETE FROM documents WHERE kind='usage' AND json_extract(body,'$.runId')=?",
        ).run(runId);
      this.prepare(
        "DELETE FROM events WHERE json_extract(body,'$.conversationId')=? OR (kind LIKE 'conversation.%' AND json_extract(body,'$.id')=?)",
      ).run(id, id);
      for (const runId of runs)
        this.prepare(
          "DELETE FROM events WHERE json_extract(body,'$.runId')=? OR (kind LIKE 'run.%' AND json_extract(body,'$.id')=?)",
        ).run(runId, runId);
      this.prepare(
        "DELETE FROM message_search WHERE rowid IN (SELECT sequence FROM document_index WHERE kind='message' AND conversation_id=?)",
      ).run(id);
      this.prepare(
        "DELETE FROM documents WHERE kind IN ('message','snapshot','run') AND json_extract(body,'$.conversationId')=?",
      ).run(id);
      // Additive coordination projections and their revisions share the same deletion
      // boundary as their source conversation. Control events retain no deleted text.
      this.prepare(
        "DELETE FROM documents WHERE kind IN ('context-package','context-package-revision','context-delivery','context-delivery-revision','agent-session','agent-session-revision','attempt','attempt-revision','task','task-revision','artifact','artifact-revision') AND json_extract(body,'$.conversationId')=?",
      ).run(id);
      this.prepare(
        "DELETE FROM events WHERE json_extract(body,'$.conversationId')=?",
      ).run(id);
      this.remove("conversation", id);
      this.put("tombstone", { id, deletedAt: now() });
      this.event("conversation.deleted", { id });
    });
  }
  close(): void {
    this.db.close();
  }
}
