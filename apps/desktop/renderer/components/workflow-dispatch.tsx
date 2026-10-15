import { useEffect, useState } from "react";
export function WorkflowDispatch({
  projectId,
  workflow,
  pending,
  fresh,
  advance,
}: {
  projectId: string;
  workflow: any;
  pending: boolean;
  fresh: boolean;
  advance: () => Promise<unknown>;
}) {
  const [readiness, setReadiness] = useState<any>(null),
    [allowed, setAllowed] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setReadiness(null);
    setAllowed(false);
    setError("");
    if (["accepted", "cancelled"].includes(workflow.stage)) return;
    void Promise.all([
      window.topsl.command({
        type: "workflow-readiness-query",
        projectId,
        builder: workflow.builder,
        reviewer: workflow.reviewer,
      }),
      window.topsl.command({ type: "round-2-features-query", projectId }),
    ])
      .then(([route, features]) => {
        if (!alive) return;
        setReadiness(route);
        setAllowed(
          features.features.some(
            (feature: any) =>
              feature.id === "qualified-structured-routes" && feature.enabled,
          ),
        );
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [projectId, workflow.id, workflow.revision, workflow.stage]);
  if (["accepted", "cancelled"].includes(workflow.stage)) return null;
  return (
    <section aria-label="Workflow route readiness">
      <p>
        {readiness?.runnable && allowed
          ? "Selected coordinated roles currently satisfy recorded readiness."
          : "Coordinated dispatch is blocked; a protected draft or assisted handoff remains separate."}
        {readiness && ` Observed ${readiness.observedAt}.`}
      </p>
      {(["builder", "reviewer"] as const).map((role) =>
        readiness?.roles?.[role]?.blockers.map((blocker: any) => (
          <p key={`${role}:${blocker.code}`}>
            {role}: {blocker.detail} · next action:{" "}
            {blocker.action.replaceAll("-", " ")}
          </p>
        )),
      )}
      {!allowed && readiness && (
        <p>
          The service has disabled qualified structured dispatch for this
          rollout.
        </p>
      )}
      {error && <p role="alert">Route readiness: {error}</p>}
      {["ready-build", "ready-repair", "ready-review"].includes(
        workflow.stage,
      ) && (
        <button
          disabled={pending || !fresh || !allowed || !readiness?.runnable}
          onClick={() => void advance()}
        >
          {workflow.stage === "ready-review"
            ? "Start review of current candidate"
            : workflow.stage === "ready-repair"
              ? "Start next repair using recorded finding decisions"
              : "Approve captured inputs and start"}
        </button>
      )}
    </section>
  );
}
