/**
 * Native Ed25519 for nkeys, where the runtime has it.
 *
 * The nkeys that nats.ws and nats ship sign and verify through tweetnacl,
 * which is plain JavaScript. On the platform's VM (2 shared vCPUs) one verify
 * measured 23 ms through `nats` and 95 ms through `nats.ws`'s bundled copy,
 * against 0.25 ms for node:crypto; one sign measured 26 ms against 0.06 ms
 * (2026-09-28). Every envelope, heartbeat and agent-signed poll is verified,
 * so the platform spent most of its CPU in tweetnacl and hung whenever about
 * 60 nodes signed in at once.
 *
 * `accelerate(nkeys)` returns the same nkeys API whose key pairs sign and
 * verify through node:crypto when it is present (Node 22.3+ exposes it
 * without an import through `process.getBuiltinModule`), and exactly as
 * before everywhere else (a browser, an older Node).
 *
 * Nothing about what is checked changes:
 * - keys are still parsed and checked (prefix and CRC) by nkeys itself before
 *   any native key is made, so a malformed key throws just as it did;
 * - Ed25519 signatures are deterministic, so a native signature is byte for
 *   byte the one tweetnacl makes (a key pair's first native signature is
 *   checked against that before the native path is trusted for it);
 * - a native verify is the same RFC 8032 check. OpenSSL is, if anything,
 *   stricter (it refuses a non-canonical S, which tweetnacl accepts), and no
 *   signature tweetnacl makes is non-canonical.
 */

type Bytes = Uint8Array;

/** The key-pair surface nkeys returns; only the members touched here. */
interface KP {
  getPublicKey(): string;
  getSeed(): Bytes;
  sign(input: Bytes): Bytes;
  verify(input: Bytes, sig: Bytes): boolean;
  clear(): void;
}

interface NkeysLike {
  fromPublic(src: string): unknown;
  fromSeed(src: Bytes): unknown;
  createUser(): unknown;
  createAccount?(): unknown;
  createOperator?(): unknown;
  createServer?(): unknown;
  createCluster?(): unknown;
  createPair?(prefix: never): unknown;
}

type NodeCrypto = typeof import("node:crypto");
type KeyObject = import("node:crypto").KeyObject;

function loadCrypto(): NodeCrypto | null {
  try {
    const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const c = p?.getBuiltinModule?.("node:crypto") as NodeCrypto | undefined;
    if (!c || typeof c.verify !== "function" || typeof c.createPublicKey !== "function") return null;
    // One real round trip, so a runtime that has the module but not Ed25519
    // is found here and not on the first envelope.
    const der = new Uint8Array([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...new Uint8Array(32),
    ]);
    c.createPublicKey({ key: der as never, format: "der", type: "spki" });
    return c;
  } catch {
    return null;
  }
}

let cryptoMod: NodeCrypto | null | undefined;
function nodeCrypto(): NodeCrypto | null {
  if (cryptoMod === undefined) cryptoMod = disabledByEnv() ? null : loadCrypto();
  return cryptoMod;
}

/** MESH_NATIVE_ED25519=0 turns the native path off (for comparison, or if it
 *  ever misbehaves). Read once. */
function disabledByEnv(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return env?.MESH_NATIVE_ED25519 === "0";
  } catch {
    return false;
  }
}

