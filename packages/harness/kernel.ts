import { existsSync } from "node:fs";
import { hash, safeError, stable } from "../domain/invariants";
import type { ProtectedBlobs } from "../persistence/blobs";
import {
  collectResponse,
  type CanonicalEvent,
  type CanonicalOutputFormat,
  type CanonicalResponse,
  type CanonicalToolCallPart,
} from "../proxy/canonical";
import { NativeJournal, StaleGeneration } from "./journal";
import type { ModelClient } from "./model-client";
import type { ResourceLedger } from "./resources";
import {
  buildConversation,
  capsuleText,
  compactionCut,
  compactionInstructions,
  compileRequest,
  estimateMessages,
  openToolCalls,
  rangeHash,
  transcript,
} from "./context";
import {
  MAX_INLINE_OUTPUT,
  PathRejected,
  ToolInputError,
  toolDefinitions,
  toolsHash,
  type DelegationRequest,
  type NativeTool,
  type SkillEntry,
  type ToolContext,
  type ToolOutcome,
} from "./tools";
import {
  terminalStates,
  type DelegationMode,
  type ExecutionBinding,
  type JournalBodies,
  type JournalEvent,
  type NativeAttemptView,
  type NativeLimits,
  type NativeMemberContext,
  type ToolGrants,
} from "./types";

/**
 * The native harness kernel (docs/Native_Harness_Plan.md §3, "Native step
 * lifecycle"). For each step it:
 *
 * 1. claims input under the attempt's current generation;
 * 2. validates the binding, grants, budget and workspace;
 * 3. freezes tool definitions and compiles context;
 * 4. persists the request manifest;
 * 5. calls the Topsl proxy, showing output provisionally;
 * 6. validates and commits the provider's terminal result;
 * 7. authorizes and journals complete tool calls;
 * 8. executes tools, persists outcomes, and continues or submits.
 *
 * No tool runs from partial arguments or an unsuccessful response. The
 * kernel owns retry policy; the proxy never retries a model request.
 */

export interface AttemptSpec {
  attemptId: string;
  projectId: string;
  title: string;
  prompt: string;
  /** Compiled system instructions: policy, project instructions, skills index, accepted memories. */
  instructions: string;
  binding: ExecutionBinding;
  limits: NativeLimits;
  grants: ToolGrants;
  workspace: {
    root: string;
    identity: string;
    writable: boolean;
    baselineCandidateId: string | null;
  };
  projectRoot: string | null;
  tempRoot: string;
  parentAttemptId: string | null;
  rootAttemptId: string;
  depth: number;
  delegationMode: DelegationMode | null;
  /**
   * The JSON Schema the final text must follow, frozen at start and sent
   * with every step request (not with compaction). Absent: free text.
   */
  outputFormat?: CanonicalOutputFormat | null;
  /** Set for a member turn; its candidate is captured by the orchestration driver. */
  member?: NativeMemberContext | null;
}

export interface KernelDeps {
  journal: NativeJournal;
  blobs: ProtectedBlobs;
  model: ModelClient;
  resources: ResourceLedger;
  gitExecutable: string;
  tools(spec: AttemptSpec): NativeTool[];
  skills(spec: AttemptSpec): SkillEntry[];
  baseline(spec: AttemptSpec): Map<string, string | null>;
  /** Captures the finished workspace as a candidate; returns its ID, or null for a read-only attempt. */
  submit?(spec: AttemptSpec, summary: string): Promise<string | null>;
  delegate?(
    parent: AttemptSpec,
    callId: string,
    request: DelegationRequest,
    signal: AbortSignal,
  ): Promise<ToolOutcome>;
  integrate?(parent: AttemptSpec, childAttemptId: string): Promise<ToolOutcome>;
  proposeMemory?(spec: AttemptSpec, text: string): Promise<ToolOutcome>;
  callMcp?(
    spec: AttemptSpec,
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolOutcome>;
  /** Pre/post hooks, run contained; a pre hook can refuse a call. */
  hooks?: {
    before(
      spec: AttemptSpec,
      call: { tool: string; arguments: unknown },
    ): Promise<{ allow: boolean; reason: string | null }>;
    after(
      spec: AttemptSpec,
      call: { tool: string; arguments: unknown },
      outcome: ToolOutcome,
    ): Promise<void>;
  };
  recordProcess?(attemptId: string, callId: string, pid: number | null): void;
  onProvisional?(attemptId: string, text: string | null): void;
  onChange?(view: NativeAttemptView): void;
}

interface Runtime {
  spec: AttemptSpec;
  generation: number;
  controller: AbortController;
  pause: string | null;
  cancel: boolean;
  tools: NativeTool[];
  toolMap: Map<string, NativeTool>;
  toolsHash: string;
  failures: Map<string, number>;
  done: Promise<void>;
}

const RESTART_DETAIL =
  "Topsl restarted while this attempt was running. Its journal was reconciled; review it and resume.";

export class NativeKernel {
  private readonly runtimes = new Map<string, Runtime>();
  constructor(private deps: KernelDeps) {}

  private get journal() {
    return this.deps.journal;
  }

  isRunning(attemptId: string): boolean {
    return this.runtimes.has(attemptId);
  }

