/**
 * How the SDK reaches a platform service (platform-services/README.md): one
 * POST to the platform's service door per request, signed by the agent's own
 * key over the request's name, the time, a one-time nonce and a digest of
 * what it sends, the way every agent-authored call on the platform is. The
 * platform decides who may make it from the signer; nothing here does.
 *
 * A key rides only with the requests that need it (debt 378): the account's
 * API token with an owner's acts (credits, attachments, portfolio), the
 * operator key with an operator's (mesh.errors, filing and moving debt). An
 * agent's other requests carry its signature alone, because the platform
 * reads an account token on any request as the token speaking and refuses one
 * whose scopes do not cover the mesh. The adapter's svcCall and the Rust SDK
 * draw the same lines. A script that is not an agent sends the key it has
 * with every request: `new PlatformServices(platformCaller({ key }))`.
 *
 * Browser-safe: no Buffer and no node:crypto, the same as artifacts.ts.
 */
import { REQUEST_TIERS, ServiceRefusal, type KeyUse, type ServiceCaller } from "./services.generated.js";
import { AM_URL_API } from "./am-env.generated.js";
import { capabilitiesReader, notAvailableRefusal, type MeshCapabilities } from "./capabilities.js";

/** JSON with keys sorted at every level, so the platform hashes the bytes
 *  this signs (server/src/platform-services/door.ts stableJson). */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PlatformCallerOptions {
  /** The platform's API. This environment's when left out. */
  api?: string;
  /** The account's API token, sent as the bearer with an owner's acts. For a
   *  caller that is not an agent, whatever key it has, sent with every request. */
  key?: string;
  /** An operator key, sent as the bearer with the requests only an operator
   *  may make. */
  operatorKey?: string;
  /** The agent that signs each request: its key and a signer over a string. */
  agent?: { id: string; sign(message: string): string };
  /** Which door this is, for the platform's records. */
  door?: string;
  fetchImpl?: typeof fetch;
  /** How long to wait for an answer. Thirty seconds when left out. */
  timeoutMs?: number;
  /** Where the mesh's capabilities answer comes from (capabilities.ts). Read
   *  from the API when left out; null checks nothing. A request the mesh does
   *  not offer is refused with NOT_AVAILABLE before it is sent. */
  capabilities?: (() => Promise<MeshCapabilities | null>) | null;
}

/** The key a request carries as the bearer, if any. An agent sends the
 *  account token only with an owner's act and the operator key only with an
 *  operator's; the rest go on its signature alone. A caller that is not an
 *  agent has only its key, and sends it. `key` left out (a caller written
 *  before requests said which key they need) sends whatever key there is. */
export function bearerFor(opts: Pick<PlatformCallerOptions, "key" | "operatorKey" | "agent">, key?: KeyUse): string | undefined {
  if (opts.agent && key === "signature") return undefined;
  if (opts.agent && key === "owner") return opts.key;
  if (opts.agent && key === "operator") return opts.operatorKey;
  if (key === "operator") return opts.operatorKey ?? opts.key;
  return opts.key ?? opts.operatorKey;
}

/** A caller for PlatformServices. */
export function platformCaller(opts: PlatformCallerOptions): ServiceCaller {
  const api = (opts.api ?? AM_URL_API).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init));
  const capabilities = opts.capabilities === undefined ? capabilitiesReader(api, doFetch) : opts.capabilities;
  return {
    async call(request: string, input: Record<string, unknown>, key?: KeyUse): Promise<unknown> {
      // A platform request this mesh does not offer is refused here, in
      // plain words, rather than sent to fail some other way.
      if (capabilities && REQUEST_TIERS[request] === "platform") {
        const no = notAvailableRefusal(await capabilities(), request, api);
        if (no) throw no;
      }
      const bearer = bearerFor(opts, key);
      const body: Record<string, unknown> = { input, door: opts.door ?? "sdk" };
      if (opts.agent) {
        const ts = new Date().toISOString();
        const nonce = globalThis.crypto.randomUUID();
        const digest = await sha256Hex(stableJson(input ?? {}));
        body.agent = opts.agent.id;
        body.ts = ts;
        body.nonce = nonce;
        body.sig = opts.agent.sign(`svc-v1:${opts.agent.id}:${request}:${ts}:${nonce}:${digest}`);
      }
      const res = await doFetch(`${api}/v1/svc/${encodeURIComponent(request)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      const out = (await res.json().catch(() => ({}))) as { result?: unknown; refusal?: string; error?: string };
      if (res.ok) return out.result;
      if (out.refusal) throw new ServiceRefusal(request, out.refusal, out.error ?? out.refusal);
      throw new Error(out.error ?? `the platform answered ${request} with HTTP ${res.status}`);
    },
  };
}
