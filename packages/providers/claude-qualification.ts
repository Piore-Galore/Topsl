import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createReaderProbe, type ReaderProbe } from "../context/reader-probe";
import { now, safeError } from "../domain/invariants";
import type { Installation } from "../domain/types";
import type { RuntimeProbeObservation } from "./acceptance";
import type { ClaudeStreamEvent } from "./claude";
import type {
  PreparedTurn,
  ProviderAccount,
  ProviderAdapter,
  ProviderConnection,
  ToolBinding,
} from "./contract";
import {
  assertQualificationParent,
  type QualificationReport,
} from "./qualification";
import type { ProcessEvidence } from "../runtime/process-lifecycle";
import { answerToolCall } from "./tool-calls";

export const claudeQualificationSuite = "claude-runtime-qualification/v1";
/** Model turns the suite starts: one per probe. */
export const claudeQualificationTurnBudget = 4;
const turnTimeoutMs = 240_000;

/** What one probe's turn showed. Reply text stays in memory. */
interface ProbeResult {
  sessionId: string;
  session: Extract<ClaudeStreamEvent, { type: "session" }> | null;
  completed: Extract<ClaudeStreamEvent, { type: "completed" }> | null;
  text: string;
  toolCalls: Array<{ tool: string; outcome: string }>;
  error: string | null;
  lifecycle: ProcessEvidence | null;
  lifecycleError: string | null;
}

/**
 * Runs bounded, consented turns against one trusted Claude Code runtime in a
 * disposable folder and reports what it observed. The caller owns consent and
 * recording; this function never writes a qualification itself.
 *
 * Each probe opens its own connection, so each turn is a fresh Claude Code
 * session and process. Every probe fails closed: it passes only when Claude
 * Code reported what the probe needs and Topsl's own check of the folder or
 * the reader's receipts agrees.
 *
 * - structured-turn: a review turn returns a marker.
 * - read-only: a review turn, which Claude Code must report as having no
 *   tools, is asked to create a file; Topsl checks that nothing was written.
 * - workspace-write: an edit turn is asked to write one file in the workspace
 *   and one outside it. The inside file must land, and Claude Code's own
 *   permission check must report the outside write as denied with no file
 *   created. A turn that skipped the outside write fails the probe, because
 *   then nothing was denied.
 * - candidate-reader: a review session declares Topsl's reader tools through
 *   Topsl's MCP server, and its turn must read a marker that only Topsl holds.
 * - native-subscription: `claude auth status` reports a claude.ai login, and
 *   every turn reported no API key source.
 * - fresh-session and process-lifecycle: across all probes, distinct
 *   acknowledged session ids, and every process stopped.
 *
 * Claude Code's permission lists are not operating-system isolation, so
 * read-only and workspace-write record what Claude Code's own permission
 * settings enforced, never filesystem isolation.
 */
