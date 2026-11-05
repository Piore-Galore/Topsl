import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { hash, stable } from "../domain/invariants";
import type { ProtectedBlobs } from "../persistence/blobs";
import type { CanonicalTool } from "../proxy/canonical";
import { relativePath, resolveInside, PathRejected } from "./paths";
import { runContained, type ContainmentPolicy } from "./sandbox";
import type { DelegationMode, ToolEffect, ToolGrants } from "./types";

/**
 * Native tools (docs/Native_Harness_Plan.md §3, "Tools and isolation"). The
 * same admitted definitions produce the model's tool schemas and the
 * dispatch table, so a model can only call what the attempt admitted, with
 * arguments checked against the schema it was shown.
 */

export interface ToolOutcome {
  ok: boolean;
  output: string;
  evidence?: Record<string, unknown> | null;
}

export interface DelegationRequest {
  mode: DelegationMode;
  task: string;
  writable: boolean;
  contextPaths: string[];
}

export interface ToolContext {
  attemptId: string;
  projectId: string;
  callId: string;
  workspace: { root: string; writable: boolean };
  /** The owner's original folder, for Git history only; never written. */
  projectRoot: string | null;
  tempRoot: string;
  grants: ToolGrants;
  signal: AbortSignal;
  timeoutMs: number;
  blobs: ProtectedBlobs;
  gitExecutable: string;
  /** The baseline the workspace copy started from: path → content hash. */
  baselineFiles: Map<string, string | null>;
  skills: SkillEntry[];
  delegate?: (request: DelegationRequest) => Promise<ToolOutcome>;
  integrate?: (childAttemptId: string) => Promise<ToolOutcome>;
  proposeMemory?: (text: string) => Promise<ToolOutcome>;
  callMcp?: (tool: string, args: unknown) => Promise<ToolOutcome>;
  onProcess?: (pid: number) => void;
}

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  body: string;
}

export interface NativeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  /** Changes whenever the implementation's behavior changes. */
  revision: string;
  /** Validates and normalizes arguments; throws ToolInputError. */
  normalize(args: unknown): any;
  /** For mutations: what the call expects to find and will leave, computed before it runs. */
  expectation?(
    args: any,
    ctx: ToolContext,
  ): Promise<Record<string, unknown> | null>;
  execute(args: any, ctx: ToolContext): Promise<ToolOutcome>;
  /** After a restart: did a recorded mutation happen? */
  reconcile?(
    args: any,
    expectation: Record<string, unknown> | null,
    ctx: ToolContext,
  ): Promise<"applied" | "not-applied" | "uncertain">;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Largest file a read returns whole; larger files report size and hash only. */
export const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_READ_LINES = 2000;
/** Inline tool output a model sees; the full output is stored as an owned blob. */
export const MAX_INLINE_OUTPUT = 64 * 1024;

export const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

