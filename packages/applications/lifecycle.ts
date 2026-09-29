import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AppId,
  Installation,
  LifecycleJob,
  LifecyclePlan,
  Release,
  UpdateCheck,
} from "../domain/types";
import {
  checkDue,
  compareVersions,
  nextCheck,
  now,
  uid,
  planDigest,
  validatePlan,
  safeError,
} from "../domain/invariants";
import { catalog } from "../domain/catalog";
import { Store } from "../persistence/store";
import {
  identity,
  affectedProcesses,
  nativeEnvironment,
  runFile,
} from "../platform/system";
import { casks, homebrew } from "./discovery";
import { officialFetch, resolveRelease } from "./releases";

export interface LifecycleDependencies {
  installations: () => Installation[];
  discover: () => Promise<Installation[]>;
  active: (unit: string) => boolean;
  changed: () => void;
  release?: typeof resolveRelease;
  fetch?: typeof officialFetch;
  processes?: typeof affectedProcesses;
  execute?: typeof runFile;
  packageManager?: () => Promise<string | null>;
  nativeOpen: (target: string) => Promise<void>;
}
export class Lifecycle {
  private controllers = new Map<string, AbortController>();
  private busy = new Set<string>();
  private checking = new Map<string, Promise<UpdateCheck>>();
  constructor(
    private store: Store,
    private directory: string,
    private deps: LifecycleDependencies,
  ) {
    for (const job of store.list<LifecycleJob>("job"))
      if (
        ![
          "completed",
          "unchanged",
          "failed",
          "cancelled",
          "uncertain",
          "awaiting-native",
        ].includes(job.state)
      ) {
        this.change(job, {
          state: "uncertain",
          detail:
            "Topsl stopped during this job. Reconcile before retry; no command has been replayed.",
        });
      }
  }
  private installation(id: string): Installation {
    const i = this.deps.installations().find((i) => i.id === id);
    if (!i)
      throw new Error(
        "Installation is no longer present. Rediscover applications.",
      );
    return i;
  }
  private change(job: LifecycleJob, values: Partial<LifecycleJob>): void {
    Object.assign(job, values, { updatedAt: now() });
    this.store.transaction(() => {
      this.store.save("job", job);
      if (
        ["completed", "unchanged", "failed", "cancelled"].includes(job.state)
      ) {
        const plan = this.store.get<LifecyclePlan>("plan", job.planId);
        if (
          plan &&
          this.store.get<any>("installation-lock", plan.managementUnitId)
            ?.owner === job.id
        )
          this.store.remove("installation-lock", plan.managementUnitId);
      }
    });
    this.deps.changed();
  }
  async check(id: string, manual = false): Promise<UpdateCheck> {
    const pending = this.checking.get(id);
    if (pending) return pending;
    const previous = this.store.get<UpdateCheck>("check", id);
    if (!manual && previous && !checkDue(previous)) return previous;
    const promise = (async () => {
      let result: UpdateCheck;
      try {
        const installation = this.installation(id);
        const release = await (this.deps.release ?? resolveRelease)(
          installation.appId,
          installation,
        );
        const comparison =
          release && installation.version
            ? compareVersions(release.version, installation.version)
            : null;
        result = {
          installationId: id,
          checkedAt: now(),
          lastSuccessAt: now(),
          nextCheckAt: nextCheck(0),
          failures: 0,
          release,
          status: !release
            ? "native-required"
            : comparison === null
              ? "unknown"
              : comparison > 0
                ? "available"
                : "current",
          detail: !release
            ? "Check the existing owner or parent application. Topsl cannot resolve this channel automatically."
            : "Metadata checked. No installer or update command was run.",
        };
      } catch (e) {
        const failures = (previous?.failures ?? 0) + 1;
        result = {
          installationId: id,
          checkedAt: now(),
          lastSuccessAt: previous?.lastSuccessAt ?? null,
          nextCheckAt: nextCheck(failures),
          failures,
          release: null,
          status: "unknown",
          detail: safeError(e),
        };
      }
      this.store.put("check", { id, ...result });
      this.deps.changed();
      return result;
    })();
    this.checking.set(id, promise);
    try {
      return await promise;
    } finally {
      this.checking.delete(id);
    }
  }
  async scheduledChecks(): Promise<void> {
    for (const i of this.deps.installations()) await this.check(i.id);
  }
  async preview(
    appId: AppId,
    installationId: string | null,
    action: LifecyclePlan["action"],
  ): Promise<LifecyclePlan> {
    const app = catalog.find((a) => a.id === appId);
    if (!app) throw new Error("Unknown application.");
    if (!app.platforms.includes(process.platform))
      throw new Error(
        "This application has no official native installer for this OS.",
      );
    let installation = installationId
      ? this.installation(installationId)
      : undefined;
    if (
      action === "install" &&
      !installation &&
      this.deps.installations().some((i) => i.appId === appId)
    )
      throw new Error(
        "This application is already installed. Select its existing installation and owner before updating.",
      );
    if (installation && installation.appId !== appId)
      throw new Error("Installation does not match the selected application.");
    if (action === "update" && !installation)
      throw new Error("Choose the installation to update.");
    if (installation?.owner === "desktop") {
      const parent = this.deps
        .installations()
        .find(
          (i) =>
            i.managementUnitId === installation!.managementUnitId &&
            i.appId.endsWith("desktop"),
        );
      if (!parent)
        throw new Error(
          "This runtime updates with its desktop application. Discover or open the parent application.",
        );
      installation = parent;
      appId = parent.appId;
      installationId = parent.id;
    }
    const release = await (this.deps.release ?? resolveRelease)(
      appId,
      action === "download" ? undefined : installation,
    );
    const brew =
      installation?.owner === "homebrew"
        ? await (this.deps.packageManager ?? homebrew)()
        : null;
    const route =
      action === "download" && release?.sha256
        ? "download"
        : action === "update" && brew && release
          ? "package-manager"
          : "native";
    if (
      action === "update" &&
      release &&
      installation?.version &&
      compareVersions(release.version, installation.version) !== 1
    )
      throw new Error(
        "No eligible newer version is confirmed for this channel. Use its native owner to inspect other releases.",
      );
    if (action === "download" && route !== "download")
      throw new Error(
        "No verified direct download is available for this host and channel. Use the official download page.",
      );
    const plan: LifecyclePlan = {
      id: uid(),
      appId,
      installationId,
      expectedRevision: installation?.revisionId ?? null,
      installedVersion: installation?.version ?? null,
      action,
      route,
      managementUnitId: installation?.managementUnitId ?? `new:${appId}`,
      release,
      command:
        route === "package-manager"
          ? {
              executable: brew!,
              args: [
                "upgrade",
                "--cask",
                "--greedy",
                installation!.packageId ?? casks[appId],
              ],
            }
          : null,
      executorIdentity:
        route === "package-manager" ? (await identity(brew!)).identity : null,
      nativeUrl:
        route === "native"
          ? catalog.find((a) => a.id === appId)!.website
          : null,
      nativeApplicationPath:
        route === "native" && action === "update" && appId.endsWith("desktop")
          ? installation!.path
          : null,
      effects: [
        release
          ? `Target ${release.version}; ${release.source}.`
          : "Target version is selected by the native installer or store.",
        installation
          ? `Affected installation: ${installation.path} (${installation.owner}, ${installation.channel}).`
          : `New installation for ${process.platform}/${process.arch}.`,
        action === "download"
          ? "Save verified artifact only. Nothing is executed."
          : route === "package-manager"
            ? "Run this one package update. Homebrew may request native elevation and install required dependencies. Automatic metadata refresh is disabled."
            : action === "install" && release && appId.endsWith("desktop")
              ? "Download and checksum-verify the official archive, then open it in the native installer. Complete placement, publisher verification, and any elevation there, then reconcile."
              : action === "update" && appId.endsWith("desktop")
                ? "Open the installed application's own update controls. Its existing owner determines the eligible version and channel; complete the native flow, then reconcile."
                : "Open the official installation flow. Complete installation and elevation in the native UI, then reconcile.",
        action === "download"
          ? "Cancelled or interrupted downloads restart from byte zero."
          : "Wait for affected sessions to close. Existing processes are never force-closed. Restart the native application to use the new version.",
        "Native auto-update preferences and release channels remain unchanged. No automatic rollback is available.",
      ],
      digest: "",
      createdAt: now(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    plan.digest = planDigest(plan);
    this.store.immutable("plan", plan);
    return plan;
  }
  async approve(id: string, reviewedDigest: string): Promise<LifecycleJob> {
    const plan = this.store.get<LifecyclePlan>("plan", id);
    if (!plan || plan.digest !== reviewedDigest)
      throw new Error("Reviewed plan is missing or changed.");
    if (
      this.store.get("consumed-approval", id) ||
      this.store.list<LifecycleJob>("job").some((j) => j.planId === id)
    )
      throw new Error(
        "This approval has already been used. Reconcile the existing job.",
      );
    await this.deps.discover();
    validatePlan(
      plan,
      plan.installationId
        ? this.installation(plan.installationId).revisionId
        : null,
    );
    if (
      this.store
        .list<LifecycleJob>("job")
        .some(
          (j) =>
            this.store.get<LifecyclePlan>("plan", j.planId)
              ?.managementUnitId === plan.managementUnitId &&
            !["completed", "unchanged", "failed", "cancelled"].includes(
              j.state,
            ),
        )
    )
      throw new Error(
        "Another job owns this installation. Complete or reconcile it first.",
      );
    const job: LifecycleJob = {
      id: uid(),
      planId: id,
      state: "queued",
      acquiredPath: null,
      bytes: 0,
      total: plan.release?.size ?? null,
      actualVersion: null,
      detail: "Approved operation recorded durably.",
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.transaction(() => {
      if (this.store.get("installation-lock", plan.managementUnitId))
        throw new Error(
          "Another job owns this installation. Reconcile it first.",
        );
      this.store.put("installation-lock", {
        id: plan.managementUnitId,
        owner: job.id,
      });
      this.store.immutable("consumed-approval", {
        id: plan.id,
        digest: reviewedDigest,
        jobId: job.id,
      });
      this.store.save("job", job, "lifecycle.approved");
    });
    void this.execute(job);
    return job;
  }
  private async execute(job: LifecycleJob): Promise<void> {
    const plan = this.store.get<LifecyclePlan>("plan", job.planId)!;
    if (this.busy.has(plan.managementUnitId)) return;
    this.busy.add(plan.managementUnitId);
    let mutationStarted = false;
    try {
      const installation = plan.installationId
        ? this.installation(plan.installationId)
        : undefined;
      validatePlan(plan, installation?.revisionId ?? null);
      if (
        installation &&
        (await identity(installation.path)).identity !== installation.identity
      )
        throw new Error(
          "Installation changed after approval. Create a fresh plan.",
        );
      if (plan.action !== "download" && installation) {
        const related = this.deps
          .installations()
          .filter((i) => i.managementUnitId === plan.managementUnitId);
        const processes = await (this.deps.processes ?? affectedProcesses)(
          related.map(
            (i) =>
              i.realPath.match(/^(.*\/(?:Caskroom|Cellar)\/[^/]+)\//)?.[1] ??
              i.realPath,
          ),
        );
        if (
          this.deps.active(plan.managementUnitId) ||
          processes === null ||
          processes.length
        ) {
          this.change(job, {
            state: "waiting-for-idle",
            detail:
              processes === null
                ? "Running state could not be verified. Close affected applications and reconcile."
                : "Waiting for affected sessions and applications to close.",
          });
          return;
        }
      }
      if (this.store.get<LifecycleJob>("job", job.id)?.state === "cancelled")
        return;
      if (plan.route === "download") {
        const controller = new AbortController();
        this.controllers.set(job.id, controller);
        const file = await this.download(job, plan.release!, controller.signal);
        this.change(job, {
          state: "completed",
          acquiredPath: file,
          detail:
            "Downloaded and checksum verified. This artifact has not been installed or executed.",
        });
      } else if (plan.route === "package-manager") {
        if (
          (await identity(plan.command!.executable)).identity !==
          plan.executorIdentity
        )
          throw new Error(
            "The package manager changed after approval. Create a fresh plan.",
          );
        const latest = await (this.deps.release ?? resolveRelease)(
          plan.appId,
          installation,
        );
        if (
          latest?.version !== plan.release?.version ||
          latest?.sha256 !== plan.release?.sha256
        )
          throw new Error(
            "Update target changed after approval. Create a fresh preview.",
          );
        if (this.store.get<LifecycleJob>("job", job.id)?.state === "cancelled")
          return;
        this.change(job, {
          state: "applying",
          detail:
            "Applying the approved package operation. Cancellation is unavailable once the package manager begins.",
        });
        mutationStarted = true;
        await (this.deps.execute ?? runFile)(
          plan.command!.executable,
          plan.command!.args,
          {
            timeout: 20 * 60_000,
            env: nativeEnvironment({
              HOMEBREW_NO_AUTO_UPDATE: "1",
              HOMEBREW_NO_INSTALL_UPGRADE: "1",
              HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1",
            }),
          },
        );
        await this.reconcile(job.id, true);
      } else {
        let target = plan.nativeApplicationPath ?? plan.nativeUrl!;
        if (
          plan.action === "install" &&
          plan.release &&
          plan.appId.endsWith("desktop")
        ) {
          const controller = new AbortController();
          this.controllers.set(job.id, controller);
          target = await this.download(job, plan.release, controller.signal);
          job.acquiredPath = target;
          if (process.platform === "darwin")
            await runFile("/usr/bin/xattr", [
              "-w",
              "com.apple.quarantine",
              `0083;${Math.floor(Date.now() / 1000).toString(16)};Topsl;${uid()}`,
              target,
            ]);
        }
        this.change(job, {
          state: "awaiting-native",
          detail:
            "Complete the official installer or store flow, then choose Reconcile. Opening it does not confirm installation or Topsl compatibility.",
        });
        await this.deps.nativeOpen(target);
      }
    } catch (e) {
      this.change(job, {
        state: this.controllers.get(job.id)?.signal.aborted
          ? "cancelled"
          : mutationStarted
            ? "uncertain"
            : "failed",
        detail: safeError(e),
      });
    } finally {
      this.controllers.delete(job.id);
      this.busy.delete(plan.managementUnitId);
    }
  }
  private async download(
    job: LifecycleJob,
    release: Release,
    signal: AbortSignal,
  ): Promise<string> {
    if (!release.sha256 || !/^[a-f0-9]{64}$/.test(release.sha256))
      throw new Error("No trusted SHA-256 is available.");
    const dir = path.join(this.directory, "downloads", job.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = path
      .basename(release.artifactName)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!name || name === "." || name === "..")
      throw new Error("The artifact has no safe filename.");
    const target = path.join(dir, name || "installer");
    const partial = target + ".part";
    const file = await open(partial, "wx", 0o600);
    const digest = createHash("sha256");
    let lastUpdate = 0;
    try {
      this.change(job, {
        state: "downloading",
        detail: `Downloading ${release.artifactName}.`,
      });
      const response = await (this.deps.fetch ?? officialFetch)(release.url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
      });
      const size = Number(response.headers.get("content-length"));
      if (size > 4_000_000_000)
        throw new Error("Artifact exceeds the download size limit.");
      const reader = response.body!.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          signal.throwIfAborted();
          job.bytes += chunk.value.length;
          if (job.bytes > 4_000_000_000)
            throw new Error("Artifact exceeds the download size limit.");
          digest.update(chunk.value);
          await file.writeFile(chunk.value);
          if (Date.now() - lastUpdate > 200) {
            this.change(job, { total: release.size ?? (size || null) });
            lastUpdate = Date.now();
          }
        }
      } finally {
        await reader.cancel();
      }
      this.change(job, {
        state: "verifying",
        detail:
          "Verifying the complete artifact against the published checksum.",
      });
      if (release.size !== null && job.bytes !== release.size)
        throw new Error("Artifact length does not match release metadata.");
      if (digest.digest("hex") !== release.sha256)
        throw new Error(
          "Integrity verification failed. The artifact will not be opened.",
        );
      await file.sync();
      await file.close();
      await rename(partial, target);
      return realpath(target);
    } catch (e) {
      await file.close().catch(() => {});
      await rm(partial, { force: true });
      throw e;
    }
  }
  cancel(id: string): void {
    const job = this.store.get<LifecycleJob>("job", id);
    if (!job) throw new Error("Unknown job.");
    if (this.controllers.has(id))
      this.controllers.get(id)!.abort(new Error("Download cancelled."));
    else if (["queued", "waiting-for-idle"].includes(job.state))
      this.change(job, {
        state: "cancelled",
        detail: "Cancelled before execution.",
      });
    else
      throw new Error(
        "This operation cannot be safely cancelled. Reconcile it after the native operation finishes.",
      );
  }
  async reconcile(id: string, internal = false): Promise<LifecycleJob> {
    const job = this.store.get<LifecycleJob>("job", id);
    if (!job) throw new Error("Unknown job.");
    if (this.controllers.has(id))
      throw new Error("A download is still active.");
    const plan = this.store.get<LifecyclePlan>("plan", job.planId)!;
    if (!internal && this.busy.has(plan.managementUnitId))
      throw new Error(
        "The operation is still executing. Wait for its recorded outcome before reconciliation.",
      );
    if (["completed", "unchanged", "cancelled", "failed"].includes(job.state))
      return job;
    const installations = await this.deps.discover();
    const installation =
      installations.find((i) => i.id === plan.installationId) ??
      installations.find(
        (i) =>
          i.appId === plan.appId &&
          (plan.installationId
            ? i.managementUnitId === plan.managementUnitId
            : true) &&
          (!plan.release || i.version === plan.release.version),
      );
    if (
      plan.route === "native" &&
      plan.action === "update" &&
      !plan.release &&
      ["awaiting-native", "uncertain"].includes(job.state) &&
      installation?.revisionId === plan.expectedRevision &&
      installation?.version === plan.installedVersion &&
      !this.deps.active(plan.managementUnitId)
    ) {
      const related = installations.filter(
        (i) => i.managementUnitId === plan.managementUnitId,
      );
      const processes = await (this.deps.processes ?? affectedProcesses)(
        related.map((i) => i.realPath),
      );
      if (processes?.length === 0) {
        this.change(job, {
          state: "unchanged",
          actualVersion: installation?.version ?? null,
          detail:
            "The native flow is closed and the installation is unchanged. No update is claimed. Any new attempt requires a fresh review.",
        });
        return job;
      }
    }
    if (
      installation?.version &&
      (!plan.release || installation.version === plan.release.version) &&
      (plan.action !== "update" ||
        installation.version !== plan.installedVersion)
    ) {
      this.change(job, {
        state: "completed",
        actualVersion: installation.version,
        detail:
          "Installed version verified. Topsl compatibility is evaluated separately; old processes may still need a restart.",
      });
    } else if (job.state === "waiting-for-idle") {
      void this.execute(job);
    } else
      this.change(job, {
        state: "uncertain",
        actualVersion: installation?.version ?? null,
        detail:
          "The approved target version cannot be confirmed. No operation was repeated. Resolve this installation through its native owner; check again afterward.",
      });
    return job;
  }
  async tick(): Promise<void> {
    for (const job of this.store
      .list<LifecycleJob>("job")
      .filter((j) => j.state === "waiting-for-idle"))
      if (
        !this.busy.has(
          this.store.get<LifecyclePlan>("plan", job.planId)!.managementUnitId,
        )
      )
        await this.execute(job);
  }
}
