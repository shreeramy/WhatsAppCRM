-- ============================================================
-- Time spent on the platform, per teammate per day (Team Report).
--
-- The dashboard heartbeat calls touch_presence() every ~30s per open
-- tab. Each beat now also adds the time since the previous beat to
-- today's row in member_activity_daily:
--   * online_seconds — tab open (active or idle)
--   * active_seconds — tab visible and used within the last 5 minutes
-- The interval is credited with the status it had (the previous
-- beat's), and capped at 75s so a closed laptop or lost connection
-- isn't counted. Using the single member_presence row as the clock
-- means several open tabs don't double-count.
--
-- Days are India time (Asia/Kolkata).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS member_activity_daily (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  online_seconds INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_member_activity_daily_account_day
  ON member_activity_daily(account_id, day);

ALTER TABLE member_activity_daily ENABLE ROW LEVEL SECURITY;

-- Owners/admins see everyone's time; others only their own. Writes
-- happen only inside touch_presence (SECURITY DEFINER).
DROP POLICY IF EXISTS member_activity_daily_select ON member_activity_daily;
CREATE POLICY member_activity_daily_select ON member_activity_daily FOR SELECT
  USING (is_account_member(account_id, 'admin') OR user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_presence(
  p_status TEXT DEFAULT 'online'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_prev_status TEXT;
  v_prev_seen TIMESTAMPTZ;
  v_delta INTEGER;
  v_day DATE := (NOW() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = auth.uid();
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  -- Previous beat (any tab) — the clock for the time to credit.
  SELECT status, last_seen_at INTO v_prev_status, v_prev_seen
  FROM member_presence
  WHERE user_id = auth.uid()
  FOR UPDATE;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (auth.uid(), v_account_id, p_status, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now(),
        account_id   = excluded.account_id;

  v_delta := CASE
    WHEN v_prev_seen IS NULL THEN 0
    ELSE LEAST(GREATEST(EXTRACT(EPOCH FROM (now() - v_prev_seen))::INTEGER, 0), 75)
  END;

  INSERT INTO member_activity_daily AS a (
    user_id, account_id, day, online_seconds, active_seconds, first_seen_at, last_seen_at
  ) VALUES (
    auth.uid(), v_account_id, v_day,
    v_delta,
    CASE WHEN v_prev_status = 'online' THEN v_delta ELSE 0 END,
    now(), now()
  )
  ON CONFLICT (user_id, day) DO UPDATE
    SET online_seconds = a.online_seconds + excluded.online_seconds,
        active_seconds = a.active_seconds + excluded.active_seconds,
        last_seen_at   = now(),
        account_id     = excluded.account_id;
END;
$$;
