/**
 * The platform's steps for the core's credential doors (doors.ts
 * PlatformSteps), carried over loopback HTTP.
 *
 * The core's mesh API (mesh-api.ts) runs in its own process. When the AgentMesh
 * platform runs beside it, the doors ask it what only the platform can answer:
 * an account's standing and agent cap, linking and naming an enrolled agent,
 * the naming refusal, advisories, the platform's system agents, whether names
 * are required (its settings store holds the operator's switch), its entries in
 * the capabilities answer, and, for one release, the account store's answer
 * where the ownership record has none.
 * Each is one POST to the platform's API at /internal/keychain/<step>, which
 * answers only loopback callers.
 *
 * `loopbackPlatformSteps` is the doors' side; `keychainStep` is the API's side
 * (since step 10a the platform answers with its own copy of it,
 * platform-shared/keychain-steps.ts; this one stays for a server's own tests)
 * (api-service.ts routes the path to it), kept here so both read one format.
 *
 * A step that fails to answer fails the way the doors fail without it closed:
 * the request is refused with 503 rather than answered as if the platform had
 * said no, except the advisory and the system keys, which the doors already
 * treat as optional.
 */
import type { Advisory, Holder, PlatformSteps } from "./doors.js";
import type { AgentOwnership } from "./stop-rules.js";

const TIMEOUT_MS = 15_000;

/** A step the platform did not answer. The mesh API turns it into a 503. */
export class PlatformStepUnavailable extends Error {
  constructor(step: string, why: string) {
    super(`the platform did not answer ${step}: ${why}`);
    this.name = "PlatformStepUnavailable";
  }
}

/** The doors' side: every step, asked of the platform's API at `base`. */
export function loopbackPlatformSteps(base: string, fetchImpl: typeof fetch = fetch): PlatformSteps {
  const root = base.replace(/\/+$/, "");
  const ask = async <T>(step: string, body: unknown): Promise<T> => {
    let r: Response;
    try {
      r = await fetchImpl(`${root}/internal/keychain/${step}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PlatformStepUnavailable(step, (err as Error).message);
    }
    if (!r.ok) throw new PlatformStepUnavailable(step, `answered ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    enrollCheck: (accountId, agentId) => ask("enroll-check", { account_id: accountId, agent_id: agentId }),
    enrolled: (i) => ask("enrolled", { account_id: i.accountId, agent_id: i.agentId, label: i.label, name: i.name, org: i.org, defer_name: i.deferName }),
    namingRefusal: async (accountId, agentKey) => (await ask<{ refusal: { status: number; body: Record<string, unknown> } | null }>("naming-refusal", { account_id: accountId, agent_key: agentKey })).refusal,
    advisory: async (key) => (await ask<{ advisory: Advisory | null }>("advisory", { key })).advisory,
    systemKeys: async () => (await ask<{ keys: string[] }>("system-keys", {})).keys,
    holderFallback: async (key) => (await ask<{ holder: Holder | null }>("holder", { key })).holder,
    placeFallback: async (keys) => (await ask<{ places: AgentOwnership[] }>("places", { keys })).places,
    capabilities: async () => (await ask<{ capabilities: Record<string, unknown> }>("capabilities", {})).capabilities,
    namesRequired: async () => (await ask<{ on: boolean }>("names-required", {})).on === true,
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The API's side: run one step with the platform's own answers. */
export async function keychainStep(steps: PlatformSteps, step: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const need = (...names: string[]) => names.every((n) => typeof b[n] === "string" && b[n]);
  try {
    switch (step) {
      case "enroll-check":
        if (!need("account_id", "agent_id") || !steps.enrollCheck) break;
        return { status: 200, body: await steps.enrollCheck(str(b.account_id)!, str(b.agent_id)!) };
      case "enrolled":
        if (!need("account_id", "agent_id", "label") || !steps.enrolled) break;
        return {
          status: 200,
          body: await steps.enrolled({
            accountId: str(b.account_id)!, agentId: str(b.agent_id)!, label: str(b.label)!,
            name: str(b.name), org: str(b.org), deferName: b.defer_name === true,
          }),
        };
      case "naming-refusal":
        if (!need("account_id", "agent_key") || !steps.namingRefusal) break;
        return { status: 200, body: { refusal: await steps.namingRefusal(str(b.account_id)!, str(b.agent_key)!) } };
      case "advisory":
        if (!need("key") || !steps.advisory) break;
        return { status: 200, body: { advisory: await steps.advisory(str(b.key)!) } };
      case "system-keys":
        if (!steps.systemKeys) break;
        return { status: 200, body: { keys: await steps.systemKeys() } };
      case "holder":
        if (!need("key") || !steps.holderFallback) break;
        return { status: 200, body: { holder: await steps.holderFallback(str(b.key)!) } };
      case "places": {
        const keys = Array.isArray(b.keys) ? b.keys.filter((k): k is string => typeof k === "string") : null;
        if (!keys || !steps.placeFallback) break;
        return { status: 200, body: { places: await steps.placeFallback(keys) } };
      }
      case "capabilities":
        if (!steps.capabilities) break;
        return { status: 200, body: { capabilities: await steps.capabilities() } };
      case "names-required":
        if (!steps.namesRequired) break;
        return { status: 200, body: { on: await steps.namesRequired() } };
    }
  } catch (err) {
    return { status: 503, body: { error: (err as Error).message } };
  }
  return { status: 404, body: { error: `no step ${step} with those fields` } };
}
