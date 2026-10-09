import type { SupabaseClient } from "@supabase/supabase-js";
import { loadMemberStats, formatHours, type TeamMember } from "@/lib/reports/team";
import { formatPhoneDisplay, withIndiaCountryCode } from "@/lib/whatsapp/phone-utils";
import { CALL_RECORDINGS_BUCKET } from "@/lib/call-recordings";

// ============================================================
// Read-only MCP tools for the Claude connector (/api/mcp).
//
// Every query is scoped to the API key's account. The DB client is the
// service role (RLS bypassed), so `.eq("account_id", accountId)` — or
// a lookup through an account-owned parent row — is mandatory on every
// query below.
//
// Dates are India time (IST): "2026-10-08" means that whole IST day.
// ============================================================

export interface ToolContext {
  db: SupabaseClient;
  accountId: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const MAX_LIMIT = 200;
const RECORDING_LINK_SECONDS = 24 * 60 * 60;

// ---- argument helpers ------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function day(args: Record<string, unknown>, key: string): string | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  if (!DAY.test(v)) throw new Error(`${key} must be a date like 2026-10-08`);
  return v;
}

function limit(args: Record<string, unknown>, fallback = 50): number {
  const v = Number(args.limit);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_LIMIT) : fallback;
}

const istStart = (d: string) => `${d}T00:00:00+05:30`;
const istEnd = (d: string) => `${d}T23:59:59.999+05:30`;

