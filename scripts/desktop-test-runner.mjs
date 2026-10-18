import { spawn } from "node:child_process";

// Preserve Electron's startup diagnostics alongside assertion failures. The
// wrapper launches the synthetic-profile acceptance harness, then the
// coordinator journey, each in its own profile. Name one script to run only
// that one, for example `npm run test:desktop -- scripts/desktop-coordinator-test.mjs`.
const scripts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["scripts/desktop-test.mjs", "scripts/desktop-coordinator-test.mjs"];
function report(script, detail) {
  if (process.env.GITHUB_ACTIONS === "true") {
    const escaped = detail
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.error(
      `::error file=${script},title=Desktop acceptance smoke::${escaped}`,
    );
  }
}
function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, DEBUG: "pw:browser" },
      stdio: ["ignore", "inherit", "pipe"],
    });
    let diagnostics = "";
    child.stderr.on("data", (bytes) => {
      process.stderr.write(bytes);
      diagnostics = (diagnostics + bytes.toString()).slice(-24000);
    });
    child.on("error", (error) => {
      report(script, error.message);
      resolve(1);
    });
    child.on("close", (code) => {
      if (code !== 0)
        report(
          script,
          diagnostics || "The desktop test process exited without diagnostics.",
        );
      resolve(code ?? 1);
    });
  });
}
for (const script of scripts) {
  const code = await run(script);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
