/**
 * Break glass: the operator's three mesh commands (docs/console-retirement-plan.md,
 * Preconditions, item 1).
 *
 *   agentmesh mesh health                  [--env prod|dev]
 *   agentmesh mesh pause  --reason "<why>" [--env prod|dev] [--yes]
 *   agentmesh mesh resume --reason "<why>" [--env prod|dev] [--yes]
 *
 * For the day the app or the API is what is broken. They talk to the mesh
 * directly over NATS, never through the API, so they work with the API
 * stopped. They are usable only by someone whose own gcloud sign-in can read
 * the operator secrets of the chosen environment from Secret Manager, by
 * exact name; nothing is cached on disk and no value is ever printed.
 *
 * The pause is the platform's own mesh-wide stop, not a second one:
 *
 *   - the stop is written to the stop list (`mesh_stops`), the same record the
 *     API's kill switch writes (server/src/api/stop-store.ts), so every mint
 *     door refuses, and the app's Kill switch page and its History, and the
 *     Console, show it;
 *   - the customer signing key is taken out of the account JWT and pushed
 *     through the SYSTEM account (server/src/api/split-keys.ts), which closes
 *     every customer connection and refuses it at the door, while the
 *     platform's own connections stay up;
 *   - each covered agent's status is written to `mesh_agent_status`, which the
 *     registry, the rooms service and the inbox read (server/src/shared/
 *     agent-status.ts).
 *
 * The resume lifts that record (any operator mesh pause, whether the Console
 * or this command placed it), puts the key back, and clears the statuses the
 * pause wrote. Every run says who ran it (the gcloud account), when and why,
 * in the stop record itself, which is what the platform's history reads.
 *
 * What it cannot do without the API: the API's own follow-ups (the notices,
 * stopping the agents the API process runs, the recorder's Postgres event).
 * When the API starts it reads the stop list, so the agents it runs stay
 * stopped while the pause is in force.
 */
import { createInterface } from "node:readline";
import { execFileSync, execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AM_ENVS } from "./am-envs.generated.mjs";

/** The secrets each command reads, by exact name, in the environment's own
 *  Secret Manager project. */
export const SECRETS = {
  /** The operator automation key: the gate. Whoever cannot read it is not an
   *  operator of this mesh, and nothing else is fetched. */
  key: "agentmesh-operator-key",
  /** A platform NATS user in the application account: the stop list, the
   *  status store, the account and organization records, the registry. */
  services: "agentmesh-services-creds",
  /** The SYSTEM account user: the broker's own state, the account JWT. */
  sys: "agentmesh-sys-revoker-creds",
  /** The operator signing seed: re-signs the account JWT. pause and resume only. */
  signing: "agentmesh-operator-signing-seed",
};

const VERBS = ["health", "pause", "resume"];
const ACCOUNT_KEY = /^A[A-Z2-7]{55}$/;
const NO_REASON = "No reason given.";

export const USAGE = `agentmesh mesh health                  [--env prod|dev]
agentmesh mesh pause  --reason "<why>" [--env prod|dev] [--yes]
agentmesh mesh resume --reason "<why>" [--env prod|dev] [--yes]`;

/**
 * The command line, checked before anything is fetched or dialled.
 * Returns { ok: true, verb, env, reason, yes } or { ok: false, error }.
 */
export function parseMeshArgs(rest, opts = {}) {
  const verb = rest[0];
  if (!verb) return { ok: false, error: `say which: health, pause or resume.\n${USAGE}` };
  if (!VERBS.includes(verb)) return { ok: false, error: `"${verb}" is not a mesh command; it is health, pause or resume.\n${USAGE}` };
  if (rest.length > 1) return { ok: false, error: `unexpected "${rest.slice(1).join(" ")}". Put the reason after --reason, in quotes.\n${USAGE}` };
  const env = opts.env === undefined ? "prod" : opts.env;
  if (env !== "prod" && env !== "dev") return { ok: false, error: `--env must be prod or dev, not "${env ?? ""}".` };
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  if (verb !== "health") {
    if (opts.reason === undefined || opts.reason === true) return { ok: false, error: `${verb} needs --reason "<why>". The reason is recorded with the stop.` };
    if (!reason) return { ok: false, error: `--reason is empty. Say why; it is recorded with the stop.` };
    if (reason.length > 500) return { ok: false, error: "--reason is longer than 500 characters." };
  } else if (opts.reason !== undefined) {
    return { ok: false, error: "health takes no --reason; it changes nothing." };
  }
  if (verb === "health" && opts.yes) return { ok: false, error: "health takes no --yes; it changes nothing." };
  return { ok: true, verb, env, reason, yes: opts.yes === true };
}

