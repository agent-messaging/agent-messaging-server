import { defineConfig } from "vitest/config";

// Unit lane. Integration specs (__tests__/integration/**) run separately via
// `npm run test:integration` (vitest.integration.config.ts) — they need a live
// mesh and must not run in the fast unit lane.
//
// This file did not exist until 2026-07-30, and its absence was not cosmetic.
// With no config, `vitest run` picked up EVERY *.test.ts including the live
// integration spec, and that spec turned itself on whenever `CI` was set — so the
// unit job dialled production api.agentmesh.ai with no credentials. A unit lane
// whose verdict depends on whether a remote deployment answers is not a unit lane.
//
// It went unnoticed because the spec landed just after the last green run and every
// run afterwards was blocked on GitHub billing, so it was never once executed by a
// working CI. When the block cleared it failed six ways with "ReferenceError:
// WebSocket is not defined" out of nats.ws — Node 20 has no global WebSocket — which
// points nowhere near the actual cause.
//
// The include is a whitelist rather than an exclude for the same reason services
// uses one: a new directory of live specs should be invisible to this lane until
// someone deliberately adds it, not swept in by default.
export default defineConfig({
  test: {
    include: ["__tests__/unit/**/*.test.ts"],
  },
});
