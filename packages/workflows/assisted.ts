import { hash, now, stable, uid } from "../domain/invariants";
import type { Store } from "../persistence/store";
import type { BuilderReviewerState } from "./builder-reviewer";
import { reviewSchema } from "./builder-reviewer";
import {
  assertCandidateCurrent,
  candidateHasTextLine,
  candidateText,
  type CandidateSnapshot,
} from "./candidates";
import { RevisionRepository } from "../context/revisions";
export interface AssistedHandoff {
  id: string;
  projectId: string;
  workflowId: string;
  installationId: string;
  role: "builder" | "reviewer";
  candidateId: string;
  candidateRevision: string;
  specificationId: string;
  handoffHash: string;
  handoffText: string;
  createdAt: string;
  attribution: "externally-controlled";
}
interface AssistedState {
  id: string;
  projectId: string;
  workflowId: string;
  state: "prepared" | "externally-controlled" | "imported";
  externalWritingStopped: boolean;
  updatedAt: string;
}
/** Assisted reports are retained as attributed evidence. They never manufacture a managed attempt or provider acknowledgement. */
export class AssistedWorkflows {
  constructor(private store: Store) {}
  private workflow(projectId: string, workflowId: string) {
    const value = this.store.get<BuilderReviewerState>(
      "builder-reviewer",
      workflowId,
    );
    if (!value || value.projectId !== projectId)
      throw new Error(
        "Assisted workflow belongs to another project or no longer exists.",
      );
    return value;
  }
  private candidate(id: string) {
    const value = this.store.get<CandidateSnapshot>("candidate", id);
    if (!value)
      throw new Error(
        "Capture an immutable candidate before preparing an assisted handoff.",
      );
    return value;
  }
  query(projectId: string, workflowId: string) {
    this.workflow(projectId, workflowId);
    return {
      handoffs: [
        ...this.store.iterate<AssistedHandoff>("assisted-handoff", {
          projectId,
        }),
      ]
        .filter((h) => h.workflowId === workflowId)
        .map((h) => ({
          ...h,
          control: this.store.get<AssistedState>(
            "assisted-handoff-state",
            h.id,
          ),
        })),
      imports: [
        ...this.store.iterate<any>("assisted-result", { projectId }),
      ].filter((r) => r.workflowId === workflowId),
    };
  }
  async prepare(input: {
    projectId: string;
    workflowId: string;
    installationId: string;
    role: "builder" | "reviewer";
    exportApproved: true;
  }) {
    const workflow = this.workflow(input.projectId, input.workflowId),
      candidate = this.candidate(workflow.candidateId),
      specification = this.store.get(
        "workflow-specification",
        workflow.specificationId,
      );
    await assertCandidateCurrent(candidate);
    if (!input.exportApproved || !specification)
      throw new Error(
        "Review and approve the pinned handoff scope and specification first.",
      );
    const handoffText = stable({
      mode: "assisted-native",
      attribution: "externally-controlled",
      role: input.role,
      projectId: input.projectId,
      workflowId: input.workflowId,
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      specificationId: workflow.specificationId,
      specification,
      candidate: candidateText(candidate),
      exportCoverage: {
        text:
          candidate.formatVersion === 2
            ? "Bounded excerpts and manifest metadata. Omitted file contents are not included in this handoff."
            : "Captured text is included within this export's byte limit.",
        binary:
          "Hashes and metadata do not establish visual or binary verification.",
        continuation:
          "Native folder access observes a live workspace. Imports are marked stale when its pinned inputs changed.",
      },
      instructions:
        input.role === "reviewer"
          ? "Review this exact candidate. Return JSON with candidateRevision, summary and findings (title,severity high|medium|low,file,line,behavior,evidence). Do not modify the workspace."
          : "Work only within the approved candidate scope. Stop native writing before importing your report. Managed checks and acceptance remain separate.",
    });
    if (Buffer.byteLength(handoffText) > 1_000_000)
      throw new Error(
        "Assisted handoff exceeds the bounded export limit; review a smaller explicit scope.",
      );
    const handoff: AssistedHandoff = {
      id: uid(),
      ...input,
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      specificationId: workflow.specificationId,
      handoffHash: hash(handoffText),
      handoffText,
      createdAt: now(),
      attribution: "externally-controlled",
    };
    this.store.immutable("assisted-handoff", handoff);
    this.store.put("assisted-handoff-state", {
      id: handoff.id,
      projectId: input.projectId,
      workflowId: input.workflowId,
      state: "prepared",
      externalWritingStopped: true,
      updatedAt: now(),
    } satisfies AssistedState);
    return handoff;
  }
  get(projectId: string, id: string) {
    const handoff = this.store.get<AssistedHandoff>("assisted-handoff", id);
    if (!handoff || handoff.projectId !== projectId)
      throw new Error("Assisted handoff belongs to another project.");
    return handoff;
  }
  beginOpen(projectId: string, id: string) {
    const handoff = this.get(projectId, id),
      current = this.store.get<AssistedState>("assisted-handoff-state", id);
    if (!current || current.state !== "prepared")
      throw new Error(
        "This native opening was already requested. Reconcile the external step; it is never automatically replayed.",
      );
    this.store.transaction(() => {
      this.store.immutable("assisted-open-intent", {
        id,
        projectId,
        workflowId: handoff.workflowId,
        handoffId: id,
        observedAt: now(),
      });
      this.store.put("assisted-handoff-state", {
        id,
        projectId,
        workflowId: handoff.workflowId,
        state: "externally-controlled",
        externalWritingStopped: false,
        updatedAt: now(),
      } satisfies AssistedState);
    });
  }
  openUncertain(projectId: string, id: string) {
    const handoff = this.get(projectId, id);
    this.store.immutable("assisted-open-observation", {
      id: uid(),
      projectId,
      workflowId: handoff.workflowId,
      handoffId: id,
      route: "unknown",
      observedAt: now(),
      detail:
        "Native open reply failed after durable intent. External control is uncertain; confirm native writing stopped before another managed writer.",
    });
  }
  opened(projectId: string, id: string, route: string) {
    const handoff = this.get(projectId, id);
    this.store.immutable("assisted-open-observation", {
      id: uid(),
      projectId,
      workflowId: handoff.workflowId,
      handoffId: id,
      route,
      observedAt: now(),
      detail:
        "Native surface opened; continuation, progress, stopping and model execution are externally controlled.",
    });
    this.store.put("assisted-handoff-state", {
      id,
      projectId,
      workflowId: handoff.workflowId,
      state: "externally-controlled",
      externalWritingStopped: false,
      updatedAt: now(),
    } satisfies AssistedState);
  }
  async import(input: {
    projectId: string;
    id: string;
    candidateRevision: string;
    specificationId: string;
    report: string;
    source: "user-supplied" | "native-import";
    externalWritingStopped: true;
  }) {
    const handoff = this.get(input.projectId, input.id),
      workflow = this.workflow(input.projectId, handoff.workflowId),
      candidate = this.candidate(handoff.candidateId);
    if (!input.externalWritingStopped)
      throw new Error(
        "Explicit confirmation that external writing stopped is required before importing and releasing the writer gate.",
      );
    let applicability: "current" | "stale" | "invalid" = "current",
      detail =
        "Report is attributed to the pinned assisted handoff; coordinated verification/acceptance is still required.";
    const head =
      new RevisionRepository(this.store).head(
        input.projectId,
        `workflow-specification:${workflow.id}`,
      )?.revisionId ?? workflow.specificationId;
    if (
      input.candidateRevision !== handoff.candidateRevision ||
      input.specificationId !== handoff.specificationId ||
      workflow.candidateId !== handoff.candidateId ||
      head !== handoff.specificationId
    ) {
      applicability = "stale";
      detail =
        "Candidate or specification changed during the externally controlled step.";
    }
    try {
      await assertCandidateCurrent(candidate);
    } catch {
      applicability = "stale";
      detail = "Source files changed during the externally controlled step.";
    }
    let validatedReview: unknown = null;
    if (handoff.role === "reviewer") {
      try {
        const review = reviewSchema.parse(JSON.parse(input.report));
        if (
          review.candidateRevision !== handoff.candidateRevision ||
          review.findings.some((f) => {
            try {
              return !candidateHasTextLine(
                candidate,
                f.file,
                f.line,
                this.store,
              );
            } catch {
              return true;
            }
          })
        )
          throw new Error(
            "Review candidate, finding path or line does not match the pinned input.",
          );
        validatedReview = review;
      } catch {
        if (applicability === "current") applicability = "invalid";
        detail =
          "Review format, candidate revision, finding path or line is invalid. The original report is retained; no clean review is inferred.";
      }
    }
    const result = {
      id: uid(),
      projectId: input.projectId,
      workflowId: handoff.workflowId,
      handoffId: handoff.id,
      candidateId: handoff.candidateId,
      candidateRevision: input.candidateRevision,
      specificationId: input.specificationId,
      source: input.source,
      report: input.report,
      reportHash: hash(input.report),
      validatedReview,
      applicability,
      detail,
      externalWritingStopped: true,
      observedAt: now(),
      acceptanceEligible: false,
    };
    this.store.transaction(() => {
      this.store.immutable("assisted-result", result);
      this.store.immutable("assisted-stop-confirmation", {
        id: uid(),
        projectId: input.projectId,
        workflowId: handoff.workflowId,
        handoffId: handoff.id,
        source: "user-confirmation",
        observedAt: now(),
      });
      this.store.put("assisted-handoff-state", {
        id: handoff.id,
        projectId: input.projectId,
        workflowId: handoff.workflowId,
        state: "imported",
        externalWritingStopped: true,
        updatedAt: now(),
      } satisfies AssistedState);
    });
    return result;
  }
}
