import { createHash } from "node:crypto";
import { now } from "../domain/invariants";
import type { Store } from "./store";
import os from "node:os";
import { randomBytes } from "node:crypto";

export const BLOB_CHUNK_BYTES = 64 * 1024;
/** Native execution records that may own protected blobs besides candidates. */
export type BlobOwnerKind =
  | "native-request-manifest"
  | "native-tool-output"
  | "native-capsule"
  | "native-evidence";
export interface BlobOwner {
  kind: BlobOwnerKind;
  id: string;
  projectId: string;
  name: string;
}
export const captureOwner = {
  pid: process.pid,
  host: os.hostname(),
  processToken: randomBytes(16).toString("hex"),
};
/** The only raw storage API. Callers publish scoped refs with the immutable
 * manifest in one transaction; readers cannot authorize from a hash alone. */
export class ProtectedBlobs {
  constructor(private store: Store) {}
  stage(captureId: string, ordinal: number, bytes: Buffer): void {
    if (bytes.length > BLOB_CHUNK_BYTES)
      throw new Error("Blob chunk exceeds the bounded I/O limit.");
    this.store.db
      .prepare("INSERT INTO protected_blob_staging VALUES(?,?,?,?)")
      .run(
        captureId,
        ordinal,
        bytes,
        createHash("sha256").update(bytes).digest("hex"),
      );
  }
  discard(captureId: string): void {
    this.store.db
      .prepare("DELETE FROM protected_blob_staging WHERE capture_id=?")
      .run(captureId);
  }
  /** True when the blob was new to the vault, false when it was already held. */
  publish(captureId: string, digest: string, bytes: number): boolean {
    return this.store.transaction(() => {
      const old = this.store.db
        .prepare("SELECT bytes FROM protected_blobs WHERE hash=?")
        .get(digest);
      if (old && old.bytes !== bytes)
        throw new Error("Protected blob hash collision.");
      if (!old) {
        this.store.db
          .prepare("INSERT INTO protected_blobs VALUES(?,?,?)")
          .run(digest, bytes, now());
        this.store.db
          .prepare(
            "INSERT INTO protected_blob_chunks SELECT ?,ordinal,bytes,chunk_hash FROM protected_blob_staging WHERE capture_id=?",
          )
          .run(digest, captureId);
      }
      this.discard(captureId);
      return !old;
    });
  }
  reference(
    projectId: string,
    candidateId: string,
    file: { path: string; hash: string | null },
  ): void {
    if (!file.hash) return;
    if (
      !this.store.db
        .prepare("SELECT 1 FROM protected_blobs WHERE hash=?")
        .get(file.hash)
    )
      throw new Error("Candidate blob is missing.");
    this.store.db
      .prepare("INSERT INTO protected_blob_refs VALUES(?,?,?,?)")
      .run(projectId, candidateId, file.path, file.hash);
  }
  usage(): number {
    return this.store.db
      .prepare(
        "SELECT (SELECT COALESCE(SUM(bytes),0) FROM protected_blobs)+(SELECT COALESCE(SUM(length(bytes)),0) FROM protected_blob_staging) AS bytes",
      )
      .get().bytes;
  }
  read(
    projectId: string,
    candidateId: string,
    file: { path: string; hash: string | null; bytes: number },
    offset = 0,
    length = file.bytes,
  ): Buffer | null {
    if (!file.hash) return null;
    const ref = this.store.db
      .prepare(
        "SELECT hash FROM protected_blob_refs WHERE project_id=? AND candidate_id=? AND path=?",
      )
      .get(projectId, candidateId, file.path);
    if (!ref || ref.hash !== file.hash)
      throw new Error(
        "No protected blob reference exists for this candidate scope.",
      );
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > file.bytes
    )
      throw new Error("Invalid candidate byte range.");
    const end = Math.min(file.bytes, offset + length),
      chunks = this.store.db
        .prepare(
          "SELECT ordinal,bytes,chunk_hash FROM protected_blob_chunks WHERE hash=? AND ordinal>=? AND ordinal<=? ORDER BY ordinal",
        )
        .all(
          file.hash,
          Math.floor(offset / BLOB_CHUNK_BYTES),
          Math.floor(Math.max(offset, end - 1) / BLOB_CHUNK_BYTES),
        );
    for (const row of chunks)
      if (
        createHash("sha256").update(row.bytes).digest("hex") !== row.chunk_hash
      )
        throw new Error("Protected candidate chunk integrity failed.");
    const result = Buffer.concat(
      chunks.map((row) => Buffer.from(row.bytes)),
    ).subarray(
      offset % BLOB_CHUNK_BYTES,
      (offset % BLOB_CHUNK_BYTES) + end - offset,
    );
    if (result.length !== end - offset)
      throw new Error("Protected candidate blob is incomplete.");
    if (
      offset === 0 &&
      end === file.bytes &&
      createHash("sha256").update(result).digest("hex") !== file.hash
    )
      throw new Error("Protected candidate content integrity failed.");
    return result;
  }
  /**
   * Stores bytes as a protected blob owned by a native execution record
   * (docs/Native_Harness_Plan.md §3): a request manifest, tool output,
   * compaction capsule or evidence. Content and ownership are written in one
   * transaction, and only the owner can read the blob back.
   */
  storeOwned(owner: BlobOwner, bytes: Buffer): { hash: string; bytes: number } {
    const digest = createHash("sha256").update(bytes).digest("hex");
    this.store.transaction(() => {
      const old = this.store.db
        .prepare("SELECT bytes FROM protected_blobs WHERE hash=?")
        .get(digest);
      if (old && old.bytes !== bytes.length)
        throw new Error("Protected blob hash collision.");
      if (!old) {
        this.store.db
          .prepare("INSERT INTO protected_blobs VALUES(?,?,?)")
          .run(digest, bytes.length, now());
        const insert = this.store.db.prepare(
          "INSERT INTO protected_blob_chunks VALUES(?,?,?,?)",
        );
        const count = Math.max(1, Math.ceil(bytes.length / BLOB_CHUNK_BYTES));
        for (let ordinal = 0; ordinal < count; ordinal++) {
          const chunk = bytes.subarray(
            ordinal * BLOB_CHUNK_BYTES,
            (ordinal + 1) * BLOB_CHUNK_BYTES,
          );
          insert.run(
            digest,
            ordinal,
            chunk,
            createHash("sha256").update(chunk).digest("hex"),
          );
        }
      }
      const existing = this.store.db
        .prepare(
          "SELECT hash FROM protected_blob_owners WHERE owner_kind=? AND owner_id=? AND name=?",
        )
        .get(owner.kind, owner.id, owner.name);
      if (existing && existing.hash !== digest)
        throw new Error(
          "Protected blob owner already holds different content.",
        );
      if (!existing)
        this.store.db
          .prepare("INSERT INTO protected_blob_owners VALUES(?,?,?,?,?,?)")
          .run(
            owner.kind,
            owner.id,
            owner.projectId,
            owner.name,
            digest,
            bytes.length,
          );
    });
    return { hash: digest, bytes: bytes.length };
  }
  /** Reads an owned blob; the owner reference, not the hash, authorizes it. */
  readOwned(owner: BlobOwner, hash: string): Buffer {
    const ref = this.store.db
      .prepare(
        "SELECT hash,bytes FROM protected_blob_owners WHERE owner_kind=? AND owner_id=? AND project_id=? AND name=?",
      )
      .get(owner.kind, owner.id, owner.projectId, owner.name);
    if (!ref || ref.hash !== hash)
      throw new Error("No protected blob is owned by this record.");
    const chunks = this.store.db
      .prepare(
        "SELECT bytes,chunk_hash FROM protected_blob_chunks WHERE hash=? ORDER BY ordinal",
      )
      .all(hash);
    for (const row of chunks)
      if (
        createHash("sha256").update(row.bytes).digest("hex") !== row.chunk_hash
      )
        throw new Error("Protected blob chunk integrity failed.");
    const result = Buffer.concat(chunks.map((row) => Buffer.from(row.bytes)));
    if (
      result.length !== ref.bytes ||
      createHash("sha256").update(result).digest("hex") !== hash
    )
      throw new Error("Protected blob content integrity failed.");
    return result;
  }
  /** Explicit bounded maintenance. Independently retained candidates stay
   * referenced after conversation deletion. Active/evidence references are
   * never guessed obsolete, so this only reclaims interrupted, unreferenced
   * blobs and deliberately leaves retained artifacts alone. */
  collectUnreferenced(limit = 100): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Invalid blob cleanup batch.");
    return this.store.transaction(() => {
      const rows = this.store.db
        .prepare(
          "SELECT hash FROM protected_blobs WHERE hash NOT IN (SELECT hash FROM protected_blob_refs) AND hash NOT IN (SELECT hash FROM protected_blob_owners) LIMIT ?",
        )
        .all(limit);
      for (const row of rows) {
        this.store.db
          .prepare("DELETE FROM protected_blob_chunks WHERE hash=?")
          .run(row.hash);
        this.store.db
          .prepare("DELETE FROM protected_blobs WHERE hash=?")
          .run(row.hash);
      }
      return rows.length;
    });
  }
}

