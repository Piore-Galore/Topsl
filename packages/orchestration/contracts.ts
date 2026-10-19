import { z } from "zod";
import { hash, stable } from "../domain/invariants";
import type {
  CollaborationMode,
  DecisionCandidate,
  ExecutionPurpose,
  ParticipantContribution,
  PlanTaskAction,
  RoleRound,
} from "../domain/role-groups";
import { reviewSchema } from "../workflows/builder-reviewer";
import type { TurnProtocol } from "../domain/recursive-loops";
import { loopOutputSchema } from "./loop-contracts";

/**
 * Output contracts per execution purpose. Every purpose parses only the
 * member's final assistant message, never concatenated progress, and a
 * coordinator's read-only filesystem never makes its output a candidate review.
 */
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const planActionSchema = z
  .object({
    key,
    title: z.string().min(1).max(500),
    kind: z.enum(["implementation", "information"]),
    roleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    dependencies: z.array(key).max(50).default([]),
    permittedOutputs: z
      .array(z.string().min(1).max(4096))
      .max(1000)
      .default([]),
    acceptanceCriteria: z
      .array(z.string().min(1).max(2000))
      .max(50)
      .default([]),
    brief: z.string().min(1).max(20000),
    partitions: z
      .array(
        z.object({
          title: z.string().min(1).max(500),
          permittedOutputs: z.array(z.string().min(1).max(4096)).max(1000),
        }),
      )
      .max(64)
      .default([]),
  })
  .strict();

export const coordinatorProposalSchema = z
  .object({
    snapshotDigest: z.string().min(1),
    summary: z.string().min(1).max(20000),
    assumptions: z.array(z.string().max(2000)).max(50).default([]),
    actions: z.array(planActionSchema).min(1).max(100),
    concerns: z.array(z.string().max(2000)).max(50).default([]),
  })
  .strict();
export type CoordinatorProposal = z.infer<typeof coordinatorProposalSchema>;

export const endorsementSchema = z
  .object({
    candidateDigest: z.string().min(1),
    stance: z.enum(["endorse", "challenge", "abstain"]),
    rationale: z.string().max(20000),
  })
  .strict();

export const informationSchema = z
  .object({
    inputDigest: z.string().min(1),
    summary: z.string().min(1).max(20000),
    report: z.string().min(1).max(200000),
    limitations: z.array(z.string().max(2000)).max(50).default([]),
  })
  .strict();

export const implementationSummarySchema = z
  .object({
    inputDigest: z.string().min(1),
    summary: z.string().min(1).max(20000),
  })
  .strict();

export const purposeSchemas = {
  "coordinator-contribution": coordinatorProposalSchema,
  "coordinator-endorsement": endorsementSchema,
  information: informationSchema,
  "candidate-review": reviewSchema,
  implementation: implementationSummarySchema,
} as const;

/**
 * The JSON Schema a runtime gets for a purpose, when it can enforce one. The
 * registry is keyed by purpose, protocol kind and stage: an ordinary
 * coordinator-v1 contribution keeps its task-plan schema, and a
 * recursive-loop-v1 turn on the same read-only route gets its stage envelope.
 */
export function purposeOutputSchema(
  purpose: ExecutionPurpose,
  protocol?: TurnProtocol | null,
): Record<string, unknown> | null {
  if (purpose === "direct-chat") return null;
  if (protocol?.kind === "recursive-loop-v1")
    return loopOutputSchema(purpose, protocol);
  return z.toJSONSchema(purposeSchemas[purpose]) as Record<string, unknown>;
}

