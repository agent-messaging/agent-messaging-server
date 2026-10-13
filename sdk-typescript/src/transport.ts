/**
 * Which transport a mesh speaks, from what it says at credential time
 * (docs/agent-messaging-server-plan.md, step 10).
 *
 * Every credential-issuing answer carries a `mesh` object (SPEC §18.10).
 * Since Agent Messaging 0.7 its `endpoints` lists the mesh's transport
 * addresses as URLs in preference order, whose scheme names the binding
 * (`nats://`, `ws://`, `wss://` on NATS; `amqp://`, `amqps://` on RabbitMQ).
 * A NATS mesh also sends `nats_endpoints`, for clients older than 0.7; a
 * mesh older than 0.7 sends only that. This SDK prefers `endpoints` and
 * falls back to `nats_endpoints`, here and nowhere else.
 */

export type Binding = "nats" | "amqp";

/**
 * The transport itself, for a caller that speaks the wire rather than the
 * agent API (the conformance suite): the NATS one for a nats://, ws:// or
 * wss:// address, the AMQP one for amqp:// or amqps://. Each has `binding`,
 * `publish`, `subscribe`, `request`, `flush`, `drain`, `close` and
 * `isClosed`; the NATS one also has `raw`, the NATS connection.
 */
export async function connectTransport(opts: import("./types/options.js").ConnectOptions): Promise<import("./internal/connection.js").ConnectionManager> {
  const { ConnectionManager } = await import("./internal/connection.js");
  return ConnectionManager.connect(opts);
}

/** The binding an address speaks, by its scheme; null when it names none we know. */
export function bindingOfUrl(url: string): Binding | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "amqp" || scheme === "amqps") return "amqp";
  if (scheme === "nats" || scheme === "tls" || scheme === "ws" || scheme === "wss") return "nats";
  return null;
}

/** The `mesh` object of a credential answer, as far as this reads it. */
export interface MeshObject {
  name?: string;
  protocol?: string;
  /** The reference binding's own list: sent by a NATS mesh, and the only list
   *  a mesh older than Agent Messaging 0.7 sends. */
  nats_endpoints?: string[];
  /** Every binding's transport addresses (SPEC §18.10, Agent Messaging 0.7). */
  endpoints?: string[];
}

/**
 * The transport to dial and the addresses to dial it on, from a credential
 * answer's `mesh` object. `endpoints` wins when it is there and names a
 * binding this SDK speaks (the first such address decides the binding);
 * otherwise the NATS addresses are used, as every mesh before 0.7 sent them. `prefer` orders NATS addresses (WebSocket in a
 * browser, TCP elsewhere). Null when the answer names no address at all.
 */
export function transportFromMesh(mesh: MeshObject | null | undefined, prefer: "ws" | "tcp" = "ws"): { binding: Binding; servers: string[] } | null {
  if (!mesh) return null;
  const isWs = (u: string) => /^wss?:/i.test(u);
  const order = (list: string[]) => [...list].sort((a, b) => (isWs(a) === isWs(b) ? 0 : (isWs(a) ? -1 : 1) * (prefer === "ws" ? 1 : -1)));
  const listed = (mesh.endpoints ?? []).filter((u) => bindingOfUrl(u) !== null);
  if (listed.length) {
    const binding = bindingOfUrl(listed[0]!)!;
    const same = listed.filter((u) => bindingOfUrl(u) === binding);
    return { binding, servers: binding === "nats" ? order(same) : same };
  }
  const nats = (mesh.nats_endpoints ?? []).filter((u) => bindingOfUrl(u) === "nats");
  if (!nats.length) return null;
  return { binding: "nats", servers: order(nats) };
}
