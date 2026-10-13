/**
 * The `mesh` object every credential-issuing answer carries (SPEC.md §18.10):
 * where the mesh is, so a client needs only the mesh home's address.
 *
 * - `name` and `protocol` (the wire version, "0.3" since the MESH_EVENTS
 *   cutover of 2026-08-18) on every binding.
 * - `endpoints`, the transport addresses as URLs in preference order, whose
 *   scheme names the binding (Agent Messaging 0.7): nats://, ws://, wss://
 *   on NATS, amqp://, amqps:// on RabbitMQ.
 * - `nats_endpoints`, the reference binding's own list, which a NATS mesh
 *   MUST still send so clients older than 0.7 keep working. A RabbitMQ mesh
 *   sends it empty.
 *
 * One function for every door of the core (the node-credential door, the
 * bootstrap door, the admin door's mint), so no door can send a different
 * object. Settings: MESH_NAME, MESH_BROKER, MESH_NATS_ENDPOINTS (else the
 * core's broker.nats and broker.ws settings), MESH_AMQP_ENDPOINTS.
 */
import { coreSetting } from "../shared/settings.js";

export type MeshObject = {
  name: string;
  protocol: string;
  endpoints: string[];
  nats_endpoints: string[];
};

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function meshInfo(env: NodeJS.ProcessEnv = process.env): MeshObject {
  const name = env.MESH_NAME ?? "agentmesh.ai";
  if (env.MESH_BROKER?.trim().toLowerCase() === "rabbitmq") {
    // No NATS address to give: the broker's own go in `endpoints`.
    return { name, protocol: "0.3", endpoints: list(env.MESH_AMQP_ENDPOINTS ?? ""), nats_endpoints: [] };
  }
  const nats = list(env.MESH_NATS_ENDPOINTS ?? [coreSetting("broker.nats"), coreSetting("broker.ws")].filter(Boolean).join(","));
  return { name, protocol: "0.3", endpoints: nats, nats_endpoints: nats };
}
