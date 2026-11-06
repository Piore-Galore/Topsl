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
} from "../canonical";
import { formatSse, type SseFrame } from "../sse";
import type { ConnectionKind } from "../types";
import {
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
  imageUrl,
  interruptedError,
  isObject,
  isSet,
  malformedEvent,
  mergeUsage,
  openAiError,
  openAiErrorBody,
  openAiErrorCode,
  opaqueOf,
  optionalBoolean,
  optionalCount,
  optionalNumber,
  optionalString,
  ownReasoning,
  outputFormatOf,
  parseSchemaFormat,
  path,
  reject,
  sequentialParts,
  unixSeconds,
  unsupportedOutput,
  type JsonObject,
} from "./shared";

/**
 * The OpenAI Responses protocol (`POST /v1/responses`), as the local proxy
 * serves it to clients and sends it to OpenAI API and ChatGPT-plan
 * connections (docs/Native_Harness_Plan.md §2). Topsl keeps history
 * locally, so every request is stateless: `store: false`, the whole history
 * in `input`, and reasoning continued through `encrypted_content`.
 */
export const protocol: ClientProtocol = "responses";

export interface SerializeOptions {
  model: string;
  profile: ConnectionKind;
  defaultMaxOutputTokens?: number;
  /**
   * True when the body goes to the upstream itself rather than to Topsl's
   * local proxy. The harness serializes with its route's profile so route
   * refusals happen before anything is sent; only the proxy's upstream hop
   * applies the ChatGPT-plan route's tool namespace.
   */
  upstream?: boolean;
}

// ---------------------------------------------------------------------------
// Client request → canonical

const requestFields = [
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "max_output_tokens",
  "temperature",
  "top_p",
  "reasoning",
  "parallel_tool_calls",
  "stream",
  "store",
  "include",
  "text",
] as const;

const statelessReason =
  "Topsl keeps conversation history locally; send the whole history in `input`.";

const rejectedRequestFields: Readonly<Record<string, string>> = {
  previous_response_id: statelessReason,
  conversation: statelessReason,
  background: "background responses need server-side storage.",
  prompt:
    "stored prompt templates are not carried; send instructions and input.",
  metadata: "response metadata cannot be carried to every route.",
  user: "end-user identifiers cannot be carried to every route.",
  truncation:
    "server-side truncation is not supported; Topsl manages context itself.",
  service_tier: "service tiers cannot be carried to every route.",
};

const hostedTools: Readonly<Record<string, string>> = {
  web_search: "web search",
  web_search_preview: "web search",
  file_search: "file search",
  mcp: "hosted MCP",
  image_generation: "image generation",
  code_interpreter: "Code Interpreter",
  computer: "computer use",
  computer_use_preview: "computer use",
  tool_search: "tool search",
  local_shell: "local shell",
  shell: "shell",
  apply_patch: "apply patch",
  custom: "custom (free-form) tools",
};

/** Parses a client's Responses request; refuses anything it cannot carry. */
export function parseRequest(body: unknown): CanonicalRequest {
  const request = expectObject(body, "body");
  checkFields(request, requestFields, "", rejectedRequestFields);
  const model = expectString(request.model, "model");
  if (isSet(request.store) && request.store !== false)
    reject(
      "`store` must be false or absent: Topsl keeps history locally and the proxy never stores responses upstream.",
      "store",
    );
  if (isSet(request.include))
    expectArray(request.include, "include").forEach((entry, index) => {
      if (entry !== "reasoning.encrypted_content")
        reject(
          `\`include\` may only list "reasoning.encrypted_content"; ${JSON.stringify(entry)} cannot be carried.`,
          path("include", index),
        );
    });
  let outputFormat: CanonicalOutputFormat | null = null;
  if (isSet(request.text)) {
    const text = expectObject(request.text, "text");
    checkFields(text, ["format"], "text");
    if (isSet(text.format)) {
      const format = expectObject(text.format, "text.format");
      if (format.type === "json_schema")
        outputFormat = parseSchemaFormat(format, "text.format");
      else {
        checkFields(format, ["type"], "text.format");
        if (format.type !== "text")
          reject(
            'Only plain text (`text.format.type: "text"`) or a JSON Schema (`"json_schema"`) can be carried; JSON mode without a schema cannot.',
            "text.format.type",
          );
      }
    }
  }
  let reasoningEffort: string | null = null;
  if (isSet(request.reasoning)) {
    const reasoning = expectObject(request.reasoning, "reasoning");
    checkFields(reasoning, ["effort"], "reasoning", {
      summary:
        "reasoning summary settings cannot be carried by the canonical request.",
      generate_summary:
        "reasoning summary settings cannot be carried by the canonical request.",
    });
    reasoningEffort = optionalString(reasoning.effort, "reasoning.effort");
  }
  if (!isSet(request.input)) reject("`input` is required.", "input");
  const { instructions, messages } = parseInput(request.input);
  const topInstructions = optionalString(request.instructions, "instructions");
  const allInstructions = [
    ...(topInstructions !== null ? [topInstructions] : []),
    ...instructions,
  ];
  return {
    model,
    instructions: allInstructions.length ? allInstructions.join("\n\n") : null,
    messages,
    tools: parseTools(request.tools),
    toolChoice: parseToolChoice(request.tool_choice),
    maxOutputTokens: optionalCount(
      request.max_output_tokens,
      "max_output_tokens",
    ),
    temperature: optionalNumber(request.temperature, "temperature"),
    topP: optionalNumber(request.top_p, "top_p"),
    stop: [],
    reasoningEffort,
    thinkingBudget: null,
    parallelToolCalls: optionalBoolean(
      request.parallel_tool_calls,
      "parallel_tool_calls",
    ),
    stream: optionalBoolean(request.stream, "stream") ?? false,
    ...(outputFormat ? { outputFormat } : {}),
    clientProtocol: protocol,
  };
}

