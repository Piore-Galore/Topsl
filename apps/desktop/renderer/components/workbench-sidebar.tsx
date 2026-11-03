import { useEffect, useRef, useState } from "react";
import type { AppState } from "../../../../packages/domain/types";
import {
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
/** The project menu's destinations (docs/UX_Cleanup_Plan.md §1). */
const menuViews: ProjectView[] = [
  "all-sessions",
  "project-settings",
  "sessions",
  "advanced",
];

export type GlobalPage = "projects" | "providers" | "settings";

/**
 * One project's menu: All sessions, Project settings, Provider tools and
 * Advanced workflows. Arrow keys move between its items; Escape closes it
 * and returns focus to its button.
 */
function ProjectMenu({
  projectName,
  current,
  choose,
  close,
  trigger,
}: {
  projectName: string;
  current: ProjectView | null;
  choose: (view: ProjectView) => void;
  close: () => void;
  trigger: HTMLButtonElement | null;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: MouseEvent) => {
      if (
        !list.current?.contains(event.target as Node) &&
        !trigger?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);
  const items = () => [
    ...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];
  return (
    <ul
      ref={list}
      className="project-menu"
      role="menu"
      aria-label={`${projectName} menu`}
      onKeyDown={(event) => {
        const buttons = items();
        const index = buttons.indexOf(document.activeElement as any);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          trigger?.focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          buttons[(index + step + buttons.length) % buttons.length]?.focus();
        } else if (event.key === "Tab") close();
      }}
    >
      {menuViews.map((view) => (
        <li key={view} role="none">
          <button
            type="button"
            role="menuitem"
            className={current === view ? "selected" : ""}
            aria-current={current === view ? "page" : undefined}
            onClick={() => choose(view)}
          >
            <AtlasIcon name={view} />
            <span>{viewLabel(view)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function WorkbenchSidebar({
  state,
  page,
  projectId,
  view,
  open,
  close,
  navigate,
  openProject,
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
  /** Opens a project at its last viewed session. */
  openProject: (id: string) => void;
  selectView: (view: ProjectView, projectId: string) => void;
  addProject: () => void;
  palette: () => void;
  threads: Record<string, ProjectThreads>;
  threadId: string | null;
  /** Opens a thread of a project, or that project's New session page with none. */
  openThread: (threadId: string | null, projectId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(projectId ? [projectId] : []),
  );
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  // The selected project is always expanded, so its sessions show.
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
      {target === "providers" &&
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
          PROJECTS
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
            const menuOpen = menuFor === project.id;
            const current =
              selected && page === "project" && view !== "coordinator"
                ? view
                : null;
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
                      openProject(project.id);
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
                  <button
                    type="button"
                    className={`project-menu-button ${current ? "selected" : ""}`}
                    aria-label={`Project menu for ${project.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    ref={(node) => {
                      if (node) triggers.current.set(project.id, node);
                      else triggers.current.delete(project.id);
                    }}
                    onClick={() => setMenuFor(menuOpen ? null : project.id)}
                  >
                    <AtlasIcon name="more" />
                  </button>
                </div>
                {current && !menuOpen && (
                  // Where the owner is in the project's menu; it reopens it.
                  <ActionButton
                    className="nav current-destination selected"
                    aria-current="page"
                    onClick={() => setMenuFor(project.id)}
                  >
                    <AtlasIcon name={current} />
                    <span>{viewLabel(current)}</span>
                  </ActionButton>
                )}
                {menuOpen && (
                  <ProjectMenu
                    projectName={project.name}
                    current={current}
                    trigger={triggers.current.get(project.id) ?? null}
                    close={() => setMenuFor(null)}
                    choose={(next) => {
                      setMenuFor(null);
                      selectView(next, project.id);
                      // Keyboard users stay where they were in the sidebar.
                      triggers.current.get(project.id)?.focus();
                      close();
                    }}
                  />
                )}
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
                            selectView("all-sessions", project.id);
                            close();
                          }}
                        >
                          All {list!.total} sessions
                        </ActionButton>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {!state.projects.length && (
          <p className="tiny">Add a folder to begin.</p>
        )}
      </div>
      <div className="sidebar-bottom">
        <nav aria-label="Application navigation">
          {globalLink("providers")}
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
        <small>Topsl {state.version}</small>
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
