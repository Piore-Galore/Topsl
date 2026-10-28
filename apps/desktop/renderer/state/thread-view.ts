/**
 * Pure view models for coordinator threads (docs/Coordinator_Teams.md):
 * the order of a thread's transcript and the pinned plan task list.
 */

export interface ThreadMessage {
  id: string;
  role: "user" | "coordinator" | "service";
  text: string;
  sequence: number;
  routing: { kind: string; goalId: string | null } | null;
  /** The session intake the message started or answers. */
  intakeId?: string | null;
  createdAt: string;
}

/** The open intakes still being answered, for a "coordinators are answering" line. */
export function answering<I extends { stage: string }>(intakes: I[]): I[] {
  return intakes.filter((i) =>
    ["collecting", "reconciling", "endorsing"].includes(i.stage),
  );
}

export type TimelineItem<G> =
  | { kind: "message"; key: string; message: ThreadMessage }
  | { kind: "goal"; key: string; goal: G };

/**
 * A goal thread's transcript: its messages in order, with each goal's card
 * after the latest message about that goal, so the coordinators' current
 * turn follows what the owner last said to them. A goal with no message
 * about it (recorded before threads) follows the last message.
 */
export function threadTimeline<G extends { goal: { id: string } }>(
  messages: ThreadMessage[],
  goals: G[],
  /**
   * Messages known to be about a goal without naming it, by message ID: a
   * native session's queued request names its goal only once it starts.
   */
  about: Record<string, string> = {},
): TimelineItem<G>[] {
  const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
  const anchor = new Map<string, string>();
  for (const message of ordered) {
    const goalId = message.routing?.goalId ?? about[message.id];
    if (goalId && goals.some((g) => g.goal.id === goalId))
      anchor.set(goalId, message.id);
  }
  const items: TimelineItem<G>[] = [];
  for (const message of ordered) {
    items.push({ kind: "message", key: message.id, message });
    for (const goal of goals)
      if (anchor.get(goal.goal.id) === message.id)
        items.push({ kind: "goal", key: `goal:${goal.goal.id}`, goal });
  }
  for (const goal of goals)
    if (!anchor.has(goal.goal.id))
      items.push({ kind: "goal", key: `goal:${goal.goal.id}`, goal });
  return items;
}

export interface PlanTask {
  key: string;
  title: string;
  roleId: string;
  state:
    "queued" | "admitted" | "completed" | "blocked" | "cancelled" | "unknown";
  detail: string;
}

/** The latest plan's tasks with their queued action states. */
export function planTasks(view: {
  plan?: {
    tasks: Array<{ key: string; title: string; roleId: string }>;
  } | null;
  actions?: Array<{ taskKey: string; state: string; detail?: string }>;
}): PlanTask[] {
  return (view.plan?.tasks ?? []).map((t) => {
    const action = view.actions?.find((a) => a.taskKey === t.key);
    return {
      key: t.key,
      title: t.title,
      roleId: t.roleId,
      state: (action?.state as PlanTask["state"]) ?? "unknown",
      detail: action?.detail ?? "",
    };
  });
}

export type LoopTimelineItem<I> =
  | { kind: "message"; key: string; at: string; message: ThreadMessage }
  | { kind: "iteration"; key: string; at: string; iteration: I };

/**
 * A loop thread's transcript: what the owner wrote and the service's notes,
 * with the run's iterations as the coordinators' turns, oldest first.
 */
export function loopTimeline<I extends { id: string; startedAt: string }>(
  messages: ThreadMessage[],
  iterations: I[],
): LoopTimelineItem<I>[] {
  const items: LoopTimelineItem<I>[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      key: message.id,
      at: message.createdAt,
      message,
    })),
    ...iterations.map((iteration) => ({
      kind: "iteration" as const,
      key: iteration.id,
      at: iteration.startedAt,
      iteration,
    })),
  ];
  // Stable: a message and an iteration at the same instant keep the
  // message first, as the owner's text causes the work.
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        a.item.at.localeCompare(b.item.at) ||
        (a.item.kind === b.item.kind
          ? a.index - b.index
          : a.item.kind === "message"
            ? -1
            : 1),
    )
    .map(({ item }) => item);
}
