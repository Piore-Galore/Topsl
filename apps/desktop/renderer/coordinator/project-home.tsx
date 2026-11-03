import { useContext, useEffect, useRef, useState } from "react";
import { Freshness } from "../components/freshness";
import { useDraft } from "../state/drafts";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import type {
  ComposerMode,
  TeamMode,
} from "../../../../packages/domain/sessions";
import type { MemberIntent } from "../../../../packages/domain/role-groups";
import {
  omissionLines,
  type HistoryReference,
  type ReferenceOmissions,
} from "../../../../packages/domain/history-imports";
import { Composer } from "./composer";
import {
  CoordinatorPicker,
  coordinatorOptions,
  providerName,
  rolePurposes,
} from "./session-panes";
import { ComposerModes } from "./session-thread";
import {
  CheckFields,
  Errors,
  OpenProviders,
  checksFrom,
  emptyCheck,
  newCommandId,
  useCommandRunner,
  useRuntimeRefresh,
  type CheckDraft,
} from "./shared";

/** A role the owner defines for the new session only. */
interface OwnRole {
  roleId: string;
  title: string;
  instructions: string;
  purpose: (typeof rolePurposes)[number][0];
}

/**
 * A role ID from the title. The short suffix keeps it apart from roles
 * other sessions own, which this page cannot see.
 */
function ownRoleId(title: string, taken: string[]): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^(?![a-z])/, "role-")
      .slice(0, 50)
      .replace(/-+$/, "") || "role";
  for (;;) {
    const id = `${slug}-${crypto.randomUUID().slice(0, 4)}`;
    if (!taken.includes(id)) return id;
  }
}

const emptyOwnRole = {
  title: "",
  instructions: "",
  purpose: "implementation" as OwnRole["purpose"],
};

/** What a new session would freeze from an attached import. */
interface Excerpt {
  reference: HistoryReference;
  includedMessages: number;
  omissions: ReferenceOmissions;
  characters: number;
}

/** The import a new session starts with: its source, size and omissions. */
export function ReferenceCard({
  title,
  provider,
  formatLabel,
  included,
  omissions,
  onRemove,
}: {
  title: string;
  provider: string;
  formatLabel: string;
  included: string;
  omissions: ReferenceOmissions;
  onRemove?: () => void;
}) {
  const omitted = omissionLines(omissions);
  return (
    <section className="reference-card" aria-label="Attached reference">
      <div>
        <strong>Reference: {title}</strong>
        <span className="muted tiny">
          {" "}
          {providerName(provider)} export · {formatLabel} · {included}
        </span>
      </div>
      <p className="muted tiny">
        Background for the coordinators, kept apart from your request. It grants
        no permissions and is not an accepted result.
      </p>
      {omitted.length > 0 && (
        <details>
          <summary>Not all of the import is included</summary>
          <ul>
            {omitted.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove}>
          Remove reference
        </button>
      )}
    </section>
  );
}

/**
 * The New session page (docs/UX_Cleanup_Plan.md §1): the message box comes
 * first, with one Auto coordinator and an Automatic team summarized beside
 * it. Choosing models, the team, the goal kind and a required check are
 * explicit controls; a custom team takes project roles and roles the owner
 * defines for this session. An import from Settings → Imports can be
 * attached; the owner's next message starts the session.
 */
