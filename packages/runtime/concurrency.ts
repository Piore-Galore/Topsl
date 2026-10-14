import { now, stable, hash } from "../domain/invariants";
import type { ExecutionAttempt, Workflow } from "../domain/workflow";
import type { Store } from "../persistence/store";

export interface FanoutPolicy {
  mode: "disabled" | "bounded" | "unknown-approved" | "native-controlled";
  maxChildren: number | null;
  enforced: boolean;
  evidence: string;
  approvalDigest: string | null;
}
interface Slot {
  id: string;
  projectId: string;
  workflowId: string | null;
  provider: "codex" | "claude";
  weight: number;
  policy: FanoutPolicy;
  state: "held" | "released";
  createdAt: string;
}
/** Slots never expire into reassignment. Release follows the same observed child-exit
 * or reconciled absence boundary as the workspace lease. Hidden native teams are
 * reported separately; a visible count is never described as an exact total. */
export class ConcurrencyBudget {
  constructor(
    private store: Store,
    readonly total = 2,
    readonly perProvider = 2,
  ) {}
  setPolicy(attemptId: string, policy: FanoutPolicy): void {
    if (
      (policy.mode === "disabled" &&
        (!policy.enforced || policy.maxChildren !== 0)) ||
      (policy.mode === "bounded" &&
        (!policy.enforced ||
          !Number.isInteger(policy.maxChildren) ||
          policy.maxChildren! < 0 ||
          policy.maxChildren! > 15)) ||
      (policy.mode === "unknown-approved" &&
        (!policy.approvalDigest || policy.maxChildren !== null)) ||
      policy.mode === "native-controlled"
    )
      throw new Error(
        "Native fan-out requires enforced disabled/bounded controls or explicit reduced-observability approval.",
      );
    this.store.immutable("attempt-fanout-policy", { id: attemptId, ...policy });
  }
  acquire(attempt: ExecutionAttempt): void {
    this.store.transaction(() => {
      const old = this.store.get<Slot>("concurrency-slot", attempt.id);
      if (old?.state === "held") return;
      const policy = this.store.get<FanoutPolicy>(
        "attempt-fanout-policy",
        attempt.id,
      ) ?? {
        mode: "native-controlled" as const,
        maxChildren: null,
        enforced: false,
        evidence:
          "Legacy/native route: visible processes observed; hidden native fan-out is unknown.",
        approvalDigest: null,
      };
      // Unknown legacy native fan-out consumes the complete visible budget. Managed
      // specialist routes require an explicit verified policy before they reach here.
      const weight =
        policy.maxChildren === null ? this.total : 1 + policy.maxChildren;
      const slots = [...this.store.iterate<Slot>("concurrency-slot")].filter(
        (s) => s.state === "held",
      );
      const task = this.store.get<{ workflowId: string | null }>(
        "task",
        attempt.taskId,
      );
      const workflow = task?.workflowId
        ? this.store.get<Workflow>("workflow", task.workflowId)
        : undefined;
      if (
        slots.reduce((n, s) => n + s.weight, 0) + weight > this.total ||
        slots
          .filter((s) => s.provider === attempt.provider)
          .reduce((n, s) => n + s.weight, 0) +
          weight >
          this.perProvider ||
        (workflow &&
          slots
            .filter((s) => s.workflowId === workflow.id)
            .reduce((n, s) => n + s.weight, 0) +
            weight >
            workflow.budget.concurrency)
      )
        throw new Error(
          "Coordinator/provider concurrency budget is full. Wait for confirmed process exit; no dispatch occurred.",
        );
      this.store.put("concurrency-slot", {
        id: attempt.id,
        projectId: attempt.projectId,
        workflowId: task?.workflowId ?? null,
        provider: attempt.provider,
        weight,
        policy,
        state: "held",
        createdAt: now(),
      } satisfies Slot);
    });
  }
  available(
    provider: "codex" | "claude",
    workflowId: string | null = null,
    maxChildren: number | null = null,
  ): { available: boolean; detail: string } {
    const weight = maxChildren === null ? this.total : 1 + maxChildren;
    const slots = [...this.store.iterate<Slot>("concurrency-slot")].filter(
      (s) => s.state === "held",
    );
    const workflow = workflowId
      ? this.store.get<Workflow>("workflow", workflowId)
      : undefined;
    const available =
      slots.reduce((n, s) => n + s.weight, 0) + weight <= this.total &&
      slots
        .filter((s) => s.provider === provider)
        .reduce((n, s) => n + s.weight, 0) +
        weight <=
        this.perProvider &&
      (!workflow ||
        slots
          .filter((s) => s.workflowId === workflow.id)
          .reduce((n, s) => n + s.weight, 0) +
          weight <=
          workflow.budget.concurrency);
    return {
      available,
      detail: available
        ? "Capacity available."
        : "Coordinator/provider capacity remains reserved until observed process exit or explicit reconciliation.",
    };
  }
  release(attemptId: string): void {
    const slot = this.store.get<Slot>("concurrency-slot", attemptId);
    if (slot)
      this.store.put("concurrency-slot", { ...slot, state: "released" });
  }
  recover(): void {
    for (const attempt of this.store.iterate<ExecutionAttempt>("attempt")) {
      if (
        attempt.state !== "uncertain" ||
        this.store.get<Slot>("concurrency-slot", attempt.id)
      )
        continue;
      const task = this.store.get<{ workflowId: string | null }>(
        "task",
        attempt.taskId,
      );
      this.store.put("concurrency-slot", {
        id: attempt.id,
        projectId: attempt.projectId,
        workflowId: task?.workflowId ?? null,
        provider: attempt.provider,
        weight: this.total,
        state: "held",
        createdAt: now(),
        policy: {
          mode: "native-controlled",
          maxChildren: null,
          enforced: false,
          approvalDigest: null,
          evidence:
            "Recovered legacy dispatch has unknown native descendants; capacity remains reserved pending explicit reconciliation.",
        },
      } satisfies Slot);
    }
  }
  snapshot() {
    const active = [...this.store.iterate<Slot>("concurrency-slot")].filter(
      (s) => s.state === "held",
    );
    return {
      totalLimit: this.total,
      perProviderLimit: this.perProvider,
      visibleAttempts: active.length,
      reservedCapacity: active.reduce((n, s) => n + s.weight, 0),
      hiddenConcurrency: active.some((s) => s.policy.maxChildren === null)
        ? "unknown"
        : "bounded",
      maximumIncludingNativeChildren: active.some(
        (s) => s.policy.maxChildren === null,
      )
        ? null
        : active.reduce((n, s) => n + s.weight, 0),
      active,
      revision: hash(stable(active)),
    };
  }
}
