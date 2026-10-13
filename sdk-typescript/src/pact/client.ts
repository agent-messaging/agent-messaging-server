/**
 * The personal-agent side of PACT 1.0 (https://openpactprotocol.org/spec.md,
 * personal-agent.md): read a Brand's card, send it messages, follow a
 * delegation (device code, RFC 8628), and read what comes back. `fetch` only.
 *
 * Signing is a callback (`getToken`), so the key stays wherever the caller
 * keeps it: AgentMesh's platform signs on its side; an agent builder who is
 * their own personal-agent platform passes a signer over their own key.
 */
import { DELEGATION_HEADER, DEVICE_CODE_GRANT_TYPE, PACT_METADATA, REFRESH_TOKEN_GRANT_TYPE, formatScope, parseScope, type Receipt } from "./rules.js";
import type { Jwks } from "./jose.js";

// ─── the card (sections 2.1, 5.1) ───────────────────────────────────

export interface PactCard {
  name?: string;
  description?: string;
  supportedInterfaces?: Array<{ url?: string; protocolBinding?: string; protocolVersion?: string }>;
  securitySchemes?: Record<string, Record<string, unknown>>;
  securityRequirements?: Array<{ schemes?: Record<string, unknown> }>;
  skills?: Array<{ id?: string; name?: string; description?: string }>;
  capabilities?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface DelegationScheme {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  refreshUrl: string;
  metadataUrl: string;
  scopes: Array<{ id: string; description: string }>;
}

/** The interface URL: the HTTP+JSON 1.0 entry's `url`, chosen by binding and
 *  version, never by position (2.1). Null when the card has none. */
export function interfaceUrlOf(card: PactCard): string | null {
  const entry = (card.supportedInterfaces ?? []).find((i) => i?.protocolBinding === "HTTP+JSON" && i?.protocolVersion === "1.0" && typeof i.url === "string");
  return entry?.url ? entry.url.replace(/\/+$/, "") : null;
}

/** The delegation scheme of a card that offers PACT Delegated (5.1): an
 *  `oauth2SecurityScheme` with a `deviceCode` flow, named beside a bearer
 *  scheme in one security requirement. Null when the card offers none. */
export function delegationSchemeOf(card: PactCard): DelegationScheme | null {
  const schemes = card.securitySchemes ?? {};
  for (const req of card.securityRequirements ?? []) {
    const names = Object.keys(req?.schemes ?? {});
    if (names.length !== 2) continue;
    let bearer = false;
    let found: DelegationScheme | null = null;
    for (const name of names) {
      const s = schemes[name] as Record<string, any> | undefined;
      if (!s) continue;
      if (s.httpAuthSecurityScheme && String(s.httpAuthSecurityScheme.scheme ?? "").toLowerCase() === "bearer") {
        bearer = true;
        continue;
      }
      const flow = s.oauth2SecurityScheme?.flows?.deviceCode;
      const metadataUrl = s.oauth2SecurityScheme?.oauth2MetadataUrl;
      if (flow && typeof flow.deviceAuthorizationUrl === "string" && typeof flow.tokenUrl === "string" && typeof metadataUrl === "string") {
        found = {
          deviceAuthorizationUrl: flow.deviceAuthorizationUrl,
          tokenUrl: flow.tokenUrl,
          refreshUrl: typeof flow.refreshUrl === "string" ? flow.refreshUrl : flow.tokenUrl,
          metadataUrl,
          scopes: Object.entries((flow.scopes ?? {}) as Record<string, unknown>).map(([id, d]) => ({ id, description: String(d ?? "") })),
        };
      }
    }
    if (bearer && found) return found;
  }
  return null;
}

/** The card at a URL (2.1: no authentication). */
export async function fetchCard(url: string, fetchImpl: typeof fetch = fetch): Promise<PactCard> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, redirect: "follow" });
  if (!res.ok) throw new PactHttpError(res.status, "the card could not be read", res.headers.get("retry-after"));
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object") throw new PactHttpError(res.status, "the card is not a JSON object", null);
  return body as PactCard;
}

// ─── errors ─────────────────────────────────────────────────────────

/** An A2A error envelope (section 6), read by its reason, never by status. */
export class PactA2AError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PactA2AError";
  }
}

