import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClaudeCredential } from "../credentials";

/**
 * Experimental community protocol, not an Anthropic-supported integration.
 * Protocol reference: CLIProxyAPI e6e5708e677adb2463d45accdd24bc9fd028ddd8,
 * internal/auth/claude/anthropic_auth.go (MIT; THIRD_PARTY_NOTICES.md).
 * No native credential files, client fingerprints, or fabricated identity are used.
 */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

export interface ClaudeAuthConfig {
  authorizeUrl?: string;
  tokenUrl?: string;
  profileUrl?: string;
  clientId?: string;
  /** Zero selects an ephemeral port for tests. Production uses the registered port. */
  port?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ClaudeAuthError extends Error {
  constructor(
    message: string,
    readonly terminal = false,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ClaudeAuthError";
  }
}

export type ClaudeSignInResult =
  | {
      outcome: "signed-in" | "plan-use-disabled";
      credential: ClaudeCredential;
      planUse: boolean;
    }
  | { outcome: "declined" | "cancelled" | "timed-out" }
  | { outcome: "failed"; error: string };

export interface ClaudeSignInAttempt {
  id: string;
  authorizeUrl: string;
  redirectUri: string;
  result: Promise<ClaudeSignInResult>;
  cancel(): void;
  /** Supports a provider-displayed code#state or callback URL, via trusted IPC. */
  submitCallback(value: string): Promise<void>;
}

function configuration(config: ClaudeAuthConfig) {
  return {
    authorizeUrl: config.authorizeUrl ?? "https://claude.ai/oauth/authorize",
    tokenUrl: config.tokenUrl ?? "https://platform.claude.com/v1/oauth/token",
    profileUrl:
      config.profileUrl ?? "https://api.anthropic.com/api/oauth/profile",
    clientId: config.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
    port: config.port ?? 54545,
    timeoutMs: config.timeoutMs ?? 10 * 60_000,
    fetch: config.fetch ?? globalThis.fetch,
    now: config.now ?? Date.now,
  };
}
type Config = ReturnType<typeof configuration>;
const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const string = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

async function jsonRequest(
  config: Config,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await config.fetch(url, {
      ...init,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch {
    // A refresh may have rotated at the server even if its answer was lost.
    throw new ClaudeAuthError(
      "Claude authentication could not be reached. No credential was changed.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ClaudeAuthError(
      `Claude authentication returned HTTP ${response.status}.`,
      [400, 401, 403].includes(response.status),
      `http_${response.status}`,
    );
  }
  // Bound the response without printing any upstream text, tokens, or codes.
  const reader = response.body?.getReader();
  if (!reader)
    throw new ClaudeAuthError("Claude authentication returned no data.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > 128 * 1024)
        throw new ClaudeAuthError(
          "Claude authentication returned too much data.",
        );
      chunks.push(item.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ClaudeAuthError) throw error;
    throw new ClaudeAuthError("Claude authentication returned invalid data.");
  } finally {
    reader.releaseLock();
  }
}

async function credentialFrom(
  config: Config,
  body: Record<string, any>,
  options: {
    previous?: ClaudeCredential;
    signal?: AbortSignal;
    /** Only refresh can retain identity when the provider omits it. */
    allowRetainedIdentity?: boolean;
  } = {},
): Promise<ClaudeCredential> {
  const { previous, signal, allowRetainedIdentity = false } = options;
  const accessToken = string(body.access_token);
  const expiresIn = Number(body.expires_in);
  if (
    !accessToken ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > 366 * 86400 ||
    (body.token_type && String(body.token_type).toLowerCase() !== "bearer")
  )
    throw new ClaudeAuthError("Claude returned an incomplete credential.");
  let account = object(body.account),
    organization = object(body.organization);
  if (!string(account.uuid) || !string(organization.uuid)) {
    // A browser sign-in must establish its identity anew, including a reconnect.
    if (!allowRetainedIdentity) {
      const profile = await jsonRequest(
        config,
        config.profileUrl,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "anthropic-beta": CLAUDE_OAUTH_BETA,
            accept: "application/json",
          },
        },
        signal,
      );
      account = { ...account, ...object(profile.account) };
      organization = { ...organization, ...object(profile.organization) };
    }
  }
  const accountId =
    string(account.uuid) ||
    (allowRetainedIdentity ? previous?.accountId : "") ||
    "";
  const organizationId =
    string(organization.uuid) ||
    (allowRetainedIdentity ? previous?.organizationId : "") ||
    "";
  if (!accountId || !organizationId)
    throw new ClaudeAuthError(
      "Claude did not establish the account and organization.",
    );
  if (
    previous &&
    (accountId !== previous.accountId ||
      organizationId !== previous.organizationId)
  )
    throw new ClaudeAuthError(
      "The Claude sign-in belongs to another account or organization. Add a separate connection.",
      true,
      "identity_changed",
    );
  const reportedScope = typeof body.scope === "string";
  const scopes = reportedScope
    ? body.scope.split(/\s+/).filter(Boolean)
    : [...((allowRetainedIdentity && previous?.scopes) || CLAUDE_OAUTH_SCOPES)];
  return {
    kind: "oauth-claude",
    clientId: config.clientId,
    accountId,
    organizationId,
    email:
      string(account.email_address) ||
      string(account.email) ||
      previous?.email ||
      null,
    accessToken,
    refreshToken:
      string(body.refresh_token) ||
      (allowRetainedIdentity && previous?.refreshToken) ||
      null,
    tokenType: "Bearer",
    expiresAt: new Date(config.now() + expiresIn * 1000).toISOString(),
    scopes,
    scopeEvidence: reportedScope
      ? "reported"
      : (allowRetainedIdentity && previous?.scopeEvidence) || "requested",
    savedAt: new Date(config.now()).toISOString(),
  };
}

export async function beginClaudeSignIn(
  options: ClaudeAuthConfig = {},
  previous?: ClaudeCredential,
): Promise<ClaudeSignInAttempt> {
  const config = configuration(options);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const controller = new AbortController();
  let finish!: (value: ClaudeSignInResult) => void;
  const result = new Promise<ClaudeSignInResult>((resolve) => {
    finish = resolve;
  });
  let settled = false,
    exchanging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (value: ClaudeSignInResult) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    controller.abort();
    server.close();
    server.closeAllConnections();
    finish(value);
  };
  let redirectUri = "";
  const submitCallback = async (value: string) => {
    if (settled || exchanging)
      throw new ClaudeAuthError(
        "This sign-in is no longer waiting for a callback.",
      );
    if (value.length > 16_384)
      throw new ClaudeAuthError("The sign-in callback is too large.");
    let code = "",
      returnedState = "",
      error = "";
    if (/^https?:\/\//.test(value.trim())) {
      const callback = new URL(value.trim());
      const expected = new URL(redirectUri);
      if (
        callback.origin !== expected.origin ||
        callback.pathname !== expected.pathname
      )
        throw new ClaudeAuthError(
          "The callback does not belong to this sign-in.",
        );
      code = callback.searchParams.get("code") ?? "";
      returnedState = callback.searchParams.get("state") ?? "";
      error = callback.searchParams.get("error") ?? "";
    } else {
      const parts = value.trim().split("#");
      if (parts.length !== 2)
        throw new ClaudeAuthError(
          "Copy the complete sign-in code including its state, or the callback URL.",
        );
      [code, returnedState] = parts;
    }
    // Some callbacks append state to the code as well. Both must agree.
    if (code.includes("#")) {
      const parts = code.split("#");
      if (
        parts.length !== 2 ||
        (returnedState && !equal(returnedState, parts[1]))
      )
        throw new ClaudeAuthError("The sign-in state does not match.");
      [code, returnedState] = parts;
    }
    if (!returnedState || !equal(returnedState, state))
      throw new ClaudeAuthError("The sign-in state does not match.");
    if (error) {
      settle(
        error === "access_denied"
          ? { outcome: "declined" }
          : {
              outcome: "failed",
              error: "Claude did not authorize the sign-in.",
            },
      );
      return;
    }
    if (!code)
      throw new ClaudeAuthError("The callback contains no authorization code.");
    exchanging = true;
    try {
      const body = await jsonRequest(
        config,
        config.tokenUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: config.clientId,
            code_verifier: verifier,
            state,
          }),
        },
        controller.signal,
      );
      const credential = await credentialFrom(config, body, {
        previous,
        signal: controller.signal,
      });
      const planUse = credential.scopes.includes("user:inference");
      settle({
        outcome: planUse ? "signed-in" : "plan-use-disabled",
        credential,
        planUse,
      });
    } catch (error) {
      settle({
        outcome: "failed",
        error:
          error instanceof ClaudeAuthError
            ? error.message
            : "Claude sign-in could not be completed.",
      });
    }
  };
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader("content-security-policy", "default-src 'none'");
    if (
      req.method !== "GET" ||
      !req.url?.startsWith("/callback?") ||
      !["localhost", "127.0.0.1"].some(
        (host) =>
          req.headers.host ===
          `${host}:${(server.address() as AddressInfo)?.port}`,
      )
    ) {
      res.writeHead(404);
      res.end("Not found.");
      return;
    }
    // Answer before exchanging: closing the listener must not strand the browser.
    res.end("Return to Topsl to see whether sign-in completed.");
    void submitCallback(
      `${redirectUri}${req.url.slice("/callback".length)}`,
    ).catch(() => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch {
    throw new ClaudeAuthError(
      "Claude sign-in could not open its local callback port. Close another sign-in and try again.",
    );
  }
  redirectUri = `http://localhost:${(server.address() as AddressInfo).port}/callback`;
  const authorize = new URL(config.authorizeUrl);
  for (const [name, value] of Object.entries({
    code: "true",
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: CLAUDE_OAUTH_SCOPES.join(" "),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  }))
    authorize.searchParams.set(name, value);
  timer = setTimeout(() => settle({ outcome: "timed-out" }), config.timeoutMs);
  timer.unref();
  return {
    id: randomUUID(),
    authorizeUrl: authorize.toString(),
    redirectUri,
    result,
    submitCallback,
    cancel: () => settle({ outcome: "cancelled" }),
  };
}

export async function refreshClaude(
  options: ClaudeAuthConfig,
  previous: ClaudeCredential,
): Promise<ClaudeCredential> {
  if (!previous.refreshToken)
    throw new ClaudeAuthError(
      "Sign in to Claude again.",
      true,
      "missing_refresh_token",
    );
  const config = configuration({ ...options, clientId: previous.clientId });
  const body = await jsonRequest(config, config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
      client_id: previous.clientId,
      scope: CLAUDE_OAUTH_SCOPES.join(" "),
    }),
  });
  return credentialFrom(config, body, {
    previous,
    allowRetainedIdentity: true,
  });
}
