#!/usr/bin/env node
/**
 * End-to-end test of DSA Welcome v3 (15 scenarios from the v3 brief),
 * against the deployed app, using simulated test numbers 91900000020x.
 *
 *   node scripts/simulate-flow-v3.mjs --base https://<app> --flow <v3 id> [--only 1,2] [--keep]
 *
 * Safety: numbers are on v3's test + dry-run lists (no Meta sends), names
 * start with "[TEST]" (no pushes), everything is deleted afterwards and
 * the v3 settings and round-robin pointer are restored. v2 stays live for
 * everyone else throughout.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg("base", "https://wacrm-jet-two.vercel.app");
const FLOW = arg("flow");
const ONLY = arg("only") ? arg("only").split(",").map(Number) : null;
const KEEP = argv.includes("--keep");
const OUT = arg("out", "flow-v3-test-results.md");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry transient network errors (the request itself is idempotent by wamid / job claim).
async function fetchRetry(url, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(2000 * i);
    }
  }
}

const PHONES = Array.from({ length: 30 }, (_, i) => `9190000002${String(i + 1).padStart(2, "0")}`);
const P = (i) => PHONES[i - 1];
const { data: cfg } = await db.from("whatsapp_config").select("phone_number_id, account_id").limit(1).single();
const ACCOUNT = cfg.account_id;
const { data: settingsRow } = await db.from("flow_engine_settings").select("settings").eq("flow_id", FLOW).single();
const ORIGINAL = settingsRow.settings;
const POOL = ORIGINAL.agent_pool;
const poolKey = [...POOL].sort().join(",");
const { data: ptr } = await db.from("round_robin_pointers").select("last_agent_id").eq("account_id", ACCOUNT).eq("pool_key", poolKey).maybeSingle();
const ORIGINAL_POINTER = ptr?.last_agent_id ?? null;
const { data: people } = await db.from("profiles").select("user_id, full_name").eq("account_id", ACCOUNT);
const nameOf = (id) => people.find((p) => p.user_id === id)?.full_name ?? id;
const { data: ownerRow } = await db.from("profiles").select("user_id").eq("account_id", ACCOUNT).eq("account_role", "owner").limit(1).single();

async function patchSettings(patch) {
  const { data } = await db.from("flow_engine_settings").select("settings").eq("flow_id", FLOW).single();
  await db.from("flow_engine_settings").update({ settings: { ...data.settings, ...patch } }).eq("flow_id", FLOW);
  await sleep(21000); // engine caches settings for 20s
}
async function overrides(o) {
  const { data } = await db.from("flow_engine_settings").select("settings").eq("flow_id", FLOW).single();
  await patchSettings({ test_overrides: { ...data.settings.test_overrides, ...o } });
}

// ---------------------------------------------------------------- inbound
let ts = Math.floor(Date.now() / 1000);
async function post(phone, message, name = `[TEST] v3 ${phone.slice(-2)}`) {
  ts = Math.max(ts + 1, Math.floor(Date.now() / 1000));
  const msg = { from: phone, id: `wamid.TEST.${randomUUID()}`, timestamp: String(ts), ...message };
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "TEST", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "TEST", phone_number_id: cfg.phone_number_id },
      contacts: [{ profile: { name }, wa_id: phone }],
      messages: [msg],
    } }] }],
  });
  const res = await fetchRetry(`${BASE}/api/flows/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-push-secret": env.PUSH_DISPATCH_SECRET },
    body,
  });
  if (!res.ok) throw new Error(`simulate ${res.status}: ${await res.text()}`);
}
const text = (p, body) => post(p, { type: "text", text: { body } });
const tap = (p, id, title) => post(p, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } });
const pick = (p, id, title) => post(p, { type: "interactive", interactive: { type: "list_reply", list_reply: { id, title } } });
const tick = async () => {
  const r = await fetchRetry(`${BASE}/api/flows/tick`, { method: "POST", headers: { "x-push-secret": env.PUSH_DISPATCH_SECRET } });
  return (await r.json()).processed ?? [];
};

// ---------------------------------------------------------------- reads
async function contactOf(p) {
  const { data } = await db.from("contacts").select("id, name").eq("account_id", ACCOUNT).like("phone", `%${p.slice(-10)}`).limit(1);
  return data?.[0] ?? null;
}
async function convOf(p) {
  const c = await contactOf(p);
  if (!c) return null;
  const { data } = await db.from("conversations").select("id, assigned_agent_id, status").eq("contact_id", c.id).maybeSingle();
  return data;
}
async function sent(p) {
  const c = await contactOf(p);
  if (!c) return [];
  const { data: runs } = await db.from("flow_runs").select("id").eq("flow_id", FLOW).eq("contact_id", c.id);
  if (!runs?.length) return [];
  const { data } = await db.from("flow_run_events").select("node_key, created_at").in("flow_run_id", runs.map((r) => r.id)).eq("event_type", "message_sent").order("created_at");
  return (data ?? []).map((e) => e.node_key);
}
async function errorsOf(p) {
  const c = await contactOf(p);
  if (!c) return [];
  const { data: runs } = await db.from("flow_runs").select("id").eq("flow_id", FLOW).eq("contact_id", c.id);
  if (!runs?.length) return [];
  const { data } = await db.from("flow_run_events").select("node_key, payload").in("flow_run_id", runs.map((r) => r.id)).eq("event_type", "error");
  return (data ?? []).map((e) => `${e.node_key}: ${e.payload.action ?? e.payload.reason} ${e.payload.detail ?? ""}`);
}
async function botMsgs(p) {
  const conv = await convOf(p);
  if (!conv) return [];
  const { data } = await db.from("messages").select("content_text, media_url, interactive_payload, created_at").eq("conversation_id", conv.id).eq("sender_type", "bot").order("created_at");
  return data ?? [];
}
async function tagsOf(p) {
  const c = await contactOf(p);
  const { data } = await db.from("contact_tags").select("tags(name)").eq("contact_id", c.id);
  return (data ?? []).map((r) => r.tags.name);
}
async function followUps(p) {
  const c = await contactOf(p);
  const { data } = await db.from("follow_ups").select("type, title, due_at, completed_at").eq("contact_id", c.id).order("created_at");
  return data ?? [];
}
async function alerts(p) {
  const conv = await convOf(p);
  const { data } = await db.from("notifications").select("type, title").eq("conversation_id", conv.id);
  return data ?? [];
}
async function jobs(p, kind) {
  const c = await contactOf(p);
  const { data } = await db.from("flow_scheduled_jobs").select("kind, node_key, status, result, due_at").eq("contact_id", c.id).eq("kind", kind).order("created_at");
  return data ?? [];
}
async function booking(p) {
  const c = await contactOf(p);
  const { data } = await db.from("flow_slot_bookings").select("slot_start, status").eq("contact_id", c.id).eq("status", "active");
  return data?.[0] ?? null;
}
async function lastList(p) {
  const msgs = await botMsgs(p);
  const m = [...msgs].reverse().find((x) => x.interactive_payload?.kind === "list");
  return m?.interactive_payload?.sections?.flatMap((s) => s.rows) ?? [];
}
async function waitSent(p, n, label) {
  const start = Date.now();
  while (Date.now() - start < 40000) {
    const s = await sent(p);
    if (s.length >= n) return s;
    await sleep(800);
  }
  throw new Error(`timeout: ${label ?? `${n} steps for ${p}`} (have ${(await sent(p)).join(",")})`);
}

// ---------------------------------------------------------------- report
const results = [];
let cur = null;
const check = (label, ok, detail = "") => {
  cur.checks.push({ label, ok: !!ok, detail });
  if (!ok) cur.failed = true;
};
const S = (n, title, fn) => ({ n, title, fn });
const HI_FIRST = "नमस्ते! क्या मुझे इस बारे में और पता चल सकता है?";
const EN_FIRST = "Hello! Can I get more info on this?";
const BANNED = ["30 minutes", "30 मिनट के अंदर", "10 am–7 pm", "10–11 am", "10–11 बजे"];

const scenarios = [
  S(1, "English welcome: image header + 3 buttons; Yes, I'm a DSA → team size", async () => {
    const p = P(1);
    await text(p, EN_FIRST);
    await waitSent(p, 1);
    const [welcome] = await botMsgs(p);
    check("header image on the welcome", !!welcome.media_url, welcome.media_url ?? "");
    check("3 buttons", welcome.interactive_payload?.buttons?.length === 3, welcome.interactive_payload?.buttons?.map((b) => b.title).join(" · "));
    check("new copy", welcome.content_text.startsWith("Namaste 🙏\n\nHow many loan files slipped away"));
    await tap(p, "v2.e1.dsa", "Yes, I'm a DSA");
    const s = await waitSent(p, 2);
    check("→ team size", s.join(",") === "e1,e3", s.join(" → "));
  }),

  S(2, "Hindi first message → H1 (new copy); English please → E1", async () => {
    const p = P(2);
    await text(p, HI_FIRST);
    await waitSent(p, 1);
    const [h1] = await botMsgs(p);
    check("H1 directly with the new Hindi copy", h1.content_text.startsWith("नमस्ते 🙏\n\nपिछले महीने कितनी loan files"), h1.content_text.slice(0, 40));
    check("Hindi buttons", h1.interactive_payload?.buttons?.map((b) => b.title).join(" · ") === "हाँ, मैं DSA हूँ · नहीं, code चाहिए · English please");
    await tap(p, "v2.h1.english", "English please");
    const s = await waitSent(p, 2);
    check("English please → E1", s.join(",") === "h1,e1", s.join(" → "));
  }),

  S(3, "Assignment on the first message; 6 new leads alternate; Rahul never", async () => {
    const ps = [P(3), P(4), P(5), P(6), P(7), P(8)];
    for (const p of ps) { await text(p, EN_FIRST); await sleep(300); }
    await Promise.all(ps.map((p) => waitSent(p, 1)));
    await sleep(4000);
    const assigned = await Promise.all(ps.map(async (p) => (await convOf(p)).assigned_agent_id));
    cur.log.push(`assigned: ${assigned.map(nameOf).join(", ")}`);
    check("assigned right after the first message", assigned.every(Boolean));
    check("only pool agents (never Rahul)", assigned.every((a) => POOL.includes(a)));
    check("3 / 3 alternation", POOL.map((id) => assigned.filter((a) => a === id).length).join("/") === "3/3", POOL.map((id) => assigned.filter((a) => a === id).length).join("/"));
  }),

  S(4, "Text at the welcome: 'Costing ?' → price + team size; 'ye kya hai' → fallback + video + agent notified", async () => {
    const a = P(9);
    await text(a, EN_FIRST);
    await waitSent(a, 1);
    await sleep(1500);
    await text(a, "Costing ?");
    const sa = await waitSent(a, 3);
    check("price line then team-size question", sa.slice(1).join(",") === "price_en,e3", sa.join(" → "));
    const msgs = await botMsgs(a);
    check("price line text", msgs.some((m) => m.content_text?.startsWith("Plans start at ₹600/month")));
    const b = P(10);
    await text(b, EN_FIRST);
    await waitSent(b, 1);
    await sleep(1500);
    await text(b, "ye kya hai");
    const sb = await waitSent(b, 3);
    check("fallback (with video) then the welcome again", sb.slice(1).join(",") === "e8w,e1", sb.join(" → "));
    const fb = (await botMsgs(b)).find((m) => m.content_text?.startsWith("Thanks!"));
    check("fallback has the video", fb?.content_text?.includes("youtu.be"));
    check("agent notified", (await alerts(b)).some((x) => x.title.includes("Question")));
  }),

  S(5, "Agent messaged, then the lead taps an old button → bot still answers", async () => {
    const p = P(11);
    await text(p, EN_FIRST);
    await waitSent(p, 1);
    const conv = await convOf(p);
    await db.from("messages").insert({ conversation_id: conv.id, sender_type: "agent", content_type: "text", content_text: "[TEST] Please press above button i run a DSA", status: "sent", message_id: `wamid.TEST.agent.${randomUUID()}` });
    await tap(p, "v2.e1.dsa", "I run a DSA business");
    const s = await waitSent(p, 2);
    check("tap answered during the bot pause", s.at(-1) === "e3", s.join(" → "));
  }),

  S(6, "Nudges: welcome nudge, 2nd at the next step, no 3rd → agent follow-up (timers shortened)", async () => {
    const p = P(12);
    await text(p, EN_FIRST);
    await waitSent(p, 1);
    await sleep(65000);
    await tick();
    const s1 = await waitSent(p, 2, "welcome nudge");
    check("1st nudge at the welcome", s1.at(-1) === "n_welcome", s1.join(" → "));
    await tap(p, "v3.n_welcome.dsa", "Yes, I'm a DSA");
    await waitSent(p, 3);
    await sleep(65000);
    await tick();
    const s2 = await waitSent(p, 4, "team-size nudge");
    check("2nd nudge at the team-size step", s2.at(-1) === "n_team", s2.join(" → "));
    await sleep(65000);
    await tick();
    await sleep(3000);
    const fu = await followUps(p);
    check("agent follow-up 'No reply after 2 nudges'", fu.some((f) => f.title.startsWith("No reply after 2 nudges")), fu.map((f) => f.title).join("; "));
    await tap(p, "v3.n_team.solo", "Just me");
    await waitSent(p, 5);
    await sleep(3000);
    const pending = (await jobs(p, "nudge")).filter((j) => j.status === "pending");
    check("no 3rd nudge scheduled", pending.length === 0, (await jobs(p, "nudge")).map((j) => `${j.node_key}:${j.status}`).join(", "));
  }),

  S(7, "Nudge cancelled when the lead types or an agent messages (quiet hours: unit-tested)", async () => {
    const a = P(13), b = P(14);
    for (const p of [a, b]) {
      await text(p, EN_FIRST);
      await waitSent(p, 1);
      await tap(p, "v2.e1.dsa", "Yes, I'm a DSA");
      await waitSent(p, 2);
    }
    await text(a, "ok");
    const convB = await convOf(b);
    await db.from("messages").insert({ conversation_id: convB.id, sender_type: "agent", content_type: "text", content_text: "[TEST] calling you", status: "sent", message_id: `wamid.TEST.agent.${randomUUID()}` });
    await sleep(65000);
    await tick();
    await sleep(3000);
    check("lead typed → nudge not sent", !(await sent(a)).includes("n_team"), (await jobs(a, "nudge")).map((j) => j.status).join(","));
    check("agent messaged → nudge not sent", !(await sent(b)).includes("n_team"), (await jobs(b, "nudge")).map((j) => j.status).join(","));
  }),

  S(8, "Slot list: only free 30-min slots, capacity 2, Call me instead + Other time", async () => {
    const [a, b, c, d] = [P(15), P(16), P(17), P(18)];
    for (const p of [a, b, c]) {
      await text(p, EN_FIRST); await waitSent(p, 1);
      await tap(p, "v2.e1.dsa", "Yes, I'm a DSA"); await waitSent(p, 2);
      await tap(p, "v2.e3.solo", "Just me"); await waitSent(p, 3);
      await tap(p, "v2.e4a.demo", "Book free demo"); await waitSent(p, 4);
    }
    const rows = await lastList(a);
    cur.log.push(`list rows: ${rows.map((r) => r.title).join(" · ")}`);
    const slotRows = rows.filter((r) => r.id.startsWith("slot|"));
    check("≤ 6 slot rows of 30 min + 2 fixed rows", slotRows.length > 0 && slotRows.length <= 6 && rows.some((r) => r.title === "Call me instead") && rows.some((r) => r.title === "Other time"));
    const target = slotRows[0];
    await pick(a, target.id, target.title); await waitSent(a, 5);
    await pick(b, target.id, target.title); await waitSent(b, 5);
    await pick(c, target.id, target.title); // 3rd booking for a full slot
    const sc = await waitSent(c, 6);
    check("3rd booking refused (slot full → list again)", sc.slice(-2).join(",") === "e5_full,e5" && !(await booking(c)), sc.join(" → "));
    const freshRows = (await lastList(c)).map((r) => r.id);
    check("full slot no longer offered", !freshRows.includes(target.id));
    await text(d, EN_FIRST); await waitSent(d, 1);
    await tap(d, "v2.e1.dsa", "Yes, I'm a DSA"); await waitSent(d, 2);
    await tap(d, "v2.e3.solo", "Just me"); await waitSent(d, 3);
    await tap(d, "v2.e4a.demo", "Book free demo"); await waitSent(d, 4);
    await pick(d, "v3.e5.other", "Other time");
    const sd = await waitSent(d, 5);
    check("Other time → reply + follow-up + agent notified", sd.at(-1) === "e_other" && (await followUps(d)).some((f) => f.title.startsWith("Agree a demo time")) && (await alerts(d)).some((x) => x.title.includes("another demo time")));
    await pick(c, "v3.e5.call", "Call me instead");
    const sc2 = await waitSent(c, 7);
    check("Call me instead → Call me", sc2.at(-1) === "e6", sc2.join(" → "));
  }),

  S(9, "Two slot picks within 10s → the last one is booked", async () => {
    const p = P(19);
    await text(p, EN_FIRST); await waitSent(p, 1);
    await tap(p, "v2.e1.dsa", "Yes, I'm a DSA"); await waitSent(p, 2);
    await tap(p, "v2.e3.solo", "Just me"); await waitSent(p, 3);
    await tap(p, "v2.e4a.demo", "Book free demo"); await waitSent(p, 4);
    const rows = (await lastList(p)).filter((r) => r.id.startsWith("slot|"));
    await pick(p, rows[1].id, rows[1].title);
    await sleep(500);
    await pick(p, rows[2].id, rows[2].title);
    await sleep(12000);
    const b = await booking(p);
    const lastStart = rows[2].id.split("|")[2];
    check("the last pick is the booking", b && new Date(b.slot_start).toISOString() === new Date(lastStart).toISOString(), b?.slot_start);
    const conf = (await botMsgs(p)).filter((m) => m.content_text?.startsWith("Done ✅"));
    check("confirmation shows that slot", conf.at(-1)?.content_text.includes(rows[2].title.split(" ").slice(1).join(" ")), conf.map((m) => m.content_text.slice(0, 60)).join(" | "));
    const meet = (await followUps(p)).filter((f) => f.type === "meeting" && !f.completed_at);
    check("one meeting follow-up, 15 min before that slot", meet.length === 1 && Date.parse(meet[0].due_at) === Date.parse(lastStart) - 15 * 60000, meet.map((f) => f.due_at).join(", "));
  }),

  S(10, "Call me (in hours / off hours) and the fallback include the video; no promised times anywhere", async () => {
    for (const [p, mode] of [[P(20), "open"], [P(21), "closed"]]) {
      await overrides({ working_hours_mode: mode });
      await text(p, EN_FIRST); await waitSent(p, 1);
      await tap(p, "v2.e1.dsa", "Yes, I'm a DSA"); await waitSent(p, 2);
      await tap(p, "v2.e3.solo", "Just me"); await waitSent(p, 3);
      await tap(p, "v2.e4a.call", "Call me");
      await waitSent(p, 4);
      const msg = (await botMsgs(p)).at(-1).content_text;
      cur.log.push(`[${mode}] ${msg.split("\n")[0]}`);
      check(`[${mode}] Call me has the video`, msg.includes("youtu.be"));
      check(`[${mode}] wording`, mode === "open" ? msg.includes("shortly") : msg.includes("tomorrow"));
    }
    await overrides({ working_hours_mode: "open" });
    const all = [];
    for (const p of PHONES) for (const m of await botMsgs(p)) all.push(m.content_text ?? "");
    const hits = all.filter((t) => BANNED.some((b) => t.toLowerCase().includes(b)));
    check(`no promised times in ${all.length} bot messages`, hits.length === 0, hits[0] ?? "");
  }),

  S(11, "Demo-day reminder with the video (timer shortened)", async () => {
    const p = P(22);
    await text(p, EN_FIRST); await waitSent(p, 1);
    await tap(p, "v2.e1.dsa", "Yes, I'm a DSA"); await waitSent(p, 2);
    await tap(p, "v2.e3.team", "I have a team"); await waitSent(p, 3);
    await tap(p, "v2.e4b.demo", "Book free demo"); await waitSent(p, 4);
    const row = (await lastList(p)).find((r) => r.id.startsWith("slot|"));
    await pick(p, row.id, row.title); await waitSent(p, 5);
    await sleep(3000);
    check("reminder scheduled", (await jobs(p, "reminder")).length === 1);
    await sleep(65000);
    await tick();
    const s = await waitSent(p, 6, "reminder");
    const rem = (await botMsgs(p)).at(-1).content_text;
    check("reminder sent with slot time + video", s.at(-1) === "rem_en" && rem.includes("youtu.be") && rem.startsWith("Your demo is today at"), rem.slice(0, 70));
  }),

  S(12, "Post-video: Yes, I want this → plan → registration + payment; tag, stage, follow-up, alert", async () => {
    const p = P(23);
    await text(p, EN_FIRST); await waitSent(p, 1);
    await tap(p, "v2.e1.dsa", "Yes, I'm a DSA"); await waitSent(p, 2);
    await tap(p, "v2.e3.solo", "Just me"); await waitSent(p, 3);
    await tap(p, "v2.e4a.video", "Watch video first"); await waitSent(p, 4);
    await sleep(65000);
    await tick();
    await waitSent(p, 5, "post-video nudge");
    await tap(p, "v3.n1.yes", "Yes, I want this");
    const s1 = await waitSent(p, 6);
    check("solo → 'Your plan: Individual – ₹600/month'", s1.at(-1) === "r_solo", s1.join(" → "));
    await tap(p, "v3.r_solo.ok", "Confirm ₹600/month");
    const s2 = await waitSent(p, 7);
    const msg = (await botMsgs(p)).at(-1).content_text;
    check("registration + payment links", s2.at(-1) === "pay_solo" && msg.includes("docs.google.com/forms") && msg.split("docs.google.com/forms").length === 3);
    await sleep(3000);
    check("tag Ready to Buy", (await tagsOf(p)).some((t) => t.toLowerCase() === "ready to buy"));
    const c = await contactOf(p);
    const { data: deal } = await db.from("deals").select("value, stage:pipeline_stages(name)").eq("contact_id", c.id).single();
    check("deal ₹600, stage Payment Pending", Number(deal.value) === 600 && deal.stage.name === "Payment Pending", `${deal.value} / ${deal.stage.name}`);
    check("onboarding follow-up", (await followUps(p)).some((f) => f.title.startsWith("Onboarding call – Individual")));
    check("urgent alert", (await alerts(p)).some((x) => x.title.includes("Ready to buy")) && (await convOf(p)).status === "pending");
  }),

  S(13, "Not for me → reasons + tags; a later Call me removes the Lost: tag", async () => {
    const reasons = [["price", "Too expensive", "lost_price", "Lost: Price"], ["crm", "Using Excel / other CRM", "lost_crm", "Lost: Already-CRM"], ["dsa", "Not a DSA yet", "e2", "Lost: Not-DSA"], ["explore", "Just exploring", "lost_explore", "Lost: No-need"]];
    for (let i = 0; i < reasons.length; i++) {
      const [id, title, node, tag] = reasons[i];
      const p = P(24 + i);
      await text(p, EN_FIRST); await waitSent(p, 1);
      await tap(p, "v3.n1.no", "Not for me"); await waitSent(p, 2);
      await pick(p, `v3.e_not.${id}`, title);
      const s = await waitSent(p, 3);
      await sleep(3000);
      check(`${title} → ${node}, tag ${tag}`, s.at(-1) === node && (await tagsOf(p)).includes(tag), `${s.join(" → ")} / ${(await tagsOf(p)).join(", ")}`);
    }
    const p = P(24);
    await tap(p, "v3.lost_price.call", "Call me");
    await waitSent(p, 4);
    await sleep(3000);
    check("later Call me removes Lost: Price", !(await tagsOf(p)).some((t) => t.startsWith("Lost:")), (await tagsOf(p)).join(", "));
  }),

  S(14, "No, need DSA code → Oops, I am a DSA removes Lost: Not-DSA", async () => {
    const p = P(28);
    await text(p, EN_FIRST); await waitSent(p, 1);
    await tap(p, "v2.e1.code", "No, need DSA code"); await waitSent(p, 2);
    await sleep(2000);
    check("Lost: Not-DSA added", (await tagsOf(p)).includes("Lost: Not-DSA"));
    await tap(p, "v2.e2.dsa", "Oops, I am a DSA"); await waitSent(p, 3);
    await sleep(3000);
    check("removed after Oops", !(await tagsOf(p)).includes("Lost: Not-DSA"), (await tagsOf(p)).join(", "));
  }),

  S(15, "Demo booked + old welcome button → 'already booked'; Change time moves booking and follow-up", async () => {
    const p = P(29);
    await text(p, EN_FIRST); await waitSent(p, 1);
    await tap(p, "v2.e1.dsa", "Yes, I'm a DSA"); await waitSent(p, 2);
    await tap(p, "v2.e3.solo", "Just me"); await waitSent(p, 3);
    await tap(p, "v2.e4a.demo", "Book free demo"); await waitSent(p, 4);
    const rows = (await lastList(p)).filter((r) => r.id.startsWith("slot|"));
    await pick(p, rows[3].id, rows[3].title); await waitSent(p, 5);
    await sleep(11000);
    await tap(p, "v2.e1.dsa", "Yes, I'm a DSA"); // old welcome button
    const s = await waitSent(p, 6);
    check("old welcome button → 'already booked'", s.at(-1) === "booked_en", s.join(" → "));
    await tap(p, "v3.booked_en.change", "Change time");
    await waitSent(p, 7);
    const rows2 = (await lastList(p)).filter((r) => r.id.startsWith("slot|"));
    const newRow = rows2.find((r) => r.id !== rows[3].id);
    await pick(p, newRow.id, newRow.title);
    await waitSent(p, 8);
    await sleep(3000);
    const b = await booking(p);
    const newStart = newRow.id.split("|")[2];
    check("booking moved to the new slot", b && new Date(b.slot_start).toISOString() === new Date(newStart).toISOString());
    const meet = (await followUps(p)).filter((f) => f.type === "meeting" && !f.completed_at);
    check("only the new demo follow-up remains", meet.length === 1 && Date.parse(meet[0].due_at) === Date.parse(newStart) - 15 * 60000, meet.map((f) => f.due_at).join(", "));
  }),
];

// ---------------------------------------------------------------- run
async function cleanup() {
  const { data: contacts } = await db.from("contacts").select("id").eq("account_id", ACCOUNT).or(PHONES.map((p) => `phone.like.%${p.slice(-10)}`).join(","));
  const ids = (contacts ?? []).map((c) => c.id);
  if (ids.length) {
    await db.from("flow_runs").delete().in("contact_id", ids);
    await db.from("deals").delete().in("contact_id", ids);
    await db.from("contacts").delete().in("id", ids);
  }
  await db.from("round_robin_pointers").update({ last_agent_id: ORIGINAL_POINTER }).eq("account_id", ACCOUNT).eq("pool_key", poolKey);
  await db.from("flow_engine_settings").update({ settings: ORIGINAL }).eq("flow_id", FLOW);
  return ids.length;
}

await cleanup();
await patchSettings({
  test_phones: PHONES,
  dry_run_phones: PHONES,
  sim_phones: PHONES,
  test_overrides: { working_hours_mode: "open", nudge_delay_minutes: 1, final_after_minutes: 1, reminder_after_minutes: 1, ignore_quiet_hours: true },
});

for (const s of scenarios) {
  if (ONLY && !ONLY.includes(s.n)) continue;
  cur = { n: s.n, title: s.title, checks: [], log: [], failed: false };
  results.push(cur);
  const t0 = Date.now();
  try {
    await s.fn();
  } catch (err) {
    cur.failed = true;
    cur.checks.push({ label: "scenario ran", ok: false, detail: err.message });
  }
  cur.seconds = Math.round((Date.now() - t0) / 1000);
  const errs = [];
  for (const p of PHONES) if (await contactOf(p)) errs.push(...(await errorsOf(p)).map((e) => `${p.slice(-2)} ${e}`));
  cur.engineErrors = errs;
  console.log(`${cur.failed ? "FAIL" : "PASS"}  ${s.n}. ${s.title} (${cur.seconds}s)`);
  for (const c of cur.checks) console.log(`   ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? `  [${c.detail}]` : ""}`);
  for (const l of cur.log) console.log(`   · ${l}`);
  if (errs.length) console.log(`   ! engine errors: ${errs.join(" | ")}`);
}

const removed = KEEP ? 0 : await cleanup();
if (KEEP) await db.from("flow_engine_settings").update({ settings: ORIGINAL }).eq("flow_id", FLOW);
const md = [
  "# DSA Welcome v3 — end-to-end test results",
  "",
  `Run ${new Date().toISOString()} against ${BASE}. Simulated Meta-signed webhooks for test numbers; bot replies are written to the inbox but not sent to Meta. Timers shortened for test numbers (nudges, final hand-over and demo reminder: 1 minute). ${KEEP ? "Data kept." : `Removed ${removed} test contacts afterwards.`}`,
  "",
  ...results.flatMap((r) => [
    `## ${r.failed ? "❌" : "✅"} ${r.n}. ${r.title} (${r.seconds}s)`,
    ...r.checks.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? ` — \`${c.detail}\`` : ""}`),
    ...r.log.map((l) => `- · ${l}`),
    ...(r.engineErrors?.length ? [`- engine errors: ${r.engineErrors.map((e) => `\`${e}\``).join("; ")}`] : []),
    "",
  ]),
].join("\n");
writeFileSync(OUT, md);
console.log(`\n${results.filter((r) => !r.failed).length}/${results.length} scenarios passed — ${OUT}`);
process.exit(results.some((r) => r.failed) ? 1 : 0);
