import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { Service } from "../apps/service/service";
import { fixture } from "./helpers";
import {
  projectDestinations,
  projectSection,
  projectView,
  retiredProjectViews,
} from "../packages/domain/navigation";
import { now } from "../packages/domain/invariants";

const opened: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.service.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});
async function service() {
  const f = await fixture();
  f.store.close();
  const value = new Service(f.directory, f.key, () => {}, true);
  opened.push({ service: value, directory: f.directory });
  await value.start();
  return { service: value, directory: f.directory };
}
function project(service: Service, id: string, directory: string) {
  service.store.put("project", {
    id,
    name: id,
    path: directory,
    realPath: directory,
    trusted: true,
    createdAt: now(),
  });
}
/** A session listed in the sidebar: it holds the owner's first message. */
async function session(service: Service, projectId: string, text: string) {
  const created = await service.command({
    type: "session-create",
    kind: "code",
    projectId,
    text,
    commandId: `create-${projectId}-${text}`,
  });
  return `session:${created.sessionId}`;
}

test("saved destinations from before the cleanup open their replacement sections", async () => {
  const { service: s } = await service();
  for (const view of projectDestinations) {
    await s.command({
      type: "navigation-save",
      projectId: "project",
      workflowId: "workflow",
      projectView: view,
    });
    expect(await s.command({ type: "navigation-query" })).toMatchObject({
      projectId: "project",
      workflowId: "workflow",
      projectView: view,
      section: null,
    });
  }
  for (const view of retiredProjectViews) {
    s.store.put("preference", {
      id: "navigation",
      projectId: "project",
      workflowId: "workflow",
      projectView: view,
    });
    expect(await s.command({ type: "navigation-query" })).toMatchObject({
      projectView: projectView(view),
      section: projectSection(view),
    });
  }
  expect(projectView("overview")).toBe("advanced");
  expect(projectSection("tasks")).toBe("workflows");
  expect(projectView("history")).toBe("sessions");
  expect(projectView("synchronization")).toBe("project-settings");
  expect(projectSection("synchronization")).toBe("synchronization-retired");
  await s.command({
    type: "navigation-save",
    projectId: "other",
    workflowId: null,
    projectView: "advanced",
  });
  expect(await s.command({ type: "navigation-query" })).toMatchObject({
    workflowId: null,
  });
  s.store.put("preference", {
    id: "navigation",
    projectId: "project",
    workflowId: "workflow",
    projectView: "retired-view",
  });
  expect(await s.command({ type: "navigation-query" })).toMatchObject({
    projectView: "coordinator",
    workflowId: "workflow",
  });
});

test("the open coordinator thread is restored; older records and malformed values read as none", async () => {
  const { service: s } = await service();
  s.store.put("preference", {
    id: "navigation",
    projectId: "project",
    workflowId: null,
    projectView: "coordinator",
  });
  expect(await s.command({ type: "navigation-query" })).toMatchObject({
    threadId: null,
  });
  await s.command({
    type: "navigation-save",
    projectId: "project",
    workflowId: null,
    projectView: "coordinator",
    threadId: "loop:run-1",
  });
  expect(await s.command({ type: "navigation-query" })).toMatchObject({
    projectView: "coordinator",
    threadId: "loop:run-1",
  });
  s.store.put("preference", {
    id: "navigation",
    projectId: "project",
    workflowId: null,
    projectView: "coordinator",
    threadId: "not-a-thread",
  });
  expect(await s.command({ type: "navigation-query" })).toMatchObject({
    threadId: null,
  });
});

test("a project opens at its last viewed session, else its newest, else New session", async () => {
  const { service: s, directory } = await service();
  project(s, "a", directory);
  project(s, "b", directory);
  const resume = async (projectId: string) =>
    (await s.command({ type: "navigation-query", projectId })).threadId;
  expect(await resume("a")).toBeNull();
  const first = await session(s, "a", "First question");
  const second = await session(s, "a", "Second question");
  const other = await session(s, "b", "Elsewhere");
  // Newest first when nothing was viewed.
  expect(await resume("a")).toBe(second);
  const save = (projectId: string, projectView: any, threadId: string | null) =>
    s.command({
      type: "navigation-save",
      projectId,
      workflowId: null,
      projectView,
      threadId,
    });
  await save("a", "coordinator", first);
  expect(await resume("a")).toBe(first);
  // Tools and the New session page leave the remembered session alone.
  await save("a", "advanced", null);
  await save("a", "coordinator", null);
  await save("a", "all-sessions", null);
  expect(await resume("a")).toBe(first);
  // Each project keeps its own; another project's thread is never remembered.
  await save("b", "coordinator", other);
  await save("a", "coordinator", other);
  expect(await resume("a")).toBe(first);
  expect(await resume("b")).toBe(other);
  // A remembered goal ID from before sessions opens its session.
  await save("a", "coordinator", first.replace("session:", "goal:"));
  expect(await resume("a")).toBe(first);
  // The global restart location is unchanged by per-project memory.
  expect(await s.command({ type: "navigation-query" })).toMatchObject({
    projectId: "a",
    projectView: "coordinator",
  });
  await expect(
    s.command({ type: "navigation-query", projectId: "missing" }),
  ).rejects.toThrow();
});

test("All sessions pages past 200 sessions and searches titles", async () => {
  const { service: s, directory } = await service();
  project(s, "p", directory);
  for (let i = 0; i < 205; i++)
    await session(s, "p", `Topic ${String(i).padStart(3, "0")}`);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: any = await s.command({
      type: "project-threads-page",
      projectId: "p",
      cursor,
      limit: 100,
    });
    expect(page.total).toBe(205);
    seen.push(...page.threads.map((t: any) => t.title));
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(new Set(seen).size).toBe(205);
  const found: any = await s.command({
    type: "project-threads-page",
    projectId: "p",
    query: "topic 004",
    limit: 50,
  });
  expect(found.threads.map((t: any) => t.title)).toEqual(["Topic 004"]);
  // The sidebar's batch stays bounded, with the total and attention counts.
  const [sidebar]: any = await s.command({
    type: "coordinator-threads",
    projectIds: ["p"],
    limit: 8,
  });
  expect(sidebar.total).toBe(205);
  // Every session here waits on the owner (no coordinator can answer): the
  // count covers all of them, while the list stays bounded.
  expect(sidebar.needsYou).toBe(205);
  expect(sidebar.threads).toHaveLength(16);
}, 120_000);
