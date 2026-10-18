import type { RoleRound, RoundMember } from "../domain/role-groups";

/** What the shared concurrency budget holds now. */
export interface CapacityView {
  total: number;
  perProvider: number;
  held: Array<{ provider: "codex" | "claude"; weight: number }>;
}

/**
 * The capacity one member reserves: one slot when its route enforces native
 * fan-out off, and the entire total when fan-out is unknown, matching the
 * existing ConcurrencyBudget. Raising the total does not make unknown routes
 * parallel.
 */
export function memberWeight(
  fanout: "disabled" | "bounded" | "unknown",
  total: number,
): number {
  return fanout === "unknown" ? total : 1;
}

export interface Admission {
  admit: string[];
  /** Set when the policy cannot be met as configured; nothing is admitted. */
  conflict: string | null;
  detail: string;
}

/**
 * Chooses the members of a round to start now. Capacity-bounded waves start
 * only when the previous wave has finished, so five members with width two
 * run as 2 + 2 + 1 against the same frozen input. A wave is reserved as a
 * whole or not at all, and queued members hold no capacity.
 */
export function admit(
  round: Pick<RoleRound, "scheduling" | "executionWidth" | "members">,
  phase: RoundMember["phase"],
  weights: Record<string, { provider: "codex" | "claude"; weight: number }>,
  capacity: CapacityView,
): Admission {
  const inPhase = round.members.filter((m) => m.phase === phase);
  const queued = inPhase.filter((m) => m.state === "queued");
  const running = inPhase.filter((m) => m.state === "running");
  if (!queued.length)
    return {
      admit: [],
      conflict: null,
      detail: "No member is waiting to start.",
    };
  const heldTotal = capacity.held.reduce((n, h) => n + h.weight, 0);
  const heldBy = (p: string) =>
    capacity.held
      .filter((h) => h.provider === p)
      .reduce((n, h) => n + h.weight, 0);
  const fits = (ids: string[]) => {
    const total = ids.reduce((n, id) => n + weights[id].weight, 0);
    if (heldTotal + total > capacity.total) return false;
    for (const provider of ["codex", "claude"] as const) {
      const p = ids
        .filter((id) => weights[id].provider === provider)
        .reduce((n, id) => n + weights[id].weight, 0);
      if (p && heldBy(provider) + p > capacity.perProvider) return false;
    }
    return true;
  };
  if (round.scheduling === "all-simultaneous") {
    const all = inPhase
      .filter((m) => ["queued", "running"].includes(m.state))
      .map((m) => m.memberId);
    const need = all.reduce((n, id) => n + weights[id].weight, 0);
    const width = round.executionWidth ?? Infinity;
    if (
      need > capacity.total ||
      all.length > width ||
      all.some((id) => weights[id].weight > 1 && all.length > 1)
    )
      return {
        admit: [],
        conflict: `All ${all.length} members must run at once, which needs ${need} capacity, but ${Math.min(capacity.total, width)} is available${all.some((id) => weights[id].weight > 1) ? " and some routes have unknown native fan-out" : ""}. Switch this group to capacity-bounded waves or raise the capacity; the roster is unchanged.`,
        detail: "Strict simultaneity cannot be met.",
      };
    if (running.length)
      return {
        admit: [],
        conflict: null,
        detail: "The cohort is already running.",
      };
    return fits(queued.map((m) => m.memberId))
      ? {
          admit: queued.map((m) => m.memberId),
          conflict: null,
          detail: `Starting all ${queued.length} members together.`,
        }
      : {
          admit: [],
          conflict: null,
          detail: `Queued: all ${queued.length} members need capacity at once.`,
        };
  }
  if (running.length)
    return {
      admit: [],
      conflict: null,
      detail: `${running.length} running; ${queued.length} queued for the next wave.`,
    };
  if (round.scheduling === "sequential") {
    const next = queued[0].memberId;
    return fits([next])
      ? {
          admit: [next],
          conflict: null,
          detail: `Starting ${next}; the others follow in order.`,
        }
      : {
          admit: [],
          conflict: null,
          detail: `Queued: ${next} needs capacity.`,
        };
  }
  const width = Math.max(1, round.executionWidth ?? capacity.total);
  const wave: string[] = [];
  for (const m of queued) {
    if (wave.length >= width) break;
    if (!fits([...wave, m.memberId])) break;
    wave.push(m.memberId);
  }
  return wave.length
    ? {
        admit: wave,
        conflict: null,
        detail: `Starting a wave of ${wave.length}; ${queued.length - wave.length} queued.`,
      }
    : {
        admit: [],
        conflict: null,
        detail: `Queued because ${queued.length} required members need capacity.`,
      };
}

/** The wave plan a round will follow under the current capacity, for display. */
export function wavePlan(memberCount: number, width: number): number[] {
  const waves: number[] = [];
  for (let left = memberCount; left > 0; left -= width)
    waves.push(Math.min(width, left));
  return waves;
}
