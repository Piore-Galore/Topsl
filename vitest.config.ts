import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Generous budgets for slow hosted runners; passing tests finish far sooner.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    maxWorkers: 2,
    fileParallelism: true,
  },
});
