import type { Provider, Run, UsageFact } from "./types";
import { summarizeUsage } from "./usage";

/**
 * Subscription allowance (design §16.6): what a runtime itself reports about
 * its plan's usage limits, kept apart from the token ledger. Topsl stores each
 * value exactly as reported, with when and how it was observed, and derives
 * nothing a runtime did not report. A value the runtime leaves out stays
 * unknown.
 */
export interface ReportedWindow {
  /** The runtime's own share of the window already used, 0–100. */
  usedPercent: number;
  windowMinutes: number | null;
  /** Unix seconds, as reported. */
  resetsAtSeconds: number | null;
  /** Native display label when the provider does not expose an exact timestamp. */
  resetDescription?: string | null;
}
export interface ReportedCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** A decimal string, as reported; its unit is not documented. */
  balance: string | null;
}
/** One metered quota, such as Codex's `codex` limit. */
export interface ReportedBucket {
  id: string;
  name: string | null;
  primary: ReportedWindow | null;
  secondary: ReportedWindow | null;
  credits: ReportedCredits | null;
  planType: string | null;
  /** Why the runtime says usage is blocked, such as `rate_limit_reached`. */
  limitReached: string | null;
}
/** What an adapter read: a full read, or a sparse rolling update. */
export interface AllowanceReport {
  kind: "read" | "update";
  /** Reported only by a full read. */
  ordinaryUsageAllowed: boolean | null;
  buckets: ReportedBucket[];
}
export type AllowanceSource = "read" | "update";
export interface ObservedWindow extends ReportedWindow {
  observedAt: string;
  source: AllowanceSource;
}
export interface ObservedBucket extends Omit<
  ReportedBucket,
  "primary" | "secondary"
> {
  primary: ObservedWindow | null;
  secondary: ObservedWindow | null;
}
/** The latest allowance Topsl observed for one provider account. */
export interface AllowanceSnapshot {
  /** `${provider}:${accountKey}`. */
  id: string;
  provider: Provider;
  /** Topsl's hash of the native account identity; never the account id. */
  accountKey: string;
  installationId: string;
  runtimeVersion: string | null;
  /** The runtime interface the values came from. */
  interface: string;
  /** When the last full read succeeded; null when only updates arrived. */
  readAt: string | null;
  /** When any value last arrived. */
  observedAt: string;
  ordinaryUsageAllowed: boolean | null;
  buckets: ObservedBucket[];
  /** The last read that failed, kept beside the older values. */
  lastError: { detail: string; at: string } | null;
}
export interface AllowanceOrigin {
  provider: Provider;
  accountKey: string;
  installationId: string;
  runtimeVersion: string | null;
  interface: string;
}

export const allowanceId = (provider: Provider, accountKey: string) =>
  `${provider}:${accountKey}`;

/** A snapshot older than this is stale: shown, but marked as old. */
export const ALLOWANCE_STALE_AFTER_MS = 15 * 60_000;

const observe = (
  window: ReportedWindow | null,
  at: string,
  source: AllowanceSource,
): ObservedWindow | null =>
  window ? { ...window, observedAt: at, source } : null;

/**
 * A full read replaces what Topsl knew for the account. A rolling update is
 * sparse: per Codex's protocol it merges into the last read, and a value it
 * leaves out keeps the earlier one, with that value's own observation time.
 */
export function applyAllowanceReport(
  previous: AllowanceSnapshot | undefined,
  origin: AllowanceOrigin,
  report: AllowanceReport,
  at: string,
): AllowanceSnapshot {
  const base = {
    id: allowanceId(origin.provider, origin.accountKey),
    ...origin,
    observedAt: at,
  };
  if (report.kind === "read")
    return {
      ...base,
      readAt: at,
      ordinaryUsageAllowed: report.ordinaryUsageAllowed,
      buckets: report.buckets.map((bucket) => ({
        ...bucket,
        primary: observe(bucket.primary, at, "read"),
        secondary: observe(bucket.secondary, at, "read"),
      })),
      lastError: null,
    };
  const buckets = [...(previous?.buckets ?? [])];
  for (const update of report.buckets) {
    const index = buckets.findIndex((bucket) => bucket.id === update.id),
      old = index >= 0 ? buckets[index] : undefined,
      merged: ObservedBucket = {
        id: update.id,
        name: update.name ?? old?.name ?? null,
        primary: observe(update.primary, at, "update") ?? old?.primary ?? null,
        secondary:
          observe(update.secondary, at, "update") ?? old?.secondary ?? null,
        credits: update.credits ?? old?.credits ?? null,
        planType: update.planType ?? old?.planType ?? null,
        limitReached: update.limitReached ?? old?.limitReached ?? null,
      };
    if (index >= 0) buckets[index] = merged;
    else buckets.push(merged);
  }
  return {
    ...base,
    readAt: previous?.readAt ?? null,
    ordinaryUsageAllowed: previous?.ordinaryUsageAllowed ?? null,
    buckets,
    lastError: previous?.lastError ?? null,
  };
}

