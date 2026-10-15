import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { linkSync, renameSync, symlinkSync } from "node:fs";
import { fixture } from "./helpers";
import { hash, now, stable } from "../packages/domain/invariants";
import { runFile } from "../packages/platform/system";
import { Store } from "../packages/persistence/store";
import {
  ProtectedBlobs,
  captureOwner,
  recoverAbandonedCaptures,
} from "../packages/persistence/blobs";
import {
  captureCandidate,
  candidateFileBytes,
  candidateFileRange,
  candidateText,
  assertCandidateCurrent,
  assertCandidateCoverage,
  recordCandidateBinaryReview,
  recordCandidateOutputReview,
  materializeCandidate,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import {
  createSpecification,
  createTaskContext,
} from "../packages/context/packages";
import {
  ContextServer,
  contextRequest,
  type ContextGrant,
} from "../packages/workspace/context";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const servers: ContextServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  servers.splice(0).forEach((s) => s.close());
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  const root = path.join(f.directory, "source");
  await mkdir(root);
  return { ...f, root };
}
const select = (root: string, selectedPaths: string[]) => ({
  root,
  projectId: "p",
  workflowId: "w",
  selectedPaths,
  gitExecutable: "missing-git-fixture",
});
const spec = (store: Store) =>
  createSpecification(store, {
    projectId: "p",
    workflowId: "w",
    objective: "Maintain the public interface",
    acceptanceCriteria: [
      "Every original acceptance requirement remains mandatory",
    ],
    interfaces: ["exported name stays stable"],
  });
function readerSubject(store: Store, candidate: CandidateSnapshot) {
  store.put("attempt", {
    id: "a",
    projectId: "p",
    taskId: "reader-task",
    sessionId: "reader-session",
    workspaceId: "reader-workspace",
  });
  store.put("task", {
    id: "reader-task",
    projectId: "p",
    workflowId: "w",
    attemptIds: ["a"],
    workspaceId: "reader-workspace",
  });
  store.put("agent-session", {
    id: "reader-session",
    projectId: "p",
    workspaceId: "reader-workspace",
  });
}

