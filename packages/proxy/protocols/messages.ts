import {
  emptyUsage,
  type CanonicalEvent,
  type CanonicalMessage,
  type CanonicalOutputFormat,
  type CanonicalPart,
  type CanonicalReasoningPart,
  type CanonicalRequest,
  type CanonicalResponse,
  type CanonicalTool,
  type CanonicalToolChoice,
  type CanonicalUsage,
  type ClientProtocol,
  type FinishReason,
  type ProxyErrorInfo,
  type ProxyErrorKind,
} from "../canonical";
import { formatSse, type SseFrame } from "../sse";
import type { ConnectionKind } from "../types";
import {
  anthropicTypes,
  argumentsObject,
  checkFields,
  clientParam,
  count,
  decodeReasoningEnvelope,
  encodeReasoningEnvelope,
  errorEvent,
  expectArray,
  expectObject,
  expectString,
  frameJson,
  imageBase64,
  interruptedError,
  isObject,
  isSet,
  joinTextBlocks,
  malformedEvent,
  mergeUsage,
  opaqueOf,
  optionalBoolean,
  optionalCount,
  optionalNumber,
  optionalString,
  ownReasoning,
  outputFormatOf,
  messagesSchemaProblem,
  path,
  proxyError,
  reject,
  sequentialParts,
  unsupportedOutput,
  type JsonObject,
} from "./shared";

/**
 * The Anthropic Messages protocol (`POST /v1/messages`), as the local proxy
 * serves it to clients and sends it to Anthropic connections
 * (docs/Native_Harness_Plan.md §2). Extended thinking continues through the
 * thinking block's `signature` (or a redacted block's `data`), which only a
 * Messages upstream can accept.
 */
export const protocol: ClientProtocol = "messages";

export interface SerializeOptions {
  model: string;
  profile: ConnectionKind;
  defaultMaxOutputTokens?: number;
  /** True on the proxy's upstream hop; this protocol encodes both alike. */
  upstream?: boolean;
}

// ---------------------------------------------------------------------------
// Client request → canonical

const requestFields = [
  "model",
  "max_tokens",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "stop_sequences",
  "stream",
  "thinking",
  "output_config",
] as const;

const rejectedRequestFields: Readonly<Record<string, string>> = {
  metadata: "request metadata cannot be carried to every route.",
  service_tier: "service tiers cannot be carried to every route.",
  container:
    "server-side containers are not supported; Topsl runs tools itself.",
  mcp_servers: "hosted MCP servers are not supported; Topsl runs tools itself.",
  top_k: "top-k sampling cannot be carried to every route.",
};

const cacheControlReason =
  "prompt-cache breakpoints cannot be carried by the canonical request.";

/** Parses a client's Messages request; refuses anything it cannot carry. */
export function parseRequest(body: unknown): CanonicalRequest {
  const request = expectObject(body, "body");
  checkFields(request, requestFields, "", rejectedRequestFields);
  const choice = parseToolChoice(request.tool_choice);
  const outputFormat = parseOutputConfig(request.output_config);
  return {
    model: expectString(request.model, "model"),
    instructions: parseSystem(request.system),
    messages: expectArray(request.messages, "messages").map(parseMessage),
    tools: parseTools(request.tools),
    toolChoice: choice.toolChoice,
    maxOutputTokens: optionalCount(request.max_tokens, "max_tokens"),
    temperature: optionalNumber(request.temperature, "temperature"),
    topP: optionalNumber(request.top_p, "top_p"),
    stop: isSet(request.stop_sequences)
      ? expectArray(request.stop_sequences, "stop_sequences").map(
          (entry, index) => expectString(entry, path("stop_sequences", index)),
        )
      : [],
    reasoningEffort: null,
    thinkingBudget: parseThinking(request.thinking),
    parallelToolCalls: choice.parallelToolCalls,
    stream: optionalBoolean(request.stream, "stream") ?? false,
    ...(outputFormat ? { outputFormat } : {}),
    clientProtocol: protocol,
  };
}

/** The name a Messages output format gets on protocols that require one. */
export const MESSAGES_FORMAT_NAME = "output";

/**
 * `output_config` as far as the canonical request carries it: a JSON
 * Schema output format. Messages always constrains decoding to it.
 */
