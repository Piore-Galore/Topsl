import path from "node:path";
import { z } from "zod";
import type {
  CodexProjectSyncState,
  Installation,
  NativeProject,
  Project,
} from "../domain/types";
import { hash, now, uid } from "../domain/invariants";
import { Store } from "../persistence/store";
import { identity, nativeEnvironment } from "../platform/system";
import { RpcPeer } from "../runtime/rpc";
import {
  pathKey,
  ProjectSync,
  requireProjectFolder,
  resolveFolder,
} from "./projects";

// Version-specific experimental protocol, verified against the installed CLI's
// generated schemas. Only projected folder metadata is persisted; native metadata
// and authentication are neither copied nor rewritten.
const nativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value));
const nativeSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  roots: z.array(z.object({ path: nativePath })).max(2000),
  position: z.number().int(),
});
const pageSchema = z.object({
  data: z.array(nativeSchema).max(2000),
  nextCursor: z.string().max(4096).nullish(),
});
function projectView(project: z.infer<typeof nativeSchema>): NativeProject {
  const value = {
    id: project.id,
    name: project.name,
    roots: project.roots.map((r) => r.path),
    position: project.position,
  };
  return { ...value, revision: hash(JSON.stringify(value)) };
}
export function nativeOrderRevision(projects: NativeProject[]): string {
  return hash(JSON.stringify(projects.map((p) => [p.id, p.revision])));
}
export function orderLocalProjects(
  projects: Project[],
  native: NativeProject[],
): Project[] {
  const order = new Map<string, number>();
  for (const project of native)
    for (const root of project.roots)
      order.set(JSON.stringify([project.id, pathKey(root)]), order.size);
  const rank = (project: Project) =>
    Math.min(
      Infinity,
      ...(project.sources ?? [])
        .filter((source) => source.sourceId === "codex-project-api")
        .map(
          (source) =>
            order.get(
              JSON.stringify([source.nativeProjectId, pathKey(source.path)]),
            ) ?? Infinity,
        ),
    );
  return [...projects].sort((a, b) => rank(a) - rank(b));
}
interface Preference {
  id: string;
  enabled: boolean;
  configuredHome: string;
  realHome: string;
  installationId: string;
  installationIdentity: string;
  installationPath: string;
}
interface Observation {
  id: string;
  status: "ready" | "error";
  detail: string;
  lastSuccessAt: string | null;
  projects: NativeProject[];
}
interface Link {
  id: string;
  path: string;
  nativeId: string | null;
  operationKey: string;
  requestedName?: string;
}
export interface ProjectPeer {
  request(method: string, params: unknown, timeout?: number): Promise<any>;
  notify(method: string, params?: unknown): void;
  close(): void;
}
type PeerFactory = (
  installation: Installation,
  directory: string,
  home: string,
) => ProjectPeer;
const makePeer: PeerFactory = (installation, directory, home) =>
  new RpcPeer(
    installation.realPath,
    ["app-server"],
    directory,
    nativeEnvironment({ CODEX_HOME: home }),
  );
const preferenceId = "codex-project-sync";
const readyDetail =
  "Codex project registry refreshed. The desktop sidebar may use a separate cache; open the folder in Codex to check its visible entry.";

