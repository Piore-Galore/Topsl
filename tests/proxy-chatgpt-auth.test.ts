import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProxyDatabase } from "../packages/proxy/database";
import {
  CredentialConflict,
  CredentialStore,
  keyFingerprint,
  type ApiKeyCredential,
  type ChatGptCredential,
} from "../packages/proxy/credentials";
import { JwksCache, JwtError, verifyJwt } from "../packages/proxy/jwt";
import {
  CHATGPT_SCOPES,
  DYNAMIC_CLIENT_ID,
  PLAN_USE_SCOPE,
  RefreshError,
  beginChatGptSignIn,
  chatGptAuthorizeUrl,
  pkceChallenge,
  refreshChatGpt,
  refreshStoredChatGpt,
  revokeChatGpt,
  type ChatGptAuthConfig,
  type SignInAttempt,
  type SignInResult,
} from "../packages/proxy/oauth/chatgpt";

/**
 * The ChatGPT plan sign-in (docs/Native_Harness_Plan.md §2) against a fake
 * authorization server on 127.0.0.1. The fake serves discovery, a JWKS, a
 * PKCE-checking token endpoint with rotating refresh tokens, and revocation.
 * The browser is simulated by requesting the attempt's redirect URI.
 */

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "fake-key-1";

function signJwt(
  claims: Record<string, unknown>,
  key: KeyObject,
  header: Record<string, unknown> = { alg: "RS256", kid },
): string {
  const input = `${Buffer.from(JSON.stringify({ typ: "JWT", ...header })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const signature =
    header.alg === "ES256"
      ? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
      : sign("sha256", Buffer.from(input), key);
  return `${input}.${signature.toString("base64url")}`;
}

function secret(prefix: string): string {
  return `${prefix}-${randomBytes(18).toString("base64url")}`;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  sub: string;
  email: string;
  scopes: string[];
  idTokenOverrides: Record<string, unknown>;
  signingKey: KeyObject;
}

interface Issued {
  clientId: string;
  sub: string;
  email: string;
  scopes: string[];
  nonce: string;
}

class FakeAuthServer {
  readonly server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", this.base);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/openid-configuration")
        return json(200, {
          issuer: this.base,
          authorization_endpoint: `${this.base}/api/accounts/authorize`,
          token_endpoint: `${this.base}/api/accounts/oauth/token`,
          jwks_uri: `${this.base}/jwks`,
          revocation_endpoint: `${this.base}/oauth/revoke`,
        });
      if (url.pathname === "/jwks")
        return json(200, {
          keys: [
            {
              ...rsa.publicKey.export({ format: "jwk" }),
              kid,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      if (
        url.pathname === "/api/accounts/oauth/token" &&
        req.method === "POST"
      ) {
        this.tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code")
          return this.exchange(form, json);
        if (form.get("grant_type") === "refresh_token")
          return this.refresh(form, json);
        return json(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/oauth/revoke" && req.method === "POST") {
        this.revocations.push(form);
        return json(this.revokeStatus, undefined);
      }
      json(404, { error: "not_found" });
    });
  });
  base = "";
  readonly tokenRequests: URLSearchParams[] = [];
  readonly revocations: URLSearchParams[] = [];
  readonly codes = new Map<string, Grant>();
  readonly refreshTokens = new Map<string, Issued>();
  /** Every access, refresh and ID token the fake has issued. */
  readonly issuedSecrets: string[] = [];
  refreshFailure: { status: number; body?: unknown } | null = null;
  refreshScopes: string[] | null = null;
  refreshIdToken: { sub?: string } | null = null;
  revokeStatus = 200;
  private clients = 0;

  async start(): Promise<this> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /**
   * Plays the provider's consent screen: binds a single-use code to the
   * authorize request's client, redirect URI, PKCE challenge and nonce.
   */
  authorize(
    authorizeUrl: string,
    options: {
      sub?: string;
      email?: string;
      scopes?: string[];
      idTokenOverrides?: Record<string, unknown>;
      signingKey?: KeyObject;
    } = {},
  ) {
    const params = new URL(authorizeUrl).searchParams;
    const requested = params.get("client_id")!;
    const clientId =
      requested === DYNAMIC_CLIENT_ID ? `oaiapp_${++this.clients}` : requested;
    const code = secret("code");
    this.codes.set(code, {
      clientId,
      redirectUri: params.get("redirect_uri")!,
      challenge: params.get("code_challenge")!,
      nonce: params.get("nonce")!,
      sub: options.sub ?? "user-1",
      email: options.email ?? "person@example.com",
      scopes: options.scopes ?? [...CHATGPT_SCOPES],
      idTokenOverrides: options.idTokenOverrides ?? {},
      signingKey: options.signingKey ?? rsa.privateKey,
    });
    return {
      code,
      clientId,
      state: params.get("state")!,
      redirectUri: params.get("redirect_uri")!,
      params,
    };
  }

  private idToken(
    claims: Record<string, unknown>,
    key: KeyObject = rsa.privateKey,
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(
      { iss: this.base, iat: now, exp: now + 3600, ...claims },
      key,
    );
    this.issuedSecrets.push(token);
    return token;
  }

  private tokens(issued: Issued, idToken: string | null) {
    const accessToken = secret("access");
    const refreshToken = secret("refresh");
    this.issuedSecrets.push(accessToken, refreshToken);
    this.refreshTokens.set(refreshToken, issued);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(idToken ? { id_token: idToken } : {}),
      token_type: "Bearer",
      expires_in: 3600,
      scope: issued.scopes.join(" "),
      earliest_refresh_at: Math.floor(Date.now() / 1000) + 1800,
    };
  }

  private exchange(
    form: URLSearchParams,
    json: (status: number, body: unknown) => void,
  ) {
    const grant = this.codes.get(form.get("code") ?? "");
    if (!grant) return json(400, { error: "invalid_grant" });
    this.codes.delete(form.get("code")!);
    const verifier = form.get("code_verifier") ?? "";
    if (
      form.has("client_secret") ||
      form.get("client_id") !== grant.clientId ||
      form.get("redirect_uri") !== grant.redirectUri ||
      form.get("resource") !== "https://api.openai.com/v1" ||
      pkceChallenge(verifier) !== grant.challenge
    )
      return json(400, { error: "invalid_grant" });
    const issued: Issued = {
      clientId: grant.clientId,
      sub: grant.sub,
      email: grant.email,
      scopes: grant.scopes,
      nonce: grant.nonce,
    };
    const idToken = this.idToken(
      {
        sub: grant.sub,
        aud: grant.clientId,
        email: grant.email,
        nonce: grant.nonce,
        ...grant.idTokenOverrides,
      },
      grant.signingKey,
    );
    json(200, this.tokens(issued, idToken));
  }

  private refresh(
    form: URLSearchParams,
    json: (status: number, body: unknown) => void,
  ) {
    if (this.refreshFailure)
      return json(this.refreshFailure.status, this.refreshFailure.body);
    const issued = this.refreshTokens.get(form.get("refresh_token") ?? "");
    if (
      !issued ||
      form.has("scope") ||
      form.get("client_id") !== issued.clientId ||
      form.get("resource") !== "https://api.openai.com/v1"
    )
      return json(400, { error: "invalid_grant" });
    // Rotation: the spent refresh token stops working.
    this.refreshTokens.delete(form.get("refresh_token")!);
    const next = { ...issued, scopes: this.refreshScopes ?? issued.scopes };
    const idToken = this.refreshIdToken
      ? this.idToken({
          sub: this.refreshIdToken.sub ?? issued.sub,
          aud: issued.clientId,
          email: "renewed@example.com",
        })
      : null;
    json(200, this.tokens(next, idToken));
  }
}

/** Simulates the browser following the provider's redirect. */
async function browse(
  redirectUri: string,
  query: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `${redirectUri}?${new URLSearchParams(query).toString()}`,
  );
  return { status: response.status, text: await response.text() };
}

async function listenerClosed(redirectUri: string): Promise<boolean> {
  try {
    await fetch(redirectUri);
    return false;
  } catch {
    return true;
  }
}

function signedIn(result: SignInResult): ChatGptCredential {
  if (result.outcome !== "signed-in" && result.outcome !== "plan-use-disabled")
    throw new Error(`Expected a sign-in, got ${JSON.stringify(result)}`);
  return result.credential;
}

let fake: FakeAuthServer;
let config: ChatGptAuthConfig;
let directory: string;
let db: ProxyDatabase;
let store: CredentialStore;
const hostId = "urn:uuid:00000000-0000-4000-8000-000000000001";
const attempts: SignInAttempt[] = [];

async function begin(
  options: Partial<Parameters<typeof beginChatGptSignIn>[1]> = {},
  overrides: ChatGptAuthConfig = {},
): Promise<SignInAttempt> {
  const attempt = await beginChatGptSignIn(
    { ...config, ...overrides },
    { hostId, ...options },
  );
  attempts.push(attempt);
  return attempt;
}

/** Signs in once and returns the stored credential. */
async function firstSignIn(): Promise<ChatGptCredential> {
  const attempt = await begin();
  const grant = fake.authorize(attempt.authorizeUrl);
  await browse(attempt.redirectUri, {
    code: grant.code,
    state: grant.state,
    client_id: grant.clientId,
  });
  return signedIn(await attempt.result);
}

beforeEach(async () => {
  fake = await new FakeAuthServer().start();
  config = { issuer: fake.base, preferredPort: 0 };
  directory = await mkdtemp(path.join(os.tmpdir(), "topsl-test-proxy-auth-"));
  db = new ProxyDatabase(
    path.join(directory, "proxy.sqlite"),
    randomBytes(32).toString("hex"),
  );
  store = new CredentialStore(db);
});

afterEach(async () => {
  for (const attempt of attempts.splice(0)) attempt.cancel();
  await fake.stop();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("ChatGPT sign-in", () => {
  it("completes a first registration with the documented parameters", async () => {
    const attempt = await begin();
    const url = new URL(attempt.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${fake.base}/api/accounts/authorize`,
    );
    const params = url.searchParams;
    expect([...params.keys()]).toEqual([
      "client_id",
      "agent_name_hint",
      "ext_agent_host_id",
      "response_type",
      "redirect_uri",
      "scope",
      "resource",
      "state",
      "nonce",
      "code_challenge_method",
      "code_challenge",
    ]);
    expect(params.get("client_id")).toBe(DYNAMIC_CLIENT_ID);
    expect(params.get("agent_name_hint")).toBe("Topsl");
    expect(params.get("ext_agent_host_id")).toBe(hostId);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("redirect_uri")).toBe(attempt.redirectUri);
    expect(attempt.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(params.get("scope")).toBe(
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    );
    expect(attempt.authorizeUrl).toContain(
      "scope=openid%20profile%20email%20offline_access%20resource.invoke%20chatgpt.tokens.use.direct",
    );
    expect(params.get("resource")).toBe("https://api.openai.com/v1");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A second attempt gets fresh state, nonce and verifier.
    const second = new URL((await begin()).authorizeUrl).searchParams;
    for (const name of ["state", "nonce", "code_challenge"])
      expect(second.get(name)).not.toBe(params.get(name));

    const grant = fake.authorize(attempt.authorizeUrl, {
      sub: "user-42",
      email: "person@example.com",
    });
    const page = await browse(attempt.redirectUri, {
      code: grant.code,
      state: grant.state,
      client_id: grant.clientId,
    });
    expect(page.status).toBe(200);
    expect(page.text).toContain("signed in");
    const result = await attempt.result;
    expect(result.outcome).toBe("signed-in");
    const credential = signedIn(result);
    expect(result).toMatchObject({ planUse: true });
    expect(credential).toMatchObject({
      kind: "oauth-chatgpt",
      clientId: grant.clientId,
      extAgentHostId: hostId,
      issuer: fake.base,
      subject: "user-42",
      email: "person@example.com",
      tokenType: "Bearer",
      scopes: [...CHATGPT_SCOPES],
    });
    expect(credential.clientId).toMatch(/^oaiapp_/);
    expect(credential.refreshToken).toBeTruthy();
    expect(credential.earliestRefreshAt).not.toBeNull();
    expect(Date.parse(credential.expiresAt) - Date.now()).toBeGreaterThan(
      3500_000,
    );
    for (const token of [
      credential.accessToken,
      credential.refreshToken!,
      credential.idToken,
      grant.code,
    ])
      expect(page.text).not.toContain(token);

    expect(fake.tokenRequests).toHaveLength(1);
    const exchange = fake.tokenRequests[0]!;
    expect([...exchange.keys()].sort()).toEqual(
      [
        "client_id",
        "code",
        "code_verifier",
        "grant_type",
        "redirect_uri",
        "resource",
      ].sort(),
    );
    expect(exchange.get("client_id")).toBe(grant.clientId);
    expect(exchange.get("redirect_uri")).toBe(attempt.redirectUri);
    expect(pkceChallenge(exchange.get("code_verifier")!)).toBe(
      params.get("code_challenge"),
    );
    expect(
      createHash("sha256")
        .update(exchange.get("code_verifier")!)
        .digest("base64url"),
    ).toBe(params.get("code_challenge"));

    expect(await listenerClosed(attempt.redirectUri)).toBe(true);

    // The credential round-trips through the encrypted store.
    const revision = store.put("conn-1", credential, null);
    expect(store.get("conn-1")).toEqual({ revision, credential });
  });

  it("fails a registration whose callback lacks an issued client ID", async () => {
    for (const clientId of [null, DYNAMIC_CLIENT_ID]) {
      const attempt = await begin();
      const grant = fake.authorize(attempt.authorizeUrl);
      const page = await browse(attempt.redirectUri, {
        code: grant.code,
        state: grant.state,
        ...(clientId ? { client_id: clientId } : {}),
      });
      expect(page.status).toBe(400);
      const result = await attempt.result;
      expect(result).toEqual({
        outcome: "failed",
        error: expect.stringContaining("registration is incomplete"),
      });
    }
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("ignores callbacks with a wrong or missing state and completes on the valid one", async () => {
    const attempt = await begin();
    let settled = false;
    void attempt.result.then(() => (settled = true));
    const grant = fake.authorize(attempt.authorizeUrl);
    const forged = await browse(attempt.redirectUri, {
      code: grant.code,
      state: "not-the-state",
      client_id: grant.clientId,
    });
    expect(forged.status).toBe(400);
    const missing = await browse(attempt.redirectUri, {
      code: grant.code,
      client_id: grant.clientId,
    });
    expect(missing.status).toBe(400);
    const doubled = await fetch(
      `${attempt.redirectUri}?state=${grant.state}&state=other&code=${grant.code}`,
    );
    expect(doubled.status).toBe(400);
    const deniedForged = await browse(attempt.redirectUri, {
      error: "access_denied",
      state: "not-the-state",
    });
    expect(deniedForged.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(fake.tokenRequests).toHaveLength(0);

    const page = await browse(attempt.redirectUri, {
      code: grant.code,
      state: grant.state,
      client_id: grant.clientId,
    });
    expect(page.status).toBe(200);
    expect((await attempt.result).outcome).toBe("signed-in");
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it("only serves GET /auth/callback", async () => {
    const attempt = await begin();
    const origin = new URL(attempt.redirectUri).origin;
    expect((await fetch(`${origin}/`)).status).toBe(404);
    expect((await fetch(`${origin}/auth/other`)).status).toBe(404);
    expect(
      (await fetch(attempt.redirectUri, { method: "POST", body: "x" })).status,
    ).toBe(405);
  });

  it("reports access_denied as declined without requesting a token", async () => {
    const attempt = await begin();
    const state = new URL(attempt.authorizeUrl).searchParams.get("state")!;
    const page = await browse(attempt.redirectUri, {
      error: "access_denied",
      state,
    });
    expect(page.status).toBe(200);
    expect(await attempt.result).toEqual({ outcome: "declined" });
    expect(fake.tokenRequests).toHaveLength(0);
    expect(await listenerClosed(attempt.redirectUri)).toBe(true);
  });

  it.each([
    [
      "a nonce mismatch",
      { idTokenOverrides: { nonce: "other-nonce" } },
      "does not belong to this sign-in attempt",
    ],
    [
      "a wrong audience",
      { idTokenOverrides: { aud: "oaiapp_someone_else" } },
      "issued to a different client",
    ],
    [
      "an audience list without the client",
      { idTokenOverrides: { aud: ["x", "y"] } },
      "issued to a different client",
    ],
    [
      "a different authorized party",
      { idTokenOverrides: { azp: "oaiapp_other" } },
      "authorized for a different client",
    ],
    [
      "an expired token",
      { idTokenOverrides: { exp: Math.floor(Date.now() / 1000) - 600 } },
      "has expired",
    ],
    [
      "a token not valid yet",
      { idTokenOverrides: { nbf: Math.floor(Date.now() / 1000) + 600 } },
      "not valid yet",
    ],
    [
      "a wrong issuer",
      { idTokenOverrides: { iss: "https://evil.example" } },
      "issued by a different provider",
    ],
    [
      "a bad signature",
      { signingKey: otherRsa.privateKey },
      "signature does not match",
    ],
  ])("fails on %s in the ID token", async (_name, options, reason) => {
    const attempt = await begin();
    const grant = fake.authorize(attempt.authorizeUrl, options);
    await browse(attempt.redirectUri, {
      code: grant.code,
      state: grant.state,
      client_id: grant.clientId,
    });
    const result = await attempt.result;
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.error).toContain("identity token was not accepted");
    expect(result.error).toContain(reason);
    for (const token of fake.issuedSecrets)
      expect(result.error).not.toContain(token);
    expect(result.error).not.toContain(grant.code);
  });

  it("accepts an audience list that includes the client", async () => {
    const attempt = await begin();
    const params = new URL(attempt.authorizeUrl).searchParams;
    expect(params.get("client_id")).toBe(DYNAMIC_CLIENT_ID);
    const grant = fake.authorize(attempt.authorizeUrl, {
      idTokenOverrides: {
        aud: ["oaiapp_1", "https://api.openai.com/v1"],
        azp: "oaiapp_1",
      },
    });
    expect(grant.clientId).toBe("oaiapp_1");
    await browse(attempt.redirectUri, {
      code: grant.code,
      state: grant.state,
      client_id: grant.clientId,
    });
    expect((await attempt.result).outcome).toBe("signed-in");
  });

  it("keeps the sign-in but disables plan use without chatgpt.tokens.use.direct", async () => {
    const attempt = await begin();
    const grant = fake.authorize(attempt.authorizeUrl, {
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "resource.invoke",
      ],
    });
    const page = await browse(attempt.redirectUri, {
      code: grant.code,
      state: grant.state,
      client_id: grant.clientId,
    });
    expect(page.text).toContain("did not allow Topsl to use your plan");
    const result = await attempt.result;
    expect(result.outcome).toBe("plan-use-disabled");
    expect(result).toMatchObject({ planUse: false });
    expect(signedIn(result).scopes).not.toContain(PLAN_USE_SCOPE);
  });

  it("reauthorizes with the saved client ID and no agent name hint", async () => {
    const first = await firstSignIn();
    const registration = {
      clientId: first.clientId,
      subject: first.subject,
      email: first.email,
      idToken: first.idToken,
    };

    const attempt = await begin({
      registration,
      loginHint: "person@example.com",
    });
    const params = new URL(attempt.authorizeUrl).searchParams;
    expect(params.get("client_id")).toBe(first.clientId);
    expect(params.has("agent_name_hint")).toBe(false);
    expect(params.get("ext_agent_host_id")).toBe(hostId);
    expect(params.get("id_token_hint")).toBe(first.idToken);
    expect(params.get("login_hint")).toBe("person@example.com");

    // The callback may omit client_id on reauthorization.
    const grant = fake.authorize(attempt.authorizeUrl, { sub: first.subject });
    expect(grant.clientId).toBe(first.clientId);
    await browse(attempt.redirectUri, { code: grant.code, state: grant.state });
    const credential = signedIn(await attempt.result);
    expect(credential.clientId).toBe(first.clientId);
    expect(credential.subject).toBe(first.subject);
    expect(credential.accessToken).not.toBe(first.accessToken);
    expect(fake.tokenRequests.at(-1)!.get("client_id")).toBe(first.clientId);
  });

  it("refuses a reauthorization callback that names a different client ID", async () => {
    const attempt = await begin({
      registration: {
        clientId: "oaiapp_saved",
        subject: "user-1",
        email: null,
        idToken: null,
      },
    });
    const grant = fake.authorize(attempt.authorizeUrl);
    await browse(attempt.redirectUri, {
      code: grant.code,
      state: grant.state,
      client_id: "oaiapp_other",
    });
    expect(await attempt.result).toEqual({
      outcome: "failed",
      error: expect.stringContaining("different registered client"),
    });
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refuses a reauthorization that signs in to a different account", async () => {
    const first = await firstSignIn();
    const attempt = await begin({
      registration: {
        clientId: first.clientId,
        subject: first.subject,
        email: first.email,
        idToken: first.idToken,
      },
    });
    const grant = fake.authorize(attempt.authorizeUrl, { sub: "user-2" });
    await browse(attempt.redirectUri, { code: grant.code, state: grant.state });
    expect(await attempt.result).toEqual({
      outcome: "failed",
      error: expect.stringContaining("different ChatGPT account"),
    });
  });

  it("rejects dynamic_agent_client as a saved client ID", async () => {
    await expect(
      begin({
        registration: {
          clientId: DYNAMIC_CLIENT_ID,
          subject: "user-1",
          email: null,
          idToken: null,
        },
      }),
    ).rejects.toThrow("no issued client ID");
    expect(() =>
      chatGptAuthorizeUrl(config, {
        hostId,
        redirectUri: "http://localhost:1455/auth/callback",
        state: "s",
        nonce: "n",
        codeChallenge: "c",
      }),
    ).toThrow("127.0.0.1");
  });

  it("times out and can be cancelled, closing the listener", async () => {
    const timed = await begin({ timeoutMs: 50 });
    expect(await timed.result).toEqual({ outcome: "timed-out" });
    expect(await listenerClosed(timed.redirectUri)).toBe(true);

    const cancelled = await begin();
    cancelled.cancel();
    expect(await cancelled.result).toEqual({ outcome: "cancelled" });
    expect(await listenerClosed(cancelled.redirectUri)).toBe(true);
  });

  it("falls back to a free port when the preferred one is busy", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const attempt = await begin({}, { preferredPort: busy });
      const port = Number(new URL(attempt.redirectUri).port);
      expect(port).not.toBe(busy);
      expect(port).toBeGreaterThan(0);
      const grant = fake.authorize(attempt.authorizeUrl);
      await browse(attempt.redirectUri, {
        code: grant.code,
        state: grant.state,
        client_id: grant.clientId,
      });
      expect((await attempt.result).outcome).toBe("signed-in");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }

    // A free preferred port is used as is.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const free = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const attempt = await begin({}, { preferredPort: free });
    expect(attempt.redirectUri).toBe(`http://127.0.0.1:${free}/auth/callback`);
  });
});

