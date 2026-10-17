import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fixture } from "./helpers";
import {
  RuntimeAcceptanceRegistry,
  runtimeBindingId,
  type RuntimeBinding,
  type RuntimeProbeObservation,
} from "../packages/providers/acceptance";
import {
  evaluateRoleReadiness,
  roleRequirements,
} from "../packages/providers/readiness";
import { runtimeBinding } from "../packages/providers/runtime-binding";
import { CodexAdapter } from "../packages/providers/codex";
import {
  ClaudeStreamParser,
  type ClaudeStreamEvent,
} from "../packages/providers/claude";
import type {
  PreparedTurn,
  ProviderConnection,
} from "../packages/providers/contract";
import { RuntimeManager } from "../packages/runtime/manager";
import { AssistedWorkflows } from "../packages/workflows/assisted";
import { captureCandidate } from "../packages/workflows/candidates";
import { commandSchema } from "../packages/domain/commands";
import { now } from "../packages/domain/invariants";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function setup() {
  const f = await fixture();
  cleanup.push(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const registry = new RuntimeAcceptanceRegistry(f.store),
    binding = runtimeBinding(f.installation, {
      accountKey: "account",
      profileId: "profile",
      billingRoute: "native-subscription",
    });
  return { ...f, registry, binding };
}
const expires = () => new Date(Date.now() + 60_000).toISOString();
function observations(names: string[]): RuntimeProbeObservation[] {
  return names.map((capability) => ({
    capability,
    meaning: ["read-only", "workspace-write", "independent-isolation"].includes(
      capability,
    )
      ? "policy-enforced"
      : "behavior-observed",
    source: "trusted-runtime-validation",
    operationId: `unit-observation:${capability}`,
    observedAt: now(),
    passed: true,
    negativeControl: {
      operationAttempted: true,
      trustedStateChecked: true,
      denied: true,
    },
    detail:
      "Synthetic trusted-suite contract observation; no live provider acceptance.",
  }));
}
const models = [
  {
    id: "chosen",
    model: "chosen",
    name: "Chosen",
    description: "runtime fixture",
    isDefault: true,
    supportedReasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    metadataSource: "runtime" as const,
  },
];

describe("R2-AT-09/10/11: trusted role readiness", () => {
  test("read-only reviewer qualifies without implementer workspace writes; observation is distinct from enforcement", async () => {
    const f = await setup();
    f.registry.recordTrustedValidation(
      f.binding,
      observations(roleRequirements("reviewer")),
      expires(),
    );
    const result = f.registry.resolve(f.binding, f.installation),
      common = {
        selection: {
          installationId: f.installation.id,
          provider: "codex" as const,
          model: "chosen",
          effort: "high",
        },
        installation: f.installation,
        models,
        ...result,
      };
    expect(
      result.capabilities.find((c) => c.name === "structured-turn")?.support,
    ).toBe("observable-only");
    expect(
      result.capabilities.find((c) => c.name === "read-only")?.support,
    ).toBe("enforceable");
    expect(evaluateRoleReadiness({ ...common, role: "reviewer" }).ready).toBe(
      true,
    );
    expect(
      evaluateRoleReadiness({ ...common, role: "implementer" }).blockers.some(
        (b) => b.detail.includes("workspace-write"),
      ),
    ).toBe(true);
  });
  test("fixture/import/model records, missing negative controls, renderer promotion and tampering are rejected", async () => {
    const f = await setup(),
      input = observations(["read-only"]);
    for (const source of ["fixture", "import", "model-statement"] as const)
      expect(() =>
        f.registry.recordTrustedValidation(
          f.binding,
          [{ ...input[0], source }],
          expires(),
        ),
      ).toThrow("rejected");
    expect(() =>
      f.registry.recordTrustedValidation(
        f.binding,
        [{ ...input[0], negativeControl: null }],
        expires(),
      ),
    ).toThrow("negative control");
    expect(
      commandSchema.safeParse({
        type: "runtime-acceptance-promote",
        binding: f.binding,
        observations: input,
      }).success,
    ).toBe(false);
    const accepted = f.registry.recordTrustedValidation(
      f.binding,
      input,
      expires(),
    );
    f.store.put("runtime-acceptance", {
      ...accepted,
      observations: observations(["workspace-write"]),
    });
    expect(f.registry.resolve(f.binding, f.installation).capabilities).toEqual(
      [],
    );
    expect(JSON.stringify(f.registry)).not.toContain(
      f.store.get<{ value: string }>("runtime-acceptance-authority", "local")!
        .value,
    );
  });
  test("all execution-critical bindings invalidate only matching acceptance; fresh revalidation supersedes an old invalidation", async () => {
    const f = await setup(),
      record = f.registry.recordTrustedValidation(
        f.binding,
        observations(["read-only"]),
        expires(),
      );
    const changes: Partial<RuntimeBinding>[] = [
      { executableIdentity: "different" },
      { runtimeRevision: "different" },
      { runtimeVersion: "new" },
      { adapterProtocol: "next" },
      { profileId: "next" },
      { accountKey: "next" },
      { policyHash: "next" },
      { sandboxHash: "next" },
      { hostId: "other" },
      { platform: "other" },
      { arch: "other" },
    ];
    for (const change of changes)
      expect(
        f.registry.resolve({ ...f.binding, ...change }, f.installation)
          .freshness.state,
      ).toBe("stale");
    f.registry.invalidate(record.bindingId, "selected runtime changed");
    expect(f.registry.resolve(f.binding, f.installation).capabilities).toEqual(
      [],
    );
    const next = f.registry.recordTrustedValidation(
      f.binding,
      observations(["read-only"]),
      expires(),
    );
    expect(next.id).not.toBe(record.id);
    expect(f.registry.resolve(f.binding, f.installation).freshness.state).toBe(
      "current",
    );
    expect(f.registry.history(f.installation.id)).toHaveLength(2);
    expect(runtimeBindingId(f.binding)).toBe(record.bindingId);
  });
  test("Codex's own folder entries leave the policy fingerprint unchanged; any other setting changes it", async () => {
    const f = await setup(),
      home = path.join(f.directory, "codex-home"),
      policy = async (text: string) => {
        await writeFile(path.join(home, "config.toml"), text);
        return runtimeBinding(f.installation, {
          accountKey: "account",
          profileId: "profile",
          billingRoute: "native-subscription",
        }).policyHash;
      };
    await mkdir(home);
    vi.stubEnv("CODEX_HOME", home);
    cleanup.push(async () => {
      vi.unstubAllEnvs();
    });
    const settings = 'model = "chosen"\napproval_policy = "untrusted"\n',
      // Codex adds an entry like this the first time it works in a folder.
      entry = '\n[projects."/work/new-project"]\ntrust_level = "trusted"\n',
      before = await policy(settings);
    expect(await policy(settings + entry)).toBe(before);
    for (const changed of [
      'model = "other"\napproval_policy = "untrusted"\n',
      'model = "chosen"\napproval_policy = "never"\n',
      settings + 'sandbox_mode = "danger-full-access"\n',
    ])
      expect(await policy(changed + entry)).not.toBe(before);
    expect(await policy(settings + "model_context_window = 1\n")).not.toBe(
      await policy(settings + "model_context_window = 1.0\n"),
    );
    // A file that does not parse is compared byte for byte.
    const broken = await policy(settings + "[projects\n");
    expect(await policy(settings + "[projects\n\n")).not.toBe(broken);
  });
  test("trusted executable alone remains blocked, unsupported effort blocks broker readiness, and rollout disable cannot promote a route", async () => {
    const f = await setup(),
      manager = new RuntimeManager(
        f.store,
        () => {},
        () => {},
      );
    cleanup.unshift(async () => {
      await manager.close();
    });
    const selection = {
      installationId: f.installation.id,
      provider: "codex" as const,
      model: "chosen",
      effort: "max",
    };
    expect(manager.readiness(f.installation, selection, "reviewer").ready).toBe(
      false,
    );
    expect(() =>
      manager.assertReady(f.installation, selection, "reviewer"),
    ).toThrow("unsupported-model-setting");
    f.store.put("preference", {
      id: "round-2-rollout",
      disabled: ["qualified-structured-routes"],
    });
    expect(
      manager
        .readiness(f.installation, selection, "reviewer")
        .blockers.some((b) => b.code === "route-disabled"),
    ).toBe(true);
    expect(f.store.list("run")).toEqual([]);
  });
});

describe("R2-AT-13/15: runtime protocol metadata", () => {
  test("Claude partial/final duplicates and additive informational events do not duplicate text/usage; authority-bearing unknown events fail", () => {
    const events: ClaudeStreamEvent[] = [],
      parser = new ClaudeStreamParser((e) => events.push(e));
    const records = [
      { type: "system", subtype: "init", session_id: "s", uuid: "init" },
      {
        type: "stream_event",
        session_id: "s",
        uuid: "start",
        event: { type: "message_start", message: { id: "m" } },
      },
      {
        type: "stream_event",
        session_id: "s",
        uuid: "d",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        },
      },
      {
        type: "assistant",
        session_id: "s",
        uuid: "a",
        message: { id: "m", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "assistant",
        session_id: "s",
        uuid: "a2",
        message: { id: "m", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "rate_limit_event",
        session_id: "s",
        uuid: "info",
        unretained: "payload",
      },
      {
        type: "result",
        session_id: "s",
        uuid: "r",
        subtype: "success",
        is_error: false,
        result: "hello",
        usage: { input_tokens: 10 },
      },
      {
        type: "result",
        session_id: "s",
        uuid: "r2",
        subtype: "success",
        is_error: false,
        result: "hello",
        usage: { input_tokens: 10 },
      },
    ];
    parser.push(records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    parser.finish();
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);
    expect(events.filter((e) => e.type === "delta")).toHaveLength(1);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("unretained");
    expect(() =>
      new ClaudeStreamParser(() => {}).push(
        '{"type":"control_request","request":{"allow":true}}\n',
      ),
    ).toThrow("Unsupported");
  });
  test("Claude per-content-block assistant records with one message id accumulate text instead of failing", () => {
    const events: ClaudeStreamEvent[] = [],
      parser = new ClaudeStreamParser((e) => events.push(e));
    const block = (uuid: string, content: unknown[]) => ({
      type: "assistant",
      session_id: "s",
      uuid,
      message: { id: "m", content },
    });
    const records = [
      { type: "system", subtype: "init", session_id: "s", uuid: "init" },
      block("a1", [{ type: "thinking", thinking: "private" }]),
      block("a2", [{ type: "text", text: "first" }]),
      block("a3", [{ type: "tool_use", id: "tool-1", name: "Read" }]),
      block("a4", [{ type: "text", text: "second" }]),
      block("a5", [{ type: "text", text: "second" }]),
    ];
    parser.push(records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const messages = events.filter((e) => e.type === "message");
    expect(messages.map((e) => e.type === "message" && e.text)).toEqual([
      "first",
      "first\nsecond",
    ]);
    expect(new Set(messages.map((e) => e.sourceId))).toEqual(new Set(["m"]));
    expect(events.filter((e) => e.type === "tool")).toHaveLength(1);
  });
  test("Codex paginates catalog, keeps model/effort modalities, thread/session identities, instruction provenance and output schema", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const connection = {
      initialize: async () => ({}),
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "model/list")
          return params.cursor
            ? { data: [{ id: "b", model: "second" }], nextCursor: null }
            : {
                data: [
                  {
                    id: "a",
                    model: "chosen",
                    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
                    defaultReasoningEffort: "high",
                    inputModalities: ["text"],
                  },
                ],
                nextCursor: "next",
              };
        if (method === "account/read") return { account: null };
        if (method === "thread/start")
          return {
            thread: { id: "thread", sessionId: "session" },
            model: "chosen",
            reasoningEffort: "high",
            instructionSources: ["/provider/AGENTS.md"],
          };
        return {
          turn: { id: "turn" },
          model: "chosen",
          reasoningEffort: "high",
        };
      },
    } as unknown as ProviderConnection;
    const adapter = new CodexAdapter(),
      catalog = await adapter.inspect(connection);
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]).toMatchObject({
      supportedReasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
      inputModalities: ["text"],
      metadataSource: "runtime",
    });
    const turn: PreparedTurn = {
      prompt: "synthetic",
      cwd: "/sandbox",
      requestedModel: "chosen",
      requestedEffort: "high",
      outputSchema: { type: "object" },
      mode: "review",
      contextPackageId: null,
      attemptId: "attempt",
      workspaceIdentity: "workspace",
    };
    const session = await adapter.startSession(connection, turn, null);
    expect(session).toMatchObject({
      nativeThreadId: "thread",
      providerSessionId: "session",
      reportedEffort: "high",
    });
    expect(session.instructionSources?.[0]).toMatchObject({
      source: "runtime-reported",
      contentHash: null,
    });
    await adapter.startTurn(connection, turn, session.nativeThreadId!);
    expect(calls.find((c) => c.method === "turn/start")?.params).toMatchObject({
      threadId: "thread",
      effort: "high",
      outputSchema: { type: "object" },
    });
  });
});

