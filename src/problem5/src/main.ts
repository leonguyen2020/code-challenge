import 'reflect-metadata';
import type { Server } from 'node:http';
import { bootstrapConfig } from './config/env';
import { logger } from './shared/logger';
import { createDataSource } from './infrastructure/typeorm/dataSource';
import { createRedisClient } from './infrastructure/redis/redisClient';
import { createApp } from './app';

/**
 * Process entry point: build dependencies, bind the port, and shut down
 * cleanly.
 */
async function main(): Promise<void> {
  const config = bootstrapConfig();
  // The logger is constructed at import time, before .env has been read, so the
  // configured level is applied here rather than at construction.
  logger.level = config.logLevel;

  const dataSource = createDataSource(config);
  const redis = createRedisClient(config, logger);

  await dataSource.initialize();
  logger.info(
    { host: config.postgres.host, database: config.postgres.database },
    'connected to postgres',
  );

  // Redis is a *degraded* dependency, not a required one: it backs rate
  // limiting, which fails open. Refusing to start because the cache is down
  // would make a protective control into a single point of failure.
  try {
    await redis.connect();
    logger.info({ host: config.redis.host }, 'connected to redis');
  } catch (error) {
    logger.warn({ err: error }, 'redis unavailable at start-up; rate limiting will fail open');
  }

  const app = createApp({ config, dataSource, redis, logger });
  const server: Server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'server listening');
  });

  // Node's default is a 5 s keep-alive timeout with headersTimeout just above
  // it. Behind a load balancer that reuses connections, the balancer can send a
  // request on a connection the server is closing, producing sporadic 502s that
  // are extremely hard to attribute. Making the server's timeout longer than
  // the balancer's removes the race.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  installShutdownHandlers({ server, dataSource, redis, timeoutMs: config.shutdownTimeoutMs });
}

interface ShutdownTargets {
  readonly server: Server;
  readonly dataSource: ReturnType<typeof createDataSource>;
  readonly redis: ReturnType<typeof createRedisClient>;
  readonly timeoutMs: number;
}

/**
 * Graceful shutdown.
 *
 * On SIGTERM (which is what an orchestrator sends before SIGKILL) the process
 * stops accepting new connections, lets in-flight requests finish, then closes
 * the database and cache. Exiting immediately instead would abort every request
 * currently being served - during a rolling deploy, that is a burst of 502s for
 * real users on every release.
 *
 * The timeout is the safety net: a request wedged on a slow query must not
 * prevent the process from ever exiting, or the orchestrator SIGKILLs it anyway
 * and the graceful path bought nothing.
 */
function installShutdownHandlers({ server, dataSource, redis, timeoutMs }: ShutdownTargets): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second Ctrl-C should not start a second concurrent teardown.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, timeoutMs);
    // Do not let this timer alone keep the event loop alive.
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error !== undefined ? reject(error) : resolve()));
      });
      logger.info('stopped accepting connections');

      // Dependencies close only after the server has drained; closing the pool
      // first would fail the very requests we waited for.
      await dataSource.destroy();
      await redis.quit().catch(() => redis.disconnect());
      logger.info('shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // After an uncaught exception the process state is unknown - a promise may
  // have been abandoned mid-transaction. Continuing to serve traffic from a
  // process in an unknown state is worse than restarting, so it is logged and
  // the shutdown path runs.
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