describe("ChatGPT refresh", () => {
  it("replaces every token field together and rotates the refresh token", async () => {
    const first = await firstSignIn();
    let clock = Date.now() + 30 * 60 * 1000;
    const later: ChatGptAuthConfig = { ...config, now: () => clock };
    fake.refreshScopes = ["openid", "offline_access", "resource.invoke"];
    const next = await refreshChatGpt(later, first);
    const request = fake.tokenRequests.at(-1)!;
    expect(Object.fromEntries(request)).toEqual({
      grant_type: "refresh_token",
      client_id: first.clientId,
      refresh_token: first.refreshToken,
      resource: "https://api.openai.com/v1",
    });
    expect(next.accessToken).not.toBe(first.accessToken);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(next.refreshToken).toBeTruthy();
    expect(next.expiresAt).toBe(new Date(clock + 3600_000).toISOString());
    expect(next.scopes).toEqual([
      "openid",
      "offline_access",
      "resource.invoke",
    ]);
    expect(next.earliestRefreshAt).not.toBeNull();
    expect(next.savedAt).toBe(new Date(clock).toISOString());
    expect(next).toMatchObject({
      clientId: first.clientId,
      subject: first.subject,
      idToken: first.idToken,
      issuer: first.issuer,
    });

    // The spent refresh token no longer works, which is terminal.
    clock += 1000;
    const reused = await refreshChatGpt(later, first).catch((error) => error);
    expect(reused).toBeInstanceOf(RefreshError);
    expect(reused).toMatchObject({
      terminal: true,
      kind: "sign-in-required",
      code: "invalid_grant",
      status: 400,
    });
    // The rotated one does.
    expect((await refreshChatGpt(later, next)).accessToken).toBeTruthy();
  });

  it("accepts a renewed ID token for the same account and refuses another account", async () => {
    const first = await firstSignIn();
    fake.refreshIdToken = {};
    const next = await refreshChatGpt(config, first);
    expect(next.idToken).not.toBe(first.idToken);
    expect(next.email).toBe("renewed@example.com");

    fake.refreshIdToken = { sub: "user-2" };
    const error = await refreshChatGpt(config, next).catch((e) => e);
    expect(error).toBeInstanceOf(RefreshError);
    expect(error).toMatchObject({ terminal: true, code: "identity_changed" });
  });

  it.each([
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ])("treats %s as terminal", async (code) => {
    const first = await firstSignIn();
    fake.refreshFailure = { status: 400, body: { error: code } };
    const error = await refreshChatGpt(config, first).catch((e) => e);
    expect(error).toBeInstanceOf(RefreshError);
    expect(error).toMatchObject({
      terminal: true,
      kind: "sign-in-required",
      code,
      status: 400,
    });
    expect(error.message).not.toContain(first.refreshToken);
  });

  it("separates configuration, transient and unknown refresh failures", async () => {
    const first = await firstSignIn();
    const secrets = [first.accessToken, first.refreshToken!, first.idToken];
    const failures: [
      { status: number; body?: unknown },
      Partial<RefreshError>,
    ][] = [
      [
        { status: 401, body: { error: "invalid_client" } },
        { terminal: true, kind: "client-rejected", code: "invalid_client" },
      ],
      [{ status: 503 }, { terminal: false, kind: "transient", status: 503 }],
      [
        { status: 500, body: { error: "server_error" } },
        { terminal: false, kind: "transient", code: "server_error" },
      ],
      [
        { status: 429, body: { error: { code: "rate_limited" } } },
        { terminal: false, kind: "transient", code: "rate_limited" },
      ],
      [
        { status: 400, body: { error: "invalid_request" } },
        { terminal: false, kind: "rejected", code: "invalid_request" },
      ],
      [
        { status: 200, body: { token_type: "Bearer" } },
        { terminal: false, kind: "transient", code: "invalid_response" },
      ],
    ];
    for (const [failure, expected] of failures) {
      fake.refreshFailure = failure;
      const error = await refreshChatGpt(config, first).catch((e) => e);
      expect(error).toBeInstanceOf(RefreshError);
      expect(error).toMatchObject(expected);
      for (const token of secrets) {
        expect(error.message).not.toContain(token);
        expect(JSON.stringify(error)).not.toContain(token);
      }
    }

    const offline: ChatGptAuthConfig = {
      ...config,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const network = await refreshChatGpt(offline, first).catch((e) => e);
    expect(network).toMatchObject({
      terminal: false,
      kind: "transient",
      code: null,
      status: null,
    });

    const noRefresh = await refreshChatGpt(config, {
      ...first,
      refreshToken: null,
    }).catch((e) => e);
    expect(noRefresh).toMatchObject({
      terminal: true,
      code: "no_refresh_token",
    });

    const otherIssuer = await refreshChatGpt(
      { ...config, issuer: "https://auth.example" },
      first,
    ).catch((e) => e);
    expect(otherIssuer).toMatchObject({
      terminal: false,
      code: "issuer_mismatch",
    });
  });

  it("serializes withLock callers per connection", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = store.withLock("conn-1", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
      throw new Error("first failed");
    });
    const second = store.withLock("conn-1", async () => {
      order.push("second");
      return 2;
    });
    const other = store.withLock("conn-2", async () => {
      order.push("other");
      return 3;
    });
    expect(await other).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first:start", "other"]);
    releaseFirst();
    await expect(first).rejects.toThrow("first failed");
    expect(await second).toBe(2);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });

  it("never races a rotating refresh token between concurrent refreshes", async () => {
    const credential = await firstSignIn();
    const revision = store.put("conn-1", credential, null);
    const before = fake.tokenRequests.length;

    // Two callers saw the same expiring revision: only one refresh is sent.
    const [a, b] = await Promise.all([
      refreshStoredChatGpt(config, store, "conn-1", { seenRevision: revision }),
      refreshStoredChatGpt(config, store, "conn-1", { seenRevision: revision }),
    ]);
    expect(fake.tokenRequests.length - before).toBe(1);
    expect(a).toEqual(b);
    expect(a.revision).toBe(revision + 1);

    // Unconditional refreshes queue; the second spends the rotated token.
    const [c, d] = await Promise.all([
      refreshStoredChatGpt(config, store, "conn-1"),
      refreshStoredChatGpt(config, store, "conn-1"),
    ]);
    const spent = fake.tokenRequests
      .slice(-2)
      .map((request) => request.get("refresh_token"));
    expect(spent).toEqual([
      a.credential.refreshToken,
      c.credential.refreshToken,
    ]);
    expect(d.revision).toBe(c.revision + 1);
    expect(store.get("conn-1")).toEqual(d);
  });
});