test("R2-AT-17/18 large source and unchanged binary remain complete while initial delivery is bounded", async () => {
  const f = await setup(),
    source = "export const fixture = 1; // needle\n".repeat(70000),
    image = Buffer.from([137, 80, 78, 71, 0, 1, 2]);
  await writeFile(path.join(f.root, "source.ts"), source);
  await writeFile(path.join(f.root, "image.png"), image);
  const candidate = await captureCandidate(
    f.store,
    select(f.root, ["source.ts", "image.png"]),
  );
  expect(candidate.formatVersion).toBe(2);
  expect(candidate.files.every((file) => file.content === null)).toBe(true);
  const context = createTaskContext(f.store, {
    specification: spec(f.store),
    candidate,
    taskId: "review",
    role: "reviewer",
    maxBytes: 12000,
  });
  expect(context.bytes).toBeLessThanOrEqual(12000);
  expect(context.retrievalRequired).toBe(true);
  expect(context.content).toContain("mandatory");
  expect(
    candidateFileRange(candidate, "source.ts", {
      offset: 1_500_000,
      length: 20,
    })?.toString(),
  ).toBe(source.slice(1_500_000, 1_500_020));
  expect(candidateText(candidate, 10000)).toContain("binary");
  expect(candidateText(candidate, 10000)).not.toContain(
    image.toString("base64"),
  );
  const second = await captureCandidate(f.store, {
    ...select(f.root, ["source.ts", "image.png"]),
    baseCandidateId: candidate.id,
  });
  expect(second.coverage?.manualBinaryPaths).toEqual([]);
  expect(() => assertCandidateCoverage(second, f.store)).not.toThrow();
  await writeFile(
    path.join(f.root, "image.png"),
    Buffer.from([137, 80, 78, 71, 0, 1, 3]),
  );
  const changed = await captureCandidate(f.store, {
    ...select(f.root, ["source.ts", "image.png"]),
    baseCandidateId: candidate.id,
    authorAttemptId: "builder",
  });
  expect(changed.coverage?.manualBinaryPaths).toEqual(["image.png"]);
  expect(() => assertCandidateCoverage(changed, f.store)).toThrow(
    "manual verification",
  );
  recordCandidateBinaryReview(
    f.store,
    changed,
    "image.png",
    "Inspected intended pixel change in the project preview",
  );
  expect(() => assertCandidateCoverage(changed, f.store)).not.toThrow();
});
test("R2-AT-19/23 tracked build/release source, rename and staged deletion remain visible; new output review is explicit", async () => {
  const f = await setup(),
    git = process.platform === "darwin" ? "/opt/homebrew/bin/git" : "git";
  const run = (args: string[]) => runFile(git, args, { cwd: f.root });
  await run(["init", "-q"]);
  await run(["config", "user.email", "fixture@example.invalid"]);
  await run(["config", "user.name", "Fixture"]);
  await mkdir(path.join(f.root, "build"));
  await mkdir(path.join(f.root, "release"));
  await writeFile(path.join(f.root, "build", "source.ts"), "build source");
  await writeFile(path.join(f.root, "release", "script.sh"), "release source");
  await writeFile(path.join(f.root, "old.txt"), "rename bytes");
  await writeFile(path.join(f.root, "delete.txt"), "delete bytes");
  await writeFile(path.join(f.root, ".env"), "protected fixture");
  await run(["add", "."]);
  await run(["commit", "-qm", "fixture"]);
  const baseline = await captureCandidate(f.store, {
    root: f.root,
    projectId: "p",
    workflowId: "w",
    gitExecutable: git,
  });
  expect(baseline.files.map((f) => f.path)).toContain("build/source.ts");
  expect(baseline.files.map((f) => f.path)).toContain("release/script.sh");
  expect(baseline.files.map((f) => f.path)).not.toContain(".env");
  await rename(path.join(f.root, "old.txt"), path.join(f.root, "new.txt"));
  await run(["add", "old.txt", "new.txt"]);
  await run(["rm", "-q", "delete.txt"]);
  await writeFile(path.join(f.root, "output.txt"), "new output");
  const candidate = await captureCandidate(f.store, {
    root: f.root,
    projectId: "p",
    workflowId: "w",
    gitExecutable: git,
    baseCandidateId: baseline.id,
    authorAttemptId: "a",
  });
  expect(candidate.files.find((f) => f.path === "delete.txt")?.hash).toBeNull();
  expect(candidate.changes).toContainEqual({
    path: "new.txt",
    kind: "renamed",
    previousPath: "old.txt",
  });
  expect(candidate.outputs).toContainEqual({
    path: "output.txt",
    hash: hash("new output"),
    status: "pending",
    required: true,
  });
  expect(() => assertCandidateCoverage(candidate, f.store)).toThrow("pending");
  const approved = await captureCandidate(f.store, {
    root: f.root,
    projectId: "p",
    workflowId: "w",
    gitExecutable: git,
    baseCandidateId: baseline.id,
    authorAttemptId: "a",
    approvedUntracked: ["output.txt"],
  });
  expect(candidateFileBytes(approved, "output.txt")?.toString()).toBe(
    "new output",
  );
  expect(() => assertCandidateCoverage(approved, f.store)).toThrow("pending");
  recordCandidateOutputReview(
    f.store,
    approved,
    approved
      .outputs!.filter((o) => o.required)
      .map((o) => ({ path: o.path, hash: o.hash!, decision: "approved" })),
  );
  expect(() => assertCandidateCoverage(approved, f.store)).not.toThrow();
  const rejected = await captureCandidate(f.store, {
    root: f.root,
    projectId: "p",
    workflowId: "w",
    gitExecutable: git,
    baseCandidateId: baseline.id,
    authorAttemptId: "a",
    rejectedOutputs: ["output.txt"],
  });
  expect(rejected.outputs?.find((o) => o.path === "output.txt")?.status).toBe(
    "rejected",
  );
  expect(() => assertCandidateCoverage(rejected, f.store)).toThrow("rejected");
});
test("R2-AT-20/21 immutable scoped reads cannot return workspace drift or withheld metadata/snippets", async () => {
  const f = await setup(),
    publicText = "public needle needle needle needle needle";
  await writeFile(path.join(f.root, "public.txt"), publicText);
  await writeFile(path.join(f.root, "private.txt"), "WITHHELD needle");
  await writeFile(path.join(f.root, "unicode.txt"), "汉字");
  const candidate = await captureCandidate(
    f.store,
    select(f.root, ["public.txt", "private.txt", "unicode.txt"]),
  );
  readerSubject(f.store, candidate);
  const scope = {
    projectId: "p",
    subject: { workflowId: "w", attemptId: "a" },
    candidateVisibility: "independent" as const,
    candidates: [
      {
        candidateId: candidate.id,
        revision: candidate.revision,
        paths: ["public.txt", "unicode.txt"],
      },
    ],
  };
  const req = (method: string, body: object = {}) =>
    contextRequest(f.store, scope, {
      method,
      projectId: "p",
      workflowId: "w",
      attemptId: "a",
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      ...body,
    }) as any;
  await writeFile(path.join(f.root, "public.txt"), "workspace drift");
  await expect(
    assertCandidateCurrent(candidate, "missing-git-fixture"),
  ).rejects.toThrow("stale");
  expect(
    req("candidate-read-range", { path: "public.txt", offset: 0, length: 100 })
      .content,
  ).toBe(publicText);
  expect(JSON.stringify(req("candidate-list", { limit: 1 }))).not.toContain(
    "private",
  );
  expect(
    JSON.stringify(req("candidate-search", { query: "needle", limit: 1 })),
  ).not.toContain("WITHHELD");
  const hits: any[] = [];
  let next: string | null = null;
  do {
    const page = req("candidate-search", {
      query: "needle",
      limit: 2,
      cursor: next,
    });
    hits.push(...page.items);
    next = page.nextCursor;
  } while (next);
  expect(hits).toHaveLength(5);
  expect(new Set(hits.map((hit) => hit.offset)).size).toBe(5);
  const split = req("candidate-read-range", {
    path: "unicode.txt",
    offset: 1,
    length: 1,
  });
  expect(split.encoding).toBe("base64");
  expect(Buffer.from(split.content, "base64")).toEqual(
    Buffer.from("汉字").subarray(1, 2),
  );
  expect(split.rangeHash).toBe(hash(Buffer.from("汉字").subarray(1, 2)));
  expect(() => req("candidate-read-range", { path: "private.txt" })).toThrow(
    "withheld",
  );
  expect(() => req("candidate-read-range", { path: "../public.txt" })).toThrow(
    "relative",
  );
  expect(() => req("candidate-list", { projectId: "q" })).toThrow("grant");
  expect(() => req("candidate-list", { attemptId: "other" })).toThrow("grant");
  expect(
    [...f.store.iterate<any>("candidate-retrieval", { projectId: "p" })].some(
      (r) => r.outcome === "denied",
    ),
  ).toBe(true);
  expect(Object.isFrozen(candidate.files)).toBe(true);
  expect(() => {
    candidate.projectId = "q";
  }).toThrow();
  f.store.put("task", {
    id: "reader-task",
    projectId: "other",
    workflowId: "w",
    attemptIds: ["a"],
    workspaceId: "reader-workspace",
  });
  expect(() => req("candidate-list")).toThrow("attributed");
});
test("R2-AT-21 candidate grants are checked for expiry/revocation on the live socket", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "a.txt"), "a");
  const candidate = await captureCandidate(f.store, select(f.root, ["a.txt"]));
  let tick = 1;
  readerSubject(f.store, candidate);
  const server = new ContextServer(f.store, f.directory, () => tick);
  servers.push(server);
  await server.start();
  const project = {
    id: "p",
    name: "fixture",
    path: f.root,
    realPath: f.root,
    trusted: true,
    createdAt: now(),
  };
  const grant = server.grant(project, {
    ttlMs: 10,
    subject: { workflowId: "w", attemptId: "a" },
    candidates: [{ candidateId: candidate.id, revision: candidate.revision }],
  });
  const request = (g: ContextGrant) =>
    new Promise<any>((resolve, reject) => {
      const socket = createConnection(g.endpoint);
      let text = "";
      socket.on("error", reject);
      socket.on("data", (bytes) => (text += bytes.toString()));
      socket.on("end", () => resolve(JSON.parse(text)));
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({
            ...g,
            method: "candidate-list",
            projectId: "p",
            workflowId: "w",
            attemptId: "a",
            candidateId: candidate.id,
            candidateRevision: candidate.revision,
          }) + "\n",
        ),
      );
    });
  expect((await request(grant)).result.items[0].path).toBe("a.txt");
  tick = 11;
  expect((await request(grant)).error).toContain("Invalid");
  server.revoke(grant.grant);
  expect((await request(grant)).error).toContain("Invalid");
});
test("R2-AT-22 mandatory requirements cannot be truncated to fit token or byte reserves", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "a.txt"), "a");
  const candidate = await captureCandidate(f.store, select(f.root, ["a.txt"])),
    specification = spec(f.store);
  expect(() =>
    createTaskContext(f.store, {
      specification,
      candidate,
      taskId: "t",
      role: "reviewer",
      budget: {
        contextWindowTokens: 2000,
        outputReserveTokens: 1000,
        toolReserveTokens: 1000,
        runtimeReserveTokens: 1,
      },
    }),
  ).toThrow("Mandatory context");
  expect(() =>
    createTaskContext(f.store, {
      specification: {
        ...specification,
        acceptanceCriteria: ["x".repeat(5000)],
      },
      candidate,
      taskId: "t",
      role: "reviewer",
      maxBytes: 1024,
    }),
  ).toThrow("mandatory requirement");
  expect([...f.store.iterate("task-context-package")]).toEqual([]);
});
test("R2-AT-24 content revision deduplicates across workspace identities without sharing scoped references", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "same.txt"), "DEDUP_PRIVATE_CANARY");
  const a = await captureCandidate(f.store, select(f.root, ["same.txt"]));
  const other = path.join(f.directory, "other");
  await mkdir(other);
  await writeFile(path.join(other, "same.txt"), "DEDUP_PRIVATE_CANARY");
  const b = await captureCandidate(f.store, {
    ...select(other, ["same.txt"]),
    projectId: "q",
  });
  expect(a.revision).toBe(b.revision);
  expect(a.workspaceIdentity).not.toBe(b.workspaceIdentity);
  expect(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM protected_blobs").get().n,
  ).toBe(1);
  expect(() =>
    candidateFileBytes({ ...a, id: b.id, projectId: "p" }, "same.txt", f.store),
  ).toThrow("scope");
  f.store.deleteConversation("unrelated");
  expect(candidateFileBytes(a, "same.txt")?.toString()).toBe(
    "DEDUP_PRIVATE_CANARY",
  );
  f.store.db.pragma("wal_checkpoint(TRUNCATE)");
  expect(
    (await readFile(path.join(f.directory, "history.sqlite"))).includes(
      Buffer.from("DEDUP_PRIVATE_CANARY"),
    ),
  ).toBe(false);
});
test("R2-AT-24 cancelled/limited captures publish no partial manifest; bounded recovery respects active owners", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "large.txt"), "q".repeat(200000));
  const abort = new AbortController(),
    original = ProtectedBlobs.prototype.stage;
  vi.spyOn(ProtectedBlobs.prototype, "stage").mockImplementation(function (
    this: ProtectedBlobs,
    ...args: Parameters<ProtectedBlobs["stage"]>
  ) {
    original.apply(this, args);
    abort.abort();
  });
  await expect(
    captureCandidate(f.store, {
      ...select(f.root, ["large.txt"]),
      signal: abort.signal,
    }),
  ).rejects.toThrow("cancelled");
  expect([...f.store.iterate("candidate")]).toEqual([]);
  expect(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM protected_blob_staging").get()
      .n,
  ).toBe(0);
  expect(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM protected_blob_refs").get().n,
  ).toBe(0);
  vi.restoreAllMocks();
  await expect(
    captureCandidate(f.store, {
      ...select(f.root, ["large.txt"]),
      limits: { vaultBytes: 1000 },
    }),
  ).rejects.toThrow("disk budget");
  await expect(
    captureCandidate(f.store, {
      ...select(f.root, ["large.txt"]),
      limits: { fileCount: 1, projectBytes: 1000 },
    }),
  ).rejects.toThrow("limit");
  const blobs = new ProtectedBlobs(f.store);
  f.store.put("candidate-capture", {
    id: "active",
    state: "capturing",
    owner: captureOwner,
  });
  blobs.stage("active:part", 0, Buffer.from("secret"));
  recoverAbandonedCaptures(f.store);
  expect(blobs.usage()).toBe(6);
  f.store.put("candidate-capture", {
    id: "active",
    state: "capturing",
    owner: { ...captureOwner, processToken: "previous-process" },
  });
  recoverAbandonedCaptures(f.store);
  expect(blobs.usage()).toBe(0);
});
test("R2-AT-24 legacy candidate IDs/hash/bytes retain their original semantics after schema 5 migration", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "legacy.txt"), "legacy bytes");
  const v2 = await captureCandidate(f.store, select(f.root, ["legacy.txt"]));
  const {
    formatVersion: _,
    contentRevision: __,
    coverage: ___,
    outputs: ____,
    changes: _____,
    trackedPaths: ______,
    baseCandidateId: _______,
    ...basis
  } = v2;
  const legacy: CandidateSnapshot = {
    ...basis,
    id: "legacy-original-id",
    files: [
      {
        path: "legacy.txt",
        hash: hash("legacy bytes"),
        bytes: 12,
        mode: 0o644,
        content: Buffer.from("legacy bytes").toString("base64"),
      },
    ],
    revision: "",
  };
  legacy.revision = hash(
    stable({
      workspaceIdentity: legacy.workspaceIdentity,
      baseRevision: legacy.baseRevision,
      git: legacy.git,
      approvedUntracked: legacy.approvedUntracked,
      instructionHashes: legacy.instructionHashes,
      files: legacy.files.map(({ content: _, ...file }) => file),
    }),
  );
  f.store.immutable("candidate", legacy);
  f.store.db.exec(
    "DROP TABLE protected_blob_refs;DROP TABLE protected_blob_chunks;DROP TABLE protected_blob_staging;DROP TABLE protected_blobs;DELETE FROM documents WHERE kind='migration' AND id='protected-blobs-v6';DELETE FROM documents WHERE kind='candidate' AND id!='legacy-original-id';PRAGMA user_version=5;",
  );
  f.store.close();
  f.store = new Store(path.join(f.directory, "history.sqlite"), f.key);
  fixtures[fixtures.length - 1].store = f.store;
  const reopened = f.store.get<CandidateSnapshot>("candidate", legacy.id)!;
  expect(reopened.revision).toBe(legacy.revision);
  expect(candidateText(reopened)).toContain("legacy bytes");
  await assertCandidateCurrent(reopened, "missing-git-fixture");
  const copy = await materializeCandidate(reopened);
  expect(await readFile(path.join(copy.root, "legacy.txt"), "utf8")).toBe(
    "legacy bytes",
  );
  await copy.cleanup();
  expect(
    f.store.db.prepare("PRAGMA integrity_check").get().integrity_check,
  ).toBe("ok");
});
test("capture blocks symlinks, platform aliases, submodules and flagged secrets without blessing native stores", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "A.txt"), "a");
  await writeFile(path.join(f.root, "a.txt"), "a");
  await expect(
    captureCandidate(f.store, select(f.root, ["A.txt", "a.txt"])),
  ).rejects.toThrow("collision");
  await symlink(path.join(f.root, "A.txt"), path.join(f.root, "link"));
  await expect(
    captureCandidate(f.store, select(f.root, ["link"])),
  ).rejects.toThrow("symlink");
  await writeFile(
    path.join(f.root, "source.ts"),
    "const value = '-----BEGIN PRIVATE KEY-----';",
  );
  await expect(
    captureCandidate(f.store, select(f.root, ["source.ts"])),
  ).rejects.toThrow("Potential secret");
  await mkdir(path.join(f.root, ".codex"));
  await writeFile(path.join(f.root, ".codex", "auth.json"), "synthetic");
  await expect(
    captureCandidate(f.store, {
      ...select(f.root, [".codex/auth.json"]),
      reviewedSourcePaths: [".codex/auth.json"],
    }),
  ).rejects.toThrow("excluded");
  await writeFile(
    path.join(f.root, ".npmrc"),
    "//registry.example.invalid/:_authToken=synthetic-package-token\n",
  );
  await expect(
    captureCandidate(f.store, {
      ...select(f.root, [".npmrc"]),
      reviewedSourcePaths: [".npmrc"],
    }),
  ).rejects.toThrow("Credential-bearing");
  await writeFile(
    path.join(f.root, ".npmrc"),
    "registry=https://registry.example.invalid/\nignore-scripts=true\n",
  );
  expect(
    (await captureCandidate(f.store, select(f.root, [".npmrc"]))).files[0].path,
  ).toBe(".npmrc");
  await chmod(path.join(f.root, "source.ts"), 0o755);
});
test("capture rejects a parent replaced by an outside hardlink directory before publication", async () => {
  const f = await setup(),
    inside = path.join(f.root, "parent"),
    outside = path.join(f.directory, "outside");
  await mkdir(inside);
  await mkdir(outside);
  await writeFile(path.join(inside, "source.txt"), "pinned path bytes");
  linkSync(path.join(inside, "source.txt"), path.join(outside, "source.txt"));
  const original = ProtectedBlobs.prototype.stage;
  let swapped = false;
  vi.spyOn(ProtectedBlobs.prototype, "stage").mockImplementation(function (
    this: ProtectedBlobs,
    ...args: Parameters<ProtectedBlobs["stage"]>
  ) {
    original.apply(this, args);
    if (!swapped) {
      swapped = true;
      renameSync(inside, inside + "-old");
      symlinkSync(
        outside,
        inside,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  });
  await expect(
    captureCandidate(f.store, select(f.root, ["parent/source.txt"])),
  ).rejects.toThrow("outside");
  expect([...f.store.iterate("candidate")]).toEqual([]);
  expect(
    f.store.db.prepare("SELECT COUNT(*) AS n FROM protected_blob_staging").get()
      .n,
  ).toBe(0);
});
test("submodule entries are blocked and executable bits affect content identity", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "run.sh"), "echo fixture\n");
  await chmod(path.join(f.root, "run.sh"), 0o644);
  const plain = await captureCandidate(f.store, select(f.root, ["run.sh"]));
  await chmod(path.join(f.root, "run.sh"), 0o755);
  const executable = await captureCandidate(
    f.store,
    select(f.root, ["run.sh"]),
  );
  if (process.platform !== "win32")
    expect(executable.revision).not.toBe(plain.revision);
  const git = process.platform === "darwin" ? "/opt/homebrew/bin/git" : "git";
  await runFile(git, ["init", "-q"], { cwd: f.root });
  await runFile(
    git,
    [
      "update-index",
      "--add",
      "--cacheinfo",
      "160000," + "1".repeat(40) + ",vendor",
    ],
    { cwd: f.root },
  );
  await expect(
    captureCandidate(f.store, {
      root: f.root,
      projectId: "p",
      workflowId: "w",
      gitExecutable: git,
    }),
  ).rejects.toThrow("Submodule");
});

