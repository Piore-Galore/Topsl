import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { EventEmitter } from "node:events";
import { hash, now, safeError, stable, uid } from "../domain/invariants";
import { nativeEnvironment } from "../platform/system";
import {
  ProcessLifecycle,
  type ProcessEvidence,
} from "../runtime/process-lifecycle";
import type { Installation } from "../domain/types";
import type {
  PreparedTurn,
  ProviderAccount,
  ProviderAdapter,
  ProviderCapability,
  ProviderConnection,
  ProviderEvent,
  ProviderToolCall,
  ProviderToolResult,
} from "./contract";
import { readClaudeAccount } from "./claude-allowance";
import {
  ClaudeToolServer,
  mcpToolResult,
  type ClaudeToolRequest,
} from "./claude-tools";

const token = z.number().finite().nonnegative().optional();
const usageSchema = z.object({
  input_tokens: token,
  output_tokens: token,
  cache_read_input_tokens: token,
  cache_creation_input_tokens: token,
});
const envelope = z.object({
  type: z.string(),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
});
export type ClaudeStreamEvent =
  | {
      type: "session";
      sourceId: string;
      sessionId: string;
      reportedModel: string | null;
      tools: string[];
      /** Where Claude Code said its credentials come from; "none" under the
       * native claude.ai login, null when it did not say. */
      apiKeySource: string | null;
      /** Each MCP server Claude Code loaded, with the status it reported. */
      mcpServers: Array<{ name: string; status: string }>;
    }
  | { type: "delta"; sourceId: string; text: string }
  | {
      type: "message";
      sourceId: string;
      text: string;
      reportedModel: string | null;
    }
  | { type: "tool"; sourceId: string; name: string; toolId: string }
  | {
      type: "usage";
      sourceId: string;
      usage: z.infer<typeof usageSchema>;
      scope: "session-cumulative";
    }
  | {
      type: "completed";
      sourceId: string;
      sessionId: string;
      text: string;
      structuredOutput: unknown;
      failed: boolean;
      detail: string;
      reportedModel: string | null;
      /** Each tool use Claude Code's permission settings denied, with the
       * file it named, if any. Other arguments are not kept. */
      denials: Array<{ tool: string; path: string | null }>;
    }
  | { type: "notice"; sourceId: string; detail: string };

