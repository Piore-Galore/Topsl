import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  answer,
  lastResults,
  nativeFixture,
  type Script,
} from "./native-fixture";
import type { CandidateSnapshot } from "../packages/workflows/candidates";
import { NativeHarness } from "../packages/harness/harness";
import { nativeProcessIdentity } from "../packages/harness/process-identity";
import { routeHeaders } from "../packages/proxy/types";
import { sha256 } from "../packages/harness/tools";

/**
 * Native harness end to end, against a synthetic upstream through the real
 * local proxy (loopback HTTP, route revisions, receipts, credential store)
 * and the real kernel, journal, tools, sandbox and candidate capture.
 * Synthetic fixtures only: no live ChatGPT, Anthropic or local model.
 */

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.close();
});
async function setup(
  script: Script,
  options?: Parameters<typeof nativeFixture>[1],
) {
  const f = await nativeFixture(script, options);
  fixtures.push(f);
  return f;
}
const shaOf = (output: string) =>
  /sha256: ([a-f0-9]{64})/.exec(output)?.[1] ?? "";
const canSandbox = process.platform === "darwin";

/** read → edit → check → answer, the plan's core coding loop. */
const fixScript: Script = (call) => {
  const results = lastResults(call.request);
  const turn = call.request.messages.filter(
    (m) => m.role === "assistant",
  ).length;
  if (turn === 0)
    return {
      events: answer([
        { text: "Reading the file." },
        { tool: "read_file", args: { path: "src/math.js" } },
      ]),
    };
  if (turn === 1)
    return {
      events: answer([
        {
          tool: "edit_file",
          args: {
            path: "src/math.js",
            old_text: "a - b",
            new_text: "a + b",
            expected_sha256: shaOf(results[0].output),
          },
        },
      ]),
    };
  if (turn === 2)
    return { events: answer([{ tool: "run_check", args: { name: "math" } }]) };
  return {
    events: answer([
      {
        text: `Fixed add(). Check: ${results[0]?.isError ? "failed" : "passed"}.`,
      },
    ]),
  };
};