function parseOutputConfig(value: unknown): CanonicalOutputFormat | null {
  if (!isSet(value)) return null;
  const config = expectObject(value, "output_config");
  checkFields(config, ["format"], "output_config", {
    effort:
      "Messages effort is not carried; the canonical reasoning effort is refused for Messages routes.",
    task_budget: "task budgets cannot be carried to every route.",
  });
  if (!isSet(config.format)) return null;
  const format = expectObject(config.format, "output_config.format");
  checkFields(format, ["type", "schema"], "output_config.format");
  if (format.type !== "json_schema")
    reject(
      'Only a JSON Schema output format (`type: "json_schema"`) can be carried.',
      "output_config.format.type",
    );
  return {
    name: MESSAGES_FORMAT_NAME,
    schema: expectObject(format.schema, "output_config.format.schema"),
    strict: true,
  };
}

function parseSystem(value: unknown): string | null {
  if (!isSet(value)) return null;
  if (typeof value === "string") return value;
  return expectArray(value, "system")
    .map((block, index) =>
      checkTextBlock(
        expectObject(block, path("system", index)),
        path("system", index),
      ),
    )
    .join("\n\n");
}

/** A text block's fields; cache breakpoints and citations cannot be carried. */
function checkTextBlock(block: JsonObject, at: string): string {
  if (block.type !== "text")
    reject(
      `\`${at}\` has type ${JSON.stringify(block.type)}; only text blocks can be carried here.`,
      path(at, "type"),
    );
  checkFields(block, ["type", "text", "citations"], at, {
    cache_control: cacheControlReason,
  });
  if (Array.isArray(block.citations) && block.citations.length > 0)
    reject("Text citations cannot be carried.", path(at, "citations"));
  return expectString(block.text, path(at, "text"));
}

function parseMessage(value: unknown, index: number): CanonicalMessage {
  const at = path("messages", index);
  const message = expectObject(value, at);
  checkFields(message, ["role", "content"], at);
  const role = message.role;
  if (role !== "user" && role !== "assistant")
    reject(
      `Messages roles are "user" and "assistant"; got ${JSON.stringify(role)}.`,
      path(at, "role"),
    );
  if (typeof message.content === "string")
    return { role, parts: [{ type: "text", text: message.content }] };
  const content = path(at, "content");
  return {
    role,
    parts: expectArray(message.content, content).map((block, blockIndex) =>
      parseBlock(block, path(content, blockIndex), role),
    ),
  };
}

function parseBlock(
  value: unknown,
  at: string,
  role: "user" | "assistant",
): CanonicalPart {
  const block = expectObject(value, at);
  const onlyFor = (expected: "user" | "assistant") => {
    if (role !== expected)
      reject(
        `A ${role} message cannot carry a ${String(block.type)} block.`,
        path(at, "type"),
      );
  };
  switch (block.type) {
    case "text":
      return { type: "text", text: checkTextBlock(block, at) };
    case "image": {
      onlyFor("user");
      checkFields(block, ["type", "source"], at, {
        cache_control: cacheControlReason,
      });
      const sourceAt = path(at, "source");
      const source = expectObject(block.source, sourceAt);
      if (source.type === "base64") {
        checkFields(source, ["type", "media_type", "data"], sourceAt);
        return {
          type: "image",
          mediaType: expectString(
            source.media_type,
            path(sourceAt, "media_type"),
          ),
          data: expectString(source.data, path(sourceAt, "data")),
          url: null,
        };
      }
      if (source.type === "url") {
        checkFields(source, ["type", "url"], sourceAt);
        return {
          type: "image",
          mediaType: null,
          data: null,
          url: expectString(source.url, path(sourceAt, "url")),
        };
      }
      return reject(
        `Image sources of type ${JSON.stringify(source.type)} cannot be carried; send base64 data or a URL.`,
        path(sourceAt, "type"),
      );
    }
    case "tool_use": {
      onlyFor("assistant");
      checkFields(block, ["type", "id", "name", "input"], at, {
        cache_control: cacheControlReason,
      });
      const input = isSet(block.input)
        ? expectObject(block.input, path(at, "input"))
        : {};
      return {
        type: "tool-call",
        id: expectString(block.id, path(at, "id")),
        name: expectString(block.name, path(at, "name")),
        arguments: JSON.stringify(input),
      };
    }
    case "tool_result": {
      onlyFor("user");
      checkFields(block, ["type", "tool_use_id", "content", "is_error"], at, {
        cache_control: cacheControlReason,
      });
      const contentAt = path(at, "content");
      return {
        type: "tool-result",
        callId: expectString(block.tool_use_id, path(at, "tool_use_id")),
        output: !isSet(block.content)
          ? ""
          : typeof block.content === "string"
            ? block.content
            : joinTextBlocks(expectArray(block.content, contentAt), contentAt, [
                "text",
              ]),
        isError: optionalBoolean(block.is_error, path(at, "is_error")) ?? false,
      };
    }
    case "thinking": {
      onlyFor("assistant");
      checkFields(block, ["type", "thinking", "signature"], at);
      const text = expectString(block.thinking, path(at, "thinking"));
      const signature =
        optionalString(block.signature, path(at, "signature")) ?? "";
      const envelope = decodeReasoningEnvelope(
        signature,
        path(at, "signature"),
      );
      if (envelope) return envelope;
      return {
        type: "reasoning",
        text,
        // An unsigned thinking block cannot be continued by any upstream.
        opaque: signature ? { protocol, value: { signature } } : null,
      };
    }
    case "redacted_thinking":
      onlyFor("assistant");
      checkFields(block, ["type", "data"], at);
      return {
        type: "reasoning",
        text: null,
        opaque: {
          protocol,
          value: { redacted: expectString(block.data, path(at, "data")) },
        },
      };
    default:
      return reject(
        `Content blocks of type ${JSON.stringify(block.type)} cannot be carried by the local proxy.`,
        path(at, "type"),
      );
  }
}

