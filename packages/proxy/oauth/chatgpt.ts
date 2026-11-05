import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatGptCredential, CredentialStore } from "../credentials";
import { JwtError, OidcProvider, decodeJwt, type JwtClaims } from "../jwt";

/**
 * ChatGPT plan sign-in for the local proxy (docs/Native_Harness_Plan.md §2,
 * "Subscription adapters"), following OpenAI's "Sign in with ChatGPT —
 * ChatGPT plan usage for open-source apps" flow
 * (https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
 * dynamic client registration on first sign-in, PKCE (S256), state and nonce
 * checks, ID token validation, granted-scope checks, rotating refresh and
 * revocation.
 *
 * Nothing here logs, and no thrown error or result message quotes a code,
 * token or verifier. The browser only ever sees short static pages.
 */

/** The client ID a first registration authorizes with; never stored. */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** The scope that lets Topsl use the person's ChatGPT plan for inference. */
export const PLAN_USE_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  PLAN_USE_SCOPE,
] as const;
const defaultIssuer = "https://auth.openai.com";
const defaultResource = "https://api.openai.com/v1";
const defaultTimeoutMs = 10 * 60 * 1000;
const requestTimeoutMs = 30_000;

export interface ChatGptAuthConfig {
  /** Defaults to https://auth.openai.com. */
  issuer?: string;
  /** Defaults to `<issuer>/api/accounts/authorize`. */
  authorizeUrl?: string;
  /** Defaults to `<issuer>/api/accounts/oauth/token`. */
  tokenUrl?: string;
  /** Defaults to https://api.openai.com/v1. */
  resource?: string;
  /** Shown to the person at first registration; defaults to "Topsl". */
  agentName?: string;
  /** Loopback port to try first; defaults to 1455. 0 picks any free port. */
  preferredPort?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ResolvedConfig {
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  resource: string;
  agentName: string;
  preferredPort: number;
  fetch: typeof fetch;
  now: () => number;
}

function resolveConfig(config: ChatGptAuthConfig): ResolvedConfig {
  const issuer = (config.issuer ?? defaultIssuer).replace(/\/+$/, "");
  return {
    issuer,
    authorizeUrl: config.authorizeUrl ?? `${issuer}/api/accounts/authorize`,
    tokenUrl: config.tokenUrl ?? `${issuer}/api/accounts/oauth/token`,
    resource: config.resource ?? defaultResource,
    agentName: config.agentName ?? "Topsl",
    preferredPort: config.preferredPort ?? 1455,
    fetch: config.fetch ?? globalThis.fetch,
    now: config.now ?? Date.now,
  };
}

/**
 * Discovery documents and key sets are cached per config object, so a caller
 * that keeps one config reuses them, and separate configs (for example in
 * tests) never share keys.
 */
const providers = new WeakMap<ChatGptAuthConfig, OidcProvider>();
function providerFor(
  config: ChatGptAuthConfig,
  resolved: ResolvedConfig,
): OidcProvider {
  let provider = providers.get(config);
  if (!provider || provider.issuer !== resolved.issuer) {
    provider = new OidcProvider(resolved.issuer, {
      fetch: resolved.fetch,
      now: resolved.now,
      timeoutMs: requestTimeoutMs,
    });
    providers.set(config, provider);
  }
  return provider;
}

/** What a first registration leaves behind for later reauthorization. */
export interface Registration {
  clientId: string;
  subject: string;
  email: string | null;
  /** The last validated ID token, sent as `id_token_hint`. */
  idToken: string | null;
}

export type SignInResult =
  | { outcome: "signed-in"; credential: ChatGptCredential; planUse: true }
  | {
      outcome: "plan-use-disabled";
      credential: ChatGptCredential;
      planUse: false;
    }
  | { outcome: "declined" }
  | { outcome: "cancelled" }
  | { outcome: "timed-out" }
  | { outcome: "failed"; error: string };

export interface SignInAttempt {
  id: string;
  /** Open this in the person's browser; the listener is already running. */
  authorizeUrl: string;
  redirectUri: string;
  result: Promise<SignInResult>;
  cancel(): void;
}

/** Issued client IDs are opaque; this only rules out unusable values. */
function isIssuedClientId(value: string): boolean {
  return value !== DYNAMIC_CLIENT_ID && /^[A-Za-z0-9._~:-]{1,256}$/.test(value);
}

const redirectPattern = /^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\/callback$/;

export interface AuthorizeRequest {
  hostId: string;
  /** `http://127.0.0.1:<port>/auth/callback`; never `localhost`. */
  redirectUri: string;
  state: string;
  nonce: string;
  /** Unpadded base64url SHA-256 of the attempt's code verifier. */
  codeChallenge: string;
  /** The issued client ID; omit for a first registration. */
  clientId?: string | null;
  idTokenHint?: string | null;
  loginHint?: string | null;
}

/**
 * Builds the authorization URL exactly as the documented flow describes. A
 * first registration sends `dynamic_agent_client` with `agent_name_hint`;
 * reauthorization sends the issued client ID and no name hint. Values are
 * percent-encoded (spaces as %20) so every standard decoder reads the same
 * scope list.
 */
export function chatGptAuthorizeUrl(
  config: ChatGptAuthConfig,
  request: AuthorizeRequest,
): string {
  const resolved = resolveConfig(config);
  if (!redirectPattern.test(request.redirectUri))
    throw new Error(
      "The redirect URI must be http://127.0.0.1:<port>/auth/callback.",
    );
  if (!request.hostId) throw new Error("The host ID is missing.");
  const registering = !request.clientId;
  if (request.clientId && !isIssuedClientId(request.clientId))
    throw new Error("The saved client ID is not an issued client ID.");
  const parameters: [string, string][] = [
    ["client_id", request.clientId || DYNAMIC_CLIENT_ID],
  ];
  if (registering) parameters.push(["agent_name_hint", resolved.agentName]);
  parameters.push(["ext_agent_host_id", request.hostId]);
  if (request.idTokenHint)
    parameters.push(["id_token_hint", request.idTokenHint]);
  if (request.loginHint) parameters.push(["login_hint", request.loginHint]);
  parameters.push(
    ["response_type", "code"],
    ["redirect_uri", request.redirectUri],
    ["scope", CHATGPT_SCOPES.join(" ")],
    ["resource", resolved.resource],
    ["state", request.state],
    ["nonce", request.nonce],
    ["code_challenge_method", "S256"],
    ["code_challenge", request.codeChallenge],
  );
  const query = parameters
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  return `${resolved.authorizeUrl}${resolved.authorizeUrl.includes("?") ? "&" : "?"}${query}`;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** RFC 7636 §4.2: BASE64URL(SHA256(ASCII(code_verifier))), unpadded. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function sameSecret(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Error codes from the provider are echoed only when they look like codes. */
function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : null;
}

function errorCode(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  if (typeof body.error === "string") return safeCode(body.error);
  // Some OpenAI endpoints nest errors as { error: { code, type } }.
  if (typeof body.error === "object" && body.error !== null) {
    const nested = body.error as Record<string, unknown>;
    return safeCode(nested.code) ?? safeCode(nested.type);
  }
  return null;
}

interface FormResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * Posts a form to the provider. Redirects are refused, because following one
 * would resend the form, and with it a code or token, to another address.
 * Network failures reject; any HTTP answer resolves.
 */
async function postForm(
  resolved: ResolvedConfig,
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<FormResponse> {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const response = await resolved.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  tokenType: string | null;
  expiresIn: number | null;
  scopes: string[] | null;
  earliestRefreshAt: string | null;
}

/**
 * Reads `earliest_refresh_at`. The public documentation names the field but
 * not its format, so this accepts an ISO time, epoch seconds or milliseconds,
 * or (for small numbers) seconds from now. Unreadable values become null.
 */
function parseEarliestRefresh(value: unknown, now: number): string | null {
  if (value === undefined || value === null) return null;
  let ms: number | null = null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : null;
  if (numeric !== null && Number.isFinite(numeric)) {
    if (numeric >= 1e12) ms = numeric;
    else if (numeric >= 1e9) ms = numeric * 1000;
    else ms = now + numeric * 1000;
  } else if (typeof value === "string") {
    const parsed = Date.parse(value);
    ms = Number.isNaN(parsed) ? null : parsed;
  }
  return ms === null ? null : new Date(ms).toISOString();
}

/** Returns null when the response lacks an access token or has bad types. */
function parseTokenResponse(
  body: Record<string, unknown> | null,
  now: number,
): TokenResponse | null {
  if (!body || typeof body.access_token !== "string" || !body.access_token)
    return null;
  const optionalString = (name: string): string | null | undefined => {
    const value = body[name];
    if (value === undefined || value === null) return null;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const refreshToken = optionalString("refresh_token");
  const idToken = optionalString("id_token");
  const tokenType = optionalString("token_type");
  const scope = optionalString("scope");
  if (
    refreshToken === undefined ||
    idToken === undefined ||
    tokenType === undefined ||
    scope === undefined
  )
    return null;
  let expiresIn: number | null = null;
  if (body.expires_in !== undefined && body.expires_in !== null) {
    expiresIn = Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  }
  return {
    accessToken: body.access_token,
    refreshToken,
    idToken,
    tokenType,
    expiresIn,
    // RFC 6749 §5.1: an omitted scope means the requested scope was granted.
    scopes: scope === null ? null : scope.split(/\s+/).filter(Boolean),
    earliestRefreshAt: parseEarliestRefresh(body.earliest_refresh_at, now),
  };
}

/** The documented access token lifetime, used when `expires_in` is absent. */
const documentedLifetimeSeconds = 3600;

function expiresAt(now: number, expiresIn: number | null): string {
  return new Date(
    now + (expiresIn ?? documentedLifetimeSeconds) * 1000,
  ).toISOString();
}

type Page =
  SignInResult["outcome"] | "mismatch" | "finished" | "not-found" | "method";

const pageText: Record<Page, { status: number; title: string; body: string }> =
  {
    "signed-in": {
      status: 200,
      title: "Signed in",
      body: "Topsl is signed in to ChatGPT. You can close this tab and return to Topsl.",
    },
    "plan-use-disabled": {
      status: 200,
      title: "Signed in without plan use",
      body: "You signed in, but ChatGPT did not allow Topsl to use your plan. Return to Topsl for details.",
    },
    declined: {
      status: 200,
      title: "Sign-in declined",
      body: "Sign-in was declined. You can close this tab.",
    },
    cancelled: {
      status: 200,
      title: "Sign-in cancelled",
      body: "This sign-in was cancelled in Topsl. You can close this tab.",
    },
    "timed-out": {
      status: 408,
      title: "Sign-in timed out",
      body: "Topsl stopped waiting for this sign-in. Return to Topsl and try again.",
    },
    failed: {
      status: 400,
      title: "Sign-in did not finish",
      body: "Sign-in did not finish. Return to Topsl for details.",
    },
    mismatch: {
      status: 400,
      title: "Unexpected sign-in response",
      body: "This response does not match the sign-in Topsl is waiting for. Return to Topsl and try again.",
    },
    finished: {
      status: 409,
      title: "Sign-in already finished",
      body: "This sign-in has already finished. You can close this tab.",
    },
    "not-found": { status: 404, title: "Not found", body: "Not found." },
    method: { status: 405, title: "Not allowed", body: "Only GET is served." },
  };

/**
 * Answers the browser with a short static page. It carries no token
 * material, loads nothing, and sends no referrer, so the callback URL (which
 * holds the code) is not passed anywhere else.
 */
function respond(res: ServerResponse, page: Page): void {
  const { status, title, body } = pageText[page];
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${body}</p></body></html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(page === "method" ? { allow: "GET" } : {}),
    connection: "close",
  });
  res.end(html);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

/**
 * Binds the preferred port, or any free loopback port when it is taken. The
 * documented flow allows only the port to vary between sign-ins.
 */
async function bindLoopback(
  server: Server,
  preferred: number,
): Promise<number> {
  if (preferred !== 0) {
    try {
      return await listen(server, preferred);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    }
  }
  return listen(server, 0);
}

/**
 * Starts a ChatGPT sign-in. The loopback listener is running when this
 * resolves, so the caller can open `authorizeUrl` straight away.
 *
 * Without `registration` this is a first registration: the callback must
 * carry the newly issued client ID. With it, the saved client ID is reused,
 * a callback naming another client is refused, and the new ID token must name
 * the same account (`sub`) before any credential is returned.
 */
export async function beginChatGptSignIn(
  config: ChatGptAuthConfig,
  options: {
    hostId: string;
    registration?: Registration;
    loginHint?: string;
    timeoutMs?: number;
  },
): Promise<SignInAttempt> {
  const resolved = resolveConfig(config);
  const { registration } = options;
  if (!options.hostId) throw new Error("The host ID is missing.");
  if (registration && !isIssuedClientId(registration.clientId))
    throw new Error("The saved registration has no issued client ID.");
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();

  const server = createServer();
  const port = await bindLoopback(server, resolved.preferredPort);
  const host = `127.0.0.1:${port}`;
  const redirectUri = `http://${host}/auth/callback`;
  let authorizeUrl: string;
  try {
    authorizeUrl = chatGptAuthorizeUrl(config, {
      hostId: options.hostId,
      redirectUri,
      state,
      nonce,
      codeChallenge: pkceChallenge(verifier),
      clientId: registration?.clientId ?? null,
      idTokenHint: registration?.idToken ?? null,
      loginHint: options.loginHint ?? null,
    });
  } catch (error) {
    server.close();
    throw error;
  }

  let settled = false;
  let accepted = false;
  let resolveResult!: (result: SignInResult) => void;
  const result = new Promise<SignInResult>((resolve) => {
    resolveResult = resolve;
  });
  const abort = new AbortController();
  const shutdown = () => {
    // Every response says `connection: close`, so active sockets end after
    // their reply; idle ones are dropped now.
    server.close();
    server.closeIdleConnections();
  };
  const finish = (outcome: SignInResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult(outcome);
  };
  const timer = setTimeout(() => {
    finish({ outcome: "timed-out" });
    shutdown();
  }, options.timeoutMs ?? defaultTimeoutMs);
  const failed = (error: string): SignInResult => ({
    outcome: "failed",
    error,
  });

  /** Turns an accepted callback into a result; never throws. */
  const complete = async (query: URLSearchParams): Promise<SignInResult> => {
    // RFC 9207: when the provider names itself, it must be the one we asked.
    const iss = query.get("iss");
    if (iss !== null && iss !== resolved.issuer)
      return failed("The sign-in response came from a different provider.");
    const error = query.get("error");
    if (error !== null) {
      if (error === "access_denied") return { outcome: "declined" };
      const code = safeCode(error);
      return failed(
        `ChatGPT refused the sign-in${code ? ` (${code})` : ""}. Try again.`,
      );
    }
    const callbackClientId = query.get("client_id");
    let clientId: string;
    if (registration) {
      if (
        callbackClientId !== null &&
        callbackClientId !== registration.clientId
      )
        return failed(
          "The sign-in response names a different registered client than the one Topsl saved. Nothing was changed.",
        );
      clientId = registration.clientId;
    } else {
      if (callbackClientId === null || callbackClientId === DYNAMIC_CLIENT_ID)
        return failed(
          "ChatGPT did not issue a client ID, so registration is incomplete. Sign in again.",
        );
      if (!isIssuedClientId(callbackClientId))
        return failed("ChatGPT issued a client ID Topsl cannot use.");
      clientId = callbackClientId;
    }
    const code = query.get("code");
    if (!code) return failed("The sign-in response has no authorization code.");

    let response: FormResponse;
    try {
      response = await postForm(
        resolved,
        resolved.tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: resolved.resource,
        },
        abort.signal,
      );
    } catch {
      if (abort.signal.aborted) return { outcome: "cancelled" };
      return failed(
        "Topsl could not reach the ChatGPT sign-in service to finish signing in.",
      );
    }
    const now = resolved.now();
    if (response.status !== 200) {
      const code = errorCode(response.body);
      return failed(
        `ChatGPT did not accept the sign-in (HTTP ${response.status}${code ? `, ${code}` : ""}).`,
      );
    }
    const tokens = parseTokenResponse(response.body, now);
    if (!tokens || !tokens.idToken)
      return failed("ChatGPT's sign-in response was incomplete.");

    let claims: JwtClaims & { sub: string };
    try {
      claims = await providerFor(config, resolved).verifyIdToken(
        tokens.idToken,
        { audience: clientId, nonce },
      );
    } catch (error) {
      return failed(
        `ChatGPT's identity token was not accepted: ${error instanceof JwtError ? error.message : "it could not be verified."}`,
      );
    }
    if (registration && claims.sub !== registration.subject)
      return failed(
        "You signed in to a different ChatGPT account than the one this connection uses. Its credentials were not changed.",
      );
    const scopes = tokens.scopes ?? [...CHATGPT_SCOPES];
    const credential: ChatGptCredential = {
      kind: "oauth-chatgpt",
      clientId,
      extAgentHostId: options.hostId,
      issuer: resolved.issuer,
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType ?? "Bearer",
      expiresAt: expiresAt(now, tokens.expiresIn),
      earliestRefreshAt: tokens.earliestRefreshAt,
      scopes,
      savedAt: new Date(now).toISOString(),
    };
    return scopes.includes(PLAN_USE_SCOPE)
      ? { outcome: "signed-in", credential, planUse: true }
      : { outcome: "plan-use-disabled", credential, planUse: false };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // A page on another origin can reach a loopback port through DNS
    // rebinding; such requests carry a different Host header.
    if (req.headers.host !== host) return respond(res, "not-found");
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/auth/callback") return respond(res, "not-found");
    if (req.method !== "GET") return respond(res, "method");
    if (settled || accepted) return respond(res, "finished");
    const states = url.searchParams.getAll("state");
    // A wrong or missing state may be a stale tab or a forged request: answer
    // it, change nothing, and keep waiting for the real callback.
    if (states.length !== 1 || !sameSecret(states[0] ?? null, state))
      return respond(res, "mismatch");
    accepted = true;
    clearTimeout(timer);
    let outcome: SignInResult;
    try {
      outcome = await complete(url.searchParams);
    } catch {
      outcome = failed("Sign-in did not finish because of an internal error.");
    }
    if (settled) {
      respond(res, "cancelled");
      return;
    }
    finish(outcome);
    respond(res, outcome.outcome);
    shutdown();
  };
  server.on("request", (req, res) => void handle(req, res));
  server.on("error", () => {
    finish(failed("The sign-in listener stopped unexpectedly."));
    shutdown();
  });

  return {
    id: randomUUID(),
    authorizeUrl,
    redirectUri,
    result,
    cancel() {
      if (settled) return;
      abort.abort();
      finish({ outcome: "cancelled" });
      shutdown();
    },
  };
}

/**
 * Why a refresh failed and what the caller should do:
 * - `sign-in-required` (terminal): the refresh token is unusable; clear the
 *   tokens and sign in again with the saved client ID.
 * - `client-rejected` (terminal): the provider rejected the issued client
 *   (`invalid_client`); a configuration problem, not a token problem.
 * - `transient`: network failure, 5xx, 429 or an unreadable answer; keep
 *   the credential and try later.
 * - `rejected`: any other refusal. Not terminal, because clearing a
 *   credential cannot be undone and the cause is unknown.
 */
export type RefreshErrorKind =
  "sign-in-required" | "client-rejected" | "transient" | "rejected";

export class RefreshError extends Error {
  readonly terminal: boolean;
  readonly code: string | null;
  readonly status: number | null;
  readonly kind: RefreshErrorKind;
  constructor(
    message: string,
    details: {
      kind: RefreshErrorKind;
      code: string | null;
      status: number | null;
    },
  ) {
    super(message);
    this.name = "RefreshError";
    this.kind = details.kind;
    this.terminal =
      details.kind === "sign-in-required" || details.kind === "client-rejected";
    this.code = details.code;
    this.status = details.status;
  }
}

/** Codes the documented flow says mean the refresh token cannot be used. */
const unusableRefreshCodes = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

/**
 * Checks an ID token returned by a refresh (OpenID Connect Core §12.2): it
 * must verify, name the same account, and carry the original nonce if it
 * carries one at all. Returns null when the key set cannot be fetched: the
 * refresh token has already rotated, so the new tokens are kept together
 * with the ID token that was validated at sign-in. Any other failure means
 * the identity cannot be trusted, which is terminal.
 */
async function verifyRefreshedIdToken(
  provider: OidcProvider,
  credential: ChatGptCredential,
  token: string,
  status: number,
): Promise<(JwtClaims & { sub: string }) | null> {
  let claims: JwtClaims & { sub: string };
  try {
    claims = await provider.verifyIdToken(token, {
      audience: credential.clientId,
    });
  } catch (error) {
    if (
      error instanceof JwtError &&
      (error.code === "jwks-unavailable" ||
        error.code === "discovery-unavailable")
    )
      return null;
    throw new RefreshError(
      `ChatGPT's renewed identity token was not accepted: ${error instanceof JwtError ? error.message : "it could not be verified."} Sign in again.`,
      { kind: "sign-in-required", code: "invalid_id_token", status },
    );
  }
  let originalNonce: unknown;
  try {
    originalNonce = decodeJwt(credential.idToken).claims.nonce;
  } catch {
    originalNonce = undefined;
  }
  if (
    claims.sub !== credential.subject ||
    (claims.nonce !== undefined && claims.nonce !== originalNonce)
  )
    throw new RefreshError(
      "ChatGPT's renewed identity names a different account. Sign in again.",
      { kind: "sign-in-required", code: "identity_changed", status },
    );
  return claims;
}

/**
 * Exchanges the refresh token for a new access token. The access token,
 * expiry, granted scopes and rotating refresh token are replaced together;
 * `scope` is not sent, so the grant stays as it was. The caller must hold
 * the connection's refresh lock (see {@link refreshStoredChatGpt}) so two
 * refreshes never spend the same rotating token.
 */
export async function refreshChatGpt(
  config: ChatGptAuthConfig,
  credential: ChatGptCredential,
): Promise<ChatGptCredential> {
  const resolved = resolveConfig(config);
  if (credential.issuer !== resolved.issuer)
    throw new RefreshError(
      "The saved ChatGPT sign-in belongs to a different sign-in service than the configured one.",
      { kind: "rejected", code: "issuer_mismatch", status: null },
    );
  if (!credential.refreshToken)
    throw new RefreshError(
      "The ChatGPT sign-in has no refresh token. Sign in again.",
      { kind: "sign-in-required", code: "no_refresh_token", status: null },
    );
  let response: FormResponse;
  try {
    response = await postForm(resolved, resolved.tokenUrl, {
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
      resource: resolved.resource,
    });
  } catch {
    throw new RefreshError(
      "Topsl could not reach the ChatGPT sign-in service to renew the sign-in.",
      { kind: "transient", code: null, status: null },
    );
  }
  const { status } = response;
  if (status !== 200) {
    const code = errorCode(response.body);
    const suffix = ` (HTTP ${status}${code ? `, ${code}` : ""})`;
    if (code !== null && unusableRefreshCodes.has(code))
      throw new RefreshError(
        `The ChatGPT sign-in has expired or was revoked${suffix}. Sign in again.`,
        { kind: "sign-in-required", code, status },
      );
    if (code === "invalid_client")
      throw new RefreshError(
        `ChatGPT no longer accepts Topsl's registered client${suffix}.`,
        { kind: "client-rejected", code, status },
      );
    if (status >= 500 || status === 429)
      throw new RefreshError(
        `The ChatGPT sign-in service is unavailable${suffix}. Try again later.`,
        { kind: "transient", code, status },
      );
    throw new RefreshError(`ChatGPT refused to renew the sign-in${suffix}.`, {
      kind: "rejected",
      code,
      status,
    });
  }
  const now = resolved.now();
  const tokens = parseTokenResponse(response.body, now);
  // The refresh token may already have rotated, but the old one is kept: if
  // it was spent, the next attempt fails with a terminal code instead of the
  // credential being cleared on an ambiguous answer.
  if (!tokens)
    throw new RefreshError("ChatGPT's renewal response was incomplete.", {
      kind: "transient",
      code: "invalid_response",
      status,
    });

  let idToken = credential.idToken;
  let email = credential.email;
  if (tokens.idToken) {
    const claims = await verifyRefreshedIdToken(
      providerFor(config, resolved),
      credential,
      tokens.idToken,
      status,
    );
    if (claims) {
      idToken = tokens.idToken;
      if (typeof claims.email === "string") email = claims.email;
    }
  }
  return {
    ...credential,
    idToken,
    email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? credential.refreshToken,
    tokenType: tokens.tokenType ?? credential.tokenType,
    expiresAt: expiresAt(now, tokens.expiresIn),
    earliestRefreshAt: tokens.earliestRefreshAt,
    scopes: tokens.scopes ?? credential.scopes,
    savedAt: new Date(now).toISOString(),
  };
}

/**
 * Refreshes a stored ChatGPT credential with the connection's lock held and
 * saves the result with a compare-and-swap. Pass the revision whose access
 * token was rejected or is expiring as `seenRevision`: when another caller
 * has already replaced it, that newer credential is returned without a
 * second refresh. Errors (including {@link RefreshError}) are rethrown; the
 * caller decides what a terminal error clears.
 */
export async function refreshStoredChatGpt(
  config: ChatGptAuthConfig,
  store: CredentialStore,
  connectionId: string,
  options: { seenRevision?: number } = {},
): Promise<{ revision: number; credential: ChatGptCredential }> {
  return store.withLock(connectionId, async () => {
    const current = store.get(connectionId);
    if (!current || current.credential.kind !== "oauth-chatgpt")
      throw new RefreshError(
        "This connection has no ChatGPT sign-in. Sign in again.",
        { kind: "sign-in-required", code: "no_credential", status: null },
      );
    const stored = current.credential;
    if (
      options.seenRevision !== undefined &&
      current.revision !== options.seenRevision
    )
      return { revision: current.revision, credential: stored };
    const next = await refreshChatGpt(config, stored);
    const revision = store.put(connectionId, next, current.revision);
    return { revision, credential: next };
  });
}

/**
 * Asks the provider to revoke the sign-in (RFC 7009). Only an HTTP 200 counts
 * as confirmed; the provider answers 200 for a token that is already invalid
 * too. Anything else is reported as not confirmed, and the caller must tell
 * the person remote revocation was not confirmed. Revoking does not delete
 * the registered client, so a later sign-in can reuse the client ID.
 */
export async function revokeChatGpt(
  config: ChatGptAuthConfig,
  credential: ChatGptCredential,
): Promise<{ confirmed: boolean; detail: string }> {
  const resolved = resolveConfig(config);
  const unconfirmed = (reason: string) => ({
    confirmed: false,
    detail: `${reason} Remote revocation was not confirmed.`,
  });
  if (credential.issuer !== resolved.issuer)
    return unconfirmed(
      "The saved sign-in belongs to a different sign-in service than the configured one.",
    );
  let endpoint: string | null;
  try {
    endpoint = (await providerFor(config, resolved).metadata())
      .revocation_endpoint;
  } catch {
    return unconfirmed(
      "Topsl could not read the ChatGPT sign-in service's configuration.",
    );
  }
  if (!endpoint)
    return unconfirmed(
      "The ChatGPT sign-in service does not publish a revocation endpoint.",
    );
  const [token, hint] = credential.refreshToken
    ? [credential.refreshToken, "refresh_token"]
    : [credential.accessToken, "access_token"];
  let response: FormResponse;
  try {
    response = await postForm(resolved, endpoint, {
      token,
      token_type_hint: hint,
      client_id: credential.clientId,
    });
  } catch {
    return unconfirmed("Topsl could not reach the ChatGPT sign-in service.");
  }
  if (response.status === 200)
    return {
      confirmed: true,
      detail: "ChatGPT confirmed the sign-in was revoked.",
    };
  const code = errorCode(response.body);
  const suffix = ` (HTTP ${response.status}${code ? `, ${code}` : ""})`;
  return unconfirmed(
    response.status >= 500
      ? `The ChatGPT sign-in service had a problem${suffix}.`
      : `ChatGPT refused the revocation request${suffix}.`,
  );
}
