import 'reflect-metadata';
import type { Express } from 'express';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import pino from 'pino';
import { createApp } from '../../../src/app';
import { ProductOrmEntity } from '../../../src/infrastructure/typeorm/ProductOrmEntity';
import { testConfig } from './testDatabase';

export interface TestHarness {
  readonly app: Express;
  readonly dataSource: DataSource;
  readonly redis: Redis;
  /** Empties the products table between tests. */
  truncate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boots the real application against the test database.
 *
 * NOTE ON PARALLELISM: every integration test shares one database and clears it
 * with `TRUNCATE` between tests, so they must not run concurrently. That is
 * enforced by `maxWorkers: 1` in jest.config.js rather than left to the
 * accident of there currently being a single spec file. If this suite is ever
 * parallelised, each worker needs its own database
 * (`<db>_test_${JEST_WORKER_ID}`, created in globalSetup) first.
 *
 * Nothing is stubbed: the same `createApp` that `main.ts` uses, the same
 * middleware chain, the same TypeORM repository, the same migrated schema. A
 * test that mocks the database proves the mock works; this proves the service
 * works.
 */
export async function startTestApp(): Promise<TestHarness> {
  const config = testConfig();

  const dataSource = new DataSource({
    type: 'postgres',
    host: config.postgres.host,
    port: config.postgres.port,
    username: config.postgres.user,
    password: config.postgres.password,
    database: config.postgres.database,
    entities: [ProductOrmEntity],
    synchronize: false,
    logging: false,
  });
  await dataSource.initialize();

  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on('error', () => {
    /* The rate limiter fails open; a cache blip must not fail the suite. */
  });
  await redis.connect();

  const logger = pino({ level: 'silent' });
  const app = createApp({ config, dataSource, redis, logger });

  return {
    app,
    dataSource,
    redis,
    async truncate() {
      // TRUNCATE rather than DELETE: it also resets any sequences and is
      // constant-time regardless of row count.
      await dataSource.query('TRUNCATE TABLE "products"');
    },
    async close() {
      await dataSource.destroy();
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}

/** A valid create payload; override the fields a test cares about. */
export function productPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sku: 'BEV-COLA-330',
    name: 'Cola 330ml',
    description: 'Carbonated soft drink',
    category: 'beverage',
    priceMinor: 12_000,
    currency: 'VND',
    stock: 10,
    ...overrides,
  };
}
