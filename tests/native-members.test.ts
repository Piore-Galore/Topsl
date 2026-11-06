import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import { CodexAdapter } from "../packages/providers/codex";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import { hash, now, uid } from "../packages/domain/invariants";
import type { Installation } from "../packages/domain/types";
import {
  fundingObservation,
  memberFunding,
  requestedFunding,
  type Goal,
  type MemberIntent,
  type ParticipantContribution,
  type RoleRound,
} from "../packages/domain/role-groups";
import {
  candidateFileBytes,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import type { NativeAttemptView } from "../packages/harness/types";
import { fixture, gitExecutable } from "./helpers";
import {
  answer as reply,
  lastResults,
  nativeProxy,
  type Script,
} from "./native-fixture";

/**
 * A coordinator team with native members (docs/Native_Harness_Plan.md,
 * Phase 6b), over the real control service: runtime manager, attempts,
 * copies, capture, integration, the orchestration driver's native path, the
 * native harness, and Topsl's real local proxy on loopback. The vendor
 * members are the Codex stand-in process; the native members' model is a
 * synthetic upstream that answers from the prompt with the same stand-in
 * replies. Fixture labels and models only: nothing here is evidence for a
 * live provider, account or model.
 */

const require = createRequire(import.meta.url);
const { answer } = require("./fixtures/orchestration-answers.cjs") as {
  answer(prompt: string, cwd?: string): string;
};

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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const shaOf = (output: string) =>
  /sha256: ([a-f0-9]{64})/.exec(output)?.[1] ?? "";
const promptOf = (call: Parameters<Script>[0]) =>
  call.request.messages[0].parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");

/**
 * The synthetic model: control turns answer with the stand-in's JSON;
 * implementation turns read file.ts, edit it through edit_file with the
 * hash read_file reported, then answer with their summary.
 */
function memberScript(scratch: string): Script {
  return (call) => {
    const prompt = promptOf(call);
    const turn = call.request.messages.filter(
      (m) => m.role === "assistant",
    ).length;
    if (/When done, reply/.test(prompt)) {
      if (turn === 0)
        return { events: reply([{ tool: "read_file", args: { path: "file.ts" } }]) };
      if (turn === 1)
        return {
          events: reply([
            {
              tool: "edit_file",
              args: {
                path: "file.ts",
                old_text: "value = 1",
                new_text: "value = 2",
                expected_sha256: shaOf(lastResults(call.request)[0].output),
              },
            },
          ]),
        };
      return {
        events: reply([
          {
            text: JSON.stringify({
              inputDigest: /"inputDigest": "([^"]+)"/.exec(prompt)?.[1] ?? "",
              summary: "Native member set the value to two in file.ts.",
            }),
          },
        ]),
      };
    }
    // The stand-in never writes for a control turn; its scratch folder is
    // only a cwd.
    return { events: reply([{ text: answer(prompt, scratch) }]) };
  };
}

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

async function setup(
  script?: (scratch: string) => Script,
  claudeArgs: string[] = [],
) {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true, {
    // Claude Code's stand-in answers each purpose's contract from the
    // prompt; no model is contacted (tests/fixtures/claude-orchestration.cjs).
    claude: new ClaudeAdapter(
      claudeFixtureTransport(process.execPath, [
        path.resolve("tests/fixtures/claude-orchestration.cjs"),
        ...claudeArgs,
      ]),
    ),
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
  });
  cleanups.push(async () => {
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
  seedCatalog(service, f.installation, [
    ["fixture-astra", "Astra"],
    ["fixture-sol", "Sol"],
  ]);
  const claude = {
    ...f.installation,
    id: "claude",
    appId: "anthropic.claude-code-cli",
  } satisfies Installation;
  service.store.put("installation", claude);
  seedCatalog(service, claude, [["claude-opus-fixture", "Opus"]]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "topsl-test-scratch-"));
  cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  const native = await nativeProxy((script ?? memberScript)(scratch));
  cleanups.push(() => native.close());
  const { connection, key } = await native.apiKey(
    "openai-api",
    undefined,
    "Synthetic OpenAI API",
  );
  const route = native.route(connection.id, "native/coder");
  // What Electron main hands the control service: the endpoint and the
  // sanitized proxy state, never a credential.
  service.native.setProxy(native.endpoint, native.proxy.view());
  return { ...f, service, project, native, connection, key, route };
}

const vendor = (memberId: string, model: string): MemberIntent => ({
  memberId,
  required: true,
  pin: { provider: "codex", model },
  fallbacks: [],
  preferences: { providers: [], models: [] },
  source: { kind: "ui", reference: null, provenance: "explicit" },
});
const claudeMember = (memberId: string): MemberIntent => ({
  memberId,
  required: true,
  pin: { provider: "claude", model: "claude-opus-fixture" },
  fallbacks: [],
  preferences: { providers: [], models: [] },
  source: { kind: "ui", reference: null, provenance: "explicit" },
});
const nativeMember = (memberId: string, routeId: string): MemberIntent => ({
  memberId,
  required: true,
  pin: { provider: "native", routeId, model: "upstream-model-reported" },
  fallbacks: [],
  preferences: { providers: [], models: [] },
  source: { kind: "ui", reference: null, provenance: "explicit" },
});

async function group(
  service: Service,
  roleId: string,
  members: MemberIntent[],
) {
  await service.command({
    type: "orchestration-group-set",
    projectId: "p",
    goalId: null,
    level: "project-role",
    taskKey: null,
    mode: "replace",
    roleId,
    settings: { form: "exact", members },
    commandId: `c-${uid()}`,
  });
}

async function untilGoal(service: Service, goalId: string, states: string[]) {
  await vi
    .waitFor(
      async () => {
        await service.orchestration.tick();
        expect(states).toContain(
          service.store.get<Goal>("goal", goalId)!.state,
        );
      },
      { timeout: 120_000, interval: 100 },
    )
    .catch((error) => {
      const view = service.orchestration.goalView(goalId);
      console.log(
        JSON.stringify(
          {
            goal: view.goal.detail,
            rounds: view.rounds.map((r: any) => ({
              kind: r.kind,
              stage: r.stage,
              detail: r.detail,
              members: r.members.map((m: any) => [
                m.memberId,
                m.provider,
                m.state,
                m.detail,
              ]),
            })),
          },
          null,
          1,
        ),
      );
      throw error;
    });
  return service.store.get<Goal>("goal", goalId)!;
}

