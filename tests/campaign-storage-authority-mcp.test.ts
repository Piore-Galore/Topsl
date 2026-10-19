// Campaign 2026-10-19-comprehensive, packet p2a-storage-authority.
// MCP-01/02/04/05/06/07 through the real companion CLI (apps/cli/main.ts,
// bundled the way scripts/build.mjs bundles dist/cli.cjs) talking to the real
// ContextServer socket, and through Service's context-enable command.
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { Store } from "../packages/persistence/store";
import { ContextServer, type ContextGrant } from "../packages/workspace/context";
import type { Message, Project } from "../packages/domain/types";
import { Service } from "../apps/service/service";
import { fixture } from "./helpers";

let cli = "";
let buildDirectory = "";
beforeAll(async () => {
  buildDirectory = await mkdtemp(path.join(os.tmpdir(), "topsl-campaign-cli-"));
  cli = path.join(buildDirectory, "cli.cjs");
  await build({
    entryPoints: [path.resolve("apps/cli/main.ts")],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
  });
  return () => rm(buildDirectory, { recursive: true, force: true });
});
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const env = { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" };
function runCli(args: string[], timeoutMs = 20_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
/** A long-lived `topsl-context mcp` client speaking JSON-RPC over stdio. */
function mcpClient(grantFile: string) {
  const child: ChildProcess = spawn(process.execPath, [cli, "mcp", grantFile], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses: any[] = [];
  const raw: string[] = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    raw.push(line);
    responses.push(JSON.parse(line));
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child,
    responses,
    raw,
    exited,
    send: (value: unknown) => child.stdin!.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n"),
    async response(id: unknown, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = responses.find((r) => r.id === id);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no MCP response for id ${String(id)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}
function socketRequest(endpoint: string, body: Record<string, unknown>) {
  return new Promise<any>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let data = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("socket timed out")));
    socket.once("connect", () => socket.write(JSON.stringify(body) + "\n"));
    socket.on("data", (b) => (data += b));
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
  });
}
const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  projectId: "A",
  conversationId: "c",
  role: "assistant",
  provider: "codex",
  text: `quartz ${id}`,
  runId: null,
  nativeId: id,
  createdAt: "2026-10-19T00:00:00Z",
  ...overrides,
});
function project(id: string, folder: string, trusted = true): Project {
  return { id, name: id, path: folder, realPath: folder, trusted, createdAt: "2026-10-19T00:00:00Z" };
}
async function serviceProfile() {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  cleanups.push(async () => {
    await service.close().catch(() => {});
    await rm(f.directory, { recursive: true, force: true });
  });
  service.store.put("project", project("A", f.directory));
  await service.start();
  return { ...f, service };
}
/** A bare ContextServer with a controllable clock, for expiry and visibility. */
async function serverProfile(clock?: () => number) {
  const f = await fixture();
  const server = new ContextServer(f.store, f.directory, clock);
  await server.start();
  cleanups.push(async () => {
    server.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const writeGrant = async (grant: ContextGrant, extra: Record<string, unknown> = {}, name = "grant") => {
    const file = path.join(f.directory, `${name}.json`);
    await writeFile(file, JSON.stringify({ ...grant, ...extra }), { mode: 0o600 });
    return file;
  };
  return { ...f, server, writeGrant, A: project("A", f.directory) };
}

describe("MCP-01 project-scoped grant through the service approval path", () => {
  test("context-enable needs native confirmation and a trusted project; grants are random, private and project-scoped", async () => {
    const f = await serviceProfile();
    const s = f.service;
    s.store.put("project", project("U", f.directory, false));
    await expect(s.command({ type: "context-enable", projectId: "A" })).rejects.toThrow("native confirmation");
    await expect(s.command({ type: "context-enable", projectId: "U" }, { approved: true })).rejects.toThrow(
      "Trust this project",
    );
    expect((await readdir(f.directory)).includes("context-grants")).toBe(false);
    const first = await s.command({ type: "context-enable", projectId: "A" }, { approved: true });
    const second = await s.command({ type: "context-enable", projectId: "A" }, { approved: true });
    expect(first.expires).toContain("Native configuration is not modified");
    const a = JSON.parse(await readFile(first.file, "utf8")),
      b = JSON.parse(await readFile(second.file, "utf8"));
    expect(a.grant).toMatch(/^[a-f0-9]{48}$/);
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.grant).not.toBe(b.grant);
    expect(a.token).not.toBe(b.token);
    expect((await stat(first.file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(first.file))).mode & 0o777).toBe(0o700);
    expect((await stat(a.endpoint)).mode & 0o777).toBe(0o600);
    expect(path.dirname(a.endpoint)).toBe(f.directory);
    // Project scope through the real CLI.
    s.store.put("project", project("B", path.join(f.directory, "b")));
    s.store.message(message("a1", { text: "MCP01 alpha shared-term" }));
    s.store.message(message("b1", { projectId: "B", text: "MCP01 bravo shared-term BSECRET" }));
    const status = await runCli(["status", first.file]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ projectId: "A", readOnly: true, administrativeAuthority: false });
    const search = await runCli(["search", first.file, "shared-term"]);
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout).map((m: any) => m.id)).toEqual(["a1"]);
    expect(search.stdout).not.toContain("BSECRET");
    // Unauthenticated or mixed credentials are refused by the server.
    for (const body of [
      { method: "status" },
      { grant: a.grant, method: "status" },
      { grant: a.grant, token: b.token, method: "status" },
      { grant: "0".repeat(48), token: a.token, method: "status" },
    ])
      expect((await socketRequest(a.endpoint, body)).error).toBe("Invalid project context grant.");
  });
});

