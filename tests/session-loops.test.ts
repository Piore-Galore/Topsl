import path from "node:path";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { Service } from "../apps/service/service";
import { now, uid } from "../packages/domain/invariants";
import type { LoopRun } from "../packages/domain/recursive-loops";
import type { TopslSession } from "../packages/domain/sessions";
import { queuePositions } from "../apps/desktop/renderer/state/thread-view";
import { fixture, gitExecutable } from "./helpers";

/**
 * Loops inside a native session (docs/UX_Cleanup_Plan.md §4): Work →
 * Create loop, admission in queue order, session controls reaching loops,
 * removal stopping a draft, serialized admission and restart reconciliation.
 * No loop here runs an iteration; nothing is evidence for a provider.
 */

const services: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});

async function setup() {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  services.push({ service, directory: f.directory });
  const project = path.join(f.directory, "project");
  execFileSync("mkdir", ["-p", project]);
  await writeFile(path.join(project, "file.ts"), "export const value = 1;\n");
  for (const args of [
    ["init", "-q"],
    ["add", "file.ts"],
    [
      "-c",
      "user.email=f@example.test",
      "-c",
      "user.name=Fixture",
      "commit",
      "-qm",
      "base",
    ],
  ])
    execFileSync(gitExecutable, args, { cwd: project });
  service.store.put("project", {
    id: "p",
    name: "fixture",
    path: project,
    realPath: project,
    trusted: true,
    createdAt: now(),
  });
  await service.command({ type: "loop-feature-set", enabled: true });
  const { sessionId } = await service.command({
    type: "session-create",
    projectId: "p",
    kind: "code",
    commandId: `c-${uid()}`,
  });
  const create = async (text: string, conversationId = sessionId) =>
    (
      await service.command({
        type: "loop-create",
        projectId: "p",
        conversationId,
        mode: "goal",
        text,
        policy: { scheduling: { reserveForDirectWork: 0 } },
        commandId: `c-${uid()}`,
      })
    ).run.id as string;
  const start = (runId: string) =>
    service.command(
      { type: "loop-start", runId, commandId: `c-${uid()}` },
      {
        digest: (service.review("loop-authority", runId) as { digest: string })
          .digest,
      },
    );
  const control = (action: "pause" | "resume" | "stop") =>
    service.command({
      type: "session-control",
      sessionId,
      action,
      commandId: `c-${uid()}`,
    });
  const session = () =>
    service.store.get<TopslSession>("orch-session", sessionId)!;
  const run = (id: string) => service.store.get<LoopRun>("loop-run", id)!;
  const item = (runId: string) =>
    session().queue.find((w) => w.runId === runId)!;
  return { service, sessionId, create, start, control, session, run, item };
}

test("Work → Create loop queues drafts that start only in order, in a running session", async () => {
  const f = await setup();
  const a = await f.create("Change the value to two.");
  const b = await f.create("Change the value to three.");
  // Creating starts nothing: both are drafts awaiting start, in order.
  expect(f.session().queue.map((w) => [w.runId, w.kind, w.state])).toEqual([
    [a, "loop", "queued"],
    [b, "loop", "queued"],
  ]);
  expect(f.run(a).started).toBe(false);
  expect(queuePositions(f.session().queue)).toEqual({
    [f.item(a).id]: 1,
    [f.item(b).id]: 2,
  });
  await expect(f.start(b)).rejects.toThrow(
    "Earlier work in this session runs first",
  );
  await f.control("pause");
  await expect(f.start(a)).rejects.toThrow("session is paused");
  // Resume never starts an unreviewed draft.
  await f.control("resume");
  expect(f.run(a).started).toBe(false);
  await f.start(a);
  expect(f.run(a)).toMatchObject({ started: true, desiredState: "running" });
  expect(f.item(a).state).toBe("running");
  // The started loop is the session's running work, shown under Now in Work.
  expect(f.session().activeWorkId).toBe(f.item(a).id);
  await expect(f.start(b)).rejects.toThrow("already running a goal or loop");
  // Session controls reach the running loop.
  await f.control("pause");
  expect(f.run(a).desiredState).toBe("paused");
  await expect(
    f.service.command({
      type: "loop-control",
      runId: a,
      action: "resume",
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow("Resume the session");
  await f.control("resume");
  expect(f.run(a).desiredState).toBe("running");
  // Removing a queued loop stops its draft, so it cannot start later.
  await f.service.command({
    type: "session-queue",
    sessionId: f.sessionId,
    workItemId: f.item(b).id,
    action: "remove",
    commandId: `c-${uid()}`,
  });
  expect(f.item(b).state).toBe("cancelled");
  expect(f.run(b).desiredState).toBe("stopped");
  await expect(f.start(b)).rejects.toThrow();
  // Stopping the session stops the running loop and every queued draft.
  const c = await f.create("Change the value to four.");
  await f.control("stop");
  expect(f.run(a).desiredState).toBe("stopped");
  expect(f.run(c).desiredState).toBe("stopped");
  expect(f.item(c).state).toBe("cancelled");
});

test("a loop can only be created in a session of its own project", async () => {
  const f = await setup();
  f.service.store.put("project", {
    id: "q",
    name: "other",
    path: "/elsewhere",
    realPath: "/elsewhere",
    trusted: true,
    createdAt: now(),
  });
  await expect(
    f.service.command({
      type: "loop-create",
      projectId: "q",
      conversationId: f.sessionId,
      mode: "goal",
      text: "Elsewhere",
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow("another project");
});

test("admission is serialized per session: a start and a removal of one draft never both win", async () => {
  const f = await setup();
  const a = await f.create("Change the value to two.");
  const results = await Promise.allSettled([
    f.start(a),
    f.service.command({
      type: "session-queue",
      sessionId: f.sessionId,
      workItemId: f.item(a).id,
      action: "remove",
      commandId: `c-${uid()}`,
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const started = f.run(a).started;
  expect(f.item(a).state).toBe(started ? "running" : "cancelled");
  expect(f.run(a).desiredState).toBe(started ? "running" : "stopped");
  // The same command repeated acts once.
  const commandId = `c-${uid()}`;
  const pause = () =>
    f.service.command({
      type: "session-control",
      sessionId: f.sessionId,
      action: "pause",
      commandId,
    });
  const [first, second] = await Promise.all([pause(), pause()]);
  expect(second.controlGeneration).toBe(first.controlGeneration);
});

test("after a restart, interrupted removals and pauses are finished without replaying anything else", async () => {
  const f = await setup();
  const a = await f.create("Change the value to two.");
  const b = await f.create("Change the value to three.");
  await f.start(a);
  // The process stopped after recording these and before reaching the loops.
  const s = f.session();
  f.service.store.save("orch-session", {
    ...s,
    control: "paused",
    queue: s.queue.map((w) =>
      w.runId === b ? { ...w, state: "cancelled" as const } : w,
    ),
  });
  expect(f.run(a).desiredState).toBe("running");
  expect(f.run(b).desiredState).toBe("paused");
  await f.service.sessions.recover();
  await f.service.sessions.tick();
  expect(f.run(b).desiredState).toBe("stopped");
  expect(f.run(a).desiredState).toBe("paused");
  expect(f.run(b).started).toBe(false);
  // Another tick repeats nothing.
  const revision = f.run(a).revision;
  await f.service.sessions.tick();
  expect(f.run(a).revision).toBe(revision);
});
