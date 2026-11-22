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
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { config } from "./config.js";
import { createMailbox, getDomains } from "./mail/useOther.js";

const SORASTREAM_ORIGIN = "https://www.sorastream.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0";
const POOL_FILE = join(config.dataDir, "accounts.json");
const REFILL_INTERVAL_MS = 30_000;

export interface Account {
  email: string;
  password: string;
  token: string;
  userId: string;
  profileId: string;
  createdAt: number;
}

interface SoraSignupResponse {
  status: string;
  data: {
    profile: { id: string };
    user: { id: string; email: string };
  };
}

function randomPassword(length = 14): string {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const special = "!@#$%^&*";
  const all = lower + upper + digits + special;
  const pick = (set: string) => set[crypto.getRandomValues(new Uint8Array(1))[0]! % set.length]!;
  const required = [pick(lower), pick(upper), pick(digits), pick(special)];
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const rest = Array.from(bytes.slice(4), (b) => all[b % all.length]!);
  return [...required, ...rest].sort(() => Math.random() - 0.5).join("");
}

function extractCode(text: string): string | null {
  return text.match(/\b(\d{4,8})\b/)?.[1] ?? null;
}

class SorastreamClient {
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
        "User-Agent": USER_AGENT,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "sec-gpc": "1",
      },
    });
    this.client = wrapper(base);
    (this.client.defaults as unknown as { jar: CookieJar }).jar = new CookieJar();
  }

  async register(): Promise<Account> {
    const domains = await getDomains();
    const preferred = domains.find((d) => d.domain === "temp.tf") ?? domains[0];
    if (!preferred) throw new Error("no active mail.tm domains available");

    const mailbox = await createMailbox({ domain: preferred.domain });
    const email = mailbox.address;
    const password = randomPassword();

    this.logger.debug({ email }, "creating sorastream account");

    const signup = await this.client.post<SoraSignupResponse>(
      "/api/signup",
      {
        data: {
          user: {
            username: email,
            password,
            ctry_code: "",
            preferred_lang: "en-US",
            accepted_terms: 1,
            accepted_news: 0,
          },
          profile: {
            name: "User",
            role: "super",
            birthday: "1970-01-01T00:00:00Z",
            avatar: { avatar_id: "" },
          },
        },
      },
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`,
          Referer: `${SORASTREAM_ORIGIN}/en-US/sign-up`,
        },
      },
    );

    if (signup.data.status !== "OK") {
      throw new Error("sorastream signup rejected");
    }

    const { user, profile } = signup.data.data;

    const rawCookies = signup.headers["set-cookie"];
    const cookies: string[] = Array.isArray(rawCookies)
      ? rawCookies
      : rawCookies
        ? [String(rawCookies)]
        : [];
    const token =
      cookies.find((cookie) => cookie.startsWith("token="))?.split(";")[0]?.slice(6) ?? "";
    if (!token) throw new Error("sorastream signup returned no auth token");

    const authCookie = `token=${token}; userId=${user.id}; profileId=${profile.id}`;

    const message = await mailbox.waitForMessage({
      timeout: config.mailTimeoutMs,
      interval: 2_000,
    });
    const body = message.text || message.html?.join("") || message.intro || "";
    const code = extractCode(body) ?? extractCode(message.subject);
    if (!code) throw new Error("verification code not found in email");

    await this.client.get("/api/self/login-methods/email/verify-code", {
      params: { token: code },
      headers: { Cookie: authCookie },
    });

    await this.client.post("/api/self/purchases/free-trial", null, {
      headers: {
        Cookie: authCookie,
        Referer: `${SORASTREAM_ORIGIN}/en-US/billing/choose-plan`,
      },
    });

    this.logger.info({ email }, "sorastream account ready");

    return {
      email,
      password,
      token,
      userId: user.id,
      profileId: profile.id,
      createdAt: Date.now(),
    };
  }
}

class AccountPool {
  private pool: Account[] = [];
  private filling = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly logger: FastifyInstance["log"]) {}

  async init(): Promise<void> {
    try {
      const raw = await readFile(POOL_FILE, "utf-8");
      const loaded = JSON.parse(raw) as Account[];
      this.pool = loaded.filter((account) => Date.now() - account.createdAt < config.poolMaxAgeMs);
      this.logger.info(
        { size: this.pool.length, expired: loaded.length - this.pool.length },
        "account pool restored",
      );
    } catch {
      this.pool = [];
    }

    void this.refill();
    this.timer = setInterval(() => void this.refill(), REFILL_INTERVAL_MS);
    this.timer.unref();
  }

  async take(): Promise<Account | null> {
    const account = this.pool.shift() ?? null;
    if (!account) return null;

    this.logger.info(
      { remaining: this.pool.length, target: config.poolSize },
      "account served from pool",
    );
    await this.save();
    void this.refill();
    return account;
  }

  private async refill(): Promise<void> {
    if (this.filling || config.poolSize === 0) return;
    this.filling = true;
    try {
      while (this.pool.length < config.poolSize) {
        try {
          this.pool.push(await new SorastreamClient(this.logger).register());
          await this.save();
        } catch (error) {
          this.logger.warn({ err: error }, "pool refill failed, retrying later");
          break;
        }
      }
    } finally {
      this.filling = false;
    }
  }

  private async save(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(POOL_FILE, JSON.stringify(this.pool, null, 2), { mode: 0o600 });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const accountsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance): Promise<void> => {
  const pool = new AccountPool(fastify.log);
  await pool.init();

  fastify.addHook("onClose", async () => pool.stop());

  fastify.post(
    "/accounts",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const pooled = await pool.take();
      if (pooled) {
        const { createdAt: _createdAt, ...data } = pooled;
        return reply.code(201).send({ success: true, data, source: "pool" });
      }

      try {
        const { createdAt: _createdAt, ...data } = await new SorastreamClient(fastify.log).register();
        return reply.code(201).send({ success: true, data, source: "live" });
      } catch (error) {
        fastify.log.error({ err: error }, "account registration failed");
        return reply.code(502).send({ success: false, error: "account creation failed" });
      }
    },
  );
};

export default accountsRoutes;
