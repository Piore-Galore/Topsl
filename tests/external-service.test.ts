import { afterEach, expect, test } from "vitest";
import { answer, lastResults, nativeFixture, type Script } from "./native-fixture";
import { memberCapabilityBlockers } from "../packages/proxy/capabilities";
import { nativeRouteReadiness } from "../packages/providers/readiness";
import type { ClientProtocol } from "../packages/proxy/canonical";
import type { ServiceAuthentication } from "../packages/proxy/types";

/**
 * External model services (the `openai-compatible` connection kind): a
 * separately operated service Topsl reaches over a standard protocol. Every
 * service here is a synthetic local server; nothing reaches a provider.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const KEY = "synthetic-service-key-0123";

async function service(script: Script) {
  const f = await nativeFixture(script);
  cleanups.push(() => f.close());
  const add = async (
    protocol: ClientProtocol = "chat",
    auth: ServiceAuthentication = "bearer",
  ) => {
    const connection = f.proxy.registry.createConnection({
      kind: "openai-compatible",
      label: "External service",
      endpoint: `http://127.0.0.1:${f.upstream.port}/v1`,
      protocol,
      serviceAuth: auth,
    });
    if (auth !== "none")
      await f.proxy.command({
        type: "connection-api-key",
        connectionId: connection.id,
        key: KEY,
      });
    return f.proxy.registry.requireConnection(connection.id);
  };
  return { ...f, add };
}

const toolThenText: Script = (_call, index) => ({
  events: answer(
    index === 0
      ? [{ tool: "read_file", args: { path: "README.md" }, id: "call_read_1" }]
      : [{ text: "Read it." }],
  ),
});

for (const [protocol, auth] of [
  ["chat", "bearer"],
  ["responses", "x-api-key"],
  ["messages", "none"],
] as Array<[ClientProtocol, ServiceAuthentication]>)
  test(`a ${protocol} service completes a streamed tool round trip with ${auth} authentication`, async () => {
    const f = await service(toolThenText);
    const connection = await f.add(protocol, auth);
    f.route(connection.id, `external/${protocol}`);
    const started = await f.start({
      routeAlias: `external/${protocol}`,
      prompt: "Read README",
      mode: "investigate",
    });
    const final = await f.settle(started.attemptId);
    expect(final.state).toBe("completed");
    expect(f.upstream.calls).toHaveLength(2);
    const [first, second] = f.upstream.calls;
    expect(first.path).toBe(
      {
        chat: "/v1/chat/completions",
        responses: "/v1/responses",
        messages: "/v1/messages",
      }[protocol],
    );
    for (const call of f.upstream.calls) {
      expect(call.headers.authorization).toBe(
        auth === "bearer" ? `Bearer ${KEY}` : undefined,
      );
      expect(call.headers["x-api-key"]).toBe(
        auth === "x-api-key" ? KEY : undefined,
      );
      // No remote pin was declared, so none is claimed.
      expect(call.headers["x-gateway-route-revision"]).toBeUndefined();
    }
    const assistant = second.request.messages.find((m) =>
      m.parts.some((p) => p.type === "tool-call"),
    )!;
    const callId = (assistant.parts.find((p) => p.type === "tool-call") as any)
      .id;
    expect(lastResults(second.request)).toEqual([
      expect.objectContaining({ callId }),
    ]);
    expect(final.binding.native?.funding).toBe("gateway");
    expect(JSON.stringify(f.proxy.view())).not.toContain(KEY);
  });

test("no-key mode is limited to a service on this computer", async () => {
  const f = await service(toolThenText);
  expect(() =>
    f.proxy.registry.createConnection({
      kind: "openai-compatible",
      label: "Remote",
      endpoint: "https://service.example/v1",
      serviceAuth: "none",
    }),
  ).toThrow("on this computer");
  expect(() =>
    f.proxy.registry.createConnection({
      kind: "openai-api",
      label: "OpenAI",
      serviceAuth: "x-api-key",
    }),
  ).toThrow("Only an external model service");
  const local = await f.add("chat", "none");
  expect(local).toMatchObject({ authentication: "none", state: "ready" });
});

test("the capability document is optional: absent or unreadable documents leave inference working", async () => {
  const f = await service(toolThenText);
  const connection = await f.add();
  f.route(connection.id, "external/model");
  const read = () =>
    f.proxy.command({
      type: "connection-capabilities",
      connectionId: connection.id,
    }) as Promise<any>;
  expect((await read()).document.state).toBe("absent");
  f.upstream.document.status = 501;
  expect((await read()).document.state).toBe("absent");
  f.upstream.document.status = 200;
  f.upstream.document.body = "not json";
  expect((await read()).document.state).toBe("unrecognized");
  f.upstream.document.body = { schema_version: 2, routes: [] };
  const future = (await read()).document;
  expect(future).toMatchObject({ state: "unrecognized" });
  expect(future.detail).toContain("schema version (2)");
  // The service's key went with the document request and nowhere else.
  expect(f.upstream.document.requests[0].authorization).toBe(`Bearer ${KEY}`);
  const started = await f.start({
    routeAlias: "external/model",
    prompt: "Read README",
    mode: "investigate",
  });
  expect((await f.settle(started.attemptId)).state).toBe("completed");
  // A 401 is an authentication rejection, not an absent document.
  f.upstream.document.status = 401;
  f.upstream.document.body = { error: { message: "bad key" } };
  const before = f.proxy.registry.requireConnection(connection.id).manifest;
  await expect(read()).rejects.toThrow("rejected the key");
  expect(f.proxy.registry.requireConnection(connection.id).manifest).toEqual(
    before,
  );
});

function document(options: {
  pinning?: boolean;
  revision?: string;
  capabilities?: Record<string, string>;
  engine?: string;
}) {
  return {
    schema_version: 1,
    gateway_id: "gw_example",
    revision: "cfg_7",
    routes: [
      {
        id: "route_review",
        model: "upstream-model",
        route_revision: options.revision ?? "route_review_3",
        engine: options.engine ?? "model-api",
        protocols: [
          {
            name: "chat",
            capabilities: options.capabilities ?? {
              streaming: "supported",
              tool_calls: "supported",
              parallel_tool_calls: "unknown",
              structured_output: "supported",
              images: "unknown",
              reasoning: "unknown",
            },
          },
        ],
        extensions: { route_revision_pinning: options.pinning ?? false },
      },
    ],
  };
}

/** Answers Topsl's three connection-test requests correctly. */
const probeScript =
  (structured = '{"ok": true}'): Script =>
  (call) =>
    call.request.tools.some((t) => t.name === "topsl_connection_test")
      ? {
          events: answer([
            { tool: "topsl_connection_test", args: { value: "probe" } },
          ]),
        }
      : call.request.outputFormat
        ? { events: answer([{ text: structured }]) }
        : { events: answer([{ text: "ready" }]) };

