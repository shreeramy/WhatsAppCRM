-- ============================================================
-- Call Next: what happened on each call an agent made.
--
-- NEW table only — nothing existing is altered. One row per call the
-- agent logs from the Call Next screen. Drives the queue (who to call
-- next) and the team report (calls made, demos fixed).
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('demo_booked', 'will_pay', 'call_later', 'no_answer', 'not_interested')),
  -- not_interested: price / not_dsa / other_tool / other
  reason TEXT,
  note TEXT,
  -- demo time or call-back time, when the outcome has one
  next_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS call_outcomes_contact_idx
  ON call_outcomes (account_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS call_outcomes_agent_idx
  ON call_outcomes (account_id, agent_id, created_at DESC);

ALTER TABLE call_outcomes ENABLE ROW LEVEL SECURITY;

-- Agents see their own calls; owners/admins see the whole team's.
DROP POLICY IF EXISTS call_outcomes_select ON call_outcomes;
CREATE POLICY call_outcomes_select ON call_outcomes FOR SELECT
  USING (agent_id = auth.uid() OR is_account_member(account_id, 'admin'));

-- Writes go through /api/call-next/outcome (service role) after an access
-- check, so no client insert/update/delete policies.
