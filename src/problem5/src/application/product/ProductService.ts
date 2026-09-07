import type {
  ListProductsQuery,
  Page,
  ProductRepository,
} from '../../domain/product/ProductRepository';
import type { NewProduct, Product, ProductPatch } from '../../domain/product/Product';
import { ProductNotFoundError } from '../../shared/errors';

/**
 * Use cases for the product resource.
 *
 * Thin on purpose. The brief asks for a CRUD interface, and inventing business
 * rules that nobody specified - approval workflows, price-change auditing,
 * reservation semantics - would be scope invented to look impressive. What this
 * layer legitimately owns is the orchestration the HTTP layer must not: which
 * repository calls happen, in what order, and what "not found" means.
 *
 * It depends on the `ProductRepository` interface, never on TypeORM. That is
 * what lets every test in `tests/unit` run against an in-memory repository with
 * no database at all, in milliseconds.
 */
export class ProductService {
  public constructor(private readonly repository: ProductRepository) {}

  public async create(input: NewProduct): Promise<Product> {
    // Uniqueness of the SKU is enforced by the database, not by a prior SELECT.
    // "Check then insert" is a race: under concurrency both requests pass the
    // check and one still violates the constraint. See SkuAlreadyExistsError.
    return this.repository.create(input);
  }

  public async list(query: ListProductsQuery): Promise<Page<Product>> {
    return this.repository.list(query);
  }

  /** @throws {ProductNotFoundError} */
  public async getById(id: string): Promise<Product> {
    const product = await this.repository.findById(id);
    if (product === null) {
      throw new ProductNotFoundError(id);
    }
    return product;
  }

  /**
   * @param expectedVersion From the caller's `If-Match` header. When present,
   *        the write is rejected if another request modified the row first.
   * @throws {ProductNotFoundError}
   * @throws {import('../../shared/errors').VersionConflictError}
   */
  public async update(
    id: string,
    patch: ProductPatch,
    expectedVersion?: number,
  ): Promise<Product> {
    return this.repository.update(id, patch, expectedVersion);
  }

  /** @throws {ProductNotFoundError} */
  public async delete(id: string): Promise<void> {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      // DELETE is idempotent at the protocol level, but returning 204 for an id
      // that never existed hides client bugs - a typo'd id looks like success
      // forever. 404 tells the caller something is wrong; a client that wants
      // idempotency can treat 404 as success itself.
      throw new ProductNotFoundError(id);
    }
  }
}
