import type { SupabaseClient } from "@supabase/supabase-js";

// Team Report queries. Everything is counted per teammate with cheap
// `head: true` count queries (teams are small), so no row caps apply.
// RLS already limits this to the caller's account; the page itself is
// owners/admins only.

export interface TeamMember {
  /** profiles.id — what deals.assigned_to points at. */
  profileId: string;
  /** auth user id — everything else. */
  userId: string;
  name: string;
  role: string;
}

export interface MemberStats {
  /** Seconds the tab was open and in use (not idle). */
  activeSeconds: number;
  /** Seconds the tab was open at all. */
  onlineSeconds: number;
  messagesSent: number;
  notes: number;
  tagsAdded: number;
  dealsCreated: number;
  dealsWon: number;
  followUpsDone: number;
  followUpsOverdue: number;
  recordings: number;
  recordingSeconds: number;
  openChats: number;
  openDeals: number;
}

export interface Range {
  /** ISO timestamps; null = unbounded. */
  from: string | null;
  to: string | null;
  /** yyyy-MM-dd equivalents for DATE columns. */
  fromDay: string | null;
  toDay: string | null;
}

interface RangeFilterable<T> {
  gte(column: string, value: string): T;
  lte(column: string, value: string): T;
}

function within<T extends RangeFilterable<T>>(
  q: T,
  column: string,
  from: string | null,
  to: string | null,
): T {
  let out = q;
  if (from) out = out.gte(column, from);
  if (to) out = out.lte(column, to);
  return out;
}

async function count(
  q: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  const { count: n, error } = await q;
  if (error) throw error;
  return n ?? 0;
}

export async function loadMemberStats(
  db: SupabaseClient,
  accountId: string,
  m: TeamMember,
  r: Range,
): Promise<MemberStats> {
  const head = { count: "exact" as const, head: true };
  const nowIso = new Date().toISOString();

  const [
    messagesSent,
    notes,
    tagsAdded,
    dealsCreated,
    dealsWon,
    followUpsDone,
    followUpsOverdue,
    openChats,
    openDeals,
    recs,
    time,
  ] = await Promise.all([
    count(
      within(
        db.from("messages").select("id", head).eq("sender_type", "agent").eq("sender_id", m.userId),
        "created_at",
        r.from,
        r.to,
      ),
    ),
    count(within(db.from("contact_notes").select("id", head).eq("user_id", m.userId), "created_at", r.from, r.to)),
    count(within(db.from("contact_tags").select("id", head).eq("added_by", m.userId), "created_at", r.from, r.to)),
    count(
      within(
        db.from("deals").select("id", head).eq("account_id", accountId).eq("user_id", m.userId),
        "created_at",
        r.from,
        r.to,
      ),
    ),
    count(
      within(
        db.from("deals").select("id", head).eq("account_id", accountId).eq("assigned_to", m.profileId).eq("status", "won"),
        "updated_at",
        r.from,
        r.to,
      ),
    ),
    count(
      within(
        db.from("follow_ups").select("id", head).eq("account_id", accountId).eq("assigned_to", m.userId),
        "completed_at",
        r.from,
        r.to,
      ).not("completed_at", "is", null),
    ),
    count(
      db
        .from("follow_ups")
        .select("id", head)
        .eq("account_id", accountId)
        .eq("assigned_to", m.userId)
        .is("completed_at", null)
        .lt("due_at", nowIso),
    ),
    count(
      db
        .from("conversations")
        .select("id", head)
        .eq("account_id", accountId)
        .eq("assigned_agent_id", m.userId)
        .neq("status", "closed"),
    ),
    count(
      db
        .from("deals")
        .select("id", head)
        .eq("account_id", accountId)
        .eq("assigned_to", m.profileId)
        .not("status", "in", "(won,lost)"),
    ),
    within(
      db
        .from("call_recordings")
        .select("duration_seconds", { count: "exact" })
        .eq("account_id", accountId)
        .eq("uploaded_by", m.userId)
        .limit(5000),
      "call_date",
      r.fromDay,
      r.toDay,
    ),
    within(
      db
        .from("member_activity_daily")
        .select("active_seconds, online_seconds")
        .eq("user_id", m.userId)
        .limit(1000),
      "day",
      r.fromDay,
      r.toDay,
    ),
  ]);

  if (recs.error) throw recs.error;
  if (time.error) throw time.error;
  const timeRows = (time.data ?? []) as { active_seconds: number; online_seconds: number }[];
  const recordingSeconds = (recs.data ?? []).reduce(
    (s, row) => s + ((row as { duration_seconds: number | null }).duration_seconds ?? 0),
    0,
  );

  return {
    activeSeconds: timeRows.reduce((s, d) => s + d.active_seconds, 0),
    onlineSeconds: timeRows.reduce((s, d) => s + d.online_seconds, 0),
    messagesSent,
    notes,
    tagsAdded,
    dealsCreated,
    dealsWon,
    followUpsDone,
    followUpsOverdue,
    recordings: recs.count ?? 0,
    recordingSeconds,
    openChats,
    openDeals,
  };
}