/** True when signatures go through node:crypto. For tests and diagnostics. */
export function nativeEd25519(): boolean {
  return nodeCrypto() !== null;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Bytes {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const v = B32.indexOf(s[i]);
    if (v < 0) throw new Error("nkeys: invalid encoding");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

const SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** Public KeyObjects by nkey string. Bounded: cleared whole when it grows past
 *  the limit, which costs one createPublicKey per key afterwards. */
const PUB_LIMIT = 20_000;
const pubCache = new Map<string, KeyObject>();

function publicKeyObject(c: NodeCrypto, nkey: string): KeyObject {
  const hit = pubCache.get(nkey);
  if (hit) return hit;
  // A public nkey is base32(prefix byte + 32 key bytes + 2 CRC bytes). nkeys
  // has already checked the prefix and the CRC when this is called.
  const raw = base32Decode(nkey);
  if (raw.length !== 35) throw new Error("nkeys: invalid public key");
  const ko = c.createPublicKey({
    key: new Uint8Array([...SPKI_PREFIX, ...raw.subarray(1, 33)]) as never,
    format: "der",
    type: "spki",
  });
  if (pubCache.size >= PUB_LIMIT) pubCache.clear();
  pubCache.set(nkey, ko);
  return ko;
}

function checkArgs(input: Bytes, sig: Bytes): void {
  // The same refusals tweetnacl's detached.verify makes, so a caller sees the
  // same throw for the same bad input.
  if (!(input instanceof Uint8Array) || !(sig instanceof Uint8Array)) throw new TypeError("unexpected type, use Uint8Array");
  if (sig.length !== 64) throw new Error("bad signature size");
}

function nativeVerify(c: NodeCrypto, nkey: string, input: Bytes, sig: Bytes): boolean {
  checkArgs(input, sig);
  return c.verify(null, input, publicKeyObject(c, nkey), sig);
}

const accelerated = new WeakSet<object>();

/** Give one key pair native sign and verify, in place. Returns it. */
export function accelerateKeyPair<T>(kp: T): T {
  const c = nodeCrypto();
  const k = kp as unknown as KP;
  if (!c || !k || typeof k !== "object" || accelerated.has(k)) return kp;
  accelerated.add(k);

  let pub: string | null = null;
  try { pub = k.getPublicKey(); } catch { return kp; }

  const origVerify = k.verify.bind(k);
  const origSign = typeof k.sign === "function" ? k.sign.bind(k) : null;
  const origClear = typeof k.clear === "function" ? k.clear.bind(k) : null;
  const origGetPublicKey = k.getPublicKey.bind(k);
  const publicKey = pub;
  // A seeded pair's getPublicKey() derives the key from the seed with
  // tweetnacl's scalar multiplication on every call (as costly as a sign),
  // and every heartbeat asks for it. A seed's public key never changes.
  k.getPublicKey = (): string => publicKey;

  k.verify = (input: Bytes, sig: Bytes): boolean => {
    try {
      return nativeVerify(c, publicKey, input, sig);
    } catch (err) {
      // Bad arguments throw exactly as before; anything else native could not
      // do goes to the original path, never to a quiet true.
      if (err instanceof TypeError || (err instanceof Error && err.message === "bad signature size")) throw err;
      return origVerify(input, sig);
    }
  };

  if (origSign) {
    // Only a pair holding a seed can sign. The native key is made on first
    // use and trusted only once its signature matches tweetnacl's.
    let priv: KeyObject | null | undefined;
    const privateKey = (input: Bytes): KeyObject | null => {
      if (priv !== undefined) return priv;
      try {
        const seed = new TextDecoder().decode(k.getSeed());
        const raw = base32Decode(seed);
        if (raw.length !== 36) { priv = null; return priv; }
        const ko = c.createPrivateKey({
          key: new Uint8Array([...PKCS8_PREFIX, ...raw.subarray(2, 34)]) as never,
          format: "der",
          type: "pkcs8",
        });
        const mine = new Uint8Array(c.sign(null, input, ko));
        const theirs = origSign(input);
        priv = mine.length === theirs.length && mine.every((b, i) => b === theirs[i]) ? ko : null;
      } catch {
        priv = null;
      }
      return priv;
    };
    k.sign = (input: Bytes): Bytes => {
      const ko = privateKey(input);
      if (!ko) return origSign(input);
      return new Uint8Array(c.sign(null, input, ko));
    };
    if (origClear) {
      k.clear = (): void => {
        priv = null;
        k.sign = origSign;
        k.getPublicKey = origGetPublicKey;
        origClear();
      };
    }
  } else if (origClear) {
    k.clear = (): void => {
      k.getPublicKey = origGetPublicKey;
      origClear();
    };
  }
  return kp;
}

/** The same nkeys API, with every key pair it hands out accelerated. */
export function accelerate<N extends NkeysLike>(nk: N): N {
  if (!nodeCrypto()) return nk;
  const wrap = <F extends (...a: never[]) => unknown>(f: F | undefined): F | undefined =>
    f ? (((...a: Parameters<F>) => accelerateKeyPair(f.apply(nk, a))) as F) : undefined;
  const out = { ...nk } as N;
  out.fromPublic = wrap(nk.fromPublic)!;
  out.fromSeed = wrap(nk.fromSeed)!;
  out.createUser = wrap(nk.createUser)!;
  for (const name of ["createAccount", "createOperator", "createServer", "createCluster", "createPair"] as const) {
    if (typeof nk[name] === "function") (out as Record<string, unknown>)[name] = wrap(nk[name] as never);
  }
  return out;
}