async function post(service: Service, text: string) {
  const conversation = await service.command({
    type: "orchestration-conversation-create",
    projectId: "p",
    title: "",
    commandId: `c-${uid()}`,
  });
  return service.command({
    type: "orchestration-message",
    conversationId: conversation.id,
    text,
    goalId: null,
    routing: "auto",
    kind: "code",
    commandId: `c-${uid()}`,
  });
}

test("a native GPT coordinator assigns Claude Code work and a native reviewer reviews it, through Topsl", async () => {
  // Plan §9: GPT coordinator → Claude worker → GPT reviewer, on the existing
  // structured protocol. The native members' upstream is synthetic and the
  // Claude member is the Claude Code stand-in: this shows Topsl's dispatch
  // across engines, not any live provider.
  const f = await setup();
  await group(f.service, "coordinator", [
    nativeMember("native-coordinator", f.route.id),
  ]);
  await group(f.service, "implementer", [claudeMember("claude-implementer")]);
  await group(f.service, "reviewer", [
    nativeMember("native-reviewer", f.route.id),
  ]);
  const view = f.service.orchestration.view("p");
  const claudeRoute: any = view.routes.find(
    (r: any) => r.provider === "claude",
  );
  expect(claudeRoute.purposes.implementation.ready).toBe(true);

  const posted = await post(f.service, "Change the value to two.");
  const goal = await untilGoal(f.service, posted.goal.id, [
    "awaiting-acceptance",
    "blocked",
  ]);
  expect(goal.state).toBe("awaiting-acceptance");
  const rounds = f.service.orchestration.rounds(goal.id) as RoleRound[];
  const engines = (kind: string) =>
    rounds
      .find((r) => r.kind === kind)!
      .members.filter((m) => m.phase === "initial")
      .map((m) => [m.memberId, m.provider, m.state]);
  expect(engines("coordination")).toEqual([
    ["native-coordinator", "native", "returned"],
  ]);
  expect(engines("work")).toEqual([
    ["claude-implementer", "claude", "returned"],
  ]);
  expect(engines("review")).toEqual([
    ["native-reviewer", "native", "returned"],
  ]);
  // Each member shows its engine and its turn's funding, requested and as
  // observed: Claude Code's init record named its own login; the native
  // turn went through the frozen proxy route.
  const shown = f.service.orchestration.goalView(goal.id).rounds.flatMap(
    (r: any) => r.members,
  );
  expect(
    shown.find((m: any) => m.memberId === "claude-implementer"),
  ).toMatchObject({
    engine: "claude-code",
    connection: null,
    requestedFunding: "subscription",
    funding: {
      requested: "subscription",
      observed: "subscription",
      state: "matches",
      source: "Claude Code init record",
    },
  });
  expect(
    shown.find((m: any) => m.memberId === "native-reviewer"),
  ).toMatchObject({
    engine: "native",
    connection: {
      routeAlias: "native/coder",
      connectionLabel: "Synthetic OpenAI API",
    },
    funding: {
      requested: "api-billing",
      observed: "api-billing",
      state: "matches",
      source: "proxy route binding",
    },
  });
  // Claude Code's edit, captured from its own copy, is the goal's candidate
  // that the native reviewer reviewed; the folder is untouched.
  const candidate = f.service.store.get<CandidateSnapshot>(
    "candidate",
    goal.candidateId!,
  )!;
  const file = candidate.files.find((x) => x.path === "file.ts")!;
  expect(
    candidateFileBytes(candidate, file, f.service.store)!.toString(),
  ).toBe("export const value = 2;\n");
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );
});

test("a Claude Code coordinator assigns native GPT work and a Claude Code reviewer reviews it, through Topsl", async () => {
  // Plan §9: Claude coordinator → GPT worker, the reverse direction. Same
  // fixture limits as above.
  const f = await setup();
  await group(f.service, "coordinator", [claudeMember("claude-coordinator")]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [claudeMember("claude-reviewer")]);
  const posted = await post(f.service, "Change the value to two.");
  const goal = await untilGoal(f.service, posted.goal.id, [
    "awaiting-acceptance",
    "blocked",
  ]);
  expect(goal.state).toBe("awaiting-acceptance");
  const rounds = f.service.orchestration.rounds(goal.id) as RoleRound[];
  const engines = (kind: string) =>
    rounds
      .find((r) => r.kind === kind)!
      .members.filter((m) => m.phase === "initial")
      .map((m) => [m.memberId, m.provider, m.state]);
  expect(engines("coordination")).toEqual([
    ["claude-coordinator", "claude", "returned"],
  ]);
  expect(engines("work")).toEqual([
    ["native-implementer", "native", "returned"],
  ]);
  expect(engines("review")).toEqual([
    ["claude-reviewer", "claude", "returned"],
  ]);
  const candidate = f.service.store.get<CandidateSnapshot>(
    "candidate",
    goal.candidateId!,
  )!;
  const file = candidate.files.find((x) => x.path === "file.ts")!;
  expect(
    candidateFileBytes(candidate, file, f.service.store)!.toString(),
  ).toBe("export const value = 2;\n");
});

