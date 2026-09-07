# Problem 5 — A Crude Server

A CRUD API over a product inventory, built with **ExpressJS + TypeScript**,
persisted in **PostgreSQL** via **TypeORM**, with **Redis** for distributed rate
limiting.

> **Task:** Develop a backend server with ExpressJS. Build a set of CRUD
> interfaces that allow a user to interact with the service. Use TypeScript.
> Connect to a database for persistence. Provide a `README.md` for the
> configuration and the way to run the application.

---

## Quick start

The database and cache come from the repository-root Docker stack.

```bash
# 1. Infrastructure (from the repository root)
cp .env.example .env          # then set the two passwords
docker compose up -d --wait
./scripts/verify-infra.sh     # 31 functional and security checks

# 2. This service
cd src/problem5
npm install
npm run migration:run         # create the schema
npm run seed                  # optional: 10 sample products
npm run dev                   # http://localhost:3000
```

Verify it is alive:

```bash
curl localhost:3000/readyz
# {"status":"ready","checks":{"postgres":"ok","redis":"ok"}}
```

### Commands

| Command | What it does | Needs Docker? |
|---------|--------------|---------------|
| `npm run dev` | Development server with reload | yes |
| `npm run build` / `npm start` | Compile to `dist/`, then run the compiled output | yes, to run |
| `npm test` | **Everything** — 224 tests, ~6 s | yes |
| `npm run test:coverage` | Everything, with the coverage report (gate: 100%) | yes |
| `npm run test:unit` | Unit tests only — no database, ~2 s | **no** |
| `npm run test:integration` | Integration tests only | yes |
| `npm run typecheck` | `tsc --noEmit`, strict | no |
| `npm run migration:run` / `:revert` / `:show` | Schema migrations | yes |
| `npm run seed` | Idempotent sample data | yes |

`npm test` and `npx jest --coverage` both run the full suite, including the
integration tests, so the infrastructure must be up first. `npm run test:unit`
is the loop to run while editing: it needs nothing external.

### Docker

```bash
docker build -t problem5 .
docker run --rm -p 3000:3000 --env-file ../../.env problem5
```

Multi-stage build, dev dependencies pruned, runs as the unprivileged `node`
user, `HEALTHCHECK` wired to `/healthz`. The entrypoint is `node dist/main.js`
rather than `npm start`, because npm does not forward `SIGTERM` and graceful
shutdown would never run.

---

## Configuration

Configuration is validated once at start-up and the process **refuses to boot**
if anything is missing or malformed — with *every* problem listed at once, not
just the first. No credential has a default.

Files are loaded in increasing order of precedence:

1. the repository-root `.env` — shared infrastructure credentials, so the
   PostgreSQL and Redis passwords live in exactly one place;
2. `src/problem5/.env` — service-specific overrides (see `.env.example`);
3. real environment variables — what a container or CI runner injects always
   wins.

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | `debug` also logs every SQL statement |
| `POSTGRES_HOST` / `_PORT` / `_DB` | `127.0.0.1` / `5432` / — | |
| `POSTGRES_USER` / `_PASSWORD` | — | **required, no default** |
| `REDIS_HOST` / `_PORT` | `127.0.0.1` / `6379` | |
| `REDIS_PASSWORD` | — | **required, no default** |
| `BODY_LIMIT_BYTES` | `65536` | Bounds per-request memory |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | |
| `RATE_LIMIT_MAX_REQUESTS` | `120` | Per client IP, shared across instances |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Drain window on `SIGTERM` |
| `TRUST_PROXY` | `false` | See the security note below |

---

## API

Five operations. No more — the brief asks for a CRUD interface, and the
engineering worth showing is in how carefully these five behave, not in how many
endpoints sit beside them.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/v1/products` | Create |
| `GET` | `/api/v1/products` | List with filters, sorting, pagination |
| `GET` | `/api/v1/products/:id` | Get one |
| `PATCH` | `/api/v1/products/:id` | Partial update |
| `DELETE` | `/api/v1/products/:id` | Delete |

`/healthz` and `/readyz` also exist; they are operational probes, not resources.

### Create

```bash
curl -X POST localhost:3000/api/v1/products \
  -H 'Content-Type: application/json' \
  -d '{
    "sku": "BEV-COLA-330",
    "name": "Cola 330ml",
    "description": "Carbonated soft drink",
    "category": "beverage",
    "priceMinor": 12000,
    "currency": "VND",
    "stock": 240
  }'
