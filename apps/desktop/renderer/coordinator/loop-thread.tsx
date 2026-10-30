import { useRef, useState } from "react";
import { Freshness } from "../components/freshness";
import { useDraft } from "../state/drafts";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { loopTimeline, queuePositions } from "../state/thread-view";
import type { TopslSession } from "../../../../packages/domain/sessions";
import { Composer, PaneToggles, SidePane } from "./composer";
import {
  BacklogPane,
  CheckpointPane,
  GoalsPane,
  IterationsPane,
  OrganizationPane,
  UsagePane,
  type LoopPane,
} from "./loop-panes";
import {
  Errors,
  label,
  newCommandId,
  stateTone,
  useCommandRunner,
} from "./shared";

const author = { user: "You", service: "Topsl", coordinator: "Coordinators" };

/** Run controls: start once reviewed, then pause or resume, and stop. */
function RunControls({ r, run }: { r: any; run: any }) {
  const ended = r.desiredState === "stopped" || r.state === "stopped";
  const control = (action: "pause" | "resume" | "stop") =>
    void run("control", {
      type: "loop-control",
      runId: r.id,
      action,
      commandId: newCommandId(),
    });
  return (
    <div className="actions" role="group" aria-label="Run controls">
      {!r.started ? (
        <button
          type="button"
          className="primary"
          disabled={ended}
          onClick={() =>
            void run("start", {
              type: "loop-start",
              runId: r.id,
              commandId: newCommandId(),
            })
          }
        >
          Review and start
        </button>
      ) : r.desiredState === "paused" || r.state === "suspended" ? (
        <button
          type="button"
          disabled={ended}
          onClick={() => control("resume")}
        >
          Resume
        </button>
      ) : (
        <button
          type="button"
          disabled={ended || r.state === "completed"}
          onClick={() => control("pause")}
        >
          Pause
        </button>
      )}
      <button
        type="button"
        disabled={ended || r.state === "completed"}
        onClick={() => control("stop")}
      >
        Stop
      </button>
    </div>
  );
}

/**
 * One Goal loop or Endless run as a thread: what the owner wrote and the
 * service's notes, each iteration as the coordinators' turn, what waits on
 * the owner, and a composer that steers the run (`loop-message`). Goals,
 * checkpoint, organization, iterations, backlog and usage open as panes.
 */
