import { afterEach, describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  beginClaudeSignIn,
  refreshClaude,
  CLAUDE_OAUTH_CLIENT_ID,
  type ClaudeAuthConfig,
} from "../packages/proxy/oauth/claude";
import { ProxyService, claudeAccount } from "../packages/proxy/service";
import { nativeFixture, answer, lastResults } from "./native-fixture";
import type { ClaudeCredential } from "../packages/proxy/credentials";
import { routeHeaders } from "../packages/proxy/types";

// Synthetic OAuth/model endpoints only. No live account or credential is used.
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function oauth() {
  const calls: Array<{ url: string; body: any; headers: Headers }> = [];
  let response: any = {
    access_token: "synthetic-claude-access",
    refresh_token: "synthetic-claude-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "user:profile user:inference",
    account: { uuid: "account-1", email_address: "fixture@example.invalid" },
    organization: { uuid: "org-1" },
  };
  let status = 200;
  let profile: any = {
    account: { uuid: "account-1", email: "fixture@example.invalid" },
    organization: { uuid: "org-1" },
  };
  let gate: Promise<void> | null = null;
  const config: ClaudeAuthConfig = {
    port: 0,
    fetch: (async (url: any, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      });
      if (gate) await gate;
      if (String(url).endsWith("/profile")) return Response.json(profile);
      return Response.json(response, { status });
    }) as typeof fetch,
  };
  return {
    config,
    calls,
    set(body: any, code = 200) {
      response = body;
      status = code;
    },
    setProfile(body: any) {
      profile = body;
    },
    hold(value: Promise<void>) {
      gate = value;
    },
  };
}
async function signIn(
  fake: ReturnType<typeof oauth>,
  previous?: ClaudeCredential,
) {
  const attempt = await beginClaudeSignIn(fake.config, previous);
  cleanup.push(() => attempt.cancel());
  const state = new URL(attempt.authorizeUrl).searchParams.get("state")!;
  return {
    attempt,
    state,
    complete: () => attempt.submitCallback(`fixture-code#${state}`),
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}
async function service(
  fake: ReturnType<typeof oauth>,
  modelFetch: typeof fetch = async () =>
    Response.json({ data: [{ id: "model-1" }] }),
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-claude-auth-"));
  const urls: string[] = [];
  const proxy = new ProxyService({
    file: path.join(directory, "connections.sqlite"),
    key: randomBytes(32).toString("hex"),
    claude: fake.config,
    fetch: modelFetch,
    openExternal: (url) => urls.push(url),
  });
  cleanup.push(async () => {
    proxy.close();
    await rm(directory, { recursive: true, force: true });
  });
  const connection = proxy.registry.createConnection({
    kind: "claude-plan",
    label: "Claude",
  });
  const start = (await proxy.command({
    type: "connection-sign-in",
    connectionId: connection.id,
  })) as { attemptId: string };
  const state = new URL(urls[0]).searchParams.get("state")!;
  return {
    proxy,
    connection,
    start,
    urls,
    complete: () =>
      proxy.command({
        type: "connection-sign-in-complete",
        attemptId: start.attemptId,
        callback: `fixture-code#${state}`,
      }),
  };
}

describe("experimental Claude plan browser sign-in", () => {
  test("browser callback binds PKCE, state, account and organization without exposing credentials", async () => {
    const fake = oauth();
    const { attempt, state } = await signIn(fake);
    const url = new URL(attempt.authorizeUrl);
    expect(url.origin).toBe("https://claude.ai");
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID);
    const callback = new URL(attempt.redirectUri);
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", state);
    const reply = await fetch(callback);
    expect(reply.ok).toBe(true);
    expect(await reply.text()).not.toContain("synthetic");
    const result = await attempt.result;
    expect(result.outcome).toBe("signed-in");
    if (!("credential" in result)) throw new Error("Missing credential");
    expect(result.credential.accountId).toBe("account-1");
    expect(result.credential.organizationId).toBe("org-1");
    expect(result.credential.scopeEvidence).toBe("reported");
    const body = fake.calls[0].body;
    expect(body.state).toBe(state);
    expect(body.redirect_uri).toBe(attempt.redirectUri);
    expect(
      createHash("sha256").update(body.code_verifier).digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge"));
  });

  test("wrong or conflicting state never exchanges a code and does not consume the attempt", async () => {
    const fake = oauth();
    const { attempt, state, complete } = await signIn(fake);
    await expect(attempt.submitCallback("code#wrong-state")).rejects.toThrow(
      "state",
    );
    const bad = new URL(attempt.redirectUri);
    bad.searchParams.set("code", "code#wrong-state");
    bad.searchParams.set("state", state);
    await expect(attempt.submitCallback(bad.toString())).rejects.toThrow(
      "state",
    );
    expect(fake.calls).toHaveLength(0);
    await complete();
    expect((await attempt.result).outcome).toBe("signed-in");
    await expect(complete()).rejects.toThrow("no longer");
  });

  test("declined consent performs no exchange", async () => {
    const fake = oauth();
    const { attempt, state } = await signIn(fake);
    await attempt.submitCallback(
      `${attempt.redirectUri}?error=access_denied&state=${state}`,
    );
    expect(await attempt.result).toEqual({ outcome: "declined" });
    expect(fake.calls).toHaveLength(0);
  });

  test("missing identity is fetched from the authenticated profile", async () => {
    const fake = oauth();
    fake.set({
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_in: 3600,
    });
    const { attempt, complete } = await signIn(fake);
    await complete();
    const result = await attempt.result;
    expect(result.outcome).toBe("signed-in");
    if (!("credential" in result)) throw new Error("Missing credential");
    expect(result.credential.scopeEvidence).toBe("requested");
    expect(fake.calls[1].headers.get("authorization")).toBe(
      "Bearer synthetic-access",
    );
  });

  test("an explicitly reduced scope preserves sign-in but disables plan inference", async () => {
    const fake = oauth();
    fake.set({
      access_token: "synthetic-access",
      expires_in: 3600,
      scope: "user:profile",
      account: { uuid: "account-1" },
      organization: { uuid: "org-1" },
    });
    const { attempt, complete } = await signIn(fake);
    await complete();
    expect((await attempt.result).outcome).toBe("plan-use-disabled");
  });

  test("provider errors do not echo code or token data", async () => {
    const fake = oauth();
    fake.set({ error: "fixture-code synthetic-claude-refresh" }, 400);
    const { attempt, complete } = await signIn(fake);
    await complete();
    expect(await attempt.result).toEqual({
      outcome: "failed",
      error: "Claude authentication returned HTTP 400.",
    });
  });

  test("cancellation and timeout settle without exchanging", async () => {
    const fake = oauth();
    const { attempt } = await signIn(fake);
    attempt.cancel();
    expect(await attempt.result).toEqual({ outcome: "cancelled" });
    const timed = await beginClaudeSignIn({ ...fake.config, timeoutMs: 15 });
    expect(await timed.result).toEqual({ outcome: "timed-out" });
    expect(fake.calls).toHaveLength(0);
  });

  test("reauthorization rejects a different identity", async () => {
    const fake = oauth();
    const first = await signIn(fake);
    await first.complete();
    const initial = await first.attempt.result;
    if (!("credential" in initial)) throw new Error("Missing credential");
    fake.set({
      access_token: "different",
      expires_in: 3600,
      account: { uuid: "account-2" },
      organization: { uuid: "org-1" },
    });
    const next = await signIn(fake, initial.credential);
    await next.complete();
    expect((await next.attempt.result).outcome).toBe("failed");
  });

  test.each(["different", "missing"])(
    "reauthorization checks the newly authenticated profile when identity is %s",
    async (identity) => {
      const fake = oauth();
      const first = await signIn(fake);
      await first.complete();
      const initial = await first.attempt.result;
      if (!("credential" in initial)) throw new Error("Missing credential");
      fake.set({ access_token: "different-access", expires_in: 3600 });
      fake.setProfile(
        identity === "different"
          ? { account: { uuid: "account-2" }, organization: { uuid: "org-1" } }
          : {},
      );
      const next = await signIn(fake, initial.credential);
      await next.complete();
      expect((await next.attempt.result).outcome).toBe("failed");
      expect(fake.calls.at(-1)?.headers.get("authorization")).toBe(
        "Bearer different-access",
      );
    },
  );

  test("refresh rotates credentials while retaining identity and rejects account changes", async () => {
    const fake = oauth();
    const first = await signIn(fake);
    await first.complete();
    const initial = await first.attempt.result;
    if (!("credential" in initial)) throw new Error("Missing credential");
    fake.set({
      access_token: "renewed",
      refresh_token: "rotated",
      expires_in: 3600,
    });
    const renewed = await refreshClaude(fake.config, initial.credential);
    expect(renewed.accountId).toBe("account-1");
    expect(renewed.refreshToken).toBe("rotated");
    fake.set({
      access_token: "other",
      expires_in: 3600,
      account: { uuid: "account-2" },
      organization: { uuid: "org-1" },
    });
    await expect(refreshClaude(fake.config, renewed)).rejects.toThrow(
      "another account",
    );
  });
});

describe("Claude plan proxy integration", () => {
  test("simultaneous requests share one refresh and atomically retain the rotated token", async () => {
    const fake = oauth();
    const f = await service(fake);
    await f.complete();
    await until(
      () =>
        f.proxy.registry.requireConnection(f.connection.id).state === "ready",
    );
    const old = f.proxy.credentials.get(f.connection.id)!;
    if (old.credential.kind !== "oauth-claude")
      throw new Error("Wrong credential");
    f.proxy.credentials.put(
      f.connection.id,
      { ...old.credential, expiresAt: new Date(0).toISOString() },
      old.revision,
    );
    fake.set({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    await Promise.all([
      f.proxy.models(f.connection.id),
      f.proxy.models(f.connection.id),
      f.proxy.models(f.connection.id),
    ]);
    expect(
      fake.calls.filter((c) => c.body?.grant_type === "refresh_token"),
    ).toHaveLength(1);
    expect(f.proxy.credentials.get(f.connection.id)?.credential).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      accountId: "account-1",
    });
  });

  test("a rejected subscription never switches to API billing and requires sign-in after one renewal", async () => {
    const fake = oauth();
    const headers: Headers[] = [];
    const f = await service(fake, async (_url, init) => {
      headers.push(new Headers(init?.headers));
      return Response.json(
        {
          error: { type: "authentication_error", message: "Sign-in rejected" },
        },
        { status: 401 },
      );
    });
    await f.complete();
    await until(
      () =>
        f.proxy.registry.requireConnection(f.connection.id).state === "ready",
    );
    const route = f.proxy.registry.saveRoute({
      connectionId: f.connection.id,
      alias: "claude/test",
      upstreamModel: "model-1",
    });
    const result = await f.proxy.infer({
      protocol: "messages",
      headers: {},
      signal: new AbortController().signal,
      body: {
        model: route.alias,
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(result.status).toBe(401);
    expect(headers).toHaveLength(2);
    expect(
      headers.every(
        (h) =>
          h.get("authorization")?.startsWith("Bearer ") && !h.has("x-api-key"),
      ),
    ).toBe(true);
    expect(
      fake.calls.filter((c) => c.body?.grant_type === "refresh_token"),
    ).toHaveLength(1);
    expect(f.proxy.registry.requireConnection(f.connection.id).state).toBe(
      "reauthorization-required",
    );
    expect(
      f.proxy.registry.receipts({ connectionId: f.connection.id })[0].funding,
    ).toBe("subscription");
  });

  test("built-in sign-in stores encrypted credentials and publishes only metadata", async () => {
    const fake = oauth();
    const f = await service(fake);
    await f.complete();
    await until(
      () =>
        f.proxy.registry.requireConnection(f.connection.id).state === "ready",
    );
    const view = f.proxy.view();
    const connection = view.connections[0];
    expect(connection.funding).toBe("subscription");
    expect(connection.authentication).toBe("oauth-claude");
    expect(connection.account.quotaOwner).toBe("claude:account-1:org-1");
    expect(JSON.stringify(view)).not.toContain("synthetic-claude-access");
    expect(f.proxy.credentials.get(connection.id)?.credential.kind).toBe(
      "oauth-claude",
    );
    await f.proxy.disconnect(connection.id);
    expect(f.proxy.credentials.get(connection.id)).toBeNull();
    expect(f.proxy.registry.requireConnection(connection.id).state).toBe(
      "disconnected",
    );
  });

  test("disconnect during token exchange cannot resurrect the connection", async () => {
    const fake = oauth();
    let release!: () => void;
    fake.hold(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const f = await service(fake);
    const pending = f.complete();
    await until(() => fake.calls.length === 1);
    await f.proxy.disconnect(f.connection.id);
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 20));
    expect(f.proxy.credentials.get(f.connection.id)).toBeNull();
    expect(f.proxy.registry.requireConnection(f.connection.id).state).toBe(
      "disconnected",
    );
  });

  test("disconnect cancels a sign-in still opening its callback listener", async () => {
    const f = await service(oauth());
    await f.proxy.command({
      type: "connection-sign-in-cancel",
      attemptId: f.start.attemptId,
    });
    await until(() => f.proxy.view().signIns.length === 0);
    const pending = f.proxy.command({
      type: "connection-sign-in",
      connectionId: f.connection.id,
    });
    const cancelled = expect(pending).rejects.toThrow("cancelled");
    const duplicate = expect(
      f.proxy.command({
        type: "connection-sign-in",
        connectionId: f.connection.id,
      }),
    ).rejects.toThrow("already opening");
    await f.proxy.disconnect(f.connection.id);
    await Promise.all([cancelled, duplicate]);
    expect(f.proxy.view().signIns).toHaveLength(0);
    expect(f.urls).toHaveLength(1);
    expect(f.proxy.credentials.get(f.connection.id)).toBeNull();
  });

  test("Claude plan executes native read/edit/check/candidate work with bearer OAuth and no API key", async () => {
    const containedChecks = process.platform === "darwin";
    const f = await nativeFixture((call, index) => {
      if (index === 0)
        return {
          events: answer([
            { tool: "read_file", args: { path: "src/math.js" } },
          ]),
        };
      if (index === 1)
        return {
          events: answer([
            {
              tool: "edit_file",
              args: {
                path: "src/math.js",
                old_text: "a - b",
                new_text: "a + b",
                expected_sha256: /sha256: ([a-f0-9]{64})/.exec(
                  lastResults(call.request)[0].output,
                )![1],
              },
            },
          ]),
        };
      if (index === 2 && containedChecks)
        return {
          events: answer([{ tool: "run_check", args: { name: "math" } }]),
        };
      return { events: answer([{ text: "Fixed addition." }]) };
    });
    cleanup.push(() => f.close());
    const fake = oauth();
    const login = await signIn(fake);
    await login.complete();
    const result = await login.attempt.result;
    if (!("credential" in result)) throw new Error("Missing credential");
    const c = f.proxy.registry.createConnection({
      kind: "claude-plan",
      label: "Claude plan",
    });
    f.proxy.credentials.put(c.id, result.credential, null);
    f.proxy.registry.updateConnection(c.id, {
      state: "ready",
      hasCredential: true,
      account: claudeAccount(result.credential),
    });
    const route = f.route(c.id, "claude-plan/test");
    const started = await f.start({
      routeAlias: route.alias,
      prompt: "Fix addition",
      processes: containedChecks,
      checks: containedChecks
        ? [
            {
              name: "math",
              argv: ["/bin/sh", "-c", "grep -q 'a + b' src/math.js"],
              timeoutMs: 20_000,
            },
          ]
        : [],
    });
    const final = await f.settle(started.attemptId);
    expect(final.state).toBe("completed");
    expect(final.candidateId).toBeTruthy();
    const requests = containedChecks ? 4 : 3;
    expect(final.requests).toBe(requests);
    const preview = await f.harness.applyPreview(started.attemptId);
    expect(preview.problems).toEqual([]);
    expect(
      await f.harness.apply(started.attemptId, preview.digest),
    ).toHaveProperty("applied");
    for (const call of f.upstream.calls) {
      expect(call.path).toBe("/anthropic/messages");
      expect(call.headers.authorization).toBe("Bearer synthetic-claude-access");
      expect(call.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
      expect(call.headers["x-api-key"]).toBeUndefined();
    }
    const receipts = f.proxy.registry.receipts({
      attemptId: started.attemptId,
    });
    expect(receipts).toHaveLength(requests);
    expect(
      receipts.every(
        (r) =>
          r.funding === "subscription" &&
          r.accountKey === "claude:account-1:org-1",
      ),
    ).toBe(true);
    expect(
      JSON.stringify(f.harness.events(started.attemptId, 0, 200)),
    ).not.toContain("synthetic-claude-access");
    f.proxy.registry.updateConnection(c.id, {
      account: {
        ...claudeAccount(result.credential),
        accountKey: "different-account",
      },
    });
    const refused = await f.proxy.infer({
      protocol: "messages",
      body: {
        model: route.alias,
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      },
      headers: { [routeHeaders.routeRevision]: route.revision },
      signal: new AbortController().signal,
    });
    expect(refused.status).toBe(409);
    expect(f.upstream.calls).toHaveLength(requests);
  });
});
