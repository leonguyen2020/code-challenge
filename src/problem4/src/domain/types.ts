/**
 * Core abstractions.
 *
 * The interfaces here are what make the module extensible without modification
 * (Open/Closed) and testable without mocks (Dependency Inversion): the service
 * depends on these contracts, never on a concrete implementation.
 */

/** Human-readable cost description attached to each strategy. */
export interface ComplexityProfile {
  /** Big-O time cost, e.g. `"O(1)"`. */
  readonly time: string;
  /** Big-O auxiliary space cost, e.g. `"O(log n)"`. */
  readonly space: string;
  /** Why those bounds hold, and what they mean in practice. */
  readonly rationale: string;
}

/**
 * A single way of computing the triangular number `T(n) = 1 + 2 + ... + n`.
 *
 * Contract (Liskov): every implementation must be a **pure function** of `n`
 * and must return the exact same value as every other implementation for every
 * `n` in `[0, maxSupportedInput]`. Implementations differ only in cost, never
 * in result. `tests/differential.spec.ts` enforces this mechanically.
 *
 * Note the narrow surface: a strategy handles **non-negative** inputs only.
 * Sign handling, validation and limit enforcement are separate responsibilities
 * owned by collaborators, so that logic is written once rather than five times
 * (SRP + DRY).
 */
export interface SummationStrategy {
  /** Stable identifier, used in errors and benchmark output. */
  readonly name: string;

  /** Cost characteristics of this implementation. */
  readonly complexity: ComplexityProfile;

  /**
   * Largest `n` this strategy accepts. May be lower than the domain maximum
   * when the algorithm's cost makes larger inputs impractical.
   */
  readonly maxSupportedInput: number;

  /**
   * Computes `T(n)`.
   *
   * @param n A validated integer in `[0, maxSupportedInput]`. Implementations
   *          may assume this precondition; the service guarantees it.
   */
  sumToNonNegative(n: number): number;
}

/**
 * Turns an untrusted value into a number that is known to be inside the domain.
 *
 * Kept separate from `SummationStrategy` (Interface Segregation): a strategy
 * has no business knowing what a valid input looks like, and a validator has no
 * business knowing how the sum is computed.
 */
export interface InputValidator {
  /**
   * @throws {import('./errors').SummationError} if the value is not a finite
   *         integer inside the domain.
   */
  validate(value: unknown): number;
}

/**
 * Decides what `sum_to_n(n)` means when `n < 0`.
 *
 * The brief says the input is "any integer" but only defines the result for
 * positive `n`, so the negative branch is genuinely ambiguous. Rather than bake
 * one reading in, the reading is a strategy in its own right - see
 * `docs/EDGE_CASES.md` for the four candidate conventions and why the symmetric
 * one is the default.
 */
export interface NegativeDomainPolicy {
  /** Stable identifier, surfaced by `SummationService.describe()`. */
  readonly name: string;

  /**
   * @param n              The validated, strictly negative input.
   * @param sumToNonNegative Guarded accessor to the active strategy. Policies
   *                       express themselves in terms of the non-negative case
   *                       so the arithmetic is never duplicated.
   */
  apply(n: number, sumToNonNegative: (m: number) => number): number;
}