export function LoopThread({
  projectId,
  runId,
  onThread,
}: {
  projectId: string;
  runId: string;
  onThread: (threadId: string | null) => void;
}) {
  const [view, setView] = useState<any>(null);
  /** The native session this loop belongs to, if any. */
  const [session, setSession] = useState<TopslSession | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [messages, setMessages] = useState<any[]>([]);
  const [missing, setMissing] = useState(false);
  const [pane, setPane] = useState<LoopPane | null>(null);
  const [draft, setDraft] = useDraft(`${projectId}:loop:${runId}`);
  const reads = useRef(new ScopedReadFence(projectId));
  async function refresh() {
    const ticket = reads.current.begin();
    const query: any = await window.topsl.command({
      type: "loop-query",
      projectId,
    });
    if (!query.runs.some((r: any) => r.id === runId)) {
      if (reads.current.accept(ticket, query)) setMissing(true);
      return;
    }
    const inspected: any = await window.topsl.command({
      type: "loop-inspect",
      runId,
    });
    const [thread, owner]: any[] = await Promise.all([
      window.topsl.command({
        type: "orchestration-query",
        projectId,
        conversationId: inspected.run.conversationId,
      }),
      window.topsl
        .command({
          type: "session-query",
          sessionId: inspected.run.conversationId,
        })
        .catch(() => null),
    ]);
    if (!reads.current.accept(ticket, inspected)) return;
    setEnabled(query.enabled);
    setView(inspected);
    setSession(owner?.session?.origin === "native" ? owner.session : null);
    setMessages(
      (thread.conversations?.[0]?.messages ?? []).filter(
        (m: any) => m.routing?.kind === "loop-steer",
      ),
    );
  }
  const freshness = useScopedRefresh(projectId, refresh);
  const { run, errors } = useCommandRunner(refresh, runId);
  if (missing)
    return (
      <section aria-label="Recursive loop" className="thread">
        <p role="alert">This loop run is no longer recorded.</p>
      </section>
    );
  if (!view)
    return (
      <section aria-label="Recursive loop" className="thread">
        <Freshness state={freshness} retry={freshness.retry} />
        <Errors errors={errors} />
        <p>Loading loop run…</p>
      </section>
    );
  const r = view.run;
  const ended = r.desiredState === "stopped" || r.state === "stopped";
  const blockers = view.goals.filter((g: any) => g.blocker);
  const panes: Array<{ id: LoopPane; title: string; count?: number }> = [
    ...(r.mode === "goal"
      ? [{ id: "goals" as const, title: "Goals", count: blockers.length }]
      : []),
    { id: "checkpoint", title: "Checkpoint" },
    { id: "organization", title: "Organization" },
    { id: "iterations", title: "Iterations" },
    ...(r.mode === "endless"
      ? [
          {
            id: "backlog" as const,
            title: "Backlog",
            count: view.backlog.length,
          },
        ]
      : []),
    { id: "usage", title: "Usage" },
  ];
  async function send() {
    const text = draft.trim();
    if (!text) return;
    const sent = await run("steer", {
      type: "loop-message",
      runId: r.id,
      text,
      commandId: newCommandId(),
    });
    if (sent) setDraft("");
  }
  const current = view.current;
  const item = session?.queue.find((w) => w.runId === r.id);
  const position = session ? queuePositions(session.queue)[item?.id ?? ""] : 0;
  return (
    <section
      aria-label="Recursive loop"
      className={`thread loop-thread ${pane ? "with-pane" : ""}`}
    >
      <article className="loop-run" aria-label={`Loop run ${r.title}`}>
        <header className="thread-header loop-header">
          {session && (
            <button
              type="button"
              className="back-link"
              onClick={() => onThread(`session:${session.id}`)}
            >
              ← Back to session
            </button>
          )}
          <div className="thread-title">
            <h1>{r.title}</h1>
            <span className="badge">
              {r.mode === "goal" ? "Goal loop" : "Endless loop"}
            </span>
            <span className="badge warm">Experimental</span>
            <span className={`badge ${stateTone[r.state] ?? ""}`}>
              {label(r.state)}
            </span>
          </div>
          <div className="thread-tools">
            <RunControls r={r} run={run} />
            <PaneToggles panes={panes} open={pane} onOpen={setPane} />
          </div>
          <p role="status">{r.detail}</p>
          {r.waitReason && (
            <p className="muted">
              {r.waitReason.kind === "no-opportunity"
                ? "Monitoring"
                : r.waitReason.kind === "reconciliation"
                  ? "Reconciliation needed"
                  : label(r.waitReason.kind)}
              : {r.waitReason.detail}
              {r.nextWakeAt
                ? ` Next check: ${new Date(r.nextWakeAt).toLocaleString()}.`
                : ""}
            </p>
          )}
          <p className="muted">{view.labels.release}.</p>
        </header>
        <Freshness state={freshness} retry={freshness.retry} />
        <Errors errors={errors} />
        <div className="thread-layout">
          <div className="thread-main">
            <ol className="transcript" aria-label="Conversation">
              {loopTimeline(
                messages,
                // The current iteration is shown once, as "Now", below.
                [...view.iterations]
                  .reverse()
                  .filter((i: any) => i.id !== current?.iteration.id),
              ).map((item) =>
                item.kind === "message" ? (
                  <li key={item.key} className={`turn ${item.message.role}`}>
                    <span className="turn-author">
                      {author[item.message.role]}
                    </span>
                    <div className="turn-text">{item.message.text}</div>
                  </li>
                ) : (
                  <li key={item.key} className="turn coordinators">
                    <span className="turn-author">Coordinators</span>
                    <div className="turn-text">
                      <span
                        className={`badge ${item.iteration.state === "promoted" ? "good" : item.iteration.state === "rejected" ? "warm" : ""}`}
                      >
                        {label(item.iteration.state)}
                      </span>{" "}
                      Iteration {item.iteration.number}:{" "}
                      {item.iteration.contract?.summary ??
                        item.iteration.detail}
                      {item.iteration.failure && (
                        <span className="muted">
                          {" "}
                          · {item.iteration.failure.kind}:{" "}
                          {item.iteration.failure.detail}
                        </span>
                      )}
                    </div>
                  </li>
                ),
              )}
              {current && (
                <li className="turn coordinators current">
                  <span className="turn-author">Coordinators</span>
                  <div className="turn-text">
                    <strong>Now: iteration {current.iteration.number}</strong> ·{" "}
                    {label(current.iteration.state)} ·{" "}
                    {current.iteration.detail}
                  </div>
                </li>
              )}
              {!r.started && !ended && (
                <li className="turn-card">
                  <section className="decision" aria-label="Start the run">
                    <h3>
                      {session
                        ? `Awaiting start · ${position ? `position ${position} in the session's queue` : "not in the session's queue"}`
                        : "Needs you: review and start"}
                    </h3>
                    <p>
                      Creating did not start any work. Review and start shows
                      what the run will do and records that authority once.
                      {session && position > 1
                        ? " It can start once the work before it in the session finishes or is removed."
                        : ""}
                      {session && session.control === "paused"
                        ? " The session is paused; resume it first."
                        : ""}
                    </p>
                  </section>
                </li>
              )}
              {blockers.length > 0 && (
                <li className="turn-card">
                  <section className="decision" aria-label="Goal questions">
                    <h3>Needs you: the coordinators have a question</h3>
                    <ul>
                      {blockers.map((g: any) => (
                        <li key={g.id}>
                          {g.text}: {g.blocker}
                        </li>
                      ))}
                    </ul>
                    <button type="button" onClick={() => setPane("goals")}>
                      Open goals
                    </button>
                  </section>
                </li>
              )}
              {view.checkpoint &&
                view.checkpoint.sequence > 0 &&
                !view.publication.published && (
                  <li className="turn-card">
                    <section className="decision" aria-label="Ready to publish">
                      <h3>
                        Checkpoint {view.checkpoint.sequence} is accepted, not
                        yet in your folder
                      </h3>
                      <button
                        type="button"
                        onClick={() => setPane("checkpoint")}
                      >
                        Open checkpoint
                      </button>
                    </section>
                  </li>
                )}
            </ol>
            <div className="thread-footer">
              {!enabled && (
                <div className="decision">
                  <p className="muted">
                    Recursive Looping is off, so this run is paused and cannot
                    be steered. Stop stays available.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      void run("feature", {
                        type: "loop-feature-set",
                        enabled: true,
                      })
                    }
                  >
                    Turn on experimental Recursive Looping
                  </button>
                </div>
              )}
              <Composer
                value={draft}
                onChange={setDraft}
                onSend={() => void send()}
                disabled={!enabled || ended}
                note={
                  r.mode === "goal"
                    ? "Add goals, or change the team: “Use five reviewers.” “Do not use provider claude.”"
                    : "Add priorities, or change the team: “Prioritize startup time.” “Always keep an accessibility role.”"
                }
              />
            </div>
          </div>
          {pane && (
            <SidePane
              title={panes.find((p) => p.id === pane)?.title ?? ""}
              onClose={() => setPane(null)}
            >
              {pane === "goals" && <GoalsPane view={view} run={run} />}
              {pane === "checkpoint" && (
                <CheckpointPane view={view} run={run} />
              )}
              {pane === "organization" && (
                <OrganizationPane view={view} run={run} />
              )}
              {pane === "iterations" && <IterationsPane view={view} />}
              {pane === "backlog" && <BacklogPane view={view} />}
              {pane === "usage" && <UsagePane view={view} />}
            </SidePane>
          )}
        </div>
      </article>
    </section>
  );
}
