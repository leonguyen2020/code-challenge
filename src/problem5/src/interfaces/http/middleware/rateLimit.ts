import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import type { Logger } from '../../../shared/logger';
import { RateLimitedError } from '../../../shared/errors';

/**
 * Fixed-window counter, evaluated atomically in Redis.
 *
 * INCR and EXPIRE as two round trips is a real race: a process can be
 * interrupted between them, leaving a key with no TTL that never resets and
 * locks the client out permanently. A Lua script executes atomically on the
 * server, so the counter and its expiry are always set together.
 *
 * Returns the post-increment count and the seconds remaining in the window.
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

export interface RateLimitOptions {
  readonly windowSeconds: number;
  readonly maxRequests: number;
}

/**
 * Per-client request budget, shared across every instance of the service.
 *
 * ## Why Redis and not in-process counters
 *
 * An in-memory limiter is per-process. Run four replicas and the effective
 * limit is four times what was configured; restart a pod and every client's
 * budget resets. A shared counter is the only version whose number means what
 * it says.
 *
 * ## Why it fails *open*
 *
 * If Redis is unreachable the request is allowed through and the failure is
 * logged. That is a deliberate trade-off, not an oversight: failing closed
 * converts a cache outage into a total API outage, which is a strictly worse
 * incident than temporarily unenforced rate limits. Availability of the core
 * CRUD function outranks a protective control that is itself degraded.
 *
 * The counterargument is real - if the limiter exists to stop abuse, failing
 * open removes the protection exactly when an attacker may have caused the
 * outage. For an authenticated internal API that trade would go the other way.
 * It is recorded here so the choice is visible rather than implied.
 */
export function rateLimit(redis: Redis, options: RateLimitOptions, logger: Logger) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // `req.ip` respects the `trust proxy` setting, which is off by default.
    // See TRUST_PROXY in config/env.ts for why that default is deliberate.
    const identity = req.ip ?? 'unknown';
    const window = Math.floor(Date.now() / 1000 / options.windowSeconds);
    const key = `ratelimit:${identity}:${window}`;

    let count: number;
    let ttlSeconds: number;
    try {
      const [rawCount, rawTtl] = (await redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        key,
        String(options.windowSeconds),
      )) as [number, number];
      count = rawCount;
      ttlSeconds = rawTtl;
    } catch (error) {
      logger.warn({ err: error }, 'rate limiter unavailable, allowing request (fail-open)');
      next();
      return;
    }

    const remaining = Math.max(0, options.maxRequests - count);
    res.setHeader('RateLimit-Limit', options.maxRequests);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', ttlSeconds);

    if (count > options.maxRequests) {
      res.setHeader('Retry-After', ttlSeconds);
      next(new RateLimitedError(ttlSeconds));
      return;
    }

    next();
  };
}
