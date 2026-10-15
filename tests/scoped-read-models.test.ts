import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { Service } from "../apps/service/service";
import { now } from "../packages/domain/invariants";
import { fixture } from "./helpers";

const opened: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const { service, directory } of opened.splice(0)) {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  opened.push({ service, directory: f.directory });
  const project = {
    id: "scoped-project",
    name: "Snapshot fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  };
  service.store.put("project", project);
  return { ...f, service, project };
}

test("R2-AT-31/33: scoped slices carry committed watermarks and synchronization shares the snapshot", async () => {
  const { service, project } = await setup();
  const first = await service.command({
    type: "scope-snapshot",
    projectId: project.id,
  });
  expect(first.observation).toMatchObject({
    projectId: project.id,
    epoch: first.epoch,
    sequence: first.sequence,
  });
  expect(Number.isFinite(Date.parse(first.observation.generatedAt))).toBe(true);
  expect(first.synchronization.projectId).toBe(project.id);
  expect(first.synchronization.inputs).toEqual([]);

  const workspace = service.coordinator.repository.ensureWorkspace(project);
  const task = service.coordinator.repository.createTask({
    projectId: project.id,
    workspaceId: workspace.id,
    title: "Inspect the current revision",
    role: "implementer",
    workflowId: null,
    conversationId: null,
    acceptanceCriteria: ["Keep observations scoped"],
  });
  const second = await service.command({
    type: "scope-snapshot",
    projectId: project.id,
  });
  expect(second.observation.epoch).toBe(first.observation.epoch);
  expect(second.observation.sequence).toBeGreaterThan(
    first.observation.sequence,
  );
  expect(
    second.coordination.tasks.some(
      (value: { id: string }) => value.id === task.id,
    ),
  ).toBe(true);
  expect(
    second.synchronization.inputs.some(
      (value: { taskId: string }) => value.taskId === task.id,
    ),
  ).toBe(true);

  for (const type of [
    "synchronization-query",
    "builder-reviewer-query",
  ] as const) {
    const slice = await service.command({ type, projectId: project.id });
    expect(slice.observation).toMatchObject({
      projectId: project.id,
      epoch: second.observation.epoch,
      sequence: service.store.controlHead(),
    });
  }
  const inspected = await service.command({
    type: "task-inspect",
    projectId: project.id,
    id: task.id,
  });
  expect(inspected.observation.sequence).toBe(service.store.controlHead());
  expect(inspected.task.id).toBe(task.id);
  await expect(
    service.command({
      type: "task-inspect",
      projectId: "other-project",
      id: task.id,
    }),
  ).rejects.toThrow("another project");
});
