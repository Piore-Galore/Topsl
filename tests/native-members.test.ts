import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { Service } from "../apps/service/service";
import { CodexAdapter } from "../packages/providers/codex";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import { hash, now, uid } from "../packages/domain/invariants";
import type { Installation } from "../packages/domain/types";
import type {
  Goal,
  MemberIntent,
  ParticipantContribution,
  RoleRound,
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

async function setup(script?: (scratch: string) => Script) {
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
