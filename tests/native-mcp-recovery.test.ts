import { afterEach, expect, test, vi } from "vitest";
import { nativeFixture, answer } from "./native-fixture";
import { NativeHarness } from "../packages/harness/harness";
import { McpClient, schemaHash } from "../packages/harness/mcp";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Real kernel, persistence and loopback proxy; simulated MCP process boundary.
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});
const schema = { type: "object", properties: {}, additionalProperties: false };
function mcp() {
  const start = vi
    .spyOn(McpClient.prototype, "start")
    .mockResolvedValue([
      { name: "ping", description: "A synthetic probe", inputSchema: schema },
    ]);
  const call = vi
    .spyOn(McpClient.prototype, "call")
    .mockResolvedValue({ ok: true, output: "MCP probe completed" });
  vi.spyOn(McpClient.prototype, "close").mockImplementation(() => {});
  vi.spyOn(McpClient.prototype, "running", "get").mockReturnValue(true);
  return { start, call };
}
function admit(f: Awaited<ReturnType<typeof nativeFixture>>) {
  return f.harness.mcpAdmit({
    projectId: f.project.id,
    name: "fixture",
    argv: ["synthetic-mcp"],
    networkDomains: [],
    tools: { ping: schemaHash(schema) },
  });
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

test("resume after restart restores the frozen server and does not replay its completed call", async () => {
  const server = mcp();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const f = await nativeFixture(async (_call, index) => {
    if (index === 0 || index === 2)
      return { events: answer([{ tool: "mcp__fixture__ping", args: {} }]) };
    if (index === 1) await gate;
    return { events: answer([{ text: "MCP evidence received." }]) };
  });
  cleanups.push(() => f.close());
  const { connection } = f.chatgpt();
  f.route(connection.id, "chatgpt/test");
  const admitted = admit(f);
  const started = await f.start({
    routeAlias: "chatgpt/test",
    prompt: "Use the admitted probe",
    mode: "investigate",
    mcpServerIds: [admitted.id],
  });
  await until(() => f.upstream.calls.length === 2);
  expect(server.call).toHaveBeenCalledTimes(1);
  f.harness.close();
  const recovered = new NativeHarness({
    store: f.store,
    profileDirectory: f.directory,
    endpoint: () => f.endpoint,
    gitExecutable: "git",
    route: (alias) => {
      const route = f.proxy.registry.routeByAlias(alias);
      return route
        ? {
            route,
            connection: f.proxy.registry.requireConnection(route.connectionId),
          }
        : null;
    },
  });
  cleanups.push(() => recovered.close());
  await recovered.recoverAll();
  release();
  await f.settle(started.attemptId);
  await recovered.resume(started.attemptId);
  const final = await recovered.kernel.settled(started.attemptId);
  expect(final.state).toBe("completed");
  expect(server.start).toHaveBeenCalledTimes(2);
  // One old call and one newly requested call, never a replay of the old effect.
  expect(server.call).toHaveBeenCalledTimes(2);
  const results = [...recovered.journal.all(started.attemptId)].filter(
    (e) => e.kind === "tool-result",
  );
  expect(results).toHaveLength(2);
  expect(new Set(results.map((e) => (e.body as any).callId)).size).toBe(2);
});

test.each(["changed", "missing"])(
  "a %s frozen server configuration is refused before restart dispatch",
  async (configuration) => {
    const server = mcp();
    const f = await nativeFixture(() => ({
      events: answer([{ tool: "mcp__fixture__ping", args: {} }]),
    }));
    cleanups.push(() => f.close());
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    const admitted = admit(f);
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "Probe",
      mode: "investigate",
      mcpServerIds: [admitted.id],
      maxRequests: 1,
    });
    expect((await f.settle(started.attemptId)).state).toBe("paused");
    f.harness.close();
    if (configuration === "changed")
      f.harness.mcpAdmit({
        ...admitted,
        argv: ["different-command"],
        tools: admitted.admittedTools,
      });
    else {
      const frozen = f.store.get<{ id: string; tools: unknown[] }>(
        "native-attempt-mcp",
        started.attemptId,
      )!;
      f.store.put("native-attempt-mcp", { id: frozen.id, tools: frozen.tools });
    }
    await expect(f.harness.resume(started.attemptId)).rejects.toThrow(
      configuration === "changed" ? "configuration changed" : "no frozen MCP",
    );
    expect(server.start).toHaveBeenCalledTimes(1);
  },
);

test("children inherit admitted MCP tools in separate server instances", async () => {
  const server = mcp();
  const f = await nativeFixture((_call, index) => ({
    events: answer(
      index === 0
        ? [
            {
              tool: "delegate",
              args: {
                mode: "fresh",
                task: "Run the probe",
                writable: false,
                context_paths: [],
              },
            },
          ]
        : index === 1
          ? [{ tool: "mcp__fixture__ping", args: {} }]
          : [{ text: "Probe completed." }],
    ),
  }));
  cleanups.push(() => f.close());
  const { connection } = f.chatgpt();
  f.route(connection.id, "chatgpt/test");
  const admitted = admit(f);
  const started = await f.start({
    routeAlias: "chatgpt/test",
    prompt: "Delegate a probe",
    mode: "investigate",
    mcpServerIds: [admitted.id],
    delegation: true,
  });
  const final = await f.settle(started.attemptId);
  expect(final.state).toBe("completed");
  expect(final.children).toHaveLength(1);
  expect(server.start).toHaveBeenCalledTimes(2);
  expect(server.call).toHaveBeenCalledTimes(1);
  expect(f.harness.view(final.children[0])?.state).toBe("completed");
});

/** A client attached to an in-memory stand-in for the server process. */
function attached() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const sent: any[] = [];
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean))
      sent.push(JSON.parse(line));
  });
  const client = new McpClient(
    { name: "fixture", argv: ["synthetic-mcp"] },
    {} as any,
    "/",
  );
  (client as any).attach(child);
  return { client, child, sent };
}

test("a failed write to the server's input settles it instead of throwing", async () => {
  const { client, child } = attached();
  const call = client.call("ping", {}, 5_000);
  child.stdin.destroy(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
  await expect(call).rejects.toThrow(/closed its input/);
  expect(client.running).toBe(false);
  expect(child.kill).toHaveBeenCalled();
});

test("a server request that reuses a pending id is refused, not taken as the response", async () => {
  const { client, child, sent } = attached();
  const call = client.call("ping", {}, 5_000);
  await until(() => sent.length === 1);
  const id = sent[0].id;
  child.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method: "sampling/createMessage", params: {} })}\n`,
  );
  await until(() => sent.length === 2);
  expect(sent[1]).toMatchObject({ id, error: { code: -32601 } });
  child.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "pong" }] } })}\n`,
  );
  await expect(call).resolves.toEqual({ ok: true, output: "pong" });
});

test("stopping rejects a pending MCP call at once and tells the server", async () => {
  const { client, sent } = attached();
  const controller = new AbortController();
  const call = client.call("ping", {}, 60_000, controller.signal);
  await until(() => sent.length === 1);
  controller.abort();
  await expect(call).rejects.toThrow(/stopped/);
  await until(() => sent.length === 2);
  expect(sent[1]).toMatchObject({
    method: "notifications/cancelled",
    params: { requestId: sent[0].id },
  });
});
