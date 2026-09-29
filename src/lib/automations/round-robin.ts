// Round-robin agent selection for the assign_conversation step.

export interface RoundRobinCandidate {
  user_id: string;
  account_role: string | null;
}

/**
 * Who a round-robin step rotates between: the members picked on the
 * step, or — when none are picked — every member with the Agent role.
 * Owners and admins are only included when picked explicitly.
 * Sorted by user id so the order is stable between runs.
 */
export function roundRobinPool(
  members: RoundRobinCandidate[],
  pickedIds: string[] | undefined,
): string[] {
  const picked = (pickedIds ?? []).filter(Boolean);
  const pool = picked.length
    ? members.filter((m) => picked.includes(m.user_id))
    : members.filter((m) => m.account_role === "agent");
  return pool.map((m) => m.user_id).sort();
}

/** The agent after `lastId` in the pool, wrapping around. Null if the pool is empty. */
export function nextRoundRobinAgent(pool: string[], lastId: string | undefined): string | null {
  if (pool.length === 0) return null;
  if (!lastId) return pool[0];
  const i = pool.indexOf(lastId);
  if (i !== -1) return pool[(i + 1) % pool.length];
  // Last agent left the pool — continue with whoever sorts after them.
  return pool.find((id) => id > lastId) ?? pool[0];
}
