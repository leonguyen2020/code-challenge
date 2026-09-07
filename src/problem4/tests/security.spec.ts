import { describe, expect, it, jest } from '@jest/globals';
import {
  MAX_SAFE_N,
  SummationError,
  SummationService,
  describeValue,
  sum_to_n_a,
  sum_to_n_b,
  sum_to_n_c,
} from '../src/index';
import { NonNumericInputError } from '../src/domain/errors';
import { IterativeSummation } from '../src/strategies';
import { SafeIntegerValidator } from '../src/validation/SafeIntegerValidator';

const asUnknown = (fn: (n: number) => number): ((value: unknown) => number) =>
  fn as unknown as (value: unknown) => number;

describe('SEC-01: no user-controlled code runs during validation or error building', () => {
  it('does not invoke a hostile valueOf', () => {
    const valueOf = jest.fn(() => 5);
    expect(() => asUnknown(sum_to_n_a)({ valueOf })).toThrow(NonNumericInputError);
    expect(valueOf).not.toHaveBeenCalled();
  });

  it('does not invoke a hostile toString', () => {
    const toString = jest.fn(() => '5');
    expect(() => asUnknown(sum_to_n_a)({ toString })).toThrow(NonNumericInputError);
    expect(toString).not.toHaveBeenCalled();
  });

  it('does not invoke a hostile Symbol.toPrimitive', () => {
    const toPrimitive = jest.fn(() => 5);
    const hostile = { [Symbol.toPrimitive]: toPrimitive };
    expect(() => asUnknown(sum_to_n_a)(hostile)).toThrow(NonNumericInputError);
    expect(toPrimitive).not.toHaveBeenCalled();
  });

  it('survives a value whose coercion hooks all throw', () => {
    const booby = {
      valueOf() { throw new Error('valueOf detonated'); },
      toString() { throw new Error('toString detonated'); },
      [Symbol.toPrimitive]() { throw new Error('toPrimitive detonated'); },
    };
    // The thrown error must be OURS, not the booby trap's - proof that no
    // coercion path was taken while building the message.
    expect(() => asUnknown(sum_to_n_a)(booby)).toThrow(NonNumericInputError);
    expect(() => asUnknown(sum_to_n_a)(booby)).not.toThrow(/detonated/);
  });

  it('survives a getter-laden and null-prototype object', () => {
    const withGetter = Object.defineProperty({}, 'length', {
      get() { throw new Error('getter detonated'); },
    });
    expect(() => asUnknown(sum_to_n_a)(withGetter)).toThrow(NonNumericInputError);
    expect(() => asUnknown(sum_to_n_a)(Object.create(null))).toThrow(NonNumericInputError);
  });
});

describe('SEC-02: error messages cannot be used for log injection or memory abuse', () => {
  it('truncates an oversized string rather than echoing it', () => {
    const huge = 'A'.repeat(5_000_000);
    let message = '';
    try {
      asUnknown(sum_to_n_a)(huge);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeLessThan(300);
    expect(message).toContain('...');
  });

  it('escapes control characters so a value cannot forge log lines', () => {
    const forged = 'x\n2026-01-01 ERROR admin login succeeded';
    expect(describeValue(forged)).not.toContain('\n');
    expect(describeValue(forged)).toContain('\\n');
  });

  it('reports only the type for non-primitives, never the contents', () => {
    expect(describeValue({ secret: 'hunter2' })).toBe('[object]');
    expect(describeValue(() => 0)).toBe('[function]');
    expect(describeValue(Symbol('secret'))).toBe('[symbol]');
    expect(describeValue([1, 2, 3])).toBe('[object]');
  });

  it('renders primitives faithfully', () => {
    expect(describeValue(null)).toBe('null');
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(true)).toBe('true');
    expect(describeValue(42)).toBe('42');
    expect(describeValue(Number.NaN)).toBe('NaN');
    expect(describeValue(-0)).toBe('0');
    expect(describeValue(7n)).toBe('7n');
    expect(describeValue('ok')).toBe('"ok"');
  });
});

