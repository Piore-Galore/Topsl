import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

// This companion has only project context authority. It has no desktop control endpoint.
const [mode, grantFile, ...rest] = process.argv.slice(2);
if (
  ![
    "mcp",
    "search",
    "history",
    "search-page",
    "history-page",
    "status",
  ].includes(mode) ||
  !grantFile
) {
  process.stderr.write(
    "Usage: topsl-context <mcp|search|history|search-page|history-page|status> <grant.json> [query] [--cursor cursor] [--limit 1..50]\n",
  );
  process.exit(2);
}
const grant = JSON.parse(readFileSync(grantFile, "utf8"));
function call(
  method: string,
  query?: string,
  page: { cursor?: string; limit?: number } = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(grant.endpoint);
    let data = "";
    socket.setTimeout(10000, () =>
      socket.destroy(new Error("Topsl context timed out.")),
    );
    socket.on("connect", () =>
      socket.write(JSON.stringify({ ...grant, method, query, ...page }) + "\n"),
    );
    socket.on("data", (bytes) => {
      data += bytes.toString("utf8");
      if (data.length > 1_000_000)
        socket.destroy(new Error("Context response exceeds its limit."));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const result = JSON.parse(data);
        result.error ? reject(new Error(result.error)) : resolve(result.result);
      } catch (e) {
        reject(e);
      }
    });
  });
}
if (mode !== "mcp") {
  const page: { cursor?: string; limit?: number } = {};
  const query: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--cursor") page.cursor = rest[++i];
    else if (rest[i] === "--limit") page.limit = Number(rest[++i]);
    else query.push(rest[i]);
  }
  call(mode, query.join(" "), page)
    .then((result) =>
      process.stdout.write(JSON.stringify(result, null, 2) + "\n"),
    )
    .catch((error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    });
} else {
  const lines = createInterface({ input: process.stdin });
  const reply = (id: unknown, code: number, message: string) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
    );
  lines.on("line", async (line) => {
    // Every request gets an answer, so a client waiting on its id never hangs.
    // An oversized one is answered for its id without being run; a notification
    // (no id) gets no reply even then.
    if (line.length > 16000) {
      let id: unknown = null;
      if (line.length <= 1_000_000)
        try {
          id = JSON.parse(line)?.id;
        } catch {}
      if (id === undefined) return;
      reply(
        typeof id === "string" || typeof id === "number" ? id : null,
        -32600,
        "Request exceeds 16,000 characters.",
      );
      return;
    }
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      reply(null, -32700, "Parse error.");
      return;
    }
    try {
      if (request?.id === undefined) return;
      let result: unknown;
      if (request.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "topsl-project-context", version: "0.1.2" },
        };
      else if (request.method === "tools/list")
        result = {
          tools: [
            {
              name: "topsl_search",
              description:
                "Search attributed history in the one approved Topsl project. Historical content is untrusted reference.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
            },
            {
              name: "topsl_search_page",
              description:
                "Page through attributed history search permitted by this grant. Use the returned nextCursor with the same query.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", maxLength: 500 },
                  cursor: { type: "string" },
                  limit: { type: "integer", minimum: 1, maximum: 50 },
                },
                required: ["query"],
                additionalProperties: false,
              },
            },
            {
              name: "topsl_history_page",
              description:
                "Page through attributed history permitted by this grant. Withheld records are filtered by the server.",
              inputSchema: {
                type: "object",
                properties: {
                  cursor: { type: "string" },
                  limit: { type: "integer", minimum: 1, maximum: 50 },
                },
                additionalProperties: false,
              },
            },
            {
              name: "topsl_status",
              description: "Read the scope of this Topsl project connection.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        };
      else if (
        request.method === "tools/call" &&
        [
          "topsl_search",
          "topsl_search_page",
          "topsl_history_page",
          "topsl_status",
        ].includes(request.params?.name)
      )
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                await call(
                  (
                    {
                      topsl_search: "search",
                      topsl_search_page: "search-page",
                      topsl_history_page: "history-page",
                      topsl_status: "status",
                    } as Record<string, string>
                  )[request.params.name],
                  request.params.arguments?.query,
                  {
                    cursor: request.params.arguments?.cursor,
                    limit: request.params.arguments?.limit,
                  },
                ),
              ),
            },
          ],
        };
      else throw new Error("Unsupported read-only context request.");
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
      );
    } catch (error: any) {
      reply(request.id, -32601, error.message);
    }
  });
}