test("a declaration is not a probe; the connection test records probed evidence for one configuration", async () => {
  const f = await service(probeScript());
  const connection = await f.add();
  f.upstream.document.status = 200;
  f.upstream.document.body = document({});
  await f.proxy.command({
    type: "connection-capabilities",
    connectionId: connection.id,
  });
  const route = f.route(connection.id, "external/model");
  const current = () => ({
    route: f.proxy.registry.route(route.id)!,
    connection: f.proxy.registry.requireConnection(connection.id),
    view: f.proxy.view().capabilities[route.id],
  });
  expect(current().view.tools).toMatchObject({
    value: "supported",
    evidence: "declared",
  });
  const declaredBlockers = memberCapabilityBlockers(
    current().route,
    current().connection,
    true,
  );
  expect(declaredBlockers.join("\n")).toContain(
    "declared by the service but not tested",
  );
  expect(
    nativeRouteReadiness(
      {
        alias: route.alias,
        disabled: false,
        structuredOutput: "unknown",
        connectionLabel: connection.label,
        connectionState: "ready",
        connectionDetail: null,
        proxyRunning: true,
        capabilityBlockers: declaredBlockers,
      },
      "implementation",
    ).ready,
  ).toBe(false);

  const tested = (await f.proxy.command({
    type: "connection-test",
    routeId: route.id,
  })) as any;
  expect(tested.results).toMatchObject({
    streaming: { value: "supported" },
    tools: { value: "supported" },
    structuredOutput: { value: "supported" },
  });
  expect(current().view.tools).toMatchObject({
    value: "supported",
    evidence: "probed",
  });
  expect(
    memberCapabilityBlockers(current().route, current().connection, true),
  ).toEqual([]);
  // Each test request is an ordinary, visible receipt.
  expect(
    f.proxy.registry
      .receipts({ connectionId: connection.id })
      .map((r) => r.correlationId)
      .sort(),
  ).toEqual([
    "connection-test:streaming",
    "connection-test:structuredOutput",
    "connection-test:tools",
  ]);
  // A later declaration never overwrites the current probe.
  await f.proxy.command({
    type: "connection-capabilities",
    connectionId: connection.id,
  });
  expect(current().view.tools.evidence).toBe("probed");

  // The service now pins its route: a different configuration, so the
  // probe no longer applies and members need a new test.
  const revision = current().route.revision;
  f.upstream.document.body = document({ pinning: true });
  const changed = (await f.proxy.command({
    type: "connection-capabilities",
    connectionId: connection.id,
  })) as any;
  expect(changed.changedRoutes).toEqual(["external/model"]);
  expect(current().route.revision).not.toBe(revision);
  expect(current().route.remotePin).toEqual({
    gatewayId: "gw_example",
    routeId: "route_review",
    routeRevision: "route_review_3",
  });
  expect(current().view.structuredOutput.evidence).toBe("declared");
  expect(
    memberCapabilityBlockers(current().route, current().connection, false)[0],
  ).toMatch(/^tools-not-verified/);
});

