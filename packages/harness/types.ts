import type {
  CanonicalOutputFormat,
  CanonicalPart,
  CanonicalUsage,
  ClientProtocol,
  FinishReason,
  ProxyErrorInfo,
} from "../proxy/canonical";
import type { ConnectionKind, FundingKind } from "../proxy/types";

/**
 * Native harness records (docs/Native_Harness_Plan.md §2–§3).
 */

/** Which engine runs an attempt. Only vendor engines need an installation. */
export type ExecutionEngine = "native" | "codex" | "claude-code";

/**
 * Everything an attempt is bound to, frozen when it starts. Switching
 * account, model, funding or engine makes a new attempt from a safe
 * checkpoint; nothing here changes in place.
 */
export interface ExecutionBinding {
  id: string;
  engine: ExecutionEngine;
  native: {
    routeId: string;
    routeAlias: string;
    routeRevision: string;
    connectionId: string;
    connectionKind: ConnectionKind;
    connectionLabel: string;
    protocol: ClientProtocol;
    upstreamModel: string;
    funding: FundingKind;
    accountKey: string | null;
    /** Routes with the same owner share one allowance; null when unknown. */
    quotaOwner: string | null;
  } | null;
  vendor: {
    installationId: string;
    installationRevision: string;
    executableIdentity: string;
  } | null;
  model: {
    reasoningEffort: string | null;
    contextWindowTokens: number;
  };
  /** Hash of the grants and limits the attempt runs under. */
  policyRevision: string;
  createdAt: string;
}

/**
 * What a member turn's native attempt belongs to. The orchestration driver
 * prepares its copy and captures its candidate; the harness does neither.
 */
export interface NativeMemberContext {
  goalId: string;
  roundId: string;
  memberId: string;
  launchId: string;
  purpose: string;
  /** The output protocol's kind and stage, for the record. */
  protocol: string;
}

export interface NativeLimits {
  /** Model requests per attempt, including retries and compaction. */
  maxRequests: number;
  /** Automatic transient retries of one request, on the same route. */
  maxTransientRetries: number;
  /** Pause after this many consecutive repetitions of one failed operation with no relevant change. */
  repetitionPause: number;
  maxConcurrentReads: number;
  /** Default tool deadline; explicitly configured check timeouts take precedence. */
  toolTimeoutMs: number;
  /** Compact when the compiled context passes this share of the window. */
  compactAt: number;
  /** Tool calls the model may make in one response. */
  maxToolCallsPerResponse: number;
}

export const defaultLimits: NativeLimits = {
  maxRequests: 50,
  maxTransientRetries: 2,
  repetitionPause: 3,
  maxConcurrentReads: 4,
  toolTimeoutMs: 120_000,
  compactAt: 0.8,
  maxToolCallsPerResponse: 32,
};

/** Delegation bounds, further constrained by the root's request budget. */
export const delegationLimits = {
  maxDepth: 2,
  maxActiveDescendants: 4,
} as const;

export type ToolEffect =
  "read" | "mutation" | "process" | "delegation" | "control";

/** What an attempt may do. */
export interface ToolGrants {
  /** Whether workspace edits are allowed (an edit task) or not (an investigation). */
  write: boolean;
  /** Whether contained processes may run. */
  processes: boolean;
  /** Network destinations granted to contained processes. */
  networkDomains: string[];
  /** Checks the attempt may run by name, with their own timeouts. */
  checks: Array<{ name: string; argv: string[]; timeoutMs: number }>;
  delegation: boolean;
  /** Admitted MCP servers' tools, by namespaced tool name. */
  mcpTools: string[];
  /** Candidate IDs the attempt may read besides its own workspace. */
  candidates: string[];
}

export type NativeAttemptState =
  | "starting"
  | "running"
  | "waiting-model"
  | "running-tools"
  | "waiting-children"
  | "waiting-quota"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

