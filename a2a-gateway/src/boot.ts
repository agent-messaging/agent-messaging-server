/**
 * Startup order, kept in one testable place.
 *
 * The order matters. On 2026-07-20 a restart orphaned the process holding port
 * 8090 and the replacement crash-looped 1,364 times over two and a half hours,
 * because the old order was: connect to NATS, THEN bind. Every doomed attempt
 * paid for a mesh connection and a round of hosted-agent registrations before
 * discovering the socket was taken — and because that took longer than pm2's
 * minimum uptime, pm2 scored each crash as a healthy restart and `max_restarts`
 * never tripped.
 *
 * So: bind first. A port conflict now costs one failed bind and a named error,
 * and the mesh sees nothing at all.
 */
import type { Server } from "node:http";
import type { Bridge } from "./bridge.js";
import { startInboundServer } from "./inbound/server.js";
import { attach, type AttachConfig, type Attachment } from "./outbound/attach.js";
import { AttachmentManager } from "./outbound/manager.js";
import { FileAttachmentStore } from "./outbound/store.js";
import { SettlementQueue } from "./outbound/settlements.js";
import type { ForwardRoute } from "./inbound/relay.js";
import { dirname, join } from "node:path";

export interface BootResult {
  server: Server;
  attachments: Attachment[];
  manager: AttachmentManager | null;
  shutdown(): Promise<void>;
}

export async function boot(
  bridge: Bridge,
  attachList: AttachConfig[] = [],
  /** `forwards`: path prefixes a front end beside the gateway answers
   *  (FORWARD_ROUTES, inbound/relay.ts). */
  opts: { storePath?: string; forwards?: ForwardRoute[] } = {},
): Promise<BootResult> {
  for (const warning of bridge.configWarnings()) {
    console.warn(`[bridge] WARNING: ${warning}`);
  }

  // With a store path the outbound direction is record-driven: env attaches
  // become records, records get stable identities, and the admin API can
  // manage the lot. Without one (tests, minimal dev boots) the old direct
  // attach path still works and nothing touches the filesystem.
  // The settlement queue sits beside the attachment records, for the same
  // reason and with the same durability: a charge is written down before it is
  // posted, so a restart between the two finishes the job instead of losing
  // it. Same directory, its own file, because they have different lifetimes.
  const manager = opts.storePath
    ? new AttachmentManager(
        bridge,
        new FileAttachmentStore(opts.storePath),
        undefined,
        new SettlementQueue(join(dirname(opts.storePath), "settlements.json")),
      )
    : null;

  // 1. Hold the socket, or fail here having touched nothing else.
  const server = await startInboundServer(bridge, manager ?? undefined, opts.forwards ?? []);

  // 2. Only now spend a mesh connection. Until this resolves the listener
  //    answers 503 (and /healthz reports ready:false), which is a truer answer
  //    than a refused connection.
  await bridge.connect();

  // 3. Attach outbound remotes.
  const attachments: Attachment[] = [];
  if (manager) {
    await manager.bootstrapFromEnv(attachList);
    await manager.start();
  } else {
    for (const cfg of attachList) {
      try {
        attachments.push(await attach(bridge, cfg));
      } catch (err) {
        console.error(`[bridge:outbound] failed to attach ${cfg.url}:`, err);
      }
    }
  }

  return {
    server,
    attachments,
    manager,
    shutdown: async () => {
      server.close();
      await manager?.stop();
      for (const a of attachments) await a.detach().catch(() => undefined);
      await bridge.close();
    },
  };
}
