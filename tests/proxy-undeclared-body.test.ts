import { expect, test } from "vitest";
import { dispatchUpstream } from "../packages/proxy/adapters";
import type { CanonicalEvent, CanonicalRequest } from "../packages/proxy/canonical";

/**
 * OpenAI's ChatGPT-plan route answered Topsl's streaming requests with 200
 * and no Content-Type (observed live, 6 November 2026). Reading that body as
 * one JSON document lost every event, and each request failed as "ended
 * before a terminal event". An undeclared body is now read by its content.
 */
const request: CanonicalRequest = {
  model: "chatgpt/live",
  instructions: null,
  messages: [{ role: "user", parts: [{ type: "text", text: "Reply OK." }] }],
  tools: [],
  toolChoice: "auto",
  maxOutputTokens: null,
  temperature: null,
  topP: null,
  stop: [],
  reasoningEffort: null,
  thinkingBudget: null,
  parallelToolCalls: null,
  stream: true,
  clientProtocol: "responses",
};

/** A Response whose body is a stream, so the runtime sets no Content-Type. */
const undeclared = (text: string, headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        // Split mid-event, as a network would.
        const bytes = new TextEncoder().encode(text);
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    }),
    { status: 200, headers },
  );

async function events(response: Response) {
  const result = await dispatchUpstream(
    {
      connection: { kind: "chatgpt-plan", endpoint: "https://api.openai.com/v1" } as any,
      route: { protocol: "responses", upstreamModel: "gpt-6.1-sol" } as any,
      headers: {},
      fetch: async () => response,
      signal: new AbortController().signal,
    },
    request,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("not ok");
  const out: CanonicalEvent[] = [];
  for await (const event of result.events) out.push(event);
  return { result, out };
}

const sse = [
  { type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
  { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
  { type: "response.metadata" },
  { type: "response.completed", response: { id: "resp_1", model: "gpt-6.1-sol", usage: { input_tokens: 3, output_tokens: 1 } } },
]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join("");

test("an event stream with no Content-Type is read as a stream, through its terminal event", async () => {
  const response = undeclared(sse);
  expect(response.headers.get("content-type")).toBeNull();
  const { result, out } = await events(response);
  expect(result.ok && result.streamed).toBe(true);
  expect(out.some((e) => e.type === "text-delta" && e.text === "OK")).toBe(true);
  expect(out.at(-1)?.type === "finish" || out.some((e) => e.type === "finish")).toBe(true);
  expect(out.some((e) => e.type === "error")).toBe(false);
});

test("a JSON body with no Content-Type is still read as one response", async () => {
  const body = JSON.stringify({
    object: "response",
    id: "resp_2",
    model: "gpt-6.1-sol",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "OK" }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 1 },
  });
  const { result, out } = await events(undeclared(`\n  ${body}`));
  expect(result.ok && result.streamed).toBe(false);
  expect(out.some((e) => e.type === "finish")).toBe(true);
});

test("a declared event stream and declared JSON keep their paths", async () => {
  const stream = await events(
    undeclared(sse, { "content-type": "text/event-stream" }),
  );
  expect(stream.result.ok && stream.result.streamed).toBe(true);
  const json = await events(
    undeclared(
      JSON.stringify({ object: "response", id: "r", model: "m", status: "completed", output: [] }),
      { "content-type": "application/json" },
    ),
  );
  expect(json.result.ok && json.result.streamed).toBe(false);
});

/** A declared event stream that sends `head`, then fails as a socket would. */
const broken = (head: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        if (head) controller.enqueue(new TextEncoder().encode(head));
      },
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const dispatch = (response: Response, signal: AbortSignal) =>
  dispatchUpstream(
    {
      connection: { kind: "chatgpt-plan", endpoint: "https://api.openai.com/v1" } as any,
      route: { protocol: "responses", upstreamModel: "gpt-6.1-sol" } as any,
      headers: { "x-test": "1" },
      fetch: async () => response,
      signal,
    },
    request,
  );

test("an upstream that drops the connection mid-stream ends the stream with an error event", async () => {
  // Everything up to, and not including, the terminal event.
  const head = sse.slice(0, sse.indexOf("event: response.completed"));
  const result = await dispatch(broken(head), new AbortController().signal);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("not ok");
  const out: CanonicalEvent[] = [];
  for await (const event of result.events) out.push(event);
  expect(out.some((e) => e.type === "text-delta" && e.text === "OK")).toBe(true);
  expect(out.some((e) => e.type === "finish")).toBe(false);
  const last = out.at(-1);
  expect(last?.type).toBe("error");
  if (last?.type !== "error") throw new Error("no error event");
  expect(last.error).toMatchObject({ kind: "interrupted", retryable: true });
  expect(last.error.message).toContain("socket hang up");
});

test("a body that fails before its first bytes is a classified failure, and a cancel is not retryable", async () => {
  const failed = await dispatch(broken(""), new AbortController().signal);
  expect(failed).toMatchObject({
    ok: false,
    error: { kind: "interrupted", retryable: true },
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await dispatch(broken(""), controller.signal);
  expect(cancelled).toMatchObject({
    ok: false,
    error: { kind: "interrupted", retryable: false },
  });
});
