import { bootstrapConfig, type AppConfig } from '../../../src/config/env';

/**
 * Integration tests run against a **dedicated database**, never the development
 * one.
 *
 * Sharing a database means the tests either see leftover rows (making them
 * order-dependent) or truncate the developer's data (making them hostile). A
 * separate database, dropped and recreated from the migrations on every run,
 * gives both isolation and a continuous check that the migrations actually
 * produce the schema the code expects.
 */
export function testDatabaseName(): string {
  return `${bootstrapConfig().postgres.database}_test`;
}

/** Application config pointed at the test database. */
export function testConfig(): AppConfig {
  const base = bootstrapConfig();
  return Object.freeze({
    ...base,
    nodeEnv: 'test' as const,
    isProduction: false,
    logLevel: 'silent',
    postgres: Object.freeze({ ...base.postgres, database: testDatabaseName() }),
    // The rate limiter is exercised by its own test. Everywhere else it would
    // just make the suite flaky as the request count grows.
    rateLimit: Object.freeze({ windowSeconds: 60, maxRequests: 100_000 }),
  });
}
