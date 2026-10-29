/**
 * Agent card ↔ mesh manifest mapping (BRIDGE-A2A.md §8). Pure functions.
 */
import type { Manifest, Offering } from "../../../sdk-typescript/src/types/manifest.js";
import type { CallerKind } from "../inbound/identity-store.js";
import { A2A_PROTOCOL_VERSION } from "./jsonrpc.js";
import { overA2ACardExtension } from "./over-a2a.js";

export const BRIDGE_EXTENSION_URI = "mesh://extensions/a2a-bridge/v1";

/** Agent Messaging §5.7: messages for the person behind an agent (§8.4). */
export const AUDIENCE_URI = "mesh://extensions/audience/v1";
export const AUDIENCE_DESCRIPTION = "Messages for the person behind this agent (Agent Messaging §5.7): a marked message reaches the person and never the agent's model.";

/** Whether a manifest declares an extension URI. */
export function declaresExtension(manifest: Pick<Manifest, "extensions">, uri: string): boolean {
  const exts = Array.isArray(manifest.extensions) ? manifest.extensions : [];
  return exts.some((e) => e && typeof e === "object" && (e as { uri?: unknown }).uri === uri);
}
export const BRIDGE_EXTENSION_DESCRIPTION =
  "This agent is bridged from/to the A2A protocol; mesh signatures are the bridge node's vouch, not the far party's.";

/**
 * The §8.3 marker for the INBOUND direction: what a hosted caller identity
 * carries in its manifest, and what every envelope the bridge sends on that
 * caller's behalf carries in `meta.a2a_bridge`.
 *
 * §2.1 rule 2 exists so a consumer can tell bridged traffic from native
 * traffic. Inbound is the direction where that matters most and was met least:
 * a mesh agent receiving one of these requests sees a signature from a key it
 * has never met, and without the marker it has no way to learn that the key is
 * a bridge vouch rather than a peer's own signature.
 *
 * What it deliberately does NOT carry is the account behind the caller. The
 * envelope is delivered to whatever agent was addressed and the manifest is
 * readable by id, so putting an account id in either would make a bridged
 * caller MORE identifiable to strangers than a mesh-native one, whose account
 * appears in no manifest. `caller_ref` is the stable opaque handle instead;
 * resolving it to an account is the bridge operator's `/admin/callers` lookup,
 * against the durable record (inbound/identity-store.ts).
 */
export interface InboundCallerMarker {
  direction: "inbound";
  /** The bridge node whose vouch this caller's traffic rides on (§2.1 rule 1). */
  node: string;
  /** Stable opaque handle for the caller. Resolves, operator-side, to whoever
   *  presented the credential. */
  caller_ref: string;
  /** Whether the caller stands on an account, on the operator's own key, or on
   *  nothing at all — the shape of the accountability, without the identity. */
  caller_kind: CallerKind;
  a2a_protocol_version: string;
}

export function inboundCallerMarker(fields: {
  node: string;
  ref: string;
  kind: CallerKind;
}): InboundCallerMarker {
  return {
    direction: "inbound",
    node: fields.node,
    caller_ref: fields.ref,
    caller_kind: fields.kind,
    a2a_protocol_version: A2A_PROTOCOL_VERSION,
  };
}

/** The general identity-bridge marker (SPEC §4.15): which bridge signs for a
 *  caller that holds no mesh key, the caller's stable opaque reference, how
 *  it was admitted, and which front it came in by. Every envelope the bridge
 *  sends for a caller carries it in `meta.identity_bridge`; A2A traffic
 *  carries `meta.a2a_bridge` beside it, unchanged. */
export const IDENTITY_BRIDGE_URI = "mesh://extensions/identity-bridge/v1";
export const IDENTITY_BRIDGE_DESCRIPTION =
  "This agent reaches the mesh through an identity bridge; mesh signatures on its traffic are the bridge node's vouch, not the caller's own.";

