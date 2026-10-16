/**
 * Flow engine v2 — used only by flows that have a `flow_engine_settings`
 * row (migration 057), e.g. "DSA Welcome v2". Flows without one keep
 * running on the original engine (../engine.ts) exactly as before.
 *
 * What v2 does differently (all decided by settings + node config):
 *   - Entry without keywords: new contact, contact silent for N days, or a
 *     form submission. Never while a human agent is active on the chat,
 *     never again within N days of a finished run.
 *   - Global buttons: a tap on ANY button the flow ever sent jumps to that
 *     button's step, whatever step the run is on (latest tap wins).
 *   - Tap debounce + per-step dedupe: two taps close together → only the
 *     last is processed; the same step is never sent twice within N s.
 *   - Bot pause: while a human agent messaged within N hours, the bot
 *     stays silent (the agent already gets the message).
 *   - Free text → assign + notify an agent + one "we'll reply" message.
 *   - Step actions (tag, assign, deal, follow-up, notify, schedule) run
 *     on entering a step; every failure is an `error` event in the run
 *     history — nothing is swallowed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../admin-client";
import {
  engineSendInteractiveButtons,
  engineSendText,
} from "../meta-send";
import { engineSendTemplate } from "@/lib/automations/meta-send";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { assignRoundRobin } from "@/lib/assignment/round-robin";
import { resolveTagRef } from "../tag-ref";
import type {
  DispatchInboundInput,
  DispatchInboundResult,
  FlowNodeRow,
  FlowRow,
  FlowRunRow,
} from "../types";
import {
  callFollowUpDue,
  computeDemoSlots,
  decideEntry,
  detectLanguage,
  encodeSlotReplyId,
  fill,
  firstName,
  isBotPaused,
  isWithinWorkingHours,
  matchTextIntent,
  nudgeDue,
  parseFormSubmission,
  resolveTap,
  type SlotConfig,
} from "./logic";
import {
  isTestContact,
  phoneInList,
  v2AppliesTo,
  type V2Lang,
  type V2Settings,
} from "./settings";

type Db = SupabaseClient;

// ------------------------------------------------------------
// Node config (extends the original send_buttons / send_message configs)
// ------------------------------------------------------------

export type V2Action =
  | { type: "add_tag"; tag: string }
  | { type: "assign" }
  | { type: "ensure_deal" }
  | { type: "set_deal_value"; value: number; plan: string }
  | { type: "move_deal_stage"; stage: string }
  | { type: "create_follow_up"; kind: "demo" | "call"; title: string }
  | { type: "notify_agent"; title: string; body?: string }
  | { type: "flag_hot" }
  | { type: "schedule_nudge"; nodes: Partial<Record<V2Lang, string>>; delay_minutes: number }
  | { type: "schedule_auto_close"; hours: number }
  | { type: "mark_fallback_replied" };

interface V2NodeConfig {
  lang?: V2Lang;
  text?: string;
  /** send_message: used instead of `text` outside working hours. */
  text_off_hours?: string;
  buttons?: Array<{ reply_id: string; title: string; next_node_key: string }>;
  dynamic_slots?: SlotConfig & { next_node_key: string };
  actions?: V2Action[];
  next_node_key?: string;
  /** Run is complete after this step (buttons stay tappable). */
  terminal?: boolean;
}

// ------------------------------------------------------------
// Context
// ------------------------------------------------------------

interface Ctx {
  db: Db;
  flow: FlowRow;
  settings: V2Settings;
  nodes: Map<string, FlowNodeRow>;
  accountId: string;
  userId: string;
  contact: { id: string; phone: string | null; name: string | null };
  conversationId: string;
  isTest: boolean;
  dryRun: boolean;
  now: Date;
}

export interface V2DispatchInput extends DispatchInboundInput {
  isFirstInboundMessage: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// Loading
// ------------------------------------------------------------

export interface V2FlowBundle {
  flow: FlowRow;
  settings: V2Settings;
}

export async function loadV2Flows(db: Db, accountId: string): Promise<V2FlowBundle[]> {
  const { data, error } = await db
    .from("flow_engine_settings")
    .select("settings, flow:flows(*)")
    .eq("account_id", accountId);
  if (error) {
    // Table missing (migration not applied) → behave as before.
    if (!/does not exist|schema cache/i.test(error.message)) {
      console.error("[flows-v2] settings lookup failed:", error.message);
    }
    return [];
  }
  return ((data ?? []) as unknown as Array<{ settings: V2Settings; flow: FlowRow | null }>)
    .filter((r) => r.flow && r.settings?.engine === "v2")
    .map((r) => ({ flow: r.flow as FlowRow, settings: r.settings }));
}

async function loadNodes(db: Db, flowId: string): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db.from("flow_nodes").select("*").eq("flow_id", flowId);
  if (error) throw new Error(`load nodes: ${error.message}`);
  return new Map(((data ?? []) as FlowNodeRow[]).map((n) => [n.node_key, n]));
}

async function logEvent(
  db: Db,
  runId: string,
  type: "started" | "node_entered" | "message_sent" | "reply_received" | "fallback_fired" | "handoff" | "error" | "completed" | "timeout",
  nodeKey: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db
    .from("flow_run_events")
    .insert({ flow_run_id: runId, event_type: type, node_key: nodeKey, payload });
  if (error) console.error("[flows-v2] logEvent failed:", error.message);
}

// ------------------------------------------------------------
// Entry point — called from dispatchInboundToFlows before the old path
// ------------------------------------------------------------

/**
 * Returns a result when v2 handled the message, or null to let the
 * original engine handle it (v2 off / contact not on the test list).
 */