test("a coordinator team with a native coordinator and a native implementer on a synthetic route runs a goal to acceptance", async () => {
  const f = await setup();
  // A mixed team: Codex and native coordinators, a native implementer, a
  // Codex reviewer.
  await group(f.service, "coordinator", [
    vendor("astra", "fixture-astra"),
    nativeMember("native-coordinator", f.route.id),
  ]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [vendor("sol", "fixture-sol")]);

  // The native route is offered beside the vendor installation, with no
  // installation of its own.
  const view = f.service.orchestration.view("p");
  const offered: any = view.routes.find((r: any) => r.provider === "native");
  expect(offered).toMatchObject({
    installationId: null,
    native: {
      routeId: f.route.id,
      routeAlias: "native/coder",
      connectionLabel: "Synthetic OpenAI API",
      funding: "api-billing",
    },
  });
  expect(offered.purposes["coordinator-contribution"].ready).toBe(true);
  expect(offered.purposes.implementation.ready).toBe(true);

  const posted = await post(f.service, "Change the value to two.");
  const goal = await untilGoal(f.service, posted.goal.id, [
    "awaiting-acceptance",
    "blocked",
  ]);
  expect(goal.state).toBe("awaiting-acceptance");

  const rounds = f.service.orchestration.rounds(goal.id) as RoleRound[];
  const coordination = rounds.find((r) => r.kind === "coordination")!;
  expect(
    coordination.members
      .filter((m) => m.phase === "initial")
      .map((m) => [m.memberId, m.provider, m.state]),
  ).toEqual([
    ["astra", "codex", "returned"],
    ["native-coordinator", "native", "returned"],
  ]);
  const work = rounds.find((r) => r.kind === "work")!;
  expect(work.members.map((m) => [m.provider, m.state])).toEqual([
    ["native", "returned"],
  ]);
  // A native member's round entry names its proxy route, not an installation.
  expect(work.members[0].installationId).toBe(f.route.id);
  const review = rounds.find((r) => r.kind === "review")!;
  expect(review.members.map((m) => [m.provider, m.state])).toEqual([
    ["codex", "returned"],
  ]);

  // Native contributions are valid with the model the upstream reported,
  // which is the assigned route's model.
  const contributions = f.service.orchestration.repo
    .all<ParticipantContribution>("role-contribution", "p")
    .filter((c) => c.memberId.startsWith("native-"));
  expect(contributions.length).toBeGreaterThanOrEqual(2);
  expect(
    contributions.every(
      (c) =>
        c.validation.state === "valid" &&
        c.reportedModel === "upstream-model-reported",
    ),
  ).toBe(true);

  // The native implementer's edit, captured from its own copy and
  // integrated, is the goal's candidate; the folder is untouched.
  const candidate = f.service.store.get<CandidateSnapshot>(
    "candidate",
    goal.candidateId!,
  )!;
  const file = candidate.files.find((x) => x.path === "file.ts")!;
  expect(
    candidateFileBytes(candidate, file, f.service.store)!.toString(),
  ).toBe("export const value = 2;\n");
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );

  // Each native turn ran in the harness under a frozen binding to the route,
  // with no vendor installation, and recorded its member context.
  const sessions = f.service.orchestration.repo
    .all<{
      id: string;
      provider: string;
      engine?: string;
      binding?: NativeAttemptView["binding"];
    }>("member-session", "p")
    .filter((s) => s.provider === "native");
  expect(sessions.length).toBe(contributions.length);
  for (const s of sessions) {
    expect(s.engine).toBe("native");
    expect(s.binding).toMatchObject({
      engine: "native",
      vendor: null,
      native: {
        routeId: f.route.id,
        routeRevision: f.route.revision,
        connectionId: f.connection.id,
        funding: "api-billing",
      },
    });
    const attempt = f.service.native.harness.view(s.id)!;
    expect(attempt.state).toBe("completed");
    // No vendor attempt exists for a native turn.
    expect(f.service.store.get("attempt", s.id)).toBeUndefined();
  }

  // Every upstream request was the route's Responses shape with the API key,
  // and asked for the turn's JSON Schema.
  const calls = f.native.upstream.calls;
  // One request per control turn; read, edit and answer for the implementer.
  const byName = (name: string) =>
    calls.filter((c) => c.body.text?.format?.name === name).length;
  expect(byName("coordinator-v1_implementation")).toBe(3);
  expect(calls.length).toBe(sessions.length - 1 + 3);
  for (const call of calls) {
    expect(call.path).toBe("/openai/responses");
    expect(call.body.model).toBe("upstream-model-reported");
    expect(call.headers.authorization).toBe(`Bearer ${f.key}`);
    expect(call.body.text.format).toMatchObject({ type: "json_schema" });
    expect(call.request.outputFormat?.schema).toBeTruthy();
  }
  const names = new Set(calls.map((c) => c.body.text.format.name));
  expect(names).toContain("coordinator-v1_coordinator-contribution");
  expect(names).toContain("coordinator-v1_implementation");
  // The key reached only the upstream: it is in no request body the harness
  // journaled.
  for (const s of sessions)
    expect(
      JSON.stringify(f.service.native.harness.events(s.id, 0, 1000)),
    ).not.toContain(f.key);

  // Copies were removed and no capacity is held.
  expect(
    f.service.orchestration.repo
      .all<{ state: string }>("orchestration-copy", "p")
      .every((c) => c.state === "processed"),
  ).toBe(true);
  expect(f.service.orchestration.view("p").capacity.held).toEqual([]);

  // Acceptance stays the owner's, through Topsl's own confirmation.
  const acceptance = f.service.review("goal-acceptance", goal.id) as {
    digest: string;
    files: unknown;
  };
  expect(acceptance.files).toEqual([{ path: "file.ts", change: "modified" }]);
  const accepted = await f.service.command(
    { type: "orchestration-accept", goalId: goal.id, commandId: `c-${uid()}` },
    { digest: acceptance.digest },
  );
  expect(accepted.state).toBe("accepted");
}, 180_000);

test("a native member's route that changed after assignment is refused before dispatch, never redirected", async () => {
  const f = await setup();
  await group(f.service, "coordinator", [
    nativeMember("native-coordinator", f.route.id),
  ]);
  const resolved = f.service.orchestration.resolve("p", null, "coordinator");
  expect(resolved.assignments[0]).toMatchObject({
    status: "resolved",
    provider: "native",
    engine: "native",
    installationId: null,
    native: { routeId: f.route.id, routeRevision: f.route.revision },
  });
  // The owner points the alias at another model after the member resolved.
  f.native.proxy.registry.saveRoute({
    id: f.route.id,
    connectionId: f.connection.id,
    alias: "native/coder",
    upstreamModel: "upstream-model-2",
  });
  f.service.native.setProxyState(f.native.proxy.view());
  const driver = (f.service.orchestration as any).driver;
  await expect(
    driver.launch({
      launchId: uid(),
      projectId: "p",
      goalId: "g",
      roundId: "r",
      roleId: "coordinator",
      memberId: "native-coordinator",
      assignment: resolved.assignments[0],
      purpose: "coordinator-contribution",
      phase: "initial",
      prompt: "Plan.",
      inputDigest: "d",
      candidateId: null,
      permittedOutputs: [],
      retryOfAttemptId: null,
      protocol: { kind: "coordinator-v1" },
      contextCandidateId: null,
    }),
  ).rejects.toThrow(/changed since it was assigned/);
  expect(f.native.upstream.calls).toHaveLength(0);
});