/** A small JSON Schema check covering what native tool schemas use. */
export function validateArguments(
  schema: Record<string, any>,
  value: unknown,
  at = "arguments",
): void {
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ToolInputError(`${at} must be an object.`);
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? [])
      if (record[name] === undefined)
        throw new ToolInputError(`${at}.${name} is required.`);
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(record)) {
      if (!properties[name]) {
        if (schema.additionalProperties === false)
          throw new ToolInputError(`${at}.${name} is not a known argument.`);
        continue;
      }
      if (child === null && properties[name].nullable) continue;
      validateArguments(properties[name], child, `${at}.${name}`);
    }
    return;
  }
  if (Array.isArray(type)) {
    if (!type.some((t: string) => matches(t, value)))
      throw new ToolInputError(`${at} must be ${type.join(" or ")}.`);
    return;
  }
  if (type && !matches(type, value))
    throw new ToolInputError(
      `${at} must be ${type === "integer" ? "an integer" : `a ${type}`}.`,
    );
  if (schema.enum && !schema.enum.includes(value))
    throw new ToolInputError(`${at} must be one of ${schema.enum.join(", ")}.`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new ToolInputError(`${at} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum)
      throw new ToolInputError(`${at} must be at most ${schema.maximum}.`);
  }
  if (
    typeof value === "string" &&
    schema.maxLength !== undefined &&
    value.length > schema.maxLength
  )
    throw new ToolInputError(
      `${at} is longer than ${schema.maxLength} characters.`,
    );
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw new ToolInputError(`${at} has more than ${schema.maxItems} items.`);
    if (schema.items)
      value.forEach((item, i) =>
        validateArguments(schema.items, item, `${at}[${i}]`),
      );
  }
}
function matches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function schema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}
function define(
  tool: Omit<NativeTool, "normalize"> & { normalize?: (args: any) => any },
): NativeTool {
  return {
    ...tool,
    normalize: (args: unknown) => {
      validateArguments(tool.inputSchema, args);
      return tool.normalize ? tool.normalize(args) : args;
    },
  };
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

async function readText(
  file: string,
): Promise<{ bytes: Buffer; hash: string }> {
  const bytes = await readFile(file);
  return { bytes, hash: sha256(bytes) };
}

async function currentHash(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return "not-a-file";
    return sha256(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Writes through a temporary file in the same folder, then renames it. */
async function atomicWrite(
  file: string,
  content: Buffer,
  mode: number | null,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.topsl-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const handle = await open(temporary, "wx", mode ?? 0o644);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function requireWritable(ctx: ToolContext): void {
  if (!ctx.grants.write || !ctx.workspace.writable)
    throw new ToolInputError(
      "This attempt is read-only; it cannot change files.",
    );
}

const readFileTool = define({
  name: "read_file",
  description:
    "Read a text file in the workspace. Returns its sha256 (needed to edit it) and numbered lines. Use start_line and line_count for long files.",
  inputSchema: schema(
    {
      path: {
        type: "string",
        description: "Path relative to the workspace root.",
      },
      start_line: { type: "integer", minimum: 1 },
      line_count: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
    },
    ["path"],
  ),
  effect: "read",
  revision: "read_file-v1",
  normalize: (args) => ({ ...args, path: relativePath(args.path) }),
  async execute(args, ctx) {
    const file = await resolveInside(ctx.workspace.root, args.path);
    const info = await stat(file).catch(() => null);
    if (!info) return { ok: false, output: `${args.path} does not exist.` };
    if (info.isDirectory())
      return {
        ok: false,
        output: `${args.path} is a folder; use list_directory.`,
      };
    if (info.size > MAX_READ_FILE_BYTES)
      return {
        ok: false,
        output: `${args.path} is ${info.size} bytes, more than the ${MAX_READ_FILE_BYTES}-byte read limit. Use search to find the part you need.`,
      };
    const { bytes, hash: digest } = await readText(file);
    if (isBinary(bytes))
      return {
        ok: true,
        output: `path: ${args.path}\nsha256: ${digest}\nbinary file, ${bytes.length} bytes`,
        evidence: { path: args.path, sha256: digest },
      };
    const lines = bytes.toString("utf8").split("\n");
    const start = Math.min(args.start_line ?? 1, Math.max(lines.length, 1));
    const count = args.line_count ?? MAX_READ_LINES;
    const shown = lines.slice(start - 1, start - 1 + count);
    const width = String(start + shown.length).length;
    const body = shown
      .map(
        (line, i) =>
          `${String(start + i).padStart(width)}\t${line.length > 2000 ? `${line.slice(0, 2000)}… [line truncated]` : line}`,
      )
      .join("\n");
    const end = start + shown.length - 1;
    return {
      ok: true,
      output: `path: ${args.path}\nsha256: ${digest}\nlines: ${start}-${end} of ${lines.length}${end < lines.length ? " (more below)" : ""}\n${body}`,
      evidence: { path: args.path, sha256: digest },
    };
  },
});

const skipped = new Set([".git", "node_modules"]);
const listDirectoryTool = define({
  name: "list_directory",
  description:
    "List files and folders in the workspace, up to a depth. Folders end with /.",
  inputSchema: schema(
    {
      path: {
        type: "string",
        description: "Folder relative to the workspace root; '.' for the root.",
      },
      depth: { type: "integer", minimum: 1, maximum: 4 },
    },
    [],
  ),
  effect: "read",
  revision: "list_directory-v1",
  normalize: (args) => ({
    path: relativePath(args.path ?? ".", true),
    depth: args.depth ?? 2,
  }),
  async execute(args, ctx) {
    const root = await resolveInside(ctx.workspace.root, args.path);
    const lines: string[] = [];
    let truncated = false;
    const walk = async (folder: string, prefix: string, depth: number) => {
      const entries = (await readdir(folder, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (lines.length >= 1000) {
          truncated = true;
          return;
        }
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          lines.push(
            `${name}/${skipped.has(entry.name) ? " (not listed)" : ""}`,
          );
          if (depth > 1 && !skipped.has(entry.name))
            await walk(path.join(folder, entry.name), `${name}/`, depth - 1);
        } else if (entry.isSymbolicLink())
          lines.push(`${name} -> (symbolic link)`);
        else {
          const info = await stat(path.join(folder, entry.name)).catch(
            () => null,
          );
          lines.push(`${name}${info ? ` (${info.size} bytes)` : ""}`);
        }
      }
    };
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory())
      return { ok: false, output: `${args.path} is not a folder.` };
    await walk(root, args.path === "." ? "" : `${args.path}/`, args.depth);
    return {
      ok: true,
      output: `${lines.join("\n") || "(empty)"}${truncated ? "\n… more entries not shown" : ""}`,
    };
  },
});

function run(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    signal: AbortSignal;
    maxBuffer?: number;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) =>
        resolve({
          code: error
            ? typeof (error as any).code === "number"
              ? (error as any).code
              : 1
            : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? (error ? error.message : "")),
        }),
    );
  });
}

const searchPrograms = [
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
];
const searchTool = define({
  name: "search",
  description:
    "Search file contents in the workspace with a regular expression (ripgrep syntax). Returns matching lines as path:line:text.",
  inputSchema: schema(
    {
      pattern: { type: "string", maxLength: 1000 },
      path: {
        type: "string",
        description: "Folder or file to search; default the whole workspace.",
      },
      glob: {
        type: "string",
        maxLength: 200,
        description: "Only files matching this glob, such as *.ts.",
      },
      case_insensitive: { type: "boolean" },
      max_results: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["pattern"],
  ),
  effect: "read",
  revision: "search-v1",
  normalize: (args) => ({
    ...args,
    path: relativePath(args.path ?? ".", true),
    max_results: args.max_results ?? 200,
  }),
  async execute(args, ctx) {
    const target = await resolveInside(ctx.workspace.root, args.path);
    const program = searchPrograms.find((p) => existsSync(p));
    if (program) {
      const flags = [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--max-columns",
        "400",
        "--max-count",
        "50",
        "--no-require-git",
        "--glob",
        "!.git",
      ];
      if (args.case_insensitive) flags.push("--ignore-case");
      if (args.glob) flags.push("--glob", args.glob);
      const result = await run(
        program,
        [...flags, "-e", args.pattern, "--", target],
        {
          cwd: ctx.workspace.root,
          env: { PATH: "/usr/bin:/bin", HOME: ctx.tempRoot },
          timeoutMs: Math.min(ctx.timeoutMs, 30_000),
          signal: ctx.signal,
        },
      );
      if (result.code > 1)
        return {
          ok: false,
          output: `Search failed: ${result.stderr.slice(0, 2000)}`,
        };
      const root = await realPathOf(ctx.workspace.root);
      const lines = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) =>
          line.startsWith(root) ? line.slice(root.length + 1) : line,
        );
      const shown = lines.slice(0, args.max_results);
      return {
        ok: true,
        output: shown.length
          ? `${shown.join("\n")}${lines.length > shown.length ? `\n… ${lines.length - shown.length} more matches` : ""}`
          : "No matches.",
      };
    }
    // Without ripgrep: a bounded JavaScript scan.
    let expression: RegExp;
    try {
      expression = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
    } catch {
      throw new ToolInputError(
        "The pattern is not a valid regular expression.",
      );
    }
    const found: string[] = [];
    const root = await realPathOf(ctx.workspace.root);
    const walk = async (entry: string) => {
      if (found.length >= args.max_results) return;
      const info = await lstat(entry);
      if (info.isDirectory()) {
        if (skipped.has(path.basename(entry))) return;
        for (const child of await readdir(entry))
          await walk(path.join(entry, child));
      } else if (info.isFile() && info.size < 2 * 1024 * 1024) {
        const bytes = await readFile(entry);
        if (isBinary(bytes)) return;
        bytes
          .toString("utf8")
          .split("\n")
          .forEach((line, i) => {
            if (found.length < args.max_results && expression.test(line))
              found.push(
                // Workspace paths use "/" on every platform, as the other tools report them.
                `${path.relative(root, entry).split(path.sep).join("/")}:${i + 1}:${line.slice(0, 400)}`,
              );
          });
      }
    };
    await walk(target);
    return {
      ok: true,
      output: found.length ? found.join("\n") : "No matches.",
    };
  },
});

async function realPathOf(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(p);
}

const revisionPattern = /^(?!-)[A-Za-z0-9._/~^@{}-]{1,200}$/;
function gitEnvironment(ctx: ToolContext): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
    HOME: ctx.tempRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "en_US.UTF-8",
  };
}
const gitSafety = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "-c",
  "core.hooksPath=/dev/null",
];

async function git(ctx: ToolContext, args: string[]): Promise<ToolOutcome> {
  if (!ctx.projectRoot || !existsSync(path.join(ctx.projectRoot, ".git")))
    return { ok: false, output: "The project folder is not a Git repository." };
  const result = await run(
    ctx.gitExecutable,
    ["-C", ctx.projectRoot, ...gitSafety, ...args],
    {
      cwd: ctx.tempRoot,
      env: gitEnvironment(ctx),
      timeoutMs: Math.min(ctx.timeoutMs, 30_000),
      signal: ctx.signal,
    },
  );
  const text = (
    result.code === 0 ? result.stdout : `${result.stdout}\n${result.stderr}`
  ).trim();
  return { ok: result.code === 0, output: text || "(no output)" };
}

const gitLogTool = define({
  name: "git_log",
  description:
    "Show recent commits of the project's Git history (committed history only), optionally for one path.",
  inputSchema: schema(
    {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    [],
  ),
  effect: "read",
  revision: "git_log-v1",
  normalize: (args) => ({
    path: args.path === undefined ? null : relativePath(args.path),
    limit: args.limit ?? 20,
  }),
  execute: (args, ctx) =>
    git(ctx, [
      "log",
      `-n${args.limit}`,
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--format=%h %ad %an%n    %s",
      "--date=short",
      ...(args.path ? ["--", args.path] : []),
    ]),
});

const gitShowTool = define({
  name: "git_show",
  description:
    "Show a commit (message and patch) or, with path, a file's content at that revision, from the project's Git history.",
  inputSchema: schema(
    { revision: { type: "string", maxLength: 200 }, path: { type: "string" } },
    ["revision"],
  ),
  effect: "read",
  revision: "git_show-v1",
  normalize: (args) => {
    if (!revisionPattern.test(args.revision))
      throw new ToolInputError("That is not a revision name.");
    return {
      revision: args.revision,
      path: args.path === undefined ? null : relativePath(args.path),
    };
  },
  execute: (args, ctx) =>
    git(
      ctx,
      args.path
        ? [
            "show",
            "--no-color",
            "--no-textconv",
            `${args.revision}:${args.path}`,
          ]
        : [
            "show",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--stat",
            "--patch",
            args.revision,
          ],
    ),
});

const changesTool = define({
  name: "workspace_changes",
  description:
    "List the files this attempt has added, modified or deleted in its workspace copy so far.",
  inputSchema: schema({}, []),
  effect: "read",
  revision: "workspace_changes-v1",
  async execute(_args, ctx) {
    const changes = await workspaceChanges(
      ctx.workspace.root,
      ctx.baselineFiles,
    );
    return {
      ok: true,
      output: changes.length
        ? changes.map((c) => `${c.change} ${c.path}`).join("\n")
        : "No changes yet.",
    };
  },
});

/** Compares the workspace copy with its baseline by content hash. */
export async function workspaceChanges(
  root: string,
  baseline: Map<string, string | null>,
): Promise<Array<{ path: string; change: "added" | "modified" | "deleted" }>> {
  const seen = new Set<string>();
  const changes: Array<{
    path: string;
    change: "added" | "modified" | "deleted";
  }> = [];
  const walk = async (folder: string, prefix: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await walk(path.join(folder, entry.name), rel);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(".topsl-write-")) continue;
        seen.add(rel);
        const digest = sha256(await readFile(path.join(folder, entry.name)));
        if (!baseline.has(rel)) changes.push({ path: rel, change: "added" });
        else if (baseline.get(rel) !== digest)
          changes.push({ path: rel, change: "modified" });
      }
    }
  };
  await walk(root, "");
  for (const [file, digest] of baseline)
    if (digest && !seen.has(file))
      changes.push({ path: file, change: "deleted" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

const hashPattern = /^[a-f0-9]{64}$/;
const editFileTool = define({
  name: "edit_file",
  description:
    "Replace text in a workspace file. expected_sha256 is the hash read_file reported; the edit is refused if the file changed since. old_text must occur exactly once unless replace_all is true.",
  inputSchema: schema(
    {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
      expected_sha256: { type: "string" },
      replace_all: { type: "boolean" },
    },
    ["path", "old_text", "new_text", "expected_sha256"],
  ),
  effect: "mutation",
  revision: "edit_file-v1",
  normalize: (args) => {
    if (!hashPattern.test(args.expected_sha256))
      throw new ToolInputError(
        "expected_sha256 must be the 64-character hash read_file reported.",
      );
    if (!args.old_text) throw new ToolInputError("old_text cannot be empty.");
    return {
      ...args,
      path: relativePath(args.path),
      replace_all: args.replace_all === true,
    };
  },
  async expectation(args, ctx) {
    const file = await resolveInside(ctx.workspace.root, args.path, {
      write: true,
    });
    const before = await currentHash(file);
    if (before !== args.expected_sha256)
      return {
        path: args.path,
        before: args.expected_sha256,
        after: null,
        current: before,
      };
    const text = (await readFile(file)).toString("utf8");
    const next = applyEdit(
      text,
      args.old_text,
      args.new_text,
      args.replace_all,
    );
    return {
      path: args.path,
      before,
      after: typeof next === "string" ? sha256(Buffer.from(next)) : null,
    };
  },
  async execute(args, ctx) {
    requireWritable(ctx);
    const file = await resolveInside(ctx.workspace.root, args.path, {
      write: true,
    });
    const info = await stat(file).catch(() => null);
    if (!info?.isFile())
      return {
        ok: false,
        output: `${args.path} does not exist; use write_file to create it.`,
      };
    const { bytes, hash: before } = await readText(file);
    if (before !== args.expected_sha256)
      return {
        ok: false,
        output: `${args.path} changed since it was read (sha256 is now ${before}). Read it again before editing.`,
      };
    const next = applyEdit(
      bytes.toString("utf8"),
      args.old_text,
      args.new_text,
      args.replace_all,
    );
    if (typeof next !== "string") return { ok: false, output: next.error };
    const content = Buffer.from(next);
    await atomicWrite(file, content, info.mode & 0o777);
    const after = sha256(content);
    return {
      ok: true,
      output: `Edited ${args.path}. New sha256: ${after}`,
      evidence: { path: args.path, before, after },
    };
  },
  async reconcile(args, expectation, ctx) {
    return reconcileHash(ctx, args.path, expectation);
  },
});

function applyEdit(
  text: string,
  oldText: string,
  newText: string,
  all: boolean,
): string | { error: string } {
  const count = text.split(oldText).length - 1;
  if (count === 0) return { error: "old_text was not found in the file." };
  if (count > 1 && !all)
    return {
      error: `old_text occurs ${count} times; give more surrounding text or set replace_all.`,
    };
  return all
    ? text.split(oldText).join(newText)
    : text.replace(oldText, () => newText);
}

async function reconcileHash(
  ctx: ToolContext,
  relative: string,
  expectation: Record<string, unknown> | null,
): Promise<"applied" | "not-applied" | "uncertain"> {
  if (!expectation) return "uncertain";
  const file = await resolveInside(ctx.workspace.root, relative, {
    write: true,
  });
  const now = await currentHash(file);
  if (expectation.after !== undefined && now === expectation.after)
    return "applied";
  if (now === expectation.before) return "not-applied";
  return "uncertain";
}

const writeFileTool = define({
  name: "write_file",
  description:
    "Create or replace a workspace file with the given content. expected_sha256 is the current hash from read_file, or null to create a file that must not exist yet.",
  inputSchema: schema(
    {
      path: { type: "string" },
      content: { type: "string", maxLength: 4 * 1024 * 1024 },
      expected_sha256: { type: ["string", "null"] },
    },
    ["path", "content", "expected_sha256"],
  ),
  effect: "mutation",
  revision: "write_file-v1",
  normalize: (args) => {
    if (
      args.expected_sha256 !== null &&
      !hashPattern.test(args.expected_sha256)
    )
      throw new ToolInputError(
        "expected_sha256 must be null or the 64-character hash read_file reported.",
      );
    return { ...args, path: relativePath(args.path) };
  },
  async expectation(args) {
    return {
      path: args.path,
      before: args.expected_sha256,
      after: sha256(Buffer.from(args.content)),
    };
  },
  async execute(args, ctx) {
    requireWritable(ctx);
    const file = await resolveInside(ctx.workspace.root, args.path, {
      write: true,
    });
    const before = await currentHash(file);
    if (before === "not-a-file")
      return { ok: false, output: `${args.path} is not a regular file.` };
    if (before !== args.expected_sha256)
      return {
        ok: false,
        output:
          before === null
            ? `${args.path} does not exist; pass expected_sha256: null to create it.`
            : `${args.path} exists with sha256 ${before}; read it and pass that hash to replace it.`,
      };
    const content = Buffer.from(args.content);
    const mode = before ? (await stat(file)).mode & 0o777 : null;
    await atomicWrite(file, content, mode);
    const after = sha256(content);
    return {
      ok: true,
      output: `Wrote ${args.path} (${content.length} bytes). sha256: ${after}`,
      evidence: { path: args.path, before, after },
    };
  },
  reconcile: (args, expectation, ctx) =>
    reconcileHash(ctx, args.path, expectation),
});

const deleteFileTool = define({
  name: "delete_file",
  description:
    "Delete a workspace file. expected_sha256 is its current hash from read_file.",
  inputSchema: schema(
    { path: { type: "string" }, expected_sha256: { type: "string" } },
    ["path", "expected_sha256"],
  ),
  effect: "mutation",
  revision: "delete_file-v1",
  normalize: (args) => {
    if (!hashPattern.test(args.expected_sha256))
      throw new ToolInputError(
        "expected_sha256 must be the 64-character hash read_file reported.",
      );
    return { ...args, path: relativePath(args.path) };
  },
  async expectation(args) {
    return { path: args.path, before: args.expected_sha256, after: null };
  },
  async execute(args, ctx) {
    requireWritable(ctx);
    const file = await resolveInside(ctx.workspace.root, args.path, {
      write: true,
    });
    const before = await currentHash(file);
    if (before !== args.expected_sha256)
      return {
        ok: false,
        output:
          before === null
            ? `${args.path} does not exist.`
            : `${args.path} changed since it was read (sha256 ${before}).`,
      };
    await rm(file);
    return {
      ok: true,
      output: `Deleted ${args.path}.`,
      evidence: { path: args.path, before, after: null },
    };
  },
  reconcile: (args, expectation, ctx) =>
    reconcileHash(ctx, args.path, expectation),
});

/**
 * Toolchain folders a contained command may read. The Command Line Tools put
 * the real git and python ahead of /usr/bin's shims, which otherwise try to
 * write a cache outside the sandbox.
 */
export const toolchainFolders = [
  "/Library/Developer/CommandLineTools/usr",
  "/opt/homebrew",
  "/usr/local",
].filter((p) => existsSync(p));

function containment(ctx: ToolContext): ContainmentPolicy {
  return {
    workspaceRoot: ctx.workspace.root,
    writable: ctx.grants.write && ctx.workspace.writable,
    tempRoot: ctx.tempRoot,
    allowedDomains: ctx.grants.networkDomains,
    extraReadable: toolchainFolders,
  };
}

function processOutcome(
  result: Awaited<ReturnType<typeof runContained>>,
  label: string,
): ToolOutcome {
  if (!result.started)
    return {
      ok: false,
      output: `Topsl's sandbox did not start ${label.toLowerCase()}; nothing ran.\n${result.stderr.slice(0, 4000)}`,
      evidence: { started: false, exitCode: result.exitCode },
    };
  const status = result.timedOut
    ? "timed out"
    : result.cancelled
      ? "was cancelled"
      : result.signal
        ? `ended by ${result.signal}`
        : `exited with code ${result.exitCode}`;
  const parts = [`${label} ${status} after ${result.durationMs} ms.`];
  if (result.stdout)
    parts.push(
      `stdout${result.stdoutTruncated ? " (truncated)" : ""}:\n${result.stdout}`,
    );
  if (result.stderr)
    parts.push(
      `stderr${result.stderrTruncated ? " (truncated)" : ""}:\n${result.stderr}`,
    );
  if (result.violations.length)
    parts.push(
      `sandbox refused:\n${result.violations.slice(0, 20).join("\n")}`,
    );
  return {
    ok: result.exitCode === 0 && !result.timedOut && !result.cancelled,
    output: parts.join("\n\n"),
    evidence: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      violations: result.violations.slice(0, 50),
    },
  };
}

