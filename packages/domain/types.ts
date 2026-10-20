import type { AllowanceSnapshot, ProviderBudgetStatus } from "./allowance";
import type { TerminalModeId } from "./terminal-modes";
import type { ChatPresetBlock, CodexApprovalPolicy } from "./chat-presets";
import type { AutoAcceptLevel } from "./auto-accept";
import type { ClaudeRouteDecision } from "./claude-route";
export type Provider = "codex" | "claude";
export type Theme = "paper" | "night" | "system";
export type AppId =
  | "openai.codex-cli"
  | "openai.desktop"
  | "anthropic.claude-code-cli"
  | "anthropic.claude-desktop";
export interface ApplicationDefinition {
  id: AppId;
  name: string;
  kind: "cli" | "desktop";
  provider: Provider | null;
  description: string;
  website: string;
  docs: string;
  releaseNotes: string;
  platforms: string[];
}
export interface Installation {
  id: string;
  appId: AppId;
  hostId: string;
  path: string;
  realPath: string;
  version: string | null;
  revisionId: string;
  identity: string;
  managementUnitId: string;
  owner: "homebrew" | "npm" | "vendor" | "desktop" | "system" | "unknown";
  packageId: string | null;
  channel: string;
  nativeAutoUpdates: "enabled" | "disabled" | "unknown";
  trusted: boolean;
  compatibility: "unverified" | "compatible" | "native-only" | "incompatible";
  runningPids?: number[] | null;
}
export interface ApplicationRelease {
  version: string;
  url: string;
  sha256: string | null;
  size: number | null;
  source: string;
  artifactName: string;
}
export type Release = ApplicationRelease;
export interface UpdateCheck {
  installationId: string;
  status: "available" | "current" | "unknown" | "native-required";
  release: Release | null;
  checkedAt: string;
  lastSuccessAt: string | null;
  nextCheckAt: string;
  failures: number;
  detail: string;
}
export interface LifecyclePlan {
  id: string;
  appId: AppId;
  installationId: string | null;
  expectedRevision: string | null;
  action: "download" | "install" | "update";
  route: "download" | "package-manager" | "native";
  managementUnitId: string;
  command: { executable: string; args: string[] } | null;
  executorIdentity: string | null;
  release: Release | null;
  nativeUrl: string | null;
  nativeApplicationPath: string | null;
  installedVersion: string | null;
  effects: string[];
  digest: string;
  createdAt: string;
  expiresAt: string;
}
export interface LifecycleJob {
  id: string;
  planId: string;
  state:
    | "queued"
    | "downloading"
    | "verifying"
    | "waiting-for-idle"
    | "applying"
    | "awaiting-native"
    | "reconciling"
    | "completed"
    | "unchanged"
    | "failed"
    | "cancelled"
    | "uncertain";
  acquiredPath: string | null;
  bytes: number;
  total: number | null;
  actualVersion: string | null;
  detail: string;
  createdAt: string;
  updatedAt: string;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  realPath: string;
  trusted: boolean;
  createdAt: string;
  availability?: "available" | "missing" | "changed";
  sources?: ProjectSourceReference[];
  nameSource?: { sourceId: string; nativeProjectId: string | null };
}
export interface ProjectSourceReference {
  sourceId: string;
  path: string;
  name: string | null;
  nativeProjectId: string | null;
  observedAt: string;
}
export interface ProjectSource {
  id: string;
  name: string;
  appIds: AppId[];
  path: string;
  status: "disabled" | "ready" | "missing" | "error";
  checkedAt: string | null;
  lastSuccessAt: string | null;
  folders: number;
  detail: string;
}
export interface ProjectSyncState {
  enabled: boolean;
  refreshing: boolean;
  sources: ProjectSource[];
}
export interface NativeProject {
  id: string;
  name: string;
  roots: string[];
  position: number;
  revision: string;
}
export interface CodexProjectSyncState {
  enabled: boolean;
  refreshing: boolean;
  installationId: string | null;
  home: string;
  status: "disabled" | "ready" | "error";
  detail: string;
  lastSuccessAt: string | null;
  projects: NativeProject[];
  orderRevision: string;
}
export interface ProjectOpenResult {
  terminalId?: string;
  projectPath: string;
  applicationPath?: string;
  nativeUrl?: string;
  route: "terminal" | "folder-open" | "native-selection" | "claude-folder-link";
  detail: string;
}
export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  nativeSessions: Partial<Record<Provider, string>>;
  nativeAccounts?: Partial<Record<Provider, string>>;
  createdAt: string;
}
export interface Message {
  id: string;
  conversationId: string;
  projectId: string;
  role: "user" | "assistant" | "tool" | "system";
  provider: Provider | null;
  text: string;
  runId: string | null;
  nativeId: string | null;
  createdAt: string;
}
export interface Run {
  id: string;
  conversationId: string;
  projectId: string;
  provider: Provider;
  installationId: string;
  installationRevisionId: string;
  runtimeVersion: string | null;
  executableIdentity: string;
  model: string;
  mode: "review" | "edit" | "native";
  status:
    | "starting"
    | "running"
    | "awaiting-approval"
    | "completed"
    | "failed"
    | "interrupted"
    | "uncertain";
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  error: string | null;
  createdAt: string;
  nativePid?: number;
  nativeAccountKey?: string;
  managementUnitId?: string;
  /** A native terminal's permission mode, and exactly the arguments Topsl passed for it. */
  permissionMode?: TerminalModeId;
  permissionArgs?: string[];
  /** The approval policy Topsl asked Codex for. Runs recorded before the chat presets asked for `untrusted`. */
  approvalPolicy?: CodexApprovalPolicy;
  /** What Codex reported it adopted when the run's thread started or resumed. */
  reportedPermissions?: ReportedPermissions;
  /**
   * The auto-accept level Topsl applied to this Codex turn when it started:
   * Sandboxed sent it with no asking, and Everything lets Topsl allow its
   * requests while the setting stays at Everything. Absent when it applied none.
   */
  autoAccept?: "sandboxed" | "everything";
  /** How many requests auto-accept allowed for this run. */
  autoAllowed?: number;
}
/**
 * The permissions Codex reported in its answer to `thread/start` or
 * `thread/resume`. A value Topsl does not know is kept as reported, cut to 200
 * characters; Codex's granular approval policy is recorded as `granular`, and
 * a field Codex left out as null.
 */
