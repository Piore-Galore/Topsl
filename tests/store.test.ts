import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import { readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { Store } from "../packages/persistence/store";
import { hash, now } from "../packages/domain/invariants";
import { projectPath } from "../packages/platform/system";
import { contextRequest } from "../packages/workspace/context";
import { importHistory, previewHandoff } from "../packages/workspace/history";
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
  test("deletion removes derivatives and blocks accidental reimport", async () => {
    const { store } = await setup();
    store.message(message("m"));
    store.put("run", { id: "r", conversationId: "c" });
    store.put("usage", { id: "u", runId: "r" });
    store.put("snapshot", { id: "s", conversationId: "c" });
    store.event("run.changed", { id: "r", conversationId: "c" });
    store.deleteConversation("c");
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
  test("imports are idempotent and reject a different project", async () => {
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
    await importHistory(f.store, project, "codex", file);
    await importHistory(f.store, project, "codex", file);
    expect(f.store.list("message")).toHaveLength(1);
    await expect(
      importHistory(
        f.store,
        { ...project, realPath: "/elsewhere" },
        "codex",
        file,
      ),
    ).rejects.toThrow("different project");
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