const runCommandTool = define({
  name: "run_command",
  description:
    "Run a shell command in the workspace inside Topsl's sandbox: no network unless granted, writes only inside the workspace (when the attempt may edit) and a private temporary folder.",
  inputSchema: schema(
    {
      command: { type: "string", maxLength: 20_000 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 600_000 },
    },
    ["command"],
  ),
  effect: "process",
  revision: "run_command-v1",
  async execute(args, ctx) {
    if (!ctx.grants.processes)
      throw new ToolInputError("This attempt may not run commands.");
    const result = await runContained(["/bin/sh", "-c", args.command], {
      cwd: ctx.workspace.root,
      policy: containment(ctx),
      timeoutMs: Math.min(args.timeout_ms ?? ctx.timeoutMs, ctx.timeoutMs * 5),
      signal: ctx.signal,
      onSpawn: ctx.onProcess,
    });
    return processOutcome(result, "The command");
  },
});

const runCheckTool = define({
  name: "run_check",
  description:
    "Run one of the checks the owner configured for this task, by name, inside Topsl's sandbox.",
  inputSchema: schema({ name: { type: "string", maxLength: 200 } }, ["name"]),
  effect: "process",
  revision: "run_check-v1",
  async execute(args, ctx) {
    const check = ctx.grants.checks.find((c) => c.name === args.name);
    if (!check)
      throw new ToolInputError(
        `No check is named ${args.name}. Configured: ${ctx.grants.checks.map((c) => c.name).join(", ") || "none"}.`,
      );
    const result = await runContained(check.argv, {
      cwd: ctx.workspace.root,
      policy: containment(ctx),
      // A configured check timeout is the owner's choice and is respected exactly.
      timeoutMs: check.timeoutMs,
      signal: ctx.signal,
      onSpawn: ctx.onProcess,
    });
    return processOutcome(result, `Check ${check.name}`);
  },
});

