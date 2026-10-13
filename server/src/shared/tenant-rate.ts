/**
 * The per-tenant rate cap's hook (keychain/tenant-limits.ts installs it).
 *
 * shared/handler.ts asks it once per service request, after the per-sender
 * limit. Nothing is installed until a core service starts, and the installed
 * check answers null at once while no tenant has a rate cap, so a mesh where
 * nobody set one runs as before.
 */
import type { RateLimitResult } from "./rate-limiter.js";

export type TenantRateCheck = (from: string) => Promise<(RateLimitResult & { tenant: string; limit: number }) | null>;

let check: TenantRateCheck | null = null;

export function setTenantRateCheck(fn: TenantRateCheck | null): void {
  check = fn;
}

export function tenantRateCheck(): TenantRateCheck | null {
  return check;
}
