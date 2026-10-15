import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Generous budgets for slow hosted runners: on Intel macOS one test with two
    // package preparations ran past 60 seconds. Passing tests finish far sooner.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 2,
    fileParallelism: true,
  },
});