/**
 * Converts `input` items into messages. System and developer items become
 * instructions only while they lead the input; afterwards their position
 * would matter, and the canonical model has one instruction slot.
 */
function parseInput(input: unknown): {
  instructions: string[];
  messages: CanonicalMessage[];
} {
  if (typeof input === "string")
    return {
      instructions: [],
      messages: [{ role: "user", parts: [{ type: "text", text: input }] }],
    };
  const instructions: string[] = [];
  const messages: CanonicalMessage[] = [];
  /** Function calls and reasoning join the assistant turn they belong to. */
  const assistant = (): CanonicalMessage => {
    const last = messages.at(-1);
    if (last?.role === "assistant") return last;
    const message: CanonicalMessage = { role: "assistant", parts: [] };
    messages.push(message);
    return message;
  };
  expectArray(input, "input").forEach((value, index) => {
    const at = path("input", index);
    const item = expectObject(value, at);
    const type =
      item.type ?? (typeof item.role === "string" ? "message" : undefined);
    switch (type) {
      case "message": {
        // Item IDs and status refer to stored items; with store false they
        // carry nothing the content does not.
        checkFields(item, ["type", "role", "content", "id", "status"], at);
        const role = expectString(item.role, path(at, "role"));
        const content = path(at, "content");
        if (role === "system" || role === "developer") {
          if (messages.length > 0)
            reject(
              `A ${role} message after the conversation has started cannot be carried; put instructions before every user and assistant item.`,
              path(at, "role"),
            );
          const parts = parseContent(item.content, content, "system");
          instructions.push(
            parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
          );
        } else if (role === "user")
          messages.push({
            role: "user",
            parts: parseContent(item.content, content, "user"),
          });
        else if (role === "assistant")
          assistant().parts.push(
            ...parseContent(item.content, content, "assistant"),
          );
        else
          reject(
            `Unknown message role ${JSON.stringify(role)}.`,
            path(at, "role"),
          );
        break;
      }
      case "function_call":
        checkFields(
          item,
          ["type", "call_id", "name", "arguments", "id", "status"],
          at,
        );
        assistant().parts.push({
          type: "tool-call",
          id: expectString(item.call_id, path(at, "call_id")),
          name: expectString(item.name, path(at, "name")),
          arguments: expectString(item.arguments, path(at, "arguments")),
        });
        break;
      case "function_call_output": {
        checkFields(item, ["type", "call_id", "output", "id", "status"], at);
        const output = path(at, "output");
        const part: CanonicalPart = {
          type: "tool-result",
          callId: expectString(item.call_id, path(at, "call_id")),
          output:
            typeof item.output === "string"
              ? item.output
              : expectArray(item.output, output)
                  .map((entry, partIndex) => {
                    const partAt = path(output, partIndex);
                    const object = expectObject(entry, partAt);
                    if (
                      object.type !== "input_text" &&
                      object.type !== "output_text"
                    )
                      reject(
                        `A function_call_output part of type ${JSON.stringify(object.type)} cannot be carried; only text results can.`,
                        path(partAt, "type"),
                      );
                    checkFields(object, ["type", "text"], partAt);
                    return expectString(object.text, path(partAt, "text"));
                  })
                  .join("\n"),
          isError: false,
        };
        const last = messages.at(-1);
        if (
          last?.role === "user" &&
          last.parts.every((existing) => existing.type === "tool-result")
        )
          last.parts.push(part);
        else messages.push({ role: "user", parts: [part] });
        break;
      }
      case "reasoning":
        assistant().parts.push(parseReasoningItem(item, at));
        break;
      default:
        reject(
          `Responses input items of type ${JSON.stringify(type)} cannot be carried by the local proxy.`,
          path(at, "type"),
        );
    }
  });
  return { instructions, messages };
}

function parseContent(
  content: unknown,
  at: string,
  role: "system" | "user" | "assistant",
): CanonicalPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return expectArray(content, at).map((value, index): CanonicalPart => {
    const partAt = path(at, index);
    const part = expectObject(value, partAt);
    switch (part.type) {
      case "input_text":
      case "output_text":
        checkFields(part, ["type", "text", "annotations", "logprobs"], partAt);
        if (Array.isArray(part.annotations) && part.annotations.length > 0)
          reject(
            "Output-text annotations cannot be carried.",
            path(partAt, "annotations"),
          );
        return {
          type: "text",
          text: expectString(part.text, path(partAt, "text")),
        };
      case "refusal":
        checkFields(part, ["type", "refusal"], partAt);
        return {
          type: "text",
          text: expectString(part.refusal, path(partAt, "refusal")),
        };
      case "input_image": {
        if (role !== "user")
          reject(
            `A ${role} message cannot carry an image.`,
            path(partAt, "type"),
          );
        checkFields(part, ["type", "image_url", "detail"], partAt, {
          file_id:
            "uploaded files are stored upstream; send the image inline or by URL.",
        });
        if (isSet(part.detail) && part.detail !== "auto")
          reject(
            'Image `detail` other than "auto" cannot be carried to every route.',
            path(partAt, "detail"),
          );
        return {
          type: "image",
          mediaType: null,
          data: null,
          url: expectString(part.image_url, path(partAt, "image_url")),
        };
      }
      default:
        return reject(
          `Content parts of type ${JSON.stringify(part.type)} cannot be carried by the local proxy.`,
          path(partAt, "type"),
        );
    }
  });
}