export function ProjectHome({
  projectId,
  projectName,
  onThread,
  attachment,
  onAttachment,
}: {
  projectId: string;
  projectName?: string;
  projectPath?: string;
  onThread: (threadId: string) => void;
  attachment: string | null;
  onAttachment: (referenceId: string | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [coordinators, setCoordinators] = useState<MemberIntent[]>([]);
  const [team, setTeam] = useState<TeamMode>("automatic");
  const [roster, setRoster] = useState<string[]>([]);
  const [ownRoles, setOwnRoles] = useState<OwnRole[]>([]);
  const [roleDraft, setRoleDraft] = useState(emptyOwnRole);
  const openProviders = useContext(OpenProviders);
  const [composerMode, setComposerMode] = useState<ComposerMode>("auto");
  const [kind, setKind] = useState<"code" | "information">("code");
  const [check, setCheck] = useState<CheckDraft>(emptyCheck);
  const [customizing, setCustomizing] = useState(false);
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null);
  const [excerptError, setExcerptError] = useState("");
  const [text, setText] = useDraft(`${projectId}:home`);
  const reads = useRef(new ScopedReadFence(projectId));
  async function refresh() {
    const ticket = reads.current.begin();
    const value = await window.topsl.command({
      type: "orchestration-query",
      projectId,
    });
    if (reads.current.accept(ticket, value)) setSnapshot(value);
  }
  const freshness = useScopedRefresh(projectId, refresh);
  const { run, errors } = useCommandRunner(refresh, projectId);
  useRuntimeRefresh(refresh);
  useEffect(() => {
    setExcerpt(null);
    setExcerptError("");
    if (!attachment) return;
    let live = true;
    window.topsl
      .command({ type: "history-import-excerpt", projectId, id: attachment })
      .then((value: Excerpt) => live && setExcerpt(value))
      .catch((e: any) => live && setExcerptError(e.message));
    return () => {
      live = false;
    };
  }, [projectId, attachment]);
  const readyRoutes = (snapshot?.routes ?? []).filter(
    (r: any) => r.purposes?.["coordinator-contribution"]?.ready,
  );
  const teamRoles = (snapshot?.roles ?? []).filter(
    (r: any) => r.role.purpose !== "coordinator-contribution",
  );
  const options = snapshot ? coordinatorOptions(snapshot.routes) : [];
  const coordinatorSummary = coordinators.length
    ? coordinators
        .map((m) =>
          m.pin
            ? `${
                options.find((o) => o.model === m.pin?.model)?.name ??
                m.pin.model ??
                "Pinned"
              }${m.pin.effort ? ` (${m.pin.effort})` : ""}`
            : "Auto",
        )
        .join(", ")
    : "Auto";
  const checks = checksFrom(check);
  async function send() {
    const message = text.trim();
    if (!message) return;
    const started = await run("start", {
      type: "session-create",
      projectId,
      text: message,
      mode: composerMode,
      kind,
      ...(kind === "code" ? { checks } : {}),
      ...(attachment && excerpt ? { referenceId: attachment } : {}),
      configuration: {
        coordinators,
        team,
        composerMode,
        roles:
          team === "custom"
            ? Object.fromEntries([
                ...roster.map((r) => [r, { settings: {} }]),
                ...ownRoles.map(({ roleId, ...role }) => [
                  roleId,
                  { settings: {}, ...role },
                ]),
              ])
            : {},
      },
      commandId: newCommandId(),
    });
    if (started?.sessionId) {
      setText("");
      setOwnRoles([]);
      onAttachment(null);
      onThread(`session:${started.sessionId}`);
    }
  }
  return (
    <section aria-label="New session" className="project-home">
      <header className="thread-header">
        <div className="thread-title">
          <h1>New session</h1>
          {projectName && <span className="muted">{projectName}</span>}
        </div>
      </header>
      <Freshness state={freshness} retry={freshness.retry} />
      <Errors errors={errors} />
      {snapshot && !readyRoutes.length && (
        <p role="status" className="session-attention">
          <span>
            No provider can coordinate yet. Qualify Codex or Claude Code under
            Providers; the session waits until one can answer.
          </span>
          {openProviders && (
            <button type="button" onClick={openProviders}>
              Open Providers
            </button>
          )}
        </p>
      )}
      {attachment &&
        (excerpt ? (
          <ReferenceCard
            title={excerpt.reference.fileName}
            provider={excerpt.reference.provider}
            formatLabel={excerpt.reference.formatLabel}
            included={
              excerpt.reference.structured
                ? `newest ${excerpt.includedMessages} of ${excerpt.reference.messageCount} messages`
                : `${excerpt.characters.toLocaleString()} characters`
            }
            omissions={excerpt.omissions}
            onRemove={() => onAttachment(null)}
          />
        ) : excerptError ? (
          <p role="alert">
            The attached import cannot be used: {excerptError}{" "}
            <button type="button" onClick={() => onAttachment(null)}>
              Remove reference
            </button>
          </p>
        ) : (
          <p role="status">Loading the attached import…</p>
        ))}
      <Composer
        value={text}
        onChange={setText}
        onSend={() => void send()}
        sendLabel="Start session"
        placeholder={
          excerpt
            ? "What should the coordinators do with this reference?"
            : 'For example: "How does the importer handle large files?" or "Add a retry to the upload client."'
        }
      >
        <ComposerModes
          value={composerMode}
          onChange={setComposerMode}
          name="home-composer-mode"
        />
        <button
          type="button"
          className="team-summary-button"
          aria-expanded={customizing}
          aria-controls="session-setup"
          onClick={() => {
            // Runtime changes reach this page up to two seconds late; the
            // picker reads the routes afresh when it opens.
            if (!customizing) void refresh();
            setCustomizing(!customizing);
          }}
        >
          Coordinator: {coordinatorSummary} · Team:{" "}
          {team === "automatic"
            ? "Automatic"
            : `Custom (${roster.length + ownRoles.length})`}
        </button>
        <details className="composer-options-panel">
          <summary>
            Options
            {kind === "information" ? " · information only" : ""}
            {kind === "code" && checks.length ? " · required check" : ""}
          </summary>
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
          {kind === "code" && (
            <fieldset>
              <legend>Required check (optional)</legend>
              <p className="muted">
                Runs against the integrated candidate after review; acceptance
                needs its passing result.
              </p>
              <CheckFields draft={check} setDraft={setCheck} />
            </fieldset>
          )}
        </details>
      </Composer>
      {customizing && snapshot && (
        <div className="session-setup" id="session-setup">
          <CoordinatorPicker
            routes={snapshot.routes}
            value={coordinators}
            onChange={setCoordinators}
          />
          <fieldset className="team-setup" aria-label="Team setup">
            <legend>Team</legend>
            <div className="segmented">
              {(
                [
                  ["automatic", "Automatic"],
                  ["custom", "Custom"],
                ] as const
              ).map(([value, title]) => (
                <label key={value} className={team === value ? "selected" : ""}>
                  <input
                    type="radio"
                    name="session-team-mode"
                    checked={team === value}
                    onChange={() => setTeam(value)}
                  />
                  {title}
                </label>
              ))}
            </div>
            <p className="muted">
              {team === "automatic"
                ? "Coordinators choose roles and models within your permissions and limits, and explain each choice in Team."
                : "Coordinators work within the roles you pick or add here."}
            </p>
            {team === "custom" && (
              <>
                {teamRoles.length > 0 && (
                  <ul className="roster-picker" aria-label="Custom roster">
                    {teamRoles.map((r: any) => (
                      <li key={r.role.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={roster.includes(r.role.id)}
                            onChange={(e) =>
                              setRoster(
                                e.target.checked
                                  ? [...roster, r.role.id]
                                  : roster.filter((x) => x !== r.role.id),
                              )
                            }
                          />
                          {r.role.title}
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                {ownRoles.length > 0 && (
                  <ul className="own-roles" aria-label="Your roles">
                    {ownRoles.map((r) => (
                      <li key={r.roleId}>
                        <span>
                          <strong>{r.title}</strong>{" "}
                          <span className="muted tiny">
                            · {rolePurposes.find(([v]) => v === r.purpose)?.[1]}
                          </span>
                          <span className="muted own-role-instructions">
                            {r.instructions}
                          </span>
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove role ${r.title}`}
                          onClick={() =>
                            setOwnRoles(
                              ownRoles.filter((x) => x.roleId !== r.roleId),
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <details className="own-role-create" open={!teamRoles.length}>
                  <summary>Add your own role</summary>
                  <div className="role-create">
                    <label>
                      Role title
                      <input
                        value={roleDraft.title}
                        placeholder="For example: API writer"
                        maxLength={200}
                        onChange={(e) =>
                          setRoleDraft({ ...roleDraft, title: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      What this role does
                      <textarea
                        rows={3}
                        value={roleDraft.instructions}
                        maxLength={8000}
                        placeholder="For example: Writes the HTTP handlers and keeps the OpenAPI file in step."
                        onChange={(e) =>
                          setRoleDraft({
                            ...roleDraft,
                            instructions: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Kind of work
                      <select
                        value={roleDraft.purpose}
                        onChange={(e) =>
                          setRoleDraft({
                            ...roleDraft,
                            purpose: e.target.value as OwnRole["purpose"],
                          })
                        }
                      >
                        {rolePurposes.map(([value, title]) => (
                          <option key={value} value={value}>
                            {title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={
                        !roleDraft.title.trim() ||
                        !roleDraft.instructions.trim()
                      }
                      onClick={() => {
                        const title = roleDraft.title.trim();
                        setOwnRoles([
                          ...ownRoles,
                          {
                            roleId: ownRoleId(title, [
                              ...teamRoles.map((r: any) => r.role.id),
                              ...ownRoles.map((r) => r.roleId),
                            ]),
                            title,
                            instructions: roleDraft.instructions.trim(),
                            purpose: roleDraft.purpose,
                          },
                        ]);
                        setRoleDraft(emptyOwnRole);
                      }}
                    >
                      Add role
                    </button>
                  </div>
                </details>
              </>
            )}
          </fieldset>
        </div>
      )}
    </section>
  );
}