describe("native subscription route (synthetic ChatGPT plan)", () => {
  test.skipIf(!canSandbox)(
    "read → tool call → edit → check → candidate → apply, without Codex or Claude Code",
    async () => {
      const f = await setup(fixScript);
      const { connection, credential } = f.chatgpt();
      f.route(connection.id, "chatgpt/test");
      const started = await f.start({
        routeAlias: "chatgpt/test",
        prompt: "Fix add() in src/math.js",
        processes: true,
        checks: [
          {
            name: "math",
            argv: ["/bin/sh", "-c", "grep -q 'a + b' src/math.js"],
            timeoutMs: 20_000,
          },
        ],
      });
      const view = await f.settle(started.attemptId);
      expect(view.state).toBe("completed");
      expect(view.summary).toContain("Check: passed");
      expect(view.requests).toBe(4);
      expect(view.toolCalls).toBe(3);
      expect(view.candidateId).toBeTruthy();

      // Every upstream request was the plan route's restricted Responses shape.
      expect(f.upstream.calls).toHaveLength(4);
      for (const call of f.upstream.calls) {
        expect(call.path).toBe("/openai/responses");
        expect(call.body.store).toBe(false);
        expect(call.body.stream).toBe(true);
        expect(call.body.model).toBe("upstream-model");
        expect(call.body).not.toHaveProperty("max_output_tokens");
        expect(call.body).not.toHaveProperty("temperature");
        expect(call.body).not.toHaveProperty("previous_response_id");
        expect(call.headers.authorization).toBe(
          `Bearer ${credential.accessToken}`,
        );
        expect(call.body.input.some((i: any) => i.role === "system")).toBe(
          false,
        );
      }
      // Tool IDs survive the round trip: each result quotes its call.
      const second = f.upstream.calls[1].body.input;
      const callItem = second.find((i: any) => i.type === "function_call");
      const resultItem = second.find(
        (i: any) => i.type === "function_call_output",
      );
      expect(resultItem.call_id).toBe(callItem.call_id);

      // The edit stays in the candidate until applied.
      expect(
        await readFile(path.join(f.root, "src/math.js"), "utf8"),
      ).toContain("a - b");
      const candidate = f.store.get<CandidateSnapshot>(
        "candidate",
        view.candidateId!,
      )!;
      expect(candidate.files.find((x) => x.path === "src/math.js")?.hash).toBe(
        sha256("export function add(a, b) {\n  return a + b;\n}\n"),
      );
      const preview = await f.harness.applyPreview(started.attemptId);
      expect(preview.problems).toEqual([]);
      expect(preview.files).toEqual([
        { path: "src/math.js", change: "modified" },
      ]);
      expect(await f.harness.apply(started.attemptId, preview.digest)).toEqual({
        applied: preview.files,
      });
      expect(
        await readFile(path.join(f.root, "src/math.js"), "utf8"),
      ).toContain("a + b");

      // Receipts attribute every request to the plan's account and funding.
      const receipts = f.proxy.registry.receipts({
        attemptId: started.attemptId,
      });
      expect(receipts).toHaveLength(4);
      for (const receipt of receipts) {
        expect(receipt.outcome).toBe("completed");
        expect(receipt.funding).toBe("subscription");
        expect(receipt.accountKey).toBe(
          `chatgpt:user-subject-1:oaiapp_fixture`,
        );
        expect(receipt.routeRevision).toBe(
          f.proxy.registry.routeByAlias("chatgpt/test")!.revision,
        );
        expect(receipt.reportedModel).toBe("upstream-model-reported");
        expect(receipt.usage.input).toBe(120);
      }
      expect(view.usage.input).toBe(480);
      expect(f.harness.journal.verify(started.attemptId)).toEqual({
        ok: true,
        brokenAt: null,
      });
    },
  );

  test.skipIf(!canSandbox).each(["skipped", "failed", "stale", "mutating"])(
    "a %s check cannot authorize applying a candidate",
    async (mode) => {
      const f = await setup((_call, index) => {
        if (mode !== "skipped" && index === 0)
          return {
            events: answer([{ tool: "run_check", args: { name: "probe" } }]),
          };
        if (mode === "stale" && index === 1)
          return {
            events: answer([
              {
                tool: "write_file",
                args: {
                  path: "new.txt",
                  content: "changed after check",
                  expected_sha256: null,
                },
              },
            ]),
          };
        return { events: answer([{ text: "Candidate ready." }]) };
      });
      const { connection } = f.chatgpt();
      f.route(connection.id, "chatgpt/test");
      const started = await f.start({
        routeAlias: "chatgpt/test",
        prompt: "Check before applying",
        processes: true,
        checks: [
          {
            name: "probe",
            argv: [
              "/bin/sh",
              "-c",
              mode === "failed"
                ? "exit 1"
                : mode === "mutating"
                  ? "printf changed > new.txt"
                  : "exit 0",
            ],
            timeoutMs: 20_000,
          },
        ],
      });
      const final = await f.settle(started.attemptId);
      expect(final.state).toBe("completed");
      const preview = await f.harness.applyPreview(started.attemptId);
      expect(preview.problems.join(" ")).toContain(
        "no passing result for this exact candidate",
      );
      expect(
        await f.harness.apply(started.attemptId, preview.digest),
      ).toHaveProperty("refused");
      expect(existsSync(path.join(f.root, "new.txt"))).toBe(false);
    },
  );

  test("a read-only investigation through the Anthropic API route", async () => {
    const f = await setup((call) => {
      const turn = call.request.messages.filter(
        (m) => m.role === "assistant",
      ).length;
      if (turn === 0)
        return {
          events: answer([
            { tool: "list_directory", args: { path: "." } },
            { tool: "read_file", args: { path: "README.md" } },
          ]),
        };
      return {
        events: answer([
          { text: `The README says: ${lastResults(call.request)[1].output}` },
        ]),
      };
    });
    const { connection, key } = f.apiKey("anthropic-api");
    await new Promise((r) => setTimeout(r, 10));
    f.route(connection.id, "anthropic/test", "claude-model");
    const started = await f.start({
      routeAlias: "anthropic/test",
      prompt: "What does the README say?",
      mode: "investigate",
    });
    const view = await f.settle(started.attemptId);
    expect(view.state).toBe("completed");
    expect(view.summary).toContain("# Fixture");
    expect(view.candidateId).toBeNull();
    expect(view.binding.native?.funding).toBe("api-billing");
    expect(f.upstream.calls[0].path).toBe("/anthropic/messages");
    expect(f.upstream.calls[0].headers["x-api-key"]).toBe(key);
    expect(f.upstream.calls[0].body.max_tokens).toBeGreaterThan(0);
    expect(
      f.upstream.calls[0].body.tools.map((t: any) => t.name),
    ).not.toContain("edit_file");
    // Two reads in one answer both produced results with their own IDs.
    const results = f.upstream.calls[1].body.messages
      .at(-1)
      .content.filter((b: any) => b.type === "tool_result");
    expect(results).toHaveLength(2);
  });

  test("a Chat Completions gateway route carries tool calls and results", async () => {
    const f = await setup((call) => {
      const turn = call.request.messages.filter(
        (m) => m.role === "assistant",
      ).length;
      if (turn === 0)
        return {
          events: answer([{ tool: "search", args: { pattern: "return" } }]),
        };
      return { events: answer([{ text: "Found it." }]) };
    });
    const connection = f.proxy.registry.createConnection({
      kind: "openai-compatible",
      label: "Gateway",
      endpoint: `http://127.0.0.1:${f.upstream.port}/gateway`,
    });
    await f.proxy.command({
      type: "connection-api-key",
      connectionId: connection.id,
      key: "gateway-key-123456",
    });
    f.route(connection.id, "gateway/test");
    const started = await f.start({
      routeAlias: "gateway/test",
      prompt: "Find return statements",
      mode: "investigate",
    });
    const view = await f.settle(started.attemptId);
    expect(view.state).toBe("completed");
    expect(f.upstream.calls[0].path).toBe("/gateway/chat/completions");
    const messages = f.upstream.calls[1].body.messages;
    const assistant = messages.find((m: any) => m.role === "assistant");
    const tool = messages.find((m: any) => m.role === "tool");
    expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(tool.content).toContain("src/math.js");
  });
});

