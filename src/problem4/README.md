# Problem 4 — Three ways to sum to n

Three implementations of `sum_to_n` in TypeScript, with the complexity of each
annotated and verified.

> **Task:** Provide 3 unique implementations of `sum_to_n(n: number): number`.
> Comment on the complexity or efficiency of each.
> `sum_to_n(5) === 1 + 2 + 3 + 4 + 5 === 15`.

---

## Quick start

```bash
cd src/problem4
npm install

npm test              # 212 tests, ~4 s
npm run test:coverage # with coverage (gate: 100%)
npm run typecheck     # tsc --noEmit, strict
npm run bench         # measure the complexity claims
npm run test:heavy    # opt-in full-domain verification (~2 s)
```

No runtime dependencies. Dev dependencies are TypeScript, Jest and ts-jest only;
`npm audit` reports 0 vulnerabilities.

---

## The three implementations

| Function | Algorithm | Time | Space | Max `n` | Measured cost |
|----------|-----------|------|-------|---------|---------------|
| `sum_to_n_a` | Gauss closed form | **O(1)** | O(1) | 134,217,727 | **4.5 ns**, flat |
| `sum_to_n_b` | Iterative accumulation | O(n) | O(1) | 134,217,727 | 9.3 ns → 120 ms |
| `sum_to_n_c` | Recursion by value halving | **O(log n)** | O(log n) | 134,217,727 | 20 ns → 402 ns |

Three implementations, three strategy classes, no more. Algorithms that were
tried and rejected on the way here — naive linear recursion, range-splitting
divide-and-conquer, arbitrary-precision `BigInt` — are written up with their
measurements in [`docs/EDGE_CASES.md`](docs/EDGE_CASES.md) rather than shipped
as code.

```
sum_to_n - cost per call (median of 5 runs)

strategy                                   n      per call
----------------------------------------------------------
closed-form                               10        2.1 ns
closed-form                            1,000        4.5 ns
closed-form                          100,000        4.5 ns
closed-form                        1,000,000        4.5 ns
closed-form                       10,000,000        4.5 ns
closed-form                      134,217,727        4.2 ns     <- flat
iterative                                 10        9.7 ns
iterative                              1,000      576.2 ns
iterative                            100,000     224.35 us
iterative                          1,000,000       2.44 ms
iterative                         10,000,000      23.21 ms
iterative                        134,217,727     120.20 ms     <- linear
halving-recursion                         10       20.6 ns
halving-recursion                      1,000       94.5 ns
halving-recursion                    100,000      203.2 ns
halving-recursion                  1,000,000      278.7 ns
halving-recursion                 10,000,000      336.9 ns
halving-recursion                134,217,727      401.5 ns     <- logarithmic

cost growth from the smallest to the largest input measured:
  closed-form                    2.2x  over a 13,421,772x input range
  halving-recursion             19.5x  over a 13,421,772x input range
  iterative               12418629.1x  over a 13,421,772x input range
```

Reproduce with `npm run bench`.

### A — Gauss closed form, O(1) time / O(1) space

`T(n) = n(n+1)/2`, with the halving done before the multiplication so the
intermediate value stays a full binade below the danger zone. Cost is
independent of `n`: the sum to 134 million is as cheap as the sum to 1.

**This is the one to use in production.** It is the only variant with no
input-dependent cost, and therefore the only one with no algorithmic
denial-of-service surface.

### B — Iterative accumulation, O(n) time / O(1) space

One addition per term, no allocation. Transparently correct by inspection, which
is what makes it the oracle the other two are differential-tested against.

Not for untrusted input on a request path: 134 million iterations block Node's
single thread for ~128 ms.

### C — Recursion by value halving, O(log n) time / O(log n) space

```
T(2k)     = 2·T(k) + k²
T(2k + 1) = T(2k) + (2k + 1)
```

Each step halves `n`, so the entire domain costs **27 calls and 27 stack
frames**. Genuinely recursive, and genuinely distinct from the closed form — it
never evaluates `n(n+1)/2`, only the recurrence.

