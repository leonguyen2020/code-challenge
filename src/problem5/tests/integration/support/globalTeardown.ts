/**
 * The test database is deliberately left in place.
 *
 * `globalSetup` drops and recreates it at the start of every run, so there is
 * no stale state to worry about - and keeping it afterwards means a failing
 * test can be investigated by querying the exact rows that caused it. Dropping
 * it here would destroy the evidence at the moment it is most useful.
 */
export default async function globalTeardown(): Promise<void> {
  // Intentionally empty.
}
