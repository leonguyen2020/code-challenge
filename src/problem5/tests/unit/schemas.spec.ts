import { describe, expect, it } from '@jest/globals';
import {
  createProductSchema,
  ifMatchHeaderSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  updateProductSchema,
} from '../../src/interfaces/http/schemas/product';

const VALID = {
  sku: 'BEV-COLA-330',
  name: 'Cola 330ml',
  category: 'beverage',
  priceMinor: 12_000,
  currency: 'VND',
  stock: 10,
};

describe('createProductSchema', () => {
  it('accepts a valid body and applies defaults', () => {
    const parsed = createProductSchema.parse(VALID);
    expect(parsed.description).toBeNull();
    expect(parsed.isActive).toBe(true);
  });

  it('rejects unknown keys instead of silently dropping them', () => {
    // Mass-assignment defence: without .strict() a client could believe it set
    // `version` or `id` and get a 201 saying so.
    expect(() => createProductSchema.parse({ ...VALID, version: 99 })).toThrow();
    expect(() => createProductSchema.parse({ ...VALID, id: 'x' })).toThrow();
    expect(() => createProductSchema.parse({ ...VALID, isAdmin: true })).toThrow();
  });

  it('rejects a fractional price', () => {
    // Money is integer minor units. 19.99 would truncate or round somewhere.
    expect(() => createProductSchema.parse({ ...VALID, priceMinor: 19.99 })).toThrow();
  });

  it('rejects a price or stock outside the domain bounds', () => {
    expect(() => createProductSchema.parse({ ...VALID, priceMinor: -1 })).toThrow();
    expect(() => createProductSchema.parse({ ...VALID, stock: -1 })).toThrow();
    expect(() => createProductSchema.parse({ ...VALID, priceMinor: 1e13 })).toThrow();
    expect(() => createProductSchema.parse({ ...VALID, stock: 1e10 })).toThrow();
  });

  it('trims the name and rejects one that is only whitespace', () => {
    expect(createProductSchema.parse({ ...VALID, name: '  Cola  ' }).name).toBe('Cola');
    expect(() => createProductSchema.parse({ ...VALID, name: '   ' })).toThrow();
  });

  it.each(['lower-case', 'has space', 'ÁCCENT-1', '-LEADING', 'AB', 'A'.repeat(33)])(
    'rejects the malformed SKU %p',
    (sku) => {
      expect(() => createProductSchema.parse({ ...VALID, sku })).toThrow();
    },
  );

  it('rejects an unknown category or currency', () => {
    expect(() => createProductSchema.parse({ ...VALID, category: 'weapons' })).toThrow();
    expect(() => createProductSchema.parse({ ...VALID, currency: 'XXX' })).toThrow();
  });

  it('rejects a numeric string where a number is required', () => {
    // JSON distinguishes "12000" from 12000; accepting both invites the client
    // to keep sending strings until something downstream concatenates them.
    expect(() => createProductSchema.parse({ ...VALID, priceMinor: '12000' })).toThrow();
  });
});

describe('updateProductSchema', () => {
  it('accepts a single field', () => {
    expect(updateProductSchema.parse({ stock: 5 })).toEqual({ stock: 5 });
  });

  it('rejects an empty patch', () => {
    // Almost always a client bug: a typo'd field name, or state that failed to
    // serialise. A 200 that changes nothing lets the bug survive.
    expect(() => updateProductSchema.parse({})).toThrow();
  });

  it('does not allow the SKU to be changed', () => {
    // The SKU is referenced by warehouses, suppliers and printed labels.
    expect(() => updateProductSchema.parse({ sku: 'NEW-SKU-1' })).toThrow();
  });

  it('allows description to be explicitly cleared', () => {
    expect(updateProductSchema.parse({ description: null })).toEqual({ description: null });
  });
});

