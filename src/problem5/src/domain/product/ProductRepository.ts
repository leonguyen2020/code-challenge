import type { NewProduct, Product, ProductPatch } from './Product';
import type {
  Currency,
  ProductCategory,
  SortDirection,
  SortableField,
} from './constraints';

/**
 * Filters accepted by the list endpoint.
 *
 * Every property is explicitly `| undefined` rather than merely optional,
 * because `exactOptionalPropertyTypes` is on: with that flag, `{ category:
 * undefined }` is not assignable to `{ category?: ProductCategory }`, and query
 * parsing naturally produces exactly that shape.
 */
export interface ProductFilter {
  readonly category?: ProductCategory | undefined;
  readonly currency?: Currency | undefined;
  readonly minPriceMinor?: number | undefined;
  readonly maxPriceMinor?: number | undefined;
  /** `true` restricts to `stock > 0`; `false` to `stock = 0`. */
  readonly inStock?: boolean | undefined;
  readonly isActive?: boolean | undefined;
  /** Free-text search across name and SKU. */
  readonly q?: string | undefined;
}

export interface ProductSort {
  readonly field: SortableField;
  readonly direction: SortDirection;
}

export interface ListProductsQuery {
  readonly filter: ProductFilter;
  readonly sort: ProductSort;
  readonly limit: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  readonly cursor?: string | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** `null` when this is the last page. */
  readonly nextCursor: string | null;
}

/**
 * Persistence boundary for products.
 *
 * The interface lives in `domain/` and names no technology. `application/`
 * depends on this; `infrastructure/typeorm/` implements it. That is the
 * Dependency Inversion Principle applied where it actually pays: the service
 * layer is testable against an in-memory implementation with no database, and
 * replacing TypeORM means writing one new class rather than editing the whole
 * codebase.
 */
export interface ProductRepository {
  /**
   * @throws {import('../../shared/errors').SkuAlreadyExistsError} if the SKU is taken.
   */
  create(input: NewProduct): Promise<Product>;

  findById(id: string): Promise<Product | null>;

  /**
   * @throws {import('../../shared/errors').InvalidCursorError} if the cursor is malformed.
   */
  list(query: ListProductsQuery): Promise<Page<Product>>;

  /**
   * Applies a partial update under optimistic concurrency control.
   *
   * @param expectedVersion When supplied, the update is applied only if the
   *        stored version still matches. This is what makes a lost update
   *        impossible rather than merely unlikely.
   * @throws {import('../../shared/errors').ProductNotFoundError}
   * @throws {import('../../shared/errors').VersionConflictError}
   */
  update(id: string, patch: ProductPatch, expectedVersion?: number): Promise<Product>;

  /** @returns `true` if a row was deleted, `false` if none matched. */
  delete(id: string): Promise<boolean>;
}
