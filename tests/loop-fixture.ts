import type { GoalCheckDefinition } from "../packages/domain/role-groups";
import type {
  GoalCheckEvidence,
  MemberTurn,
} from "../packages/orchestration/engine";
import { LoopSupervisor } from "../packages/orchestration/loop-engine";
import type {
  LoopDriver,
  PublicationPlan,
} from "../packages/orchestration/loop-checkpoints";
import type { LoopDecision } from "../packages/orchestration/loop-contracts";
import {
  defaultReply,
  orchestration,
  type Reply,
} from "./orchestration-fixture";

/**
 * A scripted stand-in for the loop's checkpoint and publication boundary.
 * Candidate IDs are fixture strings; no file is materialized and nothing here
 * is evidence for a real folder, check or provider.
 */
export class ScriptedLoopDriver implements LoopDriver {
  digests = new Map<string, string>([["checkpoint-c0", "content-0"]]);
  baselines: Array<{ goalId: string; from: string; id: string }> = [];
  /** Paths each candidate holds, for inspection evidence. */
  paths = new Map<string, Set<string>>();
  protocolIssues: string[] = [];
  reclaimed: string[] = [];
  verified: string[] = [];
  checkResult: (definitionId: string, candidateId: string) => string = () =>
    "passed";
  folder = { revision: "head-1" as string | null, problems: [] as string[] };
  published: Array<{ from: string; to: string }> = [];
  limits: ReturnType<NonNullable<LoopDriver["providerLimits"]>> = [];
  fingerprint = "folder-1";
  async captureBase() {
    return {
      publicationBaseCandidateId: "base-c",
      checkpointCandidateId: "checkpoint-c0",
      contentDigest: "content-0",
      setupConditions: ["Capture policy: fixture."],
    };
  }
  async childBaseline(input: { goalId: string; candidateId: string }) {
    const id = `baseline:${input.goalId}`;
    if (!this.baselines.some((b) => b.id === id))
      this.baselines.push({
        goalId: input.goalId,
        from: input.candidateId,
        id,
      });
    this.digests.set(id, this.contentDigest(input.candidateId) ?? "unknown");
    return id;
  }
  contentDigest(candidateId: string) {
    return this.digests.get(candidateId) ?? `content:${candidateId}`;
  }
  candidateHasPath(candidateId: string, path: string) {
    return this.paths.get(candidateId)?.has(path) ?? path === "src/a.ts";
  }
  changedPaths() {
    return [{ path: "src/a.ts", change: "modified" as const }];
  }
  bindRunProtocol() {}
  protocolProblems() {
    return this.protocolIssues;
  }
  protocolRevision() {
    return "protocol-1";
  }
  async verifyCheckpoint(input: {
    candidateId: string;
    checks: GoalCheckDefinition[];
    authorize: (plan: {
      id: string;
      digest: string;
      definitionId: string;
    }) => void;
  }): Promise<GoalCheckEvidence[]> {
    this.verified.push(input.candidateId);
    return input.checks.map((c, i) => {
      input.authorize({
        id: `verify-${input.candidateId}-${c.id}`,
        digest: `d-${i}`,
        definitionId: c.id,
      });
      return {
        definitionId: c.id,
        verificationId: `verification-${input.candidateId}-${c.id}`,
        result: this.checkResult(c.id, input.candidateId),
        targetRevision: `rev-${input.candidateId}`,
        evidenceArtifactId: `evidence-${c.id}`,
      };
    });
  }
  async publicationPreview(input: {
    baseCandidateId: string;
    headCandidateId: string;
    cursor: { lastPublishedCandidateId: string } | null;
  }): Promise<PublicationPlan> {
    return {
      root: "/fixture/project",
      baseRevision: "head-1",
      fromCandidateId:
        input.cursor?.lastPublishedCandidateId ?? input.baseCandidateId,
      toCandidateId: input.headCandidateId,
      files: [{ path: "src/a.ts", change: "modified" }],
      problems: [...this.folder.problems],
      basis: input.cursor ? "incremental" : "first",
    };
  }
  async publicationApply(input: { plan: PublicationPlan }) {
    if (input.plan.problems.length)
      return { refused: input.plan.problems.join(" ") };
    this.published.push({
      from: input.plan.fromCandidateId,
      to: input.plan.toCandidateId,
    });
    return {
      written: input.plan.files,
      manifest: [
        { path: "src/a.ts", hash: `hash-${input.plan.toCandidateId}` },
      ],
      targetRevision: this.folder.revision,
    };
  }
  async folderRevision() {
    return this.folder.revision;
  }
  async reclaim(ids: string[]) {
    this.reclaimed.push(...ids);
    return ids.length;
  }
  async projectFingerprint() {
    return this.fingerprint;
  }
  usage(_projectId: string, attemptIds: string[]) {
    return {
      input: null,
      output: null,
      coveredAttempts: 0,
      totalAttempts: attemptIds.length,
      complete: attemptIds.length === 0,
      notes: [],
    };
  }
  providerLimits() {
    return this.limits;
  }
}

