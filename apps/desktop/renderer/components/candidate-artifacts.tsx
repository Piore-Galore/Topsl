import { useEffect, useRef, useState } from "react";
const PAGE = 25;
export function safeRasterSource(preview: any): string | null {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    preview?.mime,
  ) &&
    Number.isSafeInteger(preview.bytes) &&
    preview.bytes >= 0 &&
    preview.bytes <= 2_000_000 &&
    typeof preview.base64 === "string" &&
    preview.base64.length <= 2_666_672
    ? `data:${preview.mime};base64,${preview.base64}`
    : null;
}
export function outputReviewState(
  candidate: any,
  receipts: any[],
  output: any,
) {
  return (
    receipts
      .filter(
        (receipt) =>
          receipt.candidateId === candidate.id &&
          receipt.candidateRevision === candidate.revision,
      )
      .flatMap((receipt) => receipt.entries ?? [])
      .filter(
        (entry) => entry.path === output.path && entry.hash === output.hash,
      )
      .at(-1)?.decision ?? output.status
  );
}
export function CandidateArtifacts({
  projectId,
  candidate,
  receipts,
  refresh,
}: {
  projectId: string;
  candidate: any;
  receipts: { outputs?: any[]; binaries?: any[] } | undefined;
  refresh: () => Promise<unknown>;
}) {
  const [filter, setFilter] = useState(""),
    [visible, setVisible] = useState(PAGE),
    [outputs, setOutputs] = useState<
      Record<string, "approved" | "rejected" | "">
    >({}),
    [capturePaths, setCapturePaths] = useState<Record<string, boolean>>({}),
    [binaries, setBinaries] = useState<Record<string, string>>({}),
    [binaryPassed, setBinaryPassed] = useState<Record<string, boolean>>({}),
    [preview, setPreview] = useState<any>(null),
    [plan, setPlan] = useState<any>(null),
    [pending, setPending] = useState(""),
    [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0),
    previewOrder = useRef(0),
    reviewButton = useRef<HTMLButtonElement>(null),
    planHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    generation.current++;
    previewOrder.current++;
    setFilter("");
    setVisible(PAGE);
    setOutputs({});
    setCapturePaths({});
    setBinaries({});
    setBinaryPassed({});
    setPreview(null);
    setPlan(null);
    setError("");
    setNotice("");
    setPending("");
    return () => {
      generation.current++;
      previewOrder.current++;
    };
  }, [projectId, candidate.id]);
  useEffect(() => {
    if (plan) planHeading.current?.focus();
  }, [plan?.id]);
  const outputPaths = (candidate.outputs ?? []).filter((output: any) =>
      output.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ),
    binaryPaths = (candidate.coverage?.manualBinaryPaths ?? []).filter(
      (path: string) =>
        path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    );
  async function perform(key: string, action: () => Promise<unknown>) {
    const ticket = generation.current;
    setPending(key);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error: any) {
      if (ticket === generation.current) setError(error.message);
    } finally {
      if (ticket === generation.current) setPending("");
    }
  }
  async function readBinary(path: string) {
    const ticket = generation.current,
      order = ++previewOrder.current;
    const value = await window.topsl.command({
      type: "candidate-binary-preview",
      projectId,
      candidateId: candidate.id,
      path,
    });
    if (
      ticket === generation.current &&
      order === previewOrder.current &&
      value.candidateId === candidate.id &&
      value.candidateRevision === candidate.revision
    )
      setPreview(value);
  }
  const decisions = (candidate.outputs ?? [])
      .filter((output: any) => output.hash && outputs[output.path])
      .map((output: any) => ({
        path: output.path,
        hash: output.hash,
        decision: outputs[output.path] as "approved" | "rejected",
      })),
    manual = Object.entries(binaries)
      .filter(([path, detail]) => binaryPassed[path] && detail.trim())
      .map(([path, detail]) => ({ path, detail })),
    captures = (candidate.outputs ?? [])
      .filter((output: any) => output.hash && capturePaths[output.path])
      .map((output: any) => ({ path: output.path, hash: output.hash }));
  return (
    <section
      className="candidate-artifact-review"
      aria-label="Candidate artifact review"
      data-artifact-candidate={candidate.id}
    >
      <h4 tabIndex={-1}>Output and binary review</h4>
      <p>
        Review the actual candidate bytes. Initial path permission does not
        approve a new file's contents. These decisions do not execute scripts or
        accept the candidate.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <label>
        Filter artifact review paths
        <input
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setVisible(PAGE);
          }}
        />
      </label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform("preview", async () => {
            const ticket = generation.current;
            const value = await window.topsl.command({
              type: "candidate-review-preview",
              projectId,
              candidateId: candidate.id,
              outputs: decisions,
              binaries: manual,
              capturePaths: captures,
            });
            if (
              ticket === generation.current &&
              value.candidateId === candidate.id
            ) {
              setPlan(value);
            }
          });
        }}
      >
        <h5>Required outputs · {outputPaths.length} matching paths</h5>
        {outputPaths.slice(0, visible).map((output: any) => {
          const captured = candidate.files.some(
              (file: any) =>
                file.path === output.path && file.hash === output.hash,
            ),
            status = outputReviewState(
              candidate,
              receipts?.outputs ?? [],
              output,
            );
          return (
            <article key={output.path} className="artifact-review-row">
              <p className="path">
                <strong>{output.path}</strong> · {status} ·{" "}
                {output.required ? "required" : "optional"}
              </p>
              {!captured && (
                <p>
                  Bytes were withheld from this candidate. Approve a narrow
                  capture path and recapture before approving its contents.
                </p>
              )}
              {!captured && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    disabled={!!pending || !output.hash}
                    checked={capturePaths[output.path] ?? false}
                    onChange={(event) => {
                      setCapturePaths({
                        ...capturePaths,
                        [output.path]: event.target.checked,
                      });
                      setPlan(null);
                    }}
                  />
                  Capture proposed output {output.path}
                </label>
              )}
              <label>
                Output decision for {output.path}
                <select
                  disabled={!!pending || !output.hash}
                  value={outputs[output.path] ?? ""}
                  onChange={(event) => {
                    setOutputs({
                      ...outputs,
                      [output.path]: event.target.value as any,
                    });
                    setPlan(null);
                  }}
                >
                  <option value="">Keep recorded state</option>
                  <option value="approved" disabled={!captured}>
                    Approve captured contents
                  </option>
                  <option value="rejected">Reject these contents</option>
                </select>
              </label>
              <details>
                <summary>Output identity</summary>
                <p>{output.hash ?? "No captured hash; recapture required"}</p>
              </details>
            </article>
          );
        })}
        {!outputPaths.length && (
          <p>No matching output obligations are recorded.</p>
        )}
        <h5>
          Changed binary verification · {binaryPaths.length} matching paths
        </h5>
        {binaryPaths.slice(0, visible).map((path: string) => {
          const file = candidate.files.find((file: any) => file.path === path),
            receipt = (receipts?.binaries ?? []).find(
              (receipt) =>
                receipt.candidateId === candidate.id &&
                receipt.candidateRevision === candidate.revision &&
                receipt.path === path &&
                receipt.hash === file?.hash &&
                receipt.accepted,
            );
          return (
            <article key={path} className="artifact-review-row">
              <p className="path">
                <strong>{path}</strong> ·{" "}
                {receipt
                  ? "manual verification recorded"
                  : "manual verification required"}
              </p>
              {receipt && <p>Recorded result: {receipt.detail}</p>}
              <button
                type="button"
                disabled={!!pending}
                onClick={() => void perform("binary", () => readBinary(path))}
              >
                Preview pinned binary {path}
              </button>
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={!!pending}
                  checked={binaryPassed[path] ?? false}
                  onChange={(event) => {
                    setBinaryPassed({
                      ...binaryPassed,
                      [path]: event.target.checked,
                    });
                    setPlan(null);
                  }}
                />
                These exact bytes passed my manual verification: {path}
              </label>
              <label>
                Successful manual verification details for {path}
                <textarea
                  required={binaryPassed[path]}
                  disabled={!!pending}
                  value={binaries[path] ?? ""}
                  onChange={(event) => {
                    setBinaries({ ...binaries, [path]: event.target.value });
                    setPlan(null);
                  }}
                  placeholder="Describe the successful result and how these exact bytes were checked. Leave the attestation unchecked if verification failed or is incomplete."
                  maxLength={4000}
                />
              </label>
            </article>
          );
        })}
        {Math.max(outputPaths.length, binaryPaths.length) > visible && (
          <button type="button" onClick={() => setVisible(visible + PAGE)}>
            Show next {PAGE} artifact paths
          </button>
        )}
        <p>
          {decisions.length} output decisions · {manual.length} manual binary
          results · {captures.length} proposed paths selected. Review at most 50
          outputs or capture paths and 10 binaries per confirmation.
        </p>
        {!!captures.length && (
          <p>
            Narrow capture creates a new immutable candidate and requires fresh
            review and checks. Capture proposals separately from content
            decisions, then inspect and approve the captured bytes.
          </p>
        )}
        <button
          ref={reviewButton}
          disabled={
            !!pending ||
            (!decisions.length && !manual.length && !captures.length) ||
            decisions.length > 50 ||
            captures.length > 50 ||
            manual.length > 10 ||
            (!!captures.length && !!(decisions.length || manual.length))
          }
        >
          {captures.length
            ? "Review narrow output capture"
            : "Review exact artifact decisions"}
        </button>
      </form>
      {preview && (
        <figure aria-label="Pinned binary preview">
          <figcaption>
            {preview.path} · {preview.bytes} bytes · candidate{" "}
            {preview.candidateRevision}
          </figcaption>
          {safeRasterSource(preview) && (
            <img
              src={safeRasterSource(preview)!}
              alt={`Pinned candidate image ${preview.path}`}
            />
          )}
          <p>{preview.detail}</p>
          <details>
            <summary>Preview content identity</summary>
            <p>{preview.hash}</p>
          </details>
        </figure>
      )}
      {plan && (
        <section
          className="workflow-card"
          aria-label="Exact artifact decision plan"
        >
          <h5 ref={planHeading} tabIndex={-1}>
            Confirm exact candidate artifacts
          </h5>
          <p>
            Candidate {plan.candidateRevision}. This plan expires{" "}
            {new Date(plan.expiresAt).toLocaleString()}.
          </p>
          {plan.outputs.map((output: any) => (
            <p className="path" key={output.path}>
              {output.decision}: {output.path} · {output.hash}
            </p>
          ))}
          {plan.binaries.map((binary: any) => (
            <p className="path" key={binary.path}>
              Manual result: {binary.path} · {binary.hash} · {binary.detail}
            </p>
          ))}
          {(plan.capturePaths ?? []).map((capture: any) => (
            <p className="path" key={capture.path}>
              Capture into a new candidate: {capture.path} · {capture.hash}
            </p>
          ))}
          <p>
            Continue opens the native review of this protected plan. Cancel
            there leaves the recorded decisions unchanged.
          </p>
          <button
            disabled={!!pending}
            onClick={() =>
              void perform("apply", async () => {
                const ticket = generation.current;
                const result = await window.topsl.command({
                  type: "candidate-review-apply",
                  requestId: crypto.randomUUID(),
                  projectId,
                  id: plan.id,
                });
                if (ticket !== generation.current) return;
                if (result == null) {
                  setNotice(
                    "Native confirmation cancelled. Your proposed decisions are retained; no artifact review was recorded.",
                  );
                  return;
                }
                setNotice(
                  "Exact candidate artifact decision recorded. Candidate review and checks remain separate.",
                );
                setPlan(null);
                setOutputs({});
                setCapturePaths({});
                setBinaries({});
                setBinaryPassed({});
                await refresh();
                requestAnimationFrame(() => {
                  const heading = document.querySelector(
                    `[data-artifact-candidate="${CSS.escape(result.candidateId ?? candidate.id)}"] > h4`,
                  );
                  if (heading instanceof HTMLElement) heading.focus();
                });
              })
            }
          >
            Continue to native artifact confirmation
          </button>
          <button
            disabled={!!pending}
            onClick={() => {
              setPlan(null);
              requestAnimationFrame(() => reviewButton.current?.focus());
            }}
          >
            Revise decisions
          </button>
        </section>
      )}
    </section>
  );
}
