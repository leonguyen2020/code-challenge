import { describe, expect, it } from '@jest/globals';
import { MAX_SAFE_N } from '../src/domain/constants';
import { sum_to_n_a, sum_to_n_b, sum_to_n_c } from '../src/index';
import {
  createRandom,
  exactTriangularAsNumber,
  randomIntBetween,
} from './helpers/oracle';

/**
 * The `SummationStrategy` contract says every implementation must return
 * *identical* results, differing only in cost. Checking that by hand for a few
 * values proves very little; these tests check it mechanically.
 *
 * ## A note on test budget
 *
 * Only `sum_to_n_b` is O(n) now, and coverage instrumentation adds a counter to
 * every loop iteration - which multiplies its cost by roughly an order of
 * magnitude. Sampling it 5,000 times at values up to 1,000,000 would mean
 * billions of instrumented operations and a suite that runs for minutes.
 *
 * So the sampling is split by cost class rather than applied uniformly:
 *
 *   * **Broad, cheap:** the O(1) closed form and the O(log n) halving recursion
 *     are sampled heavily across the *entire* domain, where sample count costs
 *     almost nothing.
 *   * **Narrow, exhaustive:** all three are compared exhaustively over a small
 *     range, which is where off-by-one and sign errors actually live.
 *   * **Targeted:** the O(n) implementation is checked at a handful of large
 *     values and at every structurally interesting boundary.
 *
 * That gives the same defect-detection power for a suite that finishes in
 * seconds. Coverage of *lines* is not the same as coverage of *inputs*, and
 * neither is bought by burning CPU on redundant large samples.
 */

const expectedFor = (n: number): number =>
  n >= 0 ? exactTriangularAsNumber(n) : -exactTriangularAsNumber(-n);

describe('differential equivalence of the three implementations', () => {
  it('all three match the exact oracle for every n in [-1000, 1000]', () => {
    for (let n = -1000; n <= 1000; n++) {
      const expected = expectedFor(n);
      expect({ n, value: sum_to_n_a(n) }).toEqual({ n, value: expected });
      expect({ n, value: sum_to_n_b(n) }).toEqual({ n, value: expected });
      expect({ n, value: sum_to_n_c(n) }).toEqual({ n, value: expected });
    }
  });

  it('all three agree on 2,000 seeded random inputs in [-4000, 4000]', () => {
    // Seeded: a failure here is replayable, not a flake.
    const random = createRandom(0x5eed_1234);
    for (let i = 0; i < 2_000; i++) {
      const n = randomIntBetween(random, -4_000, 4_000);
      const a = sum_to_n_a(n);
      expect(sum_to_n_b(n)).toBe(a);
      expect(sum_to_n_c(n)).toBe(a);
      expect(a).toBe(expectedFor(n));
    }
  });

  it('the sub-linear pair agree at every power-of-two boundary in the domain', () => {
    for (let exponent = 0; exponent <= 27; exponent++) {
      for (const n of [2 ** exponent - 1, 2 ** exponent, 2 ** exponent + 1]) {
        if (n < 0 || n > MAX_SAFE_N) continue;
        const expected = exactTriangularAsNumber(n);
        expect(sum_to_n_a(n)).toBe(expected);
        expect(sum_to_n_c(n)).toBe(expected);
      }
    }
  });

  it('all three agree at every power-of-two boundary up to 2^17', () => {
    // Powers of two are where binary splitting changes shape and where the
    // float exponent changes binade - the two places an off-by-one would hide.
    for (let exponent = 0; exponent <= 17; exponent++) {
      for (const n of [2 ** exponent - 1, 2 ** exponent, 2 ** exponent + 1]) {
        const expected = exactTriangularAsNumber(n);
        expect(sum_to_n_a(n)).toBe(expected);
        expect(sum_to_n_b(n)).toBe(expected);
        expect(sum_to_n_c(n)).toBe(expected);
      }
    }
  });

  it('the O(n) implementation agrees with the others at large n', () => {
    // Few samples, deliberately: each one costs ~n instrumented operations.
    for (const n of [123_456, 500_000, 1_000_000]) {
      const expected = exactTriangularAsNumber(n);
      expect(sum_to_n_a(n)).toBe(expected);
      expect(sum_to_n_b(n)).toBe(expected);
      expect(sum_to_n_c(n)).toBe(expected);
    }
  });

  it('the sub-linear implementations agree across the ENTIRE domain', () => {
    // Both are cheap enough to sample aggressively at full scale - which was
    // impossible while sum_to_n_c was O(n) and capped at 1,000,000.
    const random = createRandom(0xbeef_4242);
    for (let i = 0; i < 20_000; i++) {
      const n = randomIntBetween(random, -MAX_SAFE_N, MAX_SAFE_N);
      const expected = expectedFor(n);
      expect(sum_to_n_a(n)).toBe(expected);
      expect(sum_to_n_c(n)).toBe(expected);
    }
  });

  it('all three agree at both ends of the domain', () => {
    for (const n of [0, 1, -1, MAX_SAFE_N, -MAX_SAFE_N]) {
      const expected = expectedFor(n);
      expect(sum_to_n_a(n)).toBe(expected);
      expect(sum_to_n_c(n)).toBe(expected);
      // sum_to_n_b is skipped at the extremes on purpose: 134M instrumented
      // iterations, verified instead by `npm run test:heavy`.
      if (Math.abs(n) <= 1) expect(sum_to_n_b(n)).toBe(expected);
    }
  });

  it('all three reject invalid input identically', () => {
    const invalid: readonly unknown[] = [
      '5', null, undefined, true, {}, [], Number.NaN,
      Number.POSITIVE_INFINITY, 1.5, 1e21,
    ];
    for (const value of invalid) {
      const codes = [sum_to_n_a, sum_to_n_b, sum_to_n_c].map((fn) => {
        try {
          (fn as unknown as (n: unknown) => number)(value);
          return 'NO_THROW';
        } catch (error) {
          return (error as { code: string }).code;
        }
      });
      // A value accepted by one and rejected by another would be an interface
      // violation, not a cosmetic inconsistency.
      expect(new Set(codes).size).toBe(1);
      expect(codes[0]).not.toBe('NO_THROW');
    }
  });
});