export interface ParsedLoopPrompt {
  stage: "boundary" | "organize" | "evaluate";
  mode: "goal" | "endless";
  inputDigest: string;
  expected: unknown;
  idempotencyKey: string;
  goals: Array<{
    id: string;
    version: number;
    status: string;
    criteria: string[];
    text: string;
  }>;
  evidence: Array<{ id: string; kind: string }>;
  target: string | null;
  organization: Array<{ roleId: string; active: boolean; members: string[] }>;
}

export function parseLoopPrompt(prompt: string): ParsedLoopPrompt {
  const skeleton =
    /"inputDigest": "([^"]+)", "expected": (\{.*?\}), "idempotencyKey": "([^"]+)"/.exec(
      prompt,
    )!;
  const goals: ParsedLoopPrompt["goals"] = [];
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const g =
      /^- (\S+) v(\d+) \[(?:required|optional), priority -?\d+, ([a-z_]+)[^\]]*\]: (.*)$/.exec(
        lines[i],
      );
    if (!g) continue;
    const criteria: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith("  - "); j++) {
      const c = /^ {2}- criterion (\S+) \(/.exec(lines[j]);
      if (c) criteria.push(c[1]);
    }
    goals.push({
      id: g[1],
      version: Number(g[2]),
      status: g[3],
      criteria,
      text: g[4],
    });
  }
  const evidence: ParsedLoopPrompt["evidence"] = [];
  const section =
    prompt.split("Evidence you may cite (by ID):\n")[1]?.split("\n\n")[0] ?? "";
  for (const line of section.split("\n")) {
    const e = /^(\S+) \(([^)]+)\):/.exec(line);
    if (e) evidence.push({ id: e[1], kind: e[2] });
  }
  const organization: ParsedLoopPrompt["organization"] = [];
  const org = prompt.split("Organization:\n")[1]?.split("\n\n")[0] ?? "";
  for (const line of org.split("\n")) {
    const r = /^- (\S+) \(.*?; (active|inactive);.*?\): (.*)$/.exec(line);
    if (r)
      organization.push({
        roleId: r[1],
        active: r[2] === "active",
        members: r[3]
          .split(", ")
          .filter((m) => m && m !== "no members resolved"),
      });
  }
  return {
    stage: /Stage: (\w+)\./.exec(prompt)![1] as ParsedLoopPrompt["stage"],
    mode:
      /in an? (Goal|Endless) loop run/.exec(prompt)![1] === "Goal"
        ? "goal"
        : "endless",
    inputDigest: skeleton[1],
    expected: JSON.parse(skeleton[2]),
    idempotencyKey: skeleton[3],
    goals,
    evidence,
    target: /Target candidate (\S+)\./.exec(prompt)?.[1] ?? null,
    organization,
  };
}

export function envelope(
  p: ParsedLoopPrompt,
  decisions: LoopDecision[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    protocolKind: "recursive-loop-v1",
    stage: p.stage,
    inputDigest: p.inputDigest,
    expected: p.expected,
    idempotencyKey: p.idempotencyKey,
    decisions,
  });
}

/** Assess every listed goal; `met(goalId, p)` decides each goal's criteria. */
export function assess(
  p: ParsedLoopPrompt,
  met: (goalId: string, p: ParsedLoopPrompt) => boolean,
  options: {
    evidence?: (p: ParsedLoopPrompt) => string[];
    paths?: string[];
  } = {},
): LoopDecision {
  return {
    kind: "assess_goals",
    assessments: p.goals.map((g) => {
      const ok = met(g.id, p);
      return {
        goalId: g.id,
        goalVersion: g.version,
        result: ok && g.criteria.length ? "satisfied" : "unmet",
        criteria: g.criteria.map((c) => ({
          criterionId: c,
          result: ok ? "met" : "unmet",
          evidenceIds: options.evidence?.(p) ?? p.evidence.map((e) => e.id),
          citedPaths: ok ? (options.paths ?? ["src/a.ts"]) : [],
          note: ok ? "Observed in the target." : "Not yet.",
        })),
        proposedCriteria: g.criteria.length
          ? []
          : [
              {
                text: `${g.text} is observably done`,
                verification: "inspection" as const,
                checkId: null,
              },
            ],
        blocker: null,
        conflictsWith: [],
      };
    }),
  } as LoopDecision;
}

export interface LoopScript {
  /** Whether a goal's criteria are met in a prompt's target. */
  met: (goalId: string, p: ParsedLoopPrompt) => boolean;
  /** Endless: opportunities to propose at a boundary. */
  opportunities: (p: ParsedLoopPrompt, turn: MemberTurn) => LoopDecision[];
  /** Organize-stage decisions. */
  organize: (p: ParsedLoopPrompt, turn: MemberTurn) => LoopDecision[];
  /** Any stage: replace the whole reply. */
  override?: (p: ParsedLoopPrompt, turn: MemberTurn) => Reply | null;
}

