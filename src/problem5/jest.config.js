/**
 * Two test projects, run separately.
 *
 * Unit tests use an in-memory repository and touch nothing external, so they
 * run in seconds and can be run on every save. Integration tests need Postgres
 * and Redis and run against a dedicated database. Splitting them into projects
 * is what lets the fast feedback loop stay fast without giving up the slow
 * half.
 *
 *   npm test                  both projects - the full suite
 *   npm run test:unit         unit only; needs nothing external
 *   npm run test:integration  integration only; needs Postgres + Redis
 *   npm run test:coverage     the full suite, with the 100% gate
 *
 * Coverage is measured over the *whole* suite: the repository and the
 * controller are exercised by the integration tests, so a unit-only run
 * reports far less and would fail the gate.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  /*
   * The whole suite runs in a single worker.
   *
   * Two reasons, both concrete:
   *
   *   1. **Correctness.** Every integration test shares one database and clears
   *      it with TRUNCATE between tests. That is only safe while they cannot
   *      run concurrently. Today the integration project is a single spec file,
   *      so Jest happens to give it one worker - safe by accident. Pinning the
   *      worker count makes it safe by design, and means splitting the suite
   *      into more files cannot introduce intermittent failures.
   *   2. **A stable coverage number.** A parallel run produced 99.53% exactly
   *      once in fifteen attempts and could not be reproduced. With the gate at
   *      100%, an unexplained flake fails somebody else's build. Serialising
   *      removes the variable rather than lowering the bar to hide it.
   *
   * The cost is small: the suite runs in about three seconds either way.
   */
  maxWorkers: 1,

  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
      clearMocks: true,
      restoreMocks: true,
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
      transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
      globalSetup: '<rootDir>/tests/integration/support/globalSetup.ts',
      globalTeardown: '<rootDir>/tests/integration/support/globalTeardown.ts',
      testTimeout: 30_000,
      clearMocks: true,
      restoreMocks: true,
    },
  ],

  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/index.ts',
    // Process entry point and developer scripts: exercised by running the
    // service, not by unit tests. Counting them would only invite tests that
    // assert nothing in order to move a number.
    '!src/main.ts',
    '!src/infrastructure/typeorm/seed.ts',
    '!src/infrastructure/typeorm/dataSource.ts',
    '!src/infrastructure/typeorm/migrations/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],

  // 100% across the board. Every branch in this service is a deliberate,
  // reachable decision - a status code, a concurrency outcome, a validation
  // rule - so an uncovered one means an untested edge case.
  //
  // Nothing is suppressed with an `istanbul ignore file` to reach that number.
  // The only branches that were ever unreachable were compiler output rather
  // than code: `emitDecoratorMetadata` compiles a Date-typed property to
  // `typeof Date !== "undefined" ? Date : Object`, whose fallback can never
  // execute. Rather than hide them behind an ignore comment, the flag itself
  // is off (see tsconfig.json) - every column here declares its `type`
  // explicitly anyway, which is the better practice regardless.
  //
  // The files excluded above are excluded by path, listed in the open, and are
  // process entry points and developer scripts rather than shipped logic.
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
};
