import { useEffect, useMemo, useRef, useState } from "react";
import type { Command } from "../../../../packages/domain/commands";
import type {
  CollaborationMode,
  MemberIntent,
  RoleGroupSettings,
  SchedulingKind,
  SelectionForm,
} from "../../../../packages/domain/role-groups";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { Freshness } from "./freshness";

const label = (v: string) =>
  v.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase());
const newCommandId = () => `ui-${crypto.randomUUID()}`;

/** "Opus + Astra", "Auto", or "Auto (3)": the compact team line for a role. */
export function teamLine(group: any, assignments: any[] = []): string {
  const names = group.members.map((m: MemberIntent) => {
    const a = assignments.find((x) => x.memberId === m.memberId);
    return m.pin?.label ?? a?.modelLabel ?? m.pin?.model ?? "Auto";
  });
  const total =
    group.form === "exact" ? group.members.length : (group.count ?? null);
  const open = total !== null ? Math.max(0, total - group.members.length) : 0;
  if (!names.length) return total ? `Auto (${total})` : "Auto";
  return [
    ...names,
    ...(open
      ? [`${open} Auto`]
      : group.form === "required-plus-auto" && total === null
        ? ["Auto"]
        : []),
  ].join(" + ");
}

interface ModelOption {
  key: string;
  provider: "codex" | "claude";
  installationId: string;
  model: string;
  name: string;
  available: boolean;
  reason: string;
}

function modelOptions(routes: any[], purpose: string): ModelOption[] {
  return routes.flatMap((r) =>
    r.models.map((m: any) => {
      const readiness = r.purposes?.[purpose];
      const reason = !r.catalog.fresh
        ? "Catalog is stale or not bound to the signed-in account."
        : readiness && !readiness.ready
          ? readiness.blockers.join(" ")
          : "";
      return {
        key: `${r.installationId}:${m.model}`,
        provider: r.provider,
        installationId: r.installationId,
        model: m.model,
        name: m.name,
        available: !reason,
        reason,
      };
    }),
  );
}

/**
 * The editor for one role's members. It renders a scrollable collection
 * with per-member controls and a visible total, so a third, fifth or later
 * member is added the same way as the second.
 */
