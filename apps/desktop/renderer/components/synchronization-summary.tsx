const dimensions = [
  ["identity", "Project links", "Inspect approved folder mappings"],
  ["code", "Code and workspaces", "Review candidate and integration evidence"],
  ["context", "Context", "Review pending input revisions"],
  [
    "history",
    "History coverage",
    "Select a source and inspect its recorded cursor",
  ],
  [
    "configuration",
    "Effective configuration",
    "Inspect requested and reported settings",
  ],
  [
    "native-presentation",
    "Native presentation",
    "Verify the native sidebar separately",
  ],
] as const;
export function SynchronizationSummary({
  synchronization,
}: {
  synchronization: any;
}) {
  return (
    <section aria-label="Synchronization dimensions">
      <h2>Synchronization evidence</h2>
      <p>
        Each dimension has its own observation. Local stored data freshness does
        not establish provider or native freshness.
      </p>
      <div className="synchronization-dimensions">
        {dimensions.map(([dimension, title, action]) => {
          const observations = (synchronization?.observations ?? []).filter(
            (observation: any) => observation.dimension === dimension,
          );
          return (
            <article key={dimension}>
              <h3>{title}</h3>
              {observations.length ? (
                observations.map((observation: any) => (
                  <div key={observation.id}>
                    <p>
                      <strong>{observation.state}</strong> ·{" "}
                      {observation.detail}
                    </p>
                    <p>
                      Source: {observation.evidence.source} ·{" "}
                      {observation.evidence.level}
                    </p>
                    <p>
                      Last successful observation:{" "}
                      {observation.lastSuccessfulObservationAt ?? "Unknown"}
                    </p>
                    <p>Next action: {observation.suggestedAction ?? action}</p>
                  </div>
                ))
              ) : (
                <>
                  <p>
                    <strong>Unverified</strong> · no observation recorded for
                    this dimension.
                  </p>
                  <p>
                    Source: unavailable. Last successful observation: unknown.
                  </p>
                  <p>Next action: {action}.</p>
                </>
              )}
              {dimension === "native-presentation" && (
                <p>
                  Registry readback alone does not verify a visible native
                  sidebar.
                </p>
              )}
              {dimension === "context" && (
                <p>An acknowledged package does not establish comprehension.</p>
              )}
              {dimension === "code" && (
                <p>
                  Intentional worker divergence is a separate integration state.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
