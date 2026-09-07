import { MAX_SAFE_N } from '../domain/constants';
import type { ComplexityProfile, SummationStrategy } from '../domain/types';

/**
 * Gauss's closed form: `T(n) = n(n + 1) / 2`.
 *
 * ## Complexity
 *
 * **Time O(1), space O(1).** Two arithmetic operations and one comparison,
 * independent of `n`. This is the only implementation of the three that is
 * safe to place on a hot request path: `T(134_217_727)` costs exactly as much
 * as `T(1)`.
 *
 * ## Why the division is done before the multiplication
 *
 * The obvious spelling is `(n * (n + 1)) / 2`. This version instead halves the
 * even factor first:
 *
 *     n even -> (n / 2) * (n + 1)
 *     n odd  -> n * ((n + 1) / 2)
 *
 * Exactly one of `n` and `n + 1` is even, so the halving is always exact and
 * the intermediate value is roughly halved - it never leaves `[0, 2^53 - 1]`.
 *
 * Full disclosure: **the naive spelling is also exact over this domain**, and
 * that was verified by exhaustive comparison against a `BigInt` oracle rather
 * than assumed. The reason is subtle - `n * (n + 1)` is always even, its
 * maximum is `2^54 - 2^27 < 2^54`, and every *even* integer up to `2^54` is
 * exactly representable as a double, so the product survives and the halving is
 * lossless. The naive form is therefore correct, but only because of an
 * invariant that depends on `MAX_SAFE_N` being what it is. Raise the bound and
 * it breaks silently. The halved form keeps the intermediate value a full
 * binade below the danger zone, so it does not depend on that invariant at all.
 * When correctness costs one comparison, buy it.
 *
 * `tests/closedForm.spec.ts` pins both facts so a future edit cannot quietly
 * invalidate this reasoning.
 */
export class ClosedFormSummation implements SummationStrategy {
  public readonly name = 'closed-form';

  public readonly maxSupportedInput = MAX_SAFE_N;

  public readonly complexity: ComplexityProfile = Object.freeze({
    time: 'O(1)',
    space: 'O(1)',
    rationale:
      'Constant number of arithmetic operations regardless of n. Preferred for ' +
      'any request-serving path; the only variant with no input-size-dependent ' +
      'cost and therefore no algorithmic denial-of-service surface.',
  });

  public sumToNonNegative(n: number): number {
    return n % 2 === 0
      ? (n / 2) * (n + 1)
      : n * ((n + 1) / 2);
  }
}
