-- ============================================================
-- Flow engine v2 ("DSA Welcome v2")
--
-- Adds NEW objects only. No existing row is read-modified or deleted.
-- The one change to an existing object is widening the
-- notifications.type CHECK to allow 'flow_alert' (a superset — every
-- existing row stays valid).
--
--   * flow_engine_settings — per-flow settings for flows that run on the
--     v2 engine (routing: off / test allow-list / live, business config).
--     Flows without a row here run on the original engine, unchanged.
--   * flow_contact_state  — per-contact debounce for button taps
--     ("latest tap wins") and the fallback-reply cooldown.
--   * flow_step_claims + flow_claim_step() — "never send the same step
--     twice within N seconds", atomic across concurrent webhooks.
--   * flow_scheduled_jobs + flow_claim_due_jobs() — delayed nudges and
--     auto-close, processed by /api/flows/tick (pg_cron → pg_net).
--   * flow_dropoff_by_day() — per-step drop-off report (v2 vs old).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- flow_engine_settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flow_engine_settings (
  flow_id UUID PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS flow_engine_settings_account_idx
  ON flow_engine_settings (account_id);

ALTER TABLE flow_engine_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_engine_settings_select ON flow_engine_settings;
CREATE POLICY flow_engine_settings_select ON flow_engine_settings FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS flow_engine_settings_update ON flow_engine_settings;
CREATE POLICY flow_engine_settings_update ON flow_engine_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- flow_contact_state
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flow_contact_state (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  latest_tap_message_id TEXT,
  latest_tap_ts BIGINT,
  last_fallback_reply_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, contact_id)
);
ALTER TABLE flow_contact_state ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.

