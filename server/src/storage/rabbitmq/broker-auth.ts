/**
 * Who may connect to RabbitMQ, and what each connection may do (step 9 of
 * docs/agent-messaging-server-plan.md, "On RabbitMQ").
 *
 * RabbitMQ has no operator → account → user chain of its own, so the key chain
 * stays the root of trust. A node's credential on this binding is the same
 * signed claim the key chain mints for the reference binding (§18.2): a JWT
 * signed by one of the account's signing keys, naming the node's key (`sub`),
 * its publish and subscribe permissions and its expiry. RabbitMQ's HTTP
 * authentication backend (`rabbitmq_auth_backend_http`) asks this service
 * about every connection and every operation that needs a permission, and
 * this service answers from the credential:
 *
 *  - user: the user name is `<node key>:<the credential's jti>`, and the
 *    password is `<jwt>~<unix ms>~<signature>`, the signature being the node
 *    key's over `amqp-connect|<user name>|<unix ms>`. So a connection proves
 *    it holds the node's key, as a NATS connection does by signing the
 *    server's nonce, and a copied password stops working after five minutes.
 *    The credential must be signed by a signing key the account lists now,
 *    not be expired, and not be revoked (the account's `revocations`, as on
 *    NATS: every credential for that key issued at or before the instant).
 *  - vhost: only the mesh's own.
 *  - resource: the exchange `mesh` may be written and read (bound from), never
 *    configured; the default exchange may be written (answers to direct
 *    reply-to); a node may make and use server-named queues of its own, and
 *    read its hosted agents' mailbox queues and durable subscription queues.
 *  - topic: publishing on a routing key is allowed when the credential's
 *    `pub` allows the subject and does not deny it; binding a queue to a key
 *    is allowed when the credential's `sub` covers the whole pattern and no
 *    denied subject overlaps it (a pattern is all or nothing here, where NATS
 *    filters a wide subscription message by message).
 *
 * The account JWT, with its signing keys and revocations, is the binding's
 * resolver: a row in `ams_account`, written by the key chain's revocation and
 * the mesh pause (broker-admin.ts). What each connection may do is kept in
 * `ams_broker_sessions` by user name, because RabbitMQ asks about operations
 * with the user name alone.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { nkeys } from "nats";
import { decode as decodeJwt } from "nats-jwt";
import type { Sql } from "../postgres/sql.js";
import { patternCovers, patternOfBindingKey, patternsOverlap, subjectMatches } from "./subjects.js";
import { notices } from "../postgres/notices.js";

const te = new TextEncoder();

/** How far a connection's proof may be from now. */
export const PROOF_WINDOW_MS = 5 * 60_000;

export interface Permissions {
  allow?: string[];
  deny?: string[];
}

/** What a credential says, as far as the broker check reads it. */
export interface Credential {
  sub: string;
  iss: string;
  iat: number;
  exp?: number;
  jti: string;
  pub: Permissions;
  subPerms: Permissions;
  issuerAccount?: string;
}

type SigningKeyEntry = string | { key?: string };

interface AccountClaims {
  sub?: string;
  iat?: number;
  nats?: { signing_keys?: SigningKeyEntry[]; revocations?: Record<string, number> };
}

function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

/** Verify a JWT's signature by its issuer's key, and read its claims. Throws
 *  on anything that is not a JWT signed by the key it names. */
export function verifiedClaims<T = Record<string, unknown>>(jwt: string): T & { iss: string } {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const claims = decodeJwt<Record<string, unknown>>(jwt) as unknown as T & { iss?: string };
  const iss = claims.iss;
  if (typeof iss !== "string") throw new Error("the JWT names no issuer");
  const ok = nkeys.fromPublic(iss).verify(te.encode(`${parts[0]}.${parts[1]}`), b64urlDecode(parts[2]!));
  if (!ok) throw new Error("the JWT's signature does not verify");
  return claims as T & { iss: string };
}

export function credentialOf(jwt: string): Credential {
  const c = verifiedClaims<{
    sub?: string;
    iat?: number;
    exp?: number;
    jti?: string;
    nats?: { type?: string; pub?: Permissions; sub?: Permissions; issuer_account?: string };
  }>(jwt);
  if (c.nats?.type !== "user") throw new Error("the JWT is not a user credential");
  if (typeof c.sub !== "string" || typeof c.iat !== "number" || typeof c.jti !== "string") throw new Error("the credential lacks sub, iat or jti");
  return {
    sub: c.sub,
    iss: c.iss,
    iat: c.iat,
    exp: typeof c.exp === "number" ? c.exp : undefined,
    jti: c.jti,
    pub: c.nats.pub ?? {},
    subPerms: c.nats.sub ?? {},
    issuerAccount: c.nats.issuer_account,
  };
}

