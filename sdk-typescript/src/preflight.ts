import type { Manifest } from "./types/manifest.js";
import { MeshError, ErrorCode } from "./types/errors.js";
import { DEFAULT_MAX_INBOUND_CHARS } from "./constants.js";
import { inboundTextLength } from "./internal/fence.js";
import { trialRefusal } from "./trial.js";

/**
 * Common Agent 7.7 sender check: a trial request carries no budget, because a
 * requester who owes nothing has nothing to offer. A request asking for both
 * is refused here, before anything is signed or published, with the same
 * `TRIAL_REFUSED` (reason `budget`) the responder would answer with. The
 * sender holds no price for the work, so the quote says how to have it.
 */
export function preflightTrial(trial: boolean | undefined, budget: unknown): void {
  if (trial !== true || budget === undefined || budget === null) return;
  const r = trialRefusal({
    reason: "budget",
    quote: { amount_micro: null, currency: null, words: "send an ordinary request with your budget" },
  });
  throw new MeshError(ErrorCode.TRIAL_REFUSED, `Refused before publish: ${r.message}`, {
    retryable: false,
    details: r.details as unknown as Record<string, unknown>,
  });
}

// Sender pre-flight (SPEC.md §6.4b): the sender-side mirror of the §22
// receiver obligations. Every limit a message can break is published before
// the message is sent, so a sending SDK MUST enforce the recipient's declared
// limits locally, before publishing, and MUST refuse with the SAME error codes
// the recipient would answer with — a pre-flight refusal and a remote refusal
// are indistinguishable to the caller's error handling. A pre-flight refusal
// is local: nothing is published, so nothing is signed, deduplicated or
// retried. The decisions — at-cap, the over-cap boundary, the undeclared
// default, the envelope-size and content-type refusals — are pinned in
// conformance/sender-preflight.json, which is the authority on §22.8's terms.

/**
 * The inbound sender-text cap governing a recipient (§6.4b): its manifest's
 * `limits.max_inbound_chars` when declared, the §22.5 default (65,536) when
 * not — including when no manifest is at hand at all, which §6.4b treats the
 * same way (the fixture: "senders pre-flight against the default, and the
 * divergence resolves remotely — which is the round trip §8.1's limits block
 * exists to spare"). A declared `0` is §22.5's explicit "no cap" and returns
 * 0, which callers treat as check-disabled.
 */
export function effectiveInboundCap(manifest?: Manifest | null): number {
  const declared = manifest?.limits?.max_inbound_chars;
  if (typeof declared === "number" && Number.isFinite(declared) && declared >= 0) {
    return Math.floor(declared);
  }
  return DEFAULT_MAX_INBOUND_CHARS;
}

/**
 * §6.4b sender-text check: the request's input, measured exactly as the
 * recipient would measure it — the §22.5 extraction ladder, counted in UTF-16
 * code units (`U+1F600` counts 2) — against the recipient's cap. Strictly
 * greater-than: a message AT the cap is legal and MUST be published. Refusal:
 * `CONTEXT_TOO_LARGE`, `retryable: false` — the code §22.5 answers with, so
 * the caller cannot tell (and never has to care) which side refused.
 */
export function preflightSenderText(input: unknown, cap: number): void {
  if (cap <= 0) return; // explicit no-cap (§22.5)
  const size = inboundTextLength(input);
  if (size <= cap) return;
  throw new MeshError(
    ErrorCode.CONTEXT_TOO_LARGE,
    `Refused before publish (§6.4b): the sender text is ${size} UTF-16 code units, over the ` +
      `recipient's ${cap}-unit inbound cap (§22.5). The recipient would refuse this with the ` +
      `same code; sending less is the remedy.`,
    { retryable: false, details: { limit: "max_inbound_chars", cap, measured: size } },
  );
}

/**
 * §6.4b envelope-size check, against the transport's advertised maximum
 * payload (§18.9). The one pre-flight check with no remote mirror — an
 * oversized publish never reaches the recipient at all, the transport refuses
 * it — so this turns a raw transport error into a deterministic,
 * protocol-legible local refusal under the same code a caller already handles
 * for "too large". At the bound is legal; one byte over is refused, with
 * `error.details` naming the limit that fired (`transport_max_payload`) so an
 * operator can tell the refusals apart while a caller's error handling never
 * has to. §18.9's remedy — an Object Store `ref` part — is the correct path
 * for the content. `maxPayload` undefined (server not yet known, embedded
 * fakes) skips the check: there is no advertised bound to enforce.
 */
export function preflightEnvelopeSize(envelopeBytes: number, maxPayload: number | undefined): void {
  if (maxPayload === undefined || maxPayload <= 0) return;
  if (envelopeBytes <= maxPayload) return;
  throw new MeshError(
    ErrorCode.CONTEXT_TOO_LARGE,
    `Refused before publish (§6.4b): the serialized envelope is ${envelopeBytes} bytes, over the ` +
      `transport's ${maxPayload}-byte maximum payload (§18.9). The transport would refuse the ` +
      `publish outright; move the content to an Object Store ref part instead.`,
    {
      retryable: false,
      details: {
        limit: "transport_max_payload",
        max_payload: maxPayload,
        envelope_bytes: envelopeBytes,
      },
    },
  );
}

/**
 * §6.4b content-type check, against the recipient's manifest (§8.1): a
 * `config.accepted_output` that no output mode of the target offering can
 * satisfy refuses with `CONTENT_TYPE_NOT_SUPPORTED` — the code §6.4 answers
 * with. Checkable only when the manifest is at hand AND it declares the offering
 * with output modes; anything unknowable locally is left to the recipient,
 * which answers with the identical code (the mirror makes that
 * indistinguishable, which is the point).
 */
export function preflightContentType(
  manifest: Manifest | null | undefined,
  offeringId: string,
  acceptedOutput: string[] | undefined,
): void {
  if (!manifest || !acceptedOutput || acceptedOutput.length === 0) return;
  const offering = manifest.offerings?.find((s) => s.id === offeringId);
  const modes = offering?.output_modes;
  if (!modes || modes.length === 0) return; // undeclared: the recipient decides
  if (acceptedOutput.some((t) => modes.includes(t))) return;
  throw new MeshError(
    ErrorCode.CONTENT_TYPE_NOT_SUPPORTED,
    `Refused before publish (§6.4b): none of the requested output types ` +
      `[${acceptedOutput.join(", ")}] is an output mode offering '${offeringId}' declares ` +
      `[${modes.join(", ")}] (§8.1). The recipient would refuse this with the same code.`,
    { retryable: false, details: { offering: offeringId, accepted_output: acceptedOutput, output_modes: modes } },
  );
}
