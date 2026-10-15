import { expect, test } from "vitest";
import { fixture } from "./helpers";
import { now } from "../packages/domain/invariants";
import {
  captureOwner,
  ProtectedBlobs,
  recoverAbandonedCaptures,
} from "../packages/persistence/blobs";

test("capture recovery pages past live captures and matches staging by exact capture prefix", async () => {
  const f = await fixture(),
    blobs = new ProtectedBlobs(f.store);
  for (let i = 0; i < 5; i++)
    f.store.put("candidate-capture", {
      id: `live-${i}`,
      state: "capturing",
      owner: captureOwner,
      createdAt: now(),
    });
  // An id with LIKE wildcards must not reach another capture's staging rows.
  f.store.put("candidate-capture", {
    id: "dead_capture",
    state: "failed",
    owner: captureOwner,
    createdAt: now(),
  });
  blobs.stage("dead_capture:one", 0, Buffer.from("dead"));
  blobs.stage("deadXcapture:one", 0, Buffer.from("other"));
  blobs.stage("live-0:one", 0, Buffer.from("live"));

  expect(recoverAbandonedCaptures(f.store, 2)).toBe(1);
  expect(f.store.get<any>("candidate-capture", "dead_capture")?.state).toBe(
    "recovered",
  );
  const staged = f.store.db
    .prepare(
      "SELECT capture_id FROM protected_blob_staging ORDER BY capture_id",
    )
    .all()
    .map((row: { capture_id: string }) => row.capture_id);
  expect(staged).toEqual(["deadXcapture:one", "live-0:one"]);
  expect(f.store.get<any>("candidate-capture", "live-0")?.state).toBe(
    "capturing",
  );
});
