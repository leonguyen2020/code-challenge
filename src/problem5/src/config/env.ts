import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Configuration, validated once at start-up.
 *
 * Two decisions worth stating:
 *
 * 1. **Fail fast, loudly.** A missing or malformed variable aborts the process
 *    before the server binds a port. The alternative - `process.env.PORT ?? 3000`
 *    scattered through the codebase - produces a service that starts happily
 *    and then behaves subtly wrongly, which is far harder to diagnose than a
 *    refusal to boot.
 * 2. **No secret has a default.** Credentials must be supplied. A default
 *    password is a password that reaches production.
 */

/**
 * Loads `.env` files in order of increasing precedence:
 *
 *   1. the repository root `.env` - shared infrastructure credentials, so the
 *      Postgres and Redis passwords live in exactly one place;
 *   2. this package's own `.env` - service-specific overrides.
 *
 * `dotenv` never overwrites a variable that is already set, so real environment
 * variables (what a container or CI runner injects) always win over both.
 */
function loadDotEnvFiles(): void {
  const packageEnv = path.resolve(__dirname, '../../.env');
  const repositoryRootEnv = path.resolve(__dirname, '../../../../.env');

  for (const file of [packageEnv, repositoryRootEnv]) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file });
    }
  }
}

const portSchema = z.coerce.number().int().min(1).max(65_535);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: portSchema.default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: portSchema.default(5432),
  POSTGRES_USER: z.string().min(1, 'POSTGRES_USER is required'),
  POSTGRES_PASSWORD: z.string().min(1, 'POSTGRES_PASSWORD is required'),
  POSTGRES_DB: z.string().min(1, 'POSTGRES_DB is required'),

  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: portSchema.default(6379),
  REDIS_PASSWORD: z.string().min(1, 'REDIS_PASSWORD is required'),

  /** Maximum accepted JSON body. Bounds memory use per request. */
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(65_536),

  /** Sliding-window rate limit, applied per client IP. */
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100_000).default(120),

  /** How long the process waits for in-flight requests during shutdown. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),

  /**
   * Whether to believe `X-Forwarded-For` when determining the client IP.
   *
   * Defaults to OFF, and that default is a security decision. The rate limiter
   * keys on the client IP; if the header is trusted while nothing upstream
   * overwrites it, any client can send a random `X-Forwarded-For` per request
   * and never be limited at all. Enable it only when a proxy you control is
   * definitely in front of the service.
   */
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: string;
  postgres: Readonly<{
    host: string; port: number; user: string; password: string; database: string;
  }>;
  redis: Readonly<{ host: string; port: number; password: string }>;
  bodyLimitBytes: number;
  rateLimit: Readonly<{ windowSeconds: number; maxRequests: number }>;
  shutdownTimeoutMs: number;
  trustProxy: boolean;
}>;

/**
 * Parses and validates configuration.
 *
 * @throws {Error} with every problem listed at once. Reporting only the first
 *         failure turns a misconfigured deployment into a guessing game of
 *         repeated restarts.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    // Every issue has a non-empty path: the schema is a flat object with no
    // root-level refinement, so there is no "(root)" case to fall back to.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration. Copy .env.example to .env and fill it in.\n${problems}`,
    );
  }

  const env = parsed.data;
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    postgres: Object.freeze({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
    }),
    redis: Object.freeze({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
    }),
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
    rateLimit: Object.freeze({
      windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    }),
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    trustProxy: env.TRUST_PROXY,
  });
}

/** Loads `.env` files then validates. Call once, at process start. */
export function bootstrapConfig(): AppConfig {
  loadDotEnvFiles();
  return loadConfig();
}
