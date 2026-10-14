import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers";
import {
  LocalReplication,
  type TransferManifest,
} from "../packages/replication/local";
import { hash, now, stable } from "../packages/domain/invariants";
import { commandSchema } from "../packages/domain/commands";
import { createPrivateKey, sign } from "node:crypto";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function device(label: string, enabled = true) {
  const f = await fixture();
  const engine = new LocalReplication(f.store, { label, enabled });
  f.store.put("project", {
    id: "project",
    name: "Disposable",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  });
  cleanup.push(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  return { ...f, engine };
}
function owner(d: Awaited<ReturnType<typeof device>>) {
  const plan = d.engine.previewOwner("project");
  d.engine.approveOwner(plan.id, { digest: plan.digest });
}
function approve(
  d: Awaited<ReturnType<typeof device>>,
  peer: Awaited<ReturnType<typeof device>>,
) {
  const plan = d.engine.previewDevice(peer.engine.identity(), ["project"]);
  d.engine.approveDevice(plan.id, { digest: plan.digest });
}
function stage(
  d: Awaited<ReturnType<typeof device>>,
  text: string,
  id = "artifact",
) {
  const plan = d.engine.previewStage(id, "project", {
    kind: "artifact",
    label: "Fixture report",
    files: [{ path: "src/example.txt", text }],
  });
  return d.engine.approveStage(plan.id, { digest: plan.digest });
}
function envelope(
  a: Awaited<ReturnType<typeof device>>,
  b: Awaited<ReturnType<typeof device>>,
  ids = ["artifact"],
) {
  const p = a.engine.previewExport(b.engine.identity().id, ids);
  const manifest = a.engine.exportApproved(p.id, { digest: p.digest });
  return {
    manifest,
    chunks: Array.from({ length: manifest.total }, (_, index) =>
      a.engine.outgoingChunk(manifest.id, index),
    ),
  };
}
function deliver(
  b: Awaited<ReturnType<typeof device>>,
  e: ReturnType<typeof envelope>,
) {
  b.engine.beginImport(e.manifest);
  for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
  return b.engine.completeImport(e.manifest.id);
}
async function pair() {
  const a = await device("A"),
    b = await device("B");
  owner(a);
  approve(a, b);
  approve(b, a);
  return { a, b };
}

describe("optional portable encrypted replication", () => {
  test("default gates, native exact approvals, stable identity and unknown authority never grant execution", async () => {
    const a = await device("A", false),
      b = await device("B");
    expect(() =>
      a.engine.previewDevice(b.engine.identity(), ["project"]),
    ).toThrow(/disabled/);
    a.engine.setEnabled(true);
    const p = a.engine.previewDevice(b.engine.identity(), ["project"]);
    expect(() =>
      a.engine.approveDevice(p.id, { digest: hash("changed") }),
    ).toThrow(/native/);
    a.engine.approveDevice(p.id, { digest: p.digest });
    expect(() => a.engine.assertLocalOwner("project")).toThrow(/unknown/);
    expect(() => a.engine.previewOwner("project")).toThrow(
      /before its first peer/,
    );
    a.engine.setEnabled(false);
    expect(() => a.engine.assertLocalOwner("project")).toThrow(/unknown/);
    expect(new LocalReplication(a.store).identity()).toEqual(
      a.engine.identity(),
    );
    expect(() => b.engine.previewDevice(a.engine.identity(), [])).toThrow(
      /allowlist/,
    );
  });
  test("AES-GCM signed resumable chunks survive receiver restart, deduplicate and expose no plaintext", async () => {
    const { a, b } = await pair(),
      text = "Fixture content ".repeat(12000);
    stage(a, text);
    const e = envelope(a, b);
    expect(e.manifest.total).toBeGreaterThan(1);
    expect(stable(e)).not.toContain("Fixture content");
    expect(b.engine.beginImport(e.manifest).received).toBe(0);
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    expect(() => b.engine.completeImport(e.manifest.id)).toThrow(/incomplete/);
    const reopened = new LocalReplication(b.store, { enabled: true });
    expect(reopened.beginImport(e.manifest).received).toBe(1);
    for (const c of e.chunks.slice(1)) reopened.receiveChunk(e.manifest.id, c);
    reopened.completeImport(e.manifest.id);
    expect(
      b.store.get<any>("replica-record", "artifact").content.files[0].text,
    ).toBe(text);
    expect(reopened.beginImport(e.manifest).replay).toBe(true);
    expect(reopened.completeImport(e.manifest.id).replay).toBe(true);
    expect(() => reopened.assertLocalOwner("project")).toThrow(/replica/);
    expect(b.engine.status().transfers).toHaveLength(0);
    expect(() => a.engine.assertLocalOwner("project")).toThrow(
      /matching authenticated owner/,
    );
    deliver(a, envelope(b, a));
    expect(() => a.engine.assertLocalOwner("project", "integration")).toThrow(
      /pauses/,
    );
    expect(() => a.engine.assertLocalOwner("project")).not.toThrow();
  });
  test("two independently initialized local origins pause before either peer can claim authoritative execution", async () => {
    const a = await device("A"),
      b = await device("B");
    owner(a);
    owner(b);
    expect(() => a.engine.assertLocalOwner("project")).not.toThrow();
    expect(() => b.engine.assertLocalOwner("project")).not.toThrow();
    approve(a, b);
    approve(b, a);
    for (const d of [a, b]) {
      expect(() => d.engine.assertLocalOwner("project")).toThrow(
        /matching authenticated owner/,
      );
      d.engine.setEnabled(false);
      expect(() => d.engine.assertLocalOwner("project")).toThrow(
        /matching authenticated owner/,
      );
      d.engine.setEnabled(true);
    }
    stage(a, "A metadata");
    stage(b, "B metadata");
    deliver(b, envelope(a, b));
    deliver(a, envelope(b, a));
    for (const d of [a, b]) {
      expect(() => d.engine.assertLocalOwner("project")).toThrow(/Conflicting/);
      expect([
        ...d.store.iterate("replication-owner-observation"),
      ]).toHaveLength(0);
      d.engine.setEnabled(false);
      expect(() => d.engine.assertLocalOwner("project")).toThrow(/Conflicting/);
    }
  });
  test("matching owner round trips authorize only the designated host and reapproval invalidates prior policy observations", async () => {
    const { a, b } = await pair();
    stage(a, "confirmed owner metadata");
    deliver(b, envelope(a, b));
    const old = envelope(b, a);
    deliver(a, old);
    expect(() => a.engine.assertLocalOwner("project")).not.toThrow();
    expect(() => b.engine.assertLocalOwner("project")).toThrow(/replica/);
    const observationId = `${b.engine.identity().id}:project`,
      first = a.store.get<any>("replication-owner-observation", observationId);
    expect(first).toMatchObject({
      ownerDeviceId: a.engine.identity().id,
      generation: 1,
      sourceTransferId: old.manifest.id,
    });
    expect(
      a.store.get<any>("replication-peer", b.engine.identity().id).connected,
    ).toBe(false);
    expect(() => a.engine.assertLocalOwner("project", "integration")).toThrow(
      /ongoing liveness/,
    );
    approve(a, b);
    expect(
      a.store.get("replication-owner-observation", observationId),
    ).toBeUndefined();
    expect(() => a.engine.assertLocalOwner("project")).toThrow(
      /matching authenticated owner/,
    );
    a.engine.setEnabled(false);
    expect(() => a.engine.assertLocalOwner("project")).toThrow(
      /matching authenticated owner/,
    );
    a.engine.setEnabled(true);
    expect(deliver(a, old).replay).toBe(true);
    expect(() => a.engine.assertLocalOwner("project")).toThrow(
      /matching authenticated owner/,
    );
    deliver(a, envelope(b, a));
    const refreshed = a.store.get<any>(
      "replication-owner-observation",
      observationId,
    );
    expect(refreshed.approvalRevision).not.toBe(first.approvalRevision);
    expect(() => a.engine.assertLocalOwner("project")).not.toThrow();
    const changed = a.engine.previewDevice(b.engine.identity(), [
      "project",
      "other-project",
    ]);
    a.engine.approveDevice(changed.id, { digest: changed.digest });
    expect(() => a.engine.assertLocalOwner("project")).toThrow(
      /matching authenticated owner/,
    );
    deliver(a, envelope(b, a));
    expect(() => a.engine.assertLocalOwner("project")).not.toThrow();
    a.engine.revokeDevice(b.engine.identity().id);
    expect(
      a.store.get("replication-owner-observation", observationId),
    ).toBeUndefined();
  });
  test("peer association and changed project policy reject orphan active or uncertain writer leases", async () => {
    const a = await device("A"),
      b = await device("B");
    owner(a);
    const lease = {
      projectId: "project",
      workspaceId: "fixture-orphan",
      attemptId: "fixture-attempt",
      state: "uncertain",
    };
    a.store.db
      .prepare(
        "INSERT INTO workspace_leases(filesystem_identity,attempt_id,owner_id,generation,state,body) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "fixture-filesystem",
        "fixture-attempt",
        "fixture-owner",
        1,
        "uncertain",
        JSON.stringify(lease),
      );
    expect(() => approve(a, b)).toThrow(/writer leases/);
    expect(
      a.store.get("replication-peer", b.engine.identity().id),
    ).toBeUndefined();
    a.store.db.prepare("UPDATE workspace_leases SET state='released'").run();
    approve(a, b);
    const current = a.store.get<any>(
      "replication-peer",
      b.engine.identity().id,
    );
    a.store.db.prepare("UPDATE workspace_leases SET state='held'").run();
    const changed = a.engine.previewDevice(b.engine.identity(), [
      "other-project",
    ]);
    expect(() =>
      a.engine.approveDevice(changed.id, { digest: changed.digest }),
    ).toThrow(/writer leases/);
    expect(
      a.store.get<any>("replication-peer", b.engine.identity().id)
        .approvalRevision,
    ).toBe(current.approvalRevision);
    a.store.db.prepare("UPDATE workspace_leases SET state='released'").run();
  });
  test("unapproved devices, signed manifest changes, chunk tampering, changed partial manifests and project allowlists fail closed", async () => {
    const { a, b } = await pair(),
      c = await device("C");
    stage(a, "safe");
    const e = envelope(a, b);
    expect(() => c.engine.beginImport(e.manifest)).toThrow(/Unapproved/);
    expect(() =>
      b.engine.beginImport({ ...e.manifest, payloadHash: hash("wrong") }),
    ).toThrow(/signature/);
    b.engine.beginImport(e.manifest);
    expect(() =>
      b.engine.receiveChunk(e.manifest.id, {
        ...e.chunks[0],
        tag: "0".repeat(32),
      }),
    ).toThrow(/integrity/);
    const alternate = envelope(a, b);
    expect(alternate.manifest.id).not.toBe(e.manifest.id);
    expect(() =>
      b.engine.beginImport({
        ...alternate.manifest,
        id: e.manifest.id,
      } as TransferManifest),
    ).toThrow(/signature/);
    stage(a, "other", "other");
    a.store.put("replica-record", {
      ...a.store.get<any>("replica-record", "other"),
      projectId: "unapproved",
    });
    expect(() =>
      a.engine.previewExport(b.engine.identity().id, ["other"]),
    ).toThrow(/allowlist/);
    b.engine.revokeDevice(a.engine.identity().id);
    expect(b.engine.status().transfers).toHaveLength(0);
    expect(() => b.engine.receiveChunk(e.manifest.id, e.chunks[0])).toThrow();
  });
  test("authenticated encryption rejects a correctly signed envelope containing a wrong GCM authentication tag", async () => {
    const { a, b } = await pair();
    stage(a, "fixture only secret-free text");
    const e = envelope(a, b),
      chunks = e.chunks.map((c) => ({ ...c, tag: "0".repeat(32) }));
    const { signature: _, ...header } = e.manifest;
    header.chunkHashes = chunks.map((c) => hash(stable(c)));
    // Generated fixture identity only; this negative control exercises AES-GCM after signature/hash validation.
    const secrets = a.store.get<any>("replication-identity", "local"),
      key = createPrivateKey({
        key: Buffer.from(secrets.signingPrivateKey, "base64"),
        format: "der",
        type: "pkcs8",
      });
    const manifest = {
      ...header,
      signature: sign(null, Buffer.from(stable(header)), key).toString(
        "base64",
      ),
    };
    b.engine.beginImport(manifest);
    for (const c of chunks) b.engine.receiveChunk(manifest.id, c);
    expect(() => b.engine.completeImport(manifest.id)).toThrow();
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(b.store.get("replication-receipt", manifest.id)).toBeUndefined();
  });
  test("conflicting edits preserve both branches, local resolution converges, delayed ancestor import cannot roll back", async () => {
    const { a, b } = await pair();
    const first = stage(a, "base"),
      delayed = envelope(a, b);
    deliver(b, delayed);
    stage(a, "A changed");
    stage(b, "B changed");
    const remote = envelope(a, b);
    const result = deliver(b, remote);
    expect(result.receipt.conflicts).toHaveLength(1);
    const conflict = b.engine.conflictPreview(result.receipt.conflicts[0]);
    expect(() => b.engine.resolveConflict(conflict.id, "local", {})).toThrow(
      /Native/,
    );
    const chosen = b.engine.resolveConflict(conflict.id, "local", {
      digest: conflict.digest,
    });
    expect(
      chosen.content.kind === "artifact" && chosen.content.files[0].text,
    ).toBe("B changed");
    // Re-export of the remote branch is a new transfer identity, but still an ancestor of the reviewed merge.
    deliver(b, envelope(a, b));
    expect(b.store.get<any>("replica-record", "artifact").revision).toBe(
      chosen.revision,
    );
    deliver(a, envelope(b, a));
    expect(a.store.get<any>("replica-record", "artifact").revision).toBe(
      chosen.revision,
    );
    deliver(b, envelope(a, b));
    expect(
      b.store.get<any>(
        "replication-common",
        `${a.engine.identity().id}:artifact`,
      ).revision,
    ).toBe(chosen.revision);
    const old = { ...first, id: "artifact" };
    a.store.put("replica-record", old); // Explicit delayed historical export fixture.
    deliver(b, envelope(a, b));
    expect(b.store.get<any>("replica-record", "artifact").revision).toBe(
      chosen.revision,
    );
    expect(b.engine.status("project").conflicts).toHaveLength(0);
  });
  test("deletion propagates minimal tombstones, scrubs conflict/partial/export payloads and prevents replay resurrection", async () => {
    const { a, b } = await pair(),
      deletedText = "delete this unique payload";
    stage(a, deletedText);
    const old = envelope(a, b);
    deliver(b, old);
    stage(a, "conflict A");
    stage(b, deletedText + " B");
    deliver(b, envelope(a, b));
    const pending = envelope(a, b);
    b.engine.beginImport(pending.manifest);
    b.engine.receiveChunk(pending.manifest.id, pending.chunks[0]);
    a.engine.deleteRecord("artifact", "project");
    expect(a.engine.status().transfers).toHaveLength(0);
    deliver(b, envelope(a, b));
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(b.store.get("replication-tombstone", "artifact")).toEqual({
      id: "artifact",
      projectId: "project",
      deleted: true,
    });
    expect(b.engine.status("project").conflicts).toHaveLength(0);
    expect(b.engine.status().transfers).toHaveLength(0);
    expect(
      stable(
        b.store.db
          .prepare("SELECT body FROM documents WHERE kind LIKE 'replic%'")
          .all(),
      ),
    ).not.toContain(deletedText);
    expect(() => stage(b, "resurrect")).toThrow(/Deleted/);
    deliver(b, old);
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
  });
  test("credential/native grant/database paths and quoted nested sensitive keys are excluded; schemas reject arbitrary native records", async () => {
    const a = await device("A");
    const files = [
      "history.sqlite",
      "history.sqlite-wal",
      ".env",
      ".claude.json",
      ".codex-global-state.json",
      "auth.json",
      "context-grants/foo.json",
      ".codex/config.toml",
      ".ssh/id_ed25519",
    ];
    for (const file of files)
      expect(() =>
        a.engine.previewStage("s", "project", {
          kind: "artifact",
          label: "safe",
          files: [{ path: file, text: "benign" }],
        }),
      ).toThrow(/cannot be replicated/);
    for (const text of [
      '{"password":"actual"}',
      '{"nested":{"token":"actual"}}',
      '{"grant":"g","token":"t","endpoint":"http://localhost"}',
      "api_key=abc",
      "-----BEGIN PRIVATE KEY-----",
    ])
      expect(() =>
        a.engine.previewStage("s", "project", {
          kind: "artifact",
          label: "safe",
          files: [{ path: "safe.json", text }],
        }),
      ).toThrow(/Secret-like/);
    expect(
      commandSchema.safeParse({
        type: "replication-stage-preview",
        recordId: "x",
        projectId: "project",
        content: {
          kind: "artifact",
          label: "x",
          files: [{ path: "x", text: "safe" }],
          trustRevision: "copied",
        },
      }).success,
    ).toBe(false);
    expect(() =>
      a.engine.previewStage("s", "project", {
        kind: "artifact",
        label: "safe",
        files: [{ path: "../escape", text: "safe" }],
      }),
    ).toThrow();
  });
  test("imported workspace references remain unavailable until separate native local mapping; owner conflicts pause both hosts", async () => {
    const { a, b } = await pair();
    const p = a.engine.previewStage("workspace", "project", {
      kind: "workspace-reference",
      logicalWorkspaceId: "workspace",
      label: "No filesystem path",
    });
    a.engine.approveStage(p.id, { digest: p.digest });
    deliver(b, envelope(a, b, ["workspace"]));
    expect(
      b.store.get<any>("replication-mapping", "project:workspace"),
    ).toMatchObject({
      availability: "unavailable",
      trust: "untrusted",
      canonicalRoot: null,
    });
    const mapping = b.engine.previewMapping(
      "project",
      "workspace",
      b.directory,
    );
    expect(() => b.engine.approveMapping(mapping.id, {})).toThrow(/native/);
    b.engine.approveMapping(mapping.id, { digest: mapping.digest });
    expect(
      b.store.get<any>("replication-mapping", "project:workspace")
        .executionAuthorization,
    ).toContain("none");
    expect([...b.store.iterate("workspace")]).toHaveLength(0);
    const foreignOwner = b.store.get<any>("replication-owner", "project");
    b.store.put("replication-owner", {
      ...foreignOwner,
      ownerDeviceId: b.engine.identity().id,
    });
    deliver(b, envelope(a, b, ["workspace"]));
    expect(() => b.engine.assertLocalOwner("project")).toThrow(/Conflicting/);
    b.engine.setEnabled(false);
    expect(() => b.engine.assertLocalOwner("project")).toThrow(/Conflicting/);
  });
});
