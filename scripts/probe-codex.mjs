import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable))
  throw new Error(
    "Pass the absolute path of a trusted Codex executable. This probe uses a temporary empty native home and submits no model turn.",
  );
const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-test-probe-"));
const source = `import { RpcPeer } from ${JSON.stringify(path.resolve("packages/runtime/rpc.ts"))};
import { runFile, nativeEnvironment } from ${JSON.stringify(path.resolve("packages/platform/system.ts"))};
const env = nativeEnvironment({ CODEX_HOME: ${JSON.stringify(directory)}, HOME: ${JSON.stringify(directory)}, USERPROFILE: ${JSON.stringify(directory)} });
const version = await runFile(${JSON.stringify(executable)}, ['--version'], {cwd:${JSON.stringify(directory)},env});
const peer = new RpcPeer(${JSON.stringify(executable)}, ['app-server'], ${JSON.stringify(directory)}, env);
try { const info = await peer.initialize(); const models = await peer.request('model/list', {limit:100}); console.log(JSON.stringify({version:version.trim(), initialized:!!info, modelCount:models.data?.length ?? 0, isolatedNativeHome:true, submittedTurns:0})); } finally { peer.close(); }
`;
await build({
  stdin: {
    contents: source,
    resolveDir: process.cwd(),
    sourcefile: "probe.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(directory, "probe.mjs"),
});
const child = spawn(process.execPath, [path.join(directory, "probe.mjs")], {
  stdio: "inherit",
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
