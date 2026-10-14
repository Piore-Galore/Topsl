import type { Provider } from "./types";
import type { Evidence, SyncObservation } from "./workflow";

export type { SyncObservation };
export type FieldValue = string | number | boolean | null | string[];
export interface SyncField {
  id: string;
  projectId: string;
  targetId: string;
  field: string;
  revision: number;
  authority: "topsl" | "provider" | "follow-native";
  base: FieldValue;
  local: FieldValue;
  remote: FieldValue;
  state: "current" | "push-required" | "pull-required" | "conflict";
  evidence: Evidence;
  updatedAt: string;
}
export interface NativeProjectLink {
  id: string;
  projectId: string;
  provider: Provider;
  profileId: string;
  nativeGroupId: string;
  name: string;
  position: number;
  sourceRevision: string;
  revision: number;
  state: "linked" | "removed" | "unlinked";
  roots: Array<{
    nativeRoot: string;
    workspaceId: string | null;
    canonicalRoot: string | null;
    trustRevision: string | null;
  }>;
  evidence: Evidence;
  createdAt: string;
  updatedAt: string;
}
export interface SharedRevision {
  id: string;
  projectId: string;
  recordId: string;
  kind: "specification" | "decision" | "interface";
  sequence: number;
  previousId: string | null;
  title: string;
  content: string;
  contentHash: string;
  impact: "dispatch-blocking" | "advisory";
  createdAt: string;
}
export interface SharedHead {
  id: string;
  projectId: string;
  revisionId: string;
  sequence: number;
}
export interface TaskInputBinding {
  id: string;
  projectId: string;
  taskId: string;
  attemptId: string | null;
  contextPackageId: string;
  contextPackageHash: string;
  references: Array<{ recordId: string; revisionId: string }>;
  createdAt: string;
}
export interface ContextUpdateIntent {
  id: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  oldBindingId: string;
  replacementPackageId: string;
  replacementPackageHash: string;
  action: "checkpoint" | "restart" | "finish-old";
  state:
    "requested" | "delivered" | "restart-required" | "historical-completion";
  evidence: Evidence;
  createdAt: string;
}
export interface ConfigurationEvidence {
  id: string;
  projectId: string;
  sessionId: string;
  provider: Provider;
  capability: string;
  classification:
    | "enforceable"
    | "observable-only"
    | "native-only"
    | "unsupported"
    | "unknown";
  stage: "requested" | "configured" | "discovered" | "enabled" | "effective";
  value: string | null;
  sourceRevision: string | null;
  sourceHash: string | null;
  evidence: Evidence;
  createdAt: string;
}
export interface NativeHistorySource {
  id: string;
  projectId: string;
  provider: Provider;
  profileId: string;
  sessionId: string;
  selectedFile: string;
  canonicalFile: string;
  conversationId: string;
  parserVersion: string;
  enabled: boolean;
  revision: number;
  cursor: number;
  prefixHash: string;
  fileIdentity: string;
  recordCount: number;
  sourceRevision: string | null;
  pendingBytes: number;
  state:
    | "pending"
    | "current"
    | "partial"
    | "stale"
    | "paused"
    | "error"
    | "deleted";
  coverageLosses: Array<{
    at: string;
    reason: "rotation" | "truncation" | "rewrite";
    previousCursor: number;
  }>;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  detail: string;
  approvedAt: string;
}
export interface NativeMessageSource {
  sourceId: string;
  sourceRevision: string;
  contentHash: string;
  recordHash: string;
  parserVersion: string;
  nativeOrder: number;
  byteStart: number;
  byteEnd: number;
}
