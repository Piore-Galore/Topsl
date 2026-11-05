import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ProxyService } from "../packages/proxy/service";
import { startProxyServer } from "../packages/proxy/server";
import type { ChatGptCredential } from "../packages/proxy/credentials";
import { parseSse } from "../packages/proxy/sse";
import * as chat from "../packages/proxy/protocols/chat";
import * as messages from "../packages/proxy/protocols/messages";
import { collectResponse } from "../packages/proxy/canonical";
import {
  answer,
  redirectFetch,
  startUpstream,
  type Script,
} from "./native-fixture";

/**
 * The local proxy's account handling and protocol serving, against a
 * synthetic authorization server and upstream. No OpenAI or Anthropic
 * endpoint is contacted.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fakeAuth() {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  let refreshReply: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: {
      access_token: `access-${randomBytes(6).toString("hex")}`,
      refresh_token: `refresh-${randomBytes(6).toString("hex")}`,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
    },
  });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    requests.push({ path: url.pathname, form });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: base,
          jwks_uri: `${base}/jwks`,
          revocation_endpoint: `${base}/revoke`,
          authorization_endpoint: `${base}/api/accounts/authorize`,
          token_endpoint: `${base}/api/accounts/oauth/token`,
        }),
      );
      return;
    }
    if (url.pathname === "/api/accounts/oauth/token") {
      await new Promise((r) => setTimeout(r, 50));
      const reply = refreshReply();
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
      return;
    }
    if (url.pathname === "/revoke") {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return {
    issuer: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    setRefresh(fn: typeof refreshReply) {
      refreshReply = fn;
    },
  };
}

async function setup(script: Script) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-test-proxy-"));
  const upstream = await startUpstream(script);
  const auth = await fakeAuth();
  const proxy = new ProxyService({
    file: path.join(directory, "connections.sqlite"),
    key: randomBytes(32).toString("hex"),
    fetch: redirectFetch(upstream.port),
    chatgpt: { issuer: auth.issuer },
  });
  const server = await startProxyServer(proxy);
  cleanups.push(async () => {
    await server.close();
    proxy.close();
    await upstream.close();
    await rm(directory, { recursive: true, force: true });
  });
  const signIn = (expiresInMs: number) => {
    const connection = proxy.registry.createConnection({
      kind: "chatgpt-plan",
      label: "ChatGPT",
    });
    const credential: ChatGptCredential = {
      kind: "oauth-chatgpt",
      clientId: "oaiapp_fixture",
      extAgentHostId: proxy.database.hostId(),
      issuer: auth.issuer,
      subject: "sub-1",
      email: null,
      idToken: "",
      accessToken: "access-initial",
      refreshToken: "refresh-initial",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      earliestRefreshAt: null,
      scopes: ["chatgpt.tokens.use.direct"],
      savedAt: new Date().toISOString(),
    };
    proxy.credentials.put(connection.id, credential, null);
    proxy.registry.updateConnection(connection.id, {
      hasCredential: true,
      state: "ready",
    });
    const route = proxy.registry.saveRoute({
      connectionId: connection.id,
      alias: "chatgpt/x",
      upstreamModel: "upstream-model",
    });
    return { connection, route };
  };
  const post = (
    pathName: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${server.port}${pathName}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxy.accessToken}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { proxy, server, upstream, auth, signIn, post };
}

async function readEvents(
  response: Response,
  module: typeof chat | typeof messages,
) {
  const events = [];
  for await (const event of module.readStream(parseSse(response.body as any)))
    events.push(event);
  return collectResponse(events);
}

describe("plan sign-in maintenance", () => {
  test("a token near expiry is refreshed once for concurrent requests, rotating every field together", async () => {
    const f = await setup(() => ({ events: answer([{ text: "hi" }]) }));
    const { connection } = f.signIn(60_000);
    const [a, b] = await Promise.all([
      f.post("/v1/responses", {
        model: "chatgpt/x",
        input: "one",
        stream: true,
      }),
      f.post("/v1/responses", {
        model: "chatgpt/x",
        input: "two",
        stream: true,
      }),
    ]);
    await a.text();
    await b.text();
    const refreshes = f.auth.requests.filter((r) => r.path.endsWith("/token"));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].form.get("grant_type")).toBe("refresh_token");
    expect(refreshes[0].form.get("client_id")).toBe("oaiapp_fixture");
    expect(refreshes[0].form.get("refresh_token")).toBe("refresh-initial");
    expect(refreshes[0].form.has("scope")).toBe(false);
    const stored = f.proxy.credentials.get(connection.id)!
      .credential as ChatGptCredential;
    expect(stored.refreshToken).not.toBe("refresh-initial");
    expect(f.upstream.calls.map((c) => c.headers.authorization)).toEqual([
      `Bearer ${stored.accessToken}`,
      `Bearer ${stored.accessToken}`,
    ]);
  });

  test("an explicit authentication rejection renews once with the same identity, then gives up", async () => {
    let rejections = 1;
    const f = await setup(() =>
      rejections-- > 0
        ? {
            status: 401,
            body: { error: { code: "invalid_api_key", message: "expired" } },
          }
        : { events: answer([{ text: "ok" }]) },
    );
    f.signIn(3_600_000);
    const ok = await f.post("/v1/responses", {
      model: "chatgpt/x",
      input: "x",
      stream: true,
    });
    expect(ok.status).toBe(200);
    await ok.text();
    expect(f.upstream.calls).toHaveLength(2);
    rejections = 5;
    const failed = await f.post("/v1/responses", {
      model: "chatgpt/x",
      input: "x",
      stream: true,
    });
    expect(failed.status).toBe(401);
    expect((await failed.json()).topsl_error.kind).toBe("authentication");
    expect(f.upstream.calls).toHaveLength(4);
  });

  test("a terminal refresh error asks for sign-in again and stops sending requests", async () => {
    const f = await setup(() => ({ events: answer([{ text: "never" }]) }));
    f.auth.setRefresh(() => ({
      status: 400,
      body: { error: "invalid_grant" },
    }));
    const { connection } = f.signIn(1000);
    const response = await f.post("/v1/responses", {
      model: "chatgpt/x",
      input: "x",
      stream: true,
    });
    expect(response.status).toBe(401);
    expect(f.upstream.calls).toHaveLength(0);
    expect(f.proxy.registry.requireConnection(connection.id).state).toBe(
      "reauthorization-required",
    );
    const again = await f.post("/v1/responses", {
      model: "chatgpt/x",
      input: "x",
      stream: true,
    });
    expect((await again.json()).topsl_error.code).toBe(
      "reauthorization_required",
    );
  });

  test("disconnect revokes the refresh token, cancels a stream in flight and blocks new requests", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const f = await setup(() => ({ events: answer([{ text: "slow" }]), hold }));
    const { connection } = f.signIn(3_600_000);
    const pending = f
      .post("/v1/responses", { model: "chatgpt/x", input: "x", stream: true })
      .catch((e) => e);
    await new Promise((r) => setTimeout(r, 150));
    const result = await f.proxy.disconnect(connection.id);
    release();
    await pending;
    expect(result.revocation).toBe("confirmed");
    const revoke = f.auth.requests.find((r) => r.path === "/revoke")!;
    expect(revoke.form.get("token")).toBe("refresh-initial");
    expect(revoke.form.get("token_type_hint")).toBe("refresh_token");
    expect(f.proxy.credentials.get(connection.id)).toBeNull();
    expect(f.proxy.registry.requireConnection(connection.id).state).toBe(
      "disconnected",
    );
    const after = await f.post("/v1/responses", {
      model: "chatgpt/x",
      input: "x",
      stream: true,
    });
    expect(after.status).toBe(401);
  });
});

describe("serving the three client protocols", () => {
  test("a Chat Completions client reaches a Responses upstream with tool IDs intact", async () => {
    const f = await setup((call) => {
      expect(call.path).toBe("/openai/responses");
      const output = call.body.input.find(
        (i: any) => i.type === "function_call_output",
      );
      return {
        events: output
          ? answer([{ text: `got ${output.call_id}` }])
          : answer([{ tool: "lookup", args: { q: 1 }, id: "call_abc" }]),
      };
    });
    f.signIn(3_600_000);
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const first = await f.post("/v1/chat/completions", {
      model: "chatgpt/x",
      messages: [{ role: "user", content: "hi" }],
      tools,
      stream: true,
    });
    const call = (await readEvents(first, chat)).output.find(
      (p) => p.type === "tool-call",
    ) as any;
    expect(call.id).toBe("call_abc");
    const second = await f.post("/v1/chat/completions", {
      model: "chatgpt/x",
      stream: true,
      tools,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "lookup", arguments: '{"q":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_abc", content: "42" },
      ],
    });
    expect((await readEvents(second, chat)).output[0]).toEqual({
      type: "text",
      text: "got call_abc",
    });
  });

  test("a Messages client reaches a Responses upstream; unsupported features are refused before dispatch", async () => {
    const f = await setup(() => ({ events: answer([{ text: "hello" }]) }));
    f.signIn(3_600_000);
    const ok = await f.post(
      "/v1/messages",
      {
        model: "chatgpt/x",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      { "anthropic-version": "2023-06-01" },
    );
    // The plan route does not accept an output cap, so Topsl refuses rather than dropping it.
    expect(ok.status).toBe(400);
    expect((await ok.json()).topsl_error.kind).toBe("unsupported");
    expect(f.upstream.calls).toHaveLength(0);
    const hosted = await f.post("/v1/responses", {
      model: "chatgpt/x",
      input: "x",
      tools: [{ type: "web_search" }],
      stream: true,
    });
    expect(hosted.status).toBe(400);
    expect(f.upstream.calls).toHaveLength(0);
  });

  test("an unknown or disabled alias is not found, and models are listed per protocol", async () => {
    const f = await setup(() => ({ events: answer([{ text: "x" }]) }));
    const { connection, route } = f.signIn(3_600_000);
    expect(
      (await f.post("/v1/responses", { model: "nope", input: "x" })).status,
    ).toBe(404);
    f.proxy.registry.saveRoute({
      id: route.id,
      connectionId: connection.id,
      alias: route.alias,
      upstreamModel: route.upstreamModel,
      disabled: true,
    });
    expect(
      (await f.post("/v1/responses", { model: "chatgpt/x", input: "x" }))
        .status,
    ).toBe(404);
    f.proxy.registry.saveRoute({
      id: route.id,
      connectionId: connection.id,
      alias: route.alias,
      upstreamModel: route.upstreamModel,
      disabled: false,
    });
    const openai = await (
      await fetch(`http://127.0.0.1:${f.server.port}/v1/models`, {
        headers: { authorization: `Bearer ${f.proxy.accessToken}` },
      })
    ).json();
    expect(openai.data[0]).toMatchObject({
      id: "chatgpt/x",
      object: "model",
      topsl: { funding: "subscription" },
    });
    const anthropic = await (
      await fetch(`http://127.0.0.1:${f.server.port}/v1/models`, {
        headers: {
          "x-api-key": f.proxy.accessToken,
          "anthropic-version": "2023-06-01",
        },
      })
    ).json();
    expect(anthropic.data[0]).toMatchObject({ id: "chatgpt/x", type: "model" });
  });

  test("an alias resolves to exactly one connection; endpoints are validated per kind", async () => {
    const f = await setup(() => ({ events: answer([{ text: "x" }]) }));
    const { connection } = f.signIn(3_600_000);
    const other = f.proxy.registry.createConnection({
      kind: "ollama",
      label: "Ollama",
    });
    expect(() =>
      f.proxy.registry.saveRoute({
        connectionId: other.id,
        alias: "chatgpt/x",
        upstreamModel: "llama",
      }),
    ).toThrow("already names another route");
    expect(() =>
      f.proxy.registry.createConnection({
        kind: "openai-api",
        label: "x",
        endpoint: "https://evil.example/v1",
      }),
    ).toThrow("documented endpoint");
    expect(() =>
      f.proxy.registry.createConnection({
        kind: "ollama",
        label: "x",
        endpoint: "http://10.0.0.5:11434/v1",
      }),
    ).toThrow("this computer");
    expect(() =>
      f.proxy.registry.createConnection({
        kind: "openai-compatible",
        label: "x",
        endpoint: "http://gateway.example/v1",
      }),
    ).toThrow("https");
    expect(
      f.proxy.registry.saveRoute({
        connectionId: connection.id,
        alias: "chatgpt/y",
        upstreamModel: "m",
      }).protocol,
    ).toBe("responses");
  });
});