describe("MCP-02 server-side rejection whatever the client sends", () => {
  test("wrong token, revoked grant, revoked project or attempt, and expiry fail through the CLI; client fields cannot widen scope", async () => {
    let tick = 1_000_000;
    const f = await serverProfile(() => tick);
    f.store.message(message("visible"));
    f.store.message(message("peer", { runId: "peer-run", text: "quartz WITHHELD_RUN" }));
    f.store.message(message("private", { conversationId: "private", text: "quartz WITHHELD_CONVERSATION" }));
    f.store.message(message("other", { projectId: "B", text: "quartz OTHER_PROJECT" }));
    const grant = f.server.grant(f.A, {
      ttlMs: 60_000,
      visibility: { excludedRunIds: ["peer-run"], excludedConversationIds: ["private"] },
      subject: { attemptId: "attempt-1" },
    });
    const widened = await f.writeGrant(
      grant,
      { projectId: "B", visibility: {}, subject: { attemptId: "other" }, candidates: [] },
      "widened",
    );
    for (const mode of ["history", "search"]) {
      const result = await runCli([mode, widened, "quartz"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).map((m: any) => m.id)).toEqual(["visible"]);
      expect(result.stdout).not.toMatch(/WITHHELD|OTHER_PROJECT/);
    }
    const status = JSON.parse((await runCli(["status", widened])).stdout);
    expect(status).toMatchObject({ projectId: "A", restrictedHistory: true, subject: { attemptId: "attempt-1" } });
    const wrongToken = await f.writeGrant(grant, { token: "f".repeat(64) }, "wrong-token");
    const refused = async (file: string) => {
      const result = await runCli(["status", file]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid project context grant");
    };
    await refused(wrongToken);
    // Expiry exactly at the boundary.
    tick = Date.parse(grant.expiresAt) - 1;
    expect((await runCli(["status", widened])).code).toBe(0);
    tick = Date.parse(grant.expiresAt);
    await refused(widened);
    tick = 1_000_000;
    // Attempt revocation, project revocation and single-grant revocation.
    expect(f.server.revokeAttempt("attempt-1")).toBe(1);
    await refused(widened);
    const second = await f.writeGrant(f.server.grant(f.A), {}, "second");
    const third = await f.writeGrant(f.server.grant(f.A), {}, "third");
    expect((await runCli(["status", second])).code).toBe(0);
    expect(f.server.revoke(JSON.parse(await readFile(second, "utf8")).grant)).toBe(true);
    await refused(second);
    expect((await runCli(["status", third])).code).toBe(0);
    expect(f.server.revokeProject("A")).toBe(1);
    await refused(third);
  });
});

describe("MCP-03 CLI modes, malformed grant, unavailable endpoint and timeout", () => {
  test("each one-shot mode prints JSON and exits 0; bad input, missing endpoint and a silent server exit non-zero without hanging", async () => {
    const f = await serverProfile();
    f.store.message(message("one", { text: "quartz mode check" }));
    const file = await f.writeGrant(f.server.grant(f.A));
    for (const args of [
      ["status"],
      ["search", "quartz"],
      ["history"],
      ["search-page", "quartz", "--limit", "1"],
      ["history-page", "--limit", "1"],
    ]) {
      const result = await runCli([args[0], file, ...args.slice(1)]);
      expect(result.code, args[0]).toBe(0);
      expect(() => JSON.parse(result.stdout), args[0]).not.toThrow();
    }
    const usage = await runCli(["status"]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("Usage: topsl-context");
    const malformed = path.join(f.directory, "malformed.json");
    await writeFile(malformed, "{not a grant");
    const bad = await runCli(["status", malformed]);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout).toBe("");
    const missing = await f.writeGrant(
      { ...f.server.grant(f.A), endpoint: path.join(f.directory, "absent.sock") },
      {},
      "missing-endpoint",
    );
    const unavailable = await runCli(["status", missing]);
    expect(unavailable.code).toBe(1);
    expect(unavailable.stderr).toMatch(/ENOENT|ECONNREFUSED/);
    // A server that accepts and never answers: the CLI's own 10 s timeout ends it.
    const { createServer } = await import("node:net");
    const silentPath = path.join(f.directory, "silent.sock");
    const held = new Set<import("node:net").Socket>();
    const silent = createServer((socket) => {
      held.add(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => silent.listen(silentPath, resolve));
    cleanups.push(() => {
      held.forEach((socket) => socket.destroy());
      silent.close();
    });
    const silentGrant = await f.writeGrant({ ...f.server.grant(f.A), endpoint: silentPath }, {}, "silent");
    const started = Date.now();
    const timedOut = await runCli(["status", silentGrant], 30_000);
    expect(timedOut.code).toBe(1);
    expect(timedOut.stderr).toContain("Topsl context timed out");
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
  });
});

describe("MCP-04 pagination through the CLI", () => {
  test("limits 1 and 50, invalid limits, changed query or scope, reused cursors, deletions, Unicode and large history", async () => {
    const f = await serverProfile();
    f.store.transaction(() => {
      for (let i = 0; i < 120; i++)
        f.store.message(message(`m${String(i).padStart(3, "0")}`, {
          conversationId: i < 10 ? "doomed" : "c",
          text: `quartz 量子 ünïcødé 🚀 item ${i}`,
        }));
      for (let i = 0; i < 300; i++) f.store.message(message(`noise${i}`, { projectId: "B" }));
    });
    const file = await f.writeGrant(f.server.grant(f.A));
    const page = async (mode: string, extra: string[]) => {
      const result = await runCli([mode, file, ...extra]);
      return { ...result, json: result.code === 0 ? JSON.parse(result.stdout) : null };
    };
    const one = await page("history-page", ["--limit", "1"]);
    expect(one.json.items).toHaveLength(1);
    expect(one.json.nextCursor).toBeTruthy();
    expect(one.json.items[0].text).toBe("quartz 量子 ünïcødé 🚀 item 119");
    // Reusing a cursor returns the same next page, never a shifted or new one.
    const r1 = await page("history-page", ["--limit", "1", "--cursor", one.json.nextCursor]);
    const r2 = await page("history-page", ["--limit", "1", "--cursor", one.json.nextCursor]);
    expect(r1.json).toEqual(r2.json);
    expect(r1.json.items[0].id).toBe("m118");
    // Full walk at limit 50, deleting a conversation after the first page.
    const seen: string[] = [];
    let cursor: string | null = null,
      pages = 0;
    do {
      const result = await page("history-page", ["--limit", "50", ...(cursor ? ["--cursor", cursor] : [])]);
      expect(result.code, result.stderr).toBe(0);
      seen.push(...result.json.items.map((m: any) => m.id));
      cursor = result.json.nextCursor;
      if (++pages === 1) f.store.deleteConversation("doomed");
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.some((id) => id.startsWith("noise"))).toBe(false);
    expect(seen.filter((id) => Number(id.slice(1)) < 10)).toEqual([]);
    expect(seen).toHaveLength(110);
    // Search pages with the same query; a changed query or route rejects the cursor.
    const s1 = await page("search-page", ["quartz", "--limit", "50"]);
    expect(s1.json.items).toHaveLength(50);
    for (const args of [
      ["search-page", "ünïcødé", "--limit", "50", "--cursor", s1.json.nextCursor],
      ["history-page", "--limit", "50", "--cursor", s1.json.nextCursor],
      ["search-page", "quartz", "--limit", "50", "--cursor", "bm90LWEtY3Vyc29y"],
    ]) {
      const result = await runCli([args[0], file, ...args.slice(1)]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Invalid cursor");
    }
    // Another grant scope (restricted visibility) cannot reuse this cursor.
    const restricted = await f.writeGrant(
      f.server.grant(f.A, { visibility: { excludedMessageIds: ["m119"] } }),
      {},
      "restricted",
    );
    const crossScope = await runCli(["history-page", restricted, "--limit", "50", "--cursor", one.json.nextCursor]);
    expect(crossScope.code).toBe(1);
    expect(crossScope.stderr).toContain("Invalid cursor");
    for (const limit of ["0", "51", "1.5", "abc", "-1"]) {
      const result = await runCli(["history-page", file, "--limit", limit]);
      expect(result.code, limit).toBe(1);
      expect(result.stderr, limit).toContain("page size");
    }
    const unicode = await page("search-page", ["ünïcødé", "--limit", "5"]);
    expect(unicode.json.items[0].text).toContain("量子 ünïcødé 🚀");
  });
});

describe("MCP-05 MCP stdio protocol", () => {
  async function client() {
    const f = await serverProfile();
    f.store.message(message("one"));
    const file = await f.writeGrant(f.server.grant(f.A));
    return { ...f, mcp: mcpClient(file) };
  }
  test("initialize, notifications, list, concurrent calls, unknown methods and tools, and invalid arguments", async () => {
    const { mcp } = await client();
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect((await mcp.response(1)).result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
    });
    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (await mcp.response(2)).result.tools.map((t: any) => t.name).sort();
    expect(tools).toEqual(["topsl_history_page", "topsl_search", "topsl_search_page", "topsl_status"]);
    const calls = [
      [10, "topsl_status", {}],
      [11, "topsl_search_page", { query: "quartz", limit: 1 }],
      [12, "topsl_history_page", { limit: 1 }],
      ["thirteen", "topsl_search", { query: "quartz" }],
    ] as const;
    for (const [id, name, args] of calls)
      mcp.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    for (const [id] of calls) {
      const response = await mcp.response(id);
      expect(response.jsonrpc).toBe("2.0");
      expect(response.error).toBeUndefined();
      expect(() => JSON.parse(response.result.content[0].text)).not.toThrow();
    }
    expect(JSON.parse((await mcp.response(10)).result.content[0].text).readOnly).toBe(true);
    mcp.send({ jsonrpc: "2.0", id: 20, method: "resources/list" });
    mcp.send({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "run_command", arguments: {} } });
    mcp.send({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "topsl_history_page", arguments: { limit: 999 } } });
    for (const id of [20, 21, 22]) {
      const response = await mcp.response(id);
      expect(response.result).toBeUndefined();
      expect(typeof response.error.code).toBe("number");
      expect(typeof response.error.message).toBe("string");
    }
    expect((await mcp.response(22)).error.message).toContain("page size");
    // No response was ever produced for the notification, and every line is bounded.
    expect(mcp.responses.filter((r) => r.id === undefined)).toEqual([]);
    expect(Math.max(...mcp.raw.map((line) => line.length))).toBeLessThan(1_100_000);
    mcp.child.stdin!.end();
    expect(await mcp.exited).toBe(0);
  });
  // CAMPAIGN DEFECT MCP-05: a malformed JSON line gets no JSON-RPC parse error (-32700, id null); apps/cli/main.ts drops it silently.
  test.fails("malformed JSON receives a well-formed parse error response", async () => {
    const { mcp } = await client();
    mcp.send("{not json");
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await mcp.response(2);
    const parseError = mcp.responses.find((r) => r.id === null);
    expect(parseError?.error?.code).toBe(-32700);
  });
  // CAMPAIGN DEFECT MCP-05: a request line over 16,000 characters is dropped without any response, so a client waiting on its id never completes.
  test.fails("an oversized request receives a bounded error for its id", async () => {
    const { mcp } = await client();
    mcp.send({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: { name: "topsl_search", arguments: { query: "q".repeat(20_000) } },
    });
    mcp.send({ jsonrpc: "2.0", id: 31, method: "tools/list" });
    // Replies are collected by id, so the result does not depend on whether the
    // server answers 30 or 31 first once the oversized line is handled.
    const [oversized, control] = await Promise.allSettled([mcp.response(30, 5_000), mcp.response(31)]);
    // Control: the client stayed alive and answered the in-bounds request.
    expect(control.status).toBe("fulfilled");
    expect((control as PromiseFulfilledResult<any>).value.result.tools.length).toBeGreaterThan(0);
    // The oversized request gets its own well-formed, bounded error.
    expect(oversized.status).toBe("fulfilled");
    const reply = (oversized as PromiseFulfilledResult<any>).value;
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 30 });
    expect(reply.result).toBeUndefined();
    expect(typeof reply.error.code).toBe("number");
    expect(typeof reply.error.message).toBe("string");
    expect(JSON.stringify(reply).length).toBeLessThan(16_000);
  });
});