/** The flags this command adds to the adapter's own. Pulled out of argv
 *  before the adapter's parser sees them, so they mean nothing elsewhere. */
export function takeMeshFlags(argv) {
  const out = { rest: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") out.opts.env = argv[++i] ?? null;
    else if (a.startsWith("--env=")) out.opts.env = a.slice(6);
    else if (a === "--reason") out.opts.reason = argv[i + 1] === undefined ? true : argv[++i];
    else if (a.startsWith("--reason=")) out.opts.reason = a.slice(9);
    else if (a === "--yes") out.opts.yes = true;
    else if (a.startsWith("--")) { out.opts.unknown = a; }
    else out.rest.push(a);
  }
  return out;
}

// ─── Ownership, the same resolution the API makes ─────────────────────────
// server/src/api/kill-switch-world.ts ownershipWorld, account-closure.ts
// agentsOf and agent-category.ts categoryOf, reduced to what the mesh scope
// needs: every agent except the Mesh System Agents.

function agentsOf(account) {
  if (Array.isArray(account.agents) && account.agents.length) return account.agents;
  if (account.ownerKey) return [{ key: account.ownerKey, label: "linked agent" }];
  return [];
}

/** Every agent the mesh knows, organizations first, then accounts not moved
 *  into one, each once. */
export function ownershipWorld(orgs, accounts) {
  const seen = new Set();
  const out = [];
  for (const o of orgs) {
    for (const e of o.agents ?? []) {
      if (!e?.key || seen.has(e.key)) continue;
      seen.add(e.key);
      out.push({ key: e.key, person: o.homeFor ?? null, org: o.id ?? null, category: e.category ?? null, label: e.label ?? null });
    }
  }
  for (const a of accounts) {
    for (const e of agentsOf(a)) {
      if (!e?.key || seen.has(e.key)) continue;
      seen.add(e.key);
      out.push({ key: e.key, person: a.id ?? null, org: a.homeOrgId ?? null, category: e.category ?? null, label: e.label ?? null });
    }
  }
  return out;
}

/** The agents a mesh pause covers: all but the Mesh System Agents. */
export function meshCovered(world) {
  return world.filter((a) => a.category !== "mesh-system");
}

/** Does this stop cover this agent (server/src/api/kill-switch.ts covers). */
export function covers(stop, own) {
  if (stop.scope === "agent") return stop.target === own.key;
  if (stop.scope === "person") return !!own.person && stop.target === own.person;
  if (stop.scope === "org") return !!own.org && stop.target === own.org;
  if (stop.scope === "mesh") return own.category !== "mesh-system";
  return false;
}

/** The stop that decides for an agent among the active ones: a terminate
 *  first, else the oldest pause. Null when none covers it. */
export function decidingStop(active, own) {
  const hits = active.filter((s) => !s.lifted && covers(s, own));
  if (!hits.length) return null;
  return hits.find((s) => s.action === "terminate") ?? [...hits].sort((a, b) => a.at.localeCompare(b.at))[0];
}

/** The stop record a break-glass pause writes: the API's shape, pressed on
 *  the operator's authority by the gcloud account that ran it. */
export function meshStopRecord({ who, why, count, now = Date.now(), id = `stp_${randomUUID()}` }) {
  return {
    id,
    scope: "mesh",
    target: "mesh",
    target_label: "the whole mesh",
    action: "pause",
    by: { authority: "operator", account: who },
    why: (why || NO_REASON).slice(0, 500),
    at: new Date(now).toISOString(),
    count,
    via: "agentmesh mesh pause",
  };
}