async function assistedFixture() {
  const f = await setup();
  await writeFile(path.join(f.directory, "source.ts"), "one\ntwo\n");
  const candidate = await captureCandidate(f.store, {
    root: f.directory,
    projectId: "p",
    workflowId: "w",
    selectedPaths: ["source.ts"],
  });
  f.store.put("builder-reviewer", {
    id: "w",
    projectId: "p",
    candidateId: candidate.id,
    specificationId: "spec",
  });
  f.store.put("workflow-specification", {
    id: "spec",
    objective: "Review the pinned file",
  });
  const assisted = new AssistedWorkflows(f.store),
    handoff = await assisted.prepare({
      projectId: "p",
      workflowId: "w",
      installationId: f.installation.id,
      role: "reviewer",
      exportApproved: true,
    });
  return { ...f, candidate, assisted, handoff };
}
describe("R2-AT-12/14/16: assisted native operation", () => {
  test("opening intent retains external control after lost native reply and is never automatically replayed", async () => {
    const f = await assistedFixture();
    f.assisted.beginOpen("p", f.handoff.id);
    f.assisted.openUncertain("p", f.handoff.id);
    expect(
      f.store.get<any>("assisted-handoff-state", f.handoff.id),
    ).toMatchObject({
      state: "externally-controlled",
      externalWritingStopped: false,
    });
    expect(() => f.assisted.beginOpen("p", f.handoff.id)).toThrow(
      "never automatically replayed",
    );
    expect(f.store.list("assisted-open-intent")).toHaveLength(1);
    expect(f.store.list("run")).toHaveLength(0);
  });
  test("valid decoded line is accepted as attributed review; wrong line/JSON is preserved as invalid", async () => {
    const f = await assistedFixture(),
      base = {
        projectId: "p",
        id: f.handoff.id,
        candidateRevision: f.candidate.revision,
        specificationId: "spec",
        source: "user-supplied" as const,
        externalWritingStopped: true as const,
      };
    const report = (line: number) =>
      JSON.stringify({
        candidateRevision: f.candidate.revision,
        summary: "review",
        findings: [
          {
            title: "example",
            severity: "low",
            file: "source.ts",
            line,
            behavior: "observed",
            evidence: "synthetic",
          },
        ],
      });
    expect(
      (await f.assisted.import({ ...base, report: report(2) })).applicability,
    ).toBe("current");
    const invalid = await f.assisted.import({ ...base, report: report(5) });
    expect(invalid.applicability).toBe("invalid");
    expect(invalid.report).toBe(report(5));
    expect(invalid.acceptanceEligible).toBe(false);
    expect(
      (await f.assisted.import({ ...base, report: "not-json" })).applicability,
    ).toBe("invalid");
  });
  test("file/specification drift retains stale report and explicit stop confirmation; no managed acceptance is created", async () => {
    const f = await assistedFixture();
    f.assisted.beginOpen("p", f.handoff.id);
    await writeFile(path.join(f.directory, "source.ts"), "changed\n");
    const result = await f.assisted.import({
      projectId: "p",
      id: f.handoff.id,
      candidateRevision: f.candidate.revision,
      specificationId: "different",
      report: JSON.stringify({
        candidateRevision: f.candidate.revision,
        summary: "historical",
        findings: [],
      }),
      source: "native-import",
      externalWritingStopped: true,
    });
    expect(result).toMatchObject({
      applicability: "stale",
      source: "native-import",
      acceptanceEligible: false,
    });
    expect(
      f.store.get<any>("assisted-handoff-state", f.handoff.id)
        ?.externalWritingStopped,
    ).toBe(true);
    expect(f.store.list("assisted-stop-confirmation")).toHaveLength(1);
    expect(f.store.list("verification")).toHaveLength(0);
    await expect(
      f.assisted.prepare({
        projectId: "p",
        workflowId: "w",
        installationId: f.installation.id,
        role: "reviewer",
        exportApproved: true,
      }),
    ).rejects.toThrow();
  });
});
