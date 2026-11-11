import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import { readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import Database from "better-sqlite3-multiple-ciphers";
import { Store } from "../packages/persistence/store";
import {
  migrateWithBackup,
  pruneMigrationBackups,
} from "../packages/persistence/migrations/backup";
import { hash, now } from "../packages/domain/invariants";
import { projectPath } from "../packages/platform/system";
import { contextRequest } from "../packages/workspace/context";
import { previewHandoff } from "../packages/workspace/history";
import { HistoryImports } from "../packages/workspace/imports";
import { Configuration } from "../packages/workspace/configuration";
import { fixture } from "./helpers";
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
function message(id: string, projectId = "p") {
  return {
    id,
    projectId,
    conversationId: "c",
    role: "user" as const,
    provider: "codex" as const,
    text: "PRIVATE_TOPSL_PHRASE quartz",
    runId: "r",
    nativeId: id,
    createdAt: now(),
  };
}
describe("protected durable history", () => {
  test("database and WAL do not expose plaintext; wrong key fails", async () => {
    const f = await setup();
    f.store.message(message("m"));
    const bytes = await readFile(path.join(f.directory, "history.sqlite"));
    const wal = await readFile(path.join(f.directory, "history.sqlite-wal"));
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(bytes.includes(Buffer.from("PRIVATE_TOPSL_PHRASE"))).toBe(false);
    expect(wal.includes(Buffer.from("PRIVATE_TOPSL_PHRASE"))).toBe(false);
    expect(
      () => new Store(path.join(f.directory, "history.sqlite"), "0".repeat(64)),
    ).toThrow();
  });
  test("a brand-new history database writes no migration backups", async () => {
    // Campaign 2026-11-04 W1-3: each schema step backed up an empty
    // database. Upgrades of existing files still back up
    // (tests/campaign-storage-authority.test.ts).
    const f = await setup();
    const { readdir } = await import("node:fs/promises");
    expect(
      (await readdir(f.directory)).filter((n) => n.includes(".backup-")),
    ).toEqual([]);
    const steps = f.store.list<{ from: number; backup: string | null }>(
      "migration",
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((m) => !m.backup)).toBe(true);
  });

  test("transaction rollback prevents partially committed commands", async () => {
    const { store } = await setup();
    expect(() =>
      store.transaction(() => {
        store.put("command", { id: "c" });
        throw new Error("crash");
      }),
    ).toThrow();
    expect(store.get("command", "c")).toBeUndefined();
  });
  test("immutable revision cannot be rewritten", async () => {
    const { store } = await setup();
    store.immutable("revision", { id: "r", version: 1 });
    expect(() =>
      store.immutable("revision", { id: "r", version: 2 }),
    ).toThrow();
  });
  test("an identical immutable rewrite with an undefined property is accepted", async () => {
    const { store } = await setup();
    const record = { id: "r", a: 1, opt: undefined };
    store.immutable("revision", record);
    expect(() => store.immutable("revision", record)).not.toThrow();
    expect(() =>
      store.immutable("revision", { id: "r", a: 2, opt: undefined }),
    ).toThrow("Immutable record collision.");
    expect(() =>
      store.immutable("revision", { id: "r", a: 1, opt: "set" }),
    ).toThrow("Immutable record collision.");
  });
  test("a successful open keeps the two newest migration backups", async () => {
    const f = await setup();
    const { readdir } = await import("node:fs/promises");
    const file = path.join(f.directory, "history.sqlite");
    const stamp = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const backup = (schema: number) =>
      `history.sqlite.schema-${schema}.backup-${stamp(schema)}`;
    const nearMisses = [
      "history.sqlite.schema-1.backup-not-a-stamp",
      `history.sqlite.schema-1.backup-${stamp(1)}.txt`,
      `history.sqlite.schema-x.backup-${stamp(1)}`,
      `other.sqlite.schema-1.backup-${stamp(1)}`,
    ];
    for (const name of [
      ...[3, 4, 5, 6].map(backup),
      `${backup(3)}-wal`,
      `${backup(3)}-shm`,
      ...nearMisses,
    ])
      await writeFile(path.join(f.directory, name), "x");
    // A failed open prunes nothing.
    expect(() => new Store(file, "0".repeat(64))).toThrow();
    expect(
      (await readdir(f.directory)).filter((n) => n.includes(".backup-")),
    ).toHaveLength(10);
    new Store(file, f.key).close();
    expect(
      (await readdir(f.directory)).filter((n) => n.includes(".backup-")).sort(),
    ).toEqual([backup(5), backup(6), ...nearMisses].sort());
  });
  test("each upgrade leaves its pre-upgrade backup; the last two upgrades are kept", async () => {
    const f = await setup();
    const { readdir } = await import("node:fs/promises");
    const file = path.join(f.directory, "upgraded.sqlite");
    const nearMiss = "upgraded.sqlite.schema-1.backup-not-a-stamp";
    await writeFile(path.join(f.directory, nearMiss), "x");
    // One launch: open at `from`, migrate one schema step at a time to `to`.
    // `failAt` makes the step from that schema throw after its backup.
    const launch = (from: number, to: number, prune = true, failAt = -1) => {
      const db = new Database(file);
      try {
        db.pragma("cipher='sqlcipher'");
        db.pragma("legacy=4");
        db.pragma(`key='${f.key}'`);
        if (from === 0) db.exec("CREATE TABLE t(x); PRAGMA user_version=1;");
        for (let v = Math.max(from, 1); v < to; v++)
          migrateWithBackup(db, file, f.key, v, v + 1, () => {
            if (v === failAt) throw new Error("step failed");
          });
        if (prune) pruneMigrationBackups(file, db);
      } finally {
        db.close();
      }
    };
    const schemas = async () =>
      (await readdir(f.directory))
        .filter((n) => n.startsWith("upgraded.sqlite.schema-"))
        .filter((n) => n !== nearMiss)
        .map((n) => Number(/schema-(\d+)/.exec(n)?.[1]))
        .sort((a, b) => a - b);
    launch(0, 1);
    // A multi-step upgrade keeps only the copy from before it.
    launch(1, 4);
    expect(await schemas()).toEqual([1]);
    launch(4, 6);
    expect(await schemas()).toEqual([1, 4]);
    // A launch that does not finish prunes nothing.
    launch(6, 8, false);
    expect(await schemas()).toEqual([1, 4, 6, 7]);
    // The next successful launch knows the unfinished one's backups as one
    // upgrade, so its intermediate step goes and its first copy counts once.
    launch(8, 10);
    expect(await schemas()).toEqual([6, 8]);
    // An upgrade that fails partway keeps every backup it wrote.
    expect(() => launch(10, 14, true, 12)).toThrow("step failed");
    expect(await schemas()).toEqual([6, 8, 10, 11, 12]);
    // Two successful upgrades later, only their pre-upgrade copies remain.
    launch(12, 14);
    expect(await schemas()).toEqual([10, 12]);
    launch(14, 16);
    expect(await schemas()).toEqual([12, 14]);
    const names = await readdir(f.directory);
    expect(names).toContain(nearMiss);
    const stamp = "[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}";
    for (const name of names.filter(
      (n) => n !== nearMiss && n.startsWith("upgraded.sqlite.schema-"),
    ))
      expect(name).toMatch(
        new RegExp(`\\.schema-\\d+\\.backup-${stamp}\\.upgrade-${stamp}$`),
      );
  });
  test("backups named before upgrade IDs each count as one upgrade", async () => {
    const f = await setup();
    const { readdir } = await import("node:fs/promises");
    const file = path.join(f.directory, "history.sqlite");
    const stamp = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const old = (schema: number) =>
      `history.sqlite.schema-${schema}.backup-${stamp(schema)}`;
    const grouped = (schema: number, upgrade: number) =>
      `${old(schema)}.upgrade-${stamp(upgrade)}`;
    const nearMisses = [
      `${old(4)}.upgrade-not-a-stamp`,
      `${grouped(4, 9)}.txt`,
      `${old(4)}.upgrade-${stamp(9)}.upgrade-${stamp(9)}`,
      `history.sqlite.schema-4.backup-.upgrade-${stamp(9)}`,
    ];
    for (const name of [
      old(2),
      old(3),
      ...[4, 5, 6].map((schema) => grouped(schema, 9)),
      `${grouped(5, 9)}-wal`,
      `${grouped(5, 9)}-shm`,
      ...nearMisses,
    ])
      await writeFile(path.join(f.directory, name), "x");
    new Store(file, f.key).close();
    expect(
      (await readdir(f.directory)).filter((n) => n.includes(".backup-")).sort(),
    ).toEqual([old(3), grouped(4, 9), ...nearMisses].sort());
  });
  test("search and MCP are confined to the grant project", async () => {
    const { store } = await setup();
    store.message(message("a", "project-a"));
    store.message(message("b", "project-b"));
    expect(store.search("project-a", "quartz").map((m) => m.id)).toEqual(["a"]);
    expect(
      contextRequest(store, "project-a", {
        method: "search",
        query: "quartz",
        projectId: "project-b",
      }),
    ).toHaveLength(1);
    expect(() =>
      contextRequest(store, "project-a", { method: "lifecycle-apply" }),
    ).toThrow("cannot execute");
  });
  test("newest-first reading has no cap and can stop early", async () => {
    const { store } = await setup();
    store.transaction(() => {
      for (let i = 0; i < 5002; i++) store.put("usage", { id: `u${i}`, n: i });
    });
    expect(store.list("usage")).toHaveLength(5000);
    const all = [...store.newestFirst<{ n: number }>("usage")];
    expect(all).toHaveLength(5002);
    expect(all[0].value.n).toBe(5001);
    expect(all.at(-1)!.value.n).toBe(0);
    expect(all[0].sequence).toBeGreaterThan(all[1].sequence);
    let read = 0;
    for (const { value } of store.newestFirst<{ n: number }>("usage")) {
      read++;
      if (value.n < 5000) break;
    }
    expect(read).toBe(3);
  });
  test("deletion removes derivatives and blocks accidental reimport", async () => {
    const { store } = await setup();
    store.message(message("m"));
    store.put("run", { id: "r", conversationId: "c" });
    store.put("usage", { id: "u", runId: "r" });
    store.put("snapshot", { id: "s", conversationId: "c" });
    store.event("run.changed", { id: "r", conversationId: "c" });
    store.event("run.changed", { id: "r" });
    store.event("tool.used", { id: "t", runId: "r" });
    store.put("run", { id: "kept", conversationId: "other" });
    store.put("usage", { id: "kept-usage", runId: "kept" });
    store.event("run.changed", { id: "kept" });
    store.event("tool.used", { id: "r", runId: "kept" });
    store.deleteConversation("c");
    const events = (path: string, value: string) =>
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM events WHERE json_extract(body,'${path}')=?`,
        )
        .get(value).count;
    expect(events("$.runId", "r")).toBe(0);
    // Only a run event is matched by its own id.
    expect(events("$.id", "r")).toBe(1);
    expect(events("$.id", "kept")).toBe(1);
    expect(events("$.runId", "kept")).toBe(1);
    expect(store.list("usage")).toEqual([{ id: "kept-usage", runId: "kept" }]);
    store.remove("usage", "kept-usage");
    store.remove("run", "kept");
    store.message(message("m"));
    expect(store.search("p", "quartz")).toHaveLength(0);
    expect(store.list("usage")).toHaveLength(0);
    expect(store.list("snapshot")).toHaveLength(0);
    expect(store.list("run")).toHaveLength(0);
  });
  test("handoffs preserve attribution and immutable content", async () => {
    const { store } = await setup();
    store.message(message("m"));
    const s = previewHandoff(
      store,
      {
        id: "c",
        projectId: "p",
        title: "Chat",
        nativeSessions: {},
        createdAt: now(),
      },
      "claude",
      "Review changes",
    );
    expect(s.text).toContain("user · codex");
    expect(s.provider).toBe("claude");
    expect(s.sourceMessageIds).toEqual(["m"]);
    store.message({ ...message("m"), text: "later edit" });
    expect(store.get<any>("snapshot", s.id).text).toContain(
      "PRIVATE_TOPSL_PHRASE",
    );
  });
  test("a query word with no letter or digit does not empty the search", async () => {
    const { store } = await setup();
    store.message({ ...message("m"), text: "error then retry" });
    for (const query of ["error -> retry", "error & retry"])
      expect(
        store.search("p", query).map((m) => m.id),
        query,
      ).toEqual(["m"]);
  });
  test("an import of the same content is stored once", async () => {
    const f = await setup();
    const file = path.join(f.directory, "session.jsonl");
    await writeFile(
      file,
      [
        { type: "session_meta", payload: { id: "native", cwd: f.directory } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "quartz answer" }],
          },
        },
      ]
        .map(JSON.stringify as any)
        .join("\n"),
    );
    const project = {
      id: "p",
      name: "p",
      path: f.directory,
      realPath: await import("node:fs/promises").then((fs) =>
        fs.realpath(f.directory),
      ),
      trusted: true,
      createdAt: now(),
    };
    f.store.put("project", project);
    const imports = new HistoryImports(f.store);
    const commit = async () => {
      const preview = await imports.preview({
        projectId: "p",
        provider: "codex",
        file,
      });
      return imports.commit({
        projectId: "p",
        previewId: preview.id,
        contentHash: preview.contentHash,
      });
    };
    expect((await commit()).duplicate).toBe(false);
    // The same content again keeps the first import.
    expect((await commit()).duplicate).toBe(true);
    // One message, and the session metadata kept as reference text.
    expect(
      f.store
        .list<any>("message")
        .map((m) => m.role)
        .sort(),
    ).toEqual(["assistant", "reference"]);
    expect(f.store.list("history-reference")).toHaveLength(1);
  });
});
describe("configuration ownership", () => {
  test("preview detects external writes and retains the original", async () => {
    const f = await setup();
    const real = await import("node:fs/promises").then((fs) =>
      fs.realpath(f.directory),
    );
    const p = {
      id: "p",
      name: "p",
      path: real,
      realPath: real,
      trusted: true,
      createdAt: now(),
    };
    const config = new Configuration(f.store, () => false);
    const before = await config.read("claude", p, "native");
    const plan = await config.preview(
      before.path,
      before.hash,
      '{"permissions":{}}',
    );
    await mkdir(path.dirname(before.path), { recursive: true });
    await writeFile(before.path, '{"external":true}');
    await expect(config.apply(plan.id, plan.digest)).rejects.toThrow(
      "changed after approval",
    );
    expect(await readFile(before.path, "utf8")).toBe('{"external":true}');
  });
  test("applies reviewed file once with encrypted backup and no native reload claim", async () => {
    const f = await setup();
    const config = new Configuration(f.store, () => false);
    const p = {
      id: "p",
      name: "p",
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    };
    const current = await config.read("codex", p, "instructions");
    const plan = await config.preview(
      current.path,
      current.hash,
      "Use scoped changes.",
    );
    await config.apply(plan.id, plan.digest);
    expect(await readFile(current.path, "utf8")).toBe("Use scoped changes.");
    expect(f.store.get<any>("configuration-write", plan.id).state).toBe(
      "written-unverified",
    );
    expect(f.store.get("configuration-backup", plan.id)).toBeTruthy();
    await expect(config.apply(plan.id, plan.digest)).rejects.toThrow(
      "new preview",
    );
  });
  test("rejects arbitrary path requests and invalid JSON", async () => {
    const f = await setup();
    const config = new Configuration(f.store, () => false);
    await expect(config.preview("/etc/passwd", "x", "oops")).rejects.toThrow(
      "Read this provider",
    );
    const current = await config.read(
      "claude",
      {
        id: "p",
        name: "p",
        path: f.directory,
        realPath: f.directory,
        trusted: true,
        createdAt: now(),
      },
      "native",
    );
    await expect(
      config.preview(current.path, current.hash, "{oops"),
    ).rejects.toThrow();
  });
  test("project path rejects traversal and symlink escapes", async () => {
    const f = await setup();
    await expect(projectPath(f.directory, "../secret")).rejects.toThrow(
      "escapes",
    );
    const outside = path.dirname(f.directory);
    const link = path.join(f.directory, "link");
    await symlink(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(projectPath(f.directory, "link")).rejects.toThrow("escapes");
  });
  test("a crash after file replacement reconciles without replaying configuration", async () => {
    const f = await setup();
    const file = path.join(f.directory, "AGENTS.md");
    f.store.put("configuration-plan", {
      id: "interrupted",
      expectedHash: hash("before"),
    });
    f.store.put("configuration-write", {
      id: "interrupted",
      path: file,
      targetHash: hash("after"),
      state: "applying",
    });
    await writeFile(file, "after");
    const configuration = new Configuration(f.store, () => false);
    await configuration.reconcile();
    expect(f.store.get<any>("configuration-write", "interrupted").state).toBe(
      "written-unverified",
    );
    expect(await readFile(file, "utf8")).toBe("after");
  });
});
