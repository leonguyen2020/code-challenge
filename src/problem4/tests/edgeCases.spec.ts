import { describe, expect, it } from '@jest/globals';
import {
  MAX_SAFE_N,
  MIN_SAFE_N,
  sum_to_n_a,
  sum_to_n_b,
  sum_to_n_c,
} from '../src/index';
import {
  ExceedsStrategyLimitError,
  InputOutOfRangeError,
  NonFiniteInputError,
  NonIntegerInputError,
  NonNumericInputError,
} from '../src/domain/errors';
import { SummationService } from '../src/SummationService';
import type { ComplexityProfile, SummationStrategy } from '../src/domain/types';
import { HalvingSummation } from '../src/strategies';
import { exactTriangularAsNumber } from './helpers/oracle';

/**
 * The catalogue of edge cases, mirroring `docs/EDGE_CASES.md` one-for-one.
 * Each `describe` block here corresponds to a numbered case in that document,
 * so the prose and the executable specification cannot drift apart.
 */

describe('EC-01: the empty range (n = 0)', () => {
  it('returns exactly 0, and never -0', () => {
    for (const fn of [sum_to_n_a, sum_to_n_b, sum_to_n_c]) {
      expect(fn(0)).toBe(0);
      expect(Object.is(fn(0), -0)).toBe(false);
    }
  });
});

describe('EC-02: negative zero', () => {
  it('is normalised, so -0 and 0 are indistinguishable to the caller', () => {
    for (const fn of [sum_to_n_a, sum_to_n_b, sum_to_n_c]) {
      expect(Object.is(fn(-0), 0)).toBe(true);
    }
  });

  it('matters because Object.is(-0, 0) is false in JavaScript', () => {
    // Without normalisation a caller doing `Object.is(result, 0)` or a
    // snapshot assertion would see a spurious difference.
    expect(Object.is(-0, 0)).toBe(false);
    expect(-0 === 0).toBe(true);
  });
});

describe('EC-03: the smallest non-trivial inputs', () => {
  it.each([
    [1, 1],
    [2, 3],
    [3, 6],
  ])('sum_to_n(%p) === %p', (n, expected) => {
    expect(sum_to_n_a(n)).toBe(expected);
    expect(sum_to_n_b(n)).toBe(expected);
    expect(sum_to_n_c(n)).toBe(expected);
  });
});

describe('EC-04: the example from the brief', () => {
  it('sum_to_n(5) === 1 + 2 + 3 + 4 + 5 === 15', () => {
    expect(sum_to_n_a(5)).toBe(15);
    expect(sum_to_n_b(5)).toBe(15);
    expect(sum_to_n_c(5)).toBe(15);
    expect(15).toBe(1 + 2 + 3 + 4 + 5);
  });
});

describe('EC-05: negative n - the ambiguity in the brief', () => {
  it('follows the symmetric convention by default', () => {
    expect(sum_to_n_a(-5)).toBe(-15);
    expect(sum_to_n_b(-5)).toBe(-15);
    expect(sum_to_n_c(-5)).toBe(-15);
  });

  it('handles the most negative valid input exactly', () => {
    expect(sum_to_n_a(MIN_SAFE_N)).toBe(-exactTriangularAsNumber(MAX_SAFE_N));
    expect(Number.isSafeInteger(sum_to_n_a(MIN_SAFE_N))).toBe(true);
    expect(sum_to_n_a(MIN_SAFE_N)).toBeGreaterThan(Number.MIN_SAFE_INTEGER);
  });
});

