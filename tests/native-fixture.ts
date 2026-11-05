import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Store } from "../packages/persistence/store";
import { now, uid } from "../packages/domain/invariants";
import type { Project } from "../packages/domain/types";
import { ProxyService } from "../packages/proxy/service";
import { startProxyServer, type ProxyServer } from "../packages/proxy/server";
import { protocols } from "../packages/proxy/adapters";
import type {
  CanonicalEvent,
  CanonicalRequest,
  ClientProtocol,
} from "../packages/proxy/canonical";
import type { ChatGptCredential } from "../packages/proxy/credentials";
import { NativeHarness } from "../packages/harness/harness";
import type { NativeAttemptView } from "../packages/harness/types";
import { gitExecutable } from "./helpers";

/**
 * A synthetic upstream for native harness tests. It reads each request with
 * the same protocol module a real client would be checked against, and
 * answers with a scripted stream. No real provider, account or model is
 * involved; see docs/Native_Harness_Plan.md §5 for what this does not prove.
 */

export interface UpstreamCall {
  protocol: ClientProtocol;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  request: CanonicalRequest;
}
export type UpstreamReply =
  | { events: CanonicalEvent[]; delayMs?: number; hold?: Promise<void> }
  | { status: number; body: unknown };
export type Script = (
  call: UpstreamCall,
  index: number,
) => UpstreamReply | Promise<UpstreamReply>;

/** A model answer: text and/or tool calls, then usage and a finish. */
export function answer(
  parts: Array<{ text: string } | { tool: string; args: unknown; id?: string }>,
  usage = { input: 120, output: 30 },
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [
    {
      type: "response-start",
      responseId: `resp_${uid().slice(0, 8)}`,
      model: "upstream-model-reported",
    },
  ];
  let tools = false;
  parts.forEach((part, index) => {
    if ("text" in part)
      events.push(
        { type: "text-delta", index, text: part.text },
        { type: "part-end", index },
      );
    else {
      tools = true;
      const id = part.id ?? `call_${uid().slice(0, 8)}`;
      events.push(
        { type: "tool-call-start", index, id, name: part.tool },
        {
          type: "tool-call-delta",
          index,
          argumentsDelta: JSON.stringify(part.args),
        },
        { type: "part-end", index },
      );
    }
  });
  events.push({
    type: "usage",
    input: usage.input,
    output: usage.output,
    cachedInput: 0,
    reasoning: null,
  });
  events.push({
    type: "finish",
    reason: tools ? "tool-calls" : "stop",
    rawReason: null,
  });
  return events;
}

/** The tool results the request carries in its last user message. */
export function lastResults(
  request: CanonicalRequest,
): Array<{ callId: string; output: string; isError: boolean }> {
  const last = [...request.messages].reverse().find((m) => m.role === "user");
  return (last?.parts ?? [])
    .filter((p) => p.type === "tool-result")
    .map((p: any) => ({
      callId: p.callId,
      output: p.output,
      isError: p.isError,
    }));
}

export async function startUpstream(script: Script) {
  const calls: UpstreamCall[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          url.pathname.includes("chatgpt")
            ? {}
            : { data: [{ id: "upstream-model" }, { id: "upstream-model-2" }] },
        ),
      );
      return;
    }
    const protocol: ClientProtocol = url.pathname.endsWith("/responses")
      ? "responses"
      : url.pathname.endsWith("/messages")
        ? "messages"
        : "chat";
    const body = JSON.parse(text);
    const request = protocols[protocol].parseRequest(body);
    const call = {
      protocol,
      path: url.pathname,
      headers: req.headers,
      body,
      request,
    };
    calls.push(call);
    const reply = await script(call, calls.length - 1);
    if ("status" in reply) {
      res.writeHead(reply.status, {
        "content-type": "application/json",
        "x-request-id": `req_${calls.length}`,
      });
      res.end(JSON.stringify(reply.body));
      return;
    }
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (reply.hold) await reply.hold;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-request-id": `req_${calls.length}`,
    });
    const scripted = reply.events;
    async function* events() {
      yield* scripted;
    }
    for await (const chunk of protocols[protocol].writeStream(events(), {
      model: "upstream-model-reported",
      responseId: `resp_${calls.length}`,
    }))
      res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A fetch that sends official endpoints to the synthetic upstream. */
export function redirectFetch(port: number): typeof fetch {
  return (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url)
      .replace("https://api.openai.com/v1", `http://127.0.0.1:${port}/openai`)
      .replace(
        "https://api.anthropic.com/v1",
        `http://127.0.0.1:${port}/anthropic`,
      );
    return fetch(url, init);
  };
}

/**
 * The synthetic upstream behind Topsl's real local proxy (loopback server,
 * encrypted connection store, route revisions), without a harness: for a
 * test that attaches the proxy to a whole control service.
 */