/** Item fields that identify a stored item; they mean nothing with `store: false`. */
function withoutStoredIdentity(item: JsonObject): JsonObject {
  const { id: _id, status: _status, ...rest } = item;
  return rest;
}

const summaryText = (item: JsonObject): string | null => {
  const texts = (Array.isArray(item.summary) ? item.summary : [])
    .filter(isObject)
    .map((part) => (typeof part.text === "string" ? part.text : ""));
  return texts.length ? texts.join("\n\n") : null;
};

function parseReasoningItem(
  item: JsonObject,
  at: string,
): CanonicalReasoningPart {
  checkFields(
    item,
    ["type", "id", "status", "summary", "encrypted_content", "content"],
    at,
  );
  const encrypted = optionalString(
    item.encrypted_content,
    path(at, "encrypted_content"),
  );
  if (encrypted !== null) {
    const envelope = decodeReasoningEnvelope(
      encrypted,
      path(at, "encrypted_content"),
    );
    if (envelope) return envelope;
    return {
      type: "reasoning",
      text: summaryText(item),
      opaque: { protocol: "responses", value: withoutStoredIdentity(item) },
    };
  }
  // Without encrypted content there is no continuation to send back; the
  // serializer refuses this part unless the caller removes it.
  return { type: "reasoning", text: summaryText(item), opaque: null };
}

function parseTools(value: unknown): CanonicalTool[] {
  if (!isSet(value)) return [];
  return expectArray(value, "tools").map((entry, index) => {
    const at = path("tools", index);
    const tool = expectObject(entry, at);
    if (tool.type !== "function") {
      const name =
        typeof tool.type === "string" ? hostedTools[tool.type] : undefined;
      reject(
        name
          ? `The hosted ${name} tool cannot be carried by the local proxy; Topsl runs tools itself.`
          : `Tools of type ${JSON.stringify(tool.type)} cannot be carried; only function tools can.`,
        path(at, "type"),
      );
    }
    checkFields(
      tool,
      ["type", "name", "description", "parameters", "strict"],
      at,
    );
    if (tool.strict === true)
      reject(
        "Strict function schemas cannot be carried to every route.",
        path(at, "strict"),
      );
    return {
      name: expectString(tool.name, path(at, "name")),
      description:
        optionalString(tool.description, path(at, "description")) ?? "",
      inputSchema: isSet(tool.parameters)
        ? expectObject(tool.parameters, path(at, "parameters"))
        : { type: "object", properties: {} },
    };
  });
}

function parseToolChoice(value: unknown): CanonicalToolChoice {
  if (!isSet(value)) return "auto";
  if (value === "auto" || value === "none" || value === "required")
    return value;
  const choice = expectObject(value, "tool_choice");
  if (choice.type !== "function")
    reject(
      `\`tool_choice\` of type ${JSON.stringify(choice.type)} cannot be carried.`,
      "tool_choice.type",
    );
  checkFields(choice, ["type", "name"], "tool_choice");
  return { name: expectString(choice.name, "tool_choice.name") };
}

// ---------------------------------------------------------------------------
// Canonical → upstream request

/**
 * Fields the ChatGPT-plan route does not accept (developers.openai.com/siwc/
 * token-sharing-open-source/preview-limitations). The serializer never sends
 * the others; these three canonical fields must be refused when set.
 */
const planRefusedFields = [
  ["maxOutputTokens", "max_output_tokens"],
  ["temperature", "temperature"],
  ["topP", "top_p"],
] as const;

/**
 * The namespace that groups Topsl's function tools on the ChatGPT-plan
 * route. The route accepts function and custom tools only grouped in
 * namespaces or supplied through `additional_tools` input items
 * (developers.openai.com/siwc/token-sharing-open-source/preview-limitations,
 * read 6 November 2026); top-level function tools are refused. The Responses
 * reference gives a namespace tool `type`, `name`, `description` and
 * `tools`, and a function call an optional `namespace`; the name fits the
 * `^[a-zA-Z0-9_-]+$`, 64-character pattern the reference gives for it.
 */
export const planToolNamespace = "topsl";

