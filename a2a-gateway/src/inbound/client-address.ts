/**
 * Which address identifies an inbound caller.
 *
 * BRIDGE-A2A.md §2.1 rule 1 requires each distinct external party to get its
 * own hosted mesh identity. The socket peer address is the only client fact the
 * kernel gives us — but behind a reverse proxy the peer IS the proxy, so every
 * caller on the internet collapses into one identity sharing one rate bucket,
 * and one abuser starves everyone.
 *
 * `X-Forwarded-For` carries the real client, but it is a request header: any
 * caller can write it. Believing it unconditionally is strictly WORSE than the
 * collapse it fixes, because a caller could then mint a fresh identity — and a
 * fresh rate budget — on every request, simply by varying a string.
 *
 * So: the header is believed only when the immediate peer is an address the
 * operator listed as a proxy they run. Otherwise the socket address stands.
 * Nothing here ever trusts a header on its own.
 */

export interface ProxySet {
  /** True when this already-normalized address is a configured trusted proxy. */
  has(ip: string): boolean;
  /** False when the operator configured no proxies at all. */
  readonly configured: boolean;
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Reduce an address to one canonical spelling, so `::ffff:198.51.100.4`,
 * `198.51.100.4:5678` and `198.51.100.4` do not become three identities. Returns null
 * for anything that is not an IP address — a forwarded entry the bridge cannot
 * parse is an entry it must not act on.
 */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (!ip) return null;

  // "[::1]:443" / "[::1]" — bracketed form always carries an optional port.
  if (ip.startsWith("[")) {
    const close = ip.indexOf("]");
    if (close < 0) return null;
    ip = ip.slice(1, close);
  } else if ((ip.match(/:/g)?.length ?? 0) === 1) {
    // "198.51.100.4:5678" — a single colon can only be a v4 host:port, never v6.
    ip = ip.slice(0, ip.indexOf(":"));
  }

  // Scope/zone id ("fe80::1%eth0") is host-local and never identifies a caller.
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);

  ip = ip.toLowerCase();

  // IPv4-mapped IPv6 is the same host as the bare v4 (Node hands these out on
  // dual-stack listeners), so collapse it before anything compares strings.
  if (ip.startsWith("::ffff:") && V4.test(ip.slice(7))) ip = ip.slice(7);

  return ipToBytes(ip) ? ip : null;
}

/** Big-endian bytes for a normalized address: 4 for v4, 16 for v6. */
function ipToBytes(ip: string): Uint8Array | null {
  const v4 = ip.match(V4);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    return Uint8Array.from(octets);
  }
  return v6ToBytes(ip);
}

function v6ToBytes(ip: string): Uint8Array | null {
  if (!ip.includes(":")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

interface Cidr {
  bytes: Uint8Array;
  bits: number;
}

function inCidr(ip: Uint8Array, cidr: Cidr): boolean {
  // A v4 address is never inside a v6 range, and vice versa.
  if (ip.length !== cidr.bytes.length) return false;
  let bits = cidr.bits;
  for (let i = 0; i < ip.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((ip[i] & mask) !== (cidr.bytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

/**
 * Parse the operator's trusted-proxy list. Accepts literal addresses, CIDR
 * ranges, and the alias `loopback` (the common case: a proxy on the same host).
 *
 * An entry that cannot be parsed THROWS. A trust list is a security decision;
 * silently dropping a typo would either widen trust or narrow it, and the
 * operator would learn which only from an incident.
 */
export function parseTrustedProxies(spec: readonly string[] | undefined): ProxySet | null {
  const tokens = (spec ?? []).map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  const cidrs: Cidr[] = [];
  for (const token of tokens) {
    if (token.toLowerCase() === "loopback") {
      cidrs.push(toCidr("127.0.0.0/8", token), toCidr("::1/128", token));
      continue;
    }
    cidrs.push(toCidr(token, token));
  }

  return {
    configured: true,
    has(ip: string): boolean {
      const bytes = ipToBytes(ip);
      if (!bytes) return false;
      return cidrs.some((c) => inCidr(bytes, c));
    },
  };
}

function toCidr(token: string, original: string): Cidr {
  const slash = token.indexOf("/");
  const addr = slash < 0 ? token : token.slice(0, slash);
  const normalized = normalizeIp(addr);
  if (!normalized) throw new Error(`trusted proxy "${original}": "${addr}" is not an IP address`);
  const bytes = ipToBytes(normalized)!;
  if (slash < 0) return { bytes, bits: bytes.length * 8 };
  const bits = Number(token.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8) {
    throw new Error(`trusted proxy "${original}": prefix length must be 0..${bytes.length * 8}`);
  }
  return { bytes, bits };
}

export interface ResolvedClient {
  /** The address that identifies this caller. Never empty. */
  address: string;
  /** Where it came from — `forwarded` only ever happens behind a trusted peer. */
  via: "socket" | "forwarded";
}

/**
 * Resolve the caller's address from the socket peer and, only where the peer is
 * a trusted proxy, `X-Forwarded-For`.
 *
 * XFF is append-ordered: each hop appends the address it received from, so the
 * RIGHTMOST entry is what the last proxy actually saw. A caller that pre-seeds
 * the header only adds entries to the LEFT of that. Walking right to left and
 * stopping at the first entry that is not itself a trusted proxy therefore
 * lands on the real client for any chain length, and cannot be moved by a
 * caller-supplied prefix.
 */
export function clientAddress(
  forwardedFor: string | undefined,
  peerAddress: string | undefined,
  proxies: ProxySet | null,
): ResolvedClient {
  const peer = normalizeIp(peerAddress) ?? "unknown";
  if (!proxies?.configured || !proxies.has(peer)) return { address: peer, via: "socket" };

  const entries = (forwardedFor ?? "")
    .split(",")
    .map((e) => normalizeIp(e))
    .filter((e): e is string => e !== null);

  for (let i = entries.length - 1; i >= 0; i--) {
    if (!proxies.has(entries[i])) return { address: entries[i], via: "forwarded" };
  }
  // Every hop was a trusted proxy, or the header was absent/unparseable. The
  // leftmost entry is the best available claim; with nothing at all, the proxy
  // itself stands in — which is the pre-fix behaviour, and a misconfiguration
  // the operator should see rather than a silently invented identity.
  if (entries.length > 0) return { address: entries[0], via: "forwarded" };
  return { address: peer, via: "socket" };
}
