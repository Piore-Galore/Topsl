import {
  chatPreset,
  chatPresetNote,
  type ChatPreset,
  type CodexApprovalPolicy,
} from "./chat-presets";
import { terminalModes, type TerminalModeId } from "./terminal-modes";
import type { Provider } from "./types";

/**
 * Topsl's auto-accept setting, from the provider permissions plan's follow-up
 * of 17 October 2026. It decides who answers when Codex or Claude Code would
 * ask for permission in a session Topsl starts for editing. It is off until
 * the owner turns it on in Settings and confirms it in Topsl's own dialog.
 * Reviews stay read-only at every level.
 */
export const autoAcceptLevels = ["off", "sandboxed", "everything"] as const;
export type AutoAcceptLevel = (typeof autoAcceptLevels)[number];

/** The preference that holds the setting. */
export const autoAcceptPreferenceId = "auto-accept";

export interface AutoAcceptOption {
  level: AutoAcceptLevel;
  label: string;
  /** What the level does, as Settings says it. */
  effect: string;
}

export const autoAcceptOptions: readonly AutoAcceptOption[] = [
  {
    level: "off",
    label: "Off",
    effect:
      "You answer each request Codex makes, and each terminal opens in the mode you pick.",
  },
  {
    level: "sandboxed",
    label: "Sandboxed",
    effect:
      "Nobody is asked about work inside the sandbox. Codex's edit turns, in chats and workflow builds, run with no asking: commands write only in the workspace, without network, and a command the sandbox blocks fails. Terminals open in Codex's Workspace, never ask and in Claude Code's Sandboxed edits.",
  },
  {
    level: "everything",
    label: "Everything",
    effect:
      "Topsl allows every request Codex makes during an edit turn, including commands outside its sandbox, and notes each one in the conversation. Terminals open in Codex's Full access and Claude Code's Bypass, with no prompts and no sandbox, and Topsl still confirms each of those terminals.",
  },
];

/** The level with this id, or off for a value Topsl does not know. */
export const autoAcceptLevel = (value: unknown): AutoAcceptLevel =>
  autoAcceptLevels.find((level) => level === value) ?? "off";

/** The mode each provider's terminal opens in for editing while auto-accept is on. */
export const autoAcceptTerminalModes: Readonly<
  Record<
    Exclude<AutoAcceptLevel, "off">,
    Readonly<Record<Provider, TerminalModeId>>
  >
> = {
  sandboxed: { claude: "sandboxed", codex: "workspace-never" },
  everything: { claude: "bypass", codex: "full-access" },
};

/** The mode a terminal for editing opens in at this level, or null while auto-accept is off. */
export const autoAcceptTerminalMode = (
  level: AutoAcceptLevel,
  provider: Provider,
): TerminalModeId | null =>
  level === "off" ? null : autoAcceptTerminalModes[level][provider];

/**
 * The approval policy Topsl sends for a Codex turn. While auto-accept is
 * Sandboxed, an edit turn runs with no asking where the runtime can use it;
 * otherwise Topsl sends the policy the turn asked for.
 */
export const autoAcceptPolicy = (
  level: AutoAcceptLevel,
  mode: "review" | "edit",
  requested: CodexApprovalPolicy,
  noAskingAvailable: boolean,
): CodexApprovalPolicy =>
  level === "sandboxed" && mode === "edit" && noAskingAvailable
    ? "never"
    : requested;

/**
 * What a Codex chat with this preset does under auto-accept, as the composer
 * says it, or null when auto-accept changes nothing about it. `noAskingBlocked`
 * is why the runtime cannot use No asking now, if it cannot.
 */
export function autoAcceptChatNote(
  level: AutoAcceptLevel,
  preset: ChatPreset,
  noAskingBlocked?: string,
): string | null {
  if (level === "off" || preset.approvalPolicy === "never") return null;
  if (preset.mode === "review")
    return `${chatPresetNote(preset)} Auto-accept does not change reviews.`;
  if (level === "everything")
    return "Auto-accept is Everything, so Topsl allows every request Codex makes, and an allowed command may run outside the workspace sandbox with your own access. Topsl notes each one in this chat.";
  return noAskingBlocked
    ? `Auto-accept is Sandboxed, but this runtime cannot run without asking yet, so Codex asks you as before. ${noAskingBlocked}`
    : `Auto-accept is Sandboxed, so Topsl sends this with no asking. ${chatPresetNote(chatPreset("edit-never"))}`;
}

const modeLabel = (provider: Provider, id: TerminalModeId) =>
  terminalModes[provider].find((mode) => mode.id === id)!.label;

/** The text of Topsl's confirmation before it turns auto-accept on at this level. */
export function autoAcceptConfirmation(
  level: Exclude<AutoAcceptLevel, "off">,
): { message: string; detail: string; affirmative: string } {
  const terminals = autoAcceptTerminalModes[level],
    opened = `Terminals Topsl opens for editing start in Codex's ${modeLabel("codex", terminals.codex)} and Claude Code's ${modeLabel("claude", terminals.claude)}`;
  if (level === "sandboxed")
    return {
      message: "Turn on auto-accept for work inside the sandbox?",
      detail: [
        "Codex's edit turns, in chats and workflow builds, run with no asking: commands write only in the workspace, without network, and a command the sandbox blocks fails. This needs a runtime whose current qualification saw its sandbox block a write outside the workspace. On any other runtime, Codex's chats ask you as before.",
        "",
        `${opened}, which turns Claude Code's sandbox on and accepts edits in the project. You can still pick another mode for each terminal.`,
        "",
        "Reviews stay read-only, and managed settings can override either provider.",
      ].join("\n"),
      affirmative: "Turn on Sandboxed",
    };
  return {
    message: "Let Topsl allow everything Codex and Claude Code ask for?",
    detail: [
      "Topsl will allow every request Codex makes during an edit turn, in chats and workflow builds, without asking you. An allowed command may run outside Codex's sandbox with your own access. Topsl notes each request it allowed in the conversation.",
      "",
      `${opened}, with no prompts and no sandbox. Topsl still confirms each of those terminals, and Claude Code asks its own question the first time.`,
      "",
      ...(["codex", "claude"] as const).map(
        (provider) =>
          terminalModes[provider].find(
            (mode) => mode.id === terminals[provider],
          )!.warning!,
      ),
      "",
      "Codex and Claude Code can then change anything your account can, and text in a file or a web page can steer them. Reviews stay read-only.",
    ].join("\n"),
    affirmative: "Allow everything",
  };
}