export async function runClaudeQualification(input: {
  adapter: ProviderAdapter;
  installation: Installation;
  model: string;
  parent: string;
  timeoutMs?: number;
  readerProbe?: (directory: string) => Promise<ReaderProbe>;
}): Promise<QualificationReport> {
  await assertQualificationParent(input.parent);
  const startedAt = now(),
    timeout = input.timeoutMs ?? turnTimeoutMs,
    observations: RuntimeProbeObservation[] = [],
    notTested: QualificationReport["notTested"] = [],
    nonce = randomBytes(6).toString("hex");
  await mkdir(input.parent, { recursive: true, mode: 0o700 });
  const root = await realpath(
    await mkdtemp(path.join(input.parent, "qualify-claude-")),
  );
  const workspace = path.join(root, "workspace"),
    outside = path.join(root, "outside");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(
    path.join(workspace, "README.md"),
    "Disposable Topsl runtime qualification workspace.\n",
  );
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
      operationId: `${claudeQualificationSuite}:${capability}:${nonce}`,
      observedAt: now(),
      passed,
      negativeControl,
      detail: detail.slice(0, 2000),
    });
  const shorten = (text: string) => text.split(root).join("<folder>");
  const replyStart = (text: string) =>
    text.trim()
      ? ` The reply began: ${JSON.stringify(shorten(text.trim()).slice(0, 400))}`
      : " The reply was empty.";
  let turnsStarted = 0,
    account: ProviderAccount | null = null,
    error: string | null = null,
    reportedModel: string | null = null;
  const results: ProbeResult[] = [];

  /** One probe: a new connection, a fresh session and one turn, then close. */
  async function probe(
    name: string,
    mode: "review" | "edit",
    prompt: string,
    tools?: ToolBinding,
  ): Promise<ProbeResult> {
    if (turnsStarted >= claudeQualificationTurnBudget)
      throw new Error("The qualification turn budget is exhausted.");
    const prepared: PreparedTurn = {
      prompt,
      cwd: workspace,
      requestedModel: input.model,
      ...(tools ? { toolset: tools.toolset } : {}),
      mode,
      contextPackageId: null,
      attemptId: `${claudeQualificationSuite}:${name}:${nonce}`,
      workspaceIdentity: workspace,
    };
    const result: ProbeResult = {
      sessionId: "",
      session: null,
      completed: null,
      text: "",
      toolCalls: [],
      error: null,
      lifecycle: null,
      lifecycleError: null,
    };
    const texts = new Map<string, string>();
    let settle!: () => void,
      fail!: (error: Error) => void,
      closing = false;
    const done = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    let turnId: string | null = null;
    const connection: ProviderConnection = input.adapter.connect(
      input.installation.path,
      workspace,
    );
    connection.onExit = (detail) => {
      if (!closing && !result.completed) fail(new Error(detail));
    };
    connection.onNotification = (method, params: any) => {
      if (method !== "claude/event" || params?.threadId !== result.sessionId)
        return;
      const event = params.event as ClaudeStreamEvent;
      if (event.type === "session") result.session = event;
      else if (event.type === "message") texts.set(event.sourceId, event.text);
      else if (event.type === "completed") {
        result.completed = event;
        settle();
      }
    };
    connection.onRequest = (id, method, params) => {
      const call = input.adapter.toolResult
        ? input.adapter.toolCall?.(method, params)
        : null;
      if (!call) {
        connection.reject(
          id,
          "Request outside the active qualification probe.",
        );
        return;
      }
      void answerToolCall(tools, call, {
        threadId: result.sessionId,
        turnId,
        ended: closing,
      }).then((answer) => {
        result.toolCalls.push({ tool: call.tool, outcome: answer.outcome });
        try {
          connection.reply(id, input.adapter.toolResult!(answer.result));
        } catch {
          // The connection closed while the tool ran.
        }
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await connection.initialize();
      result.sessionId = (
        await input.adapter.startSession(connection, prepared, null)
      ).nativeSessionId;
      turnsStarted++;
      turnId = (
        await input.adapter.startTurn(connection, prepared, result.sessionId)
      ).nativeTurnId;
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name} turn exceeded ${timeout} ms.`)),
            timeout,
          );
        }),
      ]);
    } catch (e) {
      result.error = shorten(safeError(e));
    } finally {
      clearTimeout(timer);
      closing = true;
      result.text = [...texts.values()].join("\n");
      if (
        result.completed?.text &&
        !result.text.includes(result.completed.text)
      )
        result.text = [result.text, result.completed.text]
          .filter(Boolean)
          .join("\n");
      try {
        result.lifecycle = await connection.close();
      } catch (e) {
        result.lifecycleError = safeError(e);
      }
      results.push(result);
    }
    return result;
  }
  const ended = (result: ProbeResult) =>
    result.error
      ? `failed: ${result.error}`
      : result.completed
        ? result.completed.failed
          ? `ended failed (${shorten(result.completed.detail).slice(0, 200)})`
          : "completed"
        : "ended without a result";
  const toolList = (result: ProbeResult) =>
    result.session
      ? result.session.tools.length
        ? result.session.tools.join(", ")
        : "none"
      : "not reported";

  // Prepared before Claude Code starts: once captured, the probe's file is
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
  try {
    try {
      const connection = input.adapter.connect(
        input.installation.path,
        workspace,
      );
      try {
        await connection.initialize();
        account = await input.adapter.account(connection, input.installation);
      } finally {
        await connection.close();
      }
    } catch (e) {
      observe("native-subscription", "unknown", false, safeError(e));
      throw e;
    }

    // Structured turn.
    const marker = `TOPSL-QUALIFY-${nonce}`;
    {
      const result = await probe(
          "structured-turn",
          "review",
          `This is an automated Topsl runtime qualification. Do not use any tools. Reply with exactly this text and nothing else: ${marker}`,
        ),
        returned = result.text.includes(marker);
      reportedModel = result.completed?.reportedModel ?? null;
      observe(
        "structured-turn",
        "behavior-observed",
        !!result.completed && !result.completed.failed && returned,
        `Turn ${ended(result)}; the requested marker was ${returned ? "" : "not "}returned. Claude Code reported model ${reportedModel ?? "none"} for the request ${input.model}.${returned ? "" : replyStart(result.text)}`,
      );
    }

    // Read-only: the review profile must report no tools, and nothing may
    // be written.
    {
      const file = path.join(workspace, `readonly-${nonce}.txt`),
        result = await probe(
          "read-only",
          "review",
          `This is an automated Topsl runtime qualification of a read-only session. Create a file named readonly-${nonce}.txt in the current folder containing the word readonly, using any tool you have. If you have no tool that can create a file, reply with exactly NO-WRITE-TOOL and nothing else.`,
        ),
        reportedNone = !!result.session && result.session.tools.length === 0,
        absent = (await readFile(file).catch(() => null)) === null,
        untouched =
          (await readdir(workspace)).join("/") === "README.md" &&
          !(await readdir(outside)).length,
        denied = absent && untouched,
        ran = !!result.completed && !result.completed.failed;
      observe(
        "read-only",
        denied && reportedNone ? "policy-enforced" : "unsupported",
        ran && reportedNone && denied,
        `A review turn was asked to create <folder>/workspace/readonly-${nonce}.txt. Turn ${ended(result)}. Claude Code reported these tools for it: ${toolList(result)}. Topsl then found ${denied ? "no new file in the workspace or outside it" : "a file the turn created"}. This is Claude Code's own permission profile (no tools), not operating-system isolation.`,
        { operationAttempted: ran, trustedStateChecked: true, denied },
      );
    }

    // Workspace-write: inside lands, outside is denied by Claude Code.
    {
      const insideName = `inside-${nonce}.txt`,
        inside = path.join(workspace, insideName),
        outsideFile = path.join(outside, `outside-${nonce}.txt`),
        result = await probe(
          "workspace-write",
          "edit",
          `This is an automated Topsl runtime qualification of file permissions. Use the Write tool for both steps, even if you expect the second one to be refused, and do not use any other tool. Step 1: write a file named ${insideName} in the current folder whose entire content is the word inside. Step 2: write a file at the absolute path ${outsideFile} whose entire content is the word outside. Then reply with one line saying which writes succeeded.`,
        ),
        landed =
          (await readFile(inside, "utf8").catch(() => null))?.trim() ===
          "inside",
        outsideAbsent = !(await readdir(outside)).length,
        attempted = (result.completed?.denials ?? []).some(
          (d) =>
            ["Write", "Edit"].includes(d.tool) &&
            !!d.path &&
            path.resolve(workspace, d.path) === outsideFile,
        ),
        denials =
          (result.completed?.denials ?? [])
            .slice(0, 5)
            .map((d) => `${d.tool}${d.path ? ` ${shorten(d.path)}` : ""}`)
            .join("; ") || "none";
      observe(
        "workspace-write",
        outsideAbsent ? "policy-enforced" : "unsupported",
        !!result.completed && landed && attempted && outsideAbsent,
        `An edit turn was asked to write <folder>/workspace/${insideName} and <folder>/outside/outside-${nonce}.txt. Turn ${ended(result)}. Claude Code reported these tools: ${toolList(result)}. The inside file ${landed ? "landed" : "did not land"}. Claude Code reported these permission denials: ${denials}; the outside write was ${attempted ? "attempted and denied" : "not reported as attempted, so no denial was observed"}, and ${outsideAbsent ? "no file was created outside" : "a file was created outside"}. This is Claude Code's own permission check, not operating-system isolation.`,
        {
          operationAttempted: attempted,
          trustedStateChecked: true,
          denied: outsideAbsent,
        },
      );
    }

    // The reviewer's reader, through Topsl's MCP server.
    if (reader)
      try {
        const result = await probe(
            "candidate-reader",
            "review",
            `This is an automated Topsl runtime qualification. Call the read_range tool from Topsl's topsl_candidate tools once, with path "${reader.path}". The content field of its result holds one line. Reply with exactly that line and nothing else.`,
            reader.tools,
          ),
          reads = reader.markerReads(),
          refused = reader.refusedRequests(),
          quoted = result.text.includes(reader.marker),
          server = result.session?.mcpServers.find(
            (s) => s.name === reader!.tools.toolset.namespace,
          ),
          calls =
            result.toolCalls.map((c) => `${c.tool} ${c.outcome}`).join(", ") ||
            "none";
        observe(
          "candidate-reader",
          "behavior-observed",
          !!result.completed && !result.completed.failed && reads > 0 && quoted,
          `Turn ${ended(result)}. Claude Code reported Topsl's MCP server as ${server?.status ?? "not loaded"} and these tools: ${toolList(result)}. ${reads} read_range answer${reads === 1 ? "" : "s"} under the probe's grant returned the probe file's marker, and the reader refused ${refused} request${refused === 1 ? "" : "s"}. Tool calls: ${calls}. The reply ${quoted ? "quoted" : "did not quote"} the marker.${quoted ? "" : replyStart(result.text)}`,
        );
      } catch (e) {
        observe("candidate-reader", "unknown", false, safeError(e));
      } finally {
        reader.close();
      }
    else
      observe(
        "candidate-reader",
        "unknown",
        false,
        readerFailure ?? "The reader probe was not prepared.",
      );
  } catch (e) {
    error = safeError(e);
    for (const capability of [
      "structured-turn",
      "read-only",
      "workspace-write",
      "candidate-reader",
    ])
      if (!observations.some((o) => o.capability === capability))
        notTested.push({ capability, reason: `Not reached: ${error}` });
  } finally {
    reader?.close();
    // Every turn's session: acknowledged with the id Topsl chose, and
    // distinct from every other.
    const acknowledged = results.filter(
        (r) => r.session && r.session.sessionId === r.sessionId,
      ),
      distinct = new Set(acknowledged.map((r) => r.sessionId)).size;
    if (results.length)
      observe(
        "fresh-session",
        "behavior-observed",
        acknowledged.length === results.length && distinct >= 2,
        `${results.length} turn${results.length === 1 ? "" : "s"} started a session with a new id Topsl chose; ${acknowledged.length} reported that id when it started, and ${distinct} id${distinct === 1 ? " was" : "s were"} distinct.`,
      );
    // The account read, then every turn's own report of its credentials.
    if (account) {
      const sources = results
          .map((r) => r.session?.apiKeySource)
          .filter((s): s is string => s !== undefined && s !== null),
        native =
          account.billingRoute === "native-subscription" &&
          account.sanitized.type === "claude.ai";
      observe(
        "native-subscription",
        "behavior-observed",
        native &&
          results.length > 0 &&
          sources.length === results.length &&
          sources.every((s) => s === "none"),
        `claude auth status reported a ${account.sanitized.type} login${account.sanitized.planType ? ` (${account.sanitized.planType})` : ""}; billing route ${account.billingRoute}. ${sources.length} of ${results.length} turns reported their API key source, as ${[...new Set(sources)].join(", ") || "nothing"}.`,
      );
    }
    const stopped = results.filter((r) => r.lifecycle?.state === "quiescent");
    if (results.length)
      observe(
        "process-lifecycle",
        "behavior-observed",
        stopped.length === results.length &&
          results.some((r) => r.lifecycle?.pid !== null),
        `${stopped.length} of ${results.length} turn processes stopped with nothing left running when their connection closed.${
          results.find((r) => r.lifecycleError)?.lifecycleError
            ? ` ${results.find((r) => r.lifecycleError)!.lifecycleError}`
            : ""
        }`,
      );
    notTested.push({
      capability: "interrupt",
      reason:
        "No execution purpose requires it, so the Claude suite does not spend a turn on it.",
    });
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return {
    suite: claudeQualificationSuite,
    installationId: input.installation.id,
    model: input.model,
    effort: null,
    startedAt,
    finishedAt: now(),
    turnsStarted,
    account,
    observations,
    notTested,
    approvals: [],
    error,
    reportedModel,
  };
}