function parseTools(value: unknown): CanonicalTool[] {
  if (!isSet(value)) return [];
  return expectArray(value, "tools").map((entry, index) => {
    const at = path("tools", index);
    const tool = expectObject(entry, at);
    if (isSet(tool.type) && tool.type !== "custom")
      reject(
        `The server tool ${JSON.stringify(tool.type)} cannot be carried by the local proxy; Topsl runs tools itself.`,
        path(at, "type"),
      );
    checkFields(
      tool,
      ["type", "name", "description", "input_schema", "strict"],
      at,
      {
        cache_control: cacheControlReason,
      },
    );
    if (tool.strict === true)
      reject(
        "Strict tool schemas cannot be carried to every route.",
        path(at, "strict"),
      );
    return {
      name: expectString(tool.name, path(at, "name")),
      description:
        optionalString(tool.description, path(at, "description")) ?? "",
      inputSchema: expectObject(tool.input_schema, path(at, "input_schema")),
    };
  });
}

function parseToolChoice(value: unknown): {
  toolChoice: CanonicalToolChoice;
  parallelToolCalls: boolean | null;
} {
  if (!isSet(value)) return { toolChoice: "auto", parallelToolCalls: null };
  const choice = expectObject(value, "tool_choice");
  const disable = optionalBoolean(
    choice.disable_parallel_tool_use,
    "tool_choice.disable_parallel_tool_use",
  );
  const parallelToolCalls = disable === null ? null : !disable;
  switch (choice.type) {
    case "auto":
    case "any":
      checkFields(choice, ["type", "disable_parallel_tool_use"], "tool_choice");
      return {
        toolChoice: choice.type === "auto" ? "auto" : "required",
        parallelToolCalls,
      };
    case "tool":
      checkFields(
        choice,
        ["type", "name", "disable_parallel_tool_use"],
        "tool_choice",
      );
      return {
        toolChoice: { name: expectString(choice.name, "tool_choice.name") },
        parallelToolCalls,
      };
    case "none":
      checkFields(choice, ["type"], "tool_choice");
      return { toolChoice: "none", parallelToolCalls: null };
    default:
      return reject(
        `\`tool_choice\` of type ${JSON.stringify(choice.type)} cannot be carried.`,
        "tool_choice.type",
      );
  }
}

function parseThinking(value: unknown): number | null {
  if (!isSet(value)) return null;
  const thinking = expectObject(value, "thinking");
  if (thinking.type === "disabled") {
    checkFields(thinking, ["type"], "thinking");
    return null;
  }
  if (thinking.type !== "enabled")
    reject(
      `Thinking of type ${JSON.stringify(thinking.type)} cannot be carried; use "enabled" with a budget.`,
      "thinking.type",
    );
  checkFields(thinking, ["type", "budget_tokens"], "thinking");
  const budget = optionalCount(
    thinking.budget_tokens,
    "thinking.budget_tokens",
  );
  if (budget === null)
    reject("Enabled thinking needs `budget_tokens`.", "thinking.budget_tokens");
  return budget;
}

// ---------------------------------------------------------------------------
// Canonical → upstream request

