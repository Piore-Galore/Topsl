import type { Provider, Installation } from "../domain/types";
import type { Evidence } from "../domain/workflow";
export interface ProviderConnection {
  process: { pid?: number; once(event: "exit", callback: () => void): unknown };
  onNotification: (method: string, params: unknown) => void;
  onRequest: (id: string | number, method: string, params: unknown) => void;
  onExit: (detail: string) => void;
  initialize(): Promise<unknown>;
  request(method: string, params: unknown, timeout?: number): Promise<unknown>;
  reply(id: string | number, value: unknown): void;
  reject(id: string | number, message: string): void;
  close(): void;
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
export interface PreparedTurn {
  prompt: string;
  cwd: string;
  requestedModel: string;
  mode: "review" | "edit";
  contextPackageId: string | null;
  attemptId: string;
  workspaceIdentity: string;
}
export interface ProviderAccount {
  accountKey: string;
  profileId: string;
  billingRoute: "native-subscription";
  sanitized: { type: string; email: string | null; planType: string | null };
}
export interface SessionResult {
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
}
export interface ProviderAdapter {
  provider: Provider;
  capabilities(installation: Installation): ProviderCapability[];
  connect(executable: string, cwd: string): ProviderConnection;
  inspect(connection: ProviderConnection): Promise<{
    models: Array<{
      id: string;
      model: string;
      name: string;
      description: string;
      isDefault: boolean;
    }>;
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
  ): Promise<{ nativeTurnId: string | null; reportedModel: string | null }>;
  interrupt(
    connection: ProviderConnection,
    sessionId: string,
    turnId: string,
  ): Promise<void>;
  event(method: string, payload: unknown): ProviderEvent | null;
  approval(method: string, payload: unknown): ProviderApproval | null;
}
