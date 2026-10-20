-- ============================================================
-- Voice reminder campaigns (Plivo).
--
-- A campaign calls every contact with a tag (or a fixed list) at a set
-- time and plays a recording. Pressing 1 sends the joining link on
-- WhatsApp. Unanswered calls are retried once after a few minutes.
-- Run by /api/voice/tick every minute (pg_cron below).
--
-- Additive only: two new tables, no existing data touched.
-- ============================================================

CREATE TABLE IF NOT EXISTS voice_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  audio_url TEXT NOT NULL,
  -- Audience: contacts with this tag, or exactly these contacts.
  tag TEXT,
  contact_ids UUID[],
  -- Sent on WhatsApp when the lead presses 1: {"en":{"name","language"},"hi":{...}}, params [first_name, join_link].
  join_link TEXT,
  wa_templates JSONB,
  scheduled_at TIMESTAMPTZ NOT NULL,
  retry_after_minutes INTEGER NOT NULL DEFAULT 5,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'calling', 'done', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voice_campaign_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES voice_campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  -- queued → dialing → answered | link_sent | no_answer | busy | failed
  status TEXT NOT NULL DEFAULT 'queued',
  request_uuid TEXT,
  hangup_cause TEXT,
  duration_seconds INTEGER,
  digits TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id, attempt)
);
CREATE INDEX IF NOT EXISTS voice_campaign_calls_campaign_idx ON voice_campaign_calls (campaign_id, status);

ALTER TABLE voice_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_campaign_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS voice_campaigns_read ON voice_campaigns;
CREATE POLICY voice_campaigns_read ON voice_campaigns FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS voice_campaign_calls_read ON voice_campaign_calls;
CREATE POLICY voice_campaign_calls_read ON voice_campaign_calls FOR SELECT
  USING (EXISTS (SELECT 1 FROM voice_campaigns c WHERE c.id = campaign_id AND is_account_member(c.account_id)));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wacrm-voice-tick';
    PERFORM cron.schedule(
      'wacrm-voice-tick',
      '* * * * *',
      $cron$
        SELECT net.http_post(
          url := rtrim(c.app_url, '/') || '/api/voice/tick',
          body := '{}'::jsonb,
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', c.secret),
          timeout_milliseconds := 30000
        )
        FROM public.push_dispatch_config c
        WHERE EXISTS (
          SELECT 1 FROM public.voice_campaigns
          WHERE (status = 'scheduled' AND scheduled_at <= NOW()) OR status = 'calling'
        )
      $cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule voice tick (%).', SQLERRM;
END $$;
