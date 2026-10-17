import { useEffect, useRef, useState } from "react";
import type { Approval, Installation } from "../../../packages/domain/types";
import type { ProviderCapability } from "../../../packages/providers/contract";
import type { BuilderReviewerState } from "../../../packages/workflows/builder-reviewer";
import { ScopedReadFence, useScopedRefresh } from "./state/scoped";
import { Freshness } from "./components/freshness";
import { codexPairingNote, WorkflowSetup } from "./components/workflow-setup";
import { WorkflowEvidence } from "./components/workflow-evidence";
import { AssistedHandoff } from "./components/assisted-handoff";
import { SpecificationDraft } from "./components/specification-draft";
import { WorkflowDispatch } from "./components/workflow-dispatch";
import { ApprovalCard } from "./components/approval-card";
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
  /** Requests the running turn waits on, answered here as in its chat. */
  approvals: Approval[];
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
  const [activeWorkflow, setActiveWorkflow] = useState("");
  const [inspection, setInspection] = useState<any>(null),
    generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId)),
    inspectionReads = useRef(new ScopedReadFence(projectId)),
    activeInspection = useRef("");
  async function refresh() {
    const ticket = reads.current.begin();
    const next: Snapshot = await window.topsl.command({
      type: "builder-reviewer-query",
      projectId,
    });
    if (reads.current.accept(ticket, next)) {
      setSnapshot(next);
      const inspectedId = activeInspection.current;
      if (
        inspectedId &&
        next.workflows.some((workflow) => workflow.id === inspectedId)
      ) {
        const readTicket = inspectionReads.current.begin();
        const value = await window.topsl.command({
          type: "builder-reviewer-inspect",
          id: inspectedId,
        });
        if (
          activeInspection.current === inspectedId &&
          inspectionReads.current.accept(readTicket, value)
        )
          setInspection(value);
      }
    }
  }
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    inspectionReads.current.reset(projectId);
    setSnapshot(null);
    setInspection(null);
    activeInspection.current = "";
    setError("");
    setPending({});
    setActiveWorkflow("");
    return () => {
      generation.current++;
    };
  }, [projectId]);
  const freshness = useScopedRefresh(projectId, refresh);
  useEffect(() => {
    const ticket = generation.current;
    void window.topsl
      .command({ type: "navigation-query" })
      .then((value) => {
        if (ticket === generation.current && value.projectId === projectId)
          setActiveWorkflow(value.workflowId ?? "");
      })
      .catch((error) => {
        if (ticket === generation.current) setError(error.message);
      });
  }, [projectId]);
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
      if (ticket === generation.current)
        setPending((p) => ({ ...p, [key]: false }));
    }
  }
  return (
    <section
      aria-label="Builder reviewer workflows"
      className="workflow-section"
    >
      <h2>Build and review</h2>
      {projectId && <Freshness state={freshness} retry={freshness.retry} />}
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
          <WorkflowSetup
            key={projectId}
            projectId={projectId}
            runtimes={snapshot?.runtimes ?? []}
            checkRuntime={snapshot?.checkRuntime ?? ""}
            afterCreate={refresh}
          />
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
                  <SpecificationDraft
                    key={`${projectId}:${workflow.id}`}
                    projectId={projectId}
                    workflow={workflow}
                    publish={(input) =>
                      run(workflow.id, () =>
                        window.topsl.command({
                          type: "builder-reviewer-specification-publish",
                          requestId: crypto.randomUUID(),
                          id: workflow.id,
                          expectedRevision: workflow.revision,
                          ...input,
                        }),
                      )
                    }
                  />
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
              {workflow.approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  decide={(allow) =>
                    run(workflow.id, () =>
                      window.topsl.command({
                        type: "approval-decide",
                        id: approval.id,
                        allow,
                      }),
                    )
                  }
                />
              ))}
              <AssistedHandoff
                projectId={projectId}
                workflow={workflow}
                afterImport={refresh}
              />
              <dl>
                <dt>Builder</dt>
                <dd>
                  {workflow.builder.provider} · requested{" "}
                  {workflow.builder.model} · effective settings require a
                  runtime report
                </dd>
                <dt>Reviewer</dt>
                <dd>
                  {workflow.reviewer.provider} · requested{" "}
                  {workflow.reviewer.model} · effective settings require a
                  runtime report
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
              {workflow.builder.provider === "codex" &&
                workflow.reviewer.provider === "codex" && (
                  <p>{codexPairingNote}</p>
                )}
              {workflow.checksStatus.map((check) => (
                <p key={check.definition}>
                  {check.definition}: {check.result} on{" "}
                  {check.targetRevision.slice(0, 12)}
                </p>
              ))}
              <div className="workflow-actions">
                <WorkflowDispatch
                  projectId={projectId}
                  workflow={workflow}
                  pending={!!pending[workflow.id]}
                  fresh={freshness.status === "current"}
                  advance={() =>
                    run(workflow.id, () =>
                      window.topsl.command({
                        type: "builder-reviewer-advance",
                        requestId: crypto.randomUUID(),
                        id: workflow.id,
                        expectedRevision: workflow.revision,
                      }),
                    )
                  }
                />
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
                      const ticket = generation.current,
                        readTicket = inspectionReads.current.begin();
                      activeInspection.current = workflow.id;
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
                      if (
                        ticket === generation.current &&
                        activeInspection.current === workflow.id &&
                        inspectionReads.current.accept(readTicket, inspected)
                      )
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
            <WorkflowEvidence
              key={`${projectId}:${inspection.state.id}`}
              projectId={projectId}
              inspection={inspection}
              close={() => {
                activeInspection.current = "";
                setInspection(null);
              }}
              refresh={async () => {
                const ticket = inspectionReads.current.begin();
                const value = await window.topsl.command({
                  type: "builder-reviewer-inspect",
                  id: inspection.state.id,
                });
                if (inspectionReads.current.accept(ticket, value))
                  setInspection(value);
                await refresh();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