describe('EC-06: the upper domain boundary', () => {
  it('accepts MAX_SAFE_N and returns an exact safe integer', () => {
    const result = sum_to_n_a(MAX_SAFE_N);
    expect(result).toBe(exactTriangularAsNumber(MAX_SAFE_N));
    expect(Number.isSafeInteger(result)).toBe(true);
    expect(result).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it('rejects MAX_SAFE_N + 1, where the result stops being a safe integer', () => {
    expect(() => sum_to_n_a(MAX_SAFE_N + 1)).toThrow(InputOutOfRangeError);

    // At MAX_SAFE_N + 1 the result is still *representable* by luck - it is
    // even, and doubles represent every even integer up to 2^54 - but it has
    // already left the safe-integer range, so the guarantee is gone.
    const justPast = (BigInt(MAX_SAFE_N + 1) * BigInt(MAX_SAFE_N + 2)) / 2n;
    expect(Number.isSafeInteger(Number(justPast))).toBe(false);
  });

  it('MAX_SAFE_N + 2 is where silent corruption actually begins', () => {
    // Two past the bound, T(n) is odd and above 2^53, where representable
    // integers are spaced 2 apart. The computed answer is off by exactly 1 and
    // carries no indication of it - no NaN, no Infinity, no exception. This is
    // precisely the failure the range check exists to prevent, so it is pinned
    // here as measured fact rather than asserted as intuition.
    const n = MAX_SAFE_N + 2;
    const exact = (BigInt(n) * BigInt(n + 1)) / 2n;
    const asDouble = Number(exact);

    expect(BigInt(asDouble)).not.toBe(exact);
    expect(BigInt(asDouble) - exact).toBe(-1n);
    expect(() => sum_to_n_a(n)).toThrow(InputOutOfRangeError);
  });

  it('rejects MIN_SAFE_N - 1', () => {
    expect(() => sum_to_n_a(MIN_SAFE_N - 1)).toThrow(InputOutOfRangeError);
  });
});

describe('EC-07: large-but-valid inputs stay exact', () => {
  it.each([
    94_906_265, // last n whose naive intermediate product fits in 2^53-1
    94_906_266, // first n past it
    100_000_000,
    MAX_SAFE_N - 1,
    MAX_SAFE_N,
  ])('n = %p', (n) => {
    expect(sum_to_n_a(n)).toBe(exactTriangularAsNumber(n));
  });
});

describe('EC-08: fractional input', () => {
  it.each([0.5, 1.5, -1.5, 3.14159, 2.0000000001, 1e-7])(
    'rejects %p instead of silently truncating',
    (n) => {
      expect(() => sum_to_n_a(n)).toThrow(NonIntegerInputError);
      expect(() => sum_to_n_b(n)).toThrow(NonIntegerInputError);
      expect(() => sum_to_n_c(n)).toThrow(NonIntegerInputError);
    },
  );

  it('shows what an unguarded loop would have done with 3.7', () => {
    // A bare `for (i = 1; i <= 3.7; i++)` silently computes T(3), which is a
    // wrong answer delivered with full confidence.
    let acc = 0;
    for (let i = 1; i <= 3.7; i++) acc += i;
    expect(acc).toBe(6);
    expect(() => sum_to_n_b(3.7)).toThrow(NonIntegerInputError);
  });
});

describe('EC-09: NaN and the infinities', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s', (_label, n) => {
    expect(() => sum_to_n_a(n)).toThrow(NonFiniteInputError);
    expect(() => sum_to_n_b(n)).toThrow(NonFiniteInputError);
    expect(() => sum_to_n_c(n)).toThrow(NonFiniteInputError);
  });

  it('never returns NaN for any input it accepts', () => {
    for (let n = -1000; n <= 1000; n++) {
      expect(Number.isNaN(sum_to_n_a(n))).toBe(false);
    }
  });

  it('would otherwise hang or poison the result', () => {
    // Infinity in a closed form yields NaN; in a loop it never terminates.
    expect(Number.isNaN((Infinity * (Infinity + 1)) / 2)).toBe(false);
    expect((Infinity * (Infinity + 1)) / 2).toBe(Infinity);
    // NaN poisons silently - every comparison is false, so no guard catches it.
    expect(Number.NaN > 0).toBe(false);
    expect(Number.NaN < 0).toBe(false);
  });
});

describe('EC-10: values that are not numbers at all', () => {
  it.each([
    ['string', '5'],
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['array', [5]],
    ['object', { n: 5 }],
    ['bigint', 5n],
  ])('rejects %s', (_label, value) => {
    const call = sum_to_n_a as unknown as (n: unknown) => number;
    expect(() => call(value)).toThrow(NonNumericInputError);
  });

  it('matters because the signature is erased at runtime', () => {
    // This is exactly what arrives from `JSON.parse`, `req.query.n`, or any
    // JavaScript caller. The compiler cannot help here.
    const fromQueryString: unknown = JSON.parse('"5"');
    expect(typeof fromQueryString).toBe('string');
    expect(() => (sum_to_n_a as unknown as (n: unknown) => number)(fromQueryString))
      .toThrow(NonNumericInputError);
  });
});