export interface ReportedPermissions {
  approvalPolicy: string | null;
  approvalsReviewer: string | null;
  /** Codex's sandbox policy type, such as `readOnly` or `workspaceWrite`. */
  sandbox: string | null;
}
/** The last ordinary terminal mode the owner chose in a project, per provider. Never a bypass mode. */
export interface TerminalModePreference {
  id: string;
  claude?: TerminalModeId;
  codex?: TerminalModeId;
  updatedAt: string;
}
export interface UsageFact {
  id: string;
  runId: string;
  provider: Provider;
  input: number | null;
  output: number | null;
  cached: number | null;
  source: string;
  scope: string;
  projectId?: string;
  conversationId?: string;
  semantics?: "cumulative" | "delta";
  scopeLevel?: "turn" | "session";
  eventId?: string;
  ordinal?: number;
  cachedIncludedInInput?: boolean;
  sessionId?: string | null;
}
/** What allowing a native approval request does, in plain words. Topsl
 * writes it from the request's fields, so the agent supplies no markup. */
export interface ApprovalSummary {
  /** The action, such as "Run a command". */
  title: string;
  /** Plain-text values, such as the command, its folder or the files. */
  details: Array<{ label: string; value: string }>;
  /** What allowing does, one sentence or two each. */
  effects: string[];
}
export interface Approval {
  id: string;
  runId: string;
  method: string;
  /** The request's fields as JSON. */
  description: string;
  /** Absent on approvals recorded before Topsl described requests. */
  summary?: ApprovalSummary;
  digest: string;
  requestId: number | string;
  createdAt: string;
}
export interface ContextSnapshot {
  id: string;
  conversationId: string;
  projectId: string;
  provider: Provider;
  text: string;
  hash: string;
  sourceMessageIds: string[];
  /** What the handoff limits left out. Snapshots prepared before this field
   * existed have none and never disclosed omissions. */
  omissions?: ContextSnapshotOmissions;
  createdAt: string;
}
export interface ContextSnapshotOmissions {
  /** The conversation has messages older than the newest 30 considered. */
  olderMessages: boolean;
  /** Of the newest 30, the older messages left out to stay within 150,000
   * characters, oldest first. */
  droppedMessageIds: string[];
  /** Included messages shortened to their first 12,000 characters, oldest
   * first. */
  clippedMessageIds: string[];
}
export interface ConfigurationPlan {
  id: string;
  path: string;
  expectedHash: string;
  before: string;
  after: string;
  digest: string;
  createdAt: string;
}
export interface Capability {
  id: string;
  name: string;
  route: "structured" | "native-terminal" | "native-ui";
  description: string;
}
export interface AppState {
  locked: boolean;
  lockReason: string | null;
  platform: string;
  version: string;
  theme: Theme;
  applications: ApplicationDefinition[];
  installations: Installation[];
  checks: UpdateCheck[];
  jobs: LifecycleJob[];
  projects: Project[];
  projectSync: ProjectSyncState;
  codexProjectSync: CodexProjectSyncState;
  conversations: Conversation[];
  messages: Message[];
  runs: Run[];
  usage: UsageFact[];
  approvals: Approval[];
  capabilities: Capability[];
  serviceError: string | null;
  configurationWrites: Array<{ id: string; path: string; state: string }>;
  terminals: Array<{
    id: string;
    projectId: string;
    installationId: string;
    login: boolean;
    permissionMode: TerminalModeId | null;
  }>;
  terminalModes: TerminalModePreference[];
  /** Codex chat presets that a runtime cannot use now, each with the reason. */
  chatPresetBlocks: ChatPresetBlock[];
  /** The owner's auto-accept setting, off until they turn it on. */
  autoAccept: AutoAcceptLevel;
  /** A development test profile, which never searches for applications. */
  testProfile: boolean;
  /** Whether a Claude Code step's reply may be read from its session's transcript. */
  claudeTranscriptRead: boolean;
  /** The owner's decision on Claude Code's structured route, off until they turn it on. */
  claudeStructuredRoute: ClaudeRouteDecision;
  /** The latest subscription allowance each runtime reported, per account. */
  allowances: AllowanceSnapshot[];
  /** The owner's own token budgets, each with what Topsl observed against it. */
  providerBudgets: ProviderBudgetStatus[];
}
export interface ServiceEvent {
  type:
    "state" | "terminal" | "native-open" | "auth-url" | "changes" | "activity";
  data: any;
}
