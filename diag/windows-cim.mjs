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

for (let i = 1; i <= 3; i++) await run(`native-env#${i}`, original, 60_000, native);
for (let i = 1; i <= 3; i++) await run(`full-env#${i}`, original, 60_000);
await Promise.all([1, 2, 3, 4].map((i) => run(`native-env-parallel#${i}`, original, 60_000, native)));
await Promise.all([1, 2, 3, 4].map((i) => run(`full-env-parallel#${i}`, original, 60_000)));
for (let i = 1; i <= 2; i++) await run(`native-env-after#${i}`, original, 60_000, native);
