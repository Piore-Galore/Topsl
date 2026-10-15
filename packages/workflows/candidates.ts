import path from "node:path";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { hash, now, stable, uid } from "../domain/invariants";
import { assertRound2Feature } from "../domain/round2-features";
import { Store } from "../persistence/store";
import {
  bindCandidateStore,
  candidateStore,
} from "../persistence/candidate-binding";
import {
  BLOB_CHUNK_BYTES,
  ProtectedBlobs,
  captureOwner,
} from "../persistence/blobs";
import { exists, isWithin, runFile } from "../platform/system";

export interface CandidateFile {
  path: string;
  hash: string | null;
  bytes: number;
  mode: number | null;
  /** Legacy-only base64. v2 uses encrypted deduplicated blobs. */
  content: string | null;
  blobHash?: string | null;
  blobCandidateId?: string;
  type?: "text" | "binary" | "deleted";
  change?: "added" | "modified" | "deleted" | "unchanged";
}
export interface CandidateSnapshot {
  id: string;
  projectId: string;
  workflowId: string;
  authorAttemptId: string | null;
  sourceRoot: string;
  workspaceIdentity: string;
  revision: string;
  baseRevision: string | null;
  git: boolean;
  approvedUntracked: string[];
  files: CandidateFile[];
  instructionHashes: Array<{ path: string; hash: string }>;
  omissions: Array<{ source: string; reason: string; required?: boolean }>;
  createdAt: string;
  formatVersion?: 2;
  contentRevision?: string;
  baseCandidateId?: string | null;
  trackedPaths?: string[];
  outputs?: Array<{
    path: string;
    hash: string | null;
    status: "approved" | "pending" | "rejected";
    required: boolean;
  }>;
  changes?: Array<{
    path: string;
    kind: "added" | "modified" | "deleted" | "renamed";
    previousPath?: string;
  }>;
  coverage?: {
    complete: boolean;
    blockers: string[];
    manualBinaryPaths: string[];
    policyVersion: "protected-source-v2";
  };
}
export interface CandidateSelection {
  root: string;
  projectId: string;
  workflowId: string;
  authorAttemptId?: string | null;
  selectedPaths?: string[];
  approvedUntracked?: string[];
  gitExecutable?: string;
  /** Legacy alias for projectBytes. These are capture limits, never prompt budgets. */
  maxBytes?: number;
  limits?: {
    fileBytes?: number;
    projectBytes?: number;
    fileCount?: number;
    vaultBytes?: number;
  };
  signal?: AbortSignal;
  baseCandidateId?: string;
  rejectedOutputs?: string[];
  approvedExclusions?: string[];
  reviewedSourcePaths?: string[];
  /** Native-approved output capture pins the proposed hash before publication. */
  expectedOutputHashes?: Record<string, string>;
}
// build/ and release/ are deliberately absent: tracked source there is source.
const protectedPath =
  /(^|\/)(\.git|node_modules|dist|coverage|\.cache|\.topsl|\.codex|\.claude|\.ssh|\.aws|\.azure|\.kube|__pycache__)(\/|$)|(^|\/)(\.env(?:\..*)?|\.netrc|\.git-credentials|\.pypirc|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const legacyExcluded =
  /(^|\/)(\.git|node_modules|dist|release|build|coverage|\.cache|\.topsl|\.codex|\.claude|__pycache__)(\/|$)|(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
export function candidateRelativePath(
  value: string,
  allowProtected = false,
): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error(
      "Candidate paths must be explicit relative files inside the approved workspace.",
    );
  if (
    !allowProtected &&
    normalized
      .split("/")
      .some(
        (p) =>
          /[<>:"|?*\x00-\x1f]|[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new Error(
      `Candidate path is unsupported on the declared desktop platforms: ${normalized}`,
    );
  if (!allowProtected && protectedPath.test(normalized))
    throw new Error(
      `Candidate path is excluded by the protected-input policy: ${normalized}`,
    );
  return normalized;
}
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new Error(
      "Candidate capture cancelled; no partial manifest was published.",
    );
};
async function rootIdentity(root: string) {
  const canonical = await realpath(root),
    stat = await lstat(canonical);
  if (!stat.isDirectory())
    throw new Error("Candidate workspace is not a directory.");
  return {
    root: canonical,
    identity: hash(stable([canonical, String(stat.dev), String(stat.ino)])),
  };
}
async function readCapturedFile(
  root: string,
  relative: string,
  limit: number,
  options: {
    signal?: AbortSignal;
    blobs?: ProtectedBlobs;
    reviewed?: boolean;
    captureId?: string;
    vaultBytes?: number;
  } = {},
): Promise<{ file: CandidateFile; stagingId: string | null }> {
  cancelled(options.signal);
  const file = path.resolve(root, relative);
  if (!isWithin(root, file))
    throw new Error("Candidate path escapes the approved workspace.");
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(
          `Candidate symlinks need an explicitly supported snapshot route: ${relative}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          file: {
            path: relative,
            hash: null,
            bytes: 0,
            mode: null,
            content: null,
            blobHash: null,
            type: "deleted",
          },
          stagingId: null,
        };
      throw error;
    }
  }
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const stagingId = options.blobs ? `${options.captureId}:${uid()}` : null;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit)
      throw new Error(
        `Candidate file exceeds the capture limit or is not a regular file: ${relative}. Review the per-file/project limits before retrying.`,
      );
    const digest = createHash("sha256"),
      decoder = new TextDecoder("utf-8", { fatal: true });
    let binary = false,
      ordinal = 0,
      offset = 0,
      tail = "";
    while (offset < before.size) {
      cancelled(options.signal);
      const chunk = Buffer.alloc(
        Math.min(BLOB_CHUNK_BYTES, before.size - offset),
      );
      // Fill the whole chunk: protected range reads assume every chunk except
      // the last is exactly BLOB_CHUNK_BYTES, so short reads must not split one.
      let bytesRead = 0;
      while (bytesRead < chunk.length) {
        const result = await handle.read(
          chunk,
          bytesRead,
          chunk.length - bytesRead,
          offset + bytesRead,
        );
        if (!result.bytesRead)
          throw new Error(
            `Candidate changed while being captured: ${relative}`,
          );
        bytesRead += result.bytesRead;
      }
      const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes);
      if (bytes.includes(0)) binary = true;
      try {
        const text = decoder.decode(bytes, { stream: true });
        const inspect = tail + text;
        if (
          /(^|\/)(?:\.npmrc|\.yarnrc(?:\.yml)?|pip\.conf|auth\.json)$/i.test(
            relative,
          ) &&
          /(?:_authToken|_auth|_password|npmAuthToken|npmAuthIdent|refresh_token|access_token|client_secret)["']?\s*[:=]/i.test(
            inspect,
          )
        )
          throw new Error(
            `Credential-bearing package/provider configuration is excluded from candidates: ${relative}. Reviewed source exceptions cannot copy native/package authentication; use synthetic values or separately brokered runtime secrets.`,
          );
        if (
          !options.reviewed &&
          /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-|proj-)[A-Za-z0-9_-]{20,})\b|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{20,}/i.test(
            inspect,
          )
        )
          throw new Error(
            `Potential secret in candidate source: ${relative}. Review/redact the input; secret detection is not exhaustive.`,
          );
        tail = inspect.slice(-256);
      } catch (error) {
        if (
          error instanceof Error &&
          /^(?:Potential secret|Credential-bearing)/.test(error.message)
        )
          throw error;
        binary = true;
      }
      if (stagingId) {
        if (
          options.blobs!.usage() + bytes.length >
          (options.vaultBytes ?? Number.MAX_SAFE_INTEGER)
        )
          throw new Error(
            "Protected vault disk budget exceeded during capture; reduce scope or review retention.",
          );
        options.blobs!.stage(stagingId, ordinal, bytes);
      }
      offset += bytesRead;
      ordinal++;
    }
    try {
      decoder.decode();
    } catch {
      binary = true;
    }
    const after = await handle.stat(),
      target = await lstat(file);
    // O_NOFOLLOW alone covers only the final component. Recheck canonical
    // containment and every parent after capture as well. Node does not expose a
    // portable openat directory-descriptor route; this is not an OS sandbox.
    if (!isWithin(root, await realpath(file)))
      throw new Error(
        `Candidate path changed outside the approved workspace while being captured: ${relative}`,
      );
    let checkedParent = root;
    for (const component of relative.split("/").slice(0, -1)) {
      checkedParent = path.join(checkedParent, component);
      const stat = await lstat(checkedParent);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(
          `Candidate parent path changed while being captured: ${relative}`,
        );
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.ino !== target.ino ||
      after.dev !== target.dev ||
      target.isSymbolicLink()
    )
      throw new Error(`Candidate changed while being captured: ${relative}`);
    const value = digest.digest("hex");
    return {
      file: {
        path: relative,
        hash: value,
        bytes: offset,
        mode: before.mode & 0o777,
        content: null,
        blobHash: value,
        type: binary ? "binary" : "text",
      },
      stagingId,
    };
  } catch (error) {
    if (stagingId) options.blobs!.discard(stagingId);
    throw error;
  } finally {
    await handle.close();
  }
}
async function gitProgram(executable?: string): Promise<string> {
  return (
    executable ??
    (process.platform === "darwin" && (await exists("/opt/homebrew/bin/git"))
      ? "/opt/homebrew/bin/git"
      : "git")
  );
}
async function gitBasis(
  root: string,
  executable: string,
  legacy = false,
): Promise<{
  git: boolean;
  baseRevision: string | null;
  tracked: string[];
  excluded: string[];
  untracked: string[];
  ignored: string[];
}> {
  let repository: string;
  try {
    repository = (
      await runFile(executable, ["rev-parse", "--show-toplevel"], { cwd: root })
    ).trim();
  } catch (error) {
    if (await exists(path.join(root, ".git"))) throw error;
    return {
      git: false,
      baseRevision: null,
      tracked: [],
      excluded: [],
      untracked: [],
      ignored: [],
    };
  }
  if ((await realpath(repository)) !== root)
    throw new Error(
      "Select the Git checkout root for coordinated candidate capture.",
    );
  let baseRevision: string | null;
  try {
    baseRevision = (
      await runFile(executable, ["rev-parse", "HEAD"], { cwd: root })
    ).trim();
  } catch {
    baseRevision = null;
  }
  // --cached retains staged deletions in the HEAD union below, while stage zero
  // supplies the resulting tracked manifest. Conflicts/submodules are explicit.
  const entries = (
    await runFile(executable, ["ls-files", "--stage", "-z"], { cwd: root })
  )
    .split("\0")
    .filter(Boolean);
  const tracked: string[] = [],
    omitted: string[] = [];
  for (const entry of entries) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== "0")
      throw new Error(
        "Resolve conflicted index entries before coordinated capture.",
      );
    if (match[1] === "160000")
      throw new Error(
        "Submodule candidate capture is unsupported; use a reviewed self-contained workspace.",
      );
    if (!(legacy ? legacyExcluded : protectedPath).test(match[3]))
      tracked.push(candidateRelativePath(match[3], legacy));
    else omitted.push(match[3]);
  }
  const untracked = (
    await runFile(
      executable,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: root },
    )
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const ignored = (
    await runFile(
      executable,
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      { cwd: root },
    )
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  return {
    git: true,
    baseRevision,
    tracked: [...new Set(tracked)].sort(),
    excluded: omitted,
    untracked,
    ignored,
  };
}
function legacyRevision(
  snapshot: CandidateSnapshot,
  files = snapshot.files,
): string {
  return hash(
    stable({
      workspaceIdentity: snapshot.workspaceIdentity,
      baseRevision: snapshot.baseRevision,
      git: snapshot.git,
      approvedUntracked: snapshot.approvedUntracked,
      instructionHashes: snapshot.instructionHashes,
      files: files.map(({ path, hash, bytes, mode }) => ({
        path,
        hash,
        bytes,
        mode,
      })),
    }),
  );
}
function contentRevision(snapshot: CandidateSnapshot): string {
  return hash(
    stable({
      version: 2,
      policy: snapshot.coverage?.policyVersion,
      files: snapshot.files.map((f) => [
        f.path,
        f.hash,
        f.bytes,
        f.mode === null ? null : f.mode & 0o111,
        f.type,
      ]),
      outputs: snapshot.outputs?.map((o) => [
        o.path,
        o.hash,
        o.status,
        o.required,
      ]),
      omissions: snapshot.omissions.map((o) => [
        o.source,
        o.reason,
        o.required ?? false,
      ]),
    }),
  );
}
function captureLimits(selection: CandidateSelection) {
  const values = {
    fileBytes:
      selection.limits?.fileBytes ?? selection.maxBytes ?? 128 * 1024 * 1024,
    projectBytes:
      selection.limits?.projectBytes ?? selection.maxBytes ?? 512 * 1024 * 1024,
    fileCount: selection.limits?.fileCount ?? 20000,
    vaultBytes: selection.limits?.vaultBytes ?? 2 * 1024 * 1024 * 1024,
  };
  for (const [key, value] of Object.entries(values))
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > (key === "fileCount" ? 100000 : 16 * 1024 * 1024 * 1024)
    )
      throw new Error(`Invalid candidate ${key} capture limit.`);
  return values;
}
export async function captureCandidate(
  store: Store,
  selection: CandidateSelection,
): Promise<CandidateSnapshot> {
  assertRound2Feature(store, "manifest-context");
  cancelled(selection.signal);
  const limits = captureLimits(selection),
    root = await rootIdentity(selection.root),
    git = await gitBasis(root.root, await gitProgram(selection.gitExecutable));
  const approvedUntracked = [
    ...new Set(
      (selection.approvedUntracked ?? []).map((p) => candidateRelativePath(p)),
    ),
  ].sort();
  const baseline = selection.baseCandidateId
    ? store.get<CandidateSnapshot>("candidate", selection.baseCandidateId)
    : undefined;
  if (
    selection.baseCandidateId &&
    (!baseline || baseline.projectId !== selection.projectId)
  )
    throw new Error(
      "Candidate content base belongs to another project. A content comparison never grants workspace execution authority.",
    );
  const selected = (selection.selectedPaths ?? []).map((p) =>
    candidateRelativePath(p),
  );
  const stagedDeletions =
    git.git && git.baseRevision
      ? (
          await runFile(
            await gitProgram(selection.gitExecutable),
            [
              "diff",
              "--cached",
              "--name-only",
              "--diff-filter=D",
              "-z",
              "HEAD",
            ],
            { cwd: root.root },
          )
        )
          .split("\0")
          .filter((p) => p && !protectedPath.test(p))
          .map((p) => candidateRelativePath(p))
      : [];
  const paths = [
    ...new Set([
      ...git.tracked,
      ...stagedDeletions,
      ...selected,
      ...approvedUntracked,
      ...(baseline?.files
        .filter((f) => !protectedPath.test(f.path))
        .map((f) => f.path) ?? []),
    ]),
  ].sort();
  if (
    git.git &&
    selected.some(
      (p) =>
        !git.tracked.includes(p) &&
        !approvedUntracked.includes(p) &&
        !baseline?.files.some((f) => f.path === p),
    )
  )
    throw new Error(
      "Untracked files in a Git candidate must be explicitly approved as untracked outputs.",
    );
  if (!paths.length || (!git.git && !selection.selectedPaths?.length))
    throw new Error(
      "Non-Git folders require an explicitly selected content manifest; an empty candidate cannot be accepted.",
    );
  if (paths.length > limits.fileCount)
    throw new Error(
      `Candidate file count exceeds the capture limit (${limits.fileCount}); narrow or explicitly raise the approved scope.`,
    );
  const aliases = new Set<string>();
  for (const name of paths) {
    const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (aliases.has(folded))
      throw new Error(`Candidate has a platform path collision: ${name}`);
    aliases.add(folded);
  }
  const id = uid(),
    blobs = new ProtectedBlobs(store),
    files: CandidateFile[] = [];
  store.put("candidate-capture", {
    id,
    projectId: selection.projectId,
    workflowId: selection.workflowId,
    state: "capturing",
    owner: captureOwner,
    createdAt: now(),
  });
  let total = 0,
    committed = false;
  try {
    // Stat preflight is useful feedback, but the opened-file checks enforce limits.
    for (const name of paths) {
      const captured = await readCapturedFile(
        root.root,
        name,
        Math.min(limits.fileBytes, limits.projectBytes - total),
        {
          signal: selection.signal,
          blobs,
          reviewed: selection.reviewedSourcePaths?.includes(name),
          captureId: id,
          vaultBytes: limits.vaultBytes,
        },
      );
      const file = captured.file;
      if (
        selection.expectedOutputHashes?.[name] !== undefined &&
        selection.expectedOutputHashes[name] !== file.hash
      ) {
        if (captured.stagingId) blobs.discard(captured.stagingId);
        throw new Error(
          `Reviewed output changed before capture publication: ${name}. Request a fresh exact-hash approval; this plan is not retried.`,
        );
      }
      if (captured.stagingId)
        store.transaction(() => {
          blobs.publish(captured.stagingId!, file.hash!, file.bytes);
          blobs.reference(selection.projectId, id, file);
        });
      file.blobCandidateId = id;
      const old = baseline?.files.find((f) => f.path === name);
      file.change = !file.hash
        ? "deleted"
        : !old?.hash
          ? "added"
          : old.hash === file.hash &&
              ((old.mode ?? 0) & 0o111) === ((file.mode ?? 0) & 0o111)
            ? "unchanged"
            : "modified";
      files.push(file);
      total += file.bytes;
    }
    const exclusions = new Set(selection.approvedExclusions ?? []),
      rejected = new Set(selection.rejectedOutputs ?? []);
    const unapproved = git.untracked.filter(
      (p) => !approvedUntracked.includes(p) && !protectedPath.test(p),
    );
    const initialUntracked = new Set(
      baseline?.omissions
        .filter((o) => o.reason.startsWith("Untracked"))
        .map((o) => o.source) ?? [],
    );
    const outputPaths = [
      ...new Set([
        ...approvedUntracked,
        ...unapproved,
        ...rejected,
        ...(selection.authorAttemptId
          ? files
              .filter(
                (f) =>
                  f.hash &&
                  !baseline?.files.find((old) => old.path === f.path)?.hash,
              )
              .map((f) => f.path)
          : []),
      ]),
    ].sort();
    if (new Set([...paths, ...outputPaths]).size > limits.fileCount)
      throw new Error(
        "Candidate output file count exceeds the capture limit; narrow the output scope.",
      );
    const outputs = outputPaths.map((p) => {
      const required =
        !!selection.authorAttemptId &&
        !initialUntracked.has(p) &&
        !exclusions.has(p);
      return {
        path: p,
        hash: files.find((f) => f.path === p)?.hash ?? null,
        status: rejected.has(p)
          ? ("rejected" as const)
          : approvedUntracked.includes(p) &&
              (!required || !!baseline?.files.find((f) => f.path === p)?.hash)
            ? ("approved" as const)
            : ("pending" as const),
        required,
      };
    });
    // Hash pending/rejected regular outputs without retaining their bytes. They
    // remain visible and cannot enter checks until a new approved capture.
    for (const output of outputs)
      if (!output.hash) {
        const captured = (
          await readCapturedFile(
            root.root,
            candidateRelativePath(output.path),
            Math.min(limits.fileBytes, limits.projectBytes - total),
            { signal: selection.signal },
          )
        ).file;
        output.hash = captured.hash;
        total += captured.bytes;
      }
    const omissions: CandidateSnapshot["omissions"] = [
      ...git.excluded.map((source) => ({
        source,
        reason:
          "Protected credential/provider/cache path is excluded from declared source scope.",
        required: false,
      })),
      ...git.ignored
        .filter((p) => !approvedUntracked.includes(p.replace(/\/$/, "")))
        .map((source) => ({
          source,
          reason:
            "Ignored input is outside declared source scope; explicitly approve required assets before capture.",
          required: false,
        })),
      ...unapproved.map((source) => ({
        source,
        reason: "Untracked path was not approved for this candidate.",
        required:
          !!selection.authorAttemptId &&
          !initialUntracked.has(source) &&
          !exclusions.has(source),
      })),
    ];
    const blockers = outputs
      .filter(
        (o) => o.required && o.status !== "approved" && !exclusions.has(o.path),
      )
      .map(
        (o) =>
          `Required output ${o.path} is ${o.status}; review its hashed manifest before checks or acceptance.`,
      );
    const manualBinaryPaths = files
      .filter(
        (f) => f.type === "binary" && f.change !== "unchanged" && !!baseline,
      )
      .map((f) => f.path);
    const changes: NonNullable<CandidateSnapshot["changes"]> = files
      .filter((f) => f.change !== "unchanged")
      .map((f) => ({
        path: f.path,
        kind: f.change as "added" | "modified" | "deleted",
      }));
    for (const added of changes.filter((c) => c.kind === "added")) {
      const file = files.find((f) => f.path === added.path)!;
      const removed = changes.find(
        (c) =>
          c.kind === "deleted" &&
          baseline?.files.find((f) => f.path === c.path)?.hash === file.hash,
      );
      if (removed) {
        added.kind = "renamed";
        added.previousPath = removed.path;
      }
    }
    const snapshot: CandidateSnapshot = {
      id,
      projectId: selection.projectId,
      workflowId: selection.workflowId,
      authorAttemptId: selection.authorAttemptId ?? null,
      sourceRoot: root.root,
      workspaceIdentity: root.identity,
      revision: "",
      baseRevision: git.baseRevision,
      git: git.git,
      approvedUntracked,
      files,
      instructionHashes: files
        .filter((f) => /(^|\/)(AGENTS\.md|CLAUDE\.md)$/i.test(f.path) && f.hash)
        .map((f) => ({ path: f.path, hash: f.hash! })),
      omissions: [
        ...omissions,
        {
          source: "capture policy",
          reason:
            "Protected inputs, symlinks, submodules and platform path collisions are unavailable. Captured instructions are untrusted source. Secret detection is a control layer, not an exhaustive guarantee.",
          required: false,
        },
      ],
      createdAt: now(),
      formatVersion: 2,
      baseCandidateId: baseline?.id ?? null,
      trackedPaths: git.tracked,
      outputs,
      changes,
      coverage: {
        complete: blockers.length === 0,
        blockers,
        manualBinaryPaths,
        policyVersion: "protected-source-v2",
      },
    };
    snapshot.revision = snapshot.contentRevision = contentRevision(snapshot);
    await assertCandidateCurrent(
      snapshot,
      selection.gitExecutable,
      selection.signal,
    );
    cancelled(selection.signal);
    store.transaction(() => {
      store.immutable("candidate", snapshot);
      store.put("candidate-capture", {
        id,
        projectId: selection.projectId,
        workflowId: selection.workflowId,
        state: "complete",
        createdAt: snapshot.createdAt,
      });
    });
    committed = true;
    return bindCandidateStore(snapshot, store);
  } finally {
    if (!committed)
      store.transaction(() => {
        store.db
          .prepare(
            "DELETE FROM protected_blob_refs WHERE candidate_id=? AND project_id=?",
          )
          .run(id, selection.projectId);
        store.put("candidate-capture", {
          id,
          projectId: selection.projectId,
          state: "failed",
          createdAt: now(),
        });
      });
  }
}
export function candidateFileBytes(
  snapshot: CandidateSnapshot,
  fileOrPath: CandidateFile | string,
  store?: Store,
): Buffer | null {
  const file =
    typeof fileOrPath === "string"
      ? manifestFile(
          snapshot,
          candidateRelativePath(fileOrPath, snapshot.formatVersion !== 2),
        )
      : fileOrPath;
  const recorded = file ? manifestFile(snapshot, file.path) : undefined;
  if (
    !file ||
    !recorded ||
    recorded.hash !== file.hash ||
    recorded.bytes !== file.bytes ||
    recorded.mode !== file.mode
  )
    throw new Error("Candidate file is outside the pinned manifest.");
  if (!file.hash) return null;
  if (snapshot.formatVersion !== 2) {
    if (file.content === null)
      throw new Error("Legacy candidate bytes are missing.");
    const bytes = Buffer.from(file.content, "base64");
    if (hash(bytes) !== file.hash || bytes.length !== file.bytes)
      throw new Error("Stored candidate content integrity failed.");
    return bytes;
  }
  const vault = validateCandidateReference(snapshot, store);
  return new ProtectedBlobs(vault).read(snapshot.projectId, snapshot.id, file);
}
export function candidateFileRange(
  snapshot: CandidateSnapshot,
  filePath: string,
  range: { offset: number; length: number },
  store?: Store,
): Buffer | null {
  const file = manifestFile(
    snapshot,
    candidateRelativePath(filePath, snapshot.formatVersion !== 2),
  );
  if (!file) throw new Error("Candidate file is outside the pinned manifest.");
  if (
    !Number.isSafeInteger(range.length) ||
    range.length < 0 ||
    range.length > 256 * 1024
  )
    throw new Error("Candidate range exceeds the 256 KiB retrieval limit.");
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    range.offset > file.bytes
  )
    throw new Error("Invalid candidate range offset.");
  if (snapshot.formatVersion !== 2)
    return (
      candidateFileBytes(snapshot, file, store)?.subarray(
        range.offset,
        range.offset + range.length,
      ) ?? null
    );
  const vault = validateCandidateReference(snapshot, store);
  return new ProtectedBlobs(vault).read(
    snapshot.projectId,
    snapshot.id,
    file,
    range.offset,
    range.length,
  );
}
/** Validates a finding location against pinned text without loading a large
 * source file into one string. Binary byte offsets are a separate review route. */
export function candidateHasTextLine(
  snapshot: CandidateSnapshot,
  name: string,
  line: number,
  store?: Store,
): boolean {
  if (!Number.isSafeInteger(line) || line < 1) return false;
  let file: CandidateFile | undefined;
  try {
    file = manifestFile(
      snapshot,
      candidateRelativePath(name, snapshot.formatVersion !== 2),
    );
  } catch {
    return false;
  }
  if (!file?.hash || file.type === "binary") return false;
  if (snapshot.formatVersion !== 2) {
    const bytes = candidateFileBytes(snapshot, file, store)!;
    try {
      const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
      return !bytes.includes(0) && line <= text.split("\n").length;
    } catch {
      return false;
    }
  }
  // Read at least one range so the project/candidate reference is authorized.
  let lines = 1;
  for (
    let offset = 0;
    offset < Math.max(1, file.bytes);
    offset += BLOB_CHUNK_BYTES
  ) {
    const bytes = candidateFileRange(
      snapshot,
      file.path,
      {
        offset: Math.min(offset, file.bytes),
        length: Math.min(BLOB_CHUNK_BYTES, Math.max(0, file.bytes - offset)),
      },
      store,
    )!;
    if (lines >= line) return true;
    for (const byte of bytes) if (byte === 10 && ++lines >= line) return true;
  }
  return false;
}
const validatedCandidates = new WeakMap<CandidateSnapshot, Store>();
const manifestIndexes = new WeakMap<
  CandidateSnapshot,
  Map<string, CandidateFile>
>();
function manifestFile(
  snapshot: CandidateSnapshot,
  name: string,
): CandidateFile | undefined {
  let index = manifestIndexes.get(snapshot);
  if (!index) {
    index = new Map(snapshot.files.map((file) => [file.path, file]));
    if (Object.isFrozen(snapshot)) manifestIndexes.set(snapshot, index);
  }
  return index.get(name);
}
function validateCandidateReference(
  snapshot: CandidateSnapshot,
  explicit?: Store,
): Store {
  const vault = candidateStore(snapshot, explicit);
  if (validatedCandidates.get(snapshot) === vault) return vault;
  const saved = vault.get<CandidateSnapshot>("candidate", snapshot.id);
  if (
    !saved ||
    saved.formatVersion !== 2 ||
    saved.projectId !== snapshot.projectId ||
    saved.workflowId !== snapshot.workflowId ||
    saved.revision !== snapshot.revision ||
    saved.sourceRoot !== snapshot.sourceRoot ||
    saved.workspaceIdentity !== snapshot.workspaceIdentity ||
    saved.baseRevision !== snapshot.baseRevision ||
    contentRevision(snapshot) !== snapshot.revision
  )
    throw new Error(
      "Candidate reference is outside the immutable vault scope.",
    );
  bindCandidateStore(snapshot, vault);
  validatedCandidates.set(snapshot, vault);
  return vault;
}
export async function assertCandidateCurrent(
  snapshot: CandidateSnapshot,
  gitExecutable?: string,
  signal?: AbortSignal,
): Promise<void> {
  const current = await rootIdentity(snapshot.sourceRoot);
  if (current.identity !== snapshot.workspaceIdentity)
    throw new Error("Candidate workspace identity changed.");
  const git = await gitBasis(
    current.root,
    await gitProgram(gitExecutable),
    snapshot.formatVersion !== 2,
  );
  if (git.git !== snapshot.git || git.baseRevision !== snapshot.baseRevision)
    throw new Error("Candidate Git basis changed; evidence is stale.");
  if (git.git) {
    const expected =
      snapshot.trackedPaths ??
      snapshot.files
        .map((f) => f.path)
        .filter((p) => !snapshot.approvedUntracked.includes(p));
    if (stable(git.tracked) !== stable(expected))
      throw new Error(
        "Candidate tracked-file manifest changed; evidence is stale.",
      );
  }
  const files: CandidateFile[] = [];
  try {
    for (const file of snapshot.files)
      files.push(
        (
          await readCapturedFile(
            current.root,
            file.path,
            Math.max(file.bytes, 1),
            { signal, reviewed: true },
          )
        ).file,
      );
  } catch (error) {
    throw new Error(
      `Candidate bytes changed; evidence is stale. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    snapshot.formatVersion === 2
      ? files.some(
          (f, i) =>
            f.hash !== snapshot.files[i].hash ||
            ((f.mode ?? 0) & 0o111) !== ((snapshot.files[i].mode ?? 0) & 0o111),
        )
      : legacyRevision(snapshot, files) !== snapshot.revision
  )
    throw new Error(
      "Candidate bytes changed; review and check evidence is stale.",
    );
}
export interface CandidateOutputReviewEntry {
  path: string;
  hash: string;
  decision: "approved" | "rejected";
}
export function recordCandidateOutputReview(
  store: Store,
  snapshot: CandidateSnapshot,
  entries: CandidateOutputReviewEntry[],
): void {
  validateCandidateReference(snapshot, store);
  if (!entries.length || entries.length > 1000)
    throw new Error("Review a bounded nonempty output manifest.");
  for (const entry of entries) {
    const output = snapshot.outputs?.find(
      (o) => o.path === candidateRelativePath(entry.path),
    );
    if (!output || output.hash !== entry.hash)
      throw new Error(
        "Output review does not match the exact candidate/path/hash.",
      );
    if (
      entry.decision === "approved" &&
      !snapshot.files.some(
        (f) => f.path === entry.path && f.hash === entry.hash,
      )
    )
      throw new Error(
        "This pending output was withheld from captured bytes. Approve its narrow capture path and recapture/review the resulting manifest before checks.",
      );
    if (!["approved", "rejected"].includes(entry.decision))
      throw new Error("Invalid output review decision.");
  }
  store.immutable("candidate-output-review", {
    id: uid(),
    projectId: snapshot.projectId,
    workflowId: snapshot.workflowId,
    candidateId: snapshot.id,
    candidateRevision: snapshot.revision,
    entries,
    createdAt: now(),
    source: "explicit-user-review",
  });
}
export function assertCandidateOutputCoverage(
  snapshot: CandidateSnapshot,
  store?: Store,
): void {
  const pending = snapshot.outputs?.filter((o) => o.required) ?? [];
  if (!pending.length) return;
  const vault = candidateStore(snapshot, store),
    reviews = [
      ...vault.iterate<{
        candidateId: string;
        candidateRevision: string;
        entries: CandidateOutputReviewEntry[];
      }>("candidate-output-review", { projectId: snapshot.projectId }),
    ].filter(
      (r) =>
        r.candidateId === snapshot.id &&
        r.candidateRevision === snapshot.revision,
    );
  const unresolved: string[] = [];
  for (const output of pending) {
    const decisions = reviews
      .flatMap((r) => r.entries)
      .filter((e) => e.path === output.path && e.hash === output.hash);
    const decision = decisions.at(-1);
    if (
      (decision?.decision ?? output.status) !== "approved" ||
      !snapshot.files.some(
        (f) => f.path === output.path && f.hash === output.hash,
      )
    )
      unresolved.push(
        `${output.path} is ${decision?.decision ?? output.status}`,
      );
  }
  if (unresolved.length)
    throw new Error(
      `Required output review: ${unresolved.join("; ")}. Explicit exact-hash review and captured bytes are required before execution or acceptance.`,
    );
}
export function assertCandidateCoverage(
  snapshot: CandidateSnapshot,
  store?: Store,
): void {
  assertCandidateOutputCoverage(snapshot, store);
  for (const name of snapshot.coverage?.manualBinaryPaths ?? []) {
    const vault = candidateStore(snapshot, store);
    const receipt = [
      ...vault.iterate<{
        candidateId: string;
        candidateRevision: string;
        path: string;
        hash: string;
        accepted: boolean;
      }>("candidate-binary-review", { projectId: snapshot.projectId }),
    ].find(
      (r) =>
        r.candidateId === snapshot.id &&
        r.candidateRevision === snapshot.revision &&
        r.path === name &&
        r.hash === snapshot.files.find((f) => f.path === name)?.hash &&
        r.accepted,
    );
    if (!receipt)
      throw new Error(
        `Changed binary ${name} requires explicit manual verification for this candidate.`,
      );
  }
}
export function recordCandidateBinaryReview(
  store: Store,
  snapshot: CandidateSnapshot,
  filePath: string,
  detail: string,
): void {
  const file = snapshot.files.find(
    (f) => f.path === candidateRelativePath(filePath),
  );
  if (
    !file ||
    !snapshot.coverage?.manualBinaryPaths.includes(file.path) ||
    !detail.trim()
  )
    throw new Error(
      "Manual binary verification must identify a changed binary and its observed result.",
    );
  candidateFileRange(
    snapshot,
    file.path,
    { offset: 0, length: Math.min(1, file.bytes) },
    store,
  );
  store.immutable("candidate-binary-review", {
    id: uid(),
    projectId: snapshot.projectId,
    workflowId: snapshot.workflowId,
    candidateId: snapshot.id,
    candidateRevision: snapshot.revision,
    path: file.path,
    hash: file.hash,
    accepted: true,
    detail,
    createdAt: now(),
    source: "explicit-user-verification",
  });
}
export async function materializeCandidate(
  snapshot: CandidateSnapshot,
  preparedRoot?: string,
  store?: Store,
): Promise<{
  root: string;
  cleanup: () => Promise<void>;
  assertUnchanged: () => Promise<void>;
}> {
  if (store) bindCandidateStore(snapshot, store);
  const root =
    preparedRoot ?? (await mkdtemp(path.join(os.tmpdir(), "topsl-candidate-")));
  if (preparedRoot) await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  try {
    for (const file of snapshot.files) {
      if (!file.hash) continue;
      const target = path.join(
        root,
        candidateRelativePath(file.path, snapshot.formatVersion !== 2),
      );
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", (file.mode ?? 0o600) & ~0o222);
      try {
        if (snapshot.formatVersion === 2) {
          for (let offset = 0; offset < file.bytes; offset += BLOB_CHUNK_BYTES)
            await handle.write(
              candidateFileRange(snapshot, file.path, {
                offset,
                length: Math.min(BLOB_CHUNK_BYTES, file.bytes - offset),
              })!,
            );
        } else await handle.write(candidateFileBytes(snapshot, file)!);
      } finally {
        await handle.close();
      }
    }
    return {
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
      assertUnchanged: () => assertMaterializedCandidate(snapshot, root),
    };
  } catch (error) {
    if (!preparedRoot) await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export async function assertMaterializedCandidate(
  snapshot: CandidateSnapshot,
  root: string,
  exactFiles = false,
): Promise<void> {
  root = await realpath(root);
  for (const file of snapshot.files) {
    const current = (
      await readCapturedFile(root, file.path, Math.max(file.bytes, 1), {
        reviewed: true,
      })
    ).file;
    if (
      current.hash !== file.hash ||
      ((current.mode ?? 0) & 0o111) !== ((file.mode ?? 0) & 0o111)
    )
      throw new Error(
        "Execution modified or lost the pinned candidate; its result is invalid.",
      );
  }
  if (exactFiles) {
    const allowed = new Set(
      snapshot.files.filter((f) => f.hash).map((f) => f.path),
    );
    async function inspect(directory: string, prefix = ""): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory())
          await inspect(path.join(directory, entry.name), relative + "/");
        else if (!entry.isFile() || !allowed.has(relative))
          throw new Error(
            "Review snapshot gained an unrecorded file or symlink; review proof is invalid.",
          );
      }
    }
    await inspect(root);
  }
}
export function candidateText(
  snapshot: CandidateSnapshot,
  maxBytes = 1_000_000,
): string {
  const chunks = [
    `Candidate revision: ${snapshot.revision}`,
    `Git base: ${snapshot.baseRevision ?? "non-Git manifest"}`,
  ];
  if (snapshot.formatVersion === 2) {
    chunks.push(
      "Version 2 immutable manifest. Retrieve pinned bytes with candidate-list, candidate-search, candidate-read-range or candidate-read-binary. Binary metadata does not establish review.",
    );
    for (const file of snapshot.files) {
      const metadata = `\n--- ${file.path} (${file.hash ?? "deleted"}, ${file.bytes} bytes, ${file.type}, ${file.change}) ---`;
      if (
        Buffer.byteLength(chunks.join("\n")) + Buffer.byteLength(metadata) >
        maxBytes - 256
      ) {
        chunks.push(
          "Remaining file metadata omitted from initial input; use paginated candidate-list.",
        );
        break;
      }
      chunks.push(metadata);
      if (file.type === "text" && file.bytes <= 4096) {
        const text =
          candidateFileBytes(snapshot, file)?.toString("utf8") ?? "[deleted]";
        if (
          Buffer.byteLength(chunks.join("\n")) + Buffer.byteLength(text) <
          maxBytes - 256
        )
          chunks.push(text);
      }
    }
    return chunks.join("\n");
  }
  for (const file of snapshot.files) {
    const bytes = candidateFileBytes(snapshot, file);
    if (
      bytes &&
      (bytes.includes(0) ||
        Buffer.from(bytes.toString("utf8"), "utf8").compare(bytes) !== 0)
    )
      throw new Error(
        `Binary candidate file requires a supported review route: ${file.path}`,
      );
    chunks.push(
      `\n--- ${file.path} (${file.hash ?? "deleted"}) ---\n${bytes?.toString("utf8") ?? "[deleted]"}`,
    );
  }
  const text = chunks.join("\n");
  if (Buffer.byteLength(text) > maxBytes)
    throw new Error(
      "Candidate exceeds the context budget. Review a smaller explicit candidate; no files were silently truncated.",
    );
  return text;
}
