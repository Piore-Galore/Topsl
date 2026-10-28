import { useEffect, useRef, useState } from "react";
import type { ThreadSummary } from "../../../../packages/domain/threads";

export interface ProjectThreads {
  projectId: string;
  total: number;
  needsYou: number;
  threads: ThreadSummary[];
}

/** Record kinds whose change can alter a project's thread list. */
const threadKinds = new Set([
  "orch-conversation",
  // A native session's queue, attention and discussion-only listing.
  "orch-session",
  "goal",
  "loop-run",
  "project",
]);

/** The projects a change page touched in ways the thread list shows. */
export function changedThreadProjects(page: {
  events?: Array<{ kind: string; projectId: string | null }>;
}): string[] {
  return [
    ...new Set(
      (page.events ?? [])
        .filter((e) => e.projectId && threadKinds.has(e.kind))
        .map((e) => e.projectId!),
    ),
  ];
}

/**
 * The sidebar's thread lists for every project, read in one batched
 * `coordinator-threads` call and then refreshed only for projects whose
 * conversations, goals or loop runs changed, at most every half second.
 */
export function useThreadIndex(projectIds: string[], limit = 8) {
  const [index, setIndex] = useState<Record<string, ProjectThreads>>({});
  const key = projectIds.join("\n");
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (ids: string[]) => {
      if (!ids.length) return;
      try {
        const lists: ProjectThreads[] = await window.topsl.command({
          type: "coordinator-threads",
          projectIds: ids,
          limit,
        });
        if (!alive) return;
        setIndex((current) => {
          const next = { ...current };
          for (const id of ids) delete next[id];
          for (const list of lists) next[list.projectId] = list;
          return next;
        });
      } catch {
        // The list is a convenience; a project's own screens report errors.
      }
    };
    void load(projectIds);
    const flush = () => {
      timer.current = null;
      const ids = [...pending.current].filter((id) => projectIds.includes(id));
      pending.current.clear();
      void load(ids);
    };
    const unsubscribe = window.topsl.subscribe((event) => {
      if (event.type !== "changes") return;
      for (const id of changedThreadProjects(event.data))
        pending.current.add(id);
      if (pending.current.size && !timer.current)
        timer.current = setTimeout(flush, 500);
    });
    return () => {
      alive = false;
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [key, limit]);
  return index;
}

/** The top bar's location: "Project / thread" or "Topsl / page". */
export function breadcrumb(input: {
  page: string;
  projectName?: string;
  view: string;
  viewLabel: string;
  threadTitle?: string | null;
}): string {
  if (input.page === "applications") return "Topsl / Applications";
  if (input.page !== "project")
    return `Topsl / ${input.page.replace(/^./, (c) => c.toUpperCase())}`;
  const project = input.projectName ?? "Project";
  if (input.view !== "coordinator") return `${project} / ${input.viewLabel}`;
  return `${project} / ${input.threadTitle ?? "New session"}`;
}
