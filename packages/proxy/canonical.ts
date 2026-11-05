/**
 * The proxy's protocol-neutral model (docs/Native_Harness_Plan.md §2).
 *
 * Every client request (Responses, Messages or Chat Completions) is parsed
 * into a CanonicalRequest, and every upstream stream is read into
 * CanonicalEvents. Converters reject what they cannot carry exactly rather
 * than dropping tool calls, reasoning controls, images or continuation state.
 */

/** The three client-facing protocols the local proxy serves. */
export type ClientProtocol = "responses" | "messages" | "chat";

export interface CanonicalTextPart {
  type: "text";
  text: string;
}
export interface CanonicalImagePart {
  type: "image";
  /** For example `image/png`. */
  mediaType: string | null;
  /** Base64 bytes, when the image is inline. */
  data: string | null;
  /** A URL (https or data:), when the image is referenced. */
  url: string | null;
}
export interface CanonicalToolCallPart {
  type: "tool-call";
  /** The provider's call ID; tool results quote it exactly. */
  id: string;
  name: string;
  /** Complete JSON argument text, exactly as the model produced it. */
  arguments: string;
}
export interface CanonicalToolResultPart {
  type: "tool-result";
  callId: string;
  output: string;
  isError: boolean;
}
/**
 * Model reasoning. `opaque` is provider-private continuation (encrypted
 * reasoning content, a thinking signature) that only the protocol that
 * produced it can accept; converters refuse to send it anywhere else.
 */
export interface CanonicalReasoningPart {
  type: "reasoning";
  text: string | null;
  opaque: { protocol: ClientProtocol; value: unknown } | null;
}
export type CanonicalPart =
  | CanonicalTextPart
  | CanonicalImagePart
  | CanonicalToolCallPart
  | CanonicalToolResultPart
  | CanonicalReasoningPart;

/**
 * One conversation message. Tool results are carried as `tool-result` parts
 * of a `user` message, the way Messages carries them; the Responses and Chat
 * converters split them into their own items.
 */
export interface CanonicalMessage {
  role: "user" | "assistant";
  parts: CanonicalPart[];
}

/** A function tool the client declares. Hosted tools are not representable. */
export interface CanonicalTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
}

export type CanonicalToolChoice =
  "auto" | "none" | "required" | { name: string };

export interface CanonicalRequest {
  /** The client-facing model alias. The router resolves it to a route. */
  model: string;
  /** System or developer instructions, merged in order. */
  instructions: string | null;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  toolChoice: CanonicalToolChoice;
  /** Null when the client set no value. */
  maxOutputTokens: number | null;
  temperature: number | null;
  topP: number | null;
  stop: string[];
  /** A provider reasoning level such as `low` or `high`; null for the default. */
  reasoningEffort: string | null;
  /** Anthropic extended-thinking budget, when the client set one. */
  thinkingBudget: number | null;
  parallelToolCalls: boolean | null;
  stream: boolean;
  /** The protocol the client spoke. */
  clientProtocol: ClientProtocol;
}

/** Why an upstream stopped. */
export type FinishReason =
  "stop" | "tool-calls" | "length" | "content-filter" | "other";

export interface CanonicalUsage {
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  reasoning: number | null;
}

/** Classes of failure the harness, not the proxy, decides how to retry. */
export type ProxyErrorKind =
  | "authentication"
  | "permission"
  | "quota"
  | "unavailable"
  | "invalid-request"
  | "unsupported"
  | "route-changed"
  | "not-found"
  | "interrupted"
  | "upstream";

export interface ProxyErrorInfo {
  kind: ProxyErrorKind;
  /** The upstream HTTP status, when there was one. */
  status: number | null;
  /** The upstream's exact error code, such as `subscription_sharing_usage_limit_exceeded`. */
  code: string | null;
  /** The upstream's `error.param`, when it named one. */
  param: string | null;
  message: string;
  /** Whether a bounded retry on the same route could help. The proxy never retries itself. */
  retryable: boolean;
  /** The upstream request ID, recorded for every failure. */
  requestId: string | null;
}

