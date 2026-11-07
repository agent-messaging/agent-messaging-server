/**
 * An A2A Task's platform outputs on the NATS deployment's store: JetStream
 * key-value buckets on a real nats-server, through the storage layer. The
 * scenario is helpers/a2a-parity-scenario.ts; unit/a2a-parity-postgres.test.ts
 * runs it on Postgres.
 *
 * Needs a nats-server binary (NATS_SERVER_BIN, or the checked-in Windows one);
 * without one the test skips.
 */
import { afterAll, beforeAll, it } from "vitest";
import { startNatsServer, type TestServer } from "../helpers/nats-server.js";
import { storageOf } from "../../src/storage/index.js";
import { a2aFollowupsScenario, a2aParityScenario } from "../helpers/a2a-parity-scenario.js";

let server: TestServer | null = null;

beforeAll(async () => {
  server = await startNatsServer("a2a-parity");
}, 30_000);

afterAll(async () => {
  await server?.stop();
});

it("an A2A Task from request to cancel: origin, canceled_by, receipt and admin read on JetStream", async (ctx) => {
  if (!server) return ctx.skip();
  const storage = storageOf(server.nc.jetstream());
  await a2aParityScenario({
    tasks: await storage.keyed("mesh_tasks"),
    a2a: await storage.keyed("mesh_a2a_tasks"),
    origins: await storage.keyed("mesh_task_origins"),
    storage,
  });
});

it("an A2A Task's inputs, input wait, overdue mark and exhausted cancel fields on JetStream", async (ctx) => {
  if (!server) return ctx.skip();
  const storage = storageOf(server.nc.jetstream());
  await a2aFollowupsScenario({ a2a: await storage.keyed("mesh_a2a_tasks"), storage });
});
