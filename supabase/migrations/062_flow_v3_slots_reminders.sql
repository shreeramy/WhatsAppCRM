-- ============================================================
-- Flow v3 (DSA Welcome v3): demo slot bookings with capacity, demo-day
-- reminders, and the "Payment Pending" pipeline stage.
--
--   * flow_slot_bookings + flow_book_slot() — NEW. One active booking per
--     contact per flow; a slot holds at most N bookings; re-booking moves
--     the contact's booking (returns the old slot so its follow-up and
--     reminder can be cancelled). Serialised per slot with an advisory
--     lock so two leads can't both take the last place.
--   * flow_scheduled_jobs.kind also allows 'reminder' (table from 057).
--   * Sales Pipeline: "Payment Pending" stage after "Demo Booked" — the
--     stages after it move down one position (requested change).
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS flow_slot_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_slot_bookings_one_active
  ON flow_slot_bookings (flow_id, contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS flow_slot_bookings_slot
  ON flow_slot_bookings (flow_id, slot_start) WHERE status = 'active';
ALTER TABLE flow_slot_bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_slot_bookings_select ON flow_slot_bookings;
CREATE POLICY flow_slot_bookings_select ON flow_slot_bookings FOR SELECT
  USING (is_account_member(account_id));

-- Returns {"status": "booked"|"same"|"full", "previous_start": ts|null}.
CREATE OR REPLACE FUNCTION flow_book_slot(
  p_account_id UUID,
  p_flow_id UUID,
  p_contact_id UUID,
  p_conversation_id UUID,
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ,
  p_capacity INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing flow_slot_bookings%ROWTYPE;
  v_taken INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_flow_id::text || '|' || p_start::text));

  SELECT * INTO v_existing FROM flow_slot_bookings
  WHERE flow_id = p_flow_id AND contact_id = p_contact_id AND status = 'active'
  FOR UPDATE;

  IF FOUND AND v_existing.slot_start = p_start THEN
    RETURN jsonb_build_object('status', 'same', 'previous_start', NULL);
  END IF;

  SELECT COUNT(*) INTO v_taken FROM flow_slot_bookings
  WHERE flow_id = p_flow_id AND slot_start = p_start AND status = 'active';
  IF v_taken >= p_capacity THEN
    RETURN jsonb_build_object('status', 'full', 'previous_start', NULL);
  END IF;

  IF FOUND THEN
    UPDATE flow_slot_bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = v_existing.id;
  END IF;

  INSERT INTO flow_slot_bookings (account_id, flow_id, contact_id, conversation_id, slot_start, slot_end)
  VALUES (p_account_id, p_flow_id, p_contact_id, p_conversation_id, p_start, p_end);

  RETURN jsonb_build_object(
    'status', 'booked',
    'previous_start', CASE WHEN v_existing.id IS NULL THEN NULL ELSE v_existing.slot_start END
  );
END;
$$;
ALTER FUNCTION flow_book_slot(UUID, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION flow_book_slot(UUID, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION flow_book_slot(UUID, UUID, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO service_role;

ALTER TABLE flow_scheduled_jobs DROP CONSTRAINT IF EXISTS flow_scheduled_jobs_kind_check;
ALTER TABLE flow_scheduled_jobs ADD CONSTRAINT flow_scheduled_jobs_kind_check
  CHECK (kind IN ('nudge', 'auto_close', 'no_reply', 'reminder'));

-- "Payment Pending" right after "Demo Booked" in each pipeline that has it.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT s.pipeline_id, s.position
    FROM pipeline_stages s
    WHERE s.name = 'Demo Booked'
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_stages x WHERE x.pipeline_id = s.pipeline_id AND x.name = 'Payment Pending'
      )
  LOOP
    UPDATE pipeline_stages SET position = position + 1
    WHERE pipeline_id = r.pipeline_id AND position > r.position;
    INSERT INTO pipeline_stages (pipeline_id, name, position) VALUES (r.pipeline_id, 'Payment Pending', r.position + 1);
  END LOOP;
END $$;
