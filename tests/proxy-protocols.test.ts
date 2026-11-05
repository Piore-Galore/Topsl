import { describe, expect, test } from "vitest";
import {
  UnsupportedConversion,
  collectResponse,
  type CanonicalEvent,
  type CanonicalReasoningPart,
  type CanonicalRequest,
  type CanonicalResponse,
  type ClientProtocol,
} from "../packages/proxy/canonical";
import { formatSse, parseSse, type SseFrame } from "../packages/proxy/sse";
import * as responses from "../packages/proxy/protocols/responses";
import * as messages from "../packages/proxy/protocols/messages";
import * as chat from "../packages/proxy/protocols/chat";
import { withoutForeignReasoning } from "../packages/proxy/protocols/shared";

/**
 * The local proxy's protocol converters (docs/Native_Harness_Plan.md §2).
 * Upstream streams below are synthetic, written by hand after the public
 * OpenAI Responses, Anthropic Messages and Chat Completions streaming
 * references; they are not recordings of live traffic.
 */

const converters = { responses, messages, chat } as const;

async function* source<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function all<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** Splits text into byte chunks of `size`, cutting through UTF-8 sequences. */
function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size)
    chunks.push(bytes.slice(start, start + size));
  return chunks;
}

/** Named SSE events, as Responses and Messages stream them. */
const namedSse = (...events: Record<string, unknown>[]) =>
  events
    .map((event) =>
      formatSse({ event: String(event.type), data: JSON.stringify(event) }),
    )
    .join("");

/** Unnamed SSE chunks, as Chat Completions streams them. */
const chatSse = (...chunks: (Record<string, unknown> | "[DONE]")[]) =>
  chunks
    .map((chunk) =>
      formatSse({
        data: chunk === "[DONE]" ? chunk : JSON.stringify(chunk),
      }),
    )
    .join("");

async function readText(
  protocol: ClientProtocol,
  text: string,
  chunkSize = 7,
): Promise<CanonicalEvent[]> {
  return all(
    converters[protocol].readStream(
      parseSse(source(byteChunks(text, chunkSize))),
    ),
  );
}

const rejection = (run: () => unknown): UnsupportedConversion => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedConversion);
    return error as UnsupportedConversion;
  }
  throw new Error("Expected an UnsupportedConversion.");
};

const weatherSchema = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
};

describe("SSE", () => {
  const stream =
    ": keep-alive comment\r\n" +
    "event: greeting\r\n" +
    'data: {"text":"héllo 你好 🙂"}\r\n' +
    "\r\n" +
    "id: 7\n" +
    "data: first line\n" +
    "data:second line\n" +
    "\n" +
    "data: final frame without a blank line";

  test("parses frames across every byte boundary", async () => {
    const expected: SseFrame[] = [
      { event: "greeting", data: '{"text":"héllo 你好 🙂"}', id: null },
      { event: null, data: "first line\nsecond line", id: "7" },
      { event: null, data: "final frame without a blank line", id: null },
    ];
    for (const size of [1, 2, 3, 5, 64])
      expect(await all(parseSse(source(byteChunks(stream, size))))).toEqual(
        expected,
      );
    // String chunks, with a CR at the end of one chunk and its LF in the next.
    const strings = ["event: a\r", "\ndata: x\r", "\n\r", "\n"];
    expect(await all(parseSse(source(strings)))).toEqual([
      { event: "a", data: "x", id: null },
    ]);
  });

  test("formats multi-line data as several data lines", async () => {
    const text = formatSse({ event: "note", data: "one\ntwo" });
    expect(text).toBe("event: note\ndata: one\ndata: two\n\n");
    expect(await all(parseSse(source([text])))).toEqual([
      { event: "note", data: "one\ntwo", id: null },
    ]);
  });
});

describe("parsing client requests", () => {
  test("Responses: a multi-turn request with tools, calls, results and an image", () => {
    const request = responses.parseRequest({
      model: "topsl-codex",
      instructions: "You are Topsl's coding agent.",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Prefer small diffs." }],
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What failed in this screenshot?" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,iVBORw0KGgo=",
              detail: "auto",
            },
          ],
        },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Need the test log." }],
          encrypted_content: "gAAAAABencrypted",
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_log",
          name: "read_file",
          arguments: '{"path":"test.log"}',
        },
        {
          type: "function_call",
          call_id: "call_diff",
          name: "git_diff",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_log",
          output: "1 failed",
        },
        { type: "function_call_output", call_id: "call_diff", output: "" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "One test failed." }],
        },
        { role: "user", content: "Fix it." },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
          strict: false,
        },
        { type: "function", name: "git_diff", parameters: null },
      ],
      tool_choice: "auto",
      reasoning: { effort: "high" },
      include: ["reasoning.encrypted_content"],
      parallel_tool_calls: true,
      store: false,
      stream: true,
      text: { format: { type: "text" } },
    });
    expect(request).toEqual({
      model: "topsl-codex",
      instructions: "You are Topsl's coding agent.\n\nPrefer small diffs.",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "What failed in this screenshot?" },
            {
              type: "image",
              mediaType: null,
              data: null,
              url: "data:image/png;base64,iVBORw0KGgo=",
            },
          ],
        },
        {
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Need the test log.",
              opaque: {
                protocol: "responses",
                value: {
                  type: "reasoning",
                  summary: [
                    { type: "summary_text", text: "Need the test log." },
                  ],
                  encrypted_content: "gAAAAABencrypted",
                },
              },
            },
            {
              type: "tool-call",
              id: "call_log",
              name: "read_file",
              arguments: '{"path":"test.log"}',
            },
            {
              type: "tool-call",
              id: "call_diff",
              name: "git_diff",
              arguments: "{}",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              type: "tool-result",
              callId: "call_log",
              output: "1 failed",
              isError: false,
            },
            {
              type: "tool-result",
              callId: "call_diff",
              output: "",
              isError: false,
            },
          ],
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "One test failed." }],
        },
        { role: "user", parts: [{ type: "text", text: "Fix it." }] },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        {
          name: "git_diff",
          description: "",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      toolChoice: "auto",
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      stop: [],
      reasoningEffort: "high",
      thinkingBudget: null,
      parallelToolCalls: true,
      stream: true,
      clientProtocol: "responses",
    } satisfies CanonicalRequest);
  });

  test("Messages: thinking, parallel tool use, results and an image", () => {
    const request = messages.parseRequest({
      model: "topsl-claude",
      max_tokens: 8192,
      system: [
        { type: "text", text: "You are Topsl's coding agent." },
        { type: "text", text: "Prefer small diffs." },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
            { type: "text", text: "What is the weather in Paris and Tokyo?" },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Two cities, two calls.",
              signature: "EqQBCkYIBxgCKkA",
            },
            { type: "redacted_thinking", data: "EmwKAhgB" },
            { type: "text", text: "Checking both." },
            {
              type: "tool_use",
              id: "toolu_paris",
              name: "get_weather",
              input: { city: "Paris" },
            },
            {
              type: "tool_use",
              id: "toolu_tokyo",
              name: "get_weather",
              input: { city: "Tokyo" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_paris",
              content: "18°C",
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_tokyo",
              content: [{ type: "text", text: "Service unavailable" }],
              is_error: true,
            },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Current weather.",
          input_schema: weatherSchema,
        },
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: false },
      thinking: { type: "enabled", budget_tokens: 2048 },
      stop_sequences: ["\n\nHuman:"],
      stream: true,
    });
    expect(request.instructions).toBe(
      "You are Topsl's coding agent.\n\nPrefer small diffs.",
    );
    expect(request.messages).toEqual([
      {
        role: "user",
        parts: [
          {
            type: "image",
            mediaType: "image/png",
            data: "iVBORw0KGgo=",
            url: null,
          },
          { type: "text", text: "What is the weather in Paris and Tokyo?" },
        ],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "Two cities, two calls.",
            opaque: {
              protocol: "messages",
              value: { signature: "EqQBCkYIBxgCKkA" },
            },
          },
          {
            type: "reasoning",
            text: null,
            opaque: { protocol: "messages", value: { redacted: "EmwKAhgB" } },
          },
          { type: "text", text: "Checking both." },
          {
            type: "tool-call",
            id: "toolu_paris",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
          {
            type: "tool-call",
            id: "toolu_tokyo",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            type: "tool-result",
            callId: "toolu_paris",
            output: "18°C",
            isError: false,
          },
          {
            type: "tool-result",
            callId: "toolu_tokyo",
            output: "Service unavailable",
            isError: true,
          },
        ],
      },
    ]);
    expect(request).toMatchObject({
      toolChoice: "required",
      parallelToolCalls: true,
      maxOutputTokens: 8192,
      thinkingBudget: 2048,
      reasoningEffort: null,
      stop: ["\n\nHuman:"],
      stream: true,
      clientProtocol: "messages",
    });
  });

  test("Chat: system prompt, image, assistant tool calls and tool messages", () => {
    const body = {
      model: "topsl-local",
      messages: [
        { role: "system", content: "You are Topsl's coding agent." },
        {
          role: "user",
          content: [
            { type: "text", text: "Weather in Paris and Tokyo?" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/map.png" },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_paris",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
            {
              id: "call_tokyo",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_paris", content: "18°C" },
        {
          role: "tool",
          tool_call_id: "call_tokyo",
          content: [{ type: "text", text: "22°C" }],
        },
        { role: "assistant", content: "Paris 18°C, Tokyo 22°C." },
        { role: "user", content: "Thanks." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Current weather.",
            parameters: weatherSchema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      max_completion_tokens: 1000,
      stop: "END",
      reasoning_effort: "low",
      parallel_tool_calls: true,
      n: 1,
      stream: true,
      stream_options: { include_usage: true },
    };
    const request = chat.parseRequest(body);
    expect(chat.includeUsage(body)).toBe(true);
    expect(request).toMatchObject({
      instructions: "You are Topsl's coding agent.",
      toolChoice: { name: "get_weather" },
      maxOutputTokens: 1000,
      stop: ["END"],
      reasoningEffort: "low",
      parallelToolCalls: true,
      clientProtocol: "chat",
    });
    expect(request.messages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", text: "Weather in Paris and Tokyo?" },
          {
            type: "image",
            mediaType: null,
            data: null,
            url: "https://example.com/map.png",
          },
        ],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "call_paris",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
          {
            type: "tool-call",
            id: "call_tokyo",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            type: "tool-result",
            callId: "call_paris",
            output: "18°C",
            isError: false,
          },
          {
            type: "tool-result",
            callId: "call_tokyo",
            output: "22°C",
            isError: false,
          },
        ],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Paris 18°C, Tokyo 22°C." }],
      },
      { role: "user", parts: [{ type: "text", text: "Thanks." }] },
    ]);
  });
});

