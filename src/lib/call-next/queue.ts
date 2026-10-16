/**
 * Call Next — who an agent should call next, and why.
 *
 * Pure: the API route loads the rows, this ranks them. One entry per
 * contact, under its most urgent reason:
 *
 *   now   1 asked for a call (Call Requested) — not called since
 *         2 demo starting within 45 min
 *         3 customer wrote and is waiting for a reply
 *         4 follow-up overdue (most recently due first, so a fresh
 *           "call me in an hour" beats last week's backlog)
 *   today 4.5 didn't pick up last time — try again (after 2h, max 3 tries)
 *         5 didn't answer the welcome (No reply)
 *         6 saw the price, no next step (Price Sent)
 *         7 follow-up due later today
 *         8 watched the video a day+ ago (Nurture)
 *
 * A logged call outcome hides the lead until something new happens:
 * "no answer" for 2 hours (3 tries → off the list), "not interested"
 * for good; the others are covered by the follow-up they create.
 */

/** Tag / stage names the flow and the Call Next actions use. */
export const CALL_NEXT_NAMES = {
  tags: {
    callRequested: "Call Requested",
    noReply: "No reply",
    priceSent: "Price Sent",
    nurture: "Nurture",
    demoBooked: "Demo Booked",
    notReachable: "Not reachable",
    notInterested: "Not interested",
  },
  stages: { demoBooked: "Demo Booked", proposalSent: "Proposal Sent" },
} as const;

export type Outcome = "demo_booked" | "will_pay" | "call_later" | "no_answer" | "not_interested";

export interface QConversation {
  id: string;
  contact_id: string;
  name: string | null;
  phone: string | null;
  status: string;
  last_message_text: string | null;
  last_message_at: string | null;
  last_message_sender: string | null;
  unread_count: number;
}
export interface QTag {
  contact_id: string;
  name: string;
  added_at: string;
}
export interface QFollowUp {
  id: string;
  contact_id: string | null;
  conversation_id: string | null;
  type: string;
  title: string;
  due_at: string;
}
export interface QDeal {
  contact_id: string;
  value: number | null;
  status: string;
}
export interface QOutcome {
  contact_id: string;
  outcome: Outcome;
  created_at: string;
}

export type ReasonKey =
  | "followUpOverdue"
  | "callRequested"
  | "demoSoon"
  | "customerWaiting"
  | "retryCall"
  | "noReply"
  | "priceSent"
  | "followUpToday"
  | "nurture";

export interface QueueItem {
  contactId: string;
  conversationId: string | null;
  name: string;
  phone: string | null;
  tier: "now" | "today";
  rank: number;
  reason: ReasonKey;
  /** When the reason started (or the follow-up/demo time) — ISO. */
  since: string;
  followUpTitle?: string;
  lastMessage: string | null;
  dealValue: number | null;
}

export interface QueueInput {
  conversations: QConversation[];
  tags: QTag[];
  followUps: QFollowUp[];
  deals: QDeal[];
  outcomes: QOutcome[];
  /** contact id → epoch ms until which the agent pushed it back ("Later"). */
  skipped?: Record<string, number>;
  /** Contacts the agent can see but have no open chat (follow-up only). */
  extraContacts?: Array<{ id: string; name: string | null; phone: string | null }>;
  now: Date;
  /** End of the agent's local "today", as a Date. */
  endOfToday: Date;
}

const MIN = 60_000;
/** Overdue follow-ups: most recently due first. Everything else: oldest first. */
const newerFirst = (rank: number) => rank === 4;
const H = 60 * MIN;
const lc = (s: string) => s.trim().toLowerCase();

