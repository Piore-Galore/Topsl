import { useEffect, useRef, useState } from "react";
import type { AppState } from "../../../../packages/domain/types";
import {
  projectViews,
  viewLabel,
  type ProjectView,
} from "../../../../packages/domain/navigation";
import { ActionButton } from "./action-button";
import { AtlasIcon, Brand } from "./atlas";

export type GlobalPage = "projects" | "applications" | "settings";

export function WorkbenchSidebar({
  state,
  page,
  projectId,
  view,
  open,
  close,
  navigate,
  selectProject,
  selectView,
  addProject,
  palette,
}: {
  state: AppState;
  page: GlobalPage | "project";
  projectId: string;
  view: ProjectView;
  open: boolean;
  close: () => void;
  navigate: (page: GlobalPage) => void;
  selectProject: (id: string) => void;
  selectView: (view: ProjectView) => void;
  addProject: () => void;
  palette: () => void;
}) {
  const [compact, setCompact] = useState(
    () => matchMedia("(max-width: 899px)").matches,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const media = matchMedia("(max-width: 899px)");
    const changed = () => setCompact(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!compact || !open) return;
    const trigger = document.activeElement;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, [compact, open]);
  const globalLink = (target: GlobalPage) => (
    <ActionButton
      key={target}
      className={`nav ${page === target ? "selected" : ""}`}
      aria-current={page === target ? "page" : undefined}
      onClick={() => {
        navigate(target);
        close();
      }}
    >
      <AtlasIcon name={target} />
      <span>{viewLabel(target)}</span>
      {target === "applications" &&
        state.checks.some((check) => check.status === "available") && (
          <span className="count">
            {
              state.checks.filter((check) => check.status === "available")
                .length
            }
          </span>
        )}
    </ActionButton>
  );
  const body = (
    <>
      <Brand />
      {compact && (
        <ActionButton className="drawer-close" onClick={close}>
          Close navigation
        </ActionButton>
      )}
      <nav className="global-navigation" aria-label="Main navigation">
        {globalLink("projects")}
      </nav>
      <div className="sidebar-projects">
        <div className="eyebrow">
          PROJECT INDEX
          <ActionButton aria-label="Add project" onClick={addProject}>
            +
          </ActionButton>
        </div>
        <label className="project-picker">
          Selected project
          <select
            aria-label="Selected project"
            value={projectId}
            onChange={(event) => {
              selectProject(event.target.value);
              close();
            }}
          >
            <option value="">Choose a project</option>
            {state.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <nav className="project-navigation" aria-label="Project navigation">
          {projectViews.map((item) => (
            <ActionButton
              key={item}
              className={`nav ${page === "project" && view === item ? "selected" : ""}`}
              aria-current={
                page === "project" && view === item ? "page" : undefined
              }
              disabled={!projectId}
              onClick={() => {
                selectView(item);
                close();
              }}
            >
              <AtlasIcon name={item} />
              <span>{viewLabel(item)}</span>
            </ActionButton>
          ))}
        </nav>
        {!state.projects.length && (
          <p className="tiny">
            Add a folder to begin. Native tools are under Applications.
          </p>
        )}
      </div>
      <div className="sidebar-bottom">
        <nav aria-label="Application navigation">
          {globalLink("applications")}
          {globalLink("settings")}
        </nav>
        <ActionButton
          className="palette-key"
          onClick={() => {
            palette();
            close();
          }}
        >
          Command palette{" "}
          <kbd>{state.platform.startsWith("darwin") ? "⌘" : "Ctrl"} K</kbd>
        </ActionButton>
        <div className="vault-status">
          <span className="status-dot" /> Local vault unlocked
        </div>
        <small>Personal pilot · {state.version}</small>
      </div>
    </>
  );
  return compact ? (
    <dialog
      className="sidebar sidebar-dialog"
      id="workbench-sidebar"
      aria-label="Workbench navigation"
      ref={dialog}
      onCancel={close}
    >
      {body}
    </dialog>
  ) : (
    <aside
      className="sidebar"
      id="workbench-sidebar"
      aria-label="Workbench navigation"
    >
      {body}
    </aside>
  );
}
