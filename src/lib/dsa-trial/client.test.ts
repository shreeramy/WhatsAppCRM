import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampNote, requestSignupLink } from './client';

const KEY = 'test-secret-key-123';
const OK_BODY = {
  url: 'https://dsa.example/signup?t=abc',
  expires_at: '2026-11-18T04:00:09+00:00',
  trial_days: 7,
  single_use: true,
  email: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.DSA_APP_URL = 'https://dsa.example/';
  process.env.DSA_SIGNUP_API_KEY = KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
  delete process.env.DSA_APP_URL;
  delete process.env.DSA_SIGNUP_API_KEY;
});

/** Nothing we log may contain the key or the link. */
function expectNoSecretsLogged() {
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain(KEY);
  expect(logged).not.toContain('signup?t=');
}

describe('requestSignupLink', () => {
  it('posts the note with the key header and returns the link', async () => {
    fetchMock.mockResolvedValue(Response.json(OK_BODY));

    const res = await requestSignupLink({ note: 'WhatsApp lead Asha · 98xxxxxx10' });

    expect(res).toEqual({ ok: true, url: OK_BODY.url, expiresAt: OK_BODY.expires_at });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dsa.example/api/integrations/signup-links');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // expires_in_days left to the default; no email unless verified.
    expect(JSON.parse(init.body)).toEqual({ note: 'WhatsApp lead Asha · 98xxxxxx10' });
  });

  it('sends the email only when given', async () => {
    fetchMock.mockResolvedValue(Response.json(OK_BODY));
    await requestSignupLink({ note: 'x', email: 'asha@example.com' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).email).toBe('asha@example.com');
  });

  it.each([401, 503, 429, 422, 500])('maps HTTP %i to unavailable and logs only the status', async (status) => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: 'raw upstream error text' }, { status }),
    );

    const res = await requestSignupLink({ note: 'x' });

    expect(res).toEqual({ ok: false, reason: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry loop
    expect(JSON.stringify(warn.mock.calls)).toContain(`HTTP ${status}`);
    expect(JSON.stringify(res)).not.toContain('raw upstream');
    expectNoSecretsLogged();
  });

  it('treats a timeout as unavailable without retrying', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

    const res = await requestSignupLink({ note: 'x' });

    expect(res).toEqual({ ok: false, reason: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('timed out');
    expectNoSecretsLogged();
  });

  it('treats a network failure as unavailable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await requestSignupLink({ note: 'x' })).toEqual({ ok: false, reason: 'unavailable' });
    expectNoSecretsLogged();
  });

  it('rejects a 200 without a usable link', async () => {
    fetchMock.mockResolvedValue(Response.json({ url: 'nope' }));
    expect(await requestSignupLink({ note: 'x' })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not call out when not configured', async () => {
    delete process.env.DSA_SIGNUP_API_KEY;
    expect(await requestSignupLink({ note: 'x' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never logs the link on success', async () => {
    fetchMock.mockResolvedValue(Response.json(OK_BODY));
    await requestSignupLink({ note: 'x' });
    expectNoSecretsLogged();
  });
});

describe('clampNote', () => {
  it('keeps notes within 120 characters', () => {
    expect(clampNote('a'.repeat(200))).toHaveLength(120);
    expect(clampNote('  CRM   lead  ')).toBe('CRM lead');
  });
});
