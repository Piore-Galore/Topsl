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
  authorizationHeaders,
  dispatchUpstream,
  failure,
  listUpstreamModels,
  protocolModule,
  readServiceDocument,
  UpstreamError,
  type UpstreamModel,
} from "./adapters";
import {
  capabilityConfiguration,
  connectionTestRequests,
  effectiveCapabilities,
  testTool,
} from "./capabilities";
import type { RetirementOptions } from "./retirement";
import {
  routeHeaders,
  type CapabilityName,
  type CapabilityObservation,
  type Connection,
  type EffectiveCapability,
  type ConnectionKind,
  type ProxyRoute,
  type ReceiptOutcome,
  type RequestReceipt,
  type RetiredConnection,
  type RetiredRoute,
  type ServiceAuthentication,
  type ServiceManifestStatus,
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

export interface ProxyStateView {
  connections: Connection[];
  routes: ProxyRoute[];
  signIns: Array<{ id: string; connectionId: string; startedAt: string }>;
  /** Each route's applicable capability evidence, by route ID. */
  capabilities: Record<string, Record<CapabilityName, EffectiveCapability>>;
  /** History-only records of retired connections and their routes. */
  retired: {
    connections: RetiredConnection[];
    routes: RetiredRoute[];
  };
}

/** One result of the explicit connection test. */
export interface ConnectionTestResult {
  value: "supported" | "unsupported" | null;
  detail: string;
}

export type ProxyCommand =
  | {
      type: "connection-create";
      kind: ConnectionKind;
      label: string;
      endpoint?: string | null;
      protocol?: ClientProtocol;
      serviceAuth?: ServiceAuthentication;
    }
  | { type: "connection-rename"; connectionId: string; label: string }
  | { type: "connection-api-key"; connectionId: string; key: string }
  | { type: "connection-sign-in"; connectionId: string }
  | { type: "connection-sign-in-cancel"; attemptId: string }
  | { type: "connection-models"; connectionId: string }
  | { type: "connection-capabilities"; connectionId: string }
  | { type: "connection-test"; routeId: string }
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
  /** Test-only fault injection for the schema 2 upgrade. */
  retirement?: RetirementOptions;
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
      attempt: SignInAttempt;
      startedAt: string;
    }
  >();

  constructor(private options: ProxyServiceOptions) {
    this.database = new ProxyDatabase(
      options.file,
      options.key,
      options.retirement,
    );
    this.registry = new ProxyRegistry(this.database);
    this.credentials = new CredentialStore(this.database);
    this.fetch = options.fetch ?? fetch;
  }

  view(): ProxyStateView {
    const connections = this.registry.connections();
    const routes = this.registry.routes();
    const byId = new Map(connections.map((c) => [c.id, c]));
    return {
      connections,
      routes,
      capabilities: Object.fromEntries(
        routes.flatMap((route) => {
          const connection = byId.get(route.connectionId);
          return connection
            ? [[route.id, effectiveCapabilities(route, connection)]]
            : [];
        }),
      ),
      signIns: [...this.signIns.entries()].map(([id, s]) => ({
        id,
        connectionId: s.connectionId,
        startedAt: s.startedAt,
      })),
      retired: {
        connections: this.registry.retiredConnections(),
        routes: this.registry.retiredRoutes(),
      },
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
          serviceAuth: command.serviceAuth,
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
      case "connection-sign-in-cancel": {
        this.signIns.get(command.attemptId)?.attempt.cancel();
        return null;
      }
      case "connection-models":
        return this.models(command.connectionId);
      case "connection-capabilities":
        return this.readCapabilities(command.connectionId);
      case "connection-test":
        return this.testRoute(command.routeId);
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
    if (connection.kind !== "chatgpt-plan")
      throw new Error("Only a ChatGPT plan connection signs in.");
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
    let attempt: SignInAttempt;
    try {
      attempt = await beginChatGptSignIn(this.options.chatgpt ?? {}, {
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
            account: chatGptAccount(result.credential),
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
        headers: authorizationHeaders(connection, null),
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
        headers: authorizationHeaders(connection, stored.credential.key),
        identity: stored.credential.fingerprint,
      };
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
        headers: authorizationHeaders(connection, active.accessToken),
        identity: `${active.issuer}#${active.subject}#${active.clientId}`,
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
    const retired = this.registry.retiredRouteByAlias(request.model);
    if (retired) {
      receipt.routeId = retired.id;
      receipt.connectionId = retired.connectionId;
      return reject(
        410,
        failure(
          "route-changed",
          410,
          "route_retired",
          "model",
          `${retired.alias} was retired, so this request was not sent. ${retired.reason}`,
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
        connection.kind === "chatgpt-plan"
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

  /**
   * Reads an external model service's optional capability document and
   * records it. This is discovery, not a model call: nothing is billed.
   */
  private async readCapabilities(connectionId: string): Promise<{
    document: ServiceManifestStatus;
    changedRoutes: string[];
  }> {
    const connection = this.registry.requireConnection(connectionId);
    if (connection.kind !== "openai-compatible")
      throw new Error(
        "Only an external model service publishes a capability document.",
      );
    const { headers } = await this.headers(connection, false);
    let document: ServiceManifestStatus;
    try {
      document = await readServiceDocument({
        connection,
        headers,
        fetch: this.fetch,
      });
    } catch (error) {
      if (error instanceof UpstreamError)
        throw new Error(
          `The service ${error.info.kind === "authentication" ? "rejected the key" : "refused the request"} for its capability document (HTTP ${error.info.status}): ${error.info.message}`,
        );
      throw error;
    }
    const { changedRoutes } = this.registry.applyServiceDocument(
      connectionId,
      document,
    );
    return { document, changedRoutes };
  }

  /**
   * The explicit connection test: three small, billable requests on one
   * route (packages/proxy/capabilities.ts, `connectionTestPlan`). Each result
   * is recorded as probed evidence for the route's current configuration.
   * One conforming answer shows the route accepted the request, not that
   * every later answer will conform; the harness still validates them.
   */
  async testRoute(routeId: string): Promise<{
    route: ProxyRoute;
    results: Record<"streaming" | "tools" | "structuredOutput", ConnectionTestResult>;
  }> {
    const route = this.registry.route(routeId);
    if (!route) throw new Error("The route does not exist.");
    if (route.disabled) throw new Error("Turn the route on before testing it.");
    const connection = this.registry.requireConnection(route.connectionId);
    if (!["ready", "paused-usage-limit"].includes(connection.state))
      throw new Error(`${connection.label} is not ready.`);
    const requests = connectionTestRequests(route.alias);
    const configuration = capabilityConfiguration(route, connection);
    const results = {} as Record<
      "streaming" | "tools" | "structuredOutput",
      ConnectionTestResult
    >;
    const observations: Partial<Record<CapabilityName, CapabilityObservation>> =
      {};
    for (const name of ["streaming", "tools", "structuredOutput"] as const) {
      const result = await this.probe(connection, route, requests[name], name);
      results[name] = result;
      if (result.value)
        observations[name] = {
          value: result.value,
          evidence: "probed",
          source: `Topsl connection test: ${result.detail}`,
          model: route.upstreamModel,
          protocol: route.protocol,
          configuration,
          observedAt: new Date().toISOString(),
        };
    }
    return { route: this.registry.recordProbe(route.id, observations), results };
  }

  private async probe(
    connection: Connection,
    route: ProxyRoute,
    request: CanonicalRequest,
    name: "streaming" | "tools" | "structuredOutput",
  ): Promise<ConnectionTestResult> {
    const receipt: RequestReceipt = {
      id: randomUUID(),
      correlationId: `connection-test:${name}`,
      attemptId: null,
      routeId: route.id,
      routeRevision: route.revision,
      connectionId: connection.id,
      accountKey: connection.account.accountKey,
      funding: connection.funding,
      clientProtocol: route.protocol,
      upstreamProtocol: route.protocol,
      requestedModel: route.alias,
      upstreamModel: route.upstreamModel,
      reportedModel: null,
      outcome: "interrupted",
      error: null,
      usage: { input: null, output: null, cachedInput: null, reasoning: null },
      upstreamRequestId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let set = this.active.get(connection.id);
    if (!set) this.active.set(connection.id, (set = new Set()));
    set.add(controller);
    const settle = (outcome: ReceiptOutcome, error: ProxyErrorInfo | null) => {
      receipt.outcome = controller.signal.aborted ? "cancelled" : outcome;
      receipt.error = error;
      receipt.finishedAt = new Date().toISOString();
      if (!this.closed) this.registry.recordReceipt(receipt);
    };
    try {
      const auth = await this.headers(connection, false);
      const response = await dispatchUpstream(
        {
          connection,
          route,
          headers: auth.headers,
          fetch: this.fetch,
          signal: controller.signal,
        },
        request,
      );
      if (!response.ok) {
        receipt.upstreamRequestId = response.error.requestId;
        settle("failed", response.error);
        return response.error.kind === "unsupported" ||
          response.error.kind === "invalid-request"
          ? { value: "unsupported", detail: `the request was refused: ${response.error.message}` }
          : { value: null, detail: `not established: ${response.error.message}` };
      }
      receipt.upstreamRequestId = response.requestId;
      const events: CanonicalEvent[] = [];
      for await (const event of response.events) events.push(event);
      const collected = collectResponse(events);
      receipt.reportedModel = collected.model;
      receipt.usage = collected.usage;
      if (collected.error) {
        settle("failed", collected.error);
        return { value: null, detail: `not established: ${collected.error.message}` };
      }
      settle(collected.finish === "stop" || collected.finish === "tool-calls" ? "completed" : "incomplete", null);
      const text = collected.output
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      if (name === "streaming")
        return !response.streamed
          ? { value: "unsupported", detail: "the service answered a streaming request with one JSON body" }
          : text.trim()
            ? { value: "supported", detail: "a streamed answer arrived" }
            : { value: null, detail: "not established: the streamed answer was empty" };
      if (name === "tools") {
        const call = collected.output.find(
          (p) => p.type === "tool-call" && p.name === testTool.name,
        ) as { arguments: string } | undefined;
        if (!call)
          return { value: "unsupported", detail: "the answer did not call the test tool" };
        try {
          JSON.parse(call.arguments || "{}");
          return { value: "supported", detail: "the test tool was called with JSON arguments" };
        } catch {
          return { value: "unsupported", detail: "the test tool's arguments were not JSON" };
        }
      }
      try {
        const value = JSON.parse(text);
        const keys = value && typeof value === "object" ? Object.keys(value) : [];
        return typeof value?.ok === "boolean" && keys.length === 1
          ? { value: "supported", detail: "the answer matched the test schema" }
          : { value: "unsupported", detail: "the answer did not match the test schema" };
      } catch {
        return { value: "unsupported", detail: "the answer was not JSON" };
      }
    } catch (error) {
      const info =
        error instanceof UpstreamError
          ? error.info
          : failure("upstream", null, null, null, String((error as Error)?.message ?? error));
      settle("failed", info);
      return { value: null, detail: `not established: ${info.message}` };
    } finally {
      clearTimeout(timer);
      set.delete(controller);
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
