import type { Currency, ProductCategory } from './constraints';

/**
 * A product in the inventory.
 *
 * Modelled as an immutable, plain data structure rather than a class with
 * behaviour. The reason is honesty about what this service does: it is a CRUD
 * API, and the only rules that exist are field-level invariants already
 * enforced by validation and by database constraints. Wrapping that in a rich
 * domain object with anaemic methods would be ceremony, not design.
 *
 * What the type *does* buy is a boundary: nothing in `domain/` or
 * `application/` knows that TypeORM exists. `Product` is what the service layer
 * speaks; the ORM entity is an infrastructure detail that gets mapped to it.
 */
export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: ProductCategory;
  /** Integer, in the currency's minor unit. Never a float - see constraints.ts. */
  readonly priceMinor: number;
  readonly currency: Currency;
  readonly stock: number;
  readonly isActive: boolean;
  /**
   * Incremented by the database on every update. The client echoes it back in
   * `If-Match` so a stale write is rejected rather than silently applied.
   */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Fields accepted when creating a product. */
export interface NewProduct {
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: ProductCategory;
  readonly priceMinor: number;
  readonly currency: Currency;
  readonly stock: number;
  readonly isActive: boolean;
}

/**
 * Fields that may be changed.
 *
 * Each property is `| undefined` as well as optional because
 * `exactOptionalPropertyTypes` is on: a parsed PATCH body legitimately contains
 * explicit `undefined` for fields the client omitted, and without this the
 * compiler rejects the assignment.
 *
 * `sku` is deliberately absent. A SKU identifies a product to warehouses,
 * suppliers and printed labels; letting it change through a generic PATCH would
 * silently invalidate every external reference. Re-keying an item is a distinct
 * operation with its own consequences, not a field update.
 */
export interface ProductPatch {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly category?: ProductCategory | undefined;
  readonly priceMinor?: number | undefined;
  readonly currency?: Currency | undefined;
  readonly stock?: number | undefined;
  readonly isActive?: boolean | undefined;
}
