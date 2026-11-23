-- ============================================================
-- Free-trial signup links from DSA Management, one per contact.
--
--   * trial_links — NEW. The bot ("Get 7-day free trial" button) and
--     agents (chat sidebar) ask DSA Management for a personal, single-use
--     signup link. The unique (account_id, contact_id) index is the lock:
--     whoever inserts the 'pending' row calls the API; everyone else
--     waits for it and reuses the stored link. A failed call deletes the
--     row so a later press can try again; an expired link is never
--     replaced automatically.
--   * Members can read their account's rows (the sidebar shows the link).
--     Writes happen only on the server with the service role.
--
-- Idempotent. New table only; no existing data is touched.
-- ============================================================

CREATE TABLE IF NOT EXISTS trial_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued')),
  url TEXT,
  expires_at TIMESTAMPTZ,
  -- 'bot' (WhatsApp button) or 'agent' (chat sidebar).
  source TEXT NOT NULL CHECK (source IN ('bot', 'agent')),
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status = 'pending' OR (url IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS trial_links_one_per_contact ON trial_links (account_id, contact_id);

ALTER TABLE trial_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trial_links_select ON trial_links;
CREATE POLICY trial_links_select ON trial_links FOR SELECT
  USING (is_account_member(account_id));
