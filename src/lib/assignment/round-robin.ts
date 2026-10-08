import type { SupabaseClient } from '@supabase/supabase-js';

// Round-robin chat assignment — a thin wrapper over the
// `assign_round_robin` Postgres function (migration 053), which locks
// the pool's pointer row so concurrent chats never double-assign and
// the rotation survives restarts / multiple instances.
//
// Used by flow handoff nodes, the automation "assign conversation"
// step and the inbox "auto-assign new conversations" setting. Needs
// the service-role client (the function isn't granted to users).

export interface RoundRobinOptions {
  accountId: string;
  /** Pool of user ids; empty/undefined = every Agent-role member. */
  agentIds?: string[] | null;
  /** Chat to assign. Omit to only advance the pointer. */
  conversationId?: string | null;
  /** Reassign even if the chat already has an agent from the pool. */
  force?: boolean;
  /** Prefer agents online in the last 75s (falls back to the whole pool). */
  skipOffline?: boolean;
}

/** Returns the assigned agent's user id, or null when the pool is empty. */
export async function assignRoundRobin(
  db: SupabaseClient,
  opts: RoundRobinOptions,
): Promise<string | null> {
  const ids = (opts.agentIds ?? []).filter(Boolean);
  const { data, error } = await db.rpc('assign_round_robin', {
    p_account_id: opts.accountId,
    p_agent_ids: ids.length ? ids : null,
    p_conversation_id: opts.conversationId ?? null,
    p_force: opts.force ?? false,
    p_skip_offline: opts.skipOffline ?? false,
  });
  if (error) throw new Error(`Round-robin assignment failed: ${error.message}`);
  return (data as string | null) ?? null;
}
