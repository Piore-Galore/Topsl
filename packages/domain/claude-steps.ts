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
  /** The reply Topsl took, once it took one. */
  replyId: string | null;
  /** When the owner confirmed Claude Code had stopped. */
  stoppedAt: string | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}

/** A reply the owner handed back, kept whether or not Topsl took it. */
export interface ClaudeStepReply {
  id: string;
  projectId: string;
  workflowId: string;
  stepId: string;
  source: "owner-paste";
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
