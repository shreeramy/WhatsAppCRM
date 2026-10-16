import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTagRef } from "@/lib/flows/tag-ref";
import { addContactTagIfAbsent } from "@/lib/contacts/tag-write";
import { localParts, zonedTime } from "@/lib/flows/v2/logic";
import {
  buildQueue,
  CALL_NEXT_NAMES,
  type Outcome,
  type QConversation,
  type QDeal,
  type QFollowUp,
  type QOutcome,
  type QTag,
  type QueueItem,
} from "./queue";

const TZ = "Asia/Kolkata";

/** Start / end of today in the business time zone (IST). */
function startOfLocalDay(now: Date, timezone = TZ): Date {
  const p = localParts(now, timezone);
  return zonedTime(p.year, p.month, p.day, 0, timezone);
}

export function endOfLocalDay(now: Date, timezone = TZ): Date {
  return new Date(startOfLocalDay(now, timezone).getTime() + 24 * 3600 * 1000 - 1);
}

async function inChunks<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await fn(ids.slice(i, i + 100))));
  return out;
}

export interface CallNextData {
  items: QueueItem[];
  doneToday: number;
  counts: { now: number; today: number };
}

/** Everything the Call Next screen needs for one agent. `db` = service role. */
export async function loadCallNext(db: SupabaseClient, accountId: string, agentId: string, now = new Date()): Promise<CallNextData> {
  const endOfToday = endOfLocalDay(now);

  const [{ data: convRows, error: convErr }, { data: fuRows, error: fuErr }] = await Promise.all([
    db
      .from("conversations")
      .select("id, contact_id, status, last_message_text, last_message_at, last_message_sender, unread_count, contact:contacts(name, phone)")
      .eq("account_id", accountId)
      .eq("assigned_agent_id", agentId)
      .neq("status", "closed")
      .order("last_message_at", { ascending: false })
      .limit(500),
    db
      .from("follow_ups")
      .select("id, contact_id, conversation_id, type, title, due_at")
      .eq("account_id", accountId)
      .eq("assigned_to", agentId)
      .is("completed_at", null)
      .lte("due_at", endOfToday.toISOString())
      .limit(500),
  ]);
  if (convErr) throw new Error(convErr.message);
  if (fuErr) throw new Error(fuErr.message);

  const conversations: QConversation[] = ((convRows ?? []) as unknown as Array<
    Omit<QConversation, "name" | "phone"> & { contact: { name: string | null; phone: string | null } | null }
  >).map(({ contact, ...c }) => ({ ...c, name: contact?.name ?? null, phone: contact?.phone ?? null }));
  const followUps = (fuRows ?? []) as QFollowUp[];

  const contactIds = [...new Set([...conversations.map((c) => c.contact_id), ...followUps.map((f) => f.contact_id).filter((x): x is string => !!x)])];
  const known = new Set(conversations.map((c) => c.contact_id));
  const extraIds = contactIds.filter((id) => !known.has(id));
  const since30 = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

  const [tags, deals, outcomes, extra, done] = await Promise.all([
    inChunks(contactIds, async (ids) => {
      const { data } = await db.from("contact_tags").select("contact_id, created_at, tags(name)").in("contact_id", ids);
      return ((data ?? []) as unknown as Array<{ contact_id: string; created_at: string; tags: { name: string } | null }>)
        .filter((r) => r.tags)
        .map((r): QTag => ({ contact_id: r.contact_id, name: r.tags!.name, added_at: r.created_at }));
    }),
    inChunks(contactIds, async (ids) => {
      const { data } = await db.from("deals").select("contact_id, value, status").eq("account_id", accountId).in("contact_id", ids);
      return (data ?? []) as QDeal[];
    }),
    inChunks(contactIds, async (ids) => {
      const { data } = await db
        .from("call_outcomes")
        .select("contact_id, outcome, created_at")
        .eq("account_id", accountId)
        .in("contact_id", ids)
        .gte("created_at", since30);
      return (data ?? []) as QOutcome[];
    }),
    inChunks(extraIds, async (ids) => {
      const { data } = await db.from("contacts").select("id, name, phone").in("id", ids);
      return (data ?? []) as Array<{ id: string; name: string | null; phone: string | null }>;
    }),
    db
      .from("call_outcomes")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId)
      .eq("agent_id", agentId)
      .gte("created_at", startOfLocalDay(now).toISOString()),
  ]);

  const items = buildQueue({ conversations, tags, followUps, deals, outcomes, extraContacts: extra, now, endOfToday });
  return {
    items: items.slice(0, 100),
    doneToday: done.count ?? 0,
    counts: { now: items.filter((i) => i.tier === "now").length, today: items.filter((i) => i.tier === "today").length },
  };
}

// ------------------------------------------------------------
// Logging a call outcome
// ------------------------------------------------------------

export interface OutcomeInput {
  accountId: string;
  agentId: string;
  contactId: string;
  conversationId: string | null;
  outcome: Outcome;
  /** Demo time / call-back time (ISO). */
  at?: string | null;
  reason?: string | null;
  note?: string | null;
}