test("a structured-output test that fails gives members a clear reason", async () => {
  const f = await service(probeScript("Sure! ok is true."));
  const connection = await f.add();
  const route = f.route(connection.id, "external/model");
  const tested = (await f.proxy.command({
    type: "connection-test",
    routeId: route.id,
  })) as any;
  expect(tested.results.structuredOutput).toMatchObject({
    value: "unsupported",
  });
  const blockers = memberCapabilityBlockers(
    f.proxy.registry.route(route.id)!,
    f.proxy.registry.requireConnection(connection.id),
    true,
  );
  expect(blockers).toEqual([
    expect.stringContaining("failed Topsl's structured output test"),
  ]);
  // Direct chat does not need a schema; tools were verified.
  expect(
    memberCapabilityBlockers(
      f.proxy.registry.route(route.id)!,
      f.proxy.registry.requireConnection(connection.id),
      false,
    ),
  ).toEqual([]);
});

test("a route whose service lists another engine is never pinned or declared", async () => {
  const f = await service(toolThenText);
  const connection = await f.add();
  f.upstream.document.status = 200;
  f.upstream.document.body = document({ engine: "agent-task", pinning: true });
  await f.proxy.command({
    type: "connection-capabilities",
    connectionId: connection.id,
  });
  const route = f.route(connection.id, "external/model");
  expect(route.remotePin).toBeNull();
  expect(f.proxy.view().capabilities[route.id].tools.evidence).toBe("unknown");
});

async function pinned(script: Script) {
  const f = await service(script);
  const connection = await f.add();
  f.upstream.document.status = 200;
  f.upstream.document.body = document({ pinning: true });
  await f.proxy.command({
    type: "connection-capabilities",
    connectionId: connection.id,
  });
  const route = f.route(connection.id, "external/model");
  expect(route.remotePin?.routeRevision).toBe("route_review_3");
  return { ...f, connection, route };
}
const echo = { "x-gateway-route-revision": "route_review_3" };

