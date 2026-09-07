/**
 * Numeric bounds of the problem domain.
 *
 * Every constant here is *derived*, not guessed, and `tests/constants.spec.ts`
 * re-derives each one with `BigInt` arithmetic at test time. If a future change
 * widens the domain, those tests fail loudly rather than letting silent
 * floating-point corruption ship.
 */

/**
 * The largest `n` for which `T(n) = 1 + 2 + ... + n` is still exactly
 * representable as an IEEE-754 double.
 *
 *   T(n) = n(n+1)/2 <= 2^53 - 1
 *   =>  n <= 134_217_727 = 2^27 - 1
 *
 *   T(134_217_727) = 9_007_199_187_632_128  <= Number.MAX_SAFE_INTEGER
 *   T(134_217_728) = 9_007_199_321_849_856  >  Number.MAX_SAFE_INTEGER
 *
 * The brief says "assume the input will always produce a result lesser than
 * Number.MAX_SAFE_INTEGER". We do not merely assume it - we enforce it, because
 * an unenforced assumption is a silent-corruption bug waiting for the first
 * caller who did not read the comment.
 */
export const MAX_SAFE_N = 134_217_727;

/**
 * Mirror of {@link MAX_SAFE_N} for negative inputs.
 *
 * Under the default symmetric convention `sum_to_n(-k) === -sum_to_n(k)`, so
 * the most negative representable result is `-T(MAX_SAFE_N)`, which sits
 * comfortably above `Number.MIN_SAFE_INTEGER`.
 */
export const MIN_SAFE_N = -MAX_SAFE_N;

/**
 * The largest `n` for which the *intermediate* product `n * (n + 1)` of the
 * naive Gauss formula still lands inside `[0, 2^53 - 1]`.
 *
 * Retained for documentation and regression tests only. See
 * `ClosedFormSummation` for the proof that exceeding this value is in fact
 * harmless *given* the `MAX_SAFE_N` bound - a non-obvious invariant that this
 * constant exists to keep visible.
 */
export const MAX_N_WITH_SAFE_NAIVE_PRODUCT = 94_906_265;

/** Upper bound on how much of a rejected value is echoed back in an error. */
export const MAX_ERROR_VALUE_PREVIEW_LENGTH = 32;
