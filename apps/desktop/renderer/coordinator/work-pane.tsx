import { useState } from "react";
import type {
  SessionWorkItem,
  TopslSession,
} from "../../../../packages/domain/sessions";
import { threadTitle } from "../../../../packages/domain/threads";
import { queuePositions } from "../state/thread-view";
import {
  ChangesPane,
  ChecksPane,
  GoalControls,
  PlanPane,
  ReviewPane,
  openFindings,
} from "./goal-card";
import {
  CheckFields,
  checksFrom,
  emptyCheck,
  label,
  newCommandId,
  stateTone,
  type CheckDraft,
  type Run,
} from "./shared";

/**
 * A session's Work (docs/UX_Cleanup_Plan.md §1): the work running now with
 * its controls and plan, the queue with each loop draft's place in it, the
 * work already settled, and Create loop.
 */
export function WorkPane({
  session,
  goals,
  focused,
  onFocus,
  run,
  projectId,
  loopsEnabled,
  onThread,
}: {
  session: TopslSession;
  goals: any[];
  /** The goal whose plan shows; the running one unless the owner chose another. */
  focused: any | null;
  onFocus: (goalId: string) => void;
  run: Run;
  projectId: string;
  loopsEnabled: boolean;
  onThread: (threadId: string) => void;
}) {
  const queue = (action: "remove" | "up" | "down", workItemId: string) =>
    void run(`queue-${workItemId}`, {
      type: "session-queue",
      sessionId: session.id,
      workItemId,
      action,
      commandId: newCommandId(),
    });
  const goalOf = (id: string | null) => goals.find((g) => g.goal.id === id);
  const positions = queuePositions(session.queue);
  const active = session.queue.find((w) => w.id === session.activeWorkId);
  const waiting = session.queue.filter((w) => positions[w.id]);
  const settled = session.queue.filter(
    (w) => w.id !== active?.id && !positions[w.id] && w.state !== "running",
  );
  const item = (w: SessionWorkItem) => {
    const view = goalOf(w.goalId);
    return (
      <>
        <strong>
          {w.kind === "loop" ? "Loop: " : ""}
          {threadTitle(w.objective, 120)}
        </strong>{" "}
        <span
          className={`badge ${stateTone[view?.goal.state ?? w.state] ?? ""}`}
        >
          {label(view?.goal.state ?? w.state)}
        </span>
        {session.acceptedCheckpoint?.workItemId === w.id && (
          <span className="badge good">Latest accepted result</span>
        )}
      </>
    );
  };
  return (
    <div className="pane-section work-pane">
      <section aria-label="Running now">
        <h3>Now</h3>
        {active ? (
          <div className="work-item running">
            {item(active)}
            {active.detail && <div className="muted tiny">{active.detail}</div>}
            {active.kind === "goal" && goalOf(active.goalId) && (
              <GoalControls
                view={goalOf(active.goalId)}
                projectId={projectId}
                run={run}
              />
            )}
            {active.kind === "loop" && active.runId && (
              <button
                type="button"
                onClick={() => onThread(`loop:${active.runId}`)}
              >
                Open loop
              </button>
            )}
          </div>
        ) : (
          <p className="muted">
            {session.control === "paused"
              ? "Paused. Resume the session to continue its work."
              : waiting.length
                ? "Nothing is running."
                : "Nothing is running. Discussion alone starts no work."}
          </p>
        )}
      </section>
      {focused && (
        <section aria-label="Plan">
          <h3>
            Plan
            {goals.length > 1 && (
              <>
                {" "}
                for{" "}
                <select
                  aria-label="Goal"
                  value={focused.goal.id}
                  onChange={(e) => onFocus(e.target.value)}
                >
                  {goals.map((g) => (
                    <option key={g.goal.id} value={g.goal.id}>
                      {threadTitle(g.goal.objective, 50)}
                    </option>
                  ))}
                </select>
              </>
            )}
          </h3>
          {focused.goal.id !== active?.goalId && (
            <GoalControls view={focused} projectId={projectId} run={run} />
          )}
          <PlanPane view={focused} />
        </section>
      )}
      <section aria-label="Queue">
        <h3>Queue</h3>
        {!waiting.length ? (
          <p className="muted">Nothing waiting.</p>
        ) : (
          <ol className="work-queue">
            {waiting.map((w, index) => (
              <li key={w.id} className={`work-item ${w.state}`}>
                {item(w)}
                {w.kind === "loop" && (
                  <div className="muted tiny">
                    Awaiting start · {ordinal(positions[w.id])} in the queue
                    {positions[w.id] === 1 && !active
                      ? ". Review and start it to begin."
                      : ". It can start when the work before it finishes."}
                  </div>
                )}
                {w.detail && <div className="muted tiny">{w.detail}</div>}
                <div className="actions">
                  {w.kind === "loop" && w.runId && (
                    <button
                      type="button"
                      onClick={() => onThread(`loop:${w.runId}`)}
                    >
                      {positions[w.id] === 1 && !active
                        ? "Review and start…"
                        : "Open loop"}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Move up: ${w.objective}`}
                    disabled={index === 0}
                    onClick={() => queue("up", w.id)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    aria-label={`Move down: ${w.objective}`}
                    disabled={index === waiting.length - 1}
                    onClick={() => queue("down", w.id)}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove from queue: ${w.objective}`}
                    onClick={() => queue("remove", w.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="muted tiny">
          One goal or loop runs at a time. New work continues from the latest
          accepted result
          {session.acceptedCheckpoint ? "" : " (none yet: the project folder)"}.
        </p>
      </section>
      {settled.length > 0 && (
        <section aria-label="History">
          <h3>History</h3>
          <ol className="work-queue">
            {[...settled].reverse().map((w) => (
              <li key={w.id} className={`work-item ${w.state}`}>
                {item(w)}
                <div className="actions">
                  {w.goalId && goalOf(w.goalId) && (
                    <button type="button" onClick={() => onFocus(w.goalId!)}>
                      Show plan
                    </button>
                  )}
                  {w.kind === "loop" && w.runId && (
                    <button
                      type="button"
                      onClick={() => onThread(`loop:${w.runId}`)}
                    >
                      Open loop
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      <CreateLoop
        session={session}
        projectId={projectId}
        run={run}
        enabled={loopsEnabled}
        onThread={onThread}
      />
    </div>
  );
}

const ordinal = (n: number) =>
  n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `number ${n}`;

/**
 * Work → Create loop: a Goal or Endless loop in this session, created as a
 * draft at the end of its queue. Creating starts nothing; the loop is
 * reviewed and started from its own page when its turn comes.
 */
function CreateLoop({
  session,
  projectId,
  run,
  enabled,
  onThread,
}: {
  session: TopslSession;
  projectId: string;
  run: Run;
  enabled: boolean;
  onThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"goal" | "endless">("goal");
  const [text, setText] = useState("");
  const [check, setCheck] = useState<CheckDraft>(emptyCheck);
  const [automaticChecks, setAutomaticChecks] = useState(false);
  const [reserve, setReserve] = useState(1);
  const [allowance, setAllowance] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  return (
    <section aria-label="Create loop" className="create-loop">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          className="disclosure"
          onClick={() => setOpen(!open)}
        >
          Create loop
        </button>{" "}
        <span className="badge warm">Experimental</span>
      </h3>
      {created && (
        <p role="status">
          Loop created and queued. Nothing has started.{" "}
          <button type="button" onClick={() => onThread(`loop:${created}`)}>
            Open loop
          </button>
        </p>
      )}
      {open &&
        (!enabled ? (
          <div className="decision">
            <p className="muted">
              Recursive Looping is experimental and off. It is fixture-tested,
              not qualified against live providers.
            </p>
            <button
              type="button"
              onClick={() =>
                void run("feature", { type: "loop-feature-set", enabled: true })
              }
            >
              Turn on experimental Recursive Looping
            </button>
          </div>
        ) : (
          <form
            className="workflow-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const checks = checksFrom(check).map((c) => ({
                ...c,
                id: "loop-check-1",
              }));
              const result = await run("create-loop", {
                type: "loop-create",
                projectId,
                conversationId: session.id,
                mode,
                text: text.trim(),
                policy: {
                  checks,
                  automaticChecks: automaticChecks && checks.length > 0,
                  scheduling: { reserveForDirectWork: reserve },
                  ...(allowance.trim() && Number(allowance) > 0
                    ? {
                        allowances: {
                          runMemberTurns: Number(allowance),
                          rolling: null,
                        },
                      }
                    : {}),
                },
                commandId: newCommandId(),
              });
              if (result?.run?.id) {
                setCreated(result.run.id);
                setText("");
                setOpen(false);
              }
            }}
          >
            <fieldset className="segmented" aria-label="Loop kind">
              {(
                [
                  ["goal", "Goal loop"],
                  ["endless", "Endless"],
                ] as const
              ).map(([value, title]) => (
                <label key={value} className={mode === value ? "selected" : ""}>
                  <input
                    type="radio"
                    name={`loop-mode-${session.id}`}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {title}
                </label>
              ))}
            </fieldset>
            <p className="muted tiny">
              {mode === "goal"
                ? "Keeps assessing, delegating and repairing until every required goal is met on one accepted checkpoint."
                : "Keeps finding and verifying worthwhile improvements until you stop it."}{" "}
              It starts from the session's latest accepted result.
            </p>
            <label>
              {mode === "goal" ? "Goals, one per line" : "Priorities"}
              <textarea
                rows={3}
                value={text}
                required={mode === "goal"}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <details>
              <summary>Options</summary>
              <fieldset>
                <legend>Required check (optional)</legend>
                <p className="muted">
                  The run's protected regression protocol: candidates cannot
                  weaken its tests or scripts.
                </p>
                <CheckFields draft={check} setDraft={setCheck} />
                <label>
                  <input
                    type="checkbox"
                    checked={automaticChecks}
                    onChange={(e) => setAutomaticChecks(e.target.checked)}
                  />
                  Run it automatically on each candidate, on this computer with
                  my permissions (not a sandbox)
                </label>
              </fieldset>
              <label>
                Slots kept free for my direct work{" "}
                <input
                  type="number"
                  min={0}
                  max={64}
                  value={reserve}
                  onChange={(e) => setReserve(Number(e.target.value))}
                />
              </label>
              <label>
                Run allowance in member turns (blank: none){" "}
                <input
                  type="number"
                  min={1}
                  value={allowance}
                  onChange={(e) => setAllowance(e.target.value)}
                />
              </label>
            </details>
            <button type="submit" disabled={mode === "goal" && !text.trim()}>
              Create loop
            </button>
          </form>
        ))}
    </section>
  );
}

export type ResultsTab = "review" | "checks" | "changes";

/** A session's Results: review findings, required checks and changes of one goal. */
export function ResultsPane({
  goals,
  focused,
  onFocus,
  tab,
  onTab,
  run,
}: {
  goals: any[];
  focused: any | null;
  onFocus: (goalId: string) => void;
  tab: ResultsTab;
  onTab: (tab: ResultsTab) => void;
  run: Run;
}) {
  if (!focused)
    return <p className="muted">No goal has produced results yet.</p>;
  return (
    <div className="pane-section results-pane">
      {goals.length > 1 && (
        <label>
          Goal{" "}
          <select
            value={focused.goal.id}
            onChange={(e) => onFocus(e.target.value)}
          >
            {goals.map((g) => (
              <option key={g.goal.id} value={g.goal.id}>
                {threadTitle(g.goal.objective, 50)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="segmented sections" role="tablist" aria-label="Results">
        {(
          [
            ["review", "Review"],
            ["checks", "Checks"],
            ["changes", "Changes"],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "selected" : ""}
            onClick={() => onTab(id)}
          >
            {title}
            {id === "review" && openFindings(focused) > 0 && (
              <span className="count">{openFindings(focused)}</span>
            )}
          </button>
        ))}
      </div>
      {tab === "review" && <ReviewPane view={focused} run={run} />}
      {tab === "checks" && <ChecksPane view={focused} run={run} />}
      {tab === "changes" && <ChangesPane view={focused} />}
    </div>
  );
}
