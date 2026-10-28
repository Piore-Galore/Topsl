import { useRef, useState } from "react";
import type { ThreadSummary } from "../../../../packages/domain/threads";
import { Freshness } from "../components/freshness";
import { useDraft } from "../state/drafts";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { Composer } from "./composer";
import { RoleEditor, teamLine } from "./role-editor";
import {
  CheckFields,
  Errors,
  checksFrom,
  emptyCheck,
  label,
  newCommandId,
  stateTone,
  useCommandRunner,
  type CheckDraft,
  type Run,
} from "./shared";

type Mode = "single" | "goal" | "endless";

export const threadKindLabel: Record<ThreadSummary["kind"], string> = {
  goal: "Goal",
  "goal-loop": "Goal loop",
  endless: "Endless",
};

/**
 * With the feature off, runs that have not stopped are paused and stay
 * listed here so Stop never disappears behind the flag.
 */
function StoppableRuns({ runs, run }: { runs: any[]; run: Run }) {
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

/**
 * A project's home when no conversation is open: start a new goal or loop,
 * reopen a recent conversation, and set the team defaults for new goals.
 */
export function ProjectHome({
  projectId,
  projectName,
  projectPath,
  onThread,
}: {
  projectId: string;
  projectName?: string;
  projectPath?: string;
  onThread: (threadId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [loops, setLoops] = useState<any>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [mode, setMode] = useState<Mode>("single");
  const [kind, setKind] = useState<"code" | "information">("code");
  const [check, setCheck] = useState<CheckDraft>(emptyCheck);
  const [automaticChecks, setAutomaticChecks] = useState(false);
  const [reserve, setReserve] = useState(1);
  const [allowance, setAllowance] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useDraft(`${projectId}:home`);
  const reads = useRef(new ScopedReadFence(projectId));
  async function refresh() {
    const ticket = reads.current.begin();
    const [value, loopValue, listed]: any[] = await Promise.all([
      window.topsl.command({ type: "orchestration-query", projectId }),
      window.topsl.command({ type: "loop-query", projectId }),
      window.topsl.command({
        type: "coordinator-threads",
        projectIds: [projectId],
        limit: 20,
      }),
    ]);
    if (!reads.current.accept(ticket, value)) return;
    setSnapshot(value);
    setLoops(loopValue);
    setThreads(listed[0]?.threads ?? []);
  }
  const freshness = useScopedRefresh(projectId, refresh);
  const { run, errors } = useCommandRunner(refresh, projectId);
  const loopMode = mode !== "single";
  const loopsOff = loopMode && loops && !loops.enabled;
  const coordinators = (snapshot?.routes ?? []).filter(
    (r: any) => r.purposes?.["coordinator-contribution"]?.ready,
  );
  async function send() {
    const message = text.trim();
    if (!message) return;
    if (mode === "single") {
      const started = await run("start", {
        type: "orchestration-conversation-start",
        projectId,
        text: message,
        kind,
        ...(kind === "code" ? { checks: checksFrom(check) } : {}),
        commandId: newCommandId(),
      });
      if (started?.conversationId) {
        setText("");
        onThread(`goal:${started.conversationId}`);
      }
      return;
    }
    const checks = checksFrom(check).map((c) => ({ ...c, id: "loop-check-1" }));
    const created = await run("create", {
      type: "loop-create",
      projectId,
      conversationId: null,
      mode,
      text: message,
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
      setText("");
      onThread(`loop:${created.run.id}`);
    }
  }
  const editorRole =
    editing && snapshot?.roles.find((r: any) => r.role.id === editing);
  return (
    <section aria-label="New conversation" className="project-home">
      <header className="thread-header">
        <div className="thread-title">
          <h1>{projectName ?? "Project"}</h1>
        </div>
        {projectPath && <p className="path">{projectPath}</p>}
      </header>
      <Freshness state={freshness} retry={freshness.retry} />
      <Errors errors={errors} />
      <div className="home-start">
        <fieldset className="mode-selector" aria-label="Run mode">
          <legend>Run mode</legend>
          {(
            [
              ["single", "Single goal", false],
              ["goal", "Goal loop", true],
              ["endless", "Endless", true],
            ] as const
          ).map(([value, title, experimental]) => (
            <label key={value} className={mode === value ? "selected" : ""}>
              <input
                type="radio"
                name="coordinator-run-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {title}
              {experimental && <span className="badge warm">Experimental</span>}
            </label>
          ))}
        </fieldset>
        <p className="muted readiness">
          {mode === "single"
            ? coordinators.length
              ? `${coordinators.length} ${coordinators.length === 1 ? "runtime" : "runtimes"} can coordinate. Name models in the message ("coordinate with Opus and Astra, review with Fable and Sol") or set the project's role defaults below.`
              : "No runtime can coordinate yet. Qualify a Codex runtime (or Claude Code) under Applications first; goals wait until one can run."
            : mode === "goal"
              ? "A Goal loop keeps assessing, delegating, verifying and repairing until every required goal is met on one accepted checkpoint. Creating it does not start work."
              : "An Endless loop keeps finding and verifying worthwhile improvements until you stop it. Creating it does not start work."}
        </p>
        {loopsOff && (
          <div className="decision">
            <p className="muted">
              Recursive Looping is experimental and off. It is implemented and
              fixture-tested; it is not qualified against live providers.
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
              runs={(loops.runs ?? []).filter(
                (r: any) =>
                  r.mode === mode &&
                  !["completed", "stopped"].includes(r.state),
              )}
              run={run}
            />
          </div>
        )}
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void send()}
          sendLabel={loopMode ? "Create run" : "Send"}
          disabled={!!loopsOff}
          placeholder={
            mode === "single"
              ? 'For example: "Add the coordinator feature; coordinate with Opus and Astra, review with Fable and Sol."'
              : mode === "goal"
                ? "For example: Make project synchronization reliable, add the missing coordinator controls, and ensure restart preserves the selected model teams."
                : "For example: Keep improving Topsl. Prioritize reliability, synchronization and clarity of the interface."
          }
        >
          <details className="composer-options-panel">
            <summary>
              Options
              {checksFrom(check).length ? " · required check set" : ""}
            </summary>
            {mode === "single" && (
              <label>
                New goals produce{" "}
                <select
                  value={kind}
                  onChange={(e) =>
                    setKind(e.target.value as "code" | "information")
                  }
                >
                  <option value="code">Code changes</option>
                  <option value="information">Information only</option>
                </select>
              </label>
            )}
            {(loopMode || kind === "code") && (
              <fieldset>
                <legend>Required check (optional)</legend>
                <p className="muted">
                  {loopMode
                    ? "The check is the run's protected regression protocol: candidates cannot weaken its tests or scripts."
                    : "The check runs against the exact integrated candidate after the review group is satisfied; acceptance needs its current passing evidence. Its tests and configuration are frozen at the goal's baseline."}
                </p>
                <CheckFields draft={check} setDraft={setCheck} />
                {loopMode && (
                  <label>
                    <input
                      type="checkbox"
                      checked={automaticChecks}
                      onChange={(e) => setAutomaticChecks(e.target.checked)}
                    />
                    Run it automatically on each candidate, on this computer
                    with my permissions (not a sandbox)
                  </label>
                )}
              </fieldset>
            )}
            {loopMode && (
              <>
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
              </>
            )}
          </details>
        </Composer>
      </div>

      <section aria-label="Recent conversations" className="recent-threads">
        <h2>Recent conversations</h2>
        {!threads.length ? (
          <p className="muted">
            No conversations yet. Each goal or loop you start becomes its own
            conversation here and in the sidebar.
          </p>
        ) : (
          <ul>
            {threads.map((t) => (
              <li key={t.threadId}>
                <button
                  type="button"
                  className="recent-link"
                  onClick={() => onThread(t.threadId)}
                >
                  {t.title}
                </button>{" "}
                <span className="badge">{threadKindLabel[t.kind]}</span>{" "}
                <span className={`badge ${stateTone[t.state] ?? ""}`}>
                  {label(t.state)}
                </span>
                {t.needsYou && (
                  <span className="badge warm"> Needs you: {t.needsYou}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="home-defaults">
        <summary>Project role defaults</summary>
        <p className="muted">
          New goals start with these teams. Capacity:{" "}
          {snapshot?.capacity.held.reduce(
            (n: number, h: any) => n + h.weight,
            0,
          ) ?? 0}{" "}
          of {snapshot?.capacity.total ?? "?"} reserved. A route with unknown
          native fan-out reserves the whole budget.
        </p>
        <label>
          Members per role limit{" "}
          <input
            key={snapshot?.policy.revision ?? 0}
            type="number"
            min={1}
            max={64}
            defaultValue={snapshot?.policy.maxMembersPerRole ?? 8}
            onBlur={(e) =>
              void run("policy", {
                type: "orchestration-policy-set",
                projectId,
                expectedRevision: snapshot?.policy.revision ?? 0,
                maxMembersPerRole: Number(e.target.value),
                defaults: snapshot?.policy.defaults ?? {},
                commandId: newCommandId(),
              })
            }
          />
        </label>
        <ul>
          {snapshot?.roles.map((r: any) => (
            <li key={r.role.id}>
              <strong>{r.role.title}:</strong> {teamLine(r.group)}{" "}
              <button type="button" onClick={() => setEditing(r.role.id)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
        {editorRole && (
          <RoleEditor
            key={editing}
            projectId={projectId}
            goalId={null}
            role={editorRole.role}
            group={editorRole.group}
            routes={snapshot.routes}
            policyLimit={snapshot.policy.maxMembersPerRole}
            run={run}
            onClose={() => setEditing(null)}
          />
        )}
      </details>

      <section aria-label="Project controls" className="project-controls">
        <h2>Project controls</h2>
        <p className="muted">
          Stops every goal and loop in this project. Results and uncertain
          executions are kept.
        </p>
        <button
          type="button"
          onClick={() =>
            void run("stop-all", {
              type: "orchestration-control",
              projectId,
              goalId: null,
              action: "stop",
              commandId: newCommandId(),
            })
          }
        >
          Stop everything
        </button>
      </section>
    </section>
  );
}
