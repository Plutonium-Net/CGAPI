import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import axios from "axios";
import type { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { config, resolveCorsOrigin } from "./config.js";

const SORASTREAM_ORIGIN = "https://www.sorastream.com";

export interface StreamBody {
  token: string;
  userId: string;
  profileId: string;
  gameId: string;
  gameName?: string;
  lang?: string;
}

interface ExecData {
  exec_ip: string;
  exec_token: string;
}

interface SoraExecResponse {
  status: string;
  data: ExecData;
}

interface QueueUpdate {
  position: number | string;
  retryIn: number;
}

interface StartSessionOptions {
  token: string;
  userId: string;
  profileId: string;
  gameId: string;
  gameName?: string;
  lang?: string;
  signal?: AbortSignal;
  onQueue?: (update: QueueUpdate) => void;
}

export class SessionAbortedError extends Error {
  constructor() {
    super("session aborted by client");
    this.name = "SessionAbortedError";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SessionAbortedError());
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(new SessionAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class SorastreamStreamClient {
  private readonly client: AxiosInstance;

  constructor(private readonly logger: FastifyInstance["log"]) {
    const base = axios.create({
      baseURL: SORASTREAM_ORIGIN,
      timeout: config.requestTimeoutMs,
      withCredentials: true,
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        Origin: SORASTREAM_ORIGIN,
        Pragma: "no-cache",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "sec-gpc": "1",
      },
    });
    this.client = wrapper(base);
    (this.client.defaults as unknown as { jar: CookieJar }).jar = new CookieJar();
  }

  async startSession(options: StartSessionOptions): Promise<{ server: string; execToken: string }> {
    const {
      token,
      userId,
      profileId,
      gameId,
      lang = "en-US",
      signal,
      onQueue,
    } = options;

    const body = {
      data: {
        client_id: "WebBrowser",
        region_code: config.regionCode,
        lang_code: lang,
        entry_id: gameId,
      },
    };
    const headers = {
      Cookie: `token=${token}; userId=${userId}; profileId=${profileId}`,
      Referer: `${SORASTREAM_ORIGIN}/en-US/games/${gameId}`,
    };

    const deadline = Date.now() + config.queueTimeoutMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new SessionAbortedError();

      try {
        const res = await this.client.post<SoraExecResponse>(
          `/api/profiles/${profileId}/execs`,
          body,
          { headers, signal },
        );

        if (res.data.status !== "OK") throw new Error("sorastream exec rejected");

        return {
          server: res.data.data.exec_ip,
          execToken: res.data.data.exec_token,
        };
      } catch (error) {
        if (error instanceof SessionAbortedError) throw error;
        if (signal?.aborted) throw new SessionAbortedError();
        if (axios.isCancel(error)) throw new SessionAbortedError();

        const payload = (error as { response?: { data?: { error?: unknown } } }).response?.data
          ?.error as
          | { errors?: { string?: string }[]; data?: { retry_in?: number; position?: number | string } }
          | undefined;

        const queued = payload?.errors?.some(
          (entry) => entry.string === "IrisErrnoUserHasBeenEnqueued",
        );

        if (!queued) throw error;

        const retryIn = payload?.data?.retry_in ?? 5;
        const position = payload?.data?.position ?? "?";
        this.logger.info({ gameId, position, retryIn }, "queued for game server");
        onQueue?.({ position, retryIn });
        await sleep(retryIn * 1000, signal);
      }
    }

    throw new Error("game server queue timed out");
  }
}

export const streamRoutes: FastifyPluginAsync = async (fastify: FastifyInstance): Promise<void> => {
  const streamClient = new SorastreamStreamClient(fastify.log);

  fastify.post<{ Body: StreamBody }>(
    "/stream",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "userId", "profileId", "gameId"],
          properties: {
            token: { type: "string" },
            userId: { type: "string" },
            profileId: { type: "string" },
            gameId: { type: "string" },
            gameName: { type: "string" },
            lang: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: StreamBody }>, reply: FastifyReply) => {
      const { token, userId, profileId, gameId, gameName, lang } = request.body;
      const wantsStream = (request.headers.accept ?? "").includes("text/event-stream");

      if (!wantsStream) {
        try {
          const result = await streamClient.startSession({
            token,
            userId,
            profileId,
            gameId,
            gameName,
            lang,
          });
          return reply.code(200).send({ success: true, data: result });
        } catch (error) {
          fastify.log.error({ err: error, gameId }, "stream session failed");
          return reply.code(502).send({ success: false, error: "stream session failed" });
        }
      }

      const origin = resolveCorsOrigin(request.headers.origin);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
        Vary: "Origin",
      });

      const controller = new AbortController();
      // Listen on the response, not the request: `request.raw` emits "close" as
      // soon as the body is consumed, which would abort every SSE immediately.
      const onClose = () => controller.abort();
      reply.raw.on("close", onClose);

      const send = (event: string, data: unknown) => {
        if (controller.signal.aborted || reply.raw.writableEnded) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const result = await streamClient.startSession({
          token,
          userId,
          profileId,
          gameId,
          gameName,
          lang,
          signal: controller.signal,
          onQueue: (update) => send("queue", update),
        });
        send("ready", result);
      } catch (error) {
        if (error instanceof SessionAbortedError) {
          fastify.log.info({ gameId }, "stream client disconnected");
        } else {
          fastify.log.error({ err: error, gameId }, "stream session failed");
          send("error", { error: "stream session failed" });
        }
      } finally {
        reply.raw.off("close", onClose);
        if (!reply.raw.writableEnded) reply.raw.end();
      }

      return reply;
    },
  );
};
