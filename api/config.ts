import { join } from "path";
import { tmpdir } from "os";

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

const corsOrigins = list(process.env.CORS_ORIGIN, ["*"]);

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? "0.0.0.0",
  logLevel: process.env.LOG_LEVEL ?? "info",
  corsOrigins,
  // Always use a writable location: the deploy filesystem (and process.cwd())
  // may be read-only, and DATA_DIR in the environment is ignored on purpose.
  dataDir: join(tmpdir(), "plutonium-cgapi"),
  poolSize: Math.max(0, int(process.env.POOL_SIZE, 5)),
  poolMaxAgeMs: Math.max(1, int(process.env.POOL_MAX_AGE_HOURS, 12)) * 60 * 60 * 1000,
  regionCode: process.env.REGION_CODE ?? "US",
  requestTimeoutMs: Math.max(1000, int(process.env.REQUEST_TIMEOUT_MS, 20000)),
  queueTimeoutMs: Math.max(1000, int(process.env.QUEUE_TIMEOUT_MS, 600000)),
  mailTimeoutMs: Math.max(5000, int(process.env.MAIL_TIMEOUT_MS, 90000)),
  allowedSignalHosts: list(process.env.ALLOWED_SIGNAL_HOSTS, [".ludiumlab.com"]),
} as const;

export function resolveCorsOrigin(origin: string | undefined): string | null {
  if (config.corsOrigins.includes("*")) return "*";
  if (origin && config.corsOrigins.includes(origin)) return origin;
  return null;
}
