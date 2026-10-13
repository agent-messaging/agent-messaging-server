/**
 * What a mesh offers, and the check every platform request makes against it
 * (step 5 of docs/agent-messaging-server-plan.md).
 *
 * A mesh answers GET /v1/capabilities with the Agent Messaging version and
 * profile it implements and `services`: every request it offers, by service.
 * Every Agent Messaging server offers the core services; the AgentMesh
 * platform adds its own. Before a request of a platform service goes out, the
 * SDK reads that answer (once, then again every five minutes), and a request
 * the mesh does not list is refused here with NOT_AVAILABLE and plain words,
 * never sent to fail some other way.
 *
 * Nothing is refused when the mesh says nothing: no answer, an answer the SDK
 * cannot read, or one with no `services` (a mesh older than the list) leaves
 * every request to go as before. A core request is never refused here.
 *
 * Browser-safe, like service-caller.ts.
 */
import { NOT_AVAILABLE, REQUEST_TIERS, ServiceRefusal, notAvailable } from "./services.generated.js";

/** A mesh's capabilities answer. */
export interface MeshCapabilities {
  /** The Agent Messaging version the mesh implements. */
  agent_messaging?: string;
  /** "core" for an Agent Messaging server alone, "full" with the AgentMesh platform. */
  profile?: "core" | "full" | string;
  /** The wire protocol version. */
  protocol?: string;
  /** How the mesh keeps its tenants. */
  tenancy?: string;
  /** Every request the mesh offers, by service. */
  services?: Record<string, string[]>;
  [entry: string]: unknown;
}

/** How long an answer is kept before it is read again. */
export const CAPABILITIES_TTL_MS = 5 * 60_000;
/** How long "no answer" is kept: shorter, so a mesh that was briefly out of
 *  reach is asked again soon. */
export const CAPABILITIES_RETRY_MS = 30_000;
/** How long the SDK waits for the answer before going ahead without it. */
export const CAPABILITIES_TIMEOUT_MS = 5_000;

/** Whether the mesh offers `request` (`<service>.<request>`): true or false
 *  when its answer lists services, undefined when it says nothing. */
export function meshOffers(caps: MeshCapabilities | null | undefined, request: string): boolean | undefined {
  const services = caps?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return undefined;
  const dot = request.indexOf(".");
  const list = (services as Record<string, unknown>)[request.slice(0, dot)];
  return Array.isArray(list) && list.includes(request.slice(dot + 1));
}

/** The refusal for a platform request the mesh does not offer, or null when
 *  the request may go. `mesh` is the address the mesh was reached at. */
export function notAvailableRefusal(caps: MeshCapabilities | null | undefined, request: string, mesh: string): ServiceRefusal | null {
  if (REQUEST_TIERS[request] !== "platform") return null;
  if (meshOffers(caps, request) !== false) return null;
  return new ServiceRefusal(request, NOT_AVAILABLE, notAvailable(request, mesh));
}

/** Reads the capabilities answer of the mesh at `api`, keeping it for
 *  CAPABILITIES_TTL_MS. Null when there is no answer to read. */
export function capabilitiesReader(
  api: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): () => Promise<MeshCapabilities | null> {
  const root = api.replace(/\/+$/, "");
  let kept: { at: number; caps: MeshCapabilities | null } | null = null;
  let reading: Promise<MeshCapabilities | null> | null = null;
  return async () => {
    if (kept && Date.now() - kept.at < (kept.caps ? CAPABILITIES_TTL_MS : CAPABILITIES_RETRY_MS)) return kept.caps;
    reading ??= (async () => {
      let caps: MeshCapabilities | null = null;
      try {
        const res = await fetchImpl(`${root}/v1/capabilities`, { signal: AbortSignal.timeout(CAPABILITIES_TIMEOUT_MS) });
        const body = res.ok ? ((await res.json().catch(() => null)) as unknown) : null;
        caps = body && typeof body === "object" && !Array.isArray(body) ? (body as MeshCapabilities) : null;
      } catch {
        caps = null;
      }
      kept = { at: Date.now(), caps };
      reading = null;
      return caps;
    })();
    return reading;
  };
}

/** A door whose every method first checks that the mesh offers it: for the
 *  platform requests done on the mesh (owner.ask, reviews.file, reviews.rate),
 *  which do not go through the service door. */
export function gatedDoor<T extends object>(door: T, service: string, check: (request: string) => Promise<void>): T {
  return new Proxy(door, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function" || typeof prop !== "string" || !(`${service}.${prop}` in REQUEST_TIERS)) return v;
      return async (...args: unknown[]) => {
        await check(`${service}.${prop}`);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
