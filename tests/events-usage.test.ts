import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers";
import { advanceSequence, type ChangePage } from "../packages/domain/events";
import { budgetAlerts, summarizeUsage } from "../packages/domain/usage";
import type { UsageFact } from "../packages/domain/types";
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  return f;
}
const fact = (overrides: Partial<UsageFact> = {}): UsageFact => ({
  id: "event",
  runId: "run",
  provider: "codex",
  sessionId: "session",
  input: 10,
  output: 4,
  cached: 3,
  source: "native-runtime",
  scope: "turn",
  scopeLevel: "turn",
  semantics: "cumulative",
  cachedIncludedInInput: true,
  ...overrides,
});
describe("ordered durable scoped events", () => {
  test("committed sequence follows a snapshot and remains metadata only, with bounded unrelated streams", async () => {
    const { store } = await setup();
    const at = store.controlHead();
    store.transaction(() => {
      for (let i = 0; i < 700; i++)
        store.message({
          id: `m${i}`,
          projectId: i % 2 ? "other" : "target",
          conversationId: `c${i % 4}`,
          role: "assistant",
          provider: "codex",
          text: "SECRET_PAYLOAD_NOT_IN_EVENT",
          runId: null,
          nativeId: null,
          createdAt: new Date().toISOString(),
        });
    });
    const page = store.controlPage(at, { projectId: "target" }, 200);
    expect(page.events).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.throughSequence - at).toBe(200);
    expect(JSON.stringify(page)).not.toContain("SECRET_PAYLOAD");
    expect(page.events.every((event) => event.projectId === "target")).toBe(
      true,
    );
    expect(advanceSequence(at, page)).toEqual({
      sequence: page.throughSequence,
      resync: false,
    });
    const missed = store.controlPage(
      page.throughSequence + 200,
      { projectId: "target" },
      200,
    );
    expect(advanceSequence(page.throughSequence, missed).resync).toBe(true);
    const head = store.controlHead();
    expect(() =>
      store.transaction(() => {
        store.put("task", { id: "rollback", projectId: "target" });
        throw new Error("crash");
      }),
    ).toThrow("crash");
    expect(store.controlHead()).toBe(head);
    expect(store.get("task", "rollback")).toBeUndefined();
  });
  test("duplicates/out-of-order and malformed envelopes resync; scoped sequence skips are valid", () => {
    const page: ChangePage = {
      afterSequence: 2,
      throughSequence: 8,
      headSequence: 8,
      hasMore: false,
      events: [
        {
          sequence: 4,
          kind: "task",
          id: "a",
          projectId: "p",
          conversationId: null,
          operation: "put",
        },
        {
          sequence: 8,
          kind: "task",
          id: "b",
          projectId: "p",
          conversationId: null,
          operation: "put",
        },
      ],
    };
    expect(advanceSequence(2, page)).toEqual({ sequence: 8, resync: false });
    expect(advanceSequence(8, page)).toEqual({ sequence: 8, resync: false });
    expect(
      advanceSequence(2, { ...page, events: [page.events[1], page.events[0]] })
        .resync,
    ).toBe(true);
    expect(
      advanceSequence(2, { ...page, events: [page.events[0], page.events[0]] })
        .resync,
    ).toBe(true);
    expect(advanceSequence(2, { ...page, headSequence: 3 }).resync).toBe(true);
    expect(advanceSequence(2, { ...page, throughSequence: NaN }).resync).toBe(
      true,
    );
  });
  test("restored cursor above the vault head refuses replay", async () => {
    const { store } = await setup();
    expect(() => store.controlPage(store.controlHead() + 1)).toThrow("resync");
  });
});
describe("source aware usage and approximate thresholds", () => {
  test("repeated cumulative snapshots count once, cached input overlaps once", () => {
    const total = summarizeUsage([fact(), fact({ id: "copy" })], ["run"]);
    expect(total).toMatchObject({
      input: 10,
      output: 4,
      cached: 3,
      complete: true,
    });
  });
  test("event identities deduplicate deltas and only later deltas follow a cumulative boundary", () => {
    const total = summarizeUsage(
      [
        fact({ ordinal: 3 }),
        fact({
          id: "delta",
          eventId: "d",
          semantics: "delta",
          ordinal: 4,
          input: 2,
          output: 1,
          cached: 0,
        }),
        fact({
          id: "duplicate",
          eventId: "d",
          semantics: "delta",
          ordinal: 4,
          input: 2,
          output: 1,
          cached: 0,
        }),
        fact({
          id: "old",
          semantics: "delta",
          ordinal: 1,
          input: 50,
          output: 50,
          cached: 0,
        }),
      ],
      ["run"],
    );
    expect(total).toMatchObject({ input: 12, output: 5, cached: 3 });
  });
  test("native snapshot order defeats arrival order and conflicting/unknown provenance stays uncertain", () => {
    expect(
      summarizeUsage(
        [fact({ ordinal: 3, input: 30 }), fact({ ordinal: 1, input: 10 })],
        ["run"],
      ).knownInput,
    ).toBe(30);
    expect(
      summarizeUsage(
        [fact({ ordinal: 3, input: 30 }), fact({ ordinal: 3, input: 10 })],
        ["run"],
      ).complete,
    ).toBe(false);
    expect(
      summarizeUsage([fact({ input: 30 }), fact({ input: 10 })], ["run"])
        .complete,
    ).toBe(false);
    const overlap = summarizeUsage(
      [
        fact(),
        fact({ source: "native-parser" }),
        fact({ source: "api-estimate", input: 900 }),
      ],
      ["run"],
    );
    expect(overlap.knownInput).toBe(10);
    expect(overlap.complete).toBe(false);
    expect(overlap.notes.join(" ")).toContain("estimates");
  });
  test("same native session totals across runs supersede overlapping turn facts", () => {
    const total = summarizeUsage(
      [
        fact({
          scope: "session",
          scopeLevel: "session",
          input: 100,
          output: 10,
        }),
        fact({
          id: "new",
          runId: "run2",
          scope: "session",
          scopeLevel: "session",
          input: 120,
          output: 15,
        }),
        fact({
          id: "turn",
          runId: "run2",
          scope: "turn2",
          input: 20,
          output: 5,
        }),
      ],
      ["run", "run2"],
    );
    expect(total.knownInput).toBe(120);
    expect(total.knownOutput).toBe(15);
    expect(total.notes.join(" ")).toContain("overlap");
  });
  test("cached exclusive input is normalized once and missing/legacy reports stay incomplete", () => {
    expect(
      summarizeUsage([fact({ cachedIncludedInInput: false })], ["run"]).input,
    ).toBe(13);
    expect(summarizeUsage([fact()], ["run", "missing"])).toMatchObject({
      input: null,
      knownInput: 10,
      complete: false,
      coveredRuns: 1,
    });
    expect(
      summarizeUsage([fact({ semantics: undefined })], ["run"]).complete,
    ).toBe(false);
    expect(summarizeUsage([fact({ input: null })], ["run"]).input).toBeNull();
  });
  test("unknown usage does not become a zero-cost assertion or a fabricated native allowance", () => {
    const summary = summarizeUsage([], ["missing"]),
      alerts = budgetAlerts(summary, 1000, { tokens: 10, wallMs: 500 });
    expect(summary.input).toBeNull();
    expect(alerts).toMatchObject({
      approximate: true,
      tokenAlert: false,
      wallAlert: true,
    });
    expect(alerts.detail).toContain("Unknown usage");
  });
});
