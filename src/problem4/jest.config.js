/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.spec.ts'],

  collectCoverage: false,
  collectCoverageFrom: [
    'src/**/*.ts',
    // Barrel files re-export only; they carry no branches worth gating on.
    '!src/**/index.ts',
    // The benchmark is a developer tool, not shipped logic.
    '!src/benchmark.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],

  // Hard gate. The brief asks for >= 90%; we hold the bar at 100% for
  // branches/functions/lines because every branch in this module is a
  // deliberate, reachable decision - an uncovered one means an untested
  // edge case, which is exactly what this problem is about.
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },

  // Inherit tsconfig.json verbatim. Overriding `module` here would conflict
  // with `moduleResolution: Node16`, which requires the matching module mode.
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 30_000,
};
