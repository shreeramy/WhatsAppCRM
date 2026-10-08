import type { SupabaseClient } from '@supabase/supabase-js';

// A flow's set_tag node normally stores the tag's UUID, but flows built
// while the builder's tag picker couldn't load ended up storing the tag
// NAME ("demo-requested") in `tag_id`. Every such write failed with
// "Could not verify contact tag ownership". This resolves either form.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string) => UUID.test(v);

export class TagRefError extends Error {}

export interface ResolvedTag {
  id: string;
  /** True when the tag didn't exist and was created by name. */
  created: boolean;
}

/**
 * Resolve a set_tag reference (UUID or tag name) to a tag id in the
 * account. A name that matches no tag is created (case-insensitive
 * match first) when `createMissing` is set; otherwise a TagRefError
 * explains what's wrong.
 */
export async function resolveTagRef(
  db: SupabaseClient,
  accountId: string,
  ref: string | null | undefined,
  { createMissing = true }: { createMissing?: boolean } = {},
): Promise<ResolvedTag> {
  const value = (ref ?? '').trim();
  if (!value) throw new TagRefError('No tag selected on this step');

  if (isUuid(value)) {
    const { data, error } = await db
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .eq('id', value)
      .maybeSingle();
    if (error) throw new TagRefError(`Tag lookup failed: ${error.message}`);
    if (!data) throw new TagRefError(`Tag ${value} no longer exists — pick another tag in the flow`);
    return { id: data.id as string, created: false };
  }

  const { data: matches, error } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
    // Escape LIKE wildcards so the name matches literally.
    .ilike('name', value.replace(/[%_\\]/g, (c) => `\\${c}`));
  if (error) throw new TagRefError(`Tag lookup failed: ${error.message}`);
  const hit = (matches ?? [])[0] as { id: string } | undefined;
  if (hit) return { id: hit.id, created: false };

  if (!createMissing) throw new TagRefError(`No tag named "${value}"`);

  // tags.user_id is NOT NULL: attribute bot-created tags to the account owner.
  const { data: account, error: accErr } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  if (accErr || !account?.owner_user_id) {
    throw new TagRefError(`Couldn't create tag "${value}": account owner not found`);
  }
  const { data: created, error: insErr } = await db
    .from('tags')
    .insert({ account_id: accountId, user_id: account.owner_user_id, name: value })
    .select('id')
    .single();
  if (insErr || !created) {
    throw new TagRefError(`Couldn't create tag "${value}": ${insErr?.message ?? 'unknown error'}`);
  }
  return { id: created.id as string, created: true };
}