/** Versioned NDJSON compatibility reader. Thinking blocks and arbitrary tool arguments never enter persisted telemetry. */
export class ClaudeStreamParser {
  private pending = "";
  private seen = new Map<string, string>();
  private sequence = 0;
  private sessionId: string | null = null;
  private model: string | null = null;
  private messageId: string | null = null;
  private result = false;
  private finalFingerprint: string | null = null;
  private messages = new Map<string, string[]>();
  constructor(
    private emit: (event: ClaudeStreamEvent) => void,
    private maxLineBytes = 2_000_000,
  ) {}
  push(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    if (Buffer.byteLength(this.pending) > this.maxLineBytes)
      throw new Error("Claude stream record exceeds the bounded parser limit.");
    for (const line of lines) if (line.trim()) this.record(line);
  }
  finish(): void {
    if (this.pending.trim()) this.record(this.pending);
    this.pending = "";
    if (!this.result)
      throw new Error(
        "Claude stream ended without a validated final result; dispatch outcome is unknown.",
      );
  }
  private record(line: string): void {
    if (Buffer.byteLength(line) > this.maxLineBytes)
      throw new Error("Claude stream record exceeds the bounded parser limit.");
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(
        "Malformed Claude stream JSON; dispatch outcome is unknown.",
      );
    }
    const base = envelope.parse(raw),
      body = raw as Record<string, unknown>;
    if (base.parent_tool_use_id)
      throw new Error(
        "Unbounded native subagent events are unsupported by this coordinated route.",
      );
    if (base.session_id) {
      if (this.sessionId && this.sessionId !== base.session_id)
        throw new Error("Claude stream mixed native sessions.");
      this.sessionId = base.session_id;
    }
    const sourceId = base.uuid ?? `${base.type}:${++this.sequence}`;
    if (base.uuid) {
      const bodyHash = hash(stable(raw)),
        previous = this.seen.get(sourceId);
      if (previous && previous !== bodyHash)
        throw new Error("Claude event identity collision.");
      if (previous) return;
      if (this.seen.size >= 20_000)
        throw new Error("Claude stream exceeds the bounded event limit.");
      this.seen.set(sourceId, bodyHash);
    }
    const resultFingerprint = () =>
      hash(
        stable({
          session_id: base.session_id,
          subtype: body.subtype,
          is_error: body.is_error,
          result: body.result,
          structured_output: body.structured_output,
          usage: body.usage,
          errors: body.errors,
        }),
      );
    if (this.result) {
      if (
        base.type === "result" &&
        resultFingerprint() === this.finalFingerprint
      )
        return;
      throw new Error(
        "Claude emitted a new or inconsistent event after the final result.",
      );
    }
    switch (base.type) {
      case "system": {
        const value = z
          .object({
            subtype: z.string(),
            model: z.string().optional(),
            tools: z.array(z.string()).optional(),
            apiKeySource: z.string().optional(),
            mcp_servers: z
              .array(z.object({ name: z.string(), status: z.string() }))
              .optional(),
          })
          .parse(raw);
        if (value.subtype === "init") {
          if (!this.sessionId)
            throw new Error("Claude init omitted native session identity.");
          this.model = value.model ?? null;
          this.emit({
            type: "session",
            sourceId,
            sessionId: this.sessionId,
            reportedModel: this.model,
            tools: value.tools ?? [],
            apiKeySource: value.apiKeySource ?? null,
            mcpServers: (value.mcp_servers ?? [])
              .slice(0, 20)
              .map((server) => ({
                name: server.name.slice(0, 100),
                status: server.status.slice(0, 40),
              })),
          });
        } else
          this.emit({
            type: "notice",
            sourceId,
            detail: `Native system event: ${value.subtype}`,
          });
        break;
      }
      case "assistant": {
        const value = z
          .object({
            message: z.object({
              id: z.string().optional(),
              model: z.string().optional(),
              content: z.array(
                z.object({
                  type: z.string(),
                  text: z.string().optional(),
                  id: z.string().optional(),
                  name: z.string().optional(),
                }),
              ),
            }),
          })
          .parse(raw);
        if (value.message.model) this.model = value.message.model;
        for (const block of value.message.content) {
          if (block.type === "tool_use") {
            if (!block.name || !block.id)
              throw new Error("Malformed Claude tool-use identity.");
            this.emit({
              type: "tool",
              sourceId: block.id,
              name: block.name,
              toolId: block.id,
            });
          }
        }
        const text = value.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
        // Claude Code emits one assistant record per content block (thinking,
        // text, tool_use) under a shared message id, and may repeat a final
        // record under a new uuid. Accumulate distinct text blocks per message
        // and re-emit the combined text for the same item instead of failing.
        const messageKey = value.message.id ?? sourceId,
          parts = this.messages.get(messageKey) ?? [];
        if (!text || parts.includes(text)) break;
        if (parts.length >= 1_000)
          throw new Error("Claude message exceeds the bounded block limit.");
        parts.push(text);
        this.messages.set(messageKey, parts);
        this.emit({
          type: "message",
          sourceId: messageKey,
          text: parts.join("\n"),
          reportedModel: this.model,
        });
        break;
      }
      case "stream_event": {
        const value = z
          .object({
            event: z.object({
              type: z.string(),
              message: z.object({ id: z.string() }).optional(),
              // A message_delta's delta has no type (Claude Code 2.1.302
              // sends stop_reason and usage there); only text deltas count.
              delta: z
                .object({
                  type: z.string().optional(),
                  text: z.string().optional(),
                })
                .optional(),
            }),
          })
          .parse(raw);
        if (value.event.type === "message_start")
          this.messageId = value.event.message?.id ?? null;
        if (
          value.event.type === "content_block_delta" &&
          value.event.delta?.type === "text_delta" &&
          value.event.delta.text
        )
          this.emit({
            type: "delta",
            sourceId: this.messageId ?? "claude-message",
            text: value.event.delta.text,
          });
        break;
      }
      case "result": {
        const value = z
          .object({
            subtype: z.string(),
            is_error: z.boolean(),
            result: z.string().optional(),
            structured_output: z.unknown().optional(),
            usage: usageSchema.optional(),
            errors: z.array(z.string()).optional(),
            permission_denials: z
              .array(
                z.object({
                  tool_name: z.string(),
                  tool_input: z.unknown().optional(),
                }),
              )
              .optional(),
          })
          .parse(raw);
        if (!this.sessionId)
          throw new Error("Claude result omitted native session identity.");
        if (value.usage)
          this.emit({
            type: "usage",
            sourceId,
            usage: value.usage,
            scope: "session-cumulative",
          });
        this.result = true;
        this.finalFingerprint = resultFingerprint();
        this.emit({
          type: "completed",
          sourceId,
          sessionId: this.sessionId,
          text: value.result ?? "",
          structuredOutput: value.structured_output ?? null,
          failed: value.is_error || value.subtype !== "success",
          // Claude Code 2.1.302 can mark a result as an error while its
          // subtype still reads "success"; say so instead of "success".
          detail: safeError(
            (value.errors ?? []).join("\n") ||
              (value.is_error && value.subtype === "success"
                ? "Claude Code reported an error result."
                : value.subtype),
          ),
          reportedModel: this.model,
          denials: (value.permission_denials ?? [])
            .slice(0, 50)
            .map((denial) => {
              const input = denial.tool_input as
                  { file_path?: unknown; path?: unknown } | undefined,
                file = input?.file_path ?? input?.path;
              return {
                tool: denial.tool_name.slice(0, 100),
                path: typeof file === "string" ? file.slice(0, 1000) : null,
              };
            }),
        });
        break;
      }
      case "rate_limit_event":
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "prompt_suggestion":
        this.emit({
          type: "notice",
          sourceId,
          detail: `Native informational event: ${base.type}`,
        });
        break;
      case "user":
        // Native tool results/user echoes contain untrusted arbitrary payloads. The canonical submitted context is recorded separately.
        break;
      default:
        throw new Error(
          `Unsupported Claude event type: ${safeError(base.type)}. Reconcile before another dispatch.`,
        );
    }
  }
}

