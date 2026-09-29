import os from "node:os";
import path from "node:path";
import { open, realpath, stat } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import type {
  Project,
  ProjectSource,
  ProjectSourceReference,
  ProjectSyncState,
  NativeProject,
} from "../domain/types";
import { hash, now, uid } from "../domain/invariants";
import { Store } from "../persistence/store";

export interface ProjectSourcePaths {
  codexHome: string;
  claudeConfig: string;
}
export function projectSourcePaths(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ProjectSourcePaths {
  return {
    codexHome: path.resolve(env.CODEX_HOME || path.join(home, ".codex")),
    claudeConfig: env.CLAUDE_CONFIG_DIR
      ? path.resolve(env.CLAUDE_CONFIG_DIR, ".claude.json")
      : path.join(home, ".claude.json"),
  };
}
interface NativeFolder {
  path: string;
  name: string | null;
  nativeProjectId: string | null;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    !/[\x00-\x1f]/.test(value) &&
    path.isAbsolute(value)
  );
}
export function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Compatibility readers project only folder metadata. Native stores are never written.
// Unknown structures fail the whole source, retaining its last successful observation.
export function parseProjectFolders(
  sourceId: string,
  text: string,
): NativeFolder[] {
  let data: unknown;
  try {
    data = sourceId === "codex-cli" ? parseToml(text) : JSON.parse(text);
  } catch {
    throw new Error(
      "Project metadata is incomplete or invalid. Retry after the native app finishes saving.",
    );
  }
  if (!object(data)) throw new Error("Unrecognized project metadata format.");
  const folders: NativeFolder[] = [];
  const add = (
    folder: unknown,
    name: unknown = null,
    nativeId: unknown = null,
  ) => {
    if (!validPath(folder))
      throw new Error(
        "Project metadata contains a non-local or invalid folder path.",
      );
    if (name !== null && (typeof name !== "string" || name.length > 200))
      throw new Error("Unrecognized project name format.");
    if (
      nativeId !== null &&
      (typeof nativeId !== "string" || nativeId.length > 256)
    )
      throw new Error("Unrecognized native project identity.");
    folders.push({
      path: path.normalize(folder),
      name: name as string | null,
      nativeProjectId: nativeId as string | null,
    });
    if (folders.length > 2000)
      throw new Error("This source exceeds the 2,000-folder pilot limit.");
  };
  if (sourceId === "codex-desktop") {
    const roots = data["electron-saved-workspace-roots"];
    const projects = data["local-projects"];
    if (
      roots === undefined &&
      projects === undefined &&
      Object.keys(data).length
    )
      throw new Error(
        "This desktop project format is not supported by this reader.",
      );
    if (roots !== undefined) {
      if (!Array.isArray(roots))
        throw new Error("Unrecognized saved-folder format.");
      for (const root of roots) add(root);
    }
    if (projects !== undefined) {
      if (!object(projects))
        throw new Error("Unrecognized local-project format.");
      for (const [id, project] of Object.entries(projects)) {
        if (!object(project) || !Array.isArray(project.rootPaths))
          throw new Error("Unrecognized local-project folder format.");
        for (const root of project.rootPaths)
          add(root, project.name ?? null, id);
      }
    }
  } else if (sourceId === "codex-cli" || sourceId === "claude") {
    if (data.projects !== undefined) {
      if (!object(data.projects))
        throw new Error("Unrecognized native projects table.");
      for (const folder of Object.keys(data.projects)) add(folder);
    }
  } else throw new Error("Unknown project source.");
  return [
    ...new Map(
      folders.map((folder) => [
        pathKey(folder.path) + ":" + folder.nativeProjectId,
        folder,
      ]),
    ).values(),
  ];
}
async function readMetadata(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    const limit = 8 * 1024 * 1024;
    if (!before.isFile() || before.size > limit)
      throw new Error(
        "Project metadata is not a regular file within the 8 MB limit.",
      );
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      count > limit ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error(
        "Project metadata changed while reading. Retry after the native app finishes saving.",
      );
    return bytes.subarray(0, count).toString("utf8");
  } finally {
    await handle.close();
  }
}
export async function resolveFolder(folder: string): Promise<string | null> {
  try {
    const canonical = await realpath(folder);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}
export async function requireProjectFolder(project: Project): Promise<Project> {
  if (!project.trusted)
    throw new Error(
      "Trust this project in Projects before starting a native session.",
    );
  const canonical = await resolveFolder(project.path);
  if (!canonical)
    throw new Error(
      "The project folder is unavailable. Relink it in Projects.",
    );
  if (pathKey(canonical) !== pathKey(project.realPath))
    throw new Error(
      "The project path changed. Relink and approve it in Projects.",
    );
  return project;
}
export class ProjectSync {
  private inFlight?: Promise<void>;
  private generation = 0;
  private closed = false;
  constructor(
    private store: Store,
    private changed: () => void,
    private paths = projectSourcePaths(),
  ) {}
  private definitions(): ProjectSource[] {
    const base = {
      status: "disabled" as const,
      checkedAt: null,
      lastSuccessAt: null,
      folders: 0,
      detail: "Enable discovery to include native project folders.",
    };
    return [
      {
        ...base,
        id: "codex-desktop",
        name: "Codex desktop saved folders",
        appIds: ["openai.desktop"],
        path: path.join(this.paths.codexHome, ".codex-global-state.json"),
      },
      {
        ...base,
        id: "codex-cli",
        name: "Codex configured projects",
        appIds: ["openai.codex-cli"],
        path: path.join(this.paths.codexHome, "config.toml"),
      },
      {
        ...base,
        id: "claude",
        name: "Claude shared project metadata",
        appIds: ["anthropic.claude-code-cli", "anthropic.claude-desktop"],
        path: this.paths.claudeConfig,
      },
    ];
  }
  private scope(): string {
    return hash(JSON.stringify(this.definitions().map((s) => [s.id, s.path])));
  }
  enabled(): boolean {
    const preference = this.store.get<{ enabled: boolean; scope: string }>(
      "preference",
      "project-sync",
    );
    return preference?.enabled === true && preference.scope === this.scope();
  }
  state(): ProjectSyncState {
    const enabled = this.enabled();
    return {
      enabled,
      refreshing: !!this.inFlight,
      sources: this.definitions().map((source) => {
        const previous = this.store.get<ProjectSource>(
          "project-source",
          source.id,
        );
        if (previous?.path !== source.path) return source;
        return enabled
          ? previous
          : {
              ...previous,
              status: "disabled",
              detail:
                "Discovery paused. Previously discovered projects are retained.",
            };
      }),
    };
  }
  async enable(enabled: boolean): Promise<void> {
    this.generation++;
    this.store.save("preference", {
      id: "project-sync",
      enabled,
      scope: this.scope(),
    });
    this.changed();
    if (enabled) {
      await this.inFlight;
      await this.refresh();
    }
  }
  async add(folder: string): Promise<Project> {
    if (!validPath(folder))
      throw new Error("Select a local project directory.");
    const canonical = await resolveFolder(folder);
    if (!canonical) throw new Error("Select an existing project directory.");
    const previous = this.store
      .list<Project>("project")
      .find((p) => pathKey(p.realPath) === pathKey(canonical));
    if (!previous && this.store.list("project").length >= 5000)
      throw new Error(
        "The shared catalog reached its 5,000-folder pilot limit.",
      );
    const project: Project = {
      id: previous?.id ?? uid(),
      name: previous?.name ?? (path.basename(canonical) || canonical),
      createdAt: previous?.createdAt ?? now(),
      sources: previous?.sources ?? [],
      nameSource: previous?.nameSource,
      path: folder,
      realPath: canonical,
      trusted: true,
      availability: "available",
    };
    this.store.save("project", project);
    this.changed();
    return project;
  }
  async trust(id: string, expectedPath: string): Promise<Project> {
    const project = this.store.get<Project>("project", id);
    if (!project || project.path !== expectedPath)
      throw new Error("The project changed during review.");
    await requireProjectFolder({ ...project, trusted: true });
    const current = this.store.get<Project>("project", id);
    if (
      !current ||
      current.path !== project.path ||
      current.realPath !== project.realPath
    )
      throw new Error("The project changed during review.");
    const updated = {
      ...current,
      trusted: true,
      availability: "available" as const,
    };
    this.store.save("project", updated);
    this.changed();
    return updated;
  }
  async relink(id: string, folder: string): Promise<Project> {
    const project = this.store.get<Project>("project", id);
    if (!project) throw new Error("The project no longer exists.");
    const canonical = validPath(folder) ? await resolveFolder(folder) : null;
    if (!canonical) throw new Error("Select an existing project directory.");
    const current = this.store.get<Project>("project", id);
    if (
      !current ||
      current.path !== project.path ||
      current.realPath !== project.realPath
    )
      throw new Error("The project changed during review.");
    if (
      this.store
        .list<Project>("project")
        .some((p) => p.id !== id && pathKey(p.realPath) === pathKey(canonical))
    )
      throw new Error(
        "This folder already belongs to another project. Projects with separate histories are not merged automatically.",
      );
    const updated: Project = {
      ...current,
      path: folder,
      realPath: canonical,
      trusted: true,
      availability: "available",
      sources: [],
      nameSource: undefined,
    };
    this.store.save("project", updated, "project.relinked");
    this.changed();
    return updated;
  }
  async observeNative(
    native: NativeProject[],
    current: () => boolean,
  ): Promise<void> {
    const entries: Array<{
      project: NativeProject;
      folder: string;
      canonical: string | null;
    }> = [];
    for (const project of native)
      for (const folder of project.roots) {
        if (this.closed || !current()) return;
        entries.push({
          project,
          folder,
          canonical: await resolveFolder(folder),
        });
      }
    if (this.closed || !current()) return;
    const observedAt = now();
    this.store.transaction(() => {
      const projects = this.store.list<Project>("project");
      const byPath = new Map(projects.map((p) => [pathKey(p.path), p]));
      const byCanonical = new Map(
        projects.map((p) => [pathKey(p.realPath), p]),
      );
      const named = new Set<string>();
      for (const project of projects)
        project.sources = (project.sources ?? []).filter(
          (s) => s.sourceId !== "codex-project-api",
        );
      for (const { project: nativeProject, folder, canonical } of entries) {
        let project =
          byPath.get(pathKey(folder)) ??
          byCanonical.get(pathKey(canonical ?? folder));
        if (!project) {
          if (projects.length >= 5000)
            throw new Error(
              "The shared catalog reached its 5,000-folder limit.",
            );
          project = {
            id: uid(),
            name: nativeProject.name,
            path: folder,
            realPath: canonical ?? folder,
            trusted: false,
            createdAt: observedAt,
            availability: canonical ? "available" : "missing",
            sources: [],
          };
          projects.push(project);
          byPath.set(pathKey(folder), project);
          byCanonical.set(pathKey(project.realPath), project);
        }
        if (!named.has(project.id)) {
          project.name = nativeProject.name;
          project.nameSource = {
            sourceId: "codex-project-api",
            nativeProjectId: nativeProject.id,
          };
          named.add(project.id);
        }
        // A changed symlink must never transfer existing trust to a different directory.
        if (pathKey(project.path) === pathKey(folder)) {
          project.availability = !canonical
            ? "missing"
            : pathKey(canonical) === pathKey(project.realPath)
              ? "available"
              : "changed";
          if (project.availability === "changed") project.trusted = false;
        }
        project.sources!.push({
          sourceId: "codex-project-api",
          path: folder,
          name: nativeProject.name,
          nativeProjectId: nativeProject.id,
          observedAt,
        });
      }
      for (const project of projects) this.store.put("project", project);
    });
    this.changed();
  }
  refresh(): Promise<void> {
    if (this.closed || !this.enabled()) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.inFlight = this.scan(generation).finally(() => {
      this.inFlight = undefined;
      if (!this.closed) this.changed();
    });
    this.changed();
    return this.inFlight;
  }
  private async scan(generation: number): Promise<void> {
    const observedAt = now();
    const resolved = new Map<string, Promise<string | null>>();
    const resolve = (folder: string) => {
      if (!resolved.has(folder)) resolved.set(folder, resolveFolder(folder));
      return resolved.get(folder)!;
    };
    const results = await Promise.all(
      this.definitions().map(async (source) => {
        const previous = this.store.get<ProjectSource>(
          "project-source",
          source.id,
        );
        try {
          const folders = parseProjectFolders(
            source.id,
            await readMetadata(source.path),
          );
          const entries = [];
          for (const folder of folders)
            entries.push({ ...folder, canonical: await resolve(folder.path) });
          return {
            source: {
              ...source,
              status: "ready" as const,
              checkedAt: observedAt,
              lastSuccessAt: observedAt,
              folders: entries.length,
              detail:
                "Folder metadata refreshed. Native project lists remain owned by each app.",
            },
            entries,
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return {
            source: {
              ...source,
              checkedAt: observedAt,
              lastSuccessAt: previous?.lastSuccessAt ?? null,
              folders: previous?.folders ?? 0,
              status:
                code === "ENOENT" ? ("missing" as const) : ("error" as const),
              // Never surface a parser excerpt or OS error containing native settings.
              detail:
                code === "ENOENT"
                  ? "No metadata file found. Last known folders are retained."
                  : code
                    ? "Cannot read project metadata. Check file access, then retry."
                    : (error as Error).message,
            },
            entries: null,
          };
        }
      }),
    );
    if (this.closed || generation !== this.generation || !this.enabled())
      return;
    const checked = new Map<
      string,
      {
        path: string;
        realPath: string;
        availability: NonNullable<Project["availability"]>;
      }
    >();
    for (const project of this.store.list<Project>("project")) {
      const canonical = await resolve(project.path);
      checked.set(project.id, {
        path: project.path,
        realPath: project.realPath,
        availability:
          canonical === null
            ? "missing"
            : pathKey(canonical) === pathKey(project.realPath)
              ? "available"
              : "changed",
      });
    }
    if (this.closed || generation !== this.generation || !this.enabled())
      return;
    this.store.transaction(() => {
      const projects = this.store.list<Project>("project");
      const byCanonical = new Map(
        projects.map((p) => [pathKey(p.realPath), p]),
      );
      const byPath = new Map(projects.map((p) => [pathKey(p.path), p]));
      for (const { source, entries } of results) {
        this.store.put("project-source", source);
        if (entries === null) continue;
        for (const project of projects)
          project.sources = (project.sources ?? []).filter(
            (s) => s.sourceId !== source.id,
          );
        for (const entry of entries) {
          let project =
            byPath.get(pathKey(entry.path)) ??
            byCanonical.get(pathKey(entry.canonical ?? entry.path));
          if (!project) {
            if (projects.length >= 5000) {
              this.store.put("project-source", {
                ...source,
                status: "error",
                detail:
                  "The shared catalog reached its 5,000-folder pilot limit. Some folders were not added.",
              });
              break;
            }
            project = {
              id: uid(),
              name: entry.name || path.basename(entry.path) || entry.path,
              path: entry.path,
              realPath: entry.canonical ?? entry.path,
              trusted: false,
              createdAt: observedAt,
              availability: entry.canonical ? "available" : "missing",
              sources: [],
              nameSource: {
                sourceId: source.id,
                nativeProjectId: entry.nativeProjectId,
              },
            };
            projects.push(project);
            byCanonical.set(pathKey(project.realPath), project);
            byPath.set(pathKey(project.path), project);
          }
          if (
            entry.name &&
            project.nameSource &&
            (project.nameSource.nativeProjectId === null ||
              (project.nameSource.sourceId === source.id &&
                project.nameSource.nativeProjectId === entry.nativeProjectId))
          ) {
            project.name = entry.name;
            project.nameSource = {
              sourceId: source.id,
              nativeProjectId: entry.nativeProjectId,
            };
          }
          const reference: ProjectSourceReference = {
            sourceId: source.id,
            path: entry.path,
            name: entry.name,
            nativeProjectId: entry.nativeProjectId,
            observedAt,
          };
          project.sources!.push(reference);
        }
      }
      for (const project of projects) {
        const check = checked.get(project.id);
        if (
          check?.path === project.path &&
          check.realPath === project.realPath
        ) {
          project.availability = check.availability;
          if (check.availability === "changed") project.trusted = false;
        }
        this.store.put("project", project);
      }
    });
  }
  close(): void {
    this.closed = true;
    this.generation++;
  }
}
