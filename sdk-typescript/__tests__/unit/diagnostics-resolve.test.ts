// SPEC-NAMING §5.5 resolution, and the guards around it. The anchor domain
// outranks the registrar, which means whatever answers that probe decides
// which key a name resolves to — so these tests are as much about what the
// resolver REFUSES to follow as about what it resolves.
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import nkeys from "nkeys.js";
import { Diagnostics } from "../../src/diagnostics.js";
import { canonicalJSON } from "../../src/internal/identity.js";
import type { AgentMesh } from "../../src/mesh.js";

/** resolve() never touches the mesh connection; it is pure HTTP + crypto. */
const diag = (opts: Record<string, unknown> = {}) =>
  new Diagnostics({} as AgentMesh, opts as never);

// Every stand-in server stays listening until the file is done. The resolver
// caches an origin's published signing keys (per §5.3) for the process, keyed by
// origin — and an origin here is just `127.0.0.1:<ephemeral port>`. Closing a
// server mid-file frees its port for the next `listen(0)`, which would let one
// test inherit another's cached key set.
const openServers: Server[] = [];
afterAll(() => {
  for (const s of openServers) s.close();
});

function serve(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    openServers.push(srv);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const portOf = (s: Server) => (s.address() as AddressInfo).port;

/** A signed resolve response, the way a conforming registrar serves one. */
function signedCardDoc(signer: ReturnType<typeof nkeys.createAccount>, card: Record<string, unknown>) {
  const sig = signer.sign(new TextEncoder().encode(canonicalJSON(card)));
  return {
    ok: true,
    card,
    registrar_key: signer.getPublicKey(),
    registrar_sig: Buffer.from(sig).toString("base64"),
  };
}

/** What `GET /api/registrar-key` serves (SPEC-NAMING §5.3): the signing key set,
 *  out of band, current key first. Verifying a card against the key sitting
 *  inside the same document proves only that the document agrees with itself, so
 *  the resolver fetches the key from here — which means every stand-in authority
 *  in these tests has to publish one, exactly as a real one must. */
function keyDoc(signer: ReturnType<typeof nkeys.createAccount>) {
  const key = signer.getPublicKey();
  return {
    keys: [key],
    key_set: [{ kid: "test-current", key, status: "current", use: "pan-card-signing" }],
  };
}

const isKeyRequest = (url?: string) => url?.startsWith("/api/registrar-key") ?? false;

const cardFor = (handle: string, agentId: string) => ({
  handle,
  binding: "agent-key",
  endpoints: [{ protocol: "agentmesh", agent_id: agentId }],
});

describe("Diagnostics.resolve — the §5.5 authority chain", () => {
  it("prefers the anchor domain's card over the registrar's", async () => {
    const domainKey = nkeys.createAccount();
    const registrarKey = nkeys.createAccount();
    const handle = "Agent.someone@example.com";
    const domainAgent = nkeys.createUser().getPublicKey();
    const registrarAgent = nkeys.createUser().getPublicKey();

    const domain = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (isKeyRequest(req.url)) return res.end(JSON.stringify(keyDoc(domainKey)));
      if (req.url?.startsWith("/.well-known/webfinger")) {
        return res.end(JSON.stringify({
          subject: `acct:${handle}`,
          links: [{ rel: "urn:pan:card", href: `http://127.0.0.1:${portOf(domain)}/card` }],
        }));
      }
      if (req.url === "/card") return res.end(JSON.stringify(signedCardDoc(domainKey, cardFor(handle, domainAgent))));
      res.statusCode = 404;
      res.end();
    });
    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (isKeyRequest(req.url)) return res.end(JSON.stringify(keyDoc(registrarKey)));
      res.end(JSON.stringify(signedCardDoc(registrarKey, cardFor(handle, registrarAgent))));
    });

    const out = await diag({
      registrar: `http://127.0.0.1:${portOf(registrar)}`,
      anchorWebFingerBase: `http://127.0.0.1:${portOf(domain)}`,
    }).resolve(handle);
    expect(out.resolved).toBe(true);
    expect(out.authority).toBe("anchor-domain");
    // The point of §5.5: the domain's answer WINS. If this ever reports the
    // registrar's key, the authority chain has inverted.
    expect(out.agentId).toBe(domainAgent);
    expect(out.agentId).not.toBe(registrarAgent);
  });

  it("falls through to the registrar when the domain serves no card link", async () => {
    const registrarKey = nkeys.createAccount();
    const handle = "Agent.someone@example.com";
    const registrarAgent = nkeys.createUser().getPublicKey();

    const domain = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ subject: `acct:${handle}`, links: [] }));
    });
    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (isKeyRequest(req.url)) return res.end(JSON.stringify(keyDoc(registrarKey)));
      res.end(JSON.stringify(signedCardDoc(registrarKey, cardFor(handle, registrarAgent))));
    });

    const out = await diag({
      registrar: `http://127.0.0.1:${portOf(registrar)}`,
      anchorWebFingerBase: `http://127.0.0.1:${portOf(domain)}`,
    }).resolve(handle);
    expect(out.resolved).toBe(true);
    expect(out.authority).toBe("registrar");
    expect(out.agentId).toBe(registrarAgent);
  });

  it("discards an unsigned card, whoever served it (§5.3)", async () => {
    const handle = "Fake.someone@example.com";
    const domain = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/.well-known/webfinger")) {
        return res.end(JSON.stringify({
          subject: `acct:${handle}`,
          links: [{ rel: "urn:pan:card", href: `http://127.0.0.1:${portOf(domain)}/card` }],
        }));
      }
      // A card with no signature at all — the anchor domain is authoritative
      // about WHERE the card lives, never an excuse to skip verifying it.
      res.end(JSON.stringify({ ok: true, card: cardFor(handle, nkeys.createUser().getPublicKey()) }));
    });
    const out = await diag({
      registrar: "http://127.0.0.1:1",
      anchorWebFingerBase: `http://127.0.0.1:${portOf(domain)}`,
    }).resolve(handle);
    expect(out.resolved).toBe(false);
    expect(out.error).toMatch(/unsigned/i);
  });

  it("refuses a card signed with a key the authority does not publish (§5.3)", async () => {
    // The whole reason the key is fetched out of band: a card carries the key it
    // was signed with, so verifying one against the other proves only that the
    // document agrees with itself. Anyone can mint a key and sign a card for
    // somebody else's handle with it.
    const published = nkeys.createAccount();
    const rogue = nkeys.createAccount();
    const handle = "Impostor.someone@example.com";
    const rogueAgent = nkeys.createUser().getPublicKey();

    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (isKeyRequest(req.url)) return res.end(JSON.stringify(keyDoc(published)));
      // Internally consistent, and signed by a key this origin never published.
      res.end(JSON.stringify(signedCardDoc(rogue, cardFor(handle, rogueAgent))));
    });

    const out = await diag({ registrar: `http://127.0.0.1:${portOf(registrar)}` }).resolve(handle);
    expect(out.resolved).toBe(false);
    expect(out.error).toMatch(/does not publish/i);
    expect(out.agentId).toBeUndefined();
  });

  it("refuses a card from an authority that publishes no signing key (§5.3)", async () => {
    // §7.6: a registrar that cannot sign MUST refuse to answer resolution at
    // all. One that serves cards while publishing no key set is unverifiable,
    // and unverifiable is not resolved.
    const key = nkeys.createAccount();
    const handle = "Unverifiable.someone@example.com";
    const agentId = nkeys.createUser().getPublicKey();

    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (isKeyRequest(req.url)) {
        res.statusCode = 404;
        return res.end();
      }
      res.end(JSON.stringify(signedCardDoc(key, cardFor(handle, agentId))));
    });

    const out = await diag({ registrar: `http://127.0.0.1:${portOf(registrar)}` }).resolve(handle);
    expect(out.resolved).toBe(false);
    expect(out.error).toMatch(/no card-signing key/i);
  });

  it("refuses a card link pointing at a non-http scheme", async () => {
    const handle = "Agent.someone@example.com";
    const domain = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/.well-known/webfinger")) {
        return res.end(JSON.stringify({
          subject: `acct:${handle}`,
          links: [{ rel: "urn:pan:card", href: "file:///etc/passwd" }],
        }));
      }
      res.statusCode = 404;
      res.end();
    });
    // Nothing listens on the registrar port, so a refusal to follow the
    // file: URL shows up as a failed resolution rather than a read.
    const out = await diag({
      registrar: "http://127.0.0.1:1",
      anchorWebFingerBase: `http://127.0.0.1:${portOf(domain)}`,
    }).resolve(handle);
    expect(out.resolved).toBe(false);
  });

  it("follows a referral to the handle's new registrar (§5.6)", async () => {
    // The old registrar no longer holds the name and says where it went. A
    // consumer holding only the old address must still land on the right key,
    // or a re-homed agent has effectively disappeared for everyone but the
    // two registrars.
    const handle = "Moved.someone@example.com";
    const newKey = nkeys.createAccount();
    const agentId = nkeys.createUser().getPublicKey();

    const newRegistrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      // The new custodian is the authority for this card, so it is ITS key set
      // the resolver fetches — not the referring registrar's.
      if (isKeyRequest(req.url)) return res.end(JSON.stringify(keyDoc(newKey)));
      res.end(JSON.stringify(signedCardDoc(newKey, cardFor(handle, agentId))));
    });
    const oldRegistrar = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        referral: { handle, registrar: `http://127.0.0.1:${portOf(newRegistrar)}` },
      }));
    });

    const out = await diag({ registrar: `http://127.0.0.1:${portOf(oldRegistrar)}` }).resolve(handle);
    expect(out.resolved).toBe(true);
    expect(out.agentId).toBe(agentId);
    // and it reports which registrar actually answered
    expect(out.registrar).toBe(`http://127.0.0.1:${portOf(newRegistrar)}`);
  });

  it("gives up on a referral loop instead of chasing it", async () => {
    const handle = "Loop.someone@example.com";
    let a: Server, b: Server;
    a = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, referral: { handle, registrar: `http://127.0.0.1:${portOf(b)}` } }));
    });
    b = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, referral: { handle, registrar: `http://127.0.0.1:${portOf(a)}` } }));
    });
    const out = await diag({ registrar: `http://127.0.0.1:${portOf(a)}` }).resolve(handle);
    expect(out.resolved).toBe(false);
    expect(out.error).toMatch(/loop|referred more than/i);
  });

  it("does not read the environment for the anchor base", async () => {
    // The seam used to be the CONFORMANCE_ANCHOR_WEBFINGER env var. Whatever
    // answers the anchor probe picks the key a name resolves to, so a variable
    // sitting in the environment of a long-lived daemon must not be able to
    // pick it. The impostor below is LIVE and serves a perfectly valid signed
    // card: the old code would have resolved to its key.
    const handle = "Agent.someone@example.com";
    const impostorKey = nkeys.createAccount();
    const impostorAgent = nkeys.createUser().getPublicKey();
    const registrarKey = nkeys.createAccount();
    const realAgent = nkeys.createUser().getPublicKey();

    const impostor = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (isKeyRequest(req.url)) return res.end(JSON.stringify(keyDoc(impostorKey)));
      if (req.url?.startsWith("/.well-known/webfinger")) {
        return res.end(JSON.stringify({
          subject: `acct:${handle}`,
          links: [{ rel: "urn:pan:card", href: `http://127.0.0.1:${portOf(impostor)}/card` }],
        }));
      }
      res.end(JSON.stringify(signedCardDoc(impostorKey, cardFor(handle, impostorAgent))));
    });
    const registrar = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (isKeyRequest(req.url)) return res.end(JSON.stringify(keyDoc(registrarKey)));
      res.end(JSON.stringify(signedCardDoc(registrarKey, cardFor(handle, realAgent))));
    });

    process.env.CONFORMANCE_ANCHOR_WEBFINGER = `http://127.0.0.1:${portOf(impostor)}`;
    try {
      const out = await diag({ registrar: `http://127.0.0.1:${portOf(registrar)}` }).resolve(handle);
      expect(out.resolved).toBe(true);
      expect(out.authority).toBe("registrar");
      expect(out.agentId).toBe(realAgent);
      expect(out.agentId).not.toBe(impostorAgent);
    } finally {
      delete process.env.CONFORMANCE_ANCHOR_WEBFINGER;
    }
  });
});