describe("failures, waits and fencing", () => {
  test("a plan usage limit pauses every attempt sharing the allowance, without retrying", async () => {
    let limited = true;
    const f = await setup(() =>
      limited
        ? {
            status: 429,
            body: {
              error: {
                code: "subscription_sharing_usage_limit_exceeded",
                message: "Usage limit reached.",
              },
            },
          }
        : { events: answer([{ text: "Done." }]) },
    );
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/a");
    f.route(connection.id, "chatgpt/b", "upstream-model-2");
    const first = await f.start({
      routeAlias: "chatgpt/a",
      prompt: "one",
      mode: "investigate",
    });
    const paused = await f.settle(first.attemptId);
    expect(paused.state).toBe("waiting-quota");
    expect(f.upstream.calls).toHaveLength(1);
    expect(f.proxy.registry.requireConnection(connection.id).state).toBe(
      "paused-usage-limit",
    );
    // Another route on the same account waits before dispatching anything.
    const second = await f.start({
      routeAlias: "chatgpt/b",
      prompt: "two",
      mode: "investigate",
    });
    expect((await f.settle(second.attemptId)).state).toBe("waiting-quota");
    expect(f.upstream.calls).toHaveLength(1);
    // A different account is not affected.
    const other = f.chatgpt("user-subject-2", "oaiapp_other");
    f.route(other.connection.id, "chatgpt/other");
    limited = false;
    const third = await f.start({
      routeAlias: "chatgpt/other",
      prompt: "three",
      mode: "investigate",
    });
    expect((await f.settle(third.attemptId)).state).toBe("completed");
    // The owner resumes; the attempt continues on the same route.
    await f.harness.resume(first.attemptId);
    expect((await f.settle(first.attemptId)).state).toBe("completed");
  });

  test("transient failures retry at most twice on the same route; the proxy never retries", async () => {
    let failures = 2;
    const f = await setup(() =>
      failures-- > 0
        ? { status: 503, body: { detail: "busy" } }
        : { events: answer([{ text: "ok" }]) },
    );
    const { connection } = f.apiKey("openai-api");
    await new Promise((r) => setTimeout(r, 10));
    f.route(connection.id, "openai/test");
    const a = await f.start({
      routeAlias: "openai/test",
      prompt: "x",
      mode: "investigate",
    });
    const view = await f.settle(a.attemptId);
    expect(view.state).toBe("completed");
    expect(view.requests).toBe(3);
    expect(f.upstream.calls).toHaveLength(3);
    failures = 3;
    const b = await f.start({
      routeAlias: "openai/test",
      prompt: "y",
      mode: "investigate",
    });
    const failed = await f.settle(b.attemptId);
    expect(failed.state).toBe("failed");
    expect(failed.requests).toBe(3);
    expect(failed.stateDetail).toContain("unavailable");
  });

  test("a changed route is refused before upstream dispatch", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const f = await setup((call, index) =>
      index === 0
        ? {
            events: answer([
              { tool: "read_file", args: { path: "README.md" } },
            ]),
            hold,
          }
        : { events: answer([{ text: "never" }]) },
    );
    const { connection } = f.chatgpt();
    const route = f.route(connection.id, "chatgpt/test");
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "read",
      mode: "investigate",
    });
    await new Promise((r) => setTimeout(r, 200));
    // The owner points the alias at another model mid-attempt.
    f.proxy.registry.saveRoute({
      id: route.id,
      connectionId: connection.id,
      alias: "chatgpt/test",
      upstreamModel: "upstream-model-2",
    });
    release();
    const view = await f.settle(started.attemptId);
    expect(view.state).toBe("failed");
    expect(view.stateDetail).toContain("route changed");
    expect(f.upstream.calls).toHaveLength(1);
    const receipts = f.proxy.registry.receipts({
      attemptId: started.attemptId,
    });
    expect(receipts.map((r) => r.outcome).sort()).toEqual([
      "completed",
      "rejected",
    ]);
    // Directly: a stale revision header never reaches the upstream.
    const response = await fetch(
      `http://127.0.0.1:${f.endpoint.port}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.endpoint.token}`,
          "content-type": "application/json",
          [routeHeaders.routeRevision]: route.revision,
        },
        body: JSON.stringify({
          model: "chatgpt/test",
          input: "hi",
          stream: true,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(f.upstream.calls).toHaveLength(1);
  });

  test("the proxy refuses requests without the local token or from a browser origin", async () => {
    const f = await setup(() => ({ events: answer([{ text: "x" }]) }));
    const url = `http://127.0.0.1:${f.endpoint.port}/v1/models`;
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          headers: {
            authorization: `Bearer ${f.endpoint.token}`,
            origin: "https://example.com",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          headers: { authorization: `Bearer ${f.endpoint.token}` },
        })
      ).status,
    ).toBe(200);
  });

  test("the same failing call three times with nothing changed pauses the attempt", async () => {
    const f = await setup(() => ({
      events: answer([{ tool: "read_file", args: { path: "missing.txt" } }]),
    }));
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "loop",
      mode: "investigate",
    });
    const view = await f.settle(started.attemptId);
    expect(view.state).toBe("paused");
    expect(view.stateDetail).toContain("repeated 3 times");
    expect(view.requests).toBe(3);
  });

  test("the request budget pauses an attempt at its limit", async () => {
    const f = await setup(() => ({
      events: answer([{ tool: "list_directory", args: {} }]),
    }));
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "loop",
      mode: "investigate",
      maxRequests: 4,
    });
    const view = await f.settle(started.attemptId);
    expect(view.state).toBe("paused");
    expect(view.requests).toBe(4);
    expect(view.stateDetail).toContain("4 model requests");
  });

  test("steering reaches the next request; stop cancels the attempt", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const f = await setup((call, index) => {
      if (index === 0)
        return { events: answer([{ tool: "list_directory", args: {} }]), hold };
      const steering = call.request.messages
        .flatMap((m) => m.parts)
        .some((p) => p.type === "text" && p.text.includes("focus on README"));
      return {
        events: answer([{ text: steering ? "Steered." : "Not steered." }]),
      };
    });
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "look",
      mode: "investigate",
    });
    await new Promise((r) => setTimeout(r, 200));
    f.harness.steer(started.attemptId, "focus on README");
    release();
    expect((await f.settle(started.attemptId)).summary).toBe("Steered.");

    const blocked = await setup(() => ({
      events: [],
      hold: new Promise(() => {}),
    }));
    const second = blocked.chatgpt();
    blocked.route(second.connection.id, "chatgpt/test");
    const attempt = await blocked.start({
      routeAlias: "chatgpt/test",
      prompt: "wait",
      mode: "investigate",
    });
    await new Promise((r) => setTimeout(r, 200));
    await blocked.harness.cancel(attempt.attemptId);
    expect(blocked.harness.view(attempt.attemptId)!.state).toBe("cancelled");
    await vi.waitFor(() =>
      expect(
        blocked.proxy.registry.receipts({ attemptId: attempt.attemptId }),
      ).toHaveLength(1),
    );
    expect(
      blocked.proxy.registry.receipts({ attemptId: attempt.attemptId })[0]
        .outcome,
    ).toBe("cancelled");
  });
});

