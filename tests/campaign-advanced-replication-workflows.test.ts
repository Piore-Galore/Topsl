// Campaign 2026-10-19-comprehensive, packet p7-advanced-replication.
// Advanced collaboration templates and routing presets: AD-01..AD-11, the
// advanced-workflow mode enumeration (plan section 6.2) and journey J-13 at the
// local service layer. Isolation is supplied only by deterministic fixture drivers;
// production adapters expose no enforced access-policy route, which the service
// tests below assert directly.
import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers";
import { Coordinator } from "../packages/runtime/coordinator";
import {
  AdvancedCollaboration,
  advancedTemplates,
  type AdvancedCreate,
  type AdvancedDriver,
  type AdvancedIsolationPolicy,
} from "../packages/workflows/advanced";
import { hash, now, stable, uid } from "../packages/domain/invariants";
import type {
  ExecutionAttempt,
  Task,
  Workflow,
  Workspace,
} from "../packages/domain/workflow";
import type { Installation } from "../packages/domain/types";
import { captureCandidate } from "../packages/workflows/candidates";
import { Service } from "../apps/service/service";
import { commandSchema } from "../packages/domain/commands";
import { canonicalWorkspaceIdentity } from "../packages/workspace/ownership";
import type { Store } from "../packages/persistence/store";
import type { CoordinationRepository } from "../packages/persistence/repositories/coordination";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

