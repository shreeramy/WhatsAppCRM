-- ============================================================
-- Blocked contacts
--
-- Owners/admins can block a contact from the inbox. The app then
-- drops that contact's inbound messages (so a block holds even when
-- Meta's own block_users call is refused, e.g. outside the 24-hour
-- window) and hides the chat from the inbox.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_blocked
  ON contacts(account_id) WHERE blocked_at IS NOT NULL;
