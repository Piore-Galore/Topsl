import { afterEach, expect, test } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ProxyService } from "../packages/proxy/service";
import { startProxyServer } from "../packages/proxy/server";
import { ProxyModelClient } from "../packages/harness/model-client";
import { RouteRetiredError } from "../packages/harness/harness";
import {
  connectionCommandTypes,
  connectionCommands,
} from "../packages/domain/native-commands";
import { RETIREMENT_MARKER } from "../packages/proxy/retirement";
import {
  CLAUDE_PLAN_RETIREMENT_REASON,
  type RequestReceipt,
} from "../packages/proxy/types";
import { answer, nativeFixture } from "./native-fixture";

/**
 * Retirement of the direct Claude subscription connection (proxy schema 2,
 * packages/proxy/retirement.ts). Schema 1 profiles are built here the way
 * Topsl wrote them before 5 November 2026's retirement. Every token is
 * synthetic, and no provider is contacted: the proxies below get a fetch
 * that fails the test if it is ever called.
 */

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const noNetwork: typeof fetch = async (url) => {
  throw new Error(`The upgrade contacted ${String(url)}.`);
};

function raw(file: string, key: string) {
  const db = new Database(file);
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${key}'`);
  return db;
}

const CLAUDE_ACCESS = "synthetic-claude-access-token";
const CLAUDE_REFRESH = "synthetic-claude-refresh-token";
const CLAUDE_EMAIL = "claude-person@example.invalid";

/**
 * A schema 1 profile holding a direct Claude connection (with a route,
 * credential and receipt), an orphaned Claude credential, a ChatGPT plan
 * connection and an OpenAI API key connection with their own routes and
 * receipts.
 */