/** Builds the upstream Messages body; always streaming. */
export function serializeRequest(
  request: CanonicalRequest,
  options: SerializeOptions,
): Record<string, unknown> {
  if (request.reasoningEffort !== null)
    reject(
      "The Messages API has no reasoning effort; set a thinking budget instead.",
      clientParam(request, "reasoningEffort"),
    );
  const maxTokens = request.maxOutputTokens ?? options.defaultMaxOutputTokens;
  if (maxTokens === undefined)
    reject(
      "The Messages API requires an output-token limit, and neither the request nor the route sets one.",
      clientParam(request, "maxOutputTokens"),
    );
  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: maxTokens,
  };
  if (request.instructions !== null) body.system = request.instructions;
  body.messages = serializeMessages(request);
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.inputSchema,
    }));
    const choice: JsonObject =
      request.toolChoice === "auto"
        ? { type: "auto" }
        : request.toolChoice === "none"
          ? { type: "none" }
          : request.toolChoice === "required"
            ? { type: "any" }
            : { type: "tool", name: request.toolChoice.name };
    if (request.parallelToolCalls === false && choice.type !== "none")
      choice.disable_parallel_tool_use = true;
    body.tool_choice = choice;
  } else if (
    request.toolChoice === "required" ||
    typeof request.toolChoice === "object"
  )
    reject("`tool_choice` requires tools.", clientParam(request, "toolChoice"));
  if (request.temperature !== null) body.temperature = request.temperature;
  if (request.topP !== null) body.top_p = request.topP;
  if (request.stop.length > 0) body.stop_sequences = request.stop;
  if (request.thinkingBudget !== null)
    body.thinking = { type: "enabled", budget_tokens: request.thinkingBudget };
  const format = outputFormatOf(request);
  if (format) {
    // Refused rather than relaxed: dropping a client's constraints would
    // change what its schema promises. The native harness relaxes its own
    // schemas knowingly and validates the full schema afterwards.
    const problem = messagesSchemaProblem(format.schema);
    if (problem) reject(problem, clientParam(request, "outputFormat"));
    body.output_config = {
      format: { type: "json_schema", schema: format.schema },
    };
  }
  body.stream = true;
  return body;
}

function serializeMessages(request: CanonicalRequest): JsonObject[] {
  const param = clientParam(request, "messages");
  const turns: { role: "user" | "assistant"; content: JsonObject[] }[] = [];
  request.messages.forEach((message, messageIndex) => {
    const where = `message ${messageIndex + 1}`;
    const content = message.parts.flatMap((part): JsonObject[] =>
      serializePart(part, message.role, where, param),
    );
    if (content.length === 0) return;
    // Messages requires alternating roles, so adjacent turns are joined.
    const last = turns.at(-1);
    if (last?.role === message.role) last.content.push(...content);
    else turns.push({ role: message.role, content });
  });
  return turns.map((turn) => ({
    role: turn.role,
    // Tool results must open the user turn that answers the calls.
    content:
      turn.role === "user"
        ? [
            ...turn.content.filter((block) => block.type === "tool_result"),
            ...turn.content.filter((block) => block.type !== "tool_result"),
          ]
        : turn.content,
  }));
}

function serializePart(
  part: CanonicalPart,
  role: "user" | "assistant",
  where: string,
  param: string,
): JsonObject[] {
  switch (part.type) {
    case "text":
      // Messages refuses empty text blocks; an empty part carries nothing.
      return part.text ? [{ type: "text", text: part.text }] : [];
    case "image": {
      if (role !== "user")
        reject(`An assistant image (${where}) cannot be sent upstream.`, param);
      const inline = imageBase64(part);
      if (inline)
        return [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: inline.mediaType,
              data: inline.data,
            },
          },
        ];
      if (!part.url) reject(`An image (${where}) has no data or URL.`, param);
      return [{ type: "image", source: { type: "url", url: part.url } }];
    }
    case "tool-call":
      if (role !== "assistant")
        reject(`A user message carries a tool call (${where}).`, param);
      return [
        {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: argumentsObject(part.arguments, param),
        },
      ];
    case "tool-result":
      if (role !== "user")
        reject(`An assistant message carries a tool result (${where}).`, param);
      return [
        {
          type: "tool_result",
          tool_use_id: part.callId,
          content: part.output,
          ...(part.isError ? { is_error: true } : {}),
        },
      ];
    case "reasoning": {
      if (role !== "assistant")
        reject(`A user message carries reasoning (${where}).`, param);
      const value = ownReasoning(part, protocol, param);
      if (isObject(value) && typeof value.redacted === "string")
        return [{ type: "redacted_thinking", data: value.redacted }];
      if (
        isObject(value) &&
        typeof value.signature === "string" &&
        value.signature
      )
        return [
          {
            type: "thinking",
            thinking: part.text ?? "",
            signature: value.signature,
          },
        ];
      return reject(`Reasoning (${where}) has no thinking signature.`, param);
    }
  }
}

// ---------------------------------------------------------------------------
// Upstream stream → canonical

