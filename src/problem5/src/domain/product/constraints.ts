/**
 * Business constraints, declared once.
 *
 * These are imported by both the HTTP validation schemas and the domain entity.
 * Declaring them twice is how a service ends up accepting a 300-character name
 * at the edge and then failing on a `varchar(200)` at the database - a 500
 * where a 400 belonged.
 */

export const PRODUCT_CATEGORIES = [
  'beverage',
  'snack',
  'household',
  'personal_care',
  'electronics',
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const SUPPORTED_CURRENCIES = ['VND', 'USD', 'EUR', 'JPY'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Stock Keeping Unit. Upper-case alphanumerics and hyphens, so it is safe in a
 * URL, unambiguous when read aloud, and case-insensitively unique without
 * needing a functional index.
 */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const SKU_MIN_LENGTH = 3;
export const SKU_MAX_LENGTH = 32;

export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2_000;

/**
 * Prices are stored as integers in the currency's **minor unit** (cents for
 * USD, dong for VND, which has no minor unit at all).
 *
 * Never a float. `0.1 + 0.2 !== 0.3` in IEEE-754, and money that does not add
 * up is the fastest way to lose trust in a system. Integers in the minor unit
 * are exact, and the minor-unit exponent is a presentation concern that belongs
 * in the client's formatter, not in the database.
 *
 * The ceiling keeps `priceMinor * stock` - the obvious next query someone
 * writes - inside `Number.MAX_SAFE_INTEGER`.
 */
export const PRICE_MINOR_MIN = 0;
export const PRICE_MINOR_MAX = 1_000_000_000_000; // 1e12

export const STOCK_MIN = 0;
export const STOCK_MAX = 1_000_000_000; // 1e9

export const LIST_LIMIT_MIN = 1;
export const LIST_LIMIT_MAX = 100;
export const LIST_LIMIT_DEFAULT = 20;

/**
 * Upper bound on an inbound pagination cursor.
 *
 * A cursor this service issues is base64url of `{f, d, v, i}`, where the
 * largest `v` is a product name of {@link NAME_MAX_LENGTH} characters - about
 * 340 bytes encoded. 512 leaves generous headroom and still refuses a caller
 * who sends a megabyte of base64 for the server to decode and JSON-parse.
 *
 * Every other string in the query is bounded; this one being unbounded was an
 * omission rather than a decision.
 */
export const CURSOR_MAX_LENGTH = 512;

/** Fields the list endpoint may be sorted by. Anything else is rejected. */
export const SORTABLE_FIELDS = ['createdAt', 'priceMinor', 'name'] as const;
export type SortableField = (typeof SORTABLE_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

/**
 * Free-text search term bounds. Caps the work a single query can request.
 *
 * The minimum is **3, not 2, and that is a performance decision rather than a
 * usability one.** `q` is matched with `ILIKE '%term%'`, which a B-tree cannot
 * serve because of the leading wildcard - the GIN trigram indexes
 * (`IDX_products_name_trgm`, `IDX_products_sku_trgm`) exist for exactly that.
 * But a trigram is three characters: PostgreSQL can extract none at all from a
 * two-character pattern wrapped in wildcards, so `?q=ab` silently degenerates
 * to a sequential scan of the whole table - the very thing the indexes were
 * added to prevent, and the cheapest way for a caller to make the database do
 * the most work.
 *
 * Three characters is the shortest term the index can actually accelerate.
 */
export const SEARCH_TERM_MIN_LENGTH = 3;
export const SEARCH_TERM_MAX_LENGTH = 100;