/** A failed read keeps the older values, which age into stale. */
export function recordAllowanceFailure(
  previous: AllowanceSnapshot | undefined,
  origin: AllowanceOrigin,
  detail: string,
  at: string,
): AllowanceSnapshot {
  return {
    id: allowanceId(origin.provider, origin.accountKey),
    ...origin,
    readAt: previous?.readAt ?? null,
    observedAt: previous?.observedAt ?? at,
    ordinaryUsageAllowed: previous?.ordinaryUsageAllowed ?? null,
    buckets: previous?.buckets ?? [],
    lastError: { detail, at },
  };
}

export type WindowFreshness = "fresh" | "stale" | "reset-since";
export interface WindowView {
  label: string;
  usedPercent: number;
  /** 100 − the reported used share. */
  remainingPercent: number;
  resetsAt: string | null;
  resetsAtSeconds: number | null;
  resetDescription: string | null;
  observedAt: string;
  source: AllowanceSource;
  freshness: WindowFreshness;
}

export function windowLabel(window: ReportedWindow, slot: string) {
  const minutes = window.windowMinutes;
  if (minutes == null) return `${slot} window`;
  if (minutes === 10080) return "Weekly window";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

/**
 * A window that reset after Topsl observed it no longer says how much is used
 * now, so its share becomes unknown rather than carried forward.
 */
export function windowView(
  window: ObservedWindow,
  slot: "Primary" | "Secondary",
  nowMs: number,
): WindowView {
  const resetsMs =
    window.resetsAtSeconds == null ? null : window.resetsAtSeconds * 1000;
  return {
    label: windowLabel(window, slot),
    usedPercent: window.usedPercent,
    remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    resetsAt: resetsMs == null ? null : new Date(resetsMs).toISOString(),
    resetsAtSeconds: window.resetsAtSeconds,
    resetDescription: window.resetDescription ?? null,
    observedAt: window.observedAt,
    source: window.source,
    freshness:
      resetsMs != null && resetsMs <= nowMs
        ? "reset-since"
        : nowMs - Date.parse(window.observedAt) > ALLOWANCE_STALE_AFTER_MS
          ? "stale"
          : "fresh",
  };
}

export function allowanceWindows(snapshot: AllowanceSnapshot, nowMs: number) {
  return snapshot.buckets.map((bucket) => ({
    bucket,
    windows: [
      ...(bucket.primary ? [windowView(bucket.primary, "Primary", nowMs)] : []),
      ...(bucket.secondary
        ? [windowView(bucket.secondary, "Secondary", nowMs)]
        : []),
    ],
  }));
}

/** An owner-set token budget for one provider, counted against the usage Topsl observed. */
export type BudgetPeriod = "day" | "week" | "month";
export const budgetPeriods = ["day", "week", "month"] as const;
export interface ProviderBudget {
  /** `provider-budget:${provider}`. */
  id: string;
  provider: Provider;
  tokens: number;
  period: BudgetPeriod;
  updatedAt: string;
}
export const providerBudgetId = (provider: Provider) =>
  `provider-budget:${provider}`;

/** The current period's start in the service's local time; weeks start on Monday. */
export function budgetPeriodStart(period: BudgetPeriod, now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week")
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === "month") start.setDate(1);
  return start;
}

export interface ProviderBudgetStatus {
  provider: Provider;
  tokens: number;
  period: BudgetPeriod;
  periodStart: string;
  /** Known input + output tokens of the provider's runs this period. */
  observedTokens: number;
  /** `tokens − observedTokens`; negative when over. With incomplete coverage it is an upper bound. */
  remaining: number;
  complete: boolean;
  coveredRuns: number;
  totalRuns: number;
  notes: string[];
}

/**
 * Remaining against the owner's own budget. It counts only work Topsl ran or
 * opened, so native sessions started outside Topsl are not in it, and a run
 * that reported no usage makes the result an upper bound.
 */
export function providerBudgetStatus(
  budget: ProviderBudget,
  runs: Run[],
  usage: UsageFact[],
  now: Date,
): ProviderBudgetStatus {
  const start = budgetPeriodStart(budget.period, now);
  const counted = runs.filter(
    (run) =>
      run.provider === budget.provider &&
      Date.parse(run.createdAt) >= start.getTime() &&
      // A native sign-in is not model work.
      !(run.mode === "native" && !run.permissionMode),
  );
  const ids = new Set(counted.map((run) => run.id));
  const summary = summarizeUsage(
    usage.filter((fact) => ids.has(fact.runId)),
    [...ids],
  );
  const observedTokens = summary.knownInput + summary.knownOutput;
  return {
    provider: budget.provider,
    tokens: budget.tokens,
    period: budget.period,
    periodStart: start.toISOString(),
    observedTokens,
    remaining: budget.tokens - observedTokens,
    complete: summary.complete || summary.totalRuns === 0,
    coveredRuns: summary.coveredRuns,
    totalRuns: summary.totalRuns,
    notes: summary.notes,
  };
}