/** Builds the upstream Responses body; always streaming and stateless. */
export function serializeRequest(
  request: CanonicalRequest,
  options: SerializeOptions,
): Record<string, unknown> {
  if (request.stop.length > 0)
    reject(
      "The Responses API has no stop sequences.",
      clientParam(request, "stop"),
    );
  if (request.thinkingBudget !== null)
    reject(
      "The Responses API has no thinking budget; set a reasoning effort instead.",
      clientParam(request, "thinkingBudget"),
    );
  if (options.profile === "chatgpt-plan")
    for (const [field, name] of planRefusedFields)
      if (request[field] !== null)
        reject(
          `The ChatGPT-plan route does not accept \`${name}\`.`,
          clientParam(request, field),
        );
  const input = serializeInput(
    request,
    options.profile === "chatgpt-plan" && options.upstream === true,
  );
  const hasReasoning = request.messages.some((message) =>
    message.parts.some((part) => part.type === "reasoning"),
  );
  const body: Record<string, unknown> = { model: options.model };
  if (request.instructions !== null) body.instructions = request.instructions;
  body.input = input;
  if (request.tools.length > 0) {
    const functions = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      // Canonical tools are not strict; Responses would otherwise default to it.
      strict: false,
    }));
    const plan = options.profile === "chatgpt-plan";
    const namespaced = plan && options.upstream === true;
    // How a named choice addresses a namespaced function is not documented
    // for this route, so it is refused rather than guessed.
    if (plan && typeof request.toolChoice === "object")
      reject(
        "The ChatGPT-plan route groups tools in a namespace; a named `tool_choice` cannot be carried. Use auto, required or none.",
        clientParam(request, "toolChoice"),
      );
    body.tools = namespaced
      ? [
          {
            type: "namespace",
            name: planToolNamespace,
            description: "Tools Topsl runs on this computer.",
            tools: functions,
          },
        ]
      : functions;
    body.tool_choice =
      typeof request.toolChoice === "string"
        ? request.toolChoice
        : { type: "function", name: request.toolChoice.name };
  } else if (
    request.toolChoice === "required" ||
    typeof request.toolChoice === "object"
  )
    reject("`tool_choice` requires tools.", clientParam(request, "toolChoice"));
  if (request.parallelToolCalls !== null)
    body.parallel_tool_calls = request.parallelToolCalls;
  if (request.reasoningEffort !== null)
    body.reasoning = { effort: request.reasoningEffort };
  if (request.reasoningEffort !== null || hasReasoning)
    body.include = ["reasoning.encrypted_content"];
  if (request.maxOutputTokens !== null)
    body.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== null) body.temperature = request.temperature;
  if (request.topP !== null) body.top_p = request.topP;
  const format = outputFormatOf(request);
  // The ChatGPT-plan limitations (read 5 November 2026) neither list
  // `text.format` as refused nor as accepted; it is sent as on the API.
  if (format)
    body.text = {
      format: {
        type: "json_schema",
        name: format.name,
        schema: format.schema,
        strict: format.strict,
      },
    };
  body.store = false;
  body.stream = true;
  return body;
}

function serializeInput(
  request: CanonicalRequest,
  namespaced: boolean,
): JsonObject[] {
  const items: JsonObject[] = [];
  const param = clientParam(request, "messages");
  request.messages.forEach((message, messageIndex) => {
    let content: JsonObject[] = [];
    const flush = () => {
      if (content.length > 0)
        items.push({ type: "message", role: message.role, content });
      content = [];
    };
    for (const part of message.parts) {
      const where = `message ${messageIndex + 1}`;
      switch (part.type) {
        case "text":
          content.push({
            type: message.role === "user" ? "input_text" : "output_text",
            text: part.text,
          });
          break;
        case "image":
          if (message.role !== "user")
            reject(
              `An assistant image (${where}) cannot be sent upstream.`,
              param,
            );
          content.push({
            type: "input_image",
            image_url: imageUrl(part, param),
            detail: "auto",
          });
          break;
        case "tool-call":
          if (message.role !== "assistant")
            reject(`A user message carries a tool call (${where}).`, param);
          flush();
          items.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            // A call the plan route made named its tool inside Topsl's namespace.
            ...(namespaced ? { namespace: planToolNamespace } : {}),
            arguments: part.arguments,
          });
          break;
        case "tool-result":
          // Responses has no error flag for a tool result; the output text
          // is sent unchanged.
          if (message.role !== "user")
            reject(
              `An assistant message carries a tool result (${where}).`,
              param,
            );
          flush();
          items.push({
            type: "function_call_output",
            call_id: part.callId,
            output: part.output,
          });
          break;
        case "reasoning": {
          if (message.role !== "assistant")
            reject(`A user message carries reasoning (${where}).`, param);
          const value = ownReasoning(part, protocol, param);
          if (!isObject(value) || typeof value.encrypted_content !== "string")
            reject(
              `Reasoning (${where}) has no encrypted content to continue from.`,
              param,
            );
          flush();
          items.push({ ...withoutStoredIdentity(value), type: "reasoning" });
          break;
        }
      }
    }
    flush();
  });
  return items;
}

// ---------------------------------------------------------------------------
// Upstream stream → canonical

const incompleteReasons: Readonly<Record<string, FinishReason>> = {
  max_output_tokens: "length",
  content_filter: "content-filter",
};

function usageEvent(value: unknown): CanonicalEvent[] {
  if (!isObject(value)) return [];
  const input = isObject(value.input_tokens_details)
    ? value.input_tokens_details
    : {};
  const output = isObject(value.output_tokens_details)
    ? value.output_tokens_details
    : {};
  return [
    {
      type: "usage",
      input: count(value.input_tokens),
      output: count(value.output_tokens),
      cachedInput: count(input.cached_tokens),
      reasoning: count(output.reasoning_tokens),
    },
  ];
}

interface OpenPart {
  index: number;
  kind: "text" | "tool" | "reasoning";
  /** Text, arguments or reasoning streamed so far. */
  text: string;
  ended: boolean;
  /** The reasoning summary or content part last streamed into this part. */
  section: string | null;
}

/**
 * Reads one Responses stream into canonical events. Output items are keyed
 * by `output_index` (and `content_index` for message text); each gets a
 * canonical index in the order it first appears.
 */
class StreamReader {
  done = false;
  private started = false;
  private next = 0;
  private readonly parts = new Map<string, OpenPart>();
  private toolCalls = false;
  private refusal = false;

