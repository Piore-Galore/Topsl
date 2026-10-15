import { useEffect, useRef, useState } from "react";
export function AssistedHandoff({
  projectId,
  workflow,
  afterImport,
}: {
  projectId: string;
  workflow: any;
  afterImport: () => Promise<unknown>;
}) {
  const [role, setRole] = useState<"builder" | "reviewer">("builder"),
    [approved, setApproved] = useState(false),
    [handoff, setHandoff] = useState<any>(null),
    [report, setReport] = useState(""),
    [stopped, setStopped] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<any>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setHandoff(null);
    setApproved(false);
    setReport("");
    setStopped(false);
    setError("");
    setResult(null);
    setPending(false);
    return () => {
      generation.current++;
    };
  }, [projectId, workflow.id]);
  async function perform(operation: () => Promise<unknown>) {
    const ticket = generation.current;
    setPending(true);
    setError("");
    try {
      await operation();
    } catch (error: any) {
      if (ticket === generation.current) setError(error.message);
    } finally {
      if (ticket === generation.current) setPending(false);
    }
  }
  return (
    <details>
      <summary>Prepare assisted native handoff</summary>
      <p>
        Assisted operation exports explicit context. Opening a native app does
        not resume a session, adopt hidden state, or qualify coordinated
        execution.
      </p>
      {error && <p role="alert">{error}</p>}
      <label>
        Handoff role
        <select
          value={role}
          disabled={pending}
          onChange={(event) => {
            setRole(event.target.value as any);
            setHandoff(null);
            setApproved(false);
          }}
        >
          <option value="builder">Builder</option>
          <option value="reviewer">Reviewer</option>
        </select>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={approved}
          onChange={(event) => setApproved(event.target.checked)}
        />
        Export this workflow's recorded context and candidate references to the
        selected native route.
      </label>
      <button
        disabled={!approved || pending}
        onClick={() =>
          void perform(async () => {
            const ticket = generation.current;
            const value = await window.topsl.command({
              type: "assisted-handoff-prepare",
              projectId,
              workflowId: workflow.id,
              installationId: workflow[role].installationId,
              role,
              exportApproved: true,
            });
            if (ticket === generation.current) {
              setHandoff(value);
              setResult(null);
            }
          })
        }
      >
        Prepare reviewed handoff text
      </button>
      {handoff && (
        <section aria-label="Assisted handoff evidence">
          <p>
            Prepared context is pinned to the recorded specification and
            candidate.
          </p>
          <pre tabIndex={0}>{handoff.handoffText}</pre>
          <button
            disabled={pending}
            onClick={() =>
              void perform(() =>
                window.topsl.command({
                  type: "assisted-handoff-open",
                  projectId,
                  id: handoff.id ?? handoff.handoff?.id,
                }),
              )
            }
          >
            Open selected native route
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const ticket = generation.current;
                const value = await window.topsl.command({
                  type: "assisted-handoff-import",
                  projectId,
                  id: handoff.id ?? handoff.handoff?.id,
                  candidateRevision:
                    handoff.candidateRevision ??
                    handoff.handoff?.candidateRevision ??
                    workflow.candidateRevision,
                  specificationId:
                    handoff.specificationId ??
                    handoff.handoff?.specificationId ??
                    workflow.specificationId,
                  report,
                  source: "user-supplied",
                  externalWritingStopped: true,
                });
                if (ticket === generation.current) {
                  setResult(value);
                  await afterImport();
                }
              });
            }}
          >
            <label>
              External result report
              <textarea
                value={report}
                onChange={(event) => setReport(event.target.value)}
                required
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={stopped}
                onChange={(event) => setStopped(event.target.checked)}
              />
              I have stopped external writes and am submitting this report with
              user-supplied provenance.
            </label>
            <button disabled={pending || !stopped || !report.trim()}>
              Import assisted result for review
            </button>
          </form>
          {result && (
            <p role="status">
              Assisted result retained: {result.applicability}. {result.detail}{" "}
              Candidate review and checks remain required; this is not automatic
              acceptance.
            </p>
          )}
        </section>
      )}
    </details>
  );
}
