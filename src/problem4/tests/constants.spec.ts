import { describe, expect, it } from '@jest/globals';
import {
  MAX_N_WITH_SAFE_NAIVE_PRODUCT,
  MAX_SAFE_N,
  MIN_SAFE_N,
} from '../src/domain/constants';
import { exactTriangular } from './helpers/oracle';

/**
 * The domain bounds are load-bearing: every correctness guarantee in this
 * module is conditional on them. So rather than trust the literals, each one is
 * re-derived here from first principles with exact arithmetic. If someone
 * widens a bound without redoing the maths, these fail.
 */
describe('domain constants', () => {
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

  it('MAX_SAFE_N is the largest n whose triangular number is a safe integer', () => {
    expect(exactTriangular(MAX_SAFE_N)).toBeLessThanOrEqual(MAX_SAFE);
    expect(exactTriangular(MAX_SAFE_N + 1)).toBeGreaterThan(MAX_SAFE);
  });

  it('MAX_SAFE_N equals 2^27 - 1', () => {
    expect(MAX_SAFE_N).toBe(2 ** 27 - 1);
    expect(MAX_SAFE_N).toBe(134_217_727);
  });

  it('the maximum representable result round-trips exactly through a double', () => {
    const exact = exactTriangular(MAX_SAFE_N);
    expect(Number.isSafeInteger(Number(exact))).toBe(true);
    expect(BigInt(Number(exact))).toBe(exact);
  });

  it('MIN_SAFE_N mirrors MAX_SAFE_N and stays above Number.MIN_SAFE_INTEGER', () => {
    expect(MIN_SAFE_N).toBe(-MAX_SAFE_N);
    expect(-exactTriangular(MAX_SAFE_N)).toBeGreaterThanOrEqual(
      BigInt(Number.MIN_SAFE_INTEGER),
    );
  });

  it('MAX_N_WITH_SAFE_NAIVE_PRODUCT is the last n whose n*(n+1) fits in 2^53-1', () => {
    const n = BigInt(MAX_N_WITH_SAFE_NAIVE_PRODUCT);
    expect(n * (n + 1n)).toBeLessThanOrEqual(MAX_SAFE);
    expect((n + 1n) * (n + 2n)).toBeGreaterThan(MAX_SAFE);
  });

  it('halving needs only logarithmic depth across the whole domain', () => {
    // ceil(log2 n) + 1 frames, against V8's ~10,000 frame ceiling.
    expect(Math.ceil(Math.log2(MAX_SAFE_N)) + 1).toBeLessThan(50);
  });
});
