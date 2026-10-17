-- ============================================================
-- Flow v2 tick: also wake the app for jobs stuck in 'running' (>10 min)
-- so they are reclaimed (see 060). Re-creates only the flow-v2 cron job.
-- ============================================================
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
          WHERE (status = 'pending' AND due_at <= NOW())
             OR (status = 'running' AND processed_at < NOW() - INTERVAL '10 minutes')
        )
      $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not reschedule flow v2 tick (%).', SQLERRM;
END $$;