describe('listProductsQuerySchema', () => {
  it('parses an empty query', () => {
    expect(listProductsQuerySchema.parse({})).toEqual({});
  });

  it('parses "false" as false, not as a truthy string', () => {
    // z.coerce.boolean() applies Boolean('false') === true, which would make
    // ?isActive=false silently filter for ACTIVE products.
    expect(Boolean('false')).toBe(true);
    expect(listProductsQuerySchema.parse({ isActive: 'false' }).isActive).toBe(false);
    expect(listProductsQuerySchema.parse({ isActive: 'true' }).isActive).toBe(true);
    expect(listProductsQuerySchema.parse({ inStock: '0' }).inStock).toBe(false);
    expect(listProductsQuerySchema.parse({ inStock: '1' }).inStock).toBe(true);
  });

  it('rejects a boolean spelled any other way', () => {
    expect(() => listProductsQuerySchema.parse({ isActive: 'yes' })).toThrow();
    expect(() => listProductsQuerySchema.parse({ isActive: '' })).toThrow();
  });

  it('rejects an empty numeric parameter rather than reading it as zero', () => {
    // `?minPrice=` is a missing value, not a filter of ">= 0".
    expect(() => listProductsQuerySchema.parse({ minPrice: '' })).toThrow();
    expect(() => listProductsQuerySchema.parse({ minPrice: 'abc' })).toThrow();
    expect(() => listProductsQuerySchema.parse({ minPrice: '1.5' })).toThrow();
  });

  it('rejects an inverted price range', () => {
    expect(() => listProductsQuerySchema.parse({ minPrice: '100', maxPrice: '50' })).toThrow();
    expect(listProductsQuerySchema.parse({ minPrice: '50', maxPrice: '100' }).minPrice).toBe(50);
  });

  it('enforces the limit bounds', () => {
    expect(() => listProductsQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => listProductsQuerySchema.parse({ limit: '101' })).toThrow();
    expect(listProductsQuerySchema.parse({ limit: '100' }).limit).toBe(100);
  });

  it('parses sort and defaults the direction to asc', () => {
    expect(listProductsQuerySchema.parse({ sort: 'priceMinor:desc' }).sort).toEqual({
      field: 'priceMinor',
      direction: 'desc',
    });
    expect(listProductsQuerySchema.parse({ sort: 'name' }).sort).toEqual({
      field: 'name',
      direction: 'asc',
    });
  });

  it('rejects a sort field that is not whitelisted', () => {
    // Column names cannot be bound as parameters, so an unvalidated sort field
    // is interpolated into SQL. The whitelist is the defence.
    expect(() => listProductsQuerySchema.parse({ sort: 'password:asc' })).toThrow();
    expect(() => listProductsQuerySchema.parse({ sort: 'name; DROP TABLE products--:asc' })).toThrow();
    expect(() => listProductsQuerySchema.parse({ sort: 'name:sideways' })).toThrow();
  });

  it('rejects unknown query parameters', () => {
    // A typo'd filter must not silently return unfiltered data.
    expect(() => listProductsQuerySchema.parse({ catgory: 'snack' })).toThrow();
  });

  it('enforces the search term length bounds', () => {
    expect(() => listProductsQuerySchema.parse({ q: 'a' })).toThrow();
    expect(() => listProductsQuerySchema.parse({ q: 'a'.repeat(101) })).toThrow();
    expect(listProductsQuerySchema.parse({ q: 'ab' }).q).toBe('ab');
  });
});

describe('productIdParamSchema', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(productIdParamSchema.parse({ id: '11111111-1111-4111-8111-111111111111' }).id).toBeDefined();
    // Reaching Postgres with a non-UUID raises SQLSTATE 22P02, which would
    // surface as a 500 for what is plainly a client error.
    expect(() => productIdParamSchema.parse({ id: 'not-a-uuid' })).toThrow();
    expect(() => productIdParamSchema.parse({ id: '' })).toThrow();
  });
});

describe('ifMatchHeaderSchema', () => {
  it.each([
    ['"3"', 3],
    ['3', 3],
    ['W/"3"', 3],
  ])('parses %p as version %p', (raw, expected) => {
    expect(ifMatchHeaderSchema.parse(raw)).toBe(expected);
  });

  it('rejects a non-numeric entity tag', () => {
    expect(() => ifMatchHeaderSchema.parse('"abc"')).toThrow();
    expect(() => ifMatchHeaderSchema.parse('*')).toThrow();
  });
});
