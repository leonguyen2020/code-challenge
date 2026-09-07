import { describe, expect, it } from '@jest/globals';
import { decodeCursor, encodeCursor, type CursorPayload } from '../../src/shared/cursor';
import { InvalidCursorError } from '../../src/shared/errors';

const SORT = { field: 'createdAt', direction: 'asc' } as const;
const PAYLOAD: CursorPayload = {
  f: 'createdAt',
  d: 'asc',
  v: '2026-01-01T00:00:00.000Z',
  i: '11111111-1111-4111-8111-111111111111',
};

describe('keyset cursors', () => {
  it('round-trips a payload', () => {
    expect(decodeCursor(encodeCursor(PAYLOAD), SORT)).toEqual(PAYLOAD);
  });

  it('encodes to URL-safe characters only', () => {
    // A cursor travels in a query string. base64 (as opposed to base64url)
    // contains "+" and "/", which are re-interpreted on the way back and
    // silently corrupt the cursor.
    const encoded = encodeCursor({ ...PAYLOAD, v: 'a+b/c=d?e&f' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded, SORT).v).toBe('a+b/c=d?e&f');
  });

  it('carries numeric sort values without turning them into strings', () => {
    const numeric = { ...PAYLOAD, f: 'priceMinor', v: 12_345 } as CursorPayload;
    expect(decodeCursor(encodeCursor(numeric), { field: 'priceMinor', direction: 'asc' }).v).toBe(12_345);
  });

  describe('rejects malformed input with 400, never a 500', () => {
    it.each([
      ['not base64 at all', 'not-a-cursor!!'],
      ['valid base64, not JSON', Buffer.from('hello').toString('base64url')],
      ['JSON but not an object', Buffer.from('42').toString('base64url')],
      ['object missing fields', Buffer.from('{"f":"name"}').toString('base64url')],
      ['unknown sort field', Buffer.from('{"f":"secret","d":"asc","v":1,"i":"11111111-1111-4111-8111-111111111111"}').toString('base64url')],
      ['id is not a uuid', Buffer.from('{"f":"createdAt","d":"asc","v":1,"i":"nope"}').toString('base64url')],
      ['empty string', ''],
    ])('%s', (_label, raw) => {
      expect(() => decodeCursor(raw, SORT)).toThrow(InvalidCursorError);
    });
  });

  it('rejects a cursor issued for a different sort', () => {
    // Continuing a different ordering from this position would return an
    // arbitrary slice of the table with a 200 status - the worst kind of bug.
    const encoded = encodeCursor(PAYLOAD);
    expect(() => decodeCursor(encoded, { field: 'name', direction: 'asc' })).toThrow(InvalidCursorError);
    expect(() => decodeCursor(encoded, { field: 'createdAt', direction: 'desc' })).toThrow(InvalidCursorError);
  });

  it('never echoes the offending cursor back in the error message', () => {
    // The value is attacker-controlled and lands in logs and error responses.
    const hostile = Buffer.from('{"evil":"<script>alert(1)</script>"}').toString('base64url');
    try {
      decodeCursor(hostile, SORT);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).not.toContain('script');
      expect((error as Error).message).not.toContain(hostile);
    }
  });
});
