/**
 * Coordinator threads: the conversations the sidebar lists under each
 * project. A goal thread is one coordinator conversation and its goals; a
 * loop thread is one Goal loop or Endless run (docs/Coordinator_Teams.md).
 */

export type ThreadKind = "goal" | "goal-loop" | "endless";

export interface ThreadSummary {
  /** `goal:<conversationId>` or `loop:<runId>`. */
  threadId: string;
  kind: ThreadKind;
  projectId: string;
  conversationId: string;
  runId: string | null;
  title: string;
  state: string;
  /** What the owner needs to do next, or null when nothing waits on them. */
  needsYou: string | null;
  updatedAt: string;
}

export interface ThreadConversationFact {
  id: string;
  projectId: string;
  title: string;
  goalIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadGoalFact {
  id: string;
  conversationId: string;
  objective: string;
  kind: "code" | "information";
  state: string;
  application: { state: string } | null;
  updatedAt: string;
}

export interface ThreadRunFact {
  id: string;
  conversationId: string;
  title: string;
  mode: "goal" | "endless";
  state: string;
  started: boolean;
  waitReason: { kind: string } | null;
  updatedAt: string;
}

export const DEFAULT_CONVERSATION_TITLE = "Project conversation";

export const goalThreadId = (conversationId: string) =>
  `goal:${conversationId}`;
export const loopThreadId = (runId: string) => `loop:${runId}`;

/** Splits a thread ID; null for anything that is not one. */
export function parseThreadId(
  value: unknown,
): { kind: "goal" | "loop"; id: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(goal|loop):(.+)$/.exec(value);
  return match ? { kind: match[1] as "goal" | "loop", id: match[2] } : null;
}

/** A sidebar title from the first line of a message. */
export function threadTitle(text: string, max = 80): string {
  const line = text.trim().split(/\r?\n/)[0].replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** What a goal needs from the owner, if anything. */
export function goalAttention(goal: ThreadGoalFact): string | null {
  switch (goal.state) {
    case "blocked":
      return "Decide";
    case "checking":
      return "Run checks";
    case "awaiting-acceptance":
      return "Accept";
    case "accepted":
      if (goal.kind !== "code") return null;
      if (!goal.application || goal.application.state === "refused")
        return "Apply";
      return goal.application.state === "uncertain" ? "Check folder" : null;
    default:
      return null;
  }
}

const loopWaits: Record<string, string> = {
  "user-input": "Answer",
  authorization: "Authorize",
  allowance: "Allowance",
  "pinned-model": "Choose model",
  reconciliation: "Reconcile",
};

/** What a loop run needs from the owner, if anything. */
export function loopAttention(run: ThreadRunFact): string | null {
  if (["stopped", "completed"].includes(run.state)) return null;
  if (!run.started) return "Review and start";
  return (run.waitReason && loopWaits[run.waitReason.kind]) ?? null;
}

/**
 * One project's threads, newest activity first. Conversations a loop run
 * owns belong to that run's thread; ordinary goals recorded in such a
 * conversation still get a goal thread of their own. Conversations with no
 * goal are not listed.
 */
export function summarizeThreads(input: {
  projectId: string;
  conversations: ThreadConversationFact[];
  goals: ThreadGoalFact[];
  runs: ThreadRunFact[];
}): ThreadSummary[] {
  const threads: ThreadSummary[] = [];
  for (const conversation of input.conversations) {
    const goals = input.goals
      .filter((g) => g.conversationId === conversation.id)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    if (!goals.length) continue;
    const latest =
      conversation.goalIds
        .map((id) => goals.find((g) => g.id === id))
        .filter((g) => !!g)
        .at(-1) ?? goals.at(-1)!;
    const custom =
      conversation.title && conversation.title !== DEFAULT_CONVERSATION_TITLE;
    const first = goals.find((g) => g.id === conversation.goalIds[0]);
    threads.push({
      threadId: goalThreadId(conversation.id),
      kind: "goal",
      projectId: input.projectId,
      conversationId: conversation.id,
      runId: null,
      title: custom
        ? conversation.title
        : goals.length === 1 && first
          ? threadTitle(first.objective)
          : conversation.title || DEFAULT_CONVERSATION_TITLE,
      state: latest.state,
      needsYou: goals.map(goalAttention).find((a) => a) ?? null,
      updatedAt: [conversation.updatedAt, ...goals.map((g) => g.updatedAt)]
        .sort()
        .at(-1)!,
    });
  }
  for (const run of input.runs)
    threads.push({
      threadId: loopThreadId(run.id),
      kind: run.mode === "goal" ? "goal-loop" : "endless",
      projectId: input.projectId,
      conversationId: run.conversationId,
      runId: run.id,
      title: run.title,
      state: run.state,
      needsYou: loopAttention(run),
      updatedAt: run.updatedAt,
    });
  return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
