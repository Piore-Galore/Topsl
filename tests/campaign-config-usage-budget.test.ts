/**
 * Campaign 2026-10-19-comprehensive, packet p2b-config-usage: USAGE-12 (with
 * supporting USAGE-01/USAGE-03 service evidence).
 *
 * An owner-set provider token budget is consulted when the loop service admits
 * child work, while ordinary direct chats are not stopped by it. The loop runs
 * over the real Service, runtime manager and scripted Codex/Claude stand-ins
 * (setup copied from tests/loop-service.test.ts); the direct chat runs the
 * launched Codex stand-in (tests/fixtures/codex.cjs), as chat-presets.test.ts
 * does. Model labels are fixture catalog entries, not live evidence.
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { hash, now, uid } from "../packages/domain/invariants";
import { commandSchema } from "../packages/domain/commands";
import type { Installation, Run, UsageFact } from "../packages/domain/types";
import type { LoopRun } from "../packages/domain/recursive-loops";
import { fixture, gitExecutable } from "./helpers";

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
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
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
/** Earlier Codex work today: one run reported `tokens`, another reported nothing. */
function seedEarlierCodexWork(service: Service, tokens: number) {
  for (const id of ["earlier-reported", "earlier-silent"])
    service.store.put("run", {
      id,
      conversationId: "earlier",
      projectId: "p",
      provider: "codex",
      installationId: "earlier",
      installationRevisionId: "earlier",
      runtimeVersion: null,
      executableIdentity: "earlier",
      model: "fixture",
      mode: "edit",
      status: "completed",
      nativeSessionId: null,
      nativeTurnId: null,
      error: null,
      createdAt: now(),
    } satisfies Run);
  service.store.put("usage", {
    id: "earlier-reported:turn",
    runId: "earlier-reported",
    provider: "codex",
    input: tokens,
    output: 0,
    cached: 0,
    source: "native-runtime",
    scope: "turn",
    projectId: "p",
    semantics: "cumulative",
    scopeLevel: "turn",
    cachedIncludedInInput: true,
  } satisfies UsageFact);
}

async function loopSetup() {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true, {
    codex: new FixtureCodex(
      (_executable, cwd) =>
        new RpcPeer(
          process.execPath,
          [path.resolve("tests/fixtures/codex-orchestration.cjs")],
          cwd,
          nativeEnvironment({
            ELECTRON_RUN_AS_NODE: "1",
            FIXTURE_TURN_DELAY_MS: "20",
          }),
        ),
    ),
    claude: new ClaudeAdapter(
      claudeFixtureTransport(process.execPath, [
        path.resolve("tests/fixtures/claude-orchestration.cjs"),
      ]),
    ),
  });
  cleanup.push(async () => {
    await service.close();
    await rm(f.directory, { recursive: true, force: true });
  });
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
  seedCatalog(service, claude, [["claude-opus-fixture", "Opus"]]);
  return { ...f, service, project };
}
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
            state: view.run.state,
            wait: view.run.waitReason,
            iterations: view.iterations.map((i) => [i.number, i.state, i.detail]),
          },
          null,
          1,
        ),
      );
      throw error;
    });
  return service.loops.view(runId);
}