export function loopReply(turn: MemberTurn, script: LoopScript): Reply {
  const p = parseLoopPrompt(turn.prompt);
  const custom = script.override?.(p, turn);
  if (custom) return custom;
  if (p.stage === "organize")
    return { text: envelope(p, script.organize(p, turn)) };
  if (p.stage === "boundary" && p.mode === "endless") {
    const proposals = script.opportunities(p, turn);
    return {
      text: envelope(
        p,
        proposals.length
          ? proposals
          : [
              {
                kind: "request_wait",
                condition: "no-opportunity",
                reason: "Nothing worthwhile now.",
                question: null,
                goalIds: [],
                retryAfterSeconds: null,
              } as LoopDecision,
            ],
      ),
    };
  }
  if (p.stage === "evaluate" && p.mode === "endless")
    return { text: envelope(p, [assess(p, (id, q) => script.met(id, q))]) };
  return { text: envelope(p, [assess(p, script.met)]) };
}

export function improvement(title: string, score = 0.8): LoopDecision {
  return {
    kind: "propose_opportunity",
    opportunities: [
      {
        title,
        observedIssue: `${title} is missing.`,
        area: "src",
        expectedBenefit: `${title} works.`,
        baselineEvidence: [],
        acceptanceConditions: [`${title} is observable in src/a.ts`],
        estimatedScope: "small",
        dependencies: [],
        whyNow: "It matters now.",
        approach: `Change src/a.ts for ${title}.`,
        scores: {
          benefit: score,
          confidence: score,
          urgency: score,
          effort: 0.2,
          regressionRisk: 0.1,
        },
      },
    ],
  } as LoopDecision;
}

export async function loopSetup() {
  const f = await orchestration();
  const loop = new ScriptedLoopDriver();
  let clock = Date.parse("2026-10-19T00:00:00.000Z");
  const supervisor = new LoopSupervisor(
    f.store,
    f.orchestrator,
    f.driver,
    loop,
    () => {},
    {
      clock: () => clock,
      exportRoot: `${f.directory}/exports`,
    },
  );
  const script: LoopScript = {
    met: () => false,
    opportunities: () => [],
    organize: () => [
      {
        kind: "request_wait",
        condition: "external",
        reason: "Keep the organization.",
        question: null,
        goalIds: [],
        retryAfterSeconds: null,
      } as LoopDecision,
    ],
  };
  f.driver.total = 4;
  f.driver.perProvider = 4;
  f.driver.reply = (turn) =>
    turn.protocol?.kind === "recursive-loop-v1"
      ? loopReply(turn, script)
      : defaultReply(turn);
  return {
    ...f,
    loop,
    supervisor,
    script,
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    reopenSupervisor() {
      const o = f.reopen();
      return new LoopSupervisor(f.store, o, f.driver, loop, () => {}, {
        clock: () => clock,
      });
    },
  };
}

/** Ticks both engines and settles attempts until `until` holds or steps run out. */
export async function driveLoop(
  t: Awaited<ReturnType<typeof loopSetup>>,
  runId: string,
  until: (view: ReturnType<LoopSupervisor["view"]>) => boolean,
  maxSteps = 200,
  supervisor: LoopSupervisor = t.supervisor,
) {
  for (let i = 0; i < maxSteps; i++) {
    await supervisor.orchestrator.tick();
    await supervisor.tick();
    const view = supervisor.view(runId);
    if (until(view)) return view;
    t.driver.settle();
  }
  return supervisor.view(runId);
}

export const startRun = async (
  t: Awaited<ReturnType<typeof loopSetup>>,
  input: Omit<
    Parameters<LoopSupervisor["create"]>[0],
    "projectId" | "commandId"
  >,
) => {
  const created = await t.supervisor.create({
    projectId: "p",
    commandId: `create-${Math.random()}`,
    ...input,
  });
  const review = t.supervisor.authorityReview(created.run.id);
  return t.supervisor.start({
    runId: created.run.id,
    digest: review.digest,
    commandId: `start-${Math.random()}`,
  });
};

/** Debugging aid: the run's events, iterations and the child goal's state. */
export function trace(
  t: Awaited<ReturnType<typeof loopSetup>>,
  runId: string,
): string {
  const view = t.supervisor.view(runId);
  const events = [
    ...t.store.iterate<{ kind: string; detail: string; runId: string }>(
      "loop-event",
    ),
  ]
    .filter((e) => e.runId === runId)
    .map((e) => `  ${e.kind}: ${e.detail}`);
  const its = t.supervisor
    .iterations(view.run)
    .map(
      (i) =>
        `  #${i.number} ${i.state} repairs=${i.repairs} ${i.detail} ${i.failure ? JSON.stringify(i.failure) : ""}`,
    );
  const goal = view.current?.goal?.goal;
  return [
    `run ${view.run.state}/${view.run.desiredState}: ${view.run.detail} wait=${JSON.stringify(view.run.waitReason)}`,
    ...view.goals.map(
      (g) =>
        `  goal ${g.text} ${g.status} v${g.version} criteria=${g.criteria.length} ${g.assessment ? g.assessment.result + " " + g.assessment.detail : ""}`,
    ),
    ...its,
    goal ? `  child ${goal.state}: ${goal.detail}` : "  no child",
    ...(view.current?.rounds ?? []).map(
      (r) => `  round ${r.stage} ${r.state}: ${r.detail}`,
    ),
    ...events,
  ].join("\n");
}
