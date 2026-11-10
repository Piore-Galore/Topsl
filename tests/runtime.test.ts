import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import { chmod, rm, writeFile } from "node:fs/promises";
import { spawn as spawnPty } from "node-pty";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { now } from "../packages/domain/invariants";
import type { Approval, Run } from "../packages/domain/types";
import { fixture } from "./helpers";
const fixtures: Array<
  Awaited<ReturnType<typeof fixture>> & { runtime: RuntimeManager }
> = [];
async function setup(account = "chatgpt") {
  const f = await fixture();
  const runtime = new RuntimeManager(
    f.store,
    () => {},
    () => {},
    (_executable, cwd) =>
      new RpcPeer(
        process.execPath,
        [path.resolve("tests/fixtures/codex.cjs")],
        cwd,
        {
          ...nativeEnvironment(),
          ELECTRON_RUN_AS_NODE: "1",
          FIXTURE_ACCOUNT_TYPE: account,
        },
      ),
  );
  fixtures.push({ ...f, runtime });
  const project = {
    id: "p",
    name: "fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  };
  const conversation = {
    id: "c",
    projectId: "p",
    title: "Fixture chat",
    nativeSessions: {},
    createdAt: now(),
  };
  f.store.put("project", project);
  f.store.put("conversation", conversation);
  return { ...f, runtime, project, conversation };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.runtime.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
describe("native process adapter", () => {
  test.skipIf(process.platform === "win32")(
    "a direct structured chat through the native broker is not gated by coordinated role readiness",
    async () => {
      const f = await fixture();
      // A real launched executable (not an injected peer), so the manager uses
      // its production route rather than isolated fixture mode.
      await writeFile(
        f.installation.path,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/codex.cjs"))}\n`,
      );
      await chmod(f.installation.path, 0o700);
      const installation = {
        ...f.installation,
        ...(await identity(f.installation.path)),
      };
      f.store.put("installation", installation);
      const runtime = new RuntimeManager(
        f.store,
        () => {},
        () => {},
      );
      fixtures.push({ ...f, runtime });
      const project = {
        id: "p",
        name: "fixture",
        path: f.directory,
        realPath: f.directory,
        trusted: true,
        createdAt: now(),
      };
      const conversation = {
        id: "c",
        projectId: "p",
        title: "Fixture chat",
        nativeSessions: {},
        createdAt: now(),
      };
      f.store.put("project", project);
      f.store.put("conversation", conversation);
      // No runtime qualification has been recorded for this binding.
      expect(
        runtime.readiness(
          installation,
          {
            installationId: installation.id,
            provider: "codex",
            model: "fixture-model",
          },
          "implementer",
        ).ready,
      ).toBe(false);
      const run = await runtime.start(
        installation,
        conversation,
        project,
        "hello",
        "fixture-model",
        "review",
      );
      await vi.waitFor(() =>
        expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"),
      );
    },
  );
  test("protocol probe loads native models without submitting a turn", async () => {
    const f = await setup();
    const info = await f.runtime.inspect(f.installation);
    expect(info.models[0].model).toBe("fixture-model");
    expect(info.account.type).toBe("chatgpt");
    expect(f.store.list("run")).toHaveLength(0);
  });
  test("streaming preserves exact run revision, native IDs, and deduplicated usage", async () => {
    const f = await setup();
    const run = await f.runtime.start(
      f.installation,
      f.conversation,
      f.project,
      "hello",
      "fixture-model",
      "review",
    );
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"),
    );
    const saved = f.store.get<Run>("run", run.id)!;
    expect(saved.installationRevisionId).toBe(f.installation.revisionId);
    expect(saved.nativeSessionId).toBe("thread-fixture");
    expect(saved.nativeTurnId).toBe("turn-fixture");
    expect(f.store.list("usage")).toHaveLength(1);
    expect(f.store.list<any>("usage")[0].input).toBe(12);
    expect(f.store.list("message")).toHaveLength(2);
  });
  test("a turn's usage covers every model request, and the next turn starts from zero", async () => {
    const f = await setup();
    const turn = async (prompt: string) => {
      const run = await f.runtime.start(
        f.installation,
        f.store.get<typeof f.conversation>("conversation", "c")!,
        f.project,
        prompt,
        "fixture-model",
        "review",
      );
      await vi.waitFor(() =>
        expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"),
      );
      return f.store.list<any>("usage").filter((fact) => fact.runId === run.id);
    };
    const sum = { input: 250, output: 30, cached: 130 };
    const first = await turn("two requests");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject(sum);
    const second = await turn("two requests");
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject(sum);
  });
  test("usage without a thread total falls back to the last request", async () => {
    const f = await setup();
    const run = await f.runtime.start(
      f.installation,
      f.conversation,
      f.project,
      "usage without total",
      "fixture-model",
      "review",
    );
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"),
    );
    expect(f.store.list<any>("usage")).toHaveLength(1);
    expect(f.store.list<any>("usage")[0]).toMatchObject({
      input: 7,
      output: 2,
      cached: 1,
    });
  });
  test("review mode cannot grant escalation requests", async () => {
    const f = await setup();
    const run = await f.runtime.start(
      f.installation,
      f.conversation,
      f.project,
      "approval",
      "fixture-model",
      "review",
    );
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"),
    );
    expect(f.store.list("approval")).toHaveLength(0);
    expect(f.store.list<any>("message").some((m) => m.text === "decline")).toBe(
      true,
    );
  });
  test("editing approval is bound to the exact native request and consumed once", async () => {
    const f = await setup();
    const run = await f.runtime.start(
      f.installation,
      f.conversation,
      f.project,
      "approval",
      "fixture-model",
      "edit",
    );
    await vi.waitFor(() => expect(f.store.list("approval")).toHaveLength(1));
    const a = f.store.list<Approval>("approval")[0];
    expect(a.runId).toBe(run.id);
    expect(() => f.runtime.decide(a.id, "stale", true)).toThrow("stale");
    f.runtime.decide(a.id, a.digest, true);
    expect(() => f.runtime.decide(a.id, a.digest, true)).toThrow("stale");
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"),
    );
  });
  test("requests for other native threads are never approved", async () => {
    const f = await setup();
    const run = await f.runtime.start(
      f.installation,
      f.conversation,
      f.project,
      "wrong-thread-approval",
      "fixture-model",
      "edit",
    );
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"),
    );
    expect(f.store.list("approval")).toHaveLength(0);
  });
  test("a project has one writer; interruption uses its native turn ID", async () => {
    const f = await setup();
    const run = await f.runtime.start(
      f.installation,
      f.conversation,
      f.project,
      "hold",
      "fixture-model",
      "edit",
    );
    await expect(
      f.runtime.start(
        f.installation,
        f.conversation,
        f.project,
        "hello",
        "fixture-model",
        "edit",
      ),
    ).rejects.toThrow("already has");
    await f.runtime.interrupt(run.id);
    await vi.waitFor(() =>
      expect(f.store.get<Run>("run", run.id)?.status).toBe("interrupted"),
    );
  });
  test.each(["crash", "malformed"])(
    "uncertain %s is recorded, never replayed, and blocks another writer",
    async (prompt) => {
      const f = await setup();
      await expect(
        f.runtime.start(
          f.installation,
          f.conversation,
          f.project,
          prompt,
          "fixture-model",
          "edit",
        ),
      ).rejects.toThrow();
      expect(f.store.list<Run>("run")[0].status).toBe("uncertain");
      await expect(
        f.runtime.start(
          f.installation,
          f.conversation,
          f.project,
          "hello",
          "fixture-model",
          "edit",
        ),
      ).rejects.toThrow("uncertain");
    },
  );
  test("reconciliation identifies the process behind a recorded PID instead of trusting liveness", async () => {
    const f = await setup();
    await expect(
      f.runtime.start(
        f.installation,
        f.conversation,
        f.project,
        "crash",
        "fixture-model",
        "edit",
      ),
    ).rejects.toThrow();
    const run = f.store.list<Run>("run")[0];
    expect(run.status).toBe("uncertain");
    // A live process this user may not signal holds the recorded PID.
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (pid === 999_999 && signal === 0)
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return realKill(pid, signal as any);
    }) as typeof process.kill);
    try {
      // Same boot and nothing that identifies the process: still refused.
      f.store.save("run", { ...run, nativePid: 999_999 });
      f.store.save("installation", {
        ...f.store.get<any>("installation", run.installationId),
        realPath: path.join(f.directory, "missing-runtime"),
      });
      await expect(f.runtime.reconcile(run.id)).rejects.toThrow(
        "The native process is still present.",
      );
      // A run from before this boot cannot own any process alive now.
      f.store.save("run", {
        ...f.store.get<Run>("run", run.id)!,
        createdAt: new Date(0).toISOString(),
      });
      await f.runtime.reconcile(run.id);
      expect(f.store.get<Run>("run", run.id)?.status).toBe("interrupted");
    } finally {
      kill.mockRestore();
    }
  });
  test("API billing mode cannot silently replace subscription execution", async () => {
    const f = await setup("apiKey");
    await expect(
      f.runtime.start(
        f.installation,
        f.conversation,
        f.project,
        "hello",
        "fixture-model",
        "edit",
      ),
    ).rejects.toThrow("subscription login");
    expect(f.store.list<Run>("run")[0].status).toBe("failed");
  });
  test("changing the native account cannot silently resume private history", async () => {
    const f = await setup();
    const conversation = {
      ...f.conversation,
      nativeSessions: { codex: "previous-thread" },
      nativeAccounts: { codex: "different-account" },
    };
    await expect(
      f.runtime.start(
        f.installation,
        conversation,
        f.project,
        "hello",
        "fixture-model",
        "review",
      ),
    ).rejects.toThrow("account changed");
    expect(f.store.list<Run>("run")[0].status).toBe("failed");
  });
  test("untrusted executable never starts", async () => {
    const f = await setup();
    await expect(
      f.runtime.inspect({ ...f.installation, trusted: false }),
    ).rejects.toThrow("trust");
  });
  test("native PTY loads and carries actual process output", async () => {
    const result = await new Promise<{ output: string; exitCode: number }>(
      (resolve, reject) => {
        // Electron is a GUI-subsystem executable on Windows. Exercise ConPTY with
        // a console-subsystem child, as real native CLI installations use.
        const windows = process.platform === "win32";
        const term = spawnPty(
          windows
            ? path.join(
                process.env.SystemRoot ??
                  process.env.SYSTEMROOT ??
                  "C:\\Windows",
                "System32",
                "cmd.exe",
              )
            : process.execPath,
          windows
            ? ["/d", "/s", "/c", "echo TOPSL_PTY_OK"]
            : ["-e", 'process.stdout.write("TOPSL_PTY_OK")'],
          {
            cwd: process.cwd(),
            env: { ...nativeEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
            cols: 80,
            rows: 24,
          },
        );
        let data = "";
        const timer = setTimeout(() => {
          term.kill();
          reject(new Error("PTY did not exit"));
        }, 10000);
        term.onData((chunk) => {
          data += chunk;
        });
        term.onExit(({ exitCode }) => {
          clearTimeout(timer);
          resolve({ output: data, exitCode });
        });
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("TOPSL_PTY_OK");
  });
});
