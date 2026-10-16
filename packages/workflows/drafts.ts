import type { Store } from "../persistence/store";
import { hash, now, stable } from "../domain/invariants";
import {
  workflowDraftInput,
  type WorkflowDraft,
  type WorkflowDraftInput,
} from "../domain/workflow-drafts";
/** Editable plans are protected project data, separate from immutable execution inputs. */
export class WorkflowDrafts {
  constructor(private store: Store) {}
  private id(projectId: string, workflowId: string | null) {
    if (!this.store.get("project", projectId))
      throw new Error("The selected project no longer exists.");
    if (
      workflowId &&
      this.store.get<{ projectId: string }>("workflow", workflowId)
        ?.projectId !== projectId
    )
      throw new Error(
        "Draft workflow belongs to another project or no longer exists.",
      );
    return `workflow-draft:${hash(stable({ projectId, workflowId }))}`;
  }
  query(projectId: string, workflowId: string | null): WorkflowDraft | null {
    const saved = this.store.get<WorkflowDraft>(
      "workflow-draft",
      this.id(projectId, workflowId),
    );
    if (!saved || saved.draft.reviewer) return saved ?? null;
    // Drafts saved before the reviewer choice always paired Codex with Claude.
    return {
      ...saved,
      draft: {
        ...saved.draft,
        reviewer: saved.draft.builder === "codex" ? "claude" : "codex",
      },
    };
  }
  save(
    projectId: string,
    workflowId: string | null,
    expectedRevision: number,
    draft: WorkflowDraftInput,
  ) {
    return this.store.transaction(() => {
      const id = this.id(projectId, workflowId),
        current = this.query(projectId, workflowId);
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new Error(
          "Draft changed in another view. Reload the saved draft before overwriting it.",
        );
      const next: WorkflowDraft = {
        id,
        projectId,
        workflowId,
        revision: expectedRevision + 1,
        draft: workflowDraftInput.parse(draft),
        updatedAt: now(),
      };
      this.store.put("workflow-draft", next);
      return next;
    });
  }
  delete(
    projectId: string,
    workflowId: string | null,
    expectedRevision: number,
  ) {
    const current = this.query(projectId, workflowId);
    if (!current || current.revision !== expectedRevision)
      throw new Error("Draft revision changed. Reload before deleting it.");
    this.store.remove("workflow-draft", current.id);
  }
}
