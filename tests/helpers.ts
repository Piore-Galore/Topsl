import { mkdtemp, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../packages/persistence/store";
import { hash, now, uid } from "../packages/domain/invariants";
import { identity } from "../packages/platform/system";
import type { Installation, LifecyclePlan } from "../packages/domain/types";
export async function fixture() {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "topsl-test-unit-")),
  );
  const key = randomBytes(32).toString("hex");
  const store = new Store(path.join(directory, "history.sqlite"), key);
  const file = path.join(directory, "runtime");
  await writeFile(file, "fixture executable bytes");
  const fingerprint = await identity(file);
  const installation: Installation = {
    id: uid(),
    appId: "openai.codex-cli",
    path: file,
    ...fingerprint,
    hostId: "fixture",
    revisionId: hash("fixture-v1"),
    version: "1.0.0",
    managementUnitId: "fixture-unit",
    owner: "vendor",
    channel: "stable",
    packageId: null,
    nativeAutoUpdates: "unknown",
    trusted: true,
    compatibility: "compatible",
  };
  store.put("installation", installation);
  return { directory, key, store, installation };
}
export function plan(overrides: Partial<LifecyclePlan> = {}): LifecyclePlan {
  return {
    id: uid(),
    appId: "openai.codex-cli",
    installationId: null,
    expectedRevision: null,
    action: "download",
    route: "download",
    managementUnitId: "unit",
    command: null,
    executorIdentity: null,
    release: null,
    nativeUrl: null,
    effects: ["Save only"],
    digest: "",
    createdAt: now(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...overrides,
  };
}