  /** Starts a new attempt and runs it in the background. */
  start(spec: AttemptSpec): NativeAttemptView {
    const view = this.journal.begin(spec.attemptId, spec.projectId, {
      title: spec.title,
      prompt: spec.prompt,
      binding: spec.binding,
      limits: spec.limits,
      grants: spec.grants,
      workspace: spec.workspace,
      parentAttemptId: spec.parentAttemptId,
      rootAttemptId: spec.rootAttemptId,
      depth: spec.depth,
      delegationMode: spec.delegationMode,
      ...(spec.outputFormat ? { outputFormat: spec.outputFormat } : {}),
      ...(spec.member ? { member: spec.member } : {}),
    });
    this.launch(spec, view.generation);
    return view;
  }

  /** Continues a paused attempt under a newly claimed generation. */
  resume(spec: AttemptSpec): NativeAttemptView {
    if (this.runtimes.has(spec.attemptId))
      throw new Error("The attempt is already running.");
    const current = this.journal.require(spec.attemptId);
    if (terminalStates.has(current.state))
      throw new Error("The attempt has finished.");
    if (current.state === "uncertain")
      throw new Error("Reconcile the uncertain tool call before resuming.");
    const { generation, view } = this.journal.claim(spec.attemptId);
    this.launch(spec, generation);
    return view;
  }

  /** Waits for a running attempt's loop to stop (finished or paused). */
  async settled(attemptId: string): Promise<NativeAttemptView> {
    await this.runtimes.get(attemptId)?.done;
    return this.journal.require(attemptId);
  }

  /** Records owner steering; the running loop claims it at its next step. */
  steer(attemptId: string, text: string): NativeAttemptView {
    const view = this.journal.require(attemptId);
    if (terminalStates.has(view.state))
      throw new Error("The attempt has finished.");
    const id = hash(`${attemptId}:${Date.now()}:${Math.random()}`).slice(0, 16);
    const next = this.append(attemptId, view.generation, [
      { kind: "steering", body: { id, text } },
    ]);
    return next;
  }

  /** Asks a running attempt to pause at its next step boundary. */
  pause(attemptId: string, reason = "Paused by the owner."): void {
    const runtime = this.runtimes.get(attemptId);
    if (runtime) runtime.pause = reason;
  }

  /** Stops an attempt and all its descendants; future launches under it are refused. */
  async cancel(attemptId: string): Promise<void> {
    const view = this.journal.view(attemptId);
    if (!view) return;
    for (const child of view.children) await this.cancel(child);
    const runtime = this.runtimes.get(attemptId);
    if (runtime) {
      runtime.cancel = true;
      runtime.controller.abort();
      await runtime.done;
    }
    const current = this.journal.require(attemptId);
    if (!terminalStates.has(current.state))
      this.append(attemptId, current.generation, [
        {
          kind: "finished",
          body: { state: "cancelled", detail: "Stopped by the owner." },
        },
      ]);
  }

  /**
   * After a restart: claims the attempt, settles what the journal shows was
   * in flight without replaying any effect, and leaves the attempt paused.
   */
  async recover(
    spec: AttemptSpec,
    processes: Map<string, number>,
    alive: (pid: number) => boolean,
    kill: (pid: number) => void,
  ): Promise<NativeAttemptView> {
    const { generation } = this.journal.claim(spec.attemptId);
    const events = [...this.journal.all(spec.attemptId)];
    const drafts: Parameters<NativeJournal["append"]>[2] = [];
    const settled = new Set(
      events
        .filter((e) => e.kind === "response-settled")
        .map(
          (e) => (e.body as JournalBodies["response-settled"]).requestNumber,
        ),
    );
    for (const event of events)
      if (event.kind === "request-frozen") {
        const body = event.body as JournalBodies["request-frozen"];
        if (!settled.has(body.requestNumber))
          drafts.push({
            kind: "response-settled",
            body: {
              requestNumber: body.requestNumber,
              output: [],
              finish: null,
              error: {
                kind: "interrupted",
                status: null,
                code: "restart",
                param: null,
                message:
                  "Topsl restarted during this model request; its outcome was not received.",
                retryable: true,
                requestId: null,
              },
              usage: {
                input: null,
                output: null,
                cachedInput: null,
                reasoning: null,
              },
              reportedModel: null,
            },
          });
      }
    let uncertain = false;
    for (const intent of openIntents(events, processes)) {
      if (intent.effect === "process") {
        const record = intent.processPid;
        if (record !== null && alive(record)) kill(record);
        drafts.push({
          kind: "tool-uncertain",
          body: {
            callId: intent.callId,
            reason: `Topsl restarted while ${intent.tool} was running; its effects are unknown. Reconcile it before resuming.`,
          },
        });
        uncertain = true;
      }
    }
    drafts.push({
      kind: "paused",
      body: uncertain
        ? {
            kind: "uncertain",
            reason:
              "Topsl restarted while a command was running. Reconcile it, then resume.",
          }
        : { kind: "restart", reason: RESTART_DETAIL },
    });
    return this.append(spec.attemptId, generation, drafts);
  }

