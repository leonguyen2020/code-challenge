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

/** Fields the list endpoint may be sorted by. Anything else is rejected. */
export const SORTABLE_FIELDS = ['createdAt', 'priceMinor', 'name'] as const;
export type SortableField = (typeof SORTABLE_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

/** Free-text search term bounds. Caps the work a single query can request. */
export const SEARCH_TERM_MIN_LENGTH = 2;
export const SEARCH_TERM_MAX_LENGTH = 100;