/** A protocol-neutral conversation with an image, parallel calls and results. */
const conversation: CanonicalRequest = {
  model: "topsl-default",
  instructions: "You are Topsl's coding agent.",
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Weather in Paris and Tokyo?" },
        {
          type: "image",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
          url: null,
        },
      ],
    },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "Checking both." },
        {
          type: "tool-call",
          id: "call_paris",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
        {
          type: "tool-call",
          id: "call_tokyo",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          type: "tool-result",
          callId: "call_paris",
          output: "18°C",
          isError: false,
        },
        {
          type: "tool-result",
          callId: "call_tokyo",
          output: "Service unavailable",
          isError: true,
        },
      ],
    },
    { role: "user", parts: [{ type: "text", text: "Retry Tokyo." }] },
  ],
  tools: [
    {
      name: "get_weather",
      description: "Current weather.",
      inputSchema: weatherSchema,
    },
  ],
  toolChoice: "auto",
  maxOutputTokens: null,
  temperature: 0.2,
  topP: null,
  stop: [],
  reasoningEffort: null,
  thinkingBudget: null,
  parallelToolCalls: true,
  stream: true,
  clientProtocol: "chat",
};

/** Call IDs in the order an upstream body declares calls and quotes results. */
function callIds(protocol: ClientProtocol, body: Record<string, unknown>) {
  const calls: string[] = [];
  const results: string[] = [];
  const list = (value: unknown) => value as Record<string, unknown>[];
  if (protocol === "responses")
    for (const item of list(body.input)) {
      if (item.type === "function_call") calls.push(String(item.call_id));
      if (item.type === "function_call_output")
        results.push(String(item.call_id));
    }
  if (protocol === "messages")
    for (const message of list(body.messages))
      for (const block of list(message.content)) {
        if (block.type === "tool_use") calls.push(String(block.id));
        if (block.type === "tool_result")
          results.push(String(block.tool_use_id));
      }
  if (protocol === "chat")
    for (const message of list(body.messages)) {
      for (const call of list(message.tool_calls ?? []))
        calls.push(String(call.id));
      if (message.role === "tool") results.push(String(message.tool_call_id));
    }
  return { calls, results };
}

