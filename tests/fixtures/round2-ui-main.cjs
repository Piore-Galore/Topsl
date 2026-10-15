const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const data = (global.fixture = {
  sequence: 1,
  epoch: "fixture-epoch",
  failSnapshots: false,
  holdNext: false,
  held: [],
  holdNextDraft: false,
  heldDrafts: [],
  tasks: [],
  holdTaskInspections: false,
  taskInspections: [],
  drafts: {},
  workflows: [],
  runtimes: [],
  calls: [],
  findingDecisions: [],
  executionState: "uncertain",
  cleanupState: "failed",
  preparationState: "failed",
  outputReviews: [],
  binaryReviews: [],
  plans: {},
  cancelNextArtifactReview: true,
  captured: false,
});
let window;
const digest = (letter) => letter.repeat(64);
const candidateId = () => (data.captured ? "candidate-captured" : "candidate");
const candidateRevision = () =>
  data.captured ? "fixture-candidate-captured" : "fixture-candidate";
const observation = (projectId) => ({
  projectId,
  sequence: data.sequence,
  epoch: data.epoch,
  generatedAt: new Date().toISOString(),
});
const snapshot = (projectId) => ({
  observation: observation(projectId),
  projectId,
  sequence: data.sequence,
  epoch: data.epoch,
  coordination: {
    tasks: data.tasks,
    workflows: [],
    workspaces: [],
    attempts: [],
    sessions: [],
    concurrency: {
      visibleAttempts: 0,
      reservedCapacity: 0,
      totalLimit: 2,
      hiddenConcurrency: "unknown",
      maximumIncludingNativeChildren: null,
    },
  },
  runs: [],
  usage: [],
  conversations: [],
  synchronization: {
    sharedRevisions: [],
    inputs: [],
    historySources: [],
    observations: [],
    fields: [],
    links: [],
  },
});
data.notify = () => {
  const after = data.sequence++;
  window.webContents.send("topsl:event", {
    type: "changes",
    data: {
      epoch: data.epoch,
      afterSequence: after,
      throughSequence: data.sequence,
      headSequence: data.sequence,
      hasMore: false,
      events: [
        {
          sequence: data.sequence,
          kind: "task",
          projectId: "project",
          conversationId: null,
          id: "fixture",
          operation: "put",
        },
      ],
    },
  });
};
data.workflow = (objective) => ({
  id: "fixture-workflow",
  revision: data.sequence,
  stage: "accepted",
  objective,
  detail: "Fixture evidence only. No real provider route is qualified.",
  specificationId: "spec",
  latestSpecificationId: "spec",
  candidateRevision: candidateRevision(),
  repairRound: 0,
  maxRepairs: 2,
  builder: {
    provider: "codex",
    model: "fixture-model",
    installationId: "fixture",
  },
  reviewer: {
    provider: "claude",
    model: "fixture-model",
    installationId: "fixture",
  },
  checksStatus: [],
});
data.execution = () => ({
  id: "execution",
  definition: { label: "Original project test" },
  state: data.executionState,
  failurePhase: data.preparationState === "failed" ? "environment" : null,
  eligibility: data.executionState === "passed" ? "eligible" : "uncertain",
  targetRevision: "fixture-candidate",
  truncated: true,
});
data.inspect = () => ({
  observation: observation("project"),
  state: { ...data.workflows[0], revision: data.sequence },
  candidate: {
    id: candidateId(),
    revision: candidateRevision(),
    files: [
      {
        path: "src/路径.ts",
        bytes: 20,
        type: "text",
        change: "modified",
        blobHash: digest("d"),
        hash: digest("d"),
        content: null,
      },
      {
        path: "src/新增.ts",
        bytes: 18,
        type: "text",
        change: "added",
        blobHash: digest("a"),
        hash: digest("a"),
        content: null,
      },
      {
        path: "assets/图像.png",
        bytes: 68,
        type: "binary",
        change: "modified",
        blobHash: digest("b"),
        hash: digest("b"),
        content: null,
      },
      ...(data.captured
        ? [
            {
              path: "src/proposed.ts",
              bytes: 12,
              type: "text",
              change: "added",
              blobHash: digest("c"),
              hash: digest("c"),
              content: null,
            },
          ]
        : []),
      ...Array.from({ length: 1000 }, (_, index) => ({
        path: `src/source-${String(index).padStart(4, "0")}.ts`,
        bytes: 10,
        type: "text",
        change: "unchanged",
        hash: digest("e"),
        blobHash: digest("e"),
        content: null,
      })),
    ],
    outputs: [
      {
        path: "src/新增.ts",
        hash: digest("a"),
        status: "pending",
        required: true,
      },
      {
        path: "src/proposed.ts",
        hash: digest("c"),
        status: "pending",
        required: true,
      },
    ],
    coverage: {
      complete: true,
      blockers: [],
      manualBinaryPaths: ["assets/图像.png"],
    },
    omissions: [],
  },
  diff: {
    baseCandidateId: "baseline",
    candidateId: candidateId(),
    baseRevision: "baseline-revision",
    candidateRevision: candidateRevision(),
    files: [
      {
        path: "src/路径.ts",
        kind: "modified",
        beforeHash: "before",
        afterHash: "after",
        binary: false,
        before: [{ line: 1, text: "export const count = 1;" }],
        after: [{ line: 1, text: "export const count = 0;" }],
        omittedBeforeLines: 0,
        omittedAfterLines: 0,
        detail: "Protected immutable fixture bytes.",
      },
    ],
  },
  findings: [
    {
      id: "finding",
      severity: "high",
      title: "Recorded defect",
      file: "src/路径.ts",
      line: 1,
      behavior: "Expected count differs.",
      evidence: "Original test assertion.",
      candidateId: "candidate",
      candidateRevision: "fixture-candidate",
      disposition: "open",
    },
  ],
  findingDecisions: data.findingDecisions,
  checkExecutions: [data.execution()],
  candidateArtifactReviews: {
    outputs: data.outputReviews.filter(
      (item) => item.candidateId === candidateId(),
    ),
    binaries: data.binaryReviews.filter(
      (item) => item.candidateId === candidateId(),
    ),
  },
  contexts: [
    {
      id: "context",
      role: "reviewer",
      specificationRevision: "spec",
      bytes: 100,
      tokenEvidence: "character-estimate",
      initialFiles: ["src/路径.ts"],
      retrievalRequired: true,
      budget: { maxBytes: 1000, modelWindowEvidence: "unknown" },
      omissions: [
        {
          source: "src/source-0999.ts",
          reason:
            "Optional text omitted from initial context budget; pinned retrieval remains available.",
        },
      ],
      content: "Bounded initial context fixture.",
    },
  ],
  deliveries: [
    {
      id: "delivery",
      state: "submitted",
      evidence: "transport-submission",
      detail: "Submission observed; acknowledgement unavailable.",
    },
  ],
  candidateRetrievals: {
    total: 201,
    truncated: true,
    items: [
      {
        id: "retrieval",
        method: "candidate-read-range",
        outcome: "returned",
        bytes: 20,
        path: "src/路径.ts",
        offset: 0,
        candidateRevision: "fixture-candidate",
        attemptId: "fixture-attempt",
        createdAt: new Date().toISOString(),
      },
    ],
  },
});
data.resolveHeld = () => data.held.shift()?.();
data.rejectHeldDraft = () => data.heldDrafts.shift()?.();
const preparationEvidence = () => ({
  instance: {
    state: data.preparationState,
    candidateRevision: "fixture-candidate",
    failureKind: data.preparationState === "failed" ? "preparation" : null,
    error:
      data.preparationState === "failed"
        ? "Fixture registry/cache unavailable"
        : null,
    dependencyIdentity: data.preparationState === "ready" ? digest("f") : null,
    observedToolVersions:
      data.preparationState === "ready" ? { node: "fixture-version" } : {},
    truncated: true,
  },
  recipe: {
    kind: "locked-node",
    profile: "user-approved-local",
    network: {
      preparation: "offline-package-manager; OS-network-not-enforced",
      execution: "not-enforced",
    },
    restrictions: {
      filesystem: "disposable-copy; OS-access-not-enforced",
      processes: "observed-process-group-or-tree",
      secrets: "disposable-home; no inherited provider credentials",
    },
    preparation: {
      executable: "/fixture/node",
      args: ["/fixture/npm-cli.js", "ci", "--offline", "--ignore-scripts"],
    },
  },
  logs: [
    {
      stream: "stderr",
      text: "Fixture preparation diagnostic. Credential [redacted].",
    },
  ],
});
ipcMain.handle("fixture:command", async (_, command) => {
  data.calls.push(command.type);
  try {
    const p = command.projectId;
    switch (command.type) {
      case "scope-snapshot":
        if (data.failSnapshots) throw Error("Fixture transport interrupted");
        return { value: snapshot(p) };
      case "scope-events":
        return {
          value: {
            epoch: data.epoch,
            afterSequence: command.afterSequence,
            throughSequence: data.sequence,
            headSequence: data.sequence,
            hasMore: false,
            events: [],
          },
        };
      case "builder-reviewer-query": {
        const value = {
          observation: observation(p),
          workflows: structuredClone(data.workflows),
          runtimes: structuredClone(data.runtimes),
          checkRuntime: "/fixture/node",
        };
        if (data.holdNext) {
          data.holdNext = false;
          return await new Promise((resolve) =>
            data.held.push(() => resolve({ value })),
          );
        }
        return { value };
      }
      case "builder-reviewer-create":
        data.lastCapture = command;
        data.workflows = [
          {
            ...data.workflow(command.objective),
            stage: "ready-build",
            builder: command.builder,
            reviewer: command.reviewer,
          },
        ];
        return { value: { id: "fixture-workflow" } };
      case "navigation-query":
        return { value: { projectId: p, workflowId: null } };
      case "navigation-save":
        return { value: null };
      case "usage-budget-query":
        return { value: { tokens: null, wallMs: null } };
      case "advanced-query":
        return { value: { enabled: false, templates: [], presets: [] } };
      case "replication-query":
        return {
          value: { enabled: false, devices: [], records: [], conflicts: [] },
        };
      case "workflow-readiness-query":
        return {
          value: {
            runnable: false,
            roles: { builder: null, reviewer: null },
            observedAt: new Date().toISOString(),
          },
        };
      case "round-2-features-query":
        return {
          value: { features: [{ id: "guided-workflows", enabled: true }] },
        };
      case "environment-detect":
        return {
          value: {
            suggestions: [
              {
                id: "fixture-recipe",
                label: "Self-contained fixture check",
                kind: "self-contained",
                nodeExecutable: "/fixture/node",
                scripts: [],
                detail:
                  "Fixture recipe only; no dependency preparation is executed.",
                blockers: [],
                profile: "user-approved-local",
              },
            ],
            disclosure:
              "User-approved local fixture; no OS or network isolation is claimed.",
          },
        };
      case "workflow-draft-query":
        if (data.holdNextDraft) {
          data.holdNextDraft = false;
          return await new Promise((resolve) =>
            data.heldDrafts.push(() =>
              resolve({ error: "Previous project draft failure" }),
            ),
          );
        }
        return {
          value: {
            observation: observation(p),
            draft: data.drafts[p + ":" + (command.workflowId ?? "new")] ?? null,
          },
        };
      case "workflow-draft-save": {
        const key = p + ":" + (command.workflowId ?? "new"),
          current = data.drafts[key];
        if ((current?.revision ?? 0) !== command.expectedRevision)
          throw Error("Draft revision changed");
        const draft = (data.drafts[key] = {
          id: key,
          projectId: p,
          workflowId: command.workflowId,
          revision: (current?.revision ?? 0) + 1,
          draft: command.draft,
          updatedAt: new Date().toISOString(),
        });
        return { value: { observation: observation(p), draft } };
      }
      case "builder-reviewer-inspect":
        return { value: data.inspect() };
      case "candidate-diff-query":
        return {
          value: {
            ...data.inspect().diff,
            candidateId: command.candidateId,
            observation: observation(p),
          },
        };
      case "candidate-binary-preview":
        return {
          value: {
            observation: observation(p),
            candidateId: candidateId(),
            candidateRevision: candidateRevision(),
            path: command.path,
            hash: digest("b"),
            bytes: 68,
            mime: "image/png",
            base64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZSkAAAAASUVORK5CYII=",
            detail:
              "Pinned candidate fixture image; manual confirmation remains required.",
          },
        };
      case "candidate-review-preview": {
        const id = `plan-${Object.keys(data.plans).length + 1}`;
        const plan = (data.plans[id] = {
          id,
          candidateId: candidateId(),
          candidateRevision: candidateRevision(),
          outputs: command.outputs,
          binaries: command.binaries.map((binary) => ({
            ...binary,
            hash: digest("b"),
          })),
          capturePaths: command.capturePaths ?? [],
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
        return { value: structuredClone(plan) };
      }
      case "candidate-review-apply": {
        data.lastArtifactApply = command;
        if (data.cancelNextArtifactReview) {
          data.cancelNextArtifactReview = false;
          return { value: null };
        }
        const plan = data.plans[command.id];
        if (plan.capturePaths.length) {
          data.captured = true;
          data.workflows[0].stage = "ready-review";
          data.workflows[0].candidateRevision = candidateRevision();
        } else {
          if (plan.outputs.length)
            data.outputReviews.push({
              candidateId: plan.candidateId,
              candidateRevision: plan.candidateRevision,
              entries: plan.outputs,
              createdAt: new Date().toISOString(),
            });
          for (const binary of plan.binaries)
            data.binaryReviews.push({
              candidateId: plan.candidateId,
              candidateRevision: plan.candidateRevision,
              path: binary.path,
              hash: binary.hash,
              detail: binary.detail,
              accepted: true,
            });
        }
        return {
          value: {
            candidateId: candidateId(),
            candidateRevision: candidateRevision(),
          },
        };
      }
      case "workflow-finding-decide":
        data.findingDecisions.push({
          id: "decision",
          findingId: command.findingId,
          candidateId: command.candidateId,
          decision: command.decision,
          rationale: command.rationale,
          createdAt: new Date().toISOString(),
        });
        return { value: null };
      case "check-execution-inspect":
        return {
          value: {
            observation: observation(p),
            execution: data.execution(),
            plan: {
              definition: {
                label: "Original project test",
                executable: "/fixture/node",
                args: ["--test"],
              },
              environment: "disclosed local fixture environment",
            },
            environment: preparationEvidence(),
            logs: [
              {
                stream: "stdout",
                text: "Protected fixture log. Credential [redacted].",
              },
            ],
            cleanup: {
              id: "cleanup",
              state: data.cleanupState,
              error:
                data.cleanupState === "failed"
                  ? "Fixture cleanup interruption"
                  : null,
            },
          },
        };
      case "check-execution-reconcile":
        data.executionState = "error";
        return { value: null };
      case "check-cleanup-retry":
        data.cleanupState = "completed";
        return { value: null };
      case "coordination-query":
        return { value: snapshot(p).coordination };
      case "parallel-query":
        return {
          value: { observation: observation(p), workflows: [], queue: [] },
        };
      case "task-inspect": {
        const value = {
          observation: observation(p),
          task: data.tasks.find((task) => task.id === command.id),
          attempts: [],
          sessions: [],
          leases: [],
          configuration: { source: `Evidence for ${command.id}` },
        };
        if (data.holdTaskInspections)
          return await new Promise((resolve) =>
            data.taskInspections.push({
              id: command.id,
              complete: () => resolve({ value }),
            }),
          );
        return { value };
      }
      default:
        throw Error("External action unavailable in fixture: " + command.type);
    }
  } catch (error) {
    return { error: error.message };
  }
});
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 1280,
    height: 1000,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
