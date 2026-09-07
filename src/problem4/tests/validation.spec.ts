import { describe, expect, it } from '@jest/globals';
import { MAX_SAFE_N, MIN_SAFE_N } from '../src/domain/constants';
import {
  InputOutOfRangeError,
  NonFiniteInputError,
  NonIntegerInputError,
  NonNumericInputError,
  SummationError,
} from '../src/domain/errors';
import { SafeIntegerValidator } from '../src/validation/SafeIntegerValidator';

describe('SafeIntegerValidator', () => {
  const validator = new SafeIntegerValidator();

  describe('accepts', () => {
    it.each([0, 1, 2, 5, 42, MAX_SAFE_N, -1, -42, MIN_SAFE_N])(
      'the in-domain integer %p',
      (value) => {
        expect(validator.validate(value)).toBe(value);
      },
    );

    it('normalises negative zero to positive zero', () => {
      const result = validator.validate(-0);
      expect(Object.is(result, 0)).toBe(true);
      expect(Object.is(result, -0)).toBe(false);
    });
  });

  describe('rejects non-number types', () => {
    // `unknown` is the honest parameter type: at runtime any of these can
    // arrive from JSON, a query string, or a JavaScript caller.
    it.each([
      ['string', '5'],
      ['numeric-looking string', '  5  '],
      ['empty string', ''],
      ['null', null],
      ['undefined', undefined],
      ['boolean true', true],
      ['boolean false', false],
      ['plain object', { valueOf: () => 5 }],
      ['array', [5]],
      ['single-element array', [1]],
      ['function', () => 5],
      ['symbol', Symbol('5')],
      ['bigint', 5n],
      ['null-prototype object', Object.create(null) as unknown],
      ['Number wrapper object', new Number(5)],
      ['Date', new Date(0)],
    ])('%s', (_label, value) => {
      expect(() => validator.validate(value)).toThrow(NonNumericInputError);
      expect(() => validator.validate(value)).toThrow(SummationError);
    });

    it('does not coerce a numeric string even though "5" == 5', () => {
      // Guards against a future "helpful" refactor to `Number(value)` or `==`.
      expect('5' == 5).toBe(true); // eslint-disable-line eqeqeq
      expect(() => validator.validate('5')).toThrow(NonNumericInputError);
    });
  });

  describe('rejects non-finite numbers', () => {
    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['0/0', 0 / 0],
      ['1/0', 1 / 0],
    ])('%s', (_label, value) => {
      expect(() => validator.validate(value)).toThrow(NonFiniteInputError);
    });

    it('catches NaN even though typeof NaN === "number"', () => {
      expect(typeof Number.NaN).toBe('number');
      // NaN compares false against every bound, so a range check alone would
      // let it through and produce a NaN result.
      expect(Number.NaN < MIN_SAFE_N).toBe(false);
      expect(Number.NaN > MAX_SAFE_N).toBe(false);
      expect(() => validator.validate(Number.NaN)).toThrow(NonFiniteInputError);
    });
  });

  describe('rejects non-integers', () => {
    it.each([0.5, 1.5, -1.5, 3.14159, 1e-7, -0.1, 2.0000000001])('%p', (value) => {
      expect(() => validator.validate(value)).toThrow(NonIntegerInputError);
    });

    it('accepts float literals that are mathematically integral', () => {
      expect(validator.validate(5.0)).toBe(5);
      expect(validator.validate(1e6)).toBe(1_000_000);
    });
  });

  describe('rejects out-of-domain integers', () => {
    it.each([
      ['one past the maximum', MAX_SAFE_N + 1],
      ['one past the minimum', MIN_SAFE_N - 1],
      ['2^30', 2 ** 30],
      ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
      ['Number.MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER],
      ['1e21 (integral but enormous)', 1e21],
      ['-1e21', -1e21],
    ])('%s', (_label, value) => {
      expect(() => validator.validate(value)).toThrow(InputOutOfRangeError);
    });

    it('accepts both boundaries themselves', () => {
      expect(validator.validate(MAX_SAFE_N)).toBe(MAX_SAFE_N);
      expect(validator.validate(MIN_SAFE_N)).toBe(MIN_SAFE_N);
    });

    it('honours a caller-supplied tighter bound', () => {
      // The bound is injectable so a public HTTP endpoint can clamp far below
      // the arithmetic maximum for denial-of-service reasons.
      const strict = new SafeIntegerValidator(0, 100);
      expect(strict.validate(100)).toBe(100);
      expect(() => strict.validate(101)).toThrow(InputOutOfRangeError);
      expect(() => strict.validate(-1)).toThrow(InputOutOfRangeError);
    });
  });

  describe('error payloads', () => {
    it('exposes a stable machine-readable code', () => {
      expect(() => validator.validate('x')).toThrow(
        expect.objectContaining({ code: 'ERR_NON_NUMERIC_INPUT' }),
      );
      expect(() => validator.validate(Number.NaN)).toThrow(
        expect.objectContaining({ code: 'ERR_NON_FINITE_INPUT' }),
      );
      expect(() => validator.validate(1.5)).toThrow(
        expect.objectContaining({ code: 'ERR_NON_INTEGER_INPUT' }),
      );
      expect(() => validator.validate(1e21)).toThrow(
        expect.objectContaining({ code: 'ERR_INPUT_OUT_OF_RANGE' }),
      );
    });

    it('carries the rejected value and the violated bounds', () => {
      try {
        validator.validate(MAX_SAFE_N + 1);
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InputOutOfRangeError);
        const typed = error as InputOutOfRangeError;
        expect(typed.received).toBe(MAX_SAFE_N + 1);
        expect(typed.min).toBe(MIN_SAFE_N);
        expect(typed.max).toBe(MAX_SAFE_N);
        expect(typed.name).toBe('InputOutOfRangeError');
      }
    });
  });
});
