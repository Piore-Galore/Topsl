import { useRef, useState } from "react";
import type { Project } from "../../../../packages/domain/types";
import { summarizeUsage } from "../../../../packages/domain/usage";
import { UsageBudget } from "../components/reporting";
import { Freshness } from "../components/freshness";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { RoleEditor, teamLine } from "../coordinator/role-editor";
import {
  Errors,
  newCommandId,
  useCommandRunner,
  useRuntimeRefresh,
} from "../coordinator/shared";

/**
 * Project settings (docs/UX_Cleanup_Plan.md §1): the folder, the defaults
 * new sessions capture, limits, and project-wide controls.
 */
export function ProjectSettings({
  project,
  notice,
}: {
  project: Project;
  /** A retired destination this page replaces, if the owner came from one. */
  notice: string | null;
}) {
  const projectId = project.id;
  const [snapshot, setSnapshot] = useState<any>(null);
  const [scope, setScope] = useState<any>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [grant, setGrant] = useState<string | null>(null);
  const reads = useRef(new ScopedReadFence(projectId));
  async function refresh(accepted?: any) {
    const ticket = reads.current.begin();
    const [value, scoped] = await Promise.all([
      window.topsl.command({ type: "orchestration-query", projectId }),
      accepted ?? window.topsl.command({ type: "scope-snapshot", projectId }),
    ]);
    if (!reads.current.accept(ticket, value)) return;
    setSnapshot(value);
    setScope(scoped);
  }
  const freshness = useScopedRefresh(projectId, refresh);
  const { run, errors } = useCommandRunner(() => refresh(), projectId);
  useRuntimeRefresh(() => refresh());
  const available =
    !project.availability || project.availability === "available";
  const editorRole =
    editing && snapshot?.roles.find((r: any) => r.role.id === editing);
  const usage = summarizeUsage(
    scope?.usage ?? [],
    (scope?.runs ?? []).map((r: any) => r.id),
  );
  return (
    <section className="project-settings" aria-label="Project settings">
      <div className="page-heading">
        <div>
          <h1>Project settings</h1>
        </div>
      </div>
      {notice === "synchronization-retired" && (
        <p role="note" className="retirement-notice">
          Native project synchronization is retired. Topsl no longer reads or
          writes Codex or Claude project lists; this project's name, folder and
          order are managed here and in Projects.
        </p>
      )}
      <Freshness state={freshness} retry={freshness.retry} />
      <Errors errors={errors} />

      <section className="settings-card" aria-label="Folder">
        <h2>Folder</h2>
        {name === null ? (
          <p>
            <strong>{project.name}</strong>{" "}
            <button type="button" onClick={() => setName(project.name)}>
              Rename
            </button>
          </p>
        ) : (
          <form
            className="actions"
            onSubmit={async (e) => {
              e.preventDefault();
              const renamed = await run("rename", {
                type: "project-rename",
                id: projectId,
                expectedName: project.name,
                name,
              });
              if (renamed) setName(null);
            }}
          >
            <input
              aria-label="Project name"
              value={name}
              maxLength={200}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
            <button disabled={!name.trim()}>Save name</button>
            <button type="button" onClick={() => setName(null)}>
              Cancel
            </button>
          </form>
        )}
        <code className="path">{project.path}</code>
        <p className="muted">
          {!available
            ? project.availability === "changed"
              ? "The folder now resolves somewhere else. Relink it to keep this project's history."
              : "The folder is unavailable. Relink it to keep this project's history."
            : project.trusted
              ? "Trusted. Every run checks the folder again before it starts."
              : "Not trusted yet. Trust it before starting a session."}
        </p>
        <div className="actions wrap">
          {!project.trusted && available && (
            <button
              type="button"
              onClick={() =>
                void run("trust", { type: "project-trust", id: projectId })
              }
            >
              Trust folder…
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              void run("relink", { type: "project-relink", id: projectId })
            }
          >
            Relink folder…
          </button>
          <button
            type="button"
            onClick={() =>
              void run("copy", { type: "project-copy-path", id: projectId })
            }
          >
            Copy path
          </button>
        </div>
      </section>

      <section className="settings-card" aria-label="Defaults for new sessions">
        <h2>Defaults for new sessions</h2>
        <p className="muted">
          New sessions capture these teams when they start; later edits do not
          change existing sessions.
        </p>
        {!snapshot ? (
          <p role="status">Loading defaults…</p>
        ) : (
          <>
            <label>
              Members per role limit{" "}
              <input
                key={snapshot.policy.revision}
                type="number"
                min={1}
                max={64}
                defaultValue={snapshot.policy.maxMembersPerRole}
                onBlur={(e) =>
                  void run("policy", {
                    type: "orchestration-policy-set",
                    projectId,
                    expectedRevision: snapshot.policy.revision,
                    maxMembersPerRole: Number(e.target.value),
                    defaults: snapshot.policy.defaults ?? {},
                    commandId: newCommandId(),
                  })
                }
              />
            </label>
            <ul className="team-summary" aria-label="Role defaults">
              {snapshot.roles.map((r: any) => (
                <li key={r.role.id}>
                  <strong>{r.role.title}:</strong> {teamLine(r.group)}{" "}
                  <button
                    type="button"
                    aria-label={`Edit ${r.role.title} default`}
                    onClick={() => setEditing(r.role.id)}
                  >
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
          </>
        )}
      </section>

      <section className="settings-card" aria-label="Limits">
        <h2>Limits</h2>
        {snapshot && (
          <p className="muted">
            Capacity:{" "}
            {snapshot.capacity.held.reduce(
              (n: number, h: any) => n + h.weight,
              0,
            )}{" "}
            of {snapshot.capacity.total} reserved. A route with unknown native
            fan-out reserves the whole budget.
          </p>
        )}
        {scope && (
          <UsageBudget
            projectId={projectId}
            summary={usage}
            attempts={scope.coordination.attempts}
          />
        )}
      </section>

      <section className="settings-card" aria-label="Project controls">
        <h2>Project controls</h2>
        <div className="actions wrap">
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
            Stop every goal and loop
          </button>
          <button
            type="button"
            onClick={async () => {
              const result = await run("context", {
                type: "context-enable",
                projectId,
              });
              if (result)
                setGrant(
                  `Grant file: ${result.file}\n\n${result.expires}\n\nRun the companion with a Node.js installation:\nnode ${JSON.stringify(result.companionPath)} mcp ${JSON.stringify(result.file)}\n\nUse this executable and argument list in your native MCP configuration. Keep the grant file private.`,
                );
            }}
          >
            Share history with an MCP client…
          </button>
        </div>
        <p className="muted tiny">
          Stopping keeps results and uncertain executions. A history grant is
          read-only and expires when Topsl closes.
        </p>
        {grant && <pre className="snapshot">{grant}</pre>}
      </section>
    </section>
  );
}
