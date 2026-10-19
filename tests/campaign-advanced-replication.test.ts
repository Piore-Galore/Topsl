// Campaign 2026-10-19-comprehensive, packet p7-advanced-replication.
// Optional encrypted portable replication: REPL-01..REPL-10, journey J-14 (local
// layer) and the "device revoke -> transfer completion" fault row (plan section 8).
// Every negative case asserts at the durable boundary: the receiver's whole
// documents/events tables are compared before and after the rejected call, so a
// partial import (or a rejected call that still wrote state) fails the test.
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createPrivateKey,
  randomUUID,
  sign,
} from "node:crypto";
import { fixture } from "./helpers";
import { Store } from "../packages/persistence/store";
import {
  LocalReplication,
  type EncryptedChunk,
  type PortableContent,
  type TransferManifest,
} from "../packages/replication/local";
import { hash, now, stable, uid } from "../packages/domain/invariants";
import { commandSchema } from "../packages/domain/commands";
import { Service } from "../apps/service/service";

interface Device {
  label: string;
  directory: string;
  key: string;
  store: Store;
  engine: LocalReplication;
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function device(label: string, enabled = true): Promise<Device> {
  const f = await fixture();
  const d: Device = {
    label,
    directory: f.directory,
    key: f.key,
    store: f.store,
    engine: new LocalReplication(f.store, { label, enabled }),
  };
  for (const id of ["project", "other"])
    d.store.put("project", {
      id,
      name: `Disposable ${id}`,
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    });
  cleanup.push(async () => {
    try {
      d.store.close();
    } catch {
      /* already closed by a restart step */
    }
    await rm(d.directory, { recursive: true, force: true });
  });
  return d;
}
/** Real restart: close the SQLCipher store and reopen it from its on-disk file. */
function restart(d: Device) {
  d.store.close();
  d.store = new Store(path.join(d.directory, "history.sqlite"), d.key);
  d.engine = new LocalReplication(d.store, { enabled: true });
}
const idOf = (d: Device) => d.engine.identity().id;
function owner(d: Device, projectId = "project") {
  const plan = d.engine.previewOwner(projectId);
  d.engine.approveOwner(plan.id, { digest: plan.digest });
}
function approve(d: Device, peer: Device, projects = ["project"]) {
  const plan = d.engine.previewDevice(peer.engine.identity(), projects);
  d.engine.approveDevice(plan.id, { digest: plan.digest });
}
function stage(
  d: Device,
  text: string,
  id = "artifact",
  projectId = "project",
) {
  const plan = d.engine.previewStage(id, projectId, {
    kind: "artifact",
    label: "Fixture report",
    files: [{ path: "src/example.txt", text }],
  });
  return d.engine.approveStage(plan.id, { digest: plan.digest });
}
function envelope(a: Device, b: Device, ids = ["artifact"]) {
  const p = a.engine.previewExport(idOf(b), ids);
  const manifest = a.engine.exportApproved(p.id, { digest: p.digest });
  return {
    manifest,
    chunks: Array.from({ length: manifest.total }, (_, index) =>
      a.engine.outgoingChunk(manifest.id, index),
    ),
  };
}
type Envelope = ReturnType<typeof envelope>;
function deliver(b: Device, e: Envelope) {
  b.engine.beginImport(e.manifest);
  for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
  return b.engine.completeImport(e.manifest.id);
}
async function pair(projects = ["project"]) {
  const a = await device("A"),
    b = await device("B");
  for (const p of projects) owner(a, p);
  approve(a, b, projects);
  approve(b, a, projects);
  return { a, b };
}
/** Whole durable state of a profile: every document and event row. */
function dump(d: Device) {
  return {
    documents: d.store.db
      .prepare("SELECT kind,id,body FROM documents ORDER BY kind,id")
      .all(),
    events: d.store.db
      .prepare("SELECT kind,body FROM events ORDER BY rowid")
      .all(),
    leases: d.store.db
      .prepare("SELECT * FROM workspace_leases ORDER BY rowid")
      .all(),
  };
}
const rows = (d: Device, kind: string) => [...d.store.iterate<any>(kind)];
const recordText = (d: Device, id = "artifact") => {
  const r = d.store.get<any>("replica-record", id);
  return r?.content.kind === "artifact" ? r.content.files[0].text : undefined;
};
const recordHash = (r: {
  id: string;
  projectId: string;
  content: PortableContent;
  parentRevision: string | null;
}) =>
  hash(
    stable({
      id: r.id,
      projectId: r.projectId,
      content: r.content,
      parentRevision: r.parentRevision,
    }),
  );
function portable(
  id: string,
  text: string,
  projectId = "project",
  parentRevision: string | null = null,
) {
  const basis = {
    id,
    projectId,
    content: {
      kind: "artifact" as const,
      label: "Crafted",
      files: [{ path: "crafted.txt", text }],
    },
    parentRevision,
  };
  return { ...basis, revision: recordHash(basis) };
}
/**
 * Adversarial-sender fixture: an envelope signed with A's real (generated, fixture-only)
 * identity and encrypted under the real A->B transfer key, carrying an arbitrary payload.
 * It models a correctly authenticated but buggy or malicious peer, so the receiver's
 * payload validation and transaction boundary are what is under test.
 */
function craft(
  a: Device,
  b: Device,
  payload: unknown,
  options: { plaintext?: Buffer; relabel?: boolean } = {},
): Envelope {
  const peer = a.store.get<any>("replication-peer", idOf(b));
  const transferId = randomUUID(),
    plaintext = options.plaintext ?? Buffer.from(stable(payload)),
    total = Math.ceil(plaintext.length / 65536);
  const header: Omit<TransferManifest, "signature"> = {
    protocol: 1,
    id: transferId,
    senderDeviceId: idOf(a),
    targetDeviceId: idOf(b),
    total,
    bytes: plaintext.length,
    payloadHash: hash(plaintext),
    chunkHashes: [],
  };
  const key: Buffer = (a.engine as any).key(peer, transferId);
  let chunks: EncryptedChunk[] = [];
  for (let index = 0; index < total; index++) {
    const nonce = Buffer.alloc(12, index + 1),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from((a.engine as any).aad(header, index)));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext.subarray(index * 65536, (index + 1) * 65536)),
      cipher.final(),
    ]);
    chunks.push({
      index,
      nonce: nonce.toString("hex"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("hex"),
    });
  }
  if (options.relabel)
    // Swap the index labels of the first two chunks: each chunk's ciphertext was
    // authenticated (AAD) for its original position.
    chunks = chunks.map((c, i) => ({
      ...chunks[i === 0 ? 1 : i === 1 ? 0 : i],
      index: c.index,
    }));
  header.chunkHashes = chunks.map((c) => hash(stable(c)));
  const secrets = a.store.get<any>("replication-identity", "local");
  const signingKey = createPrivateKey({
    key: Buffer.from(secrets.signingPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return {
    manifest: {
      ...header,
      signature: sign(null, Buffer.from(stable(header)), signingKey).toString(
        "base64",
      ),
    },
    chunks,
  };
}
const ownerOf = (a: Device, projectId = "project") => ({
  projectId,
  ownerDeviceId: idOf(a),
  generation: 1,
});
function expectRejectedWithoutEffect(d: Device, action: () => unknown) {
  const before = dump(d);
  expect(action).toThrow();
  expect(dump(d)).toEqual(before);
}

describe("REPL-01 feature gate, exact native approvals and stable identity", () => {
  test("service starts disabled, persists the owner's toggle across restart, and every approval needs the exact native digest", async () => {
    const f = await fixture();
    f.store.close();
    let service = new Service(f.directory, f.key, () => {}, true);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    service.store.put("project", {
      id: "project",
      name: "Disposable",
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    });
    const command = (raw: unknown, trusted = {}) =>
      service.command(commandSchema.parse(raw), trusted);
    const off = await command({ type: "replication-query" });
    expect(off).toMatchObject({
      enabled: false,
      transport: "portable-local",
      remoteControl: "unsupported",
    });
    const identity = off.identity;
    // Disabled: no preview (and hence no approval plan row) can be created.
    await expect(
      command({ type: "replication-owner-preview", projectId: "project" }),
    ).rejects.toThrow(/disabled/);
    expect([...service.store.iterate("replication-plan")]).toHaveLength(0);
    await command({
      type: "optional-feature-set",
      requestId: uid(),
      feature: "multi-device",
      enabled: true,
    });
    await service.close();
    service = new Service(f.directory, f.key, () => {}, true);
    const on = await command({ type: "replication-query" });
    expect(on.enabled).toBe(true);
    // Stable identity: same device id and public keys after restart.
    expect(on.identity).toEqual(identity);
    const plan = await command({
      type: "replication-owner-preview",
      projectId: "project",
    });
    // No native digest, a wrong digest, and a renderer-supplied "approved" flag all fail.
    for (const trusted of [{}, { digest: hash("other") }, { approved: true }])
      await expect(
        command(
          { type: "replication-plan-apply", requestId: uid(), id: plan.id },
          trusted,
        ),
      ).rejects.toThrow(/native/);
    expect(service.store.get("replication-owner", "project")).toBeUndefined();
    await command(
      { type: "replication-plan-apply", requestId: uid(), id: plan.id },
      { digest: plan.digest },
    );
    expect(
      service.store.get<any>("replication-owner", "project"),
    ).toMatchObject({ ownerDeviceId: identity.id, generation: 1 });
    // A consumed plan cannot be replayed even with its correct digest.
    await expect(
      command(
        { type: "replication-plan-apply", requestId: uid(), id: plan.id },
        { digest: plan.digest },
      ),
    ).rejects.toThrow();
    // Mapping preview requires a native folder selection; revoke/delete require native confirmation.
    await expect(
      command({
        type: "replication-mapping-preview",
        projectId: "project",
        logicalWorkspaceId: "w",
      }),
    ).rejects.toThrow(/native dialog/);
    await expect(
      command({
        type: "replication-device-revoke",
        requestId: uid(),
        deviceId: hash("peer"),
      }),
    ).rejects.toThrow(/native confirmation/);
    await expect(
      command({
        type: "replication-delete",
        requestId: uid(),
        recordId: "x",
        projectId: "project",
      }),
    ).rejects.toThrow(/native confirmation/);
    // Turning the feature off again persists too.
    await command({
      type: "optional-feature-set",
      requestId: uid(),
      feature: "multi-device",
      enabled: false,
    });
    await service.close();
    service = new Service(f.directory, f.key, () => {}, true);
    expect((await command({ type: "replication-query" })).enabled).toBe(false);
  });

  test("approval plans expire at their exact deadline, are single-use and kind-bound", async () => {
    const a = await device("A"),
      b = await device("B");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const expired = a.engine.previewDevice(b.engine.identity(), ["project"]);
    // expiresAt is preview time + 10 minutes; approval at exactly that instant is refused.
    vi.setSystemTime(new Date(Date.parse(expired.expiresAt)));
    expectRejectedWithoutEffect(a, () =>
      a.engine.approveDevice(expired.id, { digest: expired.digest }),
    );
    expect(a.store.get("replication-peer", idOf(b))).toBeUndefined();
    vi.setSystemTime(new Date("2026-10-19T11:00:00.000Z"));
    const live = a.engine.previewDevice(b.engine.identity(), ["project"]);
    vi.setSystemTime(new Date(Date.parse(live.expiresAt) - 1));
    // Wrong kind: a device plan cannot be consumed as an owner/mapping/stage/export plan.
    expectRejectedWithoutEffect(a, () =>
      a.engine.approveOwner(live.id, { digest: live.digest }),
    );
    expectRejectedWithoutEffect(a, () =>
      a.engine.approveStage(live.id, { digest: live.digest }),
    );
    a.engine.approveDevice(live.id, { digest: live.digest });
    const peer = a.store.get<any>("replication-peer", idOf(b));
    expect(peer).toMatchObject({
      id: idOf(b),
      approvedProjectIds: ["project"],
      connected: false,
    });
    expectRejectedWithoutEffect(a, () =>
      a.engine.approveDevice(live.id, { digest: live.digest }),
    );
    // A forged identity (id not derived from its keys) is refused before any plan is stored.
    expectRejectedWithoutEffect(a, () =>
      a.engine.previewDevice({ ...b.engine.identity(), id: hash("forged") }, [
        "project",
      ]),
    );
    // Duplicate allowlist entries are refused.
    expectRejectedWithoutEffect(a, () =>
      a.engine.previewDevice(b.engine.identity(), ["project", "project"]),
    );
  });
});

describe("REPL-02 tampered, misaddressed, incomplete and reordered transfers import nothing", () => {
  test("every manifest field change breaks the signature and creates no transfer row", async () => {
    const { a, b } = await pair(),
      c = await device("C");
    approve(b, c);
    stage(a, "manifest tamper fixture ".repeat(6000));
    const e = envelope(a, b),
      other = envelope(a, b);
    expect(e.manifest.total).toBeGreaterThan(1);
    const tampered: Array<[string, TransferManifest]> = [
      ["payloadHash", { ...e.manifest, payloadHash: hash("x") }],
      ["bytes", { ...e.manifest, bytes: e.manifest.bytes - 1 }],
      ["total", { ...e.manifest, total: e.manifest.total + 1 }],
      [
        "chunkHashes order",
        {
          ...e.manifest,
          chunkHashes: [...e.manifest.chunkHashes].reverse(),
        },
      ],
      ["targetDeviceId", { ...e.manifest, targetDeviceId: idOf(c) }],
      // C is an approved peer of B, but the manifest was signed by A.
      ["senderDeviceId", { ...e.manifest, senderDeviceId: idOf(c) }],
      ["id", { ...e.manifest, id: randomUUID() }],
      ["signature", { ...e.manifest, signature: other.manifest.signature }],
      ["protocol", { ...e.manifest, protocol: 2 as 1 }],
    ];
    for (const [, manifest] of tampered)
      expectRejectedWithoutEffect(b, () => b.engine.beginImport(manifest));
    expect(rows(b, "replication-transfer")).toHaveLength(0);
    // Negative control: the untampered manifest is accepted.
    expect(b.engine.beginImport(e.manifest)).toMatchObject({
      received: 0,
      replay: false,
    });
  });

  test("chunk ciphertext, nonce, tag, index and out-of-range changes are refused without storing the chunk", async () => {
    const { a, b } = await pair();
    stage(a, "chunk tamper fixture ".repeat(8000));
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    const c0 = e.chunks[0],
      flipped = Buffer.from(c0.ciphertext, "base64");
    flipped[10] ^= 1;
    const variants: EncryptedChunk[] = [
      { ...c0, ciphertext: flipped.toString("base64") },
      { ...c0, nonce: "0".repeat(24) },
      { ...c0, tag: "f".repeat(32) },
      { ...c0, index: 1 },
      { ...e.chunks[1], index: 0 },
      { ...c0, index: e.manifest.total },
    ];
    for (const chunk of variants)
      expectRejectedWithoutEffect(b, () =>
        b.engine.receiveChunk(e.manifest.id, chunk),
      );
    expect(b.engine.status().transfers[0]).toMatchObject({ received: 0 });
    expectRejectedWithoutEffect(b, () =>
      b.engine.completeImport(e.manifest.id),
    );
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
  });

  test("wrong recipient, unapproved device and missing chunk leave no import", async () => {
    const { a, b } = await pair(),
      c = await device("C");
    approve(a, c);
    approve(c, a);
    stage(a, "addressed fixture ".repeat(8000));
    const toC = envelope(a, c),
      toB = envelope(a, b);
    // A valid envelope addressed to C is not importable by B (even though A is B's approved peer).
    expectRejectedWithoutEffect(b, () => b.engine.beginImport(toC.manifest));
    // An unapproved device cannot begin, even with a correctly signed manifest.
    const d = await device("D");
    expectRejectedWithoutEffect(d, () => d.engine.beginImport(toB.manifest));
    expectRejectedWithoutEffect(d, () =>
      d.engine.receiveChunk(toB.manifest.id, toB.chunks[0]),
    );
    // Missing chunk: every chunk except the last.
    b.engine.beginImport(toB.manifest);
    for (const chunk of toB.chunks.slice(0, -1))
      b.engine.receiveChunk(toB.manifest.id, chunk);
    expectRejectedWithoutEffect(b, () =>
      b.engine.completeImport(toB.manifest.id),
    );
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(b.store.get("replication-owner", "project")).toBeUndefined();
    // Negative control: delivering the missing chunk completes the import exactly once.
    b.engine.receiveChunk(toB.manifest.id, toB.chunks.at(-1)!);
    expect(b.engine.completeImport(toB.manifest.id).replay).toBe(false);
    expect(recordText(b)).toBe("addressed fixture ".repeat(8000));
  });

  test("out-of-order arrival is reassembled by index, but chunks relabelled to another position fail authentication", async () => {
    const { a, b } = await pair(),
      text = "ordering fixture ".repeat(9000);
    stage(a, text);
    const e = envelope(a, b);
    expect(e.manifest.total).toBeGreaterThanOrEqual(3);
    b.engine.beginImport(e.manifest);
    // Legitimate resumable transport: arrival order is irrelevant; index binds position.
    for (const chunk of [...e.chunks].reverse())
      b.engine.receiveChunk(e.manifest.id, chunk);
    deliver(b, e);
    expect(recordText(b)).toBe(text);
    // Wrong order: chunk positions swapped and re-signed so hashes/signature match.
    // The AES-GCM AAD binds each ciphertext to its index, so completion must fail.
    const c = await device("C");
    owner(c);
    approve(c, b);
    approve(b, c);
    const payload = {
      records: [portable("ordered", "position fixture ".repeat(9000))],
      tombstones: [],
      owners: [ownerOf(c)],
    };
    // Authentication fails before payload parsing, so owner handling is never reached.
    const swapped = craft(c, b, payload, { relabel: true });
    b.engine.beginImport(swapped.manifest);
    for (const chunk of swapped.chunks)
      b.engine.receiveChunk(swapped.manifest.id, chunk);
    expectRejectedWithoutEffect(b, () =>
      b.engine.completeImport(swapped.manifest.id),
    );
    expect(b.store.get("replica-record", "ordered")).toBeUndefined();
  });

  test("a project outside the receiver's own allowlist for that sender is refused at completion with nothing imported", async () => {
    const a = await device("A"),
      b = await device("B");
    owner(a);
    approve(a, b, ["project"]);
    // The receiver only allows "other" from A.
    approve(b, a, ["other"]);
    stage(a, "wrong project fixture");
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
    expectRejectedWithoutEffect(b, () =>
      b.engine.completeImport(e.manifest.id),
    );
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(b.store.get("replication-owner", "project")).toBeUndefined();
  });

  test("a correctly signed payload with one invalid member is rejected atomically, including failures inside the import transaction", async () => {
    const { a, b } = await pair(["project", "other"]);
    // B holds a record "collide" that belongs to project "other".
    b.store.put("replica-record", portable("collide", "B other", "other"));
    const valid = portable("fresh", "valid member");
    const badRevision = { ...portable("bad", "tampered"), revision: hash("x") };
    const secret = portable("secret", '{"nested":{"password":"actual"}}');
    const owners = [ownerOf(a)];
    const cases: Array<[string, unknown]> = [
      [
        "secret-like member",
        { records: [valid, secret], tombstones: [], owners },
      ],
      [
        "revision integrity",
        { records: [valid, badRevision], tombstones: [], owners },
      ],
      [
        "duplicate identities",
        { records: [valid, valid], tombstones: [], owners },
      ],
      [
        "record without designated owner",
        {
          records: [valid, portable("o", "x", "other")],
          tombstones: [],
          owners,
        },
      ],
      [
        "self-designated owner on a replica",
        {
          records: [valid],
          tombstones: [],
          owners: [{ ...ownerOf(a), ownerDeviceId: idOf(b) }],
        },
      ],
      // These two throw inside the store transaction after "fresh" was written.
      [
        "record collides with another project",
        {
          records: [valid, portable("collide", "A", "project")],
          tombstones: [],
          owners,
        },
      ],
      [
        "tombstone for another project's record",
        {
          records: [valid],
          tombstones: [{ id: "collide", projectId: "project", deleted: true }],
          owners,
        },
      ],
      [
        "unsupported native record type",
        {
          records: [
            {
              ...valid,
              content: { kind: "native-session", nativeSessionId: "s" },
            },
          ],
          tombstones: [],
          owners,
        },
      ],
    ];
    for (const [name, payload] of cases) {
      const e = craft(a, b, payload);
      b.engine.beginImport(e.manifest);
      for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
      const before = dump(b);
      expect(() => b.engine.completeImport(e.manifest.id), name).toThrow();
      expect(dump(b), name).toEqual(before);
      expect(b.store.get("replica-record", "fresh"), name).toBeUndefined();
      expect(b.store.get("replication-receipt", e.manifest.id)).toBeUndefined();
    }
    // Negative control: the same crafting path with a valid payload imports.
    const ok = craft(a, b, { records: [valid], tombstones: [], owners });
    expect(deliver(b, ok).replay).toBe(false);
    expect(recordText(b, "fresh")).toBe("valid member");
  });
});

describe("REPL-03 restart, duplicate chunks and duplicate completed transfers converge", () => {
  test("receiver resumes from disk after a real store restart; duplicates and replays have no effect and nothing plaintext reaches disk", async () => {
    const { a, b } = await pair(),
      unique = `plaintext-canary-${uid()}`,
      text = `${unique} `.repeat(4000);
    stage(a, text);
    const e = envelope(a, b);
    expect(e.manifest.total).toBeGreaterThan(2);
    expect(stable(e)).not.toContain(unique);
    b.engine.beginImport(e.manifest);
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    // The partial transfer row holds ciphertext only.
    expect(stable(rows(b, "replication-transfer"))).not.toContain(unique);
    restart(b);
    expect(b.engine.beginImport(e.manifest)).toMatchObject({
      received: 1,
      replay: false,
    });
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    expect(b.engine.status().transfers[0]).toMatchObject({
      received: 1,
      total: e.manifest.total,
    });
    for (const chunk of [...e.chunks.slice(1)].reverse()) {
      b.engine.receiveChunk(e.manifest.id, chunk);
      b.engine.receiveChunk(e.manifest.id, chunk);
    }
    expect(b.engine.completeImport(e.manifest.id).replay).toBe(false);
    expect(recordText(b)).toBe(text);
    const settled = dump(b);
    restart(b);
    // Replays of the completed transfer after another restart: no state change at all.
    expect(b.engine.beginImport(e.manifest).replay).toBe(true);
    for (const chunk of e.chunks)
      expect(b.engine.receiveChunk(e.manifest.id, chunk)).toMatchObject({
        replay: true,
      });
    expect(b.engine.completeImport(e.manifest.id).replay).toBe(true);
    expect(dump(b)).toEqual(settled);
    expect(rows(b, "replication-receipt")).toHaveLength(1);
    expect(
      rows(b, "replication-revision").filter((r) => r.recordId === "artifact"),
    ).toHaveLength(1);
    // A changed chunk under a completed transfer id is refused.
    const flipped = Buffer.from(e.chunks[0].ciphertext, "base64");
    flipped[0] ^= 1;
    expectRejectedWithoutEffect(b, () =>
      b.engine.receiveChunk(e.manifest.id, {
        ...e.chunks[0],
        ciphertext: flipped.toString("base64"),
      }),
    );
    // The SQLCipher database and WAL on disk never contain the plaintext.
    b.store.db.pragma("wal_checkpoint(TRUNCATE)");
    for (const file of ["history.sqlite", "history.sqlite-wal"]) {
      const full = path.join(b.directory, file);
      if (existsSync(full))
        expect((await readFile(full)).includes(Buffer.from(unique))).toBe(
          false,
        );
    }
  });

  test("a second transfer of the same revision converges to one logical record without conflict", async () => {
    const { a, b } = await pair();
    const record = stage(a, "same revision");
    deliver(b, envelope(a, b));
    const second = envelope(a, b);
    const result = deliver(b, second);
    expect(result.replay).toBe(false);
    expect(result.receipt.conflicts).toHaveLength(0);
    expect(rows(b, "replica-record")).toHaveLength(1);
    expect(b.store.get<any>("replica-record", "artifact").revision).toBe(
      record.revision,
    );
    expect(rows(b, "replication-conflict")).toHaveLength(0);
    expect(rows(b, "replication-receipt")).toHaveLength(2);
  });
});

describe("REPL-04 transfer completion never assigns a writer or clears uncertain leases", () => {
  function insertLease(d: Device, state: string, attempt = "fixture-attempt") {
    d.store.db
      .prepare(
        "INSERT INTO workspace_leases(filesystem_identity,attempt_id,owner_id,generation,state,body) VALUES(?,?,?,?,?,?)",
      )
      .run(
        `fs-${attempt}`,
        attempt,
        "fixture-owner",
        1,
        state,
        JSON.stringify({
          projectId: "project",
          workspaceId: "w",
          attemptId: attempt,
          state,
        }),
      );
  }
  test("an uncertain local writer blocks first owner observation, survives the attempt and is never expired by import", async () => {
    const { a, b } = await pair();
    stage(a, "authority fixture");
    insertLease(b, "uncertain");
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
    expectRejectedWithoutEffect(b, () =>
      b.engine.completeImport(e.manifest.id),
    );
    expect(
      b.store.db.prepare("SELECT state FROM workspace_leases").get(),
    ).toEqual({ state: "uncertain" });
    b.store.db.prepare("UPDATE workspace_leases SET state='released'").run();
    deliver(b, e);
    // Replica: owner is A; no lease, workspace or attempt was created on B.
    expect(b.store.get<any>("replication-owner", "project").ownerDeviceId).toBe(
      idOf(a),
    );
    expect(() => b.engine.assertLocalOwner("project")).toThrow(/replica/);
    expect(
      b.store.db.prepare("SELECT count(*) n FROM workspace_leases").get(),
    ).toEqual({ n: 1 });
    expect(rows(b, "workspace")).toHaveLength(0);
    expect(rows(b, "attempt")).toHaveLength(0);
    // On the owner, an uncertain lease is left exactly as it was by an import.
    insertLease(a, "uncertain", "owner-attempt");
    const leaseBefore = a.store.db
      .prepare("SELECT * FROM workspace_leases")
      .all();
    stage(b, "replica proposal", "proposal");
    deliver(a, envelope(b, a, ["proposal"]));
    expect(a.store.db.prepare("SELECT * FROM workspace_leases").all()).toEqual(
      leaseBefore,
    );
    expect(a.store.get<any>("replication-owner", "project").ownerDeviceId).toBe(
      idOf(a),
    );
  });
});

describe("REPL-05 imported workspace references need a separate local mapping", () => {
  test("folder identity drift between preview and approval is refused; remapping never creates a workspace or execution authority", async () => {
    const { a, b } = await pair();
    const p = a.engine.previewStage("workspace", "project", {
      kind: "workspace-reference",
      logicalWorkspaceId: "workspace",
      label: "Logical only",
    });
    a.engine.approveStage(p.id, { digest: p.digest });
    deliver(b, envelope(a, b, ["workspace"]));
    expect(
      b.store.get<any>("replication-mapping", "project:workspace"),
    ).toMatchObject({ availability: "unavailable", canonicalRoot: null });
    const first = path.join(b.directory, "mapped-first"),
      second = path.join(b.directory, "mapped-second");
    await mkdir(first);
    await mkdir(second);
    const preview = b.engine.previewMapping("project", "workspace", first);
    // Replace the folder at the same path: a different filesystem identity.
    await rm(first, { recursive: true });
    await mkdir(path.join(b.directory, "placeholder-inode"));
    await mkdir(first);
    const mappingBefore = b.store.get<any>(
      "replication-mapping",
      "project:workspace",
    );
    expect(() =>
      b.engine.approveMapping(preview.id, { digest: preview.digest }),
    ).toThrow(/Folder identity changed/);
    // The stale approval is consumed (it cannot be retried) and nothing was mapped.
    expect(b.store.get("replication-plan", preview.id)).toBeUndefined();
    expect(b.store.get("replication-mapping", "project:workspace")).toEqual(
      mappingBefore,
    );
    expect(mappingBefore.availability).toBe("unavailable");
    const firstPlan = b.engine.previewMapping("project", "workspace", first);
    b.engine.approveMapping(firstPlan.id, { digest: firstPlan.digest });
    const mapped = b.store.get<any>("replication-mapping", "project:workspace");
    const remap = b.engine.previewMapping("project", "workspace", second);
    b.engine.approveMapping(remap.id, { digest: remap.digest });
    const remapped = b.store.get<any>(
      "replication-mapping",
      "project:workspace",
    );
    expect(remapped.filesystemIdentity).not.toBe(mapped.filesystemIdentity);
    expect(remapped.canonicalRoot).toBe(second);
    expect(remapped.executionAuthorization).toMatch(/^none/);
    expect(rows(b, "workspace")).toHaveLength(0);
    expect(() => b.engine.assertLocalOwner("project")).toThrow(/replica/);
    // An unknown local project cannot receive a mapping.
    expect(() =>
      b.engine.previewMapping("unknown", "workspace", second),
    ).toThrow(/Locally known project/);
  });
});

describe("REPL-06 conflicts keep both branches and delayed ancestors cannot roll back", () => {
  test("genuinely delayed envelopes of ancestor revisions, delivered after resolution and after a restart, leave the resolved record", async () => {
    const { a, b } = await pair();
    stage(a, "base");
    const baseOnTime = envelope(a, b),
      baseDelayed = envelope(a, b);
    deliver(b, baseOnTime);
    const remoteRecord = stage(a, "A changed");
    const remoteOnTime = envelope(a, b),
      remoteDelayed = envelope(a, b);
    const local = stage(b, "B changed");
    const result = deliver(b, remoteOnTime);
    expect(result.receipt.conflicts).toHaveLength(1);
    // Both branches retained: local record unchanged, remote kept in the conflict.
    expect(b.store.get<any>("replica-record", "artifact").revision).toBe(
      local.revision,
    );
    const conflict = b.engine.conflictPreview(result.receipt.conflicts[0]);
    expect((conflict.conflict as any).remote.revision).toBe(
      remoteRecord.revision,
    );
    expect((conflict.conflict as any).local.revision).toBe(local.revision);
    const resolved = b.engine.resolveConflict(conflict.id, "local", {
      digest: conflict.digest,
    });
    restart(b);
    for (const delayed of [baseDelayed, remoteDelayed]) {
      const r = deliver(b, delayed);
      expect(r.replay).toBe(false);
      expect(r.receipt.conflicts).toHaveLength(0);
      expect(b.store.get<any>("replica-record", "artifact").revision).toBe(
        resolved.revision,
      );
    }
    expect(recordText(b)).toBe("B changed");
    expect(rows(b, "replication-conflict")).toHaveLength(0);
    // Converges on A once A receives the resolution.
    deliver(a, envelope(b, a));
    expect(a.store.get<any>("replica-record", "artifact").revision).toBe(
      resolved.revision,
    );
  });

  test("choosing the remote branch also resists a delayed ancestor; a stale conflict review cannot be applied", async () => {
    const { a, b } = await pair();
    stage(a, "base");
    deliver(b, envelope(a, b));
    const baseDelayed = envelope(a, b);
    stage(a, "A branch");
    stage(b, "B branch");
    const r = deliver(b, envelope(a, b));
    const preview = b.engine.conflictPreview(r.receipt.conflicts[0]);
    // The local side changes after the review: the reviewed digest no longer applies.
    stage(b, "B branch edited after review");
    expect(() =>
      b.engine.resolveConflict(preview.id, "remote", {
        digest: preview.digest,
      }),
    ).toThrow(/changed after review/);
    expect(recordText(b)).toBe("B branch edited after review");
    // Re-deliver A's branch: a fresh conflict against the current local revision.
    const again = deliver(b, envelope(a, b));
    const current = b.engine.conflictPreview(again.receipt.conflicts[0]);
    const chosen = b.engine.resolveConflict(current.id, "remote", {
      digest: current.digest,
    });
    expect(recordText(b)).toBe("A branch");
    deliver(b, baseDelayed);
    expect(b.store.get<any>("replica-record", "artifact").revision).toBe(
      chosen.revision,
    );
  });
});

describe("REPL-07 tombstones survive restart and prevent replay resurrection", () => {
  test("pre-deletion envelopes, never delivered before, cannot resurrect after the tombstone and a restart", async () => {
    const { a, b } = await pair(),
      unique = `deleted-canary-${uid()}`;
    stage(a, unique);
    const delivered = envelope(a, b),
      neverDelivered = envelope(a, b);
    deliver(b, delivered);
    // A conflict derivative on B that must also be scrubbed.
    stage(a, `${unique} A edit`);
    stage(b, `${unique} B edit`);
    const conflicted = deliver(b, envelope(a, b));
    const conflictId = conflicted.receipt.conflicts[0];
    const conflictPreview = b.engine.conflictPreview(conflictId);
    a.engine.deleteRecord("artifact", "project");
    const tombstone = envelope(a, b);
    restart(a);
    deliver(b, tombstone);
    restart(b);
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(b.store.get("replication-tombstone", "artifact")).toEqual({
      id: "artifact",
      projectId: "project",
      deleted: true,
    });
    expect(
      stable(b.store.db.prepare("SELECT kind,body FROM documents").all()),
    ).not.toContain(unique);
    // Replays after restart: the completed one, the never-delivered pre-deletion one,
    // a duplicate tombstone, and a resolution of the old conflict review.
    expect(deliver(b, delivered).replay).toBe(true);
    expect(deliver(b, neverDelivered).replay).toBe(false);
    expect(deliver(b, tombstone).replay).toBe(true);
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(() =>
      b.engine.resolveConflict(conflictId, "remote", {
        digest: conflictPreview.digest,
      }),
    ).toThrow();
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(() => stage(b, "resurrect")).toThrow(/Deleted/);
    // The deleting device keeps the tombstone across its restart too.
    expect(() => stage(a, "resurrect")).toThrow(/Deleted/);
    expect(
      stable(b.store.db.prepare("SELECT kind,body FROM documents").all()),
    ).not.toContain(unique);
  });
});

describe("REPL-08 secrets, native paths and native record types are excluded", () => {
  const artifactWith = (pathName: string, text: string): PortableContent => ({
    kind: "artifact",
    label: "safe label",
    files: [{ path: pathName, text }],
  });
  test("deeply nested, array-wrapped, string-embedded and non-file secret-like fields are refused before any plan is stored", async () => {
    const a = await device("A");
    const nested: PortableContent[] = [
      artifactWith("a.json", '{"a":{"b":{"c":[{"d":{"password":"x"}}]}}}'),
      artifactWith("a.json", '[[{"refresh_token":"x"}]]'),
      artifactWith(
        "a.json",
        '{"outer":"{\\"inner\\":{\\"apiKey\\":\\"x\\"}}"}',
      ),
      artifactWith("a.json", '{"Authorization":"Basic Zml4dHVyZQ=="}'),
      artifactWith("a.json", '{"credentials":{"user":"fixture"}}'),
      artifactWith("a.json", '{"PRIVATE_KEY":"fixture"}'),
      artifactWith("a.json", '{"approvalDigest":"0000"}'),
      artifactWith("a.json", '{"leaseGeneration":3}'),
      artifactWith("notes.md", "Authorization: Bearer fixture-token-value"),
      artifactWith("notes.md", "export ACCESS_TOKEN=fixture"),
      artifactWith("notes.md", "sk-fixturefixturefixture"),
      artifactWith(
        "k.txt",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----",
      ),
      {
        kind: "artifact",
        label: "token=fixture",
        files: [{ path: "x", text: "ok" }],
      },
      {
        kind: "specification",
        objective: "safe",
        acceptanceCriteria: ['{"grant":{"scope":"all"}}'],
        interfaces: [],
      },
      {
        kind: "project-metadata",
        name: "safe",
        description: "client_secret: fixture",
      },
    ];
    for (const content of nested)
      expectRejectedWithoutEffect(a, () =>
        a.engine.previewStage("s", "project", content),
      );
    const paths = [
      "nested/dir/history.sqlite-shm",
      "deep/.codex/sessions/x.jsonl",
      "deep/.claude/settings.json",
      "deep/context-grants/x.json",
      "deep/.ssh/id_rsa",
      "certs/server.key",
      "certs/client.p12",
      "nested/.env.local",
      "nested/credentials.json",
      "C:/abs/path.txt",
      "a/./b.txt",
      "a\\b.txt",
    ];
    for (const p of paths)
      expectRejectedWithoutEffect(a, () =>
        a.engine.previewStage("s", "project", artifactWith(p, "benign")),
      );
    expect(rows(a, "replication-plan")).toHaveLength(0);
    // Negative control: ordinary nested JSON without secret-like keys is accepted.
    const ok = a.engine.previewStage(
      "s",
      "project",
      artifactWith(
        "ok.json",
        '{"a":{"b":[{"tokens_used":"n/a","label":"x"}]}}',
      ),
    );
    expect(ok.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("native record kinds and extra fields are schema-rejected; a valid import creates only portable replication rows", async () => {
    for (const content of [
      { kind: "native-session", nativeSessionId: "s" },
      { kind: "conversation", messages: [] },
      { kind: "context-grant", scope: "all" },
      {
        kind: "artifact",
        label: "x",
        files: [{ path: "x", text: "y" }],
        nativeSessionId: "s",
      },
      {
        kind: "workspace-reference",
        logicalWorkspaceId: "w",
        label: "x",
        canonicalRoot: "/Users/fixture",
      },
    ])
      expect(
        commandSchema.safeParse({
          type: "replication-stage-preview",
          recordId: "x",
          projectId: "project",
          content,
        }).success,
      ).toBe(false);
    const { a, b } = await pair();
    stage(a, "plain portable metadata");
    const kindsBefore = new Set(
      b.store.db
        .prepare("SELECT DISTINCT kind FROM documents")
        .all()
        .map((r: any) => r.kind),
    );
    deliver(b, envelope(a, b));
    const created = b.store.db
      .prepare("SELECT DISTINCT kind FROM documents")
      .all()
      .map((r: any) => r.kind)
      .filter((k: string) => !kindsBefore.has(k));
    expect(created.length).toBeGreaterThan(0);
    for (const kind of created)
      expect(kind).toMatch(/^(replica-record|replication-[a-z-]+)$/);
    for (const kind of [
      "context-grant",
      "approval",
      "agent-session",
      "conversation",
      "workspace",
      "attempt",
      "run",
    ])
      expect(rows(b, kind), kind).toHaveLength(0);
  });

  for (const [name, text] of [
    ["nested secret key", '{"service":{"secret":"fixture-secret-value"}}'],
    [
      "aws secret access key",
      '{"aws_secret_access_key":"fixtureFIXTUREfixture"}',
    ],
    ["nested passphrase", '{"db":{"passphrase":"fixture-passphrase"}}'],
  ])
    test(`secret-like nested field is refused: ${name}`, async () => {
      const a = await device("A");
      expectRejectedWithoutEffect(a, () =>
        a.engine.previewStage(
          "s",
          "project",
          artifactWith("config.json", text),
        ),
      );
    });

  for (const [file, text] of [
    [".netrc", "machine example.test login fixture password fixture-pass"],
    [".git-credentials", "https://fixture:fixture-pass@example.test"],
  ])
    test(`credential file is refused: ${file}`, async () => {
      const a = await device("A");
      expectRejectedWithoutEffect(a, () =>
        a.engine.previewStage("s", "project", artifactWith(file, text)),
      );
    });
});

describe("REPL-09 and fault row 'device revoke -> transfer completion'", () => {
  test("receiver revocation mid-transfer discards partial chunks; late chunks, completion and authority reuse fail", async () => {
    const { a, b } = await pair();
    stage(a, "revoked transfer ".repeat(8000));
    deliver(b, envelope(a, b));
    const completed = rows(b, "replication-receipt")[0];
    stage(a, "second revision ".repeat(8000));
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
    // All chunks are present; revoke before completion.
    b.engine.revokeDevice(idOf(a));
    expect(rows(b, "replication-transfer")).toHaveLength(0);
    expect(b.store.get("replication-peer", idOf(a))).toBeUndefined();
    const text = recordText(b);
    expectRejectedWithoutEffect(b, () =>
      b.engine.completeImport(e.manifest.id),
    );
    expectRejectedWithoutEffect(b, () =>
      b.engine.receiveChunk(e.manifest.id, e.chunks[0]),
    );
    expectRejectedWithoutEffect(b, () => b.engine.beginImport(e.manifest));
    // A completed transfer's chunk replay also requires a current peer.
    expectRejectedWithoutEffect(b, () =>
      b.engine.receiveChunk(completed.id, e.chunks[0]),
    );
    expect(recordText(b)).toBe(text);
    // Authority reuse: the replica cannot self-designate after revoking the owner.
    expect(() => b.engine.assertLocalOwner("project")).toThrow(/replica/);
    expect(() => b.engine.previewOwner("project")).toThrow(/Initialize/);
    restart(b);
    expect(() => b.engine.beginImport(e.manifest)).toThrow(/Unapproved/);
    expect(() => b.engine.assertLocalOwner("project")).toThrow(/replica/);
  });

  test("narrowing the project allowlist mid-transfer applies current policy to a resumed envelope", async () => {
    const { a, b } = await pair(["project", "other"]);
    stage(a, "policy fixture ".repeat(8000));
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    // Re-approval with a narrower allowlist: partial transfers are discarded.
    approve(b, a, ["other"]);
    expect(rows(b, "replication-transfer")).toHaveLength(0);
    // The old (still correctly signed) envelope can be restarted, but completion is
    // judged under the current allowlist and imports nothing.
    b.engine.beginImport(e.manifest);
    for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
    expectRejectedWithoutEffect(b, () =>
      b.engine.completeImport(e.manifest.id),
    );
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    expect(b.store.get("replication-owner", "project")).toBeUndefined();
    // Negative control: restoring the project to the allowlist lets a resumed import complete.
    approve(b, a, ["project", "other"]);
    expect(deliver(b, e).replay).toBe(false);
    expect(b.store.get("replica-record", "artifact")).toBeDefined();
  });

  test("sender revocation stops serving chunks and clears outgoing envelopes; a re-approved peer gets no stale owner observation", async () => {
    const { a, b } = await pair();
    stage(a, "sender revoke ".repeat(8000));
    deliver(b, envelope(a, b));
    deliver(a, envelope(b, a, ["artifact"]));
    expect(() => a.engine.assertLocalOwner("project")).not.toThrow();
    const e = envelope(a, b);
    a.engine.revokeDevice(idOf(b));
    expect(
      rows(a, "replication-transfer").filter((t) => t.direction === "outgoing"),
    ).toHaveLength(0);
    expect(() => a.engine.outgoingChunk(e.manifest.id, 0)).toThrow();
    expect(rows(a, "replication-owner-observation")).toHaveLength(0);
    approve(a, b);
    // Prior observation does not carry across the new approval revision.
    expect(() => a.engine.assertLocalOwner("project")).toThrow(
      /matching authenticated owner/,
    );
    expect(() => a.engine.outgoingChunk(e.manifest.id, 0)).toThrow();
  });
});

describe("REPL-10 large transfer, interrupted writes, storage exhaustion and concurrent edits", () => {
  test("near-limit transfer reports exact progress; an oversize export creates no envelope", async () => {
    const { a, b } = await pair();
    const big = "L".repeat(900_000);
    stage(a, big, "one");
    stage(a, big.replace(/L/g, "M"), "two");
    const e = envelope(a, b, ["one", "two"]);
    expect(e.manifest.total).toBeGreaterThan(20);
    expect(e.manifest.bytes).toBeLessThanOrEqual(2_000_000);
    b.engine.beginImport(e.manifest);
    e.chunks.forEach((chunk, i) => {
      expect(b.engine.receiveChunk(e.manifest.id, chunk)).toEqual({
        received: i + 1,
        total: e.manifest.total,
      });
      expect(b.engine.status().transfers[0]).toMatchObject({
        received: i + 1,
        total: e.manifest.total,
      });
    });
    b.engine.completeImport(e.manifest.id);
    expect(recordText(b, "one")).toBe(big);
    expect(rows(b, "replication-transfer")).toHaveLength(0);
    stage(a, big.replace(/L/g, "N"), "three");
    const outgoingBefore = rows(a, "replication-transfer").length;
    const p = a.engine.previewExport(idOf(b), ["one", "two", "three"]);
    expect(() => a.engine.exportApproved(p.id, { digest: p.digest })).toThrow(
      /bounded envelope/,
    );
    expect(rows(a, "replication-transfer")).toHaveLength(outgoingBefore);
  });

  test("an interrupted write inside completion rolls back fully; the retry imports exactly once", async () => {
    const { a, b } = await pair();
    stage(a, "interrupted write fixture");
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
    const before = dump(b),
      put = b.store.put.bind(b.store);
    let fail = true;
    b.store.put = ((kind: string, value: any) => {
      if (fail && kind === "replication-receipt")
        throw new Error("Injected disk write failure");
      return put(kind, value);
    }) as Store["put"];
    expect(() => b.engine.completeImport(e.manifest.id)).toThrow(/Injected/);
    expect(dump(b)).toEqual(before);
    fail = false;
    expect(b.engine.completeImport(e.manifest.id).replay).toBe(false);
    expect(b.engine.completeImport(e.manifest.id).replay).toBe(true);
    expect(rows(b, "replication-receipt")).toHaveLength(1);
    expect(recordText(b)).toBe("interrupted write fixture");
  });

  test("real SQLite storage exhaustion during chunk receipt and completion leaves consistent progress and imports after space returns", async () => {
    const { a, b } = await pair();
    const text = "Q".repeat(800_000);
    stage(a, text);
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    // VACUUM empties the freelist so the page cap below is real headroom, not reuse.
    b.store.db.exec("VACUUM");
    b.store.db.pragma("wal_checkpoint(TRUNCATE)");
    const pages = (b.store.db.prepare("PRAGMA page_count").get() as any)
      .page_count as number;
    b.store.db.pragma(`max_page_count = ${pages + 2}`);
    let refused = 0;
    for (const chunk of e.chunks.slice(1)) {
      try {
        b.engine.receiveChunk(e.manifest.id, chunk);
      } catch (error: any) {
        expect(String(error.code ?? error.message)).toMatch(/FULL|full/);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
    const reported = b.engine.status().transfers[0];
    const stored = rows(b, "replication-transfer")[0];
    expect(reported.received).toBe(stored.chunks.length);
    expect(reported.received).toBeLessThan(e.manifest.total);
    expect(b.store.get("replica-record", "artifact")).toBeUndefined();
    b.store.db.pragma("max_page_count = 1073741823");
    for (const chunk of e.chunks) b.engine.receiveChunk(e.manifest.id, chunk);
    expect(b.engine.status().transfers[0].received).toBe(e.manifest.total);
    // Exhaustion again at completion: nothing partial.
    b.store.db.exec("VACUUM");
    b.store.db.pragma("wal_checkpoint(TRUNCATE)");
    const full = (b.store.db.prepare("PRAGMA page_count").get() as any)
      .page_count as number;
    b.store.db.pragma(`max_page_count = ${full + 2}`);
    const before = dump(b);
    expect(() => b.engine.completeImport(e.manifest.id)).toThrow();
    b.store.db.pragma("max_page_count = 1073741823");
    expect(dump(b)).toEqual(before);
    expect(b.engine.completeImport(e.manifest.id).replay).toBe(false);
    expect(recordText(b)).toBe(text);
  });

  test("a local edit made while a transfer is in flight becomes a conflict, never an overwrite", async () => {
    const { a, b } = await pair();
    stage(a, "base");
    deliver(b, envelope(a, b));
    stage(a, "A in flight ".repeat(8000));
    const e = envelope(a, b);
    b.engine.beginImport(e.manifest);
    b.engine.receiveChunk(e.manifest.id, e.chunks[0]);
    const local = stage(b, "B concurrent local edit");
    for (const chunk of e.chunks.slice(1))
      b.engine.receiveChunk(e.manifest.id, chunk);
    const r = b.engine.completeImport(e.manifest.id);
    expect(r.receipt.conflicts).toHaveLength(1);
    expect(b.store.get<any>("replica-record", "artifact").revision).toBe(
      local.revision,
    );
    // Repeated reconciliation of the same transfer adds nothing.
    const settled = dump(b);
    for (let i = 0; i < 3; i++)
      expect(b.engine.completeImport(e.manifest.id).replay).toBe(true);
    expect(dump(b)).toEqual(settled);
  });

  // CAMPAIGN DEFECT REPL-10: expired approval previews (with full portable content) are never pruned (packages/replication/local.ts:317-356).
  test.fails("expired approval previews do not accumulate", async () => {
    const a = await device("A");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    for (let i = 0; i < 5; i++)
      a.engine.previewStage(`draft-${i}`, "project", {
        kind: "artifact",
        label: "Declined draft",
        files: [{ path: "draft.txt", text: `declined draft ${i}` }],
      });
    vi.setSystemTime(new Date("2026-10-19T11:00:00.000Z"));
    restart(a);
    a.engine.previewStage("current", "project", {
      kind: "artifact",
      label: "Current",
      files: [{ path: "current.txt", text: "current" }],
    });
    const expired = rows(a, "replication-plan").filter(
      (p) => Date.parse(p.expiresAt) <= Date.now(),
    );
    expect(expired).toHaveLength(0);
  });
});

describe("J-14 encrypted replication journey through the service command boundary", () => {
  test("interrupted transfer, restart, resumed import, conflict, owner resolution, deletion and replay", async () => {
    const make = async () => {
      const f = await fixture();
      f.store.close();
      const ref = {
        directory: f.directory,
        key: f.key,
        service: new Service(f.directory, f.key, () => {}, true),
      };
      cleanup.push(async () => {
        await ref.service.close();
        await rm(f.directory, { recursive: true, force: true });
      });
      ref.service.store.put("project", {
        id: "project",
        name: "Journey",
        path: f.directory,
        realPath: f.directory,
        trusted: true,
        createdAt: now(),
      });
      return ref;
    };
    const A = await make(),
      B = await make();
    const cmd = (
      ref: typeof A,
      raw: unknown,
      trusted: Parameters<Service["command"]>[1] = {},
    ) => ref.service.command(commandSchema.parse(raw), trusted);
    const apply = async (ref: typeof A, plan: { id: string; digest: string }) =>
      cmd(
        ref,
        { type: "replication-plan-apply", requestId: uid(), id: plan.id },
        { digest: plan.digest },
      );
    for (const ref of [A, B])
      await cmd(ref, {
        type: "optional-feature-set",
        requestId: uid(),
        feature: "multi-device",
        enabled: true,
      });
    await apply(
      A,
      await cmd(A, { type: "replication-owner-preview", projectId: "project" }),
    );
    const idA = (await cmd(A, { type: "replication-query" })).identity,
      idB = (await cmd(B, { type: "replication-query" })).identity;
    await apply(
      A,
      await cmd(A, {
        type: "replication-device-preview",
        identity: idB,
        approvedProjectIds: ["project"],
      }),
    );
    await apply(
      B,
      await cmd(B, {
        type: "replication-device-preview",
        identity: idA,
        approvedProjectIds: ["project"],
      }),
    );
    const stageOn = async (ref: typeof A, text: string) =>
      apply(
        ref,
        await cmd(ref, {
          type: "replication-stage-preview",
          recordId: "journey",
          projectId: "project",
          content: {
            kind: "artifact",
            label: "Journey report",
            files: [{ path: "report.txt", text }],
          },
        }),
      );
    const exportTo = async (from: typeof A, to: string) => {
      const manifest: TransferManifest = await apply(
        from,
        await cmd(from, {
          type: "replication-export-preview",
          targetDeviceId: to,
          recordIds: ["journey"],
        }),
      );
      const chunks: EncryptedChunk[] = [];
      for (let index = 0; index < manifest.total; index++)
        chunks.push(
          await cmd(from, {
            type: "replication-chunk",
            id: manifest.id,
            index,
          }),
        );
      return { manifest, chunks };
    };
    const importAll = async (to: typeof A, e: Envelope) => {
      await cmd(to, {
        type: "replication-import-begin",
        requestId: uid(),
        manifest: e.manifest,
      });
      for (const chunk of e.chunks)
        await cmd(to, {
          type: "replication-import-chunk",
          requestId: uid(),
          id: e.manifest.id,
          chunk,
        });
      return cmd(to, {
        type: "replication-import-complete",
        requestId: uid(),
        id: e.manifest.id,
      });
    };
    const canary = `journey-canary-${uid()}`;
    await stageOn(A, `${canary} `.repeat(5000));
    const first = await exportTo(A, idB.id);
    expect(first.manifest.total).toBeGreaterThan(1);
    expect(stable(first)).not.toContain(canary);
    // Interrupted transfer: one chunk, then the receiver's service restarts.
    await cmd(B, {
      type: "replication-import-begin",
      requestId: uid(),
      manifest: first.manifest,
    });
    await cmd(B, {
      type: "replication-import-chunk",
      requestId: uid(),
      id: first.manifest.id,
      chunk: first.chunks[0],
    });
    await B.service.close();
    B.service = new Service(B.directory, B.key, () => {}, true);
    const resumed = await cmd(B, {
      type: "replication-import-begin",
      requestId: uid(),
      manifest: first.manifest,
    });
    expect(resumed).toMatchObject({ received: 1, replay: false });
    for (const chunk of first.chunks.slice(1))
      await cmd(B, {
        type: "replication-import-chunk",
        requestId: uid(),
        id: first.manifest.id,
        chunk,
      });
    await cmd(B, {
      type: "replication-import-complete",
      requestId: uid(),
      id: first.manifest.id,
    });
    // Local authority remains separate: B is a replica and runs nothing.
    expect(() => B.service.replication.assertLocalOwner("project")).toThrow(
      /replica/,
    );
    expect([...B.service.store.iterate("attempt")]).toHaveLength(0);
    expect([...B.service.store.iterate("run")]).toHaveLength(0);
    // Conflict and explicit owner resolution on B.
    await stageOn(A, "A journey edit");
    await stageOn(B, "B journey edit");
    const delayedAncestor = await exportTo(A, idB.id);
    const conflicted = await importAll(B, await exportTo(A, idB.id));
    expect(conflicted.receipt.conflicts).toHaveLength(1);
    const preview = await cmd(B, {
      type: "replication-conflict-preview",
      id: conflicted.receipt.conflicts[0],
    });
    await expect(
      cmd(B, {
        type: "replication-conflict-resolve",
        requestId: uid(),
        id: preview.id,
        choice: "local",
      }),
    ).rejects.toThrow(/Native review/);
    const resolved = await cmd(
      B,
      {
        type: "replication-conflict-resolve",
        requestId: uid(),
        id: preview.id,
        choice: "local",
      },
      { digest: preview.digest },
    );
    await importAll(B, delayedAncestor);
    expect(B.service.store.get<any>("replica-record", "journey").revision).toBe(
      resolved.revision,
    );
    await importAll(A, await exportTo(B, idA.id));
    expect(A.service.store.get<any>("replica-record", "journey").revision).toBe(
      resolved.revision,
    );
    // Deletion on the owner propagates; replay after B's restart cannot resurrect.
    const preDeletion = await exportTo(A, idB.id);
    await cmd(
      A,
      {
        type: "replication-delete",
        requestId: uid(),
        recordId: "journey",
        projectId: "project",
      },
      { approved: true },
    );
    await importAll(B, await exportTo(A, idB.id));
    await B.service.close();
    B.service = new Service(B.directory, B.key, () => {}, true);
    expect((await importAll(B, first)).replay).toBe(true);
    await importAll(B, preDeletion);
    expect(B.service.store.get("replica-record", "journey")).toBeUndefined();
    expect(B.service.store.get("replication-tombstone", "journey")).toEqual({
      id: "journey",
      projectId: "project",
      deleted: true,
    });
    for (const ref of [A, B]) {
      expect(
        stable(
          ref.service.store.db.prepare("SELECT body FROM documents").all(),
        ),
      ).not.toContain(canary);
      expect(
        stable(ref.service.store.db.prepare("SELECT body FROM events").all()),
      ).not.toContain(canary);
    }
    const status = await cmd(B, {
      type: "replication-query",
      projectId: "project",
    });
    expect(status).toMatchObject({
      remoteControl: "unsupported",
      conflicts: [],
      transfers: [],
      records: [],
    });
  });
});
