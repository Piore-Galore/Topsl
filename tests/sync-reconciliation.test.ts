import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { hash, now } from "../packages/domain/invariants";
import { SyncRepository } from "../packages/sync/reconciler";
import { ProjectSync } from "../packages/workspace/projects";
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
  test("native refresh keeps incompatible Topsl name intent instead of overwriting it", async () => {
    const f = await setup(),
      sync = new SyncRepository(f.store);
    f.store.put("project", {
      id: "p",
      name: "Base",
      realPath: f.directory,
      path: f.directory,
      trusted: true,
      createdAt: now(),
    });
    const group = {
      id: "native",
      name: "Base",
      roots: [f.directory],
      position: 0,
      revision: "r1",
    };
    sync.projectNativeCatalog({
      provider: "codex",
      profileId: "profile",
      groups: [group],
      evidence,
    });
    const initial = sync.fields("p")[0];
    sync.reconcileField({
      ...initial,
      local: "Local",
      remote: "Base",
      expectedRevision: initial.revision,
      evidence,
    });
    f.store.put("project", {
      ...f.store.get<any>("project", "p"),
      name: "Local",
    });
    const catalog = new ProjectSync(f.store, () => {});
    await catalog.observeNative(
      [{ ...group, name: "Remote", revision: "r2" }],
      () => true,
      "profile",
    );
    expect(f.store.get<any>("project", "p").name).toBe("Local");
    expect(sync.fields("p")[0].state).toBe("conflict");
    await catalog.close();
  });
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
  test("three-way conflict requires explicit directional resolution and stale decisions fail", async () => {
    const { store } = await setup(),
      sync = new SyncRepository(store);
    let field = sync.reconcileField({
      projectId: "p",
      targetId: "native",
      field: "name",
      local: "Base",
      remote: "Base",
      expectedRevision: 0,
      evidence,
    });
    field = sync.reconcileField({
      projectId: "p",
      targetId: "native",
      field: "name",
      local: "Local",
      remote: "Remote",
      expectedRevision: field.revision,
      evidence,
    });
    expect(field.state).toBe("conflict");
    const resolved = sync.resolveField(field.id, field.revision, "keep-topsl");
    expect(resolved.state).toBe("push-required");
    expect(resolved.remote).toBe("Remote");
    expect(() =>
      sync.resolveField(field.id, field.revision, "follow-native"),
    ).toThrow("stale");
    const verified = sync.reconcileField({
      projectId: "p",
      targetId: "native",
      field: "name",
      local: "Local",
      remote: "Local",
      expectedRevision: resolved.revision,
      evidence,
    });
    expect(verified.state).toBe("current");
    expect(verified.base).toBe("Local");
  });
  test("provider facts cannot be overwritten and follow-native policy remains explicit", async () => {
    const { store } = await setup(),
      sync = new SyncRepository(store);
    const provider = sync.reconcileField({
      projectId: "p",
      targetId: "account",
      field: "model",
      authority: "provider",
      local: "wanted",
      remote: "actual",
      expectedRevision: 0,
      evidence,
    });
    expect(provider.state).toBe("pull-required");
    expect(() =>
      sync.resolveField(provider.id, provider.revision, "keep-topsl"),
    ).toThrow("Provider-owned");
    expect(
      sync.resolveField(provider.id, provider.revision, "follow-native").local,
    ).toBe("actual");
  });
  test("multi-root native groups retain separate trust and native removal never deletes history", async () => {
    const f = await setup(),
      sync = new SyncRepository(f.store);
    f.store.put("project", {
      id: "p",
      realPath: f.directory,
      name: "Topsl",
      path: f.directory,
      trusted: true,
      createdAt: now(),
    });
    const workspace: Workspace = {
      id: "w",
      projectId: "p",
      root: f.directory,
      canonicalRoot: f.directory,
      hostId: "local",
      filesystemIdentity: "fixture",
      checkoutType: "directory",
      branch: null,
      trustRevision: "approved",
      availability: "available",
      provenance: "approved",
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    f.store.put("workspace", workspace);
    f.store.put("conversation", { id: "c", projectId: "p" });
    const group = {
      id: "native",
      name: "Native group",
      roots: [f.directory, "/unapproved-root"],
      position: 0,
      revision: "r1",
    };
    sync.projectNativeCatalog({
      provider: "codex",
      profileId: "profile",
      groups: [group],
      evidence,
    });
    let link = sync.links("p")[0];
    expect(link.roots.every((root) => !root.trustRevision)).toBe(true);
    link = sync.mapNativeRoot(link.id, link.revision, f.directory, "w");
    expect(link.roots[0].trustRevision).toBe("approved");
    expect(link.roots[1].trustRevision).toBeNull();
    expect(() =>
      sync.mapNativeRoot(link.id, link.revision, "/unapproved-root", "w"),
    ).toThrow("canonical");
    expect(
      sync
        .observations("p")
        .filter((record) => !record.targetId.startsWith("field:"))
        .map((record) => record.state),
    ).toEqual(["current", "unverified"]);
    sync.projectNativeCatalog({
      provider: "codex",
      profileId: "profile",
      groups: [],
      evidence,
    });
    expect(sync.links("p")[0].state).toBe("removed");
    expect(f.store.get("conversation", "c")).toBeDefined();
    const removed = sync.links("p")[0];
    sync.setLinkState(removed.id, removed.revision, "unlinked");
    sync.projectNativeCatalog({
      provider: "codex",
      profileId: "profile",
      groups: [group],
      evidence,
    });
    expect(sync.links("p")[0].state).toBe("unlinked");
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
