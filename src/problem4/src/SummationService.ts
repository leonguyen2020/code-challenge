import { ExceedsStrategyLimitError } from './domain/errors';
import type {
  ComplexityProfile,
  InputValidator,
  NegativeDomainPolicy,
  SummationStrategy,
} from './domain/types';
import { SymmetricNegativePolicy } from './policies';
import { SafeIntegerValidator } from './validation/SafeIntegerValidator';

/** Construction options for {@link SummationService}. */
export interface SummationServiceOptions {
  /** The algorithm used to compute the sum. Required - there is no default. */
  readonly strategy: SummationStrategy;
  /** Input validation. Defaults to {@link SafeIntegerValidator}. */
  readonly validator?: InputValidator;
  /** Meaning of a negative input. Defaults to {@link SymmetricNegativePolicy}. */
  readonly negativeDomainPolicy?: NegativeDomainPolicy;
}

/** Introspection payload returned by {@link SummationService.describe}. */
export interface SummationServiceDescription {
  readonly strategy: string;
  readonly negativeDomainPolicy: string;
  readonly maxSupportedInput: number;
  readonly complexity: ComplexityProfile;
}

/**
 * Orchestrates validation, sign handling and computation.
 *
 * This class is where the three cross-cutting concerns live so that the
 * strategies do not have to repeat them:
 *
 *   1. **Validate** the untrusted input (delegated to an `InputValidator`).
 *   2. **Enforce** the active strategy's capability limit.
 *   3. **Interpret** negative inputs (delegated to a `NegativeDomainPolicy`).
 *
 * Every collaborator is injected and every one is an interface, so a caller can
 * swap the algorithm, tighten the input bound for a public endpoint, or change
 * the negative-number convention without touching a line of this class
 * (Open/Closed + Dependency Inversion). Instances are stateless and therefore
 * safe to share, reuse and call concurrently.
 */
export class SummationService {
  private readonly strategy: SummationStrategy;
  private readonly validator: InputValidator;
  private readonly negativeDomainPolicy: NegativeDomainPolicy;

  public constructor(options: SummationServiceOptions) {
    this.strategy = options.strategy;
    this.validator = options.validator ?? new SafeIntegerValidator();
    this.negativeDomainPolicy =
      options.negativeDomainPolicy ?? new SymmetricNegativePolicy();
  }

  /**
   * Computes the summation to `n`.
   *
   * @param value Untrusted input. Typed as `unknown` on purpose: the whole
   *              point of this method is that it does not trust its caller.
   * @throws {import('./domain/errors').SummationError} on any invalid input.
   */
  public compute(value: unknown): number {
    const n = this.validator.validate(value);

    const result =
      n >= 0
        ? this.computeGuarded(n)
        : this.negativeDomainPolicy.apply(n, this.computeGuarded);

    // Defensive normalisation of -0. A policy is free to return `-0` (e.g.
    // `-sumToNonNegative(0)`), and `-0` compares unequal under `Object.is`,
    // which surprises callers and breaks snapshot assertions.
    return result + 0;
  }

  /** Cost characteristics of the configured strategy. */
  public get complexity(): ComplexityProfile {
    return this.strategy.complexity;
  }

  /** Introspection, used by the benchmark harness and by diagnostics. */
  public describe(): SummationServiceDescription {
    return Object.freeze({
      strategy: this.strategy.name,
      negativeDomainPolicy: this.negativeDomainPolicy.name,
      maxSupportedInput: this.strategy.maxSupportedInput,
      complexity: this.strategy.complexity,
    });
  }

  /**
   * Calls the strategy, enforcing its capability limit first.
   *
   * Declared as a bound arrow property so it can be handed to a policy as a
   * plain callback without the policy needing to know about `this`. The limit
   * is therefore enforced on whatever magnitude the policy actually asks for,
   * not merely on the original input - which matters, because the symmetric
   * policy converts `-1_500_000` into a request for `T(1_500_000)`.
   */
  private readonly computeGuarded = (magnitude: number): number => {
    if (magnitude > this.strategy.maxSupportedInput) {
      throw new ExceedsStrategyLimitError(
        magnitude,
        this.strategy.name,
        this.strategy.maxSupportedInput,
      );
    }
    return this.strategy.sumToNonNegative(magnitude);
  };
}
