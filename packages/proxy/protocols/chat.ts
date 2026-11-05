import {
  emptyUsage,
  type CanonicalEvent,
  type CanonicalMessage,
  type CanonicalOutputFormat,
  type CanonicalPart,
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
  errorEvent,
  expectArray,
  expectObject,
  expectString,
  frameJson,
  imageUrl,
  interruptedError,
  isObject,
  isSet,
  joinTextBlocks,
  malformedEvent,
  mergeAdjacentRoles,
  mergeUsage,
  openAiError,
  openAiErrorBody,
  optionalBoolean,
  optionalCount,
  optionalNumber,
  optionalString,
  outputFormatOf,
  parseSchemaFormat,
  path,
  reject,
  toolResultsFirst,
  unixSeconds,
  unsupportedOutput,
  type JsonObject,
} from "./shared";

/**
 * The OpenAI Chat Completions protocol (`POST /v1/chat/completions`), the
 * compatibility protocol for gateways and local models such as Ollama
 * (docs/Native_Harness_Plan.md §2). It has no field for reasoning
 * continuation, so reasoning can be read from it but never sent back.
 */
export const protocol: ClientProtocol = "chat";

export interface SerializeOptions {
  model: string;
  profile: ConnectionKind;
  defaultMaxOutputTokens?: number;
}

// ---------------------------------------------------------------------------
// Client request → canonical

const requestFields = [
  "model",
  "messages",
  "tools",
  "tool_choice",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "stream",
  "stream_options",
  "reasoning_effort",
  "parallel_tool_calls",
  "n",
  "logprobs",
  "response_format",
  "modalities",
] as const;

const rejectedRequestFields: Readonly<Record<string, string>> = {
  functions: "legacy function calling is not supported; declare `tools`.",
  function_call: "legacy function calling is not supported; use `tool_choice`.",
  user: "end-user identifiers cannot be carried to every route.",
  metadata: "request metadata cannot be carried to every route.",
  seed: "sampling seeds cannot be carried to every route.",
  logit_bias: "logit bias cannot be carried to every route.",
  audio: "audio output is not supported.",
  top_logprobs: "log probabilities cannot be carried to every route.",
};

/**
 * Whether a Chat client asked for a final usage chunk
 * (`stream_options.include_usage`), for `writeStream`'s `includeUsage`.
 */
export function includeUsage(body: unknown): boolean {
  return (
    isObject(body) &&
    isObject(body.stream_options) &&
    body.stream_options.include_usage === true
  );
}

