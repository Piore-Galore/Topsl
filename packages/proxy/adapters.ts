import type {
  CanonicalEvent,
  CanonicalRequest,
  ClientProtocol,
  ProxyErrorInfo,
  ProxyErrorKind,
} from "./canonical";
import { UnsupportedConversion } from "./canonical";
import { parseSse } from "./sse";
import * as responses from "./protocols/responses";
import * as messages from "./protocols/messages";
import * as chat from "./protocols/chat";
import type { Connection, ConnectionKind, ProxyRoute } from "./types";

/**
 * Upstream adapters (docs/Native_Harness_Plan.md §2). An adapter turns a
 * canonical request into one HTTP request to its upstream and reads the reply
 * back into canonical events. It never executes tools, never retries a model
 * request and never changes account or funding: failures are classified and
 * returned for the harness to decide.
 */

export const protocols = { responses, messages, chat } as const;
export function protocolModule(protocol: ClientProtocol) {
  return protocols[protocol];
}

export interface UpstreamModel {
  id: string;
  name: string;
  /** Where the entry came from, kept as capability evidence. */
  source: string;
}

export interface UpstreamCall {
  connection: Connection;
  route: ProxyRoute;
  /** Headers that authenticate this request (never logged). */
  headers: Record<string, string>;
  fetch: typeof fetch;
  signal: AbortSignal;
}

export type UpstreamResponse =
  | {
      ok: true;
      events: AsyncGenerator<CanonicalEvent>;
      requestId: string | null;
    }
  | { ok: false; error: ProxyErrorInfo };

/** Anthropic requires a token cap on every request; this is used when the client set none. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16_384;

const paths: Record<ConnectionKind, string> = {
  "chatgpt-plan": "/responses",
  "openai-api": "/responses",
  "anthropic-api": "/messages",
  "openai-compatible": "/chat/completions",
  ollama: "/chat/completions",
};

/** The headers a credential becomes for each kind of upstream. */
export function authorizationHeaders(
  kind: ConnectionKind,
  secret: string | null,
): Record<string, string> {
  if (kind === "anthropic-api")
    return {
      "x-api-key": secret ?? "",
      "anthropic-version": "2023-06-01",
    };
  if (kind === "ollama" || !secret) return {};
  return { authorization: `Bearer ${secret}` };
}

function requestIdOf(headers: Headers): string | null {
  return (
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("x-amzn-requestid") ??
    null
  );
}