describe("recovery", () => {
  test("a restart fences the old writer, reconciles an applied edit by hash and resumes without repeating it", async () => {
    let release!: () => void;
    let hold: Promise<void> | undefined = new Promise<void>(
      (resolve) => (release = resolve),
    );
    const f = await setup((call) => {
      const turn = call.request.messages.filter(
        (m) => m.role === "assistant",
      ).length;
      if (turn === 0)
        return {
          events: answer([
            { tool: "read_file", args: { path: "src/math.js" } },
          ]),
        };
      if (turn === 1) {
        const h = hold;
        hold = undefined;
        return {
          events: answer([{ text: "never settles before the restart" }]),
          hold: h,
        };
      }
      return {
        events: answer([
          {
            text: `Resumed with ${lastResults(call.request)
              .map((r) => r.output.split(".")[0])
              .join("; ")}`,
          },
        ]),
      };
    });
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "fix",
      mode: "edit",
    });
    await new Promise((r) => setTimeout(r, 300));
    // Simulate a crash: write the edit's intention as if the old process had
    // journaled it and changed the file just before dying.
    const id = started.attemptId;
    const spec = f.store.get<any>("native-attempt-spec", id);
    const file = path.join(spec.workspace.root, "src/math.js");
    const before = sha256(await readFile(file));
    const next = "export function add(a, b) {\n  return a + b;\n}\n";
    const generation = f.harness.journal.require(id).generation;
    f.harness.journal.append(id, generation, [
      {
        kind: "response-settled",
        body: {
          requestNumber: 99,
          output: [
            {
              type: "tool-call",
              id: "call_edit",
              name: "edit_file",
              arguments: JSON.stringify({
                path: "src/math.js",
                old_text: "a - b",
                new_text: "a + b",
                expected_sha256: before,
              }),
            },
          ],
          finish: "tool-calls",
          error: null,
          usage: {
            input: null,
            output: null,
            cachedInput: null,
            reasoning: null,
          },
          reportedModel: null,
        },
      },
      {
        kind: "tool-intended",
        body: {
          callId: "call_edit",
          tool: "edit_file",
          effect: "mutation",
          arguments: {
            path: "src/math.js",
            old_text: "a - b",
            new_text: "a + b",
            expected_sha256: before,
            replace_all: false,
          },
          argumentsHash: "",
          implementationRevision: "edit_file-v1",
          expectation: { path: "src/math.js", before, after: sha256(next) },
        },
      },
    ]);
    await writeFile(file, next);
    // A second service instance recovers the attempt while the first still waits on the model.
    const recovered = new NativeHarness({
      store: f.store,
      profileDirectory: f.directory,
      endpoint: () => f.endpoint,
      route: (alias) => {
        const route = f.proxy.registry.routeByAlias(alias);
        return route
          ? {
              route,
              connection: f.proxy.registry.connection(route.connectionId)!,
            }
          : null;
      },
      gitExecutable: "git",
    });
    expect(await recovered.recoverAll()).toBe(1);
    expect(recovered.view(id)!.state).toBe("paused");
    release();
    await f.settle(id);
    // The stale writer recorded nothing after the claim.
    const events = [...f.harness.journal.all(id)];
    const claim = events.find((e) => e.kind === "resumed")!;
    expect(
      events.filter(
        (e) => e.sequence > claim.sequence && e.generation < claim.generation,
      ),
    ).toEqual([]);
    expect(
      events.filter(
        (e) =>
          e.kind === "response-settled" &&
          (e.body as any).error?.code === "restart",
      ),
    ).toHaveLength(1);
    await recovered.resume(id);
    const view = await recovered.kernel.settled(id);
    expect(view.state).toBe("completed");
    const result = [...recovered.journal.all(id)].find(
      (e) => e.kind === "tool-result" && (e.body as any).callId === "call_edit",
    )!;
    expect((result.body as any).output).toContain("already been applied");
    expect(await readFile(file, "utf8")).toBe(next);
    expect(recovered.journal.verify(id).ok).toBe(true);
    recovered.close();
  });

  test.skipIf(!canSandbox).each(["owned", "different", "missing"])(
    "restart signals only a verified process (%s identity) and leaves its effects uncertain",
    async (identity) => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      const f = await setup((call, index) => {
        if (index === 0)
          return { events: answer([{ text: "one moment" }]), hold };
        return { events: answer([{ text: "continued after reconciliation" }]) };
      });
      const { connection } = f.chatgpt();
      f.route(connection.id, "chatgpt/test");
      const started = await f.start({
        routeAlias: "chatgpt/test",
        prompt: "run",
        mode: "edit",
        processes: true,
      });
      await new Promise((r) => setTimeout(r, 200));
      const id = started.attemptId;
      const sleeper = spawn("/bin/sleep", ["60"], {
        detached: true,
        stdio: "ignore",
      });
      fixtures.push({
        close: async () => {
          sleeper.kill("SIGKILL");
        },
      });
      const recordedIdentity = nativeProcessIdentity(sleeper.pid!);
      expect(recordedIdentity).toBeTruthy();
      const generation = f.harness.journal.require(id).generation;
      f.harness.journal.append(id, generation, [
        {
          kind: "tool-intended",
          body: {
            callId: "call_run",
            tool: "run_command",
            effect: "process",
            arguments: { command: "make" },
            argumentsHash: "",
            implementationRevision: "run_command-v1",
            expectation: null,
          },
        },
      ]);
      f.store.put("native-process", {
        id: `${id}:call_run`,
        attemptId: id,
        callId: "call_run",
        pid: sleeper.pid,
        identity:
          identity === "owned"
            ? recordedIdentity
            : identity === "different"
              ? "previous-process"
              : undefined,
        startedAt: new Date().toISOString(),
      });
      const exited = new Promise((resolve) => sleeper.once("exit", resolve));
      const recovered = new NativeHarness({
        store: f.store,
        profileDirectory: f.directory,
        endpoint: () => f.endpoint,
        route: () => null,
        gitExecutable: "git",
      });
      await recovered.recoverAll();
      if (identity === "owned") await exited;
      else {
        expect(nativeProcessIdentity(sleeper.pid!)).toBe(recordedIdentity);
        sleeper.kill("SIGKILL");
        await exited;
      }
      expect(recovered.view(id)!.state).toBe("uncertain");
      await expect(recovered.resume(id)).rejects.toThrow("Reconcile");
      release();
      await f.settle(id);
      expect(
        recovered.reconcile(
          id,
          "call_run",
          "not-applied",
          "make had not started",
        ).state,
      ).toBe("paused");
      recovered.close();
    },
  );
});

