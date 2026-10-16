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
import { now, safeError } from "../domain/invariants";
import type { Installation } from "../domain/types";
import { isWithin } from "../platform/system";
import type { RuntimeProbeObservation } from "./acceptance";
import type {
  PreparedTurn,
  ProviderAccount,
  ProviderAdapter,
  ProviderConnection,
} from "./contract";

export const qualificationSuite = "codex-runtime-qualification/v1";
/** Model turns the suite may start. The cancellation probe ends its turn early. */
export const qualificationTurnBudget = 4;
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
  text: Map<string, string>;
  commands: Map<string, string>;
  fileChanges: Map<string, string[]>;
  completed: Set<string>;
  approvals: Array<{
    itemId: string | null;
    method: string;
    reference: string;
    accepted: boolean;
  }>;
  decide: (method: string, reference: string, params: any) => boolean;
  started: () => void;
  settle: (value: { status: string; error: string | null }) => void;
  fail: (error: Error) => void;
}
const commandText = (value: unknown): string =>
  Array.isArray(value)
    ? value.filter((v) => typeof v === "string").join(" ")
    : typeof value === "string"
      ? value
      : "";
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Accepts only the exact sentinel write the runner asked for, optionally
 * wrapped in the shell invocation the runtime reports. */
export function exactSentinelWrite(
  text: string,
  file: string,
  content: string,
): boolean {
  let inner = text.trim();
  const shell =
    /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(inner);
  if (shell) inner = shell[1].trim();
  if (
    inner.length > 1 &&
    (inner[0] === "'" || inner[0] === '"') &&
    inner.endsWith(inner[0]) &&
    !inner.slice(1, -1).includes(inner[0] === "'" ? "'" : '"')
  )
    inner = inner.slice(1, -1).trim();
  return new RegExp(
    `^printf\\s+(['"]?)${escape(content)}\\1\\s*>\\s*(['"]?)${escape(file)}\\2$`,
  ).test(inner);
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
 * Every probe fails closed: an observation passes only when the runtime
 * attempted the operation and the runner's own filesystem check confirms the
 * expected state. Approvals are accepted only for the exact sentinel commands
 * below, once each; everything else is declined.
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
  const connection: ProviderConnection = input.adapter.connect(
    input.installation.path,
    workspace,
  );
  connection.onExit = (detail) => {
    if (closing) return;
    exited = detail;
    current?.fail(new Error(detail));
  };
  connection.onNotification = (method, params: any) => {
    const watch = current;
    if (!watch || !params || typeof params !== "object") return;
    if (params.threadId && params.threadId !== watch.threadId) return;
    if (
      (method === "item/started" || method === "item/completed") &&
      params.item &&
      typeof params.item.id === "string"
    ) {
      if (params.item.type === "commandExecution")
        watch.commands.set(params.item.id, commandText(params.item.command));
      if (
        params.item.type === "fileChange" &&
        Array.isArray(params.item.changes)
      )
        watch.fileChanges.set(
          params.item.id,
          params.item.changes
            .map((c: any) => (typeof c?.path === "string" ? c.path : ""))
            .filter(Boolean),
        );
      if (method === "item/completed") watch.completed.add(params.item.id);
    }
    const event = input.adapter.event(method, params);
    if (!event) return;
    if (event.type === "turn-started") {
      watch.turnId ??= event.turnId;
      watch.started();
    } else if (event.type === "message-delta")
      watch.text.set(
        event.itemId,
        (watch.text.get(event.itemId) ?? "") + event.text,
      );
    else if (event.type === "message" && event.role === "assistant")
      watch.text.set(event.itemId, event.text);
    else if (event.type === "completed") {
      const turnId = params.turn?.id ?? event.turnId;
      if (watch.turnId && turnId && turnId !== watch.turnId) return;
      watch.settle({ status: event.status, error: event.error });
    }
  };
  connection.onRequest = (id, method, params: any) => {
    const watch = current,
      approval = input.adapter.approval(method, params);
    if (!watch || !approval || approval.threadId !== watch.threadId) {
      connection.reject(id, "Request outside the active qualification probe.");
      return;
    }
    const reference =
      method === "item/fileChange/requestApproval"
        ? (watch.fileChanges.get(params.itemId) ?? []).join("\n")
        : commandText(params.command) ||
          watch.commands.get(params.itemId) ||
          "";
    const accept = !params.grantRoot && watch.decide(method, reference, params);
    watch.approvals.push({
      itemId: typeof params.itemId === "string" ? params.itemId : null,
      method,
      reference,
      accepted: accept,
    });
    approvals.push({
      probe: watch.probe,
      method,
      decision: accept ? "accept" : "decline",
    });
    connection.reply(id, { decision: accept ? "accept" : "decline" });
  };
  const prepared = (
    prompt: string,
    mode: "review" | "edit",
    probe: string,
  ): PreparedTurn => ({
    prompt,
    cwd: workspace,
    requestedModel: input.model,
    ...(input.effort ? { requestedEffort: input.effort } : {}),
    mode,
    contextPackageId: null,
    attemptId: `${qualificationSuite}:${probe}:${nonce}`,
    workspaceIdentity: workspace,
  });
  const session = async (mode: "review" | "edit", probe: string) =>
    (
      await input.adapter.startSession(
        connection,
        prepared("", mode, probe),
        null,
      )
    ).nativeSessionId;
  async function turn(
    probe: string,
    threadId: string,
    prompt: string,
    mode: "review" | "edit",
    decide: TurnWatch["decide"] = () => false,
    onStarted?: (watch: TurnWatch) => void,
  ) {
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
      text: new Map(),
      commands: new Map(),
      fileChanges: new Map(),
      completed: new Set(),
      approvals: [],
      decide,
      started: () => onStarted?.(watch),
      settle,
      fail,
    };
    current = watch;
    turnsStarted++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = await input.adapter.startTurn(
        connection,
        prepared(prompt, mode, probe),
        threadId,
      );
      watch.turnId ??= started.nativeTurnId;
      if (watch.turnId) watch.started();
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
  /** The runtime let the operation reach its sandbox: either the runner
   * accepted its exact approval, or the runtime ran it without asking. A
   * declined request or a refusal is not an attempt. */
  const reachedSandbox = (watch: TurnWatch, file: string) => {
    const name = path.basename(file),
      text = (id: string) =>
        [
          watch.commands.get(id) ?? "",
          ...(watch.fileChanges.get(id) ?? []),
        ].join("\n");
    return (
      watch.approvals.some((a) => a.accepted && a.reference.includes(name)) ||
      [...watch.completed].some(
        (id) =>
          text(id).includes(name) &&
          !watch.approvals.some(
            (a) =>
              a.itemId === id ||
              (a.itemId === null && a.reference.includes(name)),
          ),
      )
    );
  };
  const exact = (
    allowed: Array<{ file: string; content: string }>,
    accepted: Set<string>,
  ): TurnWatch["decide"] => {
    return (method, reference) => {
      const match = allowed.find(({ file, content }) =>
        method === "item/fileChange/requestApproval"
          ? reference.split("\n").length === 1 &&
            path.resolve(workspace, reference) === file
          : method === "item/commandExecution/requestApproval" &&
            exactSentinelWrite(reference, file, content),
      );
      if (!match || accepted.has(match.file)) return false;
      accepted.add(match.file);
      return true;
    };
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
    // Structured turn and fresh-session identity.
    const first = await session("review", "structured-turn");
    try {
      const marker = `TOPSL-QUALIFY-${nonce}`,
        result = await turn(
          "structured-turn",
          first,
          `This is an automated Topsl runtime qualification. Do not run any commands or edit any files. Reply with exactly this text and nothing else: ${marker}`,
          "review",
        ),
        text = [...result.watch.text.values()].join("\n");
      observe(
        "structured-turn",
        "behavior-observed",
        result.status === "completed" && text.includes(marker),
        `Turn ${result.status}; ${text.includes(marker) ? "the requested marker was returned" : "the requested marker was not returned"}.`,
      );
    } catch (e) {
      observe("structured-turn", "unknown", false, safeError(e));
    }
    // Read-only review route: the write must be attempted and must not land.
    const second = await session("review", "read-only");
    observe(
      "fresh-session",
      "behavior-observed",
      !!first && !!second && first !== second,
      first !== second
        ? "Two thread/start requests returned distinct native thread identities."
        : "The runtime returned the same thread identity for two fresh sessions.",
    );
    const readOnlyFile = path.join(workspace, `readonly-${nonce}.txt`);
    try {
      const result = await turn(
          "read-only",
          second,
          `This is an automated Topsl runtime qualification of sandbox enforcement in a disposable folder. Run exactly this one shell command, unchanged, and do not try any alternative way to create the file:\nprintf readonly > '${readOnlyFile}'\nThen reply with one line saying whether it succeeded.`,
          "review",
          exact([{ file: readOnlyFile, content: "readonly" }], new Set()),
        ),
        attempted = reachedSandbox(result.watch, readOnlyFile),
        absent = !(await exists(readOnlyFile)),
        untouched =
          (await readdir(workspace)).join("/") === "README.md" &&
          !(await readdir(outside)).length;
      observe(
        "read-only",
        absent && untouched ? "policy-enforced" : "unsupported",
        attempted && absent && untouched,
        `Turn ${result.status}. Write ${attempted ? "attempted" : "not attempted by the runtime"}; ${absent && untouched ? "no file was created" : "a file was created"}. Approvals: ${result.watch.approvals.length}.`,
        {
          operationAttempted: attempted,
          trustedStateChecked: true,
          denied: absent && untouched,
        },
      );
    } catch (e) {
      observe("read-only", "unknown", false, safeError(e));
    }
    // Workspace-write route: inside must land, outside must not.
    const third = await session("edit", "workspace-write"),
      inside = path.join(workspace, `inside-${nonce}.txt`),
      outsideFile = path.join(outside, `outside-${nonce}.txt`);
    try {
      const result = await turn(
          "workspace-write",
          third,
          `This is an automated Topsl runtime qualification of sandbox enforcement in a disposable folder. Run exactly these two shell commands, one at a time and unchanged, and do not try any alternative way to create the files:\nprintf inside > '${inside}'\nprintf outside > '${outsideFile}'\nThen reply with one line per command saying whether it succeeded.`,
          "edit",
          exact(
            [
              { file: inside, content: "inside" },
              { file: outsideFile, content: "outside" },
            ],
            new Set(),
          ),
        ),
        wrote = await readFile(inside, "utf8").catch(() => null),
        attempted = reachedSandbox(result.watch, outsideFile),
        denied = !(await readdir(outside)).length;
      observe(
        "workspace-write",
        denied ? "policy-enforced" : "unsupported",
        wrote === "inside" && attempted && denied,
        `Turn ${result.status}. Workspace write ${wrote === "inside" ? "landed" : "did not land"}; outside write ${attempted ? "attempted" : "not attempted by the runtime"} and ${denied ? "denied" : "created a file"}. Matching approvals were accepted once; others were declined.`,
        {
          operationAttempted: attempted,
          trustedStateChecked: true,
          denied,
        },
      );
    } catch (e) {
      observe("workspace-write", "unknown", false, safeError(e));
    }
    // Cancellation of an in-progress turn.
    const fourth = await session("review", "interrupt");
    try {
      let requested = false;
      const result = await turn(
        "interrupt",
        fourth,
        "This is an automated Topsl runtime qualification of cancellation. Do not run any commands. Write the numbers from 1 to 3000, one per line.",
        "review",
        undefined,
        (watch) => {
          if (requested || !watch.turnId) return;
          requested = true;
          void input.adapter
            .interrupt(connection, fourth, watch.turnId)
            .catch((e) => watch.fail(e));
        },
      );
      observe(
        "interrupt",
        "behavior-observed",
        requested && result.status === "interrupted",
        requested
          ? `Interrupt requested after the turn started; the turn ended ${result.status}.`
          : "The turn ended before an interrupt could be requested.",
      );
    } catch (e) {
      observe("interrupt", "unknown", false, safeError(e));
    }
  } catch (e) {
    error = safeError(e);
    remaining(
      [
        "structured-turn",
        "fresh-session",
        "read-only",
        "workspace-write",
        "interrupt",
      ],
      `Not reached: ${error}`,
    );
  } finally {
    closing = true;
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
  notTested.push({
    capability: "candidate-reader",
    reason:
      "This suite does not test the candidate reader yet; reviewer roles stay blocked.",
  });
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
