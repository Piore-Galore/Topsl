// Diagnostic only: reproduce Topsl's Windows process-tree query exactly as
// packages/runtime/process-lifecycle.ts runs it, and report how it fails.
import { execFile } from "node:child_process";
import path from "node:path";

const executable = path.join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const original =
  "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
const nullSafe =
  "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; created=if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } } | ConvertTo-Json -Compress";
const nullDates =
  "Get-CimInstance Win32_Process | Where-Object { -not $_.CreationDate } | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.Name }";

// Same keys and PATH handling as nativeEnvironment() in packages/platform/system.ts.
const nativeKeys = ["PATH","HOME","USERPROFILE","USER","LOGNAME","SHELL","TMPDIR","TEMP","TMP","SystemRoot","SYSTEMROOT","WINDIR","COMSPEC","PATHEXT","APPDATA","LOCALAPPDATA","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_RUNTIME_DIR","LANG","LC_ALL","TERM","DISPLAY","WAYLAND_DISPLAY","SSH_AUTH_SOCK","CODEX_HOME","CLAUDE_CONFIG_DIR","HTTPS_PROXY","HTTP_PROXY","NO_PROXY"];
const native = {};
for (const key of nativeKeys) if (process.env[key]) native[key] = process.env[key];
console.log("native env keys:", Object.keys(native).join(","));

function run(label, script, timeout, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, shell: false, timeout, maxBuffer: 20_000_000, ...(env ? { env } : {}) },
      (error, stdout, stderr) => {
        const ms = Date.now() - started;
        let rows = "unparsed";
        try {
          const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, ""));
          rows = Array.isArray(parsed) ? parsed.length : 1;
        } catch {}
        console.log(
          JSON.stringify({
            label,
            timeout,
            ms,
            error: error
              ? { code: error.code, killed: error.killed, signal: error.signal }
              : null,
            stdoutChars: String(stdout).length,
            rows,
            stderr: String(stderr).slice(0, 800),
          }),
        );
        if (label === "null-creation-dates") console.log(String(stdout));
        resolve();
      },
    );
  });
}

const groups = {
  psmodule: ["PSModulePath"],
  programs: ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "SystemDrive", "ALLUSERSPROFILE", "PUBLIC"],
  identity: ["COMPUTERNAME", "USERNAME", "USERDOMAIN", "USERDNSDOMAIN", "LOGONSERVER"],
  processor: ["NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "OS"],
  home: ["HOMEDRIVE", "HOMEPATH"],
};
const withKeys = (keys) => {
  const env = { ...native };
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  return env;
};
await run("full-env-warmup", original, 60_000);
for (const [name, keys] of Object.entries(groups)) await run(`native+${name}`, original, 60_000, withKeys(keys));
await run("native+all", original, 60_000, withKeys(Object.values(groups).flat()));
await run("native+all#2", original, 60_000, withKeys(Object.values(groups).flat()));
await run("native-only", original, 60_000, native);
