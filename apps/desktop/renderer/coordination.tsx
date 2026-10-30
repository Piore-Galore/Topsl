import { useEffect, useState, type ReactNode } from "react";
import type {
  AdvancedSection,
  ProjectView,
} from "../../../packages/domain/navigation";
import { advancedSections } from "../../../packages/domain/navigation";
import type { Project } from "../../../packages/domain/types";
export type { ProjectView } from "../../../packages/domain/navigation";
import { CoordinatorView } from "./coordinator";
import { AllSessions } from "./screens/all-sessions";
import { ProjectSettings } from "./screens/project-settings";
import { AdvancedWorkflows } from "./screens/advanced-workflows";

/**
 * A project's page (docs/UX_Cleanup_Plan.md §1). Sessions are the
 * workspace; the project menu opens All sessions, Project settings,
 * Provider tools and Advanced workflows. Provider tools and Advanced
 * workflows stay mounted once shown, so terminals and drafts survive moving
 * between destinations.
 */
export function Coordination({
  project,
  view,
  section,
  onView,
  threadId,
  onThread,
  sessionsContent,
  historyContent,
  attachment,
  onAttachment,
}: {
  project?: Project;
  view: ProjectView;
  /** The section a destination opens at, such as Advanced workflows' Activity. */
  section: string | null;
  onView: (view: ProjectView, section?: string | null) => void;
  /** The open session or loop; none shows the New session page. */
  threadId: string | null;
  onThread: (threadId: string | null) => void;
  sessionsContent?: ReactNode;
  historyContent?: ReactNode;
  /** An import the New session page attaches, from Settings → Imports. */
  attachment: string | null;
  onAttachment: (referenceId: string | null) => void;
}) {
  const projectId = project?.id ?? "";
  const [advancedShown, setAdvancedShown] = useState(view === "advanced");
  useEffect(() => {
    if (view === "advanced") setAdvancedShown(true);
  }, [view]);
  useEffect(() => setAdvancedShown(view === "advanced"), [projectId]);
  const advancedSection: AdvancedSection = advancedSections.includes(
    section as AdvancedSection,
  )
    ? (section as AdvancedSection)
    : "workflows";
  if (!project)
    return (
      <section className="coordination-view" aria-label="Project">
        <p>Select a project to begin.</p>
      </section>
    );
  return (
    <section className="coordination-view" aria-label="Project">
      {view === "coordinator" && (
        <CoordinatorView
          projectId={projectId}
          projectName={project.name}
          projectPath={project.path}
          threadId={threadId}
          onThread={onThread}
          attachment={attachment}
          onAttachment={onAttachment}
        />
      )}
      {view === "all-sessions" && (
        <AllSessions
          projectId={projectId}
          projectName={project.name}
          onThread={(next) => onThread(next)}
          onNew={() => onThread(null)}
        />
      )}
      {view === "project-settings" && (
        <ProjectSettings project={project} notice={section} />
      )}
      <div hidden={view !== "sessions"} className="provider-tools">
        <div className="page-heading">
          <div>
            <h1>Provider tools</h1>
          </div>
        </div>
        {sessionsContent}
        {historyContent}
      </div>
      {advancedShown && (
        <div hidden={view !== "advanced"}>
          <AdvancedWorkflows
            projectId={projectId}
            section={advancedSection}
            onSection={(next) => onView("advanced", next)}
          />
        </div>
      )}
    </section>
  );
}