/** A coordinator that only ever reads: it never answers. */
const endlessReader: Script = () => ({
  events: reply([{ tool: "read_file", args: { path: "file.ts" } }]),
});

test("a native member turn is a bounded episode: a used request budget ends it as failed, and the engine's retry allowance decides what follows", async () => {
  const f = await setup(() => endlessReader);
  await group(f.service, "coordinator", [
    nativeMember("native-coordinator", f.route.id),
  ]);
  const posted = await post(f.service, "Change the value to two.");
  const goal = await untilGoal(f.service, posted.goal.id, ["blocked"]);
  const coordination = (
    f.service.orchestration.rounds(goal.id) as RoleRound[]
  ).find((r) => r.kind === "coordination")!;
  const member = coordination.members[0];
  // One first attempt and the one retry the default policy allows; each
  // ended at its budget of 50 requests, never paused forever.
  expect(member.attemptIds).toHaveLength(2);
  expect(member.state).toBe("failed");
  expect(member.detail).toMatch(/ended without an answer: This attempt used its 50 model requests/);
  for (const id of member.attemptIds) {
    const view = f.service.native.harness.view(id)!;
    expect(view.state).toBe("cancelled");
    expect(view.requests).toBe(50);
  }
  expect(f.native.upstream.calls).toHaveLength(100);
}, 120_000);

test("a native member paused for no progress waits instead of restarting, and Stop cancels it", async () => {
  // An implementer that keeps sending an edit with a wrong expected hash.
  const f = await setup((scratch) => {
    const base = memberScript(scratch);
    return (call, index) =>
      /When done, reply/.test(promptOf(call))
        ? {
            events: reply([
              {
                tool: "edit_file",
                args: {
                  path: "file.ts",
                  old_text: "value = 1",
                  new_text: "value = 2",
                  expected_sha256: "0".repeat(64),
                },
              },
            ]),
          }
        : base(call, index);
  });
  await group(f.service, "coordinator", [vendor("astra", "fixture-astra")]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [vendor("sol", "fixture-sol")]);
  const posted = await post(f.service, "Change the value to two.");
  const work = async () =>
    (f.service.orchestration.rounds(posted.goal.id) as RoleRound[]).find(
      (r) => r.kind === "work",
    );
  await vi.waitFor(
    async () => {
      await f.service.orchestration.tick();
      expect((await work())?.members[0].detail).toMatch(
        /^Waiting: Paused for no progress/,
      );
    },
    { timeout: 60_000, interval: 100 },
  );
  const member = (await work())!.members[0];
  const attemptId = member.activeAttemptId!;
  expect(member.state).toBe("running");
  expect(f.service.native.harness.view(attemptId)).toMatchObject({
    state: "paused",
    pauseKind: "repetition",
  });
  // Further ticks start no replacement.
  for (let i = 0; i < 5; i++) await f.service.orchestration.tick();
  expect((await work())!.members[0].attemptIds).toEqual([attemptId]);
  // Stopping the goal cancels the native attempt (and any descendants).
  await f.service.command({
    type: "orchestration-control",
    projectId: "p",
    goalId: posted.goal.id,
    action: "stop",
    commandId: `c-${uid()}`,
  });
  await vi.waitFor(
    async () => {
      await f.service.orchestration.tick();
      expect(f.service.native.harness.view(attemptId)!.state).toBe(
        "cancelled",
      );
      expect(f.service.store.get<Goal>("goal", posted.goal.id)!.state).toBe(
        "stopped",
      );
    },
    { timeout: 30_000, interval: 100 },
  );
}, 120_000);

// ---------------------------------------------------------------------------
// The harness's member turns, directly (no control service).

async function memberHarness(script: Script) {
  const { nativeFixture } = await import("./native-fixture");
  const f = await nativeFixture(script);
  cleanups.push(() => f.close());
  let n = 0;
  const copy = async () => {
    const root = path.join(f.directory, `member-copy-${++n}`);
    execFileSync("mkdir", ["-p", root]);
    await writeFile(path.join(root, "file.ts"), "export const value = 1;\n");
    return root;
  };
  const start = async (
    routeAlias: string,
    schema: Record<string, unknown> | null = null,
    memberId = `member-${n + 1}`,
  ) =>
    f.harness.startMember({
      projectId: f.project.id,
      routeAlias,
      title: memberId,
      prompt: "Answer.",
      workspace: {
        root: await copy(),
        writable: false,
        baselineCandidateId: null,
      },
      outputSchema: schema ? { name: "answer", schema } : null,
      member: {
        goalId: "goal",
        roundId: "round",
        memberId,
        launchId: uid(),
        purpose: "coordinator-contribution",
        protocol: "coordinator-v1",
      },
      reasoningEffort: null,
      maxRequests: null,
    });
  return { ...f, start };
}

const answerSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { summary: { type: "string", minLength: 1, maxLength: 500 } },
  required: ["summary"],
  additionalProperties: false,
};

