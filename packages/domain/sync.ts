import type { Provider } from "./types";
import type { Evidence, SyncObservation } from "./workflow";

export type { SyncObservation };
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
