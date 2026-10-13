/**
 * Live revocation on RabbitMQ (step 9 of docs/agent-messaging-server-plan.md):
 * the same `BrokerAdmin` the key chain uses on NATS (keychain/live-revoke.ts),
 * so revocation, the kill switch's cut and the mesh pause run unchanged.
 *
 *  - lookupAccount: the account JWT, from `ams_account` (the binding's resolver).
 *  - pushAccount: check the JWT is signed by the operator or one of its
 *    signing keys and is not older than the one held, store it, and then
 *    close every connection it no longer accepts, through RabbitMQ's
 *    management API: a credential revoked at or after it was issued, or signed
 *    by a signing key the account no longer lists (the mesh pause). That is
 *    what NATS does when it takes a claims update. The broker check
 *    (broker-auth.ts) refuses those credentials when they try to come back.
 *  - stillConnected: which keys still hold a connection, from the same API.
 */
import { decode as decodeJwt } from "nats-jwt";
import type { Sql } from "../postgres/sql.js";
import { accountRefuses, verifiedClaims, type Credential } from "./broker-auth.js";

/** What the key chain needs from the broker (keychain/live-revoke.ts). */
export interface BrokerAdminLike {
  lookupAccount(accountId: string): Promise<string>;
  pushAccount(jwt: string): Promise<void>;
  stillConnected(accountId: string, keys: string[]): Promise<string[]>;
  close(): Promise<void>;
}

export interface ManagementSettings {
  /** http://127.0.0.1:15672 */
  url: string;
  user: string;
  password: string;
  vhost: string;
}

interface Connection {
  name: string;
  user: string;
}

/** RabbitMQ's management API, as far as revocation needs it. */
export class Management {
  constructor(private readonly s: ManagementSettings) {}

  private headers(): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`${this.s.user}:${this.s.password}`).toString("base64")}` };
  }

  /**
   * The connections a user name holds now. This asks the broker's connection
   * tracking (`/api/connections/username/…`), which knows a connection the
   * moment it opens; the general connection list is built from statistics a
   * few seconds behind, and would miss a connection made just before a
   * revocation.
   */
  async connectionsOf(user: string): Promise<Connection[]> {
    const res = await fetch(`${this.s.url.replace(/\/$/, "")}/api/connections/username/${encodeURIComponent(user)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`the broker's management API answered ${res.status} to a connection list`);
    return ((await res.json()) as Connection[]).filter((c) => !("vhost" in c) || (c as { vhost?: string }).vhost === this.s.vhost);
  }

  /** Close every connection of a user name, at once. */
  async closeConnectionsOf(user: string, reason: string): Promise<void> {
    const res = await fetch(`${this.s.url.replace(/\/$/, "")}/api/connections/username/${encodeURIComponent(user)}`, {
      method: "DELETE",
      headers: { ...this.headers(), "x-reason": reason },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`the broker's management API answered ${res.status} to closing connections`);
  }
}

/** The node key a connection's user name carries (`<key>:<jti>`). */
export function keyOfUser(user: string): string {
  const i = user.indexOf(":");
  return i < 0 ? user : user.slice(0, i);
}

export class RabbitMqBrokerAdmin implements BrokerAdminLike {
  constructor(
    private readonly sql: Sql,
    private readonly mgmt: Management,
    /** The operator's public key and its signing keys: who may sign the account. */
    private readonly operatorKeys: string[],
    private readonly ownSql = false,
  ) {}

  async lookupAccount(accountId: string): Promise<string> {
    const r = await this.sql.query<{ jwt: string }>("select jwt from ams_account where account = $1", [accountId]);
    const jwt = r.rows[0]?.jwt;
    if (!jwt) throw new Error("the mesh's account JWT is not in the database (first-run setup puts it there at the first start)");
    return jwt;
  }

