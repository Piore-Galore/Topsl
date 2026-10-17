import path from "node:path";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { identity, nativeEnvironment } from "../packages/platform/system";
import type {
  Conversation,
  Installation,
  Run,
  ServiceEvent,
} from "../packages/domain/types";
import type { ExecutionAttempt } from "../packages/domain/workflow";
import { now, uid } from "../packages/domain/invariants";
import {
  claudeStepMode,
  claudeStepModel,
  type ClaudeStep,
  type ClaudeStepReply,
} from "../packages/domain/claude-steps";
import {
  terminalMode,
  terminalModeIds,
} from "../packages/domain/terminal-modes";
import type {
  BuilderReviewerState,
  RoleAssignment,
} from "../packages/workflows/builder-reviewer";
import type { CandidateSnapshot } from "../packages/workflows/candidates";
import { createTaskContext } from "../packages/context/packages";
import { claudeTranscriptShapes } from "../packages/history/claude-transcript";
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
/** The lines in which the terminal stand-in reports how it was started. */
const argumentsLine = /Stand-in arguments: (\[[^\r\n]*\])\r*\n/,
  folderLine = /Stand-in folder: ("[^\r\n]*")\r*\n/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const services: Service[] = [],
  directories: string[] = [],
  configDirectory = process.env.CLAUDE_CONFIG_DIR;
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDirectory;
});

/**
 * A service whose Codex is the workflow stand-in and whose Claude Code is the
 * terminal stand-in, with a project folder holding file.ts.
 */
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
    name: "Claude step fixture",
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
  /** Creates and starts a workflow for this team, as the owner approves it. */
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
  const revision = (id: string) =>
    service.store.get<{ revision: number }>("workflow", id)!.revision;
  /** The step the workflow waits on now. */
  const step = (id: string) =>
    service.store.get<ClaudeStep>("claude-step", workflow(id).activeAttemptId!);
  const stage = (id: string, expected: BuilderReviewerState["stage"]) =>
    vi.waitFor(() => expect(workflow(id).stage).toBe(expected), {
      timeout: 10_000,
    });
  /** Waits until the terminal has written text matching the pattern. */
  const read = async (id: string, pattern: RegExp) => {
    await vi.waitFor(() => expect(output.get(id) ?? "").toMatch(pattern), {
      timeout: 10_000,
    });
    return output.get(id)!;
  };
  /** Opens the step the workflow waits on, as the owner's button does. */
  const open = async (
    id: string,
    options: {
      permissionMode?: (typeof terminalModeIds)[number];
      confirmed?: (typeof terminalModeIds)[number];
    } = {},
  ) => {
    const opened = await service.command(
      {
        type: "claude-step-open",
        projectId: "p",
        workflowId: id,
        stepId: step(id)!.id,
        ...(options.permissionMode
          ? { permissionMode: options.permissionMode }
          : {}),
      },
      options.confirmed ? { confirmedTerminalMode: options.confirmed } : {},
    );
    const text = await read(opened.terminalId, folderLine);
    return {
      ...opened,
      args: JSON.parse(argumentsLine.exec(text)![1]) as string[],
      cwd: JSON.parse(folderLine.exec(text)![1]) as string,
    };
  };
  /** Exits Claude Code in its terminal and waits until Topsl saw it exit. */
  const exit = async (terminalId: string) => {
    // The terminal passes a line on at Enter.
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
  /** Hands back Claude's final reply, confirming Claude Code stopped. */
  const handBack = (id: string, reply: string) =>
    service.command({
      type: "claude-step-return",
      projectId: "p",
      workflowId: id,
      stepId: step(id)!.id,
      reply,
      source: "owner-paste",
      claudeCodeStopped: true,
    });
  /** Hands back the step for Topsl to read Claude's reply from its transcript. */
  const fromTranscript = (id: string) =>
    service.command({
      type: "claude-step-return",
      projectId: "p",
      workflowId: id,
      stepId: step(id)!.id,
      source: "claude-transcript",
      claudeCodeStopped: true,
    });
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
    get service() {
      return service;
    },
    project,
    claude,
    run,
    workflow,
    revision,
    step,
    stage,
    read,
    open,
    exit,
    handBack,
    fromTranscript,
    chatEdit,
    /** Closes Topsl and starts it again on the same profile. */
    restart: async () => {
      await service.close();
      service = await start();
      await service.start();
    },
  };
}
const review = (candidateRevision: string, findings: unknown[] = []) =>
  JSON.stringify({ candidateRevision, summary: "Reviewed.", findings });
