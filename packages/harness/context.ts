import { hash, stable } from "../domain/invariants";
import type {
  CanonicalMessage,
  CanonicalPart,
  CanonicalRequest,
  CanonicalTool,
  ClientProtocol,
} from "../proxy/canonical";
import type { JournalBodies, JournalEvent } from "./types";

/**
 * Context compilation and compaction (docs/Native_Harness_Plan.md §3,
 * "Recovery and context"). The conversation is rebuilt from durable journal
 * events, never from summaries alone: a compaction capsule replaces only the
 * event range it was published against, and policy, project instructions,
 * the owner's own words and complete tool exchanges are always kept.
 */

/**
 * A conservative token estimate (about 3.5 characters per token, plus
 * per-message overhead). Providers count differently; this only decides
 * admission and compaction, never a promise about spending.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateMessages(
  instructions: string,
  messages: CanonicalMessage[],
  tools: CanonicalTool[],
): number {
  let total = estimateTokens(instructions) + 8;
  for (const tool of tools) total += estimateTokens(JSON.stringify(tool)) + 4;
  for (const message of messages) {
    total += 6;
    for (const part of message.parts) total += partTokens(part);
  }
  return total;
}

function partTokens(part: CanonicalPart): number {
  switch (part.type) {
    case "text":
      return estimateTokens(part.text);
    case "image":
      return 1600;
    case "tool-call":
      return estimateTokens(part.name + part.arguments) + 8;
    case "tool-result":
      return estimateTokens(part.output) + 8;
    case "reasoning":
      return (
        estimateTokens(part.text ?? "") +
        (part.opaque ? estimateTokens(JSON.stringify(part.opaque.value)) : 0)
      );
  }
}

export interface Conversation {
  messages: CanonicalMessage[];
  /** Journal sequences after which the conversation is at a complete user turn. */
  boundaries: Array<{ sequence: number; messageCount: number }>;
  /** The latest compaction applied, if any. */
  compactedThrough: number;
  /** The owner's words, kept verbatim through any compaction. */
  ownerWords: string[];
}

/** Request numbers that were compaction requests; their answers are capsules, not turns. */
export function compactionRequests(events: JournalEvent[]): Set<number> {
  const numbers = new Set<number>();
  for (const event of events)
    if (
      event.kind === "request-frozen" &&
      (event.body as JournalBodies["request-frozen"]).purpose === "compaction"
    )
      numbers.add(
        (event.body as JournalBodies["request-frozen"]).requestNumber,
      );
  return numbers;
}

/** Responses that become part of the conversation: settled, successful, complete, and not a compaction. */
function usable(
  body: JournalBodies["response-settled"],
  compactions: Set<number>,
): boolean {
  return (
    !body.error &&
    (body.finish === "stop" || body.finish === "tool-calls") &&
    !compactions.has(body.requestNumber)
  );
}

/**
 * Rebuilds the model conversation from journal events. Provider-private
 * reasoning is kept only for the protocol that produced it.
 */
export function buildConversation(
  events: JournalEvent[],
  protocol: ClientProtocol,
): Conversation {
  const compactions = compactionRequests(events);
  const compaction = [...events]
    .reverse()
    .find((e) => e.kind === "compaction") as
    JournalEvent<"compaction"> | undefined;
  const messages: CanonicalMessage[] = [];
  const boundaries: Conversation["boundaries"] = [];
  const ownerWords: string[] = [];
  let toolResults: CanonicalPart[] = [];
  const flush = (sequence: number) => {
    if (toolResults.length) {
      // Results follow the order of the calls they answer, however the tools finished.
      const order = new Map<string, number>();
      const previous = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      previous?.parts.forEach(
        (p, i) => p.type === "tool-call" && order.set(p.id, i),
      );
      toolResults.sort(
        (a, b) =>
          (order.get((a as { callId: string }).callId) ?? Infinity) -
          (order.get((b as { callId: string }).callId) ?? Infinity),
      );
      messages.push({ role: "user", parts: toolResults });
      toolResults = [];
      boundaries.push({ sequence, messageCount: messages.length });
    }
  };
  if (compaction)
    messages.push({
      role: "user",
      parts: [{ type: "text", text: compaction.body.summary }],
    });
  for (const event of events) {
    if (event.kind === "input-claimed")
      ownerWords.push(...(event.body as JournalBodies["input-claimed"]).texts);
    if (compaction && event.sequence <= compaction.body.throughSequence)
      continue;
    switch (event.kind) {
      case "input-claimed": {
        flush(event.sequence);
        const body = event.body as JournalBodies["input-claimed"];
        if (body.texts.length) {
          const last = messages.at(-1);
          const parts: CanonicalPart[] = body.texts.map((text) => ({
            type: "text",
            text,
          }));
          // Two user turns in a row are merged; some protocols require alternation.
          if (last?.role === "user") last.parts.push(...parts);
          else messages.push({ role: "user", parts });
          boundaries.push({
            sequence: event.sequence,
            messageCount: messages.length,
          });
        }
        break;
      }
      case "response-settled": {
        const body = event.body as JournalBodies["response-settled"];
        if (!usable(body, compactions)) break;
        flush(event.sequence);
        const parts = body.output.filter(
          (p) =>
            p.type !== "reasoning" ||
            (p.opaque !== null && p.opaque.protocol === protocol),
        );
        if (parts.length) messages.push({ role: "assistant", parts });
        break;
      }
      case "tool-result": {
        const body = event.body as JournalBodies["tool-result"];
        toolResults.push({
          type: "tool-result",
          callId: body.callId,
          output: body.output,
          isError: !body.ok,
        });
        break;
      }
      default:
        break;
    }
  }
  flush(events.at(-1)?.sequence ?? 0);
  // A trailing user turn made only of tool results is valid; merge any
  // adjacent user messages produced by results followed by steering.
  const merged: CanonicalMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last && last.role === message.role) last.parts.push(...message.parts);
    else merged.push({ role: message.role, parts: [...message.parts] });
  }
  return {
    messages: merged,
    boundaries,
    compactedThrough: compaction?.body.throughSequence ?? 0,
    ownerWords,
  };
}

