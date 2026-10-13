/**
 * The Agent Messaging Server's own entry: the core services alone, with no
 * AgentMesh platform beside them (docs/agent-messaging-server-plan.md). The
 * server image runs it, and so do AgentMesh's own core processes
 * (agentmesh-mesh, agentmesh-aux and agentmesh-admission, step 10a): the
 * platform runs beside them in processes of its own and reaches them over
 * the wire.
 *
 *   npx tsx src/server-main.ts [--service=registry,mesh-api,...]
 *
 * It reads the settings first-run setup wrote (server.env in MESH_CONFIG_DIR,
 * else ./mesh-config; setup/server-env.ts) before anything else, leaving every
 * setting already in the environment as it is. Then it connects to the broker
 * as the core's own user, sends its operator events and errors on the bus
 * (shared/ops-events.ts), starts every core service in order (core-start.ts),
 * reports liveness, and shuts down on a signal. Without --service it runs every
 * core service in one process. Under a process manager that starts it through
 * a wrapper, it leaves when the wrapper is gone (shared/orphan-guard.ts).
 */
import { loadServerEnv } from "./setup/server-env.js";

// Before any other module is loaded, so a setting read at import sees the file.
const loaded = loadServerEnv();

const { CORE_SERVICES, startCore } = await import("./core-start.js");
const { connectMesh } = await import("./storage/index.js");
const { startHeartbeat } = await import("./shared/service-health.js");
const { serverRelease } = await import("./shared/server-release.js");
const { installOpsBus, reportErrorsOnBus, spoolError } = await import("./shared/ops-events.js");
const { exitWhenOrphaned } = await import("./shared/orphan-guard.js");

type CoreServiceName = (typeof CORE_SERVICES)[number];

async function main(): Promise<void> {
  exitWhenOrphaned();
  const serviceArg = process.argv.find((a) => a.startsWith("--service="));
  const requested = serviceArg
    ? [...new Set(serviceArg.slice("--service=".length).split(",").map((s) => s.trim()).filter(Boolean))]
    : [...CORE_SERVICES];
  const unknown = requested.filter((s) => !(CORE_SERVICES as readonly string[]).includes(s));
  if (unknown.length || !requested.length) {
    console.error(`[server] unknown or no --service name(s): ${unknown.join(", ") || "(none)"}`);
    console.error(`[server] the core services are: ${CORE_SERVICES.join(", ")}`);
    process.exit(1);
  }

  const natsServer = process.env.NATS_URL ?? "localhost:4222";
  const natsCreds = process.env.NATS_CREDS;
  const release = serverRelease();
  console.log(`Agent Messaging Server${release ? ` ${release.version}` : " (from source)"}`);
  console.log(`Settings: ${loaded ? `${loaded.file} (${loaded.applied.length} read, the rest already set)` : "the environment only (no server.env found)"}`);
  const broker = (process.env.MESH_BROKER ?? "nats").toLowerCase();
  console.log(
    broker === "rabbitmq"
      ? `Broker: RabbitMQ at ${process.env.MESH_AMQP_URL?.replace(/\/\/[^@/]*@/, "//") ?? "(MESH_AMQP_URL not set)"}, state in Postgres`
      : `Broker: ${natsServer}, ${natsCreds ? "with credentials" : "anonymous"}`,
  );
  console.log(`Services: ${requested.join(", ")}`);
  console.log("");

  const mesh = await connectMesh({ binding: process.env.MESH_BROKER, servers: natsServer, credsFile: natsCreds });
  installOpsBus(mesh.messaging, { process: requested.join(",") });
  reportErrorsOnBus();
  const { services } = await startCore(mesh.messaging, mesh.storage, (n: CoreServiceName) => requested.includes(n));

  const procKey = (process.env.SERVICE_HEALTH_KEY ?? `server_${process.pid}`).replace(/[^A-Za-z0-9_-]/g, "_");
  const heartbeat = await startHeartbeat(mesh.storage, procKey, [...requested], () => mesh.isOpen());

  console.log("");
  console.log("All services ready. Waiting for messages...");
  console.log("");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    setTimeout(() => {
      console.error("[server] shutdown did not finish within 10 s; exiting anyway");
      process.exit(1);
    }, 10_000).unref();
    console.log("\nShutting down...");
    heartbeat.stop();
    for (const svc of services) await svc.stop();
    await mesh.drain();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await mesh.closed();
  console.log("Broker connection closed.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  // Exiting now leaves no time for the bus; the spool is written at once and
  // sent by the next process to start.
  spoolError(err, "fatal error at start");
  process.exit(1);
});
