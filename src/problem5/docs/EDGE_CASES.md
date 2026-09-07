# Problem 5 — Edge cases, worst cases, and why each was solved this way

The brief asks for five CRUD operations, a database, and a README. Delivering
that is a couple of hours' work. The remaining time went into the gap between
"the happy path returns 200" and "this is correct under concurrency, hostile
input and partial failure".

This document catalogues what was found. Each case has an ID that maps onto a
test, so the prose and the executable specification cannot drift apart.

Two findings below were **bugs in working-looking code that the tests caught**.
They are written up in full, including the incorrect assumption that produced
them, because the corrected version is more useful than a tidy one.

---

## 1. Summary

| ID | Edge case | Naive behaviour | This service | Severity |
|----|-----------|-----------------|--------------|----------|
| **EC-01** | **Concurrent conditional updates** | **9 of 10 writes silently lost** | one 200, nine 409 | **Critical** |
| **EC-02** | **Keyset cursor on a timestamp** | **boundary row returned twice** | `timestamptz(3)` | **High** |
| EC-03 | Concurrent create, same SKU | both succeed or 500 | unique index decides, 409 | High |
| EC-04 | `PATCH` with an absent field | column blanked to NULL | untouched | High |
| EC-05 | `bigint` from the driver | price becomes a string | transformer + assertion | High |
| EC-06 | `?isActive=false` | parsed as **true** | parsed as false | High |
| EC-07 | `?minPrice=` (empty) | becomes a `>= 0` filter | 400 | Medium |
| EC-08 | `?sort=` arbitrary column | SQL injection surface | whitelist, 400 | High |
| EC-09 | `?q=%` | matches every row | literal match | Medium |
| EC-10 | Non-UUID path parameter | 500 from SQLSTATE 22P02 | 400 | Medium |
| EC-11 | Unknown fields in the body | silently dropped | 400 (mass assignment) | High |
| EC-12 | `PATCH {}` | 200, nothing changed | 400 | Low |
| EC-13 | Malformed JSON / wrong type / huge body | 500 | 400 / 415 / 413 | Medium |
| EC-14 | Deep pagination | `OFFSET` scans and discards | keyset seek | Medium |
| EC-15 | Ties on a non-unique sort column | rows repeated or skipped | id tie-break | High |
| EC-16 | Insert during pagination | page shifts, row missed | unaffected | Medium |
| EC-17 | Tampered or foreign cursor | 500 | 400 | Medium |
| EC-18 | Delete between read and write | 409, misleading | 404 | Low |
| EC-19 | `X-Request-Id` from the client | log forging, header injection | validated or replaced | Medium |
| EC-20 | Redis unavailable | total outage, or no limit at all | fails open, logged | Medium |
| EC-21 | `INCR` then `EXPIRE` | key with no TTL, permanent lockout | one Lua script | Medium |
| EC-22 | Database error text | table names, SQL, paths leaked | logged, never returned | High |
| EC-23 | Liveness probe checking the database | restart storm on a DB blip | liveness checks nothing | High |
| EC-24 | `SIGTERM` during deploy | in-flight requests killed | graceful drain | Medium |
| EC-25 | `X-Forwarded-For` trusted by default | rate limit trivially bypassed | off unless configured | High |

---

## 2. EC-01 — The lost update that looked like it worked

**This is the most important finding in Problem 5, and it was verified twice:
once wrongly, once properly.**

### The requirement

Two operators open the same product. One sets the stock to 50, the other to 80.
Without concurrency control the second write silently discards the first, and
nobody ever learns that a decision was made on stale data. The `If-Match` header
plus a row version is the standard fix: the write applies only if nobody has
modified the row since the client read it.

### The mistake

TypeORM has `@VersionColumn`, and its documentation describes it as the
optimistic-locking feature. That was taken at face value, and this was written:

```ts
const existing = await repository.findOne({ where: { id } });
if (expectedVersion !== undefined && existing.version !== expectedVersion) {
  throw new VersionConflictError(...);       // pre-check
}
Object.assign(existing, patch);
return await repository.save(existing);      // assumed to add WHERE version = ?
```

The first concurrency test fired ten simultaneous `PATCH`es with the same
`If-Match` and returned **one 200 and nine 409**. Exactly the expected result.

It was wrong. The requests had happened to arrive far enough apart that the
first one committed before the others ran their pre-check — so the *application-
level* check caught them. The test proved the pre-check works when there is no
real race, which is the one case that does not matter.

