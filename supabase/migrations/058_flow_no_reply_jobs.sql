-- ============================================================
-- Flow engine v2: "no reply" jobs.
--
-- A lead who doesn't answer the welcome within N hours is assigned to
-- an agent with a call follow-up. The job carries the actions to run.
-- Only touches flow_scheduled_jobs (added in 057, flow-v2 only).
-- Idempotent.
-- ============================================================

ALTER TABLE flow_scheduled_jobs ADD COLUMN IF NOT EXISTS actions JSONB;

ALTER TABLE flow_scheduled_jobs DROP CONSTRAINT IF EXISTS flow_scheduled_jobs_kind_check;
ALTER TABLE flow_scheduled_jobs ADD CONSTRAINT flow_scheduled_jobs_kind_check
  CHECK (kind IN ('nudge', 'auto_close', 'no_reply'));
