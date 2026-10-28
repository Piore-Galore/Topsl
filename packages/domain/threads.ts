import { attentionLabels, type SessionAttentionKind } from "./sessions";

/**
 * Coordinator threads: the conversations the sidebar lists under each
 * project. A session thread is one native Topsl session: its conversation,
 * goals and queue (docs/Native_Sessions_Plan.md); a loop thread is one Goal
 * loop or Endless run recorded outside a native session
 * (docs/Coordinator_Teams.md). `goal:<conversationId>` is the ID such a
 * conversation had before sessions, and still opens it.
 */

export type ThreadKind = "session" | "goal-loop" | "endless";

export interface ThreadSummary {
  /** `session:<conversationId>` or `loop:<runId>`. */
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
  /** How many messages it holds; a discussion-only session is still listed. */
  messages?: number;
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

/** The session facts the sidebar needs. */
export interface ThreadSessionFact {
  id: string;
  origin: "native" | "legacy";
  attention: { kind: SessionAttentionKind; detail: string } | null;
  queue: Array<{ state: string; runId: string | null }>;
  updatedAt: string;
}

export const DEFAULT_CONVERSATION_TITLE = "Project conversation";

export const sessionThreadIdOf = (conversationId: string) =>
  `session:${conversationId}`;
/** The pre-session thread ID of a conversation; it opens the session. */
export const goalThreadId = (conversationId: string) =>
  `goal:${conversationId}`;
export const loopThreadId = (runId: string) => `loop:${runId}`;

/**
 * Splits a thread ID; null for anything that is not one. A goal thread ID
 * from before sessions reads as its conversation's session.
 */
export function parseThreadId(
  value: unknown,
): { kind: "session" | "loop"; id: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(goal|loop|session):(.+)$/.exec(value);
  if (!match) return null;
  return { kind: match[1] === "loop" ? "loop" : "session", id: match[2] };
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
 * One project's threads, newest activity first. A native session is one
 * thread, with any loop run started in it. A conversation a legacy loop run
 * owns belongs to that run's thread; ordinary goals recorded in such a
 * conversation still get a session thread of their own. A legacy
 * conversation with no goal is not listed; a native session is listed as
 * soon as it has a message, even when it holds only discussion.
 */
export function summarizeThreads(input: {
  projectId: string;
  conversations: ThreadConversationFact[];
  goals: ThreadGoalFact[];
  runs: ThreadRunFact[];
  sessions?: ThreadSessionFact[];
}): ThreadSummary[] {
  const threads: ThreadSummary[] = [];
  const sessions = new Map((input.sessions ?? []).map((s) => [s.id, s]));
  const native = (conversationId: string) =>
    sessions.get(conversationId)?.origin === "native";
  for (const conversation of input.conversations) {
    const session = sessions.get(conversation.id);
    const goals = input.goals
      .filter((g) => g.conversationId === conversation.id)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const discussed =
      session?.origin === "native" && (conversation.messages ?? 0) > 0;
    if (!goals.length && !discussed) continue;
    const runs = input.runs.filter(
      (r) => r.conversationId === conversation.id && native(conversation.id),
    );
    const latest =
      conversation.goalIds
        .map((id) => goals.find((g) => g.id === id))
        .filter((g) => !!g)
        .at(-1) ?? goals.at(-1);
    const custom =
      conversation.title && conversation.title !== DEFAULT_CONVERSATION_TITLE;
    const first = goals.find((g) => g.id === conversation.goalIds[0]);
    const running = session?.queue.some((w) => w.state === "running");
    threads.push({
      threadId: sessionThreadIdOf(conversation.id),
      kind: "session",
      projectId: input.projectId,
      conversationId: conversation.id,
      runId: null,
      title: custom
        ? conversation.title
        : goals.length === 1 && first
          ? threadTitle(first.objective)
          : conversation.title || DEFAULT_CONVERSATION_TITLE,
      state:
        latest?.state ??
        runs.at(0)?.state ??
        (running ? "running" : "discussion"),
      needsYou:
        (session?.attention ? attentionLabels[session.attention.kind] : null) ??
        goals.map(goalAttention).find((a) => a) ??
        runs.map(loopAttention).find((a) => a) ??
        null,
      updatedAt: [
        conversation.updatedAt,
        session?.updatedAt ?? "",
        ...goals.map((g) => g.updatedAt),
        ...runs.map((r) => r.updatedAt),
      ]
        .sort()
        .at(-1)!,
    });
  }
  for (const run of input.runs.filter((r) => !native(r.conversationId)))
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