/** Anything that is not an envelope: 401, 404/405, 429, a transport failure. */
export class PactHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
    /** Seconds from `Retry-After` on a 429, when it named any. */
    readonly retryAfter: string | null,
    /** On a 401: whether it was the delegation token that was refused. */
    readonly delegationRejected = false,
  ) {
    super(message);
    this.name = "PactHttpError";
  }
}

// ─── sending (sections 4, 5.5) ──────────────────────────────────────

export interface PactMessage {
  messageId: string;
  contextId?: string;
  role: string;
  parts: Array<{ text?: string; [k: string]: unknown }>;
  metadata?: Record<string, unknown>;
}

export type PactSendResult =
  | { kind: "message"; message: PactMessage; contextId: string | null; text: string; receipt?: Receipt }
  | { kind: "authRequired"; contextId: string | null; text: string; missingScopes: string[]; verificationUriComplete?: string; taskId: string };

/** Text parts joined, for a person to read. */
export function textOf(parts: Array<{ text?: unknown }> | undefined): string {
  return (parts ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

/**
 * Send one message to a Brand. `getToken` signs a fresh personal-agent JWT;
 * `delegationToken`, when given, rides in X-A2A-User-Delegation. Throws
 * PactA2AError for an envelope (its reason decides what to do) and
 * PactHttpError for everything else.
 */
export async function sendPactMessage(input: {
  interfaceUrl: string;
  text: string;
  getToken: () => Promise<string> | string;
  contextId?: string;
  messageId?: string;
  delegationToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<PactSendResult> {
  const token = await input.getToken();
  const res = await (input.fetchImpl ?? fetch)(`${input.interfaceUrl.replace(/\/+$/, "")}/message:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "A2A-Version": "1.0",
      "Content-Type": "application/json",
      ...(input.delegationToken ? { [DELEGATION_HEADER]: `Bearer ${input.delegationToken}` } : {}),
    },
    body: JSON.stringify({
      message: {
        messageId: input.messageId ?? globalThis.crypto.randomUUID(),
        ...(input.contextId ? { contextId: input.contextId } : {}),
        role: "ROLE_USER",
        parts: [{ text: input.text }],
      },
    }),
  });
  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason = body?.error?.details?.[0]?.reason;
    if (typeof reason === "string") throw new PactA2AError(res.status, reason, String(body.error.message ?? reason));
    const challenge = res.headers.get("www-authenticate") ?? "";
    throw new PactHttpError(res.status, `the business's provider answered ${res.status}`, res.headers.get("retry-after"), res.status === 401 && !!input.delegationToken && /invalid_token/.test(challenge));
  }
  if (body?.task) {
    const task = body.task;
    if (task?.status?.state !== "TASK_STATE_AUTH_REQUIRED") throw new PactHttpError(200, `unexpected task state ${task?.status?.state}`, null);
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const missing = Array.isArray(meta[PACT_METADATA.missingScopes]) ? (meta[PACT_METADATA.missingScopes] as unknown[]).filter((s): s is string => typeof s === "string") : [];
    const link = meta[PACT_METADATA.verificationUriComplete];
    return {
      kind: "authRequired",
      contextId: typeof task.contextId === "string" ? task.contextId : null,
      text: textOf(task.status?.message?.parts),
      missingScopes: missing,
      ...(typeof link === "string" ? { verificationUriComplete: link } : {}),
      taskId: String(task.id ?? ""),
    };
  }
  const message = body?.message as PactMessage | undefined;
  if (!message || message.role !== "ROLE_AGENT") throw new PactHttpError(200, "the reply was not a message from the business's agent", null);
  const receipt = message.metadata?.[PACT_METADATA.receipt] as Receipt | undefined;
  return {
    kind: "message",
    message,
    contextId: typeof message.contextId === "string" ? message.contextId : null,
    text: textOf(message.parts),
    ...(receipt ? { receipt } : {}),
  };
}

// ─── delegated authority (section 5.3, RFC 8628) ────────────────────

export class PactOAuthError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly error: string,
    readonly description?: string,
  ) {
    super(description ? `${error}: ${description}` : error);
    this.name = "PactOAuthError";
  }
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DelegationTokens {
  accessToken: string;
  refreshToken?: string;
  /** What the person approved (5.3: the personal agent MUST read it). */
  scopes: string[];
  expiresIn: number;
}

async function postForm(url: string, params: Record<string, string>, getToken: () => Promise<string> | string, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const raw = await res.text();
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (res.ok) return body;
  if (body && typeof body.error === "string" && res.status !== 401) throw new PactOAuthError(res.status, body.error, typeof body.error_description === "string" ? body.error_description : undefined);
  if (body && body.error === "invalid_client") throw new PactOAuthError(res.status, "invalid_client", body.error_description);
  throw new PactHttpError(res.status, `the authorization server answered ${res.status}`, res.headers.get("retry-after"));
}

/** Start a device authorization for scopes on the card (5.3). Refuses, before
 *  any request, a scope the card does not list (5.2). */
export async function startDeviceAuthorization(input: {
  scheme: DelegationScheme;
  clientId: string;
  scopes: readonly string[];
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceAuthorization> {
  const known = new Set(input.scheme.scopes.map((s) => s.id));
  const unknown = input.scopes.filter((s) => !known.has(s));
  if (!input.scopes.length) throw new Error("ask for at least one scope");
  if (unknown.length) throw new Error(`these scopes are not on the business's card: ${unknown.join(", ")}`);
  const b = await postForm(input.scheme.deviceAuthorizationUrl, { client_id: input.clientId, scope: formatScope(input.scopes) }, input.getToken, input.fetchImpl ?? fetch);
  if (!b || typeof b.device_code !== "string" || typeof b.user_code !== "string" || typeof b.verification_uri_complete !== "string") {
    throw new PactHttpError(200, "the device authorization answer is missing fields", null);
  }
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri: String(b.verification_uri ?? b.verification_uri_complete),
    verificationUriComplete: b.verification_uri_complete,
    expiresIn: Number(b.expires_in ?? 600),
    interval: Number(b.interval ?? 5),
  };
}

export type DevicePoll = { status: "pending" } | { status: "slow_down" } | { status: "granted"; tokens: DelegationTokens };

function tokensOf(b: any): DelegationTokens {
  if (!b || typeof b.access_token !== "string") throw new PactHttpError(200, "the token answer has no access_token", null);
  return {
    accessToken: b.access_token,
    ...(typeof b.refresh_token === "string" ? { refreshToken: b.refresh_token } : {}),
    scopes: parseScope(b.scope),
    expiresIn: Number(b.expires_in ?? 3600),
  };
}

/** One poll of the token endpoint. Pending and slow_down come back as
 *  statuses; access_denied, expired_token and the rest throw PactOAuthError. */
export async function pollDeviceToken(input: {
  scheme: DelegationScheme;
  clientId: string;
  deviceCode: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}): Promise<DevicePoll> {
  try {
    const b = await postForm(input.scheme.tokenUrl, { grant_type: DEVICE_CODE_GRANT_TYPE, device_code: input.deviceCode, client_id: input.clientId }, input.getToken, input.fetchImpl ?? fetch);
    return { status: "granted", tokens: tokensOf(b) };
  } catch (err) {
    if (err instanceof PactOAuthError && err.error === "authorization_pending") return { status: "pending" };
    if (err instanceof PactOAuthError && err.error === "slow_down") return { status: "slow_down" };
    throw err;
  }
}

/** Refresh within the grant's life. */
export async function refreshDelegation(input: {
  scheme: DelegationScheme;
  clientId: string;
  refreshToken: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}): Promise<DelegationTokens> {
  const b = await postForm(input.scheme.refreshUrl, { grant_type: REFRESH_TOKEN_GRANT_TYPE, refresh_token: input.refreshToken, client_id: input.clientId }, input.getToken, input.fetchImpl ?? fetch);
  return tokensOf(b);
}

/** RFC 8414 metadata, for the `jwks_uri` that verifies receipts. */
export async function fetchAuthorizationServerMetadata(url: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown> & { jwks_uri?: string }> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new PactHttpError(res.status, "the authorization server's metadata could not be read", null);
  return (await res.json()) as Record<string, unknown> & { jwks_uri?: string };
}

export async function fetchJwks(url: string, fetchImpl: typeof fetch = fetch): Promise<Jwks> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new PactHttpError(res.status, "the keys could not be read", null);
  const body = (await res.json()) as Jwks;
  if (!body || !Array.isArray(body.keys)) throw new PactHttpError(res.status, "the keys are not a JWKS", null);
  return body;
}
