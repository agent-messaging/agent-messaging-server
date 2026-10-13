import type { BusMessage, Messaging } from "../../storage/index.js";
import type { KeyedStore } from "../../storage/index.js";
import type { Envelope, Manifest, RegisterPayload } from "../../sdk.js";
import {
  createEnvelope,
  childSpan,
  Subjects,
  ErrorCode,
  verifyAttestation,
  attestationExpired,
} from "../../sdk.js";
import { boundKeyOf, idOf, sealEnvelope, type ServiceIdentity } from "../../shared/handler.js";
import { metrics } from "../../shared/ops-events.js";
import { normalizeLegacyManifest, validateEndpoints, validateLimits, withEndpoints, type StoredManifest } from "../endpoints.js";
import { validateDeclarations } from "../declarations.js";
import { withReadableCompliance, withReadableDataUse, withReadableReporting, withStorefront } from "../storefront.js";
import { withReadableListingModel } from "../listing-model.js";
import type { PresenceStore } from "../presence-store.js";
import type { NodeProfileStore } from "../node-profile-store.js";
import type { InboxBuffer } from "../inbox-buffer.js";
import { namesAtDoor, type NameLookup } from "../../shared/require-names.js";
import { NAMING_STANDARD, UNNAMED_AGENT_CODE } from "../../shared/naming-words.js";
import { AGENT_KEY_REVOKED, type AgentKeyRevocationLookup } from "../../shared/agent-key-revocations.js";
import type { AgentStatusLookup } from "../../shared/agent-status.js";

/**
 * Refuse any registration that does not arrive on the connection-bound channel
 * (§4.4 (b), see below). OFF by default because it is only satisfiable once
 * every credential on the deployment is minted with the subject template AND
 * its agents put the credential's own key in `node.id` — turn it on after both,
 * and §4.4 (b) is then genuinely enforced rather than approximated.
 */
const REQUIRE_BOUND_REGISTER = process.env.REGISTRY_REQUIRE_BOUND_REGISTER === "1";

/**
 * What an agent that states no visibility gets.
 *
 * `held` is whatever the shared directory already has for it: undefined on a
 * genuine first registration, and also when the directory could not be read,
 * which is the same answer on purpose. Hiding a row costs a bug report;
 * publishing one costs somebody their privacy.
 */
export const VISIBILITY_ON_SILENCE = (held: Manifest["visibility"] | undefined): Manifest["visibility"] =>
  held ?? "private";

/** How the register handler learns whether names are required, and asks the
 *  naming service. Injected so a test can say "on" and answer for the naming
 *  service without either; production leaves both to shared/require-names.ts
 *  (MESH_REQUIRE_NAMES, read live, and the process's shared lookup). */
export interface RegisterNaming {
  on?: () => Promise<boolean>;
  lookup?: NameLookup;
}

/**
 * How long a registration's answer waits for the agent's mailbox to be made.
 * Making one is a few round trips to the broker and the database; this bound
 * is for a broker that is down or stalled, and stays well inside the SDK's
 * five-second register timeout so the answer still arrives.
 */
export const MAILBOX_WAIT_MS = 2000;

/** Wait for the mailbox, up to MAILBOX_WAIT_MS. Past that the registration is
 *  answered anyway and the mailbox is finished in the background; the agent's
 *  node finds it on its next pass. */
async function mailboxMade(making: Promise<void>, agentId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), MAILBOX_WAIT_MS);
  });
  const outcome = await Promise.race([making.then(() => "made" as const), late]);
  clearTimeout(timer);
  if (outcome === "late") {
    console.error(
      `[registry] the mailbox for ${agentId.slice(0, 12)}… was not made within ${MAILBOX_WAIT_MS} ms; ` +
        `the registration is answered and the mailbox is still being made`,
    );
  }
}

