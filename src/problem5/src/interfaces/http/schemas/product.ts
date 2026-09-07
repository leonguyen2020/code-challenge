import { z } from 'zod';
import {
  DESCRIPTION_MAX_LENGTH,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  PRICE_MINOR_MAX,
  PRICE_MINOR_MIN,
  PRODUCT_CATEGORIES,
  SEARCH_TERM_MAX_LENGTH,
  SEARCH_TERM_MIN_LENGTH,
  SKU_PATTERN,
  SORTABLE_FIELDS,
  STOCK_MAX,
  STOCK_MIN,
  SUPPORTED_CURRENCIES,
} from '../../../domain/product/constraints';

/**
 * Request schemas.
 *
 * Bounds are imported from `domain/product/constraints`, never retyped. A
 * literal `200` here and a `varchar(200)` in the migration will drift, and the
 * day they do the service returns 500 for input that should have been a clean
 * 400.
 */

/**
 * Boolean query parameters.
 *
 * `z.coerce.boolean()` is a trap: it applies JavaScript's `Boolean()`, and
 * `Boolean('false') === true`. Every `?isActive=false` would silently filter
 * for active products - a wrong answer with a 200 status. Query strings carry
 * text, so the accepted spellings are enumerated explicitly.
 */
const booleanQueryParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/**
 * Integer query parameters.
 *
 * `z.coerce.number()` accepts `''` as 0 and `'  12  '` as 12, so a missing
 * parameter sent as `?minPrice=` would become a real filter of `>= 0`. The
 * regex guard requires actual digits before coercion runs.
 */
const integerQueryParam = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform(Number);

/**
 * A name that is not merely present but meaningful.
 *
 * `"   "` passes `min(1)`. Trimming first means whitespace-only input is
 * rejected rather than stored as a blank-looking row that no search will ever
 * match. The trimmed value is what gets persisted.
 */
const productName = z
  .string()
  .trim()
  .min(NAME_MIN_LENGTH, 'must not be blank')
  .max(NAME_MAX_LENGTH, `must be at most ${NAME_MAX_LENGTH} characters`);

const sku = z
  .string()
  .trim()
  .regex(
    SKU_PATTERN,
    'must be 3-32 characters of upper-case letters, digits or hyphens, starting with a letter or digit',
  );

const priceMinor = z
  .number()
  .int('must be an integer number of minor currency units (e.g. cents), not a decimal')
  .min(PRICE_MINOR_MIN)
  .max(PRICE_MINOR_MAX);

const stock = z.number().int().min(STOCK_MIN).max(STOCK_MAX);

const description = z.string().trim().max(DESCRIPTION_MAX_LENGTH).nullable();

/**
 * `.strict()` rejects unknown keys instead of ignoring them.
 *
 * This is the mass-assignment defence. Without it, `{"name":"x","version":999,
 * "id":"..."}` is silently accepted, the extra keys are dropped, and the client
 * has no idea its request did not do what it asked. Worse, if the handler ever
 * spreads the body into an entity, those keys become writes to fields the API
 * never meant to expose.
 */
export const createProductSchema = z
  .object({
    sku,
    name: productName,
    description: description.default(null),
    category: z.enum(PRODUCT_CATEGORIES),
    priceMinor,
    currency: z.enum(SUPPORTED_CURRENCIES),
    stock,
    isActive: z.boolean().default(true),
  })
  .strict();

export type CreateProductBody = z.infer<typeof createProductSchema>;

/**
 * PATCH is a partial update, but an *empty* patch is rejected.
 *
 * `PATCH {}` is almost always a client bug - a field name typo, or state that
 * failed to serialise. Accepting it returns 200 and changes nothing, so the bug
 * survives. Rejecting it surfaces the mistake immediately.
 */
export const updateProductSchema = z
  .object({
    name: productName.optional(),
    description: description.optional(),
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    priceMinor: priceMinor.optional(),
    currency: z.enum(SUPPORTED_CURRENCIES).optional(),
    stock: stock.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field must be supplied',
  });

export type UpdateProductBody = z.infer<typeof updateProductSchema>;

/**
 * Path parameter.
 *
 * Validating the UUID shape here rather than letting it reach PostgreSQL is the
 * difference between a 400 and a 500: `SELECT ... WHERE id = 'not-a-uuid'`
 * raises SQLSTATE 22P02, which surfaces as an unhandled driver error.
 */
export const productIdParamSchema = z.object({
  id: z.string().uuid('must be a UUID'),
});

/**
 * `?sort=field:direction`, with the field whitelisted.
 *
 * A sort field taken from user input and interpolated into SQL is a classic
 * injection vector, because column names cannot be bound as parameters. The
 * enum makes the set of reachable columns finite and known at compile time.
 */
const sortParam = z
  .string()
  .transform((value, ctx) => {
    const [field, direction = 'asc'] = value.split(':');
    const fieldResult = z.enum(SORTABLE_FIELDS).safeParse(field);
    const directionResult = z.enum(['asc', 'desc']).safeParse(direction);

    if (!fieldResult.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must sort by one of: ${SORTABLE_FIELDS.join(', ')}`,
      });
      return z.NEVER;
    }
    if (!directionResult.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'direction must be "asc" or "desc"',
      });
      return z.NEVER;
    }
    return { field: fieldResult.data, direction: directionResult.data };
  });

export const listProductsQuerySchema = z
  .object({
    category: z.enum(PRODUCT_CATEGORIES).optional(),
    currency: z.enum(SUPPORTED_CURRENCIES).optional(),
    minPrice: integerQueryParam.optional(),
    maxPrice: integerQueryParam.optional(),
    inStock: booleanQueryParam.optional(),
    isActive: booleanQueryParam.optional(),
    q: z.string().trim().min(SEARCH_TERM_MIN_LENGTH).max(SEARCH_TERM_MAX_LENGTH).optional(),
    sort: sortParam.optional(),
    limit: integerQueryParam
      .refine((value) => value >= LIST_LIMIT_MIN && value <= LIST_LIMIT_MAX, {
        message: `must be between ${LIST_LIMIT_MIN} and ${LIST_LIMIT_MAX}`,
      })
      .optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict()
  // An inverted price range returns an empty page and looks like "no results"
  // rather than "you asked for something impossible". Catching it here turns a
  // silent surprise into an explicit 400.
  .refine(
    (query) =>
      query.minPrice === undefined ||
      query.maxPrice === undefined ||
      query.minPrice <= query.maxPrice,
    { message: 'minPrice must not be greater than maxPrice', path: ['minPrice'] },
  );

export type ListProductsQueryInput = z.infer<typeof listProductsQuerySchema>;

export const DEFAULT_LIST_LIMIT = LIST_LIMIT_DEFAULT;

/**
 * `If-Match` carries the version the client last read.
 *
 * Modelled on the HTTP entity-tag mechanism. Supplying it is what turns a
 * blind overwrite into a checked one; omitting it is allowed and means
 * last-write-wins, which is documented rather than accidental.
 */
export const ifMatchHeaderSchema = z
  .string()
  .regex(/^(?:W\/)?"?(\d+)"?$/, 'must be a version number, optionally quoted')
  .transform((value) => Number(/(\d+)/.exec(value)?.[1]));
