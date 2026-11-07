/**
 * The A2A card at the mesh home (A2A binding §3): `GET
 * /agents/{handle or agent id}/agent-card.json`, served by the core's mesh API
 * (keychain/mesh-api.ts) for every listed agent that serves the binding.
 *
 * The card's interface URL is the mesh home, `/agents/`, then the agent's
 * handle when it has one, else its agent ID. A handle is learned from the
 * naming service (PAN_URL, shared/require-names.ts): forward resolution names
 * the agent, and the reverse answer for that agent must name the same handle,
 * so a forward answer alone never decides which agent a handle is. Without a
 * naming service, agents are found by their agent ID only.
 *
 * Public and unauthenticated, like the registry's documents: a card says what
 * an agent's operator published. Private, unlisted and sandboxed agents, and
 * agents that do not serve the binding, are not found.
 */
import { storageOf, type KeyedStore, type StorageLike } from "../storage/index.js";
import type { Manifest } from "../sdk.js";
import { a2aCardFromManifest, servesA2ABinding } from "../../../sdk-typescript/src/a2a/card.js";
import { panBase, sharedNameLookup, type NameLookup } from "../shared/require-names.js";
import type { RawAnswer } from "./documents-http.js";

const NKEY = /^U[A-Z2-7]{55}$/;
const notFound: RawAnswer = { status: 404, body: { error: "Not found" } };

export interface AgentCardOptions {
  /** The mesh home: MESH_PUBLIC_URL, else API_BASE_URL. */
  meshHome: string;
  /** Reverse resolution (agent id to handle). Default: the process's. */
  names?: NameLookup;
  /** Forward resolution (handle to agent id). Default: the naming service. */
  resolveHandle?: (handle: string) => Promise<string | null>;
  /** The registry's store, when the caller already holds it (tests). */
  registry?: KeyedStore;
}

/** Forward resolution at the naming service: the agent id a handle's card
 *  binds, or null. */
export function panHandleResolver(fetchImpl: typeof fetch = fetch): (handle: string) => Promise<string | null> {
  return async (handle) => {
    const base = panBase();
    if (!base) return null;
    try {
      const r = await fetchImpl(`${base}/api/resolve?handle=${encodeURIComponent(handle)}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const doc = (await r.json().catch(() => null)) as { card?: { endpoints?: Array<{ protocol?: unknown; agent_id?: unknown }> } } | null;
      const ep = doc?.card?.endpoints?.find((e) => e?.protocol === "agentmesh" && typeof e.agent_id === "string" && NKEY.test(e.agent_id));
      return (ep?.agent_id as string | undefined) ?? null;
    } catch {
      return null;
    }
  };
}

export function agentCards(js: StorageLike, opts: AgentCardOptions) {
  let registry: Promise<KeyedStore> | null = opts.registry ? Promise.resolve(opts.registry) : null;
  const store = (): Promise<KeyedStore> => {
    registry ??= storageOf(js).keyed("mesh_registry");
    registry.catch(() => (registry = null));
    return registry;
  };
  const names = (): NameLookup | null => opts.names ?? (panBase() ? sharedNameLookup : null);
  const resolveHandle = opts.resolveHandle ?? panHandleResolver();

  return {
    /** The card for one path segment: an agent id or a handle. */
    async card(segment: string): Promise<RawAnswer> {
      let name: string;
      try {
        name = decodeURIComponent(segment);
      } catch {
        return notFound;
      }
      let id: string | null = null;
      let handle: string | null = null;
      const lookup = names();
      if (NKEY.test(name)) {
        id = name;
        const a = lookup ? await lookup(id).catch(() => null) : null;
        if (a?.status === "named") handle = a.handle;
      } else {
        id = await resolveHandle(name);
        if (!id || !lookup) return notFound;
        const a = await lookup(id).catch(() => null);
        if (a?.status !== "named" || a.handle !== name) return notFound;
        handle = name;
      }
      let manifest: Manifest;
      try {
        const e = await (await store()).get(id);
        if (!e || e.operation !== "PUT" || !e.value?.length) return notFound;
        manifest = e.json<Manifest>();
      } catch {
        return notFound;
      }
      if (manifest.visibility === "private" || manifest.visibility === "unlisted" || manifest.sandbox) return notFound;
      if (!servesA2ABinding(manifest)) return notFound;
      const card = a2aCardFromManifest(manifest, { meshHome: opts.meshHome, agent: handle ?? id });
      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
        body: card as unknown as Record<string, unknown>,
      };
    },
  };
}
