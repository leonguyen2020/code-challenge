import Redis from 'ioredis';
import type { AppConfig } from '../../config/env';
import type { Logger } from '../../shared/logger';

/**
 * Creates the Redis client.
 *
 * `lazyConnect` is on so construction never performs I/O: the application wires
 * its dependencies first and connects explicitly, which keeps start-up ordering
 * obvious and makes failures attributable.
 *
 * `maxRetriesPerRequest: 1` matters more than it looks. ioredis defaults to 20
 * retries, so with Redis down a single rate-limit check would sit there
 * retrying while the HTTP request it belongs to waits. One retry turns a Redis
 * outage into a fast failure the caller can handle, rather than a slow one that
 * exhausts the server's request capacity.
 */
export function createRedisClient(config: AppConfig, logger: Logger): Redis {
  const client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });

  // Without a listener, ioredis emits 'error' on an EventEmitter with no
  // handler, which in Node crashes the process. A cache being unreachable must
  // never take down the API.
  client.on('error', (error) => {
    logger.warn({ err: error }, 'redis connection error');
  });

  return client;
}