export type BridgeFront = "a2a" | "https" | "mcp";

export interface IdentityBridgeMarker {
  bridge: string;
  caller_ref: string;
  caller_kind: CallerKind;
  front?: BridgeFront;
}

export function identityBridgeMarker(fields: { node: string; ref: string; kind: CallerKind; front?: BridgeFront }): IdentityBridgeMarker {
  return { bridge: fields.node, caller_ref: fields.ref, caller_kind: fields.kind, ...(fields.front ? { front: fields.front } : {}) };
}

/** Whether a caller came in by A2A (and so its traffic also carries the A2A marker). */
export function isA2aKind(kind: CallerKind): boolean {
  return kind === "operator" || kind === "account" || kind === "anonymous" || kind === "pact";
}

/** The manifest a hosted inbound caller identity registers (§2.1 rule 2).
 *
 *  `unlisted`, and with no offerings: this identity answers nothing, so it must
 *  not appear in open discovery as though it did. Reachable by id is exactly
 *  the property the rule needs — a receiver holding an envelope's `from` can
 *  look it up and learn that the signature is a bridge vouch. */
export function inboundCallerManifest(marker: InboundCallerMarker): {
  name: string;
  description: string;
  version: string;
  capabilities: string[];
  offerings: never[];
  visibility: "unlisted";
  interaction: "service";
  extensions: Array<{ uri: string; description: string }>;
  meta: { a2a_bridge?: InboundCallerMarker; identity_bridge: IdentityBridgeMarker };
} {
  const bridged = identityBridgeMarker({ node: marker.node, ref: marker.caller_ref, kind: marker.caller_kind });
  const a2a = isA2aKind(marker.caller_kind);
  return {
    name: `${a2a ? "A2A" : "Bridged"} caller ${marker.caller_ref.slice(0, 8)}`,
    description: a2a
      ? "An external A2A client reaching this mesh through the A2A gateway. " +
        "It serves no offerings; mesh signatures on its traffic are the bridge node's vouch, not the caller's own."
      : "An agent that holds no mesh key, reaching this mesh through an identity bridge with its own identity system's credential. " +
        "Mesh signatures on its traffic are the bridge node's vouch, not the caller's own.",
    version: "1.0.0",
    capabilities: [],
    offerings: [],
    visibility: "unlisted",
    interaction: "service",
    extensions: [
      ...(a2a ? [{ uri: BRIDGE_EXTENSION_URI, description: BRIDGE_EXTENSION_DESCRIPTION }] : []),
      { uri: IDENTITY_BRIDGE_URI, description: IDENTITY_BRIDGE_DESCRIPTION },
    ],
    meta: { ...(a2a ? { a2a_bridge: marker } : {}), identity_bridge: bridged },
  };
}

// ─── A2A agent card (subset — a2a_spec.md §8.5) ──────────────────────

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: string;
    protocolVersion: string;
  }>;
  provider?: { organization: string; url?: string };
  documentationUrl?: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
    extensions?: Array<{ uri: string; description?: string; required?: boolean; params?: Record<string, unknown> }>;
  };
  /** a2a.proto 1.0 `SecurityScheme`s by name: each a oneof, such as
   *  `{httpAuthSecurityScheme: {scheme: "bearer"}}`. */
  securitySchemes?: Record<string, unknown>;
  /** a2a.proto 1.0 `SecurityRequirement`s: any one satisfies the card. */
  securityRequirements?: Array<{ schemes: Record<string, { list: string[] }> }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentCardSkill[];
  signatures?: Array<{ protected: string; signature: string }>;
}

/**
 * The last resort when an agent has said nothing about what it accepts.
 *
 * A2A makes `defaultInputModes` / `defaultOutputModes` REQUIRED on a card, so
 * the bridge cannot decline to answer — but it should be clear about what this
 * value is. It is not the agent's declaration. It is the bridge's assumption on
 * behalf of an agent that made none, and it was until recently stamped on EVERY
 * card the bridge generated, including cards for agents that accept PDFs and
 * images. Now it applies only where `default_input_modes` (§8.5) is absent.
 */
