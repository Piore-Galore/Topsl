import { useEffect, useRef, useState } from "react";
import type { Command } from "../../../../packages/domain/commands";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { Freshness } from "./freshness";
export function ParallelActivity({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<any>(null),
    [inspection, setInspection] = useState<any>(null),
    [pending, setPending] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [resolutions, setResolutions] = useState<Record<string, string>>({});
  const generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId));
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    setSnapshot(null);
    setInspection(null);
    setResolutions({});
    setErrors({});
    setPending({});
    return () => {
      generation.current++;
    };
  }, [projectId]);
  async function refresh() {
    const ticket = reads.current.begin();
    const value = await window.topsl.command({
      type: "parallel-query",
      projectId,
    });
    if (reads.current.accept(ticket, value)) setSnapshot(value);
  }
  const freshness = useScopedRefresh(projectId, refresh);
  async function run(key: string, command: Command) {
    const ticket = generation.current;
    setPending((current) => ({ ...current, [key]: true }));
    setErrors((current) => ({ ...current, [key]: "" }));
    try {
      const result = await window.topsl.command(command);
      if (ticket !== generation.current) return;
      await refresh();
      return result;
    } catch (error: any) {
      if (ticket === generation.current)
        setErrors((current) => ({ ...current, [key]: error.message }));
    } finally {
      if (ticket === generation.current)
        setPending((current) => ({ ...current, [key]: false }));
    }
  }
  return (
    <section aria-label="Parallel integration queue">
      <h2>Parallel integration</h2>
      <Freshness state={freshness} retry={freshness.retry} />
      <p>
        Specialists keep separate approved workspaces. Combined checks and
        acceptance apply to the combined candidate; individual successes do not
        establish integration.
      </p>
      {Object.entries(errors)
        .filter(([, error]) => error)
        .map(([key, error]) => (
          <p key={key} role="alert">
            {error}
          </p>
        ))}
      {!snapshot?.workflows.length && (
        <p className="muted">
          No parallel run is recorded. Live parallel routes remain gated until
          the selected runtime proves bounded native fan-out and the required
          workspace controls.
        </p>
      )}
      {snapshot?.workflows.map((workflow: any) => (
        <article key={workflow.id} className="workflow-card">
          <h3>Specialist group · {workflow.stage.replaceAll("-", " ")}</h3>
          <p>{workflow.detail}</p>
          {workflow.tasks.map((task: any) => (
            <section key={task.key}>
              <h4>{task.title}</h4>
              <p>
                {task.provider} · requested {task.model} ·{" "}
                {task.candidateId
                  ? "Candidate submitted"
                  : task.attemptId
                    ? "Attempt recorded"
                    : "Ready for explicit dispatch"}
              </p>
              <p>Permitted outputs: {task.permittedOutputs.join(", ")}</p>
              <div className="workflow-actions">
                {!task.attemptId && (
                  <button
                    disabled={pending[workflow.id]}
                    onClick={() =>
                      void run(workflow.id, {
                        type: "parallel-dispatch",
                        requestId: crypto.randomUUID(),
                        id: workflow.id,
                        expectedRevision: workflow.revision,
                        key: task.key,
                      })
                    }
                  >
                    Dispatch {task.title}
                  </button>
                )}
                {task.attemptId && !task.candidateId && (
                  <button
                    disabled={pending[workflow.id]}
                    onClick={() =>
                      void run(workflow.id, {
                        type: "parallel-submit",
                        requestId: crypto.randomUUID(),
                        id: workflow.id,
                        expectedRevision: workflow.revision,
                        key: task.key,
                        approvedUntracked: task.permittedOutputs,
                      })
                    }
                  >
                    Capture declared outputs
                  </button>
                )}
              </div>
            </section>
          ))}
          <p>
            Queued candidates:{" "}
            {
              snapshot.queue.filter(
                (submission: any) => submission.workflowId === workflow.id,
              ).length
            }
          </p>
          <div className="workflow-actions">
            {["submitted", "conflict"].includes(workflow.stage) && (
              <button
                disabled={pending[workflow.id]}
                onClick={() =>
                  void (async () => {
                    const plan = await run(workflow.id, {
                      type: "parallel-integration-preview",
                      id: workflow.id,
                      expectedRevision: workflow.revision,
                      resolutions: Object.entries(resolutions).map(
                        ([path, candidateId]) => ({ path, candidateId }),
                      ),
                    });
                    if (plan) setInspection({ workflowId: workflow.id, plan });
                  })()
                }
              >
                Preview combined candidate
              </button>
            )}
            {workflow.stage === "checking" && (
              <button
                disabled={pending[workflow.id]}
                onClick={() =>
                  void (async () => {
                    const plans = await run(workflow.id, {
                      type: "parallel-checks-preview",
                      id: workflow.id,
                      expectedRevision: workflow.revision,
                    });
                    if (plans)
                      for (const plan of plans)
                        await run(workflow.id, {
                          type: "parallel-check-apply",
                          requestId: crypto.randomUUID(),
                          id: plan.id,
                        });
                  })()
                }
              >
                Review combined checks…
              </button>
            )}
            {workflow.stage === "awaiting-acceptance" && (
              <button
                disabled={pending[workflow.id]}
                onClick={() =>
                  void run(workflow.id, {
                    type: "parallel-accept",
                    requestId: crypto.randomUUID(),
                    id: workflow.id,
                    expectedRevision: workflow.revision,
                  })
                }
              >
                Review combined acceptance…
              </button>
            )}
            {!["accepted", "cancelled"].includes(workflow.stage) && (
              <button
                disabled={pending[workflow.id]}
                onClick={() =>
                  void run(workflow.id, {
                    type: "parallel-cancel",
                    requestId: crypto.randomUUID(),
                    id: workflow.id,
                    expectedRevision: workflow.revision,
                  })
                }
              >
                Cancel specialist group
              </button>
            )}
          </div>
        </article>
      ))}
      {inspection && (
        <section
          className="workflow-card"
          aria-label="Combined candidate preview"
        >
          <h3>Combined candidate preview</h3>
          <p>
            {inspection.plan.files.length} captured files ·{" "}
            {inspection.plan.conflicts.length} unresolved file conflicts
          </p>
          {inspection.plan.conflicts.map((conflict: any) => (
            <label key={conflict.path}>
              {conflict.path} · {conflict.reason}
              <select
                value={resolutions[conflict.path] ?? ""}
                onChange={(event) =>
                  setResolutions((current) => ({
                    ...current,
                    [conflict.path]: event.target.value,
                  }))
                }
              >
                <option value="">
                  Choose a submitted candidate explicitly
                </option>
                {conflict.candidateIds.map((id: string) => (
                  <option key={id} value={id}>
                    {snapshot.workflows
                      .find(
                        (workflow: any) =>
                          workflow.id === inspection.workflowId,
                      )
                      ?.tasks.find((task: any) => task.candidateId === id)
                      ?.title ?? "Historical candidate"}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!inspection.plan.conflicts.length && (
            <button
              disabled={pending[inspection.workflowId]}
              onClick={() =>
                void run(inspection.workflowId, {
                  type: "parallel-integration-apply",
                  requestId: crypto.randomUUID(),
                  id: inspection.plan.id,
                })
              }
            >
              Review integration application…
            </button>
          )}
          <button onClick={() => setInspection(null)}>
            Close combined preview
          </button>
        </section>
      )}
    </section>
  );
}
