import { now, uid } from "../domain/invariants";
import type { Store } from "../persistence/store";
import type { WorkflowFinding } from "./builder-reviewer";

/** Adjudication is separate from the immutable provider report it evaluates. */
export interface FindingDecision {
  id: string;
  projectId: string;
  workflowId: string;
  findingId: string;
  candidateId: string;
  decision: "accepted" | "rejected" | "resolved";
  rationale: string;
  actor: "local-user" | "subsequent-review";
  previousDecisionId: string | null;
  createdAt: string;
}

export function findingDecisions(
  store: Store,
  projectId: string,
  workflowId: string,
): FindingDecision[] {
  return [
    ...store.iterate<FindingDecision>("workflow-finding-decision", {
      projectId,
    }),
  ].filter((decision) => decision.workflowId === workflowId);
}

export function latestFindingDecision(
  store: Store,
  finding: WorkflowFinding,
): FindingDecision | undefined {
  const head = store.get<{ decisionId: string }>(
    "workflow-finding-decision-head",
    finding.id,
  );
  const decision =
    head &&
    store.get<FindingDecision>("workflow-finding-decision", head.decisionId);
  if (
    decision &&
    (decision.projectId !== finding.projectId ||
      decision.workflowId !== finding.workflowId ||
      decision.findingId !== finding.id)
  )
    throw new Error("Finding decision scope is inconsistent.");
  return decision;
}

export function findingBlocks(store: Store, finding: WorkflowFinding): boolean {
  const decision = latestFindingDecision(store, finding);
  return decision
    ? decision.decision === "accepted"
    : finding.disposition === "open";
}

export function recordFindingDecision(
  store: Store,
  finding: WorkflowFinding,
  input: Pick<
    FindingDecision,
    "candidateId" | "decision" | "rationale" | "actor"
  > & { expectedDecisionId: string | null },
): FindingDecision {
  const rationale = input.rationale.trim();
  if (!rationale || rationale.length > 20_000)
    throw new Error(
      "A finding decision requires a bounded, nonempty rationale.",
    );
  return store.transaction(() => {
    const previous = latestFindingDecision(store, finding);
    if ((previous?.id ?? null) !== input.expectedDecisionId)
      throw new Error(
        "This finding decision changed. Refresh before adjudicating it.",
      );
    const decision: FindingDecision = {
      id: uid(),
      projectId: finding.projectId,
      workflowId: finding.workflowId,
      findingId: finding.id,
      candidateId: input.candidateId,
      decision: input.decision,
      rationale,
      actor: input.actor,
      previousDecisionId: previous?.id ?? null,
      createdAt: now(),
    };
    store.immutable("workflow-finding-decision", decision);
    store.put("workflow-finding-decision-head", {
      id: finding.id,
      projectId: finding.projectId,
      workflowId: finding.workflowId,
      decisionId: decision.id,
    });
    return decision;
  });
}
