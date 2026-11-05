import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * macOS recovery evidence for a contained process. A persisted PID alone may
 * refer to an unrelated process after a restart. Hash creation time, owner,
 * process group and command without retaining command-line text in history.
 * This is a conservative observation, not an operating-system process handle:
 * missing or changed evidence must never authorize a signal.
 */
export function nativeProcessIdentity(pid: number): string | null {
  if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 1)
    return null;
  try {
    const value = execFileSync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "lstart=,uid=,pgid=,command="],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        maxBuffer: 64 * 1024,
      },
    ).trim();
    return value ? createHash("sha256").update(value).digest("hex") : null;
  } catch {
    return null;
  }
}
