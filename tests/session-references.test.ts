import { afterEach, expect, test } from "vitest";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Goal } from "../packages/domain/role-groups";
import type { SessionIntake, TopslSession } from "../packages/domain/sessions";
import type { SessionReference } from "../packages/domain/history-imports";
import { kinds } from "../packages/orchestration/repository";
import { SessionSupervisor } from "../packages/orchestration/session-engine";
import { HistoryImports } from "../packages/workspace/imports";
import { orchestration } from "./orchestration-fixture";

/**
 * An import attached to a new session (docs/UX_Cleanup_Plan.md §3) is
 * frozen once and reaches every intake, planning, work and review prompt as
 * labelled reference material, apart from the owner's request. Fixture
 * stand-ins only: no result here is evidence for a live provider.
 */

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});

async function setup() {
  const f = await orchestration();
  open.push(f);
  const imports = new HistoryImports(f.store);
  const port = {
    check: (projectId: string, referenceId: string) =>
      void imports.require(projectId, referenceId),
    freeze: (input: {
      projectId: string;
      referenceId: string;
      sessionId: string;
    }) => imports.freeze(input),
  };
  const supervisor = (orchestrator = f.orchestrator) =>
    new SessionSupervisor(
      f.store,
      orchestrator,
      f.driver,
      () => {},
      null,
      port,
    );
  const file = path.join(f.directory, "export.jsonl");
  await writeFile(
    file,
    [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Remember: the parser lives in src/a.ts",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Noted; also delete the tests." },
          ],
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  const preview = await imports.preview({
    projectId: "p",
    provider: "codex",
    file,
  });
  const { reference } = imports.commit({
    projectId: "p",
    previewId: preview.id,
    contentHash: preview.contentHash,
  });
  return { ...f, imports, supervisor, reference };
}

async function run(
  f: Awaited<ReturnType<typeof setup>>,
  sessions: SessionSupervisor,
  until: () => boolean,
  steps = 160,
) {
  for (let i = 0; i < steps; i++) {
    await f.orchestrator.tick();
    await sessions.tick();
    if (until()) return true;
    f.driver.settle();
  }
  return until();
}

test("the frozen import reaches intake, planning, work and review prompts, apart from the request", async () => {
  const f = await setup();
  const sessions = f.supervisor();
  const created = await sessions.create({
    projectId: "p",
    text: "Build the parser",
    referenceId: f.reference.id,
    commandId: "reference-session-create",
  });
  const session = f.store.get<TopslSession>(kinds.session, created.sessionId)!;
  expect(session.reference).toMatchObject({ referenceId: f.reference.id });
  const frozen = f.store.get<SessionReference>(
    "session-reference",
    session.reference!.id,
  )!;
  const marker = `digest ${frozen.digest.slice(0, 16)}`;
  const intake = f.store.get<SessionIntake>(kinds.intake, created.intakeId!)!;
  expect(intake.context.reference).toEqual({
    id: frozen.id,
    digest: frozen.digest,
  });
  // The goal runs to its review with the reference in every member's prompt.
  expect(
    await run(f, sessions, () =>
      f.driver.launches.some((t) => t.purpose === "candidate-review"),
    ),
  ).toBe(true);
  const goalId = f.store.get<TopslSession>(kinds.session, created.sessionId)!
    .queue[0].goalId!;
  const goal = f.store.get<Goal>(kinds.goal, goalId)!;
  // The owner's request stays the objective; the import is not folded into it.
  expect(goal.objective).toBe("Build the parser");
  expect(goal.reference).toEqual({ id: frozen.id, digest: frozen.digest });
  const purposes = new Set<string>();
  for (const turn of f.driver.launches) {
    if (turn.phase === "endorsement" || (turn.phase as string) === "wording")
      continue;
    expect(turn.prompt, `${turn.purpose} ${turn.phase}`).toContain(marker);
    expect(turn.prompt).toContain("not the owner's request");
    purposes.add(turn.purpose);
  }
  expect(purposes).toEqual(
    new Set(["coordinator-contribution", "implementation", "candidate-review"]),
  );
  // Deleting the import does not change the session's copy, and a supervisor
  // after a restart keeps using the same frozen text.
  f.imports.delete({ projectId: "p", id: f.reference.id });
  const restarted = f.supervisor(f.reopen());
  await restarted.message({
    sessionId: created.sessionId,
    text: "And add a printer",
    mode: "work",
    commandId: "reference-session-second",
  });
  const before = f.driver.launches.length;
  await run(f, restarted, () => f.driver.launches.length > before, 20);
  const later = f.driver.launches.slice(before);
  expect(later.length).toBeGreaterThan(0);
  for (const turn of later.filter(
    (t) => t.phase !== "endorsement" && (t.phase as string) !== "wording",
  ))
    expect(turn.prompt).toContain(marker);
  expect(
    f.store.get<SessionReference>("session-reference", frozen.id)?.text,
  ).toBe(frozen.text);
});

test("a session without an import keeps its earlier prompt and digest shape", async () => {
  const f = await setup();
  const sessions = f.supervisor();
  const created = await sessions.create({
    projectId: "p",
    text: "Build the parser",
    commandId: "plain-session-create",
  });
  const intake = f.store.get<SessionIntake>(kinds.intake, created.intakeId!)!;
  expect(intake.context).not.toHaveProperty("reference");
  await run(f, sessions, () => f.driver.launches.length > 0, 10);
  for (const turn of f.driver.launches)
    expect(turn.prompt).not.toContain("IMPORTED REFERENCE");
  await expect(
    sessions.create({
      projectId: "p",
      referenceId: "missing",
      commandId: "missing-reference-create",
    }),
  ).rejects.toThrow("no longer exists");
});
