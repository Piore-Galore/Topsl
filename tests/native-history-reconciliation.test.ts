import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import {
  appendFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { HistoryReconciler } from "../packages/history/reconcile";
import { Store } from "../packages/persistence/store";
import { contextRequest } from "../packages/workspace/context";
import { now } from "../packages/domain/invariants";
import type { Message } from "../packages/domain/types";
import type {
  NativeHistorySource,
  NativeMessageSource,
} from "../packages/domain/sync";
import { fixture } from "./helpers";
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const meta = (cwd: string) => ({
  type: "session_meta",
  payload: { id: "session", cwd },
});
const message = (
  id: string | null,
  text: string,
  timestamp = "2026-10-14T00:00:00Z",
) => ({
  type: "response_item",
  timestamp,
  payload: {
    type: "message",
    role: "assistant",
    ...(id ? { id } : {}),
    content: [{ type: "output_text", text }],
  },
});
const jsonl = (...records: unknown[]) =>
  records.map((value) => JSON.stringify(value)).join("\n") + "\n";
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  const project = {
    id: "p",
    name: "p",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  const file = path.join(f.directory, "native.jsonl");
  await writeFile(file, jsonl(meta(f.directory), message("one", "First")));
  const history = new HistoryReconciler(f.store),
    source = await history.approve({
      project,
      provider: "codex",
      profileId: "profile",
      sessionId: "session",
      file,
    });
  return { ...f, project, file, history, source };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
describe("authorized durable native reconciliation", () => {
  test("legacy explicit imports retain conversation/message/snapshot IDs and actual profiles stay separate", async () => {
    const f = await setup();
    const { hash } = await import("../packages/domain/invariants");
    const { importHistory } = await import("../packages/workspace/history");
    const legacyId = `import:codex:${hash("p:session")}`;
    f.store.put("conversation", {
      id: legacyId,
      projectId: "p",
      title: "Legacy",
      nativeSessions: {},
      createdAt: now(),
    });
    f.store.message({
      id: `${legacyId}:one`,
      projectId: "p",
      conversationId: legacyId,
      role: "assistant",
      provider: "codex",
      text: "First",
      runId: null,
      nativeId: "one",
      createdAt: "2026-10-14T00:00:00Z",
    });
    f.store.immutable("snapshot", {
      id: "old-snapshot",
      conversationId: legacyId,
      projectId: "p",
      sourceMessageIds: [`${legacyId}:one`],
    });
    const imported = await importHistory(f.store, f.project, "codex", f.file);
    expect(imported.conversationId).toBe(legacyId);
    expect(imported.imported).toBe(0);
    expect([...f.store.iterate("message")]).toHaveLength(1);
    await appendFile(f.file, jsonl(message("two", "Second")));
    expect(
      (await importHistory(f.store, f.project, "codex", f.file)).imported,
    ).toBe(1);
    expect(
      f.store.get<any>("snapshot", "old-snapshot").sourceMessageIds,
    ).toEqual([`${legacyId}:one`]);
    const actualProfile = await f.history.approve({
      project: f.project,
      provider: "codex",
      profileId: "verified-actual-profile",
      sessionId: "session",
      file: f.file,
    });
    expect(actualProfile.conversationId).not.toBe(legacyId);
    f.store.deleteConversation(legacyId);
    await expect(
      importHistory(f.store, f.project, "codex", f.file),
    ).rejects.toThrow("tombstones");
  });
  test("restart/replay has stable IDs and partial records never advance the durable cursor", async () => {
    const f = await setup(),
      first = await f.history.reconcile(f.source.id);
    expect(first.imported).toBe(1);
    const partial = JSON.stringify(message("two", "Second"));
    await appendFile(f.file, partial.slice(0, -7));
    const pending = await f.history.reconcile(f.source.id);
    expect(pending.source.cursor).toBe(first.source.cursor);
    expect(pending.source.state).toBe("partial");
    expect(pending.imported).toBe(0);
    f.store.close();
    f.store = new Store(path.join(f.directory, "history.sqlite"), f.key);
    fixtures[fixtures.length - 1].store = f.store;
    const restarted = new HistoryReconciler(f.store);
    await appendFile(f.file, partial.slice(-7) + "\n");
    const completed = await restarted.reconcile(f.source.id);
    expect(completed.imported).toBe(1);
    expect(completed.duplicates).toBe(1);
    expect(completed.source.state).toBe("current");
    expect((await restarted.reconcile(f.source.id)).imported).toBe(0);
    expect([...f.store.iterate("message", { projectId: "p" })]).toHaveLength(2);
    expect(
      f.store.get<any>("conversation", first.conversationId).nativeSessions,
    ).toEqual({});
  });
  test("malformed complete records and native-ID collisions retain cursor and rollback the batch", async () => {
    const f = await setup(),
      first = await f.history.reconcile(f.source.id);
    await appendFile(
      f.file,
      jsonl(message("two", "Should rollback"), message("one", "Collision")),
    );
    await expect(f.history.reconcile(f.source.id)).rejects.toThrow("collision");
    const failed = f.store.get<NativeHistorySource>(
      "native-history-source",
      f.source.id,
    )!;
    expect(failed.cursor).toBe(first.source.cursor);
    expect(failed.state).toBe("error");
    expect([...f.store.iterate("message")]).toHaveLength(1);
    await writeFile(
      f.file,
      jsonl(meta(f.directory), message("one", "First")) + "{invalid}\n",
    );
    await expect(f.history.reconcile(f.source.id)).rejects.toThrow(
      "Invalid complete",
    );
    expect(
      f.store.get<NativeHistorySource>("native-history-source", f.source.id)!
        .cursor,
    ).toBe(first.source.cursor);
  });
  test("rotation/truncation/rewrite coverage losses persist while replay remains deduplicated", async () => {
    const f = await setup();
    await f.history.reconcile(f.source.id);
    await rename(f.file, f.file + ".old");
    await writeFile(
      f.file,
      jsonl(
        meta(f.directory),
        message("one", "First"),
        message("two", "Second"),
      ),
    );
    const rotated = await f.history.reconcile(f.source.id);
    expect(rotated.imported).toBe(1);
    expect(rotated.source.coverageLosses[0].reason).toBe("rotation");
    expect(rotated.source.state).toBe("stale");
    await writeFile(f.file, jsonl(meta(f.directory)));
    const truncated = await f.history.reconcile(f.source.id);
    expect(truncated.source.coverageLosses.at(-1)?.reason).toBe("truncation");
    await writeFile(
      f.file,
      jsonl(meta(f.directory), message("three", "Third")),
    );
    const rewritten = await f.history.reconcile(f.source.id);
    expect(rewritten.source.coverageLosses).toHaveLength(2);
    expect([...f.store.iterate("message")]).toHaveLength(3);
    expect((await f.history.reconcile(f.source.id)).source.state).toBe("stale");
  });
  test("native causal order is recorded independently of backwards display timestamps", async () => {
    const f = await setup();
    await appendFile(
      f.file,
      jsonl(message("two", "Second", "2020-01-01T00:00:00Z")),
    );
    await f.history.reconcile(f.source.id);
    const messages = [
      ...f.store.iterate<Message & { source: NativeMessageSource }>("message"),
    ];
    expect(messages.map((message) => message.source.nativeOrder)).toEqual([
      1, 2,
    ]);
    expect(messages[1].createdAt < messages[0].createdAt).toBe(true);
    const response = contextRequest(f.store, "p", {
      method: "history",
    }) as Array<{ source: NativeMessageSource; omissions: unknown[] }>;
    expect(response[0].source.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(response[0].source.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  test("stable fallback identities preserve intentional repeated records and deduplicate exact replay", async () => {
    const f = await setup();
    await writeFile(
      f.file,
      jsonl(
        meta(f.directory),
        message(null, "Repeated"),
        message(null, "Repeated"),
      ),
    );
    expect((await f.history.reconcile(f.source.id)).imported).toBe(2);
    expect((await f.history.reconcile(f.source.id)).imported).toBe(0);
    expect(
      new Set(
        [...f.store.iterate<Message>("message")].map((message) => message.id),
      ).size,
    ).toBe(2);
  });
  test("deleted conversations cannot be resurrected after restart or explicit reapproval", async () => {
    const f = await setup(),
      first = await f.history.reconcile(f.source.id);
    f.store.deleteConversation(first.conversationId);
    await expect(f.history.reconcile(f.source.id)).rejects.toThrow("tombstone");
    await expect(
      f.history.approve({
        project: f.project,
        provider: "codex",
        profileId: "profile",
        sessionId: "session",
        file: f.file,
      }),
    ).rejects.toThrow("tombstones");
    expect([...f.store.iterate("message")]).toEqual([]);
    expect(
      f.store.get<NativeHistorySource>("native-history-source", f.source.id)
        ?.enabled,
    ).toBe(false);
  });
  test("approved path substitution, session changes and wrong roots are rejected", async () => {
    const f = await setup(),
      other = path.join(f.directory, "other.jsonl"),
      link = path.join(f.directory, "selected.jsonl");
    await writeFile(
      other,
      jsonl(meta(f.directory), message("one", "Different")),
    );
    await symlink(f.file, link);
    const linked = await f.history.approve({
      project: f.project,
      provider: "codex",
      profileId: "linked",
      sessionId: "session",
      file: link,
    });
    await unlink(link);
    await symlink(other, link);
    await expect(f.history.reconcile(linked.id)).rejects.toThrow(
      "path changed",
    );
    await expect(
      f.history.approve({
        project: f.project,
        provider: "codex",
        profileId: "profile",
        sessionId: "different",
        file: f.file,
      }),
    ).rejects.toThrow("session identity");
    await expect(
      f.history.approve({
        project: { ...f.project, realPath: "/different" },
        provider: "codex",
        profileId: "profile",
        sessionId: "session",
        file: f.file,
      }),
    ).rejects.toThrow("different project");
    await expect(
      f.history.approve({
        project: f.project,
        provider: "codex",
        profileId: "profile",
        sessionId: "session",
        file: f.directory,
      }),
    ).rejects.toThrow("JSONL");
  });
  test("profile provenance separates native sessions and paused or unknown parsers cannot read", async () => {
    const f = await setup();
    await f.history.reconcile(f.source.id);
    const other = await f.history.approve({
      project: f.project,
      provider: "codex",
      profileId: "other-profile",
      sessionId: "session",
      file: f.file,
    });
    await f.history.reconcile(other.id);
    expect(other.conversationId).not.toBe(f.source.conversationId);
    expect([...f.store.iterate("message")]).toHaveLength(2);
    const current = f.store.get<NativeHistorySource>(
      "native-history-source",
      other.id,
    )!;
    f.history.pause(other.id, current.revision);
    await expect(f.history.reconcile(other.id)).rejects.toThrow("paused");
    f.store.put("native-history-source", {
      ...f.source,
      enabled: true,
      parserVersion: "unknown",
    });
    await expect(f.history.reconcile(f.source.id)).rejects.toThrow(
      "parser version",
    );
  });
  test("Claude explicit records project only attributed text, with retrieval omission details", async () => {
    const f = await setup(),
      file = path.join(f.directory, "claude.jsonl");
    await writeFile(
      file,
      jsonl(
        {
          type: "user",
          sessionId: "claude-session",
          uuid: "c1",
          cwd: f.directory,
          message: { role: "user", content: "a".repeat(2500) },
        },
        {
          type: "assistant",
          sessionId: "claude-session",
          uuid: "c2",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Answer" },
              {
                type: "tool_use",
                name: "ignored",
                input: { private: "not imported" },
              },
            ],
          },
        },
      ),
    );
    const source = await f.history.approve({
      project: f.project,
      provider: "claude",
      profileId: "native-profile",
      sessionId: "claude-session",
      file,
    });
    expect((await f.history.reconcile(source.id)).imported).toBe(2);
    const response = contextRequest(f.store, "p", {
      method: "history",
    }) as Array<{ text: string; omissions: unknown[] }>;
    expect(response[1].text).toHaveLength(2000);
    expect(response[1].omissions).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain("not imported");
  });
});
