import { safeError } from "../domain/invariants";
import type {
  ProviderToolCall,
  ProviderToolResult,
  ToolBinding,
} from "./contract";

export interface ToolCallAnswer {
  result: ProviderToolResult;
  outcome: "answered" | "refused" | "failed";
  /** Why a call was refused or failed; an answer's content is not kept. */
  detail: string | null;
}

/** Answers a runtime's tool call with the session's own tools, only for the
 * thread and turn the session is running. The runtime manager and the
 * qualification both answer through here, so the route that is qualified is
 * the route reviews use. */
export async function answerToolCall(
  tools: ToolBinding | undefined,
  call: ProviderToolCall,
  session: { threadId: string | null; turnId: string | null; ended: boolean },
): Promise<ToolCallAnswer> {
  const refusal = !tools
    ? "No Topsl tools are installed for this session."
    : session.ended
      ? "This run has ended."
      : call.threadId !== session.threadId || call.turnId !== session.turnId
        ? "This tool call is outside the active turn."
        : call.namespace !== tools.toolset.namespace ||
            !tools.toolset.tools.some((tool) => tool.name === call.tool)
          ? "Topsl has no such tool."
          : null;
  if (refusal || !tools)
    return {
      result: { text: refusal ?? "", success: false },
      outcome: "refused",
      detail: refusal,
    };
  let result: ProviderToolResult;
  try {
    result = await tools.call(call);
  } catch (error) {
    result = { text: safeError(error), success: false };
  }
  return {
    result,
    outcome: result.success ? "answered" : "failed",
    detail: result.success ? null : result.text.slice(0, 500),
  };
}