  /** The owner's decision about an uncertain call; the attempt becomes resumable. */
  reconcile(
    attemptId: string,
    callId: string,
    outcome: "applied" | "not-applied",
    note: string,
  ): NativeAttemptView {
    const view = this.journal.require(attemptId);
    if (view.state !== "uncertain")
      throw new Error("Nothing in this attempt is uncertain.");
    const events = [...this.journal.all(attemptId)];
    const open = openIntents(events).find((i) => i.callId === callId);
    if (!open) throw new Error("That tool call has no open outcome.");
    const remaining = openIntents(events).filter(
      (i) => i.callId !== callId && i.uncertain,
    );
    const output = `The owner reconciled this call after a restart: ${outcome === "applied" ? "its effects happened" : "it had no effect"}.${note ? ` Note: ${note}` : ""}`;
    return this.append(attemptId, view.generation, [
      { kind: "reconciled", body: { callId, outcome, detail: note } },
      {
        kind: "tool-result",
        body: {
          callId,
          ok: outcome === "applied",
          output,
          outputHash: hash(output),
          outputBlob: null,
          evidence: { reconciled: outcome },
          durationMs: 0,
        },
      },
      ...(remaining.length
        ? []
        : [
            {
              kind: "paused" as const,
              body: {
                kind: "restart" as const,
                reason: "Reconciled. Resume to continue.",
              },
            },
          ]),
    ]);
  }

  private append(
    attemptId: string,
    generation: number,
    drafts: Parameters<NativeJournal["append"]>[2],
  ): NativeAttemptView {
    const view = this.journal.append(attemptId, generation, drafts);
    this.deps.onChange?.(view);
    return view;
  }

  private launch(spec: AttemptSpec, generation: number): void {
    const tools = this.deps.tools(spec);
    const runtime: Runtime = {
      spec,
      generation,
      controller: new AbortController(),
      pause: null,
      cancel: false,
      tools,
      toolMap: new Map(tools.map((t) => [t.name, t])),
      toolsHash: toolsHash(tools),
      failures: new Map(),
      done: Promise.resolve(),
    };
    this.runtimes.set(spec.attemptId, runtime);
    runtime.done = this.loop(runtime)
      .catch(() => undefined)
      .finally(() => {
        this.runtimes.delete(spec.attemptId);
        this.deps.onProvisional?.(spec.attemptId, null);
      });
  }