### What the database actually received

Reading TypeORM's query log rather than its documentation:

```sql
UPDATE "products"
   SET "stock" = $1, "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP
 WHERE "id" IN ($2)
RETURNING "version", "updated_at"
```

**There is no version predicate.** `@VersionColumn` increments the column; it
does not guard the update. Re-running the race with a genuine overlap:

```
10 concurrent PATCH, same If-Match  ->  10 x 200
```

Ten successes means **nine lost updates**, in the exact feature built to prevent
them.

### Why the pre-check cannot save it

```
request A: SELECT version -> 1     request B: SELECT version -> 1
request A: 1 === 1, proceed        request B: 1 === 1, proceed
request A: UPDATE ... (no guard)   request B: UPDATE ... (no guard)
```

Both read before either writes. A check in application code can only narrow the
window, never close it. Closing it requires the check and the write to be the
same atomic operation.

### The fix

```sql
UPDATE products
   SET ..., version = version + 1, updated_at = CURRENT_TIMESTAMP
 WHERE id = $1 AND version = $2
RETURNING *
```

One statement. If another transaction committed first, the row no longer matches
`version = $2`, zero rows are updated, and the caller gets a 409. `affected = 0`
is then disambiguated with a single follow-up `SELECT`: row absent means 404,
row present means someone else won.

Measured after the fix, five consecutive runs of twelve concurrent requests:

```
200 = 1   409 = 11   final version = 2      (x5, no variation)
```

### Why not `findOne({ lock: { mode: 'optimistic', version } })`

TypeORM's other offering validates the version at **read** time and leaves the
same read-to-write window open. It converts the pre-check into library code
without changing what it guarantees.

### What this cost, and the lesson

The ORM's abstraction was believed instead of inspected, and the first test was
written to confirm the design rather than to attack it. Both mistakes are
ordinary; what caught them was reading the emitted SQL. **For anything that
claims to be atomic, the query log is the specification.**

Tested by `tests/integration/products.api.spec.ts`, *"lets exactly one of many
concurrent conditional updates win"*.

---

## 3. EC-02 — A cursor less precise than the row it points at

The second bug the tests caught, and it produced *duplicate rows in a paginated
list* — the kind of defect that reaches a customer as "the export has the same
item twice" months later.

### Symptom

Two pagination tests failed: paging with `sort=createdAt` returned a row on two
consecutive pages.

### Cause

PostgreSQL's `timestamptz` stores **microseconds**. A JavaScript `Date` holds
**milliseconds**. A row written at `09:30:15.123456` is read into the
application as `09:30:15.123`, and the cursor built from it carries the
truncated value. The next page then asks:

```sql
WHERE (created_at, id) > ('2026-09-07 09:30:15.123'::timestamptz, $1)
```

and PostgreSQL answers honestly:

```sql
SELECT '...15.123Z'::timestamptz < '...15.123456Z'::timestamptz;   -- true
```

The boundary row is *greater than its own cursor*, so it is returned again.

### The fix, and the one that was rejected

Storing the timestamps as `timestamptz(3)` makes the stored value exactly
representable in the language that reads it:

```sql
"created_at" timestamptz(3) NOT NULL DEFAULT now()
```

The alternative — carrying microseconds through the cursor as a string — keeps a
precision the application can never handle, and every future consumer of that
timestamp inherits the same trap. A column more precise than its language is a
bug generator, not a feature.

**General principle: store timestamps at a precision your runtime can
represent.** This is not specific to keyset pagination; it is where the symptom
happened to surface.

Tested by *"pages through every row exactly once"* and *"is not disturbed by
rows inserted mid-pagination"*.

---

## 4. Concurrency, beyond EC-01

### EC-03 — Two clients create the same SKU at once

The obvious implementation is `SELECT ... WHERE sku = ?`, then `INSERT` if
nothing came back. Under concurrency both requests pass the check and one still
violates the unique index — surfacing as an unhandled driver error, a 500.

Uniqueness is decided by the index and nowhere else. The `INSERT` runs
unconditionally and SQLSTATE `23505` is translated into a 409. Verified with
eight simultaneous identical creates: **one 201, seven 409**.

### EC-18 — Deleted between the read and the write

A conditional update matching zero rows has two causes. If the row is gone, 409
would be a lie — there is no version to conflict with. The follow-up `SELECT`
tells them apart, and the caller gets 404.

