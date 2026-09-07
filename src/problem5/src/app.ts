import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import type { AppConfig } from './config/env';
import type { Logger } from './shared/logger';
import { ProductService } from './application/product/ProductService';
import { TypeOrmProductRepository } from './infrastructure/typeorm/TypeOrmProductRepository';
import { ProductController } from './interfaces/http/controllers/ProductController';
import { productRoutes } from './interfaces/http/routes/products';
import { healthRoutes } from './interfaces/http/routes/health';
import { errorHandler, notFoundHandler } from './interfaces/http/middleware/errorHandler';
import { rateLimit } from './interfaces/http/middleware/rateLimit';
import { requestContext } from './interfaces/http/middleware/requestContext';
import { requireJsonBody } from './interfaces/http/middleware/requireJsonBody';

/**
 * Chooses the log level for a completed request.
 *
 * Named and exported so it can be tested directly: a 4xx is the *client's*
 * mistake, and logging it at error level is how teams learn to ignore errors.
 * Only a thrown exception or a 5xx is this service's fault.
 */
export function httpLogLevel(statusCode: number, error: unknown): 'error' | 'warn' | 'info' {
  if (error !== undefined && error !== null) return 'error';
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

export interface AppDependencies {
  readonly config: AppConfig;
  readonly dataSource: DataSource;
  readonly redis: Redis;
  readonly logger: Logger;
}

/**
 * Builds the Express application.
 *
 * Deliberately does not call `listen`. An app that binds a port on import
 * cannot be tested without one, and every integration test would then race for
 * the same port. `main.ts` owns the socket; this owns the wiring.
 *
 * Middleware order is not arbitrary - it is the request pipeline:
 *
 *   1. correlation id, so everything after it can be traced;
 *   2. security headers, before anything can produce a response;
 *   3. request logging;
 *   4. rate limiting, before the body is parsed - a limited client should not
 *      get to make the server allocate and parse its payload first;
 *   5. media-type guard, then body parsing;
 *   6. routes;
 *   7. 404, then the error handler, which must be last.
 */
export function createApp(dependencies: AppDependencies): Express {
  const { config, dataSource, redis, logger } = dependencies;
  const app = express();

  // Off by default: see TRUST_PROXY in config/env.ts. Trusting X-Forwarded-For
  // without a proxy in front lets any client forge its own IP and bypass the
  // rate limiter entirely.
  app.set('trust proxy', config.trustProxy);

  // Removes the `X-Powered-By: Express` header. Free reconnaissance for an
  // attacker looking for framework-specific CVEs; no value to anyone else.
  app.disable('x-powered-by');

  // Rejects `/products` and `/Products` as different routes rather than
  // treating them as the same resource under two URLs.
  app.set('case sensitive routing', true);
  app.set('strict routing', false);

  app.use(requestContext());

  app.use(
    helmet({
      // This is a JSON API: it serves no HTML, so a restrictive CSP costs
      // nothing and blocks any content that is somehow rendered anyway.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      // Errs on the side of not leaking the referring URL to third parties.
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      // No credentialed cross-origin access. A wildcard origin *with*
      // credentials is rejected by browsers anyway; being explicit stops
      // someone "fixing" it later by adding credentials without noticing.
      origin: '*',
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'If-Match', 'X-Request-Id'],
      // Without this the browser hides ETag and Location from JavaScript, and
      // the optimistic-locking flow silently cannot work from a browser client.
      exposedHeaders: ['ETag', 'Location', 'X-Request-Id', 'RateLimit-Remaining'],
      maxAge: 600,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      // No `genReqId`: `requestContext` above has already assigned `req.id`,
      // and pino-http only calls a generator when the id is missing. Passing
      // one anyway would be code that never runs.
      customLogLevel: (_req, res, err) => httpLogLevel(res.statusCode, err),
    }),
  );

  app.use(healthRoutes(dataSource, redis));

  app.use(rateLimit(redis, config.rateLimit, logger));

  app.use(requireJsonBody());
  app.use(
    express.json({
      limit: config.bodyLimitBytes,
      // Rejects `[1,2,3]` and bare strings at the parser rather than letting
      // them reach a schema that expects an object.
      strict: true,
    }),
  );

  const repository = new TypeOrmProductRepository(dataSource);
  const service = new ProductService(repository);
  const controller = new ProductController(service);

  // Versioned from day one. Adding /v2 later is easy; retrofitting a version
  // segment onto URLs clients already depend on is not.
  app.use('/api/v1/products', productRoutes(controller));

  app.use(notFoundHandler());
  app.use(errorHandler(logger, config.isProduction));

  return app;
}
