import { spawn } from "node:child_process";
import electron from "electron";
// Topsl refuses to launch providers while a billing variable is set
// (billingConflicts in packages/platform/system.ts). A terminal or agent
// session that exports one, such as ANTHROPIC_BASE_URL, would otherwise fail
// every provider test for that reason alone, so run the suite as a Dock launch
// would. Tests that need one set it themselves.
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
for (const name of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
])
  delete env[name];
const child = spawn(
  electron,
  ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
