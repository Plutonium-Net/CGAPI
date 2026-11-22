import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import axios from "axios";
import type { AxiosInstance } from "axios";
import { config } from "./config.js";

const SORASTREAM_ORIGIN = "https://www.sorastream.com";

const catalogClient: AxiosInstance = axios.create({
  baseURL: SORASTREAM_ORIGIN,
  timeout: config.requestTimeoutMs,
  headers: {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  },
});

const catalogRoutes: FastifyPluginAsync = async (fastify: FastifyInstance): Promise<void> => {
  const proxy = async (
    reply: FastifyReply,
    path: string,
    params: Record<string, string>,
  ) => {
    try {
      const res = await catalogClient.get(path, { params });
      return reply.code(200).send(res.data);
    } catch (error) {
      fastify.log.error({ err: error, path }, "catalog upstream failed");
      return reply.code(502).send({ success: false, error: "catalog unavailable" });
    }
  };

  fastify.get(
    "/catalog/games",
    async (
      request: FastifyRequest<{
        Querystring: { locale?: string; page?: string; size?: string; genre?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { locale = "en-US", page = "0", size = "24", genre } = request.query;
      const params: Record<string, string> = { locale, page, size };
      if (genre) params.genre = genre;
      return proxy(reply, "/api/games", params);
    },
  );

  fastify.get(
    "/catalog/genres",
    async (
      request: FastifyRequest<{ Querystring: { lang?: string } }>,
      reply: FastifyReply,
    ) => {
      const { lang = "en-US" } = request.query;
      return proxy(reply, "/api/genres", { lang });
    },
  );

  fastify.get(
    "/catalog/games/:id",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { lang?: string; profileId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const { lang = "en-US", profileId } = request.query;
      const params: Record<string, string> = { lang };
      if (profileId) params.profile_id = profileId;
      return proxy(reply, `/api/games/${encodeURIComponent(id)}`, params);
    },
  );
};

export default catalogRoutes;
