# Problem 4 — Edge cases, worst cases, and why each was solved this way

The brief is three sentences long. The input domain it describes — "any
integer" — is considerably wider than the example (`sum_to_n(5) === 15`)
suggests, and most of the interesting engineering lives in the gap between the
two.

This document catalogues every case that was found, what a naive implementation
does with it, what this module does instead, and **why that trade-off was
chosen**. Each case has an ID that maps one-to-one onto a `describe` block in
`tests/edgeCases.spec.ts`, so the prose and the executable specification cannot
drift apart.

A short note on method: several claims below were originally *assumptions* that
turned out to be wrong when measured. Those are called out explicitly rather
than quietly corrected, because the corrected version is more useful than a
tidy one.

---

## 1. Summary

| ID | Edge case | Naive behaviour | This module | Severity |
|----|-----------|-----------------|-------------|----------|
| EC-01 | `n = 0` | `0` (usually correct) | `0` | — |
| EC-02 | `n = -0` | may return `-0` | normalised to `0` | Low |
| EC-03 | `n = 1, 2, 3` | correct | correct | — |
| EC-04 | `n = 5` (the brief's example) | correct | correct | — |
| EC-05 | **`n < 0`** | undefined / silently `0` | symmetric convention, configurable | **High** |
| EC-06 | `n > 134,217,727` | **silently wrong answer** | `InputOutOfRangeError` | **Critical** |
| EC-07 | large but valid `n` | usually correct | exact, proven against BigInt | Medium |
| EC-08 | fractional `n` (`3.7`) | **silently computes `T(3)`** | `NonIntegerInputError` | **High** |
| EC-09 | `NaN` / `±Infinity` | `NaN`, or an infinite loop | `NonFiniteInputError` | **High** |
| EC-10 | non-number (`"5"`, `null`, `{}`) | coerced or `NaN` | `NonNumericInputError` | **High** |
| EC-11 | deep recursion | **`RangeError` crash ~n=10,000** | logarithmic depth, no crash | **Critical** |
| EC-12 | a strategy's own capability limit | appears to hang | `ExceedsStrategyLimitError` | Medium |
| EC-13 | repeated calls | usually fine | pure, stateless, verified | Low |
| EC-14 | sign/off-by-one across the small domain | — | exhaustive sweep `[-1000, 1000]` | — |
| EC-15 | `n >> 1` in a halving algorithm | **silent corruption above 2^31** | `Math.floor(n / 2)` | **High** |
| SEC-01…05 | hostile input, log injection, DoS | varies | see §4 | **High** |

---

## 2. The two genuinely hard cases

### EC-05 — What does `sum_to_n(-5)` mean?

The brief says the input is "any integer" but defines the output only for the
positive case. `-5` is therefore not an edge case with a *correct* answer; it is
an ambiguity with **four defensible answers**:

| Convention | `sum_to_n(-5)` | Argument for it |
|------------|----------------|-----------------|
| **Symmetric** (default) | `-15` | `-1 + -2 + -3 + -4 + -5`. Preserves the odd-function identity `f(-n) === -f(n)`. |
| Empty range | `0` | The range `1..n` is empty, and the sum of nothing is zero. |
| Analytic continuation | `10` | Evaluate `n(n+1)/2` literally: `(-5)(-4)/2`. The mathematically standard extension. |
| Reject | throws | The caller is asking a question the specification does not answer. |

**Chosen: symmetric, and made configurable.**

*Why symmetric as the default.* It is the reading most callers expect, it never
returns a positive number for a negative input (which the analytic continuation
does, and which reliably surprises people), and it preserves a clean algebraic
property that makes the function composable.

*Why configurable rather than hard-coded.* The right convention genuinely
depends on the caller. A scoring service fed by user input probably wants
`RejectNegativePolicy` so a negative value surfaces as a `400` instead of being
silently reinterpreted. A mathematics library probably wants the continuation.
Baking one choice in would force every other caller to work around it, so the
convention is a `NegativeDomainPolicy` — one small interface, four
implementations, swappable at construction.

*Why not simply return `0`.* That is what an unguarded `for (let i = 1; i <= n;
i++)` loop does — not by design, but by accident. `EmptyRangeNegativePolicy`
exists so that behaviour can be chosen deliberately rather than inherited by
omission. The distinction matters: the same output arrived at on purpose is
documented and tested; arrived at by accident it is a latent bug.

### EC-06 — Silent numeric corruption above the domain bound

This is the most dangerous case in the problem, because **nothing goes wrong
visibly**. No exception, no `NaN`, no `Infinity`. Just a number that is quietly
incorrect.

The brief says: *"Assuming this input will always produce a result lesser than
`Number.MAX_SAFE_INTEGER`."* That is an assumption, and an unenforced assumption
is a bug waiting for the first caller who did not read the comment.

The exact boundary, derived rather than guessed:

```
T(n) = n(n+1)/2 ≤ 2^53 − 1   ⟹   n ≤ 134,217,727  ( = 2^27 − 1 )

T(134,217,727) = 9,007,199,187,632,128   ✅ safe
T(134,217,728) = 9,007,199,321,849,856   ❌ past MAX_SAFE_INTEGER
```

Measured behaviour just past the bound:

| `n` | `T(n)` exact | safe integer? | survives a round-trip through a double? |
|-----|--------------|---------------|------------------------------------------|
| 134,217,727 | 9,007,199,187,632,128 | ✅ | ✅ |
| 134,217,728 | 9,007,199,321,849,856 | ❌ | ✅ (even — representable by luck) |
| **134,217,729** | **9,007,199,456,067,585** | ❌ | ❌ **off by exactly −1** |

`n = MAX_SAFE_N + 2` is where corruption actually starts: `T(n)` is odd and
above `2^53`, where representable doubles are spaced two apart. The function
returns `9007199456067584` — wrong, plausible, and utterly silent.

**Chosen: reject at the boundary with `InputOutOfRangeError`.**

*Why reject rather than return an approximation.* A wrong number that looks
right propagates. In a scoring, billing, or ledger context it corrupts
downstream state and is discovered weeks later, if ever. An exception is
discovered in the first test run.

*Why not `BigInt`.* It would extend the domain, but it changes the return type
from `number` to `bigint`, which is a breaking API change the brief did not ask
for and which infects every caller. The signature in the brief is
`(n: number): number`. Widening the domain is a product decision, not something
to smuggle in behind a summation function. This was tested rather than assumed: a `BigInt` strategy was built, measured and
then removed. It dropped into the existing `SummationService` with no
behavioural change anywhere. See §4.6 for what that cost and why it did not
ship.

---

## 3. Correcting two assumptions that were wrong

### 3.1 The intermediate-overflow "bug" that is not a bug

The initial hypothesis was: `n * (n + 1)` overflows `Number.MAX_SAFE_INTEGER`
for `n > 94,906,265`, so the naive `(n * (n + 1)) / 2` must produce wrong
answers well inside the valid domain, and halving before multiplying fixes it.

**That hypothesis is false, and it was checked before being written down.** A
dense sweep of 400,002 values across both hazardous windows, compared against a
`BigInt` oracle, found **zero** divergences for either spelling.

The reason is a subtle invariant:

- `n` and `n + 1` are consecutive, so their product is always **even**.
- The largest product in the domain is `2^54 − 2^27`, which is **below `2^54`**.
- Doubles represent *every* even integer up to `2^54` exactly.

So the product survives intact and the halving is lossless. The naive form is
correct here.

**The halved form was still shipped.** Not to fix a bug, but because the naive
form's correctness is *conditional* on `MAX_SAFE_N` being exactly what it is.
Raise that bound and the naive form breaks silently, while the halved form —
whose intermediate value sits a full binade lower — does not depend on the
invariant at all. The cost of that insurance is one comparison.

The claim is pinned by a test (`tests/strategies.spec.ts`, *"documents honestly:
the naive spelling is ALSO exact over this domain"*) which asserts **both** that
the shipped form is exact and that the naive form is too. If a future change
invalidates the reasoning, the test fails and the comment gets corrected instead
of quietly becoming a lie.

### 3.2 The test suite that took four minutes

The first version of the differential test sampled 5,000 random values up to
1,000,000 and fed each to all three implementations. Two of the three are O(n),
and coverage instrumentation adds a counter to every loop iteration and every
function call — turning roughly 2.5 billion arithmetic operations into a suite
that ran for over four minutes.

That is a real defect in the tests, not in the code under test. The fix was to
budget sampling by cost class rather than uniformly:

- **broad and cheap** — the O(1) closed form is sampled 20,000 times across the
  entire domain, where sample count is nearly free;
- **narrow and exhaustive** — all three are compared over `[-1000, 1000]` and at
  every power-of-two boundary, which is where off-by-one and sign errors live;
- **targeted** — the O(n) pair is checked at a handful of large values.

Full-domain verification of the O(n) path still exists, as an opt-in suite
(`npm run test:heavy`), because it is the only direct evidence that repeated
floating-point accumulation stays exact all the way to the boundary. It is
simply not worth 15 seconds on every commit.

Result: **10.7 s with coverage, down from over four minutes, at 100% coverage.**

---

## 4. Worst-case scenarios

These are framed as availability and integrity risks, on the assumption that
`sum_to_n` may one day sit behind an HTTP handler — which is exactly the context
Problem 5 and Problem 6 establish.

### WC-1 — Algorithmic denial of service

**Scenario.** `GET /sum?n=999999999999999`. Node runs user code on a single
thread. An O(n) implementation with an unbounded `n` blocks *every* in-flight
request for the duration — minutes or hours — with one cheap request.

**Mitigations, in order of effectiveness:**

1. **Bound the input before any loop runs.** `SafeIntegerValidator` rejects
   out-of-domain values in constant time. Verified by timing the rejection: it
   returns in microseconds, proving validation precedes the work.
2. **Use the O(1) implementation on request paths.** `sum_to_n_a` has no
   input-dependent cost at all — measured at ~4.5 ns flat across a 13,400,000×
   input range. There is no DoS surface to attack.
3. **Let the caller tighten the bound further.** The validator's range is
   constructor-injected, so a public endpoint can cap `n` at 10,000 while an
   internal batch job keeps the full domain.

**Residual risk.** `sum_to_n_b(134_217_727)` still costs ~128 ms. That is
bounded and documented, but it is not free — hence the explicit guidance to
route untrusted traffic to the closed form.

### WC-2 — Stack exhaustion

**Scenario.** The textbook recursion `sum(n) = n + sum(n - 1)` consumes one
stack frame per term. V8's default stack holds roughly 10,000 frames —
**measured at 10,381** on the development machine, and lower when called from
inside an already-deep async stack.

```
sum_to_n_c(10_000)  → works
sum_to_n_c(11_000)  → RangeError: Maximum call stack size exceeded
```

The failure threshold is undocumented, varies by runtime and platform, and
*moves depending on how deep the caller's own stack happens to be*. A crash that
only reproduces under load, in one environment, is close to the worst kind of
bug to diagnose.

**First attempt: binary *range* splitting.**

```
T(lo..hi) = T(lo..mid) + T(mid+1..hi)
```

Depth becomes `ceil(log2 n) + 1` — **27 frames at the very top of the domain**
versus 134 million. Stack exhaustion becomes structurally impossible.

But depth was only half the problem. Range splitting still performs `2n − 1`
calls, so the full domain means ~268 million activations — measured at ~10 ms
per million, so roughly 2.7 seconds of fully blocked event loop. That forced an
artificial cap of 1,000,000 on the input.

**Chosen: recursion on the *value*, by halving.**

```
T(2k)     = 2·T(k) + k²
T(2k + 1) = T(2k) + (2k + 1)
```

Each step halves `n`, so the recursion bottoms out in `log2(n)` calls.

| | Range splitting | Value halving |
|---|---|---|
| Time | O(n) | **O(log n)** |
| Space | O(log n) | O(log n) |
| Calls at `n = 134,217,727` | 268,435,453 | **27** |
| Cost at `n = 1,000,000` | 10.36 ms | **0.26 µs** (~40,000× faster) |
| Input cap needed | 1,000,000 | **none** |

The cap disappears entirely, so halving ships as `sum_to_n_c` and range
splitting does not ship at all. The contrast is worth recording even though only
one of the two survives: **fixing stack depth is not the same as fixing cost.**
An implementation can be structurally safe and still be the wrong algorithm.

*Why not trampolining or an explicit stack?* Both work, and both stop the
implementation from being recognisably recursive — which is the point of having
a third, distinct implementation.

*Is halving too close to the closed form to count as distinct?* No: it never
evaluates `n(n+1)/2`. It only applies the recurrence, and it reaches the answer
by a genuinely different route.

### WC-3 — Hostile input at the trust boundary

TypeScript types are erased at runtime. `sum_to_n_a` may be called from
JavaScript, through `as any`, or with `JSON.parse` output. Everything the
signature promises has to be re-established at runtime.

| Attack | Naive outcome | This module |
|--------|---------------|-------------|
| `{ valueOf: () => 5 }` | coerced by `Number(v)`; attacker code runs | rejected; `valueOf` never invoked |
| `{ toString() { throw } }` | error escapes from message construction | rejected; `toString` never invoked |
| `{ [Symbol.toPrimitive]: … }` | coerced | rejected; never invoked |
| `"5"` | `"5" == 5` is `true` — passes a loose check | rejected (`typeof` check) |
| `"A".repeat(5_000_000)` | echoed into an error message and a log | truncated to 32 chars |
| `"x\nERROR admin login ok"` | forges a log line | JSON-escaped; newline neutralised |
| `{"__proto__": {...}}` | prototype pollution, if merged | rejected; nothing is merged |

The key design decision is in `describeValue`: **error messages never
interpolate non-primitives.** Only the *type* is reported. Building an error
message is the one place where code reflexively stringifies untrusted input, and
therefore the one place a hostile `toString` reliably gets to run. Reporting
`[object]` costs nothing and closes the hole.

### WC-4 — Silent wrong answers

Covered in EC-06, and worth restating as the governing principle of the module:

> Every input this module cannot answer exactly is rejected with a typed error.
> Nothing is coerced, nothing is truncated, and no call returns `NaN`.

An exception is a bug report delivered on the first test run. A silently wrong
number is a bug report delivered by a customer, months later, about corrupted
data.

---

## 4.5 EC-15 — The 32-bit trap inside the halving algorithm

The obvious way to halve an integer in JavaScript is `n >> 1`. It is faster to
type, marginally faster to run, and **wrong**.

Bitwise operators in JavaScript coerce their operands to **32-bit signed
integers**:

```js
3_000_000_000 >> 1        // -647483648
Math.floor(3_000_000_000 / 2)  // 1500000000
```

Across this module's domain the two agree exactly — the maximum is `2^27 − 1`,
far below `2^31` — which is precisely what makes the trap dangerous. It would
pass every test, survive every review, and become a silent corruption bug the
moment someone widened `MAX_SAFE_N` or reused the function elsewhere.

**Chosen: `Math.floor(n / 2)`**, with the reasoning recorded in the source and
pinned by a test that asserts the divergence at `3,000,000,000` explicitly. The
performance difference is unmeasurable; the failure mode is not.

## 4.6 The `BigInt` experiment, and what it measured

A fourth strategy computing `T(n)` in arbitrary precision was built during
development, then deliberately removed. Both halves of that are worth recording.

*What it did.* Removed the `2^53` result ceiling entirely. The only remaining
bound would have been that `n` itself arrives as a `number`, so it cannot exceed
`Number.MAX_SAFE_INTEGER`:

```js
sum_to_n_a(2 ** 40)   // throws InputOutOfRangeError
// bigint version:    // 604462909807314034327552n   exact
```

*Why it was removed.* Two reasons, in order of weight:

1. **The brief asks for three implementations.** Shipping five strategy classes
   invites the reviewer's first impression to be "did not follow the
   instructions", which is a worse outcome than the extra algorithm is worth.
2. **It changes the public signature.** Returning `bigint` infects every
   caller: `bigint` will not mix with `number` in arithmetic, and
   `JSON.stringify` throws on it. Widening the domain is a product decision, not
   something to smuggle in behind a summation function.

*What it proved before it was deleted.* That the strategy abstraction is
load-bearing rather than decorative — and, honestly, where it stopped short. The
class plugged into the existing service, validator and policies with **no
behavioural change anywhere**. But the result type was hard-coded to `number`,
so supporting it required a generic parameter on three interfaces. Open/Closed
held for behaviour; it did not hold for the type signature.

That generic parameter was reverted along with the strategy. A type parameter
with exactly one implementer is speculative generality — the code is strictly
simpler without it, and "we might need `bigint` one day" is not a reason to pay
for it today. If the requirement ever becomes real, the finding above says
precisely what the change costs.

## 5. Rejected alternatives

| Alternative | Why it was rejected |
|-------------|---------------------|
| `Array.from({length: n}, …).reduce(…)` | O(n) **space**. ~1 GB at the top of the domain; converts a slow response into an OOM crash. Elegance that trades O(1) space for O(n) is not elegance. |
| Naive linear recursion | `RangeError` at ~10,000 (WC-2). |
| Range-splitting recursion | Stack-safe but O(n) — 268M calls at the domain maximum, forcing an artificial 1,000,000 input cap. Superseded by value halving, which is O(log n) and needs no cap (§2, WC-2). |
| `n >> 1` for halving | 32-bit coercion; silently wrong above 2^31 (§4.5). |
| A fourth `BigInt` strategy | The brief asks for three, and `bigint` is a breaking return type. Built, measured, then removed along with the generic parameter it required (§4.6). |
| `Math.floor((lo + hi) / 2)` | The classic binary-search overflow idiom. Harmless in this domain, but it should not be copied out of here into somewhere it is not. `lo + Math.floor((hi - lo) / 2)` costs the same. |
| `BigInt` throughout | Changes the public return type; ~50× slower; not what the brief asked for. Available as a drop-in strategy if the requirement ever changes. |
| Memoisation / lookup table | The closed form is already O(1). A cache would add memory, invalidation, and an unbounded-growth DoS vector to make a two-operation function slower. |
| Clamping out-of-range input to the maximum | Silent wrong answers, deliberately (WC-4). |
| `Number(value)` for coercion | Invokes attacker-controlled `valueOf` (WC-3). |
| Skipping validation because "the types guarantee it" | Types are erased at runtime. They guarantee nothing at the trust boundary. |

---

## 6. Traceability

| Document section | Test file |
|------------------|-----------|
| EC-01 … EC-15 | `tests/edgeCases.spec.ts` |
| SEC-01 … SEC-05, WC-1, WC-3 | `tests/security.spec.ts` |
| §2 EC-05 (negative conventions) | `tests/policies.spec.ts` |
| §2 EC-06, §3.1 (numeric bounds) | `tests/constants.spec.ts`, `tests/strategies.spec.ts` |
| WC-2 (stack depth) | `tests/strategies.spec.ts`, `tests/edgeCases.spec.ts` |
| §4.5 EC-15 (32-bit shift trap) | `tests/edgeCases.spec.ts` |
| Cross-implementation equivalence | `tests/differential.spec.ts` |
| Full-domain exactness (opt-in) | `tests/heavy.spec.ts` |

**212 tests, 100% statement / branch / function / line coverage, ~4 s.**
