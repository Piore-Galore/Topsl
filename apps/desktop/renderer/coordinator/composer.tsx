import type { ReactNode } from "react";

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
  placeholder,
  note,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sendLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  note?: ReactNode;
  children?: ReactNode;
}) {
  const ready = !disabled && !!value.trim();
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
 * shows; at narrower widths it overlays the transcript (atlas.css).
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
  return (
    <aside className="thread-pane" aria-label={`${title} details`}>
      <header className="thread-pane-header">
        <h2>{title}</h2>
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
