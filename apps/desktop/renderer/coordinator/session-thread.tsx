import { useRef, useState } from "react";
import {
  DEFAULT_CONVERSATION_TITLE,
  threadTitle,
} from "../../../../packages/domain/threads";
import type {
  ComposerMode,
  TopslSession,
} from "../../../../packages/domain/sessions";
import { Freshness } from "../components/freshness";
import { useDraft } from "../state/drafts";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { answering, planTasks, threadTimeline } from "../state/thread-view";
import { Composer, PaneToggles, SidePane } from "./composer";
import { GoalCard, TeamPane, openFindings, type GoalPane } from "./goal-card";
import { Contributions, SessionTeamPane } from "./session-panes";
import { ResultsPane, WorkPane, type ResultsTab } from "./work-pane";
import { ReferenceCard } from "./project-home";
import {
  Errors,
  endedGoal,
  label,
  newCommandId,
  stateTone,
  useCommandRunner,
  useRuntimeRefresh,
} from "./shared";

const author = { user: "You", service: "Topsl", coordinator: "Coordinators" };
/** The session's three detail destinations (docs/UX_Cleanup_Plan.md §1). */
type Pane = "work" | "team" | "results";

export const composerModeHints: Record<ComposerMode, string> = {
  auto: "The coordinators decide whether this is discussion, a status question, steering or new work, and ask when it is unclear.",
  discuss: "The coordinators answer without starting any work.",
  work: "This message is work: it steers the current goal, or queues a new goal.",
};