describe("Credential store", () => {
  it("writes only when the expected revision matches", () => {
    const key: ApiKeyCredential = {
      kind: "api-key",
      key: "sk-test-secret-value",
      fingerprint: keyFingerprint("sk-test-secret-value"),
      savedAt: new Date().toISOString(),
    };
    expect(key.fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(key.fingerprint).not.toContain("secret");
    expect(store.get("conn-1")).toBeNull();
    expect(store.put("conn-1", key, null)).toBe(1);

    const conflict = (() => {
      try {
        store.put("conn-1", key, null);
      } catch (error) {
        return error;
      }
    })();
    expect(conflict).toBeInstanceOf(CredentialConflict);
    expect(conflict).toMatchObject({
      expectedRevision: null,
      actualRevision: 1,
    });
    expect((conflict as Error).message).not.toContain(key.key);

    const rotated = { ...key, key: "sk-test-rotated" };
    expect(store.put("conn-1", rotated, 1)).toBe(2);
    expect(() => store.put("conn-1", key, 1)).toThrow(CredentialConflict);
    expect(() => store.put("conn-2", key, 1)).toThrow(CredentialConflict);
    expect(store.get("conn-1")).toEqual({ revision: 2, credential: rotated });

    store.delete("conn-1");
    expect(store.get("conn-1")).toBeNull();
    expect(store.put("conn-1", key, null)).toBe(1);
  });
});

describe("ChatGPT revocation", () => {
  it("confirms an HTTP 200 and sends the refresh token with the client ID", async () => {
    const credential = await firstSignIn();
    const result = await revokeChatGpt(config, credential);
    expect(result.confirmed).toBe(true);
    expect(Object.fromEntries(fake.revocations[0]!)).toEqual({
      token: credential.refreshToken,
      token_type_hint: "refresh_token",
      client_id: credential.clientId,
    });
  });

  it("reports 5xx and network failures as not confirmed", async () => {
    const credential = await firstSignIn();
    const secrets = [credential.accessToken, credential.refreshToken!];
    fake.revokeStatus = 503;
    const unavailable = await revokeChatGpt(config, credential);
    expect(unavailable.confirmed).toBe(false);
    expect(unavailable.detail).toContain("not confirmed");
    expect(unavailable.detail).toContain("503");

    const offline = await revokeChatGpt(
      {
        ...config,
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      },
      credential,
    );
    expect(offline.confirmed).toBe(false);
    expect(offline.detail).toContain("not confirmed");
    for (const token of secrets) {
      expect(unavailable.detail).not.toContain(token);
      expect(offline.detail).not.toContain(token);
    }
  });
});

describe("JWT verification", () => {
  const issuer = "https://issuer.example";
  const jwksFor = (keys: unknown[]) =>
    new JwksCache("https://issuer.example/jwks", {
      fetch: async () =>
        new Response(JSON.stringify({ keys }), {
          headers: { "content-type": "application/json" },
        }),
    });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, sub: "user-1", aud: "client", exp: now + 600 };

  it("verifies ES256 signatures", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwks = jwksFor([
      { ...ec.publicKey.export({ format: "jwk" }), kid: "ec-1", alg: "ES256" },
    ]);
    const token = signJwt(claims, ec.privateKey, { alg: "ES256", kid: "ec-1" });
    await expect(
      verifyJwt(token, { jwks, issuer, audience: "client" }),
    ).resolves.toMatchObject({ sub: "user-1" });
  });

  it("rejects unsigned tokens, unknown keys and short RSA keys", async () => {
    const jwks = jwksFor([
      { ...rsa.publicKey.export({ format: "jwk" }), kid, alg: "RS256" },
    ]);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    await expect(
      verifyJwt(unsigned, { jwks, issuer, audience: "client" }),
    ).rejects.toBeInstanceOf(JwtError);
    const unknown = signJwt(claims, rsa.privateKey, {
      alg: "RS256",
      kid: "nope",
    });
    await expect(
      verifyJwt(unknown, { jwks, issuer, audience: "client" }),
    ).rejects.toMatchObject({ code: "unknown-key" });

    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const weakJwks = jwksFor([
      { ...weak.publicKey.export({ format: "jwk" }), kid: "weak" },
    ]);
    const weakToken = signJwt(claims, weak.privateKey, {
      alg: "RS256",
      kid: "weak",
    });
    await expect(
      verifyJwt(weakToken, { jwks: weakJwks, issuer, audience: "client" }),
    ).rejects.toMatchObject({ code: "unknown-key" });
  });
});