/** Parses a client's Chat Completions request; refuses what it cannot carry. */
export function parseRequest(body: unknown): CanonicalRequest {
  const request = expectObject(body, "body");
  checkFields(request, requestFields, "", rejectedRequestFields);
  if (isSet(request.n) && request.n !== 1)
    reject("Only one choice (`n: 1`) can be carried.", "n");
  if (isSet(request.logprobs) && request.logprobs !== false)
    reject("Log probabilities cannot be carried to every route.", "logprobs");
  let outputFormat: CanonicalOutputFormat | null = null;
  if (isSet(request.response_format)) {
    const format = expectObject(request.response_format, "response_format");
    if (format.type === "json_schema") {
      checkFields(format, ["type", "json_schema"], "response_format");
      outputFormat = parseSchemaFormat(
        expectObject(format.json_schema, "response_format.json_schema"),
        "response_format.json_schema",
      );
    } else {
      checkFields(format, ["type"], "response_format");
      if (format.type !== "text")
        reject(
          'Only plain text (`response_format.type: "text"`) or a JSON Schema (`"json_schema"`) can be carried; JSON mode without a schema cannot.',
          "response_format.type",
        );
    }
  }
  if (isSet(request.modalities)) {
    const modalities = expectArray(request.modalities, "modalities");
    if (modalities.some((modality) => modality !== "text"))
      reject("Only text output can be carried.", "modalities");
  }
  if (isSet(request.stream_options)) {
    const options = expectObject(request.stream_options, "stream_options");
    checkFields(options, ["include_usage"], "stream_options");
    optionalBoolean(options.include_usage, "stream_options.include_usage");
  }
  const maxTokens = optionalCount(request.max_tokens, "max_tokens");
  const maxCompletionTokens = optionalCount(
    request.max_completion_tokens,
    "max_completion_tokens",
  );
  if (
    maxTokens !== null &&
    maxCompletionTokens !== null &&
    maxTokens !== maxCompletionTokens
  )
    reject(
      "`max_tokens` and `max_completion_tokens` disagree.",
      "max_completion_tokens",
    );
  const { instructions, messages } = parseMessages(request.messages);
  return {
    model: expectString(request.model, "model"),
    instructions: instructions.length ? instructions.join("\n\n") : null,
    messages,
    tools: parseTools(request.tools),
    toolChoice: parseToolChoice(request.tool_choice),
    maxOutputTokens: maxCompletionTokens ?? maxTokens,
    temperature: optionalNumber(request.temperature, "temperature"),
    topP: optionalNumber(request.top_p, "top_p"),
    stop: !isSet(request.stop)
      ? []
      : typeof request.stop === "string"
        ? [request.stop]
        : expectArray(request.stop, "stop").map((entry, index) =>
            expectString(entry, path("stop", index)),
          ),
    reasoningEffort: optionalString(
      request.reasoning_effort,
      "reasoning_effort",
    ),
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

/** Text from a string or an array of text parts. */
function textContent(value: unknown, at: string): string {
  if (typeof value === "string") return value;
  return joinTextBlocks(expectArray(value, at), at, ["text"]);
}

/**
 * Converts messages. Leading system and developer messages become the
 * instructions; a later one would need its position kept, which the
 * canonical model cannot do.
 */
function parseMessages(value: unknown): {
  instructions: string[];
  messages: CanonicalMessage[];
} {
  const instructions: string[] = [];
  const messages: CanonicalMessage[] = [];
  expectArray(value, "messages").forEach((entry, index) => {
    const at = path("messages", index);
    const message = expectObject(entry, at);
    const role = message.role;
    const content = path(at, "content");
    switch (role) {
      case "system":
      case "developer":
        checkFields(message, ["role", "content"], at, {
          name: "participant names cannot be carried.",
        });
        if (messages.length > 0)
          reject(
            `A ${role} message after the conversation has started cannot be carried; put instructions first.`,
            path(at, "role"),
          );
        instructions.push(textContent(message.content, content));
        break;
      case "user":
        checkFields(message, ["role", "content"], at, {
          name: "participant names cannot be carried.",
        });
        messages.push({
          role: "user",
          parts: parseUserContent(message.content, content),
        });
        break;
      case "assistant": {
        checkFields(message, ["role", "content", "tool_calls", "refusal"], at, {
          name: "participant names cannot be carried.",
          audio: "audio output is not supported.",
          function_call:
            "legacy function calls are not supported; use `tool_calls`.",
        });
        const parts: CanonicalPart[] = [];
        // A refusal is the assistant's visible text; the canonical model
        // has no separate refusal part.
        const text =
          (isSet(message.content)
            ? assistantText(message.content, content)
            : "") +
          (optionalString(message.refusal, path(at, "refusal")) ?? "");
        if (text) parts.push({ type: "text", text });
        if (isSet(message.tool_calls))
          expectArray(message.tool_calls, path(at, "tool_calls")).forEach(
            (call, callIndex) => {
              const callAt = path(path(at, "tool_calls"), callIndex);
              const object = expectObject(call, callAt);
              checkFields(object, ["id", "type", "function"], callAt);
              if (object.type !== "function")
                reject(
                  "Only function tool calls can be carried.",
                  path(callAt, "type"),
                );
              const fn = expectObject(
                object.function,
                path(callAt, "function"),
              );
              checkFields(fn, ["name", "arguments"], path(callAt, "function"));
              parts.push({
                type: "tool-call",
                id: expectString(object.id, path(callAt, "id")),
                name: expectString(fn.name, path(callAt, "function.name")),
                arguments: expectString(
                  fn.arguments,
                  path(callAt, "function.arguments"),
                ),
              });
            },
          );
        messages.push({ role: "assistant", parts });
        break;
      }
      case "tool": {
        checkFields(message, ["role", "content", "tool_call_id"], at);
        const part: CanonicalPart = {
          type: "tool-result",
          callId: expectString(message.tool_call_id, path(at, "tool_call_id")),
          output: textContent(message.content, content),
          isError: false,
        };
        // Consecutive tool messages answer one assistant turn together.
        const last = messages.at(-1);
        if (
          last?.role === "user" &&
          last.parts.every((existing) => existing.type === "tool-result")
        )
          last.parts.push(part);
        else messages.push({ role: "user", parts: [part] });
        break;
      }
      default:
        reject(
          role === "function"
            ? "Legacy function messages are not supported; use tool messages."
            : `Unknown message role ${JSON.stringify(role)}.`,
          path(at, "role"),
        );
    }
  });
  return { instructions, messages };
}

/** Assistant content: a string, or text and refusal parts. */
function assistantText(value: unknown, at: string): string {
  if (typeof value === "string") return value;
  return expectArray(value, at)
    .map((entry, index) => {
      const partAt = path(at, index);
      const part = expectObject(entry, partAt);
      if (part.type === "text") {
        checkFields(part, ["type", "text"], partAt);
        return expectString(part.text, path(partAt, "text"));
      }
      if (part.type === "refusal") {
        checkFields(part, ["type", "refusal"], partAt);
        return expectString(part.refusal, path(partAt, "refusal"));
      }
      return reject(
        `Assistant content parts of type ${JSON.stringify(part.type)} cannot be carried.`,
        path(partAt, "type"),
      );
    })
    .join("");
}

function parseUserContent(value: unknown, at: string): CanonicalPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return expectArray(value, at).map((entry, index): CanonicalPart => {
    const partAt = path(at, index);
    const part = expectObject(entry, partAt);
    if (part.type === "text") {
      checkFields(part, ["type", "text"], partAt);
      return {
        type: "text",
        text: expectString(part.text, path(partAt, "text")),
      };
    }
    if (part.type === "image_url") {
      checkFields(part, ["type", "image_url"], partAt);
      const image = expectObject(part.image_url, path(partAt, "image_url"));
      checkFields(image, ["url", "detail"], path(partAt, "image_url"));
      if (isSet(image.detail) && image.detail !== "auto")
        reject(
          'Image `detail` other than "auto" cannot be carried to every route.',
          path(partAt, "image_url.detail"),
        );
      return {
        type: "image",
        mediaType: null,
        data: null,
        url: expectString(image.url, path(partAt, "image_url.url")),
      };
    }
    return reject(
      `Content parts of type ${JSON.stringify(part.type)} cannot be carried by the local proxy.`,
      path(partAt, "type"),
    );
  });
}

function parseTools(value: unknown): CanonicalTool[] {
  if (!isSet(value)) return [];
  return expectArray(value, "tools").map((entry, index) => {
    const at = path("tools", index);
    const tool = expectObject(entry, at);
    if (tool.type !== "function")
      reject(
        `Tools of type ${JSON.stringify(tool.type)} cannot be carried; only function tools can.`,
        path(at, "type"),
      );
    checkFields(tool, ["type", "function"], at);
    const fnAt = path(at, "function");
    const fn = expectObject(tool.function, fnAt);
    checkFields(fn, ["name", "description", "parameters", "strict"], fnAt);
    if (fn.strict === true)
      reject(
        "Strict function schemas cannot be carried to every route.",
        path(fnAt, "strict"),
      );
    return {
      name: expectString(fn.name, path(fnAt, "name")),
      description:
        optionalString(fn.description, path(fnAt, "description")) ?? "",
      inputSchema: isSet(fn.parameters)
        ? expectObject(fn.parameters, path(fnAt, "parameters"))
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
  checkFields(choice, ["type", "function"], "tool_choice");
  const fn = expectObject(choice.function, "tool_choice.function");
  checkFields(fn, ["name"], "tool_choice.function");
  return { name: expectString(fn.name, "tool_choice.function.name") };
}

// ---------------------------------------------------------------------------
// Canonical → upstream request

/** Builds the upstream Chat Completions body; always streaming with usage. */
export function serializeRequest(
  request: CanonicalRequest,
  options: SerializeOptions,
): Record<string, unknown> {
  if (request.thinkingBudget !== null)
    reject(
      "Chat Completions has no thinking budget; set a reasoning effort instead.",
      clientParam(request, "thinkingBudget"),
    );
  const body: Record<string, unknown> = {
    model: options.model,
    messages: serializeMessages(request),
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
      },
    }));
    body.tool_choice =
      typeof request.toolChoice === "string"
        ? request.toolChoice
        : { type: "function", function: { name: request.toolChoice.name } };
    // OpenAI refuses `parallel_tool_calls` without tools; without tools it means nothing.
    if (request.parallelToolCalls !== null)
      body.parallel_tool_calls = request.parallelToolCalls;
  } else if (
    request.toolChoice === "required" ||
    typeof request.toolChoice === "object"
  )
    reject("`tool_choice` requires tools.", clientParam(request, "toolChoice"));
  if (request.maxOutputTokens !== null)
    // OpenAI itself prefers max_completion_tokens; gateways and Ollama
    // understand max_tokens.
    body[
      options.profile === "openai-api" ? "max_completion_tokens" : "max_tokens"
    ] = request.maxOutputTokens;
  if (request.temperature !== null) body.temperature = request.temperature;
  if (request.topP !== null) body.top_p = request.topP;
  if (request.stop.length > 0) body.stop = request.stop;
  if (request.reasoningEffort !== null)
    body.reasoning_effort = request.reasoningEffort;
  const format = outputFormatOf(request);
  // Gateways and local servers differ in whether they enforce it; a server
  // that refuses `response_format` answers with an error, which is shown.
  if (format)
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: format.name,
        schema: format.schema,
        strict: format.strict,
      },
    };
  body.stream = true;
  body.stream_options = { include_usage: true };
  return body;
}

