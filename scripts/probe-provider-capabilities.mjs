import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

// Explicit executables only. No provider user homes, login, settings changes,
// project mutations, session creation, or inference methods are used.
const args = process.argv.slice(2);
const paths = {};
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--codex", "--claude"].includes(args[i]) ||
    !path.isAbsolute(args[i + 1] ?? "")
  )
    throw new Error(
      "Usage: node scripts/probe-provider-capabilities.mjs [--codex /absolute/executable] [--claude /absolute/executable]",
    );
  paths[args[i].slice(2)] = args[i + 1];
}
if (!Object.keys(paths).length)
  throw new Error("Select at least one existing absolute executable.");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "topsl-provider-inventory-"),
);
const run = promisify(execFile);
const env = {
  PATH: process.env.PATH,
  HOME: temporary,
  USERPROFILE: temporary,
  CODEX_HOME: path.join(temporary, "codex"),
  CLAUDE_CONFIG_DIR: path.join(temporary, "claude"),
  LANG: "en_US.UTF-8",
};
await mkdir(env.CODEX_HOME);
await mkdir(env.CLAUDE_CONFIG_DIR);
const evidence = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  host: `${os.platform()}/${os.arch()}`,
  isolatedHomes: true,
  modelTurns: 0,
  providers: {},
};
try {
  for (const [provider, executable] of Object.entries(paths)) {
    const { stdout: version } = await run(executable, ["--version"], {
      cwd: temporary,
      env,
      timeout: 10000,
    });
    const { stdout: help } = await run(
      executable,
      provider === "codex" ? ["app-server", "--help"] : ["--help"],
      { cwd: temporary, env, timeout: 10000 },
    );
    const record = {
      version: version.trim(),
      helpDigest: createHash("sha256").update(help).digest("hex"),
      evidence: "read-only-local-probe",
    };
    evidence.providers[provider] = record;
    if (provider === "claude") {
      record.advertisedFlags = [
        "--print",
        "--input-format",
        "--output-format",
        "--resume",
        "--fork-session",
        "--permission-mode",
        "--bare",
        "--strict-mcp-config",
        "--tools",
        "--safe-mode",
      ].filter((flag) => help.includes(flag));
      record.structuredExecution = "untested";
      continue;
    }
    const schemas = path.join(temporary, "schemas");
    await run(
      executable,
      [
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        schemas,
      ],
      { cwd: temporary, env, timeout: 15000 },
    );
    const files = [];
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.name.endsWith(".json")) files.push(file);
      }
    }
    await visit(schemas);
    const methods = new Set();
    function collect(value) {
      if (!value || typeof value !== "object") return;
      if (typeof value.properties?.method?.const === "string")
        methods.add(value.properties.method.const);
      if (Array.isArray(value.properties?.method?.enum))
        for (const method of value.properties.method.enum)
          if (typeof method === "string") methods.add(method);
      for (const child of Object.values(value))
        if (child && typeof child === "object") collect(child);
    }
    for (const file of files) collect(JSON.parse(await readFile(file, "utf8")));
    record.schemaFileCount = files.length;
    record.advertisedMethods = [...methods].sort();
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: temporary,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let sequence = 0,
      buffer = "";
    const pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part) => {
      buffer += part;
      if (buffer.length > 8000000) {
        child.kill();
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const reply = JSON.parse(line),
            waiter = pending.get(reply.id);
          if (!waiter) continue;
          pending.delete(reply.id);
          clearTimeout(waiter.timer);
          reply.error
            ? waiter.reject(new Error("Provider rejected read-only method."))
            : waiter.resolve(reply.result);
        } catch {
          child.kill();
        }
      }
    });
    function request(method, params) {
      if (
        ![
          "initialize",
          "model/list",
          "account/read",
          "thread/list",
          "project/list",
        ].includes(method)
      )
        throw new Error("Inventory cannot dispatch this method.");
      return new Promise((resolve, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Read-only ${method} timed out.`));
          }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    }
    const fail = () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Read-only provider probe closed."));
      }
      pending.clear();
    };
    child.on("error", fail);
    child.on("exit", fail);
    child.stdin.on("error", fail);
    try {
      await request("initialize", {
        clientInfo: { name: "topsl-read-only-inventory", version: "1" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(
        JSON.stringify({ method: "initialized", params: {} }) + "\n",
      );
      record.initialize = "tested";
      for (const [method, params] of [
        ["model/list", { limit: 100 }],
        ["account/read", { refreshToken: false }],
        ["thread/list", { limit: 10 }],
        ["project/list", { limit: 10 }],
      ]) {
        try {
          const result = await request(method, params);
          record[method] = {
            status: "tested",
            ...(Array.isArray(result?.data)
              ? { count: result.data.length }
              : {}),
            ...(method === "account/read"
              ? {
                  accountPresent:
                    result?.account !== null && result?.account !== undefined,
                }
              : {}),
          };
        } catch {
          record[method] = { status: "unsupported-or-probe-failed" };
        }
      }
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
