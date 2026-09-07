import { MAX_SAFE_N, MIN_SAFE_N } from '../domain/constants';
import {
  InputOutOfRangeError,
  NonFiniteInputError,
  NonIntegerInputError,
  NonNumericInputError,
} from '../domain/errors';
import type { InputValidator } from '../domain/types';

/**
 * Validates that an untrusted value is a finite integer inside the exactly
 * representable domain.
 *
 * Why this exists at all, given the signature is `(n: number)`:
 *
 *   1. **TypeScript types are erased.** Any JavaScript consumer, any `as any`,
 *      any JSON payload, any `req.query.n` can deliver a string, `null`, or an
 *      object. Validating at the trust boundary is the only real defence.
 *   2. **Silent corruption is worse than a thrown error.** Without the range
 *      check, `sum_to_n(2 ** 30)` returns a plausible-looking number that is
 *      simply wrong. A financial or scoring system would propagate that.
 *   3. **Denial of service.** An unbounded `n` handed to an O(n) implementation
 *      blocks Node's single event-loop thread for minutes. Bounding the input
 *      before any loop runs turns an availability bug into a 400 response.
 *
 * Checks are ordered cheapest-and-most-general first so that hostile input is
 * rejected with the least work possible.
 */
export class SafeIntegerValidator implements InputValidator {
  public constructor(
    private readonly min: number = MIN_SAFE_N,
    private readonly max: number = MAX_SAFE_N,
  ) {}

  public validate(value: unknown): number {
    // 1. Type gate. Deliberately `typeof`, never a truthiness or `==` check:
    //    `"5" == 5` is true and would let strings through, and `Number(value)`
    //    would invoke an attacker-controlled `valueOf`.
    if (typeof value !== 'number') {
      throw new NonNumericInputError(value);
    }

    // 2. Finiteness. Catches NaN, Infinity and -Infinity in one predicate.
    //    NaN must be handled here because `typeof NaN === 'number'` and every
    //    comparison against NaN is false, so a later range check would pass it
    //    straight through.
    if (!Number.isFinite(value)) {
      throw new NonFiniteInputError(value);
    }

    // 3. Integrality. `Number.isInteger` is used rather than `value % 1 === 0`
    //    because the latter is true for -0 and for values so large they have no
    //    fractional precision left.
    if (!Number.isInteger(value)) {
      throw new NonIntegerInputError(value);
    }

    // 4. Normalise negative zero. `Object.is(-0, 0)` is false, so leaving it
    //    unnormalised would leak a `-0` result out of `sum_to_n(-0)` and break
    //    strict equality for callers and snapshot tests alike.
    const normalised = value + 0;

    // 5. Domain bound. Runs last because it is the only check that needs a
    //    known-good number to compare against.
    if (normalised < this.min || normalised > this.max) {
      throw new InputOutOfRangeError(normalised, this.min, this.max);
    }

    return normalised;
  }
}
