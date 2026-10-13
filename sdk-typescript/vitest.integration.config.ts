import { defineConfig } from "vitest/config";

// Integration lane (live NATS via $NATS_URL). No integration specs exist yet —
// they're a Phase 5 (testing) deliverable — so `passWithNoTests` keeps the CI
// lane green until they land instead of failing on "no test files found".
export default defineConfig({
  test: {
    include: ["__tests__/integration/**/*.test.ts"],
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
