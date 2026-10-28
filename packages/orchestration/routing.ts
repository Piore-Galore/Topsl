import type { GoalState } from "../domain/role-groups";

/** How the owner asked a message to be routed (`orchestration-message`). */
export type RoutingMode =
  "auto" | "follow-up" | "new-goal" | "update-goal" | "related-goal" | "status";

export type Routing = Exclude<RoutingMode, "auto" | "follow-up">;

/** States after which a goal no longer takes steering. */
export const endedGoalStates: GoalState[] = [
  "stopped",
  "accepted",
  "completed",
];

export const isStopAll = (text: string) =>
  /^\s*(stop everything|stop all)\b/i.test(text);

const isStatusPhrase = (text: string) =>
  /^\s*(status|what(?:'s| is) (?:the )?(?:status|progress)|how is it going)\b/i.test(
    text,
  );

/**
 * Picks the routing for one message. `target` is the goal the message is
 * about, if any.
 *
 * - `auto`: a status phrase, a question while a goal runs, or a steering
 *   phrase ("also", "change", …) for that goal; anything else is a new goal.
 * - `follow-up`: a conversation about one goal. A status phrase or a
 *   question while the goal runs is a status request; anything else steers
 *   the goal, or starts a related goal once it has ended.
 *
 * Explicit modes are returned unchanged. Controls ("stop everything",
 * "pause this goal", "resume") are matched by the caller before routing.
 */
export function classifyMessage(
  text: string,
  target: { state: GoalState } | undefined,
  mode: RoutingMode,
): Routing {
  if (mode !== "auto" && mode !== "follow-up") return mode;
  // In auto mode the caller passes only a goal that is still running, or
  // the one the owner named; a follow-up passes the conversation's latest.
  const active =
    !!target && (mode === "auto" || !endedGoalStates.includes(target.state));
  if (isStopAll(text)) return "status";
  // An explicit status question is a status request with or without an
  // active goal; any other question is one only while a goal runs.
  if (isStatusPhrase(text) || (active && /\?\s*$/.test(text))) return "status";
  if (mode === "follow-up") {
    if (!target) return "new-goal";
    return active ? "update-goal" : "related-goal";
  }
  if (
    active &&
    /^\s*(also|change|update|instead|actually|steer|add to)\b/i.test(text)
  )
    return "update-goal";
  return "new-goal";
}
