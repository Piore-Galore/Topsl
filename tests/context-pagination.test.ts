import { afterEach, describe, expect, test } from "vitest";
import { createConnection } from "node:net";
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import Database from "better-sqlite3-multiple-ciphers";
import { Store, type MessageVisibility } from "../packages/persistence/store";
import {
  ContextServer,
  contextRequest,
  type ContextGrant,
} from "../packages/workspace/context";
import { previewHandoff } from "../packages/workspace/history";
import type { Message, Project } from "../packages/domain/types";
import { fixture } from "./helpers";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const servers: ContextServer[] = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  servers.splice(0).forEach((server) => server.close());
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
const project = (directory: string, id = "p"): Project => ({
  id,
  name: id,
  path: directory,
  realPath: directory,
  trusted: true,
  createdAt: "2026-10-14T00:00:00Z",
});
const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  projectId: "p",
  conversationId: "c",
  role: "assistant",
  provider: "codex",
  text: `quartz ${id}`,
  runId: null,
  nativeId: id,
  createdAt: "2026-10-14T00:00:00Z",
  ...overrides,
});
function request(
  grant: ContextGrant,
  body: Record<string, unknown> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(grant.endpoint);
    let response = "";
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("Socket timed out")),
    );
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({ ...grant, method: "status", ...body }) + "\n",
      ),
    );
    socket.on("data", (bytes) => {
      response += bytes.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
  });
}
async function socketFixture(clock?: () => number) {
  const f = await setup();
  const server = new ContextServer(f.store, f.directory, clock);
  servers.push(server);
  await server.start();
  return { ...f, server };
}

describe("independent local context grants", () => {
  test("two grants stay valid; revocation affects only its grant and tokens cannot be exchanged", async () => {
    const { server, directory } = await socketFixture();
    const a = server.grant(project(directory)),
      b = server.grant(project(directory));
    expect(a.grant).not.toBe(b.grant);
    expect(a.token).not.toBe(b.token);
    expect((await request(a)).result.projectId).toBe("p");
    expect((await request(b)).result.projectId).toBe("p");
    expect((await request(a, { token: b.token })).error).toContain("Invalid");
    expect(server.revoke(a.grant)).toBe(true);
    expect(server.revoke(a.grant)).toBe(false);
    expect((await request(a)).error).toContain("Invalid");
    expect((await request(b)).result.readOnly).toBe(true);
  });
  test("expiry is enforced on each request, exactly at its boundary, and attempt revocation is isolated", async () => {
    let tick = 1000;
    const { server, directory } = await socketFixture(() => tick);
    const expiring = server.grant(project(directory), {
      ttlMs: 10,
      subject: { attemptId: "a" },
    });
    const retained = server.grant(project(directory), {
      ttlMs: 100,
      subject: { attemptId: "b" },
    });
    tick = 1009;
    expect((await request(expiring)).result.subject.attemptId).toBe("a");
    tick = 1010;
    expect((await request(expiring)).error).toContain("Invalid");
    expect(server.revokeAttempt("a")).toBe(1);
    expect((await request(retained)).result.subject.attemptId).toBe("b");
    expect(server.revokeProject("p")).toBe(1);
    expect((await request(retained)).error).toContain("Invalid");
    expect(() => server.grant(project(directory), { ttlMs: 0 })).toThrow(
      "duration",
    );
    expect(() =>
      server.grant({ ...project(directory), trusted: false }),
    ).toThrow("trusted");
  });
  test("every retrieval route enforces allowlists/withholding before limiting and ignores client scope escalation", async () => {
    const { server, store, directory } = await socketFixture();
    store.message(message("permitted"));
    for (let i = 0; i < 120; i++)
      store.message(
        message(`peer-${i}`, {
          runId: "peer",
          text: "quartz WITHHELD_PEER_CONTENT",
        }),
      );
    store.message(
      message("other", { projectId: "q", text: "quartz OTHER_PROJECT" }),
    );
    const visibility: MessageVisibility = {
      conversationIds: ["c"],
      excludedRunIds: ["peer"],
    };
    const grant = server.grant(project(directory), { visibility });
    visibility.excludedRunIds = [];
    for (const method of ["history", "history-page", "search", "search-page"]) {
      const response = await request(grant, {
        method,
        query: "quartz",
        projectId: "q",
        visibility: {},
        limit: 1,
      });
      const items = response.result.items ?? response.result;
      expect(items.map((m: any) => m.id)).toEqual(["permitted"]);
      expect(JSON.stringify(response)).not.toContain("WITHHELD");
      expect(JSON.stringify(response)).not.toContain("OTHER_PROJECT");
    }
    expect((await request(grant, { method: "approval" })).error).toContain(
      "cannot execute",
    );
    expect((await request(grant)).result.filesystemIsolation).toBe(
      "not-enforced-by-context-service",
    );
    const denied = server.grant(project(directory), {
      visibility: { messageIds: [] },
    });
    expect(
      (await request(denied, { method: "history-page" })).result.items,
    ).toEqual([]);
  });
  test("one socket processes only one request and close discards every grant", async () => {
    const { server, directory } = await socketFixture();
    const grant = server.grant(project(directory));
    server.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.start();
    expect((await request(grant)).error).toContain("Invalid");
  });
});

