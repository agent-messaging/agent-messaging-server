// Node-credential renewal (§4.8).
//
// The layer below the vouch, and the one whose lapse is harder to recover from.
// An expired vouch costs discovery and a re-registration puts it back; an
// expired CREDENTIAL costs the connection, and nothing done over the mesh can
// fix a problem that stops you reaching the mesh.
//
// What these tests pin, in order of how badly each would hurt if it broke:
//
//   1. The renewal deadline is two thirds into the credential's OWN lifetime —
//      the same schedule the vouch uses, read off the JWT rather than from a
//      configured TTL, so a credential minted under a different operator policy
//      still gets a proportionate deadline.
//   2. An ALREADY-EXPIRED credential still renews. This is the migration
//      property: an agent switched off through its whole renewal window must be
//      able to come back, and it can, because renewal is HTTPS authorized by
//      possession of the keys — neither of which an expiry takes away.
//   3. A credential with NO expiry (everything minted before 2026-08) is left
//      alone rather than guessed at. Nothing fires, nothing breaks.
//   4. An `onRenewed` that fails does NOT let the renewer adopt the credential.
//      A renewal nobody wrote down is undone by the next restart, and treating
//      it as success would hide a real problem for twenty days.
//   5. The signing contract matches what the server verifies, byte for byte.
import { describe, it, expect, vi } from "vitest";
import { nkeys } from "nats.ws";
import {
  decodeCredentialClaims,
  credentialRenewAt,
  credentialCheckIntervalMs,
  buildCredentialRequest,
  renewNodeCredential,
  CredentialRenewer,
  CredentialRefusedError,
  CREDENTIAL_REQUEST_TIMEOUT_MS,
} from "../../src/credential.js";
import { MAX_VOUCH_CHECK_INTERVAL_MS, VOUCH_RENEWAL_FRACTION } from "../../src/constants.js";

const enc = new TextEncoder();
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A JWT-shaped string with the claims we care about. The signature is never
 *  checked by this code (the broker checks it), so it can be anything. */
function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" }))}.${b64url(JSON.stringify(claims))}.sig`;
}

function keys() {
  const kp = nkeys.createUser();
  return { kp, pub: kp.getPublicKey(), seed: new TextDecoder().decode(kp.getSeed()) };
}

describe("reading the lease off a credential", () => {
  it("decodes sub / iat / exp", () => {
    const c = decodeCredentialClaims(fakeJwt({ sub: "UABC", iat: 1000, exp: 2000 }));
    expect(c).toEqual({ sub: "UABC", iat: 1000, exp: 2000 });
  });

  it("returns null for anything that is not a JWT", () => {
    expect(decodeCredentialClaims("nonsense")).toBeNull();
    expect(decodeCredentialClaims("a.b")).toBeNull();
    expect(decodeCredentialClaims(`${b64url("{}")}.not-base64-json!!.sig`)).toBeNull();
  });

  it("reports a missing exp as null rather than inventing one", () => {
    // The pre-§4.8 shape. `null` here is the finding — a credential that never
    // lapses — and it must not be papered over with a guess.
    const c = decodeCredentialClaims(fakeJwt({ sub: "UABC", iat: 1000 }));
    expect(c?.exp).toBeNull();
  });
});

describe("the renewal deadline", () => {
  it("lands exactly two thirds into the credential's own life", () => {
    const iat = 1_000_000;
    const exp = iat + 30 * 24 * 3600;
    const at = credentialRenewAt({ sub: null, iat, exp });
    expect(at).toBe((iat + (exp - iat) * VOUCH_RENEWAL_FRACTION) * 1000);
    // Twenty days into a thirty-day lease, leaving ten to recover in.
    expect((at! / 1000 - iat) / 86_400).toBeCloseTo(20, 6);
  });

  it("is the same fraction the vouch uses — one schedule, not two", () => {
    expect(VOUCH_RENEWAL_FRACTION).toBe(2 / 3);
  });

  it("is null when the credential never expires", () => {
    expect(credentialRenewAt({ sub: null, iat: 1000, exp: null })).toBeNull();
    expect(credentialRenewAt(null)).toBeNull();
  });

  it("assumes a thirty-day lease when iat is missing rather than never renewing", () => {
    const exp = 2_000_000;
    const at = credentialRenewAt({ sub: null, iat: null, exp });
    const issued = (exp - 30 * 24 * 3600) * 1000;
    expect(at).toBe(issued + (exp * 1000 - issued) * VOUCH_RENEWAL_FRACTION);
  });

  it("checks four times inside the last third, capped hourly", () => {
    const thirtyDays = 30 * 24 * 3600_000;
    expect(credentialCheckIntervalMs(thirtyDays)).toBe(MAX_VOUCH_CHECK_INTERVAL_MS);
    // A short lease checks proportionally, never zero.
    expect(credentialCheckIntervalMs(1200)).toBe(100);
    expect(credentialCheckIntervalMs(1)).toBe(1);
  });
});

