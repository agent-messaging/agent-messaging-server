/**
 * Postgres notifications, shared: one LISTEN per channel per database
 * connection, fanned out to everyone waiting on a name (a keyed store, a
 * stream). The payload of a notification is that name.
 */
import type { Sql } from "./sql.js";

class Notices {
  private readonly waiters = new Map<string, Set<() => void>>();
  private listening: Promise<unknown> | null = null;
  constructor(
    private readonly sql: Sql,
    private readonly channel: string,
  ) {}

  /** Call `wake` on every notification naming `name`. Resolves once
   *  listening, with a function that stops. */
  async on(name: string, wake: () => void): Promise<() => void> {
    if (!this.listening) {
      const p = this.sql.listen(this.channel, (payload) => {
        for (const fn of this.waiters.get(payload) ?? []) fn();
      });
      this.listening = p;
      p.catch(() => {
        if (this.listening === p) this.listening = null;
      });
    }
    await this.listening;
    let set = this.waiters.get(name);
    if (!set) this.waiters.set(name, (set = new Set()));
    set.add(wake);
    return () => {
      set!.delete(wake);
    };
  }
}

const all = new WeakMap<Sql, Map<string, Notices>>();

export function notices(sql: Sql, channel: string): Notices {
  let bySql = all.get(sql);
  if (!bySql) all.set(sql, (bySql = new Map()));
  let n = bySql.get(channel);
  if (!n) bySql.set(channel, (n = new Notices(sql, channel)));
  return n;
}
