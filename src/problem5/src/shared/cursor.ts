import { z } from 'zod';
import { InvalidCursorError } from './errors';
import type { SortDirection, SortableField } from '../domain/product/constraints';
import { SORTABLE_FIELDS } from '../domain/product/constraints';

/**
 * Keyset ("seek") pagination cursors.
 *
 * ## Why not OFFSET
 *
 * `LIMIT 20 OFFSET 10000` makes PostgreSQL walk and discard 10,000 rows to
 * return 20 - the cost of page N grows linearly with N, so the deepest pages
 * are the slowest. Worse, it is *incorrect* under concurrent writes: insert a
 * row while a client pages, and every subsequent page shifts, so the client
 * silently sees a duplicate or misses a row entirely.
 *
 * Keyset pagination asks "give me the rows after this exact position", which is
 * an index seek: page 500 costs the same as page 1, and concurrent inserts
 * cannot shift the window.
 *
 * ## Why the id is part of the cursor
 *
 * The sort column need not be unique - two products can share a price or a
 * `createdAt` to the microsecond. Without a tie-break the boundary between
 * pages is ambiguous, and rows with equal sort values get skipped or repeated.
 * Every cursor therefore carries `(sortValue, id)`, and every query orders by
 * `(sortField, id)`, which makes the ordering a total one.
 *
 * ## On tampering
 *
 * Cursors are base64url JSON, not signed. A forged cursor can only move the
 * caller's own window within data they are already allowed to read - there is
 * no privilege to escalate. What a malformed cursor must never do is produce a
 * 500, so decoding validates the payload strictly and raises a 400 instead.
 */

const cursorPayloadSchema = z.object({
  /** Sort field the cursor was produced for. */
  f: z.enum(SORTABLE_FIELDS),
  /** Sort direction the cursor was produced for. */
  d: z.enum(['asc', 'desc']),
  /** Last row's value for the sort field. Dates are ISO-8601 strings. */
  v: z.union([z.string(), z.number()]),
  /** Last row's id, the tie-breaker that makes the ordering total. */
  i: z.string().uuid(),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor.
 *
 * @param expected The sort the *current* request asked for. A cursor produced
 *        under a different sort describes a position in a different ordering,
 *        so continuing from it would return an arbitrary slice. Rejecting it is
 *        the only correct behaviour; silently ignoring the mismatch would hand
 *        the caller wrong data with no indication.
 * @throws {InvalidCursorError}
 */
export function decodeCursor(
  raw: string,
  expected: { field: SortableField; direction: SortDirection },
): CursorPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // Deliberately not echoing `raw` back: it is attacker-controlled and would
    // land verbatim in logs and error responses.
    throw new InvalidCursorError('it is not valid base64url-encoded JSON');
  }

  const parsed = cursorPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new InvalidCursorError('it does not have the expected structure');
  }

  if (parsed.data.f !== expected.field || parsed.data.d !== expected.direction) {
    throw new InvalidCursorError(
      `it was issued for sort "${parsed.data.f}:${parsed.data.d}" but this ` +
        `request sorts by "${expected.field}:${expected.direction}"`,
    );
  }

  return parsed.data;
}
