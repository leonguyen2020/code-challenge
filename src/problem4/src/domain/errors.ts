import { MAX_ERROR_VALUE_PREVIEW_LENGTH } from './constants';

/**
 * Stable, machine-readable error codes.
 *
 * Callers branch on `error.code`, never on `error.message`. Message text is a
 * human affordance and may be reworded; the code is API surface and may not.
 */
export type SummationErrorCode =
  | 'ERR_NON_NUMERIC_INPUT'
  | 'ERR_NON_FINITE_INPUT'
  | 'ERR_NON_INTEGER_INPUT'
  | 'ERR_INPUT_OUT_OF_RANGE'
  | 'ERR_NEGATIVE_INPUT_REJECTED'
  | 'ERR_EXCEEDS_STRATEGY_LIMIT';

/**
 * Renders an arbitrary value for inclusion in an error message.
 *
 * SECURITY - this function deliberately never triggers user-controlled code:
 *   * It does not interpolate objects, so a hostile `toString`/`valueOf`/
 *     `Symbol.toPrimitive` cannot run, throw, spin, or exfiltrate during error
 *     construction. Only the *type* is reported for non-primitives.
 *   * Strings are truncated and JSON-escaped, so an attacker cannot forge log
 *     lines with embedded newlines or control characters (log injection), nor
 *     blow up memory by submitting a 100 MB string.
 */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'undefined':
    case 'boolean':
    case 'number':
      // Safe: these have no overridable coercion path.
      return String(value);
    case 'bigint':
      return `${String(value)}n`;
    case 'string': {
      const clipped = value.length > MAX_ERROR_VALUE_PREVIEW_LENGTH
        ? `${value.slice(0, MAX_ERROR_VALUE_PREVIEW_LENGTH)}...`
        : value;
      return JSON.stringify(clipped);
    }
    default:
      // object | function | symbol - report the type only, never the value.
      return `[${typeof value}]`;
  }
}

/** Base class for every error this module raises. */
export abstract class SummationError extends Error {
  public abstract readonly code: SummationErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Required for `instanceof` to survive TypeScript's ES5-compatible class
    // downlevelling; harmless on modern targets.
    Object.setPrototypeOf(this, new.target.prototype);
    /* istanbul ignore else -- V8-only API; the else branch is unreachable on Node. */
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** The argument was not of type `number` at runtime. */
export class NonNumericInputError extends SummationError {
  public readonly code = 'ERR_NON_NUMERIC_INPUT' as const;

  public constructor(public readonly received: unknown) {
    super(
      `Expected a number but received ${describeValue(received)} ` +
        `(typeof "${typeof received}"). TypeScript types are erased at runtime, ` +
        `so this input was validated rather than trusted.`,
    );
  }
}

/** The argument was `NaN`, `Infinity` or `-Infinity`. */
export class NonFiniteInputError extends SummationError {
  public readonly code = 'ERR_NON_FINITE_INPUT' as const;

  public constructor(public readonly received: number) {
    super(`Expected a finite number but received ${describeValue(received)}.`);
  }
}

/** The argument was a finite number with a fractional part. */
export class NonIntegerInputError extends SummationError {
  public readonly code = 'ERR_NON_INTEGER_INPUT' as const;

  public constructor(public readonly received: number) {
    super(
      `Expected an integer but received ${describeValue(received)}. ` +
        `Summation to a non-integer is undefined in this domain.`,
    );
  }
}

/** The argument was an integer, but outside the exactly-representable domain. */
export class InputOutOfRangeError extends SummationError {
  public readonly code = 'ERR_INPUT_OUT_OF_RANGE' as const;

  public constructor(
    public readonly received: number,
    public readonly min: number,
    public readonly max: number,
  ) {
    super(
      `Input ${describeValue(received)} is outside the safe domain ` +
        `[${min}, ${max}]. Beyond this range the summation exceeds ` +
        `Number.MAX_SAFE_INTEGER and the result would be silently inexact.`,
    );
  }
}

/** A negative input reached a policy configured to reject negatives. */
export class NegativeInputRejectedError extends SummationError {
  public readonly code = 'ERR_NEGATIVE_INPUT_REJECTED' as const;

  public constructor(public readonly received: number) {
    super(
      `Input ${describeValue(received)} is negative and the configured ` +
        `negative-domain policy rejects negative inputs.`,
    );
  }
}

/**
 * The input is valid for the domain but beyond what this particular strategy
 * can compute in reasonable time or stack space.
 *
 * **Unreachable through `sum_to_n_a/b/c`, by construction.** All three shipped
 * strategies set `maxSupportedInput = MAX_SAFE_N`, which is exactly the bound
 * `SafeIntegerValidator` already enforces, so the guard in `SummationService`
 * can never fire for them. That is deliberate rather than an oversight: the
 * limit exists for *custom* strategies supplied through
 * `new SummationService({ strategy })` - an O(n) implementation on a request
 * path might reasonably cap itself far lower than the domain does, and the
 * service enforces whatever cap the strategy declares.
 *
 * It is documented here so the guard is not mistaken for a live defence of the
 * three public functions. Their defence is the validator; this is the seam that
 * lets someone tighten it.
 */
export class ExceedsStrategyLimitError extends SummationError {
  public readonly code = 'ERR_EXCEEDS_STRATEGY_LIMIT' as const;

  public constructor(
    public readonly received: number,
    public readonly strategyName: string,
    public readonly limit: number,
  ) {
    super(
      `Strategy "${strategyName}" supports inputs up to ${limit}, but ` +
        `${describeValue(received)} was requested. Use a strategy with a ` +
        `lower asymptotic cost (e.g. the closed form) for inputs this large.`,
    );
  }
}