### EC-23 (behaviour) — No `If-Match` means last-write-wins

Omitting the header is allowed, and then concurrent writes overwrite one
another. That is documented, tested (five concurrent updates, five 200s, version
1 → 6) and deliberate: forcing every client to implement conditional requests
would make trivial updates painful. The header is how a client *opts into* the
guarantee.

---

## 5. Data integrity

### EC-04 — `Object.assign` blanks the fields you did not mention

```ts
Object.assign(entity, patch);   // patch = { stock: 5, name: undefined }
```

`Object.assign` copies a key whose value is `undefined` exactly as happily as a
real one, so `name` becomes `undefined` and the column is written as NULL. A
`PATCH` touching one field can quietly wipe six others.

Only keys with a defined value are applied. `null` is preserved deliberately:
for `description` it means *clear this*, which is different from *leave it
alone* — a distinction the API would otherwise be unable to express.

### EC-05 — `bigint` arrives as a string

The `pg` driver returns int8 columns as **strings**, and it is right to: int8
spans ±9.2e18 while a double is exact only to 9.007e15. But an entity field
typed `number` then holds `"1500"` at runtime:

```js
product.priceMinor * quantity   // "1500" * 2  -> 3000        (works by luck)
product.priceMinor + 100        // "1500" + 100 -> "1500100"  (silently wrong)
```

A money bug that passes every type check. A value transformer converts
explicitly and **asserts** the result is a safe integer, so corruption is loud
rather than silent.

**And the same trap a second time:** `RETURNING *` produces *raw* rows, which
bypass entity metadata entirely — so the transformer does not run. The update
path maps the raw row by hand for exactly this reason. Tested by *"keeps the
price a number after an update"*.

### EC-05b — Why `bigint` rather than `integer`

`int4` tops out at 2,147,483,647 — about 2.1 billion dong, which a real
inventory exceeds. Verified end to end with a price of 987,654,321,000: stored
exactly, read back as a `number`.

### Money is never a float

Prices are integers in the currency's minor unit. `0.1 + 0.2 !== 0.3` in
IEEE-754, and money that does not add up is the fastest way to lose trust in a
system. The minor-unit exponent is a presentation concern and belongs in the
client's formatter.

### Constraints live in the database too

Validation at the edge protects against bad requests. A `CHECK` constraint
protects against every *other* path into the table: a migration, a repair
script, a psql session at 3am, a future service. Application-only validation is
a convention; a constraint is a guarantee.

---

## 6. Input handling

### EC-06 — `z.coerce.boolean()` is a trap

`Boolean('false') === true`. Every `?isActive=false` would silently filter for
**active** products — a wrong answer delivered with a 200. Query strings carry
text, so the accepted spellings are enumerated: `true`, `false`, `1`, `0`.

### EC-07 — `z.coerce.number()` is the same trap

`Number('')` is `0`, so `?minPrice=` — a parameter the client sent empty because
its input box was blank — becomes a real filter of `>= 0`. A digits-only regex
runs before coercion.

### EC-08 — The sort parameter is an injection vector

Column names cannot be bound as query parameters, so a sort field taken from
user input has to be interpolated into SQL. The field is matched against a
compile-time whitelist; anything else is a 400. Tested with
`?sort=name;DROP TABLE products--:asc`, after which the table is asserted to
still exist.

Everything else — filter values, the search term, the cursor — is a bound
parameter and never concatenated.

### EC-09 — `%` in a search term

`?q=%` unescaped becomes `ILIKE '%%%'`, which matches every row: a wrong result
*and* the cheapest possible way to make the database do the most work. LIKE
metacharacters are escaped and the pattern declares `ESCAPE '\'`.

### EC-10 — A path parameter that is not a UUID

`SELECT ... WHERE id = 'not-a-uuid'` raises SQLSTATE `22P02` inside the driver,
which surfaces as a 500 for what is plainly a client error. The shape is
validated before the query is built.

### EC-11 — Unknown fields are rejected, not ignored

Without `.strict()`, `{"name":"x","version":999,"id":"..."}` is accepted, the
extra keys are dropped, and the client is told it succeeded. Worse, if the
handler ever spreads the body into an entity, those keys become writes to fields
the API never meant to expose. The SKU is likewise absent from `ProductPatch`:
it is referenced by warehouses, suppliers and printed labels, and re-keying an
item is not a field update.

