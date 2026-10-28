import { useState } from "react";
import { MemberCard, RoleEditor, teamLine } from "./role-editor";
import {
  CheckFields,
  checksFrom,
  emptyCheck,
  endedGoal,
  label,
  newCommandId,
  stateTone,
  type CheckDraft,
  type Run,
} from "./shared";

export type GoalPane = "team" | "plan" | "review" | "checks" | "changes";

/** Roles shown on a goal's team line: the built-in three and any that ran. */
const shownRoles = (view: any) =>
  view.groups.filter(
    (x: any) =>
      view.rounds.some((r: any) => r.roleId === x.roleId) ||
      ["coordinator", "reviewer", "implementer"].includes(x.roleId),
  );

/** Undecided findings in the goal's review rounds. */
export const openFindings = (view: any) =>
  view.rounds
    .filter((r: any) => r.kind === "review")
    .flatMap((r: any) => r.findings)
    .filter((f: any) => f.disposition === "open").length;

/** Goal controls: pause or resume, and stop, while the goal has not ended. */
export function GoalControls({
  view,
  projectId,
  run,
}: {
  view: any;
  projectId: string;
  run: Run;
}) {
  const g = view.goal;
  if (endedGoal(g.state)) return null;
  const control = (action: "pause" | "resume" | "stop") =>
    void run(`${action}-${g.id}`, {
      type: "orchestration-control",
      projectId,
      goalId: g.id,
      action,
      commandId: newCommandId(),
    });
  return (
    <div
      className="actions goal-controls"
      role="group"
      aria-label="Goal controls"
    >
      {g.state === "paused" ? (
        <button type="button" onClick={() => control("resume")}>
          Resume
        </button>
      ) : (
        <button type="button" onClick={() => control("pause")}>
          Pause
        </button>
      )}
      <button type="button" onClick={() => control("stop")}>
        Stop goal
      </button>
    </div>
  );
}

/**
 * One goal as the coordinators' turn in the thread: its state, team, the
 * coordinators' answer, and only the decisions that wait on the owner.
 * Rounds, plan, findings, checks and changes open in the thread's panes.
 */
