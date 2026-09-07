# Implementation guide

The [specification](../README.md) says *what* to build and *why*. This document
says *how to start*, and spells out the parts most likely to be built wrong.

**Who this is for.** Anyone picking up a ticket on this module. If a term in the
spec is unfamiliar, [`GLOSSARY.md`](GLOSSARY.md) defines it. If you want to know
why a decision was made rather than how to implement it,
[`DECISIONS.md`](DECISIONS.md) has the argument.

**How to use it.** Read §1 and §2 once. Then, before writing the code for a
ticket, read the matching entry in §3 — those seven entries are where the real
mistakes happen, and five of the seven fail *silently*, which means tests that
pass and a bug found weeks later in production.

The code below is **reference, not delivery**. It shows the shape and the
hazards; the team writes the real thing, with the tests.

**Contents:** [Getting started](#1-getting-started) ·
[The contracts](#2-the-contracts) ·
[Seven ways to get this wrong](#3-seven-ways-to-get-this-wrong) ·
[Tickets](#4-tickets) · [Tests that matter](#5-tests-that-matter) ·
[Before you open a PR](#6-before-you-open-a-pr)

---

## 1. Getting started

### What already exists in this repository

Do not start from an empty folder. [Problem 5](../../problem5) is the same
stack, already wired, and most of its infrastructure is directly reusable:

| Take from Problem 5 | Why |
|---|---|
| `src/config/env.ts` | Validated configuration that refuses to boot on a missing secret, listing *every* problem at once |
| `src/shared/errors.ts` | The `AppError` taxonomy with `code` + `httpStatus` on the error itself |
| `src/shared/logger.ts` | Structured logging with credential redaction |
| `src/interfaces/http/middleware/errorHandler.ts` | RFC 9457 responses; internal detail logged, never returned |
| `src/interfaces/http/middleware/requestContext.ts` | `X-Request-Id` validation and correlation |
| `src/interfaces/http/middleware/rateLimit.ts` | The Lua fixed-window limiter — extend it to a token bucket per §8.4 |
| `src/app.ts` | Middleware ordering, `helmet`, CORS, the "no `listen` here" pattern |
| `jest.config.js`, `tsconfig.json` | Test projects (unit vs integration), strict compiler settings |

The infrastructure is also already there: PostgreSQL 17 and Redis 7 come from
the repository-root `docker-compose.yml`, hardened and verified by
`scripts/verify-infra.sh`.

```bash
# from the repository root
cp .env.example .env          # set the two passwords
docker compose up -d --wait
./scripts/verify-infra.sh
```

### The one-paragraph mental model

A user finishes an action and the browser calls the API. The API checks it is
really that user, decides how many points the action is worth (the client never
says), and writes three rows to PostgreSQL in one transaction: the award itself,
the user's new total, and a note saying "the board needs updating". A background
loop reads those notes and updates a Redis sorted set, which is what the
scoreboard is actually read from. When the top 10 changes, it publishes the new
board, and every API instance pushes it down the open connections it is holding.

That is the whole module. Everything else is making each of those steps correct
when things go wrong.

---

## 2. The contracts

Write these interfaces first. They are the seams the spec's layering
([§3.3](../README.md#33-internal-structure)) depends on: the use cases talk to
these, and nothing else knows whether the other side is PostgreSQL, Redis, or an
in-memory fake in a test.

```ts
// ─── domain/scoreboard/ActionCatalogue.ts ───────────────────────────────────
// The server's authority on what an action is worth. This existing at all is
// the defence against a client sending its own point value.

export interface ActionDefinition {
  readonly actionType: string;
  readonly points: number;
  /** Shortest time in which this action can plausibly be completed. */
  readonly minDurationMs: number;
  /** Ceiling on points from this action type, per user, per hour. */
  readonly hourlyPointCap: number;
}

export interface ActionCatalogue {
  /** Recorded on every ledger row so historical awards stay explicable. */
  readonly version: number;
  /** Throws UnknownActionTypeError - never returns a default. */
  lookup(actionType: string): ActionDefinition;
}

// ─── domain/scoreboard/ScoreLedger.ts ───────────────────────────────────────
// The write side. One method, because there is exactly one way to change a
// score and it is the transaction in spec §6.2.

export interface RecordAwardCommand {
  readonly eventId: string;
  readonly userId: string;
  readonly actionType: string;
  readonly points: number;
  readonly idempotencyKey: string;
  readonly actionTokenJti: string;
  readonly catalogueVersion: number;
  readonly requestId: string;
  readonly clientIpHash: Buffer | null;
}

export interface AwardResult {
  /** bigint, not number: totals outlive Number.MAX_SAFE_INTEGER assumptions. */
  readonly totalScore: bigint;
  readonly reachedAt: Date;
  readonly version: number;
  readonly isVisible: boolean;
  /** 'replayed' means the idempotency key was already used. Award once. */
  readonly outcome: 'awarded' | 'replayed';
}

export interface ScoreLedger {
  record(command: RecordAwardCommand): Promise<AwardResult>;
  getTotal(userId: string): Promise<AwardResult | null>;
}

// ─── domain/scoreboard/ScoreboardReadModel.ts ───────────────────────────────
// The read side. Split from the write side so the board can be served from
// PostgreSQL when Redis is down (spec §9, F2) without a branch in every caller.

export interface ScoreboardEntry {
  readonly rank: number;
  readonly userId: string;
  readonly displayName: string;
  readonly score: number;
}

export interface BoardSnapshot {
  readonly version: number;
  readonly generatedAt: Date;
  readonly entries: readonly ScoreboardEntry[];
}

export interface ScoreboardReadModel {
  getTop(limit: number): Promise<BoardSnapshot>;
  getRank(userId: string): Promise<{ rank: number; score: number } | null>;
  getNeighbours(userId: string, radius: number): Promise<readonly ScoreboardEntry[]>;
}

// ─── domain/scoreboard/Outbox.ts ────────────────────────────────────────────

export interface OutboxRow {
  readonly seq: bigint;
  readonly userId: string;
  readonly totalScore: bigint;
  readonly reachedAt: Date;
  readonly isVisible: boolean;
}

export interface Outbox {
  /** FOR UPDATE SKIP LOCKED - several workers can claim different batches. */
  claim(batchSize: number): Promise<readonly OutboxRow[]>;
  markProcessed(seqs: readonly bigint[]): Promise<void>;
  /** now() - oldest unprocessed created_at. The module's key metric (§11). */
  lagSeconds(): Promise<number>;
}
```

**Write an in-memory implementation of each of these before writing the real
one.** Problem 5's `tests/support/InMemoryProductRepository.ts` is the pattern:
a real implementation of the same contract, not a mock. It lets the use cases be
tested with no infrastructure at all, and — more usefully — it forces the
interface to be honest, because anything that only makes sense for Redis will
not fit.

---

## 3. Seven ways to get this wrong

Five of these fail silently. That is why they are listed.

### 3.1 Taking the user id from the request

**The bug.** Anywhere in this module:

```ts
const userId = req.body.userId;        // ✗
const userId = req.query.userId;       // ✗
const userId = req.header('X-User-Id') // ✗
```

Any of these means any user can score for any other user. This is the whole of
threat T-01, and it usually arrives later, in a "just for internal use"
endpoint.

**The fix.**

```ts
const userId = req.auth.subject;       // ✓ the ONLY source, everywhere
```

Enforce it in three places so breaking it takes three mistakes: the zod schema
uses `.strict()` so `userId` in a body is a `400`; the service signature takes
an `AuthenticatedUser` rather than a `string`; and a test asserts that a request
carrying someone else's id returns `400` **and leaves that user's score
unchanged**. Consider a lint rule that fails the build on `body.userId`.

### 3.2 Read-modify-write on the total

**The bug.** The natural way to write it, and wrong:

```ts
const row = await repo.findOne({ where: { userId } });   // ✗
row.totalScore += points;
await repo.save(row);
```

Two requests read `100` at the same moment. One writes `150`, the other writes
`130`. No error, no exception — one award has simply vanished. Under exactly the
concurrency this endpoint is built for.

**The fix.** Let the database do the addition, in one statement:

```sql
INSERT INTO user_scores (user_id, total_score, reached_at, version)
VALUES ($1, $2, now(), 1)
ON CONFLICT (user_id) DO UPDATE
   SET total_score = user_scores.total_score + EXCLUDED.total_score,
       reached_at  = now(),
       version     = user_scores.version + 1
RETURNING total_score, reached_at, version, is_visible;
```

The row lock is held for the statement's duration, so concurrent increments
serialise correctly. Do **not** add optimistic locking here — increments are
commutative, so interleaving is safe, and `If-Match` would produce conflicts for
operations that were never in conflict
([ADR-007](DECISIONS.md#adr-007-atomic-in-place-increment-rather-than-optimistic-locking)).

The test that catches this: fire 100 concurrent increments at one user and
assert the total is exactly `100 × points`. Run it 20 times — a race that
reproduces one time in five is still a race.

### 3.3 Verifying the JWT loosely

**The bug.**

```ts
jwt.decode(token);                     // ✗ no verification at all
jwt.verify(token, publicKey);          // ✗ algorithm comes from the token
```

The second is the dangerous one, because it looks correct. If the library takes
`alg` from the token header, an attacker sets `alg: none`, or switches RS256 to
HS256 so the *public* key is used as an HMAC secret — and the public key is
public.

**The fix.** Whitelist the algorithm server-side, and verify every claim:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwks = createRemoteJWKSet(new URL(config.jwksUri), {
  cacheMaxAge: 10 * 60_000,   // keys cached, so the IdP is not on the hot path
  timeoutDuration: 3_000,
});

const { payload } = await jwtVerify(token, jwks, {
  algorithms: ['RS256'],      // ✓ decided here, never read from the token
  issuer: config.jwtIssuer,
  audience: config.jwtAudience,
  clockTolerance: '60s',
});

return { subject: payload.sub as string };
```

If the `kid` is unknown and the JWKS endpoint is unreachable, return `503`.
Never "allow because we could not check" — this is the one place in the module
that must fail closed without argument.

### 3.4 Consuming the action token with a race

**The bug.**

```ts
const pending = await redis.get(`action:${jti}`);   // ✗
if (!pending) throw new ActionAlreadyClaimedError();
await redis.del(`action:${jti}`);
```

Two concurrent requests both `GET` before either `DEL`s. Both pass. Double
points.

**The fix.** `DEL` reports how many keys it removed, so exactly one caller wins:

```ts
const consumed = await redis.del(`action:${jti}`);   // ✓
if (consumed !== 1) throw new ActionAlreadyClaimedError();
```

The durable backstop is the `UNIQUE (action_token_jti)` index — if Redis lost
the key, PostgreSQL still rejects the second insert with `23505`. Two defences
at different layers, failing independently.

### 3.5 The projector: the loop, the lock, and why the lock is not the safety

The projector is a background loop, not a request handler. Nobody waits for it.

```ts
export class Projector {
  private stopping = false;

  async run(): Promise<void> {
    while (!this.stopping) {
      const held = await this.leader.acquireOrRenew();
      if (!held) { await sleep(1_000); continue; }

      const batch = await this.outbox.claim(500);
      if (batch.length === 0) { await sleep(200); continue; }   // poll interval

      for (const row of batch) {
        await this.readModel.apply(row);    // idempotent: see the Lua guard
      }
      await this.outbox.markProcessed(batch.map((r) => r.seq));

      const top = await this.readModel.getTop(10);
      if (this.changed(top)) await this.publisher.publish(top);  // §7.3
    }
  }
}
```

Leader election, so N replicas do not all project at once:

```ts
// acquire: SET NX PX. renew: extend ONLY if we still hold it.
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;
```

**Read this next part carefully, because it is the thing juniors most often
invert.** The lock is an *efficiency* measure, not the correctness measure. Two
projectors running at once must still be safe, because during a failover or a
GC pause they *will* both run. Correctness comes from two other things:

1. `FOR UPDATE SKIP LOCKED` — two workers claim different rows, never the same
   row.
2. The Lua sequence guard in [§6.5](../README.md#65-the-projector-and-why-it-is-idempotent)
   — applying an old row is a no-op rather than a regression to a stale total.

Without the guard, a replayed outbox row makes a user's score visibly go *down*.
Never write the projector assuming the lock holds.

Emit `scoreboard_projector_lag_seconds` from `outbox.lagSeconds()` — computed
from the **table**, not from a timer inside the loop. A lag metric published by
the projector reads zero when the projector is dead, which is exactly backwards.

### 3.6 SSE without backpressure

**The bug.**

```ts
for (const conn of connections) conn.res.write(frame);   // ✗
```

A phone on a weak connection cannot drain the socket. `write()` returns `false`,
the code ignores it, frames accumulate in memory, and the process dies — under
load, which is when it matters.

**The fix.** Because every frame is a full snapshot, a slow client can simply be
skipped and resynced later:

```ts
class Connection {
  private blocked = false;
  private needsResync = false;

  send(frame: Buffer, latest: () => Buffer): void {
    if (this.blocked) { this.needsResync = true; return; }   // ✓ drop, don't queue

    if (!this.res.write(frame)) {
      this.blocked = true;
      this.res.once('drain', () => {
        this.blocked = false;
        if (this.needsResync) { this.needsResync = false; this.send(latest(), latest); }
      });
    }
  }
}
```

Close the connection if it stays blocked past ~30 s or ~256 KB buffered;
`EventSource` reconnects and gets a fresh snapshot.

Two more things in the same area:

```ts
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-store',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',        // or a proxy buffers your "live" updates
});
res.write(`retry: ${3000 + Math.floor(Math.random() * 1200) - 600}\n\n`);  // jitter
```

Without the jitter, a deploy that drops 20,000 connections brings them all back
in the same 50 ms window. Serialise the frame **once per broadcast** and write
the same `Buffer` to every connection — not once per connection.

### 3.7 The packed score, and the 32-bit trap

**The bug.**

```ts
const composite = (points << 30) | (TIME_MASK - t);   // ✗
```

JavaScript's bitwise operators truncate to **32 bits**. `points << 30` overflows
immediately and the value is destroyed — silently, producing a plausible-looking
wrong number. Problem 4 documents the same trap with `>>`.

**The fix.** Arithmetic, not bit operators:

```ts
const POINTS_BITS = 23;
const TIME_BITS   = 30;
const TIME_SPAN   = 2 ** TIME_BITS;            // 1_073_741_824
const TIME_MAX    = TIME_SPAN - 1;             // 1_073_741_823
const MAX_POINTS  = 2 ** POINTS_BITS - 1;      // 8_388_607
const EPOCH_MS    = Date.UTC(2026, 0, 1);

export function packScore(points: number, reachedAt: Date): number {
  if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
    throw new ScoreOutOfRangeError(points);    // never silently wrap
  }
  const t = Math.floor((reachedAt.getTime() - EPOCH_MS) / 1000);
  if (t < 0 || t > TIME_MAX) throw new TimestampOutOfRangeError(reachedAt);

  return points * TIME_SPAN + (TIME_MAX - t);  // ✓
}

export function unpackScore(composite: number): { points: number; t: number } {
  const points = Math.floor(composite / TIME_SPAN);
  return { points, t: TIME_MAX - (composite - points * TIME_SPAN) };
}
```

Worked example — two users on 100 points, one 5 s after the epoch, one 10 s:

```
earlier: 100 × 1_073_741_824 + (1_073_741_823 −  5) = 108_447_924_218
later:   100 × 1_073_741_824 + (1_073_741_823 − 10) = 108_447_924_213
```

The earlier user's composite is larger, so they rank higher. Both are far below
`2^53` (≈ 9.007 × 10^15), so the comparison is exact rather than approximate.

The property test worth writing: for random `(points, time)` pairs, sorting by
composite must equal sorting by `(points DESC, time ASC)`. That single test
catches every encoding mistake at once.

---

## 4. Tickets

The phases are [§13](../README.md#13-delivery-plan); this is a ticket-level
breakdown. Each ticket is meant to be one PR.

### Phase 1 — write path

| # | Ticket | Done when |
|---|--------|-----------|
| 1.1 | Migrations for `score_events`, `user_scores`, `scoreboard_outbox` | Migration runs and reverts cleanly; constraints and indexes match [§6.1](../README.md#61-postgresql-the-system-of-record) |
| 1.2 | Domain interfaces + `ActionCatalogue` + in-memory fakes | Use cases compile and unit-test with no infrastructure |
| 1.3 | JWT authentication middleware | §3.3 above; the four forged-token tests pass |
| 1.4 | zod schemas for every endpoint | `userId` or `points` in a body is a `400` |
| 1.5 | `PostgresScoreLedger.record` — the §6.2 transaction | 100 concurrent increments give exactly 100 × points |
| 1.6 | Idempotency (Redis fast path + unique index) | 50 concurrent identical keys award once |
| 1.7 | `POST /score-increments` end to end | Returns `202` with the shape in `openapi.yaml` |
| 1.8 | `GET /scoreboard/top` reading PostgreSQL directly | Correct board; no Redis yet |

### Phase 2 — read model

| # | Ticket | Done when |
|---|--------|-----------|
| 2.1 | `packScore` / `unpackScore` | Property test in §3.7 passes |
| 2.2 | `RedisScoreboardReadModel` | `getTop`, `getRank`, `getNeighbours` correct |
| 2.3 | `project.lua` + `apply()` | Shuffled and duplicated sequences converge |
| 2.4 | Projector loop + leader lock | Two projectors at once produce no double application |
| 2.5 | Rebuild command | Rebuilt board is byte-identical to the PostgreSQL ordering |
| 2.6 | `GET /scoreboard/me` | Rank and neighbours correct |
| 2.7 | Point `GET /top` at Redis, with PostgreSQL fallback | Board still served with Redis stopped |

### Phase 3 — live

| # | Ticket | Done when |
|---|--------|-----------|
| 3.1 | `StreamRegistry` + `GET /scoreboard/stream` | Snapshot on connect; correct headers |
| 3.2 | Pub/Sub fan-out on a dedicated connection | A change on instance A reaches a viewer on instance B |
| 3.3 | Change detection + 1 Hz throttle | Suppression ratio is high under realistic traffic |
| 3.4 | Backpressure + heartbeat + connection caps | A deliberately slow client never grows server memory |
| 3.5 | Graceful shutdown with jittered reconnect | 1,000 streams close cleanly on `SIGTERM` |

### Phase 4 — hardening

| # | Ticket | Done when |
|---|--------|-----------|
| 4.1 | Action-token sign/verify + `POST /actions/start` | Forged, expired and foreign tokens all rejected |
| 4.2 | Single-use consumption + minimum duration | Replay is `409`; too-fast is `422` |
| 4.3 | Token-bucket rate limit, keyed per user | Limit holds across replicas |
| 4.4 | Velocity budget, failing closed | Exhausted budget is `429` with no ledger row |
| 4.5 | Anomaly signals + review queue | Flags recorded; nothing auto-banned |
| 4.6 | Reconciliation job | Injected drift is detected and alerted |

### Phase 5 — scale

| # | Ticket | Done when |
|---|--------|-----------|
| 5.1 | Load test: 10^3 increments/s for 10 min | [§10.1](../README.md#101-latency-targets) latencies met |
| 5.2 | Load test: 10,000 SSE connections | Memory and egress measured against §10.3 |
| 5.3 | Ledger partitioning | Monthly partitions, with a retention job |
| 5.4 | Dashboards and alerts | Every metric in [§11](../README.md#11-observability), lag and score-cap alerts verified by firing them |

---

## 5. Tests that matter

Most of the suite is ordinary. These four are the ones that catch the bugs this
module actually has.

**Concurrency.** Not "call it twice" — fire N in parallel and assert an exact
total:

```ts
const results = await Promise.all(
  Array.from({ length: 100 }, () => postIncrement(freshToken(), uuid())),
);
expect(await totalFor(userId)).toBe(100n * 50n);
```

Problem 5 learned the hard way that a passing concurrency test can be lying: its
first version passed because the requests happened to arrive far enough apart.
If a test like this passes on the first try, make it fail on purpose — remove
the fix and confirm the test goes red.

**Idempotency and replay.** Same `Idempotency-Key` 50 times concurrently: one
award, 50 identical response bodies. Same action token from 20 connections: one
`202`, nineteen `409`.

**Projector convergence.** Drive `project.lua` directly with shuffled,
duplicated and out-of-order sequences and assert the final ZSET state matches
the PostgreSQL ordering. No HTTP involved.

**Ordering agreement.** Generate 10,000 random users, project them all, and
assert Redis's top 100 equals PostgreSQL's `ORDER BY total_score DESC,
reached_at ASC LIMIT 100`. This is the test that proves the packed encoding is
right.

Follow Problem 5's split: `test:unit` needs nothing external and is the loop you
run while editing; integration tests run against real PostgreSQL and Redis, in a
single worker, against a database dropped and recreated from the migrations each
run — so every run also proves the migrations produce the schema the code
expects.

---

## 6. Before you open a PR

- [ ] No `userId` or `points` read from a request body, query or header.
- [ ] No read-modify-write on a total anywhere.
- [ ] Every Redis read-then-write that makes a decision is one Lua script.
- [ ] JWT verification passes an explicit `algorithms` whitelist.
- [ ] Every new failure has an `AppError` subclass with a stable `code`, and
      appears in [§5.6](../README.md#56-errors) and `openapi.yaml`.
- [ ] No secret, token or raw IP can reach a log line.
- [ ] New concurrent paths have a test that fires N in parallel, not two.
- [ ] Anything that can fail has a defined behaviour in
      [§9](../README.md#9-failure-modes-and-degradation) — if it does not, add
      the row rather than leaving it undefined.
- [ ] Coverage still meets the gate. Problems 4 and 5 hold 100% statements,
      branches, functions and lines; every branch here is a reachable decision
      about score, so an uncovered one is an untested edge case.

If you are unsure whether something is a decision or an accident, it is in
[`DECISIONS.md`](DECISIONS.md) — and if it is not, that is worth raising rather
than guessing.