  async pushAccount(jwt: string): Promise<void> {
    let claims: { sub?: string; iat?: number; iss: string; nats?: { type?: string } };
    try {
      claims = verifiedClaims(jwt);
    } catch (err) {
      throw new Error(`refused the account update: ${err instanceof Error ? err.message : err}`);
    }
    if (claims.nats?.type !== "account" || typeof claims.sub !== "string") throw new Error("refused the account update: not an account JWT");
    if (!this.operatorKeys.includes(claims.iss)) throw new Error("refused the account update: not signed by the operator or one of its signing keys");
    // Keep the newer of the two, as NATS's resolver does, and write only over
    // the JWT just read, so two pushes at once cannot drop each other's change.
    const held = await this.sql.query<{ jwt: string }>("select jwt from ams_account where account = $1", [claims.sub]);
    const old = held.rows[0]?.jwt;
    if (old) {
      const oldIat = (decodeJwt<Record<string, unknown>>(old) as { iat?: number }).iat ?? 0;
      if ((claims.iat ?? 0) < oldIat) throw new Error("refused the account update: the account held is newer");
    }
    const r = old
      ? await this.sql.query("update ams_account set jwt = $2, updated = now() where account = $1 and jwt = $3", [claims.sub, jwt, old])
      : await this.sql.query("insert into ams_account (account, jwt) values ($1, $2) on conflict do nothing", [claims.sub, jwt]);
    if (r.rowCount === 0) throw new Error("refused the account update: the account changed while it was being updated; try again");
    await this.sql.query("select pg_notify('ams_account', $1)", [claims.sub]);
    await this.cut(claims.sub, old ?? null, jwt);
  }

  /** Close every connection the new account refuses and the old one accepted:
   *  the credentials whose key gained a revocation, and every credential signed
   *  by a signing key the account dropped (the mesh pause). */
  private async cut(accountId: string, oldJwt: string | null, newJwt: string): Promise<void> {
    type Claims = { nats?: { revocations?: Record<string, number>; signing_keys?: (string | { key?: string })[] } };
    const read = (j: string | null): Claims => (j ? (decodeJwt<Record<string, unknown>>(j) as unknown as Claims) : {});
    const keysOf = (c: Claims) => new Set((c.nats?.signing_keys ?? []).map((e) => (typeof e === "string" ? e : e?.key)).filter(Boolean) as string[]);
    const before = read(oldJwt);
    const after = read(newJwt);
    const oldRev = before.nats?.revocations ?? {};
    const revoked = Object.entries(after.nats?.revocations ?? {})
      .filter(([k, at]) => oldRev[k] === undefined || oldRev[k]! < at)
      .map(([k]) => k);
    const kept = keysOf(after);
    const dropped = [...keysOf(before)].filter((k) => !kept.has(k));

    const sessions = new Map<string, Credential>();
    const add = (rows: { username: string; claims: Credential | string }[]) => {
      for (const r of rows) sessions.set(r.username, typeof r.claims === "string" ? (JSON.parse(r.claims) as Credential) : r.claims);
    };
    if (revoked.includes("*")) {
      add((await this.sql.query<{ username: string; claims: Credential | string }>("select username, claims from ams_broker_sessions")).rows);
    } else {
      for (const k of revoked) {
        add((await this.sql.query<{ username: string; claims: Credential | string }>("select username, claims from ams_broker_sessions where username like $1", [`${k}:%`])).rows);
      }
    }
    for (const k of dropped) {
      add((await this.sql.query<{ username: string; claims: Credential | string }>("select username, claims from ams_broker_sessions where claims->>'iss' = $1", [k])).rows);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [user, cred] of sessions) {
      const why = accountRefuses({ id: accountId, jwt: newJwt }, cred, nowSec);
      if (why) await this.mgmt.closeConnectionsOf(user, `credential ${why}`);
    }
  }

  async stillConnected(_accountId: string, keys: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const k of keys) {
      const r = await this.sql.query<{ username: string }>("select username from ams_broker_sessions where username like $1", [`${k}:%`]);
      for (const { username } of r.rows) {
        if ((await this.mgmt.connectionsOf(username)).length) {
          found.push(k);
          break;
        }
      }
    }
    return found;
  }

  async close(): Promise<void> {
    if (this.ownSql) await this.sql.close();
  }
}

/** The operator's keys, from its JWT: the identity and its signing keys. */
export function operatorKeysOf(operatorJwt: string): string[] {
  const c = decodeJwt<Record<string, unknown>>(operatorJwt) as unknown as { sub?: string; nats?: { signing_keys?: (string | { key?: string })[] } };
  const keys = (c.nats?.signing_keys ?? []).map((e) => (typeof e === "string" ? e : e?.key)).filter(Boolean) as string[];
  return [c.sub, ...keys].filter(Boolean) as string[];
}

/** Put the account JWT first-run made into the database, when none is there. */
export async function seedAccount(sql: Sql, accountId: string, jwt: string): Promise<boolean> {
  const r = await sql.query("insert into ams_account (account, jwt) values ($1, $2) on conflict do nothing", [accountId, jwt]);
  return r.rowCount > 0;
}