describe("the signing contract the server verifies", () => {
  it("signs the sorted roster and each agent's consent", () => {
    const node = keys();
    const a1 = keys();
    const a2 = keys();
    const ts = 1_700_000_000;
    const body = buildCredentialRequest(node.seed, [{ id: a1.pub, seed: a1.seed }, { id: a2.pub, seed: a2.seed }], ts);

    expect(body.node_id).toBe(node.pub);
    expect(body.ts).toBe(ts);

    const roster = [a1.pub, a2.pub].sort().join(",");
    const nodeLine = `mesh-node-cred-v1:${ts}:${node.pub}:${roster}`;
    expect(node.kp.verify(enc.encode(nodeLine), Uint8Array.from(atob(body.node_sig), (c) => c.charCodeAt(0)))).toBe(true);

    for (const [i, a] of [a1, a2].entries()) {
      const line = `mesh-node-agent-v1:${ts}:${node.pub}:${a.pub}`;
      const sig = Uint8Array.from(atob(body.agents[i].sig), (c) => c.charCodeAt(0));
      expect(a.kp.verify(enc.encode(line), sig)).toBe(true);
    }
    // The array keeps caller order; only the SIGNED roster is sorted.
    expect(body.agents.map((a) => a.id)).toEqual([a1.pub, a2.pub]);
  });

  it("accepts a signer instead of a seed, so a node need not hold agent keys", () => {
    const node = keys();
    const agent = keys();
    const ts = 1_700_000_000;
    const sign = vi.fn((m: string) => btoa(String.fromCharCode(...agent.kp.sign(enc.encode(m)))));
    const body = buildCredentialRequest(node.seed, [{ id: agent.pub, sign }], ts);
    expect(sign).toHaveBeenCalledWith(`mesh-node-agent-v1:${ts}:${node.pub}:${agent.pub}`);
    expect(body.agents[0].sig).toBe(sign.mock.results[0].value);
  });

  it("refuses a seed that does not match the id it claims", () => {
    const node = keys();
    const a = keys();
    const b = keys();
    expect(() => buildCredentialRequest(node.seed, [{ id: a.pub, seed: b.seed }])).toThrow(/does not match id/);
  });

  it("refuses an empty roster", () => {
    expect(() => buildCredentialRequest(keys().seed, [])).toThrow(/at least one agent/);
  });
});

describe("renewNodeCredential", () => {
  const node = keys();
  const agent = keys();

  it("posts to /v1/node-credential and returns the fresh lease", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.example.test/v1/node-credential");
      return new Response(
        JSON.stringify({ ok: true, jwt: "fresh.jwt.here", node_id: node.pub, agents: [agent.pub], expires_at: "2026-09-07T00:00:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await renewNodeCredential("https://api.example.test/", node.seed, [{ id: agent.pub, seed: agent.seed }], fetchImpl);
    expect(out.jwt).toBe("fresh.jwt.here");
    expect(out.expires_at).toBe("2026-09-07T00:00:00.000Z");
  });

  it("abandons a stalled request instead of holding the renewer's in-flight guard", async () => {
    // Without a deadline, one stalled socket consumes the whole renewal window:
    // the call never settles, `renewIfDue` stays in-flight, and the periodic
    // loop stops retrying. sdk-rust's built-in transport uses the same number.
    expect(CREDENTIAL_REQUEST_TIMEOUT_MS).toBe(15_000);
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
      })) as unknown as typeof fetch;
    await expect(
      renewNodeCredential("https://api.example.test", node.seed, [{ id: agent.pub, seed: agent.seed }], fetchImpl, 20),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("surfaces a refusal as the error the mesh gave — a refusal IS revocation", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "agent UABC… has been retired or revoked" }), { status: 403 })) as unknown as typeof fetch;
    await expect(
      renewNodeCredential("https://api.example.test", node.seed, [{ id: agent.pub, seed: agent.seed }], fetchImpl),
    ).rejects.toThrow(/retired or revoked/);
  });

  it("carries the kill switch's code, so a host waits instead of retrying", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "Agent UABC... is paused by its owner", code: "agent_paused", retry_after_seconds: 300, stopped: [{ id: agent.pub, code: "agent_paused" }] }), { status: 403 })) as unknown as typeof fetch;
    const err = await renewNodeCredential("https://api.example.test", node.seed, [{ id: agent.pub, seed: agent.seed }], fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialRefusedError);
    expect(err.code).toBe("agent_paused");
    expect(err.isStopped).toBe(true);
    expect(err.retryAfterSeconds).toBe(300);
    expect(err.stopped).toEqual([{ id: agent.pub, code: "agent_paused" }]);
  });

  it("names the agents the mesh left off because they are stopped", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jwt: "x.y.z", node_id: node.pub, agents: [], expires_at: null, stopped: [{ id: agent.pub, code: "agent_paused" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await renewNodeCredential("https://api.example.test", node.seed, [{ id: agent.pub, seed: agent.seed }], fetchImpl);
    expect(r.stopped).toEqual([{ id: agent.pub, code: "agent_paused" }]);
  });
});

