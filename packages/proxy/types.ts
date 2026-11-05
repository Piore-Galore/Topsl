import type { ClientProtocol, ProxyErrorInfo } from "./canonical";

/**
 * Connection, route and receipt records (docs/Native_Harness_Plan.md §2).
 * The proxy is their only writer; the control service and renderer see the
 * sanitized forms below and never a credential.
 */

/**
 * What kind of upstream a connection reaches. `openai-compatible` is shown
 * as an **External model service**: a separately operated service reached by
 * a standard inference protocol. Its stored identifier is unchanged.
 */
export type ConnectionKind =
  | "chatgpt-plan"
  | "openai-api"
  | "anthropic-api"
  | "openai-compatible"
  | "ollama";

export const connectionKinds: readonly ConnectionKind[] = [
  "chatgpt-plan",
  "openai-api",
  "anthropic-api",
  "openai-compatible",
  "ollama",
];
export function isConnectionKind(value: unknown): value is ConnectionKind {
  return connectionKinds.includes(value as ConnectionKind);
}

/**
 * Connection kinds Topsl no longer creates or dispatches. Records of them are
 * kept only so old receipts and frozen task bindings still read; nothing
 * here can authenticate or send a request.
 */
export type RetiredConnectionKind = "claude-plan";

/** Why the direct Claude subscription connection was retired. */
export const CLAUDE_PLAN_RETIREMENT_REASON =
  "Direct Claude subscription sign-in was removed from Topsl on 5 November 2026. Anthropic's terms do not permit a third-party application to sign in to a Claude plan or send requests with its credentials. Use Claude Code (Providers) for Claude-plan work, or an Anthropic API key here.";

/**
 * Who pays. Distinct funding kinds are never merged, and the proxy never
 * moves a request from one to another.
 */
export type FundingKind = "subscription" | "api-billing" | "gateway" | "local";

export type AuthenticationKind = "oauth-chatgpt" | "api-key" | "none";

/**
 * How an external model service's access key is sent. `none` is allowed only
 * for a service on this computer that the owner chose to reach without a key.
 */
export type ServiceAuthentication = "bearer" | "x-api-key" | "none";

export const connectionFunding: Record<ConnectionKind, FundingKind> = {
  "chatgpt-plan": "subscription",
  "openai-api": "api-billing",
  "anthropic-api": "api-billing",
  "openai-compatible": "gateway",
  ollama: "local",
};

export const connectionAuthentication: Record<
  ConnectionKind,
  AuthenticationKind
> = {
  "chatgpt-plan": "oauth-chatgpt",
  "openai-api": "api-key",
  "anthropic-api": "api-key",
  "openai-compatible": "api-key",
  ollama: "none",
};

/** The protocol each connection kind speaks upstream. */
export const upstreamProtocol: Record<ConnectionKind, ClientProtocol> = {
  "chatgpt-plan": "responses",
  "openai-api": "responses",
  "anthropic-api": "messages",
  "openai-compatible": "chat",
  ollama: "chat",
};

export const defaultEndpoints: Record<ConnectionKind, string | null> = {
  "chatgpt-plan": "https://api.openai.com/v1",
  "openai-api": "https://api.openai.com/v1",
  "anthropic-api": "https://api.anthropic.com/v1",
  "openai-compatible": null,
  ollama: "http://127.0.0.1:11434/v1",
};

export type ConnectionState =
  | "signed-out"
  | "ready"
  | "plan-use-disabled"
  | "reauthorization-required"
  | "paused-usage-limit"
  | "unavailable"
  | "disconnected";

/** Account or workspace evidence, as the upstream established it. */
export interface AccountEvidence {
  /** A stable identity: the validated `sub` with the issued client ID, or a key fingerprint. */
  accountKey: string | null;
  email: string | null;
  /** How the identity was established. */
  source:
    "id-token" | "oauth-profile" | "api-key-fingerprint" | "endpoint" | "none";
  /** An allowance shared with other connections, when the evidence shows one. */
  quotaOwner: string | null;
  observedAt: string | null;
}

