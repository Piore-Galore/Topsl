/**
 * Campaign 2026-10-19 packet p5a-build-review-candidates (plan §5.15 BW-21, BW-13, BW-04).
 *
 * builder-reviewer-cancel while a Claude Code terminal step waits, through
 * Service.command with the terminal stand-in (tests/fixtures/terminal-stand-in.cjs
 * in a real PTY) and the Codex JSON-RPC workflow stand-in. Covers the
 * still-running terminal gate, a stale revision, the omitted stopped
 * confirmation for an opened build, the reviewer exemption, and a late hand-back
 * after cancellation. No Claude Code installation or account is used.
 */
import path from "node:path";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { identity, nativeEnvironment } from "../packages/platform/system";
import type {
  Conversation,
  Installation,
  ServiceEvent,
} from "../packages/domain/types";
import type { ExecutionAttempt } from "../packages/domain/workflow";
import { now, uid } from "../packages/domain/invariants";
import {
  claudeStepModel,
  type ClaudeStep,
} from "../packages/domain/claude-steps";
import type { BuilderReviewerState } from "../packages/workflows/builder-reviewer";
import type { CandidateSnapshot } from "../packages/workflows/candidates";
import { claudeRoutePreferenceId } from "../packages/domain/claude-route";
import { commandSchema } from "../packages/domain/commands";
import { fixture } from "./helpers";

class FixtureCodex extends CodexAdapter {
  override capabilities(installation: Installation) {
    return super.capabilities(installation).map((capability) => ({
      ...capability,
      support: "enforceable" as const,
      testedPlatforms: ["fixture"],
      evidence: {
        ...capability.evidence,
        detail: "Dependency-injected local fixture only",
      },
    }));
  }
}
const folderLine = /Stand-in folder: ("[^\r\n]*")\r*\n/;

