import { afterEach, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { Service } from "../apps/service/service";
import { fixture } from "./helpers";
const opened: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.service.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});
test("stream updates emit bounded metadata and scoped previews, never bulk global history snapshots", async () => {
  const f = await fixture();
  f.store.close();
  const events: any[] = [];
  const service = new Service(
    f.directory,
    f.key,
    (event) => events.push(event),
    true,
  );
  opened.push({ service, directory: f.directory });
  await service.start();
  service.store.put("project", {
    id: "project",
    name: "Scoped fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: new Date().toISOString(),
  });
  (service as any).changed(true);
  await vi.waitFor(() =>
    expect(
      events.filter((event) => event.type === "changes").at(-1)?.data
        .throughSequence,
    ).toBe(service.store.controlHead()),
  );
  events.length = 0;
  service.store.message({
    id: "long",
    projectId: "project",
    conversationId: "conversation",
    role: "assistant",
    provider: "codex",
    runId: "run",
    nativeId: "native",
    text: "x".repeat(60000),
    createdAt: new Date().toISOString(),
  });
  (service as any).changed();
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "changes")).toBe(true),
  );
  expect(events.some((event) => event.type === "state")).toBe(false);
  expect(JSON.stringify(events)).not.toContain("x".repeat(100));
  const snapshot = await service.command({
    type: "scope-snapshot",
    projectId: "project",
  });
  expect(snapshot.messages.items[0]).toMatchObject({
    truncated: true,
    totalChars: 60000,
  });
  expect(snapshot.messages.items[0].text).toHaveLength(6000);
  expect(snapshot.epoch).toBeTruthy();
  expect(snapshot.sequence).toBe(service.store.controlHead());
  const chunk = await service.command({
    type: "history-message",
    projectId: "project",
    id: "long",
    offset: 6000,
    limit: 20000,
  });
  expect(chunk.text).toHaveLength(20000);
  expect(chunk.nextOffset).toBe(26000);
  await expect(
    service.command({
      type: "history-message",
      projectId: "another",
      id: "long",
      offset: 0,
      limit: 20000,
    }),
  ).rejects.toThrow("another project");
  service.store.put("run", {
    id: "run",
    projectId: "project",
    conversationId: "conversation",
    status: "running",
  });
  (service as any).changed();
  await vi.waitFor(() =>
    expect(
      events.some((event) => event.type === "activity" && event.data.active),
    ).toBe(true),
  );
  expect(events.some((event) => event.type === "state")).toBe(false);
  await service.command({ type: "theme", theme: "night" });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "state")).toBe(true),
  );
  const catalog = events.filter((event) => event.type === "state").at(-1).data;
  expect(catalog.messages).toEqual([]);
  expect(catalog.runs).toEqual([]);
  expect(catalog.usage).toEqual([]);
  expect(catalog.approvals).toEqual([]);
  expect(catalog.conversations).toEqual([]);
});