test("members on two routes of one account share one allowance wait, and all continue when the owner resumes it", async () => {
  let limited = true;
  const f = await memberHarness(() =>
    limited
      ? {
          status: 429,
          body: {
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: "Usage limit reached.",
            },
          },
        }
      : { events: reply([{ text: JSON.stringify({ summary: "Done." }) }]) },
  );
  const { connection } = f.chatgpt();
  f.route(connection.id, "chatgpt/a");
  f.route(connection.id, "chatgpt/b", "upstream-model-2");
  const owner = connection.account.quotaOwner!;
  const first = await f.start("chatgpt/a", answerSchema, "a");
  expect((await f.settle(first.attemptId)).state).toBe("waiting-quota");
  // The second member, on the other route, waits before any request.
  const second = await f.start("chatgpt/b", answerSchema, "b");
  expect((await f.settle(second.attemptId)).state).toBe("waiting-quota");
  expect(f.upstream.calls).toHaveLength(1);
  expect(f.harness.resources.quotaWait(owner)).not.toBeNull();
  // The owner tries the allowance again once: both member turns continue.
  limited = false;
  f.harness.resumeQuota(owner);
  await vi.waitFor(async () => {
    expect((await f.settle(first.attemptId)).state).toBe("completed");
    expect((await f.settle(second.attemptId)).state).toBe("completed");
  });
  expect(f.harness.view(first.attemptId)!.summary).toBe(
    JSON.stringify({ summary: "Done." }),
  );
  // A member turn's candidate is the driver's to capture, not the harness's.
  expect(f.harness.view(first.attemptId)!.candidateId).toBeNull();
  expect(f.upstream.calls).toHaveLength(3);
  // Both carried the schema (strict: every field required, objects closed).
  for (const call of f.upstream.calls.slice(1))
    expect(call.body.text.format).toEqual({
      type: "json_schema",
      name: "answer",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      strict: true,
    });
});

test("on a Messages route a member's schema is relaxed to what Anthropic accepts, and the instructions ask for the JSON alone", async () => {
  const f = await memberHarness(() => ({
    events: reply([{ text: JSON.stringify({ summary: "Done." }) }]),
  }));
  const { connection } = await f.apiKey("anthropic-api");
  await new Promise((r) => setTimeout(r, 10));
  f.route(connection.id, "claude/api", "upstream-model-reported");
  const started = await f.start("claude/api", answerSchema);
  const view = await f.settle(started.attemptId);
  expect(view.state).toBe("completed");
  expect(view.reportedModel).toBe("upstream-model-reported");
  const body = f.upstream.calls[0].body;
  expect(f.upstream.calls[0].path).toBe("/anthropic/messages");
  expect(body.output_config).toEqual({
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  });
  expect(JSON.stringify(body.system)).toContain(
    "with only the JSON object your task describes",
  );
});

test("a member that needs a schema is refused on a route recorded as unable to enforce one", async () => {
  const f = await memberHarness(() => ({ events: reply([{ text: "{}" }]) }));
  const { connection } = await f.apiKey("openai-api");
  f.proxy.registry.saveRoute({
    connectionId: connection.id,
    alias: "gateway/plain",
    upstreamModel: "upstream-model",
    capabilities: { structuredOutput: "unsupported" },
  });
  await expect(f.start("gateway/plain", answerSchema)).rejects.toThrow(
    /unable to enforce a response schema/,
  );
  // A free-text turn on the same route is not refused.
  const plain = await f.start("gateway/plain", null);
  expect((await f.settle(plain.attemptId)).state).toBe("completed");
  expect(f.upstream.calls).toHaveLength(1);
  expect(f.upstream.calls[0].body).not.toHaveProperty("text");
});

test("a Topsl session takes a native coordinator beside a Codex one: both answer session-v1 intake in their schema", async () => {
  const f = await setup();
  const created = await f.service.command({
    type: "session-create",
    projectId: "p",
    configuration: {
      coordinators: [
        nativeMember("native-coordinator", f.route.id),
        vendor("astra", "fixture-astra"),
      ],
    },
    text: "What does file.ts hold?",
    mode: "discuss",
    kind: "code",
    commandId: `c-${uid()}`,
  });
  const intakeId = created.intakeId as string;
  await vi.waitFor(
    async () => {
      await f.service.orchestration.tick();
      await f.service.sessions.tick();
      expect(
        f.service.store.get<{ stage: string }>("session-intake", intakeId)
          ?.stage,
      ).toBe("decided");
    },
    { timeout: 60_000, interval: 100 },
  );
  const intake = f.service.store.get<{
    members: Array<{ provider: string; state: string; installationId: string }>;
    outcome: { kind: string; intent: string };
  }>("session-intake", intakeId)!;
  expect(intake.outcome).toMatchObject({ kind: "reply", intent: "discuss" });
  expect(
    intake.members
      .filter((m) => m.provider === "native")
      .map((m) => [m.installationId, m.state]),
  ).toContainEqual([f.route.id, "returned"]);
  // The native coordinator's requests asked for the session-v1 intake schema.
  expect(
    f.native.upstream.calls.some((c) =>
      String(c.body.text?.format?.name).startsWith(
        "session-v1_coordinator-contribution",
      ),
    ),
  ).toBe(true);
}, 120_000);

test("stopping a native attempt cancels its running descendants", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  cleanups.push(async () => release());
  const f = await memberHarness((call) => {
    const text = call.request.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n");
    // The child's request never answers until the test ends.
    if (text.includes("CHILD TASK"))
      return { events: reply([{ text: "late" }]), hold: held };
    return {
      events: reply([
        {
          tool: "delegate",
          args: { mode: "fresh", task: "CHILD TASK: read", writable: false },
        },
      ]),
    };
  });
  const { connection } = f.chatgpt();
  f.route(connection.id, "chatgpt/test");
  // A native task with delegation: member turns get no delegation tool.
  const task = await f.harness.start({
    projectId: f.project.id,
    prompt: "Delegate a read",
    routeAlias: "chatgpt/test",
    mode: "investigate",
    processes: false,
    networkDomains: [],
    checks: [],
    delegation: true,
    mcpServerIds: [],
    reasoningEffort: null,
    contextWindowTokens: null,
    maxRequests: null,
  });
  await vi.waitFor(() =>
    expect(f.harness.view(task.attemptId)!.children).toHaveLength(1),
  );
  const child = f.harness.view(task.attemptId)!.children[0];
  await vi.waitFor(() =>
    expect(f.harness.view(child)!.state).toBe("waiting-model"),
  );
  await f.harness.cancel(task.attemptId);
  expect(f.harness.view(task.attemptId)!.state).toBe("cancelled");
  expect(f.harness.view(child)!.state).toBe("cancelled");
});