const artifactTool = define({
  name: "record_artifact",
  description:
    "Save a named text artifact (a report, a plan, findings) with this attempt's evidence.",
  inputSchema: schema(
    {
      name: { type: "string", maxLength: 200 },
      content: { type: "string", maxLength: 2 * 1024 * 1024 },
    },
    ["name", "content"],
  ),
  effect: "control",
  revision: "record_artifact-v1",
  async execute(args, ctx) {
    const stored = ctx.blobs.storeOwned(
      {
        kind: "native-evidence",
        id: ctx.attemptId,
        projectId: ctx.projectId,
        name: `artifact:${args.name}`,
      },
      Buffer.from(args.content),
    );
    return {
      ok: true,
      output: `Saved artifact ${args.name} (${stored.bytes} bytes, sha256 ${stored.hash}).`,
      evidence: { artifact: args.name, ...stored },
    };
  },
});

const loadSkillTool = define({
  name: "load_skill",
  description:
    "Load the full instructions of one of the project's skills listed in your instructions.",
  inputSchema: schema({ name: { type: "string", maxLength: 200 } }, ["name"]),
  effect: "read",
  revision: "load_skill-v1",
  async execute(args, ctx) {
    const skill = ctx.skills.find((s) => s.name === args.name);
    if (!skill) throw new ToolInputError(`No skill is named ${args.name}.`);
    return {
      ok: true,
      output: `skill: ${skill.name} (${skill.path})\n\n${skill.body}`,
    };
  },
});

