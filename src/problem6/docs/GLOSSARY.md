# Glossary — terms used in this specification

The [specification](../README.md) names patterns and mechanisms without stopping
to define them, because stopping to define them every time would make it
unreadable for the people reviewing the design. This document is the other half
of that trade: every assumed term, defined once, in plain language.

**Read this first if any of these are unfamiliar.** None of them are advanced —
they are ordinary working vocabulary — but a term you have not met before is an
invisible wall, and the specification is not much use on the far side of one.

Each entry says what the thing *is*, why it appears *here*, and where to read
more in the spec.

**Contents:** [Data & consistency](#1-data-and-consistency) ·
[Live delivery](#2-live-delivery) · [Security](#3-security) ·
[PostgreSQL](#4-postgresql-mechanics) · [Redis](#5-redis-mechanics) ·
[Numbers & notation](#6-numbers-and-notation)

---

## 1. Data and consistency

**System of record**
The one store that decides what is true. If two stores disagree, this is the one
that wins, and the other is rebuilt from it. Here it is PostgreSQL; Redis is
explicitly *not* a system of record, which is why the service can keep accepting
writes while Redis is down.
→ [§3.2](../README.md#32-the-two-rules-that-hold-the-design-together)

**Read model**
A second copy of the data, shaped for how it is *read* rather than how it is
written. The ledger is shaped for writing (one row per award, append-only);
answering "who are the top 10?" from it would mean summing and sorting millions
of rows. The read model is a Redis sorted set that already holds the answer.
The general pattern is called **CQRS** — separating the write shape from the
read shape.
→ [§6.3](../README.md#63-redis-the-read-model)

**Projection / projector**
A **projection** is the read model built from the write model. The **projector**
is the background process that keeps it current: it reads new changes from the
outbox and applies them to Redis. It is not a request handler and no user waits
for it — it runs in a loop, forever.
→ [§6.5](../README.md#65-the-projector-and-why-it-is-idempotent)

**Materialised / derived data**
A value that could be recomputed from something else, stored anyway because
recomputing it every time is too slow. `user_scores.total_score` is derived from
`score_events` — you could always `SUM(points)` instead. Derived data can drift
from its source, which is why §9.4 specifies a job that checks it hourly.
→ [§6.1](../README.md#61-postgresql-the-system-of-record)

**Dual write**
Writing the same change to two stores in one request handler, hoping both
succeed. They will not always: the first commits, the second times out, and now
they disagree with nothing in the system that knows it. **This is a bug, not a
technique** — the name exists so you can recognise and avoid it.
→ [ADR-004](DECISIONS.md#adr-004-transactional-outbox-rather-than-a-dual-write)

**Transactional outbox**
The fix for a dual write. Instead of writing to Redis, the handler writes a row
to an `outbox` table *inside the same database transaction* as the score change.
Either both land or neither does. A separate process then reads the outbox and
updates Redis, retrying until it works. The trick is that "record the intent to
update Redis" is a database write, so it can be transactional.
→ [§4.1 step 4](../README.md#41-the-main-flow-action-completion-to-live-board)

**Idempotent / idempotency**
An operation is idempotent if doing it twice has the same effect as doing it
once. Awarding points is *not* naturally idempotent — calling it twice awards
twice. `Idempotency-Key` makes it so: the client sends a unique id with the
request, and the server awards once no matter how many times the request
arrives. This matters because a client that times out cannot tell whether the
request succeeded, so it must be safe to retry.
→ [§5.2](../README.md#52-post-score-increments),
[ADR-008](DECISIONS.md#adr-008-idempotency-key-is-required-not-optional)

**Eventual consistency**
The board is not updated in the same instant as the score. For a moment — under
a second here — the score is committed but the board still shows the old
ranking. It *will* catch up. Saying so explicitly is why the endpoint returns
`202 Accepted` rather than `200 OK`.
→ [ADR-009](DECISIONS.md#adr-009-202-accepted-rather-than-200-ok)

**Lost update**
Two requests read the same value, both add to it, and both write back — so one
of the two additions vanishes. Nothing errors; the number is just wrong. This is
the single most important bug class in this module, and §6.2 is written the way
it is specifically to make it impossible.
→ [§6.2](../README.md#62-the-write-transaction)

**Optimistic locking**
A way to stop lost updates when a client writes an *absolute* value: the client
sends the version it read (`If-Match`), and the write applies only if nobody
changed the row since. Problem 5 uses this. **This module deliberately does
not** — see the next entry.
→ [ADR-007](DECISIONS.md#adr-007-atomic-in-place-increment-rather-than-optimistic-locking)

**Commutative**
Order does not change the result. `+50` then `+30` equals `+30` then `+50`.
Because score increments are commutative, two concurrent increments can safely
interleave and neither is lost — so the right tool is one atomic `UPDATE ... SET
total = total + n`, and optimistic locking would only produce conflicts for
operations that were never in conflict.

**Append-only ledger**
A table that is only ever inserted into — never updated, never deleted. It gives
you a complete history: why a score is what it is, who awarded it, when. It also
makes fraud **reversible**, because you can delete the fraudulent events and
recompute the total from the rest. That capability is the main reason it exists.
→ [ADR-003](DECISIONS.md#adr-003-a-materialised-total-alongside-an-append-only-ledger)

**Reconciliation**
A scheduled job that compares derived data against its source and reports
differences. Not a repair mechanism — a *detection* mechanism. Silent drift
between the ledger and the totals is only ever found by something that goes
looking for it.
→ [§9.4](../README.md#94-rebuild-and-reconciliation)

---

## 2. Live delivery

**SSE — Server-Sent Events**
A plain HTTP response that never ends. The server keeps the connection open and
writes text messages down it as they happen; the browser's built-in
`EventSource` parses them and fires an event per message. One direction only,
server to client. Reconnection is automatic.
→ [§7.1](../README.md#71-transport-sse)

**WebSocket**
A different protocol that upgrades an HTTP connection into a two-way channel.
More capable than SSE, and unnecessary here because the client never sends
anything on the stream.
→ [ADR-002](DECISIONS.md#adr-002-sse-rather-than-websocket-or-polling)

**Pub/Sub (publish/subscribe)**
One process publishes a message to a named channel; every process subscribed to
that channel receives a copy. Used here because an SSE connection lives on one
API instance while the score change happens on another — pub/sub is the bridge.
→ [§7.2](../README.md#72-fan-out-across-instances)

**At-most-once delivery**
A delivery guarantee: a message arrives once, or not at all. Redis Pub/Sub is
at-most-once — during a failover or to a slow subscriber, messages are simply
dropped, with no error and no retry. (The stronger guarantees are *at-least-once*,
where a message may arrive twice, and *exactly-once*, which is much harder than
it sounds.) The whole snapshot-versus-delta decision follows from this one fact.
→ [ADR-006](DECISIONS.md#adr-006-broadcast-full-snapshots-not-deltas)

**Snapshot vs delta**
A **delta** says what changed ("user X moved to rank 3"); a **snapshot** carries
the entire current state. Deltas are smaller but only work if you receive every
single one, in order. Since delivery here is at-most-once, this module sends
snapshots: a lost message is simply corrected by the next one.

**Fan-out**
Turning one event into many deliveries — one score change becomes a write to
every connected viewer. The cost multiplies by the number of connections, which
is why §10.3 works out the bandwidth before committing to a design.
→ [§10.3](../README.md#103-fan-out-arithmetic-the-constraint-that-actually-binds)

**Backpressure**
What happens when the server produces data faster than a client can receive it.
In Node, `res.write()` returns `false` when the outbound buffer is full. If you
ignore that and keep writing, the data queues in memory until the process runs
out. Handling backpressure means noticing and stopping until the `drain` event.
→ [§7.4](../README.md#74-connection-handling)

**Heartbeat / keepalive**
A tiny message sent periodically on an idle connection so intermediaries can see
it is still alive. Without it, load balancers and mobile carrier NAT silently
close connections that have been quiet for ~60 seconds.

**Thundering herd**
Many clients doing the same thing at the same instant. Here: a deploy drops
20,000 SSE connections, every browser reconnects after exactly 3 seconds, and
the new instance is hit by 20,000 simultaneous connections. The fix is
**jitter** — randomising each client's delay so they spread out.
→ [§5.4](../README.md#54-get-scoreboardstream)

**Coalescing / throttling**
Combining many updates into one. If the board changes 50 times in a second,
viewers do not need 50 messages — they need the newest state, once. Everything
in between was only ever going to be on screen for milliseconds.
→ [§7.3](../README.md#73-broadcast-throttling-the-part-that-decides-whether-this-scales)

---

## 3. Security

**Authentication vs authorisation**
**Authentication** is *who are you* (a valid token proves the caller is user X).
**Authorisation** is *are you allowed to do this*. The specification's central
finding is that this module can authenticate perfectly and still be abused,
because authentication cannot answer a third question — *did the action actually
happen?*
→ [§1](../README.md#1-the-finding-that-shapes-this-design)

**JWT — JSON Web Token**
A signed token carrying claims about the user: `sub` (the subject, i.e. the user
id), `iss` (who issued it), `aud` (who it is for), `exp` (when it expires). The
signature proves it was issued by the identity service and not modified. **The
`sub` claim is the only place this module may take a user id from.**
→ [§8.1](../README.md#81-identity-comes-from-the-token-never-from-the-request)

**JWKS / `kid`**
**JWKS** (JSON Web Key Set) is a URL where the identity service publishes the
public keys used to verify its tokens. **`kid`** (key id) is a field in the
token header saying which of those keys signed it — so keys can be rotated
without invalidating every token at once.

**`alg` confusion / `alg: none`**
A family of attacks where the attacker changes the token's declared algorithm.
`alg: none` claims the token needs no signature. RS256→HS256 confusion tricks a
naive verifier into using the *public* key as an HMAC secret — and the public
key is public, so anyone can forge tokens. Both are defeated the same way: the
server decides which algorithms are acceptable, and never reads that decision
from the token.

**HMAC**
A keyed signature over some data. Anyone holding the secret key can produce it
and verify it; anyone without the key can do neither. Used here to sign action
tokens so a client cannot modify its own token's contents.
→ [§8.3](../README.md#83-action-tokens-binding-the-award-to-a-real-flow)

**CSPRNG**
Cryptographically secure pseudo-random number generator — `crypto.randomBytes`,
not `Math.random()`. `Math.random()` is predictable, so a `jti` or a key
generated from it can be guessed.

**Constant-time comparison**
Comparing two secrets in a way that always takes the same amount of time.
Ordinary `===` on strings returns as soon as it finds a difference, so an
attacker can measure response times to learn a signature one byte at a time. Use
`crypto.timingSafeEqual`.

**Replay attack**
Capturing a valid request and sending it again. The request is genuine, the
signature checks out, and it still must not work twice. Defeated here by
consuming the action token's `jti` exactly once.

**Mass assignment**
Letting fields from the request body write directly to your data model, so an
attacker adds a field you never intended to expose. The defence is to *reject*
unknown fields rather than ignore them — which is why `{"points": 999999}` is a
`400` here and not a silently dropped field.
→ [§5.2](../README.md#52-post-score-increments)

**Fail open / fail closed**
What a protective control does when it cannot function. **Fail open** = allow
the request (availability first). **Fail closed** = reject it (safety first).
This module deliberately does both, in different places, and
[ADR-011](DECISIONS.md#adr-011-rate-limiter-fails-open-velocity-budget-fails-closed)
explains why that is not an inconsistency.

**Token bucket vs fixed window**
Two rate-limiting algorithms. A **fixed window** counts requests per clock
interval — simple, but allows a double burst across a boundary. A **token
bucket** refills at a steady rate and permits a controlled burst; smoother, and
what §8.4 specifies for writes.

**Trust boundary**
The line where data stops being controlled by you and starts being controlled by
someone else. Everything crossing it must be validated. The browser is on the
far side of the most important one.
→ [THREAT_MODEL §2](THREAT_MODEL.md#2-trust-boundaries)

**STRIDE**
A checklist for finding threats systematically: **S**poofing, **T**ampering,
**R**epudiation, **I**nformation disclosure, **D**enial of service, **E**levation
of privilege. You walk each component against each letter so gaps are found by
method rather than by imagination.
→ [THREAT_MODEL §4](THREAT_MODEL.md#4-stride-by-component)

**Sybil attack**
One person creating many accounts to multiply their effect. Out of scope here
because account creation belongs to the identity service — but worth recognising
by name.

**RFC 9457 / `application/problem+json`**
A standard shape for HTTP error responses: `type`, `title`, `status`, `detail`,
plus your own fields. This module adds a stable `code` that clients branch on,
so error handling never depends on the wording of a message.
→ [§5.6](../README.md#56-errors)

---

## 4. PostgreSQL mechanics

**Transaction (`BEGIN` / `COMMIT`)**
A group of statements that all take effect together or not at all. If anything
fails before `COMMIT`, everything rolls back. §6.2's four statements are one
transaction precisely so a partial award cannot exist.

**`ON CONFLICT DO UPDATE` (upsert)**
Insert a row; if one with that key already exists, update it instead. One
statement, no race. The alternative — check whether the row exists, then insert
or update — is a race, because another request can insert between your check and
your write.

**Unique constraint as a decision-maker**
Rather than asking "does this key already exist?" and then inserting, just
insert and let the database reject the duplicate (error `23505`). The check-then-
act version has a window where two requests both pass the check. This module
relies on that for both idempotency keys and action token ids.

**`CHECK` constraint**
A rule the database enforces on every row, e.g. `points > 0`. Application
validation protects against bad *requests*; a `CHECK` protects against every
other way data can arrive — a migration, a repair script, someone in `psql` at
3am.

**`FOR UPDATE SKIP LOCKED`**
Reads rows and locks them, *skipping* any another transaction has already
locked. It turns a table into a work queue: several projector workers can each
claim a different batch of outbox rows without blocking each other and without
processing the same row twice.

**Partial index**
An index over only the rows matching a condition, e.g. `WHERE processed_at IS
NULL`. Smaller and faster than a full index, because the unprocessed outbox rows
are a tiny fraction of the table no matter how large it grows.

**Migration**
A versioned, reversible script that changes the schema. Written by hand and run
as a deployment step — never automatically on process start, or N replicas race
each other during a rolling deploy.

**`timestamptz(3)`**
A timestamp with time zone, stored to millisecond precision. The default is
microseconds, which a JavaScript `Date` cannot represent — and that mismatch
caused a real bug in Problem 5.

---

## 5. Redis mechanics

**ZSET (sorted set)**
A set where every member has a numeric score, kept permanently in score order.
Exactly the data structure a leaderboard needs. `ZADD` inserts or updates,
`ZREVRANGE 0 9` returns the top 10, `ZREVRANK` gives one member's position —
the last two in O(log N), no sorting at request time.
→ [§6.4](../README.md#64-ranking-and-the-tie-break)

**Lua script (`EVAL`)**
A small script Redis runs **atomically** — nothing else executes in the middle.
This matters whenever a decision depends on a value you just read: `GET` then
`SET` as two commands can interleave with another client, while the same logic
in Lua cannot. Both the rate limiter and the projector rely on this.
→ [§6.5](../README.md#65-the-projector-and-why-it-is-idempotent)

**`SET key value NX EX n`**
Set the key *only if it does not exist* (`NX`), expiring after `n` seconds
(`EX`). The standard way to claim something exactly once — a lock, or a
single-use token marker.

**`DEL` returns a count**
`DEL` returns how many keys it actually removed. So exactly one of many
concurrent callers gets `1` and the rest get `0` — which is how single-use
action tokens are consumed without a race.

**TTL / eviction**
Keys can expire (`TTL`), and Redis can evict keys when memory runs out
(`allkeys-lru`). Both mean **any key can vanish**, which is another reason Redis
cannot be a system of record here.

**`RENAME` for atomic swap**
Build a new ZSET under a temporary name, then `RENAME` it over the live key.
Readers see either the complete old board or the complete new one, never a
half-built one.
→ [§9.4](../README.md#94-rebuild-and-reconciliation)

**Subscriber mode**
A Redis connection that has subscribed to a channel cannot run ordinary
commands. So the process needs a **second, dedicated connection** for pub/sub —
sharing the main client breaks every other Redis call in the service.

---

## 6. Numbers and notation

**`O(1)`, `O(log N)`, `O(N log N)`**
How work grows with data size. `O(1)` — constant, unaffected by size. `O(log N)`
— grows very slowly (a million members is only about 20 steps). `O(N log N)` —
sorting everything, which is fine occasionally and fatal per request. Problem 4
covers this in more depth.

**`10^3`, `10^6`**
Scientific notation: `10^3` = 1,000; `10^6` = 1,000,000. Used for the scale
assumptions in A4.

**`2^53`**
The largest integer a JavaScript number (an IEEE-754 double) can hold exactly.
Above it, integers start being rounded — silently. The packed-score encoding in
§6.4 is designed to stay under this limit, and Problem 4 documents what happens
when code crosses it by accident.

**IEEE-754 double**
The floating-point format behind JavaScript's `number` and Redis's ZSET scores.
Integers up to `2^53` are exact; beyond that they are approximations.

**Bit packing**
Storing two numbers in one by giving each a fixed range of bits — here, 23 bits
of score and 30 bits of timestamp inside one 53-bit budget. Done with
multiplication and division, **not** `<<` and `|`: JavaScript's bitwise
operators truncate to 32 bits, which would silently destroy the value. Problem 4
documents the same trap.
→ [§6.4](../README.md#64-ranking-and-the-tie-break)

**p50 / p99**
Percentiles of a latency distribution. p50 is the median — half of requests are
faster. p99 means 99% are faster, so it describes the slow tail that averages
hide. Targets are set on p99 because that is the experience people complain
about.

**SLO**
Service Level Objective — a target you commit to and measure, e.g. "99% of
increments visible on the board within one second". An objective that is not
measurable is not an objective.
