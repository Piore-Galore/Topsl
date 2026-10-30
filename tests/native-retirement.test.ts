import { afterEach, expect, test } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { Store } from "../packages/persistence/store";
import {
  NATIVE_RETIREMENT_ID,
  retireNativeIntegration,
} from "../packages/persistence/migrations/native-retirement";
import { Service } from "../apps/service/service";
import { planDigest, now } from "../packages/domain/invariants";
import type { LifecyclePlan, ServiceEvent } from "../packages/domain/types";
import { plan } from "./helpers";

/**
 * The upgrade for docs/UX_Cleanup_Plan.md §2: a profile from before, with
 * discovery and Codex synchronization on, desktop installations, pending
 * desktop operations and native links, opened by this version.
 */

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const directories: string[] = [];
const services: Service[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function legacyProfile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-retire-"));
  directories.push(directory);
  const key = randomBytes(32).toString("hex");
  const store = new Store(path.join(directory, "history.sqlite"), key);
  store.put("preference", { id: "project-sync", enabled: true, scope: "s" });
  store.put("preference", {
    id: "codex-project-sync",
    enabled: true,
    realHome: "/home/.codex",
    configuredHome: "/home/.codex",
    installationId: "cli",
  });
  store.put("codex-project-observation", {
    id: sha("/home/.codex"),
    status: "ready",
    projects: [
      { id: "native-b", name: "B", roots: ["/b"], position: 0, revision: "1" },
      { id: "native-a", name: "A", roots: ["/a"], position: 1, revision: "1" },
    ],
  });
  const project = (id: string, folder: string, nativeId?: string) => ({
    id,
    name: id.toUpperCase(),
    path: folder,
    realPath: folder,
    trusted: id !== "c",
    createdAt: now(),
    sources: nativeId
      ? [
          {
            sourceId: "codex-project-api",
            path: folder,
            name: id,
            nativeProjectId: nativeId,
            observedAt: now(),
          },
        ]
      : [],
    ...(nativeId
      ? {
          nameSource: {
            sourceId: "codex-project-api",
            nativeProjectId: nativeId,
          },
        }
      : {}),
  });
  store.put("project", project("a", "/a", "native-a"));
  store.put("project", project("b", "/b", "native-b"));
  store.put("project", project("c", "/c"));
  store.save("conversation", {
    id: "conversation",
    projectId: "a",
    title: "Kept",
    nativeSessions: {},
    createdAt: now(),
  });
  store.message({
    id: "message",
    projectId: "a",
    conversationId: "conversation",
    role: "user",
    provider: "codex",
    text: "kept history",
    runId: null,
    nativeId: null,
    createdAt: now(),
  });
  store.put("native-history-source", {
    id: "source",
    projectId: "a",
    enabled: true,
    state: "current",
    revision: 3,
  });
  store.put("sync-field", {
    id: "field",
    projectId: "a",
    state: "push-required",
  });
  const installation = (id: string, appId: string, extra: object = {}) => ({
    id,
    appId,
    hostId: "host",
    path: `/Applications/${id}`,
    realPath: `/Applications/${id}`,
    version: "1.0.0",
    revisionId: `revision-${id}`,
    identity: `identity-${id}`,
    managementUnitId: "unit-desktop",
    owner: "vendor",
    packageId: null,
    channel: "native",
    nativeAutoUpdates: "unknown",
    trusted: true,
    compatibility: "native-only",
    ...extra,
  });
  store.put("installation", installation("desktop", "openai.desktop"));
  store.put("check", { id: "desktop", status: "available" });
  store.put(
    "installation",
    installation("bundled", "openai.codex-cli", {
      owner: "desktop",
      realPath: "/Applications/Codex.app/Contents/Resources/codex",
    }),
  );
  store.put(
    "installation",
    installation("cli", "anthropic.claude-code-cli", {
      owner: "homebrew",
      managementUnitId: "unit-brew",
      channel: "stable",
    }),
  );
  const desktopPlan = (id: string) => {
    const value = {
      ...plan({
        id,
        appId: "openai.desktop" as any,
        installationId: "desktop",
        action: "update",
        route: "native",
        managementUnitId: "unit-desktop",
      }),
      nativeApplicationPath: "/Applications/Codex.app",
    } as LifecyclePlan;
    value.digest = planDigest(value);
    store.immutable("plan", value);
    return value;
  };
  const waiting = desktopPlan("plan-waiting");
  const uncertain = desktopPlan("plan-uncertain");
  const unused = desktopPlan("plan-unused");
  const cliPlan = plan({ id: "plan-cli", managementUnitId: "unit-brew" });
  cliPlan.digest = planDigest(cliPlan);
  store.immutable("plan", cliPlan);
  const job = (id: string, planId: string, state: string) =>
    store.put("job", {
      id,
      planId,
      state,
      acquiredPath: null,
      bytes: 0,
      total: null,
      actualVersion: null,
      detail: "before",
      createdAt: now(),
      updatedAt: now(),
    });
  job("job-waiting", waiting.id, "waiting-for-idle");
  job("job-uncertain", uncertain.id, "uncertain");
  job("job-cli", cliPlan.id, "queued");
  store.put("installation-lock", { id: "unit-desktop", owner: "job-waiting" });
  return { directory, key, store, unused };
}

