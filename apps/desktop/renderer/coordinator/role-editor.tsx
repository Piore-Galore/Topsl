import { useMemo, useState } from "react";
import type { Command } from "../../../../packages/domain/commands";
import type {
  CollaborationMode,
  MemberIntent,
  MemberPin,
  RoleGroupSettings,
  SchedulingKind,
  SelectionForm,
} from "../../../../packages/domain/role-groups";
import { label, newCommandId } from "./shared";

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

export interface ModelOption {
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
 * Options whose provider, name or model ID contain every word of the search,
 * ignoring case, so "opus claude" finds Claude's Opus models.
 */
export function filterModelOptions(
  options: ModelOption[],
  search: string,
): ModelOption[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((o) => {
    const text = `${o.provider} ${o.name} ${o.model}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * A pin for a model ID the person typed, or null when the search is not one
 * ID or an observed option already offers that exact model for the provider.
 * Claude Code has no model list, so its catalog holds only qualified models;
 * a typed ID stays unresolved until a catalog observes it (RG-08).
 */
export function typedModelPin(
  options: ModelOption[],
  search: string,
  provider: ModelOption["provider"] | "",
): MemberPin | null {
  const model = search.trim();
  if (!model || /\s/.test(model) || model.length > 200) return null;
  if (
    options.some(
      (o) => o.model === model && (!provider || o.provider === provider),
    )
  )
    return null;
  return provider ? { provider, model } : { model };
}

/**
 * The editor for one role's members. It renders a scrollable collection
 * with per-member controls and a visible total, so a third, fifth or later
 * member is added the same way as the second.
 */
export function RoleEditor({
  projectId,
  goalId,
  role,
  group,
  routes,
  policyLimit,
  run,
  onClose,
}: {
  projectId: string;
  goalId: string | null;
  role: any;
  group: any;
  routes: any[];
  policyLimit: number;
  run: (key: string, command: Command) => Promise<unknown>;
  onClose: () => void;
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
  const [typedProvider, setTypedProvider] = useState<
    ModelOption["provider"] | ""
  >("");
  const options = useMemo(
    () => modelOptions(routes, role.purpose),
    [routes, role.purpose],
  );
  const filtered = filterModelOptions(options, search);
  const typed = typedModelPin(options, search, typedProvider);
  const [picked, setPicked] = useState("");
  // A search that narrows to one model selects it, so typing an ID and
  // pressing Add selected model works without opening the list.
  const pickedOption =
    filtered.find((o) => o.key === picked) ??
    (filtered.length === 1 ? filtered[0] : null);
  const total = form === "exact" ? members.length : Number(count) || null;
  function add(option: ModelOption | null) {
    addPin(
      option
        ? {
            label: option.name,
            provider: option.provider,
            installationId: option.installationId,
            model: option.model,
          }
        : null,
    );
  }
  function addPin(pin: MemberPin | null) {
    const n = members.length + 1;
    setMembers([
      ...members,
      {
        memberId: `${role.id}-${n}-${Math.random().toString(36).slice(2, 6)}`,
        required: true,
        pin,
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
      // "At most" bounds Auto only when no exact count is given.
      ...(form !== "exact" && !count && maxCount
        ? { maxCount: Number(maxCount) }
        : {}),
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
          {!count && (
            <label>
              At most{" "}
              <input
                type="number"
                min={1}
                value={maxCount}
                onChange={(e) => setMaxCount(e.target.value)}
              />
            </label>
          )}
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
                onClick={() => {
                  // As the service's release: the slot stays and Auto fills
                  // it, so an exact roster becomes pins plus Auto.
                  if (form === "exact") {
                    setForm("required-plus-auto");
                    setCount(String(members.length));
                  }
                  setMembers(
                    members.map((x) =>
                      x.memberId === m.memberId
                        ? { ...x, pin: null, fallbacks: [] }
                        : x,
                    ),
                  );
                }}
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
      <label>
        Model{" "}
        <select
          aria-label="Model picker"
          value={pickedOption?.key ?? ""}
          onChange={(e) => setPicked(e.target.value)}
        >
          <option value="">
            {filtered.length
              ? `Choose one of ${filtered.length} ${filtered.length === 1 ? "model" : "models"}`
              : "No observed model matches"}
          </option>
          {(["claude", "codex"] as const).map((provider) => {
            const group = filtered.filter((o) => o.provider === provider);
            return group.length ? (
              <optgroup key={provider} label={label(provider)}>
                {group.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.name} ({o.model})
                    {o.available ? "" : " · unavailable now"}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
      </label>{" "}
      <button
        type="button"
        disabled={!pickedOption}
        title={pickedOption?.reason || undefined}
        onClick={() => {
          add(pickedOption);
          setPicked("");
        }}
      >
        Add selected model
      </button>
      {pickedOption && !pickedOption.available && (
        <p className="muted">Unavailable now: {pickedOption.reason}</p>
      )}
      {!options.length ? (
        <p className="muted">
          No model catalog is loaded for these runtimes. Inspect a Codex runtime
          or qualify Claude Code under Applications to list its models, or pin
          the model ID you type above.
        </p>
      ) : (
        !filtered.length && (
          <p className="muted">
            No observed model matches the search. You can pin the model ID you
            typed.
          </p>
        )
      )}
      {typed && !filtered.length && (
        <div className="typed-model">
          <label>
            Provider for the typed ID{" "}
            <select
              value={typedProvider}
              onChange={(e) =>
                setTypedProvider(e.target.value as ModelOption["provider"] | "")
              }
            >
              <option value="">Any provider</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>{" "}
          <button
            type="button"
            onClick={() => {
              addPin(typed);
              setSearch("");
            }}
          >
            Pin model ID {typed.model}
          </button>
          <p className="muted">
            A typed ID is kept as your choice but stays unresolved until a
            runtime catalog or Claude qualification observes it; Topsl never
            substitutes another model.
          </p>
        </div>
      )}
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
          onClick={async () => {
            const released = await run(`release-${role.id}`, {
              type: "orchestration-roster-release",
              projectId,
              goalId,
              roleId: role.id,
              commandId: newCommandId(),
            });
            // The editor shows what was saved, so a later save cannot bring
            // the released roster back.
            if (released) {
              setForm("auto");
              setMembers([]);
              setCount("");
              setMaxCount("");
            }
          }}
        >
          Return whole role to Auto
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </fieldset>
  );
}

export function MemberCard({ member }: { member: any }) {
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
