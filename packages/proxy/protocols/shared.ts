import {
  UnsupportedConversion,
  type CanonicalEvent,
  type CanonicalImagePart,
  type CanonicalMessage,
  type CanonicalPart,
  type CanonicalReasoningPart,
  type CanonicalRequest,
  type CanonicalUsage,
  type ClientProtocol,
  type ProxyErrorInfo,
  type ProxyErrorKind,
} from "../canonical";
import type { SseFrame } from "../sse";

/**
 * Helpers the Responses, Messages and Chat Completions converters share
 * (docs/Native_Harness_Plan.md §2, "Local proxy interface"): strict request
 * field readers, reasoning-continuation checks, image and tool-argument
 * conversion, error classification and part ordering for stream writers.
 */

export type JsonObject = Record<string, unknown>;

const protocols: readonly ClientProtocol[] = ["responses", "messages", "chat"];

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a request field is set. OpenAI and Anthropic clients send `null`
 * and omit a field interchangeably, so `null` counts as absent everywhere.
 */
export function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Throws the conversion error every converter reports. */
export function reject(message: string, param: string | null): never {
  throw new UnsupportedConversion(message, param);
}

/** Builds a request path such as `input[2].content[0].file_id`. */
export function path(prefix: string, key: string | number): string {
  if (typeof key === "number") return `${prefix}[${key}]`;
  return prefix ? `${prefix}.${key}` : key;
}

export function expectObject(value: unknown, param: string): JsonObject {
  if (!isObject(value)) reject(`\`${param}\` must be an object.`, param);
  return value;
}

export function expectArray(value: unknown, param: string): unknown[] {
  if (!Array.isArray(value)) reject(`\`${param}\` must be an array.`, param);
  return value;
}

export function expectString(value: unknown, param: string): string {
  if (typeof value !== "string")
    reject(`\`${param}\` must be a string.`, param);
  return value;
}

export function optionalString(value: unknown, param: string): string | null {
  return isSet(value) ? expectString(value, param) : null;
}

export function optionalNumber(value: unknown, param: string): number | null {
  if (!isSet(value)) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    reject(`\`${param}\` must be a number.`, param);
  return value;
}

/** A positive token count such as `max_tokens`. */
export function optionalCount(value: unknown, param: string): number | null {
  const number = optionalNumber(value, param);
  if (number !== null && (!Number.isInteger(number) || number < 1))
    reject(`\`${param}\` must be a positive integer.`, param);
  return number;
}

export function optionalBoolean(value: unknown, param: string): boolean | null {
  if (!isSet(value)) return null;
  if (typeof value !== "boolean")
    reject(`\`${param}\` must be a boolean.`, param);
  return value;
}

/**
 * Rejects every set field that is not in `allowed`, naming it as `param`.
 * Fields in `rejected` get the stated reason; anything else is unknown, and
 * an unknown field is refused because the proxy cannot know what it would
 * have controlled.
 */
export function checkFields(
  object: JsonObject,
  allowed: readonly string[],
  prefix: string,
  rejected: Readonly<Record<string, string>> = {},
): void {
  for (const [key, value] of Object.entries(object)) {
    if (!isSet(value)) continue;
    const param = path(prefix, key);
    if (Object.hasOwn(rejected, key))
      reject(`\`${param}\` is not supported: ${rejected[key]}`, param);
    if (!allowed.includes(key))
      reject(
        `\`${param}\` is not supported by the local proxy, which refuses fields it cannot carry exactly.`,
        param,
      );
  }
}

/** Canonical request fields, for naming the client's own parameter in errors. */
export type CanonicalField =
  | "instructions"
  | "messages"
  | "tools"
  | "toolChoice"
  | "maxOutputTokens"
  | "temperature"
  | "topP"
  | "stop"
  | "reasoningEffort"
  | "thinkingBudget"
  | "parallelToolCalls";