describe("serializing upstream requests", () => {
  test("Responses: stateless items with call IDs, results and an inline image", () => {
    const body = responses.serializeRequest(conversation, {
      model: "gpt-5.1-codex",
      profile: "openai-api",
    });
    expect(body).toEqual({
      model: "gpt-5.1-codex",
      instructions: "You are Topsl's coding agent.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Weather in Paris and Tokyo?" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,iVBORw0KGgo=",
              detail: "auto",
            },
          ],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Checking both." }],
        },
        {
          type: "function_call",
          call_id: "call_paris",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
        {
          type: "function_call",
          call_id: "call_tokyo",
          name: "get_weather",
          arguments: '{"city":"Tokyo"}',
        },
        { type: "function_call_output", call_id: "call_paris", output: "18°C" },
        {
          type: "function_call_output",
          call_id: "call_tokyo",
          output: "Service unavailable",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Retry Tokyo." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Current weather.",
          parameters: weatherSchema,
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      temperature: 0.2,
      store: false,
      stream: true,
    });
  });

  test("Responses: reasoning requests encrypted content and resends it", () => {
    const request = responses.parseRequest({
      model: "m",
      input: [
        { role: "user", content: "Hi" },
        {
          type: "reasoning",
          id: "rs_9",
          summary: [],
          encrypted_content: "gAAAA",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
        { role: "user", content: "Again" },
      ],
      reasoning: { effort: "medium" },
    });
    const body = responses.serializeRequest(request, {
      model: "gpt-5.1",
      profile: "chatgpt-plan",
    });
    expect(body).toMatchObject({
      reasoning: { effort: "medium" },
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
    });
    expect(body).not.toHaveProperty("previous_response_id");
    // The stored-item ID is not resent: with store false it would not resolve.
    expect((body.input as unknown[])[1]).toEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "gAAAA",
    });
  });

  test("Messages: alternating turns, tool_use input objects and a max_tokens default", () => {
    const body = messages.serializeRequest(conversation, {
      model: "claude-sonnet-4-5",
      profile: "anthropic-api",
      defaultMaxOutputTokens: 4096,
    });
    expect(body).toEqual({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      system: "You are Topsl's coding agent.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Weather in Paris and Tokyo?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo=",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking both." },
            {
              type: "tool_use",
              id: "call_paris",
              name: "get_weather",
              input: { city: "Paris" },
            },
            {
              type: "tool_use",
              id: "call_tokyo",
              name: "get_weather",
              input: { city: "Tokyo" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_paris", content: "18°C" },
            {
              type: "tool_result",
              tool_use_id: "call_tokyo",
              content: "Service unavailable",
              is_error: true,
            },
            { type: "text", text: "Retry Tokyo." },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Current weather.",
          input_schema: weatherSchema,
        },
      ],
      tool_choice: { type: "auto" },
      temperature: 0.2,
      stream: true,
    });
  });

  test("Chat: system first, assistant tool_calls, tool messages, usage requested", () => {
    const body = chat.serializeRequest(conversation, {
      model: "qwen3:32b",
      profile: "ollama",
    });
    expect(body).toEqual({
      model: "qwen3:32b",
      messages: [
        { role: "system", content: "You are Topsl's coding agent." },
        {
          role: "user",
          content: [
            { type: "text", text: "Weather in Paris and Tokyo?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
            },
          ],
        },
        {
          role: "assistant",
          content: "Checking both.",
          tool_calls: [
            {
              id: "call_paris",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
            {
              id: "call_tokyo",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_paris", content: "18°C" },
        {
          role: "tool",
          tool_call_id: "call_tokyo",
          content: "Service unavailable",
        },
        { role: "user", content: "Retry Tokyo." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Current weather.",
            parameters: weatherSchema,
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test("every client request reaches every upstream with call IDs and results intact", () => {
    const clientRequests: Record<ClientProtocol, CanonicalRequest> = {
      responses: responses.parseRequest({
        model: "m",
        input: [
          { role: "user", content: "Go" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
          {
            type: "function_call",
            call_id: "call_2",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
          { type: "function_call_output", call_id: "call_1", output: "18" },
          { type: "function_call_output", call_id: "call_2", output: "22" },
        ],
        tools: [
          { type: "function", name: "get_weather", parameters: weatherSchema },
        ],
      }),
      messages: messages.parseRequest({
        model: "m",
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Go" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "get_weather",
                input: { city: "Paris" },
              },
              {
                type: "tool_use",
                id: "call_2",
                name: "get_weather",
                input: { city: "Tokyo" },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "18" },
              { type: "tool_result", tool_use_id: "call_2", content: "22" },
            ],
          },
        ],
        tools: [{ name: "get_weather", input_schema: weatherSchema }],
      }),
      chat: chat.parseRequest({
        model: "m",
        messages: [
          { role: "user", content: "Go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
              },
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Tokyo"}',
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "18" },
          { role: "tool", tool_call_id: "call_2", content: "22" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", parameters: weatherSchema },
          },
        ],
      }),
    };
    const profiles = {
      responses: "openai-api",
      messages: "anthropic-api",
      chat: "openai-compatible",
    } as const;
    for (const request of Object.values(clientRequests))
      for (const upstream of ["responses", "messages", "chat"] as const) {
        const body = converters[upstream].serializeRequest(request, {
          model: "upstream-model",
          profile: profiles[upstream],
          defaultMaxOutputTokens: 4096,
        });
        expect(body.stream).toBe(true);
        expect(callIds(upstream, body)).toEqual({
          calls: ["call_1", "call_2"],
          results: ["call_1", "call_2"],
        });
      }
  });
});

describe("reading upstream streams", () => {
  const created = (id: string) => ({
    type: "response.created",
    sequence_number: 0,
    response: {
      id,
      object: "response",
      created_at: 1762300000,
      status: "in_progress",
      model: "gpt-5.1-codex",
      output: [],
      usage: null,
    },
  });
  const usage = {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 1024 },
    output_tokens: 80,
    output_tokens_details: { reasoning_tokens: 32 },
    total_tokens: 1280,
  };

  test("Responses: a text answer with usage", async () => {
    const message = {
      id: "msg_1",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello, wörld", annotations: [] }],
    };
    const events = await readText(
      "responses",
      namedSse(
        created("resp_1"),
        { ...created("resp_1"), type: "response.in_progress" },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "Hello, ",
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "wörld",
        },
        {
          type: "response.output_text.done",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          text: "Hello, wörld",
        },
        {
          type: "response.content_part.done",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          part: message.content[0],
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.completed",
          response: {
            ...created("resp_1").response,
            status: "completed",
            output: [message],
            usage,
          },
        },
      ),
      3,
    );
    expect(events).toEqual([
      { type: "response-start", responseId: "resp_1", model: "gpt-5.1-codex" },
      { type: "text-delta", index: 0, text: "Hello, " },
      { type: "text-delta", index: 0, text: "wörld" },
      { type: "part-end", index: 0 },
      {
        type: "usage",
        input: 1200,
        output: 80,
        cachedInput: 1024,
        reasoning: 32,
      },
      { type: "finish", reason: "stop", rawReason: null },
    ]);
  });

  test("Responses: reasoning with encrypted continuation, then parallel calls", async () => {
    const reasoning = {
      id: "rs_1",
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "Two cities." },
        { type: "summary_text", text: "Call both." },
      ],
      encrypted_content: "gAAAAABn-opaque",
    };
    const call = (index: number, id: string, args: string) => ({
      id: `fc_${index}`,
      type: "function_call",
      status: "completed",
      call_id: id,
      name: "get_weather",
      arguments: args,
    });
    const events = await readText(
      "responses",
      namedSse(
        created("resp_2"),
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "rs_1", type: "reasoning", summary: [] },
        },
        ...[0, 1].flatMap((summary_index) => [
          {
            type: "response.reasoning_summary_part.added",
            item_id: "rs_1",
            output_index: 0,
            summary_index,
            part: { type: "summary_text", text: "" },
          },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "rs_1",
            output_index: 0,
            summary_index,
            delta: reasoning.summary[summary_index].text,
          },
        ]),
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...call(1, "call_paris", ""), status: "in_progress" },
        },
        {
          type: "response.output_item.added",
          output_index: 2,
          item: { ...call(2, "call_tokyo", ""), status: "in_progress" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 1,
          delta: '{"city":',
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_2",
          output_index: 2,
          delta: '{"city":"Tokyo"}',
        },
        // The done event carries a tail the deltas never sent.
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          output_index: 1,
          arguments: '{"city":"Paris"}',
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          item: call(1, "call_paris", '{"city":"Paris"}'),
        },
        {
          type: "response.output_item.done",
          output_index: 2,
          item: call(2, "call_tokyo", '{"city":"Tokyo"}'),
        },
        {
          type: "response.completed",
          response: { id: "resp_2", status: "completed", usage },
        },
      ),
    );
    const response = collectResponse(events);
    expect(response.error).toBeNull();
    expect(response.finish).toBe("tool-calls");
    expect(response.output).toEqual([
      {
        type: "reasoning",
        text: "Two cities.\n\nCall both.",
        opaque: {
          protocol: "responses",
          value: {
            type: "reasoning",
            summary: reasoning.summary,
            encrypted_content: "gAAAAABn-opaque",
          },
        },
      },
      {
        type: "tool-call",
        id: "call_paris",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
      {
        type: "tool-call",
        id: "call_tokyo",
        name: "get_weather",
        arguments: '{"city":"Tokyo"}',
      },
    ]);
    expect(response.usage).toEqual({
      input: 1200,
      output: 80,
      cachedInput: 1024,
      reasoning: 32,
    });
  });

  test("Responses: incomplete, failed with a plan quota code, and error events", async () => {
    const incomplete = collectResponse(
      await readText(
        "responses",
        namedSse(created("resp_3"), {
          type: "response.incomplete",
          response: {
            id: "resp_3",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage,
          },
        }),
      ),
    );
    expect(incomplete).toMatchObject({
      finish: "length",
      rawFinishReason: "max_output_tokens",
      error: null,
    });

    const failed = collectResponse(
      await readText(
        "responses",
        namedSse(created("resp_4"), {
          type: "response.failed",
          response: {
            id: "resp_4",
            status: "failed",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "You've hit your usage limit.",
            },
          },
        }),
      ),
    );
    expect(failed.finish).toBeNull();
    expect(failed.error).toEqual({
      kind: "quota",
      status: null,
      code: "subscription_sharing_usage_limit_exceeded",
      param: null,
      message: "You've hit your usage limit.",
      retryable: false,
      requestId: null,
    });

    const error = collectResponse(
      await readText(
        "responses",
        namedSse(created("resp_5"), {
          type: "error",
          code: "subscription_sharing_unsupported_capability",
          message: "This model does not support that tool.",
          param: "tools[0]",
          sequence_number: 1,
        }),
      ),
    );
    expect(error.error).toMatchObject({
      kind: "unsupported",
      code: "subscription_sharing_unsupported_capability",
      param: "tools[0]",
      retryable: false,
    });

    const hosted = collectResponse(
      await readText(
        "responses",
        namedSse(created("resp_6"), {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "ws_1", type: "web_search_call", status: "in_progress" },
        }),
      ),
    );
    expect(hosted.error?.kind).toBe("unsupported");
  });

  test("Messages: thinking with a signature, text, and a tool call with usage", async () => {
    const events = await readText(
      "messages",
      namedSse(
        {
          type: "message_start",
          message: {
            id: "msg_01",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 25,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 2000,
              output_tokens: 1,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
        { type: "ping" },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Need the weather." },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "EqQBCkYIBxgCKkA" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Checking." },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "toolu_01",
            name: "get_weather",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "" },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"city": "Par' },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: 'is"}' },
        },
        { type: "content_block_stop", index: 2 },
        {
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "tool_use",
            id: "toolu_02",
            name: "list_cities",
            input: {},
          },
        },
        { type: "content_block_stop", index: 3 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 89 },
        },
        { type: "message_stop" },
      ),
      4,
    );
    const response = collectResponse(events);
    expect(response).toMatchObject({
      responseId: "msg_01",
      model: "claude-sonnet-4-5",
      finish: "tool-calls",
      rawFinishReason: "tool_use",
      error: null,
      // Canonical input counts cached input too, as OpenAI reports it.
      usage: { input: 2025, output: 89, cachedInput: 2000, reasoning: null },
    });
    expect(response.output).toEqual([
      {
        type: "reasoning",
        text: "Need the weather.",
        opaque: {
          protocol: "messages",
          value: { signature: "EqQBCkYIBxgCKkA" },
        },
      },
      { type: "text", text: "Checking." },
      {
        type: "tool-call",
        id: "toolu_01",
        name: "get_weather",
        arguments: '{"city": "Paris"}',
      },
      {
        type: "tool-call",
        id: "toolu_02",
        name: "list_cities",
        arguments: "{}",
      },
    ]);
  });

  test("Messages: an error event is classified and terminal", async () => {
    const events = await readText(
      "messages",
      namedSse(
        {
          type: "message_start",
          message: {
            id: "msg_02",
            model: "claude",
            usage: { input_tokens: 5 },
          },
        },
        {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded" },
        },
        { type: "message_stop" },
      ),
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      error: {
        kind: "unavailable",
        status: null,
        code: "overloaded_error",
        param: null,
        message: "Overloaded",
        retryable: true,
        requestId: null,
      },
    });
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });

  const chunk = (
    delta: Record<string, unknown>,
    finish_reason: string | null = null,
  ) => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1762300000,
    model: "qwen3:32b",
    choices: [{ index: 0, delta, logprobs: null, finish_reason }],
  });

  test("Chat: reasoning, text, a usage chunk and [DONE]", async () => {
    const events = await readText(
      "chat",
      chatSse(
        chunk({ role: "assistant", content: "" }),
        chunk({ reasoning_content: "Simple greeting." }),
        chunk({ content: "Hi" }),
        chunk({ content: " there" }),
        chunk({}, "stop"),
        {
          ...chunk({}),
          choices: [],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 12,
            total_tokens: 52,
            prompt_tokens_details: { cached_tokens: 32 },
            completion_tokens_details: { reasoning_tokens: 4 },
          },
        },
        "[DONE]",
      ),
    );
    expect(events).toEqual([
      { type: "response-start", responseId: "chatcmpl-1", model: "qwen3:32b" },
      { type: "reasoning-delta", index: 0, text: "Simple greeting." },
      { type: "part-end", index: 0 },
      { type: "text-delta", index: 1, text: "Hi" },
      { type: "text-delta", index: 1, text: " there" },
      { type: "part-end", index: 1 },
      { type: "usage", input: 40, output: 12, cachedInput: 32, reasoning: 4 },
      { type: "finish", reason: "stop", rawReason: "stop" },
    ]);
  });

  test("Chat: parallel tool calls streamed by index keep their IDs", async () => {
    const events = await readText(
      "chat",
      chatSse(
        chunk({ role: "assistant", content: null }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_paris",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
        }),
        chunk({
          tool_calls: [
            {
              index: 1,
              id: "call_tokyo",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
            },
          ],
        }),
        // A late delta for the first call, interleaved after the second.
        chunk({
          tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
        }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ),
    );
    const response = collectResponse(events);
    expect(response.finish).toBe("tool-calls");
    expect(response.output).toEqual([
      {
        type: "tool-call",
        id: "call_paris",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
      {
        type: "tool-call",
        id: "call_tokyo",
        name: "get_weather",
        arguments: '{"city":"Tokyo"}',
      },
    ]);
  });

  test("Chat: a truncated stream is never reported complete", async () => {
    const events = await readText(
      "chat",
      chatSse(
        chunk({ role: "assistant", content: "" }),
        chunk({ content: "Partial ans" }),
      ),
    );
    expect(
      events.some((event) => event.type === "finish" || event.type === "error"),
    ).toBe(false);
    const response = collectResponse(events);
    expect(response.finish).toBeNull();
    expect(response.error?.kind).toBe("interrupted");
    expect(response.output).toEqual([{ type: "text", text: "Partial ans" }]);
  });

  test("Chat: a finish reason without [DONE], and [DONE] without a finish reason", async () => {
    const unterminated = collectResponse(
      await readText(
        "chat",
        chatSse(chunk({ content: "Done." }), chunk({}, "stop")),
      ),
    );
    expect(unterminated).toMatchObject({ finish: "stop", error: null });
    const bare = collectResponse(
      await readText("chat", chatSse(chunk({ content: "Done." }), "[DONE]")),
    );
    expect(bare).toMatchObject({ finish: "stop", rawFinishReason: null });
  });

  test("Responses: a final text that contradicts the deltas fails the stream", async () => {
    const events = await readText(
      "responses",
      namedSse(
        created("resp_7"),
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "Hello",
        },
        {
          type: "response.output_text.done",
          output_index: 0,
          content_index: 0,
          text: "Goodbye",
        },
        { type: "response.completed", response: { id: "resp_7" } },
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "upstream" },
    });
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });

  test("Chat: an error chunk is terminal", async () => {
    const events = await readText(
      "chat",
      chatSse(
        chunk({ content: "x" }),
        {
          error: {
            message: "Rate limit reached",
            type: "requests",
            code: "rate_limit_exceeded",
            param: null,
          },
        },
        "[DONE]",
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        kind: "unavailable",
        code: "rate_limit_exceeded",
        retryable: true,
      },
    });
  });
});

