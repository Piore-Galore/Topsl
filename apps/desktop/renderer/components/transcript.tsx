import { useEffect, useRef, useState } from "react";
import type { Message } from "../../../../packages/domain/types";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { Freshness } from "./freshness";
type PreviewMessage = Message & { totalChars?: number; truncated?: boolean };
const ROW = 236,
  OVERSCAN = 4;
export function Transcript({
  projectId,
  conversationId,
}: {
  projectId: string;
  conversationId: string;
}) {
  const [items, setItems] = useState<PreviewMessage[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [top, setTop] = useState(0),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, string>>({}),
    [contentPending, setContentPending] = useState<Record<string, boolean>>({});
  const generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId)),
    viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    setItems([]);
    setCursor(null);
    setTop(0);
    setExpanded({});
    setContentPending({});
    setError("");
    setPending(false);
    return () => {
      generation.current++;
      reads.current.reset("");
    };
  }, [projectId, conversationId]);
  async function load(older = false, propagate = false) {
    if (!projectId || !conversationId) return;
    const ticket = generation.current,
      readTicket = reads.current.begin();
    const follow =
      !!viewport.current &&
      viewport.current.scrollHeight -
        viewport.current.scrollTop -
        viewport.current.clientHeight <
        ROW * 2;
    setPending(true);
    try {
      const page = await window.topsl.command({
        type: "history-page",
        projectId,
        conversationId,
        cursor: older ? cursor : undefined,
        limit: 80,
      });
      if (!reads.current.accept(readTicket, page)) return;
      setItems((previous) =>
        [
          ...new Map(
            [...(older ? previous : []), ...page.items.slice().reverse()].map(
              (item: Message) => [item.id, item],
            ),
          ).values(),
        ].sort(
          (a: any, b: any) =>
            a.createdAt.localeCompare(b.createdAt) ||
            (a.source?.nativeOrder ?? 0) - (b.source?.nativeOrder ?? 0),
        ),
      );
      if (follow && !older)
        requestAnimationFrame(() => {
          if (viewport.current)
            viewport.current.scrollTop = viewport.current.scrollHeight;
        });
      setCursor(page.nextCursor);
      setError("");
    } catch (e: any) {
      if (ticket === generation.current) setError(e.message);
      if (propagate) throw e;
    } finally {
      if (ticket === generation.current) setPending(false);
    }
  }
  async function more(message: PreviewMessage) {
    const ticket = generation.current,
      previous = expanded[message.id] ?? message.text;
    setContentPending((current) => ({ ...current, [message.id]: true }));
    try {
      const page = await window.topsl.command({
        type: "history-message",
        projectId,
        id: message.id,
        offset: previous.length,
        limit: 20000,
      });
      if (ticket === generation.current)
        setExpanded((current) => ({
          ...current,
          [message.id]: previous + page.text,
        }));
    } catch (error: any) {
      if (ticket === generation.current) setError(error.message);
    } finally {
      if (ticket === generation.current)
        setContentPending((current) => ({ ...current, [message.id]: false }));
    }
  }
  const freshness = useScopedRefresh(`${projectId}`, () => load(false, true));
  useEffect(() => {
    void load();
  }, [conversationId]);
  const start = Math.max(0, Math.floor(top / ROW) - OVERSCAN),
    visible = items.slice(start, start + 12 + OVERSCAN * 2);
  return (
    <section className="transcript" aria-label="Conversation transcript">
      <Freshness state={freshness} retry={freshness.retry} />
      {error && <p role="alert">{error}</p>}
      {cursor && (
        <button disabled={pending} onClick={() => void load(true)}>
          {pending ? "Loading…" : "Load older messages"}
        </button>
      )}
      {!items.length ? (
        <p className="muted">
          {pending
            ? "Loading scoped history…"
            : "No recorded messages in this conversation."}
        </p>
      ) : (
        <div
          ref={viewport}
          className="virtual-transcript"
          tabIndex={0}
          onScroll={(event) => setTop(event.currentTarget.scrollTop)}
          aria-label="Scrollable transcript"
        >
          <div style={{ height: items.length * ROW, position: "relative" }}>
            {visible.map((message, index) => (
              <article
                key={message.id}
                className={`message virtual-message ${message.role}`}
                style={{ top: (start + index) * ROW, height: ROW }}
              >
                <div className="message-meta">
                  <strong>{message.role}</strong>
                  <span>
                    {message.provider ?? "you"} ·{" "}
                    {new Date(message.createdAt).toLocaleString()}
                  </span>
                </div>
                <pre
                  tabIndex={0}
                  aria-label={`${message.role} message content`}
                >
                  {expanded[message.id] ?? message.text}
                </pre>
                {(expanded[message.id] ?? message.text).length <
                  (message.totalChars ?? message.text.length) && (
                  <button
                    disabled={contentPending[message.id]}
                    onClick={() => void more(message)}
                  >
                    Show more message content ·{" "}
                    {(expanded[message.id] ?? message.text).length}/
                    {message.totalChars} characters
                  </button>
                )}
              </article>
            ))}
          </div>
        </div>
      )}
      {items.length > 0 && (
        <p className="tiny muted">
          {items.length} messages loaded
          {cursor ? "; older messages load on request" : ""}.
        </p>
      )}
    </section>
  );
}
