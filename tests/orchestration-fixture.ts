import { rm } from "node:fs/promises";
import { now } from "../packages/domain/invariants";
import type { Store } from "../packages/persistence/store";
import {
  Orchestrator,
  type AttemptObservation,
  type GoalCheckEvidence,
  type GoalCheckPlan,
  type MemberTurn,
  type OrchestrationDriver,
} from "../packages/orchestration/engine";
import type { RouteCandidate } from "../packages/orchestration/selection";
import type {
  ExecutionPurpose,
  GoalCheckDefinition,
} from "../packages/domain/role-groups";
import { fixture } from "./helpers";

/**
 * A scripted stand-in for native execution. The labels Opus, Astra, Fable
 * and Sol are fixture catalog entries only: no result here is evidence for
 * those models, their providers or any live route.
 */
export type Reply =
  | {
      text: string;
      reportedModel?: string | null;
      state?: AttemptObservation["state"];
      candidateId?: string | null;
    }
  | "hang";

export const allPurposes: ExecutionPurpose[] = [
  "coordinator-contribution",
  "coordinator-endorsement",
  "information",
  "implementation",
  "candidate-review",
];

export function route(
  provider: "codex" | "claude",
  installationId: string,
  models: Array<[model: string, name: string]>,
  options: Partial<
    Pick<RouteCandidate, "fanout" | "route" | "nativeAccountKey">
  > & { blocked?: ExecutionPurpose[]; stale?: boolean } = {},
): RouteCandidate {
  return {
    provider,
    installationId,
    installationRevision: `${installationId}-rev`,
    executableIdentity: `${installationId}-exe`,
    route: options.route ?? "managed-structured",
    nativeAccountKey: options.nativeAccountKey ?? `${provider}-account`,
    nativeProfileId: `${provider}-profile`,
    billingRoute: "native-subscription",
    accountLabel: null,
    catalog: {
      models: models.map(([model, name]) => ({
        id: model,
        model,
        name,
        description: "fixture",
        isDefault: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
      })),
      observedAt: now(),
      fresh: !options.stale,
    },
    purposes: Object.fromEntries(
      allPurposes.map((p) => [
        p,
        options.blocked?.includes(p)
          ? { ready: false, blockers: [`${p} is not qualified (fixture).`] }
          : { ready: true, blockers: [] },
      ]),
    ),
    fanout: options.fanout ?? "disabled",
  };
}

export const defaultRoutes = () => [
  route("claude", "claude-fixture", [
    ["claude-opus-fixture", "Opus"],
    ["claude-fable-fixture", "Fable"],
  ]),
  route("codex", "codex-fixture", [
    ["astra-fixture", "Astra"],
    ["sol-fixture", "Sol"],
    ["vega-fixture", "Vega"],
    ["lyra-fixture", "Lyra"],
  ]),
];

const digestIn = (prompt: string, label: RegExp) =>
  label.exec(prompt)?.[1] ?? "";

/** Default scripted behavior: agreeable coordinators, clean reviewers, working implementers. */
export function defaultReply(turn: MemberTurn, plan?: unknown[]): Reply {
  if (!plan) {
    // Partitioned groups need one partition per member; read the roster the
    // coordinator was shown.
    const roster =
      /- implementer: implementation, (\d+) member\(s\), (\S+)/.exec(
        turn.prompt,
      );
    const members = roster ? Number(roster[1]) : 1;
    plan = defaultPlan(
      "implementation",
      roster?.[2] === "parallel-partitioned" && members > 1 ? members : 0,
    );
  }
  switch (turn.purpose) {
    case "coordinator-contribution":
      return {
        text: JSON.stringify({
          snapshotDigest: digestIn(
            turn.prompt,
            /Snapshot digest \(echo it exactly\): (\S+)/,
          ),
          summary: `Plan from ${turn.memberId}`,
          assumptions: [],
          actions: plan,
          concerns: [],
        }),
      };
    case "coordinator-endorsement":
      return {
        text: JSON.stringify({
          candidateDigest: digestIn(
            turn.prompt,
            /Candidate digest \(echo it exactly\): (\S+)/,
          ),
          stance: "endorse",
          rationale: "Agreed.",
        }),
      };
    case "candidate-review":
      return {
        text: JSON.stringify({
          candidateRevision: digestIn(
            turn.prompt,
            /Candidate revision \(echo it exactly\): (\S+)/,
          ),
          summary: "No findings.",
          findings: [],
        }),
      };
    case "information":
      return {
        text: JSON.stringify({
          inputDigest: digestIn(turn.prompt, /"inputDigest": "([^"]+)"/),
          summary: `Report from ${turn.memberId}`,
          report: "Findings with sources.",
          limitations: [],
        }),
      };
    case "implementation":
      return {
        text: JSON.stringify({
          inputDigest: turn.inputDigest,
          summary: `Changed ${turn.permittedOutputs.join(", ")}`,
        }),
        candidateId: `candidate-${turn.memberId}-${turn.launchId.slice(0, 6)}`,
      };
    default:
      return { text: "" };
  }
}

