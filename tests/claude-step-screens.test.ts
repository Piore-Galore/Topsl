import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  claudeStepModel,
  claudeStepProvenanceText,
  teamRole,
  type ClaudeStep,
  type ClaudeStepOpen,
} from "../packages/domain/claude-steps";
import { evaluateStepReadiness } from "../packages/providers/readiness";
import type { Installation } from "../packages/domain/types";
import {
  cancelWait,
  ClaudeStepPanel,
  ClaudeStepsRecord,
  handBackWait,
  holdsFolder,
  openingText,
  stepModeMenu,
} from "../apps/desktop/renderer/components/claude-step";
import {
  claudePairingNote,
  codexPairingNote,
  pairingNote,
} from "../apps/desktop/renderer/components/workflow-setup";

const at = "2026-10-17T00:00:00.000Z";
const opening = (overrides: Partial<ClaudeStepOpen> = {}): ClaudeStepOpen => ({
  sessionId: "8c5ad7a4-6f53-4f3e-9b9e-0a1d2c3b4e5f",
  terminalId: "terminal",
  mode: "provider-default",
  runtimeVersion: "2.1.300",
  executableIdentity: "identity",
  requestedAt: at,
  state: "opened",
  error: null,
  ...overrides,
});
const step = (overrides: Partial<ClaudeStep> = {}): ClaudeStep => ({
  id: "step",
  projectId: "p",
  workflowId: "w",
  attemptId: "step",
  taskId: "task",
  role: "builder",
  installationId: "claude",
  candidateId: "candidate",
  candidateRevision: "a".repeat(64),
  specificationId: "specification",
  contextPackageId: "context",
  instructionsHash: "hash",
  workspaceId: "workspace",
  folder: "/project",
  state: "waiting",
  opens: [],
  replyId: null,
  replySource: null,
  stoppedAt: null,
  detail: "Waiting for the owner to open Claude Code.",
  createdAt: at,
  updatedAt: at,
  ...overrides,
});
/** The text a reader sees in rendered markup. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
const panel = (value: ClaudeStep, terminalId: string | null = null) =>
  renderToStaticMarkup(
    createElement(ClaudeStepPanel, {
      projectId: "p",
      workflow: {
        id: "w",
        claudeStep: value,
        claudeStepTerminalId: terminalId,
      },
      pending: false,
      stopped: false,
      setStopped: () => {},
      run: async () => {},
    }),
  );

describe("the setup screen's teams", () => {
  test("a Claude role is a Claude Code step with no model or effort, and a Codex role keeps its own", () => {
    expect(teamRole("claude", "claude-install", "gpt-5", "high")).toEqual({
      provider: "claude",
      installationId: "claude-install",
      model: claudeStepModel,
      route: "terminal",
    });
    expect(teamRole("codex", "codex-install", "gpt-5", "high")).toEqual({
      provider: "codex",
      installationId: "codex-install",
      model: "gpt-5",
      effort: "high",
    });
    expect(teamRole("codex", "codex-install", "gpt-5", "")).toEqual({
      provider: "codex",
      installationId: "codex-install",
      model: "gpt-5",
    });
  });

  test("a team whose reviewer is the builder's own tool says so, word for word", () => {
    expect(pairingNote("claude", "claude")).toBe(claudePairingNote);
    expect(claudePairingNote).toBe(
      "Claude reviews Claude in a fresh Claude Code session. This is not an independent second model.",
    );
    expect(pairingNote("codex", "codex")).toBe(codexPairingNote);
    expect(pairingNote("claude", "codex")).toBeNull();
    expect(pairingNote("codex", "claude")).toBeNull();
  });
});

describe("a Claude Code step's readiness", () => {
  const claude = {
    id: "claude",
    appId: "anthropic.claude-code-cli",
    trusted: true,
  } as Installation;
  const selection = {
    provider: "claude" as const,
    installationId: "claude",
    model: claudeStepModel,
    route: "terminal" as const,
  };
  test("is ready with a trusted Claude Code installation, and needs no qualification", () => {
    const readiness = evaluateStepReadiness({
      role: "implementer",
      selection,
      installation: claude,
    });
    expect(readiness).toMatchObject({
      role: "implementer",
      mode: "coordinated",
      ready: true,
      blockers: [],
      capabilitiesUsed: [],
      freshness: { state: "missing", bindingId: null },
      nextActions: [],
    });
    expect(readiness.warnings).toEqual([
      "Claude Code runs this step in Topsl's terminal under your login. Signing in, its permission prompts and its billing stay in Claude Code.",
    ]);
  });

  test("is blocked by an untrusted executable, another runtime, or a model or effort Topsl would not pass", () => {
    const blockers = (
      input: Partial<typeof selection> & { effort?: string },
      installation: Partial<Installation> = {},
    ) =>
      evaluateStepReadiness({
        role: "reviewer",
        selection: { ...selection, ...input },
        installation: { ...claude, ...installation },
      }).blockers.map((blocker) => blocker.code);
    expect(blockers({}, { trusted: false })).toEqual(["executable-untrusted"]);
    expect(blockers({}, { appId: "openai.codex-cli" })).toEqual([
      "terminal-route-claude-only",
    ]);
    expect(blockers({ provider: "codex" } as any)).toEqual([
      "terminal-route-claude-only",
    ]);
    expect(blockers({ model: "claude-opus" })).toEqual([
      "unsupported-model-setting",
    ]);
    expect(blockers({ effort: "high" })).toEqual(["unsupported-model-setting"]);
    expect(
      evaluateStepReadiness({
        role: "reviewer",
        selection,
        installation: { ...claude, trusted: false },
      }).ready,
    ).toBe(false);
  });
});

describe("a Claude Code step on the workflow page", () => {
  test("a build offers Bypass, and keeps it, only while auto-accept is Everything; a review opens only in Plan", () => {
    for (const role of ["builder", "repair"] as const) {
      expect(stepModeMenu(role, "off", null)).toEqual({
        mode: "provider-default",
        bypass: false,
      });
      expect(stepModeMenu(role, "sandboxed", null)).toEqual({
        mode: "sandboxed",
        bypass: false,
      });
      expect(stepModeMenu(role, "everything", null)).toEqual({
        mode: "bypass",
        bypass: true,
      });
      expect(stepModeMenu(role, "off", "accept-edits").mode).toBe(
        "accept-edits",
      );
      // A pick of Bypass falls back once auto-accept is no longer Everything.
      expect(stepModeMenu(role, "everything", "bypass").mode).toBe("bypass");
      expect(stepModeMenu(role, "sandboxed", "bypass")).toEqual({
        mode: "sandboxed",
        bypass: false,
      });
      expect(stepModeMenu(role, "off", "bypass").mode).toBe("provider-default");
    }
    for (const level of ["off", "sandboxed", "everything"] as const)
      expect(stepModeMenu("reviewer", level, "accept-edits")).toEqual({
        mode: "plan",
        bypass: false,
      });
  });

  test("a reply is handed back only after Claude Code opened, exited, and the owner confirmed it stopped", () => {
    expect(handBackWait(step(), null, true)).toBe(
      "Open Claude Code for this step first.",
    );
    expect(
      handBackWait(
        step({ opens: [opening({ state: "failed", error: "no" })] }),
        null,
        true,
      ),
    ).toBe("Open Claude Code for this step first.");
    const opened = step({ opens: [opening()] });
    expect(handBackWait(opened, "terminal", true)).toContain(
      "Claude Code is still running in Topsl's terminal.",
    );
    expect(handBackWait(opened, null, false)).toBe(
      "Confirm that Claude Code has stopped.",
    );
    expect(handBackWait(opened, null, true)).toBeNull();
  });

  test("cancelling an opened build or repair takes the same word that Claude Code stopped", () => {
    expect(cancelWait(null, null, false)).toBeNull();
    // Nothing opened yet, so nothing can still be writing.
    expect(cancelWait(step(), null, false)).toBeNull();
    for (const role of ["builder", "repair"] as const) {
      const opened = step({
        role,
        opens: [opening({ state: "failed", error: "no" })],
      });
      expect(holdsFolder(opened)).toBe(true);
      expect(cancelWait(opened, null, false)).toBe(
        "Confirm on the Claude Code step that Claude Code has stopped, then cancel.",
      );
      expect(cancelWait(opened, null, true)).toBeNull();
      expect(cancelWait(opened, "terminal", true)).toBe(
        "Exit Claude Code in Topsl's terminal, then cancel.",
      );
      expect(holdsFolder({ ...opened, state: "returned" })).toBe(false);
    }
    // A review reads a copy, so only a running Claude Code holds it up.
    const review = step({ role: "reviewer", opens: [opening()] });
    expect(holdsFolder(review)).toBe(false);
    expect(cancelWait(review, null, false)).toBeNull();
    expect(cancelWait(review, "terminal", false)).toBe(
      "Exit Claude Code in Topsl's terminal, then cancel.",
    );
  });

  test("each opening shows its session, mode and Claude Code version", () => {
    expect(openingText(opening())).toBe(
      "Session 8c5ad7a4-6f53-4f3e-9b9e-0a1d2c3b4e5f · Provider default (no arguments) · Claude Code 2.1.300 · opened",
    );
    expect(
      openingText(
        opening({
          mode: "plan",
          runtimeVersion: null,
          state: "failed",
          error: "spawn failed",
        }),
      ),
    ).toBe(
      "Session 8c5ad7a4-6f53-4f3e-9b9e-0a1d2c3b4e5f · Plan (--permission-mode plan) · Claude Code version unknown · did not open: spawn failed",
    );
    expect(
      openingText(opening({ mode: "accept-edits", state: "requested" })),
    ).toContain("Accept edits (--permission-mode acceptEdits) · ");
  });

  test("a waiting build says what it needs, offers no Bypass while auto-accept is off, and asks that Claude Code stopped", () => {
    const waiting = text(panel(step()));
    expect(waiting).toContain(
      "Claude Code build Waiting for the owner to open Claude Code.",
    );
    expect(waiting).toContain("Open in Claude Code");
    expect(panel(step())).toContain("Claude Code mode for this build");
    expect(panel(step())).not.toContain('value="bypass"');
    // Nothing to hand back before Claude Code opened.
    expect(waiting).not.toContain("Hand back reply");
    const running = panel(step({ opens: [opening()] }), "terminal");
    expect(text(running)).toContain(
      "Claude Code is still running in Topsl's terminal. Exit it before you hand back its reply.",
    );
    const exited = panel(step({ opens: [opening()] }));
    expect(text(exited)).toContain(
      "Claude Code has stopped: I exited it, and none of its sessions is still working in this folder.",
    );
    expect(text(exited)).toContain("Session 8c5ad7a4");
    expect(exited).toMatch(/<button disabled="">Hand back reply<\/button>/);
    // The transcript read is off, so the owner is told where to turn it on.
    expect(text(exited)).toContain(
      "Turn on Settings → Claude Code transcripts to take the reply from the session's transcript instead of pasting it.",
    );
    // An opening that failed still needs the stopped confirmation to cancel.
    expect(
      text(panel(step({ opens: [opening({ state: "failed", error: "no" })] }))),
    ).toContain("Claude Code has stopped");
    expect(panel(step({ state: "returned" }))).toBe("");
  });

  test("a waiting review opens in Plan in a read-only copy, with no mode to pick", () => {
    const review = panel(step({ role: "reviewer" }));
    expect(text(review)).toContain(
      "Claude Code review Waiting for the owner to open Claude Code. Opens in Plan, in a read-only copy of the build.",
    );
    expect(review).not.toContain("<select");
  });

  test("every step lists where its replies came from and what Topsl did with each", () => {
    const record = text(
      renderToStaticMarkup(
        createElement(ClaudeStepsRecord, {
          steps: [
            {
              ...step({
                state: "returned",
                replySource: "claude-transcript",
                opens: [opening({ mode: "accept-edits" })],
              }),
              replies: [
                {
                  id: "r1",
                  source: "claude-transcript",
                  outcome: "taken",
                  detail: "Topsl took Claude's reply.",
                  receivedAt: at,
                },
              ],
            },
            {
              ...step({
                id: "review",
                role: "reviewer",
                state: "stale",
                replySource: "owner-paste",
                opens: [opening({ mode: "plan" })],
              }),
              replies: [
                {
                  id: "r2",
                  source: "owner-paste",
                  outcome: "invalid",
                  detail: "Topsl did not take this reply: it is not JSON.",
                  receivedAt: at,
                },
                {
                  id: "r3",
                  source: "owner-paste",
                  outcome: "stale",
                  detail: "The workflow no longer waits on this step.",
                  receivedAt: at,
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(record).toContain(
      "Each ran in Claude Code in Topsl's terminal, under your control.",
    );
    expect(record).toContain(
      "Build · reply taken · reply read from its session's transcript",
    );
    expect(record).toContain("Accept edits (--permission-mode acceptEdits)");
    expect(record).toContain(
      "Taken · reply read from its session's transcript: Topsl took Claude's reply.",
    );
    expect(record).toContain(
      "Review · reply kept as evidence, not used · reply pasted by you",
    );
    expect(record).toContain(
      "Not taken · reply pasted by you: Topsl did not take this reply: it is not JSON.",
    );
    expect(record).toContain(
      "Kept as evidence · reply pasted by you: The workflow no longer waits on this step.",
    );
    expect(
      renderToStaticMarkup(createElement(ClaudeStepsRecord, { steps: [] })),
    ).toBe("");
  });

  test("acceptance names each step's session, mode and version, and whether its reply was pasted", () => {
    expect(
      claudeStepProvenanceText({
        role: "builder",
        replySource: "claude-transcript",
        sessionId: "s1",
        mode: "accept-edits",
        runtimeVersion: "2.1.300",
      }),
    ).toBe(
      "Claude Code build: reply read from its session's transcript · session s1 · Accept edits · Claude Code 2.1.300",
    );
    expect(
      claudeStepProvenanceText({
        role: "reviewer",
        replySource: "owner-paste",
        sessionId: null,
        mode: null,
        runtimeVersion: null,
      }),
    ).toBe(
      "Claude Code review: reply pasted by you · session unknown · mode unknown · Claude Code version unknown",
    );
  });
});
