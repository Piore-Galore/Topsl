import type {
  CanonicalEvent,
  CanonicalRequest,
  ProxyErrorInfo,
} from "../proxy/canonical";
import {
  protocolModule,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
} from "../proxy/adapters";
import { parseSse } from "../proxy/sse";
import { routeHeaders } from "../proxy/types";
import type { ExecutionBinding } from "./types";

/**
 * The harness's client for the Topsl local proxy. It speaks the route's own
 * protocol (Responses for OpenAI routes, Messages for Anthropic, Chat
 * Completions for gateways and local models) and sends the attempt's frozen
 * route revision, so a changed route is refused before any upstream request.
 */

export interface ModelStreamInput {
  binding: ExecutionBinding;
  request: CanonicalRequest;
  attemptId: string;
  correlationId: string;
  signal: AbortSignal;
}

export interface ModelClient {
  stream(input: ModelStreamInput): AsyncGenerator<CanonicalEvent>;
}

export interface ProxyEndpoint {
  port: number;
  token: string;
}

const paths = {
  responses: "/v1/responses",
  messages: "/v1/messages",
  chat: "/v1/chat/completions",
} as const;

function unavailable(message: string): ProxyErrorInfo {
  return {
    kind: "unavailable",
    status: null,
    code: "proxy_unavailable",
    param: null,
    message,
    retryable: true,
    requestId: null,
  };
}

async function* chunks(
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

export class ProxyModelClient implements ModelClient {
  constructor(
    private endpoint: () => ProxyEndpoint | null,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async *stream(input: ModelStreamInput): AsyncGenerator<CanonicalEvent> {
    const native = input.binding.native;
    if (!native)
      throw new Error("A native model request needs a native binding.");
    const endpoint = this.endpoint();
    if (!endpoint) {
      yield {
        type: "error",
        error: unavailable("The Topsl proxy is not running."),
      };
      return;
    }
    const module = protocolModule(native.protocol);
    let body: Record<string, unknown>;
    try {
      body = module.serializeRequest(
        {
          ...input.request,
          model: native.routeAlias,
          clientProtocol: native.protocol,
        },
        {
          model: native.routeAlias,
          profile: native.connectionKind,
          defaultMaxOutputTokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
        },
      );
    } catch (error) {
      yield {
        type: "error",
        error: {
          kind: "unsupported",
          status: null,
          code: "unsupported_conversion",
          param: (error as { param?: string }).param ?? null,
          message: (error as Error).message,
          retryable: false,
          requestId: null,
        },
      };
      return;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(
        `http://127.0.0.1:${endpoint.port}${paths[native.protocol]}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${endpoint.token}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            [routeHeaders.routeRevision]: native.routeRevision,
            [routeHeaders.correlation]: input.correlationId,
            [routeHeaders.attempt]: input.attemptId,
          },
          body: JSON.stringify(body),
          signal: input.signal,
        },
      );
    } catch (error) {
      if (input.signal.aborted) {
        yield {
          type: "error",
          error: {
            ...unavailable("The request was cancelled."),
            kind: "interrupted",
            retryable: false,
          },
        };
        return;
      }
      yield {
        type: "error",
        error: unavailable(
          `The Topsl proxy could not be reached: ${(error as Error).message}`,
        ),
      };
      return;
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let info: ProxyErrorInfo | null = null;
      try {
        info = JSON.parse(text)?.topsl_error ?? null;
      } catch {
        info = null;
      }
      yield {
        type: "error",
        error: info ?? {
          kind:
            response.status === 409
              ? "route-changed"
              : response.status >= 500
                ? "unavailable"
                : "upstream",
          status: response.status,
          code: null,
          param: null,
          message: text.slice(0, 1000) || `HTTP ${response.status}`,
          retryable: response.status >= 500,
          requestId: null,
        },
      };
      return;
    }
    yield* module.readStream(parseSse(chunks(response.body)));
  }
}