// ─── The account JWT (split-keys.ts, without its dependency) ───────────────

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function decodeJwt(jwt) {
  const parts = String(jwt).trim().split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  return JSON.parse(fromB64url(parts[1]).toString("utf8"));
}

const keyOf = (e) => (typeof e === "string" ? e : e?.key);

/** Whether the account JWT lists this signing key. */
export function listsSigningKey(accountJwt, key) {
  return (decodeJwt(accountJwt)?.nats?.signing_keys ?? []).some((e) => keyOf(e) === key);
}

/** Encode claims as a v2 NATS JWT signed by `kp` (an nkeys key pair), the
 *  way nats-jwt's encode does: iss, iat and jti set here. */
export function encodeJwt(claims, kp, nowSec = Math.floor(Date.now() / 1000)) {
  const c = { ...claims, iss: kp.getPublicKey(), iat: nowSec };
  c.nats = { ...c.nats, version: 2 };
  delete c.jti;
  c.jti = createHash("sha512").update(JSON.stringify(c)).digest("base64");
  const head = b64url(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" }));
  const body = b64url(JSON.stringify(c));
  const sig = b64url(kp.sign(new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${sig}`;
}

/** The account claims with `key` taken out (present=false) or put back
 *  (present=true), revocations and everything else carried over. Null when
 *  there is nothing to change. */
export function withSigningKeyClaims(accountJwt, key, present, expectAccount) {
  const claims = decodeJwt(accountJwt);
  if (claims?.nats?.type !== "account") throw new Error("the broker answered with something that is not an account JWT");
  if (expectAccount && claims.sub !== expectAccount) throw new Error("the broker answered for a different account");
  const keys = [...(claims.nats.signing_keys ?? [])];
  const has = keys.some((e) => keyOf(e) === key);
  if (has === present) return null;
  const next = { ...claims, nats: { ...claims.nats, signing_keys: present ? [...keys, key] : keys.filter((e) => keyOf(e) !== key) } };
  delete next.jti;
  delete next.iat;
  delete next.iss;
  return next;
}

// ─── Talking to the outside: gcloud and the broker ─────────────────────────

/** The gcloud program: AGENTMESH_GCLOUD when set (read by exact name), else
 *  `gcloud` on the PATH. */
function gcloudProgram(env = process.env) {
  return env.AGENTMESH_GCLOUD?.trim() || "gcloud";
}

function gcloud(args, env = process.env) {
  const prog = gcloudProgram(env);
  const o = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 20 };
  // A .cmd on Windows runs only through the shell, so it gets one command
  // line. The arguments are this file's own constants and the generated
  // project names, never user input; each is checked to be a plain word.
  const out = process.platform === "win32"
    ? execSync([`"${prog}"`, ...args.map((a) => { if (!/^[\w.=@-]+$/.test(a)) throw new Error("unexpected gcloud argument"); return a; })].join(" "), o)
    : execFileSync(prog, args, o);
  // A Windows pipe can turn \n into \r\n, and a creds file read that way is
  // refused by the broker. Values carry no trailing bytes either.
  return out.replace(/\r\n/g, "\n");
}

export const realDeps = {
  /** The gcloud account that is signed in: who ran this. */
  whoAmI() {
    const v = gcloud(["config", "get-value", "account"]).trim();
    return v && v !== "(unset)" ? v : null;
  },
  /** One secret's latest version, by exact name. Throws on any failure. */
  readSecret(name, project) {
    return gcloud(["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${project}`]);
  },
  async connect({ servers, creds, name }) {
    const { connect, credsAuthenticator } = await import("nats.ws");
    return connect({ servers, name, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0, timeout: 8000 });
  },
  async nkeys() {
    return (await import("nats.ws")).nkeys;
  },
  async fetchHealth(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const t = await r.text();
    let b = null;
    try { b = JSON.parse(t); } catch { /* not JSON */ }
    return { status: r.status, body: b };
  },
  async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await new Promise((resolve) => {
        rl.question(question, (a) => resolve(a));
        rl.on("close", () => resolve(null));
      });
    } finally {
      rl.close();
      // A piped answer is not echoed, so end the prompt's line here.
      if (!process.stdin.isTTY) process.stdout.write("\n");
    }
  },
  saveJwt(envName, account, jwt, why) {
    try {
      const dir = join(homedir(), ".agentmesh", "operator", envName, "account-jwt");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${account}.${new Date().toISOString().replace(/[:.]/g, "-")}.${why}.jwt`);
      writeFileSync(file, jwt, { mode: 0o600 });
      return file;
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const te = new TextEncoder();
const td = new TextDecoder();

async function sysRequest(nc, subject, body, timeout = 5000) {
  const m = await nc.request(subject, body === undefined ? new Uint8Array(0) : te.encode(typeof body === "string" ? body : JSON.stringify(body)), { timeout });
  return td.decode(m.data);
}

async function lookupAccount(sys, account) {
  const text = (await sysRequest(sys, `$SYS.REQ.ACCOUNT.${account}.CLAIMS.LOOKUP`)).trim();
  if (!text.includes(".")) throw new Error("the broker gave no account JWT back (is it on the full resolver?)");
  return text;
}

async function pushAccount(sys, jwt) {
  const text = await sysRequest(sys, "$SYS.REQ.CLAIMS.UPDATE", jwt);
  let body = {};
  try { body = JSON.parse(text); } catch { /* unreadable is a refusal */ }
  if (body.error || !body.data) throw new Error(`the broker refused the account update: ${body.error?.description ?? "no readable answer"}`);
}

/** Every connection in the account, reduced to its name and the key that
 *  signed its credential. */
async function accountConnections(sys, account) {
  const out = [];
  for (let offset = 0; offset < 100_000;) {
    const body = JSON.parse(await sysRequest(sys, "$SYS.REQ.SERVER.PING.CONNZ", { acc: account, auth: true, offset, limit: 1024 }));
    const conns = body.data?.connections ?? [];
    for (const c of conns) {
      let issuer = c.issuer_key ?? null;
      if (!issuer && typeof c.jwt === "string") { try { issuer = decodeJwt(c.jwt).iss ?? null; } catch { /* unreadable */ } }
      out.push({ name: c.name ?? "", issuer });
    }
    offset += conns.length;
    if (!conns.length || offset >= (body.data?.total ?? 0)) break;
  }
  return out;
}

/** A KV bucket read whole, off its backing stream's subject list, the way
 *  server/src/shared/kv.ts snapshotKvBucket does it (a key iterator can
 *  come back short, and a short list of stops reads as "not stopped").
 *  Throws when the list cannot be read completely. */
async function snapshotBucket(js, jsm, bucket, { create = false } = {}) {
  const kv = await js.views.kv(bucket, create ? { history: 1 } : { bindOnly: true });
  const prefix = `$KV.${bucket}.`;
  const info = await jsm.streams.info(`KV_${bucket}`, { subjects_filter: `${prefix}>` });
  const subjects = Object.keys(info.state.subjects ?? {});
  if (!subjects.length && (info.state.messages ?? 0) > 0) throw new Error(`the bucket ${bucket} holds messages but listed no keys; refusing to read it as empty`);
  const entries = new Map();
  for (const s of subjects) {
    const key = s.slice(prefix.length);
    const e = await kv.get(key);
    if (e && e.operation === "PUT" && e.value.length) {
      try { entries.set(key, JSON.parse(td.decode(e.value))); } catch { /* an unreadable record is skipped */ }
    }
  }
  return { kv, entries };
}

// ─── The command ───────────────────────────────────────────────────────────

class Refusal extends Error {}

/**
 * Run one mesh command. Returns the process exit code: 0 done, 1 it ran and
 * something failed, 2 refused before anything was changed.
 */
export async function runMesh(argv, deps = realDeps) {
  const { rest, opts } = takeMeshFlags(argv);
  if (opts.unknown) { deps.err(`agentmesh mesh: unknown flag ${opts.unknown}\n${USAGE}`); return 2; }
  const p = parseMeshArgs(rest, opts);
  if (!p.ok) { deps.err(`agentmesh mesh: ${p.error}`); return 2; }
  const env = AM_ENVS[p.env];
  if (!env || !ACCOUNT_KEY.test(env.account) || !ACCOUNT_KEY.test(env.customer_signing_key)) {
    deps.err(`agentmesh mesh: this build has no usable settings for the ${p.env} mesh.`);
    return 2;
  }
  const line = (label, text) => deps.out(`${label.padEnd(10)}${text}`);
  line("mesh", `${env.mesh} (the ${p.env} mesh; secrets in project ${env.secrets_project})`);

  // Who is running this, from their own gcloud sign-in.
  let who;
  try { who = deps.whoAmI(); } catch { who = null; }
  if (!who) { deps.err("REFUSED   no gcloud account is signed in (gcloud auth login), so this run cannot be recorded. Nothing was done."); return 2; }
  line("operator", who);

  // The operator key first, by exact name: no key, nothing else is fetched.
  const read = (name) => {
    try {
      const v = deps.readSecret(name, env.secrets_project);
      if (typeof v !== "string" || !v.trim()) throw new Error("empty");
      return v;
    } catch {
      throw new Refusal(`REFUSED   the secret ${name} in ${env.secrets_project} could not be read with ${who}'s sign-in. These commands need the operator key. Nothing was done.`);
    }
  };
  let secrets;
  try {
    read(SECRETS.key);
    secrets = { services: read(SECRETS.services), sys: read(SECRETS.sys) };
    if (p.verb !== "health") secrets.signing = read(SECRETS.signing).trim();
  } catch (e) {
    if (e instanceof Refusal) { deps.err(e.message); return 2; }
    throw e;
  }
  if (secrets.signing && !secrets.signing.startsWith("SO")) {
    deps.err(`REFUSED   ${SECRETS.signing} does not hold an operator signing seed. Nothing was done.`);
    return 2;
  }

  let nc = null;
  let sys = null;
  try {
    try {
      sys = await deps.connect({ servers: env.broker_wss, creds: secrets.sys, name: "agentmesh-break-glass-sys" });
      nc = await deps.connect({ servers: env.broker_wss, creds: secrets.services, name: "agentmesh-break-glass" });
    } catch (e) {
      deps.err(`NOT OK    could not reach the broker at ${env.broker_wss}: ${e?.message ?? e}. ${p.verb === "health" ? "" : "Nothing was done."}`);
      return p.verb === "health" ? 1 : 2;
    }
    const js = nc.jetstream();
    const jsm = await nc.jetstreamManager();
    if (p.verb === "health") return await health({ deps, env, p, nc, sys, js, jsm, line });
    return await change({ deps, env, p, who, secrets, nc, sys, js, jsm, line });
  } finally {
    await nc?.close().catch(() => undefined);
    await sys?.close().catch(() => undefined);
  }
}