export async function dispatchV2IfApplicable(input: V2DispatchInput): Promise<DispatchInboundResult | null> {
  const db = supabaseAdmin();
  const bundles = await loadV2Flows(db, input.accountId);
  if (bundles.length === 0) return null;

  const { data: contact } = await db
    .from("contacts")
    .select("id, phone, name")
    .eq("id", input.contactId)
    .maybeSingle();
  const phone = (contact as { phone?: string | null } | null)?.phone ?? null;

  const bundle = bundles.find((b) => b.flow.status === "active" && v2AppliesTo(b.settings, phone));
  if (!bundle) {
    // v2 doesn't handle this contact. If they still have an ACTIVE run on
    // a v2 flow (routing was switched back), end it so the original
    // engine doesn't try to drive a v2 graph.
    const v2Ids = bundles.map((b) => b.flow.id);
    const { data: stale } = await db
      .from("flow_runs")
      .select("id")
      .eq("account_id", input.accountId)
      .eq("contact_id", input.contactId)
      .eq("status", "active")
      .in("flow_id", v2Ids);
    for (const r of (stale ?? []) as Array<{ id: string }>) {
      await db
        .from("flow_runs")
        .update({ status: "completed", ended_at: new Date().toISOString(), end_reason: "v2_routing_off" })
        .eq("id", r.id)
        .eq("status", "active");
      await logEvent(db, r.id, "completed", null, { reason: "v2_routing_off" });
    }
    return null;
  }

  const ctx: Ctx = {
    db,
    flow: bundle.flow,
    settings: bundle.settings,
    nodes: await loadNodes(db, bundle.flow.id),
    accountId: input.accountId,
    userId: input.userId,
    contact: {
      id: input.contactId,
      phone,
      name: (contact as { name?: string | null } | null)?.name ?? null,
    },
    conversationId: input.conversationId,
    isTest: isTestContact(bundle.settings, phone),
    dryRun: phoneInList(phone, bundle.settings.dry_run_phones),
    now: new Date(),
  };

  try {
    return await handleInbound(ctx, input);
  } catch (err) {
    console.error("[flows-v2] dispatch failed:", err instanceof Error ? err.message : err);
    // Consumed: v2 owns this contact, so don't let the old flow or the AI
    // bot answer instead. The error is in the server log.
    return { consumed: true, outcome: "no_match" };
  }
}

// ------------------------------------------------------------
// Inbound handling
// ------------------------------------------------------------

