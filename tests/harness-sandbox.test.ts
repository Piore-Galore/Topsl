import { afterEach, describe, expect, test, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ContainmentPolicyError,
  ContainmentUnavailableError,
  QUALIFIED_RUNTIME_VERSION,
  RUNTIME_ADDED_VARIABLES,
  SECRET_HOME_PATHS,
  SHELL_MAINTAINED_VARIABLES,
  containmentHost,
  containmentStatus,
  minimalEnvironment,
  runContained,
  sandboxSettings,
  spawnContained,
  type ContainmentPolicy,
} from "../packages/harness/sandbox";

const directories: string[] = [];

async function directory(label: string): Promise<string> {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), `topsl-test-sandbox-${label}-`)),
  );
  directories.push(dir);
  return dir;
}

/**
 * One case's layout: a workspace copy, a not-yet-created task temp directory,
 * and a sibling directory outside both that the command must not touch.
 */
async function layout(writable = true) {
  const base = await directory("case");
  const workspaceRoot = path.join(base, "workspace");
  const tempRoot = path.join(base, "temp");
  const outside = path.join(base, "outside");
  await mkdir(workspaceRoot);
  await mkdir(outside);
  const policy: ContainmentPolicy = {
    workspaceRoot,
    writable,
    tempRoot,
    allowedDomains: [],
  };
  return { base, workspaceRoot, tempRoot, outside, policy };
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.TOPSL_SANDBOX_SENTINEL;
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.platform !== "darwin")("macOS containment", () => {
  test("containment is available with the qualified runtime", async () => {
    expect(await containmentStatus()).toEqual({
      available: true,
      mechanism: "macos-seatbelt",
      runtimeVersion: QUALIFIED_RUNTIME_VERSION,
      reason: null,
    });
  });

  test("a writable workspace can be read and written", async () => {
    const { workspaceRoot, tempRoot, policy } = await layout(true);
    const pids: number[] = [];
    const result = await runContained(
      [
        "/bin/sh",
        "-c",
        'echo hello > note.txt && cat note.txt && echo t > "$TMPDIR/t" && cat "$TMPDIR/t"',
      ],
      {
        cwd: workspaceRoot,
        policy,
        timeoutMs: 30_000,
        onSpawn: (pid) => pids.push(pid),
      },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hello\nt\n",
      timedOut: false,
      cancelled: false,
      started: true,
      violations: [],
    });
    expect(result.stderr).toBe("");
    expect(pids).toHaveLength(1);
    expect(existsSync(path.join(workspaceRoot, "note.txt"))).toBe(true);
    // tempRoot was created for the task and used as TMPDIR.
    expect(existsSync(path.join(tempRoot, "t"))).toBe(true);
  });

  test("a read-only policy blocks workspace writes but keeps reads and tempRoot", async () => {
    const { workspaceRoot, policy } = await layout(false);
    await writeFile(path.join(workspaceRoot, "existing.txt"), "kept\n");
    const read = await runContained(
      [
        "/bin/sh",
        "-c",
        'cat existing.txt && echo t > "$TMPDIR/t" && cat "$TMPDIR/t"',
      ],
      { cwd: workspaceRoot, policy, timeoutMs: 30_000 },
    );
    expect(read).toMatchObject({ exitCode: 0, stdout: "kept\nt\n" });
    const write = await runContained(["/bin/sh", "-c", "echo x > note.txt"], {
      cwd: workspaceRoot,
      policy,
      timeoutMs: 30_000,
    });
    expect(write.exitCode).not.toBe(0);
    expect(write.started).toBe(true);
    expect(write.stderr).toMatch(/Operation not permitted/);
    expect(write.violations.length).toBeGreaterThan(0);
    expect(existsSync(path.join(workspaceRoot, "note.txt"))).toBe(false);
  });

  test("writes outside the workspace and tempRoot are blocked", async () => {
    const { workspaceRoot, outside, policy } = await layout(true);
    await writeFile(path.join(outside, "neighbour.txt"), "other task\n");
    const tmpName = `/private/tmp/topsl-test-sandbox-escape-${process.pid}-${Date.now()}`;
    try {
      const result = await runContained(
        [
          "/bin/sh",
          "-c",
          'echo x > "$1/escape.txt"; a=$?; echo x > "$2"; b=$?; mkdir /tmp/claude/x 2>/dev/null; c=$?; cat "$1/neighbour.txt"; d=$?; echo "$a $b $c $d"',
          "sh",
          outside,
          tmpName,
        ],
        { cwd: workspaceRoot, policy, timeoutMs: 30_000 },
      );
      // Every attempt failed, including reading a sibling task's temp files
      // (the per-user temp directory is read-denied except the task's roots).
      expect(result.stdout.trim().split(" ").map(Number)).toEqual([1, 1, 1, 1]);
      expect(existsSync(path.join(outside, "escape.txt"))).toBe(false);
      expect(existsSync(tmpName)).toBe(false);
    } finally {
      await rm(tmpName, { force: true });
    }
  });

  test("denied locations are unreadable, even inside readable regions", async () => {
    const { workspaceRoot, policy, base } = await layout(true);
    const toolchain = path.join(base, "toolchain");
    await mkdir(path.join(toolchain, "secret"), { recursive: true });
    await writeFile(path.join(toolchain, "visible.txt"), "visible\n");
    await writeFile(path.join(toolchain, "secret", "key.txt"), "fake secret\n");
    await mkdir(path.join(workspaceRoot, "private"));
    await writeFile(
      path.join(workspaceRoot, "private", "data.txt"),
      "hidden\n",
    );
    const result = await runContained(
      [
        "/bin/sh",
        "-c",
        'cat "$1/visible.txt"; cat "$1/secret/key.txt"; a=$?; cat private/data.txt; b=$?; ls "$2" >/dev/null; c=$?; echo "$a $b $c"',
        "sh",
        toolchain,
        os.homedir(),
      ],
      {
        cwd: workspaceRoot,
        policy: {
          ...policy,
          extraReadable: [toolchain],
          denyRead: [
            path.join(toolchain, "secret"),
            path.join(workspaceRoot, "private"),
          ],
        },
        timeoutMs: 30_000,
      },
    );
    expect(result.stdout).toBe("visible\n1 1 1\n");
    expect(result.stdout).not.toMatch(/fake secret|hidden/);
    expect(result.stderr).toMatch(/Operation not permitted/);
  });

  test("a symlink inside the workspace cannot be used to write outside it", async () => {
    const { workspaceRoot, outside, policy } = await layout(true);
    await symlink(outside, path.join(workspaceRoot, "link"));
    const result = await runContained(
      [
        "/bin/sh",
        "-c",
        'echo x > link/escape.txt; a=$?; ln -s "$1" own-link && echo x > own-link/escape2.txt; b=$?; echo "$a $b"',
        "sh",
        outside,
      ],
      { cwd: workspaceRoot, policy, timeoutMs: 30_000 },
    );
    expect(result.stdout.trim()).toBe("1 1");
    expect(await readdir(outside)).toEqual([]);
    // A cwd that resolves outside the workspace through a symlink is refused.
    await expect(
      runContained(["/bin/pwd"], {
        cwd: path.join(workspaceRoot, "link"),
        policy,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(ContainmentPolicyError);
  });

  test("a timeout kills background descendants", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const marker = path.join(workspaceRoot, "marker");
    const result = await runContained(
      ["/bin/sh", "-c", '(sleep 2; touch "$1") & wait', "sh", marker],
      { cwd: workspaceRoot, policy, timeoutMs: 500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBeLessThan(2000);
    await sleep(3000);
    expect(existsSync(marker)).toBe(false);
  });

  test("descendants left running when the command finishes are killed", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const marker = path.join(workspaceRoot, "marker");
    const result = await runContained(
      [
        "/bin/sh",
        "-c",
        '(sleep 2; touch "$1") >/dev/null 2>&1 & echo started',
        "sh",
        marker,
      ],
      { cwd: workspaceRoot, policy, timeoutMs: 30_000 },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "started\n",
      timedOut: false,
    });
    await sleep(3000);
    expect(existsSync(marker)).toBe(false);
  });

  test("cancellation stops the command", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runContained(["/bin/sleep", "30"], {
      cwd: workspaceRoot,
      policy,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(5000);
  });

  test("exit status survives signals and output is bounded", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const killed = await runContained(["/bin/sh", "-c", "kill -TERM $$"], {
      cwd: workspaceRoot,
      policy,
      timeoutMs: 30_000,
    });
    // srt reports a command killed by SIGTERM as exit 0; the wrapper keeps 128+15.
    expect(killed.exitCode).toBe(143);
    const status = await runContained(["/bin/sh", "-c", "exit 3"], {
      cwd: workspaceRoot,
      policy,
      timeoutMs: 30_000,
    });
    expect(status.exitCode).toBe(3);
    const loud = await runContained(
      [
        "/bin/sh",
        "-c",
        "head -c 300000 /dev/zero | tr '\\0' a; head -c 300000 /dev/zero | tr '\\0' b >&2",
      ],
      { cwd: workspaceRoot, policy, timeoutMs: 30_000, maxOutputBytes: 1000 },
    );
    expect(loud).toMatchObject({
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(loud.stdout).toBe("a".repeat(1000));
    expect(loud.stderr).toBe("b".repeat(1000));
    const echoed = await runContained(["/bin/cat"], {
      cwd: workspaceRoot,
      policy,
      timeoutMs: 30_000,
      stdin: "from stdin\n",
    });
    expect(echoed).toMatchObject({
      exitCode: 0,
      stdout: "from stdin\n",
      stdoutTruncated: false,
    });
  });

  test("a settings document srt refuses runs nothing and reports not started", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const marker = path.join(workspaceRoot, "ran");
    // An unbracketed IPv6 literal passes Topsl's early check but not srt's
    // schema, so srt refuses the whole file instead of using defaults.
    const result = await runContained(["/usr/bin/touch", marker], {
      cwd: workspaceRoot,
      policy: { ...policy, allowedDomains: ["2001:db8::1"] },
      timeoutMs: 30_000,
    });
    expect(result.started).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to run/);
    expect(existsSync(marker)).toBe(false);
  });

  test("network is blocked without granted destinations", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const result = await runContained(
      ["/usr/bin/curl", "-sS", "--max-time", "5", "https://example.com"],
      { cwd: workspaceRoot, policy, timeoutMs: 30_000 },
    );
    expect(result.exitCode).not.toBe(0);
    // The sandbox's own proxy refuses the CONNECT before any DNS lookup, so the
    // reason is unambiguous even on a machine without network access.
    expect(result.stderr).toMatch(/response 403|Operation not permitted/);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  test("a granted destination is reachable through the sandbox proxy", async (context) => {
    const { workspaceRoot, policy } = await layout(true);
    const result = await runContained(
      [
        "/usr/bin/curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "10",
        "https://example.com",
      ],
      {
        cwd: workspaceRoot,
        policy: { ...policy, allowedDomains: ["example.com"] },
        timeoutMs: 30_000,
      },
    );
    // A proxy refusal would mean the grant did not apply: always a failure.
    expect(result.stderr).not.toMatch(/response 403/);
    // Anything else non-zero is this machine's network, not the sandbox.
    if (result.exitCode !== 0) context.skip();
    expect(result.stdout).toMatch(/^[23]\d\d$/);
  });

  test("concurrent commands keep their own policies", async () => {
    const a = await layout(true);
    const b = await layout(false);
    const script =
      'sleep 0.3; echo own > out.txt; o=$?; echo cross > "$1/cross.txt"; c=$?; echo "$o $c"';
    const [ra, rb] = await Promise.all([
      runContained(["/bin/sh", "-c", script, "sh", b.workspaceRoot], {
        cwd: a.workspaceRoot,
        policy: a.policy,
        timeoutMs: 30_000,
      }),
      runContained(["/bin/sh", "-c", script, "sh", a.workspaceRoot], {
        cwd: b.workspaceRoot,
        policy: b.policy,
        timeoutMs: 30_000,
      }),
    ]);
    expect(ra.stdout.trim()).toBe("0 1");
    expect(rb.stdout.trim()).toBe("1 1");
    expect(existsSync(path.join(a.workspaceRoot, "out.txt"))).toBe(true);
    expect(existsSync(path.join(b.workspaceRoot, "out.txt"))).toBe(false);
    expect(existsSync(path.join(a.workspaceRoot, "cross.txt"))).toBe(false);
    expect(existsSync(path.join(b.workspaceRoot, "cross.txt"))).toBe(false);
  });

  test("the child sees only the minimal environment", async () => {
    const { workspaceRoot, tempRoot, policy } = await layout(true);
    process.env.TOPSL_SANDBOX_SENTINEL = "parent-only";
    const granted = { ...policy, env: { TOPSL_TASK_FLAG: "on" } };
    const result = await runContained(["/usr/bin/env", "-0"], {
      cwd: workspaceRoot,
      policy: granted,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    const seen = new Map(
      result.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const at = entry.indexOf("=");
          return [entry.slice(0, at), entry.slice(at + 1)] as const;
        }),
    );
    const minimal = minimalEnvironment(granted);
    const realTemp = await realpath(tempRoot);
    expect(seen.get("HOME")).toBe(realTemp);
    expect(seen.get("TMPDIR")).toBe(realTemp);
    expect(seen.get("TERM")).toBe("dumb");
    expect(seen.get("LANG")).toBe("en_US.UTF-8");
    expect(seen.get("PATH")).toBe(minimal.PATH);
    expect(seen.get("TOPSL_TASK_FLAG")).toBe("on");
    expect(seen.has("TOPSL_SANDBOX_SENTINEL")).toBe(false);
    expect(seen.has("ELECTRON_RUN_AS_NODE")).toBe(false);
    const allowed = new Set([
      ...Object.keys(minimal),
      ...RUNTIME_ADDED_VARIABLES,
      ...SHELL_MAINTAINED_VARIABLES,
    ]);
    expect([...seen.keys()].filter((name) => !allowed.has(name))).toEqual([]);
  });

  test("credential-looking and reserved variables are refused", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const refused: Array<Record<string, string>> = [
      { GITHUB_TOKEN: "x" },
      { OPENAI_API_KEY: "x" },
      { HOME: "/" },
      { HTTPS_PROXY: "x" },
    ];
    for (const env of refused) {
      expect(() => minimalEnvironment({ ...policy, env })).toThrow(
        ContainmentPolicyError,
      );
      await expect(
        runContained(["/usr/bin/true"], {
          cwd: workspaceRoot,
          policy: { ...policy, env },
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow(ContainmentPolicyError);
    }
  });

  test("a cwd outside the workspace is refused", async () => {
    const { outside, policy } = await layout(true);
    const onSpawn = vi.fn();
    await expect(
      runContained(["/usr/bin/true"], {
        cwd: outside,
        policy,
        timeoutMs: 30_000,
        onSpawn,
      }),
    ).rejects.toThrow(ContainmentPolicyError);
    expect(onSpawn).not.toHaveBeenCalled();
  });

  test("the settings file is private, unwritable by the command and removed", async () => {
    const { workspaceRoot, policy } = await layout(true);
    // Short enough for srt's proxy socket path (macOS limits it to 104 bytes).
    const control = await realpath(await mkdtemp("/private/tmp/topsl-ctl-"));
    directories.push(control);
    vi.spyOn(containmentHost, "controlRoot").mockReturnValue(control);

    // A command that is told exactly where its settings file is still cannot
    // replace it or add anything beside it.
    const child = await spawnContained(
      [
        "/bin/sh",
        "-c",
        'read d; echo x > "$d/settings.json"; a=$?; echo x > "$d/injected"; b=$?; echo "$a $b"',
      ],
      { cwd: workspaceRoot, policy },
    );
    const entries = readdirSync(control);
    expect(entries).toHaveLength(1);
    const dir = path.join(control, entries[0]!);
    const settingsFile = path.join(dir, "settings.json");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual(
      sandboxSettings(policy),
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end(`${dir}\n`);
    await exited;
    await vi.waitFor(() => expect(output.trim()).toBe("1 1"));
    await vi.waitFor(async () => expect(await readdir(control)).toEqual([]));

    const result = await runContained(["/usr/bin/true"], {
      cwd: workspaceRoot,
      policy,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(await readdir(control)).toEqual([]);

    // A control directory inside a root the command can write is refused.
    vi.spyOn(containmentHost, "controlRoot").mockReturnValue(workspaceRoot);
    await expect(
      runContained(["/usr/bin/true"], {
        cwd: workspaceRoot,
        policy,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(ContainmentPolicyError);
  });

  test("spawnContained gives a stdio round trip under the same restrictions", async () => {
    const { workspaceRoot, outside, policy } = await layout(true);
    const child = await spawnContained(
      ["/bin/sh", "-c", 'cat; echo x > "$1/escape.txt"', "sh", outside],
      { cwd: workspaceRoot, policy },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    child.stdin.write("ping\n");
    await vi.waitFor(() => expect(output).toBe("ping\n"));
    child.stdin.end();
    expect(await exited).not.toBe(0);
    expect(existsSync(path.join(outside, "escape.txt"))).toBe(false);

    // kill() ends the whole group of a long-lived server.
    const server = await spawnContained(["/bin/sh", "-c", "sleep 30 & cat"], {
      cwd: workspaceRoot,
      policy,
    });
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    expect(server.kill()).toBe(true);
    await stopped;
  });

  test("startup latency stays bounded", async () => {
    const { workspaceRoot, policy } = await layout(true);
    const durations: number[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await runContained(["/usr/bin/true"], {
        cwd: workspaceRoot,
        policy,
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      durations.push(result.durationMs);
    }
    console.info(
      `contained /usr/bin/true durations (ms): ${durations.join(", ")}`,
    );
    expect(Math.min(...durations)).toBeLessThan(5000);
  });
});

describe.skipIf(process.platform === "win32")("containment policy", () => {
  test("the settings document is explicit and narrow", async () => {
    const { workspaceRoot, tempRoot, policy } = await layout(false);
    const home = await realpath(os.homedir());
    const denied = path.join(workspaceRoot, "private");
    const settings = sandboxSettings({
      ...policy,
      denyRead: [denied],
      allowedDomains: ["registry.npmjs.org"],
    });
    // layout() returns real paths, and tempRoot does not exist yet.
    const realTemp = tempRoot;
    expect(settings).toEqual({
      network: {
        allowedDomains: ["registry.npmjs.org"],
        deniedDomains: [],
        strictAllowlist: true,
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      filesystem: {
        denyRead: [
          home,
          await realpath(os.tmpdir()),
          "/private/tmp",
          ...SECRET_HOME_PATHS.map((rel) => path.join(home, rel)),
          denied,
        ],
        allowRead: [workspaceRoot, realTemp],
        allowWrite: [realTemp],
        denyWrite: ["/tmp/claude", "/private/tmp/claude"],
        allowGitConfig: false,
      },
      allowPty: false,
      allowAppleEvents: false,
      enableWeakerNetworkIsolation: false,
    });
    const writable = sandboxSettings({ ...policy, writable: true }) as {
      filesystem: { allowWrite: string[] };
    };
    expect(writable.filesystem.allowWrite).toEqual([workspaceRoot, realTemp]);
  });

  test("unsafe roots are refused", async () => {
    const { workspaceRoot, tempRoot, policy } = await layout(true);
    const home = os.homedir();
    for (const bad of [
      { ...policy, workspaceRoot: home },
      { ...policy, workspaceRoot: "/" },
      { ...policy, tempRoot: path.join(workspaceRoot, "tmp") },
      { ...policy, workspaceRoot: path.join(tempRoot, "ws") },
      { ...policy, tempRoot: path.join(home, ".ssh", "topsl") },
      { ...policy, tempRoot: "/tmp/claude/topsl" },
      { ...policy, extraReadable: [path.join(home, ".aws")] },
      { ...policy, workspaceRoot: "relative/path" },
      { ...policy, allowedDomains: ["https://example.com/"] },
    ])
      expect(() => sandboxSettings(bad)).toThrow(ContainmentPolicyError);
  });

  test("on other platforms containment is unavailable and nothing runs", async () => {
    const { workspaceRoot, policy } = await layout(true);
    vi.spyOn(containmentHost, "platform").mockReturnValue("linux");
    const status = await containmentStatus();
    expect(status).toMatchObject({ available: false, mechanism: null });
    expect(status.reason).toMatch(/macOS/);
    const onSpawn = vi.fn();
    await expect(
      runContained(["/usr/bin/true"], {
        cwd: workspaceRoot,
        policy,
        timeoutMs: 30_000,
        onSpawn,
      }),
    ).rejects.toThrow(ContainmentUnavailableError);
    await expect(
      spawnContained(["/bin/cat"], { cwd: workspaceRoot, policy }),
    ).rejects.toThrow(ContainmentUnavailableError);
    expect(onSpawn).not.toHaveBeenCalled();
  });
});