  /** The events for one frame, ending at the first error. */
  read(frame: SseFrame): CanonicalEvent[] {
    if (this.done) return [];
    const events = this.handle(frame);
    const failure = events.findIndex((event) => event.type === "error");
    return failure < 0 ? events : events.slice(0, failure + 1);
  }

  private handle(frame: SseFrame): CanonicalEvent[] {
    const data = frameJson(frame);
    if (!data)
      return this.fail(malformedEvent("A Responses event is not JSON."));
    const type = typeof data.type === "string" ? data.type : frame.event;
    const outputIndex =
      typeof data.output_index === "number" ? data.output_index : 0;
    const contentIndex =
      typeof data.content_index === "number" ? data.content_index : 0;
    const textKey = `message:${outputIndex}:${contentIndex}`;
    switch (type) {
      case "response.created":
      case "response.in_progress":
      case "response.queued":
        return this.start(data.response);
      case "response.output_item.added":
        return [...this.start(null), ...this.itemAdded(data.item, outputIndex)];
      case "response.content_part.added": {
        const part = isObject(data.part) ? data.part : {};
        // Raw reasoning text has its own delta events.
        if (part.type === "reasoning_text") return [];
        if (part.type !== "output_text" && part.type !== "refusal")
          return this.fail(
            unsupportedOutput(
              `The upstream returned a ${String(part.type)} content part, which the proxy cannot carry.`,
            ),
          );
        if (part.type === "refusal") this.refusal = true;
        const record = this.part(textKey, "text");
        const text = typeof part.text === "string" ? part.text : "";
        return text ? this.append(record, text) : [];
      }
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (type === "response.refusal.delta") this.refusal = true;
        return this.append(
          this.part(textKey, "text"),
          String(data.delta ?? ""),
        );
      case "response.output_text.done":
        return this.reconcile(this.part(textKey, "text"), data.text);
      case "response.refusal.done":
        return this.reconcile(this.part(textKey, "text"), data.refusal);
      case "response.content_part.done": {
        const part = isObject(data.part) ? data.part : {};
        if (part.type === "reasoning_text") return [];
        const record = this.part(textKey, "text");
        return [
          ...this.reconcile(record, part.text ?? part.refusal),
          ...this.end(record),
        ];
      }
      case "response.function_call_arguments.delta": {
        const record = this.parts.get(`tool:${outputIndex}`);
        if (!record)
          return this.fail(
            malformedEvent(
              "Function-call arguments arrived before their item.",
            ),
          );
        return this.append(record, String(data.delta ?? ""));
      }
      case "response.function_call_arguments.done": {
        const record = this.parts.get(`tool:${outputIndex}`);
        if (!record)
          return this.fail(
            malformedEvent(
              "Function-call arguments arrived before their item.",
            ),
          );
        return this.reconcile(record, data.arguments);
      }
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const section =
          type === "response.reasoning_text.delta"
            ? `content:${contentIndex}`
            : `summary:${typeof data.summary_index === "number" ? data.summary_index : 0}`;
        const record = this.part(`reasoning:${outputIndex}`, "reasoning");
        const events: CanonicalEvent[] = [];
        // Separate summary parts the way the parser joins them.
        if (
          record.section !== null &&
          record.section !== section &&
          record.text
        )
          events.push(...this.append(record, "\n\n"));
        record.section = section;
        if (type !== "response.reasoning_summary_part.added")
          events.push(...this.append(record, String(data.delta ?? "")));
        return events;
      }
      case "response.output_item.done":
        return this.itemDone(data.item, outputIndex);
      case "response.completed":
      case "response.incomplete": {
        const response = isObject(data.response) ? data.response : {};
        const events = [...this.start(response), ...this.backfill(response)];
        events.push(...this.endAll(), ...usageEvent(response.usage));
        if (type === "response.completed")
          events.push({
            type: "finish",
            reason: this.refusal
              ? "content-filter"
              : this.toolCalls
                ? "tool-calls"
                : "stop",
            rawReason: this.refusal ? "refusal" : null,
          });
        else {
          const details = isObject(response.incomplete_details)
            ? response.incomplete_details
            : {};
          const reason =
            typeof details.reason === "string" ? details.reason : null;
          events.push({
            type: "finish",
            reason:
              (reason !== null ? incompleteReasons[reason] : undefined) ??
              "other",
            rawReason: reason,
          });
        }
        this.done = true;
        return events;
      }
      case "response.failed": {
        const response = isObject(data.response) ? data.response : {};
        const error = isObject(response.error)
          ? response.error
          : { message: "The upstream response failed." };
        return this.fail(errorEvent(openAiError(error)));
      }
      case "error":
        return this.fail(
          errorEvent(openAiError(isObject(data.error) ? data.error : data)),
        );
      default:
        // Annotations, `.done` echoes and future event types carry nothing
        // the canonical model keeps.
        return [];
    }
  }

  private start(response: unknown): CanonicalEvent[] {
    if (this.started) return [];
    this.started = true;
    const object = isObject(response) ? response : {};
    return [
      {
        type: "response-start",
        responseId: typeof object.id === "string" ? object.id : null,
        model: typeof object.model === "string" ? object.model : null,
      },
    ];
  }

  private part(key: string, kind: OpenPart["kind"]): OpenPart {
    let record = this.parts.get(key);
    if (!record) {
      record = {
        index: this.next++,
        kind,
        text: "",
        ended: false,
        section: null,
      };
      this.parts.set(key, record);
    }
    return record;
  }

  private append(record: OpenPart, text: string): CanonicalEvent[] {
    if (!text) return [];
    record.text += text;
    if (record.kind === "tool")
      return [
        { type: "tool-call-delta", index: record.index, argumentsDelta: text },
      ];
    if (record.kind === "reasoning")
      return [{ type: "reasoning-delta", index: record.index, text }];
    return [{ type: "text-delta", index: record.index, text }];
  }

  /**
   * Checks a final text against the streamed deltas: a missing tail is
   * emitted, and a contradiction fails the stream rather than reporting text
   * the client never received.
   */
  private reconcile(record: OpenPart, final: unknown): CanonicalEvent[] {
    if (typeof final !== "string" || final === record.text) return [];
    if (final.startsWith(record.text))
      return this.append(record, final.slice(record.text.length));
    return this.fail(
      malformedEvent(
        "The upstream's final output contradicts its streamed deltas.",
      ),
    );
  }

  private end(record: OpenPart): CanonicalEvent[] {
    if (record.ended) return [];
    record.ended = true;
    return [{ type: "part-end", index: record.index }];
  }

  private endAll(): CanonicalEvent[] {
    return [...this.parts.values()].flatMap((record) => this.end(record));
  }

  private itemAdded(value: unknown, outputIndex: number): CanonicalEvent[] {
    const item = isObject(value) ? value : {};
    if (item.type === "message" || item.type === "reasoning") return [];
    if (item.type !== "function_call")
      return this.fail(
        unsupportedOutput(
          `The upstream returned a ${String(item.type)} output item, which the proxy cannot carry.`,
        ),
      );
    // Topsl sends one namespace, and only on the ChatGPT-plan route; a call
    // into any other would name a tool Topsl never offered.
    if (isSet(item.namespace) && item.namespace !== planToolNamespace)
      return this.fail(
        unsupportedOutput(
          `The upstream called a tool in the ${JSON.stringify(String(item.namespace)).slice(0, 80)} namespace, which Topsl did not offer.`,
        ),
      );
    this.toolCalls = true;
    const record = this.part(`tool:${outputIndex}`, "tool");
    return [
      {
        type: "tool-call-start",
        index: record.index,
        id: String(item.call_id ?? ""),
        name: String(item.name ?? ""),
      },
      ...this.append(
        record,
        typeof item.arguments === "string" ? item.arguments : "",
      ),
    ];
  }

  private itemDone(value: unknown, outputIndex: number): CanonicalEvent[] {
    const item = isObject(value) ? value : {};
    const events: CanonicalEvent[] = [];
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      content.forEach((part, contentIndex) => {
        if (!isObject(part)) return;
        if (part.type === "refusal") this.refusal = true;
        const record = this.part(
          `message:${outputIndex}:${contentIndex}`,
          "text",
        );
        events.push(
          ...this.reconcile(record, part.text ?? part.refusal),
          ...this.end(record),
        );
      });
      for (const [key, record] of this.parts)
        if (key.startsWith(`message:${outputIndex}:`))
          events.push(...this.end(record));
    } else if (item.type === "function_call") {
      let record = this.parts.get(`tool:${outputIndex}`);
      if (!record) {
        events.push(...this.itemAdded(item, outputIndex));
        // A refused call (another namespace) opens no part.
        if (this.done) return events;
      }
      record = this.parts.get(`tool:${outputIndex}`)!;
      events.push(
        ...this.reconcile(record, item.arguments),
        ...this.end(record),
      );
    } else if (item.type === "reasoning") {
      const record = this.part(`reasoning:${outputIndex}`, "reasoning");
      if (!record.text)
        events.push(...this.append(record, summaryText(item) ?? ""));
      if (typeof item.encrypted_content === "string")
        events.push({
          type: "reasoning-opaque",
          index: record.index,
          value: { protocol: "responses", value: withoutStoredIdentity(item) },
        });
      events.push(...this.end(record));
    } else
      return this.fail(
        unsupportedOutput(
          `The upstream returned a ${String(item.type)} output item, which the proxy cannot carry.`,
        ),
      );
    return events;
  }

  /** Output a terminal response lists but the stream never delivered. */
  private backfill(response: JsonObject): CanonicalEvent[] {
    if (this.parts.size > 0 || !Array.isArray(response.output)) return [];
    return response.output.flatMap((item, outputIndex) => [
      ...this.itemAdded(item, outputIndex),
      ...this.itemDone(item, outputIndex),
    ]);
  }

  private fail(event: CanonicalEvent): CanonicalEvent[] {
    this.done = true;
    return [event];
  }
}

