import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { config } from "./config.js";

const SUBPROTOCOL = "sorartc-1.0";
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PENDING = 32;

function isAllowedServer(value: string): boolean {
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(value)) return false;

  const hostname = value.split(":")[0]!.toLowerCase();
  return config.allowedSignalHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return allowed.startsWith(".") ? hostname.endsWith(allowed) : hostname === allowed;
  });
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString();
  return Buffer.from(data as ArrayBuffer).toString();
}

export const signalRoutes: FastifyPluginAsync = async (fastify: FastifyInstance): Promise<void> => {
  fastify.get("/signal", { websocket: true }, (socket, request) => {
    const { server } = request.query as { server?: string };

    if (!server || !isAllowedServer(server)) {
      socket.close(1008, "invalid server");
      return;
    }

    const upstream = new WebSocket(`wss://${server}`, [SUBPROTOCOL]);
    const pending: string[] = [];
    let ready = false;

    const connectTimer = setTimeout(() => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        fastify.log.warn({ server }, "upstream signaling connect timed out");
        upstream.close();
        socket.close(1011, "upstream timeout");
      }
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref();

    upstream.onopen = () => {
      ready = true;
      fastify.log.info({ server }, "upstream signaling connected");
      for (const message of pending.splice(0)) upstream.send(message);
    };

    upstream.onmessage = (event) => {
      if (socket.readyState === socket.OPEN) socket.send(event.data as string);
    };

    upstream.onclose = (event) => {
      if (!ready) fastify.log.warn({ server, code: event.code }, "upstream signaling closed early");
      if (socket.readyState === socket.OPEN) socket.close(event.code, event.reason);
    };

    upstream.onerror = () => {
      fastify.log.error({ server }, "upstream signaling error");
      if (socket.readyState === socket.OPEN) socket.close(1011, "upstream error");
    };

    socket.on("message", (data: unknown) => {
      const message = toText(data);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (upstream.readyState === WebSocket.CONNECTING && pending.length < MAX_PENDING) {
        pending.push(message);
      }
    });

    socket.on("close", () => {
      clearTimeout(connectTimer);
      pending.length = 0;
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
  });
};
