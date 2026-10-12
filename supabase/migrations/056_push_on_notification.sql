-- ============================================================
-- Phone push for in-app notifications
--
-- Every row inserted into `notifications` (chat assigned to you —
-- trigger from 027; follow-up due — pg_cron job from 043) is also sent
-- as a Web Push to the recipient's phones/computers. The trigger makes
-- an async HTTP call (pg_net) to the app's /api/push/notification,
-- which looks the row up and pushes it.
--
-- Adds NEW objects only — no existing table or row is altered:
--   * pg_net extension
--   * push_dispatch_config — app URL + shared secret (one row, filled in
--     outside git; no client access)
--   * push_on_notification() trigger on notifications
--
-- Never blocks the notification insert: any failure is a WARNING.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS push_dispatch_config (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  app_url TEXT NOT NULL,
  secret TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS on with no policies: only postgres / service role can read it.
ALTER TABLE push_dispatch_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_dispatch_config FROM anon, authenticated;

CREATE OR REPLACE FUNCTION push_on_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  cfg push_dispatch_config%ROWTYPE;
BEGIN
  SELECT * INTO cfg FROM push_dispatch_config WHERE id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := rtrim(cfg.app_url, '/') || '/api/push/notification',
    body := jsonb_build_object('id', NEW.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', cfg.secret
    ),
    timeout_milliseconds := 5000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push_on_notification failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION push_on_notification() OWNER TO postgres;
REVOKE ALL ON FUNCTION push_on_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_notification_push ON notifications;
CREATE TRIGGER on_notification_push
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION push_on_notification();
