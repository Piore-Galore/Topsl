import type { ClientProtocol, ProxyErrorInfo } from "./canonical";

/**
 * Connection, route and receipt records (docs/Native_Harness_Plan.md §2).
 * The proxy is their only writer; the control service and renderer see the
 * sanitized forms below and never a credential.
 */

/** What kind of upstream a connection reaches. */
export type ConnectionKind =
  | "chatgpt-plan"
  | "claude-plan"
  | "openai-api"
  | "anthropic-api"
  | "openai-compatible"
  | "ollama";

/**
 * Who pays. Distinct funding kinds are never merged, and the proxy never
 * moves a request from one to another.
 */
export type FundingKind = "subscription" | "api-billing" | "gateway" | "local";

export type AuthenticationKind =
  "oauth-chatgpt" | "oauth-claude" | "api-key" | "none";

export const connectionFunding: Record<ConnectionKind, FundingKind> = {
  "chatgpt-plan": "subscription",
  "claude-plan": "subscription",
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
  "claude-plan": "oauth-claude",
  "openai-api": "api-key",
  "anthropic-api": "api-key",
  "openai-compatible": "api-key",
  ollama: "none",
};

/** The protocol each connection kind speaks upstream. */
export const upstreamProtocol: Record<ConnectionKind, ClientProtocol> = {
  "chatgpt-plan": "responses",
  "claude-plan": "messages",
  "openai-api": "responses",
  "anthropic-api": "messages",
  "openai-compatible": "chat",
  ollama: "chat",
};

export const defaultEndpoints: Record<ConnectionKind, string | null> = {
  "chatgpt-plan": "https://api.openai.com/v1",
  "claude-plan": "https://api.anthropic.com/v1",
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
  /** The model catalog entry or document the evidence came from. */
  source: string;
  observedAt: string | null;
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
  /** Changes whenever anything above changes; native requests quote it. */
  revision: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
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
