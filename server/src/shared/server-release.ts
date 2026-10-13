/**
 * Which release of the Agent Messaging Server this is, when it is one.
 *
 * The server's image has its release number baked in at build time
 * (MESH_SERVER_VERSION, set by .github/workflows/release-images.yml from
 * server/server-release.json). A server run from a checkout, AgentMesh's own
 * processes included, has none, and says nothing rather than guess: the
 * capabilities answer and the admin status leave the release out.
 */
export const SERVER_NAME = "Agent Messaging Server";
export const SERVER_VERSION_SETTING = "MESH_SERVER_VERSION";

export interface ServerRelease {
  name: string;
  version: string;
}

/** The release, or null for a server run from source. */
export function serverRelease(env: NodeJS.ProcessEnv = process.env): ServerRelease | null {
  const v = env[SERVER_VERSION_SETTING]?.trim();
  return v && /^\d+\.\d+\.\d+$/.test(v) ? { name: SERVER_NAME, version: v } : null;
}
