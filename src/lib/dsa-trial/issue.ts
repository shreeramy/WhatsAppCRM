// ============================================================
// One DSA Management trial link per contact (table trial_links,
// migration 066). Used by the WhatsApp bot and the chat sidebar.
//
//   valid stored link → returned, no API call
//   expired link      → 'expired' (never re-issued automatically)
//   none yet          → claim a 'pending' row, call the API, store it
//
// The unique (account_id, contact_id) index makes the claim safe for
// double taps and simultaneous requests: only the inserter calls the
// API; the others wait briefly and read the stored link. A failed call
// deletes the claim, so a later press can try again (no retry loop).
// Pass the service-role client: members can only read this table.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { requestSignupLink } from './client';

/** A 'pending' claim older than this is from a crashed request; take it over. */
const STALE_CLAIM_MS = 60_000;
/** How long a concurrent request waits for the claimer (API timeout + slack). */
const WAIT_MS = 12_000;
const POLL_MS = 1_000;

export type TrialLinkState =
  | { status: 'issued'; url: string; expiresAt: string; reused: boolean }
  | { status: 'expired'; expiresAt: string }
  | { status: 'unavailable' };

interface Row {
  id: string;
  status: 'pending' | 'issued';
  url: string | null;
  expires_at: string | null;
  requested_at: string;
}

const COLUMNS = 'id, status, url, expires_at, requested_at';

export interface IssueArgs {
  accountId: string;
  contactId: string;
  source: 'bot' | 'agent';
  /** CRM user who pressed the button (agent source). */
  requestedBy?: string | null;
  /** Shown to the DSA Management admin (≤ 120 chars, trimmed by the client). */
  note: string;
  /** Verified email only; leave out otherwise. */
  email?: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

function fromRow(row: Row, now: Date): TrialLinkState | null {
  if (row.status !== 'issued' || !row.url || !row.expires_at) return null;
  return new Date(row.expires_at).getTime() > now.getTime()
    ? { status: 'issued', url: row.url, expiresAt: row.expires_at, reused: true }
    : { status: 'expired', expiresAt: row.expires_at };
}

async function readRow(db: SupabaseClient, a: IssueArgs): Promise<Row | null> {
  const { data } = await db
    .from('trial_links')
    .select(COLUMNS)
    .eq('account_id', a.accountId)
    .eq('contact_id', a.contactId)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

/** Stored state only — never calls the API (sidebar on load). */
export async function getTrialLink(
  db: SupabaseClient,
  a: Pick<IssueArgs, 'accountId' | 'contactId' | 'now'>,
): Promise<TrialLinkState | null> {
  const row = await readRow(db, a as IssueArgs);
  return row ? fromRow(row, (a.now ?? (() => new Date()))()) : null;
}

export async function getOrIssueTrialLink(db: SupabaseClient, a: IssueArgs): Promise<TrialLinkState> {
  const now = a.now ?? (() => new Date());
  const sleep = a.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let row = await readRow(db, a);
  if (row) {
    const state = fromRow(row, now());
    if (state) return state;
  }

  // Claim: insert a pending row, or take over a stale one.
  let claimed: Row | null = null;
  if (!row) {
    const { data, error } = await db
      .from('trial_links')
      .insert({
        account_id: a.accountId,
        contact_id: a.contactId,
        status: 'pending',
        source: a.source,
        requested_by: a.requestedBy ?? null,
        requested_at: now().toISOString(),
      })
      .select(COLUMNS)
      .single();
    if (data) claimed = data as Row;
    else if (!isUniqueViolation(error)) {
      console.warn('[dsa-trial] could not claim trial link:', error?.message);
      return { status: 'unavailable' };
    }
  } else if (now().getTime() - new Date(row.requested_at).getTime() > STALE_CLAIM_MS) {
    const { data } = await db
      .from('trial_links')
      .update({ requested_at: now().toISOString(), source: a.source, requested_by: a.requestedBy ?? null })
      .eq('id', row.id)
      .eq('status', 'pending')
      .eq('requested_at', row.requested_at)
      .select(COLUMNS)
      .maybeSingle();
    if (data) claimed = data as Row;
  }

  if (!claimed) {
    // Someone else is asking right now: wait for their result.
    for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
      await sleep(POLL_MS);
      row = await readRow(db, a);
      if (!row) return { status: 'unavailable' }; // their call failed
      const state = fromRow(row, now());
      if (state) return state;
    }
    return { status: 'unavailable' };
  }

  const res = await requestSignupLink({ note: a.note, email: a.email });
  if (!res.ok) {
    await db.from('trial_links').delete().eq('id', claimed.id).eq('status', 'pending');
    return { status: 'unavailable' };
  }
  const { error } = await db
    .from('trial_links')
    .update({ status: 'issued', url: res.url, expires_at: res.expiresAt })
    .eq('id', claimed.id);
  if (error) console.warn('[dsa-trial] could not store trial link:', error.message);
  return { status: 'issued', url: res.url, expiresAt: res.expiresAt, reused: false };
}

/** "CRM lead Asha · 98xxxxxx10 · contact <id>" — what the DSA admin sees. */
export function trialNote(args: { who: string; name: string | null; phone: string | null; contactId: string }): string {
  const digits = (args.phone ?? '').replace(/\D/g, '').slice(-10);
  const masked = digits.length >= 4 ? `${digits.slice(0, 2)}xxxxxx${digits.slice(-2)}` : '';
  const tail = [masked, `contact ${args.contactId}`].filter(Boolean).join(' · ');
  const room = 120 - tail.length - args.who.length - 5;
  const name = (args.name ?? '').trim().slice(0, Math.max(room, 0));
  return [`${args.who} ${name}`.trim(), tail].join(' · ');
}
