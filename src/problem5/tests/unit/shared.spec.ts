import { describe, expect, it } from '@jest/globals';
import {
  AppError,
  InvalidCursorError,
  ProductNotFoundError,
  RateLimitedError,
  SkuAlreadyExistsError,
  ValidationError,
  VersionConflictError,
} from '../../src/shared/errors';
import { bigintToSafeNumber } from '../../src/infrastructure/typeorm/transformers';
import { loadConfig } from '../../src/config/env';
import { createLogger } from '../../src/shared/logger';

describe('error taxonomy', () => {
  it.each([
    [new ValidationError([{ path: 'sku', message: 'bad' }]), 'VALIDATION_FAILED', 400],
    [new ProductNotFoundError('id-1'), 'PRODUCT_NOT_FOUND', 404],
    [new SkuAlreadyExistsError('SKU-1'), 'SKU_ALREADY_EXISTS', 409],
    [new VersionConflictError('id-1', 1, 2), 'VERSION_CONFLICT', 409],
    [new InvalidCursorError('corrupt'), 'INVALID_CURSOR', 400],
    [new RateLimitedError(30), 'RATE_LIMITED', 429],
  ])('%s carries a stable code and status', (error, code, status) => {
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    // Survives TypeScript's downlevelled class emit.
    expect(Object.getPrototypeOf(error)).toBe(error.constructor.prototype);
    expect(error.name).toBe(error.constructor.name);
  });

  it('freezes the details so a handler cannot mutate them on the way out', () => {
    const error = new VersionConflictError('id-1', 1, 2);
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.details).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
  });

  it('tells the caller what to do about a version conflict', () => {
    expect(new VersionConflictError('id-1', 1, 2).message).toMatch(/re-read the resource and retry/i);
  });
});

describe('bigint transformer', () => {
  it('passes numbers through unchanged on the way in', () => {
    expect(bigintToSafeNumber.to(12_345)).toBe(12_345);
    expect(bigintToSafeNumber.to(null)).toBeNull();
  });

  it('converts the driver string back to a number', () => {
    // The pg driver returns int8 as a string; an unguarded field typed `number`
    // would hold "1500" and concatenate instead of adding.
    expect(bigintToSafeNumber.from('1500')).toBe(1500);
    expect(typeof bigintToSafeNumber.from('1500')).toBe('number');
    expect(bigintToSafeNumber.from(1500)).toBe(1500);
    expect(bigintToSafeNumber.from(null)).toBeNull();
  });

  it('throws rather than silently losing precision', () => {
    // Unreachable through the API because of the column CHECK, but this is
    // exactly where data written by some other client would corrupt silently.
    expect(() => bigintToSafeNumber.from('9007199254740993')).toThrow(/precision/i);
    expect(() => bigintToSafeNumber.from('99999999999999999999')).toThrow();
  });
});

describe('configuration', () => {
  const VALID = {
    POSTGRES_USER: 'app',
    POSTGRES_PASSWORD: 'secret',
    POSTGRES_DB: 'db',
    REDIS_PASSWORD: 'secret',
  };

  it('applies documented defaults', () => {
    const config = loadConfig(VALID);
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.rateLimit.maxRequests).toBe(120);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('has no default for any credential', () => {
    // A default password is a password that reaches production.
    expect(() => loadConfig({})).toThrow(/POSTGRES_USER/);
    expect(() => loadConfig({ ...VALID, POSTGRES_PASSWORD: '' })).toThrow(/POSTGRES_PASSWORD/);
    expect(() => loadConfig({ ...VALID, REDIS_PASSWORD: undefined })).toThrow(/REDIS_PASSWORD/);
  });

  it('reports every problem at once, not just the first', () => {
    // Otherwise a misconfigured deployment becomes a guessing game of repeated
    // restarts, one variable at a time.
    try {
      loadConfig({});
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('POSTGRES_USER');
      expect(message).toContain('POSTGRES_PASSWORD');
      expect(message).toContain('POSTGRES_DB');
      expect(message).toContain('REDIS_PASSWORD');
    }
  });

  it('rejects an out-of-range port or malformed value', () => {
    expect(() => loadConfig({ ...VALID, PORT: '0' })).toThrow();
    expect(() => loadConfig({ ...VALID, PORT: '70000' })).toThrow();
    expect(() => loadConfig({ ...VALID, NODE_ENV: 'staging' })).toThrow();
    expect(() => loadConfig({ ...VALID, LOG_LEVEL: 'chatty' })).toThrow();
  });

  it('parses TRUST_PROXY strictly, so "false" cannot become true', () => {
    expect(loadConfig({ ...VALID, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...VALID, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(() => loadConfig({ ...VALID, TRUST_PROXY: 'yes' })).toThrow();
  });

  it('marks production explicitly', () => {
    expect(loadConfig({ ...VALID, NODE_ENV: 'production' }).isProduction).toBe(true);
  });
});

describe('logger redaction', () => {
  /** Captures one log line by pointing pino at an in-memory destination. */
  function capture(payload: Record<string, unknown>): string {
    let written = '';
    const logger = createLogger('info', {
      write(chunk: string) {
        written += chunk;
      },
    });
    logger.info(payload, 'test');
    return written;
  }

  it('scrubs credentials that request logging would otherwise capture', () => {
    const line = capture({
      req: {
        headers: {
          authorization: 'Bearer super-secret-token',
          cookie: 'session=abc123',
          'x-api-key': 'key-should-not-appear',
          'user-agent': 'jest',
        },
      },
      password: 'hunter2',
      nested: { password: 'hunter3' },
    });

    for (const secret of ['super-secret-token', 'session=abc123', 'key-should-not-appear', 'hunter2', 'hunter3']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('[redacted]');
    // Non-sensitive fields still make it through - redaction that blanks
    // everything is just a logger that does not work.
    expect(line).toContain('jest');
  });

  it('emits ISO-8601 timestamps rather than epoch milliseconds', () => {
    const line = capture({});
    expect(line).toMatch(/"time":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