  private async loop(rt: Runtime): Promise<void> {
    const { spec } = rt;
    const id = spec.attemptId;
    let retries = 0;
    let retryOf: number | null = null;
    try {
      // Open intentions left by a restart are settled before anything new.
      await this.settleOpenIntents(rt);
      while (true) {
        if (rt.cancel)
          return this.finish(rt, "cancelled", "Stopped by the owner.");
        if (rt.pause) {
          this.append(id, rt.generation, [
            { kind: "paused", body: { kind: "owner", reason: rt.pause } },
          ]);
          return;
        }
        let view = this.journal.require(id);
        if (terminalStates.has(view.state)) return;
        let events = [...this.journal.all(id)];

        // 1. Claim input under the current generation.
        const claimed = new Set(
          events
            .filter((e) => e.kind === "input-claimed")
            .flatMap(
              (e) => (e.body as JournalBodies["input-claimed"]).inputIds,
            ),
        );
        const inputIds: string[] = [];
        const texts: string[] = [];
        if (!claimed.has("prompt")) {
          inputIds.push("prompt");
          texts.push(spec.prompt);
        }
        for (const event of events)
          if (event.kind === "steering") {
            const body = event.body as JournalBodies["steering"];
            if (!claimed.has(`steer:${body.id}`)) {
              inputIds.push(`steer:${body.id}`);
              texts.push(`Steering from the owner: ${body.text}`);
            }
          }
        if (inputIds.length) {
          view = this.append(id, rt.generation, [
            { kind: "input-claimed", body: { inputIds, texts } },
          ]);
          events = [...this.journal.all(id)];
        }

        if (openToolCalls(events).length) {
          // Every proposed call must have a result before the next request.
          await this.settleOpenIntents(rt);
          continue;
        }
        const lastResponse = latestUsableResponse(events);
        if (
          lastResponse &&
          !lastResponse.calls.length &&
          !inputIds.length &&
          !hasInputAfter(events, lastResponse.sequence)
        ) {
          await this.submit(rt, lastResponse.text);
          return;
        }

        // 2. Validate binding, grants, budget and workspace.
        if (view.requests >= spec.limits.maxRequests) {
          this.append(id, rt.generation, [
            {
              kind: "paused",
              body: {
                kind: "budget",
                reason: `This attempt used its ${spec.limits.maxRequests} model requests. Raise the budget or start a new attempt from a checkpoint.`,
              },
            },
          ]);
          return;
        }
        const quota = this.deps.resources.quotaWait(
          spec.binding.native?.quotaOwner ?? null,
        );
        if (quota) {
          this.append(id, rt.generation, [
            { kind: "paused", body: { kind: "quota", reason: quota.detail } },
          ]);
          return;
        }
        if (view.binding.policyRevision !== spec.binding.policyRevision)
          return this.finish(
            rt,
            "failed",
            "The attempt's grants changed. Start a new attempt.",
          );
        if (!existsSync(spec.workspace.root))
          return this.finish(
            rt,
            "failed",
            "The attempt's workspace copy no longer exists.",
          );

        // 3. Freeze tools and compile context.
        const conversation = buildConversation(
          events,
          spec.binding.native!.protocol,
        );
        const compiled = compileRequest({
          model: spec.binding.native!.routeAlias,
          instructions: spec.instructions,
          conversation,
          tools: toolDefinitions(rt.tools),
          reasoningEffort: spec.binding.model.reasoningEffort,
          outputFormat: spec.outputFormat ?? null,
        });
        const window = spec.binding.model.contextWindowTokens;
        if (compiled.estimatedTokens > spec.limits.compactAt * window) {
          if (await this.compact(rt, events)) continue;
          if (compiled.estimatedTokens > window) {
            this.append(id, rt.generation, [
              {
                kind: "paused",
                body: {
                  kind: "budget",
                  reason:
                    "The context is larger than the model's window and cannot be compacted further.",
                },
              },
            ]);
            return;
          }
        }

        // 4. Persist the request manifest.
        const requestNumber = view.requests + 1;
        const correlationId = `${id}:${requestNumber}`;
        const manifest = this.deps.blobs.storeOwned(
          {
            kind: "native-request-manifest",
            id,
            projectId: spec.projectId,
            name: `request-${requestNumber}`,
          },
          Buffer.from(
            JSON.stringify({
              attemptId: id,
              requestNumber,
              routeId: spec.binding.native!.routeId,
              routeRevision: spec.binding.native!.routeRevision,
              toolsHash: rt.toolsHash,
              request: compiled.request,
            }),
          ),
        );
        this.append(id, rt.generation, [
          {
            kind: "request-frozen",
            body: {
              requestNumber,
              purpose: "step",
              retryOf,
              manifestHash: manifest.hash,
              toolsHash: rt.toolsHash,
              estimatedInputTokens: compiled.estimatedTokens,
              correlationId,
            },
          },
        ]);

        // 5. Call the proxy; output is provisional until settled.
        const response = await this.call(rt, compiled.request, correlationId);

        // 6. Validate and commit the terminal result.
        this.append(id, rt.generation, [
          {
            kind: "response-settled",
            body: settledBody(requestNumber, response),
          },
        ]);
        if (rt.cancel)
          return this.finish(rt, "cancelled", "Stopped by the owner.");
        if (response.error) {
          const error = response.error;
          if (error.kind === "quota") {
            const owner =
              spec.binding.native!.quotaOwner ??
              `connection:${spec.binding.native!.connectionId}`;
            this.deps.resources.pauseQuota(
              owner,
              `${spec.binding.native!.connectionLabel} reported its usage limit: ${error.message}`,
            );
            this.append(id, rt.generation, [
              {
                kind: "paused",
                body: {
                  kind: "quota",
                  reason: `${spec.binding.native!.connectionLabel} reported its usage limit. Topsl waits instead of retrying; resume once the allowance is available.`,
                },
              },
            ]);
            return;
          }
          if (error.retryable && retries < spec.limits.maxTransientRetries) {
            retries++;
            retryOf = requestNumber;
            continue;
          }
          return this.finish(rt, "failed", failureDetail(error));
        }
        if (response.finish !== "stop" && response.finish !== "tool-calls") {
          // An incomplete answer never runs tools; its partial calls are dropped.
          if (retries < spec.limits.maxTransientRetries) {
            retries++;
            retryOf = requestNumber;
            continue;
          }
          return this.finish(
            rt,
            "failed",
            `The model's answer was incomplete (${response.rawFinishReason ?? response.finish ?? "no reason"}).`,
          );
        }
        retries = 0;
        retryOf = null;
        const calls = response.output.filter(
          (p): p is CanonicalToolCallPart => p.type === "tool-call",
        );
        if (!calls.length) continue; // The next pass submits unless new input arrived.

        // 7–8. Authorize, journal and execute the complete tool calls.
        const paused = await this.runTools(rt, calls);
        if (paused) return;
      }
    } catch (error) {
      if (error instanceof StaleGeneration || error instanceof UncertainStop)
        return;
      if (rt.cancel)
        return this.finish(rt, "cancelled", "Stopped by the owner.");
      try {
        this.finish(rt, "failed", safeError(error));
      } catch {
        // A stale writer cannot record anything; the newer one owns the attempt.
      }
    }
  }

  private finish(
    rt: Runtime,
    state: "completed" | "failed" | "cancelled",
    detail: string,
  ): void {
    const view = this.journal.require(rt.spec.attemptId);
    if (terminalStates.has(view.state)) return;
    this.append(rt.spec.attemptId, rt.generation, [
      { kind: "finished", body: { state, detail } },
    ]);
  }

  private async submit(rt: Runtime, summary: string): Promise<void> {
    let candidateId: string | null = null;
    try {
      candidateId = (await this.deps.submit?.(rt.spec, summary)) ?? null;
    } catch (error) {
      this.append(rt.spec.attemptId, rt.generation, [
        { kind: "submitted", body: { summary, candidateId: null } },
        {
          kind: "finished",
          body: {
            state: "failed",
            detail: `The answer was recorded but its workspace could not be captured: ${safeError(error)}`,
          },
        },
      ]);
      return;
    }
    this.append(rt.spec.attemptId, rt.generation, [
      { kind: "submitted", body: { summary, candidateId } },
      {
        kind: "finished",
        body: {
          state: "completed",
          detail: candidateId
            ? "Answered; the workspace changes are a candidate to review."
            : "Answered.",
        },
      },
    ]);
  }

