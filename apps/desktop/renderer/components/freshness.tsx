import type { ScopedState } from "../state/scoped";
const troubled = ["stale", "failed", "disconnected"];
/**
 * How fresh the project's stored data is, shown only when it matters: a
 * stale, failed or disconnected read, with its retry. Current data shows
 * nothing (docs/UX_Cleanup_Plan.md §1).
 */
export function Freshness({
  state,
  retry,
}: {
  state: ScopedState;
  retry: () => unknown;
}) {
  const trouble = troubled.includes(state.status) || !!state.error;
  if (!trouble) return null;
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