### EC-12/13 — Empty patch, malformed JSON, wrong media type, oversized body

`PATCH {}` is almost always a client bug — a typo'd field name, or state that
failed to serialise. A 200 that changes nothing lets the bug survive, so it is a
400.

Body-parser failures are classified rather than left to become 500s: malformed
JSON → 400, oversized → 413, unsupported encoding → 415. A request sent as
`text/plain` gets 415, not a confusing "sku is required".

---

## 7. Pagination

### EC-14 — Why not `OFFSET`

`LIMIT 20 OFFSET 10000` makes PostgreSQL walk and discard 10,000 rows: the cost
of page N grows linearly with N. It is also *incorrect* under concurrent writes
— insert a row while a client pages and every later page shifts, so the client
sees a duplicate or misses a row.

Keyset pagination asks "give me the rows after this exact position", which is an
index seek. Page 500 costs the same as page 1, and concurrent inserts cannot
shift the window. Tested by inserting a row mid-pagination and asserting no
overlap.

### EC-15 — The tie-break is not optional

Prices and timestamps are not unique. Without a total ordering the boundary
between pages is ambiguous, and rows with equal sort values get repeated on one
page and skipped on the next. Every cursor carries `(sortValue, id)` and every
query orders by `(sortField, id)`. The composite indexes match that pair exactly,
so the seek stays an index range scan.

### EC-17 — Cursors are validated, not trusted

A corrupt cursor must never produce a 500, and a cursor issued for a *different*
sort must never be honoured: continuing a different ordering from that position
returns an arbitrary slice of the table with a 200 status. Both are 400s. The
offending value is never echoed back — it is attacker-controlled and would land
verbatim in logs.

Cursors are not signed. A forged one can only move the caller's own window
within data they may already read; there is no privilege to escalate.

### No `total`

Counting the filtered set costs a second pass over the same rows to answer a
question keyset pagination does not need — and the number is stale the moment it
is computed.

---

## 8. Failure, security and operations

### EC-19 — The correlation id is attacker-controlled

An inbound `X-Request-Id` is honoured so a trace survives across services — but
only after validation. The value is written into log lines and into a response
header, so an unvalidated one lets a caller inject newlines into logs (forging
entries) or control characters into headers (response splitting). Anything that
does not match the expected shape is replaced rather than rejected: failing a
request over a cosmetic header would be worse than ignoring it.

### EC-20 — The rate limiter fails **open**

If Redis is unreachable the request is allowed and the failure is logged. This
is a trade-off, not an oversight: failing closed converts a cache outage into a
total API outage, which is a strictly worse incident than temporarily unenforced
limits.

The counterargument is real — if the limiter exists to stop abuse, failing open
removes the protection exactly when an attacker may have caused the outage. For
an authenticated internal API the trade would go the other way. It is recorded
here so the choice is visible rather than implied.

### EC-21 — `INCR` and `EXPIRE` are not atomic together

A process interrupted between them leaves a key with no TTL that never resets,
locking that client out permanently. Both run in one Lua script, executed
atomically by Redis.

The limiter is in Redis rather than in process memory because an in-memory
counter is per-process: four replicas mean four times the configured limit, and
a restart resets every client's budget. Verified end to end — 130 requests
against a limit of 120 produced exactly **120 × 200 and 10 × 429**, with the
counter visible in Redis and a `Retry-After` header on every rejection.

### EC-22 — Errors are logged in full and disclosed in summary

Anything not explicitly recognised becomes a 500 whose details never reach the
client. Driver errors carry table names, column names, SQL fragments and
sometimes row values; stack traces carry filesystem paths. Those go to the log,
addressable by `requestId`, and the client gets a generic message plus that id.
Asserted by a test that greps the response body for `SELECT|INSERT|node_modules|
.ts:<line>`.

All errors share one shape — RFC 9457 `application/problem+json` — with a stable
`code` field. Clients branch on `code`, never on prose.

### EC-23 — Liveness must not check the database

If `/healthz` probed PostgreSQL, a database blip would make the orchestrator
**restart every replica**, turning a recoverable dependency outage into a
guaranteed crash loop. Liveness answers "is this process wedged?" and checks
nothing external. Readiness answers "should traffic come here right now?" and
does check dependencies, because the correct response to a database outage is to
stop routing, not to restart.

Readiness returns 503 rather than 200-with-a-flag, because load balancers read
the status code. It never reports *why* a dependency failed: readiness endpoints
are widely exposed and driver errors name hosts, databases and users.

