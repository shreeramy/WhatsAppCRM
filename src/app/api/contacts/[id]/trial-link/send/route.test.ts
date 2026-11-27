import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getTrialLink: vi.fn(),
  engineSendTemplate: vi.fn(),
  bundle: null as unknown,
  lang: 'en' as string | undefined,
  contact: { id: 'c1', phone: '919876543210' } as Record<string, unknown> | null,
  conv: { id: 'conv1' } as Record<string, unknown> | null,
}));

class UnauthorizedError extends Error {
  status = 401;
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (err: unknown) =>
    Response.json({ error: 'Unauthorized' }, { status: err instanceof UnauthorizedError ? 401 : 500 }),
}));
vi.mock('@/lib/dsa-trial/issue', () => ({ getTrialLink: mocks.getTrialLink }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: mocks.engineSendTemplate }));
vi.mock('@/lib/flows/v2/engine', () => ({ loadV2Flows: async () => [mocks.bundle] }));
vi.mock('@/lib/flows/v2/settings', () => ({ pickBundle: (b: unknown[]) => b[0] ?? null }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b, eq: () => b, order: () => b, limit: () => b,
        maybeSingle: async () => ({ data: mocks.lang ? { vars: { lang: mocks.lang } } : null }),
      };
      return b;
    },
  }),
}));

import { POST } from './route';

const scoped = {
  from: (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b,
      maybeSingle: async () => ({ data: table === 'contacts' ? mocks.contact : mocks.conv }),
    };
    return b;
  },
};
const params = { params: Promise.resolve({ id: 'c1' }) };
const req = (body: unknown = { conversation_id: 'conv1' }) =>
  new Request('http://localhost/api/contacts/c1/trial-link/send', { method: 'POST', body: JSON.stringify(body) });
const TEMPLATES = { en: { name: 'tpl_en', language: 'en' }, hi: { name: 'tpl_hi', language: 'hi' } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ supabase: scoped, accountId: 'acc', userId: 'agent-1', role: 'agent' });
  mocks.getTrialLink.mockResolvedValue({ status: 'issued', url: 'https://dsa.example/s?t=1', expiresAt: '2026-12-04T10:00:00Z' });
  mocks.engineSendTemplate.mockResolvedValue({ whatsapp_message_id: 'wamid.1' });
  mocks.bundle = { settings: { trial_link_templates: TEMPLATES, working_hours: { timezone: 'Asia/Kolkata' } } };
  mocks.lang = 'en';
  mocks.contact = { id: 'c1', phone: '919876543210' };
  mocks.conv = { id: 'conv1' };
});

describe('POST /api/contacts/[id]/trial-link/send', () => {
  it('refuses a logged-out request', async () => {
    mocks.requireRole.mockRejectedValue(new UnauthorizedError());
    expect((await POST(req(), params)).status).toBe(401);
    expect(mocks.engineSendTemplate).not.toHaveBeenCalled();
  });

  it('sends the stored link and expiry as the template params', async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(mocks.engineSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateName: 'tpl_en', language: 'en', conversationId: 'conv1', userId: 'agent-1',
      params: ['https://dsa.example/s?t=1', '4 Dec 2026'],
    }));
  });

  it("uses the Hindi template for a Hindi lead", async () => {
    mocks.lang = 'hi';
    await POST(req(), params);
    expect(mocks.engineSendTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateName: 'tpl_hi', language: 'hi' }));
  });

  it('409s when the contact has no active link', async () => {
    mocks.getTrialLink.mockResolvedValue({ status: 'expired', expiresAt: '2026-01-01T00:00:00Z' });
    expect((await POST(req(), params)).status).toBe(409);
    expect(mocks.engineSendTemplate).not.toHaveBeenCalled();
  });

  it('503s when no template is configured', async () => {
    mocks.bundle = { settings: { working_hours: { timezone: 'Asia/Kolkata' } } };
    expect((await POST(req(), params)).status).toBe(503);
  });

  it('404s for a conversation that is not this contact\'s', async () => {
    mocks.conv = null;
    expect((await POST(req(), params)).status).toBe(404);
  });
});