export function defaultPlan(
  kind: "implementation" | "information" = "implementation",
  partitions = 0,
) {
  return [
    {
      key: "build",
      title:
        kind === "implementation"
          ? "Build the change"
          : "Research the question",
      kind,
      roleId: kind === "implementation" ? "implementer" : "researcher",
      dependencies: [],
      permittedOutputs: kind === "implementation" ? ["src/a.ts"] : [],
      acceptanceCriteria: ["It works."],
      brief: "Do the bounded task.",
      partitions: Array.from({ length: partitions }, (_, i) => ({
        title: `Part ${i + 1}`,
        permittedOutputs: [`src/part-${i + 1}.ts`],
      })),
    },
  ];
}

export class ScriptedDriver implements OrchestrationDriver {
  routesList: RouteCandidate[] = defaultRoutes();
  total = 2;
  perProvider = 2;
  attempts = new Map<
    string,
    { turn: MemberTurn; obs: AttemptObservation; weight: number }
  >();
  launches: MemberTurn[] = [];
  launchRecords = new Map<string, string>();
  interrupted: string[] = [];
  maxRunning = 0;
  /** Running count at each launch, to show overlap. */
  overlap: number[] = [];
  failLaunch: (turn: MemberTurn) => boolean = () => false;
  /** When set, a launch records its attempt and then "crashes" before returning. */
  crashAfterRecord = false;
  reply: (turn: MemberTurn) => Reply = (turn) => defaultReply(turn);
  integrations: Array<{
    base: string;
    candidates: string[];
    resolutions: Array<{ path: string; candidateId: string }>;
  }> = [];
  integrateResult:
    | ((
        candidates: string[],
        resolutions: Array<{ path: string; candidateId: string }>,
      ) =>
        | { candidateId: string }
        | { conflicts: Array<{ path: string; candidateIds: string[] }> })
    | null = null;
  /** Check protocols bound per goal, as the check machinery would freeze them. */
  boundChecks: Array<{ goalId: string; baseline: string; ids: string[] }> = [];
  checkTasks: string[] = [];
  checkPlans = new Map<string, GoalCheckPlan>();
  evidence: Array<GoalCheckEvidence & { taskId: string; candidateId: string }> =
    [];
  /** The scripted result of running a check on a candidate. */
  checkResult: (definitionId: string, candidateId: string) => string = () =>
    "passed";
  cancelledChecks: string[] = [];
  /** A refusal the scripted folder returns (dirty or changed), or null. */
  applyProblem: string | null = null;
  applied: Array<{ goalId: string; candidateId: string }> = [];
  private counter = 0;
  routes() {
    return this.routesList;
  }
  capacity() {
    return {
      total: this.total,
      perProvider: this.perProvider,
      held: [...this.attempts.values()]
        .filter(
          (a) =>
            a.obs.state === "running" ||
            a.obs.state === "uncertain" ||
            !a.obs.quiescent,
        )
        .map((a) => ({
          provider: a.turn.assignment.provider!,
          weight: a.weight,
        })),
    };
  }
  async launch(turn: MemberTurn) {
    if (this.failLaunch(turn))
      throw new Error("fixture launch refused before process creation");
    const attemptId = `attempt-${++this.counter}`;
    const weight = turn.assignment.fanout === "unknown" ? this.total : 1;
    const held = this.capacity().held.reduce((n, h) => n + h.weight, 0);
    if (held + weight > this.total)
      throw new Error("fixture capacity full; no dispatch occurred");
    this.attempts.set(attemptId, {
      turn,
      weight,
      obs: {
        state: "running",
        quiescent: false,
        finalText: null,
        reportedModel: null,
        reportedEffort: null,
        evidence: {
          level: "none",
          source: "fixture",
          observedAt: null,
          detail: "fixture",
        },
      },
    });
    this.launches.push(turn);
    this.launchRecords.set(turn.launchId, attemptId);
    const running = [...this.attempts.values()].filter(
      (a) => a.obs.state === "running",
    ).length;
    this.overlap.push(running);
    this.maxRunning = Math.max(this.maxRunning, running);
    if (this.crashAfterRecord) {
      // The process dies here: the launch was recorded, the engine never hears back.
      this.crashAfterRecord = false;
      return new Promise<{ attemptId: string }>(() => {});
    }
    return { attemptId };
  }
  findLaunch(launchId: string) {
    return this.launchRecords.get(launchId) ?? null;
  }
  observe(attemptId: string): AttemptObservation {
    return this.attempts.get(attemptId)!.obs;
  }
  async interrupt(attemptId: string) {
    this.interrupted.push(attemptId);
    const a = this.attempts.get(attemptId);
    if (a && a.obs.state === "running")
      a.obs = {
        ...a.obs,
        state: "interrupted",
        quiescent: true,
        error: "interrupted",
      };
  }
  /** Completes every running attempt with its scripted reply. */
  settle() {
    for (const [id, a] of this.attempts) {
      if (a.obs.state !== "running") continue;
      const reply = this.reply(a.turn);
      if (reply === "hang") continue;
      a.obs = {
        ...a.obs,
        state: reply.state ?? "completed",
        quiescent: true,
        finalText: reply.text,
        reportedModel:
          reply.reportedModel === undefined
            ? (a.turn.assignment.model ?? null)
            : reply.reportedModel,
        reportedEffort: null,
        candidateId: reply.candidateId ?? null,
        error:
          reply.state && reply.state !== "completed" ? "fixture failure" : null,
      };
      void id;
    }
  }
  async baseline() {
    return "baseline-candidate";
  }
  async integrate(input: {
    baseCandidateId: string;
    candidateIds: string[];
    resolutions?: Array<{ path: string; candidateId: string }>;
  }) {
    this.integrations.push({
      base: input.baseCandidateId,
      candidates: input.candidateIds,
      resolutions: input.resolutions ?? [],
    });
    return (
      this.integrateResult?.(input.candidateIds, input.resolutions ?? []) ?? {
        candidateId: `integrated-${this.integrations.length}`,
      }
    );
  }
  bindChecks(input: {
    goalId: string;
    baselineCandidateId: string;
    checks: GoalCheckDefinition[];
  }) {
    this.boundChecks.push({
      goalId: input.goalId,
      baseline: input.baselineCandidateId,
      ids: input.checks.map((c) => c.id),
    });
  }
  checkTask() {
    const id = `check-task-${this.checkTasks.length + 1}`;
    this.checkTasks.push(id);
    return id;
  }
  async previewChecks(input: {
    goalId: string;
    taskId: string;
    candidateId: string;
    checks: GoalCheckDefinition[];
  }) {
    return input.checks.map((definition) => {
      const plan: GoalCheckPlan = {
        id: `plan-${this.checkPlans.size + 1}`,
        workflowId: input.goalId,
        taskId: input.taskId,
        candidateId: input.candidateId,
        targetRevision: `rev-${input.candidateId}`,
        definition,
        digest: `digest-${this.checkPlans.size + 1}`,
      };
      this.checkPlans.set(plan.id, plan);
      return plan;
    });
  }
  checkPlan(planId: string) {
    return this.checkPlans.get(planId) ?? null;
  }
  async runCheck(planId: string, digest: string) {
    const plan = this.checkPlans.get(planId)!;
    if (digest !== plan.digest) throw new Error("Check approval is stale.");
    this.evidence.push({
      definitionId: plan.definition.id,
      verificationId: `verification-${this.evidence.length + 1}`,
      result: this.checkResult(plan.definition.id, plan.candidateId),
      targetRevision: plan.targetRevision,
      evidenceArtifactId: `evidence-${this.evidence.length + 1}`,
      taskId: plan.taskId,
      candidateId: plan.candidateId,
    });
  }
  checkEvidence(input: { taskId: string; candidateId: string }) {
    return this.evidence.filter(
      (e) => e.taskId === input.taskId && e.candidateId === input.candidateId,
    );
  }
  cancelChecks(goalId: string) {
    this.cancelledChecks.push(goalId);
  }
  async applyPreview(input: { candidateId: string }) {
    return {
      root: "/fixture/project",
      baseRevision: "fixture-head",
      files: [{ path: "src/a.ts", change: "modified" as const }],
      problems: this.applyProblem ? [this.applyProblem] : [],
    };
  }
  async apply(input: { goalId: string; candidateId: string }) {
    if (this.applyProblem) return { refused: this.applyProblem };
    this.applied.push({ goalId: input.goalId, candidateId: input.candidateId });
    return { applied: [{ path: "src/a.ts", change: "modified" as const }] };
  }
  candidateRevision(candidateId: string) {
    return `rev-${candidateId}`;
  }
}

