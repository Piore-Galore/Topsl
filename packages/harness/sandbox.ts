/**
 * Topsl's macOS containment for model-requested processes.
 *
 * Every contained command (checks, builds, shell commands, hooks, local MCP
 * servers, extension helpers) runs through the `srt` command-line program of
 * `@anthropic-ai/sandbox-runtime` as a separate helper process with its own
 * settings file. The library's `SandboxManager` is a process-global singleton
 * whose configuration, proxy and violation store are shared by everything in
 * one process, so Topsl never calls it in its own process: one helper process
 * holds exactly one policy, and concurrent commands cannot see or change each
 * other's rules.
 *
 * The process tree of one contained command is:
 *
 *   srt (Electron or Node, detached: its own process group)
 *     /bin/sh -c "env <proxy vars> /usr/bin/sandbox-exec -p <profile> bash -c …"
 *       bash (inside the Seatbelt sandbox)
 *         /usr/bin/env -u … <minimal environment> /bin/sh -c <wrapper> …
 *           the requested argv
 *
 * Everything below srt inherits the Seatbelt profile, so shell descendants are
 * contained too. srt only ever runs the command through sandbox-exec with the
 * settings Topsl wrote; if the settings cannot be read or validated, or the
 * sandbox cannot be set up, srt exits without running the command. On any
 * platform other than macOS this module refuses to run anything.
 */
import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ContainmentPolicy {
  /** The Topsl-owned workspace copy the command may read and (when writable) write. */
  workspaceRoot: string;
  writable: boolean;
  /** Task-local temporary directory; always writable; used as HOME and TMPDIR. Created if missing. */
  tempRoot: string;
  /**
   * Extra readable paths (toolchains), for locations under the home or a
   * shared temp directory, which are otherwise unreadable. A `bin` entry, or
   * an entry's `bin` subdirectory, is put on PATH ahead of the system PATH.
   */
  extraReadable?: string[];
  /**
   * Paths that must never be readable, even inside a readable root (a more
   * specific deny beats a broader allow in sandbox-runtime).
   */
  denyRead?: string[];
  /** Network destinations granted to this command (sandbox-runtime domain grammar). Empty = no network. */
  allowedDomains: string[];
  /** Extra environment variables the task was granted (never credentials). */
  env?: Record<string, string>;
}

export interface ContainmentStatus {
  available: boolean;
  mechanism: "macos-seatbelt" | null;
  runtimeVersion: string;
  reason: string | null;
}

export interface ContainedResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  /**
   * Stderr lines that look like sandbox denials: EPERM ("Operation not
   * permitted") and the network proxy's refusals. srt does not report
   * Seatbelt violations itself (its kernel-log monitor is off in the CLI), so
   * this is a heuristic: it can include an unrelated EPERM, and a command that
   * swallows its errors reports none.
   */
  violations: string[];
  /**
   * Whether the requested argv began running inside the sandbox. False means
   * srt or sandbox-exec refused to start it (invalid settings, a profile that
   * did not compile, a cancelled start), so the exit status is srt's own and
   * says nothing about the command. Added beyond the agreed interface so a
   * caller can report "containment failed" instead of "the check failed".
   */
  started: boolean;
}

/** The sandbox-runtime release this module's settings and behavior were qualified against. */
export const QUALIFIED_RUNTIME_VERSION = "0.0.81";

/** Default bound for each captured output stream. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** How long a terminated process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 1000;

/** How long to wait for output pipes to close after the helper exits. */
const CLOSE_GRACE_MS = 500;

/** The longest Unix socket path macOS accepts (sun_path is 104 bytes with NUL). */
const MAX_SOCKET_PATH = 103;

/** "/topsl-srt-XXXXXX" plus srt's "/srt-mux-<pid>-<n>.sock" with a 7-digit pid. */
const CONTROL_PATH_OVERHEAD =
  "/topsl-srt-XXXXXX".length + "/srt-mux-9999999-99.sock".length;

