import { useEffect, useRef, useState } from "react";
import type { Installation } from "../../../packages/domain/types";
import type { ProviderCapability } from "../../../packages/providers/contract";
import type { BuilderReviewerState } from "../../../packages/workflows/builder-reviewer";
import { useScopedRefresh } from "./state/scoped";
import type { CheckPlan } from "../../../packages/workflows/verification";
type Item = BuilderReviewerState & {
  revision: number;
  objective: string;
  latestSpecificationId: string;
  candidateRevision: string;
  checksStatus: Array<{
    definition: string;
    result: string;
    targetRevision: string;
  }>;
};
type Snapshot = {
  workflows: Item[];
  runtimes: Array<{
    installation: Installation;
    capabilities: ProviderCapability[];
  }>;
  checkRuntime: string;
};
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function Workflows({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [pending, setPending] = useState<Record<string, boolean>>({}),
    [error, setError] = useState("");
  const [objective, setObjective] = useState(""),
    [criteria, setCriteria] = useState(""),
    [builder, setBuilder] = useState("codex");
  const [builderModel, setBuilderModel] = useState(""),
    [reviewerModel, setReviewerModel] = useState(""),
    [builderRuntime, setBuilderRuntime] = useState(""),
    [reviewerRuntime, setReviewerRuntime] = useState(""),
    [nativeModels, setNativeModels] = useState<Record<string, any[]>>({}),
    [activeWorkflow, setActiveWorkflow] = useState(""),
    [selected, setSelected] = useState(""),
    [untracked, setUntracked] = useState(""),
    [executable, setExecutable] = useState(""),
    [args, setArgs] = useState('["--test"]');
  const [inspection, setInspection] = useState<any>(null),
    generation = useRef(0);
  async function refresh() {
    const ticket = generation.current;
    const next: Snapshot = await window.topsl.command({
      type: "builder-reviewer-query",
      projectId,
    });
    if (ticket === generation.current) {
      setSnapshot(next);
      setExecutable((value) => value || next.checkRuntime);
    }
  }
  useEffect(() => {
    generation.current++;
    setSnapshot(null);
    setInspection(null);
    setError("");
    if (projectId) void refresh().catch((e) => setError(e.message));
    return () => {
      generation.current++;
    };
  }, [projectId]);
  useScopedRefresh(projectId, refresh);
  useEffect(() => {
    void window.topsl.command({ type: "navigation-query" }).then((value) => {
      if (value.projectId === projectId)
        setActiveWorkflow(value.workflowId ?? "");
    });
  }, [projectId]);
  const builderProvider = builder === "codex" ? "codex" : "claude",
    reviewerProvider = builderProvider === "codex" ? "claude" : "codex";
  const choices = (provider: string) =>
    snapshot?.runtimes.filter(
      (r) =>
        r.installation.trusted &&
        r.installation.appId ===
          (provider === "codex"
            ? "openai.codex-cli"
            : "anthropic.claude-code-cli"),
    ) ?? [];
  const chosenBuilder = choices(builderProvider).find(
      (r) => r.installation.id === builderRuntime,
    ),
    chosenReviewer = choices(reviewerProvider).find(
      (r) => r.installation.id === reviewerRuntime,
    );
  async function run(key: string, action: () => Promise<unknown>) {
    const ticket = generation.current;
    setPending((p) => ({ ...p, [key]: true }));
    setError("");
    try {
      await action();
      if (ticket === generation.current) await refresh();
    } catch (e: any) {
      if (ticket === generation.current) setError(e.message);
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
    }
  }
  async function create() {
    const ticket = generation.current;
    const parsed: unknown = JSON.parse(args);
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string"))
      throw new Error("Check arguments must be a JSON array of strings.");
    if (!chosenBuilder || !chosenReviewer)
      throw new Error("Connect and trust both selected runtimes first.");
    await window.topsl.command({
      type: "builder-reviewer-create",
      requestId: crypto.randomUUID(),
      projectId,
      objective,
      acceptanceCriteria: lines(criteria),
      interfaces: [],
      builder: {
        provider: builderProvider,
        installationId: chosenBuilder.installation.id,
        model: builderModel,
      },
      reviewer: {
        provider: reviewerProvider,
        installationId: chosenReviewer.installation.id,
        model: reviewerModel,
      },
      selectedPaths: selected.trim() ? lines(selected) : undefined,
      approvedUntracked: lines(untracked),
      maxRepairs: 2,
      requireIndependence: false,
      checks: [
        {
          id: "required-check",
          label: "Required project check",
          executable,
          args: parsed as string[],
          timeoutMs: 120000,
        },
      ],
    });
    if (ticket === generation.current) {
      setObjective("");
      setCriteria("");
    }
  }
  return (
    <section
      aria-label="Builder reviewer workflows"
      className="workflow-section"
    >
      <h2>Build and review</h2>
      <p className="muted">
        One request, a fresh review of captured files, up to two repair rounds,
        required checks and explicit acceptance. Independent filesystem
        isolation is not enforced.
      </p>
      {error && <p role="alert">{error}</p>}
      {!projectId ? (
        <p>Select a project to create a workflow.</p>
      ) : (
        <>
          <details>
            <summary>Create a workflow</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run("create", create);
              }}
              className="workflow-form"
            >
              <label>
                Objective
                <textarea
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  required
                />
              </label>
              <label>
                Acceptance criteria · one per line
                <textarea
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  required
                />
              </label>
              <label>
                Provider assignment
                <select
                  value={builder}
                  onChange={(e) => setBuilder(e.target.value)}
                >
                  <option value="codex">Codex builds · Claude reviews</option>
                  <option value="claude">Claude builds · Codex reviews</option>
                </select>
              </label>
              <label>
                Builder runtime
                <select
                  value={builderRuntime}
                  onChange={(e) => setBuilderRuntime(e.target.value)}
                  required
                >
                  <option value="">Select trusted builder runtime</option>
                  {choices(builderProvider).map((r) => (
                    <option key={r.installation.id} value={r.installation.id}>
                      {r.installation.version ?? "Unverified version"} ·{" "}
                      {r.installation.realPath}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reviewer runtime
                <select
                  value={reviewerRuntime}
                  onChange={(e) => setReviewerRuntime(e.target.value)}
                  required
                >
                  <option value="">Select trusted reviewer runtime</option>
                  {choices(reviewerProvider).map((r) => (
                    <option key={r.installation.id} value={r.installation.id}>
                      {r.installation.version ?? "Unverified version"} ·{" "}
                      {r.installation.realPath}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!chosenBuilder || pending.modelsBuilder}
                onClick={() =>
                  void run("modelsBuilder", async () => {
                    const result = await window.topsl.command({
                      type: "runtime-models",
                      id: builderRuntime,
                    });
                    setNativeModels((p) => ({
                      ...p,
                      [builderRuntime]: result.models ?? result,
                    }));
                  })
                }
              >
                Discover builder models
              </button>
              <button
                type="button"
                disabled={!chosenReviewer || pending.modelsReviewer}
                onClick={() =>
                  void run("modelsReviewer", async () => {
                    const result = await window.topsl.command({
                      type: "runtime-models",
                      id: reviewerRuntime,
                    });
                    setNativeModels((p) => ({
                      ...p,
                      [reviewerRuntime]: result.models ?? result,
                    }));
                  })
                }
              >
                Discover reviewer models
              </button>
              <datalist id="builder-native-models">
                {(nativeModels[builderRuntime] ?? []).map((model) => (
                  <option
                    key={model.model ?? model.id}
                    value={model.model ?? model.id}
                  />
                ))}
              </datalist>
              <datalist id="reviewer-native-models">
                {(nativeModels[reviewerRuntime] ?? []).map((model) => (
                  <option
                    key={model.model ?? model.id}
                    value={model.model ?? model.id}
                  />
                ))}
              </datalist>
              <label>
                Requested builder model
                <input
                  list="builder-native-models"
                  value={builderModel}
                  onChange={(e) => setBuilderModel(e.target.value)}
                  placeholder="Native model ID or alias"
                  required
                />
              </label>
              <label>
                Requested reviewer model
                <input
                  list="reviewer-native-models"
                  value={reviewerModel}
                  onChange={(e) => setReviewerModel(e.target.value)}
                  placeholder="Native model ID or alias"
                  required
                />
              </label>
              {[chosenBuilder, chosenReviewer].filter(Boolean).map((r) => (
                <p key={r!.installation.id} className="muted">
                  {r!.installation.appId} ·{" "}
                  {r!.installation.version ?? "unknown"} ·{" "}
                  {r!.installation.realPath}
                  <br />
                  Structured route:{" "}
                  {r!.capabilities.find((c) => c.name === "structured-turn")
                    ?.support ?? "unknown"}
                  . {r!.capabilities[0]?.evidence.detail}
                </p>
              ))}
              <label>
                Non-Git content manifest · relative files, one per line
                <textarea
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  placeholder="Git workspaces capture safe tracked files automatically."
                />
              </label>
              <label>
                Approved untracked output paths · one per line
                <textarea
                  value={untracked}
                  onChange={(e) => setUntracked(e.target.value)}
                  placeholder="Only explicitly selected new files enter the candidate."
                />
              </label>
              <label>
                Required check · absolute executable
                <input
                  value={executable}
                  onChange={(e) => setExecutable(e.target.value)}
                  required
                />
              </label>
              <label>
                Check arguments · JSON array
                <input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  required
                />
              </label>
              <p className="muted">
                Checks run on captured files in a temporary workspace.
                Dependencies are not installed automatically. Each exact check
                command receives native review. Provider routes stay gated until
                their required capabilities are verified.
              </p>
              <button
                type="submit"
                disabled={pending.create || !chosenBuilder || !chosenReviewer}
              >
                {pending.create ? "Creating…" : "Capture request"}
              </button>
            </form>
          </details>
          {snapshot?.workflows.map((workflow) => (
            <article
              key={workflow.id}
              className={`workflow-card ${activeWorkflow === workflow.id ? "selected" : ""}`}
            >
              <h3>{workflow.objective}</h3>
              <p>{workflow.stage.replaceAll("-", " ")}</p>
              {workflow.latestSpecificationId !== workflow.specificationId && (
                <p role="status">
                  A newer specification is available. Current attempts keep
                  their recorded inputs; restart explicitly to use it.
                </p>
              )}
              {!["accepted", "cancelled"].includes(workflow.stage) && (
                <details>
                  <summary>Revise workflow requirements</summary>
                  <form
                    className="workflow-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void run(workflow.id, () =>
                        window.topsl.command({
                          type: "builder-reviewer-specification-publish",
                          requestId: crypto.randomUUID(),
                          id: workflow.id,
                          expectedRevision: workflow.revision,
                          objective: String(form.get("objective")),
                          acceptanceCriteria: lines(
                            String(form.get("criteria")),
                          ),
                          interfaces: lines(String(form.get("interfaces"))),
                        }),
                      );
                    }}
                  >
                    <label>
                      Updated objective
                      <textarea
                        name="objective"
                        defaultValue={workflow.objective}
                        required
                      />
                    </label>
                    <label>
                      Updated acceptance criteria · one per line
                      <textarea name="criteria" required />
                    </label>
                    <label>
                      Interface requirements · one per line
                      <textarea name="interfaces" />
                    </label>
                    <button disabled={pending[workflow.id]}>
                      Publish new specification
                    </button>
                  </form>
                  {workflow.latestSpecificationId !==
                    workflow.specificationId && (
                    <button
                      disabled={pending[workflow.id]}
                      onClick={() =>
                        void run(workflow.id, () =>
                          window.topsl.command({
                            type: "builder-reviewer-specification-restart",
                            requestId: crypto.randomUUID(),
                            id: workflow.id,
                            expectedRevision: workflow.revision,
                            specificationId: workflow.latestSpecificationId,
                          }),
                        )
                      }
                    >
                      Interrupt and prepare restart on latest specification
                    </button>
                  )}
                  <p className="muted">
                    Restart prepares new work. Dispatch still requires an
                    explicit workflow action; unknown attempts are never
                    replayed.
                  </p>
                </details>
              )}
              <p>{workflow.detail}</p>
              <dl>
                <dt>Builder</dt>
                <dd>
                  {workflow.builder.provider} · requested{" "}
                  {workflow.builder.model}
                </dd>
                <dt>Reviewer</dt>
                <dd>
                  {workflow.reviewer.provider} · requested{" "}
                  {workflow.reviewer.model}
                </dd>
                <dt>Candidate</dt>
                <dd className="path">{workflow.candidateRevision}</dd>
                <dt>Repair rounds</dt>
                <dd>
                  {workflow.repairRound} / {workflow.maxRepairs}
                </dd>
                <dt>Isolation</dt>
                <dd>Independence not enforced</dd>
              </dl>
              {workflow.checksStatus.map((check) => (
                <p key={check.definition}>
                  {check.definition}: {check.result} on{" "}
                  {check.targetRevision.slice(0, 12)}
                </p>
              ))}
              <div className="workflow-actions">
                {workflow.stage === "ready-build" && (
                  <button
                    disabled={pending[workflow.id]}
                    onClick={() =>
                      void run(workflow.id, () =>
                        window.topsl.command({
                          type: "builder-reviewer-advance",
                          requestId: crypto.randomUUID(),
                          id: workflow.id,
                          expectedRevision: workflow.revision,
                        }),
                      )
                    }
                  >
                    Approve captured inputs and start
                  </button>
                )}
                {workflow.stage === "checking" && (
                  <button
                    disabled={pending[workflow.id]}
                    onClick={() =>
                      void run(workflow.id, async () => {
                        const plans: CheckPlan[] = await window.topsl.command({
                          type: "builder-reviewer-checks-preview",
                          id: workflow.id,
                          expectedRevision: workflow.revision,
                        });
                        for (const plan of plans)
                          await window.topsl.command({
                            type: "builder-reviewer-check-apply",
                            requestId: crypto.randomUUID(),
                            id: plan.id,
                          });
                      })
                    }
                  >
                    Review and run checks
                  </button>
                )}
                {workflow.stage === "awaiting-acceptance" && (
                  <button
                    disabled={pending[workflow.id]}
                    onClick={() =>
                      void run(workflow.id, () =>
                        window.topsl.command({
                          type: "builder-reviewer-accept",
                          requestId: crypto.randomUUID(),
                          id: workflow.id,
                          expectedRevision: workflow.revision,
                        }),
                      )
                    }
                  >
                    Review final acceptance
                  </button>
                )}
                <button
                  disabled={pending[workflow.id]}
                  onClick={() =>
                    void run(workflow.id, async () => {
                      const ticket = generation.current;
                      setActiveWorkflow(workflow.id);
                      await window.topsl.command({
                        type: "navigation-save",
                        projectId,
                        workflowId: workflow.id,
                        projectView: "changes",
                      });
                      const inspected = await window.topsl.command({
                        type: "builder-reviewer-inspect",
                        id: workflow.id,
                      });
                      if (ticket === generation.current)
                        setInspection(inspected);
                    })
                  }
                >
                  Inspect changes and context
                </button>
                {!["accepted", "cancelled"].includes(workflow.stage) && (
                  <button
                    disabled={pending[workflow.id]}
                    onClick={() =>
                      void run(workflow.id, () =>
                        window.topsl.command({
                          type: "builder-reviewer-cancel",
                          requestId: crypto.randomUUID(),
                          id: workflow.id,
                          expectedRevision: workflow.revision,
                        }),
                      )
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>
            </article>
          ))}
          {inspection && (
            <section aria-label="Workflow evidence">
              <h3>Changes and context</h3>
              <button onClick={() => setInspection(null)}>
                Close inspection
              </button>
              <p>Candidate {inspection.candidate.revision}</p>
              <ul>
                {inspection.candidate.files.map((file: any) => (
                  <li key={file.path}>
                    {file.path} · {file.hash ?? "deleted"} · {file.bytes} bytes
                  </li>
                ))}
              </ul>
              <details>
                <summary>Captured file content</summary>
                {inspection.candidate.files
                  .filter((file: any) => file.content !== null)
                  .map((file: any) => (
                    <article key={file.path}>
                      <h4>{file.path}</h4>
                      <pre>
                        {new TextDecoder().decode(
                          Uint8Array.from(atob(file.content), (c) =>
                            c.charCodeAt(0),
                          ),
                        )}
                      </pre>
                    </article>
                  ))}
              </details>
              <h4>Findings</h4>
              {inspection.findings.length ? (
                inspection.findings.map((finding: any) => (
                  <p key={finding.id}>
                    {finding.severity} · {finding.title} · {finding.disposition}
                    <br />
                    {finding.file}:{finding.line} · {finding.behavior}
                    <br />
                    Evidence: {finding.evidence}
                  </p>
                ))
              ) : (
                <p>No substantiated findings recorded.</p>
              )}
              <details>
                <summary>Omissions</summary>
                <ul>
                  {inspection.candidate.omissions.map(
                    (omission: any, i: number) => (
                      <li key={i}>
                        {omission.source}: {omission.reason}
                      </li>
                    ),
                  )}
                </ul>
              </details>
              <details>
                <summary>Delivered context packages</summary>
                {inspection.contexts.map((context: any) => (
                  <article key={context.id}>
                    <p>
                      {context.role} · specification{" "}
                      {context.specificationRevision} · {context.bytes} bytes ·{" "}
                      {context.tokenEvidence}
                    </p>
                    <pre>{context.content}</pre>
                  </article>
                ))}
              </details>
              <details>
                <summary>Delivery evidence</summary>
                {inspection.deliveries.map((delivery: any) => (
                  <p key={delivery.id}>
                    {delivery.state} · {delivery.evidence} · {delivery.detail}
                  </p>
                ))}
              </details>
            </section>
          )}
        </>
      )}
    </section>
  );
}
