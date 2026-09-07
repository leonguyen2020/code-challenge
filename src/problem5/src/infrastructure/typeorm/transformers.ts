import type { ValueTransformer } from 'typeorm';

/**
 * Converts PostgreSQL `bigint` (int8) between its wire form and a JavaScript
 * number.
 *
 * ## Why this exists
 *
 * The `pg` driver returns `bigint` columns as **strings**, not numbers. It is
 * right to: int8 spans +/-9.2e18 while a double is only exact to 9.007e15, so
 * silently converting would corrupt large values. But it means an unguarded
 * entity field typed `number` actually holds `"1500"` at runtime, and:
 *
 *     product.priceMinor * quantity   // "1500" * 2  -> 3000   (works by luck)
 *     product.priceMinor + 100        // "1500" + 100 -> "1500100"  (silently wrong)
 *
 * That is a money bug that passes every type check, because TypeScript believes
 * the field is a number. This transformer converts explicitly and **asserts**
 * the value is inside the exactly representable range, so the failure mode is a
 * loud error rather than a quietly wrong price.
 *
 * `PRICE_MINOR_MAX` is set well below `Number.MAX_SAFE_INTEGER`, so the throw is
 * unreachable through the API. It guards against data written by some other
 * client - a migration, a script, a future service - which is precisely when
 * silent corruption would otherwise go unnoticed.
 */
export const bigintToSafeNumber: ValueTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,

  from: (value: string | number | null): number | null => {
    if (value === null) {
      return null;
    }
    const asNumber = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new Error(
        `Database returned a bigint outside the exactly representable range ` +
          `(${String(value)}). Reading it as a number would silently lose precision.`,
      );
    }
    return asNumber;
  },
};