/** The Auto / Discuss / Work choice for one message. */
export function ComposerModes({
  value,
  onChange,
  name,
}: {
  value: ComposerMode;
  onChange: (mode: ComposerMode) => void;
  name: string;
}) {
  return (
    <fieldset className="segmented" aria-label="Composer mode">
      {(["auto", "discuss", "work"] as const).map((mode) => (
        <label
          key={mode}
          className={value === mode ? "selected" : ""}
          title={composerModeHints[mode]}
        >
          <input
            type="radio"
            name={name}
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
          />
          {label(mode)}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * One native Topsl session (docs/Native_Sessions_Plan.md): one transcript,
 * the coordinators' shared responses with their attributed contributions,
 * each goal's card with what waits on the owner, and a composer whose
 * messages the coordinators interpret. Details open in three panes: Work
 * (what runs now, its plan, the queue, history and Create loop), Team (the
 * session's team and goal-only overrides) and Results (review, checks and
 * changes). Links from the transcript open the pane at the goal they name.
 */
export function SessionThread({
  projectId,
  sessionId,
  onThread,
}: {
  projectId: string;
  sessionId: string;
  onThread: (threadId: string | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [query, setQuery] = useState<any>(null);
  const [loopsEnabled, setLoopsEnabled] = useState(false);
  const [pane, setPane] = useState<Pane | null>(null);
  const [resultsTab, setResultsTab] = useState<ResultsTab>("review");
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposerMode | null>(null);
  const [target, setTarget] = useState<"current" | "new">("current");
  const [kind, setKind] = useState<"code" | "information">("code");
  const [draft, setDraft] = useDraft(`${projectId}:session:${sessionId}`);
  const reads = useRef(new ScopedReadFence(projectId));
  async function refresh() {
    const ticket = reads.current.begin();
    const [value, sessionValue, loops] = await Promise.all([
      window.topsl.command({
        type: "orchestration-query",
        projectId,
        conversationId: sessionId,
      }),
      window.topsl.command({ type: "session-query", sessionId }),
      window.topsl.command({ type: "loop-query", projectId }),
    ]);
    if (!reads.current.accept(ticket, value)) return;
    setSnapshot(value);
    setQuery(sessionValue);
    setLoopsEnabled(!!loops?.enabled);
  }
  const freshness = useScopedRefresh(projectId, refresh);
  const { run, errors } = useCommandRunner(refresh, sessionId);
  useRuntimeRefresh(refresh);
  const conversation = snapshot?.conversations?.[0];
  const session: TopslSession | undefined = query?.session;
  const goals: any[] = snapshot?.goals ?? [];
  const intakes: any[] = query?.intakes ?? [];
  const active = session?.queue.find((w) => w.id === session.activeWorkId);
  const current =
    goals.find((g) => g.goal.id === active?.goalId) ??
    goals.filter((g) => !endedGoal(g.goal.state)).at(-1);
  const latest = goals.at(-1);
  const focused = goals.find((g) => g.goal.id === focus) ?? current ?? latest;
  if (snapshot && !conversation)
    return (
      <section aria-label="Session" className="thread">
        <p role="alert">This session is no longer recorded.</p>
      </section>
    );
  const title =
    conversation && conversation.title !== DEFAULT_CONVERSATION_TITLE
      ? conversation.title
      : goals.length === 1
        ? threadTitle(goals[0].goal.objective)
        : (conversation?.title ?? "Session");
  const composerMode = mode ?? session?.configuration.composerMode ?? "auto";
  const aimed = current && target === "current" ? current : null;
  /** Opens a pane at a goal: plan in Work, findings, checks or changes in Results. */
  const openPane = (next: GoalPane | Pane | null, goalId?: string) => {
    if (goalId) setFocus(goalId);
    if (next === "plan") setPane("work");
    else if (next === "review" || next === "checks" || next === "changes") {
      setResultsTab(next);
      setPane("results");
    } else setPane(next);
  };
  async function send() {
    const text = draft.trim();
    if (!text) return;
    const sent = await run("message", {
      type: "session-message",
      sessionId,
      text,
      mode: composerMode,
      target: aimed ? aimed.goal.id : null,
      kind,
      commandId: newCommandId(),
    });
    if (sent) setDraft("");
  }
  const control = (action: "pause" | "resume" | "stop") =>
    void run(`session-${action}`, {
      type: "session-control",
      sessionId,
      action,
      commandId: newCommandId(),
    });
  const about: Record<string, string> = {};
  for (const w of session?.queue ?? [])
    if (w.messageId && w.goalId) about[w.messageId] = w.goalId;
  const byIntake = new Map(intakes.map((i) => [i.id, i]));
  const pending = answering(intakes);
  const panes: Array<{ id: Pane; title: string; count?: number }> = [
    {
      id: "work",
      title: "Work",
      count: session?.queue.filter((w) =>
        ["queued", "waiting-configuration"].includes(w.state),
      ).length,
    },
    { id: "team", title: "Team" },
    {
      id: "results",
      title: "Results",
      count: focused ? openFindings(focused) : 0,
    },
  ];
  const paneTitle = panes.find((p) => p.id === pane)?.title ?? "";
  const tasks = current ? planTasks(current) : [];
  const state = session
    ? session.control === "paused"
      ? "paused"
      : (current?.goal.state ?? (active ? "running" : "idle"))
    : null;
  return (
    <section
      aria-label="Session"
      className={`thread ${pane ? "with-pane" : ""}`}
    >
      <header className="thread-header">
        <div className="thread-title">
          <h1>{snapshot ? title : "Loading session…"}</h1>
          {state && (
            <span className={`badge ${stateTone[state] ?? ""}`}>
              {label(state)}
            </span>
          )}
        </div>
        <div className="thread-tools">
          {session && (
            <div
              className="actions session-controls"
              role="group"
              aria-label="Session controls"
            >
              {session.control === "paused" ? (
                <button type="button" onClick={() => control("resume")}>
                  Resume session
                </button>
              ) : (
                <button type="button" onClick={() => control("pause")}>
                  Pause session
                </button>
              )}
              <button type="button" onClick={() => control("stop")}>
                Stop session
              </button>
            </div>
          )}
          {session && (
            <PaneToggles
              panes={panes}
              open={pane}
              onOpen={(next) => openPane(next)}
            />
          )}
        </div>
      </header>
      <Freshness state={freshness} retry={freshness.retry} />
      <Errors errors={errors} />
      {session?.attention && (
        <p role="status" className="session-attention">
          <strong>{label(session.attention.kind)}:</strong>{" "}
          {session.attention.detail}
          {session.attention.kind !== "choose-alternative" && (
            <button type="button" onClick={() => openPane("team")}>
              Open Team
            </button>
          )}
        </p>
      )}
      <div className="thread-layout">
        <div className="thread-main">
          {session?.reference && (
            <ReferenceCard
              title={session.reference.fileName}
              provider={session.reference.provider}
              formatLabel={session.reference.formatLabel}
              included={
                session.reference.messageCount
                  ? `newest ${session.reference.includedMessages} of ${session.reference.messageCount} messages`
                  : "text excerpt"
              }
              omissions={session.reference.omissions}
            />
          )}
          <ol className="transcript" aria-label="Conversation">
            {conversation &&
              threadTimeline(conversation.messages, goals, about).map(
                (item) => {
                  if (item.kind === "goal")
                    return (
                      <li key={item.key} className="turn-card">
                        <GoalCard
                          view={item.goal}
                          run={run}
                          onPane={(next, goalId) => openPane(next, goalId)}
                        />
                      </li>
                    );
                  const message = item.message;
                  const intake =
                    message.role !== "user" && message.intakeId
                      ? byIntake.get(message.intakeId)
                      : null;
                  const alternatives =
                    intake?.stage === "awaiting-user" &&
                    intake.replyMessageId === message.id &&
                    intake.outcome?.kind === "alternatives"
                      ? intake.outcome.options
                      : null;
                  return (
                    <li key={item.key} className={`turn ${message.role}`}>
                      <span className="turn-author">
                        {author[message.role]}
                      </span>
                      <div className="turn-text">{message.text}</div>
                      {alternatives && (
                        <div
                          className="actions"
                          role="group"
                          aria-label="Coordinator alternatives"
                        >
                          {alternatives.map((o: any, index: number) => (
                            <button
                              type="button"
                              key={index}
                              onClick={() =>
                                void run("choose", {
                                  type: "session-choose",
                                  sessionId,
                                  intakeId: intake.id,
                                  option: index,
                                  commandId: newCommandId(),
                                })
                              }
                            >
                              Choose {index + 1}: {label(o.intent)}
                            </button>
                          ))}
                        </div>
                      )}
                      {intake && <Contributions intake={intake} />}
                    </li>
                  );
                },
              )}
            {pending.map((i) => (
              <li key={i.id} className="turn coordinator pending" role="status">
                <span className="turn-author">Coordinators</span>
                <div className="turn-text muted">Answering… {i.detail}</div>
              </li>
            ))}
          </ol>
          <div className="thread-footer">
            {tasks.length > 0 && (
              <p className="plan-line">
                Plan: {tasks.filter((t) => t.state === "completed").length} of{" "}
                {tasks.length} tasks done
                {tasks.some((t) => t.state === "blocked")
                  ? ` · ${tasks.filter((t) => t.state === "blocked").length} blocked`
                  : ""}{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => openPane("plan", current?.goal.id)}
                >
                  Work
                </button>
              </p>
            )}
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              note={composerModeHints[composerMode]}
              placeholder={
                aimed
                  ? 'For example: "Also keep the public API unchanged." or "How is it going?"'
                  : 'For example: "What would it take to add caching?" or "Add a test for the parser."'
              }
            >
              <ComposerModes
                value={composerMode}
                onChange={setMode}
                name={`composer-mode-${sessionId}`}
              />
              {current ? (
                <label className="composer-target">
                  <span className="visually-hidden">Target</span>
                  <select
                    aria-label="Target"
                    value={target}
                    onChange={(e) =>
                      setTarget(e.target.value as "current" | "new")
                    }
                  >
                    <option value="current">
                      Current goal: {threadTitle(current.goal.objective, 40)}
                    </option>
                    <option value="new">New goal</option>
                  </select>
                </label>
              ) : (
                <span className="muted tiny composer-target">
                  Target: New goal
                </span>
              )}
              {!aimed && composerMode !== "discuss" && (
                <label className="tiny">
                  <span className="visually-hidden">Goal kind</span>
                  <select
                    aria-label="Goal kind"
                    value={kind}
                    onChange={(e) =>
                      setKind(e.target.value as "code" | "information")
                    }
                  >
                    <option value="code">Code</option>
                    <option value="information">Information</option>
                  </select>
                </label>
              )}
            </Composer>
          </div>
        </div>
        {pane && snapshot && query && (
          <SidePane title={paneTitle} onClose={() => setPane(null)}>
            {pane === "work" && session && (
              <WorkPane
                session={session}
                goals={goals}
                focused={focused ?? null}
                onFocus={setFocus}
                run={run}
                projectId={projectId}
                loopsEnabled={loopsEnabled}
                onThread={(next) => onThread(next)}
              />
            )}
            {pane === "team" && (
              <>
                <SessionTeamPane query={query} snapshot={snapshot} run={run} />
                {focused && (
                  <details open={!!editing}>
                    <summary>
                      Overrides for one goal only:{" "}
                      {threadTitle(focused.goal.objective, 40)}
                    </summary>
                    <p className="muted">
                      These change this goal's roles and nothing else; the
                      session's team above applies to new work.
                    </p>
                    <TeamPane
                      view={focused}
                      snapshot={snapshot}
                      projectId={projectId}
                      run={run}
                      editing={editing}
                      onEdit={setEditing}
                    />
                  </details>
                )}
              </>
            )}
            {pane === "results" && (
              <ResultsPane
                goals={goals}
                focused={focused ?? null}
                onFocus={setFocus}
                tab={resultsTab}
                onTab={setResultsTab}
                run={run}
              />
            )}
          </SidePane>
        )}
      </div>
    </section>
  );
}