  private async call(
    rt: Runtime,
    request: Parameters<ModelClient["stream"]>[0]["request"],
    correlationId: string,
  ): Promise<CanonicalResponse> {
    const { spec } = rt;
    let release: (() => void) | null = null;
    const events: CanonicalEvent[] = [];
    try {
      release = await this.deps.resources.acquireInference(
        spec.attemptId,
        rt.controller.signal,
      );
      let provisional = "";
      for await (const event of this.deps.model.stream({
        binding: spec.binding,
        request,
        attemptId: spec.attemptId,
        correlationId,
        signal: rt.controller.signal,
      })) {
        events.push(event);
        if (event.type === "text-delta") {
          provisional += event.text;
          this.deps.onProvisional?.(spec.attemptId, provisional);
        }
      }
    } catch (error) {
      events.push({
        type: "error",
        error: {
          kind: rt.controller.signal.aborted ? "interrupted" : "unavailable",
          status: null,
          code: null,
          param: null,
          message: safeError(error),
          retryable: !rt.controller.signal.aborted,
          requestId: null,
        },
      });
    } finally {
      release?.();
      this.deps.onProvisional?.(spec.attemptId, null);
    }
    return collectResponse(events);
  }

  /** Compacts history against a still-valid event range. Returns whether it published a capsule. */
  private async compact(rt: Runtime, events: JournalEvent[]): Promise<boolean> {
    const { spec } = rt;
    const id = spec.attemptId;
    const conversation = buildConversation(
      events,
      spec.binding.native!.protocol,
    );
    const cut = compactionCut(conversation);
    const view = this.journal.require(id);
    if (cut === null || view.requests >= spec.limits.maxRequests) return false;
    const prior = [...events].reverse().find((e) => e.kind === "compaction") as
      JournalEvent<"compaction"> | undefined;
    const text = transcript(
      events,
      cut,
      prior?.body.summary ?? null,
      prior?.body.throughSequence ?? 0,
    );
    const requestNumber = view.requests + 1;
    const correlationId = `${id}:${requestNumber}`;
    const request = compileRequest({
      model: spec.binding.native!.routeAlias,
      instructions: compactionInstructions,
      conversation: {
        messages: [{ role: "user", parts: [{ type: "text", text }] }],
        boundaries: [],
        compactedThrough: 0,
        ownerWords: [],
      },
      tools: [],
      reasoningEffort: null,
    });
    const manifest = this.deps.blobs.storeOwned(
      {
        kind: "native-request-manifest",
        id,
        projectId: spec.projectId,
        name: `request-${requestNumber}`,
      },
      Buffer.from(
        JSON.stringify({
          attemptId: id,
          requestNumber,
          purpose: "compaction",
          request: request.request,
        }),
      ),
    );
    this.append(id, rt.generation, [
      {
        kind: "request-frozen",
        body: {
          requestNumber,
          purpose: "compaction",
          retryOf: null,
          manifestHash: manifest.hash,
          toolsHash: hash("[]"),
          estimatedInputTokens: request.estimatedTokens,
          correlationId,
        },
      },
    ]);
    const response = await this.call(rt, request.request, correlationId);
    this.append(id, rt.generation, [
      { kind: "response-settled", body: settledBody(requestNumber, response) },
    ]);
    const summary = response.output
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("")
      .trim();
    if (response.error || !summary) return false;
    // Publish only if no other capsule replaced the range meanwhile.
    const latest = [...this.journal.all(id)];
    const latestCapsule = [...latest]
      .reverse()
      .find((e) => e.kind === "compaction") as
      JournalEvent<"compaction"> | undefined;
    if ((latestCapsule?.sequence ?? 0) !== (prior?.sequence ?? 0)) return false;
    const ownerWords = buildConversation(
      latest.filter((e) => e.sequence <= cut),
      spec.binding.native!.protocol,
    ).ownerWords;
    const capsule = capsuleText(summary, ownerWords, cut);
    const stored = this.deps.blobs.storeOwned(
      {
        kind: "native-capsule",
        id,
        projectId: spec.projectId,
        name: `capsule-${cut}`,
      },
      Buffer.from(capsule),
    );
    const after = buildConversation(
      [
        ...latest,
        {
          attemptId: id,
          sequence: Number.MAX_SAFE_INTEGER,
          generation: rt.generation,
          kind: "compaction",
          body: {
            capsuleHash: stored.hash,
            summary: capsule,
            throughSequence: cut,
            rangeHash: "",
            estimatedTokensBefore: 0,
            estimatedTokensAfter: 0,
          },
          hash: "",
          createdAt: "",
        } as JournalEvent,
      ],
      spec.binding.native!.protocol,
    );
    this.append(id, rt.generation, [
      {
        kind: "compaction",
        body: {
          capsuleHash: stored.hash,
          summary: capsule,
          throughSequence: cut,
          rangeHash: rangeHash(latest, cut),
          estimatedTokensBefore: estimateMessages(
            spec.instructions,
            conversation.messages,
            [],
          ),
          estimatedTokensAfter: estimateMessages(
            spec.instructions,
            after.messages,
            [],
          ),
        },
      },
    ]);
    return true;
  }

