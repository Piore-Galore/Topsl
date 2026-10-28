import { useEffect, useRef, useState } from "react";
import type { AppState } from "../../../../packages/domain/types";
import {
  projectViews,
  viewLabel,
  type ProjectView,
} from "../../../../packages/domain/navigation";
import type { ProjectThreads } from "../state/threads";
import { ActionButton } from "./action-button";
import { AtlasIcon, Brand } from "./atlas";

const kindMark = { session: "◆", "goal-loop": "↻", endless: "∞" } as const;
const kindTitle = {
  session: "Session",
  "goal-loop": "Goal loop",
  endless: "Endless",
} as const;
/** Project tools: every project destination except the coordinator. */
const toolViews = projectViews.filter((v) => v !== "coordinator");

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
  threads,
  threadId,
  openThread,
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
  threads: Record<string, ProjectThreads>;
  threadId: string | null;
  /** Opens a thread of a project, or that project's home with none. */
  openThread: (threadId: string | null, projectId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(projectId ? [projectId] : []),
  );
  const [toolsOpen, setToolsOpen] = useState(true);
  // The selected project is always expanded, so its conversations show.
  useEffect(() => {
    if (projectId && !expanded.has(projectId))
      setExpanded((current) => new Set(current).add(projectId));
  }, [projectId]);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const inCoordinator = page === "project" && view === "coordinator";
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
      <ActionButton
        className={`new-conversation primary ${inCoordinator && !threadId ? "selected" : ""}`}
        // The "+" is drawn by atlas.css and is not part of the name.
        aria-label="New session"
        aria-current={inCoordinator && !threadId ? "page" : undefined}
        disabled={!projectId}
        onClick={() => {
          openThread(null, projectId);
          close();
        }}
      >
        New session
      </ActionButton>
      <nav className="global-navigation" aria-label="Main navigation">
        {globalLink("projects")}
      </nav>
      <div className="sidebar-projects">
        <div className="eyebrow">
          PROJECT
          <ActionButton aria-label="Add project" onClick={addProject}>
            +
          </ActionButton>
        </div>
        <ul className="project-tree" aria-label="Projects and sessions">
          {state.projects.map((project) => {
            const list = threads[project.id];
            const open = expanded.has(project.id);
            const selected = project.id === projectId;
            const hidden = list ? list.total - list.threads.length : 0;
            return (
              <li
                key={project.id}
                className={`project-node ${selected ? "selected" : ""}`}
              >
                <div className="project-row">
                  <ActionButton
                    className="tree-toggle"
                    aria-expanded={open}
                    aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`}
                    onClick={() => toggle(project.id)}
                  >
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                  </ActionButton>
                  <ActionButton
                    className="project-name"
                    onClick={() => {
                      openThread(null, project.id);
                      close();
                    }}
                  >
                    {project.name}
                  </ActionButton>
                  {!!list?.needsYou && (
                    <span
                      className="count warm"
                      title={`${list.needsYou} waiting on you`}
                    >
                      {list.needsYou}
                      <span className="visually-hidden"> waiting on you</span>
                    </span>
                  )}
                </div>
                {open && (
                  <ul
                    className="thread-list"
                    aria-label={`${project.name} sessions`}
                  >
                    {list?.threads.map((t) => {
                      const current =
                        inCoordinator && selected && threadId === t.threadId;
                      return (
                        <li
                          key={t.threadId}
                          className={`thread-row ${t.needsYou ? "needs-you" : ""}`}
                        >
                          <ActionButton
                            className={`thread-link ${current ? "selected" : ""}`}
                            aria-current={current ? "page" : undefined}
                            title={`${kindTitle[t.kind]} · ${t.state}`}
                            onClick={() => {
                              openThread(t.threadId, project.id);
                              close();
                            }}
                          >
                            <span className="thread-mark" aria-hidden="true">
                              {kindMark[t.kind]}
                            </span>
                            <span className="thread-title">{t.title}</span>
                          </ActionButton>
                          {t.needsYou && (
                            <span className="thread-attention">
                              {t.needsYou}
                            </span>
                          )}
                        </li>
                      );
                    })}
                    {list && !list.total && (
                      <li className="tiny muted">No sessions yet.</li>
                    )}
                    {hidden > 0 && (
                      <li>
                        <ActionButton
                          className="thread-more"
                          onClick={() => {
                            openThread(null, project.id);
                            close();
                          }}
                        >
                          {hidden} older in {project.name}
                        </ActionButton>
                      </li>
                    )}
                  </ul>
                )}
                {selected && (
                  <div className="project-tools">
                    <ActionButton
                      className="tools-toggle"
                      aria-expanded={toolsOpen}
                      onClick={() => setToolsOpen(!toolsOpen)}
                    >
                      Project tools
                    </ActionButton>
                    {toolsOpen && (
                      <nav
                        className="project-navigation"
                        aria-label="Project navigation"
                      >
                        {toolViews.map((item) => (
                          <ActionButton
                            key={item}
                            className={`nav ${page === "project" && view === item ? "selected" : ""}`}
                            aria-current={
                              page === "project" && view === item
                                ? "page"
                                : undefined
                            }
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
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
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
