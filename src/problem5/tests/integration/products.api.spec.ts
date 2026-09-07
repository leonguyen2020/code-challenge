import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { productPayload, startTestApp, type TestHarness } from './support/testApp';

const BASE = '/api/v1/products';
const MISSING_ID = '99999999-9999-4999-8999-999999999999';

let harness: TestHarness;

beforeAll(async () => {
  harness = await startTestApp();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.truncate();
});

const api = () => request(harness.app);

/** Creates a product and returns its response body. */
async function create(overrides: Record<string, unknown> = {}): Promise<Record<string, never>> {
  const response = await api().post(BASE).send(productPayload(overrides)).expect(201);
  return response.body as Record<string, never>;
}

describe('POST /api/v1/products', () => {
  it('creates a product and returns 201 with Location and ETag', async () => {
    const response = await api().post(BASE).send(productPayload()).expect(201);

    expect(response.body).toMatchObject({
      sku: 'BEV-COLA-330',
      name: 'Cola 330ml',
      category: 'beverage',
      priceMinor: 12_000,
      currency: 'VND',
      stock: 10,
      isActive: true,
      version: 1,
    });
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['location']).toBe(`${BASE}/${response.body.id}`);
    expect(response.headers['etag']).toBe('"1"');
    // Timestamps are ISO-8601 with an offset, not a locale-dependent string.
    expect(response.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('defaults description to null and isActive to true', async () => {
    const body = await create({ description: undefined, isActive: undefined });
    expect(body.description).toBeNull();
    expect(body.isActive).toBe(true);
  });

  it('rejects a duplicate SKU with 409 from the database constraint', async () => {
    await create();
    const response = await api().post(BASE).send(productPayload({ name: 'Other' })).expect(409);
    expect(response.body.code).toBe('SKU_ALREADY_EXISTS');
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects concurrent creates of the same SKU, letting exactly one win', async () => {
    // The race a check-then-insert cannot survive: both requests would pass a
    // prior SELECT. Only the unique index can decide.
    const attempts = Array.from({ length: 8 }, () =>
      api().post(BASE).send(productPayload()),
    );
    const results = await Promise.all(attempts);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
  });

  it.each([
    ['fractional price', { priceMinor: 19.99 }],
    ['negative price', { priceMinor: -1 }],
    ['negative stock', { stock: -1 }],
    ['blank name', { name: '   ' }],
    ['lower-case sku', { sku: 'bev-cola-330' }],
    ['unknown category', { category: 'weapons' }],
    ['unknown currency', { currency: 'XXX' }],
    ['price above the ceiling', { priceMinor: 1e13 }],
    ['unknown field', { isAdmin: true }],
    ['client-supplied version', { version: 99 }],
  ])('rejects %s with 400', async (_label, overrides) => {
    const response = await api().post(BASE).send(productPayload(overrides)).expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(response.body.issues)).toBe(true);
  });

  it('rejects malformed JSON with 400, not 500', async () => {
    const response = await api()
      .post(BASE)
      .set('Content-Type', 'application/json')
      .send('{"sku": ')
      .expect(400);
    expect(response.body.code).toBe('MALFORMED_JSON');
  });

  it('rejects a non-JSON content type with 415', async () => {
    const response = await api().post(BASE).set('Content-Type', 'text/plain').send('hello').expect(415);
    expect(response.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects an oversized body with 413 before parsing it', async () => {
    const huge = { ...productPayload(), description: 'x'.repeat(200_000) };
    const response = await api().post(BASE).send(huge).expect(413);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('stores a price larger than a 32-bit integer and reads it back as a number', async () => {
    // int4 tops out at 2,147,483,647. The column is bigint, which the pg driver
    // returns as a *string* - the transformer is what keeps it a number.
    const big = 999_999_999_999;
    const body = await create({ sku: 'ELE-EXPENSIVE-1', priceMinor: big });
    const fetched = await api().get(`${BASE}/${body.id}`).expect(200);
    expect(fetched.body.priceMinor).toBe(big);
    expect(typeof fetched.body.priceMinor).toBe('number');
  });
});

describe('GET /api/v1/products/:id', () => {
  it('returns the product with an ETag', async () => {
    const created = await create();
    const response = await api().get(`${BASE}/${created.id}`).expect(200);
    expect(response.body.id).toBe(created.id);
    expect(response.headers['etag']).toBe('"1"');
  });

  it('returns 404 for an id that does not exist', async () => {
    const response = await api().get(`${BASE}/${MISSING_ID}`).expect(404);
    expect(response.body.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('returns 400 - not 500 - for an id that is not a UUID', async () => {
    // Passing this through would raise SQLSTATE 22P02 inside the driver.
    const response = await api().get(`${BASE}/not-a-uuid`).expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/products (list, filters, pagination)', () => {
  beforeEach(async () => {
    await create({ sku: 'BEV-A-1', name: 'Cola', category: 'beverage', priceMinor: 10_000, stock: 5 });
    await create({ sku: 'BEV-B-1', name: 'Green tea', category: 'beverage', priceMinor: 20_000, stock: 0 });
    await create({ sku: 'SNK-C-1', name: 'Chips', category: 'snack', priceMinor: 20_000, stock: 3, isActive: false });
    await create({ sku: 'SNK-D-1', name: 'Nuts', category: 'snack', priceMinor: 30_000, stock: 7 });
  });

  it('returns every product with a null cursor when they fit on one page', async () => {
    const response = await api().get(BASE).expect(200);
    expect(response.body.items).toHaveLength(4);
    expect(response.body.nextCursor).toBeNull();
    // No `total`: counting the filtered set would cost a second pass to answer
    // a question keyset pagination does not need.
    expect(response.body).not.toHaveProperty('total');
  });

  it.each([
    ['category=beverage', 'category=beverage', 2],
    ['category=snack', 'category=snack', 2],
    ['isActive=false', 'isActive=false', 1],
    ['isActive=true', 'isActive=true', 3],
    ['inStock=false', 'inStock=false', 1],
    ['inStock=true', 'inStock=true', 3],
    ['price range', 'minPrice=20000&maxPrice=30000', 3],
    ['currency', 'currency=VND', 4],
    ['combined', 'category=snack&inStock=true', 2],
  ])('filters by %s', async (_label, query, expected) => {
    const response = await api().get(`${BASE}?${query}`).expect(200);
    expect(response.body.items).toHaveLength(expected);
  });

  it('parses isActive=false as false rather than as a truthy string', async () => {
    const response = await api().get(`${BASE}?isActive=false`).expect(200);
    expect(response.body.items.every((p: { isActive: boolean }) => p.isActive === false)).toBe(true);
  });

  it('searches name and SKU case-insensitively', async () => {
    expect((await api().get(`${BASE}?q=cola`).expect(200)).body.items).toHaveLength(1);
    expect((await api().get(`${BASE}?q=COLA`).expect(200)).body.items).toHaveLength(1);
    expect((await api().get(`${BASE}?q=SNK`).expect(200)).body.items).toHaveLength(2);
  });

  it('treats LIKE metacharacters in the search term as literals', async () => {
    // Unescaped, `%%%` matches every row - a wrong answer and the cheapest way
    // to make the database do the most work. Three characters because that is
    // the minimum term length (SEARCH_TERM_MIN_LENGTH), which is itself set by
    // what a trigram index can serve.
    expect((await api().get(`${BASE}?q=%25%25%25`).expect(200)).body.items).toHaveLength(0);
    expect((await api().get(`${BASE}?q=___`).expect(200)).body.items).toHaveLength(0);
  });

  it('rejects a sort field that is not whitelisted', async () => {
    // Column names cannot be bound as parameters, so the whitelist is the only
    // thing standing between user input and interpolated SQL.
    await api().get(`${BASE}?sort=id:asc`).expect(400);
    await api().get(`${BASE}?sort=name;DROP TABLE products--:asc`).expect(400);
    // The table is still there.
    expect((await api().get(BASE).expect(200)).body.items).toHaveLength(4);
  });

  it.each([
    ['unknown query parameter', 'catgory=snack'],
    ['limit below the minimum', 'limit=0'],
    ['limit above the maximum', 'limit=101'],
    ['non-numeric limit', 'limit=abc'],
    ['empty numeric filter', 'minPrice='],
    ['inverted price range', 'minPrice=100&maxPrice=50'],
    // Regression: these used to reach PostgreSQL as bigint literals that
    // overflowed the column, so the driver error surfaced as a 500.
    ['price bound beyond bigint', 'minPrice=9223372036854775808'],
    ['price bound beyond the safe range', 'maxPrice=99999999999999999999'],
    ['price bound above the column ceiling', 'minPrice=1000000000001'],
    ['search term too short', 'q=a'],
    ['malformed cursor', 'cursor=not-base64'],
  ])('rejects %s with 400', async (_label, query) => {
    await api().get(`${BASE}?${query}`).expect(400);
  });

  it('pages through every row exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url: string = cursor === null
        ? `${BASE}?limit=2&sort=createdAt:asc`
        : `${BASE}?limit=2&sort=createdAt:asc&cursor=${encodeURIComponent(cursor)}`;
      const response = await api().get(url).expect(200);
      seen.push(...response.body.items.map((p: { id: string }) => p.id));
      cursor = response.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it('does not repeat or skip rows when the sort value is not unique', async () => {
    // Two products share priceMinor 20,000. Without the id tie-break the page
    // boundary between them is ambiguous.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url: string = cursor === null
        ? `${BASE}?limit=1&sort=priceMinor:asc`
        : `${BASE}?limit=1&sort=priceMinor:asc&cursor=${encodeURIComponent(cursor)}`;
      const response = await api().get(url).expect(200);
      seen.push(...response.body.items.map((p: { id: string }) => p.id));
      cursor = response.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it('is not disturbed by rows inserted mid-pagination', async () => {
    // The failure mode OFFSET has and keyset does not: an insert shifts every
    // later page, so the client sees a duplicate or misses a row.
    const first = await api().get(`${BASE}?limit=2&sort=createdAt:asc`).expect(200);
    const firstIds = first.body.items.map((p: { id: string }) => p.id);
    await create({ sku: 'NEW-DURING-PAGING', name: 'Inserted mid-scan' });
    const second = await api()
      .get(`${BASE}?limit=2&sort=createdAt:asc&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    const secondIds = second.body.items.map((p: { id: string }) => p.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('rejects a cursor issued for a different sort', async () => {
    const first = await api().get(`${BASE}?limit=2&sort=priceMinor:asc`).expect(200);
    await api()
      .get(`${BASE}?limit=2&sort=name:asc&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(400);
  });

  it('paginates correctly when sorting by name', async () => {
    // Exercises the third sortable column, and with it the string branch of
    // the cursor's value extraction.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url: string = cursor === null
        ? `${BASE}?limit=2&sort=name:asc`
        : `${BASE}?limit=2&sort=name:asc&cursor=${encodeURIComponent(cursor)}`;
      const response = await api().get(url).expect(200);
      seen.push(...response.body.items.map((p: { name: string }) => p.name));
      cursor = response.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(4);
  });

  it('paginates correctly when sorting descending', async () => {
    // The keyset comparison flips from `>` to `<` for a descending sort; that
    // branch is only reached when a cursor is supplied.
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url: string = cursor === null
        ? `${BASE}?limit=2&sort=priceMinor:desc`
        : `${BASE}?limit=2&sort=priceMinor:desc&cursor=${encodeURIComponent(cursor)}`;
      const response = await api().get(url).expect(200);
      seen.push(...response.body.items.map((p: { priceMinor: number }) => p.priceMinor));
      cursor = response.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(4);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it('sorts ascending and descending', async () => {
    const asc = await api().get(`${BASE}?sort=priceMinor:asc`).expect(200);
    const desc = await api().get(`${BASE}?sort=priceMinor:desc`).expect(200);
    const prices = (r: { body: { items: { priceMinor: number }[] } }) =>
      r.body.items.map((p) => p.priceMinor);
    expect(prices(asc)).toEqual([...prices(asc)].sort((a, b) => a - b));
    expect(prices(desc)).toEqual([...prices(desc)].sort((a, b) => b - a));
  });
});

describe('PATCH /api/v1/products/:id', () => {
  it('applies a partial update and bumps the version', async () => {
    const created = await create();
    const response = await api().patch(`${BASE}/${created.id}`).send({ stock: 99 }).expect(200);
    expect(response.body.stock).toBe(99);
    expect(response.body.version).toBe(2);
    expect(response.headers['etag']).toBe('"2"');
    // Fields the patch did not mention survive untouched.
    expect(response.body.name).toBe(created.name);
    expect(response.body.priceMinor).toBe(created.priceMinor);
    expect(response.body.createdAt).toBe(created.createdAt);
    expect(response.body.updatedAt).not.toBe(created.updatedAt);
  });

  it('clears the description when null is sent, without touching anything else', async () => {
    const created = await create({ description: 'remove me' });
    const response = await api().patch(`${BASE}/${created.id}`).send({ description: null }).expect(200);
    expect(response.body.description).toBeNull();
    expect(response.body.name).toBe(created.name);
    expect(response.body.stock).toBe(created.stock);
  });

  it('keeps the price a number after an update', async () => {
    // The RETURNING clause bypasses the entity transformer, so bigint would
    // come back as a string if it were not mapped by hand.
    const created = await create({ priceMinor: 5_000_000_000 });
    const response = await api().patch(`${BASE}/${created.id}`).send({ stock: 1 }).expect(200);
    expect(typeof response.body.priceMinor).toBe('number');
    expect(response.body.priceMinor).toBe(5_000_000_000);
  });

  it('accepts a matching If-Match', async () => {
    const created = await create();
    await api()
      .patch(`${BASE}/${created.id}`)
      .set('If-Match', '"1"')
      .send({ stock: 1 })
      .expect(200);
  });

  it('rejects a stale If-Match with 409 and reports both versions', async () => {
    const created = await create();
    await api().patch(`${BASE}/${created.id}`).send({ stock: 1 }).expect(200);
    const response = await api()
      .patch(`${BASE}/${created.id}`)
      .set('If-Match', '"1"')
      .send({ stock: 2 })
      .expect(409);
    expect(response.body.code).toBe('VERSION_CONFLICT');
    expect(response.body.expectedVersion).toBe(1);
    expect(response.body.actualVersion).toBe(2);
  });

  it('lets exactly one of many concurrent conditional updates win', async () => {
    // The lost-update test. TypeORM's save() does NOT add a version predicate -
    // verified from its query log - so this only passes because update() issues
    // `UPDATE ... WHERE id = $1 AND version = $2` as a single statement.
    const created = await create();
    const attempts = Array.from({ length: 10 }, (_, index) =>
      api().patch(`${BASE}/${created.id}`).set('If-Match', '"1"').send({ stock: index + 1 }),
    );
    const results = await Promise.all(attempts);
    const statuses = results.map((r) => r.status);

    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);

    const after = await api().get(`${BASE}/${created.id}`).expect(200);
    // Exactly one write landed, so exactly one version increment happened.
    expect(after.body.version).toBe(2);
  });

  it('allows last-write-wins when If-Match is omitted', async () => {
    // Documented behaviour, not an accident: the header is how a client opts
    // into the check.
    const created = await create();
    const attempts = Array.from({ length: 5 }, (_, index) =>
      api().patch(`${BASE}/${created.id}`).send({ stock: index + 1 }),
    );
    const results = await Promise.all(attempts);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const after = await api().get(`${BASE}/${created.id}`).expect(200);
    expect(after.body.version).toBe(6);
  });

  it.each([
    ['empty patch', {}],
    ['unknown field', { isAdmin: true }],
    ['sku change', { sku: 'NEW-SKU-1' }],
    ['client-supplied version', { version: 42 }],
    ['fractional price', { priceMinor: 1.5 }],
  ])('rejects a %s with 400', async (_label, body) => {
    const created = await create();
    await api().patch(`${BASE}/${created.id}`).send(body).expect(400);
  });

  it('rejects a malformed If-Match with 400', async () => {
    const created = await create();
    await api().patch(`${BASE}/${created.id}`).set('If-Match', '"abc"').send({ stock: 1 }).expect(400);
  });

  it('returns 404 for an id that does not exist', async () => {
    await api().patch(`${BASE}/${MISSING_ID}`).send({ stock: 1 }).expect(404);
  });

  it('returns 404 when the product was deleted between read and write', async () => {
    const created = await create();
    await api().delete(`${BASE}/${created.id}`).expect(204);
    const response = await api()
      .patch(`${BASE}/${created.id}`)
      .set('If-Match', '"1"')
      .send({ stock: 1 })
      .expect(404);
    // 404, not 409: the row is gone, so there is no version to conflict with.
    expect(response.body.code).toBe('PRODUCT_NOT_FOUND');
  });
});

describe('DELETE /api/v1/products/:id', () => {
  it('deletes the product and returns 204 with no body', async () => {
    const created = await create();
    const response = await api().delete(`${BASE}/${created.id}`).expect(204);
    expect(response.body).toEqual({});
    await api().get(`${BASE}/${created.id}`).expect(404);
  });

  it('returns 404 on a second delete', async () => {
    const created = await create();
    await api().delete(`${BASE}/${created.id}`).expect(204);
    await api().delete(`${BASE}/${created.id}`).expect(404);
  });

  it('frees the SKU for reuse', async () => {
    const created = await create();
    await api().delete(`${BASE}/${created.id}`).expect(204);
    await api().post(BASE).send(productPayload()).expect(201);
  });
});

describe('cross-cutting behaviour', () => {
  it('returns 404 in the problem+json shape for an unknown route', async () => {
    const response = await api().get('/api/v1/nope').expect(404);
    expect(response.body.code).toBe('ROUTE_NOT_FOUND');
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('does not advertise the framework', async () => {
    const response = await api().get(BASE).expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets security headers and a correlation id', async () => {
    const response = await api().get(BASE).expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-zA-Z-]{8,64}$/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('echoes a well-formed inbound correlation id', async () => {
    const response = await api().get(BASE).set('X-Request-Id', 'trace-abc-123').expect(200);
    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('replaces a hostile correlation id instead of reflecting it', async () => {
    // An unvalidated value here lets a caller forge log lines or inject control
    // characters into a response header.
    const response = await api().get(BASE).set('X-Request-Id', 'a b\tc"d').expect(200);
    expect(response.headers['x-request-id']).not.toBe('a b\tc"d');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never leaks SQL, table names or stack traces in an error body', async () => {
    const response = await api().get(`${BASE}/not-a-uuid`).expect(400);
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/SELECT|INSERT|UPDATE|node_modules|\.ts:\d+/i);
    expect(response.body.requestId).toBeDefined();
  });

  it('reports readiness only while its dependencies are reachable', async () => {
    const response = await api().get('/readyz').expect(200);
    expect(response.body).toEqual({ status: 'ready', checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('answers liveness without touching any dependency', async () => {
    const response = await api().get('/healthz').expect(200);
    expect(response.body.status).toBe('ok');
  });
});
