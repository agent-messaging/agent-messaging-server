// A small OAuth issuer for the examples, standing in for a company's own
// identity provider (Entra, Okta, Auth0 and the like): OpenID metadata and a
// key set over http on this machine, and ES256 access tokens (RFC 9068).
//
// The server reaches it at issuer.test (EXAMPLE_ISSUER_HOST to
// change that), so the mesh has to be started with MESH_TRUST_ALLOW_HTTP=on,
// which lets it fetch keys from an http:// issuer. A real identity provider is
// https and needs no such setting.

import http from "node:http";
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export class ExampleIssuer {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.jwk = { ...publicKey.export({ format: "jwk" }), kid: `k-${randomBytes(4).toString("hex")}`, alg: "ES256", use: "sig" };
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/.well-known/openid-configuration") return send({ issuer: this.base, jwks_uri: `${this.base}/jwks.json` });
      if (req.url === "/jwks.json") return send({ keys: [this.jwk] });
      res.writeHead(404);
      res.end();
    });
    await new Promise((ok) => this.server.listen(0, "0.0.0.0", ok));
    this.base = `http://${process.env.EXAMPLE_ISSUER_HOST ?? "issuer.test"}:${this.server.address().port}`;
    return this;
  }

  close() {
    this.server?.close();
  }

  /** An access token for `clientId`, for `audience`, bound to a DPoP key when `jkt` is given. */
  token(clientId, audience, jkt) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ typ: "at+jwt", alg: "ES256", kid: this.jwk.kid }));
    const body = b64u(JSON.stringify({
      iss: this.base, aud: audience, sub: clientId, client_id: clientId, iat: now, exp: now + 600,
      jti: randomBytes(8).toString("hex"), ...(jkt ? { cnf: { jkt } } : {}),
    }));
    return `${head}.${body}.${b64u(cryptoSign("sha256", Buffer.from(`${head}.${body}`), { key: this.privateKey, dsaEncoding: "ieee-p1363" }))}`;
  }
}
