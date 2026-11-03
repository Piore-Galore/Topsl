import { createHash } from "node:crypto";
import path from "node:path";
import type { Store } from "../store";

/**
 * Retires desktop-application management, automatic project discovery,
 * Codex project-registry synchronization and history-source observation
 * (docs/UX_Cleanup_Plan.md §2, upgrade behavior). It runs once, in one
 * transaction, as soon as the vault opens: before any recovery, timer or
 * background service could resume retired work.
 *
 * Kept: project identities, names, displayed order, trust, histories and
 * execution records. Disabled: the discovery and synchronization
 * preferences and every observed history source. Retired: desktop
 * installations, their pending operations and approvals. An uncertain
 * operation stays uncertain and is never replayed.
 */

export const NATIVE_RETIREMENT_ID = "native-integration-retired-v1";
const cliApps = new Set(["openai.codex-cli", "anthropic.claude-code-cli"]);
const pendingJobStates = new Set([
  "queued",
  "downloading",
  "verifying",
  "waiting-for-idle",
  "applying",
  "awaiting-native",
  "reconciling",
]);
const retiredDetail =
  "Retired: Topsl no longer manages desktop applications or native project synchronization. Nothing was run.";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pathKey = (value: string) => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

interface ProjectRecord {
  id: string;
  sources?: Array<{
    sourceId: string;
    path: string;
    nativeProjectId: string | null;
  }>;
  nameSource?: unknown;
}

/**
 * The order Projects showed before: the Codex registry's order when one was
 * recorded, otherwise newest first.
 */
function displayedOrder(store: Store): string[] {
  const projects = store.list<ProjectRecord>("project");
  const codex = store.get<{ realHome?: string }>(
    "preference",
    "codex-project-sync",
  );
  const observation = codex?.realHome
    ? store.get<{ projects?: Array<{ id: string; roots: string[] }> }>(
        "codex-project-observation",
        sha(codex.realHome),
      )
    : undefined;
  const rank = new Map<string, number>();
  for (const native of observation?.projects ?? [])
    for (const root of native.roots)
      rank.set(JSON.stringify([native.id, pathKey(root)]), rank.size);
  const of = (project: ProjectRecord) =>
    Math.min(
      Infinity,
      ...(project.sources ?? [])
        .filter((source) => source.sourceId === "codex-project-api")
        .map(
          (source) =>
            rank.get(
              JSON.stringify([source.nativeProjectId, pathKey(source.path)]),
            ) ?? Infinity,
        ),
    );
  return [...projects].sort((a, b) => of(a) - of(b)).map((p) => p.id);
}

export function retireNativeIntegration(store: Store): boolean {
  if (store.get("migration", NATIVE_RETIREMENT_ID)) return false;
  const at = new Date().toISOString();
  store.transaction(() => {
    const counts = {
      preferences: 0,
      historySources: 0,
      installations: 0,
      jobs: 0,
      plans: 0,
      locks: 0,
      fields: 0,
    };
    // The order is captured before anything native is set aside.
    if (!store.get("preference", "project-order"))
      store.put("preference", {
        id: "project-order",
        order: displayedOrder(store),
        revision: 1,
      });
    for (const id of ["project-sync", "codex-project-sync"]) {
      const preference = store.get<Record<string, unknown>>("preference", id);
      if (!preference) continue;
      store.put<any>("preference", {
        ...preference,
        id,
        enabled: false,
        retiredAt: at,
      });
      counts.preferences++;
    }
    // Names now belong to Topsl alone; no native source can rename a project.
    for (const project of store.list<ProjectRecord>("project"))
      if (project.nameSource) {
        const { nameSource: _, ...rest } = project;
        store.put("project", rest);
      }
    for (const source of store.list<Record<string, any>>(
      "native-history-source",
    )) {
      if (source.state === "retired") continue;
      store.put<any>("native-history-source", {
        ...source,
        enabled: false,
        state: "retired",
        revision: (source.revision ?? 0) + 1,
        detail:
          "Retired: Topsl no longer observes history files. Messages already imported are kept; import an export in Settings for a new snapshot.",
      });
      counts.historySources++;
    }
    for (const field of store.list<Record<string, any>>("sync-field")) {
      if (field.state === "retired") continue;
      store.put<any>("sync-field", {
        ...field,
        state: "retired",
        updatedAt: at,
      });
      counts.fields++;
    }
    // Desktop applications leave the catalog. A CLI inside an application
    // bundle stays usable, as an externally managed executable.
    const retiredUnits = new Set<string>();
    for (const installation of store.list<Record<string, any>>(
      "installation",
    )) {
      if (!cliApps.has(installation.appId)) {
        retiredUnits.add(installation.managementUnitId);
        store.remove("installation", installation.id);
        store.remove("check", installation.id);
        counts.installations++;
      } else if (["desktop", "vendor"].includes(installation.owner)) {
        retiredUnits.add(installation.managementUnitId);
        store.put<any>("installation", {
          ...installation,
          owner: "external",
          managementUnitId: sha(installation.realPath),
        });
        store.remove("check", installation.id);
        counts.installations++;
      }
    }
    // Pending desktop operations are cancelled before the lifecycle service
    // could resume them; their approvals can no longer be used.
    const plans = new Map(
      store
        .list<Record<string, any>>("plan")
        .map((plan) => [plan.id as string, plan]),
    );
    const retiredPlan = (plan: Record<string, any> | undefined) =>
      !!plan &&
      (!cliApps.has(plan.appId) ||
        "nativeApplicationPath" in plan ||
        retiredUnits.has(plan.managementUnitId));
    for (const job of store.list<Record<string, any>>("job")) {
      const plan = plans.get(job.planId);
      if (!retiredPlan(plan) || !pendingJobStates.has(job.state)) continue;
      store.put<any>("job", {
        ...job,
        state: "cancelled",
        detail: retiredDetail,
        updatedAt: at,
      });
      counts.jobs++;
    }
    for (const plan of plans.values()) {
      if (!retiredPlan(plan) || store.get("consumed-approval", plan.id))
        continue;
      store.put("consumed-approval", {
        id: plan.id,
        digest: plan.digest,
        jobId: null,
        retiredAt: at,
      });
      counts.plans++;
    }
    for (const lock of store.list<{ id: string }>("installation-lock"))
      if (retiredUnits.has(lock.id)) {
        store.remove("installation-lock", lock.id);
        counts.locks++;
      }
    store.put("migration", {
      id: NATIVE_RETIREMENT_ID,
      at,
      counts,
      detail:
        "Desktop management, project discovery, Codex registry synchronization and history-source observation retired.",
    });
    store.event("migration.native-retirement", { at, counts });
  });
  return true;
}
