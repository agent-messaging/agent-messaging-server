/**
 * The Agent Card a mesh home serves for an agent that serves the binding
 * (bindings/a2a.md §3): its one interface is the binding's, at the mesh home,
 * then `/agents/`, then the agent's handle or, without one, its agent ID.
 * Pure; the server serves it at that interface URL plus `/agent-card.json`.
 */
import type { Manifest } from "../types/manifest.js";
import { A2A_BINDING_URI, A2A_PROTOCOL_VERSION } from "./binding.js";
import { cardExtensions } from "./extensions.js";
import type { AgentCard, AgentInterface } from "./types.js";

/** Does this manifest say the agent serves the binding? */
export function servesA2ABinding(manifest: Pick<Manifest, "capabilities"> | null | undefined): boolean {
  return Array.isArray(manifest?.capabilities) && manifest!.capabilities.includes(A2A_BINDING_URI);
}

/** The binding's interface for an agent (§3), the name percent-encoded
 *  outside the URL path set (an `@` in a handle is left as it is). */
export function a2aBindingInterface(meshHome: string, agent: string): AgentInterface {
  return {
    url: `${meshHome.replace(/\/+$/, "")}/agents/${encodeURIComponent(agent).replace(/%40/g, "@")}`,
    protocolBinding: A2A_BINDING_URI,
    protocolVersion: A2A_PROTOCOL_VERSION,
  };
}

const ASSUMED_MODES = ["application/json", "text/plain"];

/** The manifest's default offering (§12.1), when it names one it declares. */
export function defaultOfferingOf(manifest: Pick<Manifest, "offerings" | "default_offering">): string | undefined {
  const d = manifest.default_offering;
  return typeof d === "string" && (manifest.offerings ?? []).some((o) => o.id === d) ? d : undefined;
}

/**
 * The card for a manifest. `agent` is what the interface URL names: the
 * agent's handle when it has one, else its agent ID. `more` adds interfaces
 * beside the binding's (an A2A Bridge serving the same agent, §3).
 */
export function a2aCardFromManifest(
  manifest: Manifest,
  opts: { meshHome: string; agent?: string; more?: AgentInterface[] },
): AgentCard {
  const modes = (m: string[] | undefined) => (Array.isArray(m) && m.length ? m : ASSUMED_MODES);
  return {
    name: manifest.name,
    description: manifest.description ?? "",
    supportedInterfaces: [a2aBindingInterface(opts.meshHome, opts.agent ?? manifest.id), ...(opts.more ?? [])],
    ...(manifest.provider ? { provider: { organization: manifest.provider.name, url: manifest.provider.url ?? "" } } : {}),
    version: manifest.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: cardExtensions(undefined, { defaultOffering: defaultOfferingOf(manifest) }),
    },
    defaultInputModes: modes(manifest.default_input_modes),
    defaultOutputModes: modes(manifest.default_output_modes),
    skills: (manifest.offerings ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description ?? "",
      tags: o.tags ?? [],
      ...(o.input_modes ? { inputModes: o.input_modes } : {}),
      ...(o.output_modes ? { outputModes: o.output_modes } : {}),
    })),
  };
}
