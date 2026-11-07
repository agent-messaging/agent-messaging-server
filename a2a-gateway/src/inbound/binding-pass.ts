/**
 * The gateway's A2A binding path (bindings/a2a.md §13; MAPPING.md §4.0).
 *
 * A mesh agent that serves the A2A binding (its manifest lists the binding
 * URI in `capabilities`) speaks A2A 1.0's own operations and objects in 0.4.0
 * frames. So an HTTP caller's A2A request, from JSON-RPC or HTTP+JSON, is
 * passed into a frame as it is, and the A2A result comes back as it is: the
 * gateway translates no A2A object. It maps identity at the edge (the caller's
 * hosted identity signs the frame, SPEC.md §4.15) and maps the errors of the
 * binding (§9) to JSON-RPC by the integer each carries. Agents that do not
 * list the binding keep the 0.3.0 translation in server.ts.
 */
import type { ServerResponse } from "node:http";
import type { AgentMesh } from "../../../sdk-typescript/src/mesh.js";
import type { Manifest } from "../../../sdk-typescript/src/types/manifest.js";
import { MeshError } from "../../../sdk-typescript/src/types/errors.js";
import { A2A_BINDING_URI, isA2AMethod } from "../../../sdk-typescript/src/a2a/binding.js";
import { A2AError } from "../../../sdk-typescript/src/a2a/errors.js";
import { EXT_OFFERING } from "../../../sdk-typescript/src/a2a/extensions.js";
import { routeOffering } from "../../../sdk-typescript/src/a2a/readings.js";
import type { A2AMethod } from "../../../sdk-typescript/src/a2a/types.js";
import { meshErrorToRpc } from "../core/errors.js";
import { rpcError, rpcResult, type JsonRpcRequest, type JsonRpcResponse } from "../core/jsonrpc.js";

/** Does this agent serve the A2A binding (its manifest lists the binding)? */
export function servesBinding(manifest: Manifest | null | undefined): boolean {
  return Array.isArray(manifest?.capabilities) && manifest!.capabilities.includes(A2A_BINDING_URI);
}

/** The method names the binding carries, including the release candidate's
 *  singular spelling of ListTaskPushNotificationConfigs, read as the plural. */
export function bindingMethod(method: string): A2AMethod | null {
  if (method === "ListTaskPushNotificationConfig") return "ListTaskPushNotificationConfigs";
  return isA2AMethod(method) ? method : null;
}

/** The A2A service parameters an HTTP request carries in its headers (§7):
 *  `A2A-Extensions`, and any other `A2A-` header. `A2A-Version` is set by
 *  the SDK. */
export function serviceParamsFromHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k.toLowerCase().startsWith("a2a-") || k.toLowerCase() === "a2a-version" || v === undefined) continue;
    const name = k
      .split("-")
      .map((w) => (w.toLowerCase() === "a2a" ? "A2A" : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join("-");
    out[name] = Array.isArray(v) ? v.join(",") : v;
  }
  return out;
}

/**
 * The A2A Bridge §4.5: during the transition window a caller with no key may
 * still name the offering with the older metadata keys (`agentmesh.offering`,
 * `agentmesh.skill`). The gateway adds the offering extension's key with the
 * same value before the frame is signed, and refuses the two disagreeing.
 */
export function withOfferingKey(params: unknown, declared: readonly string[]): { params: unknown } | { error: true; offerings: string[] } {
  const message = (params as { message?: { metadata?: Record<string, unknown> } } | undefined)?.message;
  const md = message?.metadata;
  if (!md || (md["agentmesh.offering"] === undefined && md["agentmesh.skill"] === undefined)) return { params };
  const routed = routeOffering(declared, md);
  if ("error" in routed) {
    // Only the keys' disagreement is the gateway's to refuse; anything else
    // (an undeclared name) the agent answers itself.
    const ext = (md[EXT_OFFERING] as { offering?: unknown } | undefined)?.offering;
    const old = md["agentmesh.offering"] ?? md["agentmesh.skill"];
    return ext !== undefined && ext !== old ? { error: true, offerings: routed.offerings } : { params };
  }
  if (!routed.added) return { params };
  return {
    params: {
      ...(params as object),
      message: { ...message, metadata: { ...md, [EXT_OFFERING]: { offering: routed.offering } } },
    },
  };
}

/** A binding error or a channel error, as a JSON-RPC error and HTTP status. */
export function bindingErrorToRpc(id: JsonRpcRequest["id"], err: unknown): { status: number; body: JsonRpcResponse } {
  if (err instanceof A2AError) return { status: 200, body: rpcError(id, err.rpcCode, err.message, Object.keys(err.data).length ? err.data : undefined) };
  if (err instanceof MeshError) {
    const mapped = meshErrorToRpc(err);
    return { status: mapped.httpStatus, body: { jsonrpc: "2.0", id, error: mapped.error } };
  }
  return { status: 200, body: rpcError(id, -32603, err instanceof Error ? err.message : String(err)) };
}

/**
 * One A2A operation for a binding agent. A streaming operation answers with
 * Server-Sent Events, each the JSON-RPC result of one stream event, ending
 * when the stream does; every other operation answers with its one result.
 */
export async function passThroughBinding(
  res: ServerResponse,
  id: JsonRpcRequest["id"],
  method: A2AMethod,
  params: unknown,
  requester: AgentMesh,
  agentId: string,
  serviceParams: Record<string, string>,
  write: (res: ServerResponse, status: number, body: unknown) => void,
  /** The offerings the agent declares, for the older offering keys (§4.5). */
  declared: readonly string[] = [],
): Promise<"ok" | "error"> {
  const opts = { serviceParams, timeoutMs: 60_000 };
  if (method === "SendMessage" || method === "SendStreamingMessage") {
    const fixed = withOfferingKey(params, declared);
    if ("error" in fixed) {
      write(res, 200, rpcError(id, -32602, "The offering keys disagree, or name no offering this agent declares.", { offerings: fixed.offerings }));
      return "error";
    }
    params = fixed.params;
  }
  if (method === "SendStreamingMessage" || method === "SubscribeToTask") {
    const stream =
      method === "SendStreamingMessage"
        ? requester.a2a.sendStreamingMessage(agentId, params as never, opts)
        : requester.a2a.subscribeToTask(agentId, params as never, opts);
    let started = false;
    try {
      for await (const ev of stream) {
        if (!started) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          started = true;
        }
        res.write(`data: ${JSON.stringify(rpcResult(id, ev))}\n\n`);
      }
      if (started) res.end();
      return "ok";
    } catch (err) {
      const mapped = bindingErrorToRpc(id, err);
      if (!started) write(res, mapped.status, mapped.body);
      else {
        res.write(`data: ${JSON.stringify(mapped.body)}\n\n`);
        res.end();
      }
      return "error";
    }
  }
  try {
    const result = await requester.a2a.call(agentId, method, (params ?? {}) as never, opts);
    write(res, 200, rpcResult(id, result));
    return "ok";
  } catch (err) {
    const mapped = bindingErrorToRpc(id, err);
    write(res, mapped.status, mapped.body);
    return "error";
  }
}
