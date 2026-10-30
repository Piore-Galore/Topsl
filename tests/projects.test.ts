import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import {
  ProjectCatalog,
  orderProjects,
  requireProjectFolder,
} from "../packages/workspace/projects";
import type { Project } from "../packages/domain/types";
import { fixture } from "./helpers";
import { Service } from "../apps/service/service";
import { commandSchema } from "../packages/domain/commands";

/** The local project catalog (docs/UX_Cleanup_Plan.md §2). */
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const services: Service[] = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  const catalog = new ProjectCatalog(f.store, () => {});
  const folder = path.join(f.directory, "shared folder");
  await mkdir(folder);
  return { ...f, catalog, folder };
}
async function folder(f: { directory: string }, name: string) {
  const directory = path.join(f.directory, name);
  await mkdir(directory);
  return directory;
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

describe("local project catalog", () => {
  test("one folder is one project, through symlinks too, and a new project goes first", async () => {
    const f = await setup();
    const alias = path.join(f.directory, "alias");
    await symlink(
      f.folder,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const first = await f.catalog.add(f.folder);
    const again = await f.catalog.add(alias);
    expect(again.id).toBe(first.id);
    expect(f.store.list("project")).toHaveLength(1);
    const second = await f.catalog.add(await folder(f, "second"));
    expect(f.catalog.list().map((p) => p.id)).toEqual([second.id, first.id]);
    await expect(f.catalog.add("relative/folder")).rejects.toThrow(
      "local project directory",
    );
    await expect(
      f.catalog.add(path.join(f.directory, "missing")),
    ).rejects.toThrow("existing project directory");
  });
  test("renaming changes only Topsl's name and refuses a stale name", async () => {
    const f = await setup();
    const project = await f.catalog.add(f.folder);
    const renamed = f.catalog.rename(project.id, project.name, "  Atlas  ");
    expect(renamed).toMatchObject({
      name: "Atlas",
      realPath: project.realPath,
    });
    expect(() => f.catalog.rename(project.id, project.name, "Other")).toThrow(
      "renamed meanwhile",
    );
    expect(() =>
      f.catalog.rename(project.id, "Atlas", "bad\u0007name"),
    ).toThrow("1 to 200 characters");
    expect(() => f.catalog.rename(project.id, "Atlas", "   ")).toThrow();
    expect(f.store.get<Project>("project", project.id)?.name).toBe("Atlas");
  });
  test("moving keeps an order that survives a new catalog and refuses a stale order", async () => {
    const f = await setup();
    const a = await f.catalog.add(f.folder);
    const b = await f.catalog.add(await folder(f, "b"));
    const c = await f.catalog.add(await folder(f, "c"));
    expect(f.catalog.list().map((p) => p.id)).toEqual([c.id, b.id, a.id]);
    const revision = f.catalog.orderRevision();
    f.catalog.move(a.id, "up", revision);
    expect(f.catalog.list().map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    expect(() => f.catalog.move(c.id, "down", revision)).toThrow(
      "order changed meanwhile",
    );
    // The first project cannot move further up; the order is unchanged.
    f.catalog.move(c.id, "up", f.catalog.orderRevision());
    const reopened = new ProjectCatalog(f.store, () => {});
    expect(reopened.list().map((p) => p.id)).toEqual([c.id, a.id, b.id]);
  });
  test("projects missing from the saved order follow it, newest first", () => {
    const project = (id: string) =>
      ({ id, name: id, path: id, realPath: id, trusted: true }) as Project;
    expect(
      orderProjects(
        [project("new"), project("x"), project("y")],
        ["y", "x"],
      ).map((p) => p.id),
    ).toEqual(["y", "x", "new"]);
  });
  test("a moved folder shows as missing and keeps its identity and history when relinked", async () => {
    const f = await setup();
    const project = await f.catalog.add(f.folder);
    f.store.put("conversation", { id: "retained", projectId: project.id });
    const moved = path.join(f.directory, "moved");
    await rename(f.folder, moved);
    await f.catalog.refreshAvailability();
    expect(f.store.get<Project>("project", project.id)?.availability).toBe(
      "missing",
    );
    await expect(requireProjectFolder(project)).rejects.toThrow("unavailable");
    expect(await f.catalog.relink(project.id, moved)).toMatchObject({
      id: project.id,
      path: moved,
      trusted: true,
      availability: "available",
    });
    expect(f.store.get("conversation", "retained")).toBeTruthy();
  });
  test("a retargeted link is shown as changed, blocks execution and cannot merge two histories", async () => {
    const f = await setup();
    const alias = path.join(f.directory, "alias");
    await symlink(
      f.folder,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const p = await f.catalog.add(alias);
    const second = await folder(f, "second");
    const other = await f.catalog.add(second);
    await rm(alias);
    await symlink(
      second,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await f.catalog.refreshAvailability();
    expect(f.store.get<Project>("project", p.id)).toMatchObject({
      availability: "changed",
      realPath: f.folder,
    });
    await expect(
      requireProjectFolder(f.store.get<Project>("project", p.id)!),
    ).rejects.toThrow("path changed");
    await expect(f.catalog.trust(p.id, alias)).rejects.toThrow("path changed");
    await expect(f.catalog.relink(p.id, second)).rejects.toThrow(
      "another project",
    );
    expect(f.store.get<Project>("project", other.id)?.trusted).toBe(true);
  });
});

describe("project commands", () => {
  test("renderer cannot grant trust or substitute a project path", () => {
    expect(
      commandSchema.parse({
        type: "project-trust",
        id: "p",
        approved: true,
        selectedPath: "/tmp/other",
      }),
    ).toEqual({ type: "project-trust", id: "p" });
    expect(
      commandSchema.parse({
        type: "project-open",
        projectId: "p",
        installationId: "i",
        args: ["--unsafe"],
        path: "/tmp/other",
      }),
    ).toEqual({
      type: "project-open",
      projectId: "p",
      installationId: "i",
      permissionMode: "provider-default",
    });
    // A permission mode is one of Topsl's own ids, never an argument.
    expect(() =>
      commandSchema.parse({
        type: "project-open",
        projectId: "p",
        installationId: "i",
        permissionMode: "--permission-mode=bypassPermissions",
      }),
    ).toThrow();
  });
  test.each([
    { type: "project-sync-enable", enabled: true },
    { type: "project-sync-refresh" },
    { type: "codex-project-sync-enable", installationId: "i" },
    { type: "codex-project-rename", id: "p", expectedRevision: "r", name: "x" },
    {
      type: "sync-field-push",
      requestId: "r",
      projectId: "p",
      id: "f",
      expectedRevision: 1,
    },
    {
      type: "native-history-approve",
      requestId: "r",
      projectId: "p",
      provider: "codex",
      profileId: "x",
      sessionId: "s",
    },
    { type: "open-application", id: "i" },
    { type: "history-import", projectId: "p", provider: "codex" },
  ])("the retired command $type is not accepted", (command) =>
    expect(commandSchema.safeParse(command).success).toBe(false),
  );
  test("service requires broker consent, blocks untrusted projects and active relinking, and renames and moves locally", async () => {
    const f = await setup();
    const service = new Service(
      path.join(f.directory, "service"),
      f.key,
      () => {},
      true,
    );
    services.push(service);
    const project = {
      id: "p",
      path: f.folder,
      realPath: f.folder,
      name: "p",
      trusted: false,
      createdAt: new Date().toISOString(),
    };
    service.store.put("project", project);
    await expect(service.command({ type: "project-add" })).rejects.toThrow(
      "native folder selection",
    );
    await expect(
      service.command({ type: "project-trust", id: "p" }),
    ).rejects.toThrow("confirmation");
    await expect(
      service.command({
        type: "conversation-add",
        projectId: "p",
        title: "unsafe",
      }),
    ).rejects.toThrow("Trust");
    await service.command(
      { type: "project-trust", id: "p" },
      { approved: true, selectedPath: f.folder },
    );
    expect(
      await service.command({
        type: "conversation-add",
        projectId: "p",
        title: "trusted",
      }),
    ).toMatchObject({ projectId: "p" });
    await service.command({
      type: "project-rename",
      id: "p",
      expectedName: "p",
      name: "Renamed",
    });
    const second = await folder(f, "second");
    const added = await service.command(
      { type: "project-add" },
      { approved: true, selectedPath: second },
    );
    expect(service.state().projects.map((p) => p.name)).toEqual([
      added.name,
      "Renamed",
    ]);
    await service.command({
      type: "project-move",
      id: "p",
      direction: "up",
      expectedOrderRevision: service.state().projectOrderRevision,
    });
    expect(service.state().projects.map((p) => p.id)).toEqual(["p", added.id]);
    service.store.put("run", { id: "r", projectId: "p", status: "uncertain" });
    await expect(
      service.command(
        { type: "project-relink", id: "p" },
        { approved: true, selectedPath: f.folder },
      ),
    ).rejects.toThrow("reconcile");
  });
});