const ASSUMED_MODES = ["application/json", "text/plain"];

/** What this bridge actually accepts from inbound callers. BRIDGE-A2A.md §9:
 *  "A2A `securitySchemes` in generated cards MUST declare exactly what the
 *  bridge accepts" — so this is the bridge's live policy, not a constant. */
export interface CardSecurityPolicy {
  /** A bridge API key (`Authorization: Bearer <key>`) is accepted. */
  apiKey: boolean;
  /** Callers presenting nothing are accepted (the §9 guest tier). */
  anonymous: boolean;
}

/** The same name the agent's own registration and the platform's card use
 *  for this door, so a developer reading either card sees one scheme. */
const BEARER_SCHEME = "a2a-gateway";

/** `securitySchemes` / `securityRequirements` for a policy, in A2A 1.0's
 *  shapes (a2a.proto `SecurityScheme`, `SecurityRequirement`), which replaced
 *  the OpenAPI-style `{type: "http"}` and `security` before 1.0. A requirement
 *  naming no scheme is "no credential needed", so a bridge that accepts both
 *  says so in one list instead of leaving a client to guess. */
function securityFor(policy: CardSecurityPolicy): Pick<AgentCard, "securitySchemes" | "securityRequirements"> {
  const securityRequirements: NonNullable<AgentCard["securityRequirements"]> = [];
  if (policy.apiKey) securityRequirements.push({ schemes: { [BEARER_SCHEME]: { list: [] } } });
  if (policy.anonymous) securityRequirements.push({ schemes: {} });
  if (!policy.apiKey) return { securityRequirements };
  return {
    securitySchemes: {
      [BEARER_SCHEME]: {
        httpAuthSecurityScheme: {
          scheme: "bearer",
          description:
            "A gateway key issued to an AgentMesh account, sent as `Authorization: Bearer <key>`.",
        },
      },
    },
    securityRequirements,
  };
}

// ─── Inbound: mesh manifest → generated agent card (§8.1) ────────────

