import { afterEach, expect, test } from "vitest";
import { answer, nativeFixture } from "./native-fixture";
import { listUpstreamModels } from "../packages/proxy/adapters";
import { ResourceLedger } from "../packages/harness/resources";
import { adapterRevisions } from "../packages/proxy/registry";
import type { ClientProtocol } from "../packages/proxy/canonical";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

for (const protocol of ["responses", "messages", "chat"] as ClientProtocol[]) {
  test(`a configured ${protocol} gateway completes native tool use on that upstream protocol`, async () => {
    const f = await nativeFixture((_call, index) => ({
      events: answer(
        index === 0
          ? [{ tool: "read_file", args: { path: "README.md" } }]
          : [{ text: "Read the fixture." }],
      ),
    }));
    cleanups.push(() => f.close());
    const c = f.proxy.registry.createConnection({
      kind: "openai-compatible",
      label: "Gateway",
      endpoint: `http://127.0.0.1:${f.upstream.port}/v1`,
      protocol,
    });
    await f.proxy.command({
      type: "connection-api-key",
      connectionId: c.id,
      key: "synthetic-gateway-key",
    });
    f.route(c.id, `gateway/${protocol}`);
    const started = await f.start({
      routeAlias: `gateway/${protocol}`,
      prompt: "Read README",
      mode: "investigate",
    });
    const final = await f.settle(started.attemptId);
    expect(final.state).toBe("completed");
    expect(f.upstream.calls).toHaveLength(2);
    expect(f.upstream.calls.every((call) => call.protocol === protocol)).toBe(
      true,
    );
    if (protocol === "messages")
      expect(f.upstream.calls[0].headers["anthropic-version"]).toBe(
        "2023-06-01",
      );
    expect(final.binding.native?.funding).toBe("gateway");
  });
}

test("catalog pagination preserves all models and refuses repeated cursors", async () => {
  const f = await nativeFixture(() => ({
    events: answer([{ text: "unused" }]),
  }));
  cleanups.push(() => f.close());
  const c = f.proxy.registry.createConnection({
    kind: "anthropic-api",
    label: "Anthropic API",
  });
  const paths: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    paths.push(String(url));
    return Response.json(
      paths.length === 1
        ? { data: [{ id: "a" }], has_more: true, last_id: "a" }
        : { data: [{ id: "b" }], has_more: false },
    );
  };
  const models = await listUpstreamModels({
    connection: c,
    headers: {},
    fetch: fetcher,
  });
  expect(models.map((m) => m.id)).toEqual(["a", "b"]);
  expect(paths[1]).toContain("after_id=a");
  await expect(
    listUpstreamModels({
      connection: c,
      headers: {},
      fetch: async () =>
        Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" }),
    }),
  ).rejects.toThrow("pagination cursor");
});

test("an adapter upgrade invalidates saved route revisions without rewriting history", async () => {
  const f = await nativeFixture(() => ({
    events: answer([{ text: "unused" }]),
  }));
  cleanups.push(() => f.close());
  const { connection } = f.chatgpt();
  const before = f.route(connection.id, "chatgpt/test");
  const revision = adapterRevisions["chatgpt-plan"];
  try {
    adapterRevisions["chatgpt-plan"] = "future-test-revision";
    expect(f.proxy.registry.routeByAlias(before.alias)?.revision).not.toBe(
      before.revision,
    );
    expect(f.proxy.registry.routes()[0].adapterRevision).toBe(
      "future-test-revision",
    );
  } finally {
    adapterRevisions["chatgpt-plan"] = revision;
  }
});

test("quota waits survive a resource ledger restart and already-cancelled requests take no capacity", async () => {
  const f = await nativeFixture(() => ({
    events: answer([{ text: "unused" }]),
  }));
  cleanups.push(() => f.close());
  f.harness.resources.pauseQuota("plan-account", "Usage exhausted");
  const restored = new ResourceLedger({ store: f.store });
  expect(restored.quotaWait("plan-account")?.detail).toBe("Usage exhausted");
  restored.resumeQuota("plan-account");
  expect(
    new ResourceLedger({ store: f.store }).quotaWait("plan-account"),
  ).toBeNull();
  const signal = AbortSignal.abort();
  await expect(restored.acquireInference("cancelled", signal)).rejects.toThrow(
    "Cancelled",
  );
  expect(restored.snapshot().inference.inUse).toBe(0);
});
