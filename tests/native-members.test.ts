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
