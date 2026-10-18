import type {
  AggregatedFinding,
  CompletionPolicy,
  DecisionEndorsement,
  FindingObservation,
  ParticipantContribution,
  RoleRound,
} from "../domain/role-groups";
import { hash, stable } from "../domain/invariants";

/**
 * Freezes a round's participation and decision rule from the group policy
 * and its resolved members. The electorate and its denominator never change
 * afterwards: abstentions, failures and retries cannot shrink them.
 */
export function freezePolicy(
  policy: CompletionPolicy,
  members: Array<{ memberId: string; required: boolean }>,
): {
  requiredContributorIds: string[];
  minimumValidContributions: number;
  electorateIds: string[];
  threshold: number;
  requiredEndorserIds: string[];
  conflicts: string[];
} {
  const ids = members.map((m) => m.memberId);
  const required = members.filter((m) => m.required).map((m) => m.memberId);
  const conflicts: string[] = [];
  const known = (list: string[], field: string) =>
    list.filter((v) => {
      if (ids.includes(v)) return true;
      conflicts.push(
        `The ${field} name ${v}, which is not in this round's roster.`,
      );
      return false;
    });
  const requiredContributorIds = known(
    policy.requiredContributorIds ?? required,
    "required contributors",
  );
  const electorateIds = known(policy.electorateIds ?? required, "electorate");
  const requiredEndorserIds = known(
    policy.requiredEndorserIds,
    "required endorsers",
  );
  for (const endorser of requiredEndorserIds)
    if (!electorateIds.includes(endorser))
      conflicts.push(`Required endorser ${endorser} is not in the electorate.`);
  const n = electorateIds.length;
  const threshold =
    policy.threshold.kind === "all"
      ? n
      : policy.threshold.kind === "count"
        ? policy.threshold.count
        : Math.ceil(
            (n * policy.threshold.numerator) / policy.threshold.denominator,
          );
  if (threshold > n)
    conflicts.push(
      `The decision needs ${threshold} endorsements, but the electorate has ${n} members.`,
    );
  if (policy.minimumValidContributions > ids.length)
    conflicts.push(
      `${policy.minimumValidContributions} valid contributions are required, but the roster has ${ids.length} members.`,
    );
  return {
    requiredContributorIds,
    minimumValidContributions: policy.minimumValidContributions,
    electorateIds,
    threshold: Math.max(1, threshold),
    requiredEndorserIds,
    conflicts,
  };
}

export const policyDigest = (
  round: Pick<
    RoleRound,
    | "requiredContributorIds"
    | "minimumValidContributions"
    | "electorateIds"
    | "threshold"
    | "requiredEndorserIds"
    | "members"
  >,
) =>
  hash(
    stable({
      requiredContributorIds: round.requiredContributorIds,
      minimumValidContributions: round.minimumValidContributions,
      electorateIds: round.electorateIds,
      threshold: round.threshold,
      requiredEndorserIds: round.requiredEndorserIds,
      assignments: round.members.map((m) => [
        m.memberId,
        m.assignmentId,
        m.assignmentRevision,
      ]),
    }),
  );

/** A contribution counts only for the exact frozen assignment revision it came from. */
export function countsFor(
  round: RoleRound,
  c: ParticipantContribution,
): boolean {
  const member = round.members.find((m) => m.memberId === c.memberId);
  return (
    !!member &&
    c.roundId === round.id &&
    c.assignmentId === member.assignmentId &&
    c.assignmentRevision === member.assignmentRevision &&
    c.inputDigest === round.input.digest &&
    c.validation.state === "valid"
  );
}

export interface ParticipationStatus {
  satisfied: boolean;
  returned: string[];
  missing: string[];
  validCount: number;
  detail: string;
}

/** Whether every required contributor, and the minimum count, returned a valid contribution. */
export function participation(
  round: RoleRound,
  contributions: ParticipantContribution[],
  phase: ParticipantContribution["phase"] = "initial",
): ParticipationStatus {
  const valid = new Set(
    contributions
      .filter((c) => c.phase === phase && countsFor(round, c))
      .map((c) => c.memberId),
  );
  const missing = round.requiredContributorIds.filter((id) => !valid.has(id));
  const satisfied =
    !missing.length && valid.size >= round.minimumValidContributions;
  return {
    satisfied,
    returned: [...valid],
    missing,
    validCount: valid.size,
    detail: satisfied
      ? `${valid.size} of ${round.members.length} contributions returned; every required contribution is valid.`
      : `${valid.size} of ${round.members.length} contributions returned; waiting for ${missing.join(", ") || `${round.minimumValidContributions - valid.size} more valid contributions`}.`,
  };
}

export interface DecisionStatus {
  passes: boolean;
  impossible: boolean;
  endorsements: number;
  challenges: number;
  abstentions: number;
  pending: string[];
  threshold: number;
  electorate: number;
  requiredEndorsersMissing: string[];
  detail: string;
}

/**
 * Evaluates the frozen decision rule for one exact candidate. Each member has
 * at most one vote, a challenge or abstention never counts as endorsement,
 * and a required endorser's dissent blocks the decision whatever the count.
 * Required participation is checked separately and cannot be waived by a quorum.
 */