export type ActivityKind = "note" | "tag" | "deal" | "followUp" | "recording";

export interface ActivityItem {
  kind: ActivityKind;
  at: string;
  text: string;
  contact: string | null;
}

const ACTIVITY_LIMIT = 100;

/** Recent things one teammate did, newest first (max 100 per kind). */
export async function loadMemberActivity(
  db: SupabaseClient,
  accountId: string,
  m: TeamMember,
  r: Range,
  contactLabel: (c: { name?: string | null; phone?: string | null } | null) => string | null,
): Promise<ActivityItem[]> {
  type Contact = { name: string | null; phone: string | null } | null;
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  const [notes, tags, deals, fus, recs] = await Promise.all([
    within(
      db.from("contact_notes").select("note_text, created_at, contact:contacts(name, phone)").eq("user_id", m.userId),
      "created_at",
      r.from,
      r.to,
    )
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    within(
      db.from("contact_tags").select("created_at, tag:tags(name), contact:contacts(name, phone)").eq("added_by", m.userId),
      "created_at",
      r.from,
      r.to,
    )
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    within(
      db
        .from("deals")
        .select("title, value, currency, created_at, contact:contacts(name, phone)")
        .eq("account_id", accountId)
        .eq("user_id", m.userId),
      "created_at",
      r.from,
      r.to,
    )
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    within(
      db
        .from("follow_ups")
        .select("title, completed_at, contact:contacts(name, phone)")
        .eq("account_id", accountId)
        .eq("assigned_to", m.userId),
      "completed_at",
      r.from,
      r.to,
    )
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
    within(
      db
        .from("call_recordings")
        .select("file_name, created_at, call_date, contact:contacts(name, phone), phone")
        .eq("account_id", accountId)
        .eq("uploaded_by", m.userId),
      "call_date",
      r.fromDay,
      r.toDay,
    )
      .order("created_at", { ascending: false })
      .limit(ACTIVITY_LIMIT),
  ]);

  const items: ActivityItem[] = [];
  for (const n of (notes.data ?? []) as { note_text: string; created_at: string; contact: Contact | Contact[] }[]) {
    items.push({ kind: "note", at: n.created_at, text: n.note_text, contact: contactLabel(one(n.contact)) });
  }
  for (const t of (tags.data ?? []) as {
    created_at: string;
    tag: { name: string } | { name: string }[] | null;
    contact: Contact | Contact[];
  }[]) {
    items.push({ kind: "tag", at: t.created_at, text: one(t.tag)?.name ?? "", contact: contactLabel(one(t.contact)) });
  }
  for (const d of (deals.data ?? []) as {
    title: string;
    value: number;
    currency: string | null;
    created_at: string;
    contact: Contact | Contact[];
  }[]) {
    items.push({ kind: "deal", at: d.created_at, text: d.title, contact: contactLabel(one(d.contact)) });
  }
  for (const f of (fus.data ?? []) as { title: string; completed_at: string; contact: Contact | Contact[] }[]) {
    items.push({ kind: "followUp", at: f.completed_at, text: f.title, contact: contactLabel(one(f.contact)) });
  }
  for (const rec of (recs.data ?? []) as {
    file_name: string;
    created_at: string;
    phone: string | null;
    contact: Contact | Contact[];
  }[]) {
    items.push({
      kind: "recording",
      at: rec.created_at,
      text: rec.file_name,
      contact: contactLabel(one(rec.contact)) ?? contactLabel(rec.phone ? { phone: rec.phone } : null),
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

export interface DailyTime {
  day: string;
  activeSeconds: number;
  onlineSeconds: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One teammate's time on the platform, per day, newest first. */
export async function loadMemberDailyTime(
  db: SupabaseClient,
  m: TeamMember,
  r: Range,
): Promise<DailyTime[]> {
  const { data, error } = await within(
    db
      .from("member_activity_daily")
      .select("day, active_seconds, online_seconds, first_seen_at, last_seen_at")
      .eq("user_id", m.userId),
    "day",
    r.fromDay,
    r.toDay,
  )
    .order("day", { ascending: false })
    .limit(400);
  if (error) throw error;
  return (data ?? []).map((d) => ({
    day: d.day as string,
    activeSeconds: d.active_seconds as number,
    onlineSeconds: d.online_seconds as number,
    firstSeenAt: d.first_seen_at as string,
    lastSeenAt: d.last_seen_at as string,
  }));
}

/** "3h 25m" / "12m" / "0m". */
export function formatHours(seconds: number): string {
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