export function manifestToCard(
  manifest: Manifest,
  publicBaseUrl: string,
  security: CardSecurityPolicy = { apiKey: false, anonymous: true },
): AgentCard {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return {
    ...securityFor(security),
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    // Both bindings (BRIDGE-A2A.md §3, §13). A client picks by binding and
    // version, so the order is not a preference; JSON-RPC stays first only
    // because older clients that read the first entry were written for it.
    supportedInterfaces: [
      {
        url: `${base}/agents/${manifest.id}/rpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
      {
        url: `${base}/agents/${manifest.id}`,
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: manifest.provider
      ? { organization: manifest.provider.name, url: manifest.provider.url }
      : undefined,
    documentationUrl: "https://agentmesh.ai/a2a-bridge.html",
    capabilities: {
      streaming: manifest.offerings.some((s) => s.streaming === true),
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: BRIDGE_EXTENSION_URI,
          description: BRIDGE_EXTENSION_DESCRIPTION,
          // Part of A2A's AgentExtension; a client that checks the card's
          // shape refuses an entry without it (found by PACT's reference
          // client on 2026-10-06). Data only, so never required.
          required: false,
          params: { direction: "inbound", agent_id: manifest.id },
        },
        // Agent Messaging over A2A (EXT-14): a caller with its own key may sign.
        overA2ACardExtension(),
        // Messages for the person (§8.4): listed exactly when the agent declares it.
        ...(declaresExtension(manifest, AUDIENCE_URI) ? [{ uri: AUDIENCE_URI, description: AUDIENCE_DESCRIPTION, required: false }] : []),
      ],
    },
    defaultInputModes: defaulted(manifest.default_input_modes),
    defaultOutputModes: defaulted(manifest.default_output_modes),
    // A2A vocabulary on the A2A wire: a card advertises `skills`, and the
    // entries are this manifest's OFFERINGS (§8.5) in card form.
    skills: manifest.offerings.map((s) => offeringToCardSkill(s, manifest)),
  };
}

/** A declared mode list, or the bridge's assumption when there is none. */
const defaulted = (declared: string[] | undefined): string[] =>
  Array.isArray(declared) && declared.length ? declared : ASSUMED_MODES;

/** Per-offering modes fall back to the agent's card-level defaults BEFORE the
 *  bridge's assumption — that ordering is the whole point of §8.5's card-level
 *  fields. An agent that declares it takes images and then adds an offering without
 *  its own modes means "this one takes images too", not "this one is JSON". */
function offeringToCardSkill(offering: Offering, manifest: Manifest): AgentCardSkill {
  return {
    id: offering.id,
    name: offering.name,
    description: offering.description,
    tags: offering.tags,
    examples: offering.examples?.map((ex) => JSON.stringify(ex.input)),
    inputModes: offering.input_modes ?? defaulted(manifest.default_input_modes),
    outputModes: offering.output_modes ?? defaulted(manifest.default_output_modes),
  };
}

// ─── Outbound: agent card → mesh manifest fields (§8.2) ──────────────

/** The manifest-shaped fields derived from a remote agent card. The bridge
 *  supplies identity fields (id, node vouch) at register time; this returns
 *  everything the card determines. */
export interface CardManifestFields {
  name: string;
  description: string;
  version: string;
  provider?: { name: string; url?: string };
  capabilities: string[];
  /** Mesh offerings (§8.5) derived from the card's A2A `skills`. */
  offerings: Offering[];
  /** Carried straight across from the card's `defaultInputModes` /
   *  `defaultOutputModes` (§8.5 ↔ a2a_spec §8.5). Without this the outbound
   *  direction threw away the one thing the remote agent said about what it
   *  takes, and the mesh manifest the bridge registered claimed nothing. */
  default_input_modes?: string[];
  default_output_modes?: string[];
  extensions: Array<{ uri: string; description?: string }>;
  meta: Record<string, unknown>;
}

export function cardToManifestFields(
  card: AgentCard,
  endpointUrl: string,
  cardSignatureVerified: boolean,
): CardManifestFields {
  const tags = new Set<string>();
  for (const s of card.skills) for (const t of s.tags ?? []) tags.add(t);

  return {
    name: card.name,
    description: card.description,
    version: card.version,
    provider: card.provider
      ? { name: card.provider.organization, url: card.provider.url }
      : undefined,
    capabilities: [...tags],
    ...(card.defaultInputModes?.length ? { default_input_modes: card.defaultInputModes } : {}),
    ...(card.defaultOutputModes?.length ? { default_output_modes: card.defaultOutputModes } : {}),
    offerings: card.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      input_modes: s.inputModes,
      output_modes: s.outputModes,
      streaming: card.capabilities.streaming || undefined,
      // Card examples are prose strings, not {input, output} pairs — dropped
      // rather than guessed at (BRIDGE-A2A.md §8.2).
    })),
    extensions: [
      { uri: BRIDGE_EXTENSION_URI, description: BRIDGE_EXTENSION_DESCRIPTION },
    ],
    meta: {
      a2a_bridge: {
        direction: "outbound",
        endpoint: endpointUrl,
        a2a_protocol_version: A2A_PROTOCOL_VERSION,
        card_signature_verified: cardSignatureVerified,
      },
    },
  };
}

/** Pick the JSON-RPC interface URL from a card (BRIDGE-A2A.md §8.2). */
export function jsonRpcInterfaceUrl(card: AgentCard): string | undefined {
  return card.supportedInterfaces?.find((i) => i.protocolBinding === "JSONRPC")?.url;
}
