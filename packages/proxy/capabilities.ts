import { createHash } from "node:crypto";
import { z } from "zod";
import type { CanonicalRequest } from "./canonical";
import {
  capabilityNames,
  type CapabilityName,
  type CapabilityObservation,
  type Connection,
  type EffectiveCapability,
  type ProxyRoute,
  type RemoteRoutePin,
  type ServiceManifestRoute,
  type ServiceManifestStatus,
} from "./types";

/**
 * Capability evidence for routes, and the optional capability document an
 * external model service may publish (docs/Native_Harness_Plan.md §1.3).
 *
 * Three levels are kept apart: **unknown** (nothing observed), **declared**
 * (the service's document says so) and **probed** (Topsl's explicit
 * connection test saw it). Each observation records the route configuration
 * it was made under; once that changes, the observation reads as stale.
 */

/** The configuration capability evidence is valid for. Never includes a secret. */
export function capabilityConfiguration(
  route: Pick<
    ProxyRoute,
    "connectionId" | "upstreamModel" | "protocol" | "adapterRevision"
  > & { remotePin?: RemoteRoutePin | null },
  connection: Pick<Connection, "endpoint" | "serviceAuth" | "account">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        route.connectionId,
        connection.endpoint,
        route.protocol,
        connection.serviceAuth ?? null,
        route.upstreamModel,
        route.adapterRevision,
        connection.account.accountKey,
        route.remotePin?.routeRevision ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/** The applicable evidence for one capability of a route. */
export function effectiveCapability(
  route: ProxyRoute,
  connection: Connection,
  name: CapabilityName,
): EffectiveCapability {
  const observation = route.evidence?.[name] ?? null;
  if (!observation)
    return { value: "unknown", evidence: "unknown", observation: null };
  if (observation.configuration !== capabilityConfiguration(route, connection))
    return { value: "unknown", evidence: "stale", observation };
  return {
    value: observation.value,
    evidence: observation.evidence,
    observation,
  };
}

export function effectiveCapabilities(
  route: ProxyRoute,
  connection: Connection,
): Record<CapabilityName, EffectiveCapability> {
  return Object.fromEntries(
    capabilityNames.map((name) => [
      name,
      effectiveCapability(route, connection, name),
    ]),
  ) as Record<CapabilityName, EffectiveCapability>;
}

/** Document keys → Topsl's capability names. */
const documentKeys: Record<string, CapabilityName> = {
  streaming: "streaming",
  tool_calls: "tools",
  parallel_tool_calls: "parallelTools",
  structured_output: "structuredOutput",
  images: "images",
  reasoning: "reasoning",
};

const value = z
  .enum(["supported", "unsupported", "unknown"])
  .catch("unknown");
const short = z.string().min(1).max(200);
const documentSchema = z.object({
  schema_version: z.literal(1),
  gateway_id: short,
  revision: short,
  routes: z
    .array(
      z.object({
        id: short,
        model: short,
        route_revision: z.string().min(1).max(200).nullable().optional(),
        engine: z.string().min(1).max(64),
        protocols: z
          .array(
            z.object({
              name: z.string().min(1).max(32),
              capabilities: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .max(8),
        extensions: z
          .object({ route_revision_pinning: z.boolean().optional() })
          .passthrough()
          .optional(),
      }),
    )
    .max(500),
});

/** The largest capability document Topsl reads. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/**
 * Interprets a capability document. A missing, malformed or future-version
 * document leaves capabilities unknown; it never disables inference.
 */
export function parseServiceDocument(
  body: string,
  checkedAt = new Date().toISOString(),
): ServiceManifestStatus {
  const status = (
    state: ServiceManifestStatus["state"],
    detail: string,
  ): ServiceManifestStatus => ({
    state,
    checkedAt,
    detail,
    gatewayId: null,
    revision: null,
    routes: [],
  });
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return status("unrecognized", "The capability document is not JSON.");
  }
  if (json?.schema_version !== 1)
    return status(
      "unrecognized",
      `The capability document's schema version (${String(json?.schema_version ?? "none").slice(0, 20)}) is not one Topsl reads.`,
    );
  const parsed = documentSchema.safeParse(json);
  if (!parsed.success)
    return status(
      "unrecognized",
      "The capability document does not match schema version 1.",
    );
  const routes: ServiceManifestRoute[] = parsed.data.routes.map((route) => ({
    id: route.id,
    model: route.model,
    routeRevision: route.route_revision ?? null,
    engine: route.engine,
    protocols: route.protocols.map((protocol) => ({
      name: protocol.name,
      capabilities: Object.fromEntries(
        Object.entries(protocol.capabilities ?? {}).flatMap(([key, raw]) =>
          documentKeys[key] ? [[documentKeys[key], value.parse(raw)]] : [],
        ),
      ),
    })),
    pinning: route.extensions?.route_revision_pinning === true,
  }));
  return {
    state: "read",
    checkedAt,
    detail: null,
    gatewayId: parsed.data.gateway_id,
    revision: parsed.data.revision,
    routes,
  };
}

/**
 * What a read capability document says about one Topsl route: its declared
 * capabilities, the remote revision to pin, or why it does not apply.
 */
export function documentForRoute(
  document: ServiceManifestStatus,
  route: Pick<ProxyRoute, "upstreamModel" | "protocol">,
):
  | { kind: "none" }
  | { kind: "not-model-api"; detail: string }
  | {
      kind: "declared";
      entry: ServiceManifestRoute;
      capabilities: Partial<Record<CapabilityName, "supported" | "unsupported">>;
      pin: RemoteRoutePin | null;
    } {
  if (document.state !== "read") return { kind: "none" };
  const entry = document.routes.find((r) => r.model === route.upstreamModel);
  if (!entry) return { kind: "none" };
  if (entry.engine !== "model-api")
    return {
      kind: "not-model-api",
      detail: `The service lists ${entry.model} as engine "${entry.engine}". Topsl's native harness uses only model-api routes; an agent-task API needs its own executor.`,
    };
  const protocol = entry.protocols.find((p) => p.name === route.protocol);
  if (!protocol) return { kind: "none" };
  const capabilities: Partial<
    Record<CapabilityName, "supported" | "unsupported">
  > = {};
  for (const [name, declared] of Object.entries(protocol.capabilities))
    if (declared === "supported" || declared === "unsupported")
      capabilities[name as CapabilityName] = declared;
  return {
    kind: "declared",
    entry,
    capabilities,
    pin:
      entry.pinning && entry.routeRevision && document.gatewayId
        ? {
            gatewayId: document.gatewayId,
            routeId: entry.id,
            routeRevision: entry.routeRevision,
          }
        : null,
  };
}

/**
 * Merges new observations into a route's evidence. A current probe is never
 * replaced by a declaration; anything else is replaced by newer evidence.
 */
export function mergeEvidence(
  existing: ProxyRoute["evidence"],
  incoming: Partial<Record<CapabilityName, CapabilityObservation>>,
  currentConfiguration: string,
): Partial<Record<CapabilityName, CapabilityObservation>> {
  const next = { ...(existing ?? {}) };
  for (const name of capabilityNames) {
    const observation = incoming[name];
    if (!observation) continue;
    const old = next[name];
    if (
      old?.evidence === "probed" &&
      old.configuration === currentConfiguration &&
      observation.evidence === "declared"
    )
      continue;
    next[name] = observation;
  }
  return next;
}

/** The three requests Topsl's explicit connection test sends, in order. */
export const connectionTestPlan = {
  requests: 3,
  description:
    "a one-word streamed answer, one call to a test tool, and one answer in a small JSON schema",
};

const baseRequest = (model: string): CanonicalRequest => ({
  model,
  instructions: null,
  messages: [],
  tools: [],
  toolChoice: "auto",
  maxOutputTokens: 64,
  temperature: null,
  topP: null,
  stop: [],
  reasoningEffort: null,
  thinkingBudget: null,
  parallelToolCalls: null,
  stream: true,
  outputFormat: null,
  clientProtocol: "chat",
});
const user = (text: string) => ({
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});

export const testTool = {
  name: "topsl_connection_test",
  description: "Records the value Topsl's connection test asks for.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};
export const testSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

export function connectionTestRequests(model: string): {
  streaming: CanonicalRequest;
  tools: CanonicalRequest;
  structuredOutput: CanonicalRequest;
} {
  return {
    streaming: {
      ...baseRequest(model),
      messages: [user("Reply with the single word: ready")],
    },
    tools: {
      ...baseRequest(model),
      messages: [
        user(
          `Call the ${testTool.name} tool once with value "probe". Do not answer in text.`,
        ),
      ],
      tools: [testTool],
      toolChoice: { name: testTool.name },
    },
    structuredOutput: {
      ...baseRequest(model),
      messages: [user('Answer with {"ok": true}.')],
      outputFormat: { name: "topsl_connection_test", schema: testSchema, strict: true },
    },
  };
}

function describe(
  alias: string,
  what: string,
  capability: EffectiveCapability,
): string {
  if (capability.evidence === "stale")
    return `${alias}'s ${what} evidence is from an earlier configuration.`;
  if (capability.value === "unsupported")
    return capability.evidence === "probed"
      ? `${alias} failed Topsl's ${what} test.`
      : `${alias}'s service declares no ${what}.`;
  if (capability.evidence === "declared")
    return `${alias}'s ${what} is declared by the service but not tested by Topsl.`;
  return `${alias} has no evidence of ${what}.`;
}

/**
 * What keeps a route from serving a native member turn, as `code: detail`
 * lines. Member turns always use tools. On an external model service, whose
 * upstream Topsl cannot see, both tool calls and (for a turn that answers in
 * a schema) structured output need Topsl's own test; a declaration is not
 * enough. Other routes are refused only on evidence that they cannot carry
 * a schema. Answers are validated in every case.
 */
export function memberCapabilityBlockers(
  route: ProxyRoute,
  connection: Connection,
  needsSchema: boolean,
): string[] {
  const blockers: string[] = [];
  const structured = effectiveCapability(route, connection, "structuredOutput");
  if (connection.kind === "openai-compatible") {
    const tools = effectiveCapability(route, connection, "tools");
    if (!(tools.value === "supported" && tools.evidence === "probed"))
      blockers.push(
        `tools-not-verified: ${describe(route.alias, "tool calling", tools)} Member turns use tools; choose Test route under Connections.`,
      );
    if (
      needsSchema &&
      !(structured.value === "supported" && structured.evidence === "probed")
    )
      blockers.push(
        `structured-output-not-verified: ${describe(route.alias, "structured output", structured)} This turn answers in a schema; choose Test route under Connections.`,
      );
  } else if (needsSchema && structured.value === "unsupported")
    blockers.push(
      `structured-output-unsupported: ${describe(route.alias, "structured output", structured)} This turn answers in a schema.`,
    );
  return blockers;
}
