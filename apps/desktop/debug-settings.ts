/**
 * Debug switches for a local, unpackaged run (`npm run debug`). A packaged
 * Topsl ignores every one of them. Inspector ports bind to 127.0.0.1 only.
 */
export interface DebugSettings {
  /** Open the window's DevTools, detached, when it is first shown. */
  devTools: boolean;
  /** Print the control service's and proxy's output to this terminal. */
  logs: boolean;
  /** Node inspector port for the control service process, or null. */
  serviceInspectPort: number | null;
  /** Node inspector port for the local proxy process, or null. */
  proxyInspectPort: number | null;
}

function port(value: string | undefined, name: string): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535)
    throw new Error(`${name} must be a port number from 1024 to 65535.`);
  return n;
}

export function debugSettings(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): DebugSettings | null {
  if (packaged) return null;
  const settings: DebugSettings = {
    devTools: env.TOPSL_DEBUG_DEVTOOLS === "1",
    logs: env.TOPSL_DEBUG_LOGS === "1",
    serviceInspectPort: port(
      env.TOPSL_DEBUG_SERVICE_INSPECT,
      "TOPSL_DEBUG_SERVICE_INSPECT",
    ),
    proxyInspectPort: port(
      env.TOPSL_DEBUG_PROXY_INSPECT,
      "TOPSL_DEBUG_PROXY_INSPECT",
    ),
  };
  return settings.devTools ||
    settings.logs ||
    settings.serviceInspectPort !== null ||
    settings.proxyInspectPort !== null
    ? settings
    : null;
}

/** The utility-process arguments that open its inspector, if one is asked for. */
export function inspectArgs(port: number | null): string[] {
  return port === null ? [] : [`--inspect=127.0.0.1:${port}`];
}

/**
 * Prints a child process's output with a label, or drains it unread as a
 * normal run does.
 */
export function childOutput(
  child: {
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
  },
  label: string,
  print: boolean,
): void {
  for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    if (!stream) continue;
    if (!print) {
      stream.resume();
      continue;
    }
    let carry = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (carry + chunk).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) sink.write(`[${label}] ${line}\n`);
    });
    stream.on("end", () => {
      if (carry) sink.write(`[${label}] ${carry}\n`);
    });
  }
}
