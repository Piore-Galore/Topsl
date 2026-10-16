import type {
  ApprovalSummary,
  Installation,
  Provider,
  ReportedPermissions,
} from "../domain/types";
import type { CodexApprovalPolicy } from "../domain/chat-presets";
import type { Evidence } from "../domain/workflow";
import type { ProcessEvidence } from "../runtime/process-lifecycle";
export interface ProviderConnection {
  process: { pid?: number; once(event: "exit", callback: () => void): unknown };
  onNotification: (method: string, params: unknown) => void;
  onRequest: (id: string | number, method: string, params: unknown) => void;
  onExit: (detail: string) => void;
  initialize(): Promise<unknown>;
  request(method: string, params: unknown, timeout?: number): Promise<unknown>;
  reply(id: string | number, value: unknown): void;
  reject(id: string | number, message: string): void;
  close(): Promise<ProcessEvidence>;
}
export interface ProviderCapability {
  name: string;
  route: "structured" | "native-terminal" | "native-ui";
  support:
    | "enforceable"
    | "observable-only"
    | "native-only"
    | "unsupported"
    | "unknown";
  versions: string[];
  testedPlatforms: string[];
  restrictions: string[];
  evidence: Evidence;
}
export interface ProviderModel {
  id: string;
  model: string;
  name: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string | null;
  inputModalities?: string[];
  metadataSource?: "runtime" | "unknown";
  observedAt?: string;
}
export interface InstructionSourceObservation {
  path: string;
  source: "runtime-reported";
  observedAt: string;
  contentHash: null;
}
/** A tool that Topsl declares to a runtime and answers itself. */
export interface ProviderTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}
/** Tools declared together under one namespace. */
export interface ProviderToolset {
  namespace: string;
  description: string;
  tools: ProviderTool[];
}
/** A runtime's request to run one declared tool. */
export interface ProviderToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}
export interface ProviderToolResult {
  text: string;
  success: boolean;
}
/** The tools for one attempt, and the handler that answers their calls. */
export interface ToolBinding {
  toolset: ProviderToolset;
  call(call: ProviderToolCall): Promise<ProviderToolResult>;
}
export interface PreparedTurn {
  requestedEffort?: string;
  outputSchema?: Record<string, unknown>;
  /** Topsl's own tools, declared only when a fresh review session starts. */
  toolset?: ProviderToolset;
  prompt: string;
  cwd: string;
  requestedModel: string;
  mode: "review" | "edit";
  /** Codex's approval policy for the session and its turns; `untrusted`
   * unless the owner chose another chat preset. */
  approvalPolicy?: CodexApprovalPolicy;
  contextPackageId: string | null;
  attemptId: string;
  workspaceIdentity: string;
}
export interface ProviderAccount {
  accountKey: string;
  profileId: string;
  billingRoute: "native-subscription" | "api-key" | "cloud-provider";
  sanitized: { type: string; email: string | null; planType: string | null };
}
/** The permissions Topsl asked for when a session started or resumed, and
 * what the runtime reported it adopted. */
export interface SessionPermissions {
  requested: {
    approvalPolicy: string;
    approvalsReviewer: string;
    sandbox: string;
  };
  reported: ReportedPermissions;
  /** Each way the report differs from the request, in words; empty when they agree. */
  differences: string[];
}
export interface SessionResult {
  /** Absent when the runtime does not report the permissions it adopted. */
  permissions?: SessionPermissions;
  nativeThreadId?: string;
  providerSessionId?: string | null;
  instructionSources?: InstructionSourceObservation[];
  reportedEffort?: string | null;
  nativeSessionId: string;
  reportedModel: string | null;
  evidence: Evidence;
}
export type ProviderEvent =
  | {
      type: "turn-started";
      threadId: string | null;
      turnId: string;
      reportedModel?: string | null;
    }
  | {
      type: "message-delta";
      threadId: string | null;
      turnId: string | null;
      itemId: string;
      text: string;
    }
  | {
      type: "message";
      threadId: string | null;
      turnId: string | null;
      itemId: string;
      role: "assistant" | "tool";
      text: string;
    }
  | {
      type: "usage";
      threadId: string | null;
      turnId: string | null;
      input: number | null;
      output: number | null;
      cached: number | null;
    }
  | {
      type: "completed";
      threadId: string | null;
      turnId: string | null;
      status: "completed" | "interrupted" | "failed";
      error: string | null;
    };
export interface ProviderApproval {
  threadId: string;
  turnId: string;
  method: string;
  params: unknown;
  description: string;
  summary?: ApprovalSummary;
  /** What the request is about that an earlier notification reported, such
   * as the files of a change. Topsl binds it into the approval's digest. */
  subject?: unknown;
}
/** An item a notification started, which a later approval request may name. */
export interface StartedItem {
  threadId: string;
  turnId: string;
  id: string;
  item: unknown;
}
export interface ProviderAdapter {
  provider: Provider;
  capabilities(installation: Installation): ProviderCapability[];
  connect(executable: string, cwd: string): ProviderConnection;
  inspect(connection: ProviderConnection): Promise<{
    models: ProviderModel[];
    account: ProviderAccount["sanitized"] | null;
    info: { platformFamily: string | null; platformOs: string | null };
  }>;
  account(
    connection: ProviderConnection,
    installation: Installation,
  ): Promise<ProviderAccount>;
  startSession(
    connection: ProviderConnection,
    turn: PreparedTurn,
    nativeSessionId: string | null,
  ): Promise<SessionResult>;
  startTurn(
    connection: ProviderConnection,
    turn: PreparedTurn,
    nativeSessionId: string,
  ): Promise<{
    nativeTurnId: string | null;
    reportedModel: string | null;
    reportedEffort?: string | null;
  }>;
  interrupt(
    connection: ProviderConnection,
    sessionId: string,
    turnId: string,
  ): Promise<void>;
  event(method: string, payload: unknown): ProviderEvent | null;
  /** Reads a native approval request. `item` returns what an earlier
   * notification reported about an item the request names. */
  approval(
    method: string,
    payload: unknown,
    item?: (id: string) => unknown,
  ): ProviderApproval | null;
  /** The item a notification starts, when an approval request may later name
   * it. Absent when requests describe themselves. */
  startedItem?(method: string, payload: unknown): StartedItem | null;
  /** Reads a runtime request as a call to a tool Topsl declared, or returns
   * null for any other request. Absent when the runtime cannot call tools. */
  toolCall?(method: string, payload: unknown): ProviderToolCall | null;
  /** The response that returns a tool result to the runtime. */
  toolResult?(result: ProviderToolResult): unknown;
  /** Runs one command in the runtime's own sandbox, under the policy a turn
   * in `mode` gets, with no thread, turn or model. The runtime qualification
   * uses it to try writes the sandbox must block. Absent when the runtime
   * cannot run a command this way. */
  sandboxCommand?(
    connection: ProviderConnection,
    command: { argv: string[]; cwd: string; mode: "review" | "edit" },
  ): Promise<SandboxCommandResult>;
}
export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
