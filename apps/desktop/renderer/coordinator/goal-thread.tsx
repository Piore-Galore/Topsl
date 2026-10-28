import { useRef, useState } from "react";
import {
  DEFAULT_CONVERSATION_TITLE,
  threadTitle,
} from "../../../../packages/domain/threads";
import { Freshness } from "../components/freshness";
import { useDraft } from "../state/drafts";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { planTasks, threadTimeline } from "../state/thread-view";
import { Composer, PaneToggles, SidePane, TaskList } from "./composer";
import {
  ChangesPane,
  ChecksPane,
  GoalCard,
  GoalControls,
  PlanPane,
  ReviewPane,
  TeamPane,
  openFindings,
  type GoalPane,
} from "./goal-card";
import {
  Errors,
  endedGoal,
  label,
  newCommandId,
  stateTone,
  useCommandRunner,
} from "./shared";

const author = { user: "You", service: "Topsl", coordinator: "Coordinators" };

/**
 * One goal thread: the conversation about a goal, the coordinators' turn for
 * each goal in it, the latest plan's tasks, and a composer whose messages
 * steer that goal (`follow-up` routing).
 */
export function GoalThread({
  projectId,
  conversationId,
}: {
  projectId: string;
  conversationId: string;
}) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [pane, setPane] = useState<GoalPane | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useDraft(`${projectId}:goal:${conversationId}`);
  const reads = useRef(new ScopedReadFence(projectId));
  async function refresh() {
    const ticket = reads.current.begin();
    const value = await window.topsl.command({
      type: "orchestration-query",
      projectId,
      conversationId,
    });
    if (reads.current.accept(ticket, value)) setSnapshot(value);
  }
  const freshness = useScopedRefresh(projectId, refresh);
  const { run, errors } = useCommandRunner(refresh, conversationId);
  const conversation = snapshot?.conversations?.[0];
  const goals: any[] = snapshot?.goals ?? [];
  const latest = goals.at(-1);
  const focused = goals.find((g) => g.goal.id === focus) ?? latest;
  if (snapshot && !conversation)
    return (
      <section aria-label="Coordinator conversation" className="thread">
        <p role="alert">This conversation is no longer recorded.</p>
      </section>
    );
  const title =
    conversation && conversation.title !== DEFAULT_CONVERSATION_TITLE
      ? conversation.title
      : goals.length === 1
        ? threadTitle(goals[0].goal.objective)
        : (conversation?.title ?? "Conversation");
  const openPane = (next: GoalPane | null, goalId?: string) => {
    if (goalId) setFocus(goalId);
    setPane(next);
  };
  async function send() {
    const text = draft.trim();
    if (!text) return;
    const sent = await run("message", {
      type: "orchestration-message",
      conversationId,
      text,
      goalId: null,
      routing: "follow-up",
      kind: latest?.goal.kind ?? "code",
      commandId: newCommandId(),
    });
    if (sent) setDraft("");
  }
  const note = !latest
    ? null
    : endedGoal(latest.goal.state)
      ? "This goal has ended. Your message starts a related goal in this conversation."
      : ["awaiting-acceptance", "checking"].includes(latest.goal.state)
        ? "Sending steers this goal: the coordinators plan again and the new candidate is reviewed again."
        : "Messages steer this goal. Ask a question to get its status.";
  const panes: Array<{ id: GoalPane; title: string; count?: number }> = [
    { id: "team", title: "Team" },
    { id: "plan", title: "Plan" },
    {
      id: "review",
      title: "Review",
      count: focused ? openFindings(focused) : 0,
    },
    { id: "checks", title: "Checks" },
    { id: "changes", title: "Changes" },
  ];
  const paneTitle = panes.find((p) => p.id === pane)?.title ?? "";
  return (
    <section
      aria-label="Coordinator conversation"
      className={`thread ${pane ? "with-pane" : ""}`}
    >
      <header className="thread-header">
        <div className="thread-title">
          <h1>{snapshot ? title : "Loading conversation…"}</h1>
          {latest && (
            <span className={`badge ${stateTone[latest.goal.state] ?? ""}`}>
              {label(latest.goal.state)}
            </span>
          )}
        </div>
        <div className="thread-tools">
          {latest && (
            <GoalControls view={latest} projectId={projectId} run={run} />
          )}
          {latest && (
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
      <div className="thread-layout">
        <div className="thread-main">
          <ol className="transcript" aria-label="Conversation">
            {conversation &&
              threadTimeline(conversation.messages, goals).map((item) =>
                item.kind === "message" ? (
                  <li key={item.key} className={`turn ${item.message.role}`}>
                    <span className="turn-author">
                      {author[item.message.role]}
                    </span>
                    <div className="turn-text">{item.message.text}</div>
                    {item.message.routing &&
                      item.message.role === "user" &&
                      item.message.routing.kind !== "new-goal" && (
                        <span className="muted turn-routing">
                          {label(item.message.routing.kind)}
                        </span>
                      )}
                  </li>
                ) : (
                  <li key={item.key} className="turn-card">
                    <GoalCard
                      view={item.goal}
                      projectId={projectId}
                      run={run}
                      controls={item.goal !== latest}
                      onPane={(next, goalId) => openPane(next, goalId)}
                      onChangeRole={(goalId, roleId) => {
                        setEditing(roleId);
                        openPane("team", goalId);
                      }}
                    />
                  </li>
                ),
              )}
          </ol>
          <div className="thread-footer">
            {latest && (
              <TaskList
                revision={latest.plan?.revision ?? null}
                tasks={planTasks(latest)}
              />
            )}
            <Composer
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              note={note}
              placeholder={
                latest && !endedGoal(latest.goal.state)
                  ? 'For example: "Also keep the public API unchanged." or "Review with Fable and Sol."'
                  : 'For example: "Now add a test for it."'
              }
            />
          </div>
        </div>
        {pane && focused && snapshot && (
          <SidePane title={paneTitle} onClose={() => setPane(null)}>
            {goals.length > 1 && (
              <p className="muted">Goal: {focused.goal.objective}</p>
            )}
            {pane === "team" && (
              <TeamPane
                view={focused}
                snapshot={snapshot}
                projectId={projectId}
                run={run}
                editing={editing}
                onEdit={setEditing}
              />
            )}
            {pane === "plan" && <PlanPane view={focused} />}
            {pane === "review" && <ReviewPane view={focused} run={run} />}
            {pane === "checks" && <ChecksPane view={focused} run={run} />}
            {pane === "changes" && <ChangesPane view={focused} />}
          </SidePane>
        )}
      </div>
    </section>
  );
}
