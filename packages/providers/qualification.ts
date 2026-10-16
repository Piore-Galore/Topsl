import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReaderProbe, type ReaderProbe } from "../context/reader-probe";
import { now, safeError } from "../domain/invariants";
import type { Installation } from "../domain/types";
import { isWithin } from "../platform/system";
import type { RuntimeProbeObservation } from "./acceptance";
import type {
  PreparedTurn,
  ProviderAccount,
  ProviderAdapter,
  ProviderConnection,
  ProviderToolset,
  SandboxCommandResult,
  ToolBinding,
} from "./contract";
import { answerToolCall } from "./tool-calls";

export const qualificationSuite = "codex-runtime-qualification/v4";
/** Model turns the suite may start. The cancellation probe ends its turn early. */
export const qualificationTurnBudget = 3;
export const qualificationValidityDays = 30;
const turnTimeoutMs = 180_000;

export interface QualificationReport {
  suite: string;
  installationId: string;
  model: string;
  effort: string | null;
  startedAt: string;
  finishedAt: string;
  turnsStarted: number;
  account: ProviderAccount | null;
  observations: RuntimeProbeObservation[];
  notTested: Array<{ capability: string; reason: string }>;
  approvals: Array<{ probe: string; method: string; decision: string }>;
  error: string | null;
}
interface TurnWatch {
  probe: string;
  threadId: string;
  turnId: string | null;
  /** The reader's tools, on the one turn whose thread declared them. */
  tools?: ToolBinding;
  toolCalls: Array<{ tool: string; outcome: string }>;
  text: Map<string, string>;
  /** Called for each piece of the reply the turn streams. */
  output: () => void;
  settle: (value: { status: string; error: string | null }) => void;
  fail: (error: Error) => void;
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}
/** The real path of `target`, resolved through its nearest existing ancestor. */
async function resolvedPath(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing);
    } catch (error) {
      const parent = path.dirname(current);
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        parent === current
      )
        throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}
/**
 * Refuses a qualification folder inside the system temporary directory or
 * `/tmp`. Codex's workspace-write sandbox leaves both writable unless a client
 * excludes them, so the outside-write probe could not be judged there.
 */
export async function assertQualificationParent(parent: string): Promise<void> {
  const target = await resolvedPath(parent);
  for (const temporary of new Set([os.tmpdir(), "/tmp"]))
    if (isWithin(await resolvedPath(temporary), target))
      throw new Error(
        `The qualification folder ${parent} is inside ${temporary}. Codex's workspace-write sandbox leaves that folder writable, so the outside-write probe could not be judged there. Use a folder outside the system temporary folders.`,
      );
}
/**
 * Runs bounded, consented operations against one trusted Codex runtime in a
 * disposable folder and reports what it observed. The caller owns consent and
 * recording; this function never writes a qualification itself.
 *
 * Every probe fails closed: an observation passes only when the operation was
 * attempted and the runner's own filesystem check confirms the expected
 * state. The two sandbox probes involve no model. Topsl runs each sentinel
 * write itself through the runtime's sandbox, under the policy a review or an
 * edit turn gets, because a live model with approvals off skipped the writes
 * it expected the sandbox to block. Every approval request a turn makes is
 * declined, as a review run declines them: Codex 0.163.0 appeared to run an
 * approved command outside its sandbox when the sandbox blocked it.
 *
 * A second review thread declares the reviewer's own tools, and its one turn
 * reads a one-file build through them. Only Topsl holds that file, so
 * `candidate-reader` passes only when Topsl answered the read and the reply
 * quotes the file's marker.
 */