const services: Service[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** The claude-steps.test.ts harness, reduced to what cancellation needs. */
async function setup() {
  const f = await fixture();
  f.store.close();
  directories.push(f.directory);
  const output = new Map<string, string>(),
    project = path.join(f.directory, "project");
  await mkdir(project);
  await writeFile(path.join(project, "file.ts"), "export const value = 1;\n");
  const start = async () => {
    const service = new Service(
      f.directory,
      f.key,
      (event: ServiceEvent) => {
        if (event.type === "terminal")
          output.set(
            event.data.id,
            (output.get(event.data.id) ?? "") + event.data.data,
          );
      },
      true,
      {
        codex: new FixtureCodex(
          (_executable, cwd) =>
            new RpcPeer(
              process.execPath,
              [path.resolve("tests/fixtures/codex-workflow.cjs")],
              cwd,
              nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
            ),
        ),
      },
    );
    services.push(service);
    return service;
  };
  let service = await start();
  const wrapper = path.join(f.directory, "claude-stand-in");
  await writeFile(
    wrapper,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/terminal-stand-in.cjs"))} "$@"\n`,
  );
  await chmod(wrapper, 0o700);
  const claude: Installation = {
    ...f.installation,
    path: wrapper,
    ...(await identity(wrapper)),
    id: "claude",
    appId: "anthropic.claude-code-cli",
    version: "2.1.300",
    compatibility: "native-only",
  };
  service.store.put("project", {
    id: "p",
    name: "Claude step cancel fixture",
    path: project,
    realPath: project,
    trusted: true,
    createdAt: now(),
  });
  service.store.put("installation", f.installation);
  service.store.put("installation", claude);
  await service.start();
  const roles = {
    claude: {
      provider: "claude" as const,
      installationId: "claude",
      model: claudeStepModel,
      route: "terminal" as const,
    },
    codex: {
      provider: "codex" as const,
      installationId: f.installation.id,
      model: "fixture-requested",
    },
  };
  const revision = (id: string) =>
    service.store.get<{ revision: number }>("workflow", id)!.revision;
  const run = async (
    builder: keyof typeof roles,
    reviewer: keyof typeof roles,
  ): Promise<string> => {
    const state: BuilderReviewerState = await service.command({
      type: "builder-reviewer-create",
      requestId: uid(),
      projectId: "p",
      objective: "value two",
      acceptanceCriteria: ["value equals two"],
      interfaces: [],
      builder: roles[builder],
      reviewer: roles[reviewer],
      selectedPaths: ["file.ts"],
      approvedUntracked: [],
      maxRepairs: 2,
      requireIndependence: false,
      checks: [
        {
          id: "required",
          label: "actual captured value",
          executable: process.execPath,
          args: [
            "-e",
            'if(!require("fs").readFileSync("file.ts","utf8").includes("value = 2"))process.exit(1)',
          ],
          timeoutMs: 30_000,
        },
      ],
    });
    await service.command(
      {
        type: "builder-reviewer-advance",
        requestId: uid(),
        id: state.id,
        expectedRevision: revision(state.id),
      },
      {
        digest: (service.review("workflow-dispatch-inputs", state.id) as any)
          .digest,
      },
    );
    return state.id;
  };
  const workflow = (id: string) =>
    service.store.get<BuilderReviewerState>("builder-reviewer", id)!;
  const step = (id: string) =>
    service.store.get<ClaudeStep>("claude-step", workflow(id).activeAttemptId!);
  const stage = (id: string, expected: BuilderReviewerState["stage"]) =>
    vi.waitFor(() => expect(workflow(id).stage).toBe(expected), {
      timeout: 10_000,
    });
  const read = async (id: string, pattern: RegExp) => {
    await vi.waitFor(() => expect(output.get(id) ?? "").toMatch(pattern), {
      timeout: 10_000,
    });
    return output.get(id)!;
  };
  const open = async (id: string) => {
    const opened = await service.command({
      type: "claude-step-open",
      projectId: "p",
      workflowId: id,
      stepId: step(id)!.id,
    });
    await read(opened.terminalId, folderLine);
    return opened as { terminalId: string; sessionId: string };
  };
  const exit = async (terminalId: string) => {
    await service.command({
      type: "terminal-input",
      id: terminalId,
      data: "q\r",
    });
    await read(terminalId, /Native session exited: 0/);
    await vi.waitFor(
      () =>
        expect(
          service.runtime.terminalState().some((t) => t.id === terminalId),
        ).toBe(false),
      { timeout: 10_000 },
    );
  };
  const cancel = (
    id: string,
    options: { expectedRevision?: number; stopped?: boolean } = {},
  ) =>
    service.command({
      type: "builder-reviewer-cancel",
      requestId: uid(),
      id,
      expectedRevision: options.expectedRevision ?? revision(id),
      ...(options.stopped ? { claudeCodeStopped: true as const } : {}),
    });
  const handBack = (id: string, stepId: string, reply: string) =>
    service.command({
      type: "claude-step-return",
      projectId: "p",
      workflowId: id,
      stepId,
      reply,
      source: "owner-paste",
      claudeCodeStopped: true,
    });
  const accept = (id: string) =>
    service.command(
      {
        type: "builder-reviewer-accept",
        requestId: uid(),
        id,
        expectedRevision: revision(id),
      },
      { digest: (service.review("workflow-acceptance", id) as any).digest },
    );
  /** A Codex chat edit turn in the project, which a held folder refuses. */
  const chatEdit = () => {
    const conversation: Conversation = {
      id: uid(),
      projectId: "p",
      title: "chat",
      nativeSessions: {},
      createdAt: now(),
    };
    service.store.save("conversation", conversation);
    return service.runtime.start(
      f.installation,
      conversation,
      service.store.get<any>("project", "p"),
      "hello",
      "fixture-requested",
      "edit",
    );
  };
  return {
    ...f,
    chatEdit,
    get service() {
      return service;
    },
    project,
    run,
    revision,
    workflow,
    step,
    stage,
    open,
    exit,
    cancel,
    handBack,
    accept,
    restart: async () => {
      await service.close();
      service = await start();
      await service.start();
    },
  };
}

describe.skipIf(process.platform === "win32")(
  "BW-21 cancel, BW-13 finding decisions and BW-04 route with Claude Code steps (service)",
  () => {
    test("BW-21: an opened Claude build refuses cancel while its terminal runs, at a stale revision, and without the stopped confirmation; confirmed cancel ends it and a late hand-back cannot land or accept, even after restart", async () => {
      const f = await setup();
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      const waiting = f.step(id)!;
      const opened = await f.open(id);
      // Still running: refused even with the owner's word.
      await expect(f.cancel(id, { stopped: true })).rejects.toThrow(
        "Claude Code is still running in Topsl's terminal for this step.",
      );
      expect(f.workflow(id).stage).toBe("building");
      expect(f.step(id)).toMatchObject({ id: waiting.id, state: "waiting" });
      await f.exit(opened.terminalId);
      // BW-06: after exit, a hand-back without the stopped confirmation is refused
      // by the service (and by the command schema).
      const unconfirmed = {
        type: "claude-step-return" as const,
        projectId: "p",
        workflowId: id,
        stepId: waiting.id,
        reply: "Changed the value.",
        source: "owner-paste" as const,
      };
      await expect(f.service.command(unconfirmed as never)).rejects.toThrow(
        "Confirm that Claude Code has stopped",
      );
      expect(() =>
        commandSchema.parse({ ...unconfirmed, claudeCodeStopped: false }),
      ).toThrow();
      expect(f.step(id)).toMatchObject({ state: "waiting", replyId: null });
      // Claude Code changed the folder before the owner cancelled.
      await writeFile(
        path.join(f.project, "file.ts"),
        "export const value = 2;\n",
      );
      await expect(
        f.cancel(id, { expectedRevision: f.revision(id) - 1, stopped: true }),
      ).rejects.toThrow("Workflow changed");
      await expect(f.cancel(id)).rejects.toThrow(
        "Confirm that it has stopped to cancel this workflow.",
      );
      expect(f.workflow(id).stage).toBe("building");
      await expect(f.chatEdit()).rejects.toThrow(
        "A workflow's Claude Code step holds this project folder",
      );
      expect((await f.cancel(id, { stopped: true })).stage).toBe("cancelled");
      const ended = f.service.store.get<ClaudeStep>("claude-step", waiting.id)!;
      expect(ended.state).toBe("cancelled");
      expect(ended.stoppedAt).toBeTruthy();
      expect(
        f.service.store.get<ExecutionAttempt>("attempt", waiting.attemptId),
      ).toMatchObject({ state: "interrupted" });
      expect(f.service.store.get<any>("workflow", id).state).toBe("cancelled");
      expect(f.service.store.get("check-workflow-cancelled", id)).toBeTruthy();
      // The late reply is refused and leaves no evidence that could be accepted.
      await expect(
        f.handBack(id, waiting.id, "Changed the value to two."),
      ).rejects.toThrow("This Claude Code step has already ended.");
      expect(f.service.store.list("claude-step-reply")).toEqual([]);
      expect(
        f.service.store
          .list<CandidateSnapshot>("candidate")
          .some((c) => c.authorAttemptId === waiting.attemptId),
      ).toBe(false);
      await expect(f.accept(id)).rejects.toThrow("Acceptance is stale");
      // The cancelled build no longer holds the folder.
      await expect(f.chatEdit()).resolves.toBeTruthy();
      // A restart does not resurrect the cancelled step or workflow.
      await f.restart();
      expect(f.workflow(id).stage).toBe("cancelled");
      expect(
        f.service.store.get<ClaudeStep>("claude-step", waiting.id)!.state,
      ).toBe("cancelled");
      await expect(
        f.service.command({
          type: "builder-reviewer-advance",
          requestId: uid(),
          id,
          expectedRevision: f.revision(id),
        }),
      ).rejects.toThrow();
      expect(f.service.store.get<any>("workflow", id).acceptance).toBeNull();
    });

    test("BW-21: a waiting Claude build that was never opened cancels without the stopped confirmation and cannot be opened afterwards", async () => {
      const f = await setup();
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      const waiting = f.step(id)!;
      expect(waiting.opens).toEqual([]);
      expect((await f.cancel(id)).stage).toBe("cancelled");
      const ended = f.service.store.get<ClaudeStep>("claude-step", waiting.id)!;
      expect(ended).toMatchObject({ state: "cancelled", stoppedAt: null });
      expect(
        f.service.store.get<ExecutionAttempt>("attempt", waiting.attemptId),
      ).toMatchObject({ state: "interrupted" });
      const runs = f.service.store.list("run").length;
      await expect(
        f.service.command({
          type: "claude-step-open",
          projectId: "p",
          workflowId: id,
          stepId: waiting.id,
        }),
      ).rejects.toThrow();
      expect(f.service.store.list("run")).toHaveLength(runs);
      await expect(f.chatEdit()).resolves.toBeTruthy();
    });

    test("BW-21: a Claude review step refuses cancel while its terminal runs, then cancels without the stopped confirmation, removes its copy, and a late review cannot land", async () => {
      const f = await setup();
      const id = await f.run("codex", "claude");
      await f.stage(id, "reviewing");
      await vi.waitFor(() => expect(f.step(id)?.role).toBe("reviewer"), {
        timeout: 10_000,
      });
      const waiting = f.step(id)!;
      expect(existsSync(waiting.folder)).toBe(true);
      const opened = await f.open(id);
      await expect(f.cancel(id)).rejects.toThrow(
        "Claude Code is still running in Topsl's terminal for this step.",
      );
      await f.exit(opened.terminalId);
      // A review reads a copy, so no stopped confirmation is required.
      expect((await f.cancel(id)).stage).toBe("cancelled");
      expect(
        f.service.store.get<ClaudeStep>("claude-step", waiting.id),
      ).toMatchObject({ state: "cancelled", stoppedAt: null });
      expect(existsSync(waiting.folder)).toBe(false);
      await expect(
        f.handBack(
          id,
          waiting.id,
          JSON.stringify({
            candidateRevision: waiting.candidateRevision,
            summary: "Reviewed.",
            findings: [],
          }),
        ),
      ).rejects.toThrow("This Claude Code step has already ended.");
      expect(f.workflow(id)).toMatchObject({
        stage: "cancelled",
        reviewArtifactId: null,
        checkTaskId: null,
      });
      expect(f.service.store.list("workflow-finding")).toEqual([]);
      await expect(f.accept(id)).rejects.toThrow("Acceptance is stale");
    });
    test("BW-13: through the service, a Claude review's finding takes only a current, scoped, nonblank decision at the current head, and the review itself is never edited", async () => {
      const f = await setup();
      const id = await f.run("codex", "claude");
      await vi.waitFor(() => expect(f.step(id)?.role).toBe("reviewer"), {
        timeout: 10_000,
      });
      const waiting = f.step(id)!;
      await f.exit((await f.open(id)).terminalId);
      expect(
        (
          await f.handBack(
            id,
            waiting.id,
            JSON.stringify({
              candidateRevision: waiting.candidateRevision,
              summary: "One finding.",
              findings: [
                {
                  title: "Value claim",
                  severity: "low",
                  file: "file.ts",
                  line: 1,
                  behavior: "The reviewer believes two is wrong.",
                  evidence: "export const value = 2;",
                },
              ],
            }),
          )
        ).outcome,
      ).toBe("taken");
      await f.stage(id, "ready-repair");
      const state = f.workflow(id),
        findingId = state.findings[0],
        original = f.service.store.get("workflow-finding", findingId);
      const decide = (change: Record<string, unknown> = {}) =>
        f.service.command({
          type: "workflow-finding-decide",
          requestId: uid(),
          projectId: "p",
          id,
          expectedRevision: f.revision(id),
          findingId,
          candidateId: state.candidateId,
          decision: "rejected",
          rationale: "The required check defines two as correct.",
          expectedDecisionId: null,
          ...change,
        } as any);
      const refusals: Array<[Record<string, unknown>, string]> = [
        [{ projectId: "other" }, "another project"],
        [{ expectedRevision: f.revision(id) - 1 }, "Workflow changed"],
        [{ rationale: " \n " }, "nonempty rationale"],
        [
          { candidateId: state.baselineId },
          "current, completed candidate review",
        ],
        [
          { findingId: "unknown-finding" },
          "current, completed candidate review",
        ],
        [{ expectedDecisionId: "invented" }, "Refresh before adjudicating"],
      ];
      for (const [change, message] of refusals)
        await expect(decide(change), JSON.stringify(change)).rejects.toThrow(
          message,
        );
      expect(f.service.store.list("workflow-finding-decision")).toEqual([]);
      expect(f.workflow(id).stage).toBe("ready-repair");
      const decided = await decide();
      expect(decided.stage).toBe("checking");
      expect(f.service.store.list<any>("workflow-finding-decision")).toEqual([
        expect.objectContaining({
          findingId,
          candidateId: state.candidateId,
          decision: "rejected",
          actor: "local-user",
          previousDecisionId: null,
        }),
      ]);
      // Repeating the same decision is refused once checks began.
      await expect(decide()).rejects.toThrow();
      expect(f.service.store.list("workflow-finding-decision")).toHaveLength(1);
      expect(f.service.store.get("workflow-finding", findingId)).toEqual(
        original,
      );
      // No repair was dispatched by the decision.
      expect(
        f.service.store
          .list<ClaudeStep>("claude-step")
          .filter((step) => step.workflowId === id),
      ).toHaveLength(1);
    });
    test("BW-04: turning on Claude's structured route while a Claude-built workflow is in draft does not switch its build away from the owner-run terminal step", async () => {
      const f = await setup();
      // Saved as a draft first, then the owner turns the structured route on.
      await f.service.command({
        type: "workflow-draft-save",
        requestId: uid(),
        projectId: "p",
        workflowId: null,
        expectedRevision: 0,
        draft: {
          objective: "value two",
          criteria: "value equals two",
          interfaces: "",
          builder: "claude",
          reviewer: "codex",
          builderRuntime: "claude",
          reviewerRuntime: "",
          builderModel: "",
          reviewerModel: "",
          builderEffort: "",
          reviewerEffort: "",
          environmentRecipeId: "",
          selectedPaths: "file.ts",
          approvedUntracked: "",
          checkExecutable: "",
          checkArguments: [],
          step: 2,
        },
      });
      f.service.store.put("preference", {
        id: claudeRoutePreferenceId,
        value: true,
        decidedAt: now(),
      });
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      const waiting = f.step(id)!;
      expect(waiting).toMatchObject({
        role: "builder",
        state: "waiting",
        opens: [],
      });
      expect(
        f.service.store.get<ExecutionAttempt>("attempt", waiting.attemptId),
      ).toMatchObject({
        provider: "claude",
        state: "prepared",
        requestedModel: null,
      });
      // Topsl started no Claude turn of its own.
      expect(f.service.store.list("run")).toEqual([]);
      expect(f.workflow(id).builder).toMatchObject({ route: "terminal" });
    });
  },
);
