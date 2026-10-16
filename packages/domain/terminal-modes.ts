import type { Provider } from "./types";

/**
 * Permission modes Topsl can ask for when it opens a native terminal, from the
 * provider permissions plan. Topsl passes only the arguments in this table, so
 * no free text reaches the command line. A mode Topsl asked for is not proof of
 * the policy in force: managed settings can override either provider.
 */
export const terminalModeIds = [
  "provider-default",
  "manual",
  "plan",
  "accept-edits",
  "auto",
  "dont-ask",
  "bypass",
  "read-only",
  "workspace-on-request",
  "workspace-never",
  "workspace-auto-review",
  "full-access",
] as const;
export type TerminalModeId = (typeof terminalModeIds)[number];

export interface TerminalMode {
  id: TerminalModeId;
  label: string;
  /** Exactly what Topsl passes to the executable. */
  args: readonly string[];
  /** What the mode does, per the provider's own documentation or help. */
  effect: string;
  /**
   * Set for a bypass mode: offered under Advanced, confirmed in Topsl's own
   * dialog every time, and never remembered or chosen by Topsl.
   */
  warning?: string;
}

// Claude Code: https://code.claude.com/docs/en/permission-modes, read on 16 October 2026.
// Codex CLI 0.163.0: `codex --help`.
export const terminalModes: Readonly<
  Record<Provider, readonly TerminalMode[]>
> = {
  claude: [
    {
      id: "provider-default",
      label: "Provider default",
      args: [],
      effect:
        "Passes nothing. Claude Code's own settings decide; without one, version 2.1.283 and later start in auto.",
    },
    {
      id: "manual",
      label: "Manual",
      args: ["--permission-mode", "default"],
      effect:
        "Asks before most actions that edit files, run shell commands or reach the network.",
    },
    {
      id: "plan",
      label: "Plan",
      args: ["--permission-mode", "plan"],
      effect:
        "Reads files and runs commands to explore, then proposes changes without making them. Edits stay blocked until you approve the plan, unless the session also has bypass permissions available.",
    },
    {
      id: "accept-edits",
      label: "Accept edits",
      args: ["--permission-mode", "acceptEdits"],
      effect:
        "Accepts file edits and common file commands such as mkdir and mv in its working folders, and asks for the rest.",
    },
    {
      id: "auto",
      label: "Auto",
      args: ["--permission-mode", "auto"],
      effect:
        "Runs without routine prompts; a classifier reviews actions instead of you. It needs a supported model, and where an administrator turns it off, Claude Code starts in Manual instead.",
    },
    {
      id: "dont-ask",
      label: "Don't ask",
      args: ["--permission-mode", "dontAsk"],
      effect:
        "Runs reads in its working folders and pre-approved tools only; anything that would ask is refused.",
    },
    {
      id: "bypass",
      label: "Bypass",
      args: ["--permission-mode", "bypassPermissions"],
      effect: "Skips permission prompts and safety checks.",
      warning:
        'Claude Code\'s documentation says: "Only use this mode in isolated environments like containers, VMs, or dev containers without internet access, where Claude Code cannot damage your host system." It also says this mode "offers no protection against prompt injection or unintended actions."',
    },
  ],
  codex: [
    {
      id: "provider-default",
      label: "Provider default",
      args: [],
      effect: "Passes nothing. Codex's config.toml decides.",
    },
    {
      id: "read-only",
      label: "Read-only",
      args: ["-s", "read-only", "-a", "on-request"],
      effect:
        "Commands cannot write, and the model decides when to ask for more.",
    },
    {
      id: "workspace-on-request",
      label: "Workspace, ask when needed",
      args: ["-s", "workspace-write", "-a", "on-request"],
      effect:
        "Commands write only in the workspace, and the model decides when to ask for more.",
    },
    {
      id: "workspace-never",
      label: "Workspace, never ask",
      args: ["-s", "workspace-write", "-a", "never"],
      effect:
        "Never asks. A command the sandbox blocks fails, and the model is told.",
    },
    {
      id: "workspace-auto-review",
      label: "Workspace, automatic review",
      args: ["--approve-for-me"],
      effect:
        "Uses the workspace-write sandbox and sends approval requests to Codex's automatic review instead of you.",
    },
    {
      id: "full-access",
      label: "Full access",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      effect: "No approval prompts and no sandbox.",
      warning:
        'Codex\'s help says: "Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed".',
    },
  ],
};

const providerName = (provider: Provider) =>
  provider === "claude" ? "Claude Code" : "Codex";

/** The provider's mode, or an error for a mode the provider does not offer in Topsl. */
export function terminalMode(provider: Provider, id: string): TerminalMode {
  const mode = terminalModes[provider]?.find((m) => m.id === id);
  if (!mode)
    throw new Error(
      `${providerName(provider)} has no terminal mode ${JSON.stringify(id)} in Topsl.`,
    );
  return mode;
}

/** Whether a mode needs Topsl's confirmation every time and is never remembered. */
export const isBypassMode = (id: string) =>
  Object.values(terminalModes).some((modes) =>
    modes.some((mode) => mode.id === id && !!mode.warning),
  );

/**
 * The mode Topsl opens a review handoff in: Plan for Claude Code, so the
 * handoff's instruction not to modify the workspace is backed by Claude Code's
 * own rules; otherwise the provider's own settings. Never a bypass mode.
 */
export function handoffTerminalMode(
  provider: Provider,
  role: "builder" | "reviewer",
): TerminalModeId {
  return provider === "claude" && role === "reviewer"
    ? "plan"
    : "provider-default";
}

/** The text of Topsl's confirmation before it starts a terminal in a bypass mode. */
export function bypassConfirmation(
  provider: Provider,
  mode: TerminalMode,
  executable: string,
  folder: string,
): { message: string; detail: string; affirmative: string } {
  if (!mode.warning) throw new Error(`${mode.label} is not a bypass mode.`);
  return {
    message:
      provider === "claude"
        ? "Start Claude Code with permission checks bypassed?"
        : "Start Codex with no approvals and no sandbox?",
    detail: [
      `Executable: ${executable}`,
      `Folder: ${folder}`,
      `Topsl passes: ${mode.args.join(" ")}`,
      "",
      mode.warning,
      "",
      `Topsl asks every time and does not remember this mode. If managed settings turn it off, the terminal shows ${providerName(provider)}'s own message, and Topsl does not try another mode.`,
    ].join("\n"),
    affirmative: `Start in ${mode.label}`,
  };
}
