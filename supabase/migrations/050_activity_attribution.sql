-- ============================================================
-- Who added a tag — for the Team Report.
--
-- contact_tags had no author column. Tags added from the app run as
-- the signed-in user, so DEFAULT auth.uid() records them; tags added
-- by automations (service role) stay NULL. Older rows stay NULL.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contact_tags
  ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid();

CREATE INDEX IF NOT EXISTS idx_contact_tags_added_by
  ON contact_tags(added_by, created_at) WHERE added_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_sender_id
  ON messages(sender_id, created_at) WHERE sender_id IS NOT NULL;