describe('algebraic properties', () => {
  it('recurrence: T(n) === T(n-1) + n', () => {
    const random = createRandom(0xc0ffee);
    for (let i = 0; i < 5_000; i++) {
      const n = randomIntBetween(random, 1, MAX_SAFE_N);
      expect(sum_to_n_c(n)).toBe(sum_to_n_c(n - 1) + n);
    }
    // Same property, sampled across the full domain via the O(1) form.
    for (let i = 0; i < 5_000; i++) {
      const n = randomIntBetween(random, 1, MAX_SAFE_N);
      expect(sum_to_n_a(n)).toBe(sum_to_n_a(n - 1) + n);
    }
  });

  it('oddness: T(-n) === -T(n)', () => {
    const random = createRandom(0x0dd_0dd);
    for (let i = 0; i < 300; i++) {
      const n = randomIntBetween(random, 0, 3_000);
      expect(sum_to_n_b(-n)).toBe(-sum_to_n_b(n));
    }
    for (let i = 0; i < 5_000; i++) {
      const n = randomIntBetween(random, 0, MAX_SAFE_N);
      expect(sum_to_n_c(-n)).toBe(-sum_to_n_c(n));
    }
    for (let i = 0; i < 5_000; i++) {
      const n = randomIntBetween(random, 0, MAX_SAFE_N);
      expect(sum_to_n_a(-n)).toBe(-sum_to_n_a(n));
    }
  });

  it('monotonicity: T is strictly increasing for n >= 1', () => {
    const random = createRandom(0x1_2345);
    for (let i = 0; i < 5_000; i++) {
      const n = randomIntBetween(random, 1, MAX_SAFE_N - 1);
      expect(sum_to_n_a(n + 1)).toBeGreaterThan(sum_to_n_a(n));
    }
  });

  it('doubling identity: 2*T(n) === n*(n+1)', () => {
    const random = createRandom(0x2_4680);
    for (let i = 0; i < 5_000; i++) {
      const n = randomIntBetween(random, 0, MAX_SAFE_N);
      expect(2 * sum_to_n_a(n)).toBe(n * (n + 1));
    }
  });

  it('every result is a safe integer', () => {
    const random = createRandom(0x5afe_1234);
    for (let i = 0; i < 5_000; i++) {
      const n = randomIntBetween(random, -MAX_SAFE_N, MAX_SAFE_N);
      expect(Number.isSafeInteger(sum_to_n_a(n))).toBe(true);
    }
  });
});