async function addTag(db: SupabaseClient, accountId: string, contactId: string, name: string) {
  const tag = await resolveTagRef(db, accountId, name, { createMissing: true });
  await addContactTagIfAbsent(db, { accountId, contactId, tagId: tag.id });
}

async function openDeal(db: SupabaseClient, accountId: string, contactId: string) {
  const { data } = await db
    .from("deals")
    .select("id, pipeline_id, notes")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as Array<{ id: string; pipeline_id: string; notes: string | null }>)[0] ?? null;
}

async function moveDealToStage(db: SupabaseClient, dealId: string, pipelineId: string, stage: string): Promise<boolean> {
  const { data } = await db.from("pipeline_stages").select("id, name").eq("pipeline_id", pipelineId);
  const hit = ((data ?? []) as Array<{ id: string; name: string }>).find((s) => s.name.trim().toLowerCase() === stage.toLowerCase());
  if (!hit) return false;
  await db.from("deals").update({ stage_id: hit.id }).eq("id", dealId);
  return true;
}

async function addFollowUp(
  db: SupabaseClient,
  i: OutcomeInput,
  type: "call" | "meeting" | "follow_up",
  title: string,
  dueAt: Date,
  dealId: string | null,
) {
  const { error } = await db.from("follow_ups").insert({
    account_id: i.accountId,
    contact_id: i.contactId,
    conversation_id: i.conversationId,
    deal_id: dealId,
    type,
    title,
    due_at: dueAt.toISOString(),
    assigned_to: i.agentId,
    created_by: i.agentId,
  });
  if (error) throw new Error(`follow-up: ${error.message}`);
}

function shortWhen(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d);
}

/** Save the call and do the follow-on work (tags, deal stage, next follow-up). `db` = service role. */
export async function logOutcome(db: SupabaseClient, i: OutcomeInput): Promise<string[]> {
  const done: string[] = [];
  const now = new Date();
  const at = i.at ? new Date(i.at) : null;
  if ((i.outcome === "demo_booked" || i.outcome === "call_later") && (!at || Number.isNaN(at.getTime()))) {
    throw new Error("Pick a time");
  }

  const { error } = await db.from("call_outcomes").insert({
    account_id: i.accountId,
    contact_id: i.contactId,
    conversation_id: i.conversationId,
    agent_id: i.agentId,
    outcome: i.outcome,
    reason: i.reason ?? null,
    note: i.note?.trim() || null,
    next_at: at?.toISOString() ?? null,
  });
  if (error) throw new Error(error.message);

  // The call took care of anything that was due.
  const { data: closed } = await db
    .from("follow_ups")
    .update({ completed_at: now.toISOString() })
    .eq("account_id", i.accountId)
    .eq("contact_id", i.contactId)
    .eq("assigned_to", i.agentId)
    .is("completed_at", null)
    .lte("due_at", new Date(now.getTime() + 60 * 60000).toISOString())
    .select("id");
  if (closed?.length) done.push(`closed ${closed.length} follow-up(s)`);

  const N = CALL_NEXT_NAMES;
  const deal = await openDeal(db, i.accountId, i.contactId);

  switch (i.outcome) {
    case "demo_booked": {
      await addTag(db, i.accountId, i.contactId, N.tags.demoBooked);
      if (deal && (await moveDealToStage(db, deal.id, deal.pipeline_id, N.stages.demoBooked))) done.push("deal → Demo Booked");
      await addFollowUp(db, i, "meeting", `Demo – ${shortWhen(at!)}`, new Date(at!.getTime() - 15 * 60000), deal?.id ?? null);
      done.push("demo follow-up added");
      break;
    }
    case "will_pay": {
      if (deal && (await moveDealToStage(db, deal.id, deal.pipeline_id, N.stages.proposalSent))) done.push("deal → Proposal Sent");
      await addFollowUp(db, i, "follow_up", "Payment check", at ?? new Date(now.getTime() + 24 * 3600 * 1000), deal?.id ?? null);
      done.push("payment follow-up added");
      break;
    }
    case "call_later": {
      await addFollowUp(db, i, "call", "Call back", at!, deal?.id ?? null);
      done.push("call-back added");
      break;
    }
    case "no_answer": {
      const { count } = await db
        .from("call_outcomes")
        .select("id", { count: "exact", head: true })
        .eq("account_id", i.accountId)
        .eq("contact_id", i.contactId)
        .eq("outcome", "no_answer")
        .gte("created_at", new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString());
      if ((count ?? 0) >= 3) {
        await addTag(db, i.accountId, i.contactId, N.tags.notReachable);
        done.push("3 tries — tagged Not reachable");
      }
      break;
    }
    case "not_interested": {
      await addTag(db, i.accountId, i.contactId, N.tags.notInterested);
      if (deal) {
        const line = `Lost after call: ${i.reason ?? "other"}${i.note ? ` — ${i.note.trim()}` : ""}`;
        await db
          .from("deals")
          .update({ status: "lost", notes: deal.notes ? `${deal.notes}\n${line}` : line })
          .eq("id", deal.id);
        done.push("deal marked lost");
      }
      break;
    }
  }
  return done;
}
