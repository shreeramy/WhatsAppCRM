-- ============================================================
-- Drip (paced) broadcasts.
--
-- A broadcast with `drip` set is sent slowly by /api/broadcasts/drip
-- instead of all at once: a few recipients per minute, only inside a
-- daily time window, never more than a daily cap. Its audience is
-- resolved when it starts (so "everyone tagged Webinar Registered"
-- means whoever has the tag at that moment), and each recipient gets
-- the template in their own language.
--
-- Additive only: existing broadcasts (drip IS NULL) are untouched.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS drip JSONB;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE broadcast_recipients ADD COLUMN IF NOT EXISTS template_language TEXT;

CREATE INDEX IF NOT EXISTS broadcasts_drip_due_idx
  ON broadcasts (scheduled_at)
  WHERE drip IS NOT NULL AND status IN ('scheduled', 'sending');

-- Every minute: if a drip broadcast is due or running, ask the app to
-- send its next few messages. Same URL + secret as the flow tick (056).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wacrm-broadcast-drip';
    PERFORM cron.schedule(
      'wacrm-broadcast-drip',
      '* * * * *',
      $cron$
        SELECT net.http_post(
          url := rtrim(c.app_url, '/') || '/api/broadcasts/drip',
          body := '{}'::jsonb,
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', c.secret),
          timeout_milliseconds := 30000
        )
        FROM public.push_dispatch_config c
        WHERE EXISTS (
          SELECT 1 FROM public.broadcasts
          WHERE drip IS NOT NULL
            AND status IN ('scheduled', 'sending')
            AND scheduled_at <= NOW()
        )
      $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule broadcast drip (%).', SQLERRM;
END $$;
