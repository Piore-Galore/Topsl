import { afterEach, expect, test, vi } from "vitest";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Service } from "../apps/service/service";
import {
  BuilderReviewerWorkflow,
  type WorkflowDriver,
  type BuilderReviewerState,
} from "../packages/workflows/builder-reviewer";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import { RevisionRepository } from "../packages/context/revisions";
import type {
  ExecutionAttempt,
  Task,
  Workflow,
} from "../packages/domain/workflow";
import { now, uid } from "../packages/domain/invariants";
import { fixture } from "./helpers";
const fixtures: Array<
  Awaited<ReturnType<typeof fixture>> & { service?: Service }
> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.service?.close();
    try {
      f.store.close();
    } catch {}
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup(
  mode: "completed" | "active" | "uncertain" = "completed",
  interrupt = true,
) {
  const f = await fixture();
  fixtures.push(f);
  await writeFile(path.join(f.directory, "file.ts"), "original");
  const project = {
    id: "p",
    name: "project",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  const repository = new CoordinationRepository(f.store),
    revisions = new RevisionRepository(f.store),
    results = new Map<string, string>();
  let dispatches = 0,
    interrupts = 0;
  const driver: WorkflowDriver = {
    capabilities: () => ({ supported: true, detail: "Fixture only" }),
    result: (attempt) => results.get(attempt.id) ?? "",
    async dispatch(input) {
      dispatches++;
      let attempt = repository.transitionAttempt(
        input.attempt.id,
        input.attempt.revision,
        "starting",
      );
      attempt = repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "running",
      );
      if (mode === "uncertain") {
        repository.transitionAttempt(attempt.id, attempt.revision, "uncertain");
        return;
      }
      if (mode === "active") return;
      if (input.mode === "edit")
        await writeFile(path.join(f.directory, "file.ts"), "updated");
      else
        results.set(
          attempt.id,
          JSON.stringify({
            candidateRevision: input.context.candidateRevision,
            summary: "reviewed",
            findings: [],
          }),
        );
      repository.transitionAttempt(attempt.id, attempt.revision, "completed");
      const task = repository.require<Task>("task", input.task.id);
      repository.transitionTask(task.id, task.revision, "submitted");
    },
    ...(interrupt
      ? {
          async interrupt(attempt: ExecutionAttempt) {
            interrupts++;
            repository.transitionAttempt(
              attempt.id,
              attempt.revision,
              "interrupted",
            );
          },
        }
      : {}),
  };
  const engine = new BuilderReviewerWorkflow(repository, driver),
    state = await engine.create(project, {
      objective: "old requirements",
      acceptanceCriteria: ["old criterion"],
      interfaces: [],
      selectedPaths: ["file.ts"],
      builder: {
        provider: "codex",
        installationId: f.installation.id,
        model: "fixture",
      },
      reviewer: {
        provider: "codex",
        installationId: f.installation.id,
        model: "fixture",
      },
      checks: [
        {
          id: "check",
          label: "fixture",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 30_000,
        },
      ],
    });
  const revision = () =>
    repository.require<Workflow>("workflow", state.id).revision;
  const advance = () => engine.advance(state.id, revision());
  const publish = () =>
    engine.publishSpecification(state.id, revision(), {
      objective: "new requirements",
      acceptanceCriteria: ["new criterion"],
      interfaces: ["new interface"],
    });
  return {
    ...f,
    project,
    repository,
    revisions,
    engine,
    state,
    revision,
    advance,
    publish,
    dispatches: () => dispatches,
    interrupts: () => interrupts,
  };
}
test("specification updates flag a running attempt and restart creates a fresh task without editing old packages", async () => {
  const f = await setup("active");
  await f.advance();
  const before = f.repository.all<ExecutionAttempt>("attempt")[0],
    oldPackage = f.store.get("context-package", before.contextPackageId!);
  const spec = f.publish();
  expect(f.revisions.inspectTaskInputs(before.taskId).stale[0].blocking).toBe(
    true,
  );
  const restarted = await f.engine.restartForSpecification(
    f.state.id,
    f.revision(),
    spec.id,
  );
  expect(restarted.stage).toBe("ready-build");
  expect(f.interrupts()).toBe(1);
  expect(f.dispatches()).toBe(1);
  expect(restarted.builderTaskId).not.toBe(before.taskId);
  expect(f.store.get("context-package", before.contextPackageId!)).toEqual(
    oldPackage,
  );
  expect(
    f.repository.require<ExecutionAttempt>("attempt", before.id)
      .contextPackageId,
  ).toBe(before.contextPackageId);
  expect(f.repository.require<Task>("task", before.taskId).state).toBe(
    "cancelled",
  );
  expect(
    f.store.get<any>("task-supersession", before.taskId).replacementTaskId,
  ).toBe(restarted.builderTaskId);
  await f.advance();
  const next = f.repository.all<ExecutionAttempt>("attempt").at(-1)!;
  expect(next.specificationRevision).toBe(spec.revision);
  expect(next.id).not.toBe(before.id);
});
test("unknown execution or an unsupported stop route cannot trigger a replacement", async () => {
  const f = await setup("uncertain");
  await f.advance();
  const spec = f.publish();
  await expect(
    f.engine.restartForSpecification(f.state.id, f.revision(), spec.id),
  ).rejects.toThrow("uncertain");
  expect(f.dispatches()).toBe(1);
  const g = await setup("active", false);
  await g.advance();
  const next = g.publish();
  await expect(
    g.engine.restartForSpecification(g.state.id, g.revision(), next.id),
  ).rejects.toThrow("no supported interruption");
  expect(g.dispatches()).toBe(1);
});
test("new specifications block downstream dispatch and final acceptance even when old checks passed", async () => {
  const f = await setup();
  await f.advance();
  f.publish();
  expect((await f.advance()).stage).toBe("blocked");
  expect(f.dispatches()).toBe(1);
  const g = await setup();
  await g.advance();
  await g.advance();
  await g.advance();
  const plan = (await g.engine.previewChecks(g.state.id, g.revision()))[0];
  await g.engine.runCheck(plan.id, plan.digest);
  g.publish();
  await expect(
    g.engine.accept(
      g.state.id,
      g.revision(),
      g.engine.acceptanceDigest(g.state.id),
    ),
  ).rejects.toThrow("newer shared specification");
});
test("shared decisions are mandatory package inputs and blocking edits invalidate task dispatch", async () => {
  const f = await setup();
  const first = f.revisions.publish({
    projectId: "p",
    recordId: "decision",
    kind: "decision",
    title: "Interface",
    content: "Approved contract v1",
    impact: "dispatch-blocking",
    expectedHeadId: null,
  });
  await f.advance();
  const attempt = f.repository.all<ExecutionAttempt>("attempt")[0],
    context = f.store.get<any>(
      "task-context-package",
      attempt.contextPackageId!,
    )!;
  expect(context.content).toContain("Approved contract v1");
  expect(
    context.sources.some((source: { id: string }) => source.id === first.id),
  ).toBe(true);
  f.revisions.publish({
    projectId: "p",
    recordId: "decision",
    kind: "decision",
    title: "Interface",
    content: "Approved contract v2",
    impact: "dispatch-blocking",
    expectedHeadId: first.id,
  });
  expect(() => f.revisions.assertTaskInputsCurrent(attempt.taskId)).toThrow(
    "stale",
  );
  expect(
    f.revisions
      .inspectTaskInputs(attempt.taskId)
      .stale.some((ref) => ref.recordId === "decision"),
  ).toBe(true);
});
test("explicit folder relink keeps historical workspace identity and selects a new approved default", async () => {
  const f = await setup();
  const original = f.repository.ensureWorkspace(f.project),
    oldTask = f.repository.require<Task>("task", f.state.builderTaskId);
  const newRoot = path.join(f.directory, "new-root");
  await mkdir(newRoot);
  const relinked = { ...f.project, path: newRoot, realPath: newRoot };
  f.store.put("project", relinked);
  const newWorkspace = f.repository.relinkDefaultWorkspace(relinked);
  expect(newWorkspace.id).not.toBe(original.id);
  expect(f.repository.ensureWorkspace(relinked).id).toBe(newWorkspace.id);
  expect(f.repository.require<Task>("task", oldTask.id).workspaceId).toBe(
    original.id,
  );
  expect(
    f.repository.require<any>("workspace", original.id).canonicalRoot,
  ).toBe(f.directory);
});
test("scoped service routes enforce exact revisions and known configuration evidence", async () => {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  fixtures.push({ ...f, service });
  service.store.put("project", {
    id: "p",
    name: "project",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  });
  const instructions = await service.command({
    type: "configuration-read",
    projectId: "p",
    provider: "codex",
    kind: "instructions",
  });
  const config = (
    await service.command({ type: "synchronization-query", projectId: "p" })
  ).configuration;
  expect(config[0]).toMatchObject({
    stage: "discovered",
    sourceHash: instructions.hash,
  });
  expect(
    config.some((record: { stage: string }) => record.stage === "effective"),
  ).toBe(false);
  const head = await service.command({
    type: "shared-revision-publish",
    requestId: uid(),
    projectId: "p",
    recordId: "decision",
    kind: "decision",
    title: "decision",
    content: "approved",
    impact: "advisory",
    expectedHeadId: null,
  });
  expect(head.contentHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    service.command({ type: "synchronization-query", projectId: "missing" }),
  ).rejects.toThrow("project");
});

test("project relink and default workspace mapping roll back together if a writer starts during folder review", async () => {
  const f = await setup("active");
  await f.advance();
  const { ProjectCatalog } = await import("../packages/workspace/projects");
  const catalog = new ProjectCatalog(f.store, () => {}),
    newRoot = path.join(f.directory, "relink-root");
  await mkdir(newRoot);
  await expect(
    catalog.relink("p", newRoot, (updated: any) =>
      f.repository.relinkDefaultWorkspace(updated),
    ),
  ).rejects.toThrow("prior project attempts");
  expect(f.store.get<any>("project", "p").realPath).toBe(f.directory);
  expect(f.repository.all("project-default-workspace")).toEqual([]);
});
