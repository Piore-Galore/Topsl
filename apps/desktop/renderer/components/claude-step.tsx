import { useEffect, useState } from "react";
import {
  claudeReplySourceText,
  claudeStepMode,
  claudeStepNoun,
  type ClaudeStep,
  type ClaudeStepOpen,
  type ClaudeStepReply,
  type ClaudeStepReplySource,
  type ClaudeStepRole,
} from "../../../../packages/domain/claude-steps";
import type { AutoAcceptLevel } from "../../../../packages/domain/auto-accept";
import {
  isBypassMode,
  type TerminalModeId,
} from "../../../../packages/domain/terminal-modes";
import {
  findTerminalMode,
  terminalModeText,
  TerminalModeNote,
  TerminalModeSelect,
} from "./terminal-mode";
import { TerminalPanel } from "./terminal-panel";

type StepView = ClaudeStep & {
  replies: Array<
    Pick<ClaudeStepReply, "id" | "source" | "outcome" | "detail" | "receivedAt">
  >;
};
const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);

/** The window's auto-accept level and transcript setting, kept current. */
function useClaudeSettings() {
  const [settings, setSettings] = useState<{
    autoAccept: AutoAcceptLevel;
    claudeTranscriptRead: boolean;
  }>({ autoAccept: "off", claudeTranscriptRead: false });
  useEffect(() => {
    let alive = true;
    const apply = (state: any) => {
      if (alive && state && !state.locked)
        setSettings({
          autoAccept: state.autoAccept ?? "off",
          claudeTranscriptRead: state.claudeTranscriptRead === true,
        });
    };
    void window.topsl
      .command({ type: "state" })
      .then(apply)
      .catch(() => {});
    const unsubscribe = window.topsl.subscribe((event) => {
      if (event.type === "state") apply(event.data);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return settings;
}

/**
 * The mode a step's menu shows, and whether it offers Bypass. A review opens
 * only in Plan. A build or repair opens in the owner's pick, else in
 * auto-accept's mode while it is on, else with nothing passed; Bypass is
 * offered, and kept, only while auto-accept is Everything.
 */
export function stepModeMenu(
  role: ClaudeStepRole,
  level: AutoAcceptLevel,
  choice: TerminalModeId | null,
): { mode: TerminalModeId; bypass: boolean } {
  const bypass = role !== "reviewer" && level === "everything";
  return {
    mode:
      role !== "reviewer" && choice && (!isBypassMode(choice) || bypass)
        ? choice
        : claudeStepMode(role, level),
    bypass,
  };
}

/** Whether the step is an opened build or repair, which may still be writing in the folder. */
export const holdsFolder = (step: ClaudeStep | null) =>
  !!step &&
  step.state === "waiting" &&
  step.role !== "reviewer" &&
  step.opens.length > 0;

/**
 * Why the owner cannot hand back the step's reply yet, or null once they can:
 * Claude Code opened for it, has exited, and the owner confirmed it stopped.
 */
export function handBackWait(
  step: ClaudeStep,
  terminalId: string | null,
  stopped: boolean,
): string | null {
  if (!step.opens.some((open) => open.state === "opened"))
    return "Open Claude Code for this step first.";
  if (terminalId)
    return "Claude Code is still running in Topsl's terminal. Exit it before you hand back its reply.";
  if (!stopped) return "Confirm that Claude Code has stopped.";
  return null;
}

/**
 * Why cancelling must wait on the workflow's Claude Code step, if it must:
 * while Claude Code runs in its terminal, and, for an opened build or repair,
 * until the owner confirms Claude Code stopped, as the service requires.
 */
export function cancelWait(
  step: ClaudeStep | null,
  terminalId: string | null,
  stopped: boolean,
): string | null {
  if (terminalId) return "Exit Claude Code in Topsl's terminal, then cancel.";
  if (holdsFolder(step) && !stopped)
    return "Confirm on the Claude Code step that Claude Code has stopped, then cancel.";
  return null;
}

/** One opening of Claude Code as the workflow page lists it. */
export function openingText(open: ClaudeStepOpen): string {
  const mode = findTerminalMode("claude", open.mode);
  return [
    `Session ${open.sessionId}`,
    mode ? terminalModeText(mode) : open.mode,
    `Claude Code ${open.runtimeVersion ?? "version unknown"}`,
    open.state === "opened"
      ? "opened"
      : open.state === "failed"
        ? `did not open: ${open.error ?? "unknown error"}`
        : "opening",
  ].join(" · ");
}

const stepState: Record<ClaudeStep["state"], string> = {
  waiting: "waiting for you",
  returned: "reply taken",
  stale: "reply kept as evidence, not used",
  cancelled: "cancelled",
};
const replyOutcome: Record<ClaudeStepReply["outcome"], string> = {
  taken: "Taken",
  invalid: "Not taken",
  stale: "Kept as evidence",
};

/**
 * The Claude Code step a workflow waits on: what it needs, the button that
 * copies its instructions and opens Claude Code in Topsl's terminal, that
 * terminal while it runs, and the hand-back of Claude's final reply once the
 * owner confirms Claude Code stopped.
 */
export function ClaudeStepPanel({
  projectId,
  workflow,
  pending,
  stopped,
  setStopped,
  run,
}: {
  projectId: string;
  workflow: {
    id: string;
    claudeStep: ClaudeStep | null;
    claudeStepTerminalId: string | null;
  };
  pending: boolean;
  /** The owner's confirmation that Claude Code has stopped, which cancelling also takes. */
  stopped: boolean;
  setStopped: (stopped: boolean) => void;
  run: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const settings = useClaudeSettings(),
    step = workflow.claudeStep,
    [choice, setChoice] = useState<TerminalModeId | null>(null),
    [reply, setReply] = useState(""),
    [instructions, setInstructions] = useState("");
  useEffect(() => {
    setChoice(null);
    setReply("");
    setInstructions("");
  }, [step?.id]);
  if (!step || step.state !== "waiting") return null;
  const noun = claudeStepNoun[step.role],
    review = step.role === "reviewer",
    { mode, bypass } = stepModeMenu(step.role, settings.autoAccept, choice),
    terminalId = workflow.claudeStepTerminalId,
    running = findTerminalMode(
      "claude",
      step.opens.find((open) => open.terminalId === terminalId)?.mode,
    ),
    handable = !handBackWait(step, terminalId, stopped) && !pending;
  async function handBack(source: ClaudeStepReplySource) {
    await run(async () => {
      const result = await window.topsl.command({
        type: "claude-step-return",
        projectId,
        workflowId: workflow.id,
        stepId: step!.id,
        ...(source === "owner-paste" ? { reply } : {}),
        source,
        claudeCodeStopped: true,
      });
      if (result?.outcome === "taken") setReply("");
    });
  }
  return (
    <section
      className="claude-step"
      aria-label={`Claude Code ${noun}`}
      data-step={step.id}
    >
      <h4>Claude Code {noun}</h4>
      <p role="status">{step.detail}</p>
      {review ? (
        <p>
          Opens in Plan, in a read-only copy of the build. Claude Code asks
          whether to trust each new copy.
        </p>
      ) : (
        <>
          <TerminalModeSelect
            provider="claude"
            value={mode}
            onChange={setChoice}
            label={`Claude Code mode for this ${noun}`}
            advanced={bypass}
          />
          <TerminalModeNote provider="claude" value={mode} />
        </>
      )}
      <button
        type="button"
        disabled={pending || !!terminalId}
        onClick={() =>
          void run(async () => {
            const result = await window.topsl.command({
              type: "claude-step-open",
              projectId,
              workflowId: workflow.id,
              stepId: step.id,
              ...(review ? {} : { permissionMode: mode }),
            });
            // Nothing opened when the owner declined Topsl's confirmation.
            if (!result) return;
            setStopped(false);
            setInstructions(result.instructions);
          })
        }
      >
        Open in Claude Code
      </button>
      {instructions && (
        <details>
          <summary>
            Topsl copied the instructions. Paste them into Claude Code.
          </summary>
          <pre tabIndex={0}>{instructions}</pre>
        </details>
      )}
      {step.opens.length > 0 && (
        <ul className="claude-step-opens" aria-label="Claude Code sessions">
          {step.opens.map((open) => (
            <li key={open.sessionId}>{openingText(open)}</li>
          ))}
        </ul>
      )}
      {terminalId && (
        <TerminalPanel
          key={terminalId}
          id={terminalId}
          mode={running ? terminalModeText(running) : null}
          close={() =>
            void run(() =>
              window.topsl.command({ type: "terminal-close", id: terminalId }),
            )
          }
        />
      )}
      {step.opens.length > 0 && (
        <form
          className="claude-step-return"
          onSubmit={(event) => {
            event.preventDefault();
            void handBack("owner-paste");
          }}
        >
          {terminalId && (
            <p>
              Claude Code is still running in Topsl's terminal. Exit it before
              you hand back its reply.
            </p>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={stopped}
              onChange={(event) => setStopped(event.target.checked)}
            />
            Claude Code has stopped: I exited it, and none of its sessions is
            still working in this folder.
          </label>
          <label>
            Claude's final reply
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />
          </label>
          <div className="workflow-actions">
            <button disabled={!handable || !reply.trim()}>
              Hand back reply
            </button>
            {settings.claudeTranscriptRead && (
              <button
                type="button"
                disabled={!handable}
                onClick={() => void handBack("claude-transcript")}
              >
                Take reply from transcript
              </button>
            )}
          </div>
          {!settings.claudeTranscriptRead && (
            <p className="muted">
              Turn on Settings → Claude Code transcripts to take the reply from
              the session's transcript instead of pasting it.
            </p>
          )}
        </form>
      )}
    </section>
  );
}

/**
 * Every Claude Code step of a workflow, oldest first: its sessions, each with
 * its mode and Claude Code version, and each reply handed back, with where it
 * came from and what Topsl did with it.
 */
export function ClaudeStepsRecord({ steps }: { steps: StepView[] }) {
  if (!steps.length) return null;
  return (
    <section className="claude-steps" aria-label="Claude Code steps">
      <h4>Claude Code steps</h4>
      <p className="muted">
        Each ran in Claude Code in Topsl's terminal, under your control.
      </p>
      <ol>
        {steps.map((step) => (
          <li key={step.id} data-step={step.id}>
            <strong>{capitalized(claudeStepNoun[step.role])}</strong> ·{" "}
            {stepState[step.state]}
            {step.replySource &&
              ` · reply ${claudeReplySourceText[step.replySource]}`}
            {(step.opens.length > 0 || step.replies.length > 0) && (
              <ul>
                {step.opens.map((open) => (
                  <li key={open.sessionId}>{openingText(open)}</li>
                ))}
                {step.replies.map((handed) => (
                  <li key={handed.id}>
                    {replyOutcome[handed.outcome]} · reply{" "}
                    {claudeReplySourceText[handed.source]}: {handed.detail}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
