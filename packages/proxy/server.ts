import { once } from "node:events";
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

/**
 * The request body, or null once it passes the limit. Buffering stops there
 * without closing the request: leaving a `for await` early would destroy it
 * and reset the connection before the caller could answer.
 */
function readBody(request: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BYTES) return void chunks.push(chunk);
      done();
      resolve(null);
    };
    const onEnd = () => {
      done();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => {
      done();
      reject(error);
    };
    const done = () => {
      request.off("data", onData).off("end", onEnd).off("error", onError);
      request.off("close", onClose);
    };
    const onClose = () => onError(new Error("The request was closed."));
    request.on("data", onData).on("end", onEnd).on("error", onError);
    request.on("close", onClose);
  });
}

export async function startProxyServer(
  service: ProxyService,
  options: { port?: number } = {},
): Promise<ProxyServer> {
  let port = 0;
  const handle = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
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
    // A target such as "//" is not a URL; without this it would throw.
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return send(response, 400, {
        error: { message: "The request target is not valid." },
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/models")
      return send(
        response,
        200,
        service.modelList(!!request.headers["anthropic-version"]),
      );
    const protocol = routes[url.pathname];
    if (!protocol || request.method !== "POST")
      return send(response, 404, { error: { message: "Not found." } });
    // Refused before the body is read: stopping in the middle of an upload
    // resets the connection, and the client would never see this answer.
    if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) {
      response.setHeader("connection", "close");
      return send(response, 413, {
        error: { message: "The request body is too large." },
      });
    }
    let body: unknown;
    try {
      const bytes = await readBody(request);
      if (!bytes) {
        // A body with no declared length that passed the limit. The rest of
        // it is discarded, not kept. The whole answer is written at once, but
        // the connection is closed only when the client stops sending or a
        // short grace period ends: closing while the upload is still arriving
        // resets the connection, and the client would lose the answer.
        request.resume();
        const text = JSON.stringify({
          error: { message: "The request body is too large." },
        });
        response.writeHead(413, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
          "cache-control": "no-store",
          connection: "close",
        });
        response.write(text);
        const finish = () => {
          clearTimeout(grace);
          response.end(() => request.destroy());
        };
        const grace = setTimeout(finish, 2_000);
        request.once("end", finish).once("close", finish);
        return;
      }
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      return send(response, 400, {
        error: { message: "The request body is not valid JSON." },
      });
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
        // A client that leaves while the socket is full never drains it, so
        // the wait also ends when the request is aborted.
        if (!response.write(chunk))
          await once(response, "drain", { signal: controller.signal }).catch(
            () => undefined,
          );
      }
    } catch {
      // The stream already carries its terminal error event, or the client left.
    } finally {
      await result.chunks.return?.(undefined);
      response.end();
    }
  };
  const server = http.createServer((request, response) => {
    // Nothing a request does may become an unhandled rejection in the proxy
    // process.
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else
        send(response, 500, {
          error: { message: "The proxy failed to handle the request." },
        });
    });
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
