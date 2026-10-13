import { defineConfig } from "vitest/config";

// The integration lane: tests that need a live broker. Each one skips, and
// says what to set, when the broker it needs is not there.
export default defineConfig({
  test: {
    include: ["__tests__/integration/**/*.test.ts"],
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
