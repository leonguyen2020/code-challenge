import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import type { Currency, ProductCategory } from '../../domain/product/constraints';
import {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  SKU_MAX_LENGTH,
} from '../../domain/product/constraints';
import { bigintToSafeNumber } from './transformers';

/**
 * The persistence shape of a product.
 *
 * Deliberately a *separate type* from the domain `Product`, not the same class
 * decorated. The two answer different questions - "what is a product" versus
 * "how is a product stored" - and merging them means every column rename ripples
 * into business logic, and every decorator leaks TypeORM into the domain.
 *
 * Column names are snake_case because that is PostgreSQL's convention and
 * unquoted identifiers fold to lower case anyway; property names stay camelCase
 * because that is TypeScript's. The mapping is declared once, here.
 */
@Entity({ name: 'products' })
export class ProductOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  public id!: string;

  @Column({ type: 'varchar', length: SKU_MAX_LENGTH, unique: true })
  public sku!: string;

  @Column({ type: 'varchar', length: NAME_MAX_LENGTH })
  public name!: string;

  @Column({ type: 'varchar', length: DESCRIPTION_MAX_LENGTH, nullable: true })
  public description!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 32 })
  public category!: ProductCategory;

  /**
   * Price in the currency's minor unit.
   *
   * `bigint` rather than `integer` because int4 tops out at 2,147,483,647 -
   * about 2.1 billion dong, which a genuine inventory would exceed. See
   * `transformers.ts` for why a transformer is mandatory here rather than
   * optional polish.
   */
  @Column({
    name: 'price_minor',
    type: 'bigint',
    transformer: bigintToSafeNumber,
  })
  public priceMinor!: number;

  @Column({ type: 'char', length: 3 })
  public currency!: Currency;

  @Column({ type: 'integer' })
  public stock!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  public isActive!: boolean;

  /**
   * Row version, incremented on every update.
   *
   * IMPORTANT - `@VersionColumn` does **not** give optimistic locking on its
   * own. It makes TypeORM increment the column, but `save()` emits
   * `WHERE "id" IN ($1)` with no version predicate, so concurrent writers all
   * succeed and all but one update is lost. That was verified from the query
   * log and reproduced with ten concurrent requests.
   *
   * The guarantee lives in `TypeOrmProductRepository.update()`, which issues a
   * single `UPDATE ... WHERE id = $1 AND version = $2`. This decorator is kept
   * because it declares the column and keeps `save()` consistent for any code
   * path that uses it.
   */
  @VersionColumn()
  public version!: number;

  /**
   * Millisecond precision, deliberately.
   *
   * The PostgreSQL default is microseconds, which a JavaScript `Date` cannot
   * represent - so a keyset cursor built from this value is strictly smaller
   * than the row it identifies, and that row is returned twice. See the
   * migration for the reproduction.
   */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  public createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', precision: 3 })
  public updatedAt!: Date;
}
