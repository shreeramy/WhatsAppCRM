-- ============================================================
-- Call recording transcription + AI analysis (Sarvam)
--
-- Adds nullable columns only — existing recordings are untouched and
-- simply show as "not transcribed".
--
--   transcript_status   NULL (never) | processing | done | failed
--   transcript_job_id   Sarvam batch job id while processing
--   transcript          full text
--   transcript_segments diarized turns [{speaker, start, end, text}]
--   analysis            AI call analysis (summary, lead quality, score…)
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS transcript_status TEXT
    CHECK (transcript_status IN ('processing', 'done', 'failed')),
  ADD COLUMN IF NOT EXISTS transcript_job_id TEXT,
  ADD COLUMN IF NOT EXISTS transcript TEXT,
  ADD COLUMN IF NOT EXISTS transcript_segments JSONB,
  ADD COLUMN IF NOT EXISTS transcript_language TEXT,
  ADD COLUMN IF NOT EXISTS transcript_error TEXT,
  ADD COLUMN IF NOT EXISTS analysis JSONB,
  ADD COLUMN IF NOT EXISTS transcribed_at TIMESTAMPTZ;
