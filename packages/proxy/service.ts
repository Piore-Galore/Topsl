import { randomBytes, randomUUID } from "node:crypto";
import type {
  CanonicalEvent,
  CanonicalRequest,
  ClientProtocol,
  ProxyErrorInfo,
} from "./canonical";
import { UnsupportedConversion, collectResponse } from "./canonical";
import { ProxyDatabase } from "./database";
import { includeUsage } from "./protocols/chat";
import { ProxyRegistry } from "./registry";
import {
  CredentialStore,
  keyFingerprint,
  type ChatGptCredential,
  type ClaudeCredential,
  type StoredCredential,
} from "./credentials";
import {
  RefreshError,
  beginChatGptSignIn,
  refreshChatGpt,
  revokeChatGpt,
  type ChatGptAuthConfig,
  type SignInAttempt,
} from "./oauth/chatgpt";
import {
  beginClaudeSignIn,
  refreshClaude,
  ClaudeAuthError,
  type ClaudeAuthConfig,
  type ClaudeSignInAttempt,
} from "./oauth/claude";
import {
  authorizationHeaders,
  dispatchUpstream,
  failure,
  listUpstreamModels,
  protocolModule,
  UpstreamError,
  type UpstreamModel,
} from "./adapters";
import {
  routeHeaders,
  type Connection,
  type ConnectionKind,
  type ProxyRoute,
  type ReceiptOutcome,
  type RequestReceipt,
} from "./types";

/**
 * The Topsl local proxy (docs/Native_Harness_Plan.md §2): model requests,
 * protocol conversion, accounts, authentication and usage attribution. It
 * returns model text and proposed tool calls and never executes a tool, runs
 * a second agent loop, retries a model request, rotates accounts or changes
 * funding. Authentication renewal may retry an explicitly rejected request
 * once, with the same identity.
 */

/** Refresh a plan access token this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Largest request body the proxy reads. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export const claudeSubscriptionStatus = {
  available: true,
  experimental: true,
  reason:
    "Direct Claude-plan access through Topsl's proxy is an experimental community integration. Live account and model availability are established by sign-in and inference, separately from the Anthropic API connection.",
  source: "https://code.claude.com/docs/en/legal-and-compliance",
} as const;

export interface ProxyStateView {
  connections: Connection[];
  routes: ProxyRoute[];
  signIns: Array<{ id: string; connectionId: string; startedAt: string }>;
  claudeSubscription: typeof claudeSubscriptionStatus;
}

export type ProxyCommand =
  | {
      type: "connection-create";
      kind: ConnectionKind;
      label: string;
      endpoint?: string | null;
      protocol?: ClientProtocol;
    }
  | { type: "connection-rename"; connectionId: string; label: string }
  | { type: "connection-api-key"; connectionId: string; key: string }
  | { type: "connection-sign-in"; connectionId: string }
  | { type: "connection-sign-in-complete"; attemptId: string; callback: string }
  | { type: "connection-sign-in-cancel"; attemptId: string }
  | { type: "connection-models"; connectionId: string }
  | { type: "connection-disconnect"; connectionId: string }
  | { type: "connection-remove"; connectionId: string }
  | {
      type: "route-save";
      id?: string;
      connectionId: string;
      upstreamModel: string;
      alias: string;
      disabled?: boolean;
    }
  | { type: "route-remove"; routeId: string }
  | {
      type: "receipts";
      attemptId?: string;
      connectionId?: string;
      limit?: number;
    };

export interface ProxyServiceOptions {
  file: string;
  key: string;
  fetch?: typeof fetch;
  chatgpt?: ChatGptAuthConfig;
  claude?: ClaudeAuthConfig;
  /** Called after every change the renderer should see (sanitized). */
  onState?: (state: ProxyStateView) => void;
  /** Opens a sign-in page in the person's browser. */
  openExternal?: (url: string) => void;
}

export type InferenceResult =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "stream"; status: 200; chunks: AsyncGenerator<string> };

