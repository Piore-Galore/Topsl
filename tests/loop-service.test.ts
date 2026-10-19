import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import { hash, now, uid } from "../packages/domain/invariants";
import type { Installation } from "../packages/domain/types";
import type { Goal } from "../packages/domain/role-groups";
import type { LoopRun } from "../packages/domain/recursive-loops";
import type { CandidateSnapshot } from "../packages/workflows/candidates";
import { candidateFileBytes } from "../packages/workflows/candidates";
import { fixture, gitExecutable } from "./helpers";

/**
 * Service-level Recursive Looping runs over the real runtime manager,
 * attempts, leases, concurrency budget, snapshot copies, capture,
 * integration, owned checkpoint copies and publication, with a scripted Codex
 * stand-in process (tests/fixtures/orchestration-answers.cjs). Model labels
 * are fixture catalog entries; nothing is evidence for a live provider or model.
 */
class FixtureCodex extends CodexAdapter {
  override capabilities(installation: Installation) {
    return [
      ...super.capabilities(installation),
      {
        name: "native-fanout-disabled",
        route: "structured" as const,
        support: "enforceable" as const,
        versions: [],
        testedPlatforms: ["fixture"],
        restrictions: [],
        evidence: {
          level: "source-observation" as const,
          source: "fixture",
          observedAt: now(),
          detail: "Dependency-injected local fixture only",
        },
      },
    ].map((capability) => ({
      ...capability,
      support: "enforceable" as const,
      testedPlatforms: ["fixture"],
      evidence: {
        ...capability.evidence,
        level: "source-observation" as const,
        detail: "Dependency-injected local fixture only",
      },
    }));
  }
}
const services: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const s of services.splice(0)) {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});
function seedCatalog(
  service: Service,
  installation: Installation,
  models: Array<[string, string]>,
) {
  const accountKey = hash(`fixture-account:${installation.id}`);
  service.store.put("runtime-account-observation", {
    id: installation.id,
    account: {
      accountKey,
      profileId: hash(`profile:${installation.id}`),
      billingRoute: "native-subscription",
      sanitized: { type: "fixture", email: null, planType: null },
    },
    observedAt: now(),
  });
  service.store.put("runtime-model-catalog", {
    id: installation.id,
    runtimeRevision: installation.revisionId,
    executableIdentity: installation.identity,
    models: models.map(([model, name]) => ({
      id: model,
      model,
      name,
      description: "fixture",
      isDefault: false,
      supportedReasoningEfforts: [],
    })),
    observedAt: now(),
    accountKey,
  });
}
async function setup(inject = true, turnDelayMs = 20) {
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
                [path.resolve("tests/fixtures/codex-orchestration.cjs")],
                cwd,
                nativeEnvironment({
                  ELECTRON_RUN_AS_NODE: "1",
                  FIXTURE_TURN_DELAY_MS: String(turnDelayMs),
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
  services.push({ service, directory: f.directory });
  const project = path.join(f.directory, "project");
  execFileSync("mkdir", ["-p", project]);
  await writeFile(path.join(project, "file.ts"), "export const value = 1;\n");
  for (const args of [
    ["init", "-q"],
    ["add", "file.ts"],
    [
      "-c",
      "user.email=f@example.test",
      "-c",
      "user.name=Fixture",
      "commit",
      "-qm",
      "base",
    ],
  ])
    execFileSync(gitExecutable, args, { cwd: project });
  service.store.put("project", {
    id: "p",
    name: "fixture",
    path: project,
    realPath: project,
    trusted: true,
    createdAt: now(),
  });
  service.store.put("installation", f.installation);
  const claude = {
    ...f.installation,
    id: "claude",
    appId: "anthropic.claude-code-cli",
  } satisfies Installation;
  service.store.put("installation", claude);
  seedCatalog(service, f.installation, [
    ["fixture-astra", "Astra"],
    ["fixture-sol", "Sol"],
  ]);
  return { ...f, service, project, claude };
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync(gitExecutable, args, { cwd }).toString();

async function untilRun(
  service: Service,
  runId: string,
  done: (run: LoopRun) => boolean,
) {
  await vi
    .waitFor(
      async () => {
        await service.orchestration.tick();
        await service.loops.tick();
        expect(done(service.store.get<LoopRun>("loop-run", runId)!)).toBe(true);
      },
      { timeout: 240_000, interval: 100 },
    )
    .catch((error) => {
      const view = service.loops.view(runId);
      console.log(
        JSON.stringify(
          {
            run: view.run.detail,
            state: view.run.state,
            wait: view.run.waitReason,
            iterations: view.iterations.map((i) => [
              i.number,
              i.state,
              i.detail,
              i.failure,
            ]),
            child: view.current?.goal?.goal.detail,
            rounds: view.current?.rounds,
          },
          null,
          1,
        ),
      );
      throw error;
    });
  return service.loops.view(runId);
}

async function enable(f: Awaited<ReturnType<typeof setup>>) {
  await f.service.command({ type: "loop-feature-set", enabled: true });
}

test("Recursive Looping is off until the experimental flag is on", async () => {
  const f = await setup();
  await expect(
    f.service.command({
      type: "loop-create",
      projectId: "p",
      conversationId: null,
      mode: "goal",
      text: "Change the value to two.",
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow(/experimental and off/);
  expect(
    (await f.service.command({ type: "loop-query", projectId: "p" })).enabled,
  ).toBe(false);
});

test("a Goal loop runs through real attempts, owned checkpoints and publication without per-iteration approval", async () => {
  const f = await setup();
  await enable(f);
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode: "goal",
    text: "Change the value to two.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id;
  // Starting establishes authority; the window cannot do it without the native dialog.
  await expect(
    f.service.command({ type: "loop-start", runId, commandId: `c-${uid()}` }),
  ).rejects.toThrow(/native confirmation/);
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
    statements: string[];
  };
  expect(authority.statements.join(" ")).toMatch(/Topsl-owned copies/);
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  const view = await untilRun(f.service, runId, (r) =>
    ["completed", "waiting", "stopped"].includes(r.state),
  );
  expect(view.run.state).toBe("completed");
  expect(view.checkpoint!.sequence).toBe(1);
  expect(view.goals[0].status).toBe("satisfied");
  // The original folder is untouched until publication.
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );
  const head = f.service.store.get<CandidateSnapshot>(
    "candidate",
    view.checkpoint!.candidateId,
  )!;
  expect(
    candidateFileBytes(
      head,
      head.files.find((x) => x.path === "file.ts")!,
      f.service.store,
    )!.toString(),
  ).toContain("value = 2");
  // Machine promotion is not owner acceptance.
  const child = f.service.store.get<Goal>(
    "goal",
    view.iterations.find((i) => i.state === "promoted")!
      .childExecutionGoalIds[0],
  )!;
  expect(child.acceptance).toBeNull();
  expect(child.loopDisposition!.by).toBe("loop-policy");
  // Publication: native confirmation of the exact files, then read back.
  await expect(
    f.service.command({
      type: "loop-publication-apply",
      runId,
      commandId: `c-${uid()}`,
    }),
  ).rejects.toThrow(/native confirmation/);
  const publication = (await f.service.review("loop-publication", runId)) as {
    digest: string;
    files: Array<{ path: string }>;
  };
  expect(publication.files.map((x) => x.path)).toEqual(["file.ts"]);
  await f.service.command(
    { type: "loop-publication-apply", runId, commandId: `c-${uid()}` },
    { digest: publication.digest },
  );
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 2;\n",
  );
  expect(git(f.project, "status", "--porcelain").trim()).toBe("M file.ts");
});

test("an Endless loop improves once, then monitors instead of completing", async () => {
  const f = await setup();
  await enable(f);
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode: "endless",
    text: "Keep improving the fixture. Prioritize correctness.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id;
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
  };
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  const view = await untilRun(
    f.service,
    runId,
    (r) => r.state === "monitoring",
  );
  expect(view.checkpoint!.sequence).toBe(1);
  expect(view.run.completedAt).toBeNull();
  expect(view.backlog.map((o) => o.state)).toEqual(["accepted"]);
  await f.service.command({
    type: "loop-control",
    runId,
    action: "stop",
    commandId: `c-${uid()}`,
  });
  const stopped = await untilRun(
    f.service,
    runId,
    (r) => r.state === "stopped",
  );
  expect(stopped.checkpoint!.sequence).toBe(1);
});