export async function nativeProxy(script: Script) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "topsl-test-proxy-")),
  );
  const upstream = await startUpstream(script);
  const proxy = new ProxyService({
    file: path.join(directory, "connections.sqlite"),
    key: randomBytes(32).toString("hex"),
    fetch: redirectFetch(upstream.port),
  });
  const server: ProxyServer = await startProxyServer(proxy);
  const endpoint = { port: server.port, token: proxy.accessToken };
  return {
    upstream,
    proxy,
    server,
    endpoint,
    /** An API-key connection with a synthetic key. */
    async apiKey(
      kind: "openai-api" | "anthropic-api",
      key = `sk-synthetic-${randomBytes(12).toString("hex")}`,
      label: string = kind,
    ) {
      const connection = proxy.registry.createConnection({ kind, label });
      await proxy.command({
        type: "connection-api-key",
        connectionId: connection.id,
        key,
      });
      return {
        connection: proxy.registry.requireConnection(connection.id),
        key,
      };
    },
    route(
      connectionId: string,
      alias: string,
      upstreamModel = "upstream-model-reported",
    ) {
      return proxy.registry.saveRoute({ connectionId, alias, upstreamModel });
    },
    async close() {
      await server.close();
      proxy.close();
      await upstream.close();
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
}

export async function nativeFixture(
  script: Script,
  options: { files?: Record<string, string>; git?: boolean } = {},
) {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "topsl-test-native-")),
  );
  const key = randomBytes(32).toString("hex");
  const store = new Store(path.join(directory, "history.sqlite"), key);
  const root = path.join(directory, "project");
  await mkdir(root, { recursive: true });
  for (const [name, content] of Object.entries(
    options.files ?? {
      "src/math.js": "export function add(a, b) {\n  return a - b;\n}\n",
      "README.md": "# Fixture\n",
    },
  )) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  if (options.git !== false) {
    const git = (...args: string[]) =>
      execFileSync(gitExecutable, args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
  }
  const project: Project = {
    id: uid(),
    name: "Fixture",
    path: root,
    realPath: root,
    trusted: true,
    createdAt: now(),
  };
  store.put("project", project);
  const upstream = await startUpstream(script);
  const proxy = new ProxyService({
    file: path.join(directory, "connections.sqlite"),
    key: randomBytes(32).toString("hex"),
    fetch: redirectFetch(upstream.port),
  });
  const server: ProxyServer = await startProxyServer(proxy);
  const endpoint = { port: server.port, token: proxy.accessToken };
  const harness = new NativeHarness({
    store,
    profileDirectory: directory,
    endpoint: () => endpoint,
    route: (alias) => {
      const route = proxy.registry.routeByAlias(alias);
      const connection = route && proxy.registry.connection(route.connectionId);
      return route && connection ? { route, connection } : null;
    },
    gitExecutable,
  });
  return {
    directory,
    key,
    store,
    root,
    project,
    upstream,
    proxy,
    server,
    endpoint,
    harness,
    /** A ChatGPT plan connection with a synthetic, unexpired sign-in. */
    chatgpt(subject = "user-subject-1", clientId = "oaiapp_fixture") {
      const connection = proxy.registry.createConnection({
        kind: "chatgpt-plan",
        label: `ChatGPT ${subject}`,
      });
      const credential: ChatGptCredential = {
        kind: "oauth-chatgpt",
        clientId,
        extAgentHostId: proxy.database.hostId(),
        issuer: "https://auth.openai.com",
        subject,
        email: `${subject}@example.invalid`,
        idToken: "synthetic.id.token",
        accessToken: `synthetic-access-${subject}-${randomBytes(8).toString("hex")}`,
        refreshToken: `synthetic-refresh-${randomBytes(8).toString("hex")}`,
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        earliestRefreshAt: null,
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        savedAt: now(),
      };
      proxy.credentials.put(connection.id, credential, null);
      proxy.registry.updateConnection(connection.id, {
        hasCredential: true,
        state: "ready",
        account: {
          accountKey: `chatgpt:${subject}:${clientId}`,
          email: credential.email,
          source: "id-token",
          quotaOwner: `chatgpt:${subject}:${clientId}`,
          observedAt: now(),
        },
      });
      return {
        connection: proxy.registry.requireConnection(connection.id),
        credential,
      };
    },
    apiKey(
      kind: "openai-api" | "anthropic-api",
      key = `sk-synthetic-${randomBytes(12).toString("hex")}`,
    ) {
      const connection = proxy.registry.createConnection({ kind, label: kind });
      void proxy.command({
        type: "connection-api-key",
        connectionId: connection.id,
        key,
      });
      return {
        connection: proxy.registry.requireConnection(connection.id),
        key,
      };
    },
    route(
      connectionId: string,
      alias: string,
      upstreamModel = "upstream-model",
    ) {
      return proxy.registry.saveRoute({ connectionId, alias, upstreamModel });
    },
    async settle(attemptId: string): Promise<NativeAttemptView> {
      return harness.kernel.settled(attemptId);
    },
    start(
      input: Partial<Parameters<NativeHarness["start"]>[0]> & {
        routeAlias: string;
        prompt: string;
      },
    ) {
      return harness.start({
        projectId: project.id,
        mode: "edit",
        processes: false,
        networkDomains: [],
        checks: [],
        delegation: false,
        mcpServerIds: [],
        reasoningEffort: null,
        contextWindowTokens: null,
        maxRequests: null,
        ...input,
      });
    },
    async close() {
      harness.close();
      await server.close();
      proxy.close();
      await upstream.close();
      store.close();
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
}
