import { useState } from "react";
import { label, newCommandId, type Run } from "./shared";

/**
 * A loop run's detail panes (docs/Recursive_Looping.md). Each keeps the
 * region name it had in the run view, so the goals, checkpoint,
 * organization, iterations and usage read the same in the thread's pane.
 */

export type LoopPane =
  "goals" | "checkpoint" | "organization" | "iterations" | "backlog" | "usage";

export function GoalsPane({ view, run }: { view: any; run: Run }) {
  const r = view.run;
  const [newGoal, setNewGoal] = useState("");
  return (
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
                {String(g.regression.iterationId).split(":").at(-1)}; repair is
                scheduled.
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
        <input value={newGoal} onChange={(e) => setNewGoal(e.target.value)} />
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
            Not complete yet: {view.completion.missing.slice(0, 3).join("; ")}.
          </p>
        )}
    </section>
  );
}

export function CheckpointPane({ view, run }: { view: any; run: Run }) {
  const r = view.run;
  const [exported, setExported] = useState("");
  return (
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
                }).then(
                  (x: any) => x?.path && setExported(`Exported to ${x.path}`),
                )
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
          {exported && <p role="status">{exported}</p>}
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
  );
}

export function OrganizationPane({ view, run }: { view: any; run: Run }) {
  const r = view.run;
  const [lockCounts, setLockCounts] = useState<Record<string, string>>({});
  return (
    <section aria-label="Organization">
      <h3>Organization</h3>
      <p className="muted">
        Fields marked “yours” are locked by you and never change automatically;
        everything else is Auto.
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
                    {m.model ?? "unresolved"} {m.pinned ? "· yours" : "· Auto"}
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
              {a.actor === "loop-policy" ? "loop policy" : a.actor}: {a.reason}
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
  );
}

export function IterationsPane({ view }: { view: any }) {
  const current = view.current;
  return (
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
  );
}

export function BacklogPane({ view }: { view: any }) {
  if (!view.backlog.length)
    return <p className="muted">No improvement is waiting.</p>;
  return (
    <section aria-label="Improvement backlog">
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
    </section>
  );
}

export function UsagePane({ view }: { view: any }) {
  return (
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
  );
}