```

```
HTTP/1.1 201 Created
Location: /api/v1/products/0b9c...  
ETag: "1"
```

**`priceMinor` is an integer in the currency's minor unit** — cents for USD,
dong for VND. Never a float: `0.1 + 0.2 !== 0.3`, and money that does not add up
is the fastest way to lose trust in a system.

### List

```bash
curl 'localhost:3000/api/v1/products?category=beverage&minPrice=10000&maxPrice=50000&inStock=true&q=cola&sort=priceMinor:desc&limit=20'
```

| Parameter | Values |
|-----------|--------|
| `category` | `beverage` \| `snack` \| `household` \| `personal_care` \| `electronics` |
| `currency` | `VND` \| `USD` \| `EUR` \| `JPY` |
| `minPrice`, `maxPrice` | Integer minor units |
| `inStock`, `isActive` | `true` \| `false` \| `1` \| `0` |
| `q` | Free text over name and SKU, 3–100 characters (three is the shortest term a trigram index can serve) |
| `sort` | `createdAt` \| `priceMinor` \| `name`, optionally `:asc` / `:desc` |
| `limit` | 1–100, default 20 |
| `cursor` | From the previous page's `nextCursor` |

```json
{ "items": [ /* ... */ ], "nextCursor": "eyJmIjoiY3JlYXRlZEF0Iiwi..." }
```

Pagination is **keyset**, not `OFFSET`. Page 500 costs the same as page 1, and
a row inserted while a client is paging cannot shift the window and cause a
duplicate or a skip. There is no `total`: counting the filtered set costs a
second pass to answer a question keyset pagination does not need, and the number
is stale the moment it is computed.

An unknown query parameter is a **400**, not silently ignored — a typo'd filter
must never return unfiltered data.

### Update, and concurrent writes

```bash
# Unconditional: last write wins
curl -X PATCH localhost:3000/api/v1/products/$ID \
  -H 'Content-Type: application/json' -d '{"stock": 200}'

# Conditional: fails if anyone else wrote first
curl -X PATCH localhost:3000/api/v1/products/$ID \
  -H 'Content-Type: application/json' -H 'If-Match: "3"' \
  -d '{"stock": 200}'
```

Every response carries `ETag: "<version>"`. Echo it back in `If-Match` and the
write becomes conditional:

```
HTTP/1.1 409 Conflict
{
  "code": "VERSION_CONFLICT",
  "detail": "Product ... has been modified by another request
             (expected version 3, current version 5). Re-read the resource and retry.",
  "expectedVersion": 3,
  "actualVersion": 5
}
```

This is enforced by a single statement — `UPDATE ... WHERE id = $1 AND
version = $2` — not by a read-then-compare in application code, which can only
narrow the race window rather than close it. Measured: **ten concurrent
conditional updates produce exactly one 200 and nine 409**.

TypeORM's `@VersionColumn` does *not* provide this on its own; that assumption
cost a real bug, and the story is in
[`docs/EDGE_CASES.md` §2](docs/EDGE_CASES.md).

### Errors

Every error is RFC 9457 `application/problem+json` with a **stable `code`**.
Branch on `code`, never on prose.

```json
{
  "type": "about:blank",
  "title": "Validation failed",
  "status": 400,
  "detail": "The request payload failed validation.",
  "code": "VALIDATION_FAILED",
  "issues": [{ "path": "priceMinor", "message": "must be an integer ..." }],
  "instance": "/api/v1/products",
  "requestId": "0f2c1e3a-..."
}
```

| Status | Codes |
|--------|-------|
| 400 | `VALIDATION_FAILED`, `INVALID_CURSOR`, `MALFORMED_JSON` |
| 404 | `PRODUCT_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | `SKU_ALREADY_EXISTS`, `VERSION_CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE`, `UNSUPPORTED_ENCODING` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |

