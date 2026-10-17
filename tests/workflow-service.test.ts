import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { Service } from "../apps/service/service";
import { candidateToolset } from "../packages/context/candidate-tools";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import type { Installation } from "../packages/domain/types";
import { now, uid } from "../packages/domain/invariants";
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
const fixtures: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.service?.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup(inject = true) {
  const f = await fixture(),
    log = path.join(f.directory, "codex-frames.jsonl");
  f.store.close();
  const service = new Service(
    f.directory,
    f.key,
    () => {},
    true,
    inject
      ? {
          codex: new FixtureCodex(
            (_executable, cwd) =>
              new RpcPeer(
                process.execPath,
                [path.resolve("tests/fixtures/codex-workflow.cjs")],
                cwd,
                nativeEnvironment({
                  ELECTRON_RUN_AS_NODE: "1",
                  FIXTURE_LOG: log,
                }),
              ),
          ),
          claude: new ClaudeAdapter(
            claudeFixtureTransport(process.execPath, [
              path.resolve("tests/fixtures/claude.cjs"),
            ]),
          ),
        }
      : undefined,
  );
  fixtures.push({ service, directory: f.directory });
  await writeFile(
    path.join(f.directory, "file.ts"),
    "export const value = 1;\n",
  );
  service.store.put("project", {
    id: "p",
    name: "service fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  });
  service.store.put("installation", f.installation);
  service.store.put("installation", {
    ...f.installation,
    id: "claude",
    appId: "anthropic.claude-code-cli",
  } satisfies Installation);
  await service.start();
  const create = (
    reverse = false,
    team: {
      codexReviewer?: boolean;
      selectedPaths?: string[];
      objective?: string;
    } = {},
  ) =>
    service.command({
      type: "builder-reviewer-create",
      requestId: uid(),
      projectId: "p",
      objective: team.objective ?? "value two",
      acceptanceCriteria: ["value equals two"],
      interfaces: [],
      builder: {
        provider: reverse ? "claude" : "codex",
        installationId: reverse ? "claude" : f.installation.id,
        model: "fixture-requested",
      },
      reviewer: {
        provider: reverse || team.codexReviewer ? "codex" : "claude",
        installationId:
          reverse || team.codexReviewer ? f.installation.id : "claude",
        model: "fixture-requested-reviewer",
      },
      selectedPaths: team.selectedPaths ?? ["file.ts"],
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
  const frames = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { from: string; frame: any });
  return { ...f, service, create, frames };
}
/** Advances a new workflow with its reviewed inputs until both turns ran. */
async function runTurns(
  f: Awaited<ReturnType<typeof setup>>,
  state: { id: string },
) {
  await f.service.command(
    {
      type: "builder-reviewer-advance",
      requestId: uid(),
      id: state.id,
      expectedRevision: f.service.store.get<any>("workflow", state.id).revision,
    },
    {
      digest: (f.service.review("workflow-dispatch-inputs", state.id) as any)
        .digest,
    },
  );
  await vi.waitFor(
    () =>
      expect(["checking", "blocked"]).toContain(
        f.service.store.get<any>("builder-reviewer", state.id)?.stage,
      ),
    { timeout: 8000 },
  );
  return f.service.store.get<any>("builder-reviewer", state.id);
}
test.each([false, true])(
  "service automatically completes both adapter turns for reversible assignment %s, requires native check/acceptance",
  async (reverse) => {
    const f = await setup(),
      state = await f.create(reverse);
    const command = {
      type: "builder-reviewer-advance" as const,
      requestId: uid(),
      id: state.id,
      expectedRevision: f.service.store.get<any>("workflow", state.id).revision,
    };
    await f.service.command(command, {
      digest: (f.service.review("workflow-dispatch-inputs", state.id) as any)
        .digest,
    });
    await f.service.command(command); // Same request returns receipt; does not dispatch twice.
    await vi.waitFor(
      () =>
        expect(["checking", "blocked"]).toContain(
          f.service.store.get<any>("builder-reviewer", state.id)?.stage,
        ),
      { timeout: 8000 },
    );
    expect(
      f.service.store.get<any>("builder-reviewer", state.id)?.stage,
      JSON.stringify({
        state: f.service.store.get<any>("builder-reviewer", state.id),
        messages: [
          ...f.service.store.iterate<any>("message", { projectId: "p" }),
        ]
          .filter((m) => m.role === "assistant")
          .map((m) => ({ nativeId: m.nativeId, text: m.text })),
      }),
    ).toBe("checking");
    const attempts = [
      ...f.service.store.iterate<any>("attempt", { projectId: "p" }),
    ];
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.provider)).toEqual(
      reverse ? ["claude", "codex"] : ["codex", "claude"],
    );
    expect(
      attempts.every(
        (attempt) => attempt.state === "completed" && attempt.contextPackageId,
      ),
    ).toBe(true);
    const plans = await f.service.command({
      type: "builder-reviewer-checks-preview",
      id: state.id,
      expectedRevision: f.service.store.get<any>("workflow", state.id).revision,
    });
    await expect(
      f.service.command({
        type: "builder-reviewer-check-apply",
        requestId: uid(),
        id: plans[0].id,
      }),
    ).rejects.toThrow("native approval");
    await f.service.command(
      {
        type: "builder-reviewer-check-apply",
        requestId: uid(),
        id: plans[0].id,
      },
      { digest: plans[0].digest },
    );
    const acceptance: any = f.service.review("workflow-acceptance", state.id);
    await expect(
      f.service.command({
        type: "builder-reviewer-accept",
        requestId: uid(),
        id: state.id,
        expectedRevision: f.service.store.get<any>("workflow", state.id)
          .revision,
      }),
    ).rejects.toThrow("native confirmation");
    await f.service.command(
      {
        type: "builder-reviewer-accept",
        requestId: uid(),
        id: state.id,
        expectedRevision: f.service.store.get<any>("workflow", state.id)
          .revision,
      },
      { digest: acceptance.digest },
    );
    expect(f.service.store.get<any>("builder-reviewer", state.id).stage).toBe(
      "accepted",
    );
  },
);
test("a Codex reviewer reads the captured build through Topsl's tools, and the Codex builder gets none", async () => {
  const f = await setup(),
    marker = `reader-marker-${uid()}`;
  // Too large to arrive in the task input, so the review must read it.
  await writeFile(
    path.join(f.directory, "large.txt"),
    "filler for the candidate reader\n".repeat(1000) + `last ${marker}\n`,
  );
  await writeFile(path.join(f.directory, "outside.txt"), "not captured\n");
  const revoked = vi.spyOn(f.service.context, "revokeAttempt"),
    state = await f.create(false, {
      codexReviewer: true,
      selectedPaths: ["file.ts", "large.txt"],
    });
  expect((await runTurns(f, state)).stage).toBe("checking");
  const [builder, reviewer] = [
    ...f.service.store.iterate<any>("attempt", { projectId: "p" }),
  ];
  expect([builder.provider, reviewer.provider]).toEqual(["codex", "codex"]);
  // Only the review thread declared the reader.
  const starts = f
    .frames()
    .filter(
      (entry) =>
        entry.from === "topsl" && entry.frame.method === "thread/start",
    );
  expect(starts).toHaveLength(2);
  expect(starts[0].frame.params).not.toHaveProperty("dynamicTools");
  expect(starts[1].frame.params.dynamicTools).toEqual([
    {
      type: "namespace",
      name: "topsl_candidate",
      description: candidateToolset.description,
      tools: candidateToolset.tools.map((tool) => ({
        type: "function",
        ...tool,
      })),
    },
  ]);
  expect(
    f.service.store.get<any>("attempt-context-grant", builder.id).delivery,
  ).toBe("workspace-read; retrieval-not-required");
  expect(
    f.service.store.get<any>("attempt-context-grant", reviewer.id).delivery,
  ).toBe("installed-before-dispatch");
  // The read returned the pinned file and the outside path was refused, and
  // each left a receipt under the reviewer's attempt.
  const receipts = [
    ...f.service.store.iterate<any>("candidate-retrieval", { projectId: "p" }),
  ].map((receipt) => [
    receipt.attemptId,
    receipt.candidateId,
    receipt.path,
    receipt.outcome,
  ]);
  expect(receipts.sort()).toEqual(
    [
      [
        reviewer.id,
        reviewer.inputManifest.contentManifestId,
        "large.txt",
        "returned",
      ],
      [
        reviewer.id,
        reviewer.inputManifest.contentManifestId,
        "outside.txt",
        "denied",
      ],
    ].sort(),
  );
  const review = [
    ...f.service.store.iterate<any>("message", { projectId: "p" }),
  ]
    .filter(
      (message) =>
        message.runId === reviewer.legacyRunId && message.role === "assistant",
    )
    .map((message) => message.text)
    .join("\n");
  expect(review).toContain(`large.txt ends last ${marker}`);
  expect(review).toContain(
    "outside.txt refused: Candidate path is withheld or outside the scoped manifest.",
  );
  const calls = (
    f.service.store.db
      .prepare("SELECT body FROM events WHERE kind = 'run.tool-call'")
      .all() as Array<{ body: string }>
  ).map((row) => JSON.parse(row.body));
  expect(calls.map((call) => [call.tool, call.outcome])).toEqual([
    ["read_range", "answered"],
    ["read_range", "failed"],
  ]);
  // The grant ended with the review attempt.
  expect(revoked).toHaveBeenCalledWith(reviewer.id);
});
test("a review attempt that fails still loses its reader grant", async () => {
  const f = await setup();
  await writeFile(
    path.join(f.directory, "large.txt"),
    "filler for the candidate reader\n".repeat(1000),
  );
  const revoked = vi.spyOn(f.service.context, "revokeAttempt"),
    state = await f.create(false, {
      codexReviewer: true,
      selectedPaths: ["file.ts", "large.txt"],
      objective: "value two [fixture: the review fails]",
    });
  const blocked = await runTurns(f, state);
  expect(blocked.stage).toBe("blocked");
  const [, reviewer] = [
    ...f.service.store.iterate<any>("attempt", { projectId: "p" }),
  ];
  expect(reviewer.state).toBe("failed");
  expect(blocked.detail).toContain("Attempt failed");
  expect(
    f.service.store.get<any>("attempt-context-grant", reviewer.id).delivery,
  ).toBe("installed-before-dispatch");
  expect(revoked).toHaveBeenCalledWith(reviewer.id);
});
test("a Codex review's progress note before its answer leaves the answer readable", async () => {
  const f = await setup(),
    reviewed = await runTurns(
      f,
      await f.create(false, {
        codexReviewer: true,
        objective: "value two [fixture: the review narrates]",
      }),
    );
  expect(reviewed.stage, reviewed.detail).toBe("checking");
  const [, reviewer] = [
    ...f.service.store.iterate<any>("attempt", { projectId: "p" }),
  ];
  // The note stays in the run's history ahead of the answer.
  const replies = [
    ...f.service.store.iterate<any>("message", { projectId: "p" }),
  ]
    .filter(
      (message) =>
        message.runId === reviewer.legacyRunId && message.role === "assistant",
    )
    .map((message) => message.text);
  expect(replies).toHaveLength(2);
  expect(replies[0]).toBe("Reading the captured build before I review it.");
});
test.each([
  ["is prose", "its final message is not JSON"],
  [
    "breaks the schema",
    'findings.0.severity: Invalid option: expected one of "high"|"medium"|"low"; findings.0.line: Too small: expected number to be >0',
  ],
])(
  "a review that %s blocks the workflow and says why",
  async (marker, reason) => {
    const f = await setup(),
      blocked = await runTurns(
        f,
        await f.create(false, {
          codexReviewer: true,
          objective: `value two [fixture: the review ${marker}]`,
        }),
      );
    expect(blocked.stage).toBe("blocked");
    expect(blocked.detail).toBe(
      `Reviewer output did not match the required finding schema (${reason}); review is unverified and cannot be accepted.`,
    );
  },
);
test("a workflow lists the requests its running build waits on, and the owner's answer reaches Codex", async () => {
  const f = await setup(),
    state = await f.create(false, {
      objective: "value two [fixture: the build asks first]",
    }),
    waiting = async () =>
      (
        await f.service.command({
          type: "builder-reviewer-query",
          projectId: "p",
        })
      ).workflows.find((workflow: { id: string }) => workflow.id === state.id)
        .approvals;
  await f.service.command(
    {
      type: "builder-reviewer-advance",
      requestId: uid(),
      id: state.id,
      expectedRevision: f.service.store.get<any>("workflow", state.id).revision,
    },
    {
      digest: (f.service.review("workflow-dispatch-inputs", state.id) as any)
        .digest,
    },
  );
  const request = await vi.waitFor(async () => {
    const approvals = await waiting();
    expect(approvals).toHaveLength(1);
    return approvals[0];
  });
  expect(request.summary.title).toBe("Run a command");
  expect(f.service.store.get<any>("builder-reviewer", state.id).stage).toBe(
    "building",
  );
  // The card decides it as a chat's card does.
  await f.service.command(
    { type: "approval-decide", id: request.id, allow: false },
    { digest: request.digest },
  );
  expect(await waiting()).toEqual([]);
  expect(
    f
      .frames()
      .some(
        ({ from, frame }) =>
          from === "topsl" &&
          frame.id === "ask-command" &&
          frame.result?.decision === "decline",
      ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(f.service.store.get<any>("builder-reviewer", state.id)?.stage).toBe(
      "checking",
    ),
  );
});
test("production capability gate refuses before any builder turn and retains native routes", async () => {
  const f = await setup(false),
    state = await f.create();
  const result = await f.service.command(
    {
      type: "builder-reviewer-advance",
      requestId: uid(),
      id: state.id,
      expectedRevision: f.service.store.get<any>("workflow", state.id).revision,
    },
    {
      digest: (f.service.review("workflow-dispatch-inputs", state.id) as any)
        .digest,
    },
  );
  expect(result.stage).toBe("blocked");
  expect(result.detail).toContain("gated");
  expect([
    ...f.service.store.iterate("attempt", { projectId: "p" }),
  ]).toHaveLength(0);
  expect([...f.service.store.iterate("run", { projectId: "p" })]).toHaveLength(
    0,
  );
});

test("captured inputs require native exact-revision approval before first dispatch", async () => {
  const f = await setup(false),
    state = await f.create();
  const command = {
    type: "builder-reviewer-advance" as const,
    requestId: uid(),
    id: state.id,
    expectedRevision: f.service.store.get<any>("workflow", state.id).revision,
  };
  await expect(f.service.command(command)).rejects.toThrow(
    "Review and approve",
  );
  const reviewed: any = f.service.review("workflow-dispatch-inputs", state.id);
  expect(reviewed.files.map((file: any) => file.path)).toContain("file.ts");
  expect(JSON.stringify(reviewed)).not.toContain('"content":');
  await expect(
    f.service.command(
      { ...command, requestId: uid() },
      { digest: "changed-inputs" },
    ),
  ).rejects.toThrow("Review and approve");
  expect([...f.service.store.iterate("attempt")]).toHaveLength(0);
  expect([...f.service.store.iterate("run")]).toHaveLength(0);
});
