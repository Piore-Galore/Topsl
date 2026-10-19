import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { nativeEnvironment } from "../platform/system";
import { RpcPeer } from "../runtime/rpc";
import { hash, safeError, stable } from "../domain/invariants";
import type { Installation, ReportedPermissions } from "../domain/types";
import type { AllowanceReport, ReportedBucket } from "../domain/allowance";
import { sandboxName } from "../domain/chat-presets";
import type {
  PreparedTurn,
  ProviderAdapter,
  ProviderApproval,
  ProviderCapability,
  ProviderConnection,
  ProviderEvent,
  ProviderModel,
  ProviderToolCall,
  ProviderToolResult,
  SessionPermissions,
  StartedItem,
} from "./contract";
import {
  commandApprovalSummary,
  fileChangeApprovalSummary,
} from "./codex-approvals";
const string = z.string();
const accountSchema = z.object({
  account: z
    .object({
      type: string,
      email: string.optional(),
      planType: string.optional(),
      chatgptAccountId: string.optional(),
    })
    .nullable(),
});
// Codex's `RateLimitSnapshot`: a window's used share, its length and its reset
// time in Unix seconds. Unknown fields, such as spend-control details, are
// ignored rather than read.
const rateLimitWindow = z
  .object({
    usedPercent: z.number().finite(),
    windowDurationMins: z.number().finite().nullable().optional(),
    resetsAt: z.number().finite().nullable().optional(),
  })
  .nullable()
  .optional();
const rateLimitSnapshot = z.object({
  limitId: string.nullable().optional(),
  limitName: string.nullable().optional(),
  primary: rateLimitWindow,
  secondary: rateLimitWindow,
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: string.nullable().optional(),
    })
    .nullable()
    .optional(),
  planType: string.nullable().optional(),
  rateLimitReachedType: string.nullable().optional(),
});
const rateLimitsReadSchema = z.object({
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
  rateLimits: rateLimitSnapshot,
  rateLimitsByLimitId: z
    .record(string, rateLimitSnapshot.optional())
    .nullable()
    .optional(),
});
const rateLimitsUpdatedSchema = z.object({ rateLimits: rateLimitSnapshot });
function rateLimitBucket(
  snapshot: z.infer<typeof rateLimitSnapshot>,
  key?: string,
): ReportedBucket {
  const window = (value: z.infer<typeof rateLimitWindow>) =>
    value
      ? {
          usedPercent: value.usedPercent,
          windowMinutes: value.windowDurationMins ?? null,
          resetsAtSeconds: value.resetsAt ?? null,
        }
      : null;
  return {
    // Codex keys its default single-bucket view as `codex`.
    id: snapshot.limitId ?? key ?? "codex",
    name: snapshot.limitName ?? null,
    primary: window(snapshot.primary),
    secondary: window(snapshot.secondary),
    credits: snapshot.credits
      ? {
          hasCredits: snapshot.credits.hasCredits,
          unlimited: snapshot.credits.unlimited,
          balance: snapshot.credits.balance ?? null,
        }
      : null,
    planType: snapshot.planType ?? null,
    limitReached: snapshot.rateLimitReachedType ?? null,
  };
}
const sessionSchema = z.object({
  thread: z.object({
    id: string.min(1),
    sessionId: string.nullable().optional(),
  }),
  model: string.optional(),
  reasoningEffort: string.nullable().optional(),
  instructionSources: z.array(string).optional(),
  // Read by reportedPermissions, whatever their shape.
  approvalPolicy: z.unknown().optional(),
  approvalsReviewer: z.unknown().optional(),
  sandbox: z.unknown().optional(),
});
const turnSchema = z.object({
  reasoningEffort: string.nullable().optional(),
  turn: z.object({ id: string.optional() }).optional(),
  model: string.optional(),
});
const frame = z
  .object({ threadId: string.optional(), turnId: string.optional() })
  .passthrough();
const toolCallSchema = z.object({
  threadId: string.min(1),
  turnId: string.min(1),
  callId: string.min(1),
  namespace: string.nullable().optional(),
  tool: string.min(1),
  arguments: z.unknown(),
});
const commandExecSchema = z.object({
  exitCode: z.number().int(),
  stdout: string,
  stderr: string,
});
/** The sandbox a turn runs in: read-only for a review, and for edits the
 * workspace alone, without network. `command/exec` gets the same policy. */