function ago(iso, now) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function uptimeWords(up) {
  return typeof up === "string" ? up : "unknown";
}

async function health({ deps, env, nc, sys, jsm, line }) {
  let bad = 0;
  // The broker.
  try {
    const v = JSON.parse(await sysRequest(sys, "$SYS.REQ.SERVER.PING.VARZ", {})).data ?? {};
    line("broker", `up: nats-server ${v.version ?? "?"} (${v.server_name ?? "?"}), up ${uptimeWords(v.uptime)}, ${v.connections ?? "?"} connections${v.jetstream?.config ? ", JetStream on" : ", JetStream OFF"}`);
  } catch (e) {
    bad++;
    line("broker", `NOT OK: no answer from the broker's own status (${e?.message ?? e})`);
  }
  // The account: is the customer signing key in it (the mesh pause takes it out)?
  let keyIn = null;
  try {
    keyIn = listsSigningKey(await lookupAccount(sys, env.account), env.customer_signing_key);
    line("account", keyIn ? "the customer signing key is in the account: customer agents may connect" : "the customer signing key is OUT of the account: customer agents are refused at the broker (paused)");
  } catch (e) {
    bad++;
    line("account", `NOT OK: the account JWT could not be read (${e?.message ?? e})`);
  }
  // The stop list.
  try {
    const js = nc.jetstream();
    const { entries } = await snapshotBucket(js, jsm, "mesh_stops", { create: true });
    const active = [...entries.values()].filter((s) => s && !s.lifted);
    const mesh = active.filter((s) => s.scope === "mesh");
    const now = deps.now();
    if (mesh.length) {
      for (const s of mesh) line("stops", `MESH PAUSED since ${s.at} (${ago(s.at, now)}) by ${s.by?.account ?? s.by?.authority}: "${s.why}" [${s.id}]`);
    } else {
      line("stops", "no mesh pause in force");
    }
    const others = active.length - mesh.length;
    line("", `${others} other stop${others === 1 ? "" : "s"} in force (agents, people, organizations); ${entries.size} stops recorded in all`);
    if (keyIn === false && !mesh.length) line("", "WARNING: the key is out but no mesh pause is recorded. Run agentmesh mesh resume to put it back.");
    if (keyIn === true && mesh.length) line("", "WARNING: a mesh pause is recorded but the key is in the account. Run agentmesh mesh pause again to finish the cut.");
  } catch (e) {
    bad++;
    line("stops", `NOT OK: the stop list could not be read (${e?.message ?? e})`);
  }
  // The registry, which runs in the core process with the API.
  try {
    // `total` counts the subscriptions matching `test` only when the list is
    // asked for; num_matches is the broker's lifetime counter, not this.
    const sz = JSON.parse(await sysRequest(sys, "$SYS.REQ.SERVER.PING.SUBSZ", { test: "mesh.registry.get.health", subscriptions: true, limit: 50 })).data ?? {};
    const n = sz.total ?? 0;
    line("registry", n > 0 ? `listening (${n} subscriber${n === 1 ? "" : "s"} on mesh.registry.get.*)` : "NOT LISTENING: nothing subscribes to mesh.registry.get.* (the core process is down)");
    if (!(n > 0)) bad++;
  } catch (e) {
    bad++;
    line("registry", `NOT OK: could not ask the broker (${e?.message ?? e})`);
  }
  // The platform's service connections and the customer ones.
  try {
    const conns = await accountConnections(sys, env.account);
    const customer = conns.filter((c) => c.issuer === env.customer_signing_key).length;
    const platform = conns.filter((c) => c.issuer !== env.customer_signing_key);
    const byName = new Map();
    for (const c of platform) byName.set(c.name || "(unnamed)", (byName.get(c.name || "(unnamed)") ?? 0) + 1);
    const top = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(", ");
    line("services", `${platform.length} platform connection${platform.length === 1 ? "" : "s"}${top ? `: ${top}` : ""}`);
    line("agents", `${customer} customer connection${customer === 1 ? "" : "s"} (credentials signed by the customer key)`);
  } catch (e) {
    bad++;
    line("services", `NOT OK: the connection list could not be read (${e?.message ?? e})`);
  }
  // The core process's HTTP face. Read only, to report it; nothing here needs it.
  try {
    const h = await deps.fetchHealth(`${env.api}/health`);
    const ok = h.status === 200 && h.body?.ok === true;
    line("core", ok ? `the API answers ${env.api}/health ok` : `the API answers ${env.api}/health with ${h.status}${h.body?.ok === false ? " (not ok)" : ""}`);
    if (!ok) bad++;
  } catch (e) {
    bad++;
    line("core", `the API does not answer at ${env.api}/health (${e?.name === "TimeoutError" ? "no answer in 4 s" : e?.message ?? e})`);
  }
  line("", bad ? `${bad} check${bad === 1 ? "" : "s"} not ok.` : "every check ok.");
  return bad ? 1 : 0;
}

