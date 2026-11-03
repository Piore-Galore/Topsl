import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { Project, ProjectOrder } from "../domain/types";
import { now, uid } from "../domain/invariants";
import { Store } from "../persistence/store";

/**
 * The local project catalog (docs/UX_Cleanup_Plan.md §2). Projects are
 * folders the owner adds, names, orders, trusts and relinks in Topsl.
 * Nothing is discovered from, or synchronized with, native applications.
 */

const orderId = "project-order";
export const MAX_PROJECTS = 5000;

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

/**
 * Projects in the owner's order. Projects the order does not name yet follow
 * it, newest first, which is how a catalog without an order was shown.
 */
export function orderProjects(projects: Project[], order: string[]): Project[] {
  const position = new Map(order.map((id, index) => [id, index]));
  const listed = projects
    .filter((p) => position.has(p.id))
    .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  const rest = projects.filter((p) => !position.has(p.id));
  return [...listed, ...rest];
}
/** A project name the owner typed, trimmed; control characters are refused. */
export function projectName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name))
    throw new Error("Use a name of 1 to 200 characters.");
  return name;
}

export class ProjectCatalog {
  constructor(
    private store: Store,
    private changed: () => void,
  ) {}
  private orderRecord(): ProjectOrder {
    return (
      this.store.get<ProjectOrder>("preference", orderId) ?? {
        id: orderId,
        order: [],
        revision: 0,
      }
    );
  }
  /** Every project, in the owner's order. */
  list(): Project[] {
    return orderProjects(
      this.store.list<Project>("project"),
      this.orderRecord().order,
    );
  }
  orderRevision(): number {
    return this.orderRecord().revision;
  }
  private saveOrder(order: string[]): void {
    const current = this.orderRecord();
    this.store.save("preference", {
      id: orderId,
      order,
      revision: current.revision + 1,
    } satisfies ProjectOrder);
  }
  async add(folder: string): Promise<Project> {
    if (!validPath(folder))
      throw new Error("Select a local project directory.");
    const canonical = await resolveFolder(folder);
    if (!canonical) throw new Error("Select an existing project directory.");
    // One folder is one project: adding a known folder again reuses it.
    const previous = this.store
      .list<Project>("project")
      .find((p) => pathKey(p.realPath) === pathKey(canonical));
    if (!previous && this.store.list("project").length >= MAX_PROJECTS)
      throw new Error("The catalog reached its 5,000-folder limit.");
    const project: Project = {
      id: previous?.id ?? uid(),
      name: previous?.name ?? (path.basename(canonical) || canonical),
      createdAt: previous?.createdAt ?? now(),
      path: folder,
      realPath: canonical,
      trusted: true,
      availability: "available",
    };
    this.store.transaction(() => {
      this.store.save("project", project);
      // A new project goes first, as before the catalog had an order.
      if (!previous)
        this.saveOrder([
          project.id,
          ...this.list()
            .map((p) => p.id)
            .filter((id) => id !== project.id),
        ]);
    });
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
  async relink(
    id: string,
    folder: string,
    applyWorkspaceMapping?: (project: Project) => void,
  ): Promise<Project> {
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
    };
    this.store.transaction(() => {
      applyWorkspaceMapping?.(updated);
      this.store.save("project", updated, "project.relinked");
    });
    this.changed();
    return updated;
  }
  /** Renames a project in Topsl only; the folder is not touched. */
  rename(id: string, expectedName: string, name: string): Project {
    const current = this.store.get<Project>("project", id);
    if (!current) throw new Error("The project no longer exists.");
    if (current.name !== expectedName)
      throw new Error(
        "This project was renamed meanwhile. Check its name and try again.",
      );
    const updated = { ...current, name: projectName(name) };
    this.store.save("project", updated);
    this.changed();
    return updated;
  }
  /** Moves a project one place up or down in the catalog's order. */
  move(
    id: string,
    direction: "up" | "down",
    expectedOrderRevision: number,
  ): { order: string[]; revision: number } {
    if (this.orderRevision() !== expectedOrderRevision)
      throw new Error(
        "The project order changed meanwhile. Check the list and try again.",
      );
    const order = this.list().map((p) => p.id);
    const index = order.indexOf(id);
    if (index < 0) throw new Error("The project no longer exists.");
    const target = index + (direction === "up" ? -1 : 1);
    if (target >= 0 && target < order.length)
      [order[index], order[target]] = [order[target], order[index]];
    this.saveOrder(order);
    this.changed();
    return { order, revision: this.orderRevision() };
  }
  /**
   * Re-checks each project's folder so Projects shows a missing or moved
   * one. It reads nothing inside the folders and changes no trust; every
   * execution checks its folder again.
   */
  async refreshAvailability(): Promise<void> {
    let dirty = false;
    for (const project of this.store.list<Project>("project")) {
      const canonical = await resolveFolder(project.path);
      const availability = !canonical
        ? "missing"
        : pathKey(canonical) !== pathKey(project.realPath)
          ? "changed"
          : "available";
      if ((project.availability ?? "available") === availability) continue;
      const current = this.store.get<Project>("project", project.id);
      if (!current || current.realPath !== project.realPath) continue;
      this.store.save("project", { ...current, availability });
      dirty = true;
    }
    if (dirty) this.changed();
  }
}
