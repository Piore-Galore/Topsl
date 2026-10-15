export function EnvironmentEvidence({
  evidence,
  failurePhase,
}: {
  evidence: any;
  failurePhase?: string | null;
}) {
  if (!evidence)
    return (
      <p>
        No prepared environment record is attached. Historical environment
        coverage is unknown.
      </p>
    );
  const { instance, recipe, logs } = evidence;
  return (
    <section aria-label="Environment preparation evidence">
      <h5>Environment preparation · {instance.state}</h5>
      {failurePhase === "environment" && (
        <p role="status">
          Environment preparation failed. This is separate from a failing
          candidate test.
        </p>
      )}
      {failurePhase === "integrity" && (
        <p role="status">
          Integrity verification failed. The recorded test outcome is ineligible
          for acceptance.
        </p>
      )}
      <p>
        {instance.failureKind
          ? `Failure category: ${instance.failureKind}. `
          : ""}
        {instance.error ?? "No preparation error recorded."}
      </p>
      <dl>
        <dt>Prepared candidate</dt>
        <dd className="path">{instance.candidateRevision}</dd>
        <dt>Dependency identity</dt>
        <dd className="path">
          {instance.dependencyIdentity ??
            "Unknown; preparation did not report a verified identity"}
        </dd>
        <dt>Observed tool versions</dt>
        <dd>
          {Object.keys(instance.observedToolVersions ?? {}).length
            ? Object.entries(instance.observedToolVersions)
                .map(([role, version]) => `${role}: ${version}`)
                .join(" · ")
            : "Unknown; not reported"}
        </dd>
      </dl>
      {recipe && (
        <>
          <p>
            Recipe: {recipe.kind} · {recipe.profile}. Preparation network:{" "}
            {recipe.network.preparation}. Test network:{" "}
            {recipe.network.execution}.
          </p>
          <p>
            Filesystem: {recipe.restrictions.filesystem}. Process evidence:{" "}
            {recipe.restrictions.processes}. Credentials:{" "}
            {recipe.restrictions.secrets}.
          </p>
          {recipe.preparation && (
            <>
              <h6>Recorded preparation command</h6>
              <pre>
                {[recipe.preparation.executable, ...recipe.preparation.args]
                  .map((value: string) => JSON.stringify(value))
                  .join(" ")}
              </pre>
            </>
          )}
          <details>
            <summary>
              Exact environment recipe and authorization boundaries
            </summary>
            <pre>{JSON.stringify(recipe, null, 2)}</pre>
          </details>
        </>
      )}
      <h6>Protected preparation log</h6>
      <pre tabIndex={0} aria-label="Protected preparation log">
        {logs?.length
          ? logs.map((log: any) => `[${log.stream}] ${log.text}`).join("")
          : "No preparation output was recorded."}
      </pre>
      <p>
        {instance.truncated
          ? "Preparation log is truncated by the retention limit."
          : "Bounded protected preparation log."}{" "}
        Viewing this evidence does not rerun preparation.
      </p>
    </section>
  );
}
