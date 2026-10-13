#!/usr/bin/env node
// mesh-admin: the command line for the admin API of an Agent Messaging Server.
//
// It manages the mesh's key chain and tenants (step 6 of
// docs/agent-messaging-server-plan.md): tenants and their limits, agents and
// who owns them, credentials and the kill switch's network cut, admission
// policy, and the audit log. It manages agents, not people. Headless: plain
// node 22, no packages, and every command talks to the admin API over HTTP
// (server/src/admin/admin-api.ts).
//
// It never prints a secret. An admin token, an enrollment key and a creds
// file are written to the file named by --out, with mode 600.

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HELP = `mesh-admin: run the key chain and tenants of an Agent Messaging Server

Usage: mesh-admin <command> [arguments] [options]

The mesh
  status                                   what this mesh is and what it holds
  token new --out FILE [--name NAME]       add a new admin token to FILE (the mesh's
                                           MESH_ADMIN_TOKEN_FILE); the token is not shown

Tenants
  tenants list
  tenants show TENANT
  tenants create [TENANT] [--home-org ORG] [--owner-key KEY]
  tenants disable TENANT                   its agents get no new credential
  tenants enable TENANT
  tenants delete TENANT                    only when it owns no agent
  tenants limits TENANT [--max-agents N] [--max-rooms N] [--max-drive-mb N]
                        [--requests-per-minute N] [--clear NAME]
                                           with no option, shows the limits
  tenants key TENANT --label LABEL [--name NAME] [--out FILE]
                                           a one-time enrollment key: the agent runs
                                           agentmesh up <key>. Printed unless --out.
  tenants trust list [TENANT]              the identity systems a tenant trusts (all
                                           tenants' with no TENANT)
  tenants trust add TENANT --oauth ISSUER --audience AUD [--require-binding]
                           [--jwks-uri URL] [--id ID]
                                           trust an OAuth issuer: its agents enroll with
                                           a token whose aud is AUD (--require-binding:
                                           only DPoP- or certificate-bound tokens)
  tenants trust add TENANT --spiffe TRUST_DOMAIN (--bundle FILE | --bundle-endpoint URL)
                           [--require-mtls] [--audience AUD] [--id ID]
                                           trust a SPIFFE trust domain: its agents enroll
                                           with a JWT-SVID, or an X.509-SVID over mTLS
  tenants trust remove TENANT ID           new enrollments and renewals through it stop

Agents
  agents list [--tenant TENANT]
  agents show AGENT
  agents enroll AGENT --tenant TENANT [--label LABEL] [--unlisted]
                                           record whose agent it is, and lift a revoke
                                           this tool placed on it
  agents set AGENT [--tenant TENANT] [--label LABEL] [--listed | --unlisted]
  agents remove AGENT [--reason TEXT]      revoke its credentials, deregister it, and
                                           drop its record
  agents identity AGENT                    where its identity came from: this mesh's
                                           enrollment, an OAuth issuer, a SPIFFE trust
                                           domain, or a bridge
  agents admission AGENT [--registered STANCE] [--anonymous STANCE]
                         [--allow KEY]... [--hold KEY]... [--block KEY]...
                         [--per-sender-per-hour N]
                                           STANCE is allow, hold or block. With no
                                           option, shows the policy.

Credentials
  credentials list [--agent AGENT] [--tenant TENANT]
  credentials mint --agent AGENT [--agent AGENT]... --out FILE [--label LABEL]
                                           a node credential on a fresh key, written
                                           to FILE as a creds file
  credentials revoke (--agent AGENT | --tenant TENANT | --key KEY) [--reason TEXT]
                                           the kill switch: an agent's or a tenant's
                                           connections are cut at once and get no new
                                           credential until restored. --key cuts one
                                           credential only.
  credentials restore (--agent AGENT | --tenant TENANT)
  agent-keys revoke AGENT --reason TEXT    a leaked signing key; there is no undo

Audit
  audit (--agent AGENT | --tenant TENANT) [--limit N] [--verify]

Options for every command
  --url URL            the mesh's admin API (default: MESH_ADMIN_URL, else
                       http://127.0.0.1:3005)
  --token-file FILE    where the admin token is (default: MESH_ADMIN_TOKEN_FILE).
                       MESH_ADMIN_TOKEN, when set, is used instead.
  --token-name NAME    which token in the file to use (default: the first)
  --json               print the admin API's answer as JSON
  -h, --help           this text
`;

