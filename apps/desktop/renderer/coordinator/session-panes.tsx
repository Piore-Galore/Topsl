import { useState } from "react";
import type { Command } from "../../../../packages/domain/commands";
import type {
  MemberIntent,
  RoleGroupSettings,
} from "../../../../packages/domain/role-groups";
import type {
  SessionConfiguration,
  TopslSession,
} from "../../../../packages/domain/sessions";
import {
  RoleEditor,
  filterModelOptions,
  modelOptions,
  teamLine,
  type ModelOption,
} from "./role-editor";
import { label, newCommandId, type Run } from "./shared";

/**
 * Native session panes (docs/Native_Sessions_Plan.md): the coordinator
 * picker, the session's team, its work queue and the coordinators' attributed
 * contributions behind one shared response.
 */

export const providerName = (provider: string) =>
  provider === "claude"
    ? "Claude Code"
    : provider === "codex"
      ? "Codex"
      : provider;

const intentLabel: Record<string, string> = {
  discuss: "Discuss",
  status: "Status",
  steer: "Steer",
  "new-work": "New work",
  clarify: "Clarify",
};

/** One combined Claude Code and Codex list of coordinator models. */
export function coordinatorOptions(
  routes: any[],
): Array<ModelOption & { efforts: string[] }> {
  return modelOptions(routes, "coordinator-contribution").map((o) => ({
    ...o,
    efforts:
      routes
        .find((r) => r.installationId === o.installationId)
        ?.models.find((m: any) => m.model === o.model)?.efforts ?? [],
  }));
}

/**
 * Picks the session's coordinators. Empty is one Auto coordinator; each
 * selected model is pinned and stays pinned. Unavailable models are listed
 * with the reason, and cannot be added.
 */
