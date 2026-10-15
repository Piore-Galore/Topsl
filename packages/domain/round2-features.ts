import type { Store } from "../persistence/store";

export const round2FeatureIds = [
  "durable-checks",
  "qualified-structured-routes",
  "manifest-context",
  "prepared-verification",
  "guided-workflows",
] as const;
export type Round2Feature = (typeof round2FeatureIds)[number];

/** Service-owned rollout switches can disable a path; they never supply consent,
 * runtime qualification, filesystem trust, or execution authorization. */
export function round2Features(store: Store) {
  const disabled =
    store.get<{ disabled: Round2Feature[] }>("preference", "round-2-rollout")
      ?.disabled ?? [];
  return round2FeatureIds.map((id) => ({
    id,
    enabled: !disabled.includes(id),
  }));
}

export function assertRound2Feature(store: Store, id: Round2Feature): void {
  if (!round2Features(store).find((feature) => feature.id === id)?.enabled)
    throw new Error(
      `The ${id} path is disabled by this service's rollout policy. Historical evidence remains readable.`,
    );
}
