/**
 * Server-sent events, as every upstream and client protocol of the local
 * proxy streams them (docs/Native_Harness_Plan.md §2, "Local proxy
 * interface"). The parser follows the WHATWG event-stream rules closely
 * enough for model APIs: network chunks may split a line, a CRLF pair or a
 * multi-byte UTF-8 character anywhere, so nothing is interpreted until a
 * whole line has arrived.
 */

/** One dispatched event: its `event:` name, joined `data:` lines and `id:`. */
export interface SseFrame {
  event: string | null;
  data: string;
  id: string | null;
}

/**
 * Splits a byte or text stream into SSE frames. Comment lines (`:`) and
 * unknown fields are ignored, `data:` lines are joined with newlines, and a
 * final frame that the upstream closed without a blank line is still
 * delivered, because model APIs end their last event that way often enough
 * that dropping it would lose a terminal event.
 */
export async function* parseSse(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let started = false;
  let event: string | null = null;
  let id: string | null = null;
  let data: string[] = [];
  let hasData = false;

  /** Applies one complete line; returns a frame when the line ends one. */
  const line = (text: string): SseFrame | null => {
    if (text === "") {
      const frame = hasData ? { event, data: data.join("\n"), id } : null;
      event = null;
      id = null;
      data = [];
      hasData = false;
      return frame;
    }
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":");
    const name = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") event = value;
    else if (name === "data") {
      data.push(value);
      hasData = true;
    } else if (name === "id" && !value.includes("\0")) id = value;
    return null;
  };

  /** How far the buffer is known to hold no line break, so a long line is scanned once. */
  let scanned = 0;

  /** Yields the frames completed by the whole lines now in the buffer. */
  function* drain(final: boolean): Generator<SseFrame> {
    if (!started && buffer.length > 0) {
      started = true;
      if (buffer.startsWith("\uFEFF")) buffer = buffer.slice(1);
    }
    let start = 0;
    let end = scanned;
    for (;;) {
      while (
        end < buffer.length &&
        buffer[end] !== "\n" &&
        buffer[end] !== "\r"
      )
        end++;
      if (end >= buffer.length) break;
      // A CR at the very end may be the first half of a CRLF pair.
      if (buffer[end] === "\r" && end + 1 === buffer.length && !final) break;
      const frame = line(buffer.slice(start, end));
      if (frame) yield frame;
      start = end + (buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1);
      end = start;
    }
    buffer = buffer.slice(start);
    scanned = end - start;
  }

  for await (const chunk of source) {
    // A text chunk cannot continue a partial UTF-8 sequence, so flush first.
    buffer +=
      typeof chunk === "string"
        ? decoder.decode() + chunk
        : decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
  if (buffer.length > 0) {
    const frame = line(buffer);
    buffer = "";
    if (frame) yield frame;
  }
  const last = line("");
  if (last) yield last;
}

/**
 * Formats one frame. Multi-line data is split into several `data:` lines so
 * a newline inside the payload can never end the frame early.
 */
export function formatSse(frame: { event?: string; data: string }): string {
  if (frame.event !== undefined && /[\r\n]/.test(frame.event))
    throw new Error("An SSE event name cannot contain a line break.");
  let text = frame.event !== undefined ? `event: ${frame.event}\n` : "";
  for (const line of frame.data.split(/\r\n|\r|\n/)) text += `data: ${line}\n`;
  return text + "\n";
}