/** The system PATH every contained command starts from. */
export const SYSTEM_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** The PATH srt itself runs with; it only needs to find bash and env. */
const HELPER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Credential stores under the home directory that stay unreadable even when
 * `extraReadable` re-opens part of the home directory. sandbox-runtime keeps a
 * `denyRead` entry denied when it is more specific than the `allowRead` region
 * it falls inside, so these hold against a broad toolchain grant.
 */
export const SECRET_HOME_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".netrc",
  ".config/gcloud",
  ".kube",
  ".docker",
  "Library/Keychains",
  ".codex",
  ".claude",
];

/**
 * sandbox-runtime always makes `/tmp/claude` writable (it is the TMPDIR srt
 * hands out by default). It is shared by every srt user on the machine,
 * Claude Code included, so Topsl denies it: commands get their task-local
 * tempRoot as TMPDIR instead. Both spellings are listed because srt only
 * resolves `/tmp` to `/private/tmp` for paths that already exist.
 */
const SHARED_RUNTIME_WRITE_PATHS = ["/tmp/claude", "/private/tmp/claude"];

/**
 * Variables sandbox-runtime 0.0.81 adds inside the sandbox for its network
 * proxy, JVM proxy agent and violation attribution. They are srt's own
 * plumbing (the proxy credential in them is a per-run token for that run's
 * proxy only), not anything inherited from Topsl. A task may not set them,
 * because overriding one would silently break the granted network path.
 */
export const RUNTIME_ADDED_VARIABLES = [
  "SANDBOX_RUNTIME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "FTP_PROXY",
  "ftp_proxy",
  "GRPC_PROXY",
  "grpc_proxy",
  "RSYNC_PROXY",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "CLOUDSDK_PROXY_TYPE",
  "CLOUDSDK_PROXY_ADDRESS",
  "CLOUDSDK_PROXY_PORT",
  "CLOUDSDK_PROXY_USERNAME",
  "CLOUDSDK_PROXY_PASSWORD",
  "GIT_SSH_COMMAND",
  "SRT_SSH_PROXY_COMMAND",
  "GIT_CONFIG_PARAMETERS",
  "JAVA_TOOL_OPTIONS",
];

/** Variables the shells in the chain maintain themselves. */
export const SHELL_MAINTAINED_VARIABLES = ["PWD", "OLDPWD", "SHLVL", "_"];

/** Names that look like credentials; a task granting one is refused. */
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

/** Names Topsl sets itself and a task may not override. */
const RESERVED_NAMES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  ...RUNTIME_ADDED_VARIABLES,
]);

/**
 * The wrapper prints this on stderr inside the sandbox before it runs the
 * argv, so Topsl can tell a command that ran from one srt refused to start.
 * It is removed from the captured stderr.
 */
const START_MARKER = "\u001etopsl-contained-start\n";

/** A policy Topsl refuses to contain a command under. */
export class ContainmentPolicyError extends Error {
  override name = "ContainmentPolicyError";
}

/** Containment is not available here, so nothing may run. */
export class ContainmentUnavailableError extends Error {
  override name = "ContainmentUnavailableError";
}

/**
 * Host facts this module depends on, gathered in one object so tests can
 * substitute them (`vi.spyOn(containmentHost, "platform")`). Internal: not
 * part of the harness API.
 */
export const containmentHost = {
  platform(): NodeJS.Platform {
    return process.platform;
  },
  /**
   * Where each run's private control directory (settings file and srt's own
   * proxy socket) is created. It must be outside every workspace and tempRoot
   * so the sandboxed command can neither write nor (being under the denied
   * per-user temp directory) read it. srt puts its proxy socket in this
   * directory and macOS limits Unix socket paths to 104 bytes, so a long
   * TMPDIR falls back to /private/tmp (mkdtemp keeps the directory private).
   */
  controlRoot(): string {
    const base = canonical(os.tmpdir());
    return base.length + CONTROL_PATH_OVERHEAD <= MAX_SOCKET_PATH
      ? base
      : "/private/tmp";
  },
};

