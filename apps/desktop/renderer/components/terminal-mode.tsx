import {
  terminalModes,
  type TerminalMode,
  type TerminalModeId,
} from "../../../../packages/domain/terminal-modes";
import type {
  Installation,
  Provider,
  TerminalModePreference,
} from "../../../../packages/domain/types";

/** The provider of a native command-line installation. */
export const terminalProvider = (installation: Installation): Provider =>
  installation.appId.includes("claude") ? "claude" : "codex";

/** The provider's mode with this id, if it offers one. */
export const findTerminalMode = (
  provider: Provider,
  id: string | null | undefined,
): TerminalMode | undefined =>
  terminalModes[provider].find((mode) => mode.id === id);

/** The mode the project last opened this provider's terminal in, never a bypass mode. */
export function rememberedTerminalMode(
  preferences: TerminalModePreference[],
  projectId: string,
  provider: Provider,
): TerminalModeId {
  const mode = findTerminalMode(
    provider,
    preferences.find((preference) => preference.id === projectId)?.[provider],
  );
  return mode && !mode.warning ? mode.id : "provider-default";
}

/** How a terminal's mode reads in Topsl: its name and the arguments passed. */
export function terminalModeText(mode: TerminalMode): string {
  return mode.args.length
    ? `${mode.label} (${mode.args.join(" ")})`
    : `${mode.label} (no arguments)`;
}

/**
 * The provider's own permission modes for a native terminal. Bypass modes sit
 * under Advanced; Topsl asks the owner to confirm them in its own dialog.
 */
export function TerminalModeSelect({
  provider,
  value,
  onChange,
}: {
  provider: Provider;
  value: TerminalModeId;
  onChange: (mode: TerminalModeId) => void;
}) {
  const modes = terminalModes[provider];
  return (
    <label className="terminal-mode">
      Terminal mode
      <select
        value={(findTerminalMode(provider, value) ?? modes[0]).id}
        onChange={(event) => onChange(event.target.value as TerminalModeId)}
      >
        {modes
          .filter((mode) => !mode.warning)
          .map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        <optgroup label="Advanced">
          {modes
            .filter((mode) => mode.warning)
            .map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
        </optgroup>
      </select>
    </label>
  );
}

/** What Topsl passes for the selected mode, and what the provider says it does. */
export function TerminalModeNote({
  provider,
  value,
}: {
  provider: Provider;
  value: TerminalModeId;
}) {
  const mode = findTerminalMode(provider, value) ?? terminalModes[provider][0];
  return (
    <p className="tiny terminal-mode-note">
      {mode.args.length > 0 && (
        <>
          Passes <code>{mode.args.join(" ")}</code>.{" "}
        </>
      )}
      {mode.effect}
      {mode.warning &&
        " Topsl asks you to confirm every time and does not remember it."}
    </p>
  );
}