describe("CredentialRenewer", () => {
  const node = keys();
  const agent = keys();
  const NOW = 1_700_000_000_000;

  const renewer = (claims: Record<string, unknown>, opts: Partial<{ onRenewed: (c: { jwt: string }) => void | Promise<void>; fetchImpl: typeof fetch; onWarning: (w: { code: string; message: string }) => void }> = {}) =>
    new CredentialRenewer({
      apiBase: "https://api.example.test",
      jwt: fakeJwt(claims),
      nodeSeed: node.seed,
      agents: [{ id: agent.pub, seed: agent.seed }],
      fetchImpl:
        opts.fetchImpl ??
        ((async () =>
          new Response(JSON.stringify({ ok: true, jwt: fakeJwt({ sub: node.pub, iat: NOW / 1000, exp: NOW / 1000 + 2_592_000 }), expires_at: "2026-09-07T00:00:00.000Z" }), {
            status: 200,
          })) as unknown as typeof fetch),
      onRenewed: opts.onRenewed,
      onWarning: opts.onWarning,
    });

  /** iat 30 days ago, exp today — so "now" is well past the two-thirds mark. */
  const dueClaims = { sub: node.pub, iat: NOW / 1000 - 2_592_000, exp: NOW / 1000 + 60 };
  /** Freshly minted: nothing due for another 20 days. */
  const freshClaims = { sub: node.pub, iat: NOW / 1000, exp: NOW / 1000 + 2_592_000 };

  it("does nothing when the credential is not yet due", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = renewer(freshClaims, { fetchImpl });
    expect(await r.renewIfDue(NOW)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    const s = r.status(NOW);
    expect(s.expired).toBe(false);
    expect(s.expires_at).toBe(new Date((NOW / 1000 + 2_592_000) * 1000).toISOString());
  });

  it("renews when the deadline has passed, and adopts the fresh credential", async () => {
    const r = renewer(dueClaims);
    const before = r.credential;
    expect(await r.renewIfDue(NOW)).toBe(true);
    expect(r.credential).not.toBe(before);
    expect(r.status(NOW).expired).toBe(false);
    // And the deadline moved: renewing twice in a row is a no-op.
    expect(await r.renewIfDue(NOW)).toBe(false);
  });

  it("RENEWS AN ALREADY-EXPIRED CREDENTIAL — the migration property", async () => {
    // The whole safety case for putting a fuse on live credentials. A host that
    // was off through its renewal window comes back with a dead credential; it
    // must still be able to get a live one, because the renewal door is HTTPS
    // and its authority is possession of the keys.
    const expired = { sub: node.pub, iat: NOW / 1000 - 2_592_000, exp: NOW / 1000 - 86_400 };
    const r = renewer(expired);
    expect(r.status(NOW).expired).toBe(true);
    expect(await r.renewIfExpiring(NOW)).toBe(true);
    expect(r.status(NOW).expired).toBe(false);
  });

  it("leaves a credential with no expiry completely alone", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = renewer({ sub: node.pub, iat: NOW / 1000 }, { fetchImpl });
    expect(r.status(NOW).expires_at).toBeNull();
    expect(r.status(NOW).expired).toBe(false);
    expect(await r.renewIfDue(NOW)).toBe(false);
    expect(await r.renewIfExpiring(NOW)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not adopt a credential the host could not persist", async () => {
    const r = renewer(dueClaims, {
      onRenewed: () => {
        throw new Error("disk full");
      },
    });
    const before = r.credential;
    expect(await r.renewIfDue(NOW)).toBe(false);
    expect(r.credential).toBe(before);
    expect(r.status(NOW).last_error).toMatch(/disk full/);
    // Deadline untouched, so the next tick tries again.
    expect(await r.renewIfDue(NOW)).toBe(false);
    expect(r.status(NOW).last_error).toMatch(/disk full/);
  });

  it("reports a failure through onWarning and keeps the deadline for a retry", async () => {
    const warnings: { code: string; message: string }[] = [];
    const r = renewer(dueClaims, {
      fetchImpl: (async () => new Response(JSON.stringify({ error: "mesh unreachable" }), { status: 503 })) as unknown as typeof fetch,
      onWarning: (w) => warnings.push(w),
    });
    expect(await r.renewIfDue(NOW)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("credential_renewal_failed");
    expect(warnings[0].message).toMatch(/mesh unreachable/);
    // The message must say the recovery is real, not just that something broke.
    expect(warnings[0].message).toMatch(/does not need a working connection/);
  });

  it("reads a roster function at renewal time, so a late-added agent is covered", async () => {
    const a2 = keys();
    const roster = [{ id: agent.pub, seed: agent.seed }];
    let sent: { agents: { id: string }[] } | null = null;
    const r = new CredentialRenewer({
      apiBase: "https://api.example.test",
      jwt: fakeJwt(dueClaims),
      nodeSeed: node.seed,
      agents: () => roster,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ ok: true, jwt: fakeJwt(freshClaims) }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    roster.push({ id: a2.pub, seed: a2.seed });
    await r.renewIfDue(NOW);
    expect(sent!.agents.map((a) => a.id)).toEqual([agent.pub, a2.pub]);
  });

  it("start() and stop() do not keep a process alive or double up", () => {
    const r = renewer(freshClaims);
    r.start();
    r.start(); // idempotent
    r.stop();
    r.stop(); // safe when not started
  });
});