export class ProxyService {
  readonly database: ProxyDatabase;
  readonly registry: ProxyRegistry;
  readonly credentials: CredentialStore;
  /** The local access token clients present. Never written to disk. */
  readonly accessToken = randomBytes(32).toString("base64url");
  private readonly fetch: typeof fetch;
  private closed = false;
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly startingSignIns = new Map<string, symbol>();
  private readonly signIns = new Map<
    string,
    {
      connectionId: string;
      attempt: SignInAttempt | ClaudeSignInAttempt;
      startedAt: string;
    }
  >();

  constructor(private options: ProxyServiceOptions) {
    this.database = new ProxyDatabase(options.file, options.key);
    this.registry = new ProxyRegistry(this.database);
    this.credentials = new CredentialStore(this.database);
    this.fetch = options.fetch ?? fetch;
  }

  view(): ProxyStateView {
    return {
      connections: this.registry.connections(),
      routes: this.registry.routes(),
      signIns: [...this.signIns.entries()].map(([id, s]) => ({
        id,
        connectionId: s.connectionId,
        startedAt: s.startedAt,
      })),
      claudeSubscription: claudeSubscriptionStatus,
    };
  }
  private changed(): void {
    if (this.closed) return;
    this.options.onState?.(this.view());
  }

  /** Account management over trusted IPC. There is no HTTP administration endpoint. */
  async command(command: ProxyCommand): Promise<unknown> {
    try {
      return await this.run(command);
    } finally {
      this.changed();
    }
  }

  private async run(command: ProxyCommand): Promise<unknown> {
    switch (command.type) {
      case "connection-create":
        return this.registry.createConnection({
          kind: command.kind,
          label: command.label,
          endpoint: command.endpoint ?? null,
          protocol: command.protocol,
          state: command.kind === "ollama" ? "ready" : "signed-out",
        });
      case "connection-rename":
        return this.registry.updateConnection(command.connectionId, {
          label: command.label.trim().slice(0, 200),
        });
      case "connection-api-key":
        return this.storeApiKey(command.connectionId, command.key);
      case "connection-sign-in":
        return this.signIn(command.connectionId);
      case "connection-sign-in-complete": {
        const attempt = this.signIns.get(command.attemptId)?.attempt;
        if (!attempt || !("submitCallback" in attempt))
          throw new Error("This sign-in does not accept a pasted callback.");
        await attempt.submitCallback(command.callback);
        return null;
      }
      case "connection-sign-in-cancel": {
        this.signIns.get(command.attemptId)?.attempt.cancel();
        return null;
      }
      case "connection-models":
        return this.models(command.connectionId);
      case "connection-disconnect":
        return this.disconnect(command.connectionId);
      case "connection-remove": {
        const result = await this.disconnect(command.connectionId);
        this.registry.removeConnection(command.connectionId);
        return result;
      }
      case "route-save":
        return this.registry.saveRoute(command);
      case "route-remove":
        this.registry.removeRoute(command.routeId);
        return null;
      case "receipts":
        return this.registry.receipts(command);
    }
  }

  private storeApiKey(connectionId: string, key: string): Connection {
    const connection = this.registry.requireConnection(connectionId);
    if (connection.authentication !== "api-key")
      throw new Error("This connection does not use an API key.");
    const value = key.trim();
    if (value.length < 8 || value.length > 1000 || /\s/.test(value))
      throw new Error("That does not look like an API key.");
    const fingerprint = keyFingerprint(value);
    const stored = this.credentials.get(connectionId);
    this.credentials.put(
      connectionId,
      {
        kind: "api-key",
        key: value,
        fingerprint,
        savedAt: new Date().toISOString(),
      },
      stored?.revision ?? null,
    );
    return this.registry.updateConnection(connectionId, {
      hasCredential: true,
      state: "ready",
      stateDetail: null,
      account: {
        accountKey: `${connection.kind}:${fingerprint}`,
        email: null,
        source: "api-key-fingerprint",
        // The same key bills the same account, whichever route uses it.
        quotaOwner: `${connection.kind}:${fingerprint}`,
        observedAt: new Date().toISOString(),
      },
    });
  }

