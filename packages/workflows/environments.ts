import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import { assertRound2Feature } from "../domain/round2-features";
import type { Project } from "../domain/types";
import type { Store } from "../persistence/store";
import {
  candidatePaths,
  identity,
  localHost,
  isWithin,
} from "../platform/system";
import {
  ProcessLifecycle,
  type ProcessEvidence,
} from "../runtime/process-lifecycle";
import {
  candidateFileBytes,
  candidateFileRange,
  candidateRelativePath,
  type CandidateSnapshot,
} from "./candidates";
import type { CheckDefinition } from "./verification";

export interface EnvironmentHook {
  packagePath: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}
export interface EnvironmentSelection {
  version: 1;
  id: string;
  projectId: string;
  label: string;
  kind: "self-contained" | "locked-node";
  profile: "user-approved-local" | "isolated-required";
  nodeExecutable: string;
  npmCli?: string;
  preparationTimeoutMs: number;
  preparationNetwork?:
    "offline" | "package-manager-network" | "enforced-allowlist-required";
  writablePaths: string[];
  hooks: EnvironmentHook[];
  values: Record<string, string>;
  createdAt: string;
}
export interface EnvironmentRecipe {
  version: 1;
  id: string;
  projectId: string;
  selectionId: string | null;
  kind: EnvironmentSelection["kind"];
  profile: EnvironmentSelection["profile"];
  platform: string;
  architecture: string;
  hostId: string;
  toolchains: Array<{
    role: string;
    executable: string;
    identity: string;
    version: string | null;
    supportRoot?: string;
    supportIdentity?: string;
  }>;
  inputs: Array<{ path: string; hash: string }>;
  repositoryScripts: Array<{ name: string; command: string; hash: string }>;
  preparationProbes: Array<{
    role: string;
    executable: string;
    args: string[];
    timeoutMs: number;
  }>;
  preparation: { executable: string; args: string[]; timeoutMs: number } | null;
  hooks: Array<EnvironmentHook & { identity: string; packageIdentity: string }>;
  requiredHooks: string[];
  writablePaths: string[];
  values: Record<string, string>;
  network: {
    preparation:
      | "offline-package-manager; OS-network-not-enforced"
      | "package-manager-network; OS-network-not-enforced";
    execution: "not-enforced";
  };
  restrictions: {
    filesystem: "disposable-copy; OS-access-not-enforced";
    processes: "observed-process-group-or-tree";
    resources: "unique-temp-database-and-loopback-port";
    cpuMemory: "not-enforced";
    secrets: "disposable-home; no inherited provider credentials";
  };
  cache: "fresh-disposable-install; no-host-node_modules-or-shared-cache";
  integrityCoverage: "before-and-after content checks; local process may mutate and restore files; no runtime write enforcement";
  digest: string;
  createdAt: string;
}
export interface EnvironmentInstance {
  version: 1;
  id: string;
  projectId: string;
  executionId: string;
  candidateId: string;
  candidateRevision: string;
  recipeId: string;
  recipeDigest: string;
  state:
    | "planned"
    | "approved"
    | "preparing"
    | "ready"
    | "failed"
    | "cancelled"
    | "uncertain";
  root: string;
  home: string;
  cacheRoot: string;
  resourceId: string;
  dependencyIdentity: string | null;
  preparationLifecycle: ProcessEvidence | null;
  preparationCommandId: string | null;
  commandIndex: number;
  observedToolVersions: Record<string, string>;
  failureKind:
    "policy" | "preparation" | "timeout" | "integrity" | "cancelled" | null;
  error: string | null;
  outputBytes: number;
  truncated: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface EnvironmentLog {
  id: string;
  projectId: string;
  instanceId: string;
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  createdAt: string;
}
const secretKey =
  /(?:token|secret|password|credential|api.?key|authorization|proxy|codex|claude|openai|anthropic|ssh|npm_config|node_options|preload)/i;
const redact = (value: string) =>
  value.replace(
    /(sk-[\w-]{12,}|Bearer\s+\S+|(?:access_token|refresh_token|api_key|password)["']?\s*[:=]\s*["']?[^\s&"']+)/gi,
    "[redacted]",
  );
const supported = (selection: EnvironmentSelection) => {
  if (selection.preparationNetwork === "enforced-allowlist-required")
    throw new Error(
      "An enforceable preparation network allowlist is unavailable on this host.",
    );
  if (selection.profile !== "user-approved-local")
    throw new Error(
      "Required OS filesystem/network isolation is unavailable on this host. Select disclosed user-approved local verification or use an externally validated isolated route.",
    );
};
export function environmentSelection(
  store: Store,
  value: Omit<EnvironmentSelection, "version" | "id" | "createdAt">,
): EnvironmentSelection {
  assertRound2Feature(store, "prepared-verification");
  if (
    !["self-contained", "locked-node"].includes(value.kind) ||
    !["user-approved-local", "isolated-required"].includes(value.profile)
  )
    throw new Error("Unsupported environment recipe.");
  for (const executable of [
    value.nodeExecutable,
    ...value.hooks.map((h) => h.executable),
  ])
    if (!path.isAbsolute(executable) || /\.(?:cmd|bat)$/i.test(executable))
      throw new Error(
        "Environment commands require absolute native executables; shell wrappers are unsupported.",
      );
  if (
    value.kind === "locked-node" &&
    (!value.npmCli ||
      !path.isAbsolute(value.npmCli) ||
      path.basename(value.npmCli) !== "npm-cli.js" ||
      path.basename(path.dirname(value.npmCli)) !== "bin")
  )
    throw new Error(
      "Locked Node preparation requires an absolute npm bin/npm-cli.js file invoked through the selected native Node executable.",
    );
  if (
    !Number.isInteger(value.preparationTimeoutMs) ||
    value.preparationTimeoutMs < 100 ||
    value.preparationTimeoutMs > 300000
  )
    throw new Error("Preparation timeout must be bounded.");
  for (const key of Object.keys(value.values))
    if (
      !/^[A-Z][A-Z0-9_]{0,100}$/.test(key) ||
      secretKey.test(key) ||
      /^(?:HOME|USERPROFILE|PATH|APPDATA|LOCALAPPDATA|ELECTRON_RUN_AS_NODE|TMP|TEMP|TMPDIR|TOPSL_)/.test(
        key,
      )
    )
      throw new Error(
        "Environment values must be explicit non-secret values; runtime, credential, home, and resource overrides are unsupported.",
      );
  if (
    Object.values(value.values).some(
      (v) =>
        v.includes("\0") ||
        v.length > 2000 ||
        /sk-[\w-]{12,}|Bearer\s+|-----BEGIN .*PRIVATE KEY-----/i.test(v),
    )
  )
    throw new Error("Secret-like or invalid environment value denied.");
  const writablePaths = [
    ...new Set(value.writablePaths.map((p) => candidateRelativePath(p, true))),
  ].sort();
  if (
    writablePaths.some(
      (p) =>
        p === "node_modules" ||
        p.startsWith("node_modules/") ||
        /(^|\/)(?:tests?|__tests__|specs?)(\/|$)/i.test(p),
    )
  )
    throw new Error(
      "Dependency and harness paths cannot be declared build outputs.",
    );
  for (const hook of value.hooks) {
    if (hook.packagePath !== ".") candidateRelativePath(hook.packagePath, true);
    if (
      !Array.isArray(hook.args) ||
      hook.args.some((a) => typeof a !== "string" || a.includes("\0")) ||
      !Number.isInteger(hook.timeoutMs) ||
      hook.timeoutMs < 100 ||
      hook.timeoutMs > 300000
    )
      throw new Error(
        "Reviewed hook requires exact arguments and bounded timeout.",
      );
  }
  const selection: EnvironmentSelection = {
    ...value,
    preparationNetwork: value.preparationNetwork ?? "offline",
    writablePaths,
    version: 1,
    id: uid(),
    createdAt: now(),
  };
  store.immutable("environment-selection", selection);
  return selection;
}
async function npmCliPath(): Promise<string | undefined> {
  const npmCandidates = [
    process.env.npm_execpath,
    ...(await candidatePaths("npm")),
  ].filter((p): p is string => Boolean(p));
  for (const executable of npmCandidates) {
    try {
      const file = await realpath(executable);
      if (/npm(?:-cli)?\.[cm]?js$/i.test(file)) return file;
      if (/\.cmd$/i.test(file)) {
        const cli = path.join(
          path.dirname(file),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
        if ((await lstat(cli)).isFile()) return await realpath(cli);
      }
    } catch {}
  }
}
/** Suggestions read package metadata; they never execute repository scripts. */
export async function detectEnvironments(store: Store, project: Project) {
  assertRound2Feature(store, "prepared-verification");
  const scripts: Array<{ name: string; command: string }> = [],
    blockers: string[] = [];
  let locked = false;
  try {
    const file = path.join(project.realPath, "package.json"),
      stat = await lstat(file);
    if (stat.isSymbolicLink() || stat.size > 1000000)
      throw new Error(
        "Package metadata needs a supported bounded regular file.",
      );
    const data = JSON.parse(await readFile(file, "utf8"));
    for (const [name, command] of Object.entries(data.scripts ?? {}))
      if (typeof command === "string") scripts.push({ name, command });
    const lock = await lstat(path.join(project.realPath, "package-lock.json"));
    locked = lock.isFile() && !lock.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      blockers.push(safeError(error));
  }
  const nodeCandidate =
    process.env.npm_node_execpath &&
    path.isAbsolute(process.env.npm_node_execpath)
      ? process.env.npm_node_execpath
      : (await candidatePaths("node")).find(
          (file) => !/\.(?:cmd|bat)$/i.test(file),
        );
  const nodeExecutable = nodeCandidate
    ? await realpath(nodeCandidate)
    : process.execPath;
  const base = {
    projectId: project.id,
    nodeExecutable,
    profile: "user-approved-local" as const,
    preparationTimeoutMs: 120000,
    writablePaths: [],
    hooks: [],
    values: {},
  };
  const suggestions: Array<
    EnvironmentSelection & {
      scripts: typeof scripts;
      detail: string;
      blockers: string[];
    }
  > = [];
  suggestions.push({
    ...environmentSelection(store, {
      ...base,
      kind: "self-contained",
      label: "Self-contained command",
    }),
    scripts,
    detail:
      "No dependency preparation. Exact native command runs in a disposable copy with local OS privileges.",
    blockers: [],
  });
  if (locked) {
    const npmCli = await npmCliPath();
    if (npmCli && nodeCandidate) {
      for (const preparationNetwork of [
        "offline",
        "package-manager-network",
      ] as const)
        suggestions.push({
          ...environmentSelection(store, {
            ...base,
            kind: "locked-node",
            label:
              preparationNetwork === "offline"
                ? "Locked JavaScript / TypeScript · offline"
                : "Locked JavaScript / TypeScript · registry preparation",
            npmCli,
            preparationNetwork,
          }),
          scripts,
          detail:
            preparationNetwork === "offline"
              ? "Fresh npm ci --offline --ignore-scripts with disposable home/cache; reviewed hook exceptions only. Registry fetching is disabled for this recipe."
              : "Fresh npm ci --ignore-scripts may fetch packages during preparation after exact native approval. OS network restrictions and registry allowlists are not enforced; no native credential home is inherited.",
          blockers: [],
        });
    } else
      blockers.push(
        "A native Node executable and npm CLI JavaScript file must be selected for locked dependency preparation.",
      );
  }
  return {
    suggestions,
    blockers,
    disclosure:
      "User-approved local execution: OS filesystem, network, CPU and memory restrictions are not enforced. Repository scripts are untrusted. Checks receive a disposable home and no inherited provider credential environment.",
  };
}
function jsonCandidate(
  store: Store,
  candidate: CandidateSnapshot,
  name: string,
) {
  const value = JSON.parse(
    candidateFileBytes(candidate, name, store)!.toString("utf8"),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid environment input: ${name}`);
  return value;
}
export function environmentRecipeDigest(recipe: EnvironmentRecipe) {
  const { id: _, digest: __, createdAt: ___, ...body } = recipe;
  return hash(stable(body));
}
export async function createEnvironmentRecipe(
  store: Store,
  candidate: CandidateSnapshot,
  definition: CheckDefinition,
): Promise<EnvironmentRecipe> {
  assertRound2Feature(store, "prepared-verification");
  const selection = definition.environmentRecipeId
    ? store.get<EnvironmentSelection>(
        "environment-selection",
        definition.environmentRecipeId,
      )
    : undefined;
  if (
    definition.environmentRecipeId &&
    (!selection || selection.projectId !== candidate.projectId)
  )
    throw new Error(
      "Environment selection is outside this project or no longer available.",
    );
  const selected = selection ?? {
    version: 1 as const,
    id: "",
    projectId: candidate.projectId,
    label: "Self-contained command",
    kind: "self-contained" as const,
    profile: "user-approved-local" as const,
    nodeExecutable: definition.executable,
    preparationTimeoutMs: 120000,
    writablePaths: [],
    hooks: [],
    values: {},
    createdAt: now(),
  };
  supported(selected);
  const toolchains: EnvironmentRecipe["toolchains"] = [];
  for (const [role, executable] of [
    ["check", definition.executable],
    ...(selected.kind === "locked-node"
      ? [
          ["node", selected.nodeExecutable],
          ["npm-cli", selected.npmCli!],
        ]
      : []),
  ] as Array<[string, string]>) {
    const tool = await identity(executable);
    // Preview is read-only. Hashing an executable never grants authority to run
    // it (including --version); versions remain unobserved until execution.
    const version = null;
    const supportRoot =
      role === "npm-cli"
        ? path.resolve(path.dirname(tool.realPath), "..")
        : undefined;
    toolchains.push({
      role,
      executable: tool.realPath,
      identity: tool.identity,
      version,
      ...(supportRoot
        ? { supportRoot, supportIdentity: await treeIdentity(supportRoot) }
        : {}),
    });
  }
  const inputs: EnvironmentRecipe["inputs"] = [],
    requiredHooks: string[] = [],
    repositoryScripts: EnvironmentRecipe["repositoryScripts"] = [];
  if (candidate.files.some((f) => f.path === "package.json" && f.hash)) {
    const manifest = jsonCandidate(store, candidate, "package.json");
    for (const [name, command] of Object.entries(manifest.scripts ?? {}))
      if (typeof command === "string")
        repositoryScripts.push({ name, command, hash: hash(command) });
  }
  let lock: any;
  if (selected.kind === "locked-node") {
    for (const name of ["package.json", "package-lock.json"]) {
      const file = candidate.files.find((f) => f.path === name && f.hash);
      if (!file)
        throw new Error(
          `Locked dependency preparation requires captured ${name}.`,
        );
      inputs.push({ path: name, hash: file.hash! });
    }
    lock = jsonCandidate(store, candidate, "package-lock.json");
    const manifest = jsonCandidate(store, candidate, "package.json");
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
      throw new Error(
        "Only npm lockfile versions 2 and 3 with package entries are supported.",
      );
    if (
      [
        "preinstall",
        "install",
        "postinstall",
        "prepublish",
        "preprepare",
        "prepare",
        "postprepare",
      ].some((key) => manifest.scripts?.[key])
    )
      requiredHooks.push(".");
    for (const [name, value] of Object.entries(lock.packages)) {
      const item = value as any;
      if (name && item.hasInstallScript) requiredHooks.push(name);
      if (name && !item.integrity && !item.inBundle)
        throw new Error(
          "Dependency lock entries require integrity-bound archives; mutable Git/URL packages are unsupported.",
        );
      if (name && item.link)
        throw new Error(
          "Linked/workspace dependencies require a separately supported preparation recipe.",
        );
      if (
        name &&
        typeof item.resolved === "string" &&
        item.resolved.startsWith("file:")
      ) {
        const relative = candidateRelativePath(item.resolved.slice(5));
        const source = candidate.files.find(
          (f) => f.path === relative && f.hash,
        );
        if (!source)
          throw new Error(
            `Local dependency archive is absent from candidate: ${relative}`,
          );
        if (!/\.(?:tgz|tar\.gz)$/.test(relative) || !item.integrity)
          throw new Error(
            "Local dependencies require integrity-bound archives; mutable local folders are unsupported.",
          );
        inputs.push({ path: relative, hash: source.hash! });
      }
    }
  }
  const hooks: EnvironmentRecipe["hooks"] = [];
  for (const hook of selected.hooks) {
    if (
      selected.kind !== "locked-node" ||
      !requiredHooks.includes(hook.packagePath)
    )
      throw new Error(
        "Hook exception must name an exact package requiring lifecycle preparation in this lockfile.",
      );
    hooks.push({
      ...hook,
      identity: (await identity(hook.executable)).identity,
      packageIdentity: hash(
        stable(
          hook.packagePath === "."
            ? jsonCandidate(store, candidate, "package.json")
            : lock.packages[hook.packagePath],
        ),
      ),
    });
  }
  for (const output of selected.writablePaths)
    if (
      candidate.files.some(
        (f) => f.hash && (f.path === output || f.path.startsWith(output + "/")),
      )
    )
      throw new Error(
        "Reviewed build outputs cannot overlap immutable source or original harness inputs.",
      );
  const recipe: EnvironmentRecipe = {
    version: 1,
    id: uid(),
    projectId: candidate.projectId,
    selectionId: selection?.id ?? null,
    kind: selected.kind,
    profile: selected.profile,
    platform: os.platform(),
    architecture: os.arch(),
    hostId: localHost,
    toolchains,
    inputs,
    repositoryScripts,
    preparationProbes:
      selected.kind === "locked-node"
        ? [
            {
              role: "node",
              executable: selected.nodeExecutable,
              args: ["--version"],
              timeoutMs: 5000,
            },
            {
              role: "npm",
              executable: selected.nodeExecutable,
              args: [selected.npmCli!, "--version"],
              timeoutMs: 5000,
            },
          ]
        : [],
    preparation:
      selected.kind === "locked-node"
        ? {
            executable: selected.nodeExecutable,
            args: [
              selected.npmCli!,
              "ci",
              ...((selected.preparationNetwork ?? "offline") === "offline"
                ? ["--offline"]
                : []),
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--cache",
              "{cache}",
            ],
            timeoutMs: selected.preparationTimeoutMs,
          }
        : null,
    hooks,
    requiredHooks,
    writablePaths: selected.writablePaths,
    values: selected.values,
    network: {
      preparation:
        (selected.preparationNetwork ?? "offline") === "offline"
          ? "offline-package-manager; OS-network-not-enforced"
          : "package-manager-network; OS-network-not-enforced",
      execution: "not-enforced",
    },
    restrictions: {
      filesystem: "disposable-copy; OS-access-not-enforced",
      processes: "observed-process-group-or-tree",
      resources: "unique-temp-database-and-loopback-port",
      cpuMemory: "not-enforced",
      secrets: "disposable-home; no inherited provider credentials",
    },
    cache: "fresh-disposable-install; no-host-node_modules-or-shared-cache",
    integrityCoverage:
      "before-and-after content checks; local process may mutate and restore files; no runtime write enforcement",
    digest: "",
    createdAt: now(),
  };
  recipe.digest = environmentRecipeDigest(recipe);
  store.immutable("environment-recipe", recipe);
  return recipe;
}
/** Intentionally separate from provider nativeEnvironment: no native auth homes,
 * SSH agent, proxy, NODE_OPTIONS or provider configuration reaches checks. */
export function checkEnvironment(
  values: Record<string, string>,
  home: string,
  nodeExecutable: string,
  resources: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  env.PATH = [
    path.dirname(nodeExecutable),
    ...(process.platform === "win32"
      ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"]),
  ].join(path.delimiter);
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "appdata"),
    LOCALAPPDATA: path.join(home, "localappdata"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    ELECTRON_RUN_AS_NODE: "1",
    NPM_CONFIG_USERCONFIG: path.join(home, "user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(home, "global.npmrc"),
    ...resources,
    ...values,
  };
}
export async function verifyEnvironmentRecipe(
  store: Store,
  recipe: EnvironmentRecipe,
  candidate: CandidateSnapshot,
) {
  assertRound2Feature(store, "prepared-verification");
  if (
    recipe.digest !== environmentRecipeDigest(recipe) ||
    recipe.projectId !== candidate.projectId ||
    recipe.platform !== os.platform() ||
    recipe.architecture !== os.arch() ||
    recipe.hostId !== localHost
  )
    throw new Error("Environment recipe identity/platform changed.");
  if (recipe.profile !== "user-approved-local")
    throw new Error("Required isolation is unsupported.");
  for (const tool of recipe.toolchains) {
    if (
      (await identity(tool.executable)).identity !== tool.identity ||
      (tool.supportRoot &&
        (await treeIdentity(tool.supportRoot)) !== tool.supportIdentity)
    )
      throw new Error("Environment toolchain changed since approval.");
  }
  for (const hook of recipe.hooks)
    if ((await identity(hook.executable)).identity !== hook.identity)
      throw new Error(
        "Reviewed preparation executable changed since approval.",
      );
  for (const input of recipe.inputs)
    if (candidate.files.find((f) => f.path === input.path)?.hash !== input.hash)
      throw new Error(
        "Environment lockfile or preparation input changed since approval.",
      );
}
async function fileHash(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
async function treeIdentity(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const digest = createHash("sha256");
  let count = 0,
    total = 0;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return hash("absent");
    throw error;
  }
  async function walk(directory: string, relative = "") {
    if (signal?.aborted) throw new Error("Dependency identity cancelled.");
    for (const name of (await readdir(directory)).sort()) {
      if (signal?.aborted) throw new Error("Dependency identity cancelled.");
      if (++count > 100000)
        throw new Error(
          "Dependency/toolchain identity exceeds the supported entry budget.",
        );
      const file = path.join(directory, name),
        rel = relative ? `${relative}/${name}` : name,
        stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await realpath(file);
        if (!isWithin(canonicalRoot, target))
          throw new Error(
            "Dependency symlink escapes the prepared dependency tree.",
          );
        digest.update(stable([rel, "link", await readlink(file)]));
      } else if (stat.isDirectory()) await walk(file, rel);
      else if (stat.isFile()) {
        total += stat.size;
        if (stat.size > 128 * 1024 * 1024 || total > 1024 * 1024 * 1024)
          throw new Error(
            "Dependency/toolchain identity exceeds supported byte budgets.",
          );
        digest.update(stable([rel, stat.mode & 0o111, stat.size]));
        for await (const chunk of createReadStream(file)) {
          if (signal?.aborted)
            throw new Error("Dependency identity cancelled.");
          digest.update(chunk);
        }
      } else throw new Error("Unsupported dependency tree entry.");
    }
  }
  await walk(root);
  return digest.digest("hex");
}
export async function assertExecutionIntegrity(
  store: Store,
  candidate: CandidateSnapshot,
  root: string,
  recipe: EnvironmentRecipe,
) {
  const files = new Map(
    candidate.files.filter((f) => f.hash).map((f) => [f.path, f]),
  );
  const seen = new Set<string>();
  async function walk(directory: string, relative = "") {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name),
        rel = relative ? `${relative}/${name}` : name,
        stat = await lstat(file),
        original = files.get(rel);
      if (rel === "node_modules" && recipe.kind === "locked-node") {
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error("Prepared dependencies were replaced.");
        continue;
      }
      if (original) {
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          (await fileHash(file)) !== original.hash ||
          ((stat.mode & 0o111) !== ((original.mode ?? 0) & 0o111) &&
            process.platform !== "win32")
        )
          throw new Error(`Protected source/harness input mutated: ${rel}`);
        seen.add(rel);
        continue;
      }
      const output = recipe.writablePaths.some(
        (p) => rel === p || rel.startsWith(p + "/"),
      );
      if (output) {
        if (stat.isSymbolicLink())
          throw new Error("Build output symlinks are unsupported.");
        continue;
      }
      if (
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        [...files.keys(), ...recipe.writablePaths].some((p) =>
          p.startsWith(rel + "/"),
        )
      )
        await walk(file, rel);
      else
        throw new Error(
          `Unexpected execution output outside reviewed writable paths: ${rel}`,
        );
    }
  }
  await walk(root);
  for (const name of files.keys())
    if (!seen.has(name))
      throw new Error(`Protected source/harness input removed: ${name}`);
  // Resolve bytes through protected storage too, catching corruption of canonical inputs.
  for (const file of candidate.files)
    if (file.hash)
      for (let offset = 0; offset < file.bytes; offset += 256 * 1024)
        candidateFileRange(
          candidate,
          file.path,
          { offset, length: Math.min(256 * 1024, file.bytes - offset) },
          store,
        );
}
export class PreparedEnvironments {
  constructor(readonly store: Store) {}
  list(projectId: string) {
    return {
      recipes: [
        ...this.store.iterate<EnvironmentRecipe>("environment-recipe", {
          projectId,
        }),
      ],
      instances: [
        ...this.store.iterate<EnvironmentInstance>("environment-instance", {
          projectId,
        }),
      ],
    };
  }
  inspect(projectId: string, id: string) {
    const instance = this.store.get<EnvironmentInstance>(
      "environment-instance",
      id,
    );
    if (!instance || instance.projectId !== projectId)
      throw new Error("Environment instance is outside this project.");
    return {
      instance,
      recipe: this.store.get<EnvironmentRecipe>(
        "environment-recipe",
        instance.recipeId,
      ),
      logs: [
        ...this.store.iterate<EnvironmentLog>("environment-log", { projectId }),
      ]
        .filter((l) => l.instanceId === id)
        .sort((a, b) => a.sequence - b.sequence),
    };
  }
  create(
    recipe: EnvironmentRecipe,
    executionId: string,
    candidate: CandidateSnapshot,
    root: string,
    resourceRoot: string,
    resourceId: string,
  ): EnvironmentInstance {
    const instance: EnvironmentInstance = {
      version: 1,
      id: uid(),
      projectId: candidate.projectId,
      executionId,
      candidateId: candidate.id,
      candidateRevision: candidate.revision,
      recipeId: recipe.id,
      recipeDigest: recipe.digest,
      state: resourceId ? "approved" : "planned",
      root,
      home: resourceId ? path.join(resourceRoot, "home") : "",
      cacheRoot: resourceId ? path.join(resourceRoot, "npm-cache") : "",
      resourceId,
      dependencyIdentity: null,
      preparationLifecycle: null,
      preparationCommandId: null,
      commandIndex: 0,
      observedToolVersions: {},
      failureKind: null,
      error: null,
      outputBytes: 0,
      truncated: false,
      createdAt: now(),
      updatedAt: now(),
    };
    this.save(instance);
    return instance;
  }
  private save(instance: EnvironmentInstance) {
    instance.updatedAt = now();
    this.store.put("environment-instance", instance);
  }
  allocate(
    instance: EnvironmentInstance,
    resourceRoot: string,
    resourceId: string,
  ) {
    instance.home = path.join(resourceRoot, "home");
    instance.cacheRoot = path.join(resourceRoot, "npm-cache");
    instance.resourceId = resourceId;
    instance.state = "approved";
    this.save(instance);
  }
  failBeforePreparation(
    instance: EnvironmentInstance,
    error: unknown,
    cancelled: boolean,
  ) {
    if (!["planned", "approved"].includes(instance.state)) return;
    instance.state = cancelled ? "cancelled" : "failed";
    instance.failureKind = cancelled ? "cancelled" : "preparation";
    instance.error = safeError(error);
    this.save(instance);
  }

  async prepare(
    instance: EnvironmentInstance,
    recipe: EnvironmentRecipe,
    candidate: CandidateSnapshot,
    resources: Record<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    let sequence = 0;
    const log = (stream: EnvironmentLog["stream"], value: string) => {
      const text = redact(value);
      if (
        instance.outputBytes + Buffer.byteLength(text) > 500000 ||
        sequence >= 256
      ) {
        instance.truncated = true;
        this.save(instance);
        return;
      }
      this.store.transaction(() => {
        this.store.immutable("environment-log", {
          id: `${instance.id}:${++sequence}`,
          projectId: instance.projectId,
          instanceId: instance.id,
          sequence,
          stream,
          text,
          createdAt: now(),
        } satisfies EnvironmentLog);
        instance.outputBytes += Buffer.byteLength(text);
        this.save(instance);
      });
    };
    try {
      await verifyEnvironmentRecipe(this.store, recipe, candidate);
      if (
        !path.isAbsolute(instance.home) ||
        !path.isAbsolute(instance.cacheRoot) ||
        !instance.resourceId
      )
        throw new Error("Environment resources have not been allocated.");
      await mkdir(instance.home, { recursive: true, mode: 0o700 });
      await mkdir(instance.cacheRoot, { mode: 0o700 });
      if (signal.aborted)
        throw new Error("Preparation cancelled before dispatch.");
      instance.state = "preparing";
      this.save(instance);
      if (
        recipe.requiredHooks.some(
          (p) => !recipe.hooks.some((h) => h.packagePath === p),
        )
      ) {
        instance.failureKind = "policy";
        throw new Error(
          "Unreviewed dependency lifecycle hook denied. Approve an exact package/command exception in a new recipe.",
        );
      }
      const node =
        recipe.toolchains.find((t) => t.role === "node")?.executable ??
        recipe.toolchains[0].executable;
      const env = checkEnvironment(
        recipe.values,
        instance.home,
        node,
        resources,
      );
      const commands = [
        ...recipe.preparationProbes.map((p) => ({ ...p, packagePath: "." })),
        ...(recipe.preparation
          ? [{ ...recipe.preparation, packagePath: "." }]
          : []),
        ...recipe.hooks,
      ];
      for (const command of commands) {
        if (signal.aborted)
          throw new Error("Preparation cancelled before next command.");
        const cwd = path.resolve(instance.root, command.packagePath);
        if (!isWithin(await realpath(instance.root), await realpath(cwd)))
          throw new Error("Hook package directory escapes the execution tree.");
        if ("packageIdentity" in command && command.packagePath !== ".") {
          const locked = jsonCandidate(
            this.store,
            candidate,
            "package-lock.json",
          ).packages[command.packagePath];
          const installed = JSON.parse(
            await readFile(path.join(cwd, "package.json"), "utf8"),
          );
          if (
            hash(stable(locked)) !== command.packageIdentity ||
            installed.version !== locked.version ||
            (locked.name && installed.name !== locked.name)
          )
            throw new Error(
              "Reviewed hook package identity differs from the locked package.",
            );
        }
        const args = command.args.map((a) =>
          a === "{cache}" ? instance.cacheRoot : a,
        );
        log("system", `${command.executable} ${JSON.stringify(args)}\n`);
        instance.preparationCommandId = uid();
        instance.commandIndex++;
        instance.preparationLifecycle = null;
        this.store.transaction(() => {
          this.store.immutable("environment-dispatch-intent", {
            id: instance.preparationCommandId!,
            version: 1,
            projectId: instance.projectId,
            instanceId: instance.id,
            executionId: instance.executionId,
            index: instance.commandIndex,
            executable: command.executable,
            args,
            cwd,
            createdAt: now(),
          });
          this.save(instance);
        });
        const child = spawn(command.executable, args, {
          cwd,
          env,
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: "pipe",
        });
        child.stdin.end();
        let spawnError: Error | undefined;
        child.on("error", (error) => {
          spawnError = error;
        });
        let observationFailure: unknown,
          accepting = true,
          versionOutput = "";
        const lifecycle = new ProcessLifecycle(
          child,
          process.platform !== "win32",
          (e) => {
            if (!accepting) return;
            instance.preparationLifecycle = e;
            try {
              this.save(instance);
            } catch (error) {
              observationFailure = error;
              void lifecycle.stop();
            }
          },
        );
        instance.preparationLifecycle = lifecycle.snapshot();
        try {
          this.save(instance);
        } catch (error) {
          accepting = false;
          await lifecycle.stop();
          throw error;
        }
        for (const stream of ["stdout", "stderr"] as const) {
          let pending = "",
            dropping = false;
          child[stream].setEncoding("utf8");
          const record = (value: string) => {
            if (!accepting) return;
            if (stream === "stdout" && "role" in command)
              versionOutput += value.slice(0, 200);
            try {
              log(stream, value);
            } catch (error) {
              observationFailure = error;
              void lifecycle.stop();
            }
          };
          child[stream].on("data", (chunk) => {
            pending += String(chunk);
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, end + 1);
              pending = pending.slice(end + 1);
              if (!dropping)
                record(
                  Buffer.byteLength(line) <= 16000
                    ? line
                    : "[overlong preparation diagnostic omitted]\n",
                );
              dropping = false;
            }
            if (Buffer.byteLength(pending) > 16000) {
              pending = "";
              dropping = true;
              instance.truncated = true;
            }
          });
          child[stream].on("end", () => {
            if (dropping) record("[overlong preparation diagnostic omitted]\n");
            else if (pending) record(pending);
          });
        }
        const abort = () => {
          void lifecycle.stop();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        let timeout = false;
        const timer = setTimeout(() => {
          timeout = true;
          void lifecycle.stop();
        }, command.timeoutMs);
        instance.preparationLifecycle = await lifecycle.completion(
          command.timeoutMs + 6100,
        );
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        accepting = false;
        this.save(instance);
        this.store.put("environment-command-outcome", {
          id: instance.preparationCommandId!,
          projectId: instance.projectId,
          instanceId: instance.id,
          lifecycle: instance.preparationLifecycle,
          finishedAt: now(),
        });
        if (observationFailure) throw observationFailure;
        if (spawnError) throw spawnError;
        if (instance.preparationLifecycle.state !== "quiescent") {
          instance.state = "uncertain";
          throw new Error(instance.preparationLifecycle.detail);
        }
        if (signal.aborted) {
          instance.failureKind = "cancelled";
          throw new Error(
            "Preparation cancelled; lifecycle evidence retained.",
          );
        }
        if (timeout) {
          instance.failureKind = "timeout";
          throw new Error("Environment preparation timed out.");
        }
        if (instance.preparationLifecycle.exitCode !== 0)
          throw new Error(
            "Environment preparation command failed; candidate tests were not executed.",
          );
        if ("role" in command) {
          instance.observedToolVersions[command.role] = redact(
            versionOutput.trim().slice(0, 200),
          );
          this.save(instance);
        }
      }
      await assertExecutionIntegrity(
        this.store,
        candidate,
        instance.root,
        recipe,
      );
      instance.dependencyIdentity = await treeIdentity(
        path.join(instance.root, "node_modules"),
        signal,
      );
      instance.state = "ready";
      this.save(instance);
    } catch (error) {
      if (instance.state !== "uncertain")
        instance.state = signal.aborted ? "cancelled" : "failed";
      instance.failureKind ??= signal.aborted ? "cancelled" : "preparation";
      instance.error = safeError(error);
      try {
        log("system", `${instance.error}\n`);
        this.save(instance);
      } catch {}
      throw error;
    }
  }
  async verify(
    instance: EnvironmentInstance,
    recipe: EnvironmentRecipe,
    candidate: CandidateSnapshot,
  ) {
    if (instance.state !== "ready" || instance.recipeDigest !== recipe.digest)
      throw new Error("Environment is not ready for candidate verification.");
    await verifyEnvironmentRecipe(this.store, recipe, candidate);
    await assertExecutionIntegrity(
      this.store,
      candidate,
      instance.root,
      recipe,
    );
    if (
      instance.dependencyIdentity !==
      (await treeIdentity(path.join(instance.root, "node_modules")))
    ) {
      instance.failureKind = "integrity";
      instance.error = "Prepared dependency contents changed during execution.";
      this.save(instance);
      throw new Error(instance.error);
    }
  }
}
