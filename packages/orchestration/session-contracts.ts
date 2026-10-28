import { z } from "zod";
import { hash, stable } from "../domain/invariants";
import type { ExecutionPurpose } from "../domain/role-groups";
import type { TurnProtocol } from "../domain/recursive-loops";
import {
  SESSION_PROTOCOL,
  sessionIntakeResponseSchema,
  sessionWordingSchema,
  type ComposerMode,
  type IntakeAlternative,
  type SessionContext,
  type SessionIntakeResponse,
  type SessionIntent,
  type SessionTeamProposal,
} from "../domain/sessions";

/**
 * The session-v1 protocol (docs/Native_Sessions_Plan.md): how coordinators
 * answer a session message, and how their peer answers become one decision.
 * Coordinators propose; only the session supervisor acts. Every field is
 * required (nullable where absent) so a provider can enforce the schema
 * strictly, and every answer repeats the input digest it was given so an
 * answer to an older context is kept as history, never acted on.
 */

export type SessionStage = "intake" | "wording";

const anyOf = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(anyOf);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema))
    out[k === "oneOf" ? "anyOf" : k] = anyOf(v);
  return out;
};

/** The provider-enforced schema for a session-v1 turn. */
export function sessionOutputSchema(
  purpose: ExecutionPurpose,
  protocol: TurnProtocol,
): Record<string, unknown> | null {
  if (protocol.kind !== SESSION_PROTOCOL) return null;
  if (purpose !== "coordinator-contribution") return null;
  const schema =
    protocol.stage === "wording"
      ? sessionWordingSchema
      : sessionIntakeResponseSchema;
  return anyOf(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Parses one coordinator's final message against the stage's contract. */
export function parseSessionTurn<T extends SessionStage>(
  finalText: string | null,
  stage: T,
  inputDigest: string,
):
  | {
      ok: true;
      value: T extends "intake"
        ? SessionIntakeResponse
        : z.infer<typeof sessionWordingSchema>;
    }
  | { ok: false; reason: string; stale?: boolean } {
  if (!finalText?.trim())
    return { ok: false, reason: "The coordinator returned no final message." };
  let raw: unknown;
  try {
    raw = JSON.parse(finalText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { ok: false, reason: "The final message is not JSON." };
  }
  const kind = (raw as { protocolKind?: unknown })?.protocolKind;
  if (kind !== SESSION_PROTOCOL)
    return {
      ok: false,
      reason: `The response names protocol ${String(kind)}, not ${SESSION_PROTOCOL}; it is not interpreted as another contract.`,
    };
  const schema =
    stage === "wording" ? sessionWordingSchema : sessionIntakeResponseSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      reason: `The final message does not match the contract (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "the reply"}: ${i.message}`)
        .join("; ")}).`,
    };
  if (parsed.data.inputDigest !== inputDigest)
    return {
      ok: false,
      stale: true,
      reason:
        "The answer was given for another context; it is kept as history and cannot act.",
    };
  return { ok: true, value: parsed.data as never };
}

/** A team proposal's identity, ignoring the wording of reasons. */
export function teamDigest(team: SessionTeamProposal | null): string {
  if (!team?.length) return "none";
  return hash(
    stable(
      [...team]
        .map((r) => ({
          roleId: r.roleId,
          title: r.title,
          instructions: r.instructions,
          purpose: r.purpose,
          count: r.count,
          models: r.models.map((m) => `${m.provider}:${m.model}`),
        }))
        .sort((a, b) => a.roleId.localeCompare(b.roleId)),
    ),
  );
}

export const decisionDigest = (
  intent: SessionIntent,
  team: SessionTeamProposal | null,
) => hash(stable({ intent, team: teamDigest(team) }));

const modeRules: Record<ComposerMode, string> = {
  auto: 'Decide what the message is. "discuss": a question or conversation that needs no new work. "status": a question about the work in progress. "steer": a change to the current goal while it runs. "new-work": a request for work that should become a new goal. "clarify": the intent is ambiguous; ask one question instead of guessing.',
  discuss:
    'The owner chose Discuss: answer without launching implementation. Use intent "discuss" (or "status" for a progress question) and team null.',
  work: 'The owner chose Work: this message is work. Use "steer" when it targets the current running goal, otherwise "new-work". Propose the team the work needs.',
};

function contextText(context: SessionContext): string {
  const lines: string[] = [];
  if (context.omitted)
    lines.push(
      `Earlier messages ${context.omitted.fromSequence}-${context.omitted.toSequence} (${context.omitted.count}) are omitted; they are recorded in the session.`,
    );
  for (const m of context.messages)
    lines.push(`[${m.sequence}] ${m.role}: ${m.text}`);
  const sections = [`Recent messages:\n${lines.join("\n") || "none"}`];
  if (context.decisions.length)
    sections.push(
      `Recorded decisions:\n${context.decisions.map((d) => `- ${d.intent}: ${d.summary}`).join("\n")}`,
    );
  if (context.work.length)
    sections.push(
      `Session work:\n${context.work
        .map(
          (w) =>
            `- ${w.objective} (${w.state})${w.result ? `: ${w.result}` : ""}`,
        )
        .join("\n")}`,
    );
  sections.push(
    context.checkpoint
      ? `Accepted result: candidate ${context.checkpoint.candidateId}; new goals continue from it, even where it is not yet applied to the project folder.`
      : "Accepted result: none yet; new goals start from the project folder.",
  );
  if (context.status) sections.push(`Current goal status: ${context.status}`);
  sections.push(`Team:\n${context.team.join("\n") || "none"}`);
  return sections.join("\n\n");
}

/** The intake prompt one coordinator reads for one message. */
export function sessionIntakePrompt(input: {
  memberId: string;
  instructions: string;
  context: SessionContext;
  message: string;
  mode: ComposerMode;
  target: { goalId: string; objective: string; state: string } | null;
  teamMode: "automatic" | "custom";
  models: Array<{ provider: string; model: string; purposes: string[] }>;
  inputDigest: string;
  peers?: Array<{ memberId: string; intent: string; reply: string }>;
}): string {
  const team =
    input.teamMode === "automatic"
      ? "Team: automatic. When the work needs it, propose roles (existing role IDs, or a new role with title, instructions and purpose) with member counts and models from the observed list. The owner's pinned settings stay authoritative; your choices fill only open fields. Use team null when no change is needed."
      : "Team: custom. Work within the owner's roster. You may propose models for open member slots of the roster's roles; do not create roles. Use team null when no change is needed.";
  return [
    `You are coordinator ${input.memberId} of a Topsl session, one of its peer coordinators.`,
    `Role instructions: ${input.instructions}`,
    contextText(input.context),
    input.target
      ? `Composer target: the current goal "${input.target.objective}" (${input.target.state}).`
      : "Composer target: a new goal.",
    `The owner's message:\n${input.message}`,
    modeRules[input.mode],
    team,
    `Observed models:\n${input.models.map((m) => `- ${m.provider}:${m.model} (${m.purposes.join(", ")})`).join("\n") || "none"}`,
    input.peers?.length
      ? `Your peers answered differently. Reconcile if you can; otherwise keep your view.\n${input.peers.map((p) => `- ${p.memberId} (${p.intent}): ${p.reply}`).join("\n")}`
      : "",
    `Input digest (echo it exactly): ${input.inputDigest}`,
    `Reply with one JSON object only: {"schemaVersion": 1, "protocolKind": "${SESSION_PROTOCOL}", "inputDigest": "${input.inputDigest}", "intent": "discuss" | "status" | "steer" | "new-work" | "clarify", "reply": "your answer to the owner", "question": null or "one clarifying question", "team": null or [{"roleId", "title", "instructions", "purpose", "count", "models": [{"provider", "model"}], "reason"}]}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The first coordinator prepares one response from its peers' answers. */
export function sessionWordingPrompt(input: {
  memberId: string;
  message: string;
  decision: string;
  contributions: Array<{ memberId: string; intent: string; reply: string }>;
  inputDigest: string;
}): string {
  return [
    `You are coordinator ${input.memberId}. Prepare the shared response to the owner from your peers' answers. This gives you no extra decision authority: report the decision as recorded and attribute differing views.`,
    `The owner's message:\n${input.message}`,
    `Recorded decision: ${input.decision}`,
    `Answers:\n${input.contributions.map((c) => `- ${c.memberId} (${c.intent}): ${c.reply}`).join("\n")}`,
    `Input digest (echo it exactly): ${input.inputDigest}`,
    `Reply with one JSON object only: {"schemaVersion": 1, "protocolKind": "${SESSION_PROTOCOL}", "inputDigest": "${input.inputDigest}", "reply": "..."}.`,
  ].join("\n\n");
}