export function GoalCard({
  view,
  projectId,
  run,
  controls,
  onPane,
  onChangeRole,
}: {
  view: any;
  projectId: string;
  run: Run;
  /** Shown on goals other than the thread's latest, whose controls are in the header. */
  controls: boolean;
  onPane: (pane: GoalPane, goalId: string) => void;
  onChangeRole: (goalId: string, roleId: string) => void;
}) {
  const g = view.goal;
  const [checkPlans, setCheckPlans] = useState<any[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const current = view.rounds.filter((r: any) => r.active).at(-1);
  const awaiting = view.rounds.filter((r: any) => r.stage === "awaiting-user");
  const stuck = view.rounds.filter((r: any) => r.stage === "blocked");
  const findings = openFindings(view);
  return (
    <article
      className="goal-card turn coordinators"
      aria-label={`Goal ${g.objective}`}
    >
      <header className="turn-header">
        <span className="turn-author">Coordinators</span>
        <strong className={`badge ${stateTone[g.state] ?? ""}`}>
          {label(g.state)}
        </strong>
        <span className="muted">{g.detail}</span>
      </header>
      <ul className="team-summary">
        {shownRoles(view).map((x: any) => (
          <li key={x.roleId}>
            <strong>{x.title}:</strong> {teamLine(x.group, x.assignments)}{" "}
            {x.group.conflicts.length > 0 && (
              <span role="status">({x.group.conflicts.join(" ")})</span>
            )}
            <button type="button" onClick={() => onChangeRole(g.id, x.roleId)}>
              Change
            </button>
          </li>
        ))}
      </ul>
      {current && (
        <p className="round-progress">
          {label(current.roleId)} · {label(current.kind)}
          {current.taskKey ? ` · ${current.taskKey}` : ""}: {current.progress}{" "}
          <button
            type="button"
            className="link"
            onClick={() => onPane("plan", g.id)}
          >
            Round details
          </button>
        </p>
      )}
      {g.synthesis && <div className="synthesis">{g.synthesis}</div>}
      {controls && <GoalControls view={view} projectId={projectId} run={run} />}

      {awaiting.map((r: any) => (
        <section key={r.id} className="decision" aria-label="Choose a proposal">
          <h3>Needs you: choose a proposal</h3>
          <p>
            The coordinators did not agree. Choose one attributed proposal to
            continue; the others and any dissent stay recorded.
          </p>
          <div className="actions wrap">
            {r.contributions
              .filter(
                (c: any) =>
                  c.validation.state === "valid" && c.phase !== "endorsement",
              )
              .map((c: any) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() =>
                    void run(`branch-${c.id}`, {
                      type: "orchestration-branch-choose",
                      goalId: g.id,
                      roundId: r.id,
                      contributionId: c.id,
                      commandId: newCommandId(),
                    })
                  }
                >
                  Use {c.memberId}'s {c.phase} proposal:{" "}
                  {c.summary?.slice(0, 120)}
                </button>
              ))}
          </div>
        </section>
      ))}
      {[...awaiting, ...stuck].map((r: any) => (
        <p key={`restart-${r.id}`} className="decision-inline">
          {label(r.roleId)} {label(r.kind)} round is{" "}
          {label(r.stage).toLowerCase()}
          {r.detail ? `: ${r.detail}` : "."}{" "}
          <button
            type="button"
            onClick={() =>
              void run(`restart-${r.id}`, {
                type: "orchestration-round-restart",
                goalId: g.id,
                roundId: r.id,
                commandId: newCommandId(),
              })
            }
          >
            Restart this round
          </button>
        </p>
      ))}

      {g.state === "blocked" && view.conflicts.length > 0 && (
        <section className="decision" aria-label="Integration conflicts">
          <h3>Needs you: integration conflicts ({view.conflicts.length})</h3>
          <p className="muted">
            These files were changed differently by more than one member. Choose
            one member's whole version of each file; no text is merged. The
            result is integrated again and the review group and required checks
            cover it anew.
          </p>
          <ul>
            {view.conflicts.map((c: any) => (
              <li key={c.path}>
                <fieldset>
                  <legend>{c.path}</legend>
                  {c.options.map((o: any) => (
                    <label key={o.candidateId}>
                      <input
                        type="radio"
                        name={`${g.id}:${c.path}`}
                        checked={choices[c.path] === o.candidateId}
                        onChange={() =>
                          setChoices((current) => ({
                            ...current,
                            [c.path]: o.candidateId,
                          }))
                        }
                      />{" "}
                      {o.memberId}'s version
                      {o.taskKey ? ` (task ${o.taskKey})` : ""}
                    </label>
                  ))}
                </fieldset>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={
              !Object.keys(choices).some((path) =>
                view.conflicts.some((c: any) => c.path === path),
              )
            }
            onClick={() =>
              void run(`resolve-${g.id}`, {
                type: "orchestration-conflict-resolve",
                goalId: g.id,
                resolutions: Object.entries(choices)
                  .filter(([path]) =>
                    view.conflicts.some((c: any) => c.path === path),
                  )
                  .map(([path, candidateId]) => ({ path, candidateId })),
                commandId: newCommandId(),
              })
            }
          >
            Use the chosen versions
          </button>
        </section>
      )}

      {view.review?.result === "blocked" && (
        <section className="decision" aria-label="Review findings">
          <h3>Needs you: the review group found problems</h3>
          <p>
            {findings} {findings === 1 ? "finding is" : "findings are"} open.
            Decide each one in the review pane, or start a bounded repair.
          </p>
          <div className="actions">
            <button type="button" onClick={() => onPane("review", g.id)}>
              Open findings
            </button>
            <button
              type="button"
              onClick={() =>
                void run(`repair-${g.id}`, {
                  type: "orchestration-repair",
                  goalId: g.id,
                  commandId: newCommandId(),
                })
              }
            >
              Start a bounded repair
            </button>
          </div>
        </section>
      )}

      {g.state === "checking" && (
        <section className="decision" aria-label="Run required checks">
          <h3>Needs you: run the required checks</h3>
          <p>{view.checks.detail}</p>
          <div className="actions wrap">
            <button
              type="button"
              onClick={async () => {
                const plans: any = await run(`checks-${g.id}`, {
                  type: "orchestration-checks-preview",
                  goalId: g.id,
                });
                if (plans) setCheckPlans(plans);
              }}
            >
              Prepare checks for this candidate
            </button>
            {checkPlans
              .filter((p: any) => p.candidateId === g.candidateId)
              .map((p: any) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={async () => {
                    await run(`check-${p.id}`, {
                      type: "orchestration-check-apply",
                      id: p.id,
                    });
                    setCheckPlans((current) =>
                      current.filter((x: any) => x.id !== p.id),
                    );
                  }}
                >
                  Run {p.definition.label}…
                </button>
              ))}
          </div>
        </section>
      )}

      {g.state === "awaiting-acceptance" && (
        <section className="decision" aria-label="Accept the candidate">
          <h3>Needs you: accept the candidate</h3>
          <p>
            The review group is satisfied
            {view.checks.required.length ? " and the required checks pass" : ""}
            . Accepting records your decision; the project folder is not
            changed.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() =>
                void run(`accept-${g.id}`, {
                  type: "orchestration-accept",
                  goalId: g.id,
                  commandId: newCommandId(),
                })
              }
            >
              Accept candidate…
            </button>
            <button type="button" onClick={() => onPane("changes", g.id)}>
              Review changes
            </button>
          </div>
        </section>
      )}

      {g.state === "accepted" &&
        g.baselineCandidateId &&
        (!view.application || view.application.state === "refused") && (
          <section
            className="decision"
            aria-label="Apply to the project folder"
          >
            <h3>Accepted. Apply it to the project folder?</h3>
            <p className="muted">
              Topsl writes the accepted files only when the folder has no
              uncommitted or untracked changes and still matches the goal's
              starting point. Nothing is committed.
            </p>
            <button
              type="button"
              onClick={() =>
                void run(`apply-${g.id}`, {
                  type: "orchestration-apply",
                  goalId: g.id,
                  commandId: newCommandId(),
                })
              }
            >
              Apply to project folder…
            </button>
          </section>
        )}
      {view.application && (
        <p role="status">
          <strong>Project folder: {label(view.application.state)}</strong> ·{" "}
          {view.application.detail}
        </p>
      )}
    </article>
  );
}

