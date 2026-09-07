import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { bootstrapConfig } from '../../../src/config/env';
import { ProductOrmEntity } from '../../../src/infrastructure/typeorm/ProductOrmEntity';
import { CreateProductsTable1735689600000 } from '../../../src/infrastructure/typeorm/migrations/1735689600000-CreateProductsTable';
import { testDatabaseName } from './testDatabase';

/**
 * Creates the test database from scratch and applies the migrations.
 *
 * Running the real migrations rather than `synchronize: true` is the point: it
 * means every integration test also verifies that the migration produces a
 * schema the application can actually use. A migration that is never executed
 * before production is a migration nobody has tested.
 */
export default async function globalSetup(): Promise<void> {
  const config = bootstrapConfig();
  const database = testDatabaseName();

  // `postgres` is the maintenance database: CREATE DATABASE cannot run from
  // inside the database being created.
  const admin = new DataSource({
    type: 'postgres',
    host: config.postgres.host,
    port: config.postgres.port,
    username: config.postgres.user,
    password: config.postgres.password,
    database: 'postgres',
  });
  await admin.initialize();
  // Terminate stragglers first: CREATE/DROP DATABASE fails while any session is
  // still connected, and a previous crashed run leaves exactly that behind.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.destroy();

  const test = new DataSource({
    type: 'postgres',
    host: config.postgres.host,
    port: config.postgres.port,
    username: config.postgres.user,
    password: config.postgres.password,
    database,
    entities: [ProductOrmEntity],
    migrations: [CreateProductsTable1735689600000],
    synchronize: false,
  });
  await test.initialize();
  // The Docker init script creates these in the development database only.
  await test.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await test.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await test.runMigrations();
  await test.destroy();

  // NOTE: `process.env.POSTGRES_DB` is deliberately NOT set here. Workers
  // inherit this process's environment, and `testDatabaseName()` derives the
  // name by appending "_test" to the configured database - so overwriting the
  // variable makes each worker append the suffix a second time and look for
  // "<db>_test_test".
}
