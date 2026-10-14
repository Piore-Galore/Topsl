import { test, expect } from "vitest";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fixture } from "./helpers";
import { advanceSequence } from "../packages/domain/events";
const p95 = (values: number[]) =>
  values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * 0.95)];
const benchmark = process.env.TOPSL_BENCHMARK === "1" ? test : test.skip;
benchmark(
  "records an actual 100k mixed-project scoped-history and four-stream benchmark",
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      before = process.memoryUsage(),
      started = performance.now();
    try {
      const text = "Mixed project native fixture · 测量 · " + "x".repeat(160);
      f.store.transaction(() => {
        for (let i = 0; i < 100000; i++)
          f.store.message({
            id: `bench:${i}`,
            projectId: `project:${i % 8}`,
            conversationId: `conversation:${i % 16}`,
            role: i % 2 ? "assistant" : "user",
            provider: i % 3 ? "codex" : "claude",
            text: `${text} ${i}`,
            runId: `run:${i % 4}`,
            nativeId: `native:${i}`,
            createdAt: new Date(1700000000000 + i).toISOString(),
          });
      });
      const ingestMs = performance.now() - started,
        queryMs: number[] = [],
        replayMs: number[] = [];
      let cursor: string | null = null,
        count = 0;
      do {
        const at = performance.now();
        const page = f.store.messagesPage({
          projectId: "project:0",
          limit: 200,
          cursor,
        });
        queryMs.push(performance.now() - at);
        expect(page.items.every((item) => item.projectId === "project:0")).toBe(
          true,
        );
        count += page.items.length;
        cursor = page.nextCursor;
      } while (cursor);
      expect(count).toBe(12500);
      let client = f.store.controlHead(),
        resyncs = 0;
      const streamMs: number[] = [];
      for (let round = 0; round < 100; round++) {
        const begin = performance.now();
        await Promise.all(
          Array.from({ length: 4 }, async (_, stream) => {
            await Promise.resolve();
            f.store.message({
              id: `stream:${stream}`,
              projectId: `project:${stream}`,
              conversationId: `stream:${stream}`,
              role: "assistant",
              provider: stream % 2 ? "claude" : "codex",
              text: "stream fixture ".repeat(round + 1),
              runId: `stream-run:${stream}`,
              nativeId: `stream:${stream}`,
              createdAt: new Date().toISOString(),
            });
          }),
        );
        const page = f.store.controlPage(client, {}, 200),
          next = advanceSequence(client, page);
        expect(next.resync).toBe(false);
        client = next.sequence;
        streamMs.push(performance.now() - begin);
        if (round === 50) {
          const missed = f.store.controlPage(Math.max(0, client - 4), {}, 2);
          if (advanceSequence(client - 8, missed).resync) {
            resyncs++;
            const time = performance.now();
            client = f.store.controlHead();
            f.store.messagesPage({ projectId: "project:0", limit: 80 });
            replayMs.push(performance.now() - time);
          }
        }
      }
      expect(resyncs).toBe(1);
      const cancelAt = performance.now();
      f.store.save("task", {
        id: "cancel-fixture",
        projectId: "project:0",
        state: "cancelled",
      });
      f.store.controlPage(client);
      const cancelMs = performance.now() - cancelAt;
      const databaseBytes = (
          await stat(path.join(f.directory, "history.sqlite"))
        ).size,
        walBytes = (await stat(path.join(f.directory, "history.sqlite-wal")))
          .size;
      const report = {
        sourceSizes: { databaseBytes, walBytes },
        recordedAt: new Date().toISOString(),
        environment: {
          platform: process.platform,
          arch: process.arch,
          release: os.release(),
          cpu: os.cpus()[0]?.model,
          cores: os.cpus().length,
          totalMemoryBytes: os.totalmem(),
          node: process.versions.node,
          electron: process.versions.electron,
          sqlite: f.store.db.prepare("SELECT sqlite_version() AS version").get()
            .version,
        },
        workload: {
          messages: 100000,
          projects: 8,
          conversations: 16,
          payloadTextBytes: Buffer.byteLength(text),
          streams: 4,
          streamUpdatesEach: 100,
          historyPageLimit: 200,
          eventBatchLimit: 200,
          transcriptWindowRows: 20,
        },
        measurements: {
          ingestMs,
          historyQueryP95Ms: p95(queryMs),
          fixtureCommitAndNormalizedClientP95Ms: p95(streamMs),
          cancelControlRoundTripMs: cancelMs,
          resyncSnapshotMs: replayMs[0],
          rssBefore: before.rss,
          rssAfter: process.memoryUsage().rss,
          heapUsedBefore: before.heapUsed,
          heapUsedAfter: process.memoryUsage().heapUsed,
        },
        limits: [
          "Encrypted store plus normalized event consumer; Chromium paint and provider network/inference are excluded.",
          "Four fixture streams measure ingestion headroom; live coordinator default remains two.",
          "Cancellation measures a durable control update, not provider termination.",
        ],
      };
      await mkdir("test-results", { recursive: true });
      await writeFile(
        path.resolve("test-results/coordination-benchmark.json"),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
