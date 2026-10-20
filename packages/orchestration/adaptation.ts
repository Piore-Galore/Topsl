import { hash, stable } from "../domain/invariants";
import type {
  LoopFunction,
  LoopOutcome,
  LoopPolicySettings,
  TeamTopologyRevision,
} from "../domain/recursive-loops";
import type { TeamOperation } from "./loop-contracts";

/**
 * Explainable outcome aggregation and conservative ranking for a loop's
 * automatic organization (docs/Recursive_Looping.md, "Automatic model and
 * team optimization"). It optimizes verified project progress: accepted
 * iterations, valid contributions and runtime reliability, compared within a
 * task family and weighted by difficulty. It never counts lines, commits,
 * tasks or self-reported confidence, and an unmeasured usage is unknown,
 * never zero. Low-data results say so instead of claiming a best team.
 */

export interface ModelStat {
  model: string;
  provider: string;
  function: LoopFunction | null;
  taskFamily: string | null;
  outcomes: number;
  promoted: number;
  invalid: number;
  failed: number;
  /** Smoothed success rate (Beta(1,1) prior), difficulty weighted. */
  mean: number;
  /** A conservative lower estimate; ranking uses it. */
  lower: number;
  confidence: "low" | "moderate" | "high";
  /** Usage coverage across these outcomes; unknown is not cheap. */
  usageCoverage: "complete" | "partial" | "unknown";
}

const difficultyWeight = { low: 0, medium: 0.5, high: 1 } as const;

/** One outcome's credit: verified progress first, reliability second. */
function credit(o: LoopOutcome): { success: number; weight: number } {
  const d = difficultyWeight[o.difficulty];
  if (o.contribution === "valid" && o.iterationResult === "promoted")
    // Harder accepted work counts more.
    return { success: 1 + d, weight: 1 + d };
  if (o.contribution === "valid")
    // A valid contribution to an iteration that did not promote: the team
    // outcome does not prove this member caused the failure, so it earns
    // partial credit. A harder task counts as less evidence (lower weight)
    // and so pulls the mean down less, but less evidence also widens the
    // interval: by the lower estimate that ranking uses, a failed hard
    // iteration can rank a model below the same failure on an easy one until
    // more outcomes arrive (intended; owner decision, 20 October 2026).
    return { success: 0.4 * (1 - 0.5 * d), weight: 1 - 0.5 * d };
  if (o.contribution === "invalid" || o.contribution === "missing")
    return { success: 0, weight: 1 };
  if (o.contribution === "failed") return { success: 0.1, weight: 1 };
  return { success: 0, weight: 0 };
}

