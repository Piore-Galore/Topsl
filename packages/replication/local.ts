import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { z } from "zod";
import { hash, now, stable, uid } from "../domain/invariants";
import type { Store } from "../persistence/store";
import { canonicalWorkspaceIdentity } from "../workspace/ownership";

import {
  deviceIdentitySchema,
  portableContentSchema,
  transferManifestSchema,
  chunkSchema,
  type DeviceIdentity,
  type PortableContent,
  type PortableRecord,
  type EncryptedChunk,
  type TransferManifest,
} from "../domain/replication-inputs";
export { deviceIdentitySchema, portableContentSchema, transferManifestSchema };
export type {
  DeviceIdentity,
  PortableContent,
  PortableRecord,
  EncryptedChunk,
  TransferManifest,
};
const id = z.string().min(1).max(300),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const portableRecordSchema = z
  .object({
    id,
    projectId: id,
    content: portableContentSchema,
    revision: digest,
    parentRevision: digest.nullable(),
  })
  .strict();
const tombstoneSchema = z
  .object({ id, projectId: id, deleted: z.literal(true) })
  .strict();
type Tombstone = z.infer<typeof tombstoneSchema>;
const ownerSchema = z
  .object({
    projectId: id,
    ownerDeviceId: digest,
    generation: z.number().int().positive(),
  })
  .strict();
const payloadSchema = z
  .object({
    records: z.array(portableRecordSchema).max(100),
    tombstones: z.array(tombstoneSchema).max(100),
    owners: z.array(ownerSchema).max(100),
  })
  .strict();
const headerSchema = z
  .object({
    protocol: z.literal(1),
    id: z.string().uuid(),
    senderDeviceId: digest,
    targetDeviceId: digest,
    total: z.number().int().min(1).max(40),
    bytes: z.number().int().min(1).max(2_000_000),
    payloadHash: digest,
    chunkHashes: z.array(digest).min(1).max(40),
  })
  .strict();
interface IdentitySecrets extends DeviceIdentity {
  signingPrivateKey: string;
  exchangePrivateKey: string;
}
interface Peer extends DeviceIdentity {
  approvedAt: string;
  approvalRevision: string;
  approvedProjectIds: string[];
  connected: boolean;
  observation: string;
}
interface OwnerObservation {
  id: string;
  projectId: string;
  peerId: string;
  approvalRevision: string;
  ownerDeviceId: string;
  generation: number;
  sourceTransferId: string;
  observedAt: string;
}
interface PendingTransfer {
  id: string;
  manifest: TransferManifest;
  chunks: EncryptedChunk[];
  direction: "outgoing" | "incoming";
  recordIds: string[];
}
interface ReplicationReceipt {
  id: string;
  digest: string;
  senderDeviceId: string;
  importedAt: string;
  recordIds: string[];
  conflicts: string[];
  chunkHashes: string[];
}
interface ApprovalPlan {
  id: string;
  kind: "device" | "mapping" | "export" | "stage" | "owner";
  projectId?: string;
  payload: unknown;
  digest: string;
  expiresAt: string;
}
export interface ReplicationNativeInput {
  digest?: string;
}
const publicPem = (value: string) =>
  createPublicKey({
    key: Buffer.from(value, "base64"),
    type: "spki",
    format: "der",
  });
const privatePem = (value: string) =>
  createPrivateKey({
    key: Buffer.from(value, "base64"),
    type: "pkcs8",
    format: "der",
  });
const identityHash = (
  value: Pick<DeviceIdentity, "signingPublicKey" | "exchangePublicKey">,
) => hash(stable([value.signingPublicKey, value.exchangePublicKey]));
const recordHash = (
  record: Pick<
    PortableRecord,
    "id" | "projectId" | "content" | "parentRevision"
  >,
) => hash(stable(record));
const protectedPath =
  /(^|\/)(\.git|\.topsl|\.codex|\.claude|\.ssh|\.aws|\.config|context-grants|node_modules)(\/|$)|(^|\/)(\.env(?:\..*)?|\.claude\.json|\.codex-global-state\.json|auth\.json|credentials(?:\..*)?|config\.toml|.*(?:sqlite(?:-(?:wal|shm))?|\.db(?:-(?:wal|shm))?|\.wal|[-.]shm)|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const sensitiveKey =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|approval[_-]?token|grant|grants|credential|credentials|private[_-]?key|authorization|trustRevision|approvalDigest|leaseGeneration)$/i;
const secretText =
  /-----BEGIN [\w ]*PRIVATE KEY-----|\bsk-[a-z0-9_-]{12,}|\bBearer\s+\S+|["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|client[_-]?secret|approval[_-]?token|private[_-]?key|authorization)["']?\s*[=:]\s*["']?\S+/i;
