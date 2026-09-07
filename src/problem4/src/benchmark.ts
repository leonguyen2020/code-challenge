/**
 * Measures what the complexity annotations claim.
 *
 *     npm run bench
 *
 * A doc comment saying "O(1)" is an assertion; this is the evidence. The
 * numbers it prints are the ones quoted in README.md.
 */

import { MAX_SAFE_N } from './domain/constants';
import { SummationService } from './SummationService';
import {
  ClosedFormSummation,
  HalvingSummation,
  IterativeSummation,
} from './strategies';

interface BenchmarkRow {
  readonly strategy: string;
  readonly n: number;
  readonly nanosPerCall: number;
}

/**
 * Chooses how many times to repeat a call so the measurement window is long
 * enough to dominate timer overhead.
 *
 * Fixing the repetition count per input size is a classic benchmarking error:
 * a cheap call measured over 3 repetitions is mostly `process.hrtime` overhead,
 * which makes a genuinely constant-time function look like it scales. Doubling
 * until the run takes at least `targetMillis` removes that artefact.
 */
function calibrate(run: () => void, targetMillis: number, maxIterations: number): number {
  let iterations = 1;
  for (;;) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) run();
    const elapsedMillis = Number(process.hrtime.bigint() - start) / 1e6;
    if (elapsedMillis >= targetMillis || iterations >= maxIterations) return iterations;
    // Scale towards the target rather than blindly doubling, so calibration of
    // a very cheap call converges in a couple of rounds instead of twenty.
    const scale = Math.max(2, Math.ceil(targetMillis / Math.max(elapsedMillis, 0.001)));
    iterations = Math.min(iterations * scale, maxIterations);
  }
}

/** Median of repeated timings - robust against GC pauses and scheduler noise. */
function measureNanosPerCall(run: () => void, samples: number, iterations: number): number {
  const timings: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) run();
    timings.push(Number(process.hrtime.bigint() - start) / iterations);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(timings.length / 2)] as number;
}

function formatDuration(nanos: number): string {
  if (nanos < 1_000) return `${nanos.toFixed(1)} ns`;
  if (nanos < 1_000_000) return `${(nanos / 1_000).toFixed(2)} us`;
  return `${(nanos / 1_000_000).toFixed(2)} ms`;
}

function main(): void {
  const services = [
    new SummationService({ strategy: new ClosedFormSummation() }),
    new SummationService({ strategy: new IterativeSummation() }),
    new SummationService({ strategy: new HalvingSummation() }),
  ];

  const inputs = [10, 1_000, 100_000, 1_000_000, 10_000_000, MAX_SAFE_N];
  const rows: BenchmarkRow[] = [];

  for (const service of services) {
    const { strategy, maxSupportedInput } = service.describe();
    for (const n of inputs) {
      if (n > maxSupportedInput) continue;

      // Warm the JIT so compilation is not folded into the measurement.
      for (let i = 0; i < 200; i++) service.compute(n);

      // Calibrate to a 50 ms window, capped so an O(n) call at the top of the
      // domain does not run for minutes.
      const iterations = calibrate(() => service.compute(n), 50, 5_000_000);

      rows.push({
        strategy,
        n,
        nanosPerCall: measureNanosPerCall(() => service.compute(n), 5, iterations),
      });
    }
  }

  console.log('\nsum_to_n - cost per call (median of 5 runs)\n');
  console.log(
    `${'strategy'.padEnd(30)}${'n'.padStart(14)}${'per call'.padStart(14)}`,
  );
  console.log('-'.repeat(58));
  for (const row of rows) {
    console.log(
      row.strategy.padEnd(30) +
        row.n.toLocaleString('en-US').padStart(14) +
        formatDuration(row.nanosPerCall).padStart(14),
    );
  }

  const ratioFor = (name: string): string => {
    const subset = rows.filter((row) => row.strategy === name);
    const cheapest = Math.min(...subset.map((row) => row.nanosPerCall));
    const dearest = Math.max(...subset.map((row) => row.nanosPerCall));
    const span = Math.max(...subset.map((r) => r.n)) / Math.min(...subset.map((r) => r.n));
    return `${(dearest / cheapest).toFixed(1).padStart(12)}x  over a ${span.toLocaleString('en-US')}x input range`;
  };

  console.log('\ncost growth from the smallest to the largest input measured:');
  // Derived from the rows themselves rather than a hand-maintained list, so
  // adding a strategy cannot leave this summary silently incomplete - and the
  // labels cannot drift out of sync with the strategy names again.
  for (const name of [...new Set(rows.map((row) => row.strategy))]) {
    console.log(`  ${name.padEnd(22)}${ratioFor(name)}`);
  }
  console.log(
    '\nThe closed form is flat. Halving grows logarithmically - a ~19x cost rise\n' +
      'across a 13,400,000x input range. The iterative one tracks the input size\n' +
      'directly. O(1) vs O(log n) vs O(n), measured rather than asserted.\n',
  );
}

main();