test("USAGE-12: an exhausted owner-set Codex budget holds loop child admission with its own reason, and changing the budget while waiting is honoured", async () => {
  const f = await loopSetup();
  const service = f.service;
  await service.command({ type: "loop-feature-set", enabled: true });
  seedEarlierCodexWork(service, 500);
  const save = (tokens: number | null) =>
    service.command(
      commandSchema.parse({
        type: "provider-budget-save",
        provider: "codex",
        tokens,
        period: "day",
      }),
    );
  await save(100);
  expect(service.state().providerBudgets).toMatchObject([
    {
      provider: "codex",
      observedTokens: 500,
      remaining: -400,
      complete: false,
      coveredRuns: 1,
      totalRuns: 2,
    },
  ]);
  const created = await service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode: "goal",
    text: "Change the value to two.",
    policy: {
      scheduling: { reserveForDirectWork: 0 },
      monitoring: { initialSeconds: 1, maxSeconds: 2, factor: 1 },
    },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id;
  const authority = service.review("loop-authority", runId) as {
    digest: string;
  };
  await service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  let view = await untilRun(
    service,
    runId,
    (r) =>
      ["completed", "stopped", "failed"].includes(r.state) ||
      (r.state === "waiting" && r.waitReason?.kind === "allowance"),
  );
  expect(view.run.state).toBe("waiting");
  // The provider budget's own reason, distinct from run/rolling member-turn allowances.
  expect(view.run.waitReason).toMatchObject({
    kind: "allowance",
    detail:
      "codex: Your day budget of 100 tokens is used (incomplete measurement).",
  });
  expect(view.run.waitReason!.detail).not.toMatch(/member turns/);
  // No child execution was admitted while the budget was used up.
  expect(view.iterations.flatMap((i) => i.childExecutionGoalIds)).toEqual([]);
  expect(view.checkpoint?.sequence ?? 0).toBe(0);
  // A changed budget that is still used up keeps it waiting, with the new value.
  await save(200);
  view = await untilRun(service, runId, (r) =>
    /budget of 200 tokens is used/.test(r.waitReason?.detail ?? ""),
  );
  expect(view.run.state).toBe("waiting");
  expect(view.iterations.flatMap((i) => i.childExecutionGoalIds)).toEqual([]);
  // Raising it releases admission; the loop then completes its goal.
  await save(1_000_000_000);
  view = await untilRun(service, runId, (r) =>
    ["completed", "stopped", "failed"].includes(r.state),
  );
  expect(view.run.state).toBe("completed");
  expect(view.checkpoint!.sequence).toBe(1);
  expect(
    view.iterations.flatMap((i) => i.childExecutionGoalIds).length,
  ).toBeGreaterThan(0);
});

test.skipIf(process.platform === "win32")(
  "USAGE-12: the same used-up budget does not stop a direct chat, whose deduplicated usage is counted and survives restart",
  async () => {
    const f = await fixture();
    f.store.close();
    let service = new Service(f.directory, f.key, () => {}, true);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const wrapper = path.join(f.directory, "codex-stand-in");
    await writeFile(
      wrapper,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/codex.cjs"))}\n`,
    );
    await chmod(wrapper, 0o700);
    const installation: Installation = {
      ...f.installation,
      path: wrapper,
      ...(await identity(wrapper)),
    };
    service.store.put("installation", installation);
    service.store.put("project", {
      id: "p",
      name: "fixture",
      path: f.directory,
      realPath: f.directory,
      trusted: true,
      createdAt: now(),
    });
    service.store.put("conversation", {
      id: "c",
      projectId: "p",
      title: "Fixture chat",
      nativeSessions: {},
      createdAt: now(),
    });
    seedEarlierCodexWork(service, 500);
    await service.start();
    await service.command(
      commandSchema.parse({
        type: "provider-budget-save",
        provider: "codex",
        tokens: 10,
        period: "day",
      }),
    );
    expect(service.state().providerBudgets[0].remaining).toBe(-490);
    // The same state would hold loop child admission.
    expect((service as any).loopProviderLimits(["codex"])).toMatchObject([
      { provider: "codex", kind: "allowance" },
    ]);
    const run: Run = await service.command(
      commandSchema.parse({
        type: "run-start",
        conversationId: "c",
        installationId: installation.id,
        prompt: "hello",
        model: "fixture-model",
        mode: "edit",
        snapshotId: null,
      }),
    );
    await vi.waitFor(
      () =>
        expect(service.store.get<Run>("run", run.id)?.status).toBe(
          "completed",
        ),
      { timeout: 10_000 },
    );
    // The stand-in reports the same cumulative usage twice; it is stored once.
    const usage = service.store
      .list<UsageFact>("usage")
      .filter((u) => u.runId === run.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ input: 12, output: 3 });
    expect(service.state().providerBudgets[0]).toMatchObject({
      observedTokens: 515,
      remaining: -505,
      coveredRuns: 2,
      totalRuns: 3,
    });
    await service.close();
    service = new Service(f.directory, f.key, () => {}, true);
    await service.start();
    expect(service.state().providerBudgets[0]).toMatchObject({
      observedTokens: 515,
      remaining: -505,
    });
    expect(
      service.store.list<UsageFact>("usage").filter((u) => u.runId === run.id),
    ).toHaveLength(1);
  },
);
