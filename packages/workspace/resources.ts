import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { hash, now, stable, uid } from "../domain/invariants";
import type { Store } from "../persistence/store";

export interface TaskResources {
  id: string;
  projectId: string;
  taskId: string;
  root: string;
  temporaryDirectory: string;
  databasePath: string;
  port: number;
  portState: "reserved" | "handed-off" | "released";
  state: "allocated" | "retained";
  createdAt: string;
}
/** A loopback socket reserves the port until explicit handoff. Handoff cannot guarantee
 * a third-party executable wins the subsequent bind; callers must fail on bind error.
 * No writable resources are placed inside a pinned review/test candidate. */
export class TaskResourceAllocator {
  private sockets = new Map<string, Server>();
  constructor(
    private store: Store,
    private directory: string,
  ) {}
  async allocate(projectId: string, taskId: string): Promise<TaskResources> {
    const task = this.store.get<{ projectId: string }>("task", taskId);
    if (!task || task.projectId !== projectId)
      throw new Error("Resource allocation requires its attributed task.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = uid(),
      root = await mkdtemp(path.join(this.directory, "task-")),
      temporaryDirectory = path.join(root, "temporary");
    await mkdir(temporaryDirectory, { mode: 0o700 });
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", () => {
        socket.off("error", reject);
        resolve();
      });
    });
    socket.unref();
    const address = socket.address();
    if (!address || typeof address === "string") {
      socket.close();
      throw new Error("Resource port allocation failed.");
    }
    const resources: TaskResources = {
      id,
      projectId,
      taskId,
      root,
      temporaryDirectory,
      databasePath: path.join(
        root,
        `${hash(stable([taskId, id])).slice(0, 20)}.sqlite`,
      ),
      port: address.port,
      portState: "reserved",
      state: "allocated",
      createdAt: now(),
    };
    this.sockets.set(id, socket);
    this.store.immutable("task-resource-allocation", resources);
    this.store.put("task-resources", resources);
    return resources;
  }
  async handoffPort(id: string): Promise<TaskResources> {
    const resources = this.require(id),
      socket = this.sockets.get(id);
    if (!socket || resources.portState !== "reserved")
      throw new Error(
        "Port reservation is missing after restart or already handed off. Allocate fresh resources.",
      );
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    this.sockets.delete(id);
    const updated = { ...resources, portState: "handed-off" as const };
    this.store.put("task-resources", updated);
    return updated;
  }
  environment(resources: TaskResources): Record<string, string> {
    return {
      TMPDIR: resources.temporaryDirectory,
      TMP: resources.temporaryDirectory,
      TEMP: resources.temporaryDirectory,
      TOPSL_TASK_TEMP: resources.temporaryDirectory,
      TOPSL_TASK_DATABASE: resources.databasePath,
      TOPSL_TASK_PORT: String(resources.port),
      TOPSL_TASK_RESOURCE_ID: resources.id,
    };
  }
  retain(id: string) {
    const resources = this.require(id);
    this.sockets.get(id)?.close();
    this.sockets.delete(id);
    this.store.put("task-resources", {
      ...resources,
      portState: "released",
      state: "retained",
    });
  }
  private require(id: string) {
    const value = this.store.get<TaskResources>("task-resources", id);
    if (!value) throw new Error("Task resources are missing.");
    return value;
  }
  close() {
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
  }
}