export function CoordinatorPicker({
  routes,
  value,
  onChange,
}: {
  routes: any[];
  value: MemberIntent[];
  onChange: (value: MemberIntent[]) => void;
}) {
  const [search, setSearch] = useState("");
  const options = coordinatorOptions(routes);
  const shown = filterModelOptions(options, search) as typeof options;
  const add = (pin: MemberIntent["pin"]) =>
    onChange([
      ...value,
      {
        memberId: `coordinator-${value.length + 1}`,
        required: true,
        pin,
        fallbacks: [],
        preferences: { providers: [], models: [] },
        source: { kind: "ui", reference: null, provenance: "explicit" },
      },
    ]);
  return (
    <fieldset className="coordinator-picker" aria-label="Coordinators">
      <legend>Coordinators</legend>
      {value.length ? (
        <ol className="picked-coordinators">
          {value.map((m, i) => {
            const option = options.find(
              (o) =>
                o.model === m.pin?.model &&
                (!m.pin?.provider || o.provider === m.pin.provider),
            );
            return (
              <li key={m.memberId}>
                <span>
                  {m.pin
                    ? `${providerName(m.pin.provider ?? "")} · ${option?.name ?? m.pin.model}`
                    : "Auto"}
                  {i === 0 && value.length > 1
                    ? " (prepares the shared wording)"
                    : ""}
                </span>
                {m.pin && option && option.efforts.length > 0 && (
                  <select
                    aria-label={`Effort for ${option.name}`}
                    value={m.pin.effort ?? ""}
                    onChange={(e) =>
                      onChange(
                        value.map((x) =>
                          x.memberId === m.memberId
                            ? {
                                ...x,
                                pin: {
                                  ...x.pin!,
                                  effort: e.target.value || undefined,
                                },
                              }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value="">Default effort</option>
                    {option.efforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {label(effort)}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  aria-label={`Remove coordinator ${i + 1}`}
                  onClick={() =>
                    onChange(
                      value
                        .filter((x) => x.memberId !== m.memberId)
                        .map((x, n) => ({
                          ...x,
                          memberId: `coordinator-${n + 1}`,
                        })),
                    )
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted">
          Auto: one coordinator, chosen from the ready models.
        </p>
      )}
      <label>
        Find a model{" "}
        <input
          type="search"
          value={search}
          placeholder="opus, codex, gpt…"
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <ul className="model-options" aria-label="Coordinator models">
        {shown.map((o) => (
          <li key={o.key} className={o.available ? "" : "unavailable"}>
            <span>
              <strong>{o.name}</strong> · {providerName(o.provider)} ·{" "}
              <code>{o.model}</code>
              {o.efforts.length ? ` · effort ${o.efforts.join("/")}` : ""}
              {!o.available && <span className="muted"> · {o.reason}</span>}
            </span>
            <button
              type="button"
              disabled={!o.available}
              aria-label={`Add ${o.name} (${providerName(o.provider)}) as a coordinator`}
              onClick={() =>
                add({
                  label: o.name,
                  provider: o.provider,
                  installationId: o.installationId,
                  model: o.model,
                })
              }
            >
              Add
            </button>
          </li>
        ))}
        {!options.length && (
          <li className="muted">
            No coordinator model is observed yet. Qualify Claude Code or Codex
            under Providers.
          </li>
        )}
      </ul>
      <button type="button" onClick={() => add(null)}>
        Add an Auto coordinator
      </button>
    </fieldset>
  );
}

/** The roles a new custom role can be created with. */
const purposes = [
  ["implementation", "Implementation"],
  ["information", "Research"],
  ["candidate-review", "Review"],
] as const;

/**
 * The session's team: coordinators, Automatic or Custom mode, and each
 * role with who chose its members and why. Changes apply at the running
 * goal's next round boundary.
 */
export function SessionTeamPane({
  query,
  snapshot,
  run,
}: {
  query: any;
  snapshot: any;
  run: Run;
}) {
  const session: TopslSession = query.session;
  const configuration = session.pending?.configuration ?? session.configuration;
  const [coordinators, setCoordinators] = useState<MemberIntent[]>(
    configuration.coordinators,
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    roleId: "",
    title: "",
    instructions: "",
    purpose: "implementation" as (typeof purposes)[number][0],
  });
  const update = (key: string, patch: Partial<SessionConfiguration>) =>
    run(key, {
      type: "session-update",
      sessionId: session.id,
      expectedRevision: session.revision,
      configuration: patch,
      commandId: newCommandId(),
    } as Command);
  const roles: any[] = query.roles.filter(
    (r: any) => r.role.purpose !== "coordinator-contribution",
  );
  const editorRole = editing && roles.find((r) => r.role.id === editing);
  const setRole = (roleId: string, settings: RoleGroupSettings | null) => {
    const next = { ...configuration.roles };
    if (settings) next[roleId] = { ...(next[roleId] ?? {}), settings };
    else delete next[roleId];
    return {
      type: "session-update",
      sessionId: session.id,
      expectedRevision: session.revision,
      configuration: {
        roles: next,
        requiredRoles: configuration.requiredRoles.filter((r) => next[r]),
      },
      commandId: newCommandId(),
    } as Command;
  };
  return (
    <div className="pane-section session-team">
      {session.pending && (
        <p role="status">
          Your change waits for the running round to finish, so no round is
          re-scoped under its members.
        </p>
      )}
      <section aria-label="Session coordinators">
        <ul className="team-summary">
          {query.coordinators.map((c: any) => (
            <li key={c.memberId}>
              <strong>{c.memberId}:</strong>{" "}
              {c.model
                ? `${providerName(c.provider)} · ${c.model}`
                : "unresolved"}{" "}
              ·{" "}
              {c.selection === "auto"
                ? "Auto"
                : c.selection === "fallback"
                  ? "Fallback"
                  : "Pinned"}
              {c.status !== "resolved" && (
                <span role="alert"> · {c.reason}</span>
              )}
            </li>
          ))}
        </ul>
        <CoordinatorPicker
          routes={snapshot.routes}
          value={coordinators}
          onChange={setCoordinators}
        />
        <button
          type="button"
          onClick={() => void update("coordinators", { coordinators })}
        >
          Save coordinators
        </button>
      </section>
      <fieldset className="mode-selector" aria-label="Team setup">
        <legend>Team</legend>
        {(
          [
            [
              "automatic",
              "Automatic",
              "Coordinators choose roles and models; your pinned roles and settings stay authoritative.",
            ],
            ["custom", "Custom", "Coordinators work within your roster."],
          ] as const
        ).map(([value, title, hint]) => (
          <label
            key={value}
            className={configuration.team === value ? "selected" : ""}
            title={hint}
          >
            <input
              type="radio"
              name={`team-mode-${session.id}`}
              checked={configuration.team === value}
              onChange={() => void update("team", { team: value })}
            />
            {title}
          </label>
        ))}
      </fieldset>
      {session.automatic.rejections.length > 0 && (
        <details>
          <summary>
            Automatic choices not applied ({session.automatic.rejections.length}
            )
          </summary>
          <ul>
            {session.automatic.rejections.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <ul className="team-summary" aria-label="Session roles">
        {roles.map((r) => (
          <li key={r.role.id} className={r.active ? "" : "muted"}>
            <strong>{r.role.title}:</strong> {teamLine(r.group)}{" "}
            <span className="tiny">
              {r.pinned ? "· yours" : r.explanation ? "· automatic" : ""}
              {!r.active ? " · not used" : ""}
              {r.owned ? " · this session's role" : ""}
            </span>
            {r.explanation && (
              <div className="muted tiny">Why: {r.explanation}</div>
            )}
            <div className="actions">
              <button type="button" onClick={() => setEditing(r.role.id)}>
                Edit
              </button>
              {configuration.team === "custom" || r.pinned ? (
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      `pin-${r.role.id}`,
                      setRole(r.role.id, r.pinned ? null : {}),
                    )
                  }
                >
                  {r.pinned
                    ? configuration.team === "custom"
                      ? "Remove from roster"
                      : "Unpin"
                    : "Add to roster"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    void run(`pin-${r.role.id}`, setRole(r.role.id, {}))
                  }
                >
                  Pin role
                </button>
              )}
              {(r.owned || r.pinned) && (
                <button
                  type="button"
                  onClick={() =>
                    void run(`save-role-${r.role.id}`, {
                      type: "session-role-save",
                      sessionId: session.id,
                      roleId: r.role.id,
                      commandId: newCommandId(),
                    })
                  }
                >
                  Save as project default
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editorRole && (
        <RoleEditor
          key={`${session.id}:${editing}`}
          projectId={session.projectId}
          goalId={null}
          role={editorRole.role}
          group={editorRole.group}
          routes={snapshot.routes}
          policyLimit={snapshot.policy.maxMembersPerRole}
          run={run}
          onClose={() => setEditing(null)}
          scope={{
            save: (settings) => setRole(editorRole.role.id, settings),
            release: () => setRole(editorRole.role.id, null),
          }}
        />
      )}
      <details>
        <summary>New role for this session</summary>
        <div className="role-create">
          <label>
            Role ID{" "}
            <input
              value={draft.roleId}
              placeholder="api-writer"
              onChange={(e) => setDraft({ ...draft, roleId: e.target.value })}
            />
          </label>
          <label>
            Title{" "}
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            Instructions{" "}
            <textarea
              rows={3}
              value={draft.instructions}
              onChange={(e) =>
                setDraft({ ...draft, instructions: e.target.value })
              }
            />
          </label>
          <label>
            Purpose{" "}
            <select
              value={draft.purpose}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  purpose: e.target.value as typeof draft.purpose,
                })
              }
            >
              {purposes.map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={
              !/^[a-z][a-z0-9-]{0,63}$/.test(draft.roleId) ||
              !draft.title.trim() ||
              !draft.instructions.trim()
            }
            onClick={async () => {
              const added = await update("role-create", {
                roles: {
                  ...configuration.roles,
                  [draft.roleId]: {
                    settings: {},
                    title: draft.title.trim(),
                    instructions: draft.instructions.trim(),
                    purpose: draft.purpose,
                  },
                },
              });
              if (added)
                setDraft({
                  roleId: "",
                  title: "",
                  instructions: "",
                  purpose: "implementation",
                });
            }}
          >
            Add role
          </button>
        </div>
      </details>
    </div>
  );
}

/** The coordinators' attributed answers behind one shared response. */
export function Contributions({ intake }: { intake: any }) {
  const answers = intake.members.flatMap((m: any) =>
    m.contributions.map((c: any) => ({ member: m, c })),
  );
  if (!answers.length) return null;
  return (
    <details className="contributions">
      <summary>
        {intake.members.length === 1
          ? "Contribution"
          : `Contributions from ${intake.members.length} coordinators`}
      </summary>
      <ul>
        {answers.map(({ member, c }: any) => (
          <li key={c.id}>
            <strong>{member.memberId}</strong> · {providerName(member.provider)}{" "}
            · <code>{member.model}</code> · {label(c.phase)}
            {c.valid ? (
              c.output?.intent ? (
                <>
                  {" "}
                  · {intentLabel[c.output.intent] ?? c.output.intent}
                  <div className="turn-text">{c.output.reply}</div>
                </>
              ) : c.output?.stance ? (
                <>
                  {" "}
                  · {label(c.output.stance)}
                  {c.output.rationale && (
                    <div className="turn-text">{c.output.rationale}</div>
                  )}
                </>
              ) : c.output?.reply ? (
                <div className="turn-text">{c.output.reply}</div>
              ) : null
            ) : (
              <span role="status"> · not counted: {c.reason}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