interface SandboxRuntimeInstall {
  cliPath: string;
  version: string;
}

/**
 * Finds the installed sandbox-runtime. `require` exists both in Topsl's
 * esbuild CommonJS bundles and under vitest; in a context without it the
 * runtime is reported missing rather than guessed from the working directory,
 * because a wrong guess could run a different program as "the sandbox".
 */
function sandboxRuntimeInstall(): SandboxRuntimeInstall | string {
  if (typeof require !== "function" || typeof require.resolve !== "function")
    return "sandbox-runtime cannot be located from this module context";
  try {
    const manifestPath =
      require.resolve("@anthropic-ai/sandbox-runtime/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      version?: unknown;
    };
    const bundled = path.join(path.dirname(manifestPath), "dist", "cli.js");
    // In a packaged app the runtime is unpacked beside app.asar (package.json
    // asarUnpack), so srt and its dependencies load from real files.
    const unpacked = bundled.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    const cliPath =
      unpacked !== bundled && fs.existsSync(unpacked) ? unpacked : bundled;
    if (!fs.existsSync(cliPath))
      return `sandbox-runtime's srt program is missing at ${cliPath}`;
    return {
      cliPath,
      version: typeof manifest.version === "string" ? manifest.version : "",
    };
  } catch (error) {
    return `sandbox-runtime is not installed (${(error as Error).message})`;
  }
}

function unavailable(reason: string, runtimeVersion = ""): ContainmentStatus {
  return { available: false, mechanism: null, runtimeVersion, reason };
}

/**
 * Whether Topsl can contain processes on this machine. Only macOS Seatbelt
 * (`sandbox-exec`) is qualified, and only with the pinned sandbox-runtime
 * release: a different release may interpret the same settings differently,
 * so it must be requalified before it counts as containment.
 */
export async function containmentStatus(): Promise<ContainmentStatus> {
  const platform = containmentHost.platform();
  const install = sandboxRuntimeInstall();
  const version = typeof install === "string" ? "" : install.version;
  if (platform !== "darwin")
    return unavailable(
      `Containment is qualified only on macOS (sandbox-exec); this host is ${platform}.`,
      version,
    );
  try {
    await access(SANDBOX_EXEC, fs.constants.X_OK);
  } catch {
    return unavailable(
      `${SANDBOX_EXEC} is missing or not executable.`,
      version,
    );
  }
  if (typeof install === "string") return unavailable(install);
  if (install.version !== QUALIFIED_RUNTIME_VERSION)
    return unavailable(
      `sandbox-runtime ${install.version || "(unknown version)"} is installed; Topsl's containment is qualified with ${QUALIFIED_RUNTIME_VERSION}.`,
      install.version,
    );
  return {
    available: true,
    mechanism: "macos-seatbelt",
    runtimeVersion: install.version,
    reason: null,
  };
}

/** True when `target` is `root` or lies beneath it, by path segment. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * The real path of `p`, resolving symlinks in the part that exists. On macOS
 * `/var` and `/tmp` are symlinks into `/private`, and Seatbelt matches real
 * vnode paths, so a rule spelled `/var/folders/…` would match nothing. A path
 * that does not exist yet keeps its missing tail under the real path of its
 * nearest existing ancestor.
 */
function canonical(p: string): string {
  const absolute = path.resolve(p);
  let existing = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Paths are written as plain strings unless they contain glob characters, in
 * which case they are marked literal so a directory named `[WIP] app` is never
 * read as a pattern.
 */
function pathEntry(p: string): string | { path: string; literal: true } {
  return /[*?[\]]/.test(p) ? { path: p, literal: true } : p;
}

function absoluteList(name: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ContainmentPolicyError(`${name} must be an array of paths.`);
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !path.isAbsolute(entry) ||
      entry.includes("\0")
    )
      throw new ContainmentPolicyError(
        `${name} entries must be absolute paths.`,
      );
    return canonical(entry);
  });
}

