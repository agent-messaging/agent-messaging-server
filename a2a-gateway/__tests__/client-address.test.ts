/**
 * FIX 2 — caller identity behind a reverse proxy.
 *
 * Nothing in the bridge read `X-Forwarded-For`, so behind the proxy that fronts
 * it every caller on the internet resolved to the loopback address: one
 * identity, one 30/min bucket, one abuser starving everyone. That breaks
 * BRIDGE-A2A.md §2.1 rule 1.
 *
 * The fix must not overshoot. A header believed unconditionally is worse than
 * the collapse, because a caller could then mint identities — and rate budgets
 * — at will.
 */
import { describe, it, expect } from "vitest";
import { clientAddress, normalizeIp, parseTrustedProxies } from "../src/inbound/client-address.js";

const loopback = parseTrustedProxies(["loopback"]);

describe("normalizeIp", () => {
  it("collapses IPv4-mapped IPv6 to the bare v4", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("strips ports and brackets", () => {
    expect(normalizeIp("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
  });

  it("strips a zone id", () => {
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  it("rejects anything that is not an address", () => {
    expect(normalizeIp("evil.example.com")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});

describe("parseTrustedProxies", () => {
  it("returns null when nothing is configured", () => {
    expect(parseTrustedProxies(undefined)).toBeNull();
    expect(parseTrustedProxies([])).toBeNull();
  });

  it("matches v4 CIDRs and does not match outside them", () => {
    const set = parseTrustedProxies(["10.4.0.0/16"])!;
    expect(set.has("10.4.9.9")).toBe(true);
    expect(set.has("10.5.0.1")).toBe(false);
  });

  it("matches v6 CIDRs, and never crosses families", () => {
    const set = parseTrustedProxies(["2001:db8::/32"])!;
    expect(set.has("2001:db8:1234::9")).toBe(true);
    expect(set.has("2001:db9::1")).toBe(false);
    expect(set.has("10.0.0.1")).toBe(false);
  });

  it("expands `loopback` to both families", () => {
    expect(loopback!.has("127.0.0.1")).toBe(true);
    expect(loopback!.has("127.9.9.9")).toBe(true);
    expect(loopback!.has("::1")).toBe(true);
    expect(loopback!.has("203.0.113.7")).toBe(false);
  });

  it("throws on a typo rather than silently widening or narrowing trust", () => {
    expect(() => parseTrustedProxies(["10.0.0.0/99"])).toThrow(/prefix length/);
    expect(() => parseTrustedProxies(["proxy.internal"])).toThrow(/not an IP address/);
  });
});

describe("clientAddress (BRIDGE-A2A.md §2.1 rule 1)", () => {
  it("ignores X-Forwarded-For from an untrusted peer", () => {
    expect(clientAddress("198.51.100.4", "203.0.113.7", loopback)).toEqual({
      address: "203.0.113.7",
      via: "socket",
    });
  });

  it("ignores X-Forwarded-For when no proxies are configured at all", () => {
    expect(clientAddress("198.51.100.4", "127.0.0.1", null)).toEqual({
      address: "127.0.0.1",
      via: "socket",
    });
  });

  it("believes the header from a trusted peer", () => {
    expect(clientAddress("203.0.113.7", "127.0.0.1", loopback)).toEqual({
      address: "203.0.113.7",
      via: "forwarded",
    });
  });

  it("gives two forwarded callers two different addresses", () => {
    const a = clientAddress("203.0.113.7", "127.0.0.1", loopback).address;
    const b = clientAddress("198.51.100.4", "127.0.0.1", loopback).address;
    expect(a).not.toBe(b);
  });

  it("takes the rightmost non-proxy entry, so a caller-supplied prefix cannot lie", () => {
    // The client sent `X-Forwarded-For: 198.51.100.4`; the proxy appended what it saw.
    expect(clientAddress("198.51.100.4, 203.0.113.7", "127.0.0.1", loopback)).toEqual({
      address: "203.0.113.7",
      via: "forwarded",
    });
  });

  it("skips trusted hops in a proxy chain", () => {
    const set = parseTrustedProxies(["loopback", "10.0.0.0/8"])!;
    expect(clientAddress("203.0.113.7, 10.0.0.5", "127.0.0.1", set).address).toBe("203.0.113.7");
  });

  it("falls back to the socket address when a trusted peer sends no usable header", () => {
    expect(clientAddress(undefined, "127.0.0.1", loopback)).toEqual({
      address: "127.0.0.1",
      via: "socket",
    });
    expect(clientAddress("not-an-ip", "127.0.0.1", loopback)).toEqual({
      address: "127.0.0.1",
      via: "socket",
    });
  });

  it("normalizes forwarded entries so one caller is one identity", () => {
    expect(clientAddress("::ffff:203.0.113.7", "::1", loopback).address).toBe("203.0.113.7");
  });
});
