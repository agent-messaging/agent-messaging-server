/**
 * MESH_REQUIRE_NAMES: the platform enforces the naming rule (2026-09-27,
 * docs/no-anonymous-agents-plan.md item 6).
 *
 * One plain setting, read by exact name like MESH_BETA_GATE. When it is "on":
 *
 *   - the node-credential door mints only for agents with a verified name,
 *     and refuses when none on the roster has one;
 *   - the job-credential door refuses an agent with no verified name;
 *   - the registry refuses to register an agent with no verified name, except
 *     a throwaway identity confined to the sandbox (SPEC §4.1, §6.2);
 *   - the hosted gateway does not register an account's agent under its
 *     machine name (web-<account>) until that agent has a verified name.
 *
 * Anything else, unset included, is today's behaviour, plus one log line per
 * agent per door per day naming who WOULD be refused, so the owner can name
 * those agents before the setting goes on. Names and short key prefixes only.
 *
 * A verified name is what the adapter's namedCheck and the SDKs' naming gate
 * accept: the naming service's reverse resolution of the agent's key returns a
 * card whose agentmesh endpoint is this key and whose handle has the standard
 * shape, the agent's name, a dot, and its owner's email. A naming service that
 * does not answer is never taken as a yes (SPEC §6.2).
 */

import { NAMING_STANDARD, UNNAMED_AGENT_CODE } from "./naming-words.js";
import { namingUrl } from "./settings.js";

/** The setting's exact name. */
export const REQUIRE_NAMES_SETTING = "MESH_REQUIRE_NAMES" as const;

/** Whether the naming rule is enforced right now. A read that fails is
 *  "off": the setting is a rollout switch, and failing it on would lock out
 *  every unnamed agent on a blip.
 *
 *  The core reads its own environment. The platform passes its own reader
 *  (its settings store, which falls back to the environment); the platform's
 *  steps behind the core's credential doors answer from that store
 *  (keychain/platform-steps.ts). */
export async function requireNamesOn(read: (k: typeof REQUIRE_NAMES_SETTING) => Promise<string | undefined> = async (k) => process.env[k]): Promise<boolean> {
  try {
    return (await read(REQUIRE_NAMES_SETTING))?.trim() === "on";
  } catch {
    return false;
  }
}

/** The handle shape, for any owner: a name with no dot, a dot, then an email.
 *  The same test the SDKs and the adapter make (sdk-typescript naming-gate.ts). */
export function isStandardShape(h: unknown): h is string {
  return typeof h === "string" && /^[^\s@.]+\.[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(h);
}

export type NameAnswer =
  | { status: "named"; handle: string }
  | { status: "unnamed"; handle: string | null }
  | { status: "unreachable" };

/** The naming service's base URL: PAN_URL or PAN_REGISTRAR, read by exact
 *  name, as the api service reads it. */
export function panBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (env.PAN_URL ?? env.PAN_REGISTRAR ?? namingUrl())?.replace(/\/$/, "");
}

export interface NameLookupOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a "named" answer is kept. A handle does not change often. */
  namedTtlMs?: number;
  /** How long an "unnamed" answer is kept: short, so an agent named a
   *  moment ago is let in at once. Unreachable is never kept. */
  unnamedTtlMs?: number;
  timeoutMs?: number;
}

/** Reverse resolution at the naming service, with a cache.
 *
 *  THE CACHE IS NOT AN OPTIMISATION. The naming service limits reverse
 *  lookups per caller address (PAN_REVERSE_MAX_PER_HOUR, 300 by default), and
 *  every platform service reverse-resolves from one egress address. That
 *  address is listed in the registrar's PAN_REVERSE_TRUSTED_IPS, with its own
 *  ceiling (PAN_REVERSE_TRUSTED_MAX_PER_HOUR, 20000; naming/deploy/deploy.sh,
 *  plan item 14), but the doors here run on every registration and every
 *  credential renewal, so the cache still carries the load: six hours for a
 *  name (a handle rarely changes, and naming here forgets the entry), ten
 *  minutes for no name, and an unanswered lookup is never kept. If the
 *  platform's address changes and the list is not updated, the ceiling falls
 *  back to 300 and this cache is what keeps the doors working. */
export interface NameLookup {
  (agentKey: string): Promise<NameAnswer>;
  /** Drop what is known about this key, after it was named here. */
  forget(agentKey: string): void;
}

export function makeNameLookup(opts: NameLookupOptions = {}): NameLookup {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const namedTtl = opts.namedTtlMs ?? 6 * 3600_000;
  const unnamedTtl = opts.unnamedTtlMs ?? 10 * 60_000;
  const cache = new Map<string, { at: number; answer: NameAnswer }>();
  const lookup = async (agentKey: string): Promise<NameAnswer> => {
    const hit = cache.get(agentKey);
    if (hit && now() - hit.at < (hit.answer.status === "named" ? namedTtl : unnamedTtl)) return hit.answer;
    let answer: NameAnswer;
    try {
      const base = opts.base ?? panBase();
      // No naming service: nobody can be found named. The rule that asks
      // (MESH_REQUIRE_NAMES) is off on a server that offers no naming.
      if (!base) return { status: "unreachable" };
      const r = await fetchImpl(`${base}/api/resolve?agent_id=${encodeURIComponent(agentKey)}`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
      });
      if (r.status === 404) {
        answer = { status: "unnamed", handle: null };
      } else if (!r.ok) {
        answer = { status: "unreachable" };
      } else {
        const doc = (await r.json().catch(() => null)) as {
          card?: { handle?: unknown; endpoints?: Array<{ protocol?: unknown; agent_id?: unknown }> };
        } | null;
        const card = doc?.card;
        const bound = Array.isArray(card?.endpoints)
          && card!.endpoints!.some((e) => e?.protocol === "agentmesh" && e?.agent_id === agentKey);
        const handle = typeof card?.handle === "string" ? card.handle : null;
        answer = bound && isStandardShape(handle) ? { status: "named", handle } : { status: "unnamed", handle };
      }
    } catch {
      answer = { status: "unreachable" };
    }
    if (answer.status !== "unreachable") {
      if (cache.size > 10_000) cache.clear();
      cache.set(agentKey, { at: now(), answer });
    }
    return answer;
  };
  return Object.assign(lookup, { forget: (agentKey: string) => { cache.delete(agentKey); } });
}

