import { autoAcceptTerminalMode, type AutoAcceptLevel } from "./auto-accept";
import {
  isBypassMode,
  terminalMode,
  type TerminalModeId,
} from "./terminal-modes";

/**
 * A Claude Code step of a Build and review workflow, from the Claude workflows
 * plan's "How a Claude step runs". Topsl prepares the step and records it as
 * that stage's turn; the owner runs it in Claude Code in Topsl's terminal and
 * hands back Claude's final reply after Claude Code has stopped.
 */
export type ClaudeStepRole = "builder" | "reviewer" | "repair";

/** The model a Claude step's role names: Topsl passes none, so Claude Code's own setting decides. */
export const claudeStepModel = "set-in-claude-code";

/** What each role's step is called on Topsl's screens. */
export const claudeStepNoun = {
  builder: "build",
  reviewer: "review",
  repair: "repair",
} as const satisfies Record<ClaudeStepRole, string>;

/**
 * A workflow role as the setup screen captures it. A Claude role is a Claude
 * Code step, to which Topsl passes no model or effort; the screens never offer
 * Claude's structured route, which stays gated.
 */
export function teamRole(
  provider: "codex" | "claude",
  installationId: string,
  model: string,
  effort?: string,
):
  | {
      provider: "codex";
      installationId: string;
      model: string;
      effort?: string;
    }
  | {
      provider: "claude";
      installationId: string;
      model: typeof claudeStepModel;
      route: "terminal";
    } {
  return provider === "claude"
    ? { provider, installationId, model: claudeStepModel, route: "terminal" }
    : { provider, installationId, model, ...(effort ? { effort } : {}) };
}

/** One opening of Claude Code for a step, each with a new session id. */
export interface ClaudeStepOpen {
  sessionId: string;
  /** The terminal Topsl opened, once it started. */
  terminalId: string | null;
  mode: TerminalModeId;
  runtimeVersion: string | null;
  executableIdentity: string;
  requestedAt: string;
  state: "requested" | "opened" | "failed";
  error: string | null;
}