  private context(rt: Runtime, callId: string): ToolContext {
    const { spec } = rt;
    return {
      attemptId: spec.attemptId,
      projectId: spec.projectId,
      callId,
      workspace: {
        root: spec.workspace.root,
        writable: spec.workspace.writable,
      },
      projectRoot: spec.projectRoot,
      tempRoot: spec.tempRoot,
      grants: spec.grants,
      signal: rt.controller.signal,
      timeoutMs: spec.limits.toolTimeoutMs,
      blobs: this.deps.blobs,
      gitExecutable: this.deps.gitExecutable,
      baselineFiles: this.deps.baseline(spec),
      skills: this.deps.skills(spec),
      delegate: this.deps.delegate
        ? (request) =>
            this.deps.delegate!(spec, callId, request, rt.controller.signal)
        : undefined,
      integrate: this.deps.integrate
        ? (child) => this.deps.integrate!(spec, child)
        : undefined,
      proposeMemory: this.deps.proposeMemory
        ? (text) => this.deps.proposeMemory!(spec, text)
        : undefined,
      callMcp: this.deps.callMcp
        ? (tool, args) =>
            this.deps.callMcp!(spec, tool, args, rt.controller.signal)
        : undefined,
      onProcess: (pid) =>
        this.deps.recordProcess?.(spec.attemptId, callId, pid),
    };
  }

  /** Returns true when the attempt paused (repetition or uncertainty). */
  private async runTools(
    rt: Runtime,
    calls: CanonicalToolCallPart[],
  ): Promise<boolean> {
    const { spec } = rt;
    const id = spec.attemptId;
    const admitted: Array<{
      call: CanonicalToolCallPart;
      tool: NativeTool;
      raw: unknown;
      args: unknown;
      key: string;
    }> = [];
    if (calls.length > spec.limits.maxToolCallsPerResponse) {
      for (const call of calls)
        this.result(
          rt,
          call.id,
          {
            ok: false,
            output: `Too many tool calls in one answer (${calls.length}; at most ${spec.limits.maxToolCallsPerResponse}). Make fewer calls.`,
          },
          0,
        );
      return false;
    }
    for (const call of calls) {
      const tool = rt.toolMap.get(call.name);
      if (!tool) {
        this.result(
          rt,
          call.id,
          {
            ok: false,
            output: `There is no tool named ${call.name} in this attempt.`,
          },
          0,
        );
        continue;
      }
      let args: unknown;
      let raw: unknown;
      try {
        raw = call.arguments.trim() ? JSON.parse(call.arguments) : {};
        args = tool.normalize(raw);
      } catch (error) {
        this.result(
          rt,
          call.id,
          {
            ok: false,
            output: `Invalid arguments for ${call.name}: ${error instanceof SyntaxError ? "the arguments are not valid JSON" : (error as Error).message}`,
          },
          0,
        );
        continue;
      }
      if (this.deps.hooks) {
        const verdict = await this.deps.hooks
          .before(spec, { tool: tool.name, arguments: args })
          .catch((error) => ({
            allow: false,
            reason: `The hook failed: ${safeError(error)}`,
          }));
        if (!verdict.allow) {
          this.result(
            rt,
            call.id,
            {
              ok: false,
              output: `A project hook refused this call${verdict.reason ? `: ${verdict.reason}` : "."}`,
            },
            0,
          );
          continue;
        }
      }
      let expectation: Record<string, unknown> | null = null;
      try {
        expectation = tool.expectation
          ? await tool.expectation(args, this.context(rt, call.id))
          : null;
      } catch (error) {
        if (!(error instanceof PathRejected)) throw error;
        this.result(rt, call.id, { ok: false, output: error.message }, 0);
        continue;
      }
      const argumentsHash = hash(stable(args));
      this.append(id, rt.generation, [
        // The model's own arguments are journaled; the hash fixes their normalized form.
        {
          kind: "tool-intended",
          body: {
            callId: call.id,
            tool: tool.name,
            effect: tool.effect,
            arguments: raw,
            argumentsHash,
            implementationRevision: tool.revision,
            expectation,
          },
        },
      ]);
      admitted.push({
        call,
        tool,
        raw,
        args,
        key: `${tool.name}:${argumentsHash}`,
      });
    }
    // Consecutive reads run together (at most maxConcurrentReads); anything
    // else runs alone, in order, holding the workspace's mutation slot.
    let index = 0;
    while (index < admitted.length) {
      if (rt.cancel) return false;
      if (admitted[index].tool.effect === "read") {
        const batch: typeof admitted = [];
        while (
          index < admitted.length &&
          admitted[index].tool.effect === "read" &&
          batch.length < spec.limits.maxConcurrentReads
        )
          batch.push(admitted[index++]);
        await Promise.all(batch.map((item) => this.execute(rt, item)));
      } else {
        const item = admitted[index++];
        const outcome = await this.deps.resources.exclusive(
          spec.workspace.root,
          () => this.execute(rt, item),
        );
        if (outcome === "uncertain") return true;
      }
    }
    // Repetition: the same failed operation three times with nothing changed in between.
    for (const [key, count] of rt.failures)
      if (count >= spec.limits.repetitionPause) {
        rt.failures.delete(key);
        this.append(id, rt.generation, [
          {
            kind: "paused",
            body: {
              kind: "repetition",
              reason: `The same failing ${key.split(":")[0]} call was repeated ${count} times with nothing changed in between. Steer the attempt or resume it to let it try again.`,
            },
          },
        ]);
        return true;
      }
    return false;
  }

