import type { NewProduct, Product, ProductPatch } from '../../src/domain/product/Product';
import type {
  ListProductsQuery,
  Page,
  ProductRepository,
} from '../../src/domain/product/ProductRepository';
import {
  ProductNotFoundError,
  SkuAlreadyExistsError,
  VersionConflictError,
} from '../../src/shared/errors';
import { decodeCursor, encodeCursor } from '../../src/shared/cursor';

/**
 * An in-memory `ProductRepository`.
 *
 * This is the payoff for defining the repository as an interface in the domain
 * layer: the service can be tested exhaustively with no database, no Docker and
 * no I/O, in milliseconds.
 *
 * It is a real implementation, not a mock. Mocks assert that a method was
 * called; this asserts that the *behaviour* is right - and because it obeys the
 * same contract, a test that passes here and fails against Postgres points at a
 * genuine difference rather than at a stale stub.
 */
export class InMemoryProductRepository implements ProductRepository {
  private readonly rows = new Map<string, Product>();
  private sequence = 0;

  public constructor(private readonly now: () => Date = () => new Date()) {}

  public async create(input: NewProduct): Promise<Product> {
    for (const existing of this.rows.values()) {
      if (existing.sku === input.sku) {
        throw new SkuAlreadyExistsError(input.sku);
      }
    }
    this.sequence += 1;
    const timestamp = this.now();
    const product: Product = {
      // Deterministic ids keep failure output readable and diffable.
      id: `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`,
      ...input,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.rows.set(product.id, product);
    return product;
  }

  public async findById(id: string): Promise<Product | null> {
    return this.rows.get(id) ?? null;
  }

  public async list(query: ListProductsQuery): Promise<Page<Product>> {
    const { filter, sort } = query;
    let items = [...this.rows.values()].filter((product) => {
      if (filter.category !== undefined && product.category !== filter.category) return false;
      if (filter.currency !== undefined && product.currency !== filter.currency) return false;
      if (filter.minPriceMinor !== undefined && product.priceMinor < filter.minPriceMinor) return false;
      if (filter.maxPriceMinor !== undefined && product.priceMinor > filter.maxPriceMinor) return false;
      if (filter.inStock !== undefined && filter.inStock !== product.stock > 0) return false;
      if (filter.isActive !== undefined && product.isActive !== filter.isActive) return false;
      if (filter.q !== undefined) {
        const needle = filter.q.toLowerCase();
        if (!product.name.toLowerCase().includes(needle) && !product.sku.toLowerCase().includes(needle)) {
          return false;
        }
      }
      return true;
    });

    const valueOf = (product: Product): string | number =>
      sort.field === 'createdAt'
        ? product.createdAt.toISOString()
        : sort.field === 'priceMinor'
          ? product.priceMinor
          : product.name;

    // Same total ordering as the SQL implementation: sort field, then id.
    items.sort((a, b) => {
      const left = valueOf(a);
      const right = valueOf(b);
      const primary = left < right ? -1 : left > right ? 1 : 0;
      const comparison = primary !== 0 ? primary : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return sort.direction === 'asc' ? comparison : -comparison;
    });

    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor, sort);
      const after = (product: Product): boolean => {
        const value = valueOf(product);
        if (value !== cursor.v) {
          return sort.direction === 'asc' ? value > cursor.v : value < cursor.v;
        }
        return sort.direction === 'asc' ? product.id > cursor.i : product.id < cursor.i;
      };
      items = items.filter(after);
    }

    const hasMore = items.length > query.limit;
    const page = items.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
      items: page,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ f: sort.field, d: sort.direction, v: valueOf(last), i: last.id })
          : null,
    };
  }

  public async update(
    id: string,
    patch: ProductPatch,
    expectedVersion?: number,
  ): Promise<Product> {
    const existing = this.rows.get(id);
    if (existing === undefined) {
      throw new ProductNotFoundError(id);
    }
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new VersionConflictError(id, expectedVersion, existing.version);
    }
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const updated: Product = {
      ...existing,
      ...changes,
      version: existing.version + 1,
      updatedAt: this.now(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  public async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  /** Test helper: current row count. */
  public size(): number {
    return this.rows.size;
  }
}