describe("scoped cursor history", () => {
  test("old project history and search are complete beyond the global list window", async () => {
    const { store } = await setup();
    store.transaction(() => {
      for (let i = 0; i < 137; i++) store.message(message(`target-${i}`));
      for (let i = 0; i < 5100; i++)
        store.message(message(`noise-${i}`, { projectId: "other" }));
    });
    expect(
      store.list<Message>("message").every((m) => m.projectId === "other"),
    ).toBe(true);
    for (const method of ["history-page", "search-page"]) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: any = contextRequest(store, "p", {
          method,
          query: "quartz",
          cursor,
          limit: 25,
        });
        ids.push(...page.items.map((m: any) => m.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(ids).toEqual(
        Array.from({ length: 137 }, (_, i) => `target-${136 - i}`),
      );
    }
    expect([
      ...store.iterate<Message>("message", { projectId: "p" }),
    ]).toHaveLength(137);
    const handoff = previewHandoff(
      store,
      {
        id: "c",
        projectId: "p",
        title: "target",
        nativeSessions: {},
        createdAt: "now",
      },
      "claude",
      "review",
    );
    expect(handoff.sourceMessageIds).toEqual(
      Array.from({ length: 30 }, (_, i) => `target-${107 + i}`),
    );
  });
  test("role, project, conversation and visibility filters precede handoff selection", async () => {
    const { store } = await setup();
    store.message(message("included"));
    for (let i = 0; i < 50; i++) {
      store.message(message(`tool-${i}`, { role: "tool" }));
      store.message(message(`wrong-${i}`, { projectId: "wrong" }));
      store.message(message(`conversation-${i}`, { conversationId: "other" }));
    }
    const handoff = previewHandoff(
      store,
      {
        id: "c",
        projectId: "p",
        title: "test",
        nativeSessions: {},
        createdAt: "now",
      },
      "claude",
      "review",
      { messageIds: ["included"] },
    );
    expect(handoff.sourceMessageIds).toEqual(["included"]);
  });
  test("equal timestamps, concurrent inserts, updates and deleted highest positions cannot duplicate/shift pages", async () => {
    const { store } = await setup();
    for (let i = 0; i < 6; i++) store.message(message(`m${i}`));
    const first = store.messagesPage({
      projectId: "p",
      order: "asc",
      limit: 2,
    });
    store.message(message("new"));
    store.message(message("m0", { text: "edited" }));
    store.remove("message", "m5");
    store.message(message("later"));
    const ids = first.items.map((m) => m.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = store.messagesPage({
        projectId: "p",
        order: "asc",
        cursor,
        limit: 2,
      });
      ids.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(
      store.messagesPage({ projectId: "p" }).items.map((m) => m.id),
    ).toEqual(["later", "new", "m4", "m3", "m2", "m1", "m0"]);
  });
  test("cursor reuse across projects/search/policies/order fails and malformed sizes cannot expand retrieval", async () => {
    const { store } = await setup();
    for (let i = 0; i < 4; i++) store.message(message(`m${i}`));
    const cursor = store.messagesPage({ projectId: "p", limit: 1 }).nextCursor;
    for (const options of [
      { projectId: "q" },
      { projectId: "p", order: "asc" as const },
      { projectId: "p", visibility: { excludedMessageIds: ["m3"] } },
    ])
      expect(() => store.messagesPage({ ...options, cursor })).toThrow(
        "cursor",
      );
    expect(() => store.searchPage("p", "quartz", { cursor })).toThrow("cursor");
    expect(() =>
      store.messagesPage({ projectId: "p", cursor: "not-json" }),
    ).toThrow("cursor");
    expect(() => store.messagesPage({ projectId: "p", limit: 501 })).toThrow(
      "Page size",
    );
    expect(() =>
      store.messagesPage({ projectId: "p", visibility: [] as any }),
    ).toThrow("visibility");
    expect(() =>
      store.messagesPage({ projectId: "p", visibility: { typo: [] } as any }),
    ).toThrow("visibility");
    expect(() =>
      contextRequest(store, "p", { method: "history-page", limit: 51 }),
    ).toThrow("page size");
  });
  test("deleted conversation content stays absent from scoped indexes and search after reopening", async () => {
    const f = await setup();
    f.store.message(message("deleted"));
    f.store.message(message("kept", { conversationId: "keep" }));
    f.store.deleteConversation("c");
    f.store.close();
    f.store = new Store(path.join(f.directory, "history.sqlite"), f.key);
    expect(
      f.store.messagesPage({ projectId: "p" }).items.map((m) => m.id),
    ).toEqual(["kept"]);
    expect(f.store.searchPage("p", "quartz").items.map((m) => m.id)).toEqual([
      "kept",
    ]);
    f.store.message(message("resurrect"));
    expect(f.store.get("message", "resurrect")).toBeUndefined();
  });
  test("encrypted v1 records backfill into scoped indexes without changing content", async () => {
    const f = await setup();
    f.store.message(message("legacy"));
    f.store.db.exec(
      "DROP TRIGGER control_document_insert; DROP TRIGGER control_document_update; DROP TRIGGER control_document_delete; DROP TABLE control_changes; DROP TRIGGER document_insert; DROP TRIGGER document_update; DROP TRIGGER document_delete; DROP TABLE document_index; DROP TABLE coordinator_owners; DROP TABLE workspace_leases;",
    );
    for (const row of f.store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'coordination_%'",
      )
      .all())
      f.store.db.exec(`DROP INDEX ${row.name}`);
    f.store.remove("migration", "coordination-v3");
    f.store.remove("migration", "ordered-events-v4");
    f.store.db.exec("PRAGMA user_version=1;");
    f.store.close();
    f.store = new Store(path.join(f.directory, "history.sqlite"), f.key);
    expect(f.store.messagesPage({ projectId: "p" }).items[0]).toEqual(
      message("legacy"),
    );
    expect(
      f.store.db.prepare("PRAGMA integrity_check").get().integrity_check,
    ).toBe("ok");
    expect(
      (await readFile(path.join(f.directory, "history.sqlite"))).includes(
        Buffer.from("quartz"),
      ),
    ).toBe(false);
    const backupName = (await readdir(f.directory)).find((name) =>
      name.includes(".schema-1.backup-"),
    )!;
    expect(backupName).toBeTruthy();
    const backupPath = path.join(f.directory, backupName);
    expect((await readFile(backupPath)).includes(Buffer.from("quartz"))).toBe(
      false,
    );
    const backup = new Database(backupPath);
    try {
      backup.pragma("cipher='sqlcipher'");
      backup.pragma("legacy=4");
      backup.pragma(`key='${f.key}'`);
      expect(backup.prepare("PRAGMA user_version").get().user_version).toBe(1);
      expect(
        backup.prepare("PRAGMA integrity_check").get().integrity_check,
      ).toBe("ok");
      expect(
        JSON.parse(
          backup
            .prepare(
              "SELECT body FROM documents WHERE kind='message' AND id='legacy'",
            )
            .get().body,
        ),
      ).toEqual(message("legacy"));
    } finally {
      backup.close();
    }
  });
});