/** An assistant turn with reasoning, text, two calls and usage. */
function answer(opaque: unknown): CanonicalEvent[] {
  return [
    { type: "response-start", responseId: "upstream_1", model: "upstream" },
    { type: "reasoning-delta", index: 0, text: "Two cities; " },
    { type: "reasoning-delta", index: 0, text: "call both." },
    ...(opaque !== null
      ? [{ type: "reasoning-opaque", index: 0, value: opaque } as const]
      : []),
    { type: "part-end", index: 0 },
    { type: "text-delta", index: 1, text: "Checking " },
    { type: "text-delta", index: 1, text: "both." },
    { type: "part-end", index: 1 },
    { type: "tool-call-start", index: 2, id: "call_a", name: "get_weather" },
    { type: "tool-call-delta", index: 2, argumentsDelta: '{"city":' },
    { type: "tool-call-delta", index: 2, argumentsDelta: '"Paris"}' },
    { type: "part-end", index: 2 },
    { type: "tool-call-start", index: 3, id: "call_b", name: "get_weather" },
    { type: "tool-call-delta", index: 3, argumentsDelta: '{"city":"Tokyo"}' },
    { type: "part-end", index: 3 },
    { type: "usage", input: 200, output: 50, cachedInput: 150, reasoning: 20 },
    { type: "finish", reason: "tool-calls", rawReason: null },
  ];
}

