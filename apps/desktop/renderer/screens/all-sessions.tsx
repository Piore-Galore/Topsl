import { useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "../../../../packages/domain/threads";
import { label, stateTone } from "../coordinator/shared";

const kindLabel: Record<ThreadSummary["kind"], string> = {
  session: "Session",
  "goal-loop": "Goal loop",
  endless: "Endless loop",
};
const PAGE = 50;

/**
 * All sessions (docs/UX_Cleanup_Plan.md §1): every session and standalone
 * loop of a project, newest first, searchable and paged, so none is out of
 * reach however many there are.
 */
export function AllSessions({
  projectId,
  projectName,
  onThread,
  onNew,
}: {
  projectId: string;
  projectName?: string;
  onThread: (threadId: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const ticket = useRef(0);
  async function load(search: string, after: string | null) {
    const mine = ++ticket.current;
    setError("");
    try {
      const page = await window.topsl.command({
        type: "project-threads-page",
        projectId,
        query: search || undefined,
        cursor: after,
        limit: PAGE,
      });
      if (mine !== ticket.current) return;
      setThreads((current) =>
        after ? [...(current ?? []), ...page.threads] : page.threads,
      );
      setTotal(page.total);
      setCursor(page.nextCursor);
    } catch (e: any) {
      if (mine === ticket.current) setError(e.message);
    }
  }
  useEffect(() => {
    setThreads(null);
    setQuery("");
    setApplied("");
    void load("", null);
  }, [projectId]);
  // The list follows new and changed sessions without losing the search.
  useEffect(
    () =>
      window.topsl.subscribe((event) => {
        if (event.type !== "changes") return;
        const touched = (event.data?.events ?? []).some(
          (e: any) =>
            e.projectId === projectId &&
            ["orch-conversation", "orch-session", "goal", "loop-run"].includes(
              e.kind,
            ),
        );
        if (touched && !cursor) void load(applied, null);
      }),
    [projectId, applied, cursor],
  );
  return (
    <section className="all-sessions" aria-label="All sessions">
      <div className="page-heading">
        <div>
          <h1>All sessions</h1>
          {projectName && <p className="muted">{projectName}</p>}
        </div>
        <button type="button" className="primary" onClick={onNew}>
          New session
        </button>
      </div>
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(query.trim());
          void load(query.trim(), null);
        }}
      >
        <input
          aria-label="Search sessions"
          placeholder="Search by title or state…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!threads ? (
        <p role="status">Loading sessions…</p>
      ) : !threads.length ? (
        <p className="muted">
          {applied ? "No matching sessions." : "No sessions yet."}
        </p>
      ) : (
        <>
          <p className="muted" aria-live="polite">
            {applied
              ? `${total} matching ${total === 1 ? "session" : "sessions"}`
              : `${total} ${total === 1 ? "session" : "sessions"}`}
          </p>
          <ul className="session-index">
            {threads.map((t) => (
              <li key={t.threadId}>
                <button
                  type="button"
                  className="recent-link"
                  onClick={() => onThread(t.threadId)}
                >
                  {t.title}
                </button>
                <span className="badge">{kindLabel[t.kind]}</span>
                <span className={`badge ${stateTone[t.state] ?? ""}`}>
                  {label(t.state)}
                </span>
                {t.needsYou && (
                  <span className="badge warm">Needs you: {t.needsYou}</span>
                )}
                <span className="muted tiny">
                  {new Date(t.updatedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          {cursor && (
            <button type="button" onClick={() => void load(applied, cursor)}>
              Show more ({threads.length} of {total})
            </button>
          )}
        </>
      )}
    </section>
  );
}