export interface ClaudeStep {
  /** The id of the stage's attempt, which this step is. */
  id: string;
  projectId: string;
  workflowId: string;
  attemptId: string;
  taskId: string;
  role: ClaudeStepRole;
  installationId: string;
  /** The build a review reads, or the build a build or repair starts from. */
  candidateId: string;
  candidateRevision: string;
  specificationId: string;
  contextPackageId: string;
  instructionsHash: string;
  /** Where Claude Code opens: the project folder, or a review's copy of the build. */
  workspaceId: string;
  folder: string;
  /**
   * waiting: until the owner hands back a reply Topsl takes, or cancels.
   * returned: Topsl took the reply. stale: the reply came after the workflow
   * moved on and is kept as evidence. cancelled: the workflow was cancelled.
   */
  state: "waiting" | "returned" | "stale" | "cancelled";
  opens: ClaudeStepOpen[];
  /** The reply Topsl took, or kept as stale evidence. */
  replyId: string | null;
  /** Whether that reply came from the owner's paste or the session's transcript. */
  replySource: ClaudeStepReplySource | null;
  /** When the owner confirmed Claude Code had stopped. */
  stoppedAt: string | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a step's reply came from: the owner pasted it, or Topsl read it from
 * the session's transcript, which the owner turns on in Settings.
 */
export type ClaudeStepReplySource = "owner-paste" | "claude-transcript";

/** The session transcript Topsl took a reply from, and what it checked. */
export interface ClaudeTranscriptSource {
  /** The record shapes Topsl recognized, as its fixtures cover them. */
  shapes: string;
  sessionId: string;
  file: string;
  bytes: number;
  sha256: string;
  records: number;
  /** The id of the last record of Claude's reply. */
  replyRecord: string;
}

/** How a reply's source reads on Topsl's screens and in its acceptance dialog. */
export const claudeReplySourceText = {
  "owner-paste": "pasted by you",
  "claude-transcript": "read from its session's transcript",
} as const satisfies Record<ClaudeStepReplySource, string>;

/** A step whose reply Topsl took, as acceptance names it. */
export interface ClaudeStepProvenance {
  role: ClaudeStepRole;
  replySource: ClaudeStepReplySource;
  /** The session the reply came from: the step's latest opening. */
  sessionId: string | null;
  mode: TerminalModeId | null;
  runtimeVersion: string | null;
}

/** One step's line in Topsl's acceptance dialog. */
export function claudeStepProvenanceText(step: ClaudeStepProvenance): string {
  return [
    `Claude Code ${claudeStepNoun[step.role]}: reply ${claudeReplySourceText[step.replySource]}`,
    `session ${step.sessionId ?? "unknown"}`,
    step.mode ? terminalMode("claude", step.mode).label : "mode unknown",
    `Claude Code ${step.runtimeVersion ?? "version unknown"}`,
  ].join(" · ");
}

/** A reply the owner handed back, kept whether or not Topsl took it. */
export interface ClaudeStepReply {
  id: string;
  projectId: string;
  workflowId: string;
  stepId: string;
  source: ClaudeStepReplySource;
  /** The transcript, for a reply Topsl read from one. */
  transcript?: ClaudeTranscriptSource;
  text: string;
  hash: string;
  /** taken: the step's result. invalid: the step keeps waiting. stale: kept as evidence only. */
  outcome: "taken" | "invalid" | "stale";
  detail: string;
  receivedAt: string;
}

/**
 * The mode Topsl opens Claude Code in for a step. A review always opens in
 * Plan. A build or repair opens in the mode the owner picked, else in
 * auto-accept's mode while it is on, else with nothing passed, so Claude
 * Code's own settings decide. Bypass is possible only for a build or repair
 * while auto-accept is Everything, and Topsl still confirms it each time.
 */
export function claudeStepMode(
  role: ClaudeStepRole,
  level: AutoAcceptLevel,
  requested?: TerminalModeId,
): TerminalModeId {
  if (role === "reviewer") {
    if (requested && requested !== "plan")
      throw new Error(
        "A Claude Code review opens only in Plan, in its read-only copy of the build.",
      );
    return "plan";
  }
  const mode =
    requested ?? autoAcceptTerminalMode(level, "claude") ?? "provider-default";
  terminalMode("claude", mode);
  if (isBypassMode(mode) && level !== "everything")
    throw new Error(
      "Topsl opens a Claude Code build or repair in Bypass only while auto-accept is Everything.",
    );
  return mode;
}

/**
 * The preference that turns on reading a step's reply from its session's
 * transcript, the Claude workflows plan's step 3. It is off until the owner
 * turns it on in Settings and confirms it in Topsl's own dialog.
 */
export const claudeTranscriptPreferenceId = "claude-transcript-read";

/** What each choice of the setting does, as Settings says it. */
export const claudeTranscriptOptions = [
  {
    enabled: false,
    label: "Off",
    effect:
      "You paste Claude's final reply when you hand back a workflow's Claude Code step.",
  },
  {
    enabled: true,
    label: "On",
    effect:
      "When you hand back a Claude Code step without pasting, Topsl takes Claude's final reply from that session's transcript. Anything Topsl does not recognize there falls back to your paste.",
  },
] as const;

/** The text of Topsl's confirmation before it starts reading Claude Code's transcripts. */
export function claudeTranscriptConfirmation(): {
  message: string;
  detail: string;
  affirmative: string;
} {
  return {
    message: "Let Topsl read Claude Code's transcripts for workflow steps?",
    detail: [
      "When you hand back a workflow's Claude Code step without pasting a reply, Topsl reads that session's transcript in Claude Code's projects folder and takes Claude's final reply from it.",
      "",
      "Topsl reads only the file named by the session id it passed when it opened Claude Code, and takes a reply only if every record names that session and the step's folder, or a folder inside it. Anything else falls back to your paste, including a reply that went to another session after /clear or /branch.",
      "",
      "Claude Code describes its transcript format as internal, and it changes between versions, so Topsl recognizes only the record shapes it was tested with. A review read from a transcript must still be a valid review of the build.",
    ].join("\n"),
    affirmative: "Read transcripts",
  };
}
