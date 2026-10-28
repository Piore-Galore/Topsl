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
import { Composer, PaneToggles, SidePane, TaskList } from "./composer";
import {
  ChangesPane,
  ChecksPane,
  GoalCard,
  PlanPane,
  ReviewPane,
  TeamPane,
  openFindings,
  type GoalPane,
} from "./goal-card";
import { Contributions, SessionTeamPane, WorkPane } from "./session-panes";
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
type Pane = GoalPane | "work";

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
 * each goal's card, the session's work queue and team, and a composer whose
 * messages the coordinators interpret. Goals keep their own controls.
 */
export function SessionThread({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [query, setQuery] = useState<any>(null);
  const [pane, setPane] = useState<Pane | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposerMode | null>(null);
  const [target, setTarget] = useState<"current" | "new">("current");
  const [kind, setKind] = useState<"code" | "information">("code");
  const [draft, setDraft] = useDraft(`${projectId}:session:${sessionId}`);
  const reads = useRef(new ScopedReadFence(projectId));
  async function refresh() {
    const ticket = reads.current.begin();
    const [value, sessionValue] = await Promise.all([
      window.topsl.command({
        type: "orchestration-query",
        projectId,
        conversationId: sessionId,
      }),
      window.topsl.command({ type: "session-query", sessionId }),
    ]);
    if (!reads.current.accept(ticket, value)) return;
    setSnapshot(value);
    setQuery(sessionValue);
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
  const openPane = (next: Pane | null, goalId?: string) => {
    if (goalId) setFocus(goalId);
    setPane(next);
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
    { id: "team", title: "Team" },
    {
      id: "work",
      title: "Work",
      count: session?.queue.filter((w) =>
        ["queued", "waiting-configuration"].includes(w.state),
      ).length,
    },
    ...(focused
      ? ([
          { id: "plan", title: "Plan" },
          { id: "review", title: "Review", count: openFindings(focused) },
          { id: "checks", title: "Checks" },
          { id: "changes", title: "Changes" },
        ] as const)
      : []),
  ];
  const paneTitle = panes.find((p) => p.id === pane)?.title ?? "";
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
              panes={panes as any}
              open={pane as any}
              onOpen={(next) => openPane(next as Pane)}
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
          <ol className="transcript" aria-label="Conversation">
            {conversation &&
              threadTimeline(conversation.messages, goals, about).map(
                (item) => {
                  if (item.kind === "goal")
                    return (
                      <li key={item.key} className="turn-card">
                        <GoalCard
                          view={item.goal}
                          projectId={projectId}
                          run={run}
                          controls
                          onPane={(next, goalId) => openPane(next, goalId)}
                          onChangeRole={(goalId, roleId) => {
                            setEditing(roleId);
                            openPane("team", goalId);
                          }}
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
            {current && (
              <TaskList
                revision={current.plan?.revision ?? null}
                tasks={planTasks(current)}
              />
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
            {pane === "team" && (
              <>
                <SessionTeamPane query={query} snapshot={snapshot} run={run} />
                {focused && (
                  <details>
                    <summary>
                      This goal's team:{" "}
                      {threadTitle(focused.goal.objective, 40)}
                    </summary>
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
            {pane === "work" && session && (
              <WorkPane session={session} goals={goals} run={run} />
            )}
            {focused &&
              goals.length > 1 &&
              !["team", "work"].includes(pane) && (
                <p className="muted">Goal: {focused.goal.objective}</p>
              )}
            {pane === "plan" && focused && <PlanPane view={focused} />}
            {pane === "review" && focused && (
              <ReviewPane view={focused} run={run} />
            )}
            {pane === "checks" && focused && (
              <ChecksPane view={focused} run={run} />
            )}
            {pane === "changes" && focused && <ChangesPane view={focused} />}
          </SidePane>
        )}
      </div>
    </section>
  );
}