test("the upgrade keeps projects, order, trust and history and retires desktop and synchronization work once", async () => {
  const { store, unused } = await legacyProfile();
  expect(retireNativeIntegration(store)).toBe(true);
  // The order Projects showed: the Codex registry's, then the rest.
  expect(store.get<any>("preference", "project-order")).toMatchObject({
    order: ["b", "a", "c"],
  });
  expect(store.get<any>("preference", "project-sync").enabled).toBe(false);
  expect(store.get<any>("preference", "codex-project-sync").enabled).toBe(
    false,
  );
  const projects = store.list<any>("project");
  expect(projects.map((p) => [p.id, p.name, p.trusted]).sort()).toEqual([
    ["a", "A", true],
    ["b", "B", true],
    ["c", "C", false],
  ]);
  expect(projects.every((p) => !("nameSource" in p))).toBe(true);
  expect(store.get("message", "message")).toBeTruthy();
  expect(store.get<any>("native-history-source", "source")).toMatchObject({
    enabled: false,
    state: "retired",
  });
  expect(store.get<any>("sync-field", "field").state).toBe("retired");
  // Desktop installations leave; a bundled CLI stays, managed by its bundle.
  expect(store.get("installation", "desktop")).toBeUndefined();
  expect(store.get("check", "desktop")).toBeUndefined();
  expect(store.get<any>("installation", "bundled")).toMatchObject({
    owner: "external",
    managementUnitId: sha("/Applications/Codex.app/Contents/Resources/codex"),
  });
  expect(store.get<any>("installation", "cli").owner).toBe("homebrew");
  // A pending desktop operation is cancelled; an uncertain one stays uncertain.
  expect(store.get<any>("job", "job-waiting")).toMatchObject({
    state: "cancelled",
    detail: expect.stringMatching(/Retired/),
  });
  expect(store.get<any>("job", "job-uncertain").state).toBe("uncertain");
  expect(store.get<any>("job", "job-cli").state).toBe("queued");
  expect(store.get("consumed-approval", unused.id)).toBeTruthy();
  expect(store.get("consumed-approval", "plan-cli")).toBeUndefined();
  expect(store.get("installation-lock", "unit-desktop")).toBeUndefined();
  // Idempotent: a second run changes nothing.
  const before = JSON.stringify([
    store.list("project"),
    store.list("job"),
    store.list("preference"),
    store.list("installation"),
  ]);
  expect(retireNativeIntegration(store)).toBe(false);
  expect(
    JSON.stringify([
      store.list("project"),
      store.list("job"),
      store.list("preference"),
      store.list("installation"),
    ]),
  ).toBe(before);
  expect(
    store.get<any>("migration", NATIVE_RETIREMENT_ID).counts,
  ).toMatchObject({
    installations: 2,
    jobs: 1,
    historySources: 1,
  });
  store.close();
});

test("after the upgrade the service resumes nothing retired and refuses stale approvals", async () => {
  const { directory, key, store, unused } = await legacyProfile();
  store.close();
  const events: ServiceEvent[] = [];
  const service = new Service(
    directory,
    key,
    (event) => events.push(event),
    true,
  );
  services.push(service);
  await service.start();
  await service.lifecycle.tick();
  const state = service.state();
  expect(state.projects.map((p) => p.id)).toEqual(["b", "a", "c"]);
  expect(state.applications.map((a) => a.id)).toEqual([
    "openai.codex-cli",
    "anthropic.claude-code-cli",
  ]);
  expect(state).not.toHaveProperty("projectSync");
  expect(state).not.toHaveProperty("codexProjectSync");
  expect(state.installations.map((i) => i.id).sort()).toEqual([
    "bundled",
    "cli",
  ]);
  // No launch, installer or folder handoff happened.
  expect(events.some((e) => e.type === "native-open")).toBe(false);
  expect(service.store.get<any>("job", "job-waiting").state).toBe("cancelled");
  expect(service.store.get<any>("job", "job-uncertain").state).toBe(
    "uncertain",
  );
  // Nothing native was read or written: no discovery sources or registry observations appeared.
  expect(service.store.list("project-source")).toEqual([]);
  expect(service.store.list("codex-project-observation")).toHaveLength(1);
  await expect(
    service.command(
      { type: "lifecycle-apply", id: unused.id },
      { digest: unused.digest },
    ),
  ).rejects.toThrow(/already been used|no longer manages/);
  await expect(
    service.command({ type: "lifecycle-reconcile", id: "job-uncertain" }),
  ).resolves.toMatchObject({ state: "uncertain" });
  expect(events.some((e) => e.type === "native-open")).toBe(false);
  // The bundled CLI is still usable but is never updated by Topsl.
  await expect(
    service.command({
      type: "lifecycle-preview",
      appId: "openai.codex-cli",
      installationId: "bundled",
      action: "update",
    }),
  ).rejects.toThrow("application bundle");
});