describe("MCP-06 the context endpoint carries no administrative authority", () => {
  test("execution, installation, configuration, approval and grant methods are refused and change nothing", async () => {
    const f = await serviceProfile();
    const s = f.service;
    const enabled = await s.command({ type: "context-enable", projectId: "A" }, { approved: true });
    const grant = JSON.parse(await readFile(enabled.file, "utf8"));
    const documents = () => s.store.db.prepare("SELECT count(*) n FROM documents").get().n;
    const head = s.store.controlHead(),
      count = documents(),
      files = (await readdir(f.directory)).sort(),
      grants = await readdir(path.dirname(enabled.file));
    for (const method of [
      "run-start",
      "task-run",
      "lifecycle-apply",
      "lifecycle-preview",
      "configuration-apply",
      "configuration-preview",
      "approval-decide",
      "context-enable",
      "project-trust",
      "terminal-open",
      "candidate-read",
      "exec",
    ]) {
      const response = await socketRequest(grant.endpoint, {
        ...grant,
        method,
        projectId: "A",
        command: "/bin/sh -c 'touch PWNED'",
        trusted: { approved: true, digest: "forged" },
      });
      expect(response.result, method).toBeUndefined();
      expect(typeof response.error, method).toBe("string");
    }
    const viaMcp = mcpClient(enabled.file);
    viaMcp.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lifecycle-apply", arguments: {} } });
    viaMcp.send({ jsonrpc: "2.0", id: 2, method: "approval-decide", params: { id: "x", allow: true } });
    expect((await viaMcp.response(1)).error).toBeTruthy();
    expect((await viaMcp.response(2)).error).toBeTruthy();
    const usage = await runCli(["run-start", enabled.file]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("Usage: topsl-context");
    // The only durable effect is the candidate reader's audit receipt for the
    // refused candidate-* call: denied, zero bytes.
    const changes = s.store.db.prepare("SELECT kind,id,operation FROM control_changes WHERE sequence>?").all(head);
    expect(changes.map((c: any) => [c.kind, c.operation])).toEqual([["candidate-retrieval", "put"]]);
    expect(s.store.get<any>("candidate-retrieval", changes[0].id)).toMatchObject({
      method: "candidate-read",
      outcome: "denied",
      bytes: 0,
    });
    expect(documents()).toBe(count + 1);
    expect((await readdir(f.directory)).sort()).toEqual(files);
    expect(await readdir(path.dirname(enabled.file))).toEqual(grants);
  });
});

describe("MCP-07 close and restart during use", () => {
  test("pending clients end cleanly, former grants cannot be revived, and new grants need the supported flow", async () => {
    const f = await fixture();
    f.store.close();
    cleanups.push(() => rm(f.directory, { recursive: true, force: true }));
    const first = new Service(f.directory, f.key, () => {}, true);
    first.store.put("project", project("A", f.directory));
    await first.start();
    const enabled = await first.command({ type: "context-enable", projectId: "A" }, { approved: true });
    const grant = JSON.parse(await readFile(enabled.file, "utf8"));
    const mcp = mcpClient(enabled.file);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "topsl_status", arguments: {} } });
    expect((await mcp.response(1)).result).toBeTruthy();
    // A request in flight (no newline yet) when the service closes.
    const pending = createConnection(grant.endpoint);
    await new Promise<void>((resolve) => pending.once("connect", () => resolve()));
    pending.write(JSON.stringify({ ...grant, method: "status" }));
    const pendingClosed = new Promise<{ data: string }>((resolve) => {
      let data = "";
      pending.on("data", (b) => (data += b));
      pending.on("error", () => {});
      pending.once("close", () => resolve({ data }));
    });
    await first.close();
    expect((await pendingClosed).data).toBe("");
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "topsl_status", arguments: {} } });
    expect((await mcp.response(2)).error.message).toMatch(/ENOENT|ECONNREFUSED/);
    const second = new Service(f.directory, f.key, () => {}, true);
    cleanups.push(() => second.close().catch(() => {}));
    await second.start();
    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "topsl_status", arguments: {} } });
    expect((await mcp.response(3)).error.message).toContain("Invalid project context grant");
    const oneShot = await runCli(["status", enabled.file]);
    expect(oneShot.code).toBe(1);
    expect(oneShot.stderr).toContain("Invalid project context grant");
    await expect(second.command({ type: "context-enable", projectId: "A" })).rejects.toThrow("native confirmation");
    const renewed = await second.command({ type: "context-enable", projectId: "A" }, { approved: true });
    const fresh = await runCli(["status", renewed.file]);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.stdout).projectId).toBe("A");
    mcp.child.stdin!.end();
    expect(await mcp.exited).toBe(0);
  });
});