export async function runCodexQualification(input: {
  adapter: ProviderAdapter;
  installation: Installation;
  model: string;
  effort?: string;
  /** Parent folder for the disposable workspace. A temporary directory is
   * refused; see `assertQualificationParent`. */
  parent: string;
  timeoutMs?: number;
  /** Prepares the reader probe in a folder of the disposable workspace. Tests
   * replace it to see the marker. */
  readerProbe?: (directory: string) => Promise<ReaderProbe>;
}): Promise<QualificationReport> {
  if (process.platform === "win32")
    throw new Error(
      "Runtime qualification probes use POSIX shell commands and are available on macOS and Linux only.",
    );
  await assertQualificationParent(input.parent);
  const startedAt = now(),
    timeout = input.timeoutMs ?? turnTimeoutMs,
    observations: RuntimeProbeObservation[] = [],
    notTested: QualificationReport["notTested"] = [],
    approvals: QualificationReport["approvals"] = [],
    nonce = randomBytes(6).toString("hex");
  await mkdir(input.parent, { recursive: true, mode: 0o700 });
  const root = await realpath(
    await mkdtemp(path.join(input.parent, "qualify-")),
  );
  if (!/^[A-Za-z0-9 ._\/-]+$/.test(root)) {
    await rm(root, { recursive: true, force: true });
    throw new Error(
      "The qualification folder path contains characters the shell probes cannot quote safely.",
    );
  }
  const workspace = path.join(root, "workspace"),
    outside = path.join(root, "outside");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(
    path.join(workspace, "README.md"),
    "Disposable Topsl runtime qualification workspace.\n",
  );
  // Prepared before the runtime starts: once captured, the probe's file is
  // only in the probe's own encrypted store.
  let reader: ReaderProbe | null = null,
    readerFailure: string | null = null;
  if (!input.adapter.toolCall || !input.adapter.toolResult)
    readerFailure = "This runtime adapter cannot answer tool calls.";
  else
    try {
      reader = await (input.readerProbe ?? createReaderProbe)(
        path.join(root, "reader"),
      );
    } catch (e) {
      readerFailure = `Topsl could not prepare the reader probe: ${safeError(e)}`;
    }
  let turnsStarted = 0,
    account: ProviderAccount | null = null,
    current: TurnWatch | null = null,
    exited: string | null = null,
    closing = false,
    error: string | null = null;
  const observe = (
    capability: string,
    meaning: RuntimeProbeObservation["meaning"],
    passed: boolean,
    detail: string,
    negativeControl: RuntimeProbeObservation["negativeControl"] = null,
  ) =>
    observations.push({
      capability,
      meaning: passed
        ? meaning
        : meaning === "unsupported"
          ? meaning
          : "unknown",
      source: "trusted-runtime-validation",
      operationId: `${qualificationSuite}:${capability}:${nonce}`,
      observedAt: now(),
      passed,
      negativeControl,
      detail: detail.slice(0, 2000),
    });
  let connection: ProviderConnection;
  try {
    connection = input.adapter.connect(input.installation.path, workspace);
  } catch (e) {
    reader?.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  connection.onExit = (detail) => {
    if (closing) return;
    exited = detail;
    current?.fail(new Error(detail));
  };
  connection.onNotification = (method, params: any) => {
    const watch = current;
    if (!watch || !params || typeof params !== "object") return;
    if (params.threadId && params.threadId !== watch.threadId) return;
    const event = input.adapter.event(method, params);
    if (!event) return;
    if (event.type === "turn-started") watch.turnId ??= event.turnId;
    else if (event.type === "message-delta") {
      watch.text.set(
        event.itemId,
        (watch.text.get(event.itemId) ?? "") + event.text,
      );
      watch.output();
    } else if (event.type === "message" && event.role === "assistant")
      watch.text.set(event.itemId, event.text);
    else if (event.type === "completed") {
      const turnId = params.turn?.id ?? event.turnId;
      if (watch.turnId && turnId && turnId !== watch.turnId) return;
      watch.settle({ status: event.status, error: event.error });
    }
  };
  connection.onRequest = (id, method, params: any) => {
    const call = input.adapter.toolResult
      ? input.adapter.toolCall?.(method, params)
      : null;
    if (call) {
      const watch = current;
      void answerToolCall(watch?.tools, call, {
        threadId: watch?.threadId ?? null,
        turnId: watch?.turnId ?? null,
        ended: false,
      }).then((answer) => {
        watch?.toolCalls.push({ tool: call.tool, outcome: answer.outcome });
        try {
          connection.reply(id, input.adapter.toolResult!(answer.result));
        } catch {
          // The connection closed while the tool ran.
        }
      });
      return;
    }
    const watch = current,
      approval = input.adapter.approval(method, params);
    if (!watch || !approval || approval.threadId !== watch.threadId) {
      connection.reject(id, "Request outside the active qualification probe.");
      return;
    }
    approvals.push({ probe: watch.probe, method, decision: "decline" });
    connection.reply(id, { decision: "decline" });
  };
  // Every model turn is a review turn; only the sandbox probes use the edit
  // policy, and they run no model.
  const prepared = (
    prompt: string,
    probe: string,
    toolset?: ProviderToolset,
  ): PreparedTurn => ({
    prompt,
    cwd: workspace,
    requestedModel: input.model,
    ...(input.effort ? { requestedEffort: input.effort } : {}),
    ...(toolset ? { toolset } : {}),
    mode: "review",
    contextPackageId: null,
    attemptId: `${qualificationSuite}:${probe}:${nonce}`,
    workspaceIdentity: workspace,
  });
  const session = async (probe: string, toolset?: ProviderToolset) =>
    (
      await input.adapter.startSession(
        connection,
        prepared("", probe, toolset),
        null,
      )
    ).nativeSessionId;
  async function turn(
    probe: string,
    threadId: string,
    prompt: string,
    options: {
      onOutput?: (watch: TurnWatch) => void;
      tools?: ToolBinding;
    } = {},
  ) {
    const { onOutput, tools } = options;
    if (exited) throw new Error(exited);
    if (turnsStarted >= qualificationTurnBudget)
      throw new Error("The qualification turn budget is exhausted.");
    let settle!: TurnWatch["settle"], fail!: TurnWatch["fail"];
    const done = new Promise<{ status: string; error: string | null }>(
      (resolve, reject) => {
        settle = resolve;
        fail = reject;
      },
    );
    const watch: TurnWatch = {
      probe,
      threadId,
      turnId: null,
      ...(tools ? { tools } : {}),
      toolCalls: [],
      text: new Map(),
      output: () => onOutput?.(watch),
      settle,
      fail,
    };
    current = watch;
    turnsStarted++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = await input.adapter.startTurn(
        connection,
        prepared(prompt, probe),
        threadId,
      );
      watch.turnId ??= started.nativeTurnId;
      const result = await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${probe} turn exceeded ${timeout} ms.`)),
            timeout,
          );
        }),
      ]);
      return { ...result, watch };
    } catch (e) {
      if (watch.turnId && !exited)
        await input.adapter
          .interrupt(connection, threadId, watch.turnId)
          .catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
      current = null;
    }
  }
  /** A turn's reply, all messages together. */
  const replyText = (watch: TurnWatch) => [...watch.text.values()].join("\n");
  /** The start of a reply that lacked what the probe asked for, so a failed
   * probe shows what the model said instead. */
  const replyStart = (text: string) =>
    text.trim()
      ? ` The reply began: ${JSON.stringify(text.trim().split(root).join("<folder>").slice(0, 160))}`
      : " The reply was empty.";
  /** Writes `content` to `file` with the runtime's own sandbox in `mode`'s
   * policy. No model is involved. */
  const sandboxWrite = (
    mode: "review" | "edit",
    file: string,
    content: string,
  ) =>
    input.adapter.sandboxCommand!(connection, {
      argv: ["/bin/sh", "-c", 'printf %s "$1" > "$2"', "topsl", content, file],
      cwd: workspace,
      mode,
    });
  /** How a sandboxed command ended, with the folder's path shortened. */
  const ended = (result: SandboxCommandResult) => {
    const stderr = result.stderr.trim().split(root).join("<folder>");
    return `exited with code ${result.exitCode}${stderr ? ` (${JSON.stringify(stderr.slice(0, 200))})` : ""}`;
  };
  const remaining = (capabilities: string[], reason: string) => {
    for (const capability of capabilities)
      if (
        !observations.some((o) => o.capability === capability) &&
        !notTested.some((n) => n.capability === capability)
      )
        notTested.push({ capability, reason });
  };
  try {
    await connection.initialize();
    try {
      account = await input.adapter.account(connection, input.installation);
      observe(
        "native-subscription",
        "behavior-observed",
        account.billingRoute === "native-subscription",
        `Runtime reported a ${account.sanitized.type} account; billing route ${account.billingRoute}.`,
      );
    } catch (e) {
      observe("native-subscription", "unknown", false, safeError(e));
      throw e;
    }
    // Structured turn on a review thread.
    const first = await session("structured-turn");
    try {
      const marker = `TOPSL-QUALIFY-${nonce}`,
        result = await turn(
          "structured-turn",
          first,
          `This is an automated Topsl runtime qualification. Do not run any commands or edit any files. Reply with exactly this text and nothing else: ${marker}`,
        ),
        text = replyText(result.watch),
        returned = text.includes(marker);
      observe(
        "structured-turn",
        "behavior-observed",
        result.status === "completed" && returned,
        returned
          ? `Turn ${result.status}; the requested marker was returned.`
          : `Turn ${result.status}; the requested marker was not returned.${replyStart(text)}`,
      );
    } catch (e) {
      observe("structured-turn", "unknown", false, safeError(e));
    }
    // The reviewer's reader, in its own turn on a fresh review thread that
    // declares the reader's tools. Without them the thread still shows
    // whether sessions are fresh.
    let second: string | null = null;
    if (reader)
      try {
        second = await session("candidate-reader", reader.tools.toolset);
      } catch (e) {
        readerFailure = `The runtime refused the reader's tools when the thread started: ${safeError(e)}`;
        reader.close();
        reader = null;
      }
    if (reader && second)
      try {
        const result = await turn(
            "candidate-reader",
            second,
            `This is an automated Topsl runtime qualification. Do not run any commands or edit any files. Call the read_range tool from Topsl's topsl_candidate tools once, with path "${reader.path}". The content field of its result holds one line. Reply with exactly that line and nothing else.`,
            { tools: reader.tools },
          ),
          text = replyText(result.watch),
          reads = reader.markerReads(),
          refused = reader.refusedRequests(),
          quoted = text.includes(reader.marker),
          calls =
            result.watch.toolCalls
              .map((call) => `${call.tool} ${call.outcome}`)
              .join(", ") || "none";
        observe(
          "candidate-reader",
          "behavior-observed",
          result.status === "completed" && reads > 0 && quoted,
          `Turn ${result.status}. ${reads} read_range answer${reads === 1 ? "" : "s"} under the probe's grant returned the probe file's marker, and the reader refused ${refused} request${refused === 1 ? "" : "s"}. The reply ${quoted ? "quoted" : "did not quote"} the marker. Tool calls: ${calls}.${quoted ? "" : replyStart(text)}`,
        );
      } catch (e) {
        observe("candidate-reader", "unknown", false, safeError(e));
      } finally {
        // The probe's attempt has ended, so its grant goes with it.
        reader.close();
      }
    else
      observe(
        "candidate-reader",
        "unknown",
        false,
        readerFailure ?? "The reader probe was not prepared.",
      );
    second ??= await session("fresh-session");
    observe(
      "fresh-session",
      "behavior-observed",
      !!first && !!second && first !== second,
      first !== second
        ? "Two thread/start requests returned distinct native thread identities."
        : "The runtime returned the same thread identity for two fresh sessions.",
    );
    // Sandbox enforcement, with no model: Topsl itself writes through the
    // runtime's sandbox. A model with approvals off skipped the writes it
    // expected the sandbox to block, so a turn could not test the sandbox.
    if (!input.adapter.sandboxCommand)
      for (const capability of ["read-only", "workspace-write"])
        observe(
          capability,
          "unknown",
          false,
          "This runtime adapter cannot run a command in its sandbox.",
        );
    else {
      // Read-only policy: the shell must run, and the write must not land.
      const readOnlyFile = path.join(workspace, `readonly-${nonce}.txt`);
      try {
        const control = await input.adapter.sandboxCommand(connection, {
            argv: ["/bin/sh", "-c", 'printf %s "$1"', "topsl", "readable"],
            cwd: workspace,
            mode: "review",
          }),
          ran = control.exitCode === 0 && control.stdout === "readable",
          write = await sandboxWrite("review", readOnlyFile, "readonly"),
          absent = !(await exists(readOnlyFile)),
          untouched =
            (await readdir(workspace)).join("/") === "README.md" &&
            !(await readdir(outside)).length,
          denied = absent && untouched;
        observe(
          "read-only",
          denied ? "policy-enforced" : "unsupported",
          ran && write.exitCode !== 0 && denied,
          `Topsl ran the commands itself in the runtime's sandbox under the read-only policy, with no model turn. A command printing a word ${ran ? "ran" : ended(control)}. The write to <folder>/workspace/readonly-${nonce}.txt ${ended(write)}, and ${denied ? "no file was created" : "a file was created"}.`,
          {
            operationAttempted: ran,
            trustedStateChecked: true,
            denied,
          },
        );
      } catch (e) {
        observe("read-only", "unknown", false, safeError(e));
      }
      // Workspace-write policy: inside must land, outside must not.
      const inside = path.join(workspace, `inside-${nonce}.txt`),
        outsideFile = path.join(outside, `outside-${nonce}.txt`);
      try {
        const insideWrite = await sandboxWrite("edit", inside, "inside"),
          outsideWrite = await sandboxWrite("edit", outsideFile, "outside"),
          landed =
            insideWrite.exitCode === 0 &&
            (await readFile(inside, "utf8").catch(() => null)) === "inside",
          denied = !(await readdir(outside)).length;
        observe(
          "workspace-write",
          denied ? "policy-enforced" : "unsupported",
          landed && outsideWrite.exitCode !== 0 && denied,
          `Topsl ran the writes itself in the runtime's sandbox under the workspace-write policy, with no model turn. The write inside the workspace ${ended(insideWrite)} and ${landed ? "landed" : "did not land"}. The write to <folder>/outside/outside-${nonce}.txt ${ended(outsideWrite)} and ${denied ? "was denied" : "created a file"}.`,
          {
            operationAttempted: landed,
            trustedStateChecked: true,
            denied,
          },
        );
      } catch (e) {
        observe("workspace-write", "unknown", false, safeError(e));
      }
    }
    // Cancellation of an in-progress turn. Codex 0.163.0 found no active turn
    // to interrupt when asked as soon as the turn's start was reported, so the
    // request waits for the reply's first streamed text.
    const third = await session("interrupt");
    try {
      let requested = false;
      const result = await turn(
        "interrupt",
        third,
        "This is an automated Topsl runtime qualification of cancellation. Do not run any commands. Write the numbers from 1 to 3000, one per line.",
        {
          onOutput: (watch) => {
            if (requested || !watch.turnId) return;
            requested = true;
            void input.adapter
              .interrupt(connection, third, watch.turnId)
              .catch((e) => watch.fail(e));
          },
        },
      );
      observe(
        "interrupt",
        "behavior-observed",
        requested && result.status === "interrupted",
        requested
          ? `Interrupt requested after the reply's first streamed text; the turn ended ${result.status}.`
          : `The turn ended ${result.status} before it streamed any reply text, so no interrupt was requested.`,
      );
    } catch (e) {
      observe("interrupt", "unknown", false, safeError(e));
    }
  } catch (e) {
    error = safeError(e);
    remaining(
      [
        "structured-turn",
        "candidate-reader",
        "fresh-session",
        "read-only",
        "workspace-write",
        "interrupt",
      ],
      `Not reached: ${error}`,
    );
  } finally {
    closing = true;
    reader?.close();
    try {
      const lifecycle = await connection.close();
      observe(
        "process-lifecycle",
        "behavior-observed",
        lifecycle.state === "quiescent",
        lifecycle.detail,
      );
    } catch (e) {
      observe("process-lifecycle", "unknown", false, safeError(e));
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return {
    suite: qualificationSuite,
    installationId: input.installation.id,
    model: input.model,
    effort: input.effort ?? null,
    startedAt,
    finishedAt: now(),
    turnsStarted,
    account,
    observations,
    notTested,
    approvals,
    error,
  };
}
