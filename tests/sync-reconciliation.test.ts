import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { hash, now } from "../packages/domain/invariants";
import { SyncRepository } from "../packages/sync/reconciler";
import { RevisionRepository } from "../packages/context/revisions";
import type {
  Evidence,
  ContextPackage,
  Workspace,
} from "../packages/domain/workflow";
import { fixture } from "./helpers";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const evidence: Evidence = {
  level: "provider-readback",
  source: "fixture-registry",
  observedAt: now(),
  detail: "Fixture source readback.",
};
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
describe("dimension-specific synchronization", () => {
  test("state and evidence stay separate; unsuccessful observations preserve freshness history", async () => {
    const { store } = await setup(),
      sync = new SyncRepository(store);
    const input = {
      projectId: "p",
      targetId: "registry",
      dimension: "native-presentation" as const,
      state: "current" as const,
      expectedRevision: null,
      observedRevision: "r1",
      evidence,
      detail: "Registry readback",
      suggestedAction: null,
    };
    const current = sync.observe(input),
      failed = sync.observe({
        ...input,
        state: "error",
        observedRevision: null,
      });
    expect(failed.lastSuccessfulObservationAt).toBe(
      current.lastSuccessfulObservationAt,
    );
    expect(() =>
      sync.observe({ ...input, evidence: { ...evidence, level: "none" } }),
    ).toThrow("requires recorded evidence");
    sync.observe({
      ...input,
      targetId: "sidebar",
      state: "unverified",
      evidence: { ...evidence, level: "none" },
    });
    expect(
      sync.observations("p").map((record) => [record.targetId, record.state]),
    ).toEqual([
      ["registry", "error"],
      ["sidebar", "unverified"],
    ]);
    expect(sync.observations("other")).toEqual([]);
  });
  test("configured disk evidence cannot be promoted into effective settings", async () => {
    const { store } = await setup(),
      sync = new SyncRepository(store);
    const input = {
      projectId: "p",
      sessionId: "s",
      provider: "codex" as const,
      capability: "read-only",
      classification: "enforceable" as const,
      stage: "configured" as const,
      value: "true",
      sourceHash: "disk-hash",
      sourceRevision: "config1",
      evidence: { ...evidence, level: "source-observation" as const },
    };
    sync.recordConfiguration(input);
    expect(() =>
      sync.recordConfiguration({ ...input, stage: "effective" }),
    ).toThrow("cannot prove effective");
    expect(() =>
      sync.requireEffectiveCapabilities("p", "s", ["read-only"]),
    ).toThrow("not evidenced");
    sync.recordConfiguration({ ...input, stage: "effective", evidence });
    sync.requireEffectiveCapabilities("p", "s", ["read-only"]);
    expect(() =>
      sync.requireEffectiveCapabilities("p", "other", ["read-only"]),
    ).toThrow();
  });
});
function packageFor(
  store: Awaited<ReturnType<typeof fixture>>["store"],
  id: string,
  refs: string[],
): ContextPackage {
  const context: ContextPackage = {
    id,
    projectId: "p",
    conversationId: null,
    text: `Package ${id}`,
    hash: hash(`Package ${id}`),
    sourceRefs: refs,
    specificationRevision: refs[0],
    omissions: [],
    visibility: "project",
    completeness: "recorded",
    createdAt: now(),
  };
  store.immutable("context-package", context);
  return context;
}
describe("immutable shared revisions and task inputs", () => {
  test("new blocking specifications flag old inputs without rewriting old packages", async () => {
    const { store } = await setup(),
      revisions = new RevisionRepository(store);
    store.put("task", { id: "task", projectId: "p" });
    const first = revisions.publish({
      projectId: "p",
      recordId: "spec",
      kind: "specification",
      title: "Spec",
      content: "Acceptance v1",
      impact: "dispatch-blocking",
      expectedHeadId: null,
    });
    const oldPackage = packageFor(store, "old", [first.id]);
    revisions.bindPackage("task", oldPackage.id);
    const second = revisions.publish({
      projectId: "p",
      recordId: "spec",
      kind: "specification",
      title: "Spec",
      content: "Acceptance v2",
      impact: "dispatch-blocking",
      expectedHeadId: first.id,
    });
    expect(revisions.inspectTaskInputs("task").stale[0]).toMatchObject({
      usedRevisionId: first.id,
      availableRevisionId: second.id,
      blocking: true,
    });
    expect(() => revisions.assertTaskInputsCurrent("task")).toThrow("stale");
    expect(store.get("context-package", "old")).toEqual(oldPackage);
    expect(() =>
      revisions.publish({
        projectId: "p",
        recordId: "spec",
        kind: "specification",
        title: "Spec",
        content: "v3",
        impact: "dispatch-blocking",
        expectedHeadId: first.id,
      }),
    ).toThrow("changed");
    const updated = packageFor(store, "new", [second.id]);
    revisions.bindPackage("task", updated.id);
    revisions.assertTaskInputsCurrent("task");
    expect([...store.iterate("task-input-binding")]).toHaveLength(2);
  });
  test("advisory changes are visible; references cannot cross project or omit package sources", async () => {
    const { store } = await setup(),
      revisions = new RevisionRepository(store);
    store.put("task", { id: "task", projectId: "p" });
    const first = revisions.publish({
      projectId: "p",
      recordId: "note",
      kind: "decision",
      title: "Note",
      content: "v1",
      impact: "advisory",
      expectedHeadId: null,
    });
    packageFor(store, "old", [first.id]);
    revisions.bindPackage("task", "old");
    revisions.publish({
      projectId: "p",
      recordId: "note",
      kind: "decision",
      title: "Note",
      content: "v2",
      impact: "advisory",
      expectedHeadId: first.id,
    });
    expect(revisions.inspectTaskInputs("task").stale[0].blocking).toBe(false);
    revisions.assertTaskInputsCurrent("task");
    packageFor(store, "empty", []);
    expect(() =>
      revisions.bindPackage("task", "empty", null, [
        { recordId: "note", revisionId: first.id },
      ]),
    ).toThrow("included");
    store.put("task", { id: "wrong", projectId: "other" });
    expect(() => revisions.bindPackage("wrong", "old")).toThrow(
      "another project",
    );
  });
  test("explicit update intents and receipts preserve the original attempt package", async () => {
    const { store } = await setup(),
      revisions = new RevisionRepository(store);
    store.put("task", { id: "task", projectId: "p" });
    const first = revisions.publish({
      projectId: "p",
      recordId: "spec",
      kind: "specification",
      title: "Spec",
      content: "v1",
      impact: "dispatch-blocking",
      expectedHeadId: null,
    });
    packageFor(store, "old", [first.id]);
    store.put("attempt", {
      id: "attempt",
      taskId: "task",
      projectId: "p",
      state: "running",
      contextPackageId: "old",
    });
    revisions.bindPackage("task", "old", "attempt");
    const second = revisions.publish({
      projectId: "p",
      recordId: "spec",
      kind: "specification",
      title: "Spec",
      content: "v2",
      impact: "dispatch-blocking",
      expectedHeadId: first.id,
    });
    packageFor(store, "new", [second.id]);
    const intent = revisions.requestUpdate({
      taskId: "task",
      attemptId: "attempt",
      replacementPackageId: "new",
      action: "restart",
    });
    expect(intent.state).toBe("restart-required");
    const checkpoint = revisions.requestUpdate({
      taskId: "task",
      attemptId: "attempt",
      replacementPackageId: "new",
      action: "checkpoint",
    });
    expect(() =>
      revisions.recordCheckpointDelivery(checkpoint.id, {
        ...evidence,
        level: "source-observation",
      }),
    ).toThrow("provider evidence");
    revisions.recordCheckpointDelivery(checkpoint.id, evidence);
    expect(store.get<any>("attempt", "attempt").contextPackageId).toBe("old");
    expect(revisions.inspectTaskInputs("task").binding?.contextPackageId).toBe(
      "old",
    );
  });
});