// ── Arguments ──────────────────────────────────────────────────────────

const FLAGS_WITH_VALUE = new Set([
  "url", "token-file", "token-name", "out", "name", "home-org", "owner-key", "max-agents", "max-rooms", "max-drive-mb",
  "requests-per-minute", "clear", "label", "tenant", "reason", "registered", "anonymous", "allow", "hold", "block",
  "per-sender-per-hour", "agent", "key", "limit", "oauth", "audience", "jwks-uri", "id", "spiffe", "bundle", "bundle-endpoint",
]);
const REPEATABLE = new Set(["agent", "allow", "hold", "block", "clear"]);

export function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { opt.help = true; continue; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf("=");
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    if (FLAGS_WITH_VALUE.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value.`);
      }
      if (REPEATABLE.has(name)) (opt[name] ??= []).push(value);
      else opt[name] = value;
    } else {
      if (value !== undefined) throw new UsageError(`--${name} takes no value.`);
      opt[name] = true;
    }
  }
  return { pos, opt };
}

export class UsageError extends Error {}

function wholeNumber(v, name) {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(String(v))) throw new UsageError(`--${name} must be a whole number.`);
  return Number(v);
}

// ── The token and the address ──────────────────────────────────────────

export function readToken(env, opt) {
  if (env.MESH_ADMIN_TOKEN?.trim()) return env.MESH_ADMIN_TOKEN.trim();
  const file = opt["token-file"] ?? env.MESH_ADMIN_TOKEN_FILE;
  if (!file) throw new UsageError("No admin token: set MESH_ADMIN_TOKEN_FILE, or pass --token-file.");
  let text;
  try { text = readFileSync(file, "utf8"); } catch { throw new UsageError(`The admin token file ${file} cannot be read.`); }
  const want = opt["token-name"];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const secret = parts[parts.length - 1];
    const name = parts.length > 1 ? parts.slice(0, -1).join(" ") : null;
    if (!want || name === want) return secret;
  }
  throw new UsageError(want ? `There is no token named ${want} in ${file}.` : `The admin token file ${file} holds no token.`);
}

function baseUrl(env, opt) {
  return String(opt.url ?? env.MESH_ADMIN_URL ?? "http://127.0.0.1:3005").replace(/\/+$/, "");
}

/** Write a secret to a file only its owner can read. */
function writePrivate(file, text, append = false) {
  if (append && existsSync(file)) appendFileSync(file, text, { mode: 0o600 });
  else writeFileSync(file, text, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not every file system has modes */ }
}

// ── Talking to the admin API ───────────────────────────────────────────

export async function call(ctx, method, path, body) {
  const res = await ctx.fetch(`${ctx.url}/admin/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${ctx.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch((err) => {
    throw new UsageError(`Could not reach the admin API at ${ctx.url}: ${err.cause?.code ?? err.message}.`);
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 300) }; } // cut-ok: a non-JSON error page, shown as the error
  if (!res.ok) {
    const err = new Error(json.error ?? `The admin API answered ${res.status}.`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const q = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return s.toString() ? `?${s}` : "";
};
const enc = encodeURIComponent;
const short = (k) => (typeof k === "string" && k.length > 20 ? `${k.slice(0, 12)}…` : String(k ?? "")); // cut-ok: a key's first characters for a table; --json prints it whole

// ── The commands ───────────────────────────────────────────────────────

function need(v, what) {
  if (!v) throw new UsageError(`Say ${what}.`);
  return v;
}

function table(rows, cols) {
  if (!rows.length) return "(none)";
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}

function trustTable(list) {
  return table(list.map((t) => ({
    id: t.id,
    kind: t.kind,
    trusts: t.kind === "oauth" ? t.issuer : t.trust_domain,
    audience: t.audience ?? "",
    binding: t.kind === "oauth" ? (t.require_binding ? "required" : "") : (t.require_mtls ? "mTLS only" : ""),
    keys: t.kind === "oauth" ? (t.jwks_uri ?? "from metadata") : (t.bundle_endpoint ?? `${t.bundle_keys ?? 0} keys inline`),
  })), ["id", "kind", "trusts", "audience", "binding", "keys"]);
}

function said(out) {
  return [out.note, out.what_now].filter(Boolean).join("\n");
}

export async function run(argv, { env = process.env, fetch: fetchImpl = globalThis.fetch, print = (s) => console.log(s) } = {}) {
  const { pos, opt } = parseArgs(argv);
  const [group, cmd, arg] = pos;
  if (opt.help || !group || group === "help") { print(HELP); return 0; }

  if (group === "token") {
    if (cmd !== "new") throw new UsageError("token has one command: token new --out FILE.");
    const out = need(opt.out, "where to write the token (--out FILE)");
    const name = opt.name;
    if (name && !/^[A-Za-z0-9_.@-]{1,64}$/.test(name)) throw new UsageError("--name is up to 64 letters, digits, dots, dashes, underscores or @.");
    const token = randomBytes(32).toString("base64url");
    writePrivate(out, `${name ? `${name} ` : ""}${token}\n`, true);
    print(`A new admin token${name ? ` named ${name}` : ""} was added to ${out}. The token is not shown. The mesh reads the file again at its next admin request.`);
    return 0;
  }

  const ctx = { url: baseUrl(env, opt), token: readToken(env, opt), fetch: fetchImpl };
  const show = (json, text) => print(opt.json ? JSON.stringify(json, null, 2) : text);

  switch (`${group} ${cmd ?? ""}`.trim()) {
    case "status": {
      const s = await call(ctx, "GET", "/status");
      const c = s.counts ?? {};
      show(s, [
        `Mesh: ${s.mesh ?? "(unnamed)"}`,
        `Server: ${s.server ? `${s.server.name} ${s.server.version}` : "run from source (no release number)"}`,
        `Agent Messaging ${s.agent_messaging}, ${s.profile} profile, wire protocol ${s.protocol}, tenancy: ${s.tenancy}`,
        `The AgentMesh platform beside it: ${s.platform_beside ? "yes" : "no"}`,
        `Live revocation: ${s.live_revocation}`,
        `Credential minting: ${s.minting}`,
        `Tenants ${c.tenants ?? "?"}, agents ${c.agents ?? "?"}, credentials ${c.credentials ?? "?"}, stops in force ${c.stops_in_force ?? "?"} (${c.revoked_by_admin ?? "?"} placed with this tool)`,
        `Signed in with the admin token: ${s.token}`,
      ].join("\n"));
      return 0;
    }

    case "tenants list": {
      const r = await call(ctx, "GET", "/tenants");
      show(r, table(r.tenants.map((t) => ({ tenant: t.id, disabled: t.disabled ? "yes" : "", agents: t.agents, limits: Object.entries(t.limits ?? {}).map(([k, v]) => `${k}=${v}`).join(" ") })), ["tenant", "disabled", "agents", "limits"]));
      return 0;
    }
    case "tenants show": {
      const r = await call(ctx, "GET", `/tenants/${enc(need(arg, "which tenant"))}`);
      const t = r.tenant;
      show(r, [
        `Tenant ${t.id}${t.disabled ? " (disabled)" : ""}`,
        `Home organization: ${t.home_org ?? "none"}; owner key: ${t.owner_key ? short(t.owner_key) : "none"}`,
        `Limits: ${Object.entries(t.limits ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none of its own"}`,
        `Agents (${r.agents.length}):`,
        table(r.agents.map((a) => ({ agent: a.key, label: a.label ?? "", listed: a.listed ? "yes" : "no" })), ["agent", "label", "listed"]),
      ].join("\n"));
      return 0;
    }
    case "tenants create": {
      const r = await call(ctx, "POST", "/tenants", { ...(arg ? { id: arg } : {}), ...(opt["home-org"] ? { home_org: opt["home-org"] } : {}), ...(opt["owner-key"] ? { owner_key: opt["owner-key"] } : {}) });
      show(r, [`Tenant ${r.tenant.id} created.`, said(r)].filter(Boolean).join("\n"));
      return 0;
    }
    case "tenants disable":
    case "tenants enable": {
      const r = await call(ctx, "PATCH", `/tenants/${enc(need(arg, "which tenant"))}`, { disabled: cmd === "disable" });
      show(r, [`Tenant ${r.tenant.id} is ${r.tenant.disabled ? "disabled" : "enabled"}.`, said(r)].filter(Boolean).join("\n"));
      return 0;
    }
    case "tenants delete": {
      const r = await call(ctx, "DELETE", `/tenants/${enc(need(arg, "which tenant"))}`);
      show(r, [`Tenant ${r.deleted} deleted.`, said(r)].filter(Boolean).join("\n"));
      return 0;
    }
    case "tenants limits": {
      const id = need(arg, "which tenant");
      const body = {};
      const set = (name, v) => { if (v !== undefined) body[name] = v; };
      set("max_agents", wholeNumber(opt["max-agents"], "max-agents"));
      set("max_rooms", wholeNumber(opt["max-rooms"], "max-rooms"));
      const mb = wholeNumber(opt["max-drive-mb"], "max-drive-mb");
      set("max_drive_bytes", mb === undefined ? undefined : mb * 1024 * 1024);
      set("requests_per_minute", wholeNumber(opt["requests-per-minute"], "requests-per-minute"));
      for (const c of opt.clear ?? []) body[c.replace(/-/g, "_")] = null;
      if (!Object.keys(body).length) {
        const r = await call(ctx, "GET", `/tenants/${enc(id)}`);
        const l = r.tenant.limits ?? {};
        show({ tenant: id, limits: l }, Object.keys(l).length ? Object.entries(l).map(([k, v]) => `${k}: ${v}`).join("\n") : `Tenant ${id} has no limits of its own; the mesh's settings apply.`);
      return 0;
      }
      const r = await call(ctx, "PUT", `/tenants/${enc(id)}/limits`, body);
      show(r, `Limits for ${id}: ${Object.entries(r.limits).map(([k, v]) => `${k}=${v}`).join(", ") || "none of its own"}.`);
      return 0;
    }
    case "tenants key": {
      const id = need(arg, "which tenant");
      const r = await call(ctx, "POST", `/tenants/${enc(id)}/enroll-keys`, { label: need(opt.label, "the agent's label (--label)"), ...(opt.name ? { name: opt.name } : {}) });
      if (opt.out) {
        writePrivate(opt.out, `${r.key}\n`);
        show({ ...r, key: undefined, written_to: opt.out }, `An enrollment key for ${r.label} (tenant ${id}) was written to ${opt.out}. It works once, within ${r.expires_in_days} days: agentmesh up <key>.`);
      return 0;
      }
      show(r, `${r.key}\nOne agent enrolls with it, once, within ${r.expires_in_days} days: agentmesh up <key>`);
      return 0;
    }

    case "tenants trust": {
      const sub = arg;
      const tenant = pos[3];
      if (sub === "list") {
        if (!tenant) {
          const r = await call(ctx, "GET", "/trust");
          show(r, r.tenants.length ? r.tenants.map((t) => `${t.tenant}\n${trustTable(t.trust)}`).join("\n\n") : "No tenant trusts an outside identity system.");
          return 0;
        }
        const r = await call(ctx, "GET", `/tenants/${enc(tenant)}/trust`);
        show(r, trustTable(r.trust));
        return 0;
      }
      if (sub === "add") {
        need(tenant, "which tenant");
        let body;
        if (opt.oauth && opt.spiffe) throw new UsageError("Give --oauth or --spiffe, not both.");
        if (opt.oauth) {
          body = {
            kind: "oauth", issuer: opt.oauth,
            audience: need(opt.audience, "the audience its tokens carry for this mesh (--audience)"),
            require_binding: opt["require-binding"] === true,
            ...(opt["jwks-uri"] ? { jwks_uri: opt["jwks-uri"] } : {}),
          };
        } else if (opt.spiffe) {
          if (!!opt.bundle === !!opt["bundle-endpoint"]) throw new UsageError("Give the trust bundle as --bundle FILE or --bundle-endpoint URL, one of them.");
          let bundle;
          if (opt.bundle) {
            try { bundle = JSON.parse(readFileSync(opt.bundle, "utf8")); } catch { throw new UsageError(`${opt.bundle} is not a JSON trust bundle.`); }
          }
          body = {
            kind: "spiffe", trust_domain: opt.spiffe, require_mtls: opt["require-mtls"] === true,
            ...(bundle ? { bundle } : { bundle_endpoint: opt["bundle-endpoint"] }),
            ...(opt.audience ? { audience: opt.audience } : {}),
          };
        } else {
          throw new UsageError("Say what to trust: --oauth ISSUER --audience AUD, or --spiffe TRUST_DOMAIN with --bundle or --bundle-endpoint.");
        }
        if (opt.id) body.id = opt.id;
        const r = await call(ctx, "POST", `/tenants/${enc(tenant)}/trust`, body);
        const what = r.added.kind === "oauth" ? `the issuer ${r.added.issuer} (audience ${r.added.audience})` : `the SPIFFE trust domain ${r.added.trust_domain}`;
        show(r, `Tenant ${tenant} now trusts ${what}, as record ${r.added.id}. Its agents can enroll with a proof from it.`);
        return 0;
      }
      if (sub === "remove") {
        need(tenant, "which tenant");
        const id = need(pos[4], "which trust record (its id, from tenants trust list)");
        const r = await call(ctx, "DELETE", `/tenants/${enc(tenant)}/trust/${enc(id)}`);
        show(r, `Trust record ${id} was removed from tenant ${tenant}. New enrollments through it, and renewals of the agents that enrolled through it, are refused from now on.`);
        return 0;
      }
      throw new UsageError("tenants trust has three commands: list, add and remove.");
    }

    case "agents identity": {
      const r = await call(ctx, "GET", `/agents/${enc(need(arg, "which agent"))}/identity`);
      const src = r.identity_source;
      show(r, !src ? "This mesh holds no record of where this agent's identity came from (it enrolled before the record was kept)." : [
        `Identity source: ${src.kind}`,
        ...(src.issuer ? [`Issuer: ${src.issuer}`] : []),
        ...(src.trust_domain ? [`Trust domain: ${src.trust_domain}`] : []),
        ...(src.workload_id ? [`Workload identifier: ${src.workload_id}`] : []),
        ...(src.bridge ? [`Bridged by node: ${src.bridge}`] : []),
        `Since: ${src.since}`,
        `Tenant: ${r.tenant ?? "(none)"}`,
        `Signed attestation: ${r.attestation ? `yes, until ${r.attestation.expires_at}` : "no"}`,
      ].join("\n"));
      return 0;
    }

    case "agents list": {
      const r = await call(ctx, "GET", `/agents${q({ tenant: opt.tenant })}`);
      show(r, table(r.agents.map((a) => ({ agent: a.key, tenant: a.tenant ?? "", label: a.label ?? "", listed: a.listed ? "yes" : "no" })), ["agent", "tenant", "label", "listed"]));
      return 0;
    }
    case "agents show": {
      const r = await call(ctx, "GET", `/agents/${enc(need(arg, "which agent"))}`);
      const s = r.standing;
      show(r, [
        `Agent ${r.agent}`,
        r.owner ? `Tenant: ${r.owner.tenant ?? "none"}; label: ${r.owner.label ?? "none"}; listed: ${r.owner.listed ? "yes" : "no"}` : "Not enrolled: no tenant owns it on record.",
        `Status: ${s.status}${s.stopped ? ` (${s.stopped.action} since ${s.stopped.since}${s.stopped.by_admin ? ", placed with this tool" : ""})` : ""}`,
        `Credentials revoked: ${s.revoked ? `yes, ${s.revoked.at}: ${s.revoked.reason}` : "no"}; signing key revoked: ${s.signing_key_revoked ? `yes, ${s.signing_key_revoked.at}` : "no"}`,
        `Credentials (${r.credentials.length}):`,
        table(r.credentials.map((c) => ({ key: c.key, issued: c.issued_at, expires: c.expires_at ?? "never", renewals: c.renewals })), ["key", "issued", "expires", "renewals"]),
        `Admission policy: ${r.admission ? "set" : "the default"}`,
      ].join("\n"));
      return 0;
    }
    case "agents enroll": {
      const key = need(arg, "which agent");
      const r = await call(ctx, "PUT", `/agents/${enc(key)}`, { tenant: need(opt.tenant, "the tenant (--tenant)"), ...(opt.label ? { label: opt.label } : {}), ...(opt.unlisted ? { listed: false } : {}) });
      show(r, [`Agent ${short(key)} is enrolled under tenant ${r.agent.tenant}${r.revoke_lifted ? "; the revoke on it was lifted" : ""}.`, said(r)].filter(Boolean).join("\n"));
      return 0;
    }
    case "agents set": {
      const key = need(arg, "which agent");
      if (opt.listed && opt.unlisted) throw new UsageError("Choose --listed or --unlisted, not both.");
      const body = { ...(opt.tenant ? { tenant: opt.tenant } : {}), ...(opt.label ? { label: opt.label } : {}), ...(opt.listed ? { listed: true } : {}), ...(opt.unlisted ? { listed: false } : {}) };
      if (!Object.keys(body).length) throw new UsageError("Say what to change: --tenant, --label, --listed or --unlisted.");
      const r = await call(ctx, "PATCH", `/agents/${enc(key)}`, body);
      show(r, [`Agent ${short(key)}: tenant ${r.agent.tenant}, label ${r.agent.label ?? "none"}, ${r.agent.listed ? "listed" : "unlisted"}.`, said(r)].filter(Boolean).join("\n"));
      return 0;
    }
    case "agents remove": {
      const key = need(arg, "which agent");
      const r = await call(ctx, "DELETE", `/agents/${enc(key)}`, opt.reason ? { reason: opt.reason } : {});
      show(r, [`Agent ${short(key)} removed.`, r.revoke?.note, said(r)].filter(Boolean).join("\n"));
      return 0;
    }
    case "agents admission": {
      const key = need(arg, "which agent");
      const body = {};
      const defaults = {};
      if (opt.registered) defaults.registered = opt.registered;
      if (opt.anonymous) defaults.anonymous = opt.anonymous;
      if (Object.keys(defaults).length) body.defaults = defaults;
      const entries = [
        ...(opt.allow ?? []).map((s) => ({ subject: s, stance: "allow" })),
        ...(opt.hold ?? []).map((s) => ({ subject: s, stance: "hold" })),
        ...(opt.block ?? []).map((s) => ({ subject: s, stance: "block" })),
      ];
      if (entries.length) {
        const cur = await call(ctx, "GET", `/agents/${enc(key)}/admission`);
        const kept = ((cur.roster ?? cur.default)?.entries ?? []).filter((e) => !entries.some((n) => n.subject === e.subject));
        body.entries = [...kept, ...entries];
      }
      const n = wholeNumber(opt["per-sender-per-hour"], "per-sender-per-hour");
      if (n !== undefined) body.limits = { per_sender_per_hour: n };
      const r = Object.keys(body).length
        ? await call(ctx, "PUT", `/agents/${enc(key)}/admission`, body)
        : await call(ctx, "GET", `/agents/${enc(key)}/admission`);
      const roster = r.roster ?? r.default;
      show(r, [
        `Admission policy for ${short(key)}${r.roster ? "" : " (the default; none is set)"}:`,
        `Defaults: ${Object.entries(roster.defaults ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}`,
        `Per sender per hour: ${roster.limits?.per_sender_per_hour ?? "default"}`,
        `Entries: ${(roster.entries ?? []).map((e) => `${e.stance} ${short(e.subject)}`).join(", ") || "none"}`,
        said(r),
      ].filter(Boolean).join("\n"));
      return 0;
    }

    case "credentials list": {
      const r = await call(ctx, "GET", `/credentials${q({ agent: opt.agent?.[0], tenant: opt.tenant })}`);
      show(r, table(r.credentials.map((c) => ({ key: c.key, agents: c.agents.length === 1 ? short(c.agents[0]) : `${c.agents.length} agents`, tenant: c.tenant ?? "", issued: c.issued_at, expires: c.expires_at ?? "never" })), ["key", "agents", "tenant", "issued", "expires"]));
      return 0;
    }
    case "credentials mint": {
      const agents = opt.agent ?? [];
      if (!agents.length) throw new UsageError("Say which agents the credential is for (--agent, once per agent).");
      const out = need(opt.out, "where to write the creds file (--out FILE)");
      const r = await call(ctx, "POST", "/credentials", { agents, ...(opt.label ? { label: opt.label } : {}) });
      writePrivate(out, r.creds);
      const shown = { ...r, creds: undefined, written_to: out };
      show(shown, [`A credential for ${agents.length} agent${agents.length === 1 ? "" : "s"} on key ${r.user_key} was written to ${out}. It expires ${r.expires_at ?? "never"}.`, r.what_now].join("\n"));
      return 0;
    }
    case "credentials revoke": {
      const body = { ...(opt.agent?.[0] ? { agent: opt.agent[0] } : {}), ...(opt.tenant ? { tenant: opt.tenant } : {}), ...(opt.key ? { key: opt.key } : {}), ...(opt.reason ? { reason: opt.reason } : {}) };
      const r = await call(ctx, "POST", "/credentials/revoke", body);
      const text = r.revoked === "credential"
        ? [`Credential ${short(r.key)} revoked.`, r.result?.note, r.what_now]
        : [`Revoked the credentials of ${r.revoked === "agent" ? `agent ${short(r.target)}` : `tenant ${r.target} (${r.agents} agent${r.agents === 1 ? "" : "s"})`}.`, r.cut?.note, r.what_now];
      show(r, text.filter(Boolean).join("\n"));
      return 0;
    }
    case "credentials restore": {
      const body = { ...(opt.agent?.[0] ? { agent: opt.agent[0] } : {}), ...(opt.tenant ? { tenant: opt.tenant } : {}) };
      const r = await call(ctx, "POST", "/credentials/restore", body);
      show(r, [`Restored ${r.restored === "agent" ? `agent ${short(r.target)}` : `tenant ${r.target}`}: ${r.resumed} agent${r.resumed === 1 ? "" : "s"} running again${r.still_stopped ? `, ${r.still_stopped} still held by another stop` : ""}.`, r.what_now].join("\n"));
      return 0;
    }
    case "agent-keys revoke": {
      const key = need(arg, "which agent");
      const r = await call(ctx, "POST", "/agent-keys/revoke", { agent: key, reason: need(opt.reason, "why (--reason); a revoked signing key cannot be restored") });
      show(r, [`The signing key of ${short(key)} is revoked.`, r.what_now].join("\n"));
      return 0;
    }

    case "audit": {
      const r = await call(ctx, "GET", `/audit${q({ agent: opt.agent?.[0], tenant: opt.tenant, limit: opt.limit, verify: opt.verify ? "1" : undefined })}`);
      const lines = [table(r.entries.map((e) => ({ time: e.ts, agent: short(e.agent_id), role: e.role, with: short(e.counterparty), skill: e.skill, status: e.status })), ["time", "agent", "role", "with", "skill", "status"])];
      if (r.chains) for (const c of r.chains) lines.push(`Chain of ${short(c.agent)}: ${c.ok ? `intact (${c.count} rows)` : `BROKEN at row ${c.brokenAt} of ${c.count}`}`);
      show(r, lines.join("\n"));
      return 0;
    }
  }
  throw new UsageError(`Unknown command: ${pos.join(" ")}. mesh-admin --help lists them.`);
}

let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { isMain = false; }
/**
 * End with `code` once everything written has left. `process.exit()` right
 * after a write drops what a pipe has not taken yet: stdout to a pipe is
 * asynchronous, and a large `--json` answer (agents list on a big mesh) was
 * cut at 64 KB. An empty write's callback runs after every write before it
 * has been handed to the pipe, so the exit waits for those.
 */
function finish(code) {
  process.exitCode = code;
  let open = 2;
  const done = () => {
    if (--open === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

if (isMain) {
  run(process.argv.slice(2)).then(
    (code) => finish(code ?? 0),
    (err) => {
      if (err instanceof UsageError) {
        console.error(err.message);
        finish(2);
        return;
      }
      console.error(err.message);
      if (err.body && process.argv.includes("--json")) console.error(JSON.stringify(err.body, null, 2));
      finish(1);
    },
  );
}
