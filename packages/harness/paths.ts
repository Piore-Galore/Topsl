import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Workspace path rules for native tools. Every path a model names is
 * relative to the attempt's own workspace copy and must stay inside it after
 * symbolic links are resolved; Git metadata is never written.
 */

export class PathRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathRejected";
  }
}

// Case-insensitive: on the default macOS and Windows file systems `.GIT`
// names the same folder as `.git`.
const forbiddenWrite = /(^|\/)\.git(\/|$)/i;

/** Normalizes a model-supplied relative path, or rejects it. */
export function relativePath(value: unknown, allowRoot = false): string {
  if (typeof value !== "string")
    throw new PathRejected("A path must be a string.");
  if (value.includes("\0"))
    throw new PathRejected("A path cannot contain NUL.");
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "." || trimmed === "./") {
    if (allowRoot) return ".";
    throw new PathRejected("Name a file inside the workspace.");
  }
  if (path.posix.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed))
    throw new PathRejected("Use a path relative to the workspace root.");
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../"))
    throw new PathRejected("The path leaves the workspace.");
  return normalized;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Resolves a relative path to an absolute one inside `root`. Existing targets
 * are resolved through symbolic links; for a new file, its nearest existing
 * parent is.
 */
export async function resolveInside(
  root: string,
  relative: string,
  options: { write?: boolean } = {},
): Promise<string> {
  const realRoot = await realpath(root);
  if (options.write && forbiddenWrite.test(relative))
    throw new PathRejected("Native tools do not write Git metadata.");
  const target = path.join(realRoot, relative === "." ? "" : relative);
  let probe = target;
  while (true) {
    try {
      const resolved = await realpath(probe);
      if (!inside(realRoot, resolved))
        throw new PathRejected("The path resolves outside the workspace.");
      // The same rule for where the path really leads: a linked folder must
      // not be a way into Git metadata.
      if (
        options.write &&
        forbiddenWrite.test(
          path.relative(realRoot, resolved).split(path.sep).join("/"),
        )
      )
        throw new PathRejected("Native tools do not write Git metadata.");
      // The nearest existing ancestor of a path that does not exist yet must
      // be a folder. POSIX already fails such a path with ENOTDIR; Windows
      // reports only that the path is missing.
      if (probe !== target && !(await stat(resolved)).isDirectory())
        throw new PathRejected(
          "The path passes through something that is not a folder, or is too long.",
        );
      if (probe === target && options.write) {
        const info = await lstat(target);
        if (info.isSymbolicLink())
          throw new PathRejected(
            "Native tools do not write through symbolic links.",
          );
      }
      return target;
    } catch (error) {
      if (error instanceof PathRejected) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      // A path through a regular file, a link loop or an over-long name is a
      // bad path from the model, not a failure of the tool.
      if (code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG")
        throw new PathRejected(
          "The path passes through something that is not a folder, or is too long.",
        );
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe || !inside(realRoot, parent))
        throw new PathRejected("The path resolves outside the workspace.");
      probe = parent;
    }
  }
}
