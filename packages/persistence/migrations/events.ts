import type Database from "better-sqlite3-multiple-ciphers";
import { migrateWithBackup } from "./backup";

export const EVENT_SCHEMA_VERSION = 4;
export function migrateEvents(db: Database, file: string, key: string): void {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= EVENT_SCHEMA_VERSION) return;
  if (version !== 3)
    throw new Error("Ordered event migration requires schema 3.");
  migrateWithBackup(db, file, key, 3, 4, (backup) => {
    db.exec(`DROP TABLE message_search;
      CREATE VIRTUAL TABLE message_search USING fts5(id UNINDEXED,project_id UNINDEXED,text);
      INSERT INTO message_search(rowid,id,project_id,text) SELECT i.sequence,d.id,i.project_id,json_extract(d.body,'$.text') FROM document_index i JOIN documents d ON d.kind=i.kind AND d.id=i.id WHERE i.kind='message';
      CREATE TABLE control_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT,conversation_id TEXT,operation TEXT NOT NULL);
      CREATE INDEX control_changes_project ON control_changes(project_id,sequence);
      CREATE TRIGGER control_document_insert AFTER INSERT ON documents BEGIN
        INSERT INTO control_changes(kind,id,project_id,conversation_id,operation) VALUES(new.kind,new.id,CASE WHEN new.kind='project' THEN new.id ELSE json_extract(new.body,'$.projectId') END,json_extract(new.body,'$.conversationId'),'put');
      END;
      CREATE TRIGGER control_document_update AFTER UPDATE OF body ON documents WHEN old.body<>new.body BEGIN
        INSERT INTO control_changes(kind,id,project_id,conversation_id,operation) VALUES(new.kind,new.id,CASE WHEN new.kind='project' THEN new.id ELSE json_extract(new.body,'$.projectId') END,json_extract(new.body,'$.conversationId'),'put');
      END;
      CREATE TRIGGER control_document_delete AFTER DELETE ON documents BEGIN
        INSERT INTO control_changes(kind,id,project_id,conversation_id,operation) VALUES(old.kind,old.id,CASE WHEN old.kind='project' THEN old.id ELSE json_extract(old.body,'$.projectId') END,json_extract(old.body,'$.conversationId'),'remove');
      END;`);
    db.prepare(
      "INSERT INTO documents(kind,id,body) VALUES('migration','ordered-events-v4',?)",
    ).run(
      JSON.stringify({
        id: "ordered-events-v4",
        from: 3,
        to: 4,
        backup,
        integrity: "ok",
      }),
    );
  });
}
