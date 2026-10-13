// What version this deployment is, and how confident we are about it.
//
// The advisory feed is useless without this: matching "you are on 0.2.0 and
// 0.2.0 has a hole" requires the deployment to know it is on 0.2.0. There are two
// ways a mesh gets installed and they can answer with different confidence, so
// this returns the confidence alongside the number rather than flattening both
// into a bare string.
//
// A RELEASE install (the published container images, which is what a self-hoster
// runs) has its version baked in at build time, so the answer is exact.
//
// A SOURCE install — our own reference deployment, deployed from a git checkout by
// deploy.sh — has no release identity at all. The best available answer is the
// version in package.json, which says which release the tree descends from but not
// what has landed on top of it. Reporting that as if it were exact would be a small
// lie in the one place a lie is expensive: an operator on a source build that
// already contains a fix would be told they are exposed, and after two or three of
// those they stop reading the advisories.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type VersionConfidence = "release" | "source" | "unknown";

export interface DeploymentVersion {
  version: string | null;
  confidence: VersionConfidence;
}

let cached: DeploymentVersion | null = null;

/** Read the version out of services/package.json. Cheap, but done once. */
function packageVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));      // server/src/shared
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version) ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve this deployment's version.
 *
 * `AGENTMESH_VERSION` is set by the Dockerfile from the release tag, so its
 * presence is what distinguishes a released artefact from a checkout. It is not
 * treated as operator configuration — a self-hoster who sets it by hand on a source
 * build is telling the advisory matcher something false, and the docs say so.
 */
export function deploymentVersion(): DeploymentVersion {
  if (cached) return cached;
  const baked = process.env.AGENTMESH_VERSION?.trim();
  if (baked && /^\d+\.\d+\.\d+/.test(baked)) {
    cached = { version: baked, confidence: "release" };
    return cached;
  }
  const pkg = packageVersion();
  cached = pkg ? { version: pkg, confidence: "source" } : { version: null, confidence: "unknown" };
  return cached;
}

/** Reset the memoized answer. Tests only. */
export function resetDeploymentVersion(): void {
  cached = null;
}

/**
 * The component→version map the advisory matcher takes.
 *
 * Only `services` today. The SDK and adapter versions a deployment happens to have
 * on disk are NOT reported: the platform does not run the adapter, and reporting a
 * version for something we are not running would produce advisories the operator
 * cannot act on from here.
 */
export function installedComponents(): Record<string, string | null> {
  return { services: deploymentVersion().version };
}
