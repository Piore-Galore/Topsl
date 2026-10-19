import { afterEach, expect, test, vi } from "vitest";
import {
  ScopedReadFence,
  ScopedRefreshController,
  type ScopeTransport,
} from "../apps/desktop/renderer/state/scoped-controller";
import type { ChangePage } from "../packages/domain/events";
import { usageReadout } from "../apps/desktop/renderer/state/usage-view";
import { summarizeUsage } from "../packages/domain/usage";
import {
  outputReviewState,
  safeRasterSource,
} from "../apps/desktop/renderer/components/candidate-artifacts";
const observation = (
  sequence: number,
  epoch = "epoch-a",
  projectId = "project",
) => ({ projectId, epoch, sequence, generatedAt: "2026-10-15T00:00:00.000Z" });
const snapshot = (sequence: number, epoch = "epoch-a") => ({
  observation: observation(sequence, epoch),
  value: sequence,
});
const page = (
  afterSequence: number,
  throughSequence = afterSequence,
  epoch = "epoch-a",
  relevant = false,
): ChangePage => ({
  epoch,
  afterSequence,
  throughSequence,
  headSequence: throughSequence,
  hasMore: false,
  events: relevant
    ? [
        {
          sequence: throughSequence,
          projectId: "project",
          conversationId: null,
          kind: "task",
          id: "task",
          operation: "put",
        },
      ]
    : [],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());
test("artifact display requires an exact candidate/hash receipt and a bounded safe raster", () => {
  const candidate = { id: "candidate", revision: "revision" },
    output = { path: "src/new.ts", hash: "hash", status: "pending" };
  expect(
    outputReviewState(
      candidate,
      [
        {
          candidateId: "old",
          candidateRevision: "revision",
          entries: [{ ...output, decision: "approved" }],
        },
      ],
      output,
    ),
  ).toBe("pending");
  expect(
    outputReviewState(
      candidate,
      [
        {
          candidateId: "candidate",
          candidateRevision: "revision",
          entries: [{ ...output, hash: "other", decision: "approved" }],
        },
      ],
      output,
    ),
  ).toBe("pending");
  expect(
    outputReviewState(
      candidate,
      [
        {
          candidateId: "candidate",
          candidateRevision: "revision",
          entries: [
            { ...output, decision: "approved" },
            { ...output, decision: "rejected" },
          ],
        },
      ],
      output,
    ),
  ).toBe("rejected");
  expect(
    safeRasterSource({ mime: "image/svg+xml", bytes: 100, base64: "fixture" }),
  ).toBeNull();
  expect(
    safeRasterSource({
      mime: "image/png",
      bytes: 2_000_001,
      base64: "fixture",
    }),
  ).toBeNull();
  expect(
    safeRasterSource({ mime: "image/png", bytes: 10, base64: "fixture" }),
  ).toBe("data:image/png;base64,fixture");
});
test("R2-AT-35 absent usage displays unknown rather than zero", () => {
  expect(usageReadout(summarizeUsage([], ["run"]))).toBe(
    "Input unknown · output unknown · no reported usage",
  );
});
test("R2-AT-31 same-project revisions beat reverse response arrival and request order", () => {
  const fence = new ScopedReadFence("project"),
    first = fence.begin(),
    second = fence.begin();
  expect(fence.accept(second, observation(20))).toBe(true);
  expect(fence.accept(first, observation(19))).toBe(false);
  const third = fence.begin(),
    fourth = fence.begin();
  expect(fence.accept(fourth, observation(21))).toBe(true);
  expect(fence.accept(third, observation(22))).toBe(true);
  expect(fence.accept(fence.begin(), observation(21))).toBe(false);
});
test("R2-AT-32 selection generation and retired vault epochs reject stale data", () => {
  const fence = new ScopedReadFence("project"),
    old = fence.begin();
  fence.reset("other");
  expect(fence.accept(old, observation(100))).toBe(false);
  expect(
    fence.accept(fence.begin(), observation(1, "epoch-a", "project")),
  ).toBe(false);
  fence.reset("project");
  const previous = fence.begin(),
    restored = fence.begin();
  expect(fence.accept(previous, observation(100))).toBe(true);
  expect(fence.accept(restored, observation(2, "restored"))).toBe(true);
  expect(fence.accept(fence.begin(), observation(101))).toBe(false);
});
test("R2-AT-33 subscribing before snapshot plus durable replay does not lose a commit", async () => {
  vi.useFakeTimers();
  const pending = deferred<any>();
  let notify!: (page: ChangePage) => void;
  const transport: ScopeTransport = {
    snapshot: vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(snapshot(11)),
    replay: vi.fn(async (after) => page(after, 11, "epoch-a", after < 11)),
    subscribe: vi.fn((callback) => {
      notify = callback;
      return () => {};
    }),
  };
  const controller = new ScopedRefreshController("project", transport),
    stop = controller.subscribe(() => {});
  expect(transport.subscribe).toHaveBeenCalledTimes(1);
  notify(page(10, 11, "epoch-a", true));
  pending.resolve(snapshot(10));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.state.status).toBe("resynchronizing");
  await vi.advanceTimersByTimeAsync(80);
  expect(controller.state.observation?.sequence).toBe(11);
  expect(controller.state.status).toBe("current");
  stop();
});
test("R2-AT-33 refresh failure retains last-known data and retries only bounded reads", async () => {
  vi.useFakeTimers();
  const transport: ScopeTransport = {
    snapshot: vi
      .fn()
      .mockResolvedValueOnce(snapshot(10))
      .mockRejectedValue(new Error("vault unavailable")),
    replay: vi.fn(async (after) => page(after)),
    subscribe: () => () => {},
  };
  const controller = new ScopedRefreshController("project", transport),
    stop = controller.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  await controller.refresh();
  expect(controller.state).toMatchObject({
    status: "stale",
    error: "vault unavailable",
    snapshot: { value: 10 },
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(transport.snapshot).toHaveBeenCalledTimes(5);
  expect(controller.state.status).toBe("stale");
  stop();
});
test("R2-AT-33 epoch mismatch during replay resnapshots before publishing restored data", async () => {
  vi.useFakeTimers();
  const shown: number[] = [];
  const transport: ScopeTransport = {
    snapshot: vi
      .fn()
      .mockResolvedValueOnce(snapshot(100))
      .mockResolvedValue(snapshot(2, "restored")),
    replay: vi.fn(async (after) => page(after, after, "restored")),
    subscribe: () => () => {},
  };
  const controller = new ScopedRefreshController("project", transport),
    stop = controller.subscribe((state) => {
      if (state.snapshot) shown.push(state.snapshot.value);
    });
  await vi.advanceTimersByTimeAsync(80);
  expect(shown).not.toContain(100);
  expect(controller.state).toMatchObject({
    status: "current",
    observation: { epoch: "restored", sequence: 2 },
  });
  stop();
});
test("a backlog of another project's records does not hold back this project's newer change", async () => {
  vi.useFakeTimers();
  const pending = deferred<any>();
  let notify!: (page: ChangePage) => void;
  const transport: ScopeTransport = {
    snapshot: vi
      .fn()
      .mockResolvedValueOnce(snapshot(100))
      .mockResolvedValueOnce(snapshot(110))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(snapshot(120)),
    replay: vi.fn(async (after) => page(after)),
    subscribe: vi.fn((callback) => {
      notify = callback;
      return () => {};
    }),
  };
  // The service is still publishing an earlier import into another project,
  // so its pages are old and name no record of this project.
  const behind = (after: number, head: number): ChangePage => ({
    ...page(after, after + 20),
    headSequence: head,
    hasMore: true,
  });
  const controller = new ScopedRefreshController("project", transport),
    stop = controller.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.state.observation?.sequence).toBe(100);
  notify(behind(20, 100));
  await vi.advanceTimersByTimeAsync(80);
  expect(transport.snapshot).toHaveBeenCalledTimes(1);
  // This project changed at 110, behind the backlog.
  notify(behind(40, 110));
  await vi.advanceTimersByTimeAsync(80);
  expect(transport.snapshot).toHaveBeenCalledTimes(2);
  expect(controller.state.observation?.sequence).toBe(110);
  // A change at 120 lands while a refresh is reading 115.
  void controller.refresh();
  notify(behind(60, 120));
  pending.resolve(snapshot(115));
  await vi.advanceTimersByTimeAsync(80);
  expect(transport.snapshot).toHaveBeenCalledTimes(4);
  expect(controller.state).toMatchObject({
    status: "current",
    observation: { sequence: 120 },
  });
  stop();
});
test("multiple consumers share one active subscription and pending refreshes coalesce", async () => {
  vi.useFakeTimers();
  const pending = deferred<any>(),
    unsubscribe = vi.fn();
  const transport: ScopeTransport = {
    snapshot: vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(snapshot(1)),
    replay: vi.fn(async (after) => page(after)),
    subscribe: vi.fn(() => unsubscribe),
  };
  const controller = new ScopedRefreshController("project", transport),
    a = controller.subscribe(() => {}),
    b = controller.subscribe(() => {});
  void controller.refresh();
  void controller.refresh();
  expect(transport.snapshot).toHaveBeenCalledTimes(1);
  pending.resolve(snapshot(1));
  await vi.advanceTimersByTimeAsync(80);
  expect(transport.snapshot).toHaveBeenCalledTimes(2);
  a();
  expect(unsubscribe).not.toHaveBeenCalled();
  b();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
test("F-01: a routine refresh keeps the shown state actionable; a failure, disconnection or missed change does not", async () => {
  vi.useFakeTimers();
  const pending = deferred<any>();
  let notify!: (page: ChangePage) => void;
  const transport: ScopeTransport = {
    snapshot: vi
      .fn()
      .mockResolvedValueOnce(snapshot(10))
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("vault unavailable"))
      .mockResolvedValue(snapshot(12)),
    replay: vi.fn(async (after) => page(after)),
    subscribe: vi.fn((callback) => {
      notify = callback;
      return () => {};
    }),
  };
  const seen: Array<[string, boolean]> = [];
  const controller = new ScopedRefreshController("project", transport),
    stop = controller.subscribe((state) =>
      seen.push([state.status, state.actionable]),
    );
  // Nothing has been read yet.
  expect(controller.state.actionable).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.state).toMatchObject({
    status: "current",
    actionable: true,
  });
  // A change arrives and the controller refreshes: the status says so, and
  // the shown state stays actionable throughout, so a gated control stays on.
  seen.length = 0;
  notify(page(10, 11, "epoch-a", true));
  await vi.advanceTimersByTimeAsync(80);
  expect(controller.state.status).toBe("refreshing");
  pending.resolve(snapshot(11));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([
    ["refreshing", true],
    ["current", true],
  ]);
  // A failed read clears it, and a later refresh does not restore it until
  // a read succeeds.
  await controller.refresh();
  expect(controller.state).toMatchObject({
    status: "stale",
    actionable: false,
  });
  seen.length = 0;
  await controller.refresh();
  expect(seen[0]).toEqual(["refreshing", false]);
  expect(controller.state).toMatchObject({
    status: "current",
    actionable: true,
  });
  // A missed change (a sequence gap) and a lost connection clear it too.
  notify(page(20, 21, "epoch-a", true));
  expect(controller.state).toMatchObject({
    status: "resynchronizing",
    actionable: false,
  });
  await vi.advanceTimersByTimeAsync(80);
  expect(controller.state.actionable).toBe(true);
  controller.disconnected();
  expect(controller.state).toMatchObject({
    status: "disconnected",
    actionable: false,
  });
  stop();
});
