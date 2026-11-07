/**
 * An A2A Task's platform outputs on the RabbitMQ deployment's store:
 * Postgres (PGlite here, or AMS_TEST_POSTGRES_URL for a real server), through
 * the storage layer's Postgres keyed records. The scenario is
 * helpers/a2a-parity-scenario.ts; integration/a2a-parity-jetstream.test.ts
 * runs it on JetStream.
 */
import { afterEach, beforeEach, it } from "vitest";
import { pgSql, type Sql } from "../../src/storage/postgres/sql.js";
import { PostgresState } from "../../src/storage/postgres/state.js";
import type { Storage } from "../../src/storage/index.js";
import { pgliteSql } from "./pglite-sql.js";
import { a2aParityScenario } from "../helpers/a2a-parity-scenario.js";

let sql: Sql & { close(): Promise<void> };
let state: PostgresState;
const REAL = process.env.AMS_TEST_POSTGRES_URL?.trim();

beforeEach(async () => {
  if (REAL) {
    sql = pgSql({ connectionString: REAL, max: 4 });
    await sql.query("drop table if exists ams_keyed, ams_keyed_stores, ams_streams, ams_stream_messages, ams_stream_consumers, ams_account, ams_broker_sessions, ams_schema cascade");
  } else {
    sql = await pgliteSql();
  }
  state = new PostgresState(sql);
  await state.open();
});
afterEach(async () => {
  await state.close();
  await sql.close();
});

it("an A2A Task from request to cancel: origin, canceled_by, receipt and admin read on Postgres", async () => {
  await a2aParityScenario({
    tasks: state.keyed("mesh_tasks"),
    a2a: state.keyed("mesh_a2a_tasks"),
    origins: state.keyed("mesh_task_origins"),
    storage: { keyed: async (name: string) => state.keyed(name as never) } as unknown as Storage,
  });
});
