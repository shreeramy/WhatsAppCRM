-- ============================================================
-- CALL RECORDINGS on deals
--
-- Salespeople upload phone-call recordings to a deal. Files live in a
-- PRIVATE storage bucket (`call-recordings`) under
-- `account-<account_id>/deal-<deal_id>/…` and are played through
-- short-lived signed URLs — recordings are never publicly reachable.
--
-- Access: any account member can list/play; agents+ can upload;
-- the uploader or an admin/owner can delete.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  storage_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  duration_seconds INTEGER,
  notes TEXT,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_recordings_deal
  ON call_recordings(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_recordings_account
  ON call_recordings(account_id);

-- The deal (and its path prefix) must belong to the row's account.
CREATE OR REPLACE FUNCTION call_recordings_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM deals WHERE id = NEW.deal_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Deal does not belong to this account';
  END IF;
  IF split_part(NEW.storage_path, '/', 1) <> 'account-' || NEW.account_id::text THEN
    RAISE EXCEPTION 'Recording path is outside this account';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION call_recordings_before_insert() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_call_recordings_before_insert ON call_recordings;
CREATE TRIGGER on_call_recordings_before_insert
  BEFORE INSERT ON call_recordings
  FOR EACH ROW EXECUTE FUNCTION call_recordings_before_insert();

ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_recordings_select ON call_recordings;
DROP POLICY IF EXISTS call_recordings_insert ON call_recordings;
DROP POLICY IF EXISTS call_recordings_update ON call_recordings;
DROP POLICY IF EXISTS call_recordings_delete ON call_recordings;

CREATE POLICY call_recordings_select ON call_recordings FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY call_recordings_insert ON call_recordings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent') AND uploaded_by = auth.uid());
CREATE POLICY call_recordings_update ON call_recordings FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND uploaded_by = auth.uid())
  );
CREATE POLICY call_recordings_delete ON call_recordings FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND uploaded_by = auth.uid())
  );

-- ------------------------------------------------------------
-- Private storage bucket. 50 MB covers ~1h of typical phone
-- recordings (m4a/mp3/amr) and matches Supabase's default per-file cap.
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'call-recordings',
  'call-recordings',
  FALSE,
  52428800,
  ARRAY[
    'audio/mpeg', 'audio/mp3',
    'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/x-aac',
    'audio/amr', 'audio/3gpp', 'audio/3gpp2',
    'audio/ogg', 'audio/opus', 'audio/webm',
    'audio/wav', 'audio/x-wav', 'audio/wave',
    'audio/flac', 'audio/x-flac'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Folder 1 of the object path is `account-<account_id>`.
DROP POLICY IF EXISTS "Members can read call recordings" ON storage.objects;
CREATE POLICY "Members can read call recordings"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Agents can upload call recordings" ON storage.objects;
CREATE POLICY "Agents can upload call recordings"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- Deleting a file mirrors the row's delete rule: the uploader or an
-- admin/owner. A file with no row (a failed upload being cleaned up)
-- can be removed by any agent in the account.
DROP POLICY IF EXISTS "Agents can delete call recordings" ON storage.objects;
CREATE POLICY "Agents can delete call recordings"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
    AND (
      NOT EXISTS (SELECT 1 FROM public.call_recordings r WHERE r.storage_path = name)
      OR EXISTS (
        SELECT 1 FROM public.call_recordings r
        WHERE r.storage_path = name
          AND (r.uploaded_by = auth.uid() OR public.is_account_member(r.account_id, 'admin'))
      )
    )
  );