function hasSensitiveJson(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveJson);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) => sensitiveKey.test(key) || hasSensitiveJson(item),
    );
  if (typeof value === "string") {
    if (secretText.test(value)) return true;
    try {
      const parsed = JSON.parse(value);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        hasSensitiveJson(parsed)
      );
    } catch {
      return false;
    }
  }
  return false;
}
function safeContent(raw: PortableContent): PortableContent {
  const content = portableContentSchema.parse(raw);
  if (secretText.test(stable(content)) || hasSensitiveJson(content))
    throw new Error(
      "Secret-like material is excluded from portable payloads. Review a sanitized artifact.",
    );
  if (content.kind === "artifact") {
    if (new Set(content.files.map((f) => f.path)).size !== content.files.length)
      throw new Error("Portable artifact paths must be unique.");
    for (const f of content.files)
      if (
        !f.path ||
        f.path.includes("\\") ||
        f.path.includes("\0") ||
        f.path.startsWith("/") ||
        /^[a-z]:/i.test(f.path) ||
        f.path.split("/").some((c) => !c || c === "." || c === "..") ||
        protectedPath.test(f.path)
      )
        throw new Error(
          "Native databases, credentials, trust/configuration files and unbounded paths cannot be replicated.",
        );
  }
  if (Buffer.byteLength(stable(content)) > 1_000_000)
    throw new Error("Portable content exceeds the bounded artifact limit.");
  return content;
}
/** Optional portable file transport. It never opens a socket, scans disks, installs code,
 * grants workspace trust, replicates a vault, or obtains execution authority remotely. */