function serializeMessages(request: CanonicalRequest): JsonObject[] {
  const param = clientParam(request, "messages");
  const messages: JsonObject[] = [];
  if (request.instructions !== null)
    messages.push({ role: "system", content: request.instructions });
  mergeAdjacentRoles(request.messages).forEach((message, messageIndex) => {
    const where = `turn ${messageIndex + 1}`;
    if (message.role === "assistant") {
      let text = "";
      const calls: JsonObject[] = [];
      for (const part of message.parts) {
        if (part.type === "text") text += part.text;
        else if (part.type === "tool-call")
          calls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: part.arguments },
          });
        else if (part.type === "reasoning")
          reject(
            `Chat Completions cannot carry reasoning back upstream (${where}). Remove it (withoutForeignReasoning) before using this route.`,
            param,
          );
        else
          reject(
            `An assistant ${part.type} part (${where}) cannot be sent upstream.`,
            param,
          );
      }
      if (!text && calls.length === 0) return;
      messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      return;
    }
    const content: JsonObject[] = [];
    for (const part of toolResultsFirst(message.parts)) {
      if (part.type === "tool-result")
        // Chat has no error flag for a tool result; the output is sent unchanged.
        messages.push({
          role: "tool",
          tool_call_id: part.callId,
          content: part.output,
        });
      else if (part.type === "text")
        content.push({ type: "text", text: part.text });
      else if (part.type === "image")
        content.push({
          type: "image_url",
          image_url: { url: imageUrl(part, param) },
        });
      else
        reject(
          `A user ${part.type} part (${where}) cannot be sent upstream.`,
          param,
        );
    }
    if (content.length === 0) return;
    messages.push({
      role: "user",
      content:
        content.length === 1 && content[0].type === "text"
          ? content[0].text
          : content,
    });
  });
  return messages;
}

