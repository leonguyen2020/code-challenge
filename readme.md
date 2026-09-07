# 99Tech Code Challenge — Backend track

| Problem | Task | Status |
|---------|------|--------|
| [4](src/problem4) | Three ways to sum to n | ✅ Complete |
| 5 | A Crude Server (ExpressJS + TypeScript CRUD) | 🚧 In progress |
| 6 | Architecture (live scoreboard specification) | ⏳ Not started |

---

## Problem 4 — Three ways to sum to n

Three implementations of `sum_to_n` in TypeScript, with the complexity of each
annotated in the source and **measured** rather than asserted.

| Function | Algorithm | Time | Space | Measured |
|----------|-----------|------|-------|----------|
| `sum_to_n_a` | Gauss closed form | **O(1)** | O(1) | 4.2 ns, flat across the domain |
| `sum_to_n_b` | Iterative accumulation | O(n) | O(1) | 9.7 ns → 120 ms |
| `sum_to_n_c` | Recursion by value halving | **O(log n)** | O(log n) | 20 ns → 402 ns |

```bash
cd src/problem4
npm install
npm test              # 212 tests, ~4 s
npm run test:coverage # gate: 100% statements/branches/functions/lines
npm run bench         # reproduce the numbers above
```

No runtime dependencies; `npm audit` reports 0 vulnerabilities.

**[Full documentation →](src/problem4)**

The interesting part is not the arithmetic — it is the input domain. The brief
says `n` is "any integer" and that the result may be assumed to fit in
`Number.MAX_SAFE_INTEGER`; both statements hide more than they say.
**[`src/problem4/docs/EDGE_CASES.md`](src/problem4/docs/EDGE_CASES.md)** covers:

- the silent-corruption boundary at `n = 134,217,729`, where the answer is off
  by exactly 1 with no exception, no `NaN`, and no indication;
- the stack-overflow threshold that made textbook recursion unusable (measured
  at 10,381 frames on V8) and the two formulations rejected because of it;
- the 32-bit `>>` trap that is correct across this domain and would become a
  silent bug the moment it widened;
- the four defensible readings of `sum_to_n(-5)`, and why the choice is a
  swappable policy rather than a hard-coded guess;
- two assumptions that turned out to be **wrong** when measured, corrected in
  place rather than quietly dropped.