const clientParams: Record<ClientProtocol, Record<CanonicalField, string>> = {
  responses: {
    instructions: "instructions",
    messages: "input",
    tools: "tools",
    toolChoice: "tool_choice",
    maxOutputTokens: "max_output_tokens",
    temperature: "temperature",
    topP: "top_p",
    stop: "stop",
    reasoningEffort: "reasoning.effort",
    thinkingBudget: "thinking",
    parallelToolCalls: "parallel_tool_calls",
  },
  messages: {
    instructions: "system",
    messages: "messages",
    tools: "tools",
    toolChoice: "tool_choice",
    maxOutputTokens: "max_tokens",
    temperature: "temperature",
    topP: "top_p",
    stop: "stop_sequences",
    reasoningEffort: "reasoning_effort",
    thinkingBudget: "thinking.budget_tokens",
    parallelToolCalls: "tool_choice.disable_parallel_tool_use",
  },
  chat: {
    instructions: "messages",
    messages: "messages",
    tools: "tools",
    toolChoice: "tool_choice",
    maxOutputTokens: "max_tokens",
    temperature: "temperature",
    topP: "top_p",
    stop: "stop",
    reasoningEffort: "reasoning_effort",
    thinkingBudget: "thinking",
    parallelToolCalls: "parallel_tool_calls",
  },
};

/**
 * The name the client used for a canonical field, so a serializer's
 * rejection names a parameter the client actually sent.
 */
export function clientParam(
  request: CanonicalRequest,
  field: CanonicalField,
): string {
  return clientParams[request.clientProtocol][field];
}

// ---------------------------------------------------------------------------
// Messages and parts

/**
 * Removes reasoning the target protocol cannot accept: parts whose opaque
 * continuation came from another protocol, and parts with none at all.
 * Serializers refuse such parts, so a caller that knowingly moves a
 * conversation to another route calls this first. A message left empty is
 * dropped.
 */
export function withoutForeignReasoning(
  messages: CanonicalMessage[],
  protocol: ClientProtocol,
): CanonicalMessage[] {
  const kept: CanonicalMessage[] = [];
  for (const message of messages) {
    const parts = message.parts.filter(
      (part) => part.type !== "reasoning" || part.opaque?.protocol === protocol,
    );
    if (parts.length === message.parts.length) kept.push(message);
    else if (parts.length > 0) kept.push({ ...message, parts });
  }
  return kept;
}

/**
 * The opaque continuation of a reasoning part, when it belongs to
 * `protocol`; otherwise the conversion is refused rather than dropping it.
 */
export function ownReasoning(
  part: CanonicalReasoningPart,
  protocol: ClientProtocol,
  param: string,
): unknown {
  if (!part.opaque)
    reject(
      `A reasoning part has no ${protocol} continuation state, so it cannot be sent back to a ${protocol} upstream. Remove it (withoutForeignReasoning) before changing route.`,
      param,
    );
  if (part.opaque.protocol !== protocol)
    reject(
      `A reasoning part carries ${part.opaque.protocol} continuation state, which a ${protocol} upstream cannot accept. Remove it (withoutForeignReasoning) before changing route.`,
      param,
    );
  return part.opaque.value;
}

/** Validates the `value` of a `reasoning-opaque` event. */
export function opaqueOf(value: unknown): CanonicalReasoningPart["opaque"] {
  if (
    isObject(value) &&
    typeof value.protocol === "string" &&
    (protocols as readonly string[]).includes(value.protocol)
  )
    return { protocol: value.protocol as ClientProtocol, value: value.value };
  return null;
}

const envelopePrefix = "topsl-reasoning.v1.";

/**
 * Wraps a reasoning part that the client's protocol cannot carry natively
 * (another protocol's continuation, or none) into the client protocol's own
 * opaque field: a Responses `encrypted_content` or a Messages thinking
 * `signature`. When the client sends the item back, the parser restores the
 * original part, so the serializer still sees the producing protocol and
 * refuses it on any other route. The envelope also carries the exact text,
 * because a thinking signature only verifies the text it was issued for.
 */