export const sandboxPolicy = (mode: "review" | "edit", cwd: string) =>
  mode === "review"
    ? { type: "readOnly" }
    : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false };
/** Reported text, cut to the length Topsl records. */
const reportedText = (value: unknown) =>
  (typeof value === "string" ? value : JSON.stringify(value)).slice(0, 200);
/**
 * What Codex reported it adopted in its answer to `thread/start` or
 * `thread/resume`: the approval policy, the approvals reviewer and the type of
 * the sandbox policy. Codex 0.163.0's schema requires all three.
 */
export function reportedPermissions(result: {
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
}): ReportedPermissions {
  const { approvalPolicy: policy, approvalsReviewer: reviewer } = result,
    sandbox = result.sandbox as { type?: unknown } | null | undefined;
  return {
    approvalPolicy:
      policy == null
        ? null
        : typeof policy === "object" && "granular" in policy
          ? "granular"
          : reportedText(policy),
    approvalsReviewer: reviewer == null ? null : reportedText(reviewer),
    sandbox:
      sandbox == null
        ? null
        : reportedText(
            typeof sandbox === "object" && typeof sandbox.type === "string"
              ? sandbox.type
              : sandbox,
          ),
  };
}
/** The sandbox policy type Codex reports for each sandbox Topsl asks for. */
const sandboxTypes: Record<string, string> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
};
/** Each way Codex's report differs from what Topsl asked for, in words. */
export function permissionDifferences(
  requested: SessionPermissions["requested"],
  reported: ReportedPermissions,
): string[] {
  const differences: string[] = [];
  if (reported.approvalPolicy !== requested.approvalPolicy)
    differences.push(
      `approval policy: Topsl asked for ${requested.approvalPolicy}, Codex reported ${reported.approvalPolicy ?? "nothing"}`,
    );
  if (reported.approvalsReviewer !== requested.approvalsReviewer)
    differences.push(
      `approvals reviewer: Topsl asked for ${requested.approvalsReviewer}, Codex reported ${reported.approvalsReviewer ?? "nothing"}`,
    );
  if (reported.sandbox !== sandboxTypes[requested.sandbox])
    differences.push(
      `sandbox: Topsl asked for ${requested.sandbox}, Codex reported ${reported.sandbox === null ? "nothing" : sandboxName(reported.sandbox)}`,
    );
  return differences;
}
export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  constructor(
    private peer = (executable: string, cwd: string) =>
      new RpcPeer(executable, ["app-server"], cwd),
  ) {}
  connect(executable: string, cwd: string): ProviderConnection {
    return this.peer(executable, cwd);
  }
  capabilities(installation: Installation): ProviderCapability[] {
    return [
      "structured-turn",
      "read-only",
      "workspace-write",
      "native-subscription",
      "interrupt",
      "approvals",
    ].map((name) => ({
      name,
      route: "structured",
      support:
        installation.compatibility === "compatible" &&
        name === "structured-turn"
          ? "observable-only"
          : "unknown",
      versions: installation.version ? [installation.version] : [],
      testedPlatforms: ["fixture"],
      restrictions: [
        "Installed runtime compatibility and executable trust must be revalidated.",
        "Native descendants and external editors are outside complete Topsl enforcement.",
      ],
      evidence: {
        level: "source-observation",
        source: "codex-pilot-protocol",
        observedAt: null,
        detail:
          "Pilot protocol preserved; live platform acceptance is a separate gate.",
      },
    }));
  }
  async inspect(connection: ProviderConnection) {
    const init = await connection.initialize();
    const info = z
      .object({
        platformFamily: string.optional(),
        platformOs: string.optional(),
      })
      .parse(init);
    const models: ProviderModel[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const raw = z
        .object({
          data: z
            .array(
              z.object({
                id: string,
                model: string,
                displayName: string.optional(),
                description: string.optional(),
                isDefault: z.boolean().optional(),
                supportedReasoningEfforts: z
                  .array(
                    z.object({
                      reasoningEffort: string,
                      description: string.optional(),
                    }),
                  )
                  .optional(),
                defaultReasoningEffort: string.nullable().optional(),
                inputModalities: z.array(string).optional(),
              }),
            )
            .default([]),
          nextCursor: string.nullable().optional(),
        })
        .parse(
          await connection.request("model/list", {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        );
      for (const m of raw.data)
        models.push({
          id: m.id,
          model: m.model,
          name: m.displayName ?? m.model,
          description: m.description ?? "",
          isDefault: m.isDefault ?? false,
          supportedReasoningEfforts:
            m.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [],
          defaultReasoningEffort: m.defaultReasoningEffort ?? null,
          inputModalities: m.inputModalities ?? ["text", "image"],
          metadataSource: "runtime",
          observedAt: new Date().toISOString(),
        });
      cursor = raw.nextCursor ?? null;
      if (cursor && (cursors.has(cursor) || models.length > 5000))
        throw new Error("Invalid or unbounded runtime model pagination.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const account = accountSchema.parse(
      await connection.request("account/read", { refreshToken: false }),
    ).account;
    return {
      info: {
        platformFamily: info.platformFamily ?? null,
        platformOs: info.platformOs ?? null,
      },
      models,
      account: account
        ? {
            type: account.type,
            email: account.email ?? null,
            planType: account.planType ?? null,
          }
        : null,
    };
  }
  private profileRoot(): string {
    const root = path.resolve(
      nativeEnvironment().CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    );
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  }
  async account(connection: ProviderConnection, installation: Installation) {
    const account = accountSchema.parse(
      await connection.request("account/read", { refreshToken: false }),
    ).account;
    if (account?.type !== "chatgpt")
      throw new Error(
        "A native ChatGPT subscription login is required. API-key and external-token modes are not supported by this pilot.",
      );
    return {
      accountKey: hash(
        stable({
          type: account.type,
          email: account.email,
          accountId: account.chatgptAccountId ?? null,
        }),
      ),
      profileId: hash(stable([this.profileRoot(), "codex-native-profile"])),
      billingRoute: "native-subscription" as const,
      sanitized: {
        type: account.type,
        email: account.email ?? null,
        planType: account.planType ?? null,
      },
    };
  }
  /** Codex's supported quota interface; it reads the account's limits, not a model. */
  async allowance(connection: ProviderConnection): Promise<AllowanceReport> {
    const read = rateLimitsReadSchema.parse(
      await connection.request(
        "account/rateLimits/read",
        { excludeResetCreditDetails: true },
        15_000,
      ),
    );
    const byId = Object.entries(read.rateLimitsByLimitId ?? {}).filter(
      (entry): entry is [string, z.infer<typeof rateLimitSnapshot>] =>
        entry[1] !== undefined,
    );
    return {
      kind: "read",
      ordinaryUsageAllowed: read.ordinaryUsageAllowed ?? null,
      buckets: byId.length
        ? byId.map(([key, snapshot]) => rateLimitBucket(snapshot, key))
        : [rateLimitBucket(read.rateLimits)],
    };
  }
  allowanceUpdate(method: string, payload: unknown): AllowanceReport | null {
    if (method !== "account/rateLimits/updated") return null;
    const parsed = rateLimitsUpdatedSchema.safeParse(payload);
    return parsed.success
      ? {
          kind: "update",
          ordinaryUsageAllowed: null,
          buckets: [rateLimitBucket(parsed.data.rateLimits)],
        }
      : null;
  }
  async startSession(
    connection: ProviderConnection,
    turn: PreparedTurn,
    nativeSessionId: string | null,
  ) {
    // Codex accepts declared tools only on `thread/start`.
    if (turn.toolset && (turn.mode !== "review" || nativeSessionId))
      throw new Error(
        "Topsl declares its tools only when a fresh review thread starts.",
      );
    const requested = {
      approvalPolicy: turn.approvalPolicy ?? "untrusted",
      // Approval requests come to Topsl, which asks the owner or declines
      // them, never to Codex's automatic reviewer.
      approvalsReviewer: "user",
      sandbox: turn.mode === "review" ? "read-only" : "workspace-write",
    };
    const params = {
      cwd: turn.cwd,
      model: turn.requestedModel,
      ...requested,
      // Codex's experimental dynamic tools; the connection opts in when it
      // initializes.
      ...(turn.toolset
        ? {
            dynamicTools: [
              {
                type: "namespace",
                name: turn.toolset.namespace,
                description: turn.toolset.description,
                tools: turn.toolset.tools.map((tool) => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
              },
            ],
          }
        : {}),
    };
    const result = sessionSchema.parse(
      await connection.request(
        nativeSessionId ? "thread/resume" : "thread/start",
        nativeSessionId ? { ...params, threadId: nativeSessionId } : params,
      ),
    );
    const reported = reportedPermissions(result);
    return {
      permissions: {
        requested,
        reported,
        differences: permissionDifferences(requested, reported),
      },
      nativeSessionId: result.thread.id,
      nativeThreadId: result.thread.id,
      providerSessionId: result.thread.sessionId ?? null,
      reportedEffort: result.reasoningEffort ?? null,
      instructionSources: (result.instructionSources ?? []).map((path) => ({
        path,
        source: "runtime-reported" as const,
        observedAt: new Date().toISOString(),
        contentHash: null,
      })),
      reportedModel: result.model ?? null,
      evidence: {
        level: "provider-ack" as const,
        source: "codex-app-server",
        observedAt: new Date().toISOString(),
        detail: nativeSessionId
          ? "Native session resume acknowledged."
          : "Fresh native session acknowledged.",
      },
    };
  }
  async startTurn(
    connection: ProviderConnection,
    turn: PreparedTurn,
    nativeSessionId: string,
  ) {
    const result = turnSchema.parse(
      await connection.request("turn/start", {
        threadId: nativeSessionId,
        input: [{ type: "text", text: turn.prompt }],
        cwd: turn.cwd,
        model: turn.requestedModel,
        ...(turn.requestedEffort ? { effort: turn.requestedEffort } : {}),
        ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
        approvalPolicy: turn.approvalPolicy ?? "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicy(turn.mode, turn.cwd),
      }),
    );
    return {
      nativeTurnId: result.turn?.id ?? null,
      reportedEffort: result.reasoningEffort ?? null,
      reportedModel: result.model ?? null,
    };
  }
  async interrupt(
    connection: ProviderConnection,
    sessionId: string,
    turnId: string,
  ) {
    await connection.request("turn/interrupt", { threadId: sessionId, turnId });
  }
  /** Codex's `command/exec` runs an argv in its sandbox without a thread or
   * turn, and answers once the process has exited. */
  async sandboxCommand(
    connection: ProviderConnection,
    command: { argv: string[]; cwd: string; mode: "review" | "edit" },
  ) {
    return commandExecSchema.parse(
      await connection.request("command/exec", {
        command: command.argv,
        cwd: command.cwd,
        sandboxPolicy: sandboxPolicy(command.mode, command.cwd),
        timeoutMs: 20_000,
      }),
    );
  }
  event(method: string, payload: unknown): ProviderEvent | null {
    const base = frame.safeParse(payload);
    if (!base.success) return null;
    const p = base.data,
      ids = { threadId: p.threadId ?? null, turnId: p.turnId ?? null };
    if (method === "turn/started") {
      const parsed = z.object({ turn: z.object({ id: string }) }).safeParse(p);
      return parsed.success
        ? {
            type: "turn-started",
            threadId: ids.threadId,
            turnId: parsed.data.turn.id,
          }
        : null;
    }
    if (method === "item/agentMessage/delta") {
      const parsed = z.object({ itemId: string, delta: string }).safeParse(p);
      return parsed.success
        ? {
            type: "message-delta",
            ...ids,
            itemId: parsed.data.itemId,
            text: parsed.data.delta,
          }
        : null;
    }
    if (method === "item/completed") {
      const parsed = z
        .object({
          item: z
            .object({
              id: string,
              type: z.enum([
                "agentMessage",
                "commandExecution",
                "dynamicToolCall",
                "fileChange",
                "mcpToolCall",
                "plan",
              ]),
            })
            .passthrough(),
        })
        .safeParse(p);
      if (!parsed.success) return null;
      const item = parsed.data.item;
      const text =
        item.type === "agentMessage" || item.type === "plan"
          ? item.text
          : item.type === "commandExecution"
            ? `${item.command}\n${item.aggregatedOutput ?? ""}\nExit: ${item.exitCode ?? "unknown"}`
            : JSON.stringify(item, null, 2);
      return {
        type: "message",
        ...ids,
        itemId: item.id,
        role: item.type === "agentMessage" ? "assistant" : "tool",
        text: String(text ?? "").slice(0, 2_000_000),
      };
    }
    if (method === "thread/tokenUsage/updated") {
      const number = z.number().finite().nonnegative().nullable().catch(null),
        parsed = z
          .object({
            tokenUsage: z.object({
              last: z.object({
                inputTokens: number,
                outputTokens: number,
                cachedInputTokens: number,
              }),
            }),
          })
          .safeParse(p);
      return parsed.success
        ? {
            type: "usage",
            ...ids,
            input: parsed.data.tokenUsage.last.inputTokens,
            output: parsed.data.tokenUsage.last.outputTokens,
            cached: parsed.data.tokenUsage.last.cachedInputTokens,
          }
        : null;
    }
    if (method === "turn/completed") {
      const parsed = z
        .object({
          turn: z.object({
            status: string,
            error: z.object({ message: string }).nullable().optional(),
          }),
        })
        .safeParse(p);
      return parsed.success
        ? {
            type: "completed",
            ...ids,
            status:
              parsed.data.turn.status === "completed"
                ? "completed"
                : parsed.data.turn.status === "interrupted"
                  ? "interrupted"
                  : "failed",
            error: parsed.data.turn.error?.message
              ? safeError(parsed.data.turn.error.message)
              : null,
          }
        : null;
    }
    return null;
  }
  approval(
    method: string,
    payload: unknown,
    item?: (id: string) => unknown,
  ): ProviderApproval | null {
    if (
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(method)
    )
      return null;
    const params = z
      .object({ threadId: string.min(1), turnId: string.min(1) })
      .passthrough()
      .safeParse(payload);
    if (!params.success) return null;
    const command = method === "item/commandExecution/requestApproval",
      // A file change request names its item, which lists the files.
      subject =
        !command && typeof params.data.itemId === "string"
          ? item?.(params.data.itemId)
          : undefined;
    return {
      threadId: params.data.threadId,
      turnId: params.data.turnId,
      method,
      params: params.data,
      description: JSON.stringify(params.data, null, 2).slice(0, 30000),
      summary: command
        ? commandApprovalSummary(params.data)
        : fileChangeApprovalSummary(params.data, subject),
      ...(subject === undefined ? {} : { subject }),
    };
  }
  startedItem(method: string, payload: unknown): StartedItem | null {
    if (method !== "item/started") return null;
    const parsed = z
      .object({
        threadId: string.min(1),
        turnId: string.min(1),
        item: z
          .object({ id: string.min(1), type: z.literal("fileChange") })
          .passthrough(),
      })
      .safeParse(payload);
    if (!parsed.success) return null;
    const { item } = parsed.data,
      changes: unknown[] = Array.isArray(item.changes) ? item.changes : [];
    return {
      threadId: parsed.data.threadId,
      turnId: parsed.data.turnId,
      id: item.id,
      // What an approval card shows, with each diff kept only as its digest,
      // so a large change is not held while it waits and still binds.
      item: {
        type: item.type,
        id: item.id,
        changes: changes.map((change: any) => ({
          path: change?.path,
          kind: change?.kind,
          diffDigest:
            typeof change?.diff === "string" ? hash(change.diff) : null,
        })),
      },
    };
  }
  toolCall(method: string, payload: unknown): ProviderToolCall | null {
    if (method !== "item/tool/call") return null;
    const parsed = toolCallSchema.safeParse(payload);
    return parsed.success
      ? {
          threadId: parsed.data.threadId,
          turnId: parsed.data.turnId,
          callId: parsed.data.callId,
          namespace: parsed.data.namespace ?? null,
          tool: parsed.data.tool,
          arguments: parsed.data.arguments ?? null,
        }
      : null;
  }
  toolResult(result: ProviderToolResult) {
    return {
      contentItems: [{ type: "inputText", text: result.text }],
      success: result.success,
    };
  }
}
