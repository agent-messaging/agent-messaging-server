/**
 * Where the gateway dials the mesh, from MESH_URL: one address or several,
 * comma-separated. The transport is chosen the way the SDK chooses it from a
 * credential answer's `mesh` object (SPEC §18.10, `transportFromMesh`): the
 * first address whose scheme names a binding decides it, so `ws://`, `wss://`
 * or `nats://` dials NATS and `amqp://` or `amqps://` dials RabbitMQ, and only
 * the addresses of that binding are kept. The gateway runs on either binding
 * with nothing else changed.
 */
import { transportFromMesh, type Binding } from "../../sdk-typescript/src/transport.js";

export const DEFAULT_MESH_URL = "ws://localhost:4443";

export function meshAddress(raw: string | undefined): { binding: Binding; servers: string[] } {
  const given = raw?.trim() ? raw : DEFAULT_MESH_URL;
  const endpoints = given.split(",").map((s) => s.trim()).filter(Boolean);
  const t = transportFromMesh({ endpoints });
  if (!t) {
    throw new Error(`MESH_URL is "${given}", which names no mesh this gateway can dial: use ws://, wss:// or nats:// for a NATS mesh, amqp:// or amqps:// for a RabbitMQ mesh.`);
  }
  return t;
}