export class CodexProjectSync {
  private inFlight?: Promise<void>;
  private activePeer?: ProjectPeer;
  private generation = 0;
  private closed = false;
  constructor(
    private store: Store,
    private catalog: ProjectSync,
    private directory: string,
    private home: string,
    private changed: () => void,
    private peerFactory: PeerFactory = makePeer,
  ) {}
  private preference(): Preference | undefined {
    const pref = this.store.get<Preference>("preference", preferenceId);
    return pref?.configuredHome === this.home ? pref : undefined;
  }
  private observationId(pref: Preference): string {
    return hash(pref.realHome);
  }
  state(): CodexProjectSyncState {
    const pref = this.preference();
    const observation =
      pref &&
      this.store.get<Observation>(
        "codex-project-observation",
        this.observationId(pref),
      );
    const projects = observation?.projects ?? [];
    return {
      enabled: pref?.enabled === true,
      refreshing: !!this.inFlight,
      installationId: pref?.installationId ?? null,
      home: this.home,
      status: pref?.enabled ? (observation?.status ?? "disabled") : "disabled",
      detail: pref?.enabled
        ? (observation?.detail ??
          "Waiting for the first native project refresh.")
        : "Choose a trusted Codex runtime to share trusted folders and read native project names and order.",
      lastSuccessAt: observation?.lastSuccessAt ?? null,
      projects,
      orderRevision: nativeOrderRevision(projects),
    };
  }
  async enable(installationId: string): Promise<void> {
    if (this.closed) throw new Error("Project synchronization is closed.");
    if (this.inFlight)
      throw new Error(
        "Wait for the current project refresh before changing the connection.",
      );
    const generation = this.generation;
    const installation = this.store.get<Installation>(
      "installation",
      installationId,
    );
    if (
      !installation?.trusted ||
      installation.appId !== "openai.codex-cli" ||
      /\.cmd$/i.test(installation.path)
    )
      throw new Error(
        "Choose a trusted Codex executable in Applications first.",
      );
    if ((await identity(installation.path)).identity !== installation.identity)
      throw new Error(
        "The Codex executable changed. Rediscover and trust it before synchronizing projects.",
      );
    const realHome = await resolveFolder(this.home);
    if (!realHome)
      throw new Error(
        "Open Codex once to create its local profile before enabling project synchronization.",
      );
    if (this.closed || generation !== this.generation)
      throw new Error("Project synchronization was paused.");
    this.generation++;
    this.store.put("preference", {
      id: preferenceId,
      enabled: true,
      configuredHome: this.home,
      realHome,
      installationId,
      installationIdentity: installation.identity,
      installationPath: installation.realPath,
    } satisfies Preference);
    this.changed();
    await this.refresh();
  }
  pause(): void {
    this.generation++;
    const pref = this.preference();
    if (pref) this.store.put("preference", { ...pref, enabled: false });
    this.activePeer?.close();
    this.changed();
  }
  private current(generation: number): boolean {
    return (
      !this.closed &&
      generation === this.generation &&
      this.preference()?.enabled === true
    );
  }
  private check(generation: number): void {
    if (!this.current(generation))
      throw new Error("Project synchronization was paused.");
  }
  private async request(
    peer: ProjectPeer,
    generation: number,
    method: string,
    params: unknown,
  ): Promise<any> {
    this.check(generation);
    let response: unknown;
    try {
      response = await peer.request(method, params, 10_000);
    } catch {
      this.check(generation);
      throw new Error(
        method === "project/list"
          ? "This Codex runtime could not list projects. Its experimental project API may be unavailable. Choose a supported runtime or retry."
          : "Codex did not confirm the project change. Refresh to reconcile it before trying again.",
      );
    }
    this.check(generation);
    return response;
  }
  private async list(
    peer: ProjectPeer,
    generation: number,
  ): Promise<NativeProject[]> {
    const projects: NativeProject[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    do {
      const result = pageSchema.safeParse(
        await this.request(peer, generation, "project/list", {
          cursor,
          limit: 100,
          sortKey: "position",
          sortDirection: "asc",
        }),
      );
      if (!result.success)
        throw new Error(
          "Codex returned an unsupported project format. The last successful catalog is retained.",
        );
      for (const entry of result.data.data) {
        if (ids.has(entry.id))
          throw new Error(
            "Codex projects changed during pagination. Refresh to try again.",
          );
        ids.add(entry.id);
        projects.push(projectView(entry));
      }
      if (
        projects.length > 2000 ||
        projects.reduce((n, p) => n + p.roots.length, 0) > 5000
      )
        throw new Error(
          "Codex projects exceed the pilot's 2,000-project or 5,000-folder limit.",
        );
      cursor = result.data.nextCursor ?? null;
      if (cursor && (cursors.has(cursor) || !result.data.data.length))
        throw new Error("Codex returned an invalid project cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return projects.sort(
      (a, b) => a.position - b.position || a.id.localeCompare(b.id),
    );
  }
  private parseProject(result: unknown): NativeProject {
    const parsed = z.object({ project: nativeSchema }).safeParse(result);
    if (!parsed.success)
      throw new Error(
        "Codex returned an unsupported project response. Refresh before continuing.",
      );
    return projectView(parsed.data.project);
  }
  private linkId(pref: Preference, folder: string): string {
    return hash(JSON.stringify([pref.realHome, pathKey(folder)]));
  }
  private async share(
    peer: ProjectPeer,
    pref: Preference,
    generation: number,
    native: NativeProject[],
  ): Promise<string[]> {
    const createdIds: string[] = [];
    const roots = new Map<string, string>();
    for (const project of native)
      for (const folder of project.roots) {
        const canonical = await resolveFolder(folder);
        this.check(generation);
        const key = pathKey(canonical ?? folder);
        if (!roots.has(key)) roots.set(key, project.id);
      }
    // Remember observed memberships, including untrusted folders, so a native
    // removal never causes an automatic recreation on a subsequent refresh.
    for (const [folder, nativeId] of roots) {
      const id = this.linkId(pref, folder);
      const old = this.store.get<Link>("codex-project-link", id);
      this.store.put("codex-project-link", {
        id,
        path: folder,
        nativeId,
        operationKey: old?.operationKey ?? `topsl:${uid()}`,
      } satisfies Link);
    }
    for (const candidate of this.store.list<Project>("project").reverse()) {
      this.check(generation);
      if (
        !candidate.trusted ||
        candidate.availability === "missing" ||
        candidate.availability === "changed" ||
        roots.has(pathKey(candidate.realPath))
      )
        continue;
      const id = this.linkId(pref, candidate.realPath);
      const old = this.store.get<Link>("codex-project-link", id);
      if (old?.nativeId) continue; // Native removal is authoritative for membership.
      try {
        await requireProjectFolder(candidate);
      } catch {
        continue;
      }
      this.check(generation);
      const current = this.store.get<Project>("project", candidate.id);
      if (
        !current?.trusted ||
        current.path !== candidate.path ||
        current.realPath !== candidate.realPath
      )
        continue;
      const link: Link = old ?? {
        id,
        path: candidate.realPath,
        nativeId: null,
        operationKey: `topsl:${uid()}`,
      };
      link.requestedName ??= current.name;
      // Persist the idempotency key before sending, including across crashes and lost replies.
      this.store.put("codex-project-link", link);
      const created = this.parseProject(
        await this.request(peer, generation, "project/create", {
          idempotencyKey: link.operationKey,
          name: link.requestedName,
          roots: [{ path: current.realPath }],
        }),
      );
      if (
        !created.roots.some(
          (root) => pathKey(root) === pathKey(current.realPath),
        )
      )
        throw new Error(
          "Codex returned a different project folder. Refresh to reconcile the native registry.",
        );
      this.store.put("codex-project-link", { ...link, nativeId: created.id });
      createdIds.push(created.id);
      roots.set(pathKey(current.realPath), created.id);
    }
    return createdIds;
  }
  private async publish(
    pref: Preference,
    generation: number,
    native: NativeProject[],
  ): Promise<void> {
    await this.catalog.observeNative(native, () => this.current(generation));
    this.check(generation);
    this.store.put("codex-project-observation", {
      id: this.observationId(pref),
      status: "ready",
      detail: readyDetail,
      lastSuccessAt: now(),
      projects: native,
    } satisfies Observation);
  }
  private run(
    work: (
      peer: ProjectPeer,
      pref: Preference,
      generation: number,
    ) => Promise<void>,
  ): Promise<void> {
    const pref = this.preference();
    if (!pref?.enabled || this.closed)
      return Promise.reject(
        new Error("Enable Codex project synchronization first."),
      );
    if (this.inFlight)
      return Promise.reject(
        new Error("Wait for the current project refresh to finish."),
      );
    const generation = this.generation;
    this.inFlight = (async () => {
      let peer: ProjectPeer | undefined;
      try {
        const installation = this.store.get<Installation>(
          "installation",
          pref.installationId,
        );
        if (
          !installation?.trusted ||
          installation.appId !== "openai.codex-cli" ||
          installation.identity !== pref.installationIdentity ||
          installation.realPath !== pref.installationPath ||
          (await identity(installation.path)).identity !==
            pref.installationIdentity
        )
          throw new Error(
            "The selected Codex runtime changed or is no longer trusted. Review it in Applications and reconnect project synchronization.",
          );
        if ((await resolveFolder(this.home)) !== pref.realHome)
          throw new Error(
            "The Codex profile path changed. Reconnect project synchronization for the new profile.",
          );
        this.check(generation);
        peer = this.peerFactory(installation, this.directory, pref.realHome);
        this.activePeer = peer;
        await this.request(peer, generation, "initialize", {
          clientInfo: {
            name: "topsl-projects",
            title: "Topsl project synchronization",
            version: "0.1.1",
          },
          capabilities: { experimentalApi: true },
        });
        peer.notify("initialized");
        await work(peer, pref, generation);
      } catch (error) {
        if (this.current(generation)) {
          const old = this.store.get<Observation>(
            "codex-project-observation",
            this.observationId(pref),
          );
          this.store.put("codex-project-observation", {
            id: this.observationId(pref),
            status: "error",
            detail:
              error instanceof Error
                ? error.message
                : "Native project synchronization failed.",
            lastSuccessAt: old?.lastSuccessAt ?? null,
            projects: old?.projects ?? [],
          } satisfies Observation);
        }
        throw error;
      } finally {
        peer?.close();
        if (this.activePeer === peer) this.activePeer = undefined;
      }
    })().finally(() => {
      this.inFlight = undefined;
      if (!this.closed) this.changed();
    });
    this.changed();
    return this.inFlight;
  }
  refresh(): Promise<void> {
    if (this.closed || !this.preference()?.enabled) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    return this.run(async (peer, pref, generation) => {
      const native = await this.list(peer, generation);
      await this.catalog.observeNative(native, () => this.current(generation));
      this.check(generation);
      const createdIds = await this.share(peer, pref, generation, native);
      const verified = await this.list(peer, generation);
      if (createdIds.some((id) => !verified.some((p) => p.id === id)))
        throw new Error(
          "A created project is missing from the Codex registry. Refresh to reconcile it.",
        );
      await this.publish(pref, generation, verified);
    });
  }
  rename(id: string, expectedRevision: string, name: string): Promise<void> {
    return this.run(async (peer, pref, generation) => {
      const project = this.parseProject(
        await this.request(peer, generation, "project/read", { projectId: id }),
      );
      if (project.id !== id || project.revision !== expectedRevision)
        throw new Error(
          "Codex changed this project. Refresh projects and review the new name before renaming it.",
        );
      // Partial update preserves every native root and metadata key.
      const updated = this.parseProject(
        await this.request(peer, generation, "project/update", {
          projectId: id,
          name,
        }),
      );
      if (updated.id !== id || updated.name !== name)
        throw new Error(
          "Codex did not confirm the requested name. Refresh projects to reconcile it.",
        );
      await this.publish(pref, generation, await this.list(peer, generation));
    });
  }
  move(
    id: string,
    beforeProjectId: string | null,
    expectedOrderRevision: string,
  ): Promise<void> {
    return this.run(async (peer, pref, generation) => {
      const native = await this.list(peer, generation);
      if (nativeOrderRevision(native) !== expectedOrderRevision)
        throw new Error(
          "Codex project order changed. Refresh projects before reordering it.",
        );
      if (
        id === beforeProjectId ||
        !native.some((p) => p.id === id) ||
        (beforeProjectId !== null &&
          !native.some((p) => p.id === beforeProjectId))
      )
        throw new Error("Select existing Codex projects to reorder.");
      await this.request(peer, generation, "project/move", {
        projectId: id,
        beforeProjectId,
      });
      const verified = await this.list(peer, generation);
      const index = verified.findIndex((p) => p.id === id);
      if (
        index < 0 ||
        (beforeProjectId === null
          ? index !== verified.length - 1
          : verified[index + 1]?.id !== beforeProjectId)
      )
        throw new Error(
          "Codex project order changed before verification. Refresh to review the current order.",
        );
      await this.publish(pref, generation, verified);
    });
  }
  close(): void {
    this.closed = true;
    this.generation++;
    this.activePeer?.close();
  }
}