const allCapabilities = [
  "structured-turn",
  "context-isolation",
  "filesystem-isolation",
  "tool-isolation",
  "fresh-session",
  "native-fanout-disabled",
  "workspace-write",
  "read-only",
];
type Capability = ReturnType<AdvancedDriver["capabilities"]>[number];
function capability(
  name: string,
  version: string,
  patch: Partial<Capability> = {},
): Capability {
  return {
    name,
    route: "structured",
    support: "enforceable",
    versions: [version],
    testedPlatforms: ["fixture-only"],
    restrictions: ["Deterministic fixture; no provider request."],
    evidence: {
      level: "source-observation",
      source: "fixture-policy-route",
      observedAt: now(),
      detail: "Controlled fixture enforces no peer reads or network access.",
    },
    ...patch,
  } as Capability;
}
async function workspace(store: Store, root: string, projectId = "project") {
  await mkdir(root, { recursive: true });
  const w = {
    id: uid(),
    projectId,
    hostId: "local",
    root,
    ...canonicalWorkspaceIdentity(root),
    checkoutType: "directory",
    branch: null,
    trustRevision: hash(root),
    availability: "available",
    provenance: "approved",
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  store.put("workspace", w);
  return w as unknown as Workspace;
}
function project(store: Store, id: string, directory: string) {
  store.put("project", {
    id,
    name: `Disposable ${id}`,
    path: directory,
    realPath: directory,
    trusted: true,
    createdAt: now(),
  });
}
interface SetupOptions {
  keys?: string[];
  enforce?: false | AdvancedDriver["enforceIsolation"];
  capabilities?: (installation: Installation) => Capability[];
  missing?: string[];
  outcome?: Record<string, "completed" | "interrupted" | "failed">;
  enabled?: boolean;
}
async function setup(options: SetupOptions = {}) {
  const f = await fixture(),
    coordinator = new Coordinator(f.store),
    repository = coordinator.repository;
  project(f.store, "project", f.directory);
  const keys = options.keys ?? ["alpha", "beta"];
  const participants: AdvancedCreate["participants"] = [];
  for (const key of keys) {
    const w = await workspace(f.store, path.join(f.directory, key));
    participants.push({
      key,
      workspaceId: w.id,
      installationId: f.installation.id,
      provider: "codex",
      model: "fixture-explicit",
      permittedOutputs: ["result.txt"],
    });
  }
  const policies: AdvancedIsolationPolicy[] = [];
  const driver: AdvancedDriver = {
    capabilities:
      options.capabilities ??
      (() =>
        allCapabilities
          .filter((n) => !(options.missing ?? []).includes(n))
          .map((n) => capability(n, f.installation.version!))),
    enforceIsolation:
      options.enforce === false
        ? undefined
        : (options.enforce ??
          (async (policy) => {
            policies.push(policy);
            return {
              policyHash: hash(stable(policy)),
              enforced: true,
              evidence: {
                level: "source-observation",
                source: "fixture-only-policy-installation",
                observedAt: now(),
                detail: "Deterministic local fixture.",
              },
            };
          })),
    dispatch: async ({ attempt, task }) => {
      const key = keys.find((k) => task.title.endsWith(`: ${k}`)) ?? "";
      const starting = repository.transitionAttempt(
        attempt.id,
        attempt.revision,
        "starting",
      );
      repository.transitionAttempt(
        starting.id,
        starting.revision,
        options.outcome?.[key] ?? "completed",
      );
    },
  };
  const engine = new AdvancedCollaboration(coordinator, driver, {
    enabled: options.enabled ?? true,
  });
  const input: AdvancedCreate = {
    projectId: "project",
    template: "independent-proposals",
    objective: "Compare proposed parsing approaches",
    acceptanceCriteria: ["Bounded deterministic result"],
    interfaces: ["parse(input): string"],
    participants,
    rubric: [
      {
        id: "score",
        label: "Declared correctness cases",
        unit: "cases",
        direction: "at-least",
        threshold: 2,
      },
    ],
    protocol: "Run declared cases A and B against the exact frozen output",
    protocolChecks: [],
    baselineCandidateId: null,
  };
  cleanup.push(async () => {
    coordinator.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  return { ...f, coordinator, repository, engine, input, driver, policies };
}
type Setup = Awaited<ReturnType<typeof setup>>;
function artifact(
  f: { store: Store; repository: CoordinationRepository },
  taskId: string | null,
  attemptId: string | null,
  content = "fixture report",
  targetRevision = hash(content),
) {
  const id = uid(),
    at = now();
  f.store.immutable("advanced-output", {
    id,
    projectId: "project",
    text: content,
    contentHash: hash(content),
  });
  return f.repository.artifact({
    id,
    projectId: "project",
    taskId,
    attemptId,
    conversationId: null,
    kind: "report",
    contentHash: hash(content),
    targetRevision,
    protectedContentRef: id,
    confidentiality: "restricted",
    provenance: {
      level: "source-observation",
      source: "local-fixture",
      observedAt: at,
      detail: "Explicit deterministic fixture output.",
    },
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}
function evaluator(
  f: Setup,
  state: ReturnType<AdvancedCollaboration["state"]>,
  submissionId: string,
) {
  const submission = f.engine
    .submissions(state.id)
    .find((s) => s.id === submissionId)!;
  const task = f.repository.createTask({
    projectId: "project",
    workspaceId: f.input.participants[0].workspaceId,
    title: "Separate protocol evaluation",
    role: "tester",
    inputRefs: [submission.id, submission.artifactId, state.protocolHash],
  });
  return artifact(
    f,
    task.id,
    null,
    `measured evidence ${submissionId}`,
    submission.candidateRevision ?? submission.artifactHash,
  );
}
const advancedRows = (store: Store) => ({
  workflows: [...store.iterate("advanced-workflow")].length,
  tasks: [...store.iterate("task")].length,
  attempts: [...store.iterate("attempt")].length,
  isolation: [...store.iterate("advanced-isolation")].length,
  submissions: [...store.iterate("advanced-submission")].length,
});

describe("AD-01 feature flag, enforced isolation route and capability evidence", () => {
  test("the production service is disabled by default, has no isolation route when enabled, and rejects renderer-supplied capability claims", async () => {
    const f = await fixture();
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    project(service.store, "project", f.directory);
    const command = (raw: unknown) => service.command(commandSchema.parse(raw));
    const create = {
      type: "advanced-create",
      requestId: uid(),
      projectId: "project",
      template: "independent-proposals",
      objective: "o",
      acceptanceCriteria: ["c"],
      interfaces: [],
      participants: ["alpha", "beta"].map((key) => ({
        key,
        workspaceId: `w-${key}`,
        installationId: f.installation.id,
        provider: "codex",
        model: "fixture-explicit",
        permittedOutputs: ["result.txt"],
      })),
      rubric: [
        {
          id: "score",
          label: "s",
          unit: "cases",
          direction: "at-least",
          threshold: 1,
        },
      ],
      protocol: "p",
    };
    const before = advancedRows(service.store);
    const off = await command({ type: "advanced-query", projectId: "project" });
    expect(off.enabled).toBe(false);
    expect(off.templates.every((t: any) => t.available === false)).toBe(true);
    await expect(command(create)).rejects.toThrow(/disabled/);
    await command({
      type: "optional-feature-set",
      requestId: uid(),
      feature: "advanced",
      enabled: true,
    });
    const on = await command({ type: "advanced-query", projectId: "project" });
    expect(on.enabled).toBe(true);
    for (const t of on.templates.filter((t: any) => t.independent))
      expect(t.available, t.id).toBe(false);
    await expect(command({ ...create, requestId: uid() })).rejects.toThrow(
      /access-policy/,
    );
    expect(advancedRows(service.store)).toEqual(before);
    // A renderer cannot attach capability or isolation evidence to the command.
    for (const extra of [
      { capabilities: allCapabilities },
      { isolation: { enforced: true } },
      { independent: true },
    ])
      expect(commandSchema.safeParse({ ...create, ...extra }).success).toBe(
        false,
      );
  });

  test("each defective capability record or isolation receipt blocks before any attempt is prepared", async () => {
    const base = await setup();
    const version = base.installation.version!;
    const defects: Array<[string, Partial<Capability>]> = [
      [
        "evidence none",
        {
          evidence: {
            level: "none",
            source: "x",
            observedAt: null,
            detail: "",
          } as any,
        },
      ],
      [
        "no observation time",
        {
          evidence: {
            level: "source-observation",
            source: "x",
            observedAt: null,
            detail: "",
          } as any,
        },
      ],
      ["other runtime version", { versions: ["9.9.9"] }],
      ["native route", { route: "native" as any }],
      ["no tested platform", { testedPlatforms: [] }],
      ["observable only", { support: "observable-only" as any }],
    ];
    for (const [name, patch] of defects) {
      const f = await setup({
        capabilities: () =>
          allCapabilities.map((n) =>
            capability(n, version, n === "tool-isolation" ? patch : {}),
          ),
      });
      expect(() => f.engine.create(f.input), name).toThrow(/tool-isolation/);
      expect(advancedRows(f.store), name).toMatchObject({
        workflows: 0,
        attempts: 0,
      });
    }
    // Isolation receipts that do not prove enforcement of the exact policy.
    const receipts = [
      (p: AdvancedIsolationPolicy) => ({
        policyHash: hash(stable(p)),
        enforced: false,
      }),
      () => ({ policyHash: hash("other policy"), enforced: true }),
      (p: AdvancedIsolationPolicy) => ({
        policyHash: hash(stable(p)),
        enforced: true,
        evidence: {
          level: "none",
          source: "prompt",
          observedAt: null,
          detail: "prompt-only",
        },
      }),
    ];
    for (const receipt of receipts) {
      const f = await setup({
        enforce: async (policy) =>
          ({
            evidence: {
              level: "source-observation",
              source: "fixture",
              observedAt: now(),
              detail: "fixture",
            },
            ...receipt(policy),
          }) as any,
      });
      const s = f.engine.create(f.input);
      await expect(
        f.engine.dispatch(s.id, s.revision, "alpha"),
      ).rejects.toThrow(/isolation was not confirmed/);
      expect(advancedRows(f.store)).toMatchObject({
        attempts: 0,
        isolation: 0,
      });
      expect(f.engine.state(s.id).participants[0].attemptId).toBeNull();
    }
  });
});

describe("AD-02 independent proposals with many participants", () => {
  test("three participants: identical mandatory inputs, peers denied in each policy, outputs withheld until the last freeze", async () => {
    const f = await setup({ keys: ["alpha", "beta", "gamma"] });
    let s = f.engine.create(f.input);
    const contexts = s.participants.map((p) =>
      f.store.get<any>("context-package", p.contextId),
    );
    expect(new Set(contexts.map((c) => c.hash)).size).toBe(1);
    for (const key of ["alpha", "beta"]) {
      s = await f.engine.dispatch(s.id, s.revision, key);
      const p = s.participants.find((p) => p.key === key)!;
      s = await f.engine.freeze(
        s.id,
        s.revision,
        key,
        artifact(f, p.taskId, p.attemptId, `${key} proposal`).id,
      );
    }
    // Two of three frozen: every read and decision path stays withheld.
    expect(s.stage).toBe("collecting");
    expect(() => f.engine.submissions(s.id)).toThrow(/withheld/);
    expect(() => f.engine.evaluate(s.id, s.revision, "any", [])).toThrow(
      /withheld/,
    );
    expect(() => f.engine.select(s.id, s.revision, "any")).toThrow();
    expect(() => f.engine.previewProposalReview(s.id, s.revision)).toThrow();
    s = await f.engine.dispatch(s.id, s.revision, "gamma");
    const g = s.participants[2];
    s = await f.engine.freeze(
      s.id,
      s.revision,
      "gamma",
      artifact(f, g.taskId, g.attemptId, "gamma proposal").id,
    );
    expect(s.stage).toBe("frozen");
    const submissions = f.engine.submissions(s.id);
    expect(submissions.map((x) => x.key)).toEqual(["alpha", "beta", "gamma"]);
    for (const sub of submissions) {
      const p = s.participants.find((p) => p.key === sub.key)!;
      expect(sub).toMatchObject({
        attemptId: p.attemptId,
        artifactHash: hash(`${sub.key} proposal`),
        protocolHash: s.protocolHash,
      });
    }
    // Each dispatch's installed policy allowed only its own context and denied both peers.
    expect(f.policies).toHaveLength(3);
    for (const policy of f.policies) {
      const own = s.participants.find((p) => p.taskId === policy.taskId)!;
      expect(policy.allowedContextIds).toEqual([own.contextId]);
      expect([...policy.deniedTaskIds].sort()).toEqual(
        s.participants
          .filter((p) => p.key !== own.key)
          .map((p) => p.taskId)
          .sort(),
      );
    }
    // Frozen submissions are immutable records.
    expect(() =>
      f.store.immutable("advanced-submission", {
        ...submissions[0],
        artifactHash: hash("rewritten"),
      }),
    ).toThrow(/Immutable/);
  });

  test("duplicate participant keys, duplicate rubric ids, shared folders and more than eight participants are refused with no workflow", async () => {
    const f = await setup({ keys: ["alpha", "beta", "gamma"] });
    const [a, b, c] = f.input.participants;
    const invalid: Array<[string, AdvancedCreate]> = [
      [
        "duplicate key",
        { ...f.input, participants: [a, b, { ...c, key: "alpha" }] },
      ],
      [
        "duplicate rubric id",
        {
          ...f.input,
          rubric: [f.input.rubric[0], { ...f.input.rubric[0], label: "again" }],
        },
      ],
      [
        "shared folder",
        {
          ...f.input,
          participants: [a, b, { ...c, workspaceId: a.workspaceId }],
        },
      ],
      ["single participant", { ...f.input, participants: [a] }],
    ];
    for (const [name, input] of invalid) {
      expect(() => f.engine.create(input), name).toThrow();
      expect(advancedRows(f.store).workflows, name).toBe(0);
    }
    const many = await setup({
      keys: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
    });
    const s = many.engine.create(many.input);
    expect(s.participants).toHaveLength(8);
    expect(
      [...many.store.iterate<Task>("task")].filter(
        (t) => t.workflowId === s.id,
      ),
    ).toHaveLength(8);
    expect(
      commandSchema.safeParse({
        type: "advanced-create",
        requestId: uid(),
        ...many.input,
        participants: [
          ...many.input.participants,
          { ...many.input.participants[0], key: "p9" },
        ],
      }).success,
    ).toBe(false);
  });

  test("an interrupted final participant cannot freeze or be silently replayed, so peers stay withheld", async () => {
    const f = await setup({
      keys: ["alpha", "beta", "gamma"],
      outcome: { gamma: "interrupted" },
    });
    let s = f.engine.create(f.input);
    for (const key of ["alpha", "beta"]) {
      s = await f.engine.dispatch(s.id, s.revision, key);
      const p = s.participants.find((p) => p.key === key)!;
      s = await f.engine.freeze(
        s.id,
        s.revision,
        key,
        artifact(f, p.taskId, p.attemptId, key).id,
      );
    }
    s = await f.engine.dispatch(s.id, s.revision, "gamma");
    const g = s.participants[2];
    expect(
      f.repository.require<ExecutionAttempt>("attempt", g.attemptId!).state,
    ).toBe("interrupted");
    const before = advancedRows(f.store);
    await expect(
      f.engine.freeze(
        s.id,
        s.revision,
        "gamma",
        artifact(f, g.taskId, g.attemptId, "late partial").id,
      ),
    ).rejects.toThrow(/completed task\/attempt/);
    await expect(f.engine.dispatch(s.id, s.revision, "gamma")).rejects.toThrow(
      /never automatically replayed/,
    );
    expect(advancedRows(f.store)).toEqual(before);
    expect(f.engine.state(s.id).stage).toBe("collecting");
    expect(() => f.engine.submissions(s.id)).toThrow(/withheld/);
  });

  test("a final freeze interrupted inside its transaction leaves no orphan submission and can be retried once", async () => {
    const f = await setup({ keys: ["alpha", "beta", "gamma"] });
    let s = f.engine.create(f.input);
    for (const key of ["alpha", "beta", "gamma"])
      s = await f.engine.dispatch(s.id, s.revision, key);
    for (const key of ["alpha", "beta"]) {
      const p = s.participants.find((p) => p.key === key)!;
      s = await f.engine.freeze(
        s.id,
        s.revision,
        key,
        artifact(f, p.taskId, p.attemptId, key).id,
      );
    }
    const g = s.participants[2],
      report = artifact(f, g.taskId, g.attemptId, "gamma");
    const save = f.store.save.bind(f.store);
    f.store.save = ((kind: string, value: any, event?: string) => {
      if (kind === "advanced-workflow")
        throw new Error("Injected crash while saving the frozen state");
      return save(kind, value, event);
    }) as Store["save"];
    await expect(
      f.engine.freeze(s.id, s.revision, "gamma", report.id),
    ).rejects.toThrow(/Injected/);
    f.store.save = save;
    expect(advancedRows(f.store).submissions).toBe(2);
    expect(f.repository.require<Task>("task", g.taskId).state).toBe("active");
    expect(f.engine.state(s.id).revision).toBe(s.revision);
    s = await f.engine.freeze(s.id, s.revision, "gamma", report.id);
    expect(s.stage).toBe("frozen");
    expect(advancedRows(f.store).submissions).toBe(3);
    await expect(
      f.engine.freeze(s.id, s.revision, "gamma", report.id),
    ).rejects.toThrow(/freeze once/);
  });
});

describe("AD-03 and AD-04 measured evaluation, explicit selection and manual review", () => {
  test("missing, duplicate, mis-targeted, self-scored and unprovenanced measurements are refused; no majority winner", async () => {
    const f = await setup({ keys: ["alpha", "beta", "gamma"] });
    f.input.rubric = [
      ...f.input.rubric,
      {
        id: "size",
        label: "Lines",
        unit: "lines",
        direction: "at-most",
        threshold: 10,
      },
    ];
    let s = f.engine.create(f.input);
    for (const key of ["alpha", "beta", "gamma"]) {
      s = await f.engine.dispatch(s.id, s.revision, key);
      const p = s.participants.find((p) => p.key === key)!;
      s = await f.engine.freeze(
        s.id,
        s.revision,
        key,
        artifact(f, p.taskId, p.attemptId, `${key} proposal`).id,
      );
    }
    const subs = f.engine.submissions(s.id);
    const ev = subs.map((sub) => evaluator(f, s, sub.id));
    const selfScore = artifact(
      f,
      s.participants[0].taskId,
      s.participants[0].attemptId,
      "I am correct",
      subs[0].artifactHash,
    );
    const unprovenanced = f.repository.artifact({
      ...ev[0],
      id: uid(),
      provenance: {
        level: "none",
        source: "unknown",
        observedAt: null,
        detail: "",
      },
    });
    const bad: Array<[string, any[]]> = [
      [
        "missing dimension",
        [{ criterionId: "score", value: 2, evidenceArtifactId: ev[0].id }],
      ],
      [
        "duplicate dimension",
        [
          { criterionId: "score", value: 2, evidenceArtifactId: ev[0].id },
          { criterionId: "score", value: 3, evidenceArtifactId: ev[0].id },
        ],
      ],
      [
        "other submission's evidence",
        [
          { criterionId: "score", value: 2, evidenceArtifactId: ev[1].id },
          { criterionId: "size", value: 1, evidenceArtifactId: ev[1].id },
        ],
      ],
      [
        "participant self-score",
        [
          { criterionId: "score", value: 9, evidenceArtifactId: selfScore.id },
          { criterionId: "size", value: 1, evidenceArtifactId: selfScore.id },
        ],
      ],
      [
        "no provenance",
        [
          {
            criterionId: "score",
            value: 2,
            evidenceArtifactId: unprovenanced.id,
          },
          {
            criterionId: "size",
            value: 1,
            evidenceArtifactId: unprovenanced.id,
          },
        ],
      ],
    ];
    for (const [name, measurements] of bad) {
      expect(
        () => f.engine.evaluate(s.id, s.revision, subs[0].id, measurements),
        name,
      ).toThrow();
      expect(
        f.store.get("advanced-evaluation", `${s.id}:${subs[0].id}`),
      ).toBeUndefined();
    }
    const measure = (i: number, score: number) =>
      (s = f.engine.evaluate(s.id, s.revision, subs[i].id, [
        { criterionId: "score", value: score, evidenceArtifactId: ev[i].id },
        { criterionId: "size", value: 5, evidenceArtifactId: ev[i].id },
      ]));
    measure(0, 1); // fails its threshold
    measure(1, 2);
    // Selection is refused until every submission has the same rubric measured.
    expect(() => f.engine.select(s.id, s.revision, subs[1].id)).toThrow(
      /all frozen submissions/,
    );
    measure(2, 3);
    // A failing submission cannot be selected, however many others pass.
    expect(() => f.engine.select(s.id, s.revision, subs[0].id)).toThrow(
      /passing selected result/,
    );
    s = f.engine.select(s.id, s.revision, subs[1].id);
    expect(s.stage).toBe("awaiting-verification");
    // Selection is not acceptance: accept and bind are refused at this stage.
    await expect(
      f.engine.accept(s.id, s.revision, f.engine.acceptanceDigest(s.id)),
    ).rejects.toThrow(/explicit review/);
    expect(f.repository.require<Workflow>("workflow", s.id).state).toBe(
      "running",
    );
    const review = f.engine.previewProposalReview(s.id, s.revision);
    expect(review.targetRevision).toBe(subs[1].artifactHash);
    const manual = f.engine.confirmProposalReview(review.id, review.digest);
    expect(manual.evidence.level).toBe("user-confirmation");
    expect(manual.environment).toMatch(
      /Manual native user review; no automated/,
    );
    expect(() =>
      f.engine.confirmProposalReview(review.id, review.digest),
    ).toThrow(/consumed/);
  });
});

describe("AD-05 and AD-06 independent test design input withholding", () => {
  test("test design requires exactly one participant and never receives a baseline", async () => {
    const f = await setup();
    expect(() =>
      f.engine.create({ ...f.input, template: "independent-test-design" }),
    ).toThrow(/participant count/);
    const s = f.engine.create({
      ...f.input,
      template: "independent-test-design",
      participants: [f.input.participants[0]],
    });
    const context = f.store.get<any>(
      "context-package",
      s.participants[0].contextId,
    );
    expect(JSON.parse(context.text).baseline).toBeNull();
    expect(context.sourceRefs).toEqual([s.specificationId]);
    expect(
      f.repository.require<Task>("task", s.participants[0].taskId).role,
    ).toBe("tester");
  });
});

describe("AD-07 competing implementations run the same protocol on every candidate", () => {
  test("selection is refused until every frozen candidate ran the common process check", async () => {
    const f = await setup();
    const script =
      'const f=require("node:fs"),x=f.readFileSync("result.txt","utf8");if(!["A","B"].includes(x))process.exit(3);console.log("declared cases passed");';
    const roots = f.input.participants.map(
      (p) =>
        f.repository.require<Workspace>("workspace", p.workspaceId)
          .canonicalRoot,
    );
    for (const root of roots) {
      await writeFile(path.join(root, "result.txt"), "base");
      await writeFile(path.join(root, "check.cjs"), script);
    }
    const baseline = await captureCandidate(f.store, {
      root: roots[0],
      projectId: "project",
      workflowId: "baseline-fixture",
      selectedPaths: ["result.txt", "check.cjs"],
    });
    const definition = {
      id: "regression",
      label: "Fixture regression",
      executable: process.execPath,
      args: ["check.cjs"],
      timeoutMs: 30_000,
    };
    let s = f.engine.create({
      ...f.input,
      template: "competing-implementations",
      participants: f.input.participants.map((p) => ({
        ...p,
        permittedOutputs: ["result.txt", "check.cjs"],
      })),
      protocolChecks: [definition],
      baselineCandidateId: baseline.id,
    });
    for (const [i, key] of ["alpha", "beta"].entries()) {
      s = await f.engine.dispatch(s.id, s.revision, key);
      await writeFile(path.join(roots[i], "result.txt"), i === 0 ? "A" : "B");
      s = await f.engine.capture(s.id, s.revision, key);
    }
    const subs = f.engine.submissions(s.id);
    const plan = await f.engine.previewCheck(
      s.id,
      s.revision,
      subs[0].id,
      definition,
    );
    const check = await f.engine.runCheck(plan.id, plan.digest);
    expect(check.result).toBe("passed");
    s = f.engine.evaluate(s.id, s.revision, subs[0].id, [
      {
        criterionId: "score",
        value: 2,
        evidenceArtifactId: check.evidenceArtifactId!,
      },
    ]);
    s = f.engine.evaluate(s.id, s.revision, subs[1].id, [
      {
        criterionId: "score",
        value: 2,
        evidenceArtifactId: evaluator(f, s, subs[1].id).id,
      },
    ]);
    expect(() => f.engine.select(s.id, s.revision, subs[0].id)).toThrow(
      /same declared process-check protocol/,
    );
    const second = await f.engine.previewCheck(
      s.id,
      s.revision,
      subs[1].id,
      definition,
    );
    expect((await f.engine.runCheck(second.id, second.digest)).result).toBe(
      "passed",
    );
    s = f.engine.select(s.id, s.revision, subs[0].id);
    expect(s.stage).toBe("awaiting-verification");
    expect(
      f.store.get<any>("integration-submission", subs[0].candidateId!),
    ).toMatchObject({
      state: "queued",
      candidateRevision: subs[0].candidateRevision,
    });
  });
});

describe("AD-09 routing presets with several members per role across providers", () => {
  test("three or more same-role members across Codex and Claude persist; invalid assignments are refused without changing the saved preset", async () => {
    const f = await fixture();
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    project(service.store, "project", f.directory);
    project(service.store, "elsewhere", f.directory);
    const claude: Installation = {
      ...f.installation,
      id: uid(),
      appId: "anthropic.claude-code-cli",
    };
    service.store.put("installation", claude);
    const command = (raw: unknown) => service.command(commandSchema.parse(raw));
    const member = (
      memberId: string | undefined,
      provider: "codex" | "claude",
      model: string,
      role = "reviewer",
    ) => ({
      role,
      ...(memberId ? { memberId } : {}),
      provider,
      installationId: provider === "codex" ? f.installation.id : claude.id,
      model,
    });
    const assignments = [
      member("rev-codex-1", "codex", "codex-model-a"),
      member("rev-claude-1", "claude", "claude-model-a"),
      member("rev-codex-2", "codex", "codex-model-b"),
      member("rev-claude-2", "claude", "claude-model-b"),
      member("impl-1", "codex", "codex-model-a", "implementer"),
      member("impl-2", "claude", "claude-model-a", "implementer"),
      member("impl-3", "codex", "codex-model-c", "implementer"),
    ];
    const saved = await command({
      type: "routing-preset-save",
      requestId: uid(),
      projectId: "project",
      name: "Mixed team",
      assignments,
    });
    const stored = service.store.get<any>("routing-preset", saved.id);
    expect(stored.revision).toBe(1);
    expect(stored.assignments.map((a: any) => a.memberId)).toEqual(
      assignments.map((a) => a.memberId),
    );
    expect(
      stored.assignments
        .filter((a: any) => a.role === "reviewer")
        .map((a: any) => a.provider),
    ).toEqual(["codex", "claude", "codex", "claude"]);
    // No two-member ceiling: a dozen reviewers persist.
    const dozen = await command({
      type: "routing-preset-save",
      requestId: uid(),
      projectId: "project",
      name: "Dozen reviewers",
      assignments: Array.from({ length: 12 }, (_, i) =>
        member(`r${i}`, i % 2 ? "claude" : "codex", `model-${i}`),
      ),
    });
    expect(
      service.store.get<any>("routing-preset", dozen.id).assignments,
    ).toHaveLength(12);
    const update = (changed: unknown[], extra: Record<string, unknown> = {}) =>
      command({
        type: "routing-preset-save",
        requestId: uid(),
        id: saved.id,
        expectedRevision: 1,
        projectId: "project",
        name: "Mixed team",
        assignments: changed,
        ...extra,
      });
    const invalid: Array<[string, () => Promise<unknown>]> = [
      [
        "duplicate identity",
        () => update([...assignments, member("rev-codex-1", "claude", "x")]),
      ],
      [
        "two unnamed members of one role",
        () =>
          update([
            member(undefined, "codex", "x"),
            member(undefined, "claude", "y"),
          ]),
      ],
      ["blank model", () => update([member("m", "codex", "   ")])],
      [
        "Claude member on a Codex installation",
        () =>
          update([
            {
              ...member("m", "claude", "x"),
              installationId: f.installation.id,
            },
          ]),
      ],
      [
        "Codex member on a Claude installation",
        () =>
          update([{ ...member("m", "codex", "x"), installationId: claude.id }]),
      ],
      [
        "missing installation",
        () =>
          update([{ ...member("m", "codex", "x"), installationId: "gone" }]),
      ],
      ["stale revision", () => update(assignments, { expectedRevision: 7 })],
      [
        "preset moved to another project",
        () => update(assignments, { projectId: "elsewhere" }),
      ],
    ];
    for (const [name, attempt] of invalid) {
      await expect(attempt(), name).rejects.toThrow();
      expect(service.store.get<any>("routing-preset", saved.id), name).toEqual(
        stored,
      );
    }
    // Negative control: a correct revision update is accepted.
    const next = await update(assignments.slice(0, 3));
    expect(next.revision).toBe(2);
  });
});

describe("AD-10 routing measurement matrix", () => {
  test("incompatible or unfinished evidence is refused; the summary covers only the current preset revision and genuine outcomes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T0 = Date.parse("2026-10-19T09:00:00.000Z");
    vi.setSystemTime(T0);
    const f = await fixture();
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true);
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const repo = service.coordinator.repository,
      store = service.store;
    project(store, "project", f.directory);
    project(store, "elsewhere", f.directory);
    const claude: Installation = {
      ...f.installation,
      id: uid(),
      appId: "anthropic.claude-code-cli",
    };
    store.put("installation", claude);
    const w = await workspace(store, path.join(f.directory, "w"));
    const w2 = await workspace(
      store,
      path.join(f.directory, "w2"),
      "elsewhere",
    );
    const command = (raw: unknown) => service.command(commandSchema.parse(raw));
    const preset = await command({
      type: "routing-preset-save",
      requestId: uid(),
      projectId: "project",
      name: "Reviewers",
      assignments: [
        {
          role: "reviewer",
          memberId: "c1",
          provider: "codex",
          installationId: f.installation.id,
          model: "m-codex",
        },
        {
          role: "reviewer",
          memberId: "k1",
          provider: "claude",
          installationId: claude.id,
          model: "m-claude",
        },
      ],
    });
    const at = (ms: number) => vi.setSystemTime(T0 + ms);
    function task(role: Task["role"] = "reviewer", ws = w) {
      const t = repo.createTask({
        projectId: ws.projectId,
        workspaceId: ws.id,
        title: "measured",
        role,
      });
      return repo.transitionTask(t.id, t.revision, "ready");
    }
    function attempt(
      t: Task,
      provider: "codex" | "claude",
      model: string,
      final: ExecutionAttempt["state"] | null,
      extra: {
        retryOf?: string;
        runId?: string;
        usage?: boolean;
        finishAt?: number;
      } = {},
    ) {
      const current = repo.require<Task>("task", t.id);
      const a = repo.prepareAttempt({
        taskId: t.id,
        expectedRevision: current.revision,
        provider,
        requestedModel: model,
        retryOfAttemptId: extra.retryOf ?? null,
        legacyRunId: extra.runId ?? null,
      });
      if (!final) return a;
      const s = repo.transitionAttempt(a.id, a.revision, "starting");
      if (extra.finishAt !== undefined) at(extra.finishAt);
      return repo.transitionAttempt(s.id, s.revision, final, {
        ...(extra.usage
          ? {
              usageEvidence: {
                level: "provider-readback",
                source: "fixture-usage-report",
                observedAt: now(),
                detail: "Deterministic fixture usage.",
              },
            }
          : {}),
      });
    }
    const measure = (
      taskId: string,
      escapedDefects: number,
      presetId = preset.id,
    ) =>
      command({
        type: "routing-measure",
        requestId: uid(),
        presetId,
        taskId,
        escapedDefects,
      });
    // Invalid matrix.
    const wrongProject = task("reviewer", w2);
    attempt(wrongProject, "codex", "m-codex", "completed");
    const wrongProvider = task();
    attempt(wrongProvider, "claude", "m-codex", "completed");
    const wrongModel = task();
    attempt(wrongModel, "codex", "m-other", "completed");
    const wrongRole = task("implementer");
    attempt(wrongRole, "codex", "m-codex", "completed");
    const active = task();
    attempt(active, "codex", "m-codex", null);
    const uncertain = task();
    const u = attempt(uncertain, "codex", "m-codex", null);
    repo.transitionAttempt(u.id, u.revision, "uncertain");
    const empty = task();
    for (const [name, t] of [
      ["wrong project", wrongProject],
      ["wrong provider", wrongProvider],
      ["wrong model", wrongModel],
      ["wrong role", wrongRole],
      ["active attempt", active],
      ["uncertain attempt", uncertain],
      ["no attempts", empty],
    ] as const)
      await expect(measure(t.id, 0), name).rejects.toThrow(
        /matching completed role attempts/,
      );
    for (const defects of [-1, 1.5])
      expect(
        commandSchema.safeParse({
          type: "routing-measure",
          requestId: uid(),
          presetId: preset.id,
          taskId: empty.id,
          escapedDefects: defects,
        }).success,
      ).toBe(false);
    expect([...store.iterate("routing-measurement")]).toHaveLength(0);
    // Genuine data: task one fails then is repaired and accepted; task two is not accepted.
    at(0);
    const one = task();
    const first = attempt(one, "codex", "m-codex", "failed", {
      finishAt: 1000,
    });
    let t1 = repo.require<Task>("task", one.id);
    t1 = repo.transitionTask(t1.id, t1.revision, "changes-requested");
    repo.transitionTask(t1.id, t1.revision, "ready");
    at(2000);
    attempt(one, "codex", "m-codex", "completed", {
      retryOf: first.id,
      runId: "run-known",
      usage: true,
      finishAt: 5000,
    });
    store.put("usage", {
      id: "usage-known",
      projectId: "project",
      runId: "run-known",
      input: 900,
      output: 100,
    });
    t1 = repo.require<Task>("task", one.id);
    t1 = repo.transitionTask(t1.id, t1.revision, "submitted");
    t1 = repo.transitionTask(t1.id, t1.revision, "verifying");
    // Accepted-outcome fixture: real task acceptance needs a verified candidate
    // (covered by J-13 and advanced-workflows.test.ts); measurement reads only the state.
    store.put("task", { ...t1, state: "accepted", revision: t1.revision + 1 });
    at(10_000);
    const two = task();
    // Usage evidence claimed but the usage record has no input count: stays unknown.
    attempt(two, "claude", "m-claude", "completed", {
      runId: "run-partial",
      usage: true,
      finishAt: 13_000,
    });
    store.put("usage", {
      id: "usage-partial",
      projectId: "project",
      runId: "run-partial",
      input: null,
      output: 5,
    });
    await measure(one.id, 2);
    await measure(two.id, 0);
    await measure(one.id, 2); // duplicate delivery replaces, never double counts
    const summary = service.advanced.routingSummary(preset.id);
    expect(summary).toEqual({
      tasks: 2,
      acceptedTaskRate: 0.5,
      escapedDefects: 2,
      repairCount: 1,
      wallTimeMs: 5000 + 3000,
      knownUsageCoverage: 1 / 3,
      ranking: "none; explicit role selection remains user-controlled",
      subscriptionAllowance: "unknown",
    });
    expect(Object.keys(summary).some((k) => /token/i.test(k))).toBe(false);
    const listed = (
      await command({ type: "advanced-query", projectId: "project" })
    ).presets.find((p: any) => p.id === preset.id);
    expect(listed.measurements).toEqual(summary);
    // A new preset revision starts an empty summary; old-revision rows are retained but not counted.
    const revised = await command({
      type: "routing-preset-save",
      requestId: uid(),
      id: preset.id,
      expectedRevision: preset.revision,
      projectId: "project",
      name: "Reviewers",
      assignments: [
        {
          role: "reviewer",
          memberId: "c1",
          provider: "codex",
          installationId: f.installation.id,
          model: "m-codex",
        },
      ],
    });
    expect(service.advanced.routingSummary(revised.id)).toMatchObject({
      tasks: 0,
      acceptedTaskRate: null,
      knownUsageCoverage: null,
    });
    expect([...store.iterate("routing-measurement")]).toHaveLength(2);
    // Under the revised assignments the Claude task no longer matches.
    await expect(measure(two.id, 0)).rejects.toThrow(
      /matching completed role attempts/,
    );
    await measure(one.id, 0);
    expect(service.advanced.routingSummary(revised.id)).toMatchObject({
      tasks: 1,
      acceptedTaskRate: 1,
      escapedDefects: 0,
    });
  });
});

describe("AD-11 catalog availability labels and section 6.2 mode enumeration", () => {
  test("only the four implemented templates exist; debate and plan competition are not selectable", async () => {
    expect(advancedTemplates.map((t) => t.id)).toEqual([
      "independent-proposals",
      "independent-test-design",
      "competing-implementations",
      "pair-debugging",
    ]);
    for (const template of [
      "debate",
      "plan-competition",
      "generic-plan-competition",
    ])
      expect(
        commandSchema.safeParse({
          type: "advanced-create",
          requestId: uid(),
          projectId: "project",
          template,
          objective: "o",
          acceptanceCriteria: ["c"],
          interfaces: [],
          participants: [],
          rubric: [],
          protocol: "p",
        }).success,
        template,
      ).toBe(false);
    // Availability: disabled -> none; enabled with full enforcement -> all four;
    // enabled without an isolation route -> only the non-independent pair template.
    const off = await setup({ enabled: false });
    const offStatus = off.engine.status("project");
    expect(offStatus.templates.map((t) => [t.id, t.available])).toEqual(
      advancedTemplates.map((t) => [t.id, false]),
    );
    expect(offStatus.templates[0].detail).toMatch(/Feature flag disabled/);
    const full = await setup();
    expect(
      full.engine.status("project").templates.every((t) => t.available),
    ).toBe(true);
    const noRoute = await setup({ enforce: false });
    expect(
      noRoute.engine
        .status("project")
        .templates.filter((t) => t.available)
        .map((t) => t.id),
    ).toEqual(["pair-debugging"]);
    const noWrite = await setup({ missing: ["workspace-write"] });
    expect(
      noWrite.engine
        .status("project")
        .templates.filter((t) => t.available)
        .map((t) => t.id),
    ).toEqual(["independent-proposals", "independent-test-design"]);
  });

  test.each(advancedTemplates.map((t) => t.id))(
    "mode %s: disabled refuses creation; enabled creates the declared roles and gates; disabling keeps existing work controllable",
    async (template) => {
      const f = await setup({ keys: ["alpha", "beta"], enabled: false });
      const root = f.repository.require<Workspace>(
        "workspace",
        f.input.participants[0].workspaceId,
      ).canonicalRoot;
      await writeFile(path.join(root, "result.txt"), "base");
      const needsBaseline = [
        "competing-implementations",
        "pair-debugging",
      ].includes(template);
      const baseline = needsBaseline
        ? await captureCandidate(f.store, {
            root,
            projectId: "project",
            workflowId: "mode-baseline",
            selectedPaths: ["result.txt"],
          })
        : null;
      const input: AdvancedCreate = {
        ...f.input,
        template,
        participants:
          template === "independent-test-design"
            ? [f.input.participants[0]]
            : f.input.participants,
        baselineCandidateId: baseline?.id ?? null,
        protocolChecks: needsBaseline
          ? [
              {
                id: "regression",
                label: "Regression",
                executable: process.execPath,
                args: ["check.cjs"],
                timeoutMs: 30_000,
              },
            ]
          : [],
      };
      expect(() => f.engine.create(input)).toThrow(/disabled/);
      expect(advancedRows(f.store).workflows).toBe(0);
      f.engine.setEnabled(true);
      let s = f.engine.create(input);
      const declared = advancedTemplates.find((t) => t.id === template)!;
      const tasks = s.participants.map((p) =>
        f.repository.require<Task>("task", p.taskId),
      );
      const expectedRoles: Record<string, string[]> = {
        "independent-proposals": ["planner", "planner"],
        "independent-test-design": ["tester"],
        "competing-implementations": ["implementer", "implementer"],
        "pair-debugging": ["implementer", "reviewer"],
      };
      expect(tasks.map((t) => t.role)).toEqual(expectedRoles[template]);
      for (const t of tasks)
        expect(t.requiredCapabilities).toEqual([...declared.gates]);
      expect(s.writerKey).toBe(template === "pair-debugging" ? "alpha" : null);
      if (template === "pair-debugging")
        expect(tasks[1].permittedOutputs).toEqual([]);
      s = await f.engine.dispatch(s.id, s.revision, "alpha");
      f.engine.setEnabled(false);
      // New dispatch is refused behind the off flag ...
      if (s.participants.length > 1)
        await expect(
          f.engine.dispatch(s.id, s.revision, "beta"),
        ).rejects.toThrow(/disabled/);
      // ... but the already-dispatched role's output can still be frozen (control remains).
      const p = s.participants[0];
      if (
        template === "independent-proposals" ||
        template === "independent-test-design"
      ) {
        s = await f.engine.freeze(
          s.id,
          s.revision,
          "alpha",
          artifact(f, p.taskId, p.attemptId, "control after disable").id,
        );
        expect(s.participants[0].submissionId).not.toBeNull();
      } else {
        await writeFile(path.join(root, "result.txt"), "changed by driver");
        s = await f.engine.capture(s.id, s.revision, "alpha");
        expect(s.participants[0].submissionId).not.toBeNull();
      }
    },
  );
});

describe("J-13 independent test design journey through the service commands", () => {
  test("frozen tests, withheld implementation, same protected protocol on a pinned candidate, no acceptance from self-score", async () => {
    const f = await fixture();
    f.store.close();
    const service = new Service(f.directory, f.key, () => {}, true),
      repo = service.coordinator.repository;
    cleanup.push(async () => {
      await service.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    project(service.store, "project", f.directory);
    const designer = await workspace(
      service.store,
      path.join(f.directory, "designer"),
    );
    const implementation = await workspace(
      service.store,
      path.join(f.directory, "impl"),
    );
    const policies: AdvancedIsolationPolicy[] = [];
    const engine = new AdvancedCollaboration(
      service.coordinator,
      {
        capabilities: () =>
          allCapabilities.map((n) => capability(n, f.installation.version!)),
        enforceIsolation: async (policy) => {
          policies.push(policy);
          return {
            policyHash: hash(stable(policy)),
            enforced: true,
            evidence: {
              level: "source-observation",
              source: "controlled-fixture",
              observedAt: now(),
              detail: "Fixture isolation receipt.",
            },
          };
        },
        dispatch: async ({ attempt }) => {
          const s = repo.transitionAttempt(
            attempt.id,
            attempt.revision,
            "starting",
          );
          repo.transitionAttempt(s.id, s.revision, "completed");
        },
      },
      { enabled: true },
    );
    // Isolated constructor fixture only; production has no isolation route (AD-01).
    Object.defineProperty(service, "advanced", { value: engine });
    const command = (
      raw: unknown,
      trusted: Parameters<Service["command"]>[1] = {},
    ) => service.command(commandSchema.parse(raw), trusted);
    const testText =
      'const f=require("node:fs");if(f.readFileSync("result.txt","utf8")!=="fixed")process.exit(3);console.log("frozen regression passed");';
    const definition = {
      id: "frozen-regression",
      label: "Frozen independent regression",
      executable: process.execPath,
      args: ["regression.cjs"],
      timeoutMs: 30_000,
    };
    const create = {
      type: "advanced-create",
      requestId: uid(),
      projectId: "project",
      template: "independent-test-design",
      objective: "Design tests for parse()",
      acceptanceCriteria: ["parse returns fixed"],
      interfaces: ["parse(input): string"],
      participants: [
        {
          key: "designer",
          workspaceId: designer.id,
          installationId: f.installation.id,
          provider: "codex",
          model: "fixture-explicit",
          permittedOutputs: ["tests.json"],
        },
      ],
      rubric: [
        {
          id: "passes",
          label: "Frozen checks passing",
          unit: "checks",
          direction: "at-least",
          threshold: 1,
        },
      ],
      protocol: "Run the frozen regression file unchanged",
    };
    await expect(
      command({
        ...create,
        requestId: uid(),
        baselineCandidateId: "implementation",
      }),
    ).rejects.toThrow(/before seeing implementation/);
    let s = await command(create);
    await expect(
      command({
        type: "advanced-test-candidate-capture",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
        workspaceId: implementation.id,
        selectedPaths: ["result.txt"],
      }),
    ).rejects.toThrow(/Freeze the independent test design/);
    s = await command({
      type: "advanced-dispatch",
      requestId: uid(),
      id: s.id,
      expectedRevision: s.revision,
      key: "designer",
    });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      freshSession: true,
      context: true,
      filesystem: true,
      tools: true,
    });
    expect(
      [...service.store.iterate<any>("advanced-isolation")][0].enforced,
    ).toBe(true);
    const p = s.participants[0];
    const protocol = JSON.stringify({
      files: [{ path: "regression.cjs", text: testText }],
      checks: [definition],
    });
    const frozenArtifact = artifact(
      { store: service.store, repository: repo },
      p.taskId,
      p.attemptId,
      protocol,
    );
    s = await command({
      type: "advanced-freeze",
      requestId: uid(),
      id: s.id,
      expectedRevision: s.revision,
      key: "designer",
      artifactId: frozenArtifact.id,
    });
    const [submission] = await command({
      type: "advanced-submissions",
      id: s.id,
    });
    const capture = (paths: string[]) =>
      command({
        type: "advanced-test-candidate-capture",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
        workspaceId: implementation.id,
        selectedPaths: paths,
      });
    // The implementation arrives only now. A missing or altered frozen test file is refused.
    await writeFile(
      path.join(implementation.canonicalRoot, "result.txt"),
      "fixed",
    );
    await expect(capture(["result.txt"])).rejects.toThrow(
      /missing or changed a frozen/,
    );
    await writeFile(
      path.join(implementation.canonicalRoot, "regression.cjs"),
      "process.exit(0)",
    );
    await expect(capture(["result.txt"])).rejects.toThrow(
      /missing or changed a frozen/,
    );
    await writeFile(
      path.join(implementation.canonicalRoot, "regression.cjs"),
      testText,
    );
    const candidate = await capture(["result.txt"]);
    for (const altered of [
      { ...definition, args: ["-e", "process.exit(0)"] },
      { ...definition, timeoutMs: 31_000 },
    ])
      await expect(
        command({
          type: "advanced-check-preview",
          id: s.id,
          expectedRevision: s.revision,
          submissionId: submission.id,
          definition: altered,
          candidateId: candidate.id,
        }),
      ).rejects.toThrow(/differs from the frozen/);
    const plan = await command({
      type: "advanced-check-preview",
      id: s.id,
      expectedRevision: s.revision,
      submissionId: submission.id,
      definition,
      candidateId: candidate.id,
    });
    await expect(
      command({ type: "advanced-check-apply", requestId: uid(), id: plan.id }),
    ).rejects.toThrow(/native approval/);
    const check = await command(
      { type: "advanced-check-apply", requestId: uid(), id: plan.id },
      { digest: plan.digest },
    );
    expect(check.result).toBe("passed");
    expect(check.taskId).not.toBe(p.taskId);
    expect(check.targetRevision).toBe(candidate.revision);
    // A model's self-score (the designer's own artifact) is not evaluation evidence.
    const selfScore = artifact(
      { store: service.store, repository: repo },
      p.taskId,
      p.attemptId,
      "All my tests are excellent",
      submission.artifactHash,
    );
    await expect(
      command({
        type: "advanced-evaluate",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
        submissionId: submission.id,
        measurements: [
          { criterionId: "passes", value: 1, evidenceArtifactId: selfScore.id },
        ],
      }),
    ).rejects.toThrow(/observed evidence bound/);
    s = await command({
      type: "advanced-evaluate",
      requestId: uid(),
      id: s.id,
      expectedRevision: s.revision,
      submissionId: submission.id,
      measurements: [
        {
          criterionId: "passes",
          value: 1,
          evidenceArtifactId: check.evidenceArtifactId,
        },
      ],
    });
    s = await command({
      type: "advanced-select",
      requestId: uid(),
      id: s.id,
      expectedRevision: s.revision,
      submissionId: submission.id,
    });
    // Acceptance without separate verification is refused.
    const early = service.review("advanced-acceptance", s.id) as any;
    await expect(
      command(
        {
          type: "advanced-accept",
          requestId: uid(),
          id: s.id,
          expectedRevision: s.revision,
        },
        { digest: early.digest },
      ),
    ).rejects.toThrow(/explicit review/);
    await expect(
      command({
        type: "advanced-bind-verification",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
        verificationIds: [check.id],
      }),
    ).rejects.toThrow(/frozen test protocol/);
    s = await command({
      type: "advanced-bind-verification",
      requestId: uid(),
      id: s.id,
      expectedRevision: s.revision,
      verificationIds: [check.id],
      frozenTestSubmissionId: submission.id,
    });
    const review = service.review("advanced-acceptance", s.id) as any;
    await expect(
      command({
        type: "advanced-accept",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
      }),
    ).rejects.toThrow(/native review/);
    s = await command(
      {
        type: "advanced-accept",
        requestId: uid(),
        id: s.id,
        expectedRevision: s.revision,
      },
      { digest: review.digest },
    );
    expect(s.stage).toBe("accepted");
    const workflow = repo.require<Workflow>("workflow", s.id);
    expect(workflow.state).toBe("accepted");
    expect(workflow.acceptance?.targetRevision).toBe(candidate.revision);
    expect(workflow.acceptance?.by).toBe("native-user");
    expect(service.runtime.hasActive()).toBe(false);
  });
});