/**
 * One event of a model response. `index` numbers output parts in order.
 * A well-formed stream ends with exactly one `finish` or `error`.
 */
export type CanonicalEvent =
  | { type: "response-start"; responseId: string | null; model: string | null }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "reasoning-opaque"; index: number; value: unknown }
  | { type: "tool-call-start"; index: number; id: string; name: string }
  | { type: "tool-call-delta"; index: number; argumentsDelta: string }
  | { type: "part-end"; index: number }
  | ({ type: "usage" } & CanonicalUsage)
  | { type: "finish"; reason: FinishReason; rawReason: string | null }
  | { type: "error"; error: ProxyErrorInfo };

/** A complete response, assembled from a stream. */
export interface CanonicalResponse {
  responseId: string | null;
  model: string | null;
  output: CanonicalPart[];
  finish: FinishReason | null;
  rawFinishReason: string | null;
  usage: CanonicalUsage;
  error: ProxyErrorInfo | null;
}

/** A conversion the proxy cannot perform exactly. */
export class UnsupportedConversion extends Error {
  constructor(
    message: string,
    readonly param: string | null = null,
  ) {
    super(message);
    this.name = "UnsupportedConversion";
  }
}

export const emptyUsage = (): CanonicalUsage => ({
  input: null,
  output: null,
  cachedInput: null,
  reasoning: null,
});

/**
 * Assembles canonical events into one response. Tool-call arguments are
 * concatenated in order; a stream with no terminal event is recorded as
 * interrupted, never as complete.
 */
export function collectResponse(events: CanonicalEvent[]): CanonicalResponse {
  const response: CanonicalResponse = {
    responseId: null,
    model: null,
    output: [],
    finish: null,
    rawFinishReason: null,
    usage: emptyUsage(),
    error: null,
  };
  const parts = new Map<number, CanonicalPart>();
  let terminal = false;
  for (const event of events) {
    switch (event.type) {
      case "response-start":
        response.responseId = event.responseId ?? response.responseId;
        response.model = event.model ?? response.model;
        break;
      case "text-delta": {
        const part = parts.get(event.index);
        if (part?.type === "text") part.text += event.text;
        else parts.set(event.index, { type: "text", text: event.text });
        break;
      }
      case "reasoning-delta": {
        const part = parts.get(event.index);
        if (part?.type === "reasoning")
          part.text = (part.text ?? "") + event.text;
        else
          parts.set(event.index, {
            type: "reasoning",
            text: event.text,
            opaque: null,
          });
        break;
      }
      case "reasoning-opaque": {
        const part = parts.get(event.index);
        const opaque = event.value as CanonicalReasoningPart["opaque"];
        if (part?.type === "reasoning") part.opaque = opaque;
        else parts.set(event.index, { type: "reasoning", text: null, opaque });
        break;
      }
      case "tool-call-start":
        parts.set(event.index, {
          type: "tool-call",
          id: event.id,
          name: event.name,
          arguments: "",
        });
        break;
      case "tool-call-delta": {
        const part = parts.get(event.index);
        if (part?.type === "tool-call") part.arguments += event.argumentsDelta;
        break;
      }
      case "usage":
        response.usage = {
          input: event.input ?? response.usage.input,
          output: event.output ?? response.usage.output,
          cachedInput: event.cachedInput ?? response.usage.cachedInput,
          reasoning: event.reasoning ?? response.usage.reasoning,
        };
        break;
      case "finish":
        response.finish = event.reason;
        response.rawFinishReason = event.rawReason;
        terminal = true;
        break;
      case "error":
        response.error = event.error;
        terminal = true;
        break;
      case "part-end":
        break;
    }
  }
  response.output = [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, part]) => part);
  if (!terminal)
    response.error = {
      kind: "interrupted",
      status: null,
      code: null,
      param: null,
      message: "The model stream ended before a terminal event.",
      retryable: true,
      requestId: null,
    };
  return response;
}
