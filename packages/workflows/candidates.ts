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
import os from "node:os";
import { hash, now, stable, uid } from "../domain/invariants";
import { Store } from "../persistence/store";
import { exists, isWithin, runFile } from "../platform/system";

export interface CandidateFile {
  path: string;
  hash: string | null;
  bytes: number;
  mode: number | null;
  content: string | null;
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
  omissions: Array<{ source: string; reason: string }>;
  createdAt: string;
}
export interface CandidateSelection {
  root: string;
  projectId: string;
  workflowId: string;
  authorAttemptId?: string | null;
  /** Non-Git folders need an explicit content manifest. Git folders include all safe tracked files. */
  selectedPaths?: string[];
  approvedUntracked?: string[];
  gitExecutable?: string;
  maxBytes?: number;
}
const excluded =
  /(^|\/)(\.git|node_modules|dist|release|build|coverage|\.cache|\.topsl|\.codex|\.claude|__pycache__)(\/|$)|(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
function relativePath(value: string): string {
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
  if (excluded.test(normalized))
    throw new Error(
      `Candidate path is excluded by the protected-input policy: ${normalized}`,
    );
  return normalized;
}
async function rootIdentity(
  root: string,
): Promise<{ root: string; identity: string }> {
  const canonical = await realpath(root),
    stat = await lstat(canonical);
  if (!stat.isDirectory())
    throw new Error("Candidate workspace is not a directory.");
  return {
    root: canonical,
    identity: hash(stable([canonical, String(stat.dev), String(stat.ino)])),
  };
}
async function readFile(
  root: string,
  relative: string,
  limit: number,
): Promise<CandidateFile> {
  const file = path.resolve(root, relative);
  if (!isWithin(root, file))
    throw new Error("Candidate path escapes the approved workspace.");
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(
          `Candidate symlinks need an explicitly supported snapshot route: ${relative}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          path: relative,
          hash: null,
          bytes: 0,
          mode: null,
          content: null,
        };
      throw error;
    }
  }
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit)
      throw new Error(
        `Candidate file exceeds the snapshot limit or is not a regular file: ${relative}`,
      );
    const bytes = await handle.readFile(),
      after = await handle.stat(),
      target = await lstat(file);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      after.ino !== target.ino ||
      after.dev !== target.dev ||
      target.isSymbolicLink()
    )
      throw new Error(`Candidate changed while being captured: ${relative}`);
    return {
      path: relative,
      hash: hash(bytes),
      bytes: bytes.length,
      mode: before.mode & 0o777,
      content: bytes.toString("base64"),
    };
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
): Promise<{
  git: boolean;
  baseRevision: string | null;
  tracked: string[];
  excluded: string[];
  untracked: string[];
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
    if (!excluded.test(match[3])) tracked.push(relativePath(match[3]));
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
    excluded: [...omitted, ...ignored],
    untracked,
  };
}
function revisionOf(
  snapshot: Pick<
    CandidateSnapshot,
    | "workspaceIdentity"
    | "baseRevision"
    | "git"
    | "approvedUntracked"
    | "files"
    | "instructionHashes"
  >,
): string {
  return hash(
    stable({
      workspaceIdentity: snapshot.workspaceIdentity,
      baseRevision: snapshot.baseRevision,
      git: snapshot.git,
      approvedUntracked: snapshot.approvedUntracked,
      instructionHashes: snapshot.instructionHashes,
      files: snapshot.files.map(({ content: _, ...file }) => file),
    }),
  );
}
export async function captureCandidate(
  store: Store,
  selection: CandidateSelection,
): Promise<CandidateSnapshot> {
  const root = await rootIdentity(selection.root),
    git = await gitBasis(root.root, await gitProgram(selection.gitExecutable));
  const approvedUntracked = [
    ...new Set((selection.approvedUntracked ?? []).map(relativePath)),
  ].sort();
  const paths = [
    ...new Set([
      ...git.tracked,
      ...(selection.selectedPaths ?? []).map(relativePath),
      ...approvedUntracked,
    ]),
  ].sort();
  if (
    git.git &&
    paths.some(
      (p) => !git.tracked.includes(p) && !approvedUntracked.includes(p),
    )
  )
    throw new Error(
      "Untracked files in a Git candidate must be explicitly approved as untracked outputs.",
    );
  if (!paths.length)
    throw new Error(
      "Provide an explicit file manifest for a non-Git folder; an empty candidate cannot be accepted.",
    );
  if (!git.git && !selection.selectedPaths?.length)
    throw new Error(
      "Non-Git folders require an explicitly selected content manifest.",
    );
  const maxBytes = selection.maxBytes ?? 5_000_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20_000_000)
    throw new Error("Invalid snapshot byte budget.");
  const files: CandidateFile[] = [];
  let bytes = 0;
  for (const name of paths) {
    const file = await readFile(root.root, name, maxBytes - bytes);
    files.push(file);
    bytes += file.bytes;
  }
  const instructionHashes = files
    .filter((f) => /(^|\/)(AGENTS\.md|CLAUDE\.md)$/i.test(f.path) && f.hash)
    .map((f) => ({ path: f.path, hash: f.hash! }));
  const snapshot: CandidateSnapshot = {
    id: uid(),
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
    instructionHashes,
    omissions: [
      ...git.excluded.map((source) => ({
        source,
        reason:
          "Excluded tracked path or ignored path; unavailable to the captured candidate.",
      })),
      ...git.untracked
        .filter((p) => !approvedUntracked.includes(p))
        .map((source) => ({
          source,
          reason: "Untracked path was not approved for this candidate.",
        })),
      {
        source: "protected-input policy",
        reason:
          "Credentials, caches, build output and provider state are excluded; ignored directories are listed as a coverage boundary, not recursively read.",
      },
    ],
    createdAt: now(),
  };
  snapshot.revision = revisionOf(snapshot);
  await assertCandidateCurrent(snapshot, selection.gitExecutable);
  store.immutable("candidate", snapshot);
  return snapshot;
}
export async function assertCandidateCurrent(
  snapshot: CandidateSnapshot,
  gitExecutable?: string,
): Promise<void> {
  const current = await rootIdentity(snapshot.sourceRoot);
  if (current.identity !== snapshot.workspaceIdentity)
    throw new Error("Candidate workspace identity changed.");
  const git = await gitBasis(current.root, await gitProgram(gitExecutable));
  if (git.git !== snapshot.git || git.baseRevision !== snapshot.baseRevision)
    throw new Error("Candidate Git basis changed; evidence is stale.");
  if (git.git) {
    const expectedTracked = snapshot.files
      .map((f) => f.path)
      .filter((p) => !snapshot.approvedUntracked.includes(p));
    if (
      git.tracked.some((p) => !expectedTracked.includes(p)) ||
      expectedTracked.some((p) => !git.tracked.includes(p))
    )
      throw new Error(
        "Candidate tracked-file manifest changed; evidence is stale.",
      );
  }
  const files: CandidateFile[] = [];
  for (const file of snapshot.files)
    files.push(await readFile(current.root, file.path, 20_000_000));
  if (revisionOf({ ...snapshot, files }) !== snapshot.revision)
    throw new Error(
      "Candidate bytes changed; review and check evidence is stale.",
    );
}
export async function materializeCandidate(
  snapshot: CandidateSnapshot,
): Promise<{
  root: string;
  cleanup: () => Promise<void>;
  assertUnchanged: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "topsl-candidate-"));
  await chmod(root, 0o700);
  try {
    for (const file of snapshot.files) {
      if (file.content === null) continue;
      const relative = relativePath(file.path),
        bytes = Buffer.from(file.content, "base64");
      if (hash(bytes) !== file.hash || bytes.length !== file.bytes)
        throw new Error("Stored candidate content integrity failed.");
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, {
        flag: "wx",
        mode: (file.mode ?? 0o600) & ~0o222,
      });
    }
    return {
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
      assertUnchanged: () => assertMaterializedCandidate(snapshot, root),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export async function assertMaterializedCandidate(
  snapshot: CandidateSnapshot,
  root: string,
  exactFiles = false,
): Promise<void> {
  for (const file of snapshot.files) {
    const current = await readFile(root, file.path, 20_000_000);
    if (current.hash !== file.hash)
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
  for (const file of snapshot.files) {
    const bytes =
      file.content === null ? null : Buffer.from(file.content, "base64");
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
