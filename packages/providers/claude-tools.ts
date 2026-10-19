import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { safeError } from "../domain/invariants";
import type { ProviderToolResult, ProviderToolset } from "./contract";

/** The MCP protocol version Topsl answers with when a client names none. */
const defaultProtocolVersion = "2025-06-18";
const maxRequestBytes = 1_000_000;

/** One tool call Claude Code made through Topsl's MCP server. */
export interface ClaudeToolRequest {
  /** The JSON-RPC id of the call, unique within this server. */
  requestId: string;
  tool: string;
  arguments: unknown;
}

/**
 * Topsl's own MCP server for one Claude Code review session. It listens on
 * 127.0.0.1 only, at a random path, and answers only requests that carry the
 * session's bearer token; both are written to an MCP configuration file that
 * only the owner can read, which Claude Code is given with `--mcp-config`.
 * It lists exactly the session's toolset and passes each call to `call`,
 * which answers it through Topsl's own tool handler (see tool-calls.ts).
 * Nothing is served once it is closed.
 */
export class ClaudeToolServer {
  private server: Server | null = null;
  private directory: string | null = null;
  private token = randomBytes(32).toString("hex");
  private route = `/mcp/${randomBytes(12).toString("hex")}`;
  private sequence = 0;
  private closed = false;
  /** Path of the MCP configuration file, once started. */
  configPath: string | null = null;
  constructor(
    readonly toolset: ProviderToolset,
    /** Answers a call with an MCP `tools/call` result (see `mcpToolResult`). */
    private call: (request: ClaudeToolRequest) => Promise<unknown>,
  ) {}
  /** The tool names Claude Code gives this server's tools. */
  get allowedTools(): string[] {
    return this.toolset.tools.map(
      (tool) => `mcp__${this.toolset.namespace}__${tool.name}`,
    );
  }
  async start(): Promise<string> {
    if (this.closed) throw new Error("Topsl's tool server is closed.");
    if (this.configPath) return this.configPath;
    const server = createServer((request, response) => {
      void this.handle(request).then(
        ({ status, body }) => {
          response.writeHead(
            status,
            body === null ? {} : { "content-type": "application/json" },
          );
          response.end(body === null ? undefined : JSON.stringify(body));
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Topsl's tool server has no local port.");
    this.directory = await mkdtemp(path.join(os.tmpdir(), "topsl-claude-mcp-"));
    const file = path.join(this.directory, "mcp.json");
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          [this.toolset.namespace]: {
            type: "http",
            url: `http://127.0.0.1:${address.port}${this.route}`,
            headers: { Authorization: `Bearer ${this.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    this.configPath = file;
    return file;
  }
  async close(): Promise<void> {
    this.closed = true;
    const server = this.server,
      directory = this.directory;
    this.server = null;
    this.directory = null;
    this.configPath = null;
    if (server)
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? "",
      expected = Buffer.from(`Bearer ${this.token}`),
      given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  private async handle(
    request: IncomingMessage,
  ): Promise<{ status: number; body: unknown }> {
    if (this.closed) return { status: 503, body: null };
    if (request.url !== this.route || !this.authorized(request))
      return { status: 404, body: null };
    // Topsl offers no server-sent stream; each POST gets one JSON answer.
    if (request.method !== "POST") return { status: 405, body: null };
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > maxRequestBytes) return { status: 413, body: null };
    }
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return {
        status: 400,
        body: rpcError(null, -32700, "Topsl could not parse this request."),
      };
    }
    if (Array.isArray(message))
      return {
        status: 400,
        body: rpcError(null, -32600, "Topsl does not accept batches."),
      };
    // A notification or a response to nothing Topsl asked needs no answer.
    if (!message || typeof message !== "object" || message.id === undefined)
      return { status: 202, body: null };
    const id = message.id;
    switch (message.method) {
      case "initialize":
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion:
                typeof message.params?.protocolVersion === "string"
                  ? message.params.protocolVersion
                  : defaultProtocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "topsl", version: "1" },
              instructions: this.toolset.description,
            },
          },
        };
      case "ping":
        return { status: 200, body: { jsonrpc: "2.0", id, result: {} } };
      case "tools/list":
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id,
            result: {
              tools: this.toolset.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          },
        };
      case "tools/call": {
        const name = message.params?.name;
        if (typeof name !== "string")
          return {
            status: 200,
            body: rpcError(id, -32602, "A tool call must name its tool."),
          };
        let result: unknown;
        try {
          result = await this.call({
            requestId: `mcp-${++this.sequence}`,
            tool: name,
            arguments: message.params?.arguments ?? {},
          });
        } catch (error) {
          result = mcpToolResult({ text: safeError(error), success: false });
        }
        return { status: 200, body: { jsonrpc: "2.0", id, result } };
      }
      default:
        return {
          status: 200,
          body: rpcError(id, -32601, "Topsl does not offer this method."),
        };
    }
  }
}

/** A tool result as MCP's `tools/call` returns it. */
export const mcpToolResult = (result: ProviderToolResult) => ({
  content: [{ type: "text", text: result.text }],
  isError: !result.success,
});

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