const memoryTool = define({
  name: "propose_memory",
  description:
    "Propose a short durable instruction for future tasks in this project. It takes effect only after the owner accepts it.",
  inputSchema: schema({ text: { type: "string", maxLength: 2000 } }, ["text"]),
  effect: "control",
  revision: "propose_memory-v1",
  async execute(args, ctx) {
    if (!ctx.proposeMemory)
      throw new ToolInputError("Memory proposals are not available here.");
    return ctx.proposeMemory(args.text);
  },
});

const delegateTool = define({
  name: "delegate",
  description:
    "Hand a bounded sub-task to a child agent and wait for its result. mode fresh: the child sees only the task and the original snapshot. task-package: the task plus the files you name, on a snapshot of your current workspace. fork: your visible conversation so far plus the task. A writable child edits its own copy; integrate its result with integrate_child.",
  inputSchema: schema(
    {
      mode: { type: "string", enum: ["fresh", "task-package", "fork"] },
      task: { type: "string", maxLength: 20_000 },
      writable: { type: "boolean" },
      context_paths: { type: "array", items: { type: "string" }, maxItems: 50 },
    },
    ["mode", "task"],
  ),
  effect: "delegation",
  revision: "delegate-v1",
  normalize: (args) => ({
    mode: args.mode,
    task: args.task,
    writable: args.writable === true,
    contextPaths: (args.context_paths ?? []).map((p: unknown) =>
      relativePath(p),
    ),
  }),
  async execute(args, ctx) {
    if (!ctx.grants.delegation || !ctx.delegate)
      throw new ToolInputError("Delegation is not granted to this attempt.");
    if (args.writable && !(ctx.grants.write && ctx.workspace.writable))
      throw new ToolInputError(
        "A read-only attempt cannot start a writable child.",
      );
    return ctx.delegate(args);
  },
});

