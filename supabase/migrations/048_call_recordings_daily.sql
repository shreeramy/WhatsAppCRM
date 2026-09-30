-- ============================================================
-- CALL RECORDINGS as a daily log (separate "Call Recordings" menu)
--
-- Agents bulk-upload the day's phone-call recordings; owners/admins
-- review them by day and by agent. Recordings no longer have to belong
-- to a deal.
--
--   * deal_id becomes optional; call_date + phone added.
--   * Agents/viewers see only recordings they uploaded; owners and
--     admins see the whole account.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE call_recordings ALTER COLUMN deal_id DROP NOT NULL;

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS call_date DATE,
  -- Other party's number, read from the recording's file name when present.
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- Existing (deal) recordings: use the upload day in India time.
UPDATE call_recordings
SET call_date = (created_at AT TIME ZONE 'Asia/Kolkata')::date
WHERE call_date IS NULL;

ALTER TABLE call_recordings
  ALTER COLUMN call_date SET DEFAULT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date),
  ALTER COLUMN call_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_recordings_day
  ON call_recordings(account_id, call_date DESC, uploaded_by);

-- Deal is optional now; when set (or a contact is), it must be in the account.
CREATE OR REPLACE FUNCTION call_recordings_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM deals WHERE id = NEW.deal_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Deal does not belong to this account';
  END IF;
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Contact does not belong to this account';
  END IF;
  IF split_part(NEW.storage_path, '/', 1) <> 'account-' || NEW.account_id::text THEN
    RAISE EXCEPTION 'Recording path is outside this account';
  END IF;
  RETURN NEW;
END;
$$;

-- Visibility: own recordings for agents/viewers, everything for admins+.
DROP POLICY IF EXISTS call_recordings_select ON call_recordings;
CREATE POLICY call_recordings_select ON call_recordings FOR SELECT
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id) AND uploaded_by = auth.uid())
  );
