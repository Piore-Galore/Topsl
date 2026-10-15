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
  ProviderAdapter,
  ProviderCapability,
  ProviderConnection,
  ProviderEvent,
} from "./contract";

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
              delta: z
                .object({ type: z.string(), text: z.string().optional() })
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
          detail: safeError((value.errors ?? []).join("\n") || value.subtype),
          reportedModel: this.model,
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
    "official-documentation + deterministic-fixtures; selected-runtime acceptance pending",
  observedVersion: null as string | null,
  runtimeRevision: null as string | null,
  observedAt: null as string | null,
  testedPlatforms: [] as string[],
  billingRoute: "unconfirmed" as const,
  filesystemIsolation: "unsupported" as const,
  detail:
    "Structured Claude execution is gated. This profile has no approved product authentication/billing route or live permission/isolation acceptance. Use the native terminal; no API-key or subscription fallback is dispatched.",
};

export function claudeArguments(
  model: string,
  sessionId: string,
  mode: "review" | "edit",
): string[] {
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
    "--safe-mode",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--tools",
    mode === "review" ? "" : "Read,Edit,Write,Glob,Grep",
    "--allowedTools",
    mode === "review" ? "" : "Read,Edit,Write,Glob,Grep",
  ];
}

/** Production refuses model dispatch. Fixture transport is dependency-injected and has no service-facing activation switch. */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly capability: typeof claudeStructuredGate;
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
  ) {
    this.capability = {
      ...claudeStructuredGate,
      observedVersion: runtime?.version ?? null,
      runtimeRevision: runtime?.revisionId ?? null,
      observedAt: runtime?.observedAt ?? null,
    };
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
      support: this.fixtureTransport ? "enforceable" : "native-only",
      versions: installation.version ? [installation.version] : [],
      testedPlatforms: this.fixtureTransport ? ["fixture"] : [],
      restrictions: [
        this.capability.detail,
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
          : `Selected runtime revision ${installation.revisionId}; live protocol and billing route remain unvalidated.`,
      },
    }));
  }
  connect(executable: string, cwd: string): ProviderConnection {
    if (!this.fixtureTransport) throw new Error(this.capability.detail);
    return new ClaudeConnection(this, executable, cwd);
  }
  async inspect(connection: ProviderConnection) {
    this.connection(connection);
    return {
      models: [],
      account: { type: "fixture", email: null, planType: null },
      info: { platformFamily: "fixture", platformOs: process.platform },
    };
  }
  async account(connection: ProviderConnection, installation: Installation) {
    this.connection(connection);
    return {
      accountKey: hash("claude-fixture-account"),
      profileId: hash(stable([installation.id, "claude-fixture-profile"])),
      billingRoute: "native-subscription" as const,
      sanitized: { type: "fixture", email: null, planType: null },
    };
  }
  async startSession(
    connection: ProviderConnection,
    _turn: PreparedTurn,
    nativeSessionId: string | null,
  ) {
    const client = this.connection(connection);
    if (nativeSessionId)
      throw new Error(
        "Coordinated Claude review requires a fresh session; resume is unsupported by this route.",
      );
    client.sessionId = uid();
    return {
      nativeSessionId: client.sessionId,
      reportedModel: null,
      evidence: {
        level: "topsl-transaction" as const,
        source: "claude-fixture-session",
        observedAt: now(),
        detail:
          "Fresh fixture session prepared; provider creation is not yet acknowledged.",
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
    client.turnId = uid();
    client.execution = this.start(
      {
        executable: client.executable,
        cwd: client.cwd,
        model: turn.requestedModel,
        sessionId: nativeSessionId,
        mode: turn.mode,
        prompt: turn.prompt,
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
    const client = this.connection(connection);
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
  private connection(connection: ProviderConnection): ClaudeConnection {
    if (!(connection instanceof ClaudeConnection) || !this.fixtureTransport)
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
    },
    emit: (event: ClaudeStreamEvent) => void,
  ): {
    process: ChildProcessWithoutNullStreams;
    done: Promise<void>;
    interrupt: () => void;
  } {
    if (!this.fixtureTransport) throw new Error(claudeStructuredGate.detail);
    const process = this.fixtureTransport(
      claudeArguments(input.model, input.sessionId, input.mode),
      input.cwd,
    );
    const parser = new ClaudeStreamParser(emit);
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
  private closing?: Promise<ProcessEvidence>;
  private texts = new Map<string, string>();
  constructor(
    readonly adapter: ClaudeAdapter,
    readonly executable: string,
    readonly cwd: string,
  ) {}
  async initialize(): Promise<unknown> {
    return { platformFamily: "fixture", platformOs: process.platform };
  }
  request(): Promise<unknown> {
    return Promise.reject(
      new Error("Claude print route does not expose arbitrary RPC methods."),
    );
  }
  reply(): void {
    throw new Error(
      "Claude native permission prompts are not enabled by this route.",
    );
  }
  reject(): void {}
  close(): Promise<ProcessEvidence> {
    if (this.closing) return this.closing;
    if (this.lifecycle) return (this.closing = this.lifecycle.stop());
    const at = now();
    return (this.closing = Promise.resolve({
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
    }));
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
