/** The `.creds` file format nsc writes and every NATS client reads.
 *
 *  Lived as a private helper in api/api-service.ts until pool rotation (now
 *  retired) needed to write the same shape; a format string with two copies
 *  is a format string that will eventually disagree with itself.
 *
 *  The asymmetric dashes are not a typo — nsc emits five on BEGIN and six on
 *  END, and the parsers in this repo (platform-shared/legacy-pool-keys.ts,
 *  mesh-adapter, the SDK) match on exactly that. */
export function credsFileText(jwt: string, seed: string): string {
  return `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`;
}
