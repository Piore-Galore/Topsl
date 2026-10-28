import { parseThreadId } from "../../../../packages/domain/threads";
import { SessionThread } from "./session-thread";
import { LoopThread } from "./loop-thread";
import { ProjectHome } from "./project-home";

/**
 * The coordinator: the project's home when no session is open, one native
 * Topsl session (docs/Native_Sessions_Plan.md), or one loop thread
 * (docs/Coordinator_Teams.md). Each thread mounts afresh,
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
  // A goal thread ID saved before sessions opens its conversation's session.
  if (thread?.kind === "session")
    return (
      <SessionThread
        key={thread.id}
        projectId={projectId}
        sessionId={thread.id}
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
