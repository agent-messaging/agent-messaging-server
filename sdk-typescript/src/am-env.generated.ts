// The addresses the SDK uses when a caller gives none: AgentMesh's public
// network. (The file kept the name it had when a generator wrote it.)
//
// A Node process can point them elsewhere, without changing code, with
// AGENTMESH_API_URL, AGENTMESH_NAMING_URL and AGENTMESH_BROKER_WSS. They are
// read once, when the SDK loads. An empty value counts as unset. In a browser,
// or anywhere with no `process`, the defaults stand.
//
// An option a caller passes (`platformApi`, `requireNamed.registrar`, a
// registrar or api argument) still wins over both.

const fromEnv = (name: string): string | undefined => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[name]?.trim();
  return v ? v : undefined;
};

export const AM_URL_API = fromEnv("AGENTMESH_API_URL") ?? "https://api.agentmesh.ai";
export const AM_URL_NAMING = fromEnv("AGENTMESH_NAMING_URL") ?? "https://naming.agentmesh.ai";
export const AM_BROKER_WSS = fromEnv("AGENTMESH_BROKER_WSS") ?? "wss://mesh.agentmesh.ai";
