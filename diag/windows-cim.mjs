// Diagnostic only: does a descendant survive its Node parent's exit on Windows,
// and does Topsl's process query then find it? Mirrors the R2-AT-03 fixture in
// tests/durable-executions.test.ts and windowsDescendants in
// packages/runtime/process-lifecycle.ts.
import { execFile, spawn } from "node:child_process";
import path from "node:path";

const executable = path.join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const query =
  "$PSModuleAutoLoadingPreference = 'None'; Import-Module -Name ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility'), ($PSHOME + '\\Modules\\CimCmdlets') -ErrorAction Stop; " +
  "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";

function processes() {
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query],
      { windowsHide: true, timeout: 60_000, maxBuffer: 20_000_000 },
      (error, stdout) =>
        error
          ? reject(error)
          : resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, ""))),
    ),
  );
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function scenario(label, detachedChild) {
  const childProgram = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore',env:process.env,detached:${detachedChild}});console.log(c.pid);c.unref();`;
  const startedAt = new Date().toISOString();
  const parent = spawn(process.execPath, ["-e", childProgram], {
    stdio: "pipe",
  });
  const closed = new Promise((resolve) => parent.once("close", resolve));
  const descendant = await new Promise((resolve) =>
    parent.stdout.once("data", (bytes) =>
      resolve(Number(bytes.toString().trim())),
    ),
  );
  await closed;
  const aliveAtClose = alive(descendant);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const rows = await processes();
  const row = rows.find((r) => r.pid === descendant) ?? null;
  console.log(
    JSON.stringify({
      label,
      node: process.version,
      parent: parent.pid,
      descendant,
      aliveAtClose,
      aliveAfter500ms: alive(descendant),
      cimRow: row,
      cimParentMatches: row ? row.parent === parent.pid : null,
      createdInWindow: row
        ? Date.parse(row.created) >= Date.parse(startedAt) - 2_000
        : null,
    }),
  );
  try {
    process.kill(descendant, "SIGKILL");
  } catch {}
}

await scenario("child not detached (current R2-AT-03 fixture)", false);
await scenario("child detached (proposed Windows fixture)", true);