export function buildQueue(input: QueueInput): QueueItem[] {
  const now = input.now.getTime();
  const N = CALL_NEXT_NAMES.tags;

  const tagsBy = new Map<string, Map<string, number>>();
  for (const t of input.tags) {
    const m = tagsBy.get(t.contact_id) ?? new Map<string, number>();
    m.set(lc(t.name), Date.parse(t.added_at));
    tagsBy.set(t.contact_id, m);
  }
  const outcomesBy = new Map<string, QOutcome[]>();
  for (const o of input.outcomes) {
    const list = outcomesBy.get(o.contact_id) ?? [];
    list.push(o);
    outcomesBy.set(o.contact_id, list);
  }
  for (const list of outcomesBy.values()) list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const dealBy = new Map<string, QDeal[]>();
  for (const d of input.deals) dealBy.set(d.contact_id, [...(dealBy.get(d.contact_id) ?? []), d]);

  const convBy = new Map(input.conversations.map((c) => [c.contact_id, c]));
  const people = new Map<string, { name: string | null; phone: string | null }>();
  for (const c of input.conversations) people.set(c.contact_id, { name: c.name, phone: c.phone });
  for (const c of input.extraContacts ?? []) if (!people.has(c.id)) people.set(c.id, { name: c.name, phone: c.phone });

  const best = new Map<string, QueueItem>();
  const offer = (contactId: string, rank: number, reason: ReasonKey, since: string, extra: Partial<QueueItem> = {}) => {
    const cur = best.get(contactId);
    if (cur) {
      if (cur.rank < rank) return;
      if (cur.rank === rank) {
        // Same reason twice (e.g. two overdue follow-ups): keep the one that sorts first.
        const keepCur = newerFirst(rank)
          ? Date.parse(cur.since) >= Date.parse(since)
          : Date.parse(cur.since) <= Date.parse(since);
        if (keepCur) return;
      }
    }
    const conv = convBy.get(contactId);
    const p = people.get(contactId);
    const deals = dealBy.get(contactId) ?? [];
    const open = deals.find((d) => d.status === "open");
    best.set(contactId, {
      contactId,
      conversationId: conv?.id ?? null,
      name: p?.name || p?.phone || "Unknown",
      phone: p?.phone ?? null,
      tier: rank <= 4 ? "now" : "today",
      rank,
      reason,
      since,
      lastMessage: conv?.last_message_text ?? null,
      dealValue: open?.value ?? null,
      ...extra,
    });
  };

  const excluded = (contactId: string): boolean => {
    if ((input.skipped?.[contactId] ?? 0) > now) return true;
    const deals = dealBy.get(contactId) ?? [];
    if (deals.length && !deals.some((d) => d.status === "open")) return true; // won or lost
    const outs = outcomesBy.get(contactId) ?? [];
    const latest = outs[0];
    if (!latest) return false;
    const conv = convBy.get(contactId);
    const wroteAfter =
      conv?.last_message_sender === "customer" &&
      !!conv.last_message_at &&
      Date.parse(conv.last_message_at) > Date.parse(latest.created_at);
    if (wroteAfter) return false; // something new happened — back on the list
    if (latest.outcome === "not_interested") return true;
    const tries = outs.filter((o) => o.outcome === "no_answer" && now - Date.parse(o.created_at) < 7 * 24 * H).length;
    if (latest.outcome === "no_answer" && (tries >= 3 || now - Date.parse(latest.created_at) < 2 * H)) return true;
    return false;
  };
  const lastCallAt = (contactId: string) => {
    const o = outcomesBy.get(contactId)?.[0];
    return o ? Date.parse(o.created_at) : 0;
  };
  /** Tag added and nobody logged a call since. */
  const freshTag = (contactId: string, tag: string): number | null => {
    const at = tagsBy.get(contactId)?.get(lc(tag));
    if (at === undefined) return null;
    return lastCallAt(contactId) >= at ? null : at;
  };

  // Follow-ups (1, 3, 7)
  for (const f of input.followUps) {
    if (!f.contact_id) continue;
    const due = Date.parse(f.due_at);
    if (f.type === "meeting" && due >= now && due - now <= 45 * MIN) {
      offer(f.contact_id, 2, "demoSoon", f.due_at, { followUpTitle: f.title });
    } else if (due < now) {
      offer(f.contact_id, 4, "followUpOverdue", f.due_at, { followUpTitle: f.title });
    } else if (due <= input.endOfToday.getTime()) {
      offer(f.contact_id, 7, "followUpToday", f.due_at, { followUpTitle: f.title });
    }
  }

  for (const c of input.conversations) {
    const id = c.contact_id;
    const cr = freshTag(id, N.callRequested);
    if (cr !== null) offer(id, 1, "callRequested", new Date(cr).toISOString());
    if (
      c.last_message_sender === "customer" &&
      c.unread_count > 0 &&
      c.last_message_at &&
      Date.parse(c.last_message_at) > lastCallAt(id)
    ) {
      offer(id, 3, "customerWaiting", c.last_message_at);
    }
    const nr = freshTag(id, N.noReply);
    if (nr !== null) offer(id, 5, "noReply", new Date(nr).toISOString());
    const ps = freshTag(id, N.priceSent);
    const moved = freshTag(id, N.demoBooked) !== null || tagsBy.get(id)?.has(lc(N.demoBooked));
    if (ps !== null && !moved && cr === null) offer(id, 6, "priceSent", new Date(ps).toISOString());
    const nu = freshTag(id, N.nurture);
    if (nu !== null && now - nu >= 24 * H) offer(id, 8, "nurture", new Date(nu).toISOString());
  }

  // Didn't pick up: try again 2h later, up to 3 tries in a week.
  for (const [id, outs] of outcomesBy) {
    const latest = outs[0];
    if (latest?.outcome !== "no_answer" || !people.has(id)) continue;
    const tries = outs.filter((o) => o.outcome === "no_answer" && now - Date.parse(o.created_at) < 7 * 24 * H).length;
    if (tries < 3 && now - Date.parse(latest.created_at) >= 2 * H) {
      offer(id, 4.5, "retryCall", latest.created_at);
    }
  }

  return [...best.values()]
    .filter((item) => !excluded(item.contactId))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (newerFirst(a.rank) ? Date.parse(b.since) - Date.parse(a.since) : Date.parse(a.since) - Date.parse(b.since)),
    );
}