  private async execute(
    rt: Runtime,
    item: {
      call: CanonicalToolCallPart;
      tool: NativeTool;
      raw: unknown;
      key: string;
    },
  ): Promise<"ok" | "failed" | "uncertain"> {
    const { spec } = rt;
    const started = Date.now();
    const ctx = this.context(rt, item.call.id);
    // Recheck immediately before execution: implementation, arguments, grants, revocation.
    const current = rt.toolMap.get(item.tool.name);
    if (!current || current.revision !== item.tool.revision || rt.cancel) {
      this.result(
        rt,
        item.call.id,
        {
          ok: false,
          output:
            "The tool changed or the attempt was stopped before the call ran; it did not run.",
        },
        0,
      );
      return "failed";
    }
    let outcome: ToolOutcome;
    let args: unknown = null;
    try {
      args = current.normalize(item.raw);
      if (hash(stable(args)) !== item.key.slice(item.tool.name.length + 1))
        throw new ToolInputError(
          "The arguments changed between authorization and execution.",
        );
      outcome =
        item.tool.effect === "read"
          ? await withDeadline(
              current.execute(args, ctx),
              spec.limits.toolTimeoutMs,
            )
          : await current.execute(args, ctx);
    } catch (error) {
      if (error instanceof ToolInputError || error instanceof PathRejected)
        outcome = { ok: false, output: error.message };
      else if (item.tool.effect === "mutation" && item.tool.reconcile) {
        const state = await item.tool
          .reconcile(args, null, ctx)
          .catch(() => "uncertain" as const);
        if (state === "uncertain") {
          this.append(spec.attemptId, rt.generation, [
            {
              kind: "tool-uncertain",
              body: {
                callId: item.call.id,
                reason: `${item.tool.name} failed partway (${safeError(error)}); whether it changed the workspace is unknown.`,
              },
            },
            {
              kind: "paused",
              body: {
                kind: "uncertain",
                reason:
                  "A file change may or may not have happened. Reconcile it, then resume.",
              },
            },
          ]);
          return "uncertain";
        }
        outcome = {
          ok: state === "applied",
          output: `${item.tool.name} failed: ${safeError(error)} (verified ${state}).`,
        };
      } else
        outcome = {
          ok: false,
          output: `${item.tool.name} failed: ${safeError(error)}`,
        };
    } finally {
      if (item.tool.effect === "process")
        this.deps.recordProcess?.(spec.attemptId, item.call.id, null);
    }
    this.result(rt, item.call.id, outcome, Date.now() - started);
    await this.deps.hooks
      ?.after(
        spec,
        { tool: item.tool.name, arguments: args ?? item.raw },
        outcome,
      )
      .catch(() => undefined);
    if (outcome.ok) {
      if (item.tool.effect === "mutation" || item.tool.effect === "process")
        rt.failures.clear();
    } else rt.failures.set(item.key, (rt.failures.get(item.key) ?? 0) + 1);
    return outcome.ok ? "ok" : "failed";
  }

  private result(
    rt: Runtime,
    callId: string,
    outcome: ToolOutcome,
    durationMs: number,
  ): void {
    const { spec } = rt;
    let output = outcome.output;
    let outputBlob: string | null = null;
    if (Buffer.byteLength(output) > MAX_INLINE_OUTPUT) {
      const stored = this.deps.blobs.storeOwned(
        {
          kind: "native-tool-output",
          id: spec.attemptId,
          projectId: spec.projectId,
          name: callId,
        },
        Buffer.from(output),
      );
      outputBlob = stored.hash;
      const half = Math.floor(MAX_INLINE_OUTPUT / 2);
      output = `${output.slice(0, half)}\n… [${stored.bytes - MAX_INLINE_OUTPUT} bytes omitted; Topsl kept the full output as evidence] …\n${output.slice(-half)}`;
    }
    this.append(spec.attemptId, rt.generation, [
      {
        kind: "tool-result",
        body: {
          callId,
          ok: outcome.ok,
          output,
          outputHash: hash(outcome.output),
          outputBlob,
          evidence: outcome.evidence ?? null,
          durationMs,
        },
      },
    ]);
  }

