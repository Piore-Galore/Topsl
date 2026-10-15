import { useEffect, useRef, useState } from "react";
import { ScopedReadFence } from "../state/scoped";
import { CandidateArtifacts } from "./candidate-artifacts";
import { EnvironmentEvidence } from "./environment-evidence";
export function capturedText(file: any) {
  if (
    file.type === "deleted" ||
    (file.content === null && !file.blobHash && !file.type)
  )
    return "Deleted file";
  if (file.type === "binary")
    return "Binary artifact retained. A changed relevant binary requires supported or manual verification.";
  if (typeof file.content !== "string")
    return "Content is retained in protected artifact storage; open supported file evidence.";
  if (file.bytes > 100000)
    return "Large file content is omitted from this bounded preview.";
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(file.content), (character) =>
        character.charCodeAt(0),
      ),
    );
    return text.includes("\0")
      ? "Binary artifact; text preview unavailable. Review its recorded coverage and verification."
      : text;
  } catch {
    return "Binary or unsupported text encoding; review recorded artifact coverage and verification.";
  }
}
export function WorkflowEvidence({
  projectId,
  inspection,
  close,
  refresh,
}: {
  projectId: string;
  inspection: any;
  close: () => void;
  refresh: () => Promise<unknown>;
}) {
  const [selectedFinding, setSelectedFinding] = useState(""),
    [selectedFile, setSelectedFile] = useState(""),
    [rationale, setRationale] = useState(""),
    [check, setCheck] = useState<any>(null),
    [pending, setPending] = useState(""),
    [error, setError] = useState(""),
    [diff, setDiff] = useState<any>(inspection.diff ?? null),
    [fileFilter, setFileFilter] = useState(""),
    [fileLimit, setFileLimit] = useState(100);
  const generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId)),
    diffReads = useRef(new ScopedReadFence(projectId)),
    diffSelection = useRef(""),
    fileHeading = useRef<HTMLHeadingElement>(null);
  const candidate = inspection.candidate,
    state = inspection.state;
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    diffReads.current.reset(projectId);
    setDiff(inspection.diff ?? null);
    setCheck(null);
    setError("");
    setPending("");
    setRationale("");
    setSelectedFinding("");
    setSelectedFile("");
    setFileFilter("");
    setFileLimit(100);
    return () => {
      generation.current++;
      reads.current.reset("");
      diffReads.current.reset("");
    };
  }, [projectId, state.id, candidate.id]);
  async function perform(key: string, operation: () => Promise<unknown>) {
    const ticket = generation.current;
    setPending(key);
    setError("");
    try {
      await operation();
    } catch (error: any) {
      if (ticket === generation.current) setError(error.message);
    } finally {
      if (ticket === generation.current) setPending("");
    }
  }
  const finding = inspection.findings.find(
      (item: any) => item.id === selectedFinding,
    ),
    file = candidate.files.find((item: any) => item.path === selectedFile),
    fileDiff = diff?.files.find((item: any) => item.path === selectedFile),
    decisionFor = (findingId: string) =>
      (inspection.findingDecisions ?? [])
        .filter((item: any) => item.findingId === findingId)
        .at(-1);
  const matchingFiles = candidate.files.filter((file: any) =>
    file.path.toLocaleLowerCase().includes(fileFilter.toLocaleLowerCase()),
  );
  async function decide(decision: "accepted" | "rejected") {
    if (!finding) return;
    await window.topsl.command({
      type: "workflow-finding-decide",
      requestId: crypto.randomUUID(),
      projectId,
      id: state.id,
      expectedRevision: state.revision,
      findingId: finding.id,
      candidateId: candidate.id,
      decision,
      rationale,
      expectedDecisionId: decisionFor(finding.id)?.id ?? null,
    });
    await refresh();
  }
  async function inspectCheck(id: string) {
    const ticket = reads.current.begin();
    const value = await window.topsl.command({
      type: "check-execution-inspect",
      projectId,
      id,
    });
    if (reads.current.accept(ticket, value)) setCheck(value);
  }
  async function loadDiff(path: string, targetCandidateId = candidate.id) {
    if (!inspection.diff) return;
    const ticket = diffReads.current.begin(),
      selection = `${targetCandidateId}:${path}`;
    diffSelection.current = selection;
    const value = await window.topsl.command({
      type: "candidate-diff-query",
      projectId,
      workflowId: state.id,
      baseCandidateId: inspection.diff.baseCandidateId,
      candidateId: targetCandidateId,
      path,
      offset: 0,
      limit: 20,
    });
    if (
      diffSelection.current === selection &&
      value.candidateId === targetCandidateId &&
      diffReads.current.accept(ticket, value)
    )
      setDiff(value);
  }
  function selectFile(path: string) {
    setSelectedFile(path);
    setSelectedFinding("");
    if (inspection.diff?.files.some((item: any) => item.path === path)) {
      diffSelection.current = "";
      setDiff(inspection.diff);
    } else void perform("diff", () => loadDiff(path));
  }
  function selectFinding(item: any) {
    setSelectedFinding(item.id);
    setSelectedFile(item.file);
    setRationale("");
    requestAnimationFrame(() => fileHeading.current?.focus());
    if (
      inspection.diff &&
      (item.candidateId !== diff?.candidateId ||
        !diff?.files.some((file: any) => file.path === item.file))
    )
      void perform("diff", () => loadDiff(item.file, item.candidateId));
  }
  function diffLines(
    lines: Array<{ line: number; text: string }>,
    side: "before" | "after",
  ) {
    return (
      <div
        className="diff-text"
        tabIndex={0}
        aria-label={`${side === "before" ? "Baseline" : "Candidate"} lines for ${selectedFile}`}
      >
        {lines.map((line) => {
          const atLine =
            side === "after"
              ? inspection.findings.filter(
                  (item: any) =>
                    item.candidateId === diff.candidateId &&
                    item.file === selectedFile &&
                    item.line === line.line,
                )
              : [];
          return (
            <div
              key={line.line}
              className={`diff-line ${atLine.length ? "finding-line" : ""}`}
            >
              <code>
                <span className="line-number" aria-hidden="true">
                  {line.line}
                </span>
                {line.text}
              </code>
              {atLine.map((item: any) => (
                <button
                  key={item.id}
                  className="finding-inline"
                  onClick={() => selectFinding(item)}
                >
                  {item.severity}: {item.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <section aria-label="Workflow evidence" className="workflow-evidence">
      <div className="section-heading">
        <h3>Changes and context</h3>
        <button onClick={close}>Close inspection</button>
      </div>
      <p>
        Candidate {candidate.revision} · {candidate.files.length} files.
        Evidence applies to the recorded candidate; earlier results remain
        historical.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="evidence-layout">
        <section aria-label="Candidate files">
          <h4>Candidate files</h4>
          <label>
            Filter candidate files
            <input
              value={fileFilter}
              onChange={(event) => {
                setFileFilter(event.target.value);
                setFileLimit(100);
              }}
            />
          </label>
          <p>
            {Math.min(fileLimit, matchingFiles.length)} of{" "}
            {matchingFiles.length} matching paths shown. File contents remain
            bounded previews.
          </p>
          {matchingFiles.slice(0, fileLimit).map((item: any) => (
            <button
              key={item.path}
              className="evidence-file"
              aria-pressed={selectedFile === item.path}
              onClick={() => selectFile(item.path)}
            >
              {item.path} · {item.bytes} bytes ·{" "}
              {item.change ??
                item.type ??
                (item.content === null ? "deleted" : "captured")}
            </button>
          ))}
          {matchingFiles.length > fileLimit && (
            <button onClick={() => setFileLimit(fileLimit + 100)}>
              Show next 100 candidate files
            </button>
          )}
        </section>
        <section aria-label="Candidate content">
          <h4 ref={fileHeading} tabIndex={-1}>
            {selectedFile || "Select a file or finding"}
          </h4>
          {fileDiff ? (
            <>
              <p>
                {fileDiff.kind} · baseline {diff.baseRevision} → candidate{" "}
                {diff.candidateRevision}
              </p>
              <p>{fileDiff.detail}</p>
              {fileDiff.binary ? (
                <p>
                  Binary change; text diff unavailable. Inspect the required
                  binary verification gate.
                </p>
              ) : (
                <div className="candidate-diff-columns">
                  <section>
                    <h5>Recorded baseline</h5>
                    {diffLines(fileDiff.before, "before")}
                    {!!fileDiff.omittedBeforeLines && (
                      <p>
                        {fileDiff.omittedBeforeLines} baseline lines omitted
                        from this bounded excerpt.
                      </p>
                    )}
                  </section>
                  <section>
                    <h5>Recorded candidate</h5>
                    {diffLines(fileDiff.after, "after")}
                    {!!fileDiff.omittedAfterLines && (
                      <p>
                        {fileDiff.omittedAfterLines} candidate lines omitted
                        from this bounded excerpt.
                      </p>
                    )}
                  </section>
                </div>
              )}
              <details>
                <summary>File content identities</summary>
                <p>Before: {fileDiff.beforeHash ?? "absent"}</p>
                <p>After: {fileDiff.afterHash ?? "absent"}</p>
              </details>
            </>
          ) : (
            file && (
              <>
                <p>
                  Candidate {candidate.revision}.{" "}
                  {finding?.file === file.path
                    ? `Finding at recorded line ${finding.line}.`
                    : "Captured file preview."}
                </p>
                <pre
                  tabIndex={0}
                  aria-label={`Captured candidate content ${file.path}`}
                >
                  {capturedText(file)
                    .split("\n")
                    .map((text, index) => (
                      <span
                        key={index}
                        className={
                          finding?.file === file.path &&
                          finding.line === index + 1
                            ? "finding-line"
                            : ""
                        }
                      >
                        <span className="line-number" aria-hidden="true">
                          {index + 1}
                        </span>
                        {text}
                        {"\n"}
                      </span>
                    ))}
                </pre>
              </>
            )
          )}
        </section>
      </div>
      <h4>Reviewer findings</h4>
      {inspection.findings.length ? (
        <div className="finding-list">
          {inspection.findings.map((item: any) => (
            <button
              key={item.id}
              aria-pressed={item.id === selectedFinding}
              onClick={() => selectFinding(item)}
            >
              {item.severity} · {item.title} ·{" "}
              {decisionFor(item.id)?.decision ?? item.disposition} · {item.file}
              :{item.line}
            </button>
          ))}
        </div>
      ) : (
        <p>No substantiated findings recorded.</p>
      )}
      {finding && (
        <article
          className="workflow-card"
          aria-label="Selected finding evidence"
        >
          <h4>{finding.title}</h4>
          <p>{finding.behavior}</p>
          <p>Evidence: {finding.evidence}</p>
          <p>
            Original candidate: {finding.candidateRevision}.{" "}
            {decisionFor(finding.id)?.decision === "resolved"
              ? `Resolved by candidate ${decisionFor(finding.id).candidateId}.`
              : "A changed candidate requires new review evidence."}
          </p>
          {decisionFor(finding.id) && (
            <p>
              Recorded decision: {decisionFor(finding.id).decision} ·{" "}
              {decisionFor(finding.id).rationale}
            </p>
          )}
          {finding.candidateId === candidate.id &&
            !["accepted", "cancelled"].includes(state.stage) && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform("accept-finding", () => decide("accepted"));
                }}
              >
                <label>
                  Finding decision rationale
                  <textarea
                    value={rationale}
                    onChange={(event) => setRationale(event.target.value)}
                    required
                  />
                </label>
                <div className="workflow-actions">
                  <button disabled={!!pending || !rationale.trim()}>
                    Accept substantiated finding
                  </button>
                  <button
                    type="button"
                    disabled={!!pending || !rationale.trim()}
                    onClick={() =>
                      void perform("reject-finding", () => decide("rejected"))
                    }
                  >
                    Reject with rationale
                  </button>
                </div>
              </form>
            )}
          <details>
            <summary>Finding decision history</summary>
            {(inspection.findingDecisions ?? [])
              .filter((item: any) => item.findingId === finding.id)
              .map((item: any) => (
                <p key={item.id}>
                  {item.decision} · {item.createdAt} · candidate{" "}
                  {item.candidateId} · {item.rationale}
                </p>
              ))}
          </details>
        </article>
      )}
      <h4>Checks and protected logs</h4>
      {(inspection.checkExecutions ?? []).length ? (
        inspection.checkExecutions.map((execution: any) => (
          <button
            key={execution.id}
            className="evidence-file"
            disabled={!!pending}
            onClick={() =>
              void perform("inspect-check", () => inspectCheck(execution.id))
            }
          >
            {execution.definition.label} · {execution.state} ·{" "}
            {execution.eligibility} · candidate{" "}
            {execution.targetRevision.slice(0, 12)}
          </button>
        ))
      ) : (
        <p>
          No durable check execution is recorded for this workflow. Historical
          checks without an environment keep their original coverage.
        </p>
      )}
      {check && (
        <article
          className="workflow-card"
          aria-label="Protected check evidence"
        >
          <h4>
            {check.execution.definition.label} · {check.execution.state}
          </h4>
          <p>
            Candidate {check.execution.targetRevision} · eligibility{" "}
            {check.execution.eligibility}
          </p>
          <pre>
            {[check.plan.definition.executable, ...check.plan.definition.args]
              .map((value: string) => JSON.stringify(value))
              .join(" ")}
          </pre>
          <EnvironmentEvidence
            evidence={check.environment}
            failurePhase={check.execution.failurePhase}
          />
          <details>
            <summary>
              Recorded check environment and execution authorization
            </summary>
            <pre>{check.plan.environment}</pre>
            <pre>
              {JSON.stringify(
                check.plan.authorization ?? {
                  coverage: "Legacy single-use authorization",
                },
                null,
                2,
              )}
            </pre>
          </details>
          <p>
            Cleanup: {check.cleanup?.state ?? "Not recorded"}
            {check.cleanup?.error && ` · ${check.cleanup.error}`}
          </p>
          {check.execution.state === "uncertain" && (
            <button
              disabled={!!pending}
              onClick={() =>
                void perform("reconcile", async () => {
                  await window.topsl.command({
                    type: "check-execution-reconcile",
                    requestId: crypto.randomUUID(),
                    projectId,
                    id: check.execution.id,
                  });
                  await inspectCheck(check.execution.id);
                  await refresh();
                })
              }
            >
              Reconcile original check lifecycle
            </button>
          )}
          {check.cleanup &&
            ["failed", "pending"].includes(check.cleanup.state) && (
              <button
                disabled={!!pending}
                onClick={() =>
                  void perform("cleanup", async () => {
                    await window.topsl.command({
                      type: "check-cleanup-retry",
                      requestId: crypto.randomUUID(),
                      projectId,
                      id: check.cleanup.id,
                    });
                    await inspectCheck(check.execution.id);
                    await refresh();
                  })
                }
              >
                Retry cleanup only
              </button>
            )}
          <pre tabIndex={0} aria-label="Protected check log">
            {check.logs.length
              ? check.logs
                  .map((log: any) => `[${log.stream}] ${log.text}`)
                  .join("")
              : "No protected output was recorded."}
          </pre>
          <p>
            {check.execution.truncated
              ? "Protected log is truncated by the retention limit."
              : "Bounded protected log; credentials are redacted at capture."}
          </p>
        </article>
      )}
      <details>
        <summary>Candidate coverage and omissions</summary>
        <p>
          {candidate.coverage
            ? candidate.coverage.complete
              ? "Approved candidate scope captured"
              : "Candidate coverage blocked"
            : "Legacy coverage interpretation retained"}
        </p>
        {(candidate.coverage?.blockers ?? []).map((blocker: string) => (
          <p key={blocker}>{blocker}</p>
        ))}
        {(candidate.coverage?.manualBinaryPaths ?? []).map((path: string) => (
          <p key={path}>Manual or supported binary review required: {path}</p>
        ))}
        {(candidate.omissions ?? []).map((omission: any, index: number) => (
          <p key={index}>
            {omission.source}: {omission.reason}
          </p>
        ))}
      </details>
      <CandidateArtifacts
        key={`${projectId}:${candidate.id}`}
        projectId={projectId}
        candidate={candidate}
        receipts={inspection.candidateArtifactReviews}
        refresh={refresh}
      />
      <details>
        <summary>Initial context packages</summary>
        {inspection.contexts.map((context: any) => (
          <article key={context.id}>
            <p>
              {context.role} · specification {context.specificationRevision} ·{" "}
              {context.bytes} bytes · {context.tokenEvidence}
            </p>
            <p>
              Initial text paths:{" "}
              {context.initialFiles?.length ?? "not recorded"}.{" "}
              {context.retrievalRequired
                ? "Additional pinned retrieval is required; initial context does not cover the full candidate."
                : "No additional retrieval requirement was recorded."}
            </p>
            {(context.omissions ?? []).map((omission: any, index: number) => (
              <p key={index}>
                Omitted from initial context: {omission.source} ·{" "}
                {omission.reason}
              </p>
            ))}
            {context.budget && (
              <details>
                <summary>Context budget and source coverage</summary>
                <pre>{JSON.stringify(context.budget, null, 2)}</pre>
                <p>
                  Initial paths:{" "}
                  {context.initialFiles?.join(", ") || "No text files selected"}
                </p>
              </details>
            )}
            <pre>{context.content}</pre>
          </article>
        ))}
      </details>
      <details>
        <summary>Context acknowledgements and retrieved evidence</summary>
        {inspection.deliveries.map((delivery: any) => (
          <p key={delivery.id}>
            {delivery.state} · {delivery.evidence} · {delivery.detail}
          </p>
        ))}
        <p>
          {inspection.candidateRetrievals
            ? `${inspection.candidateRetrievals.items.length} of ${inspection.candidateRetrievals.total} retrieval observations shown${inspection.candidateRetrievals.truncated ? "; older observations omitted from this bounded view" : ""}.`
            : "No pinned retrieval observations are available in this read model."}{" "}
          A returned file range establishes delivery coverage, not
          comprehension.
        </p>
        {(inspection.candidateRetrievals?.items ?? []).map((retrieval: any) => (
          <article key={retrieval.id}>
            <p>
              {retrieval.method} · {retrieval.outcome} · {retrieval.bytes} bytes
              · {retrieval.path ?? "Manifest metadata"} · {retrieval.createdAt}
            </p>
            <p>
              Candidate {retrieval.candidateRevision ?? "Unknown"} · attempt{" "}
              {retrieval.attemptId ?? "Unknown"}
              {retrieval.offset !== null && ` · offset ${retrieval.offset}`}
            </p>
          </article>
        ))}
      </details>
      <details>
        <summary>Source identities and configuration</summary>
        <pre>
          {JSON.stringify(
            {
              workflow: state.id,
              candidate: candidate.id,
              revision: candidate.revision,
              observation: inspection.observation,
              builder: state.builder,
              reviewer: state.reviewer,
              runtimeMetadata: inspection.runtimeMetadata,
              runtimeResultMetadata: inspection.runtimeResultMetadata,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
