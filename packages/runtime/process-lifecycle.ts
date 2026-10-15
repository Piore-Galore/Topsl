import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { nativeEnvironment } from "../platform/system";
import { now } from "../domain/invariants";

export interface ProcessEvidence {
  version: 1;
  pid: number | null;
  groupId: number | null;
  scope: "posix-process-group" | "windows-process-tree" | "child-and-stdio";
  state: "running" | "stopping" | "quiescent" | "uncertain";
  startedAt: string;
  stopRequestedAt: string | null;
  exitedAt: string | null;
  closedAt: string | null;
  observedAt: string;
  exitCode: number | null;
  signal: string | null;
  remainingGroup: "present" | "absent" | "unknown";
  remainingDescendants?: number[];
  detail: string;
}
/** CIM preserves ParentProcessId when the parent exits. This observes the
 * current process tree; it is not a Windows Job or an escape-proof containment
 * guarantee. Unavailable/ambiguous observations retain ownership. */
export async function windowsDescendants(
  pid: number,
  startedAt: string,
): Promise<number[] | null> {
  const executable = path.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script =
    "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        shell: false,
        timeout: 4_000,
        maxBuffer: 2_000_000,
        env: nativeEnvironment(),
      },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "")),
            rows = Array.isArray(parsed) ? parsed : [parsed];
          if (
            !rows.length ||
            rows.some(
              (r: any) =>
                !Number.isInteger(r.pid) ||
                !Number.isInteger(r.parent) ||
                !Number.isFinite(Date.parse(r.created)),
            )
          )
            return resolve(null);
          const family = new Set([pid]),
            descendants = new Set<number>();
          for (let i = 0; i < rows.length; i++) {
            let changed = false;
            for (const row of rows) {
              if (
                row.pid === pid ||
                !family.has(row.parent) ||
                family.has(row.pid) ||
                Date.parse(row.created) < Date.parse(startedAt) - 2_000
              )
                continue;
              family.add(row.pid);
              descendants.add(row.pid);
              changed = true;
            }
            if (!changed) break;
          }
          resolve([...descendants]);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Observation only: a POSIX process group is not a sandbox. Processes which
 * deliberately escape it require a separately qualified containment route. */
export function processGroupPresent(groupId: number): boolean | null {
  if (process.platform === "win32") return null;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error: any) {
    return error.code === "ESRCH" ? false : null;
  }
}

export class ProcessLifecycle {
  private evidence: ProcessEvidence;
  private closePromise?: Promise<ProcessEvidence>;
  private closed: Promise<void>;
  private exited = false;
  private stdioClosed = false;
  constructor(
    readonly child: ChildProcess,
    private grouped = process.platform !== "win32",
    private observe: (value: ProcessEvidence) => void = () => {},
  ) {
    const at = now();
    this.evidence = {
      version: 1,
      pid: child.pid ?? null,
      groupId: grouped ? (child.pid ?? null) : null,
      scope: grouped
        ? "posix-process-group"
        : process.platform === "win32"
          ? "windows-process-tree"
          : "child-and-stdio",
      state: "running",
      startedAt: at,
      stopRequestedAt: null,
      exitedAt: null,
      closedAt: null,
      observedAt: at,
      exitCode: null,
      signal: null,
      remainingGroup: grouped ? "present" : "unknown",
      detail:
        "Child started. Exit, stdio closure and group absence are separate observations.",
    };
    child.once("exit", (code, signal) => {
      this.exited = true;
      this.update({ exitedAt: now(), exitCode: code, signal });
    });
    this.closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.exited = true;
        this.stdioClosed = true;
        this.update({ closedAt: now(), exitCode: code, signal });
        resolve();
      });
    });
  }
  snapshot(): ProcessEvidence {
    return { ...this.evidence };
  }
  private update(patch: Partial<ProcessEvidence>): void {
    this.evidence = { ...this.evidence, ...patch, observedAt: now() };
    this.observe(this.snapshot());
  }
  private signal(signal: NodeJS.Signals): void {
    try {
      if (this.grouped && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error: any) {
      if (error.code !== "ESRCH")
        this.update({
          detail: `Termination signal failed (${error.code ?? "unknown"}).`,
        });
    }
  }
  /** Bounded and idempotent; returning uncertainty never grants reuse. */
  stop(timeoutMs = 5_000): Promise<ProcessEvidence> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.settle(true, timeoutMs);
    return this.closePromise;
  }
  async completion(timeoutMs: number): Promise<ProcessEvidence> {
    const result = await this.settle(false, timeoutMs);
    // A cancellation/timeout may start stop() while completion is waiting.
    // Await its observations too, so callers can safely close persistence.
    return this.closePromise ? await this.closePromise : result;
  }
  private async settle(
    stop: boolean,
    timeoutMs: number,
  ): Promise<ProcessEvidence> {
    const settleStarted = Date.now();
    if (stop) {
      this.update({ state: "stopping", stopRequestedAt: now() });
      this.signal("SIGTERM");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = await Promise.race([
      this.closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!complete && stop) {
      this.signal("SIGKILL");
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_000);
        }),
      ]);
      clearTimeout(timer);
    }
    if (this.grouped && this.child.pid && this.stdioClosed) {
      // The leader can exit before other members of its owned group finish
      // handling the same signal. Allow a bounded grace period, and for an
      // explicit stop escalate the remaining group instead of leaving it alive.
      const pid = this.child.pid,
        graceUntil = Math.max(
          Date.now() + 250,
          stop && complete ? settleStarted + timeoutMs : Date.now() + 1_000,
        );
      const settled = async (until: number) => {
        while (processGroupPresent(pid) === true && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 25));
      };
      await settled(graceUntil);
      if (stop && processGroupPresent(pid) === true) {
        this.signal("SIGKILL");
        await settled(Date.now() + 1_000);
      }
    }
    const descendants =
      !this.grouped && process.platform === "win32" && this.child.pid
        ? await windowsDescendants(this.child.pid, this.evidence.startedAt)
        : null;
    const group =
      this.grouped && this.child.pid
        ? processGroupPresent(this.child.pid)
        : descendants
          ? descendants.length > 0
          : null;
    const quiescent = this.exited && this.stdioClosed && group === false;
    this.update({
      state: quiescent ? "quiescent" : "uncertain",
      remainingGroup:
        group === true ? "present" : group === false ? "absent" : "unknown",
      remainingDescendants: descendants ?? undefined,
      detail: quiescent
        ? this.grouped
          ? "Child exit, stdio closure and owned POSIX process-group absence observed. Detached/escaped descendants are outside this observation boundary."
          : "Child exit, stdio closure and current Windows CIM descendant-tree absence observed. This is a scoped process-tree observation, not Job containment; ancestry lost before observation remains outside coverage."
        : "Task quiescence is unproven. Preserve resources and ownership; child exit alone does not establish descendant termination.",
    });
    return this.snapshot();
  }
}
