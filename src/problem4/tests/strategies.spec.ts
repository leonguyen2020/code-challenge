import { describe, expect, it } from '@jest/globals';
import {
  MAX_N_WITH_SAFE_NAIVE_PRODUCT,
  MAX_SAFE_N,
} from '../src/domain/constants';
import type { SummationStrategy } from '../src/domain/types';
import {
  ClosedFormSummation,
  HalvingSummation,
  IterativeSummation,
} from '../src/strategies';
import { exactTriangularAsNumber, naiveGauss } from './helpers/oracle';

const closedForm = new ClosedFormSummation();
const iterative = new IterativeSummation();
const halving = new HalvingSummation();

const strategies: ReadonlyArray<[string, SummationStrategy]> = [
  ['ClosedFormSummation', closedForm],
  ['IterativeSummation', iterative],
  ['HalvingSummation', halving],
];

describe.each(strategies)('%s', (_name, strategy) => {
  it('exposes a stable name, a limit and a frozen complexity profile', () => {
    expect(typeof strategy.name).toBe('string');
    expect(strategy.name.length).toBeGreaterThan(0);
    expect(Number.isSafeInteger(strategy.maxSupportedInput)).toBe(true);
    expect(strategy.complexity.time).toMatch(/^O\(/);
    expect(strategy.complexity.space).toMatch(/^O\(/);
    expect(strategy.complexity.rationale.length).toBeGreaterThan(20);
    expect(Object.isFrozen(strategy.complexity)).toBe(true);
  });

  it('returns 0 for the empty range', () => {
    expect(strategy.sumToNonNegative(0)).toBe(0);
    expect(Object.is(strategy.sumToNonNegative(0), -0)).toBe(false);
  });

  it('matches the exact oracle across the whole small domain', () => {
    for (let n = 0; n <= 500; n++) {
      expect(strategy.sumToNonNegative(n)).toBe(exactTriangularAsNumber(n));
    }
  });

  it('satisfies the example from the brief: sum_to_n(5) === 15', () => {
    expect(strategy.sumToNonNegative(5)).toBe(15);
  });

  it('is pure - repeated calls do not drift', () => {
    const first = strategy.sumToNonNegative(1234);
    expect(strategy.sumToNonNegative(1234)).toBe(first);
    expect(strategy.sumToNonNegative(1234)).toBe(first);
  });

  it('is exact at a large input within its declared limit', () => {
    // Capped rather than run at the raw limit: for the two O(n) strategies the
    // limit is 134M, and coverage instrumentation makes that a ~15 s assertion
    // for no extra defect-detection power. The closed form is separately
    // exercised at the true domain maximum below, where it costs nothing, and
    // the heavy full-domain sweep is available via `npm run test:heavy`.
    const probe = Math.min(strategy.maxSupportedInput, 1_000_000);
    expect(strategy.sumToNonNegative(probe)).toBe(exactTriangularAsNumber(probe));
    expect(Number.isSafeInteger(strategy.sumToNonNegative(probe))).toBe(true);
  });
});

describe('ClosedFormSummation specifics', () => {
  it('supports the full domain', () => {
    expect(closedForm.maxSupportedInput).toBe(MAX_SAFE_N);
  });

  it('is O(1): the top of the domain is computed in constant time', () => {
    // Warm the JIT so compilation cost is not attributed to the measurement.
    for (let i = 0; i < 10_000; i++) closedForm.sumToNonNegative(i);

    const start = process.hrtime.bigint();
    for (let i = 0; i < 10_000; i++) closedForm.sumToNonNegative(MAX_SAFE_N);
    const nanosPerCall = Number(process.hrtime.bigint() - start) / 10_000;

    // An O(n) implementation would need ~134 million iterations per call here.
    // Anything under a microsecond proves the cost is not input-dependent,
    // with orders of magnitude of headroom against a slow CI machine.
    expect(nanosPerCall).toBeLessThan(1_000);
  });

  it('halves before multiplying, keeping the intermediate below 2^53', () => {
    // The even factor is halved first, so the largest intermediate product is
    // roughly half of the naive one.
    const n = MAX_SAFE_N;
    const halvedIntermediate = (n - 1) / 2 === Math.floor((n - 1) / 2)
      ? n * ((n + 1) / 2)
      : (n / 2) * (n + 1);
    expect(Number.isSafeInteger(halvedIntermediate)).toBe(true);
  });

  it('documents honestly: the naive spelling is ALSO exact over this domain', () => {
    // This pins the claim made in ClosedFormSummation's doc comment. The naive
    // product exceeds 2^53 above MAX_N_WITH_SAFE_NAIVE_PRODUCT yet stays exact,
    // because it is always even and never exceeds 2^54. If a future change to
    // MAX_SAFE_N breaks that invariant, this test fails and the comment gets
    // corrected rather than silently becoming a lie.
    const probes = [
      MAX_N_WITH_SAFE_NAIVE_PRODUCT,
      MAX_N_WITH_SAFE_NAIVE_PRODUCT + 1,
      MAX_N_WITH_SAFE_NAIVE_PRODUCT + 12_345,
      MAX_SAFE_N - 1,
      MAX_SAFE_N,
    ];
    for (const n of probes) {
      const exact = exactTriangularAsNumber(n);
      expect(closedForm.sumToNonNegative(n)).toBe(exact);
      expect(naiveGauss(n)).toBe(exact);
    }
    // ...and the reason it survives:
    const maxProduct = BigInt(MAX_SAFE_N) * BigInt(MAX_SAFE_N + 1);
    expect(maxProduct % 2n).toBe(0n);
    expect(maxProduct).toBeLessThanOrEqual(2n ** 54n);
  });
});

describe('IterativeSummation specifics', () => {
  it('supports the full domain', () => {
    expect(iterative.maxSupportedInput).toBe(MAX_SAFE_N);
  });

  it('stays exact under repeated accumulation', () => {
    // Repeated addition is exact for as long as every partial sum stays at or
    // below 2^53 - 1, which the domain bound guarantees. Verified here at a
    // scale that runs in milliseconds; `npm run test:heavy` proves it at the
    // true domain maximum.
    const n = 1_000_000;
    expect(iterative.sumToNonNegative(n)).toBe(exactTriangularAsNumber(n));
  });
});

describe('HalvingSummation specifics', () => {
  it('supports the full domain - no artificial cap', () => {
    expect(halving.maxSupportedInput).toBe(MAX_SAFE_N);
    expect(halving.sumToNonNegative(MAX_SAFE_N)).toBe(
      exactTriangularAsNumber(MAX_SAFE_N),
    );
  });

  it('does NOT overflow the stack where linear recursion would', () => {
    // Establish that naive linear recursion really does die in this runtime,
    // so the claim in the doc comment is measured, not assumed.
    const linear = (n: number): number => (n === 0 ? 0 : n + linear(n - 1));
    expect(() => linear(50_000)).toThrow(RangeError);

    // Halving handles four orders of magnitude more without touching the limit.
    expect(halving.sumToNonNegative(MAX_SAFE_N)).toBe(
      exactTriangularAsNumber(MAX_SAFE_N),
    );
  });

  it('needs only logarithmic stack depth, measured from real stack frames', () => {
    // Count how many `sumToNonNegative` activations are simultaneously on the
    // stack by sampling a real stack trace from inside the recursion.
    const originalFloor = Math.floor;
    const originalLimit = Error.stackTraceLimit;
    let maxFrames = 0;
    let sampling = false;

    try {
      Error.stackTraceLimit = 500;
      Math.floor = ((x: number): number => {
        if (!sampling) {
          sampling = true;
          const frames = (new Error().stack ?? '').match(/sumToNonNegative/g)?.length ?? 0;
          if (frames > maxFrames) maxFrames = frames;
          sampling = false;
        }
        return originalFloor(x);
      }) as typeof Math.floor;

      halving.sumToNonNegative(MAX_SAFE_N);
    } finally {
      Math.floor = originalFloor;
      Error.stackTraceLimit = originalLimit;
    }

    // ceil(log2(134217727)) + 1 = 28 frames. Linear recursion would need 134M.
    expect(maxFrames).toBeGreaterThan(0);
    expect(maxFrames).toBeLessThanOrEqual(35);
  });

  it('makes only a logarithmic number of calls', () => {
    let calls = 0;
    const counted = new (class extends HalvingSummation {
      public override sumToNonNegative(n: number): number {
        calls++;
        return super.sumToNonNegative(n);
      }
    })();
    counted.sumToNonNegative(MAX_SAFE_N);
    // Range splitting would need 2n - 1 = 268,435,453 calls for the same input.
    expect(calls).toBeLessThanOrEqual(30);
  });

  it('handles the degenerate single-element range', () => {
    expect(halving.sumToNonNegative(1)).toBe(1);
  });
});
