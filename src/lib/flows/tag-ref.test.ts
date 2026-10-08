import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTagRef, TagRefError } from './tag-ref';

// Tiny in-memory stand-in for the bits of supabase-js resolveTagRef uses.
function fakeDb(tags: { id: string; name: string; account_id: string }[]) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const filters: [string, unknown, 'eq' | 'ilike'][] = [];
      const rows = () => {
        const src: Record<string, unknown>[] =
          table === 'tags'
            ? tags
            : table === 'accounts'
              ? [{ id: 'acc', owner_user_id: 'owner' }]
              : [];
        return src.filter((r) =>
          filters.every(([k, v, op]) =>
            op === 'eq'
              ? r[k] === v
              : String(r[k]).toLowerCase() === String(v).toLowerCase(),
          ),
        );
      };
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          filters.push([k, v, 'eq']);
          return b;
        },
        ilike: (k: string, v: unknown) => {
          filters.push([k, v, 'ilike']);
          return b;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: 'new-tag-id' }, error: null }),
            }),
          };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, inserted };
}

const UUID = 'b243224d-27d3-4783-84f9-100df6ce1f58';

describe('resolveTagRef', () => {
  it('accepts a tag UUID from this account', async () => {
    const { db } = fakeDb([{ id: UUID, name: 'demo-requested', account_id: 'acc' }]);
    await expect(resolveTagRef(db, 'acc', UUID)).resolves.toEqual({ id: UUID, created: false });
  });

  it('resolves a tag NAME (what the broken builder saved) case-insensitively', async () => {
    const { db } = fakeDb([{ id: UUID, name: 'Demo-Requested', account_id: 'acc' }]);
    await expect(resolveTagRef(db, 'acc', 'demo-requested')).resolves.toEqual({
      id: UUID,
      created: false,
    });
  });

  it('creates a missing tag by name, owned by the account owner', async () => {
    const { db, inserted } = fakeDb([]);
    await expect(resolveTagRef(db, 'acc', 'not-fit')).resolves.toEqual({
      id: 'new-tag-id',
      created: true,
    });
    expect(inserted).toEqual([{ account_id: 'acc', user_id: 'owner', name: 'not-fit' }]);
  });

  it('gives a clear error for a deleted tag UUID', async () => {
    const { db } = fakeDb([]);
    await expect(resolveTagRef(db, 'acc', UUID)).rejects.toThrow(/no longer exists/);
  });

  it('rejects an empty step', async () => {
    const { db } = fakeDb([]);
    await expect(resolveTagRef(db, 'acc', '   ')).rejects.toBeInstanceOf(TagRefError);
  });

  it('can refuse to create when asked', async () => {
    const { db } = fakeDb([]);
    await expect(
      resolveTagRef(db, 'acc', 'nurture', { createMissing: false }),
    ).rejects.toThrow(/No tag named "nurture"/);
  });

  it('ignores tags from other accounts', async () => {
    const { db } = fakeDb([{ id: UUID, name: 'demo-requested', account_id: 'other' }]);
    await expect(resolveTagRef(db, 'acc', 'demo-requested')).resolves.toMatchObject({
      created: true,
    });
  });
});