describe("context, delegation and extensions", () => {
  test("compaction replaces only a still-valid range and keeps the owner's words", async () => {
    let steps = 0;
    const f = await setup((call) => {
      if (call.request.instructions?.includes("compacting"))
        return {
          events: answer([{ text: "Summary: listed the folder twice." }]),
        };
      if (++steps < 5)
        return {
          events: answer([
            { text: "x".repeat(3000) },
            { tool: "list_directory", args: {} },
          ]),
        };
      const capsule = call.request.messages[0].parts.find(
        (p) => p.type === "text",
      ) as any;
      return {
        events: answer([
          {
            text: capsule?.text?.includes("Owner's messages so far")
              ? "compacted"
              : "not compacted",
          },
        ]),
      };
    });
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "THE ORIGINAL TASK",
      mode: "investigate",
      contextWindowTokens: 4000,
    });
    const view = await f.settle(started.attemptId);
    expect(view.state).toBe("completed");
    expect(view.compactions).toBeGreaterThan(0);
    const compaction = [...f.harness.journal.all(started.attemptId)].find(
      (e) => e.kind === "compaction",
    )!;
    expect((compaction.body as any).summary).toContain("THE ORIGINAL TASK");
    expect(view.summary).toBe("compacted");
  });

  test.skipIf(!canSandbox)(
    "a writable child edits its own copy and the parent integrates it",
    async () => {
      const f = await setup((call) => {
        const text = call.request.messages
          .flatMap((m) => m.parts)
          .filter((p) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n");
        const results = lastResults(call.request);
        const isChild = text.includes("CHILD TASK");
        const turn = call.request.messages.filter(
          (m) => m.role === "assistant",
        ).length;
        if (isChild) {
          if (turn === 0)
            return {
              events: answer([
                { tool: "read_file", args: { path: "README.md" } },
              ]),
            };
          if (turn === 1)
            return {
              events: answer([
                {
                  tool: "write_file",
                  args: {
                    path: "README.md",
                    content: "# Fixture\n\nUpdated by the child.\n",
                    expected_sha256: shaOf(results[0].output),
                  },
                },
              ]),
            };
          return { events: answer([{ text: "Child updated README." }]) };
        }
        if (turn === 0)
          return {
            events: answer([
              {
                tool: "delegate",
                args: {
                  mode: "fresh",
                  task: "CHILD TASK: update README",
                  writable: true,
                },
              },
            ]),
          };
        if (turn === 1) {
          const child = /Child ([0-9a-f-]{36})/.exec(results[0].output)?.[1];
          return {
            events: answer([
              { tool: "integrate_child", args: { child_attempt_id: child } },
            ]),
          };
        }
        return {
          events: answer([
            { text: `Parent done: ${results[0].output.split(":")[0]}` },
          ]),
        };
      });
      const { connection } = f.chatgpt();
      f.route(connection.id, "chatgpt/test");
      const started = await f.start({
        routeAlias: "chatgpt/test",
        prompt: "Delegate the README update",
        delegation: true,
      });
      const view = await f.settle(started.attemptId);
      expect(view.state).toBe("completed");
      expect(view.children).toHaveLength(1);
      const child = f.harness.view(view.children[0])!;
      expect(child.depth).toBe(1);
      expect(child.state).toBe("completed");
      expect(child.binding.native?.routeRevision).toBe(
        view.binding.native?.routeRevision,
      );
      expect(view.summary).toContain("Integrated 1 file");
      const candidate = f.store.get<CandidateSnapshot>(
        "candidate",
        view.candidateId!,
      )!;
      expect(candidate.files.find((x) => x.path === "README.md")?.hash).toBe(
        sha256("# Fixture\n\nUpdated by the child.\n"),
      );
    },
  );

  test("skills load on demand and memory proposals wait for acceptance", async () => {
    const f = await setup(
      (call) => {
        const turn = call.request.messages.filter(
          (m) => m.role === "assistant",
        ).length;
        if (turn === 0)
          return {
            events: answer([
              { tool: "load_skill", args: { name: "release-notes" } },
              {
                tool: "propose_memory",
                args: { text: "Always update CHANGELOG.md" },
              },
            ]),
          };
        return {
          events: answer([
            {
              text: lastResults(call.request)[0].output.includes(
                "Write release notes",
              )
                ? "skill loaded"
                : "no skill",
            },
          ]),
        };
      },
      {
        files: {
          "README.md": "x\n",
          ".agents/skills/release-notes/SKILL.md":
            "---\nname: release-notes\ndescription: Write release notes\n---\nWrite release notes from the changelog.\n",
        },
      },
    );
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    const started = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "notes",
      mode: "investigate",
    });
    expect(f.upstream.calls.length).toBeGreaterThanOrEqual(0);
    const view = await f.settle(started.attemptId);
    expect(view.summary).toBe("skill loaded");
    expect(f.upstream.calls[0].body.instructions).toContain(
      "release-notes: Write release notes",
    );
    const [memory] = f.harness.memories(f.project.id);
    expect(memory.state).toBe("proposed");
    f.harness.decideMemory(memory.id, true);
    const next = await f.start({
      routeAlias: "chatgpt/test",
      prompt: "again",
      mode: "investigate",
    });
    await f.settle(next.attemptId);
    expect(f.upstream.calls.at(-1)!.body.instructions).toContain(
      "Always update CHANGELOG.md",
    );
  });

  test.skipIf(!canSandbox)(
    "a before-tool hook refuses a call, contained",
    async () => {
      const f = await setup((call) => {
        const turn = call.request.messages.filter(
          (m) => m.role === "assistant",
        ).length;
        if (turn === 0)
          return {
            events: answer([
              { tool: "read_file", args: { path: "README.md" } },
            ]),
          };
        return {
          events: answer([{ text: lastResults(call.request)[0].output }]),
        };
      });
      f.harness.hookAdmit({
        projectId: f.project.id,
        event: "before-tool",
        argv: [
          "/bin/sh",
          "-c",
          "cat >/dev/null; echo 'reads are audited today' >&2; exit 2",
        ],
        timeoutMs: 10_000,
      });
      const { connection } = f.chatgpt();
      f.route(connection.id, "chatgpt/test");
      const started = await f.start({
        routeAlias: "chatgpt/test",
        prompt: "read",
        mode: "investigate",
      });
      const view = await f.settle(started.attemptId);
      expect(view.summary).toContain("reads are audited today");
    },
  );
});