export function parseFinal<T extends z.ZodType>(
  schema: T,
  finalText: string | null,
): { ok: true; value: z.infer<T> } | { ok: false; reason: string } {
  if (!finalText?.trim())
    return { ok: false, reason: "The member returned no final message." };
  let value: unknown;
  try {
    value = JSON.parse(
      finalText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
    );
  } catch {
    return { ok: false, reason: "The final message is not JSON." };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    // Zod names the field and what it expected, never the member's own text.
    return {
      ok: false,
      reason: `The final message does not match the contract (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "the reply"}: ${i.message}`)
        .join("; ")}).`,
    };
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Plan actions: normalization, digests and validation.

export function normalizeAction(
  a: z.infer<typeof planActionSchema>,
): PlanTaskAction {
  return {
    key: a.key,
    title: a.title.trim(),
    kind: a.kind,
    roleId: a.roleId,
    dependencies: [...new Set(a.dependencies)].sort(),
    permittedOutputs: [...new Set(a.permittedOutputs)].sort(),
    acceptanceCriteria: a.acceptanceCriteria.map((c) => c.trim()),
    brief: a.brief.trim(),
    partitions: a.partitions.map((p) => ({
      title: p.title.trim(),
      permittedOutputs: [...new Set(p.permittedOutputs)].sort(),
    })),
  };
}

/** The identity of an action's content; titles and wording are part of it. */
export const actionDigest = (a: PlanTaskAction) => hash(stable(a));
export const actionSetDigest = (actions: PlanTaskAction[]) =>
  hash(
    stable(
      [...actions].sort((x, y) => x.key.localeCompare(y.key)).map(actionDigest),
    ),
  );

/** The exact decision a member endorses: actions, roster, policy and bounds. */
export function candidateDigest(
  round: RoleRound,
  actions: PlanTaskAction[],
  assumptions: string[],
): string {
  return hash(
    stable({
      round: round.id,
      actions: actionSetDigest(actions),
      assumptions: [...assumptions].sort(),
      roster: round.members.map((m) => [
        m.memberId,
        m.assignmentId,
        m.assignmentRevision,
      ]),
      policy: round.policyDigest,
      expected: [
        round.input.goalRevision,
        round.input.planRevision,
        round.input.controlGeneration,
      ],
      bounds: round.input.allowedOperations,
    }),
  );
}

export function validateActions(
  actions: PlanTaskAction[],
  context: {
    knownRoles: string[];
    allowedKinds: string[];
    remainingTasks: number;
    rosters: Record<
      string,
      { members: number; collaboration: CollaborationMode }
    >;
    /** Each role's execution purpose, for task-kind compatibility. */
    rolePurposes?: Record<string, ExecutionPurpose>;
  },
): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const a of actions) {
    if (keys.has(a.key)) problems.push(`Action key ${a.key} appears twice.`);
    keys.add(a.key);
    if (!context.knownRoles.includes(a.roleId))
      problems.push(
        `Action ${a.key} names role ${a.roleId}, which is not defined or not active. Coordinators cannot invent roles or models.`,
      );
    // A task kind needs a role whose purpose produces its output contract:
    // an implementation task cannot go to a reviewer or information role.
    const purpose = context.rolePurposes?.[a.roleId];
    if (
      purpose &&
      ((a.kind === "implementation" && purpose !== "implementation") ||
        (a.kind === "information" && purpose !== "information"))
    )
      problems.push(
        `Action ${a.key} is ${a.kind} work, but role ${a.roleId} has purpose ${purpose}; its output contract cannot satisfy this task.`,
      );
    if (
      context.knownRoles.includes(a.roleId) &&
      context.rosters[a.roleId]?.members === 0
    )
      problems.push(
        `Action ${a.key} goes to ${a.roleId}, which has no member that can run now.`,
      );
    if (!context.allowedKinds.includes(a.kind))
      problems.push(
        `Action ${a.key} is ${a.kind} work, which the goal's grant does not permit.`,
      );
    if (
      a.kind === "implementation" &&
      !a.permittedOutputs.length &&
      !a.partitions.length
    )
      problems.push(
        `Implementation action ${a.key} declares no permitted outputs.`,
      );
    const roster = context.rosters[a.roleId];
    if (
      a.kind === "implementation" &&
      roster?.collaboration === "parallel-partitioned" &&
      roster.members > 1 &&
      a.partitions.length !== roster.members
    )
      problems.push(
        `Action ${a.key} goes to a partitioned group of ${roster.members} members and needs ${roster.members} partitions, not ${a.partitions.length}.`,
      );
    if (a.partitions.length) {
      const owned = a.partitions.flatMap((p) => p.permittedOutputs);
      if (new Set(owned).size !== owned.length)
        problems.push(
          `Action ${a.key} gives one output to two partitions; concurrent writers need distinct scopes.`,
        );
    }
  }
  for (const a of actions)
    for (const d of a.dependencies)
      if (!keys.has(d))
        problems.push(
          `Action ${a.key} depends on ${d}, which is not in the plan.`,
        );
  const graph = new Map(actions.map((a) => [a.key, a.dependencies]));
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (k: string): boolean => {
    if (visiting.has(k)) return false;
    if (done.has(k)) return true;
    visiting.add(k);
    const ok = (graph.get(k) ?? []).every((d) => !graph.has(d) || visit(d));
    visiting.delete(k);
    done.add(k);
    return ok;
  };
  if (![...graph.keys()].every(visit))
    problems.push("The plan's dependencies contain a cycle.");
  if (actions.length > context.remainingTasks)
    problems.push(
      `The plan delegates ${actions.length} tasks, above the ${context.remainingTasks} the goal's grant still allows.`,
    );
  return problems;
}

