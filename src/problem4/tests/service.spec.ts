import { describe, expect, it } from '@jest/globals';
import { SummationService } from '../src/SummationService';
import { MAX_SAFE_N } from '../src/domain/constants';
import {
  ExceedsStrategyLimitError,
  InputOutOfRangeError,
  NegativeInputRejectedError,
  NonNumericInputError,
} from '../src/domain/errors';
import type { ComplexityProfile, SummationStrategy } from '../src/domain/types';
import {
  EmptyRangeNegativePolicy,
  GaussContinuationNegativePolicy,
  RejectNegativePolicy,
} from '../src/policies';
import {
  ClosedFormSummation,
  HalvingSummation,
  IterativeSummation,
} from '../src/strategies';
import { SafeIntegerValidator } from '../src/validation/SafeIntegerValidator';
import { exactTriangularAsNumber } from './helpers/oracle';

describe('SummationService', () => {
  const service = new SummationService({ strategy: new ClosedFormSummation() });

  describe('defaults', () => {
    it('uses SafeIntegerValidator and the symmetric negative policy', () => {
      expect(service.describe().negativeDomainPolicy).toBe('symmetric');
      expect(service.compute(-5)).toBe(-15);
      expect(() => service.compute('5')).toThrow(NonNumericInputError);
    });
  });

  describe('compute', () => {
    it.each([
      [0, 0],
      [1, 1],
      [2, 3],
      [5, 15],
      [100, 5050],
    ])('sum_to_n(%p) === %p', (input, expected) => {
      expect(service.compute(input)).toBe(expected);
    });

    it('never returns negative zero', () => {
      expect(Object.is(service.compute(0), 0)).toBe(true);
      expect(Object.is(service.compute(-0), 0)).toBe(true);
    });

    it('is exact at the domain boundary', () => {
      expect(service.compute(MAX_SAFE_N)).toBe(exactTriangularAsNumber(MAX_SAFE_N));
      expect(service.compute(-MAX_SAFE_N)).toBe(-exactTriangularAsNumber(MAX_SAFE_N));
    });
  });

  describe('describe()', () => {
    it('reports the active configuration and is frozen', () => {
      const description = service.describe();
      expect(description).toEqual({
        strategy: 'closed-form',
        negativeDomainPolicy: 'symmetric',
        maxSupportedInput: MAX_SAFE_N,
        complexity: expect.objectContaining({ time: 'O(1)', space: 'O(1)' }),
      });
      expect(Object.isFrozen(description)).toBe(true);
    });
  });

  describe('complexity getter', () => {
    it('forwards the strategy profile', () => {
      expect(service.complexity.time).toBe('O(1)');
      expect(
        new SummationService({ strategy: new IterativeSummation() }).complexity.time,
      ).toBe('O(n)');
      expect(
        new SummationService({ strategy: new HalvingSummation() }).complexity.time,
      ).toBe('O(log n)');
    });
  });

  describe('strategy capability limits', () => {
    // All three shipped strategies cover the whole domain, so the limit
    // mechanism is exercised through a deliberately narrow strategy. It stays
    // part of the contract because `maxSupportedInput` is declared by the
    // interface: any future strategy with a genuine ceiling gets enforcement
    // and a typed error for free.
    const narrow: SummationStrategy = {
      name: 'narrow-test-strategy',
      maxSupportedInput: 100,
      complexity: Object.freeze<ComplexityProfile>({
        time: 'O(1)',
        space: 'O(1)',
        rationale: 'Test double with a deliberately low ceiling.',
      }),
      sumToNonNegative: (n) => (n * (n + 1)) / 2,
    };
    const narrowService = new SummationService({ strategy: narrow });

    it('accepts input exactly at the limit', () => {
      expect(narrowService.compute(100)).toBe(5050);
    });

    it('rejects input one past the limit with a typed, actionable error', () => {
      expect(() => narrowService.compute(101)).toThrow(ExceedsStrategyLimitError);
      try {
        narrowService.compute(101);
        throw new Error('expected a throw');
      } catch (error) {
        const typed = error as ExceedsStrategyLimitError;
        expect(typed.code).toBe('ERR_EXCEEDS_STRATEGY_LIMIT');
        expect(typed.strategyName).toBe('narrow-test-strategy');
        expect(typed.limit).toBe(100);
        expect(typed.message).toMatch(/closed form/i);
      }
    });

    it('applies the limit to the MAGNITUDE a policy requests, not the raw input', () => {
      // The symmetric policy turns -101 into a request for T(101). A limit
      // check on the raw (negative) input alone would let that through and
      // then run the very computation the limit exists to prevent.
      expect(() => narrowService.compute(-101)).toThrow(ExceedsStrategyLimitError);
      expect(narrowService.compute(-100)).toBe(-5050);
    });

    it('applies the limit through the Gauss-continuation policy too', () => {
      const gaussService = new SummationService({
        strategy: narrow,
        negativeDomainPolicy: new GaussContinuationNegativePolicy(),
      });
      // The continuation asks for T(|n| - 1), so the boundary shifts by one.
      expect(gaussService.compute(-101)).toBe(5050);
      expect(() => gaussService.compute(-102)).toThrow(ExceedsStrategyLimitError);
    });

    it('the shipped strategies have no ceiling below the domain maximum', () => {
      for (const strategy of [
        new ClosedFormSummation(),
        new IterativeSummation(),
        new HalvingSummation(),
      ]) {
        expect(strategy.maxSupportedInput).toBe(MAX_SAFE_N);
      }
    });
  });

  describe('dependency injection', () => {
    it('accepts a tightened validator, e.g. for a public endpoint', () => {
      const hardened = new SummationService({
        strategy: new IterativeSummation(),
        validator: new SafeIntegerValidator(0, 1_000),
      });
      expect(hardened.compute(1_000)).toBe(500_500);
      expect(() => hardened.compute(1_001)).toThrow(InputOutOfRangeError);
      expect(() => hardened.compute(-1)).toThrow(InputOutOfRangeError);
    });

    it('accepts an alternative negative-domain policy', () => {
      const rejecting = new SummationService({
        strategy: new ClosedFormSummation(),
        negativeDomainPolicy: new RejectNegativePolicy(),
      });
      expect(rejecting.compute(5)).toBe(15);
      expect(() => rejecting.compute(-5)).toThrow(NegativeInputRejectedError);
      expect(rejecting.describe().negativeDomainPolicy).toBe('reject');

      const empty = new SummationService({
        strategy: new ClosedFormSummation(),
        negativeDomainPolicy: new EmptyRangeNegativePolicy(),
      });
      expect(empty.compute(-5)).toBe(0);
    });

    it('accepts an entirely custom strategy without modifying the service', () => {
      // Open/Closed in one assertion: a brand-new algorithm plugs in with no
      // change to SummationService, the validator, or any policy.
      const memoised: SummationStrategy = {
        name: 'memoised-lookup',
        maxSupportedInput: 10,
        complexity: Object.freeze<ComplexityProfile>({
          time: 'O(1)',
          space: 'O(k)',
          rationale: 'Precomputed table for a tiny fixed domain.',
        }),
        sumToNonNegative: (n) => [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55][n] as number,
      };
      const custom = new SummationService({ strategy: memoised });
      expect(custom.compute(5)).toBe(15);
      expect(custom.compute(-5)).toBe(-15);
      expect(custom.describe().strategy).toBe('memoised-lookup');
      expect(() => custom.compute(11)).toThrow(ExceedsStrategyLimitError);
    });
  });

  describe('statelessness', () => {
    it('is safe to reuse and interleave', () => {
      const shared = new SummationService({ strategy: new IterativeSummation() });
      const sequence = [5, 100, 0, -5, 1, -100, 5];
      const firstPass = sequence.map((n) => shared.compute(n));
      const secondPass = sequence.map((n) => shared.compute(n));
      expect(secondPass).toEqual(firstPass);
      expect(firstPass).toEqual([15, 5050, 0, -15, 1, -5050, 15]);
    });

    it('does not leak state between instances', () => {
      const a = new SummationService({ strategy: new ClosedFormSummation() });
      const b = new SummationService({
        strategy: new ClosedFormSummation(),
        negativeDomainPolicy: new EmptyRangeNegativePolicy(),
      });
      expect(a.compute(-5)).toBe(-15);
      expect(b.compute(-5)).toBe(0);
      expect(a.compute(-5)).toBe(-15);
    });
  });
});
