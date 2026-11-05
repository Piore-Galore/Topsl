import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { hash, stable } from "../domain/invariants";
import { spawnContained, type ContainmentPolicy } from "./sandbox";

/**
 * A minimal Model Context Protocol client for admitted local servers
 * (docs/Native_Harness_Plan.md §3, "Teams and extensions"). Each server runs
 * as a contained process with its own policy; Topsl exposes only the tools
 * whose names and schemas match the snapshot the owner admitted, under the
 * names `mcp__<server>__<tool>`.
 */

export interface McpServerDefinition {
  id: string;
  projectId: string;
  name: string;
  argv: string[];
  /** Network destinations the server may reach; empty for none. */
  networkDomains: string[];
  /** The tool list the owner admitted: name → schema hash. */
  admittedTools: Record<string, string>;
  admittedAt: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const mcpToolName = (server: string, tool: string) =>
  `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(
    0,
    64,
  );

export const schemaHash = (schema: unknown) => hash(stable(schema ?? {}));

const PROTOCOL_VERSION = "2025-06-18";

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private buffer = "";
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  stderr = "";
  get running(): boolean {
    return this.child !== null;
  }

  constructor(
    readonly definition: Pick<McpServerDefinition, "name" | "argv">,
    private policy: ContainmentPolicy,
    private cwd: string,
  ) {}

  async start(timeoutMs = 20_000): Promise<McpToolInfo[]> {
    this.child = await spawnContained(this.definition.argv, {
      cwd: this.cwd,
      policy: this.policy,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    this.child.on("exit", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new Error(
            `The MCP server ${this.definition.name} exited.${this.stderr.trim() ? ` Its last output: ${this.stderr.trim().slice(-500)}` : ""}`,
          ),
        );
      }
      this.pending.clear();
      this.child = null;
    });
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Topsl", version: "1" },
      },
      timeoutMs,
    );
    this.notify("notifications/initialized", {});
    const listed = await this.request("tools/list", {}, timeoutMs);
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return tools
      .filter((t: any) => typeof t?.name === "string")
      .map((t: any) => ({
        name: t.name,
        description:
          typeof t.description === "string" ? t.description.slice(0, 4000) : "",
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema
            : { type: "object" },
      }));
  }

  async call(
    tool: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<{ ok: boolean; output: string }> {
    const result = await this.request(
      "tools/call",
      { name: tool, arguments: args },
      timeoutMs,
    );
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((c: any) =>
        c?.type === "text" && typeof c.text === "string"
          ? c.text
          : `[${c?.type ?? "unknown"} content not shown]`,
      )
      .join("\n");
    return { ok: result?.isError !== true, output: text || "(no output)" };
  }

  close(): void {
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<any> {
    if (!this.child)
      return Promise.reject(
        new Error(`The MCP server ${this.definition.name} is not running.`),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `The MCP server ${this.definition.name} did not answer ${method} within ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.buffer = "";
      this.close();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id === "number" && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error)
          entry.reject(
            new Error(String(message.error?.message ?? "MCP error")),
          );
        else entry.resolve(message.result);
      } else if (message?.method && message?.id !== undefined) {
        // Topsl offers the server no client capabilities (sampling, roots…).
        this.child?.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported by Topsl." } })}\n`,
        );
      }
    }
  }
}

/** Which of a server's listed tools match the owner's admitted snapshot. */
export function admittedMcpTools(
  definition: McpServerDefinition,
  listed: McpToolInfo[],
): { admitted: McpToolInfo[]; changed: string[]; added: string[] } {
  const admitted: McpToolInfo[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  for (const tool of listed) {
    const expected = definition.admittedTools[tool.name];
    if (!expected) added.push(tool.name);
    else if (expected !== schemaHash(tool.inputSchema)) changed.push(tool.name);
    else admitted.push(tool);
  }
  return { admitted, changed, added };
}