  private async signIn(
    connectionId: string,
  ): Promise<{ attemptId: string; authorizeUrl: string }> {
    if (this.closed) throw new Error("The proxy is shutting down.");
    const connection = this.registry.requireConnection(connectionId);
    if (connection.kind !== "chatgpt-plan" && connection.kind !== "claude-plan")
      throw new Error("Only a plan connection signs in.");
    for (const s of this.signIns.values())
      if (s.connectionId === connectionId)
        throw new Error("A sign-in for this connection is already open.");
    if (this.startingSignIns.has(connectionId))
      throw new Error("A sign-in for this connection is already opening.");
    const stored = this.credentials.get(connectionId)?.credential;
    const registration =
      stored?.kind === "oauth-chatgpt"
        ? {
            clientId: stored.clientId,
            subject: stored.subject,
            email: stored.email,
            idToken: stored.idToken || null,
          }
        : undefined;
    const opening = Symbol();
    this.startingSignIns.set(connectionId, opening);
    let attempt: SignInAttempt | ClaudeSignInAttempt;
    try {
      attempt =
        connection.kind === "claude-plan"
          ? await beginClaudeSignIn(
              this.options.claude ?? {},
              stored?.kind === "oauth-claude" ? stored : undefined,
            )
          : await beginChatGptSignIn(this.options.chatgpt ?? {}, {
              hostId: this.database.hostId(),
              registration,
              loginHint: registration?.email ?? undefined,
            });
      if (
        this.closed ||
        this.startingSignIns.get(connectionId) !== opening ||
        !this.registry.connection(connectionId)
      ) {
        attempt.cancel();
        throw new Error("Sign-in was cancelled before the browser opened.");
      }
    } finally {
      if (this.startingSignIns.get(connectionId) === opening)
        this.startingSignIns.delete(connectionId);
    }
    const startedAt = new Date().toISOString();
    this.signIns.set(attempt.id, { connectionId, attempt, startedAt });
    const stillOpen = () =>
      !this.closed &&
      this.signIns.get(attempt.id)?.attempt === attempt &&
      !!this.registry.connection(connectionId);
    void attempt.result
      .then(async (result) => {
        if (!stillOpen()) return;
        if (
          result.outcome === "signed-in" ||
          result.outcome === "plan-use-disabled"
        ) {
          // Under the refresh lock, so a concurrent refresh never races this write.
          await this.credentials.withLock(connectionId, async () => {
            if (!stillOpen()) return;
            const current = this.credentials.get(connectionId);
            this.credentials.put(
              connectionId,
              result.credential,
              current?.revision ?? null,
            );
          });
          if (!stillOpen()) return;
          this.registry.updateConnection(connectionId, {
            hasCredential: true,
            state: result.planUse ? "ready" : "plan-use-disabled",
            stateDetail: result.planUse
              ? null
              : "Plan inference permission was not granted. Sign in again and allow plan usage.",
            account:
              result.credential.kind === "oauth-claude"
                ? claudeAccount(result.credential)
                : chatGptAccount(result.credential),
          });
        } else if (result.outcome === "declined")
          this.registry.updateConnection(connectionId, {
            stateDetail:
              "Sign-in was declined in the browser. Nothing was stored.",
          });
        else if (result.outcome === "failed")
          this.registry.updateConnection(connectionId, {
            stateDetail: `Sign-in did not complete: ${result.error}`,
          });
        else if (result.outcome === "timed-out")
          this.registry.updateConnection(connectionId, {
            stateDetail: "Sign-in timed out before the browser returned.",
          });
      })
      .catch((error) => {
        if (stillOpen())
          this.registry.updateConnection(connectionId, {
            stateDetail: `Sign-in did not complete: ${String(error?.message ?? error)}`,
          });
      })
      .finally(() => {
        this.signIns.delete(attempt.id);
        this.changed();
      });
    this.options.openExternal?.(attempt.authorizeUrl);
    return { attemptId: attempt.id, authorizeUrl: attempt.authorizeUrl };
  }