// ---------------------------------------------------------------------------
// Upstream stream → canonical

const finishReasons: Readonly<Record<string, FinishReason>> = {
  stop: "stop",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  length: "length",
  content_filter: "content-filter",
};

function usageEvent(value: unknown): CanonicalEvent[] {
  if (!isObject(value)) return [];
  const prompt = isObject(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : {};
  const completion = isObject(value.completion_tokens_details)
    ? value.completion_tokens_details
    : {};
  return [
    {
      type: "usage",
      input: count(value.prompt_tokens),
      output: count(value.completion_tokens),
      cachedInput: count(prompt.cached_tokens),
      reasoning: count(completion.reasoning_tokens),
    },
  ];
}

interface ToolState {
  index: number | null;
  id: string | null;
  name: string | null;
  /** Arguments that arrived before the call's name. */
  pending: string;
}

/**
 * Reads one Chat Completions stream. Reasoning, text and each tool call get
 * their own canonical index. Reasoning and text end when the other kind
 * begins, so a client sees one part at a time; text that resumes later
 * becomes a new part. Tool calls stay open until the finish, because
 * gateways may interleave them by `index`.
 */
class StreamReader {
  done = false;
  private started = false;
  private responseId: string | null = null;
  private next = 0;
  private text: number | null = null;
  private reasoning: number | null = null;
  private readonly tools = new Map<number, ToolState>();
  private readonly ended = new Set<number>();
  private finish: { reason: FinishReason; rawReason: string | null } | null =
    null;
  private refusal = false;

  read(frame: SseFrame): CanonicalEvent[] {
    if (this.done) return [];
    if (frame.data.trim() === "[DONE]") return this.complete(true);
    const data = frameJson(frame);
    if (!data)
      return this.fail(malformedEvent("A Chat Completions chunk is not JSON."));
    if (isObject(data.error))
      return this.fail(errorEvent(openAiError(data.error)));
    const events: CanonicalEvent[] = [];
    if (!this.started) {
      this.started = true;
      this.responseId = typeof data.id === "string" ? data.id : null;
      events.push({
        type: "response-start",
        responseId: this.responseId,
        model: typeof data.model === "string" ? data.model : null,
      });
    }
    const choices = Array.isArray(data.choices) ? data.choices : [];
    for (const entry of choices) {
      const choice = isObject(entry) ? entry : {};
      if (isSet(choice.index) && choice.index !== 0)
        return [
          ...events,
          ...this.fail(
            unsupportedOutput("The upstream returned more than one choice."),
          ),
        ];
      const delta = isObject(choice.delta) ? choice.delta : {};
      if (isSet(delta.function_call))
        return [
          ...events,
          ...this.fail(
            unsupportedOutput("The upstream returned a legacy function call."),
          ),
        ];
      const reasoning =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : "";
      if (reasoning) {
        events.push(...this.endText());
        if (this.reasoning === null) this.reasoning = this.next++;
        events.push({
          type: "reasoning-delta",
          index: this.reasoning,
          text: reasoning,
        });
      }
      const refusal = typeof delta.refusal === "string" ? delta.refusal : "";
      if (refusal) this.refusal = true;
      const text =
        (typeof delta.content === "string" ? delta.content : "") + refusal;
      if (text) {
        events.push(...this.endReasoning());
        if (this.text === null) this.text = this.next++;
        events.push({ type: "text-delta", index: this.text, text });
      }
      if (Array.isArray(delta.tool_calls))
        delta.tool_calls.forEach((call, position) =>
          events.push(...this.toolDelta(call, position)),
        );
      // Some gateways send an empty string rather than null mid-stream.
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        this.finish = {
          reason: finishReasons[choice.finish_reason] ?? "other",
          rawReason: choice.finish_reason,
        };
        events.push(...this.endAll());
      }
    }
    events.push(...usageEvent(data.usage));
    return events;
  }

  /**
   * The terminal event, at `[DONE]` or when the source ends. `[DONE]`
   * without a finish reason still ends the response, judged by its output;
   * a source that simply stops without either is not complete.
   */
  complete(done: boolean): CanonicalEvent[] {
    if (this.done) return [];
    if (!this.finish && !done) return [];
    this.done = true;
    const events = this.endAll();
    let finish = this.finish ?? {
      reason: this.tools.size > 0 ? "tool-calls" : "stop",
      rawReason: null,
    };
    if (this.refusal && finish.reason === "stop")
      finish = { reason: "content-filter", rawReason: "refusal" };
    events.push({ type: "finish", ...finish });
    return events;
  }

  private toolDelta(value: unknown, position: number): CanonicalEvent[] {
    const call = isObject(value) ? value : {};
    const key = typeof call.index === "number" ? call.index : position;
    let state = this.tools.get(key);
    const events: CanonicalEvent[] = [
      ...this.endText(),
      ...this.endReasoning(),
    ];
    if (!state) {
      state = { index: null, id: null, name: null, pending: "" };
      this.tools.set(key, state);
    }
    const fn = isObject(call.function) ? call.function : {};
    if (typeof call.id === "string" && call.id) state.id ??= call.id;
    if (typeof fn.name === "string" && fn.name) state.name ??= fn.name;
    const args = typeof fn.arguments === "string" ? fn.arguments : "";
    if (state.index === null) {
      state.pending += args;
      if (state.name !== null) events.push(...this.startTool(key, state));
    } else if (args)
      events.push({
        type: "tool-call-delta",
        index: state.index,
        argumentsDelta: args,
      });
    return events;
  }

  /**
   * Starts a call once its name is known. A gateway that sends no call ID
   * gets one derived from the response, which the next request's tool
   * result then quotes exactly.
   */
  private startTool(key: number, state: ToolState): CanonicalEvent[] {
    state.index = this.next++;
    const events: CanonicalEvent[] = [
      {
        type: "tool-call-start",
        index: state.index,
        id: state.id ?? `call_${this.responseId ?? "chat"}_${key}`,
        name: state.name ?? "",
      },
    ];
    if (state.pending)
      events.push({
        type: "tool-call-delta",
        index: state.index,
        argumentsDelta: state.pending,
      });
    state.pending = "";
    return events;
  }

  private end(index: number | null): CanonicalEvent[] {
    if (index === null || this.ended.has(index)) return [];
    this.ended.add(index);
    return [{ type: "part-end", index }];
  }

  private endText(): CanonicalEvent[] {
    const events = this.end(this.text);
    this.text = null;
    return events;
  }

  private endReasoning(): CanonicalEvent[] {
    const events = this.end(this.reasoning);
    this.reasoning = null;
    return events;
  }

  private endAll(): CanonicalEvent[] {
    const events = [...this.endReasoning(), ...this.endText()];
    for (const [key, state] of this.tools) {
      if (state.index === null) events.push(...this.startTool(key, state));
      events.push(...this.end(state.index));
    }
    return events;
  }

  private fail(event: CanonicalEvent): CanonicalEvent[] {
    this.done = true;
    return [event];
  }
}