const ownOpaque: Record<ClientProtocol, unknown> = {
  responses: {
    protocol: "responses",
    value: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Two cities; call both." }],
      encrypted_content: "gAAAAABn-opaque",
    },
  },
  messages: { protocol: "messages", value: { signature: "EqQBCkYIBxgCKkA" } },
  chat: null,
};

const meta = { model: "topsl-alias", responseId: "resp_topsl_1" };

async function roundTrip(
  protocol: ClientProtocol,
  events: CanonicalEvent[],
  includeUsage = true,
): Promise<CanonicalResponse> {
  const text = (
    await all(
      converters[protocol].writeStream(source(events), {
        ...meta,
        includeUsage,
      }),
    )
  ).join("");
  return collectResponse(await readText(protocol, text, 5));
}

describe("round trips through each client protocol", () => {
  test.each(["responses", "messages", "chat"] as const)(
    "%s: written stream reads back to the same response",
    async (protocol) => {
      const events = answer(ownOpaque[protocol]);
      const original = collectResponse(events);
      const reread = await roundTrip(protocol, events);
      expect(reread.responseId).toBe(meta.responseId);
      expect(reread.model).toBe(meta.model);
      expect(reread.error).toBeNull();
      expect(reread.finish).toBe("tool-calls");
      expect(reread.output).toEqual(original.output);
      expect(reread.usage).toEqual({
        ...original.usage,
        // Messages reports no reasoning-token count.
        reasoning: protocol === "messages" ? null : original.usage.reasoning,
      });
    },
  );

  test.each(["responses", "messages", "chat"] as const)(
    "%s: written response object reads back to the same response",
    (protocol) => {
      const original = collectResponse(answer(ownOpaque[protocol]));
      const body = converters[protocol].writeResponse(original, meta);
      const reread = collectResponse(converters[protocol].readResponse(body));
      expect(reread.output).toEqual(original.output);
      expect(reread.finish).toBe("tool-calls");
      expect(reread.usage.input).toBe(200);
      expect(reread.usage.cachedInput).toBe(150);
    },
  );

  test("Messages carries redacted thinking through a round trip", async () => {
    const redacted: CanonicalEvent[] = [
      { type: "response-start", responseId: null, model: null },
      {
        type: "reasoning-opaque",
        index: 0,
        value: { protocol: "messages", value: { redacted: "EmwKAhgB" } },
      },
      { type: "part-end", index: 0 },
      { type: "text-delta", index: 1, text: "Hi" },
      { type: "finish", reason: "stop", rawReason: "end_turn" },
    ];
    const reread = await roundTrip("messages", redacted);
    expect(reread.output).toEqual(collectResponse(redacted).output);
    expect(reread.rawFinishReason).toBe("end_turn");
  });

  test("Chat drops opaque reasoning it cannot carry but keeps the text", async () => {
    const reread = await roundTrip("chat", answer(ownOpaque.messages));
    expect(reread.output[0]).toEqual({
      type: "reasoning",
      text: "Two cities; call both.",
      opaque: null,
    });
  });

  test("errors and incomplete finishes survive a round trip", async () => {
    const quota: CanonicalEvent = {
      type: "error",
      error: {
        kind: "quota",
        status: 429,
        code: "subscription_sharing_usage_limit_exceeded",
        param: null,
        message: "Usage limit reached.",
        retryable: false,
        requestId: "req_1",
      },
    };
    const start: CanonicalEvent = {
      type: "response-start",
      responseId: null,
      model: null,
    };
    const failed = await roundTrip("responses", [start, quota]);
    expect(failed.error).toMatchObject({
      kind: "quota",
      code: "subscription_sharing_usage_limit_exceeded",
      retryable: false,
    });
    expect((await roundTrip("chat", [start, quota])).error?.kind).toBe("quota");
    // Messages has no quota code of its own; billing_error keeps the class.
    expect((await roundTrip("messages", [start, quota])).error).toMatchObject({
      kind: "quota",
      code: "billing_error",
    });

    const length: CanonicalEvent[] = [
      start,
      { type: "text-delta", index: 0, text: "Cut" },
      { type: "finish", reason: "length", rawReason: "max_output_tokens" },
    ];
    for (const protocol of ["responses", "messages", "chat"] as const)
      expect((await roundTrip(protocol, length)).finish).toBe("length");
  });

  test("a source that ends without a terminal event is written as a failure", async () => {
    const partial: CanonicalEvent[] = [
      { type: "response-start", responseId: null, model: null },
      { type: "text-delta", index: 0, text: "Partial" },
    ];
    for (const protocol of ["responses", "messages", "chat"] as const) {
      const reread = await roundTrip(protocol, partial);
      expect(reread.finish).toBeNull();
      expect(reread.error).not.toBeNull();
      expect(reread.error?.retryable).toBe(true);
    }
  });

  test("interleaved upstream parts are written one block at a time", async () => {
    const interleaved: CanonicalEvent[] = [
      { type: "response-start", responseId: null, model: null },
      { type: "tool-call-start", index: 0, id: "call_a", name: "a" },
      { type: "tool-call-start", index: 1, id: "call_b", name: "b" },
      { type: "tool-call-delta", index: 1, argumentsDelta: '{"x":2}' },
      { type: "tool-call-delta", index: 0, argumentsDelta: '{"x":1}' },
      { type: "finish", reason: "tool-calls", rawReason: null },
    ];
    for (const protocol of ["responses", "messages"] as const) {
      const reread = await roundTrip(protocol, interleaved);
      expect(reread.output).toEqual([
        { type: "tool-call", id: "call_a", name: "a", arguments: '{"x":1}' },
        { type: "tool-call", id: "call_b", name: "b", arguments: '{"x":2}' },
      ]);
    }
  });

  test("Responses stream events carry sequence numbers and the full response", async () => {
    const text = (
      await all(
        responses.writeStream(source(answer(ownOpaque.responses)), meta),
      )
    ).join("");
    const frames = await all(parseSse(source([text])));
    const payloads = frames.map((frame) => JSON.parse(frame.data));
    expect(payloads.map((payload) => payload.sequence_number)).toEqual(
      payloads.map((_, index) => index),
    );
    expect(frames.map((frame) => frame.event)).toContain(
      "response.content_part.added",
    );
    const completed = payloads.at(-1);
    expect(completed.type).toBe("response.completed");
    expect(completed.response.usage).toEqual({
      input_tokens: 200,
      input_tokens_details: { cached_tokens: 150 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 250,
    });
    expect(
      completed.response.output.map((item: { type: string }) => item.type),
    ).toEqual(["reasoning", "message", "function_call", "function_call"]);
    expect(completed.response.output[0].encrypted_content).toBe(
      "gAAAAABn-opaque",
    );
  });

  test("Chat stream ends with a finish chunk, a usage chunk and [DONE]", async () => {
    const text = (
      await all(
        chat.writeStream(source(answer(null)), { ...meta, includeUsage: true }),
      )
    ).join("");
    const frames = await all(parseSse(source([text])));
    expect(frames.at(-1)?.data).toBe("[DONE]");
    const usageChunk = JSON.parse(frames.at(-2)!.data);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage.prompt_tokens).toBe(200);
    const finishChunk = JSON.parse(frames.at(-3)!.data);
    expect(finishChunk.choices[0].finish_reason).toBe("tool_calls");
    expect(JSON.parse(frames[0].data).choices[0].delta.role).toBe("assistant");
  });
});

