/**
 * The capabilities answer: what this mesh offers (step 5 of
 * docs/agent-messaging-server-plan.md), at GET /v1/capabilities.
 *
 * The core answers with what every Agent Messaging server offers: the
 * specification version and profile it implements (SPEC.md §1.6, whose rule 2
 * says a server states them), the wire protocol, its tenancy model, and the
 * requests of every core service, by service. The AgentMesh platform adds its
 * entries on top: the full specification as its profile, its own services'
 * requests, and the facts it has always published here (clearing, reputation,
 * organizations, the markup and where to report).
 *
 * The SDKs and the adapter read `services` when they connect. A request of a
 * platform service that is not listed is refused at the door with "not
 * available on this mesh", and the adapter's MCP tool list leaves it out. A
 * mesh whose answer has no `services` (one older than this) is taken to offer
 * everything, as before.
 */
import { AGENT_MESSAGING_VERSION, CORE_REQUESTS } from "./core-services.generated.js";
import { serverRelease, type ServerRelease } from "./server-release.js";

/** The wire protocol version a mesh speaks (§18.10 `mesh.protocol`). */
export const WIRE_PROTOCOL = "0.3";

export interface Capabilities {
  /** The Agent Messaging version implemented, from SPEC.md. */
  agent_messaging: string;
  /** "core" for a server alone; "full" when every deployment-defined part is offered too (§1.6). */
  profile: "core" | "full";
  /** The wire protocol version (§18.10). */
  protocol: string;
  /** How tenants are kept (§1.6, the tenancy model): one NATS account, with
   *  tenants as records the server enforces itself. */
  tenancy: "one_nats_account" | "one_rabbitmq_vhost";
  /** The binding the mesh runs (SPEC §18): "nats", the reference binding, or
   *  "rabbitmq" (docs/agent-messaging-server-plan.md, step 9). */
  binding: "nats" | "rabbitmq";
  /** Whether this mesh offers naming: a naming service whose verified names it
   *  requires and shows (SPEC §1.6, Names, a deployment-defined part). The
   *  core alone offers none (false), and says so, as §1.6 rule 2 asks; the
   *  AgentMesh platform says true. Where it is false, an agent is known by its
   *  key and by the account that holds it, and the reference adapter takes the
   *  mesh's word that an account holds its key in place of a verified name. */
  naming: boolean;
  /** Every request this mesh offers, by service. */
  services: Record<string, string[]>;
  /** The server's own release, when it runs from a released image
   *  (shared/server-release.ts). Left out for a server run from source. */
  server?: ServerRelease;
  [extra: string]: unknown;
}

/** The core's own answer. */
export function coreCapabilities(env: NodeJS.ProcessEnv = process.env): Capabilities {
  const release = serverRelease(env);
  const rabbitmq = env.MESH_BROKER?.trim().toLowerCase() === "rabbitmq";
  return {
    agent_messaging: AGENT_MESSAGING_VERSION,
    profile: "core",
    protocol: WIRE_PROTOCOL,
    tenancy: rabbitmq ? "one_rabbitmq_vhost" : "one_nats_account",
    binding: rabbitmq ? "rabbitmq" : "nats",
    naming: false,
    services: Object.fromEntries(Object.entries(CORE_REQUESTS).map(([s, reqs]) => [s, [...reqs]])),
    ...(release ? { server: release } : {}),
  };
}

/** The core's answer with a platform's entries on top. `services` is the two
 *  lists together; every other entry the platform names replaces the core's. */
export function withPlatform(core: Capabilities, platform: Record<string, unknown> | null | undefined): Capabilities {
  if (!platform) return core;
  const services: Record<string, string[]> = Object.fromEntries(Object.entries(core.services).map(([s, r]) => [s, [...r]]));
  const extra = platform.services;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [s, reqs] of Object.entries(extra as Record<string, unknown>)) {
      if (!Array.isArray(reqs)) continue;
      const have = (services[s] ??= []);
      for (const r of reqs) if (typeof r === "string" && !have.includes(r)) have.push(r);
    }
  }
  return { ...core, ...platform, services } as Capabilities;
}
