// Where the SDK finds a server's HTTPS doors and its naming service when a
// caller names neither. (The file kept the name it had when a generator wrote
// it.)
//
// The SDK has no built-in addresses. In order, it uses:
//
//   1. what the caller passes: `platformApi`, `credentialRenewal.apiBase` (the
//      address the agent enrolled against), `requireNamed.registrar`, or a
//      registrar or api argument;
//   2. AGENTMESH_API_URL and AGENTMESH_NAMING_URL, read once when the SDK
//      loads in a Node process (an empty value counts as unset);
//   3. the broker's own address, by the convention a deployment may follow:
//      a broker at mesh.<domain> has its HTTPS doors at https://api.<domain>
//      and, when the server says it offers naming, its naming service at
//      https://naming.<domain>. AgentMesh's network follows it.
//
// With none of these, the requests that need the HTTPS doors say so, and the
// naming rule is off unless the caller turns it on with an address.

const fromEnv = (name: string): string | undefined => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[name]?.trim();
  return v ? v : undefined;
};

/** The server's HTTPS doors, from the environment, when it names them. */
export const AM_URL_API: string | undefined = fromEnv("AGENTMESH_API_URL");
/** The naming service, from the environment, when it names one. */
export const AM_URL_NAMING: string | undefined = fromEnv("AGENTMESH_NAMING_URL");

/** The address of a server's HTTPS doors, without a trailing slash, or a
 *  refusal that says how to give one. */
export function requireApi(api: string | undefined): string {
  if (!api) {
    throw new Error(
      "This needs the address of the server's HTTPS doors, and none is known: pass platformApi when you connect " +
        "(the address the agent enrolled against), or set AGENTMESH_API_URL.",
    );
  }
  return api.replace(/\/+$/, "");
}

/** The addresses a broker's own address implies under the mesh.<domain>
 *  convention: `api` and `naming` on the same domain. Empty for a broker
 *  whose host does not start with `mesh.` (an IP address, localhost, a host
 *  of another shape), which then names its addresses some other way. */
export function addressesFromBroker(servers: string | string[] | undefined): { api?: string; naming?: string } {
  for (const s of Array.isArray(servers) ? servers : servers ? [servers] : []) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `nats://${s}`;
    let host: string;
    try {
      host = new URL(withScheme).hostname.toLowerCase();
    } catch {
      continue;
    }
    const m = /^mesh\.((?:[a-z0-9-]+\.)+[a-z]{2,})$/.exec(host);
    if (m) return { api: `https://api.${m[1]}`, naming: `https://naming.${m[1]}` };
  }
  return {};
}
