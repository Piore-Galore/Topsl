import { ActionButton } from "./components/action-button";
import {
  startingTerminalMode,
  terminalProvider,
  TerminalModeNote,
  TerminalModeSelect,
} from "./components/terminal-mode";
import type { TerminalModeId } from "../../../packages/domain/terminal-modes";
import { useState } from "react";
import type {
  AppState,
  Project,
  ProjectOpenResult,
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

/**
 * One folder of the local catalog (docs/UX_Cleanup_Plan.md §2): open it,
 * rename or move it in Topsl, copy its path, trust or relink it, or open a
 * provider CLI's terminal in it.
 */
function ProjectCard({
  project,
  index,
  count,
  ...props
}: Props & { project: Project; index: number; count: number }) {
  const { state, busy, act, selectProject, openTerminal } = props;
  const [installationId, setInstallationId] = useState("");
  const [opened, setOpened] = useState<ProjectOpenResult | null>(null);
  const [name, setName] = useState<string | null>(null);
  /** A mode picked for the next terminal; otherwise auto-accept's or the project's remembered one. */
  const [modeChoice, setModeChoice] = useState<TerminalModeId | null>(null);
  const available =
    !project.availability || project.availability === "available";
  const selectedInstallation = state.installations.find(
    (installation) => installation.id === installationId,
  );
  const terminal = selectedInstallation
    ? terminalProvider(selectedInstallation)
    : null;
  const mode: TerminalModeId = terminal
    ? (modeChoice ?? startingTerminalMode(state, project.id, terminal))
    : "provider-default";
  const move = (direction: "up" | "down") =>
    void act({
      type: "project-move",
      id: project.id,
      direction,
      expectedOrderRevision: state.projectOrderRevision,
    });
  return (
    <article className="project-card" aria-label={project.name}>
      <div className="section-heading">
        {name === null ? (
          <h2>{project.name}</h2>
        ) : (
          <form
            className="actions"
            onSubmit={async (event) => {
              event.preventDefault();
              const renamed = await act({
                type: "project-rename",
                id: project.id,
                expectedName: project.name,
                name,
              });
              if (renamed) setName(null);
            }}
          >
            <input
              aria-label={`New name for ${project.name}`}
              value={name}
              maxLength={200}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setName(null);
              }}
            />
            <ActionButton disabled={busy || !name.trim()}>
              Save name
            </ActionButton>
            <ActionButton type="button" onClick={() => setName(null)}>
              Cancel
            </ActionButton>
          </form>
        )}
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
      {!available && (
        <p>Relink this project’s folder to keep using its history.</p>
      )}
      <div className="actions wrap">
        <ActionButton disabled={busy} onClick={() => selectProject(project.id)}>
          Open
        </ActionButton>
        {name === null && (
          <ActionButton disabled={busy} onClick={() => setName(project.name)}>
            Rename
          </ActionButton>
        )}
        <ActionButton
          aria-label={`Move ${project.name} up`}
          disabled={busy || index === 0}
          onClick={() => move("up")}
        >
          ↑
        </ActionButton>
        <ActionButton
          aria-label={`Move ${project.name} down`}
          disabled={busy || index === count - 1}
          onClick={() => move("down")}
        >
          ↓
        </ActionButton>
        {!project.trusted && available && (
          <ActionButton
            disabled={busy}
            onClick={() => void act({ type: "project-trust", id: project.id })}
          >
            Trust folder…
          </ActionButton>
        )}
        <ActionButton
          disabled={busy}
          onClick={() => void act({ type: "project-relink", id: project.id })}
        >
          Relink folder…
        </ActionButton>
        <ActionButton
          disabled={busy}
          onClick={() =>
            void act({ type: "project-copy-path", id: project.id })
          }
        >
          Copy path
        </ActionButton>
      </div>
      <div className="project-open">
        <label>
          Open a terminal in
          <select
            value={selectedInstallation?.id ?? ""}
            onChange={(event) => {
              setInstallationId(event.target.value);
              setModeChoice(null);
              setOpened(null);
            }}
          >
            <option value="">Choose a provider</option>
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
                  {app.name} ·{" "}
                  {state.testProfile ? "not searched" : "not installed"}
                </option>
              );
            })}
          </select>
        </label>
        {terminal && (
          <TerminalModeSelect
            provider={terminal}
            value={mode}
            onChange={setModeChoice}
          />
        )}
        <ActionButton
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
              permissionMode: mode,
            });
            // The menu returns to the remembered mode, which is never a bypass mode.
            setModeChoice(null);
            if (!result) return;
            setOpened(result);
            if (result.terminalId) openTerminal(project.id, result.terminalId);
          }}
        >
          Open terminal
        </ActionButton>
      </div>
      {terminal && <TerminalModeNote provider={terminal} value={mode} />}
      {selectedInstallation && !selectedInstallation.trusted && (
        <p className="tiny">
          Trust this executable in Providers before opening a terminal.
        </p>
      )}
      {opened && <p role="status">{opened.detail}</p>}
    </article>
  );
}

export function Projects(props: Props) {
  const { state, busy, addProject } = props;
  const [query, setQuery] = useState("");
  const projects = state.projects.filter((project) =>
    (project.name + " " + project.path)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Projects</h1>
        </div>
        <ActionButton className="primary" disabled={busy} onClick={addProject}>
          + Add folder
        </ActionButton>
      </div>
      {state.projects.length > 6 && (
        <div className="search">
          <input
            aria-label="Filter projects"
            placeholder="Find a project or folder…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      <div className="project-grid">
        {projects.map((project) => (
          <ProjectCard
            {...props}
            project={project}
            key={project.id}
            index={state.projects.indexOf(project)}
            count={state.projects.length}
          />
        ))}
      </div>
      {!projects.length && (
        <div className="empty-row">
          {query ? "No matching projects." : "Add a folder to begin."}
        </div>
      )}
    </>
  );
}