const integrateTool = define({
  name: "integrate_child",
  description:
    "Apply a finished writable child's changes to your workspace. Refused for any file you changed since the child started.",
  inputSchema: schema(
    { child_attempt_id: { type: "string", maxLength: 200 } },
    ["child_attempt_id"],
  ),
  effect: "mutation",
  revision: "integrate_child-v1",
  async execute(args, ctx) {
    requireWritable(ctx);
    if (!ctx.integrate)
      throw new ToolInputError("Integration is not available here.");
    return ctx.integrate(args.child_attempt_id);
  },
});

export const coreTools: NativeTool[] = [
  readFileTool,
  listDirectoryTool,
  searchTool,
  gitLogTool,
  gitShowTool,
  changesTool,
  editFileTool,
  writeFileTool,
  deleteFileTool,
  runCommandTool,
  runCheckTool,
  artifactTool,
  loadSkillTool,
  memoryTool,
  delegateTool,
  integrateTool,
];

/** An admitted MCP tool, run by the MCP broker under containment. */
export function mcpTool(definition: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  revision: string;
}): NativeTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    effect: "process",
    revision: definition.revision,
    normalize(args) {
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new ToolInputError("arguments must be an object.");
      return args;
    },
    async execute(args, ctx) {
      if (!ctx.callMcp)
        throw new ToolInputError("MCP tools are not available here.");
      return ctx.callMcp(definition.name, args);
    },
  };
}