  /**
   * Settles tool intentions without results: safe reads run again, recorded
   * edits are reconciled by content hash, and anything else stays uncertain.
   */
  private async settleOpenIntents(rt: Runtime): Promise<void> {
    const events = [...this.journal.all(rt.spec.attemptId)];
    for (const intent of openIntents(events)) {
      if (intent.uncertain) continue;
      const tool = rt.toolMap.get(intent.tool);
      if (!tool) {
        this.result(
          rt,
          intent.callId,
          {
            ok: false,
            output:
              "This tool is no longer available; the call did not complete.",
          },
          0,
        );
        continue;
      }
      if (tool.effect === "read" || tool.effect === "control") {
        await this.execute(rt, {
          call: {
            type: "tool-call",
            id: intent.callId,
            name: intent.tool,
            arguments: JSON.stringify(intent.arguments),
          },
          tool,
          raw: intent.arguments,
          key: `${intent.tool}:${intent.argumentsHash}`,
        });
        continue;
      }
      if (tool.effect === "mutation" && tool.reconcile) {
        const ctx = this.context(rt, intent.callId);
        const state = await Promise.resolve()
          .then(() =>
            tool.reconcile!(
              tool.normalize(intent.arguments),
              intent.expectation,
              ctx,
            ),
          )
          .catch(() => "uncertain" as const);
        if (state === "applied") {
          this.result(
            rt,
            intent.callId,
            {
              ok: true,
              output: `${intent.tool} had already been applied before the restart (verified by content hash).`,
              evidence: { reconciled: "applied" },
            },
            0,
          );
          continue;
        }
        if (state === "not-applied") {
          await this.deps.resources.exclusive(rt.spec.workspace.root, () =>
            this.execute(rt, {
              call: {
                type: "tool-call",
                id: intent.callId,
                name: intent.tool,
                arguments: JSON.stringify(intent.arguments),
              },
              tool,
              raw: intent.arguments,
              key: `${intent.tool}:${intent.argumentsHash}`,
            }),
          );
          continue;
        }
      }
      if (tool.effect === "delegation") {
        this.result(
          rt,
          intent.callId,
          {
            ok: false,
            output:
              "Topsl restarted while this child ran. Check the child attempt's result and delegate again if needed.",
          },
          0,
        );
        continue;
      }
      this.append(rt.spec.attemptId, rt.generation, [
        {
          kind: "tool-uncertain",
          body: {
            callId: intent.callId,
            reason: `Whether ${intent.tool} took effect is unknown.`,
          },
        },
        {
          kind: "paused",
          body: {
            kind: "uncertain",
            reason: "Reconcile the uncertain call, then resume.",
          },
        },
      ]);
      throw new UncertainStop();
    }
  }
}

class UncertainStop extends Error {}

interface OpenIntent {
  callId: string;
  tool: string;
  effect: string;
  arguments: unknown;
  argumentsHash: string;
  expectation: Record<string, unknown> | null;
  uncertain: boolean;
  processPid: number | null;
}

/** Tool intentions with no recorded result. */
export function openIntents(
  events: JournalEvent[],
  processes: Map<string, number> = new Map(),
): OpenIntent[] {
  const intents = new Map<string, OpenIntent>();
  for (const event of events) {
    if (event.kind === "tool-intended") {
      const body = event.body as JournalBodies["tool-intended"];
      intents.set(body.callId, {
        callId: body.callId,
        tool: body.tool,
        effect: body.effect,
        arguments: body.arguments,
        argumentsHash: body.argumentsHash,
        expectation: body.expectation,
        uncertain: false,
        processPid: processes.get(body.callId) ?? null,
      });
    }
    if (event.kind === "tool-result")
      intents.delete((event.body as JournalBodies["tool-result"]).callId);
    if (event.kind === "tool-uncertain") {
      const intent = intents.get(
        (event.body as JournalBodies["tool-uncertain"]).callId,
      );
      if (intent) intent.uncertain = true;
    }
  }
  return [...intents.values()];
}

function latestUsableResponse(
  events: JournalEvent[],
): { sequence: number; text: string; calls: string[] } | null {
  const compactions = new Set(
    events
      .filter(
        (e) =>
          e.kind === "request-frozen" &&
          (e.body as JournalBodies["request-frozen"]).purpose === "compaction",
      )
      .map((e) => (e.body as JournalBodies["request-frozen"]).requestNumber),
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== "response-settled") continue;
    const body = event.body as JournalBodies["response-settled"];
    if (compactions.has(body.requestNumber)) continue;
    if (body.error || (body.finish !== "stop" && body.finish !== "tool-calls"))
      return null;
    return {
      sequence: event.sequence,
      text: body.output
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join(""),
      calls: body.output
        .filter((p) => p.type === "tool-call")
        .map((p) => (p as CanonicalToolCallPart).id),
    };
  }
  return null;
}

function hasInputAfter(events: JournalEvent[], sequence: number): boolean {
  return events.some(
    (e) =>
      e.sequence > sequence &&
      (e.kind === "input-claimed" || e.kind === "steering"),
  );
}

function settledBody(
  requestNumber: number,
  response: CanonicalResponse,
): JournalBodies["response-settled"] {
  return {
    requestNumber,
    output: response.error ? [] : response.output,
    finish: response.finish,
    error: response.error,
    usage: response.usage,
    reportedModel: response.model,
  };
}

function failureDetail(error: NonNullable<CanonicalResponse["error"]>): string {
  const code = error.code
    ? ` (${error.code}${error.param ? `, ${error.param}` : ""})`
    : "";
  const labels: Record<string, string> = {
    authentication: "The connection's sign-in or key was rejected",
    permission: "The provider refused this request",
    unsupported: "The route cannot carry this request",
    "invalid-request": "The provider rejected the request",
    "route-changed":
      "The route changed after this attempt was bound; start a new attempt",
    "not-found": "The model or route was not found",
    unavailable: "The provider was unavailable after the allowed retries",
    interrupted: "The model stream was interrupted after the allowed retries",
    upstream: "The provider failed",
    quota: "The allowance is exhausted",
  };
  return `${labels[error.kind] ?? "The request failed"}${code}: ${error.message}`;
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ToolInputError(`The tool did not finish within ${ms} ms.`),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
