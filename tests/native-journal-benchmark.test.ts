import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../packages/persistence/store";
import { NativeJournal } from "../packages/harness/journal";
import {
  defaultLimits,
  type ExecutionBinding,
} from "../packages/harness/types";

/**
 * Scoped-query latency of the native journal (docs/Native_Harness_Plan.md
 * §5): p95 below 100 ms at 120 attempts and 100,000 events (asserted), and
 * the latency ratio when history grows tenfold (reported). Opt-in, because it writes
 * 110,000 encrypted events:
 *
 *   TOPSL_NATIVE_BENCHMARK=1 npm test -- tests/native-journal-benchmark.test.ts
 *
 * Synthetic events on this machine only; provider latency is not measured.
 */

const enabled = process.env.TOPSL_NATIVE_BENCHMARK === "1";
const binding: ExecutionBinding = {
  id: "b",
  engine: "native",
  native: null,
  vendor: null,
  model: { reasoningEffort: null, contextWindowTokens: 200_000 },
  policyRevision: "p",
  createdAt: new Date().toISOString(),
};
const grants = {
  write: false,
  processes: false,
  networkDomains: [],
  checks: [],
  delegation: false,
  mcpTools: [],
  candidates: [],
};

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

async function populate(attempts: number, eventsTotal: number) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "topsl-test-journal-"),
  );
  const store = new Store(
    path.join(directory, "history.sqlite"),
    randomBytes(32).toString("hex"),
  );
  const journal = new NativeJournal(store);
  const ids: string[] = [];
  for (let a = 0; a < attempts; a++) {
    const id = `attempt-${a}`;
    ids.push(id);
    journal.begin(id, "project", {
      title: `Attempt ${a}`,
      prompt: "benchmark",
      binding,
      limits: defaultLimits,
      grants,
      workspace: {
        root: directory,
        identity: "w",
        writable: false,
        baselineCandidateId: null,
      },
      parentAttemptId: null,
      rootAttemptId: id,
      depth: 0,
      delegationMode: null,
    });
  }
  const perAttempt = Math.ceil(eventsTotal / attempts) - 1;
  const output = "x".repeat(400);
  for (const id of ids)
    for (let written = 0; written < perAttempt; written += 100) {
      const count = Math.min(100, perAttempt - written);
      journal.append(
        id,
        1,
        Array.from({ length: count }, (_, i) => ({
          kind: "tool-result" as const,
          body: {
            callId: `c${written + i}`,
            ok: true,
            output,
            outputHash: "h",
            outputBlob: null,
            evidence: null,
            durationMs: 1,
          },
        })),
      );
    }
  return { directory, store, journal, ids };
}

function measure(journal: NativeJournal, ids: string[]) {
  const pages: number[] = [];
  const views: number[] = [];
  const lists: number[] = [];
  for (let i = 0; i < 300; i++) {
    const id = ids[(i * 37) % ids.length];
    const view = journal.require(id);
    const after = Math.floor(
      (((i * 7919) % 1000) / 1000) * Math.max(view.throughSequence - 50, 0),
    );
    let t = performance.now();
    // 50 events per page: both sizes have at least that many per attempt,
    // so every sample returns the same number of rows.
    journal.events(id, after, 50);
    pages.push(performance.now() - t);
    t = performance.now();
    journal.view(id);
    views.push(performance.now() - t);
    t = performance.now();
    journal.list("project", { limit: 50 });
    lists.push(performance.now() - t);
  }
  return { page: p95(pages), view: p95(views), list: p95(lists) };
}

describe.skipIf(!enabled)("native journal scoped-query latency", () => {
  test("p95 under 100 ms at 100,000 events; reports the ratio to 10,000 events", async () => {
    const small = await populate(120, 10_000);
    const smallResult = measure(small.journal, small.ids);
    small.store.close();
    await rm(small.directory, { recursive: true, force: true });
    const large = await populate(120, 100_000);
    const rows = large.store.db
      .prepare("SELECT COUNT(*) AS n FROM native_journal")
      .get().n;
    const largeResult = measure(large.journal, large.ids);
    large.store.close();
    await rm(large.directory, { recursive: true, force: true });
    const ratio = Object.fromEntries(
      (["page", "view", "list"] as const).map((k) => [
        k,
        largeResult[k] / smallResult[k],
      ]),
    );
    console.log(
      JSON.stringify({
        rows,
        smallP95ms: smallResult,
        largeP95ms: largeResult,
        ratio,
      }),
    );
    expect(rows).toBeGreaterThanOrEqual(100_000);
    // The absolute target is asserted. The tenfold ratio is reported, not
    // asserted: at these sub-millisecond latencies the event-page ratio
    // depends on SQLCipher's page cache (docs/Native_Harness_Execution.md).
    for (const key of ["page", "view", "list"] as const)
      expect(largeResult[key]).toBeLessThan(100);
  });
});