describe('SEC-03: algorithmic denial of service is bounded', () => {
  it('caps the worst-case work an untrusted caller can request', () => {
    // Without the domain bound, `sum_to_n_b(1e15)` would block Node's single
    // thread for hours. The bound turns that into an immediate rejection.
    expect(() => sum_to_n_b(1e15)).toThrow(SummationError);
    expect(() => sum_to_n_b(Number.MAX_SAFE_INTEGER)).toThrow(SummationError);
  });

  it('lets an endpoint tighten the bound far below the arithmetic maximum', () => {
    const publicEndpoint = new SummationService({
      strategy: new IterativeSummation(),
      validator: new SafeIntegerValidator(0, 10_000),
    });
    expect(publicEndpoint.compute(10_000)).toBe(50_005_000);
    expect(() => publicEndpoint.compute(10_001)).toThrow(SummationError);
    expect(() => publicEndpoint.compute(MAX_SAFE_N)).toThrow(SummationError);
  });

  it('the O(1) implementation has no input-dependent cost at all', () => {
    const start = process.hrtime.bigint();
    sum_to_n_a(MAX_SAFE_N);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(50);
  });

  it('rejects before doing any work, not after', () => {
    // If validation ran after the loop, this call would take ~100 ms rather
    // than microseconds. Timing the rejection proves the ordering.
    const start = process.hrtime.bigint();
    expect(() => sum_to_n_b(MAX_SAFE_N + 1)).toThrow();
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe('SEC-04: no prototype pollution surface', () => {
  it('ignores a polluted Object.prototype', () => {
    const polluted = Object.prototype as unknown as Record<string, unknown>;
    try {
      polluted['maxSupportedInput'] = 1;
      polluted['name'] = 'pwned';
      // Behaviour must be entirely unaffected: nothing is read off the
      // prototype chain, and no option object is merged with defaults.
      expect(sum_to_n_a(5)).toBe(15);
      expect(sum_to_n_b(5)).toBe(15);
      expect(sum_to_n_c(5)).toBe(15);
    } finally {
      delete polluted['maxSupportedInput'];
      delete polluted['name'];
    }
  });

  it('accepts a __proto__-bearing payload without altering anything', () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    expect(() => asUnknown(sum_to_n_a)(payload)).toThrow(NonNumericInputError);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('SEC-05: errors are safe to surface', () => {
  it('every error is a typed SummationError with a stable code', () => {
    const cases: ReadonlyArray<[unknown, string]> = [
      ['5', 'ERR_NON_NUMERIC_INPUT'],
      [Number.NaN, 'ERR_NON_FINITE_INPUT'],
      [1.5, 'ERR_NON_INTEGER_INPUT'],
      [1e21, 'ERR_INPUT_OUT_OF_RANGE'],
    ];
    for (const [value, code] of cases) {
      try {
        asUnknown(sum_to_n_a)(value);
        throw new Error('expected a throw');
      } catch (error) {
        expect(error).toBeInstanceOf(SummationError);
        expect(error).toBeInstanceOf(Error);
        expect((error as { code: string }).code).toBe(code);
        expect((error as Error).name).not.toBe('Error');
        // No stack frames from inside the validator leak into the message.
        expect((error as Error).message).not.toMatch(/node_modules|\/src\//);
      }
    }
  });

  it('instanceof works for every concrete error subclass', () => {
    // Guards the `Object.setPrototypeOf` in the base constructor, which is what
    // makes `instanceof` survive downlevelled class emit.
    expect(() => asUnknown(sum_to_n_a)('x')).toThrow(NonNumericInputError);
    try {
      asUnknown(sum_to_n_a)('x');
    } catch (error) {
      expect(error instanceof NonNumericInputError).toBe(true);
      expect(error instanceof SummationError).toBe(true);
      expect(error instanceof Error).toBe(true);
      expect(Object.getPrototypeOf(error)).toBe(NonNumericInputError.prototype);
    }
  });

  it('captures a stack trace that starts at the caller', () => {
    try {
      asUnknown(sum_to_n_a)('x');
    } catch (error) {
      expect(typeof (error as Error).stack).toBe('string');
      // The error's own constructor is elided by Error.captureStackTrace.
      expect((error as Error).stack).not.toMatch(/at new NonNumericInputError/);
    }
  });
});
