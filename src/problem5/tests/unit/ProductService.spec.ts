import { beforeEach, describe, expect, it } from '@jest/globals';
import { ProductService } from '../../src/application/product/ProductService';
import type { NewProduct } from '../../src/domain/product/Product';
import {
  ProductNotFoundError,
  SkuAlreadyExistsError,
  VersionConflictError,
} from '../../src/shared/errors';
import { InMemoryProductRepository } from '../support/InMemoryProductRepository';

const NEW_PRODUCT: NewProduct = {
  sku: 'BEV-COLA-330',
  name: 'Cola 330ml',
  description: null,
  category: 'beverage',
  priceMinor: 12_000,
  currency: 'VND',
  stock: 10,
  isActive: true,
};

const MISSING_ID = '99999999-9999-4999-8999-999999999999';

describe('ProductService', () => {
  let repository: InMemoryProductRepository;
  let service: ProductService;

  beforeEach(() => {
    repository = new InMemoryProductRepository();
    service = new ProductService(repository);
  });

  describe('create', () => {
    it('stores the product and assigns version 1', async () => {
      const product = await service.create(NEW_PRODUCT);
      expect(product.version).toBe(1);
      expect(product.sku).toBe('BEV-COLA-330');
      expect(product.createdAt).toEqual(product.updatedAt);
      expect(repository.size()).toBe(1);
    });

    it('rejects a duplicate SKU', async () => {
      await service.create(NEW_PRODUCT);
      await expect(service.create({ ...NEW_PRODUCT, name: 'Other' })).rejects.toBeInstanceOf(
        SkuAlreadyExistsError,
      );
      expect(repository.size()).toBe(1);
    });
  });

  describe('getById', () => {
    it('returns the product', async () => {
      const created = await service.create(NEW_PRODUCT);
      expect(await service.getById(created.id)).toEqual(created);
    });

    it('throws rather than returning null, so callers cannot forget to check', async () => {
      await expect(service.getById(MISSING_ID)).rejects.toBeInstanceOf(ProductNotFoundError);
    });
  });

  describe('update', () => {
    it('applies a partial patch and bumps the version', async () => {
      const created = await service.create(NEW_PRODUCT);
      const updated = await service.update(created.id, { stock: 99 });
      expect(updated.stock).toBe(99);
      expect(updated.version).toBe(created.version + 1);
      // Everything the patch did not mention is untouched.
      expect(updated.name).toBe(created.name);
      expect(updated.priceMinor).toBe(created.priceMinor);
    });

    it('does not blank fields whose patch value is undefined', async () => {
      const created = await service.create({ ...NEW_PRODUCT, description: 'keep me' });
      const updated = await service.update(created.id, { stock: 1, name: undefined });
      expect(updated.name).toBe(created.name);
      expect(updated.description).toBe('keep me');
    });

    it('clears the description when null is supplied explicitly', async () => {
      const created = await service.create({ ...NEW_PRODUCT, description: 'remove me' });
      expect((await service.update(created.id, { description: null })).description).toBeNull();
    });

    it('accepts a matching expected version', async () => {
      const created = await service.create(NEW_PRODUCT);
      const updated = await service.update(created.id, { stock: 1 }, created.version);
      expect(updated.version).toBe(2);
    });

    it('rejects a stale expected version', async () => {
      const created = await service.create(NEW_PRODUCT);
      await service.update(created.id, { stock: 1 });
      await expect(
        service.update(created.id, { stock: 2 }, created.version),
      ).rejects.toBeInstanceOf(VersionConflictError);
    });

    it('reports both versions so the client can decide what to do', async () => {
      const created = await service.create(NEW_PRODUCT);
      await service.update(created.id, { stock: 1 });
      try {
        await service.update(created.id, { stock: 2 }, 1);
        throw new Error('expected a throw');
      } catch (error) {
        const conflict = error as VersionConflictError;
        expect(conflict.expectedVersion).toBe(1);
        expect(conflict.actualVersion).toBe(2);
        expect(conflict.code).toBe('VERSION_CONFLICT');
      }
    });

    it('throws when the product does not exist', async () => {
      await expect(service.update(MISSING_ID, { stock: 1 })).rejects.toBeInstanceOf(
        ProductNotFoundError,
      );
    });
  });

  describe('delete', () => {
    it('removes the product', async () => {
      const created = await service.create(NEW_PRODUCT);
      await service.delete(created.id);
      expect(repository.size()).toBe(0);
      await expect(service.getById(created.id)).rejects.toBeInstanceOf(ProductNotFoundError);
    });

    it('reports a delete of something that was never there', async () => {
      // DELETE is idempotent at the protocol level, but silently succeeding for
      // an id that never existed hides client bugs forever.
      await expect(service.delete(MISSING_ID)).rejects.toBeInstanceOf(ProductNotFoundError);
    });

    it('is not idempotent by design: a second delete is a 404', async () => {
      const created = await service.create(NEW_PRODUCT);
      await service.delete(created.id);
      await expect(service.delete(created.id)).rejects.toBeInstanceOf(ProductNotFoundError);
    });
  });

  describe('list', () => {
    const baseQuery = {
      filter: {},
      sort: { field: 'createdAt', direction: 'asc' } as const,
      limit: 10,
    };

    beforeEach(async () => {
      const rows: ReadonlyArray<Partial<NewProduct>> = [
        { sku: 'BEV-A', name: 'Cola', category: 'beverage', priceMinor: 10_000, stock: 5 },
        { sku: 'BEV-B', name: 'Tea', category: 'beverage', priceMinor: 20_000, stock: 0 },
        { sku: 'SNK-C', name: 'Chips', category: 'snack', priceMinor: 20_000, stock: 3, isActive: false },
        { sku: 'SNK-D', name: 'Nuts', category: 'snack', priceMinor: 30_000, stock: 7 },
      ];
      for (const row of rows) {
        await service.create({ ...NEW_PRODUCT, ...row });
      }
    });

    it('returns everything when no filter is given', async () => {
      expect((await service.list(baseQuery)).items).toHaveLength(4);
    });

    it.each([
      ['category', { category: 'beverage' as const }, 2],
      ['isActive=false', { isActive: false }, 1],
      ['inStock=false', { inStock: false }, 1],
      ['inStock=true', { inStock: true }, 3],
      ['price range', { minPriceMinor: 20_000, maxPriceMinor: 30_000 }, 3],
      ['search', { q: 'co' }, 1],
    ])('filters by %s', async (_label, filter, expected) => {
      expect((await service.list({ ...baseQuery, filter })).items).toHaveLength(expected);
    });

    it('combines filters with AND', async () => {
      const page = await service.list({
        ...baseQuery,
        filter: { category: 'snack', inStock: true },
      });
      expect(page.items).toHaveLength(2);
    });

    it('paginates without repeating or skipping rows', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page: { items: readonly { id: string }[]; nextCursor: string | null } =
          await service.list({ ...baseQuery, limit: 2, ...(cursor !== undefined && { cursor }) });
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    });

    it('breaks ties on non-unique sort values deterministically', async () => {
      // Two products share priceMinor 20,000. Without the id tie-break the page
      // boundary between them is ambiguous.
      const sort = { field: 'priceMinor', direction: 'asc' } as const;
      const first = await service.list({ ...baseQuery, sort, limit: 2 });
      const second = await service.list({
        ...baseQuery,
        sort,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      const ids = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('returns a null cursor on the last page', async () => {
      expect((await service.list({ ...baseQuery, limit: 100 })).nextCursor).toBeNull();
    });
  });
});
