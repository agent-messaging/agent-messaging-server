/**
 * The registry's documents over HTTPS, served by the core's mesh API
 * (keychain/mesh-api.ts): the exact stored bytes of an agent's Common Agent
 * descriptor (§6.7) and evaluation record (§9.4), current or by digest, and
 * the gateway check (whether a key is a caller the A2A gateway registered).
 *
 *   GET /v1/agents/:key/descriptor     GET /v1/descriptors/:digest
 *   GET /v1/agents/:key/eval-record    GET /v1/eval-records/:digest
 *   GET /v1/gateway-check/:key
 *
 * Until step 10a of docs/agent-messaging-server-plan.md the AgentMesh API
 * served these from the registry's stores in its own process; they are the
 * core's, so the core serves them, and the platform's API passes the paths on.
 *
 * The document routes answer raw stored bytes, never a reserialization: the
 * digest is defined over exact bytes, and a pretty-printer would quietly break
 * every signed reference. By digest is immutable, so it caches forever; the
 * current route revalidates on its digest ETag. Public and unauthenticated: a
 * descriptor is a document its operator published.
 */
import { createHash } from "node:crypto";
import { storageOf, type KeyedStore, type StorageLike } from "../storage/index.js";

/** One answer: JSON, or raw bytes with their headers. */
export interface RawAnswer {
  status: number;
  headers?: Record<string, string | number>;
  body: Uint8Array | Record<string, unknown>;
}

const NKEY = /^U[A-Z2-7]{55}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const notFound: RawAnswer = { status: 404, body: { error: "Not found" } };

type DocKind = "descriptor" | "eval-record";
const STORES: Record<DocKind, { current: "mesh_descriptors" | "mesh_eval_records"; archive: "mesh_descriptor_archive" | "mesh_eval_record_archive"; header: string }> = {
  descriptor: { current: "mesh_descriptors", archive: "mesh_descriptor_archive", header: "x-descriptor-digest" },
  "eval-record": { current: "mesh_eval_records", archive: "mesh_eval_record_archive", header: "x-eval-record-digest" },
};

export function registryDocuments(js: StorageLike, env: NodeJS.ProcessEnv = process.env) {
  const storage = storageOf(js);
  const opened = new Map<string, Promise<KeyedStore>>();
  const store = (name: Parameters<typeof storage.keyed>[0]): Promise<KeyedStore> => {
    let p = opened.get(name);
    if (!p) {
      p = storage.keyed(name);
      opened.set(name, p);
      p.catch(() => { if (opened.get(name) === p) opened.delete(name); });
    }
    return p;
  };

  const raw = (bytes: Uint8Array, digest: string, header: string, immutable: boolean): RawAnswer => ({
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": bytes.length,
      etag: `"${digest}"`,
      [header]: digest,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
    body: bytes,
  });

  const live = async (name: Parameters<typeof storage.keyed>[0], key: string): Promise<Uint8Array | null> => {
    const e = await (await store(name)).get(key);
    return e && e.operation === "PUT" && e.value.length > 0 ? e.value : null;
  };

  return {
    /** The current document for an agent. */
    async current(kind: DocKind, key: string): Promise<RawAnswer> {
      try {
        const bytes = await live(STORES[kind].current, key);
        return bytes ? raw(bytes, sha256(bytes), STORES[kind].header, false) : notFound;
      } catch {
        return notFound;
      }
    },
    /** Any stored version, by its digest. */
    async byDigest(kind: DocKind, digest: string): Promise<RawAnswer> {
      if (!DIGEST.test(digest)) return notFound;
      try {
        const bytes = await live(STORES[kind].archive, digest);
        return bytes ? raw(bytes, digest, STORES[kind].header, true) : notFound;
      } catch {
        return notFound;
      }
    },
    /** One boolean: a caller identity the A2A gateway minted for an outside
     *  client. True only when the registry holds a manifest for the key that
     *  carries the gateway's marker AND was registered under a node other
     *  than the key itself (the gateway's own node vouches for its callers),
     *  AND, where the deployment names its gateway node (A2A_GATEWAY_NODE_KEY),
     *  under that node. A failed read is false: the door then treats the
     *  sender as anonymous, which only narrows what it gets. */
    async gatewayCheck(key: string): Promise<RawAnswer> {
      if (!NKEY.test(key)) return { status: 200, body: { gateway: false } };
      try {
        const e = await (await store("mesh_registry")).get(key);
        if (!e || e.operation !== "PUT" || !e.value.length) return { status: 200, body: { gateway: false } };
        const m = e.json<{ node?: { id?: string }; meta?: { a2a_bridge?: unknown } }>();
        const nodeId = typeof m.node?.id === "string" ? m.node.id : null;
        const marked = !!m.meta && typeof m.meta === "object" && !!(m.meta as { a2a_bridge?: unknown }).a2a_bridge;
        const wanted = (env.A2A_GATEWAY_NODE_KEY ?? "").trim();
        return { status: 200, body: { gateway: marked && !!nodeId && nodeId !== key && (!wanted || nodeId === wanted) } };
      } catch {
        return { status: 200, body: { gateway: false } };
      }
    },
  };
}

export type RegistryDocuments = ReturnType<typeof registryDocuments>;

/** The route this answers, if the path is one of the five. */
export async function registryDocumentRoute(docs: RegistryDocuments, method: string, path: string): Promise<RawAnswer | null> {
  if (method !== "GET") return null;
  let m: RegExpExecArray | null;
  if ((m = /^\/v1\/agents\/([^/]+)\/descriptor$/.exec(path))) return docs.current("descriptor", decodeURIComponent(m[1]!));
  if ((m = /^\/v1\/descriptors\/([^/]+)$/.exec(path))) return docs.byDigest("descriptor", decodeURIComponent(m[1]!));
  if ((m = /^\/v1\/agents\/([^/]+)\/eval-record$/.exec(path))) return docs.current("eval-record", decodeURIComponent(m[1]!));
  if ((m = /^\/v1\/eval-records\/([^/]+)$/.exec(path))) return docs.byDigest("eval-record", decodeURIComponent(m[1]!));
  if ((m = /^\/v1\/gateway-check\/([^/]+)$/.exec(path))) return docs.gatewayCheck(decodeURIComponent(m[1]!));
  return null;
}
