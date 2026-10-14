import type { UsageFact } from "./types";
export interface UsageSummary {
  input: number | null;
  output: number | null;
  cached: number | null;
  knownInput: number;
  knownOutput: number;
  coveredRuns: number;
  totalRuns: number;
  complete: boolean;
  notes: string[];
}
/** A native cumulative observation replaces its own scope; cached input overlaps
 * the input total when declared included and is never added a second time. */
export function summarizeUsage(
  facts: UsageFact[],
  runIds: string[],
): UsageSummary {
  const unique = new Map<string, UsageFact>();
  const notes = new Set<string>();
  for (const fact of facts) {
    if (!runIds.includes(fact.runId)) continue;
    if (/estimate/i.test(fact.source)) {
      notes.add(
        "API and other estimates are excluded from native reported totals.",
      );
      continue;
    }
    const key = [
      fact.provider,
      fact.source,
      fact.sessionId ?? fact.runId,
      fact.scope,
      fact.eventId ?? (fact.semantics !== "delta" ? "snapshot" : fact.id),
    ].join("\0");
    const old = unique.get(key);
    if (old) {
      const sameValues =
        old.input === fact.input &&
        old.output === fact.output &&
        old.cached === fact.cached;
      if (old.ordinal !== undefined && fact.ordinal !== undefined) {
        if (old.ordinal > fact.ordinal) continue;
        if (old.ordinal === fact.ordinal && !sameValues)
          notes.add(
            "Conflicting observations share one native event order; coverage is uncertain.",
          );
      } else if (!sameValues)
        notes.add("Snapshot ordering was not reported; coverage is uncertain.");
    }
    unique.set(key, fact);
  }
  const groups = new Map<string, UsageFact[]>();
  for (const fact of unique.values()) {
    const key = [
      fact.provider,
      fact.source,
      fact.sessionId ?? fact.runId,
      fact.scope,
    ].join("\0");
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  const values: Array<{
    input: number | null;
    output: number | null;
    cached: number | null;
  }> = [];
  const sources = new Map<string, Set<string>>();
  for (const observation of unique.values()) {
    const scope = [
      observation.provider,
      observation.sessionId ?? observation.runId,
      observation.scope,
    ].join("\0");
    const set = sources.get(scope) ?? new Set<string>();
    set.add(observation.source);
    sources.set(scope, set);
  }
  const sessions = new Set(
    [...unique.values()]
      .filter((f) => f.scopeLevel === "session")
      .map((f) => `${f.provider}:${f.source}:${f.sessionId ?? f.runId}`),
  );
  for (const group of groups.values()) {
    const first = group[0];
    const sourceChoices = sources.get(
      [first.provider, first.sessionId ?? first.runId, first.scope].join("\0"),
    )!;
    if (sourceChoices.size > 1) {
      notes.add(
        "Multiple report sources overlap one native scope; one source retained and coverage is uncertain.",
      );
      if (first.source !== [...sourceChoices].sort()[0]) continue;
    }
    if (
      sessions.has(
        `${first.provider}:${first.source}:${first.sessionId ?? first.runId}`,
      ) &&
      first.scopeLevel !== "session"
    ) {
      notes.add(
        "Session snapshots overlap turn observations; only the session scope is counted.",
      );
      continue;
    }
    const ordered = group.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const snapshot = ordered.filter((f) => f.semantics !== "delta").at(-1);
    const deltas = ordered.filter(
      (f) =>
        f.semantics === "delta" &&
        (!snapshot ||
          (f.ordinal !== undefined &&
            snapshot.ordinal !== undefined &&
            f.ordinal > snapshot.ordinal)),
    );
    if (
      snapshot &&
      ordered.some((f) => f.semantics === "delta" && f.ordinal === undefined)
    )
      notes.add(
        "Unordered delta/snapshot overlap excluded; coverage is uncertain.",
      );
    const sum = (field: "input" | "output" | "cached") => {
      const included = [...(snapshot ? [snapshot] : []), ...deltas];
      return included.length &&
        included.every(
          (f) =>
            f[field] !== null &&
            (field !== "input" ||
              f.cachedIncludedInInput !== false ||
              f.cached !== null),
        )
        ? included.reduce(
            (n, f) =>
              n +
              (f[field] ?? 0) +
              (field === "input" && f.cachedIncludedInInput === false
                ? (f.cached ?? 0)
                : 0),
            0,
          )
        : null;
    };
    values.push({
      input: sum("input"),
      output: sum("output"),
      cached: sum("cached"),
    });
    if (group.some((f) => f.semantics === undefined))
      notes.add(
        "Legacy scope semantics retained; provider coverage was not recorded.",
      );
  }
  const coveredRuns = new Set([...unique.values()].map((f) => f.runId)).size;
  const complete =
    coveredRuns === runIds.length &&
    runIds.length > 0 &&
    values.length > 0 &&
    values.every((v) => v.input !== null && v.output !== null) &&
    notes.size === 0;
  const knownInput = values.reduce((n, v) => n + (v.input ?? 0), 0),
    knownOutput = values.reduce((n, v) => n + (v.output ?? 0), 0);
  return {
    input: complete ? knownInput : null,
    output: complete ? knownOutput : null,
    cached:
      values.length && values.every((v) => v.cached !== null)
        ? values.reduce((n, v) => n + v.cached!, 0)
        : null,
    knownInput,
    knownOutput,
    coveredRuns,
    totalRuns: runIds.length,
    complete,
    notes: [...notes],
  };
}
export function budgetAlerts(
  summary: UsageSummary,
  elapsedMs: number,
  budget: { tokens?: number | null; wallMs?: number | null },
) {
  return {
    approximate: true,
    tokenAlert:
      budget.tokens != null &&
      summary.knownInput + summary.knownOutput >= budget.tokens,
    wallAlert: budget.wallMs != null && elapsedMs >= budget.wallMs,
    detail: summary.complete
      ? "Approximate reporting thresholds; native billing remains authoritative."
      : "Usage coverage is incomplete. Unknown usage may exceed the visible threshold; native billing remains authoritative.",
  };
}