export const terminalStates: ReadonlySet<NativeAttemptState> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Journal event bodies, by kind. */
export interface JournalBodies {
  "attempt-started": {
    title: string;
    prompt: string;
    /** The JSON Schema every step asks the final text to follow; absent: free text. */
    outputFormat?: CanonicalOutputFormat | null;
    /** Set for a coordinator, session or loop member turn. */
    member?: NativeMemberContext | null;
    binding: ExecutionBinding;
    limits: NativeLimits;
    grants: ToolGrants;
    workspace: {
      root: string;
      identity: string;
      writable: boolean;
      baselineCandidateId: string | null;
    };
    parentAttemptId: string | null;
    rootAttemptId: string;
    depth: number;
    delegationMode: DelegationMode | null;
  };
  "input-claimed": { inputIds: string[]; texts: string[] };
  steering: { id: string; text: string };
  "request-frozen": {
    requestNumber: number;
    purpose: "step" | "compaction";
    retryOf: number | null;
    manifestHash: string;
    toolsHash: string;
    estimatedInputTokens: number;
    correlationId: string;
  };
  "response-settled": {
    requestNumber: number;
    output: CanonicalPart[];
    finish: FinishReason | null;
    error: ProxyErrorInfo | null;
    usage: CanonicalUsage;
    reportedModel: string | null;
  };
  "tool-intended": {
    callId: string;
    tool: string;
    effect: ToolEffect;
    arguments: unknown;
    argumentsHash: string;
    implementationRevision: string;
    /** For an edit, the file hashes it expects before and will produce after. */
    expectation: Record<string, unknown> | null;
  };
  "tool-result": {
    callId: string;
    ok: boolean;
    output: string;
    outputHash: string;
    /** Owned blob holding the full output when the inline text was bounded. */
    outputBlob: string | null;
    evidence: Record<string, unknown> | null;
    durationMs: number;
  };
  "tool-uncertain": { callId: string; reason: string };
  reconciled: {
    callId: string;
    outcome: "applied" | "not-applied" | "uncertain";
    detail: string;
  };
  compaction: {
    capsuleHash: string;
    summary: string;
    throughSequence: number;
    rangeHash: string;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
  };
  checkpoint: { label: string; candidateId: string | null };
  paused: {
    reason: string;
    kind: "owner" | "repetition" | "budget" | "quota" | "uncertain" | "restart";
  };
  resumed: { generation: number };
  "child-started": {
    callId: string;
    childAttemptId: string;
    mode: DelegationMode;
    task: string;
  };
  "child-finished": {
    childAttemptId: string;
    state: NativeAttemptState;
    summary: string;
    candidateId: string | null;
  };
  submitted: { summary: string; candidateId: string | null };
  finished: { state: "completed" | "failed" | "cancelled"; detail: string };
}
export type JournalKind = keyof JournalBodies;
export interface JournalEvent<K extends JournalKind = JournalKind> {
  attemptId: string;
  sequence: number;
  generation: number;
  kind: K;
  body: JournalBodies[K];
  hash: string;
  createdAt: string;
}

export type DelegationMode = "fresh" | "task-package" | "fork";

/** The read model of one attempt, advanced with its journal. */
export interface NativeAttemptView {
  attemptId: string;
  projectId: string;
  rootAttemptId: string;
  parentAttemptId: string | null;
  depth: number;
  title: string;
  state: NativeAttemptState;
  stateDetail: string | null;
  generation: number;
  throughSequence: number;
  binding: ExecutionBinding;
  writable: boolean;
  requests: number;
  toolCalls: number;
  compactions: number;
  usage: CanonicalUsage & { unknownRequests: number };
  lastText: string;
  candidateId: string | null;
  summary: string | null;
  children: string[];
  pendingSteering: number;
  /**
   * Why a paused attempt paused, while it is paused. Absent in projections
   * written before 5 November 2026's member-engine work.
   */
  pauseKind?: JournalBodies["paused"]["kind"] | null;
  /** The model the upstream reported for the latest settled answer. */
  reportedModel?: string | null;
  createdAt: string;
  updatedAt: string;
}