test("manifest rollout disables new capture/context access without deleting retained evidence", async () => {
  const f = await setup();
  await writeFile(path.join(f.root, "a.txt"), "retained evidence");
  const candidate = await captureCandidate(f.store, select(f.root, ["a.txt"])),
    specification = spec(f.store);
  readerSubject(f.store, candidate);
  f.store.put("preference", {
    id: "round-2-rollout",
    disabled: ["manifest-context"],
  });
  await expect(
    captureCandidate(f.store, select(f.root, ["a.txt"])),
  ).rejects.toThrow("disabled");
  expect(() =>
    createTaskContext(f.store, {
      specification,
      candidate,
      taskId: "t",
      role: "reviewer",
    }),
  ).toThrow("disabled");
  expect(() =>
    contextRequest(
      f.store,
      {
        projectId: "p",
        subject: { workflowId: "w", attemptId: "a" },
        candidates: [
          { candidateId: candidate.id, revision: candidate.revision },
        ],
      },
      {
        method: "candidate-list",
        projectId: "p",
        workflowId: "w",
        attemptId: "a",
        candidateId: candidate.id,
        candidateRevision: candidate.revision,
      },
    ),
  ).toThrow("disabled");
  expect(candidateFileBytes(candidate, "a.txt")?.toString()).toBe(
    "retained evidence",
  );
  expect(contextRequest(f.store, "p", { method: "history" })).toEqual([]);
});
