import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { nativeEnvironment } from "../platform/system";
import { RpcPeer } from "../runtime/rpc";
import { hash, safeError, stable } from "../domain/invariants";
import type { Installation } from "../domain/types";
import type {
  PreparedTurn,
  ProviderAdapter,
  ProviderApproval,
  ProviderCapability,
  ProviderConnection,
  ProviderEvent,
} from "./contract";
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
const sessionSchema = z.object({
  thread: z.object({ id: string.min(1) }),
  model: string.optional(),
});
const turnSchema = z.object({
  turn: z.object({ id: string.optional() }).optional(),
  model: string.optional(),
});
const frame = z
  .object({ threadId: string.optional(), turnId: string.optional() })
  .passthrough();
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
            }),
          )
          .default([]),
      })
      .parse(await connection.request("model/list", { limit: 100 }));
    const account = accountSchema.parse(
      await connection.request("account/read", { refreshToken: false }),
    ).account;
    return {
      info: {
        platformFamily: info.platformFamily ?? null,
        platformOs: info.platformOs ?? null,
      },
      models: raw.data.map((m) => ({
        id: m.id,
        model: m.model,
        name: m.displayName ?? m.model,
        description: m.description ?? "",
        isDefault: m.isDefault ?? false,
      })),
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
  async startSession(
    connection: ProviderConnection,
    turn: PreparedTurn,
    nativeSessionId: string | null,
  ) {
    const params = {
      cwd: turn.cwd,
      model: turn.requestedModel,
      approvalPolicy: "untrusted",
      sandbox: turn.mode === "review" ? "read-only" : "workspace-write",
    };
    const result = sessionSchema.parse(
      await connection.request(
        nativeSessionId ? "thread/resume" : "thread/start",
        nativeSessionId ? { ...params, threadId: nativeSessionId } : params,
      ),
    );
    return {
      nativeSessionId: result.thread.id,
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
        approvalPolicy: "untrusted",
        sandboxPolicy:
          turn.mode === "review"
            ? { type: "readOnly" }
            : {
                type: "workspaceWrite",
                writableRoots: [turn.cwd],
                networkAccess: false,
              },
      }),
    );
    return {
      nativeTurnId: result.turn?.id ?? null,
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
  approval(method: string, payload: unknown): ProviderApproval | null {
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
    return params.success
      ? {
          threadId: params.data.threadId,
          turnId: params.data.turnId,
          method,
          params: params.data,
          description: JSON.stringify(params.data, null, 2).slice(0, 30000),
        }
      : null;
  }
}