const stopReasons: Readonly<Record<string, FinishReason>> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  max_tokens: "length",
  refusal: "content-filter",
};

/**
 * Anthropic counts cached input apart from `input_tokens`. The canonical
 * `input` is the whole prompt, cached or not, as OpenAI reports it, so usage
 * from every route means the same thing.
 */
function usageFrom(value: unknown, withOutput: boolean): CanonicalUsage {
  const usage = isObject(value) ? value : {};
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const created = count(usage.cache_creation_input_tokens);
  return {
    input: input === null ? null : input + (read ?? 0) + (created ?? 0),
    output: withOutput ? count(usage.output_tokens) : null,
    cachedInput: read,
    reasoning: null,
  };
}

function anthropicError(
  source: JsonObject,
  requestId: string | null,
): ProxyErrorInfo {
  const type = typeof source.type === "string" ? source.type : null;
  const classification = (type !== null ? anthropicTypes[type] : undefined) ?? {
    kind: "upstream" as ProxyErrorKind,
    retryable: false,
  };
  return proxyError(
    classification.kind,
    typeof source.message === "string"
      ? source.message
      : "The upstream reported an error.",
    { code: type, retryable: classification.retryable, requestId },
  );
}

interface Block {
  index: number;
  kind: "text" | "tool" | "reasoning";
  arguments: boolean;
  input: unknown;
  signature: string;
  ended: boolean;
}

/** Reads one Messages stream into canonical events, block by block. */
class StreamReader {
  done = false;
  private next = 0;
  private readonly blocks = new Map<number, Block>();
  private finish: { reason: FinishReason; rawReason: string | null } | null =
    null;

  read(frame: SseFrame): CanonicalEvent[] {
    if (this.done) return [];
    const data = frameJson(frame);
    if (!data)
      return this.fail(malformedEvent("A Messages event is not JSON."));
    const type = typeof data.type === "string" ? data.type : frame.event;
    switch (type) {
      case "message_start": {
        const message = isObject(data.message) ? data.message : {};
        return [
          {
            type: "response-start",
            responseId: typeof message.id === "string" ? message.id : null,
            model: typeof message.model === "string" ? message.model : null,
          },
          // message_start's output count is a placeholder; message_delta has the total.
          ...(isObject(message.usage)
            ? [{ type: "usage", ...usageFrom(message.usage, false) } as const]
            : []),
        ];
      }
      case "content_block_start":
        return this.blockStart(data);
      case "content_block_delta":
        return this.blockDelta(data);
      case "content_block_stop": {
        const block = this.blocks.get(Number(data.index));
        if (!block)
          return this.fail(
            malformedEvent("A content block stopped before it started."),
          );
        return this.end(block);
      }
      case "message_delta": {
        const delta = isObject(data.delta) ? data.delta : {};
        if (typeof delta.stop_reason === "string")
          this.finish = {
            reason: stopReasons[delta.stop_reason] ?? "other",
            rawReason: delta.stop_reason,
          };
        return isObject(data.usage)
          ? [{ type: "usage", ...usageFrom(data.usage, true) }]
          : [];
      }
      case "message_stop": {
        const events = [...this.blocks.values()].flatMap((block) =>
          this.end(block),
        );
        events.push({
          type: "finish",
          reason: this.finish?.reason ?? "other",
          rawReason: this.finish?.rawReason ?? null,
        });
        this.done = true;
        return events;
      }
      case "error": {
        const error = isObject(data.error) ? data.error : data;
        return this.fail(
          errorEvent(
            anthropicError(
              error,
              typeof data.request_id === "string" ? data.request_id : null,
            ),
          ),
        );
      }
      default:
        // `ping` and future event types carry nothing the canonical model keeps.
        return [];
    }
  }

  private blockStart(data: JsonObject): CanonicalEvent[] {
    const content = isObject(data.content_block) ? data.content_block : {};
    const kind =
      content.type === "text"
        ? "text"
        : content.type === "tool_use"
          ? "tool"
          : content.type === "thinking" || content.type === "redacted_thinking"
            ? "reasoning"
            : null;
    if (kind === null)
      return this.fail(
        unsupportedOutput(
          `The upstream returned a ${String(content.type)} block, which the proxy cannot carry.`,
        ),
      );
    const block: Block = {
      index: this.next++,
      kind,
      arguments: false,
      input: content.input,
      signature: "",
      ended: false,
    };
    this.blocks.set(Number(data.index), block);
    const events: CanonicalEvent[] = [];
    if (
      content.type === "text" &&
      typeof content.text === "string" &&
      content.text
    )
      events.push({
        type: "text-delta",
        index: block.index,
        text: content.text,
      });
    if (content.type === "tool_use")
      events.push({
        type: "tool-call-start",
        index: block.index,
        id: String(content.id ?? ""),
        name: String(content.name ?? ""),
      });
    if (content.type === "thinking") {
      if (typeof content.thinking === "string" && content.thinking)
        events.push({
          type: "reasoning-delta",
          index: block.index,
          text: content.thinking,
        });
      if (typeof content.signature === "string" && content.signature)
        events.push(...this.sign(block, content.signature));
    }
    if (content.type === "redacted_thinking")
      events.push({
        type: "reasoning-opaque",
        index: block.index,
        value: { protocol, value: { redacted: String(content.data ?? "") } },
      });
    return events;
  }