/** Reads an upstream Responses stream into canonical events. */
export async function* readStream(
  frames: AsyncIterable<SseFrame>,
): AsyncGenerator<CanonicalEvent> {
  const reader = new StreamReader();
  for await (const frame of frames) {
    const events = reader.read(frame);
    yield* events;
    if (reader.done) return;
  }
}

/**
 * Reads a non-streaming Responses body (or an OpenAI error body) by
 * replaying it through the stream reader's item handling.
 */
export function readResponse(body: unknown): CanonicalEvent[] {
  const object = isObject(body) ? body : {};
  if (object.object !== "response" && isObject(object.error))
    return [errorEvent(openAiError(object.error))];
  const reader = new StreamReader();
  const frame = (data: JsonObject): CanonicalEvent[] =>
    reader.read({ event: null, data: JSON.stringify(data), id: null });
  const events = frame({ type: "response.created", response: object });
  const output = Array.isArray(object.output) ? object.output : [];
  output.forEach((item, output_index) => {
    events.push(
      ...frame({ type: "response.output_item.added", output_index, item }),
      ...frame({ type: "response.output_item.done", output_index, item }),
    );
  });
  if (object.status === "completed" || object.status === "incomplete")
    events.push(
      ...frame({ type: `response.${object.status}`, response: object }),
    );
  else if (object.status === "failed")
    events.push(...frame({ type: "response.failed", response: object }));
  // Any other status (queued, in progress) has no terminal event, which
  // collectResponse records as interrupted.
  return events;
}

