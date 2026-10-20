import { useEffect, useRef, useState } from "react";
import type { Command } from "../../../../packages/domain/commands";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { Freshness } from "./freshness";
import { CoordinatorTeams } from "./coordinator-teams";

/**
 * Recursive Looping (docs/Recursive_Looping.md): the Coordinator section's run
 * mode selector, plus the experimental Goal loop and Endless views. The views
 * answer, in order: what the run is doing now, which goals are met, which
 * checkpoint is accepted, which roles and models are active (and which are
 * Auto or yours), why the organization changed, what the latest iteration did,
 * whether the run is working, waiting, monitoring, paused or stopping, and
 * what usage is known. Detail is in expandable sections.
 */

const newCommandId = () => `ui-${crypto.randomUUID()}`;
const label = (v: string) =>
  v
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/^./, (c) => c.toUpperCase());

type Mode = "single" | "goal" | "endless";

export function CoordinatorModes({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<Mode>("single");
  return (
    <div className="coordinator-modes">
      <fieldset className="mode-selector" aria-label="Run mode">
        <legend>Run mode</legend>
        {(
          [
            ["single", "Single goal", false],
            ["goal", "Goal loop", true],
            ["endless", "Endless", true],
          ] as const
        ).map(([value, text, experimental]) => (
          <label key={value} className={mode === value ? "selected" : ""}>
            <input
              type="radio"
              name="coordinator-run-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {text}
            {experimental && <span className="badge warm">Experimental</span>}
          </label>
        ))}
      </fieldset>
      {mode === "single" ? (
        <CoordinatorTeams projectId={projectId} />
      ) : (
        <RecursiveLoop projectId={projectId} mode={mode} />
      )}
    </div>
  );
}

interface CheckDraft {
  label: string;
  executable: string;
  args: string;
}

export function RecursiveLoop({
  projectId,
  mode,
}: {
  projectId: string;
  mode: "goal" | "endless";
}) {
  const [query, setQuery] = useState<any>(null),
    [runId, setShownRun] = useState<string | null>(null),
    [view, setView] = useState<any>(null),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [text, setText] = useState(""),
    [check, setCheck] = useState<CheckDraft>({
      label: "",
      executable: "",
      args: "",
    }),
    [automaticChecks, setAutomaticChecks] = useState(false),
    [reserve, setReserve] = useState(1),
    [allowance, setAllowance] = useState(""),
    [steer, setSteer] = useState(""),
    [newGoal, setNewGoal] = useState(""),
    [lockCounts, setLockCounts] = useState<Record<string, string>>({});
  const generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId)),
    // The run the owner chose, read by refresh() at once. A refresh started
    // right after choosing still holds the previous render, so reading the
    // state there re-read the run chosen before and showed it until the
    // project's next change.
    chosenRun = useRef<string | null>(null);
  const setRunId = (id: string | null) => {
    chosenRun.current = id;
    setShownRun(id);
  };
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    setQuery(null);
    setView(null);
    setRunId(null);
    setErrors({});
  }, [projectId]);
  async function refresh() {
    const ticket = reads.current.begin();
    const value: any = await window.topsl.command({
      type: "loop-query",
      projectId,
    });
    if (!reads.current.accept(ticket, value)) return;
    setQuery(value);
    const runs = (value.runs ?? []).filter((r: any) => r.mode === mode);
    const chosen = chosenRun.current;
    const selected =
      chosen && runs.some((r: any) => r.id === chosen)
        ? chosen
        : (runs[0]?.id ?? null);
    if (selected !== chosen) setRunId(selected);
    if (selected) {
      const inspected = await window.topsl.command({
        type: "loop-inspect",
        runId: selected,
      });
      // A slower read of a run chosen earlier never replaces the chosen one.
      if (
        chosenRun.current === selected &&
        reads.current.accept(ticket, inspected)
      )
        setView(inspected);
    } else setView(null);
  }
  const freshness = useScopedRefresh(projectId, refresh);
  // The loop query holds the project's runs of both modes, so switching
  // between Goal loop and Endless keeps it on screen and only selects a run
  // of the new mode. That is read now: the project's subscription reads only
  // after its next change, and clearing the runs here once left the view on
  // "Loading loop runs…" until one arrived.
  const shownMode = useRef(mode);
  useEffect(() => {
    if (shownMode.current === mode) return;
    shownMode.current = mode;
    generation.current++;
    reads.current.reset(projectId);
    setView(null);
    setRunId(null);
    setErrors({});
    freshness.reload();
  }, [mode]);
  async function run(key: string, command: Command) {
    const ticket = generation.current;
    setErrors((current) => ({ ...current, [key]: "" }));
    try {
      const result = await window.topsl.command(command);
      if (ticket === generation.current) await refresh();
      return result;
    } catch (error: any) {
      if (ticket === generation.current)
        setErrors((current) => ({ ...current, [key]: error.message }));
    }
  }
  async function create() {
    const checks = check.executable.trim()
      ? [
          {
            id: "loop-check-1",
            label: check.label.trim() || "Required check",
            executable: check.executable.trim(),
            args: check.args.trim() ? check.args.trim().split(/\s+/) : [],
            timeoutMs: 120_000,
          },
        ]
      : [];
    const created: any = await run("create", {
      type: "loop-create",
      projectId,
      conversationId: null,
      mode,
      text,
      policy: {
        checks,
        automaticChecks: automaticChecks && checks.length > 0,
        scheduling: { reserveForDirectWork: reserve },
        ...(allowance.trim() && Number(allowance) > 0
          ? { allowances: { runMemberTurns: Number(allowance), rolling: null } }
          : {}),
      },
      commandId: newCommandId(),
    });
    if (created?.run?.id) {
      setRunId(created.run.id);
      setText("");
      await refresh();
    }
  }
  if (!query)
    return (
      <section aria-label="Recursive loop">
        <Freshness state={freshness} retry={freshness.retry} />
        <p>Loading loop runs…</p>
      </section>
    );
  if (!query.enabled)
    return (
      <section aria-label="Recursive loop">
        <h2>
          {mode === "goal" ? "Goal loop" : "Endless"}{" "}
          <span className="badge warm">Experimental</span>
        </h2>
        <p className="muted">
          Recursive Looping is experimental and off. A loop repeatedly assesses
          the project, organizes a team of any size, delegates and verifies
          work, and promotes accepted results into an internal checkpoint. It is
          implemented and fixture-tested; it is not qualified against live
          providers.
        </p>
        <button
          type="button"
          onClick={() =>
            void run("feature", { type: "loop-feature-set", enabled: true })
          }
        >
          Turn on experimental Recursive Looping
        </button>
        <StoppableRuns
          runs={(query.runs ?? []).filter(
            (r: any) =>
              r.mode === mode && !["completed", "stopped"].includes(r.state),
          )}
          run={run}
        />
        <Errors errors={errors} />
      </section>
    );
  const runs = (query.runs ?? []).filter((r: any) => r.mode === mode);
  return (
    <section aria-label="Recursive loop" className="recursive-loop">
      <Freshness state={freshness} retry={freshness.retry} />
      <Errors errors={errors} />
      {runs.length > 0 && (
        <label className="run-picker">
          Run{" "}
          <select
            value={runId ?? ""}
            onChange={(e) => {
              setRunId(e.target.value);
              void refresh();
            }}
          >
            {runs.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.title} · {label(r.state)}
              </option>
            ))}
          </select>
        </label>
      )}
      <details open={!runs.length} className="loop-new">
        <summary>
          {mode === "goal" ? "New Goal loop" : "New Endless loop"}
        </summary>
        <label>
          {mode === "goal" ? "Goals" : "What to improve, and priorities"}{" "}
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === "goal"
                ? "For example: Make project synchronization reliable, add the missing coordinator controls, and ensure restart preserves the selected model teams."
                : "For example: Keep improving Topsl. Prioritize reliability, synchronization and clarity of the interface."
            }
          />
        </label>
        <details>
          <summary>Required check (optional)</summary>
          <p className="muted">
            The check is the run's protected regression protocol: candidates
            cannot weaken its tests or scripts.
          </p>
          <label>
            Label{" "}
            <input
              value={check.label}
              onChange={(e) => setCheck({ ...check, label: e.target.value })}
            />
          </label>
          <label>
            Executable (absolute path){" "}
            <input
              value={check.executable}
              onChange={(e) =>
                setCheck({ ...check, executable: e.target.value })
              }
            />
          </label>
          <label>
            Arguments{" "}
            <input
              value={check.args}
              onChange={(e) => setCheck({ ...check, args: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={automaticChecks}
              onChange={(e) => setAutomaticChecks(e.target.checked)}
            />
            Run it automatically on each candidate, on this computer with my
            permissions (not a sandbox)
          </label>
        </details>
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
        <button
          type="button"
          disabled={mode === "goal" && !text.trim()}
          onClick={() => void create()}
        >
          Create run
        </button>
        <p className="muted">
          Creating does not start work. Starting shows what the run will do and
          records that authority once.
        </p>
      </details>
      {view?.run.mode === mode && (
        <RunView
          view={view}
          run={run}
          steer={steer}
          setSteer={setSteer}
          newGoal={newGoal}
          setNewGoal={setNewGoal}
          lockCounts={lockCounts}
          setLockCounts={setLockCounts}
        />
      )}
    </section>
  );
}

/**
 * With the feature off, runs that have not stopped are paused and stay
 * listed here so Stop never disappears behind the flag.
 */
function StoppableRuns({
  runs,
  run,
}: {
  runs: any[];
  run: (key: string, command: Command) => Promise<unknown>;
}) {
  if (!runs.length) return null;
  return (
    <section aria-label="Existing runs">
      <h3>Existing runs</h3>
      <p className="muted">
        Runs that have not stopped are paused while Recursive Looping is off.
        Stop ends a run; turn the feature on to resume one.
      </p>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            {r.title} · {label(r.state)}{" "}
            <button
              type="button"
              aria-label={`Stop ${r.title}`}
              disabled={r.desiredState === "stopped"}
              onClick={() =>
                void run("control", {
                  type: "loop-control",
                  runId: r.id,
                  action: "stop",
                  commandId: newCommandId(),
                })
              }
            >
              Stop
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Errors({ errors }: { errors: Record<string, string> }) {
  return (
    <>
      {Object.entries(errors)
        .filter(([, e]) => e)
        .map(([k, e]) => (
          <p key={k} role="alert">
            {e}
          </p>
        ))}
    </>
  );
}

const stateTone: Record<string, string> = {
  active: "good",
  completed: "good",
  monitoring: "",
  waiting: "warm",
  paused: "warm",
  suspended: "warm",
  stopping: "warm",
  stopped: "",
};

function RunView({
  view,
  run,
  steer,
  setSteer,
  newGoal,
  setNewGoal,
  lockCounts,
  setLockCounts,
}: {
  view: any;
  run: (key: string, command: Command) => Promise<any>;
  steer: string;
  setSteer: (v: string) => void;
  newGoal: string;
  setNewGoal: (v: string) => void;
  lockCounts: Record<string, string>;
  setLockCounts: (v: Record<string, string>) => void;
}) {
  const r = view.run;
  const ended = r.desiredState === "stopped" || r.state === "stopped";
  const current = view.current;
  return (
    <article className="loop-run" aria-label={`Loop run ${r.title}`}>
      <header className="loop-header">
        <h2>
          {r.title} <span className="badge warm">Experimental</span>{" "}
          <span className={`badge ${stateTone[r.state] ?? ""}`}>
            {label(r.state)}
          </span>
        </h2>
        <div className="actions" role="group" aria-label="Run controls">
          {!r.started ? (
            <button
              type="button"
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
              onClick={() =>
                void run("control", {
                  type: "loop-control",
                  runId: r.id,
                  action: "resume",
                  commandId: newCommandId(),
                })
              }
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              disabled={ended || r.state === "completed"}
              onClick={() =>
                void run("control", {
                  type: "loop-control",
                  runId: r.id,
                  action: "pause",
                  commandId: newCommandId(),
                })
              }
            >
              Pause
            </button>
          )}
          <button
            type="button"
            disabled={ended || r.state === "completed"}
            onClick={() =>
              void run("control", {
                type: "loop-control",
                runId: r.id,
                action: "stop",
                commandId: newCommandId(),
              })
            }
          >
            Stop
          </button>
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

      {r.mode === "goal" && (
        <section aria-label="Goals">
          <h3>Goals</h3>
          <ol className="goal-ledger">
            {view.goals.map((g: any) => (
              <li key={g.id}>
                <span
                  className={`badge ${g.status === "satisfied" ? "good" : g.status === "regressed" || g.status === "blocked" ? "warm" : ""}`}
                >
                  {label(g.status)}
                </span>{" "}
                <strong>{g.text}</strong>
                {!g.required && <span className="muted"> · optional</span>}
                <span className="muted"> · priority {g.priority}</span>
                {g.blocker && <p role="note">Needs you: {g.blocker}</p>}
                {g.conflict && <p className="muted">{g.conflict}</p>}
                {g.regression && g.status === "regressed" && (
                  <p className="muted">
                    Regressed by iteration{" "}
                    {String(g.regression.iterationId).split(":").at(-1)}; repair
                    is scheduled.
                  </p>
                )}
                <details>
                  <summary>
                    {g.criteria.length} acceptance{" "}
                    {g.criteria.length === 1 ? "criterion" : "criteria"}
                    {g.assessment ? ` · ${g.assessment.detail}` : ""}
                  </summary>
                  <ul>
                    {g.criteria.map((c: any) => {
                      const a = g.assessment?.criteria.find(
                        (x: any) => x.criterionId === c.id,
                      );
                      return (
                        <li key={c.id}>
                          {c.text}{" "}
                          <span className="muted">
                            ({c.verification.kind},{" "}
                            {c.provenance === "user"
                              ? "yours"
                              : "from the coordinators"}
                            )
                          </span>
                          {a && (
                            <span className="muted">
                              {" "}
                              · {a.result}
                              {a.validation === "missing-evidence"
                                ? ", evidence missing"
                                : ""}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() =>
                        void run(`goal-${g.id}`, {
                          type: "loop-goals-update",
                          runId: r.id,
                          edit: [{ goalId: g.id, required: !g.required }],
                          commandId: newCommandId(),
                        })
                      }
                      disabled={g.status === "cancelled_by_user"}
                    >
                      Make {g.required ? "optional" : "required"}
                    </button>
                    {g.blocker && (
                      <button
                        type="button"
                        onClick={() =>
                          void run(`goal-${g.id}`, {
                            type: "loop-goals-update",
                            runId: r.id,
                            edit: [{ goalId: g.id, clearBlocker: true }],
                            commandId: newCommandId(),
                          })
                        }
                      >
                        Mark answered
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void run(`goal-${g.id}`, {
                          type: "loop-goals-update",
                          runId: r.id,
                          remove: [g.id],
                          commandId: newCommandId(),
                        })
                      }
                      disabled={g.status === "cancelled_by_user"}
                    >
                      Remove goal
                    </button>
                  </div>
                </details>
              </li>
            ))}
          </ol>
          <label>
            Add a goal{" "}
            <input
              value={newGoal}
              onChange={(e) => setNewGoal(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!newGoal.trim()}
            onClick={() => {
              void run("add-goal", {
                type: "loop-goals-update",
                runId: r.id,
                add: [{ text: newGoal }],
                commandId: newCommandId(),
              });
              setNewGoal("");
            }}
          >
            Add goal
          </button>
          {view.completion &&
            !view.completion.complete &&
            r.state !== "completed" && (
              <p className="muted">
                Not complete yet:{" "}
                {view.completion.missing.slice(0, 3).join("; ")}.
              </p>
            )}
        </section>
      )}

      <section aria-label="Accepted checkpoint">
        <h3>
          Accepted checkpoint {view.checkpoint ? view.checkpoint.sequence : "—"}
        </h3>
        {view.checkpoint && (
          <>
            <p className="muted">
              {view.checkpoint.sequence === 0
                ? "The run's starting content. Nothing has been accepted yet."
                : `${view.checkpoint.changedSinceBase.length} ${view.checkpoint.changedSinceBase.length === 1 ? "file differs" : "files differ"} from the folder the run started from. Promoted automatically by loop policy; not yet in your folder unless published.`}
            </p>
            {view.checkpoint.changedSinceBase.length > 0 && (
              <details>
                <summary>Accumulated changes</summary>
                <ul>
                  {view.checkpoint.changedSinceBase.map((f: any) => (
                    <li key={f.path}>
                      {f.change}: {f.path}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={
                  view.checkpoint.sequence === 0 || view.publication.published
                }
                onClick={() =>
                  void run("publish", {
                    type: "loop-publication-apply",
                    runId: r.id,
                    commandId: newCommandId(),
                  })
                }
              >
                Publish to folder…
              </button>
              <button
                type="button"
                onClick={() =>
                  void run("export", {
                    type: "loop-checkpoint-export",
                    runId: r.id,
                    checkpointId: null,
                  }).then((x: any) => x?.path && alert(`Exported to ${x.path}`))
                }
              >
                Export copy
              </button>
              {view.publication.cursor && (
                <button
                  type="button"
                  onClick={() =>
                    void run("reconcile", {
                      type: "loop-publication-reconcile",
                      runId: r.id,
                      commandId: newCommandId(),
                    })
                  }
                >
                  I committed the published files
                </button>
              )}
            </div>
            {view.publication.cursor && (
              <p className="muted">
                Last published: checkpoint{" "}
                {String(view.publication.cursor.lastPublishedCheckpointId)
                  .split(":")
                  .at(-1)}{" "}
                ({view.publication.cursor.state}).
              </p>
            )}
          </>
        )}
        {r.setupConditions?.length > 0 && (
          <details>
            <summary>Capture conditions</summary>
            <ul>
              {r.setupConditions.map((c: string) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section aria-label="Organization">
        <h3>Organization</h3>
        <p className="muted">
          Fields marked “yours” are locked by you and never change
          automatically; everything else is Auto.
          {view.topology
            ? ` Revision ${view.topology.revision}: ${view.topology.reason}`
            : ""}
        </p>
        <ul className="loop-roles">
          {view.organization.map((role: any) => (
            <li key={role.roleId} className={role.active ? "" : "muted"}>
              <strong>{role.title}</strong>{" "}
              <span className="muted">
                ({role.roleId}; {role.active ? "active" : "retired"}
                {role.functions.length ? `; ${role.functions.join(", ")}` : ""})
              </span>
              <div>
                {role.members.length ? (
                  role.members.map((m: any) => (
                    <span key={m.memberId} className="badge">
                      {m.model ?? "unresolved"}{" "}
                      {m.pinned ? "· yours" : "· Auto"}
                    </span>
                  ))
                ) : (
                  <span className="muted">
                    Members resolve when the next iteration starts.
                  </span>
                )}
              </div>
              {role.locked.length > 0 && (
                <p className="muted">Yours: {role.locked.join(", ")}</p>
              )}
              {role.active && (
                <div className="actions">
                  <label>
                    Members{" "}
                    <input
                      type="number"
                      min={1}
                      max={64}
                      aria-label={`Member count for ${role.title}`}
                      value={lockCounts[role.roleId] ?? ""}
                      onChange={(e) =>
                        setLockCounts({
                          ...lockCounts,
                          [role.roleId]: e.target.value,
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!(Number(lockCounts[role.roleId]) > 0)}
                    onClick={() =>
                      void run(`lock-${role.roleId}`, {
                        type: "loop-override-set",
                        runId: r.id,
                        kind: "role-settings",
                        roleId: role.roleId,
                        settings: { count: Number(lockCounts[role.roleId]) },
                        value: null,
                        commandId: newCommandId(),
                      })
                    }
                  >
                    Lock count
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void run(`freeze-${role.roleId}`, {
                        type: "loop-override-set",
                        runId: r.id,
                        kind: "role-frozen",
                        roleId: role.roleId,
                        settings: null,
                        value: null,
                        commandId: newCommandId(),
                      })
                    }
                  >
                    Keep this team
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {view.overrides.length > 0 && (
          <details>
            <summary>Your overrides ({view.overrides.length})</summary>
            <ul>
              {view.overrides.map((o: any) => (
                <li key={o.id}>
                  {label(o.kind)}
                  {o.roleId ? ` for ${o.roleId}` : ""}
                  {o.value !== null ? `: ${o.value}` : ""}{" "}
                  <span className="muted">
                    · from {o.source} · effective{" "}
                    {o.effectiveBoundary === "immediate"
                      ? "immediately"
                      : "at the next iteration"}
                  </span>{" "}
                  <button
                    type="button"
                    onClick={() =>
                      void run(`release-${o.id}`, {
                        type: "loop-override-release",
                        runId: r.id,
                        overrideId: o.id,
                        commandId: newCommandId(),
                      })
                    }
                  >
                    Return to Auto
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <details>
          <summary>
            Why the organization changed ({view.adaptations.length})
          </summary>
          <ol>
            {view.adaptations.map((a: any) => (
              <li key={a.id}>
                <strong>{label(a.kind)}</strong> at iteration{" "}
                {a.boundaryIteration} by{" "}
                {a.actor === "loop-policy" ? "loop policy" : a.actor}:{" "}
                {a.reason}
                {a.rejections.length > 0 && (
                  <p className="muted">Not applied: {a.rejections.join(" ")}</p>
                )}
                {a.dissent.length > 0 && (
                  <p className="muted">
                    Dissent:{" "}
                    {a.dissent
                      .map((d: any) => `${d.memberId}: ${d.rationale}`)
                      .join("; ")}
                  </p>
                )}
                <span className="muted">
                  {" "}
                  Evidence: {a.evidence.outcomes} outcomes (
                  {a.evidence.confidence} confidence).
                </span>
              </li>
            ))}
          </ol>
        </details>
      </section>

      <section aria-label="Iterations">
        <h3>Iterations</h3>
        {current && (
          <div className="loop-current">
            <p>
              <strong>Iteration {current.iteration.number}</strong> ·{" "}
              {label(current.iteration.state)} · {current.iteration.detail}
            </p>
            {current.rounds
              .filter((x: any) =>
                ["collecting", "endorsing", "blocked"].includes(x.state),
              )
              .map((x: any) => (
                <p key={x.id} className="muted">
                  {label(x.stage)} decision ({x.roleId}):{" "}
                  {x.members
                    .map((m: any) => `${m.memberId} (${m.model}) ${m.state}`)
                    .join(", ")}
                </p>
              ))}
            {current.goal && (
              <details>
                <summary>
                  Work in this iteration: {current.goal.goal.detail}
                </summary>
                <ul>
                  {current.goal.rounds.map((x: any) => (
                    <li key={x.id}>
                      {label(x.kind)}
                      {x.taskKey ? ` ${x.taskKey}` : ""} · {x.progress}
                      <ul>
                        {x.members.map((m: any) => (
                          <li key={m.memberId} className="muted">
                            {m.memberId}: {m.modelLabel ?? m.requestedModel} ·{" "}
                            {m.state}
                            {m.effectiveModel &&
                            m.effectiveModel !== m.requestedModel
                              ? ` · reported ${m.effectiveModel}`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <ol reversed className="loop-timeline">
          {view.iterations.map((it: any) => (
            <li key={it.id}>
              <span
                className={`badge ${it.state === "promoted" ? "good" : it.state === "rejected" ? "warm" : ""}`}
              >
                {label(it.state)}
              </span>{" "}
              #{it.number} {it.contract?.summary ?? it.detail}
              {it.failure && (
                <span className="muted">
                  {" "}
                  · {it.failure.kind}: {it.failure.detail}
                </span>
              )}
              <span className="muted">
                {" "}
                · {it.memberTurns} member turns
                {it.repairs ? ` · ${it.repairs} repairs` : ""}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {r.mode === "endless" && view.backlog.length > 0 && (
        <details>
          <summary>Improvement backlog ({view.backlog.length})</summary>
          <ul>
            {view.backlog.map((o: any) => (
              <li key={o.id}>
                <span className="badge">{label(o.state)}</span> {o.title}{" "}
                <span className="muted">
                  · score {o.priorityScore.toFixed(2)} · {o.expectedBenefit}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section aria-label="Usage">
        <h3>Usage</h3>
        <p className="muted">
          {view.usage.memberTurns} member{" "}
          {view.usage.memberTurns === 1 ? "turn" : "turns"} ·{" "}
          {view.usage.iterations}{" "}
          {view.usage.iterations === 1 ? "iteration" : "iterations"} (
          {view.usage.promoted} promoted, {view.usage.rejected} rejected) ·{" "}
          {view.usage.tokens.input === null
            ? "token counts not reported (unknown, not zero)"
            : `${view.usage.tokens.input} input / ${view.usage.tokens.output} output tokens known`}
          {view.usage.tokens.totalAttempts > 0 &&
            ` · reported for ${view.usage.tokens.coveredAttempts} of ${view.usage.tokens.totalAttempts} executions`}
        </p>
      </section>

      <section aria-label="Steer the run">
        <label>
          Steer{" "}
          <textarea
            rows={2}
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            placeholder={
              r.mode === "goal"
                ? 'Add a goal, or for example: "Use five reviewers." "Do not use provider claude."'
                : 'For example: "Prioritize startup time." "Always keep an accessibility role."'
            }
          />
        </label>
        <button
          type="button"
          disabled={!steer.trim() || ended}
          onClick={() => {
            void run("steer", {
              type: "loop-message",
              runId: r.id,
              text: steer,
              commandId: newCommandId(),
            });
            setSteer("");
          }}
        >
          Send
        </button>
      </section>
    </article>
  );
}