/** The user name a connection presents: the node key and which credential. */
export function amqpUserName(cred: Pick<Credential, "sub" | "jti">): string {
  return `${cred.sub}:${cred.jti}`;
}

/** The string the node key signs to connect. */
export function connectProofText(userName: string, atMs: number): string {
  return `amqp-connect|${userName}|${atMs}`;
}

/** Why an account (its JWT) refuses a credential, or null when it accepts it. */
export function accountRefuses(account: { id: string; jwt: string }, cred: Credential, nowSec: number): string | null {
  const a = decodeJwt<Record<string, unknown>>(account.jwt) as unknown as AccountClaims;
  const keys = (a.nats?.signing_keys ?? []).map((e) => (typeof e === "string" ? e : e?.key)).filter(Boolean) as string[];
  if (cred.iss !== account.id && !keys.includes(cred.iss)) return "signed by a key this account does not list";
  if (cred.iss !== account.id && cred.issuerAccount !== account.id) return "issued for another account";
  if (cred.exp !== undefined && cred.exp <= nowSec) return "expired";
  const rev = a.nats?.revocations ?? {};
  const at = rev[cred.sub] ?? rev["*"];
  if (at !== undefined && cred.iat <= at) return "revoked";
  return null;
}

/** Whether `subject` may be published under these permissions (NATS's rule:
 *  no allow list allows everything; deny wins). */
export function mayPublish(p: Permissions, subject: string): boolean {
  if (p.deny?.some((d) => subjectMatches(d, subject))) return false;
  if (!p.allow || p.allow.length === 0) return true;
  return p.allow.some((a) => subjectMatches(a, subject));
}

/** Whether a whole subscription pattern may be bound. */
export function maySubscribe(p: Permissions, pattern: string): boolean {
  if (p.deny?.some((d) => patternsOverlap(d, pattern))) return false;
  if (!p.allow || p.allow.length === 0) return true;
  return p.allow.some((a) => patternCovers(a, pattern));
}

/** The agent a queue belongs to, by the queue names the binding uses for an
 *  agent: its mailbox, its durable event subscriptions and its feed cursor. */
export function queueAgent(name: string): string | null {
  const m =
    /^MESH_INBOX_([A-Z2-7]{56})$/.exec(name) ??
    /^mesh_event_([A-Z2-7]{56})_[0-9a-f]{16}$/.exec(name) ??
    /^mesh_feed_([A-Z2-7]{56})$/.exec(name);
  return m ? m[1]! : null;
}

/** Whether the credential hosts the agent: its inbox is one of its subscriptions. */
function hosts(cred: Credential, agent: string): boolean {
  return maySubscribe(cred.subPerms, `mesh.agent.${agent}.inbox`) || maySubscribe(cred.subPerms, `mesh.agent.${agent}.inbox.guarded`);
}

/** The answer to one resource question. */
export function resourceAllowed(cred: Credential, resource: string, name: string, permission: string): boolean {
  if (resource === "exchange") {
    if (name === "mesh") return permission === "write" || permission === "read";
    if (name === "amq.default") return permission === "write";
    return false;
  }
  if (resource === "queue") {
    // Server-named queues: a subscription's own, exclusive to the connection.
    if (name.startsWith("amq.gen-")) return true;
    const agent = queueAgent(name);
    if (!agent || !hosts(cred, agent)) return false;
    // A mailbox is made by the registry; its node may only read it (and check it).
    if (name.startsWith("MESH_INBOX_")) return permission === "read" || permission === "configure";
    return true;
  }
  return false;
}

export interface BrokerAuthOptions {
  sql: Sql;
  /** The mesh's account (ROOMS_MINT_ISSUER_ACCOUNT). */
  accountId: string;
  /** The virtual host connections may use. */
  vhost: string;
  now?: () => number;
}

/** The account JWT, read from Postgres and kept until it changes. */
class AccountCache {
  private jwt: string | null = null;
  private listening = false;
  constructor(
    private readonly sql: Sql,
    private readonly id: string,
  ) {}
  async get(): Promise<string | null> {
    if (!this.listening) {
      this.listening = true;
      await notices(this.sql, "ams_account").on(this.id, () => {
        this.jwt = null;
      });
    }
    if (this.jwt) return this.jwt;
    const r = await this.sql.query<{ jwt: string }>("select jwt from ams_account where account = $1", [this.id]);
    this.jwt = r.rows[0]?.jwt ?? null;
    return this.jwt;
  }
}

export class BrokerAuth {
  private readonly account: AccountCache;
  private readonly sessions = new Map<string, Credential>();
  private readonly now: () => number;

  constructor(private readonly opts: BrokerAuthOptions) {
    this.account = new AccountCache(opts.sql, opts.accountId);
    this.now = opts.now ?? Date.now;
  }

