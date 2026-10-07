-- ============================================================
-- Invited signups join the inviting account directly.
--
-- Before: every signup got a brand-new personal account (as owner),
-- and the invite was only applied when the user came back to
-- /join/<token> after confirming their email. If the confirmation
-- link didn't return there (Supabase redirect allow-list, opening the
-- mail on another device, …) the teammate ended up as owner of an
-- empty account of their own instead of in the team.
--
-- Now: the signup page sends the invite token as user metadata
-- (`invite_token`). If it matches a valid, unused invitation, the new
-- user's profile is created straight in the inviting account with the
-- invited role and the invitation is marked accepted — no personal
-- account is created. Signups without a valid token behave as before.
--
-- peek_invitation also reports 'joined' when the caller is the person
-- who already accepted the invite, so /join can send them on to the
-- dashboard instead of showing "invite already used".
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
  v_token TEXT;
  v_inv account_invitations%ROWTYPE;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_token := NULLIF(NEW.raw_user_meta_data->>'invite_token', '');

  IF v_token IS NOT NULL THEN
    SELECT * INTO v_inv
    FROM account_invitations
    WHERE token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')
      AND accepted_at IS NULL
      AND expires_at > NOW()
    FOR UPDATE;

    IF FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
      VALUES (NEW.id, v_full_name, NEW.email, v_inv.account_id, v_inv.role);

      UPDATE account_invitations
      SET accepted_at = NOW(),
          accepted_by_user_id = NEW.id
      WHERE id = v_inv.id;

      RETURN NEW;
    END IF;
  END IF;

  -- No (valid) invite: personal account, as before.
  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    -- The caller already joined with this invite (e.g. at signup).
    IF auth.uid() IS NOT NULL AND v_inv.accepted_by_user_id = auth.uid() THEN
      RETURN json_build_object('ok', false, 'reason', 'joined');
    END IF;
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at
  );
END;
$$;

ALTER FUNCTION public.peek_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;
