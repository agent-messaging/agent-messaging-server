/**
 * The scenario's settings: config.json, with any
 * value overridden by its environment variable. The delays are what make the
 * same tests run in seconds in CI and over hours overnight.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Requirements {
  employee: string;
  cpu_cores_min: number;
  ram_gb_min: number;
  storage_gb_min: number;
  screen_in_max: number;
  budget_usd: number;
}

export interface CatalogItem {
  sku: string;
  model: string;
  cpu_cores: number;
  ram_gb: number;
  storage_gb: number;
  screen_in: number;
  price_usd: number;
}

export interface ScenarioConfig {
  /** How long after an order is accepted the vendor ships it. */
  ship_delay_ms: number;
  /** How long a manager takes to decide a purchase above the auto-approve limit. */
  approval_delay_ms: number;
  /** How long the approver spends on its policy check before any decision.
   *  Set it to 0 to expose the RabbitMQ deferred-result race that
   *  tests/deferred-task-timing.test.ts covers on its own. */
  approval_review_ms: number;
  /** How long the requester waits for a synchronous quote. */
  quote_timeout_ms: number;
  /** How long a quote stays valid. */
  quote_ttl_ms: number;
  /** Purchases at or below this are approved without a manager. */
  auto_approve_limit_usd: number;
  /** How long an agent stays offline in the store-and-forward tests. */
  offline_window_ms: number;
  requirements: Requirements;
  vendor_catalog: CatalogItem[];
}

const ENV: Record<string, keyof ScenarioConfig> = {
  SHIP_DELAY_MS: "ship_delay_ms",
  APPROVAL_DELAY_MS: "approval_delay_ms",
  APPROVAL_REVIEW_MS: "approval_review_ms",
  QUOTE_TIMEOUT_MS: "quote_timeout_ms",
  QUOTE_TTL_MS: "quote_ttl_ms",
  AUTO_APPROVE_LIMIT_USD: "auto_approve_limit_usd",
  OFFLINE_WINDOW_MS: "offline_window_ms",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ScenarioConfig {
  const file = env.SCENARIO_CONFIG ?? join(ROOT, "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8")) as ScenarioConfig;
  for (const [name, key] of Object.entries(ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of 0 or more, not ${raw}`);
    (cfg as unknown as Record<string, number>)[key] = n;
  }
  return cfg;
}
