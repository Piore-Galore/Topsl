import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ActionButton } from "./action-button";

/** Each native terminal's output so far, so a panel shown later starts with it. */
const outputs = new Map<string, string>();
/** Keeps a terminal's output; the window records every terminal event here. */
export function recordTerminalOutput(id: string, data: string): void {
  outputs.set(id, ((outputs.get(id) ?? "") + data).slice(-262144));
}
const terminalOutput = (id: string): string => outputs.get(id) ?? "";

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: color("--terminal-bg"),
    foreground: color("--terminal-fg"),
    cursor: color("--terminal-cursor"),
    selectionBackground: "#668d9a66",
    black: "#9db0b8",
    red: "#ffaba0",
    green: "#b4d6ae",
    yellow: "#e3ca8a",
    blue: "#9dc7eb",
    magenta: "#d7b4dc",
    cyan: "#a1d9d8",
    white: "#eee5d5",
    brightBlack: "#a3b7be",
    brightRed: "#ffc1b8",
    brightGreen: "#c3e8bd",
    brightYellow: "#f7dea0",
    brightBlue: "#b7dbfa",
    brightMagenta: "#ecd0f0",
    brightCyan: "#bcebea",
    brightWhite: "#fff9ed",
  };
}

export function TerminalPanel({
  id,
  mode,
  close,
}: {
  id: string;
  /** The permission mode Topsl asked for, if any. */
  mode: string | null;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: "Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 3000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(ref.current!);
    fit.fit();
    const repaint = () => {
      terminal.options.theme = terminalTheme();
    };
    const appearance = matchMedia("(prefers-color-scheme: dark)");
    appearance.addEventListener("change", repaint);
    const themeChanges = new MutationObserver(repaint);
    themeChanges.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    // The output so far, read just before subscribing below, so output that
    // arrived after the panel rendered is not lost.
    terminal.write(terminalOutput(id));
    terminal.parser.registerOscHandler(52, () => true); // Native output cannot write the system clipboard.
    const input = terminal.onData((data) => {
      void window.topsl
        .command({ type: "terminal-input", id, data })
        .catch(() => {});
    });
    const resize = new ResizeObserver(() => {
      if (!ref.current?.clientWidth || !ref.current?.clientHeight) return;
      fit.fit();
      void window.topsl
        .command({
          type: "terminal-resize",
          id,
          cols: Math.max(20, terminal.cols),
          rows: Math.max(5, terminal.rows),
        })
        .catch(() => {});
    });
    resize.observe(ref.current!);
    const unsubscribe = window.topsl.subscribe((e) => {
      if (e.type === "terminal" && e.data.id === id)
        terminal.write(e.data.data);
    });
    return () => {
      unsubscribe();
      resize.disconnect();
      themeChanges.disconnect();
      appearance.removeEventListener("change", repaint);
      input.dispose();
      terminal.dispose();
    };
  }, [id]);
  return (
    <section className="terminal-panel" data-session-id={id}>
      <div className="terminal-heading">
        <span>
          Native session{mode ? ` · ${mode}` : ""} · native permissions and
          billing · output stays in memory
        </span>
        <ActionButton onClick={close}>Close session</ActionButton>
      </div>
      <div
        className="terminal"
        ref={ref}
        role="region"
        aria-label="Native terminal"
      />
    </section>
  );
}