export const claudeStructuredGate = {
  provider: "claude" as const,
  route: "claude-code/print/stream-json",
  state: "native-only" as const,
  protocolEvidence:
    "official-documentation + deterministic-fixtures; each binding needs its own Claude runtime qualification",
  observedVersion: null as string | null,
  runtimeRevision: null as string | null,
  observedAt: null as string | null,
  testedPlatforms: [] as string[],
  billingRoute: "unconfirmed" as const,
  filesystemIsolation: "unsupported" as const,
  detail:
    "Structured Claude execution is gated: the owner has not turned on Claude Code's structured route in Settings. Use the native terminal; no API-key or subscription fallback is dispatched.",
};

/** The tools a Claude Code turn may report, by mode. A review turn gets none
 * of Claude Code's own, only Topsl's tools when its session declared them. */
export const claudeEditTools = ["Read", "Edit", "Write", "Glob", "Grep"];

/**
 * What an edit turn may do without asking. File edits are allowed only inside
 * the working directory: `Edit(./**)` covers every file-editing tool,
 * including Write. Under `dontAsk` anything else is denied. A bare `Write`
 * rule let Claude Code 2.1.302 create a file outside the working directory in
 * the live qualification of 19 October 2026.
 */
export const claudeEditPermissions = ["Read", "Glob", "Grep", "Edit(./**)"];

/** Topsl's own tools for a review session: the MCP configuration file that
 * names Topsl's server, and the tool names Claude Code gives them. */
export interface ClaudeTurnTools {
  configPath: string;
  names: string[];
}

export function claudeArguments(
  model: string,
  sessionId: string,
  mode: "review" | "edit",
  tools?: ClaudeTurnTools,
): string[] {
  if (tools && mode !== "review")
    throw new Error("Topsl's tools are declared only on a review session.");
  const allowed =
    mode === "edit"
      ? claudeEditPermissions.join(",")
      : (tools?.names ?? []).join(",");
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--verbose",
    "--include-partial-messages",
    "--model",
    model,
    "--session-id",
    sessionId,
    // Claude Code 2.1.302's safe mode also drops the servers --mcp-config
    // names, so a session with Topsl's tools turns hooks off itself; no
    // setting source is loaded either way.
    ...(tools ? ["--settings", '{"disableAllHooks":true}'] : ["--safe-mode"]),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    tools ? tools.configPath : '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--tools",
    mode === "review" ? "" : claudeEditTools.join(","),
    "--allowedTools",
    allowed,
  ];
}

/** Starts one Claude Code process for a turn. */
export type ClaudeTransport = (
  executable: string,
  args: string[],
  cwd: string,
) => ChildProcessWithoutNullStreams;

/** Claude Code itself, with only Topsl's allowlisted environment, so no API
 * key or third-party provider setting reaches it. */