Two recursive formulations were rejected on the way here:

- **`n + sum(n-1)`** — one stack frame per term, dies with `RangeError` at
  around `n = 10,000` (measured: 10,381 frames on V8), at a threshold that
  shifts with the caller's own stack depth.
- **Range splitting**, `T(lo..hi) = T(lo..mid) + T(mid+1..hi)` — fixes the depth
  (27 frames) but leaves the call count linear at `2n − 1`, which would force an
  artificial cap on the input. Measured at ~10 ms for `n = 1,000,000` against
  ~0.28 µs for halving. **Fixing stack depth is not the same as fixing cost.**

One detail worth flagging: the implementation uses `Math.floor(n / 2)`, never
`n >> 1`. JavaScript's bitwise operators coerce to 32-bit signed integers, so
`3000000000 >> 1` is `-647483648`. The shift is correct across this domain and
would become a silent corruption bug the moment the domain widened.

---

## Behaviour contract

```ts
sum_to_n_a(5)     // 15
sum_to_n_a(0)     // 0
sum_to_n_a(-5)    // -15   (symmetric convention — see below)

sum_to_n_a(3.7)   // throws NonIntegerInputError
sum_to_n_a(NaN)   // throws NonFiniteInputError
sum_to_n_a('5')   // throws NonNumericInputError
sum_to_n_a(1e21)  // throws InputOutOfRangeError
```

All three cover the full domain; none carries an artificial cap.

**Domain:** `[-134,217,727, 134,217,727]` — the range over which `T(n)` is
exactly representable as an IEEE-754 double. Outside it the answer would be
silently wrong, so it is rejected instead. Derivation and measurements:
[`docs/EDGE_CASES.md`](docs/EDGE_CASES.md).

**Negative `n`:** the brief says "any integer" but defines the result only for
positive `n`. There are four defensible conventions; this module defaults to the
symmetric one (`f(-n) === -f(n)`) and makes the choice swappable. The reasoning
is in [`docs/EDGE_CASES.md` §2](docs/EDGE_CASES.md).

**Errors:** every failure is a typed `SummationError` with a stable `code`.
Branch on `error.code`, never on the message.

| Code | Meaning |
|------|---------|
| `ERR_NON_NUMERIC_INPUT` | not a `number` at runtime |
| `ERR_NON_FINITE_INPUT` | `NaN`, `Infinity`, `-Infinity` |
| `ERR_NON_INTEGER_INPUT` | finite, but has a fractional part |
| `ERR_INPUT_OUT_OF_RANGE` | integer, but outside the exact domain |
| `ERR_NEGATIVE_INPUT_REJECTED` | negative, under `RejectNegativePolicy` |
| `ERR_EXCEEDS_STRATEGY_LIMIT` | valid, but past this strategy's practical limit |

---

## Design

```
src/
├── index.ts                        sum_to_n_a / _b / _c + extension surface
├── SummationService.ts             validate → enforce limit → interpret sign
├── domain/
│   ├── constants.ts                derived numeric bounds
│   ├── errors.ts                   typed error hierarchy + safe value rendering
│   └── types.ts                    SummationStrategy, InputValidator, NegativeDomainPolicy
├── validation/SafeIntegerValidator.ts
├── policies/negativeDomainPolicies.ts   4 conventions for negative n
└── strategies/                     the three algorithms
```

The three functions the brief asks for are three lines each. Everything else
exists to handle an input domain that is wider and more hostile than the example
suggests.

**Single responsibility.** A strategy computes `T(n)` for non-negative `n` and
nothing else. It does not validate, does not handle signs, does not enforce
limits. Those are cross-cutting concerns owned by `SummationService`, so the
logic is written once instead of three times.

**Open/closed.** Adding an algorithm, a negative-number convention, or a
stricter validator means adding a file. A test proves this by plugging in a
custom strategy at runtime.