  /**
   * Blocks new requests, cancels active transports and clears the stored
   * credential, reporting whether the provider confirmed revocation.
   */
  async disconnect(connectionId: string): Promise<{
    revocation:
      "confirmed" | "not-confirmed" | "not-supported" | "not-applicable";
    detail: string;
  }> {
    const connection = this.registry.requireConnection(connectionId);
    this.startingSignIns.delete(connectionId);
    for (const [id, pending] of this.signIns)
      if (pending.connectionId === connectionId) {
        this.signIns.delete(id);
        pending.attempt.cancel();
      }
    this.registry.updateConnection(connectionId, {
      state: "disconnected",
      stateDetail: "Disconnecting…",
    });
    for (const controller of this.active.get(connectionId) ?? [])
      controller.abort();
    let revocation:
      "confirmed" | "not-confirmed" | "not-supported" | "not-applicable" =
      connection.revocation === "supported"
        ? "not-confirmed"
        : connection.revocation;
    let detail =
      connection.revocation === "not-applicable"
        ? "This connection holds no credential."
        : "Topsl removed its copy of the key. Revoke the key at the provider if it should stop working everywhere.";
    await this.credentials.withLock(connectionId, async () => {
      const stored = this.credentials.get(connectionId)?.credential;
      if (stored?.kind === "oauth-chatgpt" && stored.refreshToken) {
        const result = await revokeChatGpt(
          this.options.chatgpt ?? {},
          stored,
        ).catch((error) => ({
          confirmed: false,
          detail: String(error?.message ?? error),
        }));
        revocation = result.confirmed ? "confirmed" : "not-confirmed";
        detail = result.confirmed
          ? "OpenAI confirmed the sign-in was revoked."
          : `Remote revocation was not confirmed (${result.detail}). Topsl removed its copy; you can also disconnect Topsl in ChatGPT settings.`;
      }
      if (stored?.kind === "oauth-claude") {
        revocation = "not-supported";
        detail =
          "Topsl removed this Claude sign-in and cancelled its requests. Provider-side revocation was not established; manage connected sessions in your Claude account.";
      }
      this.credentials.delete(connectionId);
    });
    this.registry.updateConnection(connectionId, {
      hasCredential: false,
      state: "disconnected",
      stateDetail: detail,
    });
    return { revocation, detail };
  }

  async models(connectionId: string): Promise<UpstreamModel[]> {
    const connection = this.registry.requireConnection(connectionId);
    const { headers } = await this.headers(connection, false);
    try {
      return await listUpstreamModels({
        connection,
        headers,
        fetch: this.fetch,
      });
    } catch (error) {
      if (error instanceof UpstreamError) throw new Error(error.info.message);
      throw error;
    }
  }

  /** The authenticating headers for one request; refreshes a plan token under its lock. */
  private async headers(
    connection: Connection,
    force: boolean,
    rejectedRevision?: number,
  ): Promise<{
    headers: Record<string, string>;
    identity: string | null;
    revision?: number;
  }> {
    if (connection.authentication === "none")
      return {
        headers: authorizationHeaders(connection.kind, null),
        identity: null,
      };
    const stored = this.credentials.get(connection.id);
    if (!stored)
      throw new UpstreamError(
        failure(
          "authentication",
          null,
          null,
          null,
          "This connection has no stored credential.",
        ),
      );
    if (stored.credential.kind === "api-key")
      return {
        headers: authorizationHeaders(connection.kind, stored.credential.key),
        identity: stored.credential.fingerprint,
      };
    if (stored.credential.kind === "oauth-claude")
      return this.claudeHeaders(connection, force, rejectedRevision);
    return this.credentials.withLock(connection.id, async () => {
      // Re-read inside the lock: another request may have rotated the token.
      const current = this.credentials.get(connection.id);
      const credential = current?.credential;
      if (
        !current ||
        credential?.kind !== "oauth-chatgpt" ||
        !credential.accessToken
      )
        throw new UpstreamError(
          failure(
            "authentication",
            null,
            null,
            null,
            "Sign in to ChatGPT again for this connection.",
          ),
        );
      let active: ChatGptCredential = credential;
      const remaining = Date.parse(credential.expiresAt) - Date.now();
      if (
        (force &&
          (rejectedRevision === undefined ||
            rejectedRevision === current.revision)) ||
        remaining < REFRESH_MARGIN_MS
      ) {
        try {
          const next = await refreshChatGpt(
            this.options.chatgpt ?? {},
            credential,
          );
          if (
            next.subject !== credential.subject ||
            next.clientId !== credential.clientId
          )
            throw new RefreshError(
              "The refreshed sign-in belongs to another account.",
              {
                kind: "sign-in-required",
                code: "identity_changed",
                status: null,
              },
            );
          this.credentials.put(connection.id, next, current.revision);
          active = next;
        } catch (error) {
          if (error instanceof RefreshError && error.terminal) {
            this.credentials.put(
              connection.id,
              { ...credential, accessToken: "", refreshToken: null },
              current.revision,
            );
            this.registry.updateConnection(connection.id, {
              state: "reauthorization-required",
              stateDetail:
                "The ChatGPT sign-in can no longer be renewed. Sign in again.",
            });
            this.changed();
            throw new UpstreamError(
              failure(
                "authentication",
                401,
                error.code,
                null,
                "The ChatGPT sign-in can no longer be renewed. Sign in again.",
              ),
            );
          }
          // A temporary refresh failure keeps the credential; a still-valid
          // token remains usable.
          if (remaining <= 0)
            throw new UpstreamError(
              failure(
                "unavailable",
                null,
                null,
                null,
                "The ChatGPT sign-in could not be renewed right now.",
                true,
              ),
            );
        }
      }
      return {
        headers: authorizationHeaders(connection.kind, active.accessToken),
        identity: `${active.issuer}#${active.subject}#${active.clientId}`,
        revision: this.credentials.get(connection.id)?.revision,
      };
    });
  }

