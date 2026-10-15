import { vi } from "vitest";

// Hosted CI runners (especially Windows and Intel macOS) can be several times
// slower than a developer machine. vi.waitFor's built-in 1 second budget, and
// the few shorter budgets tests chose for themselves, are too short for waits on
// real child processes, package preparation and encrypted storage there. Every
// wait therefore gets at least 30 seconds. A wait still returns as soon as its
// condition holds, so passing tests are not slowed down.
const waitFor = vi.waitFor.bind(vi);
const minimumTimeout = 30_000;
vi.waitFor = ((callback, options) => {
  const requested = typeof options === "number" ? { timeout: options } : options;
  return waitFor(callback, {
    interval: 50,
    ...requested,
    timeout: Math.max(requested?.timeout ?? 0, minimumTimeout),
  });
}) as typeof vi.waitFor;