async function legacyProfile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-test-retire-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "connections.sqlite");
  const key = randomBytes(32).toString("hex");
  // The supported rows are written by the current registry, so their shape
  // is exactly what schema 1 stored; the file is then set back to schema 1.
  const current = new ProxyService({ file, key, fetch: noNetwork });
  const chatgpt = current.registry.createConnection({
    kind: "chatgpt-plan",
    label: "ChatGPT",
  });
  current.credentials.put(
    chatgpt.id,
    {
      kind: "oauth-chatgpt",
      clientId: "oaiapp_fixture",
      extAgentHostId: current.database.hostId(),
      issuer: "https://auth.openai.com",
      subject: "sub-1",
      email: null,
      idToken: "synthetic.id.token",
      accessToken: "synthetic-chatgpt-access",
      refreshToken: "synthetic-chatgpt-refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      earliestRefreshAt: null,
      scopes: ["chatgpt.tokens.use.direct"],
      savedAt: new Date().toISOString(),
    },
    null,
  );
  current.registry.updateConnection(chatgpt.id, {
    hasCredential: true,
    state: "ready",
  });
  const chatgptRoute = current.registry.saveRoute({
    connectionId: chatgpt.id,
    alias: "chatgpt/model",
    upstreamModel: "gpt-model",
  });
  const api = current.registry.createConnection({
    kind: "openai-api",
    label: "OpenAI API",
  });
  await current.command({
    type: "connection-api-key",
    connectionId: api.id,
    key: "sk-synthetic-retirement-test",
  });
  const receipt = (id: string, connectionId: string): RequestReceipt => ({
    id,
    correlationId: null,
    attemptId: `attempt-${id}`,
    routeId: null,
    routeRevision: null,
    connectionId,
    accountKey: null,
    funding: "subscription",
    clientProtocol: "messages",
    upstreamProtocol: "messages",
    requestedModel: "model",
    upstreamModel: "model",
    reportedModel: null,
    outcome: "completed",
    error: null,
    usage: { input: 10, output: 5, cachedInput: null, reasoning: null },
    upstreamRequestId: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  current.registry.recordReceipt(receipt("receipt-chatgpt", chatgpt.id));
  current.close();

  const db = raw(file, key);
  db.exec(`
    DROP TABLE retired_connections;
    DROP TABLE retired_routes;
    DELETE FROM meta WHERE key='${RETIREMENT_MARKER}';
    PRAGMA user_version=1;
  `);
  const at = new Date().toISOString();
  db.prepare("INSERT INTO connections(id,body) VALUES(?,?)").run(
    "claude-connection",
    JSON.stringify({
      id: "claude-connection",
      kind: "claude-plan",
      label: "Claude plan",
      endpoint: "https://api.anthropic.com/v1",
      protocol: "messages",
      authentication: "oauth-claude",
      funding: "subscription",
      state: "ready",
      stateDetail: null,
      account: {
        accountKey: "claude:acct-1:org-1",
        email: CLAUDE_EMAIL,
        source: "oauth-profile",
        quotaOwner: "claude:acct-1:org-1",
        observedAt: at,
      },
      hasCredential: true,
      revocation: "not-supported",
      revision: 3,
      createdAt: at,
      updatedAt: at,
    }),
  );
  db.prepare(
    "INSERT INTO routes(id,alias,connection_id,body) VALUES(?,?,?,?)",
  ).run(
    "claude-route",
    "claude-plan/model",
    "claude-connection",
    JSON.stringify({
      id: "claude-route",
      connectionId: "claude-connection",
      upstreamModel: "claude-model",
      alias: "claude-plan/model",
      protocol: "messages",
      adapterRevision: "claude-plan-messages-e6e5708-v1",
      capabilities: {},
      revision: "legacy-claude-revision",
      disabled: false,
      createdAt: at,
      updatedAt: at,
    }),
  );
  const claudeCredential = (accountId: string) =>
    JSON.stringify({
      kind: "oauth-claude",
      clientId: "legacy-client",
      accountId,
      organizationId: "org-1",
      email: CLAUDE_EMAIL,
      accessToken: CLAUDE_ACCESS,
      refreshToken: CLAUDE_REFRESH,
      tokenType: "Bearer",
      expiresAt: at,
      scopes: ["user:inference"],
      scopeEvidence: "reported",
      savedAt: at,
    });
  const credential = db.prepare(
    "INSERT INTO credentials(connection_id,revision,body,updated_at) VALUES(?,?,?,?)",
  );
  credential.run("claude-connection", 2, claudeCredential("acct-1"), at);
  credential.run("deleted-connection", 1, claudeCredential("acct-2"), at);
  const claudeReceipt = receipt("receipt-claude", "claude-connection");
  db.prepare(
    "INSERT INTO receipts(id,attempt_id,connection_id,started_at,body) VALUES(?,?,?,?,?)",
  ).run(
    claudeReceipt.id,
    claudeReceipt.attemptId,
    claudeReceipt.connectionId,
    claudeReceipt.startedAt,
    JSON.stringify(claudeReceipt),
  );
  db.close();
  return { directory, file, key, chatgpt, chatgptRoute, api };
}

function snapshot(file: string, key: string) {
  const db = raw(file, key);
  try {
    const all = (table: string) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return {
      version: db.prepare("PRAGMA user_version").get() as {
        user_version: number;
      },
      tables: Object.fromEntries(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map(({ name }) => [name, all(name)]),
      ) as Record<string, any[]>,
    };
  } finally {
    db.close();
  }
}

test("a mixed schema 1 profile upgrades offline: Claude credentials go, everything else stays", async () => {
  const p = await legacyProfile();
  const before = snapshot(p.file, p.key);
  const proxy = new ProxyService({ file: p.file, key: p.key, fetch: noNetwork });
  cleanups.push(() => proxy.close());
  const after = snapshot(p.file, p.key);

  expect(after.version.user_version).toBe(2);
  // Credentials: both Claude rows gone; the others byte for byte unchanged.
  expect(after.tables.credentials.map((r) => r.connection_id).sort()).toEqual(
    [p.api.id, p.chatgpt.id].sort(),
  );
  for (const row of after.tables.credentials)
    expect(row).toEqual(
      before.tables.credentials.find(
        (r) => r.connection_id === row.connection_id,
      ),
    );
  expect(JSON.stringify(after.tables)).not.toContain(CLAUDE_ACCESS);
  expect(JSON.stringify(after.tables)).not.toContain(CLAUDE_REFRESH);
  // Other connections, routes and every receipt are unchanged.
  expect(after.tables.connections).toEqual(
    before.tables.connections.filter((r) => r.id !== "claude-connection"),
  );
  expect(after.tables.routes).toEqual(
    before.tables.routes.filter((r) => r.id !== "claude-route"),
  );
  expect(after.tables.receipts).toEqual(before.tables.receipts);

  // History-only descriptors keep IDs, alias, funding and account fingerprint.
  const view = proxy.view();
  expect(view.connections.map((c) => c.id).sort()).toEqual(
    [p.api.id, p.chatgpt.id].sort(),
  );
  expect(view.retired.connections).toEqual([
    expect.objectContaining({
      id: "claude-connection",
      kind: "claude-plan",
      funding: "subscription",
      reason: CLAUDE_PLAN_RETIREMENT_REASON,
      account: expect.objectContaining({
        accountKey: "claude:acct-1:org-1",
        email: null,
      }),
    }),
  ]);
  expect(view.retired.routes).toEqual([
    expect.objectContaining({
      id: "claude-route",
      alias: "claude-plan/model",
      revision: "legacy-claude-revision",
    }),
  ]);
  expect(JSON.stringify(view)).not.toContain(CLAUDE_EMAIL);
  expect(proxy.registry.receipts({ connectionId: "claude-connection" })).toEqual(
    [expect.objectContaining({ id: "receipt-claude" })],
  );
  const marker = JSON.parse(
    after.tables.meta.find((r) => r.key === RETIREMENT_MARKER).value,
  );
  expect(marker).toMatchObject({
    state: "complete",
    attempts: 1,
    counts: { connections: 1, routes: 1, credentials: 1, orphanCredentials: 1 },
  });

  // Reopening is idempotent.
  proxy.close();
  cleanups.pop();
  const again = new ProxyService({ file: p.file, key: p.key, fetch: noNetwork });
  again.close();
  expect(snapshot(p.file, p.key)).toEqual(after);
});

test("a cleanup failure rolls back behind the fence, and the next open completes", async () => {
  const p = await legacyProfile();
  expect(
    () =>
      new ProxyService({
        file: p.file,
        key: p.key,
        fetch: noNetwork,
        retirement: {
          beforeCleanupCommit: () => {
            throw new Error("injected cleanup fault");
          },
        },
      }),
  ).toThrow("injected cleanup fault");
  const failed = snapshot(p.file, p.key);
  // The fence held: schema 2, so an older Topsl refuses the file …
  expect(failed.version.user_version).toBe(2);
  expect(
    JSON.parse(failed.tables.meta.find((r) => r.key === RETIREMENT_MARKER).value),
  ).toMatchObject({ state: "fenced", attempts: 1 });
  // … and the cleanup rolled back as a whole.
  expect(
    failed.tables.connections.some((r) => r.id === "claude-connection"),
  ).toBe(true);
  expect(failed.tables.credentials).toHaveLength(4);
  expect(failed.tables.retired_connections).toEqual([]);

  const proxy = new ProxyService({ file: p.file, key: p.key, fetch: noNetwork });
  cleanups.push(() => proxy.close());
  const done = snapshot(p.file, p.key);
  expect(
    JSON.parse(done.tables.meta.find((r) => r.key === RETIREMENT_MARKER).value),
  ).toMatchObject({
    state: "complete",
    attempts: 2,
    counts: { connections: 1, credentials: 1, orphanCredentials: 1 },
  });
  expect(done.tables.credentials).toHaveLength(2);
  expect(proxy.view().retired.connections).toHaveLength(1);
});

test("the upgrade refuses to run beneath another writer, and a newer schema is refused", async () => {
  const p = await legacyProfile();
  const holder = raw(p.file, p.key);
  holder.exec("BEGIN IMMEDIATE");
  expect(
    () => new ProxyService({ file: p.file, key: p.key, fetch: noNetwork }),
  ).toThrow(/locked|busy/i);
  holder.exec("ROLLBACK");
  holder.close();
  const untouched = snapshot(p.file, p.key);
  expect(untouched.version.user_version).toBe(1);
  expect(untouched.tables.credentials).toHaveLength(4);

  const proxy = new ProxyService({ file: p.file, key: p.key, fetch: noNetwork });
  proxy.close();
  const db = raw(p.file, p.key);
  db.pragma("user_version=3");
  db.close();
  expect(
    () => new ProxyService({ file: p.file, key: p.key, fetch: noNetwork }),
  ).toThrow("newer Topsl version");
}, 20_000);

test("a retired route is refused before dispatch with its reason, and its alias stays reserved", async () => {
  const p = await legacyProfile();
  const calls: string[] = [];
  const proxy = new ProxyService({
    file: p.file,
    key: p.key,
    fetch: async (url) => {
      calls.push(String(url));
      throw new Error("no upstream in this test");
    },
  });
  const server = await startProxyServer(proxy);
  cleanups.push(async () => {
    await server.close();
    proxy.close();
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${proxy.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-plan/model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(response.status).toBe(410);
  const body = await response.json();
  expect(body.topsl_error).toMatchObject({
    code: "route_retired",
    kind: "route-changed",
  });
  expect(body.topsl_error.message).toContain("retired");
  expect(calls).toEqual([]);
  expect(
    proxy.registry.receipts({ connectionId: "claude-connection" })[0],
  ).toMatchObject({ outcome: "rejected", routeId: "claude-route" });
  expect(() =>
    proxy.registry.saveRoute({
      connectionId: p.chatgpt.id,
      alias: "claude-plan/model",
      upstreamModel: "gpt-model",
    }),
  ).toThrow("retired route");
});

test("every entry point refuses the retired connection kind", async () => {
  const p = await legacyProfile();
  const proxy = new ProxyService({ file: p.file, key: p.key, fetch: noNetwork });
  cleanups.push(() => proxy.close());
  await expect(
    proxy.command({
      type: "connection-create",
      kind: "claude-plan" as any,
      label: "Claude",
    }),
  ).rejects.toThrow("Direct Claude subscription sign-in was removed");
  for (const type of [
    "connection-sign-in",
    "connection-disconnect",
    "connection-remove",
    "connection-models",
  ] as const)
    await expect(
      proxy.command({ type, connectionId: "claude-connection" }),
    ).rejects.toThrow("Direct Claude subscription sign-in was removed");
  await expect(
    proxy.command({
      type: "connection-api-key",
      connectionId: "claude-connection",
      key: "sk-synthetic-key-value",
    }),
  ).rejects.toThrow("Direct Claude subscription sign-in was removed");
  // The window's command schema has no way to name it.
  const create = connectionCommands.find(
    (c) => c.shape.type.value === "connection-create",
  )!;
  expect(
    create.safeParse({
      type: "connection-create",
      kind: "claude-plan",
      label: "Claude",
    }).success,
  ).toBe(false);
  expect(connectionCommandTypes.has("connection-sign-in-complete")).toBe(false);
  // A stray row of the retired kind is never decoded as a usable connection.
  const db = raw(p.file, p.key);
  db.prepare("INSERT INTO connections(id,body) VALUES(?,?)").run(
    "stray",
    JSON.stringify({ id: "stray", kind: "claude-plan", label: "Stray" }),
  );
  db.close();
  expect(proxy.registry.connections().some((c) => c.id === "stray")).toBe(false);
  expect(() => proxy.registry.requireConnection("stray")).toThrow(
    "does not exist",
  );
  expect(proxy.view()).not.toHaveProperty("claudeSubscription");
});

test("a waiting task on a retired route keeps its history and cannot resume or move", async () => {
  const f = await nativeFixture((_call, index) =>
    index === 0
      ? {
          status: 429,
          body: {
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "limit",
            },
          },
        }
      : { events: answer([{ text: "never sent" }]) },
  );
  cleanups.push(() => f.close());
  const { connection } = f.chatgpt();
  const route = f.route(connection.id, "chatgpt/test");
  const started = await f.start({ routeAlias: "chatgpt/test", prompt: "hi" });
  await expect
    .poll(() => f.harness.view(started.attemptId)!.state)
    .toBe("waiting-quota");
  const before = f.harness.view(started.attemptId)!;
  const events = f.harness.events(started.attemptId, 0, 100).events.length;
  f.retired.set(route.id, CLAUDE_PLAN_RETIREMENT_REASON);
  const error = await f.harness.resume(started.attemptId).catch((e) => e);
  expect(error).toBeInstanceOf(RouteRetiredError);
  expect(error.code).toBe("route-retired");
  expect(error.message).toContain("cannot continue");
  const after = f.harness.view(started.attemptId)!;
  expect(after.state).toBe("waiting-quota");
  expect(after.binding).toEqual(before.binding);
  expect(f.harness.events(started.attemptId, 0, 100).events.length).toBe(events);
  expect(f.upstream.calls).toHaveLength(1);
});

test("a binding frozen on the retired kind sends nothing", async () => {
  const requests: string[] = [];
  const client = new ProxyModelClient(
    () => ({ port: 9, token: "unused" }),
    (async (url: any) => {
      requests.push(String(url));
      throw new Error("must not be called");
    }) as typeof fetch,
  );
  const events = [];
  for await (const event of client.stream({
    binding: {
      id: "binding",
      engine: "native",
      native: {
        routeId: "claude-route",
        routeAlias: "claude-plan/model",
        routeRevision: "legacy",
        connectionId: "claude-connection",
        connectionKind: "claude-plan",
        connectionLabel: "Claude plan",
        protocol: "messages",
        upstreamModel: "claude-model",
        funding: "subscription",
        accountKey: "claude:acct-1:org-1",
        quotaOwner: "claude:acct-1:org-1",
      },
      vendor: null,
      model: { reasoningEffort: null, contextWindowTokens: 200_000 },
      policyRevision: "policy",
      createdAt: new Date().toISOString(),
    } as any,
    request: {
      model: "claude-plan/model",
      instructions: null,
      messages: [],
      tools: [],
      toolChoice: "auto",
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      stop: [],
      reasoningEffort: null,
      thinkingBudget: null,
      parallelToolCalls: null,
      stream: true,
      clientProtocol: "messages",
    },
    attemptId: "attempt",
    correlationId: "correlation",
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(events).toEqual([
    expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "route_retired" }),
    }),
  ]);
  expect(requests).toEqual([]);
});
