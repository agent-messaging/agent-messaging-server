import { defineConfig } from "vitest/config";

// The scenario talks to a live mesh, so its files run one at a time, and a
// test may wait as long as the configured shipment takes.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: Number(process.env.TEST_TIMEOUT_MS ?? 180_000),
    hookTimeout: 60_000,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: `.state/junit-${process.env.BROKER ?? "nats"}.xml` },
  },
});
