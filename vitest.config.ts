import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Generous budgets for slow hosted runners: on Intel macOS one test with two
    // package preparations ran past 60 seconds, and some Windows runners take two
    // to three times as long as others (170 s instead of 65 s for one test).
    // Passing tests finish far sooner.
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 2,
    fileParallelism: true,
  },
});
