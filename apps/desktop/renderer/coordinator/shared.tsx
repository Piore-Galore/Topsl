import { useEffect, useRef, useState } from "react";
import type { Command } from "../../../../packages/domain/commands";
import type { GoalCheckDefinition } from "../../../../packages/domain/role-groups";

export const label = (v: string) =>
  v
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/^./, (c) => c.toUpperCase());
export const newCommandId = () => `ui-${crypto.randomUUID()}`;

/** Goal states after which a goal takes no more steering. */
export const endedGoal = (state: string) =>
  ["stopped", "accepted", "completed"].includes(state);

export const stateTone: Record<string, string> = {
  active: "good",
  running: "good",
  completed: "good",
  accepted: "good",
  monitoring: "",
  planning: "",
  reviewing: "",
  waiting: "warm",
  paused: "warm",
  suspended: "warm",
  stopping: "warm",
  blocked: "warm",
  checking: "warm",
  "awaiting-acceptance": "warm",
  stopped: "",
};

export type Run = (key: string, command: Command) => Promise<any>;

/**
 * Re-reads a screen when the application state changes, at most every two
 * seconds. Runtime qualification and model catalogs are not project records,
 * so project change events do not carry them; a coordinator picker opened
 * before a runtime qualified would otherwise keep showing it as unavailable.
 */
export function useRuntimeRefresh(refresh: () => unknown) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.topsl.subscribe((event: { type: string }) => {
      if (event.type !== "state" || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void latest.current();
      }, 2000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);
}

/**
 * Runs owner commands for one screen: each command's error is kept under its
 * key, and a result that arrives after the screen changed (another project
 * or thread) neither refreshes nor reports.
 */
export function useCommandRunner(refresh: () => Promise<void>, scope: string) {
  const generation = useRef(0);
  const latest = useRef(refresh);
  latest.current = refresh;
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    generation.current++;
    setErrors({});
  }, [scope]);
  const run: Run = async (key, command) => {
    const ticket = generation.current;
    setErrors((current) => ({ ...current, [key]: "" }));
    try {
      const result = await window.topsl.command(command);
      if (ticket === generation.current) await latest.current();
      return result;
    } catch (error: any) {
      if (ticket === generation.current)
        setErrors((current) => ({ ...current, [key]: error.message }));
    }
  };
  return { run, errors };
}

export function Errors({ errors }: { errors: Record<string, string> }) {
  return (
    <>
      {Object.entries(errors)
        .filter(([, e]) => e)
        .map(([k, e]) => (
          <p key={k} role="alert">
            {e}
          </p>
        ))}
    </>
  );
}

export interface CheckDraft {
  label: string;
  executable: string;
  args: string;
  timeoutSeconds: string;
}
export const emptyCheck: CheckDraft = {
  label: "",
  executable: "",
  args: "",
  timeoutSeconds: "120",
};
/** One required check from the form, or none when the executable is empty. */
export function checksFrom(draft: CheckDraft): GoalCheckDefinition[] {
  if (!draft.executable.trim()) return [];
  return [
    {
      id: "required-check",
      label: draft.label.trim() || "Required project check",
      executable: draft.executable.trim(),
      args: draft.args.split("\n").filter((line) => line.length),
      timeoutMs: Math.round(Number(draft.timeoutSeconds || "120") * 1000),
    },
  ];
}

export function CheckFields({
  draft,
  setDraft,
}: {
  draft: CheckDraft;
  setDraft: (draft: CheckDraft) => void;
}) {
  return (
    <div className="check-fields">
      <label>
        Check name{" "}
        <input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Required project check"
        />
      </label>
      <label>
        Executable (absolute path){" "}
        <input
          value={draft.executable}
          onChange={(e) => setDraft({ ...draft, executable: e.target.value })}
          placeholder="/usr/local/bin/npm"
        />
      </label>
      <label>
        Arguments, one per line{" "}
        <textarea
          rows={2}
          value={draft.args}
          onChange={(e) => setDraft({ ...draft, args: e.target.value })}
        />
      </label>
      <label>
        Timeout (seconds){" "}
        <input
          type="number"
          min={1}
          max={300}
          value={draft.timeoutSeconds}
          onChange={(e) =>
            setDraft({ ...draft, timeoutSeconds: e.target.value })
          }
        />
      </label>
    </div>
  );
}
