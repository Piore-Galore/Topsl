/**
 * The owner's decision of 19 October 2026 to let Topsl run Claude Code's
 * structured route (`claude --print --output-format stream-json`) for
 * automated coordinator, loop and review work. It is off until the owner turns
 * it on in Settings and confirms it in Topsl's own dialog. Turning it on does
 * not make a Claude runtime ready: each purpose still needs a current Claude
 * runtime qualification that observed what the purpose requires.
 */
export const claudeRoutePreferenceId = "claude-structured-route";

/** The stored decision. `decidedAt` is when the owner last changed it. */
export interface ClaudeRouteDecision {
  enabled: boolean;
  decidedAt: string | null;
}

/** Reads the stored preference, or off for anything Topsl does not know. */
export function claudeRouteDecision(stored: unknown): ClaudeRouteDecision {
  const value =
    stored && typeof stored === "object"
      ? (stored as { value?: unknown; decidedAt?: unknown })
      : null;
  return value?.value === true
    ? {
        enabled: true,
        decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : null,
      }
    : {
        enabled: false,
        decidedAt:
          typeof value?.decidedAt === "string" ? value.decidedAt : null,
      };
}

/** What each choice of the setting does, as Settings says it. */
export const claudeRouteOptions = [
  {
    enabled: false,
    label: "Off",
    effect:
      "Claude Code takes part only as steps you run in Topsl's terminal. Topsl starts no Claude turn itself.",
  },
  {
    enabled: true,
    label: "On",
    effect:
      "Topsl may start Claude Code itself for coordinator, loop and review work, under your Claude Code login and usage. Each runtime still needs a current Claude qualification for each purpose it serves.",
  },
] as const;

/** The text of Topsl's confirmation before it turns the Claude route on. */
export function claudeRouteConfirmation(): {
  message: string;
  detail: string;
  affirmative: string;
} {
  return {
    message: "Let Topsl run Claude Code unattended?",
    detail: [
      "Topsl will start Claude Code itself (claude --print with stream-json output) for coordinator, loop and review work, with no terminal open and nobody watching each turn.",
      "",
      "Every turn runs under your own Claude Code login and counts against your Claude subscription usage. Topsl does not use an API key, and it refuses to start when an API key or another provider's settings are in its environment.",
      "",
      "Topsl limits what Claude Code may do with its permission settings: a review or coordinator turn gets no file or command tools, only Topsl's own read-only tools for the build under review; an implementation turn gets file read, edit and search tools, and nothing that runs commands. These are Claude Code's own permission lists, not operating-system filesystem isolation: Claude Code's process runs with your access, and a defect or a setting Topsl does not control could let it reach files outside the project.",
      "",
      "Turning this on does not make any Claude runtime ready. A runtime is used only for the purposes its current Claude qualification observed. You can turn this off at any time; Topsl then starts no new Claude turn.",
    ].join("\n"),
    affirmative: "Allow unattended Claude Code",
  };
}
