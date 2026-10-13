/**
 * The one way the Postgres side of the storage layer talks to its database
 * (step 9 of docs/agent-messaging-server-plan.md).
 *
 * Small on purpose: a query, a notification listener and a close. The keyed
 * records and the streams are written against this, so the same code runs on
 * a real Postgres (`pgSql`, through the `pg` package) and on PGlite in the
 * unit tests, which is Postgres compiled to run in the test's own process.
 *
 * Every write that has to be atomic is one statement or one call of a
 * function the schema defines (schema.ts), so no caller needs a transaction
 * across round trips.
 */
import pg from "pg";

export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

export type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<SqlResult<T>>;

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
  /** Run `fn` on one connection held for its whole length (an advisory lock
   *  and the work under it must share a session). */
  session<T>(fn: (query: QueryFn) => Promise<T>): Promise<T>;
  /** Call `onNotify` with the payload of every NOTIFY on `channel`. Resolves
   *  once listening, with a function that stops. */
  listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** The connection settings, read by exact name: MESH_POSTGRES_URL, and the
 *  password from MESH_POSTGRES_PASSWORD_FILE when the URL carries none (so a
 *  settings file names where the password is, never the password). */
export function postgresConfigFromEnv(env: NodeJS.ProcessEnv = process.env, read: (p: string) => string): pg.PoolConfig {
  const url = env.MESH_POSTGRES_URL?.trim();
  if (!url) throw new Error("MESH_POSTGRES_URL is not set: the RabbitMQ binding keeps its state in Postgres.");
  const parsed = new URL(url);
  const passFile = env.MESH_POSTGRES_PASSWORD_FILE?.trim();
  if (passFile && !parsed.password) {
    let pass: string;
    try {
      pass = read(passFile).trim();
    } catch {
      throw new Error(`MESH_POSTGRES_PASSWORD_FILE points at ${passFile}, which cannot be read.`);
    }
    // Into the connection string itself: pg reads the string over a separate
    // password field.
    parsed.password = encodeURIComponent(pass);
  }
  return { connectionString: parsed.toString(), max: Number(env.MESH_POSTGRES_POOL ?? 10), application_name: "agent-messaging-server" };
}

const CHANNEL = /^[a-z_][a-z0-9_]*$/;

/** A pool of connections, and one connection kept for LISTEN. */
export function pgSql(config: pg.PoolConfig): Sql {
  const pool = new pg.Pool(config);
  // An idle client that errors (the server restarted) is dropped by the pool;
  // without a listener the error would end the process.
  pool.on("error", (err) => console.error("[postgres] idle connection error:", err.message));

  const listeners = new Map<string, Set<(payload: string) => void>>();
  let listener: pg.Client | null = null;
  let opening: Promise<pg.Client> | null = null;
  let closed = false;

  const openListener = (): Promise<pg.Client> => {
    if (listener) return Promise.resolve(listener);
    if (opening) return opening;
    opening = (async () => {
      const c = new pg.Client(config);
      c.on("notification", (n) => {
        for (const fn of listeners.get(n.channel) ?? []) {
          try {
            fn(n.payload ?? "");
          } catch {
            /* one listener's failure is its own */
          }
        }
      });
      c.on("error", (err) => {
        console.error("[postgres] notification connection error:", err.message);
        if (listener === c) listener = null;
        // Listen again on a fresh connection; a missed notification is caught
        // by the readers' own polling.
        if (!closed) setTimeout(() => void relisten(), 1000).unref?.();
      });
      await c.connect();
      for (const ch of listeners.keys()) await c.query(`LISTEN ${ch}`);
      listener = c;
      return c;
    })();
    opening.catch(() => undefined).finally(() => {
      opening = null;
    });
    return opening;
  };
  const relisten = async () => {
    try {
      await openListener();
    } catch (err) {
      console.error("[postgres] could not listen again:", err instanceof Error ? err.message : err);
      if (!closed) setTimeout(() => void relisten(), 5000).unref?.();
    }
  };

  return {
    async query<T>(text: string, params?: unknown[]) {
      const r = await pool.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async session(fn) {
      const client = await pool.connect();
      try {
        return await fn(async <T>(text: string, params?: unknown[]) => {
          const r = await client.query(text, params as unknown[]);
          return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
        });
      } finally {
        client.release();
      }
    },
    async listen(channel, onNotify) {
      if (!CHANNEL.test(channel)) throw new Error(`not a channel name: ${channel}`);
      let set = listeners.get(channel);
      const first = !set;
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(onNotify);
      const c = await openListener();
      if (first) await c.query(`LISTEN ${channel}`);
      return async () => {
        set!.delete(onNotify);
      };
    },
    async close() {
      closed = true;
      await listener?.end().catch(() => undefined);
      listener = null;
      await pool.end().catch(() => undefined);
    },
  };
}