// ---------------------------------------------------------------------------
// Canonical → client stream

function usageJson(usage: CanonicalUsage): JsonObject | null {
  if (usage.input === null && usage.output === null) return null;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  return {
    input_tokens: input,
    ...(usage.cachedInput !== null
      ? { input_tokens_details: { cached_tokens: usage.cachedInput } }
      : {}),
    output_tokens: output,
    ...(usage.reasoning !== null
      ? { output_tokens_details: { reasoning_tokens: usage.reasoning } }
      : {}),
    total_tokens: input + output,
  };
}

/** How a canonical finish appears as a Responses status. */
function terminalStatus(
  finish: FinishReason | null,
  rawReason: string | null,
): { status: "completed" | "incomplete"; reason: string | null } {
  switch (finish) {
    case "stop":
    case "tool-calls":
      return { status: "completed", reason: null };
    case "length":
      return { status: "incomplete", reason: "max_output_tokens" };
    case "content-filter":
      return { status: "incomplete", reason: "content_filter" };
    default:
      return { status: "incomplete", reason: rawReason ?? "other" };
  }
}

function reasoningItem(id: string, part: CanonicalReasoningPart): JsonObject {
  if (part.opaque?.protocol === protocol && isObject(part.opaque.value))
    return { id, ...part.opaque.value, type: "reasoning" };
  return {
    id,
    type: "reasoning",
    summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
    // Another protocol's continuation travels in an envelope the parser
    // restores; a part with none has nothing to continue from.
    ...(part.opaque
      ? { encrypted_content: encodeReasoningEnvelope(part) }
      : {}),
  };
}

function outputItem(id: string, part: CanonicalPart): JsonObject | null {
  switch (part.type) {
    case "text":
      return {
        id,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: part.text, annotations: [] }],
      };
    case "tool-call":
      return {
        id,
        type: "function_call",
        status: "completed",
        call_id: part.id,
        name: part.name,
        arguments: part.arguments,
      };
    case "reasoning":
      return reasoningItem(id, part);
    default:
      return null;
  }
}

const itemPrefix: Record<"text" | "tool" | "reasoning", string> = {
  text: "msg",
  tool: "fc",
  reasoning: "rs",
};

interface WriterItem {
  kind: "text" | "tool" | "reasoning";
  outputIndex: number;
  id: string;
  text: string;
  callId: string;
  name: string;
  opaque: CanonicalReasoningPart["opaque"];
  summaryStarted: boolean;
  closed: boolean;
}

/** Writes canonical events as the Responses SSE a client expects. */
class StreamWriter {
  done = false;
  private sequence = 0;
  private started = false;
  private readonly createdAt = unixSeconds();
  private readonly items = new Map<number, WriterItem>();
  private readonly output: JsonObject[] = [];
  private nextOutput = 0;
  private usage: CanonicalUsage = emptyUsage();

  constructor(private readonly meta: { model: string; responseId: string }) {}

