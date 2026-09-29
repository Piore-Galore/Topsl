import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers";
import {
  CodexProjectSync,
  orderLocalProjects,
  type ProjectPeer,
} from "../packages/workspace/codex-projects";
import {
  ProjectSync,
  projectSourcePaths,
} from "../packages/workspace/projects";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import type { Project } from "../packages/domain/types";
import { Service } from "../apps/service/service";

class Registry {
  projects: any[] = [];
  keys = new Map<string, string>();
  calls: Array<{ method: string; params: any }> = [];
  pageSize = 100;
  failCreateOnce = false;
  failBeforeCreateOnce = false;
  unsupported = false;
  invalid = false;
  gate?: (method: string) => Promise<void>;
  make(projects: Array<{ id: string; name: string; roots: string[] }>) {
    this.projects = projects.map((p, i) => ({
      ...p,
      roots: p.roots.map((path) => ({ path })),
      position: i,
      metadata: { private: "DO_NOT_COPY" },
      createdAt: 1,
      updatedAt: 1,
    }));
  }
  peer(): ProjectPeer {
    return {
      notify: () => {},
      close: () => {},
      request: async (method, params: any) => {
        this.calls.push({ method, params });
        await this.gate?.(method);
        if (method === "initialize") return {};
        if (this.unsupported)
          throw new Error("Unsupported method; PRIVATE_RUNTIME_ERROR");
        if (method === "project/list") {
          if (this.invalid) return { data: [{ name: "PRIVATE_BAD_DATA" }] };
          const offset = Number(params.cursor ?? 0);
          return structuredClone({
            data: this.projects.slice(offset, offset + this.pageSize),
            nextCursor:
              offset + this.pageSize < this.projects.length
                ? String(offset + this.pageSize)
                : null,
          });
        }
        if (method === "project/read")
          return structuredClone({
            project: this.projects.find((p) => p.id === params.projectId),
          });
        if (method === "project/create") {
          if (this.failBeforeCreateOnce) {
            this.failBeforeCreateOnce = false;
            throw new Error("Disconnected before write");
          }
          let project = this.projects.find(
            (p) => p.id === this.keys.get(params.idempotencyKey),
          );
          if (!project) {
            project = {
              id: `native-${this.keys.size}`,
              name: params.name,
              roots: params.roots,
              position: this.projects.length,
              metadata: {},
              createdAt: 1,
              updatedAt: 1,
            };
            this.projects.push(project);
            this.keys.set(params.idempotencyKey, project.id);
          }
          if (this.failCreateOnce) {
            this.failCreateOnce = false;
            throw new Error("Lost reply");
          }
          return structuredClone({ project });
        }
        if (method === "project/update") {
          const project = this.projects.find((p) => p.id === params.projectId);
          project.name = params.name;
          return structuredClone({ project });
        }
        if (method === "project/move") {
          const [project] = this.projects.splice(
            this.projects.findIndex((p) => p.id === params.projectId),
            1,
          );
          const before =
            params.beforeProjectId === null
              ? this.projects.length
              : this.projects.findIndex((p) => p.id === params.beforeProjectId);
          this.projects.splice(before, 0, project);
          this.projects.forEach((p, i) => (p.position = i));
          return {};
        }
        throw new Error("Unexpected native method");
      },
    };
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(realProcess = false) {
  const f = await fixture();
  const paths = projectSourcePaths(path.join(f.directory, "native-home"), {});
  await mkdir(paths.codexHome, { recursive: true });
  const catalog = new ProjectSync(f.store, () => {}, paths);
  const native = new Registry();
  const factory = realProcess
    ? () =>
        new RpcPeer(
          process.execPath,
          [path.resolve("tests/fixtures/projects.cjs")],
          f.directory,
          {
            ...nativeEnvironment({ CODEX_HOME: paths.codexHome }),
            ELECTRON_RUN_AS_NODE: "1",
          },
        )
    : () => native.peer();
  const connections: CodexProjectSync[] = [];
  const connect = () => {
    const connection = new CodexProjectSync(
      f.store,
      catalog,
      f.directory,
      paths.codexHome,
      () => {},
      factory,
    );
    connections.push(connection);
    return connection;
  };
  const sync = connect();
  cleanups.push(async () => {
    connections.forEach((c) => c.close());
    catalog.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const folder = async (name: string) => {
    const value = path.join(f.directory, name);
    await mkdir(value);
    return value;
  };
  return { ...f, paths, catalog, native, sync, connect, folder };
}
describe("Codex native project synchronization", () => {
  test("is opt-in, publishes only trusted folders, and verifies native IDs without starting turns", async () => {
    const f = await setup();
    const trusted = await f.catalog.add(await f.folder("trusted"));
    f.store.put("project", {
      ...trusted,
      id: "untrusted",
      name: "untrusted",
      trusted: false,
      path: await f.folder("untrusted"),
      realPath: path.join(f.directory, "untrusted"),
    });
    await f.sync.refresh();
    expect(f.native.calls).toHaveLength(0);
    await f.sync.enable(f.installation.id);
    expect(f.native.projects).toHaveLength(1);
    expect(f.sync.state()).toMatchObject({ enabled: true, status: "ready" });
    expect(f.sync.state().projects[0].roots).toEqual([trusted.realPath]);
    expect(f.native.calls[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    expect(
      f.native.calls.every(
        (c) => c.method === "initialize" || c.method.startsWith("project/"),
      ),
    ).toBe(true);
    await f.sync.refresh();
    expect(
      f.native.calls.filter((c) => c.method === "project/create"),
    ).toHaveLength(1);
  });
  test("imports paginated multi-root native groups without granting trust, duplicating folders, or storing metadata", async () => {
    const f = await setup();
    const a = await f.folder("first");
    const b = await f.folder("second");
    f.native.make([
      { id: "one", name: "Grouped", roots: [a, b] },
      { id: "two", name: "Other reference", roots: [a] },
    ]);
    f.native.pageSize = 1;
    await f.sync.enable(f.installation.id);
    expect(f.sync.state().projects).toHaveLength(2);
    expect(f.sync.state().projects[0].roots).toEqual([a, b]);
    const locals = f.store.list<Project>("project");
    expect(locals).toHaveLength(2);
    expect(locals.every((p) => !p.trusted && p.name === "Grouped")).toBe(true);
    expect(locals.find((p) => p.path === a)?.sources).toHaveLength(2);
    expect(JSON.stringify(f.sync.state())).not.toContain("DO_NOT_COPY");
    expect(
      JSON.stringify(f.store.list("codex-project-observation")),
    ).not.toContain("DO_NOT_COPY");
    expect(f.native.calls.some((c) => c.method === "project/create")).toBe(
      false,
    );
  });
  test("deduplicates symlink aliases and retains manually added project identity and history", async () => {
    const f = await setup();
    const target = await f.folder("target");
    const alias = path.join(f.directory, "alias");
    await symlink(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const local = await f.catalog.add(target);
    f.store.put("conversation", { id: "history", projectId: local.id });
    f.native.make([{ id: "native", name: "Native name", roots: [alias] }]);
    await f.sync.enable(f.installation.id);
    expect(f.store.list<Project>("project")).toMatchObject([
      { id: local.id, name: "Native name", trusted: true },
    ]);
    expect(f.store.get<any>("conversation", "history").projectId).toBe(
      local.id,
    );
    expect(f.native.calls.some((c) => c.method === "project/create")).toBe(
      false,
    );
  });
  test("partial renames preserve roots and metadata and detect stale review", async () => {
    const f = await setup();
    const roots = [await f.folder("one"), await f.folder("two")];
    f.native.make([{ id: "group", name: "Group", roots }]);
    await f.sync.enable(f.installation.id);
    const before = f.sync.state().projects[0];
    await f.sync.rename(before.id, before.revision, "New group");
    expect(f.native.projects[0]).toMatchObject({
      roots: roots.map((path) => ({ path })),
      metadata: { private: "DO_NOT_COPY" },
    });
    expect(
      f.store.list<Project>("project").every((p) => p.name === "New group"),
    ).toBe(true);
    expect(
      f.native.calls.find((c) => c.method === "project/update")?.params,
    ).toEqual({ projectId: "group", name: "New group" });
    await expect(
      f.sync.rename(before.id, before.revision, "Stale"),
    ).rejects.toThrow("changed this project");
    expect(f.native.projects[0].name).toBe("New group");
  });
  test("reorders native groups and rejects stale order", async () => {
    const f = await setup();
    f.native.make([
      { id: "a", name: "A", roots: [] },
      { id: "b", name: "B", roots: [] },
      { id: "c", name: "C", roots: [] },
    ]);
    await f.sync.enable(f.installation.id);
    const revision = f.sync.state().orderRevision;
    await f.sync.move("c", "a", revision);
    expect(f.sync.state().projects.map((p) => p.id)).toEqual(["c", "a", "b"]);
    await expect(f.sync.move("a", null, revision)).rejects.toThrow(
      "order changed",
    );
    expect(
      f.native.calls.filter((c) => c.method === "project/move"),
    ).toHaveLength(1);
  });
  test("native removals never delete local history or automatically recreate entries, including after restart", async () => {
    const f = await setup();
    const local = await f.catalog.add(await f.folder("local"));
    f.store.put("conversation", { id: "history", projectId: local.id });
    await f.sync.enable(f.installation.id);
    f.native.projects = [];
    await f.sync.refresh();
    f.sync.close();
    const restarted = f.connect();
    await restarted.refresh();
    expect(restarted.state().projects).toHaveLength(0);
    expect(f.store.get<Project>("project", local.id)?.sources).toEqual([]);
    expect(f.store.list("conversation")).toHaveLength(1);
    expect(
      f.native.calls.filter((c) => c.method === "project/create"),
    ).toHaveLength(1);
  });
  test("a lost create reply is reconciled from the registry after restart without duplicates", async () => {
    const f = await setup();
    await f.catalog.add(await f.folder("local"));
    f.native.failCreateOnce = true;
    await expect(f.sync.enable(f.installation.id)).rejects.toThrow(
      "did not confirm",
    );
    expect(f.store.list<any>("codex-project-link")[0]).toMatchObject({
      nativeId: null,
    });
    f.sync.close();
    await f.connect().refresh();
    expect(f.native.projects).toHaveLength(1);
    expect(f.store.list<any>("codex-project-link")[0].nativeId).toBe(
      f.native.projects[0].id,
    );
    expect(
      f.native.calls.filter((c) => c.method === "project/create"),
    ).toHaveLength(1);
  });
  test("a pending create reuses its original key and payload even if the local name changes", async () => {
    const f = await setup();
    const local = await f.catalog.add(await f.folder("original"));
    f.native.failBeforeCreateOnce = true;
    await expect(f.sync.enable(f.installation.id)).rejects.toThrow(
      "did not confirm",
    );
    f.store.put("project", { ...local, name: "Changed while disconnected" });
    f.sync.close();
    await f.connect().refresh();
    const calls = f.native.calls.filter((c) => c.method === "project/create");
    expect(calls).toHaveLength(2);
    expect(calls[0].params).toEqual(calls[1].params);
    expect(f.native.projects).toHaveLength(1);
  });
  test("Topsl's sidebar follows native order and keeps multi-folder groups contiguous", async () => {
    const f = await setup();
    const folders = [
      await f.folder("one"),
      await f.folder("two"),
      await f.folder("three"),
    ];
    const other = await f.catalog.add(await f.folder("not-native"));
    f.store.put("project", { ...other, trusted: false });
    f.native.make([
      { id: "a", name: "A", roots: folders.slice(0, 2) },
      { id: "b", name: "B", roots: folders.slice(2) },
    ]);
    await f.sync.enable(f.installation.id);
    await f.sync.move("b", "a", f.sync.state().orderRevision);
    const ordered = orderLocalProjects(
      f.store.list<Project>("project"),
      f.sync.state().projects,
    );
    expect(ordered.map((p) => p.path)).toEqual([
      folders[2],
      folders[0],
      folders[1],
      other.path,
    ]);
  });
  test("unsupported or malformed APIs retain the last observation and do not leak native errors", async () => {
    const f = await setup();
    f.native.make([{ id: "a", name: "Kept", roots: [await f.folder("kept")] }]);
    await f.sync.enable(f.installation.id);
    f.native.unsupported = true;
    await expect(f.sync.refresh()).rejects.toThrow("experimental project API");
    expect(f.sync.state()).toMatchObject({
      status: "error",
      projects: [{ name: "Kept" }],
    });
    expect(f.sync.state().detail).not.toContain("PRIVATE_RUNTIME_ERROR");
    f.native.unsupported = false;
    f.native.invalid = true;
    await expect(f.sync.refresh()).rejects.toThrow(
      "unsupported project format",
    );
    expect(f.store.list<Project>("project")).toHaveLength(1);
    expect(f.sync.state().detail).not.toContain("PRIVATE_BAD_DATA");
  });
  test("pausing an in-flight refresh stops subsequent imports and writes", async () => {
    const f = await setup();
    await f.sync.enable(f.installation.id);
    await f.catalog.add(await f.folder("new"));
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    f.native.gate = async (method) => {
      if (method === "project/list") await waiting;
    };
    const work = f.sync.refresh();
    const assertion = expect(work).rejects.toThrow("paused");
    await vi.waitFor(() =>
      expect(
        f.native.calls.filter((c) => c.method === "project/list").length,
      ).toBe(3),
    );
    f.sync.pause();
    release();
    await assertion;
    expect(f.native.projects).toHaveLength(0);
    expect(f.sync.state().enabled).toBe(false);
  });
  test("runtime replacement and profile changes invalidate the existing connection", async () => {
    const f = await setup();
    await f.sync.enable(f.installation.id);
    await writeFile(f.installation.path, "replacement runtime");
    const count = f.native.calls.length;
    await expect(f.sync.refresh()).rejects.toThrow("runtime changed");
    expect(f.native.calls).toHaveLength(count);
    const differentHome = new CodexProjectSync(
      f.store,
      f.catalog,
      f.directory,
      path.join(f.directory, "another-home"),
      () => {},
      () => f.native.peer(),
    );
    expect(differentHome.state().enabled).toBe(false);
    await differentHome.refresh();
    differentHome.close();
    expect(f.native.calls).toHaveLength(count);
  });
  test("retargeted folder symlinks lose trust and never get exported", async () => {
    const f = await setup();
    const target = await f.folder("original");
    const replacement = await f.folder("replacement");
    const alias = path.join(f.directory, "alias");
    await symlink(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const project = await f.catalog.add(alias);
    await rm(alias);
    await symlink(
      replacement,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    f.native.make([{ id: "changed", name: "Changed", roots: [alias] }]);
    await f.sync.enable(f.installation.id);
    expect(f.store.get<Project>("project", project.id)).toMatchObject({
      trusted: false,
      realPath: target,
      availability: "changed",
    });
    expect(f.native.calls.some((c) => c.method === "project/create")).toBe(
      false,
    );
  });
  test("raw metadata discovery cannot overwrite API-managed native names", async () => {
    const f = await setup();
    const folder = await f.folder("folder");
    f.native.make([{ id: "current", name: "Current", roots: [folder] }]);
    await f.sync.enable(f.installation.id);
    await writeFile(
      path.join(f.paths.codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          legacy: { name: "Stale cache", rootPaths: [folder] },
        },
      }),
    );
    await f.catalog.enable(true);
    expect(f.store.list<Project>("project")[0].name).toBe("Current");
  });
  test("real stdio process persists project IDs, renames, and order across reconnects", async () => {
    const f = await setup(true);
    await f.catalog.add(await f.folder("first"));
    await f.catalog.add(await f.folder("second"));
    await f.sync.enable(f.installation.id);
    const [first, second] = f.sync.state().projects;
    await f.sync.rename(first.id, first.revision, "Renamed");
    await f.sync.move(second.id, first.id, f.sync.state().orderRevision);
    f.sync.close();
    const restarted = f.connect();
    await restarted.refresh();
    expect(restarted.state().projects.map((p) => [p.id, p.name])).toEqual([
      [second.id, "second"],
      [first.id, "Renamed"],
    ]);
    const requests = (
      await readFile(
        path.join(f.paths.codexHome, "topsl-project-requests.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.every(
        (r) => r.method === "initialize" || r.method.startsWith("project/"),
      ),
    ).toBe(true);
  });
  test("service requires trusted enablement and never connects an unapproved runtime", async () => {
    const f = await setup();
    const directory = await f.folder("service");
    const service = new Service(directory, f.key, () => {}, true);
    try {
      await expect(
        service.command({
          type: "codex-project-sync-enable",
          installationId: f.installation.id,
        }),
      ).rejects.toThrow("confirmation");
      await expect(service.codexProjects.enable("unknown")).rejects.toThrow(
        "trusted Codex",
      );
      await expect(
        service.command({ type: "codex-project-sync-refresh" }),
      ).rejects.toThrow("Enable");
    } finally {
      service.close();
    }
  });
});