interface ResolvedPolicy {
  workspaceRoot: string;
  tempRoot: string;
  writable: boolean;
  extraReadable: string[];
  denyRead: string[];
  allowedDomains: string[];
  env: Record<string, string>;
  home: string;
  userTemp: string;
}

/**
 * Validates a policy and resolves every path to its real spelling. Every
 * public entry point goes through here, so an invalid policy never produces a
 * settings document or a process.
 */
function resolvePolicy(policy: ContainmentPolicy): ResolvedPolicy {
  if (!policy || typeof policy !== "object")
    throw new ContainmentPolicyError("A containment policy is required.");
  for (const key of ["workspaceRoot", "tempRoot"] as const) {
    const value = policy[key];
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      value.includes("\0")
    )
      throw new ContainmentPolicyError(`${key} must be an absolute path.`);
  }
  if (typeof policy.writable !== "boolean")
    throw new ContainmentPolicyError("writable must be true or false.");
  const workspaceRoot = canonical(policy.workspaceRoot);
  const tempRoot = canonical(policy.tempRoot);
  const extraReadable = absoluteList("extraReadable", policy.extraReadable);
  const denyRead = absoluteList("denyRead", policy.denyRead);
  const home = canonical(os.homedir());
  const userTemp = canonical(os.tmpdir());
  const secrets = SECRET_HOME_PATHS.map((rel) => path.join(home, rel));

  for (const [name, root] of [
    ["workspaceRoot", workspaceRoot],
    ["tempRoot", tempRoot],
  ] as const) {
    if (isWithin(root, home))
      throw new ContainmentPolicyError(
        `${name} must not be the home directory or one of its ancestors.`,
      );
    if (secrets.some((secret) => isWithin(secret, root)))
      throw new ContainmentPolicyError(
        `${name} must not lie inside a protected credential location.`,
      );
    if (SHARED_RUNTIME_WRITE_PATHS.some((shared) => isWithin(shared, root)))
      throw new ContainmentPolicyError(
        `${name} must not lie inside sandbox-runtime's shared /tmp/claude.`,
      );
  }
  // Overlapping roots would let the always-writable tempRoot write a read-only
  // workspace (or make HOME part of the candidate's files).
  if (isWithin(workspaceRoot, tempRoot) || isWithin(tempRoot, workspaceRoot))
    throw new ContainmentPolicyError(
      "workspaceRoot and tempRoot must be separate directories.",
    );
  // allowRead wins over a less specific denyRead, so a readable path inside a
  // denied one would quietly re-open it. Refuse the contradiction instead.
  for (const readable of extraReadable)
    if ([...secrets, ...denyRead].some((denied) => isWithin(denied, readable)))
      throw new ContainmentPolicyError(
        `extraReadable ${readable} lies inside a denied location.`,
      );

  if (!Array.isArray(policy.allowedDomains))
    throw new ContainmentPolicyError("allowedDomains must be an array.");
  // sandbox-runtime validates the full grammar and refuses the settings file
  // (so nothing runs) if an entry is wrong; this only catches URLs and other
  // obvious mistakes early with a clearer message.
  for (const domain of policy.allowedDomains)
    if (
      typeof domain !== "string" ||
      domain.length === 0 ||
      /[\s/\0]/.test(domain) ||
      domain.includes("://")
    )
      throw new ContainmentPolicyError(
        `Network destination ${JSON.stringify(domain)} is not a domain pattern.`,
      );

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(policy.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new ContainmentPolicyError(
        `Environment variable name ${JSON.stringify(name)} is invalid.`,
      );
    if (CREDENTIAL_NAME.test(name))
      throw new ContainmentPolicyError(
        `Environment variable ${name} looks like a credential; contained processes never receive credentials.`,
      );
    if (RESERVED_NAMES.has(name))
      throw new ContainmentPolicyError(
        `Environment variable ${name} is set by Topsl or the sandbox and cannot be granted.`,
      );
    if (typeof value !== "string" || value.includes("\0"))
      throw new ContainmentPolicyError(
        `Environment variable ${name} must be a string without NUL bytes.`,
      );
    env[name] = value;
  }

  return {
    workspaceRoot,
    tempRoot,
    writable: policy.writable,
    extraReadable,
    denyRead,
    allowedDomains: [...policy.allowedDomains],
    env,
    home,
    userTemp,
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function settingsFor(resolved: ResolvedPolicy): Record<string, unknown> {
  const secrets = SECRET_HOME_PATHS.map((rel) => path.join(resolved.home, rel));
  // The per-user temp directory and /private/tmp hold other tasks' workspace
  // copies and temp files (and other applications' scratch data). They are
  // denied for reading like the home directory, with the policy's own roots
  // re-allowed; an unusual TMPDIR that contains the home directory is left to
  // the home deny.
  const sharedTemps = [resolved.userTemp, "/private/tmp"].filter(
    (dir) => dir !== "/" && !isWithin(dir, resolved.home),
  );
  return {
    network: {
      allowedDomains: resolved.allowedDomains,
      deniedDomains: [],
      // There is no ask callback in the CLI; strict makes the allowlist the
      // whole policy rather than a prompt-suppression hint.
      strictAllowlist: true,
      allowLocalBinding: false,
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead: unique([
        resolved.home,
        ...sharedTemps,
        ...secrets,
        ...resolved.denyRead,
      ]).map(pathEntry),
      allowRead: unique([
        resolved.workspaceRoot,
        resolved.tempRoot,
        ...resolved.extraReadable,
      ]).map(pathEntry),
      allowWrite: (resolved.writable
        ? [resolved.workspaceRoot, resolved.tempRoot]
        : [resolved.tempRoot]
      ).map(pathEntry),
      denyWrite: SHARED_RUNTIME_WRITE_PATHS,
      allowGitConfig: false,
    },
    allowPty: false,
    allowAppleEvents: false,
    enableWeakerNetworkIsolation: false,
  };
}

/** The exact settings document a policy produces (exported for tests and evidence). */
export function sandboxSettings(
  policy: ContainmentPolicy,
): Record<string, unknown> {
  return settingsFor(resolvePolicy(policy));
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Toolchain directories granted through `extraReadable`, in the order given:
 * an entry named `bin`, or an entry's `bin` subdirectory. They come before the
 * system PATH so a toolchain the task was granted wins over a system copy
 * (for example the Command Line Tools' git over the /usr/bin xcrun shim).
 */
function toolchainPath(extraReadable: string[]): string[] {
  const dirs: string[] = [];
  for (const entry of extraReadable) {
    if (path.basename(entry) === "bin" && isDirectory(entry)) dirs.push(entry);
    else if (isDirectory(path.join(entry, "bin")))
      dirs.push(path.join(entry, "bin"));
  }
  return unique(dirs);
}

function environmentFor(resolved: ResolvedPolicy): Record<string, string> {
  return {
    PATH: [...toolchainPath(resolved.extraReadable), SYSTEM_PATH].join(":"),
    HOME: resolved.tempRoot,
    TMPDIR: resolved.tempRoot,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
    ...resolved.env,
  };
}

/**
 * The environment a contained command starts with, before sandbox-runtime
 * adds its proxy variables (RUNTIME_ADDED_VARIABLES). Nothing comes from
 * Topsl's own environment.
 */
export function minimalEnvironment(
  policy: ContainmentPolicy,
): Record<string, string> {
  return environmentFor(resolvePolicy(policy));
}

function validateArgv(argv: unknown): asserts argv is string[] {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    argv[0] === ""
  )
    throw new ContainmentPolicyError(
      "argv must be a non-empty list of strings without NUL bytes.",
    );
}

interface PreparedRun {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cleanup: () => Promise<void>;
}

/**
 * Everything up to the spawn: refuse when containment is unavailable, validate
 * the policy and cwd, write the settings file into a fresh private directory,
 * and build the helper's argv and environment.
 */
async function prepareRun(
  argv: string[],
  cwd: string,
  policy: ContainmentPolicy,
  announceStart: boolean,
): Promise<PreparedRun> {
  const status = await containmentStatus();
  if (!status.available)
    throw new ContainmentUnavailableError(
      `Containment is unavailable, so the command was not run: ${status.reason}`,
    );
  const install = sandboxRuntimeInstall();
  if (typeof install === "string")
    throw new ContainmentUnavailableError(install);
  validateArgv(argv);
  // Validate everything that does not need the disk before creating tempRoot.
  resolvePolicy(policy);
  await mkdir(policy.tempRoot, { recursive: true, mode: 0o700 });
  const resolved = resolvePolicy(policy);
  if (!isDirectory(resolved.workspaceRoot))
    throw new ContainmentPolicyError(
      "workspaceRoot must be an existing directory.",
    );
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    throw new ContainmentPolicyError("cwd must be an absolute path.");
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    throw new ContainmentPolicyError(`cwd ${cwd} does not exist.`);
  }
  if (!isWithin(resolved.workspaceRoot, realCwd))
    throw new ContainmentPolicyError(
      `cwd ${cwd} resolves outside the workspace (${realCwd}).`,
    );
  if (!isDirectory(realCwd))
    throw new ContainmentPolicyError(`cwd ${cwd} is not a directory.`);

  const settings = settingsFor(resolved);
  const environment = environmentFor(resolved);

  // The control directory is a fresh subdirectory of controlRoot, so it is
  // inside a root exactly when controlRoot is.
  const controlRoot = canonical(containmentHost.controlRoot());
  if (
    [resolved.workspaceRoot, resolved.tempRoot].some((root) =>
      isWithin(root, controlRoot),
    )
  )
    throw new ContainmentPolicyError(
      "The settings directory would be inside a root the command can write.",
    );
  if (controlRoot.length + CONTROL_PATH_OVERHEAD > MAX_SOCKET_PATH)
    throw new ContainmentPolicyError(
      `The settings directory ${controlRoot} is too long for srt's proxy socket path.`,
    );
  const controlDir = await mkdtemp(path.join(controlRoot, "topsl-srt-"));
  const cleanup = async () => {
    await rm(controlDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await fs.promises.chmod(controlDir, 0o700);
    const settingsFile = path.join(controlDir, "settings.json");
    await writeFile(settingsFile, JSON.stringify(settings, null, 2), {
      mode: 0o600,
      flag: "wx",
    });

    // Inside the sandbox: drop the two variables the helper process itself
    // carries (Electron's node switch and CoreFoundation's text encoding),
    // set the task's environment, then change into the requested cwd. The
    // wrapper does not exec the argv: it waits and exits with its status, so
    // a command killed by a signal reports 128+N instead of srt's 0 (srt maps
    // a child that died of SIGTERM or SIGINT to exit code 0).
    const wrapper = `${announceStart ? `printf '\\036topsl-contained-start\\n' >&2; ` : ""}cd -- "$1" || exit 125; shift; "$@"; exit $?`;
    const inner = [
      "/usr/bin/env",
      "-u",
      "ELECTRON_RUN_AS_NODE",
      "-u",
      "__CF_USER_TEXT_ENCODING",
      ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
      "/bin/sh",
      "-c",
      wrapper,
      "topsl-contained",
      realCwd,
      ...argv,
    ];

    // srt is started through `-e` so its argument parser (commander) sees
    // the arguments in "eval" layout. Run as `Electron cli.js …`, commander
    // detects Electron, assumes a packaged app and takes cli.js itself as the
    // command to run.
    const launcher = `import(${JSON.stringify(pathToFileURL(install.cliPath).href)}).catch((error) => { console.error("srt failed to load:", error); process.exit(1); });`;
    const args = [
      "-e",
      launcher,
      "--",
      "--settings",
      settingsFile,
      "--",
      ...inner,
    ];

    // srt's own environment. srt passes its environment through to the
    // sandboxed command, so it gets nothing of Topsl's. HOME is the tempRoot
    // so srt's built-in home write conveniences (~/.npm/_logs,
    // ~/.claude/debug) land inside the task's own temp directory; TMPDIR is
    // the private control directory, where srt puts its proxy socket.
    const env: Record<string, string> = {
      PATH: HELPER_PATH,
      HOME: resolved.tempRoot,
      TMPDIR: controlDir,
      LANG: "en_US.UTF-8",
    };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";

    // srt's working directory is the workspace root, not the command's cwd:
    // its built-in write protections (.git/hooks, .git/config, shell rc
    // files, .vscode, .idea, .mcp.json, …) are anchored at its cwd, so this
    // keeps them over the whole workspace copy when the command runs in a
    // subdirectory.
    return {
      command: process.execPath,
      args,
      env,
      cwd: resolved.workspaceRoot,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Sends a signal to a process group; a group that is already gone is fine. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
}

/**
 * Live descendants of `root`, from a fresh process table. A command can leave
 * its process group with setsid(); while its parent chain is alive this still
 * finds it. A descendant that both left the group and lost its parents
 * (a double-forked daemon) is reparented to launchd and cannot be found:
 * macOS has no cgroup-like container to enumerate.
 */
async function descendants(root: number): Promise<number[]> {
  const table = await new Promise<string>((resolve) => {
    execFile("/bin/ps", ["-A", "-o", "pid=,ppid="], (error, stdout) =>
      resolve(error ? "" : stdout),
    );
  });
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const next = children.get(queue.shift()!) ?? [];
    for (const pid of next) {
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

/** Signals the helper's process group and every descendant still attached. */
async function signalTree(pgid: number, signal: NodeJS.Signals): Promise<void> {
  const pids = await descendants(pgid);
  signalGroup(pgid, signal);
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/** Collects at most `limit` bytes of a stream and remembers whether it was cut. */
class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      if (chunk.length > 0) this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.limit;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const VIOLATION_LINE =
  /Operation not permitted|blocked-by-allowlist|blocked-by-sandbox-runtime|not on the allow list|CONNECT tunnel failed, response 403|^sandbox-exec: /;

function violationLines(stderr: string): string[] {
  return unique(
    stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => VIOLATION_LINE.test(line))
      .map((line) => line.slice(0, 500)),
  ).slice(0, 50);
}

function positiveInteger(name: string, value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  )
    throw new ContainmentPolicyError(
      `${name} must be a positive integer no larger than ${max}.`,
    );
  return value;
}

/**
 * Runs one command under its own policy and returns its bounded output.
 *
 * The helper is spawned detached, so the command and all its descendants share
 * one new process group. Timeout and cancellation send SIGTERM to that group
 * (and to any descendant that left it but is still attached), then SIGKILL
 * after a short grace. When the command finishes, whatever it left running in
 * the group is killed too: a contained command never outlives its result.
 */
export async function runContained(
  argv: string[],
  options: {
    cwd: string;
    policy: ContainmentPolicy;
    timeoutMs: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    stdin?: string;
    onSpawn?: (pid: number) => void;
  },
): Promise<ContainedResult> {
  const timeoutMs = positiveInteger(
    "timeoutMs",
    options.timeoutMs,
    2 ** 31 - 1,
  );
  const maxOutputBytes = positiveInteger(
    "maxOutputBytes",
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    2 ** 30,
  );
  const prepared = await prepareRun(argv, options.cwd, options.policy, true);
  if (options.signal?.aborted) {
    await prepared.cleanup();
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: true,
      durationMs: 0,
      violations: [],
      started: false,
    };
  }

  const started = Date.now();
  const child: ChildProcess = spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    detached: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout = new BoundedOutput(maxOutputBytes);
  // Room for the start marker, which is removed again below.
  const stderr = new BoundedOutput(maxOutputBytes + START_MARKER.length);
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => {
      // EPIPE when the command does not read its input; not an error here.
    });
    child.stdin.end(options.stdin);
  }

  let timedOut = false;
  let cancelled = false;
  let terminating = false;
  let killTimer: NodeJS.Timeout | undefined;
  const pid = child.pid;
  const terminate = () => {
    if (terminating || pid === undefined) return;
    terminating = true;
    void signalTree(pid, "SIGTERM");
    killTimer = setTimeout(
      () => void signalTree(pid, "SIGKILL"),
      KILL_GRACE_MS,
    );
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const onAbort = () => {
    cancelled = true;
    terminate();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let callbackError: unknown;
  if (pid !== undefined && options.onSpawn) {
    try {
      options.onSpawn(pid);
    } catch (error) {
      callbackError = error;
      terminate();
    }
  }

  try {
    const outcome = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve, reject) => {
      let exited: { code: number | null; signal: string | null } | undefined;
      let closeTimer: NodeJS.Timeout | undefined;
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        exited = { code, signal };
        // The command is done; nothing it started may keep running.
        if (pid !== undefined) signalGroup(pid, "SIGKILL");
        // A descendant that escaped the group may still hold the pipes.
        closeTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve(exited!);
        }, CLOSE_GRACE_MS);
      });
      child.once("close", (code, signal) => {
        if (closeTimer) clearTimeout(closeTimer);
        resolve(exited ?? { code, signal });
      });
    });
    if (callbackError !== undefined) throw callbackError;

    let stderrText = stderr.text();
    const markerAt = stderrText.indexOf(START_MARKER);
    const commandStarted = markerAt !== -1;
    if (commandStarted)
      stderrText =
        stderrText.slice(0, markerAt) +
        stderrText.slice(markerAt + START_MARKER.length);
    let stderrTruncated = stderr.truncated;
    if (Buffer.byteLength(stderrText) > maxOutputBytes) {
      stderrText = Buffer.from(stderrText)
        .subarray(0, maxOutputBytes)
        .toString("utf8");
      stderrTruncated = true;
    }
    return {
      exitCode: outcome.code,
      signal: outcome.signal,
      stdout: stdout.text(),
      stderr: stderrText,
      stdoutTruncated: stdout.truncated,
      stderrTruncated,
      timedOut,
      cancelled,
      durationMs: Date.now() - started,
      violations: violationLines(stderrText),
      started: commandStarted,
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);
    await prepared.cleanup();
  }
}

