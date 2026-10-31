-- ============================================================
-- Hide a template from the pickers (inbox, new broadcast) without
-- deleting it at Meta, e.g. webinar templates between webinars.
-- Flows, drips and automations that name it keep working.
-- ============================================================

ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
