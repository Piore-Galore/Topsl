import { hash, now, stable, uid } from "../domain/invariants";
import type {
  ContextPackage,
  Evidence,
  ExecutionAttempt,
  Task,
} from "../domain/workflow";
import type {
  ContextUpdateIntent,
  SharedHead,
  SharedRevision,
  TaskInputBinding,
} from "../domain/sync";
import { Store } from "../persistence/store";
import { SyncRepository } from "../sync/reconciler";
import type { WorkflowSpecification } from "./packages";

export class RevisionRepository {
  constructor(readonly store: Store) {}
  revisions(projectId: string): SharedRevision[] {
    return [
      ...this.store.iterate<SharedRevision>("shared-revision", { projectId }),
    ];
  }
  heads(projectId: string): SharedHead[] {
    return [...this.store.iterate<SharedHead>("shared-head", { projectId })];
  }
  publish(
    input: Omit<
      SharedRevision,
      "id" | "sequence" | "previousId" | "contentHash" | "createdAt"
    > & { expectedHeadId: string | null; id?: string },
  ): SharedRevision {
    if (
      !input.recordId ||
      !input.content.trim() ||
      input.content.length > 1_000_000 ||
      !input.title.trim()
    )
      throw new Error(
        "A shared revision requires a title and bounded nonempty content.",
      );
    return this.store.transaction(() => {
      const key = hash(stable([input.projectId, input.recordId])),
        old = this.store.get<SharedHead>("shared-head", key);
      if ((old?.revisionId ?? null) !== input.expectedHeadId)
        throw new Error(
          "Shared record changed; review its current revision before publishing.",
        );
      const revision: SharedRevision = {
        id: input.id ?? uid(),
        projectId: input.projectId,
        recordId: input.recordId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        contentHash: hash(input.content),
        impact: input.impact,
        sequence: (old?.sequence ?? 0) + 1,
        previousId: old?.revisionId ?? null,
        createdAt: now(),
      };
      this.store.immutable("shared-revision", revision);
      this.store.save("shared-head", {
        id: key,
        projectId: input.projectId,
        revisionId: revision.id,
        sequence: revision.sequence,
      } satisfies SharedHead);
      return revision;
    });
  }
  trackSpecification(specification: WorkflowSpecification): SharedRevision {
    const existing = this.store.get<SharedRevision>(
      "shared-revision",
      specification.id,
    );
    if (existing) return existing;
    const recordId = `workflow-specification:${specification.workflowId}`,
      head = this.head(specification.projectId, recordId);
    return this.publish({
      id: specification.id,
      projectId: specification.projectId,
      recordId,
      kind: "specification",
      title: specification.objective,
      content: stable({
        objective: specification.objective,
        acceptanceCriteria: specification.acceptanceCriteria,
        interfaces: specification.interfaces,
        revision: specification.revision,
      }),
      impact: "dispatch-blocking",
      expectedHeadId: head?.revisionId ?? null,
    });
  }
  head(projectId: string, recordId: string): SharedHead | undefined {
    return this.store.get<SharedHead>(
      "shared-head",
      hash(stable([projectId, recordId])),
    );
  }
  private context(
    taskId: string,
    packageId: string,
  ): { task: Task; context: ContextPackage } {
    const task = this.store.get<Task>("task", taskId),
      context = this.store.get<ContextPackage>("context-package", packageId);
    if (
      !task ||
      !context ||
      task.projectId !== context.projectId ||
      hash(context.text) !== context.hash
    )
      throw new Error(
        "Task context package is missing, changed, or belongs to another project.",
      );
    return { task, context };
  }
  bindPackage(
    taskId: string,
    contextPackageId: string,
    attemptId: string | null = null,
    references?: TaskInputBinding["references"],
  ): TaskInputBinding {
    return this.store.transaction(() => {
      const { task, context } = this.context(taskId, contextPackageId);
      if (attemptId) {
        const attempt = this.store.get<ExecutionAttempt>("attempt", attemptId);
        if (
          !attempt ||
          attempt.taskId !== taskId ||
          attempt.contextPackageId !== contextPackageId
        )
          throw new Error("Attempt inputs do not match this task package.");
      }
      const derived = context.sourceRefs.flatMap((id) => {
        const revision = this.store.get<SharedRevision>("shared-revision", id);
        return revision
          ? [{ recordId: revision.recordId, revisionId: revision.id }]
          : [];
      });
      const refs = references ?? derived;
      if (new Set(refs.map((ref) => ref.recordId)).size !== refs.length)
        throw new Error(
          "Task inputs contain two revisions of one shared record.",
        );
      for (const ref of refs) {
        const revision = this.store.get<SharedRevision>(
          "shared-revision",
          ref.revisionId,
        );
        if (
          !revision ||
          revision.projectId !== task.projectId ||
          revision.recordId !== ref.recordId ||
          !context.sourceRefs.includes(revision.id)
        )
          throw new Error(
            "Task revision references must be included in the immutable context package.",
          );
      }
      const binding: TaskInputBinding = {
        id: uid(),
        projectId: task.projectId,
        taskId,
        attemptId,
        contextPackageId,
        contextPackageHash: context.hash,
        references: refs,
        createdAt: now(),
      };
      this.store.immutable("task-input-binding", binding);
      this.store.save("task-input-head", {
        id: taskId,
        projectId: task.projectId,
        bindingId: binding.id,
      });
      new SyncRepository(this.store).observe({
        projectId: task.projectId,
        dimension: "context",
        targetId: `task-input:${taskId}`,
        state: "current",
        expectedRevision: context.hash,
        observedRevision: context.hash,
        evidence: {
          level: "topsl-transaction",
          source: binding.id,
          observedAt: binding.createdAt,
          detail:
            "Immutable task input binding persisted; provider delivery and native instruction loading remain separate.",
        },
        detail:
          "Task inputs are recorded at the package revision shown. Inspect shared-head comparisons for later changes.",
        suggestedAction: null,
      });
      return binding;
    });
  }
  inspectTaskInputs(
    taskId: string,
    contextPackageId?: string,
  ): {
    binding: TaskInputBinding | null;
    stale: Array<{
      recordId: string;
      usedRevisionId: string;
      availableRevisionId: string | null;
      blocking: boolean;
    }>;
    current: boolean;
  } {
    const head = this.store.get<{ bindingId: string }>(
      "task-input-head",
      taskId,
    );
    let binding = head
      ? (this.store.get<TaskInputBinding>(
          "task-input-binding",
          head.bindingId,
        ) ?? null)
      : null;
    if (contextPackageId && binding?.contextPackageId !== contextPackageId) {
      const { task, context } = this.context(taskId, contextPackageId);
      binding = {
        id: "inspection",
        projectId: task.projectId,
        taskId,
        attemptId: null,
        contextPackageId,
        contextPackageHash: context.hash,
        createdAt: context.createdAt,
        references: context.sourceRefs.flatMap((id) => {
          const revision = this.store.get<SharedRevision>(
            "shared-revision",
            id,
          );
          return revision
            ? [{ recordId: revision.recordId, revisionId: revision.id }]
            : [];
        }),
      };
    }
    const task = this.store.get<Task>("task", taskId);
    const references =
      binding?.references ??
      (task?.inputRefs ?? []).flatMap((id) => {
        const revision = this.store.get<SharedRevision>("shared-revision", id);
        return revision
          ? [{ recordId: revision.recordId, revisionId: revision.id }]
          : [];
      });
    const projectId = binding?.projectId ?? task?.projectId;
    const stale = references.flatMap((ref) => {
      const latest = projectId ? this.head(projectId, ref.recordId) : undefined,
        used = this.store.get<SharedRevision>(
          "shared-revision",
          ref.revisionId,
        );
      if (latest?.revisionId === ref.revisionId) return [];
      const available =
        latest &&
        this.store.get<SharedRevision>("shared-revision", latest.revisionId);
      return [
        {
          recordId: ref.recordId,
          usedRevisionId: ref.revisionId,
          availableRevisionId: latest?.revisionId ?? null,
          blocking:
            !available ||
            used?.impact === "dispatch-blocking" ||
            available.impact === "dispatch-blocking",
        },
      ];
    });
    return { binding, stale, current: !stale.length };
  }
  assertTaskInputsCurrent(taskId: string, contextPackageId?: string): void {
    const status = this.inspectTaskInputs(taskId, contextPackageId);
    if (status.stale.some((ref) => ref.blocking))
      throw new Error(
        "Task inputs are stale. Explicitly update its context or restart against the new shared revision before dispatch.",
      );
  }
  requestUpdate(input: {
    taskId: string;
    attemptId: string;
    replacementPackageId: string;
    action: ContextUpdateIntent["action"];
  }): ContextUpdateIntent {
    return this.store.transaction(() => {
      const old = [
          ...this.store.iterate<TaskInputBinding>("task-input-binding"),
        ]
          .filter((binding) => binding.attemptId === input.attemptId)
          .at(-1),
        attempt = this.store.get<ExecutionAttempt>("attempt", input.attemptId);
      if (
        !old ||
        !attempt ||
        attempt.taskId !== input.taskId ||
        old.taskId !== input.taskId
      )
        throw new Error(
          "The attempt has no recorded input binding for this task.",
        );
      if (
        input.action !== "finish-old" &&
        ["completed", "failed", "interrupted"].includes(attempt.state)
      )
        throw new Error(
          "This attempt ended; create an explicit new attempt with current inputs.",
        );
      const { context } = this.context(
        input.taskId,
        input.replacementPackageId,
      );
      this.assertTaskInputsCurrent(input.taskId, input.replacementPackageId);
      const intent: ContextUpdateIntent = {
        id: uid(),
        projectId: old.projectId,
        taskId: input.taskId,
        attemptId: input.attemptId,
        oldBindingId: old.id,
        replacementPackageId: context.id,
        replacementPackageHash: context.hash,
        action: input.action,
        state:
          input.action === "restart"
            ? "restart-required"
            : input.action === "finish-old"
              ? "historical-completion"
              : "requested",
        evidence: {
          level: "topsl-transaction",
          source: "explicit-context-update",
          observedAt: now(),
          detail:
            "Update intent recorded. Original input package and attempt specification remain immutable; no runtime delivery is inferred.",
        },
        createdAt: now(),
      };
      this.store.immutable("context-update-intent", intent);
      return intent;
    });
  }
  recordCheckpointDelivery(intentId: string, evidence: Evidence): void {
    const intent = this.store.get<ContextUpdateIntent>(
      "context-update-intent",
      intentId,
    );
    if (
      !intent ||
      intent.action !== "checkpoint" ||
      !["provider-ack", "provider-readback"].includes(evidence.level)
    )
      throw new Error(
        "A supported checkpoint needs provider evidence; disk updates cannot count as delivery.",
      );
    this.store.immutable("context-update-delivery", {
      id: intentId,
      projectId: intent.projectId,
      intentId,
      packageId: intent.replacementPackageId,
      evidence,
      createdAt: now(),
    });
    // A receipt records a later delivery, never rewrites the attempt's initial input binding.
  }
}