  /** A connection: its user name and password. */
  async user(username: string, password: string): Promise<{ ok: boolean; why?: string }> {
    const [jwt, at, sig] = password.split("~");
    if (!jwt || !at || !sig) return { ok: false, why: "the password is not a credential with its proof" };
    let cred: Credential;
    try {
      cred = credentialOf(jwt);
    } catch (err) {
      return { ok: false, why: err instanceof Error ? err.message : String(err) };
    }
    if (username !== amqpUserName(cred)) return { ok: false, why: "the user name does not name this credential" };
    const atMs = Number(at);
    if (!Number.isFinite(atMs) || Math.abs(this.now() - atMs) > PROOF_WINDOW_MS) return { ok: false, why: "the proof is stale" };
    try {
      if (!nkeys.fromPublic(cred.sub).verify(te.encode(connectProofText(username, atMs)), b64urlDecode(sig))) {
        return { ok: false, why: "the proof is not signed by the credential's key" };
      }
    } catch {
      return { ok: false, why: "the proof cannot be read" };
    }
    const accountJwt = await this.account.get();
    if (!accountJwt) return { ok: false, why: "the mesh's account is not set up" };
    const refusal = accountRefuses({ id: this.opts.accountId, jwt: accountJwt }, cred, Math.floor(this.now() / 1000));
    if (refusal) return { ok: false, why: refusal };
    this.sessions.set(username, cred);
    await this.opts.sql.query(
      `insert into ams_broker_sessions (username, claims, iat) values ($1, $2, $3)
         on conflict (username) do update set claims = excluded.claims, iat = excluded.iat, updated = now()`,
      [username, JSON.stringify(cred), cred.iat],
    );
    return { ok: true };
  }

  /** The credential behind a user name that connected. */
  async session(username: string): Promise<Credential | null> {
    const s = this.sessions.get(username);
    if (s) return s;
    const r = await this.opts.sql.query<{ claims: Credential | string }>("select claims from ams_broker_sessions where username = $1", [username]);
    const c = r.rows[0]?.claims;
    if (!c) return null;
    const cred = typeof c === "string" ? (JSON.parse(c) as Credential) : c;
    this.sessions.set(username, cred);
    return cred;
  }

  async vhost(username: string, vhost: string): Promise<boolean> {
    return vhost === this.opts.vhost && (await this.session(username)) !== null;
  }

  async resource(username: string, vhost: string, resource: string, name: string, permission: string): Promise<boolean> {
    if (vhost !== this.opts.vhost) return false;
    const cred = await this.session(username);
    return cred !== null && resourceAllowed(cred, resource, name, permission);
  }

  async topic(username: string, vhost: string, exchange: string, permission: string, routingKey: string): Promise<boolean> {
    if (vhost !== this.opts.vhost || exchange !== "mesh") return false;
    const cred = await this.session(username);
    if (!cred) return false;
    if (permission === "write") return mayPublish(cred.pub, routingKey);
    if (permission === "read") return maySubscribe(cred.subPerms, patternOfBindingKey(routingKey));
    return false;
  }
}

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
      if (body.length > 64 * 1024) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      resolve(new URLSearchParams(body || url.search));
    });
    req.on("error", reject);
  });
}

/**
 * The HTTP side RabbitMQ calls (`auth_http.user_path` and the rest point at
 * `/broker-auth/user`, `/vhost`, `/resource` and `/topic`). It answers
 * `allow` or `deny` in plain text. It listens on its own address
 * (MESH_BROKER_AUTH_HOST and _PORT, loopback by default), which nothing but
 * the broker should reach.
 */
export function brokerAuthServer(auth: BrokerAuth, log: (line: string) => void = (l) => console.log(l)): Server {
  return createServer((req, res) => {
    void (async () => {
      let allow = false;
      try {
        const f = await readForm(req);
        const u = f.get("username") ?? "";
        const path = (req.url ?? "").split("?")[0];
        if (path === "/broker-auth/user") {
          const r = await auth.user(u, f.get("password") ?? "");
          allow = r.ok;
          if (!r.ok) log(`[broker-auth] refused ${u.slice(0, 12)}…: ${r.why}`); // cut-ok: a key's first characters in a log line
        } else if (path === "/broker-auth/vhost") {
          allow = await auth.vhost(u, f.get("vhost") ?? "");
        } else if (path === "/broker-auth/resource") {
          allow = await auth.resource(u, f.get("vhost") ?? "", f.get("resource") ?? "", f.get("name") ?? "", f.get("permission") ?? "");
        } else if (path === "/broker-auth/topic") {
          allow = await auth.topic(u, f.get("vhost") ?? "", f.get("name") ?? "", f.get("permission") ?? "", f.get("routing_key") ?? "");
        } else {
          res.writeHead(404).end();
          return;
        }
      } catch (err) {
        log(`[broker-auth] could not answer: ${err instanceof Error ? err.message : err}`);
        allow = false;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end(allow ? "allow" : "deny");
    })();
  });
}
