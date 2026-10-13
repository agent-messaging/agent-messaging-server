/**
 * Device-profile detection (EXT-1, `mesh://extensions/device-profile/v1`).
 *
 * SDKs SHOULD auto-fill `platform` and `client` — both are knowable without
 * user input — and leave `device_class`/`os_version` to the embedding
 * application (a Node.js process cannot tell a laptop from a server). Detected
 * values merge UNDER any caller-supplied profile: the caller always wins.
 */
import type { NodeDeclaredProfile, DevicePlatform } from "../types/manifest.js";

/** EXT-1 `client` self-identification. Keep in sync with package.json. */
export const SDK_CLIENT = "sdk-typescript/0.17.0";

/** EXT-1 platform values `process.platform` can map to directly. */
const NODE_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "win32", "linux", "android"]);

/** Detect the EXT-1 attributes this runtime can know on its own. */
export function detectDeviceProfile(): NodeDeclaredProfile {
  const out: NodeDeclaredProfile = { client: SDK_CLIENT };

  // Node.js (and Node-like runtimes exposing process.platform)
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc && typeof proc.platform === "string") {
    if (NODE_PLATFORMS.has(proc.platform)) out.platform = proc.platform as DevicePlatform;
    return out;
  }

  // Browser
  if (typeof (globalThis as { navigator?: unknown }).navigator !== "undefined") {
    out.platform = "browser";
    out.device_class = "browser";
  }
  return out;
}

/** Merge detected device attributes under a caller-supplied profile (caller
 *  keys win; detection only fills gaps). Returns a profile even when the
 *  caller supplied none, so every registration carries at least `client`. */
export function withDetectedDevice(profile?: NodeDeclaredProfile): NodeDeclaredProfile {
  return { ...detectDeviceProfile(), ...profile };
}