export async function confirm({ deps, env, p }) {
  if (p.yes) return true;
  const word = p.verb === "pause" ? "PAUSE every customer agent on" : "RESUME";
  const typed = await deps.ask(`Type the mesh name (${env.mesh}) to ${word} it: `);
  if ((typed ?? "").trim() !== env.mesh) {
    deps.err(`REFUSED   that was not "${env.mesh}". Nothing was done.`);
    return false;
  }
  return true;
}

async function setCustomerKey({ deps, env, sys, signing, present, envName }) {
  const nk = await deps.nkeys();
  const kp = nk.fromSeed(te.encode(signing));
  const live = await lookupAccount(sys, env.account);
  const claims = withSigningKeyClaims(live, env.customer_signing_key, present, env.account);
  if (!claims) return { changed: false, note: present ? "the customer signing key was already in the account" : "the customer signing key was already out of the account" };
  // The resolver keeps the newer JWT by issue time; make sure this one is.
  const prevIat = decodeJwt(live).iat ?? 0;
  let nowSec = Math.floor(deps.now() / 1000);
  if (nowSec <= prevIat) {
    await deps.sleep((prevIat - nowSec + 1) * 1000 + 50);
    nowSec = Math.floor(deps.now() / 1000);
  }
  const saved = deps.saveJwt(envName, env.account, live, present ? "before-resume" : "before-pause");
  await pushAccount(sys, encodeJwt(claims, kp, nowSec));
  return { changed: true, saved, note: present ? "the customer signing key is back in the account" : "the customer signing key was taken out of the account" };
}

