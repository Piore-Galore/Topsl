import { execFile } from "node:child_process";
import { access, realpath, stat, readFile, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { hash } from "../domain/invariants";
export const localHost = `${os.platform()}:${os.hostname()}`;
export function nativeEnvironment(
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SSH_AUTH_SOCK",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[key]) result[key] = process.env[key]!;
  }
  result.PATH = [
    ...new Set([
      ...(result.PATH ?? "").split(path.delimiter),
      ...platformBins(),
    ]),
  ]
    .filter((p) => path.isAbsolute(p))
    .join(path.delimiter);
  return { ...result, ...extra };
}
export function billingConflicts(): string[] {
  return Object.keys(process.env).filter(
    (k) =>
      /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_BASE_URL|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/.test(
        k,
      ) && process.env[k],
  );
}
export function platformBins(): string[] {
  return process.platform === "win32"
    ? [
        path.join(os.homedir(), ".local", "bin"),
        path.join(process.env.APPDATA ?? os.homedir(), "npm"),
      ]
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        path.join(os.homedir(), ".local", "bin"),
      ];
}
export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
export async function identity(
  p: string,
): Promise<{ realPath: string; identity: string }> {
  const r = await realpath(p),
    s = await stat(r);
  const digest = createHash("sha256");
  digest.update(JSON.stringify([r, s.dev, s.ino, s.size, s.mtimeMs]));
  if (s.isFile()) {
    for await (const chunk of createReadStream(r)) digest.update(chunk);
  } else if (r.endsWith(".app")) {
    digest.update(await readFile(path.join(r, "Contents", "Info.plist")));
    const binaries = path.join(r, "Contents", "MacOS");
    for (const name of (await readdir(binaries)).sort()) {
      const file = path.join(binaries, name);
      if ((await stat(file)).isFile()) {
        digest.update(name);
        for await (const chunk of createReadStream(file)) digest.update(chunk);
      }
    }
  }
  return { realPath: r, identity: digest.digest("hex") };
}
export function runFile(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      args,
      {
        cwd: options.cwd ?? os.homedir(),
        timeout: options.timeout ?? 15000,
        maxBuffer: 2_000_000,
        windowsHide: true,
        env: options.env ?? nativeEnvironment(),
        encoding: "utf8",
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${path.basename(executable)} failed: ${String(stderr).slice(0, 600) || error.message}`,
            ),
          );
        else resolve(String(stdout));
      },
    ),
  );
}
export async function candidatePaths(name: string): Promise<string[]> {
  const bins = [...new Set(nativeEnvironment().PATH.split(path.delimiter))];
  const names =
    process.platform === "win32"
      ? [`${name}.exe`, `${name}.cmd`, name]
      : [name];
  const paths: string[] = [];
  for (const bin of bins)
    for (const file of names) {
      const p = path.join(bin, file);
      if (await exists(p)) paths.push(p);
    }
  return paths;
}
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export async function projectPath(
  root: string,
  relative: string,
): Promise<string> {
  const target = path.resolve(root, relative);
  if (!isWithin(root, target))
    throw new Error("Path escapes approved project.");
  if (await exists(target)) {
    if (!isWithin(root, await realpath(target)))
      throw new Error("Symlink escapes approved project.");
  } else if (!isWithin(root, await realpath(path.dirname(target))))
    throw new Error("Parent escapes approved project.");
  return target;
}
export async function readBounded(
  file: string,
  limit = 1_000_000,
): Promise<string> {
  const s = await stat(file);
  if (!s.isFile() || s.size > limit)
    throw new Error("File is not a supported size or type.");
  return readFile(file, "utf8");
}
export async function affectedProcesses(
  paths: string[],
): Promise<number[] | null> {
  try {
    const found: number[] = [];
    if (process.platform === "win32") {
      const raw = await runFile(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
        ],
      );
      const decoded = JSON.parse(raw);
      for (const p of Array.isArray(decoded) ? decoded : [decoded])
        if (
          p?.ExecutablePath &&
          paths.some(
            (x) =>
              String(p.ExecutablePath).toLowerCase() === x.toLowerCase() ||
              String(p.ExecutablePath)
                .toLowerCase()
                .startsWith(x.toLowerCase() + path.sep),
          )
        )
          found.push(p.ProcessId);
    } else {
      const raw = await runFile("/bin/ps", ["-axo", "pid=,comm="]);
      for (const line of raw.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (
          match &&
          paths.some((x) => match[2] === x || match[2].startsWith(x + path.sep))
        )
          found.push(Number(match[1]));
      }
    }
    return found.filter((id) => id !== process.pid);
  } catch {
    return null;
  }
}
