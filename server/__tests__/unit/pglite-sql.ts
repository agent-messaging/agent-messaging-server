/**
 * PGlite (Postgres in the test's own process) behind the storage layer's
 * `Sql` interface, so the Postgres side of the RabbitMQ binding is tested on
 * the database it runs on, with no server. PGlite is one connection, so
 * queries run one at a time, as on a pool of one.
 */
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../../src/storage/postgres/sql.js";

export async function pgliteSql(): Promise<Sql & { db: PGlite }> {
  const db = await PGlite.create();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const run = async <T>(text: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      const results = await db.exec(text);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? 0 };
    }
    const r = await db.query<T>(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
  };
  return {
    db,
    query: <T>(text: string, params?: unknown[]) => serial(() => run<T>(text, params)),
    session: (fn) => fn(<T>(text: string, params?: unknown[]) => serial(() => run<T>(text, params))) as never,
    async listen(channel, onNotify) {
      const off = await db.listen(channel, onNotify);
      return async () => {
        await off();
      };
    },
    async close() {
      await db.close();
    },
  } as Sql & { db: PGlite };
}
