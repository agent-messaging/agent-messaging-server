// The environment's values for the A2A bridge (env/<name>.json, AGENTMESH_ENV,
// default prod). deploy.sh ships env/ beside a2a-gateway/ on the mesh host, so
// the same relative path works there and in the repository.
//
// The gateway is part of the core server (the Agent Messaging Server), which
// must also start where nobody wrote an environment file. With a file, every
// value is read exactly as before. With none, a value is the default below,
// and one with no default throws when it is read, as a missing value always
// has; the paths that read those (PACT, payments) are platform parts that are
// off unless they are configured.
import { envName as loaderEnvName, findEnvFile as find, envFileGet as get } from "./env-file.js";

/** What the gateway uses when the deployment has no environment file. */
const DEFAULTS: Readonly<Record<string, string>> = {
  // Where artifact references become fetchable links (core/parts.ts). The
  // services API listens on port 3001 unless API_PORT says otherwise, and
  // MESH_ARTIFACT_BASE_URL overrides this.
  "urls.api": "http://localhost:3001",
};

/** A string value from the environment file, e.g. amEnv("urls.api"). */
export const amEnv = (dotted: string): string => {
  if (find() === null) {
    const v = DEFAULTS[dotted];
    if (v === undefined) throw new Error(`no environment file was found, and ${dotted} has no default`);
    return v;
  }
  return get<string>(dotted);
};

/** A value that may be missing or null in this environment's file: undefined then. */
export const amEnvOptional = (dotted: string): string | undefined => {
  try {
    const v = amEnv(dotted);
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
};

/** This environment's name: "prod", "dev", ... */
export const envName = (): string => loaderEnvName();