/** The process's one lookup, shared by every door in it, so they share one
 *  cache and one slice of the naming service's per-address budget. */
export const sharedNameLookup: NameLookup = makeNameLookup();

/** One would-be refusal, as the operator check lists it. */
export interface WouldRefuse {
  door: string;
  name: string | null;
  key_prefix: string;
  why: string;
  at: string;
}

/**
 * While the setting is off: say once per agent per door per day who WOULD be
 * refused, and remember the recent ones for the operator check. Names and a
 * twelve-character key prefix; never a whole key, never anything secret.
 */
export class WouldRefuseLog {
  private seen = new Map<string, string>();
  private recent: WouldRefuse[] = [];
  constructor(
    private now: () => number = Date.now,
    private log: (line: string) => void = (l) => console.log(l),
    private keep = 500,
  ) {}

  /** Whether this door already logged this key today. A door checks this
   *  BEFORE looking the key up, so an unnamed agent costs one reverse lookup
   *  a day while the setting is off, not one per renewal. */
  notedToday(door: string, agentKey: string): boolean {
    return this.seen.get(`${door}|${agentKey}`) === new Date(this.now()).toISOString().slice(0, 10);
  }

  /** True when this call logged (the first time today for this door and key). */
  note(door: string, agentKey: string, name: string | null | undefined, why: string): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const k = `${door}|${agentKey}`;
    if (this.seen.get(k) === day) return false;
    if (this.seen.size > 20_000) this.seen.clear();
    this.seen.set(k, day);
    const entry: WouldRefuse = {
      door,
      name: name?.trim() ? name.trim().slice(0, 120) : null,
      key_prefix: agentKey.slice(0, 12),
      why,
      at: new Date(this.now()).toISOString(),
    };
    this.recent.push(entry);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    this.log(
      `[require-names] would refuse at ${door} if ${REQUIRE_NAMES_SETTING} were on: ` +
        `${entry.name ?? "(no name)"} ${entry.key_prefix}… (${why})`,
    );
    return true;
  }

  /** The would-be refusals logged recently, newest last. */
  list(): WouldRefuse[] {
    return [...this.recent];
  }
}

/** The process's one log, shared by the doors that run in it. */
export const wouldRefuseLog = new WouldRefuseLog();

/**
 * The refusal for an agent no account holds, where no name can be proposed
 * (a proposal goes to an owner's email, and there is none). Opens with the
 * standard, like every door's refusal (naming-words.ts).
 */
export function unnamedStrangerRefusal(): { error: string; code: string } {
  return {
    error:
      `${NAMING_STANDARD} This agent does not have one yet, and no account holds it, so nothing was issued. ` +
      "Sign in, connect this agent to your account, and name it; then try again.",
    code: UNNAMED_AGENT_CODE,
  };
}

/** The refusal when the naming service could not be asked. Retryable. */
export function namesUncheckedRefusal(): { error: string; code: string } {
  return {
    error: "Nothing was issued: we could not check this agent's name with the naming service just now. Try again in a minute.",
    code: "name_unchecked",
  };
}

/** What one door decided about a set of keys. With the setting off every key
 *  is in `pass`; with it on, only the named ones are. */
export interface DoorNames {
  on: boolean;
  pass: string[];
  unnamed: string[];
  unreachable: string[];
}

/**
 * The check a door runs. `labelOf` gives the agent's name for the log (never
 * its key); `why` says what the door would have done.
 *
 * Off: every key passes at once. In the background, a key not already noted
 * today is looked up, and one with no verified name is noted (one log line,
 * one lookup, per door per day). Nothing waits on that, so a door behaves
 * exactly as it did before the setting existed.
 * On: every key is looked up; only the named pass.
 */
export async function namesAtDoor(
  door: string,
  keys: readonly string[],
  opts: {
    labelOf?: (key: string) => string | null | undefined;
    why?: (key: string) => string;
    lookup?: NameLookup;
    log?: WouldRefuseLog;
    on?: boolean;
  } = {},
): Promise<DoorNames> {
  const lookup = opts.lookup ?? sharedNameLookup;
  const log = opts.log ?? wouldRefuseLog;
  const on = opts.on ?? (await requireNamesOn());
  const why = opts.why ?? (() => "no verified name");
  if (!on) {
    const todo = keys.filter((k) => !log.notedToday(door, k));
    if (todo.length) {
      void (async () => {
        for (const k of todo) {
          const a = await lookup(k);
          if (a.status === "unnamed") log.note(door, k, opts.labelOf?.(k) ?? null, why(k));
        }
      })().catch(() => { /* a log line we could not write; nothing depends on it */ });
    }
    return { on, pass: [...keys], unnamed: [], unreachable: [] };
  }
  const out: DoorNames = { on, pass: [], unnamed: [], unreachable: [] };
  for (const k of keys) {
    const a = await lookup(k);
    if (a.status === "named") out.pass.push(k);
    else if (a.status === "unnamed") out.unnamed.push(k);
    else out.unreachable.push(k);
  }
  return out;
}
