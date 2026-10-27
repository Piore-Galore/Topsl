import type { ReactNode } from "react";
import type { Task } from "../../../../packages/domain/workflow";
import type { ProjectView } from "../../../../packages/domain/navigation";
import { Panel } from "../components/atlas";

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
          <p>Nothing needs attention.</p>
        )}
      </Panel>
      {children}
    </>
  );
}
