import { describe, expect, it } from '@jest/globals';
import { QueryFailedError, type DataSource } from 'typeorm';
import { TypeOrmProductRepository } from '../../src/infrastructure/typeorm/TypeOrmProductRepository';
import {
  ProductNotFoundError,
  SkuAlreadyExistsError,
  VersionConflictError,
} from '../../src/shared/errors';

/**
 * These tests drive the repository's **error paths** with a stubbed TypeORM
 * repository.
 *
 * The happy paths are covered against a real PostgreSQL in
 * `tests/integration`, which is where they belong - a stub cannot tell you
 * whether the SQL is correct. What a stub *can* do is produce failures that are
 * awkward to provoke for real: a driver-level unique violation, an unexpected
 * error class, a zero-row update. Those branches decide which HTTP status a
 * client sees, so leaving them untested would be leaving the error contract
 * untested.
 */

/** A `QueryFailedError` carrying the SQLSTATE the driver would report. */
function pgError(code: string): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('constraint violated'));
  (error as { driverError: unknown }).driverError = { code };
  return error;
}

interface RepoStub {
  save?: () => Promise<unknown>;
  findOne?: () => Promise<unknown>;
  delete?: () => Promise<{ affected: number | null }>;
  execute?: () => Promise<{ affected: number | null; raw: unknown[] }>;
}

function repositoryWith(stub: RepoStub): TypeOrmProductRepository {
  const builder = {
    update: () => builder,
    set: () => builder,
    where: () => builder,
    andWhere: () => builder,
    returning: () => builder,
    execute: stub.execute ?? (async () => ({ affected: 1, raw: [] })),
  };
  const repository = {
    create: (input: unknown) => input,
    save: stub.save ?? (async (entity: unknown) => entity),
    findOne: stub.findOne ?? (async () => null),
    delete: stub.delete ?? (async () => ({ affected: 1 })),
    createQueryBuilder: () => builder,
  };
  return new TypeOrmProductRepository({
    getRepository: () => repository,
  } as unknown as DataSource);
}

const NEW_PRODUCT = {
  sku: 'BEV-COLA-330',
  name: 'Cola',
  description: null,
  category: 'beverage' as const,
  priceMinor: 1_000,
  currency: 'VND' as const,
  stock: 1,
  isActive: true,
};

describe('TypeOrmProductRepository error mapping', () => {
  it('turns SQLSTATE 23505 on insert into a 409, not a 500', async () => {
    // Uniqueness is decided by the index, never by a prior SELECT: two
    // concurrent creates both pass a check-then-insert and one still fails.
    const repository = repositoryWith({
      save: async () => {
        throw pgError('23505');
      },
    });
    await expect(repository.create(NEW_PRODUCT)).rejects.toBeInstanceOf(SkuAlreadyExistsError);
  });

  it('lets an unrecognised driver error through untouched', async () => {
    // Anything not explicitly understood must reach the error handler as an
    // unknown failure - dressing it up as a 409 would hide a real defect.
    const repository = repositoryWith({
      save: async () => {
        throw pgError('42P01'); // undefined_table
      },
    });
    await expect(repository.create(NEW_PRODUCT)).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('lets a plain Error through untouched', async () => {
    const boom = new Error('connection terminated');
    const repository = repositoryWith({
      save: async () => {
        throw boom;
      },
    });
    await expect(repository.create(NEW_PRODUCT)).rejects.toBe(boom);
  });

  it('reports 404 when a conditional update matches nothing and the row is gone', async () => {
    const repository = repositoryWith({
      execute: async () => ({ affected: 0, raw: [] }),
      findOne: async () => null,
    });
    await expect(repository.update('id-1', { stock: 1 }, 1)).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });

  it('reports 409 when a conditional update matches nothing but the row exists', async () => {
    // Zero rows matched with the product still present means someone else
    // committed first. The client needs to tell this apart from a 404.
    const repository = repositoryWith({
      execute: async () => ({ affected: 0, raw: [] }),
      findOne: async () => ({ id: 'id-1', version: 7 }),
    });
    try {
      await repository.update('id-1', { stock: 1 }, 3);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VersionConflictError);
      expect((error as VersionConflictError).expectedVersion).toBe(3);
      expect((error as VersionConflictError).actualVersion).toBe(7);
    }
  });

  it('falls back to the stored version when the caller sent no If-Match', async () => {
    const repository = repositoryWith({
      execute: async () => ({ affected: 0, raw: [] }),
      findOne: async () => ({ id: 'id-1', version: 4 }),
    });
    try {
      await repository.update('id-1', { stock: 1 });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as VersionConflictError).expectedVersion).toBe(4);
    }
  });

  it('treats a null affected count on update as "nothing matched"', async () => {
    // Some drivers report null instead of 0. Reading that as truthy would make
    // a failed conditional update look like a success.
    const repository = repositoryWith({
      execute: async () => ({ affected: null, raw: [] }),
      findOne: async () => ({ id: 'id-1', version: 2 }),
    });
    await expect(repository.update('id-1', { stock: 1 }, 1)).rejects.toBeInstanceOf(
      VersionConflictError,
    );
  });

  it.each([
    ['Date objects', new Date('2026-01-02T03:04:05.678Z'), new Date('2026-01-02T03:04:06.000Z')],
    ['ISO strings', '2026-01-02T03:04:05.678Z', '2026-01-02T03:04:06.000Z'],
  ])('maps a RETURNING row whose timestamps are %s', async (_label, created, updated) => {
    // `RETURNING *` yields raw rows, which bypass the entity metadata: column
    // names are snake_case, `price_minor` is a string, and the driver may hand
    // back either a Date or an ISO string depending on how it was configured.
    const repository = repositoryWith({
      execute: async () => ({
        affected: 1,
        raw: [
          {
            id: 'id-1',
            sku: 'BEV-COLA-330',
            name: 'Cola',
            description: null,
            category: 'beverage',
            price_minor: '12000',
            currency: 'VND',
            stock: 3,
            is_active: true,
            version: 2,
            created_at: created,
            updated_at: updated,
          },
        ],
      }),
    });

    const product = await repository.update('id-1', { stock: 3 });
    expect(product.priceMinor).toBe(12_000);
    expect(typeof product.priceMinor).toBe('number');
    expect(product.createdAt).toBeInstanceOf(Date);
    expect(product.createdAt.toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(product.updatedAt).toBeInstanceOf(Date);
    expect(product.isActive).toBe(true);
  });

  it('treats a null affected count as "nothing was deleted"', async () => {
    // Some drivers report null rather than 0; reading that as truthy would
    // turn a failed delete into a 204.
    const repository = repositoryWith({ delete: async () => ({ affected: null }) });
    expect(await repository.delete('id-1')).toBe(false);
  });

  it('reports a successful delete', async () => {
    const repository = repositoryWith({ delete: async () => ({ affected: 1 }) });
    expect(await repository.delete('id-1')).toBe(true);
  });

  it('returns null rather than throwing when a product is absent', async () => {
    const repository = repositoryWith({ findOne: async () => null });
    expect(await repository.findById('id-1')).toBeNull();
  });
});