async function handleInbound(ctx: Ctx, input: V2DispatchInput): Promise<DispatchInboundResult> {
  const { db, settings } = ctx;
  const msg = input.message;

  // Runs of the flow v2 replaces (or any other flow) stop here for
  // contacts v2 now handles.
  await endOtherActiveRuns(ctx);

  const [latestRun, lastAgentAt] = await Promise.all([loadLatestRun(ctx), lastAgentMessageAt(ctx)]);
  const paused = isBotPaused(lastAgentAt, ctx.now, settings.bot_pause_hours);
  const staleCutoff = settings.entry.reengage_after_days * 24 * 3600 * 1000;
  let activeRun = latestRun?.status === "active" ? latestRun : null;
  if (activeRun && ctx.now.getTime() - Date.parse(activeRun.last_advanced_at) > staleCutoff) {
    await finishRun(ctx, activeRun, "timed_out", "stale_v2_run");
    activeRun = null;
  }

  // ---------------- Button / list tap ----------------
  if (msg.kind === "interactive_reply") {
    if (input.hasNewerTapInBatch) {
      if (activeRun) await logEvent(db, activeRun.id, "reply_received", activeRun.current_node_key, tapPayload(msg, { superseded: "newer_tap_in_batch" }));
      return { consumed: true, flow_run_id: activeRun?.id, outcome: "duplicate_inbound_ignored" };
    }
    // Latest tap wins: record this tap, wait the debounce window, and
    // drop it if a newer tap arrived meanwhile.
    const { data: latest } = await db.rpc("flow_record_tap", {
      p_account_id: ctx.accountId,
      p_contact_id: ctx.contact.id,
      p_message_id: msg.meta_message_id,
      p_ts: input.messageTs ?? Math.floor(Date.now() / 1000),
    });
    if (latest === msg.meta_message_id && settings.tap_debounce_seconds > 0) {
      await sleep(settings.tap_debounce_seconds * 1000);
    }
    const { data: state } = await db
      .from("flow_contact_state")
      .select("latest_tap_message_id")
      .eq("account_id", ctx.accountId)
      .eq("contact_id", ctx.contact.id)
      .maybeSingle();
    if ((state as { latest_tap_message_id?: string } | null)?.latest_tap_message_id !== msg.meta_message_id) {
      if (activeRun) await logEvent(db, activeRun.id, "reply_received", activeRun.current_node_key, tapPayload(msg, { superseded: "newer_tap" }));
      return { consumed: true, flow_run_id: activeRun?.id, outcome: "duplicate_inbound_ignored" };
    }
    ctx.now = new Date();

    const target = resolveTap(ctx.nodes.values(), msg.reply_id, msg.reply_title);
    if (!target) {
      // Not one of ours — handle like typed text.
      return handleText(ctx, input, msg.reply_title || msg.reply_id, activeRun, latestRun, paused, lastAgentAt);
    }
    if (paused) {
      if (activeRun ?? latestRun) {
        await logEvent(db, (activeRun ?? latestRun)!.id, "reply_received", null, tapPayload(msg, { ignored: "bot_paused_agent_active" }));
      }
      return { consumed: true, flow_run_id: (activeRun ?? latestRun)?.id, outcome: "no_match" };
    }
    let run = activeRun;
    if (!run && latestRun && ctx.now.getTime() - Date.parse(latestRun.started_at) < staleCutoff) {
      run = await reopenRun(ctx, latestRun);
    }
    if (!run) {
      const lang = (ctx.nodes.get(target.node_key)?.config as V2NodeConfig | undefined)?.lang ?? "en";
      run = await startRun(ctx, { trigger: "tap", lang, reason: "tap_without_run" });
      if (!run) return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    await logEvent(db, run.id, "reply_received", run.current_node_key, tapPayload(msg, { via: target.kind === "node" ? target.via : "slot" }));
    if (target.kind === "slot") {
      run.vars = { ...run.vars, slot_start: target.start, slot_end: target.end, slot_long: target.long };
    }
    await walk(ctx, run, target.node_key);
    return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
  }

  // ---------------- Form submission ----------------
  if (input.form) {
    const parsed = parseFormSubmission(input.form.responseJson, settings.form);
    const patch: Record<string, string> = {};
    if (parsed.name) patch.name = parsed.name;
    if (parsed.email) patch.email = parsed.email;
    if (Object.keys(patch).length) {
      const { error } = await db.from("contacts").update(patch).eq("id", ctx.contact.id);
      if (error) console.error("[flows-v2] form → contact update failed:", error.message);
      else if (patch.name) ctx.contact.name = patch.name;
    }
    if (activeRun) {
      await logEvent(db, activeRun.id, "reply_received", activeRun.current_node_key, {
        meta_message_id: msg.meta_message_id,
        reply_kind: "form",
        note: "run already started — not starting twice",
        stored: Object.keys(patch),
      });
      return { consumed: true, flow_run_id: activeRun.id, outcome: "duplicate_inbound_ignored" };
    }
    const decision = decideEntry(
      {
        kind: "form",
        isFirstInbound: input.isFirstInboundMessage,
        lastPriorMessageAt: null,
        lastAgentMessageAt: lastAgentAt,
        lastFinishedRunAt: finishedAt(latestRun),
        hasActiveRun: false,
        now: ctx.now,
      },
      settings.entry,
    );
    if (decision.action === "agent_active") return { consumed: true, outcome: "no_match" };
    if (decision.action === "fallback") return fallback(ctx, null, "form", msg.meta_message_id);
    const lang = detectLanguage(null, settings, parsed.language);
    const run = await startRun(ctx, { trigger: "form", lang, reason: "form", stored: Object.keys(patch) });
    if (!run) return { consumed: true, outcome: "duplicate_inbound_ignored" };
    await walk(ctx, run, settings.entry_nodes[lang]);
    return { consumed: true, flow_run_id: run.id, outcome: "started" };
  }

  // ---------------- Typed text ----------------
  return handleText(ctx, input, msg.kind === "text" ? msg.text : "", activeRun, latestRun, paused, lastAgentAt);
}

async function handleText(
  ctx: Ctx,
  input: V2DispatchInput,
  text: string,
  activeRun: FlowRunRow | null,
  latestRun: FlowRunRow | null,
  paused: boolean,
  lastAgentAt: Date | null,
): Promise<DispatchInboundResult> {
  const { db, settings } = ctx;
  const metaId = input.message.meta_message_id;

  if (activeRun) {
    await logEvent(db, activeRun.id, "reply_received", activeRun.current_node_key, {
      meta_message_id: metaId,
      reply_kind: "text",
      text_length: text.length,
    });
    if (paused) {
      await logEvent(db, activeRun.id, "fallback_fired", activeRun.current_node_key, { action: "none", reason: "bot_paused_agent_active" });
      return { consumed: true, flow_run_id: activeRun.id, outcome: "no_match" };
    }
    const entryKeys = Object.values(settings.entry_nodes);
    const sinceStart = (ctx.now.getTime() - Date.parse(activeRun.started_at)) / 1000;
    if (
      activeRun.current_node_key &&
      entryKeys.includes(activeRun.current_node_key) &&
      sinceStart < settings.entry.opening_grace_seconds
    ) {
      // e.g. the ad's pre-filled text right after a form submission.
      await logEvent(db, activeRun.id, "fallback_fired", activeRun.current_node_key, { action: "none", reason: "opening_grace" });
      return { consumed: true, flow_run_id: activeRun.id, outcome: "no_match" };
    }
    const lang = runLang(activeRun);
    const intent = matchTextIntent(text, settings.text_intents, activeRun.current_node_key, lang, activeRun.vars);
    if (intent) {
      await logEvent(db, activeRun.id, "node_entered", activeRun.current_node_key, { text_intent: intent });
      await walk(ctx, activeRun, intent);
      return { consumed: true, flow_run_id: activeRun.id, outcome: "advanced" };
    }
    return fallback(ctx, activeRun, "free_text", metaId);
  }

  // No active run: start, stay out of the agent's way, or fall back.
  const decision = decideEntry(
    {
      kind: "text",
      isFirstInbound: input.isFirstInboundMessage,
      lastPriorMessageAt: await lastPriorMessageAt(ctx, metaId),
      lastAgentMessageAt: lastAgentAt,
      lastFinishedRunAt: finishedAt(latestRun),
      hasActiveRun: false,
      now: ctx.now,
    },
    settings.entry,
  );
  if (decision.action === "agent_active") {
    // The assigned agent already gets the message (inbox + push).
    return { consumed: true, outcome: "no_match" };
  }
  if (decision.action === "fallback") {
    // A recent contact typing something — maybe a price question.
    const lang = latestRun ? runLang(latestRun) : detectLanguage(text, settings);
    const intent = matchTextIntent(text, settings.text_intents.filter((i) => !i.at_nodes?.length), null, lang, latestRun?.vars ?? {});
    if (intent && latestRun) {
      const run = await reopenRun(ctx, latestRun);
      if (run) {
        await walk(ctx, run, intent);
        return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
      }
    }
    return fallback(ctx, latestRun, decision.reason, metaId, text);
  }
  const lang = detectLanguage(text, settings);
  const run = await startRun(ctx, {
    trigger: lang === "hi" ? "hindi" : "text",
    lang,
    reason: decision.action === "start" ? decision.reason : "first_message",
  });
  if (!run) return { consumed: true, outcome: "duplicate_inbound_ignored" };
  await walk(ctx, run, settings.entry_nodes[lang]);
  return { consumed: true, flow_run_id: run.id, outcome: "started" };
}

/**
 * Free text the flow can't route: assign an agent, notify them, and send
 * the "we'll reply soon" step once per cooldown. Then the bot waits.
 */
async function fallback(
  ctx: Ctx,
  run: FlowRunRow | null,
  reason: string,
  metaId: string,
  text?: string,
): Promise<DispatchInboundResult> {
  const { db, settings } = ctx;
  const lang: V2Lang = run ? runLang(run) : detectLanguage(text ?? null, settings);

  const { data: st } = await db
    .from("flow_contact_state")
    .select("last_fallback_reply_at")
    .eq("account_id", ctx.accountId)
    .eq("contact_id", ctx.contact.id)
    .maybeSingle();
  const last = (st as { last_fallback_reply_at?: string | null } | null)?.last_fallback_reply_at;
  const coolingDown =
    !!last && ctx.now.getTime() - Date.parse(last) < settings.fallback_reply_cooldown_hours * 3600 * 1000;

  if (!run || run.status !== "active") {
    run = run && ctx.now.getTime() - Date.parse(run.started_at) < settings.entry.reengage_after_days * 86400000
      ? await reopenRun(ctx, run)
      : await startRun(ctx, { trigger: "fallback", lang, reason });
    if (!run) return { consumed: true, outcome: "duplicate_inbound_ignored" };
  }

  if (coolingDown) {
    // Already told them a human will reply — just make sure one is assigned.
    await runAction(ctx, run, settings.fallback_nodes[lang], { type: "assign" });
    await logEvent(db, run.id, "fallback_fired", run.current_node_key, { action: "assign_only", reason, cooldown: true, meta_message_id: metaId });
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, { action: "question_reply", reason, meta_message_id: metaId });
  await walk(ctx, run, settings.fallback_nodes[lang]);
  return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
}

// ------------------------------------------------------------
// Runs
// ------------------------------------------------------------

function runLang(run: FlowRunRow): V2Lang {
  return run.vars?.lang === "hi" ? "hi" : "en";
}

function finishedAt(run: FlowRunRow | null): Date | null {
  if (!run || run.status === "active") return null;
  if (run.vars?.trigger === "fallback") return null;
  return run.ended_at ? new Date(run.ended_at) : null;
}

function tapPayload(
  msg: { meta_message_id: string; reply_id?: string; reply_title?: string },
  extra: Record<string, unknown>,
) {
  return {
    meta_message_id: msg.meta_message_id,
    reply_kind: "interactive_reply",
    reply_id: msg.reply_id ?? null,
    reply_title: msg.reply_title ?? null,
    tapped_at: new Date().toISOString(),
    ...extra,
  };
}

async function loadLatestRun(ctx: Ctx): Promise<FlowRunRow | null> {
  const { data } = await ctx.db
    .from("flow_runs")
    .select("*")
    .eq("flow_id", ctx.flow.id)
    .eq("contact_id", ctx.contact.id)
    .order("started_at", { ascending: false })
    .limit(1);
  return ((data ?? []) as FlowRunRow[])[0] ?? null;
}

async function lastAgentMessageAt(ctx: Ctx): Promise<Date | null> {
  const { data } = await ctx.db
    .from("messages")
    .select("created_at")
    .eq("conversation_id", ctx.conversationId)
    .eq("sender_type", "agent")
    .order("created_at", { ascending: false })
    .limit(1);
  const row = ((data ?? []) as Array<{ created_at: string }>)[0];
  return row ? new Date(row.created_at) : null;
}

async function lastPriorMessageAt(ctx: Ctx, currentMetaId: string): Promise<Date | null> {
  const { data } = await ctx.db
    .from("messages")
    .select("created_at, message_id")
    .eq("conversation_id", ctx.conversationId)
    .order("created_at", { ascending: false })
    .limit(2);
  const row = ((data ?? []) as Array<{ created_at: string; message_id: string | null }>).find(
    (m) => m.message_id !== currentMetaId,
  );
  return row ? new Date(row.created_at) : null;
}

async function endOtherActiveRuns(ctx: Ctx): Promise<void> {
  const { data } = await ctx.db
    .from("flow_runs")
    .select("id, flow_id")
    .eq("account_id", ctx.accountId)
    .eq("contact_id", ctx.contact.id)
    .eq("status", "active")
    .neq("flow_id", ctx.flow.id);
  for (const r of (data ?? []) as Array<{ id: string }>) {
    const { error } = await ctx.db
      .from("flow_runs")
      .update({ status: "completed", ended_at: new Date().toISOString(), end_reason: "superseded_by_v2" })
      .eq("id", r.id)
      .eq("status", "active");
    if (!error) await logEvent(ctx.db, r.id, "completed", null, { reason: "superseded_by_v2", by_flow: ctx.flow.id });
  }
}

async function startRun(
  ctx: Ctx,
  opts: { trigger: string; lang: V2Lang; reason: string; stored?: string[] },
): Promise<FlowRunRow | null> {
  const vars = { lang: opts.lang, trigger: opts.trigger, start_reason: opts.reason, test: ctx.isTest || undefined };
  const { data, error } = await ctx.db
    .from("flow_runs")
    .insert({
      flow_id: ctx.flow.id,
      account_id: ctx.accountId,
      user_id: ctx.flow.user_id,
      contact_id: ctx.contact.id,
      conversation_id: ctx.conversationId,
      status: "active",
      current_node_key: null,
      vars,
    })
    .select("*")
    .maybeSingle();
  if (error) {
    // Another webhook (form + text, double tap) started it first.
    if (/23505|duplicate key/.test(error.message)) return null;
    throw new Error(`start run: ${error.message}`);
  }
  const run = data as FlowRunRow;
  await logEvent(ctx.db, run.id, "started", null, {
    flow_id: ctx.flow.id,
    trigger_type: opts.trigger,
    language: opts.lang,
    reason: opts.reason,
    stored_fields: opts.stored ?? [],
  });
  await setContactLanguage(ctx, run, opts.lang);
  await ctx.db.rpc("increment_flow_execution_count", { p_flow_id: ctx.flow.id });
  return run;
}

async function reopenRun(ctx: Ctx, run: FlowRunRow): Promise<FlowRunRow | null> {
  if (run.status === "active") return run;
  const { data, error } = await ctx.db
    .from("flow_runs")
    .update({ status: "active", ended_at: null, end_reason: null, last_advanced_at: new Date().toISOString() })
    .eq("id", run.id)
    .select("*")
    .maybeSingle();
  if (error) {
    if (/23505|duplicate key/.test(error.message)) return null;
    throw new Error(`reopen run: ${error.message}`);
  }
  await logEvent(ctx.db, run.id, "node_entered", run.current_node_key, { reopened_from: run.status });
  return data as FlowRunRow;
}

async function finishRun(
  ctx: Ctx,
  run: FlowRunRow,
  status: "completed" | "timed_out",
  reason: string,
): Promise<void> {
  await ctx.db
    .from("flow_runs")
    .update({ status, ended_at: new Date().toISOString(), end_reason: reason, vars: run.vars })
    .eq("id", run.id);
  run.status = status;
  await logEvent(ctx.db, run.id, status === "completed" ? "completed" : "timeout", run.current_node_key, { reason });
}

async function saveRun(ctx: Ctx, run: FlowRunRow, nodeKey: string): Promise<void> {
  run.current_node_key = nodeKey;
  const { error } = await ctx.db
    .from("flow_runs")
    .update({ current_node_key: nodeKey, vars: run.vars, last_advanced_at: new Date().toISOString() })
    .eq("id", run.id);
  if (error) await logEvent(ctx.db, run.id, "error", nodeKey, { reason: "save_run_failed", detail: error.message });
}

// ------------------------------------------------------------
// Walking the graph
// ------------------------------------------------------------

export async function walk(ctx: Ctx, run: FlowRunRow, startKey: string): Promise<void> {
  let key: string | undefined = startKey;
  for (let guard = 0; key && guard < 20; guard++) {
    const node = ctx.nodes.get(key);
    if (!node) {
      await logEvent(ctx.db, run.id, "error", key, { reason: "node_not_found" });
      return;
    }
    const cfg = node.config as unknown as V2NodeConfig;

    // Same step to the same contact within the window → send nothing.
    const { data: claimed, error: claimErr } = await ctx.db.rpc("flow_claim_step", {
      p_contact_id: ctx.contact.id,
      p_flow_id: ctx.flow.id,
      p_node_key: node.node_key,
      p_window_seconds: ctx.settings.dedupe_window_seconds,
    });
    if (claimErr) {
      await logEvent(ctx.db, run.id, "error", node.node_key, { reason: "step_claim_failed", detail: claimErr.message });
    } else if (claimed === false) {
      await logEvent(ctx.db, run.id, "node_entered", node.node_key, { suppressed: "duplicate_step_within_window" });
      return;
    }

    await logEvent(ctx.db, run.id, "node_entered", node.node_key, { node_type: node.node_type });
    if (cfg.lang && cfg.lang !== run.vars?.lang) {
      run.vars = { ...run.vars, lang: cfg.lang };
      await setContactLanguage(ctx, run, cfg.lang);
    }

    for (const action of cfg.actions ?? []) {
      await runAction(ctx, run, node.node_key, action);
    }

    if (node.node_type === "send_buttons") {
      const ok = await sendButtons(ctx, run, node, cfg);
      await saveRun(ctx, run, node.node_key);
      if (ok && cfg.terminal) await finishRun(ctx, run, "completed", node.node_key);
      return;
    }
    if (node.node_type === "send_message") {
      const ok = await sendText(ctx, run, node, cfg);
      await saveRun(ctx, run, node.node_key);
      if (!ok) return;
      if (cfg.terminal) {
        await finishRun(ctx, run, "completed", node.node_key);
        return;
      }
      key = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "start") {
      key = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "end") {
      await saveRun(ctx, run, node.node_key);
      await finishRun(ctx, run, "completed", node.node_key);
      return;
    }
    await logEvent(ctx.db, run.id, "error", node.node_key, { reason: `unsupported_node_type:${node.node_type}` });
    return;
  }
}

function workingHoursOpen(ctx: Ctx): boolean {
  const mode = ctx.isTest ? ctx.settings.test_overrides?.working_hours_mode : undefined;
  if (mode === "open") return true;
  if (mode === "closed") return false;
  return isWithinWorkingHours(ctx.now, ctx.settings.working_hours);
}

async function textValues(ctx: Ctx, run: FlowRunRow): Promise<Record<string, string | null>> {
  const lang = runLang(run);
  let agentName: string | null = null;
  const { data: conv } = await ctx.db
    .from("conversations")
    .select("assigned_agent_id")
    .eq("id", ctx.conversationId)
    .maybeSingle();
  const agentId = (conv as { assigned_agent_id?: string | null } | null)?.assigned_agent_id;
  if (agentId) {
    const { data: prof } = await ctx.db.from("profiles").select("full_name").eq("user_id", agentId).maybeSingle();
    agentName = firstName((prof as { full_name?: string | null } | null)?.full_name);
  }
  return {
    agent_first_name: agentName ?? ctx.settings.fallback_agent_name[lang],
    slot: (run.vars?.slot_long as string | undefined) ?? null,
    contact_name: ctx.contact.name ?? ctx.contact.phone,
    plan: (run.vars?.plan as string | undefined) ?? null,
  };
}

async function sendText(ctx: Ctx, run: FlowRunRow, node: FlowNodeRow, cfg: V2NodeConfig): Promise<boolean> {
  const open = workingHoursOpen(ctx);
  const template = !open && cfg.text_off_hours ? cfg.text_off_hours : cfg.text ?? "";
  try {
    const text = fill(template, await textValues(ctx, run));
    const { whatsapp_message_id } = await engineSendText({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contact.id,
      text,
      dryRun: ctx.dryRun,
    });
    await logEvent(ctx.db, run.id, "message_sent", node.node_key, {
      node_type: "send_message",
      whatsapp_message_id,
      variant: !open && cfg.text_off_hours ? "off_hours" : "default",
      dry_run: ctx.dryRun || undefined,
    });
    return true;
  } catch (err) {
    await logEvent(ctx.db, run.id, "error", node.node_key, {
      reason: "send_text_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function sendButtons(ctx: Ctx, run: FlowRunRow, node: FlowNodeRow, cfg: V2NodeConfig): Promise<boolean> {
  try {
    const values = await textValues(ctx, run);
    let buttons = (cfg.buttons ?? []).map((b) => ({ id: b.reply_id, title: fill(b.title, values) }));
    if (cfg.dynamic_slots) {
      const slots = computeDemoSlots(ctx.now, ctx.settings.working_hours, cfg.dynamic_slots, runLang(run));
      buttons = slots.map((s) => ({ id: encodeSlotReplyId(node.node_key, s), title: s.label }));
    }
    const { whatsapp_message_id } = await engineSendInteractiveButtons({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contact.id,
      bodyText: fill(cfg.text ?? "", values),
      buttons,
      dryRun: ctx.dryRun,
    });
    await logEvent(ctx.db, run.id, "message_sent", node.node_key, {
      node_type: "send_buttons",
      whatsapp_message_id,
      buttons: buttons.map((b) => b.title),
      dry_run: ctx.dryRun || undefined,
    });
    return true;
  } catch (err) {
    await logEvent(ctx.db, run.id, "error", node.node_key, {
      reason: "send_buttons_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ------------------------------------------------------------
// Actions — each failure is an `error` event, never swallowed
// ------------------------------------------------------------

async function runAction(ctx: Ctx, run: FlowRunRow, nodeKey: string, action: V2Action): Promise<void> {
  try {
    const result = await executeAction(ctx, run, action);
    await logEvent(ctx.db, run.id, "node_entered", nodeKey, { action: action.type, result });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[flows-v2] action ${action.type} failed on ${nodeKey} (run ${run.id}):`, detail);
    await logEvent(ctx.db, run.id, "error", nodeKey, { reason: "action_failed", action: action.type, detail });
  }
}

async function currentAgent(ctx: Ctx): Promise<string | null> {
  const { data } = await ctx.db
    .from("conversations")
    .select("assigned_agent_id")
    .eq("id", ctx.conversationId)
    .maybeSingle();
  return (data as { assigned_agent_id?: string | null } | null)?.assigned_agent_id ?? null;
}

async function ensureAgent(ctx: Ctx): Promise<string> {
  const agent = await assignRoundRobin(ctx.db, {
    accountId: ctx.accountId,
    agentIds: ctx.settings.agent_pool,
    conversationId: ctx.conversationId,
    force: false,
    skipOffline: ctx.settings.skip_offline ?? false,
  });
  if (!agent) throw new Error("Round-robin pool is empty — no agent to assign");
  return agent;
}

async function ensureDeal(ctx: Ctx, run: FlowRunRow): Promise<{ id: string; pipeline_id: string; created: boolean }> {
  const { db, settings } = ctx;
  const { data: pipe, error: pipeErr } = await db
    .from("pipelines")
    .select("id")
    .eq("account_id", ctx.accountId)
    .eq("name", settings.deal.pipeline)
    .limit(1);
  if (pipeErr) throw new Error(`pipeline lookup: ${pipeErr.message}`);
  const pipelineId = ((pipe ?? []) as Array<{ id: string }>)[0]?.id;
  if (!pipelineId) throw new Error(`Pipeline "${settings.deal.pipeline}" not found`);

  const { data: open } = await db
    .from("deals")
    .select("id, pipeline_id")
    .eq("account_id", ctx.accountId)
    .eq("contact_id", ctx.contact.id)
    .eq("pipeline_id", pipelineId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1);
  const existing = ((open ?? []) as Array<{ id: string; pipeline_id: string }>)[0];
  if (existing) {
    run.vars = { ...run.vars, deal_id: existing.id };
    return { ...existing, created: false };
  }
  const stageId = await stageIdByName(ctx, pipelineId, settings.deal.new_stage, false);
  // deals.assigned_to references profiles.id (not the auth user id).
  const agentUserId = await currentAgent(ctx);
  let agent: string | null = null;
  if (agentUserId) {
    const { data: prof } = await db.from("profiles").select("id").eq("user_id", agentUserId).maybeSingle();
    agent = (prof as { id?: string } | null)?.id ?? null;
  }
  const { data: deal, error } = await db
    .from("deals")
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.flow.user_id,
      pipeline_id: pipelineId,
      stage_id: stageId,
      contact_id: ctx.contact.id,
      conversation_id: ctx.conversationId,
      title: ctx.contact.name || ctx.contact.phone || "WhatsApp lead",
      value: 0,
      currency: settings.deal.currency,
      status: "open",
      assigned_to: agent,
    })
    .select("id, pipeline_id")
    .single();
  if (error) throw new Error(`create deal: ${error.message}`);
  run.vars = { ...run.vars, deal_id: (deal as { id: string }).id };
  return { ...(deal as { id: string; pipeline_id: string }), created: true };
}

async function stageIdByName(ctx: Ctx, pipelineId: string, name: string, createMissing: boolean): Promise<string> {
  const { data, error } = await ctx.db
    .from("pipeline_stages")
    .select("id, name, position")
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true });
  if (error) throw new Error(`stage lookup: ${error.message}`);
  const stages = (data ?? []) as Array<{ id: string; name: string; position: number }>;
  const hit = stages.find((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (hit) return hit.id;
  if (!createMissing) throw new Error(`Stage "${name}" not found`);
  // Added at the end so no existing stage is touched.
  const position = stages.reduce((m, s) => Math.max(m, s.position), -1) + 1;
  const { data: created, error: insErr } = await ctx.db
    .from("pipeline_stages")
    .insert({ pipeline_id: pipelineId, name, position })
    .select("id")
    .single();
  if (insErr) throw new Error(`create stage "${name}": ${insErr.message}`);
  return (created as { id: string }).id;
}

async function notify(ctx: Ctx, run: FlowRunRow, title: string, body: string): Promise<string> {
  const agent = await currentAgent(ctx);
  let recipients: string[];
  if (agent) recipients = [agent];
  else {
    const { data } = await ctx.db
      .from("profiles")
      .select("user_id")
      .eq("account_id", ctx.accountId)
      .in("account_role", ["owner", "admin"]);
    recipients = ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  }
  if (!recipients.length) throw new Error("Nobody to notify");
  const values = await textValues(ctx, run);
  const prefix = ctx.isTest ? "[TEST] " : "";
  const { error } = await ctx.db.from("notifications").insert(
    recipients.map((user_id) => ({
      account_id: ctx.accountId,
      user_id,
      type: "flow_alert",
      conversation_id: ctx.conversationId,
      contact_id: ctx.contact.id,
      title: prefix + fill(title, values),
      body: fill(body, values),
    })),
  );
  if (error) throw new Error(`notification insert: ${error.message}`);
  return `notified ${recipients.length}`;
}

async function executeAction(ctx: Ctx, run: FlowRunRow, action: V2Action): Promise<string> {
  const { db, settings } = ctx;
  switch (action.type) {
    case "add_tag": {
      const tag = await resolveTagRef(db, ctx.accountId, action.tag, { createMissing: true });
      const r = await addContactTagAndDispatch({
        db,
        accountId: ctx.accountId,
        contactId: ctx.contact.id,
        tagId: tag.id,
        context: { conversation_id: ctx.conversationId, vars: run.vars },
      });
      return r.added ? `tag "${action.tag}" added` : `tag "${action.tag}" already set`;
    }
    case "assign":
      return `assigned to ${await ensureAgent(ctx)}`;
    case "ensure_deal": {
      const d = await ensureDeal(ctx, run);
      return d.created ? `deal ${d.id} created` : `deal ${d.id} exists`;
    }
    case "set_deal_value": {
      const d = await ensureDeal(ctx, run);
      const { error } = await db.from("deals").update({ value: action.value }).eq("id", d.id);
      if (error) throw new Error(`set deal value: ${error.message}`);
      run.vars = { ...run.vars, plan: action.plan };
      return `deal ${d.id} value ${action.value}`;
    }
    case "move_deal_stage": {
      const d = await ensureDeal(ctx, run);
      const stageId = await stageIdByName(ctx, d.pipeline_id, action.stage, true);
      const { error } = await db.from("deals").update({ stage_id: stageId }).eq("id", d.id);
      if (error) throw new Error(`move deal: ${error.message}`);
      return `deal ${d.id} → ${action.stage}`;
    }
    case "create_follow_up": {
      const agent = (await currentAgent(ctx)) ?? (await ensureAgent(ctx));
      let due: Date;
      let type: "meeting" | "call";
      if (action.kind === "demo") {
        const start = run.vars?.slot_start as string | undefined;
        if (!start) throw new Error("No demo slot picked");
        due = new Date(Date.parse(start) - 15 * 60000);
        type = "meeting";
      } else {
        due = callFollowUpDue(ctx.now, settings.working_hours, workingHoursOpen(ctx));
        type = "call";
      }
      const planLabel = run.vars?.plan === "team" ? "Team" : run.vars?.plan === "individual" ? "Individual" : "";
      const title = fill(action.title, { ...(await textValues(ctx, run)), plan_label: planLabel })
        .replace(/\s+–\s*$/, "")
        .trim();
      const { data, error } = await db
        .from("follow_ups")
        .insert({
          account_id: ctx.accountId,
          contact_id: ctx.contact.id,
          deal_id: (run.vars?.deal_id as string | undefined) ?? null,
          conversation_id: ctx.conversationId,
          type,
          title,
          due_at: due.toISOString(),
          assigned_to: agent,
          created_by: null,
        })
        .select("id")
        .single();
      if (error) throw new Error(`create follow-up: ${error.message}`);
      return `follow-up ${(data as { id: string }).id} due ${due.toISOString()}`;
    }
    case "notify_agent":
      return notify(ctx, run, action.title, action.body ?? "");
    case "flag_hot": {
      const { error } = await db
        .from("conversations")
        .update({ status: "pending", last_message_at: new Date().toISOString() })
        .eq("id", ctx.conversationId);
      if (error) throw new Error(`flag hot: ${error.message}`);
      return "conversation marked pending (top of queue)";
    }
    case "schedule_nudge": {
      const lang = runLang(run);
      const node = action.nodes[lang] ?? action.nodes.en;
      if (!node) throw new Error("No nudge node for this language");
      const delay =
        (ctx.isTest ? settings.test_overrides?.nudge_delay_minutes : undefined) ?? action.delay_minutes;
      const ignoreHours = ctx.isTest && settings.test_overrides?.working_hours_mode === "open";
      const due = nudgeDue(ctx.now, settings.working_hours, delay, "10:30", ignoreHours);
      const { error } = await db.from("flow_scheduled_jobs").insert({
        account_id: ctx.accountId,
        flow_id: ctx.flow.id,
        run_id: run.id,
        contact_id: ctx.contact.id,
        conversation_id: ctx.conversationId,
        kind: "nudge",
        node_key: node,
        cancel_on: ["customer", "agent"],
        due_at: due.toISOString(),
      });
      if (error) throw new Error(`schedule nudge: ${error.message}`);
      return `nudge ${node} at ${due.toISOString()}`;
    }
    case "schedule_auto_close": {
      const due = new Date(ctx.now.getTime() + action.hours * 3600 * 1000);
      const { error } = await db.from("flow_scheduled_jobs").insert({
        account_id: ctx.accountId,
        flow_id: ctx.flow.id,
        run_id: run.id,
        contact_id: ctx.contact.id,
        conversation_id: ctx.conversationId,
        kind: "auto_close",
        cancel_on: ["customer", "agent"],
        due_at: due.toISOString(),
      });
      if (error) throw new Error(`schedule auto-close: ${error.message}`);
      return `auto-close at ${due.toISOString()}`;
    }
    case "mark_fallback_replied": {
      const { error } = await db
        .from("flow_contact_state")
        .upsert(
          { account_id: ctx.accountId, contact_id: ctx.contact.id, last_fallback_reply_at: new Date().toISOString() },
          { onConflict: "account_id,contact_id" },
        );
      if (error) throw new Error(`fallback state: ${error.message}`);
      return "fallback reply recorded";
    }
  }
}

async function setContactLanguage(ctx: Ctx, run: FlowRunRow, lang: V2Lang): Promise<void> {
  const field = ctx.settings.language.contact_field;
  try {
    const { data: existing } = await ctx.db
      .from("custom_fields")
      .select("id")
      .eq("account_id", ctx.accountId)
      .eq("field_name", field)
      .limit(1);
    let fieldId = ((existing ?? []) as Array<{ id: string }>)[0]?.id;
    if (!fieldId) {
      const { data: created, error } = await ctx.db
        .from("custom_fields")
        .insert({ account_id: ctx.accountId, user_id: ctx.flow.user_id, field_name: field, field_type: "text" })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      fieldId = (created as { id: string }).id;
    }
    const { error } = await ctx.db
      .from("contact_custom_values")
      .upsert({ contact_id: ctx.contact.id, custom_field_id: fieldId, value: lang }, { onConflict: "contact_id,custom_field_id" });
    if (error) throw new Error(error.message);
  } catch (err) {
    await logEvent(ctx.db, run.id, "error", run.current_node_key, {
      reason: "action_failed",
      action: "set_language_field",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// ------------------------------------------------------------
// Scheduled jobs (nudges, auto-close) — called by /api/flows/tick
// ------------------------------------------------------------

interface JobRow {
  id: string;
  account_id: string;
  flow_id: string;
  run_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  kind: "nudge" | "auto_close";
  node_key: string | null;
  cancel_on: string[];
  due_at: string;
  created_at: string;
}

export async function processDueJobs(limit = 25): Promise<Array<{ id: string; status: string; result: string }>> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("flow_claim_due_jobs", { p_limit: limit });
  if (error) throw new Error(`claim jobs: ${error.message}`);
  const out: Array<{ id: string; status: string; result: string }> = [];
  for (const job of (data ?? []) as JobRow[]) {
    let status = "done";
    let result = "";
    try {
      ({ status, result } = await processJob(db, job));
    } catch (err) {
      status = "failed";
      result = err instanceof Error ? err.message : String(err);
    }
    await db.from("flow_scheduled_jobs").update({ status, result, processed_at: new Date().toISOString() }).eq("id", job.id);
    if (job.run_id) {
      await logEvent(db, job.run_id, status === "failed" ? "error" : "node_entered", job.node_key, {
        scheduled_job: job.kind,
        job_status: status,
        result,
      });
    }
    out.push({ id: job.id, status, result });
  }
  return out;
}

async function processJob(db: Db, job: JobRow): Promise<{ status: string; result: string }> {
  if (!job.conversation_id || !job.contact_id) return { status: "skipped", result: "contact or chat deleted" };

  // Cancelled if the lead / an agent wrote after the job was scheduled.
  if (job.cancel_on.length) {
    const { count } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", job.conversation_id)
      .in("sender_type", job.cancel_on)
      .gt("created_at", job.created_at);
    if ((count ?? 0) > 0) return { status: "cancelled", result: "lead or agent messaged after it was scheduled" };
  }

  if (job.kind === "auto_close") {
    const { error } = await db.from("conversations").update({ status: "closed" }).eq("id", job.conversation_id);
    if (error) throw new Error(`close conversation: ${error.message}`);
    return { status: "done", result: "conversation closed (no reply in time)" };
  }

  // Nudge
  const bundles = await loadV2Flows(db, job.account_id);
  const bundle = bundles.find((b) => b.flow.id === job.flow_id);
  if (!bundle) return { status: "skipped", result: "flow no longer on v2" };
  const { data: contact } = await db.from("contacts").select("id, phone, name").eq("id", job.contact_id).maybeSingle();
  const c = contact as { id: string; phone: string | null; name: string | null } | null;
  if (!c) return { status: "skipped", result: "contact deleted" };
  if (!v2AppliesTo(bundle.settings, c.phone)) return { status: "skipped", result: "v2 no longer routes this contact" };
  const { data: runRow } = await db.from("flow_runs").select("*").eq("id", job.run_id).maybeSingle();
  if (!runRow) return { status: "skipped", result: "run deleted" };
  const run = runRow as FlowRunRow;

  const ctx: Ctx = {
    db,
    flow: bundle.flow,
    settings: bundle.settings,
    nodes: await loadNodes(db, bundle.flow.id),
    accountId: job.account_id,
    userId: bundle.flow.user_id,
    contact: c,
    conversationId: job.conversation_id,
    isTest: isTestContact(bundle.settings, c.phone),
    dryRun: phoneInList(c.phone, bundle.settings.dry_run_phones),
    now: new Date(),
  };
  if (isBotPaused(await lastAgentMessageAt(ctx), ctx.now, bundle.settings.bot_pause_hours)) {
    return { status: "cancelled", result: "agent active on the chat" };
  }

  // WhatsApp's 24h customer-service window.
  const { data: lastIn } = await db
    .from("messages")
    .select("created_at")
    .eq("conversation_id", job.conversation_id)
    .eq("sender_type", "customer")
    .order("created_at", { ascending: false })
    .limit(1);
  const lastCustomer = ((lastIn ?? []) as Array<{ created_at: string }>)[0];
  const windowOpen = !!lastCustomer && ctx.now.getTime() - Date.parse(lastCustomer.created_at) < 24 * 3600 * 1000;

  if (!windowOpen) {
    const tpl = bundle.settings.nudge_template;
    if (!tpl?.name) return { status: "skipped", result: "24h window closed and no approved nudge template set" };
    if (ctx.dryRun) return { status: "done", result: `would send template ${tpl.name} (dry run)` };
    await engineSendTemplate({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: c.id,
      templateName: tpl.name,
      language: tpl.language,
    });
    return { status: "done", result: `template ${tpl.name} sent (window closed)` };
  }

  const active = await reopenRun(ctx, run);
  if (!active) return { status: "skipped", result: "another run is active" };
  await walk(ctx, active, job.node_key!);
  return { status: "done", result: `sent ${job.node_key}` };
}