export async function handleRegister(
  env: Envelope,
  kv: KeyedStore,
  nc: Messaging,
  serviceId: ServiceIdentity,
  cache: Map<string, Manifest>,
  presence: PresenceStore,
  profiles: NodeProfileStore,
  inboxBuffer?: InboxBuffer,
  msg?: BusMessage,
  naming?: RegisterNaming,
  revocations?: AgentKeyRevocationLookup,
  /** The kill switch's per-agent status: a terminated agent never registers
   *  again (docs/kill-switch-plan.md item 5). */
  statuses?: AgentStatusLookup,
): Promise<Envelope> {
  let manifest = env.payload as RegisterPayload & StoredManifest;

  // Deprecation window (§8.5): registrants on pre-rename SDKs say `skills`.
  // Normalized HERE, on the way in, so the stored manifest — what discovery,
  // the market and the storefront all read — carries one vocabulary.
  // (Registrant-supplied offering_details are discarded by withStorefront
  // below regardless of which spelling they arrived under.)
  manifest = normalizeLegacyManifest(manifest);

  const reject = (code: ErrorCode, message: string) =>
    createEnvelope({
      type: "respond",
      from: idOf(serviceId),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: { code, message, retryable: false },
    });

  // Validate: from must match manifest.id
  if (!manifest?.id || env.from !== manifest.id) {
    return reject(
      ErrorCode.IDENTITY_MISMATCH,
      `Envelope 'from' (${env.from}) does not match manifest.id (${manifest?.id})`,
    );
  }

  // §5.3: a revoked agent key does not come back by registering again. A store
  // that cannot be read does not block the registration.
  const revoked = revocations ? await revocations.get(manifest.id).catch(() => null) : null;
  if (revoked) {
    return createEnvelope({
      type: "respond",
      from: idOf(serviceId),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message: "This agent key has been revoked. Its owner moves the agent to a new key; this one cannot register again.",
        details: {
          reason: AGENT_KEY_REVOKED,
          revoked_at: revoked.at,
          ...(revoked.replaced_by ? { replaced_by: revoked.replaced_by } : {}),
        },
        retryable: false,
      },
    });
  }

  // The kill switch: a terminated agent does not come back by registering.
  // Its key is revoked too (above); this also holds where the revocation
  // store could not be read.
  const stopped = statuses ? await statuses.get(manifest.id).catch(() => null) : null;
  if (stopped?.status === "terminated") {
    return createEnvelope({
      type: "respond",
      from: idOf(serviceId),
      to: env.from,
      in_reply_to: env.id,
      trace: childSpan(env.trace),
      error: {
        code: ErrorCode.UNAUTHORIZED,
        message: "This agent was terminated, so it cannot register again. Its owner can make a new agent with a new key.",
        details: { reason: "agent_terminated", terminated_at: stopped.since },
        retryable: false,
      },
    });
  }

  // Validate: required fields
  if (!manifest.name || !manifest.endpoint) {
    return reject(ErrorCode.INVALID_MANIFEST, "Manifest missing required fields: name, endpoint");
  }

  // §8.1/§14.4: the endpoint subjects this manifest publishes are what callers
  // will address VERBATIM, so they must be well-formed concrete subjects — and
  // a subject in another agent's `mesh.agent.<key>.…` namespace is an identity
  // claim the registrant does not hold (it would redirect that agent's
  // callers), refused as such. Covers both a supplied `endpoints` block and
  // the `endpoint` field the block is stamped from.
  const endpointsProblem = validateEndpoints(manifest);
  if (endpointsProblem) {
    return reject(
      endpointsProblem.code === "foreign" ? ErrorCode.IDENTITY_MISMATCH : ErrorCode.INVALID_MANIFEST,
      endpointsProblem.message,
    );
  }

  // §8.1 `limits`: passes through untouched when well-formed; a malformed cap
  // is refused rather than stored, because senders pre-flight against it
  // (§6.4b) and would inherit the garbage.
  const limitsProblem = validateLimits(manifest);
  if (limitsProblem) {
    return reject(ErrorCode.INVALID_MANIFEST, limitsProblem);
  }

  // §8.8 `works_with` and §8.5.1's `credential` need: both are read by
  // strangers pre-admission, so a shape a renderer cannot show honestly is
  // refused here, where the operator sees the refusal. Nothing about TRUTH is
  // checked — no domain verification, no affiliation, no allow-list — because
  // no machinery for that exists and pretending otherwise would be the false
  // assurance the fields are meant to avoid.
  const declarationsProblem = validateDeclarations(manifest);
  if (declarationsProblem) {
    return reject(ErrorCode.INVALID_MANIFEST, declarationsProblem);
  }

  // 0.2: verify the node vouch (§4.4) — the manifest must be attested by a node,
  // the attestation must bind THIS agent, and its signature must verify.
  const node = manifest.node;
  if (!node?.id || !node.attestation) {
    return reject(ErrorCode.INVALID_MANIFEST, "Manifest missing node vouch (node.attestation)");
  }
  if (node.attestation.node !== node.id || node.attestation.agent !== manifest.id) {
    return reject(ErrorCode.UNAUTHORIZED, "Node attestation does not bind this node→agent");
  }
  if (!verifyAttestation(node.attestation, manifest.id)) {
    return reject(ErrorCode.UNAUTHORIZED, "Node attestation signature is invalid");
  }
  // §9.7: "A verifier MUST reject an attestation whose expires_at has passed."
  // verifyAttestation deliberately leaves freshness to its caller — this is the
  // caller. Without this the reaper is the only expiry check, and it runs on a
  // 10-minute sweep, so re-registering faster than that kept a lapsed vouch
  // (and a revoked agent) alive indefinitely.
  if (attestationExpired(node.attestation)) {
    return reject(ErrorCode.UNAUTHORIZED, "Node attestation has expired; re-vouch and register again");
  }

  // ── §4.4 (b): binding the vouch to the connection that registered ──────
  // §4.4 requires the registry to verify BOTH (a) the attestation signature and
  // (b) that "the registering connection's identity is that node". (a) is done
  // above. (b) is NOT verifiable from a core NATS message: a subscriber gets the
  // subject, the reply subject, the payload and headers, and nothing about the
  // publisher's authenticated user — so `node.id` is a claim, proven only by
  // possession of the node key (the attestation signature), never by the
  // connection. Anyone may therefore mint a fresh keypair and register as its
  // own node; that is the standing gap, and it is a transport gap.
  //
  // The one identity a broker CAN pin to a credential is the subject: a user JWT
  // minted with `allow_pub: "mesh.registry.register.<its own key>"` cannot
  // publish under another key's token. The registry listens on that channel too,
  // so where a deployment mints credentials that way the trailing token is the
  // connection's key. On the plain subject there is no such token and nothing to
  // check, which is exactly what REQUIRE_BOUND_REGISTER refuses.
  const boundKey = boundKeyOf(msg, Subjects.REGISTRY_REGISTER);
  if (REQUIRE_BOUND_REGISTER) {
    if (!boundKey) {
      return reject(
        ErrorCode.UNAUTHORIZED,
        `this registry requires connection-bound registration: publish to ` +
          `${Subjects.REGISTRY_REGISTER}.<your credential's public key> (§4.4)`,
      );
    }
    if (node.id !== boundKey) {
      return reject(
        ErrorCode.UNAUTHORIZED,
        `node.id must be the registering connection's own key (§4.4: the vouching node IS the connection)`,
      );
    }
  } else if (boundKey && node.id !== boundKey) {
    // Not fatal here (the token is only a guarantee under the mint template),
    // but worth surfacing: a vouch naming a node other than the connection is
    // the shape §4.4 (b) exists to refuse.
    console.warn(
      `[registry] ${manifest.id.slice(0, 12)}… registered on a bound channel as ${boundKey.slice(0, 12)}… ` +
        `but vouched by node ${node.id.slice(0, 12)}…`,
    );
  }

  // Ownership (§9.x). Defaults to the node (already vouched). An explicit owner
  // key must carry an owner attestation binding owner→agent, so an agent can't
  // claim another operator's owner to see their hidden agents.
  const owner = manifest.owner ?? node.id;
  if (owner !== node.id) {
    const oa = manifest.owner_attestation;
    if (!oa || oa.node !== owner || oa.agent !== manifest.id) {
      return reject(ErrorCode.UNAUTHORIZED, "Owner attestation does not bind this owner→agent");
    }
    if (!verifyAttestation(oa, manifest.id)) {
      return reject(ErrorCode.UNAUTHORIZED, "Owner attestation signature is invalid");
    }
    // Same expiry rule as the node vouch (§9.7): an owner claim is valid for
    // exactly as long as it says it is.
    if (attestationExpired(oa)) {
      return reject(ErrorCode.UNAUTHORIZED, "Owner attestation has expired; re-issue it and register again");
    }
  }
  // Normalize so discovery can always scope by a populated owner + visibility.
  manifest.owner = owner;
  //
  // WHAT SILENCE MEANS, and it depends on whether we have met this agent.
  //
  // A FIRST registration that says nothing is private. The owner, 2026-09-20: "a
  // person builds an agent and its access is just theirs. Later, they can move
  // it to org, or move it to public." Publishing should be something somebody
  // did, not something that happened because a field was missing.
  //
  // A RE-registration that says nothing keeps what it had. This half is not
  // politeness, it is the difference between a default and an outage: 114
  // agents are registered right now, most of them written before this field
  // meant anything, and they re-register on every restart. Defaulting those to
  // private would take every one of them out of discovery the next time it
  // rebooted, with nothing in any log saying why.
  //
  // Read from the SHARED directory, not the local cache. There is more than
  // one registry instance and each keeps its own cache, so an agent that first
  // registered on instance A and later re-registers on instance B would look
  // brand new to B and be flipped from public to private on a restart nobody
  // connected to it. registry-coherence.test.ts caught exactly that.
  if (manifest.visibility === undefined) {
    let held: Manifest["visibility"];
    try {
      const prior = await kv.get(manifest.id);
      if (prior?.value?.length) {
        held = (JSON.parse(new TextDecoder().decode(prior.value)) as Manifest).visibility;
      }
    } catch {
      // A directory we cannot read is not evidence that this agent is new, and
      // guessing "new" here publishes nothing and hides something. Fall through
      // to private, which is the same answer as a genuine first registration.
    }
    manifest.visibility = VISIBILITY_ON_SILENCE(held);
  }
  // Sandbox agents are never listed in open discovery (§1.3, §9.7). ENFORCED,
  // not honor-system: an agent whose host the operator attested as
  // trust_tier=sandbox is marked sandbox regardless of what it self-declares.
  //
  // Checked against every key this registration PROVED possession of, not just
  // the self-asserted `node.id`: the envelope signature proves `env.from`, the
  // node attestation proves `node.id`, the owner attestation proves `owner`, and
  // a bound subject (above) proves the connection key. A guest-pool credential
  // therefore stays clamped even if it names a freshly minted key as its node —
  // the SDK path makes the agent key the credential key, so `env.from` gives it
  // away. What no payload check can catch is a caller that abandons its pool key
  // entirely and registers wholly fresh keys: only the transport sees that
  // (§4.4 (b) above), which is why the clamp is not fully closed here.
  const provenKeys = [env.from, node.id, owner, boundKey].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  if (provenKeys.some((k) => profiles.get(k)?.trust_tier === "sandbox")) {
    manifest.sandbox = true;
  }
  // Clamp any public/default visibility down to unlisted. Sandbox agents stay
  // reachable by ID and to their owner.
  if (manifest.sandbox && manifest.visibility === "public") {
    manifest.visibility = "unlisted";
    console.log(`[registry] sandbox agent ${manifest.id} clamped to unlisted`);
  }

  // SPEC §6.2, no anonymous agents (2026-09-27, plan item 6): the registry
  // refuses an agent with no verified name, except a throwaway identity
  // confined to the sandbox (§4.1), which is what `sandbox` above marks.
  // Enforced only while MESH_REQUIRE_NAMES is "on"; until then the agents
  // that would be refused are logged once a day, by name, so they can be
  // named first. A naming service that does not answer is never a yes.
  if (!manifest.sandbox && naming) {
    const on = naming.on ? await naming.on().catch(() => false) : undefined;
    const names = await namesAtDoor("registry", [manifest.id], {
      labelOf: () => manifest.name,
      ...(on !== undefined ? { on } : {}),
      ...(naming.lookup ? { lookup: naming.lookup } : {}),
    });
    if (names.on && !names.pass.length) {
      const unreachable = names.unreachable.length > 0;
      console.log(`[registry] refused ${manifest.name} ${manifest.id.slice(0, 12)}…: ${unreachable ? "the naming service did not answer" : "no verified name"}`);
      return createEnvelope({
        type: "respond",
        from: idOf(serviceId),
        to: env.from,
        in_reply_to: env.id,
        trace: childSpan(env.trace),
        error: {
          code: ErrorCode.UNAUTHORIZED,
          message: unreachable
            ? "Not registered: we could not check this agent's name with the naming service just now. Try again in a minute."
            : `${NAMING_STANDARD} This agent does not have one yet, so it was not registered. Name it (agentmesh join, or Connect to AgentMesh in the app), then register again.`,
          details: { reason: unreachable ? "name_unchecked" : UNNAMED_AGENT_CODE },
          retryable: unreachable,
        },
      });
    }
  }

  // §8.2: registry-populated `endpoints` — stamped from `endpoint` when the
  // registrant did not supply the block (and `inbox` filled in when a supplied
  // block lacks it), so the STORED manifest always resolves (§14.4). Validated
  // above, so everything stamped here is well-formed and the agent's own.
  manifest = withEndpoints(manifest);

  // §8.5.2: an offering's `reporting` is the one declaration validated rather
  // than refused or passed through — a closed vocabulary feeding an integer
  // comparison. Unknown level, malformed cadence, check_ins without `every`,
  // or `every` below check_ins: the reporting field is dropped from the stored
  // manifest (and so from the storefront below), never served. Per-field: the
  // offering itself survives, unlike the §8.8/§8.5.1 refusals above, because
  // an unreadable advertisement is a nothing, not a danger.
  manifest = withReadableReporting(manifest);

  // §8.10: the card-level `data_use` declaration, validated the same way but
  // dropped WHOLE when unreadable — a privacy claim served in part misleads
  // more than none at all, so unlike reporting's per-field drop there is no
  // salvaging the readable half. A readable declaration is normalized to
  // exactly the §8.10 members; the manifest itself survives either way.
  manifest = withReadableDataUse(manifest);

  // §8.11: the card-level `compliance` declarations, under `data_use`'s
  // family rule — one unreadable entry (a non-token standard, a blank scope,
  // a malformed attestation) drops the WHOLE member, because a partially
  // readable claims list shows a posture nobody declared. A readable one is
  // normalized to exactly the §8.11 members; the manifest survives either way.
  manifest = withReadableCompliance(manifest);

  // §8.12: the listing-model declarations — audience, coverage, edge, serves,
  // origin, acts, parties. Per-MEMBER drop rather than whole, which departs
  // from the two above on purpose: `data_use` drops whole because a surviving
  // promise flatters the operator when its neighbour is lost, and nothing here
  // has that property — losing `touches` leaves `for` exactly as true as it
  // was. `acts` is the one that still drops whole, because actions with no
  // statement of whether the agent acts at all are incoherent, not partial.
  manifest = withReadableListingModel(manifest);

  // §8.7: materialize the storefront's offering descriptors from the agent's own
  // declared offerings, selected by the IDs in `public.offerings`. Derived, never
  // accepted from the registrant, for the same reason `owner` isn't: a field
  // the registry can compute is a field a registrant should not be able to lie
  // about. See storefront.ts for why this is not an operator-written block.
  manifest = withStorefront(manifest);

  // Store the manifest — durable description only, no liveness fields.
  const data = new TextEncoder().encode(JSON.stringify(manifest));
  await kv.put(manifest.id, data);
  cache.set(manifest.id, manifest);

  // Offline-delivery buffer (§16.4): a registered agent gets a mailbox;
  // sandbox agents deliberately do not (live-only contract). The answer waits
  // for the mailbox, because once an agent is told it is registered, a message
  // to it must be kept. On JetStream the mailbox stream is what captures the
  // inbox subject; on RabbitMQ it is the only queue bound to it besides the
  // node's live subscription, and a message published while neither exists is
  // dropped by the exchange (binding document §6.1). The wait is bounded, and
  // `ensure` never throws, so registration still never fails or hangs because
  // the buffer tier is down.
  if (inboxBuffer) {
    if (manifest.sandbox) void inboxBuffer.remove(manifest.id);
    else await mailboxMade(inboxBuffer.ensure(manifest.id), manifest.id);
  }

  // Seed presence for the hosting node (liveness lives in the presence store).
  presence.update(node.id, "online");

  // Populate the node's DECLARED profile (§9.7), if the node supplied one. Only
  // declared attributes are accepted here; attested attributes (trust_tier,
  // role) come from the operator and any existing values are preserved.
  if (node.profile) {
    const existing = profiles.get(node.id);
    profiles.set({
      node: node.id,
      trust_tier: existing?.trust_tier,
      role: existing?.role,
      availability_class: node.profile.availability_class,
      reachability: node.profile.reachability,
      capacity: node.profile.capacity,
      // EXT-1 device-profile declared keys (advisory, like all declared attrs)
      platform: node.profile.platform,
      os_version: node.profile.os_version,
      client: node.profile.client,
      device_class: node.profile.device_class,
    });
  }

  // Emit registration event
  const eventEnv = createEnvelope({
    type: "emit",
    from: idOf(serviceId),
    payload: {
      domain: "registry",
      event_type: "agent_registered",
      data: {
        agent_id: manifest.id,
        name: manifest.name,
        node: node.id,
        // Lets consumers (e.g. catalog auto-listing) treat ephemeral
        // sandbox registrations differently from durable ones.
        sandbox: manifest.sandbox === true,
      },
    },
  });
  nc.publish(Subjects.event("registry.agent_registered"), sealEnvelope(eventEnv, serviceId));

  console.log(`[registry] registered agent: ${manifest.id} (${manifest.name}) on node ${node.id}`);

  // The catalog sync is the platform's: it listens for the event above and
  // reads the stored manifest (api/catalog-sync.ts). A core with no platform
  // tells nobody.

  // Durable history. The bus event above is for LIVE subscribers and is gone the
  // moment nobody is listening; this is what makes "how many agents registered
  // yesterday" answerable, and it was the one number in the daily operator stats
  // with no source at all. `sandbox` matters in the tally: guest agents are
  // throwaway and counting them alongside real registrations would overstate
  // growth by however many people clicked the demo.
  metrics.event({
    kind: "agent_register",
    actor: manifest.id,
    target: node.id,
    meta: {
      name: manifest.name,
      sandbox: manifest.sandbox === true,
      offerings: manifest.offerings?.length ?? 0,
    },
  });

  return createEnvelope({
    type: "respond",
    from: idOf(serviceId),
    to: env.from,
    in_reply_to: env.id,
    trace: childSpan(env.trace),
    payload: {
      status: "registered",
      agent_id: manifest.id,
      registered_at: new Date().toISOString(),
    },
  });
}