/**
 * Loop turns judge the target's file.ts, so the synthetic model reads it
 * with read_file first and answers from what it read.
 */
function loopScript(scratch: string): Script {
  const base = memberScript(scratch);
  return async (call, index) => {
    const prompt = promptOf(call);
    if (
      !/"protocolKind": "recursive-loop-v1"/.test(prompt) ||
      !/Stage: \w+\./.test(prompt)
    )
      return base(call, index);
    const turn = call.request.messages.filter(
      (m) => m.role === "assistant",
    ).length;
    if (turn === 0)
      return { events: reply([{ tool: "read_file", args: { path: "file.ts" } }]) };
    const seen = path.join(scratch, `loop-turn-${index}`);
    execFileSync("mkdir", ["-p", seen]);
    await writeFile(
      path.join(seen, "file.ts"),
      lastResults(call.request)[0]?.output ?? "",
    );
    return { events: reply([{ text: answer(prompt, seen) }]) };
  };
}

test("a Goal loop with a native coordinator and implementer answers recursive-loop-v1 through the proxy and promotes its result", async () => {
  const f = await setup(loopScript);
  await f.service.command({ type: "loop-feature-set", enabled: true });
  await group(f.service, "coordinator", [
    nativeMember("native-coordinator", f.route.id),
  ]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [vendor("sol", "fixture-sol")]);
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode: "goal",
    text: "Change the value to two.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id as string;
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
  };
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  await vi.waitFor(
    async () => {
      await f.service.orchestration.tick();
      await f.service.loops.tick();
      expect(
        ["completed", "waiting", "stopped"].includes(
          f.service.loops.view(runId).run.state,
        ),
      ).toBe(true);
    },
    { timeout: 120_000, interval: 100 },
  );
  const view = f.service.loops.view(runId);
  expect(view.run.state).toBe("completed");
  expect(view.checkpoint!.sequence).toBe(1);
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
  ).toBe("export const value = 2;\n");
  // Decision turns went through the native route in the loop's own schema,
  // and the native implementer made the change.
  const formats = f.native.upstream.calls.map(
    (c) => c.body.text?.format?.name as string,
  );
  expect(
    formats.some((n) => n.startsWith("recursive-loop-v1_coordinator-contribution")),
  ).toBe(true);
  expect(formats).toContain("coordinator-v1_implementation");
  // Native turns count in the loop's accounting with their reported usage.
  expect(view.usage.memberTurns).toBeGreaterThan(0);
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );
}, 180_000);

/** Starts a loop run in `mode` with the loop feature on and its authority confirmed. */
async function startLoop(
  f: Awaited<ReturnType<typeof setup>>,
  mode: "goal" | "endless",
) {
  await f.service.command({ type: "loop-feature-set", enabled: true });
  const created = await f.service.command({
    type: "loop-create",
    projectId: "p",
    conversationId: null,
    mode,
    text: "Change the value to two.",
    policy: { scheduling: { reserveForDirectWork: 0 } },
    commandId: `c-${uid()}`,
  });
  const runId = created.run.id as string;
  const authority = f.service.review("loop-authority", runId) as {
    digest: string;
  };
  await f.service.command(
    { type: "loop-start", runId, commandId: `c-${uid()}` },
    { digest: authority.digest },
  );
  return runId;
}

test("a Goal loop with a Claude Code coordinator, a native GPT implementer and a native reviewer completes through the existing acceptance protocol", async () => {
  // Plan Phase 5: loop control stays in the loop engine; execution beneath it
  // spans Claude Code and the native harness. Stand-ins and a synthetic
  // upstream only.
  const f = await setup(loopScript);
  await group(f.service, "coordinator", [claudeMember("claude-coordinator")]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [
    nativeMember("native-reviewer", f.route.id),
  ]);
  const runId = await startLoop(f, "goal");
  await vi.waitFor(
    async () => {
      await f.service.orchestration.tick();
      await f.service.loops.tick();
      expect(
        ["completed", "waiting", "stopped"].includes(
          f.service.loops.view(runId).run.state,
        ),
      ).toBe(true);
    },
    { timeout: 120_000, interval: 100 },
  );
  const view = f.service.loops.view(runId);
  expect(view.run.state).toBe("completed");
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
  ).toBe("export const value = 2;\n");
  // Both engines took turns: Claude Code sessions and native harness turns.
  const engines = new Set(
    f.service.orchestration.repo
      .all<{ provider: string }>("member-session", "p")
      .map((s) => s.provider),
  );
  expect([...engines].sort()).toEqual(["claude", "native"]);
  expect(await readFile(path.join(f.project, "file.ts"), "utf8")).toBe(
    "export const value = 1;\n",
  );
}, 180_000);

test("an Endless loop across Claude Code and native members improves once, monitors, and Stop fences every engine", async () => {
  // Plan Phase 5: Endless continues until stopped; each attempt stays
  // bounded; after Stop nothing new launches on either engine.
  const f = await setup(loopScript);
  await group(f.service, "coordinator", [
    claudeMember("claude-coordinator"),
    nativeMember("native-coordinator", f.route.id),
  ]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [claudeMember("claude-reviewer")]);
  const runId = await startLoop(f, "endless");
  const settle = async () => {
    await f.service.orchestration.tick();
    await f.service.loops.tick();
  };
  await vi.waitFor(
    async () => {
      await settle();
      expect(f.service.loops.view(runId).run.state).toBe("monitoring");
    },
    { timeout: 120_000, interval: 100 },
  );
  expect(f.service.loops.view(runId).checkpoint!.sequence).toBe(1);
  await f.service.command({
    type: "loop-control",
    runId,
    action: "stop",
    commandId: `c-${uid()}`,
  });
  await vi.waitFor(
    async () => {
      await settle();
      expect(f.service.loops.view(runId).run.state).toBe("stopped");
    },
    { timeout: 60_000, interval: 100 },
  );
  const attempts = () =>
    [...f.service.store.iterate<{ state: string }>("attempt")].length;
  const before = { attempts: attempts(), upstream: f.native.upstream.calls.length };
  for (let i = 0; i < 20; i++) await settle();
  expect(attempts()).toBe(before.attempts);
  expect(f.native.upstream.calls.length).toBe(before.upstream);
  // No member turn of either engine is still running.
  expect(
    [...f.service.store.iterate<{ state: string }>("attempt")].filter(
      (a) => a.state === "running" || a.state === "starting",
    ),
  ).toEqual([]);
  // Nor is any native harness turn still running in its kernel.
  const native = f.service.native.harness
    .list("p", null, 200)
    .items.map((v) => v.attemptId);
  expect(native.length).toBeGreaterThan(0);
  expect(
    native.filter((id) => f.service.native.harness.kernel.isRunning(id)),
  ).toEqual([]);
}, 180_000);