  private blockDelta(data: JsonObject): CanonicalEvent[] {
    const block = this.blocks.get(Number(data.index));
    if (!block)
      return this.fail(
        malformedEvent("A content block delta arrived before its block."),
      );
    const delta = isObject(data.delta) ? data.delta : {};
    switch (delta.type) {
      case "text_delta":
        return typeof delta.text === "string" && delta.text
          ? [{ type: "text-delta", index: block.index, text: delta.text }]
          : [];
      case "input_json_delta":
        if (typeof delta.partial_json !== "string" || !delta.partial_json)
          return [];
        block.arguments = true;
        return [
          {
            type: "tool-call-delta",
            index: block.index,
            argumentsDelta: delta.partial_json,
          },
        ];
      case "thinking_delta":
        return typeof delta.thinking === "string" && delta.thinking
          ? [
              {
                type: "reasoning-delta",
                index: block.index,
                text: delta.thinking,
              },
            ]
          : [];
      case "signature_delta":
        return typeof delta.signature === "string"
          ? this.sign(block, delta.signature)
          : [];
      default:
        return [];
    }
  }

  /** Signature deltas accumulate; each event carries the whole signature so far. */
  private sign(block: Block, signature: string): CanonicalEvent[] {
    block.signature += signature;
    return [
      {
        type: "reasoning-opaque",
        index: block.index,
        value: { protocol, value: { signature: block.signature } },
      },
    ];
  }

  private end(block: Block): CanonicalEvent[] {
    if (block.ended) return [];
    block.ended = true;
    const events: CanonicalEvent[] = [];
    // A call with no streamed input carries its start input (usually `{}`).
    if (block.kind === "tool" && !block.arguments)
      events.push({
        type: "tool-call-delta",
        index: block.index,
        argumentsDelta: JSON.stringify(
          isObject(block.input) ? block.input : {},
        ),
      });
    events.push({ type: "part-end", index: block.index });
    return events;
  }

  private fail(event: CanonicalEvent): CanonicalEvent[] {
    this.done = true;
    return [event];
  }
}

/** Reads an upstream Messages stream into canonical events. */
export async function* readStream(
  frames: AsyncIterable<SseFrame>,
): AsyncGenerator<CanonicalEvent> {
  const reader = new StreamReader();
  for await (const frame of frames) {
    yield* reader.read(frame);
    if (reader.done) return;
  }
}

/** Reads a non-streaming Messages body (or error body) through the stream reader. */
export function readResponse(body: unknown): CanonicalEvent[] {
  const object = isObject(body) ? body : {};
  const reader = new StreamReader();
  const frame = (data: JsonObject): CanonicalEvent[] =>
    reader.read({ event: null, data: JSON.stringify(data), id: null });
  if (
    object.type === "error" ||
    (object.type !== "message" && isObject(object.error))
  )
    return frame({ ...object, type: "error" });
  const events = frame({
    type: "message_start",
    message: { ...object, content: [] },
  });
  const content = Array.isArray(object.content) ? object.content : [];
  content.forEach((content_block, index) => {
    events.push(
      ...frame({ type: "content_block_start", index, content_block }),
      ...frame({ type: "content_block_stop", index }),
    );
  });
  if (typeof object.stop_reason === "string")
    events.push(
      ...frame({
        type: "message_delta",
        delta: { stop_reason: object.stop_reason },
        usage: object.usage,
      }),
      ...frame({ type: "message_stop" }),
    );
  return events;
}

// ---------------------------------------------------------------------------
// Canonical → client stream

function stopReason(
  reason: FinishReason | null,
  rawReason: string | null,
): string {
  switch (reason) {
    case "stop":
      return rawReason === "stop_sequence" ? "stop_sequence" : "end_turn";
    case "tool-calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "refusal";
    default:
      return rawReason === "pause_turn" ||
        rawReason === "model_context_window_exceeded"
        ? rawReason
        : "end_turn";
  }
}

