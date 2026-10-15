import { vi } from "vitest";

// Hosted CI runners (especially Windows and Intel macOS) can be several times
// slower than a developer machine. vi.waitFor's built-in 1 second budget is too
// short for waits on real child processes and encrypted storage there, so every
// wait gets a 20 second default. A wait still returns as soon as its condition
// holds, and an explicit timeout passed by a test still wins.
const waitFor = vi.waitFor.bind(vi);
vi.waitFor = ((callback, options) =>
  waitFor(callback, {
    timeout: 20_000,
    interval: 50,
    ...(typeof options === "number" ? { timeout: options } : options),
  })) as typeof vi.waitFor;
