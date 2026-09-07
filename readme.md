# 99Tech Code Challenge — Backend track

| Problem | Task | Status |
|---------|------|--------|
| [4](src/problem4) | Three ways to sum to n | ✅ Complete |
| [5](src/problem5) | A Crude Server (ExpressJS + TypeScript CRUD) | ✅ Complete |
| [6](src/problem6) | Architecture (live scoreboard specification) | ✅ Complete |

---

## Local infrastructure

Problem 5 needs PostgreSQL and Redis. Both come from the Docker Compose stack at
the repository root.

```bash
cp .env.example .env      # then set the two passwords
docker compose up -d --wait
./scripts/verify-infra.sh # 31 functional and security checks
```

| Service | Version | Address |
|---------|---------|---------|
| PostgreSQL | 17 (alpine) | `127.0.0.1:5432` |
| Redis | 7 (alpine) | `127.0.0.1:6379` |

`docker compose down` stops the stack and keeps the data; `down -v` destroys it.

**Security posture** — this stack is for local development only, and is hardened
accordingly: ports published on `127.0.0.1` only; credentials required from
`.env` (git-ignored) with no defaults, so the stack refuses to start rather than
booting with a weak password; PostgreSQL enforces `scram-sha-256` and revokes the
`PUBLIC` create-privilege; Redis requires AUTH, runs `protected-mode on`, has
`CONFIG`/`FLUSHALL`/`FLUSHDB`/`DEBUG`/`MODULE` removed, and its password is
rendered into a config file at boot so it never appears in `docker inspect`;
Redis is capped at 256 MB with `allkeys-lru`; both containers run with
`no-new-privileges`. Persistence is verified to survive a container restart.

`scripts/verify-infra.sh` checks all of the above and exits non-zero on failure.

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

---

## Problem 5 — A Crude Server

A CRUD API over a product inventory: **ExpressJS + TypeScript**, **PostgreSQL**
via **TypeORM**, **Redis** for distributed rate limiting.

```bash
docker compose up -d --wait          # from the repository root
cd src/problem5
npm install && npm run migration:run && npm run seed
npm run dev                          # http://localhost:3000
```

**216 tests — 140 unit, 76 integration against a real PostgreSQL — 100%
statements, branches, functions and lines.** `npm audit`: 0 vulnerabilities.

Exactly the five operations the brief asks for. The engineering is in how they
behave: keyset pagination, optimistic concurrency via `If-Match`, RFC 9457 error
documents, integer money, and validation that turns hostile input into a 4xx
rather than a 500.

**[Full documentation →](src/problem5)**

Two bugs were found by tests in code that looked like it worked, and both are
written up in
**[`src/problem5/docs/EDGE_CASES.md`](src/problem5/docs/EDGE_CASES.md)**:

- a **lost-update race** that a passing concurrency test had already declared
  safe — TypeORM's `@VersionColumn` increments the version but adds no version
  predicate to the `UPDATE`, so ten concurrent conditional writes all succeeded;
- a **keyset cursor less precise than the row it pointed at** — PostgreSQL stores
  microseconds, a JavaScript `Date` holds milliseconds, so the boundary row was
  returned on two consecutive pages.

---

## Problem 6 — Architecture

A specification, not an implementation: the brief asks for a `README.md`, a
diagram of the execution flow, and comments for improvement, to be handed to a
backend engineering team to build.

The module is a **live top-10 scoreboard** — PostgreSQL as the system of record,
a Redis read model kept current by a transactional outbox and a projector, and
SSE for live delivery.

**[Full specification →](src/problem6)** · ~3,900 lines across six documents,
each written for a named audience — because a specification that only its author
can read has not been delivered:

| Document | For |
|---|---|
| [Specification](src/problem6/README.md) | Deciding whether the design is right |
| [Implementation guide](src/problem6/docs/IMPLEMENTATION_GUIDE.md) | Whoever writes the code — interfaces, tickets, and the seven mistakes that fail silently |
| [Glossary](src/problem6/docs/GLOSSARY.md) | Anyone — every assumed term defined once |
| [Decision records](src/problem6/docs/DECISIONS.md) | Reviewers, and whoever revisits this later |
| [Threat model](src/problem6/docs/THREAT_MODEL.md) | Security review |
| [OpenAPI 3.1 contract](src/problem6/docs/openapi.yaml) | Clients and contract tests |

Six Mermaid diagrams, all verified by rendering; every `$ref` in the OpenAPI
file and all 100+ internal links resolve.

The document is built around one finding, stated in its first section:

> **Requirements 4 and 5 are in tension, and the tension cannot be fully
> resolved at the API layer.**

If the client is the party that announces "the action finished", then
authentication proves *who is calling* — not *that the action happened*. A user
holding a legitimate session can copy the request from the network tab and
replay it in a loop; every one of those requests is authenticated, is from the
real user, and is fraudulent. So the requirement is split in two:

- **"increase someone else's score, or invent one from nothing"** — closed
  completely. Identity comes from the verified token subject and the point value
  from a server-side catalogue; neither may cross the trust boundary.
- **"replay or automate your own action"** — mitigated, not solved. Single-use
  action tokens, a minimum plausible duration, idempotency, per-user velocity
  budgets, anomaly detection and a reversible ledger raise the cost and make the
  abuse *legible* — the real value of the action token is that it turns an
  attack into a signal.

The residual risk is stated plainly rather than hidden behind the control list,
along with the architectural change that would actually close it and the
recommendation not to attach prizes or money to rank until it ships.

The rest follows from that, and from a second rule — PostgreSQL is the only
system of record, Redis is a cache that can be destroyed and rebuilt — which is
what lets the service keep accepting writes with the cache down. Also covered:
why every broadcast is a full snapshot rather than a delta (Redis Pub/Sub is
at-most-once, and a delta stream diverges permanently on one lost message); a
packed composite ZSET score that makes ties resolve to whoever got there first,
with its 8.4-million-point cap and mandatory alert documented rather than
discovered; why the increment is an atomic `+=` and *not* the optimistic locking
Problem 5 uses; and the fan-out arithmetic showing that broadcasting on every
increment would need 10 GB/s of egress per instance, which is why change
detection and a 1 Hz cap are requirements rather than optimisations.
