import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { config, resolveCorsOrigin } from "./config.js";
import accountsRoutes from "./accounts.js";
import catalogRoutes from "./catalog.js";
import { streamRoutes } from "./stream.js";
import { signalRoutes } from "./signal.js";

const SERVICE = "Plutonium CGAPI";
const VERSION = "1.0.0";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = resolveCorsOrigin(request.headers.origin);
    if (origin) reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Accept");
    reply.header("Access-Control-Max-Age", "86400");
    reply.header("Vary", "Origin");
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 },
  });

  app.get("/", async () => ({
    service: SERVICE,
    version: VERSION,
    status: "ok",
    endpoints: {
      "GET /health": "liveness probe",
      "POST /api/accounts": "issue a ready-to-use Sorastream account",
      "GET /api/catalog/games": "game catalog (?locale, ?page, ?size, ?genre)",
      "GET /api/catalog/genres": "genre list (?lang)",
      "GET /api/catalog/games/:id": "single game (?lang, ?profileId)",
      "POST /api/stream": "start a game session (JSON or text/event-stream)",
      "GET /api/signal?server=": "WebSocket proxy for WebRTC signaling",
    },
  }));

  app.get("/health", async () => ({
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  await app.register(accountsRoutes, { prefix: "/api" });
  await app.register(catalogRoutes, { prefix: "/api" });
  await app.register(streamRoutes, { prefix: "/api" });
  await app.register(signalRoutes, { prefix: "/api" });

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    const force = setTimeout(() => {
      app.log.warn("shutdown timed out, exiting");
      process.exit(1);
    }, 15_000);
    force.unref();

    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (error) => {
    app.log.error({ err: error }, "uncaught exception");
    void shutdown("SIGTERM");
  });

  await app.listen({ port: config.port, host: config.host });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