test("a pinned route sends its remote revision and accepts only answers that echo it", async () => {
  const f = await pinned((_call, index) => ({
    headers: echo,
    events: answer(
      index === 0
        ? [{ tool: "read_file", args: { path: "README.md" } }]
        : [{ text: "Done." }],
    ),
  }));
  const started = await f.start({
    routeAlias: "external/model",
    prompt: "Read README",
    mode: "investigate",
  });
  expect((await f.settle(started.attemptId)).state).toBe("completed");
  expect(
    f.upstream.calls.map((c) => c.headers["x-gateway-route-revision"]),
  ).toEqual(["route_review_3", "route_review_3"]);
});

for (const [name, headers] of [
  ["a missing", {}],
  ["a different", { "x-gateway-route-revision": "route_review_4" }],
] as Array<[string, Record<string, string>]>)
  test(`${name} revision echo delivers no tool call to the harness and is not replayed`, async () => {
    const f = await pinned(() => ({
      headers,
      events: answer([{ tool: "read_file", args: { path: "README.md" } }]),
    }));
    const started = await f.start({
      routeAlias: "external/model",
      prompt: "Read README",
      mode: "investigate",
    });
    const final = await f.settle(started.attemptId);
    expect(final.state).toBe("failed");
    expect(final.stateDetail).toContain("may already have run the request");
    expect(f.upstream.calls).toHaveLength(1);
    const kinds = f.harness
      .events(started.attemptId, 0, 200)
      .events.map((e: any) => e.kind);
    expect(kinds).not.toContain("tool-intended");
    expect(kinds).not.toContain("tool-result");
  });

test("a 409 from the service is surfaced without fetching a new revision or replaying", async () => {
  const f = await pinned(() => ({
    status: 409,
    body: { error: { message: "route revision mismatch" } },
  }));
  const documents = f.upstream.document.requests.length;
  const started = await f.start({
    routeAlias: "external/model",
    prompt: "Read README",
    mode: "investigate",
  });
  const final = await f.settle(started.attemptId);
  expect(final.state).toBe("failed");
  expect(final.stateDetail).toContain("refused pinned route revision");
  expect(f.upstream.calls).toHaveLength(1);
  expect(f.upstream.document.requests.length).toBe(documents);
});

test("a metadata outage keeps the pin, and a new remote revision stops a bound task before dispatch", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const f = await pinned((_call, index) => ({
    headers: echo,
    hold: index === 0 ? hold : undefined,
    events: answer(
      index === 0
        ? [{ tool: "read_file", args: { path: "README.md" } }]
        : [{ text: "Done." }],
    ),
  }));
  const revision = f.route.revision;
  for (const status of [500, 404]) {
    f.upstream.document.status = status;
    await f.proxy.command({
      type: "connection-capabilities",
      connectionId: f.connection.id,
    });
    expect(f.proxy.registry.route(f.route.id)).toMatchObject({
      revision,
      remotePin: { routeRevision: "route_review_3" },
    });
  }
  const started = await f.start({
    routeAlias: "external/model",
    prompt: "Read README",
    mode: "investigate",
  });
  await expect.poll(() => f.upstream.calls.length).toBe(1);
  // The service publishes a new route revision while the task's first
  // request is in flight.
  f.upstream.document.status = 200;
  f.upstream.document.body = document({
    pinning: true,
    revision: "route_review_4",
  });
  await f.proxy.command({
    type: "connection-capabilities",
    connectionId: f.connection.id,
  });
  release();
  const final = await f.settle(started.attemptId);
  expect(final.state).toBe("failed");
  expect(final.stateDetail).toContain("route changed");
  // The second request was refused by Topsl's proxy, not sent.
  expect(f.upstream.calls).toHaveLength(1);
});