export function evaluateDecision(
  round: RoleRound,
  candidateDigest: string,
  endorsements: DecisionEndorsement[],
): DecisionStatus {
  const votes = new Map<string, DecisionEndorsement>();
  for (const e of endorsements) {
    const member = round.members.find((m) => m.memberId === e.memberId);
    if (
      e.roundId !== round.id ||
      e.candidateDigest !== candidateDigest ||
      !round.electorateIds.includes(e.memberId) ||
      !member ||
      e.assignmentId !== member.assignmentId
    )
      continue;
    // A retry or duplicate event never adds a second vote.
    if (!votes.has(e.memberId)) votes.set(e.memberId, e);
  }
  const all = [...votes.values()];
  const endorsed = all
    .filter((e) => e.stance === "endorse")
    .map((e) => e.memberId);
  const challenges = all.filter((e) => e.stance === "challenge").length;
  const abstentions = all.filter((e) => e.stance === "abstain").length;
  const pending = round.electorateIds.filter((id) => !votes.has(id));
  const requiredEndorsersMissing = round.requiredEndorserIds.filter(
    (id) => !endorsed.includes(id),
  );
  const requiredEndorserDissent = round.requiredEndorserIds.some(
    (id) => votes.has(id) && votes.get(id)!.stance !== "endorse",
  );
  const passes =
    endorsed.length >= round.threshold && !requiredEndorsersMissing.length;
  const impossible =
    !passes &&
    (endorsed.length + pending.length < round.threshold ||
      requiredEndorserDissent);
  return {
    passes,
    impossible,
    endorsements: endorsed.length,
    challenges,
    abstentions,
    pending,
    threshold: round.threshold,
    electorate: round.electorateIds.length,
    requiredEndorsersMissing,
    detail: `${endorsed.length} of ${round.electorateIds.length} endorsed (needs ${round.threshold}${round.requiredEndorserIds.length ? `, including ${round.requiredEndorserIds.join(", ")}` : ""}); ${challenges} challenged, ${abstentions} abstained, ${pending.length} pending.`,
  };
}

// ---------------------------------------------------------------------------
// Review aggregation for N reviewers.

const tokens = (v: string) =>
  new Set(
    v
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
function similar(a: FindingObservation, b: FindingObservation): boolean {
  if (a.file !== b.file) return false;
  if (a.line === b.line) return true;
  if (Math.abs(a.line - b.line) > 3) return false;
  const x = tokens(a.title + " " + a.behavior),
    y = tokens(b.title + " " + b.behavior);
  const shared = [...x].filter((t) => y.has(t)).length;
  return shared / Math.max(1, new Set([...x, ...y]).size) >= 0.34;
}
const rank = { high: 3, medium: 2, low: 1 } as const;

/**
 * Groups overlapping observations into findings while keeping every original
 * observation and its member. A reviewer who did not mention a finding is
 * recorded as silent: omission is never evidence that a defect is fixed.
 */
export function aggregateFindings(
  observations: FindingObservation[],
  reportingMemberIds: string[],
  prior: AggregatedFinding[] = [],
): AggregatedFinding[] {
  const groups: FindingObservation[][] = [];
  for (const o of observations) {
    const group = groups.find((g) =>
      g.some((existing) => similar(existing, o)),
    );
    if (group) group.push(o);
    else groups.push([o]);
  }
  return groups.map((group) => {
    const lead = [...group].sort(
      (a, b) => rank[b.severity] - rank[a.severity] || a.line - b.line,
    )[0];
    const key = hash(
      stable([lead.file, lead.line, [...tokens(lead.title)].sort()]),
    ).slice(0, 16);
    const reporters = new Set(group.map((o) => o.memberId));
    const before = prior.find((p) => p.key === key);
    return {
      id: before?.id ?? key,
      key,
      title: lead.title,
      severity: lead.severity,
      file: lead.file,
      line: lead.line,
      observations: group,
      silentMemberIds: reportingMemberIds.filter((id) => !reporters.has(id)),
      disposition: before?.disposition ?? "open",
      dispositionRationale: before?.dispositionRationale ?? null,
      decidedBy: before?.decidedBy ?? null,
    };
  });
}

export const blockingDispositions: ReadonlySet<
  AggregatedFinding["disposition"]
> = new Set(["open", "substantiated"]);

export interface ReviewStatus {
  complete: boolean;
  satisfied: boolean;
  returned: number;
  required: number;
  running: number;
  queued: number;
  missing: string[];
  blockingFindings: number;
  detail: string;
}

/**
 * The review completion barrier. Every required report must be valid before
 * the review can complete, and a single substantiated or undecided finding
 * blocks acceptance however many reports are clean.
 */
export function reviewStatus(
  round: RoleRound,
  contributions: ParticipantContribution[],
  findings: AggregatedFinding[],
): ReviewStatus {
  const p = participation(round, contributions);
  const required = round.requiredContributorIds.length;
  const returned = round.requiredContributorIds.filter((id) =>
    p.returned.includes(id),
  ).length;
  const running = round.members.filter((m) => m.state === "running").length;
  const queued = round.members.filter((m) => m.state === "queued").length;
  const blockingFindings = findings.filter((f) =>
    blockingDispositions.has(f.disposition),
  ).length;
  const complete = p.satisfied;
  return {
    complete,
    satisfied: complete && blockingFindings === 0,
    returned,
    required,
    running,
    queued,
    missing: p.missing,
    blockingFindings,
    detail: `${returned} of ${required} reviews returned${running ? `; ${running} running` : ""}${queued ? `; ${queued} queued` : ""}${complete ? `; ${blockingFindings} findings need a disposition` : ""}.`,
  };
}
