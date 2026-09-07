import { NegativeInputRejectedError } from '../domain/errors';
import type { NegativeDomainPolicy } from '../domain/types';

/**
 * `sum_to_n(-k) === -sum_to_n(k)` - the summation is treated as an odd function.
 *
 * This is the default. Rationale:
 *   * It matches the most common reading of "sum the integers from 1 to n"
 *     when the range runs backwards: `-1 + -2 + ... + n`.
 *   * It preserves the algebraic identity `f(-n) === -f(n)`, which makes the
 *     function composable and easy to reason about.
 *   * It never surprises a caller with a *positive* answer for a negative
 *     input, which the analytic continuation does (see below).
 *
 * `sum_to_n(-5) === -15`.
 */
export class SymmetricNegativePolicy implements NegativeDomainPolicy {
  public readonly name = 'symmetric';

  public apply(n: number, sumToNonNegative: (m: number) => number): number {
    return -sumToNonNegative(-n);
  }
}

/**
 * Negative inputs are a caller error and are rejected.
 *
 * The right choice when `n` originates from user input and any negative value
 * indicates a bug or an attack upstream - failing loudly beats inventing a
 * convention the caller did not ask for.
 */
export class RejectNegativePolicy implements NegativeDomainPolicy {
  public readonly name = 'reject';

  public apply(n: number): never {
    throw new NegativeInputRejectedError(n);
  }
}

/**
 * The range `1..n` is empty when `n < 0`, and the sum of an empty set is 0.
 *
 * Matches the behaviour of a naive `for (let i = 1; i <= n; i++)` loop, which
 * is what an unguarded iterative implementation does by accident. Offered
 * explicitly so that "the loop's behaviour" can be chosen on purpose rather
 * than inherited by omission.
 */
export class EmptyRangeNegativePolicy implements NegativeDomainPolicy {
  public readonly name = 'empty-range';

  public apply(): number {
    return 0;
  }
}

/**
 * The analytic continuation of Gauss's formula: evaluate `n(n+1)/2` literally.
 *
 * Using the standard convention `sum_{k=1}^{n} = -sum_{k=n+1}^{0}` for `n < 0`:
 *
 *   sum_to_n(-5) = -(0 + -1 + -2 + -3 + -4) = 10 = T(4) = T(|n| - 1)
 *
 * So the continuation is expressible through the same strategy interface as
 * `T(-n - 1)` - no bespoke arithmetic, and it stays consistent across all three
 * implementations. Mathematically the most defensible reading, but it returns a
 * *positive* number for a negative input, which surprises most callers; hence
 * it is available but not the default.
 */
export class GaussContinuationNegativePolicy implements NegativeDomainPolicy {
  public readonly name = 'gauss-continuation';

  public apply(n: number, sumToNonNegative: (m: number) => number): number {
    // n < 0, so -n - 1 >= 0 and no separate guard is needed.
    return sumToNonNegative(-n - 1);
  }
}
