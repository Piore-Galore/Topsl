import type { ScopedState } from "../state/scoped";
export function Freshness({
  state,
  retry,
}: {
  state: ScopedState;
  retry: () => unknown;
}) {
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
        {state.snapshot &&
          ["stale", "failed", "disconnected"].includes(state.status) &&
          " · showing last-known state"}
      </p>
      {state.error && (
        <p role="alert">
          {state.source}: {state.error}
        </p>
      )}
      <button
        onClick={() => void retry()}
        disabled={["refreshing", "resynchronizing"].includes(state.status)}
      >
        Retry project reads
      </button>
      <small>
        Local stored data freshness. Provider and native observations have
        separate coverage.
      </small>
    </div>
  );
}
