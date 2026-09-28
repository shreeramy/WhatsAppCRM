-- ============================================================
-- INVITE-ONLY SIGNUP
--
-- Supabase Auth "Before User Created" hook: a new account can only be
-- created with a valid, unused, unexpired team invitation token (the
-- one in the invite link an owner/admin shares from Settings → Team
-- members). The signup page passes it as `user_metadata.invite_token`.
--
-- Exception: the very first user of a fresh install (no users yet) may
-- sign up, so a new deployment can bootstrap its owner.
--
-- Enforced by Supabase Auth itself, so it can't be skipped by calling
-- the Auth API directly. After running this migration, turn it on in
-- Supabase Dashboard → Authentication → Hooks → "Before User Created"
-- → Postgres function `public.hook_require_invite_for_signup`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.hook_require_invite_for_signup(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token TEXT;
BEGIN
  -- Fresh install: let the first person in (they become the owner).
  IF NOT EXISTS (SELECT 1 FROM auth.users) THEN
    RETURN '{}'::JSONB;
  END IF;

  v_token := COALESCE(
    event->'user'->'user_metadata'->>'invite_token',
    event->'user'->'raw_user_meta_data'->>'invite_token'
  );

  IF v_token IS NOT NULL AND length(v_token) > 0 AND EXISTS (
    SELECT 1
    FROM account_invitations
    WHERE token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')
      AND accepted_at IS NULL
      AND expires_at > NOW()
  ) THEN
    RETURN '{}'::JSONB;
  END IF;

  RETURN jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Signup is by invitation only. Ask the account owner for an invite link.'
    )
  );
END;
$$;

ALTER FUNCTION public.hook_require_invite_for_signup(JSONB) OWNER TO postgres;

-- Only Supabase Auth may call it.
REVOKE ALL ON FUNCTION public.hook_require_invite_for_signup(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hook_require_invite_for_signup(JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hook_require_invite_for_signup(JSONB) TO supabase_auth_admin;