/** The goal's team: every role's members, with the editor for one role. */
export function TeamPane({
  view,
  snapshot,
  projectId,
  run,
  editing,
  onEdit,
}: {
  view: any;
  snapshot: any;
  projectId: string;
  run: Run;
  editing: string | null;
  onEdit: (roleId: string | null) => void;
}) {
  const g = view.goal;
  const role =
    editing && snapshot.roles.find((r: any) => r.role.id === editing);
  const group =
    editing && view.groups.find((x: any) => x.roleId === editing)?.group;
  return (
    <div className="pane-section">
      <p className="muted">
        Changes here apply to this goal. Project defaults for new goals are on
        the project's New conversation page.
      </p>
      <ul className="team-summary">
        {view.groups.map((x: any) => (
          <li key={x.roleId}>
            <strong>{x.title}:</strong> {teamLine(x.group, x.assignments)}{" "}
            <button type="button" onClick={() => onEdit(x.roleId)}>
              Edit
            </button>
          </li>
        ))}
      </ul>
      {role && group && (
        <RoleEditor
          key={`${g.id}:${editing}`}
          projectId={projectId}
          goalId={g.id}
          role={role.role}
          group={group}
          routes={snapshot.routes}
          policyLimit={snapshot.policy.maxMembersPerRole}
          run={run}
          onClose={() => onEdit(null)}
        />
      )}
    </div>
  );
}