/**
 * The tools an attempt may use. Writes, processes, delegation, skills and
 * memory are admitted only when granted; read tools always are.
 */
export function admitTools(
  grants: ToolGrants,
  options: {
    skills: boolean;
    memory: boolean;
    mcp: NativeTool[];
    childOf: string | null;
  },
): NativeTool[] {
  const tools = coreTools.filter((tool) => {
    switch (tool.name) {
      case "edit_file":
      case "write_file":
      case "delete_file":
        return grants.write;
      case "run_command":
        return grants.processes;
      case "run_check":
        return grants.checks.length > 0;
      case "delegate":
        return grants.delegation;
      case "integrate_child":
        return grants.delegation && grants.write;
      case "load_skill":
        return options.skills;
      case "propose_memory":
        return options.memory && !options.childOf;
      default:
        return true;
    }
  });
  const admitted = new Set(grants.mcpTools);
  return [...tools, ...options.mcp.filter((t) => admitted.has(t.name))];
}

export function toolDefinitions(tools: NativeTool[]): CanonicalTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function toolsHash(tools: NativeTool[]): string {
  return hash(
    stable(
      tools.map((t) => ({
        name: t.name,
        revision: t.revision,
        effect: t.effect,
        schema: t.inputSchema,
      })),
    ),
  );
}

export { PathRejected };