test("a Claude Code turn that reports API-key credentials is recorded as a funding conflict, never as a subscription turn", async () => {
  // Plan §9: conflicting Claude API credential. The fixture route is not
  // live, so the turn is not stopped at init (a live turn is); what it ran
  // on is still recorded against what its assignment asked for.
  const f = await setup(undefined, [
    "--fixture-api-key-source",
    "ANTHROPIC_API_KEY",
  ]);
  await group(f.service, "coordinator", [
    nativeMember("native-coordinator", f.route.id),
  ]);
  await group(f.service, "implementer", [claudeMember("claude-implementer")]);
  await group(f.service, "reviewer", [
    nativeMember("native-reviewer", f.route.id),
  ]);
  const posted = await post(f.service, "Change the value to two.");
  const goal = await untilGoal(f.service, posted.goal.id, [
    "awaiting-acceptance",
    "blocked",
  ]);
  const member = f.service.orchestration
    .goalView(goal.id)
    .rounds.flatMap((r: any) => r.members)
    .find((m: any) => m.memberId === "claude-implementer");
  expect(member.funding).toMatchObject({
    requested: "subscription",
    observed: "api-billing",
    state: "conflict",
    source: "Claude Code init record",
  });
  expect(member.funding.detail).toContain("ANTHROPIC_API_KEY");
});

test("funding observations: unknown is never a match, and a differing report is a conflict", () => {
  expect(requestedFunding({ billingRoute: "native-subscription" })).toBe(
    "subscription",
  );
  expect(requestedFunding({ billingRoute: null })).toBe("unknown");
  expect(
    requestedFunding({ billingRoute: null, native: { funding: "gateway" } }),
  ).toBe("external-service");
  expect(fundingObservation("subscription", null)).toMatchObject({
    observed: "unknown",
    state: "unknown",
  });
  expect(
    fundingObservation("unknown", {
      observed: "subscription",
      source: "s",
      detail: "d",
    }).state,
  ).toBe("unknown");
  expect(
    fundingObservation("subscription", {
      observed: "api-billing",
      source: "s",
      detail: "d",
    }).state,
  ).toBe("conflict");
  expect(
    fundingObservation("local", { observed: "local", source: "s", detail: "d" })
      .state,
  ).toBe("matches");
});

/** A job request a coordinator makes in the delegation tests. */
const surveyJob = {
  title: "Survey file.ts",
  brief: "Report what file.ts exports and its current value.",
  kind: "information",
  role: "researcher",
  idempotency_key: "survey-1",
};

test("agent jobs: a native GPT coordinator requests a Claude Code child; Topsl records it once, admits it after the plan commits and runs it", async () => {
  // Plan Phase 6 and §7: an attempt-bound job tool, idempotent per key; the
  // same key with different arguments is a conflict; the child runs on the
  // engine its role resolves to. Stand-ins and a synthetic upstream only.
  const answers: string[] = [];
  const script = (scratch: string): Script => {
    const base = memberScript(scratch);
    return (call, index) => {
      const prompt = promptOf(call);
      if (!/Snapshot digest \(echo it exactly\)/.test(prompt))
        return base(call, index);
      const turn = call.request.messages.filter(
        (m) => m.role === "assistant",
      ).length;
      if (turn > 0) answers.push(lastResults(call.request)[0].output);
      if (turn === 0 || turn === 1)
        return { events: reply([{ tool: "start_agent_job", args: surveyJob }]) };
      if (turn === 2)
        return {
          events: reply([
            {
              tool: "start_agent_job",
              args: { ...surveyJob, title: "A different survey" },
            },
          ]),
        };
      return base(call, index);
    };
  };
  const f = await setup(script);
  await f.service.command({ type: "agent-jobs-set", enabled: true });
  await group(f.service, "coordinator", [
    nativeMember("native-coordinator", f.route.id),
  ]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [
    nativeMember("native-reviewer", f.route.id),
  ]);
  await group(f.service, "researcher", [claudeMember("claude-researcher")]);
  const posted = await post(f.service, "Change the value to two.");
  const goal = await untilGoal(f.service, posted.goal.id, [
    "awaiting-acceptance",
    "blocked",
  ]);
  expect(goal.state).toBe("awaiting-acceptance");

  // The retry returned the same job; the changed request was refused.
  const first = JSON.parse(answers[0]),
    retry = JSON.parse(answers[1]);
  expect(first.job_id).toMatch(/^[a-f0-9]{32}$/);
  expect(retry.job_id).toBe(first.job_id);
  expect(answers[2]).toContain("already names a different job request");
  const jobs = [...f.service.store.iterate<any>("agent-job")];
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    state: "completed",
    goalId: goal.id,
    parentMemberId: "native-coordinator",
  });
  expect(f.service.orchestration.goalView(goal.id).agentJobs).toEqual([
    expect.objectContaining({
      id: jobs[0].id,
      title: "Survey file.ts",
      roleId: "researcher",
      state: "completed",
      parentMemberId: "native-coordinator",
    }),
  ]);
  // The child ran as an ordinary round on Claude Code.
  const child = (f.service.orchestration.rounds(goal.id) as RoleRound[]).find(
    (r) => r.taskKey === jobs[0].task.key,
  )!;
  expect(child.members.map((m) => [m.memberId, m.provider, m.state])).toEqual([
    ["claude-researcher", "claude", "returned"],
  ]);
  // Only the coordinator's turn was offered the job tools.
  const toolNames = (call: (typeof f.native.upstream.calls)[number]) =>
    ((call.body.tools ?? []) as Array<{ name?: string }>).map((t) => t.name);
  const offered = f.native.upstream.calls.filter((c) =>
    toolNames(c).includes("start_agent_job"),
  );
  expect(offered.length).toBeGreaterThan(0);
  expect(
    offered.every((c) => /Snapshot digest \(echo it exactly\)/.test(promptOf(c))),
  ).toBe(true);
});