describe("credential isolation", () => {
  test("credentials are absent from the renderer view, journal, receipts and history database", async () => {
    const f = await setup(() => ({ events: answer([{ text: "ok" }]) }));
    const { connection, credential } = f.chatgpt();
    const api = f.apiKey("openai-api", "sk-synthetic-SECRET-0123456789");
    await new Promise((r) => setTimeout(r, 10));
    f.route(connection.id, "chatgpt/test");
    f.route(api.connection.id, "openai/test");
    for (const alias of ["chatgpt/test", "openai/test"]) {
      const started = await f.start({
        routeAlias: alias,
        prompt: "hi",
        mode: "investigate",
      });
      await f.settle(started.attemptId);
    }
    const secrets = [
      credential.accessToken,
      credential.refreshToken!,
      "sk-synthetic-SECRET-0123456789",
      f.endpoint.token,
    ];
    const view = JSON.stringify(f.proxy.view());
    const receipts = JSON.stringify(f.proxy.registry.receipts({}));
    const journal = JSON.stringify(
      f.store.db.prepare("SELECT body FROM native_journal").all(),
    );
    const documents = JSON.stringify(
      f.store.db.prepare("SELECT body FROM documents").all(),
    );
    for (const secret of secrets) {
      expect(view).not.toContain(secret);
      expect(receipts).not.toContain(secret);
      expect(journal).not.toContain(secret);
      expect(documents).not.toContain(secret);
    }
    expect(existsSync(path.join(f.directory, "connections.sqlite"))).toBe(true);
    // The connection database is encrypted: no plaintext header or token.
    const bytes = await readFile(path.join(f.directory, "connections.sqlite"));
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(bytes.includes(Buffer.from("sk-synthetic-SECRET"))).toBe(false);
  });
});