export async function orchestration() {
  const f = await fixture();
  f.store.put("project", {
    id: "p",
    name: "Fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  });
  const driver = new ScriptedDriver();
  const orchestrator = new Orchestrator(f.store, driver);
  return {
    ...f,
    driver,
    orchestrator,
    reopen(store: Store = f.store) {
      return new Orchestrator(store, driver);
    },
    async close() {
      try {
        f.store.close();
      } catch {}
      await rm(f.directory, { recursive: true, force: true });
    },
  };
}

/** Ticks and settles until the goal stops changing or reaches a resting state. */
export async function drive(
  o: Orchestrator,
  driver: ScriptedDriver,
  goalId: string,
  options: {
    until?: (state: string) => boolean;
    maxSteps?: number;
    settle?: boolean;
  } = {},
) {
  const until =
    options.until ??
    ((s) =>
      [
        "awaiting-acceptance",
        "completed",
        "blocked",
        "accepted",
        "stopped",
      ].includes(s));
  for (let i = 0; i < (options.maxSteps ?? 80); i++) {
    await o.tick();
    const goal = o.repo.require<{ state: string }>("goal", goalId);
    if (until(goal.state) && i > 0) return goal.state;
    if (options.settle !== false) driver.settle();
  }
  return o.repo.require<{ state: string }>("goal", goalId).state;
}
