# Architecture decision records — Scoreboard module

Every significant decision in the [specification](../README.md), with the
options that were considered and the reason each was rejected. A specification
that only states conclusions cannot be argued with; the reviewer cannot tell a
considered choice from a default, and the team that inherits it cannot tell
which decisions are safe to revisit.

Each record states the decision, the alternatives, and — where one exists — the
condition that should cause it to be reopened.

| # | Decision | Status |
|---|----------|--------|
| [001](#adr-001-postgresql-as-the-system-of-record-redis-as-a-disposable-read-model) | PostgreSQL as the system of record, Redis as a disposable read model | Accepted |
| [002](#adr-002-sse-rather-than-websocket-or-polling) | SSE rather than WebSocket or polling | Accepted |
| [003](#adr-003-a-materialised-total-alongside-an-append-only-ledger) | A materialised total alongside an append-only ledger | Accepted |
| [004](#adr-004-transactional-outbox-rather-than-a-dual-write) | Transactional outbox rather than a dual write | Accepted |
| [005](#adr-005-packed-composite-zset-score-for-deterministic-ties) | Packed composite ZSET score for deterministic ties | Accepted, with a documented cap |
| [006](#adr-006-broadcast-full-snapshots-not-deltas) | Broadcast full snapshots, not deltas | Accepted |
| [007](#adr-007-atomic-in-place-increment-rather-than-optimistic-locking) | Atomic in-place increment rather than optimistic locking | Accepted |
| [008](#adr-008-idempotency-key-is-required-not-optional) | `Idempotency-Key` is required, not optional | Accepted |
| [009](#adr-009-202-accepted-rather-than-200-ok) | `202 Accepted` rather than `200 OK` | Accepted |
| [010](#adr-010-stream-authentication-if-the-board-becomes-private) | Stream authentication if the board becomes private | Conditional |
| [011](#adr-011-rate-limiter-fails-open-velocity-budget-fails-closed) | Rate limiter fails open; velocity budget fails closed | Accepted |
| [012](#adr-012-action-tokens-despite-not-solving-the-problem) | Action tokens, despite not solving the problem | Accepted, with stated residual risk |

---

## ADR-001: PostgreSQL as the system of record, Redis as a disposable read model

**Decision.** All score state is durably written to PostgreSQL. Redis holds a
read model that may be destroyed at any moment and rebuilt from PostgreSQL.

**Alternatives.**

*Redis as the system of record.* Attractive because the ranking data structure
is already there and the write path collapses to one `ZINCRBY`. Rejected: Redis
persistence is asynchronous by default, so a crash loses the last window of
writes, and a leaderboard that silently loses points is a support problem with
no evidence trail. It also has no transactions across the ledger and the total,
no foreign keys, no `CHECK` constraints, and no way to answer "why does this
user have 9,820 points?".

*PostgreSQL only, no Redis.* Simplest possible design and correct at small
scale. Rejected on the read path: `ORDER BY total_score DESC LIMIT 10` on every
page load, at 10^5 viewers per minute, is the whole database doing sorting work
to produce ten rows that are identical for every caller.

**Consequence.** Every Redis failure is a performance incident rather than a
data-loss incident (§9, F2), and the module can keep accepting writes with the
cache down. This single property pays for the extra moving part.

**Revisit if:** the ledger stops being needed for audit, *and* the scale drops
by two orders of magnitude. Then PostgreSQL-only is the better design.

---

## ADR-002: SSE rather than WebSocket or polling

**Decision.** Server-Sent Events over HTTP/2.

**Alternatives.**

| Option | Verdict |
|--------|---------|
| **SSE** | **Chosen.** Unidirectional, which matches the data flow exactly. Plain HTTP, so it inherits TLS termination, load balancing, auth middleware, logging and rate limiting rather than needing a parallel stack for each. Automatic reconnection with `Last-Event-ID` is built into every browser. |
| WebSocket | Rejected *for this requirement*. Full duplex is capability the module does not use: the only client-to-server message is a score increment, which wants an HTTP status code, an `Idempotency-Key` header and a retry — all natural over HTTP, all hand-built over a socket. The cost is a second protocol stack to secure, observe and load-balance. |
| Long polling | Rejected. Works everywhere, and costs a full request cycle per update per client, with a reconnect storm after every broadcast. |
| Short polling | Rejected as the *primary* transport; retained as the documented fallback and the CDN path (§5.3). At one-second intervals it is indistinguishable from live, and behind a CDN it is nearly free — see the note below. |

**The honest counterargument.** Because the board is public and byte-identical
for every viewer, a CDN-cached `GET /top` with a one-second TTL would serve an
unlimited audience at near-zero origin cost, and no user could tell the
difference. SSE is chosen because it delivers change-driven updates rather than
fixed-interval ones, the projected audience (10^4–10^5) fits comfortably, and
the fallback path exists anyway. If viewers grow by two orders of magnitude, the
CDN path is the answer — not more instances holding sockets. This is recorded
because it is the decision most likely to look wrong later, and the team should
know it was made with the alternative in view.

**Revisit if:** the client needs to send messages on the same connection, or
concurrent viewers exceed ~10^6.

---

## ADR-003: A materialised total alongside an append-only ledger

**Decision.** Keep both `score_events` (immutable, one row per award) and
`user_scores` (one row per user, incremented in place).

**Alternatives.**

*Ledger only, sum on read.* Pure and always correct. Rejected: summing a user's
full history on every read is O(events) and unbounded — a heavy user's read gets
slower forever.

*Total only, no ledger.* One table, minimal writes. Rejected, and this is the
more important rejection: without the ledger there is no way to explain a score,
no way to detect abuse after the fact, and **no way to reverse fraud**. A
confirmed cheater's score could only be guessed at and manually overwritten.
The ledger is what makes §8.5's "flag, don't auto-ban" policy operationally
possible — a human reviewer can reverse exactly the events that were fraudulent
and recompute the rest.

**Consequence.** Two things that can disagree, so §9.4's hourly reconciliation
is mandatory rather than nice to have.

---

## ADR-004: Transactional outbox rather than a dual write

**Decision.** The write transaction inserts a row into `scoreboard_outbox`. A
projector reads the outbox and updates Redis.

**Alternatives.**

*Write to PostgreSQL, then write to Redis in the same request handler.* The
obvious approach, and wrong. There is no transaction spanning the two: if the
PostgreSQL commit succeeds and the Redis call fails — a timeout, a failover, a
process kill in between — the board is permanently wrong for that user with
nothing left in the system that knows it. The failure is silent, and it is
exactly the kind that is invisible in testing because it needs an unlucky moment
to reproduce.

*Change data capture from the WAL (Debezium or similar).* Genuinely good, and
removes the outbox table. Rejected on operational cost: a Kafka or Debezium
deployment to keep a leaderboard current is a large amount of infrastructure to
own for one projection. Worth revisiting if the platform already runs CDC for
other reasons.

*`LISTEN`/`NOTIFY`.* Attractively simple. Rejected: notifications are dropped if
no listener is connected, so a projector restart loses every change during the
gap, with no backlog to recover from.

**Consequence.** The board is eventually consistent with the ledger, bounded by
projector lag — which is why `scoreboard_projector_lag_seconds` (§11) is the
module's most important metric, and why `POST /score-increments` returns `202`
(ADR-009).

---

## ADR-005: Packed composite ZSET score for deterministic ties

**Decision.** `composite = points × 2^30 + (2^30 − 1 − t)`, with `t` in whole
seconds since a service epoch. Ties resolve to the user who reached the score
first.

**Alternatives.**

*Plain integer score.* Simple, no cap, no arithmetic to get wrong. Rejected:
Redis breaks ties lexicographically by member, which here is a UUID. Two users
on the same score would be ranked by their identifiers — stable, but arbitrary,
and indefensible to the user who has just been pushed out of the top 10 by the
alphabet.

*Rank in PostgreSQL, cache the result.* Correct ordering with no bit budget, and
this is exactly what the module already does for the *authoritative* ordering.
Rejected as the primary read path because `ZREVRANK` for an arbitrary user
(`GET /scoreboard/me`) would then need a database query per call.

*Two structures — ZSET for score, secondary sort for ties.* Rejected: the
tie-break would happen in application code after fetching a candidate set of
unknown size, which is unbounded work on a read path specified as O(1).

**The accepted cost.** A hard maximum of 8,388,607 points per user and
one-second tie resolution. Both are documented in §6.4 with a mandatory alert at
80% of the cap, because exceeding it corrupts ordering *silently* — the failure
mode with no symptom until someone complains about their rank. The remedy is a
re-split of the 53 bits and a rebuild, which is a tested operation rather than a
migration.

**Revisit if:** the expected maximum score approaches 10^6, or the product needs
sub-second tie resolution.

---

## ADR-006: Broadcast full snapshots, not deltas

**Decision.** Every pub/sub message and every SSE event carries the complete
top 10.

**Alternatives.**

*Delta messages* ("user X moved to rank 3"). Smaller on the wire. Rejected, and
the reason is the entire argument for this ADR: Redis Pub/Sub is **at-most-once**.
A message lost to a failover or a slow subscriber leaves every client that
missed it permanently wrong, with no way for either side to detect the
divergence. Recovering from that requires sequence numbers, gap detection, a
replay buffer and a resync protocol — a meaningful amount of machinery, all of
it to avoid sending ten rows.

**Consequence.** Four hard problems stop existing: message loss self-heals on
the next broadcast; reconnection needs no gap recovery, just the current
snapshot; instances are interchangeable and connections need no stickiness; and
backpressure handling (§7.4) can simply *drop* pending messages for a slow
client, because only the newest one matters.

The payload is ~1 KB. The correct engineering trade is obvious once the failure
mode is written down, which is why it is written down.

---

## ADR-007: Atomic in-place increment rather than optimistic locking

**Decision.** `UPDATE user_scores SET total_score = total_score + $n`. No
`If-Match`, no version predicate, no 409 on concurrent writes.

**Alternatives.**

*Read-modify-write in application code.* Rejected — it loses increments under
concurrency, silently. This is the same class of defect as Problem 5's `EC-01`,
where a passing test had already declared the code safe.

*Optimistic locking with a version predicate*, as Problem 5's `PATCH` uses.
Rejected here, and the distinction matters: `If-Match` exists to stop two
clients overwriting each other's *absolute* values, where interleaving genuinely
loses a decision. Score increments are **relative and commutative** — applying
+50 and +30 in either order gives the same result, and neither client's
intention is lost. Adding optimistic locking would generate 409s for operations
that are perfectly safe to interleave, and would push clients into retry loops
that make contention worse.

**Consequence.** `version` is retained on the row purely as a monotonic marker
for the read model, not as a concurrency control. Contention on a single hot row
is a row-lock queue rather than a retry storm.

---

## ADR-008: `Idempotency-Key` is required, not optional

**Decision.** The header is mandatory on `POST /score-increments`; a missing key
is `400 IDEMPOTENCY_KEY_MISSING`. Uniqueness is enforced by a PostgreSQL unique
index, not only by a Redis lookup.

**Alternatives.**

*Optional, honoured when present.* Rejected. The clients that most need
idempotency are the ones on unreliable mobile connections, and those are exactly
the clients that will not implement an optional header. Making it required
turns "double-awarded points on a flaky network" from a support ticket into a
condition that cannot occur.

*Redis-only deduplication.* Rejected as the sole mechanism: a cache lookup
narrows the race window but does not close it — two concurrent retries can both
miss the cache. The unique index is the authority, exactly as Problem 5 lets the
SKU unique constraint decide rather than a prior `SELECT`. Redis stays as the
fast path that returns the stored response body without a database round trip.

**Consequence.** The idempotency record must store the response, not just the
key, so a replay returns the same `totalScore` the original did. A replay that
recomputed the total would return a *different* number for the same logical
operation, which is a subtler bug than the one being fixed.

---

## ADR-009: `202 Accepted` rather than `200 OK`

**Decision.** The increment endpoint returns `202`.

**Reasoning.** At the moment of the response the score is durably committed, but
the board has not necessarily been updated — projection is asynchronous by
ADR-004. `200 OK` would assert a system-wide consistency the design does not
provide, and clients would reasonably build on that assertion: refetch the board
on `200`, see stale data, and file a bug against the wrong component.

The response still carries the caller's authoritative `totalScore`, read from
the write transaction, so the user's own UI updates immediately and correctly.
`rank` and `boardVersion` are documented as best-effort.

**The counterargument**, recorded because it is reasonable: `202` conventionally
signals "accepted for processing, outcome unknown", and here the score change is
*already durable* — only its publication is pending. A client that treats `202`
as "might not have worked" would be wrong. The response body resolves this,
and the OpenAPI description states it explicitly. `200` was rejected because
overstating consistency causes worse bugs than understating it.

---

## ADR-010: Stream authentication if the board becomes private

**Status: conditional.** Under assumption A1 the board is public and the stream
needs no authentication. This ADR pre-decides the design if A1 is overturned, so
the answer is not improvised under time pressure.

**Decision, if needed.** A single-use **stream ticket**: 60-second TTL, bound to
the user, consumed on connect, passed as a query parameter.

**Alternatives.**

*Bearer token in the query string.* The path teams take by default, because
`EventSource` cannot set headers. Rejected: URLs are logged by load balancers,
reverse proxies, CDNs and application logs, retained in browser history, and
leaked in `Referer` headers. A long-lived access token in any of those places is
a full account compromise waiting for a log review.

*Cookie-based session on the stream.* Works, and `EventSource` sends cookies
with `withCredentials`. Rejected as the default because it re-introduces CSRF
exposure to an API that is otherwise header-authenticated, and mixing the two
schemes in one service is how a CSRF gap gets shipped.

*`fetch`-based SSE client* (streaming `fetch` with a manual event parser). Can
set an `Authorization` header, and is a genuinely good option. Not chosen as the
default only because it discards the browser's built-in reconnection and
`Last-Event-ID` handling, which then has to be reimplemented correctly. Listed
as the equal alternative if the team prefers it.

**Why the ticket wins.** A leaked ticket is worth one connection for sixty
seconds, to data that is a snapshot of a leaderboard. That is an acceptable
blast radius; a leaked access token is not.

---

## ADR-011: Rate limiter fails open; velocity budget fails closed

**Decision.** If Redis is unavailable, the per-user *request* rate limiter
allows the request through and logs. The per-user *score velocity* budget
rejects with `503 WRITE_UNAVAILABLE`.

**Reasoning.** Problem 5 already argues the fail-open case: converting a cache
outage into a total API outage is a strictly worse incident than temporarily
unenforced rate limits, and availability of the core function outranks a
protective control that is itself degraded.

That argument does not transfer to the velocity budget, and noticing the
difference is the point of this record. The rate limiter protects the *service*
from load, and the service is still standing without it. The velocity budget
protects the *scoreboard's integrity*, which is the thing the module exists to
provide. An attacker who can cause or wait out a Redis outage would otherwise
get an unlimited scoring window, and — because the ledger is durable — the
fraudulent points would survive the outage and need manual reversal afterwards.

**Consequence.** Redis is on the critical path for writes. That is a real
availability cost, accepted deliberately: a brief write outage is recoverable,
and a corrupted leaderboard is a trust problem that outlives the incident.

**Revisit if:** Redis availability proves worse than the write SLO, in which
case the velocity budget should move to a PostgreSQL-backed counter in the same
transaction rather than being relaxed.

---

## ADR-012: Action tokens, despite not solving the problem

**Decision.** Implement single-use, short-TTL, HMAC-signed action tokens with a
minimum plausible duration, while stating plainly that they do not make
requirement 5 fully satisfiable.

**The tension.** As argued in [§1](../README.md#1-the-finding-that-shapes-this-design),
a legitimate user can replay their own authenticated request. Action tokens do
not change that: the user can obtain a token, wait `minDurationMs`, and submit —
in a script, forever.

**Why implement them anyway.** They convert a single replayable request into a
two-step flow with server-issued state, which:

- defeats naive replay of a captured request (the `jti` is consumed);
- defeats trivially parallel automation (each award needs its own token);
- makes the minimum-duration floor enforceable, which rules out the fastest
  automation;
- produces a **strong, low-false-positive signal** for §8.5 — an account with
  perfectly regular start-to-complete intervals at exactly `minDurationMs` is
  automated, and there is no innocent explanation.

That last point is the real value, and it is easy to miss: the token's job is
less to block the attack than to make the attack *legible*.

**Rejected alternatives.**

*Client-side signing with a secret embedded in the JavaScript bundle.* Rejected
outright: nothing on the client can hold a secret from the person operating it.
This appears in real systems and is security theatre.

*CAPTCHA on the increment path.* Rejected: continuous friction for every honest
user to inconvenience an attacker once. Reserved as a targeted response for
accounts already flagged by §8.5, where the cost falls on the right party.

*Proof-of-work.* Rejected: burns the honest user's battery, and an attacker with
a server has more compute than a phone does.

**Residual risk, stated:** a determined user who drives the real action flow
programmatically will still score. Closing that requires
[§14.1](../README.md#141-make-the-server-own-the-action-outcome) — the server
owning the action's outcome — which is outside this module's scope and is
specified as the recommended follow-up.
