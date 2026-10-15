import { createServer, type Server } from "node:net";
import path from "node:path";
import { chmod, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Store, type MessageVisibility } from "../persistence/store";
import { hash, safeEqual } from "../domain/invariants";
import type { Message, Project } from "../domain/types";
import {
  candidateRequest,
  validateCandidateAccess,
  type CandidateAccess,
} from "../context/candidate-reader";

export interface ContextScope {
  projectId: string;
  candidates?: CandidateAccess[];
  candidateVisibility?: "task-inputs" | "independent";
  grantId?: string;
  visibility?: MessageVisibility;
  subject?: {
    agentSessionId?: string;
    attemptId?: string;
    workflowId?: string;
    taskId?: string;
  };
}
export interface ContextGrantOptions {
  ttlMs?: number;
  visibility?: MessageVisibility;
  subject?: ContextScope["subject"];
  candidates?: CandidateAccess[];
  candidateVisibility?: ContextScope["candidateVisibility"];
}
export interface ContextGrant {
  endpoint: string;
  grant: string;
  token: string;
  expiresAt: string;
}

export function contextRequest(
  store: Store,
  scope: string | ContextScope,
  request: any,
): unknown {
  const { projectId, visibility, subject } =
    typeof scope === "string" ? { projectId: scope } : scope;
  if (!request || typeof request !== "object")
    throw new Error("Invalid context request.");
  if (
    typeof request.method === "string" &&
    request.method.startsWith("candidate-")
  )
    return candidateRequest(
      store,
      typeof scope === "string" ? { projectId: scope } : scope,
      request,
    );
  if (request.method === "status")
    return {
      projectId,
      subject: subject ?? null,
      restrictedHistory: visibility !== undefined,
      readOnly: true,
      administrativeAuthority: false,
      filesystemIsolation: "not-enforced-by-context-service",
    };
  if (
    ["search", "search-page"].includes(request.method) &&
    typeof request.query === "string" &&
    request.query.length <= 500
  ) {
    const page = store.searchPage(projectId, request.query, {
      visibility,
      cursor: request.cursor,
      limit: contextLimit(request.limit),
    });
    const items = page.items.map(contextMessage);
    return request.method === "search" ? items : { ...page, items };
  }
  if (["history", "history-page"].includes(request.method)) {
    const page = store.messagesPage({
      projectId,
      visibility,
      cursor: request.cursor,
      limit: contextLimit(request.limit),
    });
    const items = page.items.map(contextMessage);
    return request.method === "history" ? items : { ...page, items };
  }
  throw new Error(
    "This project context connection cannot execute commands, grant approvals, or manage applications.",
  );
}
function contextLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 50
  )
    throw new Error("Context page size must be an integer between 1 and 50.");
  return value as number;
}
function contextMessage(m: Message) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    runId: m.runId,
    role: m.role,
    provider: m.provider,
    text: m.text.slice(0, 2000),
    truncated: m.text.length > 2000,
    createdAt: m.createdAt,
    source: (
      m as Message & { source?: import("../domain/sync").NativeMessageSource }
    ).source ?? {
      sourceId: m.id,
      sourceRevision: hash(JSON.stringify(m)),
      contentHash: hash(m.text),
      parserVersion: null,
      nativeOrder: null,
      byteStart: null,
      byteEnd: null,
    },
    omissions:
      m.text.length > 2000
        ? [
            {
              source: m.id,
              reason:
                "Result excerpt exceeds the 2,000-character retrieval budget; the full durable message is retained.",
            },
          ]
        : [],
  };
}
export class ContextServer {
  private server: Server | null = null;
  private grants = new Map<
    string,
    { token: string; scope: ContextScope; expiresAt: number }
  >();
  private sockets = new Set<import("node:net").Socket>();
  readonly endpoint: string;
  constructor(
    private store: Store,
    directory: string,
    private clock: () => number = Date.now,
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
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      let buffer = "";
      let handled = false;
      socket.setTimeout(10000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", (bytes) => {
        if (handled) return;
        buffer += bytes.toString("utf8");
        if (buffer.length > 16000) {
          socket.destroy();
          return;
        }
        if (!buffer.includes("\n")) return;
        handled = true;
        try {
          const request = JSON.parse(buffer.split("\n")[0]);
          const grant = this.grants.get(request.grant);
          if (
            !grant ||
            this.clock() >= grant.expiresAt ||
            typeof request.token !== "string" ||
            !safeEqual(request.token, grant.token)
          )
            throw new Error("Invalid project context grant.");
          socket.end(
            JSON.stringify({
              result: contextRequest(this.store, grant.scope, request),
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
  grant(project: Project, options: ContextGrantOptions = {}): ContextGrant {
    if (!project.trusted)
      throw new Error("Context sharing requires a trusted project.");
    const ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000;
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 24 * 60 * 60 * 1000
    )
      throw new Error(
        "Context grant duration must be positive and at most 24 hours.",
      );
    // Validate and copy the policy now; later caller mutation cannot widen it.
    const visibility =
      options.visibility === undefined
        ? undefined
        : structuredClone(options.visibility);
    if (visibility !== undefined)
      this.store.messagesPage({ projectId: project.id, visibility, limit: 1 });
    const candidates =
      options.candidates === undefined
        ? undefined
        : structuredClone(options.candidates);
    if (candidates !== undefined)
      validateCandidateAccess(this.store, {
        projectId: project.id,
        subject: options.subject,
        candidates,
        candidateVisibility: options.candidateVisibility,
      });
    for (const [id, entry] of this.grants)
      if (entry.expiresAt <= this.clock()) this.grants.delete(id);
    const grant = randomBytes(24).toString("hex");
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.clock() + ttlMs;
    this.grants.set(grant, {
      scope: {
        projectId: project.id,
        candidates,
        candidateVisibility: options.candidateVisibility,
        grantId: grant,
        visibility,
        subject: options.subject ? structuredClone(options.subject) : undefined,
      },
      token,
      expiresAt,
    });
    return {
      endpoint: this.endpoint,
      grant,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  revoke(grant: string): boolean {
    return this.grants.delete(grant);
  }
  revokeProject(projectId: string): number {
    return this.revokeWhere((scope) => scope.projectId === projectId);
  }
  revokeAttempt(attemptId: string): number {
    return this.revokeWhere((scope) => scope.subject?.attemptId === attemptId);
  }
  private revokeWhere(predicate: (scope: ContextScope) => boolean): number {
    let count = 0;
    for (const [id, grant] of this.grants)
      if (predicate(grant.scope) && this.grants.delete(id)) count++;
    return count;
  }
  close(): void {
    this.grants.clear();
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
  }
}
