import { defineConfig } from "vitest/config";

// The unit lane. The integration tests (__tests__/integration) need a live
// broker and run with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["__tests__/unit/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