describe("reasoning continuation across client protocols", () => {
  test("Messages thinking shown to a Responses client comes back as Messages reasoning", () => {
    const upstream = collectResponse(answer(ownOpaque.messages));
    const shown = responses.writeResponse(upstream, meta);
    const output = shown.output as Record<string, unknown>[];
    expect(output[0].encrypted_content).toMatch(/^topsl-reasoning\.v1\./);
    const next = responses.parseRequest({
      model: "topsl-claude",
      input: [
        { role: "user", content: "Weather?" },
        ...output,
        { type: "function_call_output", call_id: "call_a", output: "18" },
        { type: "function_call_output", call_id: "call_b", output: "22" },
      ],
    });
    expect(next.messages[1].parts[0]).toEqual({
      type: "reasoning",
      text: "Two cities; call both.",
      opaque: { protocol: "messages", value: { signature: "EqQBCkYIBxgCKkA" } },
    });
    const body = messages.serializeRequest(next, {
      model: "claude-sonnet-4-5",
      profile: "anthropic-api",
      defaultMaxOutputTokens: 1024,
    });
    const turns = body.messages as { content: Record<string, unknown>[] }[];
    expect(turns[1].content[0]).toEqual({
      type: "thinking",
      thinking: "Two cities; call both.",
      signature: "EqQBCkYIBxgCKkA",
    });
    // The same history cannot go to a Responses upstream.
    expect(
      rejection(() =>
        responses.serializeRequest(next, { model: "m", profile: "openai-api" }),
      ).message,
    ).toMatch(/messages continuation/);
  });

  test("Responses reasoning shown to a Messages client comes back as Responses reasoning", async () => {
    const text = (
      await all(messages.writeStream(source(answer(ownOpaque.responses)), meta))
    ).join("");
    const shown = collectResponse(await readText("messages", text));
    const thinking = shown.output[0];
    expect(thinking.type).toBe("reasoning");
    const reply = messages.writeResponse(shown, meta);
    const next = messages.parseRequest({
      model: "topsl-codex",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: reply.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_a", content: "18" },
            { type: "tool_result", tool_use_id: "call_b", content: "22" },
          ],
        },
      ],
    });
    expect(next.messages[1].parts[0]).toEqual({
      type: "reasoning",
      text: "Two cities; call both.",
      opaque: ownOpaque.responses,
    });
    const body = responses.serializeRequest(next, {
      model: "gpt-5.1",
      profile: "openai-api",
    });
    expect((body.input as unknown[])[1]).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Two cities; call both." }],
      encrypted_content: "gAAAAABn-opaque",
    });
  });

  test("reasoning without continuation shown to a Messages client is not mistaken for signed thinking", async () => {
    const text = (
      await all(messages.writeStream(source(answer(null)), meta))
    ).join("");
    const reply = messages.writeResponse(
      collectResponse(await readText("messages", text)),
      meta,
    );
    const next = messages.parseRequest({
      model: "m",
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: reply.content },
      ],
    });
    expect(next.messages[1].parts[0]).toEqual({
      type: "reasoning",
      text: "Two cities; call both.",
      opaque: null,
    });
  });
});

