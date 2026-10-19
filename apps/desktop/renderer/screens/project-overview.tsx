import type { ReactNode } from "react";
import type { Task } from "../../../../packages/domain/workflow";
import type { ProjectView } from "../../../../packages/domain/navigation";
import { AtlasIcon, Panel } from "../components/atlas";

export function ProjectOverview({
  tasks,
  onView,
  children,
}: {
  tasks: Task[];
  onView: (view: ProjectView) => void;
  children: ReactNode;
}) {
  const attention = tasks.filter((task) =>
    new Set([
      "blocked",
      "awaiting-approval",
      "awaiting-review",
      "awaiting-acceptance",
      "failed",
      "uncertain",
    ]).has(task.state),
  );
  return (
    <>
      <div className="command-actions">
        <button className="command-action" onClick={() => onView("sessions")}>
          <AtlasIcon name="sessions" />
          <span>
            <strong>Start a session</strong>
            <small>Chat with Codex or open a native terminal.</small>
          </span>
          <AtlasIcon name="arrow" />
        </button>
        <button
          className="command-action"
          onClick={() => onView("coordinator")}
        >
          <AtlasIcon name="coordinator" />
          <span>
            <strong>Coordinate work</strong>
            <small>Set a goal, choose a team, follow the evidence.</small>
          </span>
          <AtlasIcon name="arrow" />
        </button>
      </div>
      <Panel title="Needs attention">
        {attention.length ? (
          <ul className="attention-list">
            {attention.map((task) => (
              <li key={task.id}>
                <span>
                  <strong>{task.title}</strong>
                  <br />
                  <small>
                    {task.state.replaceAll("-", " ")} · {task.detail}
                  </small>
                </span>
                <button onClick={() => onView("tasks")}>Inspect task</button>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No recorded tasks need attention. Open Coordinator for goal and team
            progress, or Tasks for workflow status.
          </p>
        )}
        <div className="actions wrap">
          <button onClick={() => onView("tasks")}>Tasks and workflows</button>
          <button onClick={() => onView("changes")}>Review changes</button>
        </div>
      </Panel>
      {children}
    </>
  );
}