-- Record a tap unless a newer one (by Meta timestamp) is already stored.
-- Returns the message id that is now the latest tap.
CREATE OR REPLACE FUNCTION flow_record_tap(
  p_account_id UUID,
  p_contact_id UUID,
  p_message_id TEXT,
  p_ts BIGINT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_latest TEXT;
BEGIN
  INSERT INTO flow_contact_state AS s (account_id, contact_id, latest_tap_message_id, latest_tap_ts)
  VALUES (p_account_id, p_contact_id, p_message_id, p_ts)
  ON CONFLICT (account_id, contact_id) DO UPDATE
    SET latest_tap_message_id = EXCLUDED.latest_tap_message_id,
        latest_tap_ts = EXCLUDED.latest_tap_ts,
        updated_at = NOW()
    WHERE s.latest_tap_ts IS NULL OR s.latest_tap_ts <= EXCLUDED.latest_tap_ts;
  SELECT latest_tap_message_id INTO v_latest
  FROM flow_contact_state
  WHERE account_id = p_account_id AND contact_id = p_contact_id;
  RETURN v_latest;
END;
$$;
ALTER FUNCTION flow_record_tap(UUID, UUID, TEXT, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION flow_record_tap(UUID, UUID, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION flow_record_tap(UUID, UUID, TEXT, BIGINT) TO service_role;

-- ------------------------------------------------------------
-- flow_step_claims
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flow_step_claims (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, flow_id, node_key)
);
ALTER TABLE flow_step_claims ENABLE ROW LEVEL SECURITY;

-- TRUE when the caller may send this step now; FALSE when the same step
-- was sent to this contact within p_window_seconds. Atomic: of two
-- concurrent callers exactly one gets TRUE.
CREATE OR REPLACE FUNCTION flow_claim_step(
  p_contact_id UUID,
  p_flow_id UUID,
  p_node_key TEXT,
  p_window_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  INSERT INTO flow_step_claims AS c (contact_id, flow_id, node_key, claimed_at)
  VALUES (p_contact_id, p_flow_id, p_node_key, NOW())
  ON CONFLICT (contact_id, flow_id, node_key) DO UPDATE
    SET claimed_at = NOW()
    WHERE c.claimed_at < NOW() - make_interval(secs => p_window_seconds)
  RETURNING TRUE INTO v_ok;
  RETURN COALESCE(v_ok, FALSE);
END;
$$;
ALTER FUNCTION flow_claim_step(UUID, UUID, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION flow_claim_step(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION flow_claim_step(UUID, UUID, TEXT, INTEGER) TO service_role;

-- ------------------------------------------------------------
-- flow_scheduled_jobs
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flow_scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  run_id UUID REFERENCES flow_runs(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('nudge', 'auto_close')),
  node_key TEXT,
  -- Sender types whose message (after created_at) cancels the job.
  cancel_on TEXT[] NOT NULL DEFAULT ARRAY['customer', 'agent'],
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'cancelled', 'skipped', 'failed')),
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flow_scheduled_jobs_due_idx
  ON flow_scheduled_jobs (due_at) WHERE status = 'pending';
ALTER TABLE flow_scheduled_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_scheduled_jobs_select ON flow_scheduled_jobs;
CREATE POLICY flow_scheduled_jobs_select ON flow_scheduled_jobs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- Claim up to p_limit due jobs (status pending → running). SKIP LOCKED so
-- two overlapping ticks never process the same job.
CREATE OR REPLACE FUNCTION flow_claim_due_jobs(p_limit INTEGER DEFAULT 25)
RETURNS SETOF flow_scheduled_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE flow_scheduled_jobs j
  SET status = 'running', processed_at = NOW()
  WHERE j.id IN (
    SELECT id FROM flow_scheduled_jobs
    WHERE status = 'pending' AND due_at <= NOW()
    ORDER BY due_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING j.*;
END;
$$;
ALTER FUNCTION flow_claim_due_jobs(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION flow_claim_due_jobs(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION flow_claim_due_jobs(INTEGER) TO service_role;

-- Every minute: if any job is due, ask the app to process it. Reuses the
-- app URL + shared secret from push_dispatch_config (migration 056).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wacrm-flow-v2-tick';
    PERFORM cron.schedule(
      'wacrm-flow-v2-tick',
      '* * * * *',
      $cron$
        SELECT net.http_post(
          url := rtrim(c.app_url, '/') || '/api/flows/tick',
          body := '{}'::jsonb,
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', c.secret),
          timeout_milliseconds := 30000
        )
        FROM public.push_dispatch_config c
        WHERE EXISTS (
          SELECT 1 FROM public.flow_scheduled_jobs
          WHERE status = 'pending' AND due_at <= NOW()
        )
      $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule flow v2 tick (%).', SQLERRM;
END $$;

-- ------------------------------------------------------------
-- notifications: allow 'flow_alert' (demo booked, call requested,
-- question asked). Superset of the old list.
-- ------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'follow_up_due', 'flow_alert'));

-- ------------------------------------------------------------
-- Drop-off report: per day, per flow, how many runs ended (so far) on
-- each step — the step of the run's last bot message. Also the median
-- minutes until the first human (agent) reply after the run started.
--
--   SELECT * FROM flow_dropoff_by_day(14);
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION flow_dropoff_by_day(p_days INTEGER DEFAULT 14)
RETURNS TABLE (
  day DATE,
  flow_name TEXT,
  last_step TEXT,
  runs BIGINT,
  median_minutes_to_first_human_reply NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH r AS (
    SELECT fr.id, fr.flow_id, fr.conversation_id, fr.started_at,
      (fr.started_at AT TIME ZONE 'Asia/Kolkata')::date AS day
    FROM flow_runs fr
    WHERE fr.started_at > NOW() - make_interval(days => p_days)
      AND COALESCE(fr.vars->>'trigger', '') <> 'fallback'
  ),
  last_step AS (
    SELECT DISTINCT ON (e.flow_run_id) e.flow_run_id, e.node_key
    FROM flow_run_events e
    JOIN r ON r.id = e.flow_run_id
    WHERE e.event_type = 'message_sent'
    ORDER BY e.flow_run_id, e.created_at DESC
  ),
  first_human AS (
    SELECT r.id AS run_id,
      EXTRACT(EPOCH FROM (MIN(m.created_at) - r.started_at)) / 60.0 AS minutes
    FROM r
    JOIN messages m ON m.conversation_id = r.conversation_id
      AND m.sender_type = 'agent' AND m.created_at > r.started_at
    GROUP BY r.id, r.started_at
  )
  SELECT r.day, f.name, COALESCE(ls.node_key, '(nothing sent)'), COUNT(*),
    ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY fh.minutes))::numeric, 1)
  FROM r
  JOIN flows f ON f.id = r.flow_id
  LEFT JOIN last_step ls ON ls.flow_run_id = r.id
  LEFT JOIN first_human fh ON fh.run_id = r.id
  GROUP BY r.day, f.name, COALESCE(ls.node_key, '(nothing sent)')
  ORDER BY r.day DESC, f.name, COUNT(*) DESC;
$$;
ALTER FUNCTION flow_dropoff_by_day(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION flow_dropoff_by_day(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION flow_dropoff_by_day(INTEGER) TO service_role;