export const claudeNativeTransport: ClaudeTransport = (executable, args, cwd) =>
  spawn(executable, args, {
    cwd,
    shell: false,
    env: nativeEnvironment(),
    detached: process.platform !== "win32",
  });

export interface ClaudeAdapterOptions {
  /** The owner's structured-route decision, read on every use. */
  routeAllowed?: () => boolean;
  /** Replaces Claude Code for a test of the live route's own checks. */
  transport?: ClaudeTransport;
  /** Replaces the native account read for a test. */
  readAccount?: (executable: string) => Promise<ProviderAccount>;
}

/**
 * Claude Code's print/stream-json route. An injected fixture transport always
 * runs. Otherwise the adapter starts Claude Code only while the owner's
 * structured-route setting is on, and refuses before any process is created
 * while it is off. Being able to connect qualifies nothing: readiness uses
 * only what a recorded Claude runtime qualification observed.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly capability: typeof claudeStructuredGate;
  private options: ClaudeAdapterOptions;
  constructor(
    private fixtureTransport?: (
      args: string[],
      cwd: string,
    ) => ChildProcessWithoutNullStreams,
    runtime?: {
      version: string | null;
      revisionId: string;
      observedAt: string | null;
    },
    options: ClaudeAdapterOptions = {},
  ) {
    this.options = options;
    this.capability = {
      ...claudeStructuredGate,
      observedVersion: runtime?.version ?? null,
      runtimeRevision: runtime?.revisionId ?? null,
      observedAt: runtime?.observedAt ?? null,
    };
  }
  /** Whether this adapter starts the real Claude Code. */
  get live(): boolean {
    return !this.fixtureTransport && !!this.options.routeAllowed?.();
  }
  private get enabled(): boolean {
    return !!this.fixtureTransport || this.live;
  }
  capabilities(installation: Installation): ProviderCapability[] {
    const live = this.live;
    return [
      "structured-turn",
      "read-only",
      "workspace-write",
      "native-subscription",
      "fresh-session",
      "process-lifecycle",
      "candidate-reader",
      "interrupt",
      "approvals",
    ].map((name) => ({
      name,
      route: "structured",
      support: this.fixtureTransport
        ? "enforceable"
        : live
          ? "observable-only"
          : "native-only",
      versions: installation.version ? [installation.version] : [],
      testedPlatforms: this.fixtureTransport ? ["fixture"] : [],
      restrictions: [
        live
          ? "The owner turned on Claude Code's structured route. A purpose uses this runtime only when a current Claude qualification observed what it needs."
          : this.capability.detail,
        "Permission tool lists do not establish OS filesystem isolation. Native subagent fanout is disabled.",
      ],
      evidence: {
        level: this.fixtureTransport ? "source-observation" : "none",
        source: this.fixtureTransport
          ? "claude-deterministic-fixture"
          : "selected-runtime-unvalidated",
        observedAt: this.capability.observedAt,
        detail: this.fixtureTransport
          ? "Injected local fixture only; no live provider/billing capability is inferred."
          : `Selected runtime revision ${installation.revisionId}; ${live ? "qualify it to record what it enforces" : "the structured route is off"}.`,
      },
    }));
  }
  connect(executable: string, cwd: string): ProviderConnection {
    if (!this.enabled) throw new Error(this.capability.detail);
    return new ClaudeConnection(this, executable, cwd, this.live);
  }
  async inspect(connection: ProviderConnection) {
    const client = this.connection(connection);
    if (!client.live)
      return {
        models: [],
        account: { type: "fixture", email: null, planType: null },
        info: { platformFamily: "fixture", platformOs: process.platform },
      };
    const account = await this.readAccount(client.executable);
    return {
      // Claude Code has no model list. Models enter Topsl's catalog only when
      // a qualification saw Claude Code report the model it was asked for.
      models: [],
      account: account.sanitized,
      info: {
        platformFamily: "claude-code-print",
        platformOs: process.platform,
      },
    };
  }
  async account(connection: ProviderConnection, installation: Installation) {
    const client = this.connection(connection);
    if (!client.live)
      return {
        accountKey: hash("claude-fixture-account"),
        profileId: hash(stable([installation.id, "claude-fixture-profile"])),
        billingRoute: "native-subscription" as const,
        sanitized: { type: "fixture", email: null, planType: null },
      };
    return this.readAccount(client.executable);
  }
  private readAccount(executable: string): Promise<ProviderAccount> {
    return this.options.readAccount
      ? this.options.readAccount(executable)
      : readClaudeAccount(executable, AbortSignal.timeout(15_000));
  }
  async startSession(
    connection: ProviderConnection,
    turn: PreparedTurn,
    nativeSessionId: string | null,
  ) {
    const client = this.connection(connection);
    if (nativeSessionId)
      throw new Error(
        "Coordinated Claude review requires a fresh session; resume is unsupported by this route.",
      );
    if (client.execution)
      throw new Error(
        "This Claude connection already ran a turn; open a new connection for a fresh session.",
      );
    if (turn.toolset) {
      if (turn.mode !== "review")
        throw new Error("Topsl's tools are declared only on a review session.");
      await client.tools?.close();
      client.tools = new ClaudeToolServer(turn.toolset, (request) =>
        client.toolRequest(request),
      );
      await client.tools.start();
    }
    client.sessionId = uid();
    return {
      nativeSessionId: client.sessionId,
      reportedModel: null,
      evidence: {
        level: "topsl-transaction" as const,
        source: client.live ? "claude-session" : "claude-fixture-session",
        observedAt: now(),
        detail:
          "Fresh session id prepared; Claude Code acknowledges it when its turn starts.",
      },
    };
  }
  async startTurn(
    connection: ProviderConnection,
    turn: PreparedTurn,
    nativeSessionId: string,
  ) {
    const client = this.connection(connection);
    if (client.sessionId !== nativeSessionId || client.execution)
      throw new Error(
        "Claude session identity or active-turn ownership changed.",
      );
    if (client.tools && turn.mode !== "review")
      throw new Error("Topsl's tools are declared only on a review session.");
    client.turnId = uid();
    client.execution = this.start(
      {
        executable: client.executable,
        cwd: client.cwd,
        model: turn.requestedModel,
        sessionId: nativeSessionId,
        mode: turn.mode,
        prompt: turn.prompt,
        ...(client.tools?.configPath
          ? {
              tools: {
                configPath: client.tools.configPath,
                names: client.tools.allowedTools,
              },
            }
          : {}),
      },
      (event) => client.receive(event),
    );
    client.execution.process.once("exit", () => client.process.emit("exit"));
    client.lifecycle = new ProcessLifecycle(client.execution.process);
    client.execution.done.then(
      () => {},
      (error) => client.onExit(safeError(error)),
    );
    return { nativeTurnId: client.turnId, reportedModel: null };
  }
  async interrupt(
    connection: ProviderConnection,
    sessionId: string,
    turnId: string,
  ) {
    // Stopping a running turn never needs the route to still be on.
    if (!(connection instanceof ClaudeConnection))
      throw new Error(this.capability.detail);
    const client = connection;
    if (client.sessionId !== sessionId || client.turnId !== turnId)
      throw new Error("Claude interrupt targets a stale native turn.");
    client.execution?.interrupt();
  }
  event(method: string, payload: unknown): ProviderEvent | null {
    if (method !== "claude/event") return null;
    const value = z
        .object({
          event: z.unknown(),
          threadId: z.string(),
          turnId: z.string(),
        })
        .parse(payload),
      event = value.event as ClaudeStreamEvent;
    const ids = { threadId: value.threadId, turnId: value.turnId };
    if (event.type === "session")
      return {
        type: "turn-started",
        ...ids,
        reportedModel: event.reportedModel,
      };
    if (event.type === "delta")
      return {
        type: "message-delta",
        ...ids,
        itemId: event.sourceId,
        text: event.text,
      };
    if (event.type === "message")
      return {
        type: "message",
        ...ids,
        itemId: event.sourceId,
        role: "assistant",
        text: event.text,
      };
    if (event.type === "usage") {
      const usage = event.usage,
        input = [
          usage.input_tokens,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
        ].every((n) => n !== undefined)
          ? usage.input_tokens! +
            usage.cache_read_input_tokens! +
            usage.cache_creation_input_tokens!
          : null;
      return {
        type: "usage",
        ...ids,
        input,
        output: usage.output_tokens ?? null,
        cached: usage.cache_read_input_tokens ?? null,
      };
    }
    if (event.type === "completed")
      return {
        type: "completed",
        ...ids,
        status: event.failed ? "failed" : "completed",
        error: event.failed ? event.detail : null,
      };
    if (event.type === "tool")
      return {
        type: "message",
        ...ids,
        itemId: event.toolId,
        role: "tool",
        text: `Native tool: ${event.name}; arguments not retained.`,
      };
    return null;
  }
  approval(): null {
    return null;
  } // dontAsk never silently promotes a denied native permission.
  /** A call Claude Code made to one of Topsl's tools through Topsl's MCP
   * server, as the connection reports it. */
  toolCall(method: string, payload: unknown): ProviderToolCall | null {
    if (method !== claudeToolMethod) return null;
    const parsed = z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        callId: z.string().min(1),
        namespace: z.string().min(1),
        tool: z.string().min(1),
        arguments: z.unknown(),
      })
      .safeParse(payload);
    return parsed.success
      ? {
          threadId: parsed.data.threadId,
          turnId: parsed.data.turnId,
          callId: parsed.data.callId,
          namespace: parsed.data.namespace,
          tool: parsed.data.tool,
          arguments: parsed.data.arguments ?? null,
        }
      : null;
  }
  toolResult(result: ProviderToolResult) {
    return mcpToolResult(result);
  }
  private connection(connection: ProviderConnection): ClaudeConnection {
    if (!(connection instanceof ClaudeConnection) || !this.enabled)
      throw new Error(this.capability.detail);
    return connection;
  }
  start(
    input: {
      executable: string;
      cwd: string;
      model: string;
      sessionId: string;
      mode: "review" | "edit";
      prompt: string;
      tools?: ClaudeTurnTools;
    },
    emit: (event: ClaudeStreamEvent) => void,
  ): {
    process: ChildProcessWithoutNullStreams;
    done: Promise<void>;
    interrupt: () => void;
  } {
    if (!this.enabled) throw new Error(claudeStructuredGate.detail);
    const args = claudeArguments(
        input.model,
        input.sessionId,
        input.mode,
        input.tools,
      ),
      live = !this.fixtureTransport,
      process = this.fixtureTransport
        ? this.fixtureTransport(args, input.cwd)
        : (this.options.transport ?? claudeNativeTransport)(
            input.executable,
            args,
            input.cwd,
          ),
      granted = new Set(
        input.mode === "edit" ? claudeEditTools : (input.tools?.names ?? []),
      );
    // Claude Code reports the tools and credentials a turn runs with before
    // it calls a model. A turn with more than Topsl granted, or with an API
    // key, is stopped there.
    const checked = (event: ClaudeStreamEvent) => {
      if (event.type === "session") {
        const extra = event.tools.filter((tool) => !granted.has(tool));
        if (extra.length)
          throw new Error(
            `Claude Code reported tools Topsl did not grant (${extra.slice(0, 10).join(", ")}). Topsl stopped the turn.`,
          );
        if (live && event.apiKeySource && event.apiKeySource !== "none")
          throw new Error(
            `Claude Code reported credentials from ${safeError(event.apiKeySource)}, not your Claude login. Topsl stopped the turn.`,
          );
      }
      emit(event);
    };
    const parser = new ClaudeStreamParser(checked);
    let cancelled = false;
    const done = new Promise<void>((resolve, reject) => {
      let parserError: Error | undefined;
      process.stdout.setEncoding("utf8");
      process.stdout.on("data", (chunk: string) => {
        if (!parserError)
          try {
            parser.push(chunk);
          } catch (e) {
            parserError = new Error(safeError(e));
            process.kill();
          }
      });
      // Drain stderr without retaining credential-bearing native diagnostics.
      process.stderr.resume();
      process.on("error", reject);
      process.on("close", (code) => {
        if (parserError) return reject(parserError);
        if (cancelled)
          return reject(
            new Error("Claude cancellation requested; process exit confirmed."),
          );
        try {
          parser.finish();
          if (code !== 0)
            throw new Error(
              `Claude process exited with code ${code}; inspect its recorded result.`,
            );
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      process.stdin.on("error", (e) =>
        reject(
          new Error(
            `Claude input submission failed: ${safeError(e)}. Outcome is unknown.`,
          ),
        ),
      );
      process.stdin.end(input.prompt);
    });
    return {
      process,
      done,
      interrupt: () => {
        cancelled = true;
        process.kill("SIGINT");
      },
    };
  }
}

/** The request method a Claude connection uses for a call to Topsl's tools. */
export const claudeToolMethod = "claude/tool-call";

/** Only tests call this helper; the production constructor never selects it. */
export function claudeFixtureTransport(
  executable: string,
  fixtureArgs: string[],
) {
  return (args: string[], cwd: string) =>
    spawn(executable, [...fixtureArgs, ...args], {
      cwd,
      shell: false,
      env: nativeEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
      detached: process.platform !== "win32",
    });
}

class ClaudeConnection implements ProviderConnection {
  onNotification = (_method: string, _params: unknown) => {};
  onRequest = (_id: string | number, _method: string, _params: unknown) => {};
  onExit = (_detail: string) => {};
  process = new EventEmitter() as EventEmitter & { pid?: number };
  sessionId: string | null = null;
  turnId: string | null = null;
  execution?: ReturnType<ClaudeAdapter["start"]>;
  lifecycle?: ProcessLifecycle;
  /** Topsl's MCP server, when the session declared Topsl's tools. */
  tools?: ClaudeToolServer;
  private closing?: Promise<ProcessEvidence>;
  private texts = new Map<string, string>();
  private pending = new Map<string, (result: unknown) => void>();
  constructor(
    readonly adapter: ClaudeAdapter,
    readonly executable: string,
    readonly cwd: string,
    readonly live: boolean,
  ) {}
  async initialize(): Promise<unknown> {
    return this.live
      ? { platformFamily: "claude-code-print", platformOs: process.platform }
      : { platformFamily: "fixture", platformOs: process.platform };
  }
  request(): Promise<unknown> {
    return Promise.reject(
      new Error("Claude print route does not expose arbitrary RPC methods."),
    );
  }
  /** Hands a call from Topsl's MCP server to whoever runs this connection,
   * and waits for its reply. A call outside a running turn is refused. */
  toolRequest(request: ClaudeToolRequest): Promise<unknown> {
    if (!this.sessionId || !this.turnId || this.closing || !this.tools)
      return Promise.resolve(
        mcpToolResult({
          text: "This tool call is outside the active turn.",
          success: false,
        }),
      );
    const id = `${this.turnId}:${request.requestId}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.onRequest(id, claudeToolMethod, {
        threadId: this.sessionId,
        turnId: this.turnId,
        callId: id,
        namespace: this.tools!.toolset.namespace,
        tool: request.tool,
        arguments: request.arguments,
      });
    });
  }
  reply(id: string | number, value: unknown): void {
    const resolve = this.pending.get(String(id));
    if (!resolve)
      throw new Error(
        "Claude native permission prompts are not enabled by this route.",
      );
    this.pending.delete(String(id));
    resolve(value);
  }
  reject(id: string | number, message: string): void {
    const resolve = this.pending.get(String(id));
    if (!resolve) return;
    this.pending.delete(String(id));
    resolve(mcpToolResult({ text: message, success: false }));
  }
  close(): Promise<ProcessEvidence> {
    if (this.closing) return this.closing;
    for (const [id] of this.pending) this.reject(id, "This run has ended.");
    const tools = this.tools?.close() ?? Promise.resolve();
    if (this.lifecycle)
      return (this.closing = this.lifecycle
        .stop()
        .then(async (evidence) => (await tools, evidence)));
    const at = now();
    return (this.closing = tools.then(() => ({
      version: 1,
      pid: null,
      groupId: null,
      scope: "child-and-stdio",
      state: "quiescent",
      startedAt: at,
      stopRequestedAt: at,
      exitedAt: null,
      closedAt: null,
      observedAt: at,
      exitCode: null,
      signal: null,
      remainingGroup: "absent",
      detail: "No task process was created.",
    })));
  }
  receive(event: ClaudeStreamEvent): void {
    if (!this.sessionId || !this.turnId)
      throw new Error("Claude event arrived without a prepared session/turn.");
    if (event.type === "session" && event.sessionId !== this.sessionId)
      throw new Error(
        "Claude native session differs from the requested fresh session.",
      );
    if (event.type === "message") this.texts.set(event.sourceId, event.text);
    if (event.type === "completed") {
      const text = event.structuredOutput
        ? JSON.stringify(event.structuredOutput)
        : event.text;
      if (text && [...this.texts.values()].join("\n") !== text)
        this.onNotification("claude/event", {
          threadId: this.sessionId,
          turnId: this.turnId,
          event: {
            type: "message",
            sourceId: `${event.sourceId}:output`,
            text,
            reportedModel: event.reportedModel,
          },
        });
    }
    this.onNotification("claude/event", {
      threadId: this.sessionId,
      turnId: this.turnId,
      event,
    });
  }
}