/** Reads an upstream Chat Completions stream into canonical events. */
export async function* readStream(
  frames: AsyncIterable<SseFrame>,
): AsyncGenerator<CanonicalEvent> {
  const reader = new StreamReader();
  for await (const frame of frames) {
    yield* reader.read(frame);
    if (reader.done) return;
  }
  yield* reader.complete(false);
}

/** Reads a non-streaming Chat Completions body (or error body). */
export function readResponse(body: unknown): CanonicalEvent[] {
  const object = isObject(body) ? body : {};
  if (isObject(object.error)) return [errorEvent(openAiError(object.error))];
  const reader = new StreamReader();
  const choices = Array.isArray(object.choices) ? object.choices : [];
  const events = reader.read({
    event: null,
    data: JSON.stringify({
      id: object.id,
      model: object.model,
      // A message has the same fields as a delta.
      choices: choices.map((choice) =>
        isObject(choice)
          ? {
              index: choice.index,
              finish_reason: choice.finish_reason,
              delta: isObject(choice.message)
                ? {
                    ...choice.message,
                    tool_calls: Array.isArray(choice.message.tool_calls)
                      ? choice.message.tool_calls.map((call, index) =>
                          isObject(call) ? { index, ...call } : call,
                        )
                      : undefined,
                  }
                : {},
            }
          : choice,
      ),
      usage: object.usage,
    }),
    id: null,
  });
  return [...events, ...reader.complete(false)];
}

