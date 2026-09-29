import { test, expect } from "vitest";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { fixture } from "./helpers";
import { identity, nativeEnvironment } from "../packages/platform/system";
import {
  ProjectSync,
  projectSourcePaths,
} from "../packages/workspace/projects";
import { CodexProjectSync } from "../packages/workspace/codex-projects";
import { RpcPeer } from "../packages/runtime/rpc";

// Optional acceptance probe of an explicitly selected local executable. Both
// provider homes are empty fixtures; no real native projects or model turns.
const executable = process.env.TOPSL_NATIVE_PROJECT_BINARY;
test.skipIf(!executable)(
  "selected native Codex supports project synchronization across independent connections",
  async () => {
    if (!executable || !path.isAbsolute(executable))
      throw new Error("Choose an absolute native executable path.");
    const f = await fixture();
    const paths = projectSourcePaths(path.join(f.directory, "native-home"), {});
    await mkdir(paths.codexHome, { recursive: true });
    const fingerprint = await identity(executable);
    const installation = {
      ...f.installation,
      path: executable,
      ...fingerprint,
    };
    f.store.put("installation", installation);
    const peers: RpcPeer[] = [];
    const factory = () => {
      const peer = new RpcPeer(
        installation.realPath,
        ["app-server"],
        f.directory,
        nativeEnvironment({
          CODEX_HOME: paths.codexHome,
          HOME: path.dirname(paths.codexHome),
          USERPROFILE: path.dirname(paths.codexHome),
        }),
      );
      peers.push(peer);
      return peer;
    };
    const catalog = new ProjectSync(f.store, () => {}, paths);
    const sync = new CodexProjectSync(
      f.store,
      catalog,
      f.directory,
      paths.codexHome,
      () => {},
      factory,
    );
    try {
      for (const name of ["First fixture", "第二个 & # folder"]) {
        const folder = path.join(f.directory, name);
        await mkdir(folder);
        await catalog.add(folder);
      }
      await sync.enable(installation.id);
      const [first, second] = sync.state().projects;
      expect(sync.state().projects).toHaveLength(2);
      await sync.rename(first.id, first.revision, "Renamed fixture");
      await sync.move(second.id, first.id, sync.state().orderRevision);
      const observer = factory();
      await observer.request("initialize", {
        clientInfo: { name: "topsl-project-observer", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      observer.notify("initialized");
      const native = await observer.request("project/list", {
        sortKey: "position",
        sortDirection: "asc",
      });
      expect(native.data.map((p: any) => p.id)).toEqual([second.id, first.id]);
      expect(native.data[1].name).toBe("Renamed fixture");
      await observer.request("project/delete", { projectId: second.id });
      await sync.refresh();
      expect(sync.state().projects.map((p) => p.id)).toEqual([first.id]);
      expect(f.store.list("project")).toHaveLength(2);
      expect(f.store.list("run")).toHaveLength(0);
      console.log(
        "Native acceptance: create, readback, rename, order, independent connection, deletion retention; isolated homes; zero model turns.",
      );
    } finally {
      sync.close();
      catalog.close();
      peers.forEach((p) => p.close());
      await Promise.all(
        peers.map((p) =>
          p.process.exitCode !== null || p.process.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolve) =>
                p.process.once("exit", () => resolve()),
              ),
        ),
      );
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
  60_000,
);
