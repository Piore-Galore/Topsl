import { z } from "zod";
const id = z.string().min(1).max(300),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const deviceIdentitySchema = z
  .object({
    id: digest,
    label: z.string().trim().min(1).max(100),
    signingPublicKey: z.string().min(1).max(300),
    exchangePublicKey: z.string().min(1).max(300),
  })
  .strict();
export type DeviceIdentity = z.infer<typeof deviceIdentitySchema>;
const fileSchema = z
  .object({
    path: z.string().min(1).max(1000),
    text: z.string().max(1_000_000),
  })
  .strict();
/** Export uses a separate strict payload vocabulary. Native records are never serialized. */
export const portableContentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("project-metadata"),
      name: z.string().max(200),
      description: z.string().max(20000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("specification"),
      objective: z.string().max(20000),
      acceptanceCriteria: z.array(z.string().max(5000)).max(100),
      interfaces: z.array(z.string().max(20000)).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      label: z.string().max(200),
      files: z.array(fileSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace-reference"),
      logicalWorkspaceId: id,
      label: z.string().max(200),
    })
    .strict(),
]);
export type PortableContent = z.infer<typeof portableContentSchema>;
const portableRecordSchema = z
  .object({
    id,
    projectId: id,
    content: portableContentSchema,
    revision: digest,
    parentRevision: digest.nullable(),
  })
  .strict();
export type PortableRecord = z.infer<typeof portableRecordSchema>;
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
export const chunkSchema = z
  .object({
    index: z.number().int().min(0).max(100),
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
    ciphertext: z.string().max(90000),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export type EncryptedChunk = z.infer<typeof chunkSchema>;
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
export const transferManifestSchema = headerSchema
  .extend({ signature: z.string().min(1).max(150) })
  .strict();
export type TransferManifest = z.infer<typeof transferManifestSchema>;