export class LocalReplication {
  private enabled: boolean;
  private identitySecret: IdentitySecrets;
  constructor(
    readonly store: Store,
    options: { enabled?: boolean; label?: string } = {},
  ) {
    this.enabled = options.enabled ?? false;
    const saved = store.get<IdentitySecrets>("replication-identity", "local");
    if (saved) this.identitySecret = saved;
    else {
      const signing = generateKeyPairSync("ed25519"),
        exchange = generateKeyPairSync("x25519");
      const keys = {
        signingPublicKey: signing.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        exchangePublicKey: exchange.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      };
      this.identitySecret = {
        ...keys,
        id: identityHash(keys),
        label: options.label ?? "Local Topsl profile",
        signingPrivateKey: signing.privateKey
          .export({ type: "pkcs8", format: "der" })
          .toString("base64"),
        exchangePrivateKey: exchange.privateKey
          .export({ type: "pkcs8", format: "der" })
          .toString("base64"),
      };
      // Store is the existing SQLCipher vault; private identity keys never leave this record.
      store.put("replication-identity", {
        ...this.identitySecret,
        id: "local",
        deviceId: this.identitySecret.id,
      });
    }
    if (saved) {
      const { deviceId, ...secrets } = saved as IdentitySecrets & {
        deviceId: string;
      };
      this.identitySecret = { ...secrets, id: deviceId };
    }
  }
  identity(): DeviceIdentity {
    const {
      signingPrivateKey: _,
      exchangePrivateKey: __,
      ...identity
    } = this.identitySecret;
    return deviceIdentitySchema.parse(identity);
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    return {
      enabled,
      transport: "portable-local",
      remoteControl: "unsupported",
      safetyChecks: "always-enforced",
    };
  }
  private assertEnabled() {
    if (!this.enabled)
      throw new Error("Optional multi-device replication is disabled.");
  }
  status(projectId?: string) {
    return {
      enabled: this.enabled,
      identity: this.identity(),
      transport: "portable-local",
      remoteControl: "unsupported",
      networkConnectivity: "not-observed; explicit local import/export only",
      devices: [...this.store.iterate<Peer>("replication-peer")].map((p) => ({
        ...p,
        connected: p.connected,
      })),
      mappings: [
        ...this.store.iterate(
          "replication-mapping",
          projectId ? { projectId } : {},
        ),
      ],
      records: [
        ...this.store.iterate<PortableRecord>(
          "replica-record",
          projectId ? { projectId } : {},
        ),
      ].map(({ content, ...r }) => ({ ...r, kind: content.kind })),
      conflicts: [
        ...this.store.iterate(
          "replication-conflict",
          projectId ? { projectId } : {},
        ),
      ].map((c: any) => ({
        id: c.id,
        projectId: c.projectId,
        recordId: c.recordId,
        reason: c.reason,
      })),
      owner: projectId
        ? (this.store.get("replication-owner", projectId) ?? null)
        : null,
      transfers: [
        ...this.store.iterate<PendingTransfer>("replication-transfer"),
      ].map((t) => ({
        id: t.id,
        direction: t.direction,
        received: t.chunks.length,
        total: t.manifest.total,
      })),
    };
  }
  private preview(
    kind: ApprovalPlan["kind"],
    payload: unknown,
    projectId?: string,
  ) {
    this.assertEnabled();
    const plan: ApprovalPlan = {
      id: uid(),
      kind,
      ...(projectId ? { projectId } : {}),
      payload,
      digest: "",
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const { digest: _, ...body } = plan;
    plan.digest = hash(stable(body));
    this.store.put("replication-plan", plan);
    return plan;
  }
  private consume(
    planId: string,
    kind: ApprovalPlan["kind"],
    trusted: ReplicationNativeInput,
  ) {
    this.assertEnabled();
    const plan = this.store.get<ApprovalPlan>("replication-plan", planId);
    if (!plan || plan.kind !== kind || Date.parse(plan.expiresAt) <= Date.now())
      throw new Error("Replication approval is absent or expired.");
    const { digest: _, ...body } = plan;
    if (
      !trusted.digest ||
      plan.digest !== trusted.digest ||
      hash(stable(body)) !== plan.digest
    )
      throw new Error(
        "Replication requires native confirmation of this exact preview.",
      );
    this.store.remove("replication-plan", planId);
    return plan;
  }
  previewDevice(raw: DeviceIdentity, approvedProjectIds: string[] = []) {
    const identity = deviceIdentitySchema.parse(raw);
    if (
      identityHash(identity) !== identity.id ||
      identity.id === this.identity().id ||
      publicPem(identity.signingPublicKey).asymmetricKeyType !== "ed25519" ||
      publicPem(identity.exchangePublicKey).asymmetricKeyType !== "x25519"
    )
      throw new Error("Device identity/key type is invalid.");
    if (
      !approvedProjectIds.length ||
      approvedProjectIds.length > 100 ||
      new Set(approvedProjectIds).size !== approvedProjectIds.length
    )
      throw new Error(
        "Device approval requires an explicit project allowlist.",
      );
    approvedProjectIds.forEach((projectId) => id.parse(projectId));
    return this.preview("device", {
      identity,
      approvedProjectIds: [...approvedProjectIds].sort(),
    });
  }
  approveDevice(planId: string, trusted: ReplicationNativeInput) {
    const plan = this.consume(planId, "device", trusted),
      payload = plan.payload as {
        identity: DeviceIdentity;
        approvedProjectIds: string[];
      },
      identity = deviceIdentitySchema.parse(payload.identity);
    const previous = this.store.get<Peer>("replication-peer", identity.id),
      affectedProjects = [
        ...new Set([
          ...(previous?.approvedProjectIds ?? []),
          ...payload.approvedProjectIds,
        ]),
      ];
    for (const projectId of affectedProjects)
      if (this.projectBusy(projectId))
        throw new Error(
          "Stop and reconcile current execution and writer leases before associating or reapproving a shared project/device.",
        );
    this.store.transaction(() => {
      this.clearPeerObservations(identity.id);
      this.clearPeerTransfers(identity.id);
      this.store.put("replication-peer", {
        ...identity,
        approvedProjectIds: payload.approvedProjectIds,
        approvalRevision: uid(),
        approvedAt: now(),
        connected: false,
        observation:
          "Approved identity and exact project allowlist. Matching authenticated owner observation is required; ongoing liveness is unavailable.",
      });
      for (const projectId of payload.approvedProjectIds)
        this.store.put("replication-shared-project", {
          id: projectId,
          projectId,
          association: "explicit-native-device-approval",
        });
    });
    return identity;
  }
  revokeDevice(deviceId: string) {
    this.store.transaction(() => {
      this.store.remove("replication-peer", deviceId);
      this.clearPeerObservations(deviceId);
      this.clearPeerTransfers(deviceId);
    });
  }
  previewMapping(projectId: string, logicalWorkspaceId: string, root: string) {
    if (!this.store.get("project", projectId))
      throw new Error(
        "Locally known project is required before folder approval.",
      );
    const identity = canonicalWorkspaceIdentity(root);
    return this.preview(
      "mapping",
      { projectId, logicalWorkspaceId, ...identity },
      projectId,
    );
  }
  approveMapping(planId: string, trusted: ReplicationNativeInput) {
    const plan = this.consume(planId, "mapping", trusted),
      value = plan.payload as {
        projectId: string;
        logicalWorkspaceId: string;
        canonicalRoot: string;
        filesystemIdentity: string;
      };
    const current = canonicalWorkspaceIdentity(value.canonicalRoot);
    if (current.filesystemIdentity !== value.filesystemIdentity)
      throw new Error("Folder identity changed after the native preview.");
    const mapping = {
      id: `${value.projectId}:${value.logicalWorkspaceId}`,
      ...value,
      deviceId: this.identity().id,
      availability: "available",
      trust: "local-folder-confirmed",
      approvedAt: now(),
      executionAuthorization:
        "none; separate workspace trust and dispatch approval required",
    };
    this.store.put("replication-mapping", mapping);
    return mapping;
  }
  previewOwner(projectId: string) {
    if (
      !this.store.get("project", projectId) ||
      this.store.get("replication-owner", projectId) ||
      this.store.get("replication-shared-project", projectId)
    )
      throw new Error(
        "Initialize a local-origin owner before its first peer association. Imported/unknown/shared authority cannot be self-designated or transferred.",
      );
    return this.preview(
      "owner",
      { projectId, ownerDeviceId: this.identity().id, generation: 1 },
      projectId,
    );
  }
  approveOwner(planId: string, trusted: ReplicationNativeInput) {
    const plan = this.consume(planId, "owner", trusted),
      value = ownerSchema.parse(plan.payload);
    if (
      this.store.get("replication-owner", value.projectId) ||
      this.store.get("replication-shared-project", value.projectId) ||
      this.projectBusy(value.projectId)
    )
      throw new Error(
        "Authority was associated or execution changed after preview; no ownership substitution is supported.",
      );
    this.store.put("replication-owner", { ...value, id: value.projectId });
    return value;
  }
  assertLocalOwner(
    projectId: string,
    action: "execution" | "integration" = "execution",
  ) {
    const owner = this.store.get<{ ownerDeviceId: string; generation: number }>(
      "replication-owner",
      projectId,
    );
    if (!owner) {
      if (this.store.get("replication-shared-project", projectId))
        throw new Error(
          "Shared project authority is unknown. Authoritative work pauses until its designated owner is observed; local self-designation is forbidden.",
        );
      return;
    }
    if (owner.ownerDeviceId !== this.identity().id)
      throw new Error(
        "This device is a replica; authoritative execution/integration belongs to the designated owner host. Isolated local proposals may continue.",
      );
    if (this.store.get("replication-owner-conflict", projectId))
      throw new Error(
        "Conflicting owner observation pauses authoritative work; no partitioned ownership transfer is permitted.",
      );
    const peers = [...this.store.iterate<Peer>("replication-peer")].filter(
      (p) => p.approvedProjectIds.includes(projectId),
    );
    if (
      peers.some((peer) => {
        const observation = this.store.get<OwnerObservation>(
          "replication-owner-observation",
          `${peer.id}:${projectId}`,
        );
        return (
          !peer.approvalRevision ||
          !observation ||
          observation.peerId !== peer.id ||
          observation.approvalRevision !== peer.approvalRevision ||
          observation.ownerDeviceId !== owner.ownerDeviceId ||
          observation.generation !== owner.generation
        );
      })
    )
      throw new Error(
        "Shared authoritative work pauses until every approved project peer supplies a matching authenticated owner observation under its current approval policy.",
      );
    if (action === "integration" && peers.some((p) => !p.connected))
      throw new Error(
        "Shared integration pauses without a current peer observation. Portable transport cannot prove ongoing liveness or transfer ownership.",
      );
  }
  previewStage(recordId: string, projectId: string, raw: PortableContent) {
    const content = safeContent(raw);
    id.parse(recordId);
    id.parse(projectId);
    if (!this.store.get("project", projectId))
      throw new Error(
        "Only explicitly selected locally known projects can be exported.",
      );
    if (this.store.get("replication-tombstone", recordId))
      throw new Error(
        "Deleted replica identities cannot be resurrected; create an explicit new record identity.",
      );
    return this.preview(
      "stage",
      { id: recordId, projectId, content },
      projectId,
    );
  }
  approveStage(planId: string, trusted: ReplicationNativeInput) {
    const plan = this.consume(planId, "stage", trusted),
      input = plan.payload as Pick<
        PortableRecord,
        "id" | "projectId" | "content"
      >;
    if (this.store.get("replication-tombstone", input.id))
      throw new Error("Deletion occurred after preview.");
    const previous = this.store.get<PortableRecord>("replica-record", input.id);
    if (previous && previous.projectId !== input.projectId)
      throw new Error("Replica identity belongs to another project.");
    const basis = {
        ...input,
        content: safeContent(input.content),
        parentRevision: previous?.revision ?? null,
      },
      value = { ...basis, revision: recordHash(basis) };
    this.store.put("replica-record", value);
    this.trackRevision(value);
    return value;
  }
  previewExport(targetDeviceId: string, recordIds: string[]) {
    const peer = this.peer(targetDeviceId);
    if (
      !recordIds.length ||
      recordIds.length > 100 ||
      new Set(recordIds).size !== recordIds.length
    )
      throw new Error(
        "Export requires one to one hundred explicit unique record identities.",
      );
    const records = recordIds.flatMap((recordId) => {
      const record = this.store.get<PortableRecord>("replica-record", recordId);
      return record ? [record] : [];
    });
    const tombstones = recordIds.flatMap((recordId) => {
      const t = this.store.get<Tombstone>("replication-tombstone", recordId);
      return t ? [t] : [];
    });
    if (records.length + tombstones.length !== recordIds.length)
      throw new Error("An explicitly selected replica record is unavailable.");
    if (
      [...records, ...tombstones].some(
        (r) => !peer.approvedProjectIds.includes(r.projectId),
      )
    )
      throw new Error(
        "Project is outside this device's locally approved allowlist.",
      );
    for (const record of records) safeContent(record.content);
    const owners = [
      ...new Set([...records, ...tombstones].map((r) => r.projectId)),
    ].map((projectId) => {
      const owner = this.store.get("replication-owner", projectId);
      if (!owner)
        throw new Error(
          "Designate one authoritative owner before exporting project metadata.",
        );
      return ownerSchema.parse(
        owner &&
          (({ projectId, ownerDeviceId, generation }: any) => ({
            projectId,
            ownerDeviceId,
            generation,
          }))(owner),
      );
    });
    return this.preview("export", {
      targetDeviceId,
      payload: { records, tombstones, owners },
    });
  }
  exportApproved(
    planId: string,
    trusted: ReplicationNativeInput,
  ): TransferManifest {
    const plan = this.consume(planId, "export", trusted),
      selected = plan.payload as {
        targetDeviceId: string;
        payload: z.infer<typeof payloadSchema>;
      },
      peer = this.peer(selected.targetDeviceId),
      payload = payloadSchema.parse(selected.payload);
    for (const record of payload.records)
      if (
        this.store.get<PortableRecord>("replica-record", record.id)
          ?.revision !== record.revision ||
        this.store.get("replication-tombstone", record.id) ||
        !peer.approvedProjectIds.includes(record.projectId)
      )
        throw new Error("Selected export changed after preview.");
    const plaintext = Buffer.from(stable(payload));
    if (plaintext.length > 2_000_000)
      throw new Error("Transfer exceeds the bounded envelope limit.");
    const transferId = uid(),
      key = this.key(peer, transferId),
      total = Math.ceil(plaintext.length / 65536),
      header: z.infer<typeof headerSchema> = {
        protocol: 1,
        id: transferId,
        senderDeviceId: this.identity().id,
        targetDeviceId: peer.id,
        total,
        bytes: plaintext.length,
        payloadHash: hash(plaintext),
        chunkHashes: [],
      };
    const chunks: EncryptedChunk[] = [];
    for (let index = 0; index < total; index++) {
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(this.aad(header, index)));
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
    key.fill(0);
    plaintext.fill(0);
    header.chunkHashes = chunks.map((c) => hash(stable(c)));
    const manifest: TransferManifest = {
      ...header,
      signature: sign(
        null,
        Buffer.from(stable(header)),
        privatePem(this.identitySecret.signingPrivateKey),
      ).toString("base64"),
    };
    this.store.put("replication-transfer", {
      id: manifest.id,
      direction: "outgoing",
      manifest,
      chunks,
      recordIds: [...payload.records, ...payload.tombstones].map((r) => r.id),
    } satisfies PendingTransfer);
    return manifest;
  }
  outgoingChunk(transferId: string, index: number): EncryptedChunk {
    this.assertEnabled();
    const transfer = this.store.get<PendingTransfer>(
      "replication-transfer",
      transferId,
    );
    if (!transfer || transfer.direction !== "outgoing")
      throw new Error("Outgoing encrypted transfer is unavailable.");
    this.peer(transfer.manifest.targetDeviceId);
    const chunk = transfer.chunks.find((c) => c.index === index);
    if (!chunk) throw new Error("Chunk index is unavailable.");
    return chunk;
  }
  beginImport(raw: TransferManifest) {
    this.assertEnabled();
    const manifest = transferManifestSchema.parse(raw),
      peer = this.peer(manifest.senderDeviceId),
      { signature, ...header } = manifest;
    if (
      manifest.targetDeviceId !== this.identity().id ||
      header.chunkHashes.length !== header.total ||
      header.total !== Math.ceil(header.bytes / 65536) ||
      !verify(
        null,
        Buffer.from(stable(header)),
        publicPem(peer.signingPublicKey),
        Buffer.from(signature, "base64"),
      )
    )
      throw new Error("Transfer signature, recipient or bounds are invalid.");
    const receipt = this.store.get<{ digest: string }>(
      "replication-receipt",
      manifest.id,
    );
    if (receipt) {
      if (receipt.digest !== hash(stable(manifest)))
        throw new Error("Replay identity changed.");
      return {
        id: manifest.id,
        received: manifest.total,
        total: manifest.total,
        replay: true,
      };
    }
    const previous = this.store.get<PendingTransfer>(
      "replication-transfer",
      manifest.id,
    );
    if (previous && stable(previous.manifest) !== stable(manifest))
      throw new Error(
        "Partial transfer manifest changed; no mixed chunks are accepted.",
      );
    if (!previous)
      this.store.put("replication-transfer", {
        id: manifest.id,
        manifest,
        chunks: [],
        direction: "incoming",
        recordIds: [],
      } satisfies PendingTransfer);
    return {
      id: manifest.id,
      received: previous?.chunks.length ?? 0,
      total: manifest.total,
      replay: false,
    };
  }
  receiveChunk(transferId: string, raw: EncryptedChunk) {
    this.assertEnabled();
    const transfer = this.store.get<PendingTransfer>(
        "replication-transfer",
        transferId,
      ),
      chunk = chunkSchema.parse(raw);
    const receipt = this.store.get<ReplicationReceipt>(
      "replication-receipt",
      transferId,
    );
    if (receipt) {
      this.peer(receipt.senderDeviceId);
      if (receipt.chunkHashes[chunk.index] !== hash(stable(chunk)))
        throw new Error("Completed transfer chunk replay changed.");
      return {
        received: receipt.chunkHashes.length,
        total: receipt.chunkHashes.length,
        replay: true,
      };
    }
    if (!transfer || transfer.direction !== "incoming")
      throw new Error("Begin the explicitly approved sender's transfer first.");
    this.peer(transfer.manifest.senderDeviceId);
    if (
      chunk.index >= transfer.manifest.total ||
      hash(stable(chunk)) !== transfer.manifest.chunkHashes[chunk.index]
    )
      throw new Error("Encrypted chunk integrity failed.");
    const previous = transfer.chunks.find((c) => c.index === chunk.index);
    if (previous && stable(previous) !== stable(chunk))
      throw new Error("Chunk replay changed.");
    if (!previous)
      this.store.put("replication-transfer", {
        ...transfer,
        chunks: [...transfer.chunks, chunk],
      });
    return {
      received: transfer.chunks.length + (previous ? 0 : 1),
      total: transfer.manifest.total,
    };
  }
  completeImport(transferId: string) {
    this.assertEnabled();
    const receipt = this.store.get<ReplicationReceipt>(
      "replication-receipt",
      transferId,
    );
    if (receipt) return { replay: true, receipt };
    const transfer = this.store.get<PendingTransfer>(
      "replication-transfer",
      transferId,
    );
    if (
      !transfer ||
      transfer.direction !== "incoming" ||
      transfer.chunks.length !== transfer.manifest.total
    )
      throw new Error(
        "Transfer is incomplete; resume the missing encrypted chunks.",
      );
    const peer = this.peer(transfer.manifest.senderDeviceId),
      key = this.key(peer, transferId);
    const buffers: Buffer[] = [];
    try {
      for (const chunk of transfer.chunks.sort((a, b) => a.index - b.index)) {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(chunk.nonce, "hex"),
        );
        decipher.setAAD(Buffer.from(this.aad(transfer.manifest, chunk.index)));
        decipher.setAuthTag(Buffer.from(chunk.tag, "hex"));
        buffers.push(
          Buffer.concat([
            decipher.update(Buffer.from(chunk.ciphertext, "base64")),
            decipher.final(),
          ]),
        );
      }
    } catch (error) {
      buffers.forEach((b) => b.fill(0));
      throw error;
    } finally {
      key.fill(0);
    }
    const plaintext = Buffer.concat(buffers);
    buffers.forEach((b) => b.fill(0));
    if (
      plaintext.length !== transfer.manifest.bytes ||
      hash(plaintext) !== transfer.manifest.payloadHash
    ) {
      plaintext.fill(0);
      throw new Error("Transferred payload integrity failed.");
    }
    let payload: z.infer<typeof payloadSchema>;
    try {
      payload = payloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } finally {
      plaintext.fill(0);
    }
    const all = [...payload.records, ...payload.tombstones];
    if (
      new Set(all.map((r) => r.id)).size !== all.length ||
      new Set(payload.owners.map((o) => o.projectId)).size !==
        payload.owners.length
    )
      throw new Error(
        "Duplicate portable record/authority identities are invalid.",
      );
    if (
      all.some((r) => !peer.approvedProjectIds.includes(r.projectId)) ||
      payload.owners.some((o) => !peer.approvedProjectIds.includes(o.projectId))
    )
      throw new Error(
        "Transferred project is outside the sender's locally approved allowlist.",
      );
    for (const record of payload.records) {
      safeContent(record.content);
      const { revision: _, ...basis } = record;
      if (recordHash(basis) !== record.revision)
        throw new Error("Portable record revision integrity failed.");
    }
    if (
      all.some(
        (record) =>
          !payload.owners.some((o) => o.projectId === record.projectId),
      )
    )
      throw new Error("Portable project lacks a designated owner.");
    return this.store.transaction(() => {
      const conflicts: string[] = [];
      for (const owner of payload.owners) {
        const local = this.store.get<z.infer<typeof ownerSchema>>(
            "replication-owner",
            owner.projectId,
          ),
          observationId = `${peer.id}:${owner.projectId}`;
        if (
          !local &&
          (this.projectBusy(owner.projectId) ||
            owner.ownerDeviceId === this.identity().id)
        )
          throw new Error(
            "Remote metadata cannot confer new local execution authority or replace an active writer; observe a foreign designated owner after reconciliation.",
          );
        if (!local)
          this.store.put("replication-owner", {
            ...owner,
            id: owner.projectId,
          });
        if (
          local &&
          (local.ownerDeviceId !== owner.ownerDeviceId ||
            local.generation !== owner.generation)
        ) {
          this.store.remove("replication-owner-observation", observationId);
          this.store.put("replication-owner-conflict", {
            id: owner.projectId,
            projectId: owner.projectId,
            localOwnerDeviceId: local.ownerDeviceId,
            remoteOwnerDeviceId: owner.ownerDeviceId,
            action: "authoritative work paused; remote transfer unsupported",
          });
          conflicts.push(`owner:${owner.projectId}`);
        } else
          this.store.put("replication-owner-observation", {
            id: observationId,
            projectId: owner.projectId,
            peerId: peer.id,
            approvalRevision: peer.approvalRevision,
            ownerDeviceId: owner.ownerDeviceId,
            generation: owner.generation,
            sourceTransferId: transferId,
            observedAt: now(),
          } satisfies OwnerObservation);
      }
      for (const record of payload.records) {
        if (this.store.get("replication-tombstone", record.id)) continue;
        const local = this.store.get<PortableRecord>(
            "replica-record",
            record.id,
          ),
          commonId = `${peer.id}:${record.id}`,
          common = this.store.get<{ revision: string }>(
            "replication-common",
            commonId,
          );
        if (local && local.projectId !== record.projectId)
          throw new Error("Remote record collides with another project.");
        if (
          local &&
          this.isAncestor(record.id, record.revision, local.revision) &&
          local.revision !== record.revision
        )
          continue;
        if (
          !local ||
          local.revision === record.revision ||
          local.revision === record.parentRevision
        ) {
          this.store.put("replica-record", record);
          this.trackRevision(record);
          this.store.put("replication-common", {
            id: commonId,
            projectId: record.projectId,
            recordId: record.id,
            peerId: peer.id,
            revision: record.revision,
          });
          if (
            record.content.kind === "workspace-reference" &&
            !this.store.get(
              "replication-mapping",
              `${record.projectId}:${record.content.logicalWorkspaceId}`,
            )
          )
            this.store.put("replication-mapping", {
              id: `${record.projectId}:${record.content.logicalWorkspaceId}`,
              projectId: record.projectId,
              logicalWorkspaceId: record.content.logicalWorkspaceId,
              availability: "unavailable",
              trust: "untrusted",
              canonicalRoot: null,
              executionAuthorization:
                "none; local folder confirmation required",
            });
        } else {
          this.trackRevision(record);
          const conflictId = hash(
            stable(
              [peer.id, record.id, local.revision, record.revision].sort(),
            ),
          );
          this.store.put("replication-conflict", {
            id: conflictId,
            projectId: record.projectId,
            recordId: record.id,
            peerId: peer.id,
            commonRevision: common?.revision ?? record.parentRevision,
            local,
            remote: record,
            reason:
              "Both replicas changed or ancestry is unproven; explicit resolution required.",
          });
          conflicts.push(conflictId);
        }
      }
      for (const tombstone of payload.tombstones)
        this.deleteRecord(tombstone.id, tombstone.projectId);
      this.store.remove("replication-transfer", transferId);
      const value = {
        id: transferId,
        digest: hash(stable(transfer.manifest)),
        senderDeviceId: peer.id,
        importedAt: now(),
        recordIds: all.map((r) => r.id),
        conflicts,
        chunkHashes: transfer.manifest.chunkHashes,
      };
      this.store.put("replication-receipt", value);
      // Portable import is an observation, not a heartbeat. It cannot justify live ownership transfer.
      this.store.put("replication-peer", {
        ...peer,
        connected: false,
        observation: `Local import observed at ${now()}; ongoing connectivity unavailable.`,
      });
      return { replay: false, receipt: value };
    });
  }
  resolveConflict(
    conflictId: string,
    choice: "local" | "remote",
    trusted: ReplicationNativeInput,
  ) {
    const conflict = this.store.get<any>("replication-conflict", conflictId);
    if (!conflict || trusted.digest !== hash(stable(conflict)))
      throw new Error("Native review of the exact conflict is required.");
    if (this.store.get("replication-tombstone", conflict.recordId))
      throw new Error(
        "Deleted records cannot be resurrected by conflict resolution.",
      );
    const current = this.store.get<PortableRecord>(
      "replica-record",
      conflict.recordId,
    );
    if (current?.revision !== conflict.local.revision)
      throw new Error("Local conflict changed after review.");
    const basis = {
        id: conflict.local.id,
        projectId: conflict.local.projectId,
        content: conflict.local.content,
        parentRevision: conflict.remote.revision,
      },
      value =
        choice === "local"
          ? { ...basis, revision: recordHash(basis) }
          : conflict.remote;
    this.store.put("replica-record", value);
    this.trackRevision(value);
    this.store.remove("replication-conflict", conflictId);
    return value;
  }
  conflictPreview(conflictId: string) {
    const conflict = this.store.get("replication-conflict", conflictId);
    if (!conflict) throw new Error("Conflict is unavailable.");
    return { id: conflictId, conflict, digest: hash(stable(conflict)) };
  }
  deleteRecord(recordId: string, projectId: string) {
    id.parse(recordId);
    id.parse(projectId);
    const local = this.store.get<PortableRecord>("replica-record", recordId);
    if (local && local.projectId !== projectId)
      throw new Error("Deletion belongs to another project.");
    this.store.transaction(() => {
      this.store.remove("replica-record", recordId);
      this.store.put("replication-tombstone", {
        id: recordId,
        projectId,
        deleted: true,
      } satisfies Tombstone);
      for (const kind of [
        "replication-conflict",
        "replication-common",
        "replication-revision",
        "replication-plan",
        "replication-transfer",
      ])
        for (const record of this.store.iterate<any>(kind)) {
          // Remove every pending transfer on deletion: incoming encrypted metadata may contain this payload.
          if (
            kind === "replication-transfer" ||
            record.recordId === recordId ||
            record.payload?.id === recordId ||
            record.payload?.payload?.records?.some(
              (r: any) => r.id === recordId,
            )
          )
            this.store.remove(kind, record.id);
        }
    });
  }
  private peer(deviceId: string): Peer {
    this.assertEnabled();
    const peer = this.store.get<Peer>("replication-peer", deviceId);
    if (!peer)
      throw new Error(
        "Unapproved device; confirm its public fingerprint at the native user boundary first.",
      );
    return peer;
  }
  private clearPeerObservations(peerId: string) {
    for (const observation of this.store.iterate<OwnerObservation>(
      "replication-owner-observation",
    ))
      if (observation.peerId === peerId)
        this.store.remove("replication-owner-observation", observation.id);
  }
  private clearPeerTransfers(peerId: string) {
    for (const transfer of this.store.iterate<PendingTransfer>(
      "replication-transfer",
    ))
      if (
        transfer.manifest.senderDeviceId === peerId ||
        transfer.manifest.targetDeviceId === peerId
      )
        this.store.remove("replication-transfer", transfer.id);
  }
  private trackRevision(record: PortableRecord) {
    this.store.put("replication-revision", {
      id: `${record.id}:${record.revision}`,
      projectId: record.projectId,
      recordId: record.id,
      revision: record.revision,
      parentRevision: record.parentRevision,
    });
  }
  private isAncestor(
    recordId: string,
    possibleAncestor: string,
    currentRevision: string,
  ) {
    let revision: string | null = currentRevision;
    const seen = new Set<string>();
    while (revision && seen.size < 1000 && !seen.has(revision)) {
      if (revision === possibleAncestor) return true;
      seen.add(revision);
      revision =
        this.store.get<{ parentRevision: string | null }>(
          "replication-revision",
          `${recordId}:${revision}`,
        )?.parentRevision ?? null;
    }
    return false;
  }
  private projectBusy(projectId: string) {
    return (
      !!this.store.db
        .prepare(
          "SELECT attempt_id FROM workspace_leases WHERE state!='released' AND json_extract(body,'$.projectId')=? LIMIT 1",
        )
        .get(projectId) ||
      [...this.store.iterate<any>("attempt", { projectId })].some((a) =>
        [
          "prepared",
          "starting",
          "running",
          "awaiting-approval",
          "uncertain",
        ].includes(a.state),
      ) ||
      [...this.store.iterate<any>("run", { projectId })].some((r) =>
        ["starting", "running", "awaiting-approval", "uncertain"].includes(
          r.status,
        ),
      )
    );
  }
  private key(peer: DeviceIdentity, transferId: string) {
    const secret = diffieHellman({
      privateKey: privatePem(this.identitySecret.exchangePrivateKey),
      publicKey: publicPem(peer.exchangePublicKey),
    });
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        Buffer.from(transferId),
        Buffer.from(stable([this.identity().id, peer.id].sort())),
        32,
      ),
    );
    secret.fill(0);
    return key;
  }
  private aad(
    header: Pick<
      TransferManifest,
      | "protocol"
      | "id"
      | "senderDeviceId"
      | "targetDeviceId"
      | "total"
      | "bytes"
      | "payloadHash"
    >,
    index: number,
  ) {
    const {
      protocol,
      id,
      senderDeviceId,
      targetDeviceId,
      total,
      bytes,
      payloadHash,
    } = header;
    return stable({
      protocol,
      id,
      senderDeviceId,
      targetDeviceId,
      total,
      bytes,
      payloadHash,
      index,
    });
  }
}