/**
 * Combines valid proposals. Identical action sets agree outright; otherwise
 * actions are combined only when no key carries two different contents, so
 * compatibility is demonstrable. Anything else is a conflict to reconcile.
 */
export function combineProposals(
  proposals: Array<{
    contribution: ParticipantContribution;
    actions: PlanTaskAction[];
    assumptions: string[];
  }>,
): {
  agreement: "matching" | "combined" | "conflict";
  actions: PlanTaskAction[];
  assumptions: string[];
  conflicts: Array<{
    key: string;
    variants: Array<{ memberId: string; digest: string; title: string }>;
  }>;
} {
  const digests = new Set(proposals.map((p) => actionSetDigest(p.actions)));
  const assumptions = [
    ...new Set(proposals.flatMap((p) => p.assumptions)),
  ].sort();
  if (digests.size === 1)
    return {
      agreement: "matching",
      actions: proposals[0].actions,
      assumptions,
      conflicts: [],
    };
  const byKey = new Map<
    string,
    Map<string, { action: PlanTaskAction; members: string[] }>
  >();
  for (const p of proposals)
    for (const action of p.actions) {
      const variants = byKey.get(action.key) ?? new Map();
      const d = actionDigest(action);
      const entry = variants.get(d) ?? { action, members: [] };
      entry.members.push(p.contribution.memberId);
      variants.set(d, entry);
      byKey.set(action.key, variants);
    }
  const conflicts = [...byKey]
    .filter(([, variants]) => variants.size > 1)
    .map(([key, variants]) => ({
      key,
      variants: [...variants].flatMap(([digest, v]) =>
        v.members.map((memberId) => ({
          memberId,
          digest,
          title: v.action.title,
        })),
      ),
    }));
  const actions = [...byKey.values()].map(
    (variants) => [...variants.values()][0].action,
  );
  return conflicts.length
    ? { agreement: "conflict", actions: [], assumptions, conflicts }
    : {
        agreement: "combined",
        actions: actions.sort((a, b) => a.key.localeCompare(b.key)),
        assumptions,
        conflicts,
      };
}

// ---------------------------------------------------------------------------
// Prompts. Each carries the frozen round snapshot and nothing a member did
// not need: no other member's initial proposal before collection completes.

export function coordinatorPrompt(input: {
  objective: string;
  constraints: string[];
  round: RoleRound;
  knownRoles: Array<{
    id: string;
    purpose: string;
    members: number;
    collaboration: string;
    unresolved?: number;
  }>;
  completed: Array<{ key: string; title: string; summary: string }>;
  memberId: string;
  instructions: string;
}): string {
  return [
    "You are one coordinator in a peer group. Propose a plan; you cannot dispatch work, change the roster or grant authority.",
    `Your member ID: ${input.memberId}.`,
    `Role instructions: ${input.instructions}`,
    `Goal: ${input.objective}`,
    input.constraints.length
      ? `Constraints:\n- ${input.constraints.join("\n- ")}`
      : "Constraints: none recorded.",
    `Roles you may delegate to (exact IDs; partitioned groups need one partition per member):\n${input.knownRoles
      .map(
        (r) =>
          `- ${r.id}: ${r.purpose}, ${r.members} member(s), ${r.collaboration}${r.unresolved ? ` (${r.unresolved} more cannot run now)` : ""}`,
      )
      .join("\n")}`,
    input.completed.length
      ? `Completed work:\n${input.completed.map((c) => `- ${c.key} ${c.title}: ${c.summary}`).join("\n")}`
      : "No completed work yet.",
    `Allowed action kinds: ${input.round.input.allowedOperations.join(", ")}.`,
    `Snapshot digest (echo it exactly): ${input.round.input.digest}`,
    "Reply with one JSON object only: {snapshotDigest, summary, assumptions[], actions[{key, title, kind, roleId, dependencies[], permittedOutputs[], acceptanceCriteria[], brief, partitions[{title, permittedOutputs[]}]}], concerns[]}.",
  ].join("\n\n");
}

