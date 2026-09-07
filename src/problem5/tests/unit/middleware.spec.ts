import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import { ZodError, z } from 'zod';
import { errorHandler, notFoundHandler } from '../../src/interfaces/http/middleware/errorHandler';
import { rateLimit } from '../../src/interfaces/http/middleware/rateLimit';
import { requestContext, requestId } from '../../src/interfaces/http/middleware/requestContext';
import { createRedisClient } from '../../src/infrastructure/redis/redisClient';
import { httpLogLevel } from '../../src/app';
import { createLogger } from '../../src/shared/logger';
import {
  ProductNotFoundError,
  RateLimitedError,
  VersionConflictError,
} from '../../src/shared/errors';

const silentLogger = createLogger('silent');

/** Minimal Response double that records what a handler did to it. */
function fakeResponse() {
  const state = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    contentType: '',
    headersSent: false,
  };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    type(value: string) {
      state.contentType = value;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
    setHeader(name: string, value: unknown) {
      state.headers[name] = value;
    },
  };
  return { res: res as unknown as Response, state };
}

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    originalUrl: '/api/v1/products',
    path: '/api/v1/products',
    id: 'req-1234-5678',
    ip: '203.0.113.10',
    get: () => undefined,
    ...overrides,
  } as unknown as Request;
}

