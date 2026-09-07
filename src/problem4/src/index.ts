/**
 * Problem 4 - Three ways to sum to n.
 *
 * The brief asks for three implementations of `sum_to_n` plus a note on the
 * complexity of each. Those three functions are the public API below; the
 * machinery behind them exists because "any integer" is a wider and more
 * hostile input domain than it looks. See `README.md` and `docs/EDGE_CASES.md`.
 *
 * ## The three implementations at a glance
 *
 * | Function       | Algorithm                    | Time     | Space    | Max n       |
 * |----------------|------------------------------|----------|----------|-------------|
 * | `sum_to_n_a`   | Gauss closed form            | O(1)     | O(1)     | 134,217,727 |
 * | `sum_to_n_b`   | Iterative accumulation       | O(n)     | O(1)     | 134,217,727 |
 * | `sum_to_n_c`   | Recursion by value halving   | O(log n) | O(log n) | 134,217,727 |
 *
 * All three cover the entire domain and return identical results for every
 * input; this is enforced by a differential test rather than left to
 * inspection.
 *
 * ## Shared contract
 *
 * * Input is validated at runtime, because TypeScript types do not exist at
 *   runtime and this function may sit behind an HTTP handler.
 * * Negative `n` follows the symmetric convention: `sum_to_n(-5) === -15`.
 *   The brief leaves this undefined; the reasoning and the three alternative
 *   conventions are in `docs/EDGE_CASES.md`, and the convention is swappable
 *   via `SummationService`.
 * * Invalid input throws a typed `SummationError` carrying a stable `code`.
 *   Nothing is silently coerced and nothing returns `NaN`.
 */

import { SummationService } from './SummationService';
import {
  ClosedFormSummation,
  HalvingSummation,
  IterativeSummation,
} from './strategies';

/*
 * Module-level singletons. The services are stateless and immutable, so one
 * instance each is sufficient, allocation-free per call, and safe to share.
 */
const closedFormService = new SummationService({ strategy: new ClosedFormSummation() });
const iterativeService = new SummationService({ strategy: new IterativeSummation() });
const halvingService = new SummationService({ strategy: new HalvingSummation() });

/**
 * **Implementation A - Gauss's closed form.**
 *
 * `T(n) = n(n + 1) / 2`, evaluated so that the halving happens before the
 * multiplication.
 *
 * **Complexity: O(1) time, O(1) space.** Cost is independent of `n`: computing
 * the sum to 134 million is exactly as cheap as computing the sum to 1. This is
 * the implementation to use in production, and the only one of the three with
 * no algorithmic denial-of-service surface.
 *
 * @param n Any integer in `[-134217727, 134217727]`.
 * @throws {import('./domain/errors').SummationError} if `n` is not a finite
 *         integer within that domain.
 */
export function sum_to_n_a(n: number): number {
  return closedFormService.compute(n);
}

/**
 * **Implementation B - iterative accumulation.**
 *
 * A single `for` loop adding each term.
 *
 * **Complexity: O(n) time, O(1) space.** Linear in `n` with very small constant
 * factors; ~134 million iterations at the top of the domain, which blocks
 * Node's event loop for a noticeable interval. Obviously correct by inspection,
 * which is what makes it the oracle the other two are tested against - but it
 * should not be handed attacker-controlled input on a request path.
 *
 * @param n Any integer in `[-134217727, 134217727]`.
 * @throws {import('./domain/errors').SummationError} if `n` is not a finite
 *         integer within that domain.
 */
export function sum_to_n_b(n: number): number {
  return iterativeService.compute(n);
}

/**
 * **Implementation C - recursion on the value, by halving.**
 *
 *     T(2k)     = 2*T(k) + k^2
 *     T(2k + 1) = T(2k) + (2k + 1)
 *
 * **Complexity: O(log n) time, O(log n) space.** Each step halves `n`, so the
 * entire domain costs **27 calls** and 27 stack frames.
 *
 * Two recursive formulations were rejected on the way here:
 *
 *   * The textbook `n + sum(n - 1)` consumes one stack frame per term and dies
 *     with `RangeError: Maximum call stack size exceeded` around `n = 10,000`
 *     on V8 (measured: 10,381 frames), at a threshold that shifts with the
 *     caller's own stack depth.
 *   * Range splitting - `T(lo..hi) = T(lo..mid) + T(mid+1..hi)` - fixes the
 *     depth (27 frames) but leaves the call count linear at `2n - 1`, which
 *     would force an artificial cap on the input. Measured at ~10 ms for
 *     `n = 1,000,000`, against ~0.26 us for halving. Fixing stack depth is not
 *     the same as fixing cost; see `docs/EDGE_CASES.md`.
 *
 * @param n Any integer in `[-134217727, 134217727]`.
 * @throws {import('./domain/errors').SummationError} if `n` is not a finite
 *         integer within that domain.
 */
export function sum_to_n_c(n: number): number {
  return halvingService.compute(n);
}

/* -------------------------------------------------------------------------- */
/* Extension surface - exported so callers can compose their own configuration */
/* -------------------------------------------------------------------------- */

export {
  MAX_N_WITH_SAFE_NAIVE_PRODUCT,
  MAX_SAFE_N,
  MIN_SAFE_N,
} from './domain/constants';

export {
  ExceedsStrategyLimitError,
  InputOutOfRangeError,
  NegativeInputRejectedError,
  NonFiniteInputError,
  NonIntegerInputError,
  NonNumericInputError,
  SummationError,
  describeValue,
} from './domain/errors';
export type { SummationErrorCode } from './domain/errors';

export type {
  ComplexityProfile,
  InputValidator,
  NegativeDomainPolicy,
  SummationStrategy,
} from './domain/types';

export {
  EmptyRangeNegativePolicy,
  GaussContinuationNegativePolicy,
  RejectNegativePolicy,
  SymmetricNegativePolicy,
} from './policies';

export {
  ClosedFormSummation,
  HalvingSummation,
  IterativeSummation,
} from './strategies';

export { SafeIntegerValidator } from './validation/SafeIntegerValidator';

export { SummationService } from './SummationService';
export type {
  SummationServiceDescription,
  SummationServiceOptions,
} from './SummationService';