/**
 * Claude Code's transcript of a step's session in `config`, in the record
 * shapes Topsl recognizes: the pasted instructions, Claude's reply, and the
 * owner's /exit.
 */
async function writeTranscript(
  config: string,
  session: { sessionId: string; cwd: string; instructions: string },
  reply: string,
): Promise<string> {
  const folder = path.join(
      config,
      "projects",
      session.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    ),
    file = path.join(folder, `${session.sessionId}.jsonl`),
    record = (type: "user" | "assistant", content: unknown) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        userType: "external",
        cwd: session.cwd,
        sessionId: session.sessionId,
        version: "2.1.300",
        type,
        message: { role: type, content },
        uuid: uid(),
        timestamp: now(),
      }) + "\n";
  await mkdir(folder, { recursive: true });
  await writeFile(
    file,
    record("user", session.instructions) +
      record("assistant", [{ type: "text", text: reply }]) +
      record("user", "<command-name>/exit</command-name>"),
  );
  return file;
}

describe("a Claude Code step's mode", () => {
  test("a review opens only in Plan, and a build in Bypass only while auto-accept is Everything", () => {
    for (const level of ["off", "sandboxed", "everything"] as const) {
      expect(claudeStepMode("reviewer", level)).toBe("plan");
      expect(claudeStepMode("reviewer", level, "plan")).toBe("plan");
      for (const requested of [
        "accept-edits",
        "bypass",
        "provider-default",
      ] as const)
        expect(() => claudeStepMode("reviewer", level, requested)).toThrow(
          "A Claude Code review opens only in Plan",
        );
    }
    for (const role of ["builder", "repair"] as const) {
      expect(claudeStepMode(role, "off")).toBe("provider-default");
      expect(claudeStepMode(role, "sandboxed")).toBe("sandboxed");
      expect(claudeStepMode(role, "everything")).toBe("bypass");
      expect(claudeStepMode(role, "off", "accept-edits")).toBe("accept-edits");
      expect(claudeStepMode(role, "everything", "plan")).toBe("plan");
      for (const level of ["off", "sandboxed"] as const)
        expect(() => claudeStepMode(role, level, "bypass")).toThrow(
          "only while auto-accept is Everything",
        );
      expect(() => claudeStepMode(role, "off", "full-access")).toThrow(
        'Claude Code has no terminal mode "full-access" in Topsl.',
      );
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "Claude Code steps through the service",
  () => {
    test("Claude builds and Codex reviews: the build waits for the owner, opens with a session id, and ends on the owner's reply", async () => {
      const f = await setup();
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      const waiting = f.step(id)!;
      expect(waiting).toMatchObject({
        role: "builder",
        state: "waiting",
        folder: f.project,
        opens: [],
      });
      expect(f.workflow(id).detail).toContain("Waiting for Claude Code.");
      const attempt = f.service.store.get<ExecutionAttempt>(
        "attempt",
        waiting.attemptId,
      )!;
      // The step is the stage's turn, which Topsl itself does not run.
      expect(attempt).toMatchObject({
        provider: "claude",
        state: "prepared",
        requestedModel: null,
      });
      expect(f.service.store.list<Run>("run")).toEqual([]);
      // The instructions carry the specification and no file excerpts.
      const instructions = f.service.store.get<any>(
        "task-context-package",
        waiting.contextPackageId,
      ).content;
      expect(instructions).toContain("Role: builder");
      expect(instructions).toContain("Objective: value two");
      expect(instructions).toContain("1. value equals two");
      expect(instructions).toContain(
        "End with a concise description of your changes",
      );
      expect(instructions).not.toContain("export const value = 1;");
      expect(instructions).not.toContain("complete text");
      // No Topsl-run writer starts while the build holds the folder.
      await expect(f.chatEdit()).rejects.toThrow(
        "A workflow's Claude Code step holds this project folder",
      );
      // A reply comes from a session Topsl opened.
      await expect(f.handBack(id, "Changed the value.")).rejects.toThrow(
        "Open Claude Code for this step in Topsl's terminal before handing back its reply.",
      );

      const opened = await f.open(id);
      expect(opened.sessionId).toMatch(uuid);
      expect(opened.instructions).toBe(instructions);
      // Claude Code's own settings decide its mode, so only the session id is passed.
      expect(opened.args).toEqual(["--session-id", opened.sessionId]);
      expect(await realpath(opened.cwd)).toBe(await realpath(f.project));
      expect(f.service.store.get<Run>("run", opened.terminalId)).toMatchObject({
        provider: "claude",
        mode: "native",
        permissionMode: "provider-default",
        permissionArgs: [],
        nativeSessionId: opened.sessionId,
      });
      expect(f.step(id)!.opens).toEqual([
        expect.objectContaining({
          sessionId: opened.sessionId,
          terminalId: opened.terminalId,
          mode: "provider-default",
          runtimeVersion: "2.1.300",
          executableIdentity: f.claude.identity,
          state: "opened",
        }),
      ]);
      // The reply waits until Claude Code has exited.
      await expect(f.handBack(id, "Changed the value.")).rejects.toThrow(
        "Claude Code is still running in Topsl's terminal for this step.",
      );
      // An exit without a reply leaves the step waiting, still holding the folder.
      await f.exit(opened.terminalId);
      expect(f.workflow(id).stage).toBe("building");
      expect(f.step(id)).toMatchObject({ state: "waiting", stoppedAt: null });
      await expect(f.chatEdit()).rejects.toThrow(
        "A workflow's Claude Code step holds this project folder",
      );

      // Claude Code changed the file, and the owner hands back its reply.
      await writeFile(
        path.join(f.project, "file.ts"),
        "export const value = 2;\n",
      );
      const result = await f.handBack(id, "Changed the value to two.");
      expect(result.outcome).toBe("taken");
      await f.stage(id, "checking");
      const ended = f.service.store.get<ClaudeStep>("claude-step", waiting.id)!;
      expect(ended).toMatchObject({
        state: "returned",
        replySource: "owner-paste",
      });
      expect(ended.stoppedAt).toBeTruthy();
      expect(
        f.service.store.get<ClaudeStepReply>(
          "claude-step-reply",
          ended.replyId!,
        ),
      ).toMatchObject({
        source: "owner-paste",
        text: "Changed the value to two.",
        outcome: "taken",
      });
      expect(
        f.service.store.get<ExecutionAttempt>("attempt", waiting.attemptId),
      ).toMatchObject({ state: "completed" });
      // Topsl captured the folder as the build, and Codex reviewed that build.
      const state = f.workflow(id),
        candidate = f.service.store.get<CandidateSnapshot>(
          "candidate",
          state.candidateId,
        )!;
      expect(candidate.authorAttemptId).toBe(waiting.attemptId);
      expect(
        candidate.files.find((file) => file.path === "file.ts")?.change,
      ).not.toBe("unchanged");
      expect(state.reviewedCandidateId).toBe(state.candidateId);
      // The hold ended with the reply.
      expect(f.service.runtime.isProjectBusy("p")).toBe(false);
    });

    test("Codex builds and Claude reviews: the review opens in Plan in a read-only copy, and waits until its reply is a review of that build", async () => {
      const f = await setup();
      const id = await f.run("codex", "claude");
      await f.stage(id, "reviewing");
      await vi.waitFor(() => expect(f.step(id)?.role).toBe("reviewer"), {
        timeout: 10_000,
      });
      const waiting = f.step(id)!,
        state = f.workflow(id),
        candidate = f.service.store.get<CandidateSnapshot>(
          "candidate",
          state.candidateId,
        )!;
      expect(waiting.candidateRevision).toBe(candidate.revision);
      expect(await realpath(waiting.folder)).not.toBe(
        await realpath(f.project),
      );
      // A review step does not hold the project folder.
      expect(f.service.store.list<Run>("run").length).toBeGreaterThan(0);
      const instructions = f.service.store.get<any>(
        "task-context-package",
        waiting.contextPackageId,
      ).content;
      expect(instructions).toContain("Role: reviewer");
      expect(instructions).toContain(
        `"candidateRevision":"${candidate.revision}"`,
      );
      expect(instructions).toContain("its files and folders are read-only");
      expect(instructions).toContain("do not run commands that write files");
      expect(instructions).not.toContain("export const value = 2;");

      const opened = await f.open(id);
      expect(opened.args).toEqual([
        "--permission-mode",
        "plan",
        "--session-id",
        opened.sessionId,
      ]);
      expect(await realpath(opened.cwd)).toBe(await realpath(waiting.folder));
      // The copy holds the build, and neither its files nor its folders can change.
      expect(await readFile(path.join(waiting.folder, "file.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect((await stat(waiting.folder)).mode & 0o777).toBe(0o500);
      expect(
        (await stat(path.join(waiting.folder, "file.ts"))).mode & 0o222,
      ).toBe(0);
      await f.exit(opened.terminalId);

      // A reply Topsl cannot take leaves the step waiting, and says why.
      for (const [reply, why] of [
        ["The build looks right.", "it is not one JSON object"],
        [review("another-build"), "not this build's"],
        [
          review(candidate.revision, [
            {
              title: "Wrong",
              severity: "high",
              file: "file.ts",
              line: 9,
              behavior: "b",
              evidence: "e",
            },
          ]),
          'finding 1 names "file.ts" line 9',
        ],
        [
          JSON.stringify({ candidateRevision: candidate.revision }),
          "does not match the review format",
        ],
      ] as const) {
        const result = await f.handBack(id, reply);
        expect(result.outcome, reply).toBe("invalid");
        expect(result.detail, reply).toContain(why);
        expect(result.detail).toContain("The step keeps waiting");
        expect(f.workflow(id).stage).toBe("reviewing");
        expect(f.step(id)!.state).toBe("waiting");
      }
      expect(
        f.service.store
          .list<ClaudeStepReply>("claude-step-reply")
          .map((reply) => reply.outcome),
      ).toEqual(["invalid", "invalid", "invalid", "invalid"]);

      const result = await f.handBack(id, review(candidate.revision));
      expect(result.outcome).toBe("taken");
      await f.stage(id, "checking");
      expect(f.workflow(id).reviewArtifactId).toBeTruthy();
      // The copy is removed once Topsl checked it.
      expect(existsSync(waiting.folder)).toBe(false);
    });

    test("Claude builds and Claude reviews: two steps, each in its own folder and mode", async () => {
      const f = await setup();
      const id = await f.run("claude", "claude");
      await f.stage(id, "building");
      const build = await f.open(id);
      expect(build.args).toEqual(["--session-id", build.sessionId]);
      await writeFile(
        path.join(f.project, "file.ts"),
        "export const value = 2;\n",
      );
      await f.exit(build.terminalId);
      expect((await f.handBack(id, "Done.")).outcome).toBe("taken");
      await f.stage(id, "reviewing");
      const reviewStep = f.step(id)!;
      expect(reviewStep.role).toBe("reviewer");
      const opened = await f.open(id);
      expect(opened.args).toEqual([
        "--permission-mode",
        "plan",
        "--session-id",
        opened.sessionId,
      ]);
      expect(opened.sessionId).not.toBe(build.sessionId);
      await f.exit(opened.terminalId);
      expect(
        (await f.handBack(id, review(reviewStep.candidateRevision))).outcome,
      ).toBe("taken");
      await f.stage(id, "checking");
    });

    test("a review whose copy changed is blocked, even with a valid reply", async () => {
      const f = await setup();
      const id = await f.run("codex", "claude");
      await vi.waitFor(() => expect(f.step(id)?.role).toBe("reviewer"), {
        timeout: 10_000,
      });
      const waiting = f.step(id)!;
      const opened = await f.open(id);
      await f.exit(opened.terminalId);
      // Something wrote in the copy despite its read-only folders.
      await chmod(waiting.folder, 0o700);
      await writeFile(path.join(waiting.folder, "notes.md"), "changed\n");
      const result = await f.handBack(id, review(waiting.candidateRevision));
      expect(result.outcome).toBe("taken");
      expect(result.state.stage).toBe("blocked");
      expect(result.state.detail).toContain("Review proof failed");
      expect(f.workflow(id).reviewArtifactId).toBeNull();
      expect(existsSync(waiting.folder)).toBe(false);
    });

    test("a reply that arrives after the specification changed is kept as evidence, and the workflow stops", async () => {
      const f = await setup();
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      const waiting = f.step(id)!;
      await f.exit((await f.open(id)).terminalId);
      await f.service.command({
        type: "builder-reviewer-specification-publish",
        requestId: uid(),
        id,
        expectedRevision: f.revision(id),
        objective: "value three",
        acceptanceCriteria: ["value equals three"],
        interfaces: [],
      });
      // Restarting would replace the step, so it waits for the reply or a cancel.
      const head = f.service.revisions.head(
        "p",
        `workflow-specification:${id}`,
      )!.revisionId;
      await expect(
        f.service.command({
          type: "builder-reviewer-specification-restart",
          requestId: uid(),
          id,
          expectedRevision: f.revision(id),
          specificationId: head,
        }),
      ).rejects.toThrow("Hand back this Claude Code step's reply");
      const result = await f.handBack(id, "Changed the value.");
      expect(result.outcome).toBe("stale");
      expect(result.detail).toContain(
        "The specification changed during this Claude Code build.",
      );
      expect(f.workflow(id)).toMatchObject({
        stage: "blocked",
        activeAttemptId: null,
      });
      expect(
        f.service.store.get<ClaudeStep>("claude-step", waiting.id),
      ).toMatchObject({
        state: "stale",
      });
      expect(
        f.service.store.list<ClaudeStepReply>("claude-step-reply"),
      ).toEqual([
        expect.objectContaining({
          outcome: "stale",
          text: "Changed the value.",
        }),
      ]);
      // The stale build holds the folder no longer.
      await expect(f.chatEdit()).resolves.toBeTruthy();
    });

    test("one writer at a time: a build step opens only while nothing else writes, and holds the folder until its reply", async () => {
      const f = await setup();
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      // An owner's own terminal in the folder keeps the step from opening.
      const terminalId: string = await f.service.command({
        type: "terminal-open",
        projectId: "p",
        installationId: "claude",
        login: false,
        permissionMode: "provider-default",
      });
      await f.read(terminalId, folderLine);
      const runs = f.service.store.list<Run>("run").length;
      await expect(f.open(id)).rejects.toThrow(
        "Stop and reconcile the current managed/native writer before opening Claude Code for this step.",
      );
      expect(f.service.store.list<Run>("run").length).toBe(runs);
      expect(f.step(id)!.opens).toEqual([]);
      await f.exit(terminalId);
      // Another workflow's build, by Claude Code or Codex, waits while this step holds the folder.
      const held =
        "Waiting for capacity: another workflow's Claude Code build holds this project folder";
      const second = await f.run("claude", "codex"),
        third = await f.run("codex", "codex");
      for (const other of [second, third])
        await vi.waitFor(
          () =>
            expect(f.workflow(other)).toMatchObject({
              stage: "ready-build",
              activeAttemptId: null,
              detail: expect.stringContaining(held),
            }),
          { timeout: 10_000 },
        );
      // Each retry while it waits changes its revision, so cancel at the latest one.
      await vi.waitFor(
        () =>
          f.service.command({
            type: "builder-reviewer-cancel",
            requestId: uid(),
            id: third,
            expectedRevision: f.revision(third),
          }),
        { timeout: 10_000 },
      );
      expect(f.workflow(third).stage).toBe("cancelled");
      const opened = await f.open(id);
      await f.exit(opened.terminalId);
      // Cancelling an opened build takes the owner's word that Claude Code stopped.
      await expect(
        f.service.command({
          type: "builder-reviewer-cancel",
          requestId: uid(),
          id,
          expectedRevision: f.revision(id),
        }),
      ).rejects.toThrow("Confirm that it has stopped to cancel this workflow.");
      await f.service.command({
        type: "builder-reviewer-cancel",
        requestId: uid(),
        id,
        expectedRevision: f.revision(id),
        claudeCodeStopped: true,
      });
      expect(f.workflow(id).stage).toBe("cancelled");
      const cancelled = f.service.store
        .list<ClaudeStep>("claude-step")
        .find((step) => step.workflowId === id)!;
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.stoppedAt).toBeTruthy();
      expect(
        f.service.store.get<ExecutionAttempt>("attempt", cancelled.attemptId),
      ).toMatchObject({ state: "interrupted" });
      // The waiting workflow's build starts once the folder is free.
      await f.stage(second, "building");
      const next = await f.open(second);
      expect(next.args).toEqual(["--session-id", next.sessionId]);
      await f.exit(next.terminalId);
    });

    test("no bypass mode reaches a Claude step, except a build under Everything after the owner confirmed it", async () => {
      const f = await setup();
      const id = await f.run("claude", "claude");
      await f.stage(id, "building");
      await expect(f.open(id, { permissionMode: "bypass" })).rejects.toThrow(
        "only while auto-accept is Everything",
      );
      await f.service.command(
        { type: "auto-accept-set", level: "sandboxed" },
        { confirmedAutoAccept: "sandboxed" },
      );
      const sandboxed = await f.open(id);
      expect(sandboxed.args).toEqual([
        ...terminalMode("claude", "sandboxed").args,
        "--session-id",
        sandboxed.sessionId,
      ]);
      await f.exit(sandboxed.terminalId);
      // The owner may pick another ordinary mode.
      const acceptEdits = await f.open(id, { permissionMode: "accept-edits" });
      expect(acceptEdits.args).toEqual([
        "--permission-mode",
        "acceptEdits",
        "--session-id",
        acceptEdits.sessionId,
      ]);
      await f.exit(acceptEdits.terminalId);
      await f.service.command(
        { type: "auto-accept-set", level: "everything" },
        { confirmedAutoAccept: "everything" },
      );
      // Refused before the opening is recorded, without Topsl's confirmation of Bypass.
      const opens = f.step(id)!.opens.length,
        runs = f.service.store.list<Run>("run").length;
      for (const confirmed of [undefined, "plan", "full-access"] as const)
        await expect(f.open(id, { confirmed })).rejects.toThrow(
          "Bypass needs your confirmation in Topsl's own dialog each time.",
        );
      expect(f.step(id)!.opens.length).toBe(opens);
      expect(f.service.store.list<Run>("run").length).toBe(runs);
      const bypass = await f.open(id, { confirmed: "bypass" });
      expect(bypass.args).toEqual([
        "--permission-mode",
        "bypassPermissions",
        "--session-id",
        bypass.sessionId,
      ]);
      await f.exit(bypass.terminalId);
      await writeFile(
        path.join(f.project, "file.ts"),
        "export const value = 2;\n",
      );
      await f.handBack(id, "Done.");
      await f.stage(id, "reviewing");
      // A review keeps Plan under Everything, and no other mode.
      for (const permissionMode of ["bypass", "accept-edits"] as const)
        await expect(
          f.open(id, { permissionMode, confirmed: "bypass" }),
        ).rejects.toThrow("A Claude Code review opens only in Plan");
      const plan = await f.open(id, { confirmed: "bypass" });
      expect(plan.args).toEqual([
        "--permission-mode",
        "plan",
        "--session-id",
        plan.sessionId,
      ]);
      await f.exit(plan.terminalId);
      // Every terminal Topsl opened for a step, and the mode it passed.
      expect(
        f.service.store
          .list<ClaudeStep>("claude-step")
          .flatMap((step) => step.opens.map((open) => ({ step, open })))
          .sort((a, b) => a.open.requestedAt.localeCompare(b.open.requestedAt))
          .map(({ step, open }) => [step.role, open.mode]),
      ).toEqual([
        ["builder", "sandboxed"],
        ["builder", "accept-edits"],
        ["builder", "bypass"],
        ["reviewer", "plan"],
      ]);
    });

    test("a waiting step survives a restart of Topsl and still holds the folder", async () => {
      const f = await setup();
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      const waiting = f.step(id)!;
      const opened = await f.open(id);
      await f.exit(opened.terminalId);
      await f.restart();
      // Recovery marks running attempts uncertain, but a step runs nothing itself.
      expect(
        f.service.store.get<ExecutionAttempt>("attempt", waiting.attemptId),
      ).toMatchObject({ state: "prepared" });
      expect(f.step(id)).toMatchObject({ id: waiting.id, state: "waiting" });
      await expect(f.chatEdit()).rejects.toThrow(
        "A workflow's Claude Code step holds this project folder",
      );
      await writeFile(
        path.join(f.project, "file.ts"),
        "export const value = 2;\n",
      );
      expect((await f.handBack(id, "Done after a restart.")).outcome).toBe(
        "taken",
      );
      await f.stage(id, "checking");
    });

    test("a Claude role names no model or effort, and only Claude Code runs as a step", async () => {
      const f = await setup();
      const create = (builder: RoleAssignment) =>
        f.service.command({
          type: "builder-reviewer-create",
          requestId: uid(),
          projectId: "p",
          objective: "value two",
          acceptanceCriteria: ["value equals two"],
          interfaces: [],
          builder,
          reviewer: {
            provider: "codex",
            installationId: f.installation.id,
            model: "fixture-requested",
          },
          selectedPaths: ["file.ts"],
          approvedUntracked: [],
          maxRepairs: 2,
          requireIndependence: false,
          checks: [
            {
              id: "required",
              label: "check",
              executable: process.execPath,
              args: ["-e", ""],
              timeoutMs: 30_000,
            },
          ],
        });
      await expect(
        create({
          provider: "claude",
          installationId: "claude",
          model: "opus",
          route: "terminal",
        }),
      ).rejects.toThrow("Topsl passes a Claude Code step no model or effort");
      await expect(
        create({
          provider: "claude",
          installationId: "claude",
          model: claudeStepModel,
          effort: "high",
          route: "terminal",
        }),
      ).rejects.toThrow("Topsl passes a Claude Code step no model or effort");
      await expect(
        create({
          provider: "codex",
          installationId: f.installation.id,
          model: "fixture-requested",
          route: "terminal",
        }),
      ).rejects.toThrow("Only Claude Code runs as a step in Topsl's terminal");
    });
  },
);

test("a terminal step's instructions carry no file excerpts, and say where the files are", async () => {
  const f = await fixture();
  directories.push(f.directory);
  const specification = {
      id: "spec",
      workflowId: "w",
      projectId: "p",
      objective: "Change the value",
      acceptanceCriteria: ["The value is two"],
      interfaces: [],
      revision: "spec-revision",
      createdAt: now(),
    },
    candidate = {
      id: "c",
      projectId: "p",
      workflowId: "w",
      revision: "c".repeat(64),
      baseRevision: null,
      files: [],
      omissions: [],
      instructionHashes: [],
    } as unknown as CandidateSnapshot;
  for (const role of ["builder", "reviewer", "repair"] as const) {
    const context = createTaskContext(f.store, {
      specification,
      candidate,
      taskId: "t",
      role,
      delivery: "terminal",
      persist: false,
    });
    expect(context.content).toContain(
      "Candidate files: they are in the folder you are in",
    );
    expect(context.retrievalRequired).toBe(false);
    expect(context.initialFiles).toEqual([]);
    expect(context.omissions).toContainEqual({
      source: "candidate file contents",
      reason:
        "Not excerpted; Claude Code reads the files in the folder it opens in.",
    });
  }
  f.store.close();
});

describe.skipIf(process.platform === "win32")(
  "a Claude Code step's reply from its session's transcript",
  () => {
    test("off until the owner confirms it in Topsl's dialog; then a build's reply comes from its session's transcript", async () => {
      const f = await setup(),
        config = path.join(f.directory, "claude-config");
      process.env.CLAUDE_CONFIG_DIR = config;
      expect(f.service.state().claudeTranscriptRead).toBe(false);
      const id = await f.run("claude", "codex");
      await f.stage(id, "building");
      const waiting = f.step(id)!,
        opened = await f.open(id);
      await writeFile(
        path.join(f.project, "file.ts"),
        "export const value = 2;\n",
      );
      await f.exit(opened.terminalId);
      const handBack = (fields: Record<string, unknown>) =>
        f.service.command({
          type: "claude-step-return",
          projectId: "p",
          workflowId: id,
          stepId: waiting.id,
          claudeCodeStopped: true,
          ...fields,
        } as any);
      // Off: the owner pastes the reply.
      await expect(f.fromTranscript(id)).rejects.toThrow(
        "Turn on reading Claude Code's transcripts in Settings, or paste Claude's final reply.",
      );
      await expect(handBack({ source: "owner-paste" })).rejects.toThrow(
        "Paste Claude's final reply to hand it back.",
      );
      await expect(
        handBack({ source: "claude-transcript", reply: "Changed it." }),
      ).rejects.toThrow(
        "A reply Topsl reads from the transcript comes without pasted text.",
      );
      // Turning it on takes the confirmation only Topsl's own dialog gives.
      await expect(
        f.service.command({
          type: "claude-transcript-read-set",
          enabled: true,
        }),
      ).rejects.toThrow(
        "Turning on the transcript read needs your confirmation in Topsl's own dialog.",
      );
      expect(f.service.state().claudeTranscriptRead).toBe(false);
      await f.service.command(
        { type: "claude-transcript-read-set", enabled: true },
        { confirmedTranscriptRead: true },
      );
      expect(f.service.state().claudeTranscriptRead).toBe(true);

      // Before Claude Code wrote its transcript, the step keeps waiting and says why.
      const missing = await f.fromTranscript(id);
      expect(missing.outcome).toBe("unread");
      expect(missing.detail).toContain(
        `Topsl took no reply from the session's transcript: Claude Code has no projects folder Topsl can read at ${path.join(config, "projects")}.`,
      );
      expect(missing.detail).toContain("Paste Claude's final reply instead");
      expect(f.step(id)).toMatchObject({
        state: "waiting",
        replyId: null,
        detail: missing.detail,
      });
      expect(f.workflow(id).stage).toBe("building");
      expect(
        f.service.store.list<ClaudeStepReply>("claude-step-reply"),
      ).toEqual([]);

      const file = await writeTranscript(
        config,
        opened,
        "Changed the value to two.",
      );
      const result = await f.fromTranscript(id);
      expect(result.outcome).toBe("taken");
      await f.stage(id, "checking");
      const ended = f.service.store.get<ClaudeStep>("claude-step", waiting.id)!;
      expect(ended).toMatchObject({
        state: "returned",
        replySource: "claude-transcript",
      });
      expect(
        f.service.store.get<ClaudeStepReply>(
          "claude-step-reply",
          ended.replyId!,
        ),
      ).toMatchObject({
        source: "claude-transcript",
        text: "Changed the value to two.",
        outcome: "taken",
        transcript: {
          shapes: claudeTranscriptShapes,
          sessionId: opened.sessionId,
          file: await realpath(file),
          records: 3,
        },
      });
      // Topsl captured the folder as the build, as after a pasted reply.
      const state = f.workflow(id);
      expect(
        f.service.store.get<CandidateSnapshot>("candidate", state.candidateId)!
          .authorAttemptId,
      ).toBe(waiting.attemptId);
      // Turning it off takes no confirmation.
      await f.service.command({
        type: "claude-transcript-read-set",
        enabled: false,
      });
      expect(f.service.state().claudeTranscriptRead).toBe(false);
    });

    test("a review's reply comes from its latest session, in its copy, and one without valid findings keeps it waiting", async () => {
      const f = await setup(),
        config = path.join(f.directory, "claude-config");
      process.env.CLAUDE_CONFIG_DIR = config;
      await f.service.command(
        { type: "claude-transcript-read-set", enabled: true },
        { confirmedTranscriptRead: true },
      );
      const id = await f.run("codex", "claude");
      await vi.waitFor(() => expect(f.step(id)?.role).toBe("reviewer"), {
        timeout: 10_000,
      });
      const waiting = f.step(id)!,
        first = await f.open(id);
      await f.exit(first.terminalId);
      // A transcript of the session in the project folder is not the review's.
      const outside = await writeTranscript(
        config,
        { ...first, cwd: f.project },
        review(waiting.candidateRevision),
      );
      let result = await f.fromTranscript(id);
      expect(result.outcome).toBe("unread");
      expect(result.detail).toContain(
        "Line 1 of the transcript names a folder outside the step's.",
      );
      await rm(outside);
      // In the copy, a finding on a line the build does not have is invalid.
      await writeTranscript(
        config,
        first,
        review(waiting.candidateRevision, [
          {
            title: "Wrong",
            severity: "high",
            file: "file.ts",
            line: 9,
            behavior: "b",
            evidence: "e",
          },
        ]),
      );
      result = await f.fromTranscript(id);
      expect(result.outcome).toBe("invalid");
      expect(result.detail).toContain('finding 1 names "file.ts" line 9');
      expect(f.step(id)).toMatchObject({ state: "waiting", replyId: null });
      expect(
        f.service.store.list<ClaudeStepReply>("claude-step-reply"),
      ).toEqual([
        expect.objectContaining({
          outcome: "invalid",
          source: "claude-transcript",
          transcript: expect.objectContaining({ sessionId: first.sessionId }),
        }),
      ]);
      // Opened again, only the new session counts.
      const second = await f.open(id);
      await f.exit(second.terminalId);
      const older =
        f.service.store.list<ClaudeStepReply>("claude-step-reply")[0]
          .transcript!;
      const take = (fields: object) =>
        f.service.workflows.returnClaudeStep({
          projectId: "p",
          workflowId: id,
          stepId: waiting.id,
          reply: review(waiting.candidateRevision),
          source: "claude-transcript",
          ...fields,
        });
      await expect(take({ transcript: older })).rejects.toThrow(
        "Claude Code opened again for this step while Topsl read the transcript. Hand the reply back again.",
      );
      await expect(take({})).rejects.toThrow(
        "A reply from the transcript comes with the transcript Topsl read, and only then.",
      );
      result = await f.fromTranscript(id);
      expect(result.outcome).toBe("unread");
      expect(result.detail).toContain(
        `Claude Code has no transcript for session ${second.sessionId}`,
      );
      await writeTranscript(config, second, review(waiting.candidateRevision));
      result = await f.fromTranscript(id);
      expect(result.outcome).toBe("taken");
      await f.stage(id, "checking");
      expect(f.workflow(id).reviewArtifactId).toBeTruthy();
      const ended = f.service.store.get<ClaudeStep>("claude-step", waiting.id)!;
      expect(ended.replySource).toBe("claude-transcript");
      expect(
        f.service.store.get<ClaudeStepReply>(
          "claude-step-reply",
          ended.replyId!,
        )!.transcript!.sessionId,
      ).toBe(second.sessionId);
    });
  },
);