This was verified rather than assumed: a `BigInt` strategy was built during
development to test the claim. It plugged into the service, validator and
policies with no behavioural change anywhere — but the result type was
hard-coded to `number`, so extending it would have meant a generic parameter.
Behaviour was closed for modification; the *type signature* was not. The
strategy itself was then removed, because the brief asks for three
implementations and speculative generality for a fourth that does not ship is
not a virtue. The finding is recorded in `docs/EDGE_CASES.md`.

**Liskov.** The `SummationStrategy` contract requires every implementation to
return *identical* results, differing only in cost. That is enforced
mechanically by `tests/differential.spec.ts`, not left to inspection.

**Interface segregation.** Three small interfaces rather than one wide one. A
validator knows nothing about summation; a strategy knows nothing about what a
valid input looks like.

**Dependency inversion.** `SummationService` depends only on interfaces, all
constructor-injected. Tests use real implementations rather than mocks — there
is nothing to mock.

```ts
// A public endpoint: constant-time algorithm, tight input cap, negatives rejected.
const endpoint = new SummationService({
  strategy: new ClosedFormSummation(),
  validator: new SafeIntegerValidator(0, 10_000),
  negativeDomainPolicy: new RejectNegativePolicy(),
});
```

---

## Security

Written on the assumption that this may end up behind an HTTP handler — the
context Problems 5 and 6 establish.

- **Runtime validation at the trust boundary.** TypeScript types are erased;
  `"5"`, `null` and `{}` all reach the function at runtime.
- **No coercion.** `typeof` checks, never `Number(value)` or `==`, so a hostile
  `valueOf` / `toString` / `Symbol.toPrimitive` is never invoked. Tested with
  booby-trapped objects whose coercion hooks all throw.
- **Error messages never interpolate non-primitives** — only the type is
  reported. Strings are truncated to 32 characters and JSON-escaped, closing
  both log injection and memory abuse.
- **Bounded work.** Input is range-checked before any loop runs, so an
  algorithmic DoS is a fast rejection rather than a blocked event loop.
- **No prototype pollution surface.** No option merging, no dynamic property
  access from input. Tested against a deliberately polluted `Object.prototype`.
- **No `eval`, no `Function`, no I/O, no runtime dependencies.**

---

## Testing

**212 tests · 100% statements / branches / functions / lines · ~4 s**

```
File                        | % Stmts | % Branch | % Funcs | % Lines
----------------------------|---------|----------|---------|--------
All files                   |     100 |      100 |     100 |     100
```

The coverage gate is set to **100%**, above the 90% asked for, because every
branch in this module is a deliberate, reachable decision — an uncovered one
means an untested edge case, which is the substance of this problem.

| File | Covers |
|------|--------|
| `constants.spec.ts` | numeric bounds re-derived from scratch with `BigInt` |
| `validation.spec.ts` | the type / finiteness / integrality / range gates |
| `strategies.spec.ts` | all three algorithms, their limits and stack behaviour |
| `policies.spec.ts` | the four negative-number conventions |
| `service.spec.ts` | orchestration, DI, limit enforcement, statelessness |
| `differential.spec.ts` | the three implementations agree; algebraic properties |
| `edgeCases.spec.ts` | EC-01 … EC-15, mirroring `docs/EDGE_CASES.md` |
| `security.spec.ts` | hostile input, log injection, DoS, prototype pollution |
| `publicApi.spec.ts` | the exported surface |
| `heavy.spec.ts` | opt-in full-domain exactness (`npm run test:heavy`) |

Correctness is checked against a `BigInt` oracle — arbitrary-precision, so it
cannot suffer the floating-point failure modes being tested for. Random sampling
uses a seeded PRNG, so any failure is replayable rather than flaky.

---

## Further reading

**[`docs/EDGE_CASES.md`](docs/EDGE_CASES.md)** — the full catalogue: every edge
case, the worst-case scenarios, the rejected alternatives and why, and two
assumptions that turned out to be wrong when measured.