/**
 * A long-lived contained process with piped stdio (for MCP servers); same
 * policy rules as runContained.
 *
 * The process runs in its own process group. `kill()` on the returned child
 * signals the whole group (default SIGTERM), and when the helper exits the
 * rest of its group is killed and the settings directory removed. The caller
 * owns the lifetime: there is no timeout.
 */
export async function spawnContained(
  argv: string[],
  options: { cwd: string; policy: ContainmentPolicy },
): Promise<ChildProcessWithoutNullStreams> {
  const prepared = await prepareRun(argv, options.cwd, options.policy, false);
  const child = spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    detached: true,
    stdio: "pipe",
  });
  const cleanedUp = { done: false };
  const cleanup = () => {
    if (cleanedUp.done) return;
    cleanedUp.done = true;
    void prepared.cleanup();
  };
  child.once("error", cleanup);
  try {
    await once(child, "spawn");
  } catch (error) {
    cleanup();
    throw error;
  }
  const pid = child.pid!;
  const killProcess = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (child.exitCode !== null || child.signalCode !== null)
      return killProcess(signal);
    try {
      process.kill(-pid, signal ?? "SIGTERM");
      return true;
    } catch {
      return killProcess(signal);
    }
  };
  child.once("exit", () => {
    signalGroup(pid, "SIGKILL");
    cleanup();
  });
  return child;
}