export function reconciliationPrompt(input: {
  base: string;
  proposals: Array<{
    memberId: string;
    summary: string;
    actions: PlanTaskAction[];
  }>;
  conflicts: string[];
  challenges: Array<{ memberId: string; rationale: string }>;
}): string {
  return [
    input.base,
    "All initial proposals are now collected. Address the disputed points and return one revised proposal in the same JSON form.",
    `Disputed points:\n- ${input.conflicts.join("\n- ") || "none recorded"}`,
    input.challenges.length
      ? `Challenges to the last candidate:\n${input.challenges.map((c) => `- ${c.memberId}: ${c.rationale}`).join("\n")}`
      : "",
    `Attributed proposals:\n${input.proposals
      .map(
        (p) => `### ${p.memberId}\n${p.summary}\n${JSON.stringify(p.actions)}`,
      )
      .join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function endorsementPrompt(
  candidate: DecisionCandidate,
  memberId: string,
): string {
  return [
    `You are coordinator ${memberId}. Endorse or challenge this exact candidate decision. You may also abstain.`,
    `Candidate digest (echo it exactly): ${candidate.digest}`,
    `Summary: ${candidate.summary}`,
    `Assumptions: ${candidate.assumptions.join("; ") || "none"}`,
    `Actions: ${JSON.stringify(candidate.actions)}`,
    'Reply with one JSON object only: {"candidateDigest": "...", "stance": "endorse" | "challenge" | "abstain", "rationale": "..."}.',
  ].join("\n\n");
}

export function workPrompt(input: {
  purpose: "information" | "implementation";
  objective: string;
  action: PlanTaskAction;
  partition: { title: string; permittedOutputs: string[] } | null;
  memberId: string;
  instructions: string;
  inputDigest: string;
  handoff: string | null;
  /** Predecessor results this task consumes, with their IDs. */
  dependencies?: string | null;
}): string {
  return [
    `You are member ${input.memberId}. Goal: ${input.objective}`,
    `Role instructions: ${input.instructions}`,
    `Task ${input.action.key}: ${input.action.title}\n${input.action.brief}`,
    input.partition
      ? `Your partition: ${input.partition.title}. Change only: ${input.partition.permittedOutputs.join(", ")}.`
      : input.action.permittedOutputs.length
        ? `Permitted outputs: ${input.action.permittedOutputs.join(", ")}.`
        : "",
    input.action.acceptanceCriteria.length
      ? `Acceptance criteria:\n- ${input.action.acceptanceCriteria.join("\n- ")}`
      : "",
    input.handoff ? `Handoff from the previous member:\n${input.handoff}` : "",
    input.dependencies
      ? `Inputs from the tasks this one depends on:\n${input.dependencies}`
      : "",
    input.purpose === "information"
      ? `Reply with one JSON object only: {"inputDigest": "${input.inputDigest}", "summary": "...", "report": "...", "limitations": []}.`
      : `When done, reply with one JSON object only: {"inputDigest": "${input.inputDigest}", "summary": "..."}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function reviewPrompt(input: {
  objective: string;
  candidateRevision: string;
  memberId: string;
  instructions: string;
  criteria: string[];
}): string {
  return [
    `You are reviewer ${input.memberId}, reviewing independently in a fresh session. You cannot see other reviewers' reports.`,
    `Goal: ${input.objective}`,
    `Role instructions: ${input.instructions}`,
    input.criteria.length
      ? `Acceptance criteria:\n- ${input.criteria.join("\n- ")}`
      : "",
    `Candidate revision (echo it exactly): ${input.candidateRevision}`,
    'Reply with one JSON object only: {"candidateRevision": "...", "summary": "...", "findings": [{"title", "severity": "high"|"medium"|"low", "file", "line", "behavior", "evidence"}]}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}