/** An endorsement turn for a session decision (coordinator-v1 endorsement contract). */
export function sessionEndorsementPrompt(input: {
  memberId: string;
  message: string;
  intent: string;
  team: SessionTeamProposal | null;
  digest: string;
}): string {
  return [
    `You are coordinator ${input.memberId}. Endorse or challenge this exact session decision. You may also abstain.`,
    `Candidate digest (echo it exactly): ${input.digest}`,
    `The owner's message:\n${input.message}`,
    `Decision: ${input.intent === "steer" ? "steer the current goal" : "queue it as new work"}.`,
    `Team: ${input.team?.length ? JSON.stringify(input.team) : "unchanged"}`,
    'Reply with one JSON object only: {"candidateDigest": "...", "stance": "endorse" | "challenge" | "abstain", "rationale": "..."}.',
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Peer decision.

export interface PeerAnswer {
  memberId: string;
  order: number;
  value: SessionIntakeResponse;
}

const actions = new Set<SessionIntent>(["steer", "new-work"]);

/**
 * The intent each answer counts as under the composer mode. Discuss never
 * acts; Work always acts on the composer's target; Auto keeps the
 * coordinators' intent, except that steering needs a running target.
 */
export function effectiveIntent(
  intent: SessionIntent,
  mode: ComposerMode,
  targetActive: boolean,
): SessionIntent {
  if (mode === "discuss") return intent === "status" ? "status" : "discuss";
  if (mode === "work") return targetActive ? "steer" : "new-work";
  if (intent === "steer" && !targetActive) return "new-work";
  return intent;
}

export type PeerDecision =
  | {
      kind: "reply";
      intent: "discuss" | "status" | "clarify";
      views: Array<{ memberId: string; intent: SessionIntent }>;
    }
  | {
      kind: "candidate";
      intent: "steer" | "new-work";
      team: SessionTeamProposal | null;
      digest: string;
      /** Members whose own answer already matches: implied endorsements. */
      implied: string[];
      /** Members who must endorse it in a turn of their own. */
      endorsers: string[];
    }
  | { kind: "reconcile" }
  | { kind: "alternatives"; options: IntakeAlternative[] };

/**
 * Turns peer answers into one decision. Agreement on a non-acting intent is
 * a reply; any clarify asks; agreement on an acting intent is a candidate
 * the others endorse; disagreement gets one reconciliation round and then
 * goes to the owner as alternatives. Order never adds authority: the
 * largest group of identical proposals leads, with order only breaking ties.
 */
export function decidePeers(input: {
  answers: PeerAnswer[];
  mode: ComposerMode;
  targetActive: boolean;
  reconciliationLeft: boolean;
}): PeerDecision {
  const answers = [...input.answers].sort((a, b) => a.order - b.order);
  const counted = answers.map((a) => ({
    ...a,
    intent: effectiveIntent(a.value.intent, input.mode, input.targetActive),
    team: a.value.team,
  }));
  const views = counted.map((a) => ({
    memberId: a.memberId,
    intent: a.intent,
  }));
  const acting = counted.filter((a) => actions.has(a.intent));
  if (!acting.length) {
    const intent: "discuss" | "status" | "clarify" = counted.some(
      (a) => a.intent === "clarify",
    )
      ? "clarify"
      : counted.every((a) => a.intent === "status")
        ? "status"
        : "discuss";
    return { kind: "reply", intent, views };
  }
  const intents = new Set(counted.map((a) => a.intent));
  if (intents.size > 1) {
    if (input.reconciliationLeft) return { kind: "reconcile" };
    return { kind: "alternatives", options: alternatives(counted) };
  }
  const intent = acting[0].intent as "steer" | "new-work";
  // Group identical team proposals; the largest group leads.
  const groups = new Map<string, typeof counted>();
  for (const a of counted) {
    const key = teamDigest(a.team);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const lead = [...groups.values()].sort(
    (a, b) => b.length - a.length || a[0].order - b[0].order,
  )[0];
  const team = lead[0].team;
  return {
    kind: "candidate",
    intent,
    team,
    digest: decisionDigest(intent, team),
    implied: lead.map((a) => a.memberId),
    endorsers: counted.filter((a) => !lead.includes(a)).map((a) => a.memberId),
  };
}

function alternatives(
  counted: Array<{
    memberId: string;
    intent: SessionIntent;
    team: SessionTeamProposal | null;
    value: SessionIntakeResponse;
  }>,
): IntakeAlternative[] {
  const groups = new Map<string, IntakeAlternative>();
  for (const a of counted) {
    const key = decisionDigest(a.intent, a.team);
    const prior = groups.get(key);
    if (prior) prior.memberIds.push(a.memberId);
    else
      groups.set(key, {
        intent: a.intent,
        team: a.team,
        memberIds: [a.memberId],
        summary: a.value.reply.slice(0, 600),
      });
  }
  return [...groups.values()];
}

/** The shared response when no wording turn is needed. */
export function sharedReply(
  answers: PeerAnswer[],
  decision: PeerDecision,
): string {
  const ordered = [...answers].sort((a, b) => a.order - b.order);
  if (decision.kind === "reply" && decision.intent === "clarify") {
    const questions = [
      ...new Set(
        ordered
          .map(
            (a) =>
              a.value.question ??
              (a.value.intent === "clarify" ? a.value.reply : null),
          )
          .filter((q): q is string => !!q),
      ),
    ];
    return questions.length
      ? questions.join("\n")
      : (ordered[0]?.value.reply ?? "");
  }
  return ordered[0]?.value.reply ?? "";
}