async function change({ deps, env, p, who, secrets, nc, sys, js, jsm, line }) {
  const now = deps.now();
  // Read the facts before asking: what is stopped now, and what a pause covers.
  let stops;
  let world;
  try {
    stops = await snapshotBucket(js, jsm, "mesh_stops", { create: true });
    const orgs = await snapshotBucket(js, jsm, "mesh_orgs").catch(() => ({ entries: new Map() }));
    const accounts = await snapshotBucket(js, jsm, "mesh_accounts");
    world = ownershipWorld([...orgs.entries.values()], [...accounts.entries.values()]);
  } catch (e) {
    deps.err(`NOT OK    the stop list or the account records could not be read (${e?.message ?? e}). Nothing was done.`);
    return 2;
  }
  const active = [...stops.entries.values()].filter((s) => s && !s.lifted);
  const meshStops = active.filter((s) => s.scope === "mesh");
  const covered = meshCovered(world);
  let keyIn;
  try { keyIn = listsSigningKey(await lookupAccount(sys, env.account), env.customer_signing_key); } catch (e) {
    deps.err(`NOT OK    the account JWT could not be read from the broker (${e?.message ?? e}). Nothing was done.`);
    return 2;
  }
  if (p.verb === "pause") {
    line("now", meshStops.length ? `already paused since ${meshStops[0].at} by ${meshStops[0].by?.account ?? meshStops[0].by?.authority}` : `running; a pause covers ${covered.length} agent${covered.length === 1 ? "" : "s"} (the Mesh System Agents keep running)`);
    if (meshStops.length && !keyIn) { line("", "nothing to do: the pause is recorded and the key is out."); return 0; }
  } else {
    line("now", meshStops.length ? `paused since ${meshStops[0].at} by ${meshStops[0].by?.account ?? meshStops[0].by?.authority}: "${meshStops[0].why}"` : "no mesh pause is recorded");
    if (!meshStops.length && keyIn) { line("", "nothing to do: no mesh pause is recorded and the key is in the account."); return 0; }
  }
  line("reason", p.reason);
  if (!(await confirm({ deps, env, p }))) return 2;

  const kv = stops.kv;
  const status = await js.views.kv("mesh_agent_status", { history: 1 });
  let failed = 0;

  if (p.verb === "pause") {
    // 1. The record first: from here every mint door refuses.
    let rec = meshStops[0];
    if (!rec) {
      rec = meshStopRecord({ who, why: p.reason, count: covered.length, now });
      await kv.put(rec.id, JSON.stringify(rec));
      line("recorded", `stop ${rec.id}: mesh pause by ${who} at ${rec.at}`);
    } else {
      line("recorded", `the existing stop ${rec.id} stands; finishing its cut`);
    }
    // 2. The transport cut: the customer key out of the account.
    try {
      const r = await setCustomerKey({ deps, env, sys, signing: secrets.signing, present: false, envName: p.env });
      line("broker", `${r.note}${r.saved ? `; the account as it was is saved at ${r.saved}` : ""}`);
      rec.cut = r.changed ? "The customer signing key was taken out of the account (agentmesh mesh pause); every customer connection was closed and is refused until the mesh is resumed. The platform's own connections stay up." : (rec.cut ?? r.note);
    } catch (e) {
      failed++;
      line("broker", `NOT OK: the key could not be taken out (${e?.message ?? e}). The stop is recorded, so every mint door refuses; connections in hand stay up until this succeeds. Run it again.`);
      rec.cut = `The customer signing key could not be taken out: ${e?.message ?? e}`;
    }
    await kv.put(rec.id, JSON.stringify(rec)).catch(() => { failed++; });
    // 3. Each covered agent's status, for the registry, rooms and the inbox.
    let marked = 0;
    for (const a of covered) {
      try {
        const prior = await status.get(a.key);
        if (prior?.value?.length && JSON.parse(td.decode(prior.value)).status === "terminated") continue;
        await status.put(a.key, JSON.stringify({ status: "paused", since: rec.at, stop_id: rec.id, scope: "mesh" }));
        marked++;
      } catch { failed++; }
    }
    line("status", `${marked} agent${marked === 1 ? "" : "s"} marked paused for the registry and the inbox`);
  } else {
    // 1. The record: every mesh pause in force is lifted, by whoever placed it.
    const lifted = [];
    for (const rec of meshStops) {
      rec.lifted = { at: new Date(now).toISOString(), by: { authority: "operator", account: who }, why: p.reason.slice(0, 500), via: "agentmesh mesh resume" };
      try { await kv.put(rec.id, JSON.stringify(rec)); lifted.push(rec); line("recorded", `stop ${rec.id} lifted by ${who} at ${rec.lifted.at}`); } catch (e) { failed++; line("recorded", `NOT OK: stop ${rec.id} could not be lifted (${e?.message ?? e})`); }
    }
    // 2. The key back in.
    try {
      const r = await setCustomerKey({ deps, env, sys, signing: secrets.signing, present: true, envName: p.env });
      line("broker", `${r.note}${r.saved ? `; the account as it was is saved at ${r.saved}` : ""}`);
    } catch (e) {
      failed++;
      line("broker", `NOT OK: the key could not be put back (${e?.message ?? e}). Run it again, or use server/tools/break-glass-account.mjs on the broker host.`);
    }
    // 3. The statuses the pause wrote: cleared, or handed to another stop
    //    that still covers the agent.
    const ids = new Set(lifted.map((s) => s.id));
    const still = active.filter((s) => !ids.has(s.id));
    const where = new Map(world.map((a) => [a.key, a]));
    let cleared = 0;
    let kept = 0;
    try {
      const snap = await snapshotBucket(js, jsm, "mesh_agent_status");
      for (const [key, st] of snap.entries) {
        if (!ids.has(st?.stop_id) || st?.status === "terminated") continue;
        const own = where.get(key) ?? { key, person: null, org: null, category: null };
        const other = decidingStop(still, own);
        try {
          if (other) {
            await status.put(key, JSON.stringify({ status: other.action === "terminate" ? "terminated" : "paused", since: other.at, stop_id: other.id, scope: other.scope }));
            kept++;
          } else {
            await status.purge(key);
            cleared++;
          }
        } catch { failed++; }
      }
    } catch (e) {
      failed++;
      line("status", `NOT OK: the status list could not be read (${e?.message ?? e})`);
    }
    line("status", `${cleared} agent${cleared === 1 ? "" : "s"} running again; ${kept} still stopped by another stop`);
  }

  // Check what the broker says now.
  await deps.sleep(1500);
  try {
    const conns = await accountConnections(sys, env.account);
    const customer = conns.filter((c) => c.issuer === env.customer_signing_key).length;
    line("agents", p.verb === "pause"
      ? `${customer} customer connection${customer === 1 ? "" : "s"} still open${customer ? " (they close within seconds; run agentmesh mesh health)" : ""}`
      : `${customer} customer connection${customer === 1 ? "" : "s"} open so far; nodes reconnect on their own within a few minutes`);
  } catch { /* the check is a courtesy */ }
  line("history", `${env.app}/kill-switch (History) and the stop list show this run`);
  line("", failed ? `${failed} step${failed === 1 ? "" : "s"} failed; see above.` : p.verb === "pause" ? "the mesh is paused." : "the mesh is resumed.");
  return failed ? 1 : 0;
}
