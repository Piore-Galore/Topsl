import { spawn } from "node:child_process";

// Preserve Electron's startup diagnostics alongside assertion failures. Only
// the synthetic-profile acceptance harness is launched by this wrapper.
const child = spawn(process.execPath, ["scripts/desktop-test.mjs"], {
  env: { ...process.env, DEBUG: "pw:browser" },
  stdio: ["ignore", "inherit", "pipe"],
});
let diagnostics = "";
child.stderr.on("data", (bytes) => {
  process.stderr.write(bytes);
  diagnostics = (diagnostics + bytes.toString()).slice(-24000);
});
function report(detail) {
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = detail
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.error(
      `::error file=scripts/desktop-test.mjs,title=Desktop acceptance smoke::${escaped}`,
    );
  }
}
child.on("error", (error) => {
  report(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (code !== 0)
    report(
      diagnostics || "The desktop test process exited without diagnostics.",
    );
  process.exitCode = code ?? 1;
});
