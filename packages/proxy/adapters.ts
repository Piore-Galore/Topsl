import type { SseFrame } from "./sse";
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
import {
  gatewayRouteRevisionHeader,
  type Connection,
  type ConnectionKind,
  type ProxyRoute,
  type ServiceManifestStatus,
} from "./types";
import { MAX_DOCUMENT_BYTES, parseServiceDocument } from "./capabilities";

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
      /** False when the upstream answered a streaming request with one JSON body. */
      streamed: boolean;
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

/**
 * The headers a credential becomes for each kind of upstream. An external
 * model service gets its key as a Bearer token (the default) or in
 * `x-api-key`, as the owner chose when adding it, and no key in `none` mode.
 */
export function authorizationHeaders(
  connection: Pick<Connection, "kind" | "serviceAuth">,
  secret: string | null,
): Record<string, string> {
  if (connection.kind === "anthropic-api")
    return {
      "x-api-key": secret ?? "",
      "anthropic-version": "2023-06-01",
    };
  if (connection.kind === "ollama" || !secret) return {};
  if (connection.kind === "openai-compatible") {
    const method = connection.serviceAuth ?? "bearer";
    if (method === "none") return {};
    if (method === "x-api-key") return { "x-api-key": secret };
  }
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

/**
 * Reads a body until its first non-blank text (at most 4 KB), and returns
 * that text with the whole body, unchanged, as a chunk stream.
 */
async function peekBody(body: ReadableStream<Uint8Array>): Promise<{
  head: string;
  chunks: AsyncGenerator<Uint8Array>;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const held: Uint8Array[] = [];
  let text = "";
  try {
    while (!/\S/.test(text) && text.length < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        held.push(value);
        text += decoder.decode(value, { stream: true });
      }
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      yield* held;
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { head: text.trimStart(), chunks: chunks() };
}

async function collectJson(chunks: AsyncIterable<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder("utf-8");
  let text = "";
  for await (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    return null;
  }
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

/**
 * `npm run debug` with TOPSL_DEBUG_PROXY_TRACE=1: logs each upstream stream's
 * status, content type and response header names, then each event's type,
 * and how the stream ended. Never a header value, an event's data or a
 * credential. Off unless the variable is exactly "1".
 */
async function* traceFrames(
  frames: AsyncIterable<SseFrame>,
  response: Response,
  kind: string,
): AsyncGenerator<SseFrame> {
  if (process.env.TOPSL_DEBUG_PROXY_TRACE !== "1") return yield* frames;
  const id = Math.random().toString(36).slice(2, 8);
  const write = (line: string) => process.stderr.write(`trace ${id} ${line}\n`);
  write(
    `${kind} status ${response.status} ${response.headers.get("content-type") ?? "?"} headers: ${[...response.headers.keys()].join(",")}`,
  );
  let count = 0,
    last = "";
  try {
    for await (const frame of frames) {
      count += 1;
      let type = frame.event ?? "";
      try {
        const parsed = JSON.parse(frame.data);
        if (typeof parsed?.type === "string") type = parsed.type;
      } catch {
        type = type || (frame.data === "[DONE]" ? "[DONE]" : "non-json");
      }
      if (type !== last || !/delta$/.test(type)) write(`event ${count} ${type || "(none)"}`);
      last = type;
      yield frame;
    }
    write(`ended after ${count} events`);
  } catch (error) {
    write(`stream error after ${count} events: ${error instanceof Error ? error.name : "unknown"}`);
    throw error;
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
      upstream: true,
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
      `${connection.endpoint}${connection.kind === "openai-compatible" ? { responses: "/responses", messages: "/messages", chat: "/chat/completions" }[route.protocol] : paths[connection.kind]}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(route.protocol === "messages"
            ? { "anthropic-version": "2023-06-01" }
            : {}),
          ...(route.remotePin
            ? { [gatewayRouteRevisionHeader]: route.remotePin.routeRevision }
            : {}),
          ...call.headers,
        },
        body: JSON.stringify(body),
        signal: call.signal,
        redirect: "error",
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
    if (route.remotePin && response.status === 409)
      // Surfaced as it is: Topsl neither fetches a new revision nor replays.
      return {
        ok: false,
        error: failure(
          "route-changed",
          409,
          "gateway_route_revision_mismatch",
          "model",
          `The external service refused pinned route revision ${route.remotePin.routeRevision}: its route changed after this route was saved. Read its capabilities again and start a new task.`,
          false,
          requestId,
        ),
      };
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
  if (route.remotePin) {
    // Checked before any body is read, so a wrong answer delivers nothing,
    // tool calls included.
    const echoed = response.headers.get(gatewayRouteRevisionHeader);
    if (echoed !== route.remotePin.routeRevision) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        // 502, not the upstream's 200: the local client must see a failure.
        error: failure(
          "upstream",
          502,
          "gateway_route_revision_unconfirmed",
          null,
          echoed
            ? `The external service answered on route revision ${echoed.slice(0, 200)}, not the pinned ${route.remotePin.routeRevision}. Topsl discarded the answer. The service may already have run the request, so it is not repeated.`
            : `The external service did not confirm pinned route revision ${route.remotePin.routeRevision}. Topsl discarded the answer. The service may already have run the request, so it is not repeated.`,
          false,
          requestId,
        ),
      };
    }
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
  // A declared event stream is read as one. So is a body with no or an
  // unrecognised content type that does not start like JSON: OpenAI's
  // ChatGPT-plan route answered Topsl's streaming requests with 200 and no
  // Content-Type at all (observed live on 6 November 2026), and reading that
  // stream as one JSON document lost every event.
  const declaredStream = type.includes("text/event-stream");
  let json: unknown = null;
  if (declaredStream || !/json/i.test(type)) {
    const peeked = await peekBody(response.body);
    if (declaredStream || !/^[{[]/.test(peeked.head))
      return {
        ok: true,
        requestId,
        streamed: true,
        events: withRequestId(
          module.readStream(
            traceFrames(parseSse(peeked.chunks), response, connection.kind),
          ),
          requestId,
        ),
      };
    json = await collectJson(peeked.chunks);
  } else json = await response.json().catch(() => null);
  // Some gateways answer a streaming request with one JSON body.
  if (process.env.TOPSL_DEBUG_PROXY_TRACE === "1")
    process.stderr.write(
      `trace ${connection.kind} status ${response.status} ${type || "no content-type"} JSON body ${json === null || typeof json !== "object" ? "unreadable" : `keys: ${Object.keys(json).join(",")}`}\n`,
    );
  const events = json === null ? [] : module.readResponse(json);
  return {
    ok: true,
    requestId,
    streamed: false,
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
  const models: UpstreamModel[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${connection.endpoint}/models`);
    if (cursor) url.searchParams.set("after_id", cursor);
    const response = await input.fetch(url.toString(), {
      headers: {
        accept: "application/json",
        ...(connection.protocol === "messages"
          ? { "anthropic-version": "2023-06-01" }
          : {}),
        ...input.headers,
      },
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new UpstreamError(
        classifyHttpError(
          connection.kind,
          response.status,
          await response.text().catch(() => ""),
          requestIdOf(response.headers),
        ),
      );
    const body = (await response.json()) as any;
    if (connection.kind === "chatgpt-plan") {
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
    for (const m of data) {
      const id = m?.id ?? m?.name;
      if (typeof id === "string" && !models.some((old) => old.id === id))
        models.push({
          id,
          name: m.display_name ?? m.name ?? id,
          source: `${connection.kind} /v1/models`,
        });
    }
    if (!body.has_more) return models;
    if (
      typeof body.last_id !== "string" ||
      !body.last_id ||
      cursors.has(body.last_id)
    )
      throw new Error(
        "The model catalog returned an invalid pagination cursor.",
      );
    cursor = body.last_id;
    cursors.add(body.last_id);
  }
  throw new Error("The model catalog exceeded the pagination limit.");
}

/**
 * Reads an external model service's optional capability document,
 * `GET <inference base>/gateway/capabilities`. A 404 or 501, a malformed or
 * future-version document, or an unreachable service leaves capabilities
 * unknown. A 401 or 403 is an authentication or permission rejection and is
 * thrown as one; Topsl never substitutes another credential.
 */
export async function readServiceDocument(input: {
  connection: Connection;
  headers: Record<string, string>;
  fetch: typeof fetch;
}): Promise<ServiceManifestStatus> {
  const checkedAt = new Date().toISOString();
  const unavailable = (detail: string): ServiceManifestStatus => ({
    state: "unavailable",
    checkedAt,
    detail,
    gatewayId: null,
    revision: null,
    routes: [],
  });
  let response: Response;
  try {
    response = await input.fetch(
      `${input.connection.endpoint}/gateway/capabilities`,
      {
        headers: { accept: "application/json", ...input.headers },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      },
    );
  } catch (error) {
    return unavailable(`The service could not be reached: ${message(error)}`);
  }
  if (response.status === 401 || response.status === 403)
    throw new UpstreamError(
      classifyHttpError(
        input.connection.kind,
        response.status,
        await response.text().catch(() => ""),
        requestIdOf(response.headers),
      ),
    );
  if (response.status === 404 || response.status === 501) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ...unavailable("The service publishes no capability document."),
      state: "absent",
    };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return unavailable(`The capability document returned HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ...unavailable("The capability document is larger than 1 MB."),
      state: "unrecognized",
    };
  }
  const text = await response.text().catch(() => null);
  if (text === null) return unavailable("The capability document could not be read.");
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
    return {
      ...unavailable("The capability document is larger than 1 MB."),
      state: "unrecognized",
    };
  return parseServiceDocument(text, checkedAt);
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
