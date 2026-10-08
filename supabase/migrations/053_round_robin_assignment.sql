-- ============================================================
-- Round-robin chat assignment (flows, automations, inbox auto-assign)
--
-- Adds NEW objects only — no existing table or row is altered:
--   * round_robin_pointers — who got the last chat, per account + pool.
--   * assign_round_robin() — picks the next agent and assigns the chat
--     atomically. The pointer row is locked (SELECT … FOR UPDATE) for
--     the whole pick-and-assign, so concurrent chats never get the
--     same agent twice in a row and the rotation survives restarts and
--     multiple app instances.
--   * inbox_settings — per-account "auto-assign new conversations
--     round-robin" switch + agent pool.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS round_robin_pointers (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'agents' = every Agent-role member; otherwise the sorted pool ids.
  pool_key TEXT NOT NULL,
  last_agent_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, pool_key)
);

ALTER TABLE round_robin_pointers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS round_robin_pointers_select ON round_robin_pointers;
CREATE POLICY round_robin_pointers_select ON round_robin_pointers FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- No client writes: only assign_round_robin() (SECURITY DEFINER) writes.

CREATE TABLE IF NOT EXISTS inbox_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  auto_assign_round_robin BOOLEAN NOT NULL DEFAULT FALSE,
  -- Empty/NULL = every member with the Agent role.
  auto_assign_agent_ids UUID[],
  auto_assign_skip_offline BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE inbox_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_settings_select ON inbox_settings;
DROP POLICY IF EXISTS inbox_settings_write ON inbox_settings;
CREATE POLICY inbox_settings_select ON inbox_settings FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY inbox_settings_write ON inbox_settings FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- assign_round_robin
--
-- p_agent_ids      pool (user ids); NULL/empty = all Agent-role members.
--                  Ids that aren't members of the account are ignored.
-- p_conversation_id  chat to assign (NULL = just advance the pointer).
-- p_force          reassign even if the chat already has a pool agent.
-- p_skip_offline   prefer agents seen in the last 75s; if none are
--                  online, fall back to the whole pool.
-- Returns the agent the chat is assigned to (existing one when kept),
-- or NULL when the pool is empty.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_round_robin(
  p_account_id UUID,
  p_agent_ids UUID[] DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE,
  p_skip_offline BOOLEAN DEFAULT FALSE
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pool UUID[];
  v_pool_key TEXT;
  v_candidates UUID[];
  v_online UUID[];
  v_current UUID;
  v_last UUID;
  v_next UUID;
BEGIN
  IF p_agent_ids IS NOT NULL AND cardinality(p_agent_ids) > 0 THEN
    SELECT array_agg(p.user_id ORDER BY p.user_id) INTO v_pool
    FROM profiles p
    WHERE p.account_id = p_account_id AND p.user_id = ANY(p_agent_ids);
    v_pool_key := array_to_string(v_pool, ',');
  ELSE
    SELECT array_agg(p.user_id ORDER BY p.user_id) INTO v_pool
    FROM profiles p
    WHERE p.account_id = p_account_id AND p.account_role = 'agent';
    v_pool_key := 'agents';
  END IF;

  IF v_pool IS NULL OR cardinality(v_pool) = 0 THEN
    RETURN NULL;
  END IF;

  IF p_conversation_id IS NOT NULL THEN
    SELECT assigned_agent_id INTO v_current
    FROM conversations
    WHERE id = p_conversation_id AND account_id = p_account_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Conversation % not found in account', p_conversation_id;
    END IF;
    -- Don't reshuffle a lead that already sits with a pool agent.
    IF NOT p_force AND v_current IS NOT NULL AND v_current = ANY(v_pool) THEN
      RETURN v_current;
    END IF;
  END IF;

  INSERT INTO round_robin_pointers (account_id, pool_key)
  VALUES (p_account_id, v_pool_key)
  ON CONFLICT (account_id, pool_key) DO NOTHING;

  SELECT last_agent_id INTO v_last
  FROM round_robin_pointers
  WHERE account_id = p_account_id AND pool_key = v_pool_key
  FOR UPDATE;

  v_candidates := v_pool;
  IF p_skip_offline THEN
    SELECT array_agg(u ORDER BY u) INTO v_online
    FROM unnest(v_pool) AS u
    JOIN member_presence mp ON mp.user_id = u
    WHERE mp.last_seen_at > NOW() - INTERVAL '75 seconds';
    IF v_online IS NOT NULL AND cardinality(v_online) > 0 THEN
      v_candidates := v_online;
    END IF;
  END IF;

  -- Next id after the last one in sorted order, wrapping around.
  SELECT c INTO v_next
  FROM unnest(v_candidates) AS c
  WHERE v_last IS NULL OR c > v_last
  ORDER BY c
  LIMIT 1;
  IF v_next IS NULL THEN
    v_next := v_candidates[1];
  END IF;

  UPDATE round_robin_pointers
  SET last_agent_id = v_next, updated_at = NOW()
  WHERE account_id = p_account_id AND pool_key = v_pool_key;

  IF p_conversation_id IS NOT NULL AND v_next IS DISTINCT FROM v_current THEN
    UPDATE conversations
    SET assigned_agent_id = v_next, updated_at = NOW()
    WHERE id = p_conversation_id AND account_id = p_account_id;
  END IF;

  RETURN v_next;
END;
$$;

ALTER FUNCTION public.assign_round_robin(UUID, UUID[], UUID, BOOLEAN, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_round_robin(UUID, UUID[], UUID, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_round_robin(UUID, UUID[], UUID, BOOLEAN, BOOLEAN) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_round_robin(UUID, UUID[], UUID, BOOLEAN, BOOLEAN) TO service_role;
