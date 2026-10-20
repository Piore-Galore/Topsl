// Campaign 2026-10-19-comprehensive, packet p3a-apps-providers-terminals.
// Runtime manager, real-subprocess and service-command contracts: PR-01/02/03
// (preflight before spawn), PR-07/PR-10 over a real Claude stand-in process,
// PR-07/PR-08 over a real JSON-RPC child, PR-14 approval expiry/close races,
// TM-01 (service-level mode refusal and no shell interpretation), TM-10
// (assisted export bound) and TM-11 (reserved runtime-login). Every provider is
// a local stand-in; no model, account or network is used.
import { afterEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { now } from "../packages/domain/invariants";
import type {
  Approval,
  Installation,
  Message,
  Provider,
  Run,
  ServiceEvent,
} from "../packages/domain/types";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { Service } from "../apps/service/service";
import { captureCandidate } from "../packages/workflows/candidates";
import { AssistedWorkflows } from "../packages/workflows/assisted";
import type { TerminalModeId } from "../packages/domain/terminal-modes";
import { commandSchema } from "../packages/domain/commands";
import { fixture } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});
const codexStandIn = path.resolve("tests/fixtures/codex.cjs");
const posix = process.platform !== "win32";

/** A runtime manager over the Codex stand-in that records every spawn. */
async function managerSetup(adapters: ConstructorParameters<typeof RuntimeManager>[5] = {}) {
  const f = await fixture();
  const spawned: string[] = [];
  const runtime = new RuntimeManager(
    f.store,
    () => {},
    () => {},
    (_executable, cwd) => {
      spawned.push(cwd);
      return new RpcPeer(process.execPath, [codexStandIn], cwd, {
        ...nativeEnvironment(),
        ELECTRON_RUN_AS_NODE: "1",
      });
    },
    undefined,
    adapters,
  );
  cleanup.push(async () => {
    await runtime.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
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
  const heldLeases = () =>
    runtime.coordinator.ownership.list().filter((l) => l.state !== "released");
  return { ...f, runtime, project, conversation, spawned, heldLeases };
}

// ---------------------------------------------------------------------------
// PR-01 / PR-02 / PR-03 preflight refuses before any process or run exists
// ---------------------------------------------------------------------------
describe("PR-01/02/03 preflight refuses before spawn at every manager entry point", () => {
  test.skipIf(!posix)(
    "an untrusted executable starts nothing through inspect, chat (review and edit) or terminal",
    async () => {
      const f = await managerSetup();
      // A real executable that leaves a marker if anything ever runs it.
      const marker = path.join(f.directory, "SPAWNED");
      await writeFile(f.installation.path, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nsleep 1\n`);
      await chmod(f.installation.path, 0o700);
      const trusted: Installation = { ...f.installation, ...(await identity(f.installation.path)) };
      const untrusted = { ...trusted, trusted: false };
      f.store.put("installation", untrusted);
      await expect(f.runtime.inspect(untrusted)).rejects.toThrow("trust");
      for (const mode of ["review", "edit"] as const)
        await expect(
          f.runtime.start(untrusted, f.conversation, f.project, "hello", "fixture-model", mode),
        ).rejects.toThrow("trust");
      await expect(f.runtime.terminal(untrusted, f.project, {})).rejects.toThrow("trust");
      await expect(
        f.runtime.terminal(untrusted, f.project, { login: true }),
      ).rejects.toThrow("trust");
      expect(f.spawned).toEqual([]);
      expect(f.store.list("run")).toEqual([]);
      expect(f.store.list("approval")).toEqual([]);
      expect(f.heldLeases()).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      // Positive control: the same executable, trusted, is spawned and leaves its marker.
      f.store.put("installation", trusted);
      const id = await f.runtime.terminal(trusted, f.project, {});
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      f.runtime.terminalClose(id);
    },
  );
  test("replacing the trusted bytes refuses new dispatch, while the earlier run keeps its original identity", async () => {
    const f = await managerSetup();
    const first = await f.runtime.start(f.installation, f.conversation, f.project, "hello", "fixture-model", "review");
    await vi.waitFor(() => expect(f.store.get<Run>("run", first.id)?.status).toBe("completed"));
    // The run is saved "completed" before the coordinator confirms the child's
    // exit and releases the workspace lease; on Windows that confirmation can
    // trail the status, and a held lease would refuse the next dispatch with
    // the workspace-lease message before preflight is observable. Wait for the
    // release so only the executable identity can refuse below.
    await vi.waitFor(() => expect(f.heldLeases()).toEqual([]), { timeout: 15_000 });
    expect(f.spawned).toHaveLength(1);
    const original = f.store.get<Run>("run", first.id)!;
    expect(original.executableIdentity).toBe(f.installation.identity);
    // Same path and version label, different bytes.
    await writeFile(f.installation.path, "replacement bytes with the same version label");
    for (const mode of ["review", "edit"] as const)
      await expect(
        f.runtime.start(f.installation, f.conversation, f.project, "hello", "fixture-model", mode),
      ).rejects.toThrow("executable changed");
    await expect(f.runtime.terminal(f.installation, f.project, {})).rejects.toThrow("executable changed");
    await expect(f.runtime.inspect(f.installation)).rejects.toThrow("executable changed");
    expect(f.spawned).toHaveLength(1);
    expect(f.store.list<Run>("run").map((r) => r.id)).toEqual([first.id]);
    expect(f.store.get<Run>("run", first.id)).toMatchObject({
      executableIdentity: original.executableIdentity,
      installationRevisionId: original.installationRevisionId,
      runtimeVersion: "1.0.0",
      status: "completed",
    });
    expect(f.heldLeases()).toEqual([]);
  });
  test("an API or third-party billing variable in the launch environment refuses dispatch without naming its value", async () => {
    const f = await managerSetup();
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"]) {
      const previous = process.env[name];
      process.env[name] = "sk-campaign-canary-value";
      try {
        let message = "";
        await f.runtime
          .start(f.installation, f.conversation, f.project, "hello", "fixture-model", "edit")
          .catch((e) => (message = String(e.message)));
        expect(message, name).toContain(name);
        expect(message).toContain("billing environment");
        expect(message).not.toContain("sk-campaign-canary-value");
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
    expect(f.spawned).toEqual([]);
    expect(f.store.list("run")).toEqual([]);
    // Negative control: with the variable gone, the same dispatch runs.
    const run = await f.runtime.start(f.installation, f.conversation, f.project, "hello", "fixture-model", "review");
    await vi.waitFor(() => expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"));
  });
});

// ---------------------------------------------------------------------------
// PR-14 approval expiry and close/interrupt races
// ---------------------------------------------------------------------------
async function waitingApproval(f: Awaited<ReturnType<typeof managerSetup>>) {
  const run = await f.runtime.start(f.installation, f.conversation, f.project, "approval", "fixture-model", "edit");
  await vi.waitFor(() => expect(f.store.list("approval")).toHaveLength(1));
  return { run, approval: f.store.list<Approval>("approval")[0] };
}
const replies = (f: Awaited<ReturnType<typeof managerSetup>>) =>
  f.store.list<Message>("message").map((m) => m.text);

describe("PR-14 a stale approval can never execute", () => {
  test("exactly 15 minutes after the request an approval still decides", async () => {
    const f = await managerSetup();
    const { run, approval } = await waitingApproval(f);
    const created = Date.parse(approval.createdAt);
    vi.spyOn(Date, "now").mockReturnValue(created + 15 * 60_000);
    f.runtime.decide(approval.id, approval.digest, true);
    vi.restoreAllMocks();
    await vi.waitFor(() => expect(f.store.get<Run>("run", run.id)?.status).toBe("completed"));
    expect(replies(f)).toContain("accept");
  });
  test("one millisecond past expiry the decision is refused, the request keeps waiting, and after interrupt the old digest is stale", async () => {
    const f = await managerSetup();
    const { run, approval } = await waitingApproval(f);
    const created = Date.parse(approval.createdAt);
    vi.spyOn(Date, "now").mockReturnValue(created + 15 * 60_000 + 1);
    expect(() => f.runtime.decide(approval.id, approval.digest, true)).toThrow("Approval expired");
    vi.restoreAllMocks();
    // Nothing was answered: the run still waits and the request is still recorded.
    expect(f.store.get<Run>("run", run.id)?.status).toBe("awaiting-approval");
    expect(f.store.get("approval", approval.id)).toBeDefined();
    await f.runtime.interrupt(run.id);
    await vi.waitFor(() => expect(f.store.get<Run>("run", run.id)?.status).toBe("interrupted"));
    expect(() => f.runtime.decide(approval.id, approval.digest, true)).toThrow("stale");
    expect(f.store.get("approval", approval.id)).toBeUndefined();
    expect(replies(f)).not.toContain("accept");
    expect(f.store.get<Run>("run", run.id)?.status).toBe("interrupted");
  });
  test("closing Topsl during a pending approval leaves the run uncertain; the old digest is stale now and after restart", async () => {
    const f = await managerSetup();
    const { run, approval } = await waitingApproval(f);
    await f.runtime.close();
    expect(f.store.get<Run>("run", run.id)?.status).toBe("uncertain");
    expect(f.store.list("approval")).toEqual([]);
    expect(() => f.runtime.decide(approval.id, approval.digest, true)).toThrow("stale");
    const restarted = new RuntimeManager(f.store, () => {}, () => {}, () => {
      throw new Error("a restart must not spawn");
    });
    cleanup.push(() => restarted.close());
    expect(() => restarted.decide(approval.id, approval.digest, true)).toThrow("stale");
    expect(f.store.get<Run>("run", run.id)?.status).toBe("uncertain");
    expect(replies(f)).not.toContain("accept");
    // Uncertain ownership blocks another writer until reconciled.
    await expect(
      restarted.start(f.installation, f.conversation, f.project, "hello", "fixture-model", "edit"),
    ).rejects.toThrow(/uncertain/);
  });
});

// ---------------------------------------------------------------------------
// PR-07 / PR-10 through a real Claude stand-in process and the runtime manager
// ---------------------------------------------------------------------------
const multibyte = "héllo 中文 😀 👩‍👩‍👧 ﷽";
/** Writes a Claude stand-in script: it emits `records` (with the session id
 * substituted) as UTF-8 bytes in small chunks, with pauses, so chunk
 * boundaries fall inside multibyte characters. */
async function claudeStandIn(directory: string, name: string, records: unknown[]) {
  const file = path.join(directory, `${name}.cjs`);
  await writeFile(
    file,
    `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const session = process.argv[process.argv.indexOf("--session-id") + 1];
  const text = ${JSON.stringify(records)}.map((r) => JSON.stringify(r).replaceAll("@SESSION@", session)).join("\\n") + "\\n";
  const bytes = Buffer.from(text, "utf8");
  let at = 0, n = 0;
  const step = () => {
    if (at >= bytes.length) return;
    const size = 1 + ((n++ * 7) % 4);
    process.stdout.write(bytes.subarray(at, at + size));
    at += size;
    setTimeout(step, 1);
  };
  step();
});
`,
  );
  return file;
}
const session = "@SESSION@";
function claudeRecords(isError: boolean) {
  return [
    { type: "system", subtype: "init", session_id: session, model: "fx-effective", tools: [], uuid: "i" },
    { type: "stream_event", session_id: session, uuid: "st", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", session_id: session, uuid: "d1", event: { type: "content_block_delta", delta: { type: "text_delta", text: multibyte } } },
    { type: "assistant", session_id: session, uuid: "a0", message: { id: "m1", content: [{ type: "thinking", thinking: "thinking-canary" }] } },
    { type: "assistant", session_id: session, uuid: "a1", message: { id: "m1", content: [{ type: "text", text: multibyte }] } },
    { type: "assistant", session_id: session, uuid: "a2", message: { id: "m2", content: [{ type: "text", text: "same ✓" }] } },
    { type: "assistant", session_id: session, uuid: "a3", message: { id: "m3", content: [{ type: "text", text: "same ✓" }] } },
    // A message_delta whose delta has no type: parsed, and it does not end the turn.
    { type: "stream_event", session_id: session, uuid: "md", event: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } } },
    { type: "stream_event", session_id: session, uuid: "ms", event: { type: "message_stop" } },
    {
      type: "result",
      session_id: session,
      uuid: "r",
      subtype: "success",
      is_error: isError,
      result: multibyte,
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
    },
  ];
}
async function claudeRun(isError: boolean) {
  const f = await fixture();
  const script = await claudeStandIn(f.directory, isError ? "error-success" : "success", claudeRecords(isError));
  const runtime = new RuntimeManager(
    f.store,
    () => {},
    () => {},
    () => {
      throw new Error("no Codex process in this test");
    },
    undefined,
    { claude: new ClaudeAdapter(claudeFixtureTransport(process.execPath, [script])) },
  );
  cleanup.push(async () => {
    await runtime.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const installation = { ...f.installation, id: "claude", appId: "anthropic.claude-code-cli" as const };
  const project = { id: "p", name: "fixture", path: f.directory, realPath: f.directory, trusted: true, createdAt: now() };
  const conversation = { id: "c", projectId: "p", title: "Claude chat", nativeSessions: {}, createdAt: now() };
  f.store.put("installation", installation);
  f.store.put("project", project);
  f.store.put("conversation", conversation);
  const run = await runtime.start(installation, conversation, project, "prompt", "fx-requested", "review");
  await vi.waitFor(() =>
    expect(["completed", "failed", "uncertain"]).toContain(f.store.get<Run>("run", run.id)?.status),
  );
  return { f, run: f.store.get<Run>("run", run.id)! };
}

describe("PR-07/PR-10 a real Claude stand-in process through the runtime manager", () => {
  test("bytes split inside multibyte characters arrive as exact text once, usage once, thinking never retained", async () => {
    const { f, run } = await claudeRun(false);
    expect(run).toMatchObject({ status: "completed", error: null });
    const messages = f.store
      .list<Message>("message")
      .filter((m) => m.runId === run.id)
      .map((m) => [m.nativeId, m.text]);
    expect(messages).toEqual(
      expect.arrayContaining([
        ["m1", multibyte],
        ["m2", "same ✓"],
        ["m3", "same ✓"],
      ]),
    );
    const all = JSON.stringify(f.store.list("message"));
    expect(all).not.toContain("�");
    expect(all).not.toContain("thinking-canary");
    const usage = f.store.list<any>("usage").filter((u) => u.runId === run.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ input: 10, output: 3, cached: 1 });
  });
  test("a result with is_error true and subtype success records the run failed with a meaningful error, never completed", async () => {
    const { f, run } = await claudeRun(true);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Claude Code reported an error result.");
    // The message_delta before the result did not end the turn early: the
    // streamed text was recorded before the failure.
    expect(
      f.store.list<Message>("message").some((m) => m.runId === run.id && m.text === multibyte),
    ).toBe(true);
  });
});

describe("D-28 a long partial-message reply through a real Claude stand-in process", () => {
  test("more than 20,000 identified partial deltas then a valid result complete the run, not uncertain", async () => {
    const f = await fixture();
    // Claude Code 2.1.302 with --include-partial-messages gives every
    // fragment its own uuid. The stand-in writes the stream in large chunks.
    const script = path.join(f.directory, "long-reply.cjs");
    await writeFile(
      script,
      `process.stdin.resume();
process.stdin.on("end", () => {
  const session = process.argv[process.argv.indexOf("--session-id") + 1];
  const line = (r) => JSON.stringify({ session_id: session, ...r }) + "\\n";
  let out = line({ type: "system", subtype: "init", model: "fx-effective", tools: [], uuid: "i" });
  out += line({ type: "stream_event", uuid: "st", event: { type: "message_start", message: { id: "m1" } } });
  // Thinking deltas are identified fragments too, but store nothing, so the
  // test passes the cap without 20,000 message writes (slow on Windows CI).
  for (let i = 0; i < 20000; i++)
    out += line({ type: "stream_event", uuid: "t-" + i, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "." } } });
  for (let i = 0; i < 100; i++)
    out += line({ type: "stream_event", uuid: "p-" + i, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "." } } });
  out += line({ type: "stream_event", uuid: "ms", event: { type: "message_stop" } });
  out += line({ type: "assistant", uuid: "a", message: { id: "m1", content: [{ type: "text", text: "long reply" }] } });
  out += line({ type: "result", uuid: "r", subtype: "success", is_error: false, result: "long reply" });
  process.stdout.write(out);
});
`,
    );
    const runtime = new RuntimeManager(
      f.store,
      () => {},
      () => {},
      () => {
        throw new Error("no Codex process in this test");
      },
      undefined,
      { claude: new ClaudeAdapter(claudeFixtureTransport(process.execPath, [script])) },
    );
    cleanup.push(async () => {
      await runtime.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const installation = { ...f.installation, id: "claude", appId: "anthropic.claude-code-cli" as const };
    const project = { id: "p", name: "fixture", path: f.directory, realPath: f.directory, trusted: true, createdAt: now() };
    const conversation = { id: "c", projectId: "p", title: "Claude chat", nativeSessions: {}, createdAt: now() };
    f.store.put("installation", installation);
    f.store.put("project", project);
    f.store.put("conversation", conversation);
    const started = await runtime.start(installation, conversation, project, "prompt", "fx-requested", "review");
    await vi.waitFor(
      () => expect(["completed", "failed", "uncertain"]).toContain(f.store.get<Run>("run", started.id)?.status),
      { timeout: 30_000 },
    );
    const run = f.store.get<Run>("run", started.id)!;
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(
      f.store.list<Message>("message").find((m) => m.runId === run.id && m.nativeId === "m1")?.text,
    ).toBe("long reply");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// PR-07 / PR-08 over a real JSON-RPC child
// ---------------------------------------------------------------------------
async function rpcChild(directory: string, body: string) {
  const file = path.join(directory, `rpc-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(file, body);
  const peer = new RpcPeer(process.execPath, [file], directory, {
    ...nativeEnvironment(),
    ELECTRON_RUN_AS_NODE: "1",
  });
  cleanup.push(async () => {
    await peer.close();
  });
  return peer;
}
async function tempDirectory() {
  const f = await fixture();
  cleanup.push(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  return f.directory;
}

describe("PR-07/PR-08 JSON-RPC framing over a real child process", () => {
  test("a reply split inside multibyte characters is decoded exactly", async () => {
    const directory = await tempDirectory();
    const peer = await rpcChild(
      directory,
      `const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  const bytes = Buffer.from(JSON.stringify({ id: req.id, result: { text: ${JSON.stringify(multibyte)} } }) + "\\n", "utf8");
  let at = 0;
  const step = () => { if (at >= bytes.length) return; process.stdout.write(bytes.subarray(at, at + 1)); at += 1; setTimeout(step, 1); };
  step();
});`,
    );
    expect(await peer.request("echo", {})).toEqual({ text: multibyte });
  });
  test("a frame over the 8,000,000-character limit fails the pending request and the connection, while a large in-limit frame is accepted", async () => {
    const directory = await tempDirectory();
    const script = (size: number) => `const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, result: { pad: "x".repeat(${size}) } }) + "\\n");
});`;
    const ok = await rpcChild(directory, script(7_000_000));
    const accepted = await ok.request("big", {});
    expect(accepted.pad).toHaveLength(7_000_000);
    const tooBig = await rpcChild(directory, script(8_000_001));
    let exited = "";
    tooBig.onExit = (detail) => (exited = detail);
    await expect(tooBig.request("big", {})).rejects.toThrow("frame exceeded its limit");
    expect(exited).toBe("Runtime protocol frame exceeded its limit.");
    const evidence = await tooBig.close();
    expect(evidence.state).toBe("quiescent");
    // A malformed frame also fails closed.
    const bad = await rpcChild(
      directory,
      `require("node:readline").createInterface({ input: process.stdin }).on("line", () => process.stdout.write("{not json\\n"));`,
    );
    await expect(bad.request("x", {})).rejects.toThrow("invalid protocol data");
  });
});

// ---------------------------------------------------------------------------
// Service-level terminals: TM-01 refusal and argv integrity, TM-11 login
// ---------------------------------------------------------------------------
const argumentsLine = /Stand-in arguments: (\[[^\r\n]*\])\r*\n/;
const folderLine = /Stand-in folder: ("[^\r\n]*")\r*\n/;
async function serviceSetup() {
  const f = await fixture();
  f.store.close();
  const output = new Map<string, string>();
  const events: ServiceEvent[] = [];
  const service = new Service(
    f.directory,
    f.key,
    (event: ServiceEvent) => {
      events.push(event);
      if (event.type === "terminal")
        output.set(event.data.id, (output.get(event.data.id) ?? "") + event.data.data);
    },
    true,
  );
  cleanup.push(async () => {
    await service.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const wrapper = path.join(f.directory, "terminal-stand-in");
  await writeFile(
    wrapper,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/terminal-stand-in.cjs"))} "$@"\n`,
  );
  await chmod(wrapper, 0o700);
  const executable = { path: wrapper, ...(await identity(wrapper)) };
  const installations: Record<Provider, Installation> = {
    codex: { ...f.installation, ...executable, id: "codex" },
    claude: {
      ...f.installation,
      ...executable,
      id: "claude",
      appId: "anthropic.claude-code-cli",
      compatibility: "native-only",
    },
  };
  service.store.put("project", {
    id: "p",
    name: "terminal fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  });
  for (const installation of Object.values(installations))
    service.store.put("installation", installation);
  await service.start();
  const read = async (id: string, pattern: RegExp) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const text = output.get(id) ?? "";
      if (pattern.test(text)) return text;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Terminal output never matched ${pattern}: ${output.get(id)}`);
  };
  const released = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (!service.runtime.isProjectBusy("p")) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The terminal did not release the workspace.");
  };
  const terminalEvents = () =>
    (
      service.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='terminal.opened'")
        .get() as { n: number }
    ).n;
  return { ...f, service, installations, output, events, read, released, terminalEvents };
}

describe.skipIf(!posix)("TM-01/TM-11 terminals through the service", () => {
  test("TM-01 a cross-provider, unknown or flag-shaped mode is refused before any run or process", async () => {
    const f = await serviceSetup();
    const open = (installationId: string, permissionMode: string, login = false) =>
      f.service.command({ type: "terminal-open", projectId: "p", installationId, login, permissionMode } as any);
    await expect(open("claude", "full-access")).rejects.toThrow('Claude Code has no terminal mode "full-access" in Topsl.');
    await expect(open("claude", "workspace-never")).rejects.toThrow("no terminal mode");
    await expect(open("codex", "plan")).rejects.toThrow('Codex has no terminal mode "plan" in Topsl.');
    await expect(open("codex", "bypass")).rejects.toThrow("no terminal mode");
    for (const mode of ["--yolo", "bypassPermissions", "plan; touch PWNED", ""]) {
      await expect(open("claude", mode), mode).rejects.toThrow("no terminal mode");
      // The boundary schema refuses it too, before the service sees it.
      expect(
        commandSchema.safeParse({ type: "terminal-open", projectId: "p", installationId: "claude", login: false, permissionMode: mode }).success,
        mode,
      ).toBe(false);
    }
    expect(f.service.store.list("run")).toEqual([]);
    expect(f.terminalEvents()).toBe(0);
    expect([...f.output.keys()]).toEqual([]);
  });
  test("TM-01 a project folder full of shell metacharacters reaches the executable verbatim, with exactly the mode's arguments", async () => {
    const f = await serviceSetup();
    const odd = path.join(f.directory, `a b;$(touch PWNED)'"&|*`);
    await mkdir(odd);
    const real = await realpath(odd);
    f.service.store.put("project", {
      id: "q",
      name: "odd folder",
      path: real,
      realPath: real,
      trusted: true,
      createdAt: now(),
    });
    for (const [provider, mode, expected] of [
      ["claude", "sandboxed", ["--permission-mode", "acceptEdits", "--settings", '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"network":{"strictAllowlist":true}}}']],
      ["codex", "workspace-on-request", ["-s", "workspace-write", "-a", "on-request"]],
    ] as const) {
      const id: string = await f.service.command({
        type: "terminal-open",
        projectId: "q",
        installationId: provider,
        login: false,
        permissionMode: mode as TerminalModeId,
      });
      const text = await f.read(id, folderLine);
      expect(JSON.parse(argumentsLine.exec(text)![1]), provider).toEqual(expected);
      expect(JSON.parse(folderLine.exec(text)![1])).toBe(real);
      await f.service.command({ type: "terminal-close", id });
      for (let i = 0; i < 200 && f.service.runtime.isProjectBusy("q"); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Nothing interpreted the folder name as shell syntax.
    expect(existsSync(path.join(f.directory, "PWNED"))).toBe(false);
    expect(existsSync(path.join(real, "PWNED"))).toBe(false);
    expect(await readdir(real)).toEqual([]);
  });
  test("TM-11 reserved runtime-login starts nothing and points to the native login terminal", async () => {
    const f = await serviceSetup();
    for (const id of ["claude", "codex", "no-such-installation"])
      await expect(f.service.command({ type: "runtime-login", id })).rejects.toThrow(
        "Choose a project and open the native login terminal.",
      );
    expect(f.service.store.list("run")).toEqual([]);
    expect(f.terminalEvents()).toBe(0);
    expect(f.events.filter((e) => e.type === "terminal")).toEqual([]);
    // A login terminal refuses every permission mode with arguments, bypass included,
    // before Topsl's confirmation is even consulted.
    for (const [installationId, mode] of [
      ["codex", "read-only"],
      ["codex", "full-access"],
      ["claude", "bypass"],
      ["claude", "dont-ask"],
    ])
      await expect(
        f.service.command(
          { type: "terminal-open", projectId: "p", installationId, login: true, permissionMode: mode as TerminalModeId },
          { confirmedTerminalMode: mode as TerminalModeId },
        ),
      ).rejects.toThrow("A login terminal takes no permission mode.");
    expect(f.service.store.list("run")).toEqual([]);
    // The supported route: Codex's own login command, in the home folder, with no mode recorded.
    const id: string = await f.service.command({
      type: "terminal-open",
      projectId: "p",
      installationId: "codex",
      login: true,
      permissionMode: "provider-default",
    });
    const text = await f.read(id, folderLine);
    expect(JSON.parse(argumentsLine.exec(text)![1])).toEqual(["login"]);
    expect(JSON.parse(folderLine.exec(text)![1])).toBe(await realpath(os.homedir()));
    const run = f.service.store.get<Run>("run", id)!;
    expect(run).not.toHaveProperty("permissionMode");
    expect(run).toMatchObject({ projectId: "p", installationId: "codex", mode: "native" });
    await f.service.command({ type: "terminal-close", id });
    await f.released();
    expect(f.service.state().terminalModes.find((e) => e.id === "p")).toBeUndefined();
  });
  test("TM-07 the real PTY receives the window size and resize, exact Unicode input bytes, and its output is not imported into history", async () => {
    const f = await serviceSetup();
    const script = path.join(f.directory, "pty-echo.cjs");
    await writeFile(
      script,
      `const size = () => process.stdout.write("size " + process.stdout.columns + "x" + process.stdout.rows + "\\n");
size();
process.stdout.on("resize", size);
process.stdout.write("out: 中文 😀 PTY-OUTPUT-CANARY\\n");
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  if (data.includes(0x71)) process.exit(0);
  process.stdout.write("input-hex " + Buffer.from(data).toString("hex") + "\\n");
});
`,
    );
    const wrapper = path.join(f.directory, "pty-echo");
    await writeFile(
      wrapper,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    );
    await chmod(wrapper, 0o700);
    f.service.store.put("installation", {
      ...f.installations.codex,
      id: "echo",
      path: wrapper,
      ...(await identity(wrapper)),
    });
    const id: string = await f.service.command({
      type: "terminal-open",
      projectId: "p",
      installationId: "echo",
      login: false,
      permissionMode: "provider-default",
    });
    expect(await f.read(id, /size \d+x\d+/)).toMatch(/size 100x24/);
    expect(await f.read(id, /PTY-OUTPUT-CANARY/)).toContain("out: 中文 😀 PTY-OUTPUT-CANARY");
    await f.service.command({ type: "terminal-resize", id, cols: 132, rows: 40 });
    await f.read(id, /size 132x40/);
    const typed = "é中😀";
    await f.service.command({ type: "terminal-input", id, data: typed });
    expect(await f.read(id, /input-hex [0-9a-f]+/)).toContain(
      `input-hex ${Buffer.from(typed, "utf8").toString("hex")}`,
    );
    // Out-of-range sizes are refused by the command schema that guards the
    // renderer and worker boundaries (Service.command itself trusts its caller).
    expect(commandSchema.safeParse({ type: "terminal-resize", id, cols: 10_000, rows: 40 }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "terminal-resize", id, cols: 132, rows: 40 }).success).toBe(true);
    await f.service.command({ type: "terminal-input", id, data: "q" });
    await f.read(id, /Native session exited: 0/);
    await f.released();
    expect(f.service.store.get<Run>("run", id)?.status).toBe("completed");
    // Terminal content stays in the terminal: no stored document or event holds it.
    const stored = (table: string) =>
      (
        f.service.store.db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE body LIKE '%PTY-OUTPUT-CANARY%'`)
          .get() as { n: number }
      ).n;
    expect(stored("documents")).toBe(0);
    expect(stored("events")).toBe(0);
    // Closed terminals take no more input.
    await expect(
      f.service.command({ type: "terminal-input", id, data: "x" }),
    ).rejects.toThrow("Terminal is closed.");
  });
});

// ---------------------------------------------------------------------------
// TM-10 assisted handoff export bounds
// ---------------------------------------------------------------------------
async function assistedSetup(specification: object) {
  const f = await fixture();
  cleanup.push(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  await writeFile(path.join(f.directory, "small.ts"), "export const small = 'SMALL-CANARY';\n");
  await writeFile(path.join(f.directory, "big.txt"), "BIG-CANARY ".repeat(1000));
  await writeFile(path.join(f.directory, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0x42, 0x49, 0x4e]));
  const candidate = await captureCandidate(f.store, {
    root: f.directory,
    projectId: "p",
    workflowId: "w",
    selectedPaths: ["small.ts", "big.txt", "blob.bin"],
  });
  f.store.put("builder-reviewer", { id: "w", projectId: "p", candidateId: candidate.id, specificationId: "spec" });
  f.store.put("workflow-specification", { id: "spec", ...specification });
  const assisted = new AssistedWorkflows(f.store);
  const prepare = () =>
    assisted.prepare({ projectId: "p", workflowId: "w", installationId: f.installation.id, role: "reviewer", exportApproved: true });
  return { ...f, candidate, assisted, prepare };
}

describe("TM-10 assisted handoff export", () => {
  test("large and binary files appear as bounded metadata with an explicit omission statement", async () => {
    const f = await assistedSetup({ objective: "Review the pinned files" });
    const handoff = await f.prepare();
    const text = handoff.handoffText;
    expect(Buffer.byteLength(text)).toBeLessThan(1_000_000);
    expect(text).toContain("SMALL-CANARY");
    expect(text).not.toContain("BIG-CANARY");
    expect(text).toMatch(/--- big\.txt \([0-9a-f]{64}, 11000 bytes, text, /);
    expect(text).toMatch(/--- blob\.bin \([0-9a-f]{64}, 8 bytes, binary, /);
    expect(text).toContain("Omitted file contents are not included in this handoff.");
    expect(text).toContain("Hashes and metadata do not establish visual or binary verification.");
    expect(handoff.attribution).toBe("externally-controlled");
    expect(f.store.list("verification")).toEqual([]);
  });
  test("a handoff over the 1,000,000-byte export limit is refused and nothing is recorded", async () => {
    const f = await assistedSetup({ objective: "o".repeat(1_000_001) });
    await expect(f.prepare()).rejects.toThrow("exceeds the bounded export limit");
    expect(f.store.list("assisted-handoff")).toEqual([]);
    expect(f.store.list("assisted-handoff-state")).toEqual([]);
    expect(f.store.list("run")).toEqual([]);
  });
});