describe("rejections", () => {
  test("hosted and server tools", () => {
    for (const type of ["web_search", "file_search", "mcp", "code_interpreter"])
      expect(
        rejection(() =>
          responses.parseRequest({
            model: "m",
            input: "hi",
            tools: [{ type }],
          }),
        ).param,
      ).toBe("tools[0].type");
    expect(
      rejection(() =>
        messages.parseRequest({
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      ).param,
    ).toBe("tools[0].type");
    expect(
      rejection(() =>
        chat.parseRequest({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "custom", custom: { name: "x" } }],
        }),
      ).param,
    ).toBe("tools[0].type");
  });

  test("server-side state, storage and unknown fields", () => {
    const base = { model: "m", input: "hi" };
    for (const [field, value] of [
      ["previous_response_id", "resp_1"],
      ["conversation", "conv_1"],
      ["background", true],
      ["store", true],
      ["metadata", { a: "b" }],
      ["truncation", "auto"],
      ["prompt_cache_key", "k"],
    ] as const)
      expect(
        rejection(() => responses.parseRequest({ ...base, [field]: value }))
          .param,
      ).toBe(field);
    // `null` means unset, so it is accepted.
    expect(() =>
      responses.parseRequest({ ...base, previous_response_id: null }),
    ).not.toThrow();
    expect(
      rejection(() =>
        responses.parseRequest({ ...base, reasoning: { summary: "auto" } }),
      ).param,
    ).toBe("reasoning.summary");
    expect(
      rejection(() =>
        responses.parseRequest({
          model: "m",
          input: [
            {
              role: "user",
              content: [{ type: "input_image", file_id: "file_1" }],
            },
          ],
        }),
      ).param,
    ).toBe("input[0].content[0].file_id");
    expect(
      rejection(() =>
        messages.parseRequest({
          model: "m",
          messages: [],
          metadata: { user_id: "u" },
        }),
      ).param,
    ).toBe("metadata");
    expect(
      rejection(() =>
        messages.parseRequest({
          model: "m",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "hi",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        }),
      ).param,
    ).toBe("messages[0].content[0].cache_control");
  });

  test("Chat: more than one choice and legacy function calling", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(rejection(() => chat.parseRequest({ ...base, n: 2 })).param).toBe(
      "n",
    );
    expect(
      rejection(() => chat.parseRequest({ ...base, functions: [] })).param,
    ).toBe("functions");
    expect(
      rejection(() =>
        chat.parseRequest({
          ...base,
          response_format: { type: "json_object" },
        }),
      ).param,
    ).toBe("response_format.type");
  });

  test("a system message after the conversation has started", () => {
    expect(
      rejection(() =>
        responses.parseRequest({
          model: "m",
          input: [
            { role: "user", content: "hi" },
            { role: "system", content: "Be brief." },
          ],
        }),
      ).param,
    ).toBe("input[1].role");
    expect(
      rejection(() =>
        chat.parseRequest({
          model: "m",
          messages: [
            { role: "user", content: "hi" },
            { role: "developer", content: "Be brief." },
          ],
        }),
      ).param,
    ).toBe("messages[1].role");
  });

  test("reasoning from another protocol, or with no continuation", () => {
    const withReasoning = (opaque: unknown): CanonicalRequest => ({
      ...conversation,
      messages: [
        conversation.messages[0],
        {
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "x",
              opaque: opaque as CanonicalReasoningPart["opaque"],
            },
            { type: "text", text: "y" },
          ],
        },
      ],
    });
    const options = { model: "m", defaultMaxOutputTokens: 100 } as const;
    expect(() =>
      responses.serializeRequest(withReasoning(ownOpaque.messages), {
        ...options,
        profile: "openai-api",
      }),
    ).toThrow(UnsupportedConversion);
    expect(() =>
      messages.serializeRequest(withReasoning(ownOpaque.responses), {
        ...options,
        profile: "anthropic-api",
      }),
    ).toThrow(UnsupportedConversion);
    expect(() =>
      messages.serializeRequest(withReasoning(null), {
        ...options,
        profile: "anthropic-api",
      }),
    ).toThrow(UnsupportedConversion);
    expect(() =>
      chat.serializeRequest(withReasoning(ownOpaque.messages), {
        ...options,
        profile: "ollama",
      }),
    ).toThrow(UnsupportedConversion);
    // Each serializer accepts its own protocol's continuation.
    expect(() =>
      messages.serializeRequest(withReasoning(ownOpaque.messages), {
        ...options,
        profile: "anthropic-api",
      }),
    ).not.toThrow();
  });

  test("ChatGPT-plan route refuses fields the route does not accept", () => {
    const plan = { model: "gpt-5.1", profile: "chatgpt-plan" } as const;
    expect(
      rejection(() => responses.serializeRequest(conversation, plan)).param,
    ).toBe("temperature");
    const capped = responses.parseRequest({
      model: "m",
      input: "hi",
      max_output_tokens: 500,
    });
    expect(
      rejection(() => responses.serializeRequest(capped, plan)).param,
    ).toBe("max_output_tokens");
    // The same request is fine on an API-key route.
    expect(
      responses.serializeRequest(capped, { model: "m", profile: "openai-api" })
        .max_output_tokens,
    ).toBe(500);
    const plain = responses.serializeRequest(
      { ...conversation, temperature: null },
      plan,
    );
    for (const field of [
      "previous_response_id",
      "background",
      "conversation",
      "max_tool_calls",
      "metadata",
      "prompt",
      "prompt_cache_retention",
      "safety_identifier",
      "top_logprobs",
      "truncation",
      "user",
    ])
      expect(plain).not.toHaveProperty(field);
    expect(plain).toMatchObject({ store: false, stream: true });
  });

  test("Messages needs a token limit and has no reasoning effort", () => {
    const options = { model: "claude", profile: "anthropic-api" } as const;
    expect(
      rejection(() => messages.serializeRequest(conversation, options)).param,
    ).toBe("max_tokens");
    expect(
      messages.serializeRequest(
        { ...conversation, maxOutputTokens: 300 },
        options,
      ).max_tokens,
    ).toBe(300);
    const effort = responses.parseRequest({
      model: "m",
      input: "hi",
      reasoning: { effort: "high" },
    });
    expect(
      rejection(() =>
        messages.serializeRequest(effort, {
          ...options,
          defaultMaxOutputTokens: 100,
        }),
      ).param,
    ).toBe("reasoning.effort");
    const budget = messages.parseRequest({
      model: "m",
      max_tokens: 4000,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 2000 },
    });
    expect(messages.serializeRequest(budget, options).thinking).toEqual({
      type: "enabled",
      budget_tokens: 2000,
    });
    expect(
      rejection(() =>
        responses.serializeRequest(budget, {
          model: "m",
          profile: "openai-api",
        }),
      ).param,
    ).toBe("thinking.budget_tokens");
  });

  test("Messages refuses tool-call arguments that are not a JSON object", () => {
    const broken: CanonicalRequest = {
      ...conversation,
      maxOutputTokens: 100,
      messages: [
        conversation.messages[0],
        {
          role: "assistant",
          parts: [
            { type: "tool-call", id: "c", name: "get_weather", arguments: "{" },
          ],
        },
      ],
    };
    expect(() =>
      messages.serializeRequest(broken, {
        model: "m",
        profile: "anthropic-api",
      }),
    ).toThrow(/not valid JSON/);
  });
});

describe("withoutForeignReasoning", () => {
  test("keeps only the target protocol's reasoning and drops emptied messages", () => {
    const history: CanonicalRequest["messages"] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "reasoning",
            text: "a",
            opaque: { protocol: "messages", value: { signature: "s" } },
          },
          { type: "reasoning", text: "b", opaque: null },
          {
            type: "reasoning",
            text: "c",
            opaque: { protocol: "responses", value: {} },
          },
          { type: "text", text: "hello" },
        ],
      },
      {
        role: "assistant",
        parts: [{ type: "reasoning", text: "only", opaque: null }],
      },
    ];
    expect(withoutForeignReasoning(history, "messages")).toEqual([
      history[0],
      {
        role: "assistant",
        parts: [history[1].parts[0], { type: "text", text: "hello" }],
      },
    ]);
    expect(withoutForeignReasoning(history, "chat")).toEqual([
      history[0],
      { role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ]);
    // The input is not modified.
    expect(history[1].parts).toHaveLength(4);
  });
});