export function encodeReasoningEnvelope(part: CanonicalReasoningPart): string {
  return (
    envelopePrefix +
    Buffer.from(
      JSON.stringify({ text: part.text, opaque: part.opaque }),
      "utf8",
    ).toString("base64url")
  );
}

/** Restores a part from `encodeReasoningEnvelope`, or null for other values. */
export function decodeReasoningEnvelope(
  value: string,
  param: string,
): CanonicalReasoningPart | null {
  if (!value.startsWith(envelopePrefix)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice(envelopePrefix.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    reject("A Topsl reasoning envelope is malformed.", param);
  }
  if (
    !isObject(decoded) ||
    !(decoded.text === null || typeof decoded.text === "string") ||
    !(decoded.opaque === null || opaqueOf(decoded.opaque))
  )
    reject("A Topsl reasoning envelope is malformed.", param);
  return {
    type: "reasoning",
    text: decoded.text as string | null,
    opaque: decoded.opaque === null ? null : opaqueOf(decoded.opaque),
  };
}

/**
 * Joins adjacent messages of the same role. Messages requires alternating
 * turns, and Chat requires an assistant's parallel tool calls in one message
 * followed by all their results.
 */
export function mergeAdjacentRoles(
  messages: CanonicalMessage[],
): CanonicalMessage[] {
  const merged: CanonicalMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last && last.role === message.role)
      merged[merged.length - 1] = {
        role: last.role,
        parts: [...last.parts, ...message.parts],
      };
    else merged.push(message);
  }
  return merged;
}

/**
 * Moves tool results ahead of a user turn's other content, keeping their
 * order. Both Messages and Chat require the results to follow the calls
 * directly; they answer the previous turn, so this changes no meaning.
 */
export function toolResultsFirst(parts: CanonicalPart[]): CanonicalPart[] {
  return [
    ...parts.filter((part) => part.type === "tool-result"),
    ...parts.filter((part) => part.type !== "tool-result"),
  ];
}

/** Splits a `data:` URL into media type and base64 bytes. */
export function parseDataUrl(
  url: string,
): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

/** An image as a URL (https or data:), as Responses and Chat carry it. */
export function imageUrl(part: CanonicalImagePart, param: string): string {
  if (part.url) return part.url;
  if (part.data !== null && part.mediaType)
    return `data:${part.mediaType};base64,${part.data}`;
  reject("An image has neither a URL nor inline data with a type.", param);
}

/** An image as inline base64, when it is inline or a data: URL. */
export function imageBase64(
  part: CanonicalImagePart,
): { mediaType: string; data: string } | null {
  if (part.data !== null && part.mediaType)
    return { mediaType: part.mediaType, data: part.data };
  return part.url ? parseDataUrl(part.url) : null;
}

/**
 * Parses tool-call argument text into the object Messages requires. Empty
 * text is a call with no arguments, which Chat gateways sometimes produce.
 */
export function argumentsObject(text: string, param: string): JsonObject {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    reject("Tool-call arguments are not valid JSON.", param);
  }
  if (!isObject(value))
    reject("Tool-call arguments must be a JSON object.", param);
  return value;
}

/**
 * Text from an array of text blocks (a tool result or system prompt), for
 * fields the canonical model keeps as one string. Any other block type is
 * refused; blocks are joined with a newline.
 */
