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
}
export interface Approval {
  id: string;
  runId: string;
  method: string;
  description: string;
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
  createdAt: string;
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
  }>;
}
export interface ServiceEvent {
  type: "state" | "terminal" | "native-open" | "auth-url";
  data: any;
}
