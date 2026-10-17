// A stand-in for a provider's command line in Topsl's native terminal. It
// prints the arguments and the folder it was started with and contacts no
// model. Like Claude Code when auto mode is unavailable, it refuses
// `--permission-mode auto`.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.300 (terminal stand-in)\n");
  process.exit(0);
}
process.stdout.write(`Stand-in arguments: ${JSON.stringify(args)}\n`);
process.stdout.write(`Stand-in folder: ${JSON.stringify(process.cwd())}\n`);
const flag = args.indexOf("--permission-mode");
const mode = flag >= 0 ? args[flag + 1] : null;
if (mode) process.stdout.write(`Permission mode: ${mode}\n`);
if (mode === "auto") {
  process.stdout.write("Auto mode is unavailable for this account.\n");
  process.exit(1);
}
process.stdout.write("Stand-in ready. Type q to quit.\n");
process.stdin.on("data", (data) => {
  if (String(data).includes("q")) process.exit(0);
});
