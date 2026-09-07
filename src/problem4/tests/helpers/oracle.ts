/**
 * Test-only reference implementations.
 *
 * These are deliberately *not* the production code: an oracle that shares an
 * implementation with the code under test proves nothing. `BigInt` arithmetic
 * is arbitrary-precision, so it cannot suffer the floating-point failure modes
 * we are checking for.
 */

/** Exact triangular number via arbitrary-precision arithmetic. */
export function exactTriangular(n: number): bigint {
  const big = BigInt(n);
  return (big * (big + 1n)) / 2n;
}

/** Exact triangular number, returned as a `number`. Only valid inside the domain. */
export function exactTriangularAsNumber(n: number): number {
  return Number(exactTriangular(n));
}

/**
 * The *naive* Gauss spelling, kept only so a regression test can assert the
 * documented claim that it happens to be exact over the validated domain.
 */
export function naiveGauss(n: number): number {
  return (n * (n + 1)) / 2;
}

/**
 * A deterministic PRNG (mulberry32).
 *
 * Property tests must be reproducible: a failure that cannot be replayed is a
 * flaky test, not a finding. A fixed seed gives the breadth of random sampling
 * with none of the nondeterminism, and no third-party dependency to vet.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in `[min, max]` from a seeded generator. */
export function randomIntBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}
