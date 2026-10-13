/**
 * The nkeys every SDK module uses: nats.ws's, with native Ed25519 where the
 * runtime has it (see fast-nkeys.ts). Import `nkeys` from here, never from
 * "nats.ws" directly, or that module's signatures go back to tweetnacl.
 */
import { nkeys as wsNkeys } from "nats.ws";
import { accelerate } from "./fast-nkeys.js";

export const nkeys: typeof wsNkeys = accelerate(wsNkeys);
