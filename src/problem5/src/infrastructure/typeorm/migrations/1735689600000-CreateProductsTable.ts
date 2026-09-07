import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the products table and its indexes.
 *
 * ## Why the timestamps are `timestamptz(3)`
 *
 * PostgreSQL's default `timestamptz` stores **microseconds**; a JavaScript
 * `Date` holds **milliseconds**. A row written at 09:30:15.123456 is therefore
 * read back as 09:30:15.123, and any value derived from it - such as a keyset
 * pagination cursor - is *smaller than the row it came from*:
 *
 *   SELECT '...15.123Z'::timestamptz < '...15.123456Z'::timestamptz;  -- true
 *
 * The seek `WHERE (created_at, id) > (cursor, id)` then matches the boundary
 * row again, so it appears on two consecutive pages. That was reproduced by an
 * integration test before this was changed.
 *
 * Truncating the column to millisecond precision makes the stored value exactly
 * representable in the language that reads it. The alternative - carrying
 * microseconds through the cursor as a string - keeps a precision the
 * application can never actually handle, and every future consumer of the
 * timestamp inherits the same trap.
 *
 * Written by hand rather than generated. `typeorm migration:generate` produces
 * a diff of the entity metadata, which is fine for columns but cannot express
 * partial indexes, GIN/trigram indexes, or CHECK constraints - exactly the parts
 * that matter for correctness and for query performance. Generated migrations
 * also tend to arrive with incidental noise that nobody reads before applying.
 */
export class CreateProductsTable1735689600000 implements MigrationInterface {
  public name = 'CreateProductsTable1735689600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "products" (
        "id"          uuid         NOT NULL DEFAULT gen_random_uuid(),
        "sku"         varchar(32)  NOT NULL,
        "name"        varchar(200) NOT NULL,
        "description" varchar(2000),
        "category"    varchar(32)  NOT NULL,
        "price_minor" bigint       NOT NULL,
        "currency"    char(3)      NOT NULL,
        "stock"       integer      NOT NULL,
        "is_active"   boolean      NOT NULL DEFAULT true,
        "version"     integer      NOT NULL DEFAULT 1,
        -- timestamptz(3), not the default microsecond precision. See the note
        -- below: a column more precise than the language can represent is a
        -- pagination bug waiting to happen.
        "created_at"  timestamptz(3) NOT NULL DEFAULT now(),
        "updated_at"  timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "PK_products" PRIMARY KEY ("id")
      )
    `);

    /*
     * Invariants enforced by the database, not only by the application.
     *
     * Validation at the edge protects against bad requests; a CHECK constraint
     * protects against every other path into the table - a migration, a repair
     * script, a psql session at 3am, a future service. Application-only
     * validation is a convention; a constraint is a guarantee.
     */
    await queryRunner.query(`
      ALTER TABLE "products"
        ADD CONSTRAINT "CHK_products_price_non_negative" CHECK ("price_minor" >= 0),
        ADD CONSTRAINT "CHK_products_price_ceiling"      CHECK ("price_minor" <= 1000000000000),
        ADD CONSTRAINT "CHK_products_stock_non_negative" CHECK ("stock" >= 0),
        ADD CONSTRAINT "CHK_products_stock_ceiling"      CHECK ("stock" <= 1000000000),
        ADD CONSTRAINT "CHK_products_name_not_blank"     CHECK (length(btrim("name")) > 0),
        ADD CONSTRAINT "CHK_products_sku_format"         CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
        ADD CONSTRAINT "CHK_products_currency_format"    CHECK ("currency" ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT "CHK_products_category_known"
          CHECK ("category" IN ('beverage','snack','household','personal_care','electronics'))
    `);

    // The SKU is the business key. Uniqueness is enforced here so that
    // concurrent inserts cannot both succeed - a prior SELECT could never
    // guarantee that.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_products_sku" ON "products" ("sku")`,
    );

    /*
     * Keyset-pagination indexes.
     *
     * Every list query orders by (sortField, id) - the id is the tie-breaker
     * that makes the ordering total - and seeks with a row-value comparison on
     * the same pair. A composite index on exactly that pair turns the seek into
     * an index range scan, so page 500 costs the same as page 1.
     *
     * One index per sortable field is deliberate: a composite index only serves
     * an ORDER BY whose leading column matches.
     */
    await queryRunner.query(
      `CREATE INDEX "IDX_products_created_at_id" ON "products" ("created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_price_minor_id" ON "products" ("price_minor", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_name_id" ON "products" ("name", "id")`,
    );

    // Category is the most selective of the equality filters, and is very
    // commonly combined with the default ordering.
    await queryRunner.query(
      `CREATE INDEX "IDX_products_category_created_at" ON "products" ("category", "created_at", "id")`,
    );

    /*
     * Partial index for the common "what can I actually sell" query.
     *
     * Partial rather than full because the predicate is highly selective and
     * stable: the index only contains sellable rows, so it is smaller, stays in
     * cache, and does not need updating when an archived product changes.
     */
    await queryRunner.query(`
      CREATE INDEX "IDX_products_sellable" ON "products" ("created_at", "id")
        WHERE "is_active" = true AND "stock" > 0
    `);

    /*
     * Trigram indexes for the free-text filter.
     *
     * `q` is matched with ILIKE '%term%'. A leading wildcard makes a B-tree
     * index useless - PostgreSQL has to scan every row. A GIN trigram index
     * supports the leading wildcard directly, turning a sequential scan into an
     * index scan. pg_trgm is created by the repository's Docker init script.
     */
    await queryRunner.query(
      `CREATE INDEX "IDX_products_name_trgm" ON "products" USING gin ("name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_sku_trgm" ON "products" USING gin ("sku" gin_trgm_ops)`,
    );
  }

  /**
   * Every migration is reversible. A migration that cannot be rolled back is a
   * one-way door in the middle of a deploy.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the table removes its indexes and constraints with it; the
    // explicit drops keep the intent readable and stay correct if the table
    // definition is later split across migrations.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_sku_trgm"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_name_trgm"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_sellable"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_category_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_name_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_price_minor_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_created_at_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_products_sku"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "products"`);
  }
}