// ---------------------------------------------------------------------------
// Canonical → client stream

/** Chat has no "other" finish reason; such a finish reads as `stop`. */
function finishReason(reason: FinishReason | null): string {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function usageJson(usage: CanonicalUsage): JsonObject {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(usage.cachedInput !== null
      ? { prompt_tokens_details: { cached_tokens: usage.cachedInput } }
      : {}),
    ...(usage.reasoning !== null
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } }
      : {}),
  };
}

/** Writes canonical events as `chat.completion.chunk` SSE. */
class StreamWriter {
  done = false;
  private started = false;
  private readonly created = unixSeconds();
  private readonly tools = new Map<number, number>();
  private usage: CanonicalUsage = emptyUsage();

  constructor(
    private readonly meta: {
      model: string;
      responseId: string;
      includeUsage?: boolean;
    },
  ) {}

  write(event: CanonicalEvent): string[] {
    if (this.done) return [];
    const out = this.start();
    switch (event.type) {
      case "text-delta":
        out.push(this.chunk({ content: event.text }));
        break;
      case "reasoning-delta":
        // A common gateway extension; Chat has no field for the opaque part.
        out.push(this.chunk({ reasoning_content: event.text }));
        break;
      case "tool-call-start": {
        const index = this.tools.size;
        this.tools.set(event.index, index);
        out.push(
          this.chunk({
            tool_calls: [
              {
                index,
                id: event.id,
                type: "function",
                function: { name: event.name, arguments: "" },
              },
            ],
          }),
        );
        break;
      }
      case "tool-call-delta": {
        const index = this.tools.get(event.index);
        if (index !== undefined)
          out.push(
            this.chunk({
              tool_calls: [
                { index, function: { arguments: event.argumentsDelta } },
              ],
            }),
          );
        break;
      }
      case "usage":
        this.usage = mergeUsage(this.usage, event);
        break;
      case "finish":
        out.push(this.chunk({}, finishReason(event.reason)));
        if (this.meta.includeUsage)
          out.push(
            this.data({
              ...this.base(),
              choices: [],
              usage: usageJson(this.usage),
            }),
          );
        out.push(formatSse({ data: "[DONE]" }));
        this.done = true;
        break;
      case "error":
        out.push(this.failed(event.error));
        break;
      default:
        // Part boundaries and opaque reasoning have no Chat representation.
        break;
    }
    return out;
  }

