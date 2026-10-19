import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ClaudeAdapter,
  ClaudeStreamParser,
  claudeArguments,
  claudeFixtureTransport,
  type ClaudeStreamEvent,
} from "../packages/providers/claude";

describe("Claude protocol compatibility and live gate", () => {
  test("live dispatch is refused before creating a process", () => {
    const adapter = new ClaudeAdapter();
    expect(() =>
      adapter.start(
        {
          executable: "claude",
          cwd: ".",
          prompt: "no live request",
          model: "requested",
          sessionId: "id",
          mode: "review",
        },
        () => {},
      ),
    ).toThrow("gated");
    expect(adapter.capability.filesystemIsolation).toBe("unsupported");
  });
  test("arguments never enable permissions bypass, hooks, MCP, subagents or automatic model fallback", () => {
    const args = claudeArguments("requested", "fresh-session", "review");
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args.join(" ")).not.toMatch(/dangerously|fallback-model|bare/);
  });
  test("stream chunks retain native identity/effective model, reject duplicate events and omit thinking", async () => {
    const events: ClaudeStreamEvent[] = [];
    const adapter = new ClaudeAdapter(
      claudeFixtureTransport(process.execPath, [
        path.resolve("tests/fixtures/claude.cjs"),
      ]),
    );
    await adapter.start(
      {
        executable: "unused",
        cwd: process.cwd(),
        prompt: "fixture",
        model: "requested",
        sessionId: "fresh",
        mode: "review",
      },
      (e) => events.push(e),
    ).done;
    expect(events.find((e) => e.type === "session")).toMatchObject({
      sessionId: "fresh",
      reportedModel: "fixture-effective",
    });
    expect(events.find((e) => e.type === "completed")).toMatchObject({
      failed: false,
      reportedModel: "fixture-effective",
    });
    expect(JSON.stringify(events)).not.toContain("not product telemetry");
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    const replay: ClaudeStreamEvent[] = [],
      parser = new ClaudeStreamParser((e) => replay.push(e));
    const result = JSON.stringify({
      type: "result",
      session_id: "same",
      uuid: "same-result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 12 },
    });
    parser.push(result.slice(0, 20));
    parser.push(result.slice(20) + "\n" + result + "\n");
    parser.finish();
    expect(replay.filter((e) => e.type === "completed")).toHaveLength(1);
    expect(replay.filter((e) => e.type === "usage")).toHaveLength(1);
  });
  test.each(["fixture-crash", "fixture-malformed"])(
    "%s never produces a false final success",
    async (prompt) => {
      const adapter = new ClaudeAdapter(
        claudeFixtureTransport(process.execPath, [
          path.resolve("tests/fixtures/claude.cjs"),
        ]),
      );
      await expect(
        adapter.start(
          {
            executable: "unused",
            cwd: process.cwd(),
            prompt,
            model: "requested",
            sessionId: "fresh",
            mode: "edit",
          },
          () => {},
        ).done,
      ).rejects.toThrow(/unknown|Malformed/);
    },
  );
  test("a message_delta stream event, whose delta has no type, is accepted (found live with Claude Code 2.1.302)", () => {
    const events: ClaudeStreamEvent[] = [],
      parser = new ClaudeStreamParser((e) => events.push(e));
    parser.push(
      [
        '{"type":"system","subtype":"init","session_id":"s","uuid":"i"}',
        '{"type":"stream_event","session_id":"s","uuid":"a","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}}',
        '{"type":"stream_event","session_id":"s","uuid":"b","event":{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}}',
        '{"type":"result","session_id":"s","uuid":"r","subtype":"success","is_error":false,"result":"hi"}',
        "",
      ].join("\n"),
    );
    parser.finish();
    expect(events.filter((e) => e.type === "delta")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "completed", failed: false });
  });
  test("mixed sessions, subagent fanout, negative usage and identity collision fail closed", () => {
    const parser = () => new ClaudeStreamParser(() => {});
    const p = parser();
    p.push(
      '{"type":"system","subtype":"init","session_id":"one","uuid":"init"}\n',
    );
    expect(() =>
      p.push('{"type":"system","subtype":"init","session_id":"two"}\n'),
    ).toThrow("mixed");
    expect(() =>
      parser().push('{"type":"user","parent_tool_use_id":"child"}\n'),
    ).toThrow("subagent");
    expect(() =>
      parser().push(
        '{"type":"result","session_id":"a","subtype":"success","is_error":false,"usage":{"input_tokens":-1}}\n',
      ),
    ).toThrow();
    const collision = parser();
    collision.push('{"type":"user","uuid":"x"}\n');
    expect(() =>
      collision.push('{"type":"user","uuid":"x","message":"different"}\n'),
    ).toThrow("collision");
  });
});