### EC-24 — Shutdown, and why not `npm start`

On `SIGTERM` the process stops accepting connections, lets in-flight requests
finish, then closes the pool. Exiting immediately would abort every request being
served — during a rolling deploy, a burst of 502s for real users on every
release. A timeout forces exit so one wedged request cannot block the process
forever.

The container runs `node dist/main.js`, not `npm start`: npm sits between the
init system and the process and does not forward `SIGTERM`, so the graceful path
never runs.

`keepAliveTimeout` is raised above the typical load-balancer idle timeout.
Node's default is lower, which lets a balancer send a request on a connection
the server is closing — sporadic 502s that are extremely hard to attribute.

### EC-25 — `trust proxy` is off by default

The rate limiter keys on the client IP. If `X-Forwarded-For` is trusted while
nothing upstream overwrites it, any client can send a random value per request
and never be limited at all. Enabling it is an explicit, documented decision.

---

## 9. Verified against the real thing

Claims in this document were checked against a running service and a real
database, not only against tests:

| Claim | How it was verified |
|-------|---------------------|
| Rows are actually written | `psql` row count before/after, then reading the row directly |
| `bigint` is exact | 987,654,321,000 stored and read back identical |
| `timestamptz(3)` applied | `information_schema.columns` reports `datetime_precision = 3` |
| Update changes the row | `stock`, `version` and `updated_at` re-read from `psql` |
| Delete removes the row | row count back to zero |
| Redis records limits | key, counter value, TTL and type read with `redis-cli` |
| Limits are enforced | 130 requests → exactly 120 × 200 + 10 × 429 |
| Data is durable | row survives `docker compose restart postgres` |
| The service recovers | readiness, reads and writes all succeed after that restart |
| The production build runs | verification performed against `node dist/main.js`, not `tsx` |

---

## 10. Deliberately not built

Scope discipline is part of the answer. The brief asks for five operations; each
of the following was considered and left out, and the reason is the same in
every case — it was not requested, and the engineering worth showing is in how
carefully the five behave.

| Not built | Why |
|-----------|-----|
| Authentication | The brief does not mention users or permissions. Problem 6 is where the authorisation design belongs. |
| Soft delete | Adds a predicate to every query and an index to every filter, to satisfy a retention requirement nobody stated. |
| Response caching in Redis | Cache invalidation across five filter dimensions is a correctness risk that buys little at this scale. Keyset pagination and the right indexes are the performance story here. |
| Bulk import, stock adjustment, price history | Extra endpoints, not better ones. |
| `total` in list responses | See §7. |
| Idempotency keys on `POST` | Genuinely useful for retried creates, but the unique SKU already prevents duplicates for this resource. |

---

## 11. Traceability

| Section | Tests |
|---------|-------|
| EC-01 (lost update) | `integration/products.api.spec.ts` — concurrency block |
| EC-02 (timestamp precision) | `integration/products.api.spec.ts` — pagination block |
| EC-03 (SKU race) | `integration` — *"rejects concurrent creates"* |
| EC-04, EC-05 | `integration` — patch block; `unit/shared.spec.ts` — transformer |
| EC-06 … EC-13 | `unit/schemas.spec.ts`, `integration` — validation block |
| EC-14 … EC-18 | `unit/cursor.spec.ts`, `integration` — pagination block |
| EC-19 … EC-22 | `unit/middleware.spec.ts` |
| EC-23 | `unit/health.spec.ts` |
| Repository error mapping | `unit/TypeOrmProductRepository.spec.ts` |

**216 tests — 140 unit, 76 integration against a real PostgreSQL.
100% statements, branches, functions and lines.**

Nothing is excluded from the report to reach that number. The last two
uncovered branches turned out to be compiler output, not code:
`emitDecoratorMetadata` compiles a `Date`-typed property to
`typeof Date !== "undefined" ? Date : Object`, whose fallback is unreachable
because `Date` is a language built-in.

The first attempt suppressed them with `istanbul ignore file`, which reaches
100% by removing the file from the report - a number that flatters rather than
informs. The better fix was to turn `emitDecoratorMetadata` off entirely: every
column in the entity already declares its `type` explicitly, so the metadata was
never used. That removes the unreachable branches at the source, and makes the
`number` -> `int4`/`int8`/`numeric` mapping an explicit decision rather than one
inferred from a TypeScript type.
