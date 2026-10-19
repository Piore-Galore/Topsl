import type { Provider } from "../../../../packages/domain/types";
import {
  allowanceWindows,
  type AllowanceSnapshot,
  type ProviderBudgetStatus,
  type ReportedCredits,
  type WindowView,
} from "../../../../packages/domain/allowance";

/** The card's badge: whether a runtime reported anything, and how old it is. */
export function allowanceStatus(
  provider: Provider,
  snapshots: AllowanceSnapshot[],
  nowMs: number,
): { label: string; tone: "" | "good" | "warm" } {
  const windows = snapshots.flatMap((snapshot) =>
    allowanceWindows(snapshot, nowMs).flatMap((bucket) => bucket.windows),
  );
  if (!windows.length)
    return snapshots.some((snapshot) => snapshot.lastError)
      ? { label: "Read failed", tone: "warm" }
      : { label: "Not reported", tone: "" };
  if (snapshots.some((snapshot) => snapshot.lastError))
    return { label: "Refresh failed · older values", tone: "warm" };
  if (windows.every((window) => window.freshness === "fresh"))
    return { label: "Reported · current", tone: "good" };
  return { label: "Reported · stale", tone: "warm" };
}

/** A window's share left, always tied to the share the runtime reported used. */
export function windowReadout(window: WindowView) {
  return `${window.remainingPercent}% left · ${window.usedPercent}% used, as reported`;
}

export function creditsReadout(credits: ReportedCredits) {
  if (credits.unlimited) return "Unlimited, as reported";
  if (!credits.hasCredits)
    return `None available${credits.balance != null ? ` · balance ${credits.balance}` : ""}`;
  return credits.balance != null
    ? `Balance ${credits.balance} (unit not reported)`
    : "Available · balance not reported";
}

/** Remaining against the owner's own budget; an upper bound when a counted run reported no usage. */
export function budgetReadout(budget: ProviderBudgetStatus) {
  const period =
    budget.period === "day"
      ? "today"
      : budget.period === "week"
        ? "this week"
        : "this month";
  const left =
    budget.remaining >= 0
      ? `${budget.complete ? "" : "at most "}${budget.remaining.toLocaleString()} tokens left`
      : `over by ${(-budget.remaining).toLocaleString()} tokens`;
  const coverage = budget.complete
    ? budget.totalRuns
      ? `${budget.totalRuns} run${budget.totalRuns === 1 ? "" : "s"} reported usage`
      : "no runs in Topsl yet"
    : budget.coveredRuns < budget.totalRuns
      ? `${budget.totalRuns - budget.coveredRuns} of ${budget.totalRuns} runs reported no usage, so more may be used`
      : `coverage is uncertain: ${budget.notes.join(" ") || "a reported value is unknown"}`;
  return `Owner-set budget: ${budget.tokens.toLocaleString()} tokens ${period}. Topsl observed ${budget.observedTokens.toLocaleString()} known tokens · ${left} · ${coverage}.`;
}