/** Default window: the last `days` IST days including today. */
function defaultRange(days: number): { from: string; to: string } {
  const fmt = (dt: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(dt);
  const now = new Date();
  return { from: fmt(new Date(now.getTime() - (days - 1) * 86_400_000)), to: fmt(now) };
}

const dateProps = {
  from: { type: "string", description: "Start date (inclusive), YYYY-MM-DD, India time." },
  to: { type: "string", description: "End date (inclusive), YYYY-MM-DD, India time." },
};

// ---- shared lookups --------------------------------------------------

async function members(ctx: ToolContext): Promise<(TeamMember & { email: string | null })[]> {
  const { data, error } = await ctx.db
    .from("profiles")
    .select("id, user_id, full_name, email, account_role")
    .eq("account_id", ctx.accountId)
    .order("full_name");
  if (error) throw error;
  return (data ?? []).map((p) => ({
    profileId: p.id as string,
    userId: p.user_id as string,
    name: (p.full_name as string) || (p.email as string) || "—",
    role: (p.account_role as string) ?? "",
    email: (p.email as string) ?? null,
  }));
}

/** Match a teammate by name or email (case-insensitive, partial). */
function findMember<T extends { name: string; email: string | null }>(list: T[], q: string): T {
  const needle = q.toLowerCase();
  const hit =
    list.find((m) => m.name.toLowerCase() === needle || m.email?.toLowerCase() === needle) ??
    list.find((m) => m.name.toLowerCase().includes(needle) || m.email?.toLowerCase().includes(needle));
  if (!hit) throw new Error(`No teammate matches "${q}". Use list_team_members to see names.`);
  return hit;
}

const contactName = (c: { name?: string | null; phone?: string | null } | null | undefined) =>
  c ? c.name || formatPhoneDisplay(c.phone) || null : null;

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

// ---- tools -----------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "list_team_members",
    description: "List the CRM team (name, email, role: owner/admin/agent/viewer).",
    inputSchema: { type: "object", properties: {} },
    run: async (ctx) =>
      (await members(ctx)).map(({ name, email, role }) => ({ name, email, role })),
  },

  {
    name: "team_report",
    description:
      "Per-teammate activity for a date range: active/logged-in time on the CRM, WhatsApp messages sent, notes, tags added, deals created/won, follow-ups done, call recordings (count + minutes), plus current overdue follow-ups, open chats and open deals assigned. Defaults to the last 7 days.",
    inputSchema: {
      type: "object",
      properties: {
        ...dateProps,
        member: { type: "string", description: "Optional: only this teammate (name or email)." },
      },
    },
    run: async (ctx, args) => {
      const d = defaultRange(7);
      const from = day(args, "from") ?? d.from;
      const to = day(args, "to") ?? d.to;
      let list = await members(ctx);
      const who = str(args, "member");
      if (who) list = [findMember(list, who)];
      const range = { from: istStart(from), to: istEnd(to), fromDay: from, toDay: to };
      const rows = await Promise.all(
        list.map(async (m) => {
          const s = await loadMemberStats(ctx.db, ctx.accountId, m, range);
          return {
            member: m.name,
            role: m.role,
            active_time: formatHours(s.activeSeconds),
            logged_in_time: formatHours(s.onlineSeconds),
            messages_sent: s.messagesSent,
            notes: s.notes,
            tags_added: s.tagsAdded,
            deals_created: s.dealsCreated,
            deals_won: s.dealsWon,
            follow_ups_done: s.followUpsDone,
            call_recordings: s.recordings,
            call_recording_minutes: Math.round(s.recordingSeconds / 60),
            calls_analysed: s.callsAnalysed,
            avg_call_score: s.avgCallScore,
            leads_hot: s.hotLeads,
            leads_warm: s.warmLeads,
            leads_cold: s.coldLeads,
            now_overdue_follow_ups: s.followUpsOverdue,
            now_open_chats_assigned: s.openChats,
            now_open_deals_assigned: s.openDeals,
          };
        }),
      );
      return {
        period: { from, to, timezone: "Asia/Kolkata" },
        note: "Messages sent, tags added and time on the CRM are recorded from 6 Oct 2026 onward.",
        members: rows,
      };
    },
  },

  {
    name: "list_conversations",
    description:
      "List WhatsApp inbox chats, newest activity first. Filter by status, assigned teammate, unreplied (customer sent the last message), or last-message date range.",
    inputSchema: {
      type: "object",
      properties: {
        ...dateProps,
        status: { type: "string", enum: ["open", "pending", "closed"] },
        assigned_to: {
          type: "string",
          description: "Teammate name or email, or 'unassigned'.",
        },
        unreplied: { type: "boolean", description: "Only chats where the customer is waiting for a reply." },
        limit: { type: "number", description: `Max rows (default 50, max ${MAX_LIMIT}).` },
      },
    },
    run: async (ctx, args) => {
      const team = await members(ctx);
      const nameOf = new Map(team.map((m) => [m.userId, m.name]));
      let q = ctx.db
        .from("conversations")
        .select(
          "id, status, assigned_agent_id, last_message_text, last_message_at, last_message_sender, unread_count, contact:contacts(name, phone, blocked_at)",
        )
        .eq("account_id", ctx.accountId)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(limit(args));
      const status = str(args, "status");
      if (status) q = q.eq("status", status);
      const assigned = str(args, "assigned_to");
      if (assigned?.toLowerCase() === "unassigned") q = q.is("assigned_agent_id", null);
      else if (assigned) q = q.eq("assigned_agent_id", findMember(team, assigned).userId);
      if (args.unreplied === true) q = q.eq("last_message_sender", "customer").neq("status", "closed");
      const from = day(args, "from");
      const to = day(args, "to");
      if (from) q = q.gte("last_message_at", istStart(from));
      if (to) q = q.lte("last_message_at", istEnd(to));
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((c) => {
        const contact = one(c.contact as never) as { name: string | null; phone: string | null; blocked_at: string | null } | null;
        return {
          conversation_id: c.id,
          contact: contactName(contact),
          phone: formatPhoneDisplay(contact?.phone),
          status: c.status,
          assigned_to: c.assigned_agent_id ? nameOf.get(c.assigned_agent_id as string) ?? "unknown" : null,
          last_message: c.last_message_text,
          last_message_at: c.last_message_at,
          waiting_for_our_reply: c.last_message_sender === "customer",
          unread: c.unread_count,
          blocked: !!contact?.blocked_at,
        };
      });
    },
  },

  {
    name: "get_conversation_messages",
    description:
      "Read the WhatsApp messages of one chat (oldest first). Identify it by conversation_id (from list_conversations) or by the contact's phone number.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        phone: { type: "string", description: "10-digit Indian mobile or full international number." },
        limit: { type: "number", description: `Most recent N messages (default 100, max ${MAX_LIMIT}).` },
      },
    },
    run: async (ctx, args) => {
      let convId = str(args, "conversation_id");
      const phone = str(args, "phone");
      if (!convId && phone) {
        const digits = withIndiaCountryCode(phone).replace(/\D/g, "");
        const { data: contact } = await ctx.db
          .from("contacts")
          .select("id")
          .eq("account_id", ctx.accountId)
          .eq("phone_normalized", digits)
          .maybeSingle();
        if (!contact) throw new Error(`No contact with phone ${phone}`);
        const { data: conv } = await ctx.db
          .from("conversations")
          .select("id")
          .eq("account_id", ctx.accountId)
          .eq("contact_id", contact.id)
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        convId = conv?.id as string | undefined;
      }
      if (!convId) throw new Error("Give conversation_id or phone");

      const { data: conv, error: convErr } = await ctx.db
        .from("conversations")
        .select("id, status, contact:contacts(name, phone)")
        .eq("account_id", ctx.accountId)
        .eq("id", convId)
        .maybeSingle();
      if (convErr) throw convErr;
      if (!conv) throw new Error("Conversation not found");

      const team = await members(ctx);
      const nameOf = new Map(team.map((m) => [m.userId, m.name]));
      const { data, error } = await ctx.db
        .from("messages")
        .select("sender_type, sender_id, content_type, content_text, created_at, status")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: false })
        .limit(limit(args, 100));
      if (error) throw error;
      const contact = one(conv.contact as never) as { name: string | null; phone: string | null } | null;
      return {
        conversation_id: conv.id,
        contact: contactName(contact),
        phone: formatPhoneDisplay(contact?.phone),
        status: conv.status,
        messages: (data ?? []).reverse().map((m) => ({
          at: m.created_at,
          from:
            m.sender_type === "customer"
              ? "customer"
              : m.sender_type === "bot"
                ? "bot/automation"
                : (m.sender_id && nameOf.get(m.sender_id as string)) || "team",
          type: m.content_type,
          text: m.content_text,
          delivery: m.sender_type === "customer" ? undefined : m.status,
        })),
      };
    },
  },

  {
    name: "pipeline_summary",
    description:
      "Sales pipelines with each stage's deal count and total value (open deals), plus won/lost totals.",
    inputSchema: { type: "object", properties: {} },
    run: async (ctx) => {
      const [{ data: pipes, error: pe }, { data: deals, error: de }] = await Promise.all([
        ctx.db.from("pipelines").select("id, name").eq("account_id", ctx.accountId),
        ctx.db
          .from("deals")
          .select("pipeline_id, stage_id, value, status")
          .eq("account_id", ctx.accountId)
          .limit(10_000),
      ]);
      if (pe || de) throw pe ?? de;
      const pipeIds = new Set((pipes ?? []).map((p) => p.id as string));
      const { data: stages, error: se } = pipeIds.size
        ? await ctx.db
            .from("pipeline_stages")
            .select("id, pipeline_id, name, position")
            .in("pipeline_id", [...pipeIds])
        : { data: [], error: null };
      if (se) throw se;
      return (pipes ?? []).map((p) => {
        const ds = (deals ?? []).filter((d) => d.pipeline_id === p.id);
        const sum = (rows: typeof ds) => rows.reduce((n, d) => n + Number(d.value ?? 0), 0);
        return {
          pipeline: p.name,
          stages: (stages ?? [])
            .filter((s) => s.pipeline_id === p.id && pipeIds.has(s.pipeline_id))
            .sort((a, b) => a.position - b.position)
            .map((s) => {
              const open = ds.filter((d) => d.stage_id === s.id && d.status !== "won" && d.status !== "lost");
              return { stage: s.name, open_deals: open.length, open_value: sum(open) };
            }),
          won: { deals: ds.filter((d) => d.status === "won").length, value: sum(ds.filter((d) => d.status === "won")) },
          lost: { deals: ds.filter((d) => d.status === "lost").length, value: sum(ds.filter((d) => d.status === "lost")) },
        };
      });
    },
  },

  {
    name: "list_deals",
    description:
      "List deals with stage, value, contact, assigned teammate, creator, status and next follow-up. Filter by pipeline, stage, status, assigned teammate, creator or created date.",
    inputSchema: {
      type: "object",
      properties: {
        ...dateProps,
        pipeline: { type: "string", description: "Pipeline name (partial match)." },
        stage: { type: "string", description: "Stage name (partial match)." },
        status: { type: "string", enum: ["open", "won", "lost"] },
        assigned_to: { type: "string", description: "Teammate name/email, or 'unassigned'." },
        created_by: { type: "string", description: "Teammate name/email." },
        limit: { type: "number", description: `Max rows (default 50, max ${MAX_LIMIT}).` },
      },
    },
    run: async (ctx, args) => {
      const team = await members(ctx);
      const byProfile = new Map(team.map((m) => [m.profileId, m.name]));
      const byUser = new Map(team.map((m) => [m.userId, m.name]));
      let q = ctx.db
        .from("deals")
        .select(
          "id, title, value, currency, status, expected_close_date, created_at, assigned_to, user_id, notes, contact:contacts(name, phone), stage:pipeline_stages(name), pipeline:pipelines(name)",
        )
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false })
        .limit(limit(args));
      const status = str(args, "status");
      if (status === "open") q = q.not("status", "in", "(won,lost)");
      else if (status) q = q.eq("status", status);
      const assigned = str(args, "assigned_to");
      if (assigned?.toLowerCase() === "unassigned") q = q.is("assigned_to", null);
      else if (assigned) q = q.eq("assigned_to", findMember(team, assigned).profileId);
      const creator = str(args, "created_by");
      if (creator) q = q.eq("user_id", findMember(team, creator).userId);
      const from = day(args, "from");
      const to = day(args, "to");
      if (from) q = q.gte("created_at", istStart(from));
      if (to) q = q.lte("created_at", istEnd(to));
      const { data, error } = await q;
      if (error) throw error;

      const pipeline = str(args, "pipeline")?.toLowerCase();
      const stage = str(args, "stage")?.toLowerCase();
      const rows = (data ?? []).filter((d) => {
        const p = one(d.pipeline as never) as { name: string } | null;
        const s = one(d.stage as never) as { name: string } | null;
        return (
          (!pipeline || p?.name.toLowerCase().includes(pipeline)) &&
          (!stage || s?.name.toLowerCase().includes(stage))
        );
      });

      const ids = rows.map((d) => d.id);
      const nextFu = new Map<string, string>();
      if (ids.length) {
        const { data: fus } = await ctx.db
          .from("follow_ups")
          .select("deal_id, due_at")
          .eq("account_id", ctx.accountId)
          .in("deal_id", ids)
          .is("completed_at", null)
          .order("due_at");
        for (const f of fus ?? []) if (f.deal_id && !nextFu.has(f.deal_id)) nextFu.set(f.deal_id, f.due_at);
      }

      return rows.map((d) => ({
        title: d.title,
        pipeline: (one(d.pipeline as never) as { name: string } | null)?.name ?? null,
        stage: (one(d.stage as never) as { name: string } | null)?.name ?? null,
        status: d.status,
        value: d.value,
        currency: d.currency,
        contact: contactName(one(d.contact as never)),
        assigned_to: d.assigned_to ? byProfile.get(d.assigned_to as string) ?? "unknown" : null,
        created_by: byUser.get(d.user_id as string) ?? null,
        created_at: d.created_at,
        expected_close_date: d.expected_close_date,
        next_follow_up: nextFu.get(d.id as string) ?? null,
        notes: d.notes,
      }));
    },
  },

  {
    name: "list_follow_ups",
    description:
      "List follow-ups (call-backs, meetings, tasks). Filter by state (overdue, today, upcoming, done) and teammate.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["overdue", "today", "upcoming", "done", "open"] },
        assigned_to: { type: "string", description: "Teammate name or email." },
        limit: { type: "number", description: `Max rows (default 50, max ${MAX_LIMIT}).` },
      },
    },
    run: async (ctx, args) => {
      const team = await members(ctx);
      const nameOf = new Map(team.map((m) => [m.userId, m.name]));
      const today = defaultRange(1).to;
      const now = new Date().toISOString();
      let q = ctx.db
        .from("follow_ups")
        .select("type, title, notes, due_at, completed_at, assigned_to, contact:contacts(name, phone), deal:deals(title)")
        .eq("account_id", ctx.accountId)
        .limit(limit(args));
      const state = str(args, "state") ?? "open";
      if (state === "done") q = q.not("completed_at", "is", null).order("completed_at", { ascending: false });
      else {
        q = q.is("completed_at", null).order("due_at");
        if (state === "overdue") q = q.lt("due_at", now);
        if (state === "today") q = q.gte("due_at", now).lte("due_at", istEnd(today));
        if (state === "upcoming") q = q.gt("due_at", istEnd(today));
      }
      const who = str(args, "assigned_to");
      if (who) q = q.eq("assigned_to", findMember(team, who).userId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((f) => ({
        type: f.type,
        title: f.title,
        notes: f.notes,
        due_at: f.due_at,
        completed_at: f.completed_at,
        assigned_to: nameOf.get(f.assigned_to as string) ?? null,
        contact: contactName(one(f.contact as never)),
        deal: (one(f.deal as never) as { title: string } | null)?.title ?? null,
      }));
    },
  },

  {
    name: "list_call_recordings",
    description:
      "List phone-call recordings uploaded by the team, with call date, teammate, contact/number, duration, a download link valid for 24 hours and — when transcribed — the AI call analysis (summary, lead quality hot/warm/cold, agent score 0-10, objections, next step). Use get_call_transcript for the full conversation. Defaults to the last 7 days.",
    inputSchema: {
      type: "object",
      properties: {
        ...dateProps,
        member: { type: "string", description: "Teammate name or email." },
        limit: { type: "number", description: `Max rows (default 50, max ${MAX_LIMIT}).` },
      },
    },
    run: async (ctx, args) => {
      const d = defaultRange(7);
      const from = day(args, "from") ?? d.from;
      const to = day(args, "to") ?? d.to;
      const team = await members(ctx);
      const nameOf = new Map(team.map((m) => [m.userId, m.name]));
      let q = ctx.db
        .from("call_recordings")
        .select("id, storage_path, file_name, call_date, created_at, duration_seconds, phone, notes, uploaded_by, transcript_status, analysis, contact:contacts(name, phone)")
        .eq("account_id", ctx.accountId)
        .gte("call_date", from)
        .lte("call_date", to)
        .order("call_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(limit(args));
      const who = str(args, "member");
      if (who) q = q.eq("uploaded_by", findMember(team, who).userId);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data ?? [];
      const signed = rows.length
        ? await ctx.db.storage
            .from(CALL_RECORDINGS_BUCKET)
            .createSignedUrls(rows.map((r) => r.storage_path as string), RECORDING_LINK_SECONDS)
        : { data: [] };
      const urlOf = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]));
      return {
        period: { from, to },
        recordings: rows.map((r) => ({
          call_date: r.call_date,
          uploaded_at: r.created_at,
          teammate: nameOf.get(r.uploaded_by as string) ?? null,
          contact:
            contactName(one(r.contact as never)) ?? (r.phone ? formatPhoneDisplay(r.phone as string) : null),
          duration_minutes: r.duration_seconds ? Math.round((r.duration_seconds as number) / 6) / 10 : null,
          file_name: r.file_name,
          notes: r.notes,
          recording_id: r.id,
          transcribed: r.transcript_status === "done",
          analysis: r.analysis ?? null,
          download_url: urlOf.get(r.storage_path as string) ?? null,
        })),
      };
    },
  },

  {
    name: "get_call_transcript",
    description:
      "Full transcript of one transcribed call recording (speaker turns labelled Agent/Customer, Hinglish) plus its AI analysis. Get recording_id from list_call_recordings.",
    inputSchema: {
      type: "object",
      properties: { recording_id: { type: "string" } },
      required: ["recording_id"],
    },
    run: async (ctx, args) => {
      const id = str(args, "recording_id");
      if (!id) throw new Error("recording_id is required");
      const { data: r, error } = await ctx.db
        .from("call_recordings")
        .select("call_date, uploaded_by, file_name, transcript_status, transcript, transcript_segments, transcript_language, analysis, contact:contacts(name, phone), phone")
        .eq("account_id", ctx.accountId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!r) throw new Error("Recording not found");
      if (r.transcript_status !== "done") {
        throw new Error(
          r.transcript_status === "processing"
            ? "This recording is still being transcribed — try again in a minute."
            : "This recording hasn't been transcribed yet. Use 'Transcribe & analyse' on the Call Recordings page.",
        );
      }
      const team = await members(ctx);
      const analysis = r.analysis as { agent_speaker?: number } | null;
      const segments = (r.transcript_segments ?? []) as { speaker: number; text: string; start: number }[];
      return {
        call_date: r.call_date,
        teammate: team.find((m) => m.userId === r.uploaded_by)?.name ?? null,
        contact:
          contactName(one(r.contact as never)) ?? (r.phone ? formatPhoneDisplay(r.phone as string) : null),
        language: r.transcript_language,
        analysis: r.analysis,
        conversation: segments.length
          ? segments.map((s) => ({
              at_seconds: s.start,
              speaker: analysis?.agent_speaker
                ? s.speaker === analysis.agent_speaker
                  ? "Agent"
                  : "Customer"
                : `Speaker ${s.speaker}`,
              text: s.text,
            }))
          : r.transcript,
      };
    },
  },

  {
    name: "new_leads",
    description:
      "Count new leads (new contacts — first-time WhatsApp messages, or added/imported) per day or per month in a date range. Defaults to the last 30 days, per day.",
    inputSchema: {
      type: "object",
      properties: {
        ...dateProps,
        group_by: { type: "string", enum: ["day", "month"] },
      },
    },
    run: async (ctx, args) => {
      const d = defaultRange(30);
      const from = day(args, "from") ?? d.from;
      const to = day(args, "to") ?? d.to;
      const byMonth = str(args, "group_by") === "month";
      const counts = new Map<string, number>();
      const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
      for (let off = 0; off < 100_000; off += 1000) {
        const { data, error } = await ctx.db
          .from("contacts")
          .select("created_at")
          .eq("account_id", ctx.accountId)
          .gte("created_at", istStart(from))
          .lte("created_at", istEnd(to))
          .order("created_at")
          .range(off, off + 999);
        if (error) throw error;
        for (const r of data ?? []) {
          const k = keyFmt.format(new Date(r.created_at as string)).slice(0, byMonth ? 7 : 10);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        if (!data || data.length < 1000) break;
      }
      const series = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, leads]) => ({ period, leads }));
      return {
        period: { from, to, group_by: byMonth ? "month" : "day" },
        total: series.reduce((n, s) => n + s.leads, 0),
        series,
        note: "Periods with no new leads are omitted.",
      };
    },
  },

  {
    name: "search_contacts",
    description: "Find contacts by name, phone or email; returns tags, notes count and open deals.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max rows (default 20, max 200)." },
      },
      required: ["query"],
    },
    run: async (ctx, args) => {
      const qText = str(args, "query");
      if (!qText) throw new Error("query is required");
      const digits = qText.replace(/\D/g, "");
      const like = `%${qText.replace(/[%,()]/g, "")}%`;
      const ors = [`name.ilike.${like}`, `email.ilike.${like}`];
      if (digits.length >= 4) ors.push(`phone_normalized.ilike.%${digits}%`);
      const { data, error } = await ctx.db
        .from("contacts")
        .select("id, name, phone, email, company, created_at, blocked_at, contact_tags(tags(name)), deals(title, status, value)")
        .eq("account_id", ctx.accountId)
        .or(ors.join(","))
        .limit(limit(args, 20));
      if (error) throw error;
      return (data ?? []).map((c) => ({
        name: c.name,
        phone: formatPhoneDisplay(c.phone as string),
        email: c.email,
        company: c.company,
        added_at: c.created_at,
        blocked: !!c.blocked_at,
        tags: ((c.contact_tags ?? []) as { tags: { name: string } | { name: string }[] | null }[])
          .map((t) => one(t.tags)?.name)
          .filter(Boolean),
        deals: c.deals,
      }));
    },
  },
];

export function toolList() {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: true },
  }));
}

export async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(ctx, args ?? {});
}
