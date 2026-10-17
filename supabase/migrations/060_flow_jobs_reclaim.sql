-- ============================================================
-- Flow v2 jobs: recover jobs stuck in 'running'.
--
-- A tick that is cut off mid-batch (function timeout) used to leave its
-- claimed jobs in 'running' forever. Claims now also take back jobs that
-- have been 'running' for over 10 minutes. Only replaces the function
-- from 057 (flow-v2 only). Idempotent.
-- ============================================================

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
    WHERE (status = 'pending' AND due_at <= NOW())
       OR (status = 'running' AND processed_at < NOW() - INTERVAL '10 minutes')
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