  write(event: CanonicalEvent): string[] {
    if (this.done) return [];
    const out = this.start();
    switch (event.type) {
      case "response-start":
        break;
      case "text-delta": {
        const item = this.open(event.index, "text", out);
        if (!item) break;
        item.text += event.text;
        out.push(
          this.emit("response.output_text.delta", {
            item_id: item.id,
            output_index: item.outputIndex,
            content_index: 0,
            delta: event.text,
            logprobs: [],
          }),
        );
        break;
      }
      case "reasoning-delta": {
        const item = this.open(event.index, "reasoning", out);
        if (!item) break;
        if (!item.summaryStarted) {
          item.summaryStarted = true;
          out.push(
            this.emit("response.reasoning_summary_part.added", {
              item_id: item.id,
              output_index: item.outputIndex,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            }),
          );
        }
        item.text += event.text;
        out.push(
          this.emit("response.reasoning_summary_text.delta", {
            item_id: item.id,
            output_index: item.outputIndex,
            summary_index: 0,
            delta: event.text,
          }),
        );
        break;
      }
      case "reasoning-opaque": {
        const item = this.open(event.index, "reasoning", out);
        if (item) item.opaque = opaqueOf(event.value);
        break;
      }
      case "tool-call-start": {
        const item = this.open(event.index, "tool", out, event);
        if (item) {
          item.callId = event.id;
          item.name = event.name;
        }
        break;
      }
      case "tool-call-delta": {
        const item = this.items.get(event.index);
        if (!item || item.kind !== "tool" || item.closed) break;
        item.text += event.argumentsDelta;
        out.push(
          this.emit("response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: item.outputIndex,
            delta: event.argumentsDelta,
          }),
        );
        break;
      }
      case "part-end":
        out.push(...this.close(event.index));
        break;
      case "usage":
        this.usage = mergeUsage(this.usage, event);
        break;
      case "finish": {
        for (const index of this.items.keys()) out.push(...this.close(index));
        const { status, reason } = terminalStatus(
          event.reason,
          event.rawReason,
        );
        out.push(
          this.emit(`response.${status}`, {
            response: this.response(status, {
              incomplete_details: reason !== null ? { reason } : null,
            }),
          }),
        );
        this.done = true;
        break;
      }
      case "error":
        out.push(this.failed(event.error));
        break;
    }
    return out;
  }

  /** Reports a source that ended without a terminal event as failed. */
  end(): string[] {
    if (this.done) return [];
    return [...this.start(), this.failed(interruptedError())];
  }

  private failed(error: ProxyErrorInfo): string {
    this.done = true;
    return this.emit("response.failed", {
      response: this.response("failed", {
        error: { code: openAiErrorCode(error), message: error.message },
      }),
    });
  }

  private emit(type: string, payload: JsonObject): string {
    return formatSse({
      event: type,
      data: JSON.stringify({
        type,
        sequence_number: this.sequence++,
        ...payload,
      }),
    });
  }

  private response(status: string, extra: JsonObject = {}): JsonObject {
    return {
      id: this.meta.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      error: null,
      incomplete_details: null,
      model: this.meta.model,
      output: this.output.filter((item) => item !== undefined),
      usage: status === "in_progress" ? null : usageJson(this.usage),
      ...extra,
    };
  }

  private start(): string[] {
    if (this.started) return [];
    this.started = true;
    const response = this.response("in_progress");
    return [
      this.emit("response.created", { response }),
      this.emit("response.in_progress", { response }),
    ];
  }

  /** The output item for a canonical part, announcing it on first use. */
  private open(
    index: number,
    kind: WriterItem["kind"],
    out: string[],
    call?: { id: string; name: string },
  ): WriterItem | null {
    const existing = this.items.get(index);
    if (existing)
      return existing.kind === kind && !existing.closed ? existing : null;
    const outputIndex = this.nextOutput++;
    const item: WriterItem = {
      kind,
      outputIndex,
      id: `${itemPrefix[kind]}_${this.meta.responseId}_${outputIndex}`,
      text: "",
      callId: call?.id ?? "",
      name: call?.name ?? "",
      opaque: null,
      summaryStarted: false,
      closed: false,
    };
    this.items.set(index, item);
    const added =
      kind === "text"
        ? {
            id: item.id,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          }
        : kind === "tool"
          ? {
              id: item.id,
              type: "function_call",
              status: "in_progress",
              call_id: item.callId,
              name: item.name,
              arguments: "",
            }
          : { id: item.id, type: "reasoning", summary: [] };
    out.push(
      this.emit("response.output_item.added", {
        output_index: outputIndex,
        item: added,
      }),
    );
    if (kind === "text")
      out.push(
        this.emit("response.content_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      );
    return item;
  }

  private close(index: number): string[] {
    const item = this.items.get(index);
    if (!item || item.closed) return [];
    item.closed = true;
    const out: string[] = [];
    const at = { item_id: item.id, output_index: item.outputIndex };
    let done: JsonObject;
    if (item.kind === "text") {
      const part = { type: "output_text", text: item.text, annotations: [] };
      out.push(
        this.emit("response.output_text.done", {
          ...at,
          content_index: 0,
          text: item.text,
          logprobs: [],
        }),
        this.emit("response.content_part.done", {
          ...at,
          content_index: 0,
          part,
        }),
      );
      done = outputItem(item.id, { type: "text", text: item.text })!;
    } else if (item.kind === "tool") {
      out.push(
        this.emit("response.function_call_arguments.done", {
          ...at,
          name: item.name,
          arguments: item.text,
        }),
      );
      done = outputItem(item.id, {
        type: "tool-call",
        id: item.callId,
        name: item.name,
        arguments: item.text,
      })!;
    } else {
      if (item.summaryStarted)
        out.push(
          this.emit("response.reasoning_summary_text.done", {
            ...at,
            summary_index: 0,
            text: item.text,
          }),
          this.emit("response.reasoning_summary_part.done", {
            ...at,
            summary_index: 0,
            part: { type: "summary_text", text: item.text },
          }),
        );
      done = reasoningItem(item.id, {
        type: "reasoning",
        text: item.text || null,
        opaque: item.opaque,
      });
    }
    this.output[item.outputIndex] = done;
    out.push(
      this.emit("response.output_item.done", {
        output_index: item.outputIndex,
        item: done,
      }),
    );
    return out;
  }
}

/** Writes canonical events as a client-facing Responses stream. */
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

/** A complete client-facing Responses object. */
export function writeResponse(
  response: CanonicalResponse,
  meta: { model: string; responseId: string },
): Record<string, unknown> {
  const output = response.output
    .map((part, index) => {
      const kind =
        part.type === "tool-call"
          ? "tool"
          : part.type === "reasoning"
            ? "reasoning"
            : "text";
      return outputItem(
        `${itemPrefix[kind]}_${meta.responseId}_${index}`,
        part,
      );
    })
    .filter((item): item is JsonObject => item !== null);
  const failed = response.error !== null;
  const { status, reason } = failed
    ? { status: "failed", reason: null }
    : terminalStatus(response.finish, response.rawFinishReason);
  return {
    id: meta.responseId,
    object: "response",
    created_at: unixSeconds(),
    status,
    error: response.error
      ? {
          code: openAiErrorCode(response.error),
          message: response.error.message,
        }
      : null,
    incomplete_details: reason !== null ? { reason } : null,
    model: meta.model,
    output,
    usage: usageJson(response.usage),
  };
}

/** The OpenAI error JSON a Responses client expects. */
export function errorBody(error: ProxyErrorInfo): Record<string, unknown> {
  return openAiErrorBody(error);
}