async function* bodyChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Sends one request upstream. Pre-stream failures come back classified. */
export async function dispatchUpstream(
  call: UpstreamCall,
  request: CanonicalRequest,
): Promise<UpstreamResponse> {
  const { connection, route } = call;
  const module = protocolModule(route.protocol);
  let body: Record<string, unknown>;
  try {
    body = module.serializeRequest(request, {
      model: route.upstreamModel,
      profile: connection.kind,
      defaultMaxOutputTokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
    });
  } catch (error) {
    if (error instanceof UnsupportedConversion)
      return {
        ok: false,
        error: failure("unsupported", null, null, error.param, error.message),
      };
    throw error;
  }
  let response: Response;
  try {
    response = await call.fetch(
      `${connection.endpoint}${paths[connection.kind]}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...call.headers,
        },
        body: JSON.stringify(body),
        signal: call.signal,
      },
    );
  } catch (error) {
    if (call.signal.aborted)
      return {
        ok: false,
        error: failure(
          "interrupted",
          null,
          null,
          null,
          "The request was cancelled.",
        ),
      };
    return {
      ok: false,
      error: failure(
        "unavailable",
        null,
        null,
        null,
        `The upstream could not be reached: ${message(error)}`,
        true,
      ),
    };
  }
  const requestId = requestIdOf(response.headers);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: classifyHttpError(
        connection.kind,
        response.status,
        text,
        requestId,
      ),
    };
  }
  const type = response.headers.get("content-type") ?? "";
  if (!response.body)
    return {
      ok: false,
      error: failure(
        "upstream",
        response.status,
        null,
        null,
        "The upstream sent no body.",
        false,
        requestId,
      ),
    };
  if (type.includes("text/event-stream"))
    return {
      ok: true,
      requestId,
      events: withRequestId(
        module.readStream(parseSse(bodyChunks(response.body))),
        requestId,
      ),
    };
  // Some gateways answer a streaming request with one JSON body.
  const json = await response.json().catch(() => null);
  const events = json === null ? [] : module.readResponse(json);
  return {
    ok: true,
    requestId,
    events: withRequestId(
      (async function* () {
        yield* events;
      })(),
      requestId,
    ),
  };
}

async function* withRequestId(
  events: AsyncGenerator<CanonicalEvent>,
  requestId: string | null,
): AsyncGenerator<CanonicalEvent> {
  for await (const event of events)
    yield event.type === "error" && !event.error.requestId
      ? { ...event, error: { ...event.error, requestId } }
      : event;
}

/** Lists the models a connection's own account can use. */
export async function listUpstreamModels(input: {
  connection: Connection;
  headers: Record<string, string>;
  fetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<UpstreamModel[]> {
  const { connection } = input;
  const response = await input.fetch(`${connection.endpoint}/models`, {
    headers: { accept: "application/json", ...input.headers },
    signal: input.signal,
  });
  if (!response.ok) {
    const error = classifyHttpError(
      connection.kind,
      response.status,
      await response.text().catch(() => ""),
      requestIdOf(response.headers),
    );
    throw new UpstreamError(error);
  }
  const body = (await response.json()) as any;
  if (connection.kind === "chatgpt-plan") {
    // The plan route lists `models` with `slug`, `display_name` and
    // `visibility`; only `visibility: "list"` entries are offered.
    if (!Array.isArray(body?.models))
      throw new Error("The ChatGPT plan model list had an unexpected shape.");
    return body.models
      .filter(
        (m: any) => m?.visibility === "list" && typeof m.slug === "string",
      )
      .map((m: any) => ({
        id: m.slug,
        name: typeof m.display_name === "string" ? m.display_name : m.slug,
        source: "chatgpt-plan /v1/models",
      }));
  }
  const data = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : null;
  if (!data) throw new Error("The model list had an unexpected shape.");
  return data
    .filter((m: any) => typeof (m?.id ?? m?.name) === "string")
    .map((m: any) => ({
      id: m.id ?? m.name,
      name: m.display_name ?? m.name ?? m.id,
      source: `${connection.kind} /v1/models`,
    }));
}

export class UpstreamError extends Error {
  constructor(readonly info: ProxyErrorInfo) {
    super(info.message);
    this.name = "UpstreamError";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failure(
  kind: ProxyErrorKind,
  status: number | null,
  code: string | null,
  param: string | null,
  text: string,
  retryable = false,
  requestId: string | null = null,
): ProxyErrorInfo {
  return { kind, status, code, param, message: text, retryable, requestId };
}

const chatGptCodes: Record<string, [ProxyErrorKind, boolean]> = {
  subscription_sharing_user_not_eligible: ["permission", false],
  subscription_sharing_usage_limit_exceeded: ["quota", false],
  subscription_sharing_usage_unavailable: ["unavailable", true],
  subscription_sharing_unsupported_capability: ["unsupported", false],
  subscription_sharing_route_not_supported: ["permission", false],
  subscription_sharing_invalid_user: ["authentication", false],
  chatpass_v2_scope_not_authorized: ["permission", false],
  chatpass_v2_invalid_authorization_context: ["permission", false],
  subscription_sharing_user_unavailable: ["unavailable", true],
};

/**
 * Classifies a pre-stream HTTP failure. The codes and statuses follow each
 * provider's documentation; anything unrecognized stays an upstream failure
 * with its exact status, code and request ID.
 */
export function classifyHttpError(
  kind: ConnectionKind,
  status: number,
  text: string,
  requestId: string | null,
): ProxyErrorInfo {
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const error = body?.error ?? null;
  const code: string | null =
    (typeof error?.code === "string" && error.code) ||
    (typeof error?.type === "string" && error.type) ||
    null;
  const param: string | null =
    typeof error?.param === "string" ? error.param : null;
  // The plan route may answer `{"detail": "..."}`: diagnostic text, not a code.
  const detail =
    (typeof error?.message === "string" && error.message) ||
    (typeof body?.detail === "string" && body.detail) ||
    (text && text.length < 500 ? text : "") ||
    `HTTP ${status}`;
  if (kind === "chatgpt-plan" && code && chatGptCodes[code]) {
    const [errorKind, retryable] = chatGptCodes[code];
    return failure(
      errorKind,
      status,
      code,
      param,
      detail,
      retryable,
      requestId,
    );
  }
  if (status === 401)
    return failure(
      "authentication",
      status,
      code,
      param,
      detail,
      false,
      requestId,
    );
  if (status === 403)
    return failure("permission", status, code, param, detail, false, requestId);
  if (status === 404)
    return failure("not-found", status, code, param, detail, false, requestId);
  if (status === 429) {
    // A plan usage limit or an exhausted API balance pauses; a rate limit may
    // pass. Neither is retried by the proxy.
    if (kind === "chatgpt-plan" || code === "insufficient_quota")
      return failure("quota", status, code, param, detail, false, requestId);
    return failure("unavailable", status, code, param, detail, true, requestId);
  }
  if (status === 400 || status === 422)
    return failure(
      code?.includes("unsupported") ? "unsupported" : "invalid-request",
      status,
      code,
      param,
      detail,
      false,
      requestId,
    );
  if (status >= 500)
    return failure("unavailable", status, code, param, detail, true, requestId);
  return failure("upstream", status, code, param, detail, false, requestId);
}