/** Usage as Messages reports it: cached input apart from `input_tokens`. */
function usageJson(usage: CanonicalUsage, withOutput: boolean): JsonObject {
  return {
    ...(usage.input !== null || !withOutput
      ? {
          input_tokens: Math.max(
            0,
            (usage.input ?? 0) - (usage.cachedInput ?? 0),
          ),
        }
      : {}),
    ...(usage.cachedInput !== null
      ? { cache_read_input_tokens: usage.cachedInput }
      : {}),
    output_tokens: withOutput ? (usage.output ?? 0) : 0,
  };
}

const anthropicErrorTypes: Record<ProxyErrorKind, string> = {
  authentication: "authentication_error",
  permission: "permission_error",
  quota: "billing_error",
  unavailable: "api_error",
  "invalid-request": "invalid_request_error",
  unsupported: "invalid_request_error",
  "route-changed": "invalid_request_error",
  "not-found": "not_found_error",
  interrupted: "api_error",
  upstream: "api_error",
};

function errorType(error: ProxyErrorInfo): string {
  if (error.code !== null && Object.hasOwn(anthropicTypes, error.code))
    return error.code;
  if (error.code === "rate_limit_exceeded") return "rate_limit_error";
  return anthropicErrorTypes[error.kind];
}

/** The Messages continuation of a reasoning part, when it has one of its own. */
function ownValue(opaque: CanonicalReasoningPart["opaque"]): JsonObject | null {
  return opaque?.protocol === protocol && isObject(opaque.value)
    ? opaque.value
    : null;
}

/**
 * A thinking block's signature: the upstream's own, or an envelope that
 * carries another protocol's continuation (or the lack of one) back to the
 * parser, so an unsigned block is never mistaken for a signed one.
 */
function thinkingSignature(part: CanonicalReasoningPart): string {
  const value = ownValue(part.opaque);
  return typeof value?.signature === "string" && value.signature
    ? value.signature
    : encodeReasoningEnvelope(part);
}

/** A reasoning part as a Messages block. */
function reasoningBlock(part: CanonicalReasoningPart): JsonObject {
  const value = ownValue(part.opaque);
  if (typeof value?.redacted === "string")
    return { type: "redacted_thinking", data: value.redacted };
  return {
    type: "thinking",
    thinking: part.text ?? "",
    signature: thinkingSignature(part),
  };
}

interface OpenBlock {
  canonical: number;
  block: number;
  kind: "text" | "tool" | "thinking" | "redacted";
  text: string;
  opaque: CanonicalReasoningPart["opaque"];
}

/** Writes canonical events as the Messages SSE a client expects. */
class StreamWriter {
  done = false;
  private started = false;
  private nextBlock = 0;
  private open: OpenBlock | null = null;
  private readonly closed = new Set<number>();
  private usage: CanonicalUsage = emptyUsage();

  constructor(private readonly meta: { model: string; responseId: string }) {}

  write(event: CanonicalEvent): string[] {
    if (this.done) return [];
    const out: string[] = [];
    switch (event.type) {
      case "response-start":
        break;
      case "usage":
        this.usage = mergeUsage(this.usage, event);
        break;
      case "text-delta": {
        const block = this.block(event.index, "text", out);
        if (block)
          out.push(this.delta(block, { type: "text_delta", text: event.text }));
        break;
      }
      case "reasoning-delta": {
        const block = this.block(event.index, "thinking", out);
        if (block) {
          block.text += event.text;
          out.push(
            this.delta(block, { type: "thinking_delta", thinking: event.text }),
          );
        }
        break;
      }
      case "reasoning-opaque": {
        const opaque = opaqueOf(event.value);
        const redacted = ownValue(opaque)?.redacted;
        // Redacted thinking is a block of its own, known only from its data.
        const block =
          typeof redacted === "string" && this.open?.canonical !== event.index
            ? this.block(event.index, "redacted", out, {
                type: "redacted_thinking",
                data: redacted,
              })
            : this.block(event.index, "thinking", out);
        if (block) block.opaque = opaque;
        break;
      }
      case "tool-call-start":
        this.block(event.index, "tool", out, {
          type: "tool_use",
          id: event.id,
          name: event.name,
          input: {},
        });
        break;
      case "tool-call-delta":
        if (this.open?.canonical === event.index && this.open.kind === "tool")
          out.push(
            this.delta(this.open, {
              type: "input_json_delta",
              partial_json: event.argumentsDelta,
            }),
          );
        break;
      case "part-end":
        if (this.open?.canonical === event.index) out.push(...this.close());
        break;
      case "finish":
        out.push(
          ...this.start(),
          ...this.close(),
          this.emit("message_delta", {
            delta: {
              stop_reason: stopReason(event.reason, event.rawReason),
              stop_sequence: null,
            },
            usage: usageJson(this.usage, true),
          }),
          this.emit("message_stop", {}),
        );
        this.done = true;
        break;
      case "error":
        out.push(...this.close(), this.failed(event.error));
        break;
    }
    return out;
  }