function RoleEditor({
  projectId,
  goalId,
  role,
  group,
  routes,
  policyLimit,
  run,
}: {
  projectId: string;
  goalId: string | null;
  role: any;
  group: any;
  routes: any[];
  policyLimit: number;
  run: (key: string, command: Command) => Promise<unknown>;
}) {
  const [form, setForm] = useState<SelectionForm>(group.form);
  const [count, setCount] = useState<string>(
    group.count ? String(group.count) : "",
  );
  const [maxCount, setMaxCount] = useState<string>(
    String(group.maxCount ?? ""),
  );
  const [members, setMembers] = useState<MemberIntent[]>(group.members);
  const [collaboration, setCollaboration] = useState<CollaborationMode>(
    group.collaboration,
  );
  const [scheduling, setScheduling] = useState<SchedulingKind>(
    group.scheduling,
  );
  const [width, setWidth] = useState<string>(
    group.executionWidth ? String(group.executionWidth) : "",
  );
  const [threshold, setThreshold] = useState<string>(
    group.completion.threshold.kind === "count"
      ? String(group.completion.threshold.count)
      : "",
  );
  const [distinct, setDistinct] = useState(group.distinctModels === "required");
  const [search, setSearch] = useState("");
  const options = useMemo(
    () => modelOptions(routes, role.purpose),
    [routes, role.purpose],
  );
  const filtered = options.filter((o) =>
    `${o.provider} ${o.name} ${o.model}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const total = form === "exact" ? members.length : Number(count) || null;
  function add(option: ModelOption | null) {
    const n = members.length + 1;
    setMembers([
      ...members,
      {
        memberId: `${role.id}-${n}-${Math.random().toString(36).slice(2, 6)}`,
        required: true,
        pin: option
          ? {
              label: option.name,
              provider: option.provider,
              installationId: option.installationId,
              model: option.model,
            }
          : null,
        fallbacks: [],
        preferences: { providers: [], models: [] },
        source: { kind: "ui", reference: null, provenance: "explicit" },
      },
    ]);
  }
  function save() {
    const settings: RoleGroupSettings = {
      form,
      members,
      collaboration,
      scheduling,
      executionWidth: width ? Number(width) : null,
      distinctModels: distinct ? "required" : "none",
      ...(form !== "exact" && count ? { count: Number(count) } : {}),
      ...(form !== "exact" && maxCount ? { maxCount: Number(maxCount) } : {}),
      completion: {
        threshold: threshold
          ? { kind: "count", count: Number(threshold) }
          : { kind: "all" },
      },
    };
    void run(`save-${role.id}`, {
      type: "orchestration-group-set",
      projectId,
      goalId,
      level: goalId ? "goal-role" : "project-role",
      taskKey: null,
      roleId: role.id,
      settings,
      mode: "replace",
      commandId: newCommandId(),
    });
  }
  return (
    <fieldset className="role-editor">
      <legend>
        {role.title}: {teamLine({ ...group, form, members, count: total })}
      </legend>
      <p className="muted">
        {members.length} {members.length === 1 ? "member" : "members"} listed
        {total !== null ? ` of ${total}` : ""}; limit {policyLimit} per role.
        Team size, execution width and decision rule are separate settings.
      </p>
      {group.conflicts.length > 0 && (
        <p role="alert">{group.conflicts.join(" ")}</p>
      )}
      <label>
        Selection{" "}
        <select
          value={form}
          onChange={(e) => setForm(e.target.value as SelectionForm)}
        >
          <option value="auto">Auto</option>
          <option value="exact">Exact members</option>
          <option value="required-plus-auto">Required members + Auto</option>
        </select>
      </label>
      {form !== "exact" && (
        <>
          <label>
            Exact count{" "}
            <input
              type="number"
              min={1}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              placeholder="Auto"
            />
          </label>
          <label>
            At most{" "}
            <input
              type="number"
              min={1}
              value={maxCount}
              onChange={(e) => setMaxCount(e.target.value)}
            />
          </label>
        </>
      )}
      <ul
        className="member-list"
        aria-label={`${role.title} members`}
        style={{ maxHeight: 280, overflowY: "auto" }}
      >
        {members.map((m, index) => (
          <li key={m.memberId}>
            <span>
              {index + 1}.{" "}
              {m.pin
                ? `${m.pin.label ?? m.pin.model}${m.pin.provider ? ` · ${m.pin.provider}` : ""}`
                : "Auto slot"}
              {m.fallbacks.length
                ? ` (fallback: ${m.fallbacks.map((f) => f.label ?? f.model).join(", ")})`
                : ""}
            </span>{" "}
            <label>
              <input
                type="checkbox"
                checked={m.required}
                onChange={(e) =>
                  setMembers(
                    members.map((x) =>
                      x.memberId === m.memberId
                        ? { ...x, required: e.target.checked }
                        : x,
                    ),
                  )
                }
              />{" "}
              Required
            </label>{" "}
            {m.pin && (
              <button
                type="button"
                onClick={() =>
                  setMembers(
                    members.map((x) =>
                      x.memberId === m.memberId
                        ? { ...x, pin: null, fallbacks: [] }
                        : x,
                    ),
                  )
                }
              >
                Return to Auto
              </button>
            )}{" "}
            <button
              type="button"
              onClick={() =>
                setMembers(members.filter((x) => x.memberId !== m.memberId))
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <label>
        Search models across providers{" "}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, model ID or provider"
        />
      </label>
      <ul
        className="model-options"
        style={{ maxHeight: 200, overflowY: "auto" }}
        aria-label="Model options"
      >
        {filtered.map((o) => (
          <li key={o.key}>
            <button
              type="button"
              onClick={() => add(o)}
              title={o.reason || undefined}
            >
              Add {o.name} · {o.provider} ({o.model})
            </button>
            {!o.available && (
              <span className="muted"> Unavailable now: {o.reason}</span>
            )}
          </li>
        ))}
        {!filtered.length && (
          <li className="muted">
            No observed model matches. Inspect a runtime to load its catalog.
          </li>
        )}
      </ul>
      <button type="button" onClick={() => add(null)}>
        Add Auto member
      </button>
      <label>
        Collaboration{" "}
        <select
          value={collaboration}
          onChange={(e) =>
            setCollaboration(e.target.value as CollaborationMode)
          }
        >
          {[
            "solo",
            "parallel-independent",
            "parallel-partitioned",
            "peer-collaboration",
            "sequential",
          ].map((v) => (
            <option key={v} value={v}>
              {label(v)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Scheduling{" "}
        <select
          value={scheduling}
          onChange={(e) => setScheduling(e.target.value as SchedulingKind)}
        >
          <option value="capacity-waves">Capacity-bounded waves</option>
          <option value="all-simultaneous">All members simultaneously</option>
          <option value="sequential">Sequential</option>
        </select>
      </label>
      <label>
        Execution width{" "}
        <input
          type="number"
          min={1}
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          placeholder="Capacity decides"
        />
      </label>
      {role.purpose === "coordinator-contribution" && (
        <label>
          Endorsements needed{" "}
          <input
            type="number"
            min={1}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="All (unanimous)"
          />
        </label>
      )}
      <label>
        <input
          type="checkbox"
          checked={distinct}
          onChange={(e) => setDistinct(e.target.checked)}
        />{" "}
        Require different models
      </label>
      <div className="actions">
        <button type="button" onClick={save}>
          Save {role.title.toLowerCase()}
        </button>
        <button
          type="button"
          onClick={() =>
            void run(`release-${role.id}`, {
              type: "orchestration-roster-release",
              projectId,
              goalId,
              roleId: role.id,
              commandId: newCommandId(),
            })
          }
        >
          Return whole role to Auto
        </button>
      </div>
    </fieldset>
  );
}

function MemberCard({ member }: { member: any }) {
  return (
    <li className="member-card">
      <strong>{member.memberId}</strong> · {member.state}
      {member.phase !== "initial" ? ` (${member.phase})` : ""}
      <br />
      Requested:{" "}
      {member.modelLabel
        ? `${member.modelLabel} (${member.requestedModel})`
        : member.requestedModel}{" "}
      · {member.provider}
      {member.route ? ` · ${member.route}` : ""} ·{" "}
      {member.selection === "auto"
        ? "Auto"
        : member.selection === "fallback"
          ? "Fallback"
          : "Pinned"}
      <br />
      Effective: {member.effectiveModel ?? "not reported yet"}
      {member.reason && (
        <>
          <br />
          <span className="muted">{member.reason}</span>
        </>
      )}
      {member.latestValidation && member.latestValidation.state !== "valid" && (
        <>
          <br />
          <span role="status">
            Last result {member.latestValidation.state}:{" "}
            {member.latestValidation.reason}
          </span>
        </>
      )}
      {member.detail && member.detail !== "cohort-restart" && (
        <>
          <br />
          <span className="muted">{member.detail}</span>
        </>
      )}
    </li>
  );
}

export function CoordinatorTeams({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<any>(null),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [text, setText] = useState(""),
    [kind, setKind] = useState<"code" | "information">("code"),
    [editing, setEditing] = useState<{
      goalId: string | null;
      roleId: string;
    } | null>(null),
    [rationale, setRationale] = useState("");
  const generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId));
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    setSnapshot(null);
    setErrors({});
    setEditing(null);
  }, [projectId]);
  async function refresh() {
    const ticket = reads.current.begin();
    const value = await window.topsl.command({
      type: "orchestration-query",
      projectId,
    });
    if (reads.current.accept(ticket, value)) setSnapshot(value);
  }
  const freshness = useScopedRefresh(projectId, refresh);
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
  const conversation = snapshot?.conversations?.[0];
  async function send() {
    if (!text.trim()) return;
    let id = conversation?.id;
    if (!id) {
      const created: any = await run("conversation", {
        type: "orchestration-conversation-create",
        projectId,
        title: "Project conversation",
        commandId: newCommandId(),
      });
      id = created?.id;
    }
    if (!id) return;
    await run("message", {
      type: "orchestration-message",
      conversationId: id,
      text,
      goalId: null,
      routing: "auto",
      kind,
      commandId: newCommandId(),
    });
    setText("");
  }
  const editorRole =
    editing && snapshot?.roles.find((r: any) => r.role.id === editing.roleId);
  const editorGroup = editing
    ? editing.goalId
      ? snapshot?.goals
          .find((g: any) => g.goal.id === editing.goalId)
          ?.groups.find((g: any) => g.roleId === editing.roleId)?.group
      : editorRole?.group
    : null;
  return (
    <section aria-label="Coordinator conversation">
      <h2>Coordinator</h2>
      <Freshness state={freshness} retry={freshness.retry} />
      <p className="muted">
        Give a goal in one conversation. Each role can have any number of
        members, chosen automatically or pinned. Every required member
        contributes; queued members are shown as queued, not running.
      </p>
      {Object.entries(errors)
        .filter(([, e]) => e)
        .map(([k, e]) => (
          <p key={k} role="alert">
            {e}
          </p>
        ))}
      <div className="coordinator-conversation">
        <ol
          aria-label="Conversation"
          style={{ maxHeight: 240, overflowY: "auto" }}
        >
          {conversation?.messages.map((m: any) => (
            <li key={m.id}>
              <strong>
                {m.role === "user"
                  ? "You"
                  : m.role === "service"
                    ? "Topsl"
                    : "Coordinators"}
                :
              </strong>{" "}
              <span style={{ whiteSpace: "pre-wrap" }}>{m.text}</span>
              {m.routing && (
                <span className="muted"> · {label(m.routing.kind)}</span>
              )}
            </li>
          ))}
        </ol>
        <label>
          Message{" "}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='For example: "Add the coordinator feature; coordinate with Opus and Astra, review with Fable and Sol."'
            rows={3}
          />
        </label>
        <label>
          New goals produce{" "}
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "code" | "information")}
          >
            <option value="code">Code changes</option>
            <option value="information">Information only</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!text.trim()}
        >
          Send
        </button>
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
      </div>
      <details>
        <summary>Project role defaults</summary>
        <p className="muted">
          Capacity:{" "}
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
              <button
                type="button"
                onClick={() => setEditing({ goalId: null, roleId: r.role.id })}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      </details>
      {editing && editorRole && editorGroup && (
        <RoleEditor
          key={`${editing.goalId}:${editing.roleId}`}
          projectId={projectId}
          goalId={editing.goalId}
          role={editorRole.role}
          group={editorGroup}
          routes={snapshot.routes}
          policyLimit={snapshot.policy.maxMembersPerRole}
          run={run}
        />
      )}
      {snapshot?.goals
        .slice()
        .reverse()
        .map((view: any) => {
          const g = view.goal;
          const active = (roleId: string) =>
            view.rounds.some((r: any) => r.roleId === roleId) ||
            ["coordinator", "reviewer", "implementer"].includes(roleId);
          return (
            <article
              key={g.id}
              className="workflow-card"
              aria-label={`Goal ${g.objective}`}
            >
              <h3>{g.objective}</h3>
              <p>
                <strong>{label(g.state)}</strong> · {g.detail}
              </p>
              <ul className="team-summary">
                {view.groups
                  .filter((x: any) => active(x.roleId))
                  .map((x: any) => (
                    <li key={x.roleId}>
                      <strong>{x.title}:</strong>{" "}
                      {teamLine(x.group, x.assignments)}{" "}
                      {x.group.conflicts.length > 0 && (
                        <span role="status">
                          ({x.group.conflicts.join(" ")})
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({ goalId: g.id, roleId: x.roleId })
                        }
                      >
                        Change
                      </button>
                    </li>
                  ))}
              </ul>
              <div className="actions">
                {g.state === "paused" ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run(`resume-${g.id}`, {
                        type: "orchestration-control",
                        projectId,
                        goalId: g.id,
                        action: "resume",
                        commandId: newCommandId(),
                      })
                    }
                  >
                    Resume
                  </button>
                ) : !["stopped", "accepted", "completed"].includes(g.state) ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run(`pause-${g.id}`, {
                        type: "orchestration-control",
                        projectId,
                        goalId: g.id,
                        action: "pause",
                        commandId: newCommandId(),
                      })
                    }
                  >
                    Pause
                  </button>
                ) : null}
                {!["stopped", "accepted", "completed"].includes(g.state) && (
                  <button
                    type="button"
                    onClick={() =>
                      void run(`stop-${g.id}`, {
                        type: "orchestration-control",
                        projectId,
                        goalId: g.id,
                        action: "stop",
                        commandId: newCommandId(),
                      })
                    }
                  >
                    Stop goal
                  </button>
                )}
                {g.state === "awaiting-acceptance" && (
                  <button
                    type="button"
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
                )}
                {view.review?.result === "blocked" && (
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
                )}
              </div>
              {g.synthesis && <pre className="synthesis">{g.synthesis}</pre>}
              {view.actions.length > 0 && (
                <details>
                  <summary>
                    Plan revision {view.plan?.revision}:{" "}
                    {
                      view.actions.filter((a: any) => a.state === "completed")
                        .length
                    }{" "}
                    of {view.actions.length} tasks completed
                  </summary>
                  <ul>
                    {view.plan?.tasks.map((t: any) => {
                      const a = view.actions.find(
                        (x: any) => x.taskKey === t.key,
                      );
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
                </details>
              )}
              {view.rounds
                .filter(
                  (r: any) =>
                    r.active || r.stage === "blocked" || r.kind === "review",
                )
                .slice(-4)
                .map((r: any) => (
                  <section key={r.id} aria-label={`${r.roleId} round`}>
                    <h4>
                      {label(r.roleId)} · {label(r.kind)}
                      {r.taskKey ? ` · ${r.taskKey}` : ""}
                    </h4>
                    <p>{r.progress}</p>
                    {r.kind === "coordination" && (
                      <p className="muted">
                        Decision rule: {r.threshold} of {r.electorate}{" "}
                        endorsements.
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
                    {r.stage === "awaiting-user" && (
                      <div>
                        <p>
                          Choose one attributed proposal to continue; the others
                          and any dissent stay recorded.
                        </p>
                        {r.contributions
                          .filter(
                            (c: any) =>
                              c.validation.state === "valid" &&
                              c.phase !== "endorsement",
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
                    )}
                    {["blocked", "awaiting-user"].includes(r.stage) && (
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
                    )}
                    {r.findings.length > 0 && (
                      <div>
                        <h5>Findings ({r.findings.length})</h5>
                        <label>
                          Rationale for a decision{" "}
                          <input
                            value={rationale}
                            onChange={(e) => setRationale(e.target.value)}
                          />
                        </label>
                        <ul>
                          {r.findings.map((f: any) => (
                            <li key={f.key}>
                              <strong>{f.severity}</strong> {f.file}:{f.line}{" "}
                              {f.title} · {f.disposition}
                              <div className="muted">
                                Reported by{" "}
                                {f.observations
                                  .map((o: any) => o.memberId)
                                  .join(", ")}
                                {f.silentMemberIds.length
                                  ? `; not mentioned by ${f.silentMemberIds.join(", ")} (omission is not resolution)`
                                  : ""}
                              </div>
                              {[
                                "substantiated",
                                "duplicate",
                                "unsupported",
                                "waived",
                              ].map((d) => (
                                <button
                                  key={d}
                                  type="button"
                                  disabled={!rationale.trim()}
                                  onClick={() =>
                                    void run(`finding-${f.key}`, {
                                      type: "orchestration-finding-decide",
                                      goalId: g.id,
                                      findingKey: f.key,
                                      disposition: d as any,
                                      rationale,
                                      commandId: newCommandId(),
                                    })
                                  }
                                >
                                  {label(d)}
                                </button>
                              ))}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                ))}
            </article>
          );
        })}
    </section>
  );
}