/** The plan and the rounds that produced and worked it. */
export function PlanPane({ view }: { view: any }) {
  const rounds = view.rounds
    .filter(
      (r: any) => r.active || r.stage === "blocked" || r.kind === "review",
    )
    .slice(-6);
  return (
    <div className="pane-section">
      {view.plan ? (
        <section aria-label="Plan">
          <h3>
            Plan revision {view.plan.revision}:{" "}
            {view.actions.filter((a: any) => a.state === "completed").length} of{" "}
            {view.actions.length} tasks completed
          </h3>
          <ul>
            {view.plan.tasks.map((t: any) => {
              const a = view.actions.find((x: any) => x.taskKey === t.key);
              return (
                <li key={t.key}>
                  {t.title} · {t.roleId} · {a?.state ?? "unknown"}
                  {t.dependencies.length
                    ? ` · after ${t.dependencies.join(", ")}`
                    : ""}
                  {a?.detail && <div className="muted">{a.detail}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="muted">No plan is agreed yet.</p>
      )}
      {rounds.map((r: any) => (
        <section key={r.id} aria-label={`${r.roleId} round`}>
          <h3>
            {label(r.roleId)} · {label(r.kind)}
            {r.taskKey ? ` · ${r.taskKey}` : ""}
          </h3>
          <p>{r.progress}</p>
          {r.kind === "coordination" && (
            <p className="muted">
              Decision rule: {r.threshold} of {r.electorate} endorsements.
            </p>
          )}
          <ul className="member-cards">
            {r.members.map((m: any) => (
              <MemberCard key={m.memberId} member={m} />
            ))}
          </ul>
          {r.endorsements.length > 0 && (
            <p>
              Endorsements:{" "}
              {r.endorsements
                .map(
                  (e: any) =>
                    `${e.memberId} ${e.stance}${e.implied ? " (by matching proposal)" : ""}`,
                )
                .join("; ")}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

/** Review findings, each decided with its own rationale. */
export function ReviewPane({ view, run }: { view: any; run: Run }) {
  const g = view.goal;
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const reviews = view.rounds.filter((r: any) => r.kind === "review");
  if (!reviews.length)
    return (
      <p className="muted">
        The review group has not reviewed a candidate yet.
      </p>
    );
  return (
    <div className="pane-section">
      {view.review && (
        <p role="status">Review: {label(view.review.result ?? "pending")}</p>
      )}
      {reviews.map((r: any) => (
        <section key={r.id} aria-label={`Review round ${r.id}`}>
          <h3>Review · {r.progress}</h3>
          {!r.findings.length && <p className="muted">No findings.</p>}
          <ul className="findings">
            {r.findings.map((f: any) => (
              <li key={f.key}>
                <strong>{f.severity}</strong> {f.file}:{f.line} {f.title} ·{" "}
                {f.disposition}
                <div className="muted">
                  Reported by{" "}
                  {f.observations.map((o: any) => o.memberId).join(", ")}
                  {f.silentMemberIds.length
                    ? `; not mentioned by ${f.silentMemberIds.join(", ")} (omission is not resolution)`
                    : ""}
                </div>
                <label>
                  Rationale for {f.title}{" "}
                  <input
                    value={rationale[f.key] ?? ""}
                    onChange={(e) =>
                      setRationale((current) => ({
                        ...current,
                        [f.key]: e.target.value,
                      }))
                    }
                  />
                </label>
                <div className="actions wrap">
                  {["substantiated", "duplicate", "unsupported", "waived"].map(
                    (d) => (
                      <button
                        key={d}
                        type="button"
                        disabled={!rationale[f.key]?.trim()}
                        onClick={() =>
                          void run(`finding-${f.key}`, {
                            type: "orchestration-finding-decide",
                            goalId: g.id,
                            findingKey: f.key,
                            disposition: d as any,
                            rationale: rationale[f.key],
                            commandId: newCommandId(),
                          })
                        }
                      >
                        {label(d)}
                      </button>
                    ),
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Required checks: their results, and the definition until work starts. */
export function ChecksPane({ view, run }: { view: any; run: Run }) {
  const g = view.goal;
  const [draft, setDraft] = useState<CheckDraft>(emptyCheck);
  const editable =
    g.kind === "code" &&
    !view.rounds.some((r: any) => r.kind === "work") &&
    !endedGoal(g.state);
  if (g.kind !== "code")
    return <p className="muted">Information goals have no required checks.</p>;
  return (
    <section className="pane-section" aria-label="Required checks">
      {view.checks.required.length ? (
        <>
          <p>{view.checks.detail}</p>
          <ul>
            {view.checks.results.map((c: any) => (
              <li key={c.definitionId}>
                {c.label} · {c.result ?? "not run"} on the current candidate
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">
          No required checks; acceptance rests on the review group.
        </p>
      )}
      {editable && (
        <details>
          <summary>Set this goal's required check</summary>
          <p className="muted">
            Checks are fixed once implementation starts. Leave the executable
            empty to remove them.
          </p>
          <CheckFields draft={draft} setDraft={setDraft} />
          <button
            type="button"
            onClick={() =>
              void run(`checks-set-${g.id}`, {
                type: "orchestration-checks-set",
                goalId: g.id,
                checks: checksFrom(draft),
                commandId: newCommandId(),
              })
            }
          >
            Save required check
          </button>
        </details>
      )}
    </section>
  );
}

/** What the goal changed: its candidate, choices made, and the folder outcome. */
export function ChangesPane({ view }: { view: any }) {
  const g = view.goal;
  return (
    <div className="pane-section">
      {g.kind === "information" ? (
        <p className="muted">
          Information goals produce the coordinators' answer, not file changes.
        </p>
      ) : g.candidateId ? (
        <p>
          Integrated candidate <code>{g.candidateId}</code>
          {g.acceptance
            ? `, accepted ${new Date(g.acceptance.at).toLocaleString()}`
            : ""}
          .
        </p>
      ) : (
        <p className="muted">No integrated candidate yet.</p>
      )}
      {view.resolutions.length > 0 && (
        <section aria-label="Conflict choices">
          <h3>Your conflict choices</h3>
          <ul>
            {view.resolutions.map((r: any) => (
              <li key={r.path}>
                {r.path} · {r.candidateId}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.application && (
        <section aria-label="Project folder">
          <h3>Project folder: {label(view.application.state)}</h3>
          <p className="muted">{view.application.detail}</p>
          <ul>
            {view.application.files.map((f: any) => (
              <li key={f.path}>
                {f.change}: {f.path}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
