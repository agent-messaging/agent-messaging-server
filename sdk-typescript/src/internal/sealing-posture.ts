/**
 * §8.9 `sealing` — the one place the default is decided.
 *
 * ## Why this is not a boolean somebody flips
 *
 * Sealing has existed since 0.8.0 and nobody uses it, because the honest
 * default is cleartext and a default nobody changes is the real behaviour of
 * the system. The obvious fix is to turn sealing on globally. That fix breaks
 * the mesh: a sender that starts sealing to every agent holding an
 * `encryption_key` will send ciphertext to handlers that have never opened a
 * sealed payload, and the failure is silent at the sender and unreadable at the
 * receiver. Live agents, including a production fleet, are in exactly that
 * position — they publish a key so people can invite them to sealed rooms, and
 * their request handlers know nothing about it.
 *
 * So the switch is not global and it is not a boolean. It is a manifest field
 * an older implementation never writes, which makes the compatibility argument
 * structural rather than a promise: a manifest registered before this code
 * existed carries no `sealing`, senders read that as "has not said", and
 * absolutely nothing about that agent's traffic changes. An agent's posture can
 * only ever move when its own operator re-registers it.
 *
 * ## The rule
 *
 * The default is derived from what the agent ALREADY declared about the work it
 * does, so the vendor case is sealed without anybody remembering to ask:
 *
 *  1. An explicit choice from the operator wins, including `"none"`, which is
 *     how an agent that would otherwise qualify opts out.
 *  2. No encryption key, no posture. A posture is a promise about reading, and
 *     an agent with no key cannot keep it.
 *  3. An offering with a `credential` need (§8.5.1) earns `"required"`. That
 *     declaration means the agent will ask a caller to sign in to somebody's
 *     account at a third party, which is the one thing here that must not cross
 *     a broker in the clear.
 *  4. Otherwise `works_with` (§8.8) earns `"preferred"`. The agent moves a
 *     caller's material through a system it does not own, which is usually the
 *     caller's business data and sometimes a public weather feed — so it earns
 *     the posture that seals when both ends can and refuses nobody.
 *  5. Otherwise nothing.
 *
 * Both signals are declarations the agent makes about itself, which is the
 * point: an agent that tells buyers it plugs into their CRM has said enough to
 * know how its inbox should be treated, and it should not also have to find a
 * separate encryption setting.
 */
import type { Manifest, SealingPosture } from "../types/manifest.js";

/** What an operator may ask for. `"none"` is an explicit refusal of a posture
 *  the derivation would otherwise apply, and is never emitted on the wire. */
export type SealingChoice = SealingPosture | "none";

/** The shape the rule reads. A subset of the manifest so the registry and the
 *  storefront can apply the identical rule to a stored record. */
export interface SealingInputs {
  encryption_key?: string;
  works_with?: Manifest["works_with"];
  offerings?: Manifest["offerings"];
}

/** Whether any offering declares a §8.5.1 `credential` need: the agent will ask
 *  the caller to sign in to a named third-party service. */
export function declaresCredentialNeed(offerings: SealingInputs["offerings"]): boolean {
  for (const offering of Array.isArray(offerings) ? offerings : []) {
    for (const need of Array.isArray(offering?.needs) ? offering.needs : []) {
      const service = (need as { credential?: unknown } | null)?.credential;
      if (typeof service === "string" && service.trim().length > 0) return true;
    }
  }
  return false;
}

/**
 * The §8.9 posture for a registration. `undefined` means "declare nothing",
 * which is the same thing every pre-existing manifest says.
 */
export function derivedSealing(
  inputs: SealingInputs,
  explicit?: SealingChoice,
): SealingPosture | undefined {
  if (explicit === "none") return undefined;
  if (explicit === "required" || explicit === "preferred") {
    // Still gated on the key: declaring a posture an agent cannot honour would
    // make the registry refuse the whole registration (§8.9), which is a
    // confusing way to punish an operator for asking for the safer thing.
    return inputs.encryption_key ? explicit : undefined;
  }
  if (!inputs.encryption_key) return undefined;
  if (declaresCredentialNeed(inputs.offerings)) return "required";
  if (Array.isArray(inputs.works_with) && inputs.works_with.length > 0) return "preferred";
  return undefined;
}