Unrecognised failures become a 500 whose details never reach the client — driver
errors carry table names, SQL fragments and sometimes row values. Those go to
the log, findable by `requestId`.

---

## Architecture

```
src/
├── main.ts                    bootstrap, graceful shutdown
├── app.ts                     express wiring (no listen: testable)
├── config/env.ts              validated configuration, fails fast
├── domain/product/            entity, repository INTERFACE, constraints
├── application/product/       use cases
├── infrastructure/
│   ├── typeorm/               entity, repository impl, migrations, seed
│   └── redis/                 client
├── interfaces/http/           controller, routes, middleware, zod schemas
└── shared/                    errors, logger, keyset cursor
```

Dependencies point inwards. `domain/` and `application/` do not know that
TypeORM, Express or Redis exist.

**The repository is an interface in `domain/`**, implemented in
`infrastructure/`. That is Dependency Inversion applied where it pays: the
service layer is tested against an in-memory implementation with no database at
all, and replacing the ORM means writing one class rather than editing the
codebase. `tests/support/InMemoryProductRepository.ts` is a real implementation
of the same contract — not a mock. Mocks assert that a method was called; this
asserts that the behaviour is right.

**Single responsibility.** A strategy for persistence, a service for use cases,
a controller for HTTP. The controller parses, calls one method, and shapes the
response; there is no business logic in it. Errors are thrown, never caught
per-handler — Express 5 forwards rejected promises, so one error handler decides
every status code.

**The API response type is declared explicitly** rather than returning the
domain object. The two match today, but a response body is a published contract:
leaking whatever fields the domain grows next is how private data escapes
without anyone deciding to publish it.

### Database

Schema changes go through hand-written, reversible migrations. `synchronize` is
`false` permanently — it is convenient for about a week and then it drops a
column because somebody renamed a property. Migrations are also *not* run on
boot: that is a deployment step, not a side effect of process start, or N
replicas race to migrate during a rolling deploy.

The migration is written by hand rather than generated because generators cannot
express partial indexes, GIN/trigram indexes or `CHECK` constraints — exactly
the parts that matter.

| Index | Serves |
|-------|--------|
| `UQ_products_sku` | The business key. Uniqueness is decided here, never by a prior `SELECT` |
| `(created_at, id)`, `(price_minor, id)`, `(name, id)` | Keyset seeks — the pair the cursor compares |
| `(category, created_at, id)` | The most common filter plus the default ordering |
| `(created_at, id) WHERE is_active AND stock > 0` | Partial: "what can I actually sell" |
| GIN trigram on `name`, `sku` | `ILIKE '%term%'` — a leading wildcard makes a B-tree useless |

`CHECK` constraints mirror the application's validation. Validation at the edge
protects against bad requests; a constraint protects against every other path
into the table — a migration, a repair script, a psql session at 3am.

Timestamps are `timestamptz(3)`. The PostgreSQL default is microseconds, which a
JavaScript `Date` cannot represent — and that mismatch produced duplicate rows
in paginated results until it was found. See
[`docs/EDGE_CASES.md` §3](docs/EDGE_CASES.md).

---

## Security

- **Runtime validation at the trust boundary.** TypeScript types are erased;
  `"5"`, `null` and `{}` all arrive at runtime.
- **Unknown fields are rejected** (`400`), not dropped — the mass-assignment
  defence.
- **Sort fields are whitelisted.** Column names cannot be bound as parameters,
  so a sort field is the one value that must be interpolated. Everything else —
  filters, search terms, cursors — is a bound parameter.
- **LIKE metacharacters are escaped**, so `?q=%` matches a literal percent sign
  instead of every row in the table.
- **Bounded work per request:** body size, page size, and search-term length are
  all capped.
- **Distributed rate limiting** in Redis, evaluated atomically in Lua. It
  **fails open** if Redis is unreachable — a deliberate trade-off, argued in
  `docs/EDGE_CASES.md` §8.
- **`trust proxy` is off by default.** The limiter keys on the client IP; if
  `X-Forwarded-For` were trusted with no proxy in front, any client could forge
  it per request and never be limited.
