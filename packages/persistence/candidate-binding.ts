import type { Store } from "./store";

// Ephemeral vault binding, never serialized into an artifact or prompt. A content
// hash is not a grant; every blob read still resolves a candidate-scoped ref.
const stores = new WeakMap<object, Store>();
export function bindCandidateStore<T extends object>(
  value: T,
  store: Store,
): T {
  function freeze(item: unknown): void {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  }
  freeze(value);
  stores.set(value, store);
  return value;
}
export function candidateStore(value: object, explicit?: Store): Store {
  const store = explicit ?? stores.get(value);
  if (!store)
    throw new Error(
      "Open the candidate through its protected vault before reading bytes.",
    );
  return store;
}
