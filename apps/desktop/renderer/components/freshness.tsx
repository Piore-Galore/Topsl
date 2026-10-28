import type { ScopedState } from "../state/scoped";
const troubled = ["stale", "failed", "disconnected"];
/**
 * One line on how fresh the project's stored data is. A page shows one;
 * sections inside it pass `quiet` and appear only when their own read fails.
 */
export function Freshness({
  state,
  retry,
  quiet = false,
}: {
  state: ScopedState;
  retry: () => unknown;
  quiet?: boolean;
}) {
  const trouble = troubled.includes(state.status) || !!state.error;
  if (quiet && !trouble) return null;
  return (
    <div
      className={`scope-freshness ${state.status}`}
      aria-label="Project data freshness"
    >
      <p role="status" aria-live="polite">
        <strong>{state.status.replaceAll("-", " ")}</strong>
        {state.observation
          ? ` · stored revision ${state.observation.sequence}`
          : " · no successful project observation"}
        {state.lastSuccessAt &&
          ` · observed ${new Date(state.lastSuccessAt).toLocaleTimeString()}`}
        {state.snapshot && trouble && " · showing last-known state"}
      </p>
      {state.error && (
        <p role="alert">
          {state.source}: {state.error}
        </p>
      )}
      {state.status !== "current" && (
        <button
          onClick={() => void retry()}
          disabled={["refreshing", "resynchronizing"].includes(state.status)}
        >
          Retry project reads
        </button>
      )}
    </div>
  );
}
