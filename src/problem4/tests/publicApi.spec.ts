import { describe, expect, it } from '@jest/globals';
import * as api from '../src/index';

describe('public API surface', () => {
  it('exports the three functions the brief asks for', () => {
    expect(typeof api.sum_to_n_a).toBe('function');
    expect(typeof api.sum_to_n_b).toBe('function');
    expect(typeof api.sum_to_n_c).toBe('function');
    expect(api.sum_to_n_a).toHaveLength(1);
    expect(api.sum_to_n_b).toHaveLength(1);
    expect(api.sum_to_n_c).toHaveLength(1);
  });

  it('exports the extension surface for callers who need to compose', () => {
    expect(typeof api.SummationService).toBe('function');
    expect(typeof api.ClosedFormSummation).toBe('function');
    expect(typeof api.IterativeSummation).toBe('function');
    expect(typeof api.HalvingSummation).toBe('function');
    expect(typeof api.SafeIntegerValidator).toBe('function');
    expect(typeof api.SymmetricNegativePolicy).toBe('function');
    expect(typeof api.RejectNegativePolicy).toBe('function');
    expect(typeof api.EmptyRangeNegativePolicy).toBe('function');
    expect(typeof api.GaussContinuationNegativePolicy).toBe('function');
  });

  it('exports the documented numeric bounds', () => {
    expect(api.MAX_SAFE_N).toBe(134_217_727);
    expect(api.MIN_SAFE_N).toBe(-134_217_727);
    expect(api.MAX_N_WITH_SAFE_NAIVE_PRODUCT).toBe(94_906_265);
  });

  it('exports every error class so callers can branch on type', () => {
    expect(typeof api.SummationError).toBe('function');
    expect(typeof api.NonNumericInputError).toBe('function');
    expect(typeof api.NonFiniteInputError).toBe('function');
    expect(typeof api.NonIntegerInputError).toBe('function');
    expect(typeof api.InputOutOfRangeError).toBe('function');
    expect(typeof api.NegativeInputRejectedError).toBe('function');
    expect(typeof api.ExceedsStrategyLimitError).toBe('function');
  });

  it('the three functions are independent - one throwing does not affect another', () => {
    expect(() => (api.sum_to_n_c as unknown as (n: unknown) => number)('x')).toThrow();
    expect(api.sum_to_n_a(5)).toBe(15);
    expect(api.sum_to_n_b(5)).toBe(15);
    expect(api.sum_to_n_c(5)).toBe(15);
  });

  it('all three functions cover the full domain, with no artificial cap', () => {
    expect(api.sum_to_n_c(api.MAX_SAFE_N)).toBe(api.sum_to_n_a(api.MAX_SAFE_N));
    expect(api.sum_to_n_c(-api.MAX_SAFE_N)).toBe(api.sum_to_n_a(-api.MAX_SAFE_N));
  });
});