- **Inbound `X-Request-Id` is validated**, not reflected — otherwise a caller
  can inject newlines into logs or control characters into headers.
- **Credentials are redacted from logs** (`authorization`, `cookie`,
  `x-api-key`, `set-cookie`, `password`), verified by a test that asserts the
  secrets do not appear in the output.
- `helmet`, no `x-powered-by`, restrictive CSP, CORS without credentials.
- **No secret has a default value.**

Out of scope, deliberately: **authentication**. The brief does not mention users
or permissions, and Problem 6 is where the authorisation design belongs.

---

## Testing

**224 tests — 145 unit, 79 integration — 100% statements, branches, functions
and lines.**

```
Statements   : 100% ( 433/433 )
Branches     : 100% ( 151/151 )
Functions    : 100% ( 83/83 )
Lines        : 100% ( 425/425 )
```

Coverage is measured over the **whole** suite. A unit-only run reports far less
(the repository and the controller are exercised by the integration tests, which
is where they belong), so `npm run test:coverage` and `npx jest --coverage` both
run everything.

The suite runs in a single worker (`maxWorkers: 1`, ~3 s). That is deliberate:
the integration tests share one database and clear it between tests, so
serialising them is a correctness requirement rather than a performance
trade-off.

The gate is set to 100%: every branch in this service is a reachable decision —
a status code, a concurrency outcome, a validation rule — so an uncovered one
means an untested edge case.

Nothing is excluded to reach that number. The last two uncovered branches were
compiler output rather than code — `emitDecoratorMetadata` compiles a
`Date`-typed property to `typeof Date !== "undefined" ? Date : Object`, and the
fallback can never execute. Rather than suppress them with an ignore comment,
the flag itself was turned off: every column here already declares its `type`
explicitly, which is better practice anyway, since the mapping from `number` to
`int4`/`int8`/`numeric` is a decision worth making on purpose.

| Suite | Covers |
|-------|--------|
| `unit/schemas.spec.ts` | Every validation rule and coercion trap |
| `unit/cursor.spec.ts` | Cursor encoding, tampering, sort mismatch |
| `unit/ProductService.spec.ts` | Use cases against the in-memory repository |
| `unit/TypeOrmProductRepository.spec.ts` | Driver error → HTTP status mapping |
| `unit/middleware.spec.ts` | Error handler, rate limiter, correlation id, Redis client |
| `unit/health.spec.ts` | Liveness vs readiness, and non-disclosure on failure |
| `unit/shared.spec.ts` | Error taxonomy, bigint transformer, config, log redaction |
| `integration/products.api.spec.ts` | All five endpoints against real PostgreSQL |

Integration tests run against a **dedicated database**, dropped and recreated
from the migrations on every run — so every run also verifies that the
migrations produce the schema the code expects. A migration never executed
before production is a migration nobody has tested.

Nothing is stubbed in the integration suite: the same `createApp` that `main.ts`
uses, the same middleware chain, the same repository, the same schema.

---

## Operations

`/healthz` (liveness) checks **nothing external**. If it probed the database, a
database blip would make the orchestrator restart every replica — turning a
recoverable outage into a guaranteed crash loop. `/readyz` (readiness) does
check dependencies and returns **503** when one is down, because the correct
response to a database outage is to stop routing traffic here, not to restart.

On `SIGTERM` the process stops accepting connections, drains in-flight requests,
then closes the pool — with a timeout so one wedged request cannot block exit
forever. Verified in practice: after `docker compose restart postgres`, the
service recovered on its own — readiness green, reads and writes succeeding, no
crash.

Logs are structured JSON with a `requestId` on every line, matching the
`X-Request-Id` header returned to the client.

---

## Further reading

**[`docs/EDGE_CASES.md`](docs/EDGE_CASES.md)** — 25 edge cases, the worst-case
scenarios, what was deliberately *not* built and why, and the two bugs the tests
caught in code that looked like it worked: a lost-update race that a passing
test had already declared safe, and a keyset cursor less precise than the row it
pointed at.
