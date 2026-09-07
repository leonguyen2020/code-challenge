import { describe, expect, it } from '@jest/globals';
import { MAX_SAFE_N } from '../src/domain/constants';
import { IterativeSummation } from '../src/strategies';
import { exactTriangularAsNumber } from './helpers/oracle';

/**
 * Full-domain verification of the O(n) implementation.
 *
 * Excluded from the default run because a single assertion here executes 134
 * million loop iterations, which coverage instrumentation inflates into tens of
 * seconds - real cost, no extra defect-detection power over the sampled checks
 * in `differential.spec.ts`.
 *
 * It is kept, rather than deleted, because it is the only *direct* evidence
 * that repeated floating-point accumulation stays exact all the way to the
 * domain boundary. Run it before a release or when changing `MAX_SAFE_N`:
 *
 *     npm run test:heavy
 */
const describeHeavy = process.env['RUN_HEAVY_TESTS'] === '1' ? describe : describe.skip;

describeHeavy('heavy: full-domain verification (opt-in)', () => {
  const iterative = new IterativeSummation();

  it('iterative accumulation is exact at the domain maximum', () => {
    expect(iterative.sumToNonNegative(MAX_SAFE_N)).toBe(
      exactTriangularAsNumber(MAX_SAFE_N),
    );
  }, 600_000);

  it('every partial sum stays a safe integer up to the domain maximum', () => {
    // Walk the accumulator directly: the moment a partial sum stops being a
    // safe integer, exactness is lost for every subsequent term.
    let accumulator = 0;
    for (let i = 1; i <= MAX_SAFE_N; i++) {
      accumulator += i;
    }
    expect(Number.isSafeInteger(accumulator)).toBe(true);
    expect(accumulator).toBe(exactTriangularAsNumber(MAX_SAFE_N));
  }, 600_000);
});