test("agent jobs: with the owner's gate off, no turn is offered the job tools", async () => {
  const f = await setup();
  await group(f.service, "coordinator", [
    nativeMember("native-coordinator", f.route.id),
  ]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [vendor("sol", "fixture-sol")]);
  const posted = await post(f.service, "Change the value to two.");
  await untilGoal(f.service, posted.goal.id, ["awaiting-acceptance", "blocked"]);
  expect(
    f.native.upstream.calls.some((c) =>
      ((c.body.tools ?? []) as Array<{ name?: string }>).some(
        (t) => t.name === "start_agent_job",
      ),
    ),
  ).toBe(false);
  expect([...f.service.store.iterate("agent-job-authority")]).toEqual([]);
});

test("agent jobs: a Claude Code coordinator requests a native GPT child through Topsl's MCP server", async () => {
  const log = path.join(
    await mkdtemp(path.join(os.tmpdir(), "topsl-job-log-")),
    "answers.jsonl",
  );
  cleanups.push(() => rm(path.dirname(log), { recursive: true, force: true }));
  const f = await setup(undefined, [
    "--fixture-agent-job",
    JSON.stringify(surveyJob),
    "--fixture-agent-job-log",
    log,
  ]);
  await f.service.command({ type: "agent-jobs-set", enabled: true });
  await group(f.service, "coordinator", [claudeMember("claude-coordinator")]);
  await group(f.service, "implementer", [
    nativeMember("native-implementer", f.route.id),
  ]);
  await group(f.service, "reviewer", [claudeMember("claude-reviewer")]);
  await group(f.service, "researcher", [
    nativeMember("native-researcher", f.route.id),
  ]);
  const posted = await post(f.service, "Change the value to two.");
  const goal = await untilGoal(f.service, posted.goal.id, [
    "awaiting-acceptance",
    "blocked",
  ]);
  expect(goal.state).toBe("awaiting-acceptance");
  const answers = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(JSON.parse(line)));
  expect(answers).toHaveLength(2);
  expect(answers[1].job_id).toBe(answers[0].job_id);
  const jobs = [...f.service.store.iterate<any>("agent-job")];
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    state: "completed",
    parentMemberId: "claude-coordinator",
  });
  const child = (f.service.orchestration.rounds(goal.id) as RoleRound[]).find(
    (r) => r.taskKey === jobs[0].task.key,
  )!;
  expect(child.members.map((m) => [m.memberId, m.provider, m.state])).toEqual([
    ["native-researcher", "native", "returned"],
  ]);
});

test.skipIf(process.platform !== "darwin")(
  "a native implementer runs the goal's configured check in its own copy before it submits; other members get no check tool",
  async () => {
    // Plan Phase 7: a member capability added for a purpose, not a role
    // name. The check runs contained in the member's copy; Topsl still runs
    // the required check on the integrated candidate.
    const checkResults: string[] = [];
    const script = (scratch: string): Script => {
      const base = memberScript(scratch);
      return (call, index) => {
        const prompt = promptOf(call);
        if (!/When done, reply/.test(prompt)) return base(call, index);
        const turn = call.request.messages.filter(
          (m) => m.role === "assistant",
        ).length;
        if (turn === 2)
          return {
            events: reply([{ tool: "run_check", args: { name: "value-check" } }]),
          };
        if (turn === 3) checkResults.push(lastResults(call.request)[0].output);
        return base(call, index);
      };
    };
    const f = await setup(script);
    await group(f.service, "coordinator", [
      nativeMember("native-coordinator", f.route.id),
    ]);
    await group(f.service, "implementer", [
      nativeMember("native-implementer", f.route.id),
    ]);
    await group(f.service, "reviewer", [
      nativeMember("native-reviewer", f.route.id),
    ]);
    const conversation = await f.service.command({
      type: "orchestration-conversation-create",
      projectId: "p",
      title: "",
      commandId: `c-${uid()}`,
    });
    const posted = await f.service.command({
      type: "orchestration-message",
      conversationId: conversation.id,
      text: "Change the value to two.",
      goalId: null,
      routing: "auto",
      kind: "code",
      checks: [
        {
          id: "value-check",
          label: "value is two",
          executable: "/bin/sh",
          args: ["-c", "grep -q 'value = 2' file.ts"],
          timeoutMs: 20_000,
        },
      ],
      commandId: `c-${uid()}`,
    } as any);
    // The member's own check does not replace Topsl's: the goal waits for
    // the owner to run the required check on the integrated candidate.
    const goal = await untilGoal(f.service, posted.goal.id, [
      "checking",
      "blocked",
    ]);
    expect(goal.state).toBe("checking");
    expect(checkResults).toHaveLength(1);
    expect(checkResults[0]).toMatch(/Check value-check/);
    expect(checkResults[0]).toMatch(/exited with code 0/);
    const names = (call: (typeof f.native.upstream.calls)[number]) =>
      ((call.body.tools ?? []) as Array<{ name?: string }>).map((t) => t.name);
    for (const call of f.native.upstream.calls)
      expect(names(call).includes("run_check")).toBe(
        /When done, reply/.test(promptOf(call)),
      );
  },
  180_000,
);

test("a turn recorded before funding was observed reads as not recorded, never as a match", () => {
  // Plan Phase 9: new fields are added conservatively; missing historical
  // evidence stays unknown.
  expect(memberFunding("subscription", undefined)).toBeNull();
  expect(memberFunding("subscription", {})).toMatchObject({
    requested: "subscription",
    observed: "unknown",
    state: "unknown",
    source: "not recorded",
  });
  const recorded = fundingObservation("api-billing", {
    observed: "api-billing",
    source: "proxy route binding",
    detail: "d",
  });
  expect(memberFunding("api-billing", { funding: recorded })).toBe(recorded);
});
