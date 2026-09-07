import {
  QueryFailedError,
  type DataSource,
  type Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import type { NewProduct, Product, ProductPatch } from '../../domain/product/Product';
import type {
  ListProductsQuery,
  Page,
  ProductFilter,
  ProductRepository,
} from '../../domain/product/ProductRepository';
import type { SortableField } from '../../domain/product/constraints';
import {
  ProductNotFoundError,
  SkuAlreadyExistsError,
  VersionConflictError,
} from '../../shared/errors';
import { decodeCursor, encodeCursor } from '../../shared/cursor';
import { ProductOrmEntity } from './ProductOrmEntity';
import { bigintToSafeNumber } from './transformers';

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * How each sortable field maps to SQL.
 *
 * The explicit cast matters: the keyset comparison binds the cursor value as a
 * parameter, and PostgreSQL cannot infer the type of a bare placeholder inside
 * a row-value comparison. Without the cast it errors with
 * "could not determine data type of parameter".
 */
const SORT_COLUMNS: Record<SortableField, { column: string; cast: string; property: string }> = {
  createdAt: { column: '"p"."created_at"', cast: 'timestamptz', property: 'p.createdAt' },
  priceMinor: { column: '"p"."price_minor"', cast: 'bigint', property: 'p.priceMinor' },
  name: { column: '"p"."name"', cast: 'varchar', property: 'p.name' },
};

/**
 * Escapes the LIKE metacharacters in a user-supplied search term.
 *
 * Without this, `?q=%` matches every row in the table - the filter silently
 * becomes "return everything", which is both a wrong result and the cheapest
 * possible way to make the database do the most possible work. `_` is the
 * single-character wildcard and is escaped for the same reason.
 */
function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function toDomain(entity: ProductOrmEntity): Product {
  return {
    id: entity.id,
    sku: entity.sku,
    name: entity.name,
    description: entity.description,
    category: entity.category,
    priceMinor: entity.priceMinor,
    currency: entity.currency,
    stock: entity.stock,
    isActive: entity.isActive,
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

/**
 * Shape of a row returned by `RETURNING *`.
 *
 * Raw rows bypass the entity metadata entirely: column names arrive snake_case,
 * and - critically - `price_minor` arrives as a **string**, because the `pg`
 * driver returns int8 that way and the entity's value transformer is never
 * applied to raw results. Mapping it by hand is what keeps a price from
 * silently becoming a string that then concatenates instead of adding.
 */
interface RawProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  price_minor: string | number;
  currency: string;
  stock: number;
  is_active: boolean;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function fromRawRow(row: RawProductRow): Product {
  const priceMinor = bigintToSafeNumber.from(row.price_minor) as number;
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category as Product['category'],
    priceMinor,
    currency: row.currency as Product['currency'],
    stock: row.stock,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === PG_UNIQUE_VIOLATION
  );
}

/**
 * TypeORM-backed implementation of {@link ProductRepository}.
 *
 * This is the only file in the codebase that knows TypeORM exists. Everything
 * above it depends on the interface, which is what makes the service layer
 * testable without a database and makes replacing the ORM a one-file change.
 */
export class TypeOrmProductRepository implements ProductRepository {
  private readonly repository: Repository<ProductOrmEntity>;

  public constructor(dataSource: DataSource) {
    this.repository = dataSource.getRepository(ProductOrmEntity);
  }

  public async create(input: NewProduct): Promise<Product> {
    const entity = this.repository.create({
      sku: input.sku,
      name: input.name,
      description: input.description,
      category: input.category,
      priceMinor: input.priceMinor,
      currency: input.currency,
      stock: input.stock,
      isActive: input.isActive,
    });

    try {
      return toDomain(await this.repository.save(entity));
    } catch (error) {
      // Uniqueness is decided by the database, never by a prior SELECT: two
      // concurrent creates would both pass a check-then-insert and one would
      // still fail here. Catching the constraint violation is the only
      // race-free way to report it.
      if (isUniqueViolation(error)) {
        throw new SkuAlreadyExistsError(input.sku);
      }
      throw error;
    }
  }

  public async findById(id: string): Promise<Product | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity === null ? null : toDomain(entity);
  }

  public async list(query: ListProductsQuery): Promise<Page<Product>> {
    const sort = SORT_COLUMNS[query.sort.field];
    const builder = this.repository.createQueryBuilder('p');

    this.applyFilters(builder, query.filter);

    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor, query.sort);
      // Row-value comparison. `(a, b) > (x, y)` is lexicographic and maps
      // directly onto the composite index on (sortField, id), so this is an
      // index seek rather than a scan-and-discard.
      const operator = query.sort.direction === 'asc' ? '>' : '<';
      builder.andWhere(
        `(${sort.column}, "p"."id") ${operator} (:cursorValue::${sort.cast}, :cursorId::uuid)`,
        { cursorValue: cursor.v, cursorId: cursor.i },
      );
    }

    const direction = query.sort.direction === 'asc' ? 'ASC' : 'DESC';
    builder
      .orderBy(sort.property, direction)
      // The id tie-break is not optional. Prices and timestamps are not unique,
      // and without a total ordering the page boundary is ambiguous: rows with
      // equal sort values get repeated on one page and skipped on the next.
      .addOrderBy('p.id', direction)
      // One extra row is the cheapest possible "is there a next page" probe.
      // The alternative - a COUNT(*) over the filtered set - costs a second
      // full scan to answer a question the caller did not ask.
      .take(query.limit + 1);

    const rows = await builder.getMany();
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toDomain),
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({
              f: query.sort.field,
              d: query.sort.direction,
              v: this.sortValueOf(last, query.sort.field),
              i: last.id,
            })
          : null,
    };
  }

  public async update(
    id: string,
    patch: ProductPatch,
    expectedVersion?: number,
  ): Promise<Product> {
    // Only keys the caller actually supplied are applied. `Object.assign`-style
    // copying would treat a key whose value is `undefined` exactly like a real
    // one and blank the column, so a PATCH touching one field could quietly
    // wipe six others. `null` is preserved deliberately: for `description` it
    // means "clear this", which is different from "leave it alone".
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Record<string, unknown>;

    /*
     * Optimistic concurrency, enforced in a single statement:
     *
     *   UPDATE products SET ..., version = version + 1, updated_at = now()
     *   WHERE id = $1 AND version = $2
     *
     * The `AND version = $2` predicate is the entire guarantee. If another
     * transaction committed first, the row no longer matches, zero rows are
     * updated, and the caller is told - instead of its write silently
     * overwriting work it never saw.
     *
     * ## Why this is not done with `repository.save()`
     *
     * Because `save()` does not do it. TypeORM's `@VersionColumn` increments
     * the version but adds **no** version predicate to the UPDATE. The emitted
     * SQL is:
     *
     *   UPDATE "products" SET "stock" = $1, "version" = "version" + 1,
     *          "updated_at" = CURRENT_TIMESTAMP
     *   WHERE "id" IN ($2) RETURNING "version", "updated_at"
     *
     * That was verified by reading the query log, not assumed from the
     * documentation - and then confirmed by firing ten concurrent PATCHes with
     * the same `If-Match`: with `save()` all ten returned 200, meaning nine
     * lost updates. A read-then-compare check in application code does not fix
     * it either; it only narrows the window, because every concurrent request
     * can read the same version before any of them writes.
     *
     * `findOne({ lock: { mode: 'optimistic', version } })` is TypeORM's other
     * offering, but it validates at *read* time and so leaves the same
     * read-to-write window open. One conditional statement closes it entirely.
     */
    const builder = this.repository
      .createQueryBuilder()
      .update(ProductOrmEntity)
      .set({
        ...changes,
        // Set explicitly: outside `save()`, neither @VersionColumn nor
        // @UpdateDateColumn is applied automatically.
        version: () => '"version" + 1',
        updatedAt: () => 'CURRENT_TIMESTAMP',
      })
      .where('id = :id', { id })
      .returning('*');

    if (expectedVersion !== undefined) {
      builder.andWhere('version = :expectedVersion', { expectedVersion });
    }

    // No unique-violation handling here, deliberately: `ProductPatch` has no
    // `sku` field, so an update cannot collide with the only unique index on
    // the table. Catching an impossible error would be unreachable code that
    // reads like a safeguard.
    const result = await builder.execute();

    if ((result.affected ?? 0) === 0) {
      // Zero rows matched. Two causes, and the caller needs to tell them apart:
      // the product is gone (404), or somebody else got there first (409).
      const current = await this.repository.findOne({ where: { id } });
      if (current === null) {
        throw new ProductNotFoundError(id);
      }
      throw new VersionConflictError(id, expectedVersion ?? current.version, current.version);
    }

    const row = (result.raw as unknown[])[0];
    /* istanbul ignore if -- `affected > 0` guarantees RETURNING produced a row;
       this guard exists only so a driver behaving unexpectedly surfaces as a
       typed 404 rather than a TypeError on undefined. */
    if (row === undefined) {
      throw new ProductNotFoundError(id);
    }
    return fromRawRow(row as RawProductRow);
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.repository.delete({ id });
    return (result.affected ?? 0) > 0;
  }

  private applyFilters(
    builder: SelectQueryBuilder<ProductOrmEntity>,
    filter: ProductFilter,
  ): void {
    if (filter.category !== undefined) {
      builder.andWhere('p.category = :category', { category: filter.category });
    }
    if (filter.currency !== undefined) {
      builder.andWhere('p.currency = :currency', { currency: filter.currency });
    }
    if (filter.minPriceMinor !== undefined) {
      builder.andWhere('p.priceMinor >= :minPrice', { minPrice: filter.minPriceMinor });
    }
    if (filter.maxPriceMinor !== undefined) {
      builder.andWhere('p.priceMinor <= :maxPrice', { maxPrice: filter.maxPriceMinor });
    }
    if (filter.inStock !== undefined) {
      builder.andWhere(filter.inStock ? 'p.stock > 0' : 'p.stock = 0');
    }
    if (filter.isActive !== undefined) {
      builder.andWhere('p.isActive = :isActive', { isActive: filter.isActive });
    }
    if (filter.q !== undefined) {
      // Bound parameters throughout - the search term is never concatenated
      // into SQL. ESCAPE '\' pairs with escapeLikePattern so a term containing
      // `%` matches a literal percent sign instead of everything.
      builder.andWhere(
        `("p"."name" ILIKE :searchTerm ESCAPE '\\' OR "p"."sku" ILIKE :searchTerm ESCAPE '\\')`,
        { searchTerm: `%${escapeLikePattern(filter.q)}%` },
      );
    }
  }

  private sortValueOf(entity: ProductOrmEntity, field: SortableField): string | number {
    switch (field) {
      case 'createdAt':
        return entity.createdAt.toISOString();
      case 'priceMinor':
        return entity.priceMinor;
      case 'name':
        return entity.name;
    }
  }
}
