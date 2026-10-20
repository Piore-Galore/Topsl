// Streamed message text is written in batches, not once per delta. A long
// reply of N deltas used to cost N rewrites of a growing message (D-28
// follow-up, 21 October 2026).
import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { nativeEnvironment } from "../packages/platform/system";
import { now } from "../packages/domain/invariants";
import type { Message, Run } from "../packages/domain/types";
import {
  ClaudeAdapter,
  claudeFixtureTransport,
} from "../packages/providers/claude";
import { fixture } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Runs one turn and records every message write the runtime makes. */
async function streamed(
  provider: "claude" | "codex",
  options: { claudeRecords?: string; codexDeltas?: number },
) {
  const f = await fixture();
  let runtime: RuntimeManager;
  if (provider === "claude") {
    const script = path.join(f.directory, "stream.cjs");
    await writeFile(
      script,
      `process.stdin.resume();
process.stdin.on("end", () => {
  const session = process.argv[process.argv.indexOf("--session-id") + 1];
  const line = (r) => JSON.stringify({ session_id: session, ...r }) + "\\n";
  let out = line({ type: "system", subtype: "init", model: "fx-effective", tools: [], uuid: "i" });
  out += line({ type: "stream_event", uuid: "st", event: { type: "message_start", message: { id: "m1" } } });
  ${options.claudeRecords}
  out += line({ type: "stream_event", uuid: "ms", event: { type: "message_stop" } });
  out += line({ type: "result", uuid: "r", subtype: "success", is_error: false, result: "" });
  process.stdout.write(out);
});
`,
    );
    runtime = new RuntimeManager(
      f.store,
      () => {},
      () => {},
      () => {
        throw new Error("no Codex process in this test");
      },
      undefined,
      {
        claude: new ClaudeAdapter(
          claudeFixtureTransport(process.execPath, [script]),
        ),
      },
    );
  } else
    runtime = new RuntimeManager(
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
            FIXTURE_DELTAS: String(options.codexDeltas ?? 0),
          },
        ),
    );
  cleanup.push(async () => {
    await runtime.close();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const writes: Message[] = [];
  const write = f.store.message.bind(f.store);
  f.store.message = (message: Message) => {
    if (message.role === "assistant") writes.push(message);
    write(message);
  };
  const installation =
    provider === "claude"
      ? {
          ...f.installation,
          id: "claude",
          appId: "anthropic.claude-code-cli" as const,
        }
      : f.installation;
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
    title: "Streamed chat",
    nativeSessions: {},
    createdAt: now(),
  };
  f.store.put("installation", installation);
  f.store.put("project", project);
  f.store.put("conversation", conversation);
  const started = await runtime.start(
    installation,
    conversation,
    project,
    "hello",
    provider === "claude" ? "fx-requested" : "fixture-model",
    "review",
  );
  await vi.waitFor(
    () =>
      expect(["completed", "failed", "uncertain"]).toContain(
        f.store.get<Run>("run", started.id)?.status,
      ),
    { timeout: 30_000 },
  );
  const run = f.store.get<Run>("run", started.id)!;
  const stored = f.store
    .list<Message>("message")
    .filter((m) => m.runId === run.id && m.role === "assistant");
  return { run, stored, writes };
}

describe("streamed message text is written in batches", () => {
  test("20,100 Claude text deltas with no final message store the exact text in a bounded number of writes", async () => {
    const { run, stored, writes } = await streamed("claude", {
      claudeRecords: `for (let i = 0; i < 20100; i++)
    out += line({ type: "stream_event", uuid: "p-" + i, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: String(i % 10) } } });`,
    });
    const expected = Array.from({ length: 20_100 }, (_, i) => i % 10).join("");
    expect(run).toMatchObject({ status: "completed", error: null });
    // The draft is the whole reply when no final message replaces it.
    expect(stored.map((m) => m.text)).toEqual([expected]);
    // The first delta is written at once, so the message keeps its place.
    expect(writes[0].text).toBe("0");
    // One write per delta would be 20,100 writes of 210 million characters.
    expect(writes.length).toBeLessThan(200);
    expect(
      writes.reduce((total, m) => total + m.text.length, 0),
    ).toBeLessThan(200 * expected.length);
    expect(new Set(writes.map((m) => m.createdAt)).size).toBe(1);
  }, 60_000);

  test("a Claude draft longer than 2,000,000 characters is stored at exactly the bound", async () => {
    const { run, stored } = await streamed("claude", {
      claudeRecords: `for (let i = 0; i < 3; i++)
    out += line({ type: "stream_event", uuid: "p-" + i, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(900000) } } });`,
    });
    expect(run).toMatchObject({ status: "completed", error: null });
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe("x".repeat(2_000_000));
  }, 60_000);

  test("20,100 Codex deltas then a completed item store the item's exact text in a bounded number of writes", async () => {
    const { run, stored, writes } = await streamed("codex", {
      codexDeltas: 20_100,
    });
    expect(run).toMatchObject({ status: "completed", error: null });
    // The completed item's text replaces the streamed draft exactly.
    expect(stored.map((m) => m.text)).toEqual([
      "Fixture response, no model was contacted.",
    ]);
    expect(writes[0].text).toBe(".");
    expect(writes.at(-1)!.text).toBe(
      "Fixture response, no model was contacted.",
    );
    expect(writes.length).toBeLessThan(200);
  }, 60_000);
});
