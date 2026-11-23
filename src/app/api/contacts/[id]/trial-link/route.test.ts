import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  contact: { id: 'contact-1', name: 'Asha', phone: '919876543210' } as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
}));

class UnauthorizedError extends Error {
  status = 401;
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (err: unknown) =>
    Response.json({ error: 'Unauthorized' }, { status: err instanceof UnauthorizedError ? 401 : 500 }),
}));

// Service-role client: a one-table store for trial_links.
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      let op = 'select';
      let payload: Record<string, unknown> = {};
      const run = () => {
        if (op === 'insert') {
          const row = { id: 'row-1', ...payload };
          mocks.rows.push(row);
          return { data: row, error: null };
        }
        if (op === 'update') mocks.rows.forEach((r) => Object.assign(r, payload));
        if (op === 'delete') mocks.rows.length = 0;
        return { data: mocks.rows[0] ?? null, error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (p: Record<string, unknown>) => ((op = 'insert'), (payload = p), b),
        update: (p: Record<string, unknown>) => ((op = 'update'), (payload = p), b),
        delete: () => ((op = 'delete'), b),
        eq: () => b,
        single: async () => run(),
        maybeSingle: async () => run(),
        then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
      };
      return b;
    },
  }),
}));

import { GET, POST } from './route';

const KEY = 'route-test-secret-key';
const scoped = {
  from: () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: mocks.contact, error: null }),
    };
    return b;
  },
};
const params = { params: Promise.resolve({ id: 'contact-1' }) };
const req = (method = 'POST') => new Request('http://localhost/api/contacts/contact-1/trial-link', { method });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.DSA_APP_URL = 'https://dsa.example';
  process.env.DSA_SIGNUP_API_KEY = KEY;
  mocks.rows.length = 0;
  mocks.contact = { id: 'contact-1', name: 'Asha', phone: '919876543210' };
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({ supabase: scoped, accountId: 'acc-1', userId: 'user-1', role: 'agent' });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/api/contacts/[id]/trial-link', () => {
  it('refuses a logged-out request without calling DSA Management', async () => {
    mocks.requireRole.mockRejectedValue(new UnauthorizedError());

    const res = await POST(req(), params);

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an agent and returns the link, never the key', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ url: 'https://dsa.example/signup?t=abc', expires_at: '2099-01-01T00:00:00+00:00' }),
    );

    const res = await POST(req(), params);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(JSON.parse(text)).toEqual({
      status: 'issued',
      url: 'https://dsa.example/signup?t=abc',
      expires_at: '2099-01-01T00:00:00+00:00',
    });
    expect(text).not.toContain(KEY);
    const note = JSON.parse(fetchMock.mock.calls[0][1].body).note as string;
    expect(note).toContain('Asha');
    expect(note).toContain('contact contact-1');
  });

  it('returns the same link on a repeat press with no second API call', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ url: 'https://dsa.example/signup?t=abc', expires_at: '2099-01-01T00:00:00+00:00' }),
    );

    const first = await (await POST(req(), params)).json();
    const second = await (await POST(req(), params)).json();

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 503, 429])('shows only a generic status when DSA Management answers %i', async (status) => {
    fetchMock.mockResolvedValue(Response.json({ detail: 'Invalid API key xyz' }, { status }));

    const res = await POST(req(), params);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ status: 'unavailable' });
    expect(text).not.toContain('Invalid API key');
  });

  it('shows the generic status on a timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    expect(await (await POST(req(), params)).json()).toEqual({ status: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET reads the stored state and never calls DSA Management', async () => {
    const res = await GET(req('GET'), params);
    expect(await res.json()).toEqual({ status: 'none' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s for a contact outside the account', async () => {
    mocks.contact = null;
    expect((await POST(req(), params)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
