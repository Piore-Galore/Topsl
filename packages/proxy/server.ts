import http from "node:http";
import type { AddressInfo } from "node:net";
import { safeEqual } from "../domain/invariants";
import type { ClientProtocol } from "./canonical";
import { MAX_REQUEST_BYTES, type ProxyService } from "./service";

/**
 * The proxy's loopback HTTP interface (docs/Native_Harness_Plan.md §2):
 * `GET /v1/models`, `POST /v1/responses`, `POST /v1/messages` and
 * `POST /v1/chat/completions` on 127.0.0.1 only, behind the application's
 * local access token. Browsers are refused (an Origin header or a foreign
 * Host), so a web page cannot use the token-less parts of the interface or
 * rebind a hostname to it. Account management is not served over HTTP.
 */

const routes: Record<string, ClientProtocol> = {
  "/v1/responses": "responses",
  "/v1/messages": "messages",
  "/v1/chat/completions": "chat",
};

export interface ProxyServer {
  port: number;
  close(): Promise<void>;
}

function send(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function presentedToken(request: http.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer "))
    return authorization.slice(7).trim();
  const key = request.headers["x-api-key"];
  return typeof key === "string" ? key.trim() : null;
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startProxyServer(
  service: ProxyService,
  options: { port?: number } = {},
): Promise<ProxyServer> {
  let port = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const host = request.headers.host ?? "";
    if (
      request.headers.origin ||
      (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    )
      return send(response, 403, { error: { message: "Local clients only." } });
    const token = presentedToken(request);
    if (!token || !safeEqual(token, service.accessToken))
      return send(response, 401, {
        error: { message: "Missing or invalid local access token." },
      });
    if (request.method === "GET" && url.pathname === "/v1/models")
      return send(
        response,
        200,
        service.modelList(!!request.headers["anthropic-version"]),
      );
    const protocol = routes[url.pathname];
    if (!protocol || request.method !== "POST")
      return send(response, 404, { error: { message: "Not found." } });
    let body: unknown;
    try {
      body = JSON.parse((await readBody(request)).toString("utf8"));
    } catch (error) {
      return send(
        response,
        (error as Error)?.message === "too-large" ? 413 : 400,
        {
          error: {
            message: "The request body is not valid JSON or is too large.",
          },
        },
      );
    }
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers))
      headers[name] = Array.isArray(value) ? value[0] : value;
    let result;
    try {
      result = await service.infer({
        protocol,
        body,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      return send(response, 500, {
        error: { message: "The proxy failed to handle the request." },
      });
    }
    if (result.kind === "json")
      return send(response, result.status, result.body);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    try {
      for await (const chunk of result.chunks) {
        if (controller.signal.aborted) break;
        if (!response.write(chunk))
          await new Promise<void>((resolve) => response.once("drain", resolve));
      }
    } catch {
      // The stream already carries its terminal error event, or the client left.
    } finally {
      await result.chunks.return?.(undefined);
      response.end();
    }
  });
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