describe('errorHandler', () => {
  const handle = errorHandler(silentLogger, false);

  it('renders an AppError as RFC 9457 problem+json', () => {
    const { res, state } = fakeResponse();
    handle(new ProductNotFoundError('abc'), fakeRequest(), res, jest.fn() as NextFunction);

    expect(state.statusCode).toBe(404);
    expect(state.contentType).toBe('application/problem+json');
    expect(state.body).toMatchObject({
      status: 404,
      code: 'PRODUCT_NOT_FOUND',
      instance: '/api/v1/products',
      requestId: 'req-1234-5678',
      id: 'abc',
    });
  });

  it('spreads an error\'s details so clients can act on them', () => {
    const { res, state } = fakeResponse();
    handle(new VersionConflictError('abc', 1, 5), fakeRequest(), res, jest.fn() as NextFunction);
    expect(state.body).toMatchObject({ expectedVersion: 1, actualVersion: 5 });
  });

  it('turns a ZodError into a 400 with per-field issues', () => {
    const { res, state } = fakeResponse();
    const parsed = z.object({ sku: z.string() }).safeParse({});
    handle(
      (parsed as { error: ZodError }).error,
      fakeRequest(),
      res,
      jest.fn() as NextFunction,
    );
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((state.body as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it.each([
    ['entity.parse.failed', 400, 'MALFORMED_JSON'],
    ['entity.too.large', 413, 'PAYLOAD_TOO_LARGE'],
    ['encoding.unsupported', 415, 'UNSUPPORTED_ENCODING'],
  ])('classifies body-parser failure %s as %i', (type, status, code) => {
    const { res, state } = fakeResponse();
    const error = Object.assign(new Error('body parser'), { type });
    handle(error, fakeRequest(), res, jest.fn() as NextFunction);
    expect(state.statusCode).toBe(status);
    expect(state.body).toMatchObject({ code });
  });

  it('hides internal detail in production and shows it elsewhere', () => {
    // A driver error of the kind that carries schema names, SQL fragments and
    // filesystem paths. The marker is deliberately absent from the request URL
    // so the assertion cannot pass on the `instance` field by accident.
    const secret = 'relation "s3cr3t_table" does not exist at /srv/app/src/repo.ts:42';
    const request = fakeRequest({ originalUrl: '/api/v1/widgets', path: '/api/v1/widgets' });

    const dev = fakeResponse();
    errorHandler(silentLogger, false)(new Error(secret), request, dev.res, jest.fn() as NextFunction);
    expect(JSON.stringify(dev.state.body)).toContain('s3cr3t_table');

    const prod = fakeResponse();
    errorHandler(silentLogger, true)(new Error(secret), request, prod.res, jest.fn() as NextFunction);
    expect(prod.state.statusCode).toBe(500);
    expect(JSON.stringify(prod.state.body)).not.toContain('s3cr3t_table');
    expect(JSON.stringify(prod.state.body)).not.toContain('repo.ts');
    // The correlation id is what makes the hidden detail findable in the log.
    expect(prod.state.body).toMatchObject({ requestId: 'req-1234-5678' });
  });

  it('handles a non-Error value without crashing', () => {
    const { res, state } = fakeResponse();
    handle('a bare string was thrown', fakeRequest(), res, jest.fn() as NextFunction);
    expect(state.statusCode).toBe(500);
  });

  it('delegates to Express once the response has started streaming', () => {
    // Writing a second set of headers would throw; the only correct action is
    // to let the default handler destroy the socket.
    const { res, state } = fakeResponse();
    state.headersSent = true;
    const next = jest.fn();
    handle(new ProductNotFoundError('abc'), fakeRequest(), res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(state.statusCode).toBe(0);
  });
});

describe('notFoundHandler', () => {
  it('uses the same problem+json shape as every other error', () => {
    const { res, state } = fakeResponse();
    notFoundHandler()(fakeRequest({ method: 'POST', path: '/nope' }), res);
    expect(state.statusCode).toBe(404);
    expect(state.contentType).toBe('application/problem+json');
    expect(state.body).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });
});

describe('requestContext', () => {
  it('generates an id when none is supplied', () => {
    const { res, state } = fakeResponse();
    const req = fakeRequest({ get: (() => undefined) as unknown as Request['get'] });
    requestContext()(req, res, jest.fn() as NextFunction);
    expect(requestId(req)).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.headers['x-request-id']).toBe(requestId(req));
  });

  it('honours a well-formed inbound id so traces span services', () => {
    const { res } = fakeResponse();
    const req = fakeRequest({ get: (() => 'trace-abc-12345') as unknown as Request['get'] });
    requestContext()(req, res, jest.fn() as NextFunction);
    expect(requestId(req)).toBe('trace-abc-12345');
  });

  it.each([
    ['too short', 'abc'],
    ['contains a newline', 'abcdefgh\nFORGED LOG LINE'],
    ['contains a quote', 'abcdefgh"evil'],
    ['too long', 'a'.repeat(65)],
  ])('replaces a hostile inbound id (%s)', (_label, supplied) => {
    // Unvalidated, this value lets a caller forge log entries or inject control
    // characters into a response header.
    const { res } = fakeResponse();
    const req = fakeRequest({ get: (() => supplied) as unknown as Request['get'] });
    requestContext()(req, res, jest.fn() as NextFunction);
    expect(requestId(req)).not.toBe(supplied);
    expect(requestId(req)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('coerces a non-string id rather than throwing', () => {
    const req = fakeRequest();
    (req as { id: unknown }).id = 42;
    expect(requestId(req)).toBe('42');
  });
});

describe('rateLimit', () => {
  const options = { windowSeconds: 60, maxRequests: 3 };

  /** Redis double whose `eval` returns a scripted [count, ttl]. */
  function fakeRedis(result: [number, number] | Error): Redis {
    return {
      eval: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as Redis;
  }

  it('allows a request inside the budget and reports what is left', async () => {
    const { res, state } = fakeResponse();
    const next = jest.fn();
    await rateLimit(fakeRedis([1, 60]), options, silentLogger)(
      fakeRequest(),
      res,
      next as unknown as NextFunction,
    );
    expect(next).toHaveBeenCalledWith();
    expect(state.headers['RateLimit-Limit']).toBe(3);
    expect(state.headers['RateLimit-Remaining']).toBe(2);
    expect(state.headers['RateLimit-Reset']).toBe(60);
  });

  it('rejects once the budget is exhausted, with Retry-After', async () => {
    const { res, state } = fakeResponse();
    const next = jest.fn();
    await rateLimit(fakeRedis([4, 42]), options, silentLogger)(
      fakeRequest(),
      res,
      next as unknown as NextFunction,
    );
    const passed = (next as jest.Mock).mock.calls[0]?.[0];
    expect(passed).toBeInstanceOf(RateLimitedError);
    expect(state.headers['Retry-After']).toBe(42);
    expect(state.headers['RateLimit-Remaining']).toBe(0);
  });

  it('fails OPEN when Redis is unreachable', async () => {
    // A deliberate trade-off: failing closed would turn a cache outage into a
    // total API outage. Recorded here so the choice stays visible.
    const { res } = fakeResponse();
    const next = jest.fn();
    await rateLimit(fakeRedis(new Error('ECONNREFUSED')), options, silentLogger)(
      fakeRequest(),
      res,
      next as unknown as NextFunction,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('still counts a request whose source IP is unknown', async () => {
    const { res } = fakeResponse();
    const next = jest.fn();
    await rateLimit(fakeRedis([1, 60]), options, silentLogger)(
      fakeRequest({ ip: undefined }),
      res,
      next as unknown as NextFunction,
    );
    expect(next).toHaveBeenCalledWith();
  });
});

describe('createRedisClient', () => {
  const config = {
    redis: { host: '127.0.0.1', port: 6379, password: 'x' },
  } as Parameters<typeof createRedisClient>[0];

  it('does no I/O at construction time', () => {
    const client = createRedisClient(config, silentLogger);
    // lazyConnect: dependency wiring stays free of side effects, so start-up
    // ordering is explicit and failures are attributable.
    expect(client.status).toBe('wait');
    client.disconnect();
  });

  it('backs off on reconnect, and caps the delay', () => {
    // ioredis defaults to an aggressive reconnect loop. A capped, increasing
    // delay keeps a Redis outage from turning into a connection storm against
    // a server that is already struggling.
    const client = createRedisClient(config, silentLogger);
    const retry = client.options.retryStrategy as (attempt: number) => number;
    expect(retry(1)).toBe(200);
    expect(retry(5)).toBe(1_000);
    expect(retry(50)).toBe(2_000);
    expect(retry(1_000)).toBe(2_000);
    client.disconnect();
  });

  it('handles connection errors instead of crashing the process', () => {
    // ioredis emits 'error' on an EventEmitter; with no listener, Node exits.
    // A cache being unreachable must never take the API down.
    const client = createRedisClient(config, silentLogger);
    expect(() => client.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
    client.disconnect();
  });
});

describe('httpLogLevel', () => {
  it.each([
    [200, undefined, 'info'],
    [201, undefined, 'info'],
    [304, undefined, 'info'],
    [400, undefined, 'warn'],
    [404, undefined, 'warn'],
    [429, undefined, 'warn'],
    [500, undefined, 'error'],
    [503, undefined, 'error'],
  ])('logs a %i as %s', (status, error, expected) => {
    expect(httpLogLevel(status, error)).toBe(expected);
  });

  it('logs at error level whenever an exception escaped, whatever the status', () => {
    expect(httpLogLevel(200, new Error('boom'))).toBe('error');
    expect(httpLogLevel(404, new Error('boom'))).toBe('error');
  });

  it('treats null like no error', () => {
    expect(httpLogLevel(200, null)).toBe('info');
  });
});
