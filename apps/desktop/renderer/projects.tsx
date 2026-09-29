import React, { useState } from "react";
import type {
  AppState,
  Project,
  ProjectOpenResult,
  NativeProject,
} from "../../../packages/domain/types";
import type { Command } from "../../../packages/domain/commands";

interface Props {
  state: AppState;
  busy: boolean;
  act: (command: Command) => Promise<any>;
  addProject: () => void;
  selectProject: (id: string) => void;
  openTerminal: (projectId: string, terminalId: string) => void;
}
function ProjectCard({ project, ...props }: Props & { project: Project }) {
  const { state, busy, act, selectProject, openTerminal } = props;
  const [installationId, setInstallationId] = useState("");
  const [opened, setOpened] = useState<ProjectOpenResult | null>(null);
  const available =
    !project.availability || project.availability === "available";
  const sources = [
    ...new Set(
      (project.sources ?? []).map((ref) =>
        ref.sourceId === "codex-project-api"
          ? "Codex project registry"
          : (state.projectSync.sources.find(
              (source) => source.id === ref.sourceId,
            )?.name ?? ref.sourceId),
      ),
    ),
  ];
  const selectedInstallation = state.installations.find(
    (installation) => installation.id === installationId,
  );
  return (
    <article className="project-card" aria-label={project.name}>
      <div className="section-heading">
        <h2>{project.name}</h2>
        <span
          className={
            "badge " + (available && project.trusted ? "good" : "warm")
          }
        >
          {!available
            ? project.availability === "changed"
              ? "Folder changed"
              : "Folder unavailable"
            : project.trusted
              ? "Trusted folder"
              : "Needs trust"}
        </span>
      </div>
      <code className="path">{project.path}</code>
      <p className="tiny">
        {sources.length
          ? "Discovered in: " + sources.join(" · ")
          : "Saved in Topsl"}
      </p>
      {!available && (
        <p>Locate this project’s folder to keep using its existing history.</p>
      )}
      <div className="actions wrap">
        <button disabled={busy} onClick={() => selectProject(project.id)}>
          View workspace
        </button>
        {!project.trusted && available && (
          <button
            disabled={busy}
            onClick={() => void act({ type: "project-trust", id: project.id })}
          >
            Trust folder…
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => void act({ type: "project-relink", id: project.id })}
        >
          Relink folder…
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void act({ type: "project-copy-path", id: project.id })
          }
        >
          Copy folder path
        </button>
      </div>
      <div className="project-open">
        <label>
          Open this folder in
          <select
            value={selectedInstallation?.id ?? ""}
            onChange={(event) => {
              setInstallationId(event.target.value);
              setOpened(null);
            }}
          >
            <option value="">Choose an application</option>
            {state.applications.map((app) => {
              const installations = state.installations.filter(
                (installation) => installation.appId === app.id,
              );
              return installations.length ? (
                <optgroup label={app.name} key={app.id}>
                  {installations.map((installation) => (
                    <option key={installation.id} value={installation.id}>
                      {app.name} · {installation.version ?? "unknown version"} ·{" "}
                      {installation.path}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option disabled key={app.id}>
                  {app.name} · not installed
                </option>
              );
            })}
          </select>
        </label>
        <button
          disabled={
            busy ||
            !available ||
            !project.trusted ||
            !selectedInstallation?.trusted
          }
          onClick={async () => {
            const result: ProjectOpenResult | undefined = await act({
              type: "project-open",
              projectId: project.id,
              installationId,
            });
            if (!result) return;
            setOpened(result);
            if (result.terminalId) openTerminal(project.id, result.terminalId);
          }}
        >
          Open folder
        </button>
      </div>
      {selectedInstallation && !selectedInstallation.trusted && (
        <p className="tiny">
          Trust this executable in Applications before opening the folder.
        </p>
      )}
      {selectedInstallation?.appId.endsWith("desktop") && (
        <p className="tiny">
          {selectedInstallation.appId === "anthropic.claude-desktop"
            ? `Opens this folder in Claude Code${state.platform.startsWith("darwin/") ? " in the selected app" : " through the system’s registered Claude app"}. Claude will ask you to confirm folder access.`
            : selectedInstallation.appId === "openai.desktop" &&
                state.platform.startsWith("darwin/")
              ? "Opens the folder in the selected desktop app. Check the native project picker after opening."
              : "Opens the selected app; choose this folder in its native project picker."}
        </p>
      )}
      {opened && <p role="status">{opened.detail}</p>}
    </article>
  );
}
function NativeProjectRow({
  project,
  index,
  props,
}: {
  project: NativeProject;
  index: number;
  props: Props;
}) {
  const sync = props.state.codexProjectSync;
  const disabled =
    props.busy || sync.refreshing || !sync.enabled || sync.status !== "ready";
  const [edit, setEdit] = useState<{ name: string; revision: string } | null>(
    null,
  );
  return (
    <div className="native-project-row">
      <div>
        {edit ? (
          <form
            className="actions"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await props.act({
                type: "codex-project-rename",
                id: project.id,
                expectedRevision: edit.revision,
                name: edit.name.trim(),
              });
              if (result) setEdit(null);
            }}
          >
            <input
              aria-label={`Rename ${project.name}`}
              value={edit.name}
              maxLength={200}
              onChange={(event) =>
                setEdit({ ...edit, name: event.target.value })
              }
            />
            <button disabled={disabled || !edit.name.trim()}>Save name</button>
            <button type="button" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <strong>{project.name}</strong>
        )}
        <details>
          <summary>
            {project.roots.length}{" "}
            {project.roots.length === 1 ? "folder" : "folders"}
          </summary>
          {project.roots.map((root) => (
            <code className="path" key={root}>
              {root}
            </code>
          ))}
        </details>
      </div>
      <div className="actions wrap">
        {!edit && (
          <button
            disabled={disabled}
            onClick={() =>
              setEdit({ name: project.name, revision: project.revision })
            }
          >
            Rename
          </button>
        )}
        <button
          aria-label={`Move ${project.name} up`}
          disabled={disabled || index === 0}
          onClick={() =>
            void props.act({
              type: "codex-project-move",
              id: project.id,
              beforeProjectId: sync.projects[index - 1].id,
              expectedOrderRevision: sync.orderRevision,
            })
          }
        >
          ↑
        </button>
        <button
          aria-label={`Move ${project.name} down`}
          disabled={disabled || index === sync.projects.length - 1}
          onClick={() =>
            void props.act({
              type: "codex-project-move",
              id: project.id,
              beforeProjectId: sync.projects[index + 2]?.id ?? null,
              expectedOrderRevision: sync.orderRevision,
            })
          }
        >
          ↓
        </button>
      </div>
    </div>
  );
}
function CodexRegistry(props: Props) {
  const { state, busy, act } = props;
  const sync = state.codexProjectSync;
  const [chosen, setChosen] = useState("");
  const runtimes = state.installations.filter(
    (i) => i.appId === "openai.codex-cli",
  );
  const installationId = chosen || sync.installationId || "";
  return (
    <section
      className="settings-card"
      aria-label="Codex project synchronization"
    >
      <div className="section-heading">
        <h2>Codex native projects</h2>
        <span
          className={
            "badge " + (sync.enabled && sync.status === "ready" ? "good" : "")
          }
        >
          {sync.refreshing
            ? "Syncing…"
            : !sync.enabled
              ? "Paused"
              : sync.status === "ready"
                ? "Registry synced"
                : "Needs attention"}
        </span>
      </div>
      <p>
        Share trusted folders with Codex and bring its project names and order
        here. Native multi-folder projects stay together.
      </p>
      <div className="project-open">
        <label>
          Codex runtime
          <select
            aria-label="Codex sync runtime"
            value={installationId}
            onChange={(event) => setChosen(event.target.value)}
            disabled={busy || sync.refreshing}
          >
            <option value="">Choose a trusted runtime</option>
            {runtimes.map((i) => (
              <option key={i.id} value={i.id} disabled={!i.trusted}>
                {i.version ?? "Unknown version"} · {i.path}
                {i.trusted ? "" : " · Trust in Applications first"}
              </option>
            ))}
          </select>
        </label>
        <div className="actions wrap">
          {(!sync.enabled ||
            sync.status === "error" ||
            installationId !== sync.installationId) && (
            <button
              disabled={
                busy ||
                sync.refreshing ||
                !runtimes.some((i) => i.id === installationId && i.trusted)
              }
              onClick={() =>
                void act({ type: "codex-project-sync-enable", installationId })
              }
            >
              {sync.enabled ? "Reconnect…" : "Enable Codex sync…"}
            </button>
          )}
          {sync.enabled && (
            <>
              <button
                disabled={busy || sync.refreshing}
                onClick={() => void act({ type: "codex-project-sync-refresh" })}
              >
                Sync now
              </button>
              <button
                disabled={busy}
                onClick={() => void act({ type: "codex-project-sync-pause" })}
              >
                Pause Codex sync
              </button>
            </>
          )}
        </div>
      </div>
      <p className="tiny" role="status">
        {sync.detail}
      </p>
      <details className="project-sources">
        <summary>
          {sync.projects.length} registered projects · Names, order, and
          connection
        </summary>
        <code className="path">{sync.home}</code>
        <p className="tiny">
          Refreshes every minute while enabled. Renames apply to every folder in
          a native project. Native removals retain Topsl history and are not
          recreated automatically. Desktop pins, sections, and chats remain
          native.
        </p>
        {sync.lastSuccessAt && (
          <p className="tiny">
            Last registry check: {new Date(sync.lastSuccessAt).toLocaleString()}
          </p>
        )}
        {sync.projects.map((project, index) => (
          <NativeProjectRow
            key={project.id}
            project={project}
            index={index}
            props={props}
          />
        ))}
      </details>
    </section>
  );
}
export function Projects(props: Props) {
  const { state, busy, act, addProject } = props;
  const [query, setQuery] = useState("");
  const sync = state.projectSync;
  const projects = state.projects.filter((project) =>
    (project.name + " " + project.path)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">SHARED LOCAL FOLDERS</div>
          <h1>Projects</h1>
          <p>Use the same project folders in Topsl, Codex, and Claude.</p>
        </div>
        <button className="primary" disabled={busy} onClick={addProject}>
          + Add project
        </button>
      </div>
      <section className="settings-card" aria-label="Project synchronization">
        <div className="section-heading">
          <h2>Project discovery</h2>
          <span className="badge">
            {sync.refreshing
              ? "Refreshing…"
              : sync.enabled
                ? "Every minute"
                : "Paused"}
          </span>
        </div>
        <p>
          Native project folders join one shared catalog. All apps work on the
          same files when they use the same folder.
        </p>
        <div className="actions wrap">
          <button
            disabled={busy}
            onClick={() =>
              void act({ type: "project-sync-enable", enabled: !sync.enabled })
            }
          >
            {sync.enabled ? "Pause discovery" : "Enable project discovery…"}
          </button>
          <button
            disabled={busy || !sync.enabled || sync.refreshing}
            onClick={() => void act({ type: "project-sync-refresh" })}
          >
            Refresh projects
          </button>
        </div>
        <details className="project-sources">
          <summary>
            Native source details ·{" "}
            {sync.sources.filter((source) => source.status === "ready").length}{" "}
            of {sync.sources.length} refreshed
            {sync.sources.some(
              (source) =>
                source.status === "error" || source.status === "missing",
            ) && " · Some sources unavailable"}
          </summary>
          {sync.sources.map((source) => (
            <div className="project-source" key={source.id}>
              <div className="section-heading">
                <strong>{source.name}</strong>
                <span className="badge">
                  {source.status === "ready"
                    ? "Metadata refreshed"
                    : source.status}
                </span>
              </div>
              <code className="path">{source.path}</code>
              <p>{source.detail}</p>
              {source.checkedAt && (
                <small>
                  Last check: {new Date(source.checkedAt).toLocaleString()} ·{" "}
                  {source.folders} folder references
                  {source.lastSuccessAt && source.status !== "ready"
                    ? " · Last success: " +
                      new Date(source.lastSuccessAt).toLocaleString()
                    : ""}
                </small>
              )}
            </div>
          ))}
        </details>
      </section>
      <CodexRegistry {...props} />
      <div className="search">
        <input
          aria-label="Filter projects"
          placeholder="Find a project or folder…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p>
        {projects.length} {projects.length === 1 ? "folder" : "folders"} · Trust
        discovered folders before starting a session.
      </p>
      <div className="project-grid">
        {projects.map((project) => (
          <ProjectCard {...props} project={project} key={project.id} />
        ))}
      </div>
      {!projects.length && (
        <div className="empty-row">
          {query
            ? "No matching projects."
            : "Add a folder or enable discovery to bring in projects from your native apps."}
        </div>
      )}
    </>
  );
}
