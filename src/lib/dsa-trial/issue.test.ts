import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ requestSignupLink: vi.fn() }));
vi.mock('./client', () => ({ requestSignupLink: mocks.requestSignupLink }));

import { getOrIssueTrialLink, getTrialLink, trialNote } from './issue';

// ------------------------------------------------------------
// Minimal in-memory trial_links table with the unique
// (account_id, contact_id) constraint the migration adds.
// ------------------------------------------------------------
type Row = Record<string, unknown>;

function fakeDb(rows: Row[] = []) {
  let seq = 0;
  function builder() {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];
    const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
    const run = (): { data: Row | null; error: { code: string; message: string } | null } => {
      if (op === 'insert') {
        if (rows.some((r) => r.account_id === payload.account_id && r.contact_id === payload.contact_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { id: `row-${++seq}`, url: null, expires_at: null, ...payload };
        rows.push(row);
        return { data: { ...row }, error: null };
      }
      const hit = rows.filter(matches);
      if (op === 'update') hit.forEach((r) => Object.assign(r, payload));
      if (op === 'delete') hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { data: hit[0] ? { ...hit[0] } : null, error: null };
    };
    const b = {
      select: () => b,
      insert: (p: Row) => ((op = 'insert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      delete: () => ((op = 'delete'), b),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      single: async () => run(),
      maybeSingle: async () => run(),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  return { db: { from: () => builder() } as unknown as SupabaseClient, rows };
}

const NOW = new Date('2026-11-11T10:00:00Z');
const base = {
  accountId: 'acc-1',
  contactId: 'contact-1',
  source: 'bot' as const,
  note: 'WhatsApp lead Asha',
  now: () => NOW,
  sleep: async () => {},
};
const LINK = { ok: true, url: 'https://dsa.example/signup?t=abc', expiresAt: '2026-11-18T10:00:00Z' };

beforeEach(() => {
  mocks.requestSignupLink.mockReset();
});

describe('getOrIssueTrialLink', () => {
  it('issues and stores a new link on the first press', async () => {
    const { db, rows } = fakeDb();
    mocks.requestSignupLink.mockResolvedValue(LINK);

    const res = await getOrIssueTrialLink(db, base);

    expect(res).toEqual({ status: 'issued', url: LINK.url, expiresAt: LINK.expiresAt, reused: false });
    expect(mocks.requestSignupLink).toHaveBeenCalledWith({ note: 'WhatsApp lead Asha', email: undefined });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'issued', url: LINK.url, expires_at: LINK.expiresAt, source: 'bot' });
  });

  it('returns the stored link on a repeat press without calling the API again', async () => {
    const { db } = fakeDb();
    mocks.requestSignupLink.mockResolvedValue(LINK);

    await getOrIssueTrialLink(db, base);
    const again = await getOrIssueTrialLink(db, { ...base, source: 'agent' });

    expect(again).toEqual({ status: 'issued', url: LINK.url, expiresAt: LINK.expiresAt, reused: true });
    expect(mocks.requestSignupLink).toHaveBeenCalledTimes(1);
  });

  it('does not re-issue an expired link', async () => {
    const { db } = fakeDb([
      { id: 'r1', account_id: 'acc-1', contact_id: 'contact-1', status: 'issued', url: LINK.url,
        expires_at: '2026-11-01T00:00:00Z', requested_at: '2026-10-25T00:00:00Z' },
    ]);

    const res = await getOrIssueTrialLink(db, base);

    expect(res).toEqual({ status: 'expired', expiresAt: '2026-11-01T00:00:00Z' });
    expect(mocks.requestSignupLink).not.toHaveBeenCalled();
  });

  it('lets two simultaneous presses share one API call', async () => {
    const { db } = fakeDb();
    let release!: () => void;
    mocks.requestSignupLink.mockImplementation(
      () => new Promise((r) => (release = () => r(LINK))),
    );
    const sleep = vi.fn(async () => {
      release?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    const [a, b] = await Promise.all([
      getOrIssueTrialLink(db, { ...base, sleep }),
      getOrIssueTrialLink(db, { ...base, sleep }),
    ]);

    expect(mocks.requestSignupLink).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('issued');
    expect(b).toEqual(a.status === 'issued' ? { ...a, reused: true } : a);
  });

  it('frees the claim when the API fails, so a later press can try again', async () => {
    const { db, rows } = fakeDb();
    mocks.requestSignupLink.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });

    expect(await getOrIssueTrialLink(db, base)).toEqual({ status: 'unavailable' });
    expect(rows).toHaveLength(0);
    expect(mocks.requestSignupLink).toHaveBeenCalledTimes(1);

    mocks.requestSignupLink.mockResolvedValueOnce(LINK);
    expect((await getOrIssueTrialLink(db, base)).status).toBe('issued');
  });

  it('takes over a pending claim left behind by a crashed request', async () => {
    const { db } = fakeDb([
      { id: 'r1', account_id: 'acc-1', contact_id: 'contact-1', status: 'pending', url: null,
        expires_at: null, requested_at: '2026-11-11T09:50:00Z' },
    ]);
    mocks.requestSignupLink.mockResolvedValue(LINK);

    expect((await getOrIssueTrialLink(db, base)).status).toBe('issued');
    expect(mocks.requestSignupLink).toHaveBeenCalledTimes(1);
  });
});

describe('getTrialLink', () => {
  it('reads without calling the API', async () => {
    const { db } = fakeDb();
    expect(await getTrialLink(db, base)).toBeNull();
    expect(mocks.requestSignupLink).not.toHaveBeenCalled();
  });
});

describe('trialNote', () => {
  it('masks the phone and stays within 120 characters', () => {
    const note = trialNote({ who: 'WhatsApp lead', name: 'A'.repeat(200), phone: '919876543210', contactId: '0f8b1c2e-1111-2222-3333-444455556666' });
    expect(note.length).toBeLessThanOrEqual(120);
    expect(note).toContain('98xxxxxx10');
    expect(note).toContain('contact 0f8b1c2e-1111-2222-3333-444455556666');
    expect(note).not.toContain('9876543210');
  });
});