  /** Reports a source that ended without a terminal event as failed. */
  end(): string[] {
    return this.done ? [] : [...this.start(), this.failed(interruptedError())];
  }

  private failed(error: ProxyErrorInfo): string {
    this.done = true;
    return this.data(openAiErrorBody(error));
  }

  private base(): JsonObject {
    return {
      id: this.meta.responseId,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.meta.model,
    };
  }

  private data(payload: JsonObject): string {
    return formatSse({ data: JSON.stringify(payload) });
  }

  private chunk(delta: JsonObject, finish: string | null = null): string {
    return this.data({
      ...this.base(),
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });
  }

  private start(): string[] {
    if (this.started) return [];
    this.started = true;
    return [this.chunk({ role: "assistant", content: "" })];
  }
}

/** Writes canonical events as a client-facing Chat Completions stream. */
export async function* writeStream(
  events: AsyncIterable<CanonicalEvent>,
  meta: { model: string; responseId: string; includeUsage?: boolean },
): AsyncGenerator<string> {
  const writer = new StreamWriter(meta);
  for await (const event of events) {
    yield* writer.write(event);
    if (writer.done) return;
  }
  yield* writer.end();
}

/** A complete `chat.completion` object, or the error body on failure. */
export function writeResponse(
  response: CanonicalResponse,
  meta: { model: string; responseId: string },
): Record<string, unknown> {
  if (response.error) return errorBody(response.error);
  let text = "";
  let reasoning = "";
  const calls: JsonObject[] = [];
  for (const part of response.output) {
    if (part.type === "text") text += part.text;
    else if (part.type === "reasoning") reasoning += part.text ?? "";
    else if (part.type === "tool-call")
      calls.push({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: part.arguments },
      });
  }
  return {
    id: meta.responseId,
    object: "chat.completion",
    created: unixSeconds(),
    model: meta.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason(response.finish),
      },
    ],
    usage: usageJson(response.usage),
  };
}

/** The OpenAI error JSON a Chat Completions client expects. */
export function errorBody(error: ProxyErrorInfo): Record<string, unknown> {
  return openAiErrorBody(error);
}