  /** Reports a source that ended without a terminal event as failed. */
  end(): string[] {
    return this.done ? [] : [this.failed(interruptedError())];
  }

  private failed(error: ProxyErrorInfo): string {
    this.done = true;
    return this.emit("error", {
      error: { type: errorType(error), message: error.message },
    });
  }

  private emit(type: string, payload: JsonObject): string {
    return formatSse({
      event: type,
      data: JSON.stringify({ type, ...payload }),
    });
  }

  private start(): string[] {
    if (this.started) return [];
    this.started = true;
    return [
      this.emit("message_start", {
        message: {
          id: this.meta.responseId,
          type: "message",
          role: "assistant",
          model: this.meta.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usageJson(this.usage, false),
        },
      }),
    ];
  }

  /**
   * The open block for a canonical part, starting it on first use. Parts
   * arrive one at a time (sequentialParts); a part that has closed cannot
   * be reopened, because Messages blocks never resume.
   */
  private block(
    canonical: number,
    kind: OpenBlock["kind"],
    out: string[],
    start?: JsonObject,
  ): OpenBlock | null {
    if (this.open?.canonical === canonical) {
      return this.open.kind === kind ? this.open : null;
    }
    if (this.closed.has(canonical)) return null;
    out.push(...this.start(), ...this.close());
    const block: OpenBlock = {
      canonical,
      block: this.nextBlock++,
      kind,
      text: "",
      opaque: null,
    };
    this.open = block;
    const content =
      kind === "text"
        ? { type: "text", text: "" }
        : kind === "thinking"
          ? { type: "thinking", thinking: "" }
          : start!;
    out.push(
      this.emit("content_block_start", {
        index: block.block,
        content_block: content,
      }),
    );
    return block;
  }

  private delta(block: OpenBlock, delta: JsonObject): string {
    return this.emit("content_block_delta", { index: block.block, delta });
  }

  private close(): string[] {
    const block = this.open;
    if (!block) return [];
    this.open = null;
    this.closed.add(block.canonical);
    const out: string[] = [];
    if (block.kind === "thinking")
      out.push(
        this.delta(block, {
          type: "signature_delta",
          signature: thinkingSignature({
            type: "reasoning",
            text: block.text,
            opaque: block.opaque,
          }),
        }),
      );
    out.push(this.emit("content_block_stop", { index: block.block }));
    return out;
  }
}

/** Writes canonical events as a client-facing Messages stream. */
export async function* writeStream(
  events: AsyncIterable<CanonicalEvent>,
  meta: { model: string; responseId: string; includeUsage?: boolean },
): AsyncGenerator<string> {
  const writer = new StreamWriter(meta);
  for await (const event of sequentialParts(events)) {
    yield* writer.write(event);
    if (writer.done) return;
  }
  yield* writer.end();
}

/** A complete client-facing Messages object, or the error body on failure. */
export function writeResponse(
  response: CanonicalResponse,
  meta: { model: string; responseId: string },
): Record<string, unknown> {
  if (response.error) return errorBody(response.error);
  const content: JsonObject[] = [];
  for (const part of response.output) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "reasoning") content.push(reasoningBlock(part));
    else if (part.type === "tool-call") {
      let input: JsonObject;
      try {
        input = argumentsObject(part.arguments, "tool_use.input");
      } catch {
        return errorBody(
          proxyError(
            "upstream",
            "The upstream produced tool-call arguments that are not a JSON object.",
          ),
        );
      }
      content.push({ type: "tool_use", id: part.id, name: part.name, input });
    }
  }
  return {
    id: meta.responseId,
    type: "message",
    role: "assistant",
    model: meta.model,
    content,
    stop_reason: stopReason(response.finish, response.rawFinishReason),
    stop_sequence: null,
    usage: usageJson(response.usage, true),
  };
}

/** The error JSON a Messages client expects. */
export function errorBody(error: ProxyErrorInfo): Record<string, unknown> {
  return {
    type: "error",
    error: { type: errorType(error), message: error.message },
    ...(error.requestId !== null ? { request_id: error.requestId } : {}),
  };
}