export function aggregateOutcomes(
  outcomes: LoopOutcome[],
  filter: { function?: LoopFunction | null; taskFamily?: string | null } = {},
): ModelStat[] {
  const groups = new Map<string, LoopOutcome[]>();
  for (const o of outcomes) {
    if (filter.function !== undefined && o.function !== filter.function)
      continue;
    if (filter.taskFamily && o.taskFamily !== filter.taskFamily) continue;
    const key = `${o.provider}\0${o.model}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.values()].map((list) => {
    let success = 0,
      weight = 0;
    for (const o of list) {
      const c = credit(o);
      success += c.success;
      weight += c.weight;
    }
    const mean = (success + 1) / (weight + 2);
    const lower = Math.max(0, mean - 0.5 / Math.sqrt(weight + 1));
    const coverages = new Set(list.map((o) => o.usageCoverage));
    return {
      model: list[0].model,
      provider: list[0].provider,
      function: filter.function ?? null,
      taskFamily: filter.taskFamily ?? null,
      outcomes: list.length,
      promoted: list.filter(
        (o) => o.contribution === "valid" && o.iterationResult === "promoted",
      ).length,
      invalid: list.filter((o) => o.contribution === "invalid").length,
      failed: list.filter((o) => o.contribution === "failed").length,
      mean: Number(mean.toFixed(4)),
      lower: Number(lower.toFixed(4)),
      confidence:
        list.length < 3 ? "low" : list.length < 10 ? "moderate" : "high",
      usageCoverage:
        coverages.size === 1 && coverages.has("complete")
          ? "complete"
          : coverages.has("complete") || coverages.has("partial")
            ? "partial"
            : "unknown",
    };
  });
}

/**
 * Orders eligible models for one function. Models with outcomes in the same
 * task family come first by their conservative estimate; a family with too
 * little data falls back to the function's outcomes across families; models
 * with no outcomes keep the documented cold-start order the caller supplies
 * (explicit preferences, diversity, default model, stable provider/model
 * order). Ranking reorders eligible routes only.
 *
 * Statistics belong to a provider and model together: the same model ID on
 * two providers is two records. An eligible entry names its provider; a bare
 * model ID stands for that ID on any provider. The ranking lists model IDs,
 * each at the position of its best eligible provider.
 */
export function rankModels(input: {
  outcomes: LoopOutcome[];
  function: LoopFunction;
  taskFamily: string;
  eligible: Array<string | { provider: string; model: string }>;
}): {
  ranking: string[];
  basis: "task-family" | "function" | "cold-start";
  stats: ModelStat[];
} {
  const family = aggregateOutcomes(input.outcomes, {
    function: input.function,
    taskFamily: input.taskFamily,
  });
  const familyData = family.filter((s) => s.outcomes >= 3).length > 0;
  const stats = familyData
    ? family
    : aggregateOutcomes(input.outcomes, { function: input.function });
  const basis = familyData
    ? "task-family"
    : stats.length
      ? "function"
      : "cold-start";
  const known = new Map(stats.map((s) => [`${s.provider}\0${s.model}`, s]));
  const ranked = input.eligible
    .flatMap((entry, index) => {
      if (typeof entry !== "string")
        return [
          {
            model: entry.model,
            index,
            stat: known.get(`${entry.provider}\0${entry.model}`),
          },
        ];
      const matching = stats.filter((s) => s.model === entry);
      return matching.length
        ? matching.map((stat) => ({ model: entry, index, stat }))
        : [{ model: entry, index, stat: undefined }];
    })
    .sort((a, b) => {
      // Known models rank by their lower estimate. An unknown model sits at
      // the prior's lower estimate (0), the same as a model with no credited
      // success, and ties keep the cold-start order.
      const prior = 0;
      const la = a.stat?.lower ?? prior;
      const lb = b.stat?.lower ?? prior;
      return lb - la || a.index - b.index;
    })
    .map((r) => r.model);
  return { ranking: [...new Set(ranked)], basis, stats };
}

/** A content identity for an organization, ignoring revision bookkeeping. */
export function topologyDigest(
  t: Pick<TeamTopologyRevision, "roles" | "roleBindings">,
): string {
  return hash(
    stable({
      roles: [...t.roles]
        .sort((a, b) => a.roleId.localeCompare(b.roleId))
        .map((r) => [r.roleId, r.lineageId, r.active, r.adaptive]),
      bindings: [...t.roleBindings]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((b) => [b.function, b.roleId, b.lineageId]),
    }),
  );
}

export interface ChangeCheck {
  allowed: boolean;
  reasons: string[];
}

/**
 * The change policy at an iteration boundary. Routine changes wait for the
 * dwell period and stay small while evidence is weak; triggered changes
 * (unavailable unpinned routes, repeated invalid output, repeated
 * verification failures, exhausted repairs, no progress, new requirements or
 * user steering) may happen immediately. Swap-backs and add/remove churn are
 * rejected unless a trigger explains them. The numeric defaults are proposed
 * tuning values, exposed as policy, not measured optima.
 */
export function checkChange(input: {
  policy: LoopPolicySettings["adaptation"];
  trigger: string;
  operations: TeamOperation[];
  /** Evaluated iterations (including unsuccessful ones) since the last routine change. */
  iterationsSinceChange: number;
  /** Earlier organizations in this run, newest first. */
  history: Array<
    Pick<TeamTopologyRevision, "roles" | "roleBindings" | "change">
  >;
  proposed: Pick<TeamTopologyRevision, "roles" | "roleBindings">;
  current: Pick<TeamTopologyRevision, "roles" | "roleBindings">;
  evidenceOutcomes: number;
  /** Member turns in the rolling window, and how many went to untried models. */
  windowTurns: number;
  exploratoryTurns: number;
  newExploratoryTurns: number;
}): ChangeCheck {
  const reasons: string[] = [];
  const triggered = input.trigger !== "none";
  if (!input.operations.length) return { allowed: true, reasons };
  if (!triggered && input.iterationsSinceChange < input.policy.dwellIterations)
    reasons.push(
      `Routine changes wait ${input.policy.dwellIterations} evaluated iterations; ${input.iterationsSinceChange} have passed since the last change.`,
    );
  if (
    !triggered &&
    input.evidenceOutcomes < 6 &&
    input.operations.length > input.policy.maxRoutineOperations
  )
    reasons.push(
      `Evidence is weak (${input.evidenceOutcomes} outcomes); a routine change may have at most ${input.policy.maxRoutineOperations} operations so its result is interpretable.`,
    );
  const proposed = topologyDigest(input.proposed);
  const window = input.history.slice(0, input.policy.windowIterations);
  // A → B → A: returning to the organization the last change replaced.
  if (
    !triggered &&
    window.length >= 1 &&
    topologyDigest(window[0]) === proposed
  )
    reasons.push(
      "This restores the organization the last change replaced (a swap-back); keep the current one or name the evidence that triggers the change.",
    );
  const seen = window.filter((t) => topologyDigest(t) === proposed).length;
  if (!triggered && seen >= 2)
    reasons.push(
      "This organization recurred repeatedly in the recent window (churn); the run keeps a stable organization.",
    );
  if (topologyDigest(input.current) === proposed && input.operations.length)
    reasons.push("The operations do not change the organization.");
  const share =
    (input.exploratoryTurns + input.newExploratoryTurns) /
    Math.max(1, input.windowTurns + input.newExploratoryTurns);
  if (
    !triggered &&
    input.newExploratoryTurns > 0 &&
    share > input.policy.explorationShare
  )
    reasons.push(
      `Untried models would take ${(share * 100).toFixed(0)}% of member turns in the window, above the ${(input.policy.explorationShare * 100).toFixed(0)}% exploration allowance.`,
    );
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Whether the organization from a routine experiment did worse than the
 * preceding one, so the preceding successful organization is restored.
 */
export function shouldRevert(input: {
  current: Pick<TeamTopologyRevision, "id" | "change" | "previousRevisionId">;
  underCurrent: Array<"promoted" | "rejected" | "no-work" | "cancelled">;
  underPrevious: Array<"promoted" | "rejected" | "no-work" | "cancelled">;
}): boolean {
  if (input.current.change !== "routine" || !input.current.previousRevisionId)
    return false;
  const evaluated = input.underCurrent.filter(
    (r) => r === "promoted" || r === "rejected",
  );
  if (evaluated.length < 2) return false;
  const rate = (list: string[]) => {
    const e = list.filter((r) => r === "promoted" || r === "rejected");
    return e.length
      ? e.filter((r) => r === "promoted").length / e.length
      : null;
  };
  const before = rate(input.underPrevious);
  const after = rate(evaluated);
  return before !== null && after !== null && after < before && after === 0;
}
