import { MAX_SAFE_N } from '../domain/constants';
import type { ComplexityProfile, SummationStrategy } from '../domain/types';

/**
 * Straightforward accumulation: `for i in 1..n: acc += i`.
 *
 * ## Complexity
 *
 * **Time O(n), space O(1).** One addition and one comparison per step, no
 * allocation. Constant factors are as low as JavaScript gets - the loop is
 * monomorphic over small integers and JIT-compiles to a tight machine loop -
 * but linear is still linear: at the top of the domain this executes ~134
 * million iterations.
 *
 * ## Why it is here anyway
 *
 * It is the reference implementation. It is transparently correct by
 * inspection, which is exactly what you want on the other side of a
 * differential test that checks the two clever implementations against it.
 *
 * ## What it is *not* for
 *
 * Never call this with attacker-controlled `n` on a request path. Node runs
 * user code on a single thread, so a linear scan over 134M values blocks every
 * other in-flight request for the duration - a textbook algorithmic
 * denial-of-service. The service's validation bound caps the damage, but the
 * correct mitigation is to route request traffic to `ClosedFormSummation` and
 * keep this one for verification and small inputs.
 *
 * ## Rejected alternative
 *
 * `Array.from({ length: n }, (_, i) => i + 1).reduce((a, b) => a + b, 0)` reads
 * more "functional" but allocates an n-element array: O(n) space, ~1 GB at the
 * top of the domain, and an out-of-memory crash rather than a slow response.
 * Elegance that trades O(1) space for O(n) is not elegance.
 */
export class IterativeSummation implements SummationStrategy {
  public readonly name = 'iterative';

  public readonly maxSupportedInput = MAX_SAFE_N;

  public readonly complexity: ComplexityProfile = Object.freeze({
    time: 'O(n)',
    space: 'O(1)',
    rationale:
      'One addition per term, no allocation. Simple and obviously correct, ' +
      'which makes it the oracle for differential testing - but linear cost ' +
      'makes it unsuitable for untrusted input on a single-threaded runtime.',
  });

  public sumToNonNegative(n: number): number {
    let accumulator = 0;
    for (let i = 1; i <= n; i++) {
      accumulator += i;
    }
    return accumulator;
  }
}
