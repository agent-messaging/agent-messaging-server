/**
 * Bootstrap-key exchange: the "dashboard gives you a key" onboarding for SDK
 * agents. The owner mints a single-use agent key in their AgentMesh console;
 * the agent exchanges it once for durable connection credentials and account
 * linkage. The agent's own identity key stays local-born — the credential
 * only authenticates its connection.
 */

export interface BootstrapResult {
  jwt: string;
  /** The seed of the key the CREDENTIAL is bound to. Not the agent's seed: the
   *  exchange mints a fresh key for the connection and leaves the agent's own
   *  identity where it was made. It is what signs the broker's nonce, so it is
   *  what `jwtAuthenticator` takes and what `credentialRenewal.credentialSeed`
   *  needs. */
  seed: string;
  /** The same jwt+seed assembled in standard NATS .creds file format. */
  creds: string;
  label: string;
  account_email: string;
  /** Where the mesh is (SPEC §18.10); `transportFromMesh` reads it. */
  mesh: { name: string; protocol?: string; nats_endpoints?: string[]; endpoints?: string[] };
  /** The PAN handle claimed for this agent, when the console key carried a
   *  usable name. Null when it did not, or when the name was taken: the agent
   *  joins unnamed rather than not joining. */
  handle?: string | null;
  /** When the credential lapses, ISO-8601. Thirty days out at the reference
   *  deployment. Stating it means a host can schedule renewal without decoding
   *  the JWT; one that ignores it still renews, because the SDK reads the same
   *  deadline off the credential itself. */
  expires_at?: string | null;
  /** Where renewal is done (`{apiBase}/v1/node-credential`). The same address
   *  `credentialRenewal` derives from `apiBase`, carried so a host that stores
   *  nothing else still knows where to go. */
  renew_url?: string;
}

/** Exchange a console-minted bootstrap token (POST /v1/bootstrap). Persist
 *  the result — the token is single-use and burned by this call. */
export async function exchangeBootstrapToken(
  apiBase: string,
  token: string,
  agentPublicKey: string,
): Promise<BootstrapResult> {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/v1/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, agent_id: agentPublicKey }),
  });
  const data = (await res.json().catch(() => ({}))) as BootstrapResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `bootstrap failed: HTTP ${res.status}`);
  return data;
}
