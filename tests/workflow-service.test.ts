import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { Service } from "../apps/service/service";
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
  const f = await fixture();
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
                nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
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
  const create = (reverse = false) =>
    service.command({
      type: "builder-reviewer-create",
      requestId: uid(),
      projectId: "p",
      objective: "value two",
      acceptanceCriteria: ["value equals two"],
      interfaces: [],
      builder: {
        provider: reverse ? "claude" : "codex",
        installationId: reverse ? "claude" : f.installation.id,
        model: "fixture-requested",
      },
      reviewer: {
        provider: reverse ? "codex" : "claude",
        installationId: reverse ? f.installation.id : "claude",
        model: "fixture-requested-reviewer",
      },
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
  return { ...f, service, create };
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
