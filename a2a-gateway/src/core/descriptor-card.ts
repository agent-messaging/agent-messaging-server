/**
 * The A2A card generated from the agent's Descriptor (EXT-14 §10, MAPPING.md
 * §8.1). The Common Agent Specification makes the signed Descriptor the one
 * description of an agent and every other description a projection of it. So
 * a card for an agent that published a Descriptor takes what it says from the
 * Descriptor itself, not from the registration manifest's copy, and what a
 * card cannot hold (the inputs and outputs of each offering) rides in this
 * extension's params, beside a link to the Descriptor and its digest.
 *
 * Pure functions; the Descriptor's bytes come from the registry (Bridge.
 * agentDescriptorBytes) and the card from manifestToCard.
 */
import { createHash } from "node:crypto";
import type { Manifest } from "../../../sdk-typescript/src/types/manifest.js";
import type { AgentCard } from "./card.js";
import { OVER_A2A_URI } from "./over-a2a.js";

interface DescriptorOffering {
  id?: unknown;
  name?: unknown;
  does?: unknown;
  inputs?: unknown;
  outputs?: unknown;
}

/** `sha256:` and the lowercase hex SHA-256 of the Descriptor's exact bytes. */
export function descriptorDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Where the gateway serves an agent's Descriptor, byte for byte. */
export function descriptorUrl(publicBaseUrl: string, agentId: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/agents/${agentId}/descriptor.json`;
}

const isMediaType = (k: unknown): k is string => typeof k === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(k);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * The card, with what the Descriptor says in place of what the manifest says:
 * the description, the version, and each skill's name, description and
 * modes. A skill is listed only for an offering the agent both describes and
 * declares, since a skill the agent does not answer cannot be called. The
 * extension's params carry each offering's inputs and outputs (and the
 * manifest's schemas, where it declares them) and the Descriptor's link and
 * digest.
 */
export function cardFromDescriptor(
  card: AgentCard,
  manifest: Manifest,
  descriptor: Record<string, unknown>,
  bytes: Uint8Array,
  publicBaseUrl: string,
): AgentCard {
  const offerings = (Array.isArray(descriptor.offerings) ? descriptor.offerings : []) as DescriptorOffering[];
  const declared = new Map(manifest.offerings.map((o) => [o.id, o]));
  const skills: AgentCard["skills"] = [];
  const details: Record<string, Record<string, unknown>> = {};
  for (const d of offerings) {
    const id = str(d.id);
    if (!id || !declared.has(id)) continue;
    const base = card.skills.find((s) => s.id === id);
    const inputs = Array.isArray(d.inputs) ? d.inputs : [];
    const outputs = Array.isArray(d.outputs) ? d.outputs : [];
    const inModes = inputs.map((i) => (i as { kind?: unknown })?.kind).filter(isMediaType);
    const outModes = outputs.map((o) => (o as { kind?: unknown })?.kind).filter(isMediaType);
    skills.push({
      ...(base ?? { id, tags: [] as string[] }),
      id,
      name: str(d.name) ?? base?.name ?? id,
      description: str(d.does) ?? base?.description ?? "",
      ...(inModes.length ? { inputModes: [...new Set([...inModes, "application/json", "text/plain"])] } : {}),
      ...(outModes.length ? { outputModes: [...new Set([...outModes, "application/json", "text/plain"])] } : {}),
    } as AgentCard["skills"][number]);
    const m = declared.get(id) as { input_schema?: unknown; output_schema?: unknown } | undefined;
    details[id] = {
      ...(inputs.length ? { inputs } : {}),
      ...(outputs.length ? { outputs } : {}),
      ...(m?.input_schema !== undefined ? { input_schema: m.input_schema } : {}),
      ...(m?.output_schema !== undefined ? { output_schema: m.output_schema } : {}),
    };
  }
  const extensions = (card.capabilities.extensions ?? []).map((e) =>
    e.uri === OVER_A2A_URI
      ? {
          ...e,
          params: {
            ...(e.params ?? {}),
            descriptor: { url: descriptorUrl(publicBaseUrl, manifest.id), digest: descriptorDigest(bytes) },
            offerings: details,
          },
        }
      : e,
  );
  return {
    ...card,
    description: str(descriptor.does) ?? card.description,
    version: str(descriptor.agent_version) ?? card.version,
    skills: skills.length ? skills : card.skills,
    capabilities: { ...card.capabilities, extensions },
  };
}
