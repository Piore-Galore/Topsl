import { useEffect, useRef, type ReactNode } from "react";

/**
 * The thread composer. Command/Ctrl+Enter sends and Enter makes a newline
 * (docs/Topsl_Design.md §20.8), so editing a long message never sends a
 * billable request by accident.
 */
export function Composer({
  value,
  onChange,
  onSend,
  sendLabel = "Send",
  disabled = false,
  sending = false,
  loading = false,
  placeholder,
  note,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sendLabel?: string;
  disabled?: boolean;
  /** A submission is in flight: Send waits for it. */
  sending?: boolean;
  /** What the message would act on is not read yet: Send waits for it, typing does not. */
  loading?: boolean;
  placeholder?: string;
  note?: ReactNode;
  children?: ReactNode;
}) {
  const ready = !disabled && !sending && !loading && !!value.trim();
  return (
    <div className="thread-composer">
      <label className="composer-field">
        <span className="visually-hidden">Message</span>
        <textarea
          aria-label="Message"
          rows={3}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // An input method's Enter commits its composition; it never sends
            // the uncommitted text (campaign 2026-11-04, W3-2).
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) {
              e.preventDefault();
              onSend();
            }
          }}
        />
      </label>
      {note && <p className="muted composer-note">{note}</p>}
      <div className="composer-bar">
        <div className="composer-options">{children}</div>
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={onSend}
          title="Command/Ctrl+Enter"
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * The thread's detail pane. The thread header's toggles choose what it
 * shows; at narrower widths it overlays the transcript (atlas.css). Opening
 * it moves focus to its heading, Escape closes it, and closing returns focus
 * to whatever opened it (W3-6).
 */
export function SidePane({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus();
    return () => {
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        // Only when focus would otherwise be lost, not after the owner moved on.
        (document.activeElement === document.body ||
          !document.activeElement?.isConnected)
      )
        opener.focus();
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <aside
      className="thread-pane"
      aria-label={`${title} details`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className="thread-pane-header">
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <button
          type="button"
          aria-label={`Close ${title.toLowerCase()} details`}
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <div className="thread-pane-body">{children}</div>
    </aside>
  );
}

/** Header toggles for the thread's panes; one pane is open at a time. */
export function PaneToggles<P extends string>({
  panes,
  open,
  onOpen,
}: {
  panes: Array<{ id: P; title: string; count?: number }>;
  open: P | null;
  onOpen: (pane: P | null) => void;
}) {
  return (
    <div className="pane-toggles" role="group" aria-label="Thread panes">
      {panes.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={open === p.id}
          onClick={() => onOpen(open === p.id ? null : p.id)}
        >
          {p.title}
          {p.count ? (
            <span className="count" aria-hidden="true">
              {p.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
