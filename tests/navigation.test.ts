import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { Service } from "../apps/service/service";
import { fixture } from "./helpers";
import { projectViews } from "../packages/domain/navigation";

const opened: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.service.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});

test("project navigation retains old destinations and accepts Sessions and Coordinator without a migration", async () => {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  opened.push({ service, directory: f.directory });
  await service.start();
  for (const view of projectViews) {
    await service.command({
      type: "navigation-save",
      projectId: "project",
      workflowId: "workflow",
      projectView: view,
    });
    expect(await service.command({ type: "navigation-query" })).toMatchObject({
      projectId: "project",
      workflowId: "workflow",
      projectView: view,
    });
  }
  await service.command({
    type: "navigation-save",
    projectId: "project",
    workflowId: null,
    projectView: "sessions",
  });
  expect(await service.command({ type: "navigation-query" })).toMatchObject({
    workflowId: "workflow",
    projectView: "sessions",
  });
  await service.command({
    type: "navigation-save",
    projectId: "other",
    workflowId: null,
    projectView: "overview",
  });
  expect(await service.command({ type: "navigation-query" })).toMatchObject({
    workflowId: null,
  });
  service.store.put("preference", {
    id: "navigation",
    projectId: "project",
    workflowId: "workflow",
    projectView: "retired-view",
  });
  expect(await service.command({ type: "navigation-query" })).toMatchObject({
    projectView: "overview",
    workflowId: "workflow",
  });
});

test("the open coordinator thread is restored; older records and malformed values read as none", async () => {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  opened.push({ service, directory: f.directory });
  await service.start();
  service.store.put("preference", {
    id: "navigation",
    projectId: "project",
    workflowId: null,
    projectView: "coordinator",
  });
  expect(await service.command({ type: "navigation-query" })).toMatchObject({
    threadId: null,
  });
  await service.command({
    type: "navigation-save",
    projectId: "project",
    workflowId: null,
    projectView: "coordinator",
    threadId: "loop:run-1",
  });
  expect(await service.command({ type: "navigation-query" })).toMatchObject({
    projectView: "coordinator",
    threadId: "loop:run-1",
  });
  service.store.put("preference", {
    id: "navigation",
    projectId: "project",
    workflowId: null,
    projectView: "coordinator",
    threadId: "not-a-thread",
  });
  expect(await service.command({ type: "navigation-query" })).toMatchObject({
    threadId: null,
  });
});
