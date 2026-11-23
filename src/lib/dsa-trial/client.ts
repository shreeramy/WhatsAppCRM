// ============================================================
// DSA Management signup-link API (server-to-server).
//
//   POST <DSA_APP_URL>/api/integrations/signup-links
//   X-API-Key: <DSA_SIGNUP_API_KEY>
//
// Server-only: reads the key from the environment. Never log the key
// or the returned URL (the link is a secret: anyone holding it can sign
// up). Failures collapse to one `unavailable` result; the caller shows
// a friendly message and the status is logged for us.
// ============================================================

const TIMEOUT_MS = 10_000;
const NOTE_MAX = 120;

export type SignupLinkResult =
  | { ok: true; url: string; expiresAt: string }
  | { ok: false; reason: 'unavailable' };

/** True when both env vars are set (the button can work at all). */
export function dsaTrialConfigured(): boolean {
  return !!process.env.DSA_APP_URL && !!process.env.DSA_SIGNUP_API_KEY;
}

/** Trims to the API's 120-character limit. */
export function clampNote(note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim();
  return clean.length <= NOTE_MAX ? clean : `${clean.slice(0, NOTE_MAX - 1)}…`;
}

export async function requestSignupLink(args: { note: string; email?: string | null }): Promise<SignupLinkResult> {
  const base = process.env.DSA_APP_URL?.replace(/\/+$/, '');
  const key = process.env.DSA_SIGNUP_API_KEY;
  if (!base || !key) {
    console.warn('[dsa-trial] DSA_APP_URL / DSA_SIGNUP_API_KEY not set');
    return { ok: false, reason: 'unavailable' };
  }

  const body: Record<string, string> = { note: clampNote(args.note) };
  if (args.email) body.email = args.email;

  let res: Response;
  try {
    res = await fetch(`${base}/api/integrations/signup-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    console.warn(`[dsa-trial] signup-links ${timedOut ? 'timed out' : 'network error'}`);
    return { ok: false, reason: 'unavailable' };
  }

  if (!res.ok) {
    // 401 key wrong · 503 API off on their side · 422 bad field · 429 rate limit.
    console.warn(`[dsa-trial] signup-links failed: HTTP ${res.status}`);
    return { ok: false, reason: 'unavailable' };
  }

  const data = (await res.json().catch(() => null)) as { url?: unknown; expires_at?: unknown } | null;
  const url = typeof data?.url === 'string' ? data.url : '';
  const expiresAt = typeof data?.expires_at === 'string' ? data.expires_at : '';
  if (!/^https?:\/\//.test(url) || Number.isNaN(Date.parse(expiresAt))) {
    console.warn('[dsa-trial] signup-links returned an unexpected body');
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, url, expiresAt };
}