export function joinTextBlocks(
  blocks: unknown[],
  param: string,
  textTypes: readonly string[],
): string {
  return blocks
    .map((block, index) => {
      const at = path(param, index);
      const object = expectObject(block, at);
      if (typeof object.type !== "string" || !textTypes.includes(object.type))
        reject(
          `\`${at}\` has type ${JSON.stringify(object.type)}; only text can be carried here.`,
          path(at, "type"),
        );
      checkFields(object, ["type", "text"], at);
      return expectString(object.text, path(at, "text"));
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Errors

export function proxyError(
  kind: ProxyErrorKind,
  message: string,
  options: Partial<Omit<ProxyErrorInfo, "kind" | "message">> = {},
): ProxyErrorInfo {
  return {
    kind,
    status: null,
    code: null,
    param: null,
    message,
    retryable: kind === "unavailable" || kind === "interrupted",
    requestId: null,
    ...options,
  };
}

export const errorEvent = (error: ProxyErrorInfo): CanonicalEvent => ({
  type: "error",
  error,
});

/** An upstream event that broke its protocol's contract. */
export const malformedEvent = (message: string): CanonicalEvent =>
  errorEvent(proxyError("upstream", message));

/** Upstream output the canonical model cannot carry, such as a hosted tool call. */
export const unsupportedOutput = (message: string): CanonicalEvent =>
  errorEvent(proxyError("unsupported", message));

export const interruptedError = (): ProxyErrorInfo =>
  proxyError("interrupted", "The model stream ended before a terminal event.");

type Classification = { kind: ProxyErrorKind; retryable: boolean };
const quota = { kind: "quota", retryable: false } as const;
const unavailable = { kind: "unavailable", retryable: true } as const;
const unsupported = { kind: "unsupported", retryable: false } as const;
const permission = { kind: "permission", retryable: false } as const;
const authentication = { kind: "authentication", retryable: false } as const;
const invalidRequest = { kind: "invalid-request", retryable: false } as const;
const notFound = { kind: "not-found", retryable: false } as const;

/**
 * OpenAI error codes, including the ChatGPT-plan token-sharing codes
 * (developers.openai.com/siwc/token-sharing-open-source). Unknown codes are
 * `upstream` failures; the harness, not the proxy, decides on any retry.
 */
const openAiCodes: Readonly<Record<string, Classification>> = {
  subscription_sharing_usage_limit_exceeded: quota,
  insufficient_quota: quota,
  subscription_sharing_usage_unavailable: unavailable,
  subscription_sharing_user_unavailable: unavailable,
  server_error: unavailable,
  rate_limit_exceeded: unavailable,
  subscription_sharing_unsupported_capability: unsupported,
  subscription_sharing_user_not_eligible: permission,
  subscription_sharing_route_not_supported: permission,
  chatpass_v2_scope_not_authorized: permission,
  chatpass_v2_invalid_authorization_context: permission,
  subscription_sharing_invalid_user: authentication,
  invalid_api_key: authentication,
  model_not_found: notFound,
};

/** OpenAI-style error `type` values, used only when the code is unknown. */
const openAiTypes: Readonly<Record<string, Classification>> = {
  invalid_request_error: invalidRequest,
  authentication_error: authentication,
  permission_error: permission,
  not_found_error: notFound,
  server_error: unavailable,
};

/** Anthropic error `type` values (docs.anthropic.com, "Errors"). */
export const anthropicTypes: Readonly<Record<string, Classification>> = {
  overloaded_error: unavailable,
  api_error: unavailable,
  rate_limit_error: unavailable,
  timeout_error: unavailable,
  authentication_error: authentication,
  permission_error: permission,
  billing_error: quota,
  invalid_request_error: invalidRequest,
  request_too_large: invalidRequest,
  not_found_error: notFound,
};

/** Classifies an OpenAI error object (`{code, type, message, param}`). */
export function openAiError(
  source: JsonObject,
  requestId: string | null = null,
): ProxyErrorInfo {
  const code = typeof source.code === "string" ? source.code : null;
  const type = typeof source.type === "string" ? source.type : null;
  const classification = (code !== null ? openAiCodes[code] : undefined) ??
    (type !== null ? openAiTypes[type] : undefined) ?? {
      kind: "upstream",
      retryable: false,
    };
  return proxyError(
    classification.kind,
    typeof source.message === "string"
      ? source.message
      : "The upstream reported an error.",
    {
      code: code ?? type,
      param: typeof source.param === "string" ? source.param : null,
      retryable: classification.retryable,
      requestId,
    },
  );
}

const defaultOpenAiCodes: Record<ProxyErrorKind, string> = {
  authentication: "invalid_api_key",
  permission: "permission_denied",
  quota: "insufficient_quota",
  unavailable: "server_error",
  "invalid-request": "invalid_request",
  unsupported: "unsupported_conversion",
  "route-changed": "route_changed",
  "not-found": "model_not_found",
  interrupted: "server_error",
  upstream: "upstream_error",
};

const openAiErrorTypes: Record<ProxyErrorKind, string> = {
  authentication: "authentication_error",
  permission: "permission_error",
  quota: "insufficient_quota",
  unavailable: "server_error",
  "invalid-request": "invalid_request_error",
  unsupported: "invalid_request_error",
  "route-changed": "invalid_request_error",
  "not-found": "not_found_error",
  interrupted: "server_error",
  upstream: "server_error",
};

/** The code an OpenAI-protocol client sees: the upstream's own when known. */
export function openAiErrorCode(error: ProxyErrorInfo): string {
  return error.code ?? defaultOpenAiCodes[error.kind];
}

/** The OpenAI error JSON shared by Responses and Chat Completions. */
export function openAiErrorBody(error: ProxyErrorInfo): JsonObject {
  return {
    error: {
      message: error.message,
      type: openAiErrorTypes[error.kind],
      param: error.param,
      code: openAiErrorCode(error),
    },
  };
}

// ---------------------------------------------------------------------------
// Streams

/** A frame's JSON payload, or null when it is not a JSON object. */
export function frameJson(frame: SseFrame): JsonObject | null {
  try {
    const value: unknown = JSON.parse(frame.data);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** A token count from an upstream usage object; anything else is unknown. */
export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Later usage values replace earlier ones; unknown values never erase known ones. */
export function mergeUsage(
  usage: CanonicalUsage,
  event: CanonicalUsage,
): CanonicalUsage {
  return {
    input: event.input ?? usage.input,
    output: event.output ?? usage.output,
    cachedInput: event.cachedInput ?? usage.cachedInput,
    reasoning: event.reasoning ?? usage.reasoning,
  };
}

export const unixSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Reorders canonical events so output parts do not interleave: events for a
 * part that starts while another is still open wait until that one ends.
 * Messages and Responses clients expect one content block or output item at
 * a time, while a Chat upstream may stream parallel tool calls side by
 * side. A terminal event first closes every part, so nothing is lost.
 */
export async function* sequentialParts(
  events: AsyncIterable<CanonicalEvent>,
): AsyncGenerator<CanonicalEvent> {
  let current: number | null = null;
  const ended = new Set<number>();
  const waiting = new Map<number, CanonicalEvent[]>();
  function* release(): Generator<CanonicalEvent> {
    for (const [index, queued] of waiting) {
      if (current !== null) break;
      waiting.delete(index);
      current = index;
      for (const event of queued) {
        yield event;
        if (event.type === "part-end") {
          ended.add(index);
          current = null;
        }
      }
    }
  }
  /** Closes the open part, then replays and closes every waiting one. */
  function* closeAll(): Generator<CanonicalEvent> {
    if (current !== null) {
      yield { type: "part-end", index: current };
      ended.add(current);
      current = null;
    }
    for (const [index, queued] of waiting) {
      yield* queued;
      if (!queued.some((queuedEvent) => queuedEvent.type === "part-end"))
        yield { type: "part-end", index };
      ended.add(index);
    }
    waiting.clear();
  }
  for await (const event of events) {
    if (!("index" in event)) {
      if (event.type === "finish" || event.type === "error") yield* closeAll();
      yield event;
      continue;
    }
    const index = event.index;
    if (ended.has(index)) {
      yield event;
      continue;
    }
    if (current === null && !waiting.has(index)) current = index;
    if (current === index) {
      yield event;
      if (event.type === "part-end") {
        ended.add(index);
        current = null;
        yield* release();
      }
    } else {
      const queued = waiting.get(index);
      if (queued) queued.push(event);
      else waiting.set(index, [event]);
    }
  }
  // An interrupted source still delivers what it produced; the writer then
  // reports the interruption.
  if (waiting.size > 0) yield* closeAll();
}
