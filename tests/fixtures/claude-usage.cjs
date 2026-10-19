// Native /usage and auth-status stand-in. Never reads a real Claude profile.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.302 (Claude Code usage stand-in)");
  process.exit(0);
}
const root = process.env.CLAUDE_CONFIG_DIR;
if (!root || !fs.existsSync(path.join(root, "usage-fixture"))) process.exit(2);
const knob = (name) => fs.existsSync(path.join(root, name));
if (args.join(" ") === "auth status --json") {
  console.log(
    JSON.stringify({
      loggedIn: !knob("signed-out"),
      authMethod: "claude.ai",
      email: knob("changed-account")
        ? "other@example.test"
        : "private@example.test",
      orgId: "private-organization",
      configDirectory: root,
      subscriptionType: "max",
    }),
  );
  process.exit(0);
}
fs.writeFileSync(path.join(root, "usage-args.json"), JSON.stringify(args));
fs.appendFileSync(path.join(root, "usage-starts"), "start\n");
if (
  args.at(-1) !== "/usage" ||
  !args.includes("--safe-mode") ||
  args.includes("--print")
)
  process.exit(3);
if (knob("change-account"))
  fs.writeFileSync(path.join(root, "changed-account"), "");
if (knob("silent")) {
  // Exercise service shutdown while the native display is still loading.
} else if (knob("failure")) {
  console.log("Error fetching usage. private-body-must-not-leak");
} else {
  // Shape observed in 2.1.302 screen-reader mode, with synthetic values.
  process.stdout.write(
    "\x1b]0;Claude\x07Settings  Status   Config   Usage   Stats\r\nLoading usage data…\r\nEsc to cancel",
  );
  setTimeout(() => process.stdout.write("\x1b[2K\x1b[1A\x1b[GCurrent ses"), 20);
  setTimeout(
    () =>
      process.stdout.write(
        "sion\r\n13% 13% used\r\nResets 1:29am (Asia/Shanghai)\r\nCurrent week (all models)\r\n51% 51% used\r\nResets Oct 23 at 3:59pm (Asia/Shanghai)\r\nCurrent week (Fable)\r\n0% 0% used\r\nResets Oct 23 at 4pm (Asia/Shanghai)\r\nWhat's contributing to your limits usage?\r\n90% of your usage was at >150k context\r\nUsage credits\r\nUsage credits are off\r\nEsc to cancel\x1b[29G",
      ),
    40,
  );
}
// The reader must close the native terminal, including on failure.
setInterval(() => {}, 1000);