describe("error bodies", () => {
  const error = {
    kind: "permission",
    status: 403,
    code: "subscription_sharing_route_not_supported",
    param: null,
    message: "Not available on this route.",
    retryable: false,
    requestId: "req_9",
  } as const;
  test("each protocol's error JSON keeps the upstream code", () => {
    expect(responses.errorBody(error)).toEqual({
      error: {
        message: "Not available on this route.",
        type: "permission_error",
        param: null,
        code: "subscription_sharing_route_not_supported",
      },
    });
    expect(chat.errorBody(error)).toEqual(responses.errorBody(error));
    expect(messages.errorBody(error)).toEqual({
      type: "error",
      error: {
        type: "permission_error",
        message: "Not available on this route.",
      },
      request_id: "req_9",
    });
  });
});

describe("structured output (a JSON Schema for the final text)", () => {
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 200 },
      count: { type: "integer", minimum: 0 },
      items: { type: "array", items: { type: "string" }, maxItems: 4 },
    },
    required: ["summary", "count", "items"],
    additionalProperties: false,
  };
  const closed = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  };
  // The shared conversation without sampling settings the plan route refuses.
  const simple = (outputFormat: CanonicalRequest["outputFormat"]) => ({
    ...conversation,
    temperature: null,
    outputFormat,
  });

  test("each client protocol's schema field parses to one canonical format", () => {
    expect(
      responses.parseRequest({
        model: "m",
        input: "hi",
        text: {
          format: { type: "json_schema", name: "plan", schema, strict: true },
        },
      }).outputFormat,
    ).toEqual({ name: "plan", schema, strict: true });
    expect(
      chat.parseRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "plan", schema },
        },
      }).outputFormat,
    ).toEqual({ name: "plan", schema, strict: false });
    expect(
      messages.parseRequest({
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        output_config: { format: { type: "json_schema", schema: closed } },
      }).outputFormat,
    ).toEqual({ name: "output", schema: closed, strict: true });
    // Plain text needs no format, and none is added.
    expect(
      responses.parseRequest({
        model: "m",
        input: "hi",
        text: { format: { type: "text" } },
      }),
    ).not.toHaveProperty("outputFormat");
  });

  test("each upstream protocol carries it in its own field", () => {
    const format = { name: "plan", schema, strict: true };
    expect(
      responses.serializeRequest(simple(format), {
        model: "gpt",
        profile: "openai-api",
      }).text,
    ).toEqual({ format: { type: "json_schema", ...format } });
    // Not among the plan route's documented refusals (5 November 2026).
    expect(
      responses.serializeRequest(
        simple(format),
        { model: "gpt", profile: "chatgpt-plan" },
      ).text,
    ).toEqual({ format: { type: "json_schema", ...format } });
    expect(
      chat.serializeRequest(simple(format), {
        model: "local",
        profile: "ollama",
      }).response_format,
    ).toEqual({ type: "json_schema", json_schema: format });
    expect(
      messages.serializeRequest(
        simple({ name: "plan", schema: closed, strict: false }),
        { model: "claude", profile: "anthropic-api", defaultMaxOutputTokens: 8 },
      ).output_config,
    ).toEqual({ format: { type: "json_schema", schema: closed } });
    // Without a format nothing is added.
    expect(
      responses.serializeRequest(conversation, {
        model: "gpt",
        profile: "openai-api",
      }),
    ).not.toHaveProperty("text");
  });

  test("Messages refuses a schema it would have to weaken; the relaxed copy is the caller's choice", async () => {
    const { relaxSchemaForMessages, strictCompatible } = await import(
      "../packages/proxy/protocols/shared"
    );
    const refused = rejection(() =>
      messages.serializeRequest(simple({ name: "plan", schema, strict: true }), {
        model: "claude",
        profile: "anthropic-api",
        defaultMaxOutputTokens: 8,
      }),
    );
    expect(refused.message).toContain("minLength");
    // Named as the client (a Chat Completions client here) sent it.
    expect(refused.param).toBe("response_format");
    const open = { type: "object", properties: { a: { type: "string" } } };
    expect(
      rejection(() =>
        messages.serializeRequest(
          simple({ name: "plan", schema: open, strict: false }),
          { model: "claude", profile: "anthropic-api", defaultMaxOutputTokens: 8 },
        ),
      ).message,
    ).toContain("additionalProperties: false");
    const relaxed = relaxSchemaForMessages(schema) as Record<string, any>;
    expect(relaxed.properties.summary).toEqual({ type: "string" });
    expect(relaxed.properties.count).toEqual({ type: "integer" });
    expect(relaxed.properties.items).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(
      messages.serializeRequest(
        simple({ name: "plan", schema: relaxed, strict: true }),
        { model: "claude", profile: "anthropic-api", defaultMaxOutputTokens: 8 },
      ).output_config,
    ).toEqual({ format: { type: "json_schema", schema: relaxed } });
    // OpenAI strict mode needs every object closed and every field required.
    expect(strictCompatible(schema)).toBe(true);
    expect(strictCompatible(open)).toBe(false);
    expect(
      strictCompatible({ ...closed, properties: { a: {}, b: {} }, required: ["a"] }),
    ).toBe(false);
  });

  test("JSON mode without a schema, descriptions and other format types are refused", () => {
    expect(
      rejection(() =>
        responses.parseRequest({
          model: "m",
          input: "hi",
          text: { format: { type: "json_object" } },
        }),
      ).param,
    ).toBe("text.format.type");
    expect(
      rejection(() =>
        chat.parseRequest({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          response_format: { type: "json_object" },
        }),
      ).param,
    ).toBe("response_format.type");
    expect(
      rejection(() =>
        responses.parseRequest({
          model: "m",
          input: "hi",
          text: {
            format: {
              type: "json_schema",
              name: "plan",
              schema: closed,
              description: "A plan.",
            },
          },
        }),
      ).param,
    ).toBe("text.format.description");
    expect(
      rejection(() =>
        responses.parseRequest({
          model: "m",
          input: "hi",
          text: { format: { type: "json_schema", name: "bad name", schema: closed } },
        }),
      ).param,
    ).toBe("text.format.name");
    expect(
      rejection(() =>
        messages.parseRequest({
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
          output_config: { effort: "high" },
        }),
      ).param,
    ).toBe("output_config.effort");
  });

  test("a format survives every client → upstream conversion", () => {
    const format = { name: "output", schema: closed, strict: true };
    const clients = {
      responses: {
        model: "m",
        input: "hi",
        text: { format: { type: "json_schema", ...format } },
      },
      chat: {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_schema", json_schema: format },
      },
      messages: {
        model: "m",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        output_config: { format: { type: "json_schema", schema: closed } },
      },
    } as const;
    for (const [client, body] of Object.entries(clients)) {
      const request = converters[client as ClientProtocol].parseRequest(body);
      expect(request.outputFormat).toEqual(format);
      for (const upstream of ["responses", "chat", "messages"] as const) {
        const profile =
          upstream === "messages"
            ? "anthropic-api"
            : upstream === "chat"
              ? "openai-compatible"
              : "openai-api";
        const sent = converters[upstream].serializeRequest(request, {
          model: "u",
          profile,
          defaultMaxOutputTokens: 8,
        });
        const back = converters[upstream].parseRequest({
          ...sent,
          stream: false,
        });
        expect(back.outputFormat?.schema).toEqual(closed);
      }
    }
  });
});
