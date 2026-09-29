import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  ProjectSync,
  parseProjectFolders,
  projectSourcePaths,
  requireProjectFolder,
} from "../packages/workspace/projects";
import {
  desktopProjectRoute,
  claudeFolderUrl,
  isClaudeFolderUrl,
} from "../packages/workspace/project-opening";
import type { Project } from "../packages/domain/types";
import { fixture } from "./helpers";
import { Service } from "../apps/service/service";
import { commandSchema } from "../packages/domain/commands";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const synchronizers: ProjectSync[] = [];
const services: Service[] = [];
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  const home = path.join(f.directory, "native-home");
  const paths = projectSourcePaths(home, {});
  await mkdir(paths.codexHome, { recursive: true });
  const sync = new ProjectSync(f.store, () => {}, paths);
  synchronizers.push(sync);
  const folder = path.join(f.directory, "shared folder");
  await mkdir(folder);
  return {
    ...f,
    home,
    paths,
    sync,
    folder,
    desktop: path.join(paths.codexHome, ".codex-global-state.json"),
    cli: path.join(paths.codexHome, "config.toml"),
  };
}
async function saveDesktop(file: string, roots: string[]) {
  await writeFile(
    file,
    JSON.stringify({ "electron-saved-workspace-roots": roots }),
  );
}
afterEach(async () => {
  for (const sync of synchronizers.splice(0)) sync.close();
  for (const service of services.splice(0)) service.close();
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

describe("native project metadata readers", () => {
  test("projects only explicit path/name fields from each provider; all other values stay private", () => {
    const folder = path.resolve("shared-project");
    const extra = path.resolve("second-root");
    expect(
      parseProjectFolders(
        "codex-cli",
        "[projects." + JSON.stringify(folder) + "]\ntrust_level = 'trusted'\n",
      ),
    ).toEqual([{ path: folder, name: null, nativeProjectId: null }]);
    expect(
      parseProjectFolders(
        "claude",
        JSON.stringify({
          oauthAccount: { secret: "PRIVATE" },
          projects: { [folder]: { history: ["PRIVATE"], trusted: true } },
        }),
      ),
    ).toEqual([{ path: folder, name: null, nativeProjectId: null }]);
    expect(
      parseProjectFolders(
        "codex-desktop",
        JSON.stringify({
          "local-projects": {
            native: { name: "Product", rootPaths: [folder, extra] },
          },
          "thread-messages": "PRIVATE",
        }),
      ),
    ).toEqual([
      { path: folder, name: "Product", nativeProjectId: "native" },
      { path: extra, name: "Product", nativeProjectId: "native" },
    ]);
  });
  test("rejects unknown schemas and relative/remote/control-character paths without exposing data", () => {
    for (const data of [
      '{"secret":"PRIVATE',
      "[]",
      '{"local-projects":[]}',
      '{"other-schema":"PRIVATE"}',
      '{"electron-saved-workspace-roots":["../secret"]}',
      '{"electron-saved-workspace-roots":["ssh://remote/project"]}',
    ]) {
      expect(() => parseProjectFolders("codex-desktop", data)).toThrow();
      try {
        parseProjectFolders("codex-desktop", data);
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE");
      }
    }
    expect(() =>
      parseProjectFolders(
        "claude",
        JSON.stringify({ projects: { [path.resolve("a\nb")]: {} } }),
      ),
    ).toThrow("invalid");
  });
  test("honors explicit provider homes without consulting a different profile", () => {
    const home = path.resolve("test-home");
    expect(projectSourcePaths(home, {})).toEqual({
      codexHome: path.join(home, ".codex"),
      claudeConfig: path.join(home, ".claude.json"),
    });
    expect(
      projectSourcePaths(home, {
        CODEX_HOME: path.join(home, "codex-two"),
        CLAUDE_CONFIG_DIR: path.join(home, "claude-two"),
      }),
    ).toEqual({
      codexHome: path.join(home, "codex-two"),
      claudeConfig: path.join(home, "claude-two", ".claude.json"),
    });
  });
});

describe("shared local catalog reconciliation", () => {
  test("native project renames keep the same folder identity and trust; manually named projects stay unchanged", async () => {
    const f = await setup();
    const manual = path.join(f.directory, "manual-project");
    await mkdir(manual);
    const saved = await f.sync.add(manual);
    const save = (name: string) =>
      writeFile(
        f.desktop,
        JSON.stringify({
          "electron-saved-workspace-roots": [f.folder],
          "local-projects": { native: { name, rootPaths: [f.folder, manual] } },
        }),
      );
    await save("Native project");
    await f.sync.enable(true);
    const discovered = f.store
      .list<Project>("project")
      .find((p) => p.path === f.folder)!;
    expect(discovered.name).toBe("Native project");
    await f.sync.trust(discovered.id, discovered.path);
    await save("Renamed native project");
    await f.sync.refresh();
    expect(f.store.get<Project>("project", discovered.id)).toMatchObject({
      name: "Renamed native project",
      trusted: true,
    });
    expect(f.store.get<Project>("project", saved.id)?.name).toBe(
      "manual-project",
    );
    expect(f.store.list("project")).toHaveLength(2);
  });
  test("is opt-in, deduplicates all providers and symlinks, and never inherits native trust", async () => {
    const f = await setup();
    const alias = path.join(f.directory, "alias");
    await symlink(
      f.folder,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await saveDesktop(f.desktop, [f.folder]);
    await writeFile(
      f.cli,
      "[projects." + JSON.stringify(alias) + "]\ntrust_level='trusted'\n",
    );
    const native = JSON.stringify({
      projects: {
        [f.folder]: { hasTrustDialogAccepted: true, allowedTools: ["PRIVATE"] },
      },
    });
    await writeFile(f.paths.claudeConfig, native);
    await f.sync.refresh();
    expect(f.store.list("project")).toEqual([]);
    await f.sync.enable(true);
    const projects = f.store.list<Project>("project");
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      realPath: f.folder,
      trusted: false,
      availability: "available",
    });
    expect(projects[0].sources?.map((ref) => ref.sourceId).sort()).toEqual([
      "claude",
      "codex-cli",
      "codex-desktop",
    ]);
    await expect(requireProjectFolder(projects[0])).rejects.toThrow("Trust");
    expect(
      JSON.stringify(f.sync.state()) + JSON.stringify(projects),
    ).not.toContain("PRIVATE");
    expect(await readFile(f.paths.claudeConfig, "utf8")).toBe(native);
    await f.sync.refresh();
    expect(f.store.list<Project>("project").map((p) => p.id)).toEqual([
      projects[0].id,
    ]);
  });
  test("native changes and removals reconcile without deleting Topsl projects or conversations", async () => {
    const f = await setup();
    const saved = await f.sync.add(f.folder);
    f.store.put("conversation", { id: "history", projectId: saved.id });
    await saveDesktop(f.desktop, [f.folder]);
    await f.sync.enable(true);
    expect(f.store.list<Project>("project")[0]).toMatchObject({
      id: saved.id,
      trusted: true,
    });
    const second = path.join(f.directory, "second");
    await mkdir(second);
    await saveDesktop(f.desktop, [second]);
    await f.sync.refresh();
    expect(f.store.list("project")).toHaveLength(2);
    expect(f.store.get<Project>("project", saved.id)?.sources).toEqual([]);
    expect(f.store.get("conversation", "history")).toBeTruthy();
    expect(
      f.store.list<Project>("project").find((p) => p.path === second)?.trusted,
    ).toBe(false);
  });
  test("corruption, missing files, and unsupported schemas retain the last observation and recover", async () => {
    const f = await setup();
    await saveDesktop(f.desktop, [f.folder]);
    await f.sync.enable(true);
    const prior = f.store.list<Project>("project")[0];
    await writeFile(f.desktop, '{"PRIVATE":"');
    await f.sync.refresh();
    expect(f.sync.state().sources[0]).toMatchObject({
      status: "error",
      folders: 1,
    });
    expect(f.sync.state().sources[0].detail).not.toContain("PRIVATE");
    expect(f.store.get<Project>("project", prior.id)?.sources).toEqual(
      prior.sources,
    );
    await rm(f.desktop);
    await f.sync.refresh();
    expect(f.sync.state().sources[0].status).toBe("missing");
    expect(f.store.get<Project>("project", prior.id)?.sources).toEqual(
      prior.sources,
    );
    await saveDesktop(f.desktop, []);
    await f.sync.refresh();
    expect(f.sync.state().sources[0].status).toBe("ready");
    expect(f.store.get<Project>("project", prior.id)?.sources).toEqual([]);
  });
  test("pause stops ingestion and a new service instance restores the approved scope", async () => {
    const f = await setup();
    await saveDesktop(f.desktop, [f.folder]);
    await f.sync.enable(true);
    await f.sync.enable(false);
    const second = path.join(f.directory, "second");
    await mkdir(second);
    await saveDesktop(f.desktop, [second]);
    await f.sync.refresh();
    expect(f.store.list("project")).toHaveLength(1);
    const restarted = new ProjectSync(f.store, () => {}, f.paths);
    synchronizers.push(restarted);
    expect(restarted.enabled()).toBe(false);
    await restarted.enable(true);
    expect(f.store.list("project")).toHaveLength(2);
    const changedProfile = new ProjectSync(
      f.store,
      () => {},
      projectSourcePaths(path.join(f.directory, "different"), {}),
    );
    synchronizers.push(changedProfile);
    expect(changedProfile.enabled()).toBe(false);
  });
  test("simultaneous refreshes coalesce and a pause cancels their pending ingestion", async () => {
    const f = await setup();
    await f.sync.enable(true);
    await saveDesktop(f.desktop, [f.folder]);
    const first = f.sync.refresh();
    expect(f.sync.refresh()).toBe(first);
    await f.sync.enable(false);
    await first;
    expect(f.store.list("project")).toEqual([]);
    await f.sync.enable(true);
    expect(f.store.list("project")).toHaveLength(1);
  });
  test("a missing/moved folder keeps its identity and history when explicitly relinked", async () => {
    const f = await setup();
    const project = await f.sync.add(f.folder);
    f.store.put("conversation", { id: "retained", projectId: project.id });
    const moved = path.join(f.directory, "moved");
    await rename(f.folder, moved);
    await f.sync.enable(true);
    expect(f.store.get<Project>("project", project.id)?.availability).toBe(
      "missing",
    );
    await expect(requireProjectFolder(project)).rejects.toThrow("unavailable");
    expect(await f.sync.relink(project.id, moved)).toMatchObject({
      id: project.id,
      path: moved,
      trusted: true,
      availability: "available",
    });
    expect(f.store.get("conversation", "retained")).toBeTruthy();
  });
  test("a retargeted symlink revokes trust and cannot silently merge two histories", async () => {
    const f = await setup();
    const alias = path.join(f.directory, "alias");
    await symlink(
      f.folder,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const p = await f.sync.add(alias);
    const second = path.join(f.directory, "second");
    await mkdir(second);
    const other = await f.sync.add(second);
    await rm(alias);
    await symlink(
      second,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await f.sync.enable(true);
    expect(f.store.get<Project>("project", p.id)).toMatchObject({
      trusted: false,
      availability: "changed",
      realPath: f.folder,
    });
    await expect(f.sync.trust(p.id, alias)).rejects.toThrow("path changed");
    await expect(f.sync.relink(p.id, second)).rejects.toThrow(
      "another project",
    );
    expect(f.store.get<Project>("project", other.id)?.trusted).toBe(true);
  });
  test("manual adoption of a discovered folder grants trust without duplicating it", async () => {
    const f = await setup();
    await saveDesktop(f.desktop, [f.folder]);
    await f.sync.enable(true);
    const discovered = f.store.list<Project>("project")[0];
    await expect(
      f.sync.trust(discovered.id, path.join(f.directory, "other")),
    ).rejects.toThrow("changed during review");
    const saved = await f.sync.add(f.folder);
    expect(saved.id).toBe(discovered.id);
    expect(saved.trusted).toBe(true);
    expect(f.store.list("project")).toHaveLength(1);
    expect(saved.sources).toHaveLength(1);
  });
});

describe("project commands and native opening", () => {
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
    ).toEqual({ type: "project-open", projectId: "p", installationId: "i" });
  });
  test("service requires broker consent and blocks untrusted projects and active relinking", async () => {
    const f = await setup();
    const service = new Service(
      path.join(f.directory, "service"),
      f.key,
      () => {},
      true,
    );
    services.push(service);
    await expect(
      service.command({ type: "project-sync-enable", enabled: true }),
    ).rejects.toThrow("confirmation");
    await service.command(
      { type: "project-sync-enable", enabled: true },
      { approved: true },
    );
    const project = {
      id: "p",
      path: f.folder,
      realPath: f.folder,
      name: "p",
      trusted: false,
      createdAt: new Date().toISOString(),
    };
    service.store.put("project", project);
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
    service.store.put("run", { id: "r", projectId: "p", status: "uncertain" });
    await expect(
      service.command(
        { type: "project-relink", id: "p" },
        { approved: true, selectedPath: f.folder },
      ),
    ).rejects.toThrow("reconcile");
  });
  test("desktop routes preserve the selected folder and expose native selection limits", async () => {
    const f = await setup();
    const project = await f.sync.add(f.folder);
    const installation = {
      ...f.installation,
      appId: "openai.desktop" as const,
    };
    expect(
      await desktopProjectRoute(installation, project, "darwin"),
    ).toMatchObject({
      route: "folder-open",
      projectPath: f.folder,
      applicationPath: installation.realPath,
    });
    expect(
      await desktopProjectRoute(installation, project, "win32"),
    ).toMatchObject({ route: "native-selection", projectPath: f.folder });
    expect(
      await desktopProjectRoute(
        { ...installation, appId: "anthropic.claude-desktop" },
        project,
        "darwin",
      ),
    ).toMatchObject({
      route: "claude-folder-link",
      projectPath: f.folder,
      nativeUrl: claudeFolderUrl(f.folder),
    });
    await expect(
      desktopProjectRoute({ ...installation, trusted: false }, project),
    ).rejects.toThrow("trust this application");
    await expect(
      desktopProjectRoute(installation, { ...project, trusted: false }),
    ).rejects.toThrow("Trust this project");
    await writeFile(installation.path, "externally replaced");
    await expect(desktopProjectRoute(installation, project)).rejects.toThrow(
      "application changed",
    );
  });
  test("Claude links encode one exact folder without introducing prompts or routes", () => {
    const folder = path.resolve(
      "项目 & #q=ignored?folder=elsewhere%20 with spaces",
    );
    const link = claudeFolderUrl(folder);
    const url = new URL(link);
    expect(url.protocol).toBe("claude:");
    expect(url.hostname).toBe("code");
    expect(url.pathname).toBe("/new");
    expect([...url.searchParams]).toEqual([["folder", folder]]);
    expect(url.hash).toBe("");
    expect(isClaudeFolderUrl(link, folder)).toBe(true);
    for (const wrong of [
      link + "&q=run",
      link + "&folder=other",
      link.replace("code/new", "cowork/new"),
      link.replace("claude:", "https:"),
      link + "#fragment",
    ])
      expect(isClaudeFolderUrl(wrong, folder)).toBe(false);
    expect(isClaudeFolderUrl(link, folder + "-changed")).toBe(false);
  });
});