/** How old a capturing record from another host must be to count as dead. */
const FOREIGN_CAPTURE_DEAD_AFTER_MS = 24 * 60 * 60_000;

/** Bounded recovery only for a known failed/dead capture. Live owners and every
 * immutable candidate (including independently retained evidence) are kept. */
export function recoverAbandonedCaptures(store: Store, limit = 100): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid capture recovery batch.");
  let recovered = 0,
    scanned = 0,
    afterRowid = 0;
  // Page by rowid so live or foreign-host captures at the head of the table
  // cannot starve dead ones behind them. The scan itself stays bounded.
  // A capture from another host cannot be probed, so it is skipped while it is
  // young. The vault is local and only one service opens it, and a macOS
  // hostname changes with the network, so an old one is this machine's own
  // crashed capture under an earlier name.
  const foreignDeadBefore = Date.now() - FOREIGN_CAPTURE_DEAD_AFTER_MS;
  const page = store.db.prepare(
    "SELECT rowid,body FROM documents WHERE kind='candidate-capture' AND json_extract(body,'$.state') IN ('capturing','failed') AND rowid>? ORDER BY rowid LIMIT ?",
  );
  const captures = function* () {
    while (scanned < limit * 50) {
      const rows = page.all(afterRowid, limit);
      if (!rows.length) return;
      for (const row of rows) {
        afterRowid = row.rowid;
        scanned++;
        yield JSON.parse(row.body) as {
          id: string;
          state: string;
          owner?: typeof captureOwner;
          createdAt?: string;
        };
      }
    }
  };
  for (const capture of captures()) {
    if (recovered >= limit) break;
    if (capture.state === "complete" || store.get("candidate", capture.id))
      continue;
    let dead = capture.state === "failed";
    if (!dead && capture.owner?.host === captureOwner.host) {
      if (capture.owner.pid === process.pid)
        dead = capture.owner.processToken !== captureOwner.processToken;
      else
        try {
          process.kill(capture.owner.pid, 0);
        } catch (error) {
          dead = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
    } else if (!dead && capture.owner)
      dead = Date.parse(capture.createdAt ?? "") < foreignDeadBefore;
    if (!dead) continue;
    store.transaction(() => {
      store.db
        .prepare(
          "DELETE FROM protected_blob_staging WHERE rowid IN (SELECT rowid FROM protected_blob_staging WHERE substr(capture_id,1,?)=? LIMIT 500)",
        )
        .run(capture.id.length + 1, capture.id + ":");
      store.db
        .prepare(
          "DELETE FROM protected_blob_refs WHERE rowid IN (SELECT rowid FROM protected_blob_refs WHERE candidate_id=? LIMIT 500)",
        )
        .run(capture.id);
      const remaining = store.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM protected_blob_staging WHERE substr(capture_id,1,?)=?)+(SELECT COUNT(*) FROM protected_blob_refs WHERE candidate_id=?) AS count",
        )
        .get(capture.id.length + 1, capture.id + ":", capture.id).count;
      store.put("candidate-capture", {
        ...capture,
        state: remaining ? "failed" : "recovered",
        recoveredAt: now(),
      });
    });
    recovered++;
  }
  return recovered;
}