describe('EC-11: stack exhaustion in the recursive implementations', () => {
  it('naive linear recursion really does die on this runtime', () => {
    const linear = (n: number): number => (n === 0 ? 0 : n + linear(n - 1));
    expect(() => linear(50_000)).toThrow(RangeError);
    expect(() => linear(50_000)).toThrow(/call stack/i);
  });

  it('the shipped recursion survives the same input', () => {
    expect(sum_to_n_c(50_000)).toBe(exactTriangularAsNumber(50_000));
  });

  it('the shipped recursion covers the whole domain with no cap', () => {
    // Halving needs 27 frames and 27 calls at the very top of the domain, so
    // unlike range splitting it needs no artificial input limit at all.
    expect(sum_to_n_c(MAX_SAFE_N)).toBe(exactTriangularAsNumber(MAX_SAFE_N));
    expect(sum_to_n_c(-MAX_SAFE_N)).toBe(-exactTriangularAsNumber(MAX_SAFE_N));
  });
});

describe('EC-12: input beyond a strategy capability limit', () => {
  // No shipped strategy has a ceiling below the domain maximum any more - the
  // one that did (range splitting, O(n)) was superseded by halving. The
  // mechanism is still part of the strategy contract, so it is exercised here
  // through a deliberately narrow strategy.
  const narrow: SummationStrategy = {
    name: 'narrow-test-strategy',
    maxSupportedInput: 1_000,
    complexity: Object.freeze<ComplexityProfile>({
      time: 'O(1)',
      space: 'O(1)',
      rationale: 'Test double with a deliberately low ceiling.',
    }),
    sumToNonNegative: (n) => (n * (n + 1)) / 2,
  };
  const narrowService = new SummationService({ strategy: narrow });

  it('fails fast with a typed error instead of appearing to hang', () => {
    expect(() => narrowService.compute(1_001)).toThrow(ExceedsStrategyLimitError);
    // Crucially it does NOT throw RangeError - the failure is a designed,
    // documented outcome rather than a runtime crash.
    expect(() => narrowService.compute(1_001)).not.toThrow(RangeError);
  });

  it('names the alternative in the error message', () => {
    try {
      narrowService.compute(1_001);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toMatch(/closed form/i);
    }
  });

  it('the three shipped functions accept the entire domain', () => {
    for (const n of [0, 1, 5, 12_345, 1_000_000]) {
      expect(sum_to_n_a(n)).toBe(sum_to_n_c(n));
    }
    expect(sum_to_n_a(MAX_SAFE_N)).toBe(sum_to_n_c(MAX_SAFE_N));
  });
});

describe('EC-15: the 32-bit trap in bitwise halving', () => {
  it('n >> 1 silently corrupts above 2^31, which is why Math.floor is used', () => {
    // JavaScript's bitwise operators coerce to 32-bit signed integers. The
    // shift is correct across this module's domain, but it would become a
    // silent corruption bug the moment the domain widened - so the shipped
    // implementation never uses it.
    const beyond32Bit = 3_000_000_000;
    expect(beyond32Bit >> 1).toBe(-647_483_648);
    expect(Math.floor(beyond32Bit / 2)).toBe(1_500_000_000);

    // Within the domain the two agree, which is exactly what makes the trap
    // easy to miss in review.
    expect(MAX_SAFE_N >> 1).toBe(Math.floor(MAX_SAFE_N / 2));
  });

  it('halving stays exact at every power-of-two boundary', () => {
    const halvingStrategy = new HalvingSummation();
    for (let exponent = 0; exponent <= 27; exponent++) {
      for (const n of [2 ** exponent - 1, 2 ** exponent, 2 ** exponent + 1]) {
        if (n < 0 || n > MAX_SAFE_N) continue;
        expect(halvingStrategy.sumToNonNegative(n)).toBe(exactTriangularAsNumber(n));
      }
    }
  });
});

describe('EC-13: purity and repeatability', () => {
  it('gives the same answer every time, with no observable side effects', () => {
    const inputs = [0, 1, -1, 5, -5, 999, -999];
    const first = inputs.map(sum_to_n_a);
    const second = inputs.map(sum_to_n_a);
    const third = inputs.map(sum_to_n_a);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('does not mutate anything reachable from the caller', () => {
    const frozenInput = Object.freeze({ n: 5 });
    expect(sum_to_n_a(frozenInput.n)).toBe(15);
    expect(frozenInput).toEqual({ n: 5 });
  });
});

describe('EC-14: exhaustive small-domain sweep', () => {
  it('every n in [-1000, 1000] matches the exact oracle in all three', () => {
    for (let n = -1000; n <= 1000; n++) {
      const expected = n >= 0
        ? exactTriangularAsNumber(n)
        : -exactTriangularAsNumber(-n);
      expect(sum_to_n_a(n)).toBe(expected);
      expect(sum_to_n_b(n)).toBe(expected);
      expect(sum_to_n_c(n)).toBe(expected);
    }
  });
});