  private async claudeHeaders(
    connection: Connection,
    force: boolean,
    rejectedRevision?: number,
  ) {
    return this.credentials.withLock(connection.id, async () => {
      const current = this.credentials.get(connection.id);
      const state = this.registry.requireConnection(connection.id).state;
      if (
        this.closed ||
        state === "disconnected" ||
        current?.credential.kind !== "oauth-claude" ||
        !current.credential.accessToken
      )
        throw new UpstreamError(
          failure(
            "authentication",
            401,
            "not_connected",
            null,
            "Sign in to Claude for this connection.",
          ),
        );
      let active = current.credential;
      const remaining = Date.parse(active.expiresAt) - Date.now();
      if (
        (force &&
          (rejectedRevision === undefined ||
            current.revision === rejectedRevision)) ||
        remaining < REFRESH_MARGIN_MS
      ) {
        try {
          const renewed = await refreshClaude(
            this.options.claude ?? {},
            active,
          );
          this.credentials.put(connection.id, renewed, current.revision);
          active = renewed;
        } catch (error) {
          if (error instanceof ClaudeAuthError && error.terminal) {
            this.credentials.put(
              connection.id,
              { ...active, accessToken: "", refreshToken: null },
              current.revision,
            );
            this.registry.updateConnection(connection.id, {
              state: "reauthorization-required",
              stateDetail:
                "The Claude sign-in can no longer be renewed. Sign in again.",
            });
            this.changed();
            throw new UpstreamError(
              failure(
                "authentication",
                401,
                error.code,
                null,
                "The Claude sign-in can no longer be renewed. Sign in again.",
              ),
            );
          }
          if (force || remaining <= 0)
            throw new UpstreamError(
              failure(
                "unavailable",
                503,
                "refresh_unavailable",
                null,
                "The Claude sign-in could not be renewed right now.",
                true,
              ),
            );
        }
      }
      if (!active.scopes.includes("user:inference")) {
        this.registry.updateConnection(connection.id, {
          state: "plan-use-disabled",
          stateDetail: "Claude inference permission was not granted.",
        });
        this.changed();
        throw new UpstreamError(
          failure(
            "permission",
            403,
            "plan_use_disabled",
            null,
            "Claude inference permission was not granted.",
          ),
        );
      }
      return {
        headers: authorizationHeaders("claude-plan", active.accessToken),
        identity: `${active.accountId}:${active.organizationId}`,
        revision: this.credentials.get(connection.id)?.revision,
      };
    });
  }