describe("admitted MCP servers", () => {
  const python = "/Library/Developer/CommandLineTools/usr/bin/python3";
  const server = String.raw`
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fixture", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "shout", "description": "Upper-cases text", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": message["params"]["arguments"]["text"].upper()}]}
    else:
        result = {}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}) + "\n")
    sys.stdout.flush()
`;
  test.skipIf(!canSandbox || !existsSync(python))(
    "a contained MCP server's admitted tool is callable under its namespaced name",
    async () => {
      const f = await setup(
        (call) => {
          const turn = call.request.messages.filter(
            (m) => m.role === "assistant",
          ).length;
          if (turn === 0)
            return {
              events: answer([
                { tool: "mcp__fixture__shout", args: { text: "quiet" } },
              ]),
            };
          return {
            events: answer([
              { text: `MCP said ${lastResults(call.request)[0].output}` },
            ]),
          };
        },
        // The server is part of the project, so each task's copy carries it.
        { files: { "README.md": "x\n", "tools/mcp-server.py": server } },
      );
      const argv = [python, "-u", "tools/mcp-server.py"];
      const inspected = await f.harness
        .mcpInspect(f.project.id, "fixture", argv, [])
        .catch((error) => ({ error }));
      if ("error" in inspected) throw inspected.error;
      expect(inspected.tools.map((t) => t.name)).toEqual(["shout"]);
      const definition = f.harness.mcpAdmit({
        projectId: f.project.id,
        name: "fixture",
        argv,
        networkDomains: [],
        tools: Object.fromEntries(
          inspected.tools.map((t) => [t.name, t.schemaHash]),
        ),
      });
      const { connection } = f.chatgpt();
      f.route(connection.id, "chatgpt/test");
      const started = await f.start({
        routeAlias: "chatgpt/test",
        prompt: "shout",
        mode: "investigate",
        mcpServerIds: [definition.id],
      });
      expect(f.upstream.calls.length).toBeGreaterThanOrEqual(0);
      const view = await f.settle(started.attemptId);
      expect(view.summary).toBe("MCP said QUIET");
      // The plan route carries every tool inside Topsl's one namespace.
      const [namespace] = f.upstream.calls[0].body.tools;
      expect(namespace).toMatchObject({ type: "namespace", name: "topsl" });
      expect(namespace.tools.map((t: any) => t.name)).toContain(
        "mcp__fixture__shout",
      );
    },
  );
});

describe("project folders", () => {
  test("a native task needs a Git project folder", async () => {
    const f = await setup(() => ({ events: answer([{ text: "never" }]) }), {
      git: false,
    });
    const { connection } = f.chatgpt();
    f.route(connection.id, "chatgpt/test");
    await expect(
      f.start({ routeAlias: "chatgpt/test", prompt: "add a file" }),
    ).rejects.toThrow("need a Git project folder");
    expect(f.upstream.calls).toHaveLength(0);
  });
});