/** Tool calls in settled responses that have no recorded result yet. */
export function openToolCalls(events: JournalEvent[]): string[] {
  const compactions = compactionRequests(events);
  const calls: string[] = [];
  const results = new Set<string>();
  for (const event of events) {
    if (event.kind === "response-settled") {
      const body = event.body as JournalBodies["response-settled"];
      if (!usable(body, compactions)) continue;
      for (const part of body.output)
        if (part.type === "tool-call") calls.push(part.id);
    }
    if (event.kind === "tool-result")
      results.add((event.body as JournalBodies["tool-result"]).callId);
  }
  return calls.filter((id) => !results.has(id));
}

export interface CompileInput {
  model: string;
  instructions: string;
  conversation: Conversation;
  tools: CanonicalTool[];
  reasoningEffort: string | null;
}

export function compileRequest(input: CompileInput): {
  request: CanonicalRequest;
  estimatedTokens: number;
} {
  const request: CanonicalRequest = {
    model: input.model,
    instructions: input.instructions,
    messages: input.conversation.messages,
    tools: input.tools,
    toolChoice: "auto",
    maxOutputTokens: null,
    temperature: null,
    topP: null,
    stop: [],
    reasoningEffort: input.reasoningEffort,
    thinkingBudget: null,
    parallelToolCalls: null,
    stream: true,
    clientProtocol: "responses",
  };
  return {
    request,
    estimatedTokens: estimateMessages(
      input.instructions,
      input.conversation.messages,
      input.tools,
    ),
  };
}

/**
 * Chooses the event range a compaction may replace: the latest complete user
 * turn that still leaves the most recent exchanges verbatim. Returns null
 * when there is not enough history to compact.
 */
export function compactionCut(
  conversation: Conversation,
  keepRecentTurns = 2,
): number | null {
  const candidates = conversation.boundaries.filter(
    (b) => b.sequence > conversation.compactedThrough,
  );
  if (candidates.length <= keepRecentTurns) return null;
  return candidates[candidates.length - 1 - keepRecentTurns].sequence;
}

/** Renders the events of a range as a plain transcript for the compaction request. */
export function transcript(
  events: JournalEvent[],
  throughSequence: number,
  previousSummary: string | null,
  afterSequence = 0,
  limitChars = 400_000,
): string {
  const compactions = compactionRequests(events);
  const lines: string[] = [];
  if (previousSummary) lines.push(`[Earlier summary]\n${previousSummary}`);
  for (const event of events) {
    if (event.sequence > throughSequence) break;
    // A range an earlier capsule already summarized is not repeated.
    if (event.sequence <= afterSequence) continue;
    if (event.kind === "input-claimed")
      lines.push(
        ...(event.body as JournalBodies["input-claimed"]).texts.map(
          (t) => `[Owner]\n${t}`,
        ),
      );
    else if (event.kind === "response-settled") {
      const body = event.body as JournalBodies["response-settled"];
      if (!usable(body, compactions)) continue;
      for (const part of body.output) {
        if (part.type === "text") lines.push(`[Assistant]\n${part.text}`);
        if (part.type === "tool-call")
          lines.push(
            `[Tool call ${part.id}] ${part.name} ${part.arguments.slice(0, 4000)}`,
          );
      }
    } else if (event.kind === "tool-result") {
      const body = event.body as JournalBodies["tool-result"];
      lines.push(
        `[Tool result ${body.callId}${body.ok ? "" : " (failed)"}]\n${body.output.slice(0, 8000)}`,
      );
    }
  }
  const text = lines.join("\n\n");
  return text.length > limitChars
    ? `…(earliest part omitted)\n${text.slice(-limitChars)}`
    : text;
}

export const compactionInstructions =
  "You are compacting the working history of a coding agent so it can continue with less context. Write a faithful, specific summary: the task, decisions made, files read and changed (with paths), commands and checks run with their results, open problems and the next steps. Keep exact identifiers, paths, error messages and numbers. Do not invent anything and do not call tools.";

/** The capsule text that replaces a compacted range. */
export function capsuleText(
  summary: string,
  ownerWords: string[],
  throughSequence: number,
): string {
  const words = ownerWords.map((w, i) => `${i + 1}. ${w}`).join("\n\n");
  return `[Topsl compacted this attempt's history through journal event ${throughSequence}. The owner's messages are kept verbatim; the rest is a summary.]\n\nOwner's messages so far:\n${words}\n\nSummary of the work so far:\n${summary}`;
}

/** The hash a capsule is published against; events are immutable, so it fixes the range. */
export function rangeHash(
  events: JournalEvent[],
  throughSequence: number,
): string {
  return hash(
    stable(
      events.filter((e) => e.sequence <= throughSequence).map((e) => e.hash),
    ),
  );
}