export interface Connection {
  id: string;
  kind: ConnectionKind;
  label: string;
  endpoint: string;
  /** Configurable for gateways; absent on older profiles means the kind's default. */
  protocol?: ClientProtocol;
  authentication: AuthenticationKind;
  /**
   * External model services only: how the key is sent. Absent on older
   * profiles means `bearer`. Fixed when the connection is created, like the
   * endpoint and protocol, so a binding can never silently follow a change.
   */
  serviceAuth?: ServiceAuthentication;
  /** External model services only: what Topsl last read from the optional capability document. */
  manifest?: ServiceManifestStatus;
  funding: FundingKind;
  state: ConnectionState;
  stateDetail: string | null;
  account: AccountEvidence;
  /** Whether a credential is stored; never the credential. */
  hasCredential: boolean;
  /** Whether disconnecting can revoke the credential at the provider. */
  revocation: "supported" | "not-supported" | "not-applicable";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** What Topsl observed a route can carry, with where that came from. */
export interface CapabilityEvidence {
  tools: "supported" | "unsupported" | "unknown";
  images: "supported" | "unsupported" | "unknown";
  reasoning: "supported" | "unsupported" | "unknown";
  outputCap: "supported" | "unsupported" | "unknown";
  /**
   * Whether the route enforces a JSON Schema on the final text. Absent on
   * routes saved before 5 November 2026, which reads as unknown. A route
   * recorded as unsupported is refused for turns that need a schema.
   */
  structuredOutput?: "supported" | "unsupported" | "unknown";
  /** The model catalog entry or document the evidence came from. */
  source: string;
  observedAt: string | null;
}

/**
 * Capabilities whose evidence Topsl records per route. A service's
 * declaration is never a probe result, and evidence recorded under one
 * configuration says nothing about another.
 */
export type CapabilityName =
  | "streaming"
  | "tools"
  | "parallelTools"
  | "images"
  | "reasoning"
  | "structuredOutput";
export const capabilityNames: readonly CapabilityName[] = [
  "streaming",
  "tools",
  "parallelTools",
  "images",
  "reasoning",
  "structuredOutput",
];

export interface CapabilityObservation {
  value: "supported" | "unsupported";
  /** `declared`: the service said so. `probed`: Topsl's connection test saw it. */
  evidence: "declared" | "probed";
  /** Which document or test produced it. */
  source: string;
  model: string;
  protocol: ClientProtocol;
  /** The route configuration it was observed under (`capabilityConfiguration`). */
  configuration: string;
  observedAt: string;
}

/** A route's evidence for one capability, as currently applicable. */
export interface EffectiveCapability {
  value: "supported" | "unsupported" | "unknown";
  evidence: "declared" | "probed" | "unknown" | "stale";
  observation: CapabilityObservation | null;
}

/**
 * The remote route revision an external service declared, frozen into the
 * route when the service supports pinning. Requests carry it as
 * `X-Gateway-Route-Revision`, and an answer must echo it.
 */
export interface RemoteRoutePin {
  gatewayId: string;
  routeId: string;
  routeRevision: string;
}

/** One route an external service's capability document lists (sanitized). */
export interface ServiceManifestRoute {
  id: string;
  model: string;
  routeRevision: string | null;
  engine: string;
  protocols: Array<{
    name: string;
    capabilities: Partial<Record<CapabilityName, "supported" | "unsupported" | "unknown">>;
  }>;
  pinning: boolean;
}

export interface ServiceManifestStatus {
  /** `absent`: 404/501. `unrecognized`: malformed or a future schema version. */
  state: "read" | "absent" | "unrecognized" | "unavailable";
  checkedAt: string;
  detail: string | null;
  gatewayId: string | null;
  revision: string | null;
  routes: ServiceManifestRoute[];
}

export interface ProxyRoute {
  id: string;
  connectionId: string;
  /** The model the upstream is asked for. */
  upstreamModel: string;
  /** The client-facing name; unique across all routes. */
  alias: string;
  /** The upstream protocol. */
  protocol: ClientProtocol;
  /** Serializer and stream-reader revision for this kind of connection. */
  adapterRevision: string;
  capabilities: CapabilityEvidence;
  /** Declared and probed observations; absent on routes saved before 5 November 2026. */
  evidence?: Partial<Record<CapabilityName, CapabilityObservation>>;
  /** External model services that support pinning: the remote revision this route froze. */
  remotePin?: RemoteRoutePin | null;
  /** Changes whenever anything above changes; native requests quote it. */
  revision: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A history-only record of a connection Topsl no longer supports. It keeps
 * what old receipts and frozen bindings need to be explained and nothing
 * that could authenticate: its credential was deleted when it was retired.
 */
export interface RetiredConnection {
  id: string;
  kind: RetiredConnectionKind;
  label: string;
  endpoint: string;
  funding: FundingKind;
  /** The authentication it used, for the record. */
  authentication: string;
  account: AccountEvidence;
  createdAt: string;
  retiredAt: string;
  reason: string;
}

/** A route of a retired connection. Its alias stays reserved, so it can never name another connection. */
export interface RetiredRoute {
  id: string;
  connectionId: string;
  alias: string;
  upstreamModel: string;
  protocol: ClientProtocol;
  /** The revision bindings froze; a request quoting it is refused as retired. */
  revision: string;
  retiredAt: string;
  reason: string;
}

export type ReceiptOutcome =
  | "completed"
  | "incomplete"
  | "failed"
  | "rejected"
  | "interrupted"
  | "cancelled";

export interface RequestReceipt {
  id: string;
  /** The harness's request or attempt correlation ID, when it sent one. */
  correlationId: string | null;
  attemptId: string | null;
  routeId: string | null;
  routeRevision: string | null;
  connectionId: string | null;
  accountKey: string | null;
  funding: FundingKind | null;
  clientProtocol: ClientProtocol;
  upstreamProtocol: ClientProtocol | null;
  requestedModel: string;
  upstreamModel: string | null;
  reportedModel: string | null;
  outcome: ReceiptOutcome;
  error: ProxyErrorInfo | null;
  usage: {
    input: number | null;
    output: number | null;
    cachedInput: number | null;
    reasoning: number | null;
  };
  upstreamRequestId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** The route identity a native request freezes, sent as headers. */
export const routeHeaders = {
  correlation: "x-topsl-correlation-id",
  attempt: "x-topsl-attempt-id",
  routeRevision: "x-topsl-route-revision",
} as const;

/**
 * The optional remote pinning extension of an external model service: Topsl
 * sends the frozen remote revision, and the service must refuse a mismatch
 * with HTTP 409 before dispatch and echo the revision on accepted answers.
 */
export const gatewayRouteRevisionHeader = "x-gateway-route-revision";
