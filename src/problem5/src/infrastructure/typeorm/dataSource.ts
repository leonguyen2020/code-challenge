import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../../config/env';
import { bootstrapConfig } from '../../config/env';
import { ProductOrmEntity } from './ProductOrmEntity';
import { CreateProductsTable1735689600000 } from './migrations/1735689600000-CreateProductsTable';

/**
 * Builds the TypeORM data source.
 *
 * ## `synchronize` is false, permanently
 *
 * `synchronize: true` makes TypeORM diff the entities against the live schema
 * and alter it to match, on every boot. It is convenient for about a week and
 * then it drops a column because somebody renamed a property. Schema changes go
 * through reviewed, reversible migrations - including in development, so the
 * migrations are exercised long before they reach production.
 *
 * ## `migrationsRun` is also false
 *
 * Migrations are a deployment step, not a side effect of process start. Running
 * them automatically means N replicas racing to migrate the same database
 * during a rolling deploy.
 */
export function createDataSource(config: AppConfig): DataSource {
  return new DataSource({
    type: 'postgres',
    host: config.postgres.host,
    port: config.postgres.port,
    username: config.postgres.user,
    password: config.postgres.password,
    database: config.postgres.database,

    entities: [ProductOrmEntity],
    migrations: [CreateProductsTable1735689600000],

    synchronize: false,
    migrationsRun: false,

    // Log slow statements always, and every statement only when explicitly
    // asked. Full query logging in production is both a performance cost and a
    // way to write user data into log files.
    logging: config.logLevel === 'debug' || config.logLevel === 'trace'
      ? ['query', 'error', 'warn']
      : ['error', 'warn'],
    maxQueryExecutionTime: 500,

    poolSize: 10,
    extra: {
      // Fail fast when the database is unreachable rather than piling up
      // requests that are all going to time out anyway.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      // A statement that has run for 15 s in an API request is never going to
      // produce a useful response; killing it protects the connection pool.
      statement_timeout: 15_000,
    },
  });
}

/**
 * Default export for the TypeORM CLI (`npm run migration:run`).
 *
 * The CLI instantiates this module directly and has no access to the
 * application's dependency graph, so it builds its own config here.
 */
export default createDataSource(bootstrapConfig());