  /**
   * Handles one inference request from a local client. Errors come back in
   * the client's protocol; nothing is retried except one same-identity
   * renewal after an explicit authentication rejection.
   */
  async infer(input: {
    protocol: ClientProtocol;
    body: unknown;
    headers: Record<string, string | undefined>;
    signal: AbortSignal;
  }): Promise<InferenceResult> {
    const module = protocolModule(input.protocol);
    const receipt: RequestReceipt = {
      id: randomUUID(),
      correlationId: input.headers[routeHeaders.correlation] ?? null,
      attemptId: input.headers[routeHeaders.attempt] ?? null,
      routeId: null,
      routeRevision: null,
      connectionId: null,
      accountKey: null,
      funding: null,
      clientProtocol: input.protocol,
      upstreamProtocol: null,
      requestedModel:
        typeof (input.body as any)?.model === "string"
          ? (input.body as any).model.slice(0, 200)
          : "",
      upstreamModel: null,
      reportedModel: null,
      outcome: "rejected",
      error: null,
      usage: { input: null, output: null, cachedInput: null, reasoning: null },
      upstreamRequestId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const reject = (status: number, error: ProxyErrorInfo): InferenceResult => {
      receipt.outcome = "rejected";
      receipt.error = error;
      receipt.finishedAt = new Date().toISOString();
      this.registry.recordReceipt(receipt);
      return { kind: "json", status, body: errorJson(module, error) };
    };
    let request: CanonicalRequest;
    try {
      request = module.parseRequest(input.body);
    } catch (error) {
      if (error instanceof UnsupportedConversion)
        return reject(
          400,
          failure(
            "unsupported",
            400,
            "unsupported_conversion",
            error.param,
            error.message,
          ),
        );
      return reject(
        400,
        failure(
          "invalid-request",
          400,
          null,
          null,
          String((error as Error)?.message ?? error),
        ),
      );
    }
    const route = this.registry.routeByAlias(request.model);
    if (!route || route.disabled)
      return reject(
        404,
        failure(
          "not-found",
          404,
          "model_not_found",
          "model",
          `No enabled route is named ${request.model}.`,
        ),
      );
    receipt.routeId = route.id;
    receipt.routeRevision = route.revision;
    receipt.upstreamModel = route.upstreamModel;
    receipt.upstreamProtocol = route.protocol;
    const frozen = input.headers[routeHeaders.routeRevision];
    // A native attempt froze this revision; a changed route never receives it.
    if (frozen && frozen !== route.revision)
      return reject(
        409,
        failure(
          "route-changed",
          409,
          "route_revision_mismatch",
          "model",
          "The route changed after this attempt was bound. Start a new attempt from a safe checkpoint.",
        ),
      );
    const connection = this.registry.connection(route.connectionId);
    if (!connection)
      return reject(
        404,
        failure(
          "not-found",
          404,
          "connection_missing",
          null,
          "The route's connection no longer exists.",
        ),
      );
    receipt.connectionId = connection.id;
    receipt.accountKey = connection.account.accountKey;
    receipt.funding = connection.funding;
    if (
      connection.state === "disconnected" ||
      connection.state === "signed-out"
    )
      return reject(
        401,
        failure(
          "authentication",
          401,
          "not_connected",
          null,
          `${connection.label} is not connected.`,
        ),
      );
    if (connection.state === "plan-use-disabled")
      return reject(
        403,
        failure(
          "permission",
          403,
          "plan_use_disabled",
          null,
          "Plan usage is not enabled for this sign-in.",
        ),
      );
    if (connection.state === "reauthorization-required")
      return reject(
        401,
        failure(
          "authentication",
          401,
          "reauthorization_required",
          null,
          "Sign in again for this connection.",
        ),
      );

    const controller = new AbortController();
    if (input.signal.aborted) controller.abort();
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    let set = this.active.get(connection.id);
    if (!set) this.active.set(connection.id, (set = new Set()));
    set.add(controller);
    const release = () => {
      set!.delete(controller);
      input.signal.removeEventListener("abort", abort);
    };
    let response;
    try {
      let auth = await this.headers(connection, false);
      response = await dispatchUpstream(
        {
          connection,
          route,
          headers: auth.headers,
          fetch: this.fetch,
          signal: controller.signal,
        },
        request,
      );
      if (
        !response.ok &&
        response.error.kind === "authentication" &&
        (connection.kind === "chatgpt-plan" ||
          connection.kind === "claude-plan")
      ) {
        const renewed = await this.headers(connection, true, auth.revision);
        if (renewed.identity !== auth.identity)
          throw new Error("The renewed sign-in changed identity.");
        auth = renewed;
        response = await dispatchUpstream(
          {
            connection,
            route,
            headers: auth.headers,
            fetch: this.fetch,
            signal: controller.signal,
          },
          request,
        );
      }
    } catch (error) {
      release();
      const info =
        error instanceof UpstreamError
          ? error.info
          : failure(
              "upstream",
              null,
              null,
              null,
              String((error as Error)?.message ?? error),
            );
      return reject(statusFor(info), info);
    }
    if (!response.ok) {
      release();
      this.noteFailure(connection, response.error);
      receipt.upstreamRequestId = response.error.requestId;
      receipt.outcome = controller.signal.aborted ? "cancelled" : "failed";
      receipt.error = response.error;
      receipt.finishedAt = new Date().toISOString();
      if (!this.closed) this.registry.recordReceipt(receipt);
      return {
        kind: "json",
        status: statusFor(response.error),
        body: errorJson(module, response.error),
      };
    }
    receipt.upstreamRequestId = response.requestId;
    receipt.outcome = "interrupted";
    this.registry.recordReceipt(receipt);
    const observed = this.observe(
      response.events,
      receipt,
      connection,
      release,
      controller,
    );
    if (request.stream) {
      const meta = {
        model: request.model,
        responseId: receipt.id,
        // A Chat Completions client gets a usage chunk only when it asked for one.
        includeUsage:
          input.protocol === "chat" ? includeUsage(input.body) : true,
      };
      return {
        kind: "stream",
        status: 200,
        // Topsl's harness (a request with a frozen route revision) is told
        // the model the upstream reported, which it records as evidence;
        // other clients see the alias they asked for.
        chunks: module.writeStream(
          frozen ? reportingUpstreamModel(observed, meta) : observed,
          meta,
        ),
      };
    }
    const events: CanonicalEvent[] = [];
    for await (const event of observed) events.push(event);
    const collected = collectResponse(events);
    if (collected.error)
      return {
        kind: "json",
        status: statusFor(collected.error),
        body: errorJson(module, collected.error),
      };
    return {
      kind: "json",
      status: 200,
      body: module.writeResponse(collected, {
        model: request.model,
        responseId: receipt.id,
      }),
    };
  }

  /** Watches a stream for the receipt and settles it when the stream ends. */
  private async *observe(
    events: AsyncGenerator<CanonicalEvent>,
    receipt: RequestReceipt,
    connection: Connection,
    release: () => void,
    controller: AbortController,
  ): AsyncGenerator<CanonicalEvent> {
    let outcome: ReceiptOutcome | null = null;
    try {
      for await (const event of events) {
        if (event.type === "response-start" && event.model)
          receipt.reportedModel = event.model;
        if (event.type === "usage")
          receipt.usage = {
            input: event.input ?? receipt.usage.input,
            output: event.output ?? receipt.usage.output,
            cachedInput: event.cachedInput ?? receipt.usage.cachedInput,
            reasoning: event.reasoning ?? receipt.usage.reasoning,
          };
        if (event.type === "finish")
          outcome =
            event.reason === "length" ||
            event.reason === "content-filter" ||
            event.reason === "other"
              ? "incomplete"
              : "completed";
        if (event.type === "error") {
          outcome = "failed";
          receipt.error = event.error;
          this.noteFailure(connection, event.error);
        }
        yield event;
      }
    } finally {
      release();
      // A request the client or a disconnect cancelled is recorded as cancelled,
      // even when the aborted upstream read surfaced as an error event.
      receipt.outcome =
        outcome === "completed" || outcome === "incomplete"
          ? outcome
          : controller.signal.aborted
            ? "cancelled"
            : (outcome ?? "interrupted");
      receipt.finishedAt = new Date().toISOString();
      if (!this.closed) this.registry.recordReceipt(receipt);
      if (
        !this.closed &&
        this.registry.connection(connection.id) &&
        outcome === "completed" &&
        connection.state === "paused-usage-limit"
      ) {
        this.registry.updateConnection(connection.id, {
          state: "ready",
          stateDetail: null,
        });
        this.changed();
      }
    }
  }

  /** Records a plan usage limit on the connection; the harness owns the wait. */
  private noteFailure(connection: Connection, error: ProxyErrorInfo): void {
    if (
      !this.closed &&
      error.kind === "authentication" &&
      connection.funding === "subscription" &&
      this.registry.connection(connection.id)
    ) {
      this.registry.updateConnection(connection.id, {
        state: "reauthorization-required",
        stateDetail:
          "The provider rejected this sign-in after renewal. Sign in again.",
      });
      this.changed();
    }
    if (
      !this.closed &&
      error.kind === "quota" &&
      connection.funding === "subscription"
    ) {
      this.registry.updateConnection(connection.id, {
        state: "paused-usage-limit",
        stateDetail:
          "The provider reported the plan's usage limit. Check your account's usage; Topsl does not infer a reset time.",
      });
      this.changed();
    }
  }

  /** Lists routes as models, in the OpenAI or Anthropic shape the client expects. */
  modelList(anthropic: boolean): unknown {
    const routes = this.registry.routes().filter((r) => !r.disabled);
    const connections = new Map(
      this.registry.connections().map((c) => [c.id, c]),
    );
    if (anthropic)
      return {
        data: routes.map((r) => ({
          type: "model",
          id: r.alias,
          display_name: r.alias,
          created_at: r.createdAt,
        })),
        has_more: false,
        first_id: routes[0]?.alias ?? null,
        last_id: routes.at(-1)?.alias ?? null,
      };
    return {
      object: "list",
      data: routes.map((r) => ({
        id: r.alias,
        object: "model",
        created: Math.floor(Date.parse(r.createdAt) / 1000),
        owned_by: connections.get(r.connectionId)?.kind ?? "unknown",
        topsl: {
          routeId: r.id,
          routeRevision: r.revision,
          protocol: r.protocol,
          funding: connections.get(r.connectionId)?.funding ?? null,
          connection: connections.get(r.connectionId)?.label ?? null,
        },
      })),
    };
  }

  close(): void {
    this.closed = true;
    this.startingSignIns.clear();
    for (const s of this.signIns.values()) s.attempt.cancel();
    this.signIns.clear();
    for (const set of this.active.values()) for (const c of set) c.abort();
    this.database.close();
  }
}

/** The HTTP status a local client sees: the upstream's when it gave one, else the class's. */
function statusFor(error: ProxyErrorInfo): number {
  if (error.status) return error.status;
  const statuses: Record<ProxyErrorInfo["kind"], number> = {
    authentication: 401,
    permission: 403,
    quota: 429,
    unavailable: 503,
    "invalid-request": 400,
    unsupported: 400,
    "route-changed": 409,
    "not-found": 404,
    interrupted: 502,
    upstream: 502,
  };
  return statuses[error.kind];
}

/**
 * An error in the client's protocol, with Topsl's classification alongside so
 * the native harness can tell a quota pause from a transient failure.
 */
function errorJson(
  module: ReturnType<typeof protocolModule>,
  error: ProxyErrorInfo,
) {
  return { ...module.errorBody(error), topsl_error: error };
}

export function chatGptAccount(credential: ChatGptCredential) {
  return {
    accountKey: `chatgpt:${credential.subject}:${credential.clientId}`,
    email: credential.email,
    source: "id-token" as const,
    // One issued client ID covers one user and workspace; routes on
    // connections with the same registration share its plan allowance.
    // Separate registrations do not create extra allowance. Until a verified
    // workspace meter is exposed, conservatively share a subject's pool.
    quotaOwner: `chatgpt:${credential.subject}`,
    observedAt: credential.savedAt,
  };
}

export function claudeAccount(credential: ClaudeCredential) {
  const owner = `claude:${credential.accountId}:${credential.organizationId}`;
  return {
    accountKey: owner,
    email: credential.email,
    source: "oauth-profile" as const,
    quotaOwner: owner,
    observedAt: credential.savedAt,
  };
}

export type { StoredCredential };

/**
 * Passes events through, naming the upstream-reported model in `meta`
 * before the writer emits its first frame (the writers read `meta.model`
 * when they start).
 */
async function* reportingUpstreamModel(
  events: AsyncGenerator<CanonicalEvent>,
  meta: { model: string },
): AsyncGenerator<CanonicalEvent> {
  for await (const event of events) {
    if (event.type === "response-start" && event.model) meta.model = event.model;
    yield event;
  }
}
