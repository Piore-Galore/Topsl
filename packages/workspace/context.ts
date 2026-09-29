import { createServer, type Server } from "node:net";
import path from "node:path";
import { chmod, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Store } from "../persistence/store";
import { hash, safeEqual } from "../domain/invariants";
import type { Message, Project } from "../domain/types";

export function contextRequest(
  store: Store,
  projectId: string,
  request: any,
): unknown {
  if (request.method === "status")
    return { projectId, readOnly: true, administrativeAuthority: false };
  if (
    request.method === "search" &&
    typeof request.query === "string" &&
    request.query.length <= 500
  )
    return store
      .search(projectId, request.query)
      .map((m) => ({
        role: m.role,
        provider: m.provider,
        text: m.text,
        createdAt: m.createdAt,
      }));
  if (request.method === "history")
    return store
      .list<Message>("message")
      .filter((m) => m.projectId === projectId)
      .slice(0, 50)
      .map((m) => ({
        role: m.role,
        provider: m.provider,
        text: m.text.slice(0, 10000),
        createdAt: m.createdAt,
      }));
  throw new Error(
    "This project context connection cannot execute commands, grant approvals, or manage applications.",
  );
}
export class ContextServer {
  private server: Server | null = null;
  private grants = new Map<string, { token: string; projectId: string }>();
  readonly endpoint: string;
  constructor(
    private store: Store,
    directory: string,
  ) {
    this.endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\topsl-${hash(directory).slice(0, 16)}`
        : path.join(directory, "context.sock");
  }
  async start(): Promise<void> {
    if (process.platform !== "win32") {
      await mkdir(path.dirname(this.endpoint), {
        recursive: true,
        mode: 0o700,
      });
      await rm(this.endpoint, { force: true });
    }
    this.server = createServer((socket) => {
      let buffer = "";
      socket.setTimeout(10000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", (bytes) => {
        buffer += bytes.toString("utf8");
        if (buffer.length > 16000) {
          socket.destroy();
          return;
        }
        if (!buffer.includes("\n")) return;
        try {
          const request = JSON.parse(buffer.split("\n")[0]);
          const grant = this.grants.get(request.grant);
          if (
            !grant ||
            typeof request.token !== "string" ||
            !safeEqual(request.token, grant.token)
          )
            throw new Error("Invalid project context grant.");
          socket.end(
            JSON.stringify({
              result: contextRequest(this.store, grant.projectId, request),
            }) + "\n",
          );
        } catch (e: any) {
          socket.end(JSON.stringify({ error: e.message }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.endpoint, resolve);
    });
    if (process.platform !== "win32") await chmod(this.endpoint, 0o600);
  }
  grant(project: Project): { endpoint: string; grant: string; token: string } {
    const grant = hash(project.id);
    const token = randomBytes(32).toString("hex");
    this.grants.set(grant, { projectId: project.id, token });
    return { endpoint: this.endpoint, grant, token };
  }
  close(): void {
    this.grants.clear();
    this.server?.close();
  }
}
