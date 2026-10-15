import { createHash } from "node:crypto";
import { now } from "../domain/invariants";
import type { Store } from "./store";
import os from "node:os";
import { randomBytes } from "node:crypto";

export const BLOB_CHUNK_BYTES = 64 * 1024;
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
  publish(captureId: string, digest: string, bytes: number): void {
    this.store.transaction(() => {
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
          "SELECT hash FROM protected_blobs WHERE hash NOT IN (SELECT hash FROM protected_blob_refs) LIMIT ?",
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
    }
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
