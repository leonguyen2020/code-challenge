import { describe, expect, it } from '@jest/globals';
import { NegativeInputRejectedError } from '../src/domain/errors';
import {
  EmptyRangeNegativePolicy,
  GaussContinuationNegativePolicy,
  RejectNegativePolicy,
  SymmetricNegativePolicy,
} from '../src/policies';
import { exactTriangularAsNumber } from './helpers/oracle';

/** Stand-in for the guarded strategy accessor the service normally supplies. */
const sum = (m: number): number => exactTriangularAsNumber(m);

describe('SymmetricNegativePolicy (the default)', () => {
  const policy = new SymmetricNegativePolicy();

  it('is named', () => {
    expect(policy.name).toBe('symmetric');
  });

  it.each([
    [-1, -1],
    [-2, -3],
    [-5, -15],
    [-10, -55],
    [-100, -5050],
  ])('maps %p to %p', (input, expected) => {
    expect(policy.apply(input, sum)).toBe(expected);
  });

  it('preserves the odd-function identity f(-n) === -f(n)', () => {
    for (let n = 1; n <= 200; n++) {
      expect(policy.apply(-n, sum)).toBe(-sum(n));
    }
  });
});

describe('RejectNegativePolicy', () => {
  const policy = new RejectNegativePolicy();

  it('is named', () => {
    expect(policy.name).toBe('reject');
  });

  it('throws a typed error carrying the offending value', () => {
    expect(() => policy.apply(-5)).toThrow(NegativeInputRejectedError);
    try {
      policy.apply(-5);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as NegativeInputRejectedError).code).toBe(
        'ERR_NEGATIVE_INPUT_REJECTED',
      );
      expect((error as NegativeInputRejectedError).received).toBe(-5);
    }
  });
});

describe('EmptyRangeNegativePolicy', () => {
  const policy = new EmptyRangeNegativePolicy();

  it('is named', () => {
    expect(policy.name).toBe('empty-range');
  });

  it('returns 0, matching an unguarded `for (i = 1; i <= n; i++)` loop', () => {
    expect(policy.apply()).toBe(0);

    // Demonstrate the equivalence rather than assert it by hand.
    const naiveLoop = (n: number): number => {
      let acc = 0;
      for (let i = 1; i <= n; i++) acc += i;
      return acc;
    };
    expect(naiveLoop(-5)).toBe(0);
  });
});

describe('GaussContinuationNegativePolicy', () => {
  const policy = new GaussContinuationNegativePolicy();

  it('is named', () => {
    expect(policy.name).toBe('gauss-continuation');
  });

  it.each([
    [-1, 0],
    [-2, 1],
    [-5, 10],
    [-10, 45],
  ])('maps %p to %p', (input, expected) => {
    expect(policy.apply(input, sum)).toBe(expected);
  });

  it('agrees with evaluating n(n+1)/2 literally at negative n', () => {
    for (let n = -1; n >= -200; n--) {
      // `+ 0` normalises the reference value: at n = -1 the expression
      // (-1 * 0) / 2 evaluates to -0, and Object.is(-0, 0) is false. The
      // policy returns a normalised 0, which is the desired behaviour - so it
      // is the *reference* that needs normalising here, not the policy.
      expect(policy.apply(n, sum)).toBe((n * (n + 1)) / 2 + 0);
    }
  });

  it('the -0 hazard in that reference expression is real', () => {
    expect(Object.is((-1 * 0) / 2, -0)).toBe(true);
    expect(Object.is(new GaussContinuationNegativePolicy().apply(-1, sum), 0)).toBe(true);
  });
});

describe('policy comparison at n = -5', () => {
  it('shows why the convention must be a deliberate choice', () => {
    expect(new SymmetricNegativePolicy().apply(-5, sum)).toBe(-15);
    expect(new EmptyRangeNegativePolicy().apply()).toBe(0);
    expect(new GaussContinuationNegativePolicy().apply(-5, sum)).toBe(10);
    expect(() => new RejectNegativePolicy().apply(-5)).toThrow();
    // Four defensible answers for the same input. The brief specifies none of
    // them, so the module makes the choice explicit and configurable rather
    // than accidental.
  });
});
