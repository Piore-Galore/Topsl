import { parseThreadId } from "../../../../packages/domain/threads";
import { GoalThread } from "./goal-thread";
import { LoopThread } from "./loop-thread";
import { ProjectHome } from "./project-home";

/**
 * The coordinator: the project's home when no conversation is open, or one
 * goal or loop thread (docs/Coordinator_Teams.md). Each thread mounts afresh,
 * so its reads and panes never carry over to another thread; unsent text is
 * kept per thread (state/drafts.ts).
 */
export function CoordinatorView({
  projectId,
  projectName,
  projectPath,
  threadId,
  onThread,
}: {
  projectId: string;
  projectName?: string;
  projectPath?: string;
  threadId: string | null;
  onThread: (threadId: string | null) => void;
}) {
  const thread = parseThreadId(threadId);
  if (thread?.kind === "goal")
    return (
      <GoalThread
        key={threadId}
        projectId={projectId}
        conversationId={thread.id}
      />
    );
  if (thread?.kind === "loop")
    return (
      <LoopThread key={threadId} projectId={projectId} runId={thread.id} />
    );
  return (
    <ProjectHome
      projectId={projectId}
      projectName={projectName}
      projectPath={projectPath}
      onThread={onThread}
    />
  );
}
